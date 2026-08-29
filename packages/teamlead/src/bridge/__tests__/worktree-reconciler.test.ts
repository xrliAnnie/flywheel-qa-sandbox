import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	buildProtectedKeys,
	classifyWorktreeLiveness,
	isUnder,
	type LivenessDeps,
	type ReconcileDeps,
	reconcileMergedWorktrees,
} from "../worktree-reconciler.js";

const MAIN = "/Users/x/Dev/flywheel";
const PARENT = "/Users/x/Dev";

function session(p: Partial<Session>): Session {
	return {
		execution_id: "e1",
		issue_id: "FLY-603",
		project_name: "flywheel",
		status: "running",
		...p,
	} as Session;
}

// a tiny WorktreeManager stand-in with the real key parsing semantics
const wm = {
	parseWorktreeKeyFromBranch(_main: string, branch: string | null) {
		if (!branch) return null;
		return branch.startsWith("flywheel-")
			? branch.slice("flywheel-".length)
			: null;
	},
	parseWorktreeKeyFromPath(_main: string, _proj: string, p: string) {
		const base = p.split("/").pop() ?? "";
		return base.startsWith("flywheel-") ? base.slice("flywheel-".length) : null;
	},
};

function wt(over: Partial<ReturnType<typeof mkWt>> = {}) {
	return { ...mkWt(), ...over };
}
function mkWt() {
	return {
		path: "/Users/x/Dev/flywheel-FLY-700",
		branch: "flywheel-FLY-700",
		head: "headsha700",
		isDetached: false,
		isBare: false,
	};
}

describe("FLY-603 isUnder (path-boundary, not startsWith)", () => {
	it("FLY-60 does NOT match FLY-603 (the prefix footgun)", () => {
		expect(isUnder("/d/flywheel-FLY-60", "/d/flywheel-FLY-603")).toBe(false);
	});
	it("real child is under", () => {
		expect(
			isUnder("/d/flywheel-FLY-603", "/d/flywheel-FLY-603/worktrees/qa"),
		).toBe(true);
	});
	it("sibling under parent dir", () => {
		expect(isUnder(PARENT, "/Users/x/Dev/flywheel-FLY-603")).toBe(true);
	});
});

describe("FLY-603 buildProtectedKeys (path-authoritative + fail-closed)", () => {
	it("uses worktree_path key, not issue metadata (uuid != identifier)", () => {
		const rows = [
			session({
				issue_id: "uuid-123",
				issue_identifier: "FLY-603",
				session_role: "qa",
				worktree_path: "/Users/x/Dev/flywheel-uuid-123-qa",
			}),
		];
		const keys = buildProtectedKeys(wm, MAIN, "flywheel", rows);
		expect(keys.has("uuid-123-qa")).toBe(true);
		expect(keys.has("FLY-603-qa")).toBe(false); // NOT the identifier-derived key
	});
	it("no path + id != identifier → protects BOTH derived keys", () => {
		const rows = [
			session({
				issue_id: "uuid-9",
				issue_identifier: "FLY-9",
				session_role: "main",
				worktree_path: undefined,
			}),
		];
		const keys = buildProtectedKeys(wm, MAIN, "flywheel", rows);
		expect(keys.has("uuid-9")).toBe(true);
		expect(keys.has("FLY-9")).toBe(true);
	});
});

