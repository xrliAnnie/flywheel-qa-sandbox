/**
 * FLY-827: centralized Codex review predicate.
 */

import { describe, expect, it } from "vitest";
import { type CodexGateStore, isCodexGateSatisfied } from "../codex-gate.js";

function fakeStore(approved: Set<string>): CodexGateStore {
	return {
		isCodexCodeReviewApproved: (exec, sha) =>
			approved.has(`${exec}:${sha.toLowerCase()}`),
	};
}

const SHA = "a".repeat(40);

describe("FLY-827 isCodexGateSatisfied", () => {
	const session = { execution_id: "exec1" };

	it("FLY-1981: process env =0 cannot satisfy a missing exact-head review", () => {
		const previous = process.env.FLYWHEEL_CODEX_HARD_GATE;
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		try {
			expect(isCodexGateSatisfied(fakeStore(new Set()), session, SHA)).toBe(
				false,
			);
		} finally {
			if (previous === undefined) {
				delete process.env.FLYWHEEL_CODEX_HARD_GATE;
			} else {
				process.env.FLYWHEEL_CODEX_HARD_GATE = previous;
			}
		}
	});

	it("codex_skip session → satisfied without a record", () => {
		const store = fakeStore(new Set());
		expect(
			isCodexGateSatisfied(
				store,
				{ execution_id: "exec1", codex_skip: 1 },
				SHA,
			),
		).toBe(true);
	});

	it("approved record for this head → satisfied", () => {
		const store = fakeStore(new Set([`exec1:${SHA}`]));
		expect(isCodexGateSatisfied(store, session, SHA)).toBe(true);
	});

	it("no record + not codex_skip → NOT satisfied (fail-closed)", () => {
		const store = fakeStore(new Set());
		expect(isCodexGateSatisfied(store, session, SHA)).toBe(false);
	});

	it("record for a different head does not satisfy this head", () => {
		const store = fakeStore(new Set([`exec1:${"b".repeat(40)}`]));
		expect(isCodexGateSatisfied(store, session, SHA)).toBe(false);
	});
});
