/**
 * FLY-742: stale-blocker guard for the `/api/runs/start` active-session 409.
 *
 * A runner that FINISHES + parks (awaiting_review / approved_to_ship) but never
 * emits its terminal `completed` event lingers as the issue's ACTIVE session
 * forever. The next SCHEDULED/CRON run-start for that issue then gets a 409, and
 * schedulers treat the 409 as a benign quiet skip — so the daily job silently
 * stops until a human notices (FLY-742, 2nd occurrence on the Sub daily-loop).
 *
 * This guard runs in the 409 path (every caller — external Sub cron, the in-repo
 * xhs scheduler, Leads, humans — hits the same endpoint) and does one of:
 *   - block_silent   — genuinely-running or freshly-parked blocker → unchanged
 *                      409, NO alert, NO `gh` call (the normal in-flight guard).
 *   - finalize_proceed — stale parked blocker whose PR is MERGED/CLOSED → the
 *                      Bridge auto-finalizes it (fail-closed teardown → completed)
 *                      and the run-start proceeds (same-tick self-heal).
 *   - alert_block    — stale parked blocker whose PR is still open/unknown →
 *                      durable Discord alert to the issue's Lead, still 409
 *                      (never auto-clears a session the founder still owns).
 *
 * Merged/closed PR = the founder already decided (via merge) → auto-finalize is
 * Bridge system-health cleanup (crash-reaper precedent), NOT a founder-gated
 * agent action. Unknown PR state is fail-safe: alert only, never auto-clear.
 */

import type { TransitionContext } from "flywheel-core";
import type { Session } from "../StateStore.js";
import type { FinalizeCommDbResult } from "./commdb-session-prune.js";
import type { HookPayload } from "./hook-payload.js";
import type { DeliveryResult, LeadEventEnvelope } from "./lead-runtime.js";
import type { TmuxTargetLookup } from "./tmux-lookup.js";

export const SCHEDULED_RUN_BLOCKED_EVENT = "scheduled_run_blocked";

export type LocalClass = "block_silent" | "needs_pr_check";
export type PrState = "merged" | "closed" | "open" | "unknown";

/** Park states that FLY-742 acts on. `running` is left to the in-flight guard /
 * crash-reaper; other statuses are terminal/pre-run. */
const PARK_STATES = new Set(["awaiting_review", "approved_to_ship"]);

/** Terminal/outcome statuses that mean the slot is already free (re-read guard). */
const SLOT_FREE_STATES = new Set([
	"completed",
	"terminated",
	"failed",
	"blocked",
	"rejected",
	"deferred",
	"shelved",
	"approved",
]);

/** Parse a SQLite UTC datetime ("YYYY-MM-DD HH:MM:SS") to epoch ms; NaN if unparseable. */
export function parseSqliteUtcMs(ts: string | undefined | null): number {
	if (!ts) return Number.NaN;
	return new Date(`${ts.replace(" ", "T")}Z`).getTime();
}

/**
 * The status-specific idle anchor for a parked blocker (Codex R1 #3):
 * `awaiting_review` anchors on `awaiting_review_entered_at` (fall back to
 * `last_activity_at`); `approved_to_ship` anchors on `last_activity_at` (an
 * approve only bumps last_activity_at — using the old review entry timestamp
 * would falsely classify a freshly-approved session as stale).
 */
export function staleAnchor(input: {
	status: string;
	awaitingReviewEnteredAt?: string;
	lastActivityAt?: string;
}): string | undefined {
	if (input.status === "approved_to_ship") return input.lastActivityAt;
	return input.awaitingReviewEnteredAt ?? input.lastActivityAt;
}

export interface LocalClassifyInput {
	status: string;
	awaitingReviewEnteredAt?: string;
	lastActivityAt?: string;
	nowMs: number;
	staleTtlMs: number;
}

/**
 * Phase 1 — LOCAL-ONLY classification (zero I/O). Only a stale PARKED blocker
 * reaches Phase 2 (`gh` PR-state check). `running`, freshly-parked, or
 * missing/unparseable-anchor blockers stay `block_silent` and never hit `gh`
 * (Codex R1 #2 — no GitHub latency on the normal run-start hot path).
 */
