import { describe, expect, it, vi } from "vitest";
import {
	DarwinMemoryPort,
	LaunchctlPort,
	ProcessRestartGate,
	type SystemCommandRunner,
} from "../system-ports.js";

describe("scheduler system ports", () => {
	it("uses status --with-seq and accepts the held record-failure exit", async () => {
		const run = vi
			.fn<SystemCommandRunner>()
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{"state":"active","last_resumed_seq":0,"ledger_seq":4}\n',
				stderr: "",
			})
			.mockResolvedValueOnce({
				exitCode: 3,
				stdout:
					'{"state":"held_alert_attempted","episode_key":"x","window_start":"2026-07-27T00:00:00.000Z","last_resumed_seq":0,"ledger_seq":5,"recorded":true}\n',
				stderr: "",
			});
		const gate = new ProcessRestartGate({
			gateBin: "/repo/scripts/restart-storm-gate.py",
			ledgerRoot: "/tmp/ledger",
			run,
			timeoutMs: 1234,
		});

		await expect(gate.status("lead.flywheel-eng")).resolves.toEqual({
			state: "active",
			ledgerSeq: 4,
		});
		await expect(gate.recordFailure("lead.flywheel-eng", 4)).resolves.toEqual({
			state: "held_alert_attempted",
			ledgerSeq: 5,
			recorded: true,
		});
		expect(run).toHaveBeenNthCalledWith(
			1,
			"/repo/scripts/restart-storm-gate.py",
			["status", "--with-seq", "--root", "/tmp/ledger", "lead.flywheel-eng"],
			1234,
		);
		expect(run).toHaveBeenNthCalledWith(
			2,
			"/repo/scripts/restart-storm-gate.py",
			[
				"record-failure",
				"--expected-seq",
				"4",
				"--root",
				"/tmp/ledger",
				"lead.flywheel-eng",
			],
			1234,
		);
	});

	it("fails closed on restart gate lock contention or malformed output", async () => {
		const locked = new ProcessRestartGate({
			gateBin: "/gate.py",
			run: vi.fn(async () => ({
				exitCode: 2,
				stdout: "",
				stderr: "locked",
			})),
		});
		await expect(locked.status("lead.flywheel-eng")).rejects.toThrow(/exit 2/i);

		const malformed = new ProcessRestartGate({
			gateBin: "/gate.py",
			run: vi.fn(async () => ({
				exitCode: 0,
				stdout: '{"state":"active"}',
				stderr: "",
			})),
		});
		await expect(malformed.status("lead.flywheel-eng")).rejects.toThrow(
			/malformed/i,
		);
	});

	it("invokes launchctl only through bounded kickstart -k", async () => {
		const run = vi.fn<SystemCommandRunner>(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const launchd = new LaunchctlPort({ run, timeoutMs: 2345 });
		await launchd.kickstart("gui/501/com.flywheel.lead.flywheel-eng");
		expect(run).toHaveBeenCalledWith(
			"launchctl",
			["kickstart", "-k", "gui/501/com.flywheel.lead.flywheel-eng"],
			2345,
		);
		await expect(launchd.kickstart("system/bad")).rejects.toThrow(/target/i);
	});

	it("samples hw.memsize, hw.pagesize, and vm_stat without importing the v1 monitor", async () => {
		const run = vi
			.fn<SystemCommandRunner>()
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: String(48 * 1024 ** 3),
				stderr: "",
			})
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: "16384\n",
				stderr: "",
			})
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: [
					"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
					"Pages free: 10.",
					"Pages inactive: 20.",
					"Pages speculative: 5.",
					"Swapouts: 99.",
				].join("\n"),
				stderr: "",
			});
		const memory = await DarwinMemoryPort.create(run);
		expect(memory.thresholds.swapoutMinPagesPerTick).toBe(3072);
		await expect(memory.sample()).resolves.toEqual({
			reclaimableBytes: 35 * 16_384,
			swapoutsTotal: 99,
		});
	});
});
