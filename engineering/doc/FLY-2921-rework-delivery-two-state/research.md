# FLY-2921 返工投递收成两态 — 调研
Issue: FLY-2921 (https://linear.app/geoforge3d/issue/FLY-2921/病根修复-6-返工投递收成两态送达-失败交还-lead投给死体改投替身不再把整条-run-打-held6-张-46)
日期: 2026-09-26
基于: exploration.md

审计基线 `d52df7841`。本文件回答方向 B 落地前必须弄清的问题：每个状态被谁写、被谁读，删掉后谁会坏，现有能复用的门在哪里。

## 1. 写端：每一处改 `workflow_rework_delivery.state` 的代码

**INSERT（全部写 `pending`，随后 `mintWorkflowReworkDeliveryAttemptTx`）：** `openEngineLandConflictResolution`（52757）、`openEngineLandConflictRework`（53108）、`openOperatorRework`（54166）、`commitWorkflowTransitionTx`（68767，QA FAIL / 链式返工）、`openPendingCarryoverFounderFeedbackTx`（70206）。本单不动。

**UPDATE state：**

| 位置 | 函数 | 迁移 | 本单处置 |
|---|---|---|---|
| 41275 | `rollbackUnlaunchedWorkflowAdmission`（replacement 绑定） | replacement_pending→held + run held | 改：投递留 pending、run 不动、提醒协调器 |
| 43960 | `projectWorkflowReworkWakeReceiptTx` | awaiting_receipt→wake_delivered | 改：从 turn_granted 接收签收 |
| 44512 | `convergeWorkflowReworkWriterReplacement` | 任意在途→replacement_pending | 改：收敛成 pending + 新路由版本（仅兼容旧车道铸出的体） |
| 44712 | `materializeWorkflowReworkReplacement`（held 窗格恢复） | held→replacement_pending + run active | 并入新的「改投替身」单事务；held 分支删除 |
| 45911 | `settleWorkflowReworkFailure` | pending/turn_granted→同态退避 / needs_lead / held | 改：耗尽→returned_to_lead，不冻 run、不撤节点、不铸 run 级 hold |
| 45757 | `settleHeldReworkRecoveryFailure` | held→needs_lead | 删（无 held 可恢复） |
| 46226 | `advanceWorkflowReworkDelivery` | 通用 CAS | 改允许表 |
| 45277 | `markWorkflowReplacementStartedTx` | replacement_pending→wake_delivered | 改：从 pending（替身启动中）→wake_delivered |
| 48871 | `allocateWorkflowResumeFallback` | 在途→replacement_pending | 改：→pending + 新路由版本（与替身同形） |
| 55831 / 56472 | 投递合同改投 | →pending | 只改状态白名单 |
| 58688 | `applyStateWorkflowHoldResumeActionTx` | held/needs_lead→pending | 改：returned_to_lead→pending（Lead 重投门） |
| 59138 | `cancelWorkflowStateDeliveryTx` | 非完成→completed | 只改状态白名单 |
| 68142/69009/69100 | `commitWorkflowTransitionTx` | wake_delivered→completed | 不变 |

## 2. 读端：删状态后会坏的消费者

| 消费者 | 现在依赖 | 本单改法 |
|---|---|---|
| `workflow-engine-dispatcher.ts:1251-1260` 扫描 | pending/turn_granted/awaiting_receipt/wake_delivered/held | pending/turn_granted/wake_delivered |
| 同文件 1276-1368、1475-1497 held 窗格恢复 | held + `persisted_target_missing` | 删除整块（返工投递不再有 held） |
| 同文件 1405-1421 | 协调器返回 `replacement_pending` 后由调度器物化替身 | 删除；协调器在认领内一步铸完 |
| 同文件 2805-2821 启动围栏 | `deliveryState === "replacement_pending"` | 改为「替身启动中」谓词（§4.3） |
| 同文件 2822-2853 替身上下文 | 同上 | 同上 |
| `delivery-contract/watch.ts:219-225` | 返工 awaiting_receipt/replacement_pending + 收件体不活 ⇒ 投不到（冻 run） | 删返工半边；死体归协调器改投 |
| `patrol-loop-ledger.ts:266-286、402-408、550-563` | 进度源判定与圈显示 | pending 恒为进度；turn_granted/wake_delivered 按活性；returned_to_lead 非进度、显示 `rework:returned_to_lead` |
| `hook-payload.ts:603-624` 白名单 | 含 replacement_pending/needs_lead（载体也用 needs_lead） | 加 returned_to_lead；删仅返工用的 replacement_pending；needs_lead 留给载体 |
| `turn-wake-receipt-classifier.ts:20-42` | 「Lead 停驻」集合 {held, needs_lead, replacement_pending}（该调用只传返工） | {returned_to_lead}；并把「签收的路由版本 < 投递当前版本」判为 not_applicable（替身后旧 wake 的签收） |
| `hold-shape-registry.ts:86-100` + manifest + inventory | 三种返工 hold（按事件名识别） | 保留作历史解码；新增 delivery 作用域 `rework_returned_to_lead` |
| `workflowHoldAuthoritativePrecondition`（57885） | 三种返工 hold 写死 expected=held | 改为 returned_to_lead（修 FLY-2473） |
| `openOperatorRework`（53731-53945） | 找 needs_lead 行、要求 run held、全体证死 | 找 returned_to_lead 行、run held/active 均可、用 active 同款静默校验 + 凭据撤销 |
| `LeadAlertNotifier.ts:465` | 处置枚举 | 加 `rework_returned_to_lead`，旧值留作历史 |
| `flywheel-comm/src/commands/complete.ts:637-640` | 原样打印 deliveryState | 加 `rework_head_unchanged` 的人话提示 |
| `scripts/qa-529-generalized-e2e.mjs:318-330、1076-1106` | 危险行 `held/needs_lead`；要求 `rework_delivery_wake_delivered` 事件 | 危险行改 `returned_to_lead` + run 被返工冻结；事件名不变（保留 wake_delivered 字面值） |
| `lead-rules-base/runbooks/patrol-v1.md` 附录 A/B（及镜像） | 手工 SQL 修 receipt 死结 / 替身漏账 | 两个附录改为「FLY-2921 后不再出现，遗留行按迁移处理」；同步 `fly369-patrol-rule.test.ts:596-617` |
| `scripts/fly-1648-hot-loop-closeout.mjs` + 测试 | 调 `settleHeldReworkRecoveryFailure` | 一次性脚本（8 月已执行），随该函数一并删除；列入死代码清单请审阅确认 |
| `scripts/fly-2828-*.sql` | 旧状态过滤 | 一次性脚本，已执行，不改；plan 注明失效 |

不受影响（名字相同、属于别的表）：`workflow-ship-carrier-coordinator.ts` 全部、`run-dispatcher.ts:522`（doa_backoff）、`workflow_rework_verification_path.state='needs_lead'`（验证路径自己的作废标记，本单不改该表词汇）。

## 3. 能直接复用的现成件

1. **Lead 自己能按的门已经存在**：`/api/runs/:runId/rework` 是 founder 授权门（`founder-consent/reserved-endpoints.ts:128`），Lead 单独用不了；但 hold 恢复入口（`runs-route.ts` hold list/stage/apply，master + loopback + 一次性确认令牌，CLI `flywheel-comm hold resume`）支持 **delivery 作用域**的 hold：`listWorkflowHolds`（58099）只对 `scope==="run"` 加 `run_held` 前置，`resumeWorkflowHold` 只在 `hold.runLevel` 时改 run 状态（59253-59258）。所以「交还 Lead」可以挂一个**不冻 run 的 delivery 作用域 hold**，Lead 用现有 CLI 恢复，不必新造 API。
2. **重投逻辑已经存在**：`applyStateWorkflowHoldResumeActionTx` 的 `resume_rework`（58633-58700）追加同目标同体的路由版本、投递回 pending、清计数、重铸投递 attempt、验证路径回 pending。只需把接受的源状态换成 returned_to_lead，并加一条「目标节点仍被本请求预留」校验。
3. **持久 turn wake 幂等**：`deliverDurableTurnWake`（flywheel-comm/src/wake.ts:190）先按 wakeId 入队再认领；同一 wakeId 已推成功或已签收直接返回成功。所以 turn_granted 行在崩溃后重跑整段授权+唤醒是安全的，不会重复推送。
4. **替身事务**：`materializeWorkflowReworkReplacement`（44580）已经在一个事务里做完「终结死会话、结清停驻、撤凭据、分配启动序号（dispatch ledger，reason=`rework_replacement:<req>`）、节点换新执行体、追加路由版本、重铸投递 attempt、死体观察」。缺陷只有三个：要求前态 `replacement_pending`、回执 UID 每请求一个、由调度器而不是协调器调用。
5. **路由版本自带来源**：`workflow_rework_route_revision.interpreted_by / interpretation_reason` 能区分「替身铸出的版本」（`engine` / `proven_dead_replacement`）与 Lead 重投（`engine:hold_resume`），不需要新列就能判断「这一版是替身、还没启动」。
6. **交卷新提交校验的落点**：`commitWorkflowTransitionTx` 在 67928-67979 已解析出 `activeRequest`（含 `base_revision`）、`activeRoute`、`activePathCurrentIndex`、`source` 节点能力；`input.subjectDigest` 由 `event-route.ts:1742` 从服务端工作树权威取得（调用方自报不一致会被拒）。在 67979 之后插入比对，失败返回 `ok:false` 会被 `commitEnrolledCompletion` 转成 `transition_refused`，并由 69238-69246 回滚已做的 implied 签收。注意 65626-65633 在 `subjectDigest` 缺失时会回落到可能陈旧的 `session.pr_head_sha`：新校验只信显式传入的服务端 head。

## 4. 驻留 hold 为什么第二次返工必坏（FLY-2821 精确链）

1. 实现体首次交卷（activation A0）：`enterResidentHoldForCompletionTx` 插入 `resident, activation_id=A0`。
2. QA FAIL → 返工 R1：协调器用 `activation:R1` 唤醒；`deliverResidentWake` 推送成功后把 hold 置 `woken`。
3. 实现体以 `activation:R1` 交卷：`existing.activation_id (A0) !== binding.activation_id (R1)` ⇒ return false，hold **停在 woken**。全文件没有任何 UPDATE 会改 `workflow_resident_hold.activation_id`。
4. QA 再 FAIL → R2：`deliverResidentWake` 见 woken ⇒ `resident_hold_already_woken`；协调器重试 5 次必然仍 woken ⇒ needs_lead + run held。
5. 副作用：hold 永远不回 resident，驻留宽限到期回收（49836 只扫 resident）也永远不触发。

同一 fence 也包着 ship 载体的唤醒（plugin.ts:15206-15270），修正对它同样生效。

## 5. 「投不到」冻 run 的两条来源（FLY-2330）

1. 返工 wake 实际走 `turn_wake_outbox`，收件体死后投递合同为 `turn_wake` 家族铸「投不到」episode，`finalizeUndeliverableHoldTx` 因 `family !== "mailbox"` 冻 run。
2. 替身交卷缺内容回执：`commitEnrolledCompletion` → `rework_content_not_delivered` → `openReworkContentUndeliverableTx`（64978）铸 rework 家族投不到 + 冻 run。

取消正门停 staged：`delivery-operations.ts:572-592` 只有 mailbox / turn_wake 有取消实现，其余家族和所有非 ok 结果都 `continue`，从不 `markWorkflowHoldResumeFailed`；`cancelTurnWakeDelivery`（flywheel-comm db.ts:9223）在源已被 `terminal_guard` 取消时返回 `turn_wake_source_changed` ⇒ 永远 staged。

## 6. 迁移机制

- SQLite 的 CHECK 只能重建表。已有先例 `migrateWorkflowReworkDeliveryBudget`（7403-7461）：关外键、建 `_next`、拷贝、删旧、改名。
- **坑**：该旧迁移的跳过条件是「表 SQL 含 needs_lead 和 awaiting_receipt」。新表不再含这两个字面值 ⇒ 旧迁移会误判需要重建、把新表重建回 8 态 CHECK。新迁移必须同时把旧迁移的跳过条件改成「按列判断」（hold_count / next_retry_at / grant_started_at 存在即跳过），并保证新迁移在旧迁移之后执行。`assertMaintenanceSchema`（7041-7046）同理：从检查 `'needs_lead'` 改为检查 `'returned_to_lead'`。
- 生产 teamlead.db 约 4.3 GB，但投递表只有约 1,100 行，重建成本可忽略；Bridge 用 sql.js 整库在内存，迁移在启动时一次完成。
- 基础 `CREATE TABLE IF NOT EXISTS`（35141）同步改成新 CHECK，保证新库直接是新形态。

## 7. 测试面（只列文件，实施时逐个改）

返工投递相关断言最多的：`StateStore.workflow-rework.test.ts`（约 130 处）、`workflow-rework-coordinator.test.ts`（约 54）、`fly2504-rework-replacement-receipt.test.ts`（约 37）、`workflow-engine-dispatcher.test.ts`（约 33）、`workflow-rework.e2e.test.ts`（约 20）、`fly2096-rework-stall-hold.test.ts`（13）。其余 20 个文件各 1-5 处（清单见 plan §8）。`scripts/__tests__/qa-generalized-e2e-lib.test.mjs` 约 10 处。

## 8. 结论

方向 B 可行，且大部分零件现成：替身事务、重投逻辑、delivery 作用域 hold、幂等 wake 都在。真正新增的只有：一个终态 `returned_to_lead`、一个 `wake_sent_at` 事实列、「替身启动中」谓词、交卷新提交校验、表重建迁移。其余是删除与改白名单。
