/* 从 Discord 那头把消息读回来 —— 不拿桥自己的日志当证据。
 * 只读:不发、不改、不删。*/
import { Client, GatewayIntentBits } from "discord.js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(process.env.HOME + "/.flywheel/.env", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once("clientReady", async () => {
  const ch = await c.channels.fetch("1485787273193853170");
  const msgs = [...(await ch.messages.fetch({ limit: 30 })).values()].reverse();
  console.log("频道:" + ch.name + " (" + ch.id + ")  ⇒ 这是语音房自带的那个聊天");
  console.log("读回来 " + msgs.length + " 条:\n");
  for (const m of msgs) {
    const t = new Date(m.createdTimestamp).toISOString().slice(11, 19);
    const edited = m.editedTimestamp ? " 〔改过〕" : "";
    console.log(`  ${t}  [${m.author.tag}]${edited}  ${JSON.stringify(m.content)}`);
  }
  c.destroy(); process.exit(0);
});
c.login(env["TEST_BOT_TOKEN_1"]).catch(e => { console.log("登录失败:" + String(e?.message || e).slice(0, 120)); process.exit(1); });
