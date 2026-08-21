/**
 * FLY-560 Feature C: unit tests for the attach-target resolution + command
 * rendering (resolveCmuxAttachTarget / buildAttachCommand). Uses an injected
 * TmuxRunner seam so no real tmux server is needed; the real-tmux happy path is
 * covered in tmux-lookup.real-tmux.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
	buildAttachCommand,
	killCmuxLinkedSession,
	resolveCmuxAttachTarget,
	type TmuxRunner,
} from "../bridge/tmux-lookup.js";

describe("resolveCmuxAttachTarget", () => {
	it("returns the cmux linked session when display-message + has-session succeed", async () => {
		const calls: string[][] = [];
		const runner: TmuxRunner = async (args) => {
			calls.push(args);
			if (args[0] === "display-message") {
				return {
					stdout: "runner-flywheel|@46|FLY-560-claude-some-title|exec-560\n",
				};
			}
			// has-session resolves (exists)
			return { stdout: "" };
		};
		const target = await resolveCmuxAttachTarget("runner-flywheel:@46", {
			runTmux: runner,
			expectedExecutionId: "exec-560",
		});
		expect(target).toEqual({
			kind: "cmux",
			session: "cmux-FLY-560-claude-some-title",
			// FLY-907 (Step 3): the resolved window_name rides along so callers
			// can verify the window belongs to the issue before rendering.
			windowName: "FLY-560-claude-some-title",
		});
		// Verified with an EXACT (=) match.
		expect(calls).toContainEqual([
			"has-session",
			"-t",
			"=cmux-FLY-560-claude-some-title",
		]);
		// display-message targeted the full window.
		expect(calls[0]).toEqual([
			"display-message",
			"-p",
			"-t",
			"runner-flywheel:@46",
			"#{session_name}|#{window_id}|#{window_name}|#{@flywheel_exec_id}",
		]);
	});

	it("resolves identity when tmux sanitizes control-character separators", async () => {
		const runner: TmuxRunner = async (args) => {
			if (args[0] === "display-message") {
				const format = args.at(-1) ?? "";
				const separator = format.includes("|") ? "|" : "_";
				return {
					stdout: [
						"runner-flywheel",
						"@46",
						"FLY-560-claude-some-title",
						"exec-560",
					].join(separator),
				};
			}
			throw new Error("linked session absent");
		};

		await expect(
			resolveCmuxAttachTarget("runner-flywheel:@46", {
				runTmux: runner,
				expectedExecutionId: "exec-560",
			}),
		).resolves.toEqual({
			kind: "base",
			session: "runner-flywheel",
			tmuxWindow: "runner-flywheel:@46",
			windowName: "FLY-560-claude-some-title",
		});
	});

	it("falls back to base when the cmux session is absent (has-session rejects)", async () => {
		const runner: TmuxRunner = async (args) => {
			if (args[0] === "display-message") {
				return {
					stdout: "runner-flywheel|@46|FLY-560-claude-some-title|exec-560",
				};
			}
			throw new Error("can't find session: cmux-FLY-560-claude-some-title");
		};
		const target = await resolveCmuxAttachTarget("runner-flywheel:@46", {
			runTmux: runner,
			expectedExecutionId: "exec-560",
		});
		expect(target).toEqual({
			kind: "base",
			session: "runner-flywheel",
			tmuxWindow: "runner-flywheel:@46",
			// FLY-907 (Step 3): window_name was still resolved (display-message
			// succeeded) — carried for the cross-wire guard on base fallback too.
			windowName: "FLY-560-claude-some-title",
		});
	});

	it("fails loud when display-message fails (window gone / indeterminate)", async () => {
		const runner: TmuxRunner = async () => {
			throw new Error("can't find window");
		};
		const target = await resolveCmuxAttachTarget("retry-geoforge3d:@9", {
			runTmux: runner,
			expectedExecutionId: "exec-9",
		});
		expect(target).toEqual({
			kind: "unresolved",
			tmuxWindow: "retry-geoforge3d:@9",
			reason: "probe-failed",
		});
	});

	it("fails loud when the returned identity is malformed", async () => {
		const runner: TmuxRunner = async () => ({ stdout: "   \n" });
		const target = await resolveCmuxAttachTarget("base:@1", {
			runTmux: runner,
			expectedExecutionId: "exec-1",
		});
		expect(target).toEqual({
			kind: "unresolved",
			tmuxWindow: "base:@1",
			reason: "malformed-identity",
		});
	});

	it("fails loud for a tmux_window with no window selector", async () => {
		const runner: TmuxRunner = vi.fn(async () => {
			throw new Error("nope");
		});
		const target = await resolveCmuxAttachTarget("loneSession", {
			runTmux: runner,
			expectedExecutionId: "exec-lone",
		});
		expect(target).toEqual({
			kind: "unresolved",
			tmuxWindow: "loneSession",
			reason: "invalid-target",
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("withholds the pending sentinel without asking tmux to resolve it", async () => {
		const runner: TmuxRunner = vi.fn(async () => ({
			stdout: "runner-flywheel|@12|pending|exec-implement",
		}));
		const target = await resolveCmuxAttachTarget("runner-flywheel:pending", {
			runTmux: runner,
			expectedExecutionId: "exec-implement",
		});
		expect(target).toEqual({
			kind: "unresolved",
			tmuxWindow: "runner-flywheel:pending",
			reason: "pending-target",
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it.each([
		["runner-flywheel:stale-window-name", "window-name-mismatch"],
		["runner-flywheel:@999", "window-id-mismatch"],
	] as const)(
		"withholds the founder attach when %s silently resolves to the current design tab",
		async (tmuxWindow, reason) => {
			const calls: string[][] = [];
			const runner: TmuxRunner = async (args) => {
				calls.push(args);
				// This is the real tmux failure mode: an invalid target exits 0 and
				// prints the current window. It belongs to another execution.
				return {
					stdout: "runner-flywheel|@12|FLY-1944-design-codex-other|exec-design",
				};
			};

			const target = await resolveCmuxAttachTarget(tmuxWindow, {
				runTmux: runner,
				expectedExecutionId: "exec-implement",
			});

			expect(target).toEqual({ kind: "unresolved", tmuxWindow, reason });
			expect(calls).toHaveLength(1);
		},
	);

	it("withholds a valid-looking target owned by a different execution", async () => {
		const runner: TmuxRunner = async () => ({
			stdout: "runner-flywheel|@46|FLY-1944-implement-codex|exec-other",
		});
		const target = await resolveCmuxAttachTarget("runner-flywheel:@46", {
			runTmux: runner,
			expectedExecutionId: "exec-implement",
		});
		expect(target).toEqual({
			kind: "unresolved",
			tmuxWindow: "runner-flywheel:@46",
			reason: "execution-mismatch",
		});
	});
});

describe("buildAttachCommand", () => {
	it("refuses to render any command for an unresolved identity", () => {
		expect(() =>
			buildAttachCommand({
				kind: "unresolved",
				tmuxWindow: "runner-flywheel:@999",
				reason: "window-id-mismatch",
			}),
		).toThrow(/refusing to build attach command.*window-id-mismatch/);
	});

	it("renders an exact-match cmux attach (single machine)", () => {
		const cmd = buildAttachCommand({
			kind: "cmux",
			session: "cmux-FLY-560-claude-x",
		});
		// FLY-756: env -u TMUX so a paste into a $TMUX shell (e.g. the cmux dead
		// surface Annie copies into) doesn't nest-fail ("sessions should be
		// nested with care, unset $TMUX").
		expect(cmd).toBe("env -u TMUX tmux attach -t '=cmux-FLY-560-claude-x'");
	});

	it("renders the base fallback with attach + exact select-window", () => {
		const cmd = buildAttachCommand({
			kind: "base",
			session: "runner-flywheel",
			tmuxWindow: "runner-flywheel:@46",
		});
		expect(cmd).toBe(
			"env -u TMUX tmux attach -t '=runner-flywheel' \\; select-window -t '=runner-flywheel:@46'",
		);
	});

	it("wraps with an ssh prefix when sshHost is given (machine-aware future)", () => {
		const cmd = buildAttachCommand(
			{ kind: "cmux", session: "cmux-FLY-560-x" },
			{ sshHost: "mac-studio" },
		);
		expect(cmd).toBe(
			"ssh mac-studio -t 'env -u TMUX tmux attach -t '\\''=cmux-FLY-560-x'\\'''",
		);
	});
});

// ── FLY-638: canonical cmux views are never name-killed ─────────────────────
describe("killCmuxLinkedSession", () => {
	it("never name-kills a resolved canonical view", async () => {
		const calls: string[][] = [];
		const runner: TmuxRunner = async (args) => {
			calls.push(args);
			return { stdout: "FLY-1272-implement\n" };
		};
		const res = await killCmuxLinkedSession("runner-flywheel:@42", runner);
		expect(res).toEqual({
			killed: true,
			viewSkipped: true,
			cmuxSession: "cmux-FLY-1272-implement",
		});
		expect(calls).toHaveLength(1);
		expect(calls.some((c) => c[0] === "kill-session")).toBe(false);
	});

	it.each([
		["missing window", new Error("can't find window"), "can't find window"],
		["probe failure", new Error("permission denied"), "permission denied"],
	])(
		"permits lifecycle and remains non-destructive on %s",
		async (_label, error, message) => {
			const calls: string[][] = [];
			const runner: TmuxRunner = async (args) => {
				calls.push(args);
				throw error;
			};
			await expect(
				killCmuxLinkedSession("runner-flywheel:@42", runner),
			).resolves.toEqual({
				killed: true,
				viewSkipped: true,
				resolutionError: message,
			});
			expect(calls.some((c) => c[0] === "kill-session")).toBe(false);
		},
	);

	it("treats an empty resolved name as a safe skip", async () => {
		const calls: string[][] = [];
		const runner: TmuxRunner = async (args) => {
			calls.push(args);
			return { stdout: "  \n" };
		};
		await expect(
			killCmuxLinkedSession("runner-flywheel:@42", runner),
		).resolves.toEqual({
			killed: true,
			viewSkipped: true,
			resolutionError: "empty window_name",
		});
		expect(calls.some((c) => c[0] === "kill-session")).toBe(false);
	});
});
