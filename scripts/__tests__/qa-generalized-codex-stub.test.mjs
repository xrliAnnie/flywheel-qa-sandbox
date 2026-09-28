import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
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

async function waitForFile(path, childProcess, readStderr, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
			throw new Error(`process exited before ${path}: ${readStderr()}`);
		}
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${path}: ${readStderr()}`);
		}
		await sleep(20);
	}
}

test("Codex upstream fault stub refuses a non-slot room before listening", async () => {
	const slot = 47_000 + (process.pid % 1_000);
	const slotRoot = `/tmp/flywheel-test-slot-${slot}`;
	const receipt = join(slotRoot, "state", "codex-fault", "receipt.json");
	rmSync(slotRoot, { recursive: true, force: true });
	mkdirSync(join(slotRoot, "state", "codex-fault"), {
		recursive: true,
		mode: 0o700,
	});
	chmodSync(slotRoot, 0o700);
	writeFileSync(
		join(slotRoot, "room-info.json"),
		`${JSON.stringify({ schemaVersion: 1, slot, mode: "mirror" })}\n`,
		{ mode: 0o600 },
	);
	const fault = spawn(
		process.execPath,
		[
			resolve(root, "scripts/qa/codex-upstream-fault-stub.mjs"),
			"serve",
			"--slot",
			String(slot),
			"--receipt",
			receipt,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	fault.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const [code] = await once(fault, "exit");
	try {
		assert.notEqual(code, 0);
		assert.match(stderr, /room-info\.json must identify this mode=slot room/);
		assert.equal(existsSync(receipt), false);
	} finally {
		rmSync(slotRoot, { recursive: true, force: true });
	}
});

test("Codex upstream fault stub serves faults and teardown retires it from the receipt", async () => {
	const slot = 48_000 + (process.pid % 1_000);
	const slotRoot = `/tmp/flywheel-test-slot-${slot}`;
	const faultRoot = join(slotRoot, "state", "codex-fault");
	const receipt = join(faultRoot, "receipt.json");
	rmSync(slotRoot, { recursive: true, force: true });
	mkdirSync(faultRoot, { recursive: true, mode: 0o700 });
	chmodSync(slotRoot, 0o700);
	chmodSync(join(slotRoot, "state"), 0o700);
	chmodSync(faultRoot, 0o700);
	writeFileSync(
		join(slotRoot, "room-info.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			slot,
			mode: "slot",
			generalized: true,
			runnerMode: "real",
		})}\n`,
		{ mode: 0o600 },
	);
	const fault = spawn(
		process.execPath,
		[
			resolve(root, "scripts/qa/codex-upstream-fault-stub.mjs"),
			"serve",
			"--slot",
			String(slot),
			"--receipt",
			receipt,
			"--sequence",
			"rate_limit,server_error,capacity,quota,unauthorized",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	fault.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		await waitForFile(receipt, fault, () => stderr);
		const ready = JSON.parse(readFileSync(receipt, "utf8"));
		assert.equal(ready.host, "127.0.0.1");
		assert.match(ready.baseUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/v1$/);
		assert.deepEqual(ready.sequence, [
			"rate_limit",
			"server_error",
			"capacity",
			"quota",
			"unauthorized",
		]);
		const observed = [];
		for (let index = 0; index < ready.sequence.length; index += 1) {
			const response = await fetch(`${ready.baseUrl}/responses`, {
				method: "POST",
				headers: {
					authorization: "Bearer must-not-be-logged",
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: "gpt-5.6-sol", input: "fixture" }),
			});
			const body = await response.json();
			observed.push({ status: response.status, code: body.error.code });
		}
		assert.deepEqual(observed, [
			{ status: 429, code: "rate_limit_exceeded" },
			{ status: 500, code: "server_error" },
			{ status: 503, code: "server_overloaded" },
			{ status: 429, code: "insufficient_quota" },
			{ status: 401, code: "invalid_api_key" },
		]);
		assert.doesNotMatch(stderr, /must-not-be-logged/);

		const sourceHome = join(tempRoot, `fault-source-${slot}`);
		const destination = join(faultRoot, "source-home");
		mkdirSync(sourceHome, { mode: 0o700 });
		writeFileSync(join(sourceHome, "auth.json"), '{"fixture":"same-inode"}\n', {
			mode: 0o600,
		});
		writeFileSync(
			join(sourceHome, "config.toml"),
			'model_provider = "proxy"\nopenai_base_url = "https://production.invalid/v1"\n[features]\nweb_search = true\n',
			{ mode: 0o600 },
		);
		const prepared = spawnSync(
			process.execPath,
			[
				resolve(root, "scripts/qa/codex-upstream-fault-stub.mjs"),
				"prepare-source",
				"--slot",
				String(slot),
				"--receipt",
				receipt,
				"--source-home",
				sourceHome,
				"--destination",
				destination,
			],
			{ encoding: "utf8" },
		);
		assert.equal(prepared.status, 0, prepared.stderr);
		const sourceAuth = statSync(join(sourceHome, "auth.json"));
		const slotAuth = statSync(join(destination, "auth.json"));
		assert.equal(slotAuth.dev, sourceAuth.dev);
		assert.equal(slotAuth.ino, sourceAuth.ino);
		const config = readFileSync(join(destination, "config.toml"), "utf8");
		assert.match(
			config,
			/^model_provider = "openai"\nopenai_base_url = "http:\/\/127\.0\.0\.1:[1-9][0-9]*\/v1"\n/,
		);
		assert.doesNotMatch(config, /production\.invalid/);
		assert.match(config, /\[features\]\nweb_search = true/);

		// The readiness receipt is published before deploy finishes preparing the
		// slot-local source home. Teardown must therefore be able to retire the
		// stub from that receipt alone if deploy is interrupted in between.
		assert.equal(existsSync(join(faultRoot, "pid")), false);
		const teardownEnv = Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) => name !== "BASH_ENV" && name !== "ENV",
			),
		);
		const teardown = spawn(
			"/bin/bash",
			[
				"--noprofile",
				"--norc",
				"-c",
				'source "$1"; fault_slot="$2"; fault_script="$3"; ps() { printf "%s serve --slot %s --receipt fixture\\n" "$fault_script" "$fault_slot"; }; qa_teardown_codex_fault_stub "$fault_slot"',
				"qa-fault-teardown",
				resolve(root, "scripts/test-teardown.sh"),
				String(slot),
				resolve(root, "scripts/qa/codex-upstream-fault-stub.mjs"),
			],
			{ env: teardownEnv, stdio: ["ignore", "ignore", "pipe"] },
		);
		let teardownStderr = "";
		teardown.stderr.on("data", (chunk) => {
			teardownStderr += chunk;
		});
		const [teardownCode, teardownSignal] = await once(teardown, "exit");
		assert.equal(teardownSignal, null, teardownStderr);
		assert.equal(teardownCode, 0, teardownStderr);
		if (fault.exitCode === null && fault.signalCode === null) {
			await Promise.race([
				once(fault, "exit"),
				sleep(2_000).then(() => {
					throw new Error("teardown left the Codex fault stub running");
				}),
			]);
		}
		assert.notEqual(
			spawnSync("kill", ["-0", String(ready.pid)]).status,
			0,
			"teardown left the Codex fault stub PID observable",
		);
	} finally {
		if (fault.exitCode === null) fault.kill("SIGTERM");
		if (fault.exitCode === null) await once(fault, "exit");
		rmSync(slotRoot, { recursive: true, force: true });
	}
});

