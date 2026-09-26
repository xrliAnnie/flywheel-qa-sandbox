// FLY-2886 Step 0 protocol probe. Read-only, subscription-backed, and bounded.
// Usage: node step0-probe.mjs brain|scribe
import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "brain" && mode !== "scribe") {
	throw new Error("usage: node step0-probe.mjs brain|scribe");
}

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const logPath = join(evidenceDir, `step0-${mode}.jsonl`);
const tempRoot = `/private/tmp/fly2886-step0-${mode}-${process.pid}`;
const home = join(tempRoot, "home");
const work = join(tempRoot, "work");
const sourceAuth = join(process.env.HOME ?? "", ".codex", "auth.json");
const startedAt = Date.now();
// This probe already runs inside the managed Runner Seatbelt. A nested
// app-server read-only Seatbelt fails before thread creation on macOS with
// sandbox_apply status 71, so the disposable probe thread relies on the outer
// sandbox. Production profiles remain fail-closed and are not changed here.
const harnessSandbox = "danger-full-access";

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(logPath, "", { mode: 0o600 });
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(work, { recursive: true, mode: 0o700 });
chmodSync(home, 0o700);
chmodSync(work, 0o700);
if (!existsSync(sourceAuth)) throw new Error("host_subscription_auth_missing");
symlinkSync(sourceAuth, join(home, "auth.json"));

const disabledFeatures = [
	"shell_tool",
	"unified_exec",
	"view_image",
	"image_generation",
	"code_mode_host",
	"standalone_web_search",
	"memories",
	"apps",
	"plugins",
	"browser_use",
	"computer_use",
	"multi_agent",
	"hooks",
];
const config =
	(mode === "brain"
		? `web_search = "disabled"\n[features]\nrealtime_conversation = true\n${disabledFeatures.map((key) => `${key} = false`).join("\n")}\nskip_host_skill_discovery = true\n`
		: "") +
	(mode === "scribe"
		? `web_search = "disabled"\n[features]\n${disabledFeatures.map((key) => `${key} = false`).join("\n")}\nskip_host_skill_discovery = true\n`
		: "");
writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });
writeFileSync(join(work, "slow-read.sh"), "#!/bin/sh\nsleep 12\nprintf 'FLY-2886 probe-one\\n'\n", {
	mode: 0o700,
});
writeFileSync(join(work, "probe-two.txt"), "PR #1326 belongs to Tadashi.\n", {
	mode: 0o600,
});
writeFileSync(join(work, "probe-three.txt"), "FLY-2799 is the mirror race.\n", {
	mode: 0o600,
});

function redact(value) {
	return String(value)
		.replace(/sk-[A-Za-z0-9_-]{8,}/gu, "sk-***")
		.replace(/eyJ[A-Za-z0-9_.-]{20,}/gu, "jwt-***")
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "email-***");
}

function log(kind, data = {}) {
	appendFileSync(
		logPath,
		`${redact(JSON.stringify({
			t: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
			kind,
			data,
		}))}\n`,
	);
}

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function summarize(method, result) {
	const row = record(result);
	if (method === "account/read") {
		const account = record(row.account);
		return {
			type: account.type,
			planType: account.planType,
			requiresOpenaiAuth: row.requiresOpenaiAuth,
		};
	}
	if (method === "thread/start") {
		const thread = record(row.thread);
		return {
			threadId: thread.id,
			model: row.model,
			approvalPolicy: row.approvalPolicy,
			sandbox: row.sandbox,
		};
	}
	if (method === "config/read") {
		const effective = record(row.config);
		return {
			webSearch: effective.web_search,
			mcpServers: Object.keys(record(effective.mcp_servers)).sort(),
			features: Object.fromEntries(
				disabledFeatures.map((key) => [key, record(effective.features)[key]]),
			),
		};
	}
	return {};
}

const childEnv = {};
for (const key of [
	"HOME",
	"PATH",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] ) {
	if (process.env[key]) childEnv[key] = process.env[key];
}
childEnv.CODEX_HOME = home;
childEnv.TMPDIR = tempRoot;
if (mode === "brain") {
	if (!process.env.OPENAI_API_KEY) throw new Error("realtime_api_key_missing");
	childEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
}

