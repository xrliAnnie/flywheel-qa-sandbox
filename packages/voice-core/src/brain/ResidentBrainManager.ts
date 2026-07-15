/**
 * ResidentBrainManager — FLY-1160 §3.2: key → resident session registry with a
 * GLOBAL hard cap and the reaping iron rule (FLY-1148 lesson: who spawns,
 * reaps — and only the daemon spawns; the shim never gets spawn rights).
 *
 * Key convention: `<issueIdentifier>:<leadId>` (/glaw per-line) or
 * `eleven:<conversation_id>` (/eleven).
 */
import { VoiceError } from "../types.js";
import {
	type ResidentBrainOptions,
	ResidentClaudeBrain,
} from "./ResidentClaudeBrain.js";

export interface ResidentBrainManagerOptions {
	/** global hard cap across ALL keys. Over the cap open() throws
	 * VoiceError("resource-exhausted") — fail-loud, no queueing. Default 4. */
	maxSessions?: number;
}

const DEFAULT_MAX_SESSIONS = 4;

export class ResidentBrainManager {
	private readonly maxSessions: number;
	private readonly brains = new Map<string, ResidentClaudeBrain>();
	/** every brain opened and not yet CONFIRMED reaped — forceKillAll's set
	 * AND the population the hard cap counts (a dying child still holds a
	 * process slot until its exit is confirmed — Codex #550 R1 HIGH). A brain
	 * whose dispose FAILED stays here: losing the kill handle is worse than
	 * over-counting (FLY-1148). */
	private readonly live = new Set<ResidentClaudeBrain>();
	/** every in-flight close() — closeAll must wait for ALL of these. */
	private readonly inFlightCloses = new Set<Promise<void>>();
	/** key → its latest in-flight close, so a repeat close(key) returns the
	 * SAME promise instead of resolving early (Codex #550 R2 MEDIUM). */
	private readonly closingByKey = new Map<string, Promise<void>>();

	constructor(opts: ResidentBrainManagerOptions = {}) {
		this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
	}

	/** idempotent: an existing key returns its brain untouched. */
	open(key: string, opts: ResidentBrainOptions): ResidentClaudeBrain {
		const existing = this.brains.get(key);
		if (existing) return existing;
		if (this.live.size >= this.maxSessions) {
			throw new VoiceError(
				"resource-exhausted",
				`resident brain session limit reached (${this.maxSessions}) — close a meeting (and let its process reap) before opening another`,
			);
		}
		const brain = new ResidentClaudeBrain(opts);
		this.brains.set(key, brain);
		this.live.add(brain);
		return brain;
	}

	get(key: string): ResidentClaudeBrain | undefined {
		return this.brains.get(key);
	}

	/** dispose + CONFIRM process exit before resolving. A repeat close(key)
	 * while the child is still dying returns the SAME in-flight promise. On a
	 * dispose failure the brain stays in the live set — the hard-timer
	 * forceKillAll must never lose its kill handle. */
	close(key: string): Promise<void> {
		const brain = this.brains.get(key);
		if (!brain) return this.closingByKey.get(key) ?? Promise.resolve();
		this.brains.delete(key);
		const done = (async () => {
			await brain.dispose();
			this.live.delete(brain); // slot freed only on CONFIRMED reap
		})();
		this.inFlightCloses.add(done);
		this.closingByKey.set(key, done);
		// cleanup on BOTH outcomes without creating a new unhandled rejection
		// (done.finally() would mint a second rejecting promise — Codex #550 R3);
		// the original rejection stays with `done` for the caller.
		const cleanup = (): void => {
			this.inFlightCloses.delete(done);
			if (this.closingByKey.get(key) === done) this.closingByKey.delete(key);
		};
		done.then(cleanup, cleanup);
		return done;
	}

	/** shutdown Phase 3: every child's exit confirmed — including closes that
	 * were already in flight when closeAll started; a failing dispose does
	 * not stop the others from being reaped (first error re-thrown after). */
	async closeAll(): Promise<void> {
		const pending = [...this.inFlightCloses];
		const closes = [...this.brains.keys()].map((k) => this.close(k));
		const results = await Promise.allSettled([...pending, ...closes]);
		const firstFailure = results.find(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		if (firstFailure) throw firstFailure.reason;
	}

	/** synchronous SIGKILL of every registered child — the shutdown outer
	 * hard-timer path: never exit the daemon with a live child behind. */
	forceKillAll(): void {
		for (const brain of [...this.live]) {
			try {
				brain.forceKill();
			} catch {
				// hard path: keep killing the rest
			}
		}
	}

	/** counts only — BrainPort's health endpoint must not leak keys/issues. */
	stats(): { active: number } {
		return { active: this.brains.size };
	}
}