test("529 deploy wires the fault stub only through an explicit real-Codex slot switch", () => {
	const deploy = readFileSync(resolve(root, "scripts/test-deploy.sh"), "utf8");
	const teardown = readFileSync(
		resolve(root, "scripts/test-teardown.sh"),
		"utf8",
	);
	assert.match(deploy, /--codex-fault-sequence\)/);
	assert.match(
		deploy,
		/--codex-fault-sequence requires --generalized --codex-runner --mode slot/,
	);
	assert.match(
		deploy,
		/FLYWHEEL_CODEX_SOURCE_HOME=\$\{CODEX_FAULT_SOURCE_HOME\}/,
	);
	assert.match(
		deploy,
		/codex-upstream-fault-stub\.mjs" serve[\s\S]+codex-upstream-fault-stub\.mjs" prepare-source/,
	);
	assert.match(
		teardown,
		/CODEX_FAULT_RECEIPT="\$\{CODEX_FAULT_ROOT\}\/receipt\.json"/,
	);
	assert.doesNotMatch(deploy, /CODEX_FAULT_ROOT\}\/pid\.tmp/);
	assert.match(teardown, /if ! qa_teardown_codex_fault_stub "\$SLOT"; then/);
	const roomGuard = teardown.indexOf('.mode == "slot"');
	const faultSignal = teardown.indexOf(
		'qa_generalized_terminate_pid "$CODEX_FAULT_PID"',
	);
	assert.ok(roomGuard >= 0 && roomGuard < faultSignal);
	assert.match(teardown, /CODEX_FAULT_EXPECTED_SLOT_DIR/);
	assert.match(teardown, /Codex fault stub identity mismatch/);
});
