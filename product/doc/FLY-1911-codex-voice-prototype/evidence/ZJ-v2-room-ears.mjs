/* 把 ack-filler 那条结论的最后一环补上:
 *   前面量的是「桥收到了多少音频」;这里量的是「房间里真的响了没有」。
 * 数据来自另一个进程、另一个 Discord 客户端(提问的那个 bot 坐在房里收音),
 * 它每 2 秒记一次「到此为止收到了多少字节」。⇒ 字节不涨 = 那段时间房里没声音。
 * 锚点 = ASK-DONE(她那句话放完的那一刻),不是转写。*/
import { readFileSync } from "node:fs";
const rows = [];
for (const r of process.argv.slice(2)) {
  const m = JSON.parse(readFileSync(`${process.env.HOME}/.fly1911/${r}-asker-manifest.json`, "utf8"));
  const marks = (m.marks || []).map(([ms, bytes]) => ({ ms, bytes }));
  const t0 = m.askDoneAt;
  if (!t0 || marks.length < 3) { console.log(`跳过 ${r}`); continue; }
  const after = marks.filter(x => x.ms >= t0);
  if (!after.length) { console.log(`跳过 ${r}:问完之后没有采样`); continue; }
  const base = after[0].bytes;
  const firstGrow = after.find(x => x.bytes > base);              // 第一次又有声音进来
  const rel = ms => ((ms - t0) / 1000).toFixed(1);
  if (!firstGrow) { console.log(`── ${r}:问完之后房里再没响过(这一场不计入)`); continue; }
  // 静默里有没有零星的声音:看 base 到 firstGrow 之间有没有任何一次增长(定义上没有)
  const quietSamples = after.filter(x => x.ms < firstGrow.ms).length;
  rows.push({ r, quiet: +rel(firstGrow.ms), quietSamples });
  console.log(`── ${r}  问完 → 房里再次响起:${rel(firstGrow.ms)}s  ` +
    `(中间 ${quietSamples} 个 2 秒采样,字节一个没涨)`);
}
console.log("\n════════ 房间里(她耳朵)那一侧 ════════");
if (rows.length) {
  const q = rows.map(x => x.quiet).sort((a, b) => a - b);
  console.log(`可用场次:${rows.length}`);
  console.log(`问完到房里再次响起:${q[0]}s ~ ${q[q.length - 1]}s(中位 ${q[Math.floor(q.length / 2)]}s)`);
  console.log("⇒ 每一场,这段时间里收到的音频字节数一个都没涨 —— 房间里是真的静的,不是桥没收到。");
}
