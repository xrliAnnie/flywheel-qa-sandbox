import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runGate } from "../package-gate.mjs";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const helper = join(repoRoot, "scripts", "package-gate-host.py");
const roots = [];
const children = new Set();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
	}
	await Promise.allSettled(
		[...children].map(
			(child) =>
				new Promise((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) resolve();
					else child.once("exit", resolve);
				}),
		),
	);
	children.clear();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function waitFor(predicate, timeoutMs = 5_000) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const poll = () => {
			try {
				const result = predicate();
				if (result) return resolve(result);
			} catch (error) {
				return reject(error);
			}
			if (Date.now() - started >= timeoutMs)
				return reject(new Error(`condition not met within ${timeoutMs}ms`));
			setTimeout(poll, 25);
		};
		poll();
	});
}

function readEvents(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function startRequest({
	stateRoot,
	worktree,
	id,
	events,
	release,
	detached = false,
}) {
	const child = spawn(
		"/usr/bin/python3",
		[
			helper,
			"_test-run",
			"--state-root",
			stateRoot,
			"--worktree",
			worktree,
			"--head",
			id.repeat(40).slice(0, 40),
			"--",
			process.execPath,
			join(stateRoot, "fake-worker.mjs"),
			id,
			events,
			release,
		],
		{
			cwd: repoRoot,
			env: { ...process.env, FLYWHEEL_PACKAGE_GATE_TESTING: "1" },
			detached,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

function configureAsync(stateRoot, capacity = 2) {
	const child = spawn(
		"/usr/bin/python3",
		[
			helper,
			"_test-config",
			"--state-root",
			stateRoot,
			"--capacity",
			String(capacity),
		],
		{
			cwd: repoRoot,
			env: { ...process.env, FLYWHEEL_PACKAGE_GATE_TESTING: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	return new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal, stderr })),
	);
}

function configure(stateRoot, capacity = 2) {
	return spawnSync(
		"/usr/bin/python3",
		[
			helper,
			"_test-config",
			"--state-root",
			stateRoot,
			"--capacity",
			String(capacity),
			"--enable",
		],
		{
			cwd: repoRoot,
			env: { ...process.env, FLYWHEEL_PACKAGE_GATE_TESTING: "1" },
			encoding: "utf8",
		},
	);
}

test("capacity N queues N+1 without starting work and hands off within five seconds", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-test-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot, { recursive: true });
	const events = join(root, "events.jsonl");
	writeFileSync(
		join(stateRoot, "fake-worker.mjs"),
		`import {appendFileSync,existsSync} from 'node:fs';
const [id,events,release]=process.argv.slice(2);
appendFileSync(events,JSON.stringify({kind:'start',id,at:Date.now()})+'\\n');
while(!existsSync(release)) await new Promise(resolve=>setTimeout(resolve,25));
appendFileSync(events,JSON.stringify({kind:'end',id,at:Date.now()})+'\\n');\n`,
	);
	const configured = configure(stateRoot);
	assert.equal(configured.status, 0, configured.stderr);

	const releaseA = join(root, "release-a");
	const releaseB = join(root, "release-b");
	const releaseC = join(root, "release-c");
	const a = startRequest({
		stateRoot,
		worktree: join(root, "worktree-a"),
		id: "a",
		events,
		release: releaseA,
	});
	await waitFor(() => readEvents(events).some((event) => event.id === "a"));
	const b = startRequest({
		stateRoot,
		worktree: join(root, "worktree-b"),
		id: "b",
		events,
		release: releaseB,
	});
	await waitFor(() => readEvents(events).some((event) => event.id === "b"));
	const c = startRequest({
		stateRoot,
		worktree: join(root, "worktree-c"),
		id: "c",
		events,
		release: releaseC,
	});

	await waitFor(() => c.stderr().includes("PACKAGE_GATE_WAIT"));
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(
		readEvents(events).some((event) => event.id === "c"),
		false,
		"queued request must not start its worker",
	);
	assert.match(c.stderr(), /等待第 1 位 \/ 前面 0 个/);
	const ledger = JSON.parse(
		readFileSync(join(stateRoot, "ledger.json"), "utf8"),
	);
	assert.equal(ledger.capacity, 2);
	assert.equal(
		ledger.live.find((row) => row.worktreeRealpath.endsWith("worktree-c"))
			.position,
		1,
	);

	const releasedAt = Date.now();
	writeFileSync(releaseA, "go\n");
	const cStart = await waitFor(
		() =>
			readEvents(events).find(
				(event) => event.id === "c" && event.kind === "start",
			),
		5_000,
	);
	assert.ok(
		cStart.at - releasedAt <= 5_000,
		`handoff took ${cStart.at - releasedAt}ms`,
	);
	writeFileSync(releaseB, "go\n");
	writeFileSync(releaseC, "go\n");
	for (const request of [a, b, c]) {
		const result = await request.exited;
		assert.deepEqual(result, { code: 0, signal: null }, request.stderr());
	}

	const timeline = readEvents(events).sort((left, right) => left.at - right.at);
	let active = 0;
	let maxActive = 0;
	for (const event of timeline) {
		active += event.kind === "start" ? 1 : -1;
		maxActive = Math.max(maxActive, active);
	}
	assert.equal(maxActive, 2);
});

test("test API rejects a symlinked state root instead of resolving through it", () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-symlink-"));
	roots.push(root);
	const target = join(root, "target");
	mkdirSync(target);
	const link = join(root, "state-link");
	symlinkSync(target, link);
	const result = spawnSync(
		"/usr/bin/python3",
		[helper, "_test-status", "--state-root", link, "--json"],
		{
			cwd: repoRoot,
			env: { ...process.env, FLYWHEEL_PACKAGE_GATE_TESTING: "1" },
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 70, result.stdout);
	assert.match(result.stderr, /state_root_not_directory/);
});

test("corrupt database fails closed without replacing its bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-corrupt-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const database = join(stateRoot, "queue.sqlite3");
	const corrupt = Buffer.from("not a sqlite database\n");
	writeFileSync(database, corrupt, { mode: 0o600 });
	const result = spawnSync(
		"/usr/bin/python3",
		[helper, "_test-status", "--state-root", stateRoot, "--json"],
		{
			cwd: repoRoot,
			env: { ...process.env, FLYWHEEL_PACKAGE_GATE_TESTING: "1" },
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 70, result.stdout);
	assert.deepEqual(readFileSync(database), corrupt);
});

test("a dead supervisor is reaped only after its worker group is gone", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-crash-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const events = join(root, "events.jsonl");
	writeFileSync(
		join(stateRoot, "fake-worker.mjs"),
		`import {appendFileSync,existsSync} from 'node:fs';
const [id,events,release]=process.argv.slice(2);
appendFileSync(events,JSON.stringify({kind:'start',id,at:Date.now()})+'\\n');
while(!existsSync(release)) await new Promise(resolve=>setTimeout(resolve,25));
appendFileSync(events,JSON.stringify({kind:'end',id,at:Date.now()})+'\\n');\n`,
	);
	const configured = configure(stateRoot, 1);
	assert.equal(configured.status, 0, configured.stderr);
	const a = startRequest({
		stateRoot,
		worktree: join(root, "worktree-a"),
		id: "a",
		events,
		release: join(root, "never-release-a"),
	});
	await waitFor(() => readEvents(events).some((event) => event.id === "a"));
	const releaseB = join(root, "release-b");
	const b = startRequest({
		stateRoot,
		worktree: join(root, "worktree-b"),
		id: "b",
		events,
		release: releaseB,
	});
	await waitFor(() => b.stderr().includes("PACKAGE_GATE_WAIT"));
	const killedAt = Date.now();
	a.child.kill("SIGKILL");
	await a.exited;
	const bStart = await waitFor(
		() =>
			readEvents(events).find(
				(event) => event.id === "b" && event.kind === "start",
			),
		8_000,
	);
	assert.ok(
		bStart.at - killedAt <= 7_000,
		`crash handoff took ${bStart.at - killedAt}ms`,
	);
	writeFileSync(releaseB, "go\n");
	assert.deepEqual(await b.exited, { code: 0, signal: null }, b.stderr());
	const ledger = JSON.parse(
		readFileSync(join(stateRoot, "ledger.json"), "utf8"),
	);
	assert.ok(
		ledger.recent.some(
			(row) =>
				row.worktreeRealpath.endsWith("worktree-a") &&
				row.state === "abandoned",
		),
		JSON.stringify(ledger, null, 2),
	);
});

