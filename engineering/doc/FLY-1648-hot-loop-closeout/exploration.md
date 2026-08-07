# FLY-1648 热循环收口:held rework 死账手术 + 恢复循环退避与终态 — 探索

Issue: FLY-1648 (https://linear.app/geoforge3d/issue/FLY-1648/workflow-引擎批0-热循环收口held-rework-死账手术fly-1150fly-1596-恢复循环加退避与终态)
日期: 2026-08-06
基于: 无

## 1. 问题是什么

workflow 引擎的 dispatcher 每 1 秒 tick 一次(`WorkflowEngineDispatcher.start(intervalMs = 1_000)`),其中两条扫描路径对「永远修不好的账」**无退避、无终态、无重试上限**:

1. **held rework 恢复循环**(`reconcileWorkflowReworks`,`workflow-engine-dispatcher.ts:738-865`):对每条 `state='held' && last_error='persisted_target_missing'` 的 delivery,每 tick 做一次 tmux liveness 探针 + 一次 `materializeWorkflowReworkReplacement` 事务。失败(`rework_replacement_target_changed`)后不改任何状态,下一 tick 原样再来。
2. **runner-ship merge completion 扫描**(`reconcileRunnerShipMerges`,`workflow-engine-dispatcher.ts:556-736`):对每个 approved+bound 的 runner_ship gate holder,每 tick 尝试 `completeWorkflowGateRunAfterShip`。失败(`carrier_session_mismatch`)后 holder/run 不变,candidate 下一 tick 原样重来。

**实测(2026-08-06,旧栈 `/tmp/flywheel-bridge.log`)**:最近 2000 行日志中 1104 行 `rework_replacement_target_changed` + 552 行 `carrier_session_mismatch`,合计 **~83% 的日志是热循环刷屏**。1104 ≈ 2×552 与「2 条 rework 账 + 1 条 gate 账、每 tick 各一次」精确吻合。

这是 1572 r4 重迁的第一硬前置:r3(2026-08-06 11:55 MDT)的新 Bridge(84df9168)健康启动 2 分钟后被该循环堵死 event loop → /health 超时 → 被判死。

## 2. 三条死账的地面真相(2026-08-06 只读取证,`~/.flywheel/teamlead.db`)

### 账 1:`rework:389336…`(FLY-1150,run `d015ad38` = held)

- delivery: `state=held, last_error=persisted_target_missing, hold_count=0, next_retry_at=NULL`(2026-07-24 起)
- route revision 1: target = `implement` attempt **2**,preferred actor `0555207c`
- **死因**:`workflow_run_node (implement, attempt 2)` 已是终态 **`failed`**(2026-07-25 ended)。`materializeWorkflowReworkReplacement` 要求 target node `state IN ('pending','admitted')` 且 `execution_id` 匹配(`StateStore.ts:20269-20280`)→ 永远返回 `rework_replacement_target_changed`。
- run 后来又有 attempt 3(failed)/ attempt 4(pending, 另一 execution)— route 指的那个世界早已不存在。

### 账 2:`rework:e26a21…`(FLY-1596,run `9c785ed9` = **现已 held**)

- delivery: `state=held, last_error=persisted_target_missing`(2026-08-04 起)
- route revision 1: target = `implement` attempt **2**,preferred actor `695938e5`
- **死因与账 1 完全同构**:node `(implement, 2)` 已 **`failed`**(2026-08-05 ended)。
- 注:issue 取证时(12:45 MDT)该 run 还是 active;现库里已是 held——与账 1 汇合进同一条恢复分支,与日志 1104=2×552 吻合。

### 账 3:`workflow-gate:8213…`(FLY-1596 第二个 run `fee58f20` = active@founder_gate)

- holder: `state=approved, carrier_binding_state=bound, head_sha=f95c4b42…, authority_mode=runner_ship`
- PR **真实已 merge**(#778 `ed54c0d4` 在 main;merge 探针观测 valid、head 与 holder 一致)
- **死因**:完成事务里唯一的 carrier 收口 UPDATE 要求 `sessions.status IN ('awaiting_review','approved_to_ship')`(`StateStore.ts:33306-33320`),而 carrier session `37282acb` 已是终态 **`blocked`**(terminal_at 2026-08-05 20:33:50,FLY-1505 deflect 家族行为)→ 0 行命中 → `carrier_session_mismatch`,且此失败**不写 dead-end memo**,candidate 永不出列。

### 附带发现:2 条「冷死账」(不刷屏,但也永远没有出口)

- `rework:d90e10f0…`(FLY-1150,founder rework,held / `terminal_status_unconfirmed`)
- `rework:1eb8e15…`(FLY-1571,qa rework,held / `worktree_not_ready:head_mismatch:…`)

它们的 last_error 不匹配恢复分支的谓词,run 又是 held,所以两条扫描都跳过 → 完全惰性。**不属于本单手术 scope**(issue 点名 2+1),但本单新增的合法出口工具天然覆盖它们,留给 Lead 决定。

## 3. 为什么会出现这种状态组合(病理)

恢复分支(FLY-1628 引入)设计假设:「held + persisted_target_missing」意味着 *target node 还停在 pending/admitted、只是 actor pane 死了*,于是探活→换人。但生产里存在另一条历史路径把 target node 直接打成 `failed`(node 终态化)而 **没有同步结清 rework delivery**——留下「delivery 说等换人、node 说早死了」的账面矛盾。恢复分支遇到这种矛盾时的行为是:每 tick 探活(tmux 子进程)+ 开事务 + 失败 + log,**无任何状态推进**。

merge completion 侧同理:FLY-1624 给 merge 探针加了预算和 dead-end memo,但 `completeWorkflowGateRunAfterShip` 的失败(`carrier_session_mismatch` / `ship_claims_invalid`)只写一条 checked 失败事件(幂等,只落一次),**不产生任何让 candidate 出列的记号**。

## 4. 已有机制盘点(决定「无聊解」长什么样)

审计发现本仓已经有全部需要的骨架 —— 本单不需要发明新机制,只需要把两条失败路径接进去:

| 既有机制 | 位置 | 与本单的关系 |
| -- | -- | -- |
| `workflow_rework_delivery` 已有 `hold_count` / `next_retry_at` 列 + `needs_lead` 终态(CHECK 约束里) | schema | 退避与终态的存储零迁移 |
| pending/turn_granted 投递失败已有「60s·2^n 退避、5 次封顶转 `needs_lead` + 一次性 severe alert」 | `StateStore.ts:20794-20960`(FLY-1638) | 恢复循环照抄同一预算/公式/告警形态 |
| `listWorkflowReworkDeliveries` 已内建 `next_retry_at <= now` 过滤 | `StateStore.ts:20146-20167` | 写了 next_retry_at,lister 零改动自动退避 |
| `needs_lead` 已有 master 级复活路径:`openOperatorRework`(支持 run held + needs_lead 清账 `rework_needs_lead_cleaned`) | `StateStore.ts:22636+`(FLY-1434),HTTP 入口 `runs-route.ts:877` | 转 needs_lead 不是死路,Lead 有现成工具重开 |
| merge 扫描已有 durable 出列记号:`runner_ship_merge_deadend:*` checked event → lister 排除 | `StateStore.ts:32508-32518`(FLY-1624) | completion 失败照抄同一 memo-出列模式 |
| dispatcher 已有进程内退避 Map 先例(`shipReadyFounderRetries`) | `workflow-engine-dispatcher.ts:886-897` | completion 失败计数直接复用此形态 |
| StateStore 已是 better-sqlite3(FLY-663),文件后端 | `StateStore.ts:11,173-197` | **手术可以在旧栈运行中由外部进程走合法事务执行**,写入对下一 tick 可见,无需重启旧 Bridge |

## 5. 方向选项

### 手术层(结掉 3 条账,旧栈立即停刷)

- **A. 走新增合法出口方法的一次性脚本(选定方向)**:PR 里新增 StateStore 合法出口(held→needs_lead 结账 / gate terminal-carrier 收口),附带 `scripts/` 一次性手术脚本(dry-run 默认,`--apply` 显式),merge 后从 main checkout 对生产 DB 执行。better-sqlite3 共享文件 + CAS 事务 → 与旧栈 tick 并发安全;结果对旧栈下一 tick 生效:needs_lead 出 `['pending','turn_granted','held']` 列表、completed run 出 candidate 列表 → **刷屏立即消失,不重启旧 Bridge**。
- B. 直改 SQL:被 issue 红线禁止(append-only 触发器 + 会跳过事件/告警/不变量),弃。
- C. 先部署新代码靠退避机制自然结账:把手术耦合进 r4 级重启风险,且 5 次退避 ≈ 31 分钟内还在刷;违背「手术效果立即可见于旧栈」的验收,弃(但作为兜底路径成立)。

### 防再发层(代码)

- **D. 复用既有退避+终态骨架(选定方向)**:恢复循环失败 → hold_count++/next_retry_at(60s·2^n),5 次封顶 → needs_lead + 一次 severe alert(照抄 FLY-1638 形态);completion 失败 → 进程内计数(shipReadyFounderRetries 形态),5 次 → durable dead-end memo 事件 + lister 出列 + 一次 alert。另补一条**诚实收口臂**:carrier 已终态但 question+head 完全匹配时允许完成 run(记录 disposition,不复活 session)——这是账 3 的合法终局(PR 真 merge 了,run 完成才是事实)。
- E. watchdog / 陪跑监控 / 周期重告警:issue 红线明确弃——「失败转人工态本身就是出口」。
- F. 调大 tick 间隔 / 限流日志:只治症状,必败重试仍无界,弃。

## 6. 关键约束

- **不加新 env flag**(Annie 铁律,FLY-1466 先例):N=5、60s 基数等常量内联,与既有路径字节同款。
- **不加告警机制**:只复用既有 `enqueueWorkflowEngineAlertTx` 在**进入终态那一刻**发一次 severe(与 FLY-1638 needs_lead 完全同形),绝无周期性重报。
- 正常恢复路径(target 仍 pending/admitted + actor 真死)行为零变化——成功路径一行不动。
- session `blocked` 终态**不回写**(终态免疫,FLY-228/229;run 事件里记 disposition 才是诚实账)。