export function classifyBlockerLocal(i: LocalClassifyInput): {
	local: LocalClass;
	reason: string;
} {
	if (!PARK_STATES.has(i.status)) {
		return {
			local: "block_silent",
			reason: `not a parked state (${i.status})`,
		};
	}
	const anchorMs = parseSqliteUtcMs(
		staleAnchor({
			status: i.status,
			awaitingReviewEnteredAt: i.awaitingReviewEnteredAt,
			lastActivityAt: i.lastActivityAt,
		}),
	);
	if (!Number.isFinite(anchorMs)) {
		return { local: "block_silent", reason: "no parseable idle anchor" };
	}
	const idleMs = i.nowMs - anchorMs;
	if (idleMs < i.staleTtlMs) {
		return {
			local: "block_silent",
			reason: `parked but fresh (idle ${Math.round(idleMs / 60000)}m < TTL)`,
		};
	}
	return {
		local: "needs_pr_check",
		reason: `stale parked (idle ${Math.round(idleMs / 60000)}m >= TTL)`,
	};
}

/**
 * Phase 2 — with the PR state, decide finalize vs alert. `unknown` is fail-safe
 * (alert only, never auto-clear).
 */
export function classifyStaleWithPr(prState: PrState): {
	action: "finalize_proceed" | "alert_block";
	reason: string;
} {
	if (prState === "merged" || prState === "closed") {
		return {
			action: "finalize_proceed",
			reason: `PR ${prState} — done, safe to auto-finalize`,
		};
	}
	return {
		action: "alert_block",
		reason: `PR ${prState} — not resolved, alert only`,
	};
}

// ── Side-effecting finalize (testable seam — Codex R1 #7) ────────────────────

/** Minimal StateStore surface the finalize path needs (fakeable in tests). */
export interface FinalizeStore {
	getSession(execId: string): Session | undefined;
	recordCommDbFinalizeOutcome(input: {
		executionId: string;
		issueId: string;
		projectName: string;
		ok: boolean;
		error?: string;
	}): unknown;
	insertEvent(e: {
		event_id: string;
		execution_id: string;
		issue_id: string;
		project_name: string;
		event_type: string;
		source: string;
		payload?: unknown;
	}): boolean;
}

export interface FinalizeStaleBlockerDeps {
	store: FinalizeStore;
	lookupTmuxTarget: (execId: string, projectName: string) => TmuxTargetLookup;
	killCmuxLinkedSession: (
		tmuxWindow: string,
	) => Promise<{ killed: boolean; error?: string }>;
	killTmuxWindow: (
		tmuxWindow: string,
	) => Promise<{ killed: boolean; error?: string }>;
	closeTerminalView?: (session: Session, tmuxWindow: string) => Promise<void>;
	finalizeCommDbSession: (
		execId: string,
		projectName: string,
	) => FinalizeCommDbResult;
	applyTransition: (
		execId: string,
		target: string,
		ctx: TransitionContext,
		fields: Record<string, unknown>,
	) => { ok: boolean; error?: string };
	archiveThread?: (session: Session) => Promise<void>;
	sqliteNow: () => string;
	log?: (m: string) => void;
}

/**
 * Fail-closed teardown → `completed` transition for a stale merged/closed-PR
 * blocker. Mirrors crash-reaper's ordering discipline: cmux kill gates window
 * kill; any real kill failure or an indeterminate tmux lookup leaves state
 * unchanged and returns `{proceed:false}` so the NEXT tick retries (never
 * releases the slot while the old runner might still be alive — Codex R1 #1).
 * Re-reads status before teardown AND before transition (Codex R1 #4).
 */
