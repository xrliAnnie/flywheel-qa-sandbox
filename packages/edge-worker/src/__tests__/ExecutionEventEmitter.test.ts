import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintResult } from "../Blueprint.js";
import type { EventEnvelope } from "../ExecutionEventEmitter.js";
import { NoOpEventEmitter, TeamLeadClient } from "../ExecutionEventEmitter.js";

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
	return {
		executionId: "exec-1",
		issueId: "GEO-95",
		projectName: "geoforge3d",
		...overrides,
	};
}

describe("TeamLeadClient", () => {
	let server: http.Server;
	let port: number;
	let receivedBodies: unknown[];

	beforeEach(async () => {
		receivedBodies = [];
		server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
				res.writeHead(200);
				res.end("ok");
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = server.address();
		port = typeof addr === "object" && addr ? addr.port : 0;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	});

	it("emitStarted POSTs to /events", async () => {
		const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
		await client.emitStarted(makeEnvelope());
		await client.flush();

		expect(receivedBodies).toHaveLength(1);
		const body = receivedBodies[0] as Record<string, unknown>;
		expect(body.event_type).toBe("session_started");
		expect(body.execution_id).toBe("exec-1");
		expect(body.issue_id).toBe("GEO-95");
	});

	it("emitCompleted includes evidence in payload", async () => {
		const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
		const result: BlueprintResult = {
			success: true,
			evidence: {
				commitCount: 3,
				filesChangedCount: 5,
				commitMessages: ["feat: add thing"],
				changedFilePaths: ["src/foo.ts"],
				linesAdded: 100,
				linesRemoved: 10,
				diffSummary: "added thing",
				durationMs: 5000,
				partial: false,
				headSha: "abc123",
			},
			decision: {
				route: "needs_review",
				confidence: 0.8,
				reasoning: "ok",
				concerns: [],
				decisionSource: "haiku",
			},
		};

		await client.emitCompleted(makeEnvelope(), result, "summary text");
		await client.flush();

		expect(receivedBodies).toHaveLength(1);
		const body = receivedBodies[0] as Record<string, unknown>;
		expect(body.event_type).toBe("session_completed");
		const payload = body.payload as Record<string, unknown>;
		expect(payload.evidence).toBeDefined();
		expect(payload.decision).toBeDefined();
		expect(payload.summary).toBe("summary text");
	});

	it("emitFailed includes error + lastActivity", async () => {
		const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
		await client.emitFailed(
			makeEnvelope(),
			"git preflight failed",
			"2024-01-01T00:00:00Z",
		);
		await client.flush();

		expect(receivedBodies).toHaveLength(1);
		const body = receivedBodies[0] as Record<string, unknown>;
		expect(body.event_type).toBe("session_failed");
		const payload = body.payload as Record<string, unknown>;
		expect(payload.error).toBe("git preflight failed");
		expect(payload.lastActivity).toBe("2024-01-01T00:00:00Z");
	});

	it("silently catches HTTP errors", async () => {
		const client = new TeamLeadClient("http://127.0.0.1:1"); // invalid port
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await client.emitStarted(makeEnvelope());
		await client.flush();

		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("flush() drains pending requests", async () => {
		const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
		await client.emitStarted(makeEnvelope({ executionId: "e1" }));
		await client.emitStarted(makeEnvelope({ executionId: "e2" }));

		await client.flush();
		expect(receivedBodies).toHaveLength(2);

		// flush again is no-op
		await client.flush();
		expect(receivedBodies).toHaveLength(2);
	});
});

describe("NoOpEventEmitter", () => {
	it("methods are no-ops", async () => {
		const emitter = new NoOpEventEmitter();
		await emitter.emitStarted(makeEnvelope());
		await emitter.emitCompleted(makeEnvelope(), { success: true });
		await emitter.emitFailed(makeEnvelope(), "err");
		await emitter.flush();
	});
});
