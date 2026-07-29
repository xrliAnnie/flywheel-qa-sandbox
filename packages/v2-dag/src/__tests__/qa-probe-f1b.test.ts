import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	type GitPort,
	observeNodeCompletion,
	recordEvidence,
	registerReviewFamilies,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

/**
 * QA probe — does the F1 fix hold when the family authority is registered
 * AFTER admission?
 *
 * plan §2.1a states the invariant unconditionally: "executor 五字段合法,
 * family ∈ families 权威". The fix in admission.ts guards it with
 * `if (familyAuthority)`, so a project that admits before registering its
 * review families skips the check and freezes an unvalidated family string
 * into tasks.payload. Registration is described in the plan as a
 * deployment-time writer, and admission with no authority present is an
 * exercised, supported state, so this ordering is reachable.
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

describe("FLY-1520 QA probe — F1 across registration ordering", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("F1b: still refuses executor self-review when families are registered after admission", async () => {
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

		// Step 1: admit while no family authority exists yet. The guard is
		// skipped, so "forged-family" is frozen into tasks.payload unvalidated.
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-f1b-admission",
			projectId: "project-a",
			issueId: "issue-qa-f1b",
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
					executor: {
						logicalAgentId: "agent-a",
						family: "forged-family",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});

		// Step 2: the deployment registers its families. agent-a really belongs
		// to actual-family — the family it did NOT declare.
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: { "actual-family": { reviewerAgentId: "agent-a" } },
		});

		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		head = B;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			ports,
			admitted.taskIds.code as string,
		);
		// authorFamilies is ["forged-family"], which excludes nothing real, so
		// agent-a's own family stays "eligible" and it signs off on its own code.
		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-f1b-self-approval",
			kind: "review_approval",
			projectId: "project-a",
			review: "code",
			subjectDigest: observation.reviewSubjectDigest,
			reviewer: { agentId: "agent-a", generation: spawn.agent.generation },
		});

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.code as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-f1b-completion",
			}),
		).rejects.toThrow();
	});
});
