#!/usr/bin/env node
// FLY-1911 rung-2c: ONE session, two questions —
//   (a) barge-in: while it is speaking, start talking; how long until its audio stops?
//   (b) long session: hold the line for N minutes with periodic exchanges; does it drop or degrade?
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

const OUT = process.env.OUT || "bargein";
const IN  = process.env.IN_WAV || "probe-in.wav";
const VERSION = process.env.RT_VERSION || "v2";
const VOICE = process.env.RT_VOICE || "marin";
const HOLD_MIN = Number(process.env.HOLD_MIN || 5);
const PING_EVERY_MS = Number(process.env.PING_EVERY_MS || 60000);
const LOG = `${OUT}.jsonl`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (dir, obj) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), dir, obj }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODEX_BIN = process.env.CODEX_BIN || "/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const CODEX_RESOLVED = realpathSync(CODEX_BIN);
const ARGS = ["--enable", "realtime_conversation", "app-server"];
const child = spawn(CODEX_RESOLVED, ARGS, { stdio: ["pipe", "pipe", "pipe"] });

const events = [], transcripts = [], audioLog = [];
let t0 = Date.now(), lastAudioAt = null, audioCount = 0;
let buf = ""; const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString(); let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method?.startsWith("mcpServer/")) continue;
    if (m.method === "thread/realtime/outputAudio/delta") {
      audioCount++; lastAudioAt = Date.now();
      audioLog.push({ n: audioCount, tMs: lastAudioAt - t0, bytes: Buffer.from(m.params?.audio?.data || "", "base64").length });
      continue;
    }
    if (m.method?.startsWith("thread/realtime/transcript/")) {
      const p = m.params || {}, kind = m.method.endsWith("done") ? "done" : "delta";
      transcripts.push({ kind, role: p.role, text: p.text ?? p.delta, tMs: Date.now() - t0 });
      if (kind === "done") log("<<TX-DONE", { role: p.role, text: p.text, tMs: Date.now() - t0 });
      continue;
    }
    if (m.method === "thread/realtime/sdp") { events.push(m); continue; }
    if (m.method === "thread/realtime/closed" || m.method === "thread/realtime/error" || m.method === "thread/realtime/started") { log("<<", m); events.push(m); }
    else if (m.method === "error" || m.method === "turn/completed") log("<<", { method: m.method, params: m.params?.error ?? m.params?.turn?.status });
    if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
child.stderr.on("data", (d) => { const s = d.toString().replace(/\x1b\[[0-9;]*m/g, "").trim(); if (s) log("ERR", s.slice(0, 400)); });
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
  const b = readFileSync(path); let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { numChannels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12) };
    if (id === "data") data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  } return { ...fmt, pcm: data };
}

