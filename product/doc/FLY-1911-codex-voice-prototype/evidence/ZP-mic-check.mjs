/* 只读:桥有没有【能力】影响她那一侧的麦克风。分两问:
 *   ① 代码里有没有做  ② 就算想做,权限允不允许(服务器静音需要 MuteMembers)
 * ⛔ 不改、不试。*/
import { Client, GatewayIntentBits, PermissionsBitField } from "discord.js";
import { readFileSync } from "node:fs";
const env=Object.fromEntries(readFileSync(process.env.HOME+"/.flywheel/.env","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim()]));
const c=new Client({intents:[GatewayIntentBits.Guilds]});
c.once("clientReady",async()=>{
  const ch=await c.channels.fetch("1485787273193853170");
  const me=await ch.guild.members.fetchMe(), p=ch.permissionsFor(me), F=PermissionsBitField.Flags;
  console.log("bot =",c.user.tag);
  console.log("  服务器静音别人 (MuteMembers)  :", p.has(F.MuteMembers)?"有权限":"没有权限");
  console.log("  服务器闭麦别人 (DeafenMembers):", p.has(F.DeafenMembers)?"有权限":"没有权限");
  console.log("  把人踢出语音   (MoveMembers)  :", p.has(F.MoveMembers)?"有权限":"没有权限");
  c.destroy();process.exit(0);
});
c.login(env["TEST_BOT_TOKEN_1"]).catch(e=>{console.log("登录失败");process.exit(1)});
