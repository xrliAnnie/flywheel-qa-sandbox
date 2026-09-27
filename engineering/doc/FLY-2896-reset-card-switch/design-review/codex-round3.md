# Design Review — plan.md (Round 3)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

v4 已完整关闭 Round 2 的 #1（响应证据矩阵）、#2（episode/clears 绑定）、#3（目标凭据 witness）、#6（audit 两类行）和 #7（GatePoller 范围）；#4、#5 的主体方案也正确，尤其是“崩溃后不重试切号”与 `switch_committed → settled` 的减法。

仍有两个源码可证的阻塞缺口：CAS 失败后仍可能擦掉并发切号新写的 cooldown；以及 reset-card recovery 虽放在 `pollOnce.reconcileActive()` 前，但实际 runtime 在进入 `pollOnce` 前已经按新 generation 清掉了 `blockedEpisode`。因此结论仍是 **CHANGES REQUESTED**。本轮共 2 个 blocking、2 个 advisory；未运行测试（计划评审，尚无实现）。

## What's Good (Keep)

- 保留严格证据矩阵：只有 200 + `reset` 或同一 grant 的 `resetsLeft` 下降能证明本次花卡；grant 消失不作证明；未知 4xx/5xx/网络错误全部进入只读不确定态。
- 保留 `already_used` 不归因于本 request、永不重发，以及恢复时如实区分 `redeem_confirmed` 与 `recovered_without_proven_redeem`。
- 保留执行时重算并绑定 `episodeKey`，并把 canonical `grant.clears` 纳入 proposal digest 与 execution facts。
- 保留 target credential `rawDigest`：刷新后获取、线性化点复核、写入 `switchIntent`，只读判定与切号前再复核。
- 保留“CAS 失败不调用 `switchAccount()`”以及 AccountStore `lastSwitch` 精确证明；不要退回依赖 `noop_already_switched` 的返回形状。
- 保留崩溃后绝不重试 profile switch，并保留 `switch_committed`、`settled` 与 settlement 幂等判据。
- 保留每 proposal 一条 intent、一条 terminal 的 audit 模型，以及 POST 前 intent fsync。
- 保留 GatePoller 只保证 consent kick 不被 land tick 阻断，不顺手改变 scheduler 的既有异常语义。

## Issues & Recommendations

1. **[BLOCKING] post-redeem CAS 失败仍会修改 cooldown，且成功证明没有约束当前 store generation。**

   **Issue:** §5.4-8 先定义 generation/active/targetDigest 的联合 CAS，但随后规定 `active_changed_after_redeem` 时仍在锁内清目标号 cooldown。CAS 失败正说明另一个账号域写者已经介入；现有 `commitSwitch()` 会给被切出的账号写新的 `quotaExhaustedUntil` 和 `switchCooldownUntil`（`switch-executor.ts:565-596`）。例如 A→T→C 在本流程验证 T 后并发发生，T 会得到一份新的 post-switch hysteresis，v4 随后的 stale A→T intent 会把它擦掉。

   另一个缺口在 §5.4-9/恢复表：证明条件约束了 `lastSwitch.generation === expectedGeneration` 与 `activeAccount === target`，但没有要求 **当前** `store.generation === expectedGeneration`。AccountStore 明确允许 generation 在不改 `lastSwitch` 时增长（注释 `account-store.ts:109-110`；`syncFreshenedActiveAccountInStore()` 在 `:878-891` 增 generation、保留旧 `lastSwitch`）。所以旧 lastSwitch 仍可匹配，而当前 store 已经进入更晚的 generation。

   **Why:** 第一条会破坏现有切号的 intentional cooldown；第二条会把陈旧 switch proof 当作本 intent 的当前提交，并以旧 generation 建 `reviveEpoch`。紧接着的通用 generation 对账又会看到更大的 store generation，清掉刚建立的 settlement 状态。

   **Fix:** 联合 CAS 任一项失败时，不得清 `switchCooldownUntil`；最简单、安全的行为是完全不改 target store 字段并进入 `redeemed_switch_failed`。如果仍想投影恢复读数，只能用新的 expected-generation CAS，并始终保留并发写入的 `switchCooldownUntil`。实时和重启成功判据都再加 `store.generation === switchIntent.expectedGeneration`。新增 A→T→C 后 T 的新 cooldown 不被清，以及 `syncFreshenedActiveAccountInStore` 令 generation 前进但 lastSwitch 保持旧值时不得 settlement 的测试。

