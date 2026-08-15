# FLY-1771 patrol_tick 相位漂移锚定墙钟 — 探索

Issue: FLY-1771 (https://linear.app/geoforge3d/issue/FLY-1771/bug-patrol-tick-相位漂移每小时后漂-1-6-分钟335702应锚定墙钟整点)
日期: 2026-08-14
基于: 无

## 1. 问题陈述

生产 `lead_events` 实测:patrol_tick 名义每小时一发,实际相位持续后漂 —— 8-14 一天内
02:33→03:35→04:35→05:37→06:39→07:40→08:46→09:47→10:52→11:55→12:57→13:58→15:00→16:02 (UTC),
每小时漂 1-6 分钟。后果:founder 以整点预期核对时误判「漏拍」(8-13 晚 23:23 班「缺席」实为
23:39 才响),引发夜班双保险人工 cron。founder 直令修:tick 调度锚定墙钟。

## 2. 根因(已在代码中确认,非猜测)

`packages/teamlead/src/bridge/patrol-tick.ts:219`:

```ts
if (nowMs - anchorMs < intervalMs) { /* skip */ }
```

其中 `anchorMs` = 上一条 patrol_tick 投递在 mailbox 里的 **settlement 时刻**
(`acked_at` / `dead_at`,经 `settlementAnchor()` 取出)。即:下一拍 ≈ 上一拍
**被 Lead 消费结算的时刻** + 60min,再向上取整到下一个 GatePoller rider pass
(3s tick × `DEFAULT_PATROL_EVERY_N_TICKS=20` = 60s 粒度)。

每轮相位增量 = settlement 滞后(mailbox 攒批窗 30s(FLY-1751)+ Lead 实际 ACK 耗时)
+ rider 60s 粒度余数。这些量级(约 1-6 分钟)与生产漂移逐字吻合。issue 猜的
「setInterval 自漂」方向正确,但机制不是 timer 自漂(rider 是固定 3s setInterval,不漂),
而是 **due 判据的锚点选了 settlement 时刻** —— 这是 FLY-1687 plan.md §78 的**刻意决策**:

> 锚取结算时刻而非 `created_at`,积压 3h 后刚 ACK 不会 1 分钟内又来一条

即当时为了「积压恢复后不立刻双发」把锚放到了 settlement 上,代价是稳态下处理耗时
逐轮累进相位。本单的设计必须**同时保住这个不变量**(积压刚结算不立刻重发)
**和墙钟对齐**(每个 Lead 稳态固定在自己的分钟/秒相位响),并按 founder ship gate 裁决让
不同 Lead 在一小时槽内确定性错峰,避免所有 Lead 同时唤醒。

## 3. 方案空间

### 方案 A:纯 slot 对齐(cron 式)

due ⇔ `floor(now/interval)` 所在 slot 尚未发过。稳态相位固定;
但积压 3h 刚 ACK 后,当前 slot 未发过 → **1 分钟内立刻再发一条**,
直接推翻 FLY-1687 R1/R2 review 定下的不变量。拒绝。

### 方案 B:slot 对齐 + 相对最小间隔守卫

due ⇔ slot 未发过 AND `now - settledAnchor >= 某最小守卫`(如 10min)。
保住不变量,但引入一个新的 magic number/半配置,且守卫值的选择没有原则性来源
(多少算「刚 ACK」?)。违反简单性铁律(不加新旋钮)。拒绝。

### 方案 C(选定):slot 对齐 + 「settlement 落在本 slot 内视为本 slot 已服务」

```
offsetMs           = uint32BE(sha256(agentId)[0..4]) % intervalMs
currentScheduledAt = floor((now - offsetMs) / intervalMs) * intervalMs + offsetMs
prevScheduledAt    = floor((parse(prev.scheduled_at ?? prev.generated_at) - offsetMs)
                           / intervalMs) * intervalMs + offsetMs
due ⇔ prevScheduledAt < currentScheduledAt AND anchorMs < currentScheduledAt
```

- **稳态**(以 `eng-lead` 为例,固定相位 = 每小时 `:33:22.707`):上一拍 02:33:22、
  settle 02:36,03:33:22 后第一个 rider pass 两个条件同时成立 → 在该固定相位后的
  nominal 60s rider 窗内发。处理耗时**不进相位**。
- **积压恢复**(FLY-1687 场景):上一拍 02:33:22、05:37 才 ACK。05:38 pass:
  anchor(05:37) ≥ 本 Lead 当前预定点(05:33:22) → 本槽视为「已被刚结算的 stale tick
  服务」并跳过;06:33:22 后再正常发。**不变量保住,且下一拍回到该 Lead 的固定墙钟相位**。
- 零新配置、零新 flag、零新 timer、零 schema 变更(FLY-1466 铁律 + 简单性铁律)。
- 同一 `agentId` + interval 总得到同一槽内偏移,不使用随机数;interval=60min 时每 Lead
  每小时固定在同一个分钟/秒位。非整小时 interval(如 90min)同样是确定性墙钟网格。

### 其余保持不变的既有语义(FLY-1687 合同)

- QUEUED/LEASED 在途 → 跳过(每 Lead 至多一条在途 tick,不补发积欠);
- absent_identity(append→enqueue 崩溃窗)→ 幂等重投,不铸新 tick;
- DEAD / archived_terminal → 视为已结算,链不楔死;
- genesis(该 (project,lead) 从未发过)→ 立即发(名册非空即巡逻,不等下一个相位点);
- 失败隔离 + 连续 3 次 severe 告警 + 30min 冷却 → 原样;
- render body(「[patrol_tick] 巡检时间到。+ 名册」)**字节不动** —— FLY-1687 founder 定稿正文,
  fly369 契约测试锁定;可观测字段进 payload JSON(journal),不进正文。

## 4. 可观测性(founder 直令的第二个交付)

payload 新增 `scheduled_at`(本拍所属 slot 起点 + 该 Lead 固定偏移,ISO;genesis 也写
当前时刻之前最近的同网格预定点)。既有 `generated_at` 即实际触发时刻。
漂移 = `generated_at - scheduled_at`,直接在 `lead_events` payload 里可查,
生产验收(连续 6h 落在锚点 ±60s)可用一条 SQL 核对。

## 5. 断言(founder 直令的第三个交付)

新增确定性仿真测试:注入 nominal rider 60s 步进 + 每拍 settlement 滞后 0–5min(生产形状),
跑 12 个仿真小时,断言每一拍相对该 Lead 偏移后的模 interval 误差 `≤ 60_000ms`
(正常 rider 粒度上界,比方差表述更强)。该测试对旧公式必红(旧代码 12h 漂 12–60min),对新公式绿 ——
标准 RED→GREEN。

## 6. 边界(本设计不做什么)

- 不改 nominal rider 粒度(60s);正常负载下 0–60s 抖动是验收口径。若 Bridge 负载令
  rider 实际间隔超过 60s,`scheduled_at` 仍不漂,但 `generated_at - scheduled_at` 会暴露迟触发;
- 不补发错过的 slot(Bridge 停机 3h → 只发最新一拍,与现状一致);
- 不改 mailbox lease/batch/死信语义,不动 FLY-1573/1574 面;
- 不加运行时自监控告警(修结构,不加报警器);
- 不提供用户可配的「anchor offset」旋钮;内部 `hash(agentId)` 确定性偏移是 founder
  ship gate 指定的错峰规则。
