import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventIngestion } from "../EventIngestion.js";
import { StateStore } from "../StateStore.js";

async function postEvent(port: number, body: unknown): Promise<{ status: number; body: string }> {
	const data = typeof body === "string" ? body : JSON.stringify(body);
	const res = await fetch(`http://127.0.0.1:${port}/events`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: data,
	});
	return { status: res.status, body: await res.text() };
}

describe("EventIngestion", () => {
	let store: StateStore;
	let ingestion: EventIngestion;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(async () => {
		if (ingestion) await ingestion.stop();
		store.close();
	});

	it("POST valid event → 200 + stored in DB", async () => {
		ingestion = new EventIngestion(store);
		const port = await ingestion.start(0);

		const res = await postEvent(port, {
			event_id: "e1",
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			event_type: "session_started",
		});

		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ ok: true });

		const events = store.getEventsByExecution("exec-1");
		expect(events).toHaveLength(1);
		expect(events[0]!.event_type).toBe("session_started");
	});

	it("POST duplicate event_id → 200 (idempotent)", async () => {
		ingestion = new EventIngestion(store);
		const port = await ingestion.start(0);

		const event = {
			event_id: "dup-1",
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			event_type: "session_started",
		};

		await postEvent(port, event);
		const res = await postEvent(port, event);
		expect(res.status).toBe(200);

		const events = store.getEventsByExecution("exec-1");
		expect(events).toHaveLength(1);
	});

	it("POST missing required field → 400", async () => {
		ingestion = new EventIngestion(store);
		const port = await ingestion.start(0);

		const res = await postEvent(port, {
			event_id: "e1",
			// missing execution_id
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			event_type: "session_started",
		});

		expect(res.status).toBe(400);
	});

	it("POST body > 512KB → 413", async () => {
		ingestion = new EventIngestion(store);
		const port = await ingestion.start(0);

		const largeBody = JSON.stringify({
			event_id: "e1",
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { data: "x".repeat(600_000) },
		});

		const res = await fetch(`http://127.0.0.1:${port}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: largeBody,
		}).catch(() => ({ status: 413, text: async () => "payload too large" }));

		// Either 413 or connection reset (both valid)
		expect([413, 0]).toContain(res.status);
	});

	it("session_started updates session status to running", async () => {
		ingestion = new EventIngestion(store);
		const port = await ingestion.start(0);

		await postEvent(port, {
			event_id: "e1",
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			event_type: "session_started",
		});

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
	});

	it("session_completed updates session with evidence fields", async () => {
		ingestion = new EventIngestion(store);
		const port = await ingestion.start(0);

		await postEvent(port, {
			event_id: "e1",
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review", reasoning: "looks good" },
				evidence: { commitCount: 3, filesChangedCount: 5 },
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("awaiting_review");
		expect(session!.decision_route).toBe("needs_review");
		expect(session!.commit_count).toBe(3);
	});

	it("onEvent callback fires on new event", async () => {
		const onEvent = vi.fn();
		ingestion = new EventIngestion(store, onEvent);
		const port = await ingestion.start(0);

		await postEvent(port, {
			event_id: "e1",
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			event_type: "session_started",
		});

		expect(onEvent).toHaveBeenCalledTimes(1);
		expect(onEvent.mock.calls[0]![0].event_type).toBe("session_started");
	});

	it("binds to 127.0.0.1 only", async () => {
		ingestion = new EventIngestion(store);
		const port = await ingestion.start(0);

		const addr = ingestion["server"].address();
		expect(addr).toBeDefined();
		if (typeof addr === "object" && addr) {
			expect(addr.address).toBe("127.0.0.1");
		}
	});

	it("rejects requests without auth token when configured", async () => {
		ingestion = new EventIngestion(store, undefined, "secret-token");
		const port = await ingestion.start(0);

		// No auth header → 401
		const res1 = await postEvent(port, {
			event_id: "e1",
			execution_id: "exec-1",
			issue_id: "GEO-95",
			project_name: "geoforge3d",
			event_type: "session_started",
		});
		expect(res1.status).toBe(401);

		// With correct auth → 200
		const res2 = await fetch(`http://127.0.0.1:${port}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer secret-token",
			},
			body: JSON.stringify({
				event_id: "e2",
				execution_id: "exec-2",
				issue_id: "GEO-96",
				project_name: "geoforge3d",
				event_type: "session_started",
			}),
		});
		expect(res2.status).toBe(200);
	});
});