export async function finalizeStaleBlocker(
	blocker: Session,
	prState: PrState,
	deps: FinalizeStaleBlockerDeps,
): Promise<{ proceed: boolean }> {
	const execId = blocker.execution_id;
	const project = blocker.project_name;
	if (!project) return { proceed: false };
	const finalizeCommunications = (): FinalizeCommDbResult => {
		const finalized = deps.finalizeCommDbSession(execId, project);
		deps.store.recordCommDbFinalizeOutcome({
			executionId: execId,
			issueId: blocker.issue_id,
			projectName: project,
			ok: finalized.ok,
			error: finalized.error,
		});
		return finalized;
	};

	// Re-read #1 — before any destructive teardown.
	const cur = deps.store.getSession(execId);
	if (!cur) {
		return { proceed: finalizeCommunications().ok };
	}
	if (SLOT_FREE_STATES.has(cur.status)) {
		return { proceed: finalizeCommunications().ok };
	}
	if (!PARK_STATES.has(cur.status)) return { proceed: false }; // became running/pending → don't touch

	// tmux tri-state — fail-closed on `error` (indeterminate ≠ gone).
	const lookup = deps.lookupTmuxTarget(execId, project);
	let toreDown = false;
	if (lookup.kind === "error") {
		deps.store.insertEvent({
			event_id: `cron-stale-finalize-indeterminate-${execId}`,
			execution_id: execId,
			issue_id: blocker.issue_id,
			project_name: project,
			event_type: "cron_stale_finalize_indeterminate",
			source: "bridge.stale-blocker-guard",
			payload: { error: lookup.error },
		});
		deps.log?.(
			`[stale-blocker] ${execId}: tmux lookup indeterminate — not finalizing, retry next tick`,
		);
		return { proceed: false };
	}
	if (lookup.kind === "found") {
		const w = lookup.target.tmuxWindow;
		const cmux = await deps.killCmuxLinkedSession(w);
		if (!cmux.killed) {
			deps.log?.(
				`[stale-blocker] ${execId}: cmux kill failed (${cmux.error ?? "unknown"}) — window untouched, retry next tick`,
			);
			return { proceed: false };
		}
		const win = await deps.killTmuxWindow(w);
		if (!win.killed) {
			deps.log?.(
				`[stale-blocker] ${execId}: window kill failed (${win.error ?? "unknown"}) — retry next tick`,
			);
			return { proceed: false };
		}
		toreDown = true;
		if (deps.closeTerminalView) {
			try {
				await deps.closeTerminalView(cur, w);
			} catch (e) {
				deps.log?.(
					`[stale-blocker] ${execId}: terminal close warn: ${(e as Error).message}`,
				);
			}
		}
	}
	// lookup.kind === "gone" → no tmux target to clean.

	// FLY-1238: physical absence is not a completed teardown until unresolved
	// founder gates and the CommDB session are retired atomically.
	const finalized = finalizeCommunications();
	if (!finalized.ok) {
		deps.store.insertEvent({
			event_id: `cron-stale-finalize-commdb-failed-${execId}`,
			execution_id: execId,
			issue_id: blocker.issue_id,
			project_name: project,
			event_type: "scheduled_run_blocker_commdb_finalize_failed",
			source: "bridge.stale-blocker-guard",
			payload: { error: finalized.error, prState },
		});
		deps.log?.(
			`[stale-blocker] ${execId}: CommDB finalization failed (${finalized.error ?? "unknown"}) — retry next tick`,
		);
		return { proceed: false };
	}

	// Re-read #2 — before the transition.
	const cur2 = deps.store.getSession(execId);
	if (!cur2) return { proceed: toreDown };
	if (SLOT_FREE_STATES.has(cur2.status)) {
		// Concurrent terminalization after teardown — mirror crash-reaper's
		// concurrent-move branch: prune the (already killed) CommDB row + audit,
		// the concurrent terminal status owns its own archive (Codex R3 #2).
		if (toreDown || lookup.kind === "gone") {
			deps.store.insertEvent({
				event_id: `cron-stale-finalize-skip-${execId}`,
				execution_id: execId,
				issue_id: blocker.issue_id,
				project_name: project,
				event_type: "scheduled_run_blocker_finalize_transition_skipped",
				source: "bridge.stale-blocker-guard",
				payload: { actualStatus: cur2.status, prState },
			});
		}
		return { proceed: true };
	}
	if (!PARK_STATES.has(cur2.status)) return { proceed: false };

	// Transition → completed. `prState` is stated verbatim (merged | closed) —
	// never "merged successfully" (a closed-unmerged PR also reaches here).
	const ctx: TransitionContext = {
		executionId: execId,
		issueId: blocker.issue_id,
		projectName: project,
		trigger: "cron_stale_finalize",
	};
	const tr = deps.applyTransition(execId, "completed", ctx, {
		last_activity_at: deps.sqliteNow(),
		last_error: `Auto-finalized (FLY-742): done+parked, PR ${prState}, idle past TTL — freed cron slot`,
	});
	if (!tr.ok) {
		deps.log?.(
			`[stale-blocker] ${execId}: transition to completed rejected: ${tr.error}`,
		);
		return { proceed: false };
	}

	deps.store.insertEvent({
		event_id: `scheduled-run-blocker-finalized-${execId}`,
		execution_id: execId,
		issue_id: blocker.issue_id,
		project_name: project,
		event_type: "scheduled_run_blocker_finalized",
		source: "bridge.stale-blocker-guard",
		payload: { prState, statusBefore: cur2.status, tmux: lookup.kind },
	});
	if (deps.archiveThread) {
		const finalized = deps.store.getSession(execId) ?? {
			...blocker,
			status: "completed",
		};
		try {
			await deps.archiveThread(finalized as Session);
		} catch (e) {
			deps.log?.(
				`[stale-blocker] ${execId}: thread archive warn: ${(e as Error).message}`,
			);
		}
	}
	return { proceed: true };
}

