#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
/*
 * FLY-1911 可行性验证原型 —— 「跟 Codex 说句话」
 *
 * 这是**一次性验证原型,不是生产代码**。写死、单路径、允许难看。
 * 目的只有一个:把麦克风递到 Annie 手里,让她自己判断这声音行不行。
 *
 *   浏览器麦克风 --(24kHz PCM16 / HTTP POST)--> 本文件 --(thread/realtime/appendAudio)--> codex app-server
 *   浏览器音箱   <--(SSE)------------------------ 本文件 <--(thread/realtime/outputAudio/delta)--
 *
 * 走 v2 / websocket 通道:音频就是 JSON-RPC 上的 base64 PCM,不需要任何 WebRTC / Opus 栈。
 * 零 npm 依赖 —— 只用 node 内置模块,不用 npm install。
 */
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"); // 剥掉终端颜色码;不写成正则字面量,是因为字面量里带控制字符会被 lint 拦下(行为等价,已实测)

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8911);

// pin 一个 versioned 绝对路径:~/.local/bin/codex 是会摆动的 symlink(FLY-1443 §3.1)
const CODEX_BIN =
	process.env.CODEX_BIN ||
	"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const VOICE = process.env.RT_VOICE || "marin";
const VERSION = process.env.RT_VERSION || "v2";

if (!existsSync(CODEX_BIN)) {
	console.error(
		`\n找不到 codex:${CODEX_BIN}\n用 CODEX_BIN=<路径> node talk.mjs 指一个\n`,
	);
	process.exit(1);
}

/* ---------------- SSE:把事件推给页面 ---------------- */
const clients = new Set();
function push(ev) {
	const line = `data: ${JSON.stringify(ev)}\n\n`;
	for (const res of clients) {
		try {
			res.write(line);
		} catch {}
	}
}

/* ---------------- codex app-server 会话 ---------------- */
let child = null,
	threadId = null,
	nextId = 1,
	sessionStartedAt = null;
const waiters = new Map();

function rpc(method, params) {
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

function wire() {
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d.toString();
		let nl;
		for (;;) {
			nl = buf.indexOf("\n");
			if (nl < 0) break;
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let m;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}

			switch (m.method) {
				case "thread/realtime/outputAudio/delta": {
					const a = m.params?.audio || {};
					push({
						type: "audio",
						data: a.data,
						sampleRate: a.sampleRate,
						numChannels: a.numChannels,
					});
					continue;
				}
				case "thread/realtime/transcript/delta":
					push({
						type: "tx",
						final: false,
						role: m.params?.role,
						text: m.params?.delta,
					});
					continue;
				case "thread/realtime/transcript/done":
					push({
						type: "tx",
						final: true,
						role: m.params?.role,
						text: m.params?.text,
					});
					continue;
				case "thread/realtime/started":
					sessionStartedAt = Date.now();
					push({
						type: "status",
						state: "started",
						version: m.params?.version,
					});
					continue;
				case "thread/realtime/error":
					push({
						type: "error",
						where: "语音会话",
						message: m.params?.message,
					});
					continue;
				case "thread/realtime/closed":
					push({ type: "status", state: "closed", reason: m.params?.reason });
					continue;
				case "thread/realtime/itemAdded": {
					const it = m.params?.item || {};
					// 它把听到的话交办给 Codex agent 的那一刻 —— 让她看得见
					if (it.type === "handoff_request")
						push({ type: "handoff", heard: it.input_transcript ?? null });
					continue;
				}
				case "turn/started":
					push({ type: "turn", state: "started" });
					continue;
				case "turn/completed":
					push({
						type: "turn",
						state: "completed",
						status: m.params?.turn?.status,
						error: m.params?.turn?.error?.message ?? null,
					});
					continue;
				case "error":
					// 额度墙就是从这出来的 —— 原话贴出去,不美化
					push({
						type: "error",
						where: "Codex agent",
						message: m.params?.error?.message ?? String(m.params),
					});
					continue;
			}
			if (m.id !== undefined && waiters.has(m.id)) {
				waiters.get(m.id)(m);
				waiters.delete(m.id);
			}
		}
	});
	child.stderr.on("data", (d) => {
		const s = d.toString().replace(ANSI, "").trim();
		if (s) console.error("[codex]", s.slice(0, 300));
	});
	child.on("exit", (code, sig) => {
		push({ type: "status", state: "exited", code, sig });
		child = null;
		threadId = null;
	});
}

