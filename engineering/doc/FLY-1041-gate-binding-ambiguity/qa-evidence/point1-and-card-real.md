# FLY-1041 QA — 真机证据:点① retire + outbound 卡(founder 无关腿)

日期: 2026-07-09
方式: 模块驱动(FLY-605 Tadashi-approved 先例)—— 真编译 fn + 真 better-sqlite3 CommDB + 真 Discord thread(真 fetch POST/GET),零 mock。
Harness: `packages/teamlead/qa-fly1041-real.mts`(在 `packages/teamlead` 下 `TMPDIR=/tmp/q1041 npx tsx qa-fly1041-real.mts`)。

## 点① — 单一可绑 ship gate(真 CommDB)

真 better-sqlite3 comm.db 全程:

```
=== POINT ① — single bindable ship gate (real CommDB) ===
  ✓ before retire: 2 bindable gates (ambiguity)
  ✓ retireShipGate(g1) → true
  ✓ after retire: exactly ONE gate, and it is g2
  ✓ report still pending for the Lead (relay unchanged): 1 gate + 1 report
  ✓ retire refuses an ANSWERED gate
  ✓ the real approval survives verbatim
  POINT ① PASS — real comm.db at /tmp/q1041/qa-fly1041-p1-Mhrsqq/comm.db
```

真 comm.db 终态快照(`point1-commdb-snapshot.txt`):

```
id        checkpoint       kind    state    answered
ff51ba22  approve_to_ship  (null)  RETIRED  -          ← g1 被 retire(掉出 founder 候选)
8a74aab0  approve_to_ship  (null)  live     answered   ← g2 = 唯一可绑,真批准落它身上
84b97954  (null)           report  live     -          ← runner 汇报,founder 候选集排除
```

**结论**:re-fire 造成的双 gate ambiguity(FLY-910 根因)被 Fix A retire 收敛为**恰一个**可绑 gate;真批准落到幸存 gate 后,retire 硬拒改写已答复 gate(invariant ②)。

## outbound approve_to_ship 卡 — 真 529 thread 往返

真 Discord POST 建 thread → 真编译 `emitFounderThreadNotification` 发卡 → 真 GET 取回卡体:

```
=== OUTBOUND CARD — real approve_to_ship card round-trip ===
  ✓ real thread created (id=1524781215385649332)
  ✓ notifier posted (kind=posted)
  ✓ real gate message id returned (1524781217579405503)
  ✓ founder_thread_notified audit event emitted
  --- real posted card body ---
🚀 **Ship gate 等你批准** — FLY-1041
<@1493068669444427927>

QA real-machine card verification

…实现 + code-review 完成、等你 ship。
直接**回复这条消息**或点 ✅ 即批准；其它回复不会被当成批准。批准绑定后我会在你的消息上点 ✅ 确认。
  ---
  ✓ card has the ship-gate header
  ✓ card carries the FLY-1041 Chunk 6 deterministic-binding guidance line
  ✓ card spells out that other replies are NOT approval
  ✓ card @mentions its owner
```

真机凭据:529 slot-1 频道(`1493080991290626079`)真 thread `1524781215385649332` / 真卡消息 `1524781217579405503`(留档不删)。

**owner 用非-Annie dummy snowflake**(`1493068669444427927`,slot-1 bot app id)——卡会 @mention owner,隔夜不打扰 Annie;owner 解析本身由单测覆盖,本真机腿验的是真 POST + Fix B 引导句往返。

**结论**:Fix B —— approve_to_ship 卡作为确定性批准载体,真机贴进真 thread,卡文案明确「回复这条消息 / 点 ✅ = 批准;其它回复不算」+ ✅ 回执承诺。

## 待补(需 Annie 真账号,Chrome-as-Annie standing rule)

②③④(reply-to-card 绑定 / ✅ reaction / ❓ 回执)结构性依赖一条来自 Annie 真账号的 founder 消息(deliverer 硬闸 `founder-reply-deliverer.ts:245` = `author.id===ownerUserId && author.bot!==true`,防伪,任何 bot 模拟不了)。等 Annie 早上 Discord 登录落地后,用 Chrome-as-Annie 在隔离 529 thread 补跑(纪律:只隔离 thread、只测试内容、留档)。
