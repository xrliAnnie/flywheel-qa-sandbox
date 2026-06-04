/**
 * FLY-175 Track 2 — Surface B: POST /api/founder-consent/runner-gate-response
 * (plan Appendix C).
 *
 * The production `approve_to_ship` ship path: Lead's `flywheel-comm respond`
 * is patched (fail-closed) to POST here instead of writing CommDB directly.
 * The router evaluates founder consent, then writes the CommDB response on
 * allow using the SAME `db.insertResponse(...)` code `approveExecution` uses.
 *
 * Security (Codex R2 HIGH-2): the CommDB path is derived SERVER-SIDE from a
 * configured project; a caller-supplied `dbPath` is rejected, and the resolved
 * realpath must stay under the comm root (symlink-escape guard, R3 LOW-5).
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path, { join, resolve } from "node:path";
import { type Request, type Response, Router } from "express";
import { CommDB } from "flywheel-comm/db";
import type { FounderConsentEvaluator } from "./evaluator.js";
import type { ConsentContextResolver } from "./middleware.js";

export interface GateResponseRouterDeps {
	/**
	 * The consent evaluator. **Optional**: when undefined (DECISION_MODE=off)
	 * the route still mounts and operates in PASS-THROUGH mode — it derives the
	 * CommDB path, verifies the checkpoint, and writes the response WITHOUT a
	 * consent check. This is required for byte-compat: the patched
	 * `flywheel-comm respond` CLI ALWAYS routes `approve_to_ship` through this
	 * Bridge endpoint, so if the route 404'd while off, every production ship
	 * would block during the Phase 0 default-off rollout.
	 */
	evaluator?: FounderConsentEvaluator;
	/** Resolve consent context by executionId (shared with middleware). */
	resolveContext: ConsentContextResolver;
	/** Look up a session by executionId → { project_name } (StateStore). */
	getSessionProject: (
		executionId: string,
	) => { project_name: string } | undefined;
	/**
	 * FLY-191 Phase 2 (Codex PR R1 CRITICAL): the session's CURRENT review
	 * question id (StateStore review_question_id). When set, answers to ANY
	 * other approve_to_ship question from that runner are rejected (409) —
	 * a re-review instantly invalidates the old question, so a Lead replying
	 * to a stale Discord relay can't approve the wrong request. When the
	 * session has no binding (legacy blocking-gate flow), behavior is
	 * unchanged (byte-compat with the default-off rollout).
	 */
	getCurrentReviewQuestionId?: (executionId: string) => string | undefined;
	/** Configured project names (validates a caller-supplied projectName). */
	configuredProjects: ReadonlySet<string>;
	/** Override the comm root (tests). Defaults to ~/.flywheel/comm. */
	commRoot?: string;
	logger?: { info: (m: string) => void; warn: (m: string) => void };
	/**
	 * FLY-191 Phase 2: invoked AFTER a successful CommDB response write (both
	 * the pass-through and the consent-allow paths — this endpoint is the
	 * production `flywheel-comm respond --bridge-url` ship path, so it must
	 * have parity with `/api/actions/approve`):
	 *   - approval answers (structured `{"approved": true}`) → flip
	 *     awaiting_review → approved_to_ship (Codex R2 MEDIUM-1) + wake;
	 *   - non-approval answers (changes_requested feedback) → wake only,
	 *     NOT terminal (plan §3.2(ii)).
	 * Best-effort: a hook failure must never fail the request — the response
	 * row is already durably written; implementations log + emit telemetry.
	 */
	onResponseWritten?: (info: {
		executionId: string;
		questionId: string;
		leadId: string;
		answer: string;
		db: CommDB;
	}) => Promise<void>;
}

/** Structured-approval classifier — the only shape verify-approval honors. */
function isApprovalAnswer(answer: string): boolean {
	try {
		return JSON.parse(answer)?.approved === true;
	} catch {
		return false;
	}
}

/**
 * FLY-208 6b (Codex design R2 #4): a plain-text reply with obvious approval
 * intent (e.g. `APPROVE — founder 批准在案...`, the production incident) is
 * silently recorded as changes_requested feedback because only JSON
 * `{"approved": true}` approves. Detect the intent and return a WARNING for
 * the HTTP response (the respond CLI prints it to stderr) — the write
 * behavior is deliberately unchanged. The remediation text accounts for
 * idx_unique_response (one response per question): re-sending JSON on the
 * SAME question would 409, so the Lead must have the Runner re-request
 * review and answer the NEW question.
 */
