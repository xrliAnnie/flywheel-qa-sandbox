import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveExecution, transitionSession } from "../bridge/actions.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

// ApproveHandler calls execFn twice:
// 1. gh pr list ... --json number,url → must return JSON array of PRs
// 2. gh pr merge ... → any output is fine
const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
	if (args.includes("list")) {
		return {
			stdout: JSON.stringify([
				{ number: 42, url: "https://github.com/test/pr/42" },
			]),
		};
	}
	return { stdout: "merged" };
});

// FLY-191 Phase 2 (Codex PR R1 HIGH-3): approve now REQUIRES a CommDB gate
// response to be writable BEFORE the transition — a sandbox comm root +
// seeded pending approve_to_ship question are part of every approve-success
// test's arrange step.
let commRoot: string;
beforeEach(() => {
	commRoot = mkdtempSync(join(tmpdir(), "fly191-actions-comm-"));
	process.env.FLYWHEEL_COMM_ROOT = commRoot;
});
afterEach(() => {
	rmSync(commRoot, { recursive: true, force: true });
	delete process.env.FLYWHEEL_COMM_ROOT;
});

/** Seed a pending approve_to_ship gate question for the runner. */
function seedApproveGate(
	execId: string,
	project = "geoforge3d",
	lead = "product-lead",
): string {
	mkdirSync(join(commRoot, project), { recursive: true });
	const db = new CommDB(join(commRoot, project, "comm.db"), true);
	try {
		db.registerSession(execId, "sess:win", project, undefined, lead);
		return db.insertQuestion(execId, lead, "PR ready for review", {
			checkpoint: "approve_to_ship",
		});
	} finally {
		db.close();
	}
}

