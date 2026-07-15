/**
 * FLY-720: liveness-based crash-runner reaper.
 *
 * Closes the auto-cleanup gap for crashed / abnormally-exited Runners. The clean
 * completion paths (markers, FLY-324 done-but-running, FLY-172 marker drain) do
 * NOT cover a Runner that crashes without writing a completion marker: its cmux
 * `remain-on-exit on` window lingers as an `[exited]` dead-pin (FLY-622), the old
 * window-existence liveness read it as alive so FLY-623 readopt re-adopted it
 * forever, it never aged into an orphan, and `reapOrphans` never force-failed it
 * → a permanent `status=running` zombie (cmux residue + un-archived thread).
 *
 * This reaper runs on the heartbeat tick BEFORE `reapOrphans`, in two phases:
 *   Phase 1 (ownership) — for each running session stale ≥ orphan threshold that
 *     is a CONFIRMED dead-pin (`found` target + `probeRunnerProcessLiveness` ===
 *     `dead_pin`), claim it into `deadPinOwned` so `reapOrphans` skips it (never
 *     force-fails it to `failed`).
 *   Phase 2 (reap) — of the owned set, once stale ≥ crash grace: dump the
 *     scrollback (forensics) → tear down (cmux + window + terminal) → ONLY if the
 *     tmux kill succeeded, transition to `terminated` + prune CommDB + archive.
 *
 * Teardown-first / transition-after gives automatic retry: while the tmux kill is
 * `cleanup_pending` the row stays `running`, so the next cycle re-matches and
 * retries — no persisted retry surface needed. `absent` / no-target / indeterminate
 * are NOT owned here (they keep today's `reapOrphans` / suppression behavior).
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TransitionContext } from "flywheel-core";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type { Session, StateStore } from "../StateStore.js";
import type { FinalizeCommDbResult } from "./commdb-session-prune.js";
import type { RunnerLiveness, TmuxTargetLookup } from "./tmux-lookup.js";
import { sqliteDatetime } from "./types.js";

/** Default durable crash-log location. */
export function crashLogDir(): string {
	return join(homedir(), ".flywheel", "crash-logs");
}

/**
 * Write a runner's captured scrollback to a durable crash log: dir `0700`, file
 * `0600`, via temp-file + atomic rename. Best-effort — returns `{ error }` on
 * failure instead of throwing so the reap still proceeds (Codex R1 LOW-7).
 */
export function defaultWriteCrashLog(
	executionId: string,
	text: string,
	stampMs: number,
): { path?: string; error?: string } {
	try {
		const dir = crashLogDir();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// mkdir's `mode` is ignored for an ALREADY-existing dir (and subject to
		// umask on create), so enforce 0700 explicitly (Codex code R1 MEDIUM).
		chmodSync(dir, 0o700);
		const safeId = executionId.replace(/[^A-Za-z0-9._-]/g, "_");
		const path = join(dir, `${safeId}-${stampMs}.log`);
		// `wx` fails if a stale temp exists rather than reusing its (possibly wrong)
		// mode; the stampMs + pid keep it unique per reap. chmod after write closes
		// the umask gap before the atomic rename.
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		return { path };
	} catch (err) {
		return { error: (err as Error).message };
	}
}

/** Minutes since a sqlite-datetime heartbeat (UTC). Infinity when unknown. */
function staleMinutes(heartbeatAt: string | undefined, nowMs: number): number {
	if (!heartbeatAt) return Number.POSITIVE_INFINITY;
	const t = new Date(`${heartbeatAt.replace(" ", "T")}Z`).getTime();
	if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
	return (nowMs - t) / 60_000;
}