// ── Side-effecting durable alert (testable seam — Codex R1 #5, R2 #2) ─────────

/** Minimal StateStore surface the alert path needs (fakeable in tests). */
export interface AlertStore {
	tryClaimLeadEvent(
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey?: string,
	): boolean;
	appendLeadEvent(
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey?: string,
	): number;
	markLeadEventDelivered(seq: number): void;
	recordDeliveryFailure(seq: number, error: string): void;
}

export interface AlertStaleBlockerDeps {
	store: AlertStore;
	resolveLeadId: (blocker: Session) => string | undefined;
	deliver: (
		leadId: string,
		envelope: LeadEventEnvelope,
	) => Promise<DeliveryResult>;
	isoNow: () => string;
	log?: (m: string) => void;
}

/** The stable per-incident anchor used in the dedup event id. */
export function staleBlockerEventAnchor(blocker: Session): string {
	return (
		staleAnchor({
			status: blocker.status,
			awaitingReviewEnteredAt: blocker.awaiting_review_entered_at,
			lastActivityAt: blocker.last_activity_at,
		}) ??
		blocker.last_activity_at ??
		"unknown"
	);
}

/**
 * Durable, deduped "scheduled run blocked" alert to the issue's Lead. Persisted
 * dedup via `tryClaimLeadEvent` on a stable `(leadId, event_id)`; the event type
 * is in GUARDRAIL_EVENT_TYPES so a failed inline delivery is redelivered by
 * `HeartbeatService.retryUndeliveredGuardrailEvents()` (reliability boundary is
 * the persisted lead_events row, NOT an in-memory set — Codex R1 #5).
 *
 * Ordering (Codex R2 #2): resolve lead + build payload → `tryClaimLeadEvent`
 * (first-time gate) → `appendLeadEvent` (same id → UNIQUE-conflict path returns
 * the existing seq) → deliver → mark/record.
 */
export async function alertStaleBlockerToLead(
	blocker: Session,
	prState: PrState,
	idleHours: number,
	deps: AlertStaleBlockerDeps,
): Promise<void> {
	const execId = blocker.execution_id;
	const idLabel = blocker.issue_identifier ?? blocker.issue_id;
	const eventId = `scheduled-run-blocked:${execId}:${staleBlockerEventAnchor(blocker)}`;

	const leadId = deps.resolveLeadId(blocker);
	if (!leadId) {
		deps.log?.(
			`[stale-blocker] no Lead resolved for ${blocker.project_name}/${idLabel} — cannot alert`,
		);
		return;
	}

	const payload: HookPayload = {
		event_type: SCHEDULED_RUN_BLOCKED_EVENT,
		execution_id: execId,
		issue_id: blocker.issue_id,
		issue_identifier: blocker.issue_identifier,
		issue_title: blocker.issue_title,
		project_name: blocker.project_name,
		status: blocker.status,
		minutes_since_activity: Math.round(idleHours * 60),
		summary: `A scheduled/cron run-start for ${idLabel} was DECLINED — a prior session (${execId}, ${blocker.status}, PR ${blocker.pr_number ?? "?"} ${prState}, idle ~${idleHours}h) still holds the slot and never finalized. The scheduled job will keep silently skipping until this is cleared. Resolve it: close_runner to finalize the stale session, or ship/merge its PR.`,
		notification_context: `Tell Annie a scheduled job is blocked by a stale session (${idLabel}) that needs clearing.`,
	};
	const payloadStr = JSON.stringify(payload);
	const sessionKey = `stale-blocker:${blocker.issue_id}`;

	// Persisted dedup — first tick claims, later ticks (same incident) skip.
	const claimed = deps.store.tryClaimLeadEvent(
		leadId,
		eventId,
		SCHEDULED_RUN_BLOCKED_EVENT,
		payloadStr,
		sessionKey,
	);
	if (!claimed) {
		deps.log?.(`[stale-blocker] ${eventId}: already alerted — dedup skip`);
		return;
	}
	// Recover the seq for the row the claim just inserted (UNIQUE-conflict path).
	const seq = deps.store.appendLeadEvent(
		leadId,
		eventId,
		SCHEDULED_RUN_BLOCKED_EVENT,
		payloadStr,
		sessionKey,
	);
	const envelope: LeadEventEnvelope = {
		seq,
		event: payload,
		sessionKey,
		leadId,
		timestamp: deps.isoNow(),
	};
	try {
		const result = await deps.deliver(leadId, envelope);
		if (result.delivered) deps.store.markLeadEventDelivered(seq);
		else
			deps.store.recordDeliveryFailure(
				seq,
				result.error ?? "deliver returned false",
			);
	} catch (e) {
		deps.store.recordDeliveryFailure(seq, (e as Error).message);
	}
}

