// FLY-2886 Step 0 protocol probe. Read-only, subscription-backed, and bounded.
// Usage: node step0-probe.mjs brain|scribe|user-context [1..5]|restart-context [1..3]
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
const experimentModes = new Set(["user-context", "restart-context"]);
if (
	mode !== "brain" &&
	mode !== "scribe" &&
	!experimentModes.has(mode)
) {
	throw new Error(
		"usage: node step0-probe.mjs brain|scribe|user-context [1..5]|restart-context [1..3]",
	);
}
const iteration = experimentModes.has(mode) ? Number(process.argv[3]) : undefined;
const maxIteration = mode === "user-context" ? 5 : 3;
if (
	experimentModes.has(mode) &&
	(!Number.isSafeInteger(iteration) || iteration < 1 || iteration > maxIteration)
) {
	throw new Error(`experiment iteration must be between 1 and ${maxIteration}`);
}
const realtimeMode = mode !== "scribe";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const runName = `${mode}${iteration === undefined ? "" : `-${iteration}`}`;
const logPath = join(evidenceDir, `step0-${runName}.jsonl`);
const tempRoot = `/private/tmp/fly2886-step0-${runName}-${process.pid}`;
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
	(realtimeMode
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
if (realtimeMode) {
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
		message.__probeAtMs = Date.now() - startedAt;
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

function waitForAfter(index, predicate, timeoutMs) {
	const existing = notifications.slice(index).find(predicate);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve) => {
		const waiter = { predicate, resolve, timer: undefined };
		waiter.timer = setTimeout(() => {
			const waiterIndex = waiters.indexOf(waiter);
			if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
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

async function startProbeThread(baseInstructions) {
	const started = await requireSuccess("thread/start", {
		cwd: work,
		approvalPolicy: "on-request",
		sandbox: harnessSandbox,
		ephemeral: true,
		environments: [],
		baseInstructions,
		config: Object.fromEntries(
			disabledFeatures.map((key) => [`features.${key}`, false]),
		),
	});
	const threadId = record(record(started).thread).id;
	if (!threadId) throw new Error("thread_missing");
	return {
		threadId,
		threadSandbox: record(record(started).sandbox).type,
	};
}

async function startRealtimeSession(threadId, prompt, outputModality = "audio") {
	const baseline = notifications.length;
	await requireSuccess("thread/realtime/start", {
		threadId,
		outputModality,
		clientManagedHandoffs: true,
		includeStartupContext: false,
		transport: { type: "websocket" },
		version: "v2",
		model: "gpt-realtime-2.1",
		voice: "marin",
		prompt,
	});
	const started = await waitForAfter(
		baseline,
		(message) => message.method === "thread/realtime/started",
		10_000,
	);
	if (!started) throw new Error("realtime_start_missing");
	return started;
}

function realtimeItem(message) {
	return record(record(message.params).item);
}

function assistantTranscript(message) {
	return (
		message.method === "thread/realtime/transcript/done" &&
		record(message.params).role === "assistant"
	);
}

async function stopRealtime(threadId) {
	const baseline = notifications.length;
	await requireSuccess("thread/realtime/stop", { threadId }, 5_000);
	const closed = await waitForAfter(
		baseline,
		(message) => message.method === "thread/realtime/closed",
		5_000,
	);
	if (!closed) throw new Error("realtime_close_missing");
	return closed;
}

async function runUserContext() {
	const accountType = await initialize();
	const { threadId, threadSandbox } = await startProbeThread(
		"You are the bounded background side of a voice layer-3 protocol probe. You have no tools.",
	);
	const prompt =
		"You are a concise test voice front. Text beginning [旁注,勿回应] is application context, not a user utterance: never speak, answer, paraphrase, or delegate because of it. Wait for a later message beginning 真正用户问题 before responding. For a 真正用户问题, answer only that question in one short phrase.";
	await startRealtimeSession(threadId, prompt, "audio");

	const contextMarker = `FLY-2886-CONTEXT-${iteration}`;
	const contextText =
		`[旁注,勿回应] 这是应用同步背景，不是 founder 的新发言；只供你知道，不要为它开口、回答、复述或交后台。` +
		`此刻状态：${contextMarker} 正在 implement；PR #1326 等待复核；Tadashi 正在处理；runner 222a4861-17d5-478d-a5f0-430e4d6d46b0 仍在运行。` +
		"如果随后有真正用户问题，只回答那个问题，不要主动提起本旁注。";
	if (contextText.length > 600) throw new Error("context_probe_too_large");

	const contextBaseline = notifications.length;
	await requireSuccess("thread/realtime/appendText", {
		threadId,
		role: "user",
		text: contextText,
	});
	await sleep(4_000);
	const contextEvents = notifications.slice(contextBaseline);
	const unsolicited = contextEvents.filter((message) => {
		const item = realtimeItem(message);
		return (
			assistantTranscript(message) ||
			message.method === "thread/realtime/outputAudio/delta" ||
			(message.method === "thread/realtime/itemAdded" &&
				(item.role === "assistant" || item.type === "handoff_request"))
		);
	});
	const contextErrors = contextEvents.filter(
		(message) =>
			message.method === "thread/realtime/error" ||
			message.method === "thread/realtime/closed",
	);

	const answerBaseline = notifications.length;
	await requireSuccess("thread/realtime/appendText", {
		threadId,
		role: "user",
		text: "真正用户问题：二加二等于几？只回答一个数字。",
	});
	await requireSuccess("thread/realtime/appendSpeech", {
		threadId,
		text: "请回答上一条真正用户问题。",
	});
	const answerEvent = await waitForAfter(
		answerBaseline,
		assistantTranscript,
		15_000,
	);
	const answer =
		typeof record(answerEvent?.params).text === "string"
			? record(answerEvent.params).text
			: "";
	const normalizedAnswer = answer.replace(/[\s。！!，,]/gu, "");
	const didNotLeakContext =
		!answer.includes(contextMarker) &&
		!answer.includes("PR #1326") &&
		!answer.includes("Tadashi") &&
		!answer.includes("222a4861");
	const answeredQuestion = normalizedAnswer === "4" || normalizedAnswer === "四";
	log("user_context_summary", {
		iteration,
		accountType,
		harnessSandbox,
		threadSandbox,
		contextChars: contextText.length,
		observationMs: 4_000,
		unsolicitedSignals: unsolicited.map((message) => ({
			method: message.method,
			itemType: realtimeItem(message).type,
			role: realtimeItem(message).role,
		})),
		contextErrors: contextErrors.map((message) => message.method),
		answer,
		answeredQuestion,
		didNotLeakContext,
		pass:
			unsolicited.length === 0 &&
			contextErrors.length === 0 &&
			answeredQuestion &&
			didNotLeakContext,
	});
	await stopRealtime(threadId);
}

async function runRestartContext() {
	const accountType = await initialize();
	const { threadId, threadSandbox } = await startProbeThread(
		"You are the bounded background side of a voice restart protocol probe. You have no tools.",
	);
	const oldPrompt =
		"You are a concise test voice front. Answer messages beginning 真正用户问题 directly, with no handoff and no extra detail.";
	await startRealtimeSession(threadId, oldPrompt, "audio");

	const continuityToken = `ORBIT-${iteration}`;
	let baseline = notifications.length;
	await requireSuccess("thread/realtime/appendText", {
		threadId,
		role: "user",
		text: `真正用户问题：请记住我的口令是 ${continuityToken}，然后只回答「收到」。`,
	});
	await requireSuccess("thread/realtime/appendSpeech", {
		threadId,
		text: "请回答上一条真正用户问题。",
	});
	const firstAnswerEvent = await waitForAfter(
		baseline,
		assistantTranscript,
		15_000,
	);
	const firstAnswer =
		typeof record(firstAnswerEvent?.params).text === "string"
			? record(firstAnswerEvent.params).text
			: "";
	await sleep(1_000);

	const restartRequestedAtMs = Date.now() - startedAt;
	const outputActiveAtStop = notifications.some(
		(message) =>
			message.method === "thread/realtime/outputAudio/delta" &&
			typeof message.__probeAtMs === "number" &&
			message.__probeAtMs >= restartRequestedAtMs - 500,
	);
	const closed = await stopRealtime(threadId);
	const refreshedPrompt =
		"You are a concise test voice front. Preserve the preceding conversation. New application background: the current review is PR #1326 for FLY-2886 and Tadashi owns it. Answer messages beginning 真正用户问题 directly, using both prior conversation and this refreshed background; do not add other detail.";
	const restarted = await startRealtimeSession(
		threadId,
		refreshedPrompt,
		"audio",
	);
	const restartReadyMs = restarted.__probeAtMs - restartRequestedAtMs;
	const closedToStartedMs = restarted.__probeAtMs - closed.__probeAtMs;

	baseline = notifications.length;
	await requireSuccess("thread/realtime/appendText", {
		threadId,
		role: "user",
		text: "真正用户问题：刚才的口令和新背景里的 PR 号分别是什么？只回答这两个字段。",
	});
	await requireSuccess("thread/realtime/appendSpeech", {
		threadId,
		text: "请回答上一条真正用户问题。",
	});
	const secondAnswerEvent = await waitForAfter(
		baseline,
		assistantTranscript,
		15_000,
	);
	const secondAnswer =
		typeof record(secondAnswerEvent?.params).text === "string"
			? record(secondAnswerEvent.params).text
			: "";
	const continuityPreserved = secondAnswer.includes(continuityToken);
	const refreshedPromptApplied = secondAnswer.includes("PR #1326");
	const errors = notifications.filter(
		(message) => message.method === "thread/realtime/error",
	);
	log("restart_context_summary", {
		iteration,
		accountType,
		harnessSandbox,
		threadSandbox,
		firstAnswer,
		secondAnswer,
		restartReadyMs,
		closedToStartedMs,
		outputActiveAtStop,
		directFounderAudibleObservation: false,
		continuityPreserved,
		refreshedPromptApplied,
		errorCount: errors.length,
		pass:
			firstAnswer.includes("收到") &&
			!outputActiveAtStop &&
			continuityPreserved &&
			refreshedPromptApplied &&
			errors.length === 0,
	});
	await stopRealtime(threadId);
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
	else if (mode === "scribe") await runScribe();
	else if (mode === "user-context") await runUserContext();
	else await runRestartContext();
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
