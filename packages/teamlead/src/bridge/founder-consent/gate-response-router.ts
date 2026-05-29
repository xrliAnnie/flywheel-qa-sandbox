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
	/** Configured project names (validates a caller-supplied projectName). */
	configuredProjects: ReadonlySet<string>;
	/** Override the comm root (tests). Defaults to ~/.flywheel/comm. */
	commRoot?: string;
	logger?: { info: (m: string) => void; warn: (m: string) => void };
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

			// PASS-THROUGH (DECISION_MODE=off): no evaluator → write the response
			// without a consent check. Keeps the CLI→Bridge ship path functional
			// during the default-off rollout (see GateResponseRouterDeps.evaluator).
			if (!deps.evaluator) {
				db.insertResponse(questionId, leadId, answer);
				res.json({ success: true, passthrough: true });
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
			res.json({ success: true, auditId: decision.auditId });
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