test("queued and running SIGTERM preserve 143 and never leak the slot", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-signal-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const events = join(root, "events.jsonl");
	writeFileSync(
		join(stateRoot, "fake-worker.mjs"),
		`import {appendFileSync,existsSync} from 'node:fs';
const [id,events,release]=process.argv.slice(2);
appendFileSync(events,JSON.stringify({kind:'start',id,at:Date.now()})+'\\n');
while(!existsSync(release)) await new Promise(resolve=>setTimeout(resolve,25));\n`,
	);
	assert.equal(configure(stateRoot, 1).status, 0);
	const a = startRequest({
		stateRoot,
		worktree: join(root, "worktree-a"),
		id: "a",
		events,
		release: join(root, "never-a"),
	});
	await waitFor(() => readEvents(events).some((event) => event.id === "a"));
	const b = startRequest({
		stateRoot,
		worktree: join(root, "worktree-b"),
		id: "b",
		events,
		release: join(root, "never-b"),
	});
	await waitFor(() => b.stderr().includes("PACKAGE_GATE_WAIT"));
	b.child.kill("SIGTERM");
	assert.deepEqual(await b.exited, { code: 143, signal: null }, b.stderr());
	assert.equal(
		readEvents(events).some((event) => event.id === "b"),
		false,
	);
	a.child.kill("SIGTERM");
	assert.deepEqual(await a.exited, { code: 143, signal: null }, a.stderr());
	const ledger = JSON.parse(
		readFileSync(join(stateRoot, "ledger.json"), "utf8"),
	);
	assert.equal(ledger.live.length, 0);
	assert.ok(
		ledger.recent.some(
			(row) => row.state === "cancelled" && row.exitCode === 143,
		),
	);
	assert.ok(
		ledger.recent.some(
			(row) => row.state === "finished" && row.exitCode === 143,
		),
	);
});

