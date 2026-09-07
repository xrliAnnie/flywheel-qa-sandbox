# FLY-2377 ship 后立即归档 — 实施计划
Issue: FLY-2377 (https://linear.app/geoforge3d/issue/FLY-2377/self-ship-后-issue-thread-立即归档去掉最后一条消息后安静-60-分钟窗口founder-2026-09-06-选-b)
日期: 2026-09-06
基于: research.md

## 1. 目标与锁定范围

ship/land 成功的 post-ship closeout 在同一次 reconcile tick 内直接通过 Bridge 共享 sink 归档 issue thread，不再依赖最后消息时间或 `ISSUE_THREAD_QUIET_WINDOW_MS`。保留 sink 的 archive-once、per-thread lock、FLY-2028 frontier fence/补偿、原子审计、Discord 回读、404 处理与 429/5xx 退避。

只修改 ship closeout。done-cleanup close、terminal archive、6h done reconcile、backlog/manual endpoint、terminate/abandon 的归档语义不变。

## 2. 最终行为合同

### 2.1 新 ship

当 land closeout 已满足现有安全门时：

1. `runPostShipFinalization` 为当前 closeout 构造确定性 archive receipt。event id 固定为 `chat-thread-archived-fly2377-<closeoutKind>-<closeoutId>-<threadId>`；land-managed 使用 `land` + `operationId`，legacy 使用 `execution` + `executionId`。payload 固定为 receipt version/kind、closeout kind/id、`threadId` 与 `issueId`，不含动态字段；
2. 调用 `archiveThreadAndRecord`，明确传 `authority: "terminal"`、`timing: "immediate"` 和可选 receipt；sink 在 per-thread lock 内检查 receipt；
3. StateStore receipt lookup 同时覆盖热 `session_events` 与冷 `workflow_terminal_archive`，并区分 missing/valid/invalid；仅 payload 全等的 valid receipt settled，冲突或坏 payload fail closed；
4. immediate 仍读取归档前 frontier 并在 PATCH 后复核，但不计算或等待静默时长，因此 60 分钟内的新消息不会阻塞归档；
5. 调用仍经 `archiveChatThread`。实际成功归档后，以 `commitThreadArchive` 原子写当前 `archived_at` 与 receipt；没有 receipt 的非 ship 调用方继续使用原 event id/payload；
6. 若已有 `archived_at` 且当前 probe 确认 Discord 仍 archived，插入 receipt 但不推进 archive epoch；若没有本地 epoch但 Discord 已 archived，则原子建立 epoch + receipt；
7. archive settled 后，现有 Linear Done reconciliation 在同一 closeout 链继续执行。

### 2.2 ship 后 founder 发言

archive-once 由“当前 closeout receipt”而不是任意历史 `archived_at` 证明：

- 已归档 thread 被 founder 消息自动解档；
- 同一 ship closeout 重放进入 sink 后在 lock 内读到匹配 receipt，零 Discord probe/PATCH，也不向 thread 发送会再次改变状态的解释消息；
- 只有旧 `archived_at`、没有当前 receipt 时不能 settled，当前 ship 仍以 terminal/immediate 归档；
- 新 session/lifecycle 的既有 reactivation 会清 archive epoch，下一次 done-close/ship 使用新的 closeout identity，可再次归档。

### 2.3 失败

- Discord 429/5xx/network：仍由 `archiveChatThread` 有限重试；最终失败时 post-ship 返回现有 archive partial，land closeout 重试机制负责重放；
- PATCH 后 probe/frontier 竞态或验证失败：保留补偿，并返回可重试的 `reopen_check_failed`；immediate 不返回 `deferred_quiet_window`；
- Discord 404：保持 missing 记录与既有结果解释；
- active lifecycle veto：保持 `in_active_use` settled + waiver receipt；
- 当前 receipt id 已存在但 payload 与本次 closeout/thread 不匹配：fail closed，不能将未知事件当归档证据；
- 当前 receipt 在冷表、热表 payload 为 null/坏 JSON 等场景都必须被明确识别；不存在与不可解析不能共用 `undefined`；
- 跨进程竞态使 commit 抛出 `session_event_replay:<当前 receiptId>` 时，用同一热/冷 lookup 重读：payload 匹配即 settled，不匹配则 fail closed；
- 不再存在 post-ship 的 quiet deferral 入队或 `land_archive_deferred_unqueued`。

## 3. TDD 实施步骤

### Task 1 — RED：immediate 仍走强归档路径

先修改 `packages/teamlead/src/__tests__/done-thread-archiver.test.ts`：

- 给 sink 传 `timing: "immediate"` 与确定性 receipt；frontier 消息时间设为当前时刻；
- 断言不返回 `deferred_quiet_window`，且执行 pre-probe、pre-frontier、PATCH、post-probe、post-frontier；
- 断言成功后 `archived_at` 与 receipt event 已一起落库，payload 精确绑定 closeout/thread；
- 增加前后 frontier 变化/回读异常负例，证明走补偿或 `reopen_check_failed`，没有 quiet retry。
- 将 receipt event 归档到 `workflow_terminal_archive` 后重放，断言从冷表 settled 且零 Discord 调用；
- 注入同 id 不同 payload、坏 payload 和精确 `session_event_replay`，断言前两者 fail closed、后一种匹配时收敛。

先只改测试并运行该文件，确认 `timing`/receipt 尚不存在导致 RED。

### Task 2 — GREEN：给共享 sink 增加正交 timing 与 receipt

修改 `packages/teamlead/src/bridge/done-thread-archiver.ts`：

- `ArchiveThreadDeps` 增加默认 `quiet` 的 `timing?: "quiet" | "immediate"` 与可选成功 receipt；
- StateStore 增加热 `session_events` + 冷 `workflow_terminal_archive` 的 discriminated payload lookup；
- sink 在 per-thread lock 内先核验 receipt，避免两个本地 finalization 都穿过锁外 precheck；
- 将 FLY-2028 强路径条件从“quietWindowMs 大于零”改成“quiet 自动路径或 immediate”，immediate 只跳过 `isQuiet` 判定；
- existing epoch + terminal authority 的 rearchive helper 同样保留 frontier fence，但 immediate 不等窗口；
- receipt 是可选的：提供时成功 commit 使用其固定 id/payload；未提供时 fly2028/fly1709/fly369 的既有 id 与 payload 字节不变；
- existing epoch + Discord already archived 分支只插入 receipt、不更新 `archived_at`；no epoch + Discord already archived 分支原子建立 epoch + receipt；
- 外层 catch 对精确 `session_event_replay:<当前 receiptId>` 用相同 lookup 重读并收敛，绝不写通用 archive_failed；
- immediate 的 post-PATCH open/frontier race 使用 `reopen_check_failed`/补偿，不产生 quiet deferral；
- 保留 legacy `quietWindowMs: 0` 给既有显式调用方，本单不改变它们。

运行 Task 1 测试，确认 green，并验证 `ISSUE_THREAD_QUIET_WINDOW_MS` 值未改。

### Task 3 — RED：近期消息也在当前 ship tick 归档

修改 `packages/teamlead/src/__tests__/post-ship-finalization.test.ts`：

- 将 terminal receipt → archive → Linear Done 测试的 thread 最新消息设为当前时刻；
- `archiveFn` 记录调用顺序并返回成功；
- 断言本次 `runResumablePostShipFinalization` 完成，顺序为 terminal notification → archive → Linear Done；
- 断言 frontier 在 PATCH 前后都被读取，同时没有 targeted enqueue。

先只改测试并运行该文件，确认现状因 quiet deferral 而 RED。

### Task 4 — GREEN：post-ship 选择 immediate 并写当前 receipt

修改 `packages/teamlead/src/bridge/post-ship-finalization.ts`：

- 保持 `authority: "terminal"`，加 `timing: "immediate"`；
- 按钉死的 FLY-2377 key/payload 模板构造 current receipt，并传入 sink；
- receipt 的热/冷核验和并发重放收敛全部留在 sink lock 内；
- 不把裸 `founder_reopened` 加入 settled predicate；
- 更新注释，明确 immediate ship policy、当前 epoch proof 与 replay protection。

运行 Task 3 测试，确认 green。

### Task 5 — RED/GREEN：旧 epoch 与 founder 解档两侧回归

在 `post-ship-finalization.test.ts` 增加两个回归：

- stale epoch：store 预置旧 `archived_at`，Discord open，近期 human frontier，没有当前 receipt；断言仍 PATCH、写当前 receipt 并继续 Linear Done；
- current receipt replay：先落当前 receipt，再令 Discord open；重放同一 operation，断言 Discord probe/archiveFn 为 0、无 Discord 通知，Linear reconciliation 可继续；换一个 operation id 时旧 receipt 不生效。

优先用真实 store 与已有 fetch/archive seams，不增加仅供测试的公开 API。

### Task 6 — RED/GREEN：删除 post-ship quiet queue

测试先行：

- 删除 `post-ship-finalization.test.ts` 中 accepted/deduped/refused/missing quiet enqueue 旧合同；
- 修改 `terminal-archive-enqueue-sites.test.ts` 的静态合同：所有 post-ship finalization deps 不再包含 `enqueueTerminalArchive`，而 DirectEventSink/event-route 的非 ship completed enqueue 测试继续保留。

实现：

- 删除 `PostShipDeps.enqueueTerminalArchive`、`TerminalArchiveAdmission` import、`archiveDeferredUnqueued` 与 quiet enqueue/result 分支；
- 删除 DirectEventSink、event-route、plugin、external-merge-reconcile 的 post-ship deps 字段；
- 删除 merge-ship-gate 到 actions/founder-consent wiring 仅用于 post-ship 的参数穿透，并逐个核对位置参数；
- 保留 `terminalArchiveEnqueue` 在 DirectEventSink/event-route 非 ship completion、run-infra composition 与 targeted scheduler 中的用途。

运行：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/post-ship-finalization.test.ts \
  src/__tests__/terminal-archive-enqueue-sites.test.ts \
  src/__tests__/archive-outcome-consumers.test.ts \
  src/__tests__/done-thread-archiver.test.ts
```

### Task 7 — REFACTOR 与负控

- `rg` 确认 post-ship 中无 `enqueueTerminalArchive`、`archiveDeferredUnqueued`、`land_archive_deferred_unqueued`；
- `rg` 确认常量定义和值未改；
- 跑 close cascade 窗口内 defer 测试，证明非 ship quiet 仍存在；
- 跑 terminal/reconcile 焦点测试，证明 targeted 非 ship retry 行为未变；
- 不删除整个 `deferred_quiet_window` outcome，因为它仍是非 ship 自动归档的有效结果。

## 4. 预期文件

行为与测试：

- `packages/teamlead/src/bridge/done-thread-archiver.ts`
- `packages/teamlead/src/StateStore.ts`
- `packages/teamlead/src/bridge/post-ship-finalization.ts`
- `packages/teamlead/src/__tests__/done-thread-archiver.test.ts`
- `packages/teamlead/src/__tests__/post-ship-finalization.test.ts`
- `packages/teamlead/src/__tests__/terminal-archive-enqueue-sites.test.ts`
- `packages/teamlead/src/DirectEventSink.ts`
- `packages/teamlead/src/bridge/event-route.ts`
- `packages/teamlead/src/bridge/plugin.ts`
- `packages/teamlead/src/bridge/merge-ship-gate.ts`
- `packages/teamlead/src/bridge/actions.ts`
- `packages/teamlead/src/bridge/founder-consent/wiring.ts`
- `packages/teamlead/src/bridge/external-merge-reconcile.ts`

流程文档：

- `engineering/doc/FLY-2377-ship-immediate-archive/{exploration,research,plan,progress}.md`
- `engineering/doc/milestones/FLY-2377.md`，作为 PR 的 literal last commit。

若 TDD 证明无需某个 wiring 文件，则不为凑清单修改。

## 5. 验收映射

| 验收 | 权威证据 |
|---|---|
| ship 同 tick 发归档 | post-ship 行为测试中近期 frontier、同一次 await、`archiveFn` 调用顺序 |
| 60 分钟内有消息仍归档 | 最新消息 = now，archive 成功；frontier 只作前后 fence，不作 quiet gate |
| archive-once | sink 原子 receipt + 同一 closeout 重放测试 |
| 旧 epoch 不冒充本次归档 | stale `archived_at` + 无 current receipt 仍 PATCH 并写 receipt |
| founder 发言后不被同一 ship 强归档 | current receipt + Discord open，同 operation 重放 archive PATCH 0；下一 operation 不复用 |
| 非 ship 不变 | close cascade quiet-defer 负控、targeted outcome/reconcile suites |
| 不改常量 | diff + `rg` |
| 生产 ≤1 tick 一致 | 后继 QA 在下一张真实 ship 上只读核 `chat_threads.archived_at` 与 Discord archived；本 PR 保持两侧可观测字段 |

## 6. 完整验证与交付

实现完成后运行：

```bash
pnpm lint
pnpm -r build
pnpm --filter flywheel-teamlead test:stub-hygiene
pnpm --filter './packages/*' test:run --exclude '**/tmux-viewer.macos.test.ts'
bash scripts/__tests__/fly2045-milestone-layout.test.sh
```

另逐个运行本单新增的 `scripts/__tests__/*.test.sh`，预计无新增。pnpm 参数不加多余的 `--` 分隔符，确保 Vitest 实际收到 exclude；包级测试明确排除会打开真实 Terminal.app 的 `packages/core/test/tmux-viewer.macos.test.ts`，其余 package suites 全跑。按 runner contract 使用 `codex:rescue` 做 code review，注册 `review_code` gate；修复 blocking finding 后以新 head 重开 review。最后创建 milestone 作为 literal last commit，push、开 PR，并用 `complete --route needs_review --pr <NUMBER>` 交给 DAG orchestrator；不 merge、不 dispatch QA。
