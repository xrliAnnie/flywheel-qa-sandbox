/** FLY-1393 QA — real-tmux W-1: a killed-Claude bare shell classifies as `idle`. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectTerminalStatus } from "../../../../packages/teamlead/src/bridge/runner-status.ts";

const pexec = promisify(execFile);
const SOCKNAME = `fly1393w1-${process.pid}`;
const tmux = (a: string[]) => pexec("tmux", ["-L", SOCKNAME, ...a]);
const cap = async (win: string) =>
	(await tmux(["capture-pane", "-p", "-t", win])).stdout;

// The RunnerIdleWatchdog emit/suppress gate (RunnerIdleWatchdog.ts:274-279), verbatim.
function willEmit(
	legacyOff: boolean,
	livenessOn: boolean,
	status: string,
): boolean {
	const suppressed = legacyOff && (!livenessOn || status !== "idle");
	return !suppressed;
}

async function run() {
	await tmux(["new-session", "-d", "-s", "s", "-x", "100", "-y", "30"]).catch(
		() => {},
	);
	// Let the interactive shell finish starting before injecting the prompt.
	// Without this settle the command can remain as unexecuted input, which the
	// classifier correctly reads as `executing` instead of a settled bare shell.
	await new Promise((r) => setTimeout(r, 600));
	// A bare shell prompt (Claude Code process is gone → the pane shows only the shell prompt).
	await tmux([
		"send-keys",
		"-t",
		"s:",
		"PS1='annie@mac:~/work$ '; clear",
		"Enter",
	]);
	await new Promise((r) => setTimeout(r, 400));
	const idleOut = await cap("s:");
	const idle = detectTerminalStatus(idleOut);

	// A waiting pane (Claude asking a permission question).
	await tmux([
		"send-keys",
		"-t",
		"s:",
		"printf 'Do you want to proceed? [y/N] '",
		"Enter",
	]);
	await new Promise((r) => setTimeout(r, 400));
	const waitOut = await cap("s:");
	const waiting = detectTerminalStatus(waitOut);

	console.log(
		`bare-shell tail: ${JSON.stringify(idleOut.trim().split("\n").slice(-2))}`,
	);
	console.log(`classify bare-shell => ${idle.status} (${idle.reason})`);
	console.log(`classify waiting    => ${waiting.status} (${waiting.reason})`);

	// Production posture: legacy delivery watchdogs OFF, W-1 liveness ON (default).
	const rows = [
		["idle", idle.status === "idle", willEmit(true, true, "idle")],
		["waiting", waiting.status === "waiting", willEmit(true, true, "waiting")],
		["unknown", true, willEmit(true, true, "unknown")],
		["idle+liveness=OFF", true, willEmit(true, false, "idle")],
	] as const;
	console.log("\nW-1 gate (legacy OFF):");
	for (const [name, classOk, emit] of rows)
		console.log(`  ${name}: classify_ok=${classOk} emits=${emit}`);

	const pass =
		idle.status === "idle" &&
		waiting.status === "waiting" &&
		willEmit(true, true, "idle") === true &&
		willEmit(true, true, "waiting") === false &&
		willEmit(true, true, "unknown") === false &&
		willEmit(true, false, "idle") === false;
	console.log(
		pass
			? "\nW-1 PASS: real killed-Claude bare shell => idle => EMIT; waiting/unknown/liveness=OFF => SILENT"
			: "\nW-1 UNEXPECTED — inspect above",
	);
	await tmux(["kill-server"]).catch(() => {});
	process.exit(pass ? 0 : 2);
}
run().catch(async (e) => {
	console.error(e);
	await tmux(["kill-server"]).catch(() => {});
	process.exit(3);
});
