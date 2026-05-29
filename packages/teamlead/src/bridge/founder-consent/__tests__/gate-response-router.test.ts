import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluateResult, FounderConsentEvaluator } from "../evaluator.js";
import { createGateResponseRouter } from "../gate-response-router.js";

const PROJECT = "TestProj";
let dir: string;
let commDbPath: string;
let server: Server;

async function request(method: string, path: string, body?: unknown) {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("not bound");
	const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
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
	mode: "audit_only" | "enforce" = "enforce",
): FounderConsentEvaluator {
	return {
		decisionMode: mode,
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

function mkServer(evaluator: FounderConsentEvaluator) {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/founder-consent/runner-gate-response",
		createGateResponseRouter({
			evaluator,
			resolveContext: async (execId) =>
				execId
					? { issueId: "i1", issueIdentifier: "FLY-175", projectName: PROJECT }
					: null,
			getSessionProject: (execId) =>
				execId === "exec-1" ? { project_name: PROJECT } : undefined,
			configuredProjects: new Set([PROJECT]),
			commRoot: join(dir, "comm"),
		}),
	);
	server = createServer(app);
	server.listen(0);
	return server;
}

function seedQuestion(checkpoint: string): string {
	const db = new CommDB(commDbPath, true);
	const qid = db.insertQuestion("exec-1", "lead-x", "ship it?", { checkpoint });
	db.close();
	return qid;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gate-"));
	const projDir = join(dir, "comm", PROJECT);
	mkdirSync(projDir, { recursive: true });
	commDbPath = join(projDir, "comm.db");
});
afterEach(() => {
	server?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("gate-response-router (Surface B)", () => {
	it("ALLOW: writes the CommDB response", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "approved",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(200);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.content).toBe("approved");
		db.close();
	});

	it("DENY: 403, no CommDB response written", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("deny"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "approved",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(403);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)).toBeUndefined();
		db.close();
	});

	it("audit_only: writes response even when evaluator denies", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("deny", "audit_only"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "approved",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(200);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.content).toBe("approved");
		db.close();
	});

	it("rejects caller-supplied dbPath (security)", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "x",
				executionId: "exec-1",
				dbPath: "/etc/evil.db",
			},
		);
		expect(res.status).toBe(400);
	});

	it("rejects unknown project", async () => {
		seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: "q",
				leadId: "lead-x",
				answer: "x",
				projectName: "NopeProj",
			},
		);
		expect(res.status).toBe(403);
	});

	it("rejects a non-approve_to_ship checkpoint", async () => {
		const qid = seedQuestion("brainstorm");
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "x",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(400);
	});

	it("400 on missing required fields", async () => {
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				leadId: "lead-x",
			},
		);
		expect(res.status).toBe(400);
	});

	it("PASS-THROUGH (evaluator undefined / off): writes response without consent check", async () => {
		const qid = seedQuestion("approve_to_ship");
		// Mount with NO evaluator — mirrors DECISION_MODE=off. The CLI still
		// routes here, so it must write (not 404) — Codex R1 HIGH fix.
		const app = express();
		app.use(express.json());
		app.use(
			"/api/founder-consent/runner-gate-response",
			createGateResponseRouter({
				evaluator: undefined,
				resolveContext: async () => null,
				getSessionProject: () => ({ project_name: PROJECT }),
				configuredProjects: new Set([PROJECT]),
				commRoot: join(dir, "comm"),
			}),
		);
		server = createServer(app);
		server.listen(0);
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "approved",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(200);
		expect((res.body as { passthrough?: boolean }).passthrough).toBe(true);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.content).toBe("approved");
		db.close();
	});
});
