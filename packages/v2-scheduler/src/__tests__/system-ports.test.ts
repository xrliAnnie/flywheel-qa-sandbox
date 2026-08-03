import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	DarwinMemoryPort,
	FilesystemRestartCoordinationPort,
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

	it("requests a graceful Lead restart with bounded SIGTERM", async () => {
		const run = vi.fn<SystemCommandRunner>(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const launchd = new LaunchctlPort({ run, timeoutMs: 2345 });
		await launchd.requestGracefulRestart(
			"gui/501/com.flywheel.lead.flywheel-eng",
		);
		expect(run).toHaveBeenCalledWith(
			"launchctl",
			["kill", "SIGTERM", "gui/501/com.flywheel.lead.flywheel-eng"],
			2345,
		);
		await expect(launchd.requestGracefulRestart("system/bad")).rejects.toThrow(
			/target/i,
		);
	});

	it("serializes scheduler mutation beneath the global restart lock", async () => {
		const root = mkdtempSync(join(tmpdir(), "scheduler-coordination-"));
		try {
			const globalLockDir = join(root, "restart.lock.d");
			const mutationLockDir = join(root, "scheduler-repair.lock.d");
			const run = vi.fn<SystemCommandRunner>(async () => ({
				exitCode: 0,
				stdout: "Mon Aug  2 00:00:00 2026\n",
				stderr: "",
			}));
			const coordination = new FilesystemRestartCoordinationPort({
				globalLockDir,
				mutationLockDir,
				run,
				pid: 4242,
				nowIso: () => "2026-08-02T00:00:00.000Z",
			});
			const action = vi.fn(async () => {
				expect(existsSync(join(mutationLockDir, "owner.json"))).toBe(true);
			});

			await expect(coordination.withMutationLock(action)).resolves.toBe(
				"executed",
			);
			expect(action).toHaveBeenCalledTimes(1);
			expect(existsSync(mutationLockDir)).toBe(false);

			mkdirSync(globalLockDir);
			await expect(coordination.withMutationLock(action)).resolves.toBe(
				"deferred",
			);
			expect(action).toHaveBeenCalledTimes(1);
			expect(existsSync(mutationLockDir)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reclaims only an exact stale scheduler owner and releases after errors", async () => {
		const root = mkdtempSync(join(tmpdir(), "scheduler-stale-lock-"));
		try {
			const mutationLockDir = join(root, "scheduler-repair.lock.d");
			mkdirSync(mutationLockDir, { mode: 0o700 });
			writeFileSync(
				join(mutationLockDir, "owner.json"),
				`${JSON.stringify({
					pid: 9999,
					pid_lstart: "stale-start",
					created_at: "2026-08-01T00:00:00.000Z",
				})}\n`,
				{ mode: 0o600 },
			);
			const run = vi.fn<SystemCommandRunner>(async (_file, args) =>
				args[1] === "9999"
					? { exitCode: 1, stdout: "", stderr: "" }
					: {
							exitCode: 0,
							stdout: "Mon Aug  2 00:00:00 2026\n",
							stderr: "",
						},
			);
			const coordination = new FilesystemRestartCoordinationPort({
				globalLockDir: join(root, "restart.lock.d"),
				mutationLockDir,
				run,
				pid: 4242,
				nowIso: () => "2026-08-02T00:00:00.000Z",
			});

			await expect(
				coordination.withMutationLock(async () => {
					throw new Error("signal failed");
				}),
			).rejects.toThrow("signal failed");
			expect(existsSync(mutationLockDir)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
