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
 * QA probe — residual F1 variant after the identity-level self-review fix.
 *
 * `hasApproval` now excludes the task's own executor by agent id, which kills
 * single-agent self-review outright. This probe asks the narrower question the
 * identity check cannot answer: if the declared family was never validated
 * (admission ran before the authority existed), can the author's OWN family's
 * designated reviewer sign the author's product code and have it counted as
 * cross-family?
 *
 * plan §2.1a requires `family ∈ families 权威` unconditionally at admission.
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

describe("FLY-1520 QA probe — same-family review under unvalidated family", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("F1c: refuses the author's own family reviewer when the declared family was never validated", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("author", "runner");
		fixture.provision("same-family-reviewer", "lead");
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

		// Admit before any authority exists: the declared family is frozen
		// unvalidated. "ghost-family" is not a real family of this project.
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-f1c-admission",
			projectId: "project-a",
			issueId: "issue-qa-f1c",
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
						family: "ghost-family",
						vendor: "vendor",
						model: "model",
						effort: "high",
					},
				},
			],
			edges: [],
		});

		// The deployment registers families. The author really belongs to
		// home-family, whose designated reviewer is a DIFFERENT agent — so the
		// identity-level self-review check does not fire.
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: {
				"home-family": { reviewerAgentId: "same-family-reviewer" },
			},
		});

		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		head = B;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			ports,
			admitted.taskIds.code as string,
		);
		// authorFamilies is ["ghost-family"], so home-family is never excluded
		// and the author's own family signs off on the author's code.
		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-f1c-same-family-approval",
			kind: "review_approval",
			projectId: "project-a",
			review: "code",
			subjectDigest: observation.reviewSubjectDigest,
			reviewer: { agentId: "same-family-reviewer", generation: 0 },
		});

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.code as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-f1c-completion",
			}),
		).rejects.toThrow();
	});
});
