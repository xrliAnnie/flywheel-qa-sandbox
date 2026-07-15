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
	/** FLY-1234: session_stuck confirm-layer annotation — the bounded reason
	 * code (CONFIRM_NOTES prose) recording WHY the confirm layer let this wake
	 * through (dead_pin / judge c_stuck / budget exhausted / fail-open …).
	 * Never pane text, never model rationale. Absent on the legacy path. */
	confirm_note?: string;
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
	/** FLY-1048 (A3): error-signature KIND (error-signatures.ts) behind a
	 * repeated-signature stuck candidate. Kind only — never the matched line. */
	error_signature?: string;
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

	// FLY-1048 (A5): detection_suspicious fields — the fail-suspicious
	// contract. The mechanical watchdog layer could not conclude a/b/c; the
	// owner Lead gets a QUIET report instead of silence.
	/** "runner" | "lead" — what kind of target the report is about. */
	detection_target_kind?: string;
	/** execId (runner) or `<project>:<leadId>` state key (lead). */
	detection_target_key?: string;
	/** Why the mechanical layer could not conclude (enum-ish + one sentence). */
	suspicious_reason?: string;
	/** ▏-quoted bounded pane tail. Lead-face ONLY — renderers must keep the
	 * quote prefix (echo immunity) and it must NEVER reach the founder. */
	suspicious_pane_tail?: string;

	// FLY-1048 (C2): detection_escalation fields — the Lead-first leg of the
	// unified escalation flow (PRD §4.3/§4.5). One-sentence natural language;
	// raw pane text never travels this event type.
	/** Detection kind (e.g. detection_stuck_confirmed / delivery_unconsumed). */
	escalation_kind?: string;
	/** Kind-specific one-sentence summary (no pane content). */
	escalation_reason?: string;
	/** Truthful next step for the Lead (formatParkAlert wording family). */
	escalation_next_step?: string;

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

	// FLY-1018: ship_approval_request fields (gemini-agent's request-shaped
	// ship surface — plan §2.8). Typed, optional: event_type is the
	// discriminator, existing call sites keep compiling.
	/** The GitHub PR URL the requester wants approved. */
	pr_url?: string;
	/** Requesting agent identity (server-set, e.g. "gemini-agent"). */
	requester?: string;
	/** Optional short note on who asked and in what context. */
	requester_context?: string;
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
	// FLY-1048 (A3): the error-signature KIND behind a repeated-signature
	// candidate (enoent_loop / not_logged_in / …) — kind only, never the raw
	// matched line (echo immunity, FLY-220).
	if (e.error_signature) {
		lines.push(`Error-Signature: ${e.error_signature}`);
	}
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

// ── FLY-1234: shared session_stuck renderer ──

/**
 * FLY-1234 (R1 #5, annotation leg 3/3): session_stuck previously rendered
 * through each runtime's GENERIC formatter, which drops any field it does not
 * know — the new `confirm_note` would be persisted yet invisible to the Lead.
 * SHARED between MailboxLeadRuntime and CommDBLeadRuntime (parity-by-
 * construction, FLY-195 lesson: payload/render drift IS the bug class).
 *
 * Byte-compat contract: for a payload WITHOUT `confirm_note` this renders
 * exactly what both generic formatters render today (same fields, same
 * order) — the kill-switch sentinel depends on it.
 */
