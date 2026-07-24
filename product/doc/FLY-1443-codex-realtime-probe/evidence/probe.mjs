#!/usr/bin/env node
// FLY-1443 probe v4 — fixes found by Codex design review R1:
//   - parse the real WAV `data` chunk (the input WAV has an FLLR filler chunk; data starts at 4096, not 44)
//   - wait event-driven for thread/realtime/started|error instead of a fixed sleep (removes the D start race)
//   - log EVERY audio delta's index + decoded byte length + sha256 (auditable without dumping base64)
//   - emit a run manifest (binary path + sha256, argv, env, cwd, input/output hashes)
//
// Usage: CODEX_BIN=<abs path> RT_VERSION=v2 RT_VOICE=marin RT_MODALITY=audio RT_MODE=audio node probe.mjs
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

const LOG = process.env.PROBE_LOG || "probe4.jsonl";
const MANIFEST = process.env.PROBE_MANIFEST || "probe4-manifest.json";
const VERSION = process.env.RT_VERSION || "v2";
const VOICE = process.env.RT_VOICE || "marin";
const MODALITY = process.env.RT_MODALITY || "audio";
const MODE = process.env.RT_MODE || "audio"; // audio | text
const IN_WAV = process.env.RT_IN_WAV || "probe-in.wav";
const OUT_WAV = process.env.RT_OUT_WAV || "probe4-out.wav";
writeFileSync(LOG, "");

const sha = (b) => createHash("sha256").update(b).digest("hex");
const audioOut = [];
function log(dir, obj) {
  appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), dir, obj }) + "\n");
  let s = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (s.length > 700) s = s.slice(0, 700) + `…[+${s.length - 700}]`;
  console.log(`${dir} ${s}`);
}

/** Parse RIFF chunks properly — do NOT assume a 44-byte header. */
function wavData(buf) {
  if (buf.subarray(0, 4).toString() !== "RIFF" || buf.subarray(8, 12).toString() !== "WAVE")
    throw new Error("not a RIFF/WAVE file");
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ")
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === "data") return { pcm: buf.subarray(body, body + size), dataOffset: body, fmt };
    off = body + size + (size & 1);
  }
  throw new Error("no data chunk");
}

