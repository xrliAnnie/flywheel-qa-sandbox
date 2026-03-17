import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import initSqlJs from "sql.js";
import { StateStore } from "../StateStore.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { CipherWriter } from "flywheel-edge-worker";
import type http from "node:http";

const testProjects: ProjectEntry[] = [
	{ projectName: "geoforge3d", projectRoot: "/tmp/geoforge3d", projectRepo: "xrliAnnie/GeoForge3D" },
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

/** Read cipher.db directly to verify data written by CipherWriter */
async function queryCipherDb(dbPath: string, sql: string): Promise<unknown[][]> {
	if (!existsSync(dbPath)) return [];
	const SQL = await initSqlJs();
	const buf = readFileSync(dbPath);
	const db = new SQL.Database(buf);
	try {
		const result = db.exec(sql);
		return result.length > 0 ? result[0]!.values : [];
	} finally {
		db.close();
	}
}

/**
 * End-to-end test for CIPHER integration through the Bridge HTTP layer.
 * Exercises: event ingestion → saveSnapshot → action → recordOutcome → cipher-principle API
 */
describe("CIPHER Bridge E2E", () => {
	let store: StateStore;
	let cipherWriter: CipherWriter;
	let server: http.Server;
	let baseUrl: string;
	let tmpDir: string;
	let cipherDbPath: string;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "cipher-bridge-e2e-"));
		cipherDbPath = join(tmpDir, "cipher.db");
		cipherWriter = await CipherWriter.create(cipherDbPath);
		store = await StateStore.create(":memory:");

		const app = createBridgeApp(store, testProjects, makeConfig(), undefined, undefined, undefined, cipherWriter);
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
		cipherWriter.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Helper: send session_started event */
	async function startSession(executionId: string, issueId: string, identifier: string) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: `evt-start-${executionId}`,
				execution_id: executionId,
				issue_id: issueId,
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: identifier, issueTitle: `Test ${identifier}` },
			}),
		});
	}

	/** Helper: send session_completed with CIPHER-required fields */
	async function completeSessionWithCipherFields(
		executionId: string, issueId: string, identifier: string,
		labels: string[] = ["bug"],
	) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: `evt-complete-${executionId}`,
				execution_id: executionId,
				issue_id: issueId,
				project_name: "geoforge3d",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review", reasoning: "has changes", confidence: 0.85, decisionSource: "haiku_triage" },
					evidence: {
						commitCount: 3, filesChangedCount: 4,
						linesAdded: 120, linesRemoved: 45,
						diffSummary: "Fixed auth module",
						commitMessages: ["fix: auth bug", "test: add tests", "refactor: cleanup"],
						changedFilePaths: ["src/auth.ts", "src/auth.test.ts", "src/middleware.ts", "package.json"],
					},
					issueIdentifier: identifier,
					issueTitle: `Test ${identifier}`,
					labels,
					projectId: "proj-geoforge",
					exitReason: "completed",
					consecutiveFailures: 0,
				},
			}),
		});
	}

	it("session_completed with CIPHER fields → saveSnapshot creates decision_snapshots row", async () => {
		await startSession("exec-c1", "issue-c1", "GEO-300");
		const res = await completeSessionWithCipherFields("exec-c1", "issue-c1", "GEO-300");
		expect(res.status).toBe(200);
		expect(store.getSession("exec-c1")!.status).toBe("awaiting_review");

		// Verify snapshot in cipher.db
		const snapshots = await queryCipherDb(cipherDbPath,
			"SELECT execution_id, issue_id FROM decision_snapshots WHERE execution_id = 'exec-c1'");
		expect(snapshots.length).toBe(1);
		expect(snapshots[0]![0]).toBe("exec-c1");
		expect(snapshots[0]![1]).toBe("issue-c1");
	});

	it("session_completed without CIPHER fields → no snapshot (graceful skip)", async () => {
		await startSession("exec-no-cipher", "issue-no-cipher", "GEO-301");

		// Complete WITHOUT labels/changedFilePaths/projectId
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-complete-no-cipher",
				execution_id: "exec-no-cipher",
				issue_id: "issue-no-cipher",
				project_name: "geoforge3d",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review", reasoning: "test" },
					evidence: { commitCount: 1, filesChangedCount: 1, linesAdded: 10, linesRemoved: 5 },
					summary: "Small fix",
				},
			}),
		});
		expect(res.status).toBe(200);

		// No snapshot
		const snapshots = await queryCipherDb(cipherDbPath,
			"SELECT COUNT(*) FROM decision_snapshots WHERE execution_id = 'exec-no-cipher'");
		expect(snapshots[0]![0]).toBe(0);
	});

	it("reject action → recordOutcome creates decision_reviews row", async () => {
		await startSession("exec-rej", "issue-rej", "GEO-310");
		await completeSessionWithCipherFields("exec-rej", "issue-rej", "GEO-310", ["feature"]);
		expect(store.getSession("exec-rej")!.status).toBe("awaiting_review");

		// Reject via actions endpoint
		const rejectRes = await fetch(`${baseUrl}/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-rej", reason: "Code quality issues" }),
		});
		expect(rejectRes.status).toBe(200);
		expect((await rejectRes.json()).success).toBe(true);
		expect(store.getSession("exec-rej")!.status).toBe("rejected");

		// Verify review in cipher.db
		const reviews = await queryCipherDb(cipherDbPath,
			"SELECT execution_id, ceo_action, ceo_outcome FROM decision_reviews WHERE execution_id = 'exec-rej'");
		expect(reviews.length).toBe(1);
		expect(reviews[0]![0]).toBe("exec-rej");
		expect(reviews[0]![1]).toBe("reject");
	});

	it("defer action → recordOutcome creates review with defer action", async () => {
		await startSession("exec-def", "issue-def", "GEO-311");
		await completeSessionWithCipherFields("exec-def", "issue-def", "GEO-311");

		const deferRes = await fetch(`${baseUrl}/actions/defer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-def", reason: "Not ready yet" }),
		});
		expect(deferRes.status).toBe(200);
		expect((await deferRes.json()).success).toBe(true);

		const reviews = await queryCipherDb(cipherDbPath,
			"SELECT ceo_action FROM decision_reviews WHERE execution_id = 'exec-def'");
		expect(reviews.length).toBe(1);
		expect(reviews[0]![0]).toBe("defer");
	});

	it("shelve does NOT create cipher review (not a decision action)", async () => {
		await startSession("exec-shelve", "issue-shelve", "GEO-312");
		await completeSessionWithCipherFields("exec-shelve", "issue-shelve", "GEO-312");

		await fetch(`${baseUrl}/actions/shelve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-shelve" }),
		});

		const reviews = await queryCipherDb(cipherDbPath,
			"SELECT COUNT(*) FROM decision_reviews WHERE execution_id = 'exec-shelve'");
		expect(reviews[0]![0]).toBe(0);
	});

	it("cipher-principle API validates input and routes activate/retire", async () => {
		// Seed 55 snapshots + approve outcomes to trigger skill → principle graduation
		for (let i = 0; i < 55; i++) {
			const execId = `exec-p-${i}`;
			await startSession(execId, `issue-p-${i}`, `GEO-P${i}`);
			await completeSessionWithCipherFields(execId, `issue-p-${i}`, `GEO-P${i}`, ["bug"]);
		}

		// Record approve outcomes directly (approve action requires gh CLI which isn't available in tests)
		for (let i = 0; i < 55; i++) {
			await cipherWriter.recordOutcome({
				executionId: `exec-p-${i}`,
				ceoAction: "approve",
				ceoActionTimestamp: new Date().toISOString(),
				sourceStatus: "awaiting_review",
			});
		}

		// Run dreaming to generate skills → principles
		await cipherWriter.runDreaming();

		const principles = cipherWriter.getProposedPrinciples();
		expect(principles.length).toBeGreaterThanOrEqual(1);
		const principleId = principles[0]!.id;

		// Activate via API
		const activateRes = await fetch(`${baseUrl}/api/cipher-principle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ principleId, action: "activate" }),
		});
		expect(activateRes.status).toBe(200);
		expect((await activateRes.json()).ok).toBe(true);

		// Verify activated via db
		const active = await queryCipherDb(cipherDbPath,
			`SELECT status FROM cipher_principles WHERE id = '${principleId}'`);
		expect(active[0]![0]).toBe("active");

		// Retire via API
		const retireRes = await fetch(`${baseUrl}/api/cipher-principle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ principleId, action: "retire" }),
		});
		expect(retireRes.status).toBe(200);

		const retired = await queryCipherDb(cipherDbPath,
			`SELECT status FROM cipher_principles WHERE id = '${principleId}'`);
		expect(retired[0]![0]).toBe("retired");
	});

	it("cipher-principle API rejects invalid input", async () => {
		// Missing principleId
		const res1 = await fetch(`${baseUrl}/api/cipher-principle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "activate" }),
		});
		expect(res1.status).toBe(400);

		// Invalid UUID format
		const res2 = await fetch(`${baseUrl}/api/cipher-principle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ principleId: "not-a-uuid", action: "activate" }),
		});
		expect(res2.status).toBe(400);

		// Invalid action
		const res3 = await fetch(`${baseUrl}/api/cipher-principle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				principleId: "00000000-0000-0000-0000-000000000000",
				action: "delete",
			}),
		});
		expect(res3.status).toBe(400);

		// Nonexistent principle → 404
		const res4 = await fetch(`${baseUrl}/api/cipher-principle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				principleId: "00000000-0000-0000-0000-000000000000",
				action: "activate",
			}),
		});
		expect(res4.status).toBe(404);
	});
});
