// FLY-980 V4 追加(Lead 指令②) — 常驻脑/预热能否把 claude -p 首 token 拉进
// 1-2s。三形态对比(本地,订阅侧 $0):
//   persistent — 单进程 --input-format stream-json 常驻,多轮走 stdin JSONL
//                (无每轮 spawn/session 加载)
//   prespawn   — 每轮仍 spawn,但提前 N ms 起进程(CLI 冷启动在用户说话时已付),
//                说话结束才写 prompt;测「写入→首 text_delta」
//   (baseline = bench-brain.mjs 已测: spawn+立即写)
// usage: node bench-warm.mjs [--model sonnet] [--turns 5] [--warmup 2500]
//        [--modes persistent,prespawn]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : dflt;
};
const MODEL = opt("model", "sonnet");
const TURNS = Number(opt("turns", 5));
const WARMUP_MS = Number(opt("warmup", 2500));
const MODES = opt("modes", "persistent,prespawn").split(",");
const CLAUDE_BIN =
	process.env.FLY980_CLAUDE_BIN ?? join(homedir(), ".local/bin/claude");
const CWD = join(homedir(), "fly980-eleven", "cwd-empty");

const PERSONA =
	"你是 Tadashi，Flywheel 的工程 Lead。说话简短口语化，不用 markdown。";
const QUESTIONS = [
	"链路通了吗？一句话确认。",
	"今天团队最重要的一件事是什么？",
	"帮我想想语音会议最大的风险点。",
	"FLY-980 是做什么的？",
	"你觉得延迟多少毫秒以内算好用？",
];
const VOICE_CONTEXT =
	"你在语音频道和 founder 对话。回答要短、口语化。你没有任何工具,只能讨论不能执行。";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
};

// 逐行解析 stream-json,回调每个对象
function lineReader(stream, onObj) {
	let buf = "";
	stream.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let idx = buf.indexOf("\n");
		while (idx >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			idx = buf.indexOf("\n");
			if (!line) continue;
			try {
				onObj(JSON.parse(line));
			} catch {
				// 非 JSON 行忽略
			}
		}
	});
}

const results = {};

if (MODES.includes("persistent")) {
	console.error(`[persistent] spawning single ${MODEL} process...`);
	const args = [
		"-p",
		"--tools",
		"",
		"--strict-mcp-config",
		"--append-system-prompt",
		`${PERSONA}\n${VOICE_CONTEXT}`,
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		"--verbose",
		"--model",
		MODEL,
	];
	const tSpawn = Date.now();
	const child = spawn(CLAUDE_BIN, args, {
		cwd: CWD,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));
	let turnState = null;
	let initMs = null;
	lineReader(child.stdout, (obj) => {
		if (initMs === null) initMs = Date.now() - tSpawn;
		const ev = obj.event;
		if (
			turnState &&
			ev?.type === "content_block_delta" &&
			ev.delta?.type === "text_delta"
		) {
			if (turnState.firstMs === null) {
				turnState.firstMs = Date.now() - turnState.t0;
			}
			turnState.text += ev.delta.text;
		}
		if (turnState && obj.type === "result") {
			turnState.done(Date.now() - turnState.t0);
		}
	});
	const rows = [];
	// 等进程就绪(首个 system 事件)
	while (initMs === null && Date.now() - tSpawn < 15000) await sleep(50);
	console.error(`[persistent] init event at ${initMs}ms after spawn`);
	for (let i = 0; i < TURNS; i++) {
		const totalMs = await new Promise((resolve) => {
			turnState = { t0: Date.now(), firstMs: null, text: "", done: resolve };
			child.stdin.write(
				`${JSON.stringify({
					type: "user",
					message: {
						role: "user",
						content: [{ type: "text", text: QUESTIONS[i % QUESTIONS.length] }],
					},
				})}\n`,
			);
			setTimeout(() => resolve(-1), 60_000); // 兜底超时
		});
		rows.push({
			first_ms: turnState.firstMs,
			total_ms: totalMs,
			text: turnState.text.slice(0, 40),
		});
		console.error(
			`[persistent] turn${i + 1} first=${turnState.firstMs}ms total=${totalMs}ms "${turnState.text.slice(0, 30)}"`,
		);
		turnState = null;
		await sleep(400);
	}
	child.kill("SIGKILL");
	results.persistent = {
		model: MODEL,
		init_ms: initMs,
		turns: rows,
		median_first_ms: median(
			rows.map((r) => r.first_ms).filter((x) => x !== null),
		),
	};
}

// prespawn: 每轮 spawn 但提前起进程;两个子形态 ——
//   prespawn       = turn2+ 用 --resume(session 状态)
//   prespawn-fresh = 每轮全新会话,历史以文本注入 prompt(FLY980_RESUME=0 语义)
for (const mode of ["prespawn", "prespawn-fresh"]) {
	if (!MODES.includes(mode)) continue;
	const fresh = mode === "prespawn-fresh";
	console.error(`[${mode}] warmup=${WARMUP_MS}ms model=${MODEL}`);
	const rows = [];
	let sessionId = null;
	const historyLines = [];
	for (let i = 0; i < TURNS; i++) {
		const args = ["-p", "--tools", "", "--strict-mcp-config"];
		if (!fresh && sessionId) {
			args.push("--resume", sessionId);
		} else {
			args.push("--append-system-prompt", `${PERSONA}\n${VOICE_CONTEXT}`);
		}
		args.push(
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--verbose",
			"--model",
			MODEL,
		);
		const child = spawn(CLAUDE_BIN, args, {
			cwd: CWD,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let firstMs = null;
		let text = "";
		let sawInit = false;
		let t0 = null;
		const donePromise = new Promise((resolve) => {
			lineReader(child.stdout, (obj) => {
				sawInit = true;
				if (typeof obj.session_id === "string") sessionId = obj.session_id;
				const ev = obj.event;
				if (
					t0 !== null &&
					ev?.type === "content_block_delta" &&
					ev.delta?.type === "text_delta"
				) {
					if (firstMs === null) firstMs = Date.now() - t0;
					text += ev.delta.text;
				}
				if (obj.type === "result") resolve(null);
			});
			child.on("exit", () => resolve(null));
			setTimeout(() => resolve(null), 90_000);
		});
		// 预热窗口: 模拟「用户还在说话」——进程先起着,不给 prompt
		await sleep(WARMUP_MS);
		const q = QUESTIONS[i % QUESTIONS.length];
		let prompt = q;
		if (fresh && historyLines.length > 0) {
			prompt = `<conversation-so-far>\n${historyLines.join("\n")}\n</conversation-so-far>\n\nFounder (now): ${q}\n\nYou (spoken reply):`;
		}
		t0 = Date.now();
		child.stdin.end(prompt);
		await donePromise;
		const totalMs = Date.now() - t0;
		if (fresh) {
			historyLines.push(`Founder: ${q}`, `You: ${text || "(空)"}`);
		}
		rows.push({
			first_ms: firstMs,
			total_ms: totalMs,
			saw_init_before_prompt: sawInit,
		});
		console.error(
			`[${mode}] turn${i + 1} first=${firstMs}ms total=${totalMs}ms initBeforePrompt=${sawInit} "${text.slice(0, 30)}"`,
		);
		child.kill("SIGKILL");
		await sleep(300);
	}
	results[mode] = {
		model: MODEL,
		warmup_ms: WARMUP_MS,
		turns: rows,
		median_first_ms: median(
			rows.map((r) => r.first_ms).filter((x) => x !== null),
		),
	};
}

mkdirSync("out", { recursive: true });
writeFileSync("out/bench-warm.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
