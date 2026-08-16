/**
 * FLY-1185 D entry — done-thread-reconcile extension tests.
 * Plan §4 pins: #30 cutover episode (first-seen-terminal → zero NEW mutator
 * in EVERY round; post-cutover migration → closeout; reopen→Cancel works),
 * #35 per-run caps + dual-switch byte-compat (autoclean=0 ⇒ new mutators
 * zero while the original FLY-1165 husk/archive behavior is untouched).
 */

import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	MAX_ISSUE_CLOSEOUTS_PER_RUN,
	reconcileDoneThreads,
} from "../done-thread-reconcile.js";

const UUID = "33333333-3333-4333-8333-333333333333";

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function seed(store: StateStore, issueId = UUID): void {
	store.upsertSession({
		execution_id: "e1",
		issue_id: issueId,
		project_name: "proj",
		status: "terminated",
		issue_identifier: "FLY-500",
	});
	store.upsertChatThread("thread-1", "chan", issueId, "lead");
}

function baseDeps(
	store: StateStore,
	over: Record<string, unknown> = {},
): Parameters<typeof reconcileDoneThreads>[0] {
	return {
		store,
		projects: [],
		linearApiKey: "key",
		globalBotToken: "tok",
		lookupIssue: async () => ({
			id: UUID,
			identifier: "FLY-500",
			stateType: "canceled",
			updatedAt: "2026-07-11T00:00:00.000Z",
		}),
		lookupTarget: (() => ({ kind: "gone" }) as const) as never,
		probeLiveness: async () => "absent" as const,
		archiveSinkFn: (async () => ({ archived: true })) as never,
		sleepImpl: async () => {},
		log: () => {},
		...over,
	} as Parameters<typeof reconcileDoneThreads>[0];
}

