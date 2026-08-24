/* 真机失败注入:等状态行的第二态(它自己写的那句)真的落地之后,
 * 从 Discord 那头把这条状态消息删掉 —— 于是下一次 edit 会拿到真的 Unknown Message(10008)。
 * ⚠️ 这是从【被测物外面】注入的失败,没有改被测物一行代码。*/
import { Client, GatewayIntentBits } from "discord.js";
import { readFileSync, existsSync } from "node:fs";
const env = Object.fromEntries(readFileSync(process.env.HOME + "/.flywheel/.env", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const LOG = process.env.WATCH_LOG, CH = "1485787273193853170";
const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once("clientReady", async () => {
  const ch = await c.channels.fetch(CH);
  const deadline = Date.now() + 4 * 60 * 1000;
  // 等 PLAN 出现(= 第二态已经发出去了)
  while (Date.now() < deadline) {
    if (existsSync(LOG) && readFileSync(LOG, "utf8").includes('"dir":"PLAN"')) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 4000));            // 给那次 edit 落地的时间
  const msgs = [...(await ch.messages.fetch({ limit: 20 })).values()]
    .filter(m => m.author.id === c.user.id);
  // 状态行 = 这个 bot 发的、被改过的那条(caption 从来不改)
  const status = msgs.find(m => m.editedTimestamp) ?? msgs[msgs.length - 1];
  if (!status) { console.log("❌ 找不到状态消息"); c.destroy(); process.exit(1); }
  console.log("删之前那条状态消息是:" + JSON.stringify(status.content.slice(0, 80)) +
    (status.editedTimestamp ? "  〔已经被改过 ⇒ edit 这条路走通了〕" : "  〔还没被改过〕"));
  await status.delete();
  console.log("✅ 已从 Discord 删掉,id=" + status.id + " ⇒ 之后任何 edit 都会拿到真的 Unknown Message");
  c.destroy(); process.exit(0);
});
c.login(env["TEST_BOT_TOKEN_1"]).catch(e => { console.log("登录失败:" + String(e?.message || e).slice(0, 120)); process.exit(1); });
