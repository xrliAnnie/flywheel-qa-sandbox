#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromRunner = createRequire(
	resolve(here, "../packages/claude-runner/package.json"),
);
const { WebSocket, WebSocketServer } = requireFromRunner("ws");
const argv = process.argv.slice(2);

function resumeExitFencePath() {
	const executionId = process.env.FLYWHEEL_EXEC_ID?.trim();
	const stateDbPath = process.env.FLYWHEEL_STATE_DB_PATH?.trim();
	if (!executionId || !stateDbPath || !/^[A-Za-z0-9._-]+$/.test(executionId)) {
		return null;
	}
	return resolve(
		dirname(stateDbPath),
		"stub-control",
		`${executionId}.exit.json`,
	);
}

function hasExplicitResumeExitFence(path) {
	if (!path || !existsSync(path)) return false;
	try {
		const command = JSON.parse(readFileSync(path, "utf8"));
		return (
			command?.schemaVersion === 1 &&
			command.executionId === process.env.FLYWHEEL_EXEC_ID?.trim() &&
			command.requested === true
		);
	} catch {
		return false;
	}
}

if (argv.includes("--version") || argv.includes("-v")) {
	process.stdout.write("codex-cli 0.0.0-flywheel-529-stub\n");
	process.exit(0);
}

if (argv[0] === "resume") {
	// Founder visibility only: the machine-side stub server drives the phase.
	// Keep the tmux pane alive without starting a second worker or model turn,
	// but honor the same durable exit fence as the machine-side worker. This
	// turns the pane dead only after the driver explicitly fences this execution.
	// Signal listeners alone do not count as an active Node handle; Node 25 exits
	// an unsettled top-level await with code 13 unless a real handle stays open.
	await new Promise((resolvePromise) => {
		const exitFencePath = resumeExitFencePath();
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearInterval(keepAlive);
			resolvePromise();
		};
		const checkExitFence = () => {
			if (!hasExplicitResumeExitFence(exitFencePath)) return false;
			process.stderr.write(
				"[qa-529-codex-stub] explicit exit fence observed\n",
			);
			finish();
			return true;
		};
		const keepAlive = setInterval(checkExitFence, 100);
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
			process.once(signal, finish);
		}
		if (!checkExitFence()) {
			process.stderr.write("[qa-529-codex-stub] resume ready\n");
		}
	});
	process.exit(0);
}

if (argv[0] !== "app-server") {
	process.stderr.write(
		`[qa-529-codex-stub] unsupported invocation: ${argv.join(" ")}\n`,
	);
	process.exit(64);
}

const listenIndex = argv.indexOf("--listen");
const listenUri = listenIndex >= 0 ? argv[listenIndex + 1] : undefined;
if (!listenUri?.startsWith("unix://")) {
	process.stderr.write("[qa-529-codex-stub] unix --listen URI required\n");
	process.exit(64);
}
const socketPath = listenUri.slice("unix://".length);
const workerSource = resolve(here, "qa-529-generalized-stub.mjs");
const threadStatePath = process.env.CODEX_HOME
	? resolve(process.env.CODEX_HOME, "qa-529-stub-thread.json")
	: undefined;
const threads = new Map();
let worker = null;
let stopping = false;
let turnSequence = 0;

function rpcResult(ws, id, result = {}) {
	ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function rpcError(ws, id, code, message) {
	ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

function threadFor(params) {
	const threadId = params?.threadId;
	return typeof threadId === "string" ? threads.get(threadId) : undefined;
}

function persistThread(thread) {
	if (!threadStatePath) return;
	mkdirSync(dirname(threadStatePath), { recursive: true, mode: 0o700 });
	const temp = `${threadStatePath}.tmp.${process.pid}`;
	writeFileSync(
		temp,
		`${JSON.stringify({ id: thread.id, cwd: thread.cwd })}\n`,
		{ mode: 0o600 },
	);
	chmodSync(temp, 0o600);
	renameSync(temp, threadStatePath);
}

function restoreThread(threadId) {
	if (!threadStatePath || !existsSync(threadStatePath)) return undefined;
	const stored = JSON.parse(readFileSync(threadStatePath, "utf8"));
	if (
		stored?.id !== threadId ||
		typeof stored.cwd !== "string" ||
		!stored.cwd
	) {
		return undefined;
	}
	return { id: threadId, cwd: stored.cwd, goal: null };
}

function startWorker(thread) {
	if (worker && worker.exitCode === null) return;
	worker = spawn(process.execPath, [workerSource], {
		cwd: thread.cwd,
		env: process.env,
		stdio: "inherit",
	});
	worker.once("exit", (code, signal) => {
		if (stopping || code === 0) return;
		thread.goal = {
			...(thread.goal ?? {}),
			status: "blocked",
			tokensUsed: 0,
		};
		for (const client of wss.clients) {
			if (client.readyState !== WebSocket.OPEN) continue;
			client.send(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "thread/goal/updated",
					params: { threadId: thread.id, goal: thread.goal, signal },
				}),
			);
		}
	});
}

