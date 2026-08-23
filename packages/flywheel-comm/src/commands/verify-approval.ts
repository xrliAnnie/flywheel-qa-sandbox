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
 *      wrapper / `approveExecution` can write it) and the Bridge rejects
 *      answers to non-current questions.
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
import { crossFamilyReviewSatisfied } from "flywheel-config";
import { CommDB } from "../db.js";
import {
	isTrustedApprovalAttribution,
	resolveFounderId,
} from "../founder-attribution.js";
import { resolveFounderReviewVerdictAtCommit } from "../founder-review.js";
import { createReadonlySqliteFounderReviewStateReader } from "../founder-review-sqlite.js";
import { probeShipCiGreen, type ShipCiGuardResult } from "../ship-ci-guard.js";

export interface VerifyApprovalArgs {
	execId: string;
	/** The runner's current PR head — full 40-hex sha (`git rev-parse HEAD`). */
	prHead: string;
	/** CommDB path (resolved by caller via --db/--project). */
	dbPath: string;
	/** StateStore (teamlead.db) path override. */
	stateDbPath?: string;
	env?: NodeJS.ProcessEnv;
	/** Shared live-dotenv override used by founder-attribution checks. */
	codexDotenvPath?: string;
	/** Test seam; production probes the bound PR in its persisted worktree. */
	ciProbe?: (args: {
		cwd: string;
		prNumber: number;
		expectedHead: string;
	}) => ShipCiGuardResult;
}

export type VerifyApprovalReason =
	| "approved"
	| "invalid_pr_head_format"
	| "head_authority_unavailable"
	| "head_authority_mismatch"
	| "nested_ship_unsupported"
	| "state_db_unreadable"
	| "session_not_found"
	| "review_question_unbound"
	| "commdb_unreadable"
	| "review_question_missing"
	| "review_question_invalid"
	| "gate_superseded"
	| "gate_not_answered"
	| "response_not_structured_approval"
	| "response_not_approved"
	| "response_not_founder_attributed"
	| "founder_review_missing"
	| "founder_review_not_passed"
	| "founder_review_stale_artifact"
	| "status_not_approved_to_ship"
	| "pr_head_sha_missing"
	| "pr_head_sha_mismatch"
	| "codex_review_not_approved"
	| "ci_not_green";

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
	/** Fail-closed GitHub observation detail; never authority by itself. */
	ciDetail?: string;
	exitCode: number;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export interface VerifyApprovalWithBridgeHeadArgs extends VerifyApprovalArgs {
	/** Loopback Bridge base URL that owns the execution worktree mapping. */
	bridgeUrl: string;
	/** Test seam. */
	fetchImpl?: typeof fetch;
}

/**
 * Resolve the head from the Bridge's persisted worktree mapping, compare the
 * caller's local observation, then run the existing local approval proof using
 * the authoritative head. Bridge loss or disagreement always fails closed.
 */
