/* 只读:单独核【语音频道自带的那个文字聊天】这一个对象的权限。
 * ⛔ 不引用那份 29 个文字频道的普查 —— 那是另一类对象,这个 id 根本不在里面。
 * ⛔ 不发任何消息。*/
import { Client, GatewayIntentBits, PermissionsBitField, ChannelType } from "discord.js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(process.env.HOME + "/.flywheel/.env", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const ID = "1485787273193853170";
const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once("clientReady", async () => {
  try {
    const ch = await c.channels.fetch(ID);
    const g = ch.guild, me = await g.members.fetchMe(), p = ch.permissionsFor(me);
    const F = PermissionsBitField.Flags;
    const bits = {
      "看得见这个频道 (ViewChannel)":       !!p?.has(F.ViewChannel),
      "能发消息 (SendMessages)":            !!p?.has(F.SendMessages),
      "能读历史 (ReadMessageHistory)":      !!p?.has(F.ReadMessageHistory),
      "能连进语音 (Connect)":               !!p?.has(F.Connect),
    };
    console.log("bot        =", c.user.tag);
    console.log("频道       =", ch.name, "| id =", ch.id);
    console.log("对象类型   =", ChannelType[ch.type], "(" + ch.type + ")",
      ch.type === ChannelType.GuildVoice ? "⇒ 语音频道自带的文字聊天(text-in-voice),和那 29 个文字频道不是同一类" : "");
    console.log("能不能当文字频道用 (isTextBased) =", ch.isTextBased?.() ? "是" : "否");
    for (const [k, v] of Object.entries(bits)) console.log("  " + (v ? "✅" : "❌") + " " + k);
    // 编辑自己发的消息:Discord 不需要额外权限位,但要能 fetch 到消息 ⇒ 依赖 ReadMessageHistory
    const ok = bits["看得见这个频道 (ViewChannel)"] && bits["能发消息 (SendMessages)"] && bits["能读历史 (ReadMessageHistory)"] && ch.isTextBased?.();
    console.log(ok
      ? "⇒ ✅ 这一个频道三项齐 + 是文字型 ⇒ 状态行的「发 + 原地改」有条件跑\n   ⚠️ 但「改」这一步只有真发过一次才算验到,这里没发。"
      : "⇒ ❌ 缺条件,停下报 Lead,不现场绕。");
  } catch (e) { console.log("❌ 取不到这个频道:" + String(e?.message || e).slice(0, 160)); }
  c.destroy(); process.exit(0);
});
c.login(env["TEST_BOT_TOKEN_1"]).catch(e => { console.log("登录失败:" + String(e?.message || e).slice(0, 120)); process.exit(1); });
