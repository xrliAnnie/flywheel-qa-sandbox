import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	approveShipGate,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	type GitPort,
	observeNodeCompletion,
	recordEvidence,
	registerReviewFamilies,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

function rawModify(path: string, oldSha: string, newSha: string): string {
	return `:100644 100644 ${oldSha} ${newSha} M\0${path}\0`;
}

describe("three-node DAG to generic ship", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("derives completion contracts from output and ships after exactly the generic predicates", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		for (const [agent, kind] of [
			["lead-a", "lead"],
			["docs-agent", "runner"],
			["code-agent", "runner"],
			["test-agent", "runner"],
			["reviewer-b", "lead"],
			["ship-agent", "lead"],
		] as const) {
			fixture.provision(agent, kind);
		}
		let head = "a".repeat(40);
		const diffs = new Map<string, string>();
		let mergedHead: string | null = null;
		const git: GitPort = {
			async readHead() {
				return head;
			},
			async mergeBase() {
				return "a".repeat(40);
			},
			async isAncestor() {
				return true;
			},
			async rawDiff(_path, base, tip) {
				return diffs.get(`${base}:${tip}`) ?? "";
			},
			async readRef() {
				return head;
			},
		};
		const githubObservation: GitHubObservationPort = {
			async readPrHead() {
				return head;
			},
			async readMergeState() {
				return mergedHead === null
					? { state: "open" as const }
					: { state: "merged" as const, head: mergedHead };
			},
		};
		const githubMerge: GitHubMergePort = {
			async merge(_repo, _pr, expectedSha) {
				expect(expectedSha).toBe(head);
				mergedHead = expectedSha;
				return { mergedSha: expectedSha };
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		const allPorts = { ...ports, githubObservation, githubMerge };

		registerReviewFamilies(fixture.kernel, allPorts, {
			projectId: "project-a",
			families: {
				"family-a": { reviewerAgentId: "lead-a" },
				"family-b": { reviewerAgentId: "reviewer-b" },
			},
		});
		const admitted = await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: "e2e-admission",
			projectId: "project-a",
			issueId: "issue-e2e",
			notifyAgentId: "lead-a",
			shipWorktreeId: "wt-a",
			worktrees: [
				{
					worktreeId: "wt-a",
					repoIdentity: "owner/repo",
					worktreePath: "/tmp/wt-a",
					branchRef: "refs/heads/feature",
					mergeTargetRef: "refs/heads/main",
				},
			],
			tasks: [
				{
					localId: "first",
					kindLabel: "uninterpreted-a",
					contract: [],
					writesRepo: true,
					worktreeId: "wt-a",
					executor: {
						logicalAgentId: "docs-agent",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
				{
					localId: "second",
					kindLabel: "uninterpreted-b",
					contract: [],
					writesRepo: true,
					worktreeId: "wt-a",
					executor: {
						logicalAgentId: "code-agent",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
				{
					localId: "third",
					kindLabel: "uninterpreted-c",
					contract: [{ kind: "verdict" }],
					writesRepo: false,
					worktreeId: null,
					executor: {
						logicalAgentId: "test-agent",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [
				["first", "second"],
				["second", "third"],
			],
		});

		const first = (await dispatchOnce(fixture.kernel, allPorts))
			.dispatched[0] as SpawnRequest;
		const docsHead = "b".repeat(40);
		diffs.set(
			`${head}:${docsHead}`,
			rawModify("engineering/doc/spec.md", "1".repeat(40), "2".repeat(40)),
		);
		head = docsHead;
		await submitNodeCompletion(fixture.kernel, allPorts, {
			taskId: admitted.taskIds.first as string,
			attemptId: first.attemptId,
			activationId: first.activationId,
			agent: first.agent,
			completionUid: "complete-first",
		});

		const second = (await dispatchOnce(fixture.kernel, allPorts))
			.dispatched[0] as SpawnRequest;
		const codeHead = "c".repeat(40);
		diffs.set(
			`${head}:${codeHead}`,
			rawModify("packages/app/src/index.ts", "3".repeat(40), "4".repeat(40)),
		);
		head = codeHead;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			allPorts,
			admitted.taskIds.second as string,
		);
		await expect(
			submitNodeCompletion(fixture.kernel, allPorts, {
				taskId: admitted.taskIds.second as string,
				attemptId: second.attemptId,
				activationId: second.activationId,
				agent: second.agent,
				completionUid: "complete-second-missing-evidence",
				observation: {
					...observation,
					manifest: [],
				},
			} as Parameters<typeof submitNodeCompletion>[2]),
		).rejects.toThrow(/contract/i);
		recordEvidence(fixture.kernel, allPorts, {
			eventUid: "evidence-code-approval",
			kind: "review_approval",
			projectId: "project-a",
			review: "code",
			subjectDigest: observation.reviewSubjectDigest,
			reviewer: { agentId: "reviewer-b", generation: 0 },
		});
		await submitNodeCompletion(fixture.kernel, allPorts, {
			taskId: admitted.taskIds.second as string,
			attemptId: second.attemptId,
			activationId: second.activationId,
			agent: second.agent,
			completionUid: "complete-second",
		});

		const third = (await dispatchOnce(fixture.kernel, allPorts))
			.dispatched[0] as SpawnRequest;
		recordEvidence(fixture.kernel, allPorts, {
			eventUid: "evidence-test-verdict",
			kind: "verdict",
			taskId: admitted.taskIds.third as string,
			attemptId: third.attemptId,
			head,
			verdict: "pass",
			producer: third.agent,
		});
		await submitNodeCompletion(fixture.kernel, allPorts, {
			taskId: admitted.taskIds.third as string,
			attemptId: third.attemptId,
			activationId: third.activationId,
			agent: third.agent,
			completionUid: "complete-third",
		});

		const approval = approveShipGate(fixture.kernel, allPorts, {
			issueId: "issue-e2e",
			approvalRef: "founder-approval-1",
			observedTip: head,
			shipTarget: { repo: "owner/repo", pr: 123 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config-1",
			},
		});
		const shipped = await executeShip(fixture.kernel, allPorts, {
			issueId: "issue-e2e",
			capabilityId: approval.capabilityId as string,
			actor: {
				kind: "lead",
				agentId: "ship-agent",
				instanceId: "ship-session",
				generation: 0,
			},
		});

		expect(shipped).toMatchObject({ status: "succeeded", mergedSha: head });
		expect(mergedHead).toBe(head);
		const audit = fixture.kernel.read((tx) => ({
			done: tx.get<{ count: number }>(
				"SELECT count(*) AS count FROM tasks WHERE external_issue_id='issue-e2e' AND state='done'",
			)?.count,
			completion: tx.get<{ payload: string }>(
				"SELECT payload FROM events WHERE event_uid='node_completed:complete-third'",
			)?.payload,
		}));
		expect(audit.done).toBe(3);
		expect(JSON.parse(audit.completion ?? "{}")).toMatchObject({
			manifest_digest: expect.any(String),
			satisfied_items: [{ kind: "verdict" }],
			evidence_refs: ["evidence-test-verdict"],
		});
	});
});
