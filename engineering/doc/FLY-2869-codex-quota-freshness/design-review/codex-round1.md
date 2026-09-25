# Design Review — plan.md (Round 1)
Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确，A–D 的主要代码接缝也与生产实现吻合：Codex 刷新可以从 Claude 刷新中拆出独立 single-flight；selector 的候选在安装前仍经过隔离 `codex exec` 真探；`reconcileExternalRoot` 的事务边界适合同时写 generation 与 outbox；现有 synthetic bench 足以覆盖真实 coordinator/store/install/recovery/outbox 链路，且不需要网络或生产凭据。

但当前计划尚未完整满足锁定范围。共有 3 个阻断项：A 与 D 仍被 auto-switch runtime 的构造旗标控制；共享 freshness 会把合法格式的未来时间当作 fresh；`<lastFreshAt|never>` 不能持久表示“停更段”，会永久吞掉后续一段告警。它们分别影响功能可达性、诚实展示和“一段一条”的 exactly-once 契约，需先修订计划再实施。

本轮为静态源码与调用链核验；未运行测试，也未触碰生产账号、宿主残留或 readiness 的 6 个已裁出问题。

## What's Good (Keep)

- 范围边界清楚：没有借本单修 `authority_unavailable`、清宿主或在生产真切号；自动切证据明确限定为 fixture。
- freshness 放进既有会随 codex-guard 安装的 `codex-account-core.mjs`，并由 teamlead 与 CLI 共用向量，能避免两套“过期/已过重置”语义漂移。
- 非 fresh 投影会清空百分比、过去 reset、`exhausted` 与 `recoveryAt`，保留凭据类状态优先级；这是正确的 fail-closed 展示边界。
- reset-elapsed 只放宽“100% 且所有 100% 窗口均已过 reset”，非 100% 的过去 reset 仍拒绝；`rotate()` 仍要求真探成功才安装，并将通知目标窗口降级为 n/a，安全边界基本正确。
- 手动切号选择在 `reconcileExternalRoot` 同一事务写 external generation、root 与 outbox，eventId 又绑定 generation，适合实现无重复的 durable notification。
- 整链 bench 复用了实际 runtime/coordinator/store、隔离候选 workspace、真实合成 `exec`、六路恢复与 outbox receipt；红色阴性对照也能证明 selector delta 而非 mock 在起作用。

## Issues & Recommendations

1. **BLOCKING — A 和 D 的观测生命周期仍错误地依赖 auto-switch 旗标。**

   **Issue:** 计划只拆刷新函数并挂 scheduler，没有改变 runtime 的构造条件。生产代码在 `plugin.ts:8842-8844` 仅当 `codex_quota_auto_switch` 开启时构造 `CodexQuotaRuntime`；Codex observer 又在 `plugin.ts:8916-8931` 捕获该 runtime，缺失时直接抛 `codex_quota_runtime_unavailable`。手动切号检测同样只发生在 `runtime.credential()`，而 maintenance 仅对存在的 runtime 调 `tick()`（`codex-quota/maintenance.ts:33-38`，`runtime.ts:509-519`）。因此 Bridge 若在旗标关闭状态冷启动，A 会永远只告警而不刷新，D 也永远看不到 `codex-profile use`。`research.md:38-39` 同时写了“关旗标则刷新失败”和“旗标与定时读互不依赖”，两者自相矛盾。

   **Why it matters:** auto-switch 是写凭据/恢复任务的安全开关；关闭 mutation 不应同时关闭只读额度采集和手动变更通知。当前设计在最需要手工切号的模式下恰好失去 D，并不满足计划第 10、13 行锁定的 A/D。

   **Suggested fix:** 把只读 occupancy/observer 与 canonical identity reconciliation 从 mutation runtime 生命周期中拆出，或让 runtime 无条件构造、仅由 `autoEnabled`/readiness 阻止 coordinator rotate。计划需明确 A、D 不依赖 auto-switch flag、readiness 或 recovery API token，并新增“旗标关闭后冷启动”的接线测试：定时刷新能推进 `observedAt`，手动 `use` 只产生一次 notification，同时零 probe、零 install、零 recovery。此修订不需要触碰已裁出的 `authority_unavailable` 修复。

