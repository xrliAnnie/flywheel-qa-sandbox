# FLY-1374 状态真相根因修复 — 设计纠偏

Issue: FLY-1374 (https://linear.app/geoforge3d/issue/FLY-1374/状态真相-discord-显示与-session-现实对齐-双对账器进程db-dbdiscord-幂等重渲染)
日期: 2026-07-24
基于: plan.md

## 纠偏结论

本文件由 2026-07-24 founder 纠偏令触发，并覆盖 `plan.md` 中尚未交付的实现方向。既有探索、调研、计划及审查记录保留为决策历史，不回写、不删除；最终代码交付改为一个**根因修复 PR**。

### Founder 原话

> 我还是非常 concerned 加一个所谓的对账器，这不就是 another watchdog 吗？…你每加一个东西，你看一个东西是坏的，就相当于是通过不停地加补丁来解决。我拒绝对账器这种做法。我们要理解的是，它为什么会显示不正确？把这个原因想清楚了，然后直接从根上治，不要再加对账器这种东西。

## 废除的概念

以下设计全部停止实现，也不得换名后重新引入：

1. 一切周期性对账、巡检或 reconciler 循环。
2. `SessionRealityReconciler`、进程现实 → DB 的 sweep、DB → Discord 的 sweep。
3. `audit-first` 巡检层、audit/enforce 双模式及其 GatePoller cadence。
4. 任何“先发现状态不一致，再事后修正”的后台任务、定时器或 watchdog。
5. 仅为上述巡检服务的 durable marker、generation evidence、全量 inventory、死亡证明与自动收口基础设施。

已经提交的旧设计文档保留为历史；已开始但尚未提交的巡检基础设施停止提交。分支上已经提交的、只服务于旧 reconciler 方案的代码，以普通纠偏 commit 从最终代码差异中移除，不重写历史。

## 保留的根因修复器官

最终 PR 只允许修复确定的写入时序或事件语义 bug：

1. **WAKE 路径 rehydrate**：在复用 parked holder 的 activation/wake 写入路径补齐缺失步骤，使 StateStore、CommDB session、TURN/ledger 与信箱在 wake 前形成一致的 activation commit；这是写入时序修复，不做事后扫描。
2. **`wake_failed` episode 语义**：把逐消息/逐次重铸指纹改为“同一失败 episode 只产生一个 durable fingerprint；恢复关闭 episode；新的失败 episode 才产生新 fingerprint”。
3. **DB 写入点同步 Discord 渲染**：逐条定位漏触发渲染的状态写入路径，并在成功 transition 的写入点触发已有的幂等 refresher；禁止通过后台 sweep 兜底。
4. **确定的同族写入缺口**：只有能由测试复现并定位到具体写入点的 archive/lock、长文 split、route guard、lead inbox 双命名空间 receipt/nudge 问题才纳入；证据不足时先询问 Lead，不用扫描器替代定位。

## 实现约束

- 零新增后台循环、定时器、poller cadence 或 watchdog。
- 每个修复必须先有失败测试，测试直接复现确定的写入路径。
- Discord 渲染由 transition 成功后的事件驱动 hook 保证；相同标题仍由既有 refresher 幂等跳过。
- activation/rehydrate 必须 fail-closed：无法证明 holder/epoch/target 时不合成、不猜测、不推进 wake。
- PR 正文引用本文件，并明确原 `plan.md` 的 reconciler 方案已被 founder 纠偏废除。

## 修正后的验收

1. 复用一个 parked holder 派新活，wake 前完成 StateStore、CommDB、TURN/ledger 与 mailbox activation；无需人工修 DB。
2. 同一 `wake_failed` episode 不重复产生新告警；恢复后再次失败才建立新 episode。
3. 所有已定位的 session 状态写入路径在 transition 成功后立即触发既有 Discord 幂等渲染；不依赖下一次 stage event 或周期 sweep。
4. 没有新增 reconciler、巡检 cadence、自动死亡判定或“发现不一致再修正”的代码。
