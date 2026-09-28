# Design Review — plan.md (Round 2)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

v3 是明显进步，且“取消重发”是正确的减法。Round 1 的 #5（落盘耐久性）、#6（限窗范围）、#7（反应读取顺序）、#8（账号 + grant 去重）以及两项 advisory 的核心方向均已落实。#1–#4 也大部分关闭，但仍各留有一个会影响卡片归因、episode 绑定、凭据绑定或切换崩溃恢复的真实缺口。

本轮不重开已经关闭的架构问题；结论为 **CHANGES REQUESTED**，共 5 个 blocking、2 个 advisory。未运行测试（本轮是只读计划评审，代码尚未实现）。

## What's Good (Keep)

- 保留“每个 proposal 至多一次 POST，未确认后永不重发”。这比模拟 Claude 客户端重试更简单，也把最危险的重复花卡面直接删掉了。
- 保留 `executing → redeem_unconfirmed/redeem_confirmed → switching` 的持久化阶段、`switchIntent`、开关关闭后仍对账已开始动作，以及按崩溃点注入测试的方案。
- 保留执行时完整重跑直接候选与卡候选、目标始终必须 `atLimit`、事实变化后取消并重新征询。
- 保留锁内 `executing + requestId + switchIntent` 线性化点、父目录 fsync、audit 先 fsync 后终态、损坏 audit fail-closed。
- 保留 v1 只支持非空 `exhausted ⊆ {five_hour, seven_day}`；其它窗明确拒绝，而不是假装能够验证。
- 保留 ✅ 先读、❌ 最后读、单飞和 fail-closed；对剩余毫秒窗口的“决定写入即终局”定义是清楚且可实现的。
- 保留 `(target.name, grant.id)` 去重，以及拒绝/超时/文件错误时同时断言“0 POST + 原有降级切号仍执行”。

## Issues & Recommendations

1. **[BLOCKING] 首次响应矩阵仍把没有证据的结果写成“failed, not spent”。**

   **Issue:** §5.1/§5.4 把任意其它 HTTP 4xx 归为 `refused/http_4xx`，并把首次 `already_used` 与其它 decided 拒绝一起记为“没花”。这与已读取的 Claude 客户端合同不一致：通用 `error` 会保存 pending request 并显示未确认，而不是证明未花（`cedar-ember-excerpts.txt:434-447`）；客户端对没有 prior-pending 的 `already_used` 也返回 `outcome:"spent"`（`:411-420`），含义至少是这张 grant 已经被花掉，不能审计为“卡没花”。此外，§5.4-7 把“该 grant 从列表消失且其它 grant 未变”当作 `redeem_confirmed`，但 cedar schema 没有承诺“消失只能由本次兑换造成”；到期、活动撤回或并发使用都能形成同一观测。

   **Why:** 这不会触发第二次 POST，但会把可能已花/由别人花/结果未确认的卡写成未花或写成“本 proposal 已证实花卡”，使 Discord、audit 和后续 `(account, grant)` 去重依据失真。尤其 generic 4xx 是服务端已处理请求后仍返回错误的常见不确定边界，不能仅凭状态码证明没有副作用。

   **Fix:** 仅把有明确合同证据的 401/403/429 和明确未受理结果记为本次未花；其它未知 4xx 进入 `redeem_unconfirmed` 的只读判定。`already_used` 单列为 `spent_elsewhere_or_prior`（不声称本 request 花卡，但永久阻止该账号/grant 再提议），再只读判断账号是否已恢复。grant 消失只能算 `unproven/ambiguous`，不能单独证明本次兑换；`redeem_confirmed` 只接受成功响应或同一 grant 的 `resetsLeft` 明确下降。补 generic 400/408/409、首次 `already_used`、grant 到期消失的用例。

