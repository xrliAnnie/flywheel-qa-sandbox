#!/usr/bin/env node
/**
 * FLY-1443 · 语音 demo —— 你说话,它出声回你。
 *
 *   node demo-voice.mjs
 *
 * 说明:
 *   - 参数已锁死在实测可用的组合(v2 / websocket / v2 声线),你不需要改任何东西。
 *   - 用你现有的 codex 登录(订阅额度),不需要配置 API key。
 *   - 数据去向:脚本在本机跑,但**你的麦克风音频 / 打字内容会发送到 Codex(OpenAI)的
 *     realtime 服务**去做识别和回话 —— 这是语音会话的必要环节,不是本机处理。
 *     临时 wav 只落在本机的私有临时目录,跑完即删。
 *   - 跑完自动清理,不留后台进程。
 *
 * 基于 evidence/probe.mjs(FLY-1443 验证脚本)改写:输入从"合成音频文件"换成"你的麦克风",
 * 输出从"存成 wav"换成"直接放出来听"。协议链路与已验证的探针完全一致。
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ── 锁死的参数(实测可用组合,不要改)──────────────────────────
const VERSION = "v2";
const VOICE = "marin"; // v2 声线组;v1 那组配不上 v2
const MODALITY = "audio";
const SAMPLE_RATE = 24000;
const RECORD_SECONDS = Number(process.env.DEMO_SECONDS || 6);
// 打字模式:不用麦克风,敲一句话让它念出来(纯听音质用)
const TYPE_MODE =
	process.argv.includes("--type") || process.env.DEMO_TYPE === "1";

// 私有临时目录(0700 随机名)。共享的 /tmp 里用可预测文件名会被同机他人预放 symlink
// 劫持写入,所以这里用 mkdtemp 建专属目录,跑完整个删掉。
const TMP_DIR = mkdtempSync(join(tmpdir(), "fly1443-demo-"));
const IN_WAV = join(TMP_DIR, "in.wav");
const OUT_WAV = join(TMP_DIR, "out.wav");

const say = (s) => console.log(s);
const die = (msg, hint) => {
	console.error(`\n❌ ${msg}`);
	if (hint) console.error(`\n👉 ${hint}\n`);
	cleanup();
	process.exit(1);
};

function cleanup() {
	try {
		rmSync(TMP_DIR, { recursive: true, force: true });
	} catch {}
	try {
		child?.stdin?.end();
	} catch {}
	try {
		child?.kill("SIGKILL");
	} catch {}
}
process.on("SIGINT", () => {
	say("\n\n已中断,正在清理…");
	cleanup();
	process.exit(130);
});

// ── 开跑前的体检(所有失败都给人话,不甩栈)────────────────────
function which(bin) {
	const r = spawnSync("/usr/bin/which", [bin], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : null;
}

const codexPath = which("codex");
if (!codexPath)
	die(
		"找不到 codex 命令。",
		"这台机器上应该装了 codex;如果换过机器,先装好再跑。",
	);

// 录音工具:macOS 没有自带的命令行录音器,sox 或 ffmpeg 二选一
const sox = which("rec") || which("sox");
const ffmpeg = which("ffmpeg");
if (!TYPE_MODE && !sox && !ffmpeg) {
	die(
		"缺一个录音工具(macOS 没有自带的命令行录音器)。",
		"跑一句就好:  brew install sox\n   装完再跑这个 demo。",
	);
}
const afplay = which("afplay");
if (!afplay)
	die(
		"找不到 afplay(macOS 自带的播放器)。",
		"这个通常是系统自带的;如果没有,可以用别的播放器打开生成的 wav。",
	);

// ── 麦克风设备 ──────────────────────────────────────────────
// 这台机器上可能挂着好几个输入(内置麦、显示器、外接麦)。默认用 0,
// 但先列出来给你看 —— 免得你戴着耳麦说话、它却在录内置麦。
function listMics() {
	if (!ffmpeg) return [];
	const r = spawnSync(
		ffmpeg,
		["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
		{ encoding: "utf8" },
	);
	const out = `${r.stderr || ""}`;
	const seg = out.split("AVFoundation audio devices:")[1] || "";
	return [...seg.matchAll(/\[(\d+)\]\s+(.+)/g)].map((m) => ({
		index: m[1],
		name: m[2].trim(),
	}));
}
const MIC = process.env.DEMO_MIC || "0";

// ── 录音 ────────────────────────────────────────────────────
function record(seconds) {
	if (sox) {
		const bin = which("rec") ? "rec" : "sox";
		const args = which("rec")
			? [
					"-q",
					"-c",
					"1",
					"-r",
					String(SAMPLE_RATE),
					"-b",
					"16",
					"-e",
					"signed-integer",
					IN_WAV,
					"trim",
					"0",
					String(seconds),
				]
			: [
					"-q",
					"-d",
					"-c",
					"1",
					"-r",
					String(SAMPLE_RATE),
					"-b",
					"16",
					"-e",
					"signed-integer",
					IN_WAV,
					"trim",
					"0",
					String(seconds),
				];
		const r = spawnSync(bin, args, {
			stdio: ["ignore", "ignore", "pipe"],
			encoding: "utf8",
		});
		if (r.status !== 0)
			die(
				`录音失败(${bin})。`,
				`多半是麦克风权限没给终端。\n   系统设置 → 隐私与安全性 → 麦克风 → 勾上你的终端 App,然后重跑。\n\n原始输出:${(r.stderr || "").trim().slice(0, 300)}`,
			);
	} else {
		const r = spawnSync(
			ffmpeg,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"avfoundation",
				"-i",
				`:${MIC}`,
				"-ar",
				String(SAMPLE_RATE),
				"-ac",
				"1",
				"-sample_fmt",
				"s16",
				"-t",
				String(seconds),
				"-y",
				IN_WAV,
			],
			{ stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
		);
		if (r.status !== 0)
			die(
				"录音失败(ffmpeg)。",
				`多半是麦克风权限没给终端。\n   系统设置 → 隐私与安全性 → 麦克风 → 勾上你的终端 App,然后重跑。\n\n原始输出:${(r.stderr || "").trim().slice(0, 300)}`,
			);
	}
	if (!existsSync(IN_WAV))
		die(
			"录音文件没生成。",
			"再试一次;还是不行就把上面的原始输出发给 Honey Lemon。",
		);
}

/** 正确解析 RIFF chunk —— 不能假设头是 44 字节(系统工具会插填充块) */
function wavData(buf) {
	if (
		buf.subarray(0, 4).toString() !== "RIFF" ||
		buf.subarray(8, 12).toString() !== "WAVE"
	)
		throw new Error("not RIFF/WAVE");
	let off = 12,
		fmt = null;
	while (off + 8 <= buf.length) {
		const id = buf.subarray(off, off + 4).toString();
		const size = buf.readUInt32LE(off + 4);
		const body = off + 8;
		if (id === "fmt ")
			fmt = {
				channels: buf.readUInt16LE(body + 2),
				sampleRate: buf.readUInt32LE(body + 4),
				bits: buf.readUInt16LE(body + 14),
			};
		if (id === "data") return { pcm: buf.subarray(body, body + size), fmt };
		off = body + size + (size & 1);
	}
	throw new Error("no data chunk");
}