// Gate negative-control switches (so "both gates are required" is measured, not asserted)
const NO_ENABLE_FLAG = process.env.PROBE_NO_ENABLE_FLAG === "1";       // gate 1 off
const NO_EXPERIMENTAL_API = process.env.PROBE_NO_EXPERIMENTAL_API === "1"; // gate 2 off
const CODEX_ARGS = NO_ENABLE_FLAG ? ["app-server"] : ["--enable", "realtime_conversation", "app-server"];
// Binary provenance is MEASURED here, not asserted by the caller:
// resolve the symlink chain ourselves, hash the real file, and spawn that absolute path.
const CODEX_REQUESTED = process.env.CODEX_BIN || execFileSync("/usr/bin/which", ["codex"]).toString().trim();
const CODEX_RESOLVED = realpathSync(CODEX_REQUESTED);
const CODEX_SHA = sha(readFileSync(CODEX_RESOLVED));
const child = spawn(CODEX_RESOLVED, CODEX_ARGS, { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const waiters = new Map();
const events = []; // realtime lifecycle events, for event-driven waiting
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "thread/realtime/outputAudio/delta") {
      const p = m.params || {};
      const b64 = p.audio?.data ?? p.data ?? p.delta ?? "";
      const bytes = Buffer.from(b64, "base64");
      audioOut.push(bytes);
      // auditable per-chunk record, no base64 dump
      log("<<AUDIO", { index: audioOut.length - 1, base64Chars: b64.length, decodedBytes: bytes.length, sha256: sha(bytes) });
      continue;
    }
    if (m.method?.startsWith("mcpServer/") || m.method === "thread/started" || m.method === "warning") continue;
    log("<<", m);
    if (m.method?.startsWith("thread/realtime/")) events.push(m);
    if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
child.stderr.on("data", (d) => {
  const s = d.toString().replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (s) log("ERR", s);
});
child.on("exit", (code, sig) => log("EXIT", { code, sig }));

let nextId = 1;
function send(method, params, { redactParams = false } = {}) {
  const id = nextId++;
  log(">>", { id, method, params: redactParams ? "<redacted: audio chunk, see <<AUDIO-IN record>>" : params });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((r) => {
    waiters.set(id, r);
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); r({ __timeout: true, id, method }); } }, 30000);
  });
}
const notify = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Event-driven: resolve as soon as started OR error arrives. No fixed sleep, no race. */
function waitForStartOutcome(timeoutMs = 25000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const ev = events.find((e) => e.method === "thread/realtime/started" || e.method === "thread/realtime/error");
      if (ev) return resolve({ outcome: ev.method === "thread/realtime/started" ? "started" : "error", event: ev, waitedMs: Date.now() - t0 });
      if (Date.now() - t0 > timeoutMs) return resolve({ outcome: "timeout", event: null, waitedMs: Date.now() - t0 });
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function main() {
  const inBuf = readFileSync(IN_WAV);
  const { pcm, dataOffset, fmt } = wavData(inBuf);
  if (MODE === "audio") {
    if (!pcm.length) throw new Error(`input WAV has 0 audio bytes (data chunk at ${dataOffset}) — refusing to run`);
    if (fmt.bits !== 16 || fmt.channels !== 1) throw new Error(`input WAV must be PCM16 mono, got bits=${fmt.bits} channels=${fmt.channels}`);
    if (fmt.sampleRate !== 24000) throw new Error(`input WAV must be 24000 Hz, got ${fmt.sampleRate}`);
  }
  const manifest = {
    issue: "FLY-1443",
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    codexRequested: CODEX_REQUESTED,
    codexResolved: CODEX_RESOLVED,
    codexSha256: CODEX_SHA,            // computed here from the file we actually spawn
    codexArgv: [CODEX_RESOLVED, ...CODEX_ARGS],
    probeScriptSha256: sha(readFileSync(new URL(import.meta.url))),
    params: { version: VERSION, voice: VOICE, outputModality: MODALITY, mode: MODE, transport: "websocket" },
    gates: { enableFlag: !NO_ENABLE_FLAG, experimentalApiCapability: !NO_EXPERIMENTAL_API },
    input: { file: IN_WAV, sha256: sha(inBuf), dataOffset, fmt, pcmBytes: pcm.length },
  };

  await send("initialize", {
    clientInfo: { name: "fly1443-probe", title: "FLY-1443 realtime probe", version: "0.0.1" },
    ...(NO_EXPERIMENTAL_API ? {} : { capabilities: { experimentalApi: true } }),
  });
  notify("initialized", {});
  await sleep(400);

  const th = await send("thread/start", {});
  const threadId = th?.result?.thread?.id;

  const startParams = { threadId, transport: { type: "websocket" }, outputModality: MODALITY, voice: VOICE, version: VERSION };
  const startResp = await send("thread/realtime/start", startParams);
  manifest.startRequestResponse = startResp?.error ? { error: startResp.error } : { result: startResp?.result ?? null };
  if (startResp?.error) {
    log("GATE-RESULT", { gates: manifest.gates, rejectedAtRequest: true, error: startResp.error });
    manifest.result = { rejectedAtRequest: true };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    return finish(0);
  }

  // EVENT-DRIVEN wait — this is the fix for the D start race
  const outcome = await waitForStartOutcome();
  log("START-OUTCOME", { outcome: outcome.outcome, waitedMs: outcome.waitedMs, event: outcome.event });
  manifest.startOutcome = { outcome: outcome.outcome, waitedMs: outcome.waitedMs, message: outcome.event?.params?.message ?? null };

  if (outcome.outcome !== "started") {
    log("STEP", { step: "aborting-input", reason: `realtime start did not succeed (${outcome.outcome})` });
    manifest.result = { aborted: true };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    await send("thread/realtime/stop", { threadId });
    await sleep(1000);
    return finish(0);
  }

  if (MODE === "audio") {
    const SILENCE = Buffer.alloc((fmt.sampleRate || 24000) * (fmt.channels || 1) * 2 * 2); // 2s
    const stream = Buffer.concat([pcm, SILENCE]);
    const CHUNK = 4800 * 2;
    const total = Math.ceil(stream.length / CHUNK);
    log("STEP", { step: "feeding-external-audio", pcmBytes: pcm.length, silenceBytes: SILENCE.length, streamBytes: stream.length, totalChunks: total });
    let sent = 0;
    for (let off = 0; off < stream.length; off += CHUNK) {
      const slice = stream.subarray(off, Math.min(off + CHUNK, stream.length));
      log("<<AUDIO-IN", { index: sent, decodedBytes: slice.length, sha256: sha(slice), isSilenceTail: off >= pcm.length });
      const res = await send("thread/realtime/appendAudio", {
        threadId, audio: { data: slice.toString("base64"), sampleRate: fmt.sampleRate, numChannels: fmt.channels, samplesPerChannel: slice.length / 2 },
      }, { redactParams: true });
      sent++;
      if (res?.error) { log("STEP", { step: "appendAudio-REJECTED", index: sent - 1, response: res }); break; }
      await sleep(60);
    }
    manifest.input.chunksSent = sent;
    log("STEP", { step: "audio-fed", chunksSent: sent });
  } else {
    await send("thread/realtime/appendText", { threadId, text: "Reply out loud with: flywheel probe ok." });
  }

  await sleep(35000);
  const outPcm = Buffer.concat(audioOut);
  manifest.result = { audioOutChunks: audioOut.length, audioOutBytes: outPcm.length, audioOutSha256: outPcm.length ? sha(outPcm) : null, approxSeconds: +(outPcm.length / 2 / 24000).toFixed(2) };
  log("RESULT", manifest.result);

  if (outPcm.length) {
    const hdr = Buffer.alloc(44);
    hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + outPcm.length, 4); hdr.write("WAVE", 8);
    hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(24000, 24); hdr.writeUInt32LE(24000 * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
    hdr.write("data", 36); hdr.writeUInt32LE(outPcm.length, 40);
    const wav = Buffer.concat([hdr, outPcm]);
    writeFileSync(OUT_WAV, wav);
    manifest.output = { file: OUT_WAV, sha256: sha(wav), bytes: wav.length };
    log("RESULT", { wroteWav: OUT_WAV, sha256: manifest.output.sha256 });
  }

  await send("thread/realtime/stop", { threadId });
  await sleep(1500);
  manifest.finishedAt = new Date().toISOString();
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  finish(0);
}
function finish(c) {
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} process.exit(c); }, 1200);
}
main().catch((e) => { log("THROW", String(e)); finish(1); });