const APPROVAL_INTENT_RE = /^\s*"?approved?\b/i;

function approvalIntentWarning(answer: string): string | undefined {
	if (isApprovalAnswer(answer)) return undefined;
	if (!APPROVAL_INTENT_RE.test(answer)) return undefined;
	return (
		"Recorded as FEEDBACK, not approval — only the exact JSON '{\"approved\": true}' approves " +
		"(verify-approval will NOT honor this text). This question now has its single response " +
		"(one per question); to actually approve, have the Runner re-request review and answer " +
		"the NEW question with '{\"approved\": true}'."
	);
}

/**
 * Run the post-write hook without ever failing the request — the CommDB
 * response row is already durably written; the transition/wake side effects
 * are best-effort and surface their own telemetry.
 */
async function runPostWriteHook(
	deps: GateResponseRouterDeps,
	info: {
		executionId: string;
		questionId: string;
		leadId: string;
		answer: string;
		db: CommDB;
	},
): Promise<void> {
	if (!deps.onResponseWritten) return;
	try {
		await deps.onResponseWritten(info);
	} catch (err) {
		deps.logger?.warn(
			`[founder-consent] post-write hook failed for ${info.executionId} (response already written): ${(err as Error).message}`,
		);
	}
}

export function createGateResponseRouter(deps: GateResponseRouterDeps): Router {
	const router = Router();
	const COMMDB_ROOT = resolve(
		deps.commRoot ?? join(homedir(), ".flywheel", "comm"),
	);

	router.post("/", async (req: Request, res: Response) => {
		const body = (req.body ?? {}) as {
			questionId?: string;
			leadId?: string;
			answer?: string;
			executionId?: string;
			projectName?: string;
			reason?: string;
			dbPath?: string;
		};
		const { questionId, leadId, answer, executionId, projectName } = body;

		if (!questionId || !leadId || answer === undefined) {
			res.status(400).json({ error: "missing required fields" });
			return;
		}
		if (!executionId && !projectName) {
			res.status(400).json({
				error: "must provide executionId or projectName for path derivation",
			});
			return;
		}
		if ("dbPath" in body) {
			res.status(400).json({
				error: "dbPath is server-derived; do not pass it in the request",
			});
			return;
		}

		// 1. Derive canonical CommDB path server-side.
		let resolvedProjectName: string;
		if (executionId) {
			const session = deps.getSessionProject(executionId);
			if (!session) {
				res.status(404).json({ error: "session not found for executionId" });
				return;
			}
			resolvedProjectName = session.project_name;
		} else {
			if (!deps.configuredProjects.has(projectName as string)) {
				res.status(403).json({ error: "unknown project" });
				return;
			}
			resolvedProjectName = projectName as string;
		}

		const candidatePath = join(COMMDB_ROOT, resolvedProjectName, "comm.db");
		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(candidatePath);
		} catch {
			res.status(404).json({ error: `CommDB not found at ${candidatePath}` });
			return;
		}
		// Defense in depth: realpath must stay under the comm root.
		const rootReal = realpathSync(COMMDB_ROOT);
		const rel = path.relative(rootReal, canonicalPath);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			res.status(403).json({ error: "CommDB path escapes the expected root" });
			return;
		}

		const db = new CommDB(canonicalPath, false);
		try {
			// 2. Look up the question; verify checkpoint is approve_to_ship.
			const question = db.getMessageById(questionId);
			if (!question) {
				res.status(404).json({ error: "question not found" });
				return;
			}
			if (question.checkpoint !== "approve_to_ship") {
				res.status(400).json({
					error:
						"wrapper only handles approve_to_ship; other gates use the legacy direct CLI path",
				});
				return;
			}

			// FLY-191 Phase 2 (Codex PR R1 CRITICAL): only the CURRENT review
			// question is answerable once a binding exists. The "unbound"
			// sentinel (R2 HIGH-1 — Phase-2 completion arrived without a
			// questionId) matches nothing, so it correctly rejects ALL
			// answers; recovery is the runner re-requesting review.
			const currentReviewId = deps.getCurrentReviewQuestionId?.(
				question.from_agent,
			);
			if (currentReviewId && currentReviewId !== questionId) {
				res.status(409).json({
					error: "stale_review_question",
					detail: `question ${questionId} is not the runner's current review request (${currentReviewId}); a re-review superseded it (or the review request is missing its binding — runner must re-request review)`,
					currentReviewQuestionId: currentReviewId,
				});
				return;
			}

			// FLY-191 Phase 2 (Codex R2 HIGH-2): idempotent retry. CommDB
			// enforces ONE response per question (idx_unique_response), so a
			// retry after "response written, transition/wake failed" would hit
			// the unique constraint and never re-run the recovery hook. A
			// matching prior answer (same approval-ness) skips the write and
			// re-runs the hook — the hook is idempotent (transition only from
			// awaiting_review; wake re-delivery is best-effort by design). A
			// CONFLICTING prior answer is a hard 409: the question is answered;
			// a different decision needs a fresh review round.
			const priorResponse = db.getResponse(questionId);
			if (priorResponse) {
				if (
					isApprovalAnswer(priorResponse.content) !== isApprovalAnswer(answer)
				) {
					res.status(409).json({
						error: "question_already_answered",
						detail: `question ${questionId} already has a ${isApprovalAnswer(priorResponse.content) ? "approval" : "feedback"} response; a different decision requires a new review round`,
					});
					return;
				}
				await runPostWriteHook(deps, {
					executionId: question.from_agent,
					questionId,
					leadId,
					answer: priorResponse.content,
					db,
				});
				res.json({
					success: true,
					alreadyResponded: true,
					warning: approvalIntentWarning(priorResponse.content),
				});
				return;
			}

			// PASS-THROUGH (DECISION_MODE=off): no evaluator → write the response
			// without a consent check. Keeps the CLI→Bridge ship path functional
			// during the default-off rollout (see GateResponseRouterDeps.evaluator).
			if (!deps.evaluator) {
				db.insertResponse(questionId, leadId, answer);
				await runPostWriteHook(deps, {
					executionId: question.from_agent,
					questionId,
					leadId,
					answer,
					db,
				});
				res.json({
					success: true,
					passthrough: true,
					warning: approvalIntentWarning(answer),
				});
				return;
			}

			// 3. Resolve consent context from the question's runner (from_agent).
			const ctx = await deps.resolveContext(question.from_agent);
			if (!ctx) {
				res.status(404).json({
					error: "session not found for question's from_agent",
				});
				return;
			}

			// 4. Evaluate consent.
			const decision = await deps.evaluator.evaluate({
				...ctx,
				action: "approve_to_ship_gate",
				actorSource: "gate_response_wrapper",
				leadId,
				requestReason: body.reason,
				commQuestionId: questionId,
				commProjectName: resolvedProjectName,
			});

			// audit_only: record but always allow the write.
			const allow =
				deps.evaluator.decisionMode === "audit_only" ||
				decision.decision === "allow" ||
				decision.decision === "bypass";

			if (!allow) {
				if (decision.decision === "fail_closed") {
					res.status(503).json({
						code: decision.code ?? "FOUNDER_CONSENT_FAIL_CLOSED",
						reason: decision.failReason ?? decision.llmReason,
						auditId: decision.auditId,
					});
					return;
				}
				res.status(403).json({
					code: decision.code ?? "FOUNDER_CONSENT_REQUIRED",
					reason: decision.llmReason,
					evidence: decision.evidenceExcerpt,
					auditId: decision.auditId,
				});
				return;
			}

			// 5. Allow: write the response (same path approveExecution uses).
			db.insertResponse(questionId, leadId, answer);
			await runPostWriteHook(deps, {
				executionId: question.from_agent,
				questionId,
				leadId,
				answer,
				db,
			});
			res.json({
				success: true,
				auditId: decision.auditId,
				warning: approvalIntentWarning(answer),
			});
		} catch (err) {
			deps.logger?.warn(
				`[founder-consent] gate-response error: ${(err as Error).message}`,
			);
			res.status(500).json({ error: "gate-response internal error" });
		} finally {
			db.close();
		}
	});

	return router;
}
