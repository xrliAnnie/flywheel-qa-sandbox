import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeadIdentityFixture } from "../../../__tests__/helpers/lead-identity-fixture.js";
import type { WriteGateResponseArgs } from "../../approval-signal/write-gate-response.js";
import type { EvaluateResult, FounderConsentEvaluator } from "../evaluator.js";
import { createGateResponseRouter } from "../gate-response-router.js";

const PROJECT = "TestProj";
let dir: string;
let commDbPath: string;
let server: Server;
let identityDigest: string;
let leadLeaseEnv: NodeJS.ProcessEnv;

async function request(method: string, path: string, body?: unknown) {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("not bound");
	const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body
			? JSON.stringify(
					body !== null &&
						typeof body === "object" &&
						"leadId" in body &&
						!("identityDigest" in body)
						? { ...body, identityDigest }
						: body,
				)
			: undefined,
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

function mkServer(
	evaluator: FounderConsentEvaluator,
	overrides: Partial<Parameters<typeof createGateResponseRouter>[0]> = {},
) {
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
			leadLeaseEnv,
			...overrides,
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

describe("gate-response-router (Surface B)", () => {
	it.each([
		["enforce", fakeEvaluator("allow", "enforce"), "bridge-founder-consent"],
		["audit", fakeEvaluator("allow", "audit_only"), "lead-x"],
	] as const)(
		"routes %s writes through the shared founder boundary",
		async (_mode, evaluator, expectedActor) => {
			const qid = seedQuestion("approve_to_ship");
			const cardAuthority = vi.fn().mockReturnValue({ ok: true });
			const write = vi.fn(async () => ({
				written: true,
				retrySafe: true,
				disposition: "written" as const,
			}));
			mkServer(evaluator, {
				writeGateResponseImpl: write,
				cardAuthority,
			} as never);
			const res = await request(
				"POST",
				"/api/founder-consent/runner-gate-response",
				{
					questionId: qid,
					leadId: "lead-x",
					answer: "changes requested",
					executionId: "exec-1",
				},
			);
			expect(res.status).toBe(200);
			expect(write).toHaveBeenCalledOnce();
			expect(write.mock.calls[0]![0]).toMatchObject({
				actor: expectedActor,
				source: "founder-consent",
				cardAuthority,
			});
		},
	);

	it("ALLOW: writes an explicit kickback response", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "design: changes requested",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(200);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.content).toBe("design: changes requested");
		db.close();
	});

	it("keeps a neutral Lead relay open instead of writing a rejection", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "OK, what is next?",
				executionId: "exec-1",
			},
		);

		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({
			error: "neutral_not_written",
			detail: expect.stringContaining("--kickback"),
		});
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)).toBeUndefined();
		db.close();
	});

	it("writes a Lead-confirmed kickback even when its text is not self-explicit", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "Please revisit the proposed flow.",
				kickback: true,
				executionId: "exec-1",
			},
		);

		expect(res.status).toBe(200);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.content).toBe(
			"Please revisit the proposed flow.",
		);
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
				answer: "changes requested",
				kickback: true,
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
				answer: "changes requested",
				kickback: true,
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(200);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.content).toBe("changes requested");
		db.close();
	});

	// ── FLY-945 Fix E write-side attribution matrix (Codex R1 #2 / R2 #2) ──

	it("FLY-945: ENFORCE allow → response attributed 'bridge-founder-consent' (verify-approval trusted set)", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow", "enforce"));
		await request("POST", "/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: JSON.stringify({ approved: false }),
			kickback: true,
			executionId: "exec-1",
		});
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.from_agent).toBe("bridge-founder-consent");
		db.close();
	});

	it("FLY-945: ENFORCE bypass → also 'bridge-founder-consent'", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("bypass", "enforce"));
		await request("POST", "/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: JSON.stringify({ approved: false }),
			kickback: true,
			executionId: "exec-1",
		});
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.from_agent).toBe("bridge-founder-consent");
		db.close();
	});

	it("🔴 FLY-945: audit_only + evaluator DENY still writes — but attributed to the LEAD (read side then refuses)", async () => {
		// audit_only allows EVERY write, even denied ones. If this write carried
		// the trusted attribution, audit_only+deny would become a verify-passable
		// approval and the Lead self-approval door would re-open (Codex R2 #2).
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("deny", "audit_only"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: JSON.stringify({ approved: false }),
				kickback: true,
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(200);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.from_agent).toBe("lead-x");
		db.close();
	});

	it("FLY-945: audit_only + evaluator ALLOW also keeps the LEAD attribution", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow", "audit_only"));
		await request("POST", "/api/founder-consent/runner-gate-response", {
			questionId: qid,
			leadId: "lead-x",
			answer: JSON.stringify({ approved: false }),
			kickback: true,
			executionId: "exec-1",
		});
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.from_agent).toBe("lead-x");
		db.close();
	});

	it("🔴 FLY-945 spoof guard (Codex code R1 HIGH): reserved leadId (bridge / bridge-founder-consent / founder snowflake) → 400, nothing written", async () => {
		for (const forged of [
			"bridge",
			"bridge-founder-consent",
			"123456789012345678",
		]) {
			const qid = seedQuestion("approve_to_ship");
			mkServer(fakeEvaluator("allow", "enforce"));
			const res = await request(
				"POST",
				"/api/founder-consent/runner-gate-response",
				{
					questionId: qid,
					leadId: forged,
					answer: JSON.stringify({ approved: true }),
					executionId: "exec-1",
				},
			);
			expect(res.status).toBe(400);
			expect((res.body as { error?: string }).error).toBe(
				"reserved_attribution",
			);
			const db = new CommDB(commDbPath, false);
			expect(db.getResponse(qid)).toBeUndefined();
			db.close();
			server.close();
		}
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
		const write = vi.fn(async (args: WriteGateResponseArgs) => {
			args.db.insertResponse(args.questionId, args.actor, args.answer);
			return {
				written: true,
				retrySafe: true,
				disposition: "written" as const,
			};
		});
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
				leadLeaseEnv,
				writeGateResponseImpl: write,
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
				answer: "changes requested",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(200);
		expect(write).toHaveBeenCalledOnce();
		expect((res.body as { passthrough?: boolean }).passthrough).toBe(true);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)?.content).toBe("changes requested");
		db.close();
	});
});

