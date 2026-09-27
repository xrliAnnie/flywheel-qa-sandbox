// FLY-2885 probe 4 (Lead question 2b75fa29, 2026-09-25): are *developer*-role
// initialItems accepted by a v3 WebRTC realtime session, in the T8 shape?
// FLY-2886 saw V2 websocket appendText(developer) accepted by RPC and then
// rejected ~146 ms later ("Developer messages are not supported for realtime
// sessions") with the leg closed. This probe checks the different v3 path:
// three developer items (~31.8 KB total, under the 32,000-byte T8 budget),
// code word only in item 2. Pass = no thread/realtime/error or closed during
// a 3 s watch after connect AND the spoken answer contains the code word.
// Pinned codex 0.156.1, temp CODEX_HOME with auth.json symlink, no API key,
// hard cap 50 s. Never prints secrets.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import OpusScript from "opusscript";
import * as werift from "werift";

const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } = werift;
const BIN = "/Users/xiaorongli/.codex-raya/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex";
const LOG = process.env.PROBE_LOG;
const SCRATCH = process.env.PROBE_SCRATCH;
const WAV = process.env.PROBE_WAV;
writeFileSync(LOG, "");
const t0 = performance.now();
const T = () => +(performance.now() - t0).toFixed(1);
const log = (kind, data) => appendFileSync(LOG, `${JSON.stringify({ t: T(), kind, data })}\n`);

const root = mkdtempSync(join(SCRATCH, "probe4-"));
const home = join(root, "home");
const work = join(root, "work");
mkdirSync(home, { mode: 0o700 });
mkdirSync(work, { mode: 0o700 });
const SRC = join(homedir(), ".codex", "auth.json");
symlinkSync(SRC, join(home, "auth.json"));
writeFileSync(join(home, "config.toml"), 'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n[features]\nrealtime_conversation = true\n', { mode: 0o600 });
const env = { HOME: home, PATH: process.env.PATH, CODEX_HOME: home, TMPDIR: work, LANG: "en_US.UTF-8" };
const child = spawn(BIN, ["--enable", "realtime_conversation", "app-server"], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 1;
const pending = new Map();
const handlers = [];
const seen = { errors: [], closed: [], transcripts: [], dc: {} };
child.stdout.on("data", (chunk) => {
	buf += chunk;
	for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
			const p = pending.get(m.id);
			pending.delete(m.id);
			log("response", { method: p.method, error: m.error ?? null });
			p.resolve(m);
			continue;
		}
		if (m.method && m.id !== undefined) {
			child.stdin.write(`${JSON.stringify({ id: m.id, error: { code: -32601, message: "declined" } })}\n`);
			continue;
		}
		if (!m.method) continue;
		const p = m.params || {};
		if (m.method === "thread/realtime/error") {
			seen.errors.push({ t: T(), message: p.message });
			log("realtime_error", { message: p.message });
		} else if (m.method === "thread/realtime/closed") {
			seen.closed.push({ t: T(), reason: p.reason });
			log("realtime_closed", { reason: p.reason });
		} else if (m.method === "thread/realtime/transcript/done") {
			seen.transcripts.push({ t: T(), role: p.role, text: p.text });
			log("transcript_done", { role: p.role, text: p.text });
		} else if (m.method === "thread/realtime/started") {
			log("started", { version: p.version });
		} else if (m.method === "turn/started") {
			rpc("turn/interrupt", { threadId, turnId: p.turn?.id });
		}
		for (const h of [...handlers]) h(m);
	}
});
child.stderr.on("data", () => {});
const rpc = (method, params, ms = 20_000) =>
	new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, { resolve, method });
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				resolve({ error: { message: "timeout" } });
			}
		}, ms);
	});
