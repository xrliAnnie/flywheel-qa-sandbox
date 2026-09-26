// FLY-2881 round 5: WebRTC + ChatGPT subscription (no API key) realtime voice via codex app-server, mirroring CLI /voice.
// Sends a TTS WAV, records returned audio, lets one background turn run (client-managed handoff like the TUI).
// Never prints secrets. Realtime session hard-capped at 60s.
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import * as werift from "werift";
import OpusScript from "opusscript";
const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } = werift;

const RUN = process.argv[2] || "x";
const EXP = "/tmp/fly2881-webrtc";
const LOG = `${EXP}/log-${RUN}.jsonl`;
const t0 = Date.now();
const T = () => Date.now() - t0;
writeFileSync(LOG, "");
const redact = (s) => s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***").replace(/eyJ[A-Za-z0-9_\-.]{20,}/g, "jwt-***");
const log = (kind, data) => appendFileSync(LOG, redact(JSON.stringify({ t: (T() / 1000).toFixed(3), kind, data })) + "\n");
const marks = {};
const mark = (k) => { if (marks[k] === undefined) { marks[k] = T(); log("mark", { k, ms: marks[k] }); } };

// ---------- app-server ----------
const env = { ...process.env, CODEX_HOME: `${EXP}/home` };
delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
const child = spawn("codex", ["app-server"], { cwd: `${EXP}/work`, env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 1;
const pending = new Map();
const handlers = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id); pending.delete(m.id);
      log("response", { method: p.method, error: m.error ?? null, keys: m.result ? Object.keys(m.result) : null, thread: m.result?.thread?.id, model: m.result?.model, sandbox: m.result?.sandbox, account: m.result?.account ? { type: m.result.account.type, planType: m.result.account.planType } : undefined });
      p.resolve(m);
    } else if (m.method && m.id !== undefined) {
      log("server_request_declined", { method: m.method });
      child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: "declined" } }) + "\n");
    } else if (m.method) {
      const p = m.params || {};
      if (m.method === "thread/realtime/sdp") log("notify", { method: m.method, sdpLines: (p.sdp || "").split("\r\n").filter((l) => /^(m=|a=rtpmap|a=setup|a=ice-lite)/.test(l)) });
      else if (m.method === "thread/realtime/outputAudio/delta") {}
      else if (/^(thread\/realtime\/|turn\/|item\/completed|error|account\/updated)/.test(m.method)) {
        const s = JSON.stringify(p);
        log("notify", { method: m.method, params: s.length > 1500 ? s.slice(0, 1500) + "…" : p });
      }
      for (const h of [...handlers]) h(m);
    }
  }
});
child.stderr.on("data", (d) => log("stderr", d.toString().slice(0, 800)));
child.on("exit", (code, sig) => log("exit", { code, sig }));
const rpc = (method, params, ms = 20000) => new Promise((resolve) => {
  const id = nextId++; log("request", { method });
  pending.set(id, { resolve, method });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); log("timeout", { method }); resolve({ error: { message: "timeout" } }); } }, ms);
});
const waitFor = (pred, ms) => new Promise((resolve) => {
  const h = (m) => { if (pred(m)) { handlers.splice(handlers.indexOf(h), 1); resolve(m); } };
  handlers.push(h);
  setTimeout(() => { const i = handlers.indexOf(h); if (i >= 0) { handlers.splice(i, 1); resolve(null); } }, ms);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- audio ----------
const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
const dec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
const recv = []; // mono int16 chunks
const frames = []; // {t, rms}
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function readWavPcm(path) {
  const b = readFileSync(path); let o = 12;
  while (o < b.length) { const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4); if (id === "data") return b.subarray(o + 8, o + 8 + sz); o += 8 + sz + (sz % 2); }
  throw new Error("no data chunk");
}

// ---------- webrtc ----------
const pc = new RTCPeerConnection({
  codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111, parameters: "minptime=10;useinbandfec=1" })], video: [] },
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});
const local = new MediaStreamTrack({ kind: "audio" });
pc.addTransceiver(local, { direction: "sendrecv" });
const dc = pc.createDataChannel("oai-events");
dc.stateChanged?.subscribe?.((s) => log("datachannel", { state: s }));
pc.connectionStateChange.subscribe((s) => { log("pc_state", { s }); if (s === "connected") mark("pc_connected"); });
pc.iceConnectionStateChange.subscribe((s) => log("ice_state", { s }));
pc.onTrack.subscribe((track) => {
  log("remote_track", { kind: track.kind });
  track.onReceiveRtp.subscribe((rtp) => {
    mark("first_rtp_in");
    try {
      const stereo = dec.decode(rtp.payload);
      const n = stereo.length / 4, mono = Buffer.alloc(n * 2); let ss = 0;
      for (let i = 0; i < n; i++) { const v = (stereo.readInt16LE(i * 4) + stereo.readInt16LE(i * 4 + 2)) >> 1; mono.writeInt16LE(v, i * 2); ss += v * v; }
      recv.push(mono);
      const rms = Math.sqrt(ss / Math.max(1, n));
      frames.push({ t: T(), rms });
      if (rms > 400) mark("first_voice_in");
    } catch (e) { log("decode_error", String(e).slice(0, 200)); }
  });
});

