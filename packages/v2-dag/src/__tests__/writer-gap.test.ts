import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	adoptWriterGap,
	dispatchOnce,
	mintWriterAdoptionCapability,
	recoverPendingLaunches,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("writer gap adoption", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("rejects an unauthenticated writer gap without admitting any ledger rows", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const anchor = "a".repeat(40);
		const head = "b".repeat(40);
		const { ports } = makePorts(fixture.clock, {
			git: {
				async readHead() {
					return head;
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
					return head;
				},
			},
		});
		await expect(
			admitIssueDag(fixture.kernel, ports, {
				admissionUid: "gap-admission",
				projectId: "project-a",
				issueId: "issue-gap",
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
			}),
		).rejects.toThrow(
			/worktree wt-a has unauthenticated commits.*issue issue-gap/,
		);
		expect(
			fixture.kernel.read((tx) => ({
				tasks: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM tasks WHERE external_issue_id='issue-gap'",
				)?.count,
				issue: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM meta WHERE key='dag_issue:issue-gap'",
				)?.count,
				worktree: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM meta WHERE key='canonical_worktree:wt-a'",
				)?.count,
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='writer_gap_detected'",
				)?.count,
			})),
		).toEqual({ tasks: 0, issue: 0, worktree: 0, events: 0 });
	});

	it("requires a one-shot lost-open capability before releasing an unrecoverable writer", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		const anchor = "a".repeat(40);
		const { ports } = makePorts(fixture.clock, {
			git: {
				async readHead() {
					return anchor;
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
				async readRef(_repoIdentity, ref) {
					return ref === anchor ? anchor : null;
				},
			},
			worktreeRef: {
				async worktreePresent() {
					return false;
				},
				async readExactRef(_repoIdentity, ref) {
					return ref === anchor ? anchor : null;
				},
			},
		});
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "lost-open-admission",
			projectId: "project-a",
			issueId: "issue-lost-open",
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
		const first = (await dispatchOnce(fixture.kernel, ports)).dispatched[0];
		fixture.clock.advance(60_001);

		expect(await recoverPendingLaunches(fixture.kernel, ports)).toMatchObject({
			reaped: 0,
		});
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>("SELECT state FROM tasks WHERE id=@id", {
						id: admitted.taskIds.node,
					})?.state,
			),
		).toBe("running");
		const writerRevision = fixture.kernel.read(
			(tx) =>
				tx.get<{ revision: number }>(
					"SELECT json_extract(value,'$.revision') AS revision FROM meta WHERE key='writer_chain:wt-a'",
				)?.revision,
		);
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "lead-session",
			generation: 0,
		};
		const capability = mintWriterAdoptionCapability(fixture.kernel, ports, {
			mode: "lost_open_attempt",
			authorizationUid: "authorize-lost-open-1",
			worktreeId: "wt-a",
			attemptId: first?.attemptId as string,
			writerRevision: writerRevision as number,
			startHead: anchor,
			resolutionHead: anchor,
			attributionFamily: "family-a",
			reason: "worktree_and_ref_unrecoverable",
			actor,
		});
		const adopted = await adoptWriterGap(fixture.kernel, ports, {
			mode: "lost_open_attempt",
			worktreeId: "wt-a",
			attemptId: first?.attemptId as string,
			writerRevision: writerRevision as number,
			startHead: anchor,
			resolutionHead: anchor,
			attributionFamily: "family-a",
			reason: "worktree_and_ref_unrecoverable",
			capabilityId: capability.capabilityId,
			adoptionUid: "adopt-lost-open-1",
			actor,
		});

		expect(adopted).toEqual({ status: "adopted", worktreeId: "wt-a" });
		expect(
			fixture.kernel.read((tx) => ({
				task: tx.get<{ state: string }>(
					"SELECT state FROM tasks WHERE id=@taskId",
					{ taskId: admitted.taskIds.node },
				)?.state,
				attempt: tx.get<{ state: string; terminal_reason: string }>(
					"SELECT desired_state AS state,terminal_reason FROM attempts WHERE id=@attemptId",
					{ attemptId: first?.attemptId },
				),
				activation: tx.get<{ state: string }>(
					"SELECT state FROM activations WHERE id=@activationId",
					{ activationId: first?.activationId },
				)?.state,
				writer: tx.get<{ value: string }>(
					"SELECT value FROM meta WHERE key='writer_chain:wt-a'",
				)?.value,
				consumed: tx.get<{ consumed_at: string | null }>(
					"SELECT consumed_at FROM capabilities WHERE id=@capabilityId",
					{ capabilityId: capability.capabilityId },
				)?.consumed_at,
				events: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='lost_writer_span_adopted'",
				)?.count,
				mail: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE kind='lost_writer_span_adopted'",
				)?.count,
			})),
		).toMatchObject({
			task: "ready",
			attempt: { state: "terminal", terminal_reason: "failed" },
			activation: "terminal",
			consumed: expect.any(String),
			events: 1,
			mail: 1,
		});
		expect(
			JSON.parse(
				fixture.kernel.read(
					(tx) =>
						tx.get<{ value: string }>(
							"SELECT value FROM meta WHERE key='writer_chain:wt-a'",
						)?.value as string,
				),
			).data,
		).toMatchObject({
			chain_head: anchor,
			open_attempt: null,
			span_author_set: ["family-a"],
		});
		expect(
			(await dispatchOnce(fixture.kernel, ports)).dispatched[0],
		).toMatchObject({
			attemptGeneration: 2,
		});
	});
});
