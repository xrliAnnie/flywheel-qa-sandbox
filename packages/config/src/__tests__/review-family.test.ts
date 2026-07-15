import { describe, expect, it } from "vitest";
import {
	adapterTypeToFamily,
	crossFamilyReviewSatisfied,
	manifestReviewFamilyOk,
} from "../review-family.js";

// ── FLY-1188 §7.3: family-aware review authority (shared pure rule) ──

describe("adapterTypeToFamily", () => {
	it("NULL / undefined / empty → claude (legacy path)", () => {
		expect(adapterTypeToFamily(null)).toBe("claude");
		expect(adapterTypeToFamily(undefined)).toBe("claude");
		expect(adapterTypeToFamily("")).toBe("claude");
	});

	it("claude-tmux → claude", () => {
		expect(adapterTypeToFamily("claude-tmux")).toBe("claude");
	});

	it("codex-tmux → codex", () => {
		expect(adapterTypeToFamily("codex-tmux")).toBe("codex");
	});

	it("other -tmux backends → their own family (suffix stripped)", () => {
		expect(adapterTypeToFamily("antigravity-tmux")).toBe("antigravity");
		expect(adapterTypeToFamily("kimi-tmux")).toBe("kimi");
	});

	it("unknown value without -tmux suffix passes through unchanged", () => {
		expect(adapterTypeToFamily("future-backend")).toBe("future-backend");
	});
});

describe("crossFamilyReviewSatisfied", () => {
	it("skipped → true regardless of families (governance bypass)", () => {
		expect(
			crossFamilyReviewSatisfied({
				status: "skipped",
				authorFamily: null,
				reviewerFamily: null,
				sessionAdapterType: "codex-tmux",
			}),
		).toBe(true);
		expect(
			crossFamilyReviewSatisfied({
				status: "skipped",
				authorFamily: "codex",
				reviewerFamily: "codex",
				sessionAdapterType: "codex-tmux",
			}),
		).toBe(true);
	});

	it("non-approved statuses → false", () => {
		for (const status of ["pending", "rejected", null, undefined, ""]) {
			expect(
				crossFamilyReviewSatisfied({
					status,
					authorFamily: "claude",
					reviewerFamily: "codex",
					sessionAdapterType: null,
				}),
			).toBe(false);
		}
	});

	it("approved + both families stamped + DIFFERENT → true", () => {
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: "codex",
				reviewerFamily: "claude",
				sessionAdapterType: "codex-tmux",
			}),
		).toBe(true);
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: "claude",
				reviewerFamily: "codex",
				sessionAdapterType: null,
			}),
		).toBe(true);
	});

	it("approved + both families stamped + SAME → false (reviewer inversion violated)", () => {
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: "codex",
				reviewerFamily: "codex",
				sessionAdapterType: "codex-tmux",
			}),
		).toBe(false);
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: "claude",
				reviewerFamily: "claude",
				sessionAdapterType: null,
			}),
		).toBe(false);
	});

	it("stamped families win over adapter_type: same-family stamps fail even for a claude session", () => {
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: "claude",
				reviewerFamily: "claude",
				sessionAdapterType: "claude-tmux",
			}),
		).toBe(false);
	});

	it("legacy unstamped approved record: valid ONLY for a claude-family author", () => {
		// NULL adapter_type (pre-FLY-493 row) and explicit claude-tmux → OK
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: null,
				reviewerFamily: null,
				sessionAdapterType: null,
			}),
		).toBe(true);
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: null,
				reviewerFamily: null,
				sessionAdapterType: "claude-tmux",
			}),
		).toBe(true);
	});

	it("legacy unstamped approved record + codex author → FAIL CLOSED", () => {
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: null,
				reviewerFamily: null,
				sessionAdapterType: "codex-tmux",
			}),
		).toBe(false);
	});

	it("half-stamped record (only one family) falls back to the legacy adapter_type rule", () => {
		// author stamped but reviewer missing → cannot prove inversion via stamps;
		// legacy rule applies: claude session passes, codex session fails closed.
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: "codex",
				reviewerFamily: null,
				sessionAdapterType: "codex-tmux",
			}),
		).toBe(false);
		expect(
			crossFamilyReviewSatisfied({
				status: "approved",
				authorFamily: null,
				reviewerFamily: "codex",
				sessionAdapterType: null,
			}),
		).toBe(true);
	});
});

describe("manifestReviewFamilyOk", () => {
	it("accepts only different server-resolved adapter families", () => {
		expect(manifestReviewFamilyOk("claude", "codex")).toBe(true);
		expect(manifestReviewFamilyOk("codex", "claude")).toBe(true);
		expect(manifestReviewFamilyOk("claude", "claude")).toBe(false);
		expect(manifestReviewFamilyOk("codex", "codex")).toBe(false);
		expect(manifestReviewFamilyOk("", "claude")).toBe(false);
		expect(manifestReviewFamilyOk("claude", undefined)).toBe(false);
	});
});