test("watchdog survives caller process-group SIGKILL and frees the slot", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-caller-kill-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const events = join(root, "events.jsonl");
	writeFileSync(
		join(stateRoot, "fake-worker.mjs"),
		`import {appendFileSync,existsSync} from 'node:fs';
const [id,events,release]=process.argv.slice(2);
appendFileSync(events,JSON.stringify({kind:'start',id,at:Date.now()})+'\\n');
while(!existsSync(release)) await new Promise(resolve=>setTimeout(resolve,25));\n`,
	);
	assert.equal(configure(stateRoot, 1).status, 0);
	const a = startRequest({
		stateRoot,
		worktree: join(root, "worktree-a"),
		id: "a",
		events,
		release: join(root, "never-a"),
		detached: true,
	});
	await waitFor(() => readEvents(events).some((event) => event.id === "a"));
	const releaseB = join(root, "release-b");
	const b = startRequest({
		stateRoot,
		worktree: join(root, "worktree-b"),
		id: "b",
		events,
		release: releaseB,
	});
	await waitFor(() => b.stderr().includes("PACKAGE_GATE_WAIT"));
	const killedAt = Date.now();
	process.kill(-a.child.pid, "SIGKILL");
	await a.exited;
	const bStart = await waitFor(
		() =>
			readEvents(events).find(
				(event) => event.id === "b" && event.kind === "start",
			),
		8_000,
	);
	assert.ok(
		bStart.at - killedAt <= 7_000,
		`caller-group handoff took ${bStart.at - killedAt}ms`,
	);
	writeFileSync(releaseB, "go\n");
	assert.deepEqual(await b.exited, { code: 0, signal: null }, b.stderr());
});