describe("FLY-1185 D entry — cutover episode machine (plan §4 #30)", () => {
	it("first-seen-terminal → legacy episode: ZERO closeout calls, manual candidate audited — in EVERY round", async () => {
		const store = await freshStore();
		seed(store);
		const lifecycleCloseout = vi.fn(async () => ({
			nodes: [],
			outcome: "complete",
		}));
		// round 1
		let res = await reconcileDoneThreads(
			baseDeps(store, { lifecycleCloseout }),
		);
		expect(lifecycleCloseout).not.toHaveBeenCalled();
		expect(res.legacyManualCandidates).toBe(1);
		// round 2 — STILL manual, not auto (any-round rule, not just boot)
		store.upsertChatThread("thread-1", "chan", UUID, "lead");
		res = await reconcileDoneThreads(baseDeps(store, { lifecycleCloseout }));
		expect(lifecycleCloseout).not.toHaveBeenCalled();
	});

	it("durable nonterminal→terminal migration → closeout runs with the right disposition", async () => {
		const store = await freshStore();
		seed(store);
		// seed a durable NONTERMINAL observation first (the cutover proof)
		store.observeLinearStateAndClaimCloseout({
			project: "proj",
			issueUuid: UUID,
			stateType: "started",
			linearUpdatedAt: "2026-07-10T00:00:00.000Z",
		});
		// Codex R1#14: the executor consumes the run budget PER NODE via
		// input.budget.tryConsume — the mock mimics a 2-node closeout.
		const lifecycleCloseout = vi.fn(
			async (input: { budget?: { tryConsume: () => boolean } }) => {
				input.budget?.tryConsume();
				input.budget?.tryConsume();
				return { nodes: [{}, {}], outcome: "complete" };
			},
		);
		const res = await reconcileDoneThreads(
			baseDeps(store, { lifecycleCloseout }),
		);
		expect(lifecycleCloseout).toHaveBeenCalledWith(
			expect.objectContaining({
				issueKey: UUID,
				projectName: "proj",
				disposition: "canceled",
				budget: expect.objectContaining({ tryConsume: expect.any(Function) }),
			}),
		);
		expect(res.closeoutRuns).toBe(1);
		expect(res.closeoutMutators).toBe(2);
	});

	it("canceled + authorized → the LEGACY finalizeDone loop is skipped (no fabricated completed)", async () => {
		const store = await freshStore();
		// a dead husk in a finalizable state on a CANCELED issue
		store.upsertSession({
			execution_id: "husk-e",
			issue_id: UUID,
			project_name: "proj",
			status: "awaiting_review",
			issue_identifier: "FLY-500",
		});
		store.upsertChatThread("thread-1", "chan", UUID, "lead");
		store.observeLinearStateAndClaimCloseout({
			project: "proj",
			issueUuid: UUID,
			stateType: "started",
			linearUpdatedAt: "2026-07-10T00:00:00.000Z",
		});
		const closeRunnerFn = vi.fn(async () => ({ closed: true }));
		const lifecycleCloseout = vi.fn(async () => ({
			nodes: [{}],
			outcome: "complete",
		}));
		await reconcileDoneThreads(
			baseDeps(store, {
				lifecycleCloseout,
				closeRunnerFn,
				transitionOpts: {} as never,
			}),
		);
		// the legacy husk-finalize path (closeRunnerFn with finalizeDone) must
		// NOT run — the closeout owns the husk with terminate semantics.
		expect(closeRunnerFn).not.toHaveBeenCalled();
		expect(lifecycleCloseout).toHaveBeenCalled();
	});

	it("dual-switch (plan §4 #35): newMutatorsEnabled=false ⇒ zero closeout, ORIGINAL husk finalize + archive still run", async () => {
		const store = await freshStore();
		store.upsertSession({
			execution_id: "husk-e",
			issue_id: UUID,
			project_name: "proj",
			status: "awaiting_review",
			issue_identifier: "FLY-500",
		});
		store.upsertChatThread("thread-1", "chan", UUID, "lead");
		store.observeLinearStateAndClaimCloseout({
			project: "proj",
			issueUuid: UUID,
			stateType: "started",
			linearUpdatedAt: "2026-07-10T00:00:00.000Z",
		});
		const closeRunnerFn = vi.fn(async () => ({ closed: true }));
		const lifecycleCloseout = vi.fn(async () => ({
			nodes: [],
			outcome: "complete",
		}));
		const archiveSinkFn = vi.fn(async () => ({ archived: true }));
		const res = await reconcileDoneThreads(
			baseDeps(store, {
				lifecycleCloseout,
				closeRunnerFn,
				archiveSinkFn,
				transitionOpts: { store, fsm: undefined } as never,
				newMutatorsEnabled: false, // injected autoclean seam disabled
			}),
		);
		expect(lifecycleCloseout).not.toHaveBeenCalled();
		// original FLY-1165 behavior untouched: husk finalize attempted + archive ran
		expect(closeRunnerFn).toHaveBeenCalledWith(
			expect.objectContaining({ finalizeDone: true }),
			expect.anything(),
		);
		expect(archiveSinkFn).toHaveBeenCalled();
		expect(res.closeoutRuns).toBe(0);
	});

	it("per-run closeout cap is the hardcoded constant (no env)", () => {
		expect(MAX_ISSUE_CLOSEOUTS_PER_RUN).toBe(5);
	});

	it("offers fresh Done authority to gate retirement before an active-runner veto", async () => {
		const store = await freshStore();
		store.upsertSession({
			execution_id: "active-e",
			issue_id: UUID,
			project_name: "proj",
			status: "running",
			issue_identifier: "FLY-500",
		});
		store.upsertChatThread("thread-1", "chan", UUID, "lead");
		const retireIssueGates = vi.fn(async () => {});

		const result = await reconcileDoneThreads(
			baseDeps(store, {
				retireIssueGates,
				lookupTarget: (() => ({
					kind: "found",
					target: { tmuxWindow: "runner" },
				})) as never,
				probeLiveness: async () => "alive" as const,
			}),
		);

		expect(retireIssueGates).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "proj",
				canonicalIssueId: UUID,
				issueAliases: expect.arrayContaining([UUID, "FLY-500"]),
				authorityCredential: `${UUID}:2026-07-11T00:00:00.000Z`,
				revalidate: expect.any(Function),
			}),
		);
		expect(result.skippedActive).toBe(1);
	});
});
