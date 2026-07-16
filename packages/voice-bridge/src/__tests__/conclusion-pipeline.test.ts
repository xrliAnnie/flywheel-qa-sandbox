/**
 * FLY-545 PR-2 P13′ — ConclusionPipeline landing order + failure semantics:
 * summary comment → worktree → Done → card; Done is last; any earlier
 * failure leaves the issue open and warns visibly.
 */
import { describe, expect, it } from "vitest";
import {
	ConclusionPipeline,
	SUMMARY_MARKER,
} from "../huddle/ConclusionPipeline.js";

const issue = { id: "u1", identifier: "FLY-1234", url: "https://l/1234" };

function setup(
	over: {
		summarize?: (s: string) => Promise<string>;
		commentFail?: boolean;
		worktreeFail?: boolean;
		statusFail?: boolean;
	} = {},
) {
	const calls: string[] = [];
	const warns: string[] = [];
	const cards: string[] = [];
	const comments: Array<{ issueId: string; body: string }> = [];
	const pipeline = new ConclusionPipeline({
		linear: {
			comment: async (issueId, body) => {
				calls.push("comment");
				if (over.commentFail) throw new Error("comment 502");
				comments.push({ issueId, body });
			},
			setStatus: async () => {
				calls.push("status");
				if (over.statusFail) throw new Error("status 502");
			},
		},
		worktree: {
			create: async () => {
				calls.push("worktree");
				if (over.worktreeFail) throw new Error("dirty worktree exists");
				return { path: "/Users/a/Dev/flywheel-FLY-1234" };
			},
		},
		summarize:
			over.summarize ??
			(async () => "## 结论\n1. 发布定周五(引用 [15:00] Annie: 发布定周五)"),
		tiv: {
			card: async (c) => {
				calls.push("card");
				cards.push(c);
			},
			warn: (t) => warns.push(t),
		},
		mainRepoPath: "/Users/a/Dev/flywheel",
		projectName: "flywheel",
	});
	return { pipeline, calls, warns, cards, comments };
}

describe("happy path", () => {
	it("lands in order comment→worktree→Done→card, with the idempotency marker", async () => {
		const { pipeline, calls, comments, cards } = setup();
		const outcome = await pipeline.land({
			issue,
			confirmed: true,
			journalSnapshot: "[ts] Annie: 发布定周五",
		});
		expect(outcome).toBe("landed");
		expect(calls).toEqual(["comment", "worktree", "status", "card"]);
		expect(comments[0]?.issueId).toBe("FLY-1234");
		expect(comments[0]?.body).toContain(SUMMARY_MARKER("FLY-1234"));
		expect(comments[0]?.body).not.toContain("未经口头确认");
		expect(cards[0]).toContain("FLY-1234");
		expect(cards[0]).toContain("/Users/a/Dev/flywheel-FLY-1234");
	});

	it("a degraded (unconfirmed) landing marks the comment AND the card", async () => {
		const { pipeline, comments, cards } = setup();
		await pipeline.land({ issue, confirmed: false, journalSnapshot: "x" });
		expect(comments[0]?.body).toContain("未经口头确认");
		expect(cards[0]).toContain("未经口头确认");
	});
});

describe("failure semantics — Done is last, failures are loud", () => {
	it("summarize failure: nothing written, issue open, warn carries transcript hint", async () => {
		const { pipeline, calls, warns } = setup({
			summarize: async () => {
				throw new Error("brain timeout");
			},
		});
		const outcome = await pipeline.land({
			issue,
			confirmed: true,
			journalSnapshot: "x",
			transcriptPath: "/tmp/t.jsonl",
		});
		expect(outcome).toBe("failed");
		expect(calls).toEqual([]);
		expect(warns[0]).toContain("/tmp/t.jsonl");
	});

	it("comment failure: no worktree, no Done", async () => {
		const { pipeline, calls, warns } = setup({ commentFail: true });
		expect(
			await pipeline.land({ issue, confirmed: true, journalSnapshot: "x" }),
		).toBe("failed");
		expect(calls).toEqual(["comment"]);
		expect(warns[0]).toContain("留 open");
	});

	it("worktree failure: comment stays, no Done", async () => {
		const { pipeline, calls, warns } = setup({ worktreeFail: true });
		expect(
			await pipeline.land({ issue, confirmed: true, journalSnapshot: "x" }),
		).toBe("failed");
		expect(calls).toEqual(["comment", "worktree"]);
		expect(warns[0]).toContain("worktree");
	});

	it("Done-flip failure: artifacts exist, flips is handed to a human", async () => {
		const { pipeline, calls, warns } = setup({ statusFail: true });
		expect(
			await pipeline.land({ issue, confirmed: true, journalSnapshot: "x" }),
		).toBe("failed");
		expect(calls).toEqual(["comment", "worktree", "status"]);
		expect(warns[0]).toContain("人工");
	});
});

