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

const operationInput = {
	issueId: "issue-2616",
	projectName: "flywheel",
	tmuxClosed: true,
	tmuxErrors: [] as string[],
	operationContext: {
		operationAudit: {
			operationId: "land:2616",
			ownerId: "land-worker",
			generation: 2,
			runId: "run-2616",
			sourceExecutionId: null,
		},
		target: {
			kind: "bound_worktree" as const,
			path: "/Users/x/Dev/flywheel-FLY-2602",
			branch: "flywheel-FLY-2602",
			generation: "generation-1",
			projectRoot: ROOT,
			parentIdentity: { path: "/Users/x/Dev", dev: 7, ino: 11 },
			sourceExecutionIds: ["implement-deleted"],
			sourceRunId: "run-2616",
			sourceReceipt: "state_session_binding:implement-deleted:generation-1",
		},
	},
};

function operationDepsForLeaf(
	leaf: "missing" | "eacces" | "symlink" | "directory",
) {
	return deps({
		store: {
			getSession: () => undefined,
			getWorktreeBinding: () => undefined,
			insertEvent: vi.fn(),
			getLandOperation: () => ({ closeout_reservation_epoch: 1 }),
			recordLandOperationStep: vi.fn(() => ({
				ok: true as const,
				idempotentReplay: false,
			})),
		} as never,
		resolveProjectRoot: () => ROOT,
		...({
			realpath: async (path: string) => path,
			lstat: async (path: string) => {
				if (path === "/Users/x/Dev") {
					return {
						dev: 7,
						ino: 11,
						isDirectory: () => true,
						isSymbolicLink: () => false,
					};
				}
				if (path === ROOT) {
					return {
						dev: 7,
						ino: 12,
						isDirectory: () => true,
						isSymbolicLink: () => false,
					};
				}
				if (leaf === "missing") {
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				}
				if (leaf === "eacces") {
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				}
				return {
					dev: 7,
					ino: 13,
					isDirectory: () => leaf === "directory",
					isSymbolicLink: () => leaf === "symlink",
				};
			},
		} as never),
	});
}

