# Design Review — plan.md (Round 4)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

本轮严格只复核 Round 3 的四项及其 v5 修复直接引入的问题；没有重开 R1–R3 已关闭的其它设计。本轮为静态计划与源码核对，未运行测试。

| Round 3 项目 | 结论 | 说明 |
|---|---|---|
| R3 #1：CAS 失败不写 store；成功证明包含当前 generation | **NOT RESOLVED** | 当前 generation 的实时与恢复证明已正确补齐；但第 8 步仍在联合 CAS 之前通过 `recordObservation()` 写 AccountStore，因而 CAS 失败并不保证 store 未被写。 |
| R3 #2：state load 在 `pollOnce` 前清掉 `blockedEpisode` | **RESOLVED** | `switching` 时持久化快照、真实 runtime load 后在 settlement 的同一次 `persistState` 中条件恢复，并以既有 settlement 判据防止二次恢复，闭合了原崩溃路径。存在一项低风险接线遗漏，见问题 #3。 |
| R3 #3：intent → executing 崩溃缝隙复用 requestId | **RESOLVED（原问题）** | intent 命中时复用同一 requestId，且 target/grant 不一致时 fail-closed，原 identity 缺口已关闭；但新增恢复路径会在复核取消时留下永久占用卡片组合的 orphan intent，见问题 #2。 |
| R3 #4：§6 旧断言与 `grant_already_used` 分支 | **RESOLVED** | 测试矩阵已与响应分类一致；`grant_already_used` 已独立为只检查原 exhausted windows、永不进入 `redeem_confirmed` 的路径。 |

## What's Good (Keep)

- 保留 §5.4 第 9 步和恢复表对 `store.generation === expectedGeneration` 的显式检查。现有 store 可在保留旧 `lastSwitch` 时推进 generation，因此这一条件是必要的。
- 保留 `blockedEpisodeAtSwitch` 的耐久快照方案：它正面覆盖 `loadQuotaMonitorState()` 在 generation 前进时清空 `blockedEpisode` 的真实生产顺序；§6 也已要求通过 `makeQuotaMonitorRuntime()` 验证。
- 保留 audit、proposal 与实际 POST 三处使用同一 requestId，以及 intent target/grant 不匹配时 0 POST、fail-closed。
- 保留 v4 的响应证据矩阵；§5.4 第 6 步、恢复表和 §6 对 `already_used` 的含义现已一致。

## Issues & Recommendations

1. **[BLOCKING] R3 #1 的“联合 CAS 失败时 AccountStore 零写入”仍未实现。**

   **Issue:** §5.4 第 8 步先规定“通过 → `recordObservation(target, …)`”，随后才重新拿锁执行 generation / active / targetDigest 的联合 CAS，并宣称 CAS 失败“不改 AccountStore 的任何字段”。这两个要求互相矛盾。现有 `recordObservationInStore()` 会对目标 entry 调用 `applyObservation()`，修改 `quotaExhaustedUntil`、reset/observed 字段，并在 `account-store.ts:797` 调用 `writeStore()`。因此在 observation 写入后、联合 CAS 前发生 active/generation 变化，或目标 credential digest 改变导致 CAS 失败时，store 已经被写过。

   **Why:** 这正是 R3 #1 要求封闭的并发边界。v5 的测试仅断言 T 的新 `switchCooldownUntil` 保留，无法发现其它 observation 字段已被 stale 流程改写，也无法兑现处置表中的“CAS 失败不写 AccountStore 任何字段”。当前 generation 的成功证明部分则已解决。

   **Fix:** 把目标 observation 投影、两个 cooldown 字段的清理和 `switching` 持久化都放进同一次 accounts-lock 临界区：先完成全部联合 CAS 校验，只有成功后才基于锁内读到的 store 形成一次写入；任一 CAS 条件失败时不得调用任何 store-writing helper。测试应对 generation、active、targetDigest 三种 CAS 失败分别比较完整 AccountStore 序列化内容不变，而不只检查 cooldown。

2. **[MEDIUM] R3 #3 的新恢复行会在 facts_changed 时留下“已确认未 POST、但永久去重”的 orphan intent。**

   **Issue:** §5.4 恢复表规定 `awaiting_consent + approved + intent` 从第 4 步重新复核；若事实已变化，第 4 步会把 proposal 置为 `cancelled`，且由落盘顺序可知旧流程尚未 POST。可是 I2/§5.3 第 6 步又规定同一 `(target.name, grant.id)` 只要存在任一 intent 行就永不再提议。于是一次 intent→executing 缝隙崩溃加事实漂移，会永久封死一张可证明未由本流程尝试兑换的卡；即使事实随后稳定，同 episode 的“重新问”也无法再选择该组合。

   **Why:** 原 requestId identity 问题已解决，但该修复新增了可复现的 liveness 失败，并与第 4 步“changed facts → cancelled → 同 episode 重新问”的契约冲突。

   **Fix:** 为“intent 已落盘、executing 从未落盘且复核取消”定义可审计的 `aborted_before_post`/intent-voided 终态，并让去重只忽略这种可证明未 armed/未 POST 的 intent；继续执行时仍必须复用原 requestId。增加测试：在该崩溃缝隙后改变 consent facts，断言旧 proposal 取消且 0 POST，随后同一 target/grant 可经新同意再次提议；旧 requestId 不得被后续 proposal 复用。

3. **[LOW] R3 #2 的方案引用了当前不可导入的 `parseBlockedEpisode`，修改清单也未列出其所在文件。**

   **Issue:** proposal schema 和第 8 步要求复用 `quota-monitor-state` 的现有 `parseBlockedEpisode`，但该函数目前在 `quota-monitor-state.ts:481` 是未导出的模块私有函数；§3.1 的修改文件清单也没有该文件。

   **Why:** 这不破坏快照恢复方案本身，但照计划逐文件实现时无法真正复用同一 parser，容易改成重复校验或漏接文件。

   **Fix:** 在修改清单中加入 `quota-monitor-state.ts`，明确只导出既有 parser（不改变 state-load 行为），并让 proposal parser 复用它。该项不改变 R3 #2 的 **RESOLVED** 结论。

## Verdict

CHANGES REQUESTED

R3 #2 与 #4 已关闭，R3 #3 的原 requestId 问题也已关闭；但 R3 #1 的核心零写入保证仍被 CAS 前的 `recordObservation()` 破坏，属于真实、源码可证的阻塞缺陷。修复该项时还应处理 orphan intent 的直接 liveness 回归。
