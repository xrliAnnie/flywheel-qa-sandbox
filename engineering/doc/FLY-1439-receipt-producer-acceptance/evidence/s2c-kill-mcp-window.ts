#!/usr/bin/env bun
// Runs outside the managed Codex sandbox in a transient tmux window.
// Frozen order: validate exact MCP PID -> SIGKILL -> prove dead -> kill Lead
// window so the existing supervisor creates a fresh MCP.
import { readFileSync, writeFileSync } from "node:fs";

const [pidText, leadWindow, expectedCommand, outputPath] =
	process.argv.slice(2);
const pid = Number(pidText);
if (
	!Number.isSafeInteger(pid) ||
	pid <= 1 ||
	!leadWindow ||
	!expectedCommand ||
	!outputPath
) {
	throw new Error(
		"usage: s2c-kill-mcp-window.ts PID LEAD_WINDOW EXPECTED_COMMAND OUTPUT",
	);
}

const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
const command = ps.stdout.toString().trim();
if (ps.exitCode !== 0 || !command.includes(expectedCommand)) {
	throw new Error(`MCP command mismatch for pid ${pid}: ${command}`);
}

const initial = [
	`mcp_pid=${pid}`,
	`mcp_command=${command}`,
	`signal_wall_ms=${Date.now()}`,
	"",
].join("\n");
writeFileSync(outputPath, initial, { mode: 0o600 });

process.kill(pid, "SIGKILL");
const deadline = performance.now() + 1_000;
let dead = false;
while (performance.now() < deadline) {
	const probe = Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid="]);
	if (probe.exitCode !== 0 || !probe.stdout.toString().trim()) {
		dead = true;
		break;
	}
	await Bun.sleep(5);
}
writeFileSync(
	outputPath,
	`${readFileSync(outputPath, "utf8")}mcp_dead=${dead}\nmcp_dead_wall_ms=${Date.now()}\n`,
);
if (!dead) throw new Error(`MCP pid ${pid} did not die`);

const killedWindow = Bun.spawnSync([
	"tmux",
	"kill-window",
	"-t",
	`flywheel:${leadWindow}`,
]);
writeFileSync(
	outputPath,
	`${readFileSync(outputPath, "utf8")}window_kill_status=${killedWindow.exitCode}\nwindow_kill_wall_ms=${Date.now()}\n`,
);
if (killedWindow.exitCode !== 0) {
	throw new Error(
		`tmux kill-window failed: ${killedWindow.stderr.toString().trim()}`,
	);
}
