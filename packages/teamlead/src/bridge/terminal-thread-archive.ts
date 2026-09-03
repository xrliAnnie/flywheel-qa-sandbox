/**
 * FLY-1282 Part C (folds FLY-1289): issue terminal-state thread auto-archive.
 *
 * When ALL of an issue's sessions reach a successful terminal state, its chat
 * thread should archive within minutes — not wait for a close_runner call
 * that may never come (FLY-1278/1255/1256: runners self-cleaned their
 * windows, close_runner returned "No session found", the cascade never fired)
 * or for the 6h FLY-1165 sweep.
 *
 * This module provides the ARCHIVE-ONLY TARGETED MODE (Codex R11 #3): a
 * per-issue eligibility check that is deliberately STRICTER and WEAKER than
 * the global sweep —
 *   - it can ONLY archive (never lifecycleCloseout, never husk-finalize,
 *     never any mutator besides `archiveThreadAndRecord`);
 *   - its state precondition is stricter: EVERY alias session row must be in
 *     {completed, terminated}; running / awaiting_review / approved_to_ship /
 *     design_done / pending / failed / blocked ALL veto (the global sweep
 *     lets failed/blocked pass — a completion-triggered check must not);
 *   - any alias row carrying an unresolved FLY-208 evidence-gap marker vetoes
 *     (FLY-210/manual close owns those — Codex R12 #3);
 *   - an UNDISCHARGED launch claim vetoes: a starting|active claim whose
 *     execution has no session row yet, or whose row is non-terminal, is an
 *     admitted-but-not-yet-visible successor (Codex R12 #2 / R13 #1 — a
 *     lingering active claim whose row IS terminal counts as discharged,
 *     because normal completion never closes claims);
 *   - the final decision runs inside the canonical issue lock (injected by
 *     the composition root from the lifecycle guard), with post-probe
 *     re-reads and a fresh Linear re-check immediately before the sink.
 *
 * Consumption/retry lifecycle lives in the FLY-1165 scheduler (extended with
 * `enqueue` — see done-thread-reconcile.ts); this module is the pure check.
 */

import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type {
	ArchiveChatThreadResult,
	archiveChatThread,
} from "./chat-thread-utils.js";
import {
	archiveThreadAndRecord,
	resolveBotTokenForThread,
} from "./done-thread-archiver.js";
import type { ReconcileLinearLookup } from "./done-thread-reconcile.js";
import { lookupLinearIssueByIdentifier } from "./linear-query.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
} from "./tmux-lookup.js";

/** Successful terminal states — the "全段 completed" auditable definition. */
const ALLOWED_TERMINAL = new Set(["completed", "terminated"]);
const DONE_STATE_TYPES = new Set(["completed", "canceled"]);

export type TargetedArchiveOutcome =
	| { kind: "archived"; threadId: string }
	| { kind: "already_archived" }
	| { kind: "deferred_quiet_window" }
	| { kind: "thread_missing" }
	| { kind: "vetoed_active"; executionId: string }
	| { kind: "vetoed_status"; executionId: string; status: string }
	| { kind: "vetoed_claim"; executionId: string }
	| { kind: "vetoed_evidence_gap"; executionId: string }
	| { kind: "vetoed_linear"; stateType?: string }
	| { kind: "dry_run_would_archive"; threadId: string }
	| { kind: "transient_error"; error: string };

/** Retryable outcomes stay in the scheduler queue with backoff. */
export function isRetryableOutcome(o: TargetedArchiveOutcome): boolean {
	return (
		o.kind === "vetoed_active" ||
		o.kind === "deferred_quiet_window" ||
		o.kind === "vetoed_status" ||
		o.kind === "vetoed_claim" ||
		o.kind === "vetoed_evidence_gap" ||
		o.kind === "vetoed_linear" ||
		o.kind === "dry_run_would_archive" ||
		o.kind === "transient_error"
	);
}

