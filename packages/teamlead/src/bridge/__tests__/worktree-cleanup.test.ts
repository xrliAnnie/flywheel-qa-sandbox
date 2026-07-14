import { describe, expect, it, vi } from "vitest";
import {
	makeWorktreeCleanup,
	type WorktreeCleanupDeps,
} from "../worktree-cleanup.js";

const ROOT = "/Users/x/Dev/flywheel";

function deps(over: Partial<WorktreeCleanupDeps> = {}): {
	d: WorktreeCleanupDeps;
	events: Array<{ type: string; payload: Record<string, unknown> }>;
	remove: ReturnType<typeof vi.fn>;
} {
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const remove = vi.fn(async () => ({ removed: true, branchDeleted: true }));
	const d: WorktreeCleanupDeps = {
		store: {
			getSession: () =>
				({
					execution_id: "e1",
					worktree_path: "/Users/x/Dev/flywheel-FLY-603",
					branch: "flywheel-FLY-603",
				}) as never,
			insertEvent: (e: { event_type: string; payload?: unknown }) => {
				events.push({
					type: e.event_type,
					payload: (e.payload ?? {}) as Record<string, unknown>,
				});
				return true;
			},
			// FLY-1185: legacy pre-binding session → no binding (bindingVerified
			// stays false, removal keeps the session-scoped path — R7 semantics).
			getWorktreeBinding: () => undefined,
		} as never,
		worktreeManager: {
			expectedWorktree: (_r, _p, key) => ({
				path: `/Users/x/Dev/flywheel-${key}`,
				branch: `flywheel-${key}`,
			}),
			parseWorktreeKeyFromPath: (_r, _p, path) => {
				const base = path.split("/").pop() ?? "";
				return base.startsWith("flywheel-")
					? base.slice("flywheel-".length)
					: null;
			},
			getRegisteredWorktree: async (_r, p) => ({
				path: p,
				branch: `flywheel-${p.split("/").pop()?.slice("flywheel-".length)}`,
				head: "h",
				isDetached: false,
				isBare: false,
			}),
			removeCleanWorktreeByPath: remove,
			// FLY-1185: marker read only happens when a binding exists.
			readWorktreeGeneration: async () => undefined,
		} as never,
		resolveProjectRoot: () => ROOT,
		isWorktreeClean: async () => true,
		autoclean: true,
		...over,
	};
	return { d, events, remove };
}

const input = {
	executionId: "e1",
	issueId: "FLY-603",
	issueIdentifier: "FLY-603",
	projectName: "flywheel",
	tmuxClosed: true,
	tmuxErrors: [] as string[],
};

