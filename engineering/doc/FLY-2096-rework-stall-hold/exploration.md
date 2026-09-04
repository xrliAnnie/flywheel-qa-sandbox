# FLY-2096 rework 换体后 60 分钟 stall clock 打 held — 探索

Issue: FLY-2096 (https://linear.app/geoforge3d/issue/FLY-2096/病根-rework-换体后-60-分钟-stall-clock-把-run-打成-helddelivery-wake-delivered-无)
日期: 2026-09-03
基于: 无

## 0. 一句话

本单点名的病根(dispatcher 的 30/60 分钟 rework stall 时钟 + `escalateWorkflowReworkStall` 把 run 打成 `held`)已经在今天 19:29Z 合入 main 的 FLY-2278(PR #1053,commit `069013b25`)里被**整体退役**;生产 Bridge 此刻仍跑退役前的 `31da17817`,所以线上还在撞(今天 19:02Z FLY-2283 又被同形 hold)。FLY-2096 的剩余工作不是再修一次机制,而是:**钉死本单精确形状的回归证据、清掉退役残留、给存量 held run 一个诚实的处置边界。**

## 1. 本单的形状(按生产库重建)

生产 StateStore 只读副本(`~/.flywheel/teamlead.db`,2026-09-03T20:08Z 拷贝,`?immutable=1` 打开)里:

| 指标 | 值 |
|---|---|
| `workflow_run_event.kind = rework_activation_stalled_held` 总数 | 69 |
| 其中 2026-08-23 之后、reason 属于 `delivery_wake_delivered` / `delivery_awaiting_receipt` / `actor_alive_after_receipt` 家族 | 40 条,横跨 FLY-2029/2030/2031/2033/2049/2054/2074/2077/2080/2097/2101/2102/2103/2111/2121/2139/2152/2178/2204/2211/2216/2241/2283 |
| 最新一条 | 2026-09-03T19:02:08Z,FLY-2283 implement,reason `actor_alive_after_receipt` |
| 当前 `status='held'` 的 run | 9 条;其中恰好 1 条(FLY-2241,run `25703777…`)最新 hold 事件是 `rework_activation_stalled_held` |
| `rework_activation_stalled_alerted` 风暴 | 单 run 最多 1229 条(FLY-1612 已收敛过一次) |

Issue 里的 FLY-2074 案例逐字对得上:`b7f83b3d…` 在 2026-08-27T20:28:31.915Z 被 hold,reason `delivery_wake_delivered`,node `implement`。

**关键澄清(比 issue 描述更准的一点):** `wake_delivered` 不是「在等 receipt」的状态。换体路径 `materializeWorkflowReworkReplacement` 把 delivery 从 `replacement_pending` 直接写成 `wake_delivered`(`StateStore.ts:30152`),并同时投影 `sent_at` 与 `received_at` 两个时钟(`:30173` / `:30181`)—— 引擎已经把「换体上岗」当作收到了。真正需要 receipt 的是原体重入路径的 `awaiting_receipt`。旧扫描器的病不在 receipt,而在它对 **`wake_delivered` 这个已收到状态也按 `updated_at` 计龄**,唯一的逃生口是 coordinator 每 3 分钟(`WORKFLOW_DELIVERY_RECEIPT_REPROBE_MS`)写一次的 `actor_alive_after_receipt` + `next_retry_at` 未过期 —— 巡检 tick 只要落在两次重探之间的空档,`hasFreshActorAliveEvidence` 就是 false,60 分钟一到就 hold。这解释了为什么今天 FLY-2283 的 hold reason 本身就是 `actor_alive_after_receipt`:活着的证据被写进了 `last_error`,然后被当成 hold 理由。

## 2. 退役前的机制(已删,留作对照)

`git show 069013b25^` 可见:

- `WorkflowEngineDispatcher.reconcileWorkflowReworkStalls`(旧 `:1129-1262`):每 tick 扫全部 rework delivery,`sourceAt = delivery.updated_at`(pending 用 `requested_at`),`ageMs >= 30min` → `escalate("alert")`,`ageMs >= 60min && !hasFreshActorAliveEvidence` → `escalate("hold")`。不看 node 状态、不看 turn 是否已授、不看 pane。
- `StateStore.escalateWorkflowReworkStall`(旧 `:26948-27099`):`action='hold'` 时 `UPDATE workflow_run SET status='held'` + delivery → `held`,追加 `rework_activation_stalled_held` 事件与 severe 告警。
- 两个旋钮 `FLYWHEEL_ENGINE_REWORK_ALERT_MS` / `FLYWHEEL_ENGINE_REWORK_HOLD_MS`。

run 一旦 `held`,`commitWorkflowTransitionTx`(`StateStore.ts:45951`)对任何节点完成都返回 `engine_run_not_active` —— 这就是「完工被拒」。

## 3. FLY-2278 之后 main 上的实际行为

| 环节 | 现状(main `3bdbd7cbc`) | 出处 |
|---|---|---|
| 旧扫描器 / 旧 hold 写点 / 两个旋钮 | 已删;`fly2278-retirement.test.ts` 源码守卫断言四个符号不再出现 | `packages/teamlead/src/__tests__/fly2278-retirement.test.ts` |
| 换体后 delivery 的观测 | 落 `received` 阶段;rework 在 `RECEIPT_CONSUMPTION_DEADLINE_FAMILIES`,deadline 30 分钟、severe 90 分钟 | `delivery-contract/policy.ts`、`classify.ts` |
| 超期时怎么办 | `observeWorkflowDeliveryContract`:`family='rework' && stage='received' && overdue && recipientLiveness==='alive'` → 只关旧 episode(`advanced`),**零新 episode、零告警、零 run 事件**;整个函数没有任何 `status='held'` 写点 | `StateStore.ts:39884-39900` |
| 「活」的判据 | `classifyRecipientLiveness`:CommDB 10 分钟窗内有出站消息,或 `sessions.heartbeat_at` / `last_activity_at` 在 10 分钟窗内 | `delivery-contract/liveness.ts`、`liveness-evidence.ts`(FLY-2101 定死 600 000 ms) |
| Codex 换体会不会被判「活」 | 会。HeartbeatService 对 tmux 窗口还在的会话**每个周期刷新 `heartbeat_at`**(`HeartbeatService.ts:1388` 注释原话:every cycle while tmux is alive)。生产副本里 15 个 running 会话 heartbeat 全在拷贝时刻 1 分钟内,而 `last_activity_at` 最老的已经 15 小时 —— 判「活」不依赖体发任何消息 | 生产库副本 `sessions` 表 |
| 剩下还能把 run 打 held 的路径 | ① 冻结:只对 mailbox `mailbox_inflight_slots_exhausted`(30 分钟)与 turn wake `three_stage_turn_stuck`(20 分钟)两个形状,且要活性 `absent`;② undeliverable:rework 只在 `awaiting_receipt` / `replacement_pending` 且收件 session 非 live 时成立,`wake_delivered` 不在其中。两条都以证据为门,不再以龄为门 | `delivery-contract/watch.ts:118-133, 174-215`、`freezeWorkflowDelivery` |
| 节点完成时 delivery 结算 | `wake_delivered` → `completed`(CAS,失败抛 invariant) | `StateStore.ts:46868`、`:46947` |
| hold 形状注册表 | `rework_activation_stalled_held` 形状**保留**,resumeAction `resume_receipt_deadlock`,用于存量事件 | `hold-shape-registry.ts:86` |

结论:**main 上本单的形状已经不可能再发生**。issue 提的两条修法方向(「活着在干」当 receipt;hold 改成只 alert)FLY-2278 都做了,而且是更强的形式(alive 时连告警都不发)。

## 4. 还没闭合的四件事

### 4.1 生产还没部署

Bridge `/health` 在 2026-09-03T20:05Z 报 `buildSha=31da17817`(FLY-2276,#1052),比 #1053 早一个 commit。`com.flywheel.updater` 在 launchd 里注册但当前无 pid(按窗口跑)。**本单不部署、不重启**;闭合日期 = updater 把 ≥ `069013b25` 的构建拉上去那一刻,之后巡检 class_key `8c112426…` 应归零。

### 4.2 本单精确形状没有回归证据

FLY-2278 的测试集(`fly2278-*.test.ts` 17 个文件)没有一条把 `recipientLiveness` 喂进 `observeWorkflowDeliveryContract`(全仓 grep 只有 `alert-kind-copy.test.ts` 在测文案),`fly2278-liveness.test.ts` 只测分类器纯函数且 0 次提到 rework。`StateStore.ts:39884` 那条「alive 零写入」分支目前**没有直接测试**。这是 FLY-2096 该补的:一个以 issue 时间线为脚本的回归(换体 → 61 分钟 → 95 分钟 → 完工),对照组是 liveness `absent`(只告警、仍不 hold、完工照样成功)。

### 4.3 退役残留(只删不加候选)

| 残留 | 现状 | 处置建议 |
|---|---|---|
| `listWorkflowReworkDeliveries({ includeDeferred })` | 参数只被已删的扫描器传过;现存唯一调用方 `workflow-engine-dispatcher.ts:816` 传的是 `states + now` | 删参数与对应 SQL 位(实现时再 grep 一遍确认零调用) |
| `enqueueReworkRecoveredIfAlertedTx` 查 `rework_stalled_alert:` 前缀 | 只在存量 run 上还会命中,新 run 不再产生该前缀 | **保留**:它是历史事件的消费者,删了会让存量 run 的 recovered 事件消失 |
| coordinator 对 `wake_delivered` 每 3 分钟 claim 一次并写 `actor_alive_after_receipt` | FLY-2241 一条 run 上 `rework_delivery_claimed` 几十条;这不再驱动任何 hold,但仍是 tick 开销与事件噪音 | **不动**(超出本单;已在 ask 里向 Lead 点出,由 Lead 决定是否另开单) |

### 4.4 存量:FLY-2241 仍 held

run `25703777…`:delivery `held`(`last_error=delivery_awaiting_receipt`,2026-09-01T22:32Z),`general` 节点 attempt 1/2 都已 `done`,`land` 节点 `pending`,还有一条更早的 `land_held`。注册表里的 `resume_receipt_deadlock` 会把 delivery 重置成 `pending` 并铸新 route revision **重新向已完成的节点投递 rework**(`StateStore.ts:38603-38660`),这对一个已经 done 的目标不是正确动作。FLY-2278 plan §8 明确写了「不在本单扩 hold 形状覆盖存量 held run 中匹配不上的历史事件(QA 发现物另开单)」。**本单同样不改这条数据**,只在 plan 里给 Lead 一条可核对的处置建议。

## 5. 与本仓约束的对齐

- 只删不加:不加新 flag / 旋钮 / 表 / 列 / 告警层 / hold 形状(与 FLY-2278 的 0-预算一致)。
- 自托管规则:merge 与 deploy 分离,只有 updater 在窗口部署;本单设计里没有任何重启或部署步骤。
- 单一事实源:活性只认 `classifyRecipientLiveness` 一处,不再镜像出第二套「体是否在干活」词汇。

## 6. 给 Lead 的非阻塞问题(已发,question id `49386bb7-03c9-40b4-ac93-e1509fd5504e`)

FLY-2096 是否按「回归证据 + 残留清理 + 存量处置建议」收口;coordinator 3 分钟重探的 claim 噪音是否另开单。默认按此范围推进,Lead 有异议再改。
