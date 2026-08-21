import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ExecFileFn } from "../src/TmuxAdapter.js";
import { pruneScaffoldWindow } from "../src/TmuxAdapter.js";

const tmuxBin = process.env.FLYWHEEL_TMUX_3_7C_BIN;
if (!tmuxBin) {
	throw new Error("FLYWHEEL_TMUX_3_7C_BIN is required; this gate cannot skip");
}

const socket = `fly1944-gate-${randomUUID().slice(0, 8)}`;
const session = `runner-fly1944-${randomUUID().slice(0, 8)}`;
const exactExec: ExecFileFn = (cmd, args) => {
	if (cmd !== "tmux") throw new Error(`unexpected command: ${cmd}`);
	return {
		stdout: execFileSync(tmuxBin, ["-L", socket, ...args], {
			encoding: "utf8",
			timeout: 5000,
		}),
	};
};

beforeAll(() => {
	expect(execFileSync(tmuxBin, ["-V"], { encoding: "utf8" }).trim()).toBe(
		"tmux 3.7c",
	);
});

afterAll(() => {
	try {
		execFileSync(tmuxBin, ["-L", socket, "kill-server"], {
			stdio: "ignore",
			timeout: 5000,
		});
	} catch {
		// The test may already have removed the final session.
	}
});

it("prunes the normalized scaffold on an isolated tmux 3.7c server", () => {
	execFileSync(
		tmuxBin,
		["-L", socket, "new-session", "-d", "-s", session, "-n", "zsh"],
		{
			stdio: "ignore",
			timeout: 5000,
		},
	);
	const runnerId = execFileSync(
		tmuxBin,
		[
			"-L",
			socket,
			"new-window",
			"-t",
			`=${session}`,
			"-P",
			"-F",
			"#{window_id}",
			"-n",
			"FLY-1944-implement",
		],
		{ encoding: "utf8", timeout: 5000 },
	).trim();

	pruneScaffoldWindow(exactExec, session, runnerId);

	const windows = execFileSync(
		tmuxBin,
		[
			"-L",
			socket,
			"list-windows",
			"-t",
			`=${session}`,
			"-F",
			"#{window_id}|#{window_name}",
		],
		{ encoding: "utf8", timeout: 5000 },
	)
		.trim()
		.split("\n");
	expect(windows).toEqual([`${runnerId}|FLY-1944-implement`]);
});