/** Static deps supplied once by plugin.ts (tmux / discord / fs sinks). */
export interface CrashReaperInjectedDeps {
	/**
	 * FLY-1185 (Codex R2#3, entry C): serialize each crash reap with the
	 * unified lifecycle executor's per-issue mutex — a crash teardown can
	 * never interleave with a ship/park/apply closeout on the same issue.
	 * Absent → legacy behavior (tests / non-Bridge assembly).
	 */
	lifecycleMutex?: {
		withIssueMutex: <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;
		resolveLockKeys: (issueId: string) => string[];
	};
	/** FLY-720 kill-switch: whole reaper off when false → reapOrphans→failed. */
	enabled: boolean;
	/** Forensics grace: reap only once heartbeat is stale ≥ this (≥ orphan threshold). */
	crashGraceMinutes: number;
	lookupTmuxTarget: (
		executionId: string,
		projectName: string,
	) => TmuxTargetLookup;
	probeLiveness: (tmuxWindow: string) => Promise<RunnerLiveness>;
	captureScrollback: (
		tmuxWindow: string,
	) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
	killCmuxLinkedSession: (
		tmuxWindow: string,
	) => Promise<{ killed: boolean; error?: string }>;
	killTmuxWindow: (
		tmuxWindow: string,
	) => Promise<{ killed: boolean; error?: string }>;
	/** Best-effort terminal-view close (does NOT gate cleanup_pending). */
	closeTerminalView?: (session: Session, tmuxWindow: string) => Promise<void>;
	finalizeCommDbSession: (
		executionId: string,
		projectName: string,
	) => FinalizeCommDbResult;
	/** Archive the issue thread (allowStatuses ["terminated"]), post-transition. */
	archiveThread?: (session: Session) => Promise<void>;
	/**
	 * FLY-1050: a reaped three-stage QA row may have stranded its implement at
	 * awaiting_review — notify the orchestrator (plugin.ts closes this over a
	 * fire-and-forget `reconcileQaLoss`). Called after the terminated transition
	 * commits, before archive, for `chat_thread_role === 'qa'` rows only.
	 * Optional + best-effort: absent/throwing never affects the reap (the boot
	 * reconcile is the backstop).
	 */
	onQaPhaseTerminated?: (executionId: string, issueId: string) => void;
	/** Override crash-log writer (tests). */
	writeCrashLog?: (
		executionId: string,
		text: string,
		stampMs: number,
	) => { path?: string; error?: string };
}

/** Per-cycle deps supplied by HeartbeatService. */
export interface CrashReapCycleDeps {
	store: StateStore;
	transitionOpts: ApplyTransitionOpts;
	orphanThresholdMinutes: number;
	nowMs: number;
	/** A session the reconcile pass classified alive-but-detached / marker-retry. */
	isSuppressed: (executionId: string) => boolean;
	/** FLY-172 pending complete marker → that drain owns the session. */
	hasPendingCompleteMarker: (executionId: string) => boolean;
	log?: (m: string) => void;
}

export type CrashReapDeps = CrashReaperInjectedDeps & CrashReapCycleDeps;

export interface CrashReapResult {
	/** execIds `reapOrphans` MUST skip this cycle (confirmed dead-pins). */
	deadPinOwned: Set<string>;
	confirmedDeadPinOwned: number;
	confirmedDeadButWaitingForGrace: number;
	reaped: number;
	cleanupPending: number;
	absentPassedToOrphan: number;
	indeterminateSuppressed: number;
	transitionSkipped: number;
}

