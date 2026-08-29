/**
 * FLY-123: AgentTeamTransportFactory — forBackend explicit routing (R4 #1)
 * + Phase 1 Lead transport rollout guard (R1 #8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTeamTransportFactory } from "../AgentTeamTransportFactory.js";

describe("AgentTeamTransportFactory (FLY-123)", () => {
	const origEnv = process.env.FLYWHEEL_AGENT_BACKEND;

	beforeEach(() => {
		delete process.env.FLYWHEEL_AGENT_BACKEND;
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		if (origEnv === undefined) delete process.env.FLYWHEEL_AGENT_BACKEND;
		else process.env.FLYWHEEL_AGENT_BACKEND = origEnv;
		vi.restoreAllMocks();
	});

	it("forBackend('claude-code') returns the claude adapter", () => {
		const t = AgentTeamTransportFactory.forBackend("claude-code");
		expect(t.vendorId()).toBe("claude-code");
	});

	it("forBackend('codex') returns the codex adapter", () => {
		const t = AgentTeamTransportFactory.forBackend("codex");
		expect(t.vendorId()).toBe("codex");
	});

	it("forBackend rejects unknown backends", () => {
		expect(() =>
			AgentTeamTransportFactory.forBackend("gemini" as never),
		).toThrow(/Unsupported agent-team transport backend/);
	});

	it("fromEnv default (no env) is claude-code", () => {
		expect(AgentTeamTransportFactory.fromEnv().vendorId()).toBe("claude-code");
	});

	it("LEAD GUARD (R1 #8): env=codex + context=lead → claude-code with stderr warning", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "codex";
		const t = AgentTeamTransportFactory.fromEnv({ context: "lead" });
		expect(t.vendorId()).toBe("claude-code");
		expect(process.stderr.write).toHaveBeenCalledWith(
			expect.stringContaining("locks Lead transport to claude-code"),
		);
	});

	it("env=codex without lead context selects codex (runner-side rollout knob)", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "codex";
		const t = AgentTeamTransportFactory.fromEnv();
		expect(t.vendorId()).toBe("codex");
	});
});