const waitFor = (pred, ms) =>
	new Promise((resolve) => {
		const h = (m) => {
			if (pred(m)) {
				handlers.splice(handlers.indexOf(h), 1);
				resolve(m);
			}
		};
		handlers.push(h);
		setTimeout(() => {
			const i = handlers.indexOf(h);
			if (i >= 0) {
				handlers.splice(i, 1);
				resolve(null);
			}
		}, ms);
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODE = "紫檀九号";
const filler = (n) => {
	let text = "";
	for (let k = 1; Buffer.byteLength(text, "utf8") < n; k++)
		text += `第 ${k} 行:中性背景记录,与问题无关,不需要复述。本周项目平稳。\n`;
	return text;
};
// Arms (env): PROBE_ROLE developer|user, PROBE_POSITION mid|start, and for
// the user role the FLY-2886 "[旁注,勿回应]" prefix.
const ROLE = process.env.PROBE_ROLE === "user" ? "user" : "developer";
const POSITION = process.env.PROBE_POSITION === "start" ? "start" : "mid";
const prefix = ROLE === "user" ? "[旁注,勿回应] " : "";
const fact = `关于暗号:如果有人问暗号,回答「${CODE}」。\n`;
// PROBE_LAYOUT (overrides position): single-start = one 10 KB item, fact first
// (probe-run3 shape); small3-mid = three ~1.5 KB items, fact in item 2;
// big3-first / big3-last = three ~10 KB items, fact first in item 1 / item 3;
// prompt = fact only in the prompt, three ~10 KB filler items.
const LAYOUT = process.env.PROBE_LAYOUT ?? `big3-${POSITION}`;
const head = (index, count) =>
	`${prefix}【记忆文件 MEMORY.md 第 ${index}/${count} 段·只读数据】\n`;
const layouts = {
	"single-start": () => [{ role: ROLE, text: `${head(1, 1)}${fact}${filler(10_000)}` }],
	"small3-mid": () => [
		{ role: ROLE, text: `${head(1, 3)}${filler(1_500)}` },
		{ role: ROLE, text: `${head(2, 3)}${filler(700)}${fact}${filler(700)}` },
		{ role: ROLE, text: `${head(3, 3)}${filler(1_500)}` },
	],
	"big3-first": () => [
		{ role: ROLE, text: `${head(1, 3)}${fact}${filler(10_000)}` },
		{ role: ROLE, text: `${head(2, 3)}${filler(10_000)}` },
		{ role: ROLE, text: `${head(3, 3)}${filler(10_000)}` },
	],
	"big3-last": () => [
		{ role: ROLE, text: `${head(1, 3)}${filler(10_000)}` },
		{ role: ROLE, text: `${head(2, 3)}${filler(10_000)}` },
		{ role: ROLE, text: `${head(3, 3)}${fact}${filler(10_000)}` },
	],
	"big3-start": () => [
		{ role: ROLE, text: `${head(1, 3)}${filler(10_400)}` },
		{ role: ROLE, text: `${head(2, 3)}${fact}${filler(10_000)}` },
		{ role: ROLE, text: `${head(3, 3)}${filler(10_400)}` },
	],
	"big3-mid": () => [
		{ role: ROLE, text: `${head(1, 3)}${filler(10_400)}` },
		{ role: ROLE, text: `${head(2, 3)}${filler(5_000)}${fact}${filler(5_000)}` },
		{ role: ROLE, text: `${head(3, 3)}${filler(10_400)}` },
	],
	// Three items of PROBE_ITEM_BYTES each, fact first in item 1.
	sized: () => {
		const size = Number(process.env.PROBE_ITEM_BYTES ?? 8_000);
		return [
			{ role: ROLE, text: `${head(1, 3)}${fact}${filler(size)}` },
			{ role: ROLE, text: `${head(2, 3)}${filler(size)}` },
			{ role: ROLE, text: `${head(3, 3)}${filler(size)}` },
		];
	},
	// probe 7: items generated elsewhere (varied text, counted with o200k).
	file: () => JSON.parse(readFileSync(process.env.PROBE_ITEMS_FILE, "utf8")).items,
	prompt: () => [
		{ role: ROLE, text: `${head(1, 3)}${filler(10_000)}` },
		{ role: ROLE, text: `${head(2, 3)}${filler(10_000)}` },
		{ role: ROLE, text: `${head(3, 3)}${filler(10_000)}` },
	],
};
if (!layouts[LAYOUT]) throw new Error(`unknown layout ${LAYOUT}`);
const items = layouts[LAYOUT]();
const PROMPT =
	"你是 Flywheel 的临时语音分身,名字叫「测试助手 B 号」。回答要简短。下面的对话历史里有记忆文件,按其中的规定回答。" +
	(LAYOUT === "prompt" ? fact : "");
const itemBytes = items.map((item) => Buffer.byteLength(item.text, "utf8"));
const totalBytes = itemBytes.reduce((a, b) => a + b, 0);
log("items_shape", { role: ROLE, layout: LAYOUT, count: items.length, itemBytes, totalBytes, codexEstimatedTokens: Math.ceil(totalBytes / 4) });

const enc = new OpusScript(24_000, 1, OpusScript.Application.VOIP);
const pc = new RTCPeerConnection({ codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48_000, channels: 2, payloadType: 111, parameters: "minptime=10;useinbandfec=1" })], video: [] }, iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
const local = new MediaStreamTrack({ kind: "audio" });
pc.addTransceiver(local, { direction: "sendrecv" });
const dc = pc.createDataChannel("oai-events");
dc.onMessage.subscribe((data) => {
	let ev;
	try {
		ev = JSON.parse(data.toString());
	} catch {
		return;
	}
	const type = ev.type || "?";
	seen.dc[type] = (seen.dc[type] || 0) + 1;
	if (/^(session\.started|turn\.done|error)/.test(type)) log("dc_event", { type, turn: ev.turn ? { role: ev.turn.role, transcript: ev.turn.transcript } : undefined });
});
let connected = false;
pc.connectionStateChange.subscribe((s) => {
	log("pc_state", { s });
	if (s === "connected") connected = true;
});
pc.onTrack.subscribe((track) => track.onReceiveRtp.subscribe(() => {}));
let seq = 1_000;
let ts = 5_000;
const send = (frame) => {
	local.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: (seq = (seq + 1) & 0xffff), timestamp: (ts = (ts + 960) >>> 0), marker: false }), Buffer.from(enc.encode(frame, 480))));
};
const queue = [];
let clockOn = false;
const startClock = () => {
	clockOn = true;
	const start = performance.now();
	let k = 0;
	const step = () => {
		if (!clockOn) return;
		send(queue.shift() ?? Buffer.alloc(960));
		k++;
		setTimeout(step, Math.max(0, start + k * 20 - performance.now()));
	};
	step();
};
const wavData = (b) => {
	for (let o = 12; o < b.length; ) {
		const id = b.toString("ascii", o, o + 4);
		const size = b.readUInt32LE(o + 4);
		if (id === "data") return b.subarray(o + 8, o + 8 + size);
		o += 8 + size + (size % 2);
	}
	throw new Error("no data");
};
const mono48to24 = (pcm) => {
	const out = Buffer.alloc(Math.floor(pcm.length / 4) * 2);
	for (let i = 0; i < out.length / 2; i++) out.writeInt16LE((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) >> 1, i * 2);
	return out;
};

