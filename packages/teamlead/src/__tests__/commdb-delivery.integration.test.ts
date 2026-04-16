/**
 * FLY-96 Integration: CommDB delivery pipeline.
 *
 * Tests CommDBLeadRuntime with a real CommDB (temp SQLite file), verifying
 * that events delivered through the runtime are actually persisted and
 * readable from the database. No mocks on the CommDB layer.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import type { HookPayload } from "../bridge/hook-payload.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";

function makeEnvelope(
	overrides: Partial<HookPayload> = {},
	seq = 1,
	leadId = "test-lead",
): LeadEventEnvelope {
	return {
		seq,
		event: {
			event_type: "session_started",
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "TEST-1",
			issue_title: "Test issue",
			status: "running",
			...overrides,
		} as HookPayload,
		sessionKey: "test:TEST-1",
		leadId,
		timestamp: new Date().toISOString(),
	};
}

describe("FLY-96 Integration: CommDB delivery", () => {
	let testDir: string;
	let dbPath: string;
	let runtime: CommDBLeadRuntime;

	beforeEach(() => {
		testDir = join(tmpdir(), `flywheel-commdb-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		dbPath = join(testDir, "comm.db");
		runtime = new CommDBLeadRuntime(dbPath, "test-lead");
	});

	afterEach(async () => {
		await runtime.shutdown();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("delivers event and persists instruction in CommDB", async () => {
		const envelope = makeEnvelope();
		const result = await runtime.deliver(envelope);

		expect(result.delivered).toBe(true);

		// Read back from a fresh CommDB connection
		const reader = new CommDB(dbPath, false);
		const pending = reader.getUnreadInstructions("test-lead");
		expect(pending.length).toBe(1);
		expect(pending[0].content).toContain("[Event #1] session_started");
		expect(pending[0].content).toContain("TEST-1");
		reader.close();
	});

	it("delivers multiple events with incrementing sequence", async () => {
		await runtime.deliver(makeEnvelope({ issue_identifier: "TEST-A" }, 1));
		await runtime.deliver(
			makeEnvelope(
				{
					event_type: "session_completed",
					issue_identifier: "TEST-A",
					status: "awaiting_review",
				},
				2,
			),
		);

		const reader = new CommDB(dbPath, false);
		const pending = reader.getUnreadInstructions("test-lead");
		expect(pending.length).toBe(2);
		expect(pending[0].content).toContain("[Event #1]");
		expect(pending[1].content).toContain("[Event #2]");
		reader.close();
	});

	it("sendBootstrap writes bootstrap instruction", async () => {
		await runtime.sendBootstrap({
			leadId: "test-lead",
			activeSessions: [
				{
					executionId: "exec-1",
					issueId: "issue-1",
					issueIdentifier: "TEST-1",
					issueTitle: "Active task",
					status: "running",
				},
			],
			pendingDecisions: [],
			recentFailures: [],
			recentEvents: [],
		});

		const reader = new CommDB(dbPath, false);
		const pending = reader.getUnreadInstructions("test-lead");
		expect(pending.length).toBe(1);
		expect(pending[0].content).toContain("Bootstrap");
		expect(pending[0].content).toContain("TEST-1");
		reader.close();
	});

	it("health reports degraded before first delivery, healthy after", async () => {
		const before = await runtime.health();
		expect(before.status).toBe("degraded");
		expect(before.lastDeliveredSeq).toBe(0);

		await runtime.deliver(makeEnvelope({}, 5));

		const after = await runtime.health();
		expect(after.status).toBe("healthy");
		expect(after.lastDeliveredSeq).toBe(5);
		expect(after.lastDeliveryAt).toBeTruthy();
	});

	it("gate_question format includes question ID and CommDB path", async () => {
		const envelope = makeEnvelope(
			{
				event_type: "gate_question",
				issue_identifier: "TEST-GATE",
				summary: "Should I proceed with the migration?",
				checkpoint: "pre-deploy",
				question_id: "q-123",
				comm_db_path: "/tmp/test/comm.db",
			} as unknown as Partial<HookPayload>,
			3,
		);
		await runtime.deliver(envelope);

		const reader = new CommDB(dbPath, false);
		const pending = reader.getUnreadInstructions("test-lead");
		expect(pending.length).toBe(1);
		expect(pending[0].content).toContain("gate_question");
		expect(pending[0].content).toContain("PRE-DEPLOY");
		expect(pending[0].content).toContain("q-123");
		reader.close();
	});
});