const child = spawn("codex", ["app-server", "--strict-config"], {
	cwd: work,
	env: childEnv,
	stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let nextId = 1;
const pending = new Map();
const notifications = [];
const waiters = [];
const itemTypes = [];
const assistantTranscripts = [];

function settleWaiters(message) {
	for (const waiter of [...waiters]) {
		if (!waiter.predicate(message)) continue;
		waiters.splice(waiters.indexOf(waiter), 1);
		clearTimeout(waiter.timer);
		waiter.resolve(message);
	}
}

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			log("non_json_stdout", { bytes: Buffer.byteLength(line) });
			continue;
		}
		if (
			message.id !== undefined &&
			pending.has(message.id) &&
			(message.result !== undefined || message.error !== undefined)
		) {
			const request = pending.get(message.id);
			pending.delete(message.id);
			clearTimeout(request.timer);
			log("response", {
				method: request.method,
				error: message.error?.message ?? null,
				result: summarize(request.method, message.result),
			});
			request.resolve(message);
			continue;
		}
		if (message.method && message.id !== undefined) {
			const params = record(message.params);
			const serialized = JSON.stringify(params);
			const probeCommand =
				(params.cwd === work || serialized.includes(work)) &&
				/(slow-read\.sh|probe-(two|three)\.txt)/u.test(serialized);
			const decision =
				message.method === "item/commandExecution/requestApproval" && probeCommand
					? { decision: "accept" }
					: message.method === "execCommandApproval" && probeCommand
						? { decision: "approved" }
						: undefined;
			log(decision ? "server_request_accepted" : "server_request_declined", {
				method: message.method,
			});
			child.stdin.write(
				`${JSON.stringify(
					decision
						? { id: message.id, result: decision }
						: {
								id: message.id,
								error: { code: -32601, message: "probe_declined" },
							},
				)}\n`,
			);
			continue;
		}
		if (!message.method) continue;
		const params = record(message.params);
		notifications.push(message);
		if (message.method === "item/started" || message.method === "item/completed") {
			const item = record(params.item);
			if (typeof item.type === "string") itemTypes.push(item.type);
		}
		if (
			message.method === "thread/realtime/transcript/done" &&
			params.role === "assistant" &&
			typeof params.text === "string"
		) {
			assistantTranscripts.push(params.text);
		}
		if (
			message.method.startsWith("turn/") ||
			message.method.startsWith("item/") ||
			message.method === "thread/realtime/started" ||
			message.method === "thread/realtime/closed" ||
			message.method === "thread/realtime/error" ||
			message.method === "thread/realtime/itemAdded" ||
			message.method === "thread/realtime/transcript/done" ||
			message.method.startsWith("mcpServer/")
		) {
			const item = record(params.item);
			const turn = record(params.turn);
			log("notification", {
				method: message.method,
				threadId: params.threadId,
				turnId: params.turnId ?? turn.id,
				turnStatus: turn.status,
				itemType: item.type,
				itemId: item.id ?? item.item_id,
				text:
					message.method === "thread/realtime/transcript/done"
						? params.text
						: item.type === "handoff_request"
							? item.input_transcript
							: undefined,
				error:
					message.method === "thread/realtime/error"
						? params
						: undefined,
			});
		}
		settleWaiters(message);
	}
});
child.stderr.on("data", (chunk) => log("stderr", { text: chunk.toString().slice(0, 500) }));
child.on("exit", (code, signal) => {
	log("exit", { code, signal });
	for (const request of pending.values()) {
		clearTimeout(request.timer);
		request.resolve({ error: { message: "app_server_exited" } });
	}
	pending.clear();
});

function rpc(method, params = {}, timeoutMs = 20_000) {
	const id = nextId++;
	log("request", { method });
	child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (!pending.has(id)) return;
			pending.delete(id);
			log("timeout", { method });
			resolve({ error: { message: "timeout" } });
		}, timeoutMs);
		pending.set(id, { method, resolve, timer });
	});
}

