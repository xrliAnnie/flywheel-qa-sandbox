// FLY-2884 prototype bridge: Discord voice-test-3 (bot3, DAVE) <-> codex app-server realtime WebRTC (ChatGPT subscription).
// Opus packets are forwarded in both directions WITHOUT re-encoding. The only encoder use is one pre-encoded 20ms
// silence frame for uplink gaps. Side-channel decoding (RMS + recordings) never feeds back into either direction.
// Usage: node bridge.mjs <run-name> <mode>   (mode: smoke|latency|barge|noise|stability|founder)
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, chmodSync } from "node:fs";
import { Readable } from "node:stream";
import * as werift from "werift";
import OpusScript from "opusscript";
import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType, createAudioPlayer,
  createAudioResource, StreamType, AudioPlayerStatus,
} from "@discordjs/voice";
import {
  ROOT, GUILD_ID, VOICE_CHANNEL_ID, BOT1_ID, BOT3_ID, FOUNDER_ID, now, loadEnvToken, makeLogger,
  opusSamples, opusStereoFlag, stereoToMono, wav, segments, calibrate, voiceRoomCheck,
} from "./common.mjs";
const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } = werift;

const RUN = process.argv[2] || "x";
const MODE = process.argv[3] || "smoke";
const MAX_SEC = Number(process.env.MAX_SEC || (MODE === "smoke" ? 180 : 600));
const BG_MAX = Number(process.env.BG_MAX ?? 3);
const SPEAKERS = MODE === "founder" ? [FOUNDER_ID] : [BOT1_ID];
const ALLOW = MODE === "founder" ? [BOT3_ID, FOUNDER_ID, BOT1_ID] : [BOT3_ID, BOT1_ID];
const DIR = `${ROOT}/runs/${RUN}`;
const TOKEN = loadEnvToken("TEST_BOT_TOKEN_3");
const { log } = makeLogger(DIR, "bridge.jsonl", () => [TOKEN]);
log("config", { RUN, MODE, MAX_SEC, BG_MAX, SPEAKERS, ALLOW, guild: GUILD_ID, channel: VOICE_CHANNEL_ID });
const marks = {};
const mark = (k, extra) => { if (marks[k] === undefined) { marks[k] = +now().toFixed(1); log("mark", { k, ms: marks[k], ...extra }); } };

// ---------------- state ----------------
const upFrames = []; // {t, rms, real}
const downFrames = []; // {t, rms}
const upPcm = [], downPcm = [];
const transcripts = []; // {t, role, text}
const counters = { upReal: 0, upSilenceFill: 0, upDropped: 0, upUnderrun: 0, upNon960: 0, upStereo: 0, upMono: 0,
  downPkts: 0, downNon960: 0, downTsAnomaly: 0, downReorder: 0, downLoss: 0, downStereo: 0, downMono: 0, downQueueTrim: 0, maxDownQueue: 0, maxUpQueue: 0, dcEvents: {} };
let loopback = false, stopping = false, threadId = null, realtimeOn = false, connection = null, client = null, child = null, pc = null;