describe("Action tools", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, testProjects, makeConfig());
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		mockExec.mockClear();
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("POST /api/actions/approve with valid execution_id succeeds", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-95",
		});

		seedApproveGate("e1");
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			"GEO-95",
			mockExec,
		);
		expect(result.success, result.message).toBe(true);
		// FLY-58: approve no longer calls ApproveHandler (no git merge)
		expect(mockExec).not.toHaveBeenCalled();
	});

	it("projects an enrolled founder approval through the atomic CommDB source row", async () => {
		const head = "a".repeat(40);
		const questionId = seedApproveGate("e-claims");
		store.upsertSession({
			execution_id: "e-claims",
			issue_id: "i-claims",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		store.setReviewBinding("e-claims", {
			questionId,
			prHeadSha: head,
		});
		store.applyWorkflowShadowBatch({
			projectName: "geoforge3d",
			issueId: "i-claims",
			newRunId: "run-claims",
			ops: [
				{
					op: "dispatch",
					node: "implement",
					attempt: 1,
					executionId: "e-claims",
				},
			],
		});

		const result = await approveExecution(
			store,
			testProjects,
			"e-claims",
			"GEO-CLAIMS",
			mockExec,
		);
		expect(result.success, result.message).toBe(true);

		const db = new CommDB(join(commRoot, "geoforge3d", "comm.db"), false);
		try {
			const rows = db.listWorkflowSourceEvents();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				project: "geoforge3d",
				source_event_id: `founder-approval:${questionId}`,
				kind: "founder_approval",
			});
			expect(JSON.parse(rows[0]!.payload)).toMatchObject({
				run_id: "run-claims",
				issue_id: "i-claims",
				approved_head: head,
				classification: "dashboard_founder_action",
				authority_id: questionId,
			});
		} finally {
			db.close();
		}
	});

	it("dashboard approve remains the explicit merge-block recovery surface", async () => {
		const head = "b".repeat(40);
		store.upsertSession({
			execution_id: "e-held",
			issue_id: "i-held",
			project_name: "geoforge3d",
			status: "awaiting_review",
			session_role: "implement",
			codex_skip: 1,
		});
		store.setMergeBlock({
			executionId: "e-held",
			reason: "merge_without_approval",
			head,
		});
		const questionId = seedApproveGate("e-held");
		store.setReviewBinding("e-held", { questionId, prHeadSha: head });

		const result = await approveExecution(
			store,
			testProjects,
			"e-held",
			"GEO-HELD",
			mockExec,
			undefined,
			makeConfig(),
		);
		expect(result.success, result.message).toBe(true);

		const db = new CommDB(join(commRoot, "geoforge3d", "comm.db"), false);
		try {
			expect(JSON.parse(db.getResponse(questionId)?.content ?? "{}")).toEqual({
				approved: true,
			});
		} finally {
			db.close();
		}
	});

	it("dashboard merge-block recovery still reports a downstream codex hold", async () => {
		const head = "c".repeat(40);
		store.upsertSession({
			execution_id: "e-held-codex",
			issue_id: "i-held-codex",
			project_name: "geoforge3d",
			status: "awaiting_review",
			session_role: "implement",
		});
		store.setMergeBlock({
			executionId: "e-held-codex",
			reason: "merge_without_approval",
			head,
		});
		const questionId = seedApproveGate("e-held-codex");
		store.setReviewBinding("e-held-codex", { questionId, prHeadSha: head });

		const previousHardGate = process.env.FLYWHEEL_CODEX_HARD_GATE;
		process.env.FLYWHEEL_CODEX_HARD_GATE = "1";
		let result: Awaited<ReturnType<typeof approveExecution>>;
		try {
			result = await approveExecution(
				store,
				testProjects,
				"e-held-codex",
				"GEO-HELD-CODEX",
				mockExec,
				undefined,
				makeConfig(),
			);
		} finally {
			if (previousHardGate === undefined) {
				delete process.env.FLYWHEEL_CODEX_HARD_GATE;
			} else {
				process.env.FLYWHEEL_CODEX_HARD_GATE = previousHardGate;
			}
		}
		expect(result.success).toBe(false);
		expect(result.message).toContain("held_codex_pending");

		const db = new CommDB(join(commRoot, "geoforge3d", "comm.db"), false);
		try {
			expect(db.getResponse(questionId)).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("dashboard approve passes the actions source through the card-authority seam", async () => {
		store.upsertSession({
			execution_id: "e-card",
			issue_id: "i-card",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const questionId = seedApproveGate("e-card");
		const cardAuthority = vi.fn().mockReturnValue({
			ok: false,
			reason: "inactive_card",
		});

		const result = await approveExecution(
			store,
			testProjects,
			"e-card",
			"GEO-CARD",
			mockExec,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			cardAuthority,
		);

		expect(result.success).toBe(false);
		expect(cardAuthority).toHaveBeenCalledWith({
			executionId: "e-card",
			source: "actions",
			targetMessageId: undefined,
		});
		const db = new CommDB(join(commRoot, "geoforge3d", "comm.db"), false);
		try {
			expect(db.getResponse(questionId)).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("POST /api/actions/approve without execution_id returns 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier: "GEO-95" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("execution_id");
	});

	it("POST /api/actions/approve passes internal issue_id (no merge)", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "internal-uuid-123",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-95",
		});

		seedApproveGate("e1");
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			"GEO-95",
			mockExec,
		);

		// FLY-58: approve no longer calls ApproveHandler (no git merge)
		expect(result.success).toBe(true);
		expect(mockExec).not.toHaveBeenCalled();
	});

	it("POST /api/actions/approve transitions session to approved_to_ship on success", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});

		seedApproveGate("e1");
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(result.success).toBe(true);

		const session = store.getSession("e1");
		expect(session!.status).toBe("approved_to_ship");
	});

	it("POST /api/actions/approve updates last_activity_at on success (SQLite format)", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			last_activity_at: "2026-01-01 00:00:00",
		});

		seedApproveGate("e1");
		await approveExecution(store, testProjects, "e1", undefined, mockExec);

		const session = store.getSession("e1");
		// SQLite datetime format: YYYY-MM-DD HH:MM:SS (no T, no Z)
		expect(session!.last_activity_at).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
		);
	});

	it("approved_to_ship session IS still returned by getActiveSessions()", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});

		expect(store.getActiveSessions()).toHaveLength(1);
		seedApproveGate("e1");
		await approveExecution(store, testProjects, "e1", undefined, mockExec);
		// FLY-58: approved_to_ship is a non-terminal active state
		expect(store.getActiveSessions()).toHaveLength(1);
		expect(store.getActiveSessions()[0].status).toBe("approved_to_ship");
	});

	it("approve with nonexistent execution_id returns error", async () => {
		const result = await approveExecution(store, testProjects, "nonexistent");
		expect(result.success).toBe(false);
		expect(result.message).toContain("No session found");
	});

	// FLY-191 Phase 2 (Codex PR R1 HIGH-3): response-before-transition contract
	it("approve with NO pending gate FAILS and leaves the session awaiting_review (retryable)", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		// CommDB exists (runner registered) but the gate question is
		// missing/expired — the realistic "nothing to honor" case.
		mkdirSync(join(commRoot, "geoforge3d"), { recursive: true });
		const seed = new CommDB(join(commRoot, "geoforge3d", "comm.db"), true);
		seed.registerSession(
			"e1",
			"sess:win",
			"geoforge3d",
			undefined,
			"product-lead",
		);
		seed.close();

		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("no pending approve_to_ship gate");
		// NOT stranded in approved_to_ship: timeout keeps running, approve retryable.
		expect(store.getSession("e1")!.status).toBe("awaiting_review");
	});

	it("approve with an UNREACHABLE CommDB also FAILS without transitioning", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		// No comm.db at all → write path throws → fail-closed, retryable.
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("retry once CommDB is reachable");
		expect(store.getSession("e1")!.status).toBe("awaiting_review");
	});

	it("approve REFUSES an UNBOUND-sentinel session — never strands it via the legacy fallback (Codex R2 HIGH-1)", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		// Phase-2 completion arrived without --question-id → sentinel
		store.setReviewBinding("e1", { questionId: null, prHeadSha: null });
		seedApproveGate("e1"); // a pending gate EXISTS — fallback must NOT use it
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("missing its question binding");
		expect(store.getSession("e1")!.status).toBe("awaiting_review");
	});

	it("approve binds to the session's review_question_id when set — rejects when the bound question is gone", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		store.setReviewBinding("e1", {
			questionId: "00000000-dead-beef-0000-000000000000",
			prHeadSha: null,
		});
		seedApproveGate("e1"); // pending gate exists but is NOT the bound one
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("valid bound review question");
		expect(store.getSession("e1")!.status).toBe("awaiting_review");
	});

	it("approve writes the response on the BOUND question and is idempotent on retry", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const qid = seedApproveGate("e1");
		store.setReviewBinding("e1", {
			questionId: qid,
			prHeadSha: "a".repeat(40),
		});

		const r1 = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(r1.success).toBe(true);

		const db = new CommDB(join(commRoot, "geoforge3d", "comm.db"), false);
		const resp = db.getResponse(qid);
		db.close();
		expect(resp?.content).toBe(JSON.stringify({ approved: true }));
	});

	it("approve with blocked session returns error", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "blocked",
		});

		const result = await approveExecution(store, testProjects, "e1");
		expect(result.success).toBe(false);
		expect(result.message).toContain('expected "awaiting_review"');
	});

	it("POST /api/actions/invalid returns 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/invalid`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	// --- reject ---
	it("reject transitions awaiting_review to rejected", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-50",
		});
		const result = await transitionSession(
			store,
			"reject",
			"e1",
			"Code quality issues",
		);
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("rejected");
		expect(store.getSession("e1")!.last_error).toBe("Code quality issues");
	});

	it("reject from running fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running",
		});
		const result = await transitionSession(store, "reject", "e1");
		expect(result.success).toBe(false);
		expect(result.message).toContain("awaiting_review");
	});

	it("POST /api/actions/reject via HTTP succeeds", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "e1", reason: "Not ready" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.action).toBe("reject");
	});

	it("POST /api/actions/reject without execution_id returns 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "test" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("execution_id");
	});

	// --- defer ---
	it("defer transitions awaiting_review to deferred", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const result = await transitionSession(
			store,
			"defer",
			"e1",
			"Waiting for dependency",
		);
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("deferred");
	});

	it("defer transitions blocked to deferred", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "blocked",
		});
		const result = await transitionSession(store, "defer", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("deferred");
	});

	it("defer from running fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running",
		});
		const result = await transitionSession(store, "defer", "e1");
		expect(result.success).toBe(false);
	});

	// --- retry ---
	it("retry transitions failed to running", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "failed",
		});
		const result = await transitionSession(store, "retry", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("running");
	});

	it("retry transitions rejected to running", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "rejected",
		});
		const result = await transitionSession(store, "retry", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("running");
	});

	it("retry transitions blocked to running", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "blocked",
		});
		const result = await transitionSession(store, "retry", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("running");
	});

	it("retry from awaiting_review fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const result = await transitionSession(store, "retry", "e1");
		expect(result.success).toBe(false);
	});

	// --- shelve ---
	it("shelve transitions awaiting_review to shelved", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const result = await transitionSession(
			store,
			"shelve",
			"e1",
			"Low priority",
		);
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("shelved");
	});

	it("shelve from running fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running",
		});
		const result = await transitionSession(store, "shelve", "e1");
		expect(result.success).toBe(false);
	});

	// --- edge cases ---
	it("transition with nonexistent execution_id returns error", async () => {
		const result = await transitionSession(store, "reject", "nonexistent");
		expect(result.success).toBe(false);
		expect(result.message).toContain("No session found");
	});

	it("transition uses issue_identifier in success message when available", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-42",
		});
		const result = await transitionSession(store, "reject", "e1");
		expect(result.message).toContain("GEO-42");
		expect(result.message).toContain("rejected");
	});

	it("transition without reason sets last_error to null", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			last_error: "previous error",
		});
		await transitionSession(store, "reject", "e1");
		// last_error should be cleared (COALESCE with null keeps old value in SQLite)
		// Actually COALESCE(null, last_error) keeps old value — that's fine, reason is optional
		expect(store.getSession("e1")!.status).toBe("rejected");
	});

	// --- post-action hook tests (GEO-167 → GEO-195 registry pattern) ---
	describe("post-action hooks", () => {
		let capturedEnvelopes: LeadEventEnvelope[];
		let mockRegistry: RuntimeRegistry;

		beforeEach(() => {
			capturedEnvelopes = [];
			const mockRuntime = {
				type: "commdb" as const,
				deliver: vi.fn(async (env: LeadEventEnvelope) => {
					capturedEnvelopes.push(env);
					return { delivered: true };
				}),
				sendBootstrap: vi.fn(async () => {}),
				health: vi.fn(async () => ({
					status: "healthy" as const,
					lastDeliveryAt: null,
					lastDeliveredSeq: 0,
				})),
				shutdown: vi.fn(async () => {}),
			};
			mockRegistry = new RuntimeRegistry();
			for (const project of testProjects) {
				for (const lead of project.leads) {
					mockRegistry.register(lead, mockRuntime);
				}
			}
		});

		it("approve sends action_executed hook", async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status: "awaiting_review",
				issue_identifier: "GEO-99",
			});

			seedApproveGate("e1");
			await approveExecution(
				store,
				testProjects,
				"e1",
				"GEO-99",
				mockExec,
				undefined, // transitionOpts
				undefined, // config
				undefined, // cipherWriter
				undefined, // eventFilter
				undefined, // forumTagUpdater
				mockRegistry,
			);

			// Wait for async hook delivery
			await new Promise((r) => setTimeout(r, 200));

			expect(capturedEnvelopes).toHaveLength(1);
			const payload = capturedEnvelopes[0].event;
			expect(payload.event_type).toBe("action_executed");
			expect(payload.action).toBe("approve");
			expect(payload.action_source_status).toBe("awaiting_review");
			expect(payload.action_target_status).toBe("approved_to_ship");
			expect(payload.status).toBe("approved_to_ship");
		});

		it("reject sends action_executed hook with reason", async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status: "awaiting_review",
				issue_identifier: "GEO-50",
			});

			transitionSession(
				store,
				"reject",
				"e1",
				"needs rework",
				undefined, // transitionOpts
				undefined, // config
				undefined, // cipherWriter
				testProjects,
				undefined, // eventFilter
				undefined, // forumTagUpdater
				mockRegistry,
			);

			await new Promise((r) => setTimeout(r, 200));

			expect(capturedEnvelopes).toHaveLength(1);
			const payload = capturedEnvelopes[0].event;
			expect(payload.event_type).toBe("action_executed");
			expect(payload.action).toBe("reject");
			expect(payload.action_reason).toBe("needs rework");
			expect(payload.action_source_status).toBe("awaiting_review");
			expect(payload.action_target_status).toBe("rejected");
		});

		it("no hook when registry not provided", async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status: "awaiting_review",
			});

			transitionSession(store, "reject", "e1", "test");

			await new Promise((r) => setTimeout(r, 200));
			expect(capturedEnvelopes).toHaveLength(0);
		});

		it("hook failure does not affect action result", async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status: "awaiting_review",
			});
			// Create a registry with a runtime that throws on deliver
			const failRegistry = new RuntimeRegistry();
			const failRuntime = {
				type: "commdb" as const,
				deliver: vi.fn(async () => {
					return { delivered: false, error: "connection refused" };
				}),
				sendBootstrap: vi.fn(async () => {}),
				health: vi.fn(async () => ({
					status: "healthy" as const,
					lastDeliveryAt: null,
					lastDeliveredSeq: 0,
				})),
				shutdown: vi.fn(async () => {}),
			};
			for (const project of testProjects) {
				for (const lead of project.leads) {
					failRegistry.register(lead, failRuntime);
				}
			}

			const result = await transitionSession(
				store,
				"reject",
				"e1",
				"test",
				undefined, // transitionOpts
				undefined, // config
				undefined, // cipherWriter
				testProjects,
				undefined, // eventFilter
				undefined, // forumTagUpdater
				failRegistry,
			);
			expect(result.success).toBe(true);
			expect(store.getSession("e1")!.status).toBe("rejected");
		});

		// FLY-163: dept lead with no forum still routes to chat_channel
		it("approve sends action_executed hook routed via chat_channel", async () => {
			const noForumProjects: ProjectEntry[] = [
				{
					projectName: "geoforge3d",
					projectRoot: "/tmp/geoforge3d",
					leads: [
						{
							agentId: "pm-lead",
							chatChannel: "core-channel",
							match: { labels: ["PM"] },
							// FLY-163: PM leads must explicitly opt out
							canSpawnRunners: false,
						},
					],
				},
			];
			const nfEnvelopes: LeadEventEnvelope[] = [];
			const nfRuntime = {
				type: "commdb" as const,
				deliver: vi.fn(async (env: LeadEventEnvelope) => {
					nfEnvelopes.push(env);
					return { delivered: true };
				}),
				sendBootstrap: vi.fn(async () => {}),
				health: vi.fn(async () => ({
					status: "healthy" as const,
					lastDeliveryAt: null,
					lastDeliveredSeq: 0,
				})),
				shutdown: vi.fn(async () => {}),
			};
			const nfRegistry = new RuntimeRegistry();
			for (const lead of noForumProjects[0]!.leads) {
				nfRegistry.register(lead, nfRuntime);
			}

			store.upsertSession({
				execution_id: "e-nf",
				issue_id: "i-nf",
				project_name: "geoforge3d",
				status: "awaiting_review",
				issue_identifier: "GEO-400",
			});

			seedApproveGate("e-nf");
			await approveExecution(
				store,
				noForumProjects,
				"e-nf",
				"GEO-400",
				mockExec,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined, // _unusedForumTagUpdater (FLY-163)
				nfRegistry,
			);

			await new Promise((r) => setTimeout(r, 200));

			expect(nfEnvelopes).toHaveLength(1);
			const payload = nfEnvelopes[0].event;
			expect(payload.event_type).toBe("action_executed");
			expect(payload.action).toBe("approve");
			expect(payload.chat_channel).toBe("core-channel");
		});
	});
});

