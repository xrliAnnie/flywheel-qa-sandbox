/* 阳性对照:同一个探测器、同一批文件,去找一段【已知一定存在】的声音 —— v2 的开场白。
 * 如果它连开场白都找不到,那上面那个「全静」就只是探测器瞎了。*/
import { readFileSync } from "node:fs";
const GAP_MS = 1500;
for (const r of process.argv.slice(2)) {
  const raw = `${process.env.HOME}/.fly1911/${r}-bridge-raw.jsonl`;
  const ev  = `${process.env.HOME}/.fly1911/${r}-bridge.jsonl`;
  const deltas = [];
  for (const ln of readFileSync(raw, "utf8").split("\n")) {
    if (!ln.includes("outputAudio/delta")) continue;
    try { const o = JSON.parse(ln); deltas.push({ ms: Date.parse(o.t), len: o.msg?.params?.audio?.len ?? 0 }); } catch {}
  }
  let ready = null, streamEnd = null, greetTx = null;
  for (const ln of readFileSync(ev, "utf8").split("\n")) {
    if (!ln.trim()) continue; let o; try { o = JSON.parse(ln) } catch { continue }
    const t = Date.parse(o.t);
    if (o.dir === "READY" && ready === null) ready = t;
    if (o.dir === "STREAM-END" && streamEnd === null) streamEnd = t;
    if (o.dir === "TX" && o.obj?.role === "assistant" && greetTx === null) greetTx = { ms: t, text: o.obj.text };
  }
  const segs = [];
  for (const d of deltas) {
    const last = segs[segs.length - 1];
    if (!last || d.ms - last.end > GAP_MS) segs.push({ start: d.ms, end: d.ms, n: 1 }); else { last.end = d.ms; last.n++; }
  }
  const before = segs.filter(s => s.start < streamEnd);
  console.log(`${r}: 提问之前探到 ${before.length} 段声音` +
    (before.length ? ` (第一段 READY+${((before[0].start - ready) / 1000).toFixed(1)}s, ${before[0].n} 个音频块)` : "") +
    `  它开场说的:${JSON.stringify((greetTx?.text || "").slice(0, 24))}`);
}