async function stop(why) {
  if (stopping) return; stopping = true;
  log("stop", { why, marks, counters });
  try { if (realtimeOn && threadId) await rpc("thread/realtime/stop", { threadId }, 4000); } catch {}
  try { await pc?.close(); } catch {}
  try { connection?.destroy(); } catch {}
  try { await client?.destroy(); } catch {}
  try { child?.kill("SIGTERM"); } catch {}
  writeFileSync(`${DIR}/uplink.wav`, wav(Buffer.concat(upPcm)), { mode: 0o600 });
  writeFileSync(`${DIR}/downlink.wav`, wav(Buffer.concat(downPcm)), { mode: 0o600 });
  writeFileSync(`${DIR}/frames-bridge.json`, JSON.stringify({ up: upFrames, down: downFrames }), { mode: 0o600 });
  // ---- bridge metrics (in-process monotonic only) ----
  const cu = calibrate(upFrames), cd = calibrate(downFrames);
  const us = segments(upFrames, cu.th), ds = segments(downFrames, cd.th);
  const pairs = [];
  for (const d of ds) {
    const prior = us.filter((u) => u.end < d.start);
    if (!prior.length) continue;
    const u = prior[prior.length - 1];
    const downBetween = ds.some((x) => x !== d && x.end > u.end && x.start < d.start);
    if (downBetween) continue; // not the first model speech after this utterance
    if (d.start - u.end > 20000) continue;
    pairs.push({ userEnd: u.end, modelStart: d.start, latencyMs: +(d.start - u.end).toFixed(0) });
  }
  const connectedMs = marks.pc_connected !== undefined ? +(now() - marks.pc_connected).toFixed(0) : 0;
  const metrics = { run: RUN, mode: MODE, why, calibration: { up: cu, down: cd }, upSegments: us, downSegments: ds, latencyPairs: pairs,
    connectedMs, marks, counters, transcripts, queueSamples, bgMax: BG_MAX };
  writeFileSync(`${DIR}/metrics-bridge.json`, JSON.stringify(metrics, null, 1), { mode: 0o600 });
  log("metrics_written", { pairs: pairs.length, connectedMs });
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => stop("sigint"));
process.on("SIGTERM", () => stop("sigterm"));
setInterval(() => { if (existsSync(`${DIR}/STOP`)) stop("stop_file"); }, 500).unref();

// ---------------- app-server ----------------
const HOME = `${ROOT}/home-${RUN}`;
mkdirSync(HOME, { recursive: true, mode: 0o700 }); chmodSync(HOME, 0o700);
if (!existsSync(`${HOME}/auth.json`)) symlinkSync(`${process.env.HOME}/.codex/auth.json`, `${HOME}/auth.json`);
if (!lstatSync(`${HOME}/auth.json`).isSymbolicLink()) throw new Error("auth_json_not_symlink");
writeFileSync(`${HOME}/config.toml`, "# fly2884 prototype temp home — no login commands\n");
const env = { ...process.env, CODEX_HOME: HOME };
delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
for (const k of Object.keys(env)) if (/TOKEN|SECRET/i.test(k)) delete env[k];
let buf = "", nextId = 1;
const pending = new Map(), handlers = [];
function rpc(method, params, ms = 20000) {
  return new Promise((resolve) => {
    const id = nextId++; log("request", { method });
    pending.set(id, { resolve, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); log("timeout", { method }); resolve({ error: { message: "timeout" } }); } }, ms);
  });
}
const waitFor = (pred, ms) => new Promise((resolve) => {
  const h = (m) => { if (pred(m)) { handlers.splice(handlers.indexOf(h), 1); resolve(m); } };
  handlers.push(h);
  setTimeout(() => { const i = handlers.indexOf(h); if (i >= 0) { handlers.splice(i, 1); resolve(null); } }, ms);
});
function startAppServer() {
  child = spawn("codex", ["app-server"], { cwd: `${ROOT}/work`, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
        const p = pending.get(m.id); pending.delete(m.id);
        log("response", { method: p.method, error: m.error ?? null, thread: m.result?.thread?.id, model: m.result?.model });
        p.resolve(m);
      } else if (m.method && m.id !== undefined) {
        log("server_request_declined", { method: m.method });
        child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: "declined" } }) + "\n");
      } else if (m.method) {
        const p = m.params || {};
        if (m.method === "thread/realtime/outputAudio/delta") {}
        else if (m.method === "thread/realtime/sdp") log("notify", { method: m.method, sdpLines: (p.sdp || "").split("\r\n").filter((l) => /^(m=|a=rtpmap|a=setup|a=ice-lite|a=ptime|a=fmtp)/.test(l)) });
        else if (/^(thread\/realtime\/|turn\/|item\/completed|error|account\/updated)/.test(m.method)) {
          const s = JSON.stringify(p);
          log("notify", { method: m.method, params: s.length > 1500 ? s.slice(0, 1500) + "…" : p });
          if (m.method === "thread/realtime/transcript/done") transcripts.push({ t: +now().toFixed(1), role: p.role, text: p.text });
          if (m.method === "thread/realtime/error" || m.method === "thread/realtime/closed") mark(`realtime_${m.method.split("/").pop()}`);
        }
        for (const h of [...handlers]) h(m);
      }
    }
  });
  child.stderr.on("data", (d) => log("stderr", d.toString().slice(0, 800)));
  child.on("exit", (code, sig) => { log("appserver_exit", { code, sig }); if (!stopping) stop("appserver_exit"); });
}

