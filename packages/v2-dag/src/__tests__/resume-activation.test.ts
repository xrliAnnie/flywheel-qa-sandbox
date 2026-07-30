import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	resumeActivation,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("attempt session activation generations", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("reuses the attempt while rotating sessions at the attempt generation", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const { ports } = makePorts(fixture.clock);
		await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "resume-admission",
			projectId: "project-a",
			issueId: "issue-resume",
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
		fixture.clock.advance(1_000);

		const resumed = await resumeActivation(fixture.kernel, ports, {
			attemptId: first.attemptId,
		});

		expect(resumed.attemptId).toBe(first.attemptId);
		expect(resumed.activationId).not.toBe(first.activationId);
		expect(resumed.sessionRef).not.toBe(first.sessionRef);
		expect(resumed.sessionRef).toContain(`:${resumed.activationId}`);
		expect(resumed.agent.generation).toBe(1);
		expect(
			fixture.kernel.read((tx) =>
				tx.all<{ generation: number; state: string }>(
					"SELECT generation,state FROM activations WHERE attempt_id=@attemptId ORDER BY rowid",
					{ attemptId: first.attemptId },
				),
			),
		).toEqual([
			{ generation: 1, state: "terminal" },
			{ generation: 1, state: "active" },
		]);
		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: first.taskId,
				attemptId: first.attemptId,
				activationId: first.activationId,
				agent: first.agent,
				completionUid: "late-old-generation",
			}),
		).rejects.toThrow(/stale|activation/i);

		fixture.clock.advance(1_000);
		const resumedAgain = await resumeActivation(fixture.kernel, ports, {
			attemptId: first.attemptId,
		});

		expect(resumedAgain.attemptId).toBe(first.attemptId);
		expect(resumedAgain.agent.generation).toBe(1);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ active: number; terminal: number }>(
					`SELECT
						   sum(state='active') AS active,
						   sum(state='terminal') AS terminal
						 FROM activations WHERE attempt_id=@attemptId`,
					{ attemptId: first.attemptId },
				),
			),
		).toEqual({ active: 1, terminal: 2 });
		expect(
			fixture.kernel.read((tx) =>
				tx.all<{ state: string; count: number }>(
					`SELECT json_extract(value,'$.data.state') AS state,
					        count(*) AS count
					   FROM meta WHERE key LIKE 'launch_claim:%'
					  GROUP BY state ORDER BY state`,
				),
			),
		).toEqual([
			{ state: "launched", count: 1 },
			{ state: "tombstoned", count: 2 },
		]);
	});
});
