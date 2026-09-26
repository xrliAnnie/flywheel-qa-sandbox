import { describe, expect, it, vi } from "vitest";
import type { ProgressResumeInfo } from "../progress-resume.js";
import { resolveWorkflowStartPolicy } from "../workflow-start-policy.js";

const request = {
	issueId: "FLY-2922",
	role: "design",
	projectName: "flywheel",
};
const resume: ProgressResumeInfo = {
	progressPath: "engineering/doc/FLY-2922/progress.md",
	priorExecutionId: "prior",
	resumeKind: "restart",
	effectiveStage: "implement",
	startPoint: "a".repeat(40),
	shareParentBranch: true,
};
const continuity = {
	kind: "found" as const,
	branch: "flywheel-FLY-2922",
	sha: "b".repeat(40),
	prNumber: 17,
	prUrl: "https://example.invalid/pr/17",
};

describe("shared initial workflow start policy", () => {
	it("preserves resume metadata even when a caller pins the start commit", async () => {
		const observeResume = vi.fn(async () => resume);
		const observeContinuity = vi.fn(async () => continuity);
		const result = await resolveWorkflowStartPolicy(
			{ ...request, startPoint: "c".repeat(40) },
			{ observeResume, observeContinuity },
		);
		expect(result).toMatchObject({
			startPoint: "c".repeat(40),
			resume,
			shareParentBranch: true,
		});
		expect(result.continuityInherit).toBeUndefined();
		expect(observeResume).toHaveBeenCalledOnce();
		expect(observeContinuity).not.toHaveBeenCalled();
	});
	it("uses progress before continuity and retains an explicit sharing override", async () => {
		const observeContinuity = vi.fn(async () => continuity);
		expect(
			await resolveWorkflowStartPolicy(
				{ ...request, shareParentBranch: false },
				{ observeResume: async () => resume, observeContinuity },
			),
		).toMatchObject({
			startPoint: resume.startPoint,
			resume,
			shareParentBranch: false,
		});
		expect(observeContinuity).not.toHaveBeenCalled();
	});
	it("keeps the complete continuity context needed to distinguish worktree takeover", async () => {
		expect(
			await resolveWorkflowStartPolicy(request, {
				observeResume: async () => null,
				observeContinuity: async () => continuity,
			}),
		).toEqual({
			resume: null,
			startPoint: continuity.sha,
			shareParentBranch: undefined,
			continuityInherit: {
				branch: continuity.branch,
				sha: continuity.sha,
				prNumber: 17,
				prUrl: continuity.prUrl,
			},
			continuityBranch: continuity.branch,
			skippedOriginTip: continuity.sha,
		});
	});
	it("leaves a confirmed missing branch to WorktreeManager's existing default", async () => {
		const result = await resolveWorkflowStartPolicy(request, {
			observeResume: async () => null,
			observeContinuity: async () => ({
				kind: "missing",
				branch: continuity.branch,
			}),
		});
		expect(result.startPoint).toBeUndefined();
		expect(result.continuityInherit).toBeUndefined();
	});
	it("refuses indeterminate continuity rather than silently selecting the default", async () => {
		await expect(
			resolveWorkflowStartPolicy(request, {
				observeResume: async () => null,
				observeContinuity: async () => ({
					kind: "indeterminate",
					error: "origin unreachable",
				}),
			}),
		).rejects.toMatchObject({
			name: "ContinuityIndeterminateError",
			code: "CONTINUITY_INDETERMINATE",
		});
	});
	it("preserves fresh-start audit inputs without inheriting progress or origin", async () => {
		const result = await resolveWorkflowStartPolicy(
			{ ...request, freshStart: true },
			{
				observeResume: async () => resume,
				observeContinuity: async () => continuity,
			},
		);
		expect(result).toMatchObject({
			resume: null,
			continuityBranch: continuity.branch,
			skippedOriginTip: continuity.sha,
		});
		expect(result.startPoint).toBeUndefined();
		expect(result.continuityInherit).toBeUndefined();
	});
	it("rejects a fresh caller pin before performing either observation", async () => {
		const observeResume = vi.fn(async () => resume);
		const observeContinuity = vi.fn(async () => continuity);
		await expect(
			resolveWorkflowStartPolicy(
				{ ...request, freshStart: true, startPoint: "c".repeat(40) },
				{ observeResume, observeContinuity },
			),
		).rejects.toMatchObject({ name: "FreshStartAuditError" });
		expect(observeResume).not.toHaveBeenCalled();
		expect(observeContinuity).not.toHaveBeenCalled();
	});
});
