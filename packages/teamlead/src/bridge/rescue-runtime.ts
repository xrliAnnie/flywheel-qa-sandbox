/**
 * FLY-871 R3 — rescue RUNTIME: binds the pure `rescue.ts` orchestration to the
 * real Bridge primitives (StateStore alert rows, launchctl kickstart, tmux pane
 * capture/Enter, session close + resumed-successor dispatch, live re-classify).
 *
 * Every risky primitive stays an injected seam so this module is unit-testable
 * without touching real launchd / tmux / sessions; plugin.ts passes the real
 * implementations (gated on `FLYWHEEL_ACCOUNT_SELF_HEAL`, so the whole runtime is
 * dormant + byte-compat when self-heal is off). The real-machine drill is the §8
 * QA gate.
 */

import {
	isThreeStagePhaseRole,
	type PhaseDispatchVendor,
	type RoleEffort,
	resolvePhaseDispatch,
} from "flywheel-config";
import type { AlertThreadRow, Session } from "../StateStore.js";
import {
	type PendingAlert,
	type PostEvidenceFn,
	postSwitchRescueSweep,
	type RescueAuditEntry,
	type RescueOutcome,
	type ResolveAlertFn,
	rescueLead,
	rescueRunner,
} from "./rescue.js";

/** Only the last N lines of a runner pane are re-classified (the live region). */
const REVALIDATE_RECENT_LINES = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Alert-row → PendingAlert mapping (pure).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a still-pending `alert_threads` row to the rescue guard's `PendingAlert`.
 * `listActiveAlertThreads()` returns only rows with `resolved_at IS NULL`, so a
 * row's presence IS "still pending". The `authLimit` evidence is not persisted;
 * reconstruct the `:suspicious` marker from the runner event_id's trailing
 * category so `isConfirmed` still refuses a low-confidence anomaly. Lead rows
 * carry a pane-hash event_id + no suspicious variant → evidence undefined =
 * confirmed (correct: a lead `login_expired` alert is always a real logout).
 */
