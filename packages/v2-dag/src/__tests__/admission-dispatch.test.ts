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
						generation: 1,
					},
					taskKind: "anything",
				},
			],
		});
		expect(spawned).toHaveLength(1);
		const request = spawned[0] as SpawnRequest;
		expect(request.agent.agentId).toBe(request.sessionRef);
		expect(request.agent.instanceId).toBe(request.sessionRef);
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

	it("records a visible skip when a ready task has lost its issue receipt", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock);
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "missing-issue-receipt",
			projectId: "project-a",
			issueId: "issue-missing-receipt",
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
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});
		fixture.kernel.write("test.remove-issue-receipt", (tx) => {
			tx.run("DELETE FROM meta WHERE key='dag_issue:issue-missing-receipt'");
		});

		const result = await dispatchOnce(fixture.kernel, ports);

		expect(result).toMatchObject({
			dispatched: [],
			skips: [
				{
					taskId: admitted.taskIds.node,
					reason: "issue_receipt_missing",
				},
			],
		});
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ task_id: string; reason: string }>(
					`SELECT task_id,
						        json_extract(payload,'$.failure_stage') AS reason
						   FROM events WHERE kind='task_dispatch_skipped'`,
				),
			),
		).toEqual({
			task_id: admitted.taskIds.node,
			reason: "issue_receipt_missing",
		});
	});

	it("does not reserve or bind any pre-registered runner identity in agents", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock);

		await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "role-without-badge",
			projectId: "project-a",
			issueId: "issue-role-without-badge",
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
						family: "family-a",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});

		const [request] = (await dispatchOnce(fixture.kernel, ports)).dispatched;
		expect(request).toMatchObject({ taskKind: "opaque" });
		expect(request?.agent.agentId).toBe(request?.sessionRef);
		// The only agents rows are the lead recipient, the Discord messenger
		// recipient (FLY-1544 ③, provisioned by the lifecycle outbox) and the
		// per-session runner: nothing role-shaped is reserved outside the
		// session identity.
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						`SELECT count(*) AS count FROM agents
						  WHERE agent_id NOT IN (@lead,@session,'discord-messenger')`,
						{ lead: "lead-a", session: request?.sessionRef },
					)?.count,
			),
		).toBe(0);
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
		expect(result.dispatched[0]).toMatchObject({
			taskKind: "opaque",
			agent: { generation: 1 },
		});
		expect(result.dispatched[0]?.agent.agentId).toBe(
			result.dispatched[0]?.sessionRef,
		);
	});

	it("keeps lead recipient names separate from task kinds", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock);

		await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "kind-namespace-admission",
			projectId: "project-a",
			issueId: "issue-kind-namespace",
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
					// A kind label that collides with a lead recipient name must stay
					// an opaque label: it never resolves to the lead's identity.
					kindLabel: "lead-a",
					contract: [],
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

		const [request] = (await dispatchOnce(fixture.kernel, ports)).dispatched;
		expect(request?.taskKind).toBe("lead-a");
		expect(request?.agent.agentId).toBe(request?.sessionRef);
	});

	it("dispatches tasks independently of later lead registrations", async () => {
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
		const raced = await admitIssueDag(fixture.kernel, ports, {
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

		expect(result.dispatched.map((item) => item.taskId).sort()).toEqual(
			[raced.taskIds.bad, healthy.taskIds.good].sort(),
		);
		expect(
			fixture.kernel.read((tx) => ({
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='task_dispatch_invalid'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='task_dispatch_invalid'",
				)?.count,
			})),
		).toEqual({ events: 0, mail: 0 });
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

	it("runs two writers with the same task kind on different worktrees", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock);
		const admitWriter = async (suffix: string) =>
			await admitIssueDag(fixture.kernel, ports, {
				admissionUid: `same-role-${suffix}`,
				projectId: "project-a",
				issueId: `issue-same-role-${suffix}`,
				notifyAgentId: "lead-a",
				shipWorktreeId: `wt-${suffix}`,
				worktrees: [
					{
						worktreeId: `wt-${suffix}`,
						repoIdentity: "owner/repo",
						worktreePath: `/tmp/wt-${suffix}`,
						branchRef: `refs/heads/${suffix}`,
						mergeTargetRef: "refs/heads/main",
					},
				],
				tasks: [
					{
						localId: "node",
						kindLabel: "opaque",
						contract: [],
						writesRepo: true,
						worktreeId: `wt-${suffix}`,
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
		const first = await admitWriter("one");
		const second = await admitWriter("two");

		const result = await dispatchOnce(fixture.kernel, ports);

		expect(result.dispatched.map((request) => request.taskId).sort()).toEqual(
			[first.taskIds.node, second.taskIds.node].sort(),
		);
		expect(result.dispatched.map((request) => request.taskKind)).toEqual([
			"opaque",
			"opaque",
		]);
		expect(
			new Set(result.dispatched.map((request) => request.sessionRef)).size,
		).toBe(2);
		for (const request of result.dispatched) {
			expect(request.agent.agentId).toBe(request.sessionRef);
		}
	});

	it("keeps ordinary launch failures isolated when a fault port is configured", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const launched: string[] = [];
		const { ports } = makePorts(fixture.clock, {
			spawn: {
				async spawn(request) {
					if (request.taskKind === "bad-kind") {
						throw new Error("ordinary spawn failure");
					}
					launched.push(request.taskId);
					return {
						v: 1,
						hostEpoch: "host-1",
						sessionId: request.sessionRef,
						pid: 10_003,
						pidStart: `test-start:${request.sessionRef}`,
					};
				},
			},
		});
		const admit = async (uid: string, kindLabel: string) =>
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
						kindLabel,
						contract: [],
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
		const bad = await admit("bad-launch", "bad-kind");
		const good = await admit("good-launch", "good-kind");

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

	it("FLY-1550: carries the issue title into the dag_issue envelope for the cmux workspace name", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock);
		const descriptor = {
			admissionUid: "admission-title",
			projectId: "project-a",
			issueId: "issue-titled",
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
					kindLabel: "generic",
					contract: [],
					writesRepo: true,
					worktreeId: "wt-a",
					executor: {
						family: "claude",
						vendor: "claude",
						model: "claude-fable-5",
						effort: "high" as const,
					},
				},
			],
			edges: [] as [string, string][],
		};
		await admitIssueDag(fixture.kernel, ports, {
			...descriptor,
			issueTitle: "[v2] cmux 自动可见:runner 起/停自动建",
		});
		const envelope = fixture.kernel.read((tx) =>
			tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
				key: "dag_issue:issue-titled",
			}),
		);
		expect(
			(JSON.parse(envelope?.value ?? "{}") as { data: Record<string, unknown> })
				.data.issue_title,
		).toBe("[v2] cmux 自动可见:runner 起/停自动建");

		// Absent title stays a stable null (pre-FLY-1550 admissions degrade, never break).
		await admitIssueDag(fixture.kernel, ports, {
			...descriptor,
			admissionUid: "admission-untitled",
			issueId: "issue-untitled",
			shipWorktreeId: "wt-b",
			worktrees: [{ ...descriptor.worktrees[0], worktreeId: "wt-b" }],
			tasks: [{ ...descriptor.tasks[0], worktreeId: "wt-b" }],
		});
		const untitled = fixture.kernel.read((tx) =>
			tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
				key: "dag_issue:issue-untitled",
			}),
		);
		expect(
			(JSON.parse(untitled?.value ?? "{}") as { data: Record<string, unknown> })
				.data.issue_title,
		).toBeUndefined();

		// A non-string title is refused at the contract boundary (the admit
		// request arrives as cast JSON, so the type needs a runtime check).
		await expect(
			admitIssueDag(fixture.kernel, ports, {
				...descriptor,
				admissionUid: "admission-bad-title",
				issueId: "issue-bad-title",
				issueTitle: 123 as unknown as string,
			}),
		).rejects.toThrow(/issueTitle must be a string/);
	});
});
