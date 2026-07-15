/**
 * FLY-175 Track 2 — Surface A Express middleware (plan §4.2).
 *
 * Mounted in front of the reserved REST endpoints. When the evaluator is
 * undefined (decisionMode=off, evaluator never constructed) the middleware is
 * a pure pass-through so Bridge behavior is byte-identical to pre-Track-2.
 *
 * Operating modes (read from `evaluator.decisionMode`):
 *  - audit_only: evaluate + write audit, then ALWAYS next() (no 403s).
 *  - enforce:    allow/bypass → next(); deny → 403; fail_closed → 503.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { EvaluateInput, FounderConsentEvaluator } from "./evaluator.js";
import { type MountKind, resolveReservedAction } from "./reserved-endpoints.js";

/** Context the plugin resolves for a reserved request (session + project). */
export type ResolvedConsentContext = Omit<
	EvaluateInput,
	"action" | "actorSource" | "leadId"
>;

/**
 * Resolve session + project context for an executionId. Shared by Surface A
 * (middleware) and Surface B (gate-response router). Returns null when the
 * session can't be found.
 */
export type ConsentContextResolver = (
	executionId: string | undefined,
) => Promise<ResolvedConsentContext | null>;

export interface MiddlewareDeps {
	/** Undefined when decisionMode=off — middleware no-ops. */
	evaluator?: FounderConsentEvaluator;
	resolveContext: ConsentContextResolver;
	logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export function founderConsentMiddleware(
	mount: MountKind,
	deps: MiddlewareDeps,
): RequestHandler {
	// Hard no-op when disabled: identical to pre-Track-2 middleware stack.
	if (!deps.evaluator) {
		return (_req: Request, _res: Response, next: NextFunction) => next();
	}
	const evaluator = deps.evaluator;

	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			const resolved = resolveReservedAction(mount, req);
			if (!resolved) {
				next();
				return;
			}

			const ctx = await deps.resolveContext(resolved.executionId);
			if (!ctx) {
				// Unknown session — let the real handler 404. Not an auth bypass:
				// the action cannot run against a session that doesn't exist.
				deps.logger?.warn(
					`[founder-consent] no context for ${resolved.action} exec=${resolved.executionId}; passing through`,
				);
				next();
				return;
			}

			const leadId =
				(req.body as { leadId?: string } | undefined)?.leadId ?? undefined;
			const result = await evaluator.evaluate({
				...ctx,
				action: resolved.action,
				actorSource:
					mount === "action_router" && !leadId
						? "dashboard"
						: "http_middleware",
				leadId,
				requestedBy: leadId ? undefined : "dashboard-anonymous",
			});

			// audit_only: never block.
			if (evaluator.decisionMode === "audit_only") {
				next();
				return;
			}

			// enforce.
			if (result.decision === "allow" || result.decision === "bypass") {
				next();
				return;
			}
			if (result.decision === "fail_closed") {
				res.status(503).json({
					code: result.code ?? "FOUNDER_CONSENT_FAIL_CLOSED",
					reason: result.failReason ?? result.llmReason,
					auditId: result.auditId,
				});
				return;
			}
			// deny
			res.status(403).json({
				code: result.code ?? "FOUNDER_CONSENT_REQUIRED",
				reason: result.llmReason,
				evidence: result.evidenceExcerpt,
				auditId: result.auditId,
			});
		} catch (err) {
			// A middleware crash must fail closed in enforce mode — never let a
			// reserved action through because the gate itself errored.
			deps.logger?.warn(
				`[founder-consent] middleware error: ${(err as Error).message}`,
			);
			if (evaluator.decisionMode === "enforce") {
				res.status(503).json({
					code: "FOUNDER_CONSENT_INTERNAL_ERROR",
					reason: "consent gate error",
				});
				return;
			}
			next();
		}
	};
}
