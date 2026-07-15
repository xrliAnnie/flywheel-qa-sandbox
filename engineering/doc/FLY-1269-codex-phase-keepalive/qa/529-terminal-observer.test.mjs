import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OBSERVER = path.join(HERE, "529-terminal-observer.mjs");
const REAL_SQLITE = "/usr/bin/sqlite3";
const DESIGN = "design-success";
const IMPLEMENT = "implement-success";
const QA = "qa-success";
const ISSUE = "FLY-1286";

function runSql(dbPath, sql) {
	const result = spawnSync(REAL_SQLITE, [dbPath], {
		encoding: "utf8",
		input: `PRAGMA busy_timeout=2000;${sql}`,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

function scalar(dbPath, sql) {
	const result = spawnSync(REAL_SQLITE, ["-noheader", dbPath, sql], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

function sqlQuote(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function freshHeartbeat() {
	return new Date().toISOString();
}

function socketPath(root, executionId) {
	const hash = createHash("sha1")
		.update(executionId)
		.digest("hex")
		.slice(0, 16);
	return path.join(root, `${hash}.sock`);
}

function writeJson(filePath, value) {
	writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function metadataSnapshot(paths) {
	return Object.fromEntries(
		paths.map((filePath) => {
			if (!existsSync(filePath)) return [filePath, null];
			const stat = statSync(filePath);
			const isSharedMemory = filePath.endsWith("-shm");
			const sha256 = isSharedMemory
				? null
				: createHash("sha256").update(readFileSync(filePath)).digest("hex");
			return [
				filePath,
				{
					size: stat.size,
					ino: stat.ino,
					...(sha256 ? { sha256 } : {}),
					// A read-only WAL reader takes transient mmap locks in -shm on macOS,
					// which advances only that file's mtime. Content, size, and inode
					// remain the mutation oracle; DB/WAL mtime must remain unchanged.
					...(isSharedMemory ? {} : { mtimeMs: stat.mtimeMs }),
				},
			];
		}),
	);
}

function makeExecutable(filePath, source) {
	writeFileSync(filePath, source);
	chmodSync(filePath, 0o755);
}

function createFixture({ oldAttempt = false, symlinkSocketRoot = false } = {}) {
	const root = mkdtempSync(path.join(os.tmpdir(), "fly1286-observer-"));
	const stateDb = path.join(root, "state.db");
	const commDb = path.join(root, "comm.db");
	const out = path.join(root, "observer.jsonl");
	const socketRoot = path.join(root, "sockets");
	const lsofSocketRoot = symlinkSocketRoot
		? path.join(root, "sockets-real")
		: socketRoot;
	const fakeBin = path.join(root, "bin");
	const probeDir = path.join(root, "probes");
	const probeLog = path.join(root, "probe.log");
	mkdirSync(lsofSocketRoot);
	if (symlinkSocketRoot) symlinkSync(lsofSocketRoot, socketRoot);
	mkdirSync(fakeBin);
	mkdirSync(probeDir);
	writeFileSync(probeLog, "");

	runSql(
		stateDb,
		`PRAGMA journal_mode=WAL;
		 CREATE TABLE sessions (
		   execution_id TEXT PRIMARY KEY,
		   issue_id TEXT NOT NULL,
		   status TEXT NOT NULL,
		   heartbeat_at TEXT,
		   tmux_session TEXT,
		   adapter_type TEXT,
		   chat_thread_role TEXT,
		   runner_model TEXT
		 );
		 CREATE TABLE session_events (
		   id INTEGER PRIMARY KEY AUTOINCREMENT,
		   event_id TEXT UNIQUE NOT NULL,
		   ts TEXT NOT NULL DEFAULT (datetime('now')),
		   execution_id TEXT NOT NULL,
		   issue_id TEXT NOT NULL,
		   project_name TEXT NOT NULL,
		   event_type TEXT NOT NULL,
		   severity TEXT NOT NULL DEFAULT 'info',
		   payload JSON,
		   source TEXT NOT NULL
		 );`,
	);

	runSql(
		commDb,
		`PRAGMA journal_mode=WAL;
		 CREATE TABLE sessions (
		   execution_id TEXT PRIMARY KEY,
		   tmux_window TEXT NOT NULL,
		   project_name TEXT NOT NULL,
		   issue_id TEXT,
		   lead_id TEXT,
		   status TEXT DEFAULT 'running'
		 );
		 CREATE TABLE three_stage_turn (
		   issue_id TEXT PRIMARY KEY,
		   holder_exec_id TEXT NOT NULL,
		   phase TEXT NOT NULL,
		   epoch INTEGER NOT NULL,
		   granted_at INTEGER NOT NULL
		 );
		 CREATE TABLE runner_shutdown_controls (
		   execution_id TEXT PRIMARY KEY,
		   request_id TEXT NOT NULL UNIQUE,
		   state TEXT NOT NULL,
		   requested_at INTEGER NOT NULL,
		   finished_at INTEGER,
		   error TEXT
		 );`,
	);

	const heartbeat = freshHeartbeat();
	for (const [executionId, role, adapter, model, tmux] of [
		[DESIGN, "design", "codex-tmux", "gpt-5.6-sol", "slot:design"],
		[IMPLEMENT, "implement", "codex-tmux", "gpt-5.6-sol", "slot:implement"],
		[QA, "qa", "claude-tmux", "claude-opus-4-8", "slot:qa"],
	]) {
		runSql(
			stateDb,
			`INSERT INTO sessions
			 (execution_id,issue_id,status,heartbeat_at,tmux_session,adapter_type,chat_thread_role,runner_model)
			 VALUES (${sqlQuote(executionId)},${sqlQuote(ISSUE)},'running',${sqlQuote(heartbeat)},${sqlQuote(tmux)},${sqlQuote(adapter)},${sqlQuote(role)},${sqlQuote(model)});`,
		);
		runSql(
			commDb,
			`INSERT INTO sessions (execution_id,tmux_window,project_name,issue_id,lead_id,status)
			 VALUES (${sqlQuote(executionId)},${sqlQuote(tmux)},'test-slot-2',${sqlQuote(ISSUE)},'flywheel-test-2','running');`,
		);
	}
	runSql(
		commDb,
		`INSERT INTO three_stage_turn VALUES (${sqlQuote(ISSUE)},${sqlQuote(QA)},'qa',3,${Date.now()});`,
	);
	if (oldAttempt) {
		runSql(
			stateDb,
			`INSERT INTO sessions
			 (execution_id,issue_id,status,heartbeat_at,tmux_session,adapter_type,chat_thread_role,runner_model)
			 VALUES ('old-blocked',${sqlQuote(ISSUE)},'blocked','2020-01-01T00:00:00Z','slot:old','codex-tmux','design','gpt-5.6-sol');`,
		);
		runSql(
			commDb,
			`INSERT INTO sessions VALUES ('old-blocked','slot:old','test-slot-2',${sqlQuote(ISSUE)},'flywheel-test-2','completed');`,
		);
	}

	writeJson(path.join(probeDir, "tmux.json"), {
		"slot:design": "live",
		"slot:implement": "live",
		"slot:qa": "live",
	});
	writeJson(path.join(probeDir, "lsof.json"), {
		[path.basename(socketPath(socketRoot, DESIGN))]: [31001],
		[path.basename(socketPath(socketRoot, IMPLEMENT))]: [31002],
	});

	const sqliteLog = path.join(root, "sqlite-args.jsonl");
	makeExecutable(
		path.join(fakeBin, "sqlite3"),
		`#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SQLITE_ARG_LOG\"\nexec ${REAL_SQLITE} \"$@\"\n`,
	);
	makeExecutable(
		path.join(fakeBin, "tmux"),
		`#!/usr/bin/env node
		const fs=require('node:fs');
		const map=JSON.parse(fs.readFileSync(process.env.FAKE_PROBE_DIR+'/tmux.json','utf8'));
		const target=process.argv[process.argv.indexOf('-t')+1];
		const state=map[target] ?? 'absent';
		if(state==='live'){process.stdout.write('0\\n');process.exit(0)}
		if(state==='dead'){process.stdout.write('1\\n');process.exit(0)}
		if(state==='absent'){process.stderr.write("can't find pane: "+target+'\\n');process.exit(1)}
		if(state==='permission'){process.stderr.write('permission denied\\n');process.exit(1)}
		process.stderr.write('no server running on /tmp/tmux-test/default\\n');process.exit(1);
		`,
	);
	makeExecutable(
		path.join(fakeBin, "lsof"),
		`#!/usr/bin/env node
		const fs=require('node:fs');
		fs.appendFileSync(process.env.FAKE_PROBE_LOG,'lsof\\n');
		const map=JSON.parse(fs.readFileSync(process.env.FAKE_PROBE_DIR+'/lsof.json','utf8'));
		if(Object.values(map).includes('indeterminate')){
			process.stderr.write('lsof: status error on socket: Permission denied\\n');
			process.exit(1);
		}
		if(map.__warning==='warning'){
			process.stderr.write("lsof: WARNING: can't stat() apfs file system /Volumes/example\\n      Output information may be incomplete.\\n");
		}
		let output='p99999\\nf8\\nn/unrelated.sock\\n';
		for(const [name,holders] of Object.entries(map)){
			if(!Array.isArray(holders))continue;
			for(const pid of holders)output+='p'+pid+'\\nf27\\nn'+process.env.FAKE_LSOF_SOCKET_ROOT+'/'+name+'\\n';
		}
		process.stdout.write(output);process.exit(0);
		`,
	);

	const servers = new Map();
	async function listen(executionId) {
		const target = socketPath(socketRoot, executionId);
		const server = net.createServer((connection) => connection.end());
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(target, resolve);
		});
		servers.set(executionId, server);
	}
	async function closeSocket(executionId) {
		const server = servers.get(executionId);
		if (!server) return;
		await new Promise((resolve) => server.close(resolve));
		servers.delete(executionId);
	}

	async function dispose() {
		await Promise.all([...servers.keys()].map(closeSocket));
		rmSync(root, { recursive: true, force: true });
	}

	return {
		root,
		stateDb,
		commDb,
		out,
		socketRoot,
		lsofSocketRoot,
		probeDir,
		probeLog,
		fakeBin,
		sqliteLog,
		listen,
		closeSocket,
		dispose,
	};
}

// The observer shells out to sqlite3/tmux/lsof on every sample. Keep fixture
// deadlines generous enough for a loaded 529 host while preserving every
// assertion and the observer's production polling behavior.
const FIXTURE_OBSERVER_TIMEOUT_MS = 15_000;
const FIXTURE_WAIT_TIMEOUT_MS = 15_000;
const FIXTURE_EXIT_TIMEOUT_MS = 20_000;

function observerArgs(
	fixture,
	timeoutMs = FIXTURE_OBSERVER_TIMEOUT_MS,
	extra = [],
) {
	return [
		OBSERVER,
		"--state-db",
		fixture.stateDb,
		"--comm-db",
		fixture.commDb,
		"--issue",
		ISSUE,
		"--design-exec",
		DESIGN,
		"--implement-exec",
		IMPLEMENT,
		"--qa-exec",
		QA,
		"--socket-root",
		fixture.socketRoot,
		"--out",
		fixture.out,
		"--interval-ms",
		"10",
		"--timeout-ms",
		String(timeoutMs),
		...extra,
	];
}

function observerEnv(fixture) {
	return {
		...process.env,
		PATH: `${fixture.fakeBin}:${process.env.PATH}`,
		FAKE_PROBE_DIR: fixture.probeDir,
		FAKE_PROBE_LOG: fixture.probeLog,
		FAKE_LSOF_SOCKET_ROOT: realpathSync(fixture.lsofSocketRoot),
		SQLITE_ARG_LOG: fixture.sqliteLog,
	};
}

function readFrames(out) {
	if (!existsSync(out)) return [];
	return readFileSync(out, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function waitFor(
	predicate,
	message,
	timeoutMs = FIXTURE_WAIT_TIMEOUT_MS,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
}

function startObserver(
	fixture,
	timeoutMs = FIXTURE_OBSERVER_TIMEOUT_MS,
	extra = [],
) {
	return spawn(process.execPath, observerArgs(fixture, timeoutMs, extra), {
		env: observerEnv(fixture),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function waitForExit(child, timeoutMs = FIXTURE_EXIT_TIMEOUT_MS) {
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const result = await Promise.race([
		new Promise((resolve) =>
			child.once("exit", (code, signal) =>
				resolve({ code, signal, stdout, stderr }),
			),
		),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("observer did not exit")), timeoutMs),
		),
	]);
	return result;
}

async function stopObserver(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill();
	await exited;
}

async function waitForSnapshot(fixture, predicate = () => true) {
	await waitFor(
		() =>
			readFrames(fixture.out).some(
				(frame) => frame.kind === "snapshot" && predicate(frame),
			),
		"observer did not record expected snapshot",
	);
}

function setShutdown(fixture, executionId, requestId, state) {
	runSql(
		fixture.commDb,
		`INSERT INTO runner_shutdown_controls
		 (execution_id,request_id,state,requested_at,finished_at,error)
		 VALUES (${sqlQuote(executionId)},${sqlQuote(requestId)},${sqlQuote(state)},${Date.now()},${state === "requested" ? "NULL" : Date.now()},NULL)
		 ON CONFLICT(execution_id) DO UPDATE SET state=excluded.state,finished_at=excluded.finished_at;`,
	);
}

function insertCloseEvent(fixture, executionId, requestId) {
	runSql(
		fixture.stateDb,
		`INSERT INTO session_events
		 (event_id,execution_id,issue_id,project_name,event_type,payload,source)
		 VALUES (${sqlQuote(`close-${executionId}`)},${sqlQuote(executionId)},${sqlQuote(ISSUE)},'test-slot-2','lead_close_runner',${sqlQuote(JSON.stringify({ phaseShutdownRequestId: requestId }))},'bridge.close-runner');`,
	);
}

function updateProbe(fixture, kind, mutate) {
	const filePath = path.join(fixture.probeDir, `${kind}.json`);
	const value = JSON.parse(readFileSync(filePath, "utf8"));
	mutate(value);
	writeJson(filePath, value);
}

async function clearSockets(fixture) {
	await fixture.closeSocket(DESIGN);
	await fixture.closeSocket(IMPLEMENT);
	updateProbe(fixture, "lsof", (value) => {
		value[path.basename(socketPath(fixture.socketRoot, DESIGN))] = [];
		value[path.basename(socketPath(fixture.socketRoot, IMPLEMENT))] = [];
	});
}

function clearTmux(fixture) {
	updateProbe(fixture, "tmux", (value) => {
		value["slot:design"] = "absent";
		value["slot:implement"] = "absent";
		value["slot:qa"] = "absent";
	});
}

function deleteLifecycle(fixture, { keepTurn = false, keepQa = false } = {}) {
	runSql(
		fixture.stateDb,
		`DELETE FROM sessions WHERE execution_id IN (${sqlQuote(DESIGN)},${sqlQuote(IMPLEMENT)}${keepQa ? "" : `,${sqlQuote(QA)}`});`,
	);
	runSql(
		fixture.commDb,
		`DELETE FROM sessions WHERE execution_id IN (${sqlQuote(DESIGN)},${sqlQuote(IMPLEMENT)}${keepQa ? "" : `,${sqlQuote(QA)}`});
		 DELETE FROM runner_shutdown_controls WHERE execution_id IN (${sqlQuote(DESIGN)},${sqlQuote(IMPLEMENT)});
		 ${keepTurn ? "" : `DELETE FROM three_stage_turn WHERE issue_id=${sqlQuote(ISSUE)};`}`,
	);
}

function verdict(fixture) {
	return readFrames(fixture.out).findLast((frame) => frame.kind === "verdict");
}

test(
	"records requested then acked before lifecycle rows disappear",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			const child = startObserver(fixture);
			await waitForSnapshot(fixture);
			setShutdown(fixture, DESIGN, "req-design", "requested");
			setShutdown(fixture, IMPLEMENT, "req-implement", "requested");
			await waitForSnapshot(
				fixture,
				(frame) =>
					frame.shutdown?.design?.state === "requested" &&
					frame.shutdown?.implement?.state === "requested",
			);
			setShutdown(fixture, DESIGN, "req-design", "acked");
			setShutdown(fixture, IMPLEMENT, "req-implement", "acked");
			await waitForSnapshot(
				fixture,
				(frame) =>
					frame.shutdown?.design?.state === "acked" &&
					frame.shutdown?.implement?.state === "acked",
			);
			await clearSockets(fixture);
			clearTmux(fixture);
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.equal(
				result.code,
				0,
				JSON.stringify({ stderr: result.stderr, verdict: verdict(fixture) }),
			);
			assert.equal(verdict(fixture)?.pass, true);
			for (const role of ["design", "implement"]) {
				assert.deepEqual(
					verdict(fixture).executions[role].history.map((item) => item.state),
					["requested", "acked"],
				);
			}
		} finally {
			await fixture.dispose();
		}
	},
);

test(
	"corroborates a cadence-missed ack with the durable graceful-close event",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			const child = startObserver(fixture);
			await waitForSnapshot(fixture);
			setShutdown(fixture, DESIGN, "req-design", "requested");
			setShutdown(fixture, IMPLEMENT, "req-implement", "requested");
			await waitForSnapshot(
				fixture,
				(frame) =>
					frame.shutdown?.design?.state === "requested" &&
					frame.shutdown?.implement?.state === "requested",
			);
			insertCloseEvent(fixture, DESIGN, "req-design");
			insertCloseEvent(fixture, IMPLEMENT, "req-implement");
			await clearSockets(fixture);
			clearTmux(fixture);
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.equal(
				result.code,
				0,
				JSON.stringify({ stderr: result.stderr, verdict: verdict(fixture) }),
			);
			assert.equal(verdict(fixture)?.pass, true);
			assert.equal(
				verdict(fixture)?.executions.design.classification,
				"graceful_corroborated",
			);
			assert.equal(
				verdict(fixture)?.executions.implement.classification,
				"graceful_corroborated",
			);
		} finally {
			await fixture.dispose();
		}
	},
);

test(
	"corroborates an ack first observed after its requested row was missed",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			for (const [executionId, requestId] of [
				[DESIGN, "req-design"],
				[IMPLEMENT, "req-implement"],
			]) {
				setShutdown(fixture, executionId, requestId, "acked");
				insertCloseEvent(fixture, executionId, requestId);
			}
			const child = startObserver(fixture);
			await waitForSnapshot(
				fixture,
				(frame) =>
					frame.shutdown?.design?.state === "acked" &&
					frame.shutdown?.implement?.state === "acked",
			);
			await clearSockets(fixture);
			clearTmux(fixture);
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.equal(
				result.code,
				0,
				JSON.stringify({ stderr: result.stderr, verdict: verdict(fixture) }),
			);
			for (const role of ["design", "implement"]) {
				assert.equal(
					verdict(fixture)?.executions[role].classification,
					"graceful_corroborated",
				);
				assert.deepEqual(
					verdict(fixture).executions[role].history.map((item) => item.state),
					["acked"],
				);
			}
		} finally {
			await fixture.dispose();
		}
	},
);

test(
	"fails a live fresh cleanup without ack or matching durable event",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			const child = startObserver(fixture);
			await waitForSnapshot(fixture);
			setShutdown(fixture, DESIGN, "req-design", "requested");
			setShutdown(fixture, IMPLEMENT, "req-implement", "requested");
			await waitForSnapshot(
				fixture,
				(frame) => frame.shutdown?.design?.state === "requested",
			);
			await clearSockets(fixture);
			clearTmux(fixture);
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.notEqual(result.code, 0);
			assert.match(
				verdict(fixture)?.reason ?? "",
				/missing_shutdown_ack_corroboration/,
			);
		} finally {
			await fixture.dispose();
		}
	},
);

