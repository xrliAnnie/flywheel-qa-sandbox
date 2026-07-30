import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	type GitPort,
	observeNodeCompletion,
	recoverPendingLaunches,
	type SpawnRequest,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

async function admitOne(
	fixture: ReturnType<typeof makeFixture>,
	ports: ReturnType<typeof makePorts>["ports"],
	uid: string,
	writesRepo = false,
) {
	return await admitIssueDag(fixture.kernel, ports, {
		admissionUid: uid,
		projectId: "project-a",
		issueId: `issue-${uid}`,
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
				writesRepo,
				worktreeId: writesRepo ? "wt-a" : null,
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
	});
}

async function admitWriter(
	fixture: ReturnType<typeof makeFixture>,
	ports: ReturnType<typeof makePorts>["ports"],
	input: {
		uid: string;
		agentId: string;
		worktreeId: string;
		worktreePath: string;
	},
) {
	return await admitIssueDag(fixture.kernel, ports, {
		admissionUid: input.uid,
		projectId: "project-a",
		issueId: `issue-${input.uid}`,
		notifyAgentId: "lead-a",
		shipWorktreeId: input.worktreeId,
		worktrees: [
			{
				worktreeId: input.worktreeId,
				repoIdentity: "owner/repo",
				worktreePath: input.worktreePath,
				branchRef: `refs/heads/${input.uid}`,
				mergeTargetRef: "refs/heads/main",
			},
		],
		tasks: [
			{
				localId: "node",
				kindLabel: "opaque",
				contract: [],
				writesRepo: true,
				worktreeId: input.worktreeId,
				executor: {
					logicalAgentId: input.agentId,
					family: "family-a",
					vendor: "vendor",
					model: "model",
					effort: "high",
				},
			},
		],
		edges: [],
	});
}