// ---------------- WebRTC ----------------
const upDec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
const downDec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
const silenceEnc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
const SILENCE_PKT = Buffer.from(silenceEnc.encode(Buffer.alloc(960 * 4), 960)); // one 20ms stereo silence frame
silenceEnc.delete?.();
const localTrack = new MediaStreamTrack({ kind: "audio" });
let rtpSeq = Math.floor(Math.random() * 65535), rtpTs = Math.floor(Math.random() * 1e9);
function sendRtp(payload) {
  const pkt = new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: (rtpSeq = (rtpSeq + 1) & 0xffff), timestamp: rtpTs >>> 0, marker: false }), payload);
  localTrack.writeRtp(pkt);
  rtpTs = (rtpTs + opusSamples(payload)) >>> 0;
}

// downlink → Discord (object-mode Opus stream)
const downStream = new Readable({ objectMode: true, read() {} });
let lastDownSeq = null, lastDownTs = null;
function onDownRtp(rtp) {
  const t = now();
  mark("first_rtp_in");
  const payload = rtp.payload, seq = rtp.header.sequenceNumber, ts = rtp.header.timestamp;
  counters.downPkts++;
  const samples = opusSamples(payload);
  if (opusStereoFlag(payload)) counters.downStereo++; else counters.downMono++;
  if (samples !== 960) { counters.downNon960++; log("downlink_violation", { kind: "non960", samples, len: payload.length }); stop("downlink_non960"); return; }
  if (lastDownSeq !== null) {
    const ds = (seq - lastDownSeq + 65536) & 0xffff;
    if (ds === 0 || ds > 32768) { counters.downReorder++; log("downlink_anomaly", { kind: "reorder_or_dup", seq, lastDownSeq }); return; }
    if (ds > 1) counters.downLoss += ds - 1;
    const dts = (ts - lastDownTs + 2 ** 32) % 2 ** 32;
    if (dts !== 960 * ds) { counters.downTsAnomaly++; if (counters.downTsAnomaly <= 20) log("downlink_anomaly", { kind: "ts_step", dts, ds }); }
  }
  lastDownSeq = seq; lastDownTs = ts;
  // side-channel decode for RMS + recording only
  try { const { mono, rms } = stereoToMono(Buffer.from(downDec.decode(payload))); downPcm.push(mono); downFrames.push({ t: +t.toFixed(1), rms: +rms.toFixed(0) }); }
  catch (e) { log("down_decode_error", String(e).slice(0, 200)); }
  // forward the untouched Opus payload to Discord
  const q = downStream.readableLength;
  if (q > counters.maxDownQueue) counters.maxDownQueue = q;
  if (q > 10) { while (downStream.readableLength > 3) downStream.read(); counters.downQueueTrim++; log("down_queue_trim", { from: q }); }
  downStream.push(Buffer.from(payload));
}

