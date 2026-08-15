# FLY-1771 patrol_tick 相位漂移锚定墙钟 — 实施计划

Issue: FLY-1771 (https://linear.app/geoforge3d/issue/FLY-1771/bug-patrol-tick-相位漂移每小时后漂-1-6-分钟335702应锚定墙钟整点)
日期: 2026-08-14
基于: research.md

## 0. 一句话

把 `patrol-tick.ts:219` 的 due 判据从「settlement 时刻 + interval」改为
「UTC epoch 整倍数 slot 边界」(cron 式),settlement 只保留「本 slot 内刚结算则本 slot 视为已服务」
一个否决条件(保 FLY-1687 积压不双发不变量);payload 加 `scheduled_at` 使漂移可观测;
加一条 12 仿真小时的相位 + 拍数 + slot 连续性断言(对旧公式必红)。

**精确语义(Codex R1-1 裁定)**:不是严格的「只在边界触发」,而是
**「每 slot 至多一拍;首次观察到当前 slot 未被服务时 catch-up 补发」**。
稳态(rider 活着、roster 持续、无重启)下「首次观察到」恰为边界后的第一个 rider pass
→ 边界 ±60s;扰动后(Bridge 停机中途重启、roster 长空后中途重现、interval 缩短)
第一拍是 mid-slot catch-up(`scheduled_at` = 所属 slot 边界,`generated_at - scheduled_at`
可能远超 60s,天然自标识),**下一拍即回到边界**。不为消灭这一次性 catch-up
引入新 timer/状态机 —— 巡检幂等,扰动后尽快巡逻本就是想要的行为。

## 1. 改动面(仅 2 个生产文件 + 测试)

### 1.1 `packages/teamlead/src/bridge/hook-payload.ts`

`HookPayload` 接口新增一个 optional 字段(既定扩展模式,research §5):

```ts
/** FLY-1771: patrol_tick 本拍所属墙钟 slot 边界(ISO)。genesis 拍 = generated_at。
 *  漂移 = generated_at - scheduled_at。仅入 payload/journal,不入 render 正文。 */
scheduled_at?: string;
```

`formatPatrolTick` 零改动(正文字节不变)。

### 1.2 `packages/teamlead/src/bridge/patrol-tick.ts`

**(a) due 判据**(替换 L212-223 的 anchor-interval 段;L194-211 的
absent_identity 重投与 QUEUED/LEASED 在途封顶**原样保留**):

```ts
// FLY-1771: wall-clock slot due. Phase anchors to UTC epoch multiples of
// intervalMs (interval=60min → every hour :00), so delivery/settlement
// latency no longer accumulates into the phase (production drifted 1-6
// min/hour off the settlement anchor). The settlement time keeps exactly
// one job: a slot in which the previous delivery settled counts as served
// (FLY-1687 §78 — a 3h-backlogged tick that just ACKed must not be
// followed by another within a minute).
const currentSlotStart = Math.floor(nowMs / intervalMs) * intervalMs;
const prevBasis = parseSqliteUtcMs(
    prevPayload.scheduled_at ?? prevPayload.generated_at,
);
if (prevBasis == null) {
    throw new Error("patrol_tick payload lacks scheduled_at/generated_at");
}
const prevSlotStart = Math.floor(prevBasis / intervalMs) * intervalMs;
const anchor = settlementAnchor(settlement);      // 既有函数,原样
const anchorMs = parseSqliteUtcMs(anchor);
if (anchorMs == null) {
    throw new Error(`invalid patrol settlement timestamp: ${String(anchor)}`);
}
if (prevSlotStart >= currentSlotStart || anchorMs >= currentSlotStart) {
    failures.succeeded(project.projectName, lead.agentId);
    continue;
}
```

`prevPayload` = `JSON.parse(previous.payload)`,只读两个字段;parse 失败与字段缺失
同走 throw → 既有 failure tracker/severe 面(research §7,不新增静默分支)。

**(b) payload 写入**(L227-233):

```ts
const payload: HookPayload = {
    ...,
    generated_at: new Date(nowMs).toISOString(),
    scheduled_at: previous
        ? new Date(Math.floor(nowMs / intervalMs) * intervalMs).toISOString()
        : new Date(nowMs).toISOString(),   // genesis:非按点触发,如实记
};
```

**明确不改**:eventId 链式 dedup、单飞、failure tracker、30min 告警冷却、
unowned roster 面、`settlementAnchor()`、`inspectDeliveryState` 合同、render、
rider 粒度(60s)、interval 配置解析。零新配置/flag/timer/schema/表。

## 2. 语义矩阵(实现者照此写测试)

| # | 场景 | 旧行为 | 新行为 |
|---|------|--------|--------|
| 1 | 稳态:prev slot 02:00,settle 02:03,pass 于 03:00:00-59 | 03:03+ 才 due(漂) | **03:00 pass 即 due**(整点 ±60s) |
| 2 | 稳态重复 12h,每拍 settle 滞后 0-5min | 相位累漂 12-60min | 每拍 `generated_at mod interval ≤ 60s` |
| 3 | 积压:prev slot 02:00,05:37 才 ACK,pass 05:38 | 06:37+ due | **05:00 slot 被否决(anchor≥slot),06:00 due** —— FLY-1687 不变量保留 |
| 4 | 在途 QUEUED/LEASED,已过 slot 边界 | 跳过 | 跳过(不变;结算后下一边界再发,不补积欠) |
| 5 | DEAD 于 05:37 | 06:37+ due | 同 #3:06:00 due(不楔死,语义不变、时刻变) |
| 6 | absent_identity | 幂等重投 | 不变 |
| 7 | genesis(该 (project,lead) 首拍) | 立即发 | 立即发;`scheduled_at = generated_at` |
| 8 | genesis 后首个正常拍:genesis 02:59(slot 02:00),03:00 边界 | — | 03:00 due(1 分钟后;一次性 boot 邻近,接受,见 §4 风险 R3) |
| 9 | 存量行无 `scheduled_at`(生产升级首拍) | — | 回退 `generated_at` floor 出 prevSlot;之后遵循 §0 catch-up 规则(部署重启本身即一次扰动:当前 slot 未服务则先 catch-up 一拍,下一拍回边界。Codex R2 LOW) |
| 10 | interval 热调 60→30min 于 02:40(prev slot 02:00) | — | 02:40 pass:currentSlot 02:30 > prev → due(catch-up 一拍),此后 :00/:30 |
| 11 | interval 热调 60→120min 于 03:05(prev slot 02:00,老 interval 下记) | — | currentSlot = floor(03:05/2h) = 02:00,不 > prev → 04:00 才 due |
| 12 | Bridge 停机 3h(prev slot 02:00、02:03 已结算),05:30 重启 | 恢复后按 anchor+1h | **05:30 立即 mid-slot catch-up 一拍**(scheduled_at=05:00,drift 30min 自标识),06:00 起回边界;不补 3 拍 |
| 13 | payload 两时间字段均缺/坏(理论角落) | — | throw → failure tracker → 连续 3 次 severe(既有面) |
| 14 | roster 长空数小时后 05:30 中途重现(prev 已结算) | 05:30 发(相对锚) | 同 #12:05:30 catch-up 一拍,06:00 起回边界 |

## 3. TDD(RED → GREEN 顺序)

在 `patrol-tick.test.ts` 既有 fake-deps harness 上做,无真 DB:

1. **RED-1(founder 直令断言,Codex R1-2 收紧)**:新增
   `keeps every steady-state tick on the wall-clock slot with no missed or duplicate slot`
   —— 仿真 12h:rider 每 60s 一 pass,每拍发出后注入 0-5min 确定性伪随机 settle 滞后
   (固定种子序列,生产形状),genesis 拍剔除后断言**四件事**:
   (a) **拍数恰为 12**(每 slot 恰一拍 —— 只发一拍或隔两小时一拍的错误实现不能绿);
   (b) 相邻 `scheduled_at` 逐对**恰差 intervalMs**(无跳 slot、无重复 slot);
   (c) 每拍 `scheduled_at % intervalMs === 0`;
   (d) 每拍 `Date.parse(generated_at) - Date.parse(scheduled_at) ∈ [0, 60_000]`。
   **先对现行代码跑确认红,且红的形状必须是相位累漂/漏拍**(逐拍打印
   generated_at 序列人工核对一次),不是 harness 假红。
2. **RED-2**:改写 L242 既有测试:在途封顶断言保留;「anchors cadence to settlement time」
   断言改为矩阵 #3(late-settle slot 否决 + 下一边界 due)。
3. **RED-3**:矩阵 #9(legacy 无 scheduled_at 回退)、#10/#11(热调)、
   #12/#14(mid-slot catch-up:重启/roster 重现 → 立即一拍 + 下一拍回边界)、
   #13(坏 payload → failed 路径)。
4. **GREEN**:实施 §1 改动,1-3 全绿。
5. **回归**:patrol-tick.test.ts 其余全部、`patrol-tick-render.test.ts`、
   `fly369-patrol-rule.test.ts`、`StateStore.patrol-tick.test.ts` 零改动通过
   (render/rules 若需动即说明设计有泄漏,停下重审)。

## 4. 风险

| # | 风险 | 处置 |
|---|------|------|
| R1 | 全部 Lead 的拍收敛到同一 :00 → 同一 pass 内 14 个 append+enqueue | 量级平凡(单 pass 单飞内顺序执行,毫秒级/条);FLY-1687 本就单 pass 全 fleet 扫。不做 jitter(YAGNI,验收要求恰恰是同点) |
| R2 | 推翻 FLY-1687 已 review 的 settlement 锚 | 不是推翻是收窄:settlement 从「相位锚」降为「本 slot 已服务」否决条件,其保护的原始场景(§78)在矩阵 #3 显式锁测 |
| R3 | genesis 邻近边界时 1 分钟内两拍(矩阵 #8) | 每 (project,lead) 终生一次、且需 genesis 恰落在 slot 尾分钟;巡检幂等,接受并记录,不为它加抑制逻辑 |
| R4 | 存量 payload 解析新增 JSON.parse 失败面 | 与既有 anchor-null 同路径(throw→severe),矩阵 #13 锁测;`generated_at` 自 FLY-1687 起无条件写入,实际缺失概率≈0 |
| R5 | 非 60min interval 下「整点」预期 | slot = epoch 整倍数,对 founder 文案统一说「固定锚点」;60min 时即 :00。设计文档与 HTML 明示 |
| R6 | mid-slot catch-up 拍(矩阵 #12/#14)被误读成「又漂了」 | `generated_at - scheduled_at > 60s` 自标识 catch-up;验收窗定义显式排除(§5);每次扰动至多一拍,下一拍即回边界 —— 与「持续累漂」可分辨 |

## 5. 验收

- 单测:§3 全绿;全仓 `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(按 host 纪律定向跑)。
- 生产(ship 后 QA/founder 观察项,Codex R1-3 收紧,可执行 SQL 见 research §9):
  **按 (lead_id, session_key) 单链取证**,选一条观察窗内 roster 持续非空的链;
  观察窗从**部署后第一拍重新锚定的正常拍之后**开始,窗内 interval 不变、无 Bridge 重启
  (出现扰动则窗重开 —— 扰动拍是 catch-up,`drift > 60s` 自标识,不算失败但不计入连续链);
  断言至少 6 对相邻拍 `scheduled_at` 恰 +1h,且每拍 `generated_at - scheduled_at ∈ [0, 60s]`。
- payload 可见 `scheduled_at` vs `generated_at` 两字段,漂移一列 SQL 可查。
- 部署:纯 Bridge 侧,merge 后一次 Bridge 重启生效,无需重启 Lead;回滚 = revert + 重启,零状态残留。

## 6. 不做(scope 边界)

不补发错过 slot;不加 anchor offset 配置;不加运行时漂移自告警;不动 rider 粒度、
mailbox 语义、render 正文、Lead rules;不迁移存量 payload。

## 7. Founder rework:per-Lead 槽内确定性错峰(2026-08-14)

Founder 在 ship gate 选择方案 B:保留墙钟锚定,但避免所有 Lead 在同一个整点 pass
集中触发。本节取代 §4 R1 与 §6「不加 anchor offset」;其余设计、TDD 与不变量继续有效。

- 对每个 `lead.agentId` 计算稳定偏移
  `offsetMs = sha256(agentId).uint32BE % intervalMs`;不使用随机数、进程启动时刻或
  上一拍结算时刻,因此同一 Lead 在 interval 不变时永远处于同一相位。
- 当前预定点为
  `scheduledAt = floor((nowMs - offsetMs) / intervalMs) * intervalMs + offsetMs`。
  每个 Lead 的相邻预定点仍严格相差 `intervalMs`,处理与 settlement 耗时不进入相位。
- `generated_at` 继续表示实际 pass 时刻;`scheduled_at` 一律表示上述 Lead 相位网格上的
  预定点。genesis 与 mid-slot catch-up 也记录最近一个已到达的预定点,不再用 actual
  覆写 scheduled,因此 `generated_at - scheduled_at` 始终是同一口径的可观测 drift。
- due 判断把原来的 epoch slot start 替换为该 Lead 的 `scheduledAt`;上一拍 basis 也按
  同一相位网格归槽。`absent_identity` redrive、`QUEUED/LEASED` 在途封顶、settlement
  落在当前相位 slot 后否决 catch-up、链式 eventId 与 durable winner 均不改。另保留
  FLY-1687「刚结算不立刻双发」语义:若 settlement 落在边界前不足一个 60s rider 周期,
  该 pass 跳过,下一 rider 对同一 `scheduled_at` 补发,不改变相位。
- 新增测试锁定:(1) 同一 agentId 偏移稳定且落在槽内;(2) 两个 Lead 的 steady-state
  `scheduled_at`/`generated_at` 分处不同相位;(3) 连续 12 拍的
  `scheduled_at % intervalMs === offsetMs`、相邻恰差 interval、drift 在 rider 60s 内;
  (4) late settlement、热调、restart/roster re-entry 与 FLY-1687 既有防双发矩阵按
  per-Lead 相位平移后保持。
