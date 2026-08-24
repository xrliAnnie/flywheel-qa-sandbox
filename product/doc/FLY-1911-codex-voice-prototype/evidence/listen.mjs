#!/usr/bin/env node
// FLY-1911 rung-2b: feed real speech IN (thread/realtime/appendAudio) and see whether
// Codex transcribes it (role=user) and answers by voice. Proves the EARS, not just the mouth.
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

const OUT   = process.env.OUT || "listen";
const IN    = process.env.IN_WAV || "probe-in.wav";
const VERSION = process.env.RT_VERSION || "v2";
const VOICE   = process.env.RT_VOICE   || "marin";
const TRANSPORT = process.env.RT_TRANSPORT || "websocket";
const CHUNK_MS = Number(process.env.CHUNK_MS || 100);
const TAIL_SILENCE_MS = Number(process.env.TAIL_SILENCE_MS || 1500);
const HOLD_MS = Number(process.env.HOLD_MS || 30000);
const REALTIME_PACE = process.env.REALTIME_PACE !== "0";

const LOG = `${OUT}.jsonl`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (dir, obj) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), dir, obj }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODEX_BIN = process.env.CODEX_BIN
  || "/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const CODEX_RESOLVED = realpathSync(CODEX_BIN);
const ARGS = ["--enable", "realtime_conversation", "app-server"];
const child = spawn(CODEX_RESOLVED, ARGS, { stdio: ["pipe", "pipe", "pipe"] });

const audioChunks = [], transcripts = [], events = [], approvals = [];
let t0 = Date.now(), inputDoneAt = null, firstUserTxAt = null, firstAudioAt = null;

let buf = "";
const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString(); let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method?.startsWith("mcpServer/")) continue;
    if (m.method === "thread/realtime/outputAudio/delta") {
      const a = m.params?.audio || {};
      if (firstAudioAt === null) firstAudioAt = Date.now();
      audioChunks.push({ raw: Buffer.from(a.data || "", "base64"), sampleRate: a.sampleRate, numChannels: a.numChannels });
      continue;
    }
    if (m.method === "thread/realtime/transcript/delta" || m.method === "thread/realtime/transcript/done") {
      const p = m.params || {}, kind = m.method.endsWith("done") ? "done" : "delta";
      if (p.role === "user" && firstUserTxAt === null) firstUserTxAt = Date.now();
      transcripts.push({ kind, role: p.role, text: p.text ?? p.delta, tMs: Date.now() - t0 });
      if (kind === "done") log("<<TX-DONE", { role: p.role, text: p.text, tMs: Date.now() - t0 });
      continue;
    }
    // 它干活时会请求批准(联网/执行命令)。原型里自动放行,并把每一条原样记下来。
    // ⚠️ 这一步在产品里必须是策略门,不是自动 yes —— 见 FLY-1453 的读取面。
    if (m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval") {
      approvals.push({ method: m.method, reason: m.params?.reason ?? null, itemId: m.params?.itemId ?? null, tMs: Date.now() - t0 });
      log("APPROVE", approvals[approvals.length - 1]);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { decision: "acceptForSession" } }) + "\n");
      continue;
    }
    if (m.method === "thread/realtime/sdp") { log("<<SDP", { chars: String(m.params?.sdp||"").length }); events.push(m); continue; }
    log("<<", m);
    if (m.method?.startsWith("thread/realtime/")) events.push(m);
    if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
child.stderr.on("data", (d) => { const s = d.toString().replace(/\x1b\[[0-9;]*m/g, "").trim(); if (s) log("ERR", s); });
child.on("exit", (c, s) => log("EXIT", { code: c, sig: s }));

let nextId = 1;
function send(method, params, quiet) {
  const id = nextId++;
  if (!quiet) log(">>", { id, method, params });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((r) => { waiters.set(id, r); setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); r({ __timeout: true }); } }, 30000); });
}
const notify = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");

function readWavPcm(path) {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a RIFF wav");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { audioFormat: b.readUInt16LE(off+8), numChannels: b.readUInt16LE(off+10), sampleRate: b.readUInt32LE(off+12), bits: b.readUInt16LE(off+22) };
    if (id === "data") data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("wav missing fmt/data");
  if (fmt.audioFormat !== 1 || fmt.bits !== 16) throw new Error("need pcm_s16le");
  return { ...fmt, pcm: data };
}
function writeWav(path, chunks) {
  if (!chunks.length) return null;
  const sampleRate = chunks[0].sampleRate || 24000, numChannels = chunks[0].numChannels || 1;
  const pcm = Buffer.concat(chunks.map((c) => c.raw)), byteRate = sampleRate * numChannels * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF",0); h.writeUInt32LE(36+pcm.length,4); h.write("WAVE",8); h.write("fmt ",12);
  h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(numChannels,22); h.writeUInt32LE(sampleRate,24);
  h.writeUInt32LE(byteRate,28); h.writeUInt16LE(numChannels*2,32); h.writeUInt16LE(16,34); h.write("data",36); h.writeUInt32LE(pcm.length,40);
  writeFileSync(path, Buffer.concat([h, pcm]));
  return { path, bytes: pcm.length, sampleRate, durationSec: +(pcm.length/byteRate).toFixed(2) };
}

