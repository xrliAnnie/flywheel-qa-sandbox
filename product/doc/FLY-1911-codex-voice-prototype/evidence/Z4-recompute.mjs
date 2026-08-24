#!/usr/bin/env node
/*
 * FLY-1911 事后重算读取器 —— 修读法,不修写法。
 *
 * 为什么是读取器不是补丁:那些原始字段本来就全在盘上(realtimeStartedAt / realtimeClosedAt /
 * 事件流 / answers)。改代码会【第二次】把这批数据从中间切开,而我们刚为第一次切开付过代价。
 * 事后统一重算能一次性适用于全部场次,不用改一行被测代码。
 *
 * 🔴 不变式(今天第三个同族假绿 ok / gotAnswer / outcome 之后立的):
 *   凡是用「某个负向信号没出现」来断定「处于正向状态」的字段,
 *   必须同时要求那个【开始事件】出现过。
 *   否则「从来没发生」和「一直很好」在字段里长得一模一样。
 *
 * 用法:node Z4-recompute.mjs <manifest 目录>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('用法: node Z4-recompute.mjs <manifest 目录>'); process.exit(1); }

/* 重算判据:alive 必须满足 realtimeStartedAt 非空。 */
function trueOutcome(m) {
  /* 🔴 必须先分出「还在跑」。
   * 第一版我没分,于是把一场【正在进行中】的 v3 判成了 never_started ——
   * 盘上那份是开跑时写的桩(status:"running"),会话锚要到收尾才落。
   * 差一点据此报出「v3 现在也起不来了」这个假警报。
   * ⇒ 这和它要抓的假绿是同一个形状,只是方向相反:
   *   outcome 把「没发生」说成「一直很好」;我把「还没写完」说成「没发生」。
   *   两边都是【拿一个字段的缺席去断定一个状态】。 */
  if (m.status === 'running') return 'in_flight';       // 还没跑到自己的收尾,判不了

  /* 🔴 第三层,而且是决定性的:先分「仪器在不在」,再谈「它看见了什么」。
   * realtimeStartedAt / realtimeClosedAt / durationMs 是 commit 4f5d3fdd7 才加的。
   * 在那之前跑的每一场,这个【键压根不存在】—— 而不是「有键但值为空」。
   * 第一版判据把两者当成一回事,于是把 Y3 那场【真的答了话的 v2 成功】判成了没起来过。
   * ⇒ 一个空值的意思是「这台仪器没看见」,不是「这件事没发生」；
   *   而一个不存在的键,连「没看见」都算不上 —— 那时候仪器还不存在。 */
  if (!Object.prototype.hasOwnProperty.call(m, 'realtimeStartedAt')) return 'NOT_INSTRUMENTED';

  const started = !!m.realtimeStartedAt;
  const closed  = !!m.realtimeClosedAt;
  if (!started) return 'never_started';                 // ← 原 outcome 会把它报成 alive
  if (!closed)  return 'alive';
  return m.closeReason === 'requested' ? 'alive' : 'died';
}

/* ⚠️ 范围必须收窄到【桥的 manifest】。
 * 第一版我扫了目录里所有 *-manifest.json,于是把 asker 的、以及不相关的旧探针
 * 也算了进来 —— 它们本来就没有会话锚,于是被一律判成 never_started。
 * 那不是假绿,那是我的尺子伸到了不该量的地方。⇒ 零命中/满命中之前先问「我扫的是什么」。 */
/* 范围两次都错过,所以这次写死理由:
 *  第一版「收全部 *-manifest.json」→ 把 asker 也算进来,满屏 never_started。
 *  第二版「只收 -bridge-manifest.json」→ 把【老场次】排除了,因为它们那时不叫这个名。
 * ⇒ 正确写法是【排除已知不该算的】,不是【只收当前这一代的命名】——
 *   后者会随着命名演化,悄悄把历史挡在视野外。 */
