import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	type GitPort,
	type SpawnRequest,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("DAG admission and dispatch", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("admits an arbitrary node and durably launches its first activation", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const { ports, spawned } = makePorts(fixture.clock);

		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "admission-1",
			projectId: "project-a",
			issueId: "issue-a",
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
					localId: "node-a",
					kindLabel: "anything",
					contract: [],
					writesRepo: true,
					worktreeId: "wt-a",
					executor: {
						logicalAgentId: "agent-a",
						family: "family-a",
						vendor: "vendor-a",
						model: "model-a",
						effort: "high",
					},
				},
			],
			edges: [],
		});

		const result = await dispatchOnce(fixture.kernel, ports);

		expect(result).toMatchObject({
			dispatched: [
				{
					taskId: admitted.taskIds["node-a"],
					attemptGeneration: 1,
					agent: {
						kind: "runner",
						agentId: "agent-a",
						generation: 1,
					},
				},
			],
		});
		expect(spawned).toHaveLength(1);
		const request = spawned[0] as SpawnRequest;
		expect(request.sessionRef).toContain(`:${request.activationId}`);
		expect(request.ownerToken).not.toHaveLength(0);

		const durable = fixture.kernel.read((tx) => ({
			task: tx.get<{ state: string }>("SELECT state FROM tasks WHERE id=@id", {
				id: admitted.taskIds["node-a"],
			}),
			attempt: tx.get<{ desired_state: string }>(
				"SELECT desired_state FROM attempts WHERE id=@id",
				{ id: request.attemptId },
			),
			activation: tx.get<{ generation: number; state: string }>(
				"SELECT generation,state FROM activations WHERE id=@id",
				{ id: request.activationId },
			),
		}));
		expect(durable).toEqual({
			task: { state: "running" },
			attempt: { desired_state: "started" },
			activation: { generation: 1, state: "active" },
		});
	});

	it("admits the bounded 500-task graph in one kernel transaction", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock);
		const tasks = Array.from({ length: 500 }, (_, index) => ({
			localId: `node-${index}`,
			kindLabel: "opaque",
			contract: [],
			writesRepo: false,
			worktreeId: null,
			executor: {
				logicalAgentId: `agent-${index}`,
				family: "family-a",
				vendor: "vendor",
				model: "model",
				effort: "high",
			},
		}));
		const edges = Array.from(
			{ length: tasks.length - 1 },
			(_, index) => [`node-${index}`, `node-${index + 1}`] as [string, string],
		);
		const started = performance.now();

		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "admission-500",
			projectId: "project-a",
			issueId: "issue-500",
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
			tasks,
			edges,
		});

		expect(Object.keys(admitted.taskIds)).toHaveLength(500);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM tasks WHERE external_issue_id='issue-500'",
					)?.count,
			),
		).toBe(500);
	});

	it("rejects incomplete worktree identity before touching git", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		let gitReads = 0;
		const { ports } = makePorts(fixture.clock, {
			git: {
				async readHead() {
					gitReads += 1;
					return "head-a";
				},
				async mergeBase() {
					gitReads += 1;
					return "head-a";
				},
				async isAncestor() {
					return true;
				},
				async rawDiff() {
					return "";
				},
				async readRef() {
					return "head-a";
				},
			},
		});

		await expect(
			admitIssueDag(fixture.kernel, ports, {
				admissionUid: "invalid-worktree",
				projectId: "project-a",
				issueId: "issue-invalid",
				notifyAgentId: "lead-a",
				shipWorktreeId: "wt-a",
				worktrees: [
					{
						worktreeId: "wt-a",
						repoIdentity: " ",
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
						writesRepo: false,
						worktreeId: null,
						executor: {
							logicalAgentId: "agent-a",
							family: "family-a",
							vendor: "vendor",
							model: "model",
							effort: "high",
						},
					},
				],
				edges: [],
			}),
		).rejects.toThrow(/repoIdentity is empty/);
		expect(gitReads).toBe(0);
	});

	it("audits an invalid stored contract and continues dispatching", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		fixture.provision("agent-b", "runner");
		const { ports } = makePorts(fixture.clock);
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "runtime-contract-invalid",
			projectId: "project-a",
			issueId: "issue-contract-invalid",
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
					localId: "bad",
					kindLabel: "opaque-a",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: {
						logicalAgentId: "agent-a",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
				{
					localId: "good",
					kindLabel: "opaque-b",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: {
						logicalAgentId: "agent-b",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});
		fixture.kernel.write("test.corrupt-contract", (tx) => {
			tx.run("UPDATE tasks SET payload='{}' WHERE id=@taskId", {
				taskId: admitted.taskIds.bad,
			});
		});

		const result = await dispatchOnce(fixture.kernel, ports);

		expect(result.dispatched.map((item) => item.taskId)).toEqual([
			admitted.taskIds.good,
		]);
		expect(
			fixture.kernel.read((tx) => ({
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='task_contract_invalid'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='task_contract_invalid'",
				)?.count,
			})),
		).toEqual({ events: 1, mail: 1 });
	});

	it("rejects a previously activated executor with no v2 binding", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("legacy-agent", "runner");
		fixture.kernel.write("test.legacy-generation", (tx) => {
			tx.run("UPDATE agents SET generation=1 WHERE agent_id='legacy-agent'");
		});
		const { ports } = makePorts(fixture.clock);

		await expect(
			admitIssueDag(fixture.kernel, ports, {
				admissionUid: "legacy-binding",
				projectId: "project-a",
				issueId: "issue-legacy-binding",
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
						writesRepo: false,
						worktreeId: null,
						executor: {
							logicalAgentId: "legacy-agent",
							family: "family-a",
							vendor: "vendor",
							model: "model",
							effort: "high",
						},
					},
				],
				edges: [],
			}),
		).rejects.toThrow(/missing v2 binding/);
	});

	it("provisions a never-before-seen executor during dispatch", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock);
		await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "fresh-executor",
			projectId: "project-a",
			issueId: "issue-fresh-executor",
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
					writesRepo: false,
					worktreeId: null,
					executor: {
						logicalAgentId: "fresh-agent",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});

		const result = await dispatchOnce(fixture.kernel, ports);

		expect(result.dispatched).toHaveLength(1);
		expect(result.dispatched[0]?.agent).toMatchObject({
			agentId: "fresh-agent",
			generation: 1,
		});
	});

	it("rejects an executor identity already owned by a lead", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock);

		await expect(
			admitIssueDag(fixture.kernel, ports, {
				admissionUid: "kind-collision-admission",
				projectId: "project-a",
				issueId: "issue-kind-collision",
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
						writesRepo: false,
						worktreeId: null,
						executor: {
							logicalAgentId: "lead-a",
							family: "family-a",
							vendor: "vendor",
							model: "model",
							effort: "high",
						},
					},
				],
				edges: [],
			}),
		).rejects.toThrow(/executor lead-a is a lead/);
	});

	it("audits a post-admission identity collision and dispatches later candidates", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("healthy-agent", "runner");
		const { ports } = makePorts(fixture.clock);
		const descriptor = {
			projectId: "project-a",
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
			edges: [] as [string, string][],
		};
		await admitIssueDag(fixture.kernel, ports, {
			...descriptor,
			admissionUid: "collision-race",
			issueId: "issue-collision-race",
			tasks: [
				{
					localId: "bad",
					kindLabel: "opaque-a",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: {
						logicalAgentId: "raced-agent",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
		});
		const healthy = await admitIssueDag(fixture.kernel, ports, {
			...descriptor,
			admissionUid: "healthy-after-collision",
			issueId: "issue-healthy-after-collision",
			shipWorktreeId: "wt-b",
			worktrees: [
				{
					worktreeId: "wt-b",
					repoIdentity: "owner/repo",
					worktreePath: "/tmp/wt-b",
					branchRef: "refs/heads/healthy",
					mergeTargetRef: "refs/heads/main",
				},
			],
			tasks: [
				{
					localId: "good",
					kindLabel: "opaque-b",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: {
						logicalAgentId: "healthy-agent",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
		});
		fixture.provision("raced-agent", "lead");

		const result = await dispatchOnce(fixture.kernel, ports);

		expect(result.dispatched.map((item) => item.taskId)).toEqual([
			healthy.taskIds.good,
		]);
		expect(
			fixture.kernel.read((tx) => ({
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='task_dispatch_invalid'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='task_dispatch_invalid'",
				)?.count,
			})),
		).toEqual({ events: 1, mail: 1 });
	});

	it("audits changing candidate-local failures without starving later candidates", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("healthy-agent", "runner");
		let failedReads = 0;
		let worktreeUnavailable = false;
		const git: GitPort = {
			async readHead(path) {
				if (worktreeUnavailable && path === "/tmp/gone") {
					failedReads += 1;
					throw new Error(`worktree unavailable ${failedReads}`);
				}
				return "head-a";
			},
			async mergeBase() {
				return "head-a";
			},
			async isAncestor() {
				return true;
			},
			async rawDiff() {
				return "";
			},
			async readRef() {
				return "head-a";
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "vanished-worktree",
			projectId: "project-a",
			issueId: "issue-vanished-worktree",
			notifyAgentId: "lead-a",
			shipWorktreeId: "wt-gone",
			worktrees: [
				{
					worktreeId: "wt-gone",
					repoIdentity: "owner/repo",
					worktreePath: "/tmp/gone",
					branchRef: "refs/heads/gone",
					mergeTargetRef: "refs/heads/main",
				},
			],
			tasks: [
				{
					localId: "bad",
					kindLabel: "opaque-a",
					contract: [],
					writesRepo: true,
					worktreeId: "wt-gone",
					executor: {
						logicalAgentId: "missing-agent",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});
		worktreeUnavailable = true;

		await expect(dispatchOnce(fixture.kernel, ports)).resolves.toMatchObject({
			dispatched: [],
			failures: [
				{
					stage: "worktree_head",
					audited: true,
				},
			],
		});

		const healthy = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "healthy-after-worktree-failure",
			projectId: "project-a",
			issueId: "issue-healthy-after-worktree-failure",
			notifyAgentId: "lead-a",
			shipWorktreeId: "wt-healthy",
			worktrees: [
				{
					worktreeId: "wt-healthy",
					repoIdentity: "owner/repo",
					worktreePath: "/tmp/healthy",
					branchRef: "refs/heads/healthy",
					mergeTargetRef: "refs/heads/main",
				},
			],
			tasks: [
				{
					localId: "good",
					kindLabel: "opaque-b",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: {
						logicalAgentId: "healthy-agent",
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});

		const result = await dispatchOnce(fixture.kernel, ports);

		expect(result.dispatched.map((item) => item.taskId)).toEqual([
			healthy.taskIds.good,
		]);
		expect(failedReads).toBe(2);
		expect(
			fixture.kernel.read((tx) => ({
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='task_dispatch_invalid'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='task_dispatch_invalid'",
				)?.count,
			})),
		).toEqual({ events: 1, mail: 1 });
	});

	it("keeps ordinary launch failures isolated when a fault port is configured", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("bad-agent", "runner");
		fixture.provision("good-agent", "runner");
		const launched: string[] = [];
		const { ports } = makePorts(fixture.clock, {
			spawn: {
				async spawn(request) {
					if (request.agent.agentId === "bad-agent") {
						throw new Error("ordinary spawn failure");
					}
					launched.push(request.taskId);
				},
			},
		});
		const admit = async (uid: string, agentId: string) =>
			await admitIssueDag(fixture.kernel, ports, {
				admissionUid: uid,
				projectId: "project-a",
				issueId: `issue-${uid}`,
				notifyAgentId: "lead-a",
				shipWorktreeId: `wt-${uid}`,
				worktrees: [
					{
						worktreeId: `wt-${uid}`,
						repoIdentity: "owner/repo",
						worktreePath: `/tmp/${uid}`,
						branchRef: `refs/heads/${uid}`,
						mergeTargetRef: "refs/heads/main",
					},
				],
				tasks: [
					{
						localId: "node",
						kindLabel: "opaque",
						contract: [],
						writesRepo: false,
						worktreeId: null,
						executor: {
							logicalAgentId: agentId,
							family: "family-a",
							vendor: "vendor",
							model: "model",
							effort: "high",
						},
					},
				],
				edges: [],
			});
		const bad = await admit("bad-launch", "bad-agent");
		const good = await admit("good-launch", "good-agent");

		const result = await dispatchOnce(fixture.kernel, {
			...ports,
			faults: { hit() {} },
		});

		expect(result).toMatchObject({
			dispatched: [{ taskId: good.taskIds.node }],
			failures: [
				{
					taskId: bad.taskIds.node,
					stage: "launch",
					audited: true,
				},
			],
		});
		expect(launched).toEqual([good.taskIds.node]);
	});
});
