import { describe, expect, it, vi } from "vitest";
import {
	computeProgressResume,
	type ProgressResumeDeps,
	stageToPhase,
} from "../progress-resume.js";
import { computeProgressResumeAcrossRefs } from "../run-infra.js";

/**
 * FLY-795 c3: teamlead computes the typed `progressResume` for a re-dispatch of a
 * DEAD runner (terminate / reboot), reusing FLY-793's shareParentBranch/startPoint
 * worktree mechanism. Codex R2 #3 (read the BRANCH blob, not the worktree fs — the
 * worktree may be gone) + #4 (effectiveStage from StateStore authority, fail-closed
 * on mismatch).
 */
const ledger = [
	"---",
	"issue: FLY-795",
	"phase: implement",
	'phaseCursor: "3/6"',
	"chunks: []",
	"pointers: {}",
	"---",
	"# body",
].join("\n");

function makeDeps(over: Partial<ProgressResumeDeps> = {}): ProgressResumeDeps {
	return {
		docBaseDir: "engineering/doc",
		issueIdentifier: "FLY-795",
		branchName: () => "flywheel-FLY-795",
		priorSession: vi.fn(() => ({
			execution_id: "old-exec",
			plan_path: "engineering/doc/FLY-795-x/plan.md",
			session_stage: "implement",
		})),
		// git cat-file: progress.md IS committed on the branch tip
		readBranchFile: vi.fn(() => ledger),
		branchTip: vi.fn(() => "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
		...over,
	};
}

describe("computeProgressResume (FLY-795)", () => {
	it("awaits asynchronous branch reads before deciding resume", async () => {
		const result = await computeProgressResume(
			"issue-uuid",
			"implement",
			"restart",
			makeDeps({
				readBranchFile: async () => ledger,
				branchTip: async () => "c".repeat(40),
			}),
		);

		expect(result?.startPoint).toBe("c".repeat(40));
	});

	it("returns the resume params when a prior execution + branch progress.md exist", async () => {
		const r = await computeProgressResume(
			"issue-uuid",
			"implement",
			"terminate",
			makeDeps(),
		);
		expect(r).not.toBeNull();
		expect(r!.priorExecutionId).toBe("old-exec");
		expect(r!.resumeKind).toBe("terminate");
		expect(r!.progressPath).toBe("engineering/doc/FLY-795-x/progress.md");
		// reuses 793's worktree mechanism: branch tip + shareParentBranch
		expect(r!.startPoint).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
		expect(r!.shareParentBranch).toBe(true);
	});

	it("reads the BRANCH blob, not the worktree fs (worktree may be gone on reboot)", async () => {
		const readBranchFile = vi.fn(() => ledger);
		await computeProgressResume(
			"issue-uuid",
			"implement",
			"reboot",
			makeDeps({ readBranchFile }),
		);
		// must have consulted the branch, keyed by branch name + progress path
		expect(readBranchFile).toHaveBeenCalledWith(
			"flywheel-FLY-795",
			"engineering/doc/FLY-795-x/progress.md",
		);
	});

	it("no resume when there is no prior execution", async () => {
		expect(
			await computeProgressResume(
				"i",
				"implement",
				"terminate",
				makeDeps({ priorSession: () => undefined }),
			),
		).toBeNull();
	});

	it("no resume when progress.md is not committed on the branch (→ fresh)", async () => {
		expect(
			await computeProgressResume(
				"i",
				"implement",
				"terminate",
				makeDeps({ readBranchFile: () => null }),
			),
		).toBeNull();
	});

	it("effectiveStage from StateStore session_stage when it agrees with the ledger phase", async () => {
		const r = await computeProgressResume(
			"i",
			"implement",
			"terminate",
			makeDeps(),
		);
		expect(r!.effectiveStage).toBe("implement");
	});

	it("fail-closed: effectiveStage is undefined (no suppression) when StateStore stage disagrees with ledger phase", async () => {
		// StateStore says design, ledger says implement → mismatch → no suppression
		const r = await computeProgressResume(
			"i",
			"implement",
			"terminate",
			makeDeps({
				priorSession: () => ({
					execution_id: "old",
					session_stage: "brainstorm",
				}),
			}),
		);
		expect(r).not.toBeNull();
		expect(r!.effectiveStage).toBeUndefined();
	});

	it("MED-4: with no plan_path, uses a discovered slug-named doc dir on the branch", async () => {
		const readBranchFile = vi.fn(() => ledger);
		const discoverDocDir = vi.fn(() => "engineering/doc/FLY-795-restart-slug");
		const r = await computeProgressResume(
			"i",
			"implement",
			"terminate",
			makeDeps({
				priorSession: () => ({
					execution_id: "old",
					session_stage: "implement",
				}), // no plan_path → discovery kicks in
				readBranchFile,
				discoverDocDir,
			}),
		);
		expect(discoverDocDir).toHaveBeenCalledWith("flywheel-FLY-795");
		expect(r!.progressPath).toBe(
			"engineering/doc/FLY-795-restart-slug/progress.md",
		);
		expect(readBranchFile).toHaveBeenCalledWith(
			"flywheel-FLY-795",
			"engineering/doc/FLY-795-restart-slug/progress.md",
		);
	});

	it("MED-4: plan_path (when present) still wins over branch discovery", async () => {
		const discoverDocDir = vi.fn(() => "engineering/doc/FLY-795-other");
		const r = await computeProgressResume(
			"i",
			"implement",
			"terminate",
			makeDeps({ discoverDocDir }), // default priorSession HAS plan_path
		);
		// plan_path dirname wins; discovery not consulted
		expect(discoverDocDir).not.toHaveBeenCalled();
		expect(r!.progressPath).toBe("engineering/doc/FLY-795-x/progress.md");
	});

	it("stageToPhase maps fine stages to design/implement/qa", () => {
		expect(stageToPhase("brainstorm")).toBe("design");
		expect(stageToPhase("design_review")).toBe("design");
		expect(stageToPhase("implement")).toBe("implement");
		expect(stageToPhase("code_review")).toBe("implement");
		expect(stageToPhase("test")).toBe("implement");
		expect(stageToPhase("approve")).toBe("qa");
		expect(stageToPhase("ship")).toBe("qa");
	});
});

describe("FLY-1718 pinned resume refs", () => {
	it("awaits each branch read and pins tree/blob reads to the resolved SHA", async () => {
		const ref = "refs/heads/flywheel-FLY-795";
		const sha = "c".repeat(40);
		const events: string[] = [];
		const git = async (args: string[]): Promise<string | null> => {
			const rendered = args.join(" ");
			events.push(`start:${rendered}`);
			await new Promise((resolve) => setTimeout(resolve, 1));
			events.push(`end:${rendered}`);
			if (rendered === `rev-parse ${ref}^{commit}`) return sha;
			if (rendered === `ls-tree -r --name-only ${sha}`) {
				return "engineering/doc/FLY-795-async/progress.md\n";
			}
			if (
				rendered === `show ${sha}:engineering/doc/FLY-795-async/progress.md`
			) {
				return ledger;
			}
			return null;
		};

		const result = await computeProgressResumeAcrossRefs({
			issueId: "issue-uuid",
			role: "implement",
			docBaseDir: "engineering/doc",
			issueIdentifier: "FLY-795",
			branch: "flywheel-FLY-795",
			refs: [ref],
			prior: {
				execution_id: "old-exec",
				session_stage: "implement",
			},
			git,
		});

		expect(result?.startPoint).toBe(sha);
		expect(events).toEqual([
			`start:rev-parse ${ref}^{commit}`,
			`end:rev-parse ${ref}^{commit}`,
			`start:ls-tree -r --name-only ${sha}`,
			`end:ls-tree -r --name-only ${sha}`,
			`start:show ${sha}:engineering/doc/FLY-795-async/progress.md`,
			`end:show ${sha}:engineering/doc/FLY-795-async/progress.md`,
		]);
	});

	it("never combines a remote ledger with a stale local startPoint", async () => {
		const localRef = "refs/heads/flywheel-FLY-795";
		const remoteRef = "refs/remotes/origin/flywheel-FLY-795";
		const localSha = "a".repeat(40);
		const remoteSha = "b".repeat(40);
		const calls: string[][] = [];
		const git = (args: string[]): string | null => {
			calls.push(args);
			const rendered = args.join(" ");
			if (rendered === `rev-parse ${localRef}^{commit}`) return localSha;
			if (rendered === `rev-parse ${remoteRef}^{commit}`) return remoteSha;
			if (rendered === `show ${localSha}:engineering/doc/FLY-795-x/progress.md`)
				return null;
			if (
				rendered === `show ${remoteSha}:engineering/doc/FLY-795-x/progress.md`
			)
				return ledger;
			return null;
		};

		const result = await computeProgressResumeAcrossRefs({
			issueId: "issue-uuid",
			role: "implement",
			docBaseDir: "engineering/doc",
			issueIdentifier: "FLY-795",
			branch: "flywheel-FLY-795",
			refs: [localRef, remoteRef],
			prior: {
				execution_id: "old-exec",
				plan_path: "engineering/doc/FLY-795-x/plan.md",
				session_stage: "implement",
			},
			git,
		});

		expect(result?.startPoint).toBe(remoteSha);
		expect(calls).toContainEqual([
			"show",
			`${localSha}:engineering/doc/FLY-795-x/progress.md`,
		]);
		expect(calls).toContainEqual([
			"show",
			`${remoteSha}:engineering/doc/FLY-795-x/progress.md`,
		]);
	});
});
