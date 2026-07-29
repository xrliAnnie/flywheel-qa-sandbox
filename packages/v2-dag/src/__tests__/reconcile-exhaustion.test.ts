import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	approveShipGate,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	reconcileShipActions,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

async function prepareDueRetry(
	fixture: ReturnType<typeof makeFixture>,
	issueId: string,
) {
	fixture.provision("lead-a", "lead");
	fixture.provision("agent-a", "runner");
	fixture.provision("ship-agent", "lead");
	const head = "head-a";
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
			throw new Error("transient");
		},
	};
	const { ports } = makePorts(fixture.clock);
	const allPorts = { ...ports, githubObservation, githubMerge };
	const admitted = await admitIssueDag(fixture.kernel, allPorts, {
		admissionUid: `${issueId}-admission`,
		projectId: "project-a",
		issueId,
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
		completionUid: `${issueId}-completion`,
	});
	const approval = approveShipGate(fixture.kernel, allPorts, {
		issueId,
		approvalRef: `${issueId}-approval`,
		observedTip: head,
		shipTarget: { repo: "owner/repo", pr: 43 },
		actorConfig: {
			defaultActionAgentId: "ship-agent",
			configDigest: "config",
		},
	});
	expect(
		await executeShip(fixture.kernel, allPorts, {
			issueId,
			capabilityId: approval.capabilityId as string,
			actor: {
				kind: "lead",
				agentId: "ship-agent",
				instanceId: "ship-session",
				generation: 0,
			},
		}),
	).toMatchObject({ status: "failed" });
	return allPorts;
}

function retryExpirationState(
	fixture: ReturnType<typeof makeFixture>,
	issueId: string,
) {
	return fixture.kernel.read((tx) => ({
		gate: tx.get<{ state: string; next_retry_at: string | null }>(
			`SELECT json_extract(value,'$.data.state') AS state,
			        json_extract(value,'$.data.retry.next_retry_at') AS next_retry_at
			   FROM meta
			  WHERE key=@key`,
			{ key: `ship_gate:${issueId}` },
		),
		audit: tx.get<{ count: number }>(
			"SELECT count(*) AS count FROM gates WHERE state='expired'",
		)?.count,
		event: tx.get<{ count: number }>(
			"SELECT count(*) AS count FROM events WHERE kind='ship_retry_exhausted'",
		)?.count,
		mail: tx.get<{ count: number }>(
			"SELECT count(*) AS count FROM mailbox WHERE kind='ship_retry_exhausted' AND to_agent='lead-a'",
		)?.count,
	}));
}

describe("ship reconciliation exhaustion", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("expires and notifies the founder in the transaction that settles the final rejected intent", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		fixture.provision("ship-agent", "lead");
		const head = "head-a";
		const githubObservation: GitHubObservationPort = {
			async readPrHead() {
				return head;
			},
			async readMergeState() {
				return {
					state: "rejected" as const,
					evidenceRef: "github:rejected:42",
				};
			},
		};
		const githubMerge: GitHubMergePort = {
			async merge() {
				return { mergedSha: head };
			},
		};
		const { ports } = makePorts(fixture.clock);
		const allPorts = { ...ports, githubObservation, githubMerge };
		const admitted = await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: "reconcile-exhaustion-admission",
			projectId: "project-a",
			issueId: "issue-reconcile-exhaustion",
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
			completionUid: "reconcile-exhaustion-completion",
		});
		const approval = approveShipGate(fixture.kernel, allPorts, {
			issueId: "issue-reconcile-exhaustion",
			approvalRef: "reconcile-exhaustion-approval",
			observedTip: head,
			shipTarget: { repo: "owner/repo", pr: 42 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});
		fixture.kernel.write("test.set-final-reconcile-attempt", (tx) => {
			tx.run(
				`UPDATE meta
				    SET value=json_set(
				      value,
				      '$.data.retry.max_attempts',1,
				      '$.revision',json_extract(value,'$.revision')+1
				    )
				  WHERE key='ship_gate:issue-reconcile-exhaustion'`,
			);
		});
		await expect(
			executeShip(
				fixture.kernel,
				{
					...allPorts,
					faults: {
						hit(point) {
							if (point === "ship_after_merge") throw new Error("crash");
						},
					},
				},
				{
					issueId: "issue-reconcile-exhaustion",
					capabilityId: approval.capabilityId as string,
					actor: {
						kind: "lead",
						agentId: "ship-agent",
						instanceId: "ship-session",
						generation: 0,
					},
				},
			),
		).rejects.toThrow("crash");

		expect(await reconcileShipActions(fixture.kernel, allPorts)).toMatchObject({
			failed: 1,
		});
		expect(
			fixture.kernel.read((tx) => ({
				gate: tx.get<{ state: string; next_retry_at: string | null }>(
					`SELECT json_extract(value,'$.data.state') AS state,
					        json_extract(value,'$.data.retry.next_retry_at') AS next_retry_at
					   FROM meta
					  WHERE key='ship_gate:issue-reconcile-exhaustion'`,
				),
				audit: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM gates WHERE state='expired'",
				)?.count,
				event: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='ship_retry_exhausted'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='ship_retry_exhausted' AND to_agent='lead-a'",
				)?.count,
			})),
		).toEqual({
			gate: { state: "expired", next_retry_at: null },
			audit: 1,
			event: 1,
			mail: 1,
		});
	});

	it("audits and notifies when a due retry has already reached its attempt limit", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const issueId = "issue-due-max";
		const ports = await prepareDueRetry(fixture, issueId);
		fixture.kernel.write("test.lower-due-max", (tx) => {
			tx.run(
				`UPDATE meta
				    SET value=json_set(
				      value,
				      '$.data.retry.max_attempts',1,
				      '$.revision',json_extract(value,'$.revision')+1
				    )
				  WHERE key=@key`,
				{ key: `ship_gate:${issueId}` },
			);
		});
		fixture.clock.advance(120_001);

		expect(await reconcileShipActions(fixture.kernel, ports)).toMatchObject({
			rearmed: 0,
		});
		expect(retryExpirationState(fixture, issueId)).toEqual({
			gate: { state: "expired", next_retry_at: null },
			audit: 1,
			event: 1,
			mail: 1,
		});
	});

	it("audits and notifies when a due retry no longer has valid DAG and head prerequisites", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const issueId = "issue-due-invalid";
		const ports = await prepareDueRetry(fixture, issueId);
		fixture.kernel.write("test.move-due-span", (tx) => {
			tx.run(
				`UPDATE meta
				    SET value=json_set(
				      value,
				      '$.data.head','head-b',
				      '$.revision',json_extract(value,'$.revision')+1
				    )
				  WHERE key='span_tip:wt-a'`,
			);
		});
		fixture.clock.advance(120_001);

		expect(await reconcileShipActions(fixture.kernel, ports)).toMatchObject({
			rearmed: 0,
		});
		expect(retryExpirationState(fixture, issueId)).toEqual({
			gate: { state: "expired", next_retry_at: null },
			audit: 1,
			event: 1,
			mail: 1,
		});
	});
});
