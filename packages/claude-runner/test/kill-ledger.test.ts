import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	auditedSignal,
	auditedSignalAsync,
	recordBoundaryRefusal,
} from "../src/kill-ledger.js";

describe("FLY-2211 auditedSignal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function ledgerRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "flywheel-kill-ledger-"));
		roots.push(root);
		return root;
	}

	it("appends and fsyncs the receipt before invoking the mutation", () => {
		const root = ledgerRoot();
		const order: string[] = [];
		const result = auditedSignal(
			{
				source: "codex_daemon_runtime",
				signal: "SIGKILL",
				targetKind: "pgid",
				target: 4321,
				execId: "exec-1",
				reason: "restart_after_proven_death",
			},
			{
				ledgerRoot: root,
				now: () => new Date("2026-08-31T20:00:00.000Z"),
				fsync: () => order.push("fsync"),
				mutate: (target, signal) => {
					order.push("mutate");
					expect(target).toBe(-4321);
					expect(signal).toBe("SIGKILL");
				},
			},
		);

		expect(result.ok).toBe(true);
		expect(order).toEqual(["fsync", "mutate"]);
		const line = JSON.parse(
			readFileSync(join(root, "20260831.ndjson"), "utf8").trim(),
		);
		expect(line).toEqual({
			ts: "2026-08-31T20:00:00.000Z",
			source: "codex_daemon_runtime",
			signal: "SIGKILL",
			targetKind: "pgid",
			target: 4321,
			execId: "exec-1",
			reason: "restart_after_proven_death",
			schemaVersion: 1,
		});
	});

	it("fails closed when the receipt cannot be made durable", () => {
		const mutate = vi.fn();
		const result = auditedSignal(
			{
				source: "codex_daemon_teardown",
				signal: "SIGTERM",
				targetKind: "pgid",
				target: 7654,
				reason: "terminal_cleanup",
			},
			{
				ledgerRoot: ledgerRoot(),
				fsync: () => {
					throw new Error("disk full");
				},
				mutate,
			},
		);

		expect(result).toMatchObject({ ok: false, kind: "ledger_failed" });
		expect(mutate).not.toHaveBeenCalled();
	});

	it("forced-shutdown fail-open emits a fallback receipt before signaling", () => {
		const order: string[] = [];
		const stderr = vi.fn(() => order.push("stderr"));
		const result = auditedSignal(
			{
				source: "restart_services",
				signal: "SIGKILL",
				targetKind: "pid",
				target: 9876,
				reason: "bridge_forced_shutdown",
				failureMode: "forced-shutdown-fail-open",
			},
			{
				ledgerRoot: ledgerRoot(),
				fsync: () => {
					throw new Error("read-only filesystem");
				},
				stderr,
				mutate: () => order.push("mutate"),
			},
		);

		expect(result).toMatchObject({
			ok: true,
			ledger: "stderr-fallback",
		});
		expect(order).toEqual(["stderr", "mutate"]);
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("KILL_LEDGER_FALLBACK"),
		);
	});

	it("awaits an asynchronous tmux mutation after the durable receipt", async () => {
		const order: string[] = [];
		const result = await auditedSignalAsync(
			{
				source: "tmux_lookup",
				signal: "kill-window",
				targetKind: "tmux-window",
				target: "runner-flywheel:@42",
				execId: "exec-42",
				reason: "runner_close",
			},
			{
				ledgerRoot: ledgerRoot(),
				fsync: () => order.push("fsync"),
				mutate: async (target, signal) => {
					await Promise.resolve();
					order.push(`${signal}:${target}`);
				},
			},
		);

		expect(result.ok).toBe(true);
		expect(order).toEqual(["fsync", "kill-window:runner-flywheel:@42"]);
	});

	it("refuses an isolated mutation without ownership evidence and writes the refusal before returning", () => {
		const isolationRoot = ledgerRoot();
		const root = join(isolationRoot, "ledger");
		const mutate = vi.fn();
		const stderr = vi.fn();
		const result = auditedSignal(
			{
				source: "codex_orphan_reaper",
				signal: "SIGTERM",
				targetKind: "pgid",
				target: 4321,
				reason: "orphan_reap",
			},
			{
				env: { FLYWHEEL_ISOLATION_ROOT: isolationRoot },
				ledgerRoot: root,
				now: () => new Date("2026-09-09T05:00:00.000Z"),
				fsync: () => undefined,
				stderr,
				mutate,
			},
		);

		expect(result).toMatchObject({
			ok: false,
			kind: "boundary_refused",
			error: "no_evidence",
		});
		expect(mutate).not.toHaveBeenCalled();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("[isolation-boundary] REFUSED"),
		);
		expect(
			JSON.parse(readFileSync(join(root, "20260909.ndjson"), "utf8")),
		).toEqual({
			ts: "2026-09-09T05:00:00.000Z",
			source: "codex_orphan_reaper",
			signal: "SIGTERM",
			targetKind: "pgid",
			target: 4321,
			reason: "orphan_reap",
			schemaVersion: 1,
			refusal: "isolation_boundary",
			refusalReason: "no_evidence",
			boundary: {},
			isolationRoot: realpathSync(isolationRoot),
		});
	});

	it("keeps the boundary refusal authoritative when its ledger fsync fails", () => {
		const isolationRoot = ledgerRoot();
		const mutate = vi.fn();
		const result = auditedSignal(
			{
				source: "tmux_lookup",
				signal: "kill-window",
				targetKind: "tmux-window",
				target: "@production",
				reason: "runner_close",
				boundary: { tmuxSocketPath: "/production/tmux.sock" },
			},
			{
				env: { FLYWHEEL_ISOLATION_ROOT: isolationRoot },
				ledgerRoot: join(isolationRoot, "ledger"),
				fsync: () => {
					throw new Error("disk full");
				},
				stderr: vi.fn(),
				mutate,
			},
		);

		expect(result).toMatchObject({
			ok: false,
			kind: "boundary_refused",
			error: "outside_root",
		});
		expect(mutate).not.toHaveBeenCalled();
	});

	it("allows owned evidence without changing the production ledger shape", () => {
		const isolationRoot = ledgerRoot();
		const root = join(isolationRoot, "ledger");
		const mutate = vi.fn();
		const result = auditedSignal(
			{
				source: "codex_daemon_runtime",
				signal: "SIGKILL",
				targetKind: "pgid",
				target: 7654,
				reason: "owned_daemon",
				boundary: { socketPath: join(isolationRoot, "daemon.sock") },
			},
			{
				env: { FLYWHEEL_ISOLATION_ROOT: isolationRoot },
				ledgerRoot: root,
				now: () => new Date("2026-09-09T05:10:00.000Z"),
				fsync: () => undefined,
				mutate,
			},
		);

		expect(result.ok).toBe(true);
		expect(mutate).toHaveBeenCalledWith(-7654, "SIGKILL");
		expect(
			JSON.parse(readFileSync(join(root, "20260909.ndjson"), "utf8")),
		).toEqual({
			ts: "2026-09-09T05:10:00.000Z",
			source: "codex_daemon_runtime",
			signal: "SIGKILL",
			targetKind: "pgid",
			target: 7654,
			reason: "owned_daemon",
			schemaVersion: 1,
		});
	});

	it("applies the same boundary refusal to asynchronous mutations", async () => {
		const isolationRoot = ledgerRoot();
		const mutate = vi.fn();
		const result = await auditedSignalAsync(
			{
				source: "tmux_lookup",
				signal: "kill-window",
				targetKind: "tmux-window",
				target: "@production",
				reason: "runner_close",
				boundary: { tmuxSocketPath: "/production/tmux.sock" },
			},
			{
				env: { FLYWHEEL_ISOLATION_ROOT: isolationRoot },
				ledgerRoot: join(isolationRoot, "ledger"),
				fsync: () => undefined,
				stderr: vi.fn(),
				mutate,
			},
		);

		expect(result).toMatchObject({ ok: false, kind: "boundary_refused" });
		expect(mutate).not.toHaveBeenCalled();
	});

	it("records the exact no-target refusal shape", () => {
		const isolationRoot = ledgerRoot();
		const root = join(isolationRoot, "ledger");
		const result = recordBoundaryRefusal(
			{
				source: "mcp_descendant_reaper",
				reason: "periodic_orphan_pass",
			},
			{
				env: { FLYWHEEL_ISOLATION_ROOT: isolationRoot },
				ledgerRoot: root,
				now: () => new Date("2026-09-09T05:20:00.000Z"),
				fsync: () => undefined,
				stderr: vi.fn(),
			},
		);

		expect(result).toMatchObject({ ok: false, kind: "boundary_refused" });
		expect(
			JSON.parse(readFileSync(join(root, "20260909.ndjson"), "utf8")),
		).toEqual({
			ts: "2026-09-09T05:20:00.000Z",
			source: "mcp_descendant_reaper",
			signal: "none",
			targetKind: "none",
			target: null,
			reason: "periodic_orphan_pass",
			schemaVersion: 1,
			refusal: "isolation_boundary",
			refusalReason: "no_evidence",
			boundary: {},
			isolationRoot: realpathSync(isolationRoot),
		});
	});
});