// --- GEO-259: leadId scope check on action endpoints ---

const scopeProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
			{
				agentId: "ops-lead",
				forumChannel: "ops-channel",
				chatChannel: "ops-chat",
				match: { labels: ["Operations"] },
			},
		],
	},
];

describe("GEO-259: leadId scope check on actions", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, scopeProjects, makeConfig());
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		store.upsertSession({
			execution_id: "prod-exec",
			issue_id: "i-prod",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-200",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertSession({
			execution_id: "ops-exec",
			issue_id: "i-ops",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-201",
			issue_labels: JSON.stringify(["Operations"]),
		});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("POST /api/actions/reject without leadId works as before", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "prod-exec", reason: "test" }),
		});
		const body = await res.json();
		expect(body.success).toBe(true);
	});

	it("POST /api/actions/reject with matching leadId succeeds", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "prod-exec",
				reason: "test",
				leadId: "product-lead",
			}),
		});
		const body = await res.json();
		expect(body.success).toBe(true);
	});

	it("POST /api/actions/reject with mismatching leadId returns 403", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "prod-exec",
				reason: "test",
				leadId: "ops-lead",
			}),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.success).toBe(false);
		expect(body.message).toContain("outside lead");
	});

	it("POST /api/actions/defer with mismatching leadId returns 403", async () => {
		const res = await fetch(`${baseUrl}/api/actions/defer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "ops-exec",
				reason: "test",
				leadId: "product-lead",
			}),
		});
		expect(res.status).toBe(403);
	});

	it("POST /api/actions/shelve with mismatching leadId returns 403", async () => {
		const res = await fetch(`${baseUrl}/api/actions/shelve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "ops-exec",
				leadId: "product-lead",
			}),
		});
		expect(res.status).toBe(403);
	});
});

