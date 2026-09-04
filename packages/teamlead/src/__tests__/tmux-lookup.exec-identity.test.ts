import { describe, expect, it, vi } from "vitest";
import {
	discoverTmuxTargetByExecutionId,
	isTmuxWindowAlive,
	killTmuxWindow,
	listTmuxWindowsByExecutionId,
	probeTmuxWindowLiveness,
	sendKeysToWindow,
} from "../bridge/tmux-lookup.js";

describe("FLY-1374 tmux execution identity discovery", () => {
	it("FLY-2170 lists one named window across base and linked-session aliases", async () => {
		const runTmux = vi.fn(async () => ({
			stdout: [
				"exec-1|cmux-FLY-2170|@42|FLY-2170-implement-codex",
				"exec-1|runner-flywheel|@42|FLY-2170-implement-codex",
				"exec-other|runner-flywheel|@43|another-window",
			].join("\n"),
		}));

		await expect(
			listTmuxWindowsByExecutionId("exec-1", runTmux),
		).resolves.toEqual({
			kind: "ok",
			windows: [
				{
					windowId: "@42",
					windowName: "FLY-2170-implement-codex",
					sessions: ["runner-flywheel", "cmux-FLY-2170"],
				},
			],
		});
		expect(runTmux).toHaveBeenCalledWith([
			"list-windows",
			"-a",
			"-F",
			"#{@flywheel_exec_id}|#{session_name}|#{window_id}|#{window_name}",
		]);
	});

	it("FLY-2170 ignores malformed rows that do not carry the requested marker", async () => {
		await expect(
			listTmuxWindowsByExecutionId("exec-1", async () => ({
				stdout: [
					"exec-other|runner-flywheel|not-an-id|",
					"exec-1|runner-flywheel|@42|birth-name",
				].join("\n"),
			})),
		).resolves.toEqual({
			kind: "ok",
			windows: [
				{
					windowId: "@42",
					windowName: "birth-name",
					sessions: ["runner-flywheel"],
				},
			],
		});
	});

	it.each([
		{
			name: "malformed row",
			executionId: "exec-1",
			runTmux: async () => ({ stdout: "exec-1|runner-flywheel|@42" }),
			reason: "malformed_identity_row",
		},
		{
			name: "invalid window id on a matching row",
			executionId: "exec-1",
			runTmux: async () => ({
				stdout: "exec-1|runner-flywheel|not-an-id|other-window",
			}),
			reason: "malformed_identity_row",
		},
		{
			name: "tmux failure",
			executionId: "exec-1",
			runTmux: async () => {
				throw new Error("tmux timed out");
			},
			reason: "tmux_list_failed",
		},
		{
			name: "separator in execution id",
			executionId: "exec|1",
			runTmux: async () => ({ stdout: "" }),
			reason: "invalid_execution_id",
		},
	])("FLY-2170 inventory fails closed on $name", async (scenario) => {
		await expect(
			listTmuxWindowsByExecutionId(scenario.executionId, scenario.runTmux),
		).resolves.toEqual({
			kind: "indeterminate",
			reason: scenario.reason,
		});
	});

	it("FLY-2170 inventory rejects conflicting names for one immutable window", async () => {
		await expect(
			listTmuxWindowsByExecutionId("exec-1", async () => ({
				stdout: [
					"exec-1|runner-flywheel|@42|birth-name",
					"exec-1|cmux-recovered-name|@42|recovered-name",
				].join("\n"),
			})),
		).resolves.toEqual({
			kind: "indeterminate",
			reason: "window_name_conflict",
		});
	});

	it("writes the kill receipt before mutating a runner window", async () => {
		const order: string[] = [];
		const result = await killTmuxWindow("runner-flywheel:@42", {
			auditSignal: vi.fn(async (input, deps) => {
				order.push("ledger");
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
			}),
			exec: vi.fn(async () => {
				order.push("tmux");
			}),
		});

		expect(result).toEqual({ killed: true });
		expect(order).toEqual(["ledger", "tmux"]);
	});

	it("discovers identity when tmux sanitizes control-character separators", async () => {
		const runTmux = vi.fn(async (args: string[]) => {
			const format = args.at(-1) ?? "";
			const separator = format.includes("|") ? "|" : "_";
			return {
				stdout: ["exec-1", "runner-flywheel", "@42", "FLY-1374-runner"].join(
					separator,
				),
			};
		});

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", runTmux),
		).resolves.toEqual({
			kind: "found",
			tmuxWindow: "runner-flywheel:@42",
		});
	});

	it("returns the canonical base-session target for one marked window", async () => {
		const runTmux = vi.fn(async () => ({
			stdout: [
				"exec-1|cmux-FLY-1374|@42|FLY-1374-runner",
				"exec-1|runner-flywheel|@42|FLY-1374-runner",
				"exec-other|runner-flywheel|@43|other-runner",
			].join("\n"),
		}));

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", runTmux),
		).resolves.toEqual({
			kind: "found",
			tmuxWindow: "runner-flywheel:@42",
		});
		expect(runTmux).toHaveBeenCalledWith([
			"list-windows",
			"-a",
			"-F",
			"#{@flywheel_exec_id}|#{session_name}|#{window_id}|#{window_name}",
		]);
	});

	it("fails closed when one execution id marks multiple window ids", async () => {
		const runTmux = vi.fn(async () => ({
			stdout: [
				"exec-1|runner-flywheel|@42|birth-name",
				"exec-1|runner-flywheel|@99|recovered-name",
			].join("\n"),
		}));

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", runTmux),
		).resolves.toEqual({ kind: "ambiguous" });
	});

	it("distinguishes missing identity from an indeterminate tmux read", async () => {
		await expect(
			discoverTmuxTargetByExecutionId("exec-1", async () => ({
				stdout: "exec-other|runner-flywheel|@42|other-runner\n",
			})),
		).resolves.toEqual({ kind: "missing" });

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", async () => {
				throw new Error("tmux timed out");
			}),
		).resolves.toEqual({ kind: "indeterminate" });
	});

	it("treats :pending as routing metadata with zero tmux mutation authority", async () => {
		await expect(probeTmuxWindowLiveness("runner:pending")).resolves.toBe(
			"indeterminate",
		);
		await expect(isTmuxWindowAlive("runner:pending")).resolves.toBe(false);
		await expect(killTmuxWindow("runner:pending")).resolves.toEqual({
			killed: false,
			error: "tmux window identity is still pending",
		});
		await expect(
			sendKeysToWindow("runner:pending", "continue"),
		).resolves.toEqual({
			sent: false,
			error: "tmux window identity is still pending",
		});
	});
});
