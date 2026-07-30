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
 * QA probe — does the F1c fix also cover a DECLARED review?
 *
 * The completion-side family check fires only when `productOutput` is true.
 * A node that declares `{kind:"review_approval"}` in its contract but writes no
 * product code skips it, so an unvalidated family (admitted before the
 * authority existed) would again exclude nothing — letting the author's own
 * family's reviewer satisfy the declared cross-family review.
 */

const A = "a".repeat(40);
const B = "b".repeat(40);

const WT = {
	worktreeId: "wt-a",
	repoIdentity: "owner/repo",
	worktreePath: "/tmp/wt-a",
	branchRef: "refs/heads/feature",
	mergeTargetRef: "refs/heads/main",
} as const;

describe("FLY-1520 QA probe — declared review under unvalidated family", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("F1d: refuses the author's own family reviewer for a DECLARED review too", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("author", "runner");
		fixture.provision("home-reviewer", "lead");
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
				// docs only — productOutput stays false, so the new
				// completion-side family check never fires.
				return `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0docs/note.md\0`;
			},
			async readRef() {
				return head;
			},
		};
		const { ports } = makePorts(fixture.clock, { git });

		// Admit before the authority exists: "ghost-family" is frozen unvalidated.
		const admitted = await admitIssueDag(fixture.kernel, ports, {
			admissionUid: "qa-f1d-admission",
			projectId: "project-a",
			issueId: "issue-qa-f1d",
			notifyAgentId: "lead-a",
			shipWorktreeId: WT.worktreeId,
			worktrees: [WT],
			tasks: [
				{
					localId: "doc",
					kindLabel: "opaque",
					contract: [{ kind: "review_approval", review: "design" }],
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

		// The author really belongs to home-family, whose designated reviewer is
		// a different agent — so the identity-level self-review check won't fire.
		registerReviewFamilies(fixture.kernel, ports, {
			projectId: "project-a",
			families: { "home-family": { reviewerAgentId: "home-reviewer" } },
		});

		const spawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		head = B;
		const observation = await observeNodeCompletion(
			fixture.kernel,
			ports,
			admitted.taskIds.doc as string,
		);
		recordEvidence(fixture.kernel, ports, {
			eventUid: "qa-f1d-same-family-approval",
			kind: "review_approval",
			projectId: "project-a",
			review: "design",
			subjectDigest: observation.reviewSubjectDigest,
			reviewer: { agentId: "home-reviewer", generation: 0 },
		});

		await expect(
			submitNodeCompletion(fixture.kernel, ports, {
				taskId: admitted.taskIds.doc as string,
				attemptId: spawn.attemptId,
				activationId: spawn.activationId,
				agent: spawn.agent,
				completionUid: "qa-f1d-completion",
			}),
		).rejects.toThrow();
	});
});
