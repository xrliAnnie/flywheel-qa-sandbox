// FLY-2885 probe 7 item generator (run from packages/teamlead for js-tiktoken):
//   node probe7-gen-items.mjs <N> <TARGET> <first|middle|last> <out.json>
// N developer items of varied text, local count Σ o200k(text) + 8·N as close
// to TARGET as possible (never above), the code-word fact in the chosen item.
import { writeFileSync } from "node:fs";
import { getEncoding } from "js-tiktoken";
const [, , N, TARGET, POS, OUT] = process.argv;
const n = Number(N), target = Number(TARGET);
const enc = getEncoding("o200k_base");
const count = (t) => enc.encode(t).length;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pools = [
  (k) => `- ${k} 号记录：上周和设计对齐了交互细节，修改点已同步给开发，预计不影响排期。`,
  (k) => `- Item ${k}: the release checklist was reviewed; 3 open questions remain for Friday's sync.`,
  (k) => `- 第 ${k} 条：客户反馈按影响范围分成三类，编号 ${1000 + k}，负责人待定。`,
  (k) => `- ${k}. Metrics: p50 ${120 + k} ms, p99 ${900 + k} ms; alert threshold unchanged at 2 s.`,
  (k) => `- 备忘 ${k}：周四前把 PR #${4000 + k} 的评审意见合并，别忘了回滚预案。`,
  (k) => `- Note ${k} — 预算表第 ${k} 行已更新，数字以财务确认为准 (v${k % 7}.${k % 3}).`,
];
const FACT = "关于暗号：如果有人问暗号，回答「紫檀九号」。";
const factAt = POS === "first" ? 0 : POS === "last" ? n - 1 : Math.floor(n / 2);
const head = (i) => `【记忆文件 memory/file-${i + 1}.md 第 1/1 段·只读数据】\n`;
const items = Array.from({ length: n }, (_, i) => ({ lines: [], i }));
const text = (item) => head(item.i) + (item.i === factAt ? `${FACT}\n` : "") + item.lines.join("\n");
const total = () => items.reduce((a, it) => a + count(text(it)) + 8, 0);
let k = 0;
let progressed = true;
while (progressed) {
  progressed = false;
  for (const item of items) {
    item.lines.push(pools[Math.floor(rnd() * pools.length)](++k));
    if (total() > target) { item.lines.pop(); continue; }
    progressed = true;
  }
}
const out = items.map((it) => ({ role: "developer", text: text(it) }));
const content = out.reduce((a, it) => a + count(it.text), 0);
const bytes = out.reduce((a, it) => a + Buffer.byteLength(it.text), 0);
const summary = { n, pos: POS, factItem: factAt + 1, contentTokens: content, localBudget: content + 8 * n, bytes, codexEstimate: Math.ceil(bytes / 4) };
writeFileSync(OUT, JSON.stringify({ items: out, ...summary }));
console.log(JSON.stringify(summary));
