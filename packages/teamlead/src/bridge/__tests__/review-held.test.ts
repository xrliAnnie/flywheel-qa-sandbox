/**
 * FLY-827: isReviewHeld = codex gate hold OR QA hold (the unified founder-hold
 * predicate consumed by all four founder-surface points).
 */

import { describe, expect, it } from "vitest";
import type { AutoQaRecord } from "../../StateStore.js";
import { isReviewHeld, type QaHeldSession } from "../auto-qa-held.js";

const SHA = "a".repeat(40);

interface FakeState {
	codexApproved?: boolean;
	qaRecord?: Partial<AutoQaRecord>;
}

function fakeStore(state: FakeState) {
	return {
		isCodexCodeReviewApproved: () => state.codexApproved === true,
		getAutoQaRecord: (): AutoQaRecord | undefined =>
			state.qaRecord
				? ({
						parent_execution_id: "exec1",
						target_pr_head_sha: SHA,
						issue_id: "FLY-1",
						project_name: "proj",
						status: "running",
						started_at: "now",
						...state.qaRecord,
					} as AutoQaRecord)
				: undefined,
	};
}

const awaitingMain: QaHeldSession = {
	execution_id: "exec1",
	session_role: "main",
	status: "awaiting_review",
	pr_head_sha: SHA,
};

describe("FLY-827 isReviewHeld", () => {
	it("codex NOT approved → held (even with no QA record)", () => {
		const store = fakeStore({ codexApproved: false });
		expect(isReviewHeld(store, awaitingMain, {})).toBe(true);
	});

	it("codex approved + QA record not passed → held (QA hold)", () => {
		const store = fakeStore({
			codexApproved: true,
			qaRecord: { status: "running" },
		});
		expect(isReviewHeld(store, awaitingMain, {})).toBe(true);
	});

	it("codex approved + QA passed → released", () => {
		const store = fakeStore({
			codexApproved: true,
			qaRecord: { status: "passed" },
		});
		expect(isReviewHeld(store, awaitingMain, {})).toBe(false);
	});

	it("codex approved + no QA record → released", () => {
		const store = fakeStore({ codexApproved: true });
		expect(isReviewHeld(store, awaitingMain, {})).toBe(false);
	});

	it("gate OFF → falls back to isQaHeld (no codex hold)", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			isReviewHeld(store, awaitingMain, { FLYWHEEL_CODEX_HARD_GATE: "0" }),
		).toBe(false);
	});

	it("codex_skip session → released (sanctioned bypass)", () => {
		const store = fakeStore({ codexApproved: false });
		expect(isReviewHeld(store, { ...awaitingMain, codex_skip: 1 }, {})).toBe(
			false,
		);
	});

	it("missing sha + hard gate on + not codex_skip → held (R2-MED-3)", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			isReviewHeld(store, { ...awaitingMain, pr_head_sha: undefined }, {}),
		).toBe(true);
	});

	it("missing sha + gate OFF → not held (byte-compat)", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			isReviewHeld(
				store,
				{
					...awaitingMain,
					pr_head_sha: undefined,
					// gate off
				} as QaHeldSession,
				{ FLYWHEEL_CODEX_HARD_GATE: "0" },
			),
		).toBe(false);
	});

	it("non-awaiting_review / non-reviewable-role → not held", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			isReviewHeld(store, { ...awaitingMain, status: "running" }, {}),
		).toBe(false);
		// qa (auto-QA runner OR FLY-793 qa phase) is the verifier — never held.
		expect(
			isReviewHeld(store, { ...awaitingMain, session_role: "qa" }, {}),
		).toBe(false);
		// design never reaches awaiting_review / owns no PR.
		expect(
			isReviewHeld(store, { ...awaitingMain, session_role: "design" }, {}),
		).toBe(false);
	});

	it("FLY-793 implement phase (PR-owning) + codex NOT approved → held", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			isReviewHeld(store, { ...awaitingMain, session_role: "implement" }, {}),
		).toBe(true);
	});

	it("FLY-793 implement phase + codex approved → released", () => {
		const store = fakeStore({ codexApproved: true });
		expect(
			isReviewHeld(store, { ...awaitingMain, session_role: "implement" }, {}),
		).toBe(false);
	});
});
