import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { OpenClawRuntime } from "../bridge/openclaw-runtime.js";

function makeEnvelope(
	overrides?: Partial<LeadEventEnvelope>,
): LeadEventEnvelope {
	return {
		seq: 1,
		event: {
			event_type: "session_completed",
			execution_id: "exec-1",
			issue_id: "issue-1",
		},
		sessionKey: "flywheel:GEO-100",
		leadId: "product-lead",
		timestamp: "2026-03-21T10:00:00.000Z",
		...overrides,
	};
}

describe("OpenClawRuntime", () => {
	let runtime: OpenClawRuntime;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		runtime = new OpenClawRuntime("http://gw:18789", "tok-123");
		// Mock global fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			text: () => Promise.resolve(""),
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("has type openclaw", () => {
		expect(runtime.type).toBe("openclaw");
	});

	it("deliver() calls fetch with correct URL and body", async () => {
		const env = makeEnvelope();
		const result = await runtime.deliver(env);

		expect(result.delivered).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledOnce();
		const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0]!;
		expect(url).toBe("http://gw:18789/hooks/ingest");
		expect(opts.method).toBe("POST");
		expect(opts.headers.Authorization).toBe("Bearer tok-123");
		const body = JSON.parse(opts.body);
		expect(body.agentId).toBe("product-lead");
	});

	it("deliver() returns { delivered: false } on non-ok response", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			text: () => Promise.resolve("Service Unavailable"),
		});

		const env = makeEnvelope();
		const result = await runtime.deliver(env);

		expect(result.delivered).toBe(false);
		expect(result.error).toContain("503");
	});

	it("deliver() returns { delivered: false } on network error", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

		const env = makeEnvelope();
		const result = await runtime.deliver(env);

		expect(result.delivered).toBe(false);
		expect(result.error).toBe("ECONNREFUSED");
	});

	it("deliver() returns { delivered: false } on timeout (abort)", async () => {
		globalThis.fetch = vi.fn().mockImplementation(
			(_url: string, opts: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					opts.signal.addEventListener("abort", () => {
						reject(new Error("The operation was aborted"));
					});
				}),
		);

		vi.useFakeTimers();
		const env = makeEnvelope();
		const promise = runtime.deliver(env);
		vi.advanceTimersByTime(3001);
		const result = await promise;
		vi.useRealTimers();

		expect(result.delivered).toBe(false);
		expect(result.error).toContain("aborted");
	});

	it("deliver() updates health tracking on success", async () => {
		const env = makeEnvelope({ seq: 42 });
		await runtime.deliver(env);

		const h = await runtime.health();
		expect(h.status).toBe("healthy");
		expect(h.lastDeliveredSeq).toBe(42);
		expect(h.lastDeliveryAt).toBeTruthy();
	});

	it("deliver() does NOT update health tracking on failure", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: () => Promise.resolve(""),
		});

		const env = makeEnvelope({ seq: 42 });
		await runtime.deliver(env);

		const h = await runtime.health();
		expect(h.status).toBe("degraded");
		expect(h.lastDeliveredSeq).toBe(0);
	});

	it("health() returns degraded before first delivery", async () => {
		const h = await runtime.health();
		expect(h.status).toBe("degraded");
		expect(h.lastDeliveryAt).toBeNull();
		expect(h.lastDeliveredSeq).toBe(0);
	});

	it("sendBootstrap() is a no-op", async () => {
		await runtime.sendBootstrap({
			leadId: "product-lead",
			activeSessions: [],
			pendingDecisions: [],
			recentFailures: [],
			recentEvents: [],
			memoryRecall: null,
		});
	});

	it("shutdown() is a no-op", async () => {
		await runtime.shutdown();
	});
});
