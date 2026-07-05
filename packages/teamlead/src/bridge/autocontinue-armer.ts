/**
 * FLY-818: AutoContinueArmer — the Bridge-side lifecycle-bound arming worker.
 *
 * Opt-in (default off via `FLYWHEEL_RUNNER_AUTOCONTINUE=1`). For each running,
 * arm-eligible (claude-tmux) runner it patiently observes the pane until an idle
 * input box appears, then sends `/loop <goal-path>` ONCE — putting the runner into
 * self-continue mode so it drives toward its phase goal instead of idling after a
 * turn (the FLY-818 root cause). Everything hard about this lives in pure, tested
 * helpers:
 *   - decideArmingAction (autocontinue-arming.ts) — lifecycle-bound decision;
 *   - buildGoalContract / resolveAutocontinueTarget (autocontinue-goal.ts);
 *   - durable goal file + armed marker (autocontinue-state.ts).
 *
 * This class is the thin I/O shell: poll running sessions, call the decision, and
 * on `send` write the goal file + send the keystroke + record the durable marker.
 * The marker makes arming idempotent across a Bridge restart (a re-driven observe
 * never sends a second `/loop`).
 *
 * NOTE: this is a SEPARATE poller from RunnerIdleWatchdog — it never touches the
 * stuck-detector / idle-notification path (M4: those keep running; only the Lead-
 * facing idle noise may be quieted elsewhere).
 */

import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { decideArmingAction } from "./autocontinue-arming.js";
import {
	type AutocontinueBudget,
	buildGoalContract,
	resolveAutocontinueTarget,
} from "./autocontinue-goal.js";
import {
	isAutocontinueArmed,
	markAutocontinueArmed,
	writeAutocontinueGoalFile,
} from "./autocontinue-state.js";
import { isCaptureError } from "./session-capture.js";
import type { TmuxTarget } from "./tmux-lookup.js";
import type { CaptureSessionFn } from "./tools.js";

/** Conservative default budget (env-tunable in the wiring layer). */
export const DEFAULT_AUTOCONTINUE_BUDGET: AutocontinueBudget = {
	maxContinuationTurns: 40,
	maxWallClockMinutes: 180,
	maxNoProgressTurns: 2,
};

export interface AutoContinueArmerConfig {
	pollIntervalMs: number;
	projects: ProjectEntry[];
	store: StateStore;
	captureSessionFn: CaptureSessionFn;
	getTmuxTarget: (
		executionId: string,
		projectName: string,
	) => TmuxTarget | undefined;
	sendKeys: (
		tmuxWindow: string,
		text: string,
	) => Promise<{ sent: boolean; error?: string }>;
	hasPendingGate: (executionId: string, projectName: string) => boolean;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	/** Override the lifecycle-bound arm window (else DEFAULT via decideArmingAction). */
	armWindowMs?: number;
	budget?: AutocontinueBudget;
	/** Monotonic uniquifier for audit event ids. */
	nextAuditSeq?: () => number;
}

export class AutoContinueArmer {
	private timer: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	/** Per-execution first-sighting time (ms) — the arm-observe window origin. */
	private observeStart = new Map<string, number>();
	private auditSeq = 0;

	constructor(private cfg: AutoContinueArmerConfig) {}

	private now(): number {
		return (this.cfg.now ?? Date.now)();
	}

	private env(): NodeJS.ProcessEnv {
		return this.cfg.env ?? process.env;
	}

	/** Opt-in; read per-poll so a hot flip needs no restart. Default OFF. */
	private enabled(): boolean {
		return this.env().FLYWHEEL_RUNNER_AUTOCONTINUE === "1";
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.poll().catch((err) => {
				console.error(
					"[AutoContinueArmer] poll rejection (contained):",
					err instanceof Error ? err.message : String(err),
				);
			});
		}, this.cfg.pollIntervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Exposed for tests — one poll cycle. */
	async pollOnce(): Promise<void> {
		return this.poll();
	}

	private audit(
		session: Session,
		result: "armed" | "fail-closed" | "refused",
		reason: string,
	): void {
		try {
			this.cfg.store.insertEvent({
				event_id: `autocontinue-arm-${session.execution_id}-${this.now()}-${this.nextSeq()}`,
				execution_id: session.execution_id,
				issue_id: session.issue_id ?? "unknown",
				project_name: session.project_name,
				event_type: "autocontinue_arm",
				severity: result === "armed" ? "info" : "warning",
				source: "bridge.autocontinue-armer",
				payload: { result, reason },
			});
		} catch (err) {
			console.error(
				`[AutoContinueArmer] audit write failed for ${session.execution_id}: ${(err as Error).message}`,
			);
		}
	}

