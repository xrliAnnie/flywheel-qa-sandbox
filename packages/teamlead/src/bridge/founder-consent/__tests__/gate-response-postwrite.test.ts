/**
 * FLY-191 Phase 2 — gate-response-router post-write hook.
 *
 * The Surface B endpoint is the production `flywheel-comm respond
 * --bridge-url` ship path; after a successful CommDB response write it must
 * invoke `onResponseWritten` (transition + wake in production wiring) on BOTH
 * the pass-through (DECISION_MODE=off) and consent-allow paths — and a hook
 * failure must NEVER fail the request (the response row is already durable).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeadIdentityFixture } from "../../../__tests__/helpers/lead-identity-fixture.js";
import type { EvaluateResult, FounderConsentEvaluator } from "../evaluator.js";
import {
	createGateResponseRouter,
	type GateResponseRouterDeps,
} from "../gate-response-router.js";

const PROJECT = "TestProj";
const FEEDBACK = JSON.stringify({ approved: false, feedback: "fix tests" });
let dir: string;
let commDbPath: string;
let server: Server;
let identityDigest: string;
let leadLeaseEnv: NodeJS.ProcessEnv;

async function request(path: string, body: unknown) {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("not bound");
	const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			body !== null &&
				typeof body === "object" &&
				"leadId" in body &&
				!("identityDigest" in body)
				? { ...body, identityDigest }
				: body,
		),
	});
	let json: unknown;
	try {
		json = await res.json();
	} catch {
		json = undefined;
	}
	return { status: res.status, body: json };
}

function fakeEvaluator(
	decision: EvaluateResult["decision"],
): FounderConsentEvaluator {
	return {
		decisionMode: "enforce",
		evaluate: vi.fn(async () => ({
			decision,
			decisionSource: "llm",
			confidence: decision === "allow" ? 0.95 : 0,
			thresholdApplied: 0.85,
			evidenceMessageId: null,
			evidenceExcerpt: null,
			llmReason: "x",
			auditId: 1,
			code: decision === "deny" ? "FOUNDER_CONSENT_REQUIRED" : undefined,
		})),
	} as unknown as FounderConsentEvaluator;
}

function mkServer(
	deps: Partial<GateResponseRouterDeps> & {
		evaluator?: FounderConsentEvaluator;
	},
) {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/founder-consent/runner-gate-response",
		createGateResponseRouter({
			evaluator: deps.evaluator,
			resolveContext: async (execId) =>
				execId
					? { issueId: "i1", issueIdentifier: "FLY-191", projectName: PROJECT }
					: null,
			getSessionProject: (execId) =>
				execId === "exec-1" ? { project_name: PROJECT } : undefined,
			getCurrentReviewQuestionId: deps.getCurrentReviewQuestionId,
			configuredProjects: new Set([PROJECT]),
			commRoot: join(dir, "comm"),
			leadLeaseEnv,
			onResponseWritten: deps.onResponseWritten,
			logger: { info: () => {}, warn: () => {} },
		}),
	);
	server = createServer(app);
	server.listen(0);
	return server;
}

function seedQuestion(): string {
	const db = new CommDB(commDbPath, true);
	const qid = db.insertQuestion("exec-1", "lead-x", "ship it?", {
		checkpoint: "approve_to_ship",
	});
	db.close();
	return qid;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gate-postwrite-"));
	const projDir = join(dir, "comm", PROJECT);
	mkdirSync(projDir, { recursive: true });
	commDbPath = join(projDir, "comm.db");
	({ identityDigest, env: leadLeaseEnv } = createLeadIdentityFixture({
		root: dir,
		projectName: PROJECT,
		leadId: "lead-x",
	}));
});
afterEach(() => {
	server?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("gate-response post-write hook (FLY-191 Phase 2)", () => {
	it("PASS-THROUGH (off): hook invoked with executionId + answer after the write", async () => {
		const qid = seedQuestion();
		const hook = vi.fn(async () => {});
		mkServer({ evaluator: undefined, onResponseWritten: hook });

		const res = await request("/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: FEEDBACK,
			kickback: true,
			executionId: "exec-1",
		});
		expect(res.status).toBe(200);
		expect(hook).toHaveBeenCalledTimes(1);
		const info = hook.mock.calls[0]?.[0] as {
			executionId: string;
			questionId: string;
			leadId: string;
			answer: string;
		};
		expect(info.executionId).toBe("exec-1");
		expect(info.questionId).toBe(qid);
		expect(info.answer).toBe(FEEDBACK);
	});

	it("ALLOW (enforce): hook invoked after the consent-allowed write", async () => {
		const qid = seedQuestion();
		const hook = vi.fn(async () => {});
		mkServer({ evaluator: fakeEvaluator("allow"), onResponseWritten: hook });

		const res = await request("/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: FEEDBACK,
			kickback: true,
			executionId: "exec-1",
		});
		expect(res.status).toBe(200);
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("DENY: hook NOT invoked (no write happened)", async () => {
		const qid = seedQuestion();
		const hook = vi.fn(async () => {});
		mkServer({ evaluator: fakeEvaluator("deny"), onResponseWritten: hook });

		const res = await request("/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: FEEDBACK,
			kickback: true,
			executionId: "exec-1",
		});
		expect(res.status).toBe(403);
		expect(hook).not.toHaveBeenCalled();
	});

	// FLY-191 Phase 2 (Codex PR R1 CRITICAL): only the CURRENT review question
	// is answerable once a binding exists.
	it("REJECTS (409) an answer to a stale question once a re-review re-binds", async () => {
		const staleQ = seedQuestion();
		const hook = vi.fn(async () => {});
		mkServer({
			evaluator: undefined,
			onResponseWritten: hook,
			getCurrentReviewQuestionId: () => "the-new-current-question",
		});

		const res = await request("/api/founder-consent/runner-gate-response", {
			questionId: staleQ,
			leadId: "lead-x",
			answer: FEEDBACK,
			kickback: true,
			executionId: "exec-1",
		});
		expect(res.status).toBe(409);
		expect((res.body as { error?: string }).error).toBe(
			"stale_review_question",
		);
		expect(hook).not.toHaveBeenCalled();

		// No response written for the stale question
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(staleQ)).toBeUndefined();
		db.close();
	});

	it("ALLOWS the answer when no binding exists (legacy blocking-gate byte-compat)", async () => {
		const qid = seedQuestion();
		const hook = vi.fn(async () => {});
		mkServer({
			evaluator: undefined,
			onResponseWritten: hook,
			getCurrentReviewQuestionId: () => undefined,
		});

		const res = await request("/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: FEEDBACK,
			kickback: true,
			executionId: "exec-1",
		});
		expect(res.status).toBe(200);
		expect(hook).toHaveBeenCalledTimes(1);
	});

	// FLY-191 Phase 2 (Codex R2 HIGH-2): idempotent retry past the
	// one-response-per-question unique index.
	it("retry with a matching answer SKIPS the duplicate write but RE-RUNS the hook (200 alreadyResponded)", async () => {
		const qid = seedQuestion();
		const hook = vi.fn(async () => {});
		mkServer({ evaluator: undefined, onResponseWritten: hook });

		const body = {
			questionId: qid,
			leadId: "lead-x",
			answer: FEEDBACK,
			kickback: true,
			executionId: "exec-1",
		};
		const r1 = await request("/api/founder-consent/runner-gate-response", body);
		expect(r1.status).toBe(200);
		expect(hook).toHaveBeenCalledTimes(1);

		// Retry (e.g. first call's transition failed downstream) — without the
		// idempotent path this would hit idx_unique_response and 500.
		const r2 = await request("/api/founder-consent/runner-gate-response", body);
		expect(r2.status).toBe(200);
		expect((r2.body as { alreadyResponded?: boolean }).alreadyResponded).toBe(
			true,
		);
		expect(hook).toHaveBeenCalledTimes(2); // recovery hook re-ran
	});

	it("different feedback text is an idempotent changes-requested retry", async () => {
		const qid = seedQuestion();
		const hook = vi.fn(async () => {});
		mkServer({ evaluator: undefined, onResponseWritten: hook });

		await request("/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: "changes requested: fix the tests",
			kickback: true,
			executionId: "exec-1",
		});
		const r2 = await request("/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: "changes requested: use the other implementation",
			kickback: true,
			executionId: "exec-1",
		});
		expect(r2.status).toBe(200);
		expect((r2.body as { alreadyResponded?: boolean }).alreadyResponded).toBe(
			true,
		);
		expect(hook).toHaveBeenCalledTimes(2);
	});

	it("hook failure does NOT fail the request — response row stays durable", async () => {
		const qid = seedQuestion();
		const hook = vi.fn(async () => {
			throw new Error("transition exploded");
		});
		mkServer({ evaluator: undefined, onResponseWritten: hook });

		const res = await request("/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: FEEDBACK,
			kickback: true,
			executionId: "exec-1",
		});
		expect(res.status).toBe(200);

		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.content).toBe(FEEDBACK);
		db.close();
	});
});