// uplink: Discord packets → queue → 20ms monotonic scheduler → RTP
const upQueue = []; // {pkt, arr}
let upState = "idle", underrunTicks = 0;
function onDiscordPacket(userId, pkt) {
  const samples = opusSamples(pkt);
  if (samples !== 960) { counters.upNon960++; log("uplink_violation", { kind: "non960", samples, len: pkt.length }); stop("uplink_non960"); return; }
  if (opusStereoFlag(pkt)) counters.upStereo++; else counters.upMono++;
  mark("first_discord_packet", { userId });
  if (loopback) {
    const t = now();
    try { const { mono, rms } = stereoToMono(Buffer.from(upDec.decode(pkt))); upPcm.push(mono); upFrames.push({ t: +t.toFixed(1), rms: +rms.toFixed(0), real: 1 }); } catch {}
    downStream.push(Buffer.from(pkt)); counters.upReal++; return;
  }
  upQueue.push({ pkt: Buffer.from(pkt), arr: now() });
  if (upQueue.length > counters.maxUpQueue) counters.maxUpQueue = upQueue.length;
  while (upQueue.length > 10) { upQueue.shift(); counters.upDropped++; }
}
function recordUp(pkt, t) {
  try { const { mono, rms } = stereoToMono(Buffer.from(upDec.decode(pkt))); upPcm.push(mono); upFrames.push({ t: +t.toFixed(1), rms: +rms.toFixed(0), real: 1 }); }
  catch (e) { upPcm.push(Buffer.alloc(1920)); upFrames.push({ t: +t.toFixed(1), rms: 0, real: 1 }); log("up_decode_error", String(e).slice(0, 200)); }
}
const queueSamples = [];
setInterval(() => queueSamples.push([+now().toFixed(0), upQueue.length, downStream.readableLength]), 200).unref();
function uplinkTick() {
  const t = now();
  if (upState === "idle" && (upQueue.length >= 3 || (upQueue.length >= 1 && t - upQueue[0].arr >= 60))) upState = "talking";
  let sent = null;
  if (upState === "talking") {
    if (upQueue.length) { sent = upQueue.shift().pkt; underrunTicks = 0; }
    else { underrunTicks++; counters.upUnderrun++; if (underrunTicks >= 5) upState = "idle"; }
  }
  if (sent) {
    // catch-up: if a burst left a backlog, send one extra real packet this tick (never drop below 10)
    if (upQueue.length > 3) { const extra = upQueue.shift().pkt; counters.upCatchup = (counters.upCatchup || 0) + 1; counters.upReal++; sendRtp(sent); recordUp(sent, t); sent = extra; }
    counters.upReal++;
    sendRtp(sent); recordUp(sent, t);
  } else {
    counters.upSilenceFill++;
    sendRtp(SILENCE_PKT);
    upPcm.push(Buffer.alloc(1920)); upFrames.push({ t: +t.toFixed(1), rms: 0, real: 0 });
  }
}
function startUplinkClock() {
  const start = now(); let k = 0;
  const step = () => {
    if (stopping) return;
    uplinkTick(); k++;
    // catch up if the event loop stalled, but never burst more than 3 frames
    let behind = Math.floor((now() - start) / 20) - k;
    if (behind > 3) { log("uplink_clock_skip", { behind }); k += behind - 3; behind = 3; }
    while (behind-- > 0) { uplinkTick(); k++; }
    setTimeout(step, Math.max(0, start + k * 20 - now()));
  };
  step();
}

