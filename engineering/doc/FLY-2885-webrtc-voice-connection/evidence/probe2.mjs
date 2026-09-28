// FLY-2885 design probe (one short realtime session, hard cap 60 s):
// pinned codex 0.156.1 app-server, temp CODEX_HOME with auth.json symlink (ChatGPT subscription), no API key.
// Checks: (1) v2 voice "marin" rejected for v3; (2) explicit model gpt-live-1-codex + voice cove + ~60 KB prompt accepted;
// (3) the prompt's facts are used (identity + code word); (4) appendSpeech read back; (5) no audio on JSON-RPC in webrtc;
// (6) data-channel event names. Never prints secrets; transcript text is test content only.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as werift from "werift";
import OpusScript from "opusscript";
const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } = werift;

const DIR = new URL(".", import.meta.url).pathname;
const BIN = "/Users/xiaorongli/.codex-raya/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex";
const LOG = join(DIR, "log.jsonl");
writeFileSync(LOG, "");
const t0 = performance.now();
const T = () => +(performance.now() - t0).toFixed(1);
const log = (kind, data) => appendFileSync(LOG, JSON.stringify({ t: T(), kind, data }) + "\n");
const marks = {};
const mark = (k) => { if (marks[k] === undefined) { marks[k] = T(); log("mark", { k, ms: marks[k] }); } };

