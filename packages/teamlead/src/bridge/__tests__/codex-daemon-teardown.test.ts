import { describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../StateStore.js";
import { reapCodexDaemonForSession } from "../codex-daemon-teardown.js";

const session = {
	execution_id: "exec-1",
	issue_id: "issue-1",
	project_name: "flywheel",
	adapter_type: "codex-tmux",
};

describe("FLY-1940 Bridge codex daemon teardown", () => {
	it("forwards opt-in graceful teardown and the synchronous signal guard", async () => {
		const beforeSignal = () => true;
		const reap = vi.fn(async () => ({
			outcome: "residual" as const,
			socketPath: "/tmp/owned.sock",
		}));
		await reapCodexDaemonForSession(
			{ insertEvent: vi.fn() } as unknown as StateStore,
			session,
			"test.harvest",
			{ reap, gracefulOnly: true, beforeSignal },
		);
		expect(reap).toHaveBeenCalledWith(session.execution_id, {
			gracefulOnly: true,
			beforeSignal,
		});
	});

	it("records the host-process teardown receipt", async () => {
		const insertEvent = vi.fn();
		const result = await reapCodexDaemonForSession(
			{ insertEvent } as unknown as StateStore,
			session,
			"test.close",
			{
				reap: async () => ({
					outcome: "reaped",
					pgid: 4321,
					socketPath: "/tmp/owned.sock",
				}),
			},
		);
		expect(result.outcome).toBe("reaped");
		expect(insertEvent).toHaveBeenCalledOnce();
		expect(insertEvent).toHaveBeenCalledWith(
			expect.objectContaining({ event_type: "exec_host_processes_reaped" }),
		);
	});

	it("uses the existing Lead cleanup-failure event when residue is unverifiable", async () => {
		const insertEvent = vi.fn();
		await reapCodexDaemonForSession(
			{ insertEvent } as unknown as StateStore,
			session,
			"test.close",
			{
				reap: async () => ({
					outcome: "residual",
					pgid: 4321,
					socketPath: "/tmp/owned.sock",
				}),
			},
		);
		expect(insertEvent).toHaveBeenCalledTimes(2);
		expect(insertEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				event_type: "lead_close_runner_failed",
				source: "bridge.codex-daemon-teardown",
			}),
		);
	});

	it("records distinguishable structured causes when daemon reaping throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const causes: unknown[] = [];
		try {
			for (const [code, message] of [
				["EACCES", "permission denied reading daemon ownership"],
				["ETIMEDOUT", "daemon ownership probe timed out"],
			] as const) {
				const insertEvent = vi.fn();
				const error = Object.assign(new Error(message), { code });
				await reapCodexDaemonForSession(
					{ insertEvent } as unknown as StateStore,
					session,
					"test.close",
					{
						reap: async () => {
							throw error;
						},
					},
				);
				const hostEvent = insertEvent.mock.calls
					.map(([event]) => event)
					.find(
						(event) =>
							(event as { event_type?: string }).event_type ===
							"exec_host_processes_residual",
					) as { payload?: { reapFailure?: unknown } } | undefined;
				causes.push(hostEvent?.payload?.reapFailure);
			}
		} finally {
			warn.mockRestore();
		}

		expect(causes).toEqual([
			{
				kind: "system_error",
				code: "EACCES",
				message: "permission denied reading daemon ownership",
			},
			{
				kind: "system_error",
				code: "ETIMEDOUT",
				message: "daemon ownership probe timed out",
			},
		]);
	});

	it("does nothing for non-Codex runners", async () => {
		const insertEvent = vi.fn();
		const reap = vi.fn();
		await expect(
			reapCodexDaemonForSession(
				{ insertEvent } as unknown as StateStore,
				{ ...session, adapter_type: "claude-code" },
				"test.close",
				{ reap },
			),
		).resolves.toEqual({ outcome: "not_codex" });
		expect(reap).not.toHaveBeenCalled();
		expect(insertEvent).not.toHaveBeenCalled();
	});
});

