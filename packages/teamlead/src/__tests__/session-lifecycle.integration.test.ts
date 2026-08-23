/**
 * FLY-96 Integration: Session lifecycle through Bridge.
 *
 * Tests the full session state machine: created → running → completed/failed,
 * including stage transitions, approval flow, and history queries.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { insertHistoricalAutoQaRecord } from "./helpers/historical-qa.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "test-proj",
		projectRoot: "/tmp/test-proj",
		projectRepo: "test/test-proj",
		leads: [
			{
				agentId: "test-lead",
				chatChannel: "test-chat",
				match: { labels: ["*"] },
			},
		],
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "test-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "test-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

describe("FLY-96 Integration: Session lifecycle", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer test-secret",
	};

	beforeEach(async () => {
		capturedEnvelopes = [];
		store = await StateStore.create(":memory:");

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

		const registry = new RuntimeRegistry();
		for (const project of testProjects) {
			for (const lead of project.leads) {
				registry.register(lead, mockRuntime);
			}
		}

		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			registry,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		if (commRoot) {
			rmSync(commRoot, { recursive: true, force: true });
			delete process.env.FLYWHEEL_COMM_ROOT;
		}
	});

	async function postEvent(event: Record<string, unknown>) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(event),
		});
	}

	// FLY-191 Phase 2 (Codex PR R1 HIGH-3): approve requires a writable CommDB
	// gate question — seed one in a sandbox comm root.
	let commRoot: string | undefined;
	function seedApproveGate(execId: string, project = "test-proj"): string {
		commRoot = mkdtempSync(join(tmpdir(), "fly191-lc-comm-"));
		process.env.FLYWHEEL_COMM_ROOT = commRoot;
		mkdirSync(join(commRoot, project), { recursive: true });
		const db = new CommDB(join(commRoot, project, "comm.db"), true);
		db.registerSession(execId, "sess:win", project, undefined, "test-lead");
		const qid = db.insertQuestion(execId, "test-lead", "PR ready", {
			checkpoint: "approve_to_ship",
		});
		db.close();
		return qid;
	}

	it("session_started → running → session_completed → awaiting_review → approve → approved_to_ship", async () => {
		const gateQid = seedApproveGate("exec-lc");
		// 1. Start session
		const startRes = await postEvent({
			event_id: "evt-lc-1",
			execution_id: "exec-lc",
			issue_id: "issue-lc",
			project_name: "test-proj",
			event_type: "session_started",
			payload: {
				issueIdentifier: "TEST-LC-1",
				issueTitle: "Lifecycle test",
			},
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession("exec-lc")!.status).toBe("running");

		// 2. Complete session
		const completeRes = await postEvent({
			event_id: "evt-lc-2",
			execution_id: "exec-lc",
			issue_id: "issue-lc",
			project_name: "test-proj",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review", reasoning: "has changes" },
				evidence: {
					commitCount: 2,
					filesChangedCount: 4,
					linesAdded: 80,
					linesRemoved: 20,
				},
				summary: "Lifecycle test completed",
				// FLY-191 R2 HIGH-1: a Phase-2 needs_review without the binding
				// gets the UNBOUND sentinel and approve refuses.
				reviewQuestionId: gateQid,
			},
		});
		expect(completeRes.status).toBe(200);
		expect(store.getSession("exec-lc")!.status).toBe("awaiting_review");
		// FLY-1251: approval is legal only after exact PR evidence establishes a
		// docs-only exemption or passing QA. This code-bearing lifecycle uses QA.
		const head = "a".repeat(40);
		store.patchSessionMetadata("exec-lc", {
			pr_head_sha: head,
			pr_number: 1,
			codex_skip: 1,
		});
		insertHistoricalAutoQaRecord(store, {
			parentExecutionId: "exec-lc",
			targetPrHeadSha: head,
			issueId: "issue-lc",
			projectName: "test-proj",
			status: "passed",
			verdictEventId: "qa-pass-lifecycle",
		});

		// 3. Approve
		const approveRes = await fetch(`${baseUrl}/api/actions/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "exec-lc",
				identifier: "TEST-LC-1",
			}),
		});
		expect(approveRes.status).toBe(200);
		const approveBody = await approveRes.json();
		expect(approveBody.success).toBe(true);
		expect(store.getSession("exec-lc")!.status).toBe("approved_to_ship");
	});

	it("session_failed records error status", async () => {
		await postEvent({
			event_id: "evt-fail-1",
			execution_id: "exec-fail",
			issue_id: "issue-fail",
			project_name: "test-proj",
			event_type: "session_started",
			payload: { issueIdentifier: "TEST-FAIL-1" },
		});
		expect(store.getSession("exec-fail")!.status).toBe("running");

		await postEvent({
			event_id: "evt-fail-2",
			execution_id: "exec-fail",
			issue_id: "issue-fail",
			project_name: "test-proj",
			event_type: "session_failed",
			payload: { error: "Build failed with exit code 1" },
		});
		const session = store.getSession("exec-fail");
		expect(session!.status).toBe("failed");
		expect(session!.last_error).toBe("Build failed with exit code 1");
	});

	it("stage_changed updates session stage", async () => {
		await postEvent({
			event_id: "evt-stage-1",
			execution_id: "exec-stage",
			issue_id: "issue-stage",
			project_name: "test-proj",
			event_type: "session_started",
			payload: { issueIdentifier: "TEST-STAGE-1" },
		});

		await postEvent({
			event_id: "evt-stage-2",
			execution_id: "exec-stage",
			issue_id: "issue-stage",
			project_name: "test-proj",
			event_type: "stage_changed",
			payload: { stage: "implement" },
		});

		const session = store.getSession("exec-stage");
		expect(session).toBeDefined();
		expect(session!.session_stage).toBe("implement");
	});

	it("multiple executions for same issue appear in history", async () => {
		// First execution — fails
		await postEvent({
			event_id: "evt-hist-1",
			execution_id: "exec-hist-1",
			issue_id: "issue-hist",
			project_name: "test-proj",
			event_type: "session_started",
			payload: { issueIdentifier: "TEST-HIST-1" },
		});
		await postEvent({
			event_id: "evt-hist-2",
			execution_id: "exec-hist-1",
			issue_id: "issue-hist",
			project_name: "test-proj",
			event_type: "session_failed",
			payload: { error: "first attempt" },
		});

		// Second execution — running
		await postEvent({
			event_id: "evt-hist-3",
			execution_id: "exec-hist-2",
			issue_id: "issue-hist",
			project_name: "test-proj",
			event_type: "session_started",
			payload: { issueIdentifier: "TEST-HIST-1" },
		});

		const res = await fetch(`${baseUrl}/api/sessions/TEST-HIST-1/history`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.count).toBe(2);
		expect(body.history[0].execution_id).toBe("exec-hist-1"); // oldest first (ASC)
	});

	it("notifications are delivered for each state transition", async () => {
		const head = "a".repeat(40);
		await postEvent({
			event_id: "evt-notify-1",
			execution_id: "exec-notify",
			issue_id: "issue-notify",
			project_name: "test-proj",
			event_type: "session_started",
			payload: {
				issueIdentifier: "TEST-NOTIFY-1",
				issueTitle: "Notification test",
			},
		});
		store.patchSessionMetadata("exec-notify", {
			pr_head_sha: head,
			pr_number: 42,
			codex_skip: 1,
		});
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-notify",
			pr_head_sha: head,
			repo: "test/test-proj",
			pr_number: 42,
			base_ref: "main",
			base_oid: "b".repeat(40),
			classifier_version: 1,
			ship_relevant: 0,
			file_count: 1,
			sample_paths: ["engineering/doc/TEST-NOTIFY-1/plan.md"],
		});

		await new Promise((r) => setTimeout(r, 200));
		const startEnvelopes = capturedEnvelopes.filter(
			(e) => e.event.event_type === "session_started",
		);
		expect(startEnvelopes.length).toBeGreaterThanOrEqual(1);

		await postEvent({
			event_id: "evt-notify-2",
			execution_id: "exec-notify",
			issue_id: "issue-notify",
			project_name: "test-proj",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review", reasoning: "done" },
				evidence: {
					commitCount: 1,
					filesChangedCount: 1,
					linesAdded: 10,
					linesRemoved: 0,
					headSha: head,
					landingStatus: { status: "open", prNumber: 42 },
				},
				summary: "Done",
			},
		});

		await new Promise((r) => setTimeout(r, 200));
		const completeEnvelopes = capturedEnvelopes.filter(
			(e) => e.event.event_type === "session_completed",
		);
		expect(completeEnvelopes.length).toBeGreaterThanOrEqual(1);
	});
});
