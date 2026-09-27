import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createIssueMutex } from "../lifecycle-closeout.js";
import { createRepoMutationLock } from "../repo-mutation-lock.js";
import {
	buildStockCleanupPreview,
	type StockCleanupObservedTarget,
} from "../stock-worktree-cleanup.js";
import {
	createStockCleanupExecutor,
	type StockCleanupExecutionResult,
} from "../stock-worktree-cleanup-executor.js";

const stores: StateStore[] = [];
const HEAD = "a".repeat(40);
const ISSUE = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function target(
	bodyVerdict: "dead" | "alive" | "unknown" = "dead",
): StockCleanupObservedTarget {
	return {
		projectName: "flywheel",
		repoSlug: "xrliAnnie/flywheel",
		canonicalPath: "/srv/worktrees/flywheel-FLY-3000",
		parentIdentity: { dev: "1", ino: "2" },
		leafIdentity: { dev: "1", ino: "3" },
		generation: "generation-1",
		branch: "flywheel-FLY-3000",
		head: HEAD,
		locked: false,
		detached: false,
		issueId: ISSUE,
		issueIdentifier: "FLY-3000",
		operationId: "operation-3000",
		pr: {
			number: 3000,
			state: "MERGED",
			headRef: "flywheel-FLY-3000",
			headSha: HEAD,
			baseRef: "main",
			mergeCommitSha: "b".repeat(40),
			mergedAt: "2026-09-26T20:00:00.000Z",
		},
		bindings: [
			{
				executionId: "execution-3000",
				activationId: "activation-3000",
				executionRunId: "run-3000",
				lifecycleRevision: 0,
				adapter: "codex-tmux",
				path: "/srv/worktrees/flywheel-FLY-3000",
				branch: "flywheel-FLY-3000",
				generation: "generation-1",
			},
		],
		bodyObservations: [
			{
				identity: {
					executionId: "execution-3000",
					activationId: "activation-3000",
					generation: 1,
					lifecycleRevision: 0,
					adapter: "codex-tmux",
				},
				ownerToken: "owner-3000",
				spawnEpoch: 1,
				verdict: bodyVerdict,
				observedAt: "2026-09-26T20:00:00.000Z",
				expiresAt: "2026-09-26T20:01:00.000Z",
				bindingDigest: "c".repeat(64),
				reason: `${bodyVerdict}_fixture`,
			},
		],
		clean: true,
		nestedRepository: "clear",
		remoteProof: {
			state: "preserved",
			kind: "merged_exact_head",
			observedHead: HEAD,
			observedAt: "2026-09-26T20:00:00.000Z",
		},
		processCensus: {
			state: "clear",
			observedAt: "2026-09-26T20:00:00.000Z",
		},
		terminalAuthority: {
			state: "valid",
			identity: "land:operation-3000:0",
		},
	};
}

function previewFor(
	value: StockCleanupObservedTarget,
	observedAt = "2026-09-26T20:00:00.000Z",
) {
	return buildStockCleanupPreview({
		projectName: "flywheel",
		observedAt,
		targets: [value],
	});
}

async function setup(options: {
	fresh?: StockCleanupObservedTarget;
	remove?: () => Promise<{
		removed: boolean;
		branchDeleted: boolean;
		error?: string;
	}>;
}) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const approved = previewFor(target());
	let fresh = options.fresh ?? target();
	let removed = false;
	const preview = vi.fn(async () => previewFor(fresh));
	const remove = vi.fn(
		options.remove ??
			(async () => {
				removed = true;
				return { removed: true, branchDeleted: false };
			}),
	);
	const executor = createStockCleanupExecutor({
		store,
		projectRoot: (projectName) =>
			projectName === "flywheel" ? "/srv/flywheel" : undefined,
		preview,
		withIssueMutex: createIssueMutex(),
		withRepoLock: createRepoMutationLock().withRepoLock,
		worktreeManager: {
			removeCleanWorktreeByPath: remove,
			getRegisteredWorktree: async () => (removed ? null : ({} as never)),
		} as never,
		pathState: async () => (removed ? "absent" : "present"),
	});
	return {
		store,
		approved,
		executor,
		remove,
		preview,
		setFresh(value: StockCleanupObservedTarget) {
			fresh = value;
		},
	};
}

