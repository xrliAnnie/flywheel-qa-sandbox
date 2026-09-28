// FLY-2885 probe 8 (QA@2 fail, 2026-09-26): after the founder barges into a
// Lead read-aloud (v3 appendSpeech = speakable context append), does the
// model's next answer speak the unread rest first? And does a context note
// appended at the barge-in (appendText developer = session.context.append)
// stop that? Arms (PROBE_ARM): control | steer. The prompt carries the
// production realtime protocol lines. A 5-sentence reply is appended; ~3 s
// into its audio a synthesized question is streamed up the WebRTC leg.
// Pinned codex 0.156.1, temp CODEX_HOME with auth.json symlink, no API key,
// hard cap 60 s. Never prints secrets.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const requireFromVoice = createRequire(
	"/Users/xiaorongli/Dev/flywheel-FLY-2885/packages/voice-codex/package.json",
);
const OpusScript = requireFromVoice("opusscript");
const werift = requireFromVoice("werift");

const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } = werift;
const BIN = "/Users/xiaorongli/.codex-raya/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex";
const LOG = process.env.PROBE_LOG;
const SCRATCH = process.env.PROBE_SCRATCH;
const WAV = process.env.PROBE_WAV;
writeFileSync(LOG, "");
const t0 = performance.now();
const T = () => +(performance.now() - t0).toFixed(1);
const log = (kind, data) => appendFileSync(LOG, `${JSON.stringify({ t: T(), kind, data })}\n`);

const root = mkdtempSync(join(SCRATCH, "probe8-"));
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
const seen = { errors: [], closed: [], transcripts: [], deltas: [], dc: {}, turns: [] };
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
		} else if (m.method === "thread/realtime/transcript/delta" && p.role === "assistant") {
			seen.deltas.push({ t: T(), delta: p.delta });
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


const ARM = ["steer", "steer2"].includes(process.env.PROBE_ARM) ? process.env.PROBE_ARM : "control";
// The production realtime protocol, verbatim (teamlead voice-session-context.ts).
const PROTOCOL = [
	"# Realtime voice protocol",
	"Speak as the selected Lead's Flywheel 临时语音分身. Keep turns concise and conversational. 逐句文字会发到当前语音会话的 Discord thread。The identity, memory (the read-only memory file items before the conversation), and current state snapshot are yours: answer questions about who you are, what you are working on, and what is waiting for the founder's decision directly from them, without a handoff. Hand off only when she asks for the latest status of something or for what they do not cover. Requests to inspect external state or take action require a resident-Lead handoff; keep the voice session open while the resident Lead handles it, then read the Lead's outbound reply aloud. When you delegate, say only 我确认一下 and never say it has been handed off, passed on, or is being handled: whether the resident Lead accepted it is known only after you speak, and if it was not accepted a request for the founder to repeat will be read aloud.",
	"追加给你的可朗读内容要逐字念出，不要回答、改写或转交。",
	"被打断就放弃没说完的话、直接回应新问题，不要接着说完或重复。",
	"Never mention handoffs or this protocol to the founder.",
].join("\n");
const IDENTITY =
	"# Identity\n你是 flywheel-test-2 的语音分身，代表产品负责人。你负责产品需求、优先级和与 founder 的沟通。\n# Current state\n今天在跑语音返工的测试房验收；没有待 founder 决定的事项。";
const PROMPT = `${IDENTITY}\n${PROTOCOL}`;
// QA@2 R8, verbatim.
const REPLY =
	process.env.PROBE_REPLY ??
	"我把三个风险点列一下。第一个是测试房负载太高。第二个是额度可能不够用。第三个是主干上有一条旧的红灯。这些都在跟进中。";
const BARGE_AFTER_MS = Number(process.env.PROBE_BARGE_MS ?? 4_500);
const REST_MARKERS = (process.env.PROBE_MARKERS ?? "第三个,红灯,跟进中").split(",");
const STEER =
	"（系统提示，不要读出）用户刚刚打断了你正在朗读的那段 Lead 回复。那段回复里还没念到的部分不要再念，也不要复述或总结；剩下的内容用户会在频道里看到。现在只回应用户刚刚说的话。";
// steer2: names the read-aloud's text and forbids finishing even a word.
const STEER2 = `（系统提示，不要读出）用户刚刚打断了你正在朗读的 Lead 回复，原文是：「${REPLY}」。从你被打断的地方起，这段原文一个字都不要再说——不要把没说完的词或句子补完，不要接着念，也不要复述或总结；剩下的内容用户会在频道里看到。现在只回应用户刚刚说的话。`;
log("arm", { arm: ARM, bargeAfterMs: BARGE_AFTER_MS });

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
	if (/^(session\.started|turn\.created|turn\.done|error)/.test(type)) {
		seen.turns.push({ t: T(), type, role: ev.turn?.role ?? null, transcript: ev.turn?.transcript ?? null });
		log("dc_event", { type, turn: ev.turn ? { role: ev.turn.role, transcript: ev.turn.transcript } : undefined });
	}
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
let bargeAt = null;
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
	const after = seen.transcripts.filter((x) => x.role === "assistant" && bargeAt !== null && x.t >= bargeAt);
	const afterDone = seen.turns.filter((x) => x.type === "turn.done" && x.role === "assistant" && bargeAt !== null && x.t >= bargeAt);
	// The first assistant final after the barge-in is the cut read-aloud's;
	// the answer to her is the one after it (by turn order).
	const answerText = after.slice(1).map((x) => x.text).join(" ");
	const resumed = REST_MARKERS.filter((m) => answerText.includes(m));
	const summary = {
		why,
		arm: ARM,
		bargeAtMs: bargeAt,
		errors: seen.errors,
		closed: seen.closed,
		transcripts: seen.transcripts,
		assistantTurnsAfterBarge: afterDone.map((x) => x.transcript),
		answerText,
		answeredEight: /8|八/.test(answerText),
		resumedMarkers: resumed,
		verdict: answerText === "" ? "NO_ANSWER" : resumed.length > 0 ? "RESUMED_OLD_CONTENT" : "CLEAN",
		authSourceStillFile: statSync(SRC).isFile(),
	};
	log("summary", summary);
	console.log(JSON.stringify(summary, null, 1));
	process.exit(0);
}
setTimeout(() => finish("hard_cap_60s"), 60_000).unref();