const rows = readdirSync(dir)
  .filter(f => f.endsWith('manifest.json') && !f.includes('-asker'))
  .sort().map(f => {
  const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  /* 🔴 同一个病在下一层:通不通 这个键也是后来才加的。
   * 直接读它 ⇒ 老场次一律 heard=false/spoke=false,于是 T3c 这种【真的答了话的成功场】
   * 会被读成「内容为空」。⇒ 回落到底层数组,那几个数组从第一版就有。 */
  const hasVerdict = m.通不通 && typeof m.通不通 === 'object';
  const heard = hasVerdict ? !!m.通不通.听见她 : (m.userTranscripts ?? []).length > 0;
  const spoke = hasVerdict ? !!m.通不通.它说了话
              : ((m.assistantTranscripts ?? []).length > 0 || (m.answers ?? []).length > 0);
  return {
    tag: f.replace('-bridge-manifest.json','').replace('-manifest.json',''),
    ver: m.version ?? null,
    写的outcome: m.outcome ?? null,
    真outcome: trueOutcome(m),
    分歧: (m.outcome ?? null) !== trueOutcome(m),
    durationMs: m.durationMs ?? null,
    heard, spoke,
    conversed: heard && spoke,
    egressIp: m.network?.egressIp ?? null,
    gw: m.network?.defaultGateway ?? null,
    ctCount: m.concurrentTasks?.count ?? null,
    ctPids: (m.concurrentTasks?.pids ?? []).join('+') || null,
    hasArmedField: Object.prototype.hasOwnProperty.call(m.concurrentTasks ?? {}, 'armedSleepers'),
  };
});

console.log(JSON.stringify(rows, null, 2));

console.log('\n=== 写的 outcome 与重算不一致的场次(假绿在哪) ===');
const bad = rows.filter(r => r.分歧);
console.log(bad.length ? bad.map(r => `${r.tag}: 写=${r.写的outcome} 真=${r.真outcome}`).join('\n') : '(无)');

console.log('\n=== 无仪器场次(键不存在):不许判成失败,改看内容字段 ===');
const ni = rows.filter(r => r.真outcome === 'NOT_INSTRUMENTED');
console.log(ni.length ? ni.map(r => `${r.tag}: heard=${r.heard} spoke=${r.spoke} conversed=${r.conversed} ⇒ ${r.conversed?'真成功(有来有回)':'内容为空,需读日志判'}`).join('\n') : '(无)');

console.log('\n=== 按 concurrency profile 分组,看成败是否与它相关 ===');
const g = {};
for (const r of rows) {
  if (!['alive','died'].includes(r.真outcome)) continue;  // 坏 harness / 未完成 / 无仪器 都不参与相关性
  const k = `ct=${r.ctCount} pids=${r.ctPids}`;
  (g[k] ??= { alive: 0, died: 0 })[r.真outcome === 'alive' ? 'alive' : 'died']++;
}
for (const [k, v] of Object.entries(g)) console.log(`${k}  alive=${v.alive} died=${v.died}`);
console.log('⇒ 若各 profile 的活死比例没有系统差别,则「并发画像」这条不相关,写一句「已核,不相关」把它钉死。');

console.log('\n=== 干净配对候选(同版本、同 egress、同网关、同 ct、且都带 armedSleepers 字段)===');
const eligible = rows.filter(r => r.hasArmedField && (r.真outcome === 'alive' || r.真outcome === 'died'));
const key = r => [r.ver, r.egressIp, r.gw, r.ctCount, r.ctPids].join('|');
const byKey = {};
for (const r of eligible) (byKey[key(r)] ??= []).push(r);
let found = 0;
for (const [k, list] of Object.entries(byKey)) {
  const a = list.filter(r => r.真outcome === 'alive');
  const d = list.filter(r => r.真outcome === 'died');
  if (a.length && d.length) { found++; console.log(`✅ ${k}\n   活: ${a.map(r=>r.tag)} 死: ${d.map(r=>r.tag)}`); }
}
if (!found) console.log('(还没有:需要在【脚本冻结之后】的场次里同时出现一活一死)');
