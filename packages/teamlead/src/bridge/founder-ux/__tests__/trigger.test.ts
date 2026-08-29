/**
 * FLY-598 / FLY-869: founder-ux gate — Layer A trigger snapshot (run-start)
 * unit tests. Pure decision function, exhaustively testable.
 *
 * FLY-869 flips the default from opt-in (only the `founder-facing-ux` label
 * triggers the gate) to default-on (every issue is gated UNLESS it carries an
 * exempt label). The fail-closed-on-read-failure case (Codex R1 MEDIUM, FLY-598)
 * is preserved and still dominates regardless of the exempt-label set.
 */

import { describe, expect, it } from "vitest";
import {
	BRAINSTORM_EXEMPT_LABEL,
	FOUNDER_FACING_UX_LABEL,
	isQaIssueTitle,
	resolveFounderFacingUx,
} from "../trigger.js";

const DEFAULT_EXEMPT = [BRAINSTORM_EXEMPT_LABEL];

describe("FLY-869 resolveFounderFacingUx (Layer A trigger, default-on)", () => {
	it("is founder-facing (gated) by default with no labels at all", () => {
		expect(resolveFounderFacingUx([], false, DEFAULT_EXEMPT)).toBe(true);
	});

	it("is founder-facing (gated) by default for an unrelated label set", () => {
		expect(
			resolveFounderFacingUx(["product", "backend"], false, DEFAULT_EXEMPT),
		).toBe(true);
	});

	it(`is NOT founder-facing when the "${BRAINSTORM_EXEMPT_LABEL}" label is present`, () => {
		expect(
			resolveFounderFacingUx(
				["product", BRAINSTORM_EXEMPT_LABEL],
				false,
				DEFAULT_EXEMPT,
			),
		).toBe(false);
	});

	it(`legacy "${FOUNDER_FACING_UX_LABEL}" label is still in-scope (always-in-scope alias, never exempts)`, () => {
		expect(
			resolveFounderFacingUx(
				["product", FOUNDER_FACING_UX_LABEL],
				false,
				DEFAULT_EXEMPT,
			),
		).toBe(true);
	});

	it("FAIL-CLOSED: is founder-facing when the label fetch FAILED (cannot prove exemption)", () => {
		expect(resolveFounderFacingUx([], true, DEFAULT_EXEMPT)).toBe(true);
	});

	it("FAIL-CLOSED dominates even when an exempt label is present on a failed read", () => {
		// Labels would normally be empty on failure, but the fail-closed flag must
		// win regardless of what partial data is around (defensive).
		expect(
			resolveFounderFacingUx([BRAINSTORM_EXEMPT_LABEL], true, DEFAULT_EXEMPT),
		).toBe(true);
	});

	it("respects a custom exempt-label list (project config override)", () => {
		const customExempt = ["no-brainstorm", "chore"];
		expect(resolveFounderFacingUx(["chore"], false, customExempt)).toBe(false);
		// The default exempt label no longer exempts when NOT in the custom list.
		expect(
			resolveFounderFacingUx([BRAINSTORM_EXEMPT_LABEL], false, customExempt),
		).toBe(true);
	});

	it("an empty exempt-label list gates every issue (no exemptions configured)", () => {
		expect(resolveFounderFacingUx([BRAINSTORM_EXEMPT_LABEL], false, [])).toBe(
			true,
		);
	});
});

describe("FLY-869 QA-issue auto-exemption (Lead 2ee06754)", () => {
	it("isQaIssueTitle matches the `QA ·` verification-issue convention", () => {
		expect(isQaIssueTitle("QA · FLY-873 — verify cmux cleanup")).toBe(true);
		expect(isQaIssueTitle("  QA·FLY-867")).toBe(true); // whitespace + no space
		expect(isQaIssueTitle("QA · anything")).toBe(true);
		expect(isQaIssueTitle("Add a QA · badge to the UI")).toBe(false); // not a prefix
		expect(isQaIssueTitle("QA harness refactor")).toBe(false); // no · separator
		expect(isQaIssueTitle(undefined)).toBe(false);
		expect(isQaIssueTitle("")).toBe(false);
	});

	it("a QA issue is auto-exempt (NOT founder-facing) with no manual label", () => {
		expect(resolveFounderFacingUx([], false, DEFAULT_EXEMPT, true)).toBe(false);
	});

	it("a QA issue is exempt even under a label-read FAILURE (title is independent of labels)", () => {
		// A non-QA issue fail-closes INTO the gate here; a QA issue must NOT.
		expect(resolveFounderFacingUx([], true, DEFAULT_EXEMPT, false)).toBe(true);
		expect(resolveFounderFacingUx([], true, DEFAULT_EXEMPT, true)).toBe(false);
	});

	it("QA·867 (FLY-873) — the real case: gated by default, auto-exempt as a QA issue", () => {
		// Same labels; the ONLY difference is the QA-issue flag derived from the title.
		expect(resolveFounderFacingUx(["engineer"], false, DEFAULT_EXEMPT)).toBe(
			true,
		);
		expect(
			resolveFounderFacingUx(
				["engineer"],
				false,
				DEFAULT_EXEMPT,
				isQaIssueTitle("QA · FLY-867 — cmux dead-tab cleanup"),
			),
		).toBe(false);
	});
});
