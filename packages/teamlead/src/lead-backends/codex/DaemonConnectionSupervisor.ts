/**
 * FLY-259 PR-B — DaemonConnectionSupervisor: the generation-fenced rebuild
 * lifecycle for a Codex Lead whose CodexLeadProcess speaks to the shared
 * remote-control daemon over WS (design review R5 HIGH-2 — every rule below
 * is review-pinned, do not relax):
 *
 *   1. connection loss → FENCE the current generation immediately: events from
 *      the old generation are ignored from this point (generation-id check),
 *      and the old generation is stopped — which runs `stopGateway()` FIRST
 *      (CodexLeadRuntime.stop() order), so the gateway cannot keep durably
 *      accepting inbound for a dead executor during the rebuild window;
 *   2. the old generation's own exit semantics (reject pending → executor
 *      ambiguous → health unhealthy) run inside CodexLeadProcess as today;
 *   3. exactly ONE rebuild loop per Lead — duplicate close events and stale
 *      old-generation events cannot spawn a second loop;
 *   4. old wiring is torn down BEFORE the daemon is re-ensured and a brand-new
 *      generation (new CodexLeadProcess — it is one-shot by design, R4 HIGH-3)
 *      is built, behind a bounded backoff;
 *   5. the new generation's `start()` runs the FLY-224 order internally
 *      (initialize → thread/resume re-pin → journal recover → gateway LAST).
 *
 * Backoff resets only after a new generation SURVIVES `stableAfterMs` — an
 * immediately-dying daemon must escalate, not tight-loop at the lowest step.
 * The supervisor never gives up (launchd-style persistence); health surfaces
 * the outage meanwhile. All effects (clock, timers, daemon ensure, generation
 * factory) are injected for unit tests.
 */

export interface SupervisedGeneration {
	/** Bring everything up in FLY-224 order; resolves once the gateway is up. */
	start(): Promise<void>;
	/** Stop gateway FIRST, then process. Best-effort + idempotent. */
	stop(): Promise<void>;
	/** Subscribe to THIS generation's connection death. Returns unsubscribe. */
	onConnectionLost(cb: () => void): () => void;
}

export interface DaemonConnectionSupervisorOptions {
	buildGeneration: (generationId: number) => SupervisedGeneration;
	/** `codex remote-control start` (idempotent) — re-ensured before every build. */
	ensureDaemon: () => Promise<void>;
	/** Bounded backoff steps; the last value is the cap (retried forever). */
	backoffStepsMs?: number[];
	/** A generation must live this long for the backoff to reset. */
	stableAfterMs?: number;
	log?: (m: string) => void;
	// injectable effects (tests)
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000];
const DEFAULT_STABLE_AFTER_MS = 30_000;

export class DaemonConnectionSupervisor {
	private readonly o: DaemonConnectionSupervisorOptions;
	private readonly backoff: number[];
	private readonly stableAfterMs: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private readonly log: (m: string) => void;

	private generationId = 0;
	private current: SupervisedGeneration | null = null;
	private unsubscribe: (() => void) | undefined;
	private rebuilding = false;
	private stopped = false;
	private backoffIdx = 0;
	private lastStartAt = 0;
	/** In-flight bring-up (code review R1 HIGH-1): stop() must await it and
	 * then stop the generation it produced — a pending gen.start() must never
	 * complete into a live gateway after stop(). */
	private inflightBringUp: Promise<void> | null = null;
	/** Loss latch (code review R1 HIGH-2 + R2 HIGH-2): a loss for the
	 * generation CURRENTLY bringing up (initial boot OR rebuild) is recorded
	 * here — never acted on concurrently — and checked after the bring-up
	 * settles. */
	private pendingLossGenerationId: number | null = null;
	/** The generation currently inside bringUpNewGeneration (R2 HIGH-2). */
	private bringingUpGenerationId: number | null = null;

	constructor(options: DaemonConnectionSupervisorOptions) {
		this.o = options;
		this.backoff = options.backoffStepsMs ?? DEFAULT_BACKOFF_MS;
		this.stableAfterMs = options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
		this.sleep =
			options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.now = options.now ?? (() => Date.now());
		this.log = options.log ?? (() => {});
	}

	/** Initial bring-up. Throws on first-start failure (boot is fail-loud —
	 * launchd restarts the whole Lead; the rebuild loop is only for losses
	 * AFTER a successful start). */
	async start(): Promise<void> {
		if (this.stopped) throw new Error("supervisor already stopped");
		// R2 HIGH-1: the WHOLE startup (incl. ensureDaemon) is the in-flight
		// unit stop() must await — and stopped is rechecked after ensure so a
		// stop() arriving mid-ensure prevents any generation from being built.
		const p = (async () => {
			await this.o.ensureDaemon();
			if (this.stopped) return;
			await this.bringUpNewGeneration();
		})();
		this.inflightBringUp = p;
		try {
			await p;
		} finally {
			this.inflightBringUp = null;
		}
		await this.stopIfRaced();
		// R2 HIGH-2: the initial generation may have died DURING its own
		// bring-up (latched, never acted on concurrently) — initial boot is
		// fail-loud: sweep and throw (launchd restarts the Lead).
		if (!this.stopped && this.pendingLossGenerationId === this.generationId) {
			this.pendingLossGenerationId = null;
			this.fenceCurrent();
			const gen = this.current as SupervisedGeneration | null;
			this.current = null;
			if (gen) await gen.stop();
			throw new Error("generation lost connection during initial bring-up");
		}
	}

