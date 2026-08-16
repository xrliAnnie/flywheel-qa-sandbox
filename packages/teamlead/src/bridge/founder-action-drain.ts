/**
 * FLY-1099 §3.3 — the founder action ledger drain.
 *
 * Executes durable `founder_action_ledger` intents (thread notices / codex
 * nudges / feedback wakes / must-deliver alerts) with:
 *   1. dependency gating + TERMINAL PROPAGATION (Codex R2 #2 + R3 #3): a wake
 *      never runs before its queue parent is delivered; a failed / cancelled /
 *      superseded parent cancels the child (never a permanent pending);
 *   2. per-kind ELIGIBILITY RE-VERIFY at drain time (a moved-on session never
 *      receives a stale nudge/wake);
 *   3. bounded at-least-once execution: success → delivered; failure →
 *      attempts+1 (retried next drain pass); attempts ≥ max → terminal
 *      `failed` + a follow-up `emit_alert` intent in the SAME transaction —
 *      EXCEPT for `emit_alert` rows themselves, which terminate bounded
 *      (audit + console.error) so the alert chain never recursively multiplies
 *      (Codex R4 #3).
 *
 * Sink-side dedup (Codex R3 #3): codex instructions carry the action_key as a
 * stable CommDB id (INSERT OR IGNORE); founder thread POSTs and alerts are
 * explicitly at-least-once (a crash between the side effect and the
 * `delivered` mark may repeat one message — accepted, never lost).
 *
 * Runs on the GatePoller founder-reply sub-cadence. Already-committed
 * notices/alerts converge independently from founder-reply ingestion.
 */

import type {
	FounderActionIntent,
	FounderActionRow,
	SessionEvent,
} from "../StateStore.js";
import type { MergedGateGuard } from "./merged-gate-guard.js";

export interface FounderActionDrainStore {
	listPendingFounderActions(): FounderActionRow[];
	getFounderAction(actionKey: string): FounderActionRow | undefined;
	markFounderActionDelivered(actionKey: string): void;
	recordFounderActionFailure(actionKey: string, error: string): number;
	markFounderActionFailed(input: {
		actionKey: string;
		error: string;
		nowMs: number;
		alertIntent?: FounderActionIntent;
	}): void;
	cancelFounderAction(actionKey: string, reason: string): void;
	insertEvent(event: SessionEvent): boolean;
	getSession(
		executionId: string,
	):
		| { status?: string; pr_head_sha?: string; pr_number?: number | null }
		| undefined;
}

/** Real-outcome alert sink (LeadAlertNotifier satisfies it). */
export interface DrainAlertSink {
	alert(payload: {
		leadId: string;
		projectName: string;
		eventId: string;
		eventType: string;
		title: string;
		body: string;
		severity: string;
		sessionKey?: string;
	}): Promise<{
		sent?: boolean;
		queued?: boolean;
		deadLettered?: boolean;
		skipped?: string;
	}>;
}

export interface FounderActionDrainDeps {
	store: FounderActionDrainStore;
	/** Post a founder-facing notice to a thread. */
	postNotice(args: {
		threadId: string;
		text: string;
		projectName: string;
		executionId: string;
	}): Promise<{ ok: boolean; error?: string }>;
	/** Non-authoritative mailbox wake. */
	wake(args: {
		projectName: string;
		executionId: string;
		content: string;
		metadata: Record<string, unknown>;
	}): Promise<{ ok: boolean; error?: string }>;
	/** Must-deliver alert sink (duplicate claim ≠ receipt — §7.1). */
	alertSink?: DrainAlertSink;
	/** Lead routing for the failed-action alert (infra-owner fallback inside). */
	resolveAlertRoute(
		projectName: string,
		executionId: string,
	): { leadId: string } | undefined;
	nowMs?: () => number;
	env?: Record<string, string | undefined>;
	/** FLY-1238: shared last-mile guard for founder notice rows only. */
	mergedGateGuard?: MergedGateGuard;
	resolveProjectRoot?: (projectName: string) => string | undefined;
}

export const FOUNDER_NOTIFY_RETRY_MAX = 5;

const NOTICE_KINDS = new Set([
	"held_reply",
	"ttl_expired_notice",
	"head_drift_notice",
	"rebound_notice",
]);