function handleRpc(ws, frame) {
	const { id, method, params = {} } = frame ?? {};
	if (method === "initialized" && id === undefined) return;
	if (typeof id !== "number" || typeof method !== "string") return;
	switch (method) {
		case "initialize":
			rpcResult(ws, id, { serverInfo: { name: "flywheel-529-stub" } });
			return;
		case "thread/start": {
			if (typeof params.cwd !== "string" || !params.cwd) {
				rpcError(ws, id, -32602, "thread/start cwd required");
				return;
			}
			const execution = (
				process.env.FLYWHEEL_EXEC_ID ?? `${process.pid}`
			).replace(/[^A-Za-z0-9-]/g, "-");
			const thread = {
				id: `529-stub-${execution}`,
				cwd: params.cwd,
				goal: null,
			};
			threads.set(thread.id, thread);
			persistThread(thread);
			rpcResult(ws, id, { thread: { id: thread.id } });
			return;
		}
		case "thread/resume": {
			if (typeof params.threadId !== "string" || !params.threadId) {
				rpcError(ws, id, -32602, "thread/resume threadId required");
				return;
			}
			if (!threads.has(params.threadId)) {
				const restored = restoreThread(params.threadId);
				if (!restored) {
					rpcError(ws, id, -32602, "unknown persisted thread");
					return;
				}
				threads.set(params.threadId, restored);
			}
			rpcResult(ws, id, { thread: { id: params.threadId } });
			return;
		}
		case "thread/goal/get": {
			const thread = threadFor(params);
			if (!thread) {
				rpcError(ws, id, -32602, "unknown thread");
				return;
			}
			rpcResult(ws, id, { goal: thread.goal });
			return;
		}
		case "thread/goal/set": {
			const thread = threadFor(params);
			if (!thread) {
				rpcError(ws, id, -32602, "unknown thread");
				return;
			}
			thread.goal = {
				objective: params.objective,
				status: params.status ?? "active",
				tokensUsed: 0,
			};
			rpcResult(ws, id);
			return;
		}
		case "thread/goal/clear": {
			const thread = threadFor(params);
			if (!thread) {
				rpcError(ws, id, -32602, "unknown thread");
				return;
			}
			thread.goal = null;
			rpcResult(ws, id);
			return;
		}
		case "thread/read": {
			const thread = threadFor(params);
			if (!thread) {
				rpcError(ws, id, -32602, "unknown thread");
				return;
			}
			rpcResult(ws, id, { thread: { id: thread.id }, turns: [] });
			return;
		}
		case "turn/start": {
			const thread = threadFor(params);
			if (!thread) {
				rpcError(ws, id, -32602, "unknown thread");
				return;
			}
			startWorker(thread);
			turnSequence += 1;
			const turnId = `529-stub-turn-${turnSequence}`;
			rpcResult(ws, id, { turn: { id: turnId } });
			ws.send(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "turn/started",
					params: { threadId: thread.id, turn: { id: turnId } },
				}),
			);
			return;
		}
		default:
			rpcError(ws, id, -32601, `method not found: ${method}`);
	}
}

if (existsSync(socketPath)) rmSync(socketPath, { force: true });
const server = createServer();
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
	wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
	ws.on("message", (data) => {
		try {
			handleRpc(ws, JSON.parse(String(data)));
		} catch (error) {
			process.stderr.write(
				`[qa-529-codex-stub] invalid frame: ${error instanceof Error ? error.message : error}\n`,
			);
		}
	});
});

function shutdown(signal) {
	if (stopping) return;
	stopping = true;
	if (worker && worker.exitCode === null) worker.kill(signal);
	for (const client of wss.clients) client.terminate();
	server.close(() => {
		rmSync(socketPath, { force: true });
	});
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.once(signal, () => shutdown(signal));
}
server.listen(socketPath, () => {
	chmodSync(socketPath, 0o600);
	process.stderr.write("[qa-529-codex-stub] app-server ready\n");
});
