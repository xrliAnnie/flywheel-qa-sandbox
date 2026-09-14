# FLY-2554 ship 即归档 — 调研
Issue: FLY-2554 (https://linear.app/geoforge3d/issue/FLY-2554/thread归档-ship-即归档把-done-thread-archiver-的-60-分钟静默常量降为-0机器消息阶段回声-巡检提醒)
日期: 2026-09-14
基于: exploration.md

## 当前代码证据
- post-ship-finalization.ts：closeout + worktree 清理成功后记录 terminal_notified，然后 immediate archive；只有此路径携带 deterministic successReceipt。
- terminal-thread-archive.ts：只选择 getUnarchivedIssueChatThreads，不能用它当前的选择逻辑证明已归档后被机器消息重开的线程会得到处理。
- done-thread-reconcile.ts：FLY-2028 discovery 读取 Discord open ids，与本地非空 archived_at 交集，核查 Linear、alias session/liveness 后调用 terminal sink。此路径是重开线程的现有选择入口。
- done-thread-archiver.ts：terminal reopened 分支当前只执行 quiet-window 与 frontier 检查，不调用 human classifier；非 terminal 分支才保护 founder_reopened。新例外不得把这两者混称。
- 默认窗口 60m；手动 tools.ts 明确 quietWindowMs=0，保持不变。频道级清扫保持不变。
- DirectEventSink 的 postShipOwned completion 不 enqueue targeted；普通 reconcile intervalMin=360。去掉 bot gate 本身不等于事件到来立即触发；Lead b1e3ba53 已授权 bot 发送成功后入既有 targeted 队列、允许 targeted 选 archived rows；普通6小时 pass只作兜底。

## 生产证据边界
设计 reviewer R1 声称只读生产查询发现 FLY-2543/2549/2542/2360 在 post-ship 首次归档成功后被消息重开，再由手动或全局 reconcile 重归档。此为 reviewer 提供的证据，本 runner 未独立验证其生产查询。
本 runner 按规定执行 managed snapshot helper，但得到 snapshot_owner_unavailable（retryable），没有生成副本；未改用 cp 或绕过 owner。当前只能用实际代码及真实 StateStore fixture 验证选路，生产副本证据仍待恢复/QA。

## Retention
当前 StateStore.ts 查询未发现 DELETE FROM land_operation / land_operation_step。计划复用既有 durable 查询，不新增 session_events 消费，不把易裁剪日志作为归档权限。缺失/无效 land 收据只恢复旧 quiet 行为。
