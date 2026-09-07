import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

async function fixture(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2395",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "exec-1",
	});
	return store;
}

describe("StateStore ship_relevant_declared_pr", () => {
	it("replays an identical receipt without allocating a new declaration sequence", async () => {
		const store = await fixture();
		const input = {
			receiptId: "receipt-1",
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			executionId: "exec-1",
			rows: [
				{
					repoIdentity: "owner/nested",
					prNumber: 42,
					probeRepoSlug: "owner/nested",
					frozenHeadSha: HEAD_A,
					targetRepoPath: "apps/nested",
				},
			],
			now: "2026-09-06T00:00:00.000Z",
		};

		store.recordShipRelevantDeclarations(input);
		store.recordShipRelevantDeclarations({
			...input,
			now: "2026-09-06T01:00:00.000Z",
		});

		expect(store.listShipRelevantDeclarationsForRun("run-1")).toEqual([
			expect.objectContaining({
				receipt_id: "receipt-1",
				repo_identity: "owner/nested",
				pr_number: 42,
				declaration_seq: 1,
				declared_at: "2026-09-06T00:00:00.000Z",
			}),
		]);
		store.close();
	});

	it.each([
		{
			name: "changes the PR number",
			rows: [
				{
					repoIdentity: "owner/nested",
					prNumber: 43,
					probeRepoSlug: "owner/nested",
					frozenHeadSha: HEAD_A,
					targetRepoPath: "apps/nested",
				},
			],
		},
		{
			name: "adds another PR",
			rows: [
				{
					repoIdentity: "owner/nested",
					prNumber: 42,
					probeRepoSlug: "owner/nested",
					frozenHeadSha: HEAD_A,
					targetRepoPath: "apps/nested",
				},
				{
					repoIdentity: "owner/second",
					prNumber: 44,
					probeRepoSlug: "owner/second",
					frozenHeadSha: HEAD_B,
					targetRepoPath: "apps/second",
				},
			],
		},
	])("rejects a receipt replay that $name", async ({ rows }) => {
		const store = await fixture();
		const base = {
			receiptId: "receipt-1",
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			executionId: "exec-1",
			now: "2026-09-06T00:00:00.000Z",
		};
		store.recordShipRelevantDeclarations({
			...base,
			rows: [
				{
					repoIdentity: "owner/nested",
					prNumber: 42,
					probeRepoSlug: "owner/nested",
					frozenHeadSha: HEAD_A,
					targetRepoPath: "apps/nested",
				},
			],
		});

		expect(() =>
			store.recordShipRelevantDeclarations({ ...base, rows }),
		).toThrow("declaration_conflict");
		expect(store.listShipRelevantDeclarationsForRun("run-1")).toHaveLength(1);
		store.close();
	});

	it.each([
		["__main__", 42],
		["owner/nested", 0],
	] as const)(
		"surfaces invalid declaration constraints for repo=%s pr=%s",
		async (repoIdentity, prNumber) => {
			const store = await fixture();
			expect(() =>
				store.recordShipRelevantDeclarations({
					receiptId: "receipt-invalid",
					runId: "run-1",
					nodeId: "implement",
					attempt: 1,
					executionId: "exec-1",
					rows: [
						{
							repoIdentity,
							prNumber,
							probeRepoSlug: "owner/nested",
							frozenHeadSha: HEAD_A,
							targetRepoPath: "apps/nested",
						},
					],
				}),
			).toThrow();
			expect(store.listShipRelevantDeclarationsForRun("run-1")).toEqual([]);
			store.close();
		},
	);

	it("projects the newest run sequence instead of timestamps or receipt ids", async () => {
		const store = await fixture();
		const record = (receiptId: string, frozenHeadSha: string) =>
			store.recordShipRelevantDeclarations({
				receiptId,
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				executionId: "exec-1",
				rows: [
					{
						repoIdentity: "owner/nested",
						prNumber: 42,
						probeRepoSlug: "owner/nested",
						frozenHeadSha,
						targetRepoPath: "apps/nested",
					},
				],
				now: "2026-09-06T00:00:00.000Z",
			});
		record("z-old-receipt", HEAD_A);
		record("a-new-receipt", HEAD_B);

		expect(store.projectCurrentShipRelevantCandidates("run-1")).toEqual([
			expect.objectContaining({
				receipt_id: "a-new-receipt",
				frozen_head_sha: HEAD_B,
				declaration_seq: 2,
			}),
		]);
		store.close();
	});

	it("projects later receipts across nodes instead of comparing local attempts", async () => {
		const store = await fixture();
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "node-a",
			attempt: 2,
			state: "done",
			executionId: "exec-a",
		});
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "node-b",
			attempt: 1,
			state: "done",
			executionId: "exec-b",
		});
		const record = (
			receiptId: string,
			nodeId: string,
			attempt: number,
			executionId: string,
			frozenHeadSha: string,
		) =>
			store.recordShipRelevantDeclarations({
				receiptId,
				runId: "run-1",
				nodeId,
				attempt,
				executionId,
				rows: [
					{
						repoIdentity: "owner/nested",
						prNumber: 42,
						probeRepoSlug: "owner/nested",
						frozenHeadSha,
						targetRepoPath: "apps/nested",
					},
				],
			});
		record("receipt-a", "node-a", 2, "exec-a", HEAD_A);
		record("receipt-b", "node-b", 1, "exec-b", HEAD_B);

		expect(store.projectCurrentShipRelevantCandidates("run-1")).toEqual([
			expect.objectContaining({
				node_id: "node-b",
				attempt: 1,
				frozen_head_sha: HEAD_B,
				declaration_seq: 2,
			}),
		]);
		store.close();
	});

	it("distinguishes zero, one, and ambiguous workflow run ownership", async () => {
		const store = await fixture();
		expect(store.resolveWorkflowRunForExecution("missing-exec")).toEqual({
			kind: "none",
		});
		expect(store.resolveWorkflowRunForExecution("exec-1")).toEqual({
			kind: "one",
			runId: "run-1",
		});

		store.createWorkflowRun({
			runId: "run-2",
			issueId: "FLY-2395-B",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.upsertWorkflowRunNode({
			runId: "run-2",
			nodeId: "qa",
			attempt: 1,
			state: "done",
			executionId: "exec-1",
		});
		expect(store.resolveWorkflowRunForExecution("exec-1")).toEqual({
			kind: "many",
			runIds: ["run-1", "run-2"],
		});
		store.close();
	});

	it("resolves the exact session head binding without guessing on ambiguity", async () => {
		const store = await fixture();
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		const insertBinding = (nodeId: string, receiptId: string) =>
			db.run(
				`INSERT INTO workflow_node_pr_binding
				   (run_id, node_id, attempt, pr_number, head_sha,
				    target_repo_identity, probe_repo_slug, target_repo_path,
				    worktree_binding_generation, receipt_id, bound_at)
				 VALUES ('run-1', ?, 1, 41, ?, '__main__', 'owner/main', '.',
				         'generation-1', ?, '2026-09-06T00:00:00.000Z')`,
				[nodeId, HEAD_A, receiptId],
			);

		expect(
			store.resolveWorkflowNodePrBindingForSession("exec-1", HEAD_A),
		).toEqual({ kind: "none" });
		insertBinding("implement", "binding-1");
		expect(
			store.resolveWorkflowNodePrBindingForSession("exec-1", HEAD_A),
		).toMatchObject({
			kind: "one",
			binding: { run_id: "run-1", node_id: "implement", pr_number: 41 },
		});

		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "qa",
			attempt: 1,
			state: "done",
			executionId: "exec-1",
		});
		insertBinding("qa", "binding-2");
		expect(
			store.resolveWorkflowNodePrBindingForSession("exec-1", HEAD_A),
		).toMatchObject({ kind: "many", bindings: [{}, {}] });
		store.close();
	});

	it("lists nested review heads for one execution and for its whole run", async () => {
		const store = await fixture();
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "qa",
			attempt: 1,
			state: "done",
			executionId: "exec-qa",
		});
		for (const [executionId, repoIdentity, headSha] of [
			["exec-1", "__main__", HEAD_A],
			["exec-1", "owner/nested", HEAD_A],
			["exec-qa", "owner/second", HEAD_B],
		] as const) {
			store.recordCodexReviewApproved({
				executionId,
				targetRepoIdentity: repoIdentity,
				targetPrHeadSha: headSha,
				issueId: "FLY-2395",
				projectName: "flywheel",
			});
		}

		expect(store.listNestedCodexReviewHeadsForExecution("exec-1")).toEqual([
			{ repoIdentity: "owner/nested", headSha: HEAD_A },
		]);
		expect(store.listNestedCodexReviewHeadsForRun("run-1")).toEqual([
			{ repoIdentity: "owner/nested", headSha: HEAD_A },
			{ repoIdentity: "owner/second", headSha: HEAD_B },
		]);
		store.close();
	});
});