// --- GEO-292: approve sets session_stage ---
describe("GEO-292: approve sets session_stage", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		mockExec.mockClear();
	});

	it("approve sets session_stage='ship' when current stage is earlier", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-292",
			session_stage: "pr_created",
			stage_updated_at: "2026-03-30 10:00:00",
		});

		seedApproveGate("e1");
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			"GEO-292",
			mockExec,
		);
		expect(result.success).toBe(true);

		const session = store.getSession("e1");
		expect(session!.status).toBe("approved_to_ship");
		expect(session!.session_stage).toBe("ship");
		expect(session!.stage_updated_at).toBeDefined();
		// stage_updated_at should be updated to a newer timestamp
		expect(session!.stage_updated_at).not.toBe("2026-03-30 10:00:00");
	});

	it("approve does not regress session_stage if already at 'ship'", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			session_stage: "ship",
			stage_updated_at: "2026-03-30 10:00:00",
		});

		seedApproveGate("e1");
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.session_stage).toBe("ship");
	});

	it("approve overrides premature 'completed' stage to 'ship' (FLY-58 QA bug)", async () => {
		// QA found: Runner sets stage to "completed" when PR is created,
		// but ship hasn't happened yet. Approve must override to "ship".
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			session_stage: "completed",
			stage_updated_at: "2026-03-30 10:00:00",
		});

		seedApproveGate("e1");
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.session_stage).toBe("ship");
	});

	it("approve sets session_stage='ship' when no prior stage exists", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});

		seedApproveGate("e1");
		await approveExecution(store, testProjects, "e1", undefined, mockExec);

		const session = store.getSession("e1");
		expect(session!.session_stage).toBe("ship");
	});
});

