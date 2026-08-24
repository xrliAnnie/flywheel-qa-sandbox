// FLY-1911:时间结构对比 v2 —— 修掉上一版的方法错误。
// ⚠️ 上一版用同一个绝对 dB 阈值量两个文件,而它们底噪差很远(无损采集 vs 手机录外放),
//    结果把她那段量成 99.6% 都在说话。⇒ 阈值必须按每个文件自己的电平定,不能共用一个绝对值。
import { execFileSync } from "node:child_process";
const sh=c=>execFileSync("/bin/sh",["-c",c],{encoding:"utf8"});
function analyze(file,label,relDb=25,minSil=0.30){
  const vol=sh(`ffmpeg -hide_banner -nostats -i "${file}" -af volumedetect -f null - 2>&1`);
  const max=parseFloat((vol.match(/max_volume:\s*(-?[\d.]+) dB/)||[])[1]);
  const mean=parseFloat((vol.match(/mean_volume:\s*(-?[\d.]+) dB/)||[])[1]);
  const th=+(max-relDb).toFixed(1);                       // 阈值 = 该文件自己的峰值往下 relDb
  const err=sh(`ffmpeg -hide_banner -nostats -i "${file}" -af silencedetect=n=${th}dB:d=${minSil} -f null - 2>&1`);
  const dur=(err.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)||[]).slice(1).reduce((a,v,i)=>a+parseFloat(v)*[3600,60,1][i],0)||0;
  const starts=[...err.matchAll(/silence_start: (-?[\d.]+)/g)].map(m=>+m[1]);
  const ends=[...err.matchAll(/silence_end: ([\d.]+)/g)].map(m=>+m[1]);
  const sil=[]; for(let i=0;i<starts.length;i++){const e=ends[i]!==undefined?ends[i]:dur; if(e>starts[i])sil.push({start:starts[i],dur:e-starts[i]})}
  const speech=[]; let cur=0;
  for(const s of sil){ if(s.start-cur>0.05) speech.push(+(s.start-cur).toFixed(2)); cur=s.start+s.dur }
  if(dur-cur>0.05) speech.push(+(dur-cur).toFixed(2));
  const gaps=sil.map(s=>+s.dur.toFixed(2));
  const sum=a=>+a.reduce((x,y)=>x+y,0).toFixed(2);
  const q=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return +s[Math.min(s.length-1,Math.floor(p*s.length))].toFixed(2)};
  return {label,总时长:+dur.toFixed(1),峰值dB:max,均值dB:mean,用的阈值dB:th,
    说话段数:speech.length,说话总时长:sum(speech),说话占比:+(100*sum(speech)/dur).toFixed(1),
    停顿段数:gaps.length,停顿中位:q(gaps,.5),停顿p90:q(gaps,.9),最长停顿:gaps.length?Math.max(...gaps):null,
    说话段中位:q(speech,.5),说话段p90:q(speech,.9),最长说话段:speech.length?Math.max(...speech):null};
}
const rows=[
  analyze(process.argv[2],"Annie 的 Codex App(手机二次录音)"),
  analyze(process.argv[3],"我们的 v3(无损采集)"),
];
console.log(JSON.stringify(rows,null,1));
