// 量 founder 卡片在 proofshot 视口(860px)下的真实高度。MCP 起不来时的绕法:直接开 CDP。
import { spawn } from "node:child_process";
const CH = process.argv[2], FILE = process.argv[3];
const p = spawn(CH, ["--headless=new","--remote-debugging-port=9333","--no-sandbox","--window-size=860,900","about:blank"]);
await new Promise(r=>setTimeout(r,2500));
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const ws = list.find(t=>t.type==="page")?.webSocketDebuggerUrl;
const s = new WebSocket(ws); let id=0; const w=new Map();
s.onmessage = e => { const m=JSON.parse(e.data); if(w.has(m.id)){w.get(m.id)(m); w.delete(m.id);} };
await new Promise(r=>s.onopen=r);
const cmd=(method,params={})=>{const i=++id;s.send(JSON.stringify({id:i,method,params}));return new Promise(r=>w.set(i,r));};
await cmd("Page.enable");
await cmd("Emulation.setDeviceMetricsOverride",{width:860,height:900,deviceScaleFactor:1,mobile:false});
await cmd("Page.navigate",{url:"file://"+FILE});
await new Promise(r=>setTimeout(r,2500));
const r = await cmd("Runtime.evaluate",{expression:"JSON.stringify({h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth,inner:window.innerWidth,ta:document.querySelectorAll('textarea').length,audio:document.querySelectorAll('audio').length,err:(window.__e||null)})",returnByValue:true});
console.log(r.result?.result?.value);
p.kill("SIGKILL"); process.exit(0);
