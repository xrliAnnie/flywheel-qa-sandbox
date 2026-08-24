// FLY-1911 D1:最能翻车的那条先验 —— 机器人到底能不能真的连进那个语音房?
// 权限位说有 CONNECT/SPEAK,和 gateway+UDP 真的建起语音连接,是两件事。这里只验后者。
import "libsodium-wrappers";
import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState, getVoiceConnection } from "@discordjs/voice";
import { readFileSync, appendFileSync } from "node:fs";

const GUILD = process.env.GUILD_ID, CHAN = process.env.VOICE_CHANNEL_ID;
const TOKEN_VAR = process.env.TOKEN_VAR || "TEST_BOT_TOKEN_1";
const LOG = process.env.OUT ? `${process.env.OUT}.jsonl` : "join.jsonl";
const log = (d, o) => { const l = JSON.stringify({ t: new Date().toISOString(), dir: d, obj: o }); appendFileSync(LOG, l + "\n"); console.log(l); };

// token 只从 env 文件读,不打印、不进 argv
const env = Object.fromEntries(readFileSync(process.env.HOME + "/.flywheel/.env", "utf8")
  .split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const token = env[TOKEN_VAR];
if (!token) { log("FATAL", { msg: `${TOKEN_VAR} 不在 ~/.flywheel/.env 里` }); process.exit(1); }

const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const t0 = Date.now();
c.once("clientReady", async () => {
  log("GATEWAY", { readyMs: Date.now() - t0, botTag: c.user.tag, botId: c.user.id });
  try {
    const g = await c.guilds.fetch(GUILD);
    const ch = await g.channels.fetch(CHAN);
    log("CHANNEL", { guild: g.name, channel: ch?.name, type: ch?.type, bitrate: ch?.bitrate ?? null });
    const me = await g.members.fetchMe();
    const p = ch.permissionsFor(me);
    log("PERMS", { CONNECT: p.has("Connect"), SPEAK: p.has("Speak"), VIEW: p.has("ViewChannel") });

    const tJoin = Date.now();
    const conn = joinVoiceChannel({ channelId: CHAN, guildId: GUILD, adapterCreator: g.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    conn.on("stateChange", (o, n) => log("STATE", { from: o.status, to: n.status, ms: Date.now() - tJoin }));
    conn.on("error", (e) => log("CONNERR", { message: String(e?.message || e) }));
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 25000);
      log("RESULT", { joined: true, readyMs: Date.now() - tJoin, ping: conn.ping });
      await new Promise(r => setTimeout(r, 6000));           // 停一会,看它掉不掉线
      log("HELD", { stillReady: conn.state.status === VoiceConnectionStatus.Ready, heldMs: 6000, ping: conn.ping });
    } catch (e) {
      log("RESULT", { joined: false, reason: String(e?.message || e), lastStatus: conn.state.status, waitedMs: Date.now() - tJoin });
    }
    try { getVoiceConnection(GUILD)?.destroy(); } catch {}
  } catch (e) {
    log("THROW", { message: String(e?.message || e) });
  }
  setTimeout(() => { c.destroy(); process.exit(0); }, 1200);
});
c.on("error", e => log("CLIENTERR", { message: String(e?.message || e) }));
c.login(token).catch(e => { log("LOGINFAIL", { message: String(e?.message || e) }); process.exit(1); });