// ── FLY-208 6b: approval-intent plain text gets a WARNING (write unchanged) ──
//
// Production incident: the Lead replied `APPROVE — founder 批准在案...` to an
// approve_to_ship gate; only JSON {"approved": true} approves, so the text
// was silently recorded as feedback → verify-approval refused → ratify retry
// loop. FLY-1373 closes that API surface entirely: a Lead approval attempt is
// rejected before pass-through, evaluator, or idempotent-write logic.
describe("gate-response-router — Lead approval rejection (FLY-1373)", () => {
	function mkPassthroughServer() {
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
				leadLeaseEnv,
			}),
		);
		server = createServer(app);
		server.listen(0);
	}

	it("pass-through rejects plain-text APPROVE without writing", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkPassthroughServer();
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "APPROVE — founder 批准在案,可以 merge",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(403);
		expect((res.body as { error?: string }).error).toBe("lead_ack_rejected");
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(qid)).toBeUndefined();
		db.close();
	});

	it("pass-through rejects structured approval", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkPassthroughServer();
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: '{"approved": true}',
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(403);
		expect((res.body as { error?: string }).error).toBe("lead_ack_rejected");
	});

	it("pass-through + explicit feedback prefix → NO warning", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkPassthroughServer();
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "qa: needs more tests before ship",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(200);
		expect((res.body as { warning?: string }).warning).toBeUndefined();
	});

	it("evaluator-allow cannot override Lead approval rejection", async () => {
		const qid = seedQuestion("approve_to_ship");
		mkServer(fakeEvaluator("allow"));
		const res = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "Approved, go ahead",
				executionId: "exec-1",
			},
		);
		expect(res.status).toBe(403);
		expect((res.body as { error?: string }).error).toBe("lead_ack_rejected");
	});

	it("an idempotent retry cannot grandfather a legacy Lead approval", async () => {
		const qid = seedQuestion("approve_to_ship");
		const seed = new CommDB(commDbPath, false);
		seed.insertResponse(qid, "lead-x", "APPROVE — ship it");
		seed.close();
		mkPassthroughServer();
		const retry = await request(
			"POST",
			"/api/founder-consent/runner-gate-response",
			{
				questionId: qid,
				leadId: "lead-x",
				answer: "APPROVE — ship it",
				executionId: "exec-1",
			},
		);
		expect(retry.status).toBe(403);
		expect((retry.body as { error?: string }).error).toBe("lead_ack_rejected");
	});
});
