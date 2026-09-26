# Design Review — plan.md (Round 2)
Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的 7 项均有正面响应，其中 future-time fail-closed、零推进 failure code、Codex 独立阈值、手动 outbox durable schema/分支顺序已经形成可实施闭环。旗标关闭时补只读 guard 与 canonical reconciliation 的方向也正确，episode 表则解决了“已经进入停更段后跨重启重复告警”的核心问题。

但增量设计仍有 4 个阻断缺口：occupancy 抽取没有定义 mutation runtime 如何继续共享最新在用快照；旗标关闭时新增的 canonical 对账异常会阻止后续 scheduler；episode 在阈值前重启时仍会永远不告警，且 `reset_elapsed` 成功观测不会关闭旧段；capacity-guard 的 mixed-window 期望与所写 selector 规则不可能同时成立。以上均由本轮修订引入或直接属于 Round 1 项目的未闭环部分，因此本轮仍请求修改。

本轮严格限定为 Round 1 七项及其新增设计的增量复审；未重新审计已认可架构，未运行测试，未修改仓库文件。

## What's Good (Keep)

- #2 已关闭：`nowMs`/`staleAfterMs` 非法与超过 60 秒未来偏差均 fail closed；30 分钟、reset 等于 now、未来边界也写入共享向量。
- #4 已基本关闭：scheduler 在刷新前后比较最大有效 `observedAt`，明确区分 reject、resolve-but-no-progress 与成功推进，并要求所有异步错误在内部收敛。
- #5 已关闭：计划点名 `buildAccountQuotaView` 必须消费/校验 Codex 自己的 30 分钟阈值，并用 Claude 120 / Codex 30 的反差用例防止再次串线。
- #7 已关闭：手动 notification 固定为 bounded JSON string/null，手动分支位于 incident 通用解析之前；NULL incident、身份不符、畸形快照、重启不重发均有明确测试。
- #1 的总体分层正确：保留 flag-OFF 零 runtime 语义，把只读 occupancy 与 canonical 对账从 mutation runtime 中抽出，不借机更改 readiness 或恢复路径。
- #3 采用 durable episode，而非用进程内去重或启动时间拼 eventId；episode 与 outbox 同事务创建、eventId 绑定 UUID，已经能覆盖“告警后同一段反复重启只发一次”。
- #6 新增 StateStore 层 guard replay 表驱动测试是必要的；它能把 selector 变更的 blast radius从 rotate 扩展到真实 admission guard。

## Issues & Recommendations

1. **BLOCKING — occupancy helper 的状态所有权不清楚，可能让 mutation path 丢失在用账号 fencing。**

   **Issue:** 当前 runtime 的 `readinessResult()` 不只返回 readiness；它还更新 `canonicalChainActive` 与 `activeUnsharedAccountKeys`（`runtime.ts:54-95`）。随后 `observe()`、`rotate()` 在读候选前、probe 前和 install 前多次调用同步 `candidateInUse()`（`runtime.ts:168, 193, 270, 325, 343`）。修订后的 §1.5 只说把这段逻辑抽成 `createCodexAccountInUseGuard(...)`，并让 `runtime.accountInUseGuard()` 委托它，却没有说明这些 mutation call sites 从哪里得到同一份、最新的 occupancy snapshot。若 helper 是给账号页返回的独立 closure，runtime 私有字段将不再被这条路径更新；生产 runtime 又注入了 `availability`，其 `readiness()` 走 `availability.refresh()` 而不是 `readinessResult()`，因此现有 runtime 测试也不能证明状态仍被刷新。

   **Why it matters:** 这是 credential-switch 安全边界。账号页 A 可以工作，但 coordinator 可能把 `activeUnsharedAccountKeys` 当空集，继而对正在被独立进程使用的号执行读、probe 或 install。计划宣称“行为不变”，目前 API 所有权却不足以保证这一点。

   **Suggested fix:** 把抽取物定义为有明确生命周期的共享 occupancy provider，而不只是一次性 guard factory，例如同一实例同时提供 `refresh(): Promise<Guard>` 与 `isInUse(accountKey): boolean | "unknown"`；runtime 的 `readinessResult`/`observe`/`rotate` 与账号 observer 必须使用同一 snapshot，standalone flag-OFF 路径才创建独立实例。至少新增一个带 `availability` 的 runtime 测试：collector 报 active-unshared 后，observe 不读该号，rotate 在 probe 前及 probe 后都拒绝，`recordInstalling` 为零。若选择保留现有 runtime 私有状态，则计划需明确 helper 如何回写它，而不是仅写“delegate”。

2. **BLOCKING — flag-OFF canonical 对账失败会跳过 scheduler，A 仍未真正与 D 解耦。**

   **Issue:** §1.5 把当前 `credential()` 主体原样抽成 `reconcileCodexCanonicalRoot`；该主体会在 realpath/read/identity/generation/install-lock 等失败时抛错。现有 maintenance `tick()` 只用 `finally` 保证 outbox/audit，仍会把异常重新抛出（`maintenance.ts:33-40`）。计划又要求 plugin 先 `await codexQuotaMaintenance.tick()`、之后才 `codexReadingScheduler.tick()`（plan:94；当前接线 `plugin.ts:12606-12610`）。所以 runtime 缺席时，只要新增的 D 对账持续失败——包括合法的 `quota_installation_pending`——A 的 scheduler 每轮都不会被调用。

   **Why it matters:** 这在修复“旗标关闭导致 A/D 同时失效”时重新建立了 D→A 的硬依赖。canonical auth 不可读时，账号 observer 本身仍可读取 profile slots（现实现把 canonical 不可读仅视为 active slot 不可证明），scheduler 至少应继续尝试并按其自身契约告警。

   **Suggested fix:** 给 `reconcileCanonical` 独立的 best-effort 错误边界并按 code warning/下轮重试，或在 plugin 用 `try/finally` 保证 maintenance 无论成功失败都调用 scheduler；不能让对账错误从该顺序短路 A。增加 runtime-absent 测试：`reconcileCanonical` 抛错时，flush/audit 仍执行、scheduler 仍 tick、零 probe/install/recovery，下一轮仍可重试对账。