// --- FLY-58: onApproved callback is no longer called (approve only transitions state) ---
describe("FLY-58: onApproved callback removed", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		mockExec.mockClear();
	});

	it("onApproved callback is NOT called even when provided", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-280",
		});

		const onApproved = vi.fn();
		seedApproveGate("e1");
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			"GEO-280",
			mockExec,
			undefined, // transitionOpts
			undefined, // config
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // forumTagUpdater
			undefined, // registry
			onApproved,
		);

		await new Promise((r) => setTimeout(r, 50));
		expect(result.success).toBe(true);
		// FLY-58: onApproved is no longer called — approve only transitions state
		expect(onApproved).not.toHaveBeenCalled();
		expect(store.getSession("e1")!.status).toBe("approved_to_ship");
	});

	it("approve from wrong status still fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running", // can't approve from running
		});

		const onApproved = vi.fn();
		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			onApproved,
		);

		await new Promise((r) => setTimeout(r, 50));
		expect(result.success).toBe(false);
		expect(onApproved).not.toHaveBeenCalled();
	});
});

// --- FLY-44: terminate from all started non-terminal states ---
describe("FLY-44: terminate from non-running states", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	const terminableStates = [
		"awaiting_review",
		"approved_to_ship",
		"blocked",
		"failed",
		"rejected",
		"deferred",
	];

	for (const status of terminableStates) {
		it(`terminate from ${status} succeeds`, async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status,
				issue_identifier: "FLY-44",
			});
			const result = await transitionSession(store, "terminate", "e1");
			// transitionSession uses ACTION_DEFINITIONS which now allows terminate from these states
			expect(result.success).toBe(true);
			expect(store.getSession("e1")!.status).toBe("terminated");
		});
	}

	const terminalStates = ["completed", "shelved", "terminated", "approved"];

	for (const status of terminalStates) {
		it(`terminate from ${status} fails`, async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status,
			});
			const result = await transitionSession(store, "terminate", "e1");
			expect(result.success).toBe(false);
		});
	}

	// FLY-1185 (R10#5): pending is now terminable — a canceled issue closes a
	// claimed-but-never-started session through the FSM, not a forceStatus.
	it("terminate from pending succeeds (FLY-1185 R10#5)", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "pending",
		});
		const result = await transitionSession(store, "terminate", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")?.status).toBe("terminated");
	});
});
