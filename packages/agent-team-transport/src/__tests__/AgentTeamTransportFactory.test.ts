/**
 * AgentTeamTransportFactory tests.
 *
 * Validates env-based backend selection + loud failure for unimplemented
 * adapters (Codex stub).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentTeamTransportFactory } from "../AgentTeamTransportFactory.js";
import { ClaudeCodeAdapter } from "../claude/ClaudeCodeAdapter.js";

const originalBackend = process.env.FLYWHEEL_AGENT_BACKEND;

beforeEach(() => {
	delete process.env.FLYWHEEL_AGENT_BACKEND;
});

afterEach(() => {
	if (originalBackend === undefined) {
		delete process.env.FLYWHEEL_AGENT_BACKEND;
	} else {
		process.env.FLYWHEEL_AGENT_BACKEND = originalBackend;
	}
});

describe("AgentTeamTransportFactory", () => {
	it("defaults to ClaudeCodeAdapter when env not set", () => {
		const adapter = AgentTeamTransportFactory.fromEnv();
		expect(adapter.vendorId()).toBe("claude-code");
		expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
	});

	it("returns ClaudeCodeAdapter when FLYWHEEL_AGENT_BACKEND=claude-code", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "claude-code";
		const adapter = AgentTeamTransportFactory.fromEnv();
		expect(adapter.vendorId()).toBe("claude-code");
	});

	it("throws loud at boot when FLYWHEEL_AGENT_BACKEND=codex (stub not implemented)", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "codex";
		expect(() => AgentTeamTransportFactory.fromEnv()).toThrow(
			/CodexAdapter is not implemented yet/,
		);
	});

	it("rejects unknown backend with helpful error", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "rocketchat";
		expect(() => AgentTeamTransportFactory.fromEnv()).toThrow(
			/Unsupported FLYWHEEL_AGENT_BACKEND env: "rocketchat"/,
		);
	});

	it("respects explicit `backend` option override", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "claude-code";
		const adapter = AgentTeamTransportFactory.fromEnv({ backend: "claude-code" });
		expect(adapter.vendorId()).toBe("claude-code");
	});

	it("passes ClaudeCodeAdapterOptions through", () => {
		const adapter = AgentTeamTransportFactory.fromEnv({
			claudeCode: { maxPayloadBytes: 50_000 },
		});
		expect(adapter.capabilities().maxPayloadBytes).toBe(50_000);
	});
});