let seq = Math.floor(Math.random() * 65535), ts = Math.floor(Math.random() * 1e9);
function sendFrame(pcm960) {
  const payload = Buffer.from(enc.encode(pcm960, 960));
  const pkt = new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: seq = (seq + 1) & 0xffff, timestamp: ts = (ts + 960) >>> 0, marker: false }), payload);
  local.writeRtp(pkt);
}
async function sendPcm(pcm) {
  const start = Date.now(); let k = 0;
  for (let o = 0; o + 1920 <= pcm.length; o += 1920, k++) {
    sendFrame(pcm.subarray(o, o + 1920));
    const due = start + (k + 1) * 20 - Date.now(); if (due > 0) await sleep(due);
  }
}
const silence = (ms) => Buffer.alloc((48000 * ms / 1000) * 2);

// ---------- run ----------
const hardStop = setTimeout(() => finish("hard_stop_75s"), 75000);
let finished = false, threadId = null, realtimeOn = false;
async function finish(why) {
  if (finished) return; finished = true;
  log("finish", { why, marks });
  if (realtimeOn && threadId) await rpc("thread/realtime/stop", { threadId }, 4000);
  try { await pc.close(); } catch {}
  const pcm = Buffer.concat(recv);
  writeFileSync(`${EXP}/recv-${RUN}.wav`, wav(pcm, 48000));
  // voice segments (rms>400), merged within 300ms
  const segs = []; for (const f of frames) { if (f.rms <= 400) continue; const s = segs.at(-1); if (s && f.t - s.end < 300) s.end = f.t; else segs.push({ start: f.t, end: f.t }); }
  log("voice_segments_ms", segs.map((s) => [s.start, s.end]));
  log("recv_seconds", pcm.length / 96000);
  clearTimeout(hardStop);
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
}

(async () => {
  await rpc("initialize", { clientInfo: { name: "fly2881-webrtc", title: null, version: "0.0.1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  await rpc("account/read", {});
  const th = await rpc("thread/start", { cwd: `${EXP}/work`, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
  threadId = th.result?.thread?.id;
  if (!threadId) return finish("no_thread");

  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { if (pc.iceGatheringState === "complete") r(); pc.iceGatheringStateChange.subscribe((s) => s === "complete" && r()); setTimeout(r, 8000); });
  mark("offer_ready");

  const sdpP = waitFor((m) => m.method === "thread/realtime/sdp" || m.method === "thread/realtime/error" || m.method === "thread/realtime/closed", 20000);
  const startedP = waitFor((m) => m.method === "thread/realtime/started", 25000);
  mark("realtime_start_sent");
  const st = await rpc("thread/realtime/start", {
    threadId, clientManagedHandoffs: true, outputModality: "audio", includeStartupContext: false,
    transport: { type: "webrtc", sdp: pc.localDescription.sdp }, version: "v3",
  });
  if (st.error) { log("start_rejected", st.error); return finish("start_rejected"); }
  realtimeOn = true;
  const sdp = await sdpP;
  if (!sdp || sdp.method !== "thread/realtime/sdp") { log("no_sdp", sdp?.params ?? null); return finish("no_sdp"); }
  mark("answer_sdp");
  await pc.setRemoteDescription({ type: "answer", sdp: sdp.params.sdp });
  const started = await startedP; if (started) mark("realtime_started");
  const t_conn = Date.now(); while (!marks.pc_connected && Date.now() - t_conn < 10000) await sleep(50);
  if (!marks.pc_connected) return finish("pc_not_connected");

  // Background handoff: mirror TUI (client-managed): when the turn completes, append its final answer as speech.
  let turnCount = 0;
  handlers.push(async (m) => {
    if (m.method === "turn/started") {
      turnCount++; mark("bg_turn_started"); log("bg_turn_count", turnCount);
      if (turnCount > 1) { log("extra_turn_interrupted", {}); await rpc("turn/interrupt", { threadId, turnId: m.params?.turn?.id }); }
    }
    if (m.method === "turn/completed" && turnCount === 1 && !marks.bg_turn_completed) {
      mark("bg_turn_completed");
      const items = m.params?.turn?.items || [];
      const final = [...items].reverse().find((it) => it.type === "agentMessage" && (it.phase === "final_answer" || !it.phase));
      if (final?.text) { mark("append_speech_sent"); await rpc("thread/realtime/appendSpeech", { threadId, text: final.text }); }
      setTimeout(() => finish("result_spoken_window"), 9000);
    }
  });

  await sendPcm(silence(800));
  mark("speech_send_start");
  await sendPcm(readWavPcm(`${EXP}/q.wav`));
  mark("speech_send_end");
  // keep sending silence so server VAD sees end-of-turn and the stream stays alive
  const realtimeDeadline = marks.realtime_start_sent + 58000;
  while (!finished && Date.now() - t0 < realtimeDeadline) await sendPcm(silence(200));
  finish("realtime_60s_cap");
})().catch((e) => { log("fatal", String(e?.stack || e).slice(0, 1000)); finish("fatal"); });
