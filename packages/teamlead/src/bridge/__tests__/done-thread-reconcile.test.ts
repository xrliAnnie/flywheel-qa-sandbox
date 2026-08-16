/**
 * FLY-1165: done-thread reconcile sweep — the structural backstop for the four
 * archive-cascade leak classes (terminate-only / husk-block / never-closed /
 * blocked-preserve). Safety contract under test:
 *   - double gate: fresh Linear Done/Canceled AND no live runner;
 *   - triple veto: cheap pre-check / post-Linear / post-finalize (right before
 *     archive) — every slow await is followed by a liveness recheck;
 *   - fail-closed everywhere: lookup error / probe throw / indeterminate /
 *     terminal-status-but-alive all count as LIVE; finalize failure skips the
 *     whole thread; ambiguous project resolution skips.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import type { ArchiveChatThreadResult } from "../chat-thread-utils.js";
import {
	type DoneThreadReconcileDeps,
	RECONCILE_FINALIZABLE_STATUSES,
	reconcileDoneThreads,
	resolveDoneThreadReconcileConfig,
	startDoneThreadReconcileScheduler,
} from "../done-thread-reconcile.js";

const PROJECT = {
	projectName: "flywheel",
	projectRoot: "/tmp/fw",
	leads: [
		{
			agentId: "tadashi",
			chatChannel: "ch-eng",
			match: { labels: ["Flywheel"] },
			botToken: "tok-tadashi",
		},
	],
} as unknown as ProjectEntry;

const OK_ARCHIVE: ArchiveChatThreadResult = {
	archived: true,
	attempts: 1,
	status: 200,
	reason: "ok",
};

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function seedSession(
	store: StateStore,
	o: {
		execution_id: string;
		issue_id: string;
		issue_identifier?: string;
		status?: string;
	},
): void {
	store.upsertSession({
		execution_id: o.execution_id,
		issue_id: o.issue_id,
		issue_identifier: o.issue_identifier,
		project_name: "flywheel",
		status: o.status ?? "completed",
		issue_labels: JSON.stringify(["Flywheel"]),
	});
}

/** Baseline deps: Done issue, everything dead, real in-memory store. */
function makeDeps(
	store: StateStore,
	over: Partial<DoneThreadReconcileDeps> = {},
): DoneThreadReconcileDeps & {
	archiveFn: ReturnType<typeof vi.fn>;
	closeRunnerFn: ReturnType<typeof vi.fn>;
	lookupIssue: ReturnType<typeof vi.fn>;
} {
	const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
	const closeRunnerFn = vi
		.fn()
		.mockResolvedValue({ closed: true, alreadyGone: false });
	const lookupIssue = vi.fn(async (_key: string, id: string) => ({
		id: `uuid-${id}`,
		identifier: id,
		stateType: "completed",
	}));
	return {
		store,
		projects: [PROJECT],
		linearApiKey: "test-linear-key",
		transitionOpts: {} as DoneThreadReconcileDeps["transitionOpts"],
		lookupIssue,
		archiveFn,
		closeRunnerFn,
		lookupTarget: () => ({ kind: "gone" }) as const,
		probeLiveness: async () => "absent" as const,
		sleepImpl: async () => {},
		log: () => {},
		...over,
		// keep the named mocks accessible even when overridden
	} as DoneThreadReconcileDeps & {
		archiveFn: ReturnType<typeof vi.fn>;
		closeRunnerFn: ReturnType<typeof vi.fn>;
		lookupIssue: ReturnType<typeof vi.fn>;
	};
}

