# Design Review — plan.md (Round 3)
Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的 6 项里，#2–#6 已形成完整闭环：maintenance/reconcile 与 scheduler 有独立错误边界；episode 在阈值前即持久化并把 `reset_elapsed` 视为管线健康；mixed 100% 窗口现在与 `pool_exhausted`/capacity guard 一致；非法阈值向量和 null baseline 文案也已锁定。

#1 的共享 occupancy 所有权也基本正确，并修复了 production `availability` 路径不更新 runtime occupancy 的既有缺口。但新 `CodexAccountOccupancy` 同时被 availability 与账号 observer 调用，而这些 collector 调用可并发；计划没有定义乱序完成时的发布 fencing。较旧的“账号空闲”结果可以晚于较新的 active-unshared 结果写入共享 snapshot，并在 probe 后/install 前把安全事实回滚。由于这是 credential-switch mutation fence，本轮保留 1 个阻断项。

本轮只核验 commit `37518e547` 对 Round 2 六项的修订及其新增边界；未重新审计既有 A–D 架构，未运行测试，未修改仓库文件。

## What's Good (Keep)

- R2#2 已关闭：`reconcileCanonical` 有自己的 catch/retry 边界；plugin 又以 `try/finally` 保证 maintenance 的其他失败也不能短路 scheduler。
- R2#3 已关闭：`stale_since` 在首次已尝试且不健康时落库，20 分钟重启不再重置计时；`healthy` 只看观测年龄，所以新 `reset_elapsed` 读数会关闭旧 episode。四个测试形状覆盖了告警前/后重启与恢复后第二段。
- R2#4 已关闭：过去的 100% reset 现在语法有效，只有所有 100% reset 都已过去才清除 `limited`；mixed 形状仍 `pool_exhausted`，并同时断言 selector kind 与 guard boolean。
- R2#5、#6 已关闭：共享向量补齐非法 `staleAfterMs`/`nowMs`；null baseline 固定渲染“从未观测到”，不会落到 epoch 或异常格式化。
- occupancy 的单一实例设计是正确方向：availability、runtime mutation checks 与账号 observer 共享事实，collector 异常显式变为 unknown，mutation 路径按在用拒绝。
- 带 `availability` 的 runtime 测试、probe 期间翻转为 active-unshared 的测试，直接覆盖了先前缺失的生产调用形状，而非只测账号页 guard。

## Issues & Recommendations

1. **BLOCKING — 共享 occupancy snapshot 缺少并发采集的 generation fence，旧结果可覆盖新安全事实。**

   **Issue:** §1.5 定义 `wrap(collectHomes)` 为“原 collector 完成后把结果记进本实例”，但没有规定多个 wrapper/`guard()` 同时在飞时如何排序。GatePoller 每 3 秒以 fire-and-forget 方式启动 `onLandOperationTick`（`gate-poller.ts:537-544, 764-775`），availability 自己只合并 availability 调用；账号 observer 的 `refreshInUse` 会独立调用 `occupancy.guard()`，而且当前每个 slot 都会再调一次（`codex-accounts-observer.ts:349-363`）。因此两类 host inventory 读取可以交错。

   可构造的危险顺序是：A（账号读）先开始并采到“空闲”，随后 B（probe 后的 `availability.refresh()`）采到 active-unshared 并先完成、写入共享 snapshot；A 最后完成，又把 snapshot 覆盖回“空闲”。`rotate()` 在 `await readiness()` 后立刻同步检查 occupancy（现调用点 `runtime.ts:339-344`），此时会错误通过并进入 install。现有“probe 期间翻转”测试若 collector 顺序完成，无法覆盖这个乱序反例。

   **Why it matters:** 共享实例本意是让 mutation 使用最新在用事实；没有发布 fencing 时，它反而新增了一个旧的 clear 结果撤销新的 deny 结果的窗口。该窗口位于真 probe 与 credential install 之间，属于阻断级安全问题。

   **Suggested fix:** 在 `CodexAccountOccupancy` 内为每次采集分配单调 generation，并只允许“最近启动的 generation”发布；较旧调用晚到时仍可把自己的 inventory 返回给原 readiness caller，但不得覆盖共享 snapshot。新的采集开始时应把共享状态暂置 unknown，直到该 generation 成功完成；失败保持 unknown。也可采用能保证同等语义的串行/single-flight 设计，但必须确保 mutation 的 probe 后刷新不能复用或被早于该安全检查启动的结果覆盖。新增 deferred-promise 测试：旧 clear/new active 两轮按相反顺序完成后仍为 active；新一轮在飞期间 `isInUse` 为 unknown；在该乱序落点上 `recordInstalling` 始终为零。

2. **ADVISORY — durable store 方法应自行推导或核验 `healthy`，不要信任与时间戳重复表达的布尔值。**

   **Issue:** `observeCodexReadingPipeline` 同时接收 `latestObservedAt`、`nowIso`、`alertAfterMs` 和派生值 `healthy`。这允许内部调用者意外提交矛盾输入，例如 `latestObservedAt=null, healthy=true` 会关闭 open episode，或当前观测配 `healthy=false` 会打开错误 episode。

   **Why it matters:** 该方法是 episode 状态机与 outbox 原子性的 durable authority；把核心转移条件留给事务外调用者，会削弱新增表所提供的保证。

   **Suggested fix:** 由 store 在事务内根据已校验的 `latestObservedAt`、`nowIso` 和阈值计算 healthy，或至少拒绝不一致组合。加入 invalid timestamp、未来超过 60 秒和矛盾输入测试；不要让非法输入改变 open row。

3. **ADVISORY — 告警分钟数在投递时动态计算，会让同一 eventId 的 ambiguous replay 改变正文。**

   **Issue:** 修订要求按“投递时 `now - staleSince`”计算 N。现有 outbox 在无 durable receipt 时会于 30 分钟后以同一 eventId 明确重放（`codex-quota-store.ts:780-803`）；LeadAlertNotifier 的 replay 路径会绕过既有 claim 并继续发送（`LeadAlertNotifier.ts:1114-1128`）。因此同一 durable event 首次可能写“31 分钟”，重放时变成“61 分钟”，而 `lead_events` 已保存的又是第一次 payload。

   **Why it matters:** 事件身份相同但正文不稳定，增加 ambiguous duplicate 的审计歧义，也使 outbox 行不能完整复现实际发送 blob。

   **Suggested fix:** 在 enqueue 事务中把 `staleMinutesAtAlert`（或 `alertedAt`）固化进 payload，所有重放从 durable payload 渲染相同正文；若确实要展示当前持续时间，应另发更新事件而不是改变同一 eventId。加一次首次 send 无 receipt、跨 30 分钟 replay 的正文相等断言。

## Verdict

CHANGES REQUESTED

Round 2 的六项功能语义已经基本闭环；只需再为共享 occupancy 的并发结果发布加 generation fencing，并用乱序完成测试证明旧 clear 结果不能撤销新的 active/unknown 安全事实。两项 advisory 可在同次修订中收紧 durable 状态与重放确定性，不需要扩大既定范围。
