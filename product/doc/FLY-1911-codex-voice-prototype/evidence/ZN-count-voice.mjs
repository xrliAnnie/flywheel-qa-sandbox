/* 只读:这个 guild 里有几个语音房 —— 决定「能不能在不碰她那个房的前提下做最小验证」。*/
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import { readFileSync } from "node:fs";
const env=Object.fromEntries(readFileSync(process.env.HOME+"/.flywheel/.env","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim()]));
const c=new Client({intents:[GatewayIntentBits.Guilds]});
c.once("clientReady",async()=>{
  const g=await c.guilds.fetch("1485787271192907816");
  const chs=await g.channels.fetch();
  const v=[...chs.values()].filter(ch=>ch&&ch.type===ChannelType.GuildVoice);
  console.log("语音房共 "+v.length+" 个:");
  for(const ch of v) console.log("   "+ch.name+"  "+ch.id+(ch.id==="1485787273193853170"?"   ← 她用的那个":"")+
    "  房里现在有 "+ch.members.size+" 人");
  c.destroy();process.exit(0);
});
c.login(env["TEST_BOT_TOKEN_2"]).catch(e=>{console.log("登录失败");process.exit(1)});
