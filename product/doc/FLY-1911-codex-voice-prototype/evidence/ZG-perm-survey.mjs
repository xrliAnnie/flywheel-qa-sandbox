// 只读:普查 bot 在这个 guild 的文字频道里有没有「发消息 + 编辑自己的消息」。
// ⛔ 不发任何消息、不改任何东西。编辑自己的消息不需要额外权限位,
//    但发消息需要 SendMessages,读历史需要 ReadMessageHistory(edit 前要 fetch)。
import { Client, GatewayIntentBits, PermissionsBitField, ChannelType } from "discord.js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(process.env.HOME + "/.flywheel/.env", "utf8").split("\n")
    .filter(l => l.includes("=") && !l.trim().startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const GUILD = "1485787271192907816";
const token = env[process.env.TOKEN_VAR || "TEST_BOT_TOKEN_1"];
const c = new Client({ intents: [GatewayIntentBits.Guilds] });

c.once("clientReady", async () => {
  const g = await c.guilds.fetch(GUILD);
  const me = await g.members.fetchMe();
  const chans = await g.channels.fetch();
  const rows = [];
  for (const [, ch] of chans) {
    if (!ch || ch.type !== ChannelType.GuildText) continue;
    const p = ch.permissionsFor(me);
    rows.push({
      name: ch.name, id: ch.id,
      view: !!p?.has(PermissionsBitField.Flags.ViewChannel),
      send: !!p?.has(PermissionsBitField.Flags.SendMessages),
      history: !!p?.has(PermissionsBitField.Flags.ReadMessageHistory),
    });
  }
  console.log("bot =", c.user.tag);
  console.log("可用的文字频道(view+send+history 三项齐 = 那套显示能跑):");
  let ok = 0;
  for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const good = r.view && r.send && r.history;
    if (good) ok++;
    console.log("  " + (good ? "✅" : "  ") + " " + r.name.padEnd(28) + r.id +
      "  view=" + r.view + " send=" + r.send + " history=" + r.history);
  }
  console.log("⇒ 三项齐的频道数:" + ok + " / " + rows.length);
  c.destroy(); process.exit(0);
});
c.login(token).catch(e => { console.log("登录失败:" + String(e?.message || e).slice(0, 120)); process.exit(1); });
