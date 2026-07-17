import { describe, expect, it, vi } from "vitest";
import {
	type WorkflowDocsGit,
	WorkflowDocsMaterializer,
} from "../bridge/workflow-docs-materializer.js";

const BASE = "a".repeat(40);
const TREE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const DIGEST = "d".repeat(64);
const EFFECT = `mat:${"e".repeat(64)}`;

function fixture(
	options: {
		payload?: unknown;
		adoptFailsOnce?: boolean;
		pushLosesResponse?: boolean;
	} = {},
) {
	let ledgerState:
		| "intent_recorded"
		| "launch_committed"
		| "started"
		| undefined;
	let commitReceipt: { tree_head: string; commit_head: string } | undefined;
	let remoteHead: string | undefined;
	let adoptFails = options.adoptFailsOnce === true;
	let pushLosesResponse = options.pushLosesResponse === true;
	const calls: string[] = [];
	const store = {
		listWorkflowMaterializationCandidates: () => [
			{
				runId: "run-product",
				producerNodeId: "produce",
				reviewNodeId: "review",
				attempt: 1,
				outputId: 9,
				outputDigest: DIGEST,
				payload: JSON.stringify(
					options.payload ?? {
						kind: "docs_v1",
						operations: [
							{ op: "write", path: "product/doc/prd.md", content: "PRD\n" },
						],
					},
				),
				projectName: "flywheel",
				issueId: "FLY-1307",
			},
		],
		getWorkflowMaterializedHead: () =>
			ledgerState === "started"
				? { head: COMMIT, outputId: 9, attempt: 1 }
				: undefined,
		allocateWorkflowMaterialization: (input: Record<string, unknown>) => {
			calls.push(`allocate:${input.repo}:${input.ref}:${input.baseHead}`);
			ledgerState ??= "intent_recorded";
			return { effect_id: EFFECT, state: ledgerState };
		},
		getWorkflowMaterializationReceipts: () => [
			{ stage: "intent_pinned", base_head: BASE },
			...(commitReceipt ? [{ stage: "commit_adopted", ...commitReceipt }] : []),
		],
		adoptWorkflowMaterializationCommit: (input: {
			treeHead: string;
			commitHead: string;
		}) => {
			calls.push("adopt");
			if (adoptFails) {
				adoptFails = false;
				throw new Error("crash_after_commit");
			}
			commitReceipt = {
				tree_head: input.treeHead,
				commit_head: input.commitHead,
			};
			ledgerState = "launch_committed";
		},
		confirmWorkflowMaterializationPush: () => {
			calls.push("confirm");
			ledgerState = "started";
		},
	};
	const git: WorkflowDocsGit = {
		resolveBaseHead: vi.fn(async () => BASE),
		prepareOrAdoptCommit: vi.fn(async (input) => {
			calls.push(`prepare:${input.effectId}:${input.payload.kind}`);
			return { treeHead: TREE, commitHead: COMMIT };
		}),
		readRemoteHead: vi.fn(async () => remoteHead),
		pushCommit: vi.fn(async () => {
			calls.push("push");
			remoteHead = COMMIT;
			if (pushLosesResponse) {
				pushLosesResponse = false;
				throw new Error("push_response_lost");
			}
		}),
	};
	const materializer = new WorkflowDocsMaterializer({
		store: store as never,
		git,
		projects: [
			{
				projectName: "flywheel",
				projectRoot: "/srv/flywheel",
				projectRepo: "xrliAnnie/flywheel",
				leads: [],
			},
		],
		withRepoLock: async (_root, fn) => fn(),
	});
	return { materializer, git, store, calls, state: () => ledgerState };
}

describe("WorkflowDocsMaterializer", () => {
	it("derives repo/ref server-side and converges accepted output to one confirmed head", async () => {
		const { materializer, calls, state } = fixture();
		await expect(materializer.reconcile()).resolves.toEqual({
			materialized: 1,
			held: 0,
		});
		expect(state()).toBe("started");
		expect(calls).toEqual([
			`allocate:xrliAnnie/flywheel:refs/heads/flywheel/docs/flywheel/FLY-1307:${BASE}`,
			`prepare:${EFFECT}:docs_v1`,
			"adopt",
			"push",
			"confirm",
		]);
	});

	it("adopts the same deterministic commit after a crash between git commit and DB receipt", async () => {
		const { materializer, git, state } = fixture({ adoptFailsOnce: true });
		await expect(materializer.reconcile()).resolves.toEqual({
			materialized: 0,
			held: 1,
		});
		await expect(materializer.reconcile()).resolves.toEqual({
			materialized: 1,
			held: 0,
		});
		expect(git.prepareOrAdoptCommit).toHaveBeenCalledTimes(2);
		expect(state()).toBe("started");
	});

	it("confirms an already-pushed head after the push response was lost", async () => {
		const { materializer, git, state } = fixture({ pushLosesResponse: true });
		await expect(materializer.reconcile()).resolves.toEqual({
			materialized: 0,
			held: 1,
		});
		await expect(materializer.reconcile()).resolves.toEqual({
			materialized: 1,
			held: 0,
		});
		expect(git.pushCommit).toHaveBeenCalledTimes(1);
		expect(state()).toBe("started");
	});

	it("fails closed before git for an invalid docs_v1 payload", async () => {
		const { materializer, git } = fixture({
			payload: {
				kind: "docs_v1",
				operations: [{ op: "write", path: "../pwn", content: "x" }],
			},
		});
		await expect(materializer.reconcile()).resolves.toEqual({
			materialized: 0,
			held: 1,
		});
		expect(git.resolveBaseHead).not.toHaveBeenCalled();
	});

	it("contains a store-level reconciliation failure instead of rejecting", async () => {
		const log = vi.fn();
		const materializer = new WorkflowDocsMaterializer({
			store: {
				listWorkflowMaterializationCandidates: () => {
					throw new Error("database unavailable");
				},
			} as never,
			git: {} as never,
			projects: [],
			withRepoLock: async (_root, fn) => fn(),
			log,
		});

		await expect(materializer.reconcile()).resolves.toEqual({
			materialized: 0,
			held: 1,
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/reconciliation failed.*database unavailable/i),
		);
	});

	it("single-flights concurrent reconcile calls", async () => {
		const { materializer, git } = fixture();
		const [first, second] = await Promise.all([
			materializer.reconcile(),
			materializer.reconcile(),
		]);
		expect(first.materialized + second.materialized).toBe(1);
		expect(git.prepareOrAdoptCommit).toHaveBeenCalledTimes(1);
	});
});
