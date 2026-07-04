import { describe, expect, it, vi } from "vitest";
import {
	computeProgressResume,
	type ProgressResumeDeps,
	stageToPhase,
} from "../progress-resume.js";

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
	it("returns the resume params when a prior execution + branch progress.md exist", () => {
		const r = computeProgressResume(
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

	it("reads the BRANCH blob, not the worktree fs (worktree may be gone on reboot)", () => {
		const readBranchFile = vi.fn(() => ledger);
		computeProgressResume(
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

	it("no resume when there is no prior execution", () => {
		expect(
			computeProgressResume(
				"i",
				"implement",
				"terminate",
				makeDeps({ priorSession: () => undefined }),
			),
		).toBeNull();
	});

	it("no resume when progress.md is not committed on the branch (→ fresh)", () => {
		expect(
			computeProgressResume(
				"i",
				"implement",
				"terminate",
				makeDeps({ readBranchFile: () => null }),
			),
		).toBeNull();
	});

	it("effectiveStage from StateStore session_stage when it agrees with the ledger phase", () => {
		const r = computeProgressResume("i", "implement", "terminate", makeDeps());
		expect(r!.effectiveStage).toBe("implement");
	});

	it("fail-closed: effectiveStage is undefined (no suppression) when StateStore stage disagrees with ledger phase", () => {
		// StateStore says design, ledger says implement → mismatch → no suppression
		const r = computeProgressResume(
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

	it("MED-4: with no plan_path, uses a discovered slug-named doc dir on the branch", () => {
		const readBranchFile = vi.fn(() => ledger);
		const discoverDocDir = vi.fn(() => "engineering/doc/FLY-795-restart-slug");
		const r = computeProgressResume(
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

	it("MED-4: plan_path (when present) still wins over branch discovery", () => {
		const discoverDocDir = vi.fn(() => "engineering/doc/FLY-795-other");
		const r = computeProgressResume(
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
