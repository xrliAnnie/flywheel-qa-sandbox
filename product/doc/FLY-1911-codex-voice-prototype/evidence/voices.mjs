// 只读:问它自己支持哪些音色、默认是谁。listVoices 不是 model turn,不烧额度。
import { spawn } from "node:child_process";
const BIN="/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const c=spawn(BIN,["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
let buf="",id=0;const w=new Map();
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
const rpc=(me,pa={})=>{const i=++id;c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},20000)})};
await rpc("initialize",{clientInfo:{name:"fly1911-voices",title:"voices",version:"0.0.1"},capabilities:{experimentalApi:true}});
c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n");
await new Promise(r=>setTimeout(r,400));
const v=await rpc("thread/realtime/listVoices",{});
const cfg=await rpc("config/read",{});
const pick=o=>{const s=JSON.stringify(o||{});const m=s.match(/"realtime[^,}]*|"voice"[^,}]*|"model"[^,}]*/g);return m?[...new Set(m)].slice(0,20):null};
console.log(JSON.stringify({voices:v.result??v.error,configRealtimeish:pick(cfg.result)},null,1));
c.stdin.end();setTimeout(()=>{try{c.kill("SIGKILL")}catch{};process.exit(0)},600);
