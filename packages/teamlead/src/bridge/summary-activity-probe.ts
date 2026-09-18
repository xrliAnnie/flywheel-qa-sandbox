export const SUMMARY_ACTIVITY_PROBE_VERSION = 4;
export const SUMMARY_ACTIVITY_RETENTION_RESERVE_MS = 2 * 60 * 60_000;

export const SUMMARY_ACTIVITY_NOISE_EVENT_TYPES = [
	"summary_due",
	"summary_due_skipped",
	"summary_slot_settled",
	"summary_absorption_round",
	"patrol_tick",
	"flag_scan_no_clock",
	"receipt_foundation_off",
	"quota_switch_confirmation",
	"codex_quota_automation_disabled",
	"usage_limit",
	"session_monitoring_lost",
	"session_monitoring_reestablished",
	"inbox_loop_stalled",
	"mailbox_dead_letter",
	"delivery_dead_letter",
	"checkpoint_park_nudge",
	"zombie_session_backlog",
] as const;

export const SUMMARY_ACTIVITY_BUSINESS_EVENT_TYPES = [
	"runner_question",
	"gate_question",
	"founder_reply",
	"stage_changed",
	"workflow_engine_escalation",
	"epic_intake",
	"session_started",
	"session_completed",
	"session_failed",
	"workflow_claim_recorded",
	"workflow_replacement_eligibility",
	"action_executed",
	"review_job_failed",
	"session_zombie_detected",
	"session_stuck",
	"session_orphaned",
	"session_stale_completed",
	"auto_qa_stuck",
	"pane_hash_stuck",
	"runner_idle_detected",
	"runner_park_notice",
	"runner_stuck_escalation",
	"runner_lead_pending_escalation",
	"detection_escalation",
	"detection_suspicious",
	"detection_page_undeliverable",
	"rate_limit",
	"bridge_abnormal_exit",
	"gate_timed_out",
	"scheduled_run_blocked",
] as const;

const SUMMARY_ACTIVITY_NOISE_EVENT_TYPE_SET = new Set<string>(
	SUMMARY_ACTIVITY_NOISE_EVENT_TYPES,
);

export interface LeadEventsCursor {
	decision_seq: number;
}

export interface MailboxCursor {
	allocated_seq: number;
	instance: {
		schema_generation: string;
		completed_at: string;
	};
}

export type SourceResult =
	| { status: "ok"; count: number }
	| { status: "unavailable"; reason: string }
	| { status: "not_bound"; count: 0 };

export interface ActivityWindow {
	fromMs: number;
	toMs: number;
}

export interface PreviousDecision {
	decisionAtMs: number;
	decisionSeq: number;
	window: ActivityWindow;
	mailboxCursor: MailboxCursor | null;
}

export interface PreviousDecisionEvidence {
	decisionAtMs: number | null;
	decisionSeq: number | null;
	window: ActivityWindow | null;
	mailboxCursor: MailboxCursor | null;
	error: "corrupt_cursor" | null;
}

export interface MailboxActivitySnapshot {
	count: number;
	allocatedSeq: number;
	instance: MailboxCursor["instance"];
}

export interface ActivityProbeResult {
	verdict: "active" | "quiet" | "unknown";
	window: { from: string; to: string };
	probe_version: number;
	previous_decision_at: string | null;
	sources: {
		lead_events: SourceResult;
		mailbox: SourceResult;
		linear: SourceResult;
	};
	cursors: { mailbox: MailboxCursor | null };
}

export function isSummaryActivityNoiseEventType(eventType: string): boolean {
	return SUMMARY_ACTIVITY_NOISE_EVENT_TYPE_SET.has(eventType);
}

function validSourceCount(source: SourceResult): boolean {
	return (
		(source.status === "ok" || source.status === "not_bound") &&
		Number.isSafeInteger(source.count) &&
		source.count >= 0
	);
}

