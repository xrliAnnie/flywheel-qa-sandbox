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

function makeResult(overrides: Partial<BlueprintResult> = {}): BlueprintResult {
	return {
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
		const result = makeResult();

		await client.emitCompleted(makeEnvelope(), result, "summary text");

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

		expect(receivedBodies).toHaveLength(1);
		const body = receivedBodies[0] as Record<string, unknown>;
		expect(body.event_type).toBe("session_failed");
		const payload = body.payload as Record<string, unknown>;
		expect(payload.error).toBe("git preflight failed");
		expect(payload.lastActivity).toBe("2024-01-01T00:00:00Z");
	});

	it("emitStarted silently catches HTTP errors (fire-and-forget)", async () => {
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

	// ─── GEO-261: Terminal event retry tests ─────────

	describe("terminal event retry (GEO-261)", () => {
		it("emitCompleted retries on 500 then succeeds", async () => {
			let requestCount = 0;
			// Close default server and create a failing-then-succeeding one
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});

			server = http.createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", () => {
					requestCount++;
					if (requestCount === 1) {
						res.writeHead(500);
						res.end("Internal Server Error");
					} else {
						receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
						res.writeHead(200);
						res.end("ok");
					}
				});
			});
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", () => resolve());
			});
			const addr = server.address();
			port = typeof addr === "object" && addr ? addr.port : 0;

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
			await client.emitCompleted(makeEnvelope(), makeResult(), "summary");

			expect(requestCount).toBe(2);
			expect(receivedBodies).toHaveLength(1);
			const body = receivedBodies[0] as Record<string, unknown>;
			expect(body.event_type).toBe("session_completed");
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("retrying"));
			warnSpy.mockRestore();
		});

		it("emitFailed retries on network error then succeeds", async () => {
			// Use a custom server that rejects first request then accepts second
			let requestCount = 0;
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});

			// Start a server that tracks requests
			server = http.createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", () => {
					requestCount++;
					receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
					res.writeHead(200);
					res.end("ok");
				});
			});
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", () => resolve());
			});
			const addr = server.address();
			const goodPort = typeof addr === "object" && addr ? addr.port : 0;

			// Mock fetch to fail on first call, then use real fetch
			const originalFetch = globalThis.fetch;
			let fetchCallCount = 0;
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation((...args) => {
					fetchCallCount++;
					if (fetchCallCount === 1) {
						return Promise.reject(new Error("connect ECONNREFUSED"));
					}
					fetchSpy.mockRestore();
					// Rewrite URL to use good port for retry
					const url = `http://127.0.0.1:${goodPort}/events`;
					return originalFetch(url, args[1]);
				});

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const client = new TeamLeadClient(`http://127.0.0.1:${goodPort}`);
			await client.emitFailed(makeEnvelope(), "test error");

			// First call failed, second succeeded
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("retrying"));
			expect(requestCount).toBe(1); // Only the retry hit the server
			expect(receivedBodies).toHaveLength(1);
			const body = receivedBodies[0] as Record<string, unknown>;
			expect(body.event_type).toBe("session_failed");

			warnSpy.mockRestore();
			fetchSpy.mockRestore();
		});

		it("emitCompleted does NOT retry on 400 (permanent failure)", async () => {
			let requestCount = 0;
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});

			server = http.createServer((_req, res) => {
				requestCount++;
				res.writeHead(400);
				res.end("Bad Request");
			});
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", () => resolve());
			});
			const addr = server.address();
			port = typeof addr === "object" && addr ? addr.port : 0;

			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
			await client.emitCompleted(makeEnvelope(), makeResult(), "summary");

			// Only 1 request — no retry on 4xx
			expect(requestCount).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("permanently rejected"),
			);
			// No retry warning
			expect(warnSpy).not.toHaveBeenCalledWith(
				expect.stringContaining("retrying"),
			);

			errorSpy.mockRestore();
			warnSpy.mockRestore();
		});

		it("emitCompleted logs error after max retries exhausted", async () => {
			let requestCount = 0;
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});

			server = http.createServer((_req, res) => {
				requestCount++;
				res.writeHead(503);
				res.end("Service Unavailable");
			});
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", () => resolve());
			});
			const addr = server.address();
			port = typeof addr === "object" && addr ? addr.port : 0;

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
			// Should not throw
			await client.emitCompleted(makeEnvelope(), makeResult(), "summary");

			expect(requestCount).toBe(2); // initial + 1 retry
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("retrying"));
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("no retries left"),
			);

			warnSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("emitCompleted succeeds on first try without retry", async () => {
			let requestCount = 0;
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});

			server = http.createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", () => {
					requestCount++;
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

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
			await client.emitCompleted(makeEnvelope(), makeResult(), "summary");

			expect(requestCount).toBe(1);
			expect(receivedBodies).toHaveLength(1);
			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
		});

		it("emitStarted still uses fire-and-forget (not retry)", async () => {
			let requestCount = 0;
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});

			server = http.createServer((_req, res) => {
				requestCount++;
				res.writeHead(500);
				res.end("Internal Server Error");
			});
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", () => resolve());
			});
			const addr = server.address();
			port = typeof addr === "object" && addr ? addr.port : 0;

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const client = new TeamLeadClient(`http://127.0.0.1:${port}`);
			await client.emitStarted(makeEnvelope());
			await client.flush();

			// Only 1 request — no retry for non-terminal events
			expect(requestCount).toBe(1);

			warnSpy.mockRestore();
		});
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
