import { afterEach, describe, expect, it } from "vitest";
import {
	type AdmitIssueDagInput,
	admitIssueDag,
	approveShipGate,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	type GitPort,
	observeNodeCompletion,
	recordEvidence,
	registerReviewFamilies,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

/**
 * QA phase — independent verification of the FLY-1520 acceptance clauses.
 *
 * Each block names the issue clause it exercises. These probe runtime behaviour
 * through the public surface only; none of them reach into implementation
 * internals, so a refactor that keeps the contract keeps these green.
 */

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function modify(path: string): string {
	return `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0${path}\0`;
}

interface WorldOptions {
	diff?: string;
	prHead?: () => string;
}

/** A single-worktree world whose head the test advances by hand. */
function makeWorld(options: WorldOptions = {}) {
	const world = {
		head: A,
		diff: options.diff ?? "",
		merged: null as string | null,
	};
	const git: GitPort = {
		async readHead() {
			return world.head;
		},
		async mergeBase() {
			return A;
		},
		async isAncestor() {
			return true;
		},
		async rawDiff() {
			return world.diff;
		},
		async readRef() {
			return world.head;
		},
	};
	const githubObservation: GitHubObservationPort = {
		async readPrHead() {
			return options.prHead ? options.prHead() : world.head;
		},
		async readMergeState() {
			return world.merged === null
				? { state: "open" as const }
				: { state: "merged" as const, head: world.merged };
		},
	};
	const githubMerge: GitHubMergePort = {
		async merge(_repo, _pr, expectedSha) {
			world.merged = expectedSha;
			return { mergedSha: expectedSha };
		},
	};
	return { world, git, githubObservation, githubMerge };
}

const WT = {
	worktreeId: "wt-a",
	repoIdentity: "owner/repo",
	worktreePath: "/tmp/wt-a",
	branchRef: "refs/heads/feature",
	mergeTargetRef: "refs/heads/main",
} as const;

function executor(logicalAgentId: string, family = "family-a") {
	return {
		logicalAgentId,
		family,
		vendor: "vendor",
		model: "model",
		effort: "high",
	} as const;
}

function countEvents(
	fixture: ReturnType<typeof makeFixture>,
	kind: string,
): number {
	return (
		fixture.kernel.read(
			(tx) =>
				tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind=@kind",
					{ kind },
				)?.count,
		) ?? -1
	);
}

function taskState(
	fixture: ReturnType<typeof makeFixture>,
	taskId: string,
): string | undefined {
	return fixture.kernel.read(
		(tx) =>
			tx.get<{ state: string }>("SELECT state FROM tasks WHERE id=@taskId", {
				taskId,
			})?.state,
	);
}

