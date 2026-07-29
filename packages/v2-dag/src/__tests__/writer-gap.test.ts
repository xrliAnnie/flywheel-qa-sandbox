import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	adoptWriterGap,
	dispatchOnce,
	mintWriterAdoptionCapability,
	observeNodeCompletion,
	recoverPendingLaunches,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

describe("writer gap adoption", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("fails dispatch closed until an audited capability adopts the exact gap", async () => {
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
		await admitIssueDag(fixture.kernel, ports, {
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

		expect((await dispatchOnce(fixture.kernel, ports)).dispatched).toEqual([]);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM events WHERE kind='writer_gap_detected'",
					)?.count,
			),
		).toBe(1);
		const capability = mintWriterAdoptionCapability(fixture.kernel, ports, {
			authorizationUid: "authorize-gap-1",
			worktreeId: "wt-a",
			fromHead: anchor,
			toHead: head,
			attributionFamily: "family-import",
			reason: "pre-admission commits",
			actor: {
				kind: "lead",
				agentId: "lead-a",
				instanceId: "lead-session",
				generation: 0,
			},
		});
		const adopted = await adoptWriterGap(fixture.kernel, ports, {
			worktreeId: "wt-a",
			fromHead: anchor,
			toHead: head,
			attributionFamily: "family-import",
			reason: "pre-admission commits",
			capabilityId: capability.capabilityId,
			adoptionUid: "adopt-gap-1",
			actor: {
				kind: "lead",
				agentId: "lead-a",
				instanceId: "lead-session",
				generation: 0,
			},
		});

		expect(adopted).toEqual({ status: "adopted", worktreeId: "wt-a" });
		const dispatched = (await dispatchOnce(fixture.kernel, ports)).dispatched;
		expect(dispatched).toHaveLength(1);
		expect(
			await observeNodeCompletion(
				fixture.kernel,
				ports,
				dispatched[0]?.taskId as string,
			),
		).toMatchObject({ base: anchor, head });
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ head: string }>(
						"SELECT json_extract(value,'$.data.head') AS head FROM meta WHERE key='span_tip:wt-a'",
					)?.head,
			),
		).toBe(anchor);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ authors: string }>(
						"SELECT json_extract(value,'$.data.span_author_set') AS authors FROM meta WHERE key='writer_chain:wt-a'",
					)?.authors,
			),
		).toBe('["family-import"]');
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