// ── 起 codex app-server(两道门必须同时开)────────────────────
const CODEX = realpathSync(codexPath);
const child = spawn(
	CODEX,
	["--enable", "realtime_conversation", "app-server"],
	{ stdio: ["pipe", "pipe", "pipe"] },
);

let stdoutBuf = "";
const waiters = new Map();
const events = [];
const audioOut = [];
let lastError = null;

child.stdout.on("data", (d) => {
	stdoutBuf += d.toString();
	let nl = stdoutBuf.indexOf("\n");
	for (; nl >= 0; nl = stdoutBuf.indexOf("\n")) {
		const line = stdoutBuf.slice(0, nl).trim();
		stdoutBuf = stdoutBuf.slice(nl + 1);
		if (!line) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.method === "thread/realtime/outputAudio/delta") {
			const p = m.params || {};
			audioOut.push(
				Buffer.from(p.audio?.data ?? p.data ?? p.delta ?? "", "base64"),
			);
			continue;
		}
		if (m.method === "thread/realtime/transcript/done") {
			const role = m.params?.role,
				text = m.params?.text;
			if (role === "user" && text) say(`\n📝 它听到你说:「${text}」`);
			if (role === "assistant" && text) say(`💬 它的回答:「${text}」`);
			continue;
		}
		if (m.method?.startsWith("thread/realtime/")) events.push(m);
		if (m.method === "thread/realtime/error")
			lastError = m.params?.message || "unknown";
		if (m.id !== undefined && waiters.has(m.id)) {
			waiters.get(m.id)(m);
			waiters.delete(m.id);
		}
	}
});
// biome 不允许把控制字符直接写进正则字面量,所以用构造函数拼(ESC = \u001b)
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s) => s.replace(ANSI_RE, "");
child.stderr.on("data", (d) => {
	const s = stripAnsi(d.toString()).trim();
	if (/Voice session access denied/i.test(s))
		lastError = "Voice session access denied";
});

