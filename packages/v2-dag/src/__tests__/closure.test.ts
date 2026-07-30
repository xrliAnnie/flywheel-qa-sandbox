import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	approveShipGate,
	closeShippedIssues,
	DISCORD_MESSENGER_AGENT_ID,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	type GitPort,
	type IssueCleanupPort,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

async function shipIssue(
	fixture: ReturnType<typeof makeFixture>,
	issueId: string,
) {
	fixture.provision("lead-a", "lead");
	fixture.provision("ship-agent", "lead");
	let currentHead = BASE;
	const git: GitPort = {
		async readHead() {
			return currentHead;
		},
		async mergeBase() {
			return BASE;
		},
		async isAncestor() {
			return true;
		},
		async rawDiff() {
			return `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0product/doc/brief.md\0`;
		},
		async readRef() {
			return HEAD;
		},
	};
	const githubObservation: GitHubObservationPort = {
		async readPrHead() {
			return HEAD;
		},
		async readMergeState() {
			return { state: "open" as const };
		},
	};
	const githubMerge: GitHubMergePort = {
		async merge(_repo, _pr, expectedSha) {
			return { mergedSha: expectedSha };
		},
	};
	const { ports } = makePorts(fixture.clock, { git });
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
				worktreePath: "/tmp/closure-wt-a",
				branchRef: "refs/heads/feat/closure",
				mergeTargetRef: "refs/heads/main",
			},
		],
		tasks: [
			{
				localId: "brief",
				kindLabel: "produce",
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
	const attempt = (await dispatchOnce(fixture.kernel, allPorts))
		.dispatched[0] as SpawnRequest;
	currentHead = HEAD;
	await submitNodeCompletion(fixture.kernel, allPorts, {
		taskId: admitted.taskIds.brief as string,
		attemptId: attempt.attemptId,
		activationId: attempt.activationId,
		agent: attempt.agent,
		completionUid: `${issueId}-completion`,
	});
	approveShipGate(fixture.kernel, allPorts, {
		issueId,
		approvalRef: `${issueId}-approval`,
		observedTip: HEAD,
		shipTarget: { repo: "owner/repo", pr: 31 },
		actorConfig: { defaultActionAgentId: "ship-agent", configDigest: "cfg" },
	});
	const capabilityId = fixture.kernel.read(
		(tx) =>
			(
				JSON.parse(
					tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
						key: `ship_gate:${issueId}`,
					})?.value as string,
				) as { data: { capability_id: string } }
			).data.capability_id,
	);
	const shipped = await executeShip(fixture.kernel, allPorts, {
		issueId,
		capabilityId,
		actor: {
			kind: "lead",
			agentId: "ship-agent",
			instanceId: "ship-agent",
			generation: fixture.kernel.read(
				(tx) =>
					tx.get<{ generation: number }>(
						"SELECT generation FROM agents WHERE agent_id='ship-agent'",
					)?.generation ?? 0,
			),
		},
	});
	expect(shipped.status).toBe("succeeded");
	return { allPorts, attempt };
}