test(
	"classifies a proven direct path instead of pretending it was graceful",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			const child = startObserver(fixture);
			await waitForSnapshot(fixture);
			runSql(
				fixture.stateDb,
				`UPDATE sessions SET heartbeat_at='2020-01-01T00:00:00Z' WHERE execution_id IN (${sqlQuote(DESIGN)},${sqlQuote(IMPLEMENT)});`,
			);
			await clearSockets(fixture);
			clearTmux(fixture);
			await waitForSnapshot(
				fixture,
				(frame) =>
					frame.liveness?.design?.heartbeatFresh === false &&
					frame.liveness?.design?.tmux === "absent",
			);
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.notEqual(result.code, 0);
			assert.equal(
				verdict(fixture)?.executions.design.classification,
				"direct_proven",
			);
			assert.equal(verdict(fixture)?.executions.design.rerunRequired, true);
			assert.deepEqual(verdict(fixture)?.executions.design.history, []);
		} finally {
			await fixture.dispose();
		}
	},
);

test(
	"fails closed when direct-path liveness is indeterminate",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			const child = startObserver(fixture);
			await waitForSnapshot(fixture);
			updateProbe(fixture, "tmux", (value) => {
				value["slot:design"] = "permission";
				value["slot:implement"] = "permission";
			});
			updateProbe(fixture, "lsof", (value) => {
				value[path.basename(socketPath(fixture.socketRoot, DESIGN))] =
					"indeterminate";
				value[path.basename(socketPath(fixture.socketRoot, IMPLEMENT))] =
					"indeterminate";
			});
			await waitForSnapshot(
				fixture,
				(frame) => frame.liveness?.design?.tmux === "indeterminate",
			);
			// Close the listeners without rewriting lsof.json: the cleanup frame must
			// still carry the indeterminate holder marker under test.
			await fixture.closeSocket(DESIGN);
			await fixture.closeSocket(IMPLEMENT);
			clearTmux(fixture);
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.notEqual(result.code, 0);
			assert.equal(
				verdict(fixture)?.reason,
				`liveness_indeterminate:${DESIGN}:lsof`,
			);
		} finally {
			await fixture.dispose();
		}
	},
);

