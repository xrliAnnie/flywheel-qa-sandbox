import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { deriveRunnerStartKey } from "flywheel-comm/runner-start";
import { afterEach, expect, it } from "vitest";
import {
	verifyMigrationRunEvidence,
	verifyMigrationSource,
} from "./backend-migration-evidence.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fly2459-proof-"));
	dirs.push(dir);
	const path = join(dir, "state.db");
	const db = new Database(path);
	db.exec(`CREATE TABLE workflow_start_reservation(idempotency_key TEXT,run_id TEXT,node_id TEXT,attempt INTEGER,execution_id TEXT,created_at TEXT);
 CREATE TABLE workflow_run(run_id TEXT,issue_id TEXT,project_name TEXT,created_at TEXT);
 CREATE TABLE workflow_run_node(run_id TEXT,node_id TEXT,attempt INTEGER,execution_id TEXT,started_at TEXT);
 CREATE TABLE workflow_execution_binding(activation_id TEXT,execution_id TEXT,run_id TEXT,node_id TEXT,attempt INTEGER,bound_at TEXT);
 CREATE TABLE workflow_activation_turn(activation_id TEXT,issue_id TEXT,execution_id TEXT,granted_at TEXT);
 CREATE TABLE sessions(execution_id TEXT,issue_id TEXT,issue_identifier TEXT,project_name TEXT,issue_labels TEXT);
 CREATE TABLE workflow_run_event(event_uid TEXT,run_id TEXT,node_id TEXT,execution_id TEXT,kind TEXT,payload TEXT,at TEXT);`);
	const source = {
		channelId: "123456789012345678",
		messageId: "223456789012345678",
		at: "2026-09-11T01:00:00.000Z",
	};
	const evidence = {
		issueId: "FLY-2457",
		runId: "run",
		nodeId: "design",
		executionId: "exec",
		activationId: "activation",
		eventUid: "delivery",
	};
	const key = deriveRunnerStartKey({
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		issueId: evidence.issueId,
		idempotencyKey: `discord:${source.channelId}:${source.messageId}`,
	}).key;
	const at = "2026-09-11T01:00:01.000Z";
	db.prepare("INSERT INTO workflow_start_reservation VALUES(?,?,?,?,?,?)").run(
		key,
		"run",
		"design",
		1,
		"exec",
		at,
	);
	db.prepare("INSERT INTO workflow_run VALUES(?,?,?,?)").run(
		"run",
		"issue-uuid",
		"flywheel",
		at,
	);
	db.prepare("INSERT INTO workflow_run_node VALUES(?,?,?,?,?)").run(
		"run",
		"design",
		1,
		"exec",
		at,
	);
	db.prepare("INSERT INTO workflow_execution_binding VALUES(?,?,?,?,?,?)").run(
		"activation",
		"exec",
		"run",
		"design",
		1,
		at,
	);
	db.prepare("INSERT INTO workflow_activation_turn VALUES(?,?,?,?)").run(
		"activation",
		"issue-uuid",
		"exec",
		at,
	);
	db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
		"exec",
		"issue-uuid",
		"FLY-2457",
		"flywheel",
		'["Flywheel-Product"]',
	);
	const body = "real task";
	db.prepare("INSERT INTO workflow_run_event VALUES(?,?,?,?,?,?,?)").run(
		"delivery",
		"run",
		"design",
		"exec",
		"issue_delivery",
		JSON.stringify({
			body,
			bodyDigest: createHash("sha256").update(body).digest("hex"),
			sourceKind: "authoritative",
			activationId: "activation",
		}),
		at,
	);
	db.close();
	return { path, source, evidence };
}
it("reads the complete source-key/run/activation/delivery chain without writing", () => {
	const f = fixture();
	expect(
		verifyMigrationRunEvidence({ ...f, belongsToLead: () => true }),
	).toMatch(/^[a-f0-9]{64}$/);
});
it.each([
	"UPDATE workflow_start_reservation SET idempotency_key='unrelated'",
	"UPDATE workflow_start_reservation SET created_at='2026-09-10T01:00:00Z'",
	"UPDATE workflow_execution_binding SET attempt=2",
	"DELETE FROM workflow_activation_turn",
	"UPDATE workflow_run_event SET payload='{}'",
	"UPDATE sessions SET issue_identifier='FLY-999'",
])("rejects broken chain: %s", (sql) => {
	const f = fixture();
	const db = new Database(f.path);
	db.exec(sql);
	db.close();
	expect(() =>
		verifyMigrationRunEvidence({ ...f, belongsToLead: () => true }),
	).toThrow();
});
it("rejects department mismatch", () => {
	const f = fixture();
	expect(() =>
		verifyMigrationRunEvidence({ ...f, belongsToLead: () => false }),
	).toThrow("scope");
});

it("requires exact founder mention from bot REST and rejects forged/mismatched source", async () => {
	const input = {
		channelId: "123456789012345678",
		messageId: "223456789012345678",
		founderId: "323456789012345678",
		botUserId: "423456789012345678",
		botToken: "fixture",
	};
	const message = {
		id: input.messageId,
		channel_id: input.channelId,
		author: { id: input.founderId, bot: false },
		mentions: [{ id: input.botUserId }],
		timestamp: "2026-09-11T01:00:00.000Z",
	};
	const calls: string[] = [];
	const request: typeof fetch = async (url) => {
		calls.push(String(url));
		return new Response(JSON.stringify(message));
	};
	expect(await verifyMigrationSource({ ...input, request })).toEqual({
		channelId: input.channelId,
		messageId: input.messageId,
		at: message.timestamp,
	});
	expect(calls).toEqual([
		`https://discord.com/api/v10/channels/${input.channelId}/messages/${input.messageId}`,
	]);
	for (const patch of [
		{ id: "other" },
		{ author: { id: "other" } },
		{ mentions: [] },
		{ timestamp: "bad" },
		{ author: { id: input.founderId, bot: true } },
	]) {
		await expect(
			verifyMigrationSource({
				...input,
				request: async () =>
					new Response(JSON.stringify({ ...message, ...patch })),
			}),
		).rejects.toThrow();
	}
});
