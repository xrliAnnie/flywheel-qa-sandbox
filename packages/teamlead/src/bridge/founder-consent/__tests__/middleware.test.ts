import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { EvaluateResult, FounderConsentEvaluator } from "../evaluator.js";
import {
	founderConsentMiddleware,
	type ResolvedConsentContext,
} from "../middleware.js";

function mkRes() {
	const res = {
		statusCode: 0,
		jsonBody: undefined as unknown,
		status(c: number) {
			this.statusCode = c;
			return this;
		},
		json(b: unknown) {
			this.jsonBody = b;
			return this;
		},
	};
	return res as unknown as Response & {
		statusCode: number;
		jsonBody: unknown;
	};
}

const mkReq = (over: Partial<Request> = {}): Request =>
	({ path: "/approve", params: {}, body: {}, ...over }) as Request;

const ctx: ResolvedConsentContext = {
	issueId: "i1",
	issueIdentifier: "FLY-175",
	projectName: "Flywheel",
	executionId: "exec-1",
	threadId: "t1",
};

function fakeEvaluator(
	decisionMode: "audit_only" | "enforce",
	result: Partial<EvaluateResult>,
): FounderConsentEvaluator {
	return {
		decisionMode,
		evaluate: vi.fn(async () => ({
			decision: "deny",
			decisionSource: "llm",
			confidence: 0,
			thresholdApplied: 0.85,
			evidenceMessageId: null,
			evidenceExcerpt: null,
			llmReason: "no",
			auditId: 1,
			...result,
		})),
	} as unknown as FounderConsentEvaluator;
}

describe("founderConsentMiddleware", () => {
	it("no-op (byte-compat) when evaluator is undefined (off)", async () => {
		const next = vi.fn();
		const mw = founderConsentMiddleware("action_router", {
			evaluator: undefined,
			resolveContext: async () => ctx,
		});
		await mw(
			mkReq({ body: { execution_id: "exec-1" } }),
			mkRes(),
			next as NextFunction,
		);
		expect(next).toHaveBeenCalledOnce();
	});

	it("passes through a non-reserved action without evaluating", async () => {
		const ev = fakeEvaluator("enforce", { decision: "deny" });
		const next = vi.fn();
		const mw = founderConsentMiddleware("action_router", {
			evaluator: ev,
			resolveContext: async () => ctx,
		});
		await mw(mkReq({ path: "/status" }), mkRes(), next as NextFunction);
		expect(next).toHaveBeenCalledOnce();
		expect(ev.evaluate).not.toHaveBeenCalled();
	});

	it("passes through when context can't be resolved (downstream 404s)", async () => {
		const ev = fakeEvaluator("enforce", { decision: "deny" });
		const next = vi.fn();
		const mw = founderConsentMiddleware("action_router", {
			evaluator: ev,
			resolveContext: async () => null,
		});
		await mw(
			mkReq({ body: { execution_id: "missing" } }),
			mkRes(),
			next as NextFunction,
		);
		expect(next).toHaveBeenCalledOnce();
		expect(ev.evaluate).not.toHaveBeenCalled();
	});

	it("audit_only ALWAYS calls next, even on deny", async () => {
		const ev = fakeEvaluator("audit_only", { decision: "deny" });
		const next = vi.fn();
		const res = mkRes();
		const mw = founderConsentMiddleware("action_router", {
			evaluator: ev,
			resolveContext: async () => ctx,
		});
		await mw(
			mkReq({ body: { execution_id: "exec-1" } }),
			res,
			next as NextFunction,
		);
		expect(ev.evaluate).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledOnce();
		expect(res.statusCode).toBe(0);
	});

	it("enforce: allow → next", async () => {
		const ev = fakeEvaluator("enforce", { decision: "allow" });
		const next = vi.fn();
		const mw = founderConsentMiddleware("action_router", {
			evaluator: ev,
			resolveContext: async () => ctx,
		});
		await mw(
			mkReq({ body: { execution_id: "exec-1" } }),
			mkRes(),
			next as NextFunction,
		);
		expect(next).toHaveBeenCalledOnce();
	});

	it("enforce: deny → 403 FOUNDER_CONSENT_REQUIRED, no next", async () => {
		const ev = fakeEvaluator("enforce", {
			decision: "deny",
			code: "FOUNDER_CONSENT_REQUIRED",
			evidenceExcerpt: "QA?",
		});
		const next = vi.fn();
		const res = mkRes();
		const mw = founderConsentMiddleware("action_router", {
			evaluator: ev,
			resolveContext: async () => ctx,
		});
		await mw(
			mkReq({ body: { execution_id: "exec-1" } }),
			res,
			next as NextFunction,
		);
		expect(res.statusCode).toBe(403);
		expect((res.jsonBody as { code: string }).code).toBe(
			"FOUNDER_CONSENT_REQUIRED",
		);
		expect(next).not.toHaveBeenCalled();
	});

	it("enforce: fail_closed → 503, no next", async () => {
		const ev = fakeEvaluator("enforce", {
			decision: "fail_closed",
			code: "FOUNDER_CONSENT_LLM_UNREACHABLE",
		});
		const next = vi.fn();
		const res = mkRes();
		const mw = founderConsentMiddleware("close_tmux", {
			evaluator: ev,
			resolveContext: async () => ctx,
		});
		await mw(
			mkReq({ params: { executionId: "exec-1" } as Request["params"] }),
			res,
			next as NextFunction,
		);
		expect(res.statusCode).toBe(503);
		expect(next).not.toHaveBeenCalled();
	});

	it("enforce: middleware error fails closed (503)", async () => {
		const ev = fakeEvaluator("enforce", {});
		(ev.evaluate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("boom"),
		);
		const next = vi.fn();
		const res = mkRes();
		const mw = founderConsentMiddleware("action_router", {
			evaluator: ev,
			resolveContext: async () => ctx,
		});
		await mw(
			mkReq({ body: { execution_id: "exec-1" } }),
			res,
			next as NextFunction,
		);
		expect(res.statusCode).toBe(503);
		expect(next).not.toHaveBeenCalled();
	});
});