/** Translate the sink's truthful Discord result into scheduler semantics. */
export function mapArchiveSinkResult(
	result: ArchiveChatThreadResult,
	threadId: string,
): TargetedArchiveOutcome {
	if (result.reason === "already_archived") return { kind: "already_archived" };
	if (result.archived) return { kind: "archived", threadId };
	if (result.reason === "deferred_quiet_window") {
		return { kind: "deferred_quiet_window" };
	}
	if (result.reason === "in_active_use") {
		return result.activeExecutionId
			? { kind: "vetoed_active", executionId: result.activeExecutionId }
			: {
					kind: "transient_error",
					error: "archive sink: in_active_use missing activeExecutionId",
				};
	}
	if (result.reason === "missing") return { kind: "thread_missing" };
	return {
		kind: "transient_error",
		error: `archive sink: ${result.reason}${result.error ? ` (${result.error})` : ""}`,
	};
}

export interface TargetedArchiveDeps {
	store: StateStore;
	projects: ProjectEntry[];
	linearApiKey?: string;
	globalBotToken?: string;
	discordOwnerUserId?: string;
	dryRun: boolean;
	/**
	 * Canonical per-issue lock (composition wires the lifecycle guard's
	 * resolveLockKeys + withIssueMutex so admission/close/this-check serialize
	 * on the same keys). Absent (tests) → direct execution.
	 */
	withIssueLock?: <T>(issueId: string, fn: () => Promise<T>) => Promise<T>;
	// Seams (default to the real implementations).
	lookupIssue?: ReconcileLinearLookup;
	archiveSinkFn?: typeof archiveThreadAndRecord;
	archiveFn?: typeof archiveChatThread;
	fetchImpl?: typeof fetch;
	lookupTarget?: typeof lookupTmuxTarget;
	probeLiveness?: (tmuxWindow: string) => Promise<RunnerLiveness>;
	log?: (msg: string) => void;
}

interface AliasSnapshot {
	rows: Array<{
		execution_id: string;
		status: string;
		project_name: string;
	}>;
	claims: Array<{ executionId: string; state: "starting" | "active" }>;
	/** Stable fingerprint for the post-probe change check (R12 #2). */
	fingerprint: string;
}

