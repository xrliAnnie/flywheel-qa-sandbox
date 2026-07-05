/**
 * FLY-827: centralized codex hard-gate predicates.
 */

import { describe, expect, it } from "vitest";
import {
	type CodexGateStore,
	codexHardGateEnabled,
	codexHoldStuckThresholdMs,
	isCodexGateSatisfied,
} from "../codex-gate.js";

function fakeStore(approved: Set<string>): CodexGateStore {
	return {
		isCodexCodeReviewApproved: (exec, sha) =>
			approved.has(`${exec}:${sha.toLowerCase()}`),
	};
}

const SHA = "a".repeat(40);

describe("FLY-827 codexHardGateEnabled", () => {
	it("default-on when env unset", () => {
		expect(codexHardGateEnabled({})).toBe(true);
	});
	it("off only for explicit '0'", () => {
		expect(codexHardGateEnabled({ FLYWHEEL_CODEX_HARD_GATE: "0" })).toBe(false);
	});
	it("on for '1' / any other value", () => {
		expect(codexHardGateEnabled({ FLYWHEEL_CODEX_HARD_GATE: "1" })).toBe(true);
		expect(codexHardGateEnabled({ FLYWHEEL_CODEX_HARD_GATE: "yes" })).toBe(
			true,
		);
	});
});

describe("FLY-827 isCodexGateSatisfied", () => {
	const session = { execution_id: "exec1" };

	it("gate OFF (kill-switch) → satisfied regardless of record", () => {
		const store = fakeStore(new Set());
		expect(
			isCodexGateSatisfied(store, session, SHA, {
				FLYWHEEL_CODEX_HARD_GATE: "0",
			}),
		).toBe(true);
	});

	it("codex_skip session → satisfied without a record", () => {
		const store = fakeStore(new Set());
		expect(
			isCodexGateSatisfied(
				store,
				{ execution_id: "exec1", codex_skip: 1 },
				SHA,
				{},
			),
		).toBe(true);
	});

	it("approved record for this head → satisfied", () => {
		const store = fakeStore(new Set([`exec1:${SHA}`]));
		expect(isCodexGateSatisfied(store, session, SHA, {})).toBe(true);
	});

	it("no record + gate on + not codex_skip → NOT satisfied (fail-closed)", () => {
		const store = fakeStore(new Set());
		expect(isCodexGateSatisfied(store, session, SHA, {})).toBe(false);
	});

	it("record for a different head does not satisfy this head", () => {
		const store = fakeStore(new Set([`exec1:${"b".repeat(40)}`]));
		expect(isCodexGateSatisfied(store, session, SHA, {})).toBe(false);
	});
});

describe("FLY-863 codexHoldStuckThresholdMs", () => {
	it("defaults to 3 hours when unset", () => {
		expect(codexHoldStuckThresholdMs({})).toBe(3 * 60 * 60 * 1000);
	});

	it("honors a valid positive override", () => {
		expect(
			codexHoldStuckThresholdMs({ FLYWHEEL_CODEX_HOLD_STUCK_MS: "60000" }),
		).toBe(60_000);
	});

	it("falls back to the default on a non-numeric / zero / negative value", () => {
		const fallback = 3 * 60 * 60 * 1000;
		expect(
			codexHoldStuckThresholdMs({
				FLYWHEEL_CODEX_HOLD_STUCK_MS: "not-a-number",
			}),
		).toBe(fallback);
		expect(
			codexHoldStuckThresholdMs({ FLYWHEEL_CODEX_HOLD_STUCK_MS: "0" }),
		).toBe(fallback);
		expect(
			codexHoldStuckThresholdMs({ FLYWHEEL_CODEX_HOLD_STUCK_MS: "-5" }),
		).toBe(fallback);
	});
});