describe("launch claim recovery", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("commits the launch receipt before exec and never repeats that activation", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		let spawnCount = 0;
		const { ports } = makePorts(fixture.clock, {
			spawn: {
				async spawn(request) {
					spawnCount += 1;
					return {
						v: 1,
						hostEpoch: "host-1",
						sessionId: request.sessionRef,
						pid: 10_002,
						pidStart: `test-start:${request.sessionRef}`,
					};
				},
			},
		});
		await admitOne(fixture, ports, "launch-receipt-first");

		await expect(
			dispatchOnce(fixture.kernel, {
				...ports,
				faults: {
					hit(point) {
						if (point === "launch_after_receipt") throw new Error("crash");
					},
				},
			}),
		).rejects.toThrow("crash");
		expect(spawnCount).toBe(0);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT json_extract(value,'$.data.state') AS state FROM meta WHERE key LIKE 'launch_claim:%'",
					)?.state,
			),
		).toBe("launched");

		fixture.clock.advance(60_001);
		const recovered = await recoverPendingLaunches(fixture.kernel, ports);
		const next = await dispatchOnce(fixture.kernel, ports);

		expect(recovered).toMatchObject({ reaped: 1, launched: 0 });
		expect(spawnCount).toBe(1);
		expect(next.dispatched[0]?.attemptGeneration).toBe(2);
	});

	it("adopts a spawned session binding and keeps its assignment exactly once", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		let spawnCount = 0;
		let binding:
			| {
					v: 1;
					hostEpoch: string;
					sessionId: string;
					pid: number;
					pidStart: string;
			  }
			| undefined;
		const { ports } = makePorts(fixture.clock, {
			spawn: {
				async spawn(request) {
					spawnCount += 1;
					binding = {
						v: 1,
						hostEpoch: "host-1",
						sessionId: request.sessionRef,
						pid: 20_001,
						pidStart: `spawned:${request.sessionRef}`,
					};
					return binding;
				},
			},
			process: {
				async probe() {
					return binding
						? {
								state: "present" as const,
								confirmedAt: fixture.clock.nowIso(),
								sessionBinding: binding,
							}
						: {
								state: "absent" as const,
								confirmedAt: fixture.clock.nowIso(),
							};
				},
			},
		});
		await admitOne(fixture, ports, "launch-after-spawn");

		await expect(
			dispatchOnce(fixture.kernel, {
				...ports,
				faults: {
					hit(point) {
						if (point === "launch_after_spawn") throw new Error("crash");
					},
				},
			}),
		).rejects.toThrow("crash");
		expect(spawnCount).toBe(1);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ session_binding: string | null }>(
					"SELECT session_binding FROM activations WHERE state='active'",
				),
			),
		).toEqual({ session_binding: null });
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT COUNT(*) AS count FROM mailbox WHERE source_kind='dag_task_dispatch'",
					)?.count,
			),
		).toBe(1);

		const recovered = await recoverPendingLaunches(fixture.kernel, ports);
		await recoverPendingLaunches(fixture.kernel, ports);

		expect(recovered).toMatchObject({ adopted: 1, reaped: 0 });
		expect(spawnCount).toBe(1);
		const registered = fixture.kernel.read((tx) =>
			tx.get<{
				session_ref: string;
				generation: number;
				session_binding: string;
			}>(
				"SELECT session_ref,generation,session_binding FROM activations WHERE state='active'",
			),
		);
		expect(registered).toMatchObject({
			session_ref: binding?.sessionId,
			generation: 1,
			session_binding: expect.any(String),
		});
		expect(JSON.parse(registered?.session_binding ?? "{}")).toMatchObject({
			v: 1,
			host_epoch: binding?.hostEpoch,
			session_id: binding?.sessionId,
			pid: binding?.pid,
			pid_start: binding?.pidStart,
		});
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT COUNT(*) AS count FROM mailbox WHERE source_kind='dag_task_dispatch'",
					)?.count,
			),
		).toBe(1);
	});

	it("binds a present session while adopting an older claimed receipt", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const { ports, spawned } = makePorts(fixture.clock, {
			process: {
				async probe(sessionRef) {
					return {
						state: "present" as const,
						confirmedAt: fixture.clock.nowIso(),
						sessionBinding: {
							v: 1,
							hostEpoch: "host-1",
							sessionId: sessionRef,
							pid: 20_002,
							pidStart: `claimed:${sessionRef}`,
						},
					};
				},
			},
		});
		await admitOne(fixture, ports, "claimed-present");

		await expect(
			dispatchOnce(fixture.kernel, {
				...ports,
				faults: {
					hit(point) {
						if (point === "dispatch_after_claim") throw new Error("crash");
					},
				},
			}),
		).rejects.toThrow("crash");
		const recovered = await recoverPendingLaunches(fixture.kernel, ports);

		expect(recovered).toMatchObject({ adopted: 1, launched: 0 });
		expect(spawned).toHaveLength(0);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ count: number }>(
					`SELECT COUNT(*) AS count
					   FROM mailbox
					  WHERE source_kind='dag_task_dispatch'
					    AND to_agent LIKE 'v2dag:%'`,
				),
			),
		).toEqual({ count: 1 });
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ session_ref: string; session_binding: string | null }>(
					"SELECT session_ref,session_binding FROM activations WHERE state='active'",
				),
			),
		).toMatchObject({
			session_ref: expect.stringMatching(/^v2dag:/),
			session_binding: expect.any(String),
		});
	});

	it("takes over an expired claim only after proving the process absent", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const { ports, spawned } = makePorts(fixture.clock);
		await admitOne(fixture, ports, "launch-takeover");

		await expect(
			dispatchOnce(fixture.kernel, {
				...ports,
				faults: {
					hit(point) {
						if (point === "dispatch_after_claim") throw new Error("crash");
					},
				},
			}),
		).rejects.toThrow("crash");
		fixture.clock.advance(60_001);

		const recovered = await recoverPendingLaunches(fixture.kernel, ports);

		expect(recovered).toMatchObject({ launched: 1 });
		expect(spawned).toHaveLength(1);
	});

	it("reaps a launched suite whose process disappeared and permits a new attempt", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const anchor = "a".repeat(40);
		const head = "b".repeat(40);
		let currentHead = anchor;
		const git: GitPort = {
			async readHead() {
				return currentHead;
			},
			async mergeBase() {
				return anchor;
			},
			async isAncestor() {
				return true;
			},
			async rawDiff() {
				return "";
			},
			async readRef() {
				return currentHead;
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		const admitted = await admitOne(fixture, ports, "launch-reap", true);
		const first = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		currentHead = head;
		fixture.clock.advance(60_001);

		const recovered = await recoverPendingLaunches(fixture.kernel, ports);
		const second = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;

		expect(recovered).toMatchObject({ reaped: 1 });
		expect(second.attemptGeneration).toBe(2);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ terminal_reason: string }>(
					"SELECT terminal_reason FROM attempts WHERE id=@attemptId",
					{ attemptId: first.attemptId },
				),
			),
		).toEqual({ terminal_reason: "failed" });
		expect(second.taskId).toBe(admitted.taskIds.node);
		expect(
			await observeNodeCompletion(fixture.kernel, ports, second.taskId),
		).toMatchObject({ base: anchor, head });
	});

	it("falls back to the exact branch ref when a worktree vanished", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("bad-agent", "runner");
		fixture.provision("good-agent", "runner");
		let worktreeUnavailable = false;
		const git: GitPort = {
			async readHead(path) {
				if (worktreeUnavailable && path === "/tmp/gone") {
					throw new Error("fatal: cannot chdir /tmp/gone");
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
		const bad = await admitWriter(fixture, ports, {
			uid: "bad-recovery",
			agentId: "bad-agent",
			worktreeId: "wt-bad",
			worktreePath: "/tmp/gone",
		});
		const good = await admitWriter(fixture, ports, {
			uid: "good-recovery",
			agentId: "good-agent",
			worktreeId: "wt-good",
			worktreePath: "/tmp/good",
		});
		expect((await dispatchOnce(fixture.kernel, ports)).dispatched).toHaveLength(
			2,
		);
		fixture.clock.advance(60_001);
		worktreeUnavailable = true;

		const recovered = await recoverPendingLaunches(fixture.kernel, ports);

		expect(recovered).toMatchObject({
			examined: 2,
			reaped: 2,
			failures: [],
		});
		expect(
			fixture.kernel.read((tx) =>
				tx.all<{ id: string; state: string }>(
					"SELECT id,state FROM tasks WHERE id IN (@bad,@good) ORDER BY id",
					{ bad: bad.taskIds.node, good: good.taskIds.node },
				),
			),
		).toEqual(
			[
				{ id: bad.taskIds.node, state: "ready" },
				{ id: good.taskIds.node, state: "ready" },
			].sort((left, right) => left.id.localeCompare(right.id)),
		);
	});
});
