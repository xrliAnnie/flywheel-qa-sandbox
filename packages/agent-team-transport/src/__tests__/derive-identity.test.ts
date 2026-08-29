import { describe, expect, it } from "vitest";
import { deriveRunnerMailboxIdentity } from "../path-helpers.js";

describe("deriveRunnerMailboxIdentity (FLY-168)", () => {
	it("derives agentName from the first 8 chars of the execution id", () => {
		const { agentName } = deriveRunnerMailboxIdentity(
			"6b1920df-fcad-4ebc-9677-40ac675cf229",
			"product-lead",
		);
		expect(agentName).toBe("runner-6b1920df");
	});

	it("passes leadId through as teamName", () => {
		const { teamName } = deriveRunnerMailboxIdentity(
			"abcdef12-0000",
			"ops-lead",
		);
		expect(teamName).toBe("ops-lead");
	});

	it("matches the convention used by buildAgentTeamIdentity (runner-<8>)", () => {
		// Guards the single-source-of-truth contract: the spawn side
		// (run-dispatcher.buildAgentTeamIdentity) and the send side
		// (flywheel-comm send) must derive the same identity.
		const execId = "deadbeef-cafe-1234-5678-90abcdefffff";
		const { agentName, teamName } = deriveRunnerMailboxIdentity(
			execId,
			"cos-lead",
		);
		expect(agentName).toBe(`runner-${execId.slice(0, 8)}`);
		expect(agentName).toBe("runner-deadbeef");
		expect(teamName).toBe("cos-lead");
	});

	it("handles execution ids shorter than 8 chars without throwing", () => {
		const { agentName } = deriveRunnerMailboxIdentity("abc", "lead");
		expect(agentName).toBe("runner-abc");
	});
});