describe("FLY-1520 acceptance — derived contracts carry no scenario knowledge", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	/**
	 * Acceptance 1 — a pure-PRD issue (no node touches the repo at all) ships
	 * end to end with zero code review demanded anywhere. Note there is no
	 * review-family configuration in this world at all: if the engine reached
	 * for a review it could not even find a reviewer, so a green ship here is
	 * proof the derived requirement never fired.
	 */
	it("ships a repo-free PRD issue without ever demanding a code review", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("prd-agent", "runner");
		fixture.provision("prd-agent-2", "runner");
		fixture.provision("ship-agent", "lead");
		const { world, git, githubObservation, githubMerge } = makeWorld();
		const { ports } = makePorts(fixture.clock, { git });
		const allPorts = { ...ports, githubObservation, githubMerge };

		const admitted = await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: "qa-prd-admission",
			projectId: "project-a",
			issueId: "issue-qa-prd",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "draft",
					kindLabel: "opaque-1",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: executor("prd-agent"),
				},
				{
					localId: "refine",
					kindLabel: "opaque-2",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: executor("prd-agent-2"),
				},
			],
			edges: [["draft", "refine"]],
		});

		for (const localId of ["draft", "refine"] as const) {
			const spawn = (await dispatchOnce(fixture.kernel, allPorts))
				.dispatched[0] as SpawnRequest;
			await submitNodeCompletion(fixture.kernel, allPorts, {
				taskId: admitted.taskIds[localId] as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: `qa-prd-${localId}`,
			});
		}

		expect(countEvents(fixture, "evidence.review_approval")).toBe(0);
		expect(countEvents(fixture, "review_family_exhausted")).toBe(0);

		const approval = approveShipGate(fixture.kernel, allPorts, {
			issueId: "issue-qa-prd",
			approvalRef: "qa-prd-approval",
			observedTip: world.head,
			shipTarget: { repo: "owner/repo", pr: 7 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config-qa",
			},
		});
		const shipped = await executeShip(fixture.kernel, allPorts, {
			issueId: "issue-qa-prd",
			capabilityId: approval.capabilityId as string,
			actor: {
				kind: "lead",
				agentId: "ship-agent",
				instanceId: "ship-session",
				generation: 0,
			},
		});

		expect(shipped).toMatchObject({
			status: "succeeded",
			mergedSha: world.head,
		});
		expect(countEvents(fixture, "evidence.review_approval")).toBe(0);
		expect(countEvents(fixture, "ship_completed")).toBe(1);
	});

	/**
	 * Acceptance 2 — a QA node's contract is a verdict, never a code review.
	 * The node produces no repo output, so the derived requirement is empty and
	 * the single declared verdict is the whole contract.
	 */
	it("satisfies a QA node with a verdict alone and no review evidence", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("qa-agent", "runner");
		const { git } = makeWorld();
		const { ports } = makePorts(fixture.clock, { git });

		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-verdict-admission",
			projectId: "project-a",
			issueId: "issue-qa-verdict",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "qa",
					kindLabel: "opaque",
					contract: [{ kind: "verdict" }],
					writesRepo: false,
					worktreeId: null,
					executor: executor("qa-agent"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			ports,
			admitted.taskIds.qa as string,
		);
		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-verdict-pass",
			kind: "verdict",
			taskId: admitted.taskIds.qa as string,
			attemptId: spawn.attemptId,
			head: observation.head,
			verdict: "pass",
			producer: spawn.agent,
		});

		const result = await submitNodeCompletion(fixture.kernel, ports, {
			taskId: admitted.taskIds.qa as string,
			attemptId: spawn.attemptId,
			activationId: spawn.activationId,
			agent: spawn.agent,
			completionUid: "qa-verdict-completion",
		});

		expect(result.status).toBe("completed");
		expect(countEvents(fixture, "evidence.review_approval")).toBe(0);
		const recorded = fixture.kernel.read(
			(tx) =>
				tx.get<{ payload: string }>(
					"SELECT payload FROM events WHERE event_uid='node_completed:qa-verdict-completion'",
				)?.payload,
		);
		expect(JSON.parse(recorded ?? "{}")).toMatchObject({
			satisfied_items: [{ kind: "verdict" }],
			evidence_refs: ["qa-verdict-pass"],
		});
	});

	/**
	 * Plan §2.6 pins this as the R2-3 counter-example: a recorded verdict that
	 * says "fail" is real evidence but does not satisfy the contract.
	 */
	it("refuses to complete a node whose only verdict failed", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("qa-agent", "runner");
		const { git } = makeWorld();
		const { ports } = makePorts(fixture.clock, { git });

		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-fail-admission",
			projectId: "project-a",
			issueId: "issue-qa-fail",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "qa",
					kindLabel: "opaque",
					contract: [{ kind: "verdict" }],
					writesRepo: false,
					worktreeId: null,
					executor: executor("qa-agent"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			ports,
			admitted.taskIds.qa as string,
		);
		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-verdict-fail",
			kind: "verdict",
			taskId: admitted.taskIds.qa as string,
			attemptId: spawn.attemptId,
			head: observation.head,
			verdict: "fail",
			producer: spawn.agent,
		});

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.qa as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-fail-completion",
			}),
		).rejects.toThrow(/passing verdict/);
		expect(taskState(fixture, admitted.taskIds.qa as string)).toBe("running");

		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-verdict-recovered",
			kind: "verdict",
			taskId: admitted.taskIds.qa as string,
			attemptId: spawn.attemptId,
			head: observation.head,
			verdict: "pass",
			producer: spawn.agent,
		});
		expect(
			(
				await submitNodeCompletion(fixture.kernel, ports, {
					taskId: admitted.taskIds.qa as string,
					attemptId: spawn.attemptId,
					activationId: spawn.activationId,
					agent: spawn.agent,
					completionUid: "qa-fail-completion-2",
				})
			).status,
		).toBe("completed");
	});

	/**
	 * Derived matrix, `test` row — the plan says test-only output derives no
	 * review. Nothing in the existing suite exercised that row, so a regression
	 * that reclassified test files as product would have shipped silently.
	 */
	it("derives no review for a node whose whole output is test files", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("test-writer", "runner");
		fixture.provision("reviewer-b", "lead");
		const { world, git } = makeWorld({
			diff: modify("packages/app/src/__tests__/thing.test.ts"),
		});
		const { ports } = makePorts(fixture.clock, { git });
		// Same reviewer configuration as the mixed-output case below, so the
		// only difference between the two is what the node wrote.
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: {
				"family-a": { reviewerAgentId: "lead-a" },
				"family-b": { reviewerAgentId: "reviewer-b" },
			},
		});

		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-test-only-admission",
			projectId: "project-a",
			issueId: "issue-qa-test-only",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "tests",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: WT.worktreeId,
					executor: executor("test-writer"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		world.head = B;

		const result = await submitNodeCompletion(fixture.kernel, ports, {
			taskId: admitted.taskIds.tests as string,
			attemptId: spawn.attemptId,
			activationId: spawn.activationId,
			agent: spawn.agent,
			completionUid: "qa-test-only-completion",
		});

		expect(result.status).toBe("completed");
		expect(countEvents(fixture, "evidence.review_approval")).toBe(0);
		expect(countEvents(fixture, "review_family_exhausted")).toBe(0);
	});

	/**
	 * The same node shape as above but with one product file mixed in must flip
	 * to requiring a review. Run back to back with the test-only case, this is
	 * the pair that proves the requirement tracks output classification rather
	 * than the node's label — both nodes carry an opaque `kindLabel`.
	 */
	it("derives a review as soon as one product file joins the same output", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("mixed-writer", "runner");
		fixture.provision("reviewer-b", "lead");
		const { world, git } = makeWorld({
			diff:
				modify("packages/app/src/__tests__/thing.test.ts") +
				modify("packages/app/src/thing.ts"),
		});
		const { ports } = makePorts(fixture.clock, { git });
		// A reviewer is available, so a refusal here can only mean the engine
		// derived a review requirement — not that it ran out of families.
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: {
				"family-a": { reviewerAgentId: "lead-a" },
				"family-b": { reviewerAgentId: "reviewer-b" },
			},
		});

		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-mixed-admission",
			projectId: "project-a",
			issueId: "issue-qa-mixed",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "mixed",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: WT.worktreeId,
					executor: executor("mixed-writer"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		world.head = B;

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.mixed as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-mixed-completion",
			}),
		).rejects.toThrow(/cross-family approval/);
		expect(taskState(fixture, admitted.taskIds.mixed as string)).toBe(
			"running",
		);
	});

	/**
	 * Cross-family means cross-family: the author's own family cannot sign off
	 * on its own product output even when it is a registered reviewer family.
	 */
	it("rejects a product review signed by the authoring family", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("code-writer", "runner");
		fixture.provision("reviewer-a", "lead");
		fixture.provision("reviewer-b", "lead");
		const { world, git } = makeWorld({ diff: modify("packages/app/src/x.ts") });
		const { ports } = makePorts(fixture.clock, { git });
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: {
				"family-a": { reviewerAgentId: "reviewer-a" },
				"family-b": { reviewerAgentId: "reviewer-b" },
			},
		});

		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-self-review-admission",
			projectId: "project-a",
			issueId: "issue-qa-self-review",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "code",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: WT.worktreeId,
					executor: executor("code-writer", "family-a"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		world.head = B;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			ports,
			admitted.taskIds.code as string,
		);
		expect(observation.authorFamilies).toEqual(["family-a"]);

		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-self-approval",
			kind: "review_approval",
			projectId: "project-a",
			review: "code",
			subjectDigest: observation.reviewSubjectDigest,
			reviewer: { agentId: "reviewer-a", generation: 0 },
		});

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.code as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-self-review-completion",
			}),
		).rejects.toThrow(/cross-family approval/);

		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-peer-approval",
			kind: "review_approval",
			projectId: "project-a",
			review: "code",
			subjectDigest: observation.reviewSubjectDigest,
			reviewer: { agentId: "reviewer-b", generation: 0 },
		});
		expect(
			(
				await submitNodeCompletion(fixture.kernel, ports, {
					taskId: admitted.taskIds.code as string,
					attemptId: spawn.attemptId,
					activationId: spawn.activationId,
					agent: spawn.agent,
					completionUid: "qa-peer-review-completion",
				})
			).status,
		).toBe("completed");
	});
});

