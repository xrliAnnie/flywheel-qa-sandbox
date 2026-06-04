export interface HookPayload {
	event_type: string;
	execution_id: string;
	issue_id: string;
	issue_identifier?: string;
	issue_title?: string;
	project_name?: string;
	status?: string;
	decision_route?: string;
	commit_count?: number;
	lines_added?: number;
	lines_removed?: number;
	summary?: string;
	last_error?: string;
	chat_channel?: string;
	issue_labels?: string[];
	// stuck-specific
	minutes_since_activity?: number;
	// FLY-195: runner_stuck_escalation evidence fields (plan §3.1/§3.2).
	// Evidence ONLY — the Lead judges; none of these are act-triggers.
	/** Whole minutes the runner's terminal output has been unchanged. */
	stuck_minutes?: number;
	/** Stable fingerprint of this stuck episode — echo it back when writing a disposition or nudging. */
	episode_fingerprint?: string;
	/** Trailing non-empty terminal lines (helps the Lead judge fast). */
	terminal_tail?: string;
	/** Canonical `API Error: ... Stream idle timeout` signature seen in the tail. */
	stream_error_signature?: boolean;
	/** Claude interactive input box visible at the bottom (idle-at-prompt). */
	input_box_present?: boolean;
	// action-specific fields (GEO-167)
	action?: string;
	action_source_status?: string;
	action_target_status?: string;
	action_reason?: string;
	// FLY-208 A2: runner_misrouted_report fields (black-hole inbox patrol).
	// A Runner used stock SendMessage to:"team-lead" — a recipient that does
	// not exist in Flywheel's lead-named teams; the message landed in an
	// auto-created inbox file nobody polls. The patrol surfaces it as an
	// advisory so "claimed delivered but nobody received" can never be silent.
	/** Sender of the misrouted mailbox message (e.g. "runner-433d4078"). */
	misroute_from?: string;
	/** Original mailbox timestamp (ISO) of the misrouted message. */
	misrouted_at?: string;
	/** Fixed guidance for the Lead (wrong channel; reply via flywheel-comm send). */
	misroute_hint?: string;
	/** Aggregate path only: JSONL archive of the full backlog batch. */
	misroute_archive_path?: string;
	/** Aggregate path only: number of misrouted messages in the batch. */
	misroute_count?: number;
	// FLY-62: gate_question event fields
	// FLY-161: runner_question reuses question_id / from_agent / comm_db_path /
	// summary — same schema as gate_question, but `checkpoint` is undefined for
	// runner_question (non-blocking Runner ask via `flywheel-comm ask`). The
	// distinguishing fields are `event_type` ("gate_question" vs "runner_question")
	// and the presence/absence of `checkpoint`.
	checkpoint?: string;
	question_id?: string;
	from_agent?: string;
	comm_db_path?: string;
	// FLY-159: gate_timed_out event fields (Lead notifies Annie via Discord)
	waited_ms?: number;
	original_message?: string;
	timeout_behavior?: string;
	/** "default" (no --timeout-behavior flag) | "flag" (flag was present) */
	timeout_behavior_source?: string;
	// GEO-292: PR tracking
	pr_number?: number;
	// FLY-59: Session role for multi-session-per-issue support
	session_role?: string;
	// FLY-47: stage context — explicit guidance for Lead (e.g., "Runner completed work, PR still needs review")
	stage_context?: string;
	// EventFilter fields (GEO-187)
	filter_priority?: "high" | "normal" | "low";
	notification_context?: string;
	// FLY-91: Chat thread for per-issue conversation in chatChannel
	chat_thread_id?: string;

	// GEO-151: ProofShot artifact delivery fields. Only populated when
	// `event_type === "artifact_delivery"`. HookPayload remains a single
	// interface (not a discriminated union) — event_type is the discriminator
	// and these fields are optional so existing call sites keep compiling.
	/** Absolute paths to artifact files for Lead → Discord MCP delivery. */
	paths?: string[];
	/** "ui" or "3d" — drives formatting hint in proofshot-deliver.md. */
	kind?: "ui" | "3d";
	/** `${execId}|${stage}|${captureKind}` — correlation key (wire snake_case). */
	dedup_key?: string;
	/** 1-based retry attempt — handler checks `runs[dedup_key].attempt === attempt`. */
	attempt?: number;
	/** Discord plugin per-file size cap (default 25 MB). */
	size_cap_bytes?: number;
	/** Discord plugin per-message file count cap (default 10). */
	file_count_cap?: number;
	/** Markdown line appended to Discord message when any file exceeds cap. */
	oversize_fallback_text?: string;
}

export function buildSessionKey(session: {
	issue_identifier?: string;
	issue_id: string;
}): string {
	return `flywheel:${session.issue_identifier ?? session.issue_id}`;
}

/**
 * FLY-159: Format a millisecond duration as a short human-readable string.
 * Used by gate_timed_out formatters so Annie can read "waited 48h" / "waited
 * 10s" instead of a raw ms count.
 *
 * Examples:
 *   formatDurationMs(10_000)        → "10s"
 *   formatDurationMs(90_000)        → "1m 30s"
 *   formatDurationMs(3_600_000)     → "1h"
 *   formatDurationMs(172_800_000)   → "48h"
 *   formatDurationMs(5_400_000)     → "1h 30m"
 *   formatDurationMs(undefined as never) → "—"
 */
export function formatDurationMs(ms: number | undefined | null): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) {
		const sec = totalSec % 60;
		return sec === 0 ? `${totalMin}m` : `${totalMin}m ${sec}s`;
	}
	const hours = Math.floor(totalMin / 60);
	const min = totalMin % 60;
	return min === 0 ? `${hours}h` : `${hours}h ${min}m`;
}

