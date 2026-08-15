import type { LeadLeaseRow } from "flywheel-comm/lead-lease";
import { describe, expect, it, vi } from "vitest";
import { readLeadRecipientState } from "../lead-recipient-liveness.js";

const bound = (overrides: Partial<LeadLeaseRow> = {}): LeadLeaseRow => ({
	leadKey: "flywheel-eng-lead",
	project: "flywheel",
	leadId: "eng-lead",
	identityDigest: "digest",
	generation: 2,
	supervisorPid: 900,
	supervisorStart: "supervisor-start",
	supervisorGeneration: 2,
	holderPid: 901,
	holderStart: "holder-start",
	boundAt: "2026-08-14T12:00:00.000Z",
	acquiredAt: "2026-08-14T11:59:00.000Z",
	acquiredBy: "launchd",
	...overrides,
});

describe("FLY-1773 Lead recipient liveness", () => {
	it("holds when the holder is dead even if the supervisor tuple is alive", () => {
		const processTupleState = vi.fn((pid: number) =>
			pid === 900 ? "alive" : "dead",
		);
		expect(
			readLeadRecipientState({
				leadKey: "flywheel-eng-lead",
				leaseReader: { getLease: () => bound() },
				processTupleState,
			}),
		).toBe("unknown");
		expect(processTupleState).toHaveBeenCalledOnce();
		expect(processTupleState).toHaveBeenCalledWith(901, "holder-start");
	});

	it("reports alive only for an alive holder tuple", () => {
		expect(
			readLeadRecipientState({
				leadKey: "flywheel-eng-lead",
				leaseReader: { getLease: () => bound() },
				processTupleState: () => "alive",
			}),
		).toBe("alive");
	});

	it.each([
		["missing", undefined],
		["unbound", bound({ boundAt: null, holderPid: null, holderStart: null })],
		["legacy", bound({ identityDigest: null })],
		["malformed holder", bound({ holderPid: -1 })],
	] as const)("falls back alive for %s lease coverage", (_name, row) => {
		expect(
			readLeadRecipientState({
				leadKey: "flywheel-eng-lead",
				leaseReader: { getLease: () => row },
				processTupleState: () => "dead",
			}),
		).toBe("alive");
	});

	it("falls back alive when the lease reader fails", () => {
		expect(
			readLeadRecipientState({
				leadKey: "flywheel-eng-lead",
				leaseReader: {
					getLease: () => {
						throw new Error("sqlite unavailable");
					},
				},
				processTupleState: () => "dead",
			}),
		).toBe("alive");
	});
});
