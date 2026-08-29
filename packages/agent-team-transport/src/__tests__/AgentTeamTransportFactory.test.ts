/**
 * AgentTeamTransportFactory tests.
 *
 * Validates env-based backend selection. FLY-123: the Codex adapter is
 * real (boot-throw removed per plan 1.8); the Phase 1 Lead-context guard
 * is covered here and in factory-backend.test.ts.
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

	it("FLY-123: FLYWHEEL_AGENT_BACKEND=codex returns the codex adapter (boot-throw removed — plan 1.8, Spike-\u03b4 passed)", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "codex";
		const adapter = AgentTeamTransportFactory.fromEnv();
		expect(adapter.vendorId()).toBe("codex");
	});

	it("rejects unknown backend with helpful error", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "rocketchat";
		expect(() => AgentTeamTransportFactory.fromEnv()).toThrow(
			/Unsupported FLYWHEEL_AGENT_BACKEND env: "rocketchat"/,
		);
	});

	it("respects explicit `backend` option override", () => {
		process.env.FLYWHEEL_AGENT_BACKEND = "claude-code";
		const adapter = AgentTeamTransportFactory.fromEnv({
			backend: "claude-code",
		});
		expect(adapter.vendorId()).toBe("claude-code");
	});

	it("passes ClaudeCodeAdapterOptions through", () => {
		const adapter = AgentTeamTransportFactory.fromEnv({
			claudeCode: { maxPayloadBytes: 50_000 },
		});
		expect(adapter.capabilities().maxPayloadBytes).toBe(50_000);
	});
});
