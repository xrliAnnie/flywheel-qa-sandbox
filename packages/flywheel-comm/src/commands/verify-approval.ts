/**
 * FLY-191 Phase 2: `flywheel-comm verify-approval` — the runner's MANDATORY
 * pre-ship authority check.
 *
 * Security model (plan §3.2(i), Codex R3 HIGH-1/2 rewrite; question binding
 * added per Codex PR R1 CRITICAL): the mailbox wake message carries NO
 * authority — any process that can write the inbox file can forge its text,
 * and the Claude mailbox wire format drops metadata anyway. Ship authority
 * therefore comes from re-verifying against TRUSTED LOCAL sources, ALL of
 * which must agree:
 *
 *   1. The Bridge StateStore session carries a `review_question_id` — the
 *      EXACT CommDB question of the CURRENT review request (persisted from
 *      `complete --route needs_review --question-id <id>`; a re-review
 *      overwrites it, instantly invalidating approvals on earlier questions —
 *      no "latest by timestamp" tie-break games at SQLite's 1s resolution).
 *   2. THAT question has a response row. Writes to it are FLY-175-gated
 *      (`respond.ts` refuses direct writes; only the Bridge founder-consent
 *      wrapper / `approveExecution` / the loud-audited emergency bypass can
 *      write it) and the Bridge rejects answers to non-current questions.
 *   3. The response parses as structured JSON with `approved === true`
 *      (the exact shape `approveExecution` writes). Plain-text or malformed
 *      responses are NOT authority (fail-closed).
 *   4. The session is `approved_to_ship` AND its persisted `pr_head_sha`
 *      equals the runner's CURRENT PR head (`--pr-head $(git rev-parse
 *      HEAD)`). A stale approval for an older head — or an approval that
 *      predates new commits — fails the match and does NOT ship.
 *
 * Fail-closed everywhere: missing DB file, unreadable row, missing binding,
 * missing/ambiguous pr_head_sha, parse errors → `approved: false` with a
 * machine-readable reason. No Bridge round-trip by design (§5.5.1): local
 * reads keep the runner's ship decision independent of Bridge availability
 * and resumable.
 *
 * Threat-model caveat (§5.5.1, documented per Codex R4): SQLite files are not
 * a process-level integrity boundary — a same-host process with write access
 * to `comm.db`/`teamlead.db` can forge the trusted sources directly. The
 * threat model here is "trusted local Flywheel processes" (prevents role
 * confusion, accidental triggers, and bare-text 'approved' messages), NOT a
 * hostile local writer. §5.5.3: the strict claim "only a real founder-consent
 * approval can ship" additionally requires FLY-175 `DECISION_MODE=enforce`;
 * in off/audit_only the Bridge writes the response without blocking consent.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "../db.js";

export interface VerifyApprovalArgs {
	execId: string;
	/** The runner's current PR head — full 40-hex sha (`git rev-parse HEAD`). */
	prHead: string;
	/** CommDB path (resolved by caller via --db/--project). */
	dbPath: string;
	/** StateStore (teamlead.db) path override. */
	stateDbPath?: string;
	env?: NodeJS.ProcessEnv;
}

export type VerifyApprovalReason =
	| "approved"
	| "invalid_pr_head_format"
	| "state_db_unreadable"
	| "session_not_found"
	| "review_question_unbound"
	| "commdb_unreadable"
	| "review_question_missing"
	| "review_question_invalid"
	| "gate_not_answered"
	| "response_not_structured_approval"
	| "response_not_approved"
	| "status_not_approved_to_ship"
	| "pr_head_sha_missing"
	| "pr_head_sha_mismatch";