test("reports a dead tmux pane instead of treating it as live", async () => {
	const fixture = createFixture();
	try {
		updateProbe(fixture, "tmux", (value) => {
			value["slot:design"] = "dead";
		});
		const result = spawnSync(
			process.execPath,
			observerArgs(fixture, 2000, ["--once"]),
			{
				encoding: "utf8",
				env: observerEnv(fixture),
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const snapshot = readFrames(fixture.out).findLast(
			(frame) => frame.kind === "snapshot",
		);
		assert.equal(snapshot?.liveness.design.tmux, "dead");
	} finally {
		await fixture.dispose();
	}
});

test("matches lsof holder names through a canonicalized socket root", async () => {
	const fixture = createFixture({ symlinkSocketRoot: true });
	try {
		const result = spawnSync(
			process.execPath,
			observerArgs(fixture, 2000, ["--once"]),
			{
				encoding: "utf8",
				env: observerEnv(fixture),
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const snapshot = readFrames(fixture.out).findLast(
			(frame) => frame.kind === "snapshot",
		);
		assert.equal(snapshot?.liveness.design.holders.state, "present");
		assert.deepEqual(snapshot?.liveness.design.holders.holders, [31001]);
	} finally {
		await fixture.dispose();
	}
});

test(
	"timestamps holder evidence and preserves its sample time while cached",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		let child;
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			child = startObserver(fixture, 5000);
			await waitForSnapshot(fixture);
			const first = readFrames(fixture.out).find(
				(frame) => frame.kind === "snapshot",
			);
			assert.match(
				first?.liveness.design.holders.observedAt ?? "",
				/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
			);

			const nextHeartbeat = new Date(Date.now() + 1000).toISOString();
			runSql(
				fixture.stateDb,
				`UPDATE sessions SET heartbeat_at=${sqlQuote(nextHeartbeat)} WHERE execution_id=${sqlQuote(DESIGN)};`,
			);
			await waitForSnapshot(
				fixture,
				(frame) => frame.liveness?.design?.heartbeatAt === nextHeartbeat,
			);
			const second = readFrames(fixture.out).findLast(
				(frame) =>
					frame.kind === "snapshot" &&
					frame.liveness?.design?.heartbeatAt === nextHeartbeat,
			);
			assert.equal(
				second?.liveness.design.holders.observedAt,
				first.liveness.design.holders.observedAt,
			);
			const lsofCalls = readFileSync(fixture.probeLog, "utf8")
				.split("\n")
				.filter(Boolean);
			assert.deepEqual(lsofCalls, ["lsof"]);
		} finally {
			if (child) await stopObserver(child);
			await fixture.dispose();
		}
	},
);

test("retries transient startup liveness before arming", async () => {
	const fixture = createFixture();
	let child;
	try {
		await fixture.listen(DESIGN);
		await fixture.listen(IMPLEMENT);
		updateProbe(fixture, "tmux", (value) => {
			value["slot:design"] = "indeterminate";
		});
		child = startObserver(fixture, 5000, [
			"--arming-attempts",
			"4",
			"--arming-timeout-ms",
			"4000",
		]);
		await waitForSnapshot(
			fixture,
			(frame) => frame.liveness?.design?.tmux === "indeterminate",
		);
		updateProbe(fixture, "tmux", (value) => {
			value["slot:design"] = "live";
		});
		await waitForSnapshot(
			fixture,
			(frame) => frame.liveness?.design?.tmux === "live",
		);
		assert.equal(verdict(fixture), undefined);
	} finally {
		if (child) await stopObserver(child);
		await fixture.dispose();
	}
});

test("fails closed after bounded startup retries", async () => {
	const fixture = createFixture();
	try {
		updateProbe(fixture, "tmux", (value) => {
			value["slot:design"] = "indeterminate";
		});
		const child = startObserver(fixture, 6000, [
			"--arming-attempts",
			"3",
			"--arming-timeout-ms",
			"5000",
		]);
		const result = await waitForExit(child, 8000);
		assert.notEqual(result.code, 0);
		assert.equal(
			verdict(fixture)?.reason,
			"initial_tmux_not_live:design:indeterminate",
		);
		assert.equal(verdict(fixture)?.arming?.attempts, 3);
		assert.equal(verdict(fixture)?.arming?.maxAttempts, 3);
		assert.equal(verdict(fixture)?.arming?.timeoutMs, 5000);
	} finally {
		await fixture.dispose();
	}
});

test(
	"treats a vanished tmux server as absent only after observing it live",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			const child = startObserver(fixture);
			await waitForSnapshot(fixture);
			for (const [executionId, requestId] of [
				[DESIGN, "req-design"],
				[IMPLEMENT, "req-implement"],
			]) {
				setShutdown(fixture, executionId, requestId, "requested");
			}
			await waitForSnapshot(
				fixture,
				(frame) => frame.shutdown?.implement?.state === "requested",
			);
			for (const [executionId, requestId] of [
				[DESIGN, "req-design"],
				[IMPLEMENT, "req-implement"],
			]) {
				setShutdown(fixture, executionId, requestId, "acked");
			}
			await waitForSnapshot(
				fixture,
				(frame) => frame.shutdown?.implement?.state === "acked",
			);
			await clearSockets(fixture);
			updateProbe(fixture, "tmux", (value) => {
				value["slot:design"] = "indeterminate";
				value["slot:implement"] = "indeterminate";
				value["slot:qa"] = "indeterminate";
			});
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.equal(
				result.code,
				0,
				JSON.stringify({ stderr: result.stderr, verdict: verdict(fixture) }),
			);
		} finally {
			await fixture.dispose();
		}
	},
);

