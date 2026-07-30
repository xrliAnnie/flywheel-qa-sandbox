import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	approveShipGate,
	DISCORD_MESSENGER_AGENT_ID,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	type GitPort,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

interface OutboxRow {
	kind: string;
	state: string;
	retention_class: string;
	payload: string;
}

function outboxRows(fixture: ReturnType<typeof makeFixture>): OutboxRow[] {
	return fixture.kernel.read((tx) =>
		tx.all<OutboxRow>(
			`SELECT kind,state,retention_class,payload FROM mailbox
			  WHERE to_agent=@agent ORDER BY seq`,
			{ agent: DISCORD_MESSENGER_AGENT_ID },
		),
	);
}

describe("FLY-1544 ③ — engine lifecycle rides the Discord outbox", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("emits issue_opened / task_dispatched / node_completed / pr_ready / issue_merged to the messenger", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("ship-agent", "lead");
		const base = "a".repeat(40);
		const head = "b".repeat(40);
		let currentHead = base;
		const git: GitPort = {
			async readHead() {
				return currentHead;
			},
			async mergeBase() {
				return base;
			},
			async isAncestor() {
				return true;
			},
			async rawDiff() {
				return `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0product/doc/brief.md\0`;
			},
			async readRef() {
				return head;
			},
		};
		const githubObservation: GitHubObservationPort = {
			async readPrHead() {
				return head;
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
			admissionUid: "outbox-admission",
			projectId: "project-a",
			issueId: "FLY-OUTBOX",
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

		// The recipient row is provisioned inside the admission transaction, so
		// the mailbox recipient trigger accepted the row on a fresh database.
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ kind: string }>(
						"SELECT kind FROM agents WHERE agent_id=@agent",
						{ agent: DISCORD_MESSENGER_AGENT_ID },
					)?.kind,
			),
		).toBe("lead");
		expect(outboxRows(fixture).map((row) => row.kind)).toEqual([
			"issue_opened",
		]);
		const opened = JSON.parse(outboxRows(fixture)[0]?.payload as string);
		expect(opened).toMatchObject({
			v: 1,
			issue_id: "FLY-OUTBOX",
			task_kinds: ["produce"],
		});

		const attempt = (await dispatchOnce(fixture.kernel, allPorts))
			.dispatched[0] as SpawnRequest;
		expect(outboxRows(fixture).map((row) => row.kind)).toEqual([
			"issue_opened",
			"task_dispatched",
		]);
		expect(JSON.parse(outboxRows(fixture)[1]?.payload as string)).toMatchObject(
			{
				issue_id: "FLY-OUTBOX",
				task_kind: "produce",
				attempt_id: attempt.attemptId,
			},
		);

		currentHead = head;
		await submitNodeCompletion(fixture.kernel, allPorts, {
			taskId: admitted.taskIds.brief as string,
			attemptId: attempt.attemptId,
			activationId: attempt.activationId,
			agent: attempt.agent,
			completionUid: "outbox-completion",
		});
		expect(outboxRows(fixture).map((row) => row.kind)).toEqual([
			"issue_opened",
			"task_dispatched",
			"node_completed",
		]);

		approveShipGate(fixture.kernel, allPorts, {
			issueId: "FLY-OUTBOX",
			approvalRef: "outbox-founder-approval",
			observedTip: head,
			shipTarget: { repo: "owner/repo", pr: 25 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});
		expect(outboxRows(fixture).map((row) => row.kind)).toEqual([
			"issue_opened",
			"task_dispatched",
			"node_completed",
			"pr_ready",
		]);
		expect(JSON.parse(outboxRows(fixture)[3]?.payload as string)).toMatchObject(
			{ repo: "owner/repo", pr: 25, head },
		);

		const gate = fixture.kernel.read((tx) =>
			tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
				key: "ship_gate:FLY-OUTBOX",
			}),
		);
		const capabilityId = (
			JSON.parse(gate?.value as string) as {
				data: { capability_id: string };
			}
		).data.capability_id;
		const shipped = await executeShip(fixture.kernel, allPorts, {
			issueId: "FLY-OUTBOX",
			capabilityId,
			actor: fixture.kernel.read((tx) => {
				const agent = tx.get<{ generation: number }>(
					"SELECT generation FROM agents WHERE agent_id='ship-agent'",
				);
				return {
					kind: "lead" as const,
					agentId: "ship-agent",
					instanceId: "ship-agent",
					generation: agent?.generation ?? 0,
				};
			}),
		});
		expect(shipped.status).toBe("succeeded");
		const rows = outboxRows(fixture);
		expect(rows.map((row) => row.kind)).toEqual([
			"issue_opened",
			"task_dispatched",
			"node_completed",
			"pr_ready",
			"issue_merged",
		]);
		expect(JSON.parse(rows[4]?.payload as string)).toMatchObject({
			issue_id: "FLY-OUTBOX",
			merged_sha: head,
		});
		// Lifecycle rows are business class — never shed by notice backpressure.
		expect(new Set(rows.map((row) => row.retention_class))).toEqual(
			new Set(["business"]),
		);
		// FLY-1544 founder ruling: every lifecycle event is COPIED to the lead's
		// mailbox too (one engine write, two recipients — never a serial relay).
		const leadCopies = fixture.kernel.read((tx) =>
			tx.all<{ kind: string }>(
				`SELECT kind FROM mailbox
				  WHERE to_agent='lead-a' AND source_id LIKE '%#lead'
				  ORDER BY seq`,
			),
		);
		expect(leadCopies.map((row) => row.kind)).toEqual([
			"issue_opened",
			"task_dispatched",
			"node_completed",
			"pr_ready",
			"issue_merged",
		]);
	});
});
