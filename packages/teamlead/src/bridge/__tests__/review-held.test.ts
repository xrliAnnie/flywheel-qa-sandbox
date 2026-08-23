/**
 * FLY-827: isReviewHeld = codex gate hold OR QA hold (the unified founder-hold
 * predicate consumed by all four founder-surface points).
 */

import { describe, expect, it } from "vitest";
import type { AutoQaRecord } from "../../StateStore.js";
import {
	isReviewHeld,
	type QaHeldSession,
	reviewHoldReason,
} from "../review-hold.js";

const SHA = "a".repeat(40);

interface FakeState {
	codexApproved?: boolean;
	qaRecord?: Partial<AutoQaRecord>;
	shipRelevant?: 0 | 1;
	snapshotComputedAt?: string;
	throwAt?: "codex" | "qa" | "snapshot";
}

function fakeStore(state: FakeState) {
	return {
		isCodexCodeReviewApproved: () => {
			if (state.throwAt === "codex") throw new Error("codex read failed");
			return state.codexApproved === true;
		},
		getAutoQaRecord: (): AutoQaRecord | undefined => {
			if (state.throwAt === "qa") throw new Error("QA read failed");
			return state.qaRecord
				? ({
						parent_execution_id: "exec1",
						target_pr_head_sha: SHA,
						issue_id: "FLY-1",
						project_name: "proj",
						status: "running",
						started_at: "now",
						...state.qaRecord,
					} as AutoQaRecord)
				: undefined;
		},
		getShipRelevantDiffSnapshot: () => {
			if (state.throwAt === "snapshot") {
				throw new Error("snapshot read failed");
			}
			return state.shipRelevant === undefined
				? undefined
				: {
						execution_id: "exec1",
						pr_head_sha: SHA,
						repo: "owner/repo",
						pr_number: 42,
						base_ref: "main",
						base_oid: "b".repeat(40),
						classifier_version: 1,
						ship_relevant: state.shipRelevant,
						file_count: 1,
						computed_at: state.snapshotComputedAt ?? new Date().toISOString(),
					};
		},
	};
}

const awaitingMain: QaHeldSession = {
	execution_id: "exec1",
	session_role: "main",
	status: "awaiting_review",
	pr_head_sha: SHA,
	pr_number: 42,
};