describe("FLY-603 classifyWorktreeLiveness (tri-state + pathless fallback)", () => {
	const base = (over: Partial<LivenessDeps>): LivenessDeps => ({
		projectName: "flywheel",
		mainRepoPath: MAIN,
		sessions: [],
		worktreeManager: wm,
		lookupTmuxTarget: () => ({ kind: "gone" }),
		probeTmuxWindowLiveness: async () => "dead",
		...over,
	});

	it("exact-path session with live tmux → live", async () => {
		const deps = base({
			sessions: [session({ execution_id: "x", worktree_path: mkWt().path })],
			lookupTmuxTarget: () => ({
				kind: "found",
				target: { tmuxWindow: "w:1" },
			}),
			probeTmuxWindowLiveness: async () => "alive",
		});
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("live");
	});
	it("pathless session (NULL worktree_path) with live tmux → live (R4 fallback)", async () => {
		const deps = base({
			sessions: [
				session({
					execution_id: "x",
					issue_identifier: "FLY-700",
					worktree_path: undefined,
				}),
			],
			lookupTmuxTarget: () => ({
				kind: "found",
				target: { tmuxWindow: "w:1" },
			}),
			probeTmuxWindowLiveness: async () => "alive",
		});
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("live");
	});
	it("CommDB read error → unknown (not dead)", async () => {
		const deps = base({
			sessions: [session({ execution_id: "x", worktree_path: mkWt().path })],
			lookupTmuxTarget: () => ({ kind: "error", error: "locked" }),
		});
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("unknown");
	});
	it("tmux probe indeterminate → unknown", async () => {
		const deps = base({
			sessions: [session({ execution_id: "x", worktree_path: mkWt().path })],
			lookupTmuxTarget: () => ({
				kind: "found",
				target: { tmuxWindow: "w:1" },
			}),
			probeTmuxWindowLiveness: async () => "indeterminate",
		});
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("unknown");
	});
	it("gone + dead probe → dead", async () => {
		const deps = base({
			sessions: [session({ execution_id: "x", worktree_path: mkWt().path })],
			lookupTmuxTarget: () => ({ kind: "gone" }),
		});
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("dead");
	});
	it("multiple same-key candidates ALL provably dead → dead (additive, every positively dead)", async () => {
		const deps = base({
			sessions: [
				session({ execution_id: "a", issue_identifier: "FLY-700" }),
				session({ execution_id: "b", issue_identifier: "FLY-700" }),
			],
			// base lookupTmuxTarget → gone → both provably dead
		});
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("dead");
	});

	it("multiple same-key candidates, one indeterminate → unknown (ambiguous, not all dead)", async () => {
		const deps = base({
			sessions: [
				session({ execution_id: "a", issue_identifier: "FLY-700" }),
				session({ execution_id: "b", issue_identifier: "FLY-700" }),
			],
			lookupTmuxTarget: (execId) =>
				execId === "b"
					? { kind: "found", target: { tmuxWindow: "w:1" } }
					: { kind: "gone" },
			probeTmuxWindowLiveness: async () => "indeterminate",
		});
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("unknown");
	});

	it("ADDITIVE (Codex HIGH-1): exact-path DEAD + pathless same-key LIVE → live, not dead", async () => {
		const deps = base({
			sessions: [
				// stale exact-path session, tmux gone (dead)
				session({
					execution_id: "stale",
					worktree_path: mkWt().path,
				}),
				// newer same-key session that never persisted worktree_path, tmux live
				session({
					execution_id: "live",
					issue_identifier: "FLY-700",
					worktree_path: undefined,
				}),
			],
			lookupTmuxTarget: (execId) =>
				execId === "live"
					? { kind: "found", target: { tmuxWindow: "w:1" } }
					: { kind: "gone" },
			probeTmuxWindowLiveness: async () => "alive",
		});
		// pre-fix this returned "dead" (exact-only) and would delete a live runner
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("live");
	});

	it("ADDITIVE: exact-path DEAD + pathless same-key INDETERMINATE → unknown", async () => {
		const deps = base({
			sessions: [
				session({ execution_id: "stale", worktree_path: mkWt().path }),
				session({
					execution_id: "x",
					issue_identifier: "FLY-700",
					worktree_path: undefined,
				}),
			],
			lookupTmuxTarget: (execId) =>
				execId === "x"
					? { kind: "found", target: { tmuxWindow: "w:1" } }
					: { kind: "gone" },
			probeTmuxWindowLiveness: async () => "indeterminate",
		});
		expect(await classifyWorktreeLiveness(wt(), deps)).toBe("unknown");
	});
});

