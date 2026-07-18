import { describe, expect, it, vi } from "vitest";
import { classifyRetestHeadDelta } from "../retest-head-delta.js";

const OLD = "a".repeat(40);
const HEAD = "b".repeat(40);

describe("FLY-1314 exact-range retest head delta", () => {
	it("suppresses the identical head without invoking git", async () => {
		const git = vi.fn();
		await expect(
			classifyRetestHeadDelta({
				worktreePath: "/worktree",
				verdictHead: OLD,
				currentHead: OLD,
				git,
			}),
		).resolves.toEqual({ kind: "suppress", reason: "no_head_delta" });
		expect(git).not.toHaveBeenCalled();
	});

	it("classifies only verdictHead..currentHead so an older code delta cannot contaminate docs-only", async () => {
		const git = vi.fn(async (_cwd: string, args: string[]) => {
			if (args[0] === "merge-base") return "";
			return "engineering/doc/FLY-1314/qa.md\n";
		});
		await expect(
			classifyRetestHeadDelta({
				worktreePath: "/worktree",
				verdictHead: OLD,
				currentHead: HEAD,
				git,
			}),
		).resolves.toEqual({
			kind: "suppress",
			reason: "docs_only_delta",
			paths: ["engineering/doc/FLY-1314/qa.md"],
		});
		expect(git).toHaveBeenLastCalledWith("/worktree", [
			"diff",
			"--name-only",
			`${OLD}..${HEAD}`,
		]);
	});

	it("retests mixed/product deltas", async () => {
		const git = vi.fn(async (_cwd: string, args: string[]) =>
			args[0] === "merge-base"
				? ""
				: "engineering/doc/FLY-1314/qa.md\npackages/teamlead/src/x.ts\n",
		);
		await expect(
			classifyRetestHeadDelta({
				worktreePath: "/worktree",
				verdictHead: OLD,
				currentHead: HEAD,
				git,
			}),
		).resolves.toMatchObject({ kind: "retest", reason: "product_delta" });
	});

	it("fails open to retest on non-ancestor, invalid sha, or git failure", async () => {
		for (const git of [
			vi.fn(async () => {
				throw new Error("non-ancestor");
			}),
			vi.fn(async () => {
				throw new Error("git unavailable");
			}),
		]) {
			await expect(
				classifyRetestHeadDelta({
					worktreePath: "/worktree",
					verdictHead: OLD,
					currentHead: HEAD,
					git,
				}),
			).resolves.toEqual({ kind: "retest", reason: "unknown" });
		}
		await expect(
			classifyRetestHeadDelta({
				worktreePath: "/worktree",
				verdictHead: "short",
				currentHead: HEAD,
				git: vi.fn(),
			}),
		).resolves.toEqual({ kind: "retest", reason: "unknown" });
	});
});
