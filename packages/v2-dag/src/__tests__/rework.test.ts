import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	type GitPort,
	observeNodeCompletion,
	type ProcessProbePort,
	type RunnerControlPort,
	reworkTask,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("same-task rework", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("creates a new attempt on the same task and invalidates prior ship authority", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const { ports } = makePorts(fixture.clock);
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "rework-admission",
			projectId: "project-a",
			issueId: "issue-rework",
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
		const first = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		await submitNodeCompletion(fixture.kernel, ports, {
			taskId: admitted.taskIds.node as string,
			attemptId: first.attemptId,
			activationId: first.activationId,
			agent: first.agent,
			completionUid: "complete-before-rework",
		});

		const result = await reworkTask(fixture.kernel, ports, {
			issueId: "issue-rework",
			taskId: admitted.taskIds.node as string,
			reworkUid: "rework-1",
		});

		expect(result.status).toBe("reworked");
		expect(result.dispatch?.taskId).toBe(admitted.taskIds.node);
		expect(result.dispatch?.attemptGeneration).toBe(2);
		expect(result.dispatch?.agent.generation).toBe(2);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ state: string }>(
					"SELECT json_extract(value,'$.data.state') AS state FROM meta WHERE key='ship_gate:issue-rework'",
				),
			),
		).toEqual({ state: "expired" });
	});

	it("stops and fences an active suite before replacing it on the same task", async () => {
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
		let processState: "present" | "absent" = "present";
		const stopped: string[] = [];
		const process: ProcessProbePort = {
			async probe() {
				return {
					state: processState,
					confirmedAt: fixture.clock.nowIso(),
				};
			},
		};
		const runnerControl: RunnerControlPort = {
			async requestStop(sessionRef) {
				stopped.push(sessionRef);
				processState = "absent";
			},
		};
		const { ports } = makePorts(fixture.clock, {
			git,
			process,
			runnerControl,
		});
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "active-rework-admission",
			projectId: "project-a",
			issueId: "issue-active-rework",
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
		const first = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		currentHead = head;

		const result = await reworkTask(fixture.kernel, ports, {
			issueId: "issue-active-rework",
			taskId: admitted.taskIds.node as string,
			reworkUid: "active-rework-1",
		});

		expect(stopped).toEqual([first.sessionRef]);
		expect(result).toMatchObject({
			status: "reworked",
			taskId: admitted.taskIds.node,
			dispatch: { attemptGeneration: 2 },
		});
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ terminal_reason: string }>(
					"SELECT terminal_reason FROM attempts WHERE id=@attemptId",
					{ attemptId: first.attemptId },
				),
			),
		).toEqual({ terminal_reason: "superseded" });
		expect(
			await observeNodeCompletion(
				fixture.kernel,
				ports,
				result.dispatch?.taskId as string,
			),
		).toMatchObject({ base: anchor, head });
	});
});
