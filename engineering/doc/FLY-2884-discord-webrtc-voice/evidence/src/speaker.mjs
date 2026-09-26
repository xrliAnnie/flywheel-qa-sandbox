// FLY-2884 prototype "speaker": bot1 joins voice-test-3 as a stand-in human. It plays synthetic speech / ambient
// noise into the room (Opus via AudioPlayer) and records what bot3 (the bridge) says IN THE ROOM.
// All room metrics are computed in this process on its own monotonic clock.
// Usage: node speaker.mjs <run-name> <mode>   (mode: smoke|latency|barge|noise|stability)
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import OpusScript from "opusscript";
import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType, createAudioPlayer,
  createAudioResource, StreamType, AudioPlayerStatus,
} from "@discordjs/voice";
import {
  ROOT, GUILD_ID, VOICE_CHANNEL_ID, BOT1_ID, BOT3_ID, now, loadEnvToken, makeLogger, stereoToMono, wav,
  readWavPcm, monoRms, segments, calibrate, voiceRoomCheck,
} from "./common.mjs";

const RUN = process.argv[2] || "x";
const MODE = process.argv[3] || "smoke";
const DIR = `${ROOT}/runs/${RUN}`;
const A = `${ROOT}/audio`;
const TOKEN = loadEnvToken("TEST_BOT_TOKEN_1");
const { log } = makeLogger(DIR, "speaker.jsonl", () => [TOKEN]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const roomFrames = []; // {t, rms} from bot3 as heard in the room
const roomPcm = [];
const utterances = []; // {label, kind, playStart, lastVoicedPull, playEnd, wallStart, wallEnd}
const barge = []; // live-decision records
let roomTh = 300, stopping = false, connection, client, player;

function roomVoicedWithin(ms) {
  const t = now();
  for (let i = roomFrames.length - 1; i >= 0 && t - roomFrames[i].t <= ms; i--) if (roomFrames[i].rms > roomTh) return true;
  return false;
}
async function waitRoomSpeechStart(afterT, timeoutMs) {
  const end = now() + timeoutMs;
  while (now() < end) {
    // ≥200ms of voiced frames (10 frames) after afterT within a 400ms hangover window
    const fr = roomFrames.filter((f) => f.t > afterT);
    const segs = segments(fr, roomTh);
    if (segs.length) return segs[0].start;
    await sleep(50);
  }
  return null;
}
async function waitRoomSilence(silentMs, timeoutMs) {
  const end = now() + timeoutMs;
  while (now() < end) { if (!roomVoicedWithin(silentMs)) return true; await sleep(100); }
  return false;
}

// ---- playback: pre-encode a WAV to Opus packets; record the pull time of every packet ----
const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
function encodeWav(path) {
  const pcm = readWavPcm(path); const pkts = [];
  for (let o = 0; o + 1920 <= pcm.length; o += 1920) {
    const mono = pcm.subarray(o, o + 1920), st = Buffer.alloc(3840);
    for (let i = 0; i < 960; i++) { const v = mono.readInt16LE(i * 2); st.writeInt16LE(v, i * 4); st.writeInt16LE(v, i * 4 + 2); }
    pkts.push({ opus: Buffer.from(enc.encode(st, 960)), voiced: monoRms(mono) > 300 });
  }
  return pkts;
}
function play(label, file, kind = "speech") {
  const pkts = encodeWav(`${A}/${file}`);
  const rec = { label, file, kind, frames: pkts.length, playStart: null, lastVoicedPull: null, playEnd: null, wallStart: Date.now(), wallEnd: null };
  utterances.push(rec);
  let i = 0;
  const stream = new Readable({ objectMode: true, read() {
    if (i >= pkts.length) { this.push(null); return; }
    const t = now(); if (rec.playStart === null) rec.playStart = +t.toFixed(1);
    if (pkts[i].voiced) rec.lastVoicedPull = +t.toFixed(1);
    this.push(pkts[i++].opus);
  } });
  return new Promise((resolve) => {
    const done = () => { rec.playEnd = +now().toFixed(1); rec.wallEnd = Date.now(); log("played", rec); player.off(AudioPlayerStatus.Idle, done); resolve(rec); };
    player.on(AudioPlayerStatus.Idle, done);
    player.play(createAudioResource(stream, { inputType: StreamType.Opus }));
    log("play_start", { label, file, kind });
  });
}
async function ask(label, file, { answerTimeout = 30000, settle = 2500 } = {}) {
  const u = await play(label, file);
  const s = await waitRoomSpeechStart(u.lastVoicedPull ?? u.playEnd, answerTimeout);
  log("room_answer_start", { label, at: s });
  if (s !== null) await waitRoomSilence(settle, 60000);
  return u;
}
function bridgeLogHas(re) {
  try { return re.test(readFileSync(`${DIR}/bridge.jsonl`, "utf8")); } catch { return false; }
}

// ---- scenarios ----
const scenarios = {
  async smoke() { await sleep(3000); await ask("q1", "q1.wav"); await sleep(2000); },
  async latency() {
    await sleep(3000);
    for (const q of ["q1", "q2", "q3", "q4", "q5"]) { await ask(q, `${q}.wav`); await sleep(2000); }
    const u = await play("bg", "bg.wav");
    await waitRoomSpeechStart(u.lastVoicedPull, 20000);
    const end = now() + 90000;
    while (now() < end && !bridgeLogHas(/append_speech_sent/)) await sleep(250);
    log("bg_result_appended_seen", { ok: bridgeLogHas(/append_speech_sent/) });
    await sleep(1500); await waitRoomSilence(3000, 60000); await sleep(1000);
  },
  async barge() {
    await sleep(3000);
    let valid = 0, attempt = 0;
    const longs = process.env.BARGE_SET === "fg" ? ["flong1", "flong2", "flong3", "flong4", "flong5", "flong6", "flong7", "flong8"] : ["long1", "long2", "long3", "long4", "long5"];
    const maxAttempts = process.env.BARGE_SET === "fg" ? 8 : 9;
    while (valid < (process.env.BARGE_SET === "fg" ? 8 : 5) && attempt < maxAttempts) {
      attempt++; const ln = longs[(attempt - 1) % longs.length];
      const u = await play(ln, `${ln}.wav`);
      const s = await waitRoomSpeechStart(u.lastVoicedPull, 20000);
      if (s === null) { barge.push({ attempt, valid: false, reason: "no_answer" }); await waitRoomSilence(2500, 30000); continue; }
      const target = s + 2000 + Math.random() * 1000;
      while (now() < target) await sleep(10);
      const playing = roomVoicedWithin(300) && roomFrames.filter((f) => f.t >= s && f.t <= now()).filter((f) => f.rms > roomTh).length >= 50;
      if (!playing) { barge.push({ attempt, valid: false, reason: "answer_not_playing", answerStart: s }); log("barge_invalid", { attempt }); await waitRoomSilence(2500, 30000); await sleep(1000); continue; }
      valid++;
      const st = await play(`stop${valid}`, `stop${valid}.wav`, "interrupt");
      barge.push({ attempt, valid: true, idx: valid, answerStart: s, interruptStart: st.playStart, interruptLastVoiced: st.lastVoicedPull, interruptWallStart: st.wallStart });
      await sleep(400);
      const s2 = await waitRoomSpeechStart(st.lastVoicedPull + 400, 20000);
      log("barge_new_answer_start", { idx: valid, at: s2 });
      await waitRoomSilence(2500, 45000); await sleep(1000);
    }
  },
  async noise() {
    await sleep(3000);
    for (const f of ["fan", "keyboard", "chatter_far"]) { await play(f, `${f}.wav`, "noise"); await sleep(10000); }
    await ask("fan_q6", "fan_q6.wav"); await sleep(1500);
    await ask("fan_q7", "fan_q7.wav"); await sleep(1500);
  },
  async stability() {
    const plan = ["q6", "q7", "long1", "q8", "bg", "q9", "q2", "q3", "q4"];
    const t0 = now();
    for (let k = 0; k < plan.length; k++) {
      const due = t0 + 10000 + k * 62000;
      while (now() < due) { if (stopping) return; await sleep(200); }
      if (plan[k] === "bg") {
        const u = await play("bg", "bg.wav");
        await waitRoomSpeechStart(u.lastVoicedPull, 20000);
        const end = now() + 45000; while (now() < end && !bridgeLogHas(/append_speech_sent/)) await sleep(250);
        await sleep(1500); await waitRoomSilence(3000, 40000);
      } else await ask(plan[k], `${plan[k]}.wav`, { answerTimeout: 30000 });
    }
    // let the bridge run to its 600s hard cap
    while (!stopping) await sleep(500);
  },
};

async function finish(why) {
  if (stopping && why !== "bridge_left") return;
  stopping = true;
  log("finish", { why });
  if (MODE !== "stability" || why !== "scenario_done") writeFileSync(`${DIR}/STOP`, why);
  await sleep(1500);
  try { player?.stop(true); } catch {}
  try { connection?.destroy(); } catch {}
  try { await client?.destroy(); } catch {}
  writeFileSync(`${DIR}/room.wav`, wav(Buffer.concat(roomPcm)), { mode: 0o600 });
  const cal = calibrate(roomFrames);
  const segs = segments(roomFrames, cal.th);
  const lat = [];
  for (const u of utterances.filter((x) => x.kind === "speech" && x.lastVoicedPull !== null)) {
    const nxt = segs.find((s) => s.start > u.lastVoicedPull);
    const over = segs.find((s) => s.start <= u.lastVoicedPull && s.end >= u.lastVoicedPull);
    lat.push({ label: u.label, userEnd: u.lastVoicedPull, roomStart: nxt?.start ?? null, latencyMs: nxt ? +(nxt.start - u.lastVoicedPull).toFixed(0) : null, overlappedModelSpeech: !!over });
  }
  const bargeEval = barge.filter((b) => b.valid).map((b) => {
    const winEnd = b.interruptLastVoiced + 400;
    const voicedAfter = roomFrames.filter((f) => f.t > b.interruptStart && f.t <= winEnd && f.rms > cal.th);
    const lastOld = voicedAfter.filter((f) => f.t <= b.interruptStart + 1500).pop();
    const late = voicedAfter.filter((f) => f.t > b.interruptStart + 1500);
    return { ...b, stoppedWithin1500: late.length === 0, oldAnswerStopMs: lastOld ? +(lastOld.t - b.interruptStart).toFixed(0) : 0, lateVoicedFrames: late.length };
  });
  writeFileSync(`${DIR}/metrics-speaker.json`, JSON.stringify({ run: RUN, mode: MODE, why, calibration: cal, roomSegments: segs, utterances, latency: lat, barge, bargeEval }, null, 1), { mode: 0o600 });
  writeFileSync(`${DIR}/frames-room.json`, JSON.stringify(roomFrames), { mode: 0o600 });
  log("metrics_written", { lat: lat.length, barge: bargeEval.length });
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGINT", () => finish("sigint"));

(async () => {
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  await client.login(TOKEN);
  await new Promise((r) => (client.isReady() ? r() : client.once("ready", r)));
  if (client.user.id !== BOT1_ID) return finish("bot_identity_mismatch");
  // wait for bridge READY
  const w = now(); while (!existsSync(`${DIR}/READY`) && now() - w < 90000) await sleep(250);
  if (!existsSync(`${DIR}/READY`)) return finish("bridge_not_ready");
  const guild = await client.guilds.fetch(GUILD_ID);
  const pre = voiceRoomCheck(guild, { allowInChannel: [BOT3_ID], mustNotBeInVoice: [BOT1_ID] });
  log("precheck", pre);
  if (!pre.ok || !pre.inTarget.includes(BOT3_ID)) return finish("precheck_failed");
  client.on("voiceStateUpdate", (o, n) => {
    if (stopping) return;
    if (n.channelId === VOICE_CHANNEL_ID && ![BOT1_ID, BOT3_ID].includes(n.id)) { log("intruder", { id: n.id }); finish("intruder"); }
    if (n.id === BOT3_ID && o.channelId === VOICE_CHANNEL_ID && n.channelId !== VOICE_CHANNEL_ID) { log("bridge_left", {}); finish("bridge_left"); }
    if (n.id === BOT1_ID && o.channelId === VOICE_CHANNEL_ID && n.channelId !== VOICE_CHANNEL_ID) { log("speaker_moved", {}); finish("speaker_moved"); }
  });
  connection = joinVoiceChannel({ guildId: GUILD_ID, channelId: VOICE_CHANNEL_ID, adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false, daveEncryption: true, debug: true });
  connection.on("debug", (m) => { const t = String(m); if (/\[DAVE\]/.test(t) && !/secret|token|key/i.test(t)) log("discord_dave_debug", t.slice(0, 200)); });
  connection.on("stateChange", (o, n) => log("discord_conn_state", { from: o.status, to: n.status }));
  await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  player = createAudioPlayer({ behaviors: { maxMissedFrames: 250 } });
  player.on("error", (e) => log("player_error", String(e).slice(0, 300)));
  connection.subscribe(player);
  const dec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const rs = connection.receiver.subscribe(BOT3_ID, { end: { behavior: EndBehaviorType.Manual } });
  rs.on("data", (pkt) => {
    const t = now();
    try {
      const { mono, rms } = stereoToMono(Buffer.from(dec.decode(pkt)));
      roomPcm.push(mono); roomFrames.push({ t: +t.toFixed(1), rms: +rms.toFixed(0) });
      if (roomFrames.length === 150) { roomTh = calibrate(roomFrames).th; log("room_calibrated", { th: roomTh }); }
    } catch (e) { log("room_decode_error", String(e).slice(0, 200)); }
  });
  log("speaker_ready", {});
  await scenarios[MODE]();
  log("scenario_done", {});
  if (MODE !== "stability") await finish("scenario_done");
})().catch((e) => { log("fatal", String(e?.stack || e).slice(0, 1200)); finish("fatal"); });