test("configuration rejects capacity changes while a request is live", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-capacity-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const events = join(root, "events.jsonl");
	const release = join(root, "release");
	writeFileSync(
		join(stateRoot, "fake-worker.mjs"),
		`import {appendFileSync,existsSync} from 'node:fs';
const [id,events,release]=process.argv.slice(2);
appendFileSync(events,JSON.stringify({kind:'start',id,at:Date.now()})+'\\n');
while(!existsSync(release)) await new Promise(resolve=>setTimeout(resolve,25));\n`,
	);
	assert.equal(configure(stateRoot, 1).status, 0);
	const request = startRequest({
		stateRoot,
		worktree: join(root, "worktree"),
		id: "a",
		events,
		release,
	});
	await waitFor(() => readEvents(events).length === 1);
	const changed = configure(stateRoot, 2);
	assert.equal(changed.status, 70);
	assert.match(changed.stderr, /capacity_change_requires_empty_queue/);
	writeFileSync(release, "go\n");
	assert.deepEqual(await request.exited, { code: 0, signal: null });
});

test("simultaneous first-use initialization converges on one database", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-init-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	const results = await Promise.all(
		Array.from({ length: 8 }, () => configureAsync(stateRoot, 2)),
	);
	assert.deepEqual(
		results.map((result) => result.code),
		Array(8).fill(0),
		results.map((result) => result.stderr).join("\n"),
	);
	const status = spawnSync(
		"/usr/bin/python3",
		[helper, "_test-status", "--state-root", stateRoot, "--json"],
		{
			cwd: repoRoot,
			env: { ...process.env, FLYWHEEL_PACKAGE_GATE_TESTING: "1" },
			encoding: "utf8",
		},
	);
	assert.equal(status.status, 0, status.stderr);
	assert.equal(JSON.parse(status.stdout).capacity, 2);
});

test("replacing a live owner lock inode never authorizes early recovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-lock-replace-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const events = join(root, "events.jsonl");
	const releaseA = join(root, "release-a");
	const releaseB = join(root, "release-b");
	writeFileSync(
		join(stateRoot, "fake-worker.mjs"),
		`import {appendFileSync,existsSync} from 'node:fs';
const [id,events,release]=process.argv.slice(2);
appendFileSync(events,JSON.stringify({kind:'start',id,at:Date.now()})+'\\n');
while(!existsSync(release)) await new Promise(resolve=>setTimeout(resolve,25));\n`,
	);
	assert.equal(configure(stateRoot, 1).status, 0);
	const a = startRequest({
		stateRoot,
		worktree: join(root, "worktree-a"),
		id: "a",
		events,
		release: releaseA,
	});
	await waitFor(() => readEvents(events).length === 1);
	const firstLedger = JSON.parse(
		readFileSync(join(stateRoot, "ledger.json"), "utf8"),
	);
	const owner = firstLedger.live.find((row) =>
		row.worktreeRealpath.endsWith("worktree-a"),
	);
	const lockPath = join(stateRoot, "owners", `${owner.ownerLockId}.lock`);
	rmSync(lockPath);
	writeFileSync(lockPath, "replacement\n", { mode: 0o600 });
	const b = startRequest({
		stateRoot,
		worktree: join(root, "worktree-b"),
		id: "b",
		events,
		release: releaseB,
	});
	await waitFor(() => b.stderr().includes("PACKAGE_GATE_WAIT"));
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(
		readEvents(events).some((event) => event.id === "b"),
		false,
	);
	writeFileSync(releaseA, "go\n");
	await waitFor(
		() => readEvents(events).some((event) => event.id === "b"),
		5_000,
	);
	writeFileSync(releaseB, "go\n");
	assert.deepEqual(await a.exited, { code: 0, signal: null }, a.stderr());
	assert.deepEqual(await b.exited, { code: 0, signal: null }, b.stderr());
});