// ---------------- main ----------------
(async () => {
  // 1) Discord login + fail-closed precheck
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  await client.login(TOKEN);
  await new Promise((r) => (client.isReady() ? r() : client.once("ready", r)));
  if (client.user.id !== BOT3_ID) return stop("bot_identity_mismatch");
  const guild = await client.guilds.fetch(GUILD_ID);
  const pre = voiceRoomCheck(guild, { allowInChannel: ALLOW, mustNotBeInVoice: [BOT3_ID] });
  log("precheck", pre);
  if (!pre.ok) return stop("precheck_failed");
  client.on("voiceStateUpdate", (o, n) => {
    if (stopping) return;
    if (n.channelId === VOICE_CHANNEL_ID && !ALLOW.includes(n.id)) { log("intruder", { id: n.id }); stop("intruder"); }
    if (n.id === BOT3_ID && marks.discord_ready !== undefined && n.channelId !== VOICE_CHANNEL_ID) { log("bot_moved", { to: n.channelId }); stop("bot_moved"); }
    if (n.channelId === VOICE_CHANNEL_ID || o.channelId === VOICE_CHANNEL_ID) log("voice_state", { id: n.id, from: o.channelId, to: n.channelId });
    if (MODE === "founder" && n.id === FOUNDER_ID && o.channelId === VOICE_CHANNEL_ID && n.channelId !== VOICE_CHANNEL_ID && marks.founder_present !== undefined) {
      mark("founder_left");
      setTimeout(() => { if (guild.voiceStates.cache.get(FOUNDER_ID)?.channelId !== VOICE_CHANNEL_ID) stop("founder_left"); }, 10000);
    }
  });

  // 2) join voice (DAVE on)
  connection = joinVoiceChannel({ guildId: GUILD_ID, channelId: VOICE_CHANNEL_ID, adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false, daveEncryption: true, debug: true });
  connection.on("debug", (m) => { const t = String(m); if (/\[DAVE\]/.test(t) && !/secret|token|key/i.test(t)) log("discord_dave_debug", t.slice(0, 200)); });
  connection.on("stateChange", (o, n) => { log("discord_conn_state", { from: o.status, to: n.status }); if (n.status === VoiceConnectionStatus.Disconnected && !stopping) mark("discord_disconnected"); });
  await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  mark("discord_ready");
  const player = createAudioPlayer({ behaviors: { maxMissedFrames: 50 * 700 } });
  player.on("error", (e) => log("player_error", String(e).slice(0, 300)));
  player.on("stateChange", (o, n) => { if (o.status !== n.status) log("player_state", { from: o.status, to: n.status }); });
  connection.subscribe(player);
  for (const uid of SPEAKERS) {
    const s = connection.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.Manual } });
    s.on("data", (pkt) => onDiscordPacket(uid, pkt));
    s.on("error", (e) => log("receive_error", String(e).slice(0, 300)));
  }
  connection.receiver.speaking.on("start", (uid) => log("speaking_start", { uid }));

  if (process.env.NO_REALTIME === "1") {
    // zero-quota Discord loopback: uplink Opus packets are pushed straight back to Discord untouched
    loopback = true;
    player.play(createAudioResource(downStream, { inputType: StreamType.Opus }));
    writeFileSync(`${DIR}/READY`, String(Date.now()));
    log("bridge_ready", { loopback: true });
    setTimeout(() => stop("hard_cap"), MAX_SEC * 1000).unref();
    return;
  }
  if (MODE === "founder") {
    // no quota is spent until the founder is actually in the room
    const waitUntil = now() + Number(process.env.FOUNDER_WAIT_SEC || 1800) * 1000;
    const present = () => guild.voiceStates.cache.get(FOUNDER_ID)?.channelId === VOICE_CHANNEL_ID;
    log("founder_wait", { present: present() });
    while (!present() && now() < waitUntil && !stopping) await new Promise((r) => setTimeout(r, 500));
    if (!present()) return stop("founder_not_present");
    mark("founder_present");
    await new Promise((r) => setTimeout(r, 1500));
  }
  // 3) app-server + thread
  startAppServer();
  await rpc("initialize", { clientInfo: { name: "fly2884-bridge", title: null, version: "0.0.1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const acct = await rpc("account/read", {});
  log("account", { type: acct.result?.account?.type, planType: acct.result?.account?.planType });
  const th = await rpc("thread/start", { cwd: `${ROOT}/work`, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
  threadId = th.result?.thread?.id;
  if (!threadId) return stop("no_thread");

  // 4) WebRTC offer → realtime start (same params as CLI /voice)
  pc = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111, parameters: "minptime=10;useinbandfec=1" })], video: [] },
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.addTransceiver(localTrack, { direction: "sendrecv" });
  const dc = pc.createDataChannel("oai-events");
  dc.stateChanged?.subscribe?.((s) => log("datachannel", { state: s }));
  dc.onMessage.subscribe((data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    const ty = ev.type || "?";
    counters.dcEvents[ty] = (counters.dcEvents[ty] || 0) + 1;
    if (/^(session\.|turn\.(created|done|cancel)|delegation\.|response\.|input_audio_buffer\.|output_audio_buffer\.|error)/.test(ty)) { const j = JSON.stringify(ev); log("dc_event", { type: ty, raw: j.length > 1200 ? j.slice(0, 1200) + "…" : ev }); }
    else if (!/(delta|\.added)$/.test(ty)) log("dc_event", { type: ty });
  });
  pc.connectionStateChange.subscribe((s) => { log("pc_state", { s }); if (s === "connected") mark("pc_connected"); if ((s === "disconnected" || s === "failed" || s === "closed") && !stopping) { mark(`pc_${s}`); } });
  pc.onTrack.subscribe((track) => { log("remote_track", { kind: track.kind }); track.onReceiveRtp.subscribe(onDownRtp); });
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { if (pc.iceGatheringState === "complete") r(); pc.iceGatheringStateChange.subscribe((s) => s === "complete" && r()); setTimeout(r, 8000); });
  const sdpP = waitFor((m) => ["thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed"].includes(m.method), 20000);
  const startedP = waitFor((m) => m.method === "thread/realtime/started", 25000);
  mark("realtime_start_sent");
  setTimeout(() => stop("hard_cap"), MAX_SEC * 1000).unref();
  const st = await rpc("thread/realtime/start", { threadId, clientManagedHandoffs: true, outputModality: "audio", includeStartupContext: false,
    transport: { type: "webrtc", sdp: pc.localDescription.sdp }, version: "v3" });
  if (st.error) { log("start_rejected", st.error); return stop("start_rejected"); }
  realtimeOn = true;
  const sdp = await sdpP;
  if (!sdp || sdp.method !== "thread/realtime/sdp") { log("no_sdp", sdp?.params ?? null); return stop("no_sdp"); }
  mark("answer_sdp");
  await pc.setRemoteDescription({ type: "answer", sdp: sdp.params.sdp });
  if (await startedP) mark("realtime_started");
  const t1 = now(); while (marks.pc_connected === undefined && now() - t1 < 10000) await new Promise((r) => setTimeout(r, 50));
  if (marks.pc_connected === undefined) return stop("pc_not_connected");

  // 5) forward: start downlink playback + uplink clock
  player.play(createAudioResource(downStream, { inputType: StreamType.Opus }));
  startUplinkClock();
  writeFileSync(`${DIR}/READY`, String(Date.now()));
  log("bridge_ready", {});

  // 6) background turns: client-managed handoff like the TUI; at most BG_MAX
  let turnCount = 0; const allowed = new Set();
  handlers.push(async (m) => {
    if (m.method === "turn/started") {
      turnCount++; const id = m.params?.turn?.id; log("bg_turn_started", { n: turnCount, id });
      if (turnCount <= BG_MAX) allowed.add(id);
      else { log("extra_turn_interrupted", { id }); await rpc("turn/interrupt", { threadId, turnId: id }); }
    }
    if (m.method === "turn/completed" && allowed.has(m.params?.turn?.id)) {
      const items = m.params?.turn?.items || [];
      const final = [...items].reverse().find((it) => it.type === "agentMessage" && (it.phase === "final_answer" || !it.phase));
      log("bg_turn_completed", { status: m.params?.turn?.status, final: final?.text ?? null });
      if (final?.text) { mark("append_speech_sent"); await rpc("thread/realtime/appendSpeech", { threadId, text: final.text }); }
    }
  });
})().catch((e) => { log("fatal", String(e?.stack || e).slice(0, 1200)); stop("fatal"); });