describe("FLY-603 Layer A worktree cleanup", () => {
	it("positive tmux close + clean → removes by persisted worktree_path", async () => {
		const { d, events, remove } = deps();
		// Codex R1#9: the local ref now goes through the CAS primitive with the
		// attested head — the worktree removal itself passes branch=null.
		const cas = vi.fn(async () => ({ deleted: true }) as never);
		await makeWorktreeCleanup({ ...d, casDeleteLocalBranchFn: cas as never })(
			input,
		);
		expect(remove).toHaveBeenCalledWith(
			ROOT,
			"/Users/x/Dev/flywheel-FLY-603",
			null,
		);
		expect(cas).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "flywheel-FLY-603" }),
		);
		expect(events.map((e) => e.type)).toContain("worktree_cleanup_done");
	});

	it("tmux NOT positively closed (tmuxClosed=false, errors empty) → skip", async () => {
		const { d, events, remove } = deps();
		await makeWorktreeCleanup(d)({ ...input, tmuxClosed: false });
		expect(remove).not.toHaveBeenCalled();
		expect(events[0]?.payload.reason).toBe("tmux_not_confirmed_closed");
	});

	it("tmux errors present → skip", async () => {
		const { d, remove } = deps();
		await makeWorktreeCleanup(d)({ ...input, tmuxErrors: ["boom"] });
		expect(remove).not.toHaveBeenCalled();
	});

	it("dirty tree → skip + audit dirty", async () => {
		const { d, events, remove } = deps({ isWorktreeClean: async () => false });
		await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
		expect(
			events.find((e) => e.type === "worktree_cleanup_skipped")?.payload.reason,
		).toBe("dirty");
	});

	it("clean probe unknown → skip (fail-closed)", async () => {
		const { d, remove } = deps({ isWorktreeClean: async () => "unknown" });
		await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
	});

	it("autoclean disabled → no-op", async () => {
		const { d, remove } = deps({ autoclean: false });
		await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
	});

	it("path that does not parse to a project worktree key → skip path_mismatch", async () => {
		const { d, events, remove } = deps({
			store: {
				getSession: () =>
					({ worktree_path: "/totally/unrelated/path", branch: "x" }) as never,
				insertEvent: () => true,
			} as never,
		});
		// re-bind events capture
		const captured: string[] = [];
		(
			d.store as { insertEvent: (e: { event_type: string }) => boolean }
		).insertEvent = (e) => {
			captured.push(e.event_type);
			return true;
		};
		await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
		expect(captured).toContain("worktree_cleanup_skipped");
		void events;
	});

	it("registered worktree branchless → skip (HIGH-2)", async () => {
		const { d, remove } = deps({
			worktreeManager: {
				expectedWorktree: (_r: string, _p: string, key: string) => ({
					path: `/Users/x/Dev/flywheel-${key}`,
					branch: `flywheel-${key}`,
				}),
				parseWorktreeKeyFromPath: (_r: string, _p: string, p: string) =>
					p.split("/").pop()?.slice("flywheel-".length) ?? null,
				getRegisteredWorktree: async (_r: string, p: string) => ({
					path: p,
					branch: null,
					head: "h",
					isDetached: false,
					isBare: false,
				}),
				removeCleanWorktreeByPath: vi.fn(),
			} as never,
		});
		await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
	});

	it("registered worktree detached → skip (HIGH-2)", async () => {
		const { d, remove } = deps({
			worktreeManager: {
				expectedWorktree: (_r: string, _p: string, key: string) => ({
					path: `/Users/x/Dev/flywheel-${key}`,
					branch: `flywheel-${key}`,
				}),
				parseWorktreeKeyFromPath: (_r: string, _p: string, p: string) =>
					p.split("/").pop()?.slice("flywheel-".length) ?? null,
				getRegisteredWorktree: async (_r: string, p: string) => ({
					path: p,
					branch: "flywheel-FLY-603",
					head: "h",
					isDetached: true,
					isBare: false,
				}),
				removeCleanWorktreeByPath: vi.fn(),
			} as never,
		});
		await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
	});

	it("registered branch != expected (reused path) → skip (HIGH-2)", async () => {
		const { d, remove } = deps({
			worktreeManager: {
				expectedWorktree: (_r: string, _p: string, key: string) => ({
					path: `/Users/x/Dev/flywheel-${key}`,
					branch: `flywheel-${key}`,
				}),
				parseWorktreeKeyFromPath: (_r: string, _p: string, p: string) =>
					p.split("/").pop()?.slice("flywheel-".length) ?? null,
				getRegisteredWorktree: async (_r: string, p: string) => ({
					path: p,
					branch: "some-other-branch",
					head: "h",
					isDetached: false,
					isBare: false,
				}),
				removeCleanWorktreeByPath: vi.fn(),
			} as never,
		});
		await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
	});

	it("not registered at the exact path → skip (HIGH-2)", async () => {
		const { d, remove } = deps({
			worktreeManager: {
				expectedWorktree: (_r: string, _p: string, key: string) => ({
					path: `/Users/x/Dev/flywheel-${key}`,
					branch: `flywheel-${key}`,
				}),
				parseWorktreeKeyFromPath: (_r: string, _p: string, p: string) =>
					p.split("/").pop()?.slice("flywheel-".length) ?? null,
				getRegisteredWorktree: async () => null,
				removeCleanWorktreeByPath: vi.fn(),
			} as never,
		});
		await makeWorktreeCleanup(d)(input);
		expect(remove).not.toHaveBeenCalled();
	});

	it("falls back to expectedWorktree when session has no worktree_path", async () => {
		const { d, remove } = deps({
			store: {
				getSession: () => ({ session_role: "main" }) as never,
				insertEvent: () => true,
				getWorktreeBinding: () => undefined,
			} as never,
		});
		const cas = vi.fn(async () => ({ deleted: true }) as never);
		await makeWorktreeCleanup({ ...d, casDeleteLocalBranchFn: cas as never })(
			input,
		);
		// derived from issueIdentifier FLY-603 → flywheel-FLY-603; the branch
		// deletion itself is the CAS primitive (Codex R1#9), not `branch -D`.
		expect(remove).toHaveBeenCalledWith(
			ROOT,
			"/Users/x/Dev/flywheel-FLY-603",
			null,
		);
		expect(cas).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "flywheel-FLY-603" }),
		);
	});
});