const root = mkdtempSync(join(DIR, "run-"));
const home = join(root, "home"), work = join(root, "work");
mkdirSync(home, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
const SRC = join(homedir(), ".codex", "auth.json");
symlinkSync(SRC, join(home, "auth.json"));
writeFileSync(join(home, "config.toml"), 'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n[features]\nrealtime_conversation = true\n', { mode: 0o600 });
const env = { HOME: home, PATH: process.env.PATH, CODEX_HOME: home, TMPDIR: work, LANG: "en_US.UTF-8" };
const child = spawn(BIN, ["--enable", "realtime_conversation", "app-server"], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 1; const pending = new Map(), handlers = [];
const counts = { outputAudioDelta: 0, dc: {}, notify: {} };
const transcripts = [];
child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error !== undefined)) { const p = pending.get(m.id); pending.delete(m.id); log("response", { method: p.method, error: m.error ?? null }); p.resolve(m); continue; }
    if (m.method && m.id !== undefined) { child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: "declined" } }) + "\n"); log("server_request_declined", { method: m.method }); continue; }
    if (!m.method) continue;
    counts.notify[m.method] = (counts.notify[m.method] || 0) + 1;
    const p = m.params || {};
    if (m.method === "thread/realtime/outputAudio/delta") { counts.outputAudioDelta++; }
    else if (m.method === "thread/realtime/transcript/done") { transcripts.push({ t: T(), role: p.role, text: p.text }); log("transcript_done", { role: p.role, text: p.text }); }
    else if (m.method === "turn/started") { log("bg_turn_started", {}); rpc("turn/interrupt", { threadId, turnId: p.turn?.id }); }
    else if (/^thread\/realtime\/(error|closed|started|itemAdded)$/.test(m.method)) { const s = JSON.stringify(p); log("notify", { method: m.method, params: s.length > 800 ? s.slice(0, 800) + "…" : p }); }
    for (const h of [...handlers]) h(m);
  }
});
child.stderr.on("data", () => {});
const rpc = (method, params, ms = 20000) => new Promise((resolve) => { const id = nextId++; pending.set(id, { resolve, method }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: "timeout" } }); } }, ms); });
const waitFor = (pred, ms) => new Promise((resolve) => { const h = (m) => { if (pred(m)) { handlers.splice(handlers.indexOf(h), 1); resolve(m); } }; handlers.push(h); setTimeout(() => { const i = handlers.indexOf(h); if (i >= 0) { handlers.splice(i, 1); resolve(null); } }, ms); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~60 KB prompt: identity + code word + benign filler, mirrors the size of a real Lead context
const head = "你是 Flywheel 的临时语音分身,名字叫「测试助手 B 号」。如果有人问你的名字,就说你叫测试助手 B 号。如果有人问暗号,回答「青柠七号」。回答要简短。\n\n";
let filler = "";
for (let n = 1; Buffer.byteLength(head + filler, "utf8") < Number(process.env.PROMPT_KB || 60) * 1024; n++) filler += `背景资料第 ${n} 段:这是一段用于测量上下文长度的中性填充文字,内容与问题无关,不需要复述。项目进展平稳,本周没有需要决定的事项。\n`;
const PROMPT = head + filler + "\n以上背景资料到此结束。";

const enc = new OpusScript(24000, 1, OpusScript.Application.VOIP); // same shape as the planned uplink: 24 kHz mono PCM -> Opus
const dec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
const pc = new RTCPeerConnection({ codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111, parameters: "minptime=10;useinbandfec=1" })], video: [] }, iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
const local = new MediaStreamTrack({ kind: "audio" });
pc.addTransceiver(local, { direction: "sendrecv" });
const dc = pc.createDataChannel("oai-events");
dc.onMessage.subscribe((data) => { let ev; try { ev = JSON.parse(data.toString()); } catch { return; } const ty = ev.type || "?"; counts.dc[ty] = (counts.dc[ty] || 0) + 1; if (/^(session\.started|turn\.(created|done)|error)/.test(ty)) { const s = JSON.stringify(ev); log("dc_event", s.length > 600 ? s.slice(0, 600) + "…" : ev); } });
pc.connectionStateChange.subscribe((s) => { log("pc_state", { s }); if (s === "connected") mark("pc_connected"); });
let downPkts = 0, down960 = 0, voicedDown = 0;
pc.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((rtp) => {
  mark("first_rtp_in"); downPkts++;
  const toc = rtp.payload[0], c = toc >> 3, code = toc & 3; const ms = c < 12 ? [10,20,40,60][c & 3] : c < 16 ? [10,20][c & 1] : [2.5,5,10,20][c & 3]; const fr = code === 0 ? 1 : code === 3 ? (rtp.payload[1] & 0x3f) : 2; if (Math.round(ms * 48 * fr) === 960) down960++;
  try { const s = Buffer.from(dec.decode(rtp.payload)); let ss = 0; const n = s.length / 4; for (let i = 0; i < n; i++) { const v = (s.readInt16LE(i * 4) + s.readInt16LE(i * 4 + 2)) >> 1; ss += v * v; } if (Math.sqrt(ss / n) > 400) { voicedDown++; mark("first_voice_in"); } } catch {}
}));
let seq = 1000, ts = 5000;
function sendPcm24(frame480) { const payload = Buffer.from(enc.encode(frame480, 480)); local.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: seq = (seq + 1) & 0xffff, timestamp: ts = (ts + 960) >>> 0, marker: false }), payload)); }
function readWav(path) { const b = readFileSync(path); let o = 12; while (o < b.length) { const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4); if (id === "data") return b.subarray(o + 8, o + 8 + sz); o += 8 + sz + (sz % 2); } throw new Error("no data"); }
function to24(pcm48) { const out = Buffer.alloc(Math.floor(pcm48.length / 4) * 2); for (let i = 0; i < out.length / 2; i++) out.writeInt16LE((pcm48.readInt16LE(i * 4) + pcm48.readInt16LE(i * 4 + 2)) >> 1, i * 2); return out; }
let clockOn = false; const q = [];
function startClock() { clockOn = true; const start = performance.now(); let k = 0; const step = () => { if (!clockOn) return; sendPcm24(q.shift() ?? Buffer.alloc(960)); k++; setTimeout(step, Math.max(0, start + k * 20 - performance.now())); }; step(); }
function queuePcm24(pcm) { for (let o = 0; o + 960 <= pcm.length; o += 960) q.push(pcm.subarray(o, o + 960)); }

let threadId = null, realtimeOn = false, finished = false;
async function finish(why) {
  if (finished) return; finished = true; clockOn = false;
  if (realtimeOn) await rpc("thread/realtime/stop", { threadId }, 4000);
  try { await pc.close(); } catch {}
  child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r));
  rmSync(root, { recursive: true, force: true });
  const summary = { why, marks, counts, downPkts, down960, voicedDown, transcripts, promptBytes: Buffer.byteLength(PROMPT, "utf8"), authSourceStillFile: statSync(SRC).isFile() };
  log("summary", summary); console.log(JSON.stringify(summary, null, 1)); process.exit(0);
}
setTimeout(() => finish("hard_cap_60s"), 60000).unref();

