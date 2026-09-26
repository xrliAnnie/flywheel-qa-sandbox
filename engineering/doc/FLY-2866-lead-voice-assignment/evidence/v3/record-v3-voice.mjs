// FLY-2866 v3 voice audition recorder (throwaway tooling, not product code).
// Path = FLY-2884 prototype: codex app-server realtime v3 over WebRTC on the ChatGPT subscription
// (temp CODEX_HOME whose auth.json is a symlink to ~/.codex/auth.json; OPENAI_API_KEY stripped).
// No Discord: the uplink carries only pre-encoded Opus silence; the downlink RTP is decoded to WAV.
// Usage (run from a dir whose node_modules has werift + opusscript, e.g. a copy next to /tmp/fly2884-proto):
//   node record-v3-voice.mjs <outDir> <voice> [attempt]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, symlinkSync, lstatSync, chmodSync, appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import * as werift from "werift";
import OpusScript from "opusscript";
const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } = werift;

export const V3_VOICES = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"];
export const LINE =
  "你好，我是你的 Lead，今天由我来跟你同步进度。我这边有两件事已经做完，还有一件在等你拍板，我一件一件跟你说。";

const OUT = process.argv[2];
const VOICE = process.argv[3];
const ATTEMPT = process.argv[4] || "1";
if (!OUT || !V3_VOICES.includes(VOICE)) {
  console.error("usage: record-v3-voice.mjs <outDir> <v3-voice> [attempt]");
  process.exit(64);
}
const TAG = `${VOICE}-${ATTEMPT}`;
const DIR = `${OUT}/${TAG}`;
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const now = () => performance.now();
const t0 = now();
const scrub = (s) =>
  s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***")
    .replace(/eyJ[A-Za-z0-9_\-.]{20,}/g, "jwt-***")
    .replace(/"(access_token|refresh_token|id_token|token|authorization|Authorization)"\s*:\s*"[^"]*"/g, '"$1":"***"');
const log = (kind, data) =>
  appendFileSync(`${DIR}/session.jsonl`, scrub(JSON.stringify({ t: +((now() - t0) / 1000).toFixed(3), kind, data })) + "\n");

// ---- app-server on the subscription (FLY-2884 R8) ----
const HOME = `${OUT}/home`;
mkdirSync(HOME, { recursive: true, mode: 0o700 });
chmodSync(HOME, 0o700);
if (!existsSync(`${HOME}/auth.json`)) symlinkSync(`${process.env.HOME}/.codex/auth.json`, `${HOME}/auth.json`);
if (!lstatSync(`${HOME}/auth.json`).isSymbolicLink()) throw new Error("auth_json_not_symlink");
writeFileSync(`${HOME}/config.toml`, "# fly2866 v3 voice audition temp home — no login commands\n");
const env = { ...process.env, CODEX_HOME: HOME };
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
for (const k of Object.keys(env)) if (/TOKEN|SECRET/i.test(k)) delete env[k];
mkdirSync(`${OUT}/work`, { recursive: true });

let child, buf = "", nextId = 1, stopping = false, threadId = null, realtimeOn = false, pc = null;
const pending = new Map(), handlers = [], transcripts = [];
const rpc = (method, params, ms = 20000) =>
  new Promise((resolve) => {
    const id = nextId++;
    log("request", { method, params: method === "thread/realtime/start" ? { ...params, transport: { type: "webrtc" } } : params });
    pending.set(id, { resolve, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); log("timeout", { method }); resolve({ error: { message: "timeout" } }); }
    }, ms);
  });
const waitFor = (pred, ms) =>
  new Promise((resolve) => {
    const h = (m) => { if (pred(m)) { handlers.splice(handlers.indexOf(h), 1); resolve(m); } };
    handlers.push(h);
    setTimeout(() => { const i = handlers.indexOf(h); if (i >= 0) { handlers.splice(i, 1); resolve(null); } }, ms);
  });

