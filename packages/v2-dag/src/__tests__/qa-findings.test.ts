import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	approveShipGate,
	dispatchOnce,
	executeShip,
	type GitHubMergePort,
	type GitHubObservationPort,
	type GitPort,
	type LaunchLockPort,
	observeNodeCompletion,
	recordEvidence,
	registerReviewFamilies,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

/**
 * QA phase — reproductions for the defects that failed this verdict.
 *
 * THESE TESTS ARE EXPECTED TO FAIL until the implement phase fixes the
 * underlying defects. Each one asserts the behaviour the approved plan
 * requires, and the plan clause it comes from is cited above it. Do not
 * weaken an assertion to make it green — that would re-pin the defect.
 *
 * Findings F4 and F5 are not reproduced here because they need no repro:
 * the required code is simply absent (see qa-report.md §4 for the citations).
 */

const A = "a".repeat(40);
const B = "b".repeat(40);

function modify(path: string): string {
	return `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0${path}\0`;
}

const WT = {
	worktreeId: "wt-a",
	repoIdentity: "owner/repo",
	worktreePath: "/tmp/wt-a",
	branchRef: "refs/heads/feature",
	mergeTargetRef: "refs/heads/main",
} as const;

function executor(logicalAgentId: string, family: string) {
	return {
		logicalAgentId,
		family,
		vendor: "vendor",
		model: "model",
		effort: "high",
	} as const;
}

