/**
 * FLY-2877 T9 — teamlead imports only from this package's root entry (there
 * is no sub-path export), so every lease-guard name it consumes must be there.
 */
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";

describe("FLY-2877 root exports", () => {
	it.each([
		"captureCodexProcessSnapshot",
		"defaultCodexLeaseHolderProbe",
		"holdersFromSnapshot",
		"parseCodexProcessSnapshot",
		"reassertCodexAgentHomeLease",
		"scrubCodexAgentHomeLeaseEntry",
		"releaseCodexAgentHomeLease",
		"retireCodexExecutionHome",
		"scrubOrphanedCodexAgentHomes",
	])("exports %s", (name) => {
		expect(typeof (root as Record<string, unknown>)[name]).toBe("function");
	});

	it("exports the guard and probe types", () => {
		const guard: root.CodexLeaseGuardOptions = {
			probe: async (): Promise<root.CodexLeaseHolderProbeResult> => ({
				status: "ok",
				holders: [],
			}),
		};
		const outcome: root.CodexLeaseReleaseOutcome = {
			released: true,
			remaining: 0,
		};
		const snapshot: root.CodexProcessSnapshot = {
			argsBefore: "",
			authoritative: "",
			argsAfter: "",
		};
		const record: root.CodexProcessRecord | root.CodexUnattributedProcess = {
			pid: 1,
			startIdentity: "x",
			executable: "codex",
			reason: "process_home_unknown",
		};
		const probe: root.CodexLeaseHolderProbe | undefined = guard.probe;
		expect([outcome, snapshot, record, probe].every(Boolean)).toBe(true);
	});
});

describe("FLY-2903 root exports", () => {
	it("exports the rollout locator and the stop-channel wait table", () => {
		expect(typeof root.findCodexRolloutPath).toBe("function");
		expect(root.CODEX_STOP_WAIT_MS.process_retirement).toBe(8_000);
		const reason: root.CodexStopReason = "terminal_sweep";
		const state: root.CodexOwnershipState = "reserved";
		const result: root.CodexStopResult = "reserved_fenced";
		expect([reason, state, result].every(Boolean)).toBe(true);
	});
});
