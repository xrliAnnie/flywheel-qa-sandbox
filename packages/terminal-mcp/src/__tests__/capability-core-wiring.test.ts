import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CommDB } from "flywheel-comm/db";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	root: "",
	observed: "$1:%2",
	output: "Do you want to proceed? [Y/n]",
	dead: false,
	calls: [] as string[][],
	realEnv: undefined as NodeJS.ProcessEnv | undefined,
	tools: new Map<
		string,
		{
			schema: Record<string, unknown>;
			call: (args: Record<string, unknown>) => Promise<any>;
		}
	>(),
}));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => state.root,
}));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	McpServer: class {
		tool(
			name: string,
			_description: string,
			schema: Record<string, unknown>,
			call: (args: Record<string, unknown>) => Promise<any>,
		) {
			state.tools.set(name, { schema, call });
		}
		async connect() {}
	},
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
	StdioServerTransport: class {},
}));
vi.mock("../tmux-exec.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../tmux-exec.js")>();
	return {
		requireTmuxTarget: (value: string) => value,
		execTmux: async (args: string[]) => {
			state.calls.push(args);
			if (state.realEnv)
				return actual.execTmux(args, { env: state.realEnv, timeout: 3000 });
			return {
				stdout:
					args[0] === "display-message"
						? state.observed + (state.dead ? "|1|@0\n" : "|0|@0\n")
						: args[0] === "list-panes"
							? "@0\n"
							: state.output,
				stderr: "",
			};
		},
	};
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	if (state.root) rmSync(state.root, { recursive: true, force: true });
	state.tools.clear();
	state.calls = [];
	state.dead = false;
	state.realEnv = undefined;
});
it("uses shared observedSessionId and rejection codes through actual Claude MCP registrations", async () => {
	state.root = mkdtempSync(join(tmpdir(), "terminal-core-mcp-"));
	const dir = join(state.root, ".flywheel/comm/flywheel");
	mkdirSync(dir, { recursive: true });
	const db = new CommDB(join(dir, "comm.db"), true);
	db.registerSession("own", "runner:0", "flywheel", "FLY-1", "eng");
	db.registerSession("foreign", "other:0", "flywheel", "FLY-2", "other");
	db.close();
	vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
	vi.stubEnv("FLYWHEEL_LEAD_ID", "eng");
	await import("../index.js");
	const status = state.tools.get("runner_terminal_status")!;
	const input = state.tools.get("runner_terminal_input")!;
	expect(input.schema).toHaveProperty("expectedSessionId");
	const result = await status.call({ session_id: "own", lines: 20 });
	expect(JSON.parse(result.content[0].text).observedSessionId).toBe("$1:%2");
	const rejected = await input.call({
		session_id: "foreign",
		expectedSessionId: "$1:%2",
		text: "yes",
		enter: true,
	});
	expect(rejected.isError).toBe(true);
	expect(rejected.content[0].text).toContain("terminal_scope_denied");
	expect(state.calls.filter((args) => args[0] === "send-keys")).toHaveLength(0);
	for (const text of [
		"1\r/exit",
		"1\r/quit",
		"first\nsecond",
		"/exit",
		"/quit",
	]) {
		const blocked = await input.call({ session_id: "own", text, enter: true });
		expect(blocked.isError).toBe(true);
		expect(blocked.content[0].text).toContain("terminal_input_invalid");
		expect(state.calls.filter((args) => args[0] === "send-keys")).toHaveLength(
			0,
		);
	}
	await input.call({
		session_id: "own",
		expectedSessionId: "$1:%2",
		text: "yes",
		enter: true,
	});
	expect(state.calls.filter((args) => args[0] === "send-keys")).toEqual([
		["send-keys", "-t", "%2", "-l", "--", "yes"],
		["send-keys", "-t", "%2", "Enter"],
	]);
	state.output = "Do you want to proceed?\n1. Yes\n2. No\n────────────";
	expect(
		JSON.parse(
			(await status.call({ session_id: "own", lines: 20 })).content[0].text,
		).status,
	).toBe("waiting");
	const legacy = await input.call({
		session_id: "own",
		text: "yes",
		enter: true,
	});
	expect(legacy.isError).not.toBe(true);
	state.dead = true;
	expect(
		JSON.parse(
			(await status.call({ session_id: "own", lines: 20 })).content[0].text,
		),
	).toMatchObject({ status: "dead" });
	state.dead = false;
	state.observed = "$3:%4";
	const stale = await input.call({
		session_id: "own",
		expectedSessionId: "$1:%2",
		text: "yes",
		enter: true,
	});
	expect(stale.content[0].text).toContain("terminal_session_changed");
});

it.each(["id", "index"])(
	"actual CLI registrations reject a deleted %s window with another window still live",
	async (mode) => {
		state.root = mkdtempSync(join(tmpdir(), "m2519-"));
		state.realEnv = {
			PATH: process.env.PATH,
			HOME: state.root,
			TMUX_TMPDIR: state.root,
		};
		const run = promisify(execFile);
		const cmd = (args: string[]) =>
			run("tmux", args, { env: state.realEnv, timeout: 5000 });
		try {
			const own = (
				await cmd([
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-P",
					"-F",
					"#{window_id}",
					"-s",
					"fixture",
					"/bin/sh",
					"-c",
					"sleep 60",
				])
			).stdout.trim();
			const other = (
				await cmd([
					"new-window",
					"-t",
					"fixture",
					"-P",
					"-F",
					"#{window_id}",
					"/bin/sh",
					"-c",
					"printf 'FOREIGN_CANARY'; sleep 60",
				])
			).stdout.trim();
			const dir = join(state.root, ".flywheel/comm/flywheel");
			mkdirSync(dir, { recursive: true });
			const db = new CommDB(join(dir, "comm.db"), true);
			const windowIndex = (
				await cmd([
					"display-message",
					"-p",
					"-t",
					`fixture:${own}`,
					"#{window_index}",
				])
			).stdout.trim();
			const target = `fixture:${mode === "id" ? own : windowIndex}`;
			db.registerSession("own", target, "flywheel", "FLY-1", "eng");
			db.close();
			vi.stubEnv("FLYWHEEL_PROJECT_NAME", "flywheel");
			vi.stubEnv("FLYWHEEL_LEAD_ID", "eng");
			await import("../index.js");
			expect(
				(
					await state.tools
						.get("runner_terminal_capture")!
						.call({ session_id: "own", lines: 20 })
				).isError,
			).not.toBe(true);
			await cmd(["kill-window", "-t", `fixture:${own}`]);
			state.calls = [];
			for (const name of [
				"runner_terminal_capture",
				"runner_terminal_status",
				"runner_terminal_input",
			]) {
				const result = await state.tools.get(name)!.call({
					session_id: "own",
					lines: 20,
					text: "INJECTED",
					enter: true,
				});
				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain("terminal_not_found");
				expect(result.content[0].text).not.toContain("FOREIGN_CANARY");
			}
			expect(
				state.calls.filter((args) =>
					["capture-pane", "send-keys"].includes(args[0]!),
				),
			).toEqual([]);
			expect(
				(await cmd(["list-panes", "-t", `fixture:${other}`])).stdout,
			).toBeTruthy();
		} finally {
			await cmd(["kill-server"]).catch(() => {});
		}
	},
	15_000,
);
