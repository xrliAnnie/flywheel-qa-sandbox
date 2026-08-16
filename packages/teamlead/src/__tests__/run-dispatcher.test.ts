/**
 * FLY-22: RunDispatcher unit tests.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRunnerModelDisplay } from "flywheel-config";
import { buildWindowLabel } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	launchCommitPath,
	type ProjectRuntime,
	preRegistrationVendor,
	RetryDispatcher,
	RunDispatcher,
	runnerDisplayName,
} from "../bridge/run-dispatcher.js";
import * as runInfraModule from "../bridge/run-infra.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";

// Mock flywheel-core openTmuxViewer (no-op in tests)
vi.mock("flywheel-core", async (importOriginal) => {
	const mod = (await importOriginal()) as Record<string, unknown>;
	return { ...mod, openTmuxViewer: vi.fn() };
});

type PhaseRetryProbe = (
	projectRoot: string,
	branch: string,
) =>
	| { kind: "found"; sha: string }
	| { kind: "missing" }
	| { kind: "indeterminate"; error: string };

describe("FLY-1257 phase retry branch-tip probe", () => {
	const dirs: string[] = [];
	const probe = () =>
		(
			runInfraModule as unknown as {
				probePhaseRetryBranchTip?: PhaseRetryProbe;
			}
		).probePhaseRetryBranchTip;

	function git(cwd: string, args: string[]): string {
		return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
	}

	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "fly1257-phase-retry-"));
		dirs.push(dir);
		git(dir, ["init", "-q"]);
		git(dir, ["config", "user.email", "test@example.com"]);
		git(dir, ["config", "user.name", "Flywheel Test"]);
		writeFileSync(join(dir, "base.txt"), "base\n");
		git(dir, ["add", "base.txt"]);
		git(dir, ["commit", "-qm", "base"]);
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("returns found with the fully-qualified local branch tip", () => {
		const dir = makeRepo();
		const branch = "flywheel-FLY-1257";
		git(dir, ["branch", branch]);
		const expected = git(dir, ["rev-parse", "HEAD"]);
		expect(probe()).toBeTypeOf("function");
		expect(probe()?.(dir, branch)).toEqual({ kind: "found", sha: expected });
	});

	it("returns missing for a confirmed absent branch", () => {
		const dir = makeRepo();
		expect(probe()).toBeTypeOf("function");
		expect(probe()?.(dir, "flywheel-FLY-1257")).toEqual({ kind: "missing" });
	});

	it("same-name tag cannot impersonate the missing refs/heads branch", () => {
		const dir = makeRepo();
		const name = "flywheel-FLY-1257";
		git(dir, ["tag", name]);
		expect(probe()).toBeTypeOf("function");
		expect(probe()?.(dir, name)).toEqual({ kind: "missing" });
	});

	it("fatal git/repository errors are indeterminate, never missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1257-not-repo-"));
		dirs.push(dir);
		mkdirSync(join(dir, "nested"));
		expect(probe()).toBeTypeOf("function");
		expect(probe()?.(join(dir, "nested"), "flywheel-FLY-1257")).toMatchObject({
			kind: "indeterminate",
		});
	});
});

function mockBlueprint() {
	return {
		run: vi.fn().mockResolvedValue({ success: true }),
	};
}

function makeRuntime(projectName: string): [string, ProjectRuntime] {
	return [
		projectName,
		{
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			blueprint: mockBlueprint() as any,
			projectRoot: `/tmp/${projectName}`,
			tmuxSessionName: `runner-${projectName}`,
		},
	];
}

class CleanupObservingRunDispatcher extends RunDispatcher {
	cleanupCalls = 0;

	protected override preRegisterCommDb(): void {}

	protected override cleanupPreRegistration(): void {
		this.cleanupCalls += 1;
	}

	simulateForeignInflightAbort(
		key: string,
		failedExecutionId: string,
		liveExecutionId: string,
	): string | undefined {
		this.inflight.set(key, {
			executionId: liveExecutionId,
			promise: Promise.resolve(),
		});
		this.abortPreLaunch(key, failedExecutionId, "TestProject", false);
		return this.inflight.get(key)?.executionId;
	}

	seedInflight(issueId: string, role: string, executionId: string): void {
		this.inflight.set(this.inflightKey(issueId, role), {
			executionId,
			promise: new Promise(() => {}),
		});
	}
}

function cleanupDispatcherWithTerminalProbe(
	runtimes: Map<string, ProjectRuntime>,
	probe: (executionId: string) => boolean,
): CleanupObservingRunDispatcher {
	return new CleanupObservingRunDispatcher(
		runtimes,
		[],
		RunnerAdmissionController.alwaysAdmit(),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		probe,
	);
}

describe("RunDispatcher", () => {
	it("does not delete another launch's inflight entry during a pre-launch abort", () => {
		const dispatcher = new CleanupObservingRunDispatcher(
			new Map([makeRuntime("TestProject")]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		expect(
			dispatcher.simulateForeignInflightAbort(
				"FLY-1718:main",
				"failed-before-inflight",
				"live-launch",
			),
		).toBe("live-launch");
	});

	it("returns a non-rejecting typed precommit outcome for a generalized tmux hold", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		vi.mocked(runtime.blueprint.run).mockResolvedValue({
			success: false,
			error: "tmux session ensure held: saturated",
			launchFailure: {
				code: "LAUNCH_TMUX_SESSION_HELD",
				reason: "saturated",
				physicalEvidence: "absent",
			},
		});
		const dispatcher = new CleanupObservingRunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		const result = await dispatcher.start({
			issueId: "FLY-1638",
			projectName: "TestProject",
			leadId: "flywheel-eng-lead",
			generalizedExecution: {
				engineOwned: true,
				executionId: "launch-exec",
				activationId: "activation-launch-exec",
				runId: "launch-run",
				nodeId: "execute",
				attempt: 1,
				snapshotDigest: "digest",
				gateCarrierEpoch: 0,
				dispatch: { vendor: "claude", model: "claude-opus-5" },
				capabilities: {},
				agentContent: "Execute.",
				idempotencyKey: "launch-key",
				launchGateToken: "launch-token",
				commitWorkflowLaunch: vi.fn(() => ({ ok: true })),
				projectTurn: vi.fn(() => ({
					ok: true,
					idempotentReplay: false,
				})),
			},
		});

		await expect(result.launchOutcome).resolves.toEqual({
			status: "precommit_failed",
			failure: {
				code: "LAUNCH_TMUX_SESSION_HELD",
				reason: "saturated",
				physicalEvidence: "absent",
			},
		});
	});

	it("fails closed before launch when a design node has no resolved Lead", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const dispatcher = new RunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await expect(
			dispatcher.start({
				issueId: "FLY-1404",
				projectName: "TestProject",
				sessionRole: "design",
				shareParentBranch: true,
			}),
		).rejects.toThrow(/design-node.*resolved Lead/i);
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
		expect(dispatcher.getInflightCount()).toBe(0);
	});

	it("fails closed before launch for an illegal generalized design capability", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const dispatcher = new RunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await expect(
			dispatcher.start({
				issueId: "FLY-1404",
				projectName: "TestProject",
				leadId: "flywheel-eng-lead",
				generalizedExecution: {
					engineOwned: true,
					executionId: "design-exec",
					runId: "design-run",
					nodeId: "design",
					attempt: 1,
					snapshotDigest: "digest",
					dispatch: {
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "high",
					},
					capabilities: {
						shared_branch_writer: false,
						completion_route: "phase_design_complete",
					},
					agentContent: "Design the bounded surface.",
					idempotencyKey: "design-key",
				},
			}),
		).rejects.toThrow(/design-node.*shared branch writer/i);
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
	});

	it("marks a fresh credential-backed generalized execution as submission-expected", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const dispatcher = new RunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await dispatcher.start({
			issueId: "FLY-1425",
			projectName: "TestProject",
			leadId: "flywheel-eng-lead",
			generalizedExecution: {
				engineOwned: true,
				executionId: "qa-engine-exec",
				activationId: "activation-qa-engine-exec",
				runId: "run-engine",
				nodeId: "qa",
				attempt: 1,
				snapshotDigest: "digest",
				dispatch: {
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "high",
				},
				capabilities: {
					emits_decisions: true,
					completion_route: "no_code",
				},
				agentContent: "Verify and submit the QA decision.",
				submissionCredential: "decision-ticket",
				idempotencyKey: "qa-engine-key",
				projectTurn: vi.fn(() => ({
					ok: true,
					idempotentReplay: false,
				})),
			},
		});
		await dispatcher.drain();

		const run = (
			runtime.blueprint as unknown as { run: ReturnType<typeof vi.fn> }
		).run;
		expect(run.mock.calls[0]?.[2]).toMatchObject({
			launchCommitPath: launchCommitPath("qa-engine-exec"),
			workflowSubmissionCredential: "decision-ticket",
			workflowSubmissionExpected: true,
		});
	});
	it("start() returns executionId and issueId", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		const result = await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});

		expect(result.executionId).toBeDefined();
		expect(result.issueId).toBe("GEO-1");
	});

	it("clears guarded inflight state when setup throws before Blueprint.run", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const onSpawnFailed = vi.fn();
		const resumeComputer = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("resume probe exploded");
			})
			.mockReturnValue(null);
		const dispatcher = new CleanupObservingRunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			resumeComputer,
			undefined,
			{ commitLaunch: vi.fn(async () => ({ ok: true })), onSpawnFailed },
		);

		await expect(
			dispatcher.start({ issueId: "GEO-SETUP", projectName: "TestProject" }),
		).rejects.toThrow("resume probe exploded");
		expect(dispatcher.getInflightCount()).toBe(0);
		expect(dispatcher.cleanupCalls).toBe(1);
		expect(onSpawnFailed).toHaveBeenCalledOnce();

		await expect(
			dispatcher.start({ issueId: "GEO-SETUP", projectName: "TestProject" }),
		).resolves.toMatchObject({ issueId: "GEO-SETUP" });
		expect(runtime.blueprint.run).toHaveBeenCalledOnce();
	});

	it("FLY-1279 uses a caller-prebound successor execution id", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		const result = await dispatcher.start({
			issueId: "FLY-1279-QA",
			projectName: "TestProject",
			sessionRole: "qa",
			successorExecutionId: "qa-recovery-exec",
		});

		expect(result.executionId).toBe("qa-recovery-exec");
	});

	it("FLY-1279 auto-QA skips phase resume and preserves fresh-worktree false", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const resumeComputer = vi.fn(() => ({
			startPoint: "resume-tip",
			progressPath: "engineering/doc/progress.md",
			priorExecutionId: "old-phase",
			resumeKind: "restart" as const,
		}));
		const dispatcher = new RunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			resumeComputer,
		);

		await dispatcher.start({
			issueId: "qa-issue-uuid",
			projectName: "TestProject",
			sessionRole: "qa",
			shareParentBranch: false,
			startPoint: "a".repeat(40),
			qaContext: {
				parentExecutionId: "parent-exec",
				prHeadSha: "a".repeat(40),
			},
		});

		expect(resumeComputer).not.toHaveBeenCalled();
		const ctx = (
			runtime.blueprint as unknown as { run: ReturnType<typeof vi.fn> }
		).run.mock.calls[0]?.[2];
		expect(ctx).toMatchObject({
			shareParentBranch: false,
			startPoint: "a".repeat(40),
		});
		expect(ctx.progressResume).toBeUndefined();
	});

	it("FLY-1259: start() carries designBackend into Blueprint context", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await dispatcher.start({
			issueId: "FLY-1259",
			projectName: "TestProject",
			designBackend: "codex",
		});
		await new Promise((resolve) => setImmediate(resolve));

		const blueprint = runtimes.get("TestProject")!.blueprint;
		const ctx = vi.mocked(blueprint.run).mock.calls[0]?.[2];
		expect(ctx?.designBackend).toBe("codex");
	});

	it("start() rejects when shutting down", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		dispatcher.stopAccepting();

		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "TestProject" }),
		).rejects.toThrow("shutting down");
	});

	it("admission pause returns its typed retry contract before shutdown", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const admission = RunnerAdmissionController.alwaysAdmit();
		admission.setAdmissionPauseProbe(() => ({
			detail: "deployment pause",
			retryAfterSeconds: 90,
		}));
		const dispatcher = new RunDispatcher(runtimes, [], admission);
		dispatcher.stopAccepting();

		await expect(
			dispatcher.start({ issueId: "FLY-1638", projectName: "TestProject" }),
		).rejects.toMatchObject({
			name: "AdmissionDeferredError",
			reason: "admission_paused",
			retryAfterSeconds: 90,
		});
	});

	it("FLY-123 WS-D (P4): start() defers under resource pressure (not a count cap)", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		// Admission controller under load → defers regardless of count.
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysDefer(),
		);

		// Even the FIRST start is deferred when the box is under pressure —
		// admission is resource-based, not count-based. Typed error (R1 #4) so
		// the route maps it to 429, not 500.
		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "TestProject" }),
		).rejects.toMatchObject({
			name: "AdmissionDeferredError",
			reason: "load_pressure",
		});
	});

	it("start() rejects duplicate issue", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});

		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "TestProject" }),
		).rejects.toThrow("already in progress");
	});

	it("start() rejects unknown project", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await expect(
			dispatcher.start({ issueId: "GEO-1", projectName: "NoSuchProject" }),
		).rejects.toThrow("No runtime for project");
	});

	it("getInflightCount() tracks inflight runs", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		expect(dispatcher.getInflightCount()).toBe(0);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});
		expect(dispatcher.getInflightCount()).toBe(1);
	});

	it("inflight clears after blueprint.run() completes", async () => {
		let resolveRun!: () => void;
		const blueprint = {
			run: vi.fn(
				() =>
					new Promise<{ success: boolean }>((resolve) => {
						resolveRun = () => resolve({ success: true });
					}),
			),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});
		expect(dispatcher.getInflightCount()).toBe(1);

		// Complete the run
		resolveRun();
		await dispatcher.drain();
		expect(dispatcher.getInflightCount()).toBe(0);
	});

	it.each(["resolved failure", "rejected launch"] as const)(
		"clears a generalized %s before publishing its launch outcome",
		async (failureMode) => {
			let resolveFirst!: (result: { success: false; error: string }) => void;
			let rejectFirst!: (error: Error) => void;
			const firstRun = new Promise<{ success: false; error: string }>(
				(resolve, reject) => {
					resolveFirst = resolve;
					rejectFirst = reject;
				},
			);
			const blueprint = {
				run: vi
					.fn()
					.mockImplementationOnce(() => firstRun)
					.mockImplementationOnce(() => new Promise(() => {})),
			};
			const runtime: ProjectRuntime = {
				blueprint: blueprint as unknown as ProjectRuntime["blueprint"],
				projectRoot: "/tmp/test",
				tmuxSessionName: "runner-test",
			};
			const dispatcher = new CleanupObservingRunDispatcher(
				new Map([["TestProject", runtime]]),
				[],
				RunnerAdmissionController.alwaysAdmit(),
			);
			const generalizedExecution = (executionId: string) => ({
				engineOwned: true as const,
				executionId,
				activationId: `activation-${executionId}`,
				runId: "run-1",
				nodeId: "implement",
				attempt: 1,
				snapshotDigest: "digest",
				gateCarrierEpoch: 0,
				dispatch: { vendor: "codex" as const, model: "gpt-5.6-sol" },
				capabilities: {},
				agentContent: "Implement.",
				idempotencyKey: `launch-${executionId}`,
				launchGateToken: `token-${executionId}`,
				commitWorkflowLaunch: vi.fn(() => ({ ok: true })),
				projectTurn: vi.fn(() => ({
					ok: true as const,
					idempotentReplay: false,
				})),
			});

			const first = await dispatcher.start({
				issueId: "FLY-1775",
				projectName: "TestProject",
				sessionRole: "implement",
				generalizedExecution: generalizedExecution("exec-old"),
			});
			const replacement = first.launchOutcome?.then(() =>
				dispatcher.start({
					issueId: "FLY-1775",
					projectName: "TestProject",
					sessionRole: "implement",
					generalizedExecution: generalizedExecution("exec-new"),
				}),
			);

			if (failureMode === "resolved failure") {
				resolveFirst({ success: false, error: "hold_lock_unavailable" });
			} else {
				rejectFirst(new Error("hold_lock_unavailable"));
			}

			await expect(replacement).resolves.toMatchObject({
				executionId: "exec-new",
			});
			expect(blueprint.run).toHaveBeenCalledTimes(2);
		},
	);

	it("evicts an irreversible-terminal execution and a late old settle cannot erase its replacement", async () => {
		let resolveOld!: (result: { success: true }) => void;
		const blueprint = {
			run: vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<{ success: true }>((resolve) => {
							resolveOld = resolve;
						}),
				)
				.mockImplementationOnce(() => new Promise(() => {})),
		};
		const runtime: ProjectRuntime = {
			blueprint: blueprint as unknown as ProjectRuntime["blueprint"],
			projectRoot: "/tmp/test",
			tmuxSessionName: "runner-test",
		};
		const terminal = new Set<string>();
		const dispatcher = cleanupDispatcherWithTerminalProbe(
			new Map([["TestProject", runtime]]),
			(executionId) => terminal.has(executionId),
		);
		const generalizedExecution = (executionId: string) => ({
			engineOwned: true as const,
			executionId,
			activationId: `activation-${executionId}`,
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			snapshotDigest: "digest",
			gateCarrierEpoch: 0,
			dispatch: { vendor: "codex" as const, model: "gpt-5.6-sol" },
			capabilities: {},
			agentContent: "Implement.",
			idempotencyKey: `launch-${executionId}`,
			launchGateToken: `token-${executionId}`,
			commitWorkflowLaunch: vi.fn(() => ({ ok: true })),
			projectTurn: vi.fn(() => ({
				ok: true as const,
				idempotentReplay: false,
			})),
		});

		await dispatcher.start({
			issueId: "FLY-1775",
			projectName: "TestProject",
			sessionRole: "implement",
			generalizedExecution: generalizedExecution("exec-old"),
		});
		terminal.add("exec-old");
		await expect(
			dispatcher.start({
				issueId: "FLY-1775",
				projectName: "TestProject",
				sessionRole: "implement",
				generalizedExecution: generalizedExecution("exec-new"),
			}),
		).resolves.toMatchObject({ executionId: "exec-new" });

		resolveOld({ success: true });
		await new Promise((resolve) => setImmediate(resolve));
		expect(dispatcher.getInflightCount()).toBe(1);
		expect(dispatcher.hasInflightForRole("FLY-1775", "implement")).toBe(true);
		expect(blueprint.run).toHaveBeenCalledTimes(2);
	});

	it("removes irreversible-terminal entries from every public inflight probe", () => {
		const makeSeeded = () => {
			const dispatcher = cleanupDispatcherWithTerminalProbe(
				new Map([makeRuntime("TestProject")]),
				() => true,
			);
			dispatcher.seedInflight("FLY-1775", "implement", "exec-terminal");
			return dispatcher;
		};

		expect(makeSeeded().hasInflightForRole("FLY-1775", "implement")).toBe(
			false,
		);
		expect(makeSeeded().getInflightIssues()).toEqual(new Set());
		expect(makeSeeded().getInflightCount()).toBe(0);
	});

	it("keeps the lane occupied when the terminal-session probe is unreadable", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const dispatcher = cleanupDispatcherWithTerminalProbe(
			new Map([makeRuntime("TestProject")]),
			() => {
				throw new Error("state store unavailable");
			},
		);
		dispatcher.seedInflight("FLY-1775", "implement", "exec-unknown");

		expect(dispatcher.hasInflightForRole("FLY-1775", "implement")).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("keeping lane occupied"),
		);
		warn.mockRestore();
	});
});

describe("RetryDispatcher", () => {
	it("routes retry/dead-replacement dispatch through the admission pause", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const admission = RunnerAdmissionController.alwaysAdmit();
		admission.setAdmissionPauseProbe(() => ({
			detail: "deployment pause",
			retryAfterSeconds: 120,
		}));
		const dispatcher = new RetryDispatcher(
			new Map([[name, runtime]]),
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			admission,
		);

		await expect(
			dispatcher.dispatch({
				oldExecutionId: "old-exec",
				issueId: "FLY-1638",
				projectName: "TestProject",
				runAttempt: 2,
			}),
		).rejects.toMatchObject({
			name: "AdmissionDeferredError",
			reason: "admission_paused",
			retryAfterSeconds: 120,
		});
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
	});

	it("fails closed before retry launch when a design node has no resolved Lead", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const dispatcher = new RetryDispatcher(new Map([[name, runtime]]), []);

		await expect(
			dispatcher.dispatch({
				oldExecutionId: "old-design",
				issueId: "FLY-1404",
				projectName: "TestProject",
				runAttempt: 2,
				sessionRole: "design",
				shareParentBranch: true,
			}),
		).rejects.toThrow(/design-node.*resolved Lead/i);
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
	});
	it("keeps the resolved Codex model in a retried implement-phase window", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		// FLY-1257 defect ③: a DAG workflow retry (shareParentBranch +
		// design/implement/qa role) now resolves branch B's tip through the
		// startPoint computer, and fails closed when it cannot — an indeterminate
		// probe must never silently reset branch B to origin/main. This FLY-1255
		// model-display test predates that dependency, so it supplies the computer
		// the same way production wiring does; the assertion below is unchanged.
		const dispatcher = new RetryDispatcher(
			new Map([[name, runtime]]),
			[],
			undefined, // launchClaims
			undefined, // isCommitted (keep the real default)
			undefined, // lifecycleAdmission
			undefined, // lifecycleLaunchGuard
			() => ({ kind: "found", sha: "b".repeat(40) }),
		);

		await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "FLY-1255",
			projectName: "TestProject",
			runAttempt: 1,
			sessionRole: "implement",
			shareParentBranch: true,
			ignoreRunnerLabelSelection: true,
			dispatchVendor: "codex",
			dispatchModel: "gpt-5.6-sol",
		});

		const ctx = vi.mocked(runtime.blueprint.run).mock.calls[0]?.[2];
		expect(ctx?.runnerName).toBe("implement-codex-G");
	});

	it("dispatch() returns old and new execution IDs", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RetryDispatcher(runtimes, []);

		const result = await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "GEO-1",
			projectName: "TestProject",
			runAttempt: 1,
		});

		expect(result.oldExecutionId).toBe("old-exec");
		expect(result.newExecutionId).toBeDefined();
	});

	it("FLY-1259: dispatch() carries designBackend into Blueprint context", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RetryDispatcher(runtimes, []);

		await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "FLY-1259",
			projectName: "TestProject",
			runAttempt: 1,
			designBackend: "claude",
		});
		await new Promise((resolve) => setImmediate(resolve));

		const blueprint = runtimes.get("TestProject")!.blueprint;
		const ctx = vi.mocked(blueprint.run).mock.calls[0]?.[2];
		expect(ctx?.designBackend).toBe("claude");
	});

	it("dispatch() rejects duplicate issue", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RetryDispatcher(runtimes, []);

		await dispatcher.dispatch({
			oldExecutionId: "old-1",
			issueId: "GEO-1",
			projectName: "TestProject",
			runAttempt: 1,
		});

		await expect(
			dispatcher.dispatch({
				oldExecutionId: "old-2",
				issueId: "GEO-1",
				projectName: "TestProject",
				runAttempt: 2,
			}),
		).rejects.toThrow("already in progress");
	});

	it("teardownRuntimes() calls cleanup handles", async () => {
		const cleanup = vi.fn().mockResolvedValue(undefined);
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RetryDispatcher(runtimes, [cleanup]);

		await dispatcher.teardownRuntimes();
		expect(cleanup).toHaveBeenCalledOnce();
	});
});

// ── FLY-751: runner MCP slim profile wiring (start + retry) ──────────────

describe("FLY-751: runnerMcpProfile wiring", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// FLY-812 (founder review 2026-07-03): chrome defaults ON and the default
	// slim is serena ONLY (discord + playwright kept fleet-wide for
	// runner/geoforge3d testing). disableChrome:false unless the runner opts out.
	// FLY-1185 §2.7: profiles carry the positive playwright opt-in channel.
	const DEFAULT_PROFILE = {
		disabledPlugins: ["serena@claude-plugins-official"],
		disableChrome: false,
		enabledPluginsExtra: [],
	};

	function startWith(req: Record<string, unknown>) {
		const [name, runtime] = makeRuntime("TestProject");
		const runtimes = new Map([[name, runtime]]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		return {
			dispatcher,
			runtime,
			start: () =>
				dispatcher.start({
					issueId: "FLY-751",
					projectName: "TestProject",
					...req,
				}),
		};
	}

	function ctxOf(runtime: ProjectRuntime) {
		const run = (
			runtime.blueprint as unknown as { run: ReturnType<typeof vi.fn> }
		).run;
		expect(run).toHaveBeenCalledOnce();
		return run.mock.calls[0][2];
	}

	it("start(): default claude-tmux run gets the plugin slim, chrome on", async () => {
		const { runtime, start } = startWith({});
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toEqual(DEFAULT_PROFILE);
	});

	it("start(): no-chrome label flows through → serena slimmed + chrome off", async () => {
		const { runtime, start } = startWith({ issueLabels: ["no-chrome"] });
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: true,
			enabledPluginsExtra: [],
		});
	});

	it("start(): QA run gets the serena-only slim, chrome on, playwright opt-in", async () => {
		const { runtime, start } = startWith({ sessionRole: "qa" });
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toEqual({
			...DEFAULT_PROFILE,
			enabledPluginsExtra: ["playwright@claude-plugins-official"],
		});
	});

	// FLY-1185 §2.7: full-mcp no longer degenerates to null — with the machine
	// default-off in place, "everything available" carries the positive
	// playwright entry (or the machine default would silently win).
	it("start(): full-mcp label → no slim + playwright opt-in survives", async () => {
		const { runtime, start } = startWith({ issueLabels: ["full-mcp"] });
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toEqual({
			disabledPlugins: [],
			disableChrome: false,
			enabledPluginsExtra: ["playwright@claude-plugins-official"],
		});
	});

	it("start(): FLYWHEEL_RUNNER_SLIM_MCP=0 kill-switch (profile null)", async () => {
		vi.stubEnv("FLYWHEEL_RUNNER_SLIM_MCP", "0");
		const { runtime, start } = startWith({});
		await start();
		expect(ctxOf(runtime).runnerMcpProfile).toBeNull();
	});

	it("start(): non-claude backend gets NO profile field at all", async () => {
		const { runtime, start } = startWith({ issueLabels: ["codex"] });
		await start();
		const ctx = ctxOf(runtime);
		expect(ctx.runnerBackend).toBe("codex-tmux");
		expect("runnerMcpProfile" in ctx).toBe(false);
	});

	it("retry: profile recomputed (QA retry gets the serena-only slim)", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const runtimes = new Map([[name, runtime]]);
		const dispatcher = new RetryDispatcher(runtimes, []);
		await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "FLY-751",
			projectName: "TestProject",
			runAttempt: 1,
			sessionRole: "qa",
		});
		expect(ctxOf(runtime).runnerMcpProfile).toEqual({
			...DEFAULT_PROFILE,
			enabledPluginsExtra: ["playwright@claude-plugins-official"],
		});
	});

	it("retry: default run gets the full slim profile", async () => {
		const [name, runtime] = makeRuntime("TestProject");
		const runtimes = new Map([[name, runtime]]);
		const dispatcher = new RetryDispatcher(runtimes, []);
		await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "FLY-751",
			projectName: "TestProject",
			runAttempt: 1,
		});
		expect(ctxOf(runtime).runnerMcpProfile).toEqual(DEFAULT_PROFILE);
	});
});

// ── FLY-95: Resolved failure handling ──────────────

describe("FLY-95: Dispatcher resolved failure handling", () => {
	it("RunDispatcher.start() logs worktreePath on success", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const blueprint = {
			run: vi.fn().mockResolvedValue({
				success: true,
				worktreePath: "/tmp/wt/TestProject/test-GEO-1",
			}),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});
		await dispatcher.drain();

		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("ran in worktree"),
		);
		logSpy.mockRestore();
	});

	it("RunDispatcher.start() warns on resolved failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const blueprint = {
			run: vi.fn().mockResolvedValue({
				success: false,
				error: "git lock error",
			}),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
		});
		await dispatcher.drain();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("resolved with failure"),
		);
		warnSpy.mockRestore();
	});

	it("RetryDispatcher.dispatch() warns on resolved failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const blueprint = {
			run: vi.fn().mockResolvedValue({
				success: false,
				error: "worktree create failed",
			}),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RetryDispatcher(runtimes, []);

		await dispatcher.dispatch({
			oldExecutionId: "old-exec",
			issueId: "GEO-1",
			projectName: "TestProject",
			runAttempt: 1,
		});
		await dispatcher.drain();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("resolved with failure"),
		);
		warnSpy.mockRestore();
	});

	it("FLY-59: same issue different roles can run concurrently", async () => {
		const runtimes = new Map([makeRuntime("TestProject")]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		// Start main role
		const r1 = await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
			sessionRole: "main",
		});
		expect(r1.executionId).toBeDefined();

		// Start qa role for same issue — should succeed
		const r2 = await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
			sessionRole: "qa",
		});
		expect(r2.executionId).toBeDefined();
		expect(r2.executionId).not.toBe(r1.executionId);
	});

	it("FLY-95: role normalization prevents worktree collision", async () => {
		// Use a controlled promise so the first start stays inflight
		let resolveRun!: (v: { success: boolean }) => void;
		const blueprint = {
			run: vi.fn(
				() =>
					new Promise<{ success: boolean }>((resolve) => {
						resolveRun = resolve;
					}),
			),
		};
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"TestProject",
				{
					blueprint: blueprint as any,
					projectRoot: "/tmp/test",
					tmuxSessionName: "runner-test",
				},
			],
		]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);

		// Start "qa" role — stays inflight
		await dispatcher.start({
			issueId: "GEO-1",
			projectName: "TestProject",
			sessionRole: "qa",
		});

		// "QA" normalizes to same key — should reject as duplicate
		await expect(
			dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				sessionRole: "QA",
			}),
		).rejects.toThrow("already in progress");

		// "q/a" also normalizes to "qa" — should reject
		await expect(
			dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				sessionRole: "q/a",
			}),
		).rejects.toThrow("already in progress");

		// Clean up
		resolveRun({ success: true });
		await dispatcher.drain();
	});

	// ══════════════════════════════════════════════════════════════════════
	// FLY-142 PR 1.4 — Agent Team identity wiring
	//
	// QA E1 verify (2026-05-12) found Bug #4: PR #178 added TmuxAdapter
	// transport branch, PR #181 PR #181 added MailboxLeadRuntime — but the
	// dispatch flow NEVER set the agentName/agentTeamName/vendor fields the
	// transport branch requires. claude-code never entered Agent Team mode,
	// `useInboxPoller` never ran, mailbox writes silently landed in a file
	// no one read. These tests pin the wiring so the wake bug fix actually
	// connects end-to-end.
	// ══════════════════════════════════════════════════════════════════════

	describe("FLY-142 PR 1.4 — Agent Team identity in spawn ctx", () => {
		const ORIGINAL_BACKEND = process.env.FLYWHEEL_COMM_BACKEND;
		afterEach(() => {
			if (ORIGINAL_BACKEND === undefined)
				delete process.env.FLYWHEEL_COMM_BACKEND;
			else process.env.FLYWHEEL_COMM_BACKEND = ORIGINAL_BACKEND;
		});

		it("start() under mailbox backend passes agentName/agentTeamName/vendor to Blueprint", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
			const blueprint = { run: vi.fn().mockResolvedValue({ success: true }) };
			const runtimes = new Map<string, ProjectRuntime>([
				[
					"TestProject",
					{
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						blueprint: blueprint as any,
						projectRoot: "/tmp/test",
						tmuxSessionName: "runner-test",
					},
				],
			]);
			const dispatcher = new RunDispatcher(
				runtimes,
				[],
				RunnerAdmissionController.alwaysAdmit(),
			);

			const result = await dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				leadId: "flywheel-test-2",
			});

			// Allow microtasks to drain
			await new Promise((r) => setImmediate(r));
			// blueprint.run signature: (taskNode, projectRoot, ctx) — ctx is arg #2.
			const ctx = blueprint.run.mock.calls[0]?.[2];
			expect(ctx).toBeDefined();
			expect(ctx.vendor).toBe("claude-code");
			expect(ctx.agentTeamName).toBe("flywheel-test-2");
			// FLY-142 transport identity — distinct from FLY-137's
			// `ctx.agentName` (Lead-override dispatcher key).
			expect(ctx.runnerAgentName).toBe(
				`runner-${result.executionId.slice(0, 8)}`,
			);
		});

		it("start() under commdb rollback backend omits Agent Team fields", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "commdb";
			const blueprint = { run: vi.fn().mockResolvedValue({ success: true }) };
			const runtimes = new Map<string, ProjectRuntime>([
				[
					"TestProject",
					{
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						blueprint: blueprint as any,
						projectRoot: "/tmp/test",
						tmuxSessionName: "runner-test",
					},
				],
			]);
			const dispatcher = new RunDispatcher(
				runtimes,
				[],
				RunnerAdmissionController.alwaysAdmit(),
			);

			await dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				leadId: "flywheel-test-2",
			});

			await new Promise((r) => setImmediate(r));
			// blueprint.run signature: (taskNode, projectRoot, ctx) — ctx is arg #2.
			const ctx = blueprint.run.mock.calls[0]?.[2];
			expect(ctx).toBeDefined();
			// Transport wiring stays off on rollback — Agent Team fields absent.
			expect(ctx.runnerAgentName).toBeUndefined();
			expect(ctx.agentTeamName).toBeUndefined();
			expect(ctx.vendor).toBeUndefined();
		});

		it("start() omits Agent Team fields when leadId is missing (defensive)", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
			const blueprint = { run: vi.fn().mockResolvedValue({ success: true }) };
			const runtimes = new Map<string, ProjectRuntime>([
				[
					"TestProject",
					{
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						blueprint: blueprint as any,
						projectRoot: "/tmp/test",
						tmuxSessionName: "runner-test",
					},
				],
			]);
			const dispatcher = new RunDispatcher(
				runtimes,
				[],
				RunnerAdmissionController.alwaysAdmit(),
			);

			await dispatcher.start({
				issueId: "GEO-1",
				projectName: "TestProject",
				// no leadId — shouldn't happen on hot path but guard for safety
			});

			await new Promise((r) => setImmediate(r));
			// blueprint.run signature: (taskNode, projectRoot, ctx) — ctx is arg #2.
			const ctx = blueprint.run.mock.calls[0]?.[2];
			expect(ctx).toBeDefined();
			expect(ctx.runnerAgentName).toBeUndefined();
			expect(ctx.agentTeamName).toBeUndefined();
			expect(ctx.vendor).toBeUndefined();
		});
	});
});

describe("runnerDisplayName + cmux window label (FLY-793 phase visibility)", () => {
	it("includes the vendor-neutral model label when a model was resolved", () => {
		expect(
			runnerDisplayName("implement", true, {
				threadMarker: "G",
				windowLabel: "codex-G",
			}),
		).toBe("implement-codex-G");
		expect(
			runnerDisplayName("main", false, {
				threadMarker: "K",
				windowLabel: "kimi-K",
			}),
		).toBe("runner-kimi-K");
		expect(
			runnerDisplayName("qa", true, {
				threadMarker: "O",
				windowLabel: "claude-Opus",
			}),
		).toBe("qa-claude-Opus");
		expect(
			runnerDisplayName("main", false, {
				threadMarker: "F",
				windowLabel: "claude-Fable",
			}),
		).toBe("runner-claude-Fable");
	});

	it("infers Codex defensively when backend metadata is absent", () => {
		const display = renderRunnerModelDisplay({ model: "gpt-5.6-sol" });
		expect(runnerDisplayName("main", false, display)).toBe("runner-codex-G");
	});

	it("keeps legacy names when no model was resolved", () => {
		expect(runnerDisplayName("implement", true, undefined)).toBe("implement");
		expect(runnerDisplayName("main", false, undefined)).toBe("claude");
	});

	// A DAG workflow runner is (shareParentBranch === true) AND a phase role.
	it("maps a DAG workflow role (shareParentBranch=true) to its phase name", () => {
		expect(runnerDisplayName("design", true)).toBe("design");
		expect(runnerDisplayName("implement", true)).toBe("implement");
		expect(runnerDisplayName("qa", true)).toBe("qa");
	});

	it("byte-compat: non-phase (main / undefined / unknown) stays 'claude'", () => {
		expect(runnerDisplayName("main", true)).toBe("claude");
		expect(runnerDisplayName(undefined, true)).toBe("claude");
		expect(runnerDisplayName("something-else", true)).toBe("claude");
	});

	it("byte-compat: FLY-579 Auto-QA (role='qa' but NO shareParentBranch) stays 'claude'", () => {
		// The Codex R2 regression: Auto-QA shares sessionRole "qa" but is not a
		// DAG workflow (no shareParentBranch), so it must NOT flip to "-qa-".
		expect(runnerDisplayName("qa", false)).toBe("claude");
		expect(runnerDisplayName("qa", undefined)).toBe("claude");
		// A phase role without the DAG workflow marker is likewise unchanged.
		expect(runnerDisplayName("design", false)).toBe("claude");
		expect(runnerDisplayName("implement", undefined)).toBe("claude");
	});

	it("cmux visibility: the window label carries the phase per-phase, not 'claude'", () => {
		// buildWindowLabel = `{issueId}-{runner}-{cleanTitle}`. Feeding it the
		// phase-aware runner name is what makes cmux show the live phase.
		const title = "DAG workflow";
		expect(
			buildWindowLabel("FLY-793", runnerDisplayName("design", true), title),
		).toBe("FLY-793-design-DAG workflow");
		expect(
			buildWindowLabel("FLY-793", runnerDisplayName("implement", true), title),
		).toBe("FLY-793-implement-DAG workflow");
		expect(
			buildWindowLabel("FLY-793", runnerDisplayName("qa", true), title),
		).toBe("FLY-793-qa-DAG workflow");
		// A non-phase (main) run is unchanged — still shows 'claude'.
		expect(
			buildWindowLabel("FLY-800", runnerDisplayName("main", true), title),
		).toBe("FLY-800-claude-DAG workflow");
		// Auto-QA (qa role, no shareParentBranch) is unchanged — still 'claude'.
		expect(
			buildWindowLabel("FLY-801", runnerDisplayName("qa", false), title),
		).toBe("FLY-801-claude-DAG workflow");
	});
});

// ══════════════════════════════════════════════════════════════════════
// FLY-1188 — CommDB pre-registration carries the resolved transport vendor
// (Codex M1 review MEDIUM-1): a Lead `send` between start() returning and
// the adapter's self-registration must already route to the right mailbox.
// FLYWHEEL_COMM_DIR is redirected so nothing touches the live comm.db.
// ══════════════════════════════════════════════════════════════════════

describe("FLY-1188: pre-registration vendor", () => {
	const ORIGINAL_BACKEND = process.env.FLYWHEEL_COMM_BACKEND;
	const ORIGINAL_COMM_DIR = process.env.FLYWHEEL_COMM_DIR;
	let commDir: string;

	beforeEach(async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		commDir = mkdtempSync(join(tmpdir(), "fly1188-prereg-"));
		process.env.FLYWHEEL_COMM_DIR = commDir;
		process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
	});
	afterEach(async () => {
		const { rmSync } = await import("node:fs");
		rmSync(commDir, { recursive: true, force: true });
		if (ORIGINAL_BACKEND === undefined)
			delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = ORIGINAL_BACKEND;
		if (ORIGINAL_COMM_DIR === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = ORIGINAL_COMM_DIR;
	});

	async function startAndReadVendor(issueLabels?: string[]) {
		const blueprint = { run: vi.fn().mockResolvedValue({ success: true }) };
		const runtimes = new Map<string, ProjectRuntime>([
			[
				"PreRegProj",
				{
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					blueprint: blueprint as any,
					projectRoot: "/tmp/prereg",
					tmuxSessionName: "runner-prereg",
				},
			],
		]);
		const dispatcher = new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		const result = await dispatcher.start({
			issueId: "FLY-1188",
			projectName: "PreRegProj",
			leadId: "flywheel-eng-lead",
			issueLabels,
		});
		const { CommDB } = await import("flywheel-comm/db");
		const { join } = await import("node:path");
		const db = new CommDB(join(commDir, "PreRegProj", "comm.db"));
		const session = db.getSession(result.executionId);
		db.close();
		return session;
	}

	it("codex label → pending row already carries vendor=codex", async () => {
		const session = await startAndReadVendor(["codex"]);
		expect(session?.tmux_window).toContain(":pending");
		expect(session?.vendor).toBe("codex");
	});

	it("default claude → pending row carries vendor=claude-code", async () => {
		const session = await startAndReadVendor();
		expect(session?.vendor).toBe("claude-code");
	});

	it('no-transport backend (antigravity) → pending row carries vendor="none"', async () => {
		const session = await startAndReadVendor(["antigravity"]);
		expect(session?.vendor).toBe("none");
	});

	it("commdb rollback backend → vendor NULL (legacy env fallback preserved)", async () => {
		process.env.FLYWHEEL_COMM_BACKEND = "commdb";
		const session = await startAndReadVendor(["codex"]);
		expect(session?.vendor).toBeNull();
	});
});

// FLY-1356 fix round 2 (Codex R1 HIGH-2): a THROWING sticky-stamp lookup must
// surface as readFailed on the Blueprint ctx (resolver fails closed to A) —
// never be swallowed into "no stamp" (which would hash the issue into an
// experimental arm on a broken read).
describe("FLY-1356 — sticky-stamp lookup failure surfaces readFailed", () => {
	afterEach(() => {
		delete process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE;
	});

	async function dispatchWithLookup(
		lookup: (issueId: string) => "superpowers" | "matt" | "bare" | undefined,
	): Promise<Record<string, unknown>> {
		const [name, runtime] = makeRuntime("TestProject");
		const dispatcher = new RunDispatcher(
			new Map([[name, runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lookup,
		);
		await dispatcher.start({
			issueId: "FLY-1356",
			projectName: "TestProject",
		});
		return (runtime.blueprint as unknown as { run: ReturnType<typeof vi.fn> })
			.run.mock.calls[0]?.[2] as Record<string, unknown>;
	}

	it("a THROWING lookup under split → ctx.skillFrameworkModeStampReadFailed, dispatch survives", async () => {
		process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE = "split";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const ctx = await dispatchWithLookup(() => {
				throw new Error("db exploded");
			});
			expect(ctx.skillFrameworkModeStampReadFailed).toBe(true);
			expect("skillFrameworkModePrior" in ctx).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	it("a stamp under split threads through as skillFrameworkModePrior (no readFailed)", async () => {
		process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE = "split";
		const ctx = await dispatchWithLookup(() => "matt");
		expect(ctx.skillFrameworkModePrior).toBe("matt");
		expect("skillFrameworkModeStampReadFailed" in ctx).toBe(false);
	});

	it("outside split the lookup is never consulted (zero-IO default path)", async () => {
		delete process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE;
		const lookup = vi.fn((): "matt" => {
			throw new Error("must not be called");
		});
		const ctx = await dispatchWithLookup(lookup);
		expect(lookup).not.toHaveBeenCalled();
		expect("skillFrameworkModeStampReadFailed" in ctx).toBe(false);
		expect("skillFrameworkModePrior" in ctx).toBe(false);
	});
});

describe("FLY-1188: preRegistrationVendor()", () => {
	it("maps transport mode / vendor to the pre-registration value", () => {
		expect(preRegistrationVendor({ runnerTransportMode: "none" })).toBe("none");
		expect(preRegistrationVendor({ vendor: "codex" })).toBe("codex");
		expect(preRegistrationVendor({ vendor: "claude-code" })).toBe(
			"claude-code",
		);
		expect(preRegistrationVendor({})).toBeUndefined();
	});
});
