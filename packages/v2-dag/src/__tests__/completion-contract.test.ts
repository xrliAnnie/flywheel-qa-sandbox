import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	type GitPort,
	recordEvidence,
	registerReviewFamilies,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("completion contract runtime", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("audits exhausted reviewer families without terminalizing the node", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("writer-a", "runner");
		fixture.provision("reviewer-a", "lead");
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
				return `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0packages/app/src/index.ts\0`;
			},
			async readRef() {
				return currentHead;
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: {
				"family-a": { reviewerAgentId: "reviewer-a" },
			},
		});
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "exhausted-admission",
			projectId: "project-a",
			issueId: "issue-exhausted",
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
					localId: "node",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: "wt-a",
					executor: {
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});
		const attempt = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		currentHead = head;

		expect(
			await submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.node as string,
				attemptId: attempt.attemptId,
				activationId: attempt.activationId,
				agent: attempt.agent,
				completionUid: "exhausted-completion",
			}),
		).toMatchObject({ status: "contract_pending", gateId: null });
		expect(
			fixture.kernel.read((tx) => ({
				task: tx.get<{ state: string }>(
					"SELECT state FROM tasks WHERE id=@taskId",
					{ taskId: admitted.taskIds.node },
				)?.state,
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='review_family_exhausted'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='review_family_exhausted'",
				)?.count,
			})),
		).toEqual({ task: "running", events: 1, mail: 1 });
	});

	it("rejects evidence from an agent other than the task executor", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("writer-a", "runner");
		fixture.provision("impostor-a", "runner");
		const { ports } = makePorts(fixture.clock);
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "evidence-binding",
			projectId: "project-a",
			issueId: "issue-evidence-binding",
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
					localId: "node",
					kindLabel: "opaque",
					contract: [{ kind: "verdict" }],
					writesRepo: false,
					worktreeId: null,
					executor: {
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});
		const attempt = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;

		expect(() =>
			recordEvidence(fixture.kernel, ports, {
				eventUid: "forged-verdict",
				kind: "verdict",
				taskId: admitted.taskIds.node as string,
				attemptId: attempt.attemptId,
				head: "head-a",
				verdict: "pass",
				producer: {
					kind: "runner",
					agentId: "impostor-a",
					instanceId: attempt.sessionRef,
					generation: 0,
					activationId: attempt.activationId,
				},
			}),
		).toThrow(/producer binding is stale/);
	});

	it("replays an unchanged review-family configuration without a new revision", () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("reviewer-a", "lead");
		const { ports } = makePorts(fixture.clock);
		const input = {
			projectId: "project-a",
			families: { "family-a": { reviewerAgentId: "reviewer-a" } },
		};

		registerReviewFamilies(fixture.kernel, ports, input);
		registerReviewFamilies(fixture.kernel, ports, input);

		expect(
			fixture.kernel.read((tx) => ({
				revision: tx.get<{ revision: number }>(
					"SELECT json_extract(value,'$.revision') AS revision FROM meta WHERE key='review_families:project-a'",
				)?.revision,
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='review_families_updated'",
				)?.count,
			})),
		).toEqual({ revision: 1, events: 1 });
	});

	it("resolves a shared reviewer family within the supplied project", () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("reviewer-a", "lead");
		const { ports } = makePorts(fixture.clock);
		for (const projectId of ["project-a", "project-b"]) {
			registerReviewFamilies(fixture.kernel, ports, {
				projectId,
				families: { shared: { reviewerAgentId: "reviewer-a" } },
			});
		}

		expect(() =>
			recordEvidence(fixture.kernel, ports, {
				eventUid: "shared-review",
				kind: "review_approval",
				projectId: "project-a",
				review: "code",
				subjectDigest: "subject-a",
				reviewer: { agentId: "reviewer-a", generation: 0 },
			} as Parameters<typeof recordEvidence>[2]),
		).not.toThrow();
	});

	it("audits an anchor divergence instead of silently dropping the span", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("writer-a", "runner");
		const git: GitPort = {
			async readHead() {
				return "head-b";
			},
			async mergeBase() {
				return "head-b";
			},
			async isAncestor() {
				return false;
			},
			async rawDiff() {
				throw new Error("diff must not run");
			},
			async readRef() {
				return "head-b";
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "diverged-admission",
			projectId: "project-a",
			issueId: "issue-diverged",
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
					localId: "node",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: "wt-a",
					executor: {
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});
		const attempt = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.node as string,
				attemptId: attempt.attemptId,
				activationId: attempt.activationId,
				agent: attempt.agent,
				completionUid: "diverged-completion",
			}),
		).rejects.toThrow(/span anchor diverged/);
		expect(
			fixture.kernel.read((tx) => ({
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='span_anchor_diverged'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='span_anchor_diverged'",
				)?.count,
			})),
		).toEqual({ events: 1, mail: 1 });
	});
});