describe("FLY-1520 acceptance — one live writer per worktree", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	/**
	 * Two writer nodes with no edge between them are both topologically ready.
	 * The worktree slot, not the graph, is what must keep the second one
	 * waiting — and the non-writer node alongside them must not be held up by a
	 * slot it never takes.
	 */
	it("dispatches one of two ready writers while letting a non-writer through", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("writer-one", "runner");
		fixture.provision("writer-two", "runner");
		fixture.provision("thinker", "runner");
		const { world, git } = makeWorld({ diff: modify("docs/note.md") });
		const { ports } = makePorts(fixture.clock, { git });

		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-writer-slot",
			projectId: "project-a",
			issueId: "issue-qa-writer-slot",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "w1",
					kindLabel: "opaque-1",
					contract: [],
					writesRepo: true,
					worktreeId: WT.worktreeId,
					executor: executor("writer-one"),
				},
				{
					localId: "w2",
					kindLabel: "opaque-2",
					contract: [],
					writesRepo: true,
					worktreeId: WT.worktreeId,
					executor: executor("writer-two"),
				},
				{
					localId: "think",
					kindLabel: "opaque-3",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: executor("thinker"),
				},
			],
			edges: [],
		});

		const round = await dispatchOnce(fixture.kernel, ports);
		const writerIds = [admitted.taskIds.w1, admitted.taskIds.w2];
		const dispatchedWriters = round.dispatched.filter((request) =>
			writerIds.includes(request.taskId),
		);

		expect(dispatchedWriters).toHaveLength(1);
		expect(
			round.dispatched.some(
				(request) => request.taskId === admitted.taskIds.think,
			),
		).toBe(true);
		const runningWriters = writerIds.filter(
			(taskId) => taskState(fixture, taskId as string) === "running",
		);
		expect(runningWriters).toHaveLength(1);

		// A second sweep must not sneak the waiting writer into the held slot.
		const again = await dispatchOnce(fixture.kernel, ports);
		expect(
			again.dispatched.filter((request) => writerIds.includes(request.taskId)),
		).toHaveLength(0);

		// Releasing the slot by completing the holder lets the other one in.
		const holder = dispatchedWriters[0] as SpawnRequest;
		world.head = B;
		await submitNodeCompletion(fixture.kernel, ports, {
			taskId: holder.taskId,
			attemptId: holder.attemptId,
			activationId: holder.activationId,
			agent: holder.agent,
			completionUid: "qa-writer-slot-release",
		});
		const third = await dispatchOnce(fixture.kernel, ports);

		expect(
			third.dispatched.filter((request) => writerIds.includes(request.taskId)),
		).toHaveLength(1);
	});
});