describe("FLY-1544 ⑤⑥ — whole-issue closure after the merge", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("stops every live session, removes the worktree, CAS-deletes the remote branch, clears registrations, archives", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { allPorts, attempt } = await shipIssue(fixture, "FLY-CLOSE");
		const stopped: string[] = [];
		const removed: string[] = [];
		const branchDeletes: Array<Record<string, string>> = [];
		const cleanup: IssueCleanupPort = {
			async worktreeClean() {
				return true;
			},
			async removeWorktree(worktreePath) {
				removed.push(worktreePath);
				return { mainRepoPath: "/tmp/main-repo" };
			},
			async deleteRemoteBranch(input) {
				branchDeletes.push(input as unknown as Record<string, string>);
				return { deleted: true, sha: input.expectedSha };
			},
		};
		const closurePorts = {
			...allPorts,
			runnerControl: {
				async requestStop(sessionRef: string) {
					stopped.push(sessionRef);
				},
			},
			issueCleanup: cleanup,
		};

		const first = await closeShippedIssues(fixture.kernel, closurePorts);
		expect(first).toEqual({ examined: 1, closed: 1, failed: 0 });
		// ⑤: the issue's session was stopped and its activation settled.
		expect(stopped).toEqual([attempt.sessionRef]);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM activations WHERE id=@id",
						{ id: attempt.activationId },
					)?.state,
			),
		).toBe("terminal");
		// ⑥: worktree removed, remote branch CAS-deleted against the span tip,
		// registrations cleared.
		expect(removed).toEqual(["/tmp/closure-wt-a"]);
		expect(branchDeletes).toEqual([
			{
				mainRepoPath: "/tmp/main-repo",
				branch: "feat/closure",
				expectedSha: HEAD,
			},
		]);
		expect(
			fixture.kernel.read((tx) =>
				tx
					.all<{ key: string }>(
						`SELECT key FROM meta WHERE key IN
						 ('canonical_worktree:wt-a','span_tip:wt-a','writer_chain:wt-a')`,
					)
					.map((row) => row.key),
			),
		).toEqual([]);
		// The wrap-up is visible: issue_closed event + messenger row + lead copy.
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM events WHERE kind='issue_closed'",
					)?.count,
			),
		).toBe(1);
		const closedRows = fixture.kernel.read((tx) =>
			tx.all<{ to_agent: string }>(
				"SELECT to_agent FROM mailbox WHERE kind='issue_closed' ORDER BY seq",
			),
		);
		expect(closedRows.map((row) => row.to_agent)).toEqual([
			DISCORD_MESSENGER_AGENT_ID,
			"lead-a",
		]);

		// Fire-once: the second pass sees the marker and does nothing.
		const second = await closeShippedIssues(fixture.kernel, closurePorts);
		expect(second).toEqual({ examined: 0, closed: 0, failed: 0 });
		expect(stopped).toHaveLength(1);
	});

	it("keeps a dirty worktree, its branch and its registrations, with visible residue", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { allPorts } = await shipIssue(fixture, "FLY-DIRTY");
		const removed: string[] = [];
		const closurePorts = {
			...allPorts,
			runnerControl: { async requestStop() {} },
			issueCleanup: {
				async worktreeClean() {
					return false as const;
				},
				async removeWorktree(worktreePath: string) {
					removed.push(worktreePath);
					return { mainRepoPath: "/tmp/main-repo" };
				},
				async deleteRemoteBranch() {
					throw new Error("must not delete a kept worktree's branch");
				},
			},
		};
		const result = await closeShippedIssues(fixture.kernel, closurePorts);
		expect(result).toEqual({ examined: 1, closed: 1, failed: 0 });
		expect(removed).toEqual([]);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM events WHERE kind='issue_closure_residue'",
					)?.count,
			),
		).toBe(1);
		expect(
			fixture.kernel.read((tx) =>
				tx.get("SELECT 1 FROM meta WHERE key='canonical_worktree:wt-a'"),
			),
		).toBeTruthy();
	});

	it("finalizes as failed with a visible event and never retries", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		const { allPorts } = await shipIssue(fixture, "FLY-FAILC");
		let removals = 0;
		const closurePorts = {
			...allPorts,
			runnerControl: { async requestStop() {} },
			issueCleanup: {
				async worktreeClean() {
					return true as const;
				},
				async removeWorktree(): Promise<{ mainRepoPath: string }> {
					removals += 1;
					throw new Error("git refused the removal");
				},
				async deleteRemoteBranch() {
					throw new Error("unreachable");
				},
			},
		};
		const result = await closeShippedIssues(fixture.kernel, closurePorts);
		expect(result).toEqual({ examined: 1, closed: 0, failed: 1 });
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ payload: string }>(
						"SELECT payload FROM events WHERE kind='issue_closure_step_failed'",
					)?.payload,
			),
		).toContain("git refused the removal");
		const marker = fixture.kernel.read((tx) =>
			tx.get<{ value: string }>(
				"SELECT value FROM meta WHERE key='issue_closure:FLY-FAILC'",
			),
		);
		expect(JSON.parse(marker?.value as string).data.state).toBe("failed");
		// No retry, no daemon: the next pass skips the failed marker entirely.
		const second = await closeShippedIssues(fixture.kernel, closurePorts);
		expect(second).toEqual({ examined: 0, closed: 0, failed: 0 });
		expect(removals).toBe(1);
	});
});
