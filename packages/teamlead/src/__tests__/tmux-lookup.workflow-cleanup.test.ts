import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AuditedSignalAsyncDeps,
	AuditedSignalInput,
} from "flywheel-claude-runner";
import { describe, expect, it, vi } from "vitest";
import { cleanupExactWorkflowTmuxWindow } from "../bridge/tmux-lookup.js";

const FINGERPRINT = "a".repeat(64);
const IDENTITY = {
	socketPath: "/tmp/flywheel.sock",
	serverStartTime: "123",
	windowId: "@7",
	executionId: "exec-1",
	launchGeneration: 2,
	launchFingerprint: FINGERPRINT,
};

const passAudit = async (
	input: AuditedSignalInput,
	deps?: AuditedSignalAsyncDeps,
) => {
	await deps?.mutate?.(input.target, input.signal);
	return {
		ok: true as const,
		ledger: "ndjson" as const,
		entry: {
			ts: "2026-08-31T20:00:00.000Z",
			...input,
			schemaVersion: 1 as const,
		},
	};
};

describe("cleanupExactWorkflowTmuxWindow", () => {
	it("kills and verifies absence only after the full identity matches", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7|exec-1|2|${FINGERPRINT}\n`,
			})
			.mockResolvedValueOnce({ stdout: "" })
			.mockRejectedValueOnce(new Error("can't find window: @7"));
		expect(
			await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, passAudit),
		).toBe("cleaned");
		expect(runTmux.mock.calls[1]?.[0]?.at(-1)).toBe(
			"#{window_id}|#{@flywheel_exec_id}|#{@flywheel_launch_generation}|#{@flywheel_launch_fingerprint}",
		);
		expect(runTmux.mock.calls[2]?.[0]).toEqual([
			"-S",
			"/tmp/flywheel.sock",
			"kill-window",
			"-t",
			"@7",
		]);
	});

	it("treats tmux 3.7c zero-exit empty output after kill as cleaned", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7|exec-1|2|${FINGERPRINT}\n`,
			})
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "@0\n" });

		await expect(
			cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, passAudit),
		).resolves.toBe("cleaned");
		expect(runTmux.mock.calls[4]?.[0]).toEqual([
			"-S",
			"/tmp/flywheel.sock",
			"list-windows",
			"-a",
			"-F",
			"#{window_id}",
		]);
	});

	it("treats tmux fallback to a different window after kill as cleaned only after the same-socket census", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7|exec-1|2|${FINGERPRINT}\n`,
			})
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "@0|||\n" })
			.mockResolvedValueOnce({ stdout: "@0\n" });

		await expect(
			cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, passAudit),
		).resolves.toBe("cleaned");
		expect(runTmux.mock.calls[4]?.[0]).toEqual([
			"-S",
			"/tmp/flywheel.sock",
			"list-windows",
			"-a",
			"-F",
			"#{window_id}",
		]);
	});

	it("fails closed when the tmux 3.7c follow-up census is empty", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7|exec-1|2|${FINGERPRINT}\n`,
			})
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "" });

		await expect(
			cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, passAudit),
		).resolves.toBe("unknown");
	});

	it("fails closed when the tmux 3.7c follow-up census still contains the target", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7|exec-1|2|${FINGERPRINT}\n`,
			})
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "" })
			.mockResolvedValueOnce({ stdout: "@0\n@7\n" });

		await expect(
			cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, passAudit),
		).resolves.toBe("present");
	});

	it("does not kill a window whose published fingerprint differs", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7|exec-1|2|${"b".repeat(64)}\n`,
			});
		expect(
			await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, passAudit),
		).toBe("present");
		expect(runTmux).toHaveBeenCalledTimes(2);
	});

	it("treats a superseded server generation as proof the old window is absent", async () => {
		const runTmux = vi.fn().mockResolvedValueOnce({ stdout: "124\n" });
		expect(
			await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, passAudit),
		).toBe("absent");
		expect(runTmux).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the exact probe is indeterminate", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockRejectedValueOnce(new Error("tmux probe timeout"));
		expect(
			await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, passAudit),
		).toBe("unknown");
	});

	it("refuses the exact window mutation when the ledger append fails", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7|exec-1|2|${FINGERPRINT}\n`,
			});
		const auditSignal = vi.fn(async (input: AuditedSignalInput) => ({
			ok: false as const,
			kind: "ledger_failed" as const,
			error: "disk full",
			entry: {
				ts: "2026-08-31T20:00:00.000Z",
				...input,
				schemaVersion: 1 as const,
			},
		}));

		expect(
			await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux, auditSignal),
		).toBe("unknown");
		expect(auditSignal).toHaveBeenCalledWith(
			expect.objectContaining({
				targetKind: "tmux-window",
				target: "/tmp/flywheel.sock:@7",
				execId: "exec-1",
			}),
			expect.objectContaining({ mutate: expect.any(Function) }),
		);
		expect(runTmux).toHaveBeenCalledTimes(2);
	});

	it("refuses an outside-slot socket at the audited mutation after the read-only identity probe", async () => {
		const isolationRoot = mkdtempSync(join(tmpdir(), "fly2454-workflow-slot-"));
		try {
			const runTmux = vi
				.fn()
				.mockResolvedValueOnce({ stdout: "123\n" })
				.mockResolvedValueOnce({
					stdout: `@7|exec-1|2|${FINGERPRINT}\n`,
				});
			const auditSignal = vi.fn(async (input: AuditedSignalInput) => ({
				ok: false as const,
				kind: "boundary_refused" as const,
				error: "outside_root",
				entry: {
					ts: "2026-09-09T00:00:00.000Z",
					...input,
					schemaVersion: 1 as const,
					refusal: "isolation_boundary" as const,
					refusalReason: "outside_root" as const,
				},
			}));
			const env = {
				FLYWHEEL_ISOLATION_ROOT: isolationRoot,
				FLYWHEEL_KILL_LEDGER_ROOT: join(isolationRoot, "kill-ledger"),
			};

			expect(
				await cleanupExactWorkflowTmuxWindow(
					IDENTITY,
					runTmux,
					auditSignal,
					env,
				),
			).toBe("unknown");
			expect(auditSignal).toHaveBeenCalledWith(
				expect.objectContaining({
					source: "tmux_lookup_workflow_cleanup",
					target: "/tmp/flywheel.sock:@7",
					boundary: { tmuxSocketPath: "/tmp/flywheel.sock" },
				}),
				expect.objectContaining({ env, mutate: expect.any(Function) }),
			);
			expect(runTmux).toHaveBeenCalledTimes(2);
		} finally {
			rmSync(isolationRoot, { recursive: true, force: true });
		}
	});
});