export interface VerifyApprovalResult {
	approved: boolean;
	reason: VerifyApprovalReason;
	/** The bound review question this verdict is about. */
	questionId?: string;
	/** Who wrote the gate response (e.g. "bridge", a lead id). */
	responseFrom?: string;
	/** StateStore session status observed. */
	status?: string;
	/** pr_head_sha persisted on the session (trusted side of the comparison). */
	expectedPrHeadSha?: string;
	exitCode: number;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export function resolveStateDbPath(
	override: string | undefined,
	env: NodeJS.ProcessEnv,
): string {
	return (
		override?.trim() ||
		env.FLYWHEEL_STATE_DB_PATH?.trim() ||
		env.TEAMLEAD_DB_PATH?.trim() ||
		join(homedir(), ".flywheel", "teamlead.db")
	);
}

export function verifyApproval(args: VerifyApprovalArgs): VerifyApprovalResult {
	const env = args.env ?? process.env;
	const notApproved = (
		reason: VerifyApprovalReason,
		extra?: Partial<VerifyApprovalResult>,
	): VerifyApprovalResult => ({
		approved: false,
		reason,
		exitCode: 1,
		...extra,
	});

	// 0. Input validation — fail-closed on anything that isn't a full sha
	// (prefix/short-sha comparisons invite ambiguity games, §5.5.4).
	const prHead = args.prHead.trim().toLowerCase();
	if (!FULL_SHA_RE.test(prHead)) {
		return notApproved("invalid_pr_head_format");
	}

	// 1. StateStore FIRST: the session row carries the review binding
	// (review_question_id + pr_head_sha) and the status. The StateStore file
	// is sql.js-exported standard SQLite (full-file save on every mutation),
	// so a readonly point-in-time read here is current.
	const statePath = resolveStateDbPath(args.stateDbPath, env);
	if (!existsSync(statePath)) {
		console.error(
			`[verify-approval] StateStore not found at ${statePath} (fail-closed)`,
		);
		return notApproved("state_db_unreadable");
	}
	let row:
		| {
				status?: string;
				pr_head_sha?: string | null;
				review_question_id?: string | null;
		  }
		| undefined;
	try {
		const stateDb = new Database(statePath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			row = stateDb
				.prepare(
					"SELECT status, pr_head_sha, review_question_id FROM sessions WHERE execution_id = ?",
				)
				.get(args.execId) as typeof row;
		} finally {
			stateDb.close();
		}
	} catch (err) {
		console.error(
			`[verify-approval] StateStore read failed (fail-closed): ${(err as Error).message}`,
		);
		return notApproved("state_db_unreadable");
	}

	if (!row) {
		return notApproved("session_not_found");
	}
	const questionId = row.review_question_id?.trim();
	// REVIEW_BINDING_UNBOUND sentinel (mirrors
	// teamlead/src/StateStore.ts): a Phase-2 review completion arrived
	// without a usable questionId. NULL (legacy pre-Phase-2 session) is
	// equally unapprovable HERE — verify-approval exists only for the
	// Phase-2 flow. Never fall back to "latest question" heuristics — that
	// reopens the same-second ambiguity hole (Codex PR R1 CRITICAL).
	if (!questionId || questionId === "unbound") {
		return notApproved("review_question_unbound", { status: row.status });
	}

	// 2+3. CommDB: the BOUND question must exist, be an approve_to_ship gate,
	// and carry a structured approval response.
	let responseFrom: string | undefined;
	let responseContent: string | undefined;
	try {
		const db = CommDB.openReadonly(args.dbPath);
		try {
			const question = db.getMessageById(questionId);
			if (!question) {
				return notApproved("review_question_missing", { questionId });
			}
			if (
				question.type !== "question" ||
				question.checkpoint !== "approve_to_ship" ||
				question.from_agent !== args.execId
			) {
				// Bound id points at something that is not THIS runner's
				// approve_to_ship gate — corrupt/forged binding → fail-closed.
				return notApproved("review_question_invalid", { questionId });
			}
			const response = db.getResponse(questionId);
			if (!response) {
				return notApproved("gate_not_answered", { questionId });
			}
			responseFrom = response.from_agent;
			responseContent = response.content;
		} finally {
			db.close();
		}
	} catch (err) {
		console.error(
			`[verify-approval] CommDB read failed (fail-closed): ${(err as Error).message}`,
		);
		return notApproved("commdb_unreadable", { questionId });
	}

	// Structured approval shape only — the exact `{approved: true}` contract
	// approveExecution / the founder-consent wrapper write. Anything else
	// (plain text "approved!", malformed JSON) is NOT authority.
	let parsedApproved: boolean | undefined;
	try {
		const parsed = JSON.parse(responseContent ?? "");
		if (typeof parsed?.approved === "boolean") parsedApproved = parsed.approved;
	} catch {
		// fall through — handled below
	}
	if (parsedApproved === undefined) {
		return notApproved("response_not_structured_approval", {
			questionId,
			responseFrom,
		});
	}
	if (parsedApproved !== true) {
		return notApproved("response_not_approved", { questionId, responseFrom });
	}

	// 4. Status + PR-head binding.
	if (row.status !== "approved_to_ship") {
		return notApproved("status_not_approved_to_ship", {
			questionId,
			responseFrom,
			status: row.status,
		});
	}
	const expected = row.pr_head_sha?.trim().toLowerCase();
	if (!expected) {
		// §5.5.2: missing/stale/ambiguous persisted head → ALWAYS fail-closed.
		return notApproved("pr_head_sha_missing", {
			questionId,
			responseFrom,
			status: row.status,
		});
	}
	if (expected !== prHead) {
		return notApproved("pr_head_sha_mismatch", {
			questionId,
			responseFrom,
			status: row.status,
			expectedPrHeadSha: expected,
		});
	}

	return {
		approved: true,
		reason: "approved",
		questionId,
		responseFrom,
		status: row.status,
		expectedPrHeadSha: expected,
		exitCode: 0,
	};
}
