# FLY-1771 patrol_tick 相位漂移锚定墙钟 — 调研

Issue: FLY-1771 (https://linear.app/geoforge3d/issue/FLY-1771/bug-patrol-tick-相位漂移每小时后漂-1-6-分钟335702应锚定墙钟整点)
日期: 2026-08-14
基于: exploration.md

以下全部为对本 worktree(branch `flywheel-FLY-1771`,base = main `59e8bd645`)的**实读事实**,
非记忆推断。

## 1. 唯一 producer 与调度链

- **唯一 producer**:`packages/teamlead/src/bridge/patrol-tick.ts` 的
  `runLeadPatrolTickPass()`(经 `createLeadPatrolTickPass()` 独立单飞包装)。
- **接线**:`plugin.ts:7379-7430` 构造 → `gate-poller.ts:677-681`
  `(tickCount - 1) % DEFAULT_PATROL_EVERY_N_TICKS === 0` 触发;
  `DEFAULT_PATROL_EVERY_N_TICKS = 20`(`gate-poller.ts:342`),
  生产 `pollIntervalMs: 3_000`(`plugin.ts:7421`)→ **nominal rider 粒度 60s**。
- `plugin.ts:7431` 的 `onReconcilePatrolTick` 是 turn-wake outbox drain(FLY-1505 面),
  **不生产 patrol_tick**,与本单无关(已核)。
- `/api/patrol/scan-stale`(plugin.ts:2749)是 GEO-270 stale-session 面,事件名不同,无关。

## 2. drift 根因代码(逐行)

`patrol-tick.ts:190-223`:

| 行 | 事实 |
|---|---|
| 190-193 | `getLatestPatrolTickEvent(leadId, sessionKey)` 取 journal 最新一条(StateStore.ts:10699-10711,`ORDER BY seq DESC LIMIT 1`,durable,跨 Bridge 重启) |
| 196-199 | `inspectDeliveryState()` 查该条投递的 mailbox settlement(typed 三态:absent_identity / live(state) / archived) |
| 200-204 | absent_identity → 幂等重投,本轮结束 |
| 205-211 | live QUEUED/LEASED → 在途,跳过(单条在途封顶) |
| 212-218 | `settlementAnchor()`:ACKED→`acked_at`,DEAD→`dead_at`,archived→还原终态时刻;`parseSqliteUtcMs` 解析,null 即 throw |
| **219-222** | **`if (nowMs - anchorMs < intervalMs) skip` —— due 判据。锚 = settlement 时刻 → 每轮把「投递结算滞后」累进相位。漂移根因。** |
| 225 | eventId 链式 dedup:`patrol_tick:${project}:${lead}:after-${prev.seq ?? "genesis"}` |
| 227-233 | payload(`HookPayload`):`event_type/execution_id(=sessionKey)/issue_id("")/project_name/roster/generated_at(=new Date(nowMs).toISOString())` |
| 234-245 | append journal → 读回 durable row → enqueue mailbox |

**每轮相位增量的构成**(与生产 1-6 min/h 吻合):
settlement 滞后(FLY-1751 攒批窗 30s + Lead 消费/ACK 耗时,分钟级)+ nominal rider 60s 粒度余数。

**FLY-1687 刻意性证据**:`engineering/doc/FLY-1687-lead-patrol-tick/plan.md:78`
「锚取结算时刻而非 created_at,积压 3h 后刚 ACK 不会 1 分钟内又来一条」。
该不变量必须保留(exploration §3 方案 C 的 `anchorMs < currentScheduledAt` 条件即为此)。

## 3. interval 配置(不动,仅消费)

`packages/config/src/patrol-config.ts:151-169` `effectivePatrolIntervalMs()`:
project `.flywheel/config.yaml` > global `~/.flywheel/patrol.json` > 默认 60min,
clamp `MIN/MAX_PATROL_INTERVAL_MINUTES`(10min..24h),每 pass 热读(FLY-1687 热调核心用例)。
founder ship gate rework 后,每个 Lead 的槽内相位为
`uint32BE(sha256(agentId)[0..4]) % intervalMs`;预定点公式为
`floor((now-offset)/interval)*interval+offset`。对任意合法 interval 都成立、同一 Lead 稳定、
不同 Lead 确定性错峰且不使用随机数。interval=60min 时每 Lead 每小时保持同一分钟/秒位。

## 4. 时间解析

`founder-notify-utils.ts:16-23` `parseSqliteUtcMs()`:含 `T` 的 ISO 原样 `Date.parse`,
SQLite `YYYY-MM-DD HH:MM:SS` 补 `T`+`Z`。**payload 的 `generated_at`/新增 `scheduled_at`
均为 ISO(带 T/Z),可直接复用该 helper**,不新写解析器。

## 5. payload / render / 契约面

- `hook-payload.ts:8-26` `HookPayload` 单接口 + optional 字段(event_type 为 discriminator,
  注释明示「新增 optional 字段,既有 call site 不破」)。新增 `scheduled_at?: string` 属既定扩展模式。
- `formatPatrolTick`(hook-payload.ts:247-264):正文只消费 `roster`,固定文案
  「[patrol_tick] 巡检时间到。」+ 名册。**新增 payload 字段不影响正文一个字节**。
- `fly369-patrol-rule.test.ts`:锁 Lead rules 文案锚点(patrol_tick 节),不锁调度公式 —— 不动。
- `patrol-tick-render.test.ts`:锁正文渲染 —— 不动(正文零变化)。

## 6. 既有测试盘点(patrol-tick.test.ts,14 例)

harness:纯 fake deps(注入 `now`/`store`/`inspectDeliveryState`/`enqueueLeadEvent`),
可直接扩展做确定性时间仿真,无需真 DB。

需要改的:
- `caps live QUEUED/LEASED at one and anchors ACKED/DEAD cadence to settlement time`(L242)——
  该测试**锁死了漂移行为本身**(settlement 锚 cadence)。改为:在途封顶断言保留;
  cadence 断言改为 slot 语义(late-settle slot 跳过 + 该 Lead 下一固定相位发)。
- `treats a live DEAD row as settled instead of wedging the chain`(L273)——
  DEAD 不楔死语义保留,due 时刻断言改 slot。
其余 12 例(genesis/零名册/unowned/单飞/journal winner/failure isolation/告警)预期不动或仅微调 now 值。

## 7. 生产兼容(存量 journal 行)

生产 `lead_events` 里既有 patrol_tick 行的 payload **无 `scheduled_at`**。
prevSlot 回退链:`parse(payload.scheduled_at ?? payload.generated_at)` 再投影到该 Lead 相位网格 ——
`generated_at` 自 FLY-1687 起必有(patrol-tick.ts:232 无条件写入);
若 payload 损坏到两者皆缺/不可解析(理论角落),与现状 anchor null 同类,走既有 throw→
failure tracker→severe 面,不新增静默分支。部署后第一拍即带 `scheduled_at`,链条自愈。
**无 migration、无 schema 变更**(payload 是 JSON 文本列)。

## 8. 部署形态

纯 Bridge 侧(teamlead 包)。生效 = merge 后生产重启 Bridge(patrol pass 在 Bridge 进程内),
无需重启任何 Lead。回滚 = revert + 重启,无状态残留(新字段只是 payload 里多一个 key,
旧代码读它自动忽略)。

## 9. 验收观测口径(给 QA/ship 节点)

按 (lead_id, session_key) **单链**取证(不同 Lead 已确定性错峰;全局 LIMIT 20 仍无法保证
覆盖任一单链六小时,也无法证明 slot 连续性):

```sql
-- 1) 挑一条观察窗内 roster 持续非空的链
SELECT lead_id, session_key, COUNT(*) n
FROM lead_events WHERE event_type='patrol_tick'
  AND created_at > datetime('now','-8 hours')
GROUP BY lead_id, session_key ORDER BY n DESC;

-- 2) 对选中链验相位 + 连续性(替换 :lead/:key)
SELECT seq,
       json_extract(payload,'$.scheduled_at') AS sched,
       json_extract(payload,'$.generated_at') AS actual,
       (strftime('%s', json_extract(payload,'$.generated_at'))
      - strftime('%s', json_extract(payload,'$.scheduled_at'))) AS drift_s
FROM lead_events
WHERE event_type='patrol_tick' AND lead_id=:lead AND session_key=:key
ORDER BY seq DESC LIMIT 10;
```
判定:取部署后**首拍重新锚定的正常拍之后**、interval 不变且无 Bridge 重启的窗;
至少 6 对相邻拍 `sched` 恰 +3600s,且所有 `sched mod 3600s` 相同。正常负载下
每拍 `drift_s ∈ [0, 60]`;若 `drift_s > 60`,先关联 GatePoller pass/Bridge 负载,
区分「rider 执行迟到」与相位漂移 —— 即使迟到,`sched` 序列仍必须保持固定相位。
mid-slot genesis/catch-up(重启/roster 重现/热调,plan §0)可由大 `drift_s` 识别,
不计入连续稳态窗(出现则窗重开)。