describe("idempotency guard (Codex R1: marker written but never checked)", () => {
	function setupWithState(state: string | Error) {
		const calls: string[] = [];
		const cards: string[] = [];
		const pipeline = new ConclusionPipeline({
			linear: {
				comment: async () => {
					calls.push("comment");
				},
				setStatus: async () => {
					calls.push("status");
				},
				getState: async () => {
					if (state instanceof Error) throw state;
					return state;
				},
			},
			worktree: {
				create: async () => {
					calls.push("worktree");
					return { path: "/tmp/wt" };
				},
			},
			summarize: async () => "## 结论",
			tiv: {
				card: async (c) => {
					calls.push("card");
					cards.push(c);
				},
				warn: () => {},
			},
			mainRepoPath: "/tmp/repo",
			projectName: "flywheel",
		});
		return { pipeline, calls, cards };
	}

	it("an already-Done issue short-circuits — no comment, no worktree, no flip", async () => {
		const { pipeline, calls, cards } = setupWithState("Done");
		const outcome = await pipeline.land({
			issue,
			confirmed: true,
			journalSnapshot: "x",
		});
		expect(outcome).toBe("landed");
		expect(calls).toEqual(["card"]);
		expect(cards[0]).toContain("已经落地过");
	});

	it("a getState failure never blocks the landing (guard only)", async () => {
		const { pipeline, calls } = setupWithState(new Error("bridge down"));
		await pipeline.land({ issue, confirmed: true, journalSnapshot: "x" });
		expect(calls).toEqual(["comment", "worktree", "status", "card"]);
	});

	it("a half-landed re-run (Codex R2) skips the comment and reuses the worktree", async () => {
		const ledger = new Map<
			string,
			{ commented?: boolean; worktreePath?: string }
		>();
		const calls: string[] = [];
		const make = (worktreeFail: boolean) =>
			new ConclusionPipeline({
				linear: {
					comment: async () => {
						calls.push("comment");
					},
					setStatus: async () => {
						calls.push("status");
					},
				},
				worktree: {
					create: async () => {
						calls.push("worktree");
						if (worktreeFail) throw new Error("dirty");
						return { path: "/tmp/wt-resume" };
					},
				},
				summarize: async () => "## 结论",
				tiv: { card: async () => {}, warn: () => {} },
				mainRepoPath: "/tmp/repo",
				projectName: "flywheel",
				progressStore: {
					load: (id) => ledger.get(id),
					save: (id, p) => void ledger.set(id, { ...p }),
				},
			});

		// first run: comment lands, worktree fails → partial landing
		expect(
			await make(true).land({ issue, confirmed: true, journalSnapshot: "x" }),
		).toBe("failed");
		expect(calls).toEqual(["comment", "worktree"]);
		// resume: comment SKIPPED (ledger), worktree retried, Done + card follow
		calls.length = 0;
		expect(
			await make(false).land({ issue, confirmed: true, journalSnapshot: "x" }),
		).toBe("landed");
		expect(calls).toEqual(["worktree", "status"]);
		// third run with worktree recorded too: nothing repeats but the flip
		calls.length = 0;
		expect(
			await make(false).land({ issue, confirmed: true, journalSnapshot: "x" }),
		).toBe("landed");
		expect(calls).toEqual(["status"]);
	});
});

describe("abortNoShow", () => {
	it("comments + closes; a failure warns instead of throwing", async () => {
		const { pipeline, calls, comments } = setup();
		await pipeline.abortNoShow(issue);
		expect(calls).toEqual(["comment", "status"]);
		expect(comments[0]?.body).toContain("未开成");

		const failing = setup({ commentFail: true });
		await failing.pipeline.abortNoShow(issue); // must not throw
		expect(failing.warns[0]).toContain("人工");
	});
});
