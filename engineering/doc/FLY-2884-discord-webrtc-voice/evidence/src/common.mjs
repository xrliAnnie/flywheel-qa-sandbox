// FLY-2884 prototype — shared helpers (throwaway; not product code).
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { performance } from "node:perf_hooks";

export const ROOT = "/tmp/fly2884-proto";
export const GUILD_ID = "1485787271192907816";
export const VOICE_CHANNEL_ID = "1542709028742893699"; // voice-test-3 (slot 3)
export const BOT1_ID = "1493068669444427927"; // flywheel-test-1 = synthetic speaker
export const BOT3_ID = "1493075160025272452"; // flywheel-test-3 = prototype bridge
export const FOUNDER_ID = "1138241636057481306";
export const now = () => performance.now(); // monotonic, in-process only

// ---- secrets: read from ~/.flywheel/.env into memory only ----
export function loadEnvToken(name) {
  const text = readFileSync(`${process.env.HOME}/.flywheel/.env`, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=["']?([^"'\n]+)["']?\s*$/);
    if (m && m[1] === name) return m[2].trim();
  }
  throw new Error(`token_missing:${name}`);
}

// ---- logger with exact-value redaction ----
export function makeLogger(dir, name, secrets) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = `${dir}/${name}`;
  writeFileSync(path, "", { mode: 0o600 });
  const t0 = now();
  const scrub = (s) => {
    for (const v of secrets()) if (v && v.length >= 8) s = s.split(v).join("***");
    return s
      .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***")
      .replace(/eyJ[A-Za-z0-9_\-.]{20,}/g, "jwt-***")
      .replace(/(Bot|Bearer)\s+[A-Za-z0-9._\-]{20,}/g, "$1 ***")
      .replace(/"(access_token|refresh_token|id_token|token|authorization|Authorization)"\s*:\s*"[^"]*"/g, '"$1":"***"');
  };
  const log = (kind, data) =>
    appendFileSync(path, scrub(JSON.stringify({ t: +((now() - t0) / 1000).toFixed(3), wall: Date.now(), kind, data })) + "\n");
  return { log, t0, path };
}

// ---- Opus TOC → samples @48k (RFC 6716 §3.1) ----
export function opusSamples(pkt) {
  if (!pkt || pkt.length < 1) return 0;
  const toc = pkt[0];
  const config = toc >> 3;
  let ms;
  if (config < 12) ms = [10, 20, 40, 60][config & 3];
  else if (config < 16) ms = [10, 20][config & 1];
  else ms = [2.5, 5, 10, 20][config & 3];
  const code = toc & 3;
  let frames = code === 0 ? 1 : code === 3 ? (pkt.length > 1 ? pkt[1] & 0x3f : 0) : 2;
  return Math.round(ms * 48 * frames);
}
export const opusStereoFlag = (pkt) => (pkt?.[0] >> 2) & 1;

// ---- PCM helpers ----
export function stereoToMono(stereo) {
  const n = stereo.length / 4, mono = Buffer.alloc(n * 2);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const v = (stereo.readInt16LE(i * 4) + stereo.readInt16LE(i * 4 + 2)) >> 1;
    mono.writeInt16LE(v, i * 2); ss += v * v;
  }
  return { mono, rms: Math.sqrt(ss / Math.max(1, n)), samples: n };
}
export function wav(pcm, rate = 48000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export function readWavPcm(path) {
  const b = readFileSync(path); let o = 12;
  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "data") return b.subarray(o + 8, o + 8 + sz);
    o += 8 + sz + (sz % 2);
  }
  throw new Error("no data chunk");
}
export function monoRms(pcm) {
  let ss = 0; const n = pcm.length / 2;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); ss += v * v; }
  return Math.sqrt(ss / Math.max(1, n));
}

// ---- speech segmentation (plan §2.2): voiced ≥200ms to open, 400ms hangover to close ----
export function segments(frames, th, { minVoicedMs = 200, hangoverMs = 400 } = {}) {
  // frames: [{t (ms, monotonic), rms}] sorted
  const out = []; let cur = null;
  for (const f of frames) {
    const voiced = f.rms > th;
    if (voiced) {
      if (cur && f.t - cur.lastVoiced <= hangoverMs) { cur.lastVoiced = f.t; cur.voicedMs += 20; }
      else { if (cur) out.push(cur); cur = { start: f.t, lastVoiced: f.t, voicedMs: 20 }; }
    }
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.voicedMs >= minVoicedMs).map((s) => ({ start: +s.start.toFixed(1), end: +s.lastVoiced.toFixed(1), voicedMs: s.voicedMs }));
}
export function calibrate(frames, n = 150) {
  const first = frames.slice(0, n).map((f) => f.rms).sort((a, b) => a - b);
  const med = first.length ? first[Math.floor(first.length / 2)] : 0;
  return { floorMedian: +med.toFixed(1), th: Math.max(300, 3 * med) };
}

// ---- room fail-closed precheck (plan §7) ----
export function voiceRoomCheck(guild, { allowInChannel, mustNotBeInVoice }) {
  const states = [...guild.voiceStates.cache.values()].filter((s) => s.channelId);
  const inTarget = states.filter((s) => s.channelId === VOICE_CHANNEL_ID).map((s) => s.id);
  const intruders = inTarget.filter((id) => !allowInChannel.includes(id));
  const busy = states.filter((s) => mustNotBeInVoice.includes(s.id)).map((s) => ({ id: s.id, channelId: s.channelId }));
  return { at: new Date().toISOString(), guildId: guild.id, channelId: VOICE_CHANNEL_ID, inTarget, intruders, busy, ok: intruders.length === 0 && busy.length === 0 };
}