// ---- audio ----
const dec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
const SILENCE = Buffer.from(enc.encode(Buffer.alloc(960 * 4), 960));
const pcmChunks = [];
let lastAudible = null, firstAudible = null;
const localTrack = new MediaStreamTrack({ kind: "audio" });
let seq = Math.floor(Math.random() * 65535), ts = Math.floor(Math.random() * 1e9);
function onDownRtp(rtp) {
  try {
    const stereo = Buffer.from(dec.decode(rtp.payload));
    const n = stereo.length / 4, mono = Buffer.alloc(n * 2);
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const v = (stereo.readInt16LE(i * 4) + stereo.readInt16LE(i * 4 + 2)) >> 1;
      mono.writeInt16LE(v, i * 2); ss += v * v;
    }
    pcmChunks.push(mono);
    if (Math.sqrt(ss / Math.max(1, n)) > 300) { lastAudible = now(); firstAudible ??= lastAudible; }
  } catch (e) { log("decode_error", String(e).slice(0, 200)); }
}
function wav(pcm, rate = 48000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function stop(why, extra = {}) {
  if (stopping) return;
  stopping = true;
  try { if (realtimeOn && threadId) await rpc("thread/realtime/stop", { threadId }, 4000); } catch {}
  try { await pc?.close(); } catch {}
  try { child?.kill("SIGTERM"); } catch {}
  const pcm = Buffer.concat(pcmChunks);
  writeFileSync(`${DIR}/downlink.wav`, wav(pcm), { mode: 0o600 });
  const result = {
    voice: VOICE, attempt: ATTEMPT, why, line: LINE, ...extra,
    downlinkSeconds: +(pcm.length / 96000).toFixed(2),
    audibleSpanSeconds: firstAudible && lastAudible ? +((lastAudible - firstAudible) / 1000).toFixed(2) : 0,
    assistantTranscript: transcripts.filter((x) => x.role === "assistant").map((x) => x.text).join(" "),
  };
  writeFileSync(`${DIR}/result.json`, JSON.stringify(result, null, 1));
  log("result", result);
  console.log(JSON.stringify(result));
  setTimeout(() => process.exit(why === "done" ? 0 : 1), 500);
}
process.on("SIGINT", () => stop("sigint"));
setTimeout(() => stop("hard_cap"), 90_000).unref();

(async () => {
  child = spawn("codex", ["app-server"], { cwd: `${OUT}/work`, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
        const p = pending.get(m.id); pending.delete(m.id);
        log("response", { method: p.method, error: m.error ?? null });
        p.resolve(m);
      } else if (m.method && m.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: "declined" } }) + "\n");
      } else if (m.method) {
        const p = m.params || {};
        if (m.method === "thread/realtime/transcript/done") transcripts.push({ role: p.role, text: p.text });
        if (/^thread\/realtime\/(started|error|closed|transcript\/done|itemAdded)$/.test(m.method)) log("notify", { method: m.method, params: p });
        for (const h of [...handlers]) h(m);
      }
    }
  });
  child.stderr.on("data", (d) => log("stderr", d.toString().slice(0, 600)));
  child.on("exit", (code) => { log("appserver_exit", { code }); if (!stopping) stop("appserver_exit"); });

  await rpc("initialize", { clientInfo: { name: "fly2866-voice-audition", title: null, version: "0.0.1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const acct = await rpc("account/read", {});
  log("account", { type: acct.result?.account?.type, planType: acct.result?.account?.planType });
  const voices = await rpc("thread/realtime/listVoices", {});
  log("listVoices", voices.result ?? voices.error);
  const th = await rpc("thread/start", { cwd: `${OUT}/work`, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
  threadId = th.result?.thread?.id;
  if (!threadId) return stop("no_thread", { error: th.error ?? null });

  pc = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111, parameters: "minptime=10;useinbandfec=1" })], video: [] },
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.addTransceiver(localTrack, { direction: "sendrecv" });
  pc.createDataChannel("oai-events");
  let connected = false;
  pc.connectionStateChange.subscribe((s) => { log("pc_state", { s }); if (s === "connected") connected = true; });
  pc.onTrack.subscribe((track) => track.onReceiveRtp.subscribe(onDownRtp));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { if (pc.iceGatheringState === "complete") r(); pc.iceGatheringStateChange.subscribe((s) => s === "complete" && r()); setTimeout(r, 8000); });

  const sdpP = waitFor((m) => ["thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed"].includes(m.method), 20000);
  const st = await rpc("thread/realtime/start", {
    threadId, version: "v3", model: "gpt-live-1-codex", voice: VOICE, clientManagedHandoffs: true, outputModality: "audio", includeStartupContext: false,
    prompt: "你是语音声线试听朗读员。不要调用任何工具，也不要主动说话。收到追加给你的可朗读内容时，用自然的普通话一字不改地念出来，不增不减，念完保持安静。",
    transport: { type: "webrtc", sdp: pc.localDescription.sdp },
  });
  if (st.error) return stop("start_rejected", { error: st.error });
  realtimeOn = true;
  const sdp = await sdpP;
  if (!sdp || sdp.method !== "thread/realtime/sdp") return stop("no_sdp", { error: sdp?.params ?? null });
  await pc.setRemoteDescription({ type: "answer", sdp: sdp.params.sdp });
  const tc = now();
  while (!connected && now() - tc < 10000) await new Promise((r) => setTimeout(r, 50));
  if (!connected) return stop("pc_not_connected");

  // uplink: one pre-encoded silence frame every 20 ms keeps the server's input clock running
  const clockStart = now(); let k = 0;
  const tick = () => {
    if (stopping) return;
    localTrack.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: (seq = (seq + 1) & 0xffff), timestamp: ts >>> 0, marker: false }), SILENCE));
    ts = (ts + 960) >>> 0; k++;
    setTimeout(tick, Math.max(0, clockStart + k * 20 - now()));
  };
  tick();

  await new Promise((r) => setTimeout(r, 1500)); // settle; drop any start-up noise from the measurement window
  const sp = await rpc("thread/realtime/appendSpeech", { threadId, text: LINE });
  if (sp.error) return stop("append_rejected", { error: sp.error });
  const ta = now();
  // done = something audible, then 6 s without audible frames (Live pauses mid-utterance; FLY-2866 run2 lesson)
  while (now() - ta < 60000) {
    if (lastAudible && now() - lastAudible > 6000) return stop("done");
    await new Promise((r) => setTimeout(r, 100));
  }
  stop(lastAudible ? "done" : "no_audio");
})().catch((e) => { log("fatal", String(e?.stack || e).slice(0, 1200)); stop("fatal"); });
