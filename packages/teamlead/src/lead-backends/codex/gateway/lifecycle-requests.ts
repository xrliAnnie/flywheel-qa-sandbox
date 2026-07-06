/**
 * FLY-245 Phase D-f — the PERSISTENT lifecycle request state machine + crash
 * recovery (plan §5.2, Codex R1#6).
 *
 * Why this exists: the naive `verify → UPDATE resolved_at → HTTP action` flow is
 * CONSUME-BEFORE-SIDE-EFFECT — a crash/timeout after the claim leaves the consent
 * permanently consumed with the real outcome unknown, and a timeout can mask an
 * action that actually landed. So every gateway lifecycle request lives in a
 * DURABLE better-sqlite3 state machine (same per-Lead state-dir pattern as
 * FLY-224's SqliteJournalStore / SqliteOutboundDedupStore):
 *
 *   requested → confirmed → claimed → executing → succeeded
 *                                              ↘ failed_retryable | ambiguous
 *
 * Persisted per request: the gateway request id (PK), the CommDB question id, the
 * full binding (execId / action / lifecycle_revision / nonce / project / leadId),
 * the confirmation message's channel+message id (so a restarted gateway RESUMES
 * the reaction poll, §5.6), the TTL, and the outcome.
 *
 * Restart recovery (`recoverLifecycleRequests`) — the R1#6 contract:
 *   - unexpired `requested` / `confirmed` are RESUMED (observe / execute);
 *   - `claimed` / `executing` are NEVER blindly replayed — an action-specific
 *     postcondition check (§5.2.1 table) decides the real outcome:
 *       reached        → succeeded (the action already landed)
 *       retry_safe     → caller re-drives (idempotent actions only)
 *       needs_reconfirm→ ambiguous — founder must re-confirm via a NEW request
 *   - `ambiguous` rows are never auto-replayed.
 *
 * Hard ordering invariant (documented for recovery correctness): the CommDB
 * atomic claim (`claimLifecycleConsent`, D-b) happens BEFORE the store's
 * `confirmed→claimed` transition. A persisted `claimed` row therefore implies the
 * consent was consumed; a crash between the claim and the store write leaves the
 * row `confirmed`, whose recovery re-runs the claim and loses (`claim_lost`,
 * fail-closed — the founder re-confirms; at-most-once beats convenience for
 * irreversible actions).
 *
 * All side-effectful dependencies (verify = D-c, claim = D-b, revision reader,
 * the HTTP dispatch to the canonical `/api/actions/*` endpoint — ALWAYS with
 * leadId) are injected; the real wiring is Phase F. `retry` (the one
 * non-idempotent action) gets its real reconciler in D2 — until then its
 * postcondition is fail-closed `needs_reconfirm`.
 */

import Database from "better-sqlite3";

export type LifecycleRequestState =
	| "requested"
	| "confirmed"
	| "claimed"
	| "executing"
	| "succeeded"
	| "failed_retryable"
	| "ambiguous";

/** Terminal states: no further transitions, not surfaced by recovery. An
 * `ambiguous` row is NOT terminal in the "needs attention" sense — it is
 * surfaced as needs_reconfirm — but it accepts no further transitions either
 * (resolution = a NEW request after founder re-confirmation). */
const TERMINAL_STATES: ReadonlySet<LifecycleRequestState> = new Set([
	"succeeded",
	"failed_retryable",
]);

/** Legal state-machine edges (plan §5.2). Anything else throws. */
const LEGAL_TRANSITIONS: Readonly<
	Record<LifecycleRequestState, readonly LifecycleRequestState[]>
> = {
	requested: ["confirmed", "failed_retryable"],
	confirmed: ["claimed", "failed_retryable"],
	claimed: ["executing", "succeeded", "failed_retryable", "ambiguous"],
	executing: ["succeeded", "failed_retryable", "ambiguous"],
	succeeded: [],
	failed_retryable: [],
	ambiguous: [],
};