async function main() {
  const src = readWavPcm(IN);
  const manifest = { issue: "FLY-1911", probe: "barge-in + long session", startedAt: new Date().toISOString(),
    codexResolved: CODEX_RESOLVED, codexSha256: sha(readFileSync(CODEX_RESOLVED)),
    probeSha256: sha(readFileSync(new URL(import.meta.url))),
    params: { version: VERSION, voice: VOICE, holdMinutes: HOLD_MIN } };
  await send("initialize", { clientInfo: { name: "fly1911-bargein", title: "FLY-1911 barge-in probe", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  notify("initialized", {}); await sleep(300);
  const th = await send("thread/start", {}); const threadId = th?.result?.thread?.id;
  manifest.threadId = threadId; t0 = Date.now();
  await send("thread/realtime/start", { threadId, transport: { type: "websocket" }, outputModality: "audio", voice: VOICE, version: VERSION });
  const s = Date.now();
  while (!events.find(e => e.method === "thread/realtime/started" || e.method === "thread/realtime/error") && Date.now() - s < 25000) await sleep(50);
  const ev = events.find(e => e.method === "thread/realtime/started" || e.method === "thread/realtime/error");
  manifest.startOutcome = { outcome: ev?.method.endsWith("started") ? "started" : "error", version: ev?.params?.version, waitedMs: Date.now() - s };
  if (manifest.startOutcome.outcome !== "started") return done(manifest, 0);
  await sleep(400);

  // (a) make it talk for a while
  await send("thread/realtime/appendSpeech", { threadId, text: "请你用一整段话,慢慢地、详细地介绍一下你自己能帮我做什么,至少说三十秒,不要停。" });
  const talkStart = Date.now();
  while (audioCount === 0 && Date.now() - talkStart < 20000) await sleep(50);
  manifest.bargein = { sawAudio: audioCount > 0, firstAudioMs: audioCount ? audioLog[0].tMs : null };
  if (!audioCount) { manifest.bargein.note = "never started speaking; barge-in not testable"; }
  else {
    await sleep(2500);                       // let it get going
    const before = audioCount;
    const bargeAt = Date.now();
    log("BARGE-IN", { at: bargeAt - t0, audioChunksSoFar: before });
    // start talking over it, paced like a live mic
    const bytesPerChunk = Math.floor(src.sampleRate * src.numChannels * 2 * 100 / 1000);
    for (let off = 0; off < src.pcm.length; off += bytesPerChunk) {
      const sl = src.pcm.subarray(off, Math.min(off + bytesPerChunk, src.pcm.length));
      send("thread/realtime/appendAudio", { threadId, audio: { data: sl.toString("base64"), sampleRate: src.sampleRate, numChannels: src.numChannels, samplesPerChannel: sl.length / 2 / src.numChannels } }, true);
      await sleep(100);
      if (lastAudioAt && Date.now() - lastAudioAt > 700 && audioCount > before) break; // output went quiet
    }
    const stoppedAt = lastAudioAt;
    manifest.bargein.chunksBefore = before;
    manifest.bargein.chunksAtBarge = audioCount;
    manifest.bargein.lastOutputAudioAfterBargeMs = stoppedAt ? stoppedAt - bargeAt : null;
    log("BARGE-RESULT", manifest.bargein);
  }

  // (b) long session: hold and ping
  const holdUntil = Date.now() + HOLD_MIN * 60000;
  const pings = []; let ping = 0;
  while (Date.now() < holdUntil) {
    await sleep(PING_EVERY_MS);
    if (Date.now() >= holdUntil) break;
    if (events.find(e => e.method === "thread/realtime/closed")) break;
    ping++;
    const before = audioCount, tSend = Date.now();
    await send("thread/realtime/appendSpeech", { threadId, text: `第 ${ping} 次确认,你还在吗?简短回一句。` });
    const wStart = Date.now();
    while (audioCount === before && Date.now() - wStart < 20000) await sleep(50);
    const got = audioCount > before;
    pings.push({ ping, atMinute: +((Date.now() - t0) / 60000).toFixed(1), replied: got, firstAudioLatencyMs: got ? lastAudioAt - tSend : null });
    log("PING", pings[pings.length - 1]);
    await sleep(4000);
  }
  manifest.longSession = {
    heldMinutes: +((Date.now() - t0) / 60000).toFixed(1),
    pings,
    closedEvent: events.find(e => e.method === "thread/realtime/closed")?.params ?? null,
    errorEvents: events.filter(e => e.method === "thread/realtime/error").map(e => e.params),
    totalAudioChunks: audioCount,
  };
  manifest.transcriptDone = transcripts.filter(x => x.kind === "done");
  await send("thread/realtime/stop", { threadId }); await sleep(800);
  manifest.finishedAt = new Date().toISOString();
  done(manifest, 0);
}
function done(manifest, code) {
  writeFileSync(`${OUT}-manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ startOutcome: manifest.startOutcome, bargein: manifest.bargein, longSession: manifest.longSession }, null, 1));
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} process.exit(code); }, 1000);
}
main().catch((e) => { log("THROW", String(e?.stack||e)); console.error(e); done({ threw: String(e) }, 1); });