describe("FLY-827 isReviewHeld", () => {
	it("codex NOT approved → held (even with no QA record)", () => {
		const store = fakeStore({ codexApproved: false });
		expect(isReviewHeld(store, awaitingMain)).toBe(true);
	});

	it("codex approved + QA record not passed → held (QA hold)", () => {
		const store = fakeStore({
			codexApproved: true,
			qaRecord: { status: "running" },
		});
		expect(isReviewHeld(store, awaitingMain)).toBe(true);
	});

	it("codex approved + QA passed → released", () => {
		const store = fakeStore({
			codexApproved: true,
			qaRecord: { status: "passed" },
		});
		expect(isReviewHeld(store, awaitingMain)).toBe(false);
	});

	it("E1: code PR with qa_required=0 and no QA record is evidence-held", () => {
		const store = fakeStore({ codexApproved: true, shipRelevant: 1 });
		expect(reviewHoldReason(store, awaitingMain)).toBe("qa_evidence_missing");
	});

	it("E2: server-classified docs-only PR is the only no-evidence release", () => {
		const store = fakeStore({ codexApproved: true, shipRelevant: 0 });
		expect(isReviewHeld(store, awaitingMain)).toBe(false);
	});

	it("E2: an expired docs-only classification fails closed when refresh stops", () => {
		const store = fakeStore({
			codexApproved: true,
			shipRelevant: 0,
			snapshotComputedAt: "2000-01-01T00:00:00.000Z",
		});
		expect(reviewHoldReason(store, awaitingMain)).toBe("qa_evidence_unknown");
	});

	it("E3: a missing diff snapshot fails closed until classification completes", () => {
		const store = fakeStore({ codexApproved: true });
		expect(reviewHoldReason(store, awaitingMain)).toBe("qa_evidence_missing");
	});

	it("E4: missing PR identity is an unknown-evidence hold", () => {
		const store = fakeStore({ codexApproved: true, shipRelevant: 0 });
		expect(
			reviewHoldReason(store, { ...awaitingMain, pr_number: undefined }),
		).toBe("qa_evidence_unknown");
	});

	it("E4: missing PR identity fails closed before a Codex-pending result can defer", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			reviewHoldReason(store, { ...awaitingMain, pr_number: undefined }),
		).toBe("qa_evidence_unknown");
	});

	it("E4: missing PR identity fails closed before a passed QA record can release", () => {
		const store = fakeStore({
			codexApproved: true,
			qaRecord: { status: "passed" },
		});
		expect(
			reviewHoldReason(store, { ...awaitingMain, pr_number: undefined }),
		).toBe("qa_evidence_unknown");
	});

	it.each(["codex", "qa", "snapshot"] as const)(
		"E4: a %s store read failure fails closed for main",
		(throwAt) => {
			const store = fakeStore({ codexApproved: true, throwAt });
			expect(reviewHoldReason(store, awaitingMain)).toBe("qa_evidence_unknown");
		},
	);

	it("preserves the non-main exception contract for store failures", () => {
		const store = fakeStore({ codexApproved: true, throwAt: "qa" });
		expect(() =>
			reviewHoldReason(store, {
				...awaitingMain,
				session_role: "implement",
			}),
		).toThrow("QA read failed");
	});

	it("FLY-1981: env argument =0 cannot bypass the Codex founder hold", () => {
		const store = fakeStore({ codexApproved: false, shipRelevant: 0 });
		expect(
			Reflect.apply(reviewHoldReason, undefined, [
				store,
				awaitingMain,
				{ FLYWHEEL_CODEX_HARD_GATE: "0" },
			]),
		).toBe("codex_pending");
	});

	it("codex_skip bypasses review only, not QA evidence", () => {
		const store = fakeStore({ codexApproved: false });
		expect(isReviewHeld(store, { ...awaitingMain, codex_skip: 1 })).toBe(true);
	});

	it("missing sha + not codex_skip → held (R2-MED-3)", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			isReviewHeld(store, { ...awaitingMain, pr_head_sha: undefined }),
		).toBe(true);
	});

	it("missing sha is an unknown-evidence hold for main", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			reviewHoldReason(store, {
				...awaitingMain,
				pr_head_sha: undefined,
			} as QaHeldSession),
		).toBe("qa_evidence_unknown");
	});

	it("missing sha is permanently Codex-held for implement", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			reviewHoldReason(store, {
				...awaitingMain,
				session_role: "implement",
				pr_head_sha: undefined,
			}),
		).toBe("codex_pending");
	});

	it("missing sha implement honors the sanctioned session codex_skip", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			reviewHoldReason(store, {
				...awaitingMain,
				session_role: "implement",
				pr_head_sha: undefined,
				codex_skip: 1,
			}),
		).toBeNull();
	});

	it("non-awaiting_review / non-reviewable-role → not held", () => {
		const store = fakeStore({ codexApproved: false });
		expect(isReviewHeld(store, { ...awaitingMain, status: "running" })).toBe(
			false,
		);
		// qa (auto-QA runner OR FLY-793 qa phase) is the verifier — never held.
		expect(isReviewHeld(store, { ...awaitingMain, session_role: "qa" })).toBe(
			false,
		);
		// design never reaches awaiting_review / owns no PR.
		expect(
			isReviewHeld(store, { ...awaitingMain, session_role: "design" }),
		).toBe(false);
	});

	it("FLY-793 implement phase (PR-owning) + codex NOT approved → held", () => {
		const store = fakeStore({ codexApproved: false });
		expect(
			isReviewHeld(store, { ...awaitingMain, session_role: "implement" }),
		).toBe(true);
	});

	it("FLY-793 implement phase + codex approved → released", () => {
		const store = fakeStore({ codexApproved: true });
		expect(
			isReviewHeld(store, { ...awaitingMain, session_role: "implement" }),
		).toBe(false);
	});
});
