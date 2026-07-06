/**
 * FLY-245 Phase D-c — `verifyLifecycleConsent`: the runner-lifecycle founder
 * authority check (plan §5.5, Codex R1#10 + R1#13).
 *
 * The Codex Lead gateway's `request_runner_lifecycle` path is `reserved_lifecycle`.
 * Unlike merge/ship (which reuses `verifyApproval`), a lifecycle action
 * (terminate / reject / defer / shelve / retry / close-*) has no `approve_to_ship`
 * gate. This is an INDEPENDENT verifier built on the SAME trusted-local-sources
 * model as `verifyApproval`, using only the existing public `CommDB` / StateStore
 * APIs — `verifyApproval`'s body is left BYTE-UNCHANGED (R1#10: we do not claim
 * both byte-identity and shared implementation; we share nothing but the
 * `resolveStateDbPath` helper).
 *
 * FAIL-CLOSED is the hard contract. A consent is honored ONLY when EVERY bound
 * dimension agrees (R1#13 full ownership binding):
 *   - the question exists, is a `runner_lifecycle:<action>` checkpoint, and is
 *     FROM the requesting gateway Lead and TO the founder;
 *   - its structured binding matches the runtime-derived target execId, action,
 *     nonce, and project (the model never supplies these — the gateway derives
 *     them, plan §4);
 *   - the bound `lifecycle_revision` STILL equals the session's current revision
 *     (freshness — the pr_head_sha equivalent; a session that transitioned since
 *     the request invalidates the confirmation, plan §5.1 / R1#5);
 *   - the response is a structured `{approved:true, action, execId, revision}`
 *     written BY the founder's Discord id (the reaction path has the gateway write
 *     this structured response only after verifying the founder reacted);
 *   - nothing is expired / consumed (the atomic single-consume is the separate
 *     `claimLifecycleConsent`, applied by the state machine around this check).
 *
 * Read-only: no Bridge round-trip, independent of `decisionMode` (plan §9.5).
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { CommDB } from "../db.js";
import { resolveStateDbPath } from "./verify-approval.js";

export interface VerifyLifecycleConsentArgs {
	/** The lifecycle confirmation question id. */
	questionId: string;
	/** Runtime-derived target execution id. */
	execId: string;
	/** Runtime-derived lifecycle action (terminate / reject / …). */
	action: string;
	/** Runtime-derived request nonce. */
	nonce: string;
	/** The requesting gateway Lead id (question.from_agent). */
	leadId: string;
	/** Expected founder Discord id (question.to_agent + response.from_agent). */
	founderId: string;
	/** Project the target session belongs to. */
	project: string;
	/** CommDB path. */
	dbPath: string;
	/** StateStore (teamlead.db) path override. */
	stateDbPath?: string;
	env?: NodeJS.ProcessEnv;
}

export type VerifyLifecycleConsentReason =
	| "approved"
	| "invalid_args"
	| "state_db_unreadable"
	| "session_not_found"
	| "session_project_mismatch"
	| "commdb_unreadable"
	| "question_missing"
	| "question_invalid"
	| "question_expired"
	| "question_consumed"
	| "binding_unparsable"
	| "binding_mismatch"
	| "revision_stale"
	| "gate_not_answered"
	| "response_wrong_writer"
	| "response_not_structured_approval"
	| "response_not_approved"
	| "response_binding_mismatch";

export interface VerifyLifecycleConsentResult {
	allowed: boolean;
	reason: VerifyLifecycleConsentReason;
}

/** The structured binding persisted in a lifecycle question's `content`. */
interface LifecycleBinding {
	target_execution_id: string;
	action: string;
	lifecycle_revision: number;
	nonce: string;
	project: string;
}

/**
 * Parse a SQLite `datetime('now', …)` value ("YYYY-MM-DD HH:MM:SS", UTC) to
 * epoch ms. Returns null for anything unparsable (caller fails closed).
 * ISO-8601 strings (containing "T") pass through Date.parse unchanged.
 */
function parseSqliteUtcMs(value: string | null | undefined): number | null {
	if (!value || typeof value !== "string") return null;
	const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}

