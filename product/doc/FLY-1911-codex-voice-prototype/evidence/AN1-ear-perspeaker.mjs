/* FLY-1911:按【说话人】分开录的耳朵。
 * 为什么要分开:一间房里同时有桥的 bot、我放问题的 bot,混在一条轨里就没法归因
 * ——「听到了声音」不等于「听到了那个我想验的东西」。
 * 用途:验「先进房的人,听不听得到后进房的人说话」——这是她那七分钟唯一和我的复现不同的条件。 */
import "libsodium-wrappers";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { EndBehaviorType, entersState, joinVoiceChannel, VoiceConnectionStatus } from "@discordjs/voice";
import { Client, GatewayIntentBits } from "discord.js";
import OpusScript from "opusscript";

const GUILD = process.env.GUILD_ID, CHAN = process.env.VOICE_CHANNEL_ID;
const TV = process.env.TOKEN_VAR || "TEST_BOT_TOKEN_2";
const OUT = process.env.OUT || "ear", LISTEN = Number(process.env.LISTEN_MS || 45000);
const KEEP = process.env.KEEP_AUDIO === "1"; // ⛔ 默认不留音频,只留波形读数
const log = (d, o) => appendFileSync(`${OUT}.jsonl`, `${JSON.stringify({ t: new Date().toISOString(), dir: d, obj: o })}\n`);
const env = Object.fromEntries(readFileSync(`${process.env.HOME}/.flywheel/.env`, "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const per = new Map(); // userId -> {parts, pkts, firstMs}
const t0 = Date.now();

c.once("clientReady", async () => {
  log("GATEWAY", { bot: c.user.tag, selfId: c.user.id });
  const g = await c.guilds.fetch(GUILD);
  const conn = joinVoiceChannel({ channelId: CHAN, guildId: GUILD, adapterCreator: g.voiceAdapterCreator, selfDeaf: false, selfMute: false });
  try { await entersState(conn, VoiceConnectionStatus.Ready, 25000); log("JOINED", { tMs: Date.now() - t0 }); }
  catch (e) { log("RESULT", { ok: false, reason: String(e?.message || e) }); return bye(); }
  const subs = new Set();
  conn.receiver.speaking.on("start", uid => {
    if (uid === c.user.id || subs.has(uid)) return;
    subs.add(uid);
    log("SPEAKER-SEEN", { userId: uid, tMs: Date.now() - t0 });
    const s = conn.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: 3000 } });
    s.on("data", ch => {
      let e = per.get(uid); if (!e) { e = { parts: [], pkts: 0, firstMs: Date.now() - t0 }; per.set(uid, e); }
      e.pkts++; try { e.parts.push(Buffer.from(dec.decode(ch))); } catch {}
    });
    s.on("end", () => { subs.delete(uid); });
  });
  setTimeout(() => {
    const rep = [];
    for (const [uid, e] of per) {
      const pcm = Buffer.concat(e.parts);
      let peak = 0, nz = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) { const v = Math.abs(pcm.readInt16LE(i)); if (v > peak) peak = v; if (v) nz++; }
      const secs = pcm.length / (48000 * 2 * 2);
      const nonSilentSec = +(nz / 2 / (48000 * 2) ).toFixed(2);
      rep.push({ userId: uid, opusPkts: e.pkts, firstPacketMs: e.firstMs, recordedSec: +secs.toFixed(2), peak, nonSilentSec });
      if (KEEP && pcm.length) {
        const h = Buffer.alloc(44), br = 48000 * 2 * 2;
        h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
        h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24);
        h.writeUInt32LE(br, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
        h.writeUInt32LE(pcm.length, 40);
        writeFileSync(`${OUT}-${uid}.wav`, Buffer.concat([h, pcm]));
      }
    }
    log("RESULT", { ok: rep.length > 0, keptAudio: KEEP, speakers: rep });
    bye();
  }, LISTEN);
});
function bye() { try { c.destroy(); } catch {} setTimeout(() => process.exit(0), 500); }
c.login(env[TV] || process.env[TV]);