let nextId = 1;
function send(method, params) {
	const id = nextId++;
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
	);
	return new Promise((r) => {
		waiters.set(id, r);
		setTimeout(() => {
			if (waiters.has(id)) {
				waiters.delete(id);
				r({ __timeout: true });
			}
		}, 30000);
	});
}
const notify = (m, p) =>
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", method: m, params: p })}\n`,
	);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitStart(timeoutMs = 25000) {
	const t0 = Date.now();
	return new Promise((resolve) => {
		const tick = () => {
			const ev = events.find(
				(e) =>
					e.method === "thread/realtime/started" ||
					e.method === "thread/realtime/error",
			);
			if (ev)
				return resolve(
					ev.method === "thread/realtime/started" ? "started" : "error",
				);
			if (Date.now() - t0 > timeoutMs) return resolve("timeout");
			setTimeout(tick, 100);
		};
		tick();
	});
}

const ask = (q) =>
	new Promise((res) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(q, (a) => {
			rl.close();
			res(a);
		});
	});

async function main() {
	say(
		TYPE_MODE
			? "\n⌨️  FLY-1443 语音 demo(打字模式)— 你打字,它念出来\n"
			: "\n🎙️  FLY-1443 语音 demo — 你说话,它出声回你\n",
	);
	if (!TYPE_MODE)
		say(
			"   不想开口?加 --type 就变成打字模式(不用麦克风):node demo-voice.mjs --type\n",
		);
	say("   参数已锁死在实测可用的组合,你不用改任何东西。");
	if (!TYPE_MODE)
		say(
			`   录音时长:${RECORD_SECONDS} 秒(想改:DEMO_SECONDS=10 node demo-voice.mjs)`,
		);
	const mics = TYPE_MODE ? [] : listMics();
	if (mics.length) {
		const cur = mics.find((m) => m.index === String(MIC));
		say(`   麦克风:[${MIC}] ${cur ? cur.name : "(索引不在列表里)"}`);
		if (mics.length > 1) {
			say(
				`   其他可选:${mics
					.filter((m) => m.index !== String(MIC))
					.map((m) => `[${m.index}] ${m.name}`)
					.join("  ")}`,
			);
			say(`   换一个:DEMO_MIC=2 node demo-voice.mjs`);
		}
	}
	say("");

	// 建会话(两道门:命令行 --enable + initialize 的 experimentalApi)
	await send("initialize", {
		clientInfo: {
			name: "fly1443-demo",
			title: "FLY-1443 voice demo",
			version: "1.0.0",
		},
		capabilities: { experimentalApi: true },
	});
	notify("initialized", {});
	await sleep(400);

	const th = await send("thread/start", {});
	const threadId = th?.result?.thread?.id;
	if (!threadId)
		die("建会话失败(thread/start 没返回 id)。", "把这句发给 Honey Lemon。");

	const startResp = await send("thread/realtime/start", {
		threadId,
		transport: { type: "websocket" },
		outputModality: MODALITY,
		voice: VOICE,
		version: VERSION,
	});
	if (startResp?.error) {
		const msg = JSON.stringify(startResp.error);
		if (/experimentalApi/i.test(msg))
			die(
				"第 2 道门没开(experimentalApi)。",
				"这是脚本自己的 bug,把这句发给 Honey Lemon。",
			);
		if (/realtime_conversation|feature/i.test(msg))
			die(
				"第 1 道门没开(--enable realtime_conversation)。",
				"这是脚本自己的 bug,把这句发给 Honey Lemon。",
			);
		die(`起语音会话被拒绝:${msg}`, "把这句原文发给 Honey Lemon。");
	}

	const outcome = await waitStart();
	if (outcome !== "started") {
		if (lastError && /Voice session access denied/i.test(lastError))
			die(
				"后端拒绝了这次语音会话:Voice session access denied",
				"这是账号侧的准入问题,不是你操作错了。把这句发给 Honey Lemon。",
			);
		die(
			`语音会话没建起来(${outcome})${lastError ? `:${lastError}` : ""}`,
			"把这句发给 Honey Lemon。",
		);
	}
	// 只报真正观测到的值。started 通知里带 version,不带 model —— 所以 model 不编。
	const startedEv = events.find((e) => e.method === "thread/realtime/started");
	const obsVersion = startedEv?.params?.version ?? VERSION;
	const obsSession = startedEv?.params?.realtimeSessionId ?? threadId;
	say("✅ 语音会话已建立 —— 你现在连的是:");
	say("     链路  Codex realtime 语音会话(不是 TTS)");
	say(`     版本  ${obsVersion}   传输  websocket   声线  ${VOICE}`);
	say(`     会话  ${obsSession}`);
	say("     模型  由服务端选择,协议没把 model 名回给客户端 —— 所以这里不写死");
	say("");

	let tSend0;
	if (TYPE_MODE) {
		const line = await ask("   打一句话让它念(直接回车用默认句)> ");
		const text =
			(line || "").trim() ||
			"你好,我是 Codex 的实时语音。这句话是用来让你判断音色和语气的。";
		say(`\n📤 送出去了:「${text}」`);
		tSend0 = Date.now();
		const r = await send("thread/realtime/appendSpeech", { threadId, text });
		if (r?.error)
			die(
				`送文字被拒绝:${JSON.stringify(r.error)}`,
				"把这句发给 Honey Lemon。",
			);
	} else {
		await ask(
			`   按 Enter 开始录音,然后对着麦克风说话(${RECORD_SECONDS} 秒)… `,
		);
		say(`\n🔴 录音中… 请说话(${RECORD_SECONDS} 秒)`);
		const tRec0 = Date.now();
		record(RECORD_SECONDS);
		say(
			`⏹  录完了(${((Date.now() - tRec0) / 1000).toFixed(1)} 秒)。正在送过去…\n`,
		);

		const { pcm, fmt } = wavData(readFileSync(IN_WAV));
		if (!pcm.length)
			die("录到的音频是空的。", "检查麦克风权限,或者换个输入设备再试。");

		// 尾部补 2 秒静音,让服务端的断句检测收口
		const silence = Buffer.alloc(SAMPLE_RATE * 2 * 2);
		const stream = Buffer.concat([pcm, silence]);
		const CHUNK = 4800 * 2;
		tSend0 = Date.now();
		for (let off = 0; off < stream.length; off += CHUNK) {
			const slice = stream.subarray(off, Math.min(off + CHUNK, stream.length));
			const res = await send("thread/realtime/appendAudio", {
				threadId,
				audio: {
					data: slice.toString("base64"),
					sampleRate: fmt.sampleRate,
					numChannels: fmt.channels,
					samplesPerChannel: slice.length / 2,
				},
			});
			if (res?.error)
				die(
					`送音频被拒绝:${JSON.stringify(res.error)}`,
					"把这句发给 Honey Lemon。",
				);
			await sleep(60);
		}
	}
	say("⏳ 等它回答…（最多 35 秒）");
	const deadline = Date.now() + 35000;
	let stable = 0,
		last = 0;
	while (Date.now() < deadline) {
		await sleep(500);
		if (audioOut.length === last && last > 0) {
			if (++stable >= 6) break;
		} else {
			stable = 0;
			last = audioOut.length;
		}
	}

	const outPcm = Buffer.concat(audioOut);
	const seconds = +(outPcm.length / 2 / SAMPLE_RATE).toFixed(2);
	if (!outPcm.length) {
		say("\n⚠️  它没有回声音。可能是没听清你说话,或者这次会话出了问题。");
		say("   再跑一次试试;连续两次都这样就把这段发给 Honey Lemon。");
	} else {
		const hdr = Buffer.alloc(44);
		hdr.write("RIFF", 0);
		hdr.writeUInt32LE(36 + outPcm.length, 4);
		hdr.write("WAVE", 8);
		hdr.write("fmt ", 12);
		hdr.writeUInt32LE(16, 16);
		hdr.writeUInt16LE(1, 20);
		hdr.writeUInt16LE(1, 22);
		hdr.writeUInt32LE(SAMPLE_RATE, 24);
		hdr.writeUInt32LE(SAMPLE_RATE * 2, 28);
		hdr.writeUInt16LE(2, 32);
		hdr.writeUInt16LE(16, 34);
		hdr.write("data", 36);
		hdr.writeUInt32LE(outPcm.length, 40);
		writeFileSync(OUT_WAV, Buffer.concat([hdr, outPcm]));
		say(`\n🔊 它回了 ${seconds} 秒的话,放给你听 —\n`);
		spawnSync(afplay, [OUT_WAV], { stdio: "ignore" });
	}

	await send("thread/realtime/stop", { threadId });
	await sleep(800);

	// ── 用量:只报能测到的,不假装能读到账号额度 ──────────────
	say("\n──────── 这次用了多少 ────────");
	say(TYPE_MODE ? "  输入:打字" : `  你说话:约 ${RECORD_SECONDS} 秒`);
	say(`  它回话:${seconds} 秒`);
	say(`  往返总耗时:${((Date.now() - tSend0) / 1000).toFixed(1)} 秒`);
	say(`\n  ⚠️  额度:codex CLI 没有对外暴露"这次用掉多少额度"的接口,`);
	say(`      所以这里不报百分比 —— 报了就是编的。`);
	say(`      要看真实消耗,跑之前和跑之后各看一次 ChatGPT 账号的用量页面对比。`);
	say(`      (它走的是订阅额度,不是 API 计费。)`);
	say("──────────────────────────────\n");

	cleanup();
	process.exit(0);
}

main().catch((e) => die(String(e?.message || e), "把这句发给 Honey Lemon。"));