2. **[BLOCKING] reset-card recovery 仍晚于 runtime 的 generation-advanced state scrub，崩溃后会丢失 blocked recovery 语义。**

   **Issue:** v4 把恢复放到 `pollOnce` 内现有 `reconcileActive()` 之前，这能避开 `quota-monitor.ts:1642-1667` 的清理，但生产 runtime 在调用 `pollOnce` 前已先获取 account lock/对账 transition journal，再用当前 store generation 加载 monitor state（`quota-monitor-runtime.ts:409-425`）。`loadQuotaMonitorState()` 发现 store generation 前进时会立即把 `observedGeneration` 提到新值并清空 `reviveEpoch`、`blockedEpisode` 等（`quota-monitor-state.ts:1149-1170`）。之后 v4 的 settlement 可以从 proposal 重建 `reviveEpoch`，却无法重建已被清掉的 `blockedEpisode`；`openBlockedRecovery()` 遇到 `blockedEpisode === null` 直接返回（`quota-monitor.ts:976-983`）。

   **Why:** 在 `switchAccount` 已提交 store、proposal 仍为 `switching` 时崩溃，重启会准确识别 switch，但原有 `quota_blocked_recovered` delivery 已在进入 reset-card recovery 前丢失。这违反 I6/§5.4 对共享 settlement 语义和“恢复通知恰好一次”的要求。当前 §6 的 poll-level crash test若不经过真实 `makeQuotaMonitorRuntime()` 加载路径，会漏掉该反例。

   **Fix:** 把 pending reset-card settlement 纳入 runtime/state-load 边界，而不只是 `pollOnce` 顺序。可选做法是：runtime 在 generation-advanced scrub 前读取并严格验证 `switching/switch_committed` proposal + exact AccountStore proof，给 `loadQuotaMonitorState` 一个仅针对该 expected generation 的 preserve 模式；或把重建 blocked recovery 所需的耐久信息存入 intent/proposal。无论采用哪种，必须保证 journal/store 先完成权威对账、旧 monitor state 尚未被 scrub、再运行/准备 reset settlement，最后才走普通 generation recovery。新增经过真实 runtime 初始化的“store commit 后崩溃”测试，断言 `reviveEpoch` 与原 blocked recovery delivery 都保留且只执行一次。

3. **[ADVISORY] 明确 intent 已 fsync、executing 尚未落盘这一崩溃缝隙的 requestId 恢复规则。**

   **Issue:** §5.4-5 的顺序是先 append/fsync audit intent，再写 proposal `executing`。若恰在两者之间崩溃，proposal 仍是 `awaiting_consent`，恢复表没有对应行；下一轮再次执行第 5 步时，`proposalId:intent` 虽可幂等去重，但计划没有说明 proposal 必须复用 intent 行中已经持久化的 requestId。正文甚至分别写了 intent 的 `requestId` 与 `redeem:{requestId: randomUUID()}`，容易实现成两个值。

   **Fix:** 把该状态写入恢复表：同 proposal 的 awaiting/approved + 已有 intent 表示 POST 尚未发生，读取并复用 intent 的 requestId 写 `executing`，不得生成新 ID；若 intent 的 target/grant 与 proposal 不一致则 fail-closed。让 audit append API 在幂等命中时返回原行，并在现有“intent 后/executing 前崩溃”测试里断言 audit、proposal 和实际 POST 的 requestId 完全相同。

4. **[ADVISORY] 清理 §6 中仍保留的 v3 响应断言，并把 `grant_already_used` 的恢复分支写成独立规则。**

   **Issue:** `reset-card-contract.test.ts` 一行仍写“429/401/403/4xx → refused”（§6 line 306），会把 400/408/409 也包含进去；Codex R1 增补仍写首次 `already_used → failed`（line 320）。两者都与 v4 正文和 R2 增补相反。此外恢复表把 `grant_already_used` 指向“第 7 步”，但第 7 步声明仅 `redeem_unconfirmed` 进入并含“resetsLeft 下降 → redeem_confirmed”的归因规则；`grant_already_used` 只能检查窗是否恢复，不能沿用该归因分支。

   **Fix:** 删除旧断言，按 v4 矩阵逐状态列出预期。恢复表为 `grant_already_used` 单列：“只检查原 exhausted 窗；恢复 → recovered_without_proven_redeem，否则 failed；永不转 redeem_confirmed”。

## Verdict

CHANGES REQUESTED

Round 2 的五个阻塞方向已经基本落实；只需补齐并发 store 写保护与真实 runtime state-load 边界的恢复语义。其余已关闭项无需重做。
