#!/usr/bin/env node
/**
 * FLY-2211 M5 research probe: can a successor client attach to an already-live
 * Codex goal without re-kicking it, and is clientUserMessageId an idempotency
 * key? This is intentionally isolated: one temp repo, one temp CODEX_HOME root,
 * one temp socket, and one uniquely named execution. It never touches launchd,
 * Bridge, production tmux sessions, or a restart wave.
 *
 * Build the runner first, then run:
 *   pnpm --filter flywheel-claude-runner build
 *   node scripts/qa-fly-2211-attach-probe.mjs --output /tmp/fly2211.json
 *
 * A negative capability result is a successful probe. Exit 1 is reserved for
 * a setup/cleanup failure that makes the evidence unreliable.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const runnerEntry = join(repoRoot, "packages/claude-runner/dist/index.js");
const requireFromRunner = createRequire(
	join(repoRoot, "packages/claude-runner/package.json"),
);
const WebSocket = requireFromRunner("ws");

function argValue(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function bounded(value, max = 20_000) {
	const text = JSON.stringify(value);
	if (text.length <= max) return value;
	return { truncated: true, bytes: text.length, prefix: text.slice(0, max) };
}

function rpcError(error) {
	if (!(error instanceof Error)) return String(error);
	return error.message;
}

function extractThreadId(result) {
	return result?.thread?.id ?? result?.threadId ?? result?.id;
}

function extractTurnId(result) {
	return result?.turn?.id ?? result?.turnId ?? result?.id;
}

class RpcClient {
	static async connect(socketPath, label) {
		const ws = new WebSocket(`ws+unix://${socketPath}:/`, {
			perMessageDeflate: false,
		});
		await new Promise((resolvePromise, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${label} websocket open timed out`)),
				10_000,
			);
			ws.once("open", () => {
				clearTimeout(timer);
				resolvePromise();
			});
			ws.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		return new RpcClient(ws, label);
	}

	constructor(ws, label) {
		this.ws = ws;
		this.label = label;
		this.nextId = 1;
		this.pending = new Map();
		this.notifications = [];
		ws.on("message", (data) => this.onMessage(data));
		ws.on("close", () => this.rejectPending(`${label} websocket closed`));
		ws.on("error", (error) => this.rejectPending(rpcError(error)));
	}

	onMessage(data) {
		let frame;
		try {
			frame = JSON.parse(String(data));
		} catch {
			return;
		}
		if (frame?.method && typeof frame.id === "number") {
			this.ws.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: frame.id,
					error: { code: -32601, message: "method not found" },
				}),
			);
		}
		if (frame?.method) {
			if (this.notifications.length < 300) {
				this.notifications.push({
					at: new Date().toISOString(),
					method: frame.method,
					params: bounded(frame.params, 4_000),
				});
			}
			return;
		}
		const waiter = this.pending.get(frame?.id);
		if (!waiter) return;
		this.pending.delete(frame.id);
		clearTimeout(waiter.timer);
		if (frame.error !== undefined) {
			waiter.reject(new Error(JSON.stringify(frame.error)));
		} else {
			waiter.resolve(frame.result);
		}
	}

	rejectPending(reason) {
		for (const [, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(reason));
		}
		this.pending.clear();
	}

	request(method, params = {}, timeoutMs = 30_000) {
		const id = this.nextId++;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolvePromise, reject, timer });
			this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	notify(method, params = {}) {
		this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	}

	async initialize() {
		await this.request("initialize", {
			clientInfo: {
				name: `flywheel-fly2211-${this.label}`,
				title: "FLY-2211 isolated attach probe",
				version: "1.0.0",
			},
			capabilities: {},
		});
		this.notify("initialized", {});
	}

	close() {
		this.rejectPending(`${this.label} closed by probe`);
		this.ws.close();
	}
}

async function capture(client, method, params = {}, timeoutMs = 30_000) {
	const startedAt = Date.now();
	try {
		const result = await client.request(method, params, timeoutMs);
		return {
			ok: true,
			elapsedMs: Date.now() - startedAt,
			result: bounded(result),
			raw: result,
		};
	} catch (error) {
		return {
			ok: false,
			elapsedMs: Date.now() - startedAt,
			error: rpcError(error),
		};
	}
}

function publicProbe(probe) {
	const { raw: _raw, ...safe } = probe;
	return safe;
}

if (!existsSync(runnerEntry)) {
	throw new Error(
		`runner build missing at ${runnerEntry}; run pnpm --filter flywheel-claude-runner build`,
	);
}

const runner = await import(runnerEntry);
const startedAt = new Date().toISOString();
const root = mkdtempSync(join(tmpdir(), "fly2211-529-attach-"));
const executionId = `qa529-fly2211-${Date.now().toString(36)}`;
const probeEnv = {
	...process.env,
	FLYWHEEL_STATE_DIR: join(root, "state"),
	FLYWHEEL_KILL_LEDGER_ROOT: join(root, "kill-ledger"),
	FLYWHEEL_CODEX_HOMES_ROOT: join(root, "codex-homes"),
};
process.env.FLYWHEEL_STATE_DIR = probeEnv.FLYWHEEL_STATE_DIR;
process.env.FLYWHEEL_KILL_LEDGER_ROOT = probeEnv.FLYWHEEL_KILL_LEDGER_ROOT;

const scratchRepo = join(root, "repo");
mkdirSync(scratchRepo, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: scratchRepo });
execFileSync("git", ["config", "user.email", "qa@flywheel.local"], {
	cwd: scratchRepo,
});
execFileSync("git", ["config", "user.name", "QA FLY-2211"], {
	cwd: scratchRepo,
});
writeFileSync(join(scratchRepo, "README.md"), "# FLY-2211 attach probe\n");
execFileSync("git", ["add", "README.md"], { cwd: scratchRepo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: scratchRepo });

const socketPath = join(root, "app.sock");
if (Buffer.byteLength(socketPath) >= 104) {
	throw new Error(`probe socket exceeds Darwin sun_path: ${socketPath}`);
}

const evidence = {
	issue: "FLY-2211",
	mode: "isolated-529-real-daemon",
	startedAt,
	executionId,
	codexVersion: execFileSync("codex", ["--version"], {
		encoding: "utf8",
	}).trim(),
	threadId: null,
	turnId: null,
	probes: {},
	observations: {},
	assessment: {},
	cleanup: {},
};

const clients = [];
let handle;
let codexHome;
let fatalError = null;
try {
	codexHome = runner.provisionCodexHome({
		executionId,
		env: probeEnv,
		ledgerRoot: join(root, "account-ledger"),
		trustedProjectPath: realpathSync(scratchRepo),
	});
	handle = await runner.spawnCodexDaemon({
		executionId,
		codexBin: runner.flywheelCodexBin(),
		codexHome,
		socketPath,
		sandboxWritableRoots: [realpathSync(scratchRepo)],
		sandboxNetworkAccess: false,
		env: probeEnv,
		logger: (message) => console.log(`[fly2211-probe] ${message}`),
	});

	const clientA = await RpcClient.connect(socketPath, "client-a");
	clients.push(clientA);
	await clientA.initialize();
	const startThread = await capture(clientA, "thread/start", {
		cwd: realpathSync(scratchRepo),
		// Match the production runner. A resident Codex sandbox cannot execute this
		// nested on macOS (sandbox_apply status 71); that environment limitation is
		// a valid blocked probe result, not a reason to weaken the acceptance rig.
		sandbox: "workspace-write",
		approvalPolicy: "never",
	});
	evidence.probes.threadStart = publicProbe(startThread);
	if (!startThread.ok)
		throw new Error(`thread/start failed: ${startThread.error}`);
	const threadId = extractThreadId(startThread.raw);
	if (!threadId) throw new Error("thread/start returned no thread id");
	evidence.threadId = threadId;

	const objective =
		"Without using tools, produce the requested numbered text and then complete the goal.";
	const kickText =
		"This is an isolated transport probe. Do not call any tool and do not access the filesystem. Produce exactly 200 numbered lines, each containing a distinct short description of transport continuity, then finish the goal.";
	const kickOperationId = `fly2211-kick-${Date.now().toString(36)}`;
	evidence.kickOperationId = kickOperationId;

	const setGoal = await capture(clientA, "thread/goal/set", {
		threadId,
		objective,
		status: "active",
	});
	evidence.probes.goalSet = publicProbe(setGoal);
	if (!setGoal.ok) throw new Error(`thread/goal/set failed: ${setGoal.error}`);

	const firstKick = await capture(clientA, "turn/start", {
		threadId,
		input: [{ type: "text", text: kickText }],
		clientUserMessageId: kickOperationId,
	});
	evidence.probes.firstKick = publicProbe(firstKick);
	if (!firstKick.ok) throw new Error(`turn/start failed: ${firstKick.error}`);
	const firstTurnId = extractTurnId(firstKick.raw);
	evidence.turnId = firstTurnId ?? null;

	clientA.close();
	await sleep(250);

	const clientB = await RpcClient.connect(socketPath, "client-b");
	clients.push(clientB);
	await clientB.initialize();
	const attachStartedAt = new Date().toISOString();
	evidence.attachStartedAt = attachStartedAt;

	const resume = await capture(clientB, "thread/resume", { threadId });
	const goalAtAttach = await capture(clientB, "thread/goal/get", { threadId });
	const readAtAttach = await capture(clientB, "thread/read", {
		threadId,
		includeTurns: true,
	});
	const threadList = await capture(clientB, "thread/list", { limit: 20 });
	const goalList = await capture(clientB, "thread/goal/list", {});
	const goalSubscribe = await capture(clientB, "thread/goal/subscribe", {
		threadId,
	});
	Object.assign(evidence.probes, {
		resumeLiveThread: publicProbe(resume),
		goalAtAttach: publicProbe(goalAtAttach),
		readAtAttach: publicProbe(readAtAttach),
		threadList: publicProbe(threadList),
		goalList: publicProbe(goalList),
		goalSubscribe: publicProbe(goalSubscribe),
	});

	const goalStatuses = [];
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const goal = await capture(
			clientB,
			"thread/goal/get",
			{ threadId },
			10_000,
		);
		if (goal.ok) {
			const status = goal.raw?.goal?.status;
			if (status && goalStatuses.at(-1) !== status) goalStatuses.push(status);
		}
		const terminal = [
			"complete",
			"blocked",
			"usageLimited",
			"budgetLimited",
		].includes(goal.raw?.goal?.status);
		if (terminal) {
			break;
		}
		await sleep(2_000);
	}

	const readBeforeDuplicate = await capture(clientB, "thread/read", {
		threadId,
		includeTurns: true,
	});
	const duplicateKick = await capture(clientB, "turn/start", {
		threadId,
		input: [{ type: "text", text: kickText }],
		clientUserMessageId: kickOperationId,
	});
	await sleep(1_000);
	const readAfterDuplicate = await capture(clientB, "thread/read", {
		threadId,
		includeTurns: true,
	});
	Object.assign(evidence.probes, {
		readBeforeDuplicate: publicProbe(readBeforeDuplicate),
		duplicateKick: publicProbe(duplicateKick),
		readAfterDuplicate: publicProbe(readAfterDuplicate),
	});

	const notificationMethods = clientB.notifications.map(
		(event) => event.method,
	);
	const goalNotificationCount = notificationMethods.filter((method) =>
		method.includes("goal"),
	).length;
	const readText = JSON.stringify(readBeforeDuplicate.raw ?? null);
	const duplicateTurnId = duplicateKick.ok
		? extractTurnId(duplicateKick.raw)
		: undefined;
	evidence.observations = {
		goalStatuses,
		clientBNotificationMethods: notificationMethods,
		clientBNotifications: clientB.notifications,
		goalNotificationCount,
		kickOperationIdDiscoverable: readText.includes(kickOperationId),
		firstTurnReceiptDiscoverable: firstTurnId
			? readText.includes(firstTurnId)
			: false,
		duplicateTurnId: duplicateTurnId ?? null,
	};
	const successorObservedFutureGoalEvent = goalNotificationCount > 0;
	const duplicateReturnedOriginalReceipt =
		Boolean(firstTurnId) && duplicateTurnId === firstTurnId;
	evidence.assessment = {
		liveThreadResumeAccepted:
			resume.ok && extractThreadId(resume.raw) === threadId,
		liveGoalQueryable:
			goalAtAttach.ok && goalAtAttach.raw?.goal?.objective === objective,
		successorObservedFutureGoalEvent,
		attachCanOwnLiveGoalLoop:
			resume.ok && goalAtAttach.ok && successorObservedFutureGoalEvent,
		durableKickOperationIdVisible:
			evidence.observations.kickOperationIdDiscoverable,
		duplicateReturnedOriginalReceipt,
		exactlyOnceKickSupported: duplicateReturnedOriginalReceipt,
		decision:
			resume.ok && goalAtAttach.ok && successorObservedFutureGoalEvent
				? "attach-adopt enhancement is technically viable"
				: "retain M1-M4 watch/revive; attach ownership is not proven",
	};
} catch (error) {
	fatalError = rpcError(error);
	evidence.fatalError = fatalError;
} finally {
	for (const client of clients) {
		try {
			client.close();
		} catch {
			// best effort; daemon group teardown below is authoritative
		}
	}
	if (handle) {
		try {
			handle.stop();
			evidence.cleanup.daemonConfirmedDead = await handle.ensureDead();
		} catch (error) {
			evidence.cleanup.daemonConfirmedDead = false;
			evidence.cleanup.error = rpcError(error);
		}
	}
	evidence.cleanup.socketGone = !existsSync(socketPath);
	runner.removeCodexHome(executionId, probeEnv);
	evidence.cleanup.codexHomeGone = codexHome ? !existsSync(codexHome) : true;
	evidence.finishedAt = new Date().toISOString();
}

const outputPath = resolve(
	argValue("--output") ??
		join(tmpdir(), `fly2211-attach-probe-${Date.now().toString(36)}.json`),
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
	mode: 0o600,
});
console.log(
	JSON.stringify(
		{
			outputPath,
			assessment: evidence.assessment,
			cleanup: evidence.cleanup,
			fatalError,
		},
		null,
		2,
	),
);

rmSync(root, { recursive: true, force: true });
const clean =
	evidence.cleanup.daemonConfirmedDead !== false &&
	evidence.cleanup.socketGone === true &&
	evidence.cleanup.codexHomeGone === true;
process.exitCode = fatalError || !clean ? 1 : 0;
