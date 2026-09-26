import { describe, expect, it } from "vitest";
import {
	decideMilestoneReport,
	type MilestonePolicySession,
	milestoneLabel,
} from "../milestone-report-policy.js";

const ALL = ["completed", "failed", "blocked"] as const;
const NOW = 1_000_000_000;
const GRACE = 90_000; // 90s

function session(
	over: Partial<MilestonePolicySession> = {},
): MilestonePolicySession {
	return {
		status: "completed",
		session_role: "main",
		lastActivityMs: NOW - GRACE - 1, // past grace by default
		...over,
	};
}

describe("decideMilestoneReport (FLY-725)", () => {
	it("notifies a completed main session past grace with no marker", () => {
		const a = decideMilestoneReport(session(), ALL, false, NOW, GRACE);
		expect(a).toEqual({ kind: "notify", milestone: "completed" });
	});

	it.each([
		["failed", "failed"],
		["blocked", "blocked"],
	])("maps terminal status %s → milestone %s", (status, milestone) => {
		const a = decideMilestoneReport(
			session({ status }),
			ALL,
			false,
			NOW,
			GRACE,
		);
		expect(a).toEqual({ kind: "notify", milestone });
	});

	it("skips within grace (not yet settled)", () => {
		const a = decideMilestoneReport(
			session({ lastActivityMs: NOW - GRACE + 1 }),
			ALL,
			false,
			NOW,
			GRACE,
		);
		expect(a).toEqual({ kind: "skip", reason: "within_grace" });
	});

	it("skips when a dedup marker already exists", () => {
		const a = decideMilestoneReport(session(), ALL, true, NOW, GRACE);
		expect(a).toEqual({ kind: "skip", reason: "already_notified" });
	});

	it("skips a milestone not in the enabled set", () => {
		const a = decideMilestoneReport(
			session({ status: "completed" }),
			["failed", "blocked"],
			false,
			NOW,
			GRACE,
		);
		expect(a).toEqual({ kind: "skip", reason: "milestone_not_enabled" });
	});

	it("skips a non-main (QA) session role", () => {
		const a = decideMilestoneReport(
			session({ session_role: "qa" }),
			ALL,
			false,
			NOW,
			GRACE,
		);
		expect(a).toEqual({ kind: "skip", reason: "not_main_session" });
	});

	it("treats a null session_role as main (legacy sessions)", () => {
		const a = decideMilestoneReport(
			session({ session_role: undefined }),
			ALL,
			false,
			NOW,
			GRACE,
		);
		expect(a).toEqual({ kind: "notify", milestone: "completed" });
	});

	it("skips a non-terminal status", () => {
		const a = decideMilestoneReport(
			session({ status: "awaiting_review" }),
			ALL,
			false,
			NOW,
			GRACE,
		);
		expect(a).toEqual({ kind: "skip", reason: "non_terminal_status" });
	});

	it("skips when the terminal timestamp is unparseable", () => {
		const a = decideMilestoneReport(
			session({ lastActivityMs: null }),
			ALL,
			false,
			NOW,
			GRACE,
		);
		expect(a).toEqual({ kind: "skip", reason: "no_timestamp" });
	});
});

describe("milestoneLabel", () => {
	it("returns distinct emoji + Chinese label per milestone", () => {
		expect(milestoneLabel("completed")).toEqual({ emoji: "✅", zh: "完成" });
		expect(milestoneLabel("failed")).toEqual({ emoji: "🔴", zh: "失败" });
		expect(milestoneLabel("blocked")).toEqual({ emoji: "⛔", zh: "受阻" });
	});
});
