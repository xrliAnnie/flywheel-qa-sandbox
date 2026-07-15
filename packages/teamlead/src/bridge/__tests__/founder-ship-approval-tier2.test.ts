/**
 * FLY-799 Part A — Tier-2 exact-allowlist approval matcher (RED first).
 *
 * Codex R7 #1 / R8 #3: Tier-2 must be an EXACT whole-message allowlist, NOT a
 * substring keyword detector. It is the zero-AI fast path for unambiguous short
 * founder approvals; anything else DOWNGRADES to Tier-3 (the subscription
 * classifier) — Tier-2 never returns "approve" for a hedged/negated/multi-clause
 * message, and never approves a message whose issue/PR reference does not match
 * the current gate.
 *
 * The matcher is pure + data-driven so future allowlist additions can't silently
 * reintroduce substring semantics.
 */

import { describe, expect, it } from "vitest";
import {
	hasExplicitMismatchedReference,
	matchTier2Approval,
} from "../approval-signal/tier2-allowlist.js";

const GATE = { issueIdentifier: "FLY-799", prNumber: 799 } as const;

describe("matchTier2Approval — exact allowlist (approve)", () => {
	it.each([
		"ship",
		"ship it",
		"approve",
		"approved",
		"lgtm",
		"go",
		"批准",
		"可以 ship",
		"上线吧",
		"同意上线",
		"  Ship It  ", // trim + case-insensitive normalization
		"SHIP",
	])("approves bare unambiguous approval: %j", (msg) => {
		expect(matchTier2Approval(msg, GATE)).toBe("approve");
	});

	it("approves when the issue/PR reference matches the current gate", () => {
		expect(matchTier2Approval("ship FLY-799", GATE)).toBe("approve");
		expect(matchTier2Approval("ship #799", GATE)).toBe("approve");
		expect(matchTier2Approval("approve FLY-799", GATE)).toBe("approve");
	});
});

describe("matchTier2Approval — bypass surface downgrades to Tier-3 (Codex R7/R8)", () => {
	it.each([
		"I approve the direction but don't ship yet", // hedge + negation
		"LGTM after QA", // condition
		"ship it after review",
		"go with option A", // extra content, not bare approval
		"先别 ship", // zh negation
		"我看看再 ship", // zh hedge
		"不同意上线",
		"他刚才说 ship it, 我不同意", // quoted + negation + comma
		"ship it\nbut wait", // newline
		"approve: see thread", // colon
		"lgtm, ping me first", // comma
		"ship https://github.com/x/y/pull/1", // url
		"can we ship?", // question mark
		"ship this whole giant batch of eight different things now please", // too long
	])("downgrades hedged/complex message: %j", (msg) => {
		expect(matchTier2Approval(msg, GATE)).toBe("downgrade");
	});

	it("does NOT approve when the issue/PR number mismatches the current gate", () => {
		// bare "ship 756" must not be a permanent approval for the FLY-799 gate
		expect(matchTier2Approval("ship 756", GATE)).toBe("downgrade");
		expect(matchTier2Approval("ship FLY-756", GATE)).toBe("downgrade");
		expect(matchTier2Approval("approve #756", GATE)).toBe("downgrade");
	});

	it("downgrades empty / whitespace-only input", () => {
		expect(matchTier2Approval("", GATE)).toBe("downgrade");
		expect(matchTier2Approval("   ", GATE)).toBe("downgrade");
	});
});

describe("matchTier2Approval — affirmation-prefix normalization (FLY-1041 Fix C)", () => {
	const NORM = { prefixNorm: true } as const;

	it.each([
		"嗯ship", // the FLY-910 killer: CJK affirmation glued to the approval
		"嗯 ship",
		"嗯嗯 可以",
		"好ship",
		"好的 上线吧",
		"哦 批准",
		"行 ship",
		"okk ship",
		"ok ship it",
		"yes ship",
		"嗯嗯嗯ship", // repeated prefixes all strip
		"嗯 可以 ship",
	])("approves affirmation-prefixed approval: %j", (m) => {
		expect(matchTier2Approval(m, GATE, NORM)).toBe("approve");
	});

	it.each([
		"嗯 先别ship", // deny caught BEFORE stripping
		"嗯?ship", // structural complexity still first
		"okk", // strips to empty — an affirmation alone is NOT a ship approval
		"嗯",
		"嗯嗯",
		"嗯ship FLY-999", // wrong reference still fails
		"okknot ship", // deny re-check AFTER stripping ("not" was boundary-hidden)
		"嗯 等等 ship", // deny token survives stripping
	])("still downgrades: %j", (m) => {
		expect(matchTier2Approval(m, GATE, NORM)).toBe("downgrade");
	});

	it("reverse-compat sentinel: without opts (prefixNorm off) 嗯ship downgrades exactly as before", () => {
		expect(matchTier2Approval("嗯ship", GATE)).toBe("downgrade");
		expect(matchTier2Approval("嗯ship", GATE, { prefixNorm: false })).toBe(
			"downgrade",
		);
	});

	it("existing bare approvals are unaffected by prefixNorm", () => {
		expect(matchTier2Approval("ship", GATE, NORM)).toBe("approve");
		expect(matchTier2Approval("可以", GATE, NORM)).toBe("approve");
		expect(matchTier2Approval("ship FLY-799", GATE, NORM)).toBe("approve");
		expect(matchTier2Approval("先别 ship", GATE, NORM)).toBe("downgrade");
	});
});

describe("hasExplicitMismatchedReference (FLY-799 Codex R1 HIGH-3)", () => {
	it("explicit wrong FLY-<n> → true (fail-closed target)", () => {
		expect(hasExplicitMismatchedReference("ship FLY-756", GATE)).toBe(true);
	});
	it("correct FLY-<n> → false", () => {
		expect(hasExplicitMismatchedReference("ship FLY-799", GATE)).toBe(false);
	});
	it("wrong #<n> PR → true", () => {
		expect(hasExplicitMismatchedReference("approve #123", GATE)).toBe(true);
	});
	it("correct #<n> PR (matches prNumber) → false", () => {
		expect(hasExplicitMismatchedReference("approve #799", GATE)).toBe(false);
	});
	it("bare incidental number is NOT a reference → false (still downgrades to Tier-3)", () => {
		expect(
			hasExplicitMismatchedReference("ship it, fixes 500 errors", GATE),
		).toBe(false);
	});
	it("no reference at all → false", () => {
		expect(hasExplicitMismatchedReference("looks good, ship", GATE)).toBe(
			false,
		);
	});
});
