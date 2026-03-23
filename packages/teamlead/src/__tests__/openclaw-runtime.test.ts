import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { OpenClawRuntime } from "../bridge/openclaw-runtime.js";

// Mock notifyAgent at the module level
vi.mock("../bridge/hook-payload.js", async (importOriginal) => {
	const actual =
		(await importOriginal()) as typeof import("../bridge/hook-payload.js");
	return {
		...actual,
		notifyAgent: vi.fn().mockResolvedValue(undefined),
	};
});

import { buildHookBody, notifyAgent } from "../bridge/hook-payload.js";

const mockNotifyAgent = vi.mocked(notifyAgent);

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

	beforeEach(() => {
		vi.clearAllMocks();
		runtime = new OpenClawRuntime("http://gw:18789", "tok-123");
	});

	it("has type openclaw", () => {
		expect(runtime.type).toBe("openclaw");
	});

	it("deliver() calls notifyAgent with correct body", async () => {
		const env = makeEnvelope();
		await runtime.deliver(env);

		expect(mockNotifyAgent).toHaveBeenCalledOnce();
		expect(mockNotifyAgent).toHaveBeenCalledWith(
			"http://gw:18789",
			"tok-123",
			buildHookBody("product-lead", env.event, "flywheel:GEO-100"),
		);
	});

	it("deliver() updates health tracking", async () => {
		const env = makeEnvelope({ seq: 42 });
		await runtime.deliver(env);

		const h = await runtime.health();
		expect(h.status).toBe("healthy");
		expect(h.lastDeliveredSeq).toBe(42);
		expect(h.lastDeliveryAt).toBeTruthy();
	});

	it("health() returns degraded before first delivery", async () => {
		const h = await runtime.health();
		expect(h.status).toBe("degraded");
		expect(h.lastDeliveryAt).toBeNull();
		expect(h.lastDeliveredSeq).toBe(0);
	});

	it("sendBootstrap() is a no-op", async () => {
		// Should not throw
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