test("normal completion clears residual descendants before releasing capacity", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-residual-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const events = join(root, "events.jsonl");
	const release = join(root, "release");
	writeFileSync(
		join(stateRoot, "fake-worker.mjs"),
		`import {appendFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
const [id,events,release]=process.argv.slice(2);
const residual=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
appendFileSync(events,JSON.stringify({kind:'start',id,at:Date.now(),residualPid:residual.pid})+'\\n');
while(!existsSync(release)) await new Promise(resolve=>setTimeout(resolve,25));
residual.unref();\n`,
	);
	assert.equal(configure(stateRoot, 1).status, 0);
	const request = startRequest({
		stateRoot,
		worktree: join(root, "worktree"),
		id: "a",
		events,
		release,
	});
	const started = await waitFor(() => readEvents(events)[0]);
	writeFileSync(release, "go\n");
	assert.deepEqual(
		await request.exited,
		{ code: 0, signal: null },
		request.stderr(),
	);
	await waitFor(() => {
		try {
			process.kill(started.residualPid, 0);
			return false;
		} catch (error) {
			return error.code === "ESRCH";
		}
	}, 7_000);
	const ledger = JSON.parse(
		readFileSync(join(stateRoot, "ledger.json"), "utf8"),
	);
	assert.equal(ledger.recent[0].outcome, "completed");
});

test("status prunes only terminal rows older than seven days after lock and group proof", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-host-retention-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const events = join(root, "events.jsonl");
	const release = join(root, "release");
	writeFileSync(
		join(stateRoot, "fake-worker.mjs"),
		`import {appendFileSync} from 'node:fs';
const [id,events]=process.argv.slice(2);
appendFileSync(events,JSON.stringify({kind:'start',id,at:Date.now()})+'\\n');\n`,
	);
	assert.equal(configure(stateRoot, 1).status, 0);
	const request = startRequest({
		stateRoot,
		worktree: join(root, "worktree"),
		id: "a",
		events,
		release,
	});
	assert.deepEqual(
		await request.exited,
		{ code: 0, signal: null },
		request.stderr(),
	);
	const before = JSON.parse(
		readFileSync(join(stateRoot, "ledger.json"), "utf8"),
	);
	const row = before.recent[0];
	const lockPath = join(stateRoot, "owners", `${row.ownerLockId}.lock`);
	assert.equal(existsSync(lockPath), true);
	const mutated = spawnSync(
		"/usr/bin/python3",
		[
			"-c",
			"import sqlite3,sys,time; db=sqlite3.connect(sys.argv[1]); db.execute('UPDATE requests SET finishedAtMs=?,finishedAt=?',(int(time.time()*1000)-8*86400000,'2000-01-01T00:00:00.000Z')); db.commit()",
			join(stateRoot, "queue.sqlite3"),
		],
		{ encoding: "utf8" },
	);
	assert.equal(mutated.status, 0, mutated.stderr);
	const status = spawnSync(
		"/usr/bin/python3",
		[helper, "_test-status", "--state-root", stateRoot, "--json"],
		{
			cwd: repoRoot,
			env: { ...process.env, FLYWHEEL_PACKAGE_GATE_TESTING: "1" },
			encoding: "utf8",
		},
	);
	assert.equal(status.status, 0, status.stderr);
	assert.equal(JSON.parse(status.stdout).recent.length, 0);
	assert.equal(existsSync(lockPath), false);
});

