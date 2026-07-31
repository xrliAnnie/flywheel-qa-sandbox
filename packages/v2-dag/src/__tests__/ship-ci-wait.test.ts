import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	approveShipGate,
	CI_POLL_MS,
	CI_WAIT_MS,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	reworkTask,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

const HEAD = "a".repeat(40);

function rawModify(path: string, oldSha: string, newSha: string): string {
	return `:100644 100644 ${oldSha} ${newSha} M\0${path}\0`;
}

type CiAnswer = Awaited<ReturnType<GitHubObservationPort["readCiState"]>>;

/**
 * FLY-1545 ①: drives a one-node DAG to an approved founder ship gate, with a
 * scripted CI observation. `ciScript` is consumed one answer per readCiState
 * probe; the last answer repeats.
 */
async function approvedGateFixture(options: {
	issueId: string;
	ciScript: CiAnswer[];
	prHeads?: string[];
	writer?: boolean;
}) {
	const fixture = makeFixture();
	fixture.provision("lead-a", "lead");
	fixture.provision("agent-a", "runner");
	fixture.provision("ship-agent", "lead");
	const ciProbes: CiAnswer[] = [];
	const heads = options.prHeads ? [...options.prHeads] : [HEAD];
	let mergeCalls = 0;
	const script = [...options.ciScript];
	const githubObservation: GitHubObservationPort = {
		async readPrHead() {
			return heads.length > 1 ? (heads.shift() as string) : heads[0];
		},
		async readCiState() {
			const answer =
				script.length > 1 ? (script.shift() as CiAnswer) : script[0];
			ciProbes.push(answer);
			return answer;
		},
		async readMergeState() {
			return { state: "open" as const };
		},
	};
	const githubMerge: GitHubMergePort = {
		async merge() {
			mergeCalls += 1;
			return { mergedSha: HEAD };
		},
	};
	const state = { head: HEAD };
	const diffs = new Map<string, string>();
	const { ports } = makePorts(fixture.clock, {
		git: {
			async readHead() {
				return state.head;
			},
			async mergeBase() {
				return HEAD;
			},
			async isAncestor() {
				return true;
			},
			async rawDiff(_path, base, tip) {
				return diffs.get(`${base}:${tip}`) ?? "";
			},
			async readRef() {
				return state.head;
			},
		},
	});
	const allPorts = { ...ports, githubObservation, githubMerge };
	const admitted = await admitIssueDag(fixture.kernel, allPorts, {
		admissionUid: `${options.issueId}-admission`,
		projectId: "project-a",
		issueId: options.issueId,
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
				writesRepo: options.writer ?? false,
				worktreeId: options.writer ? "wt-a" : null,
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
	await submitNodeCompletion(fixture.kernel, allPorts, {
		taskId: admitted.taskIds.node as string,
		attemptId: attempt.attemptId,
		activationId: attempt.activationId,
		agent: attempt.agent,
		completionUid: `${options.issueId}-completion`,
	});
	const approval = approveShipGate(fixture.kernel, allPorts, {
		issueId: options.issueId,
		approvalRef: `${options.issueId}-approval`,
		observedTip: HEAD,
		shipTarget: { repo: "owner/repo", pr: 31 },
		actorConfig: {
			defaultActionAgentId: "ship-agent",
			configDigest: "config",
		},
	});
	const actor = {
		kind: "lead" as const,
		agentId: "ship-agent",
		instanceId: "ship-session",
		generation: 0,
	};
	function ledger() {
		return fixture.kernel.read((tx) => ({
			actions:
				tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM actions WHERE kind='github_merge'",
				)?.count ?? 0,
			capabilityConsumed:
				tx.get<{ consumed: string | null }>(
					"SELECT consumed_at AS consumed FROM capabilities WHERE id=@id",
					{ id: approval.capabilityId },
				)?.consumed ?? null,
			gate: tx.get<{ state: string; attempts: number }>(
				`SELECT json_extract(value,'$.data.state') AS state,
				        json_extract(value,'$.data.retry.attempt_count') AS attempts
				   FROM meta WHERE key=@key`,
				{ key: `ship_gate:${options.issueId}` },
			),
		}));
	}
	return {
		fixture,
		allPorts,
		admitted,
		attempt,
		approval,
		actor,
		ledger,
		state,
		diffs,
		ciProbeCount: () => ciProbes.length,
		mergeCallCount: () => mergeCalls,
	};
}

describe("FLY-1545 ① ship waits for CI green before the intent tx", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("pins the wait constants to the reviewed values", () => {
		expect(CI_POLL_MS).toBe(30_000);
		expect(CI_WAIT_MS).toBe(1_800_000);
	});

	it("red CI rejects the ship with zero ledger consumption", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-ci-red",
			ciScript: [{ state: "red", detail: "checks failed: ci.yml" }],
		});
		fixtures.push(rig.fixture);
		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-ci-red",
				capabilityId: rig.approval.capabilityId as string,
				actor: rig.actor,
			}),
		).rejects.toThrow("ci is not green: checks failed: ci.yml");
		expect(rig.mergeCallCount()).toBe(0);
		expect(rig.ledger()).toEqual({
			actions: 0,
			capabilityConsumed: null,
			gate: { state: "approved", attempts: 0 },
		});
	});

	it("red rerun to green on the same head ships with the same capability", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-ci-rerun",
			ciScript: [{ state: "red", detail: "checks failed: ci.yml" }],
		});
		fixtures.push(rig.fixture);
		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-ci-rerun",
				capabilityId: rig.approval.capabilityId as string,
				actor: rig.actor,
			}),
		).rejects.toThrow("ci is not green");
		// The failed check is rerun on the SAME head and turns green: retry the
		// same verb with the same capability -- zero re-approval (repair flow a).
		const shipped = await executeShip(
			rig.fixture.kernel,
			{
				...rig.allPorts,
				githubObservation: {
					...rig.allPorts.githubObservation,
					async readCiState() {
						return { state: "green" as const };
					},
				},
			},
			{
				issueId: "issue-ci-rerun",
				capabilityId: rig.approval.capabilityId as string,
				actor: rig.actor,
			},
		);
		expect(shipped).toMatchObject({ status: "succeeded", mergedSha: HEAD });
		expect(rig.mergeCallCount()).toBe(1);
	});

	it("pending polls through the clock and ships when CI turns green", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-ci-pending",
			ciScript: [
				{ state: "pending", detail: "checks pending: test-shard-1" },
				{ state: "pending", detail: "checks pending: test-shard-1" },
				{ state: "green" },
			],
		});
		fixtures.push(rig.fixture);
		const before = rig.fixture.clock.nowMs();
		const shipped = await executeShip(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-ci-pending",
			capabilityId: rig.approval.capabilityId as string,
			actor: rig.actor,
		});
		expect(shipped).toMatchObject({ status: "succeeded" });
		expect(rig.ciProbeCount()).toBe(3);
		expect(rig.fixture.clock.nowMs() - before).toBe(2 * CI_POLL_MS);
	});

	it("pending forever exhausts the deadline with zero ledger consumption", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-ci-deadline",
			ciScript: [{ state: "pending", detail: "checks pending: build" }],
		});
		fixtures.push(rig.fixture);
		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-ci-deadline",
				capabilityId: rig.approval.capabilityId as string,
				actor: rig.actor,
			}),
		).rejects.toThrow("ci wait deadline: checks pending: build");
		expect(rig.mergeCallCount()).toBe(0);
		expect(rig.ledger()).toEqual({
			actions: 0,
			capabilityConsumed: null,
			gate: { state: "approved", attempts: 0 },
		});
	});

	it("head drift during the wait rejects with zero ledger consumption", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-ci-drift",
			ciScript: [{ state: "pending", detail: "checks pending: build" }],
			prHeads: [HEAD, "b".repeat(40)],
		});
		fixtures.push(rig.fixture);
		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-ci-drift",
				capabilityId: rig.approval.capabilityId as string,
				actor: rig.actor,
			}),
		).rejects.toThrow("world head drifted during ci wait");
		expect(rig.ledger()).toEqual({
			actions: 0,
			capabilityConsumed: null,
			gate: { state: "approved", attempts: 0 },
		});
	});

	it("a force-push landing as CI turns green consumes nothing (codex R1 HIGH-1)", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-ci-green-drift",
			ciScript: [{ state: "green" }],
			prHeads: [HEAD, "b".repeat(40)],
		});
		fixtures.push(rig.fixture);
		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-ci-green-drift",
				capabilityId: rig.approval.capabilityId as string,
				actor: rig.actor,
			}),
		).rejects.toThrow("world head drifted after ci green");
		expect(rig.mergeCallCount()).toBe(0);
		expect(rig.ledger()).toEqual({
			actions: 0,
			capabilityConsumed: null,
			gate: { state: "approved", attempts: 0 },
		});
	});

	it("green path stays byte-compatible with the pre-wait ledger writes", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-ci-green",
			ciScript: [{ state: "green" }],
		});
		fixtures.push(rig.fixture);
		const shipped = await executeShip(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-ci-green",
			capabilityId: rig.approval.capabilityId as string,
			actor: rig.actor,
		});
		expect(shipped).toMatchObject({ status: "succeeded", mergedSha: HEAD });
		expect(rig.ciProbeCount()).toBe(1);
		expect(
			rig.fixture.kernel.read((tx) => ({
				completed: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='ship_completed'",
				)?.count,
				settled: tx.get<{ sha: string }>(
					`SELECT json_extract(value,'$.data.settled.merged_sha') AS sha
					   FROM meta WHERE key='ship_gate:issue-ci-green'`,
				)?.sha,
			})),
		).toEqual({ completed: 1, settled: HEAD });
	});
});