test("accepts a parsed lsof scan with a known benign warning", async () => {
	const fixture = createFixture();
	try {
		updateProbe(fixture, "lsof", (value) => {
			value.__warning = "warning";
		});
		const result = spawnSync(
			process.execPath,
			observerArgs(fixture, 2000, ["--once"]),
			{
				encoding: "utf8",
				env: observerEnv(fixture),
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const snapshot = readFrames(fixture.out).findLast(
			(frame) => frame.kind === "snapshot",
		);
		assert.equal(snapshot?.liveness.design.holders.state, "present");
	} finally {
		await fixture.dispose();
	}
});

test("scans lsof once per snapshot for all Codex sockets", async () => {
	const fixture = createFixture();
	try {
		const result = spawnSync(
			process.execPath,
			observerArgs(fixture, 2000, ["--once"]),
			{
				encoding: "utf8",
				env: observerEnv(fixture),
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const lsofCalls = readFileSync(fixture.probeLog, "utf8")
			.split("\n")
			.filter(Boolean);
		assert.deepEqual(lsofCalls, ["lsof"]);
	} finally {
		await fixture.dispose();
	}
});

test("deduplicates stable snapshots despite heartbeat age advancing", async () => {
	const fixture = createFixture();
	try {
		await fixture.listen(DESIGN);
		await fixture.listen(IMPLEMENT);
		const child = startObserver(fixture, 1800);
		const result = await waitForExit(child, 5000);
		assert.notEqual(result.code, 0);
		const snapshots = readFrames(fixture.out).filter(
			(frame) => frame.kind === "snapshot",
		);
		assert.equal(snapshots.length, 1);
		assert.equal(verdict(fixture)?.reason, "cleanup_not_observed");
		const lsofCalls = readFileSync(fixture.probeLog, "utf8")
			.split("\n")
			.filter(Boolean);
		assert.deepEqual(lsofCalls, ["lsof"]);
	} finally {
		await fixture.dispose();
	}
});

test(
	"ignores old failed FLY-1286 attempts outside the manifest",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture({ oldAttempt: true });
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			const child = startObserver(fixture);
			await waitForSnapshot(fixture);
			for (const [executionId, requestId] of [
				[DESIGN, "req-design"],
				[IMPLEMENT, "req-implement"],
			]) {
				setShutdown(fixture, executionId, requestId, "requested");
			}
			await waitForSnapshot(
				fixture,
				(frame) => frame.shutdown?.implement?.state === "requested",
			);
			for (const [executionId, requestId] of [
				[DESIGN, "req-design"],
				[IMPLEMENT, "req-implement"],
			]) {
				setShutdown(fixture, executionId, requestId, "acked");
			}
			await waitForSnapshot(
				fixture,
				(frame) => frame.shutdown?.implement?.state === "acked",
			);
			await clearSockets(fixture);
			clearTmux(fixture);
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.equal(result.code, 0, result.stderr);
			assert.equal(verdict(fixture)?.pass, true);
			assert.equal(
				scalar(
					fixture.stateDb,
					"SELECT count(*) FROM sessions WHERE execution_id='old-blocked';",
				),
				"1",
			);
		} finally {
			await fixture.dispose();
		}
	},
);

test(
	"requires TURN deletion and QA successful-chain session cleanup",
	{ timeout: 30_000 },
	async () => {
		for (const retained of ["turn", "qa"]) {
			const fixture = createFixture();
			try {
				await fixture.listen(DESIGN);
				await fixture.listen(IMPLEMENT);
				// This sequence performs several SQLite/probe transitions before the
				// expected fail-closed verdict; keep its observer budget load-tolerant.
				const child = startObserver(fixture, 8000);
				await waitForSnapshot(fixture);
				for (const [executionId, requestId] of [
					[DESIGN, "req-design"],
					[IMPLEMENT, "req-implement"],
				]) {
					setShutdown(fixture, executionId, requestId, "requested");
				}
				await waitForSnapshot(
					fixture,
					(frame) => frame.shutdown?.implement?.state === "requested",
				);
				for (const [executionId, requestId] of [
					[DESIGN, "req-design"],
					[IMPLEMENT, "req-implement"],
				]) {
					setShutdown(fixture, executionId, requestId, "acked");
				}
				await waitForSnapshot(
					fixture,
					(frame) => frame.shutdown?.implement?.state === "acked",
				);
				await clearSockets(fixture);
				clearTmux(fixture);
				deleteLifecycle(fixture, {
					keepTurn: retained === "turn",
					keepQa: retained === "qa",
				});
				const result = await waitForExit(child, 12_000);
				assert.notEqual(result.code, 0);
				assert.match(
					verdict(fixture)?.reason ?? "",
					retained === "turn" ? /turn_not_deleted/ : /qa_session_not_deleted/,
				);
			} finally {
				await fixture.dispose();
			}
		}
	},
);

test(
	"requires no socket listener or holder after cleanup",
	{ timeout: 30_000 },
	async () => {
		const fixture = createFixture();
		try {
			await fixture.listen(DESIGN);
			await fixture.listen(IMPLEMENT);
			const child = startObserver(fixture);
			await waitForSnapshot(fixture);
			for (const [executionId, requestId] of [
				[DESIGN, "req-design"],
				[IMPLEMENT, "req-implement"],
			]) {
				setShutdown(fixture, executionId, requestId, "requested");
			}
			await waitForSnapshot(
				fixture,
				(frame) => frame.shutdown?.implement?.state === "requested",
			);
			for (const [executionId, requestId] of [
				[DESIGN, "req-design"],
				[IMPLEMENT, "req-implement"],
			]) {
				setShutdown(fixture, executionId, requestId, "acked");
			}
			await waitForSnapshot(
				fixture,
				(frame) => frame.shutdown?.implement?.state === "acked",
			);
			clearTmux(fixture);
			deleteLifecycle(fixture);
			const result = await waitForExit(child);
			assert.notEqual(result.code, 0);
			assert.match(
				verdict(fixture)?.reason ?? "",
				/orphan_socket|orphan_holder/,
			);
		} finally {
			await fixture.dispose();
		}
	},
);

test("opens both WAL databases readonly", { timeout: 30_000 }, async () => {
	const fixture = createFixture();
	try {
		const tracked = [
			fixture.stateDb,
			`${fixture.stateDb}-wal`,
			`${fixture.stateDb}-shm`,
			fixture.commDb,
			`${fixture.commDb}-wal`,
			`${fixture.commDb}-shm`,
		];
		const before = metadataSnapshot(tracked);
		const result = spawnSync(
			process.execPath,
			observerArgs(fixture, 2000, ["--once"]),
			{
				encoding: "utf8",
				env: observerEnv(fixture),
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const after = metadataSnapshot(tracked);
		assert.deepEqual(after, before);
		const invocations = readFileSync(fixture.sqliteLog, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.ok(invocations.length >= 2);
		assert.ok(invocations.every((line) => line.startsWith("-readonly -json ")));
		assert.ok(
			invocations.every((line) => line.includes("PRAGMA query_only=1")),
		);
		assert.equal(readFrames(fixture.out).at(-1)?.kind, "snapshot");
	} finally {
		await fixture.dispose();
	}
});
