import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditedSignal, auditedSignalAsync } from "../src/kill-ledger.js";

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
});