/**
 * The dispatch predicate for a writer node is a conjunction, and the existing
 * gap fixture trips several clauses at once — so each clause needs a world
 * where it is the only thing standing in the way. Same story for the two
 * staleness fences guarding the completion transaction.
 */
describe("FLY-1520 acceptance — writer fences, isolated one at a time", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	async function writerFixture(
		issueId: string,
		git: GitPort,
		clockOwner?: (fixture: ReturnType<typeof makeFixture>) => void,
	) {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		clockOwner?.(fixture);
		const { ports } = makePorts(fixture.clock, { git });
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: `qa-fence-${issueId}`,
			projectId: "project-a",
			issueId,
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "node",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: WT.worktreeId,
					executor: executor("agent-a"),
				},
			],
			edges: [],
		});
		return { fixture, ports, taskId: admitted.taskIds.node as string };
	}

	it("refuses to dispatch onto a head that moved after the anchor was taken", async () => {
		// Admission sees a clean worktree, so no gap is recorded. Between then
		// and dispatch someone pushes: the gap clause is null and only the
		// head-matches-chain clause can stop this.
		let head = A;
		const git: GitPort = {
			async readHead() {
				return head;
			},
			async mergeBase() {
				return A;
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
		};
		const rig = await writerFixture("issue-qa-head-moved", git);
		expect(
			rig.fixture.kernel.read(
				(tx) =>
					tx.get<{ gap: string | null }>(
						"SELECT json_extract(value,'$.data.pending_gap') AS gap FROM meta WHERE key='writer_chain:wt-a'",
					)?.gap,
			),
		).toBeNull();

		head = C;
		const round = await dispatchOnce(rig.fixture.kernel, rig.ports);

		expect(round.dispatched).toEqual([]);
		expect(taskState(rig.fixture, rig.taskId)).toBe("ready");
	});

	it("refuses to dispatch over an unadopted gap even once the head matches again", async () => {
		// Admission records a gap (head ahead of the merge base). The worktree is
		// then reset back onto the anchor, so the head clause is satisfied and
		// only the unadopted gap can stop this.
		let head = B;
		const git: GitPort = {
			async readHead() {
				return head;
			},
			async mergeBase() {
				return A;
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
		};
		const rig = await writerFixture("issue-qa-gap-only", git);
		expect(countEvents(rig.fixture, "writer_gap_detected")).toBe(1);

		head = A;
		const round = await dispatchOnce(rig.fixture.kernel, rig.ports);

		expect(round.dispatched).toEqual([]);
		expect(taskState(rig.fixture, rig.taskId)).toBe("ready");
		expect(
			rig.fixture.kernel.read(
				(tx) =>
					tx.get<{ gap: string | null }>(
						"SELECT json_extract(value,'$.data.pending_gap') AS gap FROM meta WHERE key='writer_chain:wt-a'",
					)?.gap,
			),
		).not.toBeNull();
	});

	it("refuses a completion whose writer chain moved under it mid-observation", async () => {
		// The git port runs between the completion's snapshot read and its write
		// transaction — a faithful seam for "another transaction touched this
		// worktree while we were looking at git".
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		let head = A;
		let bumpChainOnNextRead = false;
		const git: GitPort = {
			async readHead() {
				if (bumpChainOnNextRead) {
					bumpChainOnNextRead = false;
					fixture.kernel.write("qa.concurrent-chain-write", (tx) => {
						tx.run(
							`UPDATE meta
							    SET value=json_set(value,'$.revision',
							                       json_extract(value,'$.revision')+1)
							  WHERE key='writer_chain:wt-a'`,
						);
					});
				}
				return head;
			},
			async mergeBase() {
				return A;
			},
			async isAncestor() {
				return true;
			},
			async rawDiff() {
				return modify("docs/note.md");
			},
			async readRef() {
				return head;
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-fence-stale-writer",
			projectId: "project-a",
			issueId: "issue-qa-stale-writer",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "node",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: WT.worktreeId,
					executor: executor("agent-a"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		head = B;
		bumpChainOnNextRead = true;

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.node as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-stale-writer-completion",
			}),
		).rejects.toThrow(/writer observation is stale/);
		expect(taskState(fixture, admitted.taskIds.node as string)).toBe("running");

		// With the chain quiet, the very same completion goes through — proof the
		// refusal above was the staleness fence and not a broken fixture.
		expect(
			(
				await submitNodeCompletion(fixture.kernel, ports, {
					taskId: admitted.taskIds.node as string,
					attemptId: spawn.attemptId,
					activationId: spawn.activationId,
					agent: spawn.agent,
					completionUid: "qa-stale-writer-completion-2",
				})
			).status,
		).toBe("completed");
	});

	it("replays a repeated completion from its receipt without touching git again", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
		let head = A;
		const calls = { readHead: 0, rawDiff: 0, isAncestor: 0 };
		const git: GitPort = {
			async readHead() {
				calls.readHead += 1;
				return head;
			},
			async mergeBase() {
				return A;
			},
			async isAncestor() {
				calls.isAncestor += 1;
				return true;
			},
			async rawDiff() {
				calls.rawDiff += 1;
				return modify("docs/note.md");
			},
			async readRef() {
				return head;
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-fence-replay",
			projectId: "project-a",
			issueId: "issue-qa-replay",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "node",
					kindLabel: "opaque",
					contract: [],
					writesRepo: true,
					worktreeId: WT.worktreeId,
					executor: executor("agent-a"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		head = B;
		const request = {
			taskId: admitted.taskIds.node as string,
			attemptId: spawn.attemptId,
			activationId: spawn.activationId,
			agent: spawn.agent,
			completionUid: "qa-replay-completion",
		};
		const first = await submitNodeCompletion(fixture.kernel, ports, request);
		expect(first.status).toBe("completed");

		const observedBefore = { ...calls };
		const second = await submitNodeCompletion(fixture.kernel, ports, request);

		expect(second).toEqual({ ...first, status: "replayed" });
		expect(calls).toEqual(observedBefore);
		expect(countEvents(fixture, "node_completed")).toBe(1);
	});

	it("refuses a completion presented through an activation of the wrong generation", async () => {
		const rig = await writerFixture("issue-qa-forged-activation", {
			async readHead() {
				return A;
			},
			async mergeBase() {
				return A;
			},
			async isAncestor() {
				return true;
			},
			async rawDiff() {
				return "";
			},
			async readRef() {
				return A;
			},
		});
		const spawn = (await dispatchOnce(rig.fixture.kernel, rig.ports))
			.dispatched[0] as SpawnRequest;
		rig.fixture.kernel.write("qa.forge-activation-generation", (tx) => {
			tx.run(
				"UPDATE activations SET generation=generation+1 WHERE id=@activationId",
				{ activationId: spawn.activationId },
			);
		});

		await expect(
			submitNodeCompletion(rig.fixture.kernel, rig.ports, {
				taskId: rig.taskId,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-forged-activation-completion",
			}),
		).rejects.toThrow(/identity binding is stale/);
		expect(taskState(rig.fixture, rig.taskId)).toBe("running");
	});
});

describe("FLY-1520 acceptance — declared artifact contracts", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	async function artifactFixture(
		issueSuffix: string,
		contract: AdmitIssueDagInput["tasks"][number]["contract"],
	) {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("artifact-agent", "runner");
		const { git } = makeWorld();
		const { ports } = makePorts(fixture.clock, { git });
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: `qa-artifact-${issueSuffix}`,
			projectId: "project-a",
			issueId: `issue-qa-artifact-${issueSuffix}`,
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "node",
					kindLabel: "opaque",
					contract,
					writesRepo: false,
					worktreeId: null,
					executor: executor("artifact-agent"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		const taskId = admitted.taskIds.node as string;
		return {
			fixture,
			ports,
			spawn,
			taskId,
			record(eventUid: string, path: string, digest: string) {
				recordEvidence(fixture.kernel, ports, {
					eventUid,
					kind: "artifact",
					taskId,
					attemptId: spawn.attemptId,
					path,
					digest,
					producer: spawn.agent,
				});
			},
			complete(completionUid: string) {
				return submitNodeCompletion(fixture.kernel, ports, {
					taskId,
					attemptId: spawn.attemptId,
					activationId: spawn.activationId,
					agent: spawn.agent,
					completionUid,
				});
			},
		};
	}

	it("holds a cardinality-one artifact to exactly one matching record", async () => {
		const rig = await artifactFixture("one", [
			{ kind: "artifact", path: "out/brief.md", cardinality: "one" },
		]);

		await expect(rig.complete("artifact-one-missing")).rejects.toThrow(
			/artifact evidence/,
		);
		rig.record("artifact-one-first", "out/brief.md", "d".repeat(64));
		expect((await rig.complete("artifact-one-present")).status).toBe(
			"completed",
		);
	});

	it("accepts several records for a cardinality-many artifact", async () => {
		const rig = await artifactFixture("many", [
			{ kind: "artifact", path: "out/chapter.md", cardinality: "many" },
		]);

		await expect(rig.complete("artifact-many-missing")).rejects.toThrow(
			/artifact evidence/,
		);
		rig.record("artifact-many-1", "out/chapter.md", "d".repeat(64));
		rig.record("artifact-many-2", "out/chapter.md", "e".repeat(64));
		const result = await rig.complete("artifact-many-present");

		expect(result.status).toBe("completed");
		const recorded = rig.fixture.kernel.read(
			(tx) =>
				tx.get<{ payload: string }>(
					"SELECT payload FROM events WHERE event_uid='node_completed:artifact-many-present'",
				)?.payload,
		);
		expect(
			(JSON.parse(recorded ?? "{}") as { evidence_refs: string[] })
				.evidence_refs,
		).toEqual(["artifact-many-1", "artifact-many-2"]);
	});

	it("requires a declared artifact digest to match byte for byte", async () => {
		const rig = await artifactFixture("digest", [
			{
				kind: "artifact",
				path: "out/pinned.md",
				cardinality: "one",
				digest: "d".repeat(64),
			},
		]);

		rig.record("artifact-digest-wrong", "out/pinned.md", "e".repeat(64));
		await expect(rig.complete("artifact-digest-mismatch")).rejects.toThrow(
			/artifact evidence/,
		);
		rig.record("artifact-digest-right", "out/pinned.md", "d".repeat(64));
		expect((await rig.complete("artifact-digest-match")).status).toBe(
			"completed",
		);
	});
});

describe("FLY-1520 acceptance — generic ship predicates", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	async function shipRig(issueId: string, prHead?: () => string) {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("node-agent-1", "runner");
		fixture.provision("node-agent-2", "runner");
		fixture.provision("ship-agent", "lead");
		const world = makeWorld(prHead ? { prHead } : {});
		const { ports } = makePorts(fixture.clock, { git: world.git });
		const allPorts = {
			...ports,
			githubObservation: world.githubObservation,
			githubMerge: world.githubMerge,
		};
		const admitted = await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: `qa-ship-${issueId}`,
			projectId: "project-a",
			issueId,
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "one",
					kindLabel: "opaque-1",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: executor("node-agent-1"),
				},
				{
					localId: "two",
					kindLabel: "opaque-2",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: executor("node-agent-2"),
				},
			],
			edges: [["one", "two"]],
		});
		return { fixture, allPorts, admitted, world: world.world };
	}

	async function completeNode(
		rig: Awaited<ReturnType<typeof shipRig>>,
		localId: string,
	) {
		const spawn = (await dispatchOnce(rig.fixture.kernel, rig.allPorts))
			.dispatched[0] as SpawnRequest;
		await submitNodeCompletion(rig.fixture.kernel, rig.allPorts, {
			taskId: rig.admitted.taskIds[localId] as string,
			attemptId: spawn.attemptId,
			activationId: spawn.activationId,
			agent: spawn.agent,
			completionUid: `complete-${localId}`,
		});
	}

	it("refuses founder authority while any node is still open", async () => {
		const rig = await shipRig("issue-qa-partial");
		await completeNode(rig, "one");

		expect(() =>
			approveShipGate(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-qa-partial",
				approvalRef: "qa-partial-approval",
				observedTip: rig.world.head,
				shipTarget: { repo: "owner/repo", pr: 11 },
				actorConfig: {
					defaultActionAgentId: "ship-agent",
					configDigest: "config",
				},
			}),
		).toThrow();
		expect(countEvents(rig.fixture, "ship_completed")).toBe(0);
	});

	it("refuses a merge whose approved head no longer matches the world", async () => {
		let prHead = A;
		const rig = await shipRig("issue-qa-drift", () => prHead);
		await completeNode(rig, "one");
		await completeNode(rig, "two");
		const approval = approveShipGate(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-qa-drift",
			approvalRef: "qa-drift-approval",
			observedTip: rig.world.head,
			shipTarget: { repo: "owner/repo", pr: 12 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});

		prHead = C;

		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-qa-drift",
				capabilityId: approval.capabilityId as string,
				actor: {
					kind: "lead",
					agentId: "ship-agent",
					instanceId: "ship-session",
					generation: 0,
				},
			}),
		).rejects.toThrow(/head drifted/);
		expect(countEvents(rig.fixture, "ship_completed")).toBe(0);
	});

	it("refuses a merge presented by an actor the founder did not authorize", async () => {
		const rig = await shipRig("issue-qa-actor");
		rig.fixture.provision("other-lead", "lead");
		await completeNode(rig, "one");
		await completeNode(rig, "two");
		const approval = approveShipGate(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-qa-actor",
			approvalRef: "qa-actor-approval",
			observedTip: rig.world.head,
			shipTarget: { repo: "owner/repo", pr: 13 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});

		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-qa-actor",
				capabilityId: approval.capabilityId as string,
				actor: {
					kind: "lead",
					agentId: "other-lead",
					instanceId: "other-session",
					generation: 0,
				},
			}),
		).rejects.toThrow(/not authorized/);
		expect(countEvents(rig.fixture, "ship_completed")).toBe(0);
	});

	it("consumes founder authority exactly once across a repeated merge call", async () => {
		const rig = await shipRig("issue-qa-once");
		await completeNode(rig, "one");
		await completeNode(rig, "two");
		const approval = approveShipGate(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-qa-once",
			approvalRef: "qa-once-approval",
			observedTip: rig.world.head,
			shipTarget: { repo: "owner/repo", pr: 14 },
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

		expect(
			await executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-qa-once",
				capabilityId: approval.capabilityId as string,
				actor,
			}),
		).toMatchObject({ status: "succeeded" });

		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-qa-once",
				capabilityId: approval.capabilityId as string,
				actor,
			}),
		).rejects.toThrow(/authority is not current/);
		expect(countEvents(rig.fixture, "ship_completed")).toBe(1);
		expect(
			rig.fixture.kernel.read(
				(tx) =>
					tx.get<{ consumed: string | null }>(
						"SELECT consumed_at AS consumed FROM capabilities WHERE id=@id",
						{ id: approval.capabilityId },
					)?.consumed,
			),
		).not.toBeNull();
	});

	/**
	 * A merge that fails leaves the gate approved and awaiting a retry, so the
	 * settled-gate guard is out of the way. What must stop a second merge on the
	 * spent grant is the capability fence itself — the reconciler mints a fresh
	 * capability for each authorized retry, and the old one is dead.
	 */
	it("will not let a spent grant drive a second merge after the first failed", async () => {
		const rig = await shipRig("issue-qa-spent");
		await completeNode(rig, "one");
		await completeNode(rig, "two");
		const approval = approveShipGate(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-qa-spent",
			approvalRef: "qa-spent-approval",
			observedTip: rig.world.head,
			shipTarget: { repo: "owner/repo", pr: 15 },
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
		let mergeCalls = 0;
		const failingPorts = {
			...rig.allPorts,
			githubMerge: {
				async merge(): Promise<{ mergedSha: string }> {
					mergeCalls += 1;
					throw new Error("merge refused by the forge");
				},
			},
		};

		expect(
			await executeShip(rig.fixture.kernel, failingPorts, {
				issueId: "issue-qa-spent",
				capabilityId: approval.capabilityId as string,
				actor,
			}),
		).toMatchObject({ status: "failed" });
		const gateAfterFailure = rig.fixture.kernel.read(
			(tx) =>
				tx.get<{ state: string }>(
					"SELECT json_extract(value,'$.data.state') AS state FROM meta WHERE key='ship_gate:issue-qa-spent'",
				)?.state,
		);
		expect(gateAfterFailure).toBe("approved");

		await expect(
			executeShip(rig.fixture.kernel, failingPorts, {
				issueId: "issue-qa-spent",
				capabilityId: approval.capabilityId as string,
				actor,
			}),
		).rejects.toThrow();
		expect(mergeCalls).toBe(1);
	});

	/**
	 * executeShip re-checks the whole DAG inside its own intent transaction
	 * rather than trusting the approval. Regressing one node behind the gate's
	 * back is the race that check exists for.
	 */
	it("re-checks every node inside the merge transaction, not just at approval", async () => {
		const rig = await shipRig("issue-qa-regress");
		await completeNode(rig, "one");
		await completeNode(rig, "two");
		const approval = approveShipGate(rig.fixture.kernel, rig.allPorts, {
			issueId: "issue-qa-regress",
			approvalRef: "qa-regress-approval",
			observedTip: rig.world.head,
			shipTarget: { repo: "owner/repo", pr: 16 },
			actorConfig: {
				defaultActionAgentId: "ship-agent",
				configDigest: "config",
			},
		});
		rig.fixture.kernel.write("qa.regress-a-node", (tx) => {
			tx.run(
				"UPDATE tasks SET state='running',terminal_at=NULL WHERE id=@taskId",
				{ taskId: rig.admitted.taskIds.two },
			);
		});

		await expect(
			executeShip(rig.fixture.kernel, rig.allPorts, {
				issueId: "issue-qa-regress",
				capabilityId: approval.capabilityId as string,
				actor: {
					kind: "lead",
					agentId: "ship-agent",
					instanceId: "ship-session",
					generation: 0,
				},
			}),
		).rejects.toThrow(/not terminal-successful/);
		expect(countEvents(rig.fixture, "ship_completed")).toBe(0);
	});
});