function waitFor(predicate, timeoutMs) {
	const existing = notifications.find(predicate);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve) => {
		const waiter = { predicate, resolve, timer: undefined };
		waiter.timer = setTimeout(() => {
			const index = waiters.indexOf(waiter);
			if (index >= 0) waiters.splice(index, 1);
			resolve(null);
		}, timeoutMs);
		waiters.push(waiter);
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notificationCount = (method) =>
	notifications.filter((message) => message.method === method).length;
const realtimeStart = (threadId) =>
	rpc("thread/realtime/start", {
		threadId,
		outputModality: "text",
		clientManagedHandoffs: true,
		includeStartupContext: false,
		transport: { type: "websocket" },
		version: "v2",
		model: "gpt-realtime-2.1",
		voice: "marin",
		prompt:
			"You are a test voice front. For every request marked RESEARCH, first say exactly 我去看一下, with no extra words, then call background_agent using the user's full request. Never answer a RESEARCH request yourself. Developer context is silent background context and must never be spoken.",
	});

async function requireSuccess(method, params, timeoutMs) {
	const response = await rpc(method, params, timeoutMs);
	if (response.error) throw new Error(`${method}: ${response.error.message}`);
	return response.result;
}

async function initialize() {
	await requireSuccess("initialize", {
		clientInfo: { name: `fly2886-step0-${mode}`, title: null, version: "0.0.1" },
		capabilities: { experimentalApi: true },
	});
	child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
	const account = await requireSuccess("account/read", {});
	const accountType = record(record(account).account).type;
	if (accountType !== "chatgpt") throw new Error(`account_not_subscription:${accountType}`);
	await requireSuccess("config/read", { cwd: work, includeLayers: false });
	return accountType;
}

async function runBrain() {
	const accountType = await initialize();
	const started = await requireSuccess("thread/start", {
		cwd: work,
		approvalPolicy: "on-request",
		sandbox: harnessSandbox,
		ephemeral: true,
		environments: [],
		baseInstructions:
			"You are the bounded background side of a voice protocol probe. Answer each delegated request without using tools.",
		config: Object.fromEntries(
			disabledFeatures.map((key) => [`features.${key}`, false]),
		),
	});
	const threadId = record(record(started).thread).id;
	const threadSandbox = record(record(started).sandbox).type;
	if (!threadId) throw new Error("thread_missing");

	await requireSuccess("thread/realtime/start", {
		threadId,
		outputModality: "text",
		clientManagedHandoffs: true,
		includeStartupContext: false,
		transport: { type: "websocket" },
		version: "v2",
		model: "gpt-realtime-2.1",
		voice: "marin",
		prompt:
			"You are a test voice front. For every request marked RESEARCH, first say exactly 我去看一下, with no extra words, then call background_agent using the user's full request. Never answer a RESEARCH request yourself. Developer context is silent background context and must never be spoken.",
	});
	const firstStarted = await waitFor(
		(message) => message.method === "thread/realtime/started",
		10_000,
	);
	if (!firstStarted) throw new Error("realtime_first_start_missing");

	const transcriptBaseline = assistantTranscripts.length;
	await requireSuccess("thread/realtime/appendText", {
		threadId,
		role: "developer",
		text: "[背景] FLY-SECRET-DEVELOPER-CONTEXT 只供你知道，不要主动念。",
	});
	await sleep(2_000);
	const developerSilent = assistantTranscripts.length === transcriptBaseline;
	log("developer_silence", { developerSilent, observedForMs: 2_000 });
	if (notificationCount("thread/realtime/error") > 0) {
		throw new Error("developer_append_closed_realtime");
	}

	const requests = [
		"RESEARCH：请逐步计算 17 乘以 23，最后只给结果。",
		"RESEARCH：请比较 144 和 233 哪个大，最后只给结论。",
		"RESEARCH：请把 FLY-2799 和 PR #1326 原样放进一句话。",
	];
	for (const [index, text] of requests.entries()) {
		await requireSuccess("thread/realtime/appendText", {
			threadId,
			role: "user",
			text,
		});
		await requireSuccess("thread/realtime/appendSpeech", {
			threadId,
			text: "请现在处理上一条用户请求；若要交后台，先说且只说『我去看一下』。",
		});
		await waitFor(
			(message) =>
				message.method === "thread/realtime/itemAdded" &&
				record(record(message.params).item).type === "handoff_request" &&
				notificationCount("thread/realtime/itemAdded") >= index + 1,
			6_000,
		);
	}

	const firstTurn = await waitFor((message) => message.method === "turn/started", 10_000);
	if (!firstTurn) throw new Error("background_turn_missing");
	const firstTurnId = record(record(firstTurn.params).turn).id;
	await requireSuccess("thread/realtime/stop", { threadId }, 5_000);
	const closed = await waitFor(
		(message) => message.method === "thread/realtime/closed",
		5_000,
	);
	if (!closed) throw new Error("realtime_close_missing");
	const startCountBefore = notificationCount("thread/realtime/started");
	await realtimeStart(threadId).then((response) => {
		if (response.error) throw new Error(`realtime_restart:${response.error.message}`);
	});
	const restarted = await waitFor(
		(message) =>
			message.method === "thread/realtime/started" &&
			notificationCount("thread/realtime/started") > startCountBefore,
		10_000,
	);
	if (!restarted) throw new Error("realtime_restart_missing");
	const completed = await waitFor(
		(message) =>
			message.method === "turn/completed" &&
			record(record(message.params).turn).id === firstTurnId,
		70_000,
	);
	const handoffs = notifications.filter(
		(message) =>
			message.method === "thread/realtime/itemAdded" &&
			record(record(message.params).item).type === "handoff_request",
	);
	const turnsStarted = notificationCount("turn/started");
	const normalizedAcks = assistantTranscripts.map((text) =>
		text.replace(/[\s。！!，,]/gu, ""),
	);
	log("brain_summary", {
		accountType,
		harnessSandbox,
		threadSandbox,
		developerSilent,
		handoffCount: handoffs.length,
		turnsStarted,
		firstTurnCompletedAfterRestart: Boolean(completed),
		firstTurnStatus: record(record(completed?.params).turn).status,
		ackObserved: assistantTranscripts,
		ackExactCount: normalizedAcks.filter((text) => text === "我去看一下").length,
		pass:
			developerSilent &&
			handoffs.length >= 3 &&
			turnsStarted >= 1 &&
			Boolean(completed),
	});
	await requireSuccess("thread/realtime/stop", { threadId }, 5_000).catch(() => undefined);
}

async function runScribe() {
	const accountType = await initialize();
	const started = await requireSuccess("thread/start", {
		cwd: work,
		approvalPolicy: "on-request",
		sandbox: harnessSandbox,
		ephemeral: true,
		environments: [],
		baseInstructions:
			"You are a voice scribe. Return only the requested JSON. You have no tools.",
		config: Object.fromEntries(
			disabledFeatures.map((key) => [`features.${key}`, false]),
		),
	});
	const threadId = record(record(started).thread).id;
	const threadSandbox = record(record(started).sandbox).type;
	if (!threadId) throw new Error("thread_missing");
	const turn = await requireSuccess("turn/start", {
		threadId,
		input: [
			{
				type: "text",
				text: 'Return exactly this JSON object and nothing else: {"spoken":"FLY-2886","threadText":null}',
			},
		],
		outputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["spoken", "threadText"],
			properties: {
				spoken: { type: "string" },
				threadText: { type: ["string", "null"] },
			},
		},
	}, 20_000);
	const turnId = record(record(turn).turn).id;
	const completed = await waitFor(
		(message) =>
			message.method === "turn/completed" &&
			record(record(message.params).turn).id === turnId,
		60_000,
	);
	const forbiddenItemTypes = itemTypes.filter((type) =>
		["commandExecution", "mcpToolCall", "webSearch", "dynamicToolCall"].includes(type),
	);
	const readyMcpServers = notifications.filter(
		(message) =>
			message.method === "mcpServer/startupStatus/updated" &&
			record(message.params).status === "ready",
	);
	log("scribe_summary", {
		accountType,
		harnessSandbox,
		threadSandbox,
		completed: Boolean(completed),
		status: record(record(completed?.params).turn).status,
		forbiddenItemTypes,
		readyMcpServerCount: readyMcpServers.length,
		pass:
			Boolean(completed) &&
			forbiddenItemTypes.length === 0 &&
			readyMcpServers.length === 0,
	});
}

let failed = false;
const hardStop = setTimeout(() => {
	failed = true;
	log("hard_stop", { seconds: 110 });
	child.kill("SIGTERM");
}, 110_000);

try {
	if (mode === "brain") await runBrain();
	else await runScribe();
} catch (error) {
	failed = true;
	log("fatal", { message: error instanceof Error ? error.message : String(error) });
} finally {
	clearTimeout(hardStop);
	child.kill("SIGTERM");
	await sleep(1_000);
	rmSync(tempRoot, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