function gateFixture(root, name) {
	const worktree = join(root, `gate-${name}`);
	mkdirSync(join(worktree, "packages", "fixture"), { recursive: true });
	writeFileSync(
		join(worktree, "packages", "fixture", "package.json"),
		JSON.stringify({
			name: `fixture-${name}`,
			scripts: { "test:run": "node --test" },
		}),
	);
	const commands = join(worktree, "commands.jsonl");
	const release = join(worktree, "release-build");
	const pnpm = join(worktree, "pnpm");
	writeFileSync(
		pnpm,
		`#!/usr/bin/env node
const {appendFileSync,existsSync}=require('node:fs');
(async()=>{const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(commands)},JSON.stringify({args,at:Date.now()})+'\\n');
if(args[0]==='-r') while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,25));
process.exit(0);})();\n`,
		{ mode: 0o755 },
	);
	return { worktree, commands, release, pnpm };
}

test("exported runGate takes the host slot before build and keeps queued builds at zero", async () => {
	const root = mkdtempSync(join(tmpdir(), "package-gate-run-gate-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot);
	const configured = configure(stateRoot, 1);
	assert.equal(configured.status, 0, configured.stderr);
	const a = gateFixture(root, "a");
	const b = gateFixture(root, "b");
	const localEnvironment = {
		...process.env,
		CI: "",
		GITHUB_ACTIONS: "",
	};
	const first = runGate({
		root: a.worktree,
		pnpm: a.pnpm,
		receiptRoot: join(root, "receipts-a"),
		quiet: true,
		environment: localEnvironment,
		hostQueue: { stateRoot },
	});
	let second;
	let settledSecond;
	try {
		await waitFor(() => readEvents(a.commands).length > 0);
		second = runGate({
			root: b.worktree,
			pnpm: b.pnpm,
			receiptRoot: join(root, "receipts-b"),
			quiet: true,
			environment: localEnvironment,
			hostQueue: { stateRoot },
		});
		second.then((result) => {
			settledSecond = result;
		});
		try {
			await waitFor(() => {
				if (!existsSync(join(stateRoot, "ledger.json"))) return false;
				const ledger = JSON.parse(
					readFileSync(join(stateRoot, "ledger.json"), "utf8"),
				);
				return ledger.live.some(
					(row) =>
						row.worktreeRealpath === realpathSync(b.worktree) &&
						row.state === "queued" &&
						Number.isSafeInteger(row.waitMs) &&
						row.waitMs >= 0,
				);
			});
		} catch (error) {
			const ledger = readFileSync(join(stateRoot, "ledger.json"), "utf8");
			throw new Error(`${error.message}; pre-release ledger=${ledger}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(
			readEvents(b.commands).length,
			0,
			"queued runGate must not start build",
		);
		const releasedAt = Date.now();
		writeFileSync(a.release, "go\n");
		const firstResult = await first;
		assert.equal(firstResult.exitCode, 0);
		let bBuild;
		try {
			bBuild = await waitFor(() => {
				const event = readEvents(b.commands)[0];
				if (!event && settledSecond)
					throw new Error(
						`second gate exited before build: ${JSON.stringify(settledSecond)}`,
					);
				return event;
			}, 5_000);
		} catch (error) {
			const ledger = readFileSync(join(stateRoot, "ledger.json"), "utf8");
			throw new Error(`${error.message}; ledger=${ledger}`);
		}
		assert.ok(
			bBuild.at - releasedAt <= 5_000,
			`runGate handoff took ${bBuild.at - releasedAt}ms`,
		);
		writeFileSync(b.release, "go\n");
		const secondResult = await second;
		assert.equal(secondResult.exitCode, 0);
		assert.ok(secondResult.hostQueue.queueWaitMs > 0);
		const finalLedger = JSON.parse(
			readFileSync(join(stateRoot, "ledger.json"), "utf8"),
		);
		const receiptRow = finalLedger.recent.find(
			(row) => row.requestId === secondResult.hostQueue.requestId,
		);
		assert.equal(receiptRow.receiptPath, secondResult.directory);
	} finally {
		writeFileSync(a.release, "go\n");
		writeFileSync(b.release, "go\n");
		await Promise.allSettled([first, second].filter(Boolean));
	}
});
