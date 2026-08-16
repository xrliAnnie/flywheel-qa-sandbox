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
	type ContinuityComputer,
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

	function makeDispatcher(
		options: {
			resumeComputer?: ResumeComputer;
			continuityComputer?: ContinuityComputer;
			lifecycleAdmission?: ConstructorParameters<typeof RunDispatcher>[6];
			lifecycleLaunchGuard?: ConstructorParameters<typeof RunDispatcher>[7];
			freshStartAudit?: ConstructorParameters<typeof RunDispatcher>[13];
			doaBackoffAdmission?: ConstructorParameters<typeof RunDispatcher>[14];
		} = {},
	): RunDispatcher {
		return new RunDispatcher(
			new Map([["proj", makeRuntime()]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			options.resumeComputer,
			options.lifecycleAdmission,
			options.lifecycleLaunchGuard,
			undefined,
			undefined,
			undefined,
			undefined,
			options.continuityComputer,
			options.freshStartAudit,
			options.doaBackoffAdmission,
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
		const dispatcher = makeDispatcher({ resumeComputer: () => RESUME });
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
		const dispatcher = makeDispatcher();
		await dispatcher.start({ issueId: "i", projectName: "proj" });
		await dispatcher.drain();
		expect(captured?.progressResume).toBeUndefined();
		expect(captured?.shareParentBranch).toBeUndefined();
		expect(captured?.startPoint).toBeUndefined();
	});

	it("byte-compatible: resumeComputer returns null ⇒ fresh", async () => {
		const dispatcher = makeDispatcher({ resumeComputer: () => null });
		await dispatcher.start({ issueId: "i", projectName: "proj" });
		await dispatcher.drain();
		expect(captured?.progressResume).toBeUndefined();
		expect(captured?.shareParentBranch).toBeUndefined();
	});

	it("never overrides a caller-supplied startPoint (793 phase handoff pins its own)", async () => {
		const dispatcher = makeDispatcher({ resumeComputer: () => RESUME });
		await dispatcher.start({
			issueId: "i",
			projectName: "proj",
			sessionRole: "implement",
			startPoint: "caller-pinned-sha",
		} as Parameters<RunDispatcher["start"]>[0]);
		await dispatcher.drain();
		expect(captured?.startPoint).toBe("caller-pinned-sha");
	});

	it("threads a workflow resume admission with its explicit startPoint", async () => {
		const dispatcher = makeDispatcher();
		const anchor = "a".repeat(40);
		const workflowResume = {
			runId: "run-1",
			admissionKey: "admission-1",
			sourceAttachmentId: "attachment-1",
			anchorRef: "refs/flywheel/checkpoints/run-1/attachment-1",
			anchorCommit: anchor,
			frozenBody: "frozen",
		};
		await dispatcher.start({
			issueId: "issue-uuid",
			projectName: "proj",
			sessionRole: "implement",
			startPoint: anchor,
			workflowResume,
		});
		await dispatcher.drain();

		expect(captured?.startPoint).toBe(anchor);
		expect(captured?.workflowResume).toEqual(workflowResume);
	});

	it("inherits a verified origin tip without enabling DAG workflow semantics", async () => {
		const continuityComputer = vi.fn<ContinuityComputer>(async () => ({
			kind: "found",
			branch: "flywheel-FLY-1718",
			sha: "a".repeat(40),
			prNumber: 813,
			prUrl: "https://github.test/pull/813",
		}));
		const dispatcher = makeDispatcher({ continuityComputer });
		await dispatcher.start({
			issueId: "issue-uuid",
			issueIdentifier: "FLY-1718",
			projectName: "proj",
			sessionRole: "implement",
		});
		await dispatcher.drain();

		expect(continuityComputer).toHaveBeenCalledWith({
			issueId: "issue-uuid",
			projectName: "proj",
			role: "implement",
			shareParentBranch: undefined,
		});
		expect(captured?.startPoint).toBe("a".repeat(40));
		expect(captured?.shareParentBranch).toBeUndefined();
		expect(captured?.progressResume).toBeUndefined();
		expect(captured?.continuityInherit).toEqual({
			branch: "flywheel-FLY-1718",
			sha: "a".repeat(40),
			prNumber: 813,
			prUrl: "https://github.test/pull/813",
		});
	});

	it("fails before lifecycle admission when origin state is indeterminate", async () => {
		const lifecycleAdmission = vi.fn(async () => ({ admitted: true }));
		const runtime = makeRuntime();
		const continuityComputer = vi.fn<ContinuityComputer>(async () => ({
			kind: "indeterminate",
			error: "origin offline",
		}));
		const dispatcher = new RunDispatcher(
			new Map([["proj", runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			lifecycleAdmission,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			continuityComputer,
			undefined,
		);

		await expect(
			dispatcher.start({ issueId: "issue-uuid", projectName: "proj" }),
		).rejects.toMatchObject({
			name: "ContinuityIndeterminateError",
			code: "CONTINUITY_INDETERMINATE",
		});
		expect(lifecycleAdmission).not.toHaveBeenCalled();
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
		expect(dispatcher.getInflightCount()).toBe(0);
	});

	it("runs DOA reconciliation before resume and continuity and stops on denial", async () => {
		const order: string[] = [];
		const resumeComputer = vi.fn(async () => {
			order.push("resume");
			return null;
		});
		const continuityComputer = vi.fn<ContinuityComputer>(async () => {
			order.push("continuity");
			return { kind: "missing" };
		});
		const dispatcher = makeDispatcher({
			resumeComputer,
			continuityComputer,
			doaBackoffAdmission: async () => {
				order.push("doa");
				return {
					admitted: false,
					status: "backoff",
					reason: "backoff_active",
					retryAfterSeconds: 60,
				};
			},
		});

		await expect(
			dispatcher.start({ issueId: "issue-uuid", projectName: "proj" }),
		).rejects.toMatchObject({
			name: "DoaBackoffError",
			reason: "backoff_active",
			retryAfterSeconds: 60,
		});
		expect(order).toEqual(["doa"]);
		expect(resumeComputer).not.toHaveBeenCalled();
		expect(continuityComputer).not.toHaveBeenCalled();
	});

	it("exempts Auto-QA and honors the emergency DOA kill switch", async () => {
		const doaBackoffAdmission = vi.fn(async () => ({
			admitted: false,
			status: "needs_lead" as const,
		}));
		const dispatcher = makeDispatcher({ doaBackoffAdmission });
		await dispatcher.start({
			issueId: "issue-uuid",
			projectName: "proj",
			sessionRole: "qa",
			qaContext: {
				parentExecutionId: "parent",
				prNumber: 1,
				prUrl: "https://github.test/pull/1",
				prHeadSha: "b".repeat(40),
			},
		});
		await dispatcher.drain();
		expect(doaBackoffAdmission).not.toHaveBeenCalled();
	});

	it("releases a reserved lane when continuity fails before lifecycle admission", async () => {
		const onSpawnFailed = vi.fn();
		const dispatcher = makeDispatcher({
			doaBackoffAdmission: async () => ({
				admitted: true,
				status: "reserved",
			}),
			continuityComputer: async () => ({
				kind: "indeterminate",
				error: "origin offline",
			}),
			lifecycleLaunchGuard: {
				commitLaunch: async () => ({ ok: true }),
				onSpawnFailed,
			},
		});
		await expect(
			dispatcher.start({ issueId: "issue-uuid", projectName: "proj" }),
		).rejects.toMatchObject({ name: "ContinuityIndeterminateError" });
		expect(onSpawnFailed).toHaveBeenCalledOnce();
	});

	it("preserves byte-compatible fresh context when the remote branch is missing", async () => {
		const dispatcher = makeDispatcher({
			continuityComputer: async () => ({ kind: "missing" }),
		});
		await dispatcher.start({ issueId: "issue-uuid", projectName: "proj" });
		await dispatcher.drain();
		expect(captured?.startPoint).toBeUndefined();
		expect(captured?.continuityInherit).toBeUndefined();
	});

	it.each([
		["caller startPoint", { startPoint: "caller" }],
		[
			"auto-QA",
			{
				sessionRole: "qa",
				qaContext: {
					parentExecutionId: "parent",
					prNumber: 1,
					prUrl: "https://github.test/pull/1",
					prHeadSha: "b".repeat(40),
				},
			},
		],
	] as const)("skips continuity for %s", async (_label, extra) => {
		const continuityComputer = vi.fn<ContinuityComputer>();
		const dispatcher = makeDispatcher({ continuityComputer });
		await dispatcher.start({
			issueId: "issue-uuid",
			projectName: "proj",
			...extra,
		} as Parameters<RunDispatcher["start"]>[0]);
		await dispatcher.drain();
		expect(continuityComputer).not.toHaveBeenCalled();
	});

	it("skips continuity when progress resume succeeds", async () => {
		const continuityComputer = vi.fn<ContinuityComputer>();
		const dispatcher = makeDispatcher({
			resumeComputer: async () => RESUME,
			continuityComputer,
		});
		await dispatcher.start({ issueId: "issue-uuid", projectName: "proj" });
		await dispatcher.drain();
		expect(continuityComputer).not.toHaveBeenCalled();
		expect(captured?.startPoint).toBe(RESUME.startPoint);
	});

	it("an authenticated fresh-start override skips the preserved tip only after durable audit", async () => {
		const freshStartAudit = vi.fn(() => true);
		const dispatcher = makeDispatcher({
			continuityComputer: async () => ({
				kind: "found",
				branch: "flywheel-FLY-1718",
				sha: "a".repeat(40),
			}),
			freshStartAudit,
		});
		await dispatcher.start({
			issueId: "issue-uuid",
			projectName: "proj",
			freshStart: {
				authority: "authenticated_runs_route",
				actor: "master:flywheel-eng-lead",
				reason: "founder requested a clean redesign",
			},
		});
		await dispatcher.drain();

		expect(captured?.startPoint).toBeUndefined();
		expect(captured?.continuityInherit).toBeUndefined();
		expect(freshStartAudit).toHaveBeenCalledWith({
			executionId: expect.any(String),
			projectName: "proj",
			issueId: "issue-uuid",
			role: "main",
			actor: "master:flywheel-eng-lead",
			reason: "founder requested a clean redesign",
			branch: "flywheel-FLY-1718",
			skippedOriginTip: "a".repeat(40),
		});
	});

	it("fails before lifecycle admission if fresh-start evidence cannot be written", async () => {
		const lifecycleAdmission = vi.fn(async () => ({ admitted: true }));
		const dispatcher = makeDispatcher({
			continuityComputer: async () => ({
				kind: "found",
				branch: "flywheel-FLY-1718",
				sha: "a".repeat(40),
			}),
			freshStartAudit: () => false,
			lifecycleAdmission,
		});
		await expect(
			dispatcher.start({
				issueId: "issue-uuid",
				projectName: "proj",
				freshStart: {
					authority: "authenticated_runs_route",
					actor: "master:lead",
					reason: "redo",
				},
			}),
		).rejects.toMatchObject({ name: "FreshStartAuditError" });
		expect(lifecycleAdmission).not.toHaveBeenCalled();
	});
});
