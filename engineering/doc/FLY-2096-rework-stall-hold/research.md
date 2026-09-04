# FLY-2096 rework 换体后 60 分钟 stall clock 打 held — 调研

Issue: FLY-2096 (https://linear.app/geoforge3d/issue/FLY-2096/病根-rework-换体后-60-分钟-stall-clock-把-run-打成-helddelivery-wake-delivered-无)
日期: 2026-09-03
基于: exploration.md

## 0. 调研目标

exploration.md 已确认机制本身被 FLY-2278 退役。本文回答三个落地问题:

1. 能不能写一条**在退役前代码上会红、在 main 上会绿**的回归测试(Lead 要求的阳性对照)?
2. 退役残留里哪些是零调用的死代码,删掉是否安全?
3. 存量 FLY-2241 held run 的处置建议怎么写才可核对且不越权?

## 1. 阳性对照的可行性

### 1.1 两棵树上都存在的公开 API

| API | main(`3bdbd7cbc`) | 退役前(`069013b25^`) | 用途 |
|---|---|---|---|
| `StateStore.create(":memory:")` | ✓ | ✓ | 内存库 |
| `importWorkflowTemplateSeed` / `materializeWorkflowRun` / `upsertWorkflowRunNode` / `upsertSession` / `applyWorkflowLedgerBatch` | ✓ | ✓ | 铸 run-1(现有 `storeWithIntent` fixture 逐行用的就是这些) |
| `commitWorkflowTransitionTx` | ✓ | ✓ | 节点完成;held 时返回 `engine_run_not_active`(`:45951`) |
| `materializeWorkflowReworkReplacement` | ✓ | ✓ | 换体铸造(现有 `storeWithMaterializedFounderReplacement` fixture) |
| `markWorkflowReworkReplacementLaunched` | ✓ | ✓ | 换体上岗 → delivery `wake_delivered`,`updated_at = now`(`:30094-30190`) |
| `WorkflowEngineDispatcher({ store, startDispatcher, env, now, reconcileWorkflowRework })` | ✓ | ✓ | 巡检 tick;`now` 可注入 |
| `listWorkflowReworkDeliveries` / `getWorkflowRun` / `getWorkflowReworkDelivery` | ✓ | ✓ | 断言 |
| `DeliveryContractWatch` | ✓(deps 含 `commDb`) | ✓(deps **无** `commDb`,无活性门) | 只在 main 部分使用 |
| `delivery-contract/liveness.ts` | ✓ | ✗ | 只在 main 部分使用 |
| `__tests__/fixtures/legacy-workflow-manifests.ts`、`workflow-agent-project.ts` | ✓ | ✓ | fixture 依赖 |

结论:**测试文件的「阳性对照段」只依赖两棵树共有的 API**,可以原样拷进 `069013b25^` 的临时 worktree 跑。「main 专属段」(活性门零写入 / absent 对照)单独 `describe`,在旧树上用 `describe.skipIf(!hasLivenessModule)` 之类的存在性守卫跳过,而不是让整个文件在旧树上因 import 失败而无法执行。

### 1.2 旧树上会红的确切原因

旧 `reconcileWorkflowReworkStalls`(`069013b25^` dispatcher `:1129-1262`)的判定链:

```
delivery.hold_count === 0
&& run.engine_owned === 1 && run.status === 'active'
&& delivery.state ∈ {pending, turn_granted, awaiting_receipt, wake_delivered, replacement_pending}
&& sourceAt = delivery.updated_at            // wake_delivered 时刻
&& ageMs = now - sourceAt
&& ageMs >= 60min
&& !(state === 'wake_delivered' && last_error === 'actor_alive_after_receipt' && next_retry_at > now)
→ escalateWorkflowReworkStall({ action: 'hold' })
→ workflow_run.status = 'held'; delivery.state = 'held'; 事件 rework_activation_stalled_held
```

测试脚本:T0 `markWorkflowReworkReplacementLaunched`(delivery → `wake_delivered`,`updated_at=T0`,`last_error=NULL`);dispatcher `now = T0 + 61min`,`reconcileWorkflowRework: async () => ({ kind: "busy" })`(让 coordinator 不介入,保持 `last_error=NULL`,这正是 tick 落在两次 3 分钟重探之间的真实形状);`await dispatcher.reconcile()`。

- 旧树:`workflow_run.status === 'held'` → 断言 `'active'` **红**;随后 `commitWorkflowTransitionTx(... outcome: 'implement_done')` 返回 `{ ok:false, reason:'engine_run_not_active' }` → 第二条断言也红。
- main:扫描器不存在,run 保持 `active`,完成返回 `ok:true`,delivery `wake_delivered → completed`(`:46868`)。

补充证据:issue 时间线(19:28:15Z 换体 → 20:28:31Z hold)与生产 69 条 `rework_activation_stalled_held` 事件的 `reason` 字段分布都与这条判定链一致:

| reason | 条数 |
|---|---|
| `delivery_wake_delivered` | 30 |
| `delivery_awaiting_receipt` | 13 |
| `worktree_not_ready:*` | 7 |
| `holder_activation_failed:*` | 6 |
| `actor_alive_after_receipt` | 6 |
| `persisted_target_missing` | 3 |
| 其他(`writer_replacement_converged` / `terminal_status_unconfirmed` / `receipt_not_observed` / `delivery_replacement_pending`) | 各 1 |

前两行加 `actor_alive_after_receipt` 共 49 条(71%)是「体活着、只是龄到了」的形状,正是本单。

### 1.3 main 专属段:活性门

`DeliveryContractWatch.runPass(now)` 对 rework 家族的 attempt 计算 `recipientLiveness`(`watch.ts:161-171`),传入 `observeWorkflowDeliveryContract`;`StateStore.ts:39884`:

```
family === 'rework' && stage === 'received' && overdue && recipientLiveness === 'alive'
→ 只关旧 open episode('advanced'),return   // 零 episode、零告警、零 run 事件
```

测试注入的 `commDb` 只需要三个方法:`listRunnerDeliveryProjectionRows(now)` → `[]`,`listRunnerTurnWakeProjectionRows()` → `[]`,`hasMessagesFromAfter(executionId, sinceIso)` → 布尔;`getRunnerPhaseWakeProjectionRow` 只在 `ref.table === 'runner_phase_wakes'` 时才被调用,rework attempt 不会触发。「活」还可以只靠 `sessions.heartbeat_at`:`upsertSession({ heartbeat_at: now - 1min })`,与生产 HeartbeatService 每周期刷新的形状一致。

对照组(absent):`heartbeat_at = now - 2h`、`last_activity_at = now - 2h`、`hasMessagesFromAfter → false` → `classifyRecipientLiveness` 返回 `absent` → 走通用 stalled 分支:开一条 `received` episode + 一条 warning 告警(90 分钟后 severe);**`workflow_run.status` 仍为 `active`**,完成仍 `ok:true`。这条对照证明「不 hold」不是因为「判活」偶然为真,而是路径里根本没有 hold 写点。

### 1.4 「8-31 新证」形状(目标节点已完成、后继在跑)

节点完成时 `commitWorkflowTransitionTx` 把 rework delivery 从 `wake_delivered` 写成 `completed`(`:46868` / `:46947`),之后 run 保持 `active`、后继节点照常派发。旧扫描器不看这些,所以照 hold;main 上扫描器已不存在,所以「完成之后 hold」在 main 上不可能发生。这一条进回归(完成后 `dispatcher.reconcile()` 零 held、run 仍 active)。

### 1.5 新发现:完成之后 rework 的 delivery attempt 没有被结算(告警噪音,不是 hold)

| 家族 | 完成时对 `workflow_delivery_attempt` 的结算 |
|---|---|
| carrier | `settleWorkflowCarrierDeliveryOnCompletionTx`(`:36311`)在**同一事务**里 `settleWorkflowDeliveryAttemptTx` |
| rework | **没有**。`commitWorkflowTransitionTx` 只改 `workflow_rework_delivery.state`;`DeliveryProjector` 对 rework 只在 `run` 终态时结算(`projector.ts:186-203` 走 `getWorkflowStateDeliverySourceRun` → `workflowRunIsTerminal`) |

后果链(main 上):换体上岗时 `received_at = T0` → 节点完成、delivery `completed`,attempt 仍 unsettled、stage 仍 `received` → `T0 + 30min` 起 `overdue` → 体收工后 tmux 窗口没了,HeartbeatService 不再刷 `heartbeat_at`,10 分钟后 `classifyRecipientLiveness` 判 `absent` → `observeWorkflowDeliveryContract` 走通用 stalled 分支:开 `received` episode、发 warning,`T0 + 90min` 发 severe。**不 hold**,但是给一个已经 done 的节点发「投递 stalled」告警。生产库副本里已有 3 条 `delivery.state='completed'`、attempt 未结算、run `active` 的 rework attempt。

FLY-2278 plan §8 写了「不为 rework 家族补 `consumed_at` 写点(received 告警过活性门即止)」,但活性门对**已收工**的体恒为 absent,这一点 §8 没覆盖。已向 Lead 提问(question `6d580dc4-06f5-4eec-9e6c-9a8bb5f7c2ed`):(A) 本单在同一完成事务里复用 `settleWorkflowDeliveryAttemptIfPresentTx` 镜像 carrier;(B) 另开单。plan 默认按 (B),(A) 列为可选 chunk。

## 2. 退役残留审计

| 符号 | 调用方(main) | 判定 |
|---|---|---|
| `listWorkflowReworkDeliveries({ includeDeferred })` 参数与 SQL 里的 `(? = 1 OR next_retry_at IS NULL OR next_retry_at <= ?)` 第一个占位 | 源码 0 处传 `includeDeferred`(唯一调用方 `workflow-engine-dispatcher.ts:816` 传 `states + now`);测试 0 处 | **死参数,删**。SQL 改成 `(next_retry_at IS NULL OR next_retry_at <= ?)`,参数数组去掉那个 0/1 |
| `enqueueReworkRecoveredIfAlertedTx` 的 `rework_stalled_alert:` 前缀扫描 | `:29986`;由 wake receipt 路径调用 | **保留**。它读的是存量 run 上的历史事件;删了会让这些 run 在收到 receipt 时丢 `rework_stall_recovered` |
| `hold-shape-registry.ts:86` 的 `rework_activation_stalled_held` 形状 | `listWorkflowHolds` / `hold resume` | **保留**。FLY-2278 research §125 明确留给存量事件 |
| `fly2278-retirement.test.ts` 源码守卫 | — | **保留并复用**,不再加第二条同义守卫 |
| coordinator `deferReceiptProbe` 的 `actor_alive_after_receipt` 3 分钟重探 | `workflow-rework-coordinator.ts:496-525` | **不动**(不再驱动任何 hold;是否收敛另开单,已在 ask 中点出) |

## 3. 存量 FLY-2241 的处置建议(只建议,不动数据)

run `25703777-c780-41a2-8d72-aaa839bcb818`(FLY-2241):

| 表 | 现值 |
|---|---|
| `workflow_run.status` | `held` |
| 最新 hold 事件 | seq 49 `rework_activation_stalled_held`,node `general`,exec `82133264…`;更早 seq 44 `land_held` |
| `workflow_rework_delivery` | `held`,`last_error=delivery_awaiting_receipt`,2026-09-01T22:32:50Z |
| `workflow_run_node` | `general` attempt 1、2 均 `done`;`land` attempt 1 `pending`;`founder_gate` 1 review / 2 done |

注册表给这个形状配的 `resume_receipt_deadlock`(`StateStore.ts:38603`)会铸新 route revision 并把 delivery 置回 `pending`,即**重新把 rework 投递给一个已经 done 的 `general` 节点**。这不是这条 run 需要的动作;它需要的是 FLY-2278 之前巡检用过的「delivery 直接结算、run 回 active、让 `land` 继续」。这属于 FLY-2278 plan §8 里明确留给「另开单」的存量事件形状,处置权在 Lead / founder。本单在 plan 里写成一段可核对的 SQL 断言(只读核对 + 建议事务),由 Lead 决定是否执行、何时执行。

## 4. 部署与验收口径

- 生产 Bridge `buildSha=31da17817`(2026-09-03T20:05Z `/health`),是 #1053 的父 commit;`com.flywheel.updater` 只在 00:00 PT 班车窗口部署。本单不部署、不重启。
- 生产闭合的可核对指标:updater 部署 ≥ `069013b25` 后,`workflow_run_event` 里 `rework_activation_stalled_held` 计数停在 69(2026-09-03T20:08Z 副本值)不再增长;巡检 class_key `8c112426…` 7 天零新增。
- 本单 PR 的验收:回归测试在 main 绿、在 `069013b25^` 临时 worktree 红(阳性对照留证:两次 vitest 输出贴进 PR body);`fly2278-retirement.test.ts` 继续绿;`includeDeferred` 全仓 grep 为 0。
