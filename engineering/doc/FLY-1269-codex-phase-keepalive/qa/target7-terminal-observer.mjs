import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
	"/Users/xiaorongli/Dev/flywheel/packages/teamlead/package.json",
);
const Database = require("better-sqlite3");
const issueId = "ce8485dd-12e1-402b-8b36-f6a2043a980c";
const executions = [
	"d3499338-4dbb-4475-bb9b-09e7b56d1411",
	"b7255751-a56b-40e8-b3cc-d9452521828a",
	"7814e098-8dfa-4e99-a865-b6102c8d0bf3",
];
const windowIds = ["@303", "@304", "@320"];
const socketPaths = [
	"/Users/xiaorongli/.flywheel/cdx-sock/f700ec68e3a686a2.sock",
	"/Users/xiaorongli/.flywheel/cdx-sock/a3a27d016d3d5c1b.sock",
];
const daemonPids = [36949, 36950];
const commPath = "/Users/xiaorongli/.flywheel/comm/test-slot-2/comm.db";
const statePath = "/tmp/flywheel-test-slot-2/teamlead.db";
const stateFiles = [
	"/tmp/flywheel-test-slot-2/codex-sessions-target7/d3499338-4dbb-4475-bb9b-09e7b56d1411/session.json",
	"/tmp/flywheel-test-slot-2/codex-sessions-target7/b7255751-a56b-40e8-b3cc-d9452521828a/session.json",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const placeholders = executions.map(() => "?").join(",");

function rows(path, sql, args = []) {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		return db.prepare(sql).all(...args);
	} finally {
		db.close();
	}
}

function windowLive(id) {
	return (
		spawnSync(
			"tmux",
			[
				"display-message",
				"-p",
				"-t",
				`runner-test-slot-2:=${id}`,
				"#{window_id}",
			],
			{ encoding: "utf8" },
		).stdout.trim() === id
	);
}

function pidLive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function phaseHoldsPaused() {
	return stateFiles.every((path) => {
		if (!existsSync(path)) return false;
		try {
			return JSON.parse(readFileSync(path, "utf8")).phaseHold?.state === "paused";
		} catch {
			return false;
		}
	});
}

function snapshot() {
	const comm = rows(
		commPath,
		`SELECT execution_id, tmux_window, status FROM sessions WHERE execution_id IN (${placeholders}) ORDER BY execution_id`,
		executions,
	);
	const controls = rows(
		commPath,
		`SELECT execution_id, request_id, state FROM runner_shutdown_controls WHERE execution_id IN (${placeholders}) ORDER BY execution_id`,
		executions,
	);
	const turns = rows(
		commPath,
		"SELECT issue_id, holder_exec_id, phase FROM three_stage_turn WHERE issue_id = ?",
		[issueId],
	);
	const state = rows(
		statePath,
		`SELECT execution_id, session_role, status FROM sessions WHERE execution_id IN (${placeholders}) ORDER BY execution_id`,
		executions,
	);
	const windows = Object.fromEntries(windowIds.map((id) => [id, windowLive(id)]));
	const sockets = Object.fromEntries(
		socketPaths.map((path) => [path.split("/").at(-1), existsSync(path)]),
	);
	const daemons = Object.fromEntries(daemonPids.map((pid) => [pid, pidLive(pid)]));
	return {
		at: new Date().toISOString(),
		phaseHoldsPaused: phaseHoldsPaused(),
		comm,
		controls,
		turns,
		state,
		windows,
		sockets,
		daemons,
	};
}

function terminal(snapshot) {
	return (
		snapshot.comm.length === 0 &&
		snapshot.controls.length === 0 &&
		snapshot.turns.length === 0 &&
		snapshot.state.length === executions.length &&
		snapshot.state.every((row) => row.status === "completed") &&
		Object.values(snapshot.windows).every((live) => !live) &&
		Object.values(snapshot.sockets).every((live) => !live) &&
		Object.values(snapshot.daemons).every((live) => !live)
	);
}

let previous = "";
const startedAt = Date.now();
for (;;) {
	const current = snapshot();
	const comparable = JSON.stringify({ ...current, at: undefined });
	if (comparable !== previous) {
		console.log(JSON.stringify({ kind: "snapshot", ...current }));
		previous = comparable;
	}
	if (terminal(current)) {
		console.log(
			JSON.stringify({
				kind: "result",
				verdict: "PASS",
				issueId,
				executions,
				windowIds,
				durationMs: Date.now() - startedAt,
			}),
		);
		break;
	}
	if (Date.now() - startedAt > 120_000) {
		console.log(
			JSON.stringify({
				kind: "result",
				verdict: "FAIL",
				reason: "timeout",
				current,
			}),
		);
		process.exitCode = 1;
		break;
	}
	await sleep(500);
}