describe("FLY-1520 QA findings — reproductions", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	/**
	 * F1 — plan §2.1a requires admission to check `executor.family ∈ families
	 * 权威`. It does not, so the family is whatever the caller typed. Completion
	 * then treats that string as the author identity and only excludes families
	 * matching it by name, which lets an agent review its own product code by
	 * declaring a family it does not belong to.
	 *
	 * Severity HIGH — this is the cross-family review requirement, bypassed.
	 */
	it("F1: refuses an admission whose executor claims a family it is not in", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("agent-a", "runner");
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
				return modify("packages/app/src/thing.ts");
			},
			async readRef() {
				return head;
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		// agent-a is the reviewer for actual-family, and nothing else exists.
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: { "actual-family": { reviewerAgentId: "agent-a" } },
		});

		const admit = admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-f1-admission",
			projectId: "project-a",
			issueId: "issue-qa-f1",
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
					// agent-a really belongs to actual-family. It declares otherwise.
					executor: executor("agent-a", "forged-family"),
				},
			],
			edges: [],
		});

		// The plan wants this refused at the boundary.
		await expect(admit).rejects.toThrow(/family/i);

		// If admission ever stops refusing it, the bypass below must not work:
		// agent-a would be signing off on code agent-a itself produced.
		const admitted = await admit.catch(() => null);
		if (!admitted) return;
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		head = B;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			ports,
			admitted.taskIds.code as string,
		);
		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-f1-self-approval",
			kind: "review_approval",
			projectId: "project-a",
			review: "code",
			subjectDigest: observation.reviewSubjectDigest,
			reviewer: { agentId: "agent-a", generation: 0 },
		});
		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.code as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-f1-completion",
			}),
		).rejects.toThrow();
	});

	it("F1: refuses a cross-family approval signed by the task executor", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("solo", "runner");
		fixture.provision("other-reviewer", "lead");
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
				return modify("packages/app/src/thing.ts");
			},
			async readRef() {
				return head;
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: {
				alpha: { reviewerAgentId: "solo" },
				beta: { reviewerAgentId: "other-reviewer" },
			},
		});
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-f1-self-review-admission",
			projectId: "project-a",
			issueId: "issue-qa-f1-self-review",
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
					executor: executor("solo", "beta"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		head = B;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			ports,
			admitted.taskIds.code as string,
		);
		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-f1-known-family-self-approval",
			kind: "review_approval",
			projectId: "project-a",
			review: "code",
			subjectDigest: observation.reviewSubjectDigest,
			reviewer: {
				agentId: "solo",
				generation: spawn.agent.generation,
			},
		});

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.code as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-f1-known-family-self-review",
			}),
		).rejects.toThrow(/cross-family approval/);
	});

	/**
	 * F2 — plan §T3 says a non-writer node's head subject is "事务内 ship
	 * worktree 的 current span_tip" — read INSIDE the transaction. It is read
	 * before the transaction and never rechecked, so a verdict bound to the old
	 * head still completes the node after a parallel writer moved the span, and
	 * the gate then opens on the newer head that no verdict ever covered.
	 *
	 * The session lock is the seam: a writer landing there is exactly the
	 * concurrency this fence exists for.
	 *
	 * Severity HIGH — evidence stops binding the head that gets merged.
	 */
	it("F2: refuses a non-writer completion whose ship span moved before the transaction", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("qa-agent", "runner");
		const git: GitPort = {
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
		};
		let advanceSpanOnNextLock = false;
		const locks: LaunchLockPort = {
			async withSessionLock(_sessionRef, fn) {
				if (advanceSpanOnNextLock) {
					advanceSpanOnNextLock = false;
					fixture.kernel.write("qa.parallel-writer-advance", (tx) => {
						tx.run(
							`UPDATE meta
							    SET value=json_set(
							          json_set(value,'$.data.head',@head),
							          '$.revision',
							          json_extract(value,'$.revision')+1)
							  WHERE key='span_tip:wt-a'`,
							{ head: B },
						);
					});
				}
				return await fn();
			},
		};
		const { ports } = makePorts(fixture.clock, { git, locks });
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-f2-admission",
			projectId: "project-a",
			issueId: "issue-qa-f2",
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
					executor: executor("qa-agent", "family-a"),
				},
			],
			edges: [],
		});
		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		// The verdict is honestly produced against head A, the span at the time.
		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-f2-verdict",
			kind: "verdict",
			taskId: admitted.taskIds.qa as string,
			attemptId: spawn.attemptId,
			head: A,
			verdict: "pass",
			producer: spawn.agent,
		});
		advanceSpanOnNextLock = true;

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.qa as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-f2-completion",
			}),
		).rejects.toThrow();

		// And the gate must not be open on a head no verdict ever covered.
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ tip: string }>(
						"SELECT json_extract(value,'$.data.tip') AS tip FROM meta WHERE key='ship_gate:issue-qa-f2'",
					)?.tip,
			),
		).not.toBe(B);
	});

	/**
	 * F3 — `usableActor` deliberately accepts a runner that has a live
	 * activation, and `approveShipGate` will pick it. But the ship action has no
	 * task/attempt lineage, and the kernel's own actions table (migration 0006)
	 * says a runner actor must carry the full lineage:
	 *
	 *   CHECK ((attempt_id IS NULL AND attempt_generation IS NULL
	 *           AND activation_id IS NULL)
	 *          OR (task_id IS NOT NULL AND attempt_id IS NOT NULL
	 *              AND attempt_generation IS NOT NULL))
	 *   CHECK (actor_kind='lead' OR activation_id IS NOT NULL)
	 *
	 * So a runner-authorized gate mints a capability that can never be spent:
	 * every merge attempt dies on the CHECK, and a live founder approval is
	 * stranded with no path forward.
	 *
	 * Severity HIGH — a granted founder approval that can never ship.
	 */
	it("F3: never grants ship authority to an actor whose action the kernel will reject", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("target-agent", "runner");
		fixture.provision("busy-runner", "runner");
		const git: GitPort = {
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
		};
		const githubObservation: GitHubObservationPort = {
			async readPrHead() {
				return A;
			},
			async readMergeState() {
				return { state: "open" as const };
			},
		};
		let merges = 0;
		const githubMerge: GitHubMergePort = {
			async merge(_repo, _pr, expectedSha) {
				merges += 1;
				return { mergedSha: expectedSha };
			},
		};
		const { ports } = makePorts(fixture.clock, { git });
		const allPorts = { ...ports, githubObservation, githubMerge };

		// A second issue keeps busy-runner genuinely live, so usableActor accepts it.
		await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: "qa-f3-busy",
			projectId: "project-a",
			issueId: "issue-qa-f3-busy",
			notifyAgentId: "lead-a",
			shipWorktreeId: "wt-busy",
			worktrees: [{ ...WT, worktreeId: "wt-busy", worktreePath: "/tmp/busy" }],
			tasks: [
				{
					localId: "busy",
					kindLabel: "opaque",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: executor("busy-runner", "family-a"),
				},
			],
			edges: [],
		});
		const target = await admitIssueDag(fixture.kernel, allPorts, {
			admissionUid: "qa-f3-target",
			projectId: "project-a",
			issueId: "issue-qa-f3",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "node",
					kindLabel: "opaque",
					contract: [],
					writesRepo: false,
					worktreeId: null,
					executor: executor("target-agent", "family-a"),
				},
			],
			edges: [],
		});
		const spawns = (await dispatchOnce(fixture.kernel, allPorts)).dispatched;
		const targetSpawn = spawns.find(
			(request) => request.taskId === target.taskIds.node,
		) as SpawnRequest;
		await submitNodeCompletion(fixture.kernel, allPorts, {
			taskId: target.taskIds.node as string,
			attemptId: targetSpawn.attemptId,
			activationId: targetSpawn.activationId,
			agent: targetSpawn.agent,
			completionUid: "qa-f3-completion",
		});

		// busy-runner is still live, so it becomes the ship actor.
		const approval = approveShipGate(fixture.kernel, allPorts, {
			issueId: "issue-qa-f3",
			approvalRef: "qa-f3-approval",
			observedTip: A,
			shipTarget: { repo: "owner/repo", pr: 42 },
			actorConfig: {
				defaultActionAgentId: "busy-runner",
				configDigest: "config",
			},
		});
		const chosenActor = fixture.kernel.read(
			(tx) =>
				tx.get<{ actor: string }>(
					"SELECT json_extract(value,'$.data.actor_agent_id') AS actor FROM meta WHERE key='ship_gate:issue-qa-f3'",
				)?.actor,
		);
		expect(chosenActor).toBe("busy-runner");

		// Authority was granted, so it must be spendable. Today this dies on the
		// kernel CHECK constraint and the approval is stranded.
		const shipped = await executeShip(fixture.kernel, allPorts, {
			issueId: "issue-qa-f3",
			capabilityId: approval.capabilityId as string,
			actor: {
				kind: "runner",
				agentId: "busy-runner",
				instanceId: (
					spawns.find(
						(request) => request.taskId !== target.taskIds.node,
					) as SpawnRequest
				).sessionRef,
				generation: 1,
				activationId: (
					spawns.find(
						(request) => request.taskId !== target.taskIds.node,
					) as SpawnRequest
				).activationId,
			},
		});

		expect(shipped).toMatchObject({ status: "succeeded" });
		expect(merges).toBe(1);
	});
});
