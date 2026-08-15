import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(import.meta.dirname, "../..");
const requireFromRunner = createRequire(
	resolve(root, "packages/claude-runner/package.json"),
);
const WebSocket = requireFromRunner("ws");
process.env.TMPDIR = "/tmp";
const tempRoot = mkdtempSync(join(tmpdir(), "flywheel-529-codex-stub-"));
const socketPath = join(tempRoot, "stub.sock");
assert.equal(tmpdir(), "/tmp");
assert.ok(
	Buffer.byteLength(socketPath) < 104,
	`test socket must fit Darwin sun_path: ${socketPath}`,
);
let child;
let ws;
let nextId = 1;
const pending = new Map();

async function waitForStderrMarker(
	processHandle,
	readStderr,
	marker,
	timeoutMs = 5_000,
) {
	const deadline = Date.now() + timeoutMs;
	while (!readStderr().includes(marker)) {
		if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
			throw new Error(`process exited before ${marker}: ${readStderr()}`);
		}
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${marker}: ${readStderr()}`);
		}
		await sleep(20);
	}
}

function request(method, params = {}) {
	const id = nextId++;
	return new Promise((resolvePromise, reject) => {
		pending.set(id, { resolve: resolvePromise, reject });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
	});
}

before(async () => {
	child = spawn(
		process.execPath,
		[
			resolve(root, "scripts/qa-529-generalized-codex-stub.mjs"),
			"app-server",
			"--remote-control",
			"--listen",
			`unix://${socketPath}`,
		],
		{
			env: { ...process.env, CODEX_HOME: tempRoot },
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	await waitForStderrMarker(
		child,
		() => stderr,
		"[qa-529-codex-stub] app-server ready",
	);
	assert.equal(
		existsSync(socketPath),
		true,
		`Codex stub did not listen: ${stderr}`,
	);
	ws = new WebSocket(`ws+unix://${socketPath}:/`, {
		perMessageDeflate: false,
	});
	await new Promise((resolvePromise, reject) => {
		ws.once("open", resolvePromise);
		ws.once("error", reject);
	});
	ws.on("message", (data) => {
		const frame = JSON.parse(String(data));
		const waiter = pending.get(frame.id);
		if (!waiter) return;
		pending.delete(frame.id);
		if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)));
		else waiter.resolve(frame.result);
	});
});

after(async () => {
	ws?.close();
	if (child?.exitCode === null) child.kill("SIGTERM");
	if (child)
		await new Promise((resolvePromise) => child.once("exit", resolvePromise));
	rmSync(tempRoot, { recursive: true, force: true });
});

test("Codex stub implements the resident goal RPC subset", async () => {
	await request("initialize", { clientInfo: { name: "test" } });
	ws.send(
		JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
	);
	const started = await request("thread/start", {
		cwd: root,
		sandbox: "workspace-write",
		model: "gpt-5.6-sol",
	});
	assert.match(started.thread.id, /^529-stub-/);
	const persisted = join(tempRoot, "qa-529-stub-thread.json");
	assert.deepEqual(JSON.parse(readFileSync(persisted, "utf8")), {
		id: started.thread.id,
		cwd: root,
	});
	assert.equal(statSync(persisted).mode & 0o777, 0o600);
	assert.deepEqual(
		await request("thread/goal/get", { threadId: started.thread.id }),
		{ goal: null },
	);
	await request("thread/goal/set", {
		threadId: started.thread.id,
		objective: "exercise generalized implement",
		status: "active",
	});
	assert.deepEqual(
		await request("thread/goal/get", { threadId: started.thread.id }),
		{
			goal: {
				objective: "exercise generalized implement",
				status: "active",
				tokensUsed: 0,
			},
		},
	);
	assert.deepEqual(
		await request("thread/resume", { threadId: started.thread.id }),
		{ thread: { id: started.thread.id } },
	);
});

test("Codex founder resume TUI stays alive until explicitly terminated", async () => {
	const executionId = "529-stub-visible-thread";
	const tui = spawn(
		process.execPath,
		[
			resolve(root, "scripts/qa-529-generalized-codex-stub.mjs"),
			"resume",
			"--remote",
			`unix://${socketPath}`,
			"529-stub-visible-thread",
		],
		{
			env: {
				...process.env,
				FLYWHEEL_EXEC_ID: executionId,
				FLYWHEEL_STATE_DB_PATH: join(tempRoot, "state.db"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	tui.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = once(tui, "exit");
	await waitForStderrMarker(
		tui,
		() => stderr,
		"[qa-529-codex-stub] resume ready",
	);
	assert.equal(tui.exitCode, null, `founder TUI exited immediately: ${stderr}`);
	tui.kill("SIGTERM");
	const [code, signal] = await exited;
	assert.equal(signal, null);
	assert.equal(code, 0);
});

test("Codex founder resume TUI exits only after its explicit exit fence", async () => {
	const executionId = "529-stub-fenced-thread";
	const tui = spawn(
		process.execPath,
		[
			resolve(root, "scripts/qa-529-generalized-codex-stub.mjs"),
			"resume",
			"--remote",
			`unix://${socketPath}`,
			executionId,
		],
		{
			env: {
				...process.env,
				FLYWHEEL_EXEC_ID: executionId,
				FLYWHEEL_STATE_DB_PATH: join(tempRoot, "state.db"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	tui.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = once(tui, "exit");
	await waitForStderrMarker(
		tui,
		() => stderr,
		"[qa-529-codex-stub] resume ready",
	);
	const controlDir = join(tempRoot, "stub-control");
	mkdirSync(controlDir, { recursive: true });
	const exitPath = join(controlDir, `${executionId}.exit.json`);
	writeFileSync(
		exitPath,
		`${JSON.stringify({
			schemaVersion: 1,
			executionId: "some-other-execution",
			requested: true,
		})}\n`,
	);
	await sleep(250);
	assert.equal(
		tui.exitCode,
		null,
		`resume TUI accepted a fence for another execution: ${stderr}`,
	);
	writeFileSync(
		exitPath,
		`${JSON.stringify({
			schemaVersion: 1,
			executionId,
			requested: true,
		})}\n`,
	);
	const [code, signal] = await Promise.race([
		exited,
		sleep(2_000).then(() => {
			tui.kill("SIGKILL");
			throw new Error(`resume TUI ignored explicit exit fence: ${stderr}`);
		}),
	]);
	assert.equal(signal, null);
	assert.equal(code, 0);
	assert.match(stderr, /explicit exit fence observed/);
});
