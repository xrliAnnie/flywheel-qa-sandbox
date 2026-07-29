import { recordActionIntent } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	approveShipGate,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	reconcileShipActions,
	recoverShipAuthority,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("external action crash replay", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("settles an intended action from world truth after merge succeeded before outcome commit", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		fixture.provision("ship-agent", "lead");
		const head = "head-a";
		let merged = false;
		let mergeCalls = 0;
		const githubObservation: GitHubObservationPort = {
			async readPrHead() {
				return head;
			},
			async readMergeState() {
				return merged
					? { state: "merged" as const, head }
					: { state: "open" as const };
			},
		};
		const githubMerge: GitHubMergePort = {
			async merge() {
				mergeCalls += 1;
				merged = true;
				return { mergedSha: head };
			},
		};
		const { ports } = makePorts(fixture.clock);
		const basePorts = { ...ports, githubObservation, githubMerge };
		const admitted = await admitIssueDag(fixture.kernel, basePorts, {
			admissionUid: "crash-admission",
			projectId: "project-a",
			issueId: "issue-crash",
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
		const attempt = (await dispatchOnce(fixture.kernel, basePorts))
			.dispatched[0] as SpawnRequest;
		await submitNodeCompletion(fixture.kernel, basePorts, {
			taskId: admitted.taskIds.node as string,
			attemptId: attempt.attemptId,
			activationId: attempt.activationId,
			agent: attempt.agent,
			completionUid: "crash-completion",
		});
		const approval = approveShipGate(fixture.kernel, basePorts, {
			issueId: "issue-crash",
			approvalRef: "approval-crash",
			observedTip: head,
			shipTarget: { repo: "owner/repo", pr: 22 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});
		fixture.kernel.write("test.rotate-ship-actor", (tx) => {
			tx.run(
				`UPDATE agents
				    SET generation=1,
				        instance_id='ship-session',
				        session_binding=@sessionBinding
				  WHERE agent_id='ship-agent' AND generation=0`,
				{
					sessionBinding: JSON.stringify({
						v: 1,
						host_epoch: "host-1",
						session_id: "ship-session",
						pid: 9_998,
						pid_start: "ship-start",
					}),
				},
			);
		});
		expect(await reconcileShipActions(fixture.kernel, basePorts)).toMatchObject(
			{ authorityRecovered: 1 },
		);
		const recoveredCapabilityId = fixture.kernel.read(
			(tx) =>
				tx.get<{ capability_id: string }>(
					"SELECT json_extract(value,'$.data.capability_id') AS capability_id FROM meta WHERE key='ship_gate:issue-crash'",
				)?.capability_id,
		);
		expect(recoveredCapabilityId).not.toBe(approval.capabilityId);
		const actor = {
			kind: "lead" as const,
			agentId: "ship-agent",
			instanceId: "ship-session",
			generation: 1,
		};
		await expect(
			executeShip(
				fixture.kernel,
				{
					...basePorts,
					faults: {
						hit(point) {
							if (point === "ship_after_merge") throw new Error("crash");
						},
					},
				},
				{
					issueId: "issue-crash",
					capabilityId: recoveredCapabilityId as string,
					actor,
				},
			),
		).rejects.toThrow("crash");

		expect(mergeCalls).toBe(1);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM actions WHERE state='intended'",
					)?.count,
			),
		).toBe(1);
		expect(await reconcileShipActions(fixture.kernel, basePorts)).toMatchObject(
			{ settled: 1 },
		);
		expect(mergeCalls).toBe(1);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM events WHERE kind='ship_completed'",
					)?.count,
			),
		).toBe(1);
	});

	it("rearms one due capability and records an evidenced successor after a failed effect", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		fixture.provision("ship-agent", "lead");
		const head = "head-a";
		let mergeCalls = 0;
		const githubObservation: GitHubObservationPort = {
			async readPrHead() {
				return head;
			},
			async readMergeState() {
				return { state: "open" as const };
			},
		};
		const githubMerge: GitHubMergePort = {
			async merge() {
				mergeCalls += 1;
				if (mergeCalls <= 2) throw new Error("transient");
				return { mergedSha: head };
			},
		};
		const { ports } = makePorts(fixture.clock);
		const allPorts = { ...ports, githubObservation, githubMerge };
		const admitted = await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: "retry-admission",
			projectId: "project-a",
			issueId: "issue-retry",
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
		const attempt = (await dispatchOnce(fixture.kernel, allPorts))
			.dispatched[0] as SpawnRequest;
		await submitNodeCompletion(fixture.kernel, allPorts, {
			taskId: admitted.taskIds.node as string,
			attemptId: attempt.attemptId,
			activationId: attempt.activationId,
			agent: attempt.agent,
			completionUid: "retry-completion",
		});
		const approval = approveShipGate(fixture.kernel, allPorts, {
			issueId: "issue-retry",
			approvalRef: "approval-retry",
			observedTip: head,
			shipTarget: { repo: "owner/repo", pr: 23 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});
		fixture.kernel.write("test.lower-retry-limit", (tx) => {
			tx.run(
				`UPDATE meta
				    SET value=json_set(
				      value,
				      '$.data.retry.max_attempts',2,
				      '$.revision',json_extract(value,'$.revision')+1
				    )
				  WHERE key='ship_gate:issue-retry'`,
			);
		});
		const actor = {
			kind: "lead" as const,
			agentId: "ship-agent",
			instanceId: "ship-session",
			generation: 0,
		};
		expect(
			await executeShip(fixture.kernel, allPorts, {
				issueId: "issue-retry",
				capabilityId: approval.capabilityId as string,
				actor,
			}),
		).toMatchObject({ status: "failed" });
		fixture.clock.advance(1);
		fixture.kernel.write("test.fill-action-window", (tx) => {
			for (let index = 0; index < 101; index += 1) {
				recordActionIntent(tx, {
					id: `noise-${index.toString().padStart(3, "0")}`,
					actor: {
						kind: "lead",
						agentId: "ship-agent",
						instanceId: "ship-session",
						generation: 0,
					},
					kind: "noise",
					payload: { index },
					logicalEffectId: `noise-${index}`,
					invocationUid: `noise-invocation-${index}`,
					cutoverEpoch: 1,
					createdAt: fixture.clock.nowIso(),
				});
			}
		});
		fixture.clock.advance(120_001);

		expect(await reconcileShipActions(fixture.kernel, allPorts)).toMatchObject({
			rearmed: 1,
		});
		const capabilityId = fixture.kernel.read(
			(tx) =>
				tx.get<{ capability_id: string }>(
					"SELECT json_extract(value,'$.data.capability_id') AS capability_id FROM meta WHERE key='ship_gate:issue-retry'",
				)?.capability_id,
		);
		expect(capabilityId).not.toBe(approval.capabilityId);
		expect(
			await executeShip(fixture.kernel, allPorts, {
				issueId: "issue-retry",
				capabilityId: capabilityId as string,
				actor,
			}),
		).toMatchObject({ status: "failed" });
		expect(
			fixture.kernel.read((tx) => ({
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='ship_retry_exhausted'",
				)?.count,
				expiredAudit: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM gates WHERE state='expired'",
				)?.count,
			})),
		).toEqual({ mail: 1, expiredAudit: 1 });
		const reopened = approveShipGate(fixture.kernel, allPorts, {
			issueId: "issue-retry",
			approvalRef: "approval-retry-fresh",
			observedTip: head,
			shipTarget: { repo: "owner/repo", pr: 23 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});
		expect(reopened.capabilityId).not.toBe(capabilityId);
		expect(
			await executeShip(fixture.kernel, allPorts, {
				issueId: "issue-retry",
				capabilityId: reopened.capabilityId as string,
				actor,
			}),
		).toMatchObject({ status: "succeeded" });
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM actions WHERE kind='github_merge'",
					)?.count,
			),
		).toBe(3);
	});

	it("keeps an approved gate blocked until fresh founder authority selects an available actor", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const head = "head-a";
		const { ports } = makePorts(fixture.clock);
		const allPorts = {
			...ports,
			githubObservation: {
				async readPrHead() {
					return head;
				},
				async readMergeState() {
					return { state: "open" as const };
				},
			} satisfies GitHubObservationPort,
			githubMerge: {
				async merge() {
					return { mergedSha: head };
				},
			} satisfies GitHubMergePort,
		};
		const admitted = await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: "authority-admission",
			projectId: "project-a",
			issueId: "issue-authority",
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
		const attempt = (await dispatchOnce(fixture.kernel, allPorts))
			.dispatched[0] as SpawnRequest;
		await submitNodeCompletion(fixture.kernel, allPorts, {
			taskId: admitted.taskIds.node as string,
			attemptId: attempt.attemptId,
			activationId: attempt.activationId,
			agent: attempt.agent,
			completionUid: "authority-completion",
		});
		const blocked = approveShipGate(fixture.kernel, allPorts, {
			issueId: "issue-authority",
			approvalRef: "approval-authority",
			observedTip: head,
			shipTarget: { repo: "owner/repo", pr: 24 },
			actorConfig: {
				defaultActionAgentId: "not-provisioned",
				configDigest: "config-old",
			},
		});
		expect(blocked.capabilityId).toBeNull();
		expect(
			fixture.kernel.read((tx) => ({
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='ship_action_blocked'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='ship_action_blocked'",
				)?.count,
			})),
		).toEqual({ events: 1, mail: 1 });
		fixture.provision("ship-agent", "lead");

		const recovered = recoverShipAuthority(fixture.kernel, allPorts, {
			issueId: "issue-authority",
			recoveryRef: "founder-recovery-1",
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config-new",
			},
		});

		expect(recovered.capabilityId).toEqual(expect.any(String));
		expect(
			await executeShip(fixture.kernel, allPorts, {
				issueId: "issue-authority",
				capabilityId: recovered.capabilityId,
				actor: {
					kind: "lead",
					agentId: "ship-agent",
					instanceId: "ship-session",
					generation: 0,
				},
			}),
		).toMatchObject({ status: "succeeded" });
	});
});
