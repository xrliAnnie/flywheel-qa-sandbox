import { timingSafeEqual } from "node:crypto";
import express from "express";
import { canonicalSubmissionDigest } from "flywheel-config";
import type { ConfirmTokenStore } from "./fleet-admin.js";
import { isSameOrigin, loopbackSelfOrigin } from "./loopback-origin.js";

export interface WorkflowCarrierRedriveCanonical {
	requestId: string;
	runId: string;
	questionId: string;
	gateNodeId: string;
	gateAttempt: number;
	approvedHead: string;
	sourceExecutionId: string;
	reason: string;
}

interface WorkflowCarrierRedriveStore {
	resolveWorkflowCarrierRedriveCanonical(input: {
		runId: string;
		questionId: string;
		approvedHead: string;
		reason: string;
	}): WorkflowCarrierRedriveCanonical | undefined;
	getWorkflowCarrierRedriveReceipt(requestId: string):
		| {
				requestId: string;
				canonicalDigest: string;
				questionId: string;
				appliedAt: string;
		  }
		| undefined;
	redriveWorkflowCarrierDelivery(input: {
		requestId: string;
		questionId: string;
		canonicalDigest: string;
		principal: "master";
		reason: string;
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
}

interface HandlerDeps {
	store: WorkflowCarrierRedriveStore;
	tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume">;
}

type HandlerResult = { code: number; body: Record<string, unknown> };

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCanonical(
	value: unknown,
): WorkflowCarrierRedriveCanonical | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const raw = value as Record<string, unknown>;
	const exactKeys = [
		"requestId",
		"runId",
		"questionId",
		"gateNodeId",
		"gateAttempt",
		"approvedHead",
		"sourceExecutionId",
		"reason",
	];
	if (
		Object.keys(raw).length !== exactKeys.length ||
		!exactKeys.every((key) => Object.hasOwn(raw, key))
	) {
		return;
	}
	const requestId = nonEmptyString(raw.requestId);
	const runId = nonEmptyString(raw.runId);
	const questionId = nonEmptyString(raw.questionId);
	const gateNodeId = nonEmptyString(raw.gateNodeId);
	const approvedHead = nonEmptyString(raw.approvedHead)?.toLowerCase();
	const sourceExecutionId = nonEmptyString(raw.sourceExecutionId);
	const reason = nonEmptyString(raw.reason);
	if (
		!requestId ||
		!/^carrier-redrive:[0-9a-f]{64}$/i.test(requestId) ||
		!runId ||
		!questionId ||
		!gateNodeId ||
		!Number.isSafeInteger(raw.gateAttempt) ||
		Number(raw.gateAttempt) < 1 ||
		!approvedHead ||
		!/^[0-9a-f]{40}$/.test(approvedHead) ||
		!sourceExecutionId ||
		!reason ||
		reason.length > 500
	) {
		return;
	}
	return {
		requestId,
		runId,
		questionId,
		gateNodeId,
		gateAttempt: Number(raw.gateAttempt),
		approvedHead,
		sourceExecutionId,
		reason,
	};
}

export function handleWorkflowCarrierRedriveStage(
	deps: HandlerDeps,
	body: unknown,
): HandlerResult {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { code: 400, body: { ok: false, reason: "invalid_request" } };
	}
	const raw = body as Record<string, unknown>;
	const exactKeys = ["runId", "questionId", "approvedHead", "reason"];
	if (
		Object.keys(raw).length !== exactKeys.length ||
		!exactKeys.every((key) => Object.hasOwn(raw, key))
	) {
		return { code: 400, body: { ok: false, reason: "invalid_request" } };
	}
	const runId = nonEmptyString(raw.runId);
	const questionId = nonEmptyString(raw.questionId);
	const approvedHead = nonEmptyString(raw.approvedHead)?.toLowerCase();
	const reason = nonEmptyString(raw.reason);
	if (
		!runId ||
		!questionId ||
		!approvedHead ||
		!/^[0-9a-f]{40}$/.test(approvedHead) ||
		!reason ||
		reason.length > 500
	) {
		return { code: 400, body: { ok: false, reason: "invalid_request" } };
	}
	const canonical = deps.store.resolveWorkflowCarrierRedriveCanonical({
		runId,
		questionId,
		approvedHead,
		reason,
	});
	if (!canonical) {
		return {
			code: 409,
			body: { ok: false, reason: "carrier_redrive_proof_unavailable" },
		};
	}
	return {
		code: 200,
		body: {
			ok: true,
			canonical,
			confirmToken: deps.tokens.issue(canonicalSubmissionDigest(canonical)),
		},
	};
}