describe("FLY-1545 ② repair flow (b): code fixes re-open the gate for fresh authority", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("an approved gate refuses a different approvalRef", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-approved-ref",
			ciScript: [{ state: "green" }],
		});
		fixtures.push(rig.fixture);
		expect(() =>
			approveShipGate(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-approved-ref",
				approvalRef: "a-second-ref",
				observedTip: HEAD,
				shipTarget: { repo: "owner/repo", pr: 31 },
				actorConfig: {
					defaultActionAgentId: "ship-agent",
					configDigest: "config",
				},
			}),
		).toThrow("ship gate is not open");
	});

	it("rework completion advances the span tip and re-opens the gate for a new ref", async () => {
		const rig = await approvedGateFixture({
			issueId: "issue-rework-reopen",
			ciScript: [{ state: "green" }],
			writer: true,
		});
		fixtures.push(rig.fixture);
		const reworked = await reworkTask(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-rework-reopen",
			taskId: rig.admitted.taskIds.node as string,
			reworkUid: "rework-fix",
		});
		expect(reworked.status).toBe("reworked");
		const fixedHead = "c".repeat(40);
		rig.diffs.set(
			`${HEAD}:${fixedHead}`,
			rawModify("engineering/doc/fix.md", "1".repeat(40), "2".repeat(40)),
		);
		rig.state.head = fixedHead;
		const dispatch = reworked.dispatch as SpawnRequest;
		await submitNodeCompletion(rig.fixture.kernel, rig.allPorts, {
			taskId: dispatch.taskId,
			attemptId: dispatch.attemptId,
			activationId: dispatch.activationId,
			agent: dispatch.agent,
			completionUid: "rework-completion",
		});
		const gate = rig.fixture.kernel.read((tx) =>
			tx.get<{ state: string; tip: string }>(
				`SELECT json_extract(value,'$.data.state') AS state,
				        json_extract(value,'$.data.tip') AS tip
				   FROM meta WHERE key='ship_gate:issue-rework-reopen'`,
			),
		);
		expect(gate).toEqual({ state: "open", tip: fixedHead });
		// The pre-rework capability is dead authority on the new tip: the
		// re-opened gate has no target until a fresh founder approval.
		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-rework-reopen",
				capabilityId: rig.approval.capabilityId as string,
				actor: rig.actor,
			}),
		).rejects.toThrow("ship authority is incomplete");
		// Fresh founder authority on the new tip ships.
		const heads = rig.allPorts.githubObservation;
		const reapproval = approveShipGate(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-rework-reopen",
			approvalRef: "rework-fresh-ref",
			observedTip: fixedHead,
			shipTarget: { repo: "owner/repo", pr: 31 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});
		const shipped = await executeShip(
			rig.fixture.kernel,
			{
				...rig.allPorts,
				githubObservation: {
					...heads,
					async readPrHead() {
						return fixedHead;
					},
				},
				githubMerge: {
					async merge() {
						return { mergedSha: fixedHead };
					},
				},
			},
			{
				issueId: "issue-rework-reopen",
				capabilityId: reapproval.capabilityId as string,
				actor: rig.actor,
			},
		);
		expect(shipped).toMatchObject({
			status: "succeeded",
			mergedSha: fixedHead,
		});
	});
});