export function mapAlertThreadToPendingAlert(
	row: AlertThreadRow,
): PendingAlert {
	let evidence: string | undefined;
	if (row.event_type === "runner_login_expired") {
		evidence = row.event_id.endsWith(":suspicious")
			? "runner-pane:suspicious"
			: "runner-pane:login_expired";
	}
	return {
		correlationKey: row.correlation_key,
		eventType: row.event_type,
		sessionKey: row.session_key,
		leadId: row.lead_id,
		projectName: row.project_name,
		evidence,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// launchctl kickstart (lead rescue action).
// ─────────────────────────────────────────────────────────────────────────────

/** The launchd label for a project's Lead: `com.flywheel.lead.<project>-<leadId>`. */
export function leadLaunchdLabel(projectName: string, leadId: string): string {
	return `com.flywheel.lead.${projectName}-${leadId}`;
}

export interface KickstartDeps {
	/** Injected launchctl runner (tests stub it); defaults to a real execFile. */
	exec?: (
		cmd: string,
		args: string[],
	) => Promise<{ code: number; stderr: string }>;
	/** The GUI domain uid (defaults to the current process uid). */
	uid?: number;
	log?: (msg: string) => void;
}

/**
 * `launchctl kickstart -k gui/<uid>/com.flywheel.lead.<project>-<leadId>` — the
 * `-k` restarts the (running) job in place so it re-reads the fresh Keychain.
 * Returns true on exit 0; false (never throws) otherwise.
 */
export function makeKickstart(
	deps: KickstartDeps = {},
): (projectName: string, leadId: string) => Promise<boolean> {
	const uid = deps.uid ?? process.getuid?.() ?? 0;
	const exec = deps.exec ?? defaultLaunchctlExec;
	return async (projectName, leadId) => {
		const target = `gui/${uid}/${leadLaunchdLabel(projectName, leadId)}`;
		try {
			const { code, stderr } = await exec("launchctl", [
				"kickstart",
				"-k",
				target,
			]);
			if (code !== 0) {
				deps.log?.(
					`[rescue] kickstart ${target} exit ${code}: ${stderr.trim()}`,
				);
				return false;
			}
			return true;
		} catch (err) {
			deps.log?.(
				`[rescue] kickstart ${target} threw: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return false;
		}
	};
}

async function defaultLaunchctlExec(
	cmd: string,
	args: string[],
): Promise<{ code: number; stderr: string }> {
	const { execFile } = await import("node:child_process");
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 10_000 }, (err, _stdout, stderr) => {
			const code =
				err && typeof (err as { code?: unknown }).code === "number"
					? ((err as { code: number }).code ?? 1)
					: err
						? 1
						: 0;
			resolve({ code, stderr: stderr ?? "" });
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner revalidation (Lead ②): re-capture the live pane + re-classify.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunnerRevalidateDeps {
	/** Capture the runner's live pane (null ⇒ capture failed / no window). */
	captureRunnerPane: (executionId: string) => Promise<string | null>;
	/** Re-run the layered detector on the recent region. */
	classify: (region: string) => Promise<{ category: string }>;
	recentLines?: number;
}

/**
 * Build the `revalidate` seam `rescueRunner` calls immediately before its
 * destructive close+dispatch. A capture failure THROWS (⇒ rescueRunner refuses
 * AND escalates — never close on uncertainty); a successful capture returns
 * `{ confirmed: category === "login_expired", category }`.
 */
export function makeRunnerRevalidate(
	deps: RunnerRevalidateDeps,
): (executionId: string) => Promise<{ confirmed: boolean; category?: string }> {
	const n = deps.recentLines ?? REVALIDATE_RECENT_LINES;
	return async (executionId) => {
		const pane = await deps.captureRunnerPane(executionId);
		if (pane == null) {
			throw new Error("runner pane capture failed (cannot revalidate)");
		}
		const region = pane.split("\n").slice(-n).join("\n");
		const result = await deps.classify(region);
		return {
			confirmed: result.category === "login_expired",
			category: result.category,
		};
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// W4 — close the dead RUNNING session + dispatch a resumed successor.
// The normal `retry` action structurally refuses a still-`running` session
// (workflow-fsm retry.fromStates = failed/blocked/rejected + the active-session
// gate), so this is a dedicated composition (plan C9): FSM `running→terminated`
// first (so `closeRunner` — which refuses `running` — can tear it down and the
// successor lane frees), then close, then dispatch a `start()` successor (only
// `start()` runs the FLY-795 resume-computer; the retry `dispatch()` path does
// NOT resume from progress.md).
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseAndDispatchDeps {
	getSession: (executionId: string) => Session | undefined;
	/**
	 * FSM-transition the running session to `terminated` (a legal `running→…`
	 * edge; `terminated` stays resumable, mirrors the crash-reaper). Returns ok.
	 */
	terminateForRescue: (session: Session) => { ok: boolean; error?: string };
	/** Kill the tmux/terminal for the (now terminated) session. Idempotent. */
	closeRunner: (
		session: Session,
	) => Promise<{ closed: boolean; error?: string }>;
	/**
	 * Dispatch a resumed successor via `RunDispatcher.start()` (runs the FLY-795
	 * resume-computer with resumeKind "restart" → `$FLYWHEEL_PROGRESS_PATH`).
	 * Returns the new execution id; THROWS on failure / duplicate inflight.
	 */
	startSuccessor: (session: Session) => Promise<string>;
	log?: (msg: string) => void;
}

/**
 * FLY-1224 (R1 #1 — the 6th dispatch lane): the phase-aware dispatch fields
 * for a rescue SUCCESSOR. A PHASE row (durable `chat_thread_role` marker, same
 * discriminator as actions.ts) re-derives {model, vendor, effort} from the
 * phase table and keeps its shared-branch identity + phase sessionRole —
 * orchestrator-spawned phase rows usually persist NO dispatch_model, so
 * forwarding only `s.dispatch_model` would rescue a codex implement back onto
 * claude-tmux on an independent branch. sessionRole follows the durable marker
 * too (R2 #3): a polluted row can carry chat_thread_role=implement while
 * session_role drifted to main. Non-phase rows: byte-compatible passthrough.
 * Pure + exported so the REAL production derivation is unit-testable (T4b).
 */
export function buildRescueSuccessorDispatchFields(
	s: Pick<Session, "chat_thread_role" | "session_role" | "dispatch_model">,
): {
	sessionRole?: string;
	dispatchModel?: string;
	dispatchVendor?: PhaseDispatchVendor;
	dispatchEffort?: RoleEffort;
	ignoreRunnerLabelSelection?: true;
	shareParentBranch?: true;
} {
	const phaseRole = isThreeStagePhaseRole(s.chat_thread_role)
		? s.chat_thread_role
		: undefined;
	if (!phaseRole) {
		return {
			sessionRole: s.session_role ?? undefined,
			dispatchModel: s.dispatch_model ?? undefined,
		};
	}
	const dispatch = resolvePhaseDispatch(phaseRole);
	return {
		sessionRole: phaseRole,
		dispatchModel: dispatch.model,
		dispatchVendor: dispatch.vendor,
		dispatchEffort: dispatch.effort,
		ignoreRunnerLabelSelection: true,
		shareParentBranch: true,
	};
}

export function makeCloseAndDispatchSuccessor(
	deps: CloseAndDispatchDeps,
): (executionId: string) => Promise<string | null> {
	return async (executionId) => {
		const session = deps.getSession(executionId);
		if (!session) {
			deps.log?.(`[rescue] session ${executionId} not found — refusing`);
			return null;
		}
		// Only a still-`running` (kicked-out) session is a rescue target. Any
		// terminal / awaiting state is NOT a logged-out running runner → refuse
		// (also makes a retry after a partial prior attempt converge to null, not
		// a second successor).
		if (session.status !== "running") {
			deps.log?.(
				`[rescue] session ${executionId} status=${session.status} (not running) — refusing`,
			);
			return null;
		}
		// 1) FSM off `running` first.
		const tr = deps.terminateForRescue(session);
		if (!tr.ok) {
			deps.log?.(
				`[rescue] terminate ${executionId} failed: ${tr.error ?? "fsm"} — refusing`,
			);
			return null;
		}
		// 2) Close the dead tmux (idempotent; `alreadyGone` ⇒ closed:true).
		const closed = await deps.closeRunner(session);
		if (!closed.closed) {
			deps.log?.(
				`[rescue] close ${executionId} failed: ${closed.error ?? "unknown"} — not dispatching a successor onto a live tmux`,
			);
			return null;
		}
		// 3) Dispatch a resumed successor.
		try {
			return await deps.startSuccessor(session);
		} catch (err) {
			deps.log?.(
				`[rescue] startSuccessor for ${executionId} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return null;
		}
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The full rescue runtime — binds rescueLead / rescueRunner / sweep to real deps.
// ─────────────────────────────────────────────────────────────────────────────

export interface RescueRuntimeDeps {
	/** Live still-pending alert rows (mapped to PendingAlert). */
	listPendingAlerts: () => AlertThreadRow[];
	// Lead rescue seams.
	kickstart: (projectName: string, leadId: string) => Promise<boolean>;
	captureLeadPane: (
		projectName: string,
		leadId: string,
	) => Promise<string | null>;
	sendEnterToLead: (projectName: string, leadId: string) => Promise<void>;
	isResumeMenu: (pane: string) => boolean;
	// Runner rescue seams.
	revalidateRunner: (
		executionId: string,
	) => Promise<{ confirmed: boolean; category?: string }>;
	closeAndDispatchSuccessor: (executionId: string) => Promise<string | null>;
	// Shared. postEvidence routes into the incident thread (threadKey) + can @-ping
	// the founder (mention); resolveAlert clears the thread when the session heals.
	postEvidence: PostEvidenceFn;
	resolveAlert?: ResolveAlertFn;
	audit: (e: RescueAuditEntry) => void;
	waitMs?: (ms: number) => Promise<void>;
	log?: (msg: string) => void;
}

export interface RescueRuntime {
	rescueLead: (input: {
		projectName: string;
		leadId: string;
	}) => Promise<RescueOutcome>;
	rescueRunner: (input: { executionId: string }) => Promise<RescueOutcome>;
	postSwitchRescueSweep: () => Promise<RescueOutcome[]>;
}

export function buildRescueRuntime(deps: RescueRuntimeDeps): RescueRuntime {
	const pendingAlerts = (): PendingAlert[] =>
		deps.listPendingAlerts().map(mapAlertThreadToPendingAlert);

	const rescueLeadFn = (input: { projectName: string; leadId: string }) =>
		rescueLead(input, {
			pendingAlerts,
			kickstart: deps.kickstart,
			capturePane: deps.captureLeadPane,
			sendEnter: (projectName, leadId) =>
				deps.sendEnterToLead(projectName, leadId),
			isResumeMenu: deps.isResumeMenu,
			postEvidence: deps.postEvidence,
			resolveAlert: deps.resolveAlert,
			audit: deps.audit,
			waitMs: deps.waitMs,
		});

	const rescueRunnerFn = (input: { executionId: string }) =>
		rescueRunner(input, {
			pendingAlerts,
			revalidate: deps.revalidateRunner,
			closeAndDispatchSuccessor: deps.closeAndDispatchSuccessor,
			postEvidence: deps.postEvidence,
			resolveAlert: deps.resolveAlert,
			audit: deps.audit,
		});

	const sweep = () =>
		postSwitchRescueSweep({
			pendingAlerts,
			rescueLead: rescueLeadFn,
			rescueRunner: rescueRunnerFn,
			log: deps.log,
		});

	return {
		rescueLead: rescueLeadFn,
		rescueRunner: rescueRunnerFn,
		postSwitchRescueSweep: sweep,
	};
}