export function classifyActivitySources(
	sources: ActivityProbeResult["sources"],
): ActivityProbeResult["verdict"] {
	for (const source of Object.values(sources)) {
		if (
			source.status === "ok" &&
			validSourceCount(source) &&
			source.count > 0
		) {
			return "active";
		}
	}
	if (
		sources.lead_events.status === "ok" &&
		validSourceCount(sources.lead_events) &&
		sources.lead_events.count === 0 &&
		sources.mailbox.status === "ok" &&
		validSourceCount(sources.mailbox) &&
		sources.mailbox.count === 0 &&
		sources.linear.status === "not_bound"
	) {
		return "quiet";
	}
	return "unknown";
}

export function safeActivityReason(value: unknown): string {
	const raw = value instanceof Error ? value.message : String(value);
	const cleaned = [...raw]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 ? " " : character;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return (cleaned || "collector_failed").slice(0, 200);
}

function parseSqliteTimestamp(value: unknown): number | null {
	if (typeof value !== "string" || value.length === 0) return null;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?$/u.test(
		value,
	)
		? `${value.replace(" ", "T")}Z`
		: value;
	const parsed = Date.parse(normalized);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isMailboxCursor(value: unknown): value is MailboxCursor {
	if (!value || typeof value !== "object") return false;
	const cursor = value as Partial<MailboxCursor>;
	return (
		Number.isSafeInteger(cursor.allocated_seq) &&
		(cursor.allocated_seq ?? -1) >= 0 &&
		Boolean(cursor.instance) &&
		typeof cursor.instance?.schema_generation === "string" &&
		cursor.instance.schema_generation.length > 0 &&
		typeof cursor.instance.completed_at === "string" &&
		cursor.instance.completed_at.length > 0
	);
}

function activityFromDecisionPayload(
	eventType: string,
	payload: string,
): { present: boolean; value?: unknown } {
	const parsed = JSON.parse(payload) as Record<string, unknown>;
	const container =
		eventType === "summary_due_skipped"
			? parsed.summary_due_skipped
			: parsed.summary_due;
	if (!container || typeof container !== "object") return { present: false };
	if (!("activity" in container)) return { present: false };
	return {
		present: true,
		value: (container as Record<string, unknown>).activity,
	};
}

function windowFromActivity(value: unknown): ActivityWindow | null {
	if (!value || typeof value !== "object") return null;
	const window = (value as { window?: unknown }).window;
	if (!window || typeof window !== "object") return null;
	const fromMs = Date.parse(String((window as { from?: unknown }).from ?? ""));
	const toMs = Date.parse(String((window as { to?: unknown }).to ?? ""));
	return Number.isSafeInteger(fromMs) &&
		Number.isSafeInteger(toMs) &&
		fromMs >= 0 &&
		toMs > fromMs
		? { fromMs, toMs }
		: null;
}

/** Parse the newest decision and mailbox cursor without crossing a flag-off row. */
export function parsePreviousDecisionRows(
	rows: ReadonlyArray<{
		seq: number;
		event_type: string;
		payload: string;
		created_at: string;
	}>,
): PreviousDecisionEvidence {
	if (rows.length === 0) {
		return {
			decisionAtMs: null,
			decisionSeq: null,
			window: null,
			mailboxCursor: null,
			error: null,
		};
	}
	const latest = rows[0]!;
	const decisionAtMs = parseSqliteTimestamp(latest.created_at);
	if (
		!Number.isSafeInteger(latest.seq) ||
		latest.seq < 0 ||
		decisionAtMs === null
	) {
		return {
			decisionAtMs: null,
			decisionSeq: null,
			window: null,
			mailboxCursor: null,
			error: "corrupt_cursor",
		};
	}
	try {
		const latestActivity = activityFromDecisionPayload(
			latest.event_type,
			latest.payload,
		);
		const window = latestActivity.present
			? windowFromActivity(latestActivity.value)
			: null;
		if (latestActivity.present && !window) {
			throw new Error("corrupt_cursor");
		}

		let mailboxCursor: MailboxCursor | null = null;
		for (const row of rows) {
			const activity = activityFromDecisionPayload(row.event_type, row.payload);
			if (!activity.present) break;
			if (!activity.value || typeof activity.value !== "object") {
				throw new Error("corrupt_cursor");
			}
			const cursors = (activity.value as { cursors?: unknown }).cursors;
			if (!cursors || typeof cursors !== "object") {
				throw new Error("corrupt_cursor");
			}
			const candidate = (cursors as { mailbox?: unknown }).mailbox;
			if (candidate === null) continue;
			if (!isMailboxCursor(candidate)) throw new Error("corrupt_cursor");
			mailboxCursor = candidate;
			break;
		}
		return {
			decisionAtMs,
			decisionSeq: latest.seq,
			window,
			mailboxCursor,
			error: null,
		};
	} catch {
		return {
			decisionAtMs,
			decisionSeq: latest.seq,
			window: null,
			mailboxCursor: null,
			error: "corrupt_cursor",
		};
	}
}

/** Validate a mailbox read before it is allowed to participate in quiet. */
export function classifyMailboxSnapshot(input: {
	previousCursor: MailboxCursor | null;
	snapshot: MailboxActivitySnapshot;
	contiguous: boolean;
	continuityFailure?: "corrupt_cursor" | "retention_window_exceeded" | null;
}): { source: SourceResult; cursor: MailboxCursor | null } {
	const cursor: MailboxCursor = {
		allocated_seq: input.snapshot.allocatedSeq,
		instance: input.snapshot.instance,
	};
	if (
		!Number.isSafeInteger(input.snapshot.count) ||
		input.snapshot.count < 0 ||
		!isMailboxCursor(cursor)
	) {
		return {
			source: { status: "unavailable", reason: "corrupt_cursor" },
			cursor: input.previousCursor,
		};
	}
	if (input.continuityFailure === "corrupt_cursor") {
		return {
			source: { status: "unavailable", reason: "corrupt_cursor" },
			cursor,
		};
	}
	if (!input.previousCursor) {
		return {
			source: { status: "unavailable", reason: "no_previous_cursor" },
			cursor,
		};
	}
	if (!isMailboxCursor(input.previousCursor)) {
		return {
			source: { status: "unavailable", reason: "corrupt_cursor" },
			cursor,
		};
	}
	if (
		input.previousCursor.instance.schema_generation !==
			cursor.instance.schema_generation ||
		input.previousCursor.instance.completed_at !== cursor.instance.completed_at
	) {
		return {
			source: { status: "unavailable", reason: "instance_changed" },
			cursor,
		};
	}
	if (cursor.allocated_seq < input.previousCursor.allocated_seq) {
		return {
			source: { status: "unavailable", reason: "sequence_regression" },
			cursor,
		};
	}
	if (input.continuityFailure) {
		return {
			source: { status: "unavailable", reason: input.continuityFailure },
			cursor,
		};
	}
	if (!input.contiguous) {
		return {
			source: { status: "unavailable", reason: "window_discontinuous" },
			cursor,
		};
	}
	return { source: { status: "ok", count: input.snapshot.count }, cursor };
}

export async function captureActivitySource(
	read: () => Promise<SourceResult>,
): Promise<SourceResult> {
	try {
		return await read();
	} catch (error) {
		return { status: "unavailable", reason: safeActivityReason(error) };
	}
}

export function activityRetentionFailure(input: {
	nowMs: number;
	fromMs: number;
	previousDecisionAtMs: number;
	retentionMs: number;
	reserveMs?: number;
}): "corrupt_cursor" | "retention_window_exceeded" | null {
	const reserveMs = input.reserveMs ?? SUMMARY_ACTIVITY_RETENTION_RESERVE_MS;
	if (
		![
			input.nowMs,
			input.fromMs,
			input.previousDecisionAtMs,
			input.retentionMs,
			reserveMs,
		].every(Number.isSafeInteger) ||
		input.nowMs < 0 ||
		input.fromMs < 0 ||
		input.previousDecisionAtMs < 0 ||
		input.retentionMs <= reserveMs ||
		reserveMs < 0
	) {
		return "corrupt_cursor";
	}
	const usableRetentionMs = input.retentionMs - reserveMs;
	if (
		input.nowMs - input.fromMs > usableRetentionMs ||
		input.nowMs - input.previousDecisionAtMs > usableRetentionMs
	) {
		return "retention_window_exceeded";
	}
	return null;
}
