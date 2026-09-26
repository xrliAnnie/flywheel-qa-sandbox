# FLY-2921 返工投递收成两态 — 实施说明
Issue: FLY-2921 (https://linear.app/geoforge3d/issue/FLY-2921/病根修复-6-返工投递收成两态送达-失败交还-lead投给死体改投替身不再把整条-run-打-held6-张-46)
日期: 2026-09-26
基于: plan.md（Codex R4 APPROVED，blob 63bf95a）

本文件只记录实施与 plan 的对应关系、偏差和已知边界；设计本身以 plan.md 为准。

## 1. 与 FLY-2919 的合入顺序（Lead 已确认，问题 232cab63）

实施开工时 FLY-2919 仍未合入 main。按 plan C2 第 4 步 / §6.2 的兜底执行：

- **按活性换体的路径关闭。** `replaceWorkflowReworkActor` 只接受两种可在事务内复核的死亡证明：
  `unlaunched_rollback`（该执行体有 `unlaunched_admission_rolled_back` 或
  `rework_replacement_launch_rolled_back` 事实）和 `launch_abandoned`（该执行体的 dispatch
  ledger 为 `abandoned`）。会话终态、窗格消失 / dead_pin、驻留 hold 到期、内容缺失，都只是
  「需要核验」的理由：在现有授权范围内请求收体（`closeActorForReworkSupersession`，只在投递
  `pending` 或未推送的 `turn_granted` 时），然后按活性未知处理。
- **活性未知**：未推送的投递计一次失败（满 5 次交还 Lead）；已推送的 `turn_granted` 只复探加告警，
  未知满 2 小时交还 Lead（`liveness_unknown_timeout:*`，这是「未知超时后照常交还 Lead」的落点）；
  `wake_delivered` 只复探加 30 分钟 / 2 小时两档告警。
- **不接 2919 的受控收尾入口**：running / `wake_delivered` 的目标不发收体请求。

**2919 后合入时怎么打开被关闭的路径**：在 `replaceWorkflowReworkActor` 的 `proof` 联合类型里加入
2919 的「受信进程证据（执行体 + 代次）」一种，事务内按执行体与物理代次复核；协调器
`unverifiedDeath` 在请求收体后先取 2919 证据，证死就走 `replaceActor`；running /
`wake_delivered` 目标的收体改走 2919 的 `close_requested` 入口。2919 改死体扫描时必须保留本单
C6.1/C6.2 的「未关账返工目标 → 交给协调器」守卫（`handOffDeadReworkTargetToCoordinator`）。

## 2. 对照 plan 的落点

| plan | 代码 |
|---|---|
| C1 五态、两列事实、迁移、旧迁移按列跳过、维护断言 | `StateStore.migrateWorkflowReworkDeliveryTwoState`、`migrateWorkflowReworkDeliveryBudget`、`assertMaintenanceSchema` |
| C1 推送写事实不写状态 | `markWorkflowReworkWakeSent`（与投递时钟 `sent_at` 同事务） |
| C1 签收从 `turn_granted` 接收、交卷顺带签收自愈 | `projectWorkflowReworkWakeReceiptTx`、`settleWorkflowReworkOnCompletionTx`、`closeReworkReturnedToLeadHoldTx` |
| C2 单事务换体 + 预算 3 + 每版本回执 | `materializeReworkReplacementCoreTx`、`replaceWorkflowReworkActor`、`countReworkReplacementsSinceLeadResumeTx` |
| C2 启动中动作表 a–f、defer、活性未知两档告警 | 协调器 `reconcileLaunchingReplacement`、`deferWorkflowReworkDelivery`、`noteWorkflowReworkLiveness` |
| C2 Lead 重投复位同一个 wake（busy 可重试） | 协调器 `rearmReworkWake` 效果 + flywheel-comm `resumeTurnWakeHold` / delivery-operations |
| C3 失败唯一终点 + delivery 作用域门 + 前置条件 + 重投 | `settleWorkflowReworkFailure(Tx)`、`hold-shape-registry` 新形状、`workflowHoldAuthoritativePrecondition`、`applyStateWorkflowHoldResumeActionTx` |
| C3.6 founder `/rework` 兼容 | `openOperatorRework` |
| C4.1–C4.5 | `rollbackUnlaunchedWorkflowAdmission`、`escalateUnlaunchedWorkflowStall`、`watch.ts`、`holdUndeliverableTx`、`markReworkReplacementContentMissingTx` |
| C4.6 暂存取消永不落地 | `delivery-operations.ts`、flywheel-comm `cancelTurnWakeDelivery` |
| C5 驻留 hold 第二次返工 | `resident-wake-fence.ts`、`enterResidentHoldForCompletionTx` |
| C6 替身只有一条铸造路 | `handOffDeadReworkTargetToCoordinator`、`rollbackDeadWorkflowNodeExecution` 守卫、`allocateWorkflowResumeFallback`、调度器启动围栏 |
| C7 交卷必须有新提交 | `rework-completion-evidence.ts`、`event-route.ts`、`commitWorkflowTransitionTx`、flywheel-comm `complete` |
| C8 消费者 | 调度器、巡检账本、hook 白名单、签收分类器、告警 disposition、runbook、529 脚本 |

## 3. 与 plan 的偏差（均为实现细节，逐条说明）

1. **`deferWorkflowReworkDelivery` 也接受「未推送的 `turn_granted`」**。plan 写「只作用于 pending」。
   Lead 重投后 wake 复位返回 `busy` 时，崩溃恢复路径上投递可能已是未推送的 `turn_granted`，
   也需要不计失败地延后；已推送的行仍走复探调度。
2. **回滚脚本对 `migrated:held:` 前缀的行恢复成 `held`**（plan 只列了 `returned_to_lead → needs_lead`）。
   这样 held run 上旧的窗格交接门在旧代码里仍能工作，恢复更精确；其余行按 plan 映射。
3. **C6.1 的「提醒协调器」每个（请求, 路由版本, 执行体）只发一次**（事件
   `rework_dead_target_handoff:*`）。每个调度 tick 都把 `next_retry_at` 置为 now 会抹掉退避，
   让未推送投递在几秒内连计 5 次失败。
4. **`returned_activation_already_consumed` 没有保留旧名别名**：2026-09-26T18:57:15Z 扫描本仓
   `packages/`、`scripts/`、`lead-rules-base/` 与本机 `~/.claude/plugins/cache/*/`，除 StateStore 里说明改名的
   注释外零匹配；插件 fork 源 `xrliAnnie/claude-plugins-official` 未检查。它是 HTTP 拒绝原因字符串，
   不是 CLI 子命令，别名无已知对象。事件 kind
   `rework_needs_lead_cleaned` 保留原名，保证事件历史连续。
5. **founder `/rework` 替换已交还的返工时顺带关闭那扇 Lead 门**，避免 active run 上留下一个
   只会报 `rework_target_superseded` 的幽灵门。
6. **推进事件 UID 带上路由版本**（`rework_delivery_<to>:<req>:<rev>`）。一个请求在换体 / 重投后
   会在新版本上再次 `pending→turn_granted`，按请求一个 UID 会撞 `workflow_event_uid_conflict`。

## 4. 删除清单（死代码）

- 状态：`awaiting_receipt`、`replacement_pending`、`needs_lead`、`held`（仅返工投递表）。
- `StateStore.materializeWorkflowReworkReplacement`（并入共用核心）、`settleHeldReworkRecoveryFailure`、
  `validateNeedsLeadReworkQuiescenceTx`、`openReworkContentUndeliverableTx`（改为
  `markReworkReplacementContentMissingTx`）。
- `settleWorkflowReworkFailure` 的 `onExhausted` / `terminal` 参数、冻 run、撤节点预留、验证路径置
  `needs_lead` 分支；`advanceWorkflowReworkDelivery` 的 `→awaiting_receipt|replacement_pending|held`
  与 `alertIdentity` / `nextRetryAt` 参数。
- 调度器 held 窗格恢复块、`heldReworkRecoveryProbeAt`、`replacement_pending` 物化分支、
  `settleHeldReworkRecoveryFailure` 包装。
- 协调器 `markReplacementPending`、`handoff_held_pane_loss`、`awaiting_receipt` 推进。
- `resident-wake-fence` 的 `resident_hold_already_woken`。
- `watch.ts` 返工「投不到」半边。
- `scripts/fly-1648-hot-loop-closeout.mjs` 及其两个测试（Lead 确认删除，问题 67a24662；git 历史留档）。

三种旧返工 hold 形状（`rework_activation_stalled_held` / `rework_pane_loss_handoff` /
`rework_retry_exhausted`）保留解码，前置条件读 `returned_to_lead`；本单之后不再产生。

## 5. 已知边界

- **2919 合入前**：会话终态但进程已死的返工目标不会自动换体，会在约 15 分钟（未推送）或 2 小时
  （已推送未签收）后交还 Lead；`wake_delivered` 后目标死亡只告警。这是 plan 为防「账面终态当死亡、
  在活体旁造替身」而选的 fail-closed。
- phase_wake 家族「投不到」冻 run 不在本单范围（plan §7）。
- 现存 held run 上的 8 行返工投递只映射字面值，不自动解冻；由原门、FLY-2922 统一入口或 terminate 处理。