3. **BLOCKING — durable episode 仍缺少“阈值前跨重启”状态，且成功的 `reset_elapsed` 观测不会关段。**

   **Issue:** 计划仍以“当前 scheduler 启动时刻”作为无观测时的 30 分钟起点（plan:89），而 episode 只在已经判定超时后由 `openCodexReadingStaleEpisode` 创建并立即 enqueue（plan:90-93）。如果一直没有 store，Bridge 每 20 分钟重启一次，每次启动时间都会重置，系统停更数小时也永远不会创建 episode/告警。“同一段跨重启只一条”测试只覆盖 episode 已经打开后的重启，未覆盖告警阈值前的重启。

   同一设计还有第二个转换错误：关段要求新观测为 `fresh`（plan:92）。一个刚成功写入、`observedAt=now` 但 100% reset 已过的读数，其 freshness 是 `reset_elapsed`；这证明读数管线已经恢复，只是额度语义待真探。若不关闭旧 stale episode，31 分钟后再次停更仍复用旧段，第二段告警会被吞。

   **Why it matters:** 两个反例都违反 B 的“一段停更一条”：前者是零条，后者是恢复后下一段仍零条。它们也说明当前表只持久化“已告警 episode”，尚未持久化“停更候选/开始时间”。

   **Suggested fix:** 在第一次已尝试但无推进时就持久化 open episode/degradation state，保存 `stale_since = maxObservedAt ?? firstFailedAt`；增加 `alerted_at`（或以 outbox 是否存在为等价状态），仅当 durable `stale_since` 超过 30 分钟时同事务 enqueue。这样阈值前重启复用原起点，阈值后重启复用同 eventId。关段条件改为观测时间推进且 freshness 属于 `fresh | reset_elapsed`（即既非 `stale` 也非 `unobserved`）。补两条测试：无 store、每 20 分钟重启仍在累计 30 分钟后告警；stale→当前 `reset_elapsed` 关段→再次 stale 产生第二条告警。

4. **BLOCKING — mixed 100% window“守卫保持”的测试与 selector 规则互相矛盾。**

   **Issue:** §1.3 仍规定只有整个 observation 满足 `resetElapsed` 时，100% 的过去 reset 才能通过 `windowsValid`（plan:102-105）。对于“一个 100% reset 已过去、另一个 100% reset 仍在未来”的 mixed observation，`resetElapsed=false`，过去窗口使 `windowsValid=false`，selector 因而返回 `observation_unavailable`，不是 `pool_exhausted`。而 `hasCurrentCapacityGuard()` 只在 selector 返回 `pool_exhausted` 时为 true（`codex-quota-store.ts:1624-1633`），所以 plan:107 要求的“guard 保持”测试按当前设计必然失败。

   **Why it matters:** 这不是测试措辞问题：它决定已有容量守卫在一个仍明确存在未来 100% 限制窗口时是继续挡住 admission，还是因另一个窗口 reset 已过而解除。当前计划同时承诺两种相反行为。

   **Suggested fix:** 先锁定期望，再使 selector 与 guard 一致。若按修订所写要保持 guard，建议让语法有效的过去 100% 窗口通过 `windowsValid`；只有“所有 100% 窗口均有 reset 且均已过去”才由 `resetElapsed` 清除 `limited` 成为候选。mixed 形状因仍有未来/未知的 100% 窗口而保持 `limited`，可继续得到 `pool_exhausted`；非 100% 的过去 reset 仍保持 invalid。表驱动测试需同时断言 selector kind 与 `hasCurrentCapacityGuard` 布尔值，不能只写“fail closed”。

5. **ADVISORY — freshness 向量漏列了已经写入函数契约的非法 `staleAfterMs`。**

   **Issue:** plan:49 同时规定非法 `nowMs` 与非法/非正 `staleAfterMs` 返回 `unobserved`，但 plan:53 的共享向量清单只列非法 `nowMs`。

   **Why it matters:** 这是跨包共享纯函数；零、负数、`NaN`、`Infinity` 若未经向量锁定，teamlead 与 CLI 的边界实现仍可能漂移。

   **Suggested fix:** 共享向量增加 `staleAfterMs` 为 0、负数、`NaN`/`Infinity` 的用例，两边继续逐向量执行。

6. **ADVISORY — baseline 为空时的告警正文尚未定义。**

   **Issue:** episode payload 允许 `baselineObservedAt=null`，测试也明确覆盖“一开始没有 store”，但正文仍固定为“最后一次成功读数 <PT>”（plan:95-97）。若直接格式化 null，可能显示 1970、抛错使 outbox 永久 pending，或由实现者自行发明文案。

   **Why it matters:** 这是新增 durable row 的首要故障形状，且 outbox 必须 fail closed、可重放。

   **Suggested fix:** 锁定 null 文案（例如“最后一次成功读数：从未观测到”），非 null 才格式化 PT；outbox 测试同时覆盖两种正文。

## Verdict

CHANGES REQUESTED

Round 1 的多数项已经关闭，但请先修订以上 4 个阻断契约：共享 occupancy snapshot 的 mutation fencing、canonical reconcile 与 scheduler 的错误隔离、episode 的阈值前持久化与 `reset_elapsed` 关段、以及 mixed-window selector/guard 的一致语义。其余两项为小型测试/文案补全，不需要扩大既定范围或触碰 readiness 的 6 个生产 blocker。
