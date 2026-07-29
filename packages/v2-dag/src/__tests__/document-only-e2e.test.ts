import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	approveShipGate,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	type GitPort,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("document-only DAG", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("ships with an explicit exemption and no code approval evidence", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("writer-a", "runner");
		fixture.provision("ship-agent", "lead");
		const base = "a".repeat(40);
		const head = "b".repeat(40);
		let currentHead = base;
		const git: GitPort = {
			async readHead() {
				return currentHead;
			},
			async mergeBase() {
				return base;
			},
			async isAncestor() {
				return true;
			},
			async rawDiff() {
				return `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0product/doc/brief.md\0`;
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
				return { state: "open" as const };
			},
		};
		const githubMerge: GitHubMergePort = {
			async merge(_repo, _pr, expectedSha) {
				return { mergedSha: expectedSha };
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		const allPorts = { ...ports, githubObservation, githubMerge };
		const admitted = await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: "document-only-admission",
			projectId: "project-a",
			issueId: "issue-document-only",
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
					localId: "brief",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: "wt-a",
					executor: {
						logicalAgentId: "writer-a",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});
		const attempt = (await dispatchOnce(fixture.kernel, allPorts))
			.dispatched[0] as SpawnRequest;
		currentHead = head;
		await submitNodeCompletion(fixture.kernel, allPorts, {
			taskId: admitted.taskIds.brief as string,
			attemptId: attempt.attemptId,
			activationId: attempt.activationId,
			agent: attempt.agent,
			completionUid: "document-only-completion",
		});
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM events WHERE kind='evidence.review_approval'",
					)?.count,
			),
		).toBe(0);
		const approval = approveShipGate(fixture.kernel, allPorts, {
			issueId: "issue-document-only",
			approvalRef: "document-only-founder-approval",
			observedTip: head,
			shipTarget: { repo: "owner/repo", pr: 25 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});

		expect(
			await executeShip(fixture.kernel, allPorts, {
				issueId: "issue-document-only",
				capabilityId: approval.capabilityId as string,
				actor: {
					kind: "lead",
					agentId: "ship-agent",
					instanceId: "ship-session",
					generation: 0,
				},
			}),
		).toMatchObject({ status: "succeeded", mergedSha: head });
	});
});