export async function runTargetedArchiveCheck(
	issueId: string,
	deps: TargetedArchiveDeps,
): Promise<TargetedArchiveOutcome> {
	const run = () => runInsideLock(issueId, deps);
	try {
		if (deps.withIssueLock) return await deps.withIssueLock(issueId, run);
		return await run();
	} catch (err) {
		return {
			kind: "transient_error",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function runInsideLock(
	issueId: string,
	deps: TargetedArchiveDeps,
): Promise<TargetedArchiveOutcome> {
	const { store, projects } = deps;
	const log =
		deps.log ?? ((m: string) => console.log(`[terminal-archive] ${m}`));
	const lookupIssue = deps.lookupIssue ?? lookupLinearIssueByIdentifier;
	const lookupTarget = deps.lookupTarget ?? lookupTmuxTarget;
	const probeLiveness = deps.probeLiveness ?? probeRunnerProcessLiveness;

	// ── Fresh Linear double gate (identifier OR UUID accepted). ──
	if (!deps.linearApiKey) {
		return { kind: "transient_error", error: "no linear api key" };
	}
	let linear: Awaited<ReturnType<ReconcileLinearLookup>>;
	try {
		linear = await lookupIssue(deps.linearApiKey, issueId);
	} catch (err) {
		return { kind: "transient_error", error: (err as Error).message };
	}
	if (!linear) return { kind: "transient_error", error: "linear lookup empty" };
	if (!DONE_STATE_TYPES.has(linear.stateType)) {
		return { kind: "vetoed_linear", stateType: linear.stateType };
	}
	const aliasKeys = [
		...new Set([issueId, linear.id, linear.identifier].filter(Boolean)),
	];

	// ── Snapshot #1: alias rows + open launch claims (inside the lock). ──
	const snapshot = readAliasSnapshot(store, aliasKeys, linear.id);
	const stateVeto = checkStatePreconditions(store, snapshot);
	if (stateVeto) return stateVeto;

	// ── Pane liveness across ALL alias rows (alive/indeterminate/error veto). ──
	for (const row of snapshot.rows) {
		let lookup: ReturnType<typeof lookupTmuxTarget>;
		try {
			lookup = lookupTarget(row.execution_id, row.project_name);
		} catch {
			return { kind: "vetoed_active", executionId: row.execution_id };
		}
		if (lookup.kind === "error") {
			return { kind: "vetoed_active", executionId: row.execution_id };
		}
		if (lookup.kind === "gone") continue;
		let liveness: RunnerLiveness;
		try {
			liveness = await probeLiveness(lookup.target.tmuxWindow);
		} catch {
			return { kind: "vetoed_active", executionId: row.execution_id };
		}
		if (liveness === "alive" || liveness === "indeterminate") {
			return { kind: "vetoed_active", executionId: row.execution_id };
		}
	}

	// ── Post-probe re-read (R12 #2): the alias/claim set must be UNCHANGED
	// after the async probes — a pending successor inserted mid-probe wins. ──
	const recheck = readAliasSnapshot(store, aliasKeys, linear.id);
	if (recheck.fingerprint !== snapshot.fingerprint) {
		return {
			kind: "transient_error",
			error: "alias/claim set changed during probes",
		};
	}
	const stateVeto2 = checkStatePreconditions2(store, recheck);
	if (stateVeto2) return stateVeto2;

	// ── Thread lookup: UUID + identifier canonicalized; terminal
	// thread_missing ONLY when every alias misses (R12 #2). ──
	const aliasSet = new Set(aliasKeys);
	const threads = store
		.getUnarchivedIssueChatThreads()
		.filter((t) => aliasSet.has(t.issue_id));
	if (threads.length === 0) {
		// Distinguish "never had a thread / all archived" — archive-once means
		// an already-archived thread is a terminal success for the queue.
		return { kind: "thread_missing" };
	}

	// ── Fresh Linear re-check immediately before the sink (reopen wins). ──
	try {
		const relinear = await lookupIssue(deps.linearApiKey, issueId);
		if (!relinear || !DONE_STATE_TYPES.has(relinear.stateType)) {
			return { kind: "vetoed_linear", stateType: relinear?.stateType };
		}
	} catch (err) {
		return { kind: "transient_error", error: (err as Error).message };
	}

	// ── Archive (single token-bearing sink; archive-once inside). ──
	const thread = threads[0];
	if (!thread) return { kind: "thread_missing" };
	const projectNames = [
		...new Set(snapshot.rows.map((r) => r.project_name).filter(Boolean)),
	];
	const projectName =
		projectNames.length === 1
			? projectNames[0]
			: projects.find((p) =>
					p.leads?.some(
						(l) =>
							l.agentId === thread.lead_id &&
							l.chatChannel === thread.channel_id,
					),
				)?.projectName;
	if (!projectName) {
		return { kind: "transient_error", error: "ambiguous project resolution" };
	}
	const firstRow = snapshot.rows[0];
	const botToken = resolveBotTokenForThread(projects, {
		projectName,
		leadId: thread.lead_id,
		labels: firstRow ? store.getSessionLabels(firstRow.execution_id) : [],
		fallbackBotToken: deps.globalBotToken,
	});
	if (!botToken) {
		return { kind: "transient_error", error: "no bot token resolvable" };
	}
	if (deps.dryRun) {
		log(`dry-run: would archive ${thread.thread_id} for ${issueId}`);
		return { kind: "dry_run_would_archive", threadId: thread.thread_id };
	}
	const sink = deps.archiveSinkFn ?? archiveThreadAndRecord;
	const sinkResult = await sink(
		store,
		{
			threadId: thread.thread_id,
			issueId: thread.issue_id,
			projectName,
			executionId: firstRow?.execution_id ?? `terminal-archive-${issueId}`,
		},
		botToken,
		{
			authority: "terminal",
			archiveFn: deps.archiveFn,
			discordOwnerUserId: deps.discordOwnerUserId,
			fetchImpl: deps.fetchImpl,
			auditSource: "bridge.terminal-thread-archive",
		},
	);
	return mapArchiveSinkResult(sinkResult, thread.thread_id);
}

function readAliasSnapshot(
	store: StateStore,
	aliasKeys: string[],
	rootUuid: string,
): AliasSnapshot {
	const rows = store.getSessionsForIssueAliases(aliasKeys);
	// Code R1 #2: a claims read error is NOT proof of "no claims" — swallowing
	// it here would fail OPEN (an admitted-but-invisible successor could be
	// archived over). Let it throw: runTargetedArchiveCheck maps any escape to
	// transient_error, which stays in the retry queue.
	const claims: AliasSnapshot["claims"] = store
		.listOpenLaunchClaims(rootUuid)
		.map((c) => ({ executionId: c.executionId, state: c.state }));
	const fingerprint = JSON.stringify([
		rows.map((r) => [r.execution_id, r.status]).sort(),
		claims.map((c) => [c.executionId, c.state]).sort(),
	]);
	return {
		rows: rows.map((r) => ({
			execution_id: r.execution_id,
			status: r.status,
			project_name: r.project_name,
		})),
		claims,
		fingerprint,
	};
}

function checkStateVeto(
	store: StateStore,
	snapshot: AliasSnapshot,
): TargetedArchiveOutcome | null {
	for (const row of snapshot.rows) {
		if (!ALLOWED_TERMINAL.has(row.status)) {
			return {
				kind: "vetoed_status",
				executionId: row.execution_id,
				status: row.status,
			};
		}
		// FLY-208 evidence-gap marker: completion without merge proof — owned
		// by FLY-210/manual close, never auto-archived past (Codex R12 #3).
		const full = store.getSession(row.execution_id);
		const params = full?.session_params;
		if (params?.includes("fly208_evidence_gap")) {
			return { kind: "vetoed_evidence_gap", executionId: row.execution_id };
		}
	}
	// Undischarged launch claims veto (R13 #1: discharged = the claim's
	// execution row exists AND is in the allowed terminal set).
	const rowByExec = new Map(snapshot.rows.map((r) => [r.execution_id, r]));
	for (const claim of snapshot.claims) {
		const row = rowByExec.get(claim.executionId);
		if (!row || !ALLOWED_TERMINAL.has(row.status)) {
			return { kind: "vetoed_claim", executionId: claim.executionId };
		}
	}
	return null;
}

// Two thin named wrappers keep the two call sites self-documenting.
const checkStatePreconditions = checkStateVeto;
const checkStatePreconditions2 = checkStateVeto;

// ── Pre-binding enqueue buffer (Codex R11 #5) ───────────────────────────────

/**
 * The composition root creates this BEFORE DirectEventSink / createBridgeApp
 * exist; the FLY-1165 scheduler binds as consumer later. Enqueues arriving
 * before the bind are retained (bounded) and flushed on bind — completion
 * events during boot are not lost.
 */
export type TerminalArchiveAdmission = "accepted" | "deduped" | "refused";

export interface TerminalArchiveEnqueue {
	enqueue(issueId: string): TerminalArchiveAdmission;
	bind(consumer: (issueId: string) => TerminalArchiveAdmission): void;
}

export function createTerminalArchiveEnqueueBuffer(
	capacity = 64,
	log: (msg: string) => void = (m) =>
		console.log(`[terminal-archive-enqueue] ${m}`),
): TerminalArchiveEnqueue {
	const pending: string[] = [];
	let consumer: ((issueId: string) => TerminalArchiveAdmission) | null = null;
	return {
		enqueue(issueId: string) {
			if (consumer) {
				return consumer(issueId);
			}
			if (pending.includes(issueId)) return "deduped"; // dedup while buffered
			if (pending.length >= capacity) {
				log(
					`buffer full (${capacity}) — REFUSING enqueue for ${issueId}; periodic sweep is the backstop when enabled`,
				);
				return "refused";
			}
			pending.push(issueId);
			return "accepted";
		},
		bind(c: (issueId: string) => TerminalArchiveAdmission) {
			consumer = c;
			for (const issueId of pending.splice(0)) c(issueId);
		},
	};
}