describe("FLY-603 reconcileMergedWorktrees (deletion contract)", () => {
	function baseDeps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
		return {
			mainRepoPath: MAIN,
			projectName: "flywheel",
			repoSlug: "flywheel",
			siblingParent: PARENT,
			protectedKeys: new Set(),
			worktreeManager: {
				list: async () => [wt()],
				parseWorktreeKeyFromBranch: wm.parseWorktreeKeyFromBranch,
				parseWorktreeKeyFromPath: wm.parseWorktreeKeyFromPath,
				removeRegisteredWorktree: vi.fn(async () => ({
					removed: true,
					branchDeleted: true,
				})),
			},
			probeLiveRunner: async () => "dead",
			isWorktreeClean: async () => true,
			hasOpenPr: () => false,
			isMergedHead: () => true,
			isAncestorOfMain: async () => false,
			audit: () => {},
			...over,
		};
	}

	it("dead + clean + merged + non-protected → removed", async () => {
		const deps = baseDeps();
		const removed = await reconcileMergedWorktrees(deps);
		expect(removed).toEqual([mkWt().path]);
		expect(deps.worktreeManager.removeRegisteredWorktree).toHaveBeenCalled();
	});
	it("live → retained", async () => {
		const deps = baseDeps({ probeLiveRunner: async () => "live" });
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});
	it("unknown liveness → retained (fail-closed)", async () => {
		const deps = baseDeps({ probeLiveRunner: async () => "unknown" });
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});
	it("dirty → retained", async () => {
		const deps = baseDeps({ isWorktreeClean: async () => false });
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});
	it("clean probe error (unknown) → retained", async () => {
		const deps = baseDeps({ isWorktreeClean: async () => "unknown" });
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});
	it("open PR → retained", async () => {
		const deps = baseDeps({ hasOpenPr: () => true });
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});
	it("gh open-pr unknown → retained (fail-closed)", async () => {
		const deps = baseDeps({ hasOpenPr: () => "unknown" });
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});
	it("no merge evidence → retained", async () => {
		const deps = baseDeps({
			isMergedHead: () => false,
			isAncestorOfMain: async () => false,
		});
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});
	it("ancestor-of-main alone (squash branch not headRefOid-matched) → removed", async () => {
		const deps = baseDeps({
			isMergedHead: () => false,
			isAncestorOfMain: async () => true,
		});
		expect(await reconcileMergedWorktrees(deps)).toEqual([mkWt().path]);
	});
	it("protected key → retained", async () => {
		const deps = baseDeps({ protectedKeys: new Set(["FLY-700"]) });
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});
	it("nested-parent (contains another worktree) → retained", async () => {
		const parent = wt();
		const child = wt({
			path: `${parent.path}/worktrees/qa`,
			branch: "flywheel-FLY-700-qa",
		});
		const deps = baseDeps({
			worktreeManager: {
				list: async () => [parent, child],
				parseWorktreeKeyFromBranch: wm.parseWorktreeKeyFromBranch,
				parseWorktreeKeyFromPath: wm.parseWorktreeKeyFromPath,
				removeRegisteredWorktree: vi.fn(async () => ({
					removed: true,
					branchDeleted: true,
				})),
			},
		});
		const removed = await reconcileMergedWorktrees(deps);
		expect(removed).not.toContain(parent.path); // parent retained (has nested child)
	});
	it("branchless/detached worktree → skipped", async () => {
		const deps = baseDeps({
			worktreeManager: {
				list: async () => [wt({ branch: null })],
				parseWorktreeKeyFromBranch: wm.parseWorktreeKeyFromBranch,
				parseWorktreeKeyFromPath: wm.parseWorktreeKeyFromPath,
				removeRegisteredWorktree: vi.fn(async () => ({
					removed: true,
					branchDeleted: true,
				})),
			},
		});
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
	});

	it("non-canonical managed path (branch prefix matches but path-key != branch-key) → retained (Codex R2 HIGH)", async () => {
		const rogue = wt({
			path: "/Users/x/Dev/not-a-managed-FLY-700",
			branch: "flywheel-FLY-700",
		});
		const deps = baseDeps({
			worktreeManager: {
				list: async () => [rogue],
				parseWorktreeKeyFromBranch: wm.parseWorktreeKeyFromBranch,
				parseWorktreeKeyFromPath: wm.parseWorktreeKeyFromPath,
				removeRegisteredWorktree: vi.fn(async () => ({
					removed: true,
					branchDeleted: true,
				})),
			},
		});
		expect(await reconcileMergedWorktrees(deps)).toEqual([]);
		expect(
			deps.worktreeManager.removeRegisteredWorktree,
		).not.toHaveBeenCalled();
	});
});
