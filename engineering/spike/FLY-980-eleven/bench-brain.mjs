// FLY-980 V4(shim 侧口径) — claude -p 脑首 token 延迟矩阵,本地实测,不碰
// ElevenLabs(订阅 $0)。每配置起独立 shim 子进程,同一会话连打 N 轮,客户端计
// 「请求发出→首 content delta」;server 侧 first_delta 由 shim jsonl 另存。
// 全链 speech-end→首音口径 = 平台真机(S4)补齐;本脚本产出的是分解归因表里的
// 「脑首 token」列。
// usage: node bench-brain.mjs [--turns 6] [--configs haiku-resume,haiku-fresh,...]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : dflt;
};
const TURNS = Number(opt("turns", 6));
const TOKEN = "bench-local";
const PORT = 8985;

const ALL_CONFIGS = {
	"haiku-resume": { FLY980_MODEL: "haiku", FLY980_RESUME: "1" },
	"haiku-fresh": { FLY980_MODEL: "haiku", FLY980_RESUME: "0" },
	"sonnet-resume": { FLY980_MODEL: "sonnet", FLY980_RESUME: "1" },
	"sonnet-fresh": { FLY980_MODEL: "sonnet", FLY980_RESUME: "0" },
	"haiku-resume-nothink": {
		FLY980_MODEL: "haiku",
		FLY980_RESUME: "1",
		MAX_THINKING_TOKENS: "0",
	},
	"opus-resume": { FLY980_MODEL: "opus", FLY980_RESUME: "1", turns: 2 },
};
const configNames = opt("configs", Object.keys(ALL_CONFIGS).join(",")).split(
	",",
);

const QUESTIONS = [
	"链路通了吗？一句话确认。",
	"今天团队最重要的一件事是什么？",
	"帮我想想语音会议最大的风险点。",
	"FLY-980 是做什么的？",
	"你觉得延迟多少毫秒以内算好用？",
	"用一句话总结我们刚才聊的内容。",
];
const PERSONA =
	"你是 Tadashi，Flywheel 的工程 Lead。说话简短口语化，不用 markdown。";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy() {
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/health`);
			if (r.ok) return;
		} catch {
			// not up yet
		}
		await sleep(100);
	}
	throw new Error("shim did not become healthy");
}

async function runTurn(messages) {
	const t0 = Date.now();
	const res = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			stream: true,
			messages,
			elevenlabs_extra_body: { conversation_id: "bench" },
		}),
	});
	if (!res.ok) throw new Error(`http ${res.status}`);
	let firstContentMs = null;
	let text = "";
	let buf = "";
	const decoder = new TextDecoder();
	for await (const chunk of res.body) {
		buf += decoder.decode(chunk, { stream: true });
		let idx = buf.indexOf("\n\n");
		while (idx >= 0) {
			const block = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 2);
			idx = buf.indexOf("\n\n");
			if (!block.startsWith("data: ") || block === "data: [DONE]") continue;
			let obj;
			try {
				obj = JSON.parse(block.slice(6));
			} catch {
				continue;
			}
			const delta = obj.choices?.[0]?.delta?.content;
			if (delta) {
				if (firstContentMs === null) firstContentMs = Date.now() - t0;
				text += delta;
			}
		}
	}
	return { firstContentMs, totalMs: Date.now() - t0, text };
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
};

mkdirSync("out", { recursive: true });
const summary = [];
for (const name of configNames) {
	const cfg = ALL_CONFIGS[name];
	if (!cfg) {
		console.error(`unknown config ${name}`);
		continue;
	}
	const turns = cfg.turns ?? TURNS;
	const env = {
		...process.env,
		FLY980_BRAIN: "claude",
		FLY980_TOKEN: TOKEN,
		...Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== "turns")),
	};
	const shim = spawn("node", ["shim.mjs", String(PORT)], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	shim.stdout.on("data", () => {});
	shim.stderr.on("data", (d) => process.stderr.write(`[shim] ${d}`));
	try {
		await waitHealthy();
		const rows = [];
		const history = [];
		for (let i = 0; i < turns; i++) {
			const q = QUESTIONS[i % QUESTIONS.length];
			const messages = [
				{ role: "system", content: PERSONA },
				...history,
				{ role: "user", content: q },
			];
			const r = await runTurn(messages);
			rows.push(r);
			history.push(
				{ role: "user", content: q },
				{ role: "assistant", content: r.text || "(空)" },
			);
			console.error(
				`[${name}] turn${i + 1} first=${r.firstContentMs}ms total=${r.totalMs}ms "${(r.text ?? "").slice(0, 30)}"`,
			);
		}
		const later = rows.slice(1); // turn1 = 会话建立轮,单列
		summary.push({
			config: name,
			turns: rows.map((r) => ({
				first_ms: r.firstContentMs,
				total_ms: r.totalMs,
			})),
			turn1_first_ms: rows[0]?.firstContentMs ?? null,
			median_first_ms_turns2plus: median(
				later.map((r) => r.firstContentMs).filter((x) => x !== null),
			),
			median_total_ms_turns2plus: median(
				later.map((r) => r.totalMs).filter((x) => x !== null),
			),
		});
	} catch (err) {
		summary.push({ config: name, error: String(err?.message ?? err) });
		console.error(`[${name}] ERROR ${err?.message ?? err}`);
	} finally {
		shim.kill("SIGKILL");
		await sleep(300);
	}
}
writeFileSync("out/bench-brain.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