export function formatSessionStuck(env: StuckEscalationEnvelopeLike): string {
	const e = env.event;
	const roleLabel =
		e.session_role && e.session_role !== "main"
			? `[${e.session_role.toUpperCase()}] `
			: "";
	const lines = [
		`[Event #${env.seq}] ${roleLabel}${e.event_type}`,
		`ID: ${e.execution_id || "—"} | Issue: ${e.issue_identifier || e.issue_id || "—"}`,
	];
	if (e.issue_title) lines.push(`Title: ${e.issue_title}`);
	if (e.status) lines.push(`Status: ${e.status}`);
	if (e.decision_route) lines.push(`Route: ${e.decision_route}`);
	if (e.summary) lines.push(`Summary: ${e.summary.slice(0, 300)}`);
	if (e.last_error) lines.push(`Error: ${e.last_error.slice(0, 200)}`);
	if (e.action) {
		lines.push(
			`Action: ${e.action} (${e.action_source_status} → ${e.action_target_status})`,
		);
	}
	if (e.commit_count) {
		lines.push(
			`Commits: ${e.commit_count} | +${e.lines_added ?? 0}/-${e.lines_removed ?? 0}`,
		);
	}
	if (e.filter_priority) lines.push(`Priority: ${e.filter_priority}`);
	if (e.notification_context) lines.push(`Context: ${e.notification_context}`);
	if (e.confirm_note) lines.push(`Confirm-Note: ${e.confirm_note}`);
	if (e.pr_number) lines.push(`PR: #${e.pr_number}`);
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

// ── FLY-208 6a: shared gate_question renderer ──

/**
 * FLY-208 6a (Codex design R2 #5): MailboxLeadRuntime and CommDBLeadRuntime
 * carried near-duplicate gate_question formatters — exactly the drift class
 * that bit FLY-195. Extracted BEFORE changing the approve command text so the
 * required-JSON-shape guidance cannot diverge between runtimes.
 *
 * The approve_to_ship reply guidance is the production-incident fix: the
 * founder-consent wiring only honors `{"approved": true}` (JSON), and a
 * plain-text "APPROVE — ..." reply was silently recorded as feedback,
 * forcing a ratify retry loop (FLY-208 finding 6). The template now states
 * the required shape instead of the misleading generic "your reply".
 */
export function formatGateQuestion(env: StuckEscalationEnvelopeLike): string {
	const e = env.event;
	const tag = e.checkpoint?.toUpperCase() ?? "GATE";
	const issueRef = e.issue_identifier || e.issue_id;
	const roleLabel =
		e.session_role && e.session_role !== "main"
			? `[${e.session_role.toUpperCase()}] `
			: "";
	// FLY-175 Track 2: approve_to_ship MUST route through the Bridge
	// founder-consent wrapper (--bridge-url). Other checkpoints keep the
	// legacy direct command. The --db hint is always present.
	const isApprove = e.checkpoint === "approve_to_ship";
	const replyCmd = isApprove
		? `Reply via: flywheel-comm respond --db ${e.comm_db_path} --bridge-url $BRIDGE_URL --lead <your_id> ${e.question_id} '{"approved": true}'`
		: `Reply via: flywheel-comm respond --db ${e.comm_db_path} --lead <your_id> ${e.question_id} "your reply"`;
	const lines = [
		`[Event #${env.seq}] ${roleLabel}gate_question`,
		`ID: ${e.execution_id || "---"} | Issue: ${issueRef || "---"}`,
		`[${tag}] Runner asks:`,
		"---",
		e.summary ?? "(no content)",
		"---",
		replyCmd,
	];
	if (isApprove) {
		lines.push(
			`APPROVAL SHAPE: to approve you MUST answer with the exact JSON '{"approved": true}' — ` +
				`any plain text (even starting with "APPROVE") is recorded as FEEDBACK, not approval. ` +
				`To reject / request changes, answer with plain-text feedback.`,
		);
	}
	lines.push(`Question ID: ${e.question_id}`, `CommDB: ${e.comm_db_path}`);
	if (e.chat_thread_id) lines.push(`Chat-Thread: ${e.chat_thread_id}`);
	return lines.join("\n");
}

// ── FLY-1048 (A5): shared detection_suspicious renderer ──

/**
 * FLY-1048 (A5): the fail-suspicious report the owner Lead reads. SHARED
 * between MailboxLeadRuntime and CommDBLeadRuntime (parity-by-construction,
 * FLY-195/FLY-208 lesson) — without an explicit branch the generic formatter
 * drops `suspicious_pane_tail` entirely (Codex design R1 #2).
 *
 * Contract:
 *  - QUIET framing: this is an FYI, not an alert; the Lead judges.
 *  - The pane tail arrives ▏-quoted and MUST stay quoted (echo immunity) —
 *    the Lead is told to never repost the quoted lines (founder privacy).
 */
/**
 * FLY-1048 (C2): the Lead-first escalation notice the owner Lead reads.
 * SHARED between MailboxLeadRuntime and CommDBLeadRuntime (parity-by-
 * construction, FLY-195/FLY-208 lesson) — the generic formatter would drop
 * escalation_kind / escalation_reason / escalation_next_step entirely.
 *
 * Contract: natural language (PRD §4.2 — no fixed card), names the ~30min
 * grace so the Lead knows the founder gets paged if they do not act, and
 * never carries pane content (the A5 suspicious leg owns quoted tails).
 */
export function formatDetectionEscalation(
	env: StuckEscalationEnvelopeLike,
): string {
	const e = env.event;
	const label = e.issue_identifier ?? e.issue_id ?? "—";
	return [
		`[Event #${env.seq}] detection_escalation`,
		`Issue: ${label} | Target: ${e.detection_target_key ?? "—"} | Project: ${e.project_name ?? "—"}`,
		`[ESCALATION] Watchdog detected: ${e.escalation_kind ?? "?"} — you are the first responder (PRD §4.5):`,
		"---",
		e.escalation_reason ?? "(no reason captured)",
		"---",
		`Next step: ${e.escalation_next_step ?? "排查该 target 的真实状态(第一响应人)"}`,
		"If unresolved for ~30min the founder is paged automatically — act or hand off, never leave it silent.",
		`Fingerprint: ${e.episode_fingerprint ?? "—"}`,
		`Timestamp: ${env.timestamp} | Session Key: ${env.sessionKey}`,
	].join("\n");
}

export function formatDetectionSuspicious(
	env: StuckEscalationEnvelopeLike,
): string {
	const e = env.event;
	const lines = [
		`[Event #${env.seq}] detection_suspicious`,
		`Target: ${e.detection_target_kind ?? "?"} ${e.detection_target_key ?? "—"} | Project: ${e.project_name ?? "—"}`,
		"[SUSPICIOUS] Watchdog quiet FYI — mechanical detection could not conclude working/parked/stuck:",
		"---",
		e.suspicious_reason ?? "(no reason captured)",
		"---",
	];
	if (e.suspicious_pane_tail) {
		lines.push(
			"Pane tail (▏-quoted; never share the quoted pane lines outside this inbox — not in threads, never to the founder):",
			e.suspicious_pane_tail.slice(0, 2_000),
			"---",
		);
	}
	lines.push(
		"Judge it: glance at the tmux pane when convenient. No response required if healthy; if genuinely stuck, re-manage as usual.",
		`Fingerprint: ${e.episode_fingerprint ?? "—"}`,
		`Timestamp: ${env.timestamp} | Session Key: ${env.sessionKey}`,
	);
	return lines.join("\n");
}

// ── FLY-1018: shared ship_approval_request renderer ──

/**
 * FLY-1018 (plan §2.8, Codex R2-1 + R3-3): gemini-agent's request-shaped
 * ship surface. The generic formatter would drop pr_url / requester /
 * requester_context, and the Lead could not present the request to the
 * founder — so both concrete runtimes render this first-class.
 *
 * SHARED between MailboxLeadRuntime and CommDBLeadRuntime on purpose —
 * same parity-by-construction rationale as formatStuckEscalation (FLY-195
 * lesson: payload/render drift IS the bug class).
 *
 * Contract: PR URL, requester and the "nothing merged" note MUST all be
 * visible verbatim. This event creates NO approve_to_ship gate and carries
 * NO ship authority — the real ship still goes through the owning runner's
 * verified approve_to_ship + verify-approval chain, unchanged.
 */
export function formatShipApprovalRequest(
	env: StuckEscalationEnvelopeLike,
): string {
	const e = env.event;
	const context = e.requester_context ? `(${e.requester_context})` : "";
	const lines = [
		`[Event #${env.seq}] ship_approval_request`,
		`Project: ${e.project_name ?? "—"}`,
		`[ship-approval-request] requester=${e.requester ?? "unknown"} PR ${e.pr_url ?? "(missing pr_url)"} — ${e.summary ?? "(no summary)"}${context}. Nothing merged; founder approval + owning runner verified ship flow still required.`,
		"Surface this to the founder for a decision. Do NOT merge, approve, or open any gate on the requester's behalf — this event carries no ship authority.",
	];
	lines.push(`Timestamp: ${env.timestamp} | Session Key: ${env.sessionKey}`);
	return lines.join("\n");
}
