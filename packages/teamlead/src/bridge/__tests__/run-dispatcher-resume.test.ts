/**
 * FLY-795 c3-wiring: RunDispatcher.start() threads a computed progressResume into
 * the BlueprintContext, and pins startPoint = branch B tip + shareParentBranch so
 * the worktree rebuild reuses FLY-793's mechanism (progress.md survives). Stub
 * Blueprint captures the ctx the dispatcher builds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressResumeInfo } from "../progress-resume.js";
import {
	type ProjectRuntime,
	type ResumeComputer,
	RunDispatcher,
} from "../run-dispatcher.js";
import { RunnerAdmissionController } from "../runner-admission.js";

describe("RunDispatcher restart-resume wiring (FLY-795)", () => {
	let tmpDir: string;
	let captured: BlueprintContext | undefined;

	function makeRuntime(): ProjectRuntime {
		return {
			blueprint: {
				run: vi.fn(async (_n: unknown, _r: string, ctx: BlueprintContext) => {
					captured = ctx;
					return { success: true, sessionId: "s" };
				}),
			} as unknown as ProjectRuntime["blueprint"],
			projectRoot: tmpDir,
			tmuxSessionName: "runner-test",
			agentDispatcher: {
				dispatchByName: vi.fn(),
			} as unknown as ProjectRuntime["agentDispatcher"],
		};
	}

	function makeDispatcher(resumeComputer?: ResumeComputer): RunDispatcher {
		return new RunDispatcher(
			new Map([["proj", makeRuntime()]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			resumeComputer,
		);
	}

	const RESUME: ProgressResumeInfo = {
		progressPath: "engineering/doc/FLY-795-x/progress.md",
		priorExecutionId: "old-exec",
		resumeKind: "terminate",
		effectiveStage: "implement",
		startPoint: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		shareParentBranch: true,
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly795-resume-"));
		captured = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("threads progressResume + startPoint + shareParentBranch when a resume is computed", async () => {
		const dispatcher = makeDispatcher(() => RESUME);
		await dispatcher.start({
			issueId: "issue-uuid",
			projectName: "proj",
			sessionRole: "implement",
		});
		await dispatcher.drain();
		expect(captured?.progressResume).toEqual({
			progressPath: RESUME.progressPath,
			priorExecutionId: "old-exec",
			resumeKind: "terminate",
			effectiveStage: "implement",
		});
		expect(captured?.startPoint).toBe(RESUME.startPoint);
		expect(captured?.shareParentBranch).toBe(true);
	});

	it("byte-compatible: no resumeComputer ⇒ fresh (no progressResume, no shareParentBranch)", async () => {
		const dispatcher = makeDispatcher(undefined);
		await dispatcher.start({ issueId: "i", projectName: "proj" });
		await dispatcher.drain();
		expect(captured?.progressResume).toBeUndefined();
		expect(captured?.shareParentBranch).toBeUndefined();
		expect(captured?.startPoint).toBeUndefined();
	});

	it("byte-compatible: resumeComputer returns null ⇒ fresh", async () => {
		const dispatcher = makeDispatcher(() => null);
		await dispatcher.start({ issueId: "i", projectName: "proj" });
		await dispatcher.drain();
		expect(captured?.progressResume).toBeUndefined();
		expect(captured?.shareParentBranch).toBeUndefined();
	});

	it("never overrides a caller-supplied startPoint (793 phase handoff pins its own)", async () => {
		const dispatcher = makeDispatcher(() => RESUME);
		await dispatcher.start({
			issueId: "i",
			projectName: "proj",
			sessionRole: "implement",
			startPoint: "caller-pinned-sha",
		} as Parameters<RunDispatcher["start"]>[0]);
		await dispatcher.drain();
		expect(captured?.startPoint).toBe("caller-pinned-sha");
	});
});