// ── Orchestration (mounted in runs-route via plugin.ts) ──────────────────────

export interface StaleBlockerGuardDeps {
	/** FLYWHEEL_CRON_STALE_GUARD !== "0" (default-on). */
	enabled: boolean;
	/** FLYWHEEL_CRON_STALE_TTL_MIN (default 120), in ms. */
	staleTtlMs: number;
	now: () => number;
	checkPrState: (projectRoot: string, prNumber: number) => Promise<PrState>;
	finalizeBlocker: (
		blocker: Session,
		prState: PrState,
	) => Promise<{ proceed: boolean }>;
	alertLead: (
		blocker: Session,
		prState: PrState,
		idleHours: number,
	) => Promise<void>;
	projectRootFor: (projectName: string) => string | undefined;
	log?: (m: string) => void;
}

export interface StaleBlockerGuard {
	handleActiveBlocker(blocker: Session): Promise<{ proceed: boolean }>;
}

export function createStaleBlockerGuard(
	deps: StaleBlockerGuardDeps,
): StaleBlockerGuard {
	// In-memory, finally-released per-(exec:anchor) lock — serializes concurrent
	// run-start attempts WITHOUT a permanent claim (a permanent session_events
	// claim would poison retries after a transient teardown failure — Codex R2 #1).
	const inFlightFinalize = new Set<string>();

	return {
		async handleActiveBlocker(blocker) {
			if (!deps.enabled) return { proceed: false };

			const nowMs = deps.now();
			const anchor = staleAnchor({
				status: blocker.status,
				awaitingReviewEnteredAt: blocker.awaiting_review_entered_at,
				lastActivityAt: blocker.last_activity_at,
			});
			const local = classifyBlockerLocal({
				status: blocker.status,
				awaitingReviewEnteredAt: blocker.awaiting_review_entered_at,
				lastActivityAt: blocker.last_activity_at,
				nowMs,
				staleTtlMs: deps.staleTtlMs,
			});
			if (local.local === "block_silent") return { proceed: false };

			// Phase 2 — only a locally-stale parked blocker reaches `gh`.
			const projectRoot = blocker.project_name
				? deps.projectRootFor(blocker.project_name)
				: undefined;
			const prNumber = blocker.pr_number;
			const prState: PrState =
				prNumber && projectRoot
					? await deps.checkPrState(projectRoot, prNumber)
					: "unknown";
			const d = classifyStaleWithPr(prState);

			if (d.action === "finalize_proceed") {
				const key = `${blocker.execution_id}:${anchor ?? ""}`;
				if (inFlightFinalize.has(key)) return { proceed: false };
				inFlightFinalize.add(key);
				try {
					return await deps.finalizeBlocker(blocker, prState);
				} finally {
					inFlightFinalize.delete(key);
				}
			}

			const idleHours = anchor
				? Math.max(
						0,
						Math.round((nowMs - parseSqliteUtcMs(anchor)) / 3_600_000),
					)
				: 0;
			await deps.alertLead(blocker, prState, idleHours);
			return { proceed: false };
		},
	};
}
