import { afterEach, describe, expect, it } from "vitest";
import { terminalizeAttemptTx } from "../attempt-terminal.js";
import { admitIssueDag, dispatchOnce, type SpawnRequest } from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

const HEAD = "a".repeat(40);

describe("attempt terminal holding release", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];

	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	async function runningWriter() {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		const { ports } = makePorts(fixture.clock, {
			git: {
				async readHead() {
					return HEAD;
				},
				async mergeBase() {
					return HEAD;
				},
				async isAncestor() {
					return true;
				},
				async rawDiff() {
					return "";
				},
				async readRef() {
					return HEAD;
				},
			},
		});
		await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "attempt-terminal",
			projectId: "project-a",
			issueId: "issue-attempt-terminal",
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
		const request = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		fixture.kernel.write("test.add-running-delivery", (tx) => {
			tx.run(
				`INSERT INTO processing_attempts
				 (attempt_uid,message_uid,attempt_no,instance_id,generation,
				  activation_id,started_at,outcome)
				 SELECT 'delivery-running',message_uid,1,@sessionRef,@generation,
				        @activationId,@now,'running'
				   FROM mailbox
				  WHERE source_kind='dag_task_dispatch' AND source_id=@activationId`,
				{
					sessionRef: request.sessionRef,
					generation: request.attemptGeneration,
					activationId: request.activationId,
					now: fixture.clock.nowIso(),
				},
			);
		});
		return { fixture, ports, request };
	}

	it("releases session, delivery, launch lease, and writer lock atomically", async () => {
		const { fixture, ports, request } = await runningWriter();

		fixture.kernel.write("test.terminal-attempt", (tx) => {
			terminalizeAttemptTx(tx, {
				attemptId: request.attemptId,
				reason: "failed",
				cutoverEpoch: 1,
				nowIso: ports.clock.nowIso(),
			});
		});

		expect(
			fixture.kernel.read((tx) => ({
				attempt: tx.get<{ state: string; reason: string }>(
					`SELECT desired_state AS state,terminal_reason AS reason
					   FROM attempts WHERE id=@attemptId`,
					{ attemptId: request.attemptId },
				),
				activation: tx.get<{ state: string }>(
					"SELECT state FROM activations WHERE id=@activationId",
					{ activationId: request.activationId },
				)?.state,
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE source_id=@activationId",
					{ activationId: request.activationId },
				)?.state,
				processing: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='delivery-running'",
				)?.outcome,
				claim: tx.get<{
					state: string;
					owner: string | null;
					lease: string | null;
				}>(
					`SELECT json_extract(value,'$.data.state') AS state,
					        json_extract(value,'$.data.owner_token') AS owner,
					        json_extract(value,'$.data.lease_until') AS lease
					   FROM meta WHERE key=@key`,
					{ key: `launch_claim:${request.sessionRef}` },
				),
				writer: tx.get<{ openAttempt: string | null }>(
					`SELECT json_extract(value,'$.data.open_attempt') AS openAttempt
					   FROM meta WHERE key='writer_chain:wt-a'`,
				)?.openAttempt,
				runnerBadges: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM agents WHERE kind='runner'",
				)?.count,
			})),
		).toEqual({
			attempt: { state: "terminal", reason: "failed" },
			activation: "terminal",
			mailbox: "dead",
			processing: "crashed",
			claim: { state: "tombstoned", owner: null, lease: null },
			writer: null,
			runnerBadges: 0,
		});
	});

	it("rolls the terminal transition back if an owned writer lock is corrupt", async () => {
		const { fixture, ports, request } = await runningWriter();
		fixture.kernel.write("test.corrupt-writer-generation", (tx) => {
			tx.run(
				`UPDATE meta
				    SET value=json_set(value,'$.data.open_attempt.generation',99)
				  WHERE key='writer_chain:wt-a'`,
			);
		});

		expect(() =>
			fixture.kernel.write("test.terminal-attempt-corrupt", (tx) => {
				terminalizeAttemptTx(tx, {
					attemptId: request.attemptId,
					reason: "failed",
					cutoverEpoch: 1,
					nowIso: ports.clock.nowIso(),
				});
			}),
		).toThrow(/writer lock generation/i);
		expect(
			fixture.kernel.read((tx) => ({
				attempt: tx.get<{ state: string }>(
					"SELECT desired_state AS state FROM attempts WHERE id=@attemptId",
					{ attemptId: request.attemptId },
				)?.state,
				activation: tx.get<{ state: string }>(
					"SELECT state FROM activations WHERE id=@activationId",
					{ activationId: request.activationId },
				)?.state,
				claim: tx.get<{ state: string }>(
					`SELECT json_extract(value,'$.data.state') AS state
					   FROM meta WHERE key=@key`,
					{ key: `launch_claim:${request.sessionRef}` },
				)?.state,
			})),
		).toEqual({
			attempt: "started",
			activation: "active",
			claim: "launched",
		});
	});
});
