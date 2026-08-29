# FLY-1070 替身 QA 验证 PR #528 — 调研

Issue: FLY-1070 (https://linear.app/geoforge3d/issue/FLY-1070/qa-fly-1050-独立验证-pr-528三段式死-qa-干净重生)
日期: 2026-07-09
基于: exploration.md

以下全部事实基于 PR #528 head `5da5fd18`（`gh pr view 528` 确认 OPEN、headRefOid 一致）与生产库只读快照，供 Implement 段直接引用，不需重查。

## 1. head 代码结构（验证锚点）

全部在 `packages/teamlead/src/`，行号以 `5da5fd18` 为准：

| 符号 | 位置 | 行为要点（QA 断言依据） |
|---|---|---|
| `DEAD_QA_STATUSES` | `bridge/phase-orchestrator.ts:192` | `{completed, failed, terminated}`——重生判据/stranded-pass 专用域；belt 的 `TERMINAL_SESSION_STATUS`（:169 附近）保持 `{completed, failed}` 不含 terminated |
| `QA_RESPAWN_MAX` | `:196` | cap=3 |
| `qaRespawnEnabled()` | `:205` | `FLYWHEEL_THREE_STAGE_QA_RESPAWN !== "0"`；只控重生，不控 stranded-pass 硬化 |
| `reconcileStrandedImplementHandoffs` | `:560` | boot 路径；对每个 implement@awaiting_review：`hasProgressedPastImplement` false → `tryRedriveImplementHandoff` |
| `tryRedriveImplementHandoff` | `:608` | 入口第一道 = `isMergeBlocked(impl)` → skip（F9）；然后 in-flight guard → cap 检查（≥3 → `failClosed`，无 spawn）→ `onPhaseComplete(impl)` 复用全部现有门 → 仅当「有死 qa 前科 && spawn 真落了 alive row」发 thread note |
| `reconcileQaLoss` | `:655` | scoped 入口。守卫链：env 开关 → fresh re-read `getSession(terminalExecId)` → `chat_thread_role ?? "main" !== "qa"` 即 return（**undefined session 也走此路**）→ 状态必须在 `DEAD_QA_STATUSES` → `hasProgressedPastImplement` → 找 implement@awaiting_review（无则 no-op） |
| `hasProgressedPastImplement` | `:701` | ship claim → true；开关 off → row-exists 旧判据；活 qa → true；零 row → false；否则只看 `qaRows[0]` 的 intent==="fail"。查询异常 → fail-closed true（不重驱）。**无任何 issue Done/closed consult** |
| `postRespawnThreadNote` | `:672` 附近 | best-effort，文案「🧪 三段 QA 段已死…」 |
| qa 早退分支 | `:873` | `role==="qa" && DEAD_QA_STATUSES.has(status)` |
| `checkStrandedPass` | `:1410` | 域改 `DEAD_QA_STATUSES`（含 terminated）+ 活后继 QA 抑制 |
| `grantTurn` / epoch | `:369` | **TURN 在 per-project CommDB，epoch 自增**；spawn 的 TURN 由 dispatcher pre-launch seam 授予（:163 注释、belt 恢复时 `epoch + 1` 见 :1728-1736） |
| `isMergeBlocked` | `bridge/merge-ship-gate.ts:70-74` | `!!session?.merge_block_reason`——任意非空串即真（生产真实串见 §4） |
| `getStrandedThreeStageQaPassSessions` | `StateStore.ts`（:2506 附近） | SQL IN 补 `terminated` |
| 触点：emitFailed | `DirectEventSink.ts`（`maybeReconcileQaLoss` 在 `reconcileTurnBeltAfterTerminal` 之前） | qa-loss 先于 belt |
| 触点：session_failed | `bridge/event-route.ts` 成功路径 | 同上；FSM-rejected 分支**故意不接** |
| 触点：terminate | `bridge/actions.ts`（router 可选参数 `phaseOrchestrator` holder）+ `bridge/plugin.ts` **两处挂载都传**（:1021 / :1448） | 守卫 `(success \|\| cleanupPending)`；fire-and-forget qa-loss → belt |
| 触点：crash-reaper | `bridge/crash-reaper.ts` `onQaPhaseTerminated` 可选回调 + `plugin.ts:3438` 闭包 | 收尸后触发 |
| flag 注册 | `packages/config/src/feature-flags/registry.ts` | `FLYWHEEL_THREE_STAGE_QA_RESPAWN`（head commit 本身） |

## 2. 测试盘点（验证面 1 的精确范围）

**orchestrator ×4**（`packages/teamlead/src/bridge/__tests__/`）：
- `phase-orchestrator.test.ts`
- `phase-orchestrator.fly1050-qa-respawn.test.ts`（新，**32 tests**）
- `phase-orchestrator.fly939-wake-not-respawn.test.ts`
- `phase-orchestrator.fly887-keepalive.test.ts`

四文件合计 **135 tests**（implement 交接口径；QA 以实跑输出核数）。

**触点 ×5**（`packages/teamlead/src/__tests__/`）：
- `DirectEventSink.test.ts`（FLY-1050 case 在 :960/:986）
- `event-route-fly921-turn-belt.test.ts`（**绑 127.0.0.1，必须 host 跑**）
- `actions-fly1050-terminate-qa-loss.test.ts`（新；**绑 127.0.0.1**；双挂载 + 非-qa/main-role 哨兵）
- `crash-reaper.test.ts`（FLY-1050 case 在 :308/:327）
- `StateStore.three-stage-qa.test.ts`（新，7 tests）

**fixture 命名映射**（issue 验证面 2 ↔ head 实际测试）：

| issue 提法 | head 实际覆盖 | 缺口 |
|---|---|---|
| F1（967 形态）/ F1-boot | fly1050 test :214-:273 | 无 |
| FLY-1018 现场（=F2）/ F3 cap | :275-:315 | 无 |
| F4/F4b/F4c（FAIL intent 域） | :317-:383 | 无 |
| F5/F6/F7 哨兵 | :384-:526 | 无 |
| 并发/幂等/evidence 门/ghost 门/belt/stranded-pass | :528-:768 | 无 |
| F9 merge-blocked | :558-:597（3 tests） | 无 |
| **F8a-F8d** | **不存在**（全树无 F8 命名测试；部分等价：F7 main-role no-op、各触点 non-qa 哨兵） | **QA 独立行为验证补位**（见 §3） |

## 3. F8 溯源与形态规格（QA harness 的构造依据）

- 溯源：F8 系列只存在于未落 git 的「FLY-1050 design addendum」；分支历史（`git log --all -- 'engineering/doc/FLY-1050*'`）与 `/Users/xiaorongli/Dev/flywheel-FLY-1050` worktree 磁盘均确认无 addendum 文件。权威取证摘要 = FLY-1066 issue 描述。
- 形态规格（QA 按此构造，断言目标一律「不崩、不误 respawn、不算 progressed」）：

| # | 形态 | 构造 | 断言 |
|---|---|---|---|
| F8a | CommDB-only 孤儿（样本① d2f31930）：CommDB sessions 有 row（running、issue_id=NULL），StateStore **无 row** | 对不存在的 execId 调 `reconcileQaLoss({issueId, terminalExecId})`（**CommDB-only**——issue_id=NULL 形态只能在 CommDB 侧构造） | `getSession` → undefined → `chat_thread_role ?? "main"` 路径 no-op；不 throw、零 spawn |
| F8b | 死 qa 形态但 `chat_thread_role='main'`（跨 scope 僵尸的 StateStore 侧影） | main-role terminated row（**real-store**） | 全程 no-op（= head F7，复跑 + harness 重证） |
| F8c | issue_id 形态矩阵。**注意（Codex R1 #1）**：StateStore `sessions.issue_id` 在 head 是 `TEXT NOT NULL`（CommDB 侧才可 NULL）——NULL 形态归 F8a，StateStore 侧矩阵只含可构造形态 | **real-store** 半：issue_id=空串 / 跨 project 死 qa row，逐形态调 scoped 入口 + boot；**fault-injected** 半：deps 包一层 throwing seam（listPhaseSessionRows 抛错）注入查询异常 | 不崩、零误 spawn；注入故障时 `hasProgressedPastImplement` fail-closed true（不重驱）+ 告警日志 |
| F8d | scope-free 判定：reconcile 路径零 leadId scope 检查 | 代码审计（对照 close_runner 的 checkLeadScope）+ harness 里跨 project fixture 能被 reconcile 看见（但因判据 no-op） | Bridge 侧 reconcile 不因 scope 漏看形态；也不因 scope 越权收割（收割本就不做，归 FLY-1066） |

## 4. F10 生产取证（已完成第一层，Implement 段直接引用）

只读快照：`cp ~/.flywheel/teamlead.db <scratchpad>` 后 sqlite3 查询（绝不动原库）。结果：

```
-- sessions where issue_id IN ('FLY-1023','FLY-1047') ORDER BY started_at
321fb0cd|FLY-1023|completed |design   |07-09 07:03
9b4838c3|FLY-1023|completed |implement|07-09 08:02
f561baa4|FLY-1023|completed |qa       |07-09 15:32|merge_without_approval:gate_not_answered
3f8be4bb|FLY-1023|terminated|implement|07-09 21:27|merge_without_approval:review_question_unbound/qa_snapshot_missing_exempt
ad172522|FLY-1047|completed |design   |07-09 07:15
a0d9163f|FLY-1047|completed |implement|07-09 07:54|merge_without_approval:response_not_stru…
c05e6ab8|FLY-1047|terminated|qa       |07-09 20:37
b7d7adf1|FLY-1047|terminated|implement|07-09 21:37
```

判读：
1. 两例「closed-Done issue 被 respawn」= OOM 恢复后 21:27/21:37 被新拉起的 **implement** session（后被 terminate）。拉起机制是 pre-#528 的既有机制（#528 未部署），不是本 PR 引入。
2. 两 issue 当前**都没有** implement@awaiting_review row → #528 的 QA-respawn 判据对这两个样本的**现状**不会触发（`reconcileQaLoss` 找不到 stranded implement → no-op）。QA 须实证这一点（防御正确性）。
3. 真正的 F10 缺口类：「Done issue + implement@awaiting_review + 死 qa row + 无 ship claim + 无 merge_block」——替身 QA 模式 ship 后父单 implement 正是此形态（FLY-1050 的 eb8f00a6 将成活标本）。判据无 Done consult（§1）→ #528 部署后 boot 会对它重生 QA。QA 用 fixture 行为实证。
4. F9 真匹配验证素材：生产真实 marker 串 `merge_without_approval:review_question_unbound/qa_snapshot_missing_exempt`——`isMergeBlocked` 是非空真值检查，QA 用该串构造 fixture 验证 F9 守卫对生产形态真截断。

## 5. 隔离 E2E harness 接线参考（验证面 4）

原则：**能真则真，fake 面最小化**。真：dist 编译产物（非 src 直跑）、StateStore（tmp 目录 sqlite 文件）、CommDB（tmp，belt/epoch 的单一真相）、express 双挂载 router、PhaseOrchestrator/DirectEventSink/event-route/crash-reaper 按 `plugin.ts` 形态接线。fake（只 3 面）：
- `startDispatcher.start`：记录请求（断言 `sessionRole:"qa"`、`startPoint`、`shareParentBranch:true`、`ignoreRunnerLabelSelection:true`）+ 模拟 pre-launch seam（落 alive qa row + grantTurn epoch 自增），模式抄 fly1050 test harness :92-:95；
- tmux liveness probe：可注入 alive/indeterminate/absent（cleanupPending 与 ghost 剧本需要）；
- Discord/alert 出口（`postIssueThread` / `alertLeadPipelineError`）：记录调用。

接线锚点：`plugin.ts:1021`/`:1448`（createActionRouter 双挂载都传 orchestrator holder）、`:3438`（crash-reaper 闭包）、`DirectEventSink` 构造处。既有可抄模式：`actions-fly1050-terminate-qa-loss.test.ts`（真 express + supertest 形态）、`phase-orchestrator.fly1050-qa-respawn.test.ts` 的 makeHarness。

epoch 断言落点：CommDB turn 表——kill 前记录 holder/epoch，respawn 后断言 holder=新 QA exec 且 epoch 严格 +1、零 STALE-TURN 告警。

## 6. 环境与工具事实

- **host 直跑**（不进沙箱）：`event-route-fly921-turn-belt` 与 `actions-fly1050-terminate-qa-loss` 绑 127.0.0.1，Codex sandbox 已证跑不了、host 可过（implement 交接注明）。
- worktree：`git worktree add worktrees/qa-fly-1070 5da5fd18 --detach`（QA 自己的 checkout，不碰 `/Users/xiaorongli/Dev/flywheel-FLY-1050`——那是 parked implement 的工作区，且其本地有未 push 的 progress commit 74c3d0ee/16fecd4c，QA 一律以 origin 的 `5da5fd18` 为准）。
- 构建：`pnpm install` + teamlead 包 build（dist 供 harness import）。
- 测试：`pnpm vitest run <file>`（teamlead 包内定向）；负载纪律：串行跑、避免与生产 Bridge/Lead 抢资源（OOM 恢复期）。
- 生产库快照：`cp ~/.flywheel/teamlead.db` 到 scratchpad 再查（sql.js 库文件，sqlite3 CLI 可读）；comm.db 同法。绝不对原库开写连接。
- verdict CLI：`flywheel-comm qa-result --status pass|fail --target-exec <id>`（gate founder ship 通知的 QA 通道，FLY-1047 先例同款用法）。
- 全仓甄别结论（**复用不重跑**）：PR #528 comment（2026-07-09 21:24）——3 个 isolation 失败在 base 同样失败=pre-existing；load-flake 与 env-dependent suites 清单在案；FLY-1050 触面 suites isolation 全绿。
