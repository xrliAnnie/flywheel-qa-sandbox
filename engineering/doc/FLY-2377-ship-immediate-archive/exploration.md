# FLY-2377 ship 后立即归档 — 探索
Issue: FLY-2377 (https://linear.app/geoforge3d/issue/FLY-2377/self-ship-后-issue-thread-立即归档去掉最后一条消息后安静-60-分钟窗口founder-2026-09-06-选-b)
日期: 2026-09-06
基于: 无

## 1. 裁定与问题

founder 已选 b：ship 完成立即归档；之后在 Discord thread 发言时由 Discord 原生自动解档。现状不满足这个裁定，因为 post-ship 收尾调用共享归档 sink 时使用 `authority: "terminal"`，sink 会读取最后消息 snowflake，并要求 `ISSUE_THREAD_QUIET_WINDOW_MS`（60 分钟）已经过去。任何收尾消息都会重置 frontier；未满窗口则返回 `deferred_quiet_window`，post-ship 再把 issue 放入 targeted 队列。

实测延迟因此不是归档 PATCH 偶发丢失，而是当前策略的必然结果：归档时间取决于最后一条 Discord 消息和 targeted 队列退避，而不是 ship closeout tick。

## 2. 当前链路

ship/land 的共享收尾链在 `packages/teamlead/src/bridge/post-ship-finalization.ts`：

1. runner / phase / worktree closeout；
2. land terminal 通知写入 issue thread；
3. `archiveThreadAndRecord` 归档 thread；
4. Linear Done reconciliation；
5. 写 `post_ship_finalization_completed`。

归档动作已经正确收敛到 `packages/teamlead/src/bridge/done-thread-archiver.ts` 的唯一 token-bearing sink；Discord 429/5xx 的有限重试和回读验证在 `archiveChatThread` 内完成。问题只在 ship 调用方选择了静默窗口策略，并为 `deferred_quiet_window` 增加了 targeted enqueue。

## 3. 保留的安全语义

- 不直接 PATCH Discord；仍走 `archiveThreadAndRecord` → `archiveChatThread`。
- per-thread lock、审计、404 missing、owner removal、429/5xx 退避和结果回读不变。
- archive-once 不变：一次 ship 成功归档后，`chat_threads.archived_at` 保留归档历史。founder 后续发言导致 Discord 自动解档时，同一生命周期的重复 closeout 不应再次强制归档。
- 新 lifecycle/session 开始时，既有 `reactivateChatThreadForStartedSession` 会用 `commitReactivation` 清掉旧 `archived_at`；因此下一次 done-close/ship 可以再次归档。
- `maybeArchiveThreadOnClose`、`done-thread-reconcile`、`terminal-thread-archive` 和手动 `/api/chat-threads/archive` 的非 ship 策略保持不变。

## 4. 拟定改动边界

只修改 post-ship 使用共享 sink 的策略：

- 明确请求“立即”归档，使首次归档不读取/等待消息 frontier 的 60 分钟窗口；
- 恢复 post-ship 对 `founder_reopened` 的 settled 解释，避免同一 ship 的重放与 founder 争抢 thread；
- 删除 post-ship 的 `deferred_quiet_window → enqueueTerminalArchive` 分支，以及只为这条分支穿透的依赖与 wiring；
- targeted 队列仍服务非 ship completion，并保留其既有语义。

## 5. 假设

1. “同一 reconcile tick”指 `runPostShipFinalization` 本次 await 链里发出归档动作，不要求把 Discord 网络重试移出当前 sink。
2. “下一次 done-close 再归档”沿用现有 lifecycle reactivation 清 epoch 的边界；同一生命周期的 post-ship 重放不是“下一次”。
3. Linear Done 仍按当前顺序在归档成功/settled 后落地；本单要求二者属于同一收尾链，不要求交换顺序。
4. 生产只读核由后继 QA/下一张真实 ship 完成；实现节点只提供可执行单测和保持既有生产观测字段。

## 6. 不做

- 不改 `ISSUE_THREAD_QUIET_WINDOW_MS` 数值。
- 不改 done-cleanup / terminate / abandon / backlog cleanup 的触发和静默窗口。
- 不改 Discord 原生 auto-unarchive，不增加锁 thread 或发消息后重新归档的 watcher。
- 不增加新数据库字段、迁移、配置开关或独立 Discord 写路径。