	private nextSeq(): number {
		return (this.cfg.nextAuditSeq ?? (() => ++this.auditSeq))();
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		if (!this.enabled()) return;
		this.polling = true;
		try {
			const running = this.cfg.store
				.getActiveSessions()
				.filter((s) => s.status === "running");
			const activeIds = new Set(running.map((s) => s.execution_id));
			for (const id of this.observeStart.keys()) {
				if (!activeIds.has(id)) this.observeStart.delete(id);
			}
			for (const session of running) {
				await this.checkSession(session);
			}
		} catch (err) {
			console.warn(
				"[AutoContinueArmer] poll error (skipping cycle):",
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			this.polling = false;
		}
	}

	private async checkSession(session: Session): Promise<void> {
		const execId = session.execution_id;
		const target = resolveAutocontinueTarget({
			adapterType: session.adapter_type,
			sessionRole: session.session_role,
		});
		if (!target.armEligible) return;
		// Durable idempotence: already armed (or arming resolved) → never re-arm.
		if (isAutocontinueArmed(execId, this.env())) {
			this.observeStart.delete(execId);
			return;
		}

		let start = this.observeStart.get(execId);
		if (start === undefined) {
			start = this.now();
			this.observeStart.set(execId, start);
		}

		let capture: { ok: boolean; output?: string };
		try {
			const raw = await this.cfg.captureSessionFn(
				execId,
				session.project_name,
				100,
			);
			capture = isCaptureError(raw)
				? { ok: false }
				: { ok: true, output: raw.output };
		} catch {
			capture = { ok: false };
		}

		const action = decideArmingAction({
			alreadyArmed: false,
			status: session.status,
			capture,
			hasPendingGate: this.safePendingGate(session),
			elapsedMs: this.now() - start,
			armWindowMs: this.cfg.armWindowMs,
		});

		switch (action) {
			case "send":
				await this.arm(session, target.phase);
				return;
			case "fail-closed":
				// Give up arming for this execution — resolve durably so we don't
				// re-observe forever. The `/loop` was NOT sent; the runner degrades
				// to a plain (non-auto-continue) runner (byte-compat).
				markAutocontinueArmed(execId, this.env());
				this.observeStart.delete(execId);
				this.audit(
					session,
					"fail-closed",
					"arm window exceeded without idle input box",
				);
				return;
			// "wait" / "skip-gate": keep observing (a pending gate may clear).
			// "skip-terminal": the getActiveSessions filter already dropped it;
			// "skip-armed": handled by the marker check above.
			default:
				return;
		}
	}

	private safePendingGate(session: Session): boolean {
		try {
			return this.cfg.hasPendingGate(
				session.execution_id,
				session.project_name,
			);
		} catch {
			// Fail CLOSED (treat as pending gate) → do NOT arm on a probe error.
			return true;
		}
	}

	/** Arm: write goal file → send `/loop <goal>` once → mark armed durably. */
	private async arm(
		session: Session,
		phase: ReturnType<typeof resolveAutocontinueTarget>["phase"],
	): Promise<void> {
		const execId = session.execution_id;
		// 1. Write the durable goal file (throws → fail closed, retry next tick).
		let goalPath: string;
		try {
			const contract = buildGoalContract({
				phase,
				issueIdentifier: session.issue_identifier ?? session.issue_id,
				issueTitle: session.issue_title ?? undefined,
				budget: this.cfg.budget ?? DEFAULT_AUTOCONTINUE_BUDGET,
			});
			goalPath = writeAutocontinueGoalFile(execId, contract, this.env());
		} catch (err) {
			this.audit(
				session,
				"refused",
				`goal file write failed: ${(err as Error).message}`,
			);
			return; // not armed → retry next tick
		}
		// 2. Resolve the tmux target (none → retry next tick).
		const tmux = this.cfg.getTmuxTarget(execId, session.project_name);
		if (!tmux) {
			this.audit(session, "refused", "no tmux target");
			return;
		}
		// 3. COMMIT the durable armed marker BEFORE the keystroke (Codex code review
		//    R1 #1 — at-most-once). If the Bridge crashes/restarts after this write
		//    but before/around the send, the re-driven observe sees the marker and
		//    NEVER sends `/loop` again (no double-arm). If the marker write fails we
		//    are NOT committed → retry next tick (never send un-recorded).
		if (!markAutocontinueArmed(execId, this.env())) {
			this.audit(
				session,
				"refused",
				"armed marker write failed (not committed)",
			);
			return; // not committed → retry next tick
		}
		this.observeStart.delete(execId);
		// 4. Send `/loop <absolute goal path>` once (best-effort). A send failure now
		//    degrades THIS runner to a plain (non-auto-continue) runner — it is NOT
		//    retried (that would risk a double-arm on the next poll after a transient
		//    success); the marker already committed. Byte-compat: no worse than
		//    autocontinue-off for this one runner. Ops-visible via the audit.
		const loopCmd =
			`/loop 严格按目标契约自续跑:每轮先重读 ${goalPath} 再干,朝目标继续;` +
			`遇阻塞 gate / pending question 停下等答复(不要续);真卡住就升级。` +
			`到达目标 / 撞 gate / 无进展就停,别空转。`;
		const sent = await this.cfg.sendKeys(tmux.tmuxWindow, loopCmd);
		if (!sent.sent) {
			this.audit(
				session,
				"refused",
				`armed marker committed but tmux send failed (${sent.error ?? "unknown"}) — runner degrades to plain, NOT retried (avoids double-arm)`,
			);
			return;
		}
		this.audit(
			session,
			"armed",
			`sent /loop to ${tmux.tmuxWindow} (phase=${phase})`,
		);
	}
}
