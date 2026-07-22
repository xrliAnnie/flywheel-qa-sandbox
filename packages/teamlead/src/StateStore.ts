import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3, { type Database as BetterDb } from "better-sqlite3";
import { askHygieneEnabled } from "flywheel-comm/db";
import {
	canonicalSubmissionDigest,
	crossFamilyReviewSatisfied,
	type DesignBackend,
	isDesignBackend,
	isSkillFrameworkMode,
	isSkillFrameworkVia,
	type SkillFrameworkMode,
	type SkillFrameworkVia,
} from "flywheel-config";
import type { ClaudeReviewFinding } from "./bridge/claude-review-runner.js";
import type { HookPayload } from "./bridge/hook-payload.js";
import {
	ackPolicyForLeadEvent,
	type LeadEventAckPolicy,
	routingSnapshotForLeadEvent,
} from "./bridge/lead-event-ack-policy.js";
import type { LeadNudgeRow } from "./bridge/lead-pending-escalation.js";
import { findingKey as deriveReviewFindingKey } from "./bridge/review-verdict-policy.js";
import {
	buildWorkflowSelectionDigestBody,
	type CategorySource,
	type EngTier,
	type RoutingOverride,
	type WorkKindCategory,
} from "./work-kind.js";
import {
	generateCapabilityToken,
	hashCapabilityToken,
	PASSING_PREDICATES,
	REVIEW_CLASS_PREDICATES,
	RUNNER_CAPABILITY_FAMILIES,
	SYSTEM_CLAIM_ALLOWLIST,
	WORKFLOW_CLAIM_SUBJECT_KINDS,
	WORKFLOW_DECISION_FAMILIES,
	type WorkflowClaimPredicate,
	type WorkflowDecisionFamily,
} from "./workflow-claims.js";
import {
	buildWorkflowRunSnapshotV1,
	buildWorkflowRunSnapshotV2,
	parseWorkflowRunSnapshot,
} from "./workflow-run-snapshot.js";
import {
	type ShipReadyMarkerPayload,
	type WorkflowShipReadyNotice,
	workflowShipReadyUid,
} from "./workflow-ship-ready.js";
import {
	applyWorkflowOverride,
	isGeneralizedTemplatesEnabled,
	isWorkflowManifestV1Land,
	type LoadedWorkflowSeed,
	validateWorkflowManifest,
	type WorkflowTemplateOverride,
	workflowApprovalGate,
	workflowSeedContentHash,
} from "./workflow-template.js";
import {
	isLandNodeEnabled,
	workflowTemplateDispatchBlockMessage,
	workflowTemplateDispatchBlockReason,
} from "./workflow-template-dispatch.js";

/**
 * FLY-663: a thin compatibility shim that exposes the exact sql.js surface
 * StateStore used (`run` / `prepare`+`bind`/`step`/`getAsObject`/`free` /
 * `exec` / `getRowsModified` / `close`) on top of a native `better-sqlite3`
 * connection. Centralizing the 1:1 mapping here keeps the ~67 query call sites
 * byte-identical (minimal diff, single well-tested seam) while removing the
 * sql.js WASM engine entirely.
 *
 * Why the migration (FLY-663 root-fix, not FLY-639's band-aid): the old
 * `StateStore.save()` called `sql.js` `db.export()` on EVERY write — that closes
 * + reopens the SQLite connection and re-serializes the WHOLE DB into a fresh
 * contiguous buffer in the 2GB-capped, fragmentation-prone WASM linear heap
 * (independent of system RAM). Under a dozen runners' high-frequency writes the
 * WASM heap fragments/exhausts → the SQLite WASM instance corrupts → the
 * production `null function or function signature mismatch` → `no such table`
 * signatures. better-sqlite3 is native SQLite: no WASM heap to exhaust/corrupt,
 * incremental WAL writes (no full-DB export per write), so corruption is
 * structurally impossible. The on-disk file is unchanged (sql.js exported a
 * standard SQLite3 file), so the migration needs zero data conversion.
 */
interface CompatExecResult {
	columns: string[];
	values: unknown[][];
}

/** sql.js-shaped Statement over a better-sqlite3 prepared statement. */
class CompatStatement {
	private bound: unknown[] = [];
	private rows: Record<string, unknown>[] | null = null;
	private cursor = 0;
	constructor(private readonly stmt: BetterSqlite3.Statement) {}
	/** sql.js `bind` — store params; defer execution until first `step()`. */
	bind(params: unknown[] = []): boolean {
		this.bound = params;
		this.rows = null;
		this.cursor = 0;
		return true;
	}
	/** sql.js `step` — lazily run the query on first call, then advance one row. */
	step(): boolean {
		if (this.rows === null) {
			this.rows = this.stmt.all(...this.bound) as Record<string, unknown>[];
			this.cursor = 0;
		}
		if (this.cursor < this.rows.length) {
			this.cursor++;
			return true;
		}
		return false;
	}
	/** sql.js `getAsObject` — the current row as a column-name-keyed object. */
	getAsObject(): Record<string, unknown> {
		return this.rows?.[this.cursor - 1] ?? {};
	}
	/** sql.js `free` — release iteration state (no native handle to free). */
	free(): void {
		this.rows = null;
		this.cursor = 0;
	}
}

/**
 * FLY-663: sql.js-surface wrapper over a native better-sqlite3 connection.
 * Statements are prepared per-call (StateStore never cached them), matching the
 * old usage exactly.
 */
class CompatDb {
	private lastChanges = 0;
	constructor(public readonly raw: BetterDb) {}

	/** sql.js `run(sql, params?)`: param query → prepared run (track changes);
	 * no-param SQL → `exec` (supports multi-statement DDL scripts). */
	run(sql: string, params?: unknown[]): void {
		if (params !== undefined) {
			const info = this.raw.prepare(sql).run(...params);
			this.lastChanges = info.changes;
		} else {
			this.raw.exec(sql);
			this.lastChanges = 0;
		}
	}

	/** sql.js `prepare(sql)` → an iterable CompatStatement (reads). */
	prepare(sql: string): CompatStatement {
		return new CompatStatement(this.raw.prepare(sql));
	}

	/** sql.js `exec(sql, params?)`: result-bearing → `[{columns, values}]`
	 * (tuple shape the lead_events / stuck / delivery / PRAGMA readers expect);
	 * non-result → run and return `[]`. */
	exec(sql: string, params?: unknown[]): CompatExecResult[] {
		const stmt = this.raw.prepare(sql);
		if (stmt.reader) {
			const rows = stmt.all(...(params ?? [])) as Record<string, unknown>[];
			if (rows.length === 0) return [];
			const columns = Object.keys(rows[0] as Record<string, unknown>);
			const values = rows.map((r) => columns.map((c) => r[c]));
			return [{ columns, values }];
		}
		stmt.run(...(params ?? []));
		this.lastChanges = 0;
		return [];
	}

	/** sql.js `getRowsModified()` → rows changed by the last `run`. */
	getRowsModified(): number {
		return this.lastChanges;
	}

	/** Run a logical mutation atomically (FLY-663 §2.8: the old export() was the
	 * persistence boundary; better-sqlite3 autocommits each statement, so
	 * multi-statement methods must be wrapped to avoid durable partial state). */
	transaction(fn: () => void): void {
		this.raw.transaction(fn)();
	}

	close(): void {
		this.raw.close();
	}
}

/**
 * FLY-639: sql.js / WASM error signatures that mean the current DB instance can
 * no longer be trusted and must be rebuilt — NOT a recoverable logical error.
 * `null function or function signature mismatch` = WASM indirect-call-table
 * corruption (the original FLY-639 incident); the rest are the well-known SQLite
 * fatal modes. FLY-663: the engine is now native better-sqlite3 (no WASM), so
 * these are retained as DORMANT defense — they also match better-sqlite3
 * `SQLITE_CORRUPT` / `SQLITE_NOTADB` style messages. Matched case-insensitively
 * as substrings. Ordinary errors (e.g. UNIQUE constraint) deliberately do NOT
 * match, so they never trigger a reload.
 */
const SQLJS_CORRUPTION_SIGNATURES = [
	"null function or function signature mismatch",
	"no such table",
	"database disk image is malformed",
	"file is not a database",
	"out of memory",
	"memory access out of bounds",
] as const;

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]+$/;

function parseReviewFindings(json: string | undefined): ClaudeReviewFinding[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed)
			? parsed.filter(
					(finding): finding is ClaudeReviewFinding =>
						typeof finding === "object" && finding !== null,
				)
			: [];
	} catch {
		return [];
	}
}

/**
 * FLY-639: true when `err` looks like sql.js/WASM corruption that requires a DB
 * rebuild rather than continuing on a poisoned instance. Exported for tests.
 */
export function isSqlJsCorruptionError(err: unknown): boolean {
	const msg =
		err instanceof Error ? err.message : typeof err === "string" ? err : "";
	if (!msg) return false;
	const lower = msg.toLowerCase();
	return SQLJS_CORRUPTION_SIGNATURES.some((sig) => lower.includes(sig));
}

/** All statuses that represent a final outcome (used by dashboard, queries). */
export const OUTCOME_STATUSES = [
	"completed",
	"approved",
	"approved_to_ship",
	"blocked",
	"failed",
	"rejected",
	"deferred",
	"shelved",
	"terminated",
] as const;

// Terminal states — monotonic progression: once terminal, cannot go back to running
// Note: approved_to_ship is NOT terminal — Runner still needs to ship
const TERMINAL_STATUSES = new Set<string>([
	...OUTCOME_STATUSES,
	"awaiting_review",
]);
// approved_to_ship is an outcome but not terminal (Runner will transition to completed)
TERMINAL_STATUSES.delete("approved_to_ship");

/**
 * FLY-1099 §5 (Codex R2 #4): the StateStore statuses that are IRREVERSIBLY
 * terminal for zombie-gate hygiene — a pending gate whose session sits in one
 * of these (AND whose CommDB registration row is gone) can never be answered
 * through the normal flow again, so Z1 may auto-retire it.
 *
 * Deliberately NOT reused from TERMINAL_STATUSES (whose monotonicity set
 * includes `awaiting_review`) nor from CommDB's completed|timeout vocabulary —
 * the semantics differ. Enumerated value-by-value:
 *   - completed / failed / terminated — final FSM outcomes, never resume.
 *   - blocked / rejected / deferred / shelved — decision-layer terminal routes.
 * Excluded on purpose:
 *   - awaiting_review / running — live (FLY-1049 shape → Z2, never Z1).
 *   - approved_to_ship — runner still ships (its gate is answered anyway).
 *   - approved — legacy v1.0 auto-approve status; ambiguous → conservative skip.
 */
export const ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES = [
	"completed",
	"failed",
	"terminated",
	"blocked",
	"rejected",
	"deferred",
	"shelved",
] as const;

export function isStateStoreIrreversibleTerminalForZombie(
	status: string | undefined,
): boolean {
	return (
		status !== undefined &&
		(ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES as readonly string[]).includes(
			status,
		)
	);
}

export interface SessionEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	severity?: string;
	payload?: unknown;
	source: string;
	/** FLY-1048 PR-B: row timestamp (sqlite DATETIME) — populated on reads
	 * that need event ages (getEventsByExecution); optional/additive. */
	ts?: string;
}

// ── FLY-1099: founder-reply ingest reliability rows ─────────────────────────

/** FLY-1099 §3.1: a deferred founder ship-decision awaiting hold-clear rebind. */
export interface FounderDeferredApproval {
	question_id: string;
	msg_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	pr_head_sha: string;
	thread_id: string;
	decision: "approve" | "reject";
	/** FULL original founder text (Codex R3 #1 — a reject's feedback goes to the
	 * runner in full; audits/alerts truncate separately). */
	content: string;
	author_user_id: string;
	founder_id_at_capture: string;
	created_at: string;
	expires_at: string;
	consumed_at?: string;
	invalidated_at?: string;
	invalidated_reason?: string;
}

export type FounderActionKind =
	| "held_reply"
	| "ttl_expired_notice"
	| "head_drift_notice"
	| "rebound_notice"
	| "feedback_wake"
	| "codex_nudge_queue"
	| "codex_nudge_wake"
	| "emit_alert";

export type FounderActionStatus =
	| "pending"
	| "delivered"
	| "failed"
	| "cancelled"
	| "superseded";

/** FLY-1099 §3.1: one durable founder-facing action intent (ledger row). */
export interface FounderActionRow {
	action_key: string;
	kind: FounderActionKind;
	execution_id: string;
	issue_id: string;
	project_name: string;
	thread_id?: string;
	/** JSON-encoded parameters (text / alert payload / expected head, …). */
	payload: string;
	depends_on?: string;
	status: FounderActionStatus;
	attempts: number;
	last_error?: string;
	created_at: string;
	delivered_at?: string;
	failed_at_ms?: number;
}

/** Input shape for inserting a founder action intent. */
export interface FounderActionIntent {
	actionKey: string;
	kind: FounderActionKind;
	executionId: string;
	issueId: string;
	projectName: string;
	threadId?: string;
	payload: Record<string, unknown>;
	dependsOn?: string;
}

/** FLY-1238: durable bounded-failure state for the merged-PR last-mile guard. */
export interface MergedGateGuardFailureRow {
	question_id: string;
	source: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	attempts: number;
	first_seen_ms: number;
	next_retry_ms: number;
	last_error?: string;
	terminal: boolean;
	alerted: boolean;
	resolved_at?: string;
}

/** FLY-1238: durable visibility for an atomic CommDB gate/session finalizer
 * that keeps failing after the physical runner is gone. */
export interface CommDbFinalizeFailureRow {
	execution_id: string;
	issue_id: string;
	project_name: string;
	attempts: number;
	first_failure_ms: number;
	last_failure_ms: number;
	last_error?: string;
	alerted: boolean;
	resolved_at?: string;
}

/** FLY-1099 §3.1: bounded-retry row for one pinned founder message. */
export interface FounderReplyRetryRow {
	thread_id: string;
	msg_id: string;
	attempts: number;
	first_seen: string;
	first_seen_ms: number;
	last_stage?: string;
	last_error?: string;
	dead_lettered_at?: string;
	dead_lettered_ms?: number;
}

/**
 * FLY-727: a stored session_event row carrying `id` + `ts` (which the base
 * `SessionEvent` interface omits). Used by the daily completion digest for
 * per-event Pacific-day filtering + last-write-wins ordering by event timestamp.
 */
export interface CompletionEventRow {
	id: number;
	ts: string; // SQLite UTC string `YYYY-MM-DD HH:MM:SS`
	execution_id: string;
	issue_id: string;
	project_name: string;
	payload?: unknown;
}

/**
 * FLY-727: input to `insertDeploymentEvent`. Ingestion requires `projectName` +
 * `source`, at least one of issue/pr, and at least one identity field
 * (mergeSha / deployedSha / deployBatchId / sourceEventId) — validated at the
 * Bridge route boundary before this is called. `deployedAt` defaults to now.
 */
export interface DeploymentEventInput {
	projectName: string;
	issueIdentifier?: string;
	prNumber?: number;
	mergeSha?: string;
	deployedSha?: string;
	deployBatchId?: string;
	environment?: string;
	source: string;
	sourceEventId?: string;
	deployedAt?: string; // SQLite UTC string; Bridge defaults to now when omitted
	metadataJson?: string;
}

export interface DeploymentEventRow {
	id: number;
	project_name: string;
	issue_identifier: string | null;
	pr_number: number | null;
	merge_sha: string | null;
	deployed_sha: string | null;
	deploy_batch_id: string | null;
	environment: string;
	source: string;
	source_event_id: string | null;
	deployed_at: string;
	recorded_at: string;
	metadata_json: string | null;
}

/**
 * FLY-195 (plan §3.4): Lead disposition receipt for one stuck episode.
 *
 * `handled_remanaged` is written IMPLICITLY by the Bridge recovery-nudge
 * endpoint on a successful nudge; the other values are written EXPLICITLY by
 * the Lead via `POST /api/sessions/:executionId/stuck-disposition`.
 */
export const STUCK_DISPOSITIONS = [
	"handled_remanaged",
	"false_positive",
	"legitimate_wait",
	"snooze",
	"needs_founder",
] as const;
export type StuckDisposition = (typeof STUCK_DISPOSITIONS)[number];

/**
 * FLY-793 (Step 11): chat-thread role. 'main' is the byte-compatible default (one
 * thread per issue+channel via `chat_threads`); the three phase roles route to the
 * `phase_chat_threads` side-table so a three-stage issue gets one thread per phase.
 */
export type ChatThreadRole = "main" | "design" | "implement" | "qa";

const PHASE_CHAT_THREAD_ROLES: ReadonlySet<string> = new Set([
	"design",
	"implement",
	"qa",
]);

/**
 * FLY-793 (Step 11): fold any non-phase / absent role to 'main'. Every existing
 * caller passes no role → 'main' → the existing `chat_threads` 1:1 path unchanged.
 * Only an explicit three-stage phase role reaches the side-table.
 */
export function normalizeChatThreadRole(role?: string | null): ChatThreadRole {
	return role && PHASE_CHAT_THREAD_ROLES.has(role)
		? (role as ChatThreadRole)
		: "main";
}

/** Disposition values a Lead may write explicitly (handled_remanaged is implicit-only). */
export const EXPLICIT_STUCK_DISPOSITIONS: readonly StuckDisposition[] = [
	"false_positive",
	"legitimate_wait",
	"snooze",
	"needs_founder",
];

export interface StuckDispositionRow {
	execution_id: string;
	episode_fingerprint: string;
	disposition: StuckDisposition;
	/** Epoch ms until which a `snooze` disposition suppresses; null otherwise. */
	snooze_until_ms: number | null;
	noted_by: string | null;
	note: string | null;
	created_at: string;
}

/**
 * FLY-1048 PR-C (C1): unified detection-escalation episode statuses.
 * NEW → LEAD_NOTIFIED → (ACKED | ESCALATED) → RESOLVED, with CLEARING as a
 * mute-while-cleanup state that TTL-rebounds to NEW (C5).
 */
export const DETECTION_ESCALATION_STATUSES = [
	"NEW",
	"LEAD_NOTIFIED",
	"ACKED",
	"RESOLVED",
	"ESCALATED",
	"CLEARING",
] as const;
export type DetectionEscalationStatus =
	(typeof DETECTION_ESCALATION_STATUSES)[number];

export interface DetectionEscalationRow {
	target_key: string;
	kind: string;
	episode_fingerprint: string;
	issue_id: string | null;
	owner_lead_id: string | null;
	first_detected_at_ms: number;
	lead_notified_at_ms: number | null;
	lead_ack_at_ms: number | null;
	founder_paged_at_ms: number | null;
	/** Epoch ms when the episode entered CLEARING; null otherwise (C5 TTL input). */
	clearing_since_ms: number | null;
	status: DetectionEscalationStatus;
	attempts: number;
	/** How a RESOLVED row got there. Machine-proven clears (`recovery` and
	 * `residue_harvest`) may revive on later re-detection; `lead` (a human
	 * receipt) follows legacy identical-content semantics and never revives.
	 * NULL = pre-migration → treated as `lead` (conservative). */
	resolved_via: "recovery" | "residue_harvest" | "lead" | null;
}

/** FLY-1282 Part D: prepare-time receipt facts (the route builds the FINAL
 * sanitized content here — delivery never reconstructs semantics). */
export interface DispositionReceiptPrepareInput {
	actorLeadId: string;
	/** The raw disposition as the Lead expressed it (may be a stuck-route
	 * value like legitimate_wait, not just the unified ack|resolve|dismiss). */
	rawDisposition: string;
	/** Final, sanitized, ready-to-post text. */
	content: string;
	/** Audit anchors for the unroutable path. */
	executionId: string;
	projectName: string;
}

/** FLY-1282 Part D: one durable disposition-receipt outbox row. */
export interface DispositionReceiptRow {
	receipt_id: number;
	target_key: string;
	kind: string;
	episode_fingerprint: string;
	/** Generation anchor — copied from the escalation row inside the prepare
	 * transaction; revive resets the escalation's first_detected_at_ms, so a
	 * revived episode earns a NEW receipt row (4-col UNIQUE). */
	episode_first_detected_at_ms: number;
	actor_lead_id: string;
	disposition: string;
	/** Final, sanitized, ready-to-post text (built at prepare time). */
	content: string;
	issue_id: string | null;
	state: "pending" | "posted" | "unroutable" | "expired";
	attempts: number;
	last_attempt_at_ms: number | null;
	created_at_ms: number;
	posted_at_ms: number | null;
}

export interface SessionUpsert {
	execution_id: string;
	issue_id: string;
	project_name: string;
	status: string;
	issue_identifier?: string;
	issue_title?: string;
	started_at?: string;
	last_activity_at?: string;
	tmux_session?: string;
	worktree_path?: string;
	branch?: string;
	last_error?: string;
	decision_route?: string;
	decision_reasoning?: string;
	cost_usd?: number;
	commit_count?: number;
	files_changed?: number;
	lines_added?: number;
	lines_removed?: number;
	summary?: string;
	diff_summary?: string;
	commit_messages?: string;
	changed_file_paths?: string;
	session_params?: string;
	heartbeat_at?: string;
	adapter_type?: string;
	/** FLY-728: resolved runner model (per-issue model routing visibility). */
	runner_model?: string;
	/** FLY-728 Part C: the difficulty-sorter's dispatch model param (retry input). */
	dispatch_model?: string;
	/** FLY-1259: effective design backend, locked once at dispatch. */
	design_backend?: DesignBackend;
	/** FLY-615: resolved ponytail condition (A/B join key for FLY-614/616). */
	ponytail_condition?: string;
	/** FLY-1356: effective skill-framework arm (A/B/C split attribution). */
	skill_framework_mode?: SkillFrameworkMode;
	/** FLY-1356: how the arm was decided (hash/sticky/override/... join key). */
	skill_framework_mode_via?: SkillFrameworkVia;
	run_attempt?: number;
	retry_predecessor?: string;
	retry_successor?: string;
	issue_labels?: string;
	pr_number?: number;
	/** FLY-175: PR head SHA when known — cache-key salt for approve consent. */
	pr_head_sha?: string;
	session_stage?: string;
	stage_updated_at?: string;
	/** FLY-59: Session role for multi-session-per-issue */
	session_role?: string;
	/** FLY-137 Phase 5: agent dispatch (Lead override or label match) */
	agent_name?: string;
	/** FLY-137 Phase 5: how the agent was selected — "override" | "label" | "generic" */
	agent_match_method?: string;
	/** FLY-137 Phase 5: design_review plan path (set via `stage set design_review --plan ...`) */
	plan_path?: string;
	/** FLY-137 Phase 5: codex-skip label snapshotted at run start (0|1) */
	codex_skip?: number;

	/**
	 * FLY-191 Phase 2: when the session ENTERED awaiting_review (deadline
	 * anchor for the Bridge-side 48h review timeout). Set only on entry —
	 * NEVER drifted by later activity/approval attempts (Codex R1 MEDIUM-6);
	 * a re-review request (changes_requested → new needs_review) re-enters
	 * the state and resets it.
	 */
	awaiting_review_entered_at?: string;
	/** FLY-191 Phase 2: dedup stamp — when gate_timed_out was last notified for the CURRENT awaiting_review entry. */
	gate_timeout_notified_at?: string;
	/**
	 * FLY-191 Phase 2 (Codex PR R1 CRITICAL): the CommDB question id of the
	 * CURRENT review request. verify-approval honors a response ONLY on this
	 * exact question; Surface B rejects answers to any other approve_to_ship
	 * question. Set (with pr_head_sha) by `setReviewBinding` on every
	 * needs_review completion; a re-review overwrites it, instantly
	 * invalidating approvals on earlier questions — no timestamp-tie games.
	 */
	review_question_id?: string;
	/** FLY-205: Lead-judged doc tier ("full" | "plan_only" | "none"). Retry reuses. */
	doc_tier?: string;
	/** FLY-205: Linear issue URL persisted at start (doc header continuity on retry). */
	issue_url?: string;
	/** FLY-793 (Step 11): chat-thread role — 'main' (default, non-three-stage) or a
	 * phase role (design/implement/qa). Routes Session-based thread resolution to
	 * the main `chat_threads` table vs the `phase_chat_threads` side-table. */
	chat_thread_role?: string;
	/** FLY-1281: server-derived node id for an explicitly enrolled v2 workflow. */
	workflow_node_id?: string;
	/** FLY-598: founder-facing-ux flag (Lead label snapshot OR Runner self-declare), 0|1. */
	founder_facing_ux?: number;
	/** FLY-598: Bridge-written, founder-verified UX sign-off record (JSON; bound to uxHash). */
	founder_ux_signoff_json?: string;
	/** FLY-598: per-run snapshot of founder_ux_gate.mode (off|audit_only|enforce). */
	founder_ux_gate_mode?: string;
	/** FLY-869 A-1: immutable QA-required snapshot (1=required, 0=exempt, absent=never-evaluated). */
	qa_required?: number;
	/** FLY-869 A-1: why the QA-required verdict was reached (policy reason token). */
	qa_required_reason?: string;
	/** FLY-869 B-3: merged-but-unapproved park marker (reason token; NULL = not blocked). */
	merge_block_reason?: string;
	/** FLY-869 B-3: the PR head sha the merge_block marker is bound to. */
	merge_block_head?: string;
	/** FLY-869 B-3: ISO timestamp the merge_block marker was written. */
	merge_block_at?: string;
}

export interface Session {
	execution_id: string;
	issue_id: string;
	project_name: string;
	status: string;
	/** FLY-1257: first entry into an irreversible zombie-terminal status.
	 * SQLite canonical UTC text; cleared if the session is revived. */
	terminal_at?: string | null;
	issue_identifier?: string;
	issue_title?: string;
	started_at?: string;
	last_activity_at?: string;
	tmux_session?: string;
	worktree_path?: string;
	branch?: string;
	last_error?: string;
	decision_route?: string;
	decision_reasoning?: string;
	cost_usd?: number;
	commit_count?: number;
	files_changed?: number;
	lines_added?: number;
	lines_removed?: number;
	summary?: string;
	diff_summary?: string;
	commit_messages?: string;
	changed_file_paths?: string;
	session_params?: string;
	heartbeat_at?: string;
	adapter_type?: string;
	/** FLY-728: resolved runner model (per-issue model routing visibility). */
	runner_model?: string;
	/** FLY-728 Part C: the difficulty-sorter's dispatch model param (retry input). */
	dispatch_model?: string;
	/** FLY-1259: effective design backend, locked once at dispatch. */
	design_backend?: DesignBackend;
	/** FLY-615: resolved ponytail condition (A/B join key for FLY-614/616). */
	ponytail_condition?: string;
	/** FLY-1356: effective skill-framework arm (A/B/C split attribution). */
	skill_framework_mode?: SkillFrameworkMode;
	/** FLY-1356: how the arm was decided (hash/sticky/override/... join key). */
	skill_framework_mode_via?: SkillFrameworkVia;
	run_attempt?: number;
	retry_predecessor?: string;
	retry_successor?: string;
	issue_labels?: string;
	pr_number?: number;
	/** FLY-175: PR head SHA when known — cache-key salt for approve consent. */
	pr_head_sha?: string;
	session_stage?: string;
	stage_updated_at?: string;
	/** FLY-59: Session role for multi-session-per-issue */
	session_role?: string;
	/** FLY-137 Phase 5: agent dispatch (Lead override or label match) */
	agent_name?: string;
	/** FLY-137 Phase 5: how the agent was selected — "override" | "label" | "generic" */
	agent_match_method?: string;
	/** FLY-137 Phase 5: design_review plan path (set via `stage set design_review --plan ...`) */
	plan_path?: string;
	/** FLY-137 Phase 5: codex-skip label snapshotted at run start (boolean) */
	codex_skip?: boolean;
	/** FLY-191 Phase 2: when the session ENTERED awaiting_review (timeout deadline anchor). */
	awaiting_review_entered_at?: string;
	/** FLY-191 Phase 2: gate_timed_out dedup stamp for the current awaiting_review entry. */
	gate_timeout_notified_at?: string;
	/** FLY-191 Phase 2: CommDB question id of the CURRENT review request (verify-approval binding). */
	review_question_id?: string;
	/** FLY-205: Lead-judged doc tier ("full" | "plan_only" | "none"). Retry reuses. */
	doc_tier?: string;
	/** FLY-205: Linear issue URL persisted at start (doc header continuity on retry). */
	issue_url?: string;
	/** FLY-793 (Step 11): chat-thread role — 'main' (default) or a phase role
	 * (design/implement/qa). Set at start; routes thread resolution by table. */
	chat_thread_role?: string;
	/** FLY-1281: server-derived node id for an explicitly enrolled v2 workflow. */
	workflow_node_id?: string;
	/** FLY-598: founder-facing-ux flag (Lead label snapshot OR Runner self-declare). */
	founder_facing_ux?: boolean;
	/** FLY-598: Bridge-written, founder-verified UX sign-off record (JSON; bound to uxHash). */
	founder_ux_signoff_json?: string;
	/** FLY-598: per-run snapshot of founder_ux_gate.mode (off|audit_only|enforce). */
	founder_ux_gate_mode?: string;
	/** FLY-869 A-1: immutable QA-required snapshot (1=required, 0=exempt, undefined=never-evaluated). */
	qa_required?: number;
	/** FLY-869 A-1: why the QA-required verdict was reached (policy reason token). */
	qa_required_reason?: string;
	/** FLY-869 B-3: merged-but-unapproved park marker (reason token; undefined = not blocked). */
	merge_block_reason?: string;
	/** FLY-869 B-3: the PR head sha the merge_block marker is bound to. */
	merge_block_head?: string;
	/** FLY-869 B-3: ISO timestamp the merge_block marker was written. */
	merge_block_at?: string;
	/** FLY-245 D-a: monotonic revision incremented on every status transition.
	 * The runner-lifecycle founder credential snapshots this; a stale confirmation
	 * is rejected once it changes (plan §5.1). Defaults 0. */
	lifecycle_revision?: number;
}

// FLY-163: CleanupCandidate removed (CleanupService gone).

/** FLY-245 D2: one durable (gateway request id → successor execution id)
 * binding in the retry dispatch intent WAL (plan §5.2.1). */
export interface RetryDispatchIntent {
	request_id: string;
	successor_execution_id: string;
	predecessor_execution_id: string;
	/** 'intent' (WAL committed, dispatch not confirmed) | 'dispatched'.
	 * Informational — never proof of start. */
	state: "intent" | "dispatched";
	created_at: string;
	updated_at: string;
}

/**
 * FLY-579 P1: durable record for the auto-QA pipeline. One row per
 * (parent main execution, reviewed PR head sha). It is the source of truth
 * for "this awaiting_review main session is QA-held" — written BEFORE the QA
 * Runner is spawned (so no relayer can observe the parent as an ordinary
 * review gate first) and read by the shared `isQaHeld` predicate.
 *
 * status:
 *  - running    — QA spawned (or claimed, pre-spawn), verdict pending → HOLD founder
 *  - passed     — QA verdict PASS → release founder ship-ready notification
 *  - failed     — QA verdict FAIL → routed back to implementer (founder NOT notified)
 *  - superseded — a newer reviewed head opened a fresh record; this one is dead
 *  - stuck      — spawn failed or QA died without a verdict → Lead-only pipeline error
 *  - retry_pending / retry_starting — a dead QA is being clean-recovered once
 */
export interface AutoQaRecord {
	parent_execution_id: string;
	target_pr_head_sha: string;
	/** The PARENT (implementer) issue id — what is being verified. */
	issue_id: string;
	project_name: string;
	enrollment_source: "auto" | "manual";
	qa_execution_id?: string;
	/**
	 * FLY-643: the SEPARATE `QA·FLY-XX` Linear issue this record's QA runner runs
	 * on (its own issue + thread + runner), distinct from `issue_id` (the parent).
	 * Persisted at issue-creation time so a crash between create + spawn re-uses
	 * the same QA issue on reconcile instead of creating a duplicate. Absent on
	 * pre-FLY-643 / not-yet-created records.
	 */
	qa_issue_id?: string;
	qa_issue_identifier?: string;
	qa_issue_title?: string;
	qa_issue_url?: string;
	/**
	 * FLY-752: `awaiting_retest` is the NEW non-terminal hold state — a QA runner
	 * reported FAIL but is kept ALIVE (idle, `declare-state park`ed) to re-test the
	 * implementer's next head (fix-loop reuse; NEVER a fresh QA2/QA3). `failed` is
	 * retained ONLY for legacy rows written by the pre-FLY-752 pipeline; the new
	 * FAIL path writes `awaiting_retest`, but old `failed` rows must still be
	 * handled (same-head hold / new-head retarget) so an upgrade can't leak the
	 * founder gate.
	 */
	status:
		| "running"
		| "awaiting_retest"
		| "retry_pending"
		| "retry_starting"
		| "passed"
		| "failed"
		| "superseded"
		| "stuck";
	verdict_event_id?: string;
	started_at: string;
	completed_at?: string;
	notified_at?: string;
	/**
	 * FLY-752: durable crash-recovery marker. Set when a record is RETARGETED to a
	 * new head (fix round) and stays set until the QA runner's `retest_wake` is
	 * confirmed delivered. If the Bridge restarts in that window, reconcile sees
	 * this non-null and re-drives the wake (or re-spawns a dead QA) — so a missed
	 * retest wake never silently strands the founder gate.
	 */
	retest_wake_pending_at?: string;
	/** FLY-1279: bounded automatic recovery. At most one replacement QA launch. */
	auto_retry_count: number;
	/** Time the dead-QA CAS durably claimed the retry episode. */
	retry_intent_at?: string;
	/** Pre-bound successor execution id, persisted before dispatcher.start(). */
	retry_attempt_id?: string;
}

/** Bridge-owned classification of the exact PR diff for one candidate head. */
export interface ShipRelevantDiffSnapshot {
	execution_id: string;
	pr_head_sha: string;
	repo: string;
	pr_number: number;
	base_ref: string;
	base_oid: string;
	classifier_version: number;
	ship_relevant: 0 | 1;
	file_count: number;
	sample_paths?: string[];
	computed_at: string;
}

/**
 * FLY-827: the durable Codex code-review verdict record — the AUTHORITATIVE
 * source (NOT a PR comment) for "did Codex code review APPROVE this exact PR
 * head?". Keyed by (execution_id, target_pr_head_sha) exactly like auto_qa_record
 * so a new head automatically voids an older head's approval (requirement #6).
 *
 * status:
 *  - pending  — a code review is required for this head but not yet approved
 *               (audit-friendly; NOT the gate truth — the gate truth is
 *               "is there an approved/skipped row for the current head").
 *  - approved — Codex code review APPROVED this head (runner reported it via the
 *               `codex_review_result` event after `await-codex-gate code`).
 *  - skipped  — a sanctioned codex-skip label/flag bypassed review for this head.
 *
 * The gate (auto-QA spawn / founder hold / verify-approval merge) is satisfied
 * iff there is an approved OR skipped row for the session's current head (or the
 * session carries `codex_skip`, or the hard gate is off) — see
 * `isCodexGateSatisfied` (Bridge) / verify-approval (CLI mirror).
 */
export interface CodexReviewRecord {
	execution_id: string;
	target_pr_head_sha: string;
	issue_id: string;
	project_name: string;
	status: "pending" | "approved" | "skipped";
	reviewed_target?: string;
	codex_thread_id?: string;
	rounds?: number;
	verdict_event_id?: string;
	/**
	 * FLY-1188 §7.3: agent families for the reviewer-inversion invariant
	 * (reviewer_family ≠ author_family). NULL on pre-FLY-1188 rows — those are
	 * interpretable ONLY for claude-family authors (the historical
	 * claude-author→codex-reviewer lane); a codex author with an unstamped
	 * record fails closed. See `crossFamilyReviewSatisfied` (flywheel-config).
	 */
	author_family?: string;
	reviewer_family?: string;
	/** FLY-1188 §7.1: review-job binding (codex-author lane). */
	request_id?: string;
	created_at: string;
	approved_at?: string;
	/**
	 * FLY-827 (Codex code-review R1 MED-1): stamped the first time the codex-hold
	 * side-effect bundle (thread post + re-queue instruction + alert) fires for
	 * this (exec, head). `claimCodexHoldNotify` sets it atomically so a restart /
	 * repeated reconcile replays the hold WITHOUT re-posting / re-queueing.
	 */
	hold_notified_at?: string;
	/**
	 * FLY-863: stamped the first time this (exec, head) crosses the stuck
	 * threshold in `reconcileStuckCodexHolds` — the ONLY place the codex-hold
	 * thread-post + Lead alert now fire. `claimCodexHoldStuckNotify` sets it
	 * atomically so a head is escalated exactly once, no matter how many
	 * reconcile passes observe it after that.
	 */
	stuck_notified_at?: string;
}

/**
 * FLY-1188 §7.1: one runner-issued review request in the codex-author lane.
 * `request_id` is the idempotency key; `question_id` is the ONE gate this job
 * may answer. Server-derived trust: `author_family` comes from the session's
 * adapter_type, `frozen_head_sha` from rev-parse in the persisted worktree.
 */
export interface CodexReviewJob {
	request_id: string;
	execution_id: string;
	issue_id?: string;
	project_name: string;
	review_type: "design" | "code";
	round: number;
	question_id: string;
	/** design review: the plan path the reviewer reads. */
	target_path?: string;
	/** code review: server-frozen head at accept time. */
	frozen_head_sha?: string;
	status: "pending" | "running" | "done" | "failed" | "skipped";
	/** claude reviewer session uuid — resumed across rounds per (exec, type). */
	reviewer_session_uuid?: string;
	verdict?: string;
	/** Reviewer-emitted verdict before FLY-1278 policy processing. */
	reviewer_verdict?: string;
	findings_json?: string;
	advisories_json?: string;
	settled_json?: string;
	/** Exact canonical gate payload frozen when the verdict is persisted. */
	response_json?: string;
	payload_version?: number;
	failure_reason?: string;
	failure_raw?: string;
	author_family?: string;
	created_at: string;
	updated_at?: string;
	/**
	 * R12 HIGH-4 outbox stamp: set only after the bound gate question was
	 * actually answered. done/skipped rows with a NULL stamp are re-delivered
	 * on boot (from the stored verdict/findings — the reviewer is NOT re-run).
	 */
	responded_at?: string;
	/**
	 * R17: server-generated at insert, NEVER exposed over HTTP — embedded in
	 * the canonical gate payload so a runner cannot pre-write a predictable
	 * "bridge" response and have it mistaken for the Bridge's delivery.
	 */
	delivery_nonce?: string;
}

export interface ReviewFindingRuling {
	ruling_id: string;
	project_name: string;
	issue_id_canonical: string;
	issue_identifier?: string;
	finding_key: string;
	source_request_id: string;
	source_finding_index: number;
	finding_title?: string;
	finding_severity?: string;
	review_type: "design" | "code";
	disposition: "overruled" | "follow_up";
	follow_up_issue?: string;
	rationale: string;
	ruled_by: string;
	execution_id?: string;
	created_at: string;
	notified_at?: string;
	revoked_at?: string;
	revoked_by?: string;
	revoke_reason?: string;
}

export type RecordReviewFindingRulingResult =
	| {
			status: "created" | "idempotent";
			ruling: ReviewFindingRuling;
	  }
	| {
			status:
				| "issue_not_found"
				| "issue_ambiguous"
				| "finding_not_found"
				| "finding_ambiguous"
				| "conflict";
			ruling?: ReviewFindingRuling;
	  };

/**
 * FLY-191 Phase 2 (Codex R2 HIGH-1): sentinel stored in
 * `sessions.review_question_id` when a Phase-2 needs_review completion
 * carried no usable questionId. Distinguishes "binding required but missing"
 * (approval REFUSED — fail-closed) from NULL = "pre-Phase-2 legacy session"
 * (legacy approve fallback allowed). Mirrored in
 * flywheel-comm/src/commands/verify-approval.ts — keep the values in sync.
 */
export const REVIEW_BINDING_UNBOUND = "unbound";

export class StateStore {
	private db: CompatDb;
	private dbPath: string;

	// --- FLY-639: best-effort corruption self-heal + unrecoverable escalation ---
	/** Consecutive failed rebuilds; reset to 0 on a successful recovery. */
	private recoveryFailures = 0;
	/** Epoch-ms of the last ACTUAL rebuild attempt (storm guard). */
	private lastRecoveryAttemptAt = 0;
	/** Max consecutive failed rebuilds before escalating to a clean restart. */
	private readonly maxRecoveryFailures = 3;
	/**
	 * Min gap between actual rebuild attempts. GatePoller polls every ~3s and a
	 * single tick can hit the same corrupt store across multiple leads; without
	 * this, one corruption episode would trigger a reload storm.
	 */
	private readonly recoveryThrottleMs = 5_000;
	/**
	 * FLY-639 (retained DORMANT under FLY-663): invoked when in-process recovery
	 * has failed `maxRecoveryFailures` times in a row — the DB cannot be reopened.
	 * Default: log FATAL + controlled `process.exit(1)` so launchd respawns the
	 * Bridge with a fresh process + connection. This resolves the "never crash"
	 * vs. "launchd is the fallback" contradiction: a single transient error is
	 * contained, but a truly-dead store does not leave an alive-but-useless
	 * daemon. Injectable so tests do not kill the test runner.
	 */
	onUnrecoverableCorruption: (err: unknown) => void = (err) => {
		console.error(
			"[StateStore] FATAL: StateStore DB unrecoverable after repeated in-process reopen attempts — exiting for a clean restart (launchd respawns the Bridge with a fresh connection):",
			err instanceof Error ? err.message : err,
		);
		process.exit(1);
	};

	private constructor(db: CompatDb, dbPath: string) {
		this.db = db;
		this.dbPath = dbPath;
	}

	/**
	 * FLY-766: the actual db path this store opened (`:memory:` or a file path).
	 * The Chrome-session reaper uses it as the ownership truth threaded into the
	 * per-runner owner marker — no env re-resolution, no reach into the private
	 * field.
	 */
	getDbPath(): string {
		return this.dbPath;
	}

	/**
	 * FLY-663: open the StateStore on native better-sqlite3. The factory stays
	 * `async` so the many `await StateStore.create(...)` call sites (and tests)
	 * are byte-compatible; better-sqlite3 itself is synchronous.
	 *
	 * Zero data migration: a sql.js-exported `teamlead.db` is a standard SQLite3
	 * file, so this opens the existing production DB in place. WAL mode +
	 * `synchronous=NORMAL` give incremental durable writes without the old
	 * full-DB export-on-every-write.
	 */
	static async create(dbPath: string): Promise<StateStore> {
		const store = new StateStore(StateStore.openDatabase(dbPath), dbPath);
		store.migrate();
		return store;
	}

	/** FLY-663: open a better-sqlite3 connection with the StateStore pragmas. */
	private static openDatabase(dbPath: string): CompatDb {
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		const raw = new BetterSqlite3(dbPath);
		// WAL: incremental writes (no full-DB export per write). synchronous=NORMAL
		// is safe under WAL (at most the last txn lost on power-loss) and fast.
		// busy_timeout: retry transient locks (e.g. a cross-process WAL reader /
		// checkpoint) instead of failing immediately.
		raw.pragma("journal_mode = WAL");
		raw.pragma("synchronous = NORMAL");
		raw.pragma("busy_timeout = 5000");
		raw.pragma("foreign_keys = ON");
		return new CompatDb(raw);
	}

	/**
	 * FLY-663: checkpoint the WAL into the main DB file before closing, so a clean
	 * shutdown leaves `teamlead.db` complete and `-wal` empty (backup/migration
	 * tooling can then treat the main file as authoritative). save() is a no-op
	 * now (writes are already durable), so no pre-close flush is needed.
	 */
	close(): void {
		try {
			// wal_checkpoint can return a NON-throwing busy result (busy=1) if another
			// connection holds a read txn — then the WAL is NOT fully truncated. Log it
			// so backup/migration tooling knows the -wal/-shm sidecars may still hold
			// committed frames and must be copied with the main file (Codex code R1 LOW).
			const res = this.db.raw.pragma("wal_checkpoint(TRUNCATE)") as
				| Array<{ busy?: number }>
				| undefined;
			const busy = res?.[0]?.busy;
			if (busy && busy !== 0) {
				console.warn(
					`[StateStore] close(): WAL checkpoint busy (a reader held a lock) — ${this.dbPath}-wal/-shm may retain committed frames; copy them with the main file.`,
				);
			}
		} catch {
			// best-effort; a checkpoint failure must not prevent close.
		}
		this.db.close();
	}

	/**
	 * FLY-639 (band-aid, retained DORMANT under FLY-663): best-effort in-process
	 * recovery from DB corruption. Returns `true` ONLY when the DB was reopened
	 * and is healthy again.
	 *
	 * After the FLY-663 migration the engine is native better-sqlite3 (no WASM
	 * heap), so the original sql.js corruption mode is structurally impossible.
	 * This is kept as defense-in-depth for genuine SQLite-level corruption
	 * (`SQLITE_CORRUPT` / `SQLITE_NOTADB` / a malformed on-disk file).
	 *
	 * - Non-corruption errors → `false` (DB untouched; no counting / throttling).
	 * - Corruption errors → close the suspect handle and REOPEN from the on-disk
	 *   file (a transient handle/heap state heals in-process).
	 *
	 * Recovery CONTRACT (FLY-663 §2.5 — never silently recreate an empty DB over
	 * real data):
	 *   - `:memory:` → rebuild empty (tests only have no on-disk image).
	 *   - file ABSENT → fresh empty DB (legitimate first run).
	 *   - file PRESENT but malformed / NOTADB / CORRUPT → the reopen's sanity
	 *     read THROWS → counted as a rebuild FAILURE → after
	 *     `maxRecoveryFailures` consecutive failures escalate via
	 *     `onUnrecoverableCorruption` (clean restart). It is NEVER masked as an
	 *     empty-DB "success".
	 *
	 * Never throws: a failed rebuild is logged + counted, and the caller (a
	 * periodic poller) simply skips the cycle.
	 */
	recoverFromCorruption(err: unknown): boolean {
		if (!isSqlJsCorruptionError(err)) return false;

		const now = Date.now();
		// Storm guard: at most one ACTUAL rebuild per throttle window. A throttled
		// call is the SAME corruption episode, so it is NOT counted toward the
		// unrecoverable-escalation failure tally.
		if (now - this.lastRecoveryAttemptAt < this.recoveryThrottleMs) {
			return false;
		}
		this.lastRecoveryAttemptAt = now;

		const original = err instanceof Error ? err.message : String(err);
		const old = this.db;
		// Track the freshly-built handle so it can be closed if migration throws
		// (no leaked handle on the failure path — Codex code R1 LOW).
		let next: CompatDb | undefined;
		try {
			// Reopen from the on-disk file, swap it in, then migrate it (idempotent;
			// synchronous). On ANY throw the catch restores `old` and closes `next`.
			next = this.buildDatabaseFromDisk();
			this.db = next;
			this.migrate();
			// Best-effort close of the old (corrupt) handle. A close failure does
			// not fail recovery.
			try {
				old.close();
			} catch {
				// old handle may itself be poisoned — ignore.
			}
			this.recoveryFailures = 0;
			console.error(
				`[StateStore] FLY-639: recovered from DB corruption — reopened from on-disk file (${this.dbPath}). Original error: ${original}`,
			);
			return true;
		} catch (rebuildErr) {
			this.db = old; // restore defined state (old is corrupt, retried next window)
			// Close the half-built replacement so a failed rebuild never leaks a handle.
			if (next) {
				try {
					next.close();
				} catch {
					// best-effort
				}
			}
			this.recoveryFailures++;
			console.error(
				`[StateStore] FLY-639: in-process DB rebuild FAILED (attempt ${this.recoveryFailures}/${this.maxRecoveryFailures}). Original error: ${original}; rebuild error: ${
					rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr)
				}`,
			);
			if (this.recoveryFailures >= this.maxRecoveryFailures) {
				this.onUnrecoverableCorruption(err);
			}
			return false;
		}
	}

	/**
	 * FLY-663: reopen a fresh better-sqlite3 connection from the on-disk file.
	 *
	 * A MISSING file → fresh empty DB (legitimate first-run / no image yet). A
	 * file that EXISTS yet is malformed must NOT be silently swallowed into an
	 * empty-DB "success": the sanity read below THROWS so it counts as a rebuild
	 * failure in `recoverFromCorruption()` and can reach the unrecoverable
	 * escalation (FLY-639 contract preserved; Codex code R1 MEDIUM).
	 */
	private buildDatabaseFromDisk(): CompatDb {
		if (this.dbPath === ":memory:") {
			return StateStore.openDatabase(":memory:");
		}
		const fileExisted = existsSync(this.dbPath);
		const db = StateStore.openDatabase(this.dbPath);
		if (fileExisted) {
			// Existing file → prove it is a real SQLite DB. A malformed/NOTADB image
			// makes this read throw, which the caller counts as a rebuild failure
			// (rather than masking corruption as a clean empty DB).
			db.raw.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
		}
		return db;
	}

	/**
	 * FLY-663: persistence is now incremental + durable per write (better-sqlite3
	 * WAL), so the old export-on-every-write `save()` is gone. Kept as a no-op so
	 * the internal write-path call sites stay byte-identical (minimal diff).
	 */
	private save(): void {
		// no-op: every run() is already durable to the WAL.
	}

	/**
	 * FLY-605: durability barrier before a follow-on durable write. Under WAL
	 * every write is already durable, so this is a no-op (retained for the
	 * external callers in gate-poller). FLY-663: this also removes the old
	 * "appendLeadEvent/markLeadEventDelivered not durable until flush" hazard.
	 */
	flush(): void {
		// no-op: writes are already durable under WAL.
	}

	migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS session_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				event_id TEXT UNIQUE NOT NULL,
				ts TEXT NOT NULL DEFAULT (datetime('now')),
				execution_id TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				event_type TEXT NOT NULL,
				severity TEXT NOT NULL DEFAULT 'info',
				payload JSON,
				source TEXT NOT NULL
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS sessions (
				execution_id TEXT PRIMARY KEY,
				issue_id TEXT NOT NULL,
				issue_identifier TEXT,
				issue_title TEXT,
				project_name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				terminal_at TEXT,
				started_at TEXT,
				last_activity_at TEXT,
				tmux_session TEXT,
				worktree_path TEXT,
				branch TEXT,
				last_error TEXT,
				decision_route TEXT,
				decision_reasoning TEXT,
				cost_usd REAL DEFAULT 0,
				commit_count INTEGER DEFAULT 0,
				files_changed INTEGER DEFAULT 0,
				lines_added INTEGER DEFAULT 0,
				lines_removed INTEGER DEFAULT 0,
				summary TEXT,
				diff_summary TEXT,
				commit_messages TEXT,
				changed_file_paths TEXT,
				thread_id TEXT,
				chat_thread_role TEXT NOT NULL DEFAULT 'main',
				design_backend TEXT,
				workflow_node_id TEXT
			)
		`);

		// FLY-163: forum `conversation_threads` table dropped. Per-issue chat
		// threads live in `chat_threads` (FLY-91). The `sessions.thread_id`
		// physical column is kept for backward compat (deprecated; no TS surface
		// reads/writes it) and will be removed in a follow-up via table-rename.
		this.db.run("DROP TABLE IF EXISTS conversation_threads");

		// Migration: rename slack_thread_ts → thread_id (existing DBs)
		// Three cases: (a) fresh DB → DDL already has thread_id, skip
		//              (b) old DB with slack_thread_ts → rename
		//              (c) legacy DB without either column → ADD COLUMN
		const hasSlackThreadTs = this.db.exec(
			"SELECT 1 FROM pragma_table_info('sessions') WHERE name='slack_thread_ts'",
		);
		const hasThreadId = this.db.exec(
			"SELECT 1 FROM pragma_table_info('sessions') WHERE name='thread_id'",
		);
		if (hasSlackThreadTs.length > 0 && hasSlackThreadTs[0]!.values.length > 0) {
			// Case (b): old DB — rename
			this.db.run(
				"ALTER TABLE sessions RENAME COLUMN slack_thread_ts TO thread_id",
			);
		} else if (
			hasThreadId.length === 0 ||
			hasThreadId[0]!.values.length === 0
		) {
			// Case (c): legacy DB — neither column exists
			this.db.run("ALTER TABLE sessions ADD COLUMN thread_id TEXT");
		}
		// Case (a): fresh DB — thread_id already in DDL, nothing to do

		// Cutover: clear stale Slack thread mappings (one-time, guarded by user_version)
		const versionResult = this.db.exec("PRAGMA user_version");
		const currentVersion = (versionResult[0]?.values[0]?.[0] as number) ?? 0;
		if (currentVersion < 2) {
			this.db.run("UPDATE sessions SET thread_id = NULL");
			this.db.run("PRAGMA user_version = 2");
		}

		// Idempotent migration — add GEO-157 heartbeat/adapter columns
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN session_params TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN heartbeat_at TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN adapter_type TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			// FLY-728: resolved runner model (per-issue model routing visibility).
			this.db.run("ALTER TABLE sessions ADD COLUMN runner_model TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			// FLY-728 Part C: the difficulty-sorter's dispatch model param ONLY (the
			// source-honest retry input — distinct from runner_model, which is the
			// resolved model from any layer). Retry re-applies it so a sorter model
			// survives; a label/project/account model is NOT reintroduced.
			this.db.run("ALTER TABLE sessions ADD COLUMN dispatch_model TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			// FLY-1259: effective design backend locked at dispatch. This is separate
			// from model fields so the transition API can later grow into the planned
			// per-node {vendor, model, effort} shape without parsing a model string.
			this.db.run("ALTER TABLE sessions ADD COLUMN design_backend TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			// FLY-615: ponytail A/B condition (join key for FLY-614/616).
			this.db.run("ALTER TABLE sessions ADD COLUMN ponytail_condition TEXT");
		} catch {
			// Column already exists — ignore
		}
		try {
			// FLY-1356: effective skill-framework arm + attribution (split eval
			// join keys; absent = the flag sat at its default when the run resolved).
			this.db.run("ALTER TABLE sessions ADD COLUMN skill_framework_mode TEXT");
		} catch {
			// Column already exists — ignore
		}
		// FLY-1356 (Bar-Raiser MED-1): the sticky-stamp lookup filters on
		// issue_id — index it so the split-mode per-dispatch read is not a scan.
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_sessions_issue_id ON sessions (issue_id)",
		);
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN skill_framework_mode_via TEXT",
			);
		} catch {
			// Column already exists — ignore
		}
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN run_attempt INTEGER DEFAULT 0",
			);
		} catch {
			// Column already exists — ignore
		}

		// GEO-168: retry lineage columns
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN retry_predecessor TEXT");
		} catch {}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN retry_successor TEXT");
		} catch {}

		// GEO-152: issue labels for multi-lead routing
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN issue_labels TEXT");
		} catch {}

		// FLY-163: GEO-169 / GEO-200 conversation_threads ALTERs removed (table dropped).

		// GEO-292: PR number + session stage tracking
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN pr_number INTEGER");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN session_stage TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN stage_updated_at TEXT");
		} catch {
			/* exists */
		}

		// FLY-59: session role for multi-session-per-issue support
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN session_role TEXT DEFAULT 'main'",
			);
		} catch {
			/* exists */
		}

		// FLY-175: PR head SHA for founder-consent approve cache-key salt.
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN pr_head_sha TEXT");
		} catch {
			/* exists */
		}

		// FLY-137 Phase 5: agent dispatch + Codex auto-trigger persistence.
		// All four columns are NULL-able / defaulted so existing rows are
		// backward-compatible with no migration data step required.
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN agent_name TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN agent_match_method TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN plan_path TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN codex_skip INTEGER NOT NULL DEFAULT 0",
			);
		} catch {
			/* exists */
		}
		// FLY-598: founder-facing UX gate. `founder_facing_ux` = Lead label snapshot
		// at run start OR Runner self-declaration (1 = gate active for this run).
		// `founder_ux_signoff_json` = the Bridge-written, founder-identity-verified
		// sign-off record (bound to a canonical UX-brief uxHash); only the privileged
		// record path writes it, the Runner reads it via the status route.
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN founder_facing_ux INTEGER NOT NULL DEFAULT 0",
			);
		} catch {
			/* exists */
		}
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN founder_ux_signoff_json TEXT",
			);
		} catch {
			/* exists */
		}
		// FLY-598: per-run snapshot of founder_ux_gate.mode (off|audit_only|enforce),
		// captured at run start from the project config; the Layer B stage guard
		// reads it. Absent → treated as "off".
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN founder_ux_gate_mode TEXT");
		} catch {
			/* exists */
		}

		// FLY-869 A-1: immutable QA-required snapshot, captured when auto-qa-policy
		// first evaluates this session (Bridge-side, where the trusted signals live).
		// `qa_required` = 1 when QA applies (must pass before ship/Done), 0 when
		// exempt (no-code / pure-docs / no-qa label / qa.auto:false), NULL = never
		// evaluated (the "该起没起" case → the ship gate treats a code PR fail-closed,
		// a no-code/no-PR route as exempt). config/label changes NEVER rewrite it.
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN qa_required INTEGER");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN qa_required_reason TEXT");
		} catch {
			/* exists */
		}
		// FLY-869 B-3: merged-but-unapproved park marker. When a session reaches a
		// merged landing WITHOUT verified ship approval, we do NOT finalize (决定③
		// no auto-revert); instead we persist this durable marker (head-bound) so the
		// founder-hold suppressors keep it out of review/QA/finalization surfaces, and
		// same-head approval recovery can clear it. NULL reason = not blocked.
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN merge_block_reason TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN merge_block_head TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN merge_block_at TEXT");
		} catch {
			/* exists */
		}

		// FLY-191 Phase 2: persisted awaiting_review entry timestamp (Bridge-side
		// 48h review-timeout anchor; must survive Bridge restarts — NOT the
		// mutable last_activity_at) + gate_timed_out dedup stamp + the CURRENT
		// review question binding (Codex PR R1 CRITICAL).
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN awaiting_review_entered_at TEXT",
			);
		} catch {
			/* exists */
		}
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN gate_timeout_notified_at TEXT",
			);
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN review_question_id TEXT");
		} catch {
			/* exists */
		}

		// FLY-205: doc-flow tier (Lead-judged at spawn; retry reuses it — never
		// silently upgrades back to full) + Linear issue URL (doc header line;
		// persisted at start so retry prompts keep the same header as start).
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN doc_tier TEXT");
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN issue_url TEXT");
		} catch {
			/* exists */
		}

		// FLY-793 (Step 11): the session's chat-thread role — 'main' for every
		// non-three-stage session (byte-compat), or the phase role (design /
		// implement / qa) for a three-stage phase-session. Persisted at start so
		// Session-based thread resolution (which lacks the dispatch-time
		// shareParentBranch signal) routes to the right table. Legacy rows default
		// 'main' = existing 1:1 behavior.
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN chat_thread_role TEXT NOT NULL DEFAULT 'main'",
			);
		} catch {
			/* exists */
		}
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN workflow_node_id TEXT");
		} catch {
			/* exists */
		}

		// FLY-245 D-a: monotonic lifecycle revision — incremented on EVERY status
		// transition (upsert / persistTransition / forceStatus). The runner-lifecycle
		// founder credential snapshots this at request time; a stale confirmation is
		// rejected when the revision has since changed (status can leave and return to
		// the same value, so `status` alone is not a sufficient freshness signal —
		// plan §5.1 / Codex R1#5). Defaults 0 so existing rows are backward-compatible.
		try {
			this.db.run(
				"ALTER TABLE sessions ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0",
			);
		} catch {
			/* exists */
		}

		// FLY-1257: chronology anchor for zombie-gate hygiene. Existing terminal
		// rows intentionally remain NULL: without an observed entry timestamp the
		// cleanup must fail open rather than guess whether a gate is older.
		try {
			this.db.run("ALTER TABLE sessions ADD COLUMN terminal_at TEXT");
		} catch {
			/* exists */
		}

		// FLY-1185 §2.1: worktree authority binding — an INDEPENDENT column group
		// written ONLY by the atomic `bindWorktreeOnce` (create-time, orchestrator
		// side). `patchSessionMetadata` / `upsertSession` structurally cannot touch
		// these (they are absent from both field maps) — Runner-visible event
		// paths therefore can never create or overwrite deletion authority.
		for (const col of [
			"worktree_binding_path",
			"worktree_binding_branch",
			"worktree_binding_generation",
			"worktree_binding_locked_at",
		]) {
			try {
				this.db.run(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
			} catch {
				/* exists */
			}
		}

		// FLY-163: drop legacy conversation_threads index (table is gone).
		this.db.run("DROP INDEX IF EXISTS idx_threads_issue");

		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_events_execution ON session_events(execution_id)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_events_issue ON session_events(issue_id)",
		);
		// FLY-727: daily digest range-scans session_completed by ts.
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_events_type_ts ON session_events(event_type, ts)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)",
		);

		// FLY-727: deployment_events — the fleet "deployed to live" ledger. The daily
		// digest queries this by time (cheap indexed range); each project reports a
		// row at its real product-deploy point via `POST /api/deployments/report`.
		// dedup_key is a deterministic non-null identity so INSERT OR IGNORE is idempotent.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS deployment_events (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				project_name      TEXT NOT NULL,
				issue_identifier  TEXT,
				pr_number         INTEGER,
				merge_sha         TEXT,
				deployed_sha      TEXT,
				deploy_batch_id   TEXT,
				environment       TEXT NOT NULL DEFAULT 'production',
				source            TEXT NOT NULL,
				source_event_id   TEXT,
				deployed_at       TEXT NOT NULL,
				recorded_at       TEXT NOT NULL DEFAULT (datetime('now')),
				metadata_json     TEXT,
				dedup_key         TEXT NOT NULL
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_events_dedup ON deployment_events(dedup_key)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_deployment_events_time ON deployment_events(deployed_at)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_deployment_events_proj_time ON deployment_events(project_name, deployed_at)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_deployment_events_issue ON deployment_events(project_name, issue_identifier)",
		);

		// GEO-195: Event journal for lead runtime delivery tracking
		this.db.run(`
			CREATE TABLE IF NOT EXISTS lead_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				lead_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				payload TEXT NOT NULL,
				session_key TEXT,
				delivered_at TEXT,
				delivery_attempts INTEGER NOT NULL DEFAULT 0,
				last_delivery_error TEXT,
				ack_required INTEGER NOT NULL DEFAULT 0,
				ack_policy TEXT,
				ack_protocol_version INTEGER,
				ack_deadline_at TEXT,
				acked_at TEXT,
				dead_letter_pending_at TEXT,
				dead_lettered_at TEXT,
				ack_token_valid_until TEXT,
				ack_token_consumed_at TEXT,
				ingress_disposed_at TEXT,
				ack_retired_at TEXT,
				ack_retired_reason TEXT,
				routing_snapshot TEXT,
				ack_owner_lead_id TEXT,
				ack_owner_epoch INTEGER NOT NULL DEFAULT 0,
				pending_delivery_reason TEXT CHECK(pending_delivery_reason IN ('owner_transfer','secret_rotation')),
				page_claim_token TEXT,
				page_claim_lease_expires_at TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_lead_events_recent ON lead_events(lead_id, delivered_at)",
		);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_events_dedup ON lead_events(lead_id, event_id)",
		);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS lead_event_delivery_attempts (
				attempt_id TEXT PRIMARY KEY,
				event_seq INTEGER NOT NULL REFERENCES lead_events(seq),
				attempt_no INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('initial','reminder')),
				reason TEXT NOT NULL CHECK(reason IN ('initial','ack_timeout','owner_transfer','secret_rotation')),
				counts_toward_redelivery INTEGER NOT NULL CHECK(counts_toward_redelivery IN (0,1)),
				claim_token TEXT NOT NULL,
				owner_epoch_at_claim INTEGER NOT NULL,
				secret_id_at_claim TEXT NOT NULL,
				reclaim_count INTEGER NOT NULL DEFAULT 0,
				last_reclaimed_at TEXT,
				lease_expires_at TEXT NOT NULL,
				claimed_at TEXT NOT NULL,
				pushed_at TEXT,
				finalized_at TEXT,
				outcome TEXT CHECK(outcome IN ('pushed','failed')),
				last_error TEXT,
				retired_at TEXT,
				UNIQUE(event_seq, attempt_no)
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_lead_delivery_attempt_open ON lead_event_delivery_attempts(event_seq, finalized_at, retired_at, lease_expires_at)",
		);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS delivery_secret_state (
				singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
				state TEXT NOT NULL CHECK(state IN ('PREPARED','ACTIVE')),
				active_secret_id TEXT,
				prepared_secret_id TEXT,
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// FLY-1018: ship-approval-request outbox. Each row is the durable
		// record of a gemini-agent ship REQUEST; it is inserted in the SAME
		// transaction as its lead_events row (recordShipApprovalRequest), so
		// row existence ⟺ the founder-visible event is durably queued. Zero
		// CommDB involvement — this is NOT an approve_to_ship gate.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS ship_approval_requests (
				request_id TEXT PRIMARY KEY,
				pr_url TEXT NOT NULL,
				project_name TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				requester TEXT NOT NULL,
				summary TEXT NOT NULL,
				lead_event_id TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_ship_approval_requests_pr ON ship_approval_requests(pr_url, created_at)",
		);

		// FLY-91: Chat threads for per-issue conversation in chatChannel
		this.db.run(`
			CREATE TABLE IF NOT EXISTS chat_threads (
				thread_id TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				issue_id TEXT,
				lead_id TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				discord_missing_at TEXT,
				archived_at TEXT,
				attach_pin_message_id TEXT,
				attach_pin_command TEXT,
				attach_pin_pinned_at TEXT,
				phase_status_message_id TEXT,
				phase_status_text TEXT,
				display_fingerprint TEXT,
				display_reconciled_at TEXT
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_issue_channel ON chat_threads(issue_id, channel_id)",
		);

		// FLY-793 (Step 11, Hybrid): per-phase chat threads for a three-stage run.
		// DELIBERATELY a SIDE-TABLE separate from `chat_threads`: a three-stage issue
		// has ONE Design/Implement/QA thread per role, but `chat_threads`'
		// `UNIQUE(issue_id, channel_id)` allows only one row per issue. Keeping the
		// main table + its index BYTE-UNCHANGED (zero migration risk to the 1:1
		// mapping every existing project relies on) and routing only non-`main`
		// phase roles here is the de-risked Hybrid (Annie 2026-07-03). `session_role
		// NOT NULL` avoids SQLite's multi-NULL unique-index escape hatch. Columns
		// mirror `chat_threads` so the role-aware accessors dispatch by table.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS phase_chat_threads (
				thread_id TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				session_role TEXT NOT NULL,
				lead_id TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				discord_missing_at TEXT,
				archived_at TEXT,
				attach_pin_message_id TEXT,
				attach_pin_command TEXT,
				attach_pin_pinned_at TEXT
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_phase_chat_threads_issue_channel_role ON phase_chat_threads(issue_id, channel_id, session_role)",
		);

		// FLY-314: Roundtable per-topic threads. DELIBERATELY a separate table from
		// chat_threads: roundtable topics are NOT issue/session-bound, and reusing
		// chat_threads would leak synthetic ids through the issue-thread reverse
		// lookup (/api/chat-threads/by-thread) and reply-guard's "issue-thread"
		// classification (Codex design review R1#2). thread_id == source_message_id
		// (Discord "start thread from message" invariant — the crash-recovery anchor).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS roundtable_topic_threads (
				thread_id TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				source_message_id TEXT NOT NULL,
				author_id TEXT,
				trigger_mode TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				discord_missing_at TEXT,
				archived_at TEXT
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_roundtable_topic_msg ON roundtable_topic_threads(channel_id, source_message_id)",
		);

		// FLY-195: Lead disposition receipts for stuck-runner episodes (plan §3.4).
		// One row per (execution, episode fingerprint). The Lead's judgment is
		// AUTHORITATIVE: the Bridge fallback (runner_stuck_unhandled Annie alert)
		// suppresses on any row here, and the detector consults it to avoid
		// re-paging the Lead for an already-judged episode after a Bridge restart.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS stuck_dispositions (
				execution_id TEXT NOT NULL,
				episode_fingerprint TEXT NOT NULL,
				disposition TEXT NOT NULL,
				snooze_until_ms INTEGER,
				noted_by TEXT,
				note TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (execution_id, episode_fingerprint)
			)
		`);

		// FLY-245 D2: retry dispatch intent WAL (plan §5.2.1). The durable
		// (gateway request id → successor execution id) binding, committed BEFORE
		// the dispatcher runs. `state` is informational ('intent' → 'dispatched');
		// crash recovery NEVER treats it as proof of start — the authoritative
		// started evidence is the Runner's self-registered live tmux identity
		// (bridge/started-evidence.ts). Exactly one successor id per request id,
		// enforced by the PRIMARY KEY.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS retry_dispatch_intents (
				request_id TEXT PRIMARY KEY,
				successor_execution_id TEXT NOT NULL,
				predecessor_execution_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'intent',
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// FLY-368: unified alert-channel per-error threads (active-mapping ONLY —
		// the current live thread per incident; history lives in Discord / logs /
		// alert_repair_attempts, NOT here). correlation_key = coarse key for
		// resolve-by-kind: `${project}|${leadId}|${eventType}|${sessionKey??''}`.
		// event_id + episode_signature are the fine key (a different event_id under
		// the same correlation_key = a distinct, later episode → the stale row is
		// resolved+archived, then openAlertThread() UPSERTs the new mapping).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS alert_threads (
				correlation_key TEXT PRIMARY KEY,
				event_id TEXT NOT NULL,
				episode_signature TEXT,
				thread_id TEXT NOT NULL,
				root_message_id TEXT,
				channel_id TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				event_type TEXT NOT NULL,
				session_key TEXT,
				repair_status TEXT,
				opened_at TEXT NOT NULL DEFAULT (datetime('now')),
				resolved_at TEXT
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_alert_threads_active ON alert_threads(resolved_at)",
		);
		// FLY-927 (Task 2.2): ticket lifecycle columns — idempotent ADD COLUMN
		// (the FLY-267 reply_channel_id migration pattern). NULL ticket_status on
		// old rows = legacy semantics; the ticket state machine only drives rows
		// opened with an explicit status.
		for (const [col, ddl] of [
			["ticket_status", "ticket_status TEXT"],
			["owner_ref", "owner_ref TEXT"],
			["attempt_count", "attempt_count INTEGER DEFAULT 0"],
			["first_seen_at", "first_seen_at TEXT"],
			["acked_at", "acked_at TEXT"],
		] as const) {
			const has = this.db.exec(
				`SELECT 1 FROM pragma_table_info('alert_threads') WHERE name='${col}'`,
			);
			if (has.length === 0 || has[0]!.values.length === 0) {
				this.db.run(`ALTER TABLE alert_threads ADD COLUMN ${ddl}`);
			}
		}

		// FLY-1082 (Task 2.2): the fleet pressure-hold — a SINGLE durable row
		// (id=1 enforced). While present, runner admission defers every new
		// dispatch (`pressure_hold`); the swap sensor sets it on a high-watermark
		// episode and clears it when the watermark falls below the low threshold.
		// Durable so a Bridge restart mid-episode keeps the brake on.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS fleet_pressure_hold (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				set_by TEXT NOT NULL,
				set_at TEXT NOT NULL DEFAULT (datetime('now')),
				watermark TEXT
			)
		`);

		// FLY-1082 (Task 3.2): escalation-event ledger — alert_threads UPSERTs one
		// row per correlation key, so repeated episodes overwrite their history;
		// the runbook-gap counter ("same kind ESCALATED ≥N in 7 days ⇒ auto-file
		// the eng issue") needs an append-only record. Plus the per-kind open
		// runbook-issue dedup (at most ONE open issue per kind).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS ticket_escalations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL,
				escalated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_ticket_escalations_kind ON ticket_escalations(kind, escalated_at)",
		);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS runbook_issues (
				kind TEXT PRIMARY KEY,
				issue_id TEXT NOT NULL,
				issue_identifier TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// FLY-1082 (Task 2.3, Codex R3/R4/R5): the server-loss episode LEDGER —
		// a single durable row holding the active episode's signature + full
		// side-effect state (shape, claimed exec ids, per-Lead notification
		// outbox, ticket phase). The coordinator's restart resume reads THIS
		// (never the alert ticket row: ACTIVE only means resolved_at IS NULL —
		// a permanently-ESCALATED old ticket must not swallow a NEW incident),
		// and every owed side effect replays from it exactly once per target.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS server_loss_episode (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				signature TEXT NOT NULL,
				state_json TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// FLY-1285: durable, append-history tmux safety holds. Correlation is the
		// normalized socket path plus an immutable Bridge-allocated incident id;
		// diagnostic reason may evolve without opening a second incident.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS tmux_hold (
				incident_id TEXT PRIMARY KEY,
				normalized_socket_path TEXT NOT NULL,
				shape TEXT NOT NULL CHECK (shape IN ('provisional','server_down','server_fresh')),
				shape_source TEXT NOT NULL CHECK (shape_source IN ('observation','coordinator')),
				current_reason TEXT NOT NULL,
				first_reason TEXT NOT NULL,
				reason_history_json TEXT NOT NULL,
				evidence_json TEXT NOT NULL,
				affected_execution_ids_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_checked_at TEXT NOT NULL,
				resolved_at TEXT
			)
		`);
		this.db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_tmux_hold_one_active_socket
			ON tmux_hold(normalized_socket_path) WHERE resolved_at IS NULL
		`);

		// FLY-818 M3: durable per-eventId founder-page ledger. Records whether a
		// GENUINE founder page (an @founder message in the stuck runner's [FLY-XX]
		// issue thread — Annie's issue-thread design) actually succeeded for a
		// runner_stuck_unhandled escalation, keyed by its escalation eventId. The
		// stuck detector retries the SAME eventId when alertUnhandled returns false;
		// claims.db dedups that retry (skipped=duplicate) so the retry can never
		// re-POST — this ledger lets the duplicate/queued early-return paths learn
		// the REAL delivery outcome instead of resolving on a dedup alone (Codex
		// R2#2). Monotonic: once a page truly lands, `paged` stays 1 (converge — Q3).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS founder_page_ledger (
				event_id TEXT PRIMARY KEY,
				paged INTEGER NOT NULL,
				ts TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// FLY-368: durable, fail-closed audit for auto-repair-bot terminal writes
		// to a LEAD pane (the resume-menu Enter). Lead-level alerts have no real
		// execution/issue, so they MUST NOT be forced into session_events; this is
		// their purpose-built audit sink (mirrors the runner nudge's audit-before-
		// send contract). Append-only.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS alert_repair_attempts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				correlation_key TEXT NOT NULL,
				event_id TEXT,
				actor TEXT NOT NULL,
				action TEXT NOT NULL,
				lead_id TEXT,
				project_name TEXT,
				result TEXT NOT NULL,
				reason TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		// FLY-579 P1: auto-QA pipeline durable record. Keyed by (parent main
		// execution, reviewed PR head sha) so a re-review against a new head opens
		// a fresh record while a repeated awaiting_review for the SAME head dedups
		// to one QA spawn. Written before the QA Runner spawns (held-first).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS auto_qa_record (
				parent_execution_id TEXT NOT NULL,
				target_pr_head_sha TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				enrollment_source TEXT NOT NULL DEFAULT 'auto'
					CHECK (enrollment_source IN ('auto','manual')),
				qa_execution_id TEXT,
				qa_issue_id TEXT,
				qa_issue_identifier TEXT,
				qa_issue_title TEXT,
				qa_issue_url TEXT,
				status TEXT NOT NULL DEFAULT 'running',
				verdict_event_id TEXT,
				started_at TEXT NOT NULL DEFAULT (datetime('now')),
				completed_at TEXT,
				notified_at TEXT,
				retest_wake_pending_at TEXT,
				auto_retry_count INTEGER NOT NULL DEFAULT 0,
				retry_intent_at TEXT,
				retry_attempt_id TEXT,
				PRIMARY KEY (parent_execution_id, target_pr_head_sha)
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_auto_qa_record_qa_exec ON auto_qa_record(qa_execution_id)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_auto_qa_record_status ON auto_qa_record(status)",
		);

		// FLY-1251: exact-head, server-owned docs-only/code classification. A
		// missing row is authorization-unknown and therefore founder-held.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS ship_relevant_diff_snapshot (
				execution_id TEXT NOT NULL,
				pr_head_sha TEXT NOT NULL,
				repo TEXT NOT NULL,
				pr_number INTEGER NOT NULL,
				base_ref TEXT NOT NULL,
				base_oid TEXT NOT NULL,
				classifier_version INTEGER NOT NULL,
				ship_relevant INTEGER NOT NULL CHECK (ship_relevant IN (0,1)),
				file_count INTEGER NOT NULL,
				sample_paths TEXT,
				computed_at TEXT NOT NULL,
				PRIMARY KEY (execution_id, pr_head_sha)
			)
		`);

		// FLY-827: durable Codex code-review verdict — the authoritative gate record
		// (keyed to the exact reviewed head, so a new head voids an older approval).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS codex_review_record (
				execution_id TEXT NOT NULL,
				target_pr_head_sha TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				reviewed_target TEXT,
				codex_thread_id TEXT,
				rounds INTEGER,
				verdict_event_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				approved_at TEXT,
				hold_notified_at TEXT,
				stuck_notified_at TEXT,
				PRIMARY KEY (execution_id, target_pr_head_sha)
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_codex_review_status ON codex_review_record(status)",
		);
		// FLY-1188 §7.3: family-aware review authority — the reviewer-inversion
		// invariant (reviewer family ≠ author family) is checked against these
		// stamps; NULL = pre-FLY-1188 legacy row (claude-author→codex-reviewer
		// lane only). request_id binds a record to its review job (codex-author
		// lane).
		for (const col of ["author_family", "reviewer_family", "request_id"]) {
			try {
				this.db.run(`ALTER TABLE codex_review_record ADD COLUMN ${col} TEXT`);
			} catch {
				/* exists */
			}
		}
		// FLY-863: existing databases created before this column existed.
		try {
			this.db.run(
				"ALTER TABLE codex_review_record ADD COLUMN stuck_notified_at TEXT",
			);
		} catch {
			/* exists */
		}

		// FLY-1188 §7.1: durable review-JOB registry for the codex-author lane.
		// A row = one runner-issued review request (requestId is the idempotency
		// key), bound to exactly one gate questionId. The Bridge derives the
		// trusted inputs server-side (author family from sessions.adapter_type;
		// code-review head frozen via rev-parse in the persisted worktree) —
		// the payload is validated input, never authority. pending/running rows
		// are redriven on Bridge boot.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS codex_review_job (
				request_id            TEXT PRIMARY KEY,
				execution_id          TEXT NOT NULL,
				issue_id              TEXT,
				project_name          TEXT NOT NULL,
				review_type           TEXT NOT NULL CHECK(review_type IN ('design','code')),
				round                 INTEGER NOT NULL DEFAULT 1,
				question_id           TEXT NOT NULL,
				target_path           TEXT,
				frozen_head_sha       TEXT,
				status                TEXT NOT NULL DEFAULT 'pending'
				                      CHECK(status IN ('pending','running','done','failed','skipped')),
				reviewer_session_uuid TEXT,
				verdict               TEXT,
				reviewer_verdict      TEXT,
				findings_json         TEXT,
				advisories_json       TEXT,
				settled_json          TEXT,
				response_json         TEXT,
				payload_version       INTEGER,
				failure_reason        TEXT,
				failure_raw           TEXT,
				author_family         TEXT,
				created_at            TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at            TEXT,
				responded_at          TEXT,
				delivery_nonce        TEXT
			)
		`);
		// R12 HIGH-4 outbox column on databases created before it existed.
		try {
			this.db.run("ALTER TABLE codex_review_job ADD COLUMN responded_at TEXT");
		} catch {
			/* exists */
		}
		// R17: server-generated delivery nonce (never leaves the Bridge via
		// HTTP) — makes the canonical gate payload unforgeable by a runner
		// pre-writing a predictable response through the legacy respond path.
		try {
			this.db.run(
				"ALTER TABLE codex_review_job ADD COLUMN delivery_nonce TEXT",
			);
		} catch {
			/* exists */
		}
		// FLY-1254/FLY-1278: active review writes require failure diagnostics plus
		// the frozen reviewer/effective split and canonical response. Any
		// unexpected migration error must fail boot loudly instead of leaving a
		// database that will reject or mis-deliver future review writes.
		const reviewJobInfo = this.db.exec("PRAGMA table_info(codex_review_job)");
		const reviewJobColumns =
			reviewJobInfo[0]?.values.map((row) => row[1] as string) ?? [];
		for (const [column, type] of [
			["question_id", "TEXT"],
			["failure_raw", "TEXT"],
			["reviewer_verdict", "TEXT"],
			["advisories_json", "TEXT"],
			["settled_json", "TEXT"],
			["response_json", "TEXT"],
			["payload_version", "INTEGER"],
		] as const) {
			if (!reviewJobColumns.includes(column)) {
				this.db.run(
					`ALTER TABLE codex_review_job ADD COLUMN ${column} ${type}`,
				);
			}
		}
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_codex_review_job_exec ON codex_review_job(execution_id)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_codex_review_job_status ON codex_review_job(status)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_codex_review_job_question ON codex_review_job(question_id)",
		);

		// FLY-1278: Lead-authoritative, per-finding governance rulings. Rows are
		// audit history (revoke stamps, never DELETE); the partial unique index is
		// the DB boundary for one active intent per canonical issue/key/type.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS review_finding_ruling (
				ruling_id            TEXT PRIMARY KEY,
				project_name         TEXT NOT NULL,
				issue_id_canonical   TEXT NOT NULL,
				issue_identifier     TEXT,
				finding_key          TEXT NOT NULL,
				source_request_id    TEXT NOT NULL,
				source_finding_index INTEGER NOT NULL,
				finding_title        TEXT,
				finding_severity     TEXT,
				review_type          TEXT NOT NULL CHECK(review_type IN ('design','code')),
				disposition          TEXT NOT NULL CHECK(disposition IN ('overruled','follow_up')),
				follow_up_issue      TEXT,
				rationale            TEXT NOT NULL,
				ruled_by             TEXT NOT NULL,
				execution_id         TEXT,
				created_at           TEXT NOT NULL DEFAULT (datetime('now')),
				notified_at          TEXT,
				revoked_at           TEXT,
				revoked_by           TEXT,
				revoke_reason        TEXT
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_review_ruling_issue ON review_finding_ruling(project_name, issue_id_canonical)",
		);
		this.db.run(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_review_ruling_active
			   ON review_finding_ruling(project_name, issue_id_canonical, finding_key, review_type)
			 WHERE revoked_at IS NULL`,
		);

		// FLY-637 #3/#4: persistent "already-notified" dedup for the quiet-path
		// Lead wake (direction A — report-once, NO backoff). A row means "I already
		// woke the Lead about THIS frozen frame", so a Bridge restart cannot
		// re-wake (the in-memory dedup sets are wiped on restart). Keyed by
		// (execution_id, source, episode_fingerprint):
		//   - source = 'idle'  (RunnerIdleWatchdog) → fp = quietFingerprint(pane)
		//   - source = 'stuck' (HeartbeatService)   → fp = sentinel 'stuck' (no pane)
		// Rows are pruned when the session leaves the watchdog's running/stuck set.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS quiet_wake_notified (
				execution_id        TEXT NOT NULL,
				source              TEXT NOT NULL,
				episode_fingerprint TEXT NOT NULL,
				notified_at         TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (execution_id, source, episode_fingerprint)
			)
		`);

		// FLY-637-ext: durable exponential-backoff state for the lead-pending
		// escalation (a runner blocked on a `question` gate the Lead hasn't
		// answered). Keyed by (execution_id, question_id) so a runner's multiple
		// pending questions never share/overwrite backoff state (Codex R1 #1).
		// Survives a Bridge restart so a restart doesn't re-storm nudges.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS lead_pending_escalation (
				execution_id        TEXT NOT NULL,
				question_id         TEXT NOT NULL,
				stuck_key           TEXT NOT NULL,
				nudge_count         INTEGER NOT NULL DEFAULT 0,
				last_nudge_at_ms    INTEGER NOT NULL DEFAULT 0,
				next_eligible_at_ms INTEGER NOT NULL DEFAULT 0,
				paged_annie         INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (execution_id, question_id)
			)
		`);

		// FLY-1099 §3.1: deferred founder ship-decisions (held → 暂存 → rebind).
		// Historical key (question_id, msg_id) — a row is NEVER re-created/updated
		// for the same founder message (strict no-op, no TTL refresh); the single
		// ACTIVE row per gate is enforced by the partial unique index below.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS founder_deferred_approval (
				question_id     TEXT NOT NULL,
				msg_id          TEXT NOT NULL,
				execution_id    TEXT NOT NULL,
				issue_id        TEXT NOT NULL,
				project_name    TEXT NOT NULL,
				pr_head_sha     TEXT NOT NULL,
				thread_id       TEXT NOT NULL,
				decision        TEXT NOT NULL CHECK(decision IN ('approve','reject')),
				content         TEXT NOT NULL,
				author_user_id  TEXT NOT NULL,
				founder_id_at_capture TEXT NOT NULL,
				created_at      TEXT NOT NULL DEFAULT (datetime('now')),
				expires_at      TEXT NOT NULL,
				consumed_at     TEXT,
				invalidated_at  TEXT,
				invalidated_reason TEXT,
				PRIMARY KEY (question_id, msg_id)
			)
		`);
		this.db.run(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_deferred_active
			   ON founder_deferred_approval(question_id)
			   WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
		);

		// FLY-1099 §3.1: result-bearing founder action ledger — durable intent →
		// (drain-time eligibility recheck) → execute → outcome. At-least-once:
		// side-effect dedup is the sink's job (Codex R3 #3).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS founder_action_ledger (
				action_key   TEXT PRIMARY KEY,
				kind         TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				issue_id     TEXT NOT NULL,
				project_name TEXT NOT NULL,
				thread_id    TEXT,
				payload      TEXT NOT NULL,
				depends_on   TEXT,
				status       TEXT NOT NULL DEFAULT 'pending'
				             CHECK(status IN ('pending','delivered','failed','cancelled','superseded')),
				attempts     INTEGER NOT NULL DEFAULT 0,
				last_error   TEXT,
				created_at   TEXT NOT NULL DEFAULT (datetime('now')),
				delivered_at TEXT,
				failed_at_ms INTEGER
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_founder_action_status ON founder_action_ledger(status)",
		);

		// FLY-1238: a gh UNKNOWN cannot retry forever or silently degrade into
		// posting a stale founder-facing message. Persist before the first probe.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS merged_gate_guard_failure (
				question_id   TEXT NOT NULL,
				source        TEXT NOT NULL,
				execution_id  TEXT NOT NULL,
				issue_id      TEXT NOT NULL,
				project_name  TEXT NOT NULL,
				attempts      INTEGER NOT NULL DEFAULT 0,
				first_seen_ms INTEGER NOT NULL,
				next_retry_ms INTEGER NOT NULL DEFAULT 0,
				last_error    TEXT,
				terminal      INTEGER NOT NULL DEFAULT 0,
				alerted       INTEGER NOT NULL DEFAULT 0,
				resolved_at   TEXT,
				PRIMARY KEY (question_id, source)
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS commdb_finalize_failures (
				execution_id     TEXT PRIMARY KEY,
				issue_id         TEXT NOT NULL,
				project_name     TEXT NOT NULL,
				attempts         INTEGER NOT NULL DEFAULT 0,
				first_failure_ms INTEGER NOT NULL,
				last_failure_ms  INTEGER NOT NULL,
				last_error       TEXT,
				alerted          INTEGER NOT NULL DEFAULT 0,
				resolved_at      TEXT
			)
		`);

		// FLY-1099 §3.1: bounded founder-reply retry ledger — the durable source
		// for the cursor-pin watchdog AND the dead-letter decision. first_seen_ms
		// is the episode salt (Codex R3 #4: datetime('now') is second-resolution).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS founder_reply_retry (
				thread_id   TEXT NOT NULL,
				msg_id      TEXT NOT NULL,
				attempts    INTEGER NOT NULL DEFAULT 0,
				first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
				first_seen_ms INTEGER NOT NULL,
				last_stage  TEXT,
				last_error  TEXT,
				dead_lettered_at TEXT,
				dead_lettered_ms INTEGER,
				PRIMARY KEY (thread_id, msg_id)
			)
		`);

		// FLY-1185 §2.3: durable continuous-eligibility observations for cleanup
		// candidates (branches / worktrees). A candidate must hold the SAME
		// fingerprint across ≥3 days of sweeps before any new deletion class may
		// touch it; any change resets the clock.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS cleanup_ref_observations (
				project                TEXT NOT NULL,
				kind                   TEXT NOT NULL,
				ref_name               TEXT NOT NULL,
				fingerprint            TEXT NOT NULL,
				first_seen_eligible_at TEXT NOT NULL,
				last_seen_sweep_at     TEXT NOT NULL,
				PRIMARY KEY (project, kind, ref_name)
			)
		`);

		// FLY-1185 §2.12 (R9#1/R10#4): Linear state observation episodes — the
		// cutover guard. Automatic issue-terminal closeout is authorized ONLY by a
		// durably-observed nonterminal→terminal migration; ANY first-seen-terminal
		// (legacy episode) routes to the manual manifest, never to auto mutation.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS linear_state_observations (
				project                 TEXT NOT NULL,
				issue_uuid              TEXT NOT NULL,
				last_state_type         TEXT NOT NULL,
				last_linear_updated_at  TEXT NOT NULL,
				observed_at             TEXT NOT NULL DEFAULT (datetime('now')),
				legacy_terminal_episode INTEGER NOT NULL DEFAULT 0,
				terminal_authorized     INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (project, issue_uuid)
			)
		`);

		// FLY-1185 §2.12 (R9#2/R10#1): founder disposition intents — the issue
		// TOMBSTONE dimension (persistent until explicitly unparked/superseded),
		// with the execution dimension tracked separately in closeout_status.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS issue_disposition_intents (
				issue_uuid          TEXT NOT NULL PRIMARY KEY,
				project             TEXT NOT NULL,
				disposition         TEXT NOT NULL CHECK(disposition IN ('founder_parked')),
				founder_decision_id TEXT NOT NULL,
				expected_project    TEXT,
				created_at          TEXT NOT NULL DEFAULT (datetime('now')),
				closeout_status     TEXT NOT NULL DEFAULT 'pending'
				                    CHECK(closeout_status IN ('pending','partial','complete','needs_operator')),
				last_report         TEXT,
				superseded_at       TEXT,
				superseded_by       TEXT
			)
		`);

		// FLY-1185 (R11#1): durable launch claims — the admission decorator writes
		// a `starting` claim INSIDE the issue mutex before releasing it, so a
		// concurrent park's node collection always SEES an in-flight spawn.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS lifecycle_launch_claims (
				execution_id TEXT NOT NULL PRIMARY KEY,
				root_uuid    TEXT NOT NULL,
				project      TEXT NOT NULL,
				role         TEXT,
				state        TEXT NOT NULL DEFAULT 'starting'
				             CHECK(state IN ('starting','active','closed','cancelled')),
				created_at   TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		// FLY-1185 (Codex R3#7): durable apply-hash claims — same-approvedHash
		// HTTP retries and post-crash replays return the persisted report
		// instead of a spurious snapshot-drift rejection.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS lifecycle_apply_claims (
				root_uuid     TEXT NOT NULL,
				approved_hash TEXT NOT NULL,
				status        TEXT NOT NULL,
				report_json   TEXT,
				created_at    TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (root_uuid, approved_hash)
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_launch_claims_root ON lifecycle_launch_claims(root_uuid)",
		);

		// FLY-1048 PR-C (C1): durable episode store for the unified escalation
		// flow (PRD §3.3b + §4.3). Single authoritative dedup/timing record —
		// the ~30min Lead-grace timer and the notify/page dedup must survive a
		// Bridge restart, so no transition lives only in memory. Same episode
		// key family as stuck_dispositions.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS detection_escalations (
				target_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				episode_fingerprint TEXT NOT NULL,
				issue_id TEXT,
				owner_lead_id TEXT,
				first_detected_at_ms INTEGER NOT NULL,
				lead_notified_at_ms INTEGER,
				lead_ack_at_ms INTEGER,
				founder_paged_at_ms INTEGER,
				clearing_since_ms INTEGER,
				status TEXT NOT NULL DEFAULT 'NEW',
				attempts INTEGER NOT NULL DEFAULT 0,
				resolved_via TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (target_key, kind, episode_fingerprint)
			)
		`);
		// FLY-1048 (Codex code R2 #1): idempotent migration for rows created
		// before resolved_via existed (FLY-267 ADD COLUMN precedent).
		try {
			this.db.run(
				"ALTER TABLE detection_escalations ADD COLUMN resolved_via TEXT",
			);
		} catch {
			/* column already exists */
		}
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_detection_escalations_status ON detection_escalations(status)",
		);

		// FLY-1282 Part D: durable disposition-receipt outbox. Rows are created
		// ONLY by a Lead disposition (via:'lead', changed=true) inside the same
		// transaction as the escalation ack; the reconcile-side consumer posts
		// them into the issue thread. `receipt_id` is the immutable delivery
		// identity (episode PKs are reused across revives); the 4-column UNIQUE
		// is the per-episode-GENERATION dedup (anchor copied from the fresh
		// escalation row, never inferred from wall clock). Required fields are
		// NOT NULL + CHECKed so a malformed prepare THROWS and rolls the whole
		// disposition transaction back — never `INSERT OR IGNORE` here (it
		// swallows NOT NULL/CHECK failures, leaving an acked episode with a
		// permanently missing receipt).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS disposition_receipts (
				receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
				target_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				episode_fingerprint TEXT NOT NULL,
				episode_first_detected_at_ms INTEGER NOT NULL,
				actor_lead_id TEXT NOT NULL,
				disposition TEXT NOT NULL CHECK (disposition IN (
					'ack','resolve','dismiss','false_positive','legitimate_wait',
					'snooze','needs_founder','handled_remanaged'
				)),
				content TEXT NOT NULL,
				issue_id TEXT,
				state TEXT NOT NULL DEFAULT 'pending' CHECK (
					state IN ('pending','posted','unroutable','expired')
				),
				attempts INTEGER NOT NULL DEFAULT 0,
				last_attempt_at_ms INTEGER,
				created_at_ms INTEGER NOT NULL,
				posted_at_ms INTEGER,
				UNIQUE (target_key, kind, episode_fingerprint, episode_first_detected_at_ms)
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_disposition_receipts_state ON disposition_receipts(state)",
		);

		// FLY-1244 PR-5: immutable workflow template revisions + publication
		// pointer and category selection. This only materializes the catalog;
		// execution remains default-off until a run is explicitly admitted.
		this.migrateWorkflowTemplates();
		// FLY-1135 PR-1: workflow claims ledger substrate (default-off, no
		// production path reads or writes these tables yet).
		this.migrateWorkflowClaimsLedger();
		// FLY-1232 module ②: shadow-run composite transaction substrate
		// (side-effect ledger + active-run uniqueness). Runs AFTER the claims
		// ledger migration — it indexes workflow_run. Default-off like the rest:
		// production reaches it only via the WorkflowShadowWriter behind
		// FLYWHEEL_WORKFLOW_CLAIMS_WRITE.
		this.migrateWorkflowShadowLedger();

		// FLY-25: migration for existing tables missing new columns
		this.migrateLeadEventsDeliveryColumns();
		// FLY-369: archived_at on chat_threads (archive-on-Done)
		this.migrateChatThreadsArchivedColumn();
		this.migrateChatThreadsAttachPinColumns();
		this.migrateChatThreadsPhaseStatusLineColumns();
		this.migrateChatThreadsDisplayFingerprintColumns();
		// FLY-643: qa_issue_* columns on auto_qa_record (separate QA issue)
		this.migrateAutoQaRecordQaIssueColumns();
	}

	private migrateWorkflowTemplates(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_template (
				template_id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				project_scope TEXT NOT NULL CHECK (
					project_scope = 'global' OR length(trim(project_scope)) > 0
				),
				current_published_revision INTEGER,
				created_by TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				seed_owner TEXT NOT NULL DEFAULT 'system'
					CHECK (seed_owner IN ('system','founder')),
				seed_content_hash TEXT,
				retired_at TEXT,
				FOREIGN KEY (template_id, current_published_revision)
					REFERENCES workflow_template_revision(template_id, revision)
			)
		`);
		try {
			this.db.run("ALTER TABLE workflow_template ADD COLUMN retired_at TEXT");
		} catch {
			/* column already exists */
		}
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_template_revision (
				template_id TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				manifest JSON NOT NULL,
				manifest_digest TEXT NOT NULL,
				schema_version INTEGER NOT NULL,
				created_by TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (template_id, revision),
				FOREIGN KEY (template_id) REFERENCES workflow_template(template_id)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_template_publication (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				template_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				published_by TEXT NOT NULL,
				published_at TEXT NOT NULL DEFAULT (datetime('now')),
				FOREIGN KEY (template_id, revision)
					REFERENCES workflow_template_revision(template_id, revision)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_category_binding (
				project TEXT NOT NULL,
				task_category TEXT NOT NULL DEFAULT '*',
				template_id TEXT NOT NULL,
				updated_by TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (project, task_category),
				FOREIGN KEY (template_id) REFERENCES workflow_template(template_id)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_template_audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at TEXT NOT NULL DEFAULT (datetime('now')),
				actor TEXT NOT NULL,
				action TEXT NOT NULL CHECK (
					action IN ('seed_import','publish','rebind','create','run_override')
				),
				template_id TEXT,
				revision INTEGER,
				run_id TEXT,
				detail JSON
			)
		`);
		for (const table of [
			"workflow_template_revision",
			"workflow_template_publication",
			"workflow_template_audit",
		]) {
			this.db.run(`
				CREATE TRIGGER IF NOT EXISTS ${table}_no_update
				BEFORE UPDATE ON ${table}
				BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END
			`);
			this.db.run(`
				CREATE TRIGGER IF NOT EXISTS ${table}_no_delete
				BEFORE DELETE ON ${table}
				BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END
			`);
		}
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_template_revision_no_replace
			BEFORE INSERT ON workflow_template_revision
			WHEN EXISTS (
				SELECT 1 FROM workflow_template_revision
				 WHERE template_id = NEW.template_id AND revision = NEW.revision
			)
			BEGIN SELECT RAISE(ABORT, 'workflow_template_revision is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_template_publication_no_replace
			BEFORE INSERT ON workflow_template_publication
			WHEN NEW.id IS NOT NULL AND EXISTS (
				SELECT 1 FROM workflow_template_publication WHERE id = NEW.id
			)
			BEGIN SELECT RAISE(ABORT, 'workflow_template_publication is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_template_audit_no_replace
			BEFORE INSERT ON workflow_template_audit
			WHEN NEW.id IS NOT NULL AND EXISTS (
				SELECT 1 FROM workflow_template_audit WHERE id = NEW.id
			)
			BEGIN SELECT RAISE(ABORT, 'workflow_template_audit is append-only'); END
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_template_publication_template ON workflow_template_publication(template_id, id)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_template_audit_template ON workflow_template_audit(template_id, id)",
		);
	}

	insertEvent(event: SessionEvent): boolean {
		try {
			this.db.run(
				`INSERT INTO session_events (event_id, execution_id, issue_id, project_name, event_type, severity, payload, source)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					event.event_id,
					event.execution_id,
					event.issue_id,
					event.project_name,
					event.event_type,
					event.severity ?? "info",
					event.payload ? JSON.stringify(event.payload) : null,
					event.source,
				],
			);
			this.save();
			return true;
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				err.message.includes("UNIQUE constraint failed")
			) {
				return false;
			}
			throw err;
		}
	}

	getEventsByExecution(executionId: string): SessionEvent[] {
		const stmt = this.db.prepare(
			"SELECT * FROM session_events WHERE execution_id = ? ORDER BY id",
		);
		stmt.bind([executionId]);
		const rows: SessionEvent[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				event_id: row.event_id as string,
				execution_id: row.execution_id as string,
				issue_id: row.issue_id as string,
				project_name: row.project_name as string,
				event_type: row.event_type as string,
				severity: row.severity as string,
				payload: row.payload ? JSON.parse(row.payload as string) : undefined,
				source: row.source as string,
				// FLY-1048 PR-B: expose the row timestamp so consumers can compute
				// truthful event ages (judge commEvents input).
				ts: row.ts as string | undefined,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-546: events of one type across ALL executions — the voice
	 * gate-binding endpoint reverse-looks-up a ship-gate message id against
	 * every persisted `ship_gate_msg_binding` row.
	 */
	getEventsByType(eventType: string): SessionEvent[] {
		const stmt = this.db.prepare(
			"SELECT * FROM session_events WHERE event_type = ? ORDER BY id",
		);
		stmt.bind([eventType]);
		const rows: SessionEvent[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				event_id: row.event_id as string,
				execution_id: row.execution_id as string,
				issue_id: row.issue_id as string,
				project_name: row.project_name as string,
				event_type: row.event_type as string,
				severity: row.severity as string,
				payload: row.payload ? JSON.parse(row.payload as string) : undefined,
				source: row.source as string,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-546: all live (non-missing) chat thread ids — main + phase tables.
	 * The voice scope contract lists them as founder-facing channels.
	 */
	getAllChatThreadIds(): string[] {
		const ids: string[] = [];
		for (const table of ["chat_threads", "phase_chat_threads"]) {
			const stmt = this.db.prepare(
				`SELECT thread_id FROM ${table} WHERE discord_missing_at IS NULL`,
			);
			while (stmt.step()) {
				const row = stmt.getAsObject() as Record<string, unknown>;
				ids.push(row.thread_id as string);
			}
			stmt.free();
		}
		return ids;
	}

	/**
	 * FLY-727: session_completed events in a UTC time window, carrying `id` + `ts`.
	 * The daily digest queries a WIDE UTC window and does the exact Pacific-day
	 * (+ DST) filtering per-event downstream. Read-only; ordered ASC by ts so a
	 * downstream last-write-wins dedup yields each issue's latest completion.
	 */
	getCompletionEventsInRange(
		sinceUtc: string,
		untilUtc: string,
	): CompletionEventRow[] {
		const stmt = this.db.prepare(
			`SELECT id, ts, execution_id, issue_id, project_name, payload
			 FROM session_events
			 WHERE event_type = 'session_completed' AND ts >= ? AND ts < ?
			 ORDER BY ts ASC`,
		);
		stmt.bind([sinceUtc, untilUtc]);
		const rows: CompletionEventRow[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				id: row.id as number,
				ts: row.ts as string,
				execution_id: row.execution_id as string,
				issue_id: row.issue_id as string,
				project_name: row.project_name as string,
				payload: row.payload ? JSON.parse(row.payload as string) : undefined,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-727: idempotently insert a deployment event. Returns whether a NEW row was
	 * inserted (false = dedup hit). `deployedAt` defaults to now. The dedup key is a
	 * deterministic non-null identity so `INSERT OR IGNORE` collapses replays
	 * (self-ship updater re-runs, spool drains) but keeps genuinely distinct deploys.
	 */
	insertDeploymentEvent(input: DeploymentEventInput): { inserted: boolean } {
		const norm = (s: string | undefined) => (s ? s.trim() : undefined);
		const issue = norm(input.issueIdentifier)?.toUpperCase();
		const mergeSha = norm(input.mergeSha)?.toLowerCase();
		const deployedSha = norm(input.deployedSha)?.toLowerCase();
		const batchId = norm(input.deployBatchId);
		const sourceEventId = norm(input.sourceEventId);
		const environment = norm(input.environment) ?? "production";
		const deployedAt =
			norm(input.deployedAt) ??
			new Date()
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d+Z$/, "");
		// Event identity — must be non-null (Bridge route rejects if all absent).
		const eventIdentity =
			mergeSha ?? sourceEventId ?? batchId ?? deployedSha ?? "";
		// Codex code-review R6 (HIGH): a squash-merge commit is 1:1 with a single
		// PR/issue, so when `merge_sha` is the identity it ALONE identifies the deploy
		// — issue/pr are enrichment and must NOT be part of the dedup key. Otherwise a
		// fallback-git-log row whose commit subject yielded a PR but no issue (key
		// `proj||pr|sha|env`) fails to collide with the authoritative marker report
		// (key `proj|issue|pr|sha|env`), leaving two rows the digest double-counts.
		// A merge-less identity (batch / deployed-sha) CAN span multiple issues, so
		// there issue+pr stay in the key to keep genuinely-distinct deploys distinct.
		const dedupKey = mergeSha
			? [input.projectName, "", "", eventIdentity, environment].join("|")
			: [
					input.projectName,
					issue ?? "",
					input.prNumber ?? "",
					eventIdentity,
					environment,
				].join("|");

		// Correctness of dedup is guaranteed by the UNIQUE(dedup_key) index +
		// INSERT OR IGNORE regardless; the `inserted` bool is informational for the
		// CLI response, so a per-key existence probe (not a racy full-table count) is
		// enough to say "recorded" vs "already recorded".
		const existed =
			(this.db.exec(
				"SELECT 1 FROM deployment_events WHERE dedup_key = ? LIMIT 1",
				[dedupKey],
			)[0]?.values.length ?? 0) > 0;
		this.db.run(
			`INSERT OR IGNORE INTO deployment_events
			 (project_name, issue_identifier, pr_number, merge_sha, deployed_sha,
			  deploy_batch_id, environment, source, source_event_id, deployed_at,
			  metadata_json, dedup_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				input.projectName,
				issue ?? null,
				input.prNumber ?? null,
				mergeSha ?? null,
				deployedSha ?? null,
				batchId ?? null,
				environment,
				input.source,
				sourceEventId ?? null,
				deployedAt,
				norm(input.metadataJson) ?? null,
				dedupKey,
			],
		);
		// Codex code-review R5 #2: a marker-driven markerless FALLBACK row
		// (source='fallback-git-log') is written at deployed-sha advance BEFORE the
		// authoritative marker-backed self-ship report for the same commit identity;
		// plain INSERT OR IGNORE would leave the deploy stuck as `inferred`. When an
		// AUTHORITATIVE (non-fallback) source reports the same dedup_key, UPGRADE the
		// existing fallback row to it (source + enrich fields). Only fallback rows are
		// touched (WHERE source='fallback-git-log'), so authoritative rows never regress.
		if (input.source !== "fallback-git-log") {
			this.db.run(
				`UPDATE deployment_events
				   SET source = ?,
				       issue_identifier = COALESCE(?, issue_identifier),
				       pr_number = COALESCE(?, pr_number),
				       merge_sha = COALESCE(?, merge_sha),
				       deployed_sha = COALESCE(?, deployed_sha),
				       source_event_id = COALESCE(?, source_event_id)
				 WHERE dedup_key = ? AND source = 'fallback-git-log'`,
				[
					input.source,
					issue ?? null,
					input.prNumber ?? null,
					mergeSha ?? null,
					deployedSha ?? null,
					sourceEventId ?? null,
					dedupKey,
				],
			);
		}
		this.save();
		return { inserted: !existed };
	}

	/**
	 * FLY-727: deployment events in a UTC time window (the digest's primary source).
	 * Ordered ASC by deployed_at.
	 */
	getDeploymentEventsInRange(
		sinceUtc: string,
		untilUtc: string,
	): DeploymentEventRow[] {
		const stmt = this.db.prepare(
			`SELECT id, project_name, issue_identifier, pr_number, merge_sha,
			        deployed_sha, deploy_batch_id, environment, source,
			        source_event_id, deployed_at, recorded_at, metadata_json
			 FROM deployment_events
			 WHERE deployed_at >= ? AND deployed_at < ?
			 ORDER BY deployed_at ASC`,
		);
		stmt.bind([sinceUtc, untilUtc]);
		const rows: DeploymentEventRow[] = [];
		while (stmt.step()) {
			const r = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				id: r.id as number,
				project_name: r.project_name as string,
				issue_identifier: (r.issue_identifier as string) ?? null,
				pr_number: (r.pr_number as number) ?? null,
				merge_sha: (r.merge_sha as string) ?? null,
				deployed_sha: (r.deployed_sha as string) ?? null,
				deploy_batch_id: (r.deploy_batch_id as string) ?? null,
				environment: r.environment as string,
				source: r.source as string,
				source_event_id: (r.source_event_id as string) ?? null,
				deployed_at: r.deployed_at as string,
				recorded_at: r.recorded_at as string,
				metadata_json: (r.metadata_json as string) ?? null,
			});
		}
		stmt.free();
		return rows;
	}

	upsertSession(session: SessionUpsert): void {
		// Check monotonic state: if existing session is terminal, ignore transition back to running
		const existing = this.getSession(session.execution_id);
		if (
			existing?.workflow_node_id &&
			session.workflow_node_id &&
			existing.workflow_node_id !== session.workflow_node_id
		) {
			throw new Error(
				`workflow_node_id set-once conflict for ${session.execution_id}: ${existing.workflow_node_id} != ${session.workflow_node_id}`,
			);
		}
		if (
			existing &&
			TERMINAL_STATUSES.has(existing.status) &&
			session.status === "running"
		) {
			return; // Ignore: terminal → running is not allowed
		}

		// FLY-191 Phase 2: stamp awaiting_review entry on this legacy write
		// path too (same semantics as persistTransition).
		const enteringAwaitingReview =
			session.status === "awaiting_review" &&
			existing?.status !== "awaiting_review";

		// FLY-663 §2.8: the session upsert + awaiting_review stamp + lifecycle bump
		// are one logical mutation. The old export()-on-save was the atomic
		// persistence boundary; under better-sqlite3 autocommit they must be wrapped
		// so a mid-sequence throw cannot leave durable partial state.
		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO sessions (
				execution_id, issue_id, project_name, status,
				issue_identifier, issue_title,
				started_at, last_activity_at,
				tmux_session, worktree_path, branch,
				last_error, decision_route, decision_reasoning,
				cost_usd, commit_count, files_changed, lines_added, lines_removed,
				summary, diff_summary, commit_messages, changed_file_paths,
				session_params, heartbeat_at, adapter_type, runner_model, dispatch_model, design_backend, ponytail_condition, skill_framework_mode, skill_framework_mode_via, run_attempt,
				retry_predecessor, retry_successor, issue_labels,
				pr_number, session_stage, stage_updated_at, session_role,
				doc_tier, issue_url, chat_thread_role, workflow_node_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(execution_id) DO UPDATE SET
				issue_id = COALESCE(excluded.issue_id, issue_id),
				project_name = COALESCE(excluded.project_name, project_name),
				status = excluded.status,
				issue_identifier = COALESCE(excluded.issue_identifier, issue_identifier),
				issue_title = COALESCE(excluded.issue_title, issue_title),
				started_at = COALESCE(excluded.started_at, started_at),
				last_activity_at = COALESCE(excluded.last_activity_at, last_activity_at),
				tmux_session = COALESCE(excluded.tmux_session, tmux_session),
				worktree_path = COALESCE(excluded.worktree_path, worktree_path),
				branch = COALESCE(excluded.branch, branch),
				last_error = COALESCE(excluded.last_error, last_error),
				decision_route = COALESCE(excluded.decision_route, decision_route),
				decision_reasoning = COALESCE(excluded.decision_reasoning, decision_reasoning),
				cost_usd = COALESCE(excluded.cost_usd, cost_usd),
				commit_count = COALESCE(excluded.commit_count, commit_count),
				files_changed = COALESCE(excluded.files_changed, files_changed),
				lines_added = COALESCE(excluded.lines_added, lines_added),
				lines_removed = COALESCE(excluded.lines_removed, lines_removed),
				summary = COALESCE(excluded.summary, summary),
				diff_summary = COALESCE(excluded.diff_summary, diff_summary),
				commit_messages = COALESCE(excluded.commit_messages, commit_messages),
				changed_file_paths = COALESCE(excluded.changed_file_paths, changed_file_paths),
				session_params = COALESCE(excluded.session_params, session_params),
				heartbeat_at = COALESCE(excluded.heartbeat_at, heartbeat_at),
				adapter_type = COALESCE(excluded.adapter_type, adapter_type),
				runner_model = COALESCE(excluded.runner_model, runner_model),
				dispatch_model = COALESCE(excluded.dispatch_model, dispatch_model),
				design_backend = COALESCE(design_backend, excluded.design_backend),
				ponytail_condition = COALESCE(excluded.ponytail_condition, ponytail_condition),
				skill_framework_mode = COALESCE(excluded.skill_framework_mode, skill_framework_mode),
				skill_framework_mode_via = COALESCE(excluded.skill_framework_mode_via, skill_framework_mode_via),
				run_attempt = COALESCE(excluded.run_attempt, run_attempt),
				retry_predecessor = COALESCE(excluded.retry_predecessor, retry_predecessor),
				retry_successor = COALESCE(excluded.retry_successor, retry_successor),
				issue_labels = COALESCE(excluded.issue_labels, issue_labels),
				pr_number = COALESCE(excluded.pr_number, pr_number),
				session_stage = COALESCE(excluded.session_stage, session_stage),
				stage_updated_at = COALESCE(excluded.stage_updated_at, stage_updated_at),
				session_role = COALESCE(excluded.session_role, session_role),
				doc_tier = COALESCE(excluded.doc_tier, doc_tier),
					issue_url = COALESCE(excluded.issue_url, issue_url),
					workflow_node_id = CASE
						WHEN workflow_node_id IS NULL THEN excluded.workflow_node_id
						ELSE workflow_node_id
					END
			`,
				[
					session.execution_id,
					session.issue_id,
					session.project_name,
					session.status,
					session.issue_identifier ?? null,
					session.issue_title ?? null,
					session.started_at ?? null,
					session.last_activity_at ?? null,
					session.tmux_session ?? null,
					session.worktree_path ?? null,
					session.branch ?? null,
					session.last_error ?? null,
					session.decision_route ?? null,
					session.decision_reasoning ?? null,
					session.cost_usd ?? null,
					session.commit_count ?? null,
					session.files_changed ?? null,
					session.lines_added ?? null,
					session.lines_removed ?? null,
					session.summary ?? null,
					session.diff_summary ?? null,
					session.commit_messages ?? null,
					session.changed_file_paths ?? null,
					session.session_params ?? null,
					session.heartbeat_at ?? null,
					session.adapter_type ?? null,
					session.runner_model ?? null,
					session.dispatch_model ?? null,
					session.design_backend ?? null,
					session.ponytail_condition ?? null,
					session.skill_framework_mode ?? null,
					session.skill_framework_mode_via ?? null,
					session.run_attempt ?? null,
					session.retry_predecessor ?? null,
					session.retry_successor ?? null,
					session.issue_labels ?? null,
					session.pr_number ?? null,
					session.session_stage ?? null,
					session.stage_updated_at ?? null,
					session.session_role ?? null,
					session.doc_tier ?? null,
					session.issue_url ?? null,
					// FLY-793 (Step 11): set-once at INSERT; NOT in the ON CONFLICT
					// update, so it is immutable after the row is created (the phase is
					// fixed at dispatch). `?? "main"` keeps the NOT NULL column satisfied.
					session.chat_thread_role ?? "main",
					session.workflow_node_id ?? null,
				],
			);
			// FLY-1372 (Codex design R4-1): the two NOT NULL DEFAULT 0 behavior
			// columns are deliberately NOT in the fixed column list above — an
			// `undefined` input must never overwrite an existing value, and the
			// INSERT default (0) already covers the fresh-undefined case. Defined
			// inputs land here, inside the SAME transaction as row creation, so
			// there is no crash cut between the row and its behavior metadata.
			if (session.codex_skip !== undefined) {
				this.db.run(
					"UPDATE sessions SET codex_skip = ? WHERE execution_id = ?",
					[session.codex_skip ? 1 : 0, session.execution_id],
				);
			}
			if (session.founder_facing_ux !== undefined) {
				// Keep-high: a Runner self-declaration (founder_facing_ux=1) must
				// never be downgraded by a repeated started upsert carrying the
				// stale computed value.
				this.db.run(
					"UPDATE sessions SET founder_facing_ux = MAX(founder_facing_ux, ?) WHERE execution_id = ?",
					[session.founder_facing_ux ? 1 : 0, session.execution_id],
				);
			}
			this.applyTerminalTimestamp(
				session.execution_id,
				existing?.status,
				session.status,
			);
			if (enteringAwaitingReview) {
				this.stampAwaitingReviewEntry(session.execution_id);
			}
			// FLY-245 D-a: bump the monotonic lifecycle revision on a genuine status
			// CHANGE (a new session keeps revision 0; a same-status re-upsert does not
			// inflate it). The runner-lifecycle credential's freshness snapshot relies
			// on this.
			if (existing && existing.status !== session.status) {
				this.bumpLifecycleRevision(session.execution_id);
			}
		});
		this.save();
	}

	/** FLY-245 D-a: atomically increment a session's monotonic lifecycle revision.
	 * Called by every status-write path on a real transition (plan §5.1). */
	private bumpLifecycleRevision(executionId: string): void {
		this.db.run(
			"UPDATE sessions SET lifecycle_revision = lifecycle_revision + 1 WHERE execution_id = ?",
			[executionId],
		);
	}

	/** FLY-1257: maintain the single SQLite-clock chronology anchor shared by
	 * all status-write paths. First terminal entry stamps; terminal rewrites
	 * preserve the first stamp; any revival clears it. Must run inside the
	 * caller's status transaction after that status write succeeds.
	 *
	 * FLY-1328 — EVERY new sessions status-write path MUST call this. The gate
	 * branch's chronology fails OPEN on a missing stamp, so a bypass there only
	 * degrades gate hygiene. The ask sweep fails CLOSED: terminal status + no
	 * stamp reads as "no evidence of reopening" and the ask is retired. A future
	 * status-write path that skips this call would therefore make every reopened
	 * runner of that shape silently sweepable — and it would surface not as a
	 * failing test but as questions quietly vanishing weeks later. If you are
	 * adding a fourth writer, stamp here or the sweep will eat its asks. */
	private applyTerminalTimestamp(
		executionId: string,
		previousStatus: string | undefined,
		nextStatus: string,
	): void {
		const wasTerminal =
			isStateStoreIrreversibleTerminalForZombie(previousStatus);
		const isTerminal = isStateStoreIrreversibleTerminalForZombie(nextStatus);
		if (isTerminal && !wasTerminal) {
			this.db.run(
				"UPDATE sessions SET terminal_at = datetime('now') WHERE execution_id = ?",
				[executionId],
			);
		} else if (!isTerminal) {
			this.db.run(
				"UPDATE sessions SET terminal_at = NULL WHERE execution_id = ?",
				[executionId],
			);
		}
	}

	/** FLY-245 D-a: read a session's current monotonic lifecycle revision (0 if
	 * the session is absent). */
	getLifecycleRevision(executionId: string): number {
		return this.getSession(executionId)?.lifecycle_revision ?? 0;
	}

	/**
	 * Persist a status change that has already been validated by FSM.
	 * Bypasses monotonic guard — caller MUST have validated via WorkflowFSM.
	 * Uses INSERT OR UPDATE to handle both first-time creation and subsequent transitions.
	 * GEO-158: used exclusively by applyTransition().
	 */
	persistTransition(
		executionId: string,
		status: string,
		fields: Partial<SessionUpsert>,
	): void {
		const existingNodeId = this.getSession(executionId)?.workflow_node_id;
		if (
			existingNodeId &&
			fields.workflow_node_id &&
			existingNodeId !== fields.workflow_node_id
		) {
			throw new Error(
				`workflow_node_id set-once conflict for ${executionId}: ${existingNodeId} != ${fields.workflow_node_id}`,
			);
		}
		// FLY-191 Phase 2: detect entry into awaiting_review BEFORE the upsert
		// (needs the pre-write status). Stamped after the write succeeds.
		const enteringAwaitingReview = this.isEnteringAwaitingReview(
			executionId,
			status,
		);
		// FLY-245 D-a: capture pre-write status to bump lifecycle revision on a
		// genuine transition (this is the FSM-validated path; a new session keeps
		// revision 0).
		const preStatus = this.getSession(executionId)?.status;
		// FLY-663 §2.8: status upsert + awaiting_review stamp + lifecycle bump are
		// one logical mutation — wrap so no durable partial state on a mid throw.
		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO sessions (
				execution_id, issue_id, project_name, status,
				issue_identifier, issue_title,
				started_at, last_activity_at,
				tmux_session, worktree_path, branch,
				last_error, decision_route, decision_reasoning,
				cost_usd, commit_count, files_changed, lines_added, lines_removed,
				summary, diff_summary, commit_messages, changed_file_paths,
				session_params, heartbeat_at, adapter_type, runner_model, dispatch_model, design_backend, ponytail_condition, skill_framework_mode, skill_framework_mode_via, run_attempt,
				retry_predecessor, retry_successor, issue_labels,
				pr_number, session_stage, stage_updated_at, session_role,
				doc_tier, issue_url, chat_thread_role, workflow_node_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(execution_id) DO UPDATE SET
				status = excluded.status,
				issue_id = COALESCE(excluded.issue_id, issue_id),
				project_name = COALESCE(excluded.project_name, project_name),
				issue_identifier = COALESCE(excluded.issue_identifier, issue_identifier),
				issue_title = COALESCE(excluded.issue_title, issue_title),
				started_at = COALESCE(excluded.started_at, started_at),
				last_activity_at = COALESCE(excluded.last_activity_at, last_activity_at),
				tmux_session = COALESCE(excluded.tmux_session, tmux_session),
				worktree_path = COALESCE(excluded.worktree_path, worktree_path),
				branch = COALESCE(excluded.branch, branch),
				last_error = COALESCE(excluded.last_error, last_error),
				decision_route = COALESCE(excluded.decision_route, decision_route),
				decision_reasoning = COALESCE(excluded.decision_reasoning, decision_reasoning),
				cost_usd = COALESCE(excluded.cost_usd, cost_usd),
				commit_count = COALESCE(excluded.commit_count, commit_count),
				files_changed = COALESCE(excluded.files_changed, files_changed),
				lines_added = COALESCE(excluded.lines_added, lines_added),
				lines_removed = COALESCE(excluded.lines_removed, lines_removed),
				summary = COALESCE(excluded.summary, summary),
				diff_summary = COALESCE(excluded.diff_summary, diff_summary),
				commit_messages = COALESCE(excluded.commit_messages, commit_messages),
				changed_file_paths = COALESCE(excluded.changed_file_paths, changed_file_paths),
				session_params = COALESCE(excluded.session_params, session_params),
				heartbeat_at = COALESCE(excluded.heartbeat_at, heartbeat_at),
				adapter_type = COALESCE(excluded.adapter_type, adapter_type),
				runner_model = COALESCE(excluded.runner_model, runner_model),
				dispatch_model = COALESCE(excluded.dispatch_model, dispatch_model),
				design_backend = COALESCE(design_backend, excluded.design_backend),
				ponytail_condition = COALESCE(excluded.ponytail_condition, ponytail_condition),
				skill_framework_mode = COALESCE(excluded.skill_framework_mode, skill_framework_mode),
				skill_framework_mode_via = COALESCE(excluded.skill_framework_mode_via, skill_framework_mode_via),
				run_attempt = COALESCE(excluded.run_attempt, run_attempt),
				retry_predecessor = COALESCE(excluded.retry_predecessor, retry_predecessor),
				retry_successor = COALESCE(excluded.retry_successor, retry_successor),
				issue_labels = COALESCE(excluded.issue_labels, issue_labels),
				pr_number = COALESCE(excluded.pr_number, pr_number),
				session_stage = COALESCE(excluded.session_stage, session_stage),
				stage_updated_at = COALESCE(excluded.stage_updated_at, stage_updated_at),
				session_role = COALESCE(excluded.session_role, session_role),
				doc_tier = COALESCE(excluded.doc_tier, doc_tier),
					issue_url = COALESCE(excluded.issue_url, issue_url),
					workflow_node_id = CASE
						WHEN workflow_node_id IS NULL THEN excluded.workflow_node_id
						ELSE workflow_node_id
					END
			`,
				[
					executionId,
					fields.issue_id ?? null,
					fields.project_name ?? null,
					status,
					fields.issue_identifier ?? null,
					fields.issue_title ?? null,
					fields.started_at ?? null,
					fields.last_activity_at ?? null,
					fields.tmux_session ?? null,
					fields.worktree_path ?? null,
					fields.branch ?? null,
					fields.last_error ?? null,
					fields.decision_route ?? null,
					fields.decision_reasoning ?? null,
					fields.cost_usd ?? null,
					fields.commit_count ?? null,
					fields.files_changed ?? null,
					fields.lines_added ?? null,
					fields.lines_removed ?? null,
					fields.summary ?? null,
					fields.diff_summary ?? null,
					fields.commit_messages ?? null,
					fields.changed_file_paths ?? null,
					fields.session_params ?? null,
					fields.heartbeat_at ?? null,
					fields.adapter_type ?? null,
					fields.runner_model ?? null,
					fields.dispatch_model ?? null,
					fields.design_backend ?? null,
					fields.ponytail_condition ?? null,
					fields.skill_framework_mode ?? null,
					fields.skill_framework_mode_via ?? null,
					fields.run_attempt ?? null,
					fields.retry_predecessor ?? null,
					fields.retry_successor ?? null,
					fields.issue_labels ?? null,
					fields.pr_number ?? null,
					fields.session_stage ?? null,
					fields.stage_updated_at ?? null,
					fields.session_role ?? null,
					fields.doc_tier ?? null,
					fields.issue_url ?? null,
					// FLY-793 (Step 11): set-once at INSERT; immutable via omission from
					// the ON CONFLICT update (see the sibling upsert above).
					fields.chat_thread_role ?? "main",
					fields.workflow_node_id ?? null,
				],
			);
			this.applyTerminalTimestamp(executionId, preStatus, status);
			if (enteringAwaitingReview) {
				this.stampAwaitingReviewEntry(executionId);
			}
			if (preStatus !== undefined && preStatus !== status) {
				this.bumpLifecycleRevision(executionId);
			}
		});
		this.save();
	}

	/**
	 * FLY-191 Phase 2: true when this write moves the session INTO
	 * awaiting_review from a different (or no) prior status. A same-status
	 * re-upsert must NOT count — that would drift the review deadline
	 * (Codex R1 MEDIUM-6: approval attempts / feedback / keepalives must not
	 * extend the 48h window). A genuine re-entry (changes_requested →
	 * re-request review) DOES count and resets the deadline by design.
	 */
	private isEnteringAwaitingReview(
		executionId: string,
		newStatus: string,
	): boolean {
		if (newStatus !== "awaiting_review") return false;
		return this.getSession(executionId)?.status !== "awaiting_review";
	}

	/**
	 * Stamp the awaiting_review entry time + clear the gate_timed_out dedup
	 * stamp (a fresh entry opens a fresh review window — a new timeout
	 * notification is allowed for it).
	 */
	private stampAwaitingReviewEntry(executionId: string): void {
		this.db.run(
			`UPDATE sessions SET
				awaiting_review_entered_at = datetime('now'),
				gate_timeout_notified_at = NULL
			 WHERE execution_id = ?`,
			[executionId],
		);
	}

	/**
	 * FLY-191 Phase 2: explicit review-window reset for a RE-REQUEST while the
	 * session is already awaiting_review (changes_requested → runner re-posts
	 * for review → fresh `needs_review` completion). The FSM has no
	 * awaiting_review self-loop, so the event sinks call this instead of
	 * applyTransition for that case. Event-id idempotency upstream guards
	 * against replays re-stamping.
	 */
	resetAwaitingReviewWindow(executionId: string): void {
		this.stampAwaitingReviewEntry(executionId);
		this.save();
	}

	/**
	 * Update non-status metadata fields only. Does NOT touch status.
	 * Used after applyTransition() for read-model enrichment (commit_count, lines_added, etc.)
	 * GEO-158: separates status writes (FSM) from metadata writes (event-route).
	 */
	patchSessionMetadata(
		executionId: string,
		fields: Partial<Omit<SessionUpsert, "status" | "design_backend">>,
	): void {
		const setClauses: string[] = [];
		const values: (string | number | null)[] = [];

		const fieldMap: Record<string, keyof typeof fields> = {
			issue_id: "issue_id",
			project_name: "project_name",
			issue_identifier: "issue_identifier",
			issue_title: "issue_title",
			started_at: "started_at",
			last_activity_at: "last_activity_at",
			tmux_session: "tmux_session",
			worktree_path: "worktree_path",
			branch: "branch",
			last_error: "last_error",
			decision_route: "decision_route",
			decision_reasoning: "decision_reasoning",
			cost_usd: "cost_usd",
			commit_count: "commit_count",
			files_changed: "files_changed",
			lines_added: "lines_added",
			lines_removed: "lines_removed",
			summary: "summary",
			diff_summary: "diff_summary",
			commit_messages: "commit_messages",
			changed_file_paths: "changed_file_paths",
			session_params: "session_params",
			heartbeat_at: "heartbeat_at",
			adapter_type: "adapter_type",
			// FLY-728: resolved runner model (per-issue model routing visibility).
			runner_model: "runner_model",
			dispatch_model: "dispatch_model",
			ponytail_condition: "ponytail_condition",
			skill_framework_mode: "skill_framework_mode",
			skill_framework_mode_via: "skill_framework_mode_via",
			run_attempt: "run_attempt",
			retry_predecessor: "retry_predecessor",
			retry_successor: "retry_successor",
			issue_labels: "issue_labels",
			pr_number: "pr_number",
			session_stage: "session_stage",
			stage_updated_at: "stage_updated_at",
			// FLY-137 Phase 5: agent dispatch + Codex auto-trigger persistence
			agent_name: "agent_name",
			agent_match_method: "agent_match_method",
			plan_path: "plan_path",
			codex_skip: "codex_skip",
			// FLY-191 Phase 2: PR head binding for verify-approval (§5.5.2)
			pr_head_sha: "pr_head_sha",
			// FLY-205: doc-flow tier + Linear URL (retry continuity)
			doc_tier: "doc_tier",
			issue_url: "issue_url",
			// FLY-793 (Step 11): persisted chat-thread role (set at start).
			chat_thread_role: "chat_thread_role",
			// FLY-598: founder-facing UX gate flag + sign-off record + mode snapshot
			founder_facing_ux: "founder_facing_ux",
			founder_ux_signoff_json: "founder_ux_signoff_json",
			founder_ux_gate_mode: "founder_ux_gate_mode",
			// FLY-869: QA-required snapshot + merge_block park marker + codex-hold anchor
			qa_required: "qa_required",
			qa_required_reason: "qa_required_reason",
			merge_block_reason: "merge_block_reason",
			merge_block_head: "merge_block_head",
			merge_block_at: "merge_block_at",
		};

		for (const [col, key] of Object.entries(fieldMap)) {
			if (fields[key] !== undefined) {
				setClauses.push(`${col} = ?`);
				values.push(fields[key] as string | number | null);
			}
		}

		if (setClauses.length === 0) return;

		values.push(executionId);
		this.db.run(
			`UPDATE sessions SET ${setClauses.join(", ")} WHERE execution_id = ?`,
			values,
		);
		this.save();
	}

	/**
	 * @deprecated Use applyTransition() with FSM instead. Will be removed in v1.3.0.
	 */
	forceStatus(
		executionId: string,
		status: string,
		lastActivityAt: string,
		lastError?: string,
	): void {
		// FLY-191 Phase 2: same entry-stamp semantics as persistTransition.
		const enteringAwaitingReview = this.isEnteringAwaitingReview(
			executionId,
			status,
		);
		// FLY-245 D-a: bump lifecycle revision on a forced status change too (this
		// legacy path must not be a hole in the freshness counter — plan §5.1).
		const preStatus = this.getSession(executionId)?.status;
		// FLY-663 §2.8: forced status + awaiting_review stamp + lifecycle bump are
		// one logical mutation — wrap so no durable partial state on a mid throw.
		this.db.transaction(() => {
			this.db.run(
				`UPDATE sessions SET status = ?, last_activity_at = ?, last_error = ? WHERE execution_id = ?`,
				[status, lastActivityAt, lastError ?? null, executionId],
			);
			this.applyTerminalTimestamp(executionId, preStatus, status);
			if (enteringAwaitingReview) {
				this.stampAwaitingReviewEntry(executionId);
			}
			if (preStatus !== undefined && preStatus !== status) {
				this.bumpLifecycleRevision(executionId);
			}
		});
		this.save();
	}

	setRetrySuccessor(executionId: string, successorId: string): void {
		this.db.run(
			"UPDATE sessions SET retry_successor = ? WHERE execution_id = ?",
			[successorId, executionId],
		);
		this.save();
	}

	// ── FLY-245 D2: retry dispatch intent WAL (plan §5.2.1) ──────────────────

	/**
	 * Durably bind a gateway request id to its pre-bound successor execution id
	 * BEFORE dispatch. Throws on a duplicate request id (the PRIMARY KEY is the
	 * exactly-one-successor guarantee — callers check `getRetryDispatchIntent`
	 * first and treat an existing different binding as a conflict).
	 */
	recordRetryDispatchIntent(
		requestId: string,
		successorExecutionId: string,
		predecessorExecutionId: string,
	): void {
		this.db.run(
			`INSERT INTO retry_dispatch_intents
			 (request_id, successor_execution_id, predecessor_execution_id, state)
			 VALUES (?, ?, ?, 'intent')`,
			[requestId, successorExecutionId, predecessorExecutionId],
		);
		this.save();
	}

	getRetryDispatchIntent(requestId: string): RetryDispatchIntent | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM retry_dispatch_intents WHERE request_id = ?",
		);
		stmt.bind([requestId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as unknown as RetryDispatchIntent;
			stmt.free();
			return row;
		}
		stmt.free();
		return undefined;
	}

	/** Mark the intent as dispatched (blueprint.run() kicked off). Informational
	 * only — recovery reconciles against authoritative started evidence, never
	 * this flag (plan §5.2.1 item 4). */
	markRetryDispatchDispatched(requestId: string): void {
		this.db.run(
			"UPDATE retry_dispatch_intents SET state = 'dispatched', updated_at = datetime('now') WHERE request_id = ?",
			[requestId],
		);
		this.save();
	}

	getSession(executionId: string): Session | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE execution_id = ?",
		);
		stmt.bind([executionId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	getSessionByIssue(issueId: string): Session | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_id = ? ORDER BY last_activity_at DESC LIMIT 1",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	/**
	 * FLY-1356 (R1#4): sticky-stamp lookup — the most recently recorded
	 * skill-framework arm for an issue. The hash only fires on an issue's FIRST
	 * admission; every later dispatch (retry / successor / re-dispatch) rides
	 * this stamp so identifier-source instability (UUID vs FLY-XXXX) can never
	 * split one issue across arms. Garbage column values are ignored
	 * (fail-closed to "no stamp" → resolver falls through normally).
	 */
	getSkillFrameworkStamp(issueId: string): SkillFrameworkMode | undefined {
		const stmt = this.db.prepare(
			"SELECT skill_framework_mode FROM sessions WHERE issue_id = ? AND skill_framework_mode IS NOT NULL ORDER BY last_activity_at DESC LIMIT 1",
		);
		stmt.bind([issueId]);
		let mode: unknown;
		if (stmt.step()) {
			mode = (stmt.getAsObject() as Record<string, unknown>)
				.skill_framework_mode;
		}
		stmt.free();
		return isSkillFrameworkMode(mode) ? mode : undefined;
	}

	/** FLY-1185 (Codex R2#4) — EVERY session in a non-terminal status
	 * (pending/design_done/blocked/failed included): the D-entry residue
	 * union must see thread-less issues in ANY live state, not just the
	 * running/awaiting trio. */
	/** FLY-1185 (Codex R3#4 + R4#6) — TERMINAL sessions that still hold ANY
	 * residue trace: git metadata (worktree path / branch) OR a live target
	 * (tmux_session — legacy sessions that went terminal before worktree_ready
	 * keep a window but no git columns). The D residue union must see every
	 * "issue done但现场没归零" husk that has neither a thread nor a live
	 * status. */
	listTerminalSessionsWithResidue(): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE status IN
			 ('completed','terminated','rejected','deferred','shelved','approved','timeout')
			 AND (worktree_path IS NOT NULL AND worktree_path != ''
			      OR branch IS NOT NULL AND branch != ''
			      OR tmux_session IS NOT NULL AND tmux_session != '')`,
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	listNonTerminalSessions(): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE status NOT IN
			 ('completed','terminated','rejected','deferred','shelved','approved','timeout')`,
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-1329 (A3): every status a runner can be PARKED at, for boot re-adopt.
	 *
	 * Re-adopt used to filter `status === "running"`. Under keep-alive that is the
	 * one status the parking roles are NOT in: phase-orchestrator's HANDOFF_STATUS
	 * parks design at `design_done` and implement at `awaiting_review`, and
	 * `design_done` is not even in `getActiveSessions`. So the roles that park were
	 * exactly the roles re-adopt could not see — in the FLY-1319 restart, the QA
	 * session was re-adopted and the parked implement was not, which is not luck,
	 * it is the query.
	 *
	 * Terminal statuses are excluded: re-adopting one would resurrect the dead.
	 *
	 * Deliberately a NEW query rather than a widened `getActiveSessions` — that
	 * one's existing callers depend on its exact set.
	 */
	getReadoptCandidateSessions(): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status IN ('running', 'awaiting_review', 'design_done', 'approved_to_ship')",
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	getActiveSessions(): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status IN ('running', 'awaiting_review', 'approved_to_ship')",
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/** FLY-1279 D2: bounded semantic park inventory (includes truthful blocked). */
	listParkWatchSessions(): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE status IN ('running','awaiting_review','approved_to_ship','blocked')
			 ORDER BY execution_id`,
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-793 (Codex R1+R2): a same-issue session that OCCUPIES the shared branch-B
	 * worktree — so a fresh three-stage re-dispatch here must be rejected, or it
	 * would start a second phase and (via Blueprint.removeIfExists on the same
	 * shared-branch key) tear away the running phase's worktree instead of failing
	 * closed. Two disjuncts:
	 *
	 *   (a) a started PHASE session — `design`/`implement`/`qa` role in a
	 *       branch-B-holding status (`running`/`awaiting_review`/`approved_to_ship`/
	 *       `design_done`; `design_done` = the possibly-restart-spanning handoff
	 *       window where the design worktree still exists for capturePhaseHeadSha).
	 *   (b) a `pending` row that ALREADY holds a worktree (Codex R2): `worktree_ready`
	 *       is reliable while `session_started` is fire-and-forget, so a durable
	 *       `pending` + `worktree_path` row can exist BEFORE the phase role is
	 *       persisted (role is written at `session_started`). This window survives a
	 *       Bridge restart and is exactly when the inflight-map dedup is also gone —
	 *       so match it by the created worktree, NOT by role. `listWorktreeProtection
	 *       Sessions` already treats `pending` as protected; this closes the same
	 *       hole for re-dispatch deletion. The entry guard only runs when the project
	 *       has three_stage ON (a fresh `main` that just entered), so a same-issue
	 *       pending worktree is a phase (or a stale pre-flip row) — rejecting is safe.
	 *
	 * Returns the first match (single-writer invariant).
	 */
	/**
	 * FLY-793 (Codex full-PR R2 #1): all Design phase-sessions stuck at design_done.
	 * The boot complete-marker drain replays a `phase_design_complete` marker BEFORE
	 * the PhaseOrchestrator is wired, so the session lands at design_done without the
	 * Design→Implement handoff firing. The orchestrator's startup reconcile re-drives
	 * these (idempotent: onPhaseComplete re-gates on status===design_done).
	 */
	getStrandedDesignPhaseSessions(): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE session_role = 'design' AND status = 'design_done'",
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-939 (G-A2): implement phase-sessions stranded at awaiting_review —
	 * candidates for the startup reconcile of a lost implement→QA handoff (a crash
	 * / wake-fail between the implement completing needs_review and QA being
	 * spawned). `chat_thread_role='implement'` excludes single-session ('main')
	 * awaiting_review rows; the orchestrator further guards on "no qa row + no ship
	 * claim" before re-driving. Mirrors getStrandedDesignPhaseSessions' shape.
	 */
	getStrandedImplementPhaseSessions(): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE session_role = 'implement' AND status = 'awaiting_review' AND chat_thread_role = 'implement'",
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-859: implement-phase count for an issue (three-stage fix-loop round
	 * cap). `chat_thread_role` is the durable three-stage marker (Blueprint
	 * writes the phase role ONLY for shareParentBranch phase sessions), so this
	 * counts the initial Implement phase plus every Implement-fix round —
	 * auto-QA and single-session runs never carry a non-main value.
	 */
	countSessionsByIssueAndChatThreadRole(issueId: string, role: string): number {
		const stmt = this.db.prepare(
			"SELECT COUNT(*) AS n FROM sessions WHERE issue_id = ? AND chat_thread_role = ?",
		);
		stmt.bind([issueId, role]);
		const n = stmt.step()
			? Number((stmt.getAsObject() as Record<string, unknown>).n ?? 0)
			: 0;
		stmt.free();
		return n;
	}

	/**
	 * FLY-859 reconcile sweep (a): three-stage QA phase sessions that have at
	 * least one stored `qa_result` event. The PhaseOrchestrator compares each
	 * session's latest stored verdict event against its durable
	 * `three_stage_verdict` intent and replays the ones a crash left
	 * inserted-but-unprocessed (the `/events` insert→coordinator window).
	 */
	getThreeStageQaSessionsWithVerdictEvents(): Session[] {
		const stmt = this.db.prepare(
			`SELECT s.* FROM sessions s
			 WHERE s.chat_thread_role = 'qa'
			   AND EXISTS (SELECT 1 FROM session_events e
			               WHERE e.execution_id = s.execution_id
			                 AND e.event_type = 'qa_result')`,
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-859 reconcile sweep (c): terminal three-stage QA phase sessions
	 * carrying a verdict intent — candidates for the stranded-pass alert
	 * (reported PASS but never opened the ship gate; the FLY-849 §3.8 silent
	 * break). Coarse SQL filter; the orchestrator does the precise
	 * intent/binding checks after parsing session_params. FLY-1050:
	 * `terminated` joins the terminal set (root cause ③ — a terminated
	 * stranded-pass QA, the FLY-967 shape, was invisible to the boot sweep).
	 */
	getStrandedThreeStageQaPassSessions(): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE chat_thread_role = 'qa'
			   AND status IN ('completed', 'failed', 'terminated')
			   AND session_params LIKE '%three_stage_verdict%'`,
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-859: latest stored `qa_result` event for an execution (reconcile
	 * sweep (a) — replay source for inserted-but-unprocessed verdicts).
	 */
	getLatestQaResultEventForExecution(
		executionId: string,
	): { eventId: string; payload?: Record<string, unknown> } | undefined {
		const stmt = this.db.prepare(
			`SELECT event_id, payload FROM session_events
			 WHERE execution_id = ? AND event_type = 'qa_result'
			 ORDER BY id DESC LIMIT 1`,
		);
		stmt.bind([executionId]);
		const row = stmt.step()
			? (stmt.getAsObject() as Record<string, unknown>)
			: undefined;
		stmt.free();
		if (!row) return undefined;
		return {
			eventId: row.event_id as string,
			payload: row.payload
				? (JSON.parse(row.payload as string) as Record<string, unknown>)
				: undefined,
		};
	}

	getActivePhaseSessionForIssue(issueId: string): Session | undefined {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE issue_id = ?
			   AND (
			     (session_role IN ('design', 'implement', 'qa')
			        AND status IN ('running', 'awaiting_review', 'approved_to_ship', 'design_done'))
			     OR (status = 'pending' AND worktree_path IS NOT NULL AND worktree_path != '')
			   )
			 ORDER BY last_activity_at DESC LIMIT 1`,
		);
		stmt.bind([issueId]);
		const found = stmt.step()
			? this.rowToSession(stmt.getAsObject() as Record<string, unknown>)
			: undefined;
		stmt.free();
		return found;
	}

	/**
	 * FLY-887: ALL three-stage phase sessions for an issue (design/implement/qa by
	 * the durable `chat_thread_role` marker), any status, newest first. The
	 * ship-time finalizer filters these to the parked design + implement sessions
	 * it must close; the keep-alive orchestrator filters by role + alive status to
	 * find a wake target. Single-session / auto-QA rows (`chat_thread_role='main'`)
	 * are never returned, so a non-three-stage issue yields `[]` (no-op downstream).
	 */
	getPhaseSessionsForIssue(issueId: string): Session[] {
		const stmt = this.db.prepare(
			// FLY-939 (Codex design R1 #2): a `rowid DESC` tiebreak makes the order
			// deterministic when two rows share last_activity_at — the G-C ghost guard
			// probes "the most-recent N rows", so ties must resolve stably (newest
			// rowid = most-recently inserted). Byte-compat for the common distinct-
			// timestamp case; only disambiguates exact ties (freshest-first preserved).
			`SELECT * FROM sessions
			 WHERE issue_id = ?
			   AND chat_thread_role IN ('design', 'implement', 'qa')
			 ORDER BY last_activity_at DESC, rowid DESC`,
		);
		stmt.bind([issueId]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-1204: candidate PRE-SCREEN for the periodic parked-phase reclaim patrol
	 * (a status/role coarse filter only, NOT the reclaim decision). It returns
	 * three-stage phase rows (chat_thread_role IN design/implement/qa) whose status
	 * is in the keep-alive-reclaimable set:
	 *   - `design_done` — a parked Design phase (kept as the design-context holder);
	 *   - `awaiting_review` / `approved_to_ship` — a parked Implement/QA phase;
	 *   - `running` — a QA FAIL fix-loop parks with status still `running`
	 *     (the HeartbeatService verdict layer separates "parked running" from
	 *     "actively working" via the CommDB declared_state);
	 *   - `completed` — a shipped QA phase that leaked alive (the primary defect).
	 * Terminal non-candidate states (failed/blocked/terminated/rejected/deferred/
	 * shelved) are excluded. Whether a candidate is REALLY parked + safe to reclaim
	 * is decided in HeartbeatService (declared_state + probe + ship-claim guard) —
	 * this only narrows the set to verify (Codex R1 BLOCKER-1: status ≠ parked, and
	 * keep-alive OFF still produces phase rows at handoff).
	 */
	getParkedPhaseCandidates(): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE chat_thread_role IN ('design', 'implement', 'qa')
			   AND status IN ('design_done', 'completed', 'awaiting_review',
			                  'approved_to_ship', 'running')
			 ORDER BY last_activity_at DESC, rowid DESC`,
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-887: durable, replay-idempotent event count for an issue + type — the
	 * fix-round ledger source. A three-stage QA FAIL no longer spawns a NEW
	 * implement session (the parked one is woken to fix), so the FLY-859
	 * session-count round accounting no longer grows; the round is instead an
	 * idempotent `three_stage_fix_round` event per QA verdict. `insertEvent`'s
	 * UNIQUE(event_id) dedup means a replayed verdict never double-counts.
	 */
	countEventsByIssueAndType(issueId: string, eventType: string): number {
		const stmt = this.db.prepare(
			"SELECT COUNT(*) AS n FROM session_events WHERE issue_id = ? AND event_type = ?",
		);
		stmt.bind([issueId, eventType]);
		const n = stmt.step()
			? Number((stmt.getAsObject() as Record<string, unknown>).n ?? 0)
			: 0;
		stmt.free();
		return n;
	}

	/**
	 * FLY-887: the parsed JSON payload of a single event by its event_id, or
	 * undefined. Backs `recordFixRound`'s insert-or-read: after an `insertEvent`
	 * loses the UNIQUE(event_id) race (returns false), the winner's recorded
	 * round is read back from here so a crash-replay resumes round N.
	 */
	getEventPayloadById(eventId: string): Record<string, unknown> | undefined {
		const stmt = this.db.prepare(
			"SELECT payload FROM session_events WHERE event_id = ? LIMIT 1",
		);
		stmt.bind([eventId]);
		const row = stmt.step()
			? (stmt.getAsObject() as Record<string, unknown>)
			: undefined;
		stmt.free();
		if (!row || row.payload == null) return undefined;
		try {
			return JSON.parse(row.payload as string) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}

	/**
	 * FLY-1314: immutable predecessor ledger for a three-stage QA FAIL round.
	 * The event id is derived from the verdict event, so crash replay is
	 * idempotent and can never overwrite the original round/head causality.
	 */
	recordThreeStageVerdictHead(args: {
		qaExecutionId: string;
		issueId: string;
		projectName: string;
		verdictEventId: string;
		round: number;
		verdictHead: string;
	}): boolean {
		return this.insertEvent({
			event_id: `three-stage-verdict-head-${args.verdictEventId}`,
			execution_id: args.qaExecutionId,
			issue_id: args.issueId,
			project_name: args.projectName,
			event_type: "three_stage_verdict_head",
			source: "bridge.phase-orchestrator",
			payload: {
				issueId: args.issueId,
				qaExecId: args.qaExecutionId,
				verdictEventId: args.verdictEventId,
				round: args.round,
				verdictHead: args.verdictHead.toLowerCase(),
			},
		});
	}

	/**
	 * Minimal-safe predecessor selection: exactly one immutable mapping for this
	 * QA execution + issue is unambiguous. Multiple rounds, malformed payloads,
	 * or cross-issue rows fail open (null) so the caller runs QA again.
	 */
	getUnambiguousThreeStageVerdictHead(
		qaExecutionId: string,
		issueId: string,
	): {
		verdictEventId: string;
		round: number;
		verdictHead: string;
	} | null {
		const stmt = this.db.prepare(
			`SELECT payload FROM session_events
			 WHERE execution_id = ? AND issue_id = ?
			   AND event_type = 'three_stage_verdict_head'
			 ORDER BY id LIMIT 2`,
		);
		stmt.bind([qaExecutionId, issueId]);
		const payloads: unknown[] = [];
		while (stmt.step()) {
			payloads.push((stmt.getAsObject() as Record<string, unknown>).payload);
		}
		stmt.free();
		if (payloads.length !== 1 || typeof payloads[0] !== "string") return null;
		try {
			const payload = JSON.parse(payloads[0]) as Record<string, unknown>;
			if (
				payload.issueId !== issueId ||
				payload.qaExecId !== qaExecutionId ||
				typeof payload.verdictEventId !== "string" ||
				!Number.isInteger(payload.round) ||
				(payload.round as number) <= 0 ||
				typeof payload.verdictHead !== "string" ||
				!/^[0-9a-f]{40}$/.test(payload.verdictHead)
			) {
				return null;
			}
			return {
				verdictEventId: payload.verdictEventId,
				round: payload.round as number,
				verdictHead: payload.verdictHead,
			};
		} catch {
			return null;
		}
	}

	/**
	 * FLY-892 (Step 4): for the converged pipeline header, the LATEST session of
	 * each three-stage phase role (design/implement/qa) on `issueId`. Keyed on
	 * `chat_thread_role` (the persistent three-stage phase marker), NOT
	 * `session_role`, so it also captures phase sessions after terminal status.
	 *
	 * "Latest" = `last_activity_at DESC` with a stable `rowid DESC` tiebreak
	 * (Codex R1 #4): an implement fix-loop spawns several implement sessions — the
	 * header must always point at the most recent one, never a stale exec's attach
	 * command. Returns at most 3 rows (one per phase actually started); phases not
	 * yet started are absent (the caller renders them as ⬜ planned).
	 *
	 * FLY-887 R2 merge: RENAMED from `getPhaseSessionsForIssue` — that name is now
	 * FLY-887's all-status/all-rows query (keep-alive wake target + ship finalizer).
	 * The pipeline header needs exactly the latest row per role, so it keeps its own
	 * query under a distinct name; both semantics survive the merge.
	 */
	getLatestPhaseSessionsForIssue(issueId: string): Session[] {
		const out: Session[] = [];
		for (const role of ["design", "implement", "qa"] as const) {
			const stmt = this.db.prepare(
				`SELECT * FROM sessions
				 WHERE issue_id = ? AND chat_thread_role = ?
				 ORDER BY last_activity_at DESC, rowid DESC LIMIT 1`,
			);
			stmt.bind([issueId, role]);
			if (stmt.step()) {
				out.push(
					this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
				);
			}
			stmt.free();
		}
		return out;
	}

	/**
	 * FLY-603 Layer B: sessions whose worktree must NOT be reconciled — the
	 * protected status set for a project. `pending` IS included: it is a real
	 * persisted status (schema default; `worktree_ready` upserts a pending
	 * session before `session_started`). Returns rows; the path-authoritative
	 * key derivation happens at composition level (it needs WorktreeManager).
	 */
	listWorktreeProtectionSessions(projectName: string): Session[] {
		const stmt = this.db.prepare(
			// FLY-793: `design_done` protects a completed Design phase's shared
			// branch-B worktree from the reconciler during the (possibly
			// restart-spanning) handoff window — capturePhaseHeadSha still needs it.
			"SELECT * FROM sessions WHERE project_name = ? AND status IN ('running', 'awaiting_review', 'approved_to_ship', 'pending', 'design_done')",
		);
		stmt.bind([projectName]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-603 Layer B: all sessions for a project (any status) — candidates for
	 * the independent live-runner probe (a terminal session with a still-live
	 * tmux must keep its worktree).
	 */
	getProjectSessions(projectName: string): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE project_name = ?",
		);
		stmt.bind([projectName]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/** FLY-1082 (Task 2.3): ALL running sessions — the server-loss coordinator's
	 * candidate set (heartbeat-independent: a server death is detected the tick
	 * it happens, not after the orphan staleness window). */
	getRunningSessions(): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status = 'running'",
		);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	getStuckSessions(thresholdMinutes: number): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status = 'running' AND last_activity_at < datetime('now', ?)",
		);
		stmt.bind([`-${thresholdMinutes} minutes`]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-191 Phase 2: awaiting_review sessions whose review window has
	 * expired and that have NOT yet been notified for the current entry.
	 * Anchored on the persisted `awaiting_review_entered_at` (survives Bridge
	 * restarts; never drifted by activity). `gate_timeout_notified_at` is
	 * cleared on every fresh entry (stampAwaitingReviewEntry), so a plain
	 * IS NULL check dedups exactly once per review window. Rows with a NULL
	 * entry timestamp (pre-migration legacy) are excluded — no anchor means
	 * no deadline claim (fail-quiet, they age out via existing patrols).
	 */
	getAwaitingReviewTimedOut(thresholdHours: number): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE status = 'awaiting_review'
			   AND awaiting_review_entered_at IS NOT NULL
			   AND awaiting_review_entered_at < datetime('now', ?)
			   AND gate_timeout_notified_at IS NULL`,
		);
		stmt.bind([`-${thresholdHours} hours`]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/** FLY-191 Phase 2: dedup stamp — gate_timed_out notified for the current awaiting_review entry. */
	markGateTimeoutNotified(executionId: string): void {
		this.db.run(
			"UPDATE sessions SET gate_timeout_notified_at = datetime('now') WHERE execution_id = ?",
			[executionId],
		);
		this.save();
	}

	/**
	 * FLY-191 Phase 2 (Codex PR R1 CRITICAL + HIGH-2; R2 HIGH-1): bind the
	 * session to its CURRENT review request. Called on EVERY needs_review
	 * completion arriving via the HTTP /events path with whatever the event
	 * carried — NEVER retaining a previous review's binding (a stale
	 * questionId/pr_head_sha surviving a re-review is exactly the §5.5
	 * fail-closed contract violation).
	 *
	 * Tri-state `review_question_id` (Codex R2 HIGH-1):
	 *   - real id  → Phase-2 review, approvable only on that exact question;
	 *   - 'unbound' (REVIEW_BINDING_UNBOUND) → a Phase-2 completion arrived
	 *     WITHOUT a usable questionId. Approval paths REFUSE (the runner
	 *     can never verify-approval) — the runner must re-request review
	 *     with `--question-id`. Without this sentinel, a binding-less
	 *     Phase-2 session would fall into the legacy branch below and get
	 *     stranded in approved_to_ship.
	 *   - NULL → true pre-Phase-2 legacy session (this method never ran):
	 *     legacy blocking-gate approve fallback stays byte-compatible.
	 */
	setReviewBinding(
		executionId: string,
		binding: { questionId: string | null; prHeadSha: string | null },
	): void {
		this.db.run(
			"UPDATE sessions SET review_question_id = ?, pr_head_sha = ? WHERE execution_id = ?",
			[
				binding.questionId ?? REVIEW_BINDING_UNBOUND,
				binding.prHeadSha,
				executionId,
			],
		);
		this.save();
	}

	/**
	 * FLY-945 Fix B: update ONLY the reviewed head of a session that is still
	 * `awaiting_review` — the ship-gate rebind after a QA-evidence commit moved
	 * the PR head forward (`git merge-base --is-ancestor` verified by the
	 * caller). The `review_question_id` binding is intentionally untouched (the
	 * gate question does not rotate on a rebind). The status guard is in the
	 * WHERE clause so a concurrent approval flip (awaiting_review →
	 * approved_to_ship) makes this a no-op instead of retargeting a decided
	 * gate. Returns true iff the row was updated.
	 */
	setSessionPrHeadShaForRebind(
		executionId: string,
		prHeadSha: string,
	): boolean {
		this.db.run(
			"UPDATE sessions SET pr_head_sha = ? WHERE execution_id = ? AND status = 'awaiting_review'",
			[prHeadSha, executionId],
		);
		const updated = this.db.getRowsModified() > 0;
		this.save();
		return updated;
	}

	getSessionByIdentifier(identifier: string): Session | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_identifier = ? ORDER BY last_activity_at DESC LIMIT 1",
		);
		stmt.bind([identifier]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	/**
	 * FLY-102 Round 1 (Codex post-Round 4): Lookup all sessions for an identifier
	 * whose status is in the caller-supplied set. Used by `close_runner` MCP tool
	 * to avoid the unstable `ORDER BY last_activity_at DESC LIMIT 1` fallback,
	 * which under retries/parallel runs can pick the wrong execution.
	 */
	getSessionsByIdentifierAndStatuses(
		identifier: string,
		statuses: readonly string[],
	): Session[] {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(",");
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE issue_identifier = ? AND status IN (${placeholders}) ORDER BY last_activity_at DESC`,
		);
		stmt.bind([identifier, ...statuses]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-795 (code-review MED-3): the latest RESUMABLE prior session for an issue
	 * AND role — the restart-resilient resume computer's candidate lookup. Precise
	 * on purpose (the plain `getSessionByIssue` LIMIT-1-by-activity would pick the
	 * wrong role's session, or a stale completed one, on a dispatcher path that runs
	 * on every start()):
	 *   - matches either the issue UUID or the Linear identifier (caller may hold
	 *     whichever), so it works regardless of which the dispatch carries;
	 *   - matches the dispatched role (a NULL/absent `session_role` counts as
	 *     "main", the default role);
	 *   - EXCLUDES terminal-success states (`completed`/`shelved`) — a merged or
	 *     intentionally-parked session must NOT be silently resumed by a new
	 *     dispatch; running / awaiting_review / terminated / failed / blocked all
	 *     remain resumable (their work is still on branch B).
	 * Returns the most recently active match, or undefined.
	 */
	getResumableSessionForIssueRole(
		issueOrIdentifier: string,
		role: string,
	): Session | undefined {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE (issue_id = ? OR issue_identifier = ?)
			   AND (session_role = ? OR (session_role IS NULL AND ? = 'main'))
			   AND status NOT IN ('completed', 'shelved')
			 ORDER BY last_activity_at DESC
			 LIMIT 1`,
		);
		stmt.bind([issueOrIdentifier, issueOrIdentifier, role, role]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	getRecentSessions(limit: number): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT ?",
		);
		stmt.bind([limit]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	getSessionHistory(issueId: string): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_id = ? ORDER BY started_at ASC",
		);
		stmt.bind([issueId]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	getLatestActionableSession(issueId: string): Session | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_id = ? AND status IN ('awaiting_review', 'blocked') ORDER BY last_activity_at DESC LIMIT 1",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	// FLY-163: upsertThread / getThreadIssue / getThreadByIssue /
	// setSessionThreadId removed — conversation_threads table dropped.

	getLatestSessionByIssueAndStatuses(
		issueId: string,
		statuses: string[],
		excludeExecutionId?: string,
	): Session | undefined {
		if (statuses.length === 0) return undefined;
		const placeholders = statuses.map(() => "?").join(", ");
		const params: string[] = [issueId, ...statuses];
		let excludeClause = "";
		if (excludeExecutionId) {
			excludeClause = " AND execution_id != ?";
			params.push(excludeExecutionId);
		}
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE issue_id = ? AND status IN (${placeholders})${excludeClause} ORDER BY last_activity_at DESC LIMIT 1`,
		);
		stmt.bind(params);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return this.rowToSession(row);
		}
		stmt.free();
		return undefined;
	}

	/** GEO-259: Get all sessions for an issue matching given statuses, ordered by last_activity_at DESC. */
	getSessionsByIssueAndStatuses(
		issueId: string,
		statuses: string[],
	): Session[] {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(", ");
		const results: Session[] = [];
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE issue_id = ? AND status IN (${placeholders}) ORDER BY last_activity_at DESC`,
		);
		stmt.bind([issueId, ...statuses]);
		while (stmt.step()) {
			results.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return results;
	}

	getSessionsByIssue(issueId: string): Session[] {
		const results: Session[] = [];
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE issue_id = ? ORDER BY last_activity_at DESC, rowid DESC",
		);
		stmt.bind([issueId]);
		while (stmt.step()) {
			results.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return results;
	}

	/**
	 * FLY-945 Fix D: parked (awaiting_review / approved_to_ship) sessions of a
	 * project — path-1 candidates for the external-merge reconcile pass.
	 */
	listParkedSessionsForProject(projectName: string): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE project_name = ?
			   AND status IN ('awaiting_review', 'approved_to_ship')
			 ORDER BY last_activity_at ASC`,
		);
		stmt.bind([projectName]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-945 Fix D: recently-completed sessions of a project that carry a PR
	 * clue — path-2 (completed-but-unfinalized) candidates. Bounded by
	 * `sinceTs` (SQLite UTC "YYYY-MM-DD HH:MM:SS") so the sweep never digs
	 * through old history.
	 */
	listCompletedSessionsWithPrSince(
		projectName: string,
		sinceTs: string,
	): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE project_name = ?
			   AND status = 'completed'
			   AND last_activity_at >= ?
			   AND (pr_number IS NOT NULL OR pr_head_sha IS NOT NULL)
			 ORDER BY last_activity_at ASC`,
		);
		stmt.bind([projectName, sinceTs]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	getTerminalSessionsSince(sinceTs: string): Session[] {
		const placeholders = OUTCOME_STATUSES.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE status IN (${placeholders})
			 AND last_activity_at >= ?
			 ORDER BY last_activity_at DESC`,
		);
		stmt.bind([...OUTCOME_STATUSES, sinceTs]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	getRecentOutcomeSessions(limit: number): Session[] {
		const placeholders = OUTCOME_STATUSES.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			 WHERE status IN (${placeholders})
			 ORDER BY last_activity_at DESC
			 LIMIT ?`,
		);
		stmt.bind([...OUTCOME_STATUSES, limit]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/** Update heartbeat timestamp for an active execution. */
	updateHeartbeat(executionId: string): void {
		this.db.run(
			"UPDATE sessions SET heartbeat_at = datetime('now') WHERE execution_id = ?",
			[executionId],
		);
		this.save();
	}

	/** Find running sessions whose heartbeat has gone stale (orphan detection). */
	getOrphanSessions(thresholdMinutes: number): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < datetime('now', ?)",
		);
		stmt.bind([`-${thresholdMinutes} minutes`]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-1282: zombie-alert backfill backlog — failed sessions carrying the
	 * zombie declaration marker whose deterministic `zombie-<execId>` lead_event
	 * row does NOT exist yet (hard-crash residue between transition and append).
	 * SQL anti-join filters completed work BEFORE the LIMIT; stable
	 * `execution_id ASC` order behind a strict `> afterExecutionId` watermark
	 * gives fair wrap-around rotation (Codex R5 #3 / R6 #4 / R7 #4).
	 */
	getZombieAlertBacklog(afterExecutionId: string, limit: number): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions s
			 WHERE s.status = 'failed'
			   AND s.last_error LIKE 'zombie: %'
			   AND s.execution_id > ?
			   AND NOT EXISTS (
			     SELECT 1 FROM lead_events le
			     WHERE le.event_id = 'zombie-' || s.execution_id
			   )
			 ORDER BY s.execution_id ASC
			 LIMIT ?`,
		);
		stmt.bind([afterExecutionId, limit]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/** GEO-270: Get sessions in terminal state (completed/failed/blocked) with stale activity. */
	getStaleCompletedSessions(thresholdHours: number): Session[] {
		const stmt = this.db.prepare(
			"SELECT * FROM sessions WHERE status IN ('completed', 'failed', 'blocked') AND last_activity_at < datetime('now', ?)",
		);
		stmt.bind([`-${thresholdHours} hours`]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-725: main-session ZERO-SIGNAL terminal milestones (failed/blocked) for ONE
	 * project that recently reached that state — the milestone-report patrol
	 * candidate set. `completed` is intentionally excluded (routine completions go
	 * to the FLY-727 digest, not a real-time ping; Annie 2026-07-01 plan §B).
	 * `project_name` is filtered at the SQL boundary (Codex R1 #2: `matchesLead`
	 * alone is not a project boundary — two projects can reuse a lead id). QA runners
	 * (`session_role != 'main'`) are excluded — they produce no founder-facing
	 * milestone. `lookbackHours` bounds the scan window so the patrol does not walk
	 * the entire session history each tick.
	 */
	getRecentTerminalSessionsForNotify(
		projectName: string,
		lookbackHours: number,
	): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions
			  WHERE project_name = ?
			    AND status IN ('failed', 'blocked')
			    AND (session_role IS NULL OR session_role = 'main')
			    AND last_activity_at > datetime('now', ?)`,
		);
		stmt.bind([projectName, `-${lookbackHours} hours`]);
		const rows: Session[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToSession(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	/** Retrieve parsed session_params for a given execution. */
	getSessionParams(executionId: string): Record<string, unknown> | undefined {
		const stmt = this.db.prepare(
			"SELECT session_params FROM sessions WHERE execution_id = ?",
		);
		stmt.bind([executionId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			const raw = row.session_params as string | null;
			if (raw) {
				return JSON.parse(raw) as Record<string, unknown>;
			}
			return undefined;
		}
		stmt.free();
		return undefined;
	}

	/** Retrieve parsed issue_labels for a given execution (GEO-152). */
	getSessionLabels(executionId: string): string[] {
		const session = this.getSession(executionId);
		if (!session?.issue_labels) return [];
		try {
			return JSON.parse(session.issue_labels) as string[];
		} catch {
			// Fallback: comma-separated
			return session.issue_labels
				.split(",")
				.map((l) => l.trim())
				.filter(Boolean);
		}
	}

	/** Store session_params as JSON for a given execution. */
	setSessionParams(executionId: string, params: Record<string, unknown>): void {
		this.db.run(
			"UPDATE sessions SET session_params = ? WHERE execution_id = ?",
			[JSON.stringify(params), executionId],
		);
		this.save();
	}

	/** Get the most recent session_params + run_attempt for an issue (for session recovery). */
	getLatestSessionParams(
		issueId: string,
	):
		| { sessionParams: Record<string, unknown>; runAttempt: number }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT session_params, run_attempt FROM sessions WHERE issue_id = ? AND session_params IS NOT NULL ORDER BY last_activity_at DESC LIMIT 1",
		);
		stmt.bind([issueId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			const raw = row.session_params as string | null;
			if (raw) {
				return {
					sessionParams: JSON.parse(raw) as Record<string, unknown>,
					runAttempt: (row.run_attempt as number) ?? 0,
				};
			}
			return undefined;
		}
		stmt.free();
		return undefined;
	}

	// FLY-163: forum thread cleanup methods (getEligibleForCleanup, markArchived,
	// markCleanupNotified, clearArchived, markDiscordMissing) removed — forum
	// channel concept gone.

	// --- FLY-91: Chat thread CRUD (per-issue threads in chatChannel) ---

	/**
	 * Delete-first upsert (same pattern as upsertThread for Forum).
	 *
	 * FLY-892 (converge): one issue = one thread. Every caller — a Lead `/send`, a
	 * design/implement/qa phase session, gate-poller, heartbeat — resolves the SAME
	 * `(issue, channel)` row in `chat_threads`. The FLY-793 per-phase side-table
	 * (`phase_chat_threads`) is no longer written; the `session_role` phase marker
	 * lives on `sessions.chat_thread_role` and is rendered as a message prefix /
	 * pipeline-header row, not a separate thread. Legacy phase rows remain
	 * READ-ONLY (reverse-lookup + boot-sweep archive).
	 */
	upsertChatThread(
		threadId: string,
		channelId: string,
		issueId: string,
		leadId?: string,
	): void {
		// FLY-663 §2.8: delete-stale-then-upsert is one logical mutation — wrap so a
		// crash between the DELETE and the INSERT can't leave the issue thread-less.
		this.db.transaction(() => {
			this.db.run(
				"DELETE FROM chat_threads WHERE issue_id = ? AND channel_id = ? AND thread_id != ?",
				[issueId, channelId, threadId],
			);
			this.db.run(
				`INSERT INTO chat_threads (thread_id, channel_id, issue_id, lead_id)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(thread_id) DO UPDATE SET
					channel_id = excluded.channel_id,
					issue_id = excluded.issue_id,
					lead_id = excluded.lead_id`,
				[threadId, channelId, issueId, leadId ?? null],
			);
		});
		this.save();
	}

	// ── FLY-579 P1: auto-QA record CRUD ──────────────────────────────────────

	private rowToAutoQaRecord(row: Record<string, unknown>): AutoQaRecord {
		return {
			parent_execution_id: row.parent_execution_id as string,
			target_pr_head_sha: row.target_pr_head_sha as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			enrollment_source:
				(row.enrollment_source as AutoQaRecord["enrollment_source"]) ?? "auto",
			qa_execution_id: (row.qa_execution_id as string) ?? undefined,
			qa_issue_id: (row.qa_issue_id as string) ?? undefined,
			qa_issue_identifier: (row.qa_issue_identifier as string) ?? undefined,
			qa_issue_title: (row.qa_issue_title as string) ?? undefined,
			qa_issue_url: (row.qa_issue_url as string) ?? undefined,
			status: row.status as AutoQaRecord["status"],
			verdict_event_id: (row.verdict_event_id as string) ?? undefined,
			started_at: row.started_at as string,
			completed_at: (row.completed_at as string) ?? undefined,
			notified_at: (row.notified_at as string) ?? undefined,
			retest_wake_pending_at:
				(row.retest_wake_pending_at as string) ?? undefined,
			auto_retry_count: Number(row.auto_retry_count ?? 0),
			retry_intent_at: (row.retry_intent_at as string) ?? undefined,
			retry_attempt_id: (row.retry_attempt_id as string) ?? undefined,
		};
	}

	/**
	 * Atomically claim a QA record for (parent, head). Returns true if a NEW
	 * record was inserted (caller should spawn QA), false if one already exists
	 * (dedup — QA already claimed/running/done for this exact head). INSERT OR
	 * IGNORE makes the claim race-safe against concurrent awaiting_review events.
	 */
	claimAutoQaRecord(input: {
		parentExecutionId: string;
		targetPrHeadSha: string;
		issueId: string;
		projectName: string;
		enrollmentSource?: "auto" | "manual";
	}): boolean {
		this.db.run(
			`INSERT OR IGNORE INTO auto_qa_record
			   (parent_execution_id, target_pr_head_sha, issue_id, project_name, enrollment_source, status, started_at)
			 VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))`,
			[
				input.parentExecutionId,
				input.targetPrHeadSha,
				input.issueId,
				input.projectName,
				input.enrollmentSource ?? "auto",
			],
		);
		const inserted = this.db.getRowsModified() > 0;
		this.save();
		return inserted;
	}

	setAutoQaQaExecutionId(
		parentExecutionId: string,
		targetPrHeadSha: string,
		qaExecutionId: string,
	): void {
		this.db.run(
			"UPDATE auto_qa_record SET qa_execution_id = ? WHERE parent_execution_id = ? AND target_pr_head_sha = ?",
			[qaExecutionId, parentExecutionId, targetPrHeadSha],
		);
		this.save();
	}

	/**
	 * FLY-1279 B2: ownership is broader than the recovery CAS. The same QA exec
	 * may appear on historical rows, so prefer a hold-active owner and use a
	 * deterministic newest-row tiebreak. Callers use this only to decide whether
	 * a failure belongs to auto-QA; state transitions remain separately guarded.
	 */
	findAutoQaOwnershipByQaExec(qaExecutionId: string): AutoQaRecord | undefined {
		const stmt = this.db.prepare(
			`SELECT * FROM auto_qa_record
			  WHERE qa_execution_id = ?
			  ORDER BY CASE WHEN status IN
			    ('running','awaiting_retest','retry_pending','retry_starting','stuck')
			    THEN 0 ELSE 1 END,
			    started_at DESC, rowid DESC
			  LIMIT 1`,
		);
		stmt.bind([qaExecutionId]);
		let rec: AutoQaRecord | undefined;
		if (stmt.step()) {
			rec = this.rowToAutoQaRecord(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return rec;
	}

	/**
	 * Claim a dead running QA exactly once. The first death enters retry_pending;
	 * a replacement death after the one-shot budget is consumed becomes stuck.
	 */
	markDeadAutoQaExecution(
		parentExecutionId: string,
		targetPrHeadSha: string,
		deadQaExecutionId: string,
	): "retry_pending" | "exhausted" | "noop" {
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = CASE WHEN auto_retry_count = 0
			                      THEN 'retry_pending' ELSE 'stuck' END,
			        auto_retry_count = CASE WHEN auto_retry_count = 0
			                                THEN 1 ELSE auto_retry_count END,
			        retry_intent_at = CASE WHEN auto_retry_count = 0
			                               THEN datetime('now') ELSE retry_intent_at END,
			        completed_at = CASE WHEN auto_retry_count = 0
			                            THEN NULL ELSE datetime('now') END
			  WHERE parent_execution_id = ?
			    AND target_pr_head_sha = ?
			    AND qa_execution_id = ?
			    AND status = 'running'`,
			[parentExecutionId, targetPrHeadSha, deadQaExecutionId],
		);
		const changed = this.db.getRowsModified() > 0;
		this.save();
		if (!changed) return "noop";
		return this.getAutoQaRecord(parentExecutionId, targetPrHeadSha)?.status ===
			"retry_pending"
			? "retry_pending"
			: "exhausted";
	}

	/** Initial dispatcher.start() failed before a QA execution id was bound. */
	claimAutoQaRetryAfterSpawnFailure(
		parentExecutionId: string,
		targetPrHeadSha: string,
	): boolean {
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = 'retry_pending', auto_retry_count = 1,
			        retry_intent_at = datetime('now'), completed_at = NULL
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?
			    AND status = 'running' AND qa_execution_id IS NULL
			    AND auto_retry_count = 0`,
			[parentExecutionId, targetPrHeadSha],
		);
		const claimed = this.db.getRowsModified() > 0;
		this.save();
		return claimed;
	}

	/** Persist the pre-bound successor id before the first async launch effect. */
	claimAutoQaRetryLaunch(
		parentExecutionId: string,
		targetPrHeadSha: string,
		retryAttemptId: string,
	): boolean {
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = 'retry_starting', retry_attempt_id = ?
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?
			    AND status = 'retry_pending'`,
			[retryAttemptId, parentExecutionId, targetPrHeadSha],
		);
		const claimed = this.db.getRowsModified() > 0;
		this.save();
		return claimed;
	}

	/** Bind the launched successor only when the durable attempt still owns it. */
	completeAutoQaRetryLaunch(
		parentExecutionId: string,
		targetPrHeadSha: string,
		retryAttemptId: string,
		qaExecutionId: string,
	): boolean {
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = 'running', qa_execution_id = ?, completed_at = NULL,
			        retest_wake_pending_at = NULL
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?
			    AND status = 'retry_starting' AND retry_attempt_id = ?`,
			[qaExecutionId, parentExecutionId, targetPrHeadSha, retryAttemptId],
		);
		const completed = this.db.getRowsModified() > 0;
		this.save();
		return completed;
	}

	/** Definite dispatcher failure exhausts the recovery episode fail-closed. */
	failAutoQaRetryLaunch(
		parentExecutionId: string,
		targetPrHeadSha: string,
		retryAttemptId: string,
	): boolean {
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = 'stuck', completed_at = datetime('now')
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?
			    AND status = 'retry_starting' AND retry_attempt_id = ?`,
			[parentExecutionId, targetPrHeadSha, retryAttemptId],
		);
		const failed = this.db.getRowsModified() > 0;
		this.save();
		return failed;
	}

	/**
	 * FLY-643: persist the SEPARATE QA Linear issue this record's QA runs on.
	 * Written immediately after the Linear issue is created and BEFORE the QA
	 * runner spawns, so a crash mid-spawn lets reconcile re-use this QA issue
	 * (re-spawn the runner) instead of creating a duplicate.
	 */
	setAutoQaIssue(
		parentExecutionId: string,
		targetPrHeadSha: string,
		qaIssue: {
			issueId: string;
			issueIdentifier?: string;
			issueTitle?: string;
			issueUrl?: string;
		},
	): void {
		this.db.run(
			`UPDATE auto_qa_record
			    SET qa_issue_id = ?,
			        qa_issue_identifier = ?,
			        qa_issue_title = ?,
			        qa_issue_url = ?
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?`,
			[
				qaIssue.issueId,
				qaIssue.issueIdentifier ?? null,
				qaIssue.issueTitle ?? null,
				qaIssue.issueUrl ?? null,
				parentExecutionId,
				targetPrHeadSha,
			],
		);
		this.save();
	}

	/**
	 * Transition a record's status. Terminal states (passed/failed/stuck) stamp
	 * completed_at. `notifiedAt: true` stamps notified_at (PASS founder
	 * ship-ready notification sent — release dedup). verdictEventId is the
	 * qa_result event id (idempotency anchor against duplicate verdicts).
	 */
	setAutoQaStatus(
		parentExecutionId: string,
		targetPrHeadSha: string,
		status: AutoQaRecord["status"],
		opts: { verdictEventId?: string; notifiedAt?: boolean },
	): void {
		const terminal =
			status === "passed" || status === "failed" || status === "stuck";
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = ?,
			        verdict_event_id = COALESCE(?, verdict_event_id),
			        completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END,
			        notified_at = CASE WHEN ? THEN datetime('now') ELSE notified_at END
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?`,
			[
				status,
				opts.verdictEventId ?? null,
				terminal ? 1 : 0,
				opts.notifiedAt ? 1 : 0,
				parentExecutionId,
				targetPrHeadSha,
			],
		);
		this.save();
	}

	/** Mark all of a parent's still-active records superseded EXCEPT keepSha. */
	supersedeOtherAutoQaRecords(
		parentExecutionId: string,
		keepSha: string,
	): void {
		this.db.run(
			`UPDATE auto_qa_record SET status = 'superseded'
			  WHERE parent_execution_id = ? AND target_pr_head_sha != ?
			    AND status IN ('running','awaiting_retest','retry_pending','retry_starting','stuck')`,
			[parentExecutionId, keepSha],
		);
		this.save();
	}

	getAutoQaRecord(
		parentExecutionId: string,
		targetPrHeadSha: string,
	): AutoQaRecord | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE parent_execution_id = ? AND target_pr_head_sha = ?",
		);
		stmt.bind([parentExecutionId, targetPrHeadSha]);
		let rec: AutoQaRecord | undefined;
		if (stmt.step()) {
			rec = this.rowToAutoQaRecord(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return rec;
	}

	putShipRelevantDiffSnapshot(
		input: Omit<ShipRelevantDiffSnapshot, "computed_at"> & {
			computed_at?: string;
		},
	): void {
		this.db.run(
			`INSERT INTO ship_relevant_diff_snapshot
			   (execution_id, pr_head_sha, repo, pr_number, base_ref, base_oid,
			    classifier_version, ship_relevant, file_count, sample_paths, computed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(execution_id, pr_head_sha) DO UPDATE SET
			   repo = excluded.repo,
			   pr_number = excluded.pr_number,
			   base_ref = excluded.base_ref,
			   base_oid = excluded.base_oid,
			   classifier_version = excluded.classifier_version,
			   ship_relevant = excluded.ship_relevant,
			   file_count = excluded.file_count,
			   sample_paths = excluded.sample_paths,
			   computed_at = excluded.computed_at`,
			[
				input.execution_id,
				input.pr_head_sha.toLowerCase(),
				input.repo,
				input.pr_number,
				input.base_ref,
				input.base_oid.toLowerCase(),
				input.classifier_version,
				input.ship_relevant,
				input.file_count,
				input.sample_paths ? JSON.stringify(input.sample_paths) : null,
				input.computed_at ?? new Date().toISOString(),
			],
		);
		this.save();
	}

	getShipRelevantDiffSnapshot(
		executionId: string,
		prHeadSha: string,
	): ShipRelevantDiffSnapshot | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM ship_relevant_diff_snapshot WHERE execution_id = ? AND lower(pr_head_sha) = ?",
		);
		stmt.bind([executionId, prHeadSha.toLowerCase()]);
		let snapshot: ShipRelevantDiffSnapshot | undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			let samplePaths: string[] | undefined;
			if (typeof row.sample_paths === "string") {
				try {
					const parsed = JSON.parse(row.sample_paths);
					if (
						Array.isArray(parsed) &&
						parsed.every((value) => typeof value === "string")
					) {
						samplePaths = parsed;
					}
				} catch {
					// Diagnostic-only field; corruption never changes gate truth.
				}
			}
			snapshot = {
				execution_id: row.execution_id as string,
				pr_head_sha: row.pr_head_sha as string,
				repo: row.repo as string,
				pr_number: Number(row.pr_number),
				base_ref: row.base_ref as string,
				base_oid: row.base_oid as string,
				classifier_version: Number(row.classifier_version),
				ship_relevant: Number(row.ship_relevant) as 0 | 1,
				file_count: Number(row.file_count),
				sample_paths: samplePaths,
				computed_at: row.computed_at as string,
			};
		}
		stmt.free();
		return snapshot;
	}

	deleteShipRelevantDiffSnapshot(
		executionId: string,
		prHeadSha: string,
	): boolean {
		this.db.run(
			"DELETE FROM ship_relevant_diff_snapshot WHERE execution_id = ? AND lower(pr_head_sha) = ?",
			[executionId, prHeadSha.toLowerCase()],
		);
		const deleted = this.db.getRowsModified() > 0;
		if (deleted) this.save();
		return deleted;
	}

	/** Keep only the current candidate head for an execution. Classification
	 * snapshots are authorization caches, not an audit ledger; retaining stale
	 * heads would grow the daemon DB forever and can never satisfy a live gate. */
	deleteOtherShipRelevantDiffSnapshots(
		executionId: string,
		keepPrHeadSha: string,
	): number {
		this.db.run(
			`DELETE FROM ship_relevant_diff_snapshot
			 WHERE execution_id = ? AND lower(pr_head_sha) != ?`,
			[executionId, keepPrHeadSha.toLowerCase()],
		);
		const deleted = this.db.getRowsModified();
		if (deleted > 0) this.save();
		return deleted;
	}

	// ─────────────────────────── FLY-827 Codex code-review gate ───────────────

	private rowToCodexReviewRecord(
		row: Record<string, unknown>,
	): CodexReviewRecord {
		return {
			execution_id: row.execution_id as string,
			target_pr_head_sha: row.target_pr_head_sha as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			status: row.status as CodexReviewRecord["status"],
			reviewed_target: (row.reviewed_target as string) ?? undefined,
			codex_thread_id: (row.codex_thread_id as string) ?? undefined,
			rounds:
				typeof row.rounds === "number"
					? (row.rounds as number)
					: row.rounds == null
						? undefined
						: Number(row.rounds),
			verdict_event_id: (row.verdict_event_id as string) ?? undefined,
			// FLY-1188 §7.3: family stamps + review-job binding.
			author_family: (row.author_family as string) ?? undefined,
			reviewer_family: (row.reviewer_family as string) ?? undefined,
			request_id: (row.request_id as string) ?? undefined,
			created_at: row.created_at as string,
			approved_at: (row.approved_at as string) ?? undefined,
			hold_notified_at: (row.hold_notified_at as string) ?? undefined,
			stuck_notified_at: (row.stuck_notified_at as string) ?? undefined,
		};
	}

	/**
	 * FLY-827 (Codex code-review R1 MED-1): atomically CLAIM the right to fire the
	 * codex-hold side-effect bundle for (exec, head). Ensures a row exists (as
	 * pending) then stamps `hold_notified_at` IFF it was NULL. Returns true only for
	 * the FIRST caller — so the LIVE onMainAwaitingReview path posts/queues/alerts
	 * once, and a restart / repeated reconcileCodexHolds replays it as a no-op. A
	 * NEW head is a different PK → a fresh claim succeeds (re-notify on a new head).
	 */
	claimCodexHoldNotify(input: {
		executionId: string;
		targetPrHeadSha: string;
		issueId: string;
		projectName: string;
	}): boolean {
		const sha = input.targetPrHeadSha.toLowerCase();
		this.db.run(
			`INSERT OR IGNORE INTO codex_review_record
			   (execution_id, target_pr_head_sha, issue_id, project_name, status, created_at)
			 VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
			[input.executionId, sha, input.issueId, input.projectName],
		);
		this.db.run(
			`UPDATE codex_review_record SET hold_notified_at = datetime('now')
			  WHERE execution_id = ? AND target_pr_head_sha = ? AND hold_notified_at IS NULL`,
			[input.executionId, sha],
		);
		const claimed = this.db.getRowsModified() > 0;
		this.save();
		return claimed;
	}

	/**
	 * FLY-869 B-3: park a merged-but-unapproved session with a durable, head-bound
	 * marker (决定③ no auto-revert). Also the ONCE-PER-HEAD alert claim (R1 MED-4):
	 * writes IFF not already blocked for THIS head, and returns true ONLY for the
	 * first caller — so the `merge_without_approval` alert fires once, and a restart
	 * / replay is a no-op. A NEW head (rebase) is a fresh block → re-claims.
	 */
	setMergeBlock(input: {
		executionId: string;
		reason: string;
		head: string;
	}): boolean {
		const head = input.head.toLowerCase();
		this.db.run(
			`UPDATE sessions
			    SET merge_block_reason = ?, merge_block_head = ?, merge_block_at = datetime('now')
			  WHERE execution_id = ?
			    AND (merge_block_reason IS NULL OR lower(merge_block_head) != ?)`,
			[input.reason, head, input.executionId, head],
		);
		const claimed = this.db.getRowsModified() > 0;
		this.save();
		return claimed;
	}

	/**
	 * FLY-869 B-3 recovery: clear the merge_block marker once a same-head founder
	 * approval lands (the session can then transition to completed + finalize).
	 */
	clearMergeBlock(executionId: string): void {
		this.db.run(
			`UPDATE sessions
			    SET merge_block_reason = NULL, merge_block_head = NULL, merge_block_at = NULL
			  WHERE execution_id = ?`,
			[executionId],
		);
		this.save();
	}

	/**
	 * FLY-869 A-1: persist the IMMUTABLE qa_required snapshot (1=required, 0=exempt)
	 * at auto-qa-policy eval time. Immutable = written ONLY when currently NULL, so a
	 * later config/label change can never retroactively rewrite the ship verdict.
	 */
	setQaRequiredSnapshot(input: {
		executionId: string;
		required: 0 | 1;
		reason: string;
	}): void {
		this.db.run(
			`UPDATE sessions SET qa_required = ?, qa_required_reason = ?
			  WHERE execution_id = ? AND qa_required IS NULL`,
			[input.required, input.reason, input.executionId],
		);
		this.save();
	}

	/**
	 * FLY-827: record a Codex code-review APPROVAL for (exec, head). INSERT-OR-APPROVE
	 * (Codex R1 HIGH-1): a `codex_review_result` may arrive when NO `pending` row was
	 * written (pr_created often lacks a stable pr_head_sha), so we must be able to
	 * create the approved row from nothing — NOT only migrate pending→approved.
	 *   - no row       → INSERT status='approved'
	 *   - pending row  → UPDATE to approved
	 *   - approved row → idempotent; preserve original audit fields via COALESCE
	 *                    (Codex R2 LOW-4: a replayed verdict must not restamp
	 *                    approved_at / overwrite verdict_event_id)
	 *   - skipped row  → NOT overwritten (WHERE status != 'skipped'); gate already
	 *                    satisfied. Returns whether the gate is now satisfied.
	 *
	 * FLY-1188 (Codex R8/R9): the evidence group (verdict_event_id, families,
	 * request_id, review metadata) is replaced ATOMICALLY per verdict identity
	 * — never mixed across distinct verdicts:
	 *   - incoming carries a requestId MATCHING the row's request_id → replay
	 *     of the same request-bound verdict: fill-gaps only (anchors preserved).
	 *   - incoming carries a DIFFERENT (or first) requestId → a NEW
	 *     authoritative request-bound verdict: the whole evidence group is
	 *     replaced (incl. verdict_event_id + approved_at), so an invalid
	 *     `approved + codex/codex` row cannot permanently block a later valid
	 *     codex/claude review of the same head, and the surviving stamps always
	 *     point at the verdict that actually backs the gate.
	 *   - incoming has NO requestId (legacy codex lane) → it may create/fill a
	 *     requestless row (pre-FLY-1188 fill-gap semantics, byte-compatible)
	 *     but must NEVER overwrite a request-bound record: a late/replayed
	 *     same-family event cannot downgrade a valid cross-family review.
	 */
	recordCodexReviewApproved(input: {
		executionId: string;
		targetPrHeadSha: string;
		issueId: string;
		projectName: string;
		verdictEventId?: string;
		reviewedTarget?: string;
		codexThreadId?: string;
		rounds?: number;
		/** FLY-1188 §7.3: family stamps for the reviewer-inversion check. */
		authorFamily?: string;
		reviewerFamily?: string;
		/** FLY-1188 §7.1: review-job binding (codex-author lane). */
		requestId?: string;
	}): boolean {
		const sha = input.targetPrHeadSha.toLowerCase();
		const existing = this.getCodexReviewRecord(input.executionId, sha);
		if (!existing) {
			this.db.run(
				`INSERT INTO codex_review_record
				   (execution_id, target_pr_head_sha, issue_id, project_name, status,
				    reviewed_target, codex_thread_id, rounds, verdict_event_id,
				    author_family, reviewer_family, request_id, created_at, approved_at)
				 VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
				[
					input.executionId,
					sha,
					input.issueId,
					input.projectName,
					input.reviewedTarget ?? null,
					input.codexThreadId ?? null,
					input.rounds ?? null,
					input.verdictEventId ?? null,
					input.authorFamily ?? null,
					input.reviewerFamily ?? null,
					input.requestId ?? null,
				],
			);
			this.save();
			return this.isCodexCodeReviewApproved(input.executionId, sha);
		}
		if (existing.status === "skipped") {
			// gate already satisfied via sanctioned bypass; never overwritten
			return this.isCodexCodeReviewApproved(input.executionId, sha);
		}

		const isNewAuthoritativeRequest =
			input.requestId != null && existing.request_id !== input.requestId;
		const isLegacyLaneOnRequestBoundRow =
			input.requestId == null && existing.request_id != null;

		if (isLegacyLaneOnRequestBoundRow) {
			// R9/R10 MEDIUM: a requestless (legacy codex-lane) event must not
			// touch ANY request-bound record — approved (no downgrade, no mixed
			// evidence) OR pending (R10: filling a request-bound pending row
			// with legacy evidence would make the real verdict for that request
			// look like a replay and its evidence unreplaceable). Only the
			// bound request's own verdict — or a different authoritative
			// request — may write here.
			return this.isCodexCodeReviewApproved(input.executionId, sha);
		}

		if (
			isNewAuthoritativeRequest &&
			(existing.status === "approved" || existing.request_id != null)
		) {
			// Atomic evidence-group replacement: the new request-bound verdict
			// is authoritative; every stamp (incl. the verdict anchor and
			// approved_at) now describes THAT verdict. R2 LOW-4 (replays must
			// not restamp) is untouched — this branch is not a replay.
			this.db.run(
				`UPDATE codex_review_record SET
				   status = 'approved',
				   approved_at = datetime('now'),
				   verdict_event_id = ?,
				   reviewed_target = ?,
				   codex_thread_id = ?,
				   rounds = ?,
				   author_family = ?,
				   reviewer_family = ?,
				   request_id = ?
				 WHERE execution_id = ? AND target_pr_head_sha = ?`,
				[
					input.verdictEventId ?? null,
					input.reviewedTarget ?? null,
					input.codexThreadId ?? null,
					input.rounds ?? null,
					input.authorFamily ?? null,
					input.reviewerFamily ?? null,
					input.requestId ?? null,
					input.executionId,
					sha,
				],
			);
			this.save();
			return this.isCodexCodeReviewApproved(input.executionId, sha);
		}

		// pending→approved, replay of the same request-bound verdict, or a
		// requestless verdict on a requestless row: pre-FLY-1188 fill-gap
		// semantics (Codex R2 LOW-4: a replayed verdict must not restamp
		// approved_at / overwrite verdict_event_id).
		this.db.run(
			`UPDATE codex_review_record SET
			   status = 'approved',
			   approved_at = COALESCE(approved_at, datetime('now')),
			   verdict_event_id = COALESCE(verdict_event_id, ?),
			   reviewed_target = COALESCE(reviewed_target, ?),
			   codex_thread_id = COALESCE(codex_thread_id, ?),
			   rounds = COALESCE(rounds, ?),
			   author_family = COALESCE(author_family, ?),
			   reviewer_family = COALESCE(reviewer_family, ?),
			   request_id = COALESCE(request_id, ?)
			 WHERE execution_id = ? AND target_pr_head_sha = ?`,
			[
				input.verdictEventId ?? null,
				input.reviewedTarget ?? null,
				input.codexThreadId ?? null,
				input.rounds ?? null,
				input.authorFamily ?? null,
				input.reviewerFamily ?? null,
				input.requestId ?? null,
				input.executionId,
				sha,
			],
		);
		this.save();
		return this.isCodexCodeReviewApproved(input.executionId, sha);
	}

	/**
	 * FLY-827: mark a codex-skip bypass for (exec, head). Upsert to `skipped`
	 * (sanctioned label/flag path). Only written when a head is available; a
	 * session with `codex_skip` and no head is still gate-satisfied via the
	 * session flag in `isCodexGateSatisfied` (does not depend on this row).
	 */
	markCodexReviewSkipped(input: {
		executionId: string;
		targetPrHeadSha: string;
		issueId: string;
		projectName: string;
	}): void {
		const sha = input.targetPrHeadSha.toLowerCase();
		this.db.run(
			`INSERT INTO codex_review_record
			   (execution_id, target_pr_head_sha, issue_id, project_name, status, created_at)
			 VALUES (?, ?, ?, ?, 'skipped', datetime('now'))
			 ON CONFLICT(execution_id, target_pr_head_sha) DO UPDATE SET status = 'skipped'`,
			[input.executionId, sha, input.issueId, input.projectName],
		);
		this.save();
	}

	// ── FLY-1188 §7.1: codex-author review-job registry ────────────────────

	private rowToCodexReviewJob(row: Record<string, unknown>): CodexReviewJob {
		return {
			request_id: row.request_id as string,
			execution_id: row.execution_id as string,
			issue_id: (row.issue_id as string) ?? undefined,
			project_name: row.project_name as string,
			review_type: row.review_type as CodexReviewJob["review_type"],
			round: (row.round as number) ?? 1,
			question_id: row.question_id as string,
			target_path: (row.target_path as string) ?? undefined,
			frozen_head_sha: (row.frozen_head_sha as string) ?? undefined,
			status: row.status as CodexReviewJob["status"],
			reviewer_session_uuid: (row.reviewer_session_uuid as string) ?? undefined,
			verdict: (row.verdict as string) ?? undefined,
			reviewer_verdict: (row.reviewer_verdict as string) ?? undefined,
			findings_json: (row.findings_json as string) ?? undefined,
			advisories_json: (row.advisories_json as string) ?? undefined,
			settled_json: (row.settled_json as string) ?? undefined,
			response_json: (row.response_json as string) ?? undefined,
			payload_version:
				row.payload_version === null || row.payload_version === undefined
					? undefined
					: Number(row.payload_version),
			failure_reason: (row.failure_reason as string) ?? undefined,
			failure_raw: (row.failure_raw as string) ?? undefined,
			author_family: (row.author_family as string) ?? undefined,
			created_at: row.created_at as string,
			updated_at: (row.updated_at as string) ?? undefined,
			responded_at: (row.responded_at as string) ?? undefined,
			delivery_nonce: (row.delivery_nonce as string) ?? undefined,
		};
	}

	getCodexReviewJob(requestId: string): CodexReviewJob | null {
		const stmt = this.db.prepare(
			"SELECT * FROM codex_review_job WHERE request_id = ?",
		);
		stmt.bind([requestId]);
		let job: CodexReviewJob | null = null;
		if (stmt.step()) {
			job = this.rowToCodexReviewJob(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return job;
	}

	/**
	 * FLY-1314: reverse-map an orphan review gate to its durable review job.
	 * Exactly one row is required; duplicate bindings are ambiguous and fail open
	 * (the supersede patrol leaves the gate untouched).
	 */
	getCodexReviewJobByQuestionId(questionId: string): CodexReviewJob | null {
		const stmt = this.db.prepare(
			"SELECT * FROM codex_review_job WHERE question_id = ? ORDER BY request_id LIMIT 2",
		);
		stmt.bind([questionId]);
		const jobs: CodexReviewJob[] = [];
		while (stmt.step()) {
			jobs.push(
				this.rowToCodexReviewJob(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return jobs.length === 1 ? jobs[0]! : null;
	}

	/**
	 * Idempotent insert keyed by requestId (§7.1: re-POST of the same request
	 * must return the SAME durable job, never a duplicate). Returns whether a
	 * new row was created plus the current row either way.
	 */
	insertCodexReviewJob(input: {
		requestId: string;
		executionId: string;
		issueId?: string;
		projectName: string;
		reviewType: "design" | "code";
		round?: number;
		questionId: string;
		targetPath?: string;
		frozenHeadSha?: string;
		reviewerSessionUuid?: string;
		authorFamily?: string;
		/** skip lane writes the durable skipped audit row directly. */
		status?: "pending" | "skipped";
	}): { inserted: boolean; job: CodexReviewJob } {
		this.db.run(
			`INSERT OR IGNORE INTO codex_review_job
			   (request_id, execution_id, issue_id, project_name, review_type,
			    round, question_id, target_path, frozen_head_sha,
			    reviewer_session_uuid, author_family, status, delivery_nonce,
			    created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
			[
				input.requestId,
				input.executionId,
				input.issueId ?? null,
				input.projectName,
				input.reviewType,
				input.round ?? 1,
				input.questionId,
				input.targetPath ?? null,
				input.frozenHeadSha ?? null,
				input.reviewerSessionUuid ?? null,
				input.authorFamily ?? null,
				input.status ?? "pending",
				randomUUID(), // R17 delivery nonce — server-only
			],
		);
		const inserted = this.db.getRowsModified() > 0;
		this.save();
		const job = this.getCodexReviewJob(input.requestId);
		if (!job) throw new Error(`review job ${input.requestId} vanished`);
		return { inserted, job };
	}

	/**
	 * CAS claim pending|failed → running (failed→running = the sanctioned
	 * same-requestId retry after a reviewer failure). Returns false when the
	 * job is already running/done/skipped — the caller must not double-run.
	 */
	claimCodexReviewJobRunning(requestId: string): boolean {
		this.db.run(
			`UPDATE codex_review_job
			   SET status = 'running', failure_reason = NULL, failure_raw = NULL,
			       updated_at = datetime('now')
			 WHERE request_id = ? AND status IN ('pending','failed')`,
			[requestId],
		);
		const claimed = this.db.getRowsModified() > 0;
		this.save();
		return claimed;
	}

	completeCodexReviewJob(
		requestId: string,
		verdict: string,
		findingsJson?: string,
		details?: {
			reviewerVerdict: string;
			advisoriesJson: string;
			settledJson: string;
			responseJson: string;
			payloadVersion: number;
		},
	): void {
		this.db.run(
			`UPDATE codex_review_job
			   SET status = 'done', verdict = ?, reviewer_verdict = ?,
			       findings_json = ?, advisories_json = ?, settled_json = ?,
			       response_json = ?, payload_version = ?,
			       failure_reason = NULL, failure_raw = NULL,
			       updated_at = datetime('now')
			 WHERE request_id = ?`,
			[
				verdict,
				details?.reviewerVerdict ?? null,
				findingsJson ?? null,
				details?.advisoriesJson ?? null,
				details?.settledJson ?? null,
				details?.responseJson ?? null,
				details?.payloadVersion ?? null,
				requestId,
			],
		);
		this.save();
	}

	/**
	 * R13 HIGH-1: terminal done/skipped rows are IMMUTABLE here — a crashed
	 * respond/stamp after the verdict landed must not downgrade the row out of
	 * the outbox scan (which only re-delivers done/skipped).
	 */
	failCodexReviewJob(
		requestId: string,
		reason: string,
		failureRaw?: string,
	): void {
		this.db.run(
			`UPDATE codex_review_job
			   SET status = 'failed', failure_reason = ?, failure_raw = ?,
			       updated_at = datetime('now')
			 WHERE request_id = ? AND status NOT IN ('done','skipped')`,
			[reason, failureRaw ?? null, requestId],
		);
		this.save();
	}

	/** Stamp/refresh the claude reviewer session uuid used for this job. */
	setCodexReviewJobReviewerSession(requestId: string, uuid: string): void {
		this.db.run(
			"UPDATE codex_review_job SET reviewer_session_uuid = ?, updated_at = datetime('now') WHERE request_id = ?",
			[uuid, requestId],
		);
		this.save();
	}

	/**
	 * Boot redrive (§7.1): pending jobs never started; running jobs were
	 * in-flight when the Bridge died — both re-enqueue (the reviewer round is
	 * re-run from scratch; verdicts are only recorded on completion, so a
	 * half-run round has no partial state to reconcile).
	 */
	listRedrivableCodexReviewJobs(): CodexReviewJob[] {
		const jobs: CodexReviewJob[] = [];
		const stmt = this.db.prepare(
			"SELECT * FROM codex_review_job WHERE status IN ('pending','running') ORDER BY created_at ASC",
		);
		while (stmt.step()) {
			jobs.push(
				this.rowToCodexReviewJob(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return jobs;
	}

	/** R12 HIGH-4 outbox: stamp AFTER the bound question is actually answered. */
	stampCodexReviewJobResponded(requestId: string): void {
		this.db.run(
			"UPDATE codex_review_job SET responded_at = datetime('now') WHERE request_id = ?",
			[requestId],
		);
		this.save();
	}

	/**
	 * R12 HIGH-4 outbox scan: terminal verdicts whose gate response never
	 * landed (crash between the terminal write and the CommDB answer). The
	 * response is re-delivered from the STORED verdict — never a re-review.
	 */
	listUndeliveredCodexReviewJobs(): CodexReviewJob[] {
		const jobs: CodexReviewJob[] = [];
		const stmt = this.db.prepare(
			`SELECT * FROM codex_review_job
			  WHERE status IN ('done','skipped') AND responded_at IS NULL
			  ORDER BY created_at ASC`,
		);
		while (stmt.step()) {
			jobs.push(
				this.rowToCodexReviewJob(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return jobs;
	}

	/** Boot redrive prep: in-flight rows from a dead Bridge → pending again. */
	resetRunningCodexReviewJobs(): number {
		this.db.run(
			"UPDATE codex_review_job SET status = 'pending', updated_at = datetime('now') WHERE status = 'running'",
		);
		const n = this.db.getRowsModified();
		this.save();
		return n;
	}

	/** Server-derived round number: prior requests for (exec, type) + 1. */
	countCodexReviewJobs(
		executionId: string,
		reviewType: "design" | "code",
	): number {
		const stmt = this.db.prepare(
			"SELECT COUNT(*) AS n FROM codex_review_job WHERE execution_id = ? AND review_type = ?",
		);
		stmt.bind([executionId, reviewType]);
		let n = 0;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			n = Number(row.n ?? 0);
		}
		stmt.free();
		return n;
	}

	/** Latest DONE job for fresh rerounds that must rebuild prior context. */
	latestDoneCodexReviewJob(
		executionId: string,
		reviewType: "design" | "code",
	): CodexReviewJob | null {
		const stmt = this.db.prepare(
			`SELECT * FROM codex_review_job
			  WHERE execution_id = ? AND review_type = ? AND status = 'done'
			  ORDER BY created_at DESC LIMIT 1`,
		);
		stmt.bind([executionId, reviewType]);
		let job: CodexReviewJob | null = null;
		if (stmt.step()) {
			job = this.rowToCodexReviewJob(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return job;
	}

	/**
	 * Latest reviewer session uuid for (execution, review type) — rerounds
	 * resume the same claude session so the reviewer keeps its codebase read.
	 */
	latestCodexReviewerSessionUuid(
		executionId: string,
		reviewType: "design" | "code",
	): string | null {
		const stmt = this.db.prepare(
			`SELECT reviewer_session_uuid FROM codex_review_job
			  WHERE execution_id = ? AND review_type = ?
			    AND reviewer_session_uuid IS NOT NULL
			  ORDER BY created_at DESC LIMIT 1`,
		);
		stmt.bind([executionId, reviewType]);
		let uuid: string | null = null;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			uuid = (row.reviewer_session_uuid as string) ?? null;
		}
		stmt.free();
		return uuid;
	}

	// ── FLY-1278: review-finding governance rulings ───────────────────────

	recordReviewFindingRuling(input: {
		projectName: string;
		issue: string;
		findingKey?: string;
		requestId?: string;
		findingIndex?: number;
		disposition: "overruled" | "follow_up";
		followUpIssue?: string;
		rationale: string;
		ruledBy: string;
		executionId?: string;
	}): RecordReviewFindingRulingResult {
		const cluster = this.resolveReviewIssueAliasCluster(
			input.projectName,
			input.issue,
		);
		if (cluster.status !== "resolved") return { status: cluster.status };
		const source = this.resolveDeliveredReviewFinding({
			projectName: input.projectName,
			aliases: cluster.aliases,
			findingKey: input.findingKey,
			requestId: input.requestId,
			findingIndex: input.findingIndex,
		});
		if (source.status !== "resolved") return { status: source.status };

		let result: RecordReviewFindingRulingResult | undefined;
		this.db.transaction(() => {
			const active = this.findActiveReviewFindingRuling(
				input.projectName,
				cluster.aliases,
				source.findingKey,
				source.reviewType,
			);
			if (active) {
				const sameIntent =
					active.disposition === input.disposition &&
					(active.follow_up_issue ?? undefined) === input.followUpIssue &&
					active.rationale === input.rationale;
				result = {
					status: sameIntent ? "idempotent" : "conflict",
					ruling: active,
				};
				return;
			}

			const rulingId = randomUUID();
			try {
				this.db.run(
					`INSERT INTO review_finding_ruling
					   (ruling_id, project_name, issue_id_canonical, issue_identifier,
					    finding_key, source_request_id, source_finding_index,
					    finding_title, finding_severity, review_type, disposition,
					    follow_up_issue, rationale, ruled_by, execution_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						rulingId,
						input.projectName,
						cluster.canonicalId,
						cluster.identifier ?? null,
						source.findingKey,
						source.requestId,
						source.findingIndex,
						source.title ?? null,
						source.severity ?? null,
						source.reviewType,
						input.disposition,
						input.followUpIssue ?? null,
						input.rationale,
						input.ruledBy,
						input.executionId ?? null,
					],
				);
			} catch (err) {
				// The partial unique index is the final concurrency boundary. Re-read
				// the winner and classify semantic replay vs conflicting intent.
				const winner = this.findActiveReviewFindingRuling(
					input.projectName,
					cluster.aliases,
					source.findingKey,
					source.reviewType,
				);
				if (!winner) throw err;
				const sameIntent =
					winner.disposition === input.disposition &&
					(winner.follow_up_issue ?? undefined) === input.followUpIssue &&
					winner.rationale === input.rationale;
				result = {
					status: sameIntent ? "idempotent" : "conflict",
					ruling: winner,
				};
				return;
			}
			const created = this.getReviewFindingRuling(rulingId);
			if (!created) throw new Error(`review ruling ${rulingId} vanished`);
			result = { status: "created", ruling: created };
		});
		this.save();
		if (!result)
			throw new Error("review ruling transaction produced no result");
		return result;
	}

	listActiveReviewFindingRulings(
		projectName: string,
		issue: string,
	): ReviewFindingRuling[] {
		const cluster = this.resolveReviewIssueAliasCluster(projectName, issue);
		if (cluster.status !== "resolved") return [];
		const placeholders = cluster.aliases.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM review_finding_ruling
			 WHERE project_name = ? AND revoked_at IS NULL
			   AND (issue_id_canonical IN (${placeholders})
			        OR issue_identifier IN (${placeholders}))
			 ORDER BY created_at DESC, rowid DESC`,
		);
		stmt.bind([projectName, ...cluster.aliases, ...cluster.aliases]);
		const rows: ReviewFindingRuling[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToReviewFindingRuling(
					stmt.getAsObject() as Record<string, unknown>,
				),
			);
		}
		stmt.free();
		return rows;
	}

	revokeReviewFindingRuling(input: {
		projectName: string;
		rulingId: string;
		revokedBy: string;
		reason: string;
	}): ReviewFindingRuling | null {
		this.db.run(
			`UPDATE review_finding_ruling
			   SET revoked_at = datetime('now'), revoked_by = ?, revoke_reason = ?
			 WHERE ruling_id = ? AND project_name = ? AND revoked_at IS NULL`,
			[input.revokedBy, input.reason, input.rulingId, input.projectName],
		);
		this.save();
		return this.getReviewFindingRuling(input.rulingId, input.projectName);
	}

	listPendingReviewRulingNotifications(): ReviewFindingRuling[] {
		const stmt = this.db.prepare(
			`SELECT * FROM review_finding_ruling
			 WHERE revoked_at IS NULL AND notified_at IS NULL
			 ORDER BY created_at ASC, rowid ASC`,
		);
		const rows: ReviewFindingRuling[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToReviewFindingRuling(
					stmt.getAsObject() as Record<string, unknown>,
				),
			);
		}
		stmt.free();
		return rows;
	}

	markReviewFindingRulingNotified(rulingId: string): void {
		this.db.run(
			"UPDATE review_finding_ruling SET notified_at = COALESCE(notified_at, datetime('now')) WHERE ruling_id = ?",
			[rulingId],
		);
		this.save();
	}

	private getReviewFindingRuling(
		rulingId: string,
		projectName?: string,
	): ReviewFindingRuling | null {
		const stmt = this.db.prepare(
			`SELECT * FROM review_finding_ruling WHERE ruling_id = ?${projectName ? " AND project_name = ?" : ""}`,
		);
		stmt.bind(projectName ? [rulingId, projectName] : [rulingId]);
		let ruling: ReviewFindingRuling | null = null;
		if (stmt.step()) {
			ruling = this.rowToReviewFindingRuling(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return ruling;
	}

	private findActiveReviewFindingRuling(
		projectName: string,
		aliases: string[],
		findingKey: string,
		reviewType: "design" | "code",
	): ReviewFindingRuling | null {
		const placeholders = aliases.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM review_finding_ruling
			 WHERE project_name = ? AND finding_key = ? AND review_type = ?
			   AND revoked_at IS NULL
			   AND (issue_id_canonical IN (${placeholders})
			        OR issue_identifier IN (${placeholders}))
			 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
		);
		stmt.bind([projectName, findingKey, reviewType, ...aliases, ...aliases]);
		let ruling: ReviewFindingRuling | null = null;
		if (stmt.step()) {
			ruling = this.rowToReviewFindingRuling(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return ruling;
	}

	private resolveReviewIssueAliasCluster(
		projectName: string,
		issue: string,
	):
		| {
				status: "resolved";
				aliases: string[];
				canonicalId: string;
				identifier?: string;
		  }
		| { status: "issue_not_found" | "issue_ambiguous" } {
		const aliases = new Set<string>([issue]);
		let matched = false;
		let changed = true;
		while (changed) {
			changed = false;
			const sessions = this.getSessionsForIssueAliases([...aliases]).filter(
				(session) => session.project_name === projectName,
			);
			if (sessions.length > 0) matched = true;
			for (const session of sessions) {
				for (const key of [session.issue_id, session.issue_identifier]) {
					if (key && !aliases.has(key)) {
						aliases.add(key);
						changed = true;
					}
				}
			}
		}
		if (!matched) return { status: "issue_not_found" };
		const uuidKeys = [...aliases].filter((key) => UUID_PATTERN.test(key));
		if (uuidKeys.length > 1) return { status: "issue_ambiguous" };
		const identifierKeys = [...aliases]
			.filter((key) => ISSUE_IDENTIFIER_PATTERN.test(key))
			.sort();
		return {
			status: "resolved",
			aliases: [...aliases].sort(),
			canonicalId: uuidKeys[0] ?? identifierKeys[0] ?? issue,
			...(identifierKeys[0] ? { identifier: identifierKeys[0] } : {}),
		};
	}

	private resolveDeliveredReviewFinding(input: {
		projectName: string;
		aliases: string[];
		findingKey?: string;
		requestId?: string;
		findingIndex?: number;
	}):
		| {
				status: "resolved";
				findingKey: string;
				requestId: string;
				findingIndex: number;
				title?: string;
				severity?: string;
				reviewType: "design" | "code";
		  }
		| { status: "finding_not_found" | "finding_ambiguous" } {
		const placeholders = input.aliases.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM codex_review_job
			 WHERE project_name = ? AND status = 'done' AND responded_at IS NOT NULL
			   AND issue_id IN (${placeholders})
			 ORDER BY created_at DESC, rowid DESC`,
		);
		stmt.bind([input.projectName, ...input.aliases]);
		const candidates: Array<{
			findingKey: string;
			requestId: string;
			findingIndex: number;
			title?: string;
			severity?: string;
			reviewType: "design" | "code";
		}> = [];
		while (stmt.step()) {
			const job = this.rowToCodexReviewJob(
				stmt.getAsObject() as Record<string, unknown>,
			);
			if (input.requestId && job.request_id !== input.requestId) continue;
			const findings = parseReviewFindings(job.findings_json);
			for (let index = 0; index < findings.length; index += 1) {
				if (input.findingIndex !== undefined && index !== input.findingIndex) {
					continue;
				}
				const finding = findings[index] as ClaudeReviewFinding;
				const key = deriveReviewFindingKey(finding);
				if (input.findingKey && key !== input.findingKey) continue;
				candidates.push({
					findingKey: key,
					requestId: job.request_id,
					findingIndex: index,
					...(typeof finding.title === "string"
						? { title: finding.title }
						: {}),
					...(typeof finding.severity === "string"
						? { severity: finding.severity }
						: {}),
					reviewType: job.review_type,
				});
			}
		}
		stmt.free();
		if (candidates.length === 0) return { status: "finding_not_found" };
		if (
			!input.requestId &&
			new Set(candidates.map((c) => c.reviewType)).size > 1
		) {
			return { status: "finding_ambiguous" };
		}
		return { status: "resolved", ...candidates[0]! };
	}

	private rowToReviewFindingRuling(
		row: Record<string, unknown>,
	): ReviewFindingRuling {
		return {
			ruling_id: row.ruling_id as string,
			project_name: row.project_name as string,
			issue_id_canonical: row.issue_id_canonical as string,
			issue_identifier: (row.issue_identifier as string) ?? undefined,
			finding_key: row.finding_key as string,
			source_request_id: row.source_request_id as string,
			source_finding_index: Number(row.source_finding_index),
			finding_title: (row.finding_title as string) ?? undefined,
			finding_severity: (row.finding_severity as string) ?? undefined,
			review_type: row.review_type as "design" | "code",
			disposition: row.disposition as "overruled" | "follow_up",
			follow_up_issue: (row.follow_up_issue as string) ?? undefined,
			rationale: row.rationale as string,
			ruled_by: row.ruled_by as string,
			execution_id: (row.execution_id as string) ?? undefined,
			created_at: row.created_at as string,
			notified_at: (row.notified_at as string) ?? undefined,
			revoked_at: (row.revoked_at as string) ?? undefined,
			revoked_by: (row.revoked_by as string) ?? undefined,
			revoke_reason: (row.revoke_reason as string) ?? undefined,
		};
	}

	/**
	 * FLY-827: register that a code review is REQUIRED for (exec, head) — audit
	 * friendly only. INSERT OR IGNORE (never downgrades an approved/skipped row).
	 * The gate does NOT depend on a pending row existing.
	 */
	upsertCodexReviewPending(input: {
		executionId: string;
		targetPrHeadSha: string;
		issueId: string;
		projectName: string;
	}): void {
		const sha = input.targetPrHeadSha.toLowerCase();
		this.db.run(
			`INSERT OR IGNORE INTO codex_review_record
			   (execution_id, target_pr_head_sha, issue_id, project_name, status, created_at)
			 VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
			[input.executionId, sha, input.issueId, input.projectName],
		);
		this.save();
	}

	getCodexReviewRecord(
		executionId: string,
		targetPrHeadSha: string,
	): CodexReviewRecord | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM codex_review_record WHERE execution_id = ? AND target_pr_head_sha = ?",
		);
		stmt.bind([executionId, targetPrHeadSha.toLowerCase()]);
		let rec: CodexReviewRecord | undefined;
		if (stmt.step()) {
			rec = this.rowToCodexReviewRecord(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return rec;
	}

	/**
	 * FLY-827: the core durable predicate — is Codex code review satisfied for this
	 * exact head? True iff an approved OR skipped row exists (lower-cased sha).
	 * `isCodexGateSatisfied` layers session.codex_skip + the hard-gate kill-switch
	 * on top of this.
	 */
	isCodexCodeReviewApproved(executionId: string, sha: string): boolean {
		const rec = this.getCodexReviewRecord(executionId, sha.toLowerCase());
		if (!rec) return false;
		// FLY-1188 §7.3: the reviewer-inversion invariant — a record only
		// satisfies the gate if the reviewer came from a DIFFERENT agent
		// family than the author. Shared rule with the verify-approval CLI
		// mirror (flywheel-config) so server gate and merge check never
		// drift. Legacy unstamped rows stay valid ONLY for claude-family
		// authors; a codex author with an unstamped record fails closed.
		return crossFamilyReviewSatisfied({
			status: rec.status,
			authorFamily: rec.author_family ?? null,
			reviewerFamily: rec.reviewer_family ?? null,
			sessionAdapterType: this.getSession(executionId)?.adapter_type ?? null,
		});
	}

	/**
	 * FLY-863: still-pending holds whose FIRST notification (`hold_notified_at`)
	 * is older than `thresholdMs` and have not yet been escalated
	 * (`stuck_notified_at IS NULL`) — the candidates for
	 * `AutoQaCoordinator.reconcileStuckCodexHolds`. The caller re-checks the
	 * owning session (still awaiting_review on this exact head, gate still
	 * unsatisfied) before firing anything — a row here is a candidate, not a
	 * guarantee.
	 */
	listCodexHoldsPendingOlderThan(
		nowMs: number,
		thresholdMs: number,
	): CodexReviewRecord[] {
		const stmt = this.db.prepare(
			`SELECT * FROM codex_review_record
			  WHERE status = 'pending' AND hold_notified_at IS NOT NULL AND stuck_notified_at IS NULL`,
		);
		const out: CodexReviewRecord[] = [];
		while (stmt.step()) {
			const rec = this.rowToCodexReviewRecord(
				stmt.getAsObject() as Record<string, unknown>,
			);
			if (!rec.hold_notified_at) continue;
			const heldSinceMs = Date.parse(
				`${rec.hold_notified_at.replace(" ", "T")}Z`,
			);
			if (!Number.isNaN(heldSinceMs) && nowMs - heldSinceMs >= thresholdMs) {
				out.push(rec);
			}
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-863: atomically claim the right to fire the STUCK escalation (thread
	 * post + Lead alert) for (exec, head). Returns true only for the first
	 * caller — a repeated `reconcileStuckCodexHolds` pass observing the same
	 * still-unresolved head is a no-op (LeadAlertNotifier's own per-eventId
	 * dedup is a second, independent backstop).
	 */
	claimCodexHoldStuckNotify(
		executionId: string,
		targetPrHeadSha: string,
	): boolean {
		const sha = targetPrHeadSha.toLowerCase();
		this.db.run(
			`UPDATE codex_review_record SET stuck_notified_at = datetime('now')
			  WHERE execution_id = ? AND target_pr_head_sha = ? AND stuck_notified_at IS NULL`,
			[executionId, sha],
		);
		const claimed = this.db.getRowsModified() > 0;
		this.save();
		return claimed;
	}

	getAutoQaRecordByQaExec(qaExecutionId: string): AutoQaRecord | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE qa_execution_id = ?",
		);
		stmt.bind([qaExecutionId]);
		let rec: AutoQaRecord | undefined;
		if (stmt.step()) {
			rec = this.rowToAutoQaRecord(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return rec;
	}

	/**
	 * FLY-867: ALL records for a QA exec. `qa_execution_id` is NOT unique
	 * (historical rows across heads/parents) and the single-row accessor above
	 * returns an arbitrary first match — unusable as a protection predicate.
	 * The stale-terminal close guard must see EVERY row so ANY active fix-loop
	 * record can protect the runner (fail-closed).
	 */
	listAutoQaRecordsByQaExec(qaExecutionId: string): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE qa_execution_id = ? ORDER BY started_at",
		);
		stmt.bind([qaExecutionId]);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	listAutoQaRecordsByParent(parentExecutionId: string): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE parent_execution_id = ? ORDER BY started_at",
		);
		stmt.bind([parentExecutionId]);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	listRunningAutoQaRecords(): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE status = 'running' ORDER BY started_at",
		);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	/** FLY-1279 D2: all records that can semantically hold an implementer. */
	listParkWatchAutoQaRecords(): AutoQaRecord[] {
		const stmt = this.db.prepare(
			`SELECT * FROM auto_qa_record
			 WHERE status IN
			  ('running','awaiting_retest','retry_pending','retry_starting','stuck')
			 ORDER BY started_at`,
		);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	/** Records that PASSED QA but whose founder ship-ready notification was
	 * never confirmed (notified_at IS NULL) — reconcile re-notifies these so a
	 * crash between status=passed and the notification can't strand the change. */
	listPassedUnnotifiedAutoQaRecords(): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE status = 'passed' AND notified_at IS NULL ORDER BY started_at",
		);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-752: ALL passed records (regardless of notified_at) — reconcile scans
	 * these to close a QA runner that PASSED but was left live by a crash between
	 * `notifyShipReady` and the close (the passed-unnotified sweep alone misses the
	 * notified-but-not-closed case).
	 */
	listPassedAutoQaRecords(): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE status = 'passed' ORDER BY started_at",
		);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	/** FLY-752: all records in a given status (reconcile sweeps, e.g. awaiting_retest). */
	listAutoQaRecordsByStatus(status: AutoQaRecord["status"]): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE status = ? ORDER BY started_at",
		);
		stmt.bind([status]);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-752: non-superseded records whose retarget left a durable retest-wake
	 * marker (crash after retarget, before the wake was confirmed). Reconcile
	 * re-drives the wake (or re-spawns a dead QA) for these.
	 */
	listAutoQaRecordsAwaitingRetestWake(): AutoQaRecord[] {
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE retest_wake_pending_at IS NOT NULL AND status != 'superseded' ORDER BY started_at",
		);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-752: the QA "owner" record for a parent — the single non-superseded
	 * record its one QA issue/runner is tracked on. A parent has at most one active
	 * QA (the fix-loop invariant), but on upgrade a legacy `failed`/`passed`/`stuck`
	 * row can be the owner. Latest-by-started_at breaks any tie deterministically;
	 * `superseded` rows are excluded (moot).
	 */
	getLatestAutoQaRecordByParent(
		parentExecutionId: string,
	): AutoQaRecord | undefined {
		// rowid DESC tiebreaks records claimed within the same second (started_at is
		// second-granularity) → newest-inserted wins deterministically.
		const stmt = this.db.prepare(
			"SELECT * FROM auto_qa_record WHERE parent_execution_id = ? AND status != 'superseded' ORDER BY started_at DESC, rowid DESC LIMIT 1",
		);
		stmt.bind([parentExecutionId]);
		let rec: AutoQaRecord | undefined;
		if (stmt.step()) {
			rec = this.rowToAutoQaRecord(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return rec;
	}

	/**
	 * FLY-846 gate ①: is this issue itself an auto-created `QA·FLY-XX` issue?
	 * True when any of the given issue keys (Linear UUID and/or identifier —
	 * production data is MIXED-form, so callers pass both) matches a record's
	 * `qa_issue_id` or `qa_issue_identifier`. The local, durable equivalent of
	 * "this issue has a qa_of link" — no Linear API call.
	 */
	isAutoQaIssue(issueKeys: string[]): boolean {
		const keys = normalizeIssueKeys(issueKeys);
		if (keys.length === 0) return false;
		const placeholders = keys.map(() => "?").join(",");
		const stmt = this.db.prepare(
			`SELECT 1 FROM auto_qa_record
			  WHERE qa_issue_id IN (${placeholders})
			     OR qa_issue_identifier IN (${placeholders})
			  LIMIT 1`,
		);
		stmt.bind([...keys, ...keys]);
		const hit = stmt.step();
		stmt.free();
		return hit;
	}

	/**
	 * FLY-846 gate ③: the issue-level active-QA lookup. Returns records in a
	 * non-terminal QA state (running / awaiting_retest / recovery / stuck) whose PARENT
	 * issue matches any of the given keys (UUID/identifier mixed-form), excluding
	 * the caller's own parent execution (same-parent records are handled by the
	 * owner-record branch). `passed`/`failed`/`superseded` never block a new QA.
	 */
	listActiveAutoQaRecordsForIssue(input: {
		issueKeys: string[];
		excludeParentExecutionId: string;
	}): AutoQaRecord[] {
		const keys = normalizeIssueKeys(input.issueKeys);
		if (keys.length === 0) return [];
		const placeholders = keys.map(() => "?").join(",");
		const stmt = this.db.prepare(
			`SELECT * FROM auto_qa_record
			  WHERE status IN ('running','awaiting_retest','retry_pending','retry_starting','stuck')
			    AND issue_id IN (${placeholders})
			    AND parent_execution_id != ?
			  ORDER BY started_at, rowid`,
		);
		stmt.bind([...keys, input.excludeParentExecutionId]);
		const out: AutoQaRecord[] = [];
		while (stmt.step()) {
			out.push(
				this.rowToAutoQaRecord(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-752: RETARGET a parent's QA owner record to a NEW reviewed head (a fix
	 * round), REUSING the same QA issue/runner. CAS + crash-safe:
	 *   - Guard: the (parent, oldSha) row must currently be in `expectStatuses`
	 *     (running / awaiting_retest / passed / stuck / legacy failed). A status
	 *     drift (already moved on / concurrent retarget) → false, no write.
	 *   - Conflict: a stale TERMINAL/superseded (parent, newSha) row can exist
	 *     (force-push back to an old sha, prior round on that exact head) — the
	 *     in-place UPDATE would violate the PK. Delete only such stale rows first;
	 *     never an active (running/awaiting_retest) one.
	 *   - Reset: status→running; clear verdict_event_id / completed_at AND
	 *     notified_at (notification state is scoped to (parent, head), not the
	 *     reusable row — else a retargeted old PASS keeps its old notified_at and a
	 *     new-head PASS could be dropped by reconcile); set the durable
	 *     retest_wake_pending_at marker.
	 * Returns true iff the retarget row was updated.
	 */
	retargetAutoQaRecord(input: {
		parentExecutionId: string;
		oldSha: string;
		newSha: string;
		expectStatuses: AutoQaRecord["status"][];
	}): boolean {
		if (input.newSha === input.oldSha) return false;
		const current = this.getAutoQaRecord(input.parentExecutionId, input.oldSha);
		if (!current || !input.expectStatuses.includes(current.status)) {
			return false; // CAS miss — status drift / concurrent retarget.
		}
		try {
			// Remove a stale conflicting (parent, newSha) row so the PK-column UPDATE
			// cannot hit SQLITE_CONSTRAINT. Only NON-active rows — an active row for
			// newSha would mean the invariant is already broken; bail then.
			const conflicting = this.getAutoQaRecord(
				input.parentExecutionId,
				input.newSha,
			);
			if (conflicting) {
				if (
					conflicting.status === "running" ||
					conflicting.status === "awaiting_retest"
				) {
					return false; // active row already owns newSha — do not clobber.
				}
				this.db.run(
					"DELETE FROM auto_qa_record WHERE parent_execution_id = ? AND target_pr_head_sha = ?",
					[input.parentExecutionId, input.newSha],
				);
			}
			this.db.run(
				`UPDATE auto_qa_record
				    SET target_pr_head_sha = ?,
				        status = 'running',
				        verdict_event_id = NULL,
				        completed_at = NULL,
				        notified_at = NULL,
				        retest_wake_pending_at = datetime('now')
				  WHERE parent_execution_id = ? AND target_pr_head_sha = ?`,
				[input.newSha, input.parentExecutionId, input.oldSha],
			);
			const updated = this.db.getRowsModified() > 0;
			this.save();
			return updated;
		} catch (err) {
			console.warn(
				`[auto-qa] retargetAutoQaRecord failed for ${input.parentExecutionId} ${input.oldSha.slice(0, 8)}→${input.newSha.slice(0, 8)}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return false;
		}
	}

	/** FLY-752: clear the durable retest-wake marker once the wake is confirmed. */
	clearRetestWakePending(
		parentExecutionId: string,
		targetPrHeadSha: string,
	): void {
		this.db.run(
			"UPDATE auto_qa_record SET retest_wake_pending_at = NULL WHERE parent_execution_id = ? AND target_pr_head_sha = ?",
			[parentExecutionId, targetPrHeadSha],
		);
		this.save();
	}

	/**
	 * FLY-752: reopen an EXISTING (parent, sha) row for a fresh QA re-spawn on the
	 * SAME head. Used only in the rare case where the QA owner lookup found no
	 * active record but a superseded/terminal row for the current head still exists
	 * (e.g. reconcile superseded it, then the parent re-entered review on the same
	 * head). Resets to running + clears terminal fields (keeps qa_issue_id so the
	 * same QA issue is reused). Returns true iff a row was updated.
	 */
	reopenAutoQaRecordForRespawn(
		parentExecutionId: string,
		targetPrHeadSha: string,
	): boolean {
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = 'running',
			        qa_execution_id = NULL,
			        verdict_event_id = NULL,
			        completed_at = NULL,
			        notified_at = NULL,
			        retest_wake_pending_at = NULL
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?
			    AND status IN ('superseded','failed','stuck')`,
			[parentExecutionId, targetPrHeadSha],
		);
		const updated = this.db.getRowsModified() > 0;
		this.save();
		return updated;
	}

	/**
	 * FLY-1251: bounded same-head manual escape hatch. Only a terminal non-pass
	 * row can be revived; active QA and already-passed evidence are immutable.
	 * The status predicate is the CAS against a concurrent auto/manual admission.
	 */
	reviveAutoQaRecordForManualSpawn(
		parentExecutionId: string,
		targetPrHeadSha: string,
	): boolean {
		this.db.run(
			`UPDATE auto_qa_record
			    SET status = 'running',
			        enrollment_source = 'manual',
			        qa_execution_id = NULL,
			        verdict_event_id = NULL,
			        completed_at = NULL,
			        notified_at = NULL,
			        retest_wake_pending_at = NULL,
			        started_at = datetime('now')
			  WHERE parent_execution_id = ? AND target_pr_head_sha = ?
			    AND status IN ('stuck','failed')`,
			[parentExecutionId, targetPrHeadSha],
		);
		const updated = this.db.getRowsModified() > 0;
		if (updated) this.save();
		return updated;
	}

	/**
	 * FLY-892 (converge): the single `(issue, channel)` thread registry. Reads
	 * `chat_threads` only — the FLY-793 per-phase side-table is no longer a thread
	 * source, so a phase session and a Lead `/send` resolve the SAME thread. The
	 * former `role` param and echoed `session_role` are gone (phase identity now
	 * rides on the message, not on a separate thread).
	 */
	getChatThreadByIssue(
		issueId: string,
		channelId: string,
	):
		| {
				thread_id: string;
				channel_id: string;
				lead_id: string | null;
				archived_at: string | null;
		  }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT thread_id, channel_id, lead_id, archived_at FROM chat_threads WHERE issue_id = ? AND channel_id = ? AND discord_missing_at IS NULL",
		);
		stmt.bind([issueId, channelId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return {
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				lead_id: (row.lead_id as string) ?? null,
				archived_at: (row.archived_at as string) ?? null,
			};
		}
		stmt.free();
		return undefined;
	}

	/**
	 * FLY-91 Round 2: Reverse lookup by thread_id for conflict detection.
	 *
	 * FLY-793 (Step 11): a thread_id lives in exactly ONE of the two tables. Check
	 * `chat_threads` FIRST (byte-unchanged for every existing main thread), then the
	 * `phase_chat_threads` side-table. `session_role` is echoed ('main' for a main
	 * thread) so callers that need role-sensitive metadata don't have to re-query.
	 */
	getChatThreadByThreadId(threadId: string):
		| {
				thread_id: string;
				channel_id: string;
				issue_id: string;
				session_role: ChatThreadRole;
		  }
		| undefined {
		const mainStmt = this.db.prepare(
			"SELECT thread_id, channel_id, issue_id FROM chat_threads WHERE thread_id = ? AND discord_missing_at IS NULL",
		);
		mainStmt.bind([threadId]);
		if (mainStmt.step()) {
			const row = mainStmt.getAsObject() as Record<string, unknown>;
			mainStmt.free();
			return {
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				issue_id: row.issue_id as string,
				session_role: "main",
			};
		}
		mainStmt.free();
		const phaseStmt = this.db.prepare(
			"SELECT thread_id, channel_id, issue_id, session_role FROM phase_chat_threads WHERE thread_id = ? AND discord_missing_at IS NULL",
		);
		phaseStmt.bind([threadId]);
		if (phaseStmt.step()) {
			const row = phaseStmt.getAsObject() as Record<string, unknown>;
			phaseStmt.free();
			return {
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				issue_id: row.issue_id as string,
				session_role: normalizeChatThreadRole(row.session_role as string),
			};
		}
		phaseStmt.free();
		return undefined;
	}

	markChatThreadMissing(threadId: string): void {
		this.db.run(
			"UPDATE chat_threads SET discord_missing_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		// FLY-793 (Step 11): a thread_id lives in exactly one table, so this second
		// UPDATE is a no-op for a main thread (byte-safe) and covers a phase thread.
		this.db.run(
			"UPDATE phase_chat_threads SET discord_missing_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		this.save();
	}

	/**
	 * FLY-369: mark a chat thread archived (archive-once record). The on-demand
	 * archive endpoint treats a thread with `archived_at` set as already
	 * archived and does not re-archive it, so if Annie re-opens it (Discord
	 * auto-unarchives on a new message) we do not fight her.
	 */
	markChatThreadArchived(threadId: string): void {
		this.db.run(
			"UPDATE chat_threads SET archived_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		// FLY-793 (Step 11): no-op for a main thread; archives a phase thread.
		this.db.run(
			"UPDATE phase_chat_threads SET archived_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		this.save();
	}

	/**
	 * FLY-1165: reconcile candidate set — main-table (`chat_threads`) rows that
	 * are not archived, not Discord-missing, and carry an issue key. The
	 * done-thread reconcile sweep enumerates these and double-gates each one
	 * (fresh Linear Done/Canceled + no live runner) before archiving.
	 */
	getUnarchivedIssueChatThreads(): Array<{
		thread_id: string;
		channel_id: string;
		issue_id: string;
		lead_id: string | null;
	}> {
		const stmt = this.db.prepare(
			`SELECT thread_id, channel_id, issue_id, lead_id FROM chat_threads
			 WHERE (archived_at IS NULL OR archived_at = '')
			   AND discord_missing_at IS NULL
			   AND issue_id IS NOT NULL AND issue_id != ''
			 ORDER BY created_at`,
		);
		const rows: Array<{
			thread_id: string;
			channel_id: string;
			issue_id: string;
			lead_id: string | null;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				issue_id: row.issue_id as string,
				lead_id: (row.lead_id as string) ?? null,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-1165: alias-aware sessions lookup — a session row matches when its
	 * `issue_id` OR `issue_identifier` hits ANY of the given keys (issue UUID ↔
	 * Linear identifier, both directions — the FLY-270 mixed-key reality).
	 * Returns ALL statuses: the liveness veto must see terminal-status rows too
	 * (a `completed` row can still own a live process). Parameterized IN
	 * expansion; an empty key list returns [] (never a full scan).
	 */
	getSessionsForIssueAliases(keys: string[]): Array<{
		execution_id: string;
		status: string;
		project_name: string;
		issue_id: string;
		issue_identifier: string | null;
	}> {
		if (keys.length === 0) return [];
		const placeholders = keys.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT execution_id, status, project_name, issue_id, issue_identifier
			 FROM sessions
			 WHERE issue_id IN (${placeholders})
			    OR issue_identifier IN (${placeholders})`,
		);
		stmt.bind([...keys, ...keys]);
		const rows: Array<{
			execution_id: string;
			status: string;
			project_name: string;
			issue_id: string;
			issue_identifier: string | null;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				execution_id: row.execution_id as string,
				status: row.status as string,
				project_name: row.project_name as string,
				issue_id: row.issue_id as string,
				issue_identifier: (row.issue_identifier as string) ?? null,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-1165: fresh archive-once read (sink guard). True when the main-table
	 * thread row has `archived_at` set — an archived thread is NEVER re-PATCHed
	 * (a founder re-open must not be fought).
	 */
	isChatThreadArchived(threadId: string): boolean {
		const stmt = this.db.prepare(
			"SELECT archived_at FROM chat_threads WHERE thread_id = ?",
		);
		stmt.bind([threadId]);
		let archived = false;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			const value = row.archived_at as string | null;
			archived = value !== null && value !== "";
		}
		stmt.free();
		return archived;
	}

	/**
	 * FLY-560 Feature C: record the runner-attach pinned-message state for an
	 * issue's chat thread. `pinnedAt` is set (ISO/datetime string) ONLY after a
	 * pin is confirmed; left null when the message is posted but not yet pinned
	 * (e.g. pin 403) so the next stage retries the pin (self-heal).
	 */
	setChatThreadAttachPin(
		issueId: string,
		channelId: string,
		state: { messageId: string; command: string; pinnedAt: string | null },
	): void {
		// FLY-892 (converge): the pin (now the pipeline header) lives on the single
		// `(issue, channel)` main thread — no more per-phase side-table routing.
		this.db.run(
			`UPDATE chat_threads
			 SET attach_pin_message_id = ?, attach_pin_command = ?, attach_pin_pinned_at = ?
			 WHERE issue_id = ? AND channel_id = ?`,
			[
				state.messageId,
				state.command,
				state.pinnedAt ?? null,
				issueId,
				channelId,
			],
		);
		this.save();
	}

	getChatThreadAttachPin(
		issueId: string,
		channelId: string,
	):
		| { messageId: string; command: string; pinnedAt: string | null }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT attach_pin_message_id, attach_pin_command, attach_pin_pinned_at FROM chat_threads WHERE issue_id = ? AND channel_id = ?",
		);
		stmt.bind([issueId, channelId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			const messageId = (row.attach_pin_message_id as string) ?? null;
			if (!messageId) return undefined; // no pin recorded yet
			return {
				messageId,
				command: (row.attach_pin_command as string) ?? "",
				pinnedAt: (row.attach_pin_pinned_at as string) ?? null,
			};
		}
		stmt.free();
		return undefined;
	}

	/** FLY-560 Feature C: clear the attach-pin record (e.g. message deleted). */
	clearChatThreadAttachPin(issueId: string, channelId: string): void {
		this.db.run(
			`UPDATE chat_threads
			 SET attach_pin_message_id = NULL, attach_pin_command = NULL, attach_pin_pinned_at = NULL
			 WHERE issue_id = ? AND channel_id = ?`,
			[issueId, channelId],
		);
		this.save();
	}

	/**
	 * FLY-887 (founder-visibility status line): the single, in-place-edited
	 * "🎨design(...)·🔨implement(...)·🧪qa(...)" message on the issue's MAIN
	 * chat thread (never the per-role `phase_chat_threads` — the status line
	 * is issue-wide, not phase-scoped). Undefined = no message posted yet.
	 */
	getPhaseStatusLine(
		issueId: string,
		channelId: string,
	): { messageId: string; text: string } | undefined {
		const stmt = this.db.prepare(
			"SELECT phase_status_message_id, phase_status_text FROM chat_threads WHERE issue_id = ? AND channel_id = ?",
		);
		stmt.bind([issueId, channelId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			const messageId = (row.phase_status_message_id as string) ?? null;
			if (!messageId) return undefined;
			return { messageId, text: (row.phase_status_text as string) ?? "" };
		}
		stmt.free();
		return undefined;
	}

	setPhaseStatusLine(
		issueId: string,
		channelId: string,
		messageId: string,
		text: string,
	): void {
		this.db.run(
			`UPDATE chat_threads
			 SET phase_status_message_id = ?, phase_status_text = ?
			 WHERE issue_id = ? AND channel_id = ?`,
			[messageId, text, issueId, channelId],
		);
		this.save();
	}

	clearPhaseStatusLine(issueId: string, channelId: string): void {
		this.db.run(
			`UPDATE chat_threads
			 SET phase_status_message_id = NULL, phase_status_text = NULL
			 WHERE issue_id = ? AND channel_id = ?`,
			[issueId, channelId],
		);
		this.save();
	}

	/**
	 * FLY-907 (Step 4.5): persist the issue's display-reconcile fingerprint —
	 * the stable serialization of ALL inputs the unified refresher derived the
	 * three display faces from (sessions component + CommDB component). Written
	 * ONLY after every enabled face confirmed changed/noop (Codex R2 #2); a
	 * missing/mismatching fingerprint keeps the issue a sweep candidate.
	 */
	setChatThreadDisplayFingerprint(
		issueId: string,
		channelId: string,
		fingerprint: string,
		reconciledAt: string,
	): void {
		this.db.run(
			`UPDATE chat_threads
			 SET display_fingerprint = ?, display_reconciled_at = ?
			 WHERE issue_id = ? AND channel_id = ?`,
			[fingerprint, reconciledAt, issueId, channelId],
		);
		this.save();
	}

	/**
	 * FLY-907 sweep layer 1 (cheap status scan, zero CommDB reads): chat-thread
	 * issues — INCLUDING terminal ones (a stale face on a crashed finalization
	 * must not hide) — with their stored fingerprint and the issue's newest
	 * session activity, ordered newest-first with a keyset cursor so the LIMIT
	 * never creates a permanent blind spot. `la` is COALESCE'd to "" so
	 * session-less threads sort last and keyset comparison stays total.
	 */
	listDisplayReconcileCandidates(
		cursor: { la: string; issueId: string } | null,
		limit: number,
	): Array<{
		issue_id: string;
		channel_id: string;
		display_fingerprint: string | null;
		la: string;
	}> {
		const where = cursor ? `AND (la < ? OR (la = ? AND ct.issue_id < ?))` : "";
		const stmt = this.db.prepare(
			`SELECT ct.issue_id, ct.channel_id, ct.display_fingerprint,
			        COALESCE((SELECT MAX(s.last_activity_at) FROM sessions s WHERE s.issue_id = ct.issue_id), '') AS la
			 FROM chat_threads ct
			 WHERE ct.discord_missing_at IS NULL ${where}
			 ORDER BY la DESC, ct.issue_id DESC
			 LIMIT ?`,
		);
		stmt.bind(cursor ? [cursor.la, cursor.la, cursor.issueId, limit] : [limit]);
		const rows: Array<{
			issue_id: string;
			channel_id: string;
			display_fingerprint: string | null;
			la: string;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				issue_id: row.issue_id as string,
				channel_id: row.channel_id as string,
				display_fingerprint: (row.display_fingerprint as string) ?? null,
				la: (row.la as string) ?? "",
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-907 sweep layer 2 (CommDB-sensitive rotation): chat-thread issues that
	 * still have a NON-terminal session (FSM no-out-edge terminal set:
	 * completed/terminated/shelved), rotated by keyset cursor. These get an
	 * UNCONDITIONAL refresh so Bridge-invisible CommDB-only drift (manual turn
	 * re-grant, park marker change, late tmux_window registration, corrected
	 * attach target) converges — the refresher's zero-churn writers make a
	 * no-drift pass free of Discord requests.
	 */
	listDisplaySweepActiveIssues(
		cursorIssueId: string | null,
		limit: number,
	): Array<{ issue_id: string; channel_id: string }> {
		const where = cursorIssueId ? "AND ct.issue_id > ?" : "";
		const stmt = this.db.prepare(
			`SELECT ct.issue_id, ct.channel_id
			 FROM chat_threads ct
			 WHERE ct.discord_missing_at IS NULL ${where}
			   AND EXISTS (
			     SELECT 1 FROM sessions s
			     WHERE s.issue_id = ct.issue_id
			       AND s.status NOT IN ('completed', 'terminated', 'shelved')
			   )
			 ORDER BY ct.issue_id ASC
			 LIMIT ?`,
		);
		stmt.bind(cursorIssueId ? [cursorIssueId, limit] : [limit]);
		const rows: Array<{ issue_id: string; channel_id: string }> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				issue_id: row.issue_id as string,
				channel_id: row.channel_id as string,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-892 (Step 5): the still-visible legacy phase threads (FLY-793 side-table
	 * rows) the boot sweep must reconcile — a Discord thread still exists for each.
	 * Filters out rows already archived or already marked missing so the sweep is
	 * idempotent by construction (an archived row never re-enters the input set).
	 * The side-table is otherwise read-only now (nothing writes it post-converge).
	 */
	getUnarchivedPhaseChatThreads(): Array<{
		thread_id: string;
		channel_id: string;
		issue_id: string;
		session_role: ChatThreadRole;
		lead_id: string | null;
	}> {
		const stmt = this.db.prepare(
			`SELECT thread_id, channel_id, issue_id, session_role, lead_id
			 FROM phase_chat_threads
			 WHERE archived_at IS NULL AND discord_missing_at IS NULL`,
		);
		const rows: Array<{
			thread_id: string;
			channel_id: string;
			issue_id: string;
			session_role: ChatThreadRole;
			lead_id: string | null;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				issue_id: row.issue_id as string,
				session_role: normalizeChatThreadRole(row.session_role as string),
				lead_id: (row.lead_id as string) ?? null,
			});
		}
		stmt.free();
		return rows;
	}

	// ── FLY-368: alert_threads (unified-alert per-error thread, active-mapping) ──

	/**
	 * FLY-368: open OR replace the active alert thread for a correlation key.
	 * Active-mapping semantics: a second call with a DIFFERENT event_id under the
	 * same correlation_key OVERWRITES the mapping (the caller must resolve+archive
	 * the prior Discord thread BEFORE calling this; this only owns the row). The
	 * UPSERT clears resolved_at so the row is active again.
	 */
	openAlertThread(input: {
		correlationKey: string;
		eventId: string;
		episodeSignature?: string | null;
		threadId: string;
		rootMessageId?: string | null;
		channelId: string;
		leadId: string;
		projectName: string;
		eventType: string;
		sessionKey?: string | null;
		repairStatus?: string | null;
		/** FLY-927: ticket lifecycle seed (absent = legacy row, NULL status). */
		ticketStatus?: string | null;
		ownerRef?: string | null;
		firstSeenAt?: string | null;
	}): void {
		this.db.run(
			`INSERT INTO alert_threads (
				correlation_key, event_id, episode_signature, thread_id, root_message_id,
				channel_id, lead_id, project_name, event_type, session_key, repair_status,
				ticket_status, owner_ref, first_seen_at, attempt_count, acked_at,
				opened_at, resolved_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, datetime('now'), NULL)
			ON CONFLICT(correlation_key) DO UPDATE SET
				event_id = excluded.event_id,
				episode_signature = excluded.episode_signature,
				thread_id = excluded.thread_id,
				root_message_id = excluded.root_message_id,
				channel_id = excluded.channel_id,
				lead_id = excluded.lead_id,
				project_name = excluded.project_name,
				event_type = excluded.event_type,
				session_key = excluded.session_key,
				repair_status = excluded.repair_status,
				ticket_status = excluded.ticket_status,
				owner_ref = excluded.owner_ref,
				first_seen_at = excluded.first_seen_at,
				attempt_count = 0,
				acked_at = NULL,
				opened_at = datetime('now'),
				resolved_at = NULL`,
			[
				input.correlationKey,
				input.eventId,
				input.episodeSignature ?? null,
				input.threadId,
				input.rootMessageId ?? null,
				input.channelId,
				input.leadId,
				input.projectName,
				input.eventType,
				input.sessionKey ?? null,
				input.repairStatus ?? null,
				input.ticketStatus ?? null,
				input.ownerRef ?? null,
				input.firstSeenAt ?? null,
			],
		);
		this.save();
	}

	/** FLY-368: the ACTIVE (unresolved) alert thread for a correlation key, if any. */
	getActiveAlertThread(correlationKey: string): AlertThreadRow | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM alert_threads WHERE correlation_key = ? AND resolved_at IS NULL",
		);
		stmt.bind([correlationKey]);
		let out: AlertThreadRow | undefined;
		if (stmt.step()) {
			out = rowToAlertThread(stmt.getAsObject() as Record<string, unknown>);
		}
		stmt.free();
		return out;
	}

	/** FLY-368: all ACTIVE alert threads (the reconcile-pass work list). */
	listActiveAlertThreads(): AlertThreadRow[] {
		const stmt = this.db.prepare(
			"SELECT * FROM alert_threads WHERE resolved_at IS NULL ORDER BY opened_at ASC",
		);
		const out: AlertThreadRow[] = [];
		while (stmt.step()) {
			out.push(rowToAlertThread(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return out;
	}

	/** FLY-368: update repair_status on the active row (pending|fixed|needs_human|n/a). */
	setAlertRepairStatus(correlationKey: string, status: string): void {
		this.db.run(
			"UPDATE alert_threads SET repair_status = ? WHERE correlation_key = ? AND resolved_at IS NULL",
			[status, correlationKey],
		);
		this.save();
	}

	/**
	 * FLY-927 (Task 2.2): set the ticket lifecycle status on the ACTIVE row.
	 * ACK additionally stamps acked_at ONCE (first claim wins — the T2 unclaimed
	 * fallback keys on its absence).
	 */
	setTicketStatus(correlationKey: string, status: string): void {
		this.db.run(
			`UPDATE alert_threads SET
				ticket_status = ?,
				acked_at = CASE WHEN ? = 'ACK' AND acked_at IS NULL THEN datetime('now') ELSE acked_at END
			 WHERE correlation_key = ? AND resolved_at IS NULL`,
			[status, status, correlationKey],
		);
		this.save();
	}

	/** FLY-927 (Task 2.2): consume one ARC attempt toward the T2 (2-try) budget. */
	bumpTicketAttempt(correlationKey: string): void {
		this.db.run(
			"UPDATE alert_threads SET attempt_count = attempt_count + 1 WHERE correlation_key = ? AND resolved_at IS NULL",
			[correlationKey],
		);
		this.save();
	}

	// ── FLY-1082 (Task 2.2): fleet pressure-hold (single durable row) ──

	/**
	 * Place the fleet pressure-hold. IDEMPOTENT: an existing hold is left
	 * untouched (its set_at / attribution wins — first setter owns the
	 * episode). Returns true when THIS call placed the hold.
	 */
	setFleetPressureHold(input: { setBy: string; watermark?: string }): boolean {
		this.db.run(
			"INSERT OR IGNORE INTO fleet_pressure_hold (id, set_by, watermark) VALUES (1, ?, ?)",
			[input.setBy, input.watermark ?? null],
		);
		const changed = this.db.getRowsModified();
		if (changed > 0) this.save();
		return changed > 0;
	}

	/** The active fleet pressure-hold, if any. */
	getFleetPressureHold():
		| { set_by: string; set_at: string; watermark: string | null }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT set_by, set_at, watermark FROM fleet_pressure_hold WHERE id = 1",
		);
		let out:
			| { set_by: string; set_at: string; watermark: string | null }
			| undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			out = {
				set_by: row.set_by as string,
				set_at: row.set_at as string,
				watermark: (row.watermark as string) ?? null,
			};
		}
		stmt.free();
		return out;
	}

	/** Lift the fleet pressure-hold. IDEMPOTENT; true when a hold existed. */
	clearFleetPressureHold(): boolean {
		// NB: the params array is load-bearing — the compat shim only tracks
		// `changes` on the prepared (params !== undefined) path.
		this.db.run("DELETE FROM fleet_pressure_hold WHERE id = 1", []);
		const changed = this.db.getRowsModified();
		if (changed > 0) this.save();
		return changed > 0;
	}

	// ── FLY-1082 (Task 3.2): runbook-gap ledger ──

	/** Append one escalation event for the kind (the 7-day window counter). */
	recordTicketEscalation(kind: string): void {
		this.db.run("INSERT INTO ticket_escalations (kind) VALUES (?)", [kind]);
		this.save();
	}

	/** Escalation events for the kind within the last `days` days. */
	countTicketEscalations(kind: string, days: number): number {
		const stmt = this.db.prepare(
			"SELECT COUNT(*) AS n FROM ticket_escalations WHERE kind = ? AND escalated_at >= datetime('now', ?)",
		);
		stmt.bind([kind, `-${days} days`]);
		let n = 0;
		if (stmt.step()) {
			n = Number((stmt.getAsObject() as Record<string, unknown>).n ?? 0);
		}
		stmt.free();
		return n;
	}

	/** Clear the kind's escalation window (the runbook issue was closed —
	 * counting starts over). */
	clearTicketEscalations(kind: string): void {
		this.db.run("DELETE FROM ticket_escalations WHERE kind = ?", [kind]);
		this.save();
	}

	/** The kind's open runbook issue (dedup: at most one per kind). */
	getRunbookIssue(
		kind: string,
	): { issue_id: string; issue_identifier: string | null } | undefined {
		const stmt = this.db.prepare(
			"SELECT issue_id, issue_identifier FROM runbook_issues WHERE kind = ?",
		);
		stmt.bind([kind]);
		let out: { issue_id: string; issue_identifier: string | null } | undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			out = {
				issue_id: row.issue_id as string,
				issue_identifier: (row.issue_identifier as string) ?? null,
			};
		}
		stmt.free();
		return out;
	}

	setRunbookIssue(kind: string, issueId: string, identifier?: string): void {
		this.db.run(
			`INSERT INTO runbook_issues (kind, issue_id, issue_identifier) VALUES (?, ?, ?)
			 ON CONFLICT(kind) DO UPDATE SET issue_id = excluded.issue_id,
				issue_identifier = excluded.issue_identifier,
				created_at = datetime('now')`,
			[kind, issueId, identifier ?? null],
		);
		this.save();
	}

	clearRunbookIssue(kind: string): void {
		this.db.run("DELETE FROM runbook_issues WHERE kind = ?", [kind]);
		this.save();
	}

	// ── FLY-1082 (Task 2.3, Codex R3/R4/R5): server-loss episode ledger ──

	/** Write (arm or update) the episode row — full side-effect state (shape,
	 * claimed ids, per-Lead notification outbox, ticket phase). Idempotent. */
	setServerLossEpisode(signature: string, state: ServerLossEpisodeState): void {
		this.db.run(
			`INSERT INTO server_loss_episode (id, signature, state_json) VALUES (1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET signature = excluded.signature,
				state_json = excluded.state_json`,
			[signature, JSON.stringify(state)],
		);
		this.save();
	}

	getServerLossEpisode():
		| { signature: string; state: ServerLossEpisodeState }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT signature, state_json FROM server_loss_episode WHERE id = 1",
		);
		let out: { signature: string; state: ServerLossEpisodeState } | undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			const strings = (v: unknown): string[] =>
				Array.isArray(v)
					? v.filter((x): x is string => typeof x === "string")
					: [];
			let state: ServerLossEpisodeState;
			try {
				const parsed = JSON.parse(row.state_json as string) as Record<
					string,
					unknown
				>;
				state = {
					shape:
						parsed.shape === "server_fresh" ? "server_fresh" : "server_down",
					claimed: strings(parsed.claimed),
					ticketDone: parsed.ticketDone === true,
					notifiedLeads: strings(parsed.notifiedLeads),
					failedLeads: strings(parsed.failedLeads),
					notifyAttempts:
						parsed.notifyAttempts && typeof parsed.notifyAttempts === "object"
							? (parsed.notifyAttempts as Record<string, number>)
							: {},
				};
			} catch {
				state = {
					shape: "server_down",
					claimed: [],
					ticketDone: false,
					notifiedLeads: [],
					failedLeads: [],
					notifyAttempts: {},
				};
			}
			out = { signature: row.signature as string, state };
		}
		stmt.free();
		return out;
	}

	clearServerLossEpisode(): void {
		this.db.run("DELETE FROM server_loss_episode WHERE id = 1", []);
		this.save();
	}

	// ── FLY-1285: durable tmux holds ────────────────────────────────

	getOrCreateActiveTmuxHold(
		normalizedSocketPath: string,
		observation: TmuxHoldObservation,
	): TmuxHoldRow {
		const transact = this.db.raw.transaction(() => {
			const activeRaw = this.db.raw
				.prepare(
					"SELECT * FROM tmux_hold WHERE normalized_socket_path = ? AND resolved_at IS NULL",
				)
				.get(normalizedSocketPath) as Record<string, unknown> | undefined;
			if (observation.incidentId) {
				if (!activeRaw) {
					throw new Error("tmux hold incident is resolved or stale");
				}
				if (activeRaw.incident_id !== observation.incidentId) {
					throw new Error("tmux hold incident id mismatch");
				}
			}

			const now = new Date().toISOString();
			if (!activeRaw) {
				const incidentId = randomUUID();
				const evidence = { ...observation.evidence };
				if (
					Number.isSafeInteger(evidence.originalServerPid) &&
					(evidence.originalServerPid as number) > 0 &&
					evidence.source === "supervisor_archive"
				) {
					evidence.originalServerPidSource = "supervisor_archive";
				}
				this.db.raw
					.prepare(
						`INSERT INTO tmux_hold (
							incident_id, normalized_socket_path, shape, shape_source,
							current_reason, first_reason, reason_history_json,
							evidence_json, affected_execution_ids_json,
							created_at, last_checked_at, resolved_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
					)
					.run(
						incidentId,
						normalizedSocketPath,
						observation.shape,
						observation.shapeSource,
						observation.reason,
						observation.reason,
						JSON.stringify([observation.reason]),
						JSON.stringify(evidence),
						JSON.stringify([...new Set(observation.affectedExecutionIds)]),
						now,
						now,
					);
			} else {
				const active = rowToTmuxHold(activeRaw);
				const reasonHistory = active.reasonHistory.includes(observation.reason)
					? active.reasonHistory
					: [...active.reasonHistory, observation.reason];
				const evidence = { ...active.evidence, ...observation.evidence };
				if (active.evidence.originalServerPid !== undefined) {
					evidence.originalServerPid = active.evidence.originalServerPid;
					evidence.originalServerPidSource =
						active.evidence.originalServerPidSource ?? "supervisor_archive";
				}
				const affected = [
					...new Set([
						...active.affectedExecutionIds,
						...observation.affectedExecutionIds,
					]),
				];
				const canSetShape =
					active.shape === "provisional" &&
					observation.shape !== "provisional" &&
					observation.shapeSource === "coordinator";
				this.db.raw
					.prepare(
						`UPDATE tmux_hold SET
							shape = ?, shape_source = ?, current_reason = ?,
							reason_history_json = ?, evidence_json = ?,
							affected_execution_ids_json = ?, last_checked_at = ?
						 WHERE incident_id = ? AND resolved_at IS NULL`,
					)
					.run(
						canSetShape ? observation.shape : active.shape,
						canSetShape ? observation.shapeSource : active.shapeSource,
						observation.reason,
						JSON.stringify(reasonHistory),
						JSON.stringify(evidence),
						JSON.stringify(affected),
						now,
						active.incidentId,
					);
			}

			const row = this.db.raw
				.prepare(
					"SELECT * FROM tmux_hold WHERE normalized_socket_path = ? AND resolved_at IS NULL",
				)
				.get(normalizedSocketPath) as Record<string, unknown> | undefined;
			if (!row) throw new Error("tmux hold transaction produced no active row");
			return rowToTmuxHold(row);
		});
		const result = transact();
		this.save();
		return result;
	}

	getActiveTmuxHold(normalizedSocketPath: string): TmuxHoldRow | undefined {
		const row = this.db.raw
			.prepare(
				"SELECT * FROM tmux_hold WHERE normalized_socket_path = ? AND resolved_at IS NULL",
			)
			.get(normalizedSocketPath) as Record<string, unknown> | undefined;
		return row ? rowToTmuxHold(row) : undefined;
	}

	listActiveTmuxHolds(): TmuxHoldRow[] {
		return (
			this.db.raw
				.prepare(
					"SELECT * FROM tmux_hold WHERE resolved_at IS NULL ORDER BY created_at",
				)
				.all() as Record<string, unknown>[]
		).map(rowToTmuxHold);
	}

	listTmuxHoldHistory(normalizedSocketPath: string): TmuxHoldRow[] {
		return (
			this.db.raw
				.prepare(
					"SELECT * FROM tmux_hold WHERE normalized_socket_path = ? ORDER BY created_at",
				)
				.all(normalizedSocketPath) as Record<string, unknown>[]
		).map(rowToTmuxHold);
	}

	resolveTmuxHold(normalizedSocketPath: string, incidentId: string): boolean {
		const now = new Date().toISOString();
		const info = this.db.raw
			.prepare(
				`UPDATE tmux_hold SET resolved_at = ?, last_checked_at = ?
				 WHERE normalized_socket_path = ? AND incident_id = ? AND resolved_at IS NULL`,
			)
			.run(now, now, normalizedSocketPath, incidentId);
		this.save();
		return info.changes === 1;
	}

	replaceActiveTmuxHoldAffectedExecutionIds(
		normalizedSocketPath: string,
		incidentId: string,
		affectedExecutionIds: string[],
	): boolean {
		const info = this.db.raw
			.prepare(
				`UPDATE tmux_hold SET affected_execution_ids_json = ?, last_checked_at = ?
				 WHERE normalized_socket_path = ? AND incident_id = ? AND resolved_at IS NULL`,
			)
			.run(
				JSON.stringify([...new Set(affectedExecutionIds)]),
				new Date().toISOString(),
				normalizedSocketPath,
				incidentId,
			);
		if (info.changes === 1) this.save();
		return info.changes === 1;
	}

	/**
	 * Atomically convert one positively-shaped hold into the existing durable
	 * server-loss outbox intent. No migration/notification side effect runs in
	 * this SQLite transaction; ServerLossCoordinator replays those afterward.
	 */
	transitionTmuxHoldToServerLossEpisode(
		input: TmuxHoldToServerLossTransition,
	): boolean {
		const transact = this.db.raw.transaction(() => {
			const activeRaw = this.db.raw
				.prepare(
					`SELECT * FROM tmux_hold
					 WHERE normalized_socket_path = ? AND incident_id = ? AND resolved_at IS NULL`,
				)
				.get(input.normalizedSocketPath, input.incidentId) as
				| Record<string, unknown>
				| undefined;
			if (!activeRaw) return false;
			const active = rowToTmuxHold(activeRaw);
			if (active.shape === "provisional") {
				throw new Error("provisional tmux hold cannot arm server-loss episode");
			}
			if (active.shape !== input.shape) {
				throw new Error(
					`tmux hold shape mismatch: active=${active.shape} requested=${input.shape}`,
				);
			}

			const existing = this.getServerLossEpisode();
			let state: ServerLossEpisodeState;
			if (existing) {
				// The singleton outbox can merge only the exact incident while still
				// open. A completed or unrelated episode must drain first.
				if (
					existing.signature !== input.incidentId ||
					existing.state.ticketDone
				) {
					return false;
				}
				const oldClaimed = new Set(existing.state.claimed);
				const claimed = [
					...new Set([...existing.state.claimed, ...input.claimedExecutionIds]),
				];
				const affectedLeads = new Set(
					input.claimedExecutionIds
						.filter((id) => !oldClaimed.has(id))
						.map((id) => input.leadIdsByExecutionId[id])
						.filter((id): id is string => !!id),
				);
				state = {
					...existing.state,
					claimed,
					notifiedLeads: existing.state.notifiedLeads.filter(
						(leadId) => !affectedLeads.has(leadId),
					),
					failedLeads: existing.state.failedLeads.filter(
						(leadId) => !affectedLeads.has(leadId),
					),
					notifyAttempts: Object.fromEntries(
						Object.entries(existing.state.notifyAttempts).filter(
							([leadId]) => !affectedLeads.has(leadId),
						),
					),
				};
			} else {
				state = {
					shape: input.shape,
					claimed: [...new Set(input.claimedExecutionIds)],
					ticketDone: false,
					notifiedLeads: [],
					failedLeads: [],
					notifyAttempts: {},
				};
			}

			const stamp = new Date().toISOString();
			const resolved = this.db.raw
				.prepare(
					`UPDATE tmux_hold SET resolved_at = ?, last_checked_at = ?
					 WHERE normalized_socket_path = ? AND incident_id = ? AND resolved_at IS NULL`,
				)
				.run(stamp, stamp, input.normalizedSocketPath, input.incidentId);
			if (resolved.changes !== 1) {
				throw new Error("tmux hold transition lost its active row");
			}
			this.db.raw
				.prepare(
					`INSERT INTO server_loss_episode (id, signature, state_json) VALUES (1, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET signature = excluded.signature,
						state_json = excluded.state_json`,
				)
				.run(input.incidentId, JSON.stringify(state));
			return true;
		});
		const transitioned = transact();
		if (transitioned) this.save();
		return transitioned;
	}

	/**
	 * FLY-927 (Task 2.2): active tickets still at NEW whose first-seen is older
	 * than `ms` — the T2 unclaimed-fallback work list. Legacy rows (NULL
	 * ticket_status) never match.
	 */
	getUnackedTicketsOlderThan(ms: number): AlertThreadRow[] {
		const stmt = this.db.prepare(
			`SELECT * FROM alert_threads
			 WHERE resolved_at IS NULL AND ticket_status = 'NEW'
			   AND first_seen_at IS NOT NULL
			   AND first_seen_at <= datetime('now', ?)`,
		);
		stmt.bind([`-${Math.max(0, Math.floor(ms / 1000))} seconds`]);
		const out: AlertThreadRow[] = [];
		while (stmt.step()) {
			out.push(rowToAlertThread(stmt.getAsObject() as Record<string, unknown>));
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-927 (Task 2.3 ACK correlation): the ACTIVE row for an exact event id.
	 * A stale episode's event id never matches the active row (episode replace
	 * overwrites event_id), so an action callback can never ACK the wrong episode.
	 */
	getActiveAlertThreadByEventId(eventId: string): AlertThreadRow | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM alert_threads WHERE event_id = ? AND resolved_at IS NULL",
		);
		stmt.bind([eventId]);
		let out: AlertThreadRow | undefined;
		if (stmt.step()) {
			out = rowToAlertThread(stmt.getAsObject() as Record<string, unknown>);
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-927 (Task 2.3 ACK correlation): the ACTIVE row for a (lead, kind) pair
	 * — the rescue route's correlation input. Exact-match only; ambiguity is
	 * impossible because correlation_key is the PK and includes both fields.
	 */
	getActiveAlertThreadByLeadAndType(
		leadId: string,
		eventType: string,
	): AlertThreadRow | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM alert_threads WHERE lead_id = ? AND event_type = ? AND resolved_at IS NULL",
		);
		stmt.bind([leadId, eventType]);
		let out: AlertThreadRow | undefined;
		if (stmt.step()) {
			out = rowToAlertThread(stmt.getAsObject() as Record<string, unknown>);
		}
		stmt.free();
		return out;
	}

	/** FLY-368: mark the active alert thread resolved (recovery confirmed). */
	resolveAlertThread(correlationKey: string): void {
		this.db.run(
			"UPDATE alert_threads SET resolved_at = datetime('now') WHERE correlation_key = ? AND resolved_at IS NULL",
			[correlationKey],
		);
		this.save();
	}

	/**
	 * FLY-818 M3: record whether a genuine founder page landed for a stuck
	 * escalation eventId. MONOTONIC (Codex R2#2 / Lead Q3): once a real page
	 * succeeds (`paged=true`), it stays true so a later confirmed-duplicate
	 * resolves the detector (converge — at-least-once + eventually stop). A `false`
	 * (page failed / not yet delivered) never downgrades a prior `true`.
	 */
	recordFounderPaged(eventId: string, paged: boolean): void {
		this.db.run(
			`INSERT INTO founder_page_ledger (event_id, paged, ts)
			 VALUES (?, ?, datetime('now'))
			 ON CONFLICT(event_id) DO UPDATE SET
			   paged = MAX(founder_page_ledger.paged, excluded.paged),
			   ts = excluded.ts`,
			[eventId, paged ? 1 : 0],
		);
		this.save();
	}

	/**
	 * FLY-818 M3: the recorded founder-page outcome for a stuck escalation eventId,
	 * or undefined if none recorded yet. Consulted on the duplicate/queued
	 * early-return paths so `alertUnhandled` gates on the REAL delivery, not a
	 * claims.db dedup.
	 */
	getFounderPaged(eventId: string): boolean | undefined {
		const stmt = this.db.prepare(
			"SELECT paged FROM founder_page_ledger WHERE event_id = ?",
		);
		stmt.bind([eventId]);
		let out: boolean | undefined;
		if (stmt.step()) {
			out = Number((stmt.getAsObject() as { paged: number }).paged) === 1;
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-368: append a durable auto-repair attempt audit row. Returns true on
	 * success, false on write failure — callers treat false as FAIL-CLOSED (no
	 * keystroke is sent unless the `attempt` row persisted).
	 */
	recordAlertRepairAttempt(input: {
		correlationKey: string;
		eventId?: string | null;
		actor: string;
		action: string;
		leadId?: string | null;
		projectName?: string | null;
		result: "attempt" | "sent" | "refused";
		reason?: string | null;
	}): boolean {
		try {
			this.db.run(
				`INSERT INTO alert_repair_attempts (
					correlation_key, event_id, actor, action, lead_id, project_name, result, reason
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					input.correlationKey,
					input.eventId ?? null,
					input.actor,
					input.action,
					input.leadId ?? null,
					input.projectName ?? null,
					input.result,
					input.reason ?? null,
				],
			);
			this.save();
			return true;
		} catch {
			return false;
		}
	}

	// ── FLY-314: roundtable_topic_threads (separate from chat_threads) ──────────

	/**
	 * FLY-314: record a roundtable topic thread. `threadId` MUST equal the source
	 * Discord message id (the "start thread from message" invariant), which is also
	 * the crash-recovery anchor. Idempotent on thread_id.
	 */
	upsertRoundtableTopicThread(input: {
		threadId: string;
		channelId: string;
		sourceMessageId: string;
		authorId?: string;
		triggerMode?: string;
	}): void {
		this.db.run(
			`INSERT INTO roundtable_topic_threads
				(thread_id, channel_id, source_message_id, author_id, trigger_mode)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(thread_id) DO UPDATE SET
				channel_id = excluded.channel_id,
				source_message_id = excluded.source_message_id,
				author_id = excluded.author_id,
				trigger_mode = excluded.trigger_mode`,
			[
				input.threadId,
				input.channelId,
				input.sourceMessageId,
				input.authorId ?? null,
				input.triggerMode ?? null,
			],
		);
		this.save();
	}

	/** FLY-314: dedup lookup by (channel, source message). Excludes rows marked
	 * discord_missing so a deleted thread can be re-created if the topic recurs. */
	getRoundtableTopicThread(
		channelId: string,
		sourceMessageId: string,
	):
		| {
				thread_id: string;
				channel_id: string;
				source_message_id: string;
				author_id: string | null;
				archived_at: string | null;
		  }
		| undefined {
		const stmt = this.db.prepare(
			"SELECT thread_id, channel_id, source_message_id, author_id, archived_at FROM roundtable_topic_threads WHERE channel_id = ? AND source_message_id = ? AND discord_missing_at IS NULL",
		);
		stmt.bind([channelId, sourceMessageId]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			stmt.free();
			return {
				thread_id: row.thread_id as string,
				channel_id: row.channel_id as string,
				source_message_id: row.source_message_id as string,
				author_id: (row.author_id as string) ?? null,
				archived_at: (row.archived_at as string) ?? null,
			};
		}
		stmt.free();
		return undefined;
	}

	/** FLY-314: mark a roundtable topic thread missing (Discord 404). */
	markRoundtableTopicThreadMissing(threadId: string): void {
		this.db.run(
			"UPDATE roundtable_topic_threads SET discord_missing_at = datetime('now') WHERE thread_id = ?",
			[threadId],
		);
		this.save();
	}

	private rowToSession(row: Record<string, unknown>): Session {
		return {
			execution_id: row.execution_id as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			status: row.status as string,
			terminal_at: (row.terminal_at as string) ?? undefined,
			issue_identifier: (row.issue_identifier as string) ?? undefined,
			issue_title: (row.issue_title as string) ?? undefined,
			started_at: (row.started_at as string) ?? undefined,
			last_activity_at: (row.last_activity_at as string) ?? undefined,
			tmux_session: (row.tmux_session as string) ?? undefined,
			worktree_path: (row.worktree_path as string) ?? undefined,
			branch: (row.branch as string) ?? undefined,
			last_error: (row.last_error as string) ?? undefined,
			decision_route: (row.decision_route as string) ?? undefined,
			decision_reasoning: (row.decision_reasoning as string) ?? undefined,
			cost_usd: (row.cost_usd as number) ?? undefined,
			commit_count: (row.commit_count as number) ?? undefined,
			files_changed: (row.files_changed as number) ?? undefined,
			lines_added: (row.lines_added as number) ?? undefined,
			lines_removed: (row.lines_removed as number) ?? undefined,
			summary: (row.summary as string) ?? undefined,
			diff_summary: (row.diff_summary as string) ?? undefined,
			commit_messages: (row.commit_messages as string) ?? undefined,
			changed_file_paths: (row.changed_file_paths as string) ?? undefined,
			session_params: (row.session_params as string) ?? undefined,
			heartbeat_at: (row.heartbeat_at as string) ?? undefined,
			adapter_type: (row.adapter_type as string) ?? undefined,
			// FLY-728: resolved runner model (per-issue model routing visibility).
			runner_model: (row.runner_model as string) ?? undefined,
			dispatch_model: (row.dispatch_model as string) ?? undefined,
			design_backend: isDesignBackend(row.design_backend)
				? row.design_backend
				: undefined,
			ponytail_condition: (row.ponytail_condition as string) ?? undefined,
			skill_framework_mode: isSkillFrameworkMode(row.skill_framework_mode)
				? row.skill_framework_mode
				: undefined,
			skill_framework_mode_via: isSkillFrameworkVia(
				row.skill_framework_mode_via,
			)
				? row.skill_framework_mode_via
				: undefined,
			run_attempt: (row.run_attempt as number) ?? undefined,
			retry_predecessor: (row.retry_predecessor as string) ?? undefined,
			retry_successor: (row.retry_successor as string) ?? undefined,
			issue_labels: (row.issue_labels as string) ?? undefined,
			pr_number: (row.pr_number as number) ?? undefined,
			pr_head_sha: (row.pr_head_sha as string) ?? undefined,
			session_stage: (row.session_stage as string) ?? undefined,
			stage_updated_at: (row.stage_updated_at as string) ?? undefined,
			session_role: (row.session_role as string) ?? undefined,
			// FLY-137 Phase 5: agent dispatch + Codex auto-trigger persistence
			agent_name: (row.agent_name as string) ?? undefined,
			agent_match_method: (row.agent_match_method as string) ?? undefined,
			plan_path: (row.plan_path as string) ?? undefined,
			codex_skip: row.codex_skip ? !!(row.codex_skip as number) : undefined,
			// FLY-191 Phase 2: review-timeout anchor + dedup stamp + review binding
			awaiting_review_entered_at:
				(row.awaiting_review_entered_at as string) ?? undefined,
			gate_timeout_notified_at:
				(row.gate_timeout_notified_at as string) ?? undefined,
			review_question_id: (row.review_question_id as string) ?? undefined,
			// FLY-205: doc-flow tier + Linear URL (retry continuity)
			doc_tier: (row.doc_tier as string) ?? undefined,
			issue_url: (row.issue_url as string) ?? undefined,
			// FLY-793 (Step 11): persisted chat-thread role. NOT NULL DEFAULT 'main',
			// so a real row is always a string; coerce a missing column (pre-migration
			// snapshot) to 'main' too, so every reader can trust it.
			chat_thread_role: (row.chat_thread_role as string) ?? "main",
			workflow_node_id: (row.workflow_node_id as string) ?? undefined,
			// FLY-598: founder-facing UX gate flag + sign-off record
			founder_facing_ux: row.founder_facing_ux
				? !!(row.founder_facing_ux as number)
				: undefined,
			founder_ux_signoff_json:
				(row.founder_ux_signoff_json as string) ?? undefined,
			founder_ux_gate_mode: (row.founder_ux_gate_mode as string) ?? undefined,
			// FLY-869 A-1: QA-required snapshot (numeric 0/1; undefined = never evaluated).
			qa_required:
				typeof row.qa_required === "number"
					? row.qa_required
					: row.qa_required == null
						? undefined
						: Number(row.qa_required),
			qa_required_reason: (row.qa_required_reason as string) ?? undefined,
			// FLY-869 B-3: merged-but-unapproved park marker.
			merge_block_reason: (row.merge_block_reason as string) ?? undefined,
			merge_block_head: (row.merge_block_head as string) ?? undefined,
			merge_block_at: (row.merge_block_at as string) ?? undefined,
			// FLY-245 D-a: monotonic lifecycle revision (defaults 0).
			lifecycle_revision:
				typeof row.lifecycle_revision === "number" ? row.lifecycle_revision : 0,
		};
	}

	/**
	 * FLY-175: minimal session shape the founder-consent evaluator needs.
	 * Avoids the middleware reaching into the full Session row + parses the
	 * label snapshot into a string array. Returns undefined if no session.
	 */
	getSessionForConsentLookup(executionId: string):
		| {
				issue_id: string;
				issue_identifier?: string;
				project_name: string;
				session_role?: string;
				session_status: string;
				issue_labels: string[];
				pr_number?: number;
				pr_head_sha?: string;
		  }
		| undefined {
		const s = this.getSession(executionId);
		if (!s) return undefined;
		let labels: string[] = [];
		if (s.issue_labels) {
			try {
				const parsed = JSON.parse(s.issue_labels);
				if (Array.isArray(parsed)) labels = parsed.map((x) => String(x));
			} catch {
				/* malformed snapshot — treat as no labels */
			}
		}
		return {
			issue_id: s.issue_id,
			issue_identifier: s.issue_identifier,
			project_name: s.project_name,
			session_role: s.session_role,
			session_status: s.status,
			issue_labels: labels,
			pr_number: s.pr_number,
			pr_head_sha: s.pr_head_sha,
		};
	}

	// --- GEO-195: Lead Event Journal ---

	/** Append a lead event. Returns seq. Dedup on (lead_id, event_id). */
	appendLeadEvent(
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey?: string,
	): number {
		let hookPayload: HookPayload | null = null;
		try {
			const parsed = JSON.parse(payload) as unknown;
			if (parsed && typeof parsed === "object") {
				hookPayload = parsed as HookPayload;
			}
		} catch {
			// Non-HookPayload journal rows remain ACK-exempt for byte compatibility.
		}
		const ackPolicy = hookPayload
			? ackPolicyForLeadEvent(eventType, hookPayload)
			: null;
		const routingSnapshot = hookPayload
			? JSON.stringify(routingSnapshotForLeadEvent(leadId, hookPayload))
			: null;
		try {
			this.db.run(
				`INSERT INTO lead_events (
				   lead_id, event_id, event_type, payload, session_key,
				   ack_required, ack_policy, ack_protocol_version,
				   routing_snapshot, ack_owner_lead_id
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					leadId,
					eventId,
					eventType,
					payload,
					sessionKey ?? null,
					ackPolicy ? 1 : 0,
					ackPolicy,
					ackPolicy ? 1 : null,
					routingSnapshot,
					leadId,
				],
			);
		} catch (err) {
			// UNIQUE constraint → duplicate
			if ((err as Error).message?.includes("UNIQUE")) {
				const existing = this.db.exec(
					"SELECT seq FROM lead_events WHERE lead_id = ? AND event_id = ?",
					[leadId, eventId],
				);
				return (existing[0]?.values[0]?.[0] as number) ?? 0;
			}
			throw err;
		}
		const result = this.db.exec("SELECT last_insert_rowid()");
		return (result[0]?.values[0]?.[0] as number) ?? 0;
	}

	/**
	 * FLY-83: attempt to claim a (leadId, eventId) slot.
	 * Returns true if this caller wrote the row, false if it already existed.
	 *
	 * Uses a SELECT COUNT(*) pre-check + appendLeadEvent. Not atomic in the
	 * SQL sense, but sql.js is single-threaded inside the Bridge process, so
	 * no two JS callers interleave. Cross-process races (shell alert script
	 * vs Bridge) live in a separate `claims.db` (see scripts/lead-alert.sh),
	 * not in lead_events.
	 *
	 * `appendLeadEvent` alone cannot answer this question: on UNIQUE conflict
	 * it returns the existing seq (still non-zero), so a "got a seq back"
	 * return is indistinguishable from a fresh insert.
	 */
	tryClaimLeadEvent(
		leadId: string,
		eventId: string,
		eventType: string,
		payload: string,
		sessionKey?: string,
	): boolean {
		const existing = this.dbQuery(
			"SELECT COUNT(*) FROM lead_events WHERE lead_id = ? AND event_id = ?",
			[leadId, eventId],
		);
		const count = (existing[0]?.values[0]?.[0] as number) ?? 0;
		if (count > 0) return false;
		this.appendLeadEvent(leadId, eventId, eventType, payload, sessionKey);
		return true;
	}

	/**
	 * FLY-1018: transactional outbox pair for a ship-approval REQUEST
	 * (plan §2.8 ②). The `ship_approval_request` lead event and its
	 * `ship_approval_requests` row commit together or not at all — zero
	 * orphan lead events, zero half-written request rows. Runtime delivery
	 * must only start AFTER this returns (post-commit); redelivery of a
	 * queued-but-undelivered event is owned by the HeartbeatService loop
	 * via RETRYABLE_LEAD_EVENT_TYPES.
	 *
	 * Returns the lead_events seq of the queued event. Throws (with the
	 * whole transaction rolled back) if either write fails.
	 */
	recordShipApprovalRequest(req: {
		requestId: string;
		prUrl: string;
		projectName: string;
		leadId: string;
		requester: string;
		summary: string;
		eventId: string;
		payload: string;
	}): number {
		let seq = 0;
		this.db.transaction(() => {
			seq = this.appendLeadEvent(
				req.leadId,
				req.eventId,
				"ship_approval_request",
				req.payload,
			);
			this.db.run(
				`INSERT INTO ship_approval_requests
				 (request_id, pr_url, project_name, lead_id, requester, summary, lead_event_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					req.requestId,
					req.prUrl,
					req.projectName,
					req.leadId,
					req.requester,
					req.summary,
					req.eventId,
				],
			);
		});
		return seq;
	}

	/**
	 * FLY-1018: idempotency lookup (plan §2.8 ①). Because the request row
	 * commits in the same transaction as its lead event, row existence ⟺
	 * the founder-visible event is durably queued — a row here means the
	 * same prUrl is already pending and must not be re-queued. Rows from
	 * attempts whose transaction failed never exist, so a retry after a
	 * 502 is never swallowed.
	 */
	findRecentShipApprovalRequest(
		prUrl: string,
		withinMs: number,
	): { requestId: string } | null {
		const seconds = Math.max(1, Math.floor(withinMs / 1000));
		const rows = this.dbQuery(
			`SELECT request_id FROM ship_approval_requests
			 WHERE pr_url = ? AND created_at > datetime('now', ?)
			 ORDER BY created_at DESC LIMIT 1`,
			[prUrl, `-${seconds} seconds`],
		);
		const requestId = rows[0]?.values[0]?.[0];
		return typeof requestId === "string" ? { requestId } : null;
	}

	/** FLY-1018: test/observability helper — count ship_approval_request lead events. */
	countLeadEvents(leadId: string, eventType: string): number {
		const rows = this.dbQuery(
			"SELECT COUNT(*) FROM lead_events WHERE lead_id = ? AND event_type = ?",
			[leadId, eventType],
		);
		return (rows[0]?.values[0]?.[0] as number) ?? 0;
	}

	private dbQuery(
		sql: string,
		params: (string | number | null)[],
	): { values: unknown[][] }[] {
		return this.db.exec(sql, params) as { values: unknown[][] }[];
	}

	/** Mark a lead event as delivered. */
	markLeadEventDelivered(seq: number): void {
		this.db.run(
			"UPDATE lead_events SET delivered_at = datetime('now') WHERE seq = ?",
			[seq],
		);
	}

	/** Get recently delivered events within a time window (for bootstrap). */
	getRecentDeliveredEvents(
		leadId: string,
		windowMinutes: number,
	): LeadEventRow[] {
		const result = this.db.exec(
			`SELECT seq, lead_id, event_id, event_type, payload, session_key, delivered_at, created_at
			 FROM lead_events
			 WHERE lead_id = ? AND delivered_at IS NOT NULL
			   AND delivered_at > datetime('now', ?)
			 ORDER BY seq ASC`,
			[leadId, `-${windowMinutes} minutes`],
		);
		if (result.length === 0) return [];
		return result[0]!.values.map((row) => ({
			seq: row[0] as number,
			lead_id: row[1] as string,
			event_id: row[2] as string,
			event_type: row[3] as string,
			payload: row[4] as string,
			session_key: (row[5] as string) ?? undefined,
			delivered_at: (row[6] as string) ?? undefined,
			created_at: row[7] as string,
		}));
	}

	/** Get the highest delivered seq for a lead (for health checks). */
	getLastDeliveredSeq(leadId: string): number {
		const result = this.db.exec(
			`SELECT MAX(seq) FROM lead_events WHERE lead_id = ? AND delivered_at IS NOT NULL`,
			[leadId],
		);
		return (result[0]?.values[0]?.[0] as number) ?? 0;
	}

	/** FLY-62: Check if a lead event has been successfully delivered. */
	isLeadEventDelivered(leadId: string, eventId: string): boolean {
		const rows = this.db.exec(
			`SELECT 1 FROM lead_events
			 WHERE lead_id = ? AND event_id = ? AND delivered_at IS NOT NULL
			 LIMIT 1`,
			[leadId, eventId],
		);
		return rows.length > 0 && (rows[0]?.values?.length ?? 0) > 0;
	}

	getLeadEventBySeq(seq: number): LeadEventRow | null {
		const row = this.db.raw
			.prepare("SELECT * FROM lead_events WHERE seq = ?")
			.get(seq) as Record<string, unknown> | undefined;
		return row ? mapLeadEventRow(row) : null;
	}

	listUndeliveredLeadEvents(limit = 10_000): LeadEventRow[] {
		return (
			this.db.raw
				.prepare(
					`SELECT * FROM lead_events
					 WHERE delivered_at IS NULL ORDER BY seq LIMIT ?`,
				)
				.all(limit) as Record<string, unknown>[]
		).map(mapLeadEventRow);
	}

	/** FLY-1373 cutover: permanently retire the superseded ACK state machine. */
	retireOpenLeadEventAcks(nowIso: string, reason: string): number {
		let retired = 0;
		this.db.transaction(() => {
			const rows = this.db.raw
				.prepare(
					`SELECT seq FROM lead_events
					 WHERE ack_required = 1 AND acked_at IS NULL
					   AND ack_retired_at IS NULL`,
				)
				.all() as Array<{ seq: number }>;
			if (rows.length === 0) return;
			const seqs = rows.map(({ seq }) => seq);
			// Stay well below every supported SQLite variable limit. A long-lived
			// deployment can have far more than 999 open legacy rows at cutover.
			for (let offset = 0; offset < seqs.length; offset += 500) {
				const chunk = seqs.slice(offset, offset + 500);
				const placeholders = chunk.map(() => "?").join(",");
				retired += this.db.raw
					.prepare(
						`UPDATE lead_events SET
						   ack_retired_at = ?, ack_retired_reason = ?,
						   pending_delivery_reason = NULL,
						   dead_letter_pending_at = NULL,
						   page_claim_token = NULL,
						   page_claim_lease_expires_at = NULL
						 WHERE seq IN (${placeholders}) AND ack_retired_at IS NULL`,
					)
					.run(nowIso, reason, ...chunk).changes;
				this.db.raw
					.prepare(
						`UPDATE lead_event_delivery_attempts SET retired_at = COALESCE(retired_at, ?)
						 WHERE event_seq IN (${placeholders}) AND retired_at IS NULL`,
					)
					.run(nowIso, ...chunk);
			}
		});
		return retired;
	}

	listOpenAckLeadEvents(limit = 100): LeadEventRow[] {
		const rows = this.db.raw
			.prepare(
				`SELECT * FROM lead_events
				 WHERE ack_required = 1 AND ack_protocol_version IS NOT NULL
				   AND ack_retired_at IS NULL
				   AND acked_at IS NULL AND dead_lettered_at IS NULL
				 ORDER BY seq LIMIT ?`,
			)
			.all(limit) as Record<string, unknown>[];
		return rows.map(mapLeadEventRow);
	}

	listLateAckLeadEvents(nowIso: string, limit = 100): LeadEventRow[] {
		const rows = this.db.raw
			.prepare(
				`SELECT * FROM lead_events
				 WHERE ack_required = 1 AND ack_protocol_version IS NOT NULL
				   AND ack_retired_at IS NULL
				   AND acked_at IS NULL AND dead_lettered_at IS NOT NULL
				   AND ack_token_valid_until > ?
				 ORDER BY seq LIMIT ?`,
			)
			.all(nowIso, limit) as Record<string, unknown>[];
		return rows.map(mapLeadEventRow);
	}

	listExpiredAckIngressRows(nowIso: string, limit = 100): LeadEventRow[] {
		const rows = this.db.raw
			.prepare(
				`SELECT * FROM lead_events
				 WHERE ack_required = 1 AND dead_lettered_at IS NOT NULL
				   AND ack_retired_at IS NULL
				   AND ack_token_valid_until <= ? AND ingress_disposed_at IS NULL
				 ORDER BY seq LIMIT ?`,
			)
			.all(nowIso, limit) as Record<string, unknown>[];
		return rows.map(mapLeadEventRow);
	}

	markLeadEventIngressDisposed(seq: number, nowIso: string): boolean {
		return (
			this.db.raw
				.prepare(
					`UPDATE lead_events SET ingress_disposed_at = ?
					 WHERE seq = ? AND dead_lettered_at IS NOT NULL
					   AND ack_retired_at IS NULL
					   AND ingress_disposed_at IS NULL`,
				)
				.run(nowIso, seq).changes === 1
		);
	}

	listLeadEventDeliveryAttempts(
		eventSeq: number,
	): LeadEventDeliveryAttemptRow[] {
		return this.db.raw
			.prepare(
				`SELECT * FROM lead_event_delivery_attempts
				 WHERE event_seq = ? ORDER BY attempt_no`,
			)
			.all(eventSeq) as LeadEventDeliveryAttemptRow[];
	}

	setActiveDeliverySecretId(secretId: string): void {
		this.db.transaction(() => {
			const current = this.getActiveDeliverySecretId();
			if (current === secretId) return;
			this.db.run(
				`INSERT INTO delivery_secret_state
				   (singleton, state, active_secret_id, prepared_secret_id, updated_at)
				 VALUES (1, 'ACTIVE', ?, NULL, datetime('now'))
				 ON CONFLICT(singleton) DO UPDATE SET
				   state = 'ACTIVE', active_secret_id = excluded.active_secret_id,
				   prepared_secret_id = NULL, updated_at = datetime('now')`,
				[secretId],
			);
			if (current) this.requeueLeadEventsForSecretRotation();
		});
	}

	prepareDeliverySecret(secretId: string): void {
		this.db.run(
			`INSERT INTO delivery_secret_state
			   (singleton, state, active_secret_id, prepared_secret_id, updated_at)
			 VALUES (1, 'PREPARED', NULL, ?, datetime('now'))
			 ON CONFLICT(singleton) DO UPDATE SET
			   state = 'PREPARED', prepared_secret_id = excluded.prepared_secret_id,
			   updated_at = datetime('now')`,
			[secretId],
		);
	}

	activatePreparedDeliverySecret(secretId: string): boolean {
		let activated = false;
		this.db.transaction(() => {
			const marker = this.getDeliverySecretState();
			const result = this.db.raw
				.prepare(
					`UPDATE delivery_secret_state SET
					   state = 'ACTIVE', active_secret_id = ?, prepared_secret_id = NULL,
					   updated_at = datetime('now')
					 WHERE singleton = 1 AND state = 'PREPARED'
					   AND prepared_secret_id = ?`,
				)
				.run(secretId, secretId);
			activated = result.changes === 1;
			if (
				activated &&
				marker?.activeSecretId &&
				marker.activeSecretId !== secretId
			) {
				this.requeueLeadEventsForSecretRotation();
			}
		});
		return activated;
	}

	private requeueLeadEventsForSecretRotation(): void {
		this.db.run(
			`UPDATE lead_events SET
			   pending_delivery_reason = 'secret_rotation',
			   ack_deadline_at = datetime('now')
			 WHERE ack_required = 1 AND acked_at IS NULL
			   AND ack_retired_at IS NULL
			   AND dead_lettered_at IS NULL`,
		);
		this.db.run(
			`UPDATE lead_event_delivery_attempts SET retired_at = datetime('now')
			 WHERE retired_at IS NULL
			   AND event_seq IN (
			     SELECT seq FROM lead_events
			      WHERE pending_delivery_reason = 'secret_rotation'
			   )`,
		);
	}

	transferLeadEventAckOwner(
		seq: number,
		newLeadId: string,
		nowIso: string,
	): boolean {
		let transferred = false;
		this.db.transaction(() => {
			const result = this.db.raw
				.prepare(
					`UPDATE lead_events SET
					   ack_owner_lead_id = ?, ack_owner_epoch = ack_owner_epoch + 1,
					   pending_delivery_reason = 'owner_transfer', ack_deadline_at = ?
					 WHERE seq = ? AND ack_required = 1 AND acked_at IS NULL
					   AND ack_retired_at IS NULL
					   AND dead_lettered_at IS NULL AND ack_owner_lead_id <> ?`,
				)
				.run(newLeadId, nowIso, seq, newLeadId);
			if (result.changes !== 1) return;
			this.db.raw
				.prepare(
					`UPDATE lead_event_delivery_attempts SET retired_at = ?
					 WHERE event_seq = ? AND retired_at IS NULL`,
				)
				.run(nowIso, seq);
			transferred = true;
		});
		return transferred;
	}

	getDeliverySecretState(): DeliverySecretState | null {
		const row = this.db.raw
			.prepare(
				`SELECT state, active_secret_id, prepared_secret_id
				 FROM delivery_secret_state WHERE singleton = 1`,
			)
			.get() as
			| {
					state: "PREPARED" | "ACTIVE";
					active_secret_id: string | null;
					prepared_secret_id: string | null;
			  }
			| undefined;
		return row
			? {
					state: row.state,
					activeSecretId: row.active_secret_id,
					preparedSecretId: row.prepared_secret_id,
				}
			: null;
	}

	getActiveDeliverySecretId(): string | null {
		const row = this.db.raw
			.prepare(
				"SELECT active_secret_id FROM delivery_secret_state WHERE singleton = 1 AND state = 'ACTIVE'",
			)
			.get() as { active_secret_id?: string } | undefined;
		return row?.active_secret_id ?? null;
	}

	claimLeadEventDeliveryAttempt(input: {
		eventSeq: number;
		reason: LeadEventDeliveryReason;
		secretId: string;
		nowIso: string;
		leaseExpiresIso: string;
	}): LeadEventDeliveryAttemptRow | null {
		let claimed: LeadEventDeliveryAttemptRow | null = null;
		this.db.transaction(() => {
			const event = this.getLeadEventBySeq(input.eventSeq);
			if (
				!event?.ack_required ||
				event.ack_retired_at ||
				event.acked_at ||
				event.dead_lettered_at ||
				!event.ack_owner_lead_id ||
				this.getActiveDeliverySecretId() !== input.secretId
			) {
				return;
			}

			const existing = this.db.raw
				.prepare(
					`SELECT * FROM lead_event_delivery_attempts
					 WHERE event_seq = ? AND finalized_at IS NULL AND retired_at IS NULL
					 ORDER BY attempt_no DESC LIMIT 1`,
				)
				.get(input.eventSeq) as LeadEventDeliveryAttemptRow | undefined;
			const claimToken = randomUUID();
			if (existing) {
				if (existing.lease_expires_at > input.nowIso) return;
				const result = this.db.raw
					.prepare(
						`UPDATE lead_event_delivery_attempts SET
						   claim_token = ?, lease_expires_at = ?,
						   reclaim_count = reclaim_count + 1,
						   last_reclaimed_at = ?
						 WHERE attempt_id = ? AND claim_token = ?
						   AND finalized_at IS NULL AND retired_at IS NULL
						   AND lease_expires_at <= ?`,
					)
					.run(
						claimToken,
						input.leaseExpiresIso,
						input.nowIso,
						existing.attempt_id,
						existing.claim_token,
						input.nowIso,
					);
				if (result.changes !== 1) return;
				claimed = this.db.raw
					.prepare(
						"SELECT * FROM lead_event_delivery_attempts WHERE attempt_id = ?",
					)
					.get(existing.attempt_id) as LeadEventDeliveryAttemptRow;
				return;
			}

			const maxRow = this.db.raw
				.prepare(
					"SELECT COALESCE(MAX(attempt_no), -1) AS n FROM lead_event_delivery_attempts WHERE event_seq = ?",
				)
				.get(input.eventSeq) as { n: number };
			const attemptNo = Number(maxRow.n) + 1;
			const attemptId = randomUUID();
			const kind = input.reason === "initial" ? "initial" : "reminder";
			const countsTowardRedelivery = input.reason === "ack_timeout" ? 1 : 0;
			this.db.raw
				.prepare(
					`INSERT INTO lead_event_delivery_attempts (
					   attempt_id, event_seq, attempt_no, kind, reason,
					   counts_toward_redelivery, claim_token, owner_epoch_at_claim,
					   secret_id_at_claim, lease_expires_at, claimed_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					attemptId,
					input.eventSeq,
					attemptNo,
					kind,
					input.reason,
					countsTowardRedelivery,
					claimToken,
					event.ack_owner_epoch ?? 0,
					input.secretId,
					input.leaseExpiresIso,
					input.nowIso,
				);
			claimed = this.db.raw
				.prepare(
					"SELECT * FROM lead_event_delivery_attempts WHERE attempt_id = ?",
				)
				.get(attemptId) as LeadEventDeliveryAttemptRow;
		});
		return claimed;
	}

	finalizeLeadEventDeliveryAttempt(input: {
		claimToken: string;
		outcome: "pushed" | "failed";
		nowIso: string;
		ackDeadlineIso?: string;
		error?: string;
	}): boolean {
		let finalized = false;
		this.db.transaction(() => {
			const attempt = this.db.raw
				.prepare(
					`SELECT a.*, e.ack_owner_epoch, e.acked_at, e.dead_lettered_at,
					        e.ack_retired_at,
					        s.active_secret_id
					 FROM lead_event_delivery_attempts a
					 JOIN lead_events e ON e.seq = a.event_seq
					 LEFT JOIN delivery_secret_state s ON s.singleton = 1
					 WHERE a.claim_token = ? AND a.finalized_at IS NULL
					   AND a.retired_at IS NULL`,
				)
				.get(input.claimToken) as
				| (LeadEventDeliveryAttemptRow & {
						ack_owner_epoch: number;
						acked_at: string | null;
						dead_lettered_at: string | null;
						ack_retired_at: string | null;
						active_secret_id: string | null;
				  })
				| undefined;
			if (
				!attempt ||
				attempt.ack_retired_at ||
				attempt.acked_at ||
				attempt.dead_lettered_at ||
				attempt.owner_epoch_at_claim !== attempt.ack_owner_epoch ||
				attempt.secret_id_at_claim !== attempt.active_secret_id
			) {
				return;
			}

			const attemptUpdate = this.db.raw
				.prepare(
					`UPDATE lead_event_delivery_attempts SET
					   finalized_at = ?, outcome = ?,
					   pushed_at = CASE WHEN ? = 'pushed' THEN ? ELSE pushed_at END,
					   last_error = ?
					 WHERE claim_token = ? AND finalized_at IS NULL AND retired_at IS NULL
					   AND owner_epoch_at_claim = (
					     SELECT ack_owner_epoch FROM lead_events
					      WHERE seq = lead_event_delivery_attempts.event_seq
					   )
					   AND secret_id_at_claim = (
					     SELECT active_secret_id FROM delivery_secret_state WHERE singleton = 1
					   )`,
				)
				.run(
					input.nowIso,
					input.outcome,
					input.outcome,
					input.nowIso,
					input.error ?? null,
					input.claimToken,
				);
			if (attemptUpdate.changes !== 1) return;

			const eventUpdate = this.db.raw
				.prepare(
					input.outcome === "pushed"
						? `UPDATE lead_events SET
						     delivered_at = COALESCE(delivered_at, ?),
						     ack_deadline_at = ?, last_delivery_error = NULL,
						     pending_delivery_reason = NULL
						   WHERE seq = ? AND acked_at IS NULL AND dead_lettered_at IS NULL
						     AND ack_retired_at IS NULL
						     AND ack_owner_epoch = ?`
						: `UPDATE lead_events SET last_delivery_error = ?
						   WHERE seq = ? AND acked_at IS NULL AND dead_lettered_at IS NULL
						     AND ack_retired_at IS NULL
						     AND ack_owner_epoch = ?`,
				)
				.run(
					...(input.outcome === "pushed"
						? [
								input.nowIso,
								input.ackDeadlineIso ?? input.nowIso,
								attempt.event_seq,
								attempt.owner_epoch_at_claim,
							]
						: [
								input.error ?? "delivery failed",
								attempt.event_seq,
								attempt.owner_epoch_at_claim,
							]),
				);
			if (eventUpdate.changes !== 1) {
				throw new Error(
					"lead event finalizer fence changed during transaction",
				);
			}
			finalized = true;
		});
		return finalized;
	}

	markLeadEventAcked(seq: number, nowIso: string): boolean {
		let acked = false;
		this.db.transaction(() => {
			const result = this.db.raw
				.prepare(
					`UPDATE lead_events SET
					   acked_at = ?, ack_token_consumed_at = ?
					 WHERE seq = ? AND ack_required = 1 AND acked_at IS NULL
					   AND ack_retired_at IS NULL
					   AND (dead_lettered_at IS NULL OR ack_token_valid_until > ?)`,
				)
				.run(nowIso, nowIso, seq, nowIso);
			if (result.changes !== 1) return;
			this.db.raw
				.prepare(
					`UPDATE lead_event_delivery_attempts SET retired_at = ?
					 WHERE event_seq = ? AND retired_at IS NULL`,
				)
				.run(nowIso, seq);
			acked = true;
		});
		return acked;
	}

	markLeadEventDeadLetterPending(seq: number, nowIso: string): boolean {
		return (
			this.db.raw
				.prepare(
					`UPDATE lead_events SET dead_letter_pending_at = COALESCE(dead_letter_pending_at, ?)
					 WHERE seq = ? AND ack_required = 1 AND acked_at IS NULL
					   AND ack_retired_at IS NULL
					   AND dead_lettered_at IS NULL`,
				)
				.run(nowIso, seq).changes === 1
		);
	}

	claimLeadEventDeadLetterPage(input: {
		seq: number;
		claimToken: string;
		nowIso: string;
		leaseExpiresIso: string;
	}): boolean {
		return (
			this.db.raw
				.prepare(
					`UPDATE lead_events SET
					   page_claim_token = ?, page_claim_lease_expires_at = ?
					 WHERE seq = ? AND dead_letter_pending_at IS NOT NULL
					   AND ack_retired_at IS NULL
					   AND acked_at IS NULL AND dead_lettered_at IS NULL
					   AND (page_claim_token IS NULL OR page_claim_lease_expires_at <= ?)`,
				)
				.run(input.claimToken, input.leaseExpiresIso, input.seq, input.nowIso)
				.changes === 1
		);
	}

	markLeadEventDeadLetterConfirmed(input: {
		seq: number;
		claimToken: string;
		nowIso: string;
		ackTokenValidUntilIso: string;
	}): boolean {
		return (
			this.db.raw
				.prepare(
					`UPDATE lead_events SET
					   dead_lettered_at = ?, ack_token_valid_until = ?
					 WHERE seq = ? AND page_claim_token = ?
					   AND ack_retired_at IS NULL
					   AND page_claim_lease_expires_at > ?
					   AND acked_at IS NULL AND dead_lettered_at IS NULL`,
				)
				.run(
					input.nowIso,
					input.ackTokenValidUntilIso,
					input.seq,
					input.claimToken,
					input.nowIso,
				).changes === 1
		);
	}

	// --- FLY-195: stuck-episode disposition receipts (plan §3.4) ---

	/**
	 * Upsert the Lead's disposition for one stuck episode. Last write wins
	 * (e.g. snooze → false_positive refinement). Persisted immediately —
	 * the Q7 fallback does a durable re-read right before paging Annie
	 * (Codex design R2 LOW-R2-2).
	 */
	setStuckDisposition(input: {
		execution_id: string;
		episode_fingerprint: string;
		disposition: StuckDisposition;
		snooze_until_ms?: number | null;
		noted_by?: string | null;
		note?: string | null;
	}): void {
		if (!STUCK_DISPOSITIONS.includes(input.disposition)) {
			throw new Error(`Invalid stuck disposition: ${input.disposition}`);
		}
		this.db.run(
			`INSERT INTO stuck_dispositions
			   (execution_id, episode_fingerprint, disposition, snooze_until_ms, noted_by, note)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(execution_id, episode_fingerprint) DO UPDATE SET
			   disposition = excluded.disposition,
			   snooze_until_ms = excluded.snooze_until_ms,
			   noted_by = excluded.noted_by,
			   note = excluded.note,
			   created_at = datetime('now')`,
			[
				input.execution_id,
				input.episode_fingerprint,
				input.disposition,
				input.snooze_until_ms ?? null,
				input.noted_by ?? null,
				input.note ?? null,
			],
		);
		this.save();
	}

	/** Read the disposition receipt for one stuck episode (undefined = none). */
	getStuckDisposition(
		executionId: string,
		episodeFingerprint: string,
	): StuckDispositionRow | undefined {
		const result = this.db.exec(
			`SELECT execution_id, episode_fingerprint, disposition, snooze_until_ms,
			        noted_by, note, created_at
			 FROM stuck_dispositions
			 WHERE execution_id = ? AND episode_fingerprint = ?`,
			[executionId, episodeFingerprint],
		);
		const row = result[0]?.values[0];
		if (!row) return undefined;
		return this.stuckRowFromValues(row);
	}

	/**
	 * FLY-253 (L2): read BOTH disposition rows that can govern one episode —
	 * the exact (episode_fingerprint = fp) row and the execution-scoped
	 * sentinel (episode_fingerprint = '*') row. The detector picks between
	 * them with a precedence rule evaluated against `now` (effective exact >
	 * effective sentinel > expired — Codex R1 #3: an unconditional exact-first
	 * LIMIT 1 would let an expired exact snooze shadow an active sentinel
	 * legitimate_wait and re-open the alert treadmill).
	 */
	getStuckDispositionRows(
		executionId: string,
		episodeFingerprint: string,
	): { exact?: StuckDispositionRow; sentinel?: StuckDispositionRow } {
		const result = this.db.exec(
			`SELECT execution_id, episode_fingerprint, disposition, snooze_until_ms,
			        noted_by, note, created_at
			 FROM stuck_dispositions
			 WHERE execution_id = ? AND episode_fingerprint IN (?, '*')`,
			[executionId, episodeFingerprint],
		);
		const out: { exact?: StuckDispositionRow; sentinel?: StuckDispositionRow } =
			{};
		for (const values of result[0]?.values ?? []) {
			const row = this.stuckRowFromValues(values);
			if (row.episode_fingerprint === "*") out.sentinel = row;
			else out.exact = row;
		}
		return out;
	}

	/**
	 * FLY-253 (L2, re_arm): delete ALL governing receipts for this execution —
	 * the '*' sentinel AND every episode-scoped row (Codex code R1 HIGH-1: an
	 * effective exact row on the SAME frozen fingerprint would otherwise keep
	 * suppressing after re_arm, and a Bridge restart would not fix it).
	 * re_arm means "I want detection live again" — stale frame judgments go
	 * with it. No audit is lost: every disposition wrote a session_events
	 * trace row; stuck_dispositions is the live suppression state, not the
	 * audit trail. The route layer pairs this with the detector's
	 * `rearmExecution()` so the in-memory episode is reset too.
	 */
	clearExecutionStuckReceipts(executionId: string): void {
		this.db.run(`DELETE FROM stuck_dispositions WHERE execution_id = ?`, [
			executionId,
		]);
		this.save();
	}

	/**
	 * FLY-253 (L2, reminder reset): consume CURRENTLY-EXPIRED timed rows among
	 * {exact fp, '*'} for this execution — an expired receipt is a ONE-SHOT
	 * reminder token (Codex R2 #2: leaving it in place re-resets the episode
	 * on every grace expiry → infinite Lead reminders, Annie never paged).
	 *
	 * The `snooze_until_ms <= :now` predicate is the concurrency guard: a row
	 * the Lead refreshed (new future expiry) between read and consume is NOT
	 * deleted. Untimed rows (NULL) are terminal receipts and never consumed.
	 */
	consumeExpiredStuckDispositions(
		executionId: string,
		episodeFingerprint: string,
		nowMs: number,
	): void {
		this.db.run(
			`DELETE FROM stuck_dispositions
			 WHERE execution_id = ?
			 AND episode_fingerprint IN (?, '*')
			 AND snooze_until_ms IS NOT NULL
			 AND snooze_until_ms <= ?`,
			[executionId, episodeFingerprint, nowMs],
		);
		this.save();
	}

	/** Map a raw stuck_dispositions row tuple to the typed shape. */
	private stuckRowFromValues(row: unknown[]): StuckDispositionRow {
		return {
			execution_id: row[0] as string,
			episode_fingerprint: row[1] as string,
			disposition: row[2] as StuckDisposition,
			snooze_until_ms: (row[3] as number | null) ?? null,
			noted_by: (row[4] as string | null) ?? null,
			note: (row[5] as string | null) ?? null,
			created_at: row[6] as string,
		};
	}

	// --- FLY-637 #3/#4: persistent quiet-wake "already-notified" dedup ---

	/**
	 * True when the Lead was already woken about this exact frozen frame
	 * (execution + source + episode fingerprint). Used by both stall watchdogs to
	 * suppress a repeat wake across cosmetic pane jitter AND across a Bridge
	 * restart (the in-memory dedup sets are wiped on restart; this row is not).
	 */
	hasQuietWakeNotified(
		executionId: string,
		source: string,
		episodeFingerprint: string,
	): boolean {
		const result = this.db.exec(
			`SELECT 1 FROM quiet_wake_notified
			 WHERE execution_id = ? AND source = ? AND episode_fingerprint = ?`,
			[executionId, source, episodeFingerprint],
		);
		return (result[0]?.values.length ?? 0) > 0;
	}

	/**
	 * Record that the Lead was woken about this frozen frame. Idempotent
	 * (INSERT OR IGNORE on the composite PK). Callers MUST only record AFTER the
	 * wake event was actually persisted (FLY-637 R1 #2): recording a wake that
	 * never reached the guardrail journal would durably suppress a real one.
	 */
	recordQuietWakeNotified(
		executionId: string,
		source: string,
		episodeFingerprint: string,
	): void {
		this.db.run(
			`INSERT OR IGNORE INTO quiet_wake_notified
			   (execution_id, source, episode_fingerprint)
			 VALUES (?, ?, ?)`,
			[executionId, source, episodeFingerprint],
		);
		this.save();
	}

	/**
	 * Clear the quiet-wake dedup rows for one execution — all sources, or just
	 * the given source. Called when a session recovers / leaves the watchdog
	 * surface so a genuinely-new later episode starts clean.
	 */
	clearQuietWakeNotified(executionId: string, source?: string): void {
		if (source) {
			this.db.run(
				`DELETE FROM quiet_wake_notified WHERE execution_id = ? AND source = ?`,
				[executionId, source],
			);
		} else {
			this.db.run(`DELETE FROM quiet_wake_notified WHERE execution_id = ?`, [
				executionId,
			]);
		}
		this.save();
	}

	/**
	 * Prune quiet-wake dedup rows for a source: delete every row whose
	 * `execution_id` is NOT in `keepExecIds`. Each watchdog calls this with its
	 * OWN surface set (idle → the running sessions it polls; stuck → the current
	 * `getStuckSessions` set) so a session that left the surface drops its rows.
	 *
	 * Empty-set guard (FLY-637 R1 #4): `keepExecIds = []` means "keep none" →
	 * delete ALL rows for the source, instead of emitting an invalid `IN ()`.
	 */
	pruneQuietWakeNotifiedNotIn(source: string, keepExecIds: string[]): void {
		if (keepExecIds.length === 0) {
			this.db.run(`DELETE FROM quiet_wake_notified WHERE source = ?`, [source]);
		} else {
			const placeholders = keepExecIds.map(() => "?").join(",");
			this.db.run(
				`DELETE FROM quiet_wake_notified
				 WHERE source = ? AND execution_id NOT IN (${placeholders})`,
				[source, ...keepExecIds],
			);
		}
		// FLY-637 (Codex code R1 LOW-1): prune runs every heartbeat (5m) / idle poll,
		// usually a no-op. Only flush the sql.js DB to disk when rows actually
		// changed — avoids a recurring whole-DB export for the common empty case.
		if (this.db.getRowsModified() > 0) this.save();
	}

	// --- FLY-637-ext: lead-pending escalation durable backoff state ---

	/** Read the backoff row for one (execution, blocking question), or undefined. */
	getLeadPendingEscalation(
		executionId: string,
		questionId: string,
	): LeadNudgeRow | undefined {
		const result = this.db.exec(
			`SELECT stuck_key, nudge_count, last_nudge_at_ms, next_eligible_at_ms, paged_annie
			 FROM lead_pending_escalation
			 WHERE execution_id = ? AND question_id = ?`,
			[executionId, questionId],
		);
		const row = result[0]?.values[0];
		if (!row) return undefined;
		return {
			stuck_key: row[0] as string,
			nudge_count: row[1] as number,
			last_nudge_at_ms: row[2] as number,
			next_eligible_at_ms: row[3] as number,
			paged_annie: (row[4] as number) === 1,
		};
	}

	/** Upsert the backoff row. Caller commits AFTER the nudge/alert is accepted (R1 #5). */
	upsertLeadPendingEscalation(
		executionId: string,
		questionId: string,
		row: LeadNudgeRow,
	): void {
		this.db.run(
			`INSERT INTO lead_pending_escalation
			   (execution_id, question_id, stuck_key, nudge_count, last_nudge_at_ms, next_eligible_at_ms, paged_annie)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(execution_id, question_id) DO UPDATE SET
			   stuck_key = excluded.stuck_key,
			   nudge_count = excluded.nudge_count,
			   last_nudge_at_ms = excluded.last_nudge_at_ms,
			   next_eligible_at_ms = excluded.next_eligible_at_ms,
			   paged_annie = excluded.paged_annie`,
			[
				executionId,
				questionId,
				row.stuck_key,
				row.nudge_count,
				row.last_nudge_at_ms,
				row.next_eligible_at_ms,
				row.paged_annie ? 1 : 0,
			],
		);
		this.save();
	}

	/** Clear one question's row, or all of a runner's rows (question answered / gone). */
	clearLeadPendingEscalation(executionId: string, questionId?: string): void {
		if (questionId) {
			this.db.run(
				`DELETE FROM lead_pending_escalation WHERE execution_id = ? AND question_id = ?`,
				[executionId, questionId],
			);
		} else {
			this.db.run(
				`DELETE FROM lead_pending_escalation WHERE execution_id = ?`,
				[executionId],
			);
		}
		this.save();
	}

	/**
	 * Prune rows whose `question_id` is NOT in the current active pending set —
	 * a question that was answered / evicted drops its escalation state so a later
	 * genuine episode starts clean. Empty set ⇒ clear all (no `IN ()`).
	 */
	pruneLeadPendingEscalationNotIn(activeQuestionIds: string[]): void {
		if (activeQuestionIds.length === 0) {
			this.db.run(`DELETE FROM lead_pending_escalation`);
		} else {
			const placeholders = activeQuestionIds.map(() => "?").join(",");
			this.db.run(
				`DELETE FROM lead_pending_escalation WHERE question_id NOT IN (${placeholders})`,
				activeQuestionIds,
			);
		}
		if (this.db.getRowsModified() > 0) this.save();
	}

	// --- FLY-1048 PR-C (C1): detection_escalations durable episode store ---

	private static readonly DETECTION_ESCALATION_COLUMNS =
		"target_key, kind, episode_fingerprint, issue_id, owner_lead_id, first_detected_at_ms, lead_notified_at_ms, lead_ack_at_ms, founder_paged_at_ms, clearing_since_ms, status, attempts, resolved_via";

	private detectionEscalationFromValues(
		row: unknown[],
	): DetectionEscalationRow {
		return {
			target_key: row[0] as string,
			kind: row[1] as string,
			episode_fingerprint: row[2] as string,
			issue_id: (row[3] as string | null) ?? null,
			owner_lead_id: (row[4] as string | null) ?? null,
			first_detected_at_ms: row[5] as number,
			lead_notified_at_ms: (row[6] as number | null) ?? null,
			lead_ack_at_ms: (row[7] as number | null) ?? null,
			founder_paged_at_ms: (row[8] as number | null) ?? null,
			clearing_since_ms: (row[9] as number | null) ?? null,
			status: row[10] as DetectionEscalationStatus,
			attempts: row[11] as number,
			resolved_via: ((row[12] as string | null) ?? null) as
				| "recovery"
				| "residue_harvest"
				| "lead"
				| null,
		};
	}

	/** Read one episode row, or undefined. */
	getDetectionEscalation(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
	): DetectionEscalationRow | undefined {
		const result = this.db.exec(
			`SELECT ${StateStore.DETECTION_ESCALATION_COLUMNS}
			 FROM detection_escalations
			 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?`,
			[targetKey, kind, episodeFingerprint],
		);
		const row = result[0]?.values[0];
		return row ? this.detectionEscalationFromValues(row) : undefined;
	}

	/**
	 * Insert a NEW episode, or return the existing row untouched — episode
	 * continuity: re-observing an episode must never reset its detection clock
	 * or status (the ~30min grace is anchored to the FIRST detection).
	 */
	upsertDetectionEscalation(input: {
		targetKey: string;
		kind: string;
		episodeFingerprint: string;
		issueId?: string | null;
		ownerLeadId?: string | null;
		firstDetectedAtMs: number;
	}): { created: boolean; row: DetectionEscalationRow } {
		this.db.run(
			`INSERT OR IGNORE INTO detection_escalations
			   (target_key, kind, episode_fingerprint, issue_id, owner_lead_id, first_detected_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				input.targetKey,
				input.kind,
				input.episodeFingerprint,
				input.issueId ?? null,
				input.ownerLeadId ?? null,
				input.firstDetectedAtMs,
			],
		);
		let created = this.db.getRowsModified() > 0;
		if (created) this.save();
		let row = this.getDetectionEscalation(
			input.targetKey,
			input.kind,
			input.episodeFingerprint,
		);
		if (!row) {
			throw new Error(
				"detection_escalations upsert failed to persist a row (invariant violation)",
			);
		}
		// FLY-1048 PR-C (Codex code R1 #1 + R2 #1): a RESOLVED fingerprint must
		// not permanently silence a RECURRENCE — but revival needs DURABLE clear
		// evidence. Only a machine resolution (`recovery`: terminal/progress/
		// evidence-gone, or FLY-1066's double-absence `residue_harvest`) proves
		// the condition cleared between episodes; the
		// detection-side timestamps are in-process and rebuild on a Bridge
		// restart, so a Lead-dismissed but UNCHANGED condition must never
		// re-notify just because the clock reset. Lead receipts follow the
		// legacy identical-content semantics (the old flow's false_positive
		// rows behave the same way).
		if (
			!created &&
			row.status === "RESOLVED" &&
			(row.resolved_via === "recovery" ||
				row.resolved_via === "residue_harvest") &&
			input.firstDetectedAtMs > (row.lead_ack_at_ms ?? row.first_detected_at_ms)
		) {
			this.db.run(
				`UPDATE detection_escalations
				 SET status = 'NEW', first_detected_at_ms = ?,
				     lead_notified_at_ms = NULL, lead_ack_at_ms = NULL,
				     founder_paged_at_ms = NULL, clearing_since_ms = NULL,
				     attempts = 0, resolved_via = NULL, owner_lead_id = ?
				 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
				   AND status = 'RESOLVED'`,
				[
					input.firstDetectedAtMs,
					input.ownerLeadId ?? null,
					input.targetKey,
					input.kind,
					input.episodeFingerprint,
				],
			);
			if (this.db.getRowsModified() > 0) {
				this.save();
				created = true; // a genuinely new episode, reusing the row
				row = this.getDetectionEscalation(
					input.targetKey,
					input.kind,
					input.episodeFingerprint,
				);
				if (!row) {
					throw new Error(
						"detection_escalations revive failed to persist (invariant violation)",
					);
				}
			}
		}
		return { created, row };
	}

	/**
	 * FLY-1279 D2: persist one positive semantic observation. The monotonic
	 * counter makes gate-row-missing require two complete scans without relying
	 * on process memory; notification ownership remains the normal NEW→
	 * LEAD_NOTIFIED transition.
	 */
	observeParkCondition(input: {
		targetKey: string;
		kind: string;
		episodeFingerprint: string;
		issueId?: string | null;
		firstDetectedAtMs: number;
	}): DetectionEscalationRow {
		this.upsertDetectionEscalation(input);
		this.db.run(
			`UPDATE detection_escalations SET attempts = attempts + 1
			 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
			   AND status = 'NEW'`,
			[input.targetKey, input.kind, input.episodeFingerprint],
		);
		const row = this.getDetectionEscalation(
			input.targetKey,
			input.kind,
			input.episodeFingerprint,
		);
		if (!row) throw new Error("park observation failed to persist");
		return row;
	}

	/**
	 * Stamp LEAD_NOTIFIED. The FIRST notification timestamp wins on repeats so
	 * a re-notify can never slide the founder-grace window forward. Only moves
	 * NEW/LEAD_NOTIFIED rows (never regresses ACKED/terminal states).
	 */
	/**
	 * Codex R5 #2 + R6 #1/#2: the atomic single-notifier APPEND+CLAIM. One
	 * durability unit — the lead_event insert (idempotent per event id) and
	 * the NEW→LEAD_NOTIFIED transition share a SINGLE save() commit point, so
	 * the exported snapshot carries both or neither: a crash can never leave
	 * a durable event beside a still-NEW row (the R6 restart double-delivery)
	 * nor a claimed row without its event. Exactly ONE concurrent/retrying
	 * caller wins the claim (status='NEW' predicate); losers get
	 * claimed:false with the existing seq and must produce no delivery and
	 * no thread note. The claim also BACKFILLS a null owner_lead_id (R6 #2:
	 * a no_owner→recovered retry must not strand the fleet aggregate on
	 * "unassigned") — an existing owner is never overwritten.
	 */
	appendAndClaimDetectionEscalation(opts: {
		leadId: string;
		eventId: string;
		eventType: string;
		payload: string;
		sessionKey?: string;
		targetKey: string;
		kind: string;
		episodeFingerprint: string;
		ownerLeadId: string;
		atMs: number;
	}): { claimed: boolean; seq: number } {
		// Codex R7 (R6 #1 for real this time): better-sqlite3 autocommits each
		// statement, so the pair MUST run inside db.transaction() — commit
		// both or neither. A throw anywhere inside rolls the append back too:
		// heartbeat can never see an event whose episode is still NEW.
		let seq = 0;
		let claimed = false;
		let hookPayload: HookPayload | null = null;
		try {
			const parsed = JSON.parse(opts.payload) as unknown;
			if (parsed && typeof parsed === "object") {
				hookPayload = parsed as HookPayload;
			}
		} catch {
			// Non-hook detection rows remain ACK-exempt.
		}
		const ackPolicy = hookPayload
			? ackPolicyForLeadEvent(opts.eventType, hookPayload)
			: null;
		const routingSnapshot = hookPayload
			? JSON.stringify(routingSnapshotForLeadEvent(opts.leadId, hookPayload))
			: null;
		this.db.transaction(() => {
			try {
				this.db.run(
					`INSERT INTO lead_events (
					   lead_id, event_id, event_type, payload, session_key,
					   ack_required, ack_policy, ack_protocol_version,
					   routing_snapshot, ack_owner_lead_id
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						opts.leadId,
						opts.eventId,
						opts.eventType,
						opts.payload,
						opts.sessionKey ?? null,
						ackPolicy ? 1 : 0,
						ackPolicy,
						ackPolicy ? 1 : null,
						routingSnapshot,
						opts.leadId,
					],
				);
				const inserted = this.db.exec("SELECT last_insert_rowid()");
				seq = (inserted[0]?.values[0]?.[0] as number) ?? 0;
			} catch (err) {
				// Idempotent per event id: a retry of the SAME occurrence reuses
				// its row (an in-transaction catch does not roll back).
				if ((err as Error).message?.includes("UNIQUE")) {
					const existing = this.db.exec(
						"SELECT seq FROM lead_events WHERE lead_id = ? AND event_id = ?",
						[opts.leadId, opts.eventId],
					);
					seq = (existing[0]?.values[0]?.[0] as number) ?? 0;
				} else {
					throw err;
				}
			}
			this.db.run(
				`UPDATE detection_escalations
				 SET status = 'LEAD_NOTIFIED',
				     lead_notified_at_ms = COALESCE(lead_notified_at_ms, ?),
				     owner_lead_id = COALESCE(owner_lead_id, ?)
				 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
				   AND status = 'NEW'`,
				[
					opts.atMs,
					opts.ownerLeadId,
					opts.targetKey,
					opts.kind,
					opts.episodeFingerprint,
				],
			);
			claimed = this.db.getRowsModified() > 0;
		});
		this.save();
		return { claimed, seq };
	}

	markDetectionEscalationLeadNotified(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
		atMs: number,
	): boolean {
		this.db.run(
			`UPDATE detection_escalations
			 SET status = 'LEAD_NOTIFIED',
			     lead_notified_at_ms = COALESCE(lead_notified_at_ms, ?)
			 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
			   AND status IN ('NEW', 'LEAD_NOTIFIED')`,
			[atMs, targetKey, kind, episodeFingerprint],
		);
		const changed = this.db.getRowsModified() > 0;
		if (changed) this.save();
		return changed;
	}

	/**
	 * Lead disposition: `ack` → ACKED (Lead has it, grace timer disarmed);
	 * `resolve` / `dismiss` → RESOLVED (terminal). Missing row → false.
	 */
	ackDetectionEscalation(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
		opts: {
			atMs: number;
			disposition: "ack" | "resolve" | "dismiss";
			/** Resolution provenance (Codex R2 #1): 'recovery' = machine-proven
			 * clear (may revive on re-detection); default 'lead' = human receipt
			 * (never revives — legacy identical-content semantics). */
			via?: "recovery" | "lead";
		},
	): boolean {
		const status = opts.disposition === "ack" ? "ACKED" : "RESOLVED";
		this.db.run(
			`UPDATE detection_escalations
			 SET status = ?, lead_ack_at_ms = COALESCE(lead_ack_at_ms, ?),
			     resolved_via = CASE WHEN ? = 'RESOLVED' THEN ? ELSE resolved_via END
			 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
			   AND status != 'RESOLVED'`,
			[
				status,
				opts.atMs,
				status,
				opts.via ?? "lead",
				targetKey,
				kind,
				episodeFingerprint,
			],
		);
		const changed = this.db.getRowsModified() > 0;
		if (changed) this.save();
		return changed;
	}

	/**
	 * FLY-1282 Part D: a Lead disposition + its receipt prepare in ONE real
	 * transaction (better-sqlite3 autocommits per statement — a committed ack
	 * must never be missing its receipt row). `changed=false` (already
	 * RESOLVED / no row) prepares nothing: the FIRST via:'lead' disposition
	 * wins the receipt. Recovery never calls this method.
	 */
	ackDetectionEscalationWithReceipt(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
		opts: {
			atMs: number;
			disposition: "ack" | "resolve" | "dismiss";
			receipt: DispositionReceiptPrepareInput;
		},
	): { changed: boolean; receiptPrepared: boolean } {
		let changed = false;
		let receiptPrepared = false;
		this.db.transaction(() => {
			changed = this.runDetectionAckUpdate(
				targetKey,
				kind,
				episodeFingerprint,
				opts.atMs,
				opts.disposition,
			);
			if (!changed) return;
			receiptPrepared = this.prepareDispositionReceiptInTx(
				targetKey,
				kind,
				episodeFingerprint,
				opts.atMs,
				opts.receipt,
			);
		});
		return { changed, receiptPrepared };
	}

	/**
	 * FLY-1282 Part D (old stuck-disposition + recovery-nudge surfaces): the
	 * authoritative stuck_dispositions write AND every hit episode's unified
	 * ack + receipt prepare commit in ONE transaction — any failure rolls the
	 * whole disposition back (the C4a swallow-and-200 false success is gone;
	 * the route surfaces the error instead).
	 */
	applyStuckDispositionWithReceipts(opts: {
		stuck: {
			execution_id: string;
			episode_fingerprint: string;
			disposition: StuckDisposition;
			snooze_until_ms?: number | null;
			noted_by?: string | null;
			note?: string | null;
		};
		/** Unified-flow episodes this disposition acks (0..N). */
		episodes: Array<{
			targetKey: string;
			kind: string;
			episodeFingerprint: string;
			disposition: "ack" | "resolve" | "dismiss";
		}>;
		atMs: number;
		receipt: DispositionReceiptPrepareInput;
	}): { receiptsPrepared: number } {
		let receiptsPrepared = 0;
		this.db.transaction(() => {
			this.setStuckDisposition(opts.stuck);
			for (const ep of opts.episodes) {
				const changed = this.runDetectionAckUpdate(
					ep.targetKey,
					ep.kind,
					ep.episodeFingerprint,
					opts.atMs,
					ep.disposition,
				);
				if (!changed) continue;
				if (
					this.prepareDispositionReceiptInTx(
						ep.targetKey,
						ep.kind,
						ep.episodeFingerprint,
						opts.atMs,
						opts.receipt,
					)
				) {
					receiptsPrepared++;
				}
			}
		});
		return { receiptsPrepared };
	}

	/** The shared via:'lead' ack UPDATE (same SQL as ackDetectionEscalation). */
	private runDetectionAckUpdate(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
		atMs: number,
		disposition: "ack" | "resolve" | "dismiss",
	): boolean {
		const status = disposition === "ack" ? "ACKED" : "RESOLVED";
		this.db.run(
			`UPDATE detection_escalations
			 SET status = ?, lead_ack_at_ms = COALESCE(lead_ack_at_ms, ?),
			     resolved_via = CASE WHEN ? = 'RESOLVED' THEN 'lead' ELSE resolved_via END
			 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
			   AND status != 'RESOLVED'`,
			[status, atMs, status, targetKey, kind, episodeFingerprint],
		);
		return this.db.getRowsModified() > 0;
	}

	/**
	 * In-transaction receipt prepare. Caller MUST hold this.db.transaction().
	 * Precise ON CONFLICT(<4-col generation key>) DO NOTHING — ONLY a
	 * same-generation duplicate no-ops; NOT NULL/CHECK violations THROW and
	 * roll the whole disposition transaction back (never INSERT OR IGNORE:
	 * it would swallow those and commit an acked episode with a permanently
	 * missing receipt). Returns true when a NEW row was inserted.
	 */
	private prepareDispositionReceiptInTx(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
		atMs: number,
		receipt: DispositionReceiptPrepareInput,
	): boolean {
		const row = this.getDetectionEscalation(
			targetKey,
			kind,
			episodeFingerprint,
		);
		if (!row) return false;
		const issueId = row.issue_id?.trim() ? row.issue_id : null;
		this.db.run(
			`INSERT INTO disposition_receipts (
				target_key, kind, episode_fingerprint, episode_first_detected_at_ms,
				actor_lead_id, disposition, content, issue_id, state, created_at_ms
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(target_key, kind, episode_fingerprint, episode_first_detected_at_ms)
			 DO NOTHING`,
			[
				targetKey,
				kind,
				episodeFingerprint,
				row.first_detected_at_ms,
				receipt.actorLeadId,
				receipt.rawDisposition,
				receipt.content,
				issueId,
				// issue_id empty ⇒ terminal at prepare time — nowhere to route.
				issueId ? "pending" : "unroutable",
				atMs,
			],
		);
		const inserted = this.db.getRowsModified() > 0;
		if (inserted && !issueId) {
			// Audit ONLY on a real insert (a conflict means the same-generation
			// receipt already exists — its audit already happened).
			this.insertEvent({
				// Full generation key (code R1 #3): two same-target same-kind
				// episodes acked in the same millisecond must not collapse onto
				// one UNIQUE session_event.
				event_id: `receipt-unroutable-${targetKey}-${kind}-${episodeFingerprint}-${row.first_detected_at_ms}`,
				execution_id: receipt.executionId,
				issue_id: "",
				project_name: receipt.projectName,
				event_type: "disposition_receipt_unroutable",
				source: "bridge.disposition-receipt",
				payload: {
					targetKey,
					kind,
					episodeFingerprint,
					actorLeadId: receipt.actorLeadId,
					disposition: receipt.rawDisposition,
				},
			});
		}
		return inserted;
	}

	/**
	 * FLY-1282 Part D delivery queue: pending receipts, fair rotation —
	 * failures stamp last_attempt_at_ms and fall to the back; receipt_id is
	 * the deterministic final tie-break.
	 */
	getPendingDispositionReceipts(limit: number): DispositionReceiptRow[] {
		const result = this.db.exec(
			`SELECT receipt_id, target_key, kind, episode_fingerprint,
			        episode_first_detected_at_ms, actor_lead_id, disposition,
			        content, issue_id, state, attempts, last_attempt_at_ms,
			        created_at_ms, posted_at_ms
			 FROM disposition_receipts
			 WHERE state = 'pending'
			 ORDER BY last_attempt_at_ms ASC NULLS FIRST, created_at_ms ASC, receipt_id ASC
			 LIMIT ?`,
			[limit],
		);
		return (result[0]?.values ?? []).map((row) => ({
			receipt_id: row[0] as number,
			target_key: row[1] as string,
			kind: row[2] as string,
			episode_fingerprint: row[3] as string,
			episode_first_detected_at_ms: row[4] as number,
			actor_lead_id: row[5] as string,
			disposition: row[6] as string,
			content: row[7] as string,
			issue_id: (row[8] as string) ?? null,
			state: row[9] as DispositionReceiptRow["state"],
			attempts: row[10] as number,
			last_attempt_at_ms: (row[11] as number) ?? null,
			created_at_ms: row[12] as number,
			posted_at_ms: (row[13] as number) ?? null,
		}));
	}

	/** Confirmed-post-only stamp. receipt_id + state guard closes the ABA
	 * (an old consumer resuming after a revive can only touch its own row). */
	markDispositionReceiptPosted(receiptId: number, atMs: number): boolean {
		this.db.run(
			`UPDATE disposition_receipts
			 SET state = 'posted', posted_at_ms = ?
			 WHERE receipt_id = ? AND state = 'pending'`,
			[atMs, receiptId],
		);
		const changed = this.db.getRowsModified() > 0;
		if (changed) this.save();
		return changed;
	}

	/** Failed attempt: rotate to the back of the fair queue. */
	markDispositionReceiptAttempt(receiptId: number, atMs: number): boolean {
		this.db.run(
			`UPDATE disposition_receipts
			 SET attempts = attempts + 1, last_attempt_at_ms = ?
			 WHERE receipt_id = ? AND state = 'pending'`,
			[atMs, receiptId],
		);
		const changed = this.db.getRowsModified() > 0;
		if (changed) this.save();
		return changed;
	}

	/**
	 * 7-day give-up (loud log at the caller). Code R1 #3: the terminal state
	 * flip and its accountability audit row commit in ONE transaction — a
	 * failed audit INSERT rolls the expiry back (the receipt stays pending and
	 * is retried), so the 铁律 promise "expired 有审计可查" cannot be lost to a
	 * crash or write failure between two separate writes. Direct INSERT here,
	 * NOT insertEvent (that helper swallows errors).
	 */
	expireDispositionReceiptWithAudit(
		receiptId: number,
		audit: {
			executionId: string;
			issueId: string;
			projectName: string;
			kind: string;
			episodeFingerprint: string;
			actorLeadId: string;
			disposition: string;
			attempts: number;
		},
	): boolean {
		let changed = false;
		this.db.transaction(() => {
			this.db.run(
				`UPDATE disposition_receipts
				 SET state = 'expired'
				 WHERE receipt_id = ? AND state = 'pending'`,
				[receiptId],
			);
			changed = this.db.getRowsModified() > 0;
			if (!changed) return;
			this.db.run(
				`INSERT INTO session_events (event_id, execution_id, issue_id, project_name, event_type, severity, payload, source)
				 VALUES (?, ?, ?, ?, 'disposition_receipt_expired', 'warning', ?, 'bridge.disposition-receipt')`,
				[
					// receipt_id is the immutable delivery identity — collision-free.
					`receipt-expired-${receiptId}`,
					audit.executionId,
					audit.issueId,
					audit.projectName,
					JSON.stringify({
						kind: audit.kind,
						episodeFingerprint: audit.episodeFingerprint,
						actorLeadId: audit.actorLeadId,
						disposition: audit.disposition,
						attempts: audit.attempts,
					}),
				],
			);
		});
		return changed;
	}

	/**
	 * Stamp ESCALATED + founder_paged_at_ms. C3 contract: callers invoke this
	 * ONLY after the founder page is CONFIRMED posted — an unposted page must
	 * leave the row LEAD_NOTIFIED so the next reconcile retries.
	 */
	markDetectionEscalationEscalated(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
		atMs: number,
	): boolean {
		this.db.run(
			`UPDATE detection_escalations
			 SET status = 'ESCALATED',
			     founder_paged_at_ms = COALESCE(founder_paged_at_ms, ?)
			 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
			   AND status != 'RESOLVED'`,
			[atMs, targetKey, kind, episodeFingerprint],
		);
		const changed = this.db.getRowsModified() > 0;
		if (changed) this.save();
		return changed;
	}

	/** Enter CLEARING (cleanup in progress → all detection muted for the target's episode). */
	markDetectionEscalationClearing(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
		atMs: number,
	): boolean {
		this.db.run(
			`UPDATE detection_escalations
			 SET status = 'CLEARING', clearing_since_ms = ?
			 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
			   AND status != 'RESOLVED'`,
			[atMs, targetKey, kind, episodeFingerprint],
		);
		const changed = this.db.getRowsModified() > 0;
		if (changed) this.save();
		return changed;
	}

	/**
	 * CLEARING TTL rebound (C5): a cleanup that never finished must not mute
	 * the episode forever — revert to NEW so it can re-report. Only applies to
	 * CLEARING rows.
	 */
	revertDetectionEscalationClearingToNew(
		targetKey: string,
		kind: string,
		episodeFingerprint: string,
	): boolean {
		this.db.run(
			`UPDATE detection_escalations
			 SET status = 'NEW', clearing_since_ms = NULL
			 WHERE target_key = ? AND kind = ? AND episode_fingerprint = ?
			   AND status = 'CLEARING'`,
			[targetKey, kind, episodeFingerprint],
		);
		const changed = this.db.getRowsModified() > 0;
		if (changed) this.save();
		return changed;
	}

	/**
	 * Every ACTIVE (non-RESOLVED) row — the reconcile/recovery input. ESCALATED
	 * is included (Codex code R1 #2): the founder was paged but the episode is
	 * still live, so the recovery pass must keep probing its target (terminal/
	 * progress closes it out) — "never re-alerts" (C5/FLY-970) is enforced by
	 * the notify path's status!=NEW dedup and the reconcile's LEAD_NOTIFIED
	 * filter, never by hiding the row.
	 */
	getDetectionEscalationsForReconcile(filter?: {
		includeKinds?: readonly string[];
		excludeKinds?: readonly string[];
	}): DetectionEscalationRow[] {
		if (filter?.includeKinds?.length === 0) return [];
		if (filter?.includeKinds && filter.excludeKinds) {
			throw new Error(
				"detection reconcile filter cannot include and exclude kinds together",
			);
		}
		const kinds = filter?.includeKinds ?? filter?.excludeKinds;
		const kindPredicate = kinds
			? ` AND kind ${filter?.includeKinds ? "IN" : "NOT IN"} (${kinds
					.map(() => "?")
					.join(",")})`
			: "";
		const result = this.db.exec(
			`SELECT ${StateStore.DETECTION_ESCALATION_COLUMNS}
			 FROM detection_escalations
			 WHERE status != 'RESOLVED'
			 ${kindPredicate}
			 ORDER BY first_detected_at_ms ASC`,
			kinds ? [...kinds] : undefined,
		);
		const values = result[0]?.values ?? [];
		return values.map((row) => this.detectionEscalationFromValues(row));
	}

	/**
	 * Target recovered (session progressed / went terminal) → close out every
	 * one of its episodes, ESCALATED included. Returns rows resolved.
	 */
	resolveDetectionEscalationsForTarget(targetKey: string): number {
		this.db.run(
			`UPDATE detection_escalations
			 SET status = 'RESOLVED', resolved_via = 'recovery'
			 WHERE target_key = ? AND status != 'RESOLVED'`,
			[targetKey],
		);
		const n = this.db.getRowsModified();
		if (n > 0) this.save();
		return n;
	}

	/**
	 * FLY-1066: both session ledgers prove this runner target no longer exists.
	 * This is a machine clear like `recovery`, but keeps a distinct audit token.
	 * ACKED/ESCALATED/CLEARING rows are included because disappearance is
	 * independent of notification state. A later real recurrence may revive.
	 */
	resolveDetectionEscalationsForResidueTarget(targetKey: string): number {
		this.db.run(
			`UPDATE detection_escalations
			 SET status = 'RESOLVED', resolved_via = 'residue_harvest'
			 WHERE target_key = ? AND status != 'RESOLVED'`,
			[targetKey],
		);
		const n = this.db.getRowsModified();
		if (n > 0) this.save();
		return n;
	}

	/** Active (non-RESOLVED) episodes of one kind first-detected in the window — the C3 fleet-guard input. */
	countActiveDetectionEscalationsByKind(kind: string, sinceMs: number): number {
		const result = this.db.exec(
			`SELECT COUNT(*) FROM detection_escalations
			 WHERE kind = ? AND status != 'RESOLVED' AND first_detected_at_ms >= ?`,
			[kind, sinceMs],
		);
		return (result[0]?.values[0]?.[0] as number) ?? 0;
	}

	/**
	 * C5: the target entered cleanup (close-runner / reap / dismiss-with-
	 * cleanup) — mute every ACTIVE episode by marking it CLEARING. ESCALATED
	 * rows are deliberately NOT touched: a CLEARING→TTL→NEW rebound of an
	 * already-paged episode would re-page the founder (the FLY-970 re-alert
	 * bug C5 exists to kill). Already-CLEARING rows are not touched either —
	 * a repeated close attempt must not refresh the TTL clock and push the
	 * rebound out. Returns rows transitioned.
	 */
	markDetectionEscalationsClearingForTarget(
		targetKey: string,
		atMs: number,
	): number {
		this.db.run(
			`UPDATE detection_escalations
			 SET status = 'CLEARING', clearing_since_ms = ?
			 WHERE target_key = ?
			   AND status IN ('NEW', 'LEAD_NOTIFIED', 'ACKED')`,
			[atMs, targetKey],
		);
		const n = this.db.getRowsModified();
		if (n > 0) this.save();
		return n;
	}

	/** C5: true while the target has any cleanup-in-progress (CLEARING) row. */
	hasClearingDetectionEscalationForTarget(targetKey: string): boolean {
		const result = this.db.exec(
			`SELECT 1 FROM detection_escalations
			 WHERE target_key = ? AND status = 'CLEARING' LIMIT 1`,
			[targetKey],
		);
		return (result[0]?.values.length ?? 0) > 0;
	}

	/**
	 * C4a: true when the unified flow holds an ACTIVE (non-RESOLVED) episode
	 * for this (target, fingerprint) under ANY kind — the old stuck flow's
	 * pre-emit ownership probe.
	 */
	hasActiveDetectionEscalationForEpisode(
		targetKey: string,
		episodeFingerprint: string,
	): boolean {
		const result = this.db.exec(
			`SELECT 1 FROM detection_escalations
			 WHERE target_key = ? AND episode_fingerprint = ?
			   AND status != 'RESOLVED' LIMIT 1`,
			[targetKey, episodeFingerprint],
		);
		return (result[0]?.values.length ?? 0) > 0;
	}

	// --- FLY-25: Delivery tracking ---

	/** Record a delivery failure: increment attempts, store error. */
	recordDeliveryFailure(seq: number, error: string): void {
		this.db.run(
			`UPDATE lead_events SET delivery_attempts = delivery_attempts + 1, last_delivery_error = ? WHERE seq = ?`,
			[error, seq],
		);
	}

	/** Get undelivered guardrail events (stuck/orphan/stale) under max attempts. */
	getUndeliveredGuardrailEvents(
		leadId: string,
		eventTypes: string[],
		maxAttempts: number,
	): LeadEventRow[] {
		if (eventTypes.length === 0) return [];
		const placeholders = eventTypes.map(() => "?").join(",");
		const result = this.db.exec(
			`SELECT seq, lead_id, event_id, event_type, payload, session_key, delivered_at, created_at, delivery_attempts, last_delivery_error
			 FROM lead_events
			 WHERE lead_id = ? AND delivered_at IS NULL
			   AND event_type IN (${placeholders})
			   AND delivery_attempts < ?
			 ORDER BY seq ASC`,
			[leadId, ...eventTypes, maxAttempts],
		);
		if (result.length === 0) return [];
		return result[0]!.values.map((row) => ({
			seq: row[0] as number,
			lead_id: row[1] as string,
			event_id: row[2] as string,
			event_type: row[3] as string,
			payload: row[4] as string,
			session_key: (row[5] as string) ?? undefined,
			delivered_at: (row[6] as string) ?? undefined,
			created_at: row[7] as string,
			delivery_attempts: (row[8] as number) ?? 0,
			last_delivery_error: (row[9] as string) ?? undefined,
		}));
	}

	// ── FLY-1099: deferred founder approvals ─────────────────────────────────

	private rowToDeferredApproval(
		row: Record<string, unknown>,
	): FounderDeferredApproval {
		return {
			question_id: row.question_id as string,
			msg_id: row.msg_id as string,
			execution_id: row.execution_id as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			pr_head_sha: row.pr_head_sha as string,
			thread_id: row.thread_id as string,
			decision: row.decision as "approve" | "reject",
			content: row.content as string,
			author_user_id: row.author_user_id as string,
			founder_id_at_capture: row.founder_id_at_capture as string,
			created_at: row.created_at as string,
			expires_at: row.expires_at as string,
			consumed_at: (row.consumed_at as string) ?? undefined,
			invalidated_at: (row.invalidated_at as string) ?? undefined,
			invalidated_reason: (row.invalidated_reason as string) ?? undefined,
		};
	}

	private insertFounderActionRaw(intent: FounderActionIntent): void {
		this.db.run(
			`INSERT OR IGNORE INTO founder_action_ledger
			   (action_key, kind, execution_id, issue_id, project_name, thread_id, payload, depends_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				intent.actionKey,
				intent.kind,
				intent.executionId,
				intent.issueId,
				intent.projectName,
				intent.threadId ?? null,
				JSON.stringify(intent.payload),
				intent.dependsOn ?? null,
			],
		);
	}

	private insertAuditEventRaw(event: SessionEvent): void {
		this.db.run(
			`INSERT OR IGNORE INTO session_events
			   (event_id, execution_id, issue_id, project_name, event_type, severity, payload, source)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				event.event_id,
				event.execution_id,
				event.issue_id,
				event.project_name,
				event.event_type,
				event.severity ?? "info",
				event.payload ? JSON.stringify(event.payload) : null,
				event.source,
			],
		);
	}

	/**
	 * FLY-1099 §4.2: durably defer a founder ship-decision — ONE transaction:
	 *   - same (question_id, msg_id) already exists → STRICT no-op (no TTL
	 *     refresh, no ledger write — Codex R1 #3);
	 *   - a different active row for the gate → invalidated `replaced`;
	 *   - insert the new row (expires = now + ttlSeconds);
	 *   - insert the `held_reply` thread-notice intent (only committed together
	 *     with the durable deferral — the "已存着" text can never lie).
	 * Throws on failure (caller maps to a transient retry disposition).
	 */
	deferFounderApproval(input: {
		questionId: string;
		msgId: string;
		executionId: string;
		issueId: string;
		projectName: string;
		prHeadSha: string;
		threadId: string;
		decision: "approve" | "reject";
		content: string;
		authorUserId: string;
		founderIdAtCapture: string;
		ttlSeconds: number;
		heldReplyAction?: FounderActionIntent;
		audit?: SessionEvent;
	}): "inserted" | "noop_existing" {
		let outcome: "inserted" | "noop_existing" = "inserted";
		this.db.transaction(() => {
			const existing = this.db.exec(
				"SELECT 1 FROM founder_deferred_approval WHERE question_id = ? AND msg_id = ?",
				[input.questionId, input.msgId],
			);
			if (existing.length > 0 && existing[0]!.values.length > 0) {
				outcome = "noop_existing";
				return;
			}
			this.db.run(
				`UPDATE founder_deferred_approval
				    SET invalidated_at = datetime('now'), invalidated_reason = 'replaced'
				  WHERE question_id = ? AND msg_id != ?
				    AND consumed_at IS NULL AND invalidated_at IS NULL`,
				[input.questionId, input.msgId],
			);
			this.db.run(
				`INSERT INTO founder_deferred_approval
				   (question_id, msg_id, execution_id, issue_id, project_name, pr_head_sha,
				    thread_id, decision, content, author_user_id, founder_id_at_capture, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))`,
				[
					input.questionId,
					input.msgId,
					input.executionId,
					input.issueId,
					input.projectName,
					input.prHeadSha.toLowerCase(),
					input.threadId,
					input.decision,
					input.content,
					input.authorUserId,
					input.founderIdAtCapture,
					Math.max(1, Math.floor(input.ttlSeconds)),
				],
			);
			if (input.heldReplyAction)
				this.insertFounderActionRaw(input.heldReplyAction);
			if (input.audit) this.insertAuditEventRaw(input.audit);
		});
		this.save();
		return outcome;
	}

	/** Active = neither consumed nor invalidated (at most one per gate). */
	listActiveDeferredApprovals(): FounderDeferredApproval[] {
		const stmt = this.db.prepare(
			`SELECT * FROM founder_deferred_approval
			  WHERE consumed_at IS NULL AND invalidated_at IS NULL
			  ORDER BY created_at ASC`,
		);
		const rows: FounderDeferredApproval[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToDeferredApproval(
					stmt.getAsObject() as Record<string, unknown>,
				),
			);
		}
		stmt.free();
		return rows;
	}

	getDeferredApproval(
		questionId: string,
		msgId: string,
	): FounderDeferredApproval | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM founder_deferred_approval WHERE question_id = ? AND msg_id = ?",
		);
		stmt.bind([questionId, msgId]);
		let row: FounderDeferredApproval | undefined;
		if (stmt.step()) {
			row = this.rowToDeferredApproval(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return row;
	}

	/**
	 * FLY-1099 §4.3: invalidate an ACTIVE deferral — ONE transaction with:
	 *   - superseding any still-pending `held_reply` intents for the gate
	 *     (§3.3: an outdated "暂时绑不上" must never post after the terminal
	 *     notice), keyed by the `held-reply-<qid>-` action-key prefix contract;
	 *   - the optional terminal notice intent (ttl_expired / head_drift);
	 *   - the optional idempotent audit event.
	 * Returns false when the row was not active (already consumed/invalidated).
	 */
	invalidateDeferredApproval(input: {
		questionId: string;
		msgId: string;
		reason: string;
		notice?: FounderActionIntent;
		audit?: SessionEvent;
	}): boolean {
		let changed = false;
		this.db.transaction(() => {
			this.db.run(
				`UPDATE founder_deferred_approval
				    SET invalidated_at = datetime('now'), invalidated_reason = ?
				  WHERE question_id = ? AND msg_id = ?
				    AND consumed_at IS NULL AND invalidated_at IS NULL`,
				[input.reason, input.questionId, input.msgId],
			);
			changed = this.db.getRowsModified() > 0;
			if (!changed) return;
			this.db.run(
				`UPDATE founder_action_ledger SET status = 'superseded'
				  WHERE status = 'pending' AND kind = 'held_reply' AND action_key LIKE ?`,
				[`held-reply-${input.questionId}-%`],
			);
			if (input.notice) this.insertFounderActionRaw(input.notice);
			if (input.audit) this.insertAuditEventRaw(input.audit);
		});
		this.save();
		return changed;
	}

	/**
	 * FLY-1099 §4.3: consume an ACTIVE deferral after its decision's
	 * postcondition was reached — ONE transaction with the rebound notice, the
	 * reject-path `feedback_wake` intent (Codex R3 #1 (b'): committed together
	 * with consumed), held-reply supersede, and the audit event.
	 */
	consumeDeferredApproval(input: {
		questionId: string;
		msgId: string;
		notice?: FounderActionIntent;
		feedbackWake?: FounderActionIntent;
		audit?: SessionEvent;
	}): boolean {
		let changed = false;
		this.db.transaction(() => {
			this.db.run(
				`UPDATE founder_deferred_approval
				    SET consumed_at = datetime('now')
				  WHERE question_id = ? AND msg_id = ?
				    AND consumed_at IS NULL AND invalidated_at IS NULL`,
				[input.questionId, input.msgId],
			);
			changed = this.db.getRowsModified() > 0;
			if (!changed) return;
			this.db.run(
				`UPDATE founder_action_ledger SET status = 'superseded'
				  WHERE status = 'pending' AND kind = 'held_reply' AND action_key LIKE ?`,
				[`held-reply-${input.questionId}-%`],
			);
			if (input.notice) this.insertFounderActionRaw(input.notice);
			if (input.feedbackWake) this.insertFounderActionRaw(input.feedbackWake);
			if (input.audit) this.insertAuditEventRaw(input.audit);
		});
		this.save();
		return changed;
	}

	// ── FLY-1099: founder action ledger ──────────────────────────────────────

	private rowToFounderAction(row: Record<string, unknown>): FounderActionRow {
		return {
			action_key: row.action_key as string,
			kind: row.kind as FounderActionKind,
			execution_id: row.execution_id as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			thread_id: (row.thread_id as string) ?? undefined,
			payload: row.payload as string,
			depends_on: (row.depends_on as string) ?? undefined,
			status: row.status as FounderActionStatus,
			attempts: (row.attempts as number) ?? 0,
			last_error: (row.last_error as string) ?? undefined,
			created_at: row.created_at as string,
			delivered_at: (row.delivered_at as string) ?? undefined,
			failed_at_ms:
				row.failed_at_ms == null ? undefined : Number(row.failed_at_ms),
		};
	}

	/** INSERT OR IGNORE by action_key. Returns true iff a new intent row landed. */
	insertFounderAction(intent: FounderActionIntent): boolean {
		this.insertFounderActionRaw(intent);
		const inserted = this.db.getRowsModified() > 0;
		this.save();
		return inserted;
	}

	listPendingFounderActions(): FounderActionRow[] {
		const stmt = this.db.prepare(
			"SELECT * FROM founder_action_ledger WHERE status = 'pending' ORDER BY created_at ASC, action_key ASC",
		);
		const rows: FounderActionRow[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToFounderAction(stmt.getAsObject() as Record<string, unknown>),
			);
		}
		stmt.free();
		return rows;
	}

	getFounderAction(actionKey: string): FounderActionRow | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM founder_action_ledger WHERE action_key = ?",
		);
		stmt.bind([actionKey]);
		let row: FounderActionRow | undefined;
		if (stmt.step()) {
			row = this.rowToFounderAction(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return row;
	}

	markFounderActionDelivered(actionKey: string): void {
		this.db.transaction(() => {
			this.db.run(
				`UPDATE founder_action_ledger
				    SET status = 'delivered', delivered_at = datetime('now')
				  WHERE action_key = ? AND status = 'pending'`,
				[actionKey],
			);
			if (
				this.db.getRowsModified() > 0 &&
				actionKey.startsWith("commdb-finalize-stuck-")
			) {
				this.db.run(
					`UPDATE commdb_finalize_failures SET alerted = 1
					  WHERE execution_id = ?`,
					[actionKey.slice("commdb-finalize-stuck-".length)],
				);
			}
		});
		this.save();
	}

	/** attempts+1 on a still-pending row; returns the new attempt count. */
	recordFounderActionFailure(actionKey: string, error: string): number {
		this.db.run(
			`UPDATE founder_action_ledger
			    SET attempts = attempts + 1, last_error = ?
			  WHERE action_key = ? AND status = 'pending'`,
			[error.slice(0, 500), actionKey],
		);
		this.save();
		const row = this.getFounderAction(actionKey);
		return row?.attempts ?? 0;
	}

	/**
	 * FLY-1099 §3.3 + §7.1: terminal failure — ONE transaction: status='failed'
	 * + `failed_at_ms` (the durable episode salt, Codex R4 #3) + the follow-up
	 * `emit_alert` intent. The caller must pass NO alertIntent when the failing
	 * row itself is `emit_alert` (bounded terminal — the alert chain never
	 * recursively multiplies).
	 */
	markFounderActionFailed(input: {
		actionKey: string;
		error: string;
		nowMs: number;
		alertIntent?: FounderActionIntent;
	}): void {
		this.db.transaction(() => {
			this.db.run(
				`UPDATE founder_action_ledger
				    SET status = 'failed', last_error = ?, failed_at_ms = ?
				  WHERE action_key = ? AND status = 'pending'`,
				[input.error.slice(0, 500), input.nowMs, input.actionKey],
			);
			if (this.db.getRowsModified() > 0 && input.alertIntent) {
				this.insertFounderActionRaw(input.alertIntent);
			}
		});
		this.save();
	}

	/** Cancel a pending intent (eligibility lost / dependency terminal). */
	cancelFounderAction(actionKey: string, reason: string): void {
		this.db.run(
			`UPDATE founder_action_ledger
			    SET status = 'cancelled', last_error = ?
			  WHERE action_key = ? AND status = 'pending'`,
			[reason.slice(0, 500), actionKey],
		);
		this.save();
	}

	// ── FLY-1099: bounded founder-reply retry ledger ─────────────────────────

	// FLY-1238: durable state for the merged-PR last-mile guard.
	private rowToMergedGateGuardFailure(
		row: Record<string, unknown>,
	): MergedGateGuardFailureRow {
		return {
			question_id: row.question_id as string,
			source: row.source as string,
			execution_id: row.execution_id as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			attempts: Number(row.attempts ?? 0),
			first_seen_ms: Number(row.first_seen_ms),
			next_retry_ms: Number(row.next_retry_ms ?? 0),
			last_error: (row.last_error as string) ?? undefined,
			terminal: Number(row.terminal ?? 0) === 1,
			alerted: Number(row.alerted ?? 0) === 1,
			resolved_at: (row.resolved_at as string) ?? undefined,
		};
	}

	ensureMergedGateGuardFailure(input: {
		questionId: string;
		source: string;
		executionId: string;
		issueId: string;
		projectName: string;
		nowMs: number;
	}): MergedGateGuardFailureRow {
		let changed = false;
		this.db.transaction(() => {
			this.db.run(
				`INSERT OR IGNORE INTO merged_gate_guard_failure
				   (question_id, source, execution_id, issue_id, project_name, first_seen_ms)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[
					input.questionId,
					input.source,
					input.executionId,
					input.issueId,
					input.projectName,
					input.nowMs,
				],
			);
			changed = this.db.getRowsModified() > 0;

			// OPEN/CLOSED resolves one UNKNOWN episode, but the same gate can be
			// checked again after the short result cache expires. Re-arm a resolved
			// row so a later outage gets its own bounded backoff and durable alert.
			this.db.run(
				`UPDATE merged_gate_guard_failure
				    SET execution_id = ?, issue_id = ?, project_name = ?, attempts = 0,
				        first_seen_ms = ?, next_retry_ms = 0, last_error = NULL,
				        terminal = 0, alerted = 0, resolved_at = NULL
				  WHERE question_id = ? AND source = ? AND resolved_at IS NOT NULL`,
				[
					input.executionId,
					input.issueId,
					input.projectName,
					input.nowMs,
					input.questionId,
					input.source,
				],
			);
			changed = this.db.getRowsModified() > 0 || changed;
		});
		if (changed) this.save();
		return this.getMergedGateGuardFailure(input.questionId, input.source)!;
	}

	getMergedGateGuardFailure(
		questionId: string,
		source: string,
	): MergedGateGuardFailureRow | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM merged_gate_guard_failure WHERE question_id = ? AND source = ?",
		);
		stmt.bind([questionId, source]);
		let row: MergedGateGuardFailureRow | undefined;
		if (stmt.step()) {
			row = this.rowToMergedGateGuardFailure(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return row;
	}

	recordMergedGateGuardUnknown(input: {
		questionId: string;
		source: string;
		nowMs: number;
		nextRetryMs: number;
		error: string;
		terminal: boolean;
	}): MergedGateGuardFailureRow {
		this.db.transaction(() => {
			this.db.run(
				`UPDATE merged_gate_guard_failure
				    SET attempts = attempts + 1, next_retry_ms = ?, last_error = ?,
				        terminal = CASE WHEN ? THEN 1 ELSE terminal END
				  WHERE question_id = ? AND source = ? AND resolved_at IS NULL`,
				[
					input.nextRetryMs,
					input.error.slice(0, 500),
					input.terminal ? 1 : 0,
					input.questionId,
					input.source,
				],
			);
			if (!input.terminal) return;
			const row = this.getMergedGateGuardFailure(
				input.questionId,
				input.source,
			);
			if (!row || row.alerted) return;
			this.insertFounderActionRaw({
				actionKey: `merged-gate-guard-unavailable-${input.questionId}-${input.source}`,
				kind: "emit_alert",
				executionId: row.execution_id,
				issueId: row.issue_id,
				projectName: row.project_name,
				payload: {
					alert: {
						leadId: "",
						projectName: row.project_name,
						eventId: `merged-gate-guard-unavailable-${input.questionId}-${input.source}`,
						eventType: "merged_gate_guard_unavailable",
						title: `Merged gate guard unavailable — ${row.issue_id}`,
						body:
							`Suppressed founder-facing recovery for gate ${input.questionId} after ${row.attempts} inconclusive PR-state checks. ` +
							"Check GitHub and retire or re-drive the gate manually.",
						severity: "warning",
					},
				},
			});
			this.db.run(
				`UPDATE merged_gate_guard_failure SET alerted = 1
				  WHERE question_id = ? AND source = ?`,
				[input.questionId, input.source],
			);
		});
		this.save();
		return this.getMergedGateGuardFailure(input.questionId, input.source)!;
	}

	resolveMergedGateGuardFailure(questionId: string, source: string): void {
		this.db.run(
			`UPDATE merged_gate_guard_failure SET resolved_at = datetime('now')
			  WHERE question_id = ? AND source = ? AND resolved_at IS NULL`,
			[questionId, source],
		);
		if (this.db.getRowsModified() > 0) this.save();
	}

	private rowToCommDbFinalizeFailure(
		row: Record<string, unknown>,
	): CommDbFinalizeFailureRow {
		return {
			execution_id: row.execution_id as string,
			issue_id: row.issue_id as string,
			project_name: row.project_name as string,
			attempts: Number(row.attempts ?? 0),
			first_failure_ms: Number(row.first_failure_ms),
			last_failure_ms: Number(row.last_failure_ms),
			last_error: (row.last_error as string) ?? undefined,
			alerted: Number(row.alerted ?? 0) === 1,
			resolved_at: (row.resolved_at as string) ?? undefined,
		};
	}

	getCommDbFinalizeFailure(
		executionId: string,
	): CommDbFinalizeFailureRow | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM commdb_finalize_failures WHERE execution_id = ?",
		);
		stmt.bind([executionId]);
		let row: CommDbFinalizeFailureRow | undefined;
		if (stmt.step()) {
			row = this.rowToCommDbFinalizeFailure(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return row;
	}

	/** Record every structured finalizer outcome. The third failure or a
	 * fifteen-minute episode queues one stable Lead-only alert; `alerted` is
	 * deliberately set only by markFounderActionDelivered after a real receipt.
	 *
	 * FLY-1328: `audit` carries what the teardown actually disposed of. This is
	 * the audit seam because it is the one method every finalize call site
	 * already reaches AND the one holding issue/project context — the CommDB
	 * wrapper has neither, so its signature stays untouched. */
	recordCommDbFinalizeOutcome(input: {
		executionId: string;
		issueId: string;
		projectName: string;
		ok: boolean;
		error?: string;
		nowMs?: number;
		audit?: {
			retiredGateCount: number;
			retiredAskCount: number;
			source: string;
		};
	}): CommDbFinalizeFailureRow | undefined {
		const nowMs = input.nowMs ?? Date.now();
		// FLY-1328 — an ASK-DISPOSITION record, not a per-finalize one. Only a
		// finalize that truly retired asks writes an event: a failed/no-op close
		// disposed of nothing, and inventing an `owner_closed` record for it would
		// put a fiction in the forensic log. Flag off, no audit, or zero asks all
		// leave today's event set exactly as it is.
		if (
			input.ok &&
			input.audit &&
			input.audit.retiredAskCount > 0 &&
			askHygieneEnabled()
		) {
			this.insertEvent({
				event_id: `commdb-ask-disposed-${input.executionId}`,
				execution_id: input.executionId,
				issue_id: input.issueId,
				project_name: input.projectName,
				event_type: "commdb_ask_disposed",
				source: input.audit.source,
				payload: {
					retiredGateCount: input.audit.retiredGateCount,
					retiredAskCount: input.audit.retiredAskCount,
					resolvedVia: "owner_closed",
					source: input.audit.source,
				},
			});
		}
		if (input.ok) {
			this.db.run(
				`UPDATE commdb_finalize_failures SET resolved_at = datetime('now')
				  WHERE execution_id = ? AND resolved_at IS NULL`,
				[input.executionId],
			);
			if (this.db.getRowsModified() > 0) this.save();
			return this.getCommDbFinalizeFailure(input.executionId);
		}

		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO commdb_finalize_failures
				   (execution_id, issue_id, project_name, attempts,
				    first_failure_ms, last_failure_ms, last_error)
				 VALUES (?, ?, ?, 1, ?, ?, ?)
				 ON CONFLICT(execution_id) DO UPDATE SET
				   issue_id = excluded.issue_id,
				   project_name = excluded.project_name,
				   attempts = commdb_finalize_failures.attempts + 1,
				   last_failure_ms = excluded.last_failure_ms,
				   last_error = excluded.last_error`,
				[
					input.executionId,
					input.issueId,
					input.projectName,
					nowMs,
					nowMs,
					(input.error ?? "unknown").slice(0, 500),
				],
			);
			const row = this.getCommDbFinalizeFailure(input.executionId);
			if (
				!row ||
				row.alerted ||
				row.resolved_at ||
				(row.attempts < 3 && nowMs - row.first_failure_ms < 15 * 60_000)
			) {
				return;
			}
			this.insertFounderActionRaw({
				actionKey: `commdb-finalize-stuck-${input.executionId}`,
				kind: "emit_alert",
				executionId: input.executionId,
				issueId: input.issueId,
				projectName: input.projectName,
				payload: {
					alert: {
						leadId: "",
						projectName: input.projectName,
						eventId: `commdb-finalize-stuck-${input.executionId}`,
						eventType: "commdb_finalize_stuck",
						title: `CommDB finalization stuck — ${input.issueId}`,
						body:
							`Runner ${input.executionId} is physically gone, but its gates and CommDB session could not be retired atomically after ${row.attempts} attempts. ` +
							"Issue-level archive and Linear closeout remain fail-closed; inspect comm.db and retry cleanup.",
						severity: "warning",
					},
				},
			});
		});
		this.save();
		return this.getCommDbFinalizeFailure(input.executionId);
	}

	/** A MERGED verdict already suppresses output; this only retires artifacts. */
	invalidateMergedGateArtifacts(input: {
		executionId: string;
		issueId: string;
		projectName: string;
		questionId: string;
		prNumber: number;
		source: string;
		observedMergeCommitOid?: string;
	}): {
		invalidatedDeferredCount: number;
		supersededActionCount: number;
	} {
		let invalidatedDeferredCount = 0;
		let supersededActionCount = 0;
		this.db.transaction(() => {
			this.db.run(
				`UPDATE founder_deferred_approval
				    SET invalidated_at = datetime('now'), invalidated_reason = 'pr_merged'
				  WHERE question_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
				[input.questionId],
			);
			invalidatedDeferredCount = this.db.getRowsModified();

			const pending = this.db.prepare(
				`SELECT action_key, payload FROM founder_action_ledger
				  WHERE execution_id = ? AND status = 'pending'
				    AND kind IN ('held_reply','ttl_expired_notice','head_drift_notice','rebound_notice')`,
			);
			pending.bind([input.executionId]);
			const matchingKeys: string[] = [];
			while (pending.step()) {
				const row = pending.getAsObject() as Record<string, unknown>;
				try {
					const payload = JSON.parse(String(row.payload)) as Record<
						string,
						unknown
					>;
					if (payload.questionId === input.questionId) {
						matchingKeys.push(String(row.action_key));
					}
				} catch {
					// Malformed payload: do not guess-match an action to another gate.
				}
			}
			pending.free();
			for (const actionKey of matchingKeys) {
				this.db.run(
					`UPDATE founder_action_ledger SET status = 'superseded', last_error = 'pr_merged'
					  WHERE action_key = ? AND status = 'pending'`,
					[actionKey],
				);
				supersededActionCount += this.db.getRowsModified();
			}

			this.insertAuditEventRaw({
				event_id: `merged-gate-suppressed-${input.questionId}-${input.source}`,
				execution_id: input.executionId,
				issue_id: input.issueId,
				project_name: input.projectName,
				event_type: "merged_gate_suppressed",
				source: `bridge.merged-gate-guard.${input.source}`,
				payload: {
					questionId: input.questionId,
					prNumber: input.prNumber,
					observedMergeCommitOid: input.observedMergeCommitOid,
					invalidatedDeferredCount,
					supersededActionCount,
				},
			});
		});
		this.save();
		return { invalidatedDeferredCount, supersededActionCount };
	}

	private rowToFounderReplyRetry(
		row: Record<string, unknown>,
	): FounderReplyRetryRow {
		return {
			thread_id: row.thread_id as string,
			msg_id: row.msg_id as string,
			attempts: (row.attempts as number) ?? 0,
			first_seen: row.first_seen as string,
			first_seen_ms: Number(row.first_seen_ms),
			last_stage: (row.last_stage as string) ?? undefined,
			last_error: (row.last_error as string) ?? undefined,
			dead_lettered_at: (row.dead_lettered_at as string) ?? undefined,
			dead_lettered_ms:
				row.dead_lettered_ms == null ? undefined : Number(row.dead_lettered_ms),
		};
	}

	/** Upsert attempts+1 for a transiently-failed founder message. */
	recordFounderReplyFailure(input: {
		threadId: string;
		msgId: string;
		stage: string;
		error: string;
		nowMs: number;
	}): FounderReplyRetryRow {
		this.db.transaction(() => {
			this.db.run(
				`INSERT OR IGNORE INTO founder_reply_retry (thread_id, msg_id, attempts, first_seen_ms)
				 VALUES (?, ?, 0, ?)`,
				[input.threadId, input.msgId, input.nowMs],
			);
			this.db.run(
				`UPDATE founder_reply_retry
				    SET attempts = attempts + 1, last_stage = ?, last_error = ?
				  WHERE thread_id = ? AND msg_id = ? AND dead_lettered_at IS NULL`,
				[input.stage, input.error.slice(0, 500), input.threadId, input.msgId],
			);
		});
		this.save();
		const row = this.getFounderReplyRetry(input.threadId, input.msgId);
		// The row must exist (just upserted); a defensive fallback keeps callers total.
		return (
			row ?? {
				thread_id: input.threadId,
				msg_id: input.msgId,
				attempts: 1,
				first_seen: "",
				first_seen_ms: input.nowMs,
				last_stage: input.stage,
				last_error: input.error,
			}
		);
	}

	getFounderReplyRetry(
		threadId: string,
		msgId: string,
	): FounderReplyRetryRow | undefined {
		const stmt = this.db.prepare(
			"SELECT * FROM founder_reply_retry WHERE thread_id = ? AND msg_id = ?",
		);
		stmt.bind([threadId, msgId]);
		let row: FounderReplyRetryRow | undefined;
		if (stmt.step()) {
			row = this.rowToFounderReplyRetry(
				stmt.getAsObject() as Record<string, unknown>,
			);
		}
		stmt.free();
		return row;
	}

	listFounderReplyRetries(): FounderReplyRetryRow[] {
		const stmt = this.db.prepare(
			"SELECT * FROM founder_reply_retry ORDER BY first_seen_ms ASC",
		);
		const rows: FounderReplyRetryRow[] = [];
		while (stmt.step()) {
			rows.push(
				this.rowToFounderReplyRetry(
					stmt.getAsObject() as Record<string, unknown>,
				),
			);
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-1099 §7.1: dead-letter — ONE transaction: mark the retry row
	 * (dead_lettered_ms = durable alert salt) + the audit event + the
	 * must-deliver `emit_alert` intent (drained at-least-once).
	 *
	 * Codex code R5 HIGH: a MISSING retry row is CREATED (INSERT OR IGNORE) in
	 * the same transaction before the guarded mark — the pending-dead-letter
	 * latch re-drive runs after a fully-broken-store episode in which the
	 * bookkeeping upsert never landed, and a mark-only UPDATE would return
	 * false forever (latch never clears, no audit, no alert). Returns false
	 * ONLY when the row was already dead-lettered (no duplicate audit/alert).
	 */
	markFounderReplyDeadLettered(input: {
		threadId: string;
		msgId: string;
		nowMs: number;
		audit: SessionEvent;
		alertIntent: FounderActionIntent;
	}): boolean {
		let changed = false;
		this.db.transaction(() => {
			this.db.run(
				`INSERT OR IGNORE INTO founder_reply_retry (thread_id, msg_id, attempts, first_seen_ms)
				 VALUES (?, ?, 0, ?)`,
				[input.threadId, input.msgId, input.nowMs],
			);
			this.db.run(
				`UPDATE founder_reply_retry
				    SET dead_lettered_at = datetime('now'), dead_lettered_ms = ?
				  WHERE thread_id = ? AND msg_id = ? AND dead_lettered_at IS NULL`,
				[input.nowMs, input.threadId, input.msgId],
			);
			changed = this.db.getRowsModified() > 0;
			if (!changed) return;
			this.insertAuditEventRaw(input.audit);
			this.insertFounderActionRaw(input.alertIntent);
		});
		this.save();
		return changed;
	}

	/** Success-path cleanup for one message. */
	clearFounderReplyRetry(threadId: string, msgId: string): void {
		this.db.run(
			"DELETE FROM founder_reply_retry WHERE thread_id = ? AND msg_id = ?",
			[threadId, msgId],
		);
		this.save();
	}

	/**
	 * FLY-1099 §7.2 (Codex R2 #6): waterline cleanup — delete every retry row
	 * the processed-through cursor has safely crossed (message answered by
	 * another path / proven irrelevant), so the pin watchdog never false-alarms
	 * on a message that no longer blocks anything. Snowflakes fit SQLite's
	 * signed 64-bit INTEGER, so CAST comparison is exact.
	 */
	clearFounderReplyRetriesUpTo(
		threadId: string,
		msgIdInclusive: string,
	): number {
		this.db.run(
			`DELETE FROM founder_reply_retry
			  WHERE thread_id = ? AND CAST(msg_id AS INTEGER) <= CAST(? AS INTEGER)`,
			[threadId, msgIdInclusive],
		);
		const n = this.db.getRowsModified();
		if (n > 0) this.save();
		return n;
	}

	/**
	 * FLY-1048 PR-C (C4/FN4): the delivery-failure reconcile input — undelivered
	 * lead_events whose retry budget is exhausted OR whose age crossed the
	 * overdue cutoff. Bounded (oldest first) so a huge backlog drains across
	 * reconcile ticks instead of flooding one pass; the reconcile re-reads
	 * every tick, so the cap delays detection, never drops it.
	 */
	getUndeliveredLeadEventsForReconcile(opts: {
		maxAttempts: number;
		/** Absolute epoch-ms cutoff: rows created at or before it are overdue. */
		overdueCutoffMs: number;
		/**
		 * Codex R3 #3: event types excluded BEFORE the LIMIT — the FN4
		 * detection-family exclusion must not let 100 excluded rows occupy
		 * every slot and starve later genuine delivery failures forever.
		 */
		excludedEventTypes?: readonly string[];
	}): LeadEventRow[] {
		const excluded = opts.excludedEventTypes ?? [];
		const notIn =
			excluded.length > 0
				? ` AND event_type NOT IN (${excluded.map(() => "?").join(", ")})`
				: "";
		const result = this.db.exec(
			`SELECT seq, lead_id, event_id, event_type, payload, session_key, delivered_at, created_at, delivery_attempts, last_delivery_error
			 FROM lead_events
			 WHERE delivered_at IS NULL
			   AND (delivery_attempts >= ? OR created_at <= datetime(?, 'unixepoch'))${notIn}
			 ORDER BY seq ASC
			 LIMIT 100`,
			[opts.maxAttempts, Math.floor(opts.overdueCutoffMs / 1000), ...excluded],
		);
		if (result.length === 0) return [];
		return result[0]!.values.map((row) => ({
			seq: row[0] as number,
			lead_id: row[1] as string,
			event_id: row[2] as string,
			event_type: row[3] as string,
			payload: row[4] as string,
			session_key: (row[5] as string) ?? undefined,
			delivered_at: (row[6] as string) ?? undefined,
			created_at: row[7] as string,
			delivery_attempts: (row[8] as number) ?? 0,
			last_delivery_error: (row[9] as string) ?? undefined,
		}));
	}

	/**
	 * FLY-1048 PR-C (C4/FN4): per-seq delivered probe for the clear pass.
	 * null = the row no longer exists (pruned) — the caller resolves the
	 * episode either way (the evidence is gone).
	 */
	isLeadEventDeliveredBySeq(seq: number): boolean | null {
		const result = this.db.exec(
			"SELECT delivered_at FROM lead_events WHERE seq = ?",
			[seq],
		);
		const values = result[0]?.values;
		if (!values || values.length === 0) return null;
		return values[0]![0] != null;
	}

	/** Get delivery stats for dashboard. */
	getDeliveryStats(leadId?: string): {
		pending_count: number;
		total_delivered: number;
		total_failed: number;
		last_failure_error: string | null;
		last_failure_at: string | null;
	} {
		const whereClause = leadId ? "WHERE lead_id = ?" : "";
		const params = leadId ? [leadId] : [];

		const pendingResult = this.db.exec(
			`SELECT COUNT(*) FROM lead_events ${whereClause ? `${whereClause} AND` : "WHERE"} delivered_at IS NULL AND delivery_attempts > 0 AND delivery_attempts < 3`,
			params,
		);
		const pending_count = (pendingResult[0]?.values[0]?.[0] as number) ?? 0;

		const deliveredResult = this.db.exec(
			`SELECT COUNT(*) FROM lead_events ${whereClause ? `${whereClause} AND` : "WHERE"} delivered_at IS NOT NULL`,
			params,
		);
		const total_delivered = (deliveredResult[0]?.values[0]?.[0] as number) ?? 0;

		const failedResult = this.db.exec(
			`SELECT COUNT(*) FROM lead_events ${whereClause ? `${whereClause} AND` : "WHERE"} delivered_at IS NULL AND delivery_attempts >= 3`,
			params,
		);
		const total_failed = (failedResult[0]?.values[0]?.[0] as number) ?? 0;

		const lastFailureResult = this.db.exec(
			`SELECT last_delivery_error, created_at FROM lead_events ${whereClause ? `${whereClause} AND` : "WHERE"} last_delivery_error IS NOT NULL ORDER BY seq DESC LIMIT 1`,
			params,
		);
		const last_failure_error =
			(lastFailureResult[0]?.values[0]?.[0] as string) ?? null;
		const last_failure_at =
			(lastFailureResult[0]?.values[0]?.[1] as string) ?? null;

		return {
			pending_count,
			total_delivered,
			total_failed,
			last_failure_error,
			last_failure_at,
		};
	}

	/** FLY-25: Migration for existing DBs that lack delivery_attempts/last_delivery_error columns. */
	private migrateLeadEventsDeliveryColumns(): void {
		const info = this.db.exec("PRAGMA table_info(lead_events)");
		if (info.length === 0) return;
		const columns = info[0]!.values.map((row) => row[1] as string);
		if (!columns.includes("delivery_attempts")) {
			this.db.run(
				"ALTER TABLE lead_events ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0",
			);
		}
		if (!columns.includes("last_delivery_error")) {
			this.db.run(
				"ALTER TABLE lead_events ADD COLUMN last_delivery_error TEXT",
			);
		}
		const additions: Array<[string, string]> = [
			["ack_required", "INTEGER NOT NULL DEFAULT 0"],
			["ack_policy", "TEXT"],
			["ack_protocol_version", "INTEGER"],
			["ack_deadline_at", "TEXT"],
			["acked_at", "TEXT"],
			["dead_letter_pending_at", "TEXT"],
			["dead_lettered_at", "TEXT"],
			["ack_token_valid_until", "TEXT"],
			["ack_token_consumed_at", "TEXT"],
			["ingress_disposed_at", "TEXT"],
			["ack_retired_at", "TEXT"],
			["ack_retired_reason", "TEXT"],
			["routing_snapshot", "TEXT"],
			["ack_owner_lead_id", "TEXT"],
			["ack_owner_epoch", "INTEGER NOT NULL DEFAULT 0"],
			[
				"pending_delivery_reason",
				"TEXT CHECK(pending_delivery_reason IN ('owner_transfer','secret_rotation'))",
			],
			["page_claim_token", "TEXT"],
			["page_claim_lease_expires_at", "TEXT"],
		];
		for (const [column, ddl] of additions) {
			if (!columns.includes(column)) {
				this.db.run(`ALTER TABLE lead_events ADD COLUMN ${column} ${ddl}`);
			}
		}
		// Historical rows are ACK-exempt; only fill the mutable owner identity so
		// observability and a future explicit transfer have a total value. Migration
		// errors deliberately escape: starting with a half-migrated delivery journal
		// would silently strand actionable events.
		this.db.run(
			"UPDATE lead_events SET ack_owner_lead_id = lead_id WHERE ack_owner_lead_id IS NULL",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_lead_events_ack_due ON lead_events(ack_required, acked_at, dead_lettered_at, ack_deadline_at)",
		);
	}

	/** FLY-369: add archived_at to chat_threads on legacy DBs (idempotent). */
	private migrateChatThreadsArchivedColumn(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(chat_threads)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			if (!columns.includes("archived_at")) {
				this.db.run("ALTER TABLE chat_threads ADD COLUMN archived_at TEXT");
			}
		} catch {
			// Table may not exist yet (first run) — CREATE TABLE will handle it
		}
	}

	/**
	 * FLY-560 Feature C: add the runner-attach pin columns to chat_threads on
	 * legacy DBs (idempotent). Mirrors migrateChatThreadsArchivedColumn.
	 */
	private migrateChatThreadsAttachPinColumns(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(chat_threads)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			if (!columns.includes("attach_pin_message_id")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN attach_pin_message_id TEXT",
				);
			}
			if (!columns.includes("attach_pin_command")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN attach_pin_command TEXT",
				);
			}
			if (!columns.includes("attach_pin_pinned_at")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN attach_pin_pinned_at TEXT",
				);
			}
		} catch {
			// Table may not exist yet (first run) — CREATE TABLE will handle it
		}
	}

	/**
	 * FLY-887 (founder-visibility status line): add the single-updatable
	 * phase-status-line message columns to chat_threads on legacy DBs
	 * (idempotent). Mirrors migrateChatThreadsAttachPinColumns.
	 */
	/**
	 * FLY-907 (Step 4.5): add the display-reconcile fingerprint columns to
	 * chat_threads on legacy DBs (idempotent). Mirrors
	 * migrateChatThreadsAttachPinColumns (the FLY-560 additive pattern).
	 */
	private migrateChatThreadsDisplayFingerprintColumns(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(chat_threads)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			if (!columns.includes("display_fingerprint")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN display_fingerprint TEXT",
				);
			}
			if (!columns.includes("display_reconciled_at")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN display_reconciled_at TEXT",
				);
			}
		} catch {
			// Table may not exist yet (first run) — CREATE TABLE will handle it
		}
	}

	private migrateChatThreadsPhaseStatusLineColumns(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(chat_threads)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			if (!columns.includes("phase_status_message_id")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN phase_status_message_id TEXT",
				);
			}
			if (!columns.includes("phase_status_text")) {
				this.db.run(
					"ALTER TABLE chat_threads ADD COLUMN phase_status_text TEXT",
				);
			}
		} catch {
			// Table may not exist yet (first run) — CREATE TABLE will handle it
		}
	}

	/**
	 * FLY-643: add the separate-QA-issue columns to auto_qa_record on legacy DBs
	 * (idempotent). Mirrors migrateChatThreads*Columns. A pre-FLY-643 record has
	 * NULLs here (no QA issue yet) — coordinator treats absent qa_issue_id as
	 * "not created" and creates one.
	 */
	private migrateAutoQaRecordQaIssueColumns(): void {
		try {
			const info = this.db.exec("PRAGMA table_info(auto_qa_record)");
			if (info.length === 0) return;
			const columns = info[0]!.values.map((row) => row[1] as string);
			for (const col of [
				"qa_issue_id",
				"qa_issue_identifier",
				"qa_issue_title",
				"qa_issue_url",
				// FLY-752: durable retest-wake crash-recovery marker.
				"retest_wake_pending_at",
			]) {
				if (!columns.includes(col)) {
					this.db.run(`ALTER TABLE auto_qa_record ADD COLUMN ${col} TEXT`);
				}
			}
			if (!columns.includes("auto_retry_count")) {
				this.db.run(
					"ALTER TABLE auto_qa_record ADD COLUMN auto_retry_count INTEGER NOT NULL DEFAULT 0",
				);
			}
			for (const col of ["retry_intent_at", "retry_attempt_id"]) {
				if (!columns.includes(col)) {
					this.db.run(`ALTER TABLE auto_qa_record ADD COLUMN ${col} TEXT`);
				}
			}
			if (!columns.includes("enrollment_source")) {
				this.db.run(
					"ALTER TABLE auto_qa_record ADD COLUMN enrollment_source TEXT NOT NULL DEFAULT 'auto' CHECK (enrollment_source IN ('auto','manual'))",
				);
			}
		} catch {
			// Table may not exist yet (first run) — CREATE TABLE will handle it
		}
	}

	// ── FLY-1185: unified lifecycle closeout state ──────────────────────────

	/**
	 * FLY-1185 §2.1: atomic create-time worktree authority binding. The ONLY
	 * writer of the `worktree_binding_*` column group. Refuses when a binding
	 * already exists (set-once); creates a minimal `pending` session row when
	 * none exists yet (worktree creation precedes emitStarted).
	 */
	bindWorktreeOnce(
		executionId: string,
		binding: { path: string; branch: string; generation: string },
		context?: { issueId?: string; projectName?: string },
	): { bound: boolean; reason?: "already_bound" } {
		let bound = false;
		let alreadyBound = false;
		this.db.transaction(() => {
			const existing = this.getSession(executionId);
			if (!existing) {
				this.db.run(
					`INSERT INTO sessions (execution_id, issue_id, project_name, status,
						worktree_binding_path, worktree_binding_branch,
						worktree_binding_generation, worktree_binding_locked_at)
					 VALUES (?, ?, ?, 'pending', ?, ?, ?, datetime('now'))`,
					[
						executionId,
						context?.issueId ?? "",
						context?.projectName ?? "",
						binding.path,
						binding.branch,
						binding.generation,
					],
				);
				bound = true;
				return;
			}
			this.db.run(
				`UPDATE sessions SET
					worktree_binding_path = ?,
					worktree_binding_branch = ?,
					worktree_binding_generation = ?,
					worktree_binding_locked_at = datetime('now')
				 WHERE execution_id = ? AND worktree_binding_generation IS NULL`,
				[binding.path, binding.branch, binding.generation, executionId],
			);
			if (this.db.getRowsModified() > 0) {
				bound = true;
			} else {
				alreadyBound = true;
			}
		});
		this.save();
		if (alreadyBound) return { bound: false, reason: "already_bound" };
		return { bound };
	}

	/** FLY-1185 §2.1: read a session's worktree authority binding (if any). */
	getWorktreeBinding(executionId: string):
		| {
				path: string;
				branch: string;
				generation: string;
				lockedAt: string | null;
		  }
		| undefined {
		const stmt = this.db.prepare(
			`SELECT worktree_binding_path AS p, worktree_binding_branch AS b,
			        worktree_binding_generation AS g, worktree_binding_locked_at AS l
			 FROM sessions WHERE execution_id = ?`,
		);
		stmt.bind([executionId]);
		let out:
			| {
					path: string;
					branch: string;
					generation: string;
					lockedAt: string | null;
			  }
			| undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			if (row.g) {
				out = {
					path: row.p as string,
					branch: row.b as string,
					generation: row.g as string,
					lockedAt: (row.l as string) ?? null,
				};
			}
		}
		stmt.free();
		return out;
	}

	/**
	 * FLY-1185 §2.1: all sessions of a project that hold a worktree binding —
	 * the classifier's trusted-binding input (fresh read inside the repo lock).
	 */
	listWorktreeBindings(projectName: string): Array<{
		execution_id: string;
		status: string;
		path: string;
		branch: string;
		generation: string;
	}> {
		const stmt = this.db.prepare(
			`SELECT execution_id, status,
			        worktree_binding_path AS p, worktree_binding_branch AS b,
			        worktree_binding_generation AS g
			 FROM sessions
			 WHERE project_name = ? AND worktree_binding_generation IS NOT NULL`,
		);
		stmt.bind([projectName]);
		const rows: Array<{
			execution_id: string;
			status: string;
			path: string;
			branch: string;
			generation: string;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				execution_id: row.execution_id as string,
				status: row.status as string,
				path: row.p as string,
				branch: row.b as string,
				generation: row.g as string,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * FLY-1185 §2.3: observe a cleanup candidate. Inserts / fingerprint-resets /
	 * refreshes the observation and returns the CURRENT stability anchor.
	 * Deleting the object (or it failing another gate) must call
	 * `deleteCleanupRefObservation` so a re-appearing candidate restarts cold.
	 */
	/** FLY-1185 (Codex R2#11) — the sweep's end-of-pass inventory: every
	 * observation for a project, so stale rows (object no longer present)
	 * can be reset and a delete/recreate never inherits an old anchor. */
	listCleanupRefObservations(
		project: string,
	): Array<{ kind: string; ref: string }> {
		const stmt = this.db.prepare(
			`SELECT kind, ref_name AS ref FROM cleanup_ref_observations WHERE project = ?`,
		);
		stmt.bind([project]);
		const rows: Array<{ kind: string; ref: string }> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({ kind: row.kind as string, ref: row.ref as string });
		}
		stmt.free();
		return rows;
	}

	observeCleanupRef(
		project: string,
		kind: string,
		refName: string,
		fingerprint: string,
	): { firstSeenEligibleAt: string } {
		let firstSeen = "";
		this.db.transaction(() => {
			const stmt = this.db.prepare(
				`SELECT fingerprint, first_seen_eligible_at FROM cleanup_ref_observations
				 WHERE project = ? AND kind = ? AND ref_name = ?`,
			);
			stmt.bind([project, kind, refName]);
			let existing: { fingerprint: string; first: string } | undefined;
			if (stmt.step()) {
				const row = stmt.getAsObject() as Record<string, unknown>;
				existing = {
					fingerprint: row.fingerprint as string,
					first: row.first_seen_eligible_at as string,
				};
			}
			stmt.free();
			if (!existing || existing.fingerprint !== fingerprint) {
				this.db.run(
					`INSERT INTO cleanup_ref_observations
						(project, kind, ref_name, fingerprint, first_seen_eligible_at, last_seen_sweep_at)
					 VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
					 ON CONFLICT(project, kind, ref_name) DO UPDATE SET
						fingerprint = excluded.fingerprint,
						first_seen_eligible_at = excluded.first_seen_eligible_at,
						last_seen_sweep_at = excluded.last_seen_sweep_at`,
					[project, kind, refName, fingerprint],
				);
				const re = this.db.prepare(
					`SELECT first_seen_eligible_at FROM cleanup_ref_observations
					 WHERE project = ? AND kind = ? AND ref_name = ?`,
				);
				re.bind([project, kind, refName]);
				if (re.step()) {
					firstSeen = (re.getAsObject() as Record<string, unknown>)
						.first_seen_eligible_at as string;
				}
				re.free();
			} else {
				this.db.run(
					`UPDATE cleanup_ref_observations SET last_seen_sweep_at = datetime('now')
					 WHERE project = ? AND kind = ? AND ref_name = ?`,
					[project, kind, refName],
				);
				firstSeen = existing.first;
			}
		});
		this.save();
		return { firstSeenEligibleAt: firstSeen };
	}

	/** FLY-1185 §2.3: drop an observation (object deleted / gate no longer met). */
	deleteCleanupRefObservation(
		project: string,
		kind: string,
		refName: string,
	): void {
		this.db.run(
			`DELETE FROM cleanup_ref_observations WHERE project = ? AND kind = ? AND ref_name = ?`,
			[project, kind, refName],
		);
		this.save();
	}

	/**
	 * FLY-1185 §2.12 (R10#4): the single-transaction Linear-state observation +
	 * closeout-authority claim. Monotonic on `linearUpdatedAt`:
	 *   - older-than-stored response → ignored (no regression);
	 *   - same timestamp, different stateType → fail-closed conflict;
	 *   - fresh NONTERMINAL → ends any legacy episode AND clears authority;
	 *   - terminal AFTER a durable nonterminal → `terminal_authorized` (persists
	 *     across crashes until a fresh nonterminal clears it);
	 *   - FIRST-SEEN terminal (no prior row) → legacy episode, NO authority.
	 */
	observeLinearStateAndClaimCloseout(input: {
		project: string;
		issueUuid: string;
		stateType: string;
		linearUpdatedAt: string;
	}): {
		outcome: "recorded" | "ignored_stale" | "conflict";
		terminalAuthorized: boolean;
		legacyTerminalEpisode: boolean;
	} {
		const TERMINAL = new Set(["completed", "canceled"]);
		const isTerminal = TERMINAL.has(input.stateType);
		let outcome: "recorded" | "ignored_stale" | "conflict" = "recorded";
		let authorized = false;
		let legacy = false;
		this.db.transaction(() => {
			const stmt = this.db.prepare(
				`SELECT last_state_type, last_linear_updated_at, legacy_terminal_episode, terminal_authorized
				 FROM linear_state_observations WHERE project = ? AND issue_uuid = ?`,
			);
			stmt.bind([input.project, input.issueUuid]);
			let prev:
				| {
						stateType: string;
						updatedAt: string;
						legacy: number;
						authorized: number;
				  }
				| undefined;
			if (stmt.step()) {
				const row = stmt.getAsObject() as Record<string, unknown>;
				prev = {
					stateType: row.last_state_type as string,
					updatedAt: row.last_linear_updated_at as string,
					legacy: (row.legacy_terminal_episode as number) ?? 0,
					authorized: (row.terminal_authorized as number) ?? 0,
				};
			}
			stmt.free();

			if (!prev) {
				legacy = isTerminal;
				authorized = false;
				this.db.run(
					`INSERT INTO linear_state_observations
						(project, issue_uuid, last_state_type, last_linear_updated_at,
						 observed_at, legacy_terminal_episode, terminal_authorized)
					 VALUES (?, ?, ?, ?, datetime('now'), ?, 0)`,
					[
						input.project,
						input.issueUuid,
						input.stateType,
						input.linearUpdatedAt,
						legacy ? 1 : 0,
					],
				);
				return;
			}

			// Monotonic guard — an out-of-order response must not regress state.
			if (
				prev.updatedAt &&
				input.linearUpdatedAt &&
				input.linearUpdatedAt < prev.updatedAt
			) {
				outcome = "ignored_stale";
				authorized = prev.authorized === 1;
				legacy = prev.legacy === 1;
				return;
			}
			if (
				prev.updatedAt === input.linearUpdatedAt &&
				prev.stateType !== input.stateType
			) {
				outcome = "conflict";
				authorized = false;
				legacy = prev.legacy === 1;
				return;
			}

			const prevWasTerminal = TERMINAL.has(prev.stateType);
			if (!isTerminal) {
				// Fresh nonterminal: legacy episode ends, authority clears.
				legacy = false;
				authorized = false;
			} else if (!prevWasTerminal) {
				// The real nonterminal→terminal migration — authority granted.
				legacy = false;
				authorized = true;
			} else {
				// terminal → terminal re-observation: carry episode flags forward.
				legacy = prev.legacy === 1;
				authorized = prev.authorized === 1;
			}
			this.db.run(
				`UPDATE linear_state_observations SET
					last_state_type = ?, last_linear_updated_at = ?, observed_at = datetime('now'),
					legacy_terminal_episode = ?, terminal_authorized = ?
				 WHERE project = ? AND issue_uuid = ?`,
				[
					input.stateType,
					input.linearUpdatedAt,
					legacy ? 1 : 0,
					authorized ? 1 : 0,
					input.project,
					input.issueUuid,
				],
			);
		});
		this.save();
		return {
			outcome,
			terminalAuthorized: authorized,
			legacyTerminalEpisode: legacy,
		};
	}

	/**
	 * FLY-1185 §2.12: the trusted-LOCAL-terminal claim seam. Allowlist callers
	 * ONLY: exact ship-complete proof + founder park intent. Grants closeout
	 * authority through the same durable observation row — never accepted from
	 * runner-visible `/events session_completed`.
	 */
	claimLocalTerminalAuthority(input: {
		project: string;
		issueUuid: string;
		source: "ship_complete" | "founder_park";
	}): void {
		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO linear_state_observations
					(project, issue_uuid, last_state_type, last_linear_updated_at,
					 observed_at, legacy_terminal_episode, terminal_authorized)
				 VALUES (?, ?, 'completed', '', datetime('now'), 0, 1)
				 ON CONFLICT(project, issue_uuid) DO UPDATE SET
					legacy_terminal_episode = 0,
					terminal_authorized = 1,
					observed_at = datetime('now')`,
				[input.project, input.issueUuid],
			);
		});
		this.save();
	}

	/** FLY-1185 (R9#1): read the current observation episode (if any). */
	getLinearStateObservation(
		project: string,
		issueUuid: string,
	):
		| {
				lastStateType: string;
				lastLinearUpdatedAt: string;
				legacyTerminalEpisode: boolean;
				terminalAuthorized: boolean;
		  }
		| undefined {
		const stmt = this.db.prepare(
			`SELECT last_state_type, last_linear_updated_at, legacy_terminal_episode, terminal_authorized
			 FROM linear_state_observations WHERE project = ? AND issue_uuid = ?`,
		);
		stmt.bind([project, issueUuid]);
		let out:
			| {
					lastStateType: string;
					lastLinearUpdatedAt: string;
					legacyTerminalEpisode: boolean;
					terminalAuthorized: boolean;
			  }
			| undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			out = {
				lastStateType: row.last_state_type as string,
				lastLinearUpdatedAt: row.last_linear_updated_at as string,
				legacyTerminalEpisode: (row.legacy_terminal_episode as number) === 1,
				terminalAuthorized: (row.terminal_authorized as number) === 1,
			};
		}
		stmt.free();
		return out;
	}

	// ── FLY-1185 R9#2: founder park intents (issue tombstones) ──────────────

	/** Create/refresh the founder-park tombstone. Idempotent per issue UUID. */
	upsertIssueDispositionIntent(input: {
		issueUuid: string;
		project: string;
		founderDecisionId: string;
		expectedProject?: string;
	}): void {
		this.db.run(
			`INSERT INTO issue_disposition_intents
				(issue_uuid, project, disposition, founder_decision_id, expected_project)
			 VALUES (?, ?, 'founder_parked', ?, ?)
			 ON CONFLICT(issue_uuid) DO UPDATE SET
				project = excluded.project,
				founder_decision_id = excluded.founder_decision_id,
				expected_project = excluded.expected_project,
				superseded_at = NULL,
				superseded_by = NULL,
				closeout_status = 'pending'`,
			[
				input.issueUuid,
				input.project,
				input.founderDecisionId,
				input.expectedProject ?? null,
			],
		);
		this.save();
	}

	/** Read the ACTIVE (non-superseded) tombstone for an issue UUID. */
	getActiveIssueDispositionIntent(issueUuid: string):
		| {
				issueUuid: string;
				project: string;
				disposition: "founder_parked";
				founderDecisionId: string;
				closeoutStatus: "pending" | "partial" | "complete" | "needs_operator";
				lastReport: string | null;
		  }
		| undefined {
		const stmt = this.db.prepare(
			`SELECT issue_uuid, project, disposition, founder_decision_id, closeout_status, last_report
			 FROM issue_disposition_intents
			 WHERE issue_uuid = ? AND superseded_at IS NULL`,
		);
		stmt.bind([issueUuid]);
		let out:
			| {
					issueUuid: string;
					project: string;
					disposition: "founder_parked";
					founderDecisionId: string;
					closeoutStatus: "pending" | "partial" | "complete" | "needs_operator";
					lastReport: string | null;
			  }
			| undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			out = {
				issueUuid: row.issue_uuid as string,
				project: row.project as string,
				disposition: "founder_parked",
				founderDecisionId: row.founder_decision_id as string,
				closeoutStatus: row.closeout_status as
					| "pending"
					| "partial"
					| "complete"
					| "needs_operator",
				lastReport: (row.last_report as string) ?? null,
			};
		}
		stmt.free();
		return out;
	}

	/** List all ACTIVE tombstones whose execution is not complete (replay set). */
	/** FLY-1185 (Codex R1#6): legacy first-seen-terminal episodes — the issue
	 * inventory the manual-apply manifest binds (dry-run enumerates these). */
	/** FLY-1185 (Codex R4#6) — ALL terminal Linear observations (not just the
	 * legacy-episode ones): the D residue union's Linear-mismatch source.
	 * Consumers intersect with local session history to bound the set. */
	listTerminalLinearObservations(): Array<{
		project: string;
		issueUuid: string;
		lastStateType: string;
	}> {
		const stmt = this.db.prepare(
			`SELECT project, issue_uuid, last_state_type
			 FROM linear_state_observations
			 WHERE last_state_type IN ('completed', 'canceled')`,
		);
		const rows: Array<{
			project: string;
			issueUuid: string;
			lastStateType: string;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				project: row.project as string,
				issueUuid: row.issue_uuid as string,
				lastStateType: row.last_state_type as string,
			});
		}
		stmt.free();
		return rows;
	}

	listLegacyTerminalObservations(): Array<{
		project: string;
		issueUuid: string;
		lastStateType: string;
		lastLinearUpdatedAt: string;
	}> {
		const stmt = this.db.prepare(
			`SELECT project, issue_uuid, last_state_type, last_linear_updated_at
			 FROM linear_state_observations
			 WHERE legacy_terminal_episode = 1
			   AND last_state_type IN ('completed', 'canceled')`,
		);
		const rows: Array<{
			project: string;
			issueUuid: string;
			lastStateType: string;
			lastLinearUpdatedAt: string;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				project: row.project as string,
				issueUuid: row.issue_uuid as string,
				lastStateType: row.last_state_type as string,
				lastLinearUpdatedAt: (row.last_linear_updated_at as string) ?? "",
			});
		}
		stmt.free();
		return rows;
	}

	listReplayableDispositionIntents(): Array<{
		issueUuid: string;
		project: string;
		closeoutStatus: string;
	}> {
		const stmt = this.db.prepare(
			`SELECT issue_uuid, project, closeout_status FROM issue_disposition_intents
			 WHERE superseded_at IS NULL AND closeout_status IN ('pending','partial')`,
		);
		const rows: Array<{
			issueUuid: string;
			project: string;
			closeoutStatus: string;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				issueUuid: row.issue_uuid as string,
				project: row.project as string,
				closeoutStatus: row.closeout_status as string,
			});
		}
		stmt.free();
		return rows;
	}

	/** Update ONLY the execution dimension — the tombstone itself stays. */
	setIntentCloseoutStatus(
		issueUuid: string,
		closeoutStatus: "pending" | "partial" | "complete" | "needs_operator",
		lastReport?: string,
	): void {
		this.db.run(
			`UPDATE issue_disposition_intents
			 SET closeout_status = ?, last_report = COALESCE(?, last_report)
			 WHERE issue_uuid = ? AND superseded_at IS NULL`,
			[closeoutStatus, lastReport ?? null, issueUuid],
		);
		this.save();
	}

	/** Founder unpark/supersede — the ONLY way a tombstone stops gating spawns. */
	supersedeIssueDispositionIntent(
		issueUuid: string,
		supersededBy: string,
	): boolean {
		this.db.run(
			`UPDATE issue_disposition_intents
			 SET superseded_at = datetime('now'), superseded_by = ?
			 WHERE issue_uuid = ? AND superseded_at IS NULL`,
			[supersededBy, issueUuid],
		);
		const changed = this.db.getRowsModified() > 0;
		this.save();
		return changed;
	}

	// ── FLY-1185 R11#1: durable launch claims ────────────────────────────────

	/** Written INSIDE the issue mutex by the admission decorator. */
	insertLaunchClaim(input: {
		executionId: string;
		rootUuid: string;
		project: string;
		role?: string;
	}): void {
		this.db.run(
			`INSERT INTO lifecycle_launch_claims (execution_id, root_uuid, project, role, state)
			 VALUES (?, ?, ?, ?, 'starting')
			 ON CONFLICT(execution_id) DO UPDATE SET
				root_uuid = excluded.root_uuid, project = excluded.project,
				role = excluded.role, state = 'starting', updated_at = datetime('now')`,
			[input.executionId, input.rootUuid, input.project, input.role ?? null],
		);
		this.save();
	}

	/**
	 * FLY-1385 W8: durable legacy half of the workflow entry arbitration.
	 * The matching engine half rechecks this claim in the same transaction that
	 * materializes its run + start reservation. SQLite's writer serialization is
	 * the linearization point; no mutex is held across the physical spawn.
	 */
	claimLegacyWorkflowEntry(input: {
		issueId: string;
		issueAliases?: string[];
		rootKey?: string;
		projectName: string;
		executionId: string;
		role?: string;
	}):
		| { ok: true }
		| {
				ok: false;
				reason: "active_engine_run" | "legacy_entry_already_claimed";
		  } {
		let result:
			| { ok: true }
			| {
					ok: false;
					reason: "active_engine_run" | "legacy_entry_already_claimed";
			  } = { ok: true };
		this.db.transaction(() => {
			const issueKeys = [
				...new Set([input.issueId, ...(input.issueAliases ?? [])]),
			];
			const issuePlaceholders = issueKeys.map(() => "?").join(",");
			const activeEngine = this.workflowSelectAll(
				`SELECT run_id FROM workflow_run
				  WHERE project_name = ? AND issue_id IN (${issuePlaceholders})
				    AND status = 'active'
				    AND engine_owned = 1 LIMIT 1`,
				[input.projectName, ...issueKeys],
			)[0];
			if (activeEngine) {
				result = { ok: false, reason: "active_engine_run" };
				return;
			}
			const terminalPlaceholders = ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES.map(
				() => "?",
			).join(",");
			this.db.run(
				`UPDATE lifecycle_launch_claims
				    SET state = 'closed', updated_at = datetime('now')
				  WHERE root_uuid = ? AND project = ?
				    AND COALESCE(role, 'main') = ?
				    AND state IN ('starting', 'active') AND execution_id <> ?
				    AND EXISTS (
				      SELECT 1 FROM sessions s
				       WHERE s.execution_id = lifecycle_launch_claims.execution_id
				         AND s.status IN (${terminalPlaceholders})
				    )`,
				[
					input.rootKey ?? input.issueId,
					input.projectName,
					input.role ?? "main",
					input.executionId,
					...ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES,
				],
			);
			const competingClaim = this.workflowSelectAll(
				`SELECT c.execution_id FROM lifecycle_launch_claims c
				  LEFT JOIN sessions s ON s.execution_id = c.execution_id
				  WHERE c.root_uuid = ? AND c.project = ?
				    AND COALESCE(c.role, 'main') = ?
				    AND c.state IN ('starting', 'active') AND c.execution_id <> ?
				    AND (s.execution_id IS NULL OR s.status NOT IN (${terminalPlaceholders}))
				  LIMIT 1`,
				[
					input.rootKey ?? input.issueId,
					input.projectName,
					input.role ?? "main",
					input.executionId,
					...ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES,
				],
			)[0];
			if (competingClaim) {
				result = { ok: false, reason: "legacy_entry_already_claimed" };
				return;
			}
			this.db.run(
				`INSERT INTO lifecycle_launch_claims
				   (execution_id, root_uuid, project, role, state)
				 VALUES (?, ?, ?, ?, 'starting')
				 ON CONFLICT(execution_id) DO UPDATE SET
				   root_uuid = excluded.root_uuid,
				   project = excluded.project,
				   role = excluded.role,
				   state = CASE
				     WHEN lifecycle_launch_claims.state IN ('closed', 'cancelled')
				       THEN lifecycle_launch_claims.state
				     ELSE 'starting'
				   END,
				   updated_at = datetime('now')`,
				[
					input.executionId,
					input.rootKey ?? input.issueId,
					input.projectName,
					input.role ?? null,
				],
			);
		});
		this.save();
		return result;
	}

	/** starting → active (session row + binding durably visible) or → closed. */
	setLaunchClaimState(
		executionId: string,
		state: "starting" | "active" | "closed" | "cancelled",
	): void {
		this.db.run(
			`UPDATE lifecycle_launch_claims SET state = ?, updated_at = datetime('now')
			 WHERE execution_id = ?`,
			[state, executionId],
		);
		this.save();
	}

	/**
	 * FLY-1185 (Codex R1#5) — atomic compare-and-set on a launch claim. The
	 * park-vs-start arbitration: closeout CASes starting→cancelled; the
	 * dispatcher CASes starting→active right after the session row is durable.
	 * Exactly one side wins; the loser observes and yields.
	 */
	casLaunchClaimState(
		executionId: string,
		from: "starting" | "active",
		to: "starting" | "active" | "closed" | "cancelled",
	): boolean {
		this.db.run(
			`UPDATE lifecycle_launch_claims SET state = ?, updated_at = datetime('now')
			 WHERE execution_id = ? AND state = ?`,
			[to, executionId, from],
		);
		const changed = this.db.getRowsModified() > 0;
		this.save();
		return changed;
	}

	/** FLY-1185 (Codex R3#7): read a durable apply claim for (root, hash). */
	getApplyClaim(
		rootUuid: string,
		approvedHash: string,
	): { status: string; reportJson: string | null } | undefined {
		const stmt = this.db.prepare(
			`SELECT status, report_json FROM lifecycle_apply_claims
			 WHERE root_uuid = ? AND approved_hash = ?`,
		);
		stmt.bind([rootUuid, approvedHash]);
		let out: { status: string; reportJson: string | null } | undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			out = {
				status: row.status as string,
				reportJson: (row.report_json as string) ?? null,
			};
		}
		stmt.free();
		return out;
	}

	/** Persist/refresh the apply claim's outcome (idempotent replay source). */
	putApplyClaim(
		rootUuid: string,
		approvedHash: string,
		status: string,
		reportJson: string,
	): void {
		this.db.run(
			`INSERT INTO lifecycle_apply_claims (root_uuid, approved_hash, status, report_json)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(root_uuid, approved_hash) DO UPDATE SET
				status = excluded.status, report_json = excluded.report_json,
				updated_at = datetime('now')`,
			[rootUuid, approvedHash, status, reportJson],
		);
		this.save();
	}

	/** Read a single launch claim (any state). */
	getLaunchClaim(executionId: string):
		| {
				executionId: string;
				rootUuid: string;
				project: string;
				state: string;
		  }
		| undefined {
		const stmt = this.db.prepare(
			`SELECT execution_id, root_uuid, project, state
			 FROM lifecycle_launch_claims WHERE execution_id = ?`,
		);
		stmt.bind([executionId]);
		let out:
			| {
					executionId: string;
					rootUuid: string;
					project: string;
					state: string;
			  }
			| undefined;
		if (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			out = {
				executionId: row.execution_id as string,
				rootUuid: row.root_uuid as string,
				project: row.project as string,
				state: row.state as string,
			};
		}
		stmt.free();
		return out;
	}

	/** Open (non-closed) claims for a root — visible to node collection. */
	listOpenLaunchClaims(rootUuid: string): Array<{
		executionId: string;
		project: string;
		role: string | null;
		state: "starting" | "active";
		createdAt: string;
	}> {
		const stmt = this.db.prepare(
			`SELECT execution_id, project, role, state, created_at
			 FROM lifecycle_launch_claims
			 WHERE root_uuid = ? AND state IN ('starting','active')`,
		);
		stmt.bind([rootUuid]);
		const rows: Array<{
			executionId: string;
			project: string;
			role: string | null;
			state: "starting" | "active";
			createdAt: string;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				executionId: row.execution_id as string,
				project: row.project as string,
				role: (row.role as string) ?? null,
				state: row.state as "starting" | "active",
				createdAt: row.created_at as string,
			});
		}
		stmt.free();
		return rows;
	}

	/** All stale `starting` claims (maintenance convergence, R12 nit). */
	listStaleStartingClaims(olderThanMinutes: number): Array<{
		executionId: string;
		rootUuid: string;
		project: string;
	}> {
		// R3#2: `active` included — a dispatcher that CASed starting→active and
		// crashed before the session row became durable leaves a rowless
		// `active` claim; the maintenance recovery must see it too.
		const stmt = this.db.prepare(
			`SELECT execution_id, root_uuid, project FROM lifecycle_launch_claims
			 WHERE state IN ('starting', 'active')
			   AND updated_at <= datetime('now', ?)`,
		);
		stmt.bind([`-${Math.max(1, Math.floor(olderThanMinutes))} minutes`]);
		const rows: Array<{
			executionId: string;
			rootUuid: string;
			project: string;
		}> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				executionId: row.execution_id as string,
				rootUuid: row.root_uuid as string,
				project: row.project as string,
			});
		}
		stmt.free();
		return rows;
	}

	// ── FLY-1185: lifecycle-root query helpers ───────────────────────────────

	/**
	 * auto_qa_record rows whose QA-CHILD issue key matches any given key —
	 * the lifecycle-root fold input (a QA child is never its own root).
	 */
	findAutoQaRecordsByQaIssueKeys(keys: string[]): Array<{
		parent_execution_id: string;
		issue_id: string;
	}> {
		const norm = [...new Set(keys.map((k) => k?.trim()).filter(Boolean))];
		if (norm.length === 0) return [];
		const placeholders = norm.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT parent_execution_id, issue_id FROM auto_qa_record
			 WHERE qa_issue_id IN (${placeholders})
			    OR qa_issue_identifier IN (${placeholders})`,
		);
		stmt.bind([...norm, ...norm]);
		const rows: Array<{ parent_execution_id: string; issue_id: string }> = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, unknown>;
			rows.push({
				parent_execution_id: row.parent_execution_id as string,
				issue_id: row.issue_id as string,
			});
		}
		stmt.free();
		return rows;
	}

	/**
	 * auto_qa_record rows whose PARENT-side issue key matches any given key —
	 * the issue-level collector's QA-children enumeration.
	 */
	findAutoQaRecordsByParentIssueKeys(keys: string[]): AutoQaRecord[] {
		const norm = [...new Set(keys.map((k) => k?.trim()).filter(Boolean))];
		if (norm.length === 0) return [];
		const placeholders = norm.map(() => "?").join(", ");
		const stmt = this.db.prepare(
			`SELECT * FROM auto_qa_record WHERE issue_id IN (${placeholders})`,
		);
		stmt.bind(norm);
		const rows: AutoQaRecord[] = [];
		while (stmt.step()) {
			rows.push(stmt.getAsObject() as unknown as AutoQaRecord);
		}
		stmt.free();
		return rows;
	}

	// ── FLY-1135 PR-1: workflow claims ledger substrate (plan §2.1/§2.2) ──────
	// Identity: a decision is (run_id, node_id, decision_kind, attempt). Claims
	// are append-only facts bound to a subject digest; capabilities are one-shot
	// tickets for a node ATTEMPT (never pre-bound to an edge — the verdict picks
	// the edge). Nothing in production reads or writes these tables yet.

	private migrateWorkflowClaimsLedger(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_run (
				run_id TEXT PRIMARY KEY,
				issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				template_id TEXT,
				template_revision INTEGER,
				snapshot JSON,
				selection_source TEXT,
				selected_by TEXT,
				selection_reason TEXT,
				current_node_id TEXT,
				current_qa_attempt INTEGER,
				status TEXT NOT NULL DEFAULT 'active',
				claims_read_enrolled INTEGER NOT NULL DEFAULT 0,
				engine_owned INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		// Existing FLY-1232 databases predate the explicit current-QA authority.
		// Scope the migration to the column itself; legacy null rows stay valid.
		try {
			this.db.run(
				"ALTER TABLE workflow_run ADD COLUMN current_qa_attempt INTEGER",
			);
		} catch {
			/* column already exists */
		}
		for (const column of [
			"selection_source TEXT",
			"selected_by TEXT",
			"selection_reason TEXT",
			"task_category TEXT",
			"category_source TEXT",
			"tier TEXT",
			"engine_owned INTEGER NOT NULL DEFAULT 0",
			// FLY-1372: durable entry provenance. ONLY the pipeline.dag dispatch
			// entry writes 'pipeline_dag_v1' (atomically in the materialize
			// transaction); existing v2 / explicit-v1 runs stay NULL, so the DAG
			// recovery domain can never intercept them (engine_owned is NOT a
			// provenance — every start-reservation run has it).
			"entry_kind TEXT",
		]) {
			try {
				this.db.run(`ALTER TABLE workflow_run ADD COLUMN ${column}`);
			} catch {
				/* column already exists */
			}
		}
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_run_node (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				state TEXT NOT NULL,
				execution_id TEXT,
				started_at TEXT NOT NULL DEFAULT (datetime('now')),
				ended_at TEXT,
				PRIMARY KEY (run_id, node_id, attempt)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_run_event (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				event_uid TEXT NOT NULL UNIQUE,
				kind TEXT NOT NULL,
				node_id TEXT,
				edge_id TEXT,
				execution_id TEXT,
				payload JSON,
				at TEXT NOT NULL DEFAULT (datetime('now')),
				UNIQUE (run_id, seq)
			)
		`);
		// FLY-1375: approval authority survives the QA process lifecycle. The
		// source execution is attribution only; materialization and founder
		// approval advance this first-class holder row.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_gate_holder (
				run_id TEXT NOT NULL,
				gate_node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				head_sha TEXT NOT NULL,
				source_execution_id TEXT NOT NULL,
				question_id TEXT NOT NULL UNIQUE,
				card_message_id TEXT,
				state TEXT NOT NULL DEFAULT 'materializing'
				  CHECK (state IN ('materializing','awaiting_review','approved','superseded')),
				materialization_stage TEXT NOT NULL DEFAULT 'question_intent'
				  CHECK (materialization_stage IN (
				    'question_intent','question_written','session_bound',
				    'card_posted','card_bound','completed'
				  )),
				superseded_reason TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (run_id, gate_node_id, attempt, head_sha)
			)
		`);
		this.db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_gate_holder_current
			ON workflow_gate_holder(run_id, gate_node_id)
			WHERE state IN ('materializing','awaiting_review','approved')
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_gate_holder_question ON workflow_gate_holder(question_id, state)",
		);
		// FLY-1375: one fenced, resumable land operation per approved PR head.
		// Step receipts are immutable evidence; ownership may move only by lease
		// expiry and every write is generation-fenced.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS land_operation (
				operation_id TEXT PRIMARY KEY,
				run_id TEXT,
				issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				pr_number INTEGER NOT NULL CHECK (pr_number > 0),
				approved_head TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'intent'
				  CHECK (state IN ('intent','running','partial','completed','held')),
				owner_id TEXT,
				lease_expires_at TEXT,
				generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
				current_step TEXT,
				merge_confirmed_at TEXT,
				finalization_completed_at TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE (project_name, issue_id, pr_number, approved_head)
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_land_operation_work ON land_operation(state, lease_expires_at, updated_at)",
		);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS land_operation_step (
				operation_id TEXT NOT NULL,
				step TEXT NOT NULL,
				receipt_digest TEXT NOT NULL,
				receipt_json TEXT NOT NULL,
				generation INTEGER NOT NULL,
				completed_at TEXT NOT NULL,
				PRIMARY KEY (operation_id, step),
				FOREIGN KEY (operation_id) REFERENCES land_operation(operation_id)
			)
		`);
		// FLY-1385: alert delivery is a durable outbox, not a best-effort side
		// effect of the state transition. A lease generation fences late send
		// results from an earlier worker; three failed attempts dead-letter.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_alert_outbox (
				escalation_uid TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'pending'
				  CHECK (state IN ('pending','delivering','sent','failed')),
				attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
				lease_owner TEXT,
				lease_expires_at TEXT,
				generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_alert_delivery ON workflow_alert_outbox(state, lease_expires_at, created_at)",
		);
		// Founder A-strengthening: a successful dead-execution replacement leaves
		// a durable identity-bound watch. It survives Bridge restarts; the patrol
		// deletes it when its run stops being active or its bounded TTL expires.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_dead_execution_watch (
				dead_execution_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				new_execution_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				observed_at TEXT NOT NULL,
				baseline_json TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'active'
				  CHECK (state IN ('active','tripped')),
				tripped_at TEXT,
				evidence_json TEXT
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_dead_execution_watch_active ON workflow_dead_execution_watch(state, observed_at)",
		);
		// Cursor by physical execution + lifecycle revision. The divergence sweep
		// advances this in the same transaction as any emitted event.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_divergence_check (
				execution_id TEXT PRIMARY KEY,
				checked_lifecycle_revision INTEGER NOT NULL,
				checked_at TEXT NOT NULL
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_sessions_status_revision ON sessions(status, lifecycle_revision)",
		);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_decision_capability (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				token_hash TEXT NOT NULL UNIQUE,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				allowed_predicate_family TEXT NOT NULL,
				manifest_revision INTEGER,
				evidence_schema_version INTEGER NOT NULL DEFAULT 1,
				expected_subject_digest TEXT,
				issued_at TEXT NOT NULL DEFAULT (datetime('now')),
				expires_at TEXT NOT NULL,
				absolute_deadline_at TEXT NOT NULL,
				consumed_at TEXT,
				consumed_claim_id INTEGER,
				revoked INTEGER NOT NULL DEFAULT 0,
				revoked_reason TEXT
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_claims (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				server_seq INTEGER NOT NULL UNIQUE,
				issued_at TEXT NOT NULL DEFAULT (datetime('now')),
				issue_id TEXT NOT NULL,
				workflow_run_id TEXT NOT NULL,
				node_id TEXT,
				decision_kind TEXT NOT NULL,
				attempt INTEGER,
				predicate TEXT NOT NULL CHECK (predicate IN (
					'qa_passed','qa_failed','codex_approved','design_review_approved',
					'design_review_failed','founder_approved','qa_exempt')),
				issuer_kind TEXT NOT NULL CHECK (issuer_kind IN (
					'runner_node','bridge_policy','founder_challenge')),
				issuer_execution_id TEXT,
				issuer_node_id TEXT,
				issuer_vendor TEXT,
				issuer_model TEXT,
				subject_producer_execution_id TEXT,
				subject_kind TEXT NOT NULL CHECK (subject_kind IN ('git_head','snapshot_digest')),
				subject_digest TEXT NOT NULL,
				expires_at TEXT,
				permanent INTEGER NOT NULL DEFAULT 0,
				submission_digest TEXT,
				client_request_id TEXT,
				evidence JSON,
				authority_id TEXT NOT NULL,
				CHECK (issuer_kind != 'runner_node' OR (
					node_id IS NOT NULL AND attempt IS NOT NULL
					AND issuer_execution_id IS NOT NULL AND issuer_node_id IS NOT NULL
					AND issuer_vendor IS NOT NULL AND issuer_model IS NOT NULL
					AND submission_digest IS NOT NULL AND client_request_id IS NOT NULL
				)),
				CHECK (expires_at IS NOT NULL OR permanent = 1)
			)
		`);
		const workflowClaimsSql = (
			this.db.raw
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_claims'",
				)
				.get() as { sql?: string } | undefined
		)?.sql;
		if (
			workflowClaimsSql &&
			!workflowClaimsSql.includes("design_review_failed")
		) {
			const foreignKeys = Number(
				this.db.raw.pragma("foreign_keys", { simple: true }),
			);
			this.db.raw.pragma("foreign_keys = OFF");
			try {
				this.db.raw.transaction(() => {
					this.db.raw.exec(`
						DROP TRIGGER IF EXISTS workflow_claims_no_update;
						DROP TRIGGER IF EXISTS workflow_claims_no_delete;
						CREATE TABLE workflow_claims_next (
							id INTEGER PRIMARY KEY AUTOINCREMENT,
							server_seq INTEGER NOT NULL UNIQUE,
							issued_at TEXT NOT NULL DEFAULT (datetime('now')),
							issue_id TEXT NOT NULL,
							workflow_run_id TEXT NOT NULL,
							node_id TEXT,
							decision_kind TEXT NOT NULL,
							attempt INTEGER,
							predicate TEXT NOT NULL CHECK (predicate IN (
								'qa_passed','qa_failed','codex_approved','design_review_approved',
								'design_review_failed','founder_approved','qa_exempt')),
							issuer_kind TEXT NOT NULL CHECK (issuer_kind IN (
								'runner_node','bridge_policy','founder_challenge')),
							issuer_execution_id TEXT,
							issuer_node_id TEXT,
							issuer_vendor TEXT,
							issuer_model TEXT,
							subject_producer_execution_id TEXT,
							subject_kind TEXT NOT NULL CHECK (subject_kind IN ('git_head','snapshot_digest')),
							subject_digest TEXT NOT NULL,
							expires_at TEXT,
							permanent INTEGER NOT NULL DEFAULT 0,
							submission_digest TEXT,
							client_request_id TEXT,
							evidence JSON,
							authority_id TEXT NOT NULL,
							CHECK (issuer_kind != 'runner_node' OR (
								node_id IS NOT NULL AND attempt IS NOT NULL
								AND issuer_execution_id IS NOT NULL AND issuer_node_id IS NOT NULL
								AND issuer_vendor IS NOT NULL AND issuer_model IS NOT NULL
								AND submission_digest IS NOT NULL AND client_request_id IS NOT NULL
							)),
							CHECK (expires_at IS NOT NULL OR permanent = 1)
						);
						INSERT INTO workflow_claims_next
							(id, server_seq, issued_at, issue_id, workflow_run_id, node_id,
							 decision_kind, attempt, predicate, issuer_kind,
							 issuer_execution_id, issuer_node_id, issuer_vendor, issuer_model,
							 subject_producer_execution_id, subject_kind, subject_digest,
							 expires_at, permanent, submission_digest, client_request_id,
							 evidence, authority_id)
						SELECT id, server_seq, issued_at, issue_id, workflow_run_id, node_id,
							 decision_kind, attempt, predicate, issuer_kind,
							 issuer_execution_id, issuer_node_id, issuer_vendor, issuer_model,
							 subject_producer_execution_id, subject_kind, subject_digest,
							 expires_at, permanent, submission_digest, client_request_id,
							 evidence, authority_id
						  FROM workflow_claims;
						DROP TABLE workflow_claims;
						ALTER TABLE workflow_claims_next RENAME TO workflow_claims;
					`);
				})();
			} finally {
				if (foreignKeys === 1) this.db.raw.pragma("foreign_keys = ON");
			}
		}
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_claim_revocation (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				claim_id INTEGER NOT NULL,
				revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
				reason TEXT NOT NULL,
				actor TEXT NOT NULL
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_execution_binding (
				execution_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				bound_at TEXT NOT NULL,
				UNIQUE (execution_id, run_id, node_id, attempt)
			)
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_execution_binding_no_update
			BEFORE UPDATE ON workflow_execution_binding
			BEGIN SELECT RAISE(ABORT, 'workflow_execution_binding is immutable'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_execution_binding_no_delete
			BEFORE DELETE ON workflow_execution_binding
			BEGIN SELECT RAISE(ABORT, 'workflow_execution_binding is immutable'); END
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_submission_credential (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				credential_hash TEXT NOT NULL UNIQUE,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				family TEXT NOT NULL CHECK (family IN ('qa_verdict','review_verdict')),
				decision_capability_id INTEGER,
				issued_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				absolute_deadline_at TEXT NOT NULL,
				consumed_at TEXT,
				consumed_client_request_id TEXT,
				consumed_submission_digest TEXT,
				claim_id INTEGER,
				revoked INTEGER NOT NULL DEFAULT 0,
				revoked_reason TEXT,
				FOREIGN KEY (execution_id, run_id, node_id, attempt)
					REFERENCES workflow_execution_binding(execution_id, run_id, node_id, attempt),
				FOREIGN KEY (decision_capability_id) REFERENCES workflow_decision_capability(id),
				FOREIGN KEY (claim_id) REFERENCES workflow_claims(id)
			)
		`);
		this.db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_submission_live
			ON workflow_submission_credential(run_id, node_id, attempt)
			WHERE consumed_at IS NULL AND revoked = 0
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_execution_runtime (
				execution_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				vendor TEXT NOT NULL,
				model TEXT NOT NULL,
				effort TEXT NOT NULL,
				resolved_family TEXT NOT NULL,
				capabilities_digest TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY (execution_id, run_id, node_id, attempt)
					REFERENCES workflow_execution_binding(execution_id, run_id, node_id, attempt)
			)
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_execution_runtime_no_update
			BEFORE UPDATE ON workflow_execution_runtime
			BEGIN SELECT RAISE(ABORT, 'workflow_execution_runtime is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_execution_runtime_no_delete
			BEFORE DELETE ON workflow_execution_runtime
			BEGIN SELECT RAISE(ABORT, 'workflow_execution_runtime is append-only'); END
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_node_outputs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				execution_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				output_digest TEXT NOT NULL,
				output_schema TEXT NOT NULL,
				byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
				client_request_id TEXT NOT NULL,
				submission_digest TEXT NOT NULL,
				written_at TEXT NOT NULL,
				UNIQUE (run_id, node_id, attempt),
				FOREIGN KEY (execution_id, run_id, node_id, attempt)
					REFERENCES workflow_execution_binding(execution_id, run_id, node_id, attempt)
			)
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_node_outputs_no_update
			BEFORE UPDATE ON workflow_node_outputs
			BEGIN SELECT RAISE(ABORT, 'workflow_node_outputs is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_node_outputs_no_delete
			BEFORE DELETE ON workflow_node_outputs
			BEGIN SELECT RAISE(ABORT, 'workflow_node_outputs is append-only'); END
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_node_output_current (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				output_id INTEGER NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				execution_id TEXT NOT NULL,
				promoted_at TEXT NOT NULL,
				PRIMARY KEY (run_id, node_id),
				FOREIGN KEY (output_id) REFERENCES workflow_node_outputs(id)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_output_credential (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				credential_hash TEXT NOT NULL UNIQUE,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				issued_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				absolute_deadline_at TEXT NOT NULL,
				consumed_at TEXT,
				consumed_client_request_id TEXT,
				consumed_submission_digest TEXT,
				output_id INTEGER,
				revoked INTEGER NOT NULL DEFAULT 0,
				revoked_reason TEXT,
				FOREIGN KEY (execution_id, run_id, node_id, attempt)
					REFERENCES workflow_execution_binding(execution_id, run_id, node_id, attempt),
				FOREIGN KEY (output_id) REFERENCES workflow_node_outputs(id)
			)
		`);
		this.db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_output_credential_live
			ON workflow_output_credential(run_id, node_id, attempt)
			WHERE consumed_at IS NULL AND revoked = 0
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_node_completion (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				execution_id TEXT NOT NULL,
				route TEXT NOT NULL,
				event_uid TEXT NOT NULL UNIQUE,
				source_event_id TEXT NOT NULL,
				completion_submission_digest TEXT NOT NULL,
				completed_at TEXT NOT NULL,
				PRIMARY KEY (run_id, node_id, attempt),
				FOREIGN KEY (execution_id, run_id, node_id, attempt)
					REFERENCES workflow_execution_binding(execution_id, run_id, node_id, attempt)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_start_reservation (
				idempotency_key TEXT PRIMARY KEY,
				selection_digest TEXT NOT NULL,
				run_id TEXT NOT NULL UNIQUE,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				execution_id TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL
			)
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_start_reservation_no_update
			BEFORE UPDATE ON workflow_start_reservation
			BEGIN SELECT RAISE(ABORT, 'workflow_start_reservation is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_start_reservation_no_delete
			BEFORE DELETE ON workflow_start_reservation
			BEGIN SELECT RAISE(ABORT, 'workflow_start_reservation is append-only'); END
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_start_stage (
				idempotency_key TEXT PRIMARY KEY,
				stage TEXT NOT NULL CHECK (stage IN
				 ('materialized','admitted','commdb_registered','launch_committed','responded')),
				updated_at TEXT NOT NULL,
				FOREIGN KEY (idempotency_key) REFERENCES workflow_start_reservation(idempotency_key)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_start_response (
				idempotency_key TEXT PRIMARY KEY,
				response_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY (idempotency_key) REFERENCES workflow_start_reservation(idempotency_key)
			)
		`);
		// FLY-1407: dispatch route receipts live outside workflow_run because an
		// explicit no-three-stage bypass is forbidden from creating a workflow
		// run/reservation. The immutable digest makes a decided claim resumable;
		// status records the later durable launch evidence.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_route_decision (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				project TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('decided','launched','rejected')),
				route TEXT NOT NULL CHECK(route IN
				 ('workflow_v2','pipeline_dag_v1','legacy','bypass_override','generic_fallback','rejected')),
				idempotency_key TEXT,
				execution_id TEXT,
				run_id TEXT,
				node_id TEXT,
				route_digest TEXT NOT NULL,
				task_category TEXT,
				category_source TEXT CHECK(category_source IS NULL OR category_source IN
				 ('task_category','template_override','default_fallback')),
				tier TEXT CHECK(tier IS NULL OR tier IN ('trivial','light','heavy')),
				routing_override TEXT CHECK(routing_override IS NULL OR routing_override = 'no-three-stage'),
				selection_reason TEXT,
				selected_by TEXT,
				owning_dept TEXT,
				suggested_category TEXT,
				label_documentation_intent INTEGER NOT NULL DEFAULT 0,
				created_by_switch_state TEXT NOT NULL DEFAULT 'work_kind_on',
				error_code TEXT,
				payload_hash TEXT,
				dedup_key TEXT,
				created_at TEXT NOT NULL,
				launched_at TEXT
			)
		`);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_route_decision_key ON workflow_route_decision(idempotency_key) WHERE idempotency_key IS NOT NULL",
		);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_route_decision_execution ON workflow_route_decision(execution_id) WHERE execution_id IS NOT NULL",
		);
		this.db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_route_decision_rejected ON workflow_route_decision(dedup_key) WHERE dedup_key IS NOT NULL",
		);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_route_reminder_outbox (
				dedup_key TEXT PRIMARY KEY,
				decision_id INTEGER NOT NULL UNIQUE,
				project TEXT NOT NULL,
				issue_id TEXT NOT NULL,
				error_code TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				recipient_lead_id TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
				 CHECK(status IN ('pending','accepted','dead_letter')),
				attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
				claim_owner TEXT,
				claim_expires_at TEXT,
				accepted_at TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY (decision_id) REFERENCES workflow_route_decision(id)
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_route_reminder_pending ON workflow_route_reminder_outbox(status, claim_expires_at, created_at)",
		);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_launch_owner (
				execution_id TEXT PRIMARY KEY,
				owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
				owner_id TEXT NOT NULL,
				acquired_at TEXT NOT NULL,
				lease_expires_at TEXT NOT NULL,
				committed_generation INTEGER,
				delivery_attempt INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempt >= 0),
				delivery_owner TEXT,
				delivery_lease_expires_at TEXT,
				delivery_state TEXT NOT NULL DEFAULT 'pending'
				  CHECK (delivery_state IN ('pending','repairing','delivered')),
				CHECK (committed_generation IS NULL OR committed_generation = owner_generation),
				FOREIGN KEY (execution_id) REFERENCES workflow_execution_binding(execution_id)
			)
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_start_response_no_update
			BEFORE UPDATE ON workflow_start_response
			BEGIN SELECT RAISE(ABORT, 'workflow_start_response is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_start_response_no_delete
			BEFORE DELETE ON workflow_start_response
			BEGIN SELECT RAISE(ABORT, 'workflow_start_response is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_node_completion_no_update
			BEFORE UPDATE ON workflow_node_completion
			BEGIN SELECT RAISE(ABORT, 'workflow_node_completion is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_node_completion_no_delete
			BEFORE DELETE ON workflow_node_completion
			BEGIN SELECT RAISE(ABORT, 'workflow_node_completion is append-only'); END
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_source_receipt (
				project TEXT NOT NULL,
				source_event_id TEXT NOT NULL,
				payload_digest TEXT NOT NULL,
				claim_id INTEGER,
				applied_at TEXT NOT NULL,
				PRIMARY KEY (project, source_event_id),
				FOREIGN KEY (claim_id) REFERENCES workflow_claims(id)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_source_deadletter (
				project TEXT NOT NULL,
				source_event_id TEXT NOT NULL,
				reason TEXT NOT NULL,
				at TEXT NOT NULL,
				PRIMARY KEY (project, source_event_id)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_source_cursor (
				project TEXT PRIMARY KEY,
				last_row_id INTEGER NOT NULL DEFAULT 0 CHECK (last_row_id >= 0),
				updated_at TEXT NOT NULL
			)
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_claims_gate ON workflow_claims(workflow_run_id, decision_kind, subject_digest)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_capability_node ON workflow_decision_capability(run_id, node_id)",
		);
		// Append-only enforcement: the ledger is history. Corrections APPEND (a
		// revocation row, a new attempt) — rows are never rewritten, so a gate
		// verdict can always be reconstructed from what was actually recorded.
		for (const table of [
			"workflow_claims",
			"workflow_claim_revocation",
			"workflow_run_event",
		]) {
			this.db.run(`
				CREATE TRIGGER IF NOT EXISTS ${table}_no_update
				BEFORE UPDATE ON ${table}
				BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END
			`);
			this.db.run(`
				CREATE TRIGGER IF NOT EXISTS ${table}_no_delete
				BEFORE DELETE ON ${table}
				BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END
			`);
		}
	}

	private workflowSelectAll(
		sql: string,
		params: unknown[],
	): Record<string, unknown>[] {
		const stmt = this.db.prepare(sql);
		stmt.bind(params);
		const rows: Record<string, unknown>[] = [];
		while (stmt.step()) rows.push(stmt.getAsObject());
		stmt.free();
		return rows;
	}

	/** Fail-closed expiry: AT the expiry instant counts as expired. */
	private static workflowExpired(expiresAt: string, nowIso: string): boolean {
		return Date.parse(nowIso) >= Date.parse(expiresAt);
	}

	/**
	 * Fail-closed timestamp boundary (research §B.6): Date.parse(garbage) is
	 * NaN and every NaN comparison is false, which would read as "not expired".
	 * Every timestamp entering the workflow APIs must be finite or the call is
	 * refused — malformed time never widens a window.
	 */
	private static workflowFiniteTimestamp(value: string): boolean {
		return Number.isFinite(Date.parse(value));
	}

	listWorkflowTemplates(): WorkflowTemplateRow[] {
		return this.workflowSelectAll(
			"SELECT * FROM workflow_template ORDER BY template_id",
			[],
		) as unknown as WorkflowTemplateRow[];
	}

	getWorkflowTemplate(templateId: string): WorkflowTemplateRow | undefined {
		return this.workflowSelectAll(
			"SELECT * FROM workflow_template WHERE template_id = ?",
			[templateId],
		)[0] as unknown as WorkflowTemplateRow | undefined;
	}

	getWorkflowTemplateRevision(
		templateId: string,
		revision: number,
	): WorkflowTemplateRevisionRow | undefined {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_template_revision
			 WHERE template_id = ? AND revision = ?`,
			[templateId, revision],
		)[0] as unknown as WorkflowTemplateRevisionRow | undefined;
	}

	listWorkflowTemplateRevisions(
		templateId: string,
	): WorkflowTemplateRevisionRow[] {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_template_revision
			 WHERE template_id = ? ORDER BY revision`,
			[templateId],
		) as unknown as WorkflowTemplateRevisionRow[];
	}

	listWorkflowTemplatePublications(
		templateId: string,
	): WorkflowTemplatePublicationRow[] {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_template_publication
			 WHERE template_id = ? ORDER BY id`,
			[templateId],
		) as unknown as WorkflowTemplatePublicationRow[];
	}

	listWorkflowTemplateAudit(templateId?: string): WorkflowTemplateAuditRow[] {
		return this.workflowSelectAll(
			templateId
				? "SELECT * FROM workflow_template_audit WHERE template_id = ? ORDER BY id"
				: "SELECT * FROM workflow_template_audit ORDER BY id",
			templateId ? [templateId] : [],
		) as unknown as WorkflowTemplateAuditRow[];
	}

	/** Internal authoring API. HTTP intentionally exposes no mutation route. */
	createWorkflowTemplateRevision(input: {
		templateId: string;
		manifest: unknown;
		manifestDigest?: string;
		schemaVersion: number;
		createdBy: string;
		env?: Record<string, string | undefined>;
	}): number {
		const manifest = validateWorkflowManifest(input.manifest);
		if (
			manifest.schema_version === 2 &&
			!isGeneralizedTemplatesEnabled(input.env ?? process.env)
		) {
			throw new Error("generalized workflow templates are disabled by flag");
		}
		if (input.schemaVersion !== manifest.schema_version) {
			throw new Error("workflow template schema version mismatch");
		}
		const digest = canonicalSubmissionDigest(manifest);
		if (input.manifestDigest && input.manifestDigest !== digest) {
			throw new Error("workflow template manifest digest mismatch");
		}
		if (!this.getWorkflowTemplate(input.templateId)) {
			throw new Error(`workflow template not found: ${input.templateId}`);
		}
		let revision = 0;
		this.db.transaction(() => {
			const row = this.workflowSelectAll(
				`SELECT COALESCE(MAX(revision), 0) AS current
				 FROM workflow_template_revision WHERE template_id = ?`,
				[input.templateId],
			)[0];
			revision = Number(row?.current ?? 0) + 1;
			this.db.run(
				`INSERT INTO workflow_template_revision
				 (template_id, revision, manifest, manifest_digest, schema_version, created_by)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[
					input.templateId,
					revision,
					JSON.stringify(manifest),
					digest,
					manifest.schema_version,
					input.createdBy,
				],
			);
			this.db.run(
				`INSERT INTO workflow_template_audit
				 (actor, action, template_id, revision, detail)
				 VALUES (?, 'create', ?, ?, ?)`,
				[
					input.createdBy,
					input.templateId,
					revision,
					JSON.stringify({ manifest_digest: digest }),
				],
			);
			if (input.createdBy !== "system") {
				this.db.run(
					"UPDATE workflow_template SET seed_owner = 'founder' WHERE template_id = ?",
					[input.templateId],
				);
			}
		});
		this.save();
		return revision;
	}

	/**
	 * Management-console authoring boundary: validate first, then append the
	 * revision, publication, pointer update, and both audit facts in one CAS
	 * transaction. A stale editor rolls the entire transaction back, so it can
	 * never leave an orphan revision behind.
	 */
	createAndPublishWorkflowTemplateRevision(input: {
		templateId: string;
		manifest: unknown;
		expectedRevision: number | null;
		createdBy: string;
		/** Repair-only: preserve unrelated retired selections after the caller validates the edited node. */
		allowUnsupportedModels?: boolean;
	}): WorkflowTemplatePublishResult {
		const manifest = validateWorkflowManifest(input.manifest, {
			allowUnsupportedModels: input.allowUnsupportedModels === true,
		});
		const digest = canonicalSubmissionDigest(manifest);
		if (!this.getWorkflowTemplate(input.templateId)) {
			return { status: "not_found" };
		}
		const conflict = Symbol("workflow_template_edit_publish_conflict");
		let revision = 0;
		try {
			this.db.transaction(() => {
				const template = this.workflowSelectAll(
					`SELECT current_published_revision AS current
					 FROM workflow_template WHERE template_id = ?`,
					[input.templateId],
				)[0];
				const current =
					template?.current === null || template?.current === undefined
						? null
						: Number(template.current);
				if (current !== input.expectedRevision) throw conflict;

				const max = this.workflowSelectAll(
					`SELECT COALESCE(MAX(revision), 0) AS revision
					 FROM workflow_template_revision WHERE template_id = ?`,
					[input.templateId],
				)[0];
				revision = Number(max?.revision ?? 0) + 1;
				this.db.run(
					`INSERT INTO workflow_template_revision
					 (template_id, revision, manifest, manifest_digest, schema_version, created_by)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[
						input.templateId,
						revision,
						JSON.stringify(manifest),
						digest,
						manifest.schema_version,
						input.createdBy,
					],
				);
				this.db.run(
					`INSERT INTO workflow_template_publication
					 (template_id, revision, published_by) VALUES (?, ?, ?)`,
					[input.templateId, revision, input.createdBy],
				);
				this.db.run(
					`UPDATE workflow_template
					 SET current_published_revision = ?,
					     seed_owner = CASE
					       WHEN ? = 'system' THEN seed_owner ELSE 'founder' END
					 WHERE template_id = ?
					   AND ((current_published_revision IS NULL AND ? IS NULL)
					        OR current_published_revision = ?)`,
					[
						revision,
						input.createdBy,
						input.templateId,
						input.expectedRevision,
						input.expectedRevision,
					],
				);
				if (this.db.getRowsModified() !== 1) throw conflict;
				this.db.run(
					`INSERT INTO workflow_template_audit
					 (actor, action, template_id, revision, detail)
					 VALUES (?, 'create', ?, ?, ?)`,
					[
						input.createdBy,
						input.templateId,
						revision,
						JSON.stringify({ manifest_digest: digest }),
					],
				);
				this.db.run(
					`INSERT INTO workflow_template_audit
					 (actor, action, template_id, revision, detail)
					 VALUES (?, 'publish', ?, ?, ?)`,
					[
						input.createdBy,
						input.templateId,
						revision,
						JSON.stringify({ expected_revision: input.expectedRevision }),
					],
				);
			});
		} catch (error) {
			if (error !== conflict) throw error;
			return {
				status: "conflict",
				currentRevision:
					this.getWorkflowTemplate(input.templateId)
						?.current_published_revision ?? null,
			};
		}
		this.save();
		return { status: "published", revision };
	}

	publishWorkflowTemplate(input: {
		templateId: string;
		revision: number;
		expectedRevision: number | null;
		publishedBy: string;
		env?: Record<string, string | undefined>;
	}): WorkflowTemplatePublishResult {
		const targetRevision = this.getWorkflowTemplateRevision(
			input.templateId,
			input.revision,
		);
		if (!targetRevision) {
			return { status: "not_found" };
		}
		if (
			targetRevision.schema_version === 2 &&
			!isGeneralizedTemplatesEnabled(input.env ?? process.env)
		) {
			throw new Error("generalized workflow templates are disabled by flag");
		}
		const conflict = Symbol("workflow_template_publish_conflict");
		try {
			this.db.transaction(() => {
				this.db.run(
					`INSERT INTO workflow_template_publication
					 (template_id, revision, published_by) VALUES (?, ?, ?)`,
					[input.templateId, input.revision, input.publishedBy],
				);
				this.db.run(
					`UPDATE workflow_template
					 SET current_published_revision = ?,
					     seed_owner = CASE
					       WHEN ? = 'system' THEN seed_owner ELSE 'founder' END
					 WHERE template_id = ?
					   AND ((current_published_revision IS NULL AND ? IS NULL)
					        OR current_published_revision = ?)`,
					[
						input.revision,
						input.publishedBy,
						input.templateId,
						input.expectedRevision,
						input.expectedRevision,
					],
				);
				if (this.db.getRowsModified() !== 1) throw conflict;
				this.db.run(
					`INSERT INTO workflow_template_audit
					 (actor, action, template_id, revision, detail)
					 VALUES (?, 'publish', ?, ?, ?)`,
					[
						input.publishedBy,
						input.templateId,
						input.revision,
						JSON.stringify({ expected_revision: input.expectedRevision }),
					],
				);
			});
		} catch (error) {
			if (error !== conflict) throw error;
			return {
				status: "conflict",
				currentRevision:
					this.getWorkflowTemplate(input.templateId)
						?.current_published_revision ?? null,
			};
		}
		this.save();
		return { status: "published", revision: input.revision };
	}

	/** Boot seed import: content-hash idempotent and founder-owned rows never move. */
	importWorkflowTemplateSeed(
		seed: LoadedWorkflowSeed,
		env: Record<string, string | undefined> = process.env,
	): WorkflowTemplateSeedImportResult {
		const manifest = validateWorkflowManifest(seed.manifest);
		if (manifest.schema_version === 2 && !isGeneralizedTemplatesEnabled(env)) {
			throw new Error("generalized workflow templates are disabled by flag");
		}
		const digest = canonicalSubmissionDigest(manifest);
		const seedDigest = workflowSeedContentHash({ ...seed, manifest });
		if (seed.contentHash !== seedDigest) {
			throw new Error(
				`workflow seed content hash mismatch: ${seed.templateId}`,
			);
		}
		const existing = this.getWorkflowTemplate(seed.templateId);
		if (existing?.seed_content_hash === seed.contentHash) {
			return {
				status: "unchanged",
				revision: existing.current_published_revision ?? 1,
			};
		}
		if (existing?.seed_owner === "founder") {
			this.db.run(
				`INSERT INTO workflow_template_audit
				 (actor, action, template_id, revision, detail)
				 VALUES ('system', 'seed_import', ?, ?, ?)`,
				[
					seed.templateId,
					existing.current_published_revision,
					JSON.stringify({
						status: "refused",
						reason: "founder_owned_seed_mismatch",
						incoming_content_hash: seed.contentHash,
					}),
				],
			);
			this.save();
			return {
				status: "refused",
				revision: existing.current_published_revision ?? 1,
			};
		}

		let revision = 1;
		this.db.transaction(() => {
			if (!existing) {
				this.db.run(
					`INSERT INTO workflow_template
					 (template_id, name, project_scope, created_by, seed_owner, seed_content_hash)
					 VALUES (?, ?, ?, 'system', 'system', ?)`,
					[seed.templateId, seed.name, seed.projectScope, seed.contentHash],
				);
			} else {
				const max = this.workflowSelectAll(
					`SELECT COALESCE(MAX(revision), 0) AS revision
					 FROM workflow_template_revision WHERE template_id = ?`,
					[seed.templateId],
				)[0];
				revision = Number(max?.revision ?? 0) + 1;
			}
			this.db.run(
				`INSERT INTO workflow_template_revision
					 (template_id, revision, manifest, manifest_digest, schema_version, created_by)
					 VALUES (?, ?, ?, ?, ?, 'system')`,
				[
					seed.templateId,
					revision,
					JSON.stringify(manifest),
					digest,
					manifest.schema_version,
				],
			);
			this.db.run(
				`INSERT INTO workflow_template_publication
				 (template_id, revision, published_by) VALUES (?, ?, 'system')`,
				[seed.templateId, revision],
			);
			this.db.run(
				`UPDATE workflow_template
				 SET name = ?, project_scope = ?, current_published_revision = ?,
				     seed_content_hash = ?
				 WHERE template_id = ?`,
				[
					seed.name,
					seed.projectScope,
					revision,
					seed.contentHash,
					seed.templateId,
				],
			);
			this.db.run(
				`INSERT INTO workflow_template_audit
				 (actor, action, template_id, revision, detail)
				 VALUES ('system', 'seed_import', ?, ?, ?)`,
				[
					seed.templateId,
					revision,
					JSON.stringify({ status: existing ? "updated" : "imported" }),
				],
			);
		});
		this.save();
		return { status: existing ? "updated" : "imported", revision };
	}

	bindWorkflowCategory(input: {
		project: string;
		taskCategory?: string;
		templateId: string;
		updatedBy: string;
	}): void {
		const template = this.getWorkflowTemplate(input.templateId);
		if (!template) {
			throw new Error(`workflow template not found: ${input.templateId}`);
		}
		if (
			template.project_scope !== "global" &&
			template.project_scope !== input.project
		) {
			throw new Error(
				`workflow template project scope ${template.project_scope} does not allow ${input.project}`,
			);
		}
		const category = input.taskCategory?.trim() || "*";
		this.db.transaction(() => {
			this.db.run(
				`INSERT INTO workflow_category_binding
				 (project, task_category, template_id, updated_by)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(project, task_category) DO UPDATE SET
				   template_id = excluded.template_id,
				   updated_by = excluded.updated_by,
				   updated_at = datetime('now')`,
				[input.project, category, input.templateId, input.updatedBy],
			);
			this.db.run(
				`INSERT INTO workflow_template_audit
				 (actor, action, template_id, detail)
				 VALUES (?, 'rebind', ?, ?)`,
				[
					input.updatedBy,
					input.templateId,
					JSON.stringify({ project: input.project, task_category: category }),
				],
			);
		});
		this.save();
	}

	getWorkflowCategoryBinding(
		project: string,
		taskCategory: string,
	): WorkflowCategoryBindingRow | undefined {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_category_binding
			 WHERE project = ? AND task_category IN (?, '*')
			 ORDER BY CASE WHEN task_category = ? THEN 0 ELSE 1 END
			 LIMIT 1`,
			[project, taskCategory, taskCategory],
		)[0] as unknown as WorkflowCategoryBindingRow | undefined;
	}

	listWorkflowCategoryBindings(project?: string): WorkflowCategoryBindingRow[] {
		return this.workflowSelectAll(
			project
				? `SELECT * FROM workflow_category_binding
				   WHERE project = ? ORDER BY task_category, template_id`
				: `SELECT * FROM workflow_category_binding
				   ORDER BY project, task_category, template_id`,
			project ? [project] : [],
		) as unknown as WorkflowCategoryBindingRow[];
	}

	/** Resolve once, overlay once, validate once, then pin the whole snapshot. */
	materializeWorkflowRun(input: {
		runId: string;
		issueId: string;
		entryIssueAliases?: string[];
		entryRootKey?: string;
		projectName: string;
		taskCategory?: string;
		templateId?: string;
		claimsReadEnrolled: boolean;
		override?: WorkflowTemplateOverride;
		actor: string;
		canonicalRoot?: string;
		selection?: {
			source: "founder_override" | "lead" | "binding" | "default";
			selectedBy: string;
			reason: string;
		};
		categorySource?: CategorySource;
		tier?: "trivial" | "light" | "heavy";
		startReservation?: {
			idempotencyKey: string;
			selectionDigest: string;
			nodeId: string;
			attempt: number;
			executionId: string;
			createdAt: string;
		};
		expectedSelection?: {
			templateId: string;
			revision: number;
			manifestDigest: string;
			schemaVersion: 1 | 2;
			selectionSource: "lead" | "binding" | "default";
			selectionDigest: string;
		};
		/**
		 * FLY-1372: durable entry provenance. Set ONLY by the pipeline.dag
		 * dispatch entry; the DAG recovery domain filters on this marker so it
		 * can never intercept existing v2 / explicit-v1 runs (NULL).
		 */
		entryKind?: "pipeline_dag_v1" | "workflow_v2";
		supersedeShadow?: {
			runId: string;
			evidence: RunQuiescenceEvidence[];
			now: string;
		};
		env?: Record<string, string | undefined>;
	}): WorkflowRunRow {
		const binding = input.templateId
			? undefined
			: this.getWorkflowCategoryBinding(
					input.projectName,
					input.taskCategory ?? "*",
				);
		const selectedTemplateId = input.templateId ?? binding?.template_id;
		if (!selectedTemplateId)
			throw new Error("workflow template category binding not found");
		const template = this.getWorkflowTemplate(selectedTemplateId);
		if (!template?.current_published_revision) {
			throw new Error("workflow template has no published revision");
		}
		if (
			template.project_scope !== "global" &&
			template.project_scope !== input.projectName
		) {
			throw new Error(
				`workflow template project scope ${template.project_scope} does not allow ${input.projectName}`,
			);
		}
		const revision = this.getWorkflowTemplateRevision(
			template.template_id,
			template.current_published_revision,
		);
		if (!revision)
			throw new Error("published workflow template revision not found");
		if (
			revision.schema_version === 2 ||
			(revision.schema_version === 1 && input.startReservation)
		) {
			const env = input.env ?? process.env;
			const blocked = workflowTemplateDispatchBlockReason(
				revision.schema_version,
				env,
			);
			if (blocked)
				throw new Error(workflowTemplateDispatchBlockMessage(blocked));
		}
		const base = validateWorkflowManifest(JSON.parse(revision.manifest));
		const applied = input.override
			? applyWorkflowOverride(base, input.override)
			: { manifest: base, override: undefined };
		if (
			isWorkflowManifestV1Land(applied.manifest) &&
			!isLandNodeEnabled(input.env ?? process.env)
		) {
			throw new Error("land workflow node is disabled by flag");
		}
		const generalizedSnapshot =
			applied.manifest.schema_version === 2
				? buildWorkflowRunSnapshotV2({
						template: {
							id: template.template_id,
							revision: template.current_published_revision,
						},
						manifest: applied.manifest,
						canonicalRoot:
							input.canonicalRoot ??
							(() => {
								throw new Error(
									"generalized workflow materialization requires canonicalRoot",
								);
							})(),
						...(input.categorySource
							? {
									workKind: {
										taskCategory: input.taskCategory as never,
										categorySource: input.categorySource,
										...(input.tier ? { tier: input.tier } : {}),
									},
								}
							: {}),
					})
				: undefined;
		const engineSnapshot =
			applied.manifest.schema_version === 1 && input.startReservation
				? buildWorkflowRunSnapshotV1({
						template: {
							id: template.template_id,
							revision: template.current_published_revision,
						},
						manifest: applied.manifest,
						...(input.categorySource
							? {
									workKind: {
										taskCategory: input.taskCategory as never,
										categorySource: input.categorySource,
										...(input.tier ? { tier: input.tier } : {}),
									},
								}
							: {}),
					})
				: generalizedSnapshot;
		const snapshot = engineSnapshot
			? JSON.stringify(engineSnapshot)
			: JSON.stringify({
					schema_version: applied.manifest.schema_version,
					template: {
						id: template.template_id,
						revision: template.current_published_revision,
					},
					manifest_digest: canonicalSubmissionDigest(applied.manifest),
					manifest: applied.manifest,
					...(applied.override ? { override: applied.override } : {}),
				});
		this.db.transaction(() => {
			if (input.expectedSelection) {
				const expected = input.expectedSelection;
				const currentTemplate = this.getWorkflowTemplate(expected.templateId);
				const currentRevision = this.getWorkflowTemplateRevision(
					expected.templateId,
					expected.revision,
				);
				let currentSource: "lead" | "binding" | "default" | undefined;
				let currentTemplateId: string | undefined;
				if (expected.selectionSource === "lead") {
					currentSource = input.templateId ? "lead" : undefined;
					currentTemplateId = input.templateId;
				} else {
					const currentBinding = this.getWorkflowCategoryBinding(
						input.projectName,
						input.taskCategory ?? "*",
					);
					currentSource = currentBinding
						? currentBinding.task_category === "*"
							? "default"
							: "binding"
						: undefined;
					currentTemplateId = currentBinding?.template_id;
				}
				const currentSelectionDigest = canonicalSubmissionDigest(
					buildWorkflowSelectionDigestBody(
						{
							project: input.projectName,
							issueId: input.issueId,
							category: input.taskCategory ?? "*",
							templateId: expected.templateId,
							revision: expected.revision,
							selectionSource: expected.selectionSource,
							selectedBy: input.selection?.selectedBy ?? "",
							reason: input.selection?.reason ?? "",
						},
						input.categorySource
							? {
									categorySource: input.categorySource,
									tier: input.tier,
								}
							: undefined,
					),
				);
				if (
					!input.startReservation ||
					input.startReservation.selectionDigest !== expected.selectionDigest ||
					currentSelectionDigest !== expected.selectionDigest ||
					currentTemplateId !== expected.templateId ||
					currentSource !== expected.selectionSource ||
					currentTemplate?.current_published_revision !== expected.revision ||
					currentRevision?.manifest_digest !== expected.manifestDigest ||
					currentRevision?.schema_version !== expected.schemaVersion
				) {
					throw new Error(
						"workflow template candidate changed during materialization",
					);
				}
			}
			const supersededExecutions = input.supersedeShadow
				? new Set(this.listRunAttributedExecutions(input.supersedeShadow.runId))
				: new Set<string>();
			if (input.startReservation) {
				// FLY-1385 W8: engine half of the shared entry arbitration. Recheck
				// durable legacy sessions + pre-spawn launch claims in THIS transaction,
				// immediately before run/reservation creation. A quiescent shadow's own
				// attributed executions are excluded because the same transaction below
				// supersedes that observation-only run.
				const entryIssueKeys = [
					...new Set([input.issueId, ...(input.entryIssueAliases ?? [])]),
				];
				const entryIssuePlaceholders = entryIssueKeys.map(() => "?").join(",");
				const competingLegacySession = this.workflowSelectAll(
					`SELECT execution_id, status FROM sessions
					  WHERE issue_id IN (${entryIssuePlaceholders})
					     OR issue_identifier IN (${entryIssuePlaceholders})`,
					[...entryIssueKeys, ...entryIssueKeys],
				).find(
					(row) =>
						!supersededExecutions.has(row.execution_id as string) &&
						!isStateStoreIrreversibleTerminalForZombie(row.status as string),
				);
				if (competingLegacySession) {
					throw new Error(
						`legacy_entry_already_claimed:${competingLegacySession.execution_id as string}`,
					);
				}
				const competingLegacyClaim = this.workflowSelectAll(
					`SELECT execution_id FROM lifecycle_launch_claims
					  WHERE root_uuid = ? AND project = ?
					    AND state IN ('starting', 'active')`,
					[input.entryRootKey ?? input.issueId, input.projectName],
				).find((row) => {
					const executionId = row.execution_id as string;
					if (supersededExecutions.has(executionId)) return false;
					const session = this.getSession(executionId);
					return (
						!session ||
						!isStateStoreIrreversibleTerminalForZombie(session.status)
					);
				});
				if (competingLegacyClaim) {
					throw new Error(
						`legacy_entry_already_claimed:${competingLegacyClaim.execution_id as string}`,
					);
				}
			}
			if (input.supersedeShadow) {
				const shadow = this.getWorkflowRun(input.supersedeShadow.runId);
				if (
					!shadow ||
					shadow.status !== "active" ||
					shadow.engine_owned !== 0 ||
					shadow.project_name !== input.projectName ||
					shadow.issue_id !== input.issueId
				) {
					throw new Error("active_run_not_shadow");
				}
				const quiescence = this.validateRunQuiescenceEvidenceTx(
					shadow.run_id,
					input.supersedeShadow.evidence,
					input.supersedeShadow.now,
				);
				if (!quiescence.ok) {
					throw new Error(
						`shadow_run_live:${quiescence.executionIds.join(",")}`,
					);
				}
				this.db.run(
					"UPDATE workflow_run SET status = 'terminated' WHERE run_id = ? AND status = 'active' AND engine_owned = 0",
					[shadow.run_id],
				);
				if (this.db.getRowsModified() !== 1) {
					throw new Error("shadow_run_state_changed");
				}
				this.appendWorkflowRunEventCheckedTx({
					runId: shadow.run_id,
					eventUid: `run_terminated:${shadow.run_id}:supersession`,
					kind: "run_terminated_by_supersession",
					payload: {
						reason: "superseded_by_engine_start",
						at: input.supersedeShadow.now,
					},
				});
			}
			this.db.run(
				`INSERT INTO workflow_run
				 (run_id, issue_id, project_name, template_id, template_revision,
				  snapshot, claims_read_enrolled, engine_owned, current_node_id,
				  selection_source, selected_by, selection_reason, entry_kind,
				  task_category, category_source, tier)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					input.runId,
					input.issueId,
					input.projectName,
					template.template_id,
					template.current_published_revision,
					snapshot,
					input.claimsReadEnrolled ? 1 : 0,
					input.startReservation ? 1 : 0,
					input.startReservation?.nodeId ?? null,
					input.selection?.source ?? null,
					input.selection?.selectedBy ?? null,
					input.selection?.reason ?? null,
					// FLY-1372: entry provenance, pinned in the same transaction.
					input.entryKind ?? null,
					input.categorySource ? (input.taskCategory ?? null) : null,
					input.categorySource ?? null,
					input.tier ?? null,
				],
			);
			if (input.startReservation) {
				this.db.run(
					`INSERT INTO workflow_start_reservation
					   (idempotency_key, selection_digest, run_id, node_id, attempt,
					    execution_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						input.startReservation.idempotencyKey,
						input.startReservation.selectionDigest,
						input.runId,
						input.startReservation.nodeId,
						input.startReservation.attempt,
						input.startReservation.executionId,
						input.startReservation.createdAt,
					],
				);
				this.db.run(
					`INSERT INTO workflow_start_stage
					   (idempotency_key, stage, updated_at)
					 VALUES (?, 'materialized', ?)`,
					[
						input.startReservation.idempotencyKey,
						input.startReservation.createdAt,
					],
				);
				if (input.entryKind) {
					this.allocateWorkflowLaunchOrdinalTx(
						input.runId,
						input.startReservation.nodeId,
						input.startReservation.attempt,
						input.startReservation.executionId,
					);
					this.upsertWorkflowRunNodeTx({
						runId: input.runId,
						nodeId: input.startReservation.nodeId,
						attempt: input.startReservation.attempt,
						state: "pending",
						executionId: input.startReservation.executionId,
					});
				}
			}
			if (applied.override) {
				this.db.run(
					`INSERT INTO workflow_template_audit
					 (actor, action, template_id, revision, run_id, detail)
					 VALUES (?, 'run_override', ?, ?, ?, ?)`,
					[
						input.actor,
						template.template_id,
						template.current_published_revision,
						input.runId,
						JSON.stringify(applied.override),
					],
				);
			}
			if (
				generalizedSnapshot?.resolved.nodes.every(
					(node) =>
						!node.capabilities.shared_branch_writer &&
						!node.capabilities.creates_pr,
				)
			) {
				const serverSeq = this.nextWorkflowClaimSeq();
				const authorityId = `qa_exempt:${input.runId}`;
				this.db.run(
					`INSERT INTO workflow_claims
					   (server_seq, issue_id, workflow_run_id, decision_kind, predicate,
					    issuer_kind, subject_kind, subject_digest, permanent, evidence, authority_id)
					 VALUES (?, ?, ?, 'qa_policy', 'qa_exempt', 'bridge_policy',
					         'snapshot_digest', ?, 1, ?, ?)`,
					[
						serverSeq,
						input.issueId,
						input.runId,
						generalizedSnapshot.snapshot_digest,
						JSON.stringify({
							actor: input.actor,
							reason: "all_nodes_no_write",
						}),
						authorityId,
					],
				);
				this.appendWorkflowRunEventTx({
					runId: input.runId,
					eventUid: `system_claim:bridge_policy:${authorityId}`,
					kind: "claim_written",
					payload: { predicate: "qa_exempt", authorityId },
				});
			}
		});
		this.save();
		return this.getWorkflowRun(input.runId)!;
	}

	/**
	 * Create a workflow run with its TYPED enrollment marker (plan §3.2):
	 * whether this run's gates read the claims ledger is an explicit per-run
	 * fact, never inferred from table contents or global flags.
	 */
	createWorkflowRun(input: {
		runId: string;
		issueId: string;
		projectName: string;
		templateId?: string;
		templateRevision?: number;
		snapshotJson?: string;
		claimsReadEnrolled: boolean;
	}): void {
		this.db.run(
			`INSERT INTO workflow_run
			   (run_id, issue_id, project_name, template_id, template_revision, snapshot, claims_read_enrolled)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				input.runId,
				input.issueId,
				input.projectName,
				input.templateId ?? null,
				input.templateRevision ?? null,
				input.snapshotJson ?? null,
				input.claimsReadEnrolled ? 1 : 0,
			],
		);
		this.save();
	}

	getWorkflowRun(runId: string): WorkflowRunRow | undefined {
		const rows = this.workflowSelectAll(
			"SELECT * FROM workflow_run WHERE run_id = ?",
			[runId],
		);
		const r = rows[0];
		if (!r) return undefined;
		return {
			run_id: r.run_id as string,
			issue_id: r.issue_id as string,
			project_name: r.project_name as string,
			template_id: (r.template_id as string) ?? null,
			template_revision:
				r.template_revision == null ? null : Number(r.template_revision),
			snapshot: (r.snapshot as string) ?? null,
			selection_source: (r.selection_source as string) ?? null,
			selected_by: (r.selected_by as string) ?? null,
			selection_reason: (r.selection_reason as string) ?? null,
			task_category: (r.task_category as string) ?? null,
			category_source: (r.category_source as string) ?? null,
			tier: (r.tier as string) ?? null,
			current_node_id: (r.current_node_id as string) ?? null,
			current_qa_attempt:
				r.current_qa_attempt == null ? null : Number(r.current_qa_attempt),
			status: r.status as string,
			claims_read_enrolled: Number(r.claims_read_enrolled ?? 0),
			engine_owned: Number(r.engine_owned ?? 0),
			entry_kind: (r.entry_kind as string) ?? null,
			created_at: r.created_at as string,
		};
	}

	/**
	 * FLY-1372: read-only recovery accessor — the pipeline.dag entry re-drives
	 * a materialized-but-unresponded run by recovering its original start
	 * reservation from the active run (`run_id` is UNIQUE on the append-only
	 * reservation table).
	 */
	getWorkflowStartReservationForRun(
		runId: string,
	): WorkflowStartReservationRow | undefined {
		const row = this.workflowSelectAll(
			`SELECT r.*, s.stage, s.updated_at AS stage_updated_at
			   FROM workflow_start_reservation r
			   JOIN workflow_start_stage s USING (idempotency_key)
			  WHERE r.run_id = ?`,
			[runId],
		)[0];
		if (!row) return undefined;
		return {
			idempotency_key: row.idempotency_key as string,
			selection_digest: row.selection_digest as string,
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			execution_id: row.execution_id as string,
			created_at: row.created_at as string,
			stage: row.stage as WorkflowStartStage,
			stage_updated_at: row.stage_updated_at as string,
		};
	}

	getWorkflowStartReservation(
		idempotencyKey: string,
	): WorkflowStartReservationRow | undefined {
		const row = this.workflowSelectAll(
			`SELECT r.*, s.stage, s.updated_at AS stage_updated_at
			   FROM workflow_start_reservation r
			   JOIN workflow_start_stage s USING (idempotency_key)
			  WHERE r.idempotency_key = ?`,
			[idempotencyKey],
		)[0];
		if (!row) return undefined;
		return {
			idempotency_key: row.idempotency_key as string,
			selection_digest: row.selection_digest as string,
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			execution_id: row.execution_id as string,
			created_at: row.created_at as string,
			stage: row.stage as WorkflowStartStage,
			stage_updated_at: row.stage_updated_at as string,
		};
	}

	advanceWorkflowStartStage(
		idempotencyKey: string,
		stage: WorkflowStartStage,
		now = new Date().toISOString(),
	): void {
		const order: WorkflowStartStage[] = [
			"materialized",
			"admitted",
			"commdb_registered",
			"launch_committed",
			"responded",
		];
		const current = this.getWorkflowStartReservation(idempotencyKey);
		if (!current) throw new Error("workflow start reservation not found");
		if (order.indexOf(stage) < order.indexOf(current.stage)) return;
		this.db.run(
			"UPDATE workflow_start_stage SET stage = ?, updated_at = ? WHERE idempotency_key = ?",
			[stage, now, idempotencyKey],
		);
		this.save();
	}

	recordWorkflowStartResponse(input: {
		idempotencyKey: string;
		response: unknown;
		now?: string;
	}): void {
		const now = input.now ?? new Date().toISOString();
		this.db.transaction(() => {
			const reservation = this.getWorkflowStartReservation(
				input.idempotencyKey,
			);
			if (
				!reservation ||
				(reservation.stage !== "launch_committed" &&
					reservation.stage !== "responded")
			) {
				throw new Error(
					"workflow start response requires positive launch evidence",
				);
			}
			const launchOwner = this.getWorkflowLaunchOwner(reservation.execution_id);
			if (
				!launchOwner ||
				launchOwner.committed_generation !== launchOwner.owner_generation ||
				launchOwner.delivery_state !== "delivered"
			) {
				throw new Error(
					"workflow start response requires durable launch owner delivery evidence",
				);
			}
			const existing = this.workflowSelectAll(
				"SELECT response_json FROM workflow_start_response WHERE idempotency_key = ?",
				[input.idempotencyKey],
			)[0];
			const responseJson = JSON.stringify(input.response);
			if (existing) {
				if (existing.response_json !== responseJson) {
					throw new Error("workflow start response conflict");
				}
				return;
			}
			this.db.run(
				`INSERT INTO workflow_start_response
				   (idempotency_key, response_json, created_at) VALUES (?, ?, ?)`,
				[input.idempotencyKey, responseJson, now],
			);
			this.db.run(
				"UPDATE workflow_start_stage SET stage = 'responded', updated_at = ? WHERE idempotency_key = ?",
				[now, input.idempotencyKey],
			);
		});
		this.save();
	}

	getWorkflowStartResponse(idempotencyKey: string): unknown | undefined {
		const row = this.workflowSelectAll(
			"SELECT response_json FROM workflow_start_response WHERE idempotency_key = ?",
			[idempotencyKey],
		)[0];
		return row ? JSON.parse(row.response_json as string) : undefined;
	}

	private getWorkflowRouteDecisionByIdentity(input: {
		idempotencyKey?: string;
		executionId?: string;
	}): WorkflowRouteDecisionRow | undefined {
		const row = input.idempotencyKey
			? this.workflowSelectAll(
					"SELECT * FROM workflow_route_decision WHERE idempotency_key = ?",
					[input.idempotencyKey],
				)[0]
			: input.executionId
				? this.workflowSelectAll(
						"SELECT * FROM workflow_route_decision WHERE execution_id = ?",
						[input.executionId],
					)[0]
				: undefined;
		return row as unknown as WorkflowRouteDecisionRow | undefined;
	}

	claimWorkflowRouteDecision(
		input: WorkflowRouteDecisionClaimInput,
	): WorkflowRouteDecisionClaimResult {
		if (!!input.idempotencyKey === !!input.executionId) {
			throw new Error(
				"workflow route decision requires exactly one idempotencyKey or executionId",
			);
		}
		const existing = this.getWorkflowRouteDecisionByIdentity(input);
		if (existing) {
			if (existing.route_digest !== input.routeDigest) {
				return { status: "conflict", decision: existing };
			}
			return {
				status:
					existing.status === "launched"
						? "already_launched"
						: "resume_decided",
				decision: existing,
			};
		}
		const now = input.now ?? new Date().toISOString();
		this.db.run(
			`INSERT INTO workflow_route_decision
			 (project, issue_id, status, route, idempotency_key, execution_id,
			  run_id, node_id, route_digest, task_category, category_source, tier,
			  routing_override, selection_reason, selected_by, owning_dept,
			  suggested_category, label_documentation_intent,
			  created_by_switch_state, created_at)
			 VALUES (?, ?, 'decided', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				input.project,
				input.issueId,
				input.route,
				input.idempotencyKey ?? null,
				input.executionId ?? null,
				input.runId ?? null,
				input.nodeId ?? null,
				input.routeDigest,
				input.taskCategory ?? null,
				input.categorySource ?? null,
				input.tier ?? null,
				input.override ?? null,
				input.selectionReason ?? null,
				input.selectedBy ?? null,
				input.owningDept ?? null,
				input.suggestedCategory ?? null,
				input.labelDocumentationIntent ? 1 : 0,
				input.createdBySwitchState ?? "work_kind_on",
				now,
			],
		);
		this.save();
		return {
			status: "inserted",
			decision: this.getWorkflowRouteDecisionByIdentity(input)!,
		};
	}

	markWorkflowRouteDecisionLaunched(input: {
		idempotencyKey?: string;
		executionId?: string;
		now?: string;
	}): boolean {
		const decision = this.getWorkflowRouteDecisionByIdentity(input);
		if (!decision || decision.status === "rejected") return false;
		if (decision.status === "launched") return true;
		let hasEvidence = false;
		if (decision.idempotency_key) {
			const reservation = this.getWorkflowStartReservation(
				decision.idempotency_key,
			);
			hasEvidence =
				reservation?.stage === "launch_committed" ||
				reservation?.stage === "responded";
		} else if (decision.execution_id) {
			const session = this.getSession(decision.execution_id);
			const claim = this.workflowSelectAll(
				`SELECT state FROM lifecycle_launch_claims
				  WHERE execution_id = ? AND state IN ('starting','active')`,
				[decision.execution_id],
			)[0];
			hasEvidence = !!session && !!claim;
		}
		if (!hasEvidence) return false;
		this.db.run(
			`UPDATE workflow_route_decision
			    SET status = 'launched', launched_at = ?
			  WHERE id = ? AND status = 'decided'`,
			[input.now ?? new Date().toISOString(), decision.id],
		);
		const changed = this.db.getRowsModified() === 1;
		this.save();
		return changed;
	}

	insertRejectedRouteDecisionWithReminder(input: {
		project: string;
		issueId: string;
		errorCode: string;
		payload: unknown;
		recipientLeadId: string;
		owningDept?: string;
		selectedBy?: string;
		now?: string;
	}): { inserted: boolean; dedupKey: string } {
		const now = input.now ?? new Date().toISOString();
		const payloadHash = canonicalSubmissionDigest(input.payload);
		const dedupKey = canonicalSubmissionDigest({
			project: input.project,
			issueId: input.issueId,
			errorCode: input.errorCode,
			payloadHash,
		});
		let inserted = false;
		this.db.transaction(() => {
			this.db.run(
				`INSERT OR IGNORE INTO workflow_route_decision
				 (project, issue_id, status, route, route_digest, selected_by,
				  owning_dept, error_code, payload_hash, dedup_key, created_at)
				 VALUES (?, ?, 'rejected', 'rejected', ?, ?, ?, ?, ?, ?, ?)`,
				[
					input.project,
					input.issueId,
					payloadHash,
					input.selectedBy ?? null,
					input.owningDept ?? null,
					input.errorCode,
					payloadHash,
					dedupKey,
					now,
				],
			);
			inserted = this.db.getRowsModified() === 1;
			if (!inserted) return;
			const decision = this.workflowSelectAll(
				"SELECT id FROM workflow_route_decision WHERE dedup_key = ?",
				[dedupKey],
			)[0];
			this.db.run(
				`INSERT INTO workflow_route_reminder_outbox
				 (dedup_key, decision_id, project, issue_id, error_code,
				  payload_json, recipient_lead_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					dedupKey,
					Number(decision!.id),
					input.project,
					input.issueId,
					input.errorCode,
					JSON.stringify(input.payload),
					input.recipientLeadId,
					now,
					now,
				],
			);
		});
		this.save();
		return { inserted, dedupKey };
	}

	insertWorkflowRouteDecisionReminder(input: {
		idempotencyKey?: string;
		executionId?: string;
		code: string;
		payload: unknown;
		recipientLeadId: string;
		now?: string;
	}): { inserted: boolean; dedupKey: string } {
		const decision = this.getWorkflowRouteDecisionByIdentity(input);
		if (!decision || decision.status === "rejected") {
			throw new Error("workflow route reminder requires a successful decision");
		}
		const now = input.now ?? new Date().toISOString();
		const payloadHash = canonicalSubmissionDigest(input.payload);
		const dedupKey = canonicalSubmissionDigest({
			decisionId: decision.id,
			project: decision.project,
			issueId: decision.issue_id,
			code: input.code,
			payloadHash,
		});
		this.db.run(
			`INSERT OR IGNORE INTO workflow_route_reminder_outbox
			 (dedup_key, decision_id, project, issue_id, error_code,
			  payload_json, recipient_lead_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				dedupKey,
				decision.id,
				decision.project,
				decision.issue_id,
				input.code,
				JSON.stringify(input.payload),
				input.recipientLeadId,
				now,
				now,
			],
		);
		const inserted = this.db.getRowsModified() === 1;
		this.save();
		return { inserted, dedupKey };
	}

	listWorkflowRouteDecisions(): WorkflowRouteDecisionRow[] {
		return this.workflowSelectAll(
			"SELECT * FROM workflow_route_decision ORDER BY id",
			[],
		) as unknown as WorkflowRouteDecisionRow[];
	}

	listWorkflowRouteReminderOutbox(): WorkflowRouteReminderOutboxRow[] {
		return this.workflowSelectAll(
			"SELECT * FROM workflow_route_reminder_outbox ORDER BY created_at, dedup_key",
			[],
		) as unknown as WorkflowRouteReminderOutboxRow[];
	}

	claimWorkflowRouteReminder(input: {
		owner: string;
		now: string;
		leaseExpiresAt: string;
		maxAttempts?: number;
	}): WorkflowRouteReminderClaim | undefined {
		if (
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.leaseExpiresAt) ||
			Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
		) {
			throw new Error("invalid workflow route reminder lease");
		}
		const maxAttempts = input.maxAttempts ?? 3;
		let claimed: WorkflowRouteReminderClaim | undefined;
		this.db.transaction(() => {
			const candidate = this.workflowSelectAll(
				`SELECT * FROM workflow_route_reminder_outbox
				  WHERE status = 'pending'
				    AND attempts < ?
				    AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
				  ORDER BY created_at, dedup_key
				  LIMIT 1`,
				[maxAttempts, input.now],
			)[0] as unknown as WorkflowRouteReminderOutboxRow | undefined;
			if (!candidate) return;
			const attempt = Number(candidate.attempts) + 1;
			this.db.run(
				`UPDATE workflow_route_reminder_outbox
				    SET attempts = ?, claim_owner = ?, claim_expires_at = ?,
				        updated_at = ?
				  WHERE dedup_key = ? AND status = 'pending' AND attempts = ?
				    AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
				[
					attempt,
					input.owner,
					input.leaseExpiresAt,
					input.now,
					candidate.dedup_key,
					candidate.attempts,
					input.now,
				],
			);
			if (this.db.getRowsModified() !== 1) return;
			claimed = {
				dedupKey: candidate.dedup_key,
				attempt,
				eventId: `${candidate.dedup_key}#${attempt}`,
				project: candidate.project,
				issueId: candidate.issue_id,
				errorCode: candidate.error_code,
				payload: JSON.parse(candidate.payload_json) as unknown,
				recipientLeadId: candidate.recipient_lead_id,
			};
		});
		if (claimed) this.save();
		return claimed;
	}

	completeWorkflowRouteReminder(input: {
		dedupKey: string;
		owner: string;
		attempt: number;
		outcome: "accepted" | "retry";
		error?: string;
		now?: string;
		maxAttempts?: number;
	}): boolean {
		const now = input.now ?? new Date().toISOString();
		const maxAttempts = input.maxAttempts ?? 3;
		const status =
			input.outcome === "accepted"
				? "accepted"
				: input.attempt >= maxAttempts
					? "dead_letter"
					: "pending";
		this.db.run(
			`UPDATE workflow_route_reminder_outbox
			    SET status = ?, accepted_at = ?, last_error = ?,
			        claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
			  WHERE dedup_key = ? AND status = 'pending'
			    AND claim_owner = ? AND attempts = ?`,
			[
				status,
				status === "accepted" ? now : null,
				input.error ?? null,
				now,
				input.dedupKey,
				input.owner,
				input.attempt,
			],
		);
		const changed = this.db.getRowsModified() === 1;
		if (changed) this.save();
		return changed;
	}

	summarizeCategorySuggestionAlignment(
		project?: string,
	): WorkflowCategorySuggestionSummary[] {
		const rows = this.workflowSelectAll(
			`SELECT project, owning_dept,
			        COUNT(*) AS total,
			        SUM(CASE WHEN task_category = suggested_category THEN 1 ELSE 0 END) AS matches
			   FROM workflow_route_decision
			  WHERE status = 'launched'
			    AND category_source = 'task_category'
			    AND suggested_category IS NOT NULL
			    ${project ? "AND project = ?" : ""}
			  GROUP BY project, owning_dept
			  ORDER BY project, owning_dept`,
			project ? [project] : [],
		);
		return rows.map((row) => {
			const total = Number(row.total);
			const matches = Number(row.matches);
			return {
				project: row.project as string,
				owningDept: (row.owning_dept as string | null) ?? null,
				total,
				matches,
				ratio: total === 0 ? 0 : matches / total,
			};
		});
	}

	private static workflowLaunchToken(
		executionId: string,
		generation: number,
		deliveryAttempt: number,
	): string {
		return canonicalSubmissionDigest({
			execution_id: executionId,
			owner_generation: generation,
			delivery_attempt: deliveryAttempt,
		});
	}

	private static readWorkflowLaunchMarker(path: string):
		| {
				executionId: string;
				generation: number;
				deliveryAttempt: number;
				token: string;
		  }
		| undefined {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		if (
			Object.keys(parsed).sort().join(",") !==
				"deliveryAttempt,executionId,generation,token" ||
			typeof parsed.executionId !== "string" ||
			!Number.isInteger(parsed.generation) ||
			!Number.isInteger(parsed.deliveryAttempt) ||
			typeof parsed.token !== "string"
		) {
			throw new Error("workflow launch marker malformed");
		}
		return parsed as {
			executionId: string;
			generation: number;
			deliveryAttempt: number;
			token: string;
		};
	}

	getWorkflowLaunchOwner(
		executionId: string,
	): WorkflowLaunchOwnerRow | undefined {
		const row = this.workflowSelectAll(
			"SELECT * FROM workflow_launch_owner WHERE execution_id = ?",
			[executionId],
		)[0];
		if (!row) return undefined;
		return {
			execution_id: row.execution_id as string,
			owner_generation: Number(row.owner_generation),
			owner_id: row.owner_id as string,
			acquired_at: row.acquired_at as string,
			lease_expires_at: row.lease_expires_at as string,
			committed_generation:
				row.committed_generation == null
					? null
					: Number(row.committed_generation),
			delivery_attempt: Number(row.delivery_attempt),
			delivery_owner: (row.delivery_owner as string) ?? null,
			delivery_lease_expires_at:
				(row.delivery_lease_expires_at as string) ?? null,
			delivery_state:
				row.delivery_state as WorkflowLaunchOwnerRow["delivery_state"],
		};
	}

	/** Marker repair and owner acquisition share one SQLite write critical section. */
	recoverOrAcquireWorkflowLaunch(input: {
		executionId: string;
		ownerId: string;
		now: string;
		leaseExpiresAt: string;
		markerPath: string;
	}): WorkflowLaunchAcquireResult {
		if (
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.leaseExpiresAt) ||
			Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
		) {
			return { status: "hold", reason: "invalid_lease" };
		}
		let result: WorkflowLaunchAcquireResult = {
			status: "hold",
			reason: "launch_owner_unknown",
		};
		this.db.transaction(() => {
			if (!this.getWorkflowExecutionBinding(input.executionId)) {
				result = { status: "hold", reason: "execution_not_bound" };
				return;
			}
			const owner = this.getWorkflowLaunchOwner(input.executionId);
			let marker: ReturnType<typeof StateStore.readWorkflowLaunchMarker>;
			try {
				marker = StateStore.readWorkflowLaunchMarker(input.markerPath);
			} catch {
				result = { status: "hold", reason: "marker_malformed" };
				return;
			}
			if (marker) {
				if (!owner) {
					result = { status: "hold", reason: "marker_without_owner" };
					return;
				}
				const expected = StateStore.workflowLaunchToken(
					input.executionId,
					owner.owner_generation,
					owner.delivery_attempt,
				);
				const priorRepairToken =
					owner.delivery_state === "repairing" && owner.delivery_attempt > 0
						? StateStore.workflowLaunchToken(
								input.executionId,
								owner.owner_generation,
								owner.delivery_attempt - 1,
							)
						: undefined;
				const markerIsExpectedPriorRepair =
					priorRepairToken !== undefined &&
					marker.executionId === input.executionId &&
					marker.generation === owner.owner_generation &&
					marker.deliveryAttempt === owner.delivery_attempt - 1 &&
					marker.token === priorRepairToken;
				if (
					!markerIsExpectedPriorRepair &&
					(marker.executionId !== input.executionId ||
						marker.generation !== owner.owner_generation ||
						marker.deliveryAttempt !== owner.delivery_attempt ||
						marker.token !== expected)
				) {
					result = { status: "hold", reason: "marker_fence_mismatch" };
					return;
				}
				if (owner.committed_generation == null) {
					this.db.run(
						`UPDATE workflow_launch_owner
						    SET committed_generation = owner_generation,
						        delivery_state = 'delivered'
						  WHERE execution_id = ? AND owner_generation = ?
						    AND committed_generation IS NULL`,
						[input.executionId, owner.owner_generation],
					);
				}
				result = {
					status: "committed",
					generation: owner.owner_generation,
					deliveryAttempt: owner.delivery_attempt,
					token: expected,
				};
				return;
			}
			if (owner?.committed_generation != null) {
				result = { status: "hold", reason: "committed_marker_missing" };
				return;
			}
			if (!owner) {
				this.db.run(
					`INSERT INTO workflow_launch_owner
					   (execution_id, owner_generation, owner_id, acquired_at, lease_expires_at)
					 VALUES (?, 1, ?, ?, ?)`,
					[input.executionId, input.ownerId, input.now, input.leaseExpiresAt],
				);
				result = {
					status: "acquired",
					generation: 1,
					deliveryAttempt: 0,
					token: StateStore.workflowLaunchToken(input.executionId, 1, 0),
				};
				return;
			}
			if (
				owner.owner_id !== input.ownerId &&
				Date.parse(input.now) < Date.parse(owner.lease_expires_at)
			) {
				result = { status: "busy", generation: owner.owner_generation };
				return;
			}
			const generation =
				owner.owner_id === input.ownerId
					? owner.owner_generation
					: owner.owner_generation + 1;
			this.db.run(
				`UPDATE workflow_launch_owner
				    SET owner_generation = ?, owner_id = ?, acquired_at = ?,
				        lease_expires_at = ?, delivery_attempt = 0,
				        delivery_owner = NULL, delivery_lease_expires_at = NULL,
				        delivery_state = 'pending'
				  WHERE execution_id = ? AND committed_generation IS NULL
				    AND owner_generation = ?`,
				[
					generation,
					input.ownerId,
					input.now,
					input.leaseExpiresAt,
					input.executionId,
					owner.owner_generation,
				],
			);
			if (this.db.getRowsModified() !== 1) {
				result = { status: "busy", generation: owner.owner_generation };
				return;
			}
			result = {
				status: "acquired",
				generation,
				deliveryAttempt: 0,
				token: StateStore.workflowLaunchToken(input.executionId, generation, 0),
			};
		});
		this.save();
		return result;
	}

	renewWorkflowLaunchOwner(input: {
		executionId: string;
		ownerId: string;
		generation: number;
		now: string;
		leaseExpiresAt: string;
	}): { ok: true } | { ok: false; reason: string } {
		if (
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.leaseExpiresAt) ||
			Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
		) {
			return { ok: false, reason: "invalid_lease" };
		}
		let renewed = false;
		this.db.transaction(() => {
			const owner = this.getWorkflowLaunchOwner(input.executionId);
			if (
				!owner ||
				owner.owner_id !== input.ownerId ||
				owner.owner_generation !== input.generation ||
				owner.committed_generation != null ||
				Date.parse(input.now) >= Date.parse(owner.lease_expires_at)
			) {
				return;
			}
			this.db.run(
				`UPDATE workflow_launch_owner SET lease_expires_at = ?
				  WHERE execution_id = ? AND owner_id = ? AND owner_generation = ?
				    AND committed_generation IS NULL AND lease_expires_at > ?`,
				[
					input.leaseExpiresAt,
					input.executionId,
					input.ownerId,
					input.generation,
					input.now,
				],
			);
			renewed = this.db.getRowsModified() === 1;
		});
		this.save();
		return renewed ? { ok: true } : { ok: false, reason: "stale_launch_owner" };
	}

	/**
	 * Re-issues the plaintext output ticket after a pre-launch crash. The durable
	 * launch owner is the serialization fence: only its current, unexpired,
	 * uncommitted generation may revoke the lost ticket and create one replacement.
	 */
	rotateGeneralizedWorkflowOutputCredential(input: {
		executionId: string;
		ownerId: string;
		generation: number;
		now: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
	}): { ok: true; outputCredential: string } | { ok: false; reason: string } {
		if (
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.expiresAt) ||
			!StateStore.workflowFiniteTimestamp(input.absoluteDeadlineAt) ||
			Date.parse(input.expiresAt) <= Date.parse(input.now) ||
			Date.parse(input.expiresAt) > Date.parse(input.absoluteDeadlineAt)
		) {
			return { ok: false, reason: "invalid_expiry" };
		}
		const context = this.generalizedExecutionContext(input.executionId);
		if (!context) return { ok: false, reason: "not_enrolled" };
		if (!context.node.capabilities.produces_output) {
			return { ok: false, reason: "node_does_not_produce_output" };
		}
		let result:
			| { ok: true; outputCredential: string }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "stale_launch_owner",
		};
		this.db.transaction(() => {
			const owner = this.getWorkflowLaunchOwner(input.executionId);
			if (owner?.committed_generation != null) {
				result = { ok: false, reason: "launch_committed" };
				return;
			}
			if (
				!owner ||
				owner.owner_id !== input.ownerId ||
				owner.owner_generation !== input.generation ||
				Date.parse(input.now) >= Date.parse(owner.lease_expires_at)
			) {
				return;
			}
			const unexpectedDecisionTicket = this.workflowSelectAll(
				`SELECT id FROM workflow_submission_credential
				  WHERE execution_id = ? AND consumed_at IS NULL AND revoked = 0
				  LIMIT 1`,
				[input.executionId],
			)[0];
			if (unexpectedDecisionTicket) {
				result = { ok: false, reason: "decision_credential_invariant" };
				return;
			}
			this.db.run(
				`UPDATE workflow_output_credential
				    SET revoked = 1, revoked_reason = 'prelaunch_recovery_rotation'
				  WHERE execution_id = ? AND consumed_at IS NULL AND revoked = 0`,
				[input.executionId],
			);
			const outputCredential = generateCapabilityToken();
			this.db.run(
				`INSERT INTO workflow_output_credential
				   (credential_hash, run_id, node_id, execution_id, attempt,
				    issued_at, expires_at, absolute_deadline_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					hashCapabilityToken(outputCredential),
					context.binding.run_id,
					context.binding.node_id,
					context.binding.execution_id,
					context.binding.attempt,
					input.now,
					input.expiresAt,
					input.absoluteDeadlineAt,
				],
			);
			this.appendWorkflowRunEventCheckedTx({
				runId: context.binding.run_id,
				eventUid: `output_credential_rotated:${input.executionId}:${input.generation}:${input.now}`,
				kind: "output_credential_rotated",
				nodeId: context.binding.node_id,
				executionId: input.executionId,
				payload: {
					attempt: context.binding.attempt,
					ownerGeneration: input.generation,
				},
			});
			result = { ok: true, outputCredential };
		});
		this.save();
		return result;
	}

	/** Output-ticket counterpart of committed delivery repair. */
	rotateGeneralizedWorkflowOutputCredentialForDeliveryRepair(input: {
		executionId: string;
		repairOwner: string;
		generation: number;
		repairAttempt: number;
		now: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
	}): { ok: true; outputCredential: string } | { ok: false; reason: string } {
		if (
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.expiresAt) ||
			!StateStore.workflowFiniteTimestamp(input.absoluteDeadlineAt) ||
			Date.parse(input.expiresAt) <= Date.parse(input.now) ||
			Date.parse(input.expiresAt) > Date.parse(input.absoluteDeadlineAt)
		) {
			return { ok: false, reason: "invalid_expiry" };
		}
		const context = this.generalizedExecutionContext(input.executionId);
		if (!context) return { ok: false, reason: "not_enrolled" };
		if (!context.node.capabilities.produces_output) {
			return { ok: false, reason: "node_does_not_produce_output" };
		}
		let result:
			| { ok: true; outputCredential: string }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "stale_delivery_repair_owner",
		};
		this.db.transaction(() => {
			const owner = this.getWorkflowLaunchOwner(input.executionId);
			if (
				!owner ||
				owner.committed_generation !== input.generation ||
				owner.delivery_state !== "repairing" ||
				owner.delivery_owner !== input.repairOwner ||
				owner.delivery_attempt !== input.repairAttempt ||
				!owner.delivery_lease_expires_at ||
				Date.parse(input.now) >= Date.parse(owner.delivery_lease_expires_at)
			) {
				return;
			}
			const consumed = this.workflowSelectAll(
				`SELECT id FROM workflow_output_credential
				  WHERE execution_id = ? AND consumed_at IS NOT NULL LIMIT 1`,
				[input.executionId],
			)[0];
			if (consumed) {
				result = { ok: false, reason: "output_already_consumed" };
				return;
			}
			const unexpectedDecisionTicket = this.workflowSelectAll(
				`SELECT id FROM workflow_submission_credential
				  WHERE execution_id = ? AND consumed_at IS NULL AND revoked = 0 LIMIT 1`,
				[input.executionId],
			)[0];
			if (unexpectedDecisionTicket) {
				result = { ok: false, reason: "decision_credential_invariant" };
				return;
			}
			const rotationUid = `output_credential_delivery_repair_rotated:${input.executionId}:${input.generation}:${input.repairAttempt}`;
			if (
				this.workflowSelectAll(
					"SELECT 1 AS x FROM workflow_run_event WHERE event_uid = ?",
					[rotationUid],
				)[0]
			) {
				result = { ok: false, reason: "repair_credential_already_rotated" };
				return;
			}
			this.db.run(
				`UPDATE workflow_output_credential
				    SET revoked = 1, revoked_reason = 'delivery_repair_rotation'
				  WHERE execution_id = ? AND consumed_at IS NULL AND revoked = 0`,
				[input.executionId],
			);
			const outputCredential = generateCapabilityToken();
			this.db.run(
				`INSERT INTO workflow_output_credential
				   (credential_hash, run_id, node_id, execution_id, attempt,
				    issued_at, expires_at, absolute_deadline_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					hashCapabilityToken(outputCredential),
					context.binding.run_id,
					context.binding.node_id,
					context.binding.execution_id,
					context.binding.attempt,
					input.now,
					input.expiresAt,
					input.absoluteDeadlineAt,
				],
			);
			this.appendWorkflowRunEventTx({
				runId: context.binding.run_id,
				eventUid: rotationUid,
				kind: "output_credential_rotated",
				nodeId: context.binding.node_id,
				executionId: input.executionId,
				payload: {
					attempt: context.binding.attempt,
					ownerGeneration: input.generation,
					deliveryAttempt: input.repairAttempt,
				},
			});
			result = { ok: true, outputCredential };
		});
		this.save();
		return result;
	}

	/**
	 * Re-issues the plaintext QA/review decision ticket after a pre-launch
	 * crash. As with output-ticket rotation, only the current uncommitted launch
	 * owner may replace the lost capability.
	 */
	rotateGeneralizedWorkflowSubmissionCredential(input: {
		executionId: string;
		ownerId: string;
		generation: number;
		now: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
	}):
		| { ok: true; submissionCredential: string }
		| { ok: false; reason: string } {
		if (
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.expiresAt) ||
			!StateStore.workflowFiniteTimestamp(input.absoluteDeadlineAt) ||
			Date.parse(input.expiresAt) <= Date.parse(input.now) ||
			Date.parse(input.expiresAt) > Date.parse(input.absoluteDeadlineAt)
		) {
			return { ok: false, reason: "invalid_expiry" };
		}
		const context = this.generalizedExecutionContext(input.executionId);
		if (!context) return { ok: false, reason: "not_enrolled" };
		const family: WorkflowDecisionFamily | undefined =
			context.node.type === "qa"
				? "qa_verdict"
				: context.node.type === "review"
					? "review_verdict"
					: undefined;
		if (!family) return { ok: false, reason: "node_does_not_submit_decision" };
		let result:
			| { ok: true; submissionCredential: string }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "stale_launch_owner",
		};
		this.db.transaction(() => {
			const owner = this.getWorkflowLaunchOwner(input.executionId);
			if (owner?.committed_generation != null) {
				result = { ok: false, reason: "launch_committed" };
				return;
			}
			if (
				!owner ||
				owner.owner_id !== input.ownerId ||
				owner.owner_generation !== input.generation ||
				Date.parse(input.now) >= Date.parse(owner.lease_expires_at)
			) {
				return;
			}
			this.db.run(
				`UPDATE workflow_submission_credential
				    SET revoked = 1, revoked_reason = 'prelaunch_recovery_rotation'
				  WHERE execution_id = ? AND consumed_at IS NULL AND revoked = 0`,
				[input.executionId],
			);
			const submissionCredential = generateCapabilityToken();
			this.db.run(
				`INSERT INTO workflow_submission_credential
				   (credential_hash, run_id, node_id, execution_id, attempt, family,
				    issued_at, expires_at, absolute_deadline_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					hashCapabilityToken(submissionCredential),
					context.binding.run_id,
					context.binding.node_id,
					context.binding.execution_id,
					context.binding.attempt,
					family,
					input.now,
					input.expiresAt,
					input.absoluteDeadlineAt,
				],
			);
			this.appendWorkflowRunEventTx({
				runId: context.binding.run_id,
				eventUid: `submission_credential_rotated:${input.executionId}:${input.generation}:${input.now}`,
				kind: "submission_credential_rotated",
				nodeId: context.binding.node_id,
				executionId: input.executionId,
				payload: {
					attempt: context.binding.attempt,
					family,
					ownerGeneration: input.generation,
				},
			});
			result = { ok: true, submissionCredential };
		});
		this.save();
		return result;
	}

	/**
	 * Re-issues a lost QA/review ticket only after a committed shell is proven
	 * dead and the durable delivery-repair fence has been claimed. This is
	 * deliberately separate from pre-launch rotation: a plain launch owner can
	 * never mint credentials after commit.
	 */
	rotateGeneralizedWorkflowSubmissionCredentialForDeliveryRepair(input: {
		executionId: string;
		repairOwner: string;
		generation: number;
		repairAttempt: number;
		now: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
	}):
		| { ok: true; submissionCredential: string }
		| { ok: false; reason: string } {
		if (
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.expiresAt) ||
			!StateStore.workflowFiniteTimestamp(input.absoluteDeadlineAt) ||
			Date.parse(input.expiresAt) <= Date.parse(input.now) ||
			Date.parse(input.expiresAt) > Date.parse(input.absoluteDeadlineAt)
		) {
			return { ok: false, reason: "invalid_expiry" };
		}
		const context = this.generalizedExecutionContext(input.executionId);
		if (!context) return { ok: false, reason: "not_enrolled" };
		const family: WorkflowDecisionFamily | undefined =
			context.node.type === "qa"
				? "qa_verdict"
				: context.node.type === "review"
					? "review_verdict"
					: undefined;
		if (!family) return { ok: false, reason: "node_does_not_submit_decision" };
		let result:
			| { ok: true; submissionCredential: string }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "stale_delivery_repair_owner",
		};
		this.db.transaction(() => {
			const owner = this.getWorkflowLaunchOwner(input.executionId);
			if (
				!owner ||
				owner.committed_generation !== input.generation ||
				owner.delivery_state !== "repairing" ||
				owner.delivery_owner !== input.repairOwner ||
				owner.delivery_attempt !== input.repairAttempt ||
				!owner.delivery_lease_expires_at ||
				Date.parse(input.now) >= Date.parse(owner.delivery_lease_expires_at)
			) {
				return;
			}
			const consumed = this.workflowSelectAll(
				`SELECT id FROM workflow_submission_credential
				  WHERE execution_id = ? AND consumed_at IS NOT NULL LIMIT 1`,
				[input.executionId],
			)[0];
			if (consumed) {
				result = { ok: false, reason: "decision_already_consumed" };
				return;
			}
			const rotationUid = `submission_credential_delivery_repair_rotated:${input.executionId}:${input.generation}:${input.repairAttempt}`;
			if (
				this.workflowSelectAll(
					"SELECT 1 AS x FROM workflow_run_event WHERE event_uid = ?",
					[rotationUid],
				)[0]
			) {
				result = { ok: false, reason: "repair_credential_already_rotated" };
				return;
			}
			this.db.run(
				`UPDATE workflow_submission_credential
				    SET revoked = 1, revoked_reason = 'delivery_repair_rotation'
				  WHERE execution_id = ? AND consumed_at IS NULL AND revoked = 0`,
				[input.executionId],
			);
			const submissionCredential = generateCapabilityToken();
			this.db.run(
				`INSERT INTO workflow_submission_credential
				   (credential_hash, run_id, node_id, execution_id, attempt, family,
				    issued_at, expires_at, absolute_deadline_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					hashCapabilityToken(submissionCredential),
					context.binding.run_id,
					context.binding.node_id,
					context.binding.execution_id,
					context.binding.attempt,
					family,
					input.now,
					input.expiresAt,
					input.absoluteDeadlineAt,
				],
			);
			this.appendWorkflowRunEventTx({
				runId: context.binding.run_id,
				eventUid: rotationUid,
				kind: "submission_credential_rotated",
				nodeId: context.binding.node_id,
				executionId: input.executionId,
				payload: {
					attempt: context.binding.attempt,
					family,
					ownerGeneration: input.generation,
					deliveryAttempt: input.repairAttempt,
				},
			});
			result = { ok: true, submissionCredential };
		});
		this.save();
		return result;
	}

	claimWorkflowLaunchDeliveryRepair(input: {
		executionId: string;
		repairOwner: string;
		now: string;
		leaseExpiresAt: string;
	}): WorkflowLaunchDeliveryResult {
		if (
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.leaseExpiresAt) ||
			Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
		) {
			return { status: "hold", reason: "invalid_delivery_lease" };
		}
		let result: WorkflowLaunchDeliveryResult = {
			status: "hold",
			reason: "delivery_owner_unknown",
		};
		this.db.transaction(() => {
			const owner = this.getWorkflowLaunchOwner(input.executionId);
			if (!owner?.committed_generation) {
				result = { status: "hold", reason: "launch_not_committed" };
				return;
			}
			if (
				owner.delivery_state === "repairing" &&
				owner.delivery_owner !== input.repairOwner &&
				owner.delivery_lease_expires_at &&
				Date.parse(input.now) < Date.parse(owner.delivery_lease_expires_at)
			) {
				result = { status: "busy", attempt: owner.delivery_attempt };
				return;
			}
			const attempt =
				owner.delivery_state === "repairing" &&
				owner.delivery_owner === input.repairOwner
					? owner.delivery_attempt
					: owner.delivery_attempt + 1;
			this.db.run(
				`UPDATE workflow_launch_owner
				    SET delivery_attempt = ?, delivery_owner = ?,
				        delivery_lease_expires_at = ?, delivery_state = 'repairing'
				  WHERE execution_id = ? AND committed_generation = owner_generation
				    AND delivery_attempt = ?`,
				[
					attempt,
					input.repairOwner,
					input.leaseExpiresAt,
					input.executionId,
					owner.delivery_attempt,
				],
			);
			if (this.db.getRowsModified() !== 1) {
				result = { status: "busy", attempt: owner.delivery_attempt };
				return;
			}
			result = {
				status: "claimed",
				generation: owner.committed_generation,
				attempt,
				token: StateStore.workflowLaunchToken(
					input.executionId,
					owner.committed_generation,
					attempt,
				),
			};
		});
		this.save();
		return result;
	}

	commitWorkflowLaunchDeliveryRepair(input: {
		executionId: string;
		repairOwner: string;
		generation: number;
		attempt: number;
		markerPath: string;
		now: string;
	}): { ok: true; token: string } | { ok: false; reason: string } {
		const owner = this.getWorkflowLaunchOwner(input.executionId);
		if (
			!owner ||
			owner.committed_generation !== input.generation ||
			owner.delivery_attempt !== input.attempt ||
			owner.delivery_owner !== input.repairOwner ||
			owner.delivery_state !== "repairing" ||
			!owner.delivery_lease_expires_at ||
			Date.parse(input.now) >= Date.parse(owner.delivery_lease_expires_at)
		) {
			return { ok: false, reason: "stale_delivery_owner" };
		}
		const token = StateStore.workflowLaunchToken(
			input.executionId,
			input.generation,
			input.attempt,
		);
		const marker = JSON.stringify({
			executionId: input.executionId,
			generation: input.generation,
			deliveryAttempt: input.attempt,
			token,
		});
		const temp = `${input.markerPath}.${input.repairOwner}.${randomUUID()}.tmp`;
		let committed = false;
		this.db.transaction(() => {
			const current = this.getWorkflowLaunchOwner(input.executionId);
			if (
				!current ||
				current.delivery_owner !== input.repairOwner ||
				current.delivery_attempt !== input.attempt ||
				current.delivery_state !== "repairing"
			) {
				return;
			}
			try {
				mkdirSync(dirname(input.markerPath), { recursive: true });
				writeFileSync(temp, marker, { encoding: "utf8", mode: 0o600 });
				renameSync(temp, input.markerPath);
				if (readFileSync(input.markerPath, "utf8") !== marker) {
					throw new Error("workflow delivery marker readback mismatch");
				}
			} finally {
				rmSync(temp, { force: true });
			}
			this.db.run(
				`UPDATE workflow_launch_owner
				    SET delivery_state = 'delivered', delivery_owner = NULL,
				        delivery_lease_expires_at = NULL
				  WHERE execution_id = ? AND delivery_attempt = ?
				    AND delivery_owner = ? AND delivery_state = 'repairing'`,
				[input.executionId, input.attempt, input.repairOwner],
			);
			committed = this.db.getRowsModified() === 1;
		});
		this.save();
		return committed
			? { ok: true, token }
			: { ok: false, reason: "delivery_fence_lost" };
	}

	/** Atomic marker-first fenced commit. A thrown test seam leaves a repairable marker. */
	fencedCommitWorkflowLaunch(input: {
		executionId: string;
		ownerId: string;
		generation: number;
		deliveryAttempt: number;
		markerPath: string;
		now: string;
		afterMarkerWrite?: () => void;
	}): { ok: true; token: string } | { ok: false; reason: string } {
		if (!StateStore.workflowFiniteTimestamp(input.now)) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		let result: { ok: true; token: string } | { ok: false; reason: string } = {
			ok: false,
			reason: "fence_rejected",
		};
		this.db.transaction(() => {
			const owner = this.getWorkflowLaunchOwner(input.executionId);
			if (
				!owner ||
				owner.owner_id !== input.ownerId ||
				owner.owner_generation !== input.generation ||
				owner.delivery_attempt !== input.deliveryAttempt ||
				Date.parse(input.now) >= Date.parse(owner.lease_expires_at)
			) {
				result = { ok: false, reason: "stale_launch_owner" };
				return;
			}
			const token = StateStore.workflowLaunchToken(
				input.executionId,
				input.generation,
				input.deliveryAttempt,
			);
			const marker = JSON.stringify({
				executionId: input.executionId,
				generation: input.generation,
				deliveryAttempt: input.deliveryAttempt,
				token,
			});
			const temp = `${input.markerPath}.${input.ownerId}.${randomUUID()}.tmp`;
			try {
				mkdirSync(dirname(input.markerPath), { recursive: true });
				writeFileSync(temp, marker, { encoding: "utf8", mode: 0o600 });
				renameSync(temp, input.markerPath);
				if (readFileSync(input.markerPath, "utf8") !== marker) {
					throw new Error("workflow launch marker readback mismatch");
				}
				input.afterMarkerWrite?.();
			} finally {
				rmSync(temp, { force: true });
			}
			this.db.run(
				`UPDATE workflow_launch_owner
				    SET committed_generation = ?, delivery_state = 'delivered'
				  WHERE execution_id = ? AND owner_generation = ?
				    AND owner_id = ? AND committed_generation IS NULL`,
				[input.generation, input.executionId, input.generation, input.ownerId],
			);
			if (this.db.getRowsModified() !== 1) {
				throw new Error("workflow launch commit fence lost");
			}
			result = { ok: true, token };
		});
		this.save();
		return result;
	}

	/**
	 * Fail-closed pre-spawn admission for an enrolled workflow execution. The
	 * typed run enrollment, current QA authority, physical node projection,
	 * immutable execution binding and short-lived submission credential commit
	 * together. A caller must not launch the runner unless this returns `ok`.
	 *
	 * The plaintext credential is returned once for spawn-env delivery. The DB
	 * stores only its SHA-256 hash. This reduces a harvested credential's blast
	 * radius to one execution + TTL; it is not same-user process isolation.
	 */
	admitWorkflowExecution(input: {
		runId: string;
		nodeId: string;
		executionId: string;
		attempt: number;
		family: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
		now?: string;
	}): WorkflowExecutionAdmissionResult {
		const nowIso = input.now ?? new Date().toISOString();
		if (
			!Number.isInteger(input.attempt) ||
			input.attempt <= 0 ||
			!input.runId ||
			!input.nodeId ||
			!input.executionId
		) {
			return { ok: false, reason: "invalid_binding" };
		}
		if (
			!(RUNNER_CAPABILITY_FAMILIES as readonly string[]).includes(input.family)
		) {
			return { ok: false, reason: "invalid_family" };
		}
		if (
			!StateStore.workflowFiniteTimestamp(nowIso) ||
			!StateStore.workflowFiniteTimestamp(input.expiresAt) ||
			!StateStore.workflowFiniteTimestamp(input.absoluteDeadlineAt)
		) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		if (
			Date.parse(input.expiresAt) <= Date.parse(nowIso) ||
			Date.parse(input.expiresAt) > Date.parse(input.absoluteDeadlineAt)
		) {
			return { ok: false, reason: "invalid_expiry" };
		}
		let result: WorkflowExecutionAdmissionResult = {
			ok: false,
			reason: "run_not_found",
		};
		this.db.transaction(() => {
			const run = this.workflowSelectAll(
				"SELECT run_id, status, current_qa_attempt FROM workflow_run WHERE run_id = ?",
				[input.runId],
			)[0];
			if (!run || run.status !== "active") {
				result = { ok: false, reason: "run_not_found" };
				return;
			}
			if (
				input.nodeId === "qa" &&
				run.current_qa_attempt != null &&
				Number(run.current_qa_attempt) > input.attempt
			) {
				result = { ok: false, reason: "stale_attempt" };
				return;
			}
			const node = this.workflowSelectAll(
				"SELECT execution_id FROM workflow_run_node WHERE run_id = ? AND node_id = ? AND attempt = ?",
				[input.runId, input.nodeId, input.attempt],
			)[0];
			if (
				node?.execution_id != null &&
				node.execution_id !== input.executionId
			) {
				result = { ok: false, reason: "attempt_execution_conflict" };
				return;
			}
			const bound = this.workflowSelectAll(
				"SELECT run_id, node_id, attempt FROM workflow_execution_binding WHERE execution_id = ?",
				[input.executionId],
			)[0];
			if (
				bound &&
				(bound.run_id !== input.runId ||
					bound.node_id !== input.nodeId ||
					Number(bound.attempt) !== input.attempt)
			) {
				result = { ok: false, reason: "execution_already_bound" };
				return;
			}
			const live = this.workflowSelectAll(
				`SELECT id FROM workflow_submission_credential
				  WHERE run_id = ? AND node_id = ? AND attempt = ?
				    AND consumed_at IS NULL AND revoked = 0`,
				[input.runId, input.nodeId, input.attempt],
			)[0];
			if (live) {
				result = { ok: false, reason: "credential_already_issued" };
				return;
			}

			if (!node) {
				this.db.run(
					`INSERT INTO workflow_run_node
					   (run_id, node_id, attempt, state, execution_id)
					 VALUES (?, ?, ?, 'admitted', ?)`,
					[input.runId, input.nodeId, input.attempt, input.executionId],
				);
			} else if (node.execution_id == null) {
				this.db.run(
					`UPDATE workflow_run_node SET execution_id = ?, state = 'admitted'
					  WHERE run_id = ? AND node_id = ? AND attempt = ?`,
					[input.executionId, input.runId, input.nodeId, input.attempt],
				);
			}
			if (!bound) {
				this.db.run(
					`INSERT INTO workflow_execution_binding
					   (execution_id, run_id, node_id, attempt, bound_at)
					 VALUES (?, ?, ?, ?, ?)`,
					[input.executionId, input.runId, input.nodeId, input.attempt, nowIso],
				);
			}
			this.db.run(
				`UPDATE workflow_run
				    SET claims_read_enrolled = 1,
				        current_qa_attempt = CASE WHEN ? = 'qa' THEN ? ELSE current_qa_attempt END
				  WHERE run_id = ?`,
				[input.nodeId, input.attempt, input.runId],
			);
			// A new logical attempt invalidates every older unspent credential.
			this.db.run(
				`UPDATE workflow_submission_credential
				    SET revoked = 1, revoked_reason = ?
				  WHERE run_id = ? AND node_id = ? AND attempt < ?
				    AND consumed_at IS NULL AND revoked = 0`,
				[
					`superseded_by_attempt_${input.attempt}`,
					input.runId,
					input.nodeId,
					input.attempt,
				],
			);
			const credential = generateCapabilityToken();
			const credentialHash = hashCapabilityToken(credential);
			this.db.run(
				`INSERT INTO workflow_submission_credential
				   (credential_hash, run_id, node_id, execution_id, attempt, family,
				    issued_at, expires_at, absolute_deadline_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					credentialHash,
					input.runId,
					input.nodeId,
					input.executionId,
					input.attempt,
					input.family,
					nowIso,
					input.expiresAt,
					input.absoluteDeadlineAt,
				],
			);
			const credentialRow = this.workflowSelectAll(
				"SELECT id FROM workflow_submission_credential WHERE credential_hash = ?",
				[credentialHash],
			)[0];
			this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: `execution_admitted:${input.executionId}`,
				kind: "execution_admitted",
				nodeId: input.nodeId,
				executionId: input.executionId,
				payload: { attempt: input.attempt, family: input.family },
			});
			result = {
				ok: true,
				credentialId: Number(credentialRow?.id),
				credential,
			};
		});
		this.save();
		return result;
	}

	getWorkflowExecutionBinding(
		executionId: string,
	): WorkflowExecutionBindingRow | undefined {
		const row = this.workflowSelectAll(
			"SELECT * FROM workflow_execution_binding WHERE execution_id = ?",
			[executionId],
		)[0];
		if (!row) return undefined;
		return {
			execution_id: row.execution_id as string,
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			bound_at: row.bound_at as string,
		};
	}

	isWorkflowEngineOwnedExecution(executionId: string): boolean {
		const binding = this.getWorkflowExecutionBinding(executionId);
		if (!binding) return false;
		return this.getWorkflowRun(binding.run_id)?.engine_owned === 1;
	}

	private generalizedExecutionContext(executionId: string):
		| {
				binding: WorkflowExecutionBindingRow;
				run: WorkflowRunRow;
				snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
				node: ReturnType<
					typeof parseWorkflowRunSnapshot
				>["resolved"]["nodes"][number];
		  }
		| undefined {
		const binding = this.getWorkflowExecutionBinding(executionId);
		if (!binding) return undefined;
		const run = this.getWorkflowRun(binding.run_id);
		// Legacy shadow/auto-QA bindings intentionally have no typed snapshot.
		// A binding row alone is not typed engine enrollment.
		if (!run?.snapshot) {
			if (run?.selection_source) {
				throw new Error(
					"generalized workflow execution has no pinned snapshot",
				);
			}
			return undefined;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(run.snapshot);
		} catch {
			throw new Error("bound workflow snapshot is corrupt");
		}
		const schemaVersion =
			typeof raw === "object" && raw !== null
				? (raw as { schema_version?: unknown }).schema_version
				: undefined;
		if (
			schemaVersion !== 2 &&
			!(schemaVersion === 1 && run.engine_owned === 1)
		) {
			return undefined;
		}
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		const node = snapshot.resolved.nodes.find(
			(candidate) => candidate.id === binding.node_id,
		);
		if (!node) throw new Error("bound workflow node is absent from snapshot");
		return { binding, run, snapshot, node };
	}

	/** One fail-closed admission seam for typed engine and generalized executions. */
	admitGeneralizedWorkflowExecution(input: {
		runId: string;
		nodeId: string;
		executionId: string;
		attempt: number;
		expiresAt: string;
		absoluteDeadlineAt: string;
		now?: string;
		env?: Record<string, string | undefined>;
		idempotencyKey?: string;
		dispatchResolution?: {
			dispatch: {
				vendor: "claude" | "codex";
				model: string;
				effort?: "low" | "medium" | "high" | "xhigh";
			};
			source:
				| "current_config"
				| "live_template"
				| "snapshot_fallback"
				| "approved_design_fallback";
			audit: boolean;
		};
	}): GeneralizedWorkflowAdmissionResult {
		const env = input.env ?? process.env;
		const now = input.now ?? new Date().toISOString();
		if (
			!StateStore.workflowFiniteTimestamp(now) ||
			!StateStore.workflowFiniteTimestamp(input.expiresAt) ||
			!StateStore.workflowFiniteTimestamp(input.absoluteDeadlineAt) ||
			Date.parse(input.expiresAt) <= Date.parse(now) ||
			Date.parse(input.expiresAt) > Date.parse(input.absoluteDeadlineAt)
		) {
			return { ok: false, reason: "invalid_expiry" };
		}
		const run = this.getWorkflowRun(input.runId);
		if (!run?.snapshot || run.status !== "active") {
			return { ok: false, reason: "run_not_found" };
		}
		let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
		try {
			snapshot = parseWorkflowRunSnapshot(run.snapshot);
		} catch {
			return { ok: false, reason: "invalid_snapshot" };
		}
		const blocked = workflowTemplateDispatchBlockReason(
			snapshot.schema_version,
			env,
		);
		if (blocked) return { ok: false, reason: blocked };
		if (snapshot.schema_version === 1 && run.engine_owned !== 1) {
			return { ok: false, reason: "engine_ownership_required" };
		}
		const node = snapshot.resolved.nodes.find(
			(candidate) => candidate.id === input.nodeId,
		);
		if (!node) return { ok: false, reason: "unknown_node" };
		if (!node.dispatch || node.type === "gate") {
			return { ok: false, reason: "not_start_node" };
		}
		const resolvedDispatch =
			input.dispatchResolution?.dispatch ?? node.dispatch;
		if (
			node.capabilities.qa_verdict_emitter &&
			node.capabilities.produces_output
		) {
			return { ok: false, reason: "unsupported_capability_combination" };
		}
		if (node.type === "qa" || node.type === "review") {
			const producerIds = snapshot.manifest.edges
				.filter((edge) => edge.to === node.id)
				.map((edge) => edge.from);
			const producers = snapshot.resolved.nodes.filter((candidate) =>
				producerIds.includes(candidate.id),
			);
			if (producers.length !== 1 || !producers[0]?.dispatch) {
				return { ok: false, reason: "decision_producer_ambiguous" };
			}
			if (
				node.type === "review" &&
				!producers[0].capabilities.produces_output
			) {
				return { ok: false, reason: "review_output_producer_required" };
			}
			const producerAttempt = this.listWorkflowRunNodes(
				input.runId,
				producers[0].id,
			)
				.filter((candidate) => candidate.execution_id)
				.sort((left, right) => right.attempt - left.attempt)[0];
			const producerRuntime = producerAttempt?.execution_id
				? this.getWorkflowExecutionRuntime(producerAttempt.execution_id)
				: undefined;
			const producerVendor =
				producerRuntime?.vendor ?? producers[0].dispatch.vendor;
			if (producerVendor === resolvedDispatch.vendor) {
				return { ok: false, reason: "same_vendor_review" };
			}
		}

		const existingBinding = this.getWorkflowExecutionBinding(input.executionId);
		if (existingBinding) {
			if (
				existingBinding.run_id !== input.runId ||
				existingBinding.node_id !== input.nodeId ||
				existingBinding.attempt !== input.attempt ||
				!this.getWorkflowExecutionRuntime(input.executionId)
			) {
				return { ok: false, reason: "execution_already_bound" };
			}
			return {
				ok: true,
				idempotentReplay: true,
				outputCredential: undefined,
				snapshotDigest: snapshot.snapshot_digest,
			};
		}

		const incoming = new Map(
			snapshot.manifest.nodes.map((entry) => [entry.id, 0]),
		);
		for (const edge of snapshot.manifest.edges) {
			incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
		}
		const starts = snapshot.manifest.nodes.filter(
			(entry) => incoming.get(entry.id) === 0,
		);
		const attempts = this.listWorkflowRunNodes(input.runId, input.nodeId);
		const reservedSuccessor = attempts.find(
			(candidate) =>
				candidate.attempt === input.attempt &&
				candidate.execution_id === input.executionId &&
				(candidate.state === "pending" || candidate.state === "running"),
		);
		if (run.engine_owned === 1 && attempts.length > 0 && !reservedSuccessor) {
			return { ok: false, reason: "successor_not_reserved" };
		}
		if (!reservedSuccessor && attempts.length === 0) {
			if (
				starts.length !== 1 ||
				starts[0]!.id !== input.nodeId ||
				input.attempt !== 1
			) {
				return { ok: false, reason: "not_start_node" };
			}
		} else if (!reservedSuccessor) {
			const maxAttempt = Math.max(...attempts.map((entry) => entry.attempt));
			if (input.attempt !== maxAttempt + 1) {
				return { ok: false, reason: "invalid_retry_attempt" };
			}
		}

		let outputCredential: string | undefined;
		let submissionCredential: string | undefined;
		this.db.transaction(() => {
			if (reservedSuccessor) {
				this.db.run(
					`UPDATE workflow_run_node SET state = 'admitted'
					  WHERE run_id = ? AND node_id = ? AND attempt = ?
					    AND execution_id = ? AND state IN ('pending', 'running')`,
					[input.runId, input.nodeId, input.attempt, input.executionId],
				);
			} else {
				this.db.run(
					`INSERT INTO workflow_run_node
					   (run_id, node_id, attempt, state, execution_id)
					 VALUES (?, ?, ?, 'admitted', ?)`,
					[input.runId, input.nodeId, input.attempt, input.executionId],
				);
			}
			this.db.run(
				`INSERT INTO workflow_execution_binding
				   (execution_id, run_id, node_id, attempt, bound_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[input.executionId, input.runId, input.nodeId, input.attempt, now],
			);
			this.db.run(
				`INSERT INTO workflow_execution_runtime
				   (execution_id, run_id, node_id, attempt, vendor, model, effort,
				    resolved_family, capabilities_digest, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					input.executionId,
					input.runId,
					input.nodeId,
					input.attempt,
					resolvedDispatch.vendor,
					resolvedDispatch.model,
					resolvedDispatch.effort ?? "",
					resolvedDispatch.vendor,
					canonicalSubmissionDigest(node.capabilities),
					now,
				],
			);
			if (input.dispatchResolution?.audit) {
				this.appendWorkflowRunEventCheckedTx({
					runId: input.runId,
					eventUid: `vendor_resolved:${input.runId}:${input.nodeId}:${input.attempt}:${input.executionId}`,
					kind: "dispatch_vendor_resolved",
					nodeId: input.nodeId,
					executionId: input.executionId,
					payload: {
						attempt: input.attempt,
						dispatch: resolvedDispatch,
						source: input.dispatchResolution.source,
					},
				});
			}
			if (node.capabilities.produces_output) {
				this.db.run(
					`UPDATE workflow_output_credential
					    SET revoked = 1, revoked_reason = 'superseded_by_retry'
					  WHERE run_id = ? AND node_id = ? AND attempt < ?
					    AND consumed_at IS NULL AND revoked = 0`,
					[input.runId, input.nodeId, input.attempt],
				);
				outputCredential = generateCapabilityToken();
				this.db.run(
					`INSERT INTO workflow_output_credential
					   (credential_hash, run_id, node_id, execution_id, attempt,
					    issued_at, expires_at, absolute_deadline_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						hashCapabilityToken(outputCredential),
						input.runId,
						input.nodeId,
						input.executionId,
						input.attempt,
						now,
						input.expiresAt,
						input.absoluteDeadlineAt,
					],
				);
			}
			const decisionFamily: WorkflowDecisionFamily | undefined =
				node.type === "qa"
					? "qa_verdict"
					: node.type === "review"
						? "review_verdict"
						: undefined;
			if (decisionFamily) {
				this.db.run(
					`UPDATE workflow_submission_credential
					    SET revoked = 1, revoked_reason = 'superseded_by_retry'
					  WHERE run_id = ? AND node_id = ? AND attempt < ?
					    AND consumed_at IS NULL AND revoked = 0`,
					[input.runId, input.nodeId, input.attempt],
				);
				submissionCredential = generateCapabilityToken();
				this.db.run(
					`INSERT INTO workflow_submission_credential
					   (credential_hash, run_id, node_id, execution_id, attempt, family,
					    issued_at, expires_at, absolute_deadline_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						hashCapabilityToken(submissionCredential),
						input.runId,
						input.nodeId,
						input.executionId,
						input.attempt,
						decisionFamily,
						now,
						input.expiresAt,
						input.absoluteDeadlineAt,
					],
				);
			}
			this.db.run(
				`UPDATE workflow_run
				    SET claims_read_enrolled = 1,
				        current_node_id = ?,
				        current_qa_attempt = CASE WHEN ? = 'qa' THEN ? ELSE current_qa_attempt END
				  WHERE run_id = ?`,
				[input.nodeId, input.nodeId, input.attempt, input.runId],
			);
			this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: `generalized_execution_admitted:${input.executionId}`,
				kind: "execution_admitted",
				nodeId: input.nodeId,
				executionId: input.executionId,
				payload: {
					attempt: input.attempt,
					output: !!outputCredential,
					decision: !!submissionCredential,
				},
			});
			if (input.idempotencyKey) {
				this.db.run(
					`UPDATE workflow_start_stage SET stage = 'admitted', updated_at = ?
					  WHERE idempotency_key = ? AND stage = 'materialized'`,
					[now, input.idempotencyKey],
				);
			}
		});
		this.save();
		return {
			ok: true,
			idempotentReplay: false,
			outputCredential,
			submissionCredential,
			snapshotDigest: snapshot.snapshot_digest,
		};
	}

	getWorkflowExecutionRuntime(
		executionId: string,
	): WorkflowExecutionRuntimeRow | undefined {
		const row = this.workflowSelectAll(
			"SELECT * FROM workflow_execution_runtime WHERE execution_id = ?",
			[executionId],
		)[0];
		if (!row) return undefined;
		return {
			execution_id: row.execution_id as string,
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			vendor: row.vendor as string,
			model: row.model as string,
			effort: (row.effort as string) ?? null,
			resolved_family: row.resolved_family as string,
			capabilities_digest: row.capabilities_digest as string,
			created_at: row.created_at as string,
		};
	}

	getWorkflowNodeCompletion(
		runId: string,
		nodeId: string,
		attempt: number,
	): WorkflowNodeCompletionRow | undefined {
		const row = this.workflowSelectAll(
			`SELECT * FROM workflow_node_completion
			  WHERE run_id = ? AND node_id = ? AND attempt = ?`,
			[runId, nodeId, attempt],
		)[0];
		if (!row) return undefined;
		return {
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			execution_id: row.execution_id as string,
			route: row.route as string,
			event_uid: row.event_uid as string,
			source_event_id: row.source_event_id as string,
			completion_submission_digest: row.completion_submission_digest as string,
			completed_at: row.completed_at as string,
		};
	}

	getWorkflowNodeOutput(outputId: number): WorkflowNodeOutputRow | undefined {
		if (!Number.isInteger(outputId) || outputId <= 0) return undefined;
		const row = this.workflowSelectAll(
			"SELECT * FROM workflow_node_outputs WHERE id = ?",
			[outputId],
		)[0];
		if (!row) return undefined;
		return {
			id: Number(row.id),
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			execution_id: row.execution_id as string,
			payload: row.payload as string,
			output_digest: row.output_digest as string,
			output_schema: row.output_schema as string,
			byte_size: Number(row.byte_size),
			written_at: row.written_at as string,
		};
	}

	/** Typed reverse lookup; legacy non-engine v1 bindings return undefined. */
	getGeneralizedWorkflowNodeForExecution(executionId: string) {
		const context = this.generalizedExecutionContext(executionId);
		if (!context) return undefined;
		return {
			binding: context.binding,
			run: context.run,
			node: context.node,
			snapshot: context.snapshot,
			snapshotDigest: context.snapshot.snapshot_digest,
		};
	}

	/** Enrolled-only active query. Legacy phase SQL remains untouched. */
	listActiveGeneralizedWorkflowExecutions(issueId: string): Array<{
		executionId: string;
		runId: string;
		nodeId: string;
		attempt: number;
	}> {
		const rows = this.workflowSelectAll(
			`SELECT b.execution_id
			   FROM workflow_execution_binding b
			   JOIN workflow_run r ON r.run_id = b.run_id
			   JOIN workflow_run_node n
			     ON n.run_id = b.run_id AND n.node_id = b.node_id AND n.attempt = b.attempt
			  WHERE r.issue_id = ? AND r.status = 'active' AND n.state <> 'done'
			  ORDER BY b.bound_at, b.execution_id`,
			[issueId],
		);
		return rows.flatMap((row) => {
			const context = this.generalizedExecutionContext(
				row.execution_id as string,
			);
			if (!context) return [];
			return [
				{
					executionId: context.binding.execution_id,
					runId: context.binding.run_id,
					nodeId: context.binding.node_id,
					attempt: context.binding.attempt,
				},
			];
		});
	}

	/** Snapshot-topology reverse order for TURN/closeout recovery. */
	listGeneralizedExecutionsReverseTopology(runId: string): Array<{
		executionId: string;
		nodeId: string;
		attempt: number;
	}> {
		const run = this.getWorkflowRun(runId);
		if (!run?.snapshot) throw new Error("workflow run snapshot missing");
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		const indegree = new Map(
			snapshot.manifest.nodes.map((node) => [node.id, 0]),
		);
		const outgoing = new Map(
			snapshot.manifest.nodes.map((node) => [node.id, [] as string[]]),
		);
		for (const edge of snapshot.manifest.edges) {
			indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
			outgoing.get(edge.from)?.push(edge.to);
		}
		const queue = snapshot.manifest.nodes
			.filter((node) => indegree.get(node.id) === 0)
			.map((node) => node.id);
		const order: string[] = [];
		while (queue.length > 0) {
			const current = queue.shift()!;
			order.push(current);
			for (const next of outgoing.get(current) ?? []) {
				const remaining = (indegree.get(next) ?? 0) - 1;
				indegree.set(next, remaining);
				if (remaining === 0) queue.push(next);
			}
		}
		if (order.length !== snapshot.manifest.nodes.length) {
			throw new Error("workflow snapshot topology is cyclic");
		}
		const rank = new Map(order.map((nodeId, index) => [nodeId, index]));
		return this.workflowSelectAll(
			`SELECT execution_id, node_id, attempt
			   FROM workflow_execution_binding WHERE run_id = ?`,
			[runId],
		)
			.map((row) => ({
				executionId: row.execution_id as string,
				nodeId: row.node_id as string,
				attempt: Number(row.attempt),
			}))
			.sort(
				(a, b) =>
					(rank.get(b.nodeId) ?? -1) - (rank.get(a.nodeId) ?? -1) ||
					b.attempt - a.attempt,
			);
	}

	/**
	 * Persist the terminal signal for an enrolled execution without invoking
	 * any legacy completion hooks. The lifecycle event, fixed terminal session
	 * projection, and teardown fact share one SQLite commit.
	 */
	recordEnrolledTerminalSignal(input: {
		executionId: string;
		sourceEventId: string;
		signal: "completed" | "failed";
		failureKind?: string;
		lastError?: string;
		source: string;
		now?: string;
	}):
		| {
				ok: true;
				idempotentReplay: boolean;
				status: "completed" | "failed" | "blocked";
				runId: string;
				nodeId: string;
		  }
		| { ok: false; reason: string } {
		const now = input.now ?? new Date().toISOString();
		if (
			!input.executionId ||
			!input.sourceEventId ||
			!input.source ||
			!StateStore.workflowFiniteTimestamp(now)
		) {
			return { ok: false, reason: "invalid_terminal_signal" };
		}
		const context = this.generalizedExecutionContext(input.executionId);
		if (!context) return { ok: false, reason: "not_enrolled" };
		const status: "completed" | "failed" | "blocked" =
			input.signal === "completed"
				? "completed"
				: input.failureKind === "goal_blocked"
					? "blocked"
					: "failed";
		const eventType =
			input.signal === "completed" ? "session_completed" : "session_failed";
		let idempotentReplay = false;
		let refusal: string | undefined;
		this.db.transaction(() => {
			const priorEvent = this.workflowSelectAll(
				"SELECT * FROM session_events WHERE event_id = ?",
				[input.sourceEventId],
			)[0];
			if (priorEvent) {
				let priorPayload: Record<string, unknown> | undefined;
				try {
					priorPayload = JSON.parse(
						String(priorEvent.payload ?? "null"),
					) as Record<string, unknown>;
				} catch {
					priorPayload = undefined;
				}
				if (
					priorEvent.execution_id !== input.executionId ||
					priorEvent.event_type !== eventType ||
					priorEvent.source !== input.source ||
					!priorPayload ||
					(priorPayload.failureKind ?? null) !== (input.failureKind ?? null) ||
					(priorPayload.lastError ?? null) !== (input.lastError ?? null)
				) {
					refusal = "terminal_signal_conflict";
					return;
				}
				idempotentReplay = true;
				return;
			} else {
				this.db.run(
					`INSERT INTO session_events
					   (event_id, execution_id, issue_id, project_name, event_type, severity, payload, source)
					 VALUES (?, ?, ?, ?, ?, 'info', ?, ?)`,
					[
						input.sourceEventId,
						input.executionId,
						context.run.issue_id,
						context.run.project_name,
						eventType,
						JSON.stringify({
							failureKind: input.failureKind ?? null,
							lastError: input.lastError ?? null,
						}),
						input.source,
					],
				);
			}

			const previousStatus = this.getSession(input.executionId)?.status;
			this.db.run(
				`INSERT INTO sessions
				   (execution_id, issue_id, project_name, status, last_activity_at,
				    last_error, chat_thread_role, workflow_node_id)
				 VALUES (?, ?, ?, ?, ?, ?, 'main', ?)
				 ON CONFLICT(execution_id) DO UPDATE SET
				   status = excluded.status,
				   last_activity_at = excluded.last_activity_at,
				   last_error = COALESCE(excluded.last_error, sessions.last_error),
				   workflow_node_id = CASE
				     WHEN sessions.workflow_node_id IS NULL THEN excluded.workflow_node_id
				     ELSE sessions.workflow_node_id END`,
				[
					input.executionId,
					context.run.issue_id,
					context.run.project_name,
					status,
					now,
					input.lastError ?? null,
					context.binding.node_id,
				],
			);
			this.applyTerminalTimestamp(input.executionId, previousStatus, status);
			if (previousStatus && previousStatus !== status) {
				this.bumpLifecycleRevision(input.executionId);
			}
			this.appendWorkflowRunEventCheckedTx({
				runId: context.binding.run_id,
				eventUid: `teardown_recorded:${context.binding.run_id}:${input.executionId}:${input.sourceEventId}`,
				kind: "generalized_teardown_recorded",
				nodeId: context.binding.node_id,
				executionId: input.executionId,
				payload: {
					sourceEventId: input.sourceEventId,
					signal: input.signal,
					status,
					failureKind: input.failureKind ?? null,
					at: now,
				},
			});
		});
		if (refusal) return { ok: false, reason: refusal };
		this.save();
		return {
			ok: true,
			idempotentReplay,
			status,
			runId: context.binding.run_id,
			nodeId: context.binding.node_id,
		};
	}

	hasWorkflowExecutionTeardownFact(
		runId: string,
		nodeId: string,
		executionId: string,
	): boolean {
		return (
			this.workflowSelectAll(
				`SELECT 1 AS present FROM workflow_run_event
				  WHERE run_id = ? AND node_id = ? AND execution_id = ?
				    AND kind = 'generalized_teardown_recorded' LIMIT 1`,
				[runId, nodeId, executionId],
			).length > 0
		);
	}

	listRunAttributedExecutions(runId: string): string[] {
		return this.workflowSelectAll(
			`SELECT execution_id FROM (
			   SELECT execution_id FROM workflow_run_node
			    WHERE run_id = ? AND execution_id IS NOT NULL
			   UNION
			   SELECT execution_id FROM workflow_side_effect_ledger
			    WHERE run_id = ?
			   UNION
			   SELECT execution_id FROM workflow_execution_binding
			    WHERE run_id = ?
			 ) ORDER BY execution_id`,
			[runId, runId, runId],
		).map((row) => row.execution_id as string);
	}

	private validateRunQuiescenceEvidenceTx(
		runId: string,
		evidence: RunQuiescenceEvidence[],
		now: string,
	): { ok: true } | { ok: false; executionIds: string[] } {
		const attributed = this.listRunAttributedExecutions(runId);
		const byExecution = new Map(
			evidence.map((item) => [item.executionId, item]),
		);
		const live = new Set<string>();
		for (const executionId of attributed) {
			const observed = byExecution.get(executionId);
			const observedMs = observed ? Date.parse(observed.observedAt) : NaN;
			const ageMs = Date.parse(now) - observedMs;
			if (
				!observed ||
				!Number.isFinite(observedMs) ||
				ageMs < 0 ||
				ageMs > 30_000
			) {
				live.add(executionId);
				continue;
			}
			const session = this.getSession(executionId);
			if (!session) {
				if (
					observed.sessionStatus !== null ||
					observed.lifecycleRevision !== null ||
					observed.liveness !== "dead"
				) {
					live.add(executionId);
				}
				continue;
			}
			if (
				observed.sessionStatus !== session.status ||
				observed.lifecycleRevision !== session.lifecycle_revision ||
				!isStateStoreIrreversibleTerminalForZombie(session.status)
			) {
				live.add(executionId);
				continue;
			}
			let trustedZombie = false;
			if (observed.trustedZombieEventUid) {
				const marker = this.workflowSelectAll(
					"SELECT payload FROM lead_events WHERE event_id = ? LIMIT 1",
					[observed.trustedZombieEventUid],
				)[0];
				try {
					const payload = marker?.payload
						? (JSON.parse(marker.payload as string) as Record<string, unknown>)
						: undefined;
					trustedZombie =
						observed.trustedZombieEventUid === `zombie-${executionId}` &&
						(payload?.executionId === executionId ||
							payload?.execution_id === executionId);
				} catch {
					trustedZombie = false;
				}
			}
			if (observed.liveness !== "dead" && !trustedZombie) {
				live.add(executionId);
			}
		}
		for (const executionId of byExecution.keys()) {
			if (!attributed.includes(executionId)) live.add(executionId);
		}
		return live.size === 0
			? { ok: true }
			: { ok: false, executionIds: [...live].sort() };
	}

	private changeWorkflowRunStateByOperator(input: {
		runId: string;
		reason: string;
		clientRequestId: string;
		principal: string;
		evidence: RunQuiescenceEvidence[];
		now: string;
		target: "held" | "terminated";
	}): WorkflowRunOperatorResult {
		if (
			!input.runId ||
			!input.reason ||
			input.reason.length > 500 ||
			!input.clientRequestId ||
			!input.principal ||
			!StateStore.workflowFiniteTimestamp(input.now)
		) {
			return { ok: false, reason: "invalid_operator_request" };
		}
		let result: WorkflowRunOperatorResult = {
			ok: false,
			reason: "operator_change_not_committed",
		};
		this.db.transaction(() => {
			const eventUid = `run_${input.target === "held" ? "held_by_operator" : "terminated"}:${input.runId}:${input.clientRequestId}`;
			const prior = this.workflowSelectAll(
				"SELECT kind, payload FROM workflow_run_event WHERE event_uid = ?",
				[eventUid],
			)[0];
			if (prior) {
				try {
					const payload = JSON.parse(prior.payload as string) as Record<
						string,
						unknown
					>;
					if (
						payload.reason !== input.reason ||
						payload.principal !== input.principal ||
						payload.status !== input.target
					) {
						result = { ok: false, reason: "operator_request_conflict" };
						return;
					}
					result = {
						ok: true,
						status: input.target,
						idempotentReplay: true,
					};
					return;
				} catch {
					result = { ok: false, reason: "operator_request_conflict" };
					return;
				}
			}
			const run = this.getWorkflowRun(input.runId);
			const allowed =
				input.target === "held"
					? run?.status === "active"
					: run?.status === "active" || run?.status === "held";
			if (!run || !allowed) {
				result = { ok: false, reason: "run_not_manageable" };
				return;
			}
			const quiescence = this.validateRunQuiescenceEvidenceTx(
				input.runId,
				input.evidence,
				input.now,
			);
			if (!quiescence.ok) {
				result = {
					ok: false,
					reason: "run_has_live_executions",
					executionIds: quiescence.executionIds,
				};
				return;
			}
			this.db.run(
				"UPDATE workflow_run SET status = ? WHERE run_id = ? AND status = ?",
				[input.target, input.runId, run.status],
			);
			if (this.db.getRowsModified() !== 1) {
				result = { ok: false, reason: "run_state_changed" };
				return;
			}
			this.appendWorkflowRunEventCheckedTx({
				runId: input.runId,
				eventUid,
				kind:
					input.target === "held"
						? "run_held_by_operator"
						: "run_terminated_by_operator",
				payload: {
					reason: input.reason,
					principal: input.principal,
					status: input.target,
					at: input.now,
				},
			});
			result = {
				ok: true,
				status: input.target,
				idempotentReplay: false,
			};
		});
		if (result.ok) this.save();
		return result;
	}

	holdWorkflowRunByOperator(
		input: Omit<
			Parameters<StateStore["changeWorkflowRunStateByOperator"]>[0],
			"target"
		>,
	): WorkflowRunOperatorResult {
		return this.changeWorkflowRunStateByOperator({ ...input, target: "held" });
	}

	terminateWorkflowRunByOperator(
		input: Omit<
			Parameters<StateStore["changeWorkflowRunStateByOperator"]>[0],
			"target"
		>,
	): WorkflowRunOperatorResult {
		return this.changeWorkflowRunStateByOperator({
			...input,
			target: "terminated",
		});
	}

	private enqueueWorkflowEngineAlertTx(input: {
		escalationUid: string;
		runId: string;
		payload: WorkflowEngineAlertPayload;
		now: string;
	}): void {
		const payloadJson = JSON.stringify(input.payload);
		const existing = this.workflowSelectAll(
			"SELECT run_id, payload_json FROM workflow_alert_outbox WHERE escalation_uid = ?",
			[input.escalationUid],
		)[0];
		if (existing) {
			if (
				existing.run_id !== input.runId ||
				existing.payload_json !== payloadJson
			) {
				throw new Error(`workflow_alert_uid_conflict:${input.escalationUid}`);
			}
			return;
		}
		this.db.run(
			`INSERT INTO workflow_alert_outbox
			   (escalation_uid, run_id, payload_json, state, attempt, generation,
			    created_at, updated_at)
			 VALUES (?, ?, ?, 'pending', 0, 0, ?, ?)`,
			[input.escalationUid, input.runId, payloadJson, input.now, input.now],
		);
	}

	enqueueWorkflowEngineAlert(input: {
		escalationUid: string;
		runId: string;
		payload: WorkflowEngineAlertPayload;
		now?: string;
	}): void {
		const now = input.now ?? new Date().toISOString();
		this.db.transaction(() => {
			this.enqueueWorkflowEngineAlertTx({ ...input, now });
			this.appendWorkflowRunEventCheckedTx({
				runId: input.runId,
				eventUid: `alert_enqueued:${input.escalationUid}`,
				kind: "workflow_engine_alert_enqueued",
				payload: { escalationUid: input.escalationUid },
			});
		});
		this.save();
	}

	private workflowEngineAlertPayload(input: {
		escalationUid: string;
		runId: string;
		issueId: string;
		nodeId: string;
		executionId: string;
		reason: string;
		disposition: "held" | "partial" | "design_fallback";
		identity: WorkflowEngineAlertIdentity;
	}): WorkflowEngineAlertPayload {
		const fallback = input.disposition === "design_fallback";
		const partial = input.disposition === "partial";
		return {
			leadId: input.identity.leadId,
			projectName: input.identity.projectName,
			eventId: input.escalationUid,
			eventType: "workflow_engine_escalation",
			severity: "severe",
			sessionKey: `wf:${input.runId}`,
			title: fallback
				? `Workflow design fallback used for ${input.issueId}`
				: partial
					? `Workflow land cleanup needs attention for ${input.issueId}`
					: `Workflow run held for ${input.issueId}`,
			body: fallback
				? `Run ${input.runId} node ${input.nodeId}: Fable was unavailable; the one approved fallback to GPT-5.6 was selected. Reason: ${input.reason}.`
				: partial
					? `Run ${input.runId} land node ${input.nodeId} could not finish cleanup after merge. Reason: ${input.reason}. The durable operation will keep retrying; inspect GET /api/lifecycle/land/<operation-id>.`
					: `Run ${input.runId} node ${input.nodeId} was held after execution ${input.executionId}. Reason: ${input.reason}. Recover with POST /api/runs/${input.runId}/hold or /terminate after proving quiescence.`,
			metadata: {
				workflowEngine: {
					runId: input.runId,
					issueId: input.issueId,
					nodeId: input.nodeId,
					executionId: input.executionId,
					disposition: input.disposition,
					leadResolution: input.identity.leadResolution,
				},
			},
		};
	}

	private workflowDeadExecutionAlertPayload(input: {
		escalationUid: string;
		eventType: "workflow_engine_escalation" | "workflow_engine_issue_alert";
		runId: string;
		issueId: string;
		nodeId: string;
		executionId: string;
		disposition:
			| "dead_execution_activity_after_replacement"
			| "repeated_dead_execution_pattern";
		body: string;
		identity: WorkflowEngineAlertIdentity;
	}): WorkflowEngineAlertPayload {
		const falsePositive =
			input.disposition === "dead_execution_activity_after_replacement";
		return {
			leadId: input.identity.leadId,
			projectName: input.identity.projectName,
			eventId: input.escalationUid,
			eventType: input.eventType,
			severity: "severe",
			sessionKey: `wf:${input.runId}`,
			title: falsePositive
				? `FALSE-POSITIVE dead execution detected for ${input.issueId}`
				: `Repeated dead executions detected for ${input.issueId}`,
			body: input.body,
			metadata: {
				workflowEngine: {
					runId: input.runId,
					issueId: input.issueId,
					nodeId: input.nodeId,
					executionId: input.executionId,
					disposition: input.disposition,
					leadResolution: input.identity.leadResolution,
				},
			},
		};
	}

	private workflowDeadExecutionWatchRow(
		row: Record<string, unknown>,
	): WorkflowDeadExecutionWatchRow {
		return {
			dead_execution_id: row.dead_execution_id as string,
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			new_execution_id: row.new_execution_id as string,
			project_name: row.project_name as string,
			issue_id: row.issue_id as string,
			observed_at: row.observed_at as string,
			baseline: JSON.parse(
				row.baseline_json as string,
			) as WorkflowDeadExecutionActivityBaseline,
			state: row.state as "active" | "tripped",
			tripped_at: (row.tripped_at as string) ?? null,
			evidence: row.evidence_json
				? (JSON.parse(
						row.evidence_json as string,
					) as WorkflowDeadExecutionActivityEvidence)
				: null,
		};
	}

	getWorkflowDeadExecutionWatch(
		deadExecutionId: string,
	): WorkflowDeadExecutionWatchRow | undefined {
		const row = this.workflowSelectAll(
			"SELECT * FROM workflow_dead_execution_watch WHERE dead_execution_id = ?",
			[deadExecutionId],
		)[0];
		return row ? this.workflowDeadExecutionWatchRow(row) : undefined;
	}

	listActiveWorkflowDeadExecutionWatches(
		limit = 200,
		after?: { observedAt: string; deadExecutionId: string },
	): WorkflowDeadExecutionWatchRow[] {
		const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
		const afterClause = after
			? "AND (observed_at > ? OR (observed_at = ? AND dead_execution_id > ?))"
			: "";
		return this.workflowSelectAll(
			`SELECT * FROM workflow_dead_execution_watch
			  WHERE state = 'active' ${afterClause}
			  ORDER BY observed_at, dead_execution_id LIMIT ?`,
			after
				? [after.observedAt, after.observedAt, after.deadExecutionId, bounded]
				: [bounded],
		).map((row) => this.workflowDeadExecutionWatchRow(row));
	}

	pruneWorkflowDeadExecutionWatches(input: {
		now: string;
		ttlMs: number;
		limit?: number;
	}): number {
		const nowMs = Date.parse(input.now);
		if (
			!Number.isFinite(nowMs) ||
			!Number.isFinite(input.ttlMs) ||
			input.ttlMs <= 0
		) {
			throw new Error("invalid_dead_execution_watch_ttl");
		}
		const bounded = Math.max(1, Math.min(200, Math.floor(input.limit ?? 200)));
		const cutoff = new Date(nowMs - input.ttlMs).toISOString();
		const expired = this.workflowSelectAll(
			`SELECT w.dead_execution_id
			   FROM workflow_dead_execution_watch w
			   LEFT JOIN workflow_run r ON r.run_id = w.run_id
			  WHERE datetime(w.observed_at) <= datetime(?)
			     OR r.run_id IS NULL
			     OR r.status != 'active'
			  ORDER BY CASE WHEN r.run_id IS NULL OR r.status != 'active' THEN 0 ELSE 1 END,
			           w.observed_at, w.dead_execution_id
			  LIMIT ?`,
			[cutoff, bounded],
		).map((row) => row.dead_execution_id as string);
		if (expired.length === 0) return 0;
		const placeholders = expired.map(() => "?").join(", ");
		this.db.run(
			`DELETE FROM workflow_dead_execution_watch
			  WHERE dead_execution_id IN (${placeholders})`,
			expired,
		);
		const pruned = this.db.getRowsModified();
		if (pruned > 0) this.save();
		return pruned;
	}

	tripWorkflowDeadExecutionWatch(input: {
		deadExecutionId: string;
		evidence: WorkflowDeadExecutionActivityEvidence;
		alertIdentity: WorkflowEngineAlertIdentity;
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string } {
		if (
			!input.deadExecutionId ||
			!input.evidence.detail ||
			!StateStore.workflowFiniteTimestamp(input.now)
		) {
			return { ok: false, reason: "invalid_dead_execution_activity" };
		}
		if (input.evidence.kind === "tmux_output") {
			return { ok: false, reason: "weak_dead_execution_activity" };
		}
		let result:
			| { ok: true; idempotentReplay: boolean }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "watch_not_found",
		};
		this.db.transaction(() => {
			const row = this.workflowSelectAll(
				"SELECT * FROM workflow_dead_execution_watch WHERE dead_execution_id = ?",
				[input.deadExecutionId],
			)[0];
			if (!row) return;
			if (row.state === "tripped") {
				result = { ok: true, idempotentReplay: true };
				return;
			}
			const evidenceJson = JSON.stringify(input.evidence);
			this.db.run(
				`UPDATE workflow_dead_execution_watch
				    SET state = 'tripped', tripped_at = ?, evidence_json = ?
				  WHERE dead_execution_id = ? AND state = 'active'`,
				[input.now, evidenceJson, input.deadExecutionId],
			);
			if (this.db.getRowsModified() !== 1) {
				result = { ok: false, reason: "watch_transition_raced" };
				return;
			}
			const escalationUid = `dead_activity:${row.run_id}:${row.node_id}:${row.attempt}:${input.deadExecutionId}`;
			this.appendWorkflowRunEventCheckedTx({
				runId: row.run_id as string,
				eventUid: escalationUid,
				kind: "dead_execution_activity_after_replacement",
				nodeId: row.node_id as string,
				executionId: input.deadExecutionId,
				payload: {
					attempt: Number(row.attempt),
					newExecutionId: row.new_execution_id as string,
					evidence: input.evidence,
					at: input.now,
				},
			});
			this.enqueueWorkflowEngineAlertTx({
				escalationUid,
				runId: row.run_id as string,
				now: input.now,
				payload: this.workflowDeadExecutionAlertPayload({
					escalationUid,
					eventType: "workflow_engine_escalation",
					runId: row.run_id as string,
					issueId: row.issue_id as string,
					nodeId: row.node_id as string,
					executionId: input.deadExecutionId,
					disposition: "dead_execution_activity_after_replacement",
					body: `Execution ${input.deadExecutionId} was replaced as dead, then produced new ${input.evidence.kind} activity (${input.evidence.detail}). Treat the prior death verdict as a confirmed false positive and inspect both executions immediately.`,
					identity: input.alertIdentity,
				}),
			});
			const issueAlertUid = `${escalationUid}:issue`;
			this.enqueueWorkflowEngineAlertTx({
				escalationUid: issueAlertUid,
				runId: row.run_id as string,
				now: input.now,
				payload: this.workflowDeadExecutionAlertPayload({
					escalationUid: issueAlertUid,
					eventType: "workflow_engine_issue_alert",
					runId: row.run_id as string,
					issueId: row.issue_id as string,
					nodeId: row.node_id as string,
					executionId: input.deadExecutionId,
					disposition: "dead_execution_activity_after_replacement",
					body: `Execution ${input.deadExecutionId} was replaced as dead, then produced new ${input.evidence.kind} activity (${input.evidence.detail}). Treat the prior death verdict as a confirmed false positive and inspect both executions immediately.`,
					identity: input.alertIdentity,
				}),
			});
			result = { ok: true, idempotentReplay: false };
		});
		if (result.ok) this.save();
		return result;
	}

	getWorkflowAlertOutbox(
		escalationUid: string,
	): WorkflowAlertOutboxRow | undefined {
		const row = this.workflowSelectAll(
			"SELECT * FROM workflow_alert_outbox WHERE escalation_uid = ?",
			[escalationUid],
		)[0];
		return row ? workflowAlertOutboxRow(row) : undefined;
	}

	listWorkflowAlertOutbox(): WorkflowAlertOutboxRow[] {
		return this.workflowSelectAll(
			"SELECT * FROM workflow_alert_outbox ORDER BY created_at, escalation_uid",
			[],
		).map(workflowAlertOutboxRow);
	}

	claimNextWorkflowAlert(input: {
		ownerId: string;
		now: string;
		leaseExpiresAt: string;
	}): WorkflowAlertDeliveryClaim | undefined {
		if (
			!input.ownerId ||
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.leaseExpiresAt) ||
			Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
		) {
			throw new Error("invalid_workflow_alert_lease");
		}
		let claimed: WorkflowAlertDeliveryClaim | undefined;
		this.db.transaction(() => {
			const candidate = this.workflowSelectAll(
				`SELECT * FROM workflow_alert_outbox
				  WHERE attempt < 3 AND (
				    state = 'pending' OR
				    (state = 'delivering' AND lease_expires_at <= ?)
				  )
				  ORDER BY created_at, escalation_uid LIMIT 1`,
				[input.now],
			)[0];
			if (!candidate) return;
			const generation = Number(candidate.generation) + 1;
			this.db.run(
				`UPDATE workflow_alert_outbox
				    SET state = 'delivering', attempt = attempt + 1,
				        lease_owner = ?, lease_expires_at = ?, generation = ?,
				        updated_at = ?, last_error = NULL
				  WHERE escalation_uid = ? AND generation = ? AND attempt < 3
				    AND (state = 'pending' OR
				         (state = 'delivering' AND lease_expires_at <= ?))`,
				[
					input.ownerId,
					input.leaseExpiresAt,
					generation,
					input.now,
					candidate.escalation_uid,
					candidate.generation,
					input.now,
				],
			);
			if (this.db.getRowsModified() !== 1) return;
			claimed = {
				escalationUid: candidate.escalation_uid as string,
				runId: candidate.run_id as string,
				payload: JSON.parse(candidate.payload_json as string),
				attempt: Number(candidate.attempt) + 1,
				generation,
				ownerId: input.ownerId,
			};
		});
		if (claimed) this.save();
		return claimed;
	}

	finishWorkflowAlertDelivery(input: {
		escalationUid: string;
		ownerId: string;
		generation: number;
		outcome: "sent" | "failed";
		error?: string;
		now: string;
	}):
		| { ok: true; state: "pending" | "sent" | "failed" }
		| { ok: false; reason: string } {
		let result:
			| { ok: true; state: "pending" | "sent" | "failed" }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "stale_alert_delivery_generation",
		};
		this.db.transaction(() => {
			const row = this.workflowSelectAll(
				"SELECT * FROM workflow_alert_outbox WHERE escalation_uid = ?",
				[input.escalationUid],
			)[0];
			if (
				!row ||
				row.state !== "delivering" ||
				row.lease_owner !== input.ownerId ||
				Number(row.generation) !== input.generation
			) {
				return;
			}
			const attempt = Number(row.attempt);
			const state =
				input.outcome === "sent" ? "sent" : attempt >= 3 ? "failed" : "pending";
			this.db.run(
				`UPDATE workflow_alert_outbox
				    SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
				        last_error = ?, updated_at = ?
				  WHERE escalation_uid = ? AND state = 'delivering'
				    AND lease_owner = ? AND generation = ?`,
				[
					state,
					input.outcome === "failed"
						? (input.error ?? "delivery_failed")
						: null,
					input.now,
					input.escalationUid,
					input.ownerId,
					input.generation,
				],
			);
			if (this.db.getRowsModified() !== 1) return;
			if (state === "sent") {
				this.appendWorkflowRunEventCheckedTx({
					runId: row.run_id as string,
					eventUid: `alert_posted:${input.escalationUid}`,
					kind: "workflow_engine_alert_posted",
					payload: {
						escalationUid: input.escalationUid,
						attempt,
					},
				});
			}
			result = { ok: true, state };
		});
		if (result.ok) this.save();
		return result;
	}

	listWorkflowDivergenceCandidates(limit = 200): WorkflowDivergenceCandidate[] {
		const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
		const statuses = ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES.map(() => "?").join(
			",",
		);
		return this.workflowSelectAll(
			`SELECT n.run_id, n.node_id, n.attempt, n.execution_id,
			        s.status AS session_status, s.lifecycle_revision
			   FROM workflow_run_node n
			   JOIN workflow_run r ON r.run_id = n.run_id AND r.engine_owned = 1
			   JOIN sessions s ON s.execution_id = n.execution_id
			   LEFT JOIN workflow_divergence_check c
			     ON c.execution_id = n.execution_id
			  WHERE n.state = 'done'
			    AND s.status IN (${statuses})
			    AND s.lifecycle_revision > COALESCE(c.checked_lifecycle_revision, -1)
			  ORDER BY s.lifecycle_revision, n.execution_id
			  LIMIT ?`,
			[...ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES, bounded],
		).map((row) => ({
			runId: row.run_id as string,
			nodeId: row.node_id as string,
			attempt: Number(row.attempt),
			executionId: row.execution_id as string,
			sessionStatus: row.session_status as string,
			lifecycleRevision: Number(row.lifecycle_revision),
		}));
	}

	commitWorkflowDivergenceObservation(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		executionId: string;
		observedStatus: string;
		observedLifecycleRevision: number;
		now: string;
	}):
		| { ok: true; divergence: boolean; deduped: boolean }
		| { ok: false; reason: string } {
		let result:
			| { ok: true; divergence: boolean; deduped: boolean }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "stale_divergence_observation",
		};
		this.db.transaction(() => {
			const node = this.getWorkflowRunNode(
				input.runId,
				input.nodeId,
				input.attempt,
			);
			const session = this.getSession(input.executionId);
			if (
				node?.state !== "done" ||
				node.execution_id !== input.executionId ||
				!session ||
				session.status !== input.observedStatus ||
				session.lifecycle_revision !== input.observedLifecycleRevision ||
				!isStateStoreIrreversibleTerminalForZombie(session.status)
			) {
				return;
			}
			let deduped = false;
			if (session.status !== "completed") {
				const appended = this.appendWorkflowRunEventCheckedTx({
					runId: input.runId,
					eventUid: `divergence:${input.runId}:${input.nodeId}:${input.attempt}`,
					kind: "workflow_node_session_divergence",
					nodeId: input.nodeId,
					executionId: input.executionId,
					payload: {
						nodeState: "done",
						sessionStatus: session.status,
						lifecycleRevision: session.lifecycle_revision,
					},
				});
				deduped = appended.deduped;
			}
			this.db.run(
				`INSERT INTO workflow_divergence_check
				   (execution_id, checked_lifecycle_revision, checked_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(execution_id) DO UPDATE SET
				   checked_lifecycle_revision = MAX(
				     workflow_divergence_check.checked_lifecycle_revision,
				     excluded.checked_lifecycle_revision
				   ),
				   checked_at = CASE
				     WHEN excluded.checked_lifecycle_revision >= workflow_divergence_check.checked_lifecycle_revision
				     THEN excluded.checked_at ELSE workflow_divergence_check.checked_at END`,
				[input.executionId, input.observedLifecycleRevision, input.now],
			);
			result = {
				ok: true,
				divergence: session.status !== "completed",
				deduped,
			};
		});
		if (result.ok) this.save();
		return result;
	}

	/**
	 * Replace one proven-dead physical launch without rewriting its immutable
	 * launch history. The node attempt stays the same; only its execution owner
	 * and the appended launch ordinal advance.
	 */
	rollbackDeadWorkflowNodeExecution(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		deadExecutionId: string;
		newExecutionId: string;
		reason: string;
		livenessEvidence: { liveness: "dead"; observedAt: string };
		activityBaseline?: WorkflowDeadExecutionActivityBaseline;
		retryDisposition?: "retry" | "hold" | "design_fallback";
		alertIdentity?: WorkflowEngineAlertIdentity;
		now?: string;
	}):
		| { ok: true; idempotentReplay: boolean; launchOrdinal: number }
		| { ok: false; reason: string } {
		const now = input.now ?? new Date().toISOString();
		if (
			!input.runId ||
			!input.nodeId ||
			!input.deadExecutionId ||
			!input.newExecutionId ||
			!input.reason ||
			!Number.isInteger(input.attempt) ||
			input.attempt < 1 ||
			input.livenessEvidence.liveness !== "dead" ||
			!StateStore.workflowFiniteTimestamp(input.livenessEvidence.observedAt) ||
			!StateStore.workflowFiniteTimestamp(now)
		) {
			return { ok: false, reason: "invalid_dead_execution_rollback" };
		}

		let result:
			| { ok: true; idempotentReplay: boolean; launchOrdinal: number }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "rollback_not_committed",
		};
		this.db.transaction(() => {
			const eventUid = `dead_rollback:${input.runId}:${input.nodeId}:${input.attempt}:${input.deadExecutionId}`;
			const prior = this.workflowSelectAll(
				"SELECT kind, payload FROM workflow_run_event WHERE event_uid = ?",
				[eventUid],
			)[0];
			if (prior) {
				let payload: Record<string, unknown>;
				try {
					payload = JSON.parse(prior.payload as string) as Record<
						string,
						unknown
					>;
				} catch {
					result = { ok: false, reason: "rollback_receipt_corrupt" };
					return;
				}
				if (
					prior.kind !== "execution_dead_rolled_back" ||
					payload.newExecutionId !== input.newExecutionId ||
					payload.reason !== input.reason ||
					payload.retryDisposition !== (input.retryDisposition ?? "retry") ||
					payload.at !== now ||
					canonicalSubmissionDigest(payload.livenessEvidence) !==
						canonicalSubmissionDigest(input.livenessEvidence) ||
					!Number.isInteger(payload.launchOrdinal)
				) {
					result = { ok: false, reason: "rollback_receipt_conflict" };
					return;
				}
				result = {
					ok: true,
					idempotentReplay: true,
					launchOrdinal: Number(payload.launchOrdinal),
				};
				return;
			}
			const run = this.getWorkflowRun(input.runId);
			if (!run || run.engine_owned !== 1 || run.status !== "active") {
				result = { ok: false, reason: "engine_run_not_active" };
				return;
			}
			const enqueueAlert = (
				escalationUid: string,
				disposition: "held" | "design_fallback",
				reason: string,
			): void => {
				if (!input.alertIdentity) return;
				this.enqueueWorkflowEngineAlertTx({
					escalationUid,
					runId: input.runId,
					now,
					payload: this.workflowEngineAlertPayload({
						escalationUid,
						runId: input.runId,
						issueId: run.issue_id,
						nodeId: input.nodeId,
						executionId: input.deadExecutionId,
						reason,
						disposition,
						identity: input.alertIdentity,
					}),
				});
			};
			const node = this.getWorkflowRunNode(
				input.runId,
				input.nodeId,
				input.attempt,
			);
			if (
				!node ||
				node.state !== "running" ||
				node.execution_id !== input.deadExecutionId
			) {
				result = { ok: false, reason: "node_execution_not_current" };
				return;
			}
			if (
				this.getWorkflowNodeCompletion(input.runId, input.nodeId, input.attempt)
			) {
				result = { ok: false, reason: "receipt_exists" };
				return;
			}
			const session = this.getSession(input.deadExecutionId);
			if (
				!isStateStoreIrreversibleTerminalForZombie(session?.status) &&
				!this.hasWorkflowExecutionTeardownFact(
					input.runId,
					input.nodeId,
					input.deadExecutionId,
				)
			) {
				result = { ok: false, reason: "execution_not_terminal" };
				return;
			}
			if (input.retryDisposition === "hold") {
				const escalationUid = `nonretryable:${input.runId}:${input.nodeId}:${input.attempt}:${input.deadExecutionId}`;
				this.db.run(
					"UPDATE workflow_run SET status = 'held' WHERE run_id = ? AND status = 'active'",
					[input.runId],
				);
				this.appendWorkflowRunEventCheckedTx({
					runId: input.runId,
					eventUid: escalationUid,
					kind: "non_retryable_execution_failure",
					nodeId: input.nodeId,
					executionId: input.deadExecutionId,
					payload: {
						attempt: input.attempt,
						reason: input.reason,
						livenessEvidence: input.livenessEvidence,
						at: now,
					},
				});
				enqueueAlert(escalationUid, "held", input.reason);
				result = { ok: false, reason: "non_retryable_execution_failure" };
				return;
			}
			const outputExists =
				this.workflowSelectAll(
					`SELECT 1 AS present FROM workflow_node_outputs
					  WHERE run_id = ? AND node_id = ? AND attempt = ? LIMIT 1`,
					[input.runId, input.nodeId, input.attempt],
				).length > 0 ||
				this.workflowSelectAll(
					`SELECT 1 AS present FROM workflow_output_credential
					  WHERE run_id = ? AND node_id = ? AND attempt = ?
					    AND consumed_at IS NOT NULL LIMIT 1`,
					[input.runId, input.nodeId, input.attempt],
				).length > 0;
			if (outputExists) {
				this.db.run(
					"UPDATE workflow_run SET status = 'held' WHERE run_id = ? AND status = 'active'",
					[input.runId],
				);
				this.appendWorkflowRunEventCheckedTx({
					runId: input.runId,
					eventUid: `dead_after_output:${input.runId}:${input.nodeId}:${input.attempt}:${input.deadExecutionId}`,
					kind: "dead_execution_after_output",
					nodeId: input.nodeId,
					executionId: input.deadExecutionId,
					payload: {
						attempt: input.attempt,
						reason: input.reason,
						livenessEvidence: input.livenessEvidence,
						at: now,
					},
				});
				enqueueAlert(
					`dead_after_output:${input.runId}:${input.nodeId}:${input.attempt}:${input.deadExecutionId}`,
					"held",
					"dead_execution_after_output",
				);
				result = { ok: false, reason: "dead_execution_after_output" };
				return;
			}
			const launchCount = Number(
				this.workflowSelectAll(
					`SELECT COUNT(*) AS count FROM workflow_side_effect_ledger
					  WHERE run_id = ? AND node_id = ? AND attempt = ? AND kind = 'dispatch'`,
					[input.runId, input.nodeId, input.attempt],
				)[0]?.count ?? 0,
			);
			if (launchCount >= 4) {
				this.db.run(
					"UPDATE workflow_run SET status = 'held' WHERE run_id = ? AND status = 'active'",
					[input.runId],
				);
				this.appendWorkflowRunEventCheckedTx({
					runId: input.runId,
					eventUid: `retry_limit:${input.runId}:${input.nodeId}:${input.attempt}:${launchCount}`,
					kind: "retry_limit_escalated",
					nodeId: input.nodeId,
					executionId: input.deadExecutionId,
					payload: {
						attempt: input.attempt,
						maxLaunchOrdinal: launchCount,
						reason: input.reason,
						livenessEvidence: input.livenessEvidence,
						at: now,
					},
				});
				enqueueAlert(
					`retry_limit:${input.runId}:${input.nodeId}:${input.attempt}:${launchCount}`,
					"held",
					"retry_limit_exceeded",
				);
				result = { ok: false, reason: "retry_limit_exceeded" };
				return;
			}
			const priorDeadReplacementCount = Number(
				this.workflowSelectAll(
					`SELECT COUNT(*) AS count FROM workflow_dead_execution_watch
					  WHERE run_id = ? AND node_id = ? AND attempt = ?`,
					[input.runId, input.nodeId, input.attempt],
				)[0]?.count ?? 0,
			);

			for (const table of [
				"workflow_output_credential",
				"workflow_submission_credential",
			]) {
				this.db.run(
					`UPDATE ${table}
					    SET revoked = 1, revoked_reason = 'dead_execution_rolled_back'
					  WHERE run_id = ? AND node_id = ? AND attempt = ?
					    AND execution_id = ? AND consumed_at IS NULL AND revoked = 0`,
					[input.runId, input.nodeId, input.attempt, input.deadExecutionId],
				);
			}
			const launchOrdinal = this.allocateWorkflowLaunchOrdinalTx(
				input.runId,
				input.nodeId,
				input.attempt,
				input.newExecutionId,
			);
			this.upsertWorkflowRunNodeTx({
				runId: input.runId,
				nodeId: input.nodeId,
				attempt: input.attempt,
				state: "pending",
				executionId: input.newExecutionId,
			});
			this.appendWorkflowRunEventCheckedTx({
				runId: input.runId,
				eventUid,
				kind: "execution_dead_rolled_back",
				nodeId: input.nodeId,
				executionId: input.deadExecutionId,
				payload: {
					attempt: input.attempt,
					newExecutionId: input.newExecutionId,
					launchOrdinal,
					reason: input.reason,
					retryDisposition: input.retryDisposition ?? "retry",
					livenessEvidence: input.livenessEvidence,
					at: now,
				},
			});
			const activityBaseline: WorkflowDeadExecutionActivityBaseline =
				input.activityBaseline ?? {
					commitMarker: { state: "unknown" },
					commDbMessageCount: null,
					tmuxTarget: session?.tmux_session ?? null,
					tmuxOutputDigest: null,
					sessionCommitCount:
						typeof session?.commit_count === "number"
							? session.commit_count
							: null,
				};
			this.db.run(
				`INSERT INTO workflow_dead_execution_watch
				   (dead_execution_id, run_id, node_id, attempt, new_execution_id,
				    project_name, issue_id, observed_at, baseline_json, state)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
				[
					input.deadExecutionId,
					input.runId,
					input.nodeId,
					input.attempt,
					input.newExecutionId,
					run.project_name,
					run.issue_id,
					input.livenessEvidence.observedAt,
					JSON.stringify(activityBaseline),
				],
			);
			if (priorDeadReplacementCount > 0 && input.alertIdentity) {
				const deathNumber = priorDeadReplacementCount + 1;
				const escalationUid = `repeated_dead:${input.runId}:${input.nodeId}:${input.attempt}:${deathNumber}`;
				this.appendWorkflowRunEventCheckedTx({
					runId: input.runId,
					eventUid: escalationUid,
					kind: "repeated_dead_execution_pattern",
					nodeId: input.nodeId,
					executionId: input.deadExecutionId,
					payload: {
						attempt: input.attempt,
						deathNumber,
						newExecutionId: input.newExecutionId,
						at: now,
					},
				});
				this.enqueueWorkflowEngineAlertTx({
					escalationUid,
					runId: input.runId,
					now,
					payload: this.workflowDeadExecutionAlertPayload({
						escalationUid,
						eventType: "workflow_engine_escalation",
						runId: input.runId,
						issueId: run.issue_id,
						nodeId: input.nodeId,
						executionId: input.deadExecutionId,
						disposition: "repeated_dead_execution_pattern",
						body: `Run ${input.runId} node ${input.nodeId} has now required ${deathNumber} dead-execution replacements in the same logical attempt. Inspect the liveness classifier and replacement chain; automatic retry remains bounded by the existing ladder.`,
						identity: input.alertIdentity,
					}),
				});
				const issueAlertUid = `${escalationUid}:issue`;
				this.enqueueWorkflowEngineAlertTx({
					escalationUid: issueAlertUid,
					runId: input.runId,
					now,
					payload: this.workflowDeadExecutionAlertPayload({
						escalationUid: issueAlertUid,
						eventType: "workflow_engine_issue_alert",
						runId: input.runId,
						issueId: run.issue_id,
						nodeId: input.nodeId,
						executionId: input.deadExecutionId,
						disposition: "repeated_dead_execution_pattern",
						body: `Run ${input.runId} node ${input.nodeId} has now required ${deathNumber} dead-execution replacements in the same logical attempt. Inspect the liveness classifier and replacement chain; automatic retry remains bounded by the existing ladder.`,
						identity: input.alertIdentity,
					}),
				});
			}
			if (input.retryDisposition === "design_fallback") {
				enqueueAlert(
					`design_fallback:${input.runId}:${input.nodeId}:${input.attempt}:${input.deadExecutionId}`,
					"design_fallback",
					input.reason,
				);
			}
			result = { ok: true, idempotentReplay: false, launchOrdinal };
		});
		this.save();
		return result;
	}

	/** Startup safety collector: record durable holds, never dispatch successors. */
	holdStrandedGeneralizedExecutions(): string[] {
		const rows = this.workflowSelectAll(
			`SELECT b.execution_id
			   FROM workflow_execution_binding b
			   JOIN workflow_run_node n
			     ON n.run_id = b.run_id AND n.node_id = b.node_id AND n.attempt = b.attempt
			   LEFT JOIN workflow_node_completion c
			     ON c.run_id = b.run_id AND c.node_id = b.node_id AND c.attempt = b.attempt
			   LEFT JOIN sessions s ON s.execution_id = b.execution_id
			  WHERE c.execution_id IS NULL AND n.state <> 'done'
			    AND (s.execution_id IS NULL OR s.status IN ('failed','blocked','rejected'))`,
			[],
		);
		const held: string[] = [];
		for (const row of rows) {
			const executionId = row.execution_id as string;
			const context = this.generalizedExecutionContext(executionId);
			if (!context) continue;
			// Typed engine successors are recovered by WorkflowEngineDispatcher from
			// the durable dispatch outbox. This legacy safety collector must not
			// classify a recoverable engine launch as permanently stranded.
			if (context.run.engine_owned === 1) continue;
			this.appendWorkflowRunEvent({
				runId: context.binding.run_id,
				eventUid: `generalized_stranded_hold:${executionId}`,
				kind: "generalized_stranded_hold",
				nodeId: context.binding.node_id,
				executionId,
				payload: { reason: "completion_receipt_missing" },
			});
			held.push(executionId);
		}
		return held;
	}

	submitWorkflowNodeOutput(input: {
		token: string;
		clientRequestId: string;
		payload: string;
		now?: string;
	}): WorkflowOutputSubmissionResult {
		const now = input.now ?? new Date().toISOString();
		if (!StateStore.workflowFiniteTimestamp(now)) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		let parsedPayload: unknown;
		try {
			parsedPayload = JSON.parse(input.payload);
		} catch {
			return { ok: false, reason: "invalid_output" };
		}
		const submissionDigest = canonicalSubmissionDigest({
			clientRequestId: input.clientRequestId,
			payload: parsedPayload,
		});
		const credentialPreview = this.workflowSelectAll(
			"SELECT * FROM workflow_output_credential WHERE credential_hash = ?",
			[hashCapabilityToken(input.token)],
		)[0];
		if (!credentialPreview)
			return { ok: false, reason: "credential_not_found" };
		const context = this.generalizedExecutionContext(
			credentialPreview.execution_id as string,
		);
		if (
			!context ||
			!context.node.capabilities.produces_output ||
			!context.node.output
		) {
			return { ok: false, reason: "node_does_not_produce_output" };
		}
		const byteSize = Buffer.byteLength(input.payload, "utf8");
		if (byteSize > context.node.output.max_bytes) {
			return { ok: false, reason: "output_too_large" };
		}
		let result: WorkflowOutputSubmissionResult | undefined;
		this.db.transaction(() => {
			const credential = this.workflowSelectAll(
				"SELECT * FROM workflow_output_credential WHERE credential_hash = ?",
				[hashCapabilityToken(input.token)],
			)[0];
			if (!credential) {
				result = { ok: false, reason: "credential_not_found" };
				return;
			}
			if (credential.consumed_at != null) {
				result =
					credential.consumed_submission_digest === submissionDigest &&
					credential.consumed_client_request_id === input.clientRequestId &&
					credential.output_id != null
						? {
								ok: true,
								outputId: Number(credential.output_id),
								idempotentReplay: true,
							}
						: { ok: false, reason: "replay_payload_mismatch" };
				return;
			}
			if (Number(credential.revoked) === 1) {
				result = { ok: false, reason: "credential_revoked" };
				return;
			}
			if (StateStore.workflowExpired(credential.expires_at as string, now)) {
				result = { ok: false, reason: "credential_expired" };
				return;
			}
			const currentOwner = this.workflowSelectAll(
				`SELECT 1 AS present FROM workflow_run_node
				  WHERE run_id = ? AND node_id = ? AND attempt = ?
				    AND execution_id = ? AND state IN ('admitted','running')`,
				[
					credential.run_id as string,
					credential.node_id as string,
					Number(credential.attempt),
					credential.execution_id as string,
				],
			)[0];
			if (!currentOwner) {
				result = { ok: false, reason: "credential_revoked" };
				return;
			}
			const prior = this.workflowSelectAll(
				`SELECT * FROM workflow_node_outputs
				  WHERE run_id = ? AND node_id = ? AND attempt = ?`,
				[
					credential.run_id as string,
					credential.node_id as string,
					Number(credential.attempt),
				],
			)[0];
			if (prior) {
				result = { ok: false, reason: "output_already_exists" };
				return;
			}
			const current = this.workflowSelectAll(
				"SELECT * FROM workflow_node_output_current WHERE run_id = ? AND node_id = ?",
				[credential.run_id as string, credential.node_id as string],
			)[0];
			if (current && Number(current.attempt) >= Number(credential.attempt)) {
				result = { ok: false, reason: "stale_output_attempt" };
				return;
			}
			this.db.run(
				`UPDATE workflow_output_credential
				    SET consumed_at = ?, consumed_client_request_id = ?,
				        consumed_submission_digest = ?
				  WHERE id = ? AND consumed_at IS NULL AND revoked = 0`,
				[now, input.clientRequestId, submissionDigest, credential.id],
			);
			if (this.db.getRowsModified() !== 1) {
				result = { ok: false, reason: "credential_revoked" };
				return;
			}
			this.db.run(
				`INSERT INTO workflow_node_outputs
				   (run_id, node_id, attempt, execution_id, payload, output_digest,
				    output_schema, byte_size, client_request_id, submission_digest, written_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'json_v1', ?, ?, ?, ?)`,
				[
					credential.run_id as string,
					credential.node_id as string,
					Number(credential.attempt),
					credential.execution_id as string,
					input.payload,
					canonicalSubmissionDigest(parsedPayload),
					byteSize,
					input.clientRequestId,
					submissionDigest,
					now,
				],
			);
			const outputId = Number(
				this.workflowSelectAll("SELECT last_insert_rowid() AS id", [])[0]?.id,
			);
			this.db.run(
				`INSERT INTO workflow_node_output_current
				   (run_id, node_id, output_id, attempt, execution_id, promoted_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(run_id, node_id) DO UPDATE SET
				   output_id=excluded.output_id, attempt=excluded.attempt,
				   execution_id=excluded.execution_id, promoted_at=excluded.promoted_at`,
				[
					credential.run_id as string,
					credential.node_id as string,
					outputId,
					Number(credential.attempt),
					credential.execution_id as string,
					now,
				],
			);
			this.db.run(
				`UPDATE workflow_output_credential
				    SET output_id = ?
				  WHERE id = ?`,
				[outputId, credential.id],
			);
			this.appendWorkflowRunEventTx({
				runId: credential.run_id as string,
				eventUid: `workflow_output:${outputId}`,
				kind: "node_output_written",
				nodeId: credential.node_id as string,
				executionId: credential.execution_id as string,
				payload: { attempt: Number(credential.attempt), outputId },
			});
			result = { ok: true, outputId, idempotentReplay: false };
		});
		if (!result)
			throw new Error("workflow output submission produced no result");
		if (result.ok && !result.idempotentReplay) this.save();
		return result;
	}

	private projectGeneralizedCompletionTx(input: {
		context: NonNullable<ReturnType<StateStore["generalizedExecutionContext"]>>;
		route: string;
		completedAt: string;
	}): void {
		const { binding, run } = input.context;
		const previousStatus = this.getSession(binding.execution_id)?.status;
		this.db.run(
			`UPDATE workflow_run_node SET state = 'done', ended_at = ?
			  WHERE run_id = ? AND node_id = ? AND attempt = ?`,
			[input.completedAt, binding.run_id, binding.node_id, binding.attempt],
		);
		this.db.run(
			`INSERT INTO sessions
			   (execution_id, issue_id, project_name, status, last_activity_at,
			    decision_route, workflow_node_id)
			 VALUES (?, ?, ?, 'completed', ?, ?, ?)
			 ON CONFLICT(execution_id) DO UPDATE SET
			   status = 'completed', last_activity_at = excluded.last_activity_at,
			   decision_route = excluded.decision_route,
			   workflow_node_id = CASE
			     WHEN workflow_node_id IS NULL THEN excluded.workflow_node_id
			     ELSE workflow_node_id END`,
			[
				binding.execution_id,
				run.issue_id,
				run.project_name,
				input.completedAt,
				input.route,
				binding.node_id,
			],
		);
		// FLY-1328 HIGH: this generalized-completion writer sets status='completed'
		// but is NOT the FSM path, so it must stamp terminal_at itself. Without it a
		// session completed here stays terminal-with-no-stamp, and the A2 ask sweep's
		// FLY-1257 chronology guard fails CLOSED on the missing stamp — retiring an ask
		// this execution was still owed a human answer for. Same transaction as the
		// upsert above; the helper no-ops on the idempotent replay (already terminal).
		this.applyTerminalTimestamp(
			binding.execution_id,
			previousStatus,
			"completed",
		);
		if (previousStatus && previousStatus !== "completed") {
			this.bumpLifecycleRevision(binding.execution_id);
		}
	}

	commitEnrolledCompletion(input: {
		executionId: string;
		route: string;
		sourceEventId: string;
		completionSubmission: unknown;
		now?: string;
	}): WorkflowCompletionResult {
		const now = input.now ?? new Date().toISOString();
		if (!StateStore.workflowFiniteTimestamp(now)) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		const context = this.generalizedExecutionContext(input.executionId);
		if (!context) return { ok: false, reason: "not_enrolled" };
		if (input.route !== context.node.capabilities.completion_route) {
			return { ok: false, reason: "route_mismatch" };
		}
		const digest = canonicalSubmissionDigest(input.completionSubmission);
		const existing = this.workflowSelectAll(
			`SELECT * FROM workflow_node_completion
			  WHERE run_id = ? AND node_id = ? AND attempt = ?`,
			[
				context.binding.run_id,
				context.binding.node_id,
				context.binding.attempt,
			],
		)[0];
		if (existing) {
			if (
				existing.execution_id !== input.executionId ||
				existing.route !== input.route ||
				existing.completion_submission_digest !== digest
			) {
				return { ok: false, reason: "completion_conflict" };
			}
			this.db.transaction(() =>
				this.projectGeneralizedCompletionTx({
					context,
					route: input.route,
					completedAt: existing.completed_at as string,
				}),
			);
			this.save();
			return {
				ok: true,
				eventUid: existing.event_uid as string,
				idempotentReplay: true,
			};
		}
		const currentNode = this.getWorkflowRunNode(
			context.binding.run_id,
			context.binding.node_id,
			context.binding.attempt,
		);
		if (currentNode?.execution_id !== context.binding.execution_id) {
			return { ok: false, reason: "stale_execution_superseded" };
		}
		if (context.node.capabilities.produces_output) {
			const current = this.workflowSelectAll(
				`SELECT * FROM workflow_node_output_current
				  WHERE run_id = ? AND node_id = ?`,
				[context.binding.run_id, context.binding.node_id],
			)[0];
			if (
				!current ||
				Number(current.attempt) !== context.binding.attempt ||
				current.execution_id !== context.binding.execution_id
			) {
				return { ok: false, reason: "missing_output", retryable: true };
			}
		}
		const eventUid = `wfc:${context.binding.run_id}:${context.binding.node_id}:${context.binding.attempt}`;
		const engineOutcome =
			context.run.engine_owned !== 1
				? undefined
				: context.node.type === "design"
					? "design_done"
					: context.node.type === "implement"
						? "implement_done"
						: context.node.type === "generic"
							? "node_done"
							: undefined;
		let transitionRefusal: string | undefined;
		try {
			this.db.transaction(() => {
				this.db.run(
					`INSERT INTO workflow_node_completion
				   (run_id, node_id, attempt, execution_id, route, event_uid,
				    source_event_id, completion_submission_digest, completed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						context.binding.run_id,
						context.binding.node_id,
						context.binding.attempt,
						context.binding.execution_id,
						input.route,
						eventUid,
						input.sourceEventId,
						digest,
						now,
					],
				);
				if (context.run.engine_owned === 1) {
					if (!engineOutcome) {
						transitionRefusal = "decision_required";
						throw new Error("engine_completion_transition_refused");
					}
					const transition = this.commitWorkflowTransitionTx({
						runId: context.binding.run_id,
						nodeId: context.binding.node_id,
						attempt: context.binding.attempt,
						executionId: context.binding.execution_id,
						outcome: engineOutcome,
						nodeCompletionEventUid: eventUid,
						now,
					});
					if (!transition.ok) {
						transitionRefusal = transition.reason;
						throw new Error("engine_completion_transition_refused");
					}
				}
				this.projectGeneralizedCompletionTx({
					context,
					route: input.route,
					completedAt: now,
				});
				if (context.run.engine_owned !== 1) {
					this.appendWorkflowRunEventTx({
						runId: context.binding.run_id,
						eventUid,
						kind: "node_completed",
						nodeId: context.binding.node_id,
						executionId: context.binding.execution_id,
						payload: { attempt: context.binding.attempt, route: input.route },
					});
				}
			});
		} catch (error) {
			if (transitionRefusal) {
				return { ok: false, reason: "transition_refused" };
			}
			throw error;
		}
		this.save();
		return { ok: true, eventUid, idempotentReplay: false };
	}

	observeEnrolledTeardown(input: { executionId: string }): {
		enrolled: boolean;
		receipt: boolean;
		held: boolean;
	} {
		const context = this.generalizedExecutionContext(input.executionId);
		if (!context) return { enrolled: false, receipt: false, held: false };
		const receipt = this.workflowSelectAll(
			`SELECT * FROM workflow_node_completion
			  WHERE run_id = ? AND node_id = ? AND attempt = ?`,
			[
				context.binding.run_id,
				context.binding.node_id,
				context.binding.attempt,
			],
		)[0];
		if (!receipt) {
			this.appendWorkflowRunEvent({
				runId: context.binding.run_id,
				eventUid: `generalized_teardown_hold:${input.executionId}`,
				kind: "generalized_teardown_hold",
				nodeId: context.binding.node_id,
				executionId: input.executionId,
				payload: { reason: "explicit_completion_receipt_missing" },
			});
			return { enrolled: true, receipt: false, held: true };
		}
		this.db.transaction(() =>
			this.projectGeneralizedCompletionTx({
				context,
				route: receipt.route as string,
				completedAt: receipt.completed_at as string,
			}),
		);
		this.save();
		return { enrolled: true, receipt: true, held: false };
	}

	/**
	 * Resolve a schema-v2 execution's node identity exclusively from the
	 * immutable admission binding. Lifecycle payloads may repeat the derived id
	 * for consistency checks, but they can never establish or replace it.
	 *
	 * Legacy/unbound executions intentionally resolve to undefined so the flag-
	 * off and schema-v1 lifecycle bytes remain unchanged.
	 */
	resolveWorkflowNodeIdForExecution(
		executionId: string,
		proposedNodeId?: string,
	): string | undefined {
		const rawBinding = this.getWorkflowExecutionBinding(executionId);
		if (!rawBinding) {
			if (proposedNodeId) {
				throw new Error(
					`workflow node set-once conflict for unbound execution ${executionId}`,
				);
			}
			return undefined;
		}
		const context = this.generalizedExecutionContext(executionId);
		if (!context) return undefined;
		const binding = context.binding;
		const persistedNodeId = this.getSession(executionId)?.workflow_node_id;
		for (const candidate of [persistedNodeId, proposedNodeId]) {
			if (candidate && candidate !== binding.node_id) {
				throw new Error(
					`workflow node set-once conflict for ${executionId}: ${candidate} != ${binding.node_id}`,
				);
			}
		}
		return binding.node_id;
	}

	getWorkflowSubmissionCredential(
		credentialId: number,
	): WorkflowSubmissionCredentialRow | undefined {
		const row = this.workflowSelectAll(
			"SELECT * FROM workflow_submission_credential WHERE id = ?",
			[credentialId],
		)[0];
		if (!row) return undefined;
		return {
			id: Number(row.id),
			credential_hash: row.credential_hash as string,
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			execution_id: row.execution_id as string,
			attempt: Number(row.attempt),
			family: row.family as string,
			decision_capability_id:
				row.decision_capability_id == null
					? null
					: Number(row.decision_capability_id),
			issued_at: row.issued_at as string,
			expires_at: row.expires_at as string,
			absolute_deadline_at: row.absolute_deadline_at as string,
			consumed_at: (row.consumed_at as string) ?? null,
			consumed_client_request_id:
				(row.consumed_client_request_id as string) ?? null,
			consumed_submission_digest:
				(row.consumed_submission_digest as string) ?? null,
			claim_id: row.claim_id == null ? null : Number(row.claim_id),
			revoked: Number(row.revoked),
			revoked_reason: (row.revoked_reason as string) ?? null,
		};
	}

	/** Resolve a scoped submission credential without ever exposing its hash. */
	getWorkflowSubmissionCredentialByToken(
		credential: string,
	): WorkflowSubmissionCredentialRow | undefined {
		const row = this.workflowSelectAll(
			"SELECT id FROM workflow_submission_credential WHERE credential_hash = ?",
			[hashCapabilityToken(credential)],
		)[0];
		return row
			? this.getWorkflowSubmissionCredential(Number(row.id))
			: undefined;
	}

	/**
	 * Credential-authenticated verdict ingestion. Authentication, internal
	 * decision-capability mint+consume, claim append and durable replay receipt
	 * happen in one SQLite transaction. A consumed exact replay is answered
	 * before expiry checks so response-loss recovery survives Bridge restarts.
	 */
	submitWorkflowDecisionByCredential(input: {
		credential: string;
		clientRequestId: string;
		predicate: string;
		subjectDigest: string;
		issuerVendor: string;
		issuerModel: string;
		subjectProducerExecutionId?: string;
		subjectProducerVendor?: string;
		claimExpiresAt: string;
		evidence?: unknown;
		now?: string;
	}): WorkflowCredentialSubmissionResult {
		const nowIso = input.now ?? new Date().toISOString();
		if (
			!StateStore.workflowFiniteTimestamp(nowIso) ||
			!StateStore.workflowFiniteTimestamp(input.claimExpiresAt)
		) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		const digest = canonicalSubmissionDigest({
			clientRequestId: input.clientRequestId,
			predicate: input.predicate,
			subjectKind: "git_head",
			subjectDigest: input.subjectDigest,
			issuerVendor: input.issuerVendor,
			issuerModel: input.issuerModel,
			subjectProducerExecutionId: input.subjectProducerExecutionId ?? null,
			subjectProducerVendor: input.subjectProducerVendor ?? null,
			claimExpiresAt: input.claimExpiresAt,
			evidence: input.evidence ?? null,
		});
		let result: WorkflowCredentialSubmissionResult = {
			ok: false,
			reason: "credential_not_found",
		};
		let transitionRefusal: string | undefined;
		try {
			this.db.transaction(() => {
				const credential = this.workflowSelectAll(
					"SELECT * FROM workflow_submission_credential WHERE credential_hash = ?",
					[hashCapabilityToken(input.credential)],
				)[0];
				if (!credential) {
					result = { ok: false, reason: "credential_not_found" };
					return;
				}
				if (credential.consumed_at != null) {
					if (
						credential.consumed_client_request_id === input.clientRequestId &&
						credential.consumed_submission_digest === digest &&
						credential.claim_id != null
					) {
						const claim = this.getWorkflowClaim(Number(credential.claim_id));
						result = claim
							? {
									ok: true,
									claimId: claim.id,
									serverSeq: claim.server_seq,
									idempotentReplay: true,
								}
							: { ok: false, reason: "credential_receipt_corrupt" };
					} else {
						result = { ok: false, reason: "replay_payload_mismatch" };
					}
					return;
				}
				if (Number(credential.revoked) === 1) {
					result = { ok: false, reason: "credential_revoked" };
					return;
				}
				if (
					!StateStore.workflowFiniteTimestamp(
						credential.expires_at as string,
					) ||
					StateStore.workflowExpired(credential.expires_at as string, nowIso)
				) {
					result = { ok: false, reason: "credential_expired" };
					return;
				}
				const family = credential.family as WorkflowDecisionFamily;
				const allowed = WORKFLOW_DECISION_FAMILIES[family] as
					| readonly string[]
					| undefined;
				if (!allowed?.includes(input.predicate)) {
					result = { ok: false, reason: "predicate_not_allowed" };
					return;
				}
				const binding = this.workflowSelectAll(
					`SELECT b.execution_id
				   FROM workflow_execution_binding b
				   JOIN workflow_run_node n
				     ON n.run_id = b.run_id AND n.node_id = b.node_id
				    AND n.attempt = b.attempt AND n.execution_id = b.execution_id
				   JOIN workflow_run r
				     ON r.run_id = b.run_id AND r.claims_read_enrolled = 1
				  WHERE b.execution_id = ? AND b.run_id = ? AND b.node_id = ? AND b.attempt = ?
				    AND (? != 'qa' OR r.current_qa_attempt = b.attempt)`,
					[
						credential.execution_id,
						credential.run_id,
						credential.node_id,
						credential.attempt,
						credential.node_id,
					],
				)[0];
				if (!binding) {
					result = { ok: false, reason: "binding_not_current" };
					return;
				}
				if (
					REVIEW_CLASS_PREDICATES.has(input.predicate as WorkflowClaimPredicate)
				) {
					if (
						!input.subjectProducerExecutionId ||
						!input.subjectProducerVendor
					) {
						result = { ok: false, reason: "missing_subject_producer" };
						return;
					}
					if (input.issuerVendor === input.subjectProducerVendor) {
						result = { ok: false, reason: "same_vendor_review" };
						return;
					}
				}
				const run = this.workflowSelectAll(
					"SELECT issue_id FROM workflow_run WHERE run_id = ?",
					[credential.run_id],
				)[0];
				if (!run) {
					result = { ok: false, reason: "run_not_found" };
					return;
				}

				// The runner never receives this capability token. It exists only to keep
				// the ledger's authority chain explicit and is consumed in this txn.
				const capabilityToken = generateCapabilityToken();
				const capabilityHash = hashCapabilityToken(capabilityToken);
				this.db.run(
					`INSERT INTO workflow_decision_capability
				   (token_hash, run_id, node_id, execution_id, attempt,
				    allowed_predicate_family, expected_subject_digest, issued_at,
				    expires_at, absolute_deadline_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						capabilityHash,
						credential.run_id,
						credential.node_id,
						credential.execution_id,
						credential.attempt,
						family,
						input.subjectDigest,
						nowIso,
						credential.expires_at,
						credential.absolute_deadline_at,
					],
				);
				const cap = this.workflowSelectAll(
					"SELECT id FROM workflow_decision_capability WHERE token_hash = ?",
					[capabilityHash],
				)[0];
				const capabilityId = Number(cap?.id);
				const serverSeq = this.nextWorkflowClaimSeq();
				this.db.run(
					`INSERT INTO workflow_claims
				   (server_seq, issue_id, workflow_run_id, node_id, decision_kind,
				    attempt, predicate, issuer_kind, issuer_execution_id,
				    issuer_node_id, issuer_vendor, issuer_model,
				    subject_producer_execution_id, subject_kind, subject_digest,
				    expires_at, permanent, submission_digest, client_request_id,
				    evidence, authority_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'runner_node', ?, ?, ?, ?, ?,
				         'git_head', ?, ?, 0, ?, ?, ?, ?)`,
					[
						serverSeq,
						run.issue_id,
						credential.run_id,
						credential.node_id,
						family,
						credential.attempt,
						input.predicate,
						credential.execution_id,
						credential.node_id,
						input.issuerVendor,
						input.issuerModel,
						input.subjectProducerExecutionId ?? null,
						input.subjectDigest,
						input.claimExpiresAt,
						digest,
						input.clientRequestId,
						input.evidence === undefined
							? null
							: JSON.stringify(input.evidence),
						String(capabilityId),
					],
				);
				const claimId = this.workflowClaimIdBySeq(serverSeq);
				this.db.run(
					`UPDATE workflow_decision_capability
				    SET consumed_at = ?, consumed_claim_id = ? WHERE id = ?`,
					[nowIso, claimId, capabilityId],
				);
				this.db.run(
					`UPDATE workflow_submission_credential
				    SET decision_capability_id = ?, consumed_at = ?,
				        consumed_client_request_id = ?, consumed_submission_digest = ?,
				        claim_id = ?
				  WHERE id = ?`,
					[
						capabilityId,
						nowIso,
						input.clientRequestId,
						digest,
						claimId,
						credential.id,
					],
				);
				this.appendWorkflowRunEventTx({
					runId: credential.run_id as string,
					eventUid: `credential_claim_written:${credential.id}`,
					kind: "claim_written",
					nodeId: credential.node_id as string,
					executionId: credential.execution_id as string,
					payload: { claimId, serverSeq, predicate: input.predicate },
				});
				const engineOwned = Number(
					this.workflowSelectAll(
						"SELECT engine_owned FROM workflow_run WHERE run_id = ?",
						[credential.run_id],
					)[0]?.engine_owned ?? 0,
				);
				if (engineOwned === 1) {
					const outcome =
						input.predicate === "qa_passed"
							? "qa_pass"
							: input.predicate === "qa_failed"
								? "qa_fail"
								: input.predicate === "design_review_approved" ||
										input.predicate === "codex_approved"
									? "review_pass"
									: input.predicate === "design_review_failed"
										? "review_fail"
										: undefined;
					if (!outcome) {
						transitionRefusal = "predicate_has_no_engine_outcome";
						throw new Error("engine_decision_transition_refused");
					}
					const transition = this.commitWorkflowTransitionTx({
						runId: credential.run_id as string,
						nodeId: credential.node_id as string,
						attempt: Number(credential.attempt),
						executionId: credential.execution_id as string,
						outcome,
						subjectDigest: input.subjectDigest,
						now: nowIso,
					});
					if (!transition.ok) {
						transitionRefusal = transition.reason;
						throw new Error("engine_decision_transition_refused");
					}
				}
				result = {
					ok: true,
					claimId,
					serverSeq,
					idempotentReplay: false,
				};
			});
		} catch (error) {
			if (transitionRefusal) {
				return { ok: false, reason: "transition_refused" };
			}
			throw error;
		}
		this.save();
		return result;
	}

	/**
	 * Commit one engine-owned snapshot transition and its successor dispatch
	 * intent in a single SQLite transaction. The transition identity excludes
	 * the physical successor execution so competing drivers converge on the
	 * first committed choice instead of allocating a second writer.
	 */
	commitWorkflowTransitionTx(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		executionId: string;
		outcome: string;
		/** Git head decided by QA/founder; required when land_v1 opens its gate. */
		subjectDigest?: string;
		/** Trusted founder feedback carried to the kickback successor receipt. */
		founderFeedback?: string;
		successorExecutionId?: string;
		nodeCompletionEventUid?: string;
		now?: string;
	}): WorkflowTransitionResult {
		const now = input.now ?? new Date().toISOString();
		if (
			!input.runId ||
			!input.nodeId ||
			!input.executionId ||
			!input.outcome ||
			!Number.isInteger(input.attempt) ||
			input.attempt < 1 ||
			!StateStore.workflowFiniteTimestamp(now)
		) {
			return { ok: false, reason: "invalid_transition" };
		}
		const transitionUid = `workflow_transition:${canonicalSubmissionDigest({
			runId: input.runId,
			nodeId: input.nodeId,
			attempt: input.attempt,
			outcome: input.outcome,
		})}`;
		let result: WorkflowTransitionResult = {
			ok: false,
			reason: "transition_not_committed",
		};
		this.db.transaction(() => {
			const prior = this.workflowSelectAll(
				"SELECT kind, payload FROM workflow_run_event WHERE event_uid = ?",
				[transitionUid],
			)[0];
			if (prior) {
				let payload: Record<string, unknown>;
				try {
					payload = JSON.parse(prior.payload as string) as Record<
						string,
						unknown
					>;
				} catch {
					result = { ok: false, reason: "transition_receipt_corrupt" };
					return;
				}
				const committedSuccessor =
					typeof payload.successorExecutionId === "string"
						? payload.successorExecutionId
						: undefined;
				if (
					input.successorExecutionId !== undefined &&
					committedSuccessor !== input.successorExecutionId
				) {
					result = { ok: false, reason: "transition_conflict" };
					return;
				}
				result = {
					ok: true,
					idempotentReplay: true,
					edgeId: String(payload.edgeId),
					targetNodeId: String(payload.targetNodeId),
					targetAttempt: Number(payload.targetAttempt),
					...(committedSuccessor
						? { successorExecutionId: committedSuccessor }
						: {}),
					...(payload.loopIteration == null
						? {}
						: { loopIteration: Number(payload.loopIteration) }),
					...(payload.gateOpened === true ? { gateOpened: true } : {}),
					...(payload.escalated === true ? { escalated: true } : {}),
				};
				return;
			}

			const run = this.getWorkflowRun(input.runId);
			if (!run?.snapshot || run.engine_owned !== 1 || run.status !== "active") {
				result = { ok: false, reason: "engine_run_not_active" };
				return;
			}
			let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
			try {
				snapshot = parseWorkflowRunSnapshot(run.snapshot);
			} catch {
				result = { ok: false, reason: "invalid_snapshot" };
				return;
			}
			const source = snapshot.resolved.nodes.find(
				(node) => node.id === input.nodeId,
			);
			const current = this.getWorkflowRunNode(
				input.runId,
				input.nodeId,
				input.attempt,
			);
			const authorityDrivenGate =
				source?.type === "gate" &&
				snapshot.schema_version === 1 &&
				"manifest_variant" in snapshot.manifest &&
				snapshot.manifest.manifest_variant === "land_v1";
			if (
				!source ||
				!current ||
				run.current_node_id !== input.nodeId ||
				(!authorityDrivenGate && current.execution_id !== input.executionId) ||
				current.state === "done"
			) {
				result = { ok: false, reason: "node_attempt_not_current" };
				return;
			}
			const priorEdges = this.workflowSelectAll(
				`SELECT payload FROM workflow_run_event
				  WHERE run_id = ? AND node_id = ? AND kind = 'edge_traversed'`,
				[input.runId, input.nodeId],
			).some((row) => {
				try {
					return (
						(JSON.parse(row.payload as string) as { sourceAttempt?: unknown })
							.sourceAttempt === input.attempt
					);
				} catch {
					return true;
				}
			});
			if (priorEdges) {
				result = { ok: false, reason: "transition_conflict" };
				return;
			}

			const edge = snapshot.manifest.edges.find(
				(candidate) =>
					candidate.from === input.nodeId &&
					candidate.condition === input.outcome,
			);
			const loop = snapshot.manifest.loops.find(
				(candidate) =>
					candidate.from === input.nodeId &&
					candidate.loop_when === input.outcome,
			);
			if ((edge ? 1 : 0) + (loop ? 1 : 0) !== 1) {
				result = { ok: false, reason: "illegal_transition" };
				return;
			}
			const selected = edge ?? loop!;
			const target = snapshot.resolved.nodes.find(
				(node) => node.id === selected.to,
			);
			if (!target) {
				result = { ok: false, reason: "transition_target_missing" };
				return;
			}
			const targetAttempts = this.listWorkflowRunNodes(input.runId, target.id);
			const targetAttempt =
				targetAttempts.reduce(
					(max, candidate) => Math.max(max, candidate.attempt),
					0,
				) + 1;
			const loopIteration = loop
				? Number(
						this.workflowSelectAll(
							`SELECT COUNT(*) AS n FROM workflow_run_event
							  WHERE run_id = ? AND kind = 'loop_iteration' AND edge_id = ?`,
							[input.runId, loop.id],
						)[0]?.n ?? 0,
					) + 1
				: undefined;
			if (loop && loopIteration! > loop.max_iterations) {
				this.upsertWorkflowRunNodeTx({
					runId: input.runId,
					nodeId: input.nodeId,
					attempt: input.attempt,
					state: "done",
					executionId: input.executionId,
					endedAt: now,
				});
				this.db.run(
					"UPDATE workflow_run SET status = 'held' WHERE run_id = ? AND status = 'active'",
					[input.runId],
				);
				this.appendWorkflowRunEventTx({
					runId: input.runId,
					eventUid: transitionUid,
					kind: "loop_limit_escalated",
					nodeId: input.nodeId,
					edgeId: loop.id,
					executionId: input.executionId,
					payload: {
						edgeId: loop.id,
						targetNodeId: target.id,
						targetAttempt,
						sourceAttempt: input.attempt,
						outcome: input.outcome,
						attempt: input.attempt,
						iteration: loopIteration,
						loopIteration,
						maxIterations: loop.max_iterations,
						onLimit: loop.on_limit,
						escalated: true,
					},
				});
				result = {
					ok: true,
					idempotentReplay: false,
					edgeId: loop.id,
					targetNodeId: target.id,
					targetAttempt,
					loopIteration,
					escalated: true,
				};
				return;
			}
			const successorExecutionId =
				target.type === "gate"
					? undefined
					: (input.successorExecutionId ?? randomUUID());

			this.upsertWorkflowRunNodeTx({
				runId: input.runId,
				nodeId: input.nodeId,
				attempt: input.attempt,
				state: "done",
				...(source.type === "gate" ? {} : { executionId: input.executionId }),
				endedAt: now,
			});
			this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid:
					input.nodeCompletionEventUid ??
					`engine_node_completed:${input.runId}:${input.nodeId}:${input.attempt}`,
				kind: "node_completed",
				nodeId: input.nodeId,
				executionId: input.executionId,
				payload: { attempt: input.attempt, outcome: input.outcome },
			});
			if (loop) {
				this.appendWorkflowRunEventTx({
					runId: input.runId,
					eventUid: `loop_iteration:${transitionUid}`,
					kind: "loop_iteration",
					nodeId: input.nodeId,
					edgeId: loop.id,
					executionId: input.executionId,
					payload: {
						iteration: loopIteration,
						maxIterations: loop.max_iterations,
					},
				});
			}
			const receipt = {
				edgeId: selected.id,
				targetNodeId: target.id,
				targetAttempt,
				sourceAttempt: input.attempt,
				outcome: input.outcome,
				...(successorExecutionId ? { successorExecutionId } : {}),
				...(loopIteration ? { loopIteration } : {}),
				...(target.type === "gate" ? { gateOpened: true } : {}),
				...(input.founderFeedback
					? { founderFeedback: input.founderFeedback.slice(0, 4_000) }
					: {}),
			};
			this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: transitionUid,
				kind: "edge_traversed",
				nodeId: input.nodeId,
				edgeId: selected.id,
				executionId: input.executionId,
				payload: receipt,
			});
			if (target.type === "gate") {
				this.upsertWorkflowRunNodeTx({
					runId: input.runId,
					nodeId: target.id,
					attempt: targetAttempt,
					state: "review",
				});
				this.appendWorkflowRunEventTx({
					runId: input.runId,
					eventUid: `gate_opened:${input.runId}:${target.id}:${targetAttempt}`,
					kind: "gate_opened",
					nodeId: target.id,
					payload: {
						attempt: targetAttempt,
						predicate: workflowApprovalGate(snapshot.manifest).predicate,
					},
				});
				if (
					snapshot.schema_version === 1 &&
					"manifest_variant" in snapshot.manifest &&
					snapshot.manifest.manifest_variant === "land_v1"
				) {
					if (
						source.type !== "qa" ||
						!/^[0-9a-f]{40}$/i.test(input.subjectDigest ?? "")
					) {
						throw new Error("land_gate_holder_requires_qa_head");
					}
					const head = input.subjectDigest!.toLowerCase();
					const questionId = `workflow-gate:${canonicalSubmissionDigest({
						runId: input.runId,
						gateNodeId: target.id,
						attempt: targetAttempt,
						head,
					})}`;
					this.db.run(
						`UPDATE workflow_gate_holder
						    SET state = 'superseded', superseded_reason = 'new_gate_attempt', updated_at = ?
						  WHERE run_id = ? AND gate_node_id = ?
						    AND state IN ('materializing','awaiting_review','approved')`,
						[now, input.runId, target.id],
					);
					this.db.run(
						`INSERT INTO workflow_gate_holder
						   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
						    question_id, state, materialization_stage, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, 'materializing', 'question_intent', ?, ?)`,
						[
							input.runId,
							target.id,
							targetAttempt,
							head,
							input.executionId,
							questionId,
							now,
							now,
						],
					);
					this.appendWorkflowRunEventTx({
						runId: input.runId,
						eventUid: `gate_holder:${questionId}`,
						kind: "gate_holder_created",
						nodeId: target.id,
						executionId: input.executionId,
						payload: { attempt: targetAttempt, questionId, head },
					});
				}
			} else {
				const ordinal = this.allocateWorkflowLaunchOrdinalTx(
					input.runId,
					target.id,
					targetAttempt,
					successorExecutionId!,
				);
				this.upsertWorkflowRunNodeTx({
					runId: input.runId,
					nodeId: target.id,
					attempt: targetAttempt,
					state: "pending",
					executionId: successorExecutionId!,
				});
				this.appendWorkflowRunEventTx({
					runId: input.runId,
					eventUid: `engine_dispatch_intent:${input.runId}:${target.id}:${targetAttempt}`,
					kind: "node_dispatched",
					nodeId: target.id,
					executionId: successorExecutionId!,
					payload: { attempt: targetAttempt, via: "engine_intent", ordinal },
				});
			}
			this.db.run(
				"UPDATE workflow_run SET current_node_id = ? WHERE run_id = ?",
				[target.id, input.runId],
			);
			result = {
				ok: true,
				idempotentReplay: false,
				edgeId: selected.id,
				targetNodeId: target.id,
				targetAttempt,
				...(successorExecutionId ? { successorExecutionId } : {}),
				...(loopIteration ? { loopIteration } : {}),
				...(target.type === "gate" ? { gateOpened: true } : {}),
			};
		});
		this.save();
		return result;
	}

	upsertWorkflowRunNode(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		state: string;
		executionId?: string;
		endedAt?: string;
	}): void {
		this.db.run(
			`INSERT INTO workflow_run_node (run_id, node_id, attempt, state, execution_id, ended_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(run_id, node_id, attempt) DO UPDATE SET
				state = excluded.state,
				execution_id = COALESCE(excluded.execution_id, workflow_run_node.execution_id),
				ended_at = COALESCE(excluded.ended_at, workflow_run_node.ended_at)`,
			[
				input.runId,
				input.nodeId,
				input.attempt,
				input.state,
				input.executionId ?? null,
				input.endedAt ?? null,
			],
		);
		this.save();
	}

	getWorkflowRunNode(
		runId: string,
		nodeId: string,
		attempt: number,
	): WorkflowRunNodeRow | undefined {
		const rows = this.workflowSelectAll(
			"SELECT * FROM workflow_run_node WHERE run_id = ? AND node_id = ? AND attempt = ?",
			[runId, nodeId, attempt],
		);
		const r = rows[0];
		if (!r) return undefined;
		return {
			run_id: r.run_id as string,
			node_id: r.node_id as string,
			attempt: Number(r.attempt),
			state: r.state as string,
			execution_id: (r.execution_id as string) ?? null,
			started_at: r.started_at as string,
			ended_at: (r.ended_at as string) ?? null,
		};
	}

	listWorkflowRunNodes(runId: string, nodeId: string): WorkflowRunNodeRow[] {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_run_node
			  WHERE run_id = ? AND node_id = ?
			  ORDER BY attempt ASC`,
			[runId, nodeId],
		).map((row) => ({
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			state: row.state as string,
			execution_id: (row.execution_id as string) ?? null,
			started_at: row.started_at as string,
			ended_at: (row.ended_at as string) ?? null,
		}));
	}

	getWorkflowRunNodeForExecution(
		executionId: string,
	): WorkflowRunNodeRow | undefined {
		const row = this.workflowSelectAll(
			`SELECT * FROM workflow_run_node
			  WHERE execution_id = ?
			  ORDER BY attempt DESC LIMIT 1`,
			[executionId],
		)[0];
		if (!row) return undefined;
		return {
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			state: row.state as string,
			execution_id: (row.execution_id as string) ?? null,
			started_at: row.started_at as string,
			ended_at: (row.ended_at as string) ?? null,
		};
	}

	/** Append a run event (idempotent by event_uid; per-run monotonic seq). */
	appendWorkflowRunEvent(input: {
		runId: string;
		eventUid: string;
		kind: string;
		nodeId?: string;
		edgeId?: string;
		executionId?: string;
		payload?: unknown;
	}): { seq: number; deduped: boolean } {
		let result: { seq: number; deduped: boolean } | undefined;
		this.db.transaction(() => {
			result = this.appendWorkflowRunEventTx(input);
		});
		this.save();
		if (!result) throw new Error("workflow event append produced no result");
		return result;
	}

	/**
	 * Append an event with content-addressed replay semantics. A duplicate UID is
	 * idempotent only when every immutable event field is identical.
	 */
	appendWorkflowRunEventChecked(input: {
		runId: string;
		eventUid: string;
		kind: string;
		nodeId?: string;
		edgeId?: string;
		executionId?: string;
		payload?: unknown;
	}): { seq: number; deduped: boolean } {
		let result: { seq: number; deduped: boolean } | undefined;
		this.db.transaction(() => {
			result = this.appendWorkflowRunEventCheckedTx(input);
		});
		this.save();
		if (!result)
			throw new Error("workflow checked event append produced no result");
		return result;
	}

	private appendWorkflowRunEventCheckedTx(input: {
		runId: string;
		eventUid: string;
		kind: string;
		nodeId?: string;
		edgeId?: string;
		executionId?: string;
		payload?: unknown;
	}): { seq: number; deduped: boolean } {
		const existing = this.workflowSelectAll(
			`SELECT run_id, seq, kind, node_id, edge_id, execution_id, payload
			   FROM workflow_run_event WHERE event_uid = ?`,
			[input.eventUid],
		)[0];
		if (!existing) return this.appendWorkflowRunEventTx(input);
		let existingPayload: unknown = null;
		try {
			existingPayload = existing.payload
				? JSON.parse(existing.payload as string)
				: null;
		} catch {
			throw new Error(`workflow_event_uid_conflict:${input.eventUid}`);
		}
		const matches =
			existing.run_id === input.runId &&
			existing.kind === input.kind &&
			(existing.node_id ?? null) === (input.nodeId ?? null) &&
			(existing.edge_id ?? null) === (input.edgeId ?? null) &&
			(existing.execution_id ?? null) === (input.executionId ?? null) &&
			canonicalSubmissionDigest(existingPayload) ===
				canonicalSubmissionDigest(input.payload ?? null);
		if (!matches) {
			throw new Error(`workflow_event_uid_conflict:${input.eventUid}`);
		}
		return { seq: Number(existing.seq), deduped: true };
	}

	/** Transaction body — callers already inside a transaction use this. */
	private appendWorkflowRunEventTx(input: {
		runId: string;
		eventUid: string;
		kind: string;
		nodeId?: string;
		edgeId?: string;
		executionId?: string;
		payload?: unknown;
	}): { seq: number; deduped: boolean } {
		const run = this.workflowSelectAll(
			"SELECT run_id FROM workflow_run WHERE run_id = ?",
			[input.runId],
		);
		if (run.length === 0) {
			throw new Error(`workflow run not found: ${input.runId}`);
		}
		const existing = this.workflowSelectAll(
			"SELECT seq FROM workflow_run_event WHERE event_uid = ?",
			[input.eventUid],
		);
		const first = existing[0];
		if (first) return { seq: Number(first.seq), deduped: true };
		const next = this.workflowSelectAll(
			"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM workflow_run_event WHERE run_id = ?",
			[input.runId],
		);
		const seq = Number(next[0]?.next ?? 1);
		this.db.run(
			`INSERT INTO workflow_run_event
			   (run_id, seq, event_uid, kind, node_id, edge_id, execution_id, payload)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				input.runId,
				seq,
				input.eventUid,
				input.kind,
				input.nodeId ?? null,
				input.edgeId ?? null,
				input.executionId ?? null,
				input.payload !== undefined ? JSON.stringify(input.payload) : null,
			],
		);
		return { seq, deduped: false };
	}

	listWorkflowRunEvents(runId: string): WorkflowRunEventRow[] {
		return this.workflowSelectAll(
			"SELECT * FROM workflow_run_event WHERE run_id = ? ORDER BY seq",
			[runId],
		).map((r) => ({
			run_id: r.run_id as string,
			seq: Number(r.seq),
			event_uid: r.event_uid as string,
			kind: r.kind as string,
			node_id: (r.node_id as string) ?? null,
			edge_id: (r.edge_id as string) ?? null,
			execution_id: (r.execution_id as string) ?? null,
			payload: r.payload ? JSON.parse(r.payload as string) : undefined,
			at: r.at as string,
		}));
	}

	/**
	 * Issue a ONE-SHOT decision capability bound to a node ATTEMPT (plan §2.2).
	 * The plaintext token is returned ONCE (Bridge memory only); the DB stores
	 * its hash. Issuing attempt N revokes older unconsumed tickets for the same
	 * node; an attempt at or below one already decided/superseded is refused.
	 */
	issueWorkflowDecisionCapability(input: {
		runId: string;
		nodeId: string;
		executionId: string;
		attempt: number;
		allowedPredicateFamily: string;
		manifestRevision?: number;
		evidenceSchemaVersion?: number;
		expectedSubjectDigest?: string;
		expiresAt: string;
		absoluteDeadlineAt: string;
	}): WorkflowCapabilityIssueResult {
		if (
			!(RUNNER_CAPABILITY_FAMILIES as readonly string[]).includes(
				input.allowedPredicateFamily,
			)
		) {
			return { ok: false, reason: "invalid_family" };
		}
		if (
			!StateStore.workflowFiniteTimestamp(input.expiresAt) ||
			!StateStore.workflowFiniteTimestamp(input.absoluteDeadlineAt)
		) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		// The absolute deadline caps RENEWALS — it must cap issuance too, or the
		// initial grant could overshoot the ceiling renewals enforce.
		if (Date.parse(input.expiresAt) > Date.parse(input.absoluteDeadlineAt)) {
			return { ok: false, reason: "expiry_beyond_deadline" };
		}
		let result: WorkflowCapabilityIssueResult = {
			ok: false,
			reason: "run_not_found",
		};
		this.db.transaction(() => {
			const run = this.workflowSelectAll(
				"SELECT run_id FROM workflow_run WHERE run_id = ?",
				[input.runId],
			);
			if (run.length === 0) {
				result = { ok: false, reason: "run_not_found" };
				return;
			}
			const siblings = this.workflowSelectAll(
				"SELECT attempt, consumed_at, revoked FROM workflow_decision_capability WHERE run_id = ? AND node_id = ?",
				[input.runId, input.nodeId],
			);
			const stale = siblings.some(
				(s) =>
					(s.consumed_at != null && Number(s.attempt) >= input.attempt) ||
					(s.consumed_at == null &&
						Number(s.revoked) === 0 &&
						Number(s.attempt) > input.attempt),
			);
			if (stale) {
				result = { ok: false, reason: "stale_attempt" };
				return;
			}
			this.db.run(
				`UPDATE workflow_decision_capability SET revoked = 1, revoked_reason = ?
				  WHERE run_id = ? AND node_id = ? AND consumed_at IS NULL AND revoked = 0 AND attempt <= ?`,
				[
					`superseded_by_attempt_${input.attempt}`,
					input.runId,
					input.nodeId,
					input.attempt,
				],
			);
			const token = generateCapabilityToken();
			const tokenHash = hashCapabilityToken(token);
			this.db.run(
				`INSERT INTO workflow_decision_capability
				   (token_hash, run_id, node_id, execution_id, attempt, allowed_predicate_family,
				    manifest_revision, evidence_schema_version, expected_subject_digest,
				    expires_at, absolute_deadline_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					tokenHash,
					input.runId,
					input.nodeId,
					input.executionId,
					input.attempt,
					input.allowedPredicateFamily,
					input.manifestRevision ?? null,
					input.evidenceSchemaVersion ?? 1,
					input.expectedSubjectDigest ?? null,
					input.expiresAt,
					input.absoluteDeadlineAt,
				],
			);
			const idRow = this.workflowSelectAll(
				"SELECT id FROM workflow_decision_capability WHERE token_hash = ?",
				[tokenHash],
			);
			result = { ok: true, capabilityId: Number(idRow[0]?.id), token };
		});
		this.save();
		return result;
	}

	getWorkflowDecisionCapability(
		capabilityId: number,
	): WorkflowDecisionCapabilityRow | undefined {
		const rows = this.workflowSelectAll(
			"SELECT * FROM workflow_decision_capability WHERE id = ?",
			[capabilityId],
		);
		const r = rows[0];
		if (!r) return undefined;
		return {
			id: Number(r.id),
			token_hash: r.token_hash as string,
			run_id: r.run_id as string,
			node_id: r.node_id as string,
			execution_id: r.execution_id as string,
			attempt: Number(r.attempt),
			allowed_predicate_family: r.allowed_predicate_family as string,
			manifest_revision:
				r.manifest_revision == null ? null : Number(r.manifest_revision),
			evidence_schema_version: Number(r.evidence_schema_version),
			expected_subject_digest: (r.expected_subject_digest as string) ?? null,
			issued_at: r.issued_at as string,
			expires_at: r.expires_at as string,
			absolute_deadline_at: r.absolute_deadline_at as string,
			consumed_at: (r.consumed_at as string) ?? null,
			consumed_claim_id:
				r.consumed_claim_id == null ? null : Number(r.consumed_claim_id),
			revoked: Number(r.revoked),
			revoked_reason: (r.revoked_reason as string) ?? null,
		};
	}

	/**
	 * Heartbeat renewal (plan §2.2): extend expiry but NEVER past the absolute
	 * deadline — a hijacked live session cannot keep itself alive forever.
	 */
	renewWorkflowDecisionCapability(input: {
		capabilityId: number;
		requestedExpiresAt: string;
		now?: string;
	}): WorkflowCapabilityRenewalResult {
		const nowIso = input.now ?? new Date().toISOString();
		if (
			!StateStore.workflowFiniteTimestamp(input.requestedExpiresAt) ||
			!StateStore.workflowFiniteTimestamp(nowIso)
		) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		let result: WorkflowCapabilityRenewalResult = {
			ok: false,
			reason: "capability_not_found",
		};
		this.db.transaction(() => {
			const cap = this.workflowSelectAll(
				"SELECT * FROM workflow_decision_capability WHERE id = ?",
				[input.capabilityId],
			)[0];
			if (!cap) {
				result = { ok: false, reason: "capability_not_found" };
				return;
			}
			if (cap.consumed_at != null) {
				result = { ok: false, reason: "capability_consumed" };
				return;
			}
			if (Number(cap.revoked) === 1) {
				result = { ok: false, reason: "capability_revoked" };
				return;
			}
			if (StateStore.workflowExpired(cap.expires_at as string, nowIso)) {
				result = { ok: false, reason: "capability_expired" };
				return;
			}
			const deadline = cap.absolute_deadline_at as string;
			const chosen =
				Date.parse(input.requestedExpiresAt) > Date.parse(deadline)
					? deadline
					: input.requestedExpiresAt;
			this.db.run(
				"UPDATE workflow_decision_capability SET expires_at = ? WHERE id = ?",
				[chosen, input.capabilityId],
			);
			result = { ok: true, expiresAt: chosen };
		});
		this.save();
		return result;
	}

	/**
	 * THE single-transaction submission (plan §2.2): validate the capability →
	 * write the claim → consume the capability → append the run event. Any
	 * refusal leaves NOTHING behind (no "evidence-looking" partial rows).
	 * Idempotent replay: a consumed capability + byte-identical payload returns
	 * the already-created claim; anything else is fail-closed (E3).
	 *
	 * E6 CONTRACT — vendor fields are SERVER-RESOLVED families, never
	 * self-reports (umbrella plan §3.1-3): `issuerVendor` and
	 * `subjectProducerVendor` MUST be the family the Bridge resolved from the
	 * session's persisted adapter_type via `adapterTypeToFamily` (the same
	 * vocabulary `crossFamilyReviewSatisfied` consumes — FLY-1188). Passing a
	 * manifest value or a runner's self-declared vendor here silently disarms
	 * the cross-vendor gate. The claim-layer same-vendor check below is the
	 * SECOND gate; admission-time family verification is the first (sub-issue
	 * B/D wiring).
	 */
	submitWorkflowDecisionClaim(input: {
		token: string;
		clientRequestId: string;
		predicate: string;
		subjectKind: string;
		/** Server-derived subject (plan §2.1 subject_resolver) — the Bridge
		 * captures this; a runner's self-report is only ever compared. */
		subjectDigest: string;
		/** Server-resolved family of the CLAIMING session (see E6 CONTRACT). */
		issuerVendor: string;
		issuerModel: string;
		subjectProducerExecutionId?: string;
		/** Server-resolved family of the PRODUCING session (see E6 CONTRACT). */
		subjectProducerVendor?: string;
		claimExpiresAt?: string;
		evidence?: unknown;
		now?: string;
	}): WorkflowClaimSubmissionResult {
		const nowIso = input.now ?? new Date().toISOString();
		if (
			!StateStore.workflowFiniteTimestamp(nowIso) ||
			(input.claimExpiresAt !== undefined &&
				!StateStore.workflowFiniteTimestamp(input.claimExpiresAt))
		) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		const digest = canonicalSubmissionDigest({
			clientRequestId: input.clientRequestId,
			predicate: input.predicate,
			subjectKind: input.subjectKind,
			subjectDigest: input.subjectDigest,
			issuerVendor: input.issuerVendor,
			issuerModel: input.issuerModel,
			subjectProducerExecutionId: input.subjectProducerExecutionId ?? null,
			subjectProducerVendor: input.subjectProducerVendor ?? null,
			claimExpiresAt: input.claimExpiresAt ?? null,
			evidence: input.evidence ?? null,
		});
		let result: WorkflowClaimSubmissionResult = {
			ok: false,
			reason: "capability_not_found",
		};
		this.db.transaction(() => {
			const cap = this.workflowSelectAll(
				"SELECT * FROM workflow_decision_capability WHERE token_hash = ?",
				[hashCapabilityToken(input.token)],
			)[0];
			if (!cap) {
				result = { ok: false, reason: "capability_not_found" };
				return;
			}
			if (cap.consumed_at != null) {
				const prior =
					cap.consumed_claim_id == null
						? undefined
						: this.getWorkflowClaim(Number(cap.consumed_claim_id));
				if (
					prior &&
					prior.submission_digest === digest &&
					prior.client_request_id === input.clientRequestId
				) {
					result = {
						ok: true,
						claimId: prior.id,
						serverSeq: prior.server_seq,
						idempotentReplay: true,
					};
				} else {
					result = { ok: false, reason: "replay_payload_mismatch" };
				}
				return;
			}
			if (Number(cap.revoked) === 1) {
				result = { ok: false, reason: "capability_revoked" };
				return;
			}
			if (StateStore.workflowExpired(cap.expires_at as string, nowIso)) {
				result = { ok: false, reason: "capability_expired" };
				return;
			}
			const family = cap.allowed_predicate_family as WorkflowDecisionFamily;
			const allowed = WORKFLOW_DECISION_FAMILIES[family] as
				| readonly string[]
				| undefined;
			if (!allowed || !allowed.includes(input.predicate)) {
				result = { ok: false, reason: "predicate_not_allowed" };
				return;
			}
			if (
				!(WORKFLOW_CLAIM_SUBJECT_KINDS as readonly string[]).includes(
					input.subjectKind,
				)
			) {
				result = { ok: false, reason: "subject_kind_invalid" };
				return;
			}
			if (
				cap.expected_subject_digest != null &&
				cap.expected_subject_digest !== input.subjectDigest
			) {
				result = { ok: false, reason: "subject_mismatch" };
				return;
			}
			if (
				REVIEW_CLASS_PREDICATES.has(input.predicate as WorkflowClaimPredicate)
			) {
				if (!input.subjectProducerExecutionId || !input.subjectProducerVendor) {
					result = { ok: false, reason: "missing_subject_producer" };
					return;
				}
				if (input.issuerVendor === input.subjectProducerVendor) {
					result = { ok: false, reason: "same_vendor_review" };
					return;
				}
			}
			if (!input.claimExpiresAt) {
				result = { ok: false, reason: "missing_expiry" };
				return;
			}
			const run = this.getWorkflowRun(cap.run_id as string);
			if (!run) {
				result = { ok: false, reason: "run_not_found" };
				return;
			}
			const serverSeq = this.nextWorkflowClaimSeq();
			this.db.run(
				`INSERT INTO workflow_claims
				   (server_seq, issue_id, workflow_run_id, node_id, decision_kind, attempt, predicate,
				    issuer_kind, issuer_execution_id, issuer_node_id, issuer_vendor, issuer_model,
				    subject_producer_execution_id, subject_kind, subject_digest, expires_at, permanent,
				    submission_digest, client_request_id, evidence, authority_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'runner_node', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
				[
					serverSeq,
					run.issue_id,
					run.run_id,
					cap.node_id,
					family,
					cap.attempt,
					input.predicate,
					cap.execution_id,
					cap.node_id,
					input.issuerVendor,
					input.issuerModel,
					input.subjectProducerExecutionId ?? null,
					input.subjectKind,
					input.subjectDigest,
					input.claimExpiresAt,
					digest,
					input.clientRequestId,
					input.evidence !== undefined ? JSON.stringify(input.evidence) : null,
					String(cap.id),
				],
			);
			const claimId = this.workflowClaimIdBySeq(serverSeq);
			this.db.run(
				"UPDATE workflow_decision_capability SET consumed_at = ?, consumed_claim_id = ? WHERE id = ?",
				[nowIso, claimId, cap.id],
			);
			this.appendWorkflowRunEventTx({
				runId: run.run_id,
				eventUid: `claim_written:${cap.id}:${input.clientRequestId}`,
				kind: "claim_written",
				nodeId: cap.node_id as string,
				executionId: cap.execution_id as string,
				payload: {
					claimId,
					predicate: input.predicate,
					subjectDigest: input.subjectDigest,
				},
			});
			result = { ok: true, claimId, serverSeq, idempotentReplay: false };
		});
		this.save();
		return result;
	}

	/**
	 * System claims (plan §2.1/§2.3): qa_exempt is a Bridge POLICY claim bound
	 * to the run's snapshot digest; founder_approved arrives ONLY through the
	 * server-owned founder challenge, bound to a git head. The founder never
	 * holds a runner capability.
	 */
	appendWorkflowSystemClaim(input: {
		issuerKind: "bridge_policy" | "founder_challenge";
		runId: string;
		issueId: string;
		decisionKind: string;
		predicate: string;
		subjectKind: string;
		subjectDigest: string;
		nodeId?: string;
		attempt?: number;
		expiresAt?: string;
		permanent?: boolean;
		evidence?: unknown;
		authorityId: string;
	}): WorkflowSystemClaimResult {
		const allowed = SYSTEM_CLAIM_ALLOWLIST[input.issuerKind] as
			| readonly string[]
			| undefined;
		if (!allowed || !allowed.includes(input.predicate)) {
			return { ok: false, reason: "predicate_not_allowed_for_issuer" };
		}
		if (
			!(WORKFLOW_CLAIM_SUBJECT_KINDS as readonly string[]).includes(
				input.subjectKind,
			) ||
			(input.predicate === "founder_approved" &&
				input.subjectKind !== "git_head") ||
			(input.predicate === "qa_exempt" &&
				input.subjectKind !== "snapshot_digest")
		) {
			return { ok: false, reason: "subject_kind_invalid" };
		}
		const permanent = input.permanent === true;
		if (permanent === Boolean(input.expiresAt)) {
			return { ok: false, reason: "expiry_or_permanent_required" };
		}
		if (
			input.expiresAt !== undefined &&
			!StateStore.workflowFiniteTimestamp(input.expiresAt)
		) {
			return { ok: false, reason: "invalid_timestamp" };
		}
		let result: WorkflowSystemClaimResult = {
			ok: false,
			reason: "run_not_found",
		};
		this.db.transaction(() => {
			const run = this.workflowSelectAll(
				"SELECT run_id, issue_id FROM workflow_run WHERE run_id = ?",
				[input.runId],
			);
			const runRow = run[0];
			if (!runRow) {
				result = { ok: false, reason: "run_not_found" };
				return;
			}
			// Issue identity comes from the RUN row (research §B.6): the caller's
			// issueId is only ever CHECKED against it — a divergent claim about
			// some other issue must not be persistable through this path.
			const runIssueId = runRow.issue_id as string;
			if (input.issueId !== runIssueId) {
				result = { ok: false, reason: "issue_mismatch" };
				return;
			}
			const serverSeq = this.nextWorkflowClaimSeq();
			this.db.run(
				`INSERT INTO workflow_claims
				   (server_seq, issue_id, workflow_run_id, node_id, decision_kind, attempt, predicate,
				    issuer_kind, subject_kind, subject_digest, expires_at, permanent, evidence, authority_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					serverSeq,
					runIssueId,
					input.runId,
					input.nodeId ?? null,
					input.decisionKind,
					input.attempt ?? null,
					input.predicate,
					input.issuerKind,
					input.subjectKind,
					input.subjectDigest,
					input.expiresAt ?? null,
					permanent ? 1 : 0,
					input.evidence !== undefined ? JSON.stringify(input.evidence) : null,
					input.authorityId,
				],
			);
			const claimId = this.workflowClaimIdBySeq(serverSeq);
			this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: `system_claim:${input.issuerKind}:${input.authorityId}:${serverSeq}`,
				kind: "claim_written",
				nodeId: input.nodeId,
				payload: { claimId, predicate: input.predicate },
			});
			result = { ok: true, claimId, serverSeq };
		});
		this.save();
		return result;
	}

	/**
	 * Apply one immutable CommDB source event to the workflow ledger. Receipt
	 * and founder claim commit together; exact replay returns the original
	 * claim id, while a same-id/different-digest replay is terminal poison.
	 */
	applyWorkflowSourceEvent(
		input: WorkflowSourceEventInput,
	): WorkflowSourceApplyResult {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(input.payloadJson) as Record<string, unknown>;
		} catch {
			throw new Error("workflow source payload malformed");
		}
		if (
			input.schemaVersion !== 1 ||
			payload.schema_version !== 1 ||
			canonicalSubmissionDigest(payload) !== input.payloadDigest
		) {
			throw new Error("workflow source payload digest mismatch (poison)");
		}

		let result: WorkflowSourceApplyResult | undefined;
		this.db.transaction(() => {
			const targetRunId =
				input.kind === "turn_grant" && payload.target_run_id !== null
					? typeof payload.target_run_id === "string"
						? payload.target_run_id
						: "__invalid__"
					: null;
			const existing = this.workflowSelectAll(
				`SELECT payload_digest, claim_id FROM workflow_source_receipt
				  WHERE project = ? AND source_event_id = ?`,
				[input.project, input.sourceEventId],
			)[0];
			if (existing) {
				if (existing.payload_digest !== input.payloadDigest) {
					throw new Error("workflow source receipt digest mismatch (poison)");
				}
				result =
					input.kind === "founder_approval"
						? {
								kind: "founder_claim",
								status: "replayed",
								claimId: Number(existing.claim_id),
							}
						: input.kind === "founder_feedback"
							? { kind: "founder_feedback", status: "replayed" }
							: targetRunId
								? { kind: "turn_run_event", status: "replayed" }
								: { kind: "turn_project_history", status: "replayed" };
				return;
			}

			if (input.kind === "turn_grant") {
				if (targetRunId === "__invalid__") {
					throw new Error("TURN source payload invalid: target_run_id");
				}
				let turnBinding: WorkflowExecutionBindingRow | undefined;
				if (targetRunId) {
					const issueId =
						typeof payload.issue_id === "string" ? payload.issue_id : "";
					const newHolder =
						typeof payload.new_holder === "string" ? payload.new_holder : "";
					const toRole =
						typeof payload.to_role === "string" ? payload.to_role : "";
					const run = this.getWorkflowRun(targetRunId);
					turnBinding = this.getWorkflowExecutionBinding(newHolder);
					const context = turnBinding
						? this.generalizedExecutionContext(newHolder)
						: undefined;
					if (
						!run ||
						run.engine_owned !== 1 ||
						run.project_name !== input.project ||
						run.issue_id !== issueId ||
						!turnBinding ||
						turnBinding.run_id !== targetRunId ||
						context?.node.type !== toRole
					) {
						throw new Error(
							"TURN source payload invalid: run ownership mismatch",
						);
					}
				}
				this.db.run(
					`INSERT INTO workflow_source_receipt
					   (project, source_event_id, payload_digest, claim_id, applied_at)
					 VALUES (?, ?, ?, NULL, ?)`,
					[
						input.project,
						input.sourceEventId,
						input.payloadDigest,
						new Date().toISOString(),
					],
				);
				if (targetRunId && turnBinding) {
					this.appendWorkflowRunEventTx({
						runId: targetRunId,
						eventUid: `source_turn:${input.project}:${input.sourceEventId}`,
						kind: "turn_granted",
						nodeId: turnBinding.node_id,
						executionId: turnBinding.execution_id,
						payload: {
							attempt: turnBinding.attempt,
							fromRole: payload.from_role,
							toRole: payload.to_role,
							resultingEpoch: payload.resulting_epoch,
							sourceEventId: input.sourceEventId,
						},
					});
					result = { kind: "turn_run_event", status: "applied" };
				} else {
					result = { kind: "turn_project_history", status: "applied" };
				}
				return;
			}

			const runId = typeof payload.run_id === "string" ? payload.run_id : "";
			const issueId =
				typeof payload.issue_id === "string" ? payload.issue_id : "";
			const approvedHead =
				typeof payload.approved_head === "string" ? payload.approved_head : "";
			const authorityId =
				typeof payload.authority_id === "string" ? payload.authority_id : "";
			const response = payload.response as
				| { approved?: unknown; feedback?: unknown }
				| undefined;
			const run = this.getWorkflowRun(runId);
			if (!run) {
				throw new Error("workflow source run unavailable");
			}
			if (
				run.issue_id !== issueId ||
				run.project_name !== input.project ||
				typeof response?.approved !== "boolean" ||
				(input.kind === "founder_approval") !== (response.approved === true) ||
				!/^[0-9a-f]{40}$/.test(approvedHead) ||
				!authorityId
			) {
				throw new Error("founder decision source payload invalid");
			}

			if (input.kind === "founder_feedback") {
				if (
					typeof response.feedback !== "string" ||
					response.feedback.trim().length === 0 ||
					run.engine_owned !== 1 ||
					!run.snapshot ||
					run.status !== "active"
				) {
					throw new Error("founder feedback source payload invalid");
				}
				let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
				try {
					snapshot = parseWorkflowRunSnapshot(run.snapshot);
				} catch {
					throw new Error("founder feedback source payload invalid: snapshot");
				}
				if (
					!isWorkflowManifestV1Land(snapshot.manifest) ||
					run.current_node_id !== snapshot.manifest.approval_gate.node
				) {
					throw new Error("founder feedback source payload invalid: run state");
				}
				const questionId =
					typeof payload.question_id === "string" ? payload.question_id : "";
				const holder = this.workflowSelectAll(
					`SELECT * FROM workflow_gate_holder
					  WHERE question_id = ? AND run_id = ? AND gate_node_id = ?`,
					[questionId, runId, snapshot.manifest.approval_gate.node],
				)[0];
				if (
					!holder ||
					holder.state !== "awaiting_review" ||
					holder.head_sha !== approvedHead ||
					!holder.card_message_id
				) {
					throw new Error(
						"founder feedback source payload invalid: gate holder",
					);
				}
				const now = new Date().toISOString();
				this.db.run(
					`UPDATE workflow_gate_holder
					    SET state = 'superseded', superseded_reason = 'founder_feedback', updated_at = ?
					  WHERE question_id = ? AND state = 'awaiting_review'`,
					[now, questionId],
				);
				if (this.db.getRowsModified() !== 1) {
					throw new Error(
						"founder feedback source payload invalid: holder raced",
					);
				}
				const transition = this.commitWorkflowTransitionTx({
					runId,
					nodeId: snapshot.manifest.approval_gate.node,
					attempt: Number(holder.attempt),
					executionId: holder.source_execution_id as string,
					outcome: "founder_feedback_kickback",
					subjectDigest: approvedHead,
					founderFeedback: response.feedback.trim(),
					now,
				});
				if (!transition.ok || transition.targetNodeId !== "implement") {
					throw new Error(
						`founder feedback kickback failed: ${transition.ok ? "wrong_target" : transition.reason}`,
					);
				}
				this.db.run(
					`INSERT INTO workflow_source_receipt
					   (project, source_event_id, payload_digest, claim_id, applied_at)
					 VALUES (?, ?, ?, NULL, ?)`,
					[input.project, input.sourceEventId, input.payloadDigest, now],
				);
				this.appendWorkflowRunEventTx({
					runId,
					eventUid: `source_feedback:${input.project}:${input.sourceEventId}`,
					kind: "founder_feedback_kickback",
					nodeId: snapshot.manifest.approval_gate.node,
					executionId: holder.source_execution_id as string,
					payload: {
						questionId,
						head: approvedHead,
						targetNodeId: transition.targetNodeId,
						targetAttempt: transition.targetAttempt,
					},
				});
				result = { kind: "founder_feedback", status: "applied" };
				return;
			}

			const serverSeq = this.nextWorkflowClaimSeq();
			this.db.run(
				`INSERT INTO workflow_claims
				   (server_seq, issue_id, workflow_run_id, node_id, decision_kind, attempt,
				    predicate, issuer_kind, subject_kind, subject_digest, expires_at,
				    permanent, evidence, authority_id)
				 VALUES (?, ?, ?, NULL, 'founder_decision', NULL, 'founder_approved',
				         'founder_challenge', 'git_head', ?, NULL, 1, ?, ?)`,
				[
					serverSeq,
					issueId,
					runId,
					approvedHead,
					JSON.stringify({
						questionId: payload.question_id,
						actor: payload.actor,
						classification: payload.classification,
					}),
					authorityId,
				],
			);
			const claimId = this.workflowClaimIdBySeq(serverSeq);
			this.appendWorkflowRunEventTx({
				runId,
				eventUid: `source_claim:${input.project}:${input.sourceEventId}`,
				kind: "claim_written",
				payload: { claimId, predicate: "founder_approved" },
			});
			this.db.run(
				`INSERT INTO workflow_source_receipt
				   (project, source_event_id, payload_digest, claim_id, applied_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[
					input.project,
					input.sourceEventId,
					input.payloadDigest,
					claimId,
					new Date().toISOString(),
				],
			);
			if (run.engine_owned === 1 && run.snapshot && run.status === "active") {
				let snapshot: ReturnType<typeof parseWorkflowRunSnapshot> | undefined;
				try {
					snapshot = parseWorkflowRunSnapshot(run.snapshot);
				} catch {
					throw new Error("founder approval source payload invalid: snapshot");
				}
				// Generalized/product v2 has no PR merge tail: its founder source is
				// the sole terminal entry. Engineering v1 remains merge-gated by the
				// Bridge composite seam and must not complete merely on approval.
				if (
					isWorkflowManifestV1Land(snapshot.manifest) &&
					run.current_node_id === snapshot.manifest.approval_gate.node
				) {
					const questionId =
						typeof payload.question_id === "string" ? payload.question_id : "";
					const holder = this.workflowSelectAll(
						`SELECT * FROM workflow_gate_holder
						  WHERE question_id = ? AND run_id = ? AND gate_node_id = ?`,
						[questionId, runId, snapshot.manifest.approval_gate.node],
					)[0];
					if (
						!holder ||
						holder.state !== "awaiting_review" ||
						holder.head_sha !== approvedHead ||
						!holder.card_message_id
					) {
						throw new Error(
							"founder approval source payload invalid: gate holder",
						);
					}
					this.db.run(
						`UPDATE workflow_gate_holder
						    SET state = 'approved', materialization_stage = 'completed', updated_at = ?
						  WHERE question_id = ? AND state = 'awaiting_review'`,
						[new Date().toISOString(), questionId],
					);
					if (this.db.getRowsModified() !== 1) {
						throw new Error(
							"founder approval source payload invalid: holder raced",
						);
					}
					const transition = this.commitWorkflowTransitionTx({
						runId,
						nodeId: snapshot.manifest.approval_gate.node,
						attempt: Number(holder.attempt),
						executionId: holder.source_execution_id as string,
						outcome: "founder_approved",
						subjectDigest: approvedHead,
						now: new Date().toISOString(),
					});
					if (!transition.ok || transition.targetNodeId !== "land") {
						throw new Error(
							`founder approval source land activation failed: ${transition.ok ? "wrong_target" : transition.reason}`,
						);
					}
					this.appendWorkflowRunEventTx({
						runId,
						eventUid: `land_activated:${input.project}:${input.sourceEventId}`,
						kind: "land_activated",
						nodeId: transition.targetNodeId,
						payload: {
							questionId,
							head: approvedHead,
							attempt: transition.targetAttempt,
						},
					});
				} else if (
					snapshot.schema_version === 2 &&
					run.current_node_id === snapshot.manifest.terminal_gate.node
				) {
					const ship = this.resolveEngineWorkflowShipClaims({
						runId,
						subjectDigest: approvedHead,
					});
					if (ship.valid) {
						this.db.run(
							`UPDATE workflow_run SET status = 'completed'
							  WHERE run_id = ? AND status = 'active' AND current_node_id = ?`,
							[runId, snapshot.manifest.terminal_gate.node],
						);
						if (this.db.getRowsModified() === 1) {
							this.appendWorkflowRunEventTx({
								runId,
								eventUid: `source_terminal:${input.project}:${input.sourceEventId}`,
								kind: "run_completed",
								nodeId: snapshot.manifest.terminal_gate.node,
								payload: {
									predicate: "founder_approved",
									subjectDigest: approvedHead,
								},
							});
						}
					}
				}
			}
			result = { kind: "founder_claim", status: "applied", claimId };
		});
		this.save();
		if (!result) throw new Error("workflow source apply produced no result");
		return result;
	}

	recordWorkflowSourceDeadletter(input: {
		project: string;
		sourceEventId: string;
		reason: string;
	}): void {
		this.db.run(
			`INSERT OR IGNORE INTO workflow_source_deadletter
			   (project, source_event_id, reason, at) VALUES (?, ?, ?, ?)`,
			[
				input.project,
				input.sourceEventId,
				input.reason,
				new Date().toISOString(),
			],
		);
		this.save();
	}

	getWorkflowSourceDeadletter(
		project: string,
		sourceEventId: string,
	):
		| { project: string; source_event_id: string; reason: string; at: string }
		| undefined {
		return this.workflowSelectAll(
			`SELECT project, source_event_id, reason, at
			   FROM workflow_source_deadletter
			  WHERE project = ? AND source_event_id = ?`,
			[project, sourceEventId],
		)[0] as
			| { project: string; source_event_id: string; reason: string; at: string }
			| undefined;
	}

	getWorkflowSourceCursor(project: string): number {
		const row = this.workflowSelectAll(
			"SELECT last_row_id FROM workflow_source_cursor WHERE project = ?",
			[project],
		)[0];
		return Number(row?.last_row_id ?? 0);
	}

	advanceWorkflowSourceCursor(project: string, rowId: number): void {
		if (!Number.isInteger(rowId) || rowId < 0) {
			throw new Error("workflow source cursor row id invalid");
		}
		this.db.run(
			`INSERT INTO workflow_source_cursor (project, last_row_id, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(project) DO UPDATE SET
			   last_row_id = CASE
			     WHEN excluded.last_row_id > workflow_source_cursor.last_row_id
			     THEN excluded.last_row_id ELSE workflow_source_cursor.last_row_id END,
			   updated_at = excluded.updated_at`,
			[project, rowId, new Date().toISOString()],
		);
		this.save();
	}

	/** Revocation is itself append-only (plan §2.1 workflow_claim_revocation). */
	revokeWorkflowClaim(input: {
		claimId: number;
		reason: string;
		actor: string;
	}): void {
		this.db.transaction(() => {
			const claim = this.getWorkflowClaim(input.claimId);
			if (!claim) {
				throw new Error(`workflow claim not found: ${input.claimId}`);
			}
			this.db.run(
				"INSERT INTO workflow_claim_revocation (claim_id, reason, actor) VALUES (?, ?, ?)",
				[input.claimId, input.reason, input.actor],
			);
			const rev = this.workflowSelectAll(
				"SELECT MAX(id) AS id FROM workflow_claim_revocation WHERE claim_id = ?",
				[input.claimId],
			);
			this.appendWorkflowRunEventTx({
				runId: claim.workflow_run_id,
				eventUid: `claim_revoked:${input.claimId}:${Number(rev[0]?.id)}`,
				kind: "claim_revoked",
				nodeId: claim.node_id ?? undefined,
				payload: {
					claimId: input.claimId,
					reason: input.reason,
					actor: input.actor,
				},
			});
		});
		this.save();
	}

	getWorkflowClaim(claimId: number): WorkflowClaimRow | undefined {
		const rows = this.workflowSelectAll(
			"SELECT * FROM workflow_claims WHERE id = ?",
			[claimId],
		);
		const r = rows[0];
		if (!r) return undefined;
		return this.workflowClaimRowFromRaw(r);
	}

	countWorkflowClaims(runId: string): number {
		const rows = this.workflowSelectAll(
			"SELECT COUNT(*) AS n FROM workflow_claims WHERE workflow_run_id = ?",
			[runId],
		);
		return Number(rows[0]?.n ?? 0);
	}

	/**
	 * USE-time gate resolution (plan §2.1): among claims for
	 * (run, node, decision_kind) bound to the CURRENT subject, take the highest
	 * attempt (then server_seq); require it unexpired, unrevoked, unconflicted
	 * and passing. NEVER falls back to an older attempt — a superseded PASS is
	 * not evidence.
	 */
	resolveWorkflowDecisionClaim(input: {
		runId: string;
		nodeId?: string;
		decisionKind: string;
		/** Exact predicate required by the snapshot ship contract. */
		predicate?: string;
		/** Current logical node attempt; older evidence never carries forward. */
		requiredAttempt?: number;
		subjectKind: string;
		subjectDigest: string;
		now?: string;
	}): WorkflowClaimResolution {
		const nowIso = input.now ?? new Date().toISOString();
		if (!StateStore.workflowFiniteTimestamp(nowIso)) {
			return { valid: false, reason: "invalid_timestamp" };
		}
		const nodeClause = input.nodeId == null ? "node_id IS NULL" : "node_id = ?";
		const params: unknown[] = [
			input.runId,
			input.decisionKind,
			input.subjectKind,
			input.subjectDigest,
		];
		if (input.nodeId != null) params.push(input.nodeId);
		const rows = this.workflowSelectAll(
			`SELECT * FROM workflow_claims
			  WHERE workflow_run_id = ? AND decision_kind = ? AND subject_kind = ?
			    AND subject_digest = ? AND ${nodeClause}`,
			params,
		);
		if (rows.length === 0) return { valid: false, reason: "no_claim" };
		const attemptOf = (r: Record<string, unknown>): number =>
			r.attempt == null ? 0 : Number(r.attempt);
		const maxAttempt = Math.max(...rows.map(attemptOf));
		if (
			input.requiredAttempt !== undefined &&
			maxAttempt !== input.requiredAttempt
		) {
			return { valid: false, reason: "stale_attempt" };
		}
		const top = rows.filter((r) => attemptOf(r) === maxAttempt);
		const candidate = top.reduce((a, b) =>
			Number(a.server_seq) >= Number(b.server_seq) ? a : b,
		);
		if (top.some((r) => r.predicate !== candidate.predicate)) {
			return { valid: false, reason: "conflict" };
		}
		if (
			input.predicate !== undefined &&
			candidate.predicate !== input.predicate
		) {
			return { valid: false, reason: "predicate_mismatch" };
		}
		const revoked = this.workflowSelectAll(
			"SELECT 1 AS x FROM workflow_claim_revocation WHERE claim_id = ?",
			[Number(candidate.id)],
		);
		if (revoked.length > 0) return { valid: false, reason: "revoked" };
		if (
			Number(candidate.permanent) !== 1 &&
			StateStore.workflowExpired(candidate.expires_at as string, nowIso)
		) {
			return { valid: false, reason: "expired" };
		}
		if (
			!PASSING_PREDICATES.has(candidate.predicate as WorkflowClaimPredicate)
		) {
			return { valid: false, reason: "not_pass" };
		}
		return { valid: true, claim: this.workflowClaimRowFromRaw(candidate) };
	}

	/** Closed snapshot ship contract, resolved at USE time against one head. */
	resolveEngineWorkflowShipClaims(input: {
		runId: string;
		subjectDigest: string;
		now?: string;
	}): WorkflowShipClaimsResolution {
		const run = this.getWorkflowRun(input.runId);
		if (run?.engine_owned !== 1 || !run.snapshot) {
			return { valid: false, reason: "engine_run_unavailable" };
		}
		let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
		try {
			snapshot = parseWorkflowRunSnapshot(run.snapshot);
		} catch {
			return { valid: false, reason: "snapshot_invalid" };
		}
		for (const required of snapshot.manifest.ship_claims) {
			let nodeId: string | undefined;
			let decisionKind: string;
			let requiredAttempt: number | undefined;
			if (required === "qa_passed") {
				const nodes = snapshot.resolved.nodes.filter(
					(node) => node.type === "qa",
				);
				if (nodes.length !== 1) {
					return { valid: false, reason: "qa_claim_node_ambiguous" };
				}
				nodeId = nodes[0]!.id;
				decisionKind = "qa_verdict";
			} else if (required === "design_review_approved") {
				const nodes = snapshot.resolved.nodes.filter(
					(node) => node.type === "review",
				);
				if (nodes.length !== 1) {
					return { valid: false, reason: "review_claim_node_ambiguous" };
				}
				nodeId = nodes[0]!.id;
				decisionKind = "review_verdict";
			} else if (required === "founder_approved") {
				decisionKind = "founder_decision";
			} else {
				return {
					valid: false,
					reason: `unsupported_ship_claim:${required}`,
				};
			}
			if (nodeId) {
				requiredAttempt = this.listWorkflowRunNodes(input.runId, nodeId).at(
					-1,
				)?.attempt;
				if (requiredAttempt === undefined) {
					return {
						valid: false,
						reason: `${required}:attempt_unavailable`,
					};
				}
			}
			const resolved = this.resolveWorkflowDecisionClaim({
				runId: input.runId,
				...(nodeId && { nodeId }),
				decisionKind,
				predicate: required,
				...(requiredAttempt !== undefined && { requiredAttempt }),
				subjectKind: "git_head",
				subjectDigest: input.subjectDigest,
				now: input.now,
			});
			if (!resolved.valid) {
				return { valid: false, reason: `${required}:${resolved.reason}` };
			}
		}
		return { valid: true };
	}

	private nextWorkflowClaimSeq(): number {
		const rows = this.workflowSelectAll(
			"SELECT COALESCE(MAX(server_seq), 0) + 1 AS next FROM workflow_claims",
			[],
		);
		return Number(rows[0]?.next ?? 1);
	}

	private workflowClaimIdBySeq(serverSeq: number): number {
		const rows = this.workflowSelectAll(
			"SELECT id FROM workflow_claims WHERE server_seq = ?",
			[serverSeq],
		);
		return Number(rows[0]?.id);
	}

	private workflowClaimRowFromRaw(
		r: Record<string, unknown>,
	): WorkflowClaimRow {
		return {
			id: Number(r.id),
			server_seq: Number(r.server_seq),
			issued_at: r.issued_at as string,
			issue_id: r.issue_id as string,
			workflow_run_id: r.workflow_run_id as string,
			node_id: (r.node_id as string) ?? null,
			decision_kind: r.decision_kind as string,
			attempt: r.attempt == null ? null : Number(r.attempt),
			predicate: r.predicate as string,
			issuer_kind: r.issuer_kind as string,
			issuer_execution_id: (r.issuer_execution_id as string) ?? null,
			issuer_node_id: (r.issuer_node_id as string) ?? null,
			issuer_vendor: (r.issuer_vendor as string) ?? null,
			issuer_model: (r.issuer_model as string) ?? null,
			subject_producer_execution_id:
				(r.subject_producer_execution_id as string) ?? null,
			subject_kind: r.subject_kind as string,
			subject_digest: r.subject_digest as string,
			expires_at: (r.expires_at as string) ?? null,
			permanent: Number(r.permanent ?? 0),
			submission_digest: (r.submission_digest as string) ?? null,
			client_request_id: (r.client_request_id as string) ?? null,
			evidence: r.evidence ? JSON.parse(r.evidence as string) : undefined,
			authority_id: r.authority_id as string,
		};
	}

	// ── FLY-1232 module ②: shadow-run composite transaction + dispatch outbox ──
	// The shadow ledger observes the production pipeline (write path behind
	// FLYWHEEL_WORKFLOW_CLAIMS_WRITE); it is NOT authoritative — gates keep
	// reading their legacy sources until sub-issue B flips the read path.

	private migrateWorkflowShadowLedger(): void {
		// §2.4b dispatch outbox: the durable history of each PHYSICAL launch of a
		// (run, node, attempt). Row identity = (run, node, attempt, kind, ordinal);
		// every distinct execution_id gets its own row (writer-allocated ordinal,
		// design R3#2/R4#1) — history is never rewritten, replacements append.
		// kind keeps the umbrella's full CHECK vocabulary; sub-issue A only
		// ENABLES 'dispatch' at the API layer (materialize = sub-issue B).
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_side_effect_ledger (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('dispatch','materialize')),
				launch_ordinal INTEGER NOT NULL,
				execution_id TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN (
					'intent_recorded','launch_committed','started','abandoned')),
				reason TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				committed_at TEXT,
				started_at TEXT,
				abandoned_at TEXT,
				UNIQUE (run_id, node_id, attempt, kind, launch_ordinal)
			)
		`);
		// Row identity + execution binding are immutable (B7: a committed row's
		// execution_id is never rewritten) — only state/reason/timestamps move.
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_side_effect_identity_immutable
			BEFORE UPDATE OF run_id, node_id, attempt, kind, launch_ordinal, execution_id, created_at
			ON workflow_side_effect_ledger
			BEGIN SELECT RAISE(ABORT, 'workflow_side_effect_ledger identity is immutable'); END
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS workflow_materialization_receipt (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				effect_id TEXT NOT NULL,
				stage TEXT NOT NULL CHECK (stage IN
					('intent_pinned','commit_adopted','push_confirmed')),
				run_id TEXT,
				node_id TEXT,
				attempt INTEGER,
				output_id INTEGER,
				output_digest TEXT,
				repo TEXT,
				ref TEXT,
				base_head TEXT,
				tree_head TEXT,
				commit_head TEXT,
				remote_head TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				UNIQUE (effect_id, stage),
				CHECK (
					(stage = 'intent_pinned'
					 AND run_id IS NOT NULL AND node_id IS NOT NULL AND attempt > 0
					 AND output_id > 0 AND output_digest IS NOT NULL
					 AND repo IS NOT NULL AND ref IS NOT NULL AND base_head IS NOT NULL
					 AND tree_head IS NULL AND commit_head IS NULL AND remote_head IS NULL)
				 OR (stage = 'commit_adopted'
					 AND run_id IS NULL AND node_id IS NULL AND attempt IS NULL
					 AND output_id IS NULL AND output_digest IS NULL
					 AND repo IS NULL AND ref IS NULL AND base_head IS NULL
					 AND tree_head IS NOT NULL AND commit_head IS NOT NULL
					 AND remote_head IS NULL)
				 OR (stage = 'push_confirmed'
					 AND run_id IS NULL AND node_id IS NULL AND attempt IS NULL
					 AND output_id IS NULL AND output_digest IS NULL
					 AND repo IS NULL AND ref IS NULL AND base_head IS NULL
					 AND tree_head IS NULL AND commit_head IS NOT NULL
					 AND remote_head = commit_head)
				)
			)
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_materialization_receipt_no_update
			BEFORE UPDATE ON workflow_materialization_receipt
			BEGIN SELECT RAISE(ABORT, 'workflow_materialization_receipt is append-only'); END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS workflow_materialization_receipt_no_delete
			BEFORE DELETE ON workflow_materialization_receipt
			BEGIN SELECT RAISE(ABORT, 'workflow_materialization_receipt is append-only'); END
		`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_workflow_materialization_receipt_run ON workflow_materialization_receipt(run_id, node_id, attempt, stage)",
		);
		// Exactly ONE active shadow run per (project, issue) — DB-level guarantee
		// so "the ship left but a new workflow still appends to the old run" is
		// structurally impossible (finalization releases the slot).
		this.db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_run_active
			ON workflow_run(project_name, issue_id) WHERE status = 'active'
		`);
	}

	getActiveWorkflowRun(
		projectName: string,
		issueId: string,
	): WorkflowRunRow | undefined {
		const rows = this.workflowSelectAll(
			"SELECT run_id FROM workflow_run WHERE project_name = ? AND issue_id = ? AND status = 'active'",
			[projectName, issueId],
		);
		const r = rows[0];
		return r ? this.getWorkflowRun(r.run_id as string) : undefined;
	}

	listActiveWorkflowRuns(): WorkflowRunRow[] {
		return this.workflowSelectAll(
			"SELECT run_id FROM workflow_run WHERE status = 'active'",
			[],
		)
			.map((r) => this.getWorkflowRun(r.run_id as string))
			.filter((r): r is WorkflowRunRow => r !== undefined);
	}

	/**
	 * FLY-1424: active engineering runs whose v1 terminal gate is waiting for
	 * founder ship approval. Delivery-path facts are projected independently so
	 * one successful arm never hides the other arm's unfinished work.
	 */
	listWorkflowShipReadyGates(input: {
		now: string;
	}): WorkflowShipReadyNotice[] {
		const rows = this.listWorkflowShipReadyCandidates(input).filter(
			(row) => row.pending.lead || row.pending.founder,
		);
		this.warnWorkflowShipReadyCardinality("ready", rows.length);
		return rows;
	}

	/**
	 * Reminder candidates deliberately ignore delivery facts: notification is
	 * not approval, so a delivered card can still be stalled and actionable.
	 */
	listWorkflowShipReadyStalled(input: {
		now: string;
		remindAfterMs: number;
	}): WorkflowShipReadyNotice[] {
		if (
			!Number.isSafeInteger(input.remindAfterMs) ||
			input.remindAfterMs <= 0
		) {
			throw new Error(
				"workflow ship-ready reminder threshold must be positive",
			);
		}
		const nowMs = StateStore.workflowShipReadyTimestampMs(input.now);
		if (!Number.isFinite(nowMs)) {
			throw new Error("workflow ship-ready now timestamp invalid");
		}
		const rows = this.listWorkflowShipReadyCandidates({
			now: input.now,
		}).filter((row) => {
			const uid = workflowShipReadyUid({
				runId: row.runId,
				gateNodeId: row.gateNodeId,
				attempt: row.attempt,
			});
			const facts = new Set(
				this.listWorkflowRunEvents(row.runId).map((event) => event.event_uid),
			);
			return (
				nowMs - StateStore.workflowShipReadyTimestampMs(row.gateOpenedAt) >
					input.remindAfterMs &&
				!facts.has(`ship_ready_stalled_alerted:${uid}`) &&
				!facts.has(`ship_ready_handled_observed:${uid}`)
			);
		});
		this.warnWorkflowShipReadyCardinality("stalled", rows.length);
		return rows;
	}

	recordWorkflowShipReadyFact(input: {
		runId: string;
		gateNodeId: string;
		attempt: number;
		path: "lead" | "founder";
		now: string;
	}): { ok: true; idempotentReplay: boolean } {
		this.validateWorkflowShipReadyMarker(input);
		const uid = workflowShipReadyUid(input);
		const kind =
			input.path === "lead"
				? "ship_ready_lead_queued"
				: "ship_ready_founder_posted";
		let idempotentReplay = false;
		this.db.transaction(() => {
			const marker: ShipReadyMarkerPayload = {
				path: input.path,
				at: input.now,
			};
			idempotentReplay = this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: `${kind}:${uid}`,
				kind,
				nodeId: input.gateNodeId,
				payload: marker,
			}).deduped;
		});
		this.save();
		return { ok: true, idempotentReplay };
	}

	recordWorkflowShipReadyHandledObserved(input: {
		runId: string;
		gateNodeId: string;
		attempt: number;
		reason: "pr_merged";
		now: string;
	}): { ok: true; idempotentReplay: boolean } {
		this.validateWorkflowShipReadyMarker(input);
		const uid = workflowShipReadyUid(input);
		let idempotentReplay = false;
		this.db.transaction(() => {
			idempotentReplay = this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: `ship_ready_handled_observed:${uid}`,
				kind: "ship_ready_handled_observed",
				nodeId: input.gateNodeId,
				payload: { reason: input.reason, at: input.now },
			}).deduped;
		});
		this.save();
		return { ok: true, idempotentReplay };
	}

	recordWorkflowShipReadyDeliveryFailure(input: {
		runId: string;
		gateNodeId: string;
		attempt: number;
		reason: string;
		gateOpenedAt: string;
		sourceExecutionId: string;
		alertIdentity: WorkflowEngineAlertIdentity;
		now: string;
	}): { ok: true; idempotentReplay: boolean } {
		return this.recordWorkflowShipReadyAlert({
			...input,
			kind: "ship_ready_delivery_failed",
			disposition: "ship_ready_delivery_failed",
		});
	}

	recordWorkflowShipReadyStalledAlert(input: {
		runId: string;
		gateNodeId: string;
		attempt: number;
		gateOpenedAt: string;
		sourceExecutionId: string;
		alertIdentity: WorkflowEngineAlertIdentity;
		now: string;
	}): { ok: true; idempotentReplay: boolean } {
		return this.recordWorkflowShipReadyAlert({
			...input,
			reason: "founder_gate_review_timeout",
			kind: "ship_ready_stalled_alerted",
			disposition: "ship_ready_stalled",
		});
	}

	private recordWorkflowShipReadyAlert(input: {
		runId: string;
		gateNodeId: string;
		attempt: number;
		reason: string;
		gateOpenedAt: string;
		sourceExecutionId: string;
		alertIdentity: WorkflowEngineAlertIdentity;
		now: string;
		kind: "ship_ready_delivery_failed" | "ship_ready_stalled_alerted";
		disposition: "ship_ready_delivery_failed" | "ship_ready_stalled";
	}): { ok: true; idempotentReplay: boolean } {
		this.validateWorkflowShipReadyMarker(input);
		if (!input.reason.trim() || !input.sourceExecutionId.trim()) {
			throw new Error("workflow ship-ready alert attribution invalid");
		}
		if (
			!Number.isFinite(
				StateStore.workflowShipReadyTimestampMs(input.gateOpenedAt),
			)
		) {
			throw new Error("workflow ship-ready gate timestamp invalid");
		}
		const uid = workflowShipReadyUid(input);
		const escalationUid =
			input.disposition === "ship_ready_delivery_failed"
				? `ship_ready_delivery_failed:${uid}`
				: `ship_ready_stalled:${uid}`;
		let idempotentReplay = false;
		this.db.transaction(() => {
			const marker: ShipReadyMarkerPayload = {
				path: "failed",
				reason: input.reason,
				at: input.now,
			};
			const event = this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: `${input.kind}:${uid}`,
				kind: input.kind,
				nodeId: input.gateNodeId,
				executionId: input.sourceExecutionId,
				payload: marker,
			});
			idempotentReplay = event.deduped;
			if (event.deduped) return;
			const run = this.getWorkflowRun(input.runId);
			if (!run) throw new Error(`workflow run not found: ${input.runId}`);
			this.enqueueWorkflowEngineAlertTx({
				escalationUid,
				runId: input.runId,
				payload: this.workflowShipReadyAlertPayload({
					escalationUid,
					runId: input.runId,
					issueId: run.issue_id,
					nodeId: input.gateNodeId,
					executionId: input.sourceExecutionId,
					reason: input.reason,
					gateOpenedAt: input.gateOpenedAt,
					disposition: input.disposition,
					identity: input.alertIdentity,
				}),
				now: input.now,
			});
		});
		this.save();
		return { ok: true, idempotentReplay };
	}

	private workflowShipReadyAlertPayload(input: {
		escalationUid: string;
		runId: string;
		issueId: string;
		nodeId: string;
		executionId: string;
		reason: string;
		gateOpenedAt: string;
		disposition: "ship_ready_delivery_failed" | "ship_ready_stalled";
		identity: WorkflowEngineAlertIdentity;
	}): WorkflowEngineAlertPayload {
		const stalled = input.disposition === "ship_ready_stalled";
		return {
			leadId: input.identity.leadId,
			projectName: input.identity.projectName,
			eventId: input.escalationUid,
			eventType: "workflow_engine_issue_alert",
			severity: "severe",
			sessionKey: `wf:${input.runId}`,
			title: stalled
				? `Founder ship gate stalled for ${input.issueId}`
				: `Founder ship-ready delivery failed for ${input.issueId}`,
			body: stalled
				? `Run ${input.runId} has waited at ${input.nodeId} since ${input.gateOpenedAt} without founder approval or a merged PR. Please inspect the issue thread and ship decision.`
				: `Run ${input.runId} reached ${input.nodeId} at ${input.gateOpenedAt}, but direct founder notification permanently failed. Reason: ${input.reason}. Lead delivery remains independent; please notify the founder manually.`,
			metadata: {
				workflowEngine: {
					runId: input.runId,
					issueId: input.issueId,
					nodeId: input.nodeId,
					executionId: input.executionId,
					disposition: input.disposition,
					leadResolution: input.identity.leadResolution,
				},
			},
		};
	}

	private listWorkflowShipReadyCandidates(input: {
		now: string;
	}): WorkflowShipReadyNotice[] {
		const nowMs = StateStore.workflowShipReadyTimestampMs(input.now);
		if (!Number.isFinite(nowMs)) {
			throw new Error("workflow ship-ready now timestamp invalid");
		}
		const engineeringTemplates = new Set([
			"tpl_eng_heavy",
			"tpl_eng_light",
			"tpl_eng_trivial",
		]);
		const notices: WorkflowShipReadyNotice[] = [];
		for (const run of this.listActiveWorkflowRuns()) {
			if (run.engine_owned !== 1 || !run.snapshot) continue;
			let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
			try {
				snapshot = parseWorkflowRunSnapshot(run.snapshot);
			} catch {
				continue;
			}
			if (
				snapshot.schema_version !== 1 ||
				isWorkflowManifestV1Land(snapshot.manifest) ||
				!engineeringTemplates.has(snapshot.template.id) ||
				!snapshot.manifest.ship_claims.includes("qa_passed")
			) {
				continue;
			}
			const gateNodeId = workflowApprovalGate(snapshot.manifest).node;
			if (
				run.current_node_id !== gateNodeId ||
				snapshot.resolved.nodes.find((node) => node.id === gateNodeId)?.type !==
					"gate" ||
				this.hasWorkflowShipReadyFounderApproval(run.run_id)
			) {
				continue;
			}
			const gate = this.listWorkflowRunNodes(run.run_id, gateNodeId).at(-1);
			if (!gate || gate.state !== "review") continue;
			const gateOpenedAt = StateStore.workflowShipReadyTimestampIso(
				gate.started_at,
			);
			const gateOpenedMs =
				StateStore.workflowShipReadyTimestampMs(gateOpenedAt);
			if (!Number.isFinite(gateOpenedMs)) continue;

			const uid = workflowShipReadyUid({
				runId: run.run_id,
				gateNodeId,
				attempt: gate.attempt,
			});
			const events = this.listWorkflowRunEvents(run.run_id);
			const facts = new Set(events.map((event) => event.event_uid));
			let entry: WorkflowRunEventRow | undefined;
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const candidate = events[index];
				if (candidate?.kind !== "edge_traversed") continue;
				const payload = candidate.payload as
					| Record<string, unknown>
					| undefined;
				if (
					payload?.targetNodeId === gateNodeId &&
					Number(payload.targetAttempt) === gate.attempt
				) {
					entry = candidate;
					break;
				}
			}
			const qaNodeId = snapshot.resolved.nodes.find(
				(node) => node.type === "qa",
			)?.id;
			const latestQa = qaNodeId
				? this.listWorkflowRunNodes(run.run_id, qaNodeId).at(-1)
				: undefined;
			const sourceExecutionId =
				entry?.execution_id ?? latestQa?.execution_id ?? run.run_id;
			const qaClaim = qaNodeId
				? this.workflowSelectAll(
						`SELECT c.subject_digest
						   FROM workflow_claims c
						   LEFT JOIN workflow_claim_revocation r ON r.claim_id = c.id
						  WHERE c.workflow_run_id = ? AND c.node_id = ?
						    AND c.attempt = ? AND c.predicate = 'qa_passed'
						    AND r.claim_id IS NULL
						  ORDER BY c.server_seq DESC LIMIT 1`,
						[run.run_id, qaNodeId, latestQa?.attempt ?? -1],
					)[0]
				: undefined;
			const headSha =
				typeof qaClaim?.subject_digest === "string" &&
				/^[0-9a-f]{40}$/i.test(qaClaim.subject_digest)
					? qaClaim.subject_digest
					: undefined;
			const prNumber = headSha
				? this.getWorkflowRunPrNumber(run.run_id, headSha)
				: undefined;
			const sourceSession = this.getSession(sourceExecutionId);
			notices.push({
				runId: run.run_id,
				issueId: run.issue_id,
				...(sourceSession?.issue_identifier
					? { issueIdentifier: sourceSession.issue_identifier }
					: {}),
				projectName: run.project_name,
				templateId: snapshot.template.id,
				gateNodeId,
				attempt: gate.attempt,
				gateOpenedAt,
				sourceExecutionId,
				ageMinutes: Math.max(0, Math.floor((nowMs - gateOpenedMs) / 60_000)),
				evidence: {
					...(headSha ? { headSha } : {}),
					...(prNumber ? { prNumber } : {}),
					qaPassed: qaClaim !== undefined,
				},
				pending: {
					lead: !facts.has(`ship_ready_lead_queued:${uid}`),
					founder:
						!facts.has(`ship_ready_founder_posted:${uid}`) &&
						!facts.has(`ship_ready_delivery_failed:${uid}`),
				},
			});
		}
		return notices.sort(
			(left, right) =>
				StateStore.workflowShipReadyTimestampMs(left.gateOpenedAt) -
					StateStore.workflowShipReadyTimestampMs(right.gateOpenedAt) ||
				workflowShipReadyUid(left).localeCompare(workflowShipReadyUid(right)),
		);
	}

	hasWorkflowShipReadyFounderApproval(runId: string): boolean {
		return (
			this.workflowSelectAll(
				`SELECT 1 AS present
				   FROM workflow_claims c
				   LEFT JOIN workflow_claim_revocation r ON r.claim_id = c.id
				  WHERE c.workflow_run_id = ? AND c.predicate = 'founder_approved'
				    AND r.claim_id IS NULL
				  LIMIT 1`,
				[runId],
			).length > 0
		);
	}

	private validateWorkflowShipReadyMarker(input: {
		runId: string;
		gateNodeId: string;
		attempt: number;
		now: string;
	}): void {
		if (
			!input.runId.trim() ||
			!input.gateNodeId.trim() ||
			!Number.isSafeInteger(input.attempt) ||
			input.attempt <= 0 ||
			!Number.isFinite(StateStore.workflowShipReadyTimestampMs(input.now))
		) {
			throw new Error("workflow ship-ready marker invalid");
		}
	}

	private warnWorkflowShipReadyCardinality(
		kind: "ready" | "stalled",
		count: number,
	): void {
		if (count <= 500) return;
		console.warn(
			`[workflow-engine] ship-ready ${kind} scan returned ${count} rows (diagnostic guard 500); preserving the complete result to avoid starvation`,
		);
	}

	private static workflowShipReadyTimestampIso(value: string): string {
		return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	}

	private static workflowShipReadyTimestampMs(value: string): number {
		return Date.parse(StateStore.workflowShipReadyTimestampIso(value));
	}

	/** Newest ACTIVE shadow run for an issue (an issue lives in one project;
	 * rowid tiebreak keeps the theoretical cross-project case deterministic). */
	getActiveWorkflowRunForIssue(issueId: string): WorkflowRunRow | undefined {
		const rows = this.workflowSelectAll(
			"SELECT run_id FROM workflow_run WHERE issue_id = ? AND status = 'active' ORDER BY rowid DESC LIMIT 1",
			[issueId],
		);
		const r = rows[0];
		return r ? this.getWorkflowRun(r.run_id as string) : undefined;
	}

	/** loop_iteration count of ONE run — the run-scoped attempt source
	 * (Codex code R1 #2: attempt derivation must never leak across runs). */
	countWorkflowRunLoopIterations(runId: string): number {
		const rows = this.workflowSelectAll(
			"SELECT COUNT(*) AS n FROM workflow_run_event WHERE run_id = ? AND kind = 'loop_iteration'",
			[runId],
		);
		return Number(rows[0]?.n ?? 0);
	}

	/**
	 * Allocate one deterministic docs materialization fence. The ledger intent
	 * and its pinned input receipt share a transaction; neither can exist alone.
	 */
	allocateWorkflowMaterialization(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		outputId: number;
		outputDigest: string;
		repo: string;
		ref: string;
		baseHead: string;
	}): WorkflowMaterializationRow {
		if (!Number.isInteger(input.attempt) || input.attempt <= 0) {
			throw new Error("workflow materialization attempt must be positive");
		}
		if (!Number.isInteger(input.outputId) || input.outputId <= 0) {
			throw new Error("workflow materialization output id must be positive");
		}
		if (!/^[0-9a-f]{64}$/.test(input.outputDigest)) {
			throw new Error("workflow materialization output digest invalid");
		}
		if (!/^[0-9a-f]{40,64}$/.test(input.baseHead)) {
			throw new Error("workflow materialization base head invalid");
		}
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) {
			throw new Error("workflow materialization repo invalid");
		}
		if (!input.ref.startsWith("refs/heads/") || input.ref.includes("..")) {
			throw new Error("workflow materialization ref invalid");
		}
		const current = this.workflowSelectAll(
			`SELECT o.id, o.attempt, o.output_digest
			   FROM workflow_node_output_current c
			   JOIN workflow_node_outputs o ON o.id = c.output_id
			  WHERE c.run_id = ? AND c.node_id = ?
			    AND c.output_id = ? AND c.attempt = ?
			    AND o.run_id = c.run_id AND o.node_id = c.node_id
			    AND o.attempt = c.attempt AND o.execution_id = c.execution_id`,
			[input.runId, input.nodeId, input.outputId, input.attempt],
		)[0];
		if (!current || current.output_digest !== input.outputDigest) {
			throw new Error(
				"workflow materialization output is not the current accepted output",
			);
		}
		const effectId = `mat:${canonicalSubmissionDigest({
			runId: input.runId,
			nodeId: input.nodeId,
			attempt: input.attempt,
			outputDigest: input.outputDigest,
			baseHead: input.baseHead,
		})}`;
		const existing = this.getWorkflowMaterializationReceipts(effectId).find(
			(row) => row.stage === "intent_pinned",
		);
		if (existing) {
			if (
				existing.run_id !== input.runId ||
				existing.node_id !== input.nodeId ||
				existing.attempt !== input.attempt ||
				existing.output_id !== input.outputId ||
				existing.output_digest !== input.outputDigest ||
				existing.repo !== input.repo ||
				existing.ref !== input.ref ||
				existing.base_head !== input.baseHead
			) {
				throw new Error("workflow materialization effect id collision");
			}
			return this.workflowMaterializationRow(effectId);
		}

		this.db.transaction(() => {
			const ordinal =
				Number(
					this.workflowSelectAll(
						`SELECT COALESCE(MAX(launch_ordinal), 0) AS n
						   FROM workflow_side_effect_ledger
						  WHERE run_id = ? AND node_id = ? AND attempt = ?
						    AND kind = 'materialize'`,
						[input.runId, input.nodeId, input.attempt],
					)[0]?.n ?? 0,
				) + 1;
			this.db.run(
				`INSERT INTO workflow_side_effect_ledger
				   (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state)
				 VALUES (?, ?, ?, 'materialize', ?, ?, 'intent_recorded')`,
				[input.runId, input.nodeId, input.attempt, ordinal, effectId],
			);
			this.db.run(
				`INSERT INTO workflow_materialization_receipt
				   (effect_id, stage, run_id, node_id, attempt, output_id,
				    output_digest, repo, ref, base_head)
				 VALUES (?, 'intent_pinned', ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					effectId,
					input.runId,
					input.nodeId,
					input.attempt,
					input.outputId,
					input.outputDigest,
					input.repo,
					input.ref,
					input.baseHead,
				],
			);
		});
		this.save();
		return this.workflowMaterializationRow(effectId);
	}

	adoptWorkflowMaterializationCommit(input: {
		effectId: string;
		treeHead: string;
		commitHead: string;
	}): void {
		if (
			!/^[0-9a-f]{40,64}$/.test(input.treeHead) ||
			!/^[0-9a-f]{40,64}$/.test(input.commitHead)
		) {
			throw new Error("workflow materialization commit head invalid");
		}
		this.db.transaction(() => {
			const row = this.workflowMaterializationLedgerRow(input.effectId);
			if (row.state !== "intent_recorded" && row.state !== "launch_committed") {
				throw new Error(
					`workflow materialization cannot adopt from ${row.state}`,
				);
			}
			const prior = this.getWorkflowMaterializationReceipts(
				input.effectId,
			).find((receipt) => receipt.stage === "commit_adopted");
			if (prior) {
				if (
					prior.tree_head !== input.treeHead ||
					prior.commit_head !== input.commitHead
				) {
					throw new Error("workflow materialization commit adoption mismatch");
				}
			} else {
				this.db.run(
					`INSERT INTO workflow_materialization_receipt
					   (effect_id, stage, tree_head, commit_head)
					 VALUES (?, 'commit_adopted', ?, ?)`,
					[input.effectId, input.treeHead, input.commitHead],
				);
			}
			if (row.state === "intent_recorded") {
				const now = new Date().toISOString();
				this.db.run(
					`UPDATE workflow_side_effect_ledger
					    SET state = 'launch_committed', committed_at = ?, updated_at = ?
					  WHERE id = ?`,
					[now, now, row.id],
				);
			}
		});
		this.save();
	}

	confirmWorkflowMaterializationPush(input: {
		effectId: string;
		remoteHead: string;
		reviewNodeId: string;
	}): void {
		if (!/^[0-9a-f]{40,64}$/.test(input.remoteHead)) {
			throw new Error("workflow materialization remote head invalid");
		}
		this.db.transaction(() => {
			const row = this.workflowMaterializationLedgerRow(input.effectId);
			if (row.state !== "launch_committed" && row.state !== "started") {
				throw new Error(
					`workflow materialization cannot confirm push from ${row.state}`,
				);
			}
			const run = this.getWorkflowRun(row.run_id);
			if (run?.engine_owned === 1) {
				if (!run.snapshot) {
					throw new Error("workflow materialized head authority unavailable");
				}
				const snapshot = parseWorkflowRunSnapshot(run.snapshot);
				const review = snapshot.resolved.nodes.find(
					(node) => node.id === input.reviewNodeId,
				);
				const directProducerIds = snapshot.manifest.edges
					.filter(
						(edge) =>
							edge.to === input.reviewNodeId && edge.condition === "node_done",
					)
					.map((edge) => edge.from);
				const directOutputProducers = snapshot.resolved.nodes.filter(
					(node) =>
						directProducerIds.includes(node.id) &&
						node.capabilities.produces_output,
				);
				if (
					review?.type !== "review" ||
					directOutputProducers.length !== 1 ||
					directOutputProducers[0]?.id !== row.node_id
				) {
					throw new Error(
						"workflow materialized head review successor is not pinned",
					);
				}
			}
			const receipts = this.getWorkflowMaterializationReceipts(input.effectId);
			const commit = receipts.find(
				(receipt) => receipt.stage === "commit_adopted",
			);
			if (!commit || commit.commit_head !== input.remoteHead) {
				throw new Error(
					"workflow materialization remote head does not match adopted commit",
				);
			}
			const prior = receipts.find(
				(receipt) => receipt.stage === "push_confirmed",
			);
			if (prior) {
				if (prior.remote_head !== input.remoteHead) {
					throw new Error(
						"workflow materialization push confirmation mismatch",
					);
				}
			} else {
				this.db.run(
					`INSERT INTO workflow_materialization_receipt
					   (effect_id, stage, commit_head, remote_head)
					 VALUES (?, 'push_confirmed', ?, ?)`,
					[input.effectId, input.remoteHead, input.remoteHead],
				);
			}
			if (row.state === "launch_committed") {
				const now = new Date().toISOString();
				this.db.run(
					`UPDATE workflow_side_effect_ledger
					    SET state = 'started', started_at = ?, updated_at = ?
					  WHERE id = ?`,
					[now, now, row.id],
				);
				const staleClaims = this.workflowSelectAll(
					`SELECT c.id FROM workflow_claims c
					  WHERE c.workflow_run_id = ? AND c.node_id = ?
					    AND c.predicate = 'design_review_approved'
					    AND c.subject_kind = 'git_head' AND c.subject_digest <> ?
					    AND NOT EXISTS (
					      SELECT 1 FROM workflow_claim_revocation r WHERE r.claim_id = c.id)`,
					[row.run_id, input.reviewNodeId, input.remoteHead],
				);
				for (const claim of staleClaims) {
					this.db.run(
						`INSERT INTO workflow_claim_revocation (claim_id, reason, actor)
						 VALUES (?, 'materialized_head_superseded', 'workflow_materializer')`,
						[Number(claim.id)],
					);
				}
			}
		});
		this.save();
	}

	abandonWorkflowMaterialization(effectId: string, reason: string): void {
		if (!reason)
			throw new Error("workflow materialization abandon requires a reason");
		this.db.transaction(() => {
			const row = this.workflowMaterializationLedgerRow(effectId);
			if (row.state === "abandoned") return;
			if (row.state !== "intent_recorded") {
				throw new Error("workflow materialization abandon is pre-commit only");
			}
			const now = new Date().toISOString();
			this.db.run(
				`UPDATE workflow_side_effect_ledger
				    SET state = 'abandoned', reason = ?, abandoned_at = ?, updated_at = ?
				  WHERE id = ?`,
				[reason, now, now, row.id],
			);
		});
		this.save();
	}

	getWorkflowMaterializationReceipts(
		effectId: string,
	): WorkflowMaterializationReceiptRow[] {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_materialization_receipt
			  WHERE effect_id = ? ORDER BY id`,
			[effectId],
		).map((row) => this.workflowMaterializationReceiptRow(row));
	}

	getWorkflowMaterializedHead(
		runId: string,
		producerNodeId: string,
	): { head: string; outputId: number; attempt: number } | undefined {
		const row = this.workflowSelectAll(
			`SELECT push.remote_head, intent.output_id, intent.attempt
			   FROM workflow_materialization_receipt intent
			   JOIN workflow_materialization_receipt adopted
			     ON adopted.effect_id = intent.effect_id AND adopted.stage = 'commit_adopted'
			   JOIN workflow_materialization_receipt push
			     ON push.effect_id = intent.effect_id AND push.stage = 'push_confirmed'
			   JOIN workflow_side_effect_ledger ledger
			     ON ledger.execution_id = intent.effect_id AND ledger.kind = 'materialize'
			   JOIN workflow_node_output_current current
			     ON current.run_id = intent.run_id AND current.node_id = intent.node_id
			    AND current.output_id = intent.output_id AND current.attempt = intent.attempt
			  WHERE intent.stage = 'intent_pinned' AND intent.run_id = ? AND intent.node_id = ?
			    AND ledger.state = 'started'
			    AND push.remote_head = adopted.commit_head
			  ORDER BY push.id DESC LIMIT 1`,
			[runId, producerNodeId],
		)[0];
		return row
			? {
					head: row.remote_head as string,
					outputId: Number(row.output_id),
					attempt: Number(row.attempt),
				}
			: undefined;
	}

	listNonTerminalWorkflowMaterializations(): WorkflowMaterializationRow[] {
		return this.workflowSelectAll(
			`SELECT l.execution_id
			   FROM workflow_side_effect_ledger l
			  WHERE l.kind = 'materialize'
			    AND l.state IN ('intent_recorded','launch_committed')
			  ORDER BY l.id`,
			[],
		).map((row) => this.workflowMaterializationRow(row.execution_id as string));
	}

	/** Current accepted producer outputs whose pinned snapshot has one direct review successor. */
	listWorkflowMaterializationCandidates(): WorkflowMaterializationCandidateRow[] {
		const rows = this.workflowSelectAll(
			`SELECT o.*, r.project_name, r.issue_id, r.snapshot
			   FROM workflow_node_output_current current
			   JOIN workflow_node_outputs o ON o.id = current.output_id
			   JOIN workflow_run r ON r.run_id = current.run_id
			  WHERE r.status = 'active' AND r.engine_owned = 1
			    AND o.output_schema = 'json_v1'
			    AND o.run_id = current.run_id AND o.node_id = current.node_id
			    AND o.attempt = current.attempt
			    AND o.execution_id = current.execution_id
			  ORDER BY o.id`,
			[],
		);
		return rows.flatMap((row) => {
			if (typeof row.snapshot !== "string") return [];
			let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
			try {
				snapshot = parseWorkflowRunSnapshot(row.snapshot);
			} catch {
				return [];
			}
			const producer = snapshot.resolved.nodes.find(
				(node) => node.id === row.node_id && node.capabilities.produces_output,
			);
			if (!producer) return [];
			const reviewIds = new Set(
				snapshot.manifest.edges
					.filter(
						(edge) =>
							edge.from === producer.id && edge.condition === "node_done",
					)
					.map((edge) => edge.to),
			);
			const reviews = snapshot.resolved.nodes.filter(
				(node) => reviewIds.has(node.id) && node.type === "review",
			);
			if (reviews.length !== 1) return [];
			return [
				{
					runId: row.run_id as string,
					producerNodeId: producer.id,
					reviewNodeId: reviews[0]!.id,
					attempt: Number(row.attempt),
					outputId: Number(row.id),
					outputDigest: row.output_digest as string,
					payload: row.payload as string,
					projectName: row.project_name as string,
					issueId: row.issue_id as string,
				},
			];
		});
	}

	private workflowMaterializationLedgerRow(
		effectId: string,
	): WorkflowSideEffectRow {
		const row = this.listWorkflowSideEffectsByEffectId(effectId);
		if (!row)
			throw new Error(`workflow materialization not found: ${effectId}`);
		return row;
	}

	private listWorkflowSideEffectsByEffectId(
		effectId: string,
	): WorkflowSideEffectRow | undefined {
		const row = this.workflowSelectAll(
			`SELECT * FROM workflow_side_effect_ledger
			  WHERE kind = 'materialize' AND execution_id = ?`,
			[effectId],
		)[0];
		return row ? this.workflowSideEffectRow(row) : undefined;
	}

	private workflowMaterializationRow(
		effectId: string,
	): WorkflowMaterializationRow {
		const ledger = this.workflowMaterializationLedgerRow(effectId);
		const intent = this.getWorkflowMaterializationReceipts(effectId).find(
			(row) => row.stage === "intent_pinned",
		);
		if (!intent)
			throw new Error(`workflow materialization intent missing: ${effectId}`);
		return { ...ledger, effect_id: effectId, intent };
	}

	private workflowMaterializationReceiptRow(
		row: Record<string, unknown>,
	): WorkflowMaterializationReceiptRow {
		return {
			id: Number(row.id),
			effect_id: row.effect_id as string,
			stage: row.stage as WorkflowMaterializationReceiptStage,
			run_id: (row.run_id as string) ?? null,
			node_id: (row.node_id as string) ?? null,
			attempt: row.attempt == null ? null : Number(row.attempt),
			output_id: row.output_id == null ? null : Number(row.output_id),
			output_digest: (row.output_digest as string) ?? null,
			repo: (row.repo as string) ?? null,
			ref: (row.ref as string) ?? null,
			base_head: (row.base_head as string) ?? null,
			tree_head: (row.tree_head as string) ?? null,
			commit_head: (row.commit_head as string) ?? null,
			remote_head: (row.remote_head as string) ?? null,
			created_at: row.created_at as string,
		};
	}

	private workflowSideEffectRow(
		row: Record<string, unknown>,
	): WorkflowSideEffectRow {
		return {
			id: Number(row.id),
			run_id: row.run_id as string,
			node_id: row.node_id as string,
			attempt: Number(row.attempt),
			kind: row.kind as string,
			launch_ordinal: Number(row.launch_ordinal),
			execution_id: row.execution_id as string,
			state: row.state as WorkflowSideEffectState,
			reason: (row.reason as string) ?? null,
			created_at: row.created_at as string,
			updated_at: row.updated_at as string,
			committed_at: (row.committed_at as string) ?? null,
			started_at: (row.started_at as string) ?? null,
			abandoned_at: (row.abandoned_at as string) ?? null,
		};
	}

	/**
	 * Non-terminal side-effect ledger rows across ALL runs, each carrying its
	 * run's project/issue identity. Evidence reconcile iterates THIS — never the
	 * active-run list — so a run that shipped (completed) before its evidence
	 * was read still converges (Codex code R1 #3).
	 */
	listNonTerminalWorkflowSideEffects(): Array<
		WorkflowSideEffectRow & { project_name: string; issue_id: string }
	> {
		return this.workflowSelectAll(
			`SELECT l.*, r.project_name AS project_name, r.issue_id AS issue_id
			   FROM workflow_side_effect_ledger l
			   JOIN workflow_run r ON r.run_id = l.run_id
			  WHERE l.kind = 'dispatch'
			    AND l.state IN ('intent_recorded','launch_committed')
			  ORDER BY l.id`,
			[],
		).map((r) => ({
			id: Number(r.id),
			run_id: r.run_id as string,
			node_id: r.node_id as string,
			attempt: Number(r.attempt),
			kind: r.kind as string,
			launch_ordinal: Number(r.launch_ordinal),
			execution_id: r.execution_id as string,
			state: r.state as WorkflowSideEffectState,
			reason: (r.reason as string) ?? null,
			created_at: r.created_at as string,
			updated_at: r.updated_at as string,
			committed_at: (r.committed_at as string) ?? null,
			started_at: (r.started_at as string) ?? null,
			abandoned_at: (r.abandoned_at as string) ?? null,
			project_name: r.project_name as string,
			issue_id: r.issue_id as string,
		}));
	}

	/**
	 * three_stage_fix_round events ATTRIBUTED to one shadow run: only rounds
	 * reported by an execution this run itself dispatched (present in its
	 * side-effect ledger or run events). The run-scoped T8 kickback source —
	 * execution identity, never timestamps or issue-global counts, decides
	 * which run a durable fact belongs to (Codex code R2 #1); each backfill
	 * uses the event's ACTUAL production round number (R1 #2).
	 */
	listWorkflowRunAttributedFixRounds(runId: string, issueId: string): number[] {
		const stmt = this.db.prepare(
			`SELECT payload FROM session_events
			  WHERE issue_id = ? AND event_type = 'three_stage_fix_round'
			    AND execution_id IN (
			      SELECT execution_id FROM workflow_side_effect_ledger
			       WHERE run_id = ? AND kind = 'dispatch'
			      UNION
			      SELECT execution_id FROM workflow_run_event
			       WHERE run_id = ? AND execution_id IS NOT NULL)
			  ORDER BY id`,
		);
		stmt.bind([issueId, runId, runId]);
		const rounds: number[] = [];
		while (stmt.step()) {
			const raw = (stmt.getAsObject() as Record<string, unknown>).payload;
			if (raw == null) continue;
			try {
				const payload = JSON.parse(raw as string) as { round?: unknown };
				if (Number.isInteger(payload.round) && (payload.round as number) > 0) {
					rounds.push(payload.round as number);
				}
			} catch {
				// malformed payload — skip (never invent a round)
			}
		}
		stmt.free();
		return rounds;
	}

	/** True when `executionId` was dispatched by (or produced an event in)
	 * this shadow run — THE cross-run attribution predicate (R2 #1/#2/#3). */
	isExecutionAttributedToWorkflowRun(
		runId: string,
		executionId: string,
	): boolean {
		const rows = this.workflowSelectAll(
			`SELECT 1 AS x FROM workflow_side_effect_ledger
			  WHERE run_id = ? AND execution_id = ? AND kind = 'dispatch'
			 UNION
			 SELECT 1 AS x FROM workflow_run_event
			  WHERE run_id = ? AND execution_id = ?
			 LIMIT 1`,
			[runId, executionId, runId, executionId],
		);
		return rows.length > 0;
	}

	/** True when durable finalization completion belongs to this run. A claim
	 * only means cleanup started and can never terminalize a shadow run. */
	hasWorkflowRunAttributedFinalizationCompleted(
		runId: string,
		issueId: string,
	): boolean {
		if (
			this.workflowSelectAll(
				`SELECT 1 AS x FROM land_operation
				  WHERE run_id = ? AND issue_id = ?
				    AND finalization_completed_at IS NOT NULL
				  LIMIT 1`,
				[runId, issueId],
			).length > 0
		) {
			return true;
		}
		const rows = this.workflowSelectAll(
			`SELECT 1 AS x FROM session_events
			  WHERE issue_id = ? AND event_type = 'post_ship_finalization_completed'
			    AND execution_id IN (
			      SELECT execution_id FROM workflow_side_effect_ledger
			       WHERE run_id = ? AND kind = 'dispatch'
			      UNION
			      SELECT execution_id FROM workflow_run_event
			       WHERE run_id = ? AND execution_id IS NOT NULL)
			  LIMIT 1`,
			[issueId, runId, runId],
		);
		return rows.length > 0;
	}

	/** @deprecated FLY-1375: use completion, not the old once-claim. */
	hasWorkflowRunAttributedShipClaim(runId: string, issueId: string): boolean {
		return this.hasWorkflowRunAttributedFinalizationCompleted(runId, issueId);
	}

	listWorkflowSideEffects(runId: string): WorkflowSideEffectRow[] {
		return this.workflowSelectAll(
			"SELECT * FROM workflow_side_effect_ledger WHERE run_id = ? ORDER BY id",
			[runId],
		).map((r) => ({
			id: Number(r.id),
			run_id: r.run_id as string,
			node_id: r.node_id as string,
			attempt: Number(r.attempt),
			kind: r.kind as string,
			launch_ordinal: Number(r.launch_ordinal),
			execution_id: r.execution_id as string,
			state: r.state as WorkflowSideEffectState,
			reason: (r.reason as string) ?? null,
			created_at: r.created_at as string,
			updated_at: r.updated_at as string,
			committed_at: (r.committed_at as string) ?? null,
			started_at: (r.started_at as string) ?? null,
			abandoned_at: (r.abandoned_at as string) ?? null,
		}));
	}

	/**
	 * THE single sanctioned transaction surface for shadow writes (design R3#5):
	 * one call = one SQLite transaction covering run getOrCreate, event-uid
	 * dedup + per-run seq allocation, run/node projections, event appends and
	 * side-effect intent/transitions. Any statement failing rolls the WHOLE
	 * batch back (B6: no torn writes between events / projections / intent) and
	 * the same batch can be replayed cleanly. Same-uid events dedupe; a
	 * dispatch replay with the same execution id converges on its existing
	 * ledger row (same ordinal); a NEW execution id on the same (node, attempt)
	 * gets a NEW row + next ordinal (replacement starts append, never rewrite).
	 *
	 * Event-uid formulas (the transition-table contract — see
	 * bridge/workflow-shadow-writer.ts for the full T1–T9 table):
	 *   dispatch  run:{runId}:dispatch:{node}:{attempt}:{ordinal}
	 *   wake      run:{runId}:wake:{node}:{attempt}
	 *   edge      run:{runId}:edge:{from}:{to}:{attempt}
	 *   complete  run:{runId}:complete:{node}:{attempt}:{executionId}
	 *   kickback  run:{runId}:kickback:{round}
	 * finalize (T9) is a PROJECTION-ONLY transition (active→completed): the
	 * umbrella §3.1b event vocabulary has no finalize kind, and the same B9
	 * discipline that keeps side-effect transitions out of run_event applies —
	 * no invented kinds.
	 */
	applyWorkflowShadowBatch(
		input: WorkflowShadowBatchInput,
	): WorkflowShadowBatchResult {
		if (!input.projectName || !input.issueId) {
			throw new Error("workflow shadow batch requires projectName + issueId");
		}
		for (const op of input.ops) {
			StateStore.validateWorkflowShadowOp(op);
		}
		let result: WorkflowShadowBatchResult | undefined;
		this.db.transaction(() => {
			let runId: string;
			let created = false;
			if (input.runId) {
				// Explicit run targeting (evidence reconcile on rows whose run may
				// already be completed — Codex code R1 #3). Never creates, and
				// accepts ONLY side_effect ops: a finalized run's lifecycle history
				// must not be mutable through this escape hatch (R2 #5).
				const nonSideEffect = input.ops.find((op) => op.op !== "side_effect");
				if (nonSideEffect) {
					throw new Error(
						`explicit-runId workflow shadow batch accepts only side_effect ops (got ${nonSideEffect.op})`,
					);
				}
				const row = this.workflowSelectAll(
					"SELECT run_id, project_name, issue_id, engine_owned FROM workflow_run WHERE run_id = ?",
					[input.runId],
				)[0];
				if (!row) {
					throw new Error(`workflow shadow run not found: ${input.runId}`);
				}
				// R3 #1: the caller's project/issue must MATCH the targeted run —
				// a wrong-identity batch must never reach another run's rows.
				if (
					row.project_name !== input.projectName ||
					row.issue_id !== input.issueId
				) {
					throw new Error(
						`workflow shadow batch identity mismatch: run ${input.runId} belongs to ${row.project_name}/${row.issue_id}, not ${input.projectName}/${input.issueId}`,
					);
				}
				if (
					input.expectedEngineOwned !== undefined &&
					Number(row.engine_owned) !== input.expectedEngineOwned
				) {
					throw new Error(
						`workflow shadow ownership mismatch: run ${input.runId} engine_owned=${Number(row.engine_owned)} expected=${input.expectedEngineOwned}`,
					);
				}
				runId = input.runId;
			} else {
				const existing = this.workflowSelectAll(
					"SELECT run_id FROM workflow_run WHERE project_name = ? AND issue_id = ? AND status = 'active' AND engine_owned = 0",
					[input.projectName, input.issueId],
				)[0];
				if (existing) {
					runId = existing.run_id as string;
				} else {
					const engine = this.workflowSelectAll(
						"SELECT run_id FROM workflow_run WHERE project_name = ? AND issue_id = ? AND status = 'active' AND engine_owned = 1 LIMIT 1",
						[input.projectName, input.issueId],
					)[0];
					if (engine) {
						throw new Error(
							`workflow_shadow_engine_owned_active:${engine.run_id as string}`,
						);
					}
					if (!input.newRunId) {
						throw new Error(
							`no active shadow run for ${input.projectName}/${input.issueId} and no newRunId supplied (fail-closed)`,
						);
					}
					runId = input.newRunId;
					this.db.run(
						`INSERT INTO workflow_run (run_id, issue_id, project_name, claims_read_enrolled)
						 VALUES (?, ?, ?, 0)`,
						[runId, input.issueId, input.projectName],
					);
					created = true;
				}
			}
			const events: WorkflowShadowBatchResult["events"] = [];
			const dispatchOrdinals: number[] = [];
			const appendEvent = (e: {
				eventUid: string;
				kind: string;
				nodeId?: string;
				edgeId?: string;
				executionId?: string;
				payload?: unknown;
			}) => {
				const r = this.appendWorkflowRunEventTx({ runId, ...e });
				events.push({ eventUid: e.eventUid, seq: r.seq, deduped: r.deduped });
			};
			for (const op of input.ops) {
				switch (op.op) {
					case "edge": {
						appendEvent({
							eventUid: `run:${runId}:edge:${op.from}:${op.to}:${op.attempt}`,
							kind: "edge_traversed",
							edgeId: `${op.from}->${op.to}`,
							executionId: op.executionId,
							payload: { attempt: op.attempt },
						});
						break;
					}
					case "dispatch": {
						const ordinal = this.allocateWorkflowLaunchOrdinalTx(
							runId,
							op.node,
							op.attempt,
							op.executionId,
						);
						dispatchOrdinals.push(ordinal);
						appendEvent({
							eventUid: `run:${runId}:dispatch:${op.node}:${op.attempt}:${ordinal}`,
							kind: "node_dispatched",
							nodeId: op.node,
							executionId: op.executionId,
							payload: { attempt: op.attempt, via: "spawn", ordinal },
						});
						this.upsertWorkflowRunNodeTx({
							runId,
							nodeId: op.node,
							attempt: op.attempt,
							state: "running",
							executionId: op.executionId,
						});
						this.db.run(
							"UPDATE workflow_run SET current_node_id = ? WHERE run_id = ?",
							[op.node, runId],
						);
						break;
					}
					case "wake": {
						appendEvent({
							eventUid: `run:${runId}:wake:${op.node}:${op.attempt}`,
							kind: "node_dispatched",
							nodeId: op.node,
							executionId: op.executionId,
							payload: { attempt: op.attempt, via: "wake" },
						});
						this.upsertWorkflowRunNodeTx({
							runId,
							nodeId: op.node,
							attempt: op.attempt,
							state: "running",
							executionId: op.executionId,
						});
						this.db.run(
							"UPDATE workflow_run SET current_node_id = ? WHERE run_id = ?",
							[op.node, runId],
						);
						break;
					}
					case "complete": {
						appendEvent({
							eventUid: `run:${runId}:complete:${op.node}:${op.attempt}:${op.executionId}`,
							kind: "node_completed",
							nodeId: op.node,
							executionId: op.executionId,
							payload: { attempt: op.attempt },
						});
						this.upsertWorkflowRunNodeTx({
							runId,
							nodeId: op.node,
							attempt: op.attempt,
							state: "done",
							executionId: op.executionId,
							endedAt: new Date().toISOString(),
						});
						this.db.run(
							"UPDATE workflow_run SET current_node_id = ? WHERE run_id = ?",
							[op.node, runId],
						);
						break;
					}
					case "kickback": {
						appendEvent({
							eventUid: `run:${runId}:kickback:${op.round}`,
							kind: "loop_iteration",
							payload: { round: op.round },
						});
						break;
					}
					case "finalize": {
						this.db.run(
							"UPDATE workflow_run SET status = 'completed' WHERE run_id = ? AND status = 'active'",
							[runId],
						);
						break;
					}
					case "side_effect": {
						this.transitionWorkflowSideEffectTx(runId, op);
						break;
					}
				}
			}
			result = { runId, created, dispatchOrdinals, events };
		});
		this.save();
		if (!result) throw new Error("workflow shadow batch produced no result");
		return result;
	}

	private static validateWorkflowShadowOp(op: WorkflowShadowOp): void {
		const label = (name: string, v: string) => {
			if (!v || v.includes(":")) {
				throw new Error(`workflow shadow ${name} label invalid: "${v}"`);
			}
		};
		const positiveInt = (name: string, v: number) => {
			if (!Number.isInteger(v) || v < 1) {
				throw new Error(`workflow shadow ${name} must be a positive integer`);
			}
		};
		switch (op.op) {
			case "edge":
				label("edge.from", op.from);
				label("edge.to", op.to);
				positiveInt("attempt", op.attempt);
				break;
			case "dispatch":
			case "wake":
			case "complete":
				label("node", op.node);
				positiveInt("attempt", op.attempt);
				if (!op.executionId) {
					throw new Error("workflow shadow op requires executionId");
				}
				break;
			case "kickback":
				positiveInt("round", op.round);
				break;
			case "finalize":
				break;
			case "side_effect":
				label("node", op.node);
				positiveInt("attempt", op.attempt);
				if (!op.executionId) {
					throw new Error("workflow shadow op requires executionId");
				}
				break;
		}
	}

	ensureWorkflowGateHolder(input: {
		runId: string;
		gateNodeId: string;
		attempt: number;
		headSha: string;
		sourceExecutionId: string;
		questionId: string;
		now: string;
	}): WorkflowGateHolderRow {
		if (
			!input.runId ||
			!input.gateNodeId ||
			!Number.isInteger(input.attempt) ||
			input.attempt < 1 ||
			!/^[0-9a-f]{40}$/i.test(input.headSha) ||
			!input.sourceExecutionId ||
			!input.questionId ||
			!StateStore.workflowFiniteTimestamp(input.now)
		) {
			throw new Error("invalid_workflow_gate_holder");
		}
		const headSha = input.headSha.toLowerCase();
		let holder: WorkflowGateHolderRow | undefined;
		this.db.transaction(() => {
			const exact = this.workflowSelectAll(
				`SELECT * FROM workflow_gate_holder
				  WHERE run_id = ? AND gate_node_id = ? AND attempt = ? AND head_sha = ?`,
				[input.runId, input.gateNodeId, input.attempt, headSha],
			)[0];
			if (exact) {
				if (
					exact.source_execution_id !== input.sourceExecutionId ||
					exact.question_id !== input.questionId
				) {
					throw new Error("workflow_gate_holder_identity_conflict");
				}
				holder = exact as unknown as WorkflowGateHolderRow;
				return;
			}
			this.db.run(
				`UPDATE workflow_gate_holder
				    SET state = 'superseded', superseded_reason = 'new_gate_attempt', updated_at = ?
				  WHERE run_id = ? AND gate_node_id = ?
				    AND state IN ('materializing','awaiting_review','approved')`,
				[input.now, input.runId, input.gateNodeId],
			);
			this.db.run(
				`INSERT INTO workflow_gate_holder
				   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
				    question_id, state, materialization_stage, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'materializing', 'question_intent', ?, ?)`,
				[
					input.runId,
					input.gateNodeId,
					input.attempt,
					headSha,
					input.sourceExecutionId,
					input.questionId,
					input.now,
					input.now,
				],
			);
			holder = this.workflowSelectAll(
				"SELECT * FROM workflow_gate_holder WHERE question_id = ?",
				[input.questionId],
			)[0] as unknown as WorkflowGateHolderRow;
		});
		this.save();
		if (!holder) throw new Error("workflow_gate_holder_not_created");
		return holder;
	}

	advanceWorkflowGateHolderMaterialization(input: {
		questionId: string;
		stage: WorkflowGateMaterializationStage;
		cardMessageId?: string;
		now: string;
	}):
		| { ok: true; idempotentReplay: boolean; state: WorkflowGateHolderState }
		| { ok: false; reason: string } {
		const order: Record<WorkflowGateMaterializationStage, number> = {
			question_intent: 0,
			question_written: 1,
			session_bound: 2,
			card_posted: 3,
			card_bound: 4,
			completed: 5,
		};
		const row = this.workflowSelectAll(
			"SELECT * FROM workflow_gate_holder WHERE question_id = ?",
			[input.questionId],
		)[0];
		if (!row) return { ok: false, reason: "workflow_gate_holder_not_found" };
		if (row.state === "superseded" || row.state === "approved") {
			return { ok: false, reason: "workflow_gate_holder_not_materializable" };
		}
		const current =
			row.materialization_stage as WorkflowGateMaterializationStage;
		if (order[input.stage] < order[current]) {
			return { ok: false, reason: "workflow_gate_materialization_regression" };
		}
		if (order[input.stage] === order[current]) {
			return {
				ok: true,
				idempotentReplay: true,
				state: row.state as WorkflowGateHolderState,
			};
		}
		const state: WorkflowGateHolderState =
			order[input.stage] >= order.card_bound
				? "awaiting_review"
				: "materializing";
		this.db.run(
			`UPDATE workflow_gate_holder
			    SET materialization_stage = ?, state = ?,
			        card_message_id = COALESCE(?, card_message_id), updated_at = ?
			  WHERE question_id = ? AND state IN ('materializing','awaiting_review')`,
			[
				input.stage,
				state,
				input.cardMessageId ?? null,
				input.now,
				input.questionId,
			],
		);
		if (this.db.getRowsModified() !== 1) {
			return { ok: false, reason: "workflow_gate_materialization_raced" };
		}
		this.save();
		return { ok: true, idempotentReplay: false, state };
	}

	getCurrentWorkflowGateHolderByQuestionId(
		questionId: string,
	): WorkflowGateHolderRow | undefined {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_gate_holder
			  WHERE question_id = ? AND state IN ('materializing','awaiting_review','approved')`,
			[questionId],
		)[0] as unknown as WorkflowGateHolderRow | undefined;
	}

	getCurrentWorkflowGateHolder(
		runId: string,
		gateNodeId: string,
	): WorkflowGateHolderRow | undefined {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_gate_holder
			  WHERE run_id = ? AND gate_node_id = ?
			    AND state IN ('materializing','awaiting_review','approved')`,
			[runId, gateNodeId],
		)[0] as unknown as WorkflowGateHolderRow | undefined;
	}

	getCurrentWorkflowGateHolderBySourceExecution(
		executionId: string,
	): WorkflowGateHolderRow | undefined {
		return this.workflowSelectAll(
			`SELECT * FROM workflow_gate_holder
			  WHERE source_execution_id = ?
			    AND state IN ('materializing','awaiting_review','approved')
			  ORDER BY created_at DESC
			  LIMIT 1`,
			[executionId],
		)[0] as unknown as WorkflowGateHolderRow | undefined;
	}

	getWorkflowRunPrNumber(runId: string, headSha: string): number | undefined {
		const run = this.getWorkflowRun(runId);
		if (!run || !/^[0-9a-f]{40}$/i.test(headSha)) return undefined;
		const sessions = this.getSessionsByIssue(run.issue_id);
		const exact = new Set(
			sessions
				.filter(
					(session) =>
						Number.isSafeInteger(session.pr_number) &&
						(session.pr_number ?? 0) > 0 &&
						session.pr_head_sha?.toLowerCase() === headSha.toLowerCase(),
				)
				.map((session) => session.pr_number as number),
		);
		if (exact.size === 1) return [...exact][0];
		if (exact.size > 1) return undefined;
		const issuePrs = new Set(
			sessions
				.filter(
					(session) =>
						Number.isSafeInteger(session.pr_number) &&
						(session.pr_number ?? 0) > 0,
				)
				.map((session) => session.pr_number as number),
		);
		return issuePrs.size === 1 ? [...issuePrs][0] : undefined;
	}

	listWorkflowGateHoldersForMaterialization(
		limit = 20,
	): WorkflowGateHolderRow[] {
		const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
		return this.workflowSelectAll(
			`SELECT * FROM workflow_gate_holder
			  WHERE state IN ('materializing','awaiting_review')
			    AND materialization_stage != 'completed'
			  ORDER BY created_at ASC, question_id ASC
			  LIMIT ?`,
			[boundedLimit],
		) as unknown as WorkflowGateHolderRow[];
	}

	ensureLandOperation(input: {
		runId?: string;
		issueId: string;
		projectName: string;
		prNumber: number;
		approvedHead: string;
		now: string;
	}): LandOperationRow {
		if (
			!input.issueId ||
			!input.projectName ||
			!Number.isInteger(input.prNumber) ||
			input.prNumber < 1 ||
			!/^[0-9a-f]{40}$/i.test(input.approvedHead) ||
			!StateStore.workflowFiniteTimestamp(input.now)
		) {
			throw new Error("invalid_land_operation");
		}
		const approvedHead = input.approvedHead.toLowerCase();
		const operationId = `land:${canonicalSubmissionDigest({
			projectName: input.projectName,
			issueId: input.issueId,
			prNumber: input.prNumber,
			approvedHead,
		})}`;
		this.db.run(
			`INSERT OR IGNORE INTO land_operation
			   (operation_id, run_id, issue_id, project_name, pr_number,
			    approved_head, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
			[
				operationId,
				input.runId ?? null,
				input.issueId,
				input.projectName,
				input.prNumber,
				approvedHead,
				input.now,
				input.now,
			],
		);
		const row = this.workflowSelectAll(
			"SELECT * FROM land_operation WHERE operation_id = ?",
			[operationId],
		)[0];
		if (!row) throw new Error("land_operation_not_created");
		if (input.runId && row.run_id && row.run_id !== input.runId) {
			throw new Error("land_operation_run_conflict");
		}
		if (input.runId && !row.run_id) {
			this.db.run(
				"UPDATE land_operation SET run_id = ?, updated_at = ? WHERE operation_id = ? AND run_id IS NULL",
				[input.runId, input.now, operationId],
			);
			row.run_id = input.runId;
			row.updated_at = input.now;
		}
		this.save();
		return row as unknown as LandOperationRow;
	}

	getLandOperation(operationId: string): LandOperationRow | undefined {
		return this.workflowSelectAll(
			"SELECT * FROM land_operation WHERE operation_id = ?",
			[operationId],
		)[0] as unknown as LandOperationRow | undefined;
	}

	getLandOperationForRun(runId: string): LandOperationRow | undefined {
		return this.workflowSelectAll(
			"SELECT * FROM land_operation WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
			[runId],
		)[0] as unknown as LandOperationRow | undefined;
	}

	getLatestLandOperationForIssue(
		projectName: string,
		issueId: string,
	): LandOperationRow | undefined {
		return this.workflowSelectAll(
			`SELECT * FROM land_operation
			  WHERE project_name = ? AND issue_id = ?
			  ORDER BY created_at DESC LIMIT 1`,
			[projectName, issueId],
		)[0] as unknown as LandOperationRow | undefined;
	}

	listRunnableLandOperations(now: string, limit = 20): LandOperationRow[] {
		if (!StateStore.workflowFiniteTimestamp(now)) {
			throw new Error("invalid_land_operation_sweep_time");
		}
		const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
		return this.workflowSelectAll(
			`SELECT * FROM land_operation
			  WHERE state IN ('intent','partial')
			     OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
			  ORDER BY updated_at ASC, operation_id ASC
			  LIMIT ?`,
			[now, boundedLimit],
		) as unknown as LandOperationRow[];
	}

	hasMergeConfirmedForIssue(issueId: string): boolean {
		const land = this.workflowSelectAll(
			`SELECT 1 AS x FROM land_operation
			  WHERE issue_id = ? AND merge_confirmed_at IS NOT NULL
			  LIMIT 1`,
			[issueId],
		);
		if (land.length > 0) return true;
		return (
			this.countEventsByIssueAndType(issueId, "post_ship_finalization_claim") >
			0
		);
	}

	hasFinalizationCompletedForIssue(issueId: string): boolean {
		const land = this.workflowSelectAll(
			`SELECT 1 AS x FROM land_operation
			  WHERE issue_id = ? AND finalization_completed_at IS NOT NULL
			  LIMIT 1`,
			[issueId],
		);
		if (land.length > 0) return true;
		return (
			this.countEventsByIssueAndType(
				issueId,
				"post_ship_finalization_completed",
			) > 0
		);
	}

	claimLandOperation(input: {
		operationId: string;
		ownerId: string;
		now: string;
		leaseExpiresAt: string;
	}): LandOperationClaim | undefined {
		if (
			!input.ownerId ||
			!StateStore.workflowFiniteTimestamp(input.now) ||
			!StateStore.workflowFiniteTimestamp(input.leaseExpiresAt) ||
			Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
		) {
			throw new Error("invalid_land_operation_lease");
		}
		let claim: LandOperationClaim | undefined;
		this.db.transaction(() => {
			const row = this.workflowSelectAll(
				"SELECT * FROM land_operation WHERE operation_id = ?",
				[input.operationId],
			)[0];
			if (
				!row ||
				!["intent", "running", "partial"].includes(String(row.state)) ||
				(row.lease_expires_at && String(row.lease_expires_at) > input.now)
			) {
				return;
			}
			const generation = Number(row.generation) + 1;
			this.db.run(
				`UPDATE land_operation
				    SET state = 'running', owner_id = ?, lease_expires_at = ?,
				        generation = ?, updated_at = ?
				  WHERE operation_id = ? AND generation = ?
				    AND state IN ('intent','running','partial')
				    AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
				[
					input.ownerId,
					input.leaseExpiresAt,
					generation,
					input.now,
					input.operationId,
					row.generation,
					input.now,
				],
			);
			if (this.db.getRowsModified() !== 1) return;
			claim = {
				operationId: input.operationId,
				ownerId: input.ownerId,
				generation,
			};
		});
		if (claim) this.save();
		return claim;
	}

	recordLandOperationStep(input: {
		operationId: string;
		ownerId: string;
		generation: number;
		step: string;
		receipt: Record<string, unknown>;
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string } {
		const receiptDigest = canonicalSubmissionDigest(input.receipt);
		let result:
			| { ok: true; idempotentReplay: boolean }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "stale_land_generation",
		};
		this.db.transaction(() => {
			const prior = this.workflowSelectAll(
				"SELECT receipt_digest FROM land_operation_step WHERE operation_id = ? AND step = ?",
				[input.operationId, input.step],
			)[0];
			if (prior) {
				result =
					prior.receipt_digest === receiptDigest
						? { ok: true, idempotentReplay: true }
						: { ok: false, reason: "land_step_receipt_conflict" };
				return;
			}
			const operation = this.workflowSelectAll(
				"SELECT * FROM land_operation WHERE operation_id = ?",
				[input.operationId],
			)[0];
			if (
				!operation ||
				operation.state !== "running" ||
				operation.owner_id !== input.ownerId ||
				Number(operation.generation) !== input.generation ||
				!operation.lease_expires_at ||
				String(operation.lease_expires_at) <= input.now
			) {
				return;
			}
			this.db.run(
				`INSERT INTO land_operation_step
				   (operation_id, step, receipt_digest, receipt_json, generation, completed_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[
					input.operationId,
					input.step,
					receiptDigest,
					JSON.stringify(input.receipt),
					input.generation,
					input.now,
				],
			);
			const completed = input.step === "finalization_completed";
			this.db.run(
				`UPDATE land_operation
				    SET current_step = ?, updated_at = ?,
				        merge_confirmed_at = CASE WHEN ? = 'merge_confirmed' THEN COALESCE(merge_confirmed_at, ?) ELSE merge_confirmed_at END,
				        finalization_completed_at = CASE WHEN ? = 'finalization_completed' THEN COALESCE(finalization_completed_at, ?) ELSE finalization_completed_at END,
				        state = CASE WHEN ? = 1 THEN 'completed' ELSE state END
				  WHERE operation_id = ? AND owner_id = ? AND generation = ?`,
				[
					input.step,
					input.now,
					input.step,
					input.now,
					input.step,
					input.now,
					completed ? 1 : 0,
					input.operationId,
					input.ownerId,
					input.generation,
				],
			);
			result = { ok: true, idempotentReplay: false };
		});
		if (result.ok) this.save();
		return result;
	}

	listLandOperationSteps(operationId: string): LandOperationStepRow[] {
		return this.workflowSelectAll(
			`SELECT operation_id, step, receipt_json, generation, completed_at
			   FROM land_operation_step WHERE operation_id = ?
			   ORDER BY CASE step
			     WHEN 'authority_verified' THEN 1
			     WHEN 'cool_triggered' THEN 2
			     WHEN 'merge_confirmed' THEN 3
			     WHEN 'cleanup_requested' THEN 4
			     WHEN 'finalization_completed' THEN 5
			     ELSE 100 END, completed_at, step`,
			[operationId],
		).map((row) => ({
			operation_id: row.operation_id as string,
			step: row.step as string,
			receipt: JSON.parse(row.receipt_json as string) as Record<
				string,
				unknown
			>,
			generation: Number(row.generation),
			completed_at: row.completed_at as string,
		}));
	}

	setLandOperationDisposition(input: {
		operationId: string;
		ownerId: string;
		generation: number;
		state: "partial" | "held";
		error: string;
		now: string;
	}): boolean {
		this.db.run(
			`UPDATE land_operation
			    SET state = ?, last_error = ?, owner_id = NULL,
			        lease_expires_at = NULL, updated_at = ?
			  WHERE operation_id = ? AND state = 'running'
			    AND owner_id = ? AND generation = ?`,
			[
				input.state,
				input.error,
				input.now,
				input.operationId,
				input.ownerId,
				input.generation,
			],
		);
		const updated = this.db.getRowsModified() === 1;
		if (updated) this.save();
		return updated;
	}

	recordWorkflowLandPartial(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		executionId: string;
		operationId: string;
		reason: string;
		now: string;
		alertIdentity?: WorkflowEngineAlertIdentity;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string } {
		const escalationUid = `land_partial:${input.runId}:${input.nodeId}:${input.attempt}:${canonicalSubmissionDigest(
			{ operationId: input.operationId, reason: input.reason },
		)}`;
		let result:
			| { ok: true; idempotentReplay: boolean }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "land_partial_not_committed",
		};
		this.db.transaction(() => {
			if (
				this.workflowSelectAll(
					"SELECT 1 AS x FROM workflow_run_event WHERE event_uid = ?",
					[escalationUid],
				)[0]
			) {
				result = { ok: true, idempotentReplay: true };
				return;
			}
			const run = this.getWorkflowRun(input.runId);
			const node = this.getWorkflowRunNode(
				input.runId,
				input.nodeId,
				input.attempt,
			);
			const operation = this.getLandOperation(input.operationId);
			if (
				!run ||
				run.engine_owned !== 1 ||
				run.status !== "active" ||
				run.current_node_id !== input.nodeId ||
				!node ||
				node.execution_id !== input.executionId ||
				!operation ||
				operation.run_id !== input.runId ||
				operation.state !== "partial"
			) {
				result = { ok: false, reason: "land_partial_precondition_failed" };
				return;
			}
			this.appendWorkflowRunEventCheckedTx({
				runId: input.runId,
				eventUid: escalationUid,
				kind: "land_partial",
				nodeId: input.nodeId,
				executionId: input.executionId,
				payload: {
					attempt: input.attempt,
					operationId: input.operationId,
					reason: input.reason,
					at: input.now,
				},
			});
			if (input.alertIdentity) {
				this.enqueueWorkflowEngineAlertTx({
					escalationUid,
					runId: input.runId,
					now: input.now,
					payload: this.workflowEngineAlertPayload({
						escalationUid,
						runId: input.runId,
						issueId: run.issue_id,
						nodeId: input.nodeId,
						executionId: input.executionId,
						reason: input.reason,
						disposition: "partial",
						identity: input.alertIdentity,
					}),
				});
			}
			result = { ok: true, idempotentReplay: false };
		});
		if (result.ok) this.save();
		return result;
	}

	holdWorkflowLandNode(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		executionId: string;
		operationId?: string;
		reason: string;
		now: string;
		alertIdentity?: WorkflowEngineAlertIdentity;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string } {
		if (
			!input.runId ||
			!input.nodeId ||
			!Number.isInteger(input.attempt) ||
			input.attempt < 1 ||
			!input.executionId ||
			!input.reason ||
			input.reason.length > 500 ||
			!StateStore.workflowFiniteTimestamp(input.now)
		) {
			return { ok: false, reason: "invalid_land_hold" };
		}
		const escalationUid = `land_held:${input.runId}:${input.nodeId}:${input.attempt}:${canonicalSubmissionDigest(
			{
				operationId: input.operationId ?? null,
				reason: input.reason,
			},
		)}`;
		let result:
			| { ok: true; idempotentReplay: boolean }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "land_hold_not_committed",
		};
		this.db.transaction(() => {
			const prior = this.workflowSelectAll(
				"SELECT 1 AS x FROM workflow_run_event WHERE event_uid = ?",
				[escalationUid],
			)[0];
			if (prior) {
				result = { ok: true, idempotentReplay: true };
				return;
			}
			const run = this.getWorkflowRun(input.runId);
			const node = this.getWorkflowRunNode(
				input.runId,
				input.nodeId,
				input.attempt,
			);
			if (
				!run ||
				run.engine_owned !== 1 ||
				run.status !== "active" ||
				run.current_node_id !== input.nodeId ||
				!node ||
				node.execution_id !== input.executionId
			) {
				result = { ok: false, reason: "land_hold_precondition_failed" };
				return;
			}
			if (input.operationId) {
				const operation = this.getLandOperation(input.operationId);
				if (
					!operation ||
					operation.run_id !== input.runId ||
					operation.state !== "held"
				) {
					result = { ok: false, reason: "land_operation_not_held" };
					return;
				}
			}
			this.db.run(
				"UPDATE workflow_run SET status = 'held' WHERE run_id = ? AND status = 'active'",
				[input.runId],
			);
			if (this.db.getRowsModified() !== 1) {
				result = { ok: false, reason: "land_run_state_changed" };
				return;
			}
			this.appendWorkflowRunEventCheckedTx({
				runId: input.runId,
				eventUid: escalationUid,
				kind: "land_held",
				nodeId: input.nodeId,
				executionId: input.executionId,
				payload: {
					attempt: input.attempt,
					operationId: input.operationId ?? null,
					reason: input.reason,
					at: input.now,
				},
			});
			if (input.alertIdentity) {
				this.enqueueWorkflowEngineAlertTx({
					escalationUid,
					runId: input.runId,
					now: input.now,
					payload: this.workflowEngineAlertPayload({
						escalationUid,
						runId: input.runId,
						issueId: run.issue_id,
						nodeId: input.nodeId,
						executionId: input.executionId,
						reason: input.reason,
						disposition: "held",
						identity: input.alertIdentity,
					}),
				});
			}
			result = { ok: true, idempotentReplay: false };
		});
		if (result.ok) this.save();
		return result;
	}

	completeWorkflowLandNode(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		executionId: string;
		operationId: string;
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string } {
		let result:
			| { ok: true; idempotentReplay: boolean }
			| { ok: false; reason: string } = {
			ok: false,
			reason: "land_completion_not_committed",
		};
		this.db.transaction(() => {
			const run = this.workflowSelectAll(
				"SELECT * FROM workflow_run WHERE run_id = ?",
				[input.runId],
			)[0];
			const node = this.workflowSelectAll(
				"SELECT * FROM workflow_run_node WHERE run_id = ? AND node_id = ? AND attempt = ?",
				[input.runId, input.nodeId, input.attempt],
			)[0];
			const operation = this.workflowSelectAll(
				"SELECT * FROM land_operation WHERE operation_id = ?",
				[input.operationId],
			)[0];
			if (run?.status === "completed" && node?.state === "done") {
				result = { ok: true, idempotentReplay: true };
				return;
			}
			if (
				!run ||
				run.engine_owned !== 1 ||
				run.status !== "active" ||
				run.current_node_id !== input.nodeId ||
				!node ||
				node.execution_id !== input.executionId ||
				!operation ||
				operation.run_id !== input.runId ||
				operation.state !== "completed"
			) {
				result = { ok: false, reason: "land_completion_precondition_failed" };
				return;
			}
			this.upsertWorkflowRunNodeTx({
				runId: input.runId,
				nodeId: input.nodeId,
				attempt: input.attempt,
				state: "done",
				executionId: input.executionId,
				endedAt: input.now,
			});
			this.db.run(
				"UPDATE workflow_run SET status = 'completed' WHERE run_id = ? AND status = 'active'",
				[input.runId],
			);
			this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: `land_completed:${input.operationId}`,
				kind: "land_completed",
				nodeId: input.nodeId,
				executionId: input.executionId,
				payload: { operationId: input.operationId, attempt: input.attempt },
			});
			this.appendWorkflowRunEventTx({
				runId: input.runId,
				eventUid: `run_completed:${input.operationId}`,
				kind: "run_completed",
				nodeId: input.nodeId,
				executionId: input.executionId,
				payload: { operationId: input.operationId },
			});
			result = { ok: true, idempotentReplay: false };
		});
		if (result.ok) this.save();
		return result;
	}

	/**
	 * Writer-allocated launch ordinal (design R3#2/R4#1): inside the batch
	 * transaction, the SAME execution id converges on its existing row (a
	 * pre-commit re-drive of one physical launch); every DIFFERENT execution id
	 * on the same (run, node, attempt) appends a NEW intent_recorded row with
	 * the next ordinal (post-start replacement, crash-then-new-execution).
	 * Callers never pre-compute ordinals.
	 */
	private allocateWorkflowLaunchOrdinalTx(
		runId: string,
		nodeId: string,
		attempt: number,
		executionId: string,
	): number {
		const rows = this.workflowSelectAll(
			`SELECT launch_ordinal, execution_id FROM workflow_side_effect_ledger
			  WHERE run_id = ? AND node_id = ? AND attempt = ? AND kind = 'dispatch'`,
			[runId, nodeId, attempt],
		);
		const mine = rows.find((r) => r.execution_id === executionId);
		if (mine) return Number(mine.launch_ordinal);
		const next =
			rows.reduce((max, r) => Math.max(max, Number(r.launch_ordinal)), 0) + 1;
		this.db.run(
			`INSERT INTO workflow_side_effect_ledger
			   (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state)
			 VALUES (?, ?, ?, 'dispatch', ?, ?, 'intent_recorded')`,
			[runId, nodeId, attempt, next, executionId],
		);
		return next;
	}

	/**
	 * §2.4b one-way dispatch state machine:
	 *   intent_recorded → launch_committed → started (terminal)
	 *   intent_recorded → abandoned (pre-commit positive failure ONLY, reason
	 *   required — a durable commit marker means the row can never abandon:
	 *   it stops at launch_committed forever, history is not invented).
	 * Same-state replay = idempotent no-op; forward skips are allowed (both
	 * evidences proven at once) and stamp the intermediate timestamp; anything
	 * else is refused. Rows record launch HISTORY, not liveness — a runner
	 * exiting after a successful start stays `started`.
	 */
	private transitionWorkflowSideEffectTx(
		runId: string,
		op: Extract<WorkflowShadowOp, { op: "side_effect" }>,
	): void {
		const row = this.workflowSelectAll(
			`SELECT * FROM workflow_side_effect_ledger
			  WHERE run_id = ? AND node_id = ? AND attempt = ? AND kind = 'dispatch' AND execution_id = ?`,
			[runId, op.node, op.attempt, op.executionId],
		)[0];
		if (!row) {
			throw new Error(
				`workflow side-effect row not found: ${runId}/${op.node}/${op.attempt}/${op.executionId}`,
			);
		}
		const cur = row.state as WorkflowSideEffectState;
		if (cur === op.to) return; // idempotent same-state replay
		const nowIso = new Date().toISOString();
		if (op.to === "abandoned") {
			if (!op.reason) {
				throw new Error("workflow side-effect abandon requires a reason");
			}
			if (cur !== "intent_recorded") {
				throw new Error(
					`workflow side-effect illegal transition ${cur} → abandoned (abandon is pre-commit only)`,
				);
			}
			this.db.run(
				`UPDATE workflow_side_effect_ledger
				    SET state = 'abandoned', reason = ?, abandoned_at = ?, updated_at = ?
				  WHERE id = ?`,
				[op.reason, nowIso, nowIso, Number(row.id)],
			);
			return;
		}
		const ORDER: Record<string, number> = {
			intent_recorded: 0,
			launch_committed: 1,
			started: 2,
		};
		const from = ORDER[cur];
		const to = ORDER[op.to];
		if (from === undefined || to === undefined || to <= from) {
			throw new Error(
				`workflow side-effect illegal transition ${cur} → ${op.to}`,
			);
		}
		this.db.run(
			`UPDATE workflow_side_effect_ledger
			    SET state = ?, updated_at = ?,
			        committed_at = COALESCE(committed_at, ?),
			        started_at = CASE WHEN ? = 'started' THEN COALESCE(started_at, ?) ELSE started_at END
			  WHERE id = ?`,
			[op.to, nowIso, nowIso, op.to, nowIso, Number(row.id)],
		);
	}

	/** Transaction-internal node projection upsert (shared with the public API). */
	private upsertWorkflowRunNodeTx(input: {
		runId: string;
		nodeId: string;
		attempt: number;
		state: string;
		executionId?: string;
		endedAt?: string;
	}): void {
		this.db.run(
			`INSERT INTO workflow_run_node (run_id, node_id, attempt, state, execution_id, ended_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(run_id, node_id, attempt) DO UPDATE SET
				state = excluded.state,
				execution_id = COALESCE(excluded.execution_id, workflow_run_node.execution_id),
				ended_at = COALESCE(excluded.ended_at, workflow_run_node.ended_at)`,
			[
				input.runId,
				input.nodeId,
				input.attempt,
				input.state,
				input.executionId ?? null,
				input.endedAt ?? null,
			],
		);
	}
}

// ── FLY-1244: workflow template + claims row/result types ──────────────────

export type WorkflowGateHolderState =
	| "materializing"
	| "awaiting_review"
	| "approved"
	| "superseded";

export type WorkflowGateMaterializationStage =
	| "question_intent"
	| "question_written"
	| "session_bound"
	| "card_posted"
	| "card_bound"
	| "completed";

export interface WorkflowGateHolderRow {
	run_id: string;
	gate_node_id: string;
	attempt: number;
	head_sha: string;
	source_execution_id: string;
	question_id: string;
	card_message_id: string | null;
	state: WorkflowGateHolderState;
	materialization_stage: WorkflowGateMaterializationStage;
	superseded_reason: string | null;
	created_at: string;
	updated_at: string;
}

export type LandOperationState =
	| "intent"
	| "running"
	| "partial"
	| "completed"
	| "held";

export interface LandOperationRow {
	operation_id: string;
	run_id: string | null;
	issue_id: string;
	project_name: string;
	pr_number: number;
	approved_head: string;
	state: LandOperationState;
	owner_id: string | null;
	lease_expires_at: string | null;
	generation: number;
	current_step: string | null;
	merge_confirmed_at: string | null;
	finalization_completed_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

export interface LandOperationClaim {
	operationId: string;
	ownerId: string;
	generation: number;
}

export interface LandOperationStepRow {
	operation_id: string;
	step: string;
	receipt: Record<string, unknown>;
	generation: number;
	completed_at: string;
}

export type WorkflowRouteDecisionRoute =
	| "workflow_v2"
	| "pipeline_dag_v1"
	| "legacy"
	| "bypass_override"
	| "generic_fallback";

export interface WorkflowRouteDecisionClaimInput {
	project: string;
	issueId: string;
	idempotencyKey?: string;
	executionId?: string;
	runId?: string;
	nodeId?: string;
	route: WorkflowRouteDecisionRoute;
	routeDigest: string;
	taskCategory?: WorkKindCategory;
	categorySource?: CategorySource;
	tier?: EngTier;
	override?: RoutingOverride;
	selectionReason?: string;
	selectedBy?: string;
	owningDept?: string;
	suggestedCategory?: WorkKindCategory;
	labelDocumentationIntent?: boolean;
	createdBySwitchState?: string;
	now?: string;
}

export interface WorkflowRouteDecisionRow {
	id: number;
	project: string;
	issue_id: string;
	status: "decided" | "launched" | "rejected";
	route: WorkflowRouteDecisionRoute | "rejected";
	idempotency_key: string | null;
	execution_id: string | null;
	run_id: string | null;
	node_id: string | null;
	route_digest: string;
	task_category: string | null;
	category_source: CategorySource | null;
	tier: EngTier | null;
	routing_override: RoutingOverride | null;
	selection_reason: string | null;
	selected_by: string | null;
	owning_dept: string | null;
	suggested_category: string | null;
	label_documentation_intent: number;
	created_by_switch_state: string;
	error_code: string | null;
	payload_hash: string | null;
	dedup_key: string | null;
	created_at: string;
	launched_at: string | null;
}

export type WorkflowRouteDecisionClaimResult =
	| {
			status: "inserted" | "resume_decided" | "already_launched";
			decision: WorkflowRouteDecisionRow;
	  }
	| { status: "conflict"; decision: WorkflowRouteDecisionRow };

export interface WorkflowRouteReminderOutboxRow {
	dedup_key: string;
	decision_id: number;
	project: string;
	issue_id: string;
	error_code: string;
	payload_json: string;
	recipient_lead_id: string;
	status: "pending" | "accepted" | "dead_letter";
	attempts: number;
	claim_owner: string | null;
	claim_expires_at: string | null;
	accepted_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

export interface WorkflowRouteReminderClaim {
	dedupKey: string;
	attempt: number;
	eventId: string;
	project: string;
	issueId: string;
	errorCode: string;
	payload: unknown;
	recipientLeadId: string;
}

export interface WorkflowCategorySuggestionSummary {
	project: string;
	owningDept: string | null;
	total: number;
	matches: number;
	ratio: number;
}

export interface WorkflowTemplateRow {
	template_id: string;
	name: string;
	project_scope: string;
	current_published_revision: number | null;
	created_by: string;
	created_at: string;
	seed_owner: "system" | "founder";
	seed_content_hash: string | null;
	retired_at: string | null;
}

export interface WorkflowTemplateRevisionRow {
	template_id: string;
	revision: number;
	manifest: string;
	manifest_digest: string;
	schema_version: number;
	created_by: string;
	created_at: string;
}

export interface WorkflowTemplatePublicationRow {
	id: number;
	template_id: string;
	revision: number;
	published_by: string;
	published_at: string;
}

export interface WorkflowCategoryBindingRow {
	project: string;
	task_category: string;
	template_id: string;
	updated_by: string;
	updated_at: string;
}

export interface WorkflowTemplateAuditRow {
	id: number;
	at: string;
	actor: string;
	action: "seed_import" | "publish" | "rebind" | "create" | "run_override";
	template_id: string | null;
	revision: number | null;
	run_id: string | null;
	detail: string | null;
}

export type WorkflowTemplatePublishResult =
	| { status: "published"; revision: number }
	| { status: "conflict"; currentRevision: number | null }
	| { status: "not_found" };

export type WorkflowTemplateSeedImportResult = {
	status: "imported" | "updated" | "unchanged" | "refused";
	revision: number;
};

export interface WorkflowRunRow {
	run_id: string;
	issue_id: string;
	project_name: string;
	template_id: string | null;
	template_revision: number | null;
	snapshot: string | null;
	selection_source: string | null;
	selected_by: string | null;
	selection_reason: string | null;
	task_category: string | null;
	category_source: string | null;
	tier: string | null;
	current_node_id: string | null;
	/** Explicit run-level authority for the QA attempt allowed to satisfy ship. */
	current_qa_attempt: number | null;
	status: string;
	/** Typed cutover marker (plan §3.2) — 1 only when this run was EXPLICITLY
	 * enrolled in the claims read path at admission. Never inferred. */
	claims_read_enrolled: number;
	/** Snapshot interpreter ownership; written only by reserved engine starts. */
	engine_owned: number;
	/** FLY-1372: entry provenance — 'pipeline_dag_v1' only for pipeline.dag
	 * entry runs; NULL for existing v2 / explicit-v1 shapes (recovery filter). */
	entry_kind?: string | null;
	created_at: string;
}

export interface WorkflowRunNodeRow {
	run_id: string;
	node_id: string;
	attempt: number;
	state: string;
	execution_id: string | null;
	started_at: string;
	ended_at: string | null;
}

export type WorkflowTransitionResult =
	| {
			ok: true;
			idempotentReplay: boolean;
			edgeId: string;
			targetNodeId: string;
			targetAttempt: number;
			successorExecutionId?: string;
			loopIteration?: number;
			gateOpened?: true;
			escalated?: true;
	  }
	| { ok: false; reason: string };

export interface WorkflowExecutionBindingRow {
	execution_id: string;
	run_id: string;
	node_id: string;
	attempt: number;
	bound_at: string;
}

export interface WorkflowExecutionRuntimeRow {
	execution_id: string;
	run_id: string;
	node_id: string;
	attempt: number;
	vendor: string;
	model: string;
	effort: string | null;
	resolved_family: string;
	capabilities_digest: string;
	created_at: string;
}

export interface WorkflowNodeCompletionRow {
	run_id: string;
	node_id: string;
	attempt: number;
	execution_id: string;
	route: string;
	event_uid: string;
	source_event_id: string;
	completion_submission_digest: string;
	completed_at: string;
}

export interface WorkflowNodeOutputRow {
	id: number;
	run_id: string;
	node_id: string;
	attempt: number;
	execution_id: string;
	payload: string;
	output_digest: string;
	output_schema: string;
	byte_size: number;
	written_at: string;
}

export interface WorkflowMaterializationCandidateRow {
	runId: string;
	producerNodeId: string;
	reviewNodeId: string;
	attempt: number;
	outputId: number;
	outputDigest: string;
	payload: string;
	projectName: string;
	issueId: string;
}

export type WorkflowStartStage =
	| "materialized"
	| "admitted"
	| "commdb_registered"
	| "launch_committed"
	| "responded";

export interface WorkflowStartReservationRow {
	idempotency_key: string;
	selection_digest: string;
	run_id: string;
	node_id: string;
	attempt: number;
	execution_id: string;
	created_at: string;
	stage: WorkflowStartStage;
	stage_updated_at: string;
}

export interface WorkflowLaunchOwnerRow {
	execution_id: string;
	owner_generation: number;
	owner_id: string;
	acquired_at: string;
	lease_expires_at: string;
	committed_generation: number | null;
	delivery_attempt: number;
	delivery_owner: string | null;
	delivery_lease_expires_at: string | null;
	delivery_state: "pending" | "repairing" | "delivered";
}

export type WorkflowLaunchAcquireResult =
	| {
			status: "acquired" | "committed";
			generation: number;
			deliveryAttempt: number;
			token: string;
	  }
	| { status: "busy"; generation: number }
	| { status: "hold"; reason: string };

export type WorkflowLaunchDeliveryResult =
	| {
			status: "claimed";
			generation: number;
			attempt: number;
			token: string;
	  }
	| { status: "busy"; attempt: number }
	| { status: "hold"; reason: string };

export type GeneralizedWorkflowAdmissionResult =
	| {
			ok: true;
			idempotentReplay: boolean;
			outputCredential?: string;
			submissionCredential?: string;
			snapshotDigest: string;
	  }
	| {
			ok: false;
			reason:
				| "template_dispatch_disabled"
				| "generalized_disabled"
				| "claims_write_disabled"
				| "claims_read_disabled"
				| "invalid_expiry"
				| "run_not_found"
				| "invalid_snapshot"
				| "unknown_node"
				| "engine_ownership_required"
				| "not_start_node"
				| "unsupported_capability_combination"
				| "decision_producer_ambiguous"
				| "review_output_producer_required"
				| "same_vendor_review"
				| "execution_already_bound"
				| "invalid_retry_attempt"
				| "successor_not_reserved";
	  };

export type WorkflowOutputSubmissionResult =
	| { ok: true; outputId: number; idempotentReplay: boolean }
	| {
			ok: false;
			reason:
				| "invalid_timestamp"
				| "invalid_output"
				| "credential_not_found"
				| "credential_revoked"
				| "credential_expired"
				| "replay_payload_mismatch"
				| "node_does_not_produce_output"
				| "output_too_large"
				| "output_already_exists"
				| "stale_output_attempt";
	  };

export type WorkflowCompletionResult =
	| { ok: true; eventUid: string; idempotentReplay: boolean }
	| { ok: false; reason: "missing_output"; retryable: true }
	| { ok: false; reason: "stale_execution_superseded" }
	| {
			ok: false;
			reason:
				| "invalid_timestamp"
				| "not_enrolled"
				| "route_mismatch"
				| "completion_conflict"
				| "transition_refused";
	  };

export interface RunQuiescenceEvidence {
	executionId: string;
	sessionStatus: string | null;
	lifecycleRevision: number | null;
	liveness: "alive" | "dead" | "unknown";
	observedAt: string;
	trustedZombieEventUid?: string;
}

export type WorkflowRunOperatorResult =
	| {
			ok: true;
			status: "held" | "terminated";
			idempotentReplay: boolean;
	  }
	| {
			ok: false;
			reason: string;
			executionIds?: string[];
	  };

export interface WorkflowEngineAlertIdentity {
	leadId: string;
	projectName: string;
	leadResolution: "resolved" | "fallback";
}

export type WorkflowDeadExecutionCommitMarkerBaseline =
	| { state: "present"; mtimeMs: number }
	| { state: "absent" }
	| { state: "unknown" };

export interface WorkflowDeadExecutionActivityBaseline {
	commitMarker: WorkflowDeadExecutionCommitMarkerBaseline;
	commDbMessageCount: number | null;
	tmuxTarget: string | null;
	tmuxOutputDigest: string | null;
	sessionCommitCount: number | null;
}

export interface WorkflowDeadExecutionActivityEvidence {
	kind: "commit_marker" | "session_commit" | "commdb_write" | "tmux_output";
	detail: string;
}

export interface WorkflowDeadExecutionWatchRow {
	dead_execution_id: string;
	run_id: string;
	node_id: string;
	attempt: number;
	new_execution_id: string;
	project_name: string;
	issue_id: string;
	observed_at: string;
	baseline: WorkflowDeadExecutionActivityBaseline;
	state: "active" | "tripped";
	tripped_at: string | null;
	evidence: WorkflowDeadExecutionActivityEvidence | null;
}

export interface WorkflowEngineAlertPayload {
	leadId: string;
	projectName: string;
	eventId: string;
	eventType: "workflow_engine_escalation" | "workflow_engine_issue_alert";
	title: string;
	body: string;
	severity: "severe";
	sessionKey: string;
	metadata: {
		workflowEngine: {
			runId: string;
			issueId: string;
			nodeId: string;
			executionId: string;
			disposition:
				| "held"
				| "partial"
				| "design_fallback"
				| "probe_unknown"
				| "dead_execution_activity_after_replacement"
				| "repeated_dead_execution_pattern"
				| "ship_ready_stalled"
				| "ship_ready_delivery_failed";
			leadResolution: "resolved" | "fallback";
		};
	};
}

export interface WorkflowAlertOutboxRow {
	escalation_uid: string;
	run_id: string;
	payload: WorkflowEngineAlertPayload;
	state: "pending" | "delivering" | "sent" | "failed";
	attempt: number;
	lease_owner: string | null;
	lease_expires_at: string | null;
	generation: number;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

export interface WorkflowAlertDeliveryClaim {
	escalationUid: string;
	runId: string;
	payload: WorkflowEngineAlertPayload;
	attempt: number;
	generation: number;
	ownerId: string;
}

export interface WorkflowDivergenceCandidate {
	runId: string;
	nodeId: string;
	attempt: number;
	executionId: string;
	sessionStatus: string;
	lifecycleRevision: number;
}

export interface WorkflowSubmissionCredentialRow {
	id: number;
	credential_hash: string;
	run_id: string;
	node_id: string;
	execution_id: string;
	attempt: number;
	family: string;
	decision_capability_id: number | null;
	issued_at: string;
	expires_at: string;
	absolute_deadline_at: string;
	consumed_at: string | null;
	consumed_client_request_id: string | null;
	consumed_submission_digest: string | null;
	claim_id: number | null;
	revoked: number;
	revoked_reason: string | null;
}

export type WorkflowExecutionAdmissionResult =
	| { ok: true; credentialId: number; credential: string }
	| {
			ok: false;
			reason:
				| "run_not_found"
				| "stale_attempt"
				| "invalid_binding"
				| "invalid_family"
				| "invalid_timestamp"
				| "invalid_expiry"
				| "attempt_execution_conflict"
				| "execution_already_bound"
				| "credential_already_issued";
	  };

export type WorkflowCredentialSubmissionResult =
	| { ok: true; claimId: number; serverSeq: number; idempotentReplay: boolean }
	| {
			ok: false;
			reason:
				| "credential_not_found"
				| "credential_revoked"
				| "credential_expired"
				| "credential_receipt_corrupt"
				| "replay_payload_mismatch"
				| "predicate_not_allowed"
				| "binding_not_current"
				| "missing_subject_producer"
				| "same_vendor_review"
				| "invalid_timestamp"
				| "run_not_found"
				| "transition_refused";
	  };

export interface WorkflowRunEventRow {
	run_id: string;
	seq: number;
	event_uid: string;
	kind: string;
	node_id: string | null;
	edge_id: string | null;
	execution_id: string | null;
	payload?: unknown;
	at: string;
}

export interface WorkflowDecisionCapabilityRow {
	id: number;
	token_hash: string;
	run_id: string;
	node_id: string;
	execution_id: string;
	attempt: number;
	allowed_predicate_family: string;
	manifest_revision: number | null;
	evidence_schema_version: number;
	expected_subject_digest: string | null;
	issued_at: string;
	expires_at: string;
	absolute_deadline_at: string;
	consumed_at: string | null;
	consumed_claim_id: number | null;
	revoked: number;
	revoked_reason: string | null;
}

export interface WorkflowClaimRow {
	id: number;
	server_seq: number;
	issued_at: string;
	issue_id: string;
	workflow_run_id: string;
	node_id: string | null;
	decision_kind: string;
	attempt: number | null;
	predicate: string;
	issuer_kind: string;
	issuer_execution_id: string | null;
	issuer_node_id: string | null;
	issuer_vendor: string | null;
	issuer_model: string | null;
	subject_producer_execution_id: string | null;
	subject_kind: string;
	subject_digest: string;
	expires_at: string | null;
	permanent: number;
	submission_digest: string | null;
	client_request_id: string | null;
	evidence?: unknown;
	authority_id: string;
}

export type WorkflowCapabilityIssueResult =
	| { ok: true; capabilityId: number; token: string }
	| {
			ok: false;
			reason:
				| "run_not_found"
				| "stale_attempt"
				| "invalid_family"
				| "invalid_timestamp"
				| "expiry_beyond_deadline";
	  };

export type WorkflowCapabilityRenewalResult =
	| { ok: true; expiresAt: string }
	| {
			ok: false;
			reason:
				| "capability_not_found"
				| "capability_consumed"
				| "capability_revoked"
				| "capability_expired"
				| "invalid_timestamp";
	  };

export type WorkflowClaimSubmissionResult =
	| { ok: true; claimId: number; serverSeq: number; idempotentReplay: boolean }
	| {
			ok: false;
			reason:
				| "capability_not_found"
				| "capability_revoked"
				| "capability_expired"
				| "replay_payload_mismatch"
				| "predicate_not_allowed"
				| "subject_kind_invalid"
				| "subject_mismatch"
				| "missing_subject_producer"
				| "same_vendor_review"
				| "missing_expiry"
				| "invalid_timestamp"
				| "run_not_found";
	  };

export type WorkflowSystemClaimResult =
	| { ok: true; claimId: number; serverSeq: number }
	| {
			ok: false;
			reason:
				| "predicate_not_allowed_for_issuer"
				| "subject_kind_invalid"
				| "expiry_or_permanent_required"
				| "invalid_timestamp"
				| "issue_mismatch"
				| "run_not_found";
	  };

export type WorkflowClaimResolution =
	| { valid: true; claim: WorkflowClaimRow }
	| {
			valid: false;
			reason:
				| "no_claim"
				| "conflict"
				| "predicate_mismatch"
				| "stale_attempt"
				| "revoked"
				| "expired"
				| "not_pass"
				| "invalid_timestamp";
	  };

export type WorkflowShipClaimsResolution =
	| { valid: true }
	| { valid: false; reason: string };

export interface WorkflowSourceEventInput {
	project: string;
	sourceEventId: string;
	kind: "founder_approval" | "founder_feedback" | "turn_grant";
	payloadJson: string;
	payloadDigest: string;
	schemaVersion: number;
}

export type WorkflowSourceApplyResult =
	| {
			kind: "founder_claim";
			status: "applied" | "replayed";
			claimId: number;
	  }
	| {
			kind: "founder_feedback";
			status: "applied" | "replayed";
	  }
	| {
			kind: "turn_project_history";
			status: "applied" | "replayed";
	  }
	| {
			kind: "turn_run_event";
			status: "applied" | "replayed";
	  };

// ── FLY-1232 module ②: shadow batch + side-effect ledger types ─────────────

export type WorkflowSideEffectState =
	| "intent_recorded"
	| "launch_committed"
	| "started"
	| "abandoned";

export interface WorkflowSideEffectRow {
	id: number;
	run_id: string;
	node_id: string;
	attempt: number;
	kind: string;
	launch_ordinal: number;
	execution_id: string;
	state: WorkflowSideEffectState;
	reason: string | null;
	created_at: string;
	updated_at: string;
	committed_at: string | null;
	started_at: string | null;
	abandoned_at: string | null;
}

export type WorkflowMaterializationReceiptStage =
	| "intent_pinned"
	| "commit_adopted"
	| "push_confirmed";

export interface WorkflowMaterializationReceiptRow {
	id: number;
	effect_id: string;
	stage: WorkflowMaterializationReceiptStage;
	run_id: string | null;
	node_id: string | null;
	attempt: number | null;
	output_id: number | null;
	output_digest: string | null;
	repo: string | null;
	ref: string | null;
	base_head: string | null;
	tree_head: string | null;
	commit_head: string | null;
	remote_head: string | null;
	created_at: string;
}

export interface WorkflowMaterializationRow extends WorkflowSideEffectRow {
	effect_id: string;
	intent: WorkflowMaterializationReceiptRow;
}

/** One operation inside a shadow batch — see applyWorkflowShadowBatch. */
export type WorkflowShadowOp =
	| {
			op: "edge";
			from: string;
			to: string;
			attempt: number;
			executionId?: string;
	  }
	| { op: "dispatch"; node: string; attempt: number; executionId: string }
	| { op: "wake"; node: string; attempt: number; executionId: string }
	| { op: "complete"; node: string; attempt: number; executionId: string }
	| { op: "kickback"; round: number }
	| { op: "finalize" }
	| {
			op: "side_effect";
			node: string;
			attempt: number;
			executionId: string;
			to: "launch_committed" | "started" | "abandoned";
			reason?: string;
	  };

export interface WorkflowShadowBatchInput {
	projectName: string;
	issueId: string;
	/** Used ONLY when no active shadow run exists for (project, issue). */
	newRunId?: string;
	/** Explicit run targeting (ANY status; never creates) — the evidence
	 * reconcile's path onto rows whose run already completed (R1 #3). */
	runId?: string;
	/** Ownership fence for an explicit run. Engine dispatcher passes 1; the
	 * observation-only shadow reconciler passes 0. */
	expectedEngineOwned?: 0 | 1;
	ops: WorkflowShadowOp[];
}

export interface WorkflowShadowBatchResult {
	runId: string;
	created: boolean;
	/** Writer-allocated ordinal per "dispatch" op, in ops order. */
	dispatchOrdinals: number[];
	events: { eventUid: string; seq: number; deduped: boolean }[];
}

export interface LeadEventRow {
	seq: number;
	lead_id: string;
	event_id: string;
	event_type: string;
	payload: string;
	session_key?: string;
	delivered_at?: string;
	created_at: string;
	delivery_attempts?: number;
	last_delivery_error?: string;
	ack_required?: boolean;
	ack_policy?: LeadEventAckPolicy;
	ack_protocol_version?: number;
	ack_deadline_at?: string;
	acked_at?: string;
	dead_letter_pending_at?: string;
	dead_lettered_at?: string;
	ack_token_valid_until?: string;
	ack_token_consumed_at?: string;
	ingress_disposed_at?: string;
	ack_retired_at?: string;
	ack_retired_reason?: string;
	routing_snapshot?: string;
	ack_owner_lead_id?: string;
	ack_owner_epoch?: number;
	pending_delivery_reason?: "owner_transfer" | "secret_rotation";
	page_claim_token?: string;
	page_claim_lease_expires_at?: string;
}

export type LeadEventDeliveryReason =
	| "initial"
	| "ack_timeout"
	| "owner_transfer"
	| "secret_rotation";

export interface LeadEventDeliveryAttemptRow {
	attempt_id: string;
	event_seq: number;
	attempt_no: number;
	kind: "initial" | "reminder";
	reason: LeadEventDeliveryReason;
	counts_toward_redelivery: number;
	claim_token: string;
	owner_epoch_at_claim: number;
	secret_id_at_claim: string;
	reclaim_count: number;
	last_reclaimed_at: string | null;
	lease_expires_at: string;
	claimed_at: string;
	pushed_at: string | null;
	finalized_at: string | null;
	outcome: "pushed" | "failed" | null;
	last_error: string | null;
	retired_at: string | null;
}

export interface DeliverySecretState {
	state: "PREPARED" | "ACTIVE";
	activeSecretId: string | null;
	preparedSecretId: string | null;
}

function mapLeadEventRow(row: Record<string, unknown>): LeadEventRow {
	return {
		seq: Number(row.seq),
		lead_id: String(row.lead_id),
		event_id: String(row.event_id),
		event_type: String(row.event_type),
		payload: String(row.payload),
		session_key: (row.session_key as string | null) ?? undefined,
		delivered_at: (row.delivered_at as string | null) ?? undefined,
		created_at: String(row.created_at),
		delivery_attempts: Number(row.delivery_attempts ?? 0),
		last_delivery_error:
			(row.last_delivery_error as string | null) ?? undefined,
		ack_required: Number(row.ack_required ?? 0) === 1,
		ack_policy: (row.ack_policy as LeadEventAckPolicy | null) ?? undefined,
		ack_protocol_version:
			row.ack_protocol_version == null
				? undefined
				: Number(row.ack_protocol_version),
		ack_deadline_at: (row.ack_deadline_at as string | null) ?? undefined,
		acked_at: (row.acked_at as string | null) ?? undefined,
		dead_letter_pending_at:
			(row.dead_letter_pending_at as string | null) ?? undefined,
		dead_lettered_at: (row.dead_lettered_at as string | null) ?? undefined,
		ack_token_valid_until:
			(row.ack_token_valid_until as string | null) ?? undefined,
		ack_token_consumed_at:
			(row.ack_token_consumed_at as string | null) ?? undefined,
		ingress_disposed_at:
			(row.ingress_disposed_at as string | null) ?? undefined,
		ack_retired_at: (row.ack_retired_at as string | null) ?? undefined,
		ack_retired_reason: (row.ack_retired_reason as string | null) ?? undefined,
		routing_snapshot: (row.routing_snapshot as string | null) ?? undefined,
		ack_owner_lead_id: (row.ack_owner_lead_id as string | null) ?? undefined,
		ack_owner_epoch: Number(row.ack_owner_epoch ?? 0),
		pending_delivery_reason:
			(row.pending_delivery_reason as
				| "owner_transfer"
				| "secret_rotation"
				| null) ?? undefined,
		page_claim_token: (row.page_claim_token as string | null) ?? undefined,
		page_claim_lease_expires_at:
			(row.page_claim_lease_expires_at as string | null) ?? undefined,
	};
}

/** FLY-368: a row of the alert_threads active-mapping table. */
/**
 * FLY-1082 (Codex R5): the server-loss episode's durable side-effect state —
 * the per-Lead notification OUTBOX (notified / failed-after-retries / attempt
 * counts), the ticket phase, the loss shape (replay renders the right copy),
 * and the claimed exec ids. Every field must survive a Bridge crash so no
 * owed side effect is lost and none is duplicated.
 */
export interface ServerLossEpisodeState {
	shape: "server_down" | "server_fresh";
	claimed: string[];
	ticketDone: boolean;
	notifiedLeads: string[];
	/** Leads whose notification failed ≥3 attempts — surfaced via the ticket's
	 * leadsFailed metadata (→ needs_human escalation); no further retries. */
	failedLeads: string[];
	notifyAttempts: Record<string, number>;
}

export type TmuxHoldReason =
	| "saturated"
	| "split_brain"
	| "ambiguous"
	| "unknown"
	| "rescue_failed"
	| "lock_unavailable";
export type TmuxHoldShape = "provisional" | "server_down" | "server_fresh";
export type TmuxHoldShapeSource = "observation" | "coordinator";

export interface TmuxHoldObservation {
	incidentId?: string;
	reason: TmuxHoldReason;
	shape: TmuxHoldShape;
	shapeSource: TmuxHoldShapeSource;
	evidence: Record<string, unknown>;
	affectedExecutionIds: string[];
}

export interface TmuxHoldRow {
	incidentId: string;
	normalizedSocketPath: string;
	shape: TmuxHoldShape;
	shapeSource: TmuxHoldShapeSource;
	currentReason: TmuxHoldReason;
	firstReason: TmuxHoldReason;
	reasonHistory: TmuxHoldReason[];
	evidence: Record<string, unknown>;
	affectedExecutionIds: string[];
	createdAt: string;
	lastCheckedAt: string;
	resolvedAt: string | null;
}

export interface TmuxHoldToServerLossTransition {
	normalizedSocketPath: string;
	incidentId: string;
	shape: Exclude<TmuxHoldShape, "provisional">;
	claimedExecutionIds: string[];
	leadIdsByExecutionId: Record<string, string>;
}

export interface AlertThreadRow {
	correlation_key: string;
	event_id: string;
	episode_signature: string | null;
	thread_id: string;
	root_message_id: string | null;
	channel_id: string;
	lead_id: string;
	project_name: string;
	event_type: string;
	session_key: string | null;
	repair_status: string | null;
	opened_at: string;
	resolved_at: string | null;
	/** FLY-927 ticket lifecycle (NEW/ACK/REPAIRING/RESOLVED/ESCALATED; NULL = legacy row). */
	ticket_status: string | null;
	/** FLY-927 owner ref (`infra_bot:claude` / `infra_bot:codex` / `lead:<id>`). */
	owner_ref: string | null;
	/** FLY-927 ARC attempts consumed toward the T2 (2-try) budget. */
	attempt_count: number;
	first_seen_at: string | null;
	acked_at: string | null;
}

function workflowAlertOutboxRow(
	row: Record<string, unknown>,
): WorkflowAlertOutboxRow {
	return {
		escalation_uid: row.escalation_uid as string,
		run_id: row.run_id as string,
		payload: JSON.parse(
			row.payload_json as string,
		) as WorkflowEngineAlertPayload,
		state: row.state as WorkflowAlertOutboxRow["state"],
		attempt: Number(row.attempt),
		lease_owner: (row.lease_owner as string) ?? null,
		lease_expires_at: (row.lease_expires_at as string) ?? null,
		generation: Number(row.generation),
		last_error: (row.last_error as string) ?? null,
		created_at: row.created_at as string,
		updated_at: row.updated_at as string,
	};
}

/**
 * FLY-846: normalize a caller-supplied issue key list (UUID/identifier mixed)
 * for the gate queries — trim, drop blanks, dedupe. Guarantees the dynamic
 * IN(...) placeholder list is never empty at the call sites (both queries
 * short-circuit on an empty result).
 */
function normalizeIssueKeys(keys: string[]): string[] {
	return [
		...new Set(keys.map((k) => k?.trim()).filter((k): k is string => !!k)),
	];
}

function rowToAlertThread(row: Record<string, unknown>): AlertThreadRow {
	return {
		correlation_key: row.correlation_key as string,
		event_id: row.event_id as string,
		episode_signature: (row.episode_signature as string) ?? null,
		thread_id: row.thread_id as string,
		root_message_id: (row.root_message_id as string) ?? null,
		channel_id: row.channel_id as string,
		lead_id: row.lead_id as string,
		project_name: row.project_name as string,
		event_type: row.event_type as string,
		session_key: (row.session_key as string) ?? null,
		repair_status: (row.repair_status as string) ?? null,
		opened_at: row.opened_at as string,
		resolved_at: (row.resolved_at as string) ?? null,
		ticket_status: (row.ticket_status as string) ?? null,
		owner_ref: (row.owner_ref as string) ?? null,
		attempt_count: (row.attempt_count as number) ?? 0,
		first_seen_at: (row.first_seen_at as string) ?? null,
		acked_at: (row.acked_at as string) ?? null,
	};
}

function rowToTmuxHold(row: Record<string, unknown>): TmuxHoldRow {
	const parseArray = <T>(raw: unknown): T[] => {
		try {
			const value = JSON.parse(String(raw));
			return Array.isArray(value) ? (value as T[]) : [];
		} catch {
			return [];
		}
	};
	let evidence: Record<string, unknown> = {};
	try {
		const value = JSON.parse(String(row.evidence_json));
		if (value && typeof value === "object" && !Array.isArray(value)) {
			evidence = value as Record<string, unknown>;
		}
	} catch {
		// Corrupt evidence is fail-closed empty metadata; the hold stays active.
	}
	return {
		incidentId: String(row.incident_id),
		normalizedSocketPath: String(row.normalized_socket_path),
		shape: row.shape as TmuxHoldShape,
		shapeSource: row.shape_source as TmuxHoldShapeSource,
		currentReason: row.current_reason as TmuxHoldReason,
		firstReason: row.first_reason as TmuxHoldReason,
		reasonHistory: parseArray<TmuxHoldReason>(row.reason_history_json),
		evidence,
		affectedExecutionIds: parseArray<string>(row.affected_execution_ids_json),
		createdAt: String(row.created_at),
		lastCheckedAt: String(row.last_checked_at),
		resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
	};
}