export async function verifyApprovalWithBridgeHead(
	args: VerifyApprovalWithBridgeHeadArgs,
): Promise<VerifyApprovalResult> {
	const env = args.env ?? process.env;
	const callerHead = args.prHead.trim().toLowerCase();
	if (!FULL_SHA_RE.test(callerHead)) {
		return {
			approved: false,
			reason: "invalid_pr_head_format",
			exitCode: 1,
		};
	}
	const bridgeUrl = args.bridgeUrl.trim().replace(/\/$/, "");
	if (!bridgeUrl) {
		return {
			approved: false,
			reason: "head_authority_unavailable",
			exitCode: 1,
		};
	}
	const statePath = resolveStateDbPath(args.stateDbPath, env);
	let approveQuestionId: string;
	try {
		const stateDb = new Database(statePath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			const row = stateDb
				.prepare(
					"SELECT review_question_id FROM sessions WHERE execution_id = ?",
				)
				.get(args.execId) as { review_question_id?: string | null } | undefined;
			if (!row) {
				return {
					approved: false,
					reason: "session_not_found",
					exitCode: 1,
				};
			}
			approveQuestionId = row.review_question_id?.trim() ?? "";
		} finally {
			stateDb.close();
		}
	} catch (error) {
		console.error(
			`[verify-approval] StateStore review binding unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {
			approved: false,
			reason: "state_db_unreadable",
			exitCode: 1,
		};
	}
	if (!approveQuestionId || approveQuestionId === "unbound") {
		return {
			approved: false,
			reason: "review_question_unbound",
			exitCode: 1,
		};
	}
	try {
		const response = await (args.fetchImpl ?? fetch)(
			`${bridgeUrl}/api/workflow/head-authority`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					execution_id: args.execId,
					approve_question_id: approveQuestionId,
				}),
			},
		);
		const payload = (await response.json()) as {
			ok?: unknown;
			prHeadSha?: unknown;
			reason?: unknown;
		};
		if (!response.ok || payload.ok !== true) {
			if (payload.reason === "nested_ship_unsupported") {
				return {
					approved: false,
					reason: "nested_ship_unsupported",
					questionId: approveQuestionId,
					exitCode: 1,
				};
			}
			throw new Error(
				typeof payload.reason === "string"
					? payload.reason
					: `Bridge returned ${response.status}`,
			);
		}
		const authoritativeHead =
			typeof payload.prHeadSha === "string"
				? payload.prHeadSha.trim().toLowerCase()
				: "";
		if (!FULL_SHA_RE.test(authoritativeHead)) {
			throw new Error("invalid Bridge head response");
		}
		if (callerHead !== authoritativeHead) {
			return {
				approved: false,
				reason: "head_authority_mismatch",
				expectedPrHeadSha: authoritativeHead,
				exitCode: 1,
			};
		}
		return verifyApproval({ ...args, prHead: authoritativeHead });
	} catch (error) {
		console.error(
			`[verify-approval] Bridge head authority unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {
			approved: false,
			reason: "head_authority_unavailable",
			exitCode: 1,
		};
	}
}

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
				codex_skip?: number | null;
				adapter_type?: string | null;
				pr_number?: number | null;
				worktree_path?: string | null;
				project_name?: string | null;
				issue_id?: string | null;
		  }
		| undefined;
	// FLY-827: does an approved/skipped Codex code-review record exist for the
	// runner's current head? Read in the same StateStore connection.
	let codexApprovedForHead = false;
	let founderReviewRun:
		| { required: false }
		| { required: true; runId: string }
		| { required: true; invalid: true } = { required: false };
	try {
		const stateDb = new Database(statePath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			row = stateDb
				.prepare(
					"SELECT status, pr_head_sha, review_question_id, codex_skip, adapter_type, pr_number, worktree_path, project_name, issue_id FROM sessions WHERE execution_id = ?",
				)
				.get(args.execId) as typeof row;
			try {
				const bindings = stateDb
					.prepare(
						`SELECT run_id, node_id FROM workflow_execution_binding
						  WHERE execution_id = ? ORDER BY bound_at, activation_id`,
					)
					.all(args.execId) as Array<{ run_id: string; node_id: string }>;
				if (bindings.length === 1) {
					const binding = bindings[0]!;
					const workflow = stateDb
						.prepare("SELECT snapshot FROM workflow_run WHERE run_id = ?")
						.get(binding.run_id) as { snapshot?: string | null } | undefined;
					if (!workflow?.snapshot) {
						founderReviewRun = { required: true, invalid: true };
					} else {
						const snapshot = JSON.parse(workflow.snapshot) as {
							manifest?: {
								nodes?: Array<{ id?: string; founder_review?: unknown }>;
							};
						};
						const node = snapshot.manifest?.nodes?.find(
							(candidate) => candidate.id === binding.node_id,
						);
						founderReviewRun =
							node?.founder_review === true
								? { required: true, runId: binding.run_id }
								: { required: false };
					}
				} else if (bindings.length > 1) {
					founderReviewRun = { required: true, invalid: true };
				}
			} catch (error) {
				// A pre-workflow schema is legacy. Once the binding table exists, any
				// malformed/missing run snapshot is ambiguous and fails closed.
				founderReviewRun = String(error).includes(
					"no such table: workflow_execution_binding",
				)
					? { required: false }
					: { required: true, invalid: true };
			}
			// Separate try: an un-upgraded DB may lack codex_review_record (or,
			// on a version skew, the FLY-1188 family columns). A missing table/
			// column → codexApprovedForHead stays false (fail-closed under the
			// gate), but must NOT corrupt the authoritative row read above.
			try {
				const candidates = stateDb
					.prepare(
						`SELECT r.status, r.author_family, r.reviewer_family,
						        author.adapter_type AS author_adapter_type
						   FROM codex_review_record r
						   LEFT JOIN sessions author ON author.execution_id = r.execution_id
						  WHERE r.project_name = ?
						    AND r.issue_id = ?
						    AND r.target_repo_identity = '__main__'
						    AND lower(r.target_pr_head_sha) = ?
						    AND r.status IN ('approved','skipped')`,
					)
					.all(row?.project_name, row?.issue_id, prHead) as Array<{
					status?: string;
					author_family?: string | null;
					reviewer_family?: string | null;
					author_adapter_type?: string | null;
				}>;
				// FLY-1434 §10: the ship execution may differ from the author
				// execution. Query issue-scoped candidates and evaluate each
				// record with its AUTHOR session adapter, never the shipping one.
				codexApprovedForHead = candidates.some((candidate) =>
					crossFamilyReviewSatisfied({
						status: candidate.status,
						authorFamily: candidate.author_family ?? null,
						reviewerFamily: candidate.reviewer_family ?? null,
						sessionAdapterType: candidate.author_adapter_type ?? null,
					}),
				);
			} catch {
				// Legacy pre-FLY-1434 database: preserve exact-execution lookup
				// until StateStore performs the roll-forward table cutover.
				try {
					const legacy = stateDb
						.prepare(
							"SELECT status, author_family, reviewer_family FROM codex_review_record WHERE execution_id = ? AND lower(target_pr_head_sha) = ? AND status IN ('approved','skipped')",
						)
						.get(args.execId, prHead) as
						| {
								status?: string;
								author_family?: string | null;
								reviewer_family?: string | null;
						  }
						| undefined;
					codexApprovedForHead =
						legacy !== undefined &&
						crossFamilyReviewSatisfied({
							status: legacy.status,
							authorFamily: legacy.author_family ?? null,
							reviewerFamily: legacy.reviewer_family ?? null,
							sessionAdapterType: row?.adapter_type ?? null,
						});
				} catch {
					codexApprovedForHead = false;
				}
			}
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
			if (question.superseded_at) {
				return notApproved("gate_superseded", { questionId });
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

	// 3.5 FLY-945 Fix E: FOUNDER ATTRIBUTION. The structured shape alone is not
	// authority — the WRITER must be founder-side: the canonical founder Discord
	// id (FLY-799 text/✅), "bridge" (/api/actions/approve), or the historical
	// "bridge-founder-consent" actor retained for read compatibility. A Lead
	// id here means a `respond` self-approval (the FLY-921 door) → refused.
	// Honest boundaries (documented in founder-attribution.ts): the founder id
	// resolves LIVE from ~/.flywheel/.env; unresolvable id → this step is
	// SKIPPED (a project without a Discord founder cannot be attribution-gated).
	// `args.codexDotenvPath` is the shared test override for the live
	// ~/.flywheel/.env source used by merge approval and founder identity/config
	// resolution. Attribution is permanently enforced whenever that identity
	// resolves; there is no environment bypass.
	const founderId = resolveFounderId({
		argsEnv: args.env,
		processEnv: env,
		dotenvPath: args.codexDotenvPath,
	});
	if (
		founderId !== undefined &&
		!isTrustedApprovalAttribution(responseFrom, founderId)
	) {
		return notApproved("response_not_founder_attributed", {
			questionId,
			responseFrom,
		});
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

	// 3.6 FLY-1758: legacy runner-ship defense in depth. Engine-owned land has
	// its own Bridge authority seam; a workflow producer that sealed the
	// founder_review capability must also prove a delivered latest-round pass for
	// the exact HTML blobs at this head. Sessions without a workflow binding are
	// byte-compatible legacy and skip this check.
	if (founderReviewRun.required) {
		if ("invalid" in founderReviewRun || !row.worktree_path) {
			return notApproved("founder_review_missing", {
				questionId,
				responseFrom,
				status: row.status,
				expectedPrHeadSha: expected,
			});
		}
		try {
			const sqlite = createReadonlySqliteFounderReviewStateReader({
				stateDbPath: statePath,
				commDbPath: args.dbPath,
			});
			try {
				const verdict = resolveFounderReviewVerdictAtCommit({
					reader: sqlite.reader,
					runId: founderReviewRun.runId,
					repoRoot: row.worktree_path,
					head: prHead,
					founderId: resolveFounderId({
						argsEnv: args.env,
						processEnv: env,
						dotenvPath: args.codexDotenvPath,
					}),
				});
				if (verdict.status !== "passed") {
					return notApproved(
						verdict.status === "stale_artifact"
							? "founder_review_stale_artifact"
							: verdict.status === "missing"
								? "founder_review_missing"
								: "founder_review_not_passed",
						{
							questionId,
							responseFrom,
							status: row.status,
							expectedPrHeadSha: expected,
						},
					);
				}
			} finally {
				sqlite.close();
			}
		} catch {
			return notApproved("founder_review_missing", {
				questionId,
				responseFrom,
				status: row.status,
				expectedPrHeadSha: expected,
			});
		}
	}

	// 5. FLY-827 Codex code-review predicate (defense-in-depth: even a verified
	// founder approval must not merge without exact-head Codex approval). A
	// session-level codex_skip remains the sanctioned bypass.
	if (!row.codex_skip && !codexApprovedForHead) {
		return notApproved("codex_review_not_approved", {
			questionId,
			responseFrom,
			status: row.status,
			expectedPrHeadSha: expected,
		});
	}

	// 6. FLY-1314 material #8: GitHub CI is an independent ship axis. Re-probe
	// at the final authority point; a green observation made when the gate opened
	// is not reusable because checks can be re-run or invalidated afterward.
	const prNumber = Number(row.pr_number);
	const worktreePath = row.worktree_path?.trim();
	if (
		!Number.isSafeInteger(prNumber) ||
		prNumber <= 0 ||
		(!worktreePath && !args.ciProbe)
	) {
		return notApproved("ci_not_green", {
			questionId,
			responseFrom,
			status: row.status,
			expectedPrHeadSha: expected,
			ciDetail: "bound PR number or worktree path is missing",
		});
	}
	const ci = (args.ciProbe ?? probeShipCiGreen)({
		cwd: worktreePath ?? "",
		prNumber,
		expectedHead: prHead,
	});
	if (!ci.green) {
		return notApproved("ci_not_green", {
			questionId,
			responseFrom,
			status: row.status,
			expectedPrHeadSha: expected,
			ciDetail: ci.detail,
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