export interface LifecycleRequestRecord {
	requestId: string;
	questionId: string;
	action: string;
	execId: string;
	lifecycleRevision: number;
	nonce: string;
	project: string;
	leadId: string;
	channelId: string | null;
	messageId: string | null;
	/** D2 (plan §5.2.1): the gateway PRE-BOUND successor execution id for a
	 * `retry` request — durably bound before the HTTP dispatch so recovery can
	 * reconcile/re-drive by key. Null for every other action. */
	successorExecId: string | null;
	state: LifecycleRequestState;
	outcome: string | null;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

interface Row {
	request_id: string;
	question_id: string;
	action: string;
	exec_id: string;
	lifecycle_revision: number;
	nonce: string;
	project: string;
	lead_id: string;
	channel_id: string | null;
	message_id: string | null;
	successor_exec_id: string | null;
	state: string;
	outcome: string | null;
	expires_at: number;
	created_at: number;
	updated_at: number;
}

function toRecord(r: Row): LifecycleRequestRecord {
	return {
		requestId: r.request_id,
		questionId: r.question_id,
		action: r.action,
		execId: r.exec_id,
		lifecycleRevision: r.lifecycle_revision,
		nonce: r.nonce,
		project: r.project,
		leadId: r.lead_id,
		channelId: r.channel_id,
		messageId: r.message_id,
		successorExecId: r.successor_exec_id,
		state: r.state as LifecycleRequestState,
		outcome: r.outcome,
		expiresAt: r.expires_at,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export class LifecycleRequestStore {
	private readonly db: Database.Database;
	private readonly now: () => number;

	constructor(dbPath: string, now: () => number = () => Date.now()) {
		this.now = now;
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS lifecycle_requests (
				request_id TEXT PRIMARY KEY,
				question_id TEXT NOT NULL,
				action TEXT NOT NULL,
				exec_id TEXT NOT NULL,
				lifecycle_revision INTEGER NOT NULL,
				nonce TEXT NOT NULL,
				project TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				channel_id TEXT,
				message_id TEXT,
				successor_exec_id TEXT,
				state TEXT NOT NULL,
				outcome TEXT,
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
	}

	close(): void {
		this.db.close();
	}

	/** Register a new lifecycle request (state=requested). Throws on a duplicate
	 * request id — gateway request ids are unique by construction. */
	create(req: {
		requestId: string;
		questionId: string;
		action: string;
		execId: string;
		lifecycleRevision: number;
		nonce: string;
		project: string;
		leadId: string;
		ttlMs: number;
	}): void {
		const t = this.now();
		this.db
			.prepare(
				`INSERT INTO lifecycle_requests
				 (request_id, question_id, action, exec_id, lifecycle_revision, nonce,
				  project, lead_id, state, expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
			)
			.run(
				req.requestId,
				req.questionId,
				req.action,
				req.execId,
				req.lifecycleRevision,
				req.nonce,
				req.project,
				req.leadId,
				t + req.ttlMs,
				t,
				t,
			);
	}

	get(requestId: string): LifecycleRequestRecord | undefined {
		const r = this.db
			.prepare("SELECT * FROM lifecycle_requests WHERE request_id = ?")
			.get(requestId) as Row | undefined;
		return r ? toRecord(r) : undefined;
	}

	/** Persist the confirmation message identity right after the Discord send, so
	 * a restarted gateway resumes the reaction poll from durable state (§5.6). */
	setConfirmationMessage(
		requestId: string,
		channelId: string,
		messageId: string,
	): void {
		this.db
			.prepare(
				"UPDATE lifecycle_requests SET channel_id = ?, message_id = ?, updated_at = ? WHERE request_id = ?",
			)
			.run(channelId, messageId, this.now(), requestId);
	}

	/**
	 * D2 (plan §5.2.1): durably bind the pre-allocated successor execution id
	 * for a `retry` request BEFORE the HTTP dispatch. Write-once: re-binding the
	 * SAME id is an idempotent success (replay-safe); binding a DIFFERENT id is
	 * refused (`false`) — one request converges to exactly one successor, ever.
	 */
	bindSuccessorExecId(requestId: string, execId: string): boolean {
		const res = this.db
			.prepare(
				`UPDATE lifecycle_requests
				 SET successor_exec_id = ?, updated_at = ?
				 WHERE request_id = ?
				   AND (successor_exec_id IS NULL OR successor_exec_id = ?)`,
			)
			.run(execId, this.now(), requestId, execId);
		return res.changes === 1;
	}

	/**
	 * CAS state transition: applies ONLY if the row is currently in `from`
	 * (`changes === 1` is the single winner — same discipline as D-b's atomic
	 * claim). Returns false when the row is missing or in a different state.
	 * An edge not in the legal state machine THROWS — that is a programming
	 * error, never a race.
	 */
	transition(
		requestId: string,
		from: LifecycleRequestState,
		to: LifecycleRequestState,
		outcome?: string,
	): boolean {
		if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
			throw new Error(
				`LifecycleRequestStore: illegal transition ${from} → ${to} (request ${requestId})`,
			);
		}
		const res = this.db
			.prepare(
				`UPDATE lifecycle_requests
				 SET state = ?, outcome = COALESCE(?, outcome), updated_at = ?
				 WHERE request_id = ? AND state = ?`,
			)
			.run(to, outcome ?? null, this.now(), requestId, from);
		return res.changes === 1;
	}

	/** All rows recovery must look at: everything except the terminal states. */
	listNonTerminal(): LifecycleRequestRecord[] {
		const terminals = [...TERMINAL_STATES];
		const placeholders = terminals.map(() => "?").join(",");
		const rows = this.db
			.prepare(
				`SELECT * FROM lifecycle_requests WHERE state NOT IN (${placeholders}) ORDER BY created_at`,
			)
			.all(...terminals) as Row[];
		return rows.map(toRecord);
	}
}

// ── Crash recovery (plan §5.2) ───────────────────────────────────────────────

/** What the action-specific §5.2.1 postcondition check can conclude. The
 * verifier itself encodes whether re-execution is safe (idempotent classes) —
 * recovery only maps verdicts to state transitions. */
export type PostconditionVerdict = "reached" | "retry_safe" | "needs_reconfirm";

export type RecoveryDecision =
	/** requested, unexpired, confirmation message persisted → resume the poll. */
	| "resume_observe"
	/** requested, unexpired, but the message was never (durably) sent. */
	| "resend_confirmation"
	/** confirmed, unexpired → proceed verify→claim→execute. */
	| "resume_execute"
	/** requested/confirmed past TTL → killed (consent never claimed). */
	| "expired"
	/** claimed/executing whose postcondition shows the action already landed. */
	| "already_succeeded"
	/** claimed/executing, idempotent, not yet landed → caller re-drives. */
	| "retry_safe_reexecute"
	/** ambiguous (existing or newly concluded) → founder must re-confirm. */
	| "needs_reconfirm";

export interface RecoveryReportEntry {
	requestId: string;
	decision: RecoveryDecision;
	row: LifecycleRequestRecord;
}

export interface RecoveryDeps {
	now: () => number;
	/** Action-specific §5.2.1 postcondition for a claimed/executing row. A throw
	 * is fail-closed (→ ambiguous). */
	postcondition: (
		row: LifecycleRequestRecord,
	) => Promise<PostconditionVerdict> | PostconditionVerdict;
}

/**
 * Classify every non-terminal persisted request after a gateway restart.
 * NEVER blindly replays: claimed/executing outcomes are decided by the
 * action-specific postcondition; anything unprovable is ambiguous and requires
 * a fresh founder confirmation.
 */
export async function recoverLifecycleRequests(
	store: LifecycleRequestStore,
	deps: RecoveryDeps,
): Promise<RecoveryReportEntry[]> {
	const report: RecoveryReportEntry[] = [];
	for (const row of store.listNonTerminal()) {
		if (row.state === "ambiguous") {
			report.push({
				requestId: row.requestId,
				decision: "needs_reconfirm",
				row,
			});
			continue;
		}

		if (row.state === "requested" || row.state === "confirmed") {
			if (deps.now() > row.expiresAt) {
				store.transition(
					row.requestId,
					row.state,
					"failed_retryable",
					"expired",
				);
				report.push({ requestId: row.requestId, decision: "expired", row });
				continue;
			}
			const decision: RecoveryDecision =
				row.state === "confirmed"
					? "resume_execute"
					: row.messageId
						? "resume_observe"
						: "resend_confirmation";
			report.push({ requestId: row.requestId, decision, row });
			continue;
		}

		// claimed / executing — consent consumed, outcome unknown. Postcondition
		// decides; a throw is fail-closed ambiguous.
		let verdict: PostconditionVerdict;
		try {
			verdict = await deps.postcondition(row);
		} catch {
			verdict = "needs_reconfirm";
		}
		if (verdict === "reached") {
			store.transition(
				row.requestId,
				row.state,
				"succeeded",
				"recovered_postcondition",
			);
			report.push({
				requestId: row.requestId,
				decision: "already_succeeded",
				row,
			});
		} else if (verdict === "retry_safe") {
			report.push({
				requestId: row.requestId,
				decision: "retry_safe_reexecute",
				row,
			});
		} else {
			store.transition(
				row.requestId,
				row.state,
				"ambiguous",
				"recovery_unprovable",
			);
			report.push({
				requestId: row.requestId,
				decision: "needs_reconfirm",
				row,
			});
		}
	}
	return report;
}

// ── Execution flow (plan §5.2 / §5.3) ────────────────────────────────────────

/** Outcome of the injected HTTP dispatch to the canonical `/api/actions/*`
 * endpoint (Phase F binds this; the request ALWAYS carries leadId). */
export type DispatchOutcome =
	| { kind: "success" }
	/** Provably never reached the Bridge (e.g. connect refused) → retryable. */
	| { kind: "not_dispatched"; detail?: string }
	/** Sent but outcome unknown (timeout / 5xx after send) → ambiguous. */
	| { kind: "unknown"; detail?: string };

export interface ExecuteResult {
	executed: boolean;
	finalState: LifecycleRequestState;
}

export interface ClaimedExecuteDeps {
	/** The session's CURRENT lifecycle revision (undefined = unreadable →
	 * fail-closed). Re-checked AFTER the claim, BEFORE dispatch (§5.1). */
	currentRevision: () => number | undefined | Promise<number | undefined>;
	dispatch: () => Promise<DispatchOutcome>;
}

export interface ConfirmedExecuteDeps extends ClaimedExecuteDeps {
	/** D-c `verifyLifecycleConsent`, bound to this request's args. */
	verify: () => { allowed: boolean; reason: string };
	/** D-b `claimLifecycleConsent`, bound to this question — the atomic
	 * single-consume. MUST be invoked before the store's claimed transition
	 * (see the ordering invariant in the module doc). */
	claim: () => boolean;
}

/**
 * Drive a `confirmed` request through verify → atomic claim → post-claim
 * revision re-check → dispatch. Every refusal is fail-closed and persisted.
 */
export async function executeConfirmedRequest(
	store: LifecycleRequestStore,
	requestId: string,
	deps: ConfirmedExecuteDeps,
): Promise<ExecuteResult> {
	const row = store.get(requestId);
	if (!row || row.state !== "confirmed") {
		return { executed: false, finalState: row?.state ?? "failed_retryable" };
	}

	// 1. Verify the full consent binding (D-c). Deny/throw → fail-closed, the
	// consent is NOT consumed.
	let verdict: { allowed: boolean; reason: string };
	try {
		verdict = deps.verify();
	} catch (err) {
		verdict = { allowed: false, reason: `threw:${(err as Error).message}` };
	}
	if (!verdict.allowed) {
		store.transition(
			requestId,
			"confirmed",
			"failed_retryable",
			`verify:${verdict.reason}`,
		);
		return { executed: false, finalState: "failed_retryable" };
	}

	// 2. Atomic single-consume (D-b) — BEFORE the store transition, so a
	// persisted `claimed` row always implies a consumed consent.
	if (!deps.claim()) {
		store.transition(requestId, "confirmed", "failed_retryable", "claim_lost");
		return { executed: false, finalState: "failed_retryable" };
	}
	store.transition(requestId, "confirmed", "claimed");

	return executeClaimedRequest(store, requestId, deps);
}

/**
 * Drive a request whose consent is ALREADY consumed (state claimed/executing —
 * the normal continuation of `executeConfirmedRequest`, and the recovery
 * re-drive path for idempotent actions). Re-checks the lifecycle revision
 * before dispatch; never re-claims.
 */
export async function executeClaimedRequest(
	store: LifecycleRequestStore,
	requestId: string,
	deps: ClaimedExecuteDeps,
): Promise<ExecuteResult> {
	const row = store.get(requestId);
	if (!row || (row.state !== "claimed" && row.state !== "executing")) {
		return { executed: false, finalState: row?.state ?? "failed_retryable" };
	}

	// Post-claim freshness re-check (§5.1): the consent is consumed, but a stale
	// or unreadable revision REFUSES execution — the founder must re-request.
	let revision: number | undefined;
	try {
		revision = await deps.currentRevision();
	} catch {
		revision = undefined;
	}
	if (revision === undefined || revision !== row.lifecycleRevision) {
		store.transition(
			requestId,
			row.state,
			"failed_retryable",
			"revision_stale_post_claim",
		);
		return { executed: false, finalState: "failed_retryable" };
	}

	if (row.state === "claimed") {
		store.transition(requestId, "claimed", "executing");
	}

	let outcome: DispatchOutcome;
	try {
		outcome = await deps.dispatch();
	} catch (err) {
		outcome = { kind: "unknown", detail: (err as Error).message };
	}

	if (outcome.kind === "success") {
		store.transition(requestId, "executing", "succeeded", "executed");
		return { executed: true, finalState: "succeeded" };
	}
	if (outcome.kind === "not_dispatched") {
		store.transition(
			requestId,
			"executing",
			"failed_retryable",
			`not_dispatched:${outcome.detail ?? ""}`,
		);
		return { executed: false, finalState: "failed_retryable" };
	}
	store.transition(
		requestId,
		"executing",
		"ambiguous",
		`dispatch_unknown:${outcome.detail ?? ""}`,
	);
	return { executed: false, finalState: "ambiguous" };
}

// ── §5.2.1 action-specific postconditions ────────────────────────────────────

/** The terminal status each idempotent status-write action establishes. Values
 * mirror the Bridge's real writes (`bridge/actions.ts` ACTION_TARGET_STATUS +
 * `handleTerminate`'s forceStatus/"terminated") — validated again in Phase F
 * real-machine QA. */
const POSTCONDITION_TARGET_STATUS: Readonly<Record<string, string>> = {
	reject: "rejected",
	defer: "deferred",
	shelve: "shelved",
};

export interface PostconditionProbes {
	/** Target session's current status; undefined = session row gone. */
	sessionStatus: (execId: string) => Promise<string | undefined>;
	tmuxPresent?: (execId: string) => Promise<boolean>;
	runnerPresent?: (execId: string) => Promise<boolean>;
}

/**
 * Build the §5.2.1 crash-recovery postcondition check for one action. The
 * verdict encodes the idempotency table:
 *   - terminate: terminal status (or session gone) = reached; live = retry_safe.
 *   - reject/defer/shelve: status === target = reached; else retry_safe.
 *   - close_tmux/close_runner: resource absent = reached; present = retry_safe.
 *   - retry: NON-idempotent — fail-closed needs_reconfirm until D2 wires the
 *     authoritative started-evidence reconciler.
 *   - unknown action / probe failure: needs_reconfirm (fail-closed).
 */
export function makePostconditionCheck(
	action: string,
	probes: PostconditionProbes,
): (row?: LifecycleRequestRecord) => Promise<PostconditionVerdict> {
	return async (row?: LifecycleRequestRecord) => {
		const execId = row?.execId ?? "";
		try {
			switch (action) {
				case "terminate": {
					const status = await probes.sessionStatus(execId);
					return status === undefined || status === "terminated"
						? "reached"
						: "retry_safe";
				}
				case "reject":
				case "defer":
				case "shelve": {
					const status = await probes.sessionStatus(execId);
					return status === POSTCONDITION_TARGET_STATUS[action]
						? "reached"
						: "retry_safe";
				}
				case "close_tmux": {
					if (!probes.tmuxPresent) return "needs_reconfirm";
					return (await probes.tmuxPresent(execId)) ? "retry_safe" : "reached";
				}
				case "close_runner": {
					if (!probes.runnerPresent) return "needs_reconfirm";
					return (await probes.runnerPresent(execId))
						? "retry_safe"
						: "reached";
				}
				default:
					// `retry` (non-idempotent, D2) and anything unclassified.
					return "needs_reconfirm";
			}
		} catch {
			return "needs_reconfirm";
		}
	};
}
