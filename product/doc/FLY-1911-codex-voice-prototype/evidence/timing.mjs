// FLY-1911:量「怎么说」的时间结构。两段并排,都是能穿过 64kbps 压缩活下来的量。
// ⚠️ 我听不了。这里只量时长/时刻/静默段/比例,不写任何「听起来如何」的判断 —— 那一栏是 Annie 的。
import { execFileSync } from "node:child_process";
const file=process.argv[2], label=process.argv[3], TH=process.argv[4]||"-40dB", MIN=process.argv[5]||"0.25";
const out=execFileSync("ffmpeg",["-hide_banner","-nostats","-i",file,"-af",`silencedetect=n=${TH}:d=${MIN}`,"-f","null","-"],
  {encoding:"utf8",stdio:["ignore","pipe","pipe"]});
const err=execFileSync("/bin/sh",["-c",`ffmpeg -hide_banner -nostats -i "${file}" -af silencedetect=n=${TH}:d=${MIN} -f null - 2>&1`],{encoding:"utf8"});
const dur=parseFloat((err.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)||[]).slice(1).reduce((a,v,i)=>a+parseFloat(v)*[3600,60,1][i],0))||0;
const starts=[...err.matchAll(/silence_start: ([\d.]+)/g)].map(m=>+m[1]);
const ends=[...err.matchAll(/silence_end: ([\d.]+)/g)].map(m=>+m[1]);
// 配对成静默段
const sil=[]; for(let i=0;i<starts.length;i++){ const e=ends[i]!==undefined?ends[i]:dur; if(e>starts[i]) sil.push({start:+starts[i].toFixed(2),dur:+(e-starts[i]).toFixed(2)}); }
// 说话段 = 静默段之间
const speech=[]; let cur=0;
for(const s of sil){ if(s.start-cur>0.05) speech.push(+(s.start-cur).toFixed(2)); cur=s.start+s.dur; }
if(dur-cur>0.05) speech.push(+(dur-cur).toFixed(2));
const sum=a=>a.reduce((x,y)=>x+y,0);
const pct=(a,b)=>b?+(100*a/b).toFixed(1):null;
const q=(a,p)=>{ if(!a.length)return null; const s=[...a].sort((x,y)=>x-y); return +s[Math.min(s.length-1,Math.floor(p*s.length))].toFixed(2) };
const gaps=sil.map(s=>s.dur);
console.log(JSON.stringify({
  label, file: file.split("/").pop(), totalSec:+dur.toFixed(2),
  说话段数: speech.length, 说话总时长: +sum(speech).toFixed(2), 说话占比百分比: pct(sum(speech),dur),
  静默段数: gaps.length, 静默总时长: +sum(gaps).toFixed(2),
  停顿长度分布: { p10:q(gaps,.1), 中位:q(gaps,.5), p90:q(gaps,.9), 最长:gaps.length?+Math.max(...gaps).toFixed(2):null },
  说话段长度分布: { p10:q(speech,.1), 中位:q(speech,.5), p90:q(speech,.9), 最长:speech.length?+Math.max(...speech).toFixed(2):null },
  判据: `silencedetect n=${TH} d=${MIN}`,
},null,1));