// ── FLY-195 hotfix: shared runner_stuck_escalation renderer ──

/**
 * Structural envelope shape (avoids importing LeadEventEnvelope — lead-runtime
 * already imports this module; an import here would create a cycle).
 */
export interface StuckEscalationEnvelopeLike {
	seq: number;
	event: HookPayload;
	sessionKey: string;
	timestamp: string;
}

const STUCK_TAIL_MAX_LINES = 8;
const STUCK_TAIL_MAX_CHARS = 600;

/**
 * FLY-195 hotfix (production incident 2026-06-03, GEO-397 double-page):
 * the escalation EVENT carried `episode_fingerprint` / `stuck_minutes` /
 * `terminal_tail`, but neither Lead runtime RENDERED them — the Lead was told
 * to "echo this episode_fingerprint" while "this" was never printed. The
 * Lead's (correct!) disposition POST then failed validation, the grace window
 * expired, and EVERY escalation auto-paged Annie — defeating the Q6/Q7 design.
 *
 * SHARED between MailboxLeadRuntime and CommDBLeadRuntime on purpose: the two
 * generic formatters are intentional near-duplicates, and this bug class IS
 * the drift between event payload and rendered text. One renderer, one truth.
 *
 * The fingerprint line is machine-extractable: `Episode-Fingerprint: <16hex>`.
 */
export function formatStuckEscalation(
	env: StuckEscalationEnvelopeLike,
): string {
	const e = env.event;
	const roleLabel =
		e.session_role && e.session_role !== "main"
			? `[${e.session_role.toUpperCase()}] `
			: "";
	const issueRef = e.issue_identifier || e.issue_id || "—";
	const lines = [
		`[Event #${env.seq}] ${roleLabel}runner_stuck_escalation`,
		`ID: ${e.execution_id || "—"} | Issue: ${issueRef}`,
		`STUCK candidate: output unchanged for ${e.stuck_minutes ?? "?"} min while status=${e.status ?? "running"} — judge and re-manage (candidate, NOT a verdict).`,
		`Episode-Fingerprint: ${e.episode_fingerprint ?? "(missing)"}`,
		'(echo this fingerprint EXACTLY as "episode_fingerprint" in your stuck-disposition / recovery-nudge call)',
		`Evidence: input_box_present=${e.input_box_present ?? "?"} | stream_error_signature=${e.stream_error_signature ?? "?"}`,
	];
	if (e.terminal_tail) {
		const tailLines = e.terminal_tail.split("\n").slice(-STUCK_TAIL_MAX_LINES);
		let tail = tailLines.join("\n");
		if (tail.length > STUCK_TAIL_MAX_CHARS) {
			tail = tail.slice(-STUCK_TAIL_MAX_CHARS);
		}
		lines.push(
			"--- terminal tail (truncated; capture live before acting) ---",
			tail,
			"---",
		);
	}
	if (e.stage_context) lines.push(`Note: ${e.stage_context}`);
	if (e.chat_thread_id) lines.push(`Chat-Thread: ${e.chat_thread_id}`);
	lines.push(`Timestamp: ${env.timestamp} | Session Key: ${env.sessionKey}`);
	return lines.join("\n");
}

// ── FLY-208 A2: shared runner_misrouted_report renderer ──

/**
 * FLY-208 A2 (production incident 2026-06-04, sub LEARN-12 exec 433d4078):
 * Runners reported via stock `SendMessage to:"team-lead"` — a recipient that
 * does not exist in Flywheel's lead-named teams. The stock tool auto-creates
 * the inbox file and returns success, so the reports silently black-holed
 * (product-lead's file held 184 of them). The GatePoller patrol surfaces
 * each misrouted message (or an aggregated backlog) as this advisory.
 *
 * SHARED between MailboxLeadRuntime and CommDBLeadRuntime on purpose —
 * same parity-by-construction rationale as formatStuckEscalation above
 * (FLY-195 lesson: the drift between payload and rendered text IS the bug
 * class).
 */
export function formatMisroutedReport(
	env: StuckEscalationEnvelopeLike,
): string {
	const e = env.event;
	const lines = [
		`[Event #${env.seq}] runner_misrouted_report`,
		`Project: ${e.project_name ?? "—"} | Lead: ${e.chat_channel ?? ""}`.trimEnd(),
	];
	if (e.misroute_archive_path) {
		// Aggregate backlog advisory (count > threshold): originals archived,
		// not replayed one-by-one.
		lines.push(
			`MISROUTED BACKLOG: ${e.misroute_count ?? "?"} runner report(s) were sent to the black-hole "team-lead" inbox (stock SendMessage, wrong recipient name) and never reached you.`,
			`The full originals are archived (JSONL): ${e.misroute_archive_path}`,
			"They are historical — review the archive if needed; do NOT assume any of them was handled.",
		);
	} else {
		lines.push(
			`MISROUTED REPORT from ${e.misroute_from ?? e.from_agent ?? "?"} (sent ${e.misrouted_at ?? "?"}):`,
			'This Runner used stock SendMessage to "team-lead" — a black-hole inbox nobody polls. The message below never reached you through a real channel.',
			"---",
			e.summary ?? "(no content)",
			"---",
		);
	}
	lines.push(
		e.misroute_hint ??
			"Reply to the Runner via `flywheel-comm send` (NOT SendMessage). The Runner may be on a pre-FLY-208 prompt that doesn't know the report-back protocol.",
	);
	lines.push(`Timestamp: ${env.timestamp} | Session Key: ${env.sessionKey}`);
	return lines.join("\n");
}