async function main() {
  const src = readWavPcm(IN);
  const manifest = {
    issue: "FLY-1911", probe: "listen — does it hear real speech?",
    startedAt: new Date().toISOString(), codexResolved: CODEX_RESOLVED,
    codexSha256: sha(readFileSync(CODEX_RESOLVED)), codexArgv: [CODEX_RESOLVED, ...ARGS],
    probeSha256: sha(readFileSync(new URL(import.meta.url))),
    params: { version: VERSION, voice: VOICE, transport: TRANSPORT, chunkMs: CHUNK_MS, realtimePace: REALTIME_PACE },
    input: { path: IN, sha256: sha(readFileSync(IN)), sampleRate: src.sampleRate, numChannels: src.numChannels,
             durationSec: +(src.pcm.length/(src.sampleRate*src.numChannels*2)).toFixed(2),
             expectedText: process.env.EXPECT_TEXT || null },
  };
  await send("initialize", { clientInfo: { name: "fly1911-listen", title: "FLY-1911 listen probe", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  notify("initialized", {}); await sleep(300);
  const th = await send("thread/start", {});
  const threadId = th?.result?.thread?.id ?? null;
  manifest.threadId = threadId;
  if (!threadId) { manifest.result = { threadStartFailed: true }; return done(manifest, 1); }

  let transport = { type: "websocket" };
  if (TRANSPORT === "webrtc") {
    const { RTCPeerConnection } = await import("werift");
    const pc = new RTCPeerConnection({}); pc.addTransceiver("audio", { direction: "sendrecv" });
    const o = await pc.createOffer(); await pc.setLocalDescription(o);
    transport = { type: "webrtc", sdp: pc.localDescription.sdp }; globalThis.__pc = pc;
  }
  t0 = Date.now();
  const startParams = { threadId, transport, outputModality: "audio", voice: VOICE, version: VERSION };
  if (process.env.START_INSTRUCTIONS) startParams.realtimeStartInstructions = process.env.START_INSTRUCTIONS;
  const startResp = await send("thread/realtime/start", startParams);
  if (startResp?.error) { manifest.result = { admitted: false, error: startResp.error }; return done(manifest, 0); }
  const s = Date.now();
  while (!events.find((e) => e.method === "thread/realtime/started" || e.method === "thread/realtime/error")) {
    if (Date.now() - s > 25000) break; await sleep(50);
  }
  const ev = events.find((e) => e.method === "thread/realtime/started" || e.method === "thread/realtime/error");
  manifest.startOutcome = { outcome: ev?.method.endsWith("started") ? "started" : (ev ? "error" : "timeout"), message: ev?.params?.message ?? null, version: ev?.params?.version ?? null, waitedMs: Date.now() - s };
  log("START-OUTCOME", manifest.startOutcome);
  if (manifest.startOutcome.outcome !== "started") { manifest.result = { admitted: false }; return done(manifest, 0); }
  manifest.result = { admitted: true };
  await sleep(400);

  // stream the wav in, paced like a live mic
  const bytesPerChunk = Math.floor(src.sampleRate * src.numChannels * 2 * CHUNK_MS / 1000);
  const sendStart = Date.now(); let sent = 0;
  for (let off = 0; off < src.pcm.length; off += bytesPerChunk) {
    const slice = src.pcm.subarray(off, Math.min(off + bytesPerChunk, src.pcm.length));
    send("thread/realtime/appendAudio", { threadId, audio: { data: slice.toString("base64"), sampleRate: src.sampleRate, numChannels: src.numChannels, samplesPerChannel: slice.length / 2 / src.numChannels } }, true);
    sent++;
    if (REALTIME_PACE) await sleep(CHUNK_MS);
  }
  // tail silence so server-side VAD sees end-of-speech
  const silence = Buffer.alloc(bytesPerChunk);
  for (let i = 0; i < Math.ceil(TAIL_SILENCE_MS / CHUNK_MS); i++) {
    send("thread/realtime/appendAudio", { threadId, audio: { data: silence.toString("base64"), sampleRate: src.sampleRate, numChannels: src.numChannels, samplesPerChannel: silence.length / 2 } }, true);
    if (REALTIME_PACE) await sleep(CHUNK_MS);
  }
  inputDoneAt = Date.now();
  log("INPUT-DONE", { chunksSent: sent, silenceMs: TAIL_SILENCE_MS, wallMs: inputDoneAt - sendStart });

  const holdUntil = Date.now() + HOLD_MS;
  let last = -1, quiet = Date.now();
  while (Date.now() < holdUntil) {
    await sleep(300);
    const n = audioChunks.length + transcripts.length;
    if (n !== last) { last = n; quiet = Date.now(); }
    else if (transcripts.some(x => x.kind==="done" && x.role==="assistant") && Date.now() - quiet > 3000) break;
  }

  const wav = writeWav(`${OUT}-reply.wav`, audioChunks);
  manifest.heard = transcripts.filter((x) => x.kind === "done" && x.role === "user").map((x) => x.text);
  manifest.said  = transcripts.filter((x) => x.kind === "done" && x.role === "assistant").map((x) => x.text);
  manifest.allDoneTranscripts = transcripts.filter((x) => x.kind === "done");
  manifest.latency = {
    inputDoneToFirstUserTranscriptMs: firstUserTxAt ? firstUserTxAt - inputDoneAt : null,
    inputDoneToFirstReplyAudioMs: firstAudioAt ? firstAudioAt - inputDoneAt : null,
  };
  manifest.replyAudio = wav ? { ...wav, chunks: audioChunks.length } : null;
  manifest.approvals = approvals;
  await send("thread/realtime/stop", { threadId }); await sleep(800);
  try { globalThis.__pc?.close(); } catch {}
  manifest.finishedAt = new Date().toISOString();
  done(manifest, 0);
}
function done(manifest, code) {
  writeFileSync(`${OUT}-manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ result: manifest.result, startOutcome: manifest.startOutcome, heard: manifest.heard, said: manifest.said, latency: manifest.latency, replyAudio: manifest.replyAudio }, null, 1));
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} process.exit(code); }, 1000);
}
main().catch((e) => { log("THROW", String(e?.stack||e)); console.error(e); done({ threw: String(e) }, 1); });
