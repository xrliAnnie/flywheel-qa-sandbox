import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createBridgeApp } from "../plugin.js";
import type { BridgeConfig } from "../types.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

it("authenticates a Claude turn-start and imports only its native usage source", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2789-scorecard-route-"));
	roots.push(root);
	const sourceDir = join(root, "projects", "fixture");
	mkdirSync(sourceDir, { recursive: true });
	const sessionId = "11111111-1111-4111-8111-111111111111";
	const sourcePath = join(sourceDir, `${sessionId}.jsonl`);
	writeFileSync(
		sourcePath,
		`${[
			JSON.stringify({
				type: "user",
				uuid: "turn-1",
				timestamp: "2026-09-23T04:00:00.000Z",
				message: { content: "not persisted" },
			}),
			JSON.stringify({
				type: "assistant",
				requestId: "request-1",
				timestamp: "2026-09-23T04:00:01.000Z",
				message: {
					model: "claude-opus-5",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_read_input_tokens: 3,
						cache_creation_input_tokens: 2,
					},
				},
			}),
		].join("\n")}\n`,
	);
	vi.stubEnv("CLAUDE_CONFIG_DIR", root);
	const store = await StateStore.create(":memory:");
	const db = rawDb(store);
	db.prepare(
		"INSERT INTO workflow_run(run_id, issue_id, project_name, status) VALUES ('run-1','FLY-2789','flywheel','active')",
	).run();
	db.prepare(
		"INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id) VALUES ('run-1','implement',1,'running','exec-1')",
	).run();
	db.prepare(
		"INSERT INTO workflow_actor(execution_id,project_name,issue_id,role,created_at) VALUES ('exec-1','flywheel','FLY-2789','implement','2026-09-23T04:00:00.000Z')",
	).run();
	db.prepare(
		`INSERT INTO workflow_execution_binding
		 (activation_id,execution_id,run_id,node_id,attempt,mode,bound_at)
		 VALUES ('activation-1','exec-1','run-1','implement',1,'spawn','2026-09-23T04:00:00.000Z')`,
	).run();
	expect(
		store.workflowScorecard.recordActivationSafely({
			activationId: "activation-1",
			executionId: "exec-1",
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			axis: "implement",
			assignmentState: "unassigned",
			admittedAt: "2026-09-23T04:00:00.000Z",
		}),
	).toEqual({ ok: true });
	const app = createBridgeApp(store, [], {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "fixture",
		defaultLeadAgentId: "lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		ingestToken: "ingest-secret",
	} as BridgeConfig);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow/usage-source`;
	const body = JSON.stringify({
		event: "turn-start",
		execution_id: "exec-1",
		activation_id: "activation-1",
		session_id: sessionId,
		transcript_path: sourcePath,
	});
	try {
		expect(
			(
				await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				})
			).status,
		).toBe(401);
		const mismatched = await fetch(url, {
			method: "POST",
			headers: {
				authorization: "Bearer ingest-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				...JSON.parse(body),
				session_id: "22222222-2222-4222-8222-222222222222",
			}),
		});
		expect(mismatched.status).toBe(409);
		expect(await mismatched.json()).toMatchObject({
			ok: false,
			reason: "claude_session_identity_mismatch",
		});
		const response = await fetch(url, {
			method: "POST",
			headers: {
				authorization: "Bearer ingest-secret",
				"content-type": "application/json",
			},
			body,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			imported: 1,
			coverage: "open",
		});
		expect(store.workflowScorecard.listUsageForRun("run-1")).toMatchObject([
			{
				native_session_id: sessionId,
				provider_request_id: "request-1",
				observed_model_id: "claude-opus-5",
				normalized_delta: 20,
			},
		]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
	}
});
