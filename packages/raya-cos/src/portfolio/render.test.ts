import { describe, expect, it } from "vitest";
import type { PortfolioSnapshot, ProjectReading, Reading } from "./types.js";

const AT = "2026-09-06T12:00:00Z";

function ok<T>(value: T): Reading<T> {
	return { ok: true, value, at: AT };
}

function unavailable<T>(reason: string): Reading<T> {
	return { ok: false, reason };
}

function availableProject(): ProjectReading {
	return {
		projectName: "flywheel",
		repo: "xrliAnnie/flywheel",
		linearBinding: { team: "FLY", project: "Flywheel" },
		checkoutHead: {
			branch: ok("feature/probe"),
			lastCommit: ok({
				sha7: "aaaaaaa",
				committedAt: "2026-09-06T10:00:00Z",
				authoredAt: "2026-09-06T09:00:00Z",
				author: "Annie",
				subject: "feat: <real> work",
			}),
			lastNonChoreCommit: ok({
				sha7: "bbbbbbb",
				committedAt: "2026-09-05T10:00:00Z",
				authoredAt: "2026-09-05T09:00:00Z",
				author: "Annie",
				subject: "fix: behavior",
			}),
			commits30d: ok(4),
			nonChoreCommits30d: ok(2),
			dirtyCount: ok(2),
			worktreeCount: ok(3),
		},
		canonical: {
			defaultBranch: ok("main"),
			lastCommit: ok({
				sha7: "ccccccc",
				committedAt: "2026-09-06T11:00:00Z",
				subject: "feat: canonical",
			}),
		},
		prActivity: {
			number: ok(17),
			state: ok("OPEN"),
			updatedAt: ok("2026-09-06T11:30:00Z"),
			mergedAt: ok(null),
		},
		openPrs: {
			returnedCount: ok(2),
			truncated: ok(false),
			newestUpdatedAt: ok("2026-09-06T11:30:00Z"),
			oldestUpdatedAt: ok("2026-09-01T11:30:00Z"),
			sample: ok([{ number: 17, title: "A PR", isDraft: false }]),
		},
		linear: {
			projectState: ok("started"),
			projectUpdatedAt: ok("2026-09-06T08:00:00Z"),
			activeIssues: ok({
				returnedCount: 3,
				truncated: false,
				latestUpdatedAt: "2026-09-06T07:00:00Z",
			}),
		},
		deployedCheckoutSummaryFiles: {
			count: ok(2),
			latestDate: ok("2026-09-05"),
			checkoutSha: ok("ddddddd"),
		},
		activity: {
			latestObservedActivityAt: ok("2026-09-06T11:30:00Z"),
			coverage: ok(["checkout_non_chore", "canonical_commit", "pr_activity"]),
			daysSinceLatestObservedActivity: ok(0),
		},
	};
}

function unavailableProject(): ProjectReading {
	const no = <T>() => unavailable<T>("dir_missing");
	return {
		projectName: "tidal-echo",
		repo: null,
		linearBinding: null,
		checkoutHead: {
			branch: no(),
			lastCommit: no(),
			lastNonChoreCommit: no(),
			commits30d: no(),
			nonChoreCommits30d: no(),
			dirtyCount: no(),
			worktreeCount: no(),
		},
		canonical: {
			defaultBranch: unavailable("not_configured"),
			lastCommit: unavailable("not_configured"),
		},
		prActivity: {
			number: unavailable("not_configured"),
			state: unavailable("not_configured"),
			updatedAt: unavailable("not_configured"),
			mergedAt: unavailable("not_configured"),
		},
		openPrs: {
			returnedCount: unavailable("not_configured"),
			truncated: unavailable("not_configured"),
			newestUpdatedAt: unavailable("not_configured"),
			oldestUpdatedAt: unavailable("not_configured"),
			sample: unavailable("not_configured"),
		},
		linear: {
			projectState: unavailable("not_configured"),
			projectUpdatedAt: unavailable("not_configured"),
			activeIssues: unavailable("not_configured"),
		},
		deployedCheckoutSummaryFiles: {
			count: no(),
			latestDate: no(),
			checkoutSha: no(),
		},
		activity: {
			latestObservedActivityAt: unavailable("no_activity_source"),
			coverage: unavailable("no_activity_source"),
			daysSinceLatestObservedActivity: unavailable("no_activity_source"),
		},
	};
}

describe("renderSnapshot", () => {
	it("renders real readings with reference keys and explicit unavailable sources", async () => {
		const module = await import("./render.js").catch(() => ({}));
		const renderSnapshot = (module as { renderSnapshot?: unknown })
			.renderSnapshot;
		expect(renderSnapshot).toBeTypeOf("function");
		if (typeof renderSnapshot !== "function") return;
		const snapshot: PortfolioSnapshot = {
			v: 1,
			snapshotId: "20260906120000000-abcdef",
			seq: 1,
			sampledAt: AT,
			trigger: "patrol",
			projects: [availableProject(), unavailableProject()],
			activityAvailable: true,
			all: { git: "partial", gh: "partial", linear: "partial" },
		};

		const markdown = (renderSnapshot as (value: PortfolioSnapshot) => string)(
			snapshot,
		);

		expect(markdown).toContain("## flywheel");
		expect(markdown).toContain(
			"feature/probe (ref: flywheel.checkoutHead.branch)",
		);
		expect(markdown).toContain("(ref: flywheel.canonical.lastCommit)");
		expect(markdown).toContain("(ref: flywheel.prActivity.updatedAt)");
		expect(markdown).toContain("(ref: flywheel.openPrs.returnedCount)");
		expect(markdown).toContain(
			"(ref: flywheel.activity.daysSinceLatestObservedActivity)",
		);
		expect(markdown).toContain("读不到:dir_missing");
		expect(markdown).toContain("tidal-echo: Git、GitHub、Linear");
		expect(markdown).toContain(
			"部署 checkout 里的 summary 文件，不代表未读或已读",
		);
		expect(markdown).toContain("feat: &lt;real&gt; work");
		expect(markdown).not.toContain("/srv/");
		expect(markdown).not.toContain("one.ts");
	});
});