	/** Explicit shutdown — cancels any rebuild loop and stops the current
	 * generation. Safe to call at any await point of a rebuild (checked after
	 * every async step) and safe to call twice. */
	async stop(): Promise<void> {
		this.stopped = true;
		// R1 HIGH-1: a pending bring-up must settle BEFORE we sweep — otherwise
		// its gen.start() can complete into a live gateway after stop().
		const inflight = this.inflightBringUp;
		if (inflight) {
			await inflight.catch(() => {});
		}
		this.fenceCurrent();
		const gen = this.current;
		this.current = null;
		if (gen) await gen.stop();
	}

	/** After any awaited bring-up: if stop() raced us, sweep the generation. */
	private async stopIfRaced(): Promise<void> {
		if (!this.stopped) return;
		this.fenceCurrent();
		const gen = this.current as SupervisedGeneration | null;
		this.current = null;
		if (gen) await gen.stop();
	}

	isRebuilding(): boolean {
		return this.rebuilding;
	}

	// ── internals ────────────────────────────────────────────────────────────

	private fenceCurrent(): void {
		// Step 1 (fence): drop the old subscription — together with the
		// generation-id closure check in the listener and the `rebuilding`
		// latch this makes stale old-generation events inert. The id itself
		// is incremented ONLY by bringUpNewGeneration (single owner — a
		// fence+bringUp pair must advance the id exactly once).
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private async bringUpNewGeneration(): Promise<void> {
		const genId = this.generationId + 1;
		this.generationId = genId;
		const gen = this.o.buildGeneration(genId);
		this.current = gen;
		this.unsubscribe = gen.onConnectionLost(() => {
			// Fencing: only the CURRENT generation may trigger a rebuild.
			if (genId !== this.generationId || this.stopped) return;
			if (genId === this.bringingUpGenerationId || this.rebuilding) {
				// R1 HIGH-2 + R2 HIGH-2: this generation is still INSIDE its own
				// bring-up (initial boot or rebuild) — latch; the awaiter checks
				// after start settles. Acting concurrently here would overlap
				// generations (CodexLeadRuntime.stop() cannot cancel an
				// in-flight start). Never silently swallowed.
				this.pendingLossGenerationId = genId;
				return;
			}
			void this.onLoss();
		});
		this.bringingUpGenerationId = genId;
		try {
			await gen.start(); // FLY-224 order inside; gateway comes up LAST
		} finally {
			this.bringingUpGenerationId = null;
		}
		this.lastStartAt = this.now();
	}

	private async onLoss(): Promise<void> {
		// Step 3: exactly one rebuild loop. Duplicate close events of the same
		// generation race here — the flag makes the second a no-op (the fence
		// in fenceCurrent() additionally kills cross-generation stragglers).
		if (this.rebuilding || this.stopped) return;
		this.rebuilding = true;
		this.log("daemon connection lost — fencing generation and rebuilding");
		try {
			// Step 1+4: fence, then tear down the OLD wiring before anything new.
			this.fenceCurrent();
			const old = this.current;
			this.current = null;
			if (old) {
				await old.stop(); // gateway stops FIRST inside (review-pinned)
			}
			// Escalation accounting: a generation that died before stabilizing
			// keeps climbing the backoff ladder.
			if (this.now() - this.lastStartAt >= this.stableAfterMs) {
				this.backoffIdx = 0;
			}
			// Step 4 continued: bounded-backoff rebuild, forever (launchd-style).
			while (!this.stopped) {
				const wait = this.backoff[
					Math.min(this.backoffIdx, this.backoff.length - 1)
				] as number;
				this.backoffIdx = Math.min(
					this.backoffIdx + 1,
					this.backoff.length - 1,
				);
				await this.sleep(wait);
				if (this.stopped) return;
				try {
					await this.o.ensureDaemon();
					if (this.stopped) return;
					this.pendingLossGenerationId = null;
					const p = this.bringUpNewGeneration();
					this.inflightBringUp = p;
					try {
						await p;
					} finally {
						this.inflightBringUp = null;
					}
					if (this.stopped) {
						await this.stopIfRaced();
						return;
					}
					// R1 HIGH-2: did THIS generation die during its own bring-up?
					if (this.pendingLossGenerationId === this.generationId) {
						this.pendingLossGenerationId = null;
						throw new Error("generation lost connection during bring-up");
					}
					this.log("daemon connection re-established (new generation up)");
					return;
				} catch (err) {
					this.log(
						`rebuild attempt failed (will retry): ${(err as Error).message}`,
					);
					// fence whatever half-came-up and try again
					this.fenceCurrent();
					const half = this.current as SupervisedGeneration | null;
					this.current = null;
					if (half) await half.stop();
				}
			}
		} finally {
			this.rebuilding = false;
		}
	}
}