describe("reconcileDoneThreads (FLY-1165)", () => {
	it("1. Done + no session → archives + marks archived_at; second run has no candidates (idempotent)", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-1", "tadashi");
		const deps = makeDeps(store);
		const r1 = await reconcileDoneThreads(deps);
		expect(r1.archived).toBe(1);
		expect(store.isChatThreadArchived("t-1")).toBe(true);
		const r2 = await reconcileDoneThreads(deps);
		expect(r2.scanned).toBe(0);
		expect(deps.archiveFn).toHaveBeenCalledTimes(1);
	});

	it("2. Canceled → archives", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-2", "tadashi");
		const deps = makeDeps(store, {
			lookupIssue: vi.fn(async (_k: string, id: string) => ({
				id: `uuid-${id}`,
				identifier: id,
				stateType: "canceled",
			})),
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.archived).toBe(1);
	});

	it("3. Linear active → skippedNotDone, archiveFn never called", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-3", "tadashi");
		const deps = makeDeps(store, {
			lookupIssue: vi.fn(async (_k: string, id: string) => ({
				id: `uuid-${id}`,
				identifier: id,
				stateType: "started",
			})),
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedNotDone).toBe(1);
		expect(r.archived).toBe(0);
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("4. lookupIssue null / throw → skippedUnresolved; later threads still processed", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-a", "ch-eng", "FLY-4", "tadashi");
		store.upsertChatThread("t-b", "ch-eng", "FLY-5", "tadashi");
		store.upsertChatThread("t-c", "ch-eng", "FLY-6", "tadashi");
		const deps = makeDeps(store, {
			lookupIssue: vi.fn(async (_k: string, id: string) => {
				if (id === "FLY-4") return null;
				if (id === "FLY-5") throw new Error("linear down");
				return { id: `uuid-${id}`, identifier: id, stateType: "completed" };
			}),
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedUnresolved).toBe(2);
		expect(r.archived).toBe(1); // FLY-6 unaffected
	});

	// FLY-1185 (Codex R1#1): the Linear lookup now ALWAYS runs — liveness must
	// not block the durable observation write (that starved the episode
	// machine: nonterminal observations were never persisted while a runner
	// lived, so every issue aged into first-seen-terminal legacy). The
	// liveness veto still protects the LEGACY finalize/archive path.
	it("5. live runner (probe alive) → observation pass runs, legacy path skippedActive, never archived", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-7", "tadashi");
		seedSession(store, {
			execution_id: "e-1",
			issue_id: "FLY-7",
			status: "running",
		});
		const deps = makeDeps(store, {
			lookupTarget: () => ({
				kind: "found" as const,
				target: { tmuxWindow: "w:@1", sessionName: "w" },
			}),
			probeLiveness: async () => "alive" as const,
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedActive).toBe(1);
		expect(deps.lookupIssue).toHaveBeenCalled();
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("6. indeterminate probe / probe throw → treated as live", async () => {
		for (const probe of [
			async () => "indeterminate" as const,
			async () => {
				throw new Error("probe blew up");
			},
		]) {
			const store = await freshStore();
			store.upsertChatThread("t-1", "ch-eng", "FLY-8", "tadashi");
			seedSession(store, { execution_id: "e-1", issue_id: "FLY-8" });
			const deps = makeDeps(store, {
				lookupTarget: () => ({
					kind: "found" as const,
					target: { tmuxWindow: "w:@1", sessionName: "w" },
				}),
				probeLiveness: probe as DoneThreadReconcileDeps["probeLiveness"],
			});
			const r = await reconcileDoneThreads(deps);
			expect(r.skippedActive).toBe(1);
			expect(deps.archiveFn).not.toHaveBeenCalled();
		}
	});

	it("7. lookupTarget error tri-state → treated as live (CommDB lock ≠ dead)", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-9", "tadashi");
		seedSession(store, { execution_id: "e-1", issue_id: "FLY-9" });
		const deps = makeDeps(store, {
			lookupTarget: () => ({ kind: "error", error: "db locked" }) as const,
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedActive).toBe(1);
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("8. terminal-status (completed) row with a LIVE process → veto", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-10", "tadashi");
		seedSession(store, {
			execution_id: "e-1",
			issue_id: "FLY-10",
			status: "completed",
		});
		const deps = makeDeps(store, {
			lookupTarget: () => ({
				kind: "found" as const,
				target: { tmuxWindow: "w:@1", sessionName: "w" },
			}),
			probeLiveness: async () => "alive" as const,
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedActive).toBe(1);
	});

	it("9. alias: thread keyed by identifier, session keyed by UUID only → veto #2 catches it", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-11", "tadashi");
		// UUID-keyed legacy session with NO identifier column — invisible to
		// veto #1 (keys = ["FLY-11"]), only reachable via linear.id enumeration.
		seedSession(store, {
			execution_id: "e-uuid",
			issue_id: "uuid-FLY-11",
			status: "awaiting_review",
		});
		const deps = makeDeps(store, {
			lookupTarget: (execId: string) =>
				execId === "e-uuid"
					? {
							kind: "found" as const,
							target: { tmuxWindow: "w:@1", sessionName: "w" },
						}
					: { kind: "gone" as const },
			probeLiveness: async () => "alive" as const,
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedActive).toBe(1);
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("10. TOCTOU-A: live session lands DURING lookupIssue await → veto #2 blocks", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-12", "tadashi");
		let liveNow = false;
		const deps = makeDeps(store, {
			lookupIssue: vi.fn(async (_k: string, id: string) => {
				// A new run starts while we were talking to Linear.
				seedSession(store, {
					execution_id: "e-new",
					issue_id: "FLY-12",
					status: "running",
				});
				liveNow = true;
				return { id: `uuid-${id}`, identifier: id, stateType: "completed" };
			}),
			lookupTarget: () =>
				liveNow
					? ({
							kind: "found",
							target: { tmuxWindow: "w:@1", sessionName: "w" },
						} as const)
					: ({ kind: "gone" } as const),
			probeLiveness: async () => "alive" as const,
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedActive).toBe(1);
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("11. TOCTOU-B: live session lands DURING closeRunner await → veto #3 blocks, archiveFn 0 calls", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-13", "tadashi");
		seedSession(store, {
			execution_id: "e-husk",
			issue_id: "FLY-13",
			status: "awaiting_review",
		});
		let liveNow = false;
		const deps = makeDeps(store, {
			closeRunnerFn: vi.fn(async () => {
				// A new run starts while the husk finalize awaits cmux/tmux teardown.
				seedSession(store, {
					execution_id: "e-new",
					issue_id: "FLY-13",
					status: "running",
				});
				liveNow = true;
				return { closed: true, alreadyGone: false };
			}) as DoneThreadReconcileDeps["closeRunnerFn"],
			lookupTarget: ((execId: string) =>
				liveNow && execId === "e-new"
					? ({
							kind: "found",
							target: { tmuxWindow: "w:@1", sessionName: "w" },
						} as const)
					: ({
							kind: "gone",
						} as const)) as DoneThreadReconcileDeps["lookupTarget"],
			probeLiveness: async () => "alive" as const,
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedActive).toBe(1);
		expect(r.huskFinalized).toBe(1);
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("12. finalize returns closed:false → huskFinalizeFailed, whole thread skipped, archiveFn 0 calls", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-14", "tadashi");
		seedSession(store, {
			execution_id: "e-husk",
			issue_id: "FLY-14",
			status: "approved_to_ship",
		});
		const deps = makeDeps(store, {
			closeRunnerFn: vi
				.fn()
				.mockResolvedValue({ closed: false, alreadyGone: false }),
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.huskFinalizeFailed).toBe(1);
		expect(r.archived).toBe(0);
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("13. dead husk (gone) + Done → closeRunner finalizeDone:true called + archived", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-15", "tadashi");
		seedSession(store, {
			execution_id: "e-husk",
			issue_id: "FLY-15",
			status: "awaiting_review",
		});
		const deps = makeDeps(store);
		const r = await reconcileDoneThreads(deps);
		expect(deps.closeRunnerFn).toHaveBeenCalledTimes(1);
		const [closeOpts] = deps.closeRunnerFn.mock.calls[0];
		expect(closeOpts).toMatchObject({
			executionId: "e-husk",
			finalizeDone: true,
			leadId: "bridge.done-thread-reconcile",
		});
		expect(r.huskFinalized).toBe(1);
		expect(r.archived).toBe(1);
	});

	it("13b. transitionOpts missing with finalizable dead husk → huskFinalizeFailed + skip (fail-closed)", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-16", "tadashi");
		seedSession(store, {
			execution_id: "e-husk",
			issue_id: "FLY-16",
			status: "running",
		});
		const deps = makeDeps(store, { transitionOpts: undefined });
		const r = await reconcileDoneThreads(deps);
		expect(r.huskFinalizeFailed).toBe(1);
		expect(deps.closeRunnerFn).not.toHaveBeenCalled();
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("14. archived_at set by another path before archive → skippedAlreadyArchived, archiveFn NOT called", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-17", "tadashi");
		seedSession(store, {
			execution_id: "e-husk",
			issue_id: "FLY-17",
			status: "awaiting_review",
		});
		const deps = makeDeps(store, {
			closeRunnerFn: vi.fn(async () => {
				// The close→archive cascade races us and archives first.
				store.markChatThreadArchived("t-1");
				return { closed: true, alreadyGone: false };
			}) as DoneThreadReconcileDeps["closeRunnerFn"],
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedAlreadyArchived).toBe(1);
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("15. sink returns already_archived → counted skippedAlreadyArchived, NOT failed", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-18", "tadashi");
		const deps = makeDeps(store, {
			archiveSinkFn: vi.fn().mockResolvedValue({
				archived: false,
				attempts: 0,
				reason: "already_archived",
			}),
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.skippedAlreadyArchived).toBe(1);
		expect(r.failed).toBe(0);
	});

	it.each(["founder_reopened", "in_active_use"] as const)(
		"15b. sink returns %s → counted skippedReopenProtected, NOT failed",
		async (reason) => {
			const store = await freshStore();
			store.upsertChatThread("t-1", "ch-eng", "FLY-18b", "tadashi");
			const deps = makeDeps(store, {
				archiveSinkFn: vi.fn().mockResolvedValue({
					archived: false,
					attempts: 0,
					reason,
					...(reason === "in_active_use"
						? { activeExecutionId: "exec-live" }
						: {}),
				}),
			});
			const r = await reconcileDoneThreads(deps);
			expect(r.skippedReopenProtected).toBe(1);
			expect(r.failed).toBe(0);
		},
	);

	it("16. maxArchivesPerRun=1 with two Done candidates → archives 1, capped:true", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-19", "tadashi");
		store.upsertChatThread("t-2", "ch-eng", "FLY-20", "tadashi");
		const deps = makeDeps(store, { maxArchivesPerRun: 1 });
		const r = await reconcileDoneThreads(deps);
		expect(r.archived).toBe(1);
		expect(r.capped).toBe(true);
	});

	it("17. maxCandidatesPerRun=1 with two candidates → scans 1, capped:true", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-21", "tadashi");
		store.upsertChatThread("t-2", "ch-eng", "FLY-22", "tadashi");
		const deps = makeDeps(store, { maxCandidatesPerRun: 1 });
		const r = await reconcileDoneThreads(deps);
		expect(r.scanned).toBe(1);
		expect(r.capped).toBe(true);
	});

	it("18. wall-clock deadline exceeded → deadlineHit:true", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-23", "tadashi");
		store.upsertChatThread("t-2", "ch-eng", "FLY-24", "tadashi");
		let t = 0;
		const deps = makeDeps(store, {
			runDeadlineMs: 100,
			now: () => {
				t += 60; // every clock read advances 60ms — second candidate is over budget
				return t;
			},
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.deadlineHit).toBe(true);
		expect(r.scanned).toBeLessThan(2);
	});

	it("19. shouldAbort flips true mid-run → aborted:true, later candidates untouched", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-25", "tadashi");
		store.upsertChatThread("t-2", "ch-eng", "FLY-26", "tadashi");
		let processed = 0;
		const deps = makeDeps(store, {
			shouldAbort: () => processed >= 1,
			archiveSinkFn: vi.fn(async () => {
				processed++;
				return OK_ARCHIVE;
			}),
		});
		const r = await reconcileDoneThreads(deps);
		expect(r.aborted).toBe(true);
		expect(r.scanned).toBe(1);
	});

	it("20. dryRun → neither closeRunner nor archive called; counts correct", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-27", "tadashi");
		seedSession(store, {
			execution_id: "e-husk",
			issue_id: "FLY-27",
			status: "awaiting_review",
		});
		const deps = makeDeps(store, { dryRun: true });
		const r = await reconcileDoneThreads(deps);
		expect(r.dryRunWouldArchive).toBe(1);
		expect(r.archived).toBe(0);
		expect(deps.closeRunnerFn).not.toHaveBeenCalled();
		expect(deps.archiveFn).not.toHaveBeenCalled();
		expect(store.isChatThreadArchived("t-1")).toBe(false);
	});

	it("21. no linearApiKey → whole sweep is a no-op (zero lookups, zero writes)", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-1", "ch-eng", "FLY-28", "tadashi");
		const deps = makeDeps(store, { linearApiKey: undefined });
		const r = await reconcileDoneThreads(deps);
		expect(r.scanned).toBe(0);
		expect(deps.lookupIssue).not.toHaveBeenCalled();
		expect(deps.archiveFn).not.toHaveBeenCalled();
	});

	it("22. no botToken → skippedNoToken; project resolution 0-match and 2-match → skippedNoProject", async () => {
		// (a) token missing: lead has no botToken, no global fallback.
		{
			const store = await freshStore();
			store.upsertChatThread("t-1", "ch-eng", "FLY-29", "tadashi");
			const noTokenProject = {
				projectName: "flywheel",
				projectRoot: "/tmp/fw",
				leads: [
					{ agentId: "tadashi", chatChannel: "ch-eng", match: { labels: [] } },
				],
			} as unknown as ProjectEntry;
			const deps = makeDeps(store, { projects: [noTokenProject] });
			const r = await reconcileDoneThreads(deps);
			expect(r.skippedNoToken).toBe(1);
		}
		// (b) 0-match: no session rows AND no (lead_id, channel_id) match.
		{
			const store = await freshStore();
			store.upsertChatThread("t-1", "ch-other", "FLY-30", "nobody");
			const deps = makeDeps(store);
			const r = await reconcileDoneThreads(deps);
			expect(r.skippedNoProject).toBe(1);
		}
		// (c) 2-match (duplicate config): two projects share the lead/channel pair.
		{
			const store = await freshStore();
			store.upsertChatThread("t-1", "ch-eng", "FLY-31", "tadashi");
			const dup = {
				...PROJECT,
				projectName: "flywheel-dup",
			} as unknown as ProjectEntry;
			const deps = makeDeps(store, { projects: [PROJECT, dup] });
			const r = await reconcileDoneThreads(deps);
			expect(r.skippedNoProject).toBe(1);
			expect(deps.archiveFn).not.toHaveBeenCalled();
		}
	});

	it("23. UUID-form issue_id is passed verbatim to lookupIssue", async () => {
		const store = await freshStore();
		const uuid = "a1b2c3d4-0000-0000-0000-00000000cafe";
		store.upsertChatThread("t-1", "ch-eng", uuid, "tadashi");
		seedSession(store, {
			execution_id: "e-1",
			issue_id: uuid,
			status: "completed",
		});
		const deps = makeDeps(store, {
			lookupIssue: vi.fn(async (_k: string, id: string) => ({
				id,
				identifier: "FLY-32",
				stateType: "completed",
			})),
		});
		await reconcileDoneThreads(deps);
		expect(deps.lookupIssue).toHaveBeenCalledWith("test-linear-key", uuid);
	});

	it("exports the FSM-legal finalizable status set (= FINALIZE_DONE_SOURCE_STATES)", () => {
		expect([...RECONCILE_FINALIZABLE_STATUSES].sort()).toEqual([
			"approved_to_ship",
			"awaiting_review",
			"design_done",
			"running",
			"ship_parked",
		]);
	});
});

describe("resolveDoneThreadReconcileConfig (FLY-1165)", () => {
	it("defaults", () => {
		const cfg = resolveDoneThreadReconcileConfig({});
		expect(cfg).toEqual({
			enabled: true,
			intervalMin: 360,
			dryRun: false,
			maxArchivesPerRun: 25,
			maxCandidatesPerRun: 200,
			runDeadlineMs: 120_000,
		});
	});

	it("FLYWHEEL_DONE_THREAD_RECONCILE=0 → disabled; any other value stays enabled", () => {
		expect(
			resolveDoneThreadReconcileConfig({ FLYWHEEL_DONE_THREAD_RECONCILE: "0" })
				.enabled,
		).toBe(false);
		expect(
			resolveDoneThreadReconcileConfig({ FLYWHEEL_DONE_THREAD_RECONCILE: "1" })
				.enabled,
		).toBe(true);
	});

	it("interval: 0 → boot-only; junk / negative → default", () => {
		expect(
			resolveDoneThreadReconcileConfig({
				FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN: "0",
			}).intervalMin,
		).toBe(0);
		expect(
			resolveDoneThreadReconcileConfig({
				FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN: "90",
			}).intervalMin,
		).toBe(90);
		expect(
			resolveDoneThreadReconcileConfig({
				FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN: "junk",
			}).intervalMin,
		).toBe(360);
		expect(
			resolveDoneThreadReconcileConfig({
				FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN: "-5",
			}).intervalMin,
		).toBe(360);
	});

	it("keeps production dry-run disabled and parses MAX_PER_RUN", () => {
		expect(resolveDoneThreadReconcileConfig({}).dryRun).toBe(false);
		expect(
			resolveDoneThreadReconcileConfig({
				FLYWHEEL_DONE_THREAD_RECONCILE_MAX_PER_RUN: "7",
			}).maxArchivesPerRun,
		).toBe(7);
		expect(
			resolveDoneThreadReconcileConfig({
				FLYWHEEL_DONE_THREAD_RECONCILE_MAX_PER_RUN: "junk",
			}).maxArchivesPerRun,
		).toBe(25);
	});
});

describe("startDoneThreadReconcileScheduler (FLY-1165)", () => {
	const CFG = {
		enabled: true,
		intervalMin: 1,
		dryRun: false,
		maxArchivesPerRun: 25,
		maxCandidatesPerRun: 200,
		runDeadlineMs: 120_000,
	};

	it("boot pass fires once after bootDelayMs (config checked fresh at fire time)", async () => {
		vi.useFakeTimers();
		try {
			const runOnce = vi.fn().mockResolvedValue(undefined);
			const sched = startDoneThreadReconcileScheduler({
				runOnce,
				resolveConfig: () => CFG,
				bootDelayMs: 15_000,
				tickMs: 60_000,
			});
			expect(runOnce).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(15_000);
			expect(runOnce).toHaveBeenCalledTimes(1);
			await sched.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("off at boot → on later: next tick past the interval runs (no restart needed)", async () => {
		vi.useFakeTimers();
		try {
			let enabled = false;
			const runOnce = vi.fn().mockResolvedValue(undefined);
			const sched = startDoneThreadReconcileScheduler({
				runOnce,
				resolveConfig: () => ({ ...CFG, enabled }),
				bootDelayMs: 1_000,
				tickMs: 60_000,
			});
			await vi.advanceTimersByTimeAsync(1_000); // boot pass — disabled → no run
			expect(runOnce).not.toHaveBeenCalled();
			enabled = true;
			await vi.advanceTimersByTimeAsync(60_000); // first tick after interval
			expect(runOnce).toHaveBeenCalledTimes(1);
			await sched.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("on → off: no further runs after the flag flips off", async () => {
		vi.useFakeTimers();
		try {
			let enabled = true;
			const runOnce = vi.fn().mockResolvedValue(undefined);
			const sched = startDoneThreadReconcileScheduler({
				runOnce,
				resolveConfig: () => ({ ...CFG, enabled }),
				bootDelayMs: 1_000,
				tickMs: 60_000,
			});
			await vi.advanceTimersByTimeAsync(1_000);
			expect(runOnce).toHaveBeenCalledTimes(1);
			enabled = false;
			await vi.advanceTimersByTimeAsync(600_000);
			expect(runOnce).toHaveBeenCalledTimes(1);
			await sched.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("intervalMin=0 → boot-only (periodic ticks never run)", async () => {
		vi.useFakeTimers();
		try {
			const runOnce = vi.fn().mockResolvedValue(undefined);
			const sched = startDoneThreadReconcileScheduler({
				runOnce,
				resolveConfig: () => ({ ...CFG, intervalMin: 0 }),
				bootDelayMs: 1_000,
				tickMs: 60_000,
			});
			await vi.advanceTimersByTimeAsync(1_000);
			expect(runOnce).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(6_000_000);
			expect(runOnce).toHaveBeenCalledTimes(1);
			await sched.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("interval changes take effect on the next tick (fresh resolveConfig)", async () => {
		vi.useFakeTimers();
		try {
			let intervalMin = 100; // effectively never
			const runOnce = vi.fn().mockResolvedValue(undefined);
			const sched = startDoneThreadReconcileScheduler({
				runOnce,
				resolveConfig: () => ({ ...CFG, intervalMin }),
				bootDelayMs: 1_000,
				tickMs: 60_000,
			});
			await vi.advanceTimersByTimeAsync(1_000); // boot run
			expect(runOnce).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(300_000); // 5 ticks, interval 100min → none
			expect(runOnce).toHaveBeenCalledTimes(1);
			intervalMin = 1; // shrink → next tick is already past 1min since last run
			await vi.advanceTimersByTimeAsync(60_000);
			expect(runOnce).toHaveBeenCalledTimes(2);
			await sched.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("single-flight: an in-flight pass blocks new runs; stop() drains it and nothing runs after", async () => {
		vi.useFakeTimers();
		try {
			let release: () => void = () => {};
			const pending = new Promise<undefined>((resolve) => {
				release = () => resolve(undefined);
			});
			const runOnce = vi.fn().mockImplementation(() => pending);
			const sched = startDoneThreadReconcileScheduler({
				runOnce,
				resolveConfig: () => CFG,
				bootDelayMs: 1_000,
				tickMs: 60_000,
			});
			await vi.advanceTimersByTimeAsync(1_000); // boot run starts, stays in flight
			expect(runOnce).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(600_000); // many ticks — still in flight
			expect(runOnce).toHaveBeenCalledTimes(1);

			// stop(): resolves only after the in-flight pass drains.
			let stopped = false;
			const stopPromise = sched.stop().then(() => {
				stopped = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(stopped).toBe(false);
			release();
			await stopPromise;
			expect(stopped).toBe(true);

			await vi.advanceTimersByTimeAsync(6_000_000);
			expect(runOnce).toHaveBeenCalledTimes(1); // zero new runs after stop
		} finally {
			vi.useRealTimers();
		}
	});
});