export async function reapCrashedRunners(
	deps: CrashReapDeps,
): Promise<CrashReapResult> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const result: CrashReapResult = {
		deadPinOwned: new Set(),
		confirmedDeadPinOwned: 0,
		confirmedDeadButWaitingForGrace: 0,
		reaped: 0,
		cleanupPending: 0,
		absentPassedToOrphan: 0,
		indeterminateSuppressed: 0,
		transitionSkipped: 0,
	};
	if (!deps.enabled) return result;

	// Candidate set: running + heartbeat stale ≥ orphan threshold (Phase-1 gate).
	const candidates = deps.store.getOrphanSessions(deps.orphanThresholdMinutes);

	for (const session of candidates) {
		const execId = session.execution_id;
		// Alive-but-detached (reconnecting / monitor-lost / marker-retry) → never reap.
		if (deps.isSuppressed(execId)) continue;
		// FLY-172 drain owns a session with a pending complete marker.
		if (deps.hasPendingCompleteMarker(execId)) continue;
		if (!session.project_name) continue;

		// CommDB lookup indeterminacy (Codex R1 MED-3, GEO-374): a read `error` must
		// be suppressed (alive-for-suppression), never reaped. `gone` = no target →
		// reapOrphans owns it (unchanged).
		const lookup = deps.lookupTmuxTarget(execId, session.project_name);
		if (lookup.kind === "error") {
			result.indeterminateSuppressed++;
			continue;
		}
		if (lookup.kind === "gone") continue;

		const tmuxWindow = lookup.target.tmuxWindow;
		let liveness: RunnerLiveness;
		try {
			liveness = await deps.probeLiveness(tmuxWindow);
		} catch (err) {
			// Defensive: an unexpected probe throw is indeterminate → suppress.
			log(`[crash-reaper] ${execId}: probe threw (${(err as Error).message})`);
			result.indeterminateSuppressed++;
			continue;
		}

		if (liveness === "alive") continue; // still working (defensive)
		if (liveness === "indeterminate") {
			result.indeterminateSuppressed++;
			continue;
		}
		if (liveness === "absent") {
			// Window gone → NOT a dead-pin; leave for reapOrphans → failed (unchanged).
			result.absentPassedToOrphan++;
			continue;
		}

		// liveness === "dead_pin": Phase 1 ownership — reapOrphans MUST skip it.
		result.deadPinOwned.add(execId);
		result.confirmedDeadPinOwned++;

		// Phase 2 gate: reap only once stale ≥ crash grace (forensics window).
		const stale = staleMinutes(session.heartbeat_at, deps.nowMs);
		if (stale < deps.crashGraceMinutes) {
			result.confirmedDeadButWaitingForGrace++;
			continue; // owned, waiting out the forensics window
		}

		if (deps.lifecycleMutex) {
			const keys = deps.lifecycleMutex.resolveLockKeys(session.issue_id);
			await deps.lifecycleMutex.withIssueMutex(keys, () =>
				reapOne(session, tmuxWindow, stale, deps, result, log),
			);
		} else {
			await reapOne(session, tmuxWindow, stale, deps, result, log);
		}
	}

	return result;
}