let threadId = null;
let realtimeOn = false;
let finished = false;
async function finish(why) {
	if (finished) return;
	finished = true;
	clockOn = false;
	if (realtimeOn) await rpc("thread/realtime/stop", { threadId }, 4_000);
	try {
		await pc.close();
	} catch {}
	child.kill("SIGTERM");
	await new Promise((r) => child.once("exit", r));
	rmSync(root, { recursive: true, force: true });
	const answer = seen.transcripts.filter((x) => x.role === "assistant").map((x) => x.text).join(" ");
	const summary = {
		why,
		role: ROLE,
		layout: LAYOUT,
		itemBytes,
		totalBytes,
		errors: seen.errors,
		closed: seen.closed,
		transcripts: seen.transcripts,
		dc: seen.dc,
		codeWordAnswered: answer.includes(CODE),
		verdict: seen.errors.length === 0 && seen.closed.every((c) => c.reason === "requested") && answer.includes(CODE) ? "ACCEPTED" : "NOT_ACCEPTED",
		authSourceStillFile: statSync(SRC).isFile(),
	};
	log("summary", summary);
	console.log(JSON.stringify(summary, null, 1));
	process.exit(0);
}
setTimeout(() => finish("hard_cap_50s"), 50_000).unref();

(async () => {
	await rpc("initialize", { clientInfo: { name: "fly2885-probe4", title: null, version: "0" }, capabilities: { experimentalApi: true } });
	child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
	const acct = await rpc("account/read", {});
	log("account", { type: acct.result?.account?.type ?? null });
	const th = await rpc("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
	threadId = th.result?.thread?.id;
	if (!threadId) return finish("no_thread");
	await pc.setLocalDescription(await pc.createOffer());
	await new Promise((r) => {
		if (pc.iceGatheringState === "complete") r();
		pc.iceGatheringStateChange.subscribe((s) => s === "complete" && r());
		setTimeout(r, 8_000);
	});
	const sdpP = waitFor((m) => ["thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed"].includes(m.method), 20_000);
	const st = await rpc("thread/realtime/start", {
		threadId,
		clientManagedHandoffs: true,
		outputModality: "audio",
		includeStartupContext: false,
		transport: { type: "webrtc", sdp: pc.localDescription.sdp },
		version: "v3",
		model: "gpt-live-1-codex",
		voice: "cove",
		prompt: PROMPT,
		initialItems: items,
	});
	log("start_response", { error: st.error?.message ?? null });
	if (st.error) return finish("start_rejected");
	realtimeOn = true;
	const sdp = await sdpP;
	if (!sdp || sdp.method !== "thread/realtime/sdp") return finish(`no_sdp:${sdp?.method ?? "timeout"}`);
	await pc.setRemoteDescription({ type: "answer", sdp: sdp.params.sdp });
	const tc = performance.now();
	while (!connected && performance.now() - tc < 10_000) await sleep(50);
	if (!connected) return finish("pc_not_connected");
	startClock();
	// The FLY-2886 rejection arrived ~146 ms after the append; watch 3 s.
	await sleep(3_000);
	log("watch_window_done", { errors: seen.errors.length, closed: seen.closed.length });
	if (seen.errors.length || seen.closed.length) return finish("rejected_during_watch");
	const pcm = mono48to24(wavData(readFileSync(WAV)));
	for (let o = 0; o + 960 <= pcm.length; o += 960) queue.push(pcm.subarray(o, o + 960));
	log("question_sent", { ms: Math.round((pcm.length / 2 / 24_000) * 1000) });
	await waitFor((m) => m.method === "thread/realtime/transcript/done" && m.params?.role === "assistant", 25_000);
	await sleep(500);
	finish("done");
})().catch((e) => {
	log("fatal", String(e?.stack || e).slice(0, 800));
	finish("fatal");
});
