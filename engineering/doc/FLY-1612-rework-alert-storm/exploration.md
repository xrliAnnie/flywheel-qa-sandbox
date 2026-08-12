# FLY-1612 rework 告警风暴治理 — 探索

Issue: FLY-1612 (https://linear.app/geoforge3d/issue/FLY-1612/告警治理-workflow-rework-held-重试无去重无退避直发-issue-thread-同一句话对-founder)
日期: 2026-08-12
基于: 无

## 1. Issue 陈述的病(两个发作口)

1. **第一口(2026-08-03,Annie 亲见)**:FLY-1602 QA FAIL 后 rework 再入被 `worktree_not_ready:worktree_dirty` 正确挡住,但 held 重试循环每次都向 **issue thread** 发同文消息(`⚠️ Workflow rework held — Request rework:7f88… could not safely re-enter actor …`),几分钟几十条,Annie 在 thread 里问 "what is this"。
2. **第二口(2026-08-11 夜,Cass 测量)**:#flywheel-alerts 16 小时 ~596 条 `Stalled rework activation detected for FLY-1686/FLY-1708`,~90s 一条,零新信息。issue 定位 emitter 为 StateStore.ts 的 `workflow_engine_escalation` 路径。

Issue 修法要求:去重键 = (run_id, reason, target_node) 级;首条即时、后续退避/合并计数;两口同一套机制;僵尸激活(`state_not_revivable:completed`)要有收敛路径,不能只静音。

## 2. 代码审计对 issue 假设的修正(先摸真相,再谈方案)

按惯例先全量审计(greenfield 禁令)。两条修正 + 一条强化:

### 修正一:第一口的 emitter 已经不存在了

逐字消息 `could not safely re-enter` 的发信代码(`plugin.ts` 里的 `alertHold` effect)已被 **PR #779(FLY-1638,2026-08-05 merge)整体删除**。当前 main 上 rework-held 重试循环**不再向 issue thread 发任何逐次消息**。第一口是历史病,已死;本单不需要也不应该再造它的"修复"。

### 修正二:第二口不是 "~90s 一条",是 **每 1 秒一条、30 分钟窗口内 1272 条**

生产库(`~/.flywheel/teamlead.db` 快照,2026-08-12 读)落库事件是铁证:

- 引擎 dispatcher tick = **1 秒**(`start(intervalMs = 1_000)`)。
- FLY-1680 的一个 rework request:60 分钟内 **2423 次 claim/release 热循环**(~1.5s 一圈),`rework_stalled_alert` 从 12:02:58(恰好 30 分钟 alert 阈值)到 12:32:55(恰好 60 分钟 hold 阈值)共 **1272 条**,hold 一发风暴即停。
- Cass 的 ~596/16h 是频道侧观测;发射侧真相更严重:**全库 11,729 条 workflow-engine 告警投递中 11,714 条(99.9%)出自这一个 emitter**,12 个 issue 各自 30 分钟爆发窗,**FLY-1710 今晨(08-12 07:40–08:10)还在发作 874 条** —— 病是活的。

### 强化:60 分钟 hold 能止住单次风暴,但每个新 rework request 都重新爆发

风暴不是无限的(hold 是终止器),但每次爆发已是 ~1000+ 条;且僵尸激活型 rework(目标 actor 已 completed)在 0–60 分钟内做的每一次重试都注定失败 —— 白烧一小时才撞上 hold。

## 3. 病灶解剖(三个缺陷,一个源头)

```
rework request → coordinator.reconcile (每 1s tick)
  → claim(generation+1) → 激活失败(worktree_not_ready / holder_activation_failed / reentry hold)
  → releaseAndHold → release(state 留 pending、无 hold_count、无 next_retry_at)   ← 缺陷 A:无退避热循环
  → 下一 tick 重来……
30 分钟后:reconcileWorkflowReworkStalls(每 1s)
  → escalateWorkflowReworkStall(eventUid 含 generation)                          ← 缺陷 B:去重键 = claim 计数器
  → generation 每秒在涨 → 每 tick 铸新 uid → 每秒一条告警 → alerts 频道
60 分钟后:hold → run 转 held,风暴停
                                                                                  ← 缺陷 C:僵尸激活无快速收敛,白烧满 60 分钟
```

- **缺陷 A(无退避)**:`releaseAndHold` 家族(`worktree_not_ready` / `holder_activation_failed` / reentry hold / `rework_reentry_disabled`)只 release 不 settle。对照组:**retryable 家族已有完整机制**(`settleWorkflowReworkFailure`:hold_count++、1/2/4/8 分钟 `next_retry_at` 退避、第 5 击转 `needs_lead` + 单条 severe 告警,2026-08-05 上线)。held 家族被漏在机制外。
- **缺陷 B(去重键错位)**:`rework_stalled_alert:${requestId}:${generation}:${executionId}` 把 **claim 计数器**当 episode id。姊妹 emitter(launch-stall)用 `${runId}:${nodeId}:${attempt}:${executionId}`,episode 稳定,历史仅 28 条 —— 健康对照组就在同一个文件里。
- **缺陷 C(僵尸无收敛)**:`state_not_revivable:completed`(目标 actor 处于不可逆终态)永不可能激活成功,现状靠 60 分钟 wall-clock hold 兜底。
- **通道侧无法兜**:outbox 投递刻意给每次 attempt 造新 transport eventId(`${escalationUid}:${attempt}`,claim-before-send 防误抑),ClaimsDB 去重对风暴天然失效 —— **修复只能在源头 escalationUid**。

## 4. 方向选项

### 选项 1(选定):held 家族并入现有 strike 机制 + 修去重键 + 僵尸快速终局

- 把 `releaseAndHold` 家族改走 `settleWorkflowReworkFailure` 同款 strike 机制(退避 + 5 击 → needs_lead + 单条告警)。
- `escalateWorkflowReworkStall` 的 uid 去掉 generation,改 episode 稳定键(向健康的姊妹 emitter 看齐)。
- `state_not_revivable:<不可逆终态>` 直接终局(复用 `isStateStoreIrreversibleTerminalForZombie`),不烧 5 击。
- 解堵成功时补一条收口告警(状态翻转收口语义)。

**理由**:删的比加的多;机制已存在且经产线验证,held 家族只是被漏在外面;告警量从结构上有界(每 episode ≤4 条 vs 1272 条),不需要另建计数器。

### 选项 2(否决):按 issue 字面建通用 (run_id, reason, target_node) 告警去重/合并计数层

否决理由:全库普查证明病灶唯一(99.9% 出自一个 emitter),其余 emitter 家族历史总量 ≤28 条且键形态健康。为一个病人建通用去重基建 = 给结构病加报警器(Annie 简单性三连明令的反模式);且 raw reason 入键有振荡重开风暴的风险(reason 文本每 tick 可变)。

### 选项 3(否决):只修去重键,不修热循环

否决理由:去重键修好后告警安静了,但 1s 热循环照烧(2423 圈/小时的 claim/release 写放大),僵尸激活照样白烧 60 分钟 —— issue 明说"去重只是把无限循环藏起来"。

## 5. 与关联单的边界

- **FLY-1648**(已 merge #788):治的是 held **pane-loss** rework 的 materialize 重试(`persisted_target_missing` 家族)+ runner-ship merge completion,同款 1/2/4/8 退避思想。本单把同思想补到它没覆盖的 `releaseAndHold` 家族,不动它已治的路径。
- **FLY-1570**(watchdog 拆除):不并单 —— 本单是引擎通知层的确定性缺陷,非 watchdog 猜测。
- **FLY-1611**(幽灵空消息):同族不同病,不在本单。