/** The teardown-first reap sequence for one confirmed dead-pin past grace. */
async function reapOne(
	session: Session,
	tmuxWindow: string,
	stale: number,
	deps: CrashReapDeps,
	result: CrashReapResult,
	log: (m: string) => void,
): Promise<void> {
	const execId = session.execution_id;
	const projectName = session.project_name;

	// 1. Forensics dump BEFORE teardown (best-effort).
	const cap = await deps.captureScrollback(tmuxWindow);
	let crashLogPath: string | undefined;
	let dumpError: string | undefined;
	if (cap.ok) {
		const w = (deps.writeCrashLog ?? defaultWriteCrashLog)(
			execId,
			cap.text,
			deps.nowMs,
		);
		crashLogPath = w.path;
		dumpError = w.error;
	} else {
		dumpError = cap.error;
	}

	// 2. Teardown while still running. cleanup_pending iff a tmux kill returns a
	//    real error (not already-gone). Terminal close is best-effort and does NOT
	//    gate cleanup_pending (Codex design R2 LOW-4).
	//
	// ORDER MATTERS (Codex code R1 HIGH): kill the cmux linked session FIRST and
	// return `cleanup_pending` WITHOUT killing the window if it fails. cmux cleanup
	// resolves `cmux-<window_name>` from the still-alive window; if we killed the
	// window on a cmux failure, next cycle the window is gone → the probe reads
	// `absent` (not `dead_pin`) → the session drops out of `deadPinOwned` →
	// reapOrphans force-fails it to `failed` (skipping terminated + archive) AND the
	// cmux session loses its only re-resolution point. Leaving the window alive keeps
	// it a `dead_pin` the next cycle re-owns and retries.
	const cmux = await deps.killCmuxLinkedSession(tmuxWindow);
	if (!cmux.killed) {
		result.cleanupPending++;
		log(
			`[crash-reaper] ${execId}: cmux kill failed (${cmux.error ?? "unknown"}) — leaving window alive as dead_pin, retry next cycle`,
		);
		return; // window untouched → still a dead_pin → re-owned + retried next cycle
	}
	const win = await deps.killTmuxWindow(tmuxWindow);
	if (!win.killed) {
		result.cleanupPending++;
		log(
			`[crash-reaper] ${execId}: window kill failed (${win.error ?? "unknown"}) — leaving running, retry next cycle`,
		);
		return; // window still there (dead_pin) → re-owned + retried next cycle
	}
	// Both kills succeeded — best-effort terminal-view close (never gates the reap).
	if (deps.closeTerminalView) {
		try {
			await deps.closeTerminalView(session, tmuxWindow);
		} catch (e) {
			log(
				`[crash-reaper] ${execId}: terminal close warn: ${(e as Error).message}`,
			);
		}
	}

	// FLY-1238: once the physical runner is gone, retire every unresolved gate
	// in the same transaction that deletes its CommDB session. Failure blocks
	// terminalization and archive so the row remains eligible for retry.
	const finalized = deps.finalizeCommDbSession(execId, projectName);
	deps.store.recordCommDbFinalizeOutcome({
		executionId: execId,
		issueId: session.issue_id,
		projectName,
		ok: finalized.ok,
		error: finalized.error,
	});
	if (!finalized.ok) {
		result.cleanupPending++;
		log(
			`[crash-reaper] ${execId}: CommDB finalization failed (${finalized.error ?? "unknown"}) — retry next cycle`,
		);
		return;
	}

	// 3. Re-read status and branch on the post-teardown FSM race (Codex R2 MED-3).
	const current = deps.store.getSession(execId);
	if (current && current.status === "running") {
		const ctx: TransitionContext = {
			executionId: execId,
			issueId: session.issue_id,
			projectName,
			trigger: "crash_reap",
		};
		const forensics = crashLogPath ?? `dump_failed:${dumpError ?? "unknown"}`;
		const tr = applyTransition(deps.transitionOpts, execId, "terminated", ctx, {
			last_activity_at: sqliteDatetime(),
			last_error: `Crashed (process dead, no marker) — reaped. forensics=${forensics}`,
		});
		if (!tr.ok) {
			log(
				`[crash-reaper] ${execId}: FSM rejected running→terminated after teardown: ${tr.error}`,
			);
			return;
		}
		// FLY-1050: a reaped three-stage QA row may have stranded its implement —
		// hand the loss to the orchestrator (before archive; best-effort).
		if (
			(session.chat_thread_role ?? "main") === "qa" &&
			deps.onQaPhaseTerminated
		) {
			try {
				deps.onQaPhaseTerminated(execId, session.issue_id);
			} catch (err) {
				log(
					`[crash-reaper] ${execId}: onQaPhaseTerminated threw: ${(err as Error).message}`,
				);
			}
		}
		if (deps.archiveThread) {
			const reaped = deps.store.getSession(execId) ?? {
				...session,
				status: "terminated",
			};
			await deps.archiveThread(reaped);
		}
		deps.store.insertEvent({
			event_id: `crash-reaped-${execId}`,
			execution_id: execId,
			issue_id: session.issue_id,
			project_name: projectName,
			event_type: "runner_crash_reaped",
			source: "bridge.crash-reaper",
			payload: {
				tmuxWindow,
				crashLogPath: crashLogPath ?? null,
				dumpError: dumpError ?? null,
				minutesSinceHeartbeat: Math.round(stale),
			},
		});
		result.reaped++;
		return;
	}

	// Concurrent completion/event/action moved the row off `running`: do NOT force
	// `terminated`. Prune the (already killed) CommDB row and record the skip; the
	// concurrent terminal status owns its own archive.
	deps.store.insertEvent({
		event_id: `crash-reap-skip-${execId}`,
		execution_id: execId,
		issue_id: session.issue_id,
		project_name: projectName,
		event_type: "runner_crash_teardown_transition_skipped",
		source: "bridge.crash-reaper",
		payload: {
			tmuxWindow,
			actualStatus: current?.status ?? "missing",
			crashLogPath: crashLogPath ?? null,
		},
	});
	result.transitionSkipped++;
}