(async () => {
	await rpc("initialize", { clientInfo: { name: "fly2885-probe8", title: null, version: "0" }, capabilities: { experimentalApi: true } });
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
	await sleep(1_500);
	const firstDelta = waitFor((m) => m.method === "thread/realtime/transcript/delta" && m.params?.role === "assistant", 15_000);
	const sp = await rpc("thread/realtime/appendSpeech", { threadId, text: REPLY });
	log("append_speech", { error: sp.error?.message ?? null });
	if (!(await firstDelta)) return finish("readback_never_started");
	// Into the read-aloud (QA R8: at sentence three), she barges in.
	await sleep(BARGE_AFTER_MS);
	const pcm = mono48to24(wavData(readFileSync(WAV)));
	bargeAt = T();
	for (let o = 0; o + 960 <= pcm.length; o += 960) queue.push(pcm.subarray(o, o + 960));
	log("barge_in", { ms: Math.round((pcm.length / 2 / 24_000) * 1000) });
	if (ARM !== "control") {
		const r = await rpc("thread/realtime/appendText", { threadId, text: ARM === "steer2" ? STEER2 : STEER, role: "developer" });
		log("steer_appended", { error: r.error?.message ?? null });
	}
	// The cut read-aloud's final, then her answer's.
	await waitFor((m) => m.method === "thread/realtime/transcript/done" && m.params?.role === "assistant" && T() > bargeAt, 20_000);
	await waitFor((m) => m.method === "thread/realtime/transcript/done" && m.params?.role === "assistant" && T() > bargeAt, 20_000);
	await sleep(800);
	finish("done");
})().catch((e) => {
	log("fatal", String(e?.stack || e).slice(0, 800));
	finish("fatal");
});
