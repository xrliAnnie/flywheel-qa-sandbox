import type { AdapterExecutionContext } from "flywheel-core";
import { describe, expect, it, vi } from "vitest";
import {
	createCodexRecoveryRuntime,
	runCodexRecoveryOwner,
} from "../run-infra.js";

const context: AdapterExecutionContext = {
	executionId: "exec-recovery",
	issueId: "FLY-2211",
	prompt: "immutable kick is read by the adapter",
	cwd: "/tmp/worktree",
	projectName: "flywheel",
	model: "gpt-5.6-sol",
	skillFrameworkMode: "bare",
	phaseKeepAlive: { role: "implement" },
};

describe("FLY-2211 run-infra recovery owner", () => {
	it("routes exhausted recovery through the canonical failure sink", async () => {
		const emitFailed = vi.fn(async () => undefined);
		const runtime = createCodexRecoveryRuntime({
			adapter: { resumeExistingExecution: vi.fn() },
			sink: { emitCompleted: vi.fn(), emitFailed },
		});

		await runtime.failExhausted(
			{
				execution_id: "exec-recovery",
				issue_id: "issue-1",
				issue_identifier: "FLY-2211",
				project_name: "flywheel",
				status: "running",
				adapter_type: "codex-tmux",
				session_role: "implement",
				runner_model: "gpt-5.6-sol",
			},
			2,
		);

		expect(emitFailed).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-recovery",
				issueId: "issue-1",
				issueIdentifier: "FLY-2211",
				sessionRole: "implement",
			}),
			"Codex recovery exhausted after 2 attempts",
			undefined,
			{
				failureKind: "reown_exhausted",
				failureReason: "Codex recovery exhausted after 2 attempts",
			},
		);
	});

	it("publishes parked-owner terminal success only after the confirmed phase-hold recovery commit", async () => {
		const order: string[] = [];
		const commit = vi.fn(async () => {
			order.push("commit");
		});
		const emitCompleted = vi.fn(async () => {
			order.push("terminal");
		});
		const result = await runCodexRecoveryOwner({
			adapter: {
				resumeExistingExecution: async (_ctx, hooks) => {
					await hooks.onRecoveryOwnershipEstablished({
						kind: "phase_hold_confirmed",
						threadId: "thread-1",
						goalStatus: "paused",
					});
					return {
						success: true,
						sessionId: "thread-1",
						durationMs: 10,
						timedOut: false,
					};
				},
			},
			sink: { emitCompleted, emitFailed: vi.fn() },
			context,
			hooks: { onRecoveryOwnershipEstablished: commit },
		});

		expect(result.success).toBe(true);
		expect(order).toEqual(["commit", "terminal"]);
		expect(emitCompleted).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-recovery",
				runnerBackend: "codex-tmux",
				sessionRole: "implement",
			}),
			expect.objectContaining({ success: true, sessionId: "thread-1" }),
			undefined,
		);
	});

	it("does not terminalize the durable session when recovery loses its commit fence", async () => {
		const sink = { emitCompleted: vi.fn(), emitFailed: vi.fn() };
		const result = await runCodexRecoveryOwner({
			adapter: {
				resumeExistingExecution: async (_ctx, hooks) => {
					try {
						await hooks.onRecoveryOwnershipEstablished({
							kind: "turn_started",
							threadId: "thread-1",
							turnId: "turn-1",
						});
					} catch {
						return {
							success: false,
							sessionId: "thread-1",
							durationMs: 10,
							timedOut: false,
							resultText: "recovery commit failed",
						};
					}
					throw new Error("unreachable");
				},
			},
			sink,
			context,
			hooks: {
				onRecoveryOwnershipEstablished: async () => {
					throw new Error("revision changed");
				},
			},
		});

		expect(result.success).toBe(false);
		expect(sink.emitCompleted).not.toHaveBeenCalled();
		expect(sink.emitFailed).not.toHaveBeenCalled();
	});

	it("routes post-commit owner failure through the canonical failure sink", async () => {
		const emitFailed = vi.fn(async () => undefined);
		await runCodexRecoveryOwner({
			adapter: {
				resumeExistingExecution: async (_ctx, hooks) => {
					await hooks.onRecoveryOwnershipEstablished({
						kind: "turn_started",
						threadId: "thread-1",
						turnId: "turn-1",
					});
					return {
						success: false,
						sessionId: "thread-1",
						durationMs: 10,
						timedOut: false,
						resultText: "transport failed after ownership commit",
					};
				},
			},
			sink: { emitCompleted: vi.fn(), emitFailed },
			context,
			hooks: {
				onRecoveryOwnershipEstablished: vi.fn(async () => undefined),
			},
		});

		expect(emitFailed).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "exec-recovery" }),
			"transport failed after ownership commit",
			undefined,
			undefined,
		);
	});
});