export function verifyLifecycleConsent(
	args: VerifyLifecycleConsentArgs,
): VerifyLifecycleConsentResult {
	const env = args.env ?? process.env;
	const reject = (
		reason: VerifyLifecycleConsentReason,
	): VerifyLifecycleConsentResult => ({ allowed: false, reason });

	// 0. Input validation — fail-closed on any missing runtime-derived field.
	if (
		!args.questionId ||
		!args.execId ||
		!args.action ||
		!args.nonce ||
		!args.leadId ||
		!args.founderId ||
		!args.project ||
		!args.dbPath
	) {
		return reject("invalid_args");
	}
	const expectedCheckpoint = `runner_lifecycle:${args.action}`;

	// 1. StateStore: the session's CURRENT lifecycle revision (freshness anchor).
	const statePath = resolveStateDbPath(args.stateDbPath, env);
	if (!existsSync(statePath)) {
		console.error(
			`[verify-lifecycle-consent] StateStore not found at ${statePath} (fail-closed)`,
		);
		return reject("state_db_unreadable");
	}
	let stateRow:
		| { lifecycle_revision?: number; project_name?: string }
		| undefined;
	try {
		const stateDb = new Database(statePath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			stateRow = stateDb
				.prepare(
					"SELECT lifecycle_revision, project_name FROM sessions WHERE execution_id = ?",
				)
				.get(args.execId) as typeof stateRow;
		} finally {
			stateDb.close();
		}
	} catch (err) {
		console.error(
			`[verify-lifecycle-consent] StateStore read failed (fail-closed): ${(err as Error).message}`,
		);
		return reject("state_db_unreadable");
	}
	if (!stateRow) {
		return reject("session_not_found");
	}
	// Codex code-review R1 MED-8: the SESSION's actual project must match — the
	// question-binding copy alone could be forged consistently with itself.
	if (stateRow.project_name !== args.project) {
		return reject("session_project_mismatch");
	}
	const currentRevision =
		typeof stateRow.lifecycle_revision === "number"
			? stateRow.lifecycle_revision
			: 0;

	// 2. CommDB: the bound question + its founder response.
	let question: ReturnType<CommDB["getMessageById"]>;
	let response: ReturnType<CommDB["getResponse"]>;
	try {
		const db = CommDB.openReadonly(args.dbPath);
		try {
			question = db.getMessageById(args.questionId);
			if (question) response = db.getResponse(args.questionId);
		} finally {
			db.close();
		}
	} catch (err) {
		console.error(
			`[verify-lifecycle-consent] CommDB read failed (fail-closed): ${(err as Error).message}`,
		);
		return reject("commdb_unreadable");
	}

	if (!question) {
		return reject("question_missing");
	}
	if (
		question.type !== "question" ||
		question.checkpoint !== expectedCheckpoint ||
		question.from_agent !== args.leadId ||
		question.to_agent !== args.founderId
	) {
		return reject("question_invalid");
	}

	// Codex code-review R1 MED-8: this verifier must itself honor its advertised
	// fail-closed contract — an expired or already-consumed credential is rejected
	// HERE, not only by the later atomic `claimLifecycleConsent`.
	if (question.resolved_at != null) {
		return reject("question_consumed");
	}
	const expiresMs = parseSqliteUtcMs(question.expires_at);
	if (expiresMs === null || expiresMs <= Date.now()) {
		return reject("question_expired");
	}

	// 2a. Structured binding — runtime-derived target/action/nonce/project must
	// match exactly (the model never supplies these).
	let binding: LifecycleBinding;
	try {
		const parsed = JSON.parse(question.content ?? "");
		if (!parsed || typeof parsed !== "object")
			return reject("binding_unparsable");
		binding = parsed as LifecycleBinding;
	} catch {
		return reject("binding_unparsable");
	}
	if (
		binding.target_execution_id !== args.execId ||
		binding.action !== args.action ||
		binding.nonce !== args.nonce ||
		binding.project !== args.project
	) {
		return reject("binding_mismatch");
	}

	// 2b. Freshness — the snapshot revision must STILL equal the session's current
	// revision (the pr_head_sha equivalent; status can leave and return, so the
	// monotonic revision is the real anchor — D-a / R1#5).
	if (
		typeof binding.lifecycle_revision !== "number" ||
		binding.lifecycle_revision !== currentRevision
	) {
		return reject("revision_stale");
	}

	// 3. Founder response — structured approval written BY the founder id, bound to
	// the same action / execId / revision.
	if (!response) {
		return reject("gate_not_answered");
	}
	if (response.from_agent !== args.founderId) {
		return reject("response_wrong_writer");
	}
	let parsedResp: {
		approved?: unknown;
		action?: unknown;
		execId?: unknown;
		revision?: unknown;
	};
	try {
		parsedResp = JSON.parse(response.content ?? "");
	} catch {
		return reject("response_not_structured_approval");
	}
	if (!parsedResp || typeof parsedResp.approved !== "boolean") {
		return reject("response_not_structured_approval");
	}
	if (parsedResp.approved !== true) {
		return reject("response_not_approved");
	}
	if (
		parsedResp.action !== args.action ||
		parsedResp.execId !== args.execId ||
		parsedResp.revision !== currentRevision
	) {
		return reject("response_binding_mismatch");
	}

	return { allowed: true, reason: "approved" };
}
