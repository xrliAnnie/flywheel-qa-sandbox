import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	recoverPendingLaunches,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("dispatch crash replay", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("reconstructs the durable spawn request after prepare committed before launch", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const { ports, spawned } = makePorts(fixture.clock);
		await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "dispatch-crash-admission",
			projectId: "project-a",
			issueId: "issue-dispatch-crash",
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
		await expect(
			dispatchOnce(fixture.kernel, {
				...ports,
				faults: {
					hit(point) {
						if (point === "dispatch_after_prepare") throw new Error("crash");
					},
				},
			}),
		).rejects.toThrow("crash");
		expect(spawned).toHaveLength(0);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ desired_state: string }>(
						"SELECT desired_state FROM attempts",
					)?.desired_state,
			),
		).toBe("dispatched");

		const recovered = await recoverPendingLaunches(fixture.kernel, ports);

		expect(recovered).toMatchObject({ launched: 1 });
		expect(spawned).toHaveLength(1);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ desired_state: string }>(
						"SELECT desired_state FROM attempts",
					)?.desired_state,
			),
		).toBe("started");
	});
});