describe("FLY-603 Layer A worktree cleanup", () => {
	it("FLY-2616: a verified bound target with an absent leaf is already cleaned", async () => {
		const recordLandOperationStep = vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		}));
		const { d, remove } = deps({
			store: {
				getSession: () => undefined,
				getWorktreeBinding: () => undefined,
				insertEvent: vi.fn(),
				getLandOperation: () => ({ closeout_reservation_epoch: 1 }),
				recordLandOperationStep,
			} as never,
			resolveProjectRoot: () => ROOT,
			...({
				realpath: async (path: string) => path,
				lstat: async (path: string) => {
					if (path === "/Users/x/Dev") {
						return {
							dev: 7,
							ino: 11,
							isDirectory: () => true,
							isSymbolicLink: () => false,
						};
					}
					if (path === ROOT) {
						return {
							dev: 7,
							ino: 12,
							isDirectory: () => true,
							isSymbolicLink: () => false,
						};
					}
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				},
			} as never),
		});

		const attestation = await makeWorktreeCleanup(d)(operationInput as never);

		expect(attestation).toMatchObject({
			cleanupState: "absent",
			removed: false,
			bindingVerified: false,
			absentEvidence: {
				path: "/Users/x/Dev/flywheel-FLY-2602",
				bindingGeneration: "generation-1",
				operationId: "land:2616",
			},
		});
		expect(remove).not.toHaveBeenCalled();
		expect(recordLandOperationStep).toHaveBeenCalled();
	});

	it("FLY-2616: permission errors are not absence proof", async () => {
		const { d, remove } = operationDepsForLeaf("eacces");
		const attestation = await makeWorktreeCleanup(d)(operationInput as never);

		expect(attestation).toMatchObject({
			cleanupState: "blocked",
			skippedReason: "leaf_unavailable",
		});
		expect(attestation.absentEvidence).toBeUndefined();
		expect(remove).not.toHaveBeenCalled();
	});

	it("FLY-2616: an unavailable frozen parent blocks absence proof", async () => {
		const { d, remove } = operationDepsForLeaf("missing");
		d.realpath = vi.fn(async (path: string) => {
			if (path === "/Users/x/Dev") {
				throw Object.assign(new Error("parent missing"), { code: "ENOENT" });
			}
			return path;
		}) as never;

		const attestation = await makeWorktreeCleanup(d)(operationInput as never);

		expect(attestation).toMatchObject({
			cleanupState: "blocked",
			skippedReason: "parent_unavailable",
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it("FLY-2616: a symlink at the frozen leaf is not absence proof", async () => {
		const { d, remove } = operationDepsForLeaf("symlink");
		const attestation = await makeWorktreeCleanup(d)(operationInput as never);

		expect(attestation).toMatchObject({
			cleanupState: "blocked",
			skippedReason: "leaf_identity_mismatch",
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it("FLY-2616: an existing but unregistered leaf remains blocked", async () => {
		const { d, remove } = operationDepsForLeaf("directory");
		d.worktreeManager.getRegisteredWorktree = vi.fn(async () => null);

		const attestation = await makeWorktreeCleanup(d)(operationInput as never);

		expect(attestation).toMatchObject({
			cleanupState: "blocked",
			skippedReason: "not_registered",
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it("FLY-2616: a recreated leaf with the wrong generation remains blocked", async () => {
		const { d, remove } = operationDepsForLeaf("directory");
		d.worktreeManager.readWorktreeGeneration = vi.fn(
			async () => "generation-recreated",
		);

		const attestation = await makeWorktreeCleanup(d)(operationInput as never);

		expect(attestation).toMatchObject({
			cleanupState: "blocked",
			skippedReason: "binding_mismatch",
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it("FLY-1759 carries reap evidence and emits an incomplete audit event", async () => {
		const { d, events, remove } = deps();
		const reaps = [
			{
				path: "/Users/x/Dev/flywheel-FLY-603",
				summary: {
					matched: 2,
					reaped: [101],
					survivors: [102],
					verified: false,
					identityMismatchSkipped: 0,
					verifyError: "survivor",
				},
			},
		];
		remove.mockResolvedValue({
			removed: true,
			branchDeleted: false,
			reaps,
		});
		const attestation = await makeWorktreeCleanup({
			...d,
			casDeleteLocalBranchFn: vi.fn(async () => ({ deleted: true }) as never),
		})(input);

		expect(attestation.reaps).toEqual(reaps);
		expect(
			events.find((event) => event.type === "worktree_cleanup_done")?.payload
				.reaps,
		).toEqual(reaps);
		expect(events.map((event) => event.type)).toContain(
			"worktree_reap_incomplete",
		);
		expect(
			events.find((event) => event.type === "worktree_reap_incomplete")
				?.payload,
		).toMatchObject({
			path: reaps[0]!.path,
			summary: reaps[0]!.summary,
		});
	});

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
			lstat: vi.fn(async () => ({
				isDirectory: () => true,
				isSymbolicLink: () => false,
			})) as never,
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
		const attestation = await makeWorktreeCleanup(d)(input);
		expect(attestation).toMatchObject({
			cleanupState: "blocked",
			skippedReason: "not_registered",
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it("FLY-2616: an unregistered legacy path is absent only after ENOENT proof", async () => {
		const { d, events, remove } = deps({
			lstat: vi.fn(async () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			}) as never,
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

		const attestation = await makeWorktreeCleanup(d)(input);

		expect(attestation).toMatchObject({
			removed: false,
			cleanupState: "absent",
			bindingVerified: false,
		});
		expect(events).toContainEqual({
			type: "worktree_cleanup_absent",
			payload: expect.objectContaining({
				worktreePath: "/Users/x/Dev/flywheel-FLY-603",
			}),
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it("FLY-2616: ENOENT at the expected legacy path is absence proof", async () => {
		const { d, remove } = deps({
			store: {
				getSession: () => ({ session_role: "main" }) as never,
				insertEvent: () => true,
				getWorktreeBinding: () => undefined,
			} as never,
			lstat: vi.fn(async () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			}) as never,
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

		const attestation = await makeWorktreeCleanup(d)(input);

		expect(attestation).toMatchObject({
			removed: false,
			cleanupState: "absent",
			bindingVerified: false,
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it.each([
		["symlink", true, false],
		["non-directory", false, false],
	])(
		"FLY-2616: an unregistered legacy %s remains blocked",
		async (_label, isSymbolicLink, isDirectory) => {
			const { d, remove } = deps();
			d.worktreeManager.getRegisteredWorktree = vi.fn(async () => null);
			d.lstat = vi.fn(async () => ({
				isDirectory: () => isDirectory,
				isSymbolicLink: () => isSymbolicLink,
			})) as never;

			const attestation = await makeWorktreeCleanup(d)(input);

			expect(attestation).toMatchObject({
				cleanupState: "blocked",
				skippedReason: "not_registered",
			});
			expect(remove).not.toHaveBeenCalled();
		},
	);

	it("FLY-2616: an unregistered legacy permission error remains blocked", async () => {
		const { d, remove } = deps();
		d.worktreeManager.getRegisteredWorktree = vi.fn(async () => null);
		d.lstat = vi.fn(async () => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		}) as never;

		const attestation = await makeWorktreeCleanup(d)(input);

		expect(attestation).toMatchObject({
			cleanupState: "blocked",
			skippedReason: "leaf_unavailable",
		});
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
