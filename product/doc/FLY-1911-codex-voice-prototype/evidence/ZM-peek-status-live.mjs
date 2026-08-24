import { Client, GatewayIntentBits } from "discord.js";
import { readFileSync } from "node:fs";
const env=Object.fromEntries(readFileSync(process.env.HOME+"/.flywheel/.env","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim()]));
const c=new Client({intents:[GatewayIntentBits.Guilds]});
c.once("clientReady",async()=>{
  const ch=await c.channels.fetch("1485787273193853170");
  let last=null;
  for(let i=0;i<40;i++){
    const ms=[...(await ch.messages.fetch({limit:10})).values()].filter(m=>m.author.id===c.user.id);
    const st=ms.find(m=>!m.content.startsWith("🗣️ **")&&!m.content.startsWith("💬 **"));
    if(st&&st.content!==last){ last=st.content;
      console.log(new Date().toISOString().slice(11,19)+"  状态行现在是:"+JSON.stringify(st.content.slice(0,70))+(st.editedTimestamp?"  〔改过〕":"")); }
    await new Promise(r=>setTimeout(r,2000));
  }
  c.destroy();process.exit(0);
});
c.login(env["TEST_BOT_TOKEN_1"]).catch(e=>{console.log("登录失败");process.exit(1)});
