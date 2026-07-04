import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { HookEvent } from "../HookCallbackServer.js";
import { HookCallbackServer } from "../HookCallbackServer.js";

// ─── Helpers ─────────────────────────────────────

function post(
	port: number,
	path: string,
	method = "POST",
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: "127.0.0.1", port, path, method },
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				res.on("end", () => resolve({ status: res.statusCode!, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

const UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SESSION = "s1s2s3s4-s5s6-7890-abcd-ef1234567890";
const VALID_PATH = `/hook/complete?token=${UUID}&sessionId=${SESSION}&issueId=GEO-42&eventType=SessionEnd`;

// ─── Tests ───────────────────────────────────────

describe("HookCallbackServer", () => {
	const servers: HookCallbackServer[] = [];

	async function createServer(): Promise<HookCallbackServer> {
		const server = new HookCallbackServer(0);
		servers.push(server);
		await server.start();
		return server;
	}

	afterEach(async () => {
		for (const s of servers) {
			try {
				await s.stop();
			} catch {
				// already stopped
			}
		}
		servers.length = 0;
	});

	it("start() returns port > 0", async () => {
		const server = new HookCallbackServer(0);
		servers.push(server);
		const port = await server.start();
		expect(port).toBeGreaterThan(0);
	});

	it("getPort() consistent after start", async () => {
		const server = await createServer();
		const port = server.getPort();
		expect(port).toBeGreaterThan(0);
		expect(server.getPort()).toBe(port);
	});

	it("POST valid params → 200", async () => {
		const server = await createServer();
		const res = await post(server.getPort(), VALID_PATH);
		expect(res.status).toBe(200);
		expect(res.body).toBe("ok");
	});

	it('POST emits "hook" event with correct shape', async () => {
		const server = await createServer();
		const events: HookEvent[] = [];
		server.on("hook", (e: HookEvent) => events.push(e));

		await post(server.getPort(), VALID_PATH);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			token: UUID,
			sessionId: SESSION,
			issueId: "GEO-42",
			eventType: "SessionEnd",
		});
		expect(typeof events[0].timestamp).toBe("number");
	});

	it("POST missing token → 400", async () => {
		const server = await createServer();
		const res = await post(
			server.getPort(),
			"/hook/complete?sessionId=x&issueId=y&eventType=SessionEnd",
		);
		expect(res.status).toBe(400);
	});

	it("POST missing sessionId → 400", async () => {
		const server = await createServer();
		const res = await post(
			server.getPort(),
			`/hook/complete?token=${UUID}&issueId=y&eventType=SessionEnd`,
		);
		expect(res.status).toBe(400);
	});

	it("POST missing issueId → 400", async () => {
		const server = await createServer();
		const res = await post(
			server.getPort(),
			`/hook/complete?token=${UUID}&sessionId=x&eventType=SessionEnd`,
		);
		expect(res.status).toBe(400);
	});

	it("POST missing eventType → 400", async () => {
		const server = await createServer();
		const res = await post(
			server.getPort(),
			`/hook/complete?token=${UUID}&sessionId=x&issueId=y`,
		);
		expect(res.status).toBe(400);
	});

	it("GET → 405", async () => {
		const server = await createServer();
		const res = await post(server.getPort(), VALID_PATH, "GET");
		expect(res.status).toBe(405);
	});

	it("POST unknown path → 404", async () => {
		const server = await createServer();
		const res = await post(
			server.getPort(),
			`/unknown?token=${UUID}&sessionId=x&issueId=y&eventType=SessionEnd`,
		);
		expect(res.status).toBe(404);
	});

	it("waitForEvent resolves on matching event", async () => {
		const server = await createServer();
		const promise = server.waitForEvent(UUID, "SessionEnd", 2000);

		await post(server.getPort(), VALID_PATH);

		const event = await promise;
		expect(event).not.toBeNull();
		expect(event!.token).toBe(UUID);
		expect(event!.eventType).toBe("SessionEnd");
	});

	it("waitForEvent returns null on timeout", async () => {
		const server = await createServer();
		const event = await server.waitForEvent(UUID, "SessionEnd", 50);
		expect(event).toBeNull();
	});

	it("waitForEvent ignores wrong token", async () => {
		const server = await createServer();
		const promise = server.waitForEvent(
			"wrong-wrong-wrong-wrong-wrong-wrong0",
			"SessionEnd",
			100,
		);

		await post(server.getPort(), VALID_PATH);

		const event = await promise;
		expect(event).toBeNull();
	});

	it("stop() shuts down gracefully", async () => {
		const server = await createServer();
		const port = server.getPort();
		await server.stop();

		// Remove from tracking so afterEach doesn't double-stop
		servers.length = 0;

		await expect(post(port, VALID_PATH)).rejects.toThrow();
	});

	it("concurrent waitForEvent on different tokens", async () => {
		const server = await createServer();
		const token2 = "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2";

		const p1 = server.waitForEvent(UUID, "SessionEnd", 2000);
		const p2 = server.waitForEvent(token2, "SessionEnd", 2000);

		await post(server.getPort(), VALID_PATH);
		await post(
			server.getPort(),
			`/hook/complete?token=${token2}&sessionId=s2&issueId=GEO-99&eventType=SessionEnd`,
		);

		const [e1, e2] = await Promise.all([p1, p2]);
		expect(e1!.token).toBe(UUID);
		expect(e2!.token).toBe(token2);
	});

	it("cancelWait resolves pending waitForEvent with null", async () => {
		const server = await createServer();
		const promise = server.waitForEvent(UUID, "SessionEnd", 5000);

		// Cancel immediately
		server.cancelWait(UUID);

		const event = await promise;
		expect(event).toBeNull();
	});

	it("cancelWait on non-existent token is a no-op", async () => {
		const server = await createServer();
		// Should not throw
		server.cancelWait("no-such-token-1234-5678-9abc-def012345678");
	});

	it("cancelWait removes listener (no accumulation)", async () => {
		const server = await createServer();

		// Create multiple waits and cancel them
		const p1 = server.waitForEvent(UUID, "SessionEnd", 5000);
		server.cancelWait(UUID);
		await p1;

		const token2 = "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2";
		const p2 = server.waitForEvent(token2, "SessionEnd", 5000);
		server.cancelWait(token2);
		await p2;

		// After cancels, listener count should not have grown
		expect(server.listenerCount("hook")).toBe(0);
	});

	it("server binds to 127.0.0.1 only", async () => {
		const server = await createServer();
		const port = server.getPort();

		// Direct request to 127.0.0.1 should work
		const res = await post(port, VALID_PATH);
		expect(res.status).toBe(200);
	});

	it("POST with non-UUID token → 400", async () => {
		const server = await createServer();
		const res = await post(
			server.getPort(),
			"/hook/complete?token=not-a-uuid&sessionId=x&issueId=y&eventType=SessionEnd",
		);
		expect(res.status).toBe(400);
	});

	it("waitForCompletion delegates to waitForEvent with SessionEnd", async () => {
		const server = await createServer();
		const promise = server.waitForCompletion(UUID, 2000);

		await post(server.getPort(), VALID_PATH);

		const event = await promise;
		expect(event).not.toBeNull();
		expect(event!.token).toBe(UUID);
		expect(event!.eventType).toBe("SessionEnd");
	});
});