2. **[BLOCKING] 执行时的 consent facts 仍未绑定原 episode，且漏掉了 `grant.clears`。**

   **Issue:** §5.4-4 的精确比较集合只有 `{target.name, grant.id, endsAt, exhausted, recoveryAt, cardsLeftTotal, subscription}`。它没有重算并比较 proposal 的 `episodeKey / active.drivingWindow / drivingWindowResetAt`，也没有包含 `grant.clears`。这与同节“允许漂移只有在用号用量上升、目标用量（仍 atLimit）、runway”以及 §6 明确要求 `clears` 改变时取消相矛盾。

   **Why:** 真实反例：在 5h 85% 时按 5h episode 获批；等待期间 5h 自然重置，但周窗随后到 100%。两窗没有同时低于 askPct，所以轻量复核不会取消；当前 `scope` 非空，目标卡事实也可完全相同，v3 会用旧 5h 同意执行一个新的 weekly episode。另一个反例是 grant 从“清 5h + 周”变成只清 5h，而当前仅 5h exhausted；仍满足 `exhausted ⊆ clears`，却不再兑现卡片上“周额度也一并清零”的承诺。

   **Fix:** 执行时用当前 active usage 重算 driving window 与 episode key，要求与 proposal 完全相同（除非明确把 reset 时间容差也纳入 founder 裁定）；不相同则 `cancelled` 并重新问。把 canonicalized `grant.clears` 加入 proposal digest 和 execution consent facts 的精确比较。新增“原 5h 窗已重置、weekly 后来触发”和“clears 改变但 exhausted 仍被覆盖”的 0-POST 测试。

3. **[BLOCKING] 线性化点绑定了 active 凭据，却没有绑定实际用于 POST 的 target 凭据。**

   **Issue:** §5.4-5 锁内复核的是在用号的 `rawDigest`；不可逆 POST 使用的却是第 4 步从目标号读出的 token/org UUID。现有 `readCandidateCredential()` 只用 active name/generation/active credential 检查全局 witness，随后返回目标池凭据（`quota-monitor.ts:330-370`）。更具体地，生产接线的 `readPoolCredential` 调用 `readPoolMonitorCredential()`，后者会把 snapshot 的 `rawDigest` 丢掉（`quota-monitor-runtime.ts:566-567`；`quota-monitor-credentials.ts:107-115`）。因此按当前计划无法在第 5 步比较目标凭据 digest。

   **Why:** 目标池文件可能在 cedar/profile 外部读取后被刷新、轮换或重新绑定。同一个名字随后可指向另一份凭据：daemon 会用内存里的旧 token 给旧账号花卡，再由 `switchAccount()` 从池里应用新凭据，形成“卡花在 A、切到 B”。重启后的只读判定也可能拿新凭据读取另一个账号并错误归因。

   **Fix:** 让窄读取路径返回目标池文件的 `rawDigest`（生产接线使用 `readPoolMonitorCredentialSnapshot` 或等价接口）。锁内线性化同时重读并比较 active witness 与 **target credential digest**；把非敏感 target digest 或等价稳定 witness 持久化到 execution intent，供重启只读判定使用。POST 后、切号前若目标 digest 已变，停止切号并记 `redeemed_switch_failed/credential_changed`，不得把新凭据当成已恢复的旧目标。加入读取后换目标池文件、executing 重启后 digest 改变、POST 后切号前 digest 改变的测试。

4. **[BLOCKING] 花卡后的并发切号会被误报为目标切换成功。**

   **Issue:** §5.4-8 的冷却 CAS 失败时只是“不清”，随后仍把 proposal 置 `switching` 并执行第 9 步；第 9 步又把所有 `noop_already_switched` 都当作成功。现有 `switchAccount()` 在当前 active 与 `observedAccount` 不同时会对**任意**新 active 返回 `{outcome:"noop_already_switched", activeAccount}`（`switch-executor.ts:869-880`），generation 漂移也会返回同一 outcome（`:882-905`）。该 result 类型没有 `from/to/generation`（`:185-195`），不能直接传给需要成功切换事实的 settlement。

   **Why:** 卡确认恢复后，人工或普通流程先把 active 从 A 切到第三个账号 C。第 8 步 CAS 失败，但 v3 仍调用旧 intent 的 A→T 切换；executor 返回 `noop_already_switched(C)`，v3 却进入 settlement 并最终把 proposal 标成 switched/switched_unverified。这既覆盖了并发决策，又产生错误 audit/Discord 结果。

   **Fix:** 第 8 步 CAS 失败必须直接进入 `redeemed_switch_failed: active_changed_after_redeem`，不得调用第 9 步。实时与重启路径都只接受 `(outcome === "switched" && to === target && generation === generationBefore + 1)`；`noop_already_switched` 只能在重新锁读 AccountStore 后、证明 active 确为 target 且 `lastSwitch` 与该 intent 精确匹配时当成功，否则是并发切号失败。增加 POST 后/清冷却前 A→C，以及 `switching` 落盘后/调用 executor 前 A→C 的测试。