async function startSession() {
	if (child) return { ok: true, already: true };
	child = spawn(
		realpathSync(CODEX_BIN),
		["--enable", "realtime_conversation", "app-server"],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	wire();
	await rpc("initialize", {
		clientInfo: {
			name: "fly1911-talk",
			title: "FLY-1911 语音原型",
			version: "0.0.1",
		},
		capabilities: { experimentalApi: true },
	});
	notify("initialized", {});
	await new Promise((r) => setTimeout(r, 300));
	const th = await rpc("thread/start", {});
	threadId = th?.result?.thread?.id ?? null;
	if (!threadId) return { ok: false, error: "thread/start 没给回 threadId" };
	const resp = await rpc("thread/realtime/start", {
		threadId,
		transport: { type: "websocket" },
		outputModality: "audio",
		voice: VOICE,
		version: VERSION,
	});
	if (resp?.error) return { ok: false, error: JSON.stringify(resp.error) };
	return { ok: true, threadId };
}

/* ---------------- HTTP ---------------- */
function body(req) {
	return new Promise((r) => {
		let b = "";
		req.on("data", (c) => {
			b += c;
		});
		req.on("end", () => r(b));
	});
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	const send = (code, obj) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	};

	if (url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		return res.end(readFileSync(join(HERE, "talk.html")));
	}
	if (url.pathname === "/events") {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(": open\n\n");
		clients.add(res);
		req.on("close", () => clients.delete(res));
		return;
	}
	if (url.pathname === "/start" && req.method === "POST")
		return send(200, await startSession());
	if (url.pathname === "/stop" && req.method === "POST") {
		if (child && threadId) {
			await rpc("thread/realtime/stop", { threadId });
			try {
				child.stdin.end();
			} catch {}
		}
		setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {}
		}, 800);
		return send(200, { ok: true });
	}
	if (url.pathname === "/in" && req.method === "POST") {
		if (!child || !threadId)
			return send(409, { ok: false, error: "会话还没开" });
		const p = JSON.parse(await body(req));
		rpc("thread/realtime/appendAudio", {
			threadId,
			audio: {
				data: p.data,
				sampleRate: p.sampleRate,
				numChannels: p.numChannels,
				samplesPerChannel: p.samplesPerChannel,
			},
		});
		return send(200, { ok: true });
	}
	if (url.pathname === "/say" && req.method === "POST") {
		if (!child || !threadId)
			return send(409, { ok: false, error: "会话还没开" });
		const p = JSON.parse(await body(req));
		rpc("thread/realtime/appendSpeech", { threadId, text: p.text });
		return send(200, { ok: true });
	}
	if (url.pathname === "/health")
		return send(200, {
			alive: !!child,
			threadId,
			uptimeSec: sessionStartedAt
				? Math.round((Date.now() - sessionStartedAt) / 1000)
				: 0,
		});
	res.writeHead(404);
	res.end("nope");
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(
		`\n  FLY-1911 语音原型跑起来了\n\n  打开:  http://127.0.0.1:${PORT}\n\n  用的 codex: ${CODEX_BIN}\n  通道:      realtime ${VERSION} / websocket / voice=${VOICE}\n\n  Ctrl-C 退出。\n`,
	);
});
process.on("SIGINT", () => {
	try {
		child?.kill("SIGKILL");
	} catch {}
	process.exit(0);
});
