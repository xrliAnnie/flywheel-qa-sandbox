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
