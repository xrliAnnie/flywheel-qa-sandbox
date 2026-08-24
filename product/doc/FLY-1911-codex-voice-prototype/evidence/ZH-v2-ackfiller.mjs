/* 判据(动手前写死,量的是「有没有声音出来」不是「日志里有没有 filler 事件」):
 *   锚点 = STREAM-END(她那段话的音频流结束)—— 不用 user 转写,因为转写晚 8 秒多
 *   窗口 = [STREAM-END, 最终答案那一段声音开始]
 *   在这个窗口里有没有任何 outputAudio/delta(= 有没有任何声音从它嘴里出来)
 *     有  ⇒ v2 有 ack filler
 *     没有(中间全静,只有最终答案) ⇒ v2 没有
 * 声音分段:相邻 delta 间隔 > 1500ms 就算断开,算作另一段声音。*/
import { readFileSync, existsSync } from "node:fs";
const GAP_MS = 1500;
const runs = process.argv.slice(2);
const rows = [];
for (const r of runs) {
  const raw = `${process.env.HOME}/.fly1911/${r}-bridge-raw.jsonl`;
  const ev  = `${process.env.HOME}/.fly1911/${r}-bridge.jsonl`;
  if (!existsSync(raw) || !existsSync(ev)) { console.log(`跳过 ${r}:文件不全`); continue; }

  const deltas = [];
  for (const ln of readFileSync(raw, "utf8").split("\n")) {
    if (!ln.includes("outputAudio/delta")) continue;
    try { const o = JSON.parse(ln); deltas.push({ ms: Date.parse(o.t), len: o.msg?.params?.audio?.len ?? 0 }); } catch {}
  }
  let streamEnd = null, answerAt = null, asstTx = [];
  for (const ln of readFileSync(ev, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln) } catch { continue }
    const t = Date.parse(o.t), d = o.dir;
    if (d === "STREAM-END" && streamEnd === null) streamEnd = t;
    if (d === "ANSWER" && answerAt === null) answerAt = t;
    if (d === "TX" && o.obj?.role === "assistant") asstTx.push({ ms: t, text: o.obj.text });
  }
  if (streamEnd === null) { console.log(`跳过 ${r}:没有 STREAM-END(这一场没问出去)`); continue; }

  // 分段
  const segs = [];
  for (const d of deltas) {
    const last = segs[segs.length - 1];
    if (!last || d.ms - last.end > GAP_MS) segs.push({ start: d.ms, end: d.ms, bytes: d.len, n: 1 });
    else { last.end = d.ms; last.bytes += d.len; last.n++; }
  }
  const after = segs.filter(s => s.start > streamEnd);          // 提问结束之后的每一段声音
  /* ⚠️ 最终答案那一段,不能取「最后一段」——一场里可能还有第二轮对话(v2m-01 就是),
   *    取最后一段会把第二轮的回话当成本轮答案,于是把本轮答案误报成「中间的声音」。
   *    正解:答案 = 提问后第一条 assistant 转写所对应的那一段声音(转写在音频之后落地)。*/
  const firstAsstTx = asstTx.find(x => x.ms > streamEnd) ?? null;
  const answerSeg = firstAsstTx
    ? after.filter(s => s.start <= firstAsstTx.ms + 1000)
           .sort((a, b) => Math.abs(a.end - firstAsstTx.ms) - Math.abs(b.end - firstAsstTx.ms))[0] ?? null
    : (after[0] ?? null);
  const between = answerSeg ? after.filter(s => s.start < answerSeg.start) : [];  // 严格夹在提问与答案之间的声音
  rows.push({ r, streamEnd, answerAt, after, between, answerSeg, asstTx });

  const rel = ms => ((ms - streamEnd) / 1000).toFixed(1) + "s";
  console.log(`\n── ${r} ──  提问结束(STREAM-END)= 0s`);
  if (!after.length || !answerSeg) { console.log("  ⚠️ 提问之后没有可归属的答案声音,不计入"); continue; }
  for (const s of after.filter(x => x.start <= answerSeg.start)) {
    const isAns = s === answerSeg;
    console.log(`  ${isAns ? "【最终答案】" : "【中间的声音】"} ${rel(s.start)} → ${rel(s.end)}  ` +
      `时长≈${((s.end - s.start) / 1000).toFixed(1)}s  ${s.n} 个音频块`);
  }
  console.log(`  ⇒ 提问结束 → 最终答案开口:静了 ${rel(answerSeg.start)}`);
  console.log(`  ⇒ 这段静默里有没有声音:${between.length ? "❗有 " + between.length + " 段" : "没有,全静"}`);
  for (const tx of asstTx.filter(x => x.ms > streamEnd)) console.log(`     它说的话:${JSON.stringify(tx.text.slice(0, 60))}`);
}

const valid = rows.filter(x => x.after.length && x.answerSeg);
const withFiller = valid.filter(x => x.between.length);
console.log("\n════════ 判据结果 ════════");
console.log(`可用的场次:${valid.length} / ${runs.length}`);
console.log(`提问结束到答案之间出过声的:${withFiller.length} 场 ${withFiller.length ? "(" + withFiller.map(x => x.r).join(",") + ")" : ""}`);
if (valid.length) {
  const gaps = valid.map(x => (x.answerSeg.start - x.streamEnd) / 1000);
  console.log(`她耳朵里那段全空的静默:${Math.min(...gaps).toFixed(1)}s ~ ${Math.max(...gaps).toFixed(1)}s ` +
    `(中位 ${gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)].toFixed(1)}s)`);
}
console.log(withFiller.length === 0 && valid.length
  ? "⇒ 判定:v2 没有 ack filler —— 提问结束之后到最终答案之前,一声都没有"
  : "⇒ 判定:v2 有声音落在中间,1850 那一段要重写");
