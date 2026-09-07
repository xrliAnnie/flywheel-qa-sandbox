# FLY-2377 ship 后立即归档 — 调研
Issue: FLY-2377 (https://linear.app/geoforge3d/issue/FLY-2377/self-ship-后-issue-thread-立即归档去掉最后一条消息后安静-60-分钟窗口founder-2026-09-06-选-b)
日期: 2026-09-06
基于: exploration.md

## 1. 现状证据

### 1.1 唯一归档 sink

`archiveThreadAndRecord` 是 close cascade、reconcile、targeted、手动端点和 post-ship 共用的唯一归档入口。它提供 per-thread 串行锁、Discord archived 状态探测、archive-once、founder/human reopen 分类、owner removal，以及 `archiveChatThread` 的 429/5xx 有限退避。

所以本单不应新建归档函数，也不应把 Discord PATCH 搬到 post-ship。

### 1.2 quiet window 如何进入 ship 路径

`ArchiveThreadDeps.quietWindowMs` 默认取 `ISSUE_THREAD_QUIET_WINDOW_MS = 60 * 60_000`。自动路径先探测 thread、取最新消息 frontier，并用 `now - max(messageAt, archiveTimestamp)` 判断是否静默满窗；否则返回 `deferred_quiet_window`，PATCH 次数为 0。

`runPostShipFinalization` 当前传 `authority: "terminal"`，但没有覆盖 quiet window。它收到 `deferred_quiet_window` 后调用 `enqueueTerminalArchive`；accepted/deduped 被当作收尾义务已交接，refused/缺失则返回 `land_archive_deferred_unqueued`。这正是 ship 后 60 分钟以上才归档的实现来源。

### 1.3 `quietWindowMs: 0` 不是安全捷径

设计审查核对实现后发现，`quietWindowMs > 0` 不只是静默判断的开关，它也选择 FLY-2028 强归档路径。该路径包含归档前 Discord probe、frontier fence、补偿 receipt、PATCH 后 probe/frontier 双重验证，以及 `archived_at` 与审计事件的原子提交。现有 `quietWindowMs: 0` 会落到 legacy 分支，只做 PATCH、`markChatThreadArchived` 和独立事件写入。

因此 ship 不能借 `quietWindowMs: 0` 获得立即语义。需要给共享 sink 增加正交的 `timing: "quiet" | "immediate"` 策略：两种策略都走 FLY-2028 强路径，`immediate` 只跳过“是否已静默 60 分钟”的判定，不跳过 probe、frontier fence、补偿或原子提交。默认保持 `quiet`，所以非 ship 调用方不变。

### 1.4 archive-once、旧 epoch 与本次 closeout receipt

FLY-1709 的本地 `archived_at` 是归档 epoch，不是 Discord 当前状态的缓存。新 session 的可靠 activation 晚于 archive epoch 时，`reactivateChatThreadForStartedSession` 会用 `commitReactivation` 清掉 epoch，下一次 close/ship 又进入首次归档路径。

但只依赖 `archived_at` 有一个 fail-open 缺口：若上一 lifecycle 的 epoch 因 crash/漏清仍在，而 Discord 已 open，把 `founder_reopened` 无条件视作当前 ship 已 settled，会让本次 ship 从未 PATCH 却继续 Linear Done。

本次 closeout 必须有自己的 durable receipt。event id 字面固定为 `chat-thread-archived-fly2377-<closeoutKind>-<closeoutId>-<threadId>`：`closeoutKind` 只能是 `land` 或 `execution`，land-managed 使用 `operationId`，legacy 使用 `executionId`。这个 FLY-2377 专属前缀与既有 fly2028/fly1709/fly369 四类 key 不重叠；payload 只含稳定的 receipt version/kind、closeout kind/id、`threadId` 与 `issueId`，不混入 attempts/status/time 等会在重放间变化的值。

receipt 在共享 sink 的 per-thread lock 内判定，而不是由 post-ship 在锁外预查。StateStore 新增 discriminated lookup，同时查询热 `session_events` 与 7 天后迁移到的 `workflow_terminal_archive`，并区分 missing、valid、invalid；只有 valid 且 payload 全等才 settled，冲突或不可解析都 fail closed。若 `commitThreadArchive` 仍因跨进程竞态抛出当前 receipt 的 `session_event_replay`，sink 必须用同一 lookup 重读，匹配则 settled，绝不能落入通用 `archive_failed`。

成功 PATCH 时 sink 通过 `commitThreadArchive` 将当前 archive epoch 和 receipt 原子写入。若当前已有 epoch 且 Discord probe 仍是 archived，则 receipt 只证明本 closeout 已观察到满足状态：插入 receipt 但不推进 `archived_at`，避免改变新 session reactivation 的时间判断。重放先在 lock 内匹配 receipt 并跳过所有 Discord 读写；这时若 founder 已发言导致 Discord 自动解档，也不会被同一次 ship 再次强制归档。若只有旧 `archived_at` 而没有本次 receipt，post-ship 保持 `authority: "terminal"` 并执行 `timing: "immediate"`，即使 Discord open、存在近期消息也要完成本次归档。

## 2. 方案比较

| 方案 | 结果 | 结论 |
|---|---|---|
| 改 `ISSUE_THREAD_QUIET_WINDOW_MS` | 所有自动触发一起变，违反“不改常量”与非 ship 不变 | 否决 |
| post-ship 直接 PATCH Discord | 绕过唯一 sink、archive-once、审计和重试 | 否决 |
| 给 post-ship 传 `quietWindowMs: 0` | 绕过 FLY-2028 的 probe、frontier fence、补偿和原子提交 | 否决 |
| 共享 sink 增加 `timing: "immediate"`，保留 terminal authority 和强路径 | 同 tick 归档；近期消息不阻塞；保留竞态补偿与原子审计 | 采用 |
| 无条件把 `founder_reopened` 当 settled | 旧 `archived_at` 可冒充本次 ship 的归档证据 | 否决 |
| 用当前 closeout 的确定性 archive receipt 防重放，并跨热/冷事件表查询 | 首次必须有本次归档证据；7 天后与并发重放仍可收敛 | 采用 |
| 保留 post-ship targeted enqueue | immediate 不应产生 quiet deferral；残留分支会隐藏回归 | 否决，删除 |
| 删除整个 targeted 队列的 quiet outcome | 会改变非 ship completion 的现有归档语义 | 否决 |

## 3. 精确改动面

### 3.1 共享 sink

- `packages/teamlead/src/bridge/done-thread-archiver.ts`
  - 增加默认 `quiet` 的显式 timing 策略；
  - `immediate` 与 `quiet` 共用 FLY-2028 probe/frontier/compensation/atomic-commit 路径，只省略静默时长判定；
  - 可选 receipt 在 per-thread lock 内跨热/冷表检查；未提供 receipt 的调用方及其既有 event id/payload 保持不变；
  - `session_event_replay:<当前 receiptId>` 重读匹配后 settled，冲突/坏 payload fail closed；
  - 已有 epoch 且 Discord 仍 archived 时写 receipt 但不推进 epoch；
  - immediate 竞态/验证失败返回可重试的 `reopen_check_failed`，不伪装成 quiet deferral。

- `packages/teamlead/src/StateStore.ts`
  - 增加覆盖 `session_events` 与 `workflow_terminal_archive` 的 discriminated event payload lookup；
  - missing、valid record、invalid payload 三态不混淆。

### 3.2 post-ship

- `packages/teamlead/src/bridge/post-ship-finalization.ts`
  - sink 参数保持 `authority: "terminal"`，新增 `timing: "immediate"`；
  - 为每次 closeout 构造并核验确定性 archive receipt；已有匹配 receipt 时跳过 sink，保留之后的 Discord 原生解档；
  - 不把裸 `founder_reopened` 纳入 `isArchiveObligationSettled`；
  - 删除 `deferred_quiet_window` 入队、`archiveDeferredUnqueued` 和 `land_archive_deferred_unqueued` 分支；
  - 删除 `PostShipDeps.enqueueTerminalArchive` 与 `TerminalArchiveAdmission` import。

### 3.3 quiet-only wiring

删除只为 post-ship quiet deferral 穿透的参数/对象字段：

- `DirectEventSink.ts` 与 `event-route.ts` 的 post-ship deps 字段，保留它们各自的非 ship completion enqueue；
- `plugin.ts` resumable post-ship deps 字段；
- `merge-ship-gate.ts` 到 `actions.ts` / `founder-consent/wiring.ts` 的 recovered-merge 参数链；
- `external-merge-reconcile.ts` 的 post-ship deps 字段。

不删除 `terminalArchiveEnqueue` 的独立非 ship completion 消费者，也不改 scheduler、`mapArchiveSinkResult` 或 `isRetryableOutcome`。位置参数删除时逐个核对调用签名，避免移位。

## 4. 测试证据设计

### RED 1：ship tick 不受 quiet clock 阻塞

把 post-ship 顺序测试的 frontier 改为当前时刻内的新消息。实现后应在同一次 `runResumablePostShipFinalization` 内观察到：terminal notification → archive → Linear Done。frontier 仍在 PATCH 前后读取，它现在是并发消息 fence，不是 60 分钟 gate。

### RED 2：旧 archive epoch 不能冒充当前 receipt

预置旧 `archived_at`，Discord probe 为 open，frontier 是 60 分钟内的 human 消息，但没有当前 land receipt。post-ship 必须仍调用 archive PATCH、原子写当前 receipt，并在当前 tick 继续 Linear Done。

### RED 3：归档后 founder 解档不被同一 ship 重放

先完成一次带当前 receipt 的归档，再模拟 founder 发言令 Discord open，并重放同一 land operation。sink 必须在 lock 内通过精确 receipt 跳过 probe/PATCH；不发送解释消息，不清除 epoch。换一个 operation id 时不能复用旧 receipt。

### RED 4：强路径没有被 immediate 绕过

在 `done-thread-archiver.test.ts` 直接验证 immediate 模式：近期 frontier 不 defer，但仍执行 pre-probe、PATCH、post-probe、post-frontier 校验和 `commitThreadArchive`。前后 frontier 变化或回读异常返回可重试失败或执行补偿，绝不落入 legacy `quietWindowMs: 0` 路径。

另把 receipt event 的时间推进到 retention cutoff 后执行 `archiveTerminalRows`，再重放同一 closeout：必须从冷表识别匹配 receipt，零 Discord 调用并 settled。补充 mismatch/invalid payload fail-closed 与精确 `session_event_replay` 收敛测试。

### RED 5：quiet enqueue 分支消失

将 structural wiring 测试改为断言所有 post-ship finalization deps 不再出现 `enqueueTerminalArchive`，同时保留 DirectEventSink/event-route 对非 ship completed 的 enqueue 行为测试。

### 保留回归

- `done-thread-archiver.test.ts`：close cascade 仍在 60 分钟内 defer；
- `archive-outcome-consumers.test.ts`：targeted quiet deferral 仍 retryable；
- `terminal-thread-archive.test.ts` / reconcile tests：非 ship targeted/global 行为不变；
- `pnpm --filter flywheel-teamlead test:stub-hygiene`，防止 post-ship suite 的 worker 复用泄漏 stub；
- full repo lint/build/test；包级命令用 pnpm 可正确透传的无分隔符形式排除会启动真实 Terminal.app 的 `packages/core/test/tmux-viewer.macos.test.ts`；
- `bash scripts/__tests__/fly2045-milestone-layout.test.sh` 与本单新增的全部 shell 测试。

## 5. 基线

构建 teamlead workspace 依赖闭包后，以下现状基线通过：

```text
post-ship-finalization.test.ts
done-thread-archiver.test.ts
archive-outcome-consumers.test.ts
terminal-archive-enqueue-sites.test.ts
4 files / 113 tests passed
```

首次直接运行因新 worktree 没有依赖、随后因 workspace package dist 尚未构建而无法 collect；执行 `pnpm install --frozen-lockfile` 与 `pnpm --filter flywheel-teamlead... build` 后恢复。这不是行为失败。
