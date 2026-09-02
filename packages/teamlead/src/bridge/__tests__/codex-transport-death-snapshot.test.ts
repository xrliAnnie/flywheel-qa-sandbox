import { describe, expect, it, vi } from "vitest";
import { recordCodexTransportDeathSnapshot } from "../codex-transport-death-snapshot.js";

describe("recordCodexTransportDeathSnapshot", () => {
	it("records socket, matching process rows, and only the latest three maintenance ticks", async () => {
		const insertEvent = vi.fn();
		const execFile = vi.fn(async (command: string) => {
			if (command === "lsof") {
				return { stdout: "codex 42 user 10u unix /tmp/codex.sock\n" };
			}
			return {
				stdout: [
					"42 1 42 Mon Aug 31 12:00:00 2026 codex app-server --listen /tmp/codex.sock",
					"99 1 99 Mon Aug 31 12:00:00 2026 unrelated",
				].join("\n"),
			};
		});

		await recordCodexTransportDeathSnapshot(
			{
				getSession: () => ({
					execution_id: "exec-42",
					issue_id: "issue-1",
					project_name: "flywheel",
				}),
				insertEvent,
			},
			{
				executionId: "exec-42",
				socketPath: "/tmp/codex.sock",
				reason: "socket reset",
				at: "2026-08-31T20:00:00.000Z",
				trigger: "transport_close",
			},
			[
				"2026-08-31T19:40:00.000Z",
				"2026-08-31T19:45:00.000Z",
				"2026-08-31T19:50:00.000Z",
				"2026-08-31T19:55:00.000Z",
			],
			{
				existsSync: () => true,
				execFile,
				randomId: () => "fixed",
			},
		);
		expect(execFile).toHaveBeenCalledTimes(2);
		expect(execFile).toHaveBeenCalledWith(
			"lsof",
			["-nP", "/tmp/codex.sock"],
			expect.objectContaining({ timeout: 3_000, maxBuffer: 1_048_576 }),
		);

		expect(insertEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event_id: "codex-transport-death-exec-42-fixed",
				event_type: "codex_transport_death_snapshot",
				source: "bridge.codex-transport-forensics",
				payload: expect.objectContaining({
					at: "2026-08-31T20:00:00.000Z",
					trigger: "transport_close",
					reason: "socket reset",
					socket: expect.objectContaining({
						path: "/tmp/codex.sock",
						exists: true,
						lsof: expect.stringContaining("codex 42"),
					}),
					processRows: [expect.stringContaining("/tmp/codex.sock")],
					maintenanceTicks: [
						"2026-08-31T19:45:00.000Z",
						"2026-08-31T19:50:00.000Z",
						"2026-08-31T19:55:00.000Z",
					],
				}),
			}),
		);
	});

	it("still records a bounded snapshot when lsof and ps are unavailable", async () => {
		const insertEvent = vi.fn();
		await recordCodexTransportDeathSnapshot(
			{ getSession: () => undefined, insertEvent },
			{
				executionId: "exec-missing",
				socketPath: "/tmp/missing.sock",
				reason: "zombie declared",
				at: "2026-08-31T20:00:00.000Z",
				trigger: "zombie_declaration",
			},
			[],
			{
				existsSync: () => false,
				execFile: async () => {
					throw new Error("operation not permitted");
				},
				randomId: () => "fixed",
			},
		);

		expect(insertEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				issue_id: "unknown",
				project_name: "unknown",
				payload: expect.objectContaining({
					processRows: [],
					processError: "operation not permitted",
					socket: expect.objectContaining({
						exists: false,
						lsofError: "operation not permitted",
					}),
				}),
			}),
		);
	});

	it("records lsof exit 1 with no output as an empty holder set", async () => {
		const insertEvent = vi.fn();
		await recordCodexTransportDeathSnapshot(
			{ getSession: () => undefined, insertEvent },
			{
				executionId: "exec-no-holder",
				socketPath: "/tmp/stale.sock",
				reason: "transport closed",
				at: "2026-08-31T20:00:00.000Z",
				trigger: "transport_close",
			},
			[],
			{
				existsSync: () => true,
				execFile: async (command) => {
					if (command === "lsof") {
						throw Object.assign(new Error("Command failed: lsof"), {
							code: 1,
							stdout: "",
							stderr: "",
						});
					}
					return { stdout: "" };
				},
				randomId: () => "fixed",
			},
		);

		const payload = insertEvent.mock.calls[0]?.[0]?.payload;
		expect(payload).toEqual(
			expect.objectContaining({
				socket: expect.objectContaining({
					exists: true,
					lsof: "",
				}),
			}),
		);
		expect(
			(payload?.socket as { lsofError?: string }).lsofError,
		).toBeUndefined();
	});

	it("launches both bounded probes concurrently without blocking the caller", async () => {
		const insertEvent = vi.fn();
		const releases: Array<(value: { stdout: string }) => void> = [];
		const execFile = vi.fn(
			() =>
				new Promise<{ stdout: string }>((resolve) => {
					releases.push(resolve);
				}),
		);

		const completion = recordCodexTransportDeathSnapshot(
			{ getSession: () => undefined, insertEvent },
			{
				executionId: "exec-pending",
				socketPath: "/tmp/pending.sock",
				reason: "transport pending",
				at: "2026-08-31T20:00:00.000Z",
				trigger: "transport_close",
			},
			[],
			{ existsSync: () => false, execFile, randomId: () => "fixed" },
		);

		expect(completion).toBeInstanceOf(Promise);
		expect(execFile).toHaveBeenCalledTimes(2);
		expect(insertEvent).not.toHaveBeenCalled();
		for (const release of releases) release({ stdout: "" });
		await completion;
		expect(insertEvent).toHaveBeenCalledTimes(1);
	});
});
