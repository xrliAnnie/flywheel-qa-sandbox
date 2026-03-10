import { describe, expect, it } from "vitest";
import { buildSessionKey, buildHookBody, type HookPayload } from "../bridge/hook-payload.js";

describe("buildSessionKey", () => {
	it("uses issue_identifier when available", () => {
		expect(buildSessionKey({ issue_identifier: "GEO-42", issue_id: "abc-123" }))
			.toBe("flywheel:GEO-42");
	});

	it("falls back to issue_id when issue_identifier is undefined", () => {
		expect(buildSessionKey({ issue_id: "abc-123" }))
			.toBe("flywheel:abc-123");
	});

	it("falls back to issue_id when issue_identifier is explicitly undefined", () => {
		expect(buildSessionKey({ issue_identifier: undefined, issue_id: "xyz" }))
			.toBe("flywheel:xyz");
	});
});

describe("buildHookBody", () => {
	const payload: HookPayload = {
		event_type: "session_completed",
		execution_id: "exec-1",
		issue_id: "GEO-42",
		issue_identifier: "GEO-42",
		status: "awaiting_review",
	};

	it("builds body with agentId and JSON message", () => {
		const body = buildHookBody("product-lead", payload);
		expect(body.agentId).toBe("product-lead");
		expect(typeof body.message).toBe("string");
		const parsed = JSON.parse(body.message as string);
		expect(parsed.event_type).toBe("session_completed");
		expect(parsed.execution_id).toBe("exec-1");
	});

	it("includes sessionKey when provided", () => {
		const body = buildHookBody("product-lead", payload, "flywheel:GEO-42");
		expect(body.sessionKey).toBe("flywheel:GEO-42");
	});

	it("omits sessionKey when not provided", () => {
		const body = buildHookBody("product-lead", payload);
		expect(body).not.toHaveProperty("sessionKey");
	});
});