function parsePayload(row: FounderActionRow): Record<string, unknown> {
	try {
		const parsed = JSON.parse(row.payload);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** FLY-605 wake footer: a wake is a HINT, never authority. */
const NON_AUTHORITATIVE_FOOTER =
	"\n这条不是授权——ship 前必须跑 verify-approval。";

export function feedbackWakeContent(feedback: string): string {
	return (
		"Annie 的修改意见(hold 清除后自动补绑生效,完整原文):\n" +
		`${feedback}\n` +
		"请按反馈修复后重新 push + re-request review。" +
		NON_AUTHORITATIVE_FOOTER
	);
}

interface ExecResult {
	ok: boolean;
	error?: string;
}

function verifyEligibility(
	row: FounderActionRow,
	deps: FounderActionDrainDeps,
): { ok: true } | { ok: false; reason: string } {
	// R2 #2: re-verify the expected context AT EXECUTION time — never deliver a
	// stale action. Notice kinds rely on supersede-at-source (the terminal
	// transaction marks pending held_reply rows superseded), so pending status
	// itself is their eligibility.
	if (row.kind === "feedback_wake") {
		const session = deps.store.getSession(row.execution_id);
		if (!session) return { ok: false, reason: "session_missing" };
		return { ok: true };
	}
	return { ok: true };
}

async function executeAction(
	row: FounderActionRow,
	payload: Record<string, unknown>,
	deps: FounderActionDrainDeps,
): Promise<ExecResult> {
	if (NOTICE_KINDS.has(row.kind)) {
		const text = typeof payload.text === "string" ? payload.text : "";
		if (!row.thread_id || !text) {
			return { ok: false, error: "notice_missing_thread_or_text" };
		}
		return deps.postNotice({
			threadId: row.thread_id,
			text,
			projectName: row.project_name,
			executionId: row.execution_id,
		});
	}
	if (row.kind === "feedback_wake") {
		const content = feedbackWakeContent(
			typeof payload.feedback === "string" ? payload.feedback : "",
		);
		return deps.wake({
			projectName: row.project_name,
			executionId: row.execution_id,
			content,
			metadata: {
				kind: row.kind,
				actionKey: row.action_key,
				...(typeof payload.questionId === "string"
					? { questionId: payload.questionId }
					: {}),
				...(typeof payload.msgId === "string" ? { msgId: payload.msgId } : {}),
			},
		});
	}
	if (row.kind === "emit_alert") {
		if (!deps.alertSink) return { ok: false, error: "no_alert_sink" };
		const alert = (payload.alert ?? {}) as Record<string, unknown>;
		const baseEventId =
			typeof alert.eventId === "string" ? alert.eventId : row.action_key;
		// §7.1: claims.db dedup is permanent; a claim without a POST must not
		// satisfy us. Retries carry an attempt-salted eventId so a
		// crashed-after-claim episode can still deliver.
		const eventId =
			row.attempts > 0 ? `${baseEventId}:r${row.attempts}` : baseEventId;
		const res = await deps.alertSink.alert({
			leadId: typeof alert.leadId === "string" ? alert.leadId : "",
			projectName:
				typeof alert.projectName === "string"
					? alert.projectName
					: row.project_name,
			eventId,
			eventType:
				typeof alert.eventType === "string"
					? alert.eventType
					: "founder_notify_dead_letter",
			title: typeof alert.title === "string" ? alert.title : "Founder alert",
			body: typeof alert.body === "string" ? alert.body : "",
			severity: typeof alert.severity === "string" ? alert.severity : "warning",
			...(typeof alert.sessionKey === "string"
				? { sessionKey: alert.sessionKey }
				: {}),
		});
		// Real outcomes only: sent / queued / deadLettered are receipts (the
		// notifier's queue + dead-letter are durable); skipped ("duplicate" —
		// claim-not-receipt — or a config gap) is NOT.
		if (res.sent || res.queued || res.deadLettered) return { ok: true };
		return { ok: false, error: `alert_skipped_${res.skipped ?? "unknown"}` };
	}
	return { ok: false, error: `unknown_kind_${row.kind}` };
}

function buildFailedActionAlertIntent(
	row: FounderActionRow,
	error: string,
	attempts: number,
	nowMs: number,
	deps: FounderActionDrainDeps,
): FounderActionIntent {
	const route = deps.resolveAlertRoute(row.project_name, row.execution_id);
	return {
		actionKey: `emit-alert-${row.action_key}`,
		kind: "emit_alert",
		executionId: row.execution_id,
		issueId: row.issue_id,
		projectName: row.project_name,
		threadId: row.thread_id,
		payload: {
			alert: {
				leadId: route?.leadId ?? "",
				projectName: row.project_name,
				// R3 #4/R4 #3: the durable salt is failed_at_ms (= nowMs here, the
				// same value markFounderActionFailed writes in this transaction).
				eventId: `founder-notify-dl-${row.action_key}-${nowMs}`,
				eventType: "founder_notify_dead_letter",
				title: `Founder notify dead-letter — ${row.kind} (${row.issue_id})`,
				body:
					`Founder-facing action ${row.action_key} (${row.kind}) failed terminally after ${attempts} attempts: ${error}. ` +
					"The intended notice/wake did NOT reach its target — check the thread/bot/session and re-drive manually if needed.",
				severity: "warning",
			},
		},
	};
}

async function drainOne(
	row: FounderActionRow,
	deps: FounderActionDrainDeps,
	maxAttempts: number,
	nowMs: number,
): Promise<void> {
	// 1. Dependency gate + terminal propagation (R2 #2 / R3 #3).
	if (row.depends_on) {
		const parent = deps.store.getFounderAction(row.depends_on);
		if (!parent) {
			deps.store.cancelFounderAction(row.action_key, "parent_missing");
			return;
		}
		if (parent.status === "pending") return; // wait — parent first
		if (parent.status !== "delivered") {
			deps.store.cancelFounderAction(row.action_key, `parent_${parent.status}`);
			return;
		}
	}

	// 2. Eligibility re-verify.
	const payload = parsePayload(row);
	const elig = verifyEligibility(row, deps);
	if (!elig.ok) {
		deps.store.cancelFounderAction(row.action_key, elig.reason);
		return;
	}

	// FLY-1238: notice eligibility can change between durable queueing and the
	// actual Discord POST. Guard at this last mile; guard retries never consume
	// the action ledger's independent delivery-attempt budget.
	if (NOTICE_KINDS.has(row.kind) && deps.mergedGateGuard) {
		const questionId =
			typeof payload.questionId === "string" ? payload.questionId : "";
		const session = deps.store.getSession(row.execution_id);
		const guarded = await deps.mergedGateGuard({
			executionId: row.execution_id,
			issueId: row.issue_id,
			questionId,
			projectName: row.project_name,
			projectRoot: deps.resolveProjectRoot?.(row.project_name),
			prNumber: session?.pr_number ?? undefined,
			source: "action_drain",
		});
		if (guarded.kind === "retry_later") return;
		if (guarded.kind === "suppress_merged") {
			deps.store.cancelFounderAction(row.action_key, "pr_merged");
			return;
		}
		if (guarded.kind === "terminal_unavailable") {
			deps.store.cancelFounderAction(
				row.action_key,
				`merged_guard_terminal_${guarded.reason}`,
			);
			return;
		}
	}

	// 3. Execute → outcome.
	let result: ExecResult;
	try {
		result = await executeAction(row, payload, deps);
	} catch (err) {
		result = { ok: false, error: (err as Error).message };
	}
	if (result.ok) {
		deps.store.markFounderActionDelivered(row.action_key);
		return;
	}
	const error = result.error ?? "unknown";
	const attempts = deps.store.recordFounderActionFailure(row.action_key, error);
	if (attempts < maxAttempts) return; // bounded retry next drain pass

	if (row.kind === "emit_alert") {
		// R4 #3: an emit_alert's own terminal failure NEVER spawns another
		// emit_alert — bounded terminal: durable failed + audit + console.error.
		deps.store.markFounderActionFailed({
			actionKey: row.action_key,
			error,
			nowMs,
		});
		deps.store.insertEvent({
			event_id: `founder-alert-emit-exhausted-${row.action_key}`,
			execution_id: row.execution_id,
			issue_id: row.issue_id,
			project_name: row.project_name,
			event_type: "founder_alert_emit_exhausted",
			source: "bridge.founder-action-drain",
			payload: { actionKey: row.action_key, attempts, error },
		});
		console.error(
			`[founder-action-drain] emit_alert ${row.action_key} exhausted after ${attempts} attempts: ${error}`,
		);
		return;
	}
	// Terminal failure of a non-alert action → failed + emit_alert intent in
	// ONE transaction (§7.1 must-deliver).
	deps.store.markFounderActionFailed({
		actionKey: row.action_key,
		error,
		nowMs,
		alertIntent: buildFailedActionAlertIntent(
			row,
			error,
			attempts,
			nowMs,
			deps,
		),
	});
}

export async function drainFounderActionLedger(
	deps: FounderActionDrainDeps,
): Promise<void> {
	const rows = deps.store.listPendingFounderActions();
	if (rows.length === 0) return;
	const maxAttempts = FOUNDER_NOTIFY_RETRY_MAX;
	const nowMs = deps.nowMs?.() ?? Date.now();
	for (const row of rows) {
		try {
			await drainOne(row, deps, maxAttempts, nowMs);
		} catch (err) {
			// Never abort the drain — the row stays pending for the next pass.
			console.warn(
				`[founder-action-drain] drain error for ${row.action_key}: ${(err as Error).message}`,
			);
		}
	}
}