5. **[BLOCKING] `switching` 崩溃恢复仍缺少可重建输入和耐久的 settlement 幂等点。**

   **Issue:** proposal 的 `switchIntent` 只有 `{from,to,generationBefore,trigger}`，没有第 8 步实时验证产生的 `verifiedAt`，也没有“第 9 步已尝试一次”或 settlement 已完成的持久标记。现有 switch 选择用 `verifiedAt` 决定 live observation 是否可以覆盖 store 中的 quota exhaustion（`account-store.ts:501-539`），而计划要求 crash 后从 `switching` 重试第 9 步，却没有定义如何恢复这个值。所谓“重试一次”也没有持久计数，连续在调用边界崩溃会每次重启再重试。另一个顺序风险是现有 `pollOnce` 的 `reconcileActive()` 在看到新 generation 时先设置 `observedGeneration`、清 `reviveEpoch/blockedEpisode`（`quota-monitor.ts:1642-1667`）；当前成功 settlement 才负责重新建立 `reviveEpoch` 和 blocked recovery（`:2313-2339`）。若 reset-card 恢复放在该 reconcile 之后，仅凭 generation 无法判断 settlement 是否真的执行过。

   **Why:** switch store commit 后崩溃的核心目标不仅是识别 active 已变化，还要恰好一次地恢复 revive/blocked-recovery 语义。当前 schema 既不能完整重建 retry 输入，也不能区分“generation 被通用 reconcile 消费了”和“reset-card settlement 已完成”，所以可能漏建 reviveEpoch、重复重试或重复/遗漏恢复通知。

   **Fix:** 在进入 `switching` 前持久化 `verifiedAt`、期望 generation（严格为 `generationBefore + 1`）及持久 switch-attempt 标记；把恢复对账明确放在现有 generation reconcile 之前，或增加一个 durable `switch_committed/settled` 阶段，使通用 reconcile 不能吞掉该 generation。定义 `settleSuccessfulSwitch(generation)` 的具体幂等判据（不能只看 `observedGeneration`），并让 crash table 精确匹配 `lastSwitch.{generation,from,to,triggerKind}`，而不是 `generation > before && lastSwitch.to === to`。补“store commit 后、通用 reconcile 前/后、settlement state persist 前/后”的测试，并断言 reviveEpoch 与 recovery delivery 都恰好保留一次。

6. **[ADVISORY] 统一 audit 的追加时机与去重口径。**

   **Issue:** I2 说 audit 会出现 `executing / redeem_unconfirmed / ...`；§5.7 又说“每个终态一行（redeem_unconfirmed 也写一行）”，但 `executing` 和 `redeem_unconfirmed` 都不是终态，执行步骤也没有明确何时追加这些中间行。测试表的一处仍写“按 grant id 查”，与正文的 `(target.name, grant.id)` 不一致。

   **Fix:** 列出每个 audit append 事件、幂等键和是否允许同 proposal 多行；测试统一写复合键。若安全去重只依赖最终/ambiguous 行和当前 proposal，则删掉 I2 中 `executing` 的 audit 声明；若确实要在 POST 前留 intent audit，则把 append + fsync 明确放入线性化顺序。

7. **[ADVISORY] §5.6 的 GatePoller 测试还需要对应的外层控制流改动。**

   **Issue:** 把 consent kick 放在 `await landOperationTick()` 前可保证 consent 不被 land 异常阻断，这一部分已解决。但计划同时要求“landOperationTick 抛错时 `codexReadingScheduler.tick()` 仍被调用”。当前 scheduler 只在 land await 之后的 `finally` 内（`bridge/plugin.ts:12877-12885`）；只新增第一行 consent kick 无法让该断言成立。

   **Fix:** 明确是否要把现有 land await 也纳入更外层 `try/finally`。若本单不打算改变 scheduler 的既有语义，就删除该额外断言，只保留“land 抛错不影响 consent kick”；若保留断言，则把对应控制流重构写进计划和回归范围。

## Verdict

CHANGES REQUESTED

Round 1 的大部分设计缺口已经关闭；请再修正响应证据矩阵、episode/clears 绑定、目标凭据 witness、并发 noop 判定，以及 settlement 的可恢复提交点。其余已经关闭的方向无需重做。