(async () => {
  await rpc("initialize", { clientInfo: { name: "fly2885-probe", title: null, version: "0" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const acct = await rpc("account/read", {}); log("account", { type: acct.result?.account?.type });
  const th = await rpc("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
  threadId = th.result?.thread?.id; if (!threadId) return finish("no_thread");
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { if (pc.iceGatheringState === "complete") r(); pc.iceGatheringStateChange.subscribe((s) => s === "complete" && r()); setTimeout(r, 8000); });
  const base = { threadId, clientManagedHandoffs: true, outputModality: "audio", includeStartupContext: false, transport: { type: "webrtc", sdp: pc.localDescription.sdp }, version: "v3", model: "gpt-live-1-codex" };
  const bad = process.env.SKIP_MARIN ? { error: { message: "skipped" } } : await rpc("thread/realtime/start", { ...base, voice: "marin", prompt: "x" });
  log("marin_attempt", { error: bad.error?.message ?? null, accepted: !bad.error });
  if (!bad.error) { await sleep(500); await rpc("thread/realtime/stop", { threadId }, 4000); await sleep(1000); }
  const sdpP = waitFor((m) => ["thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed"].includes(m.method), 20000);
  mark("start_sent");
  const ITEM_MODE = process.env.ITEM_MODE === "1";
  const itemText = "【记忆文件】关于暗号:如果有人问暗号,回答「青柠七号」。\n" + filler.slice(0, Number(process.env.ITEM_CHARS || 6000));
  const startParams = ITEM_MODE
    ? { ...base, voice: "cove", prompt: "你是 Flywheel 的临时语音分身,名字叫「测试助手 B 号」。如果有人问你的名字,就说你叫测试助手 B 号。回答要简短。下面的对话历史里有记忆文件,按其中的规定回答。", initialItems: [{ role: "developer", text: itemText }] }
    : { ...base, voice: "cove", prompt: PROMPT };
  log("start_params_shape", { itemMode: ITEM_MODE, promptBytes: Buffer.byteLength(startParams.prompt), itemBytes: ITEM_MODE ? Buffer.byteLength(itemText) : 0 });
  const st = await rpc("thread/realtime/start", startParams);
  if (st.error) { log("start_rejected", st.error); return finish("start_rejected"); }
  realtimeOn = true;
  const sdp = await sdpP;
  if (!sdp || sdp.method !== "thread/realtime/sdp") { log("no_sdp", sdp?.params ?? null); return finish("no_sdp"); }
  mark("answer_sdp");
  await pc.setRemoteDescription({ type: "answer", sdp: sdp.params.sdp });
  const tc = performance.now(); while (marks.pc_connected === undefined && performance.now() - tc < 10000) await sleep(50);
  if (marks.pc_connected === undefined) return finish("pc_not_connected");
  startClock();
  await sleep(800);
  mark("question_start");
  queuePcm24(to24monoFromMono48(readWav(join(DIR, "q.wav"))));
  const ans = await waitFor((m) => m.method === "thread/realtime/transcript/done" && m.params?.role === "assistant", 25000);
  mark("answer_done");
  await sleep(1500);
  mark("append_speech_sent");
  await rpc("thread/realtime/appendSpeech", { threadId, text: "测试已经完成,谢谢你的配合。" });
  await waitFor((m) => m.method === "thread/realtime/transcript/done" && m.params?.role === "assistant", 15000);
  mark("append_speech_done");
  await sleep(1500);
  finish("done");
})().catch((e) => { log("fatal", String(e?.stack || e).slice(0, 800)); finish("fatal"); });

function to24monoFromMono48(pcm48mono) { const out = Buffer.alloc(Math.floor(pcm48mono.length / 4) * 2); for (let i = 0; i < out.length / 2; i++) out.writeInt16LE((pcm48mono.readInt16LE(i * 4) + pcm48mono.readInt16LE(i * 4 + 2)) >> 1, i * 2); return out; }
