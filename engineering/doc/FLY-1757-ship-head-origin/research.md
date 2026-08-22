# FLY-1757 铸卡前确认 head 已在 origin — 调研
Issue: FLY-1757 (https://linear.app/geoforge3d/issue/FLY-1757/ship卡残刀-铸卡前head-已在-origin断言a4重复卡病已修好留证关闭原1818范围承接于此)
日期: 2026-08-21
基于: exploration.md

## 1. 当前权威链

1. `workflow-decision-routes.ts` 在进入 terminal gate 时读取 immutable worktree binding、server HEAD，并用 `probeWorkflowPr()` 验 `headRefOid === serverHead`。
2. `StateStore.createWorkflowGateHolderTx()` 冻结 `(run_id, gate_node_id, attempt, head_sha)`，同时把 exact-head `workflow_node_pr_binding` 投影成 `workflow_ship_target_binding`，其中已有 trusted `probe_repo_slug`、`frozen_head_sha` 与 run/question identity。
3. `plugin.ts` 每 3 秒的 workflow gate tick 调 `materializeWorkflowGateHolder()`；工作集来自 `listWorkflowGateHoldersForMaterialization()`。
4. materializer 先写 CommDB question / session binding，再通过 `claimWorkflowGateCardPostIntent()` 持久化 POST intent，最后调用 `postCard()`。

gate-entry probe 证明的是较早时刻的 GitHub PR 状态；materializer 是异步 tick，实际 POST 前仍缺 fresh exact-PR 证明。

## 2. 被推翻的 network Git 方案

R1 HIGH 推翻初稿的 `git -C <worktree> ls-remote --heads origin`：`target_repo_path` 是 runner 可写 worktree，其共享 Git config 同 UNIX user 可写。网络 Git 会消费 `core.sshCommand`、`url.*.insteadOf`、`credential.helper`、`ext::` 等 config；这既是 Bridge 代码执行面，也允许将 origin 指到自建 repo 伪造通过。

因此不从 worktree config 读取 remote，不新增 Git 原语。现有 `probeWorkflowPr()` 可抽到独立模块供 gate-entry 与 materializer 共用：

- repo = durable ship binding 的 `probe_repo_slug`；
- PR = `getCurrentWorkflowNodePrBindingForHead(runId, holder.head_sha).pr_number`；
- fresh 结果必须 `state=OPEN`、非 draft、非 cross-repository，且 `headRefOid === holder.head_sha`；
- 现有实现通过 `gh pr view -R <trusted slug> --json ...`，15 秒 timeout，已在相同 Bridge 环境使用。

它比“任意 origin branch tip 等于 H”更强：PR force-push 到 H′ 后，即使其它 branch 仍指 H，也不会为旧 H 铸卡。

## 3. 3 秒热循环与已有治理先例

R3 复核发现，单纯把 PR probe 放进 materializer 会产生新事故：plugin 的 gate tick 每 3 秒跑一次，现有 in-flight guard 只防并发，不限制下一 tick；工作集 SQL 没有 probe not-before。若 A4 真命中或 GitHub 暂时不可读，每个 holder 将达到约 1200 次 GraphQL/小时，耗尽与 ship 共用的 GitHub quota。

仓库已有两个应复用的形态：

- `workflow-ship-ready-arm.ts`：每项目 6 次/分钟 in-memory fair budget，unknown probe 使用递增 backoff；
- gate card reconciliation：`card_post_reconcile_not_before` 持久化窗口，轮询只在到期后继续远端 scan。

A4 需要两层同时存在：

1. holder 专用 `origin_probe_next_at`/attempts 持久化；工作集 SQL 在到期前只排除 fresh/no_effect，显式放行 pending/ambiguous/legacy-unknown，Bridge 重启也不能绕过；
2. preflight closure 生命周期与 plugin 相同，维护每项目最近一分钟 raw probe 时间戳；第 7 次不调用 `gh`，而把该 holder defer 到预算窗口释放。

远端 transient 按与现有 GitHub probe 相同的 30s/1m/2m/4m/5m 数值封顶退避（A4 本地常量，不 import unrelated classifier 的私有常量）。`CLOSED`、cross-repository 与 durable binding invariant 破坏不可能靠轮询安全自愈：原子把仍 active 的 current run 置 `held`，写唯一事件与 severe alert，materialization 工作集自然停止。

`MERGED` 例外：`external-merge-reconcile.ts` 已拥有这个事实的权威。它在默认 120 分钟 stale TTL 后，对 awaiting-review session 执行 `computeShipDecision → verifyApproval`；够资格才 finalization，不够则写 merge-block + alert。A4 在约 3 秒时不能先 hold run，否则会抢权并阻断本可自动完成的 `runPostShipFinalization`。因此 `MERGED` 只做零卡 + durable defer，run 保持 active；operator 关闭 reconciler kill-switch 也不授权 A4 建第二套 finalization/hold 语义，10 分钟 materialization fail-loud 仍保留可见性。

## 4. crash 语义与 scope

preflight 只在 holder 准备创建新 intent 时执行：

- `card_post_legacy_unknown = 0` 且 `card_post_outcome IS NULL`；或
- 前一 intent 已由 quiet scan 证明 `no_effect`。

`pending` / `ambiguous` 与 legacy-unknown intent 继续 scan/reconcile，不 probe GitHub，因为 Discord POST 可能已经发生。工作集 SQL 即使存在未到期 origin not-before，也显式放行这三类；不能把已发未绑的卡挡在 reconciliation 外。首次 preflight 位于 CommDB question 之前：拒绝时零 question、零 intent、零卡。probe 成功写 verified-at 并清退避；crash 后至多重做只读 probe，不会盲重发 Discord。

not-before 的权威检查不只在工作集 SQL：plugin 同一 tick 的 resume-redrive 会绕过 `listWorkflowGateHoldersForMaterialization()` 直接调用 materializer。preflight closure 入口必须重新读取 current holder/run；run 非 active 或 not-before 未到立即短路，零 raw probe。SQL 过滤只是减负优化，不是安全边界。

本单不改 `awaiting_review_entered_at`：它是 FLY-191 的 48h fail-close 锚点，源码和测试明确要求不随 activity 漂移。也不改已退役、无生产消费者的 `checkpoint-park`。transient 卡住超过 10 分钟继续走现有 materialization fail-loud，只把实际 failure reason 放入告警 body；terminal 则立即 durable hold/alert。

## 5. legacy 与下游闭合

- `authority_mode in {land, runner_ship}`：ship-target binding 必须存在且 current，run/head/repo 完全相等，否则 terminal hold。
- `engine_terminal`：skip。
- `authority_mode IS NULL`：有 ship-target binding 时按 legacy git ship gate 断言；无 binding 时为历史/test helper 兼容而 skip。

最后一类不是可 ship 的绕过：`workflow-decision-routes.ts` `/head-authority` 对 `authority_mode ?? "legacy_runner_ship"` 要求 ship-target binding，缺失返回 409 `ship_target_binding_unavailable`。因此兼容 skip 不会放宽最终 head authority。

## 6. 验收证据矩阵

| 场景 | 预期证据 |
|---|---|
| PR head 已从 H 漂到 H′ | preflight transient；CommDB 无 question；intent seq 0；Discord 0；持久化退避 |
| PR 仍为 H | preflight 通过；只创建一次 intent、只 POST 一张卡 |
| 同 holder completed 重放 | probe 与 POST 均不重复 |
| ambiguous POST | reconciliation 继续，PR probe 不重复 |
| head 变更后的新 gate | #846 card A → card B 测试保持绿 |
| GitHub probe timeout | fail closed，raw probe ≤6/project/min，Bridge 重启不清 backoff |
| PR MERGED | 零卡 + durable defer；run active；existing external-merge reconciler 仍拥有收敛权 |
| PR CLOSED/cross-repo | run held；唯一 event + alert；不再 probe |
| engine_terminal / legacy no-binding | 明确 skip；legacy ship 下游仍需 binding |

## 7. 会过期的结论

| 结论 | as-of | 何时会过期 | 重核命令 |
|---|---|---|---|
| PR number/repo/head 已在 exact-head binding | `origin/main` @ `d97bd1173` | binding schema 或 gate-entry transaction 改动后 | `git log -S 'getCurrentWorkflowNodePrBindingForHead' -- packages/teamlead/src/StateStore.ts` |
| materializer tick 3 秒且工作集无 origin backoff | `origin/main` @ `d97bd1173` | GatePoller / list query 改动后 | `rg -n "pollIntervalMs|listWorkflowGateHoldersForMaterialization" packages/teamlead/src/bridge packages/teamlead/src/StateStore.ts` |
| 既有 per-project budget 常量为 6/min | `origin/main` @ `d97bd1173` | ship-ready probe governance 改动后 | `rg -n "PROBE_BUDGET_PER_MINUTE|UNKNOWN_BACKOFF_MS" packages/teamlead/src/bridge/workflow-ship-ready-arm.ts` |
