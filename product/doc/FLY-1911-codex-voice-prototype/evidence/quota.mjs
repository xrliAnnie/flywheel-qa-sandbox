// 只读查额度:app-server 的 account/rateLimits/read + usage/read,零 model turn、零额度消耗
import { spawn } from "node:child_process";
const BIN="/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const c=spawn(BIN,["app-server"],{stdio:["pipe","pipe","pipe"]});
let buf="",id=0;const w=new Map();const notes=[];
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
 if(m.method==="account/rateLimits/updated")notes.push(m.params);
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
const rpc=(me,pa={})=>{const i=++id;c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},20000)})};
await rpc("initialize",{clientInfo:{name:"fly1911-quota",title:"quota read",version:"0.0.1"},capabilities:{experimentalApi:true}});
c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n");
await new Promise(r=>setTimeout(r,400));
const acct=await rpc("account/read",{});
const rl=await rpc("account/rateLimits/read",{});
const us=await rpc("account/usage/read",{});
const scrub=o=>JSON.parse(JSON.stringify(o||{},(k,v)=>/id_token|access_token|refresh_token|secret|apiKey/i.test(k)?"<redacted>":v));
const u=scrub(us.result)||{};delete u.dailyUsage;delete u.usageByDay;
console.log(JSON.stringify({account:scrub(acct.result),rateLimits:scrub(rl.result),usageTop:u,pushed:scrub(notes[0])},null,1));
c.stdin.end();setTimeout(()=>{try{c.kill("SIGKILL")}catch{};process.exit(0)},600);