describe("FLY-2903 stop the in-process owner before reaping", () => {
	it("asks the owner to stop BEFORE the reap and returns the stop result", async () => {
		const order: string[] = [];
		const requestStop = vi.fn(async () => {
			order.push("requestStop");
			return "stopped" as const;
		});
		const reap = vi.fn(async () => {
			order.push("reap");
			return { outcome: "absent" as const, socketPath: "/tmp/s.sock" };
		});
		const result = await reapCodexDaemonForSession(
			{ insertEvent: vi.fn() } as unknown as StateStore,
			session,
			"bridge.terminate",
			{ reap, stopOwner: { registry: { requestStop }, reason: "terminate" } },
		);
		expect(order).toEqual(["requestStop", "reap"]);
		expect(requestStop).toHaveBeenCalledWith("exec-1", "terminate", {});
		expect(result).toMatchObject({ outcome: "absent", ownerStop: "stopped" });
	});

	it("forwards an explicit wait bound", async () => {
		const requestStop = vi.fn(async () => "timeout" as const);
		await reapCodexDaemonForSession(
			{ insertEvent: vi.fn() } as unknown as StateStore,
			session,
			"bridge.codex-terminal-sweep",
			{
				reap: async () => ({ outcome: "reaped", socketPath: "/tmp/s.sock" }),
				stopOwner: {
					registry: { requestStop },
					reason: "terminal_sweep",
					timeoutMs: 5_000,
				},
			},
		);
		expect(requestStop).toHaveBeenCalledWith("exec-1", "terminal_sweep", {
			timeoutMs: 5_000,
		});
	});

	it("still reaps after a stop timeout (the owner is already fenced)", async () => {
		const reap = vi.fn(async () => ({
			outcome: "reaped" as const,
			socketPath: "/tmp/s.sock",
		}));
		const result = await reapCodexDaemonForSession(
			{ insertEvent: vi.fn() } as unknown as StateStore,
			session,
			"bridge.close-runner",
			{
				reap,
				stopOwner: {
					registry: { requestStop: async () => "timeout" as const },
					reason: "close_runner",
				},
			},
		);
		expect(reap).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ outcome: "reaped", ownerStop: "timeout" });
	});

	it("a throwing stop channel never blocks the reap", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const reap = vi.fn(async () => ({
				outcome: "absent" as const,
				socketPath: "/tmp/s.sock",
			}));
			const result = await reapCodexDaemonForSession(
				{ insertEvent: vi.fn() } as unknown as StateStore,
				session,
				"bridge.close-tmux",
				{
					reap,
					stopOwner: {
						registry: {
							requestStop: () => {
								throw new Error("registry broken");
							},
						},
						reason: "close_tmux",
					},
				},
			);
			expect(reap).toHaveBeenCalledOnce();
			expect(result).not.toHaveProperty("ownerStop");
		} finally {
			warn.mockRestore();
		}
	});

	it("without stopOwner the stop channel is never touched", async () => {
		const result = await reapCodexDaemonForSession(
			{ insertEvent: vi.fn() } as unknown as StateStore,
			session,
			"bridge.close-runner",
			{ reap: async () => ({ outcome: "absent", socketPath: "/tmp/s.sock" }) },
		);
		expect(result).not.toHaveProperty("ownerStop");
	});

	it("records the close attempt in the ledger without any snapshot probe", async () => {
		const recordCloseAttempt = vi.fn();
		const insertEvent = vi.fn();
		await reapCodexDaemonForSession(
			{ insertEvent } as unknown as StateStore,
			session,
			"bridge.terminate",
			{
				reap: async () => ({
					outcome: "unverifiable",
					socketPath: "/tmp/s.sock",
				}),
				stopOwner: {
					registry: { requestStop: async () => "not_owned" as const },
					reason: "terminate",
				},
				closeLedger: { recordCloseAttempt },
			},
		);
		expect(recordCloseAttempt).toHaveBeenCalledWith({
			executionId: "exec-1",
			source: "bridge.terminate",
			ownerStop: "not_owned",
			reap: "unverifiable",
		});
		// The existing Lead-visible events are unchanged.
		expect(insertEvent.mock.calls.map(([e]) => e.event_type)).toEqual([
			"exec_host_processes_residual",
			"lead_close_runner_failed",
		]);
		expect(insertEvent.mock.calls[0]?.[0].payload).not.toHaveProperty(
			"ownerStop",
		);
	});

	it("a throwing ledger never fails the terminal path", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const result = await reapCodexDaemonForSession(
				{ insertEvent: vi.fn() } as unknown as StateStore,
				session,
				"bridge.close-runner",
				{
					reap: async () => ({ outcome: "reaped", socketPath: "/tmp/s.sock" }),
					closeLedger: {
						recordCloseAttempt: () => {
							throw new Error("db locked");
						},
					},
				},
			);
			expect(result.outcome).toBe("reaped");
		} finally {
			warn.mockRestore();
		}
	});

	it("non-Codex runners skip both the stop channel and the ledger", async () => {
		const requestStop = vi.fn();
		const recordCloseAttempt = vi.fn();
		await reapCodexDaemonForSession(
			{ insertEvent: vi.fn() } as unknown as StateStore,
			{ ...session, adapter_type: "claude-code" },
			"bridge.terminate",
			{
				stopOwner: { registry: { requestStop }, reason: "terminate" },
				closeLedger: { recordCloseAttempt },
			},
		);
		expect(requestStop).not.toHaveBeenCalled();
		expect(recordCloseAttempt).not.toHaveBeenCalled();
	});
});
