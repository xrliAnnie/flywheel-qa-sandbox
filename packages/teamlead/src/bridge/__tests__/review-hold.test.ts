import { describe, expect, it } from "vitest";
import type { AutoQaRecord } from "../../StateStore.js";
import {
	type AutoQaHeldStore,
	founderApprovalHoldGuard,
	isQaHeld,
	type QaHeldSession,
} from "../review-hold.js";

const SHA = "a".repeat(40);

function storeWith(record: AutoQaRecord | undefined): AutoQaHeldStore {
	return {
		getAutoQaRecord: (parent, sha) =>
			record &&
			record.parent_execution_id === parent &&
			record.target_pr_head_sha === sha
				? record
				: undefined,
	};
}

function rec(status: AutoQaRecord["status"]): AutoQaRecord {
	return {
		parent_execution_id: "main-1",
		target_pr_head_sha: SHA,
		issue_id: "FLY-1",
		project_name: "proj",
		status,
		started_at: "2026-06-28T00:00:00Z",
	};
}

const main: QaHeldSession = {
	execution_id: "main-1",
	session_role: "main",
	status: "awaiting_review",
	pr_head_sha: SHA,
	pr_number: 42,
};

describe("isQaHeld", () => {
	it("held while QA is running", () => {
		expect(isQaHeld(storeWith(rec("running")), main)).toBe(true);
	});

	it("held when QA failed (founder must NOT be surfaced for a failed change)", () => {
		expect(isQaHeld(storeWith(rec("failed")), main)).toBe(true);
	});

	it("held when QA is stuck (pipeline error → Lead handles, founder stays out)", () => {
		expect(isQaHeld(storeWith(rec("stuck")), main)).toBe(true);
	});

	it("RELEASED once QA passed (founder may be surfaced)", () => {
		expect(isQaHeld(storeWith(rec("passed")), main)).toBe(false);
	});

	it("not held when no record exists (auto-QA off / byte-compat)", () => {
		expect(isQaHeld(storeWith(undefined), main)).toBe(false);
	});

	it("never holds a QA session itself (role != main)", () => {
		expect(
			isQaHeld(storeWith(rec("running")), { ...main, session_role: "qa" }),
		).toBe(false);
	});

	it("never holds a non-awaiting_review session", () => {
		expect(
			isQaHeld(storeWith(rec("running")), { ...main, status: "running" }),
		).toBe(false);
	});

	it("not held without a pr_head_sha", () => {
		expect(
			isQaHeld(storeWith(rec("running")), { ...main, pr_head_sha: undefined }),
		).toBe(false);
	});

	it("record for a DIFFERENT head does not hold the current head", () => {
		const other = rec("running");
		other.target_pr_head_sha = "b".repeat(40);
		expect(isQaHeld(storeWith(other), main)).toBe(false);
	});

	it("undefined session is never held", () => {
		expect(isQaHeld(storeWith(rec("running")), undefined)).toBe(false);
	});
});

describe("founderApprovalHoldGuard (FLY-1041 Chunk 5)", () => {
	// A merge_block marker holds unconditionally in isReviewHeld — the cheapest
	// way to construct a held session without codex/QA scaffolding.
	const heldSession: QaHeldSession = {
		execution_id: "main-1",
		merge_block_reason: "merge_without_approval",
	};
	const guardStore = {
		getAutoQaRecord: () => undefined,
		isCodexCodeReviewApproved: () => true,
		getShipRelevantDiffSnapshot: () => ({
			pr_number: 42,
			classifier_version: 1,
			ship_relevant: 0 as const,
			computed_at: new Date().toISOString(),
		}),
	} as Parameters<typeof founderApprovalHoldGuard>[0];

	it("delegates to isReviewHeld (held session → true)", () => {
		expect(founderApprovalHoldGuard(guardStore, heldSession)).toBe(true);
	});

	it("un-held session → false", () => {
		expect(founderApprovalHoldGuard(guardStore, main)).toBe(false);
		expect(founderApprovalHoldGuard(guardStore, undefined)).toBe(false);
	});

	it("FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0 cannot bypass a live hold", () => {
		expect(
			Reflect.apply(founderApprovalHoldGuard, undefined, [
				guardStore,
				heldSession,
				{ FLYWHEEL_ATTRIBUTION_HOLD_ALIGN: "0" },
			]),
		).toBe(true);
	});
});