2. **BLOCKING — freshness 没有拒绝未来 `observedAt`，可把陈旧或损坏读数无限期当成 fresh。**

   **Issue:** 计划第 49–50 行只把“缺失/非法”时间判为 `unobserved`，随后用 `nowMs - observedAt > 30min` 判 stale。合法 ISO 的未来时间（例如 2099 年）会得到负 age，因此落入 `fresh`。持久 store 的 `instant()` 只校验 ISO round-trip，不校验相对当前时间（`codex-account-quota-store.ts:84-89`）；CLI snapshot reader更只检查字符串/数组形状（`flywheel-codex-profile.mjs:331-353`）。现有 capacity 的其他观测已有 `now + 60s` 上界模式（`capacity-snapshot.ts:399-404`），但 Codex 投影当前直接使用原始 `observedAt`（`capacity-snapshot.ts:319-340`）。

   **Why it matters:** 一个损坏或被错误写入未来时间的 100% 快照会继续显示“打满”并给恢复时刻；一个非 100% 快照也会长期显示为可用。这直接违反 B 的“过期即未知”和诚实边界，而且 teamlead 与 CLI 会一致地错。

   **Suggested fix:** 在共享函数契约中明确校验 `nowMs`、`staleAfterMs` 和 parsed observation；`observedMs > nowMs + 60_000`（或项目统一的更严格 skew）必须为 `unobserved`，不能 clamp 成 age 0。共享向量加入未来 60 秒边界、超过边界、非法 `nowMs`，并让 capacity 与 CLI 两边消费同一结果。

3. **BLOCKING — `...:<lastFreshAt|never>` 不是停更段的 durable identity，会漏掉后续独立告警。**

   **Issue:** 计划第 85 行以 `codex-quota-reading-stale:<lastFreshAt|never>` 作 outbox 主键。首次无 store/无任何成功观测时会永久占用 `...:never`；系统后来恢复，再经历一次 store 缺失、损坏或重启后丢失当前文件时，新的停更段仍生成同一主键，现有 `INSERT OR IGNORE`（`codex-quota-store.ts:675-706`）会静默吞掉它。纯内存去重无法跨重启区分这两段；反过来若直接使用每次启动时间，又会在同一段的每次重启重复告警。

   **Why it matters:** 这破坏了 B 明确要求的“一段停更一条告警”：不是 at-least-once，也不是 per-episode exactly-once。计划中的“恢复后新一段再告一次”测试若只用非空新 `observedAt`，会漏掉这个故障形状。

   **Suggested fix:** 持久化 stale episode 状态，而不只从当前 JSON 推导 eventId。fresh→stale 转换时创建并保存一次 episode id（或 durable episode-start），持续 stale 与重启复用它；观测真正推进后关闭该 episode，下一次转换再生成新 id。测试必须覆盖：初始 `never` 告警 → fresh 恢复 → store 删除/损坏 → Bridge 重启 → 第二条告警；以及同一 stale 段连续重启仍只有一条。