const input = (
	approved: ReturnType<typeof previewFor>,
	requestId = "22222222-2222-4222-8222-222222222222",
) => ({
	projectName: "flywheel",
	actor: "authenticated-lead",
	requestId,
	manifestJson: approved.manifestJson,
	manifestDigest: approved.manifestDigest,
	authorityCheck: vi.fn(),
});

describe("FLY-2778 stock cleanup executor", () => {
	it("revalidates and removes through the no-signal refuse primitive", async () => {
		const f = await setup({});
		const result = await f.executor.execute(input(f.approved));

		expect(result).toMatchObject({
			status: "applied",
			items: [{ status: "removed", canonicalPath: target().canonicalPath }],
		});
		expect(f.remove).toHaveBeenCalledWith(
			"/srv/flywheel",
			target().canonicalPath,
			null,
			{ processHandling: "refuse" },
		);
		expect(f.preview).toHaveBeenCalledWith(
			expect.objectContaining({ canonicalPath: target().canonicalPath }),
		);
	});

	it("replays the exact request without a second removal", async () => {
		const f = await setup({});
		const first = await f.executor.execute(input(f.approved));
		const replay = await f.executor.execute(input(f.approved));

		expect(replay).toEqual(first);
		expect(f.remove).toHaveBeenCalledOnce();
	});

	it("lets concurrent different requests claim one directory only once", async () => {
		const f = await setup({});
		const [left, right] = await Promise.all([
			f.executor.execute(input(f.approved)),
			f.executor.execute(
				input(f.approved, "33333333-3333-4333-8333-333333333333"),
			),
		]);

		expect(f.remove).toHaveBeenCalledOnce();
		expect([left, right].flatMap((result) => result.items)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "removed" }),
				expect.objectContaining({
					status: "rejected",
					reason: "effect_already_claimed",
				}),
			]),
		);
	});

	it("allows a new request to retry a target after a rejected observation", async () => {
		const f = await setup({ fresh: target("unknown") });
		const first = await f.executor.execute(input(f.approved));
		expect(first.items[0]).toMatchObject({
			status: "rejected",
			reason: "fresh_target_ineligible",
		});

		f.setFresh(target("dead"));
		const retryApproved = previewFor(
			target("dead"),
			"2026-09-26T20:00:01.000Z",
		);
		const retry = await f.executor.execute(
			input(retryApproved, "44444444-4444-4444-8444-444444444444"),
		);

		expect(retry.items[0]).toMatchObject({ status: "removed" });
		expect(f.remove).toHaveBeenCalledOnce();
	});

	it("allows a later worktree generation at the same path to claim cleanup", async () => {
		const f = await setup({});
		await f.executor.execute(input(f.approved));
		const later = target("dead");
		later.generation = "generation-2";
		later.leafIdentity = { dev: "1", ino: "4" };
		later.bindings[0]!.generation = "generation-2";
		f.setFresh(later);
		const laterApproved = previewFor(later, "2026-09-26T20:00:02.000Z");

		const result = await f.executor.execute(
			input(laterApproved, "55555555-5555-4555-8555-555555555555"),
		);

		expect(result.items[0]).toMatchObject({ status: "removed" });
		expect(f.remove).toHaveBeenCalledTimes(2);
	});

	it("rejects a binding identity change before removal", async () => {
		const fresh = target("dead");
		fresh.bindings[0]!.lifecycleRevision = 1;
		fresh.bodyObservations[0]!.identity.lifecycleRevision = 1;
		const f = await setup({ fresh });

		const result = await f.executor.execute(input(f.approved));

		expect(result.items[0]).toMatchObject({
			status: "rejected",
			reason: "target_identity_changed",
		});
		expect(f.remove).not.toHaveBeenCalled();
	});

	it.each([
		["unknown body", target("unknown"), "fresh_target_ineligible"],
		["late cwd process", target(), "process_present:42"],
	] as const)(
		"refuses %s without claiming success",
		async (_name, fresh, reason) => {
			const f = await setup({
				fresh,
				remove:
					reason === "process_present:42"
						? async () => ({
								removed: false,
								branchDeleted: false,
								error: reason,
							})
						: undefined,
			});
			const result: StockCleanupExecutionResult = await f.executor.execute(
				input(f.approved),
			);

			expect(result.status).toBe("partial");
			expect(result.items[0]).toMatchObject({ status: "rejected", reason });
			expect(f.remove).toHaveBeenCalledTimes(
				reason === "process_present:42" ? 1 : 0,
			);
		},
	);
});