export function handleWorkflowCarrierRedriveApply(
	deps: HandlerDeps,
	body: unknown,
	principal: "master",
	now: string,
): HandlerResult {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { code: 400, body: { ok: false, reason: "invalid_request" } };
	}
	const raw = body as Record<string, unknown>;
	if (
		Object.keys(raw).length !== 2 ||
		!Object.hasOwn(raw, "canonical") ||
		!Object.hasOwn(raw, "confirmToken")
	) {
		return { code: 400, body: { ok: false, reason: "invalid_request" } };
	}
	const canonical = parseCanonical(raw.canonical);
	const confirmToken = nonEmptyString(raw.confirmToken);
	if (!canonical || !confirmToken) {
		return { code: 400, body: { ok: false, reason: "invalid_request" } };
	}
	const canonicalDigest = canonicalSubmissionDigest(canonical);
	const prior = deps.store.getWorkflowCarrierRedriveReceipt(
		canonical.requestId,
	);
	if (prior) {
		if (
			prior.canonicalDigest !== canonicalDigest ||
			prior.questionId !== canonical.questionId
		) {
			return { code: 409, body: { ok: false, reason: "request_conflict" } };
		}
		return {
			code: 200,
			body: {
				ok: true,
				idempotentReplay: true,
				questionId: prior.questionId,
				appliedAt: prior.appliedAt,
			},
		};
	}
	const current = deps.store.resolveWorkflowCarrierRedriveCanonical({
		runId: canonical.runId,
		questionId: canonical.questionId,
		approvedHead: canonical.approvedHead,
		reason: canonical.reason,
	});
	if (!current || canonicalSubmissionDigest(current) !== canonicalDigest) {
		return {
			code: 409,
			body: { ok: false, reason: "carrier_state_changed" },
		};
	}
	const token = deps.tokens.verifyAndConsume(confirmToken, canonicalDigest);
	if (!token.ok) {
		return { code: 403, body: { ok: false, reason: token.reason } };
	}
	const result = deps.store.redriveWorkflowCarrierDelivery({
		requestId: canonical.requestId,
		questionId: canonical.questionId,
		canonicalDigest,
		principal,
		reason: canonical.reason,
		now,
	});
	return result.ok ? { code: 200, body: result } : { code: 409, body: result };
}

function bearerMatches(header: string | undefined, token: string): boolean {
	if (!header) return false;
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(header);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sameOriginRequest(req: express.Request): boolean {
	const selfOrigin = loopbackSelfOrigin(req.headers.host);
	if (!selfOrigin) return false;
	return isSameOrigin(
		{
			origin:
				typeof req.headers.origin === "string" ? req.headers.origin : undefined,
			referer:
				typeof req.headers.referer === "string"
					? req.headers.referer
					: undefined,
		},
		selfOrigin,
	);
}

export function createWorkflowCarrierRedriveRouter(input: {
	store: WorkflowCarrierRedriveStore;
	tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume">;
	apiToken?: string;
	now?: () => string;
}): express.Router {
	const router = express.Router();
	const requireAdmin: express.RequestHandler = (req, res, next) => {
		if (!input.apiToken) {
			res.status(503).json({
				ok: false,
				reason: "carrier_redrive_requires_TEAMLEAD_API_TOKEN",
			});
			return;
		}
		if (!bearerMatches(req.headers.authorization, input.apiToken)) {
			res.status(401).json({ ok: false, reason: "unauthorized" });
			return;
		}
		if (!sameOriginRequest(req)) {
			res.status(403).json({ ok: false, reason: "origin_rejected" });
			return;
		}
		next();
	};
	router.post("/carrier-redrive/stage", requireAdmin, (req, res) => {
		const result = handleWorkflowCarrierRedriveStage(input, req.body);
		res.status(result.code).json(result.body);
	});
	router.post("/carrier-redrive", requireAdmin, (req, res) => {
		const result = handleWorkflowCarrierRedriveApply(
			input,
			req.body,
			"master",
			input.now?.() ?? new Date().toISOString(),
		);
		res.status(result.code).json(result.body);
	});
	return router;
}