4. **ADVISORY — “刷新 Promise 成功”不等于有账号读数成功，`lastError` 需要一个明确的数据契约。**

   **Issue:** observer 对单 slot 失败会 carry 旧读数并以 `note=read_failed/deadline/inventory_unavailable/...` 正常 resolve，最后仍返回一个新 `generatedAt` store（`codex-accounts-observer.ts:349-370, 445-467`）；现有 refresher 只返回 `{generatedAt, accountCount}`（`account-quota-refresh.ts:62-65`）。计划给 scheduler 的 `refresh(): Promise<unknown>` 只能可靠看到 transport rejection，无法定义告警中“最近一次失败”在“整轮 resolve 但零 `observedAt` 推进”时是什么。

   **Why it matters:** 停更告警仍会触发，但可能携带空值、上一次错误或误导性的成功状态，降低诊断价值。

   **Suggested fix:** 给 Codex refresh 返回受限结果，例如 `latestObservedAtBefore/After`、`advancedCount` 和 allowlisted `failureCode`；至少明确零推进时使用稳定 code（如 `no_observation_advanced`），并规定 scheduler 自身所有 fire-and-forget rejection/enqueue 异常都被捕获和记录，不能形成 unhandled rejection。增加“所有 slot carry、Promise resolve”的测试。

5. **ADVISORY — 把 Codex 的 30 分钟阈值贯通到 view，而不只改 capacity 投影。**

   **Issue:** 当前 `buildAccountQuotaView` 明确把 Claude 的阈值传给 Codex（`account-quota-view.ts:1098-1105`）；当前 capacity 也给 Claude/Codex 共用同一 `staleAfterMinutes`（`capacity-snapshot.ts:823-844`）。计划写了 Codex block 固定 30，但没有点名这个 consumer seam。

   **Why it matters:** 百分比可因新 projection 先置空而看似正确，但 view 内仍会用错误阈值计算 Codex 的 field-level stale 状态，后续字段或 warning 很容易再次漂移。

   **Suggested fix:** 切片 2 明列 `buildAccountQuotaView` 改用并校验 `quota.codex.staleAfterMinutes`；测试把 Claude 阈值设为 120、Codex 设为 30，用 35 分钟读数证明二者不会串线。

6. **ADVISORY — selector delta 要补 capacity-guard replay 的显式回归，而不只依赖结果恰好不变的旧测试。**

   **Issue:** `hasCurrentCapacityGuard` 会把 durable evidence 原样重放进同一个 selector（`codex-quota-store.ts:1588-1633`）。研究指出现有 “after reset elapsed” 用例在改前后都只断言 `false`，因此它不能证明新路径确实是 `reset_elapsed → selected`，也不能防止未来把 mixed-window 形状误放宽。

   **Why it matters:** 这是 launch/admission 的安全守卫；selector 改动的 blast radius 不限于 rotate。

   **Suggested fix:** 在 `StateStore.codex-quota.test.ts` 增加表驱动 replay：所有 100% 窗口已过 reset 时 guard 解除；仍有未来 100% 窗口时不得成为 reset-elapsed candidate；非 100% 的过去 reset 仍 fail closed；新增/换身份的 pool member 语义保持不变。

7. **ADVISORY — 锁定手动 outbox payload 的编码和降级/重放测试。**

   **Issue:** 自动通知当前把 `notification` 存成 JSON string，generic outbox 分支也只接收 string（`codex-quota-store.ts:581-588`，`outbox.ts:225-271`）；计划第 103 行给出的手动 payload 看起来是对象。单独分支可以支持对象，但计划未锁定 durable schema，也未明确它必须在 `incident_id` 通用解析前处理。

   **Why it matters:** 若实现沿用通用解析，NULL incident 行会退化或永久 pending；若两种编码混用，重放和历史兼容会变得含糊。

   **Suggested fix:** 明确 manual payload 是结构化对象还是同样的 bounded JSON string，并在 parser 中只接受一种规范形态；测试 NULL incident、外部 generation 身份不符、malformed snapshot 降级、投递后进程重启不重复，以及 `getExternalGeneration` 不匹配时只保留已核验 profile/n/a。

## Verdict

CHANGES REQUESTED

请先修订 3 个阻断契约：让 A/D 脱离 auto-switch runtime 旗标、拒绝未来 observation、为 stale episode 建立可跨重启且可在恢复后重新开启的 durable identity。其余建议可在同次计划修订中补入测试与接线清单；readiness 的 6 个生产 blocker 继续保持明确 out of scope。
