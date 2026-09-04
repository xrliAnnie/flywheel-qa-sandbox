# FLY-2229 切号冷却降级 — 实施计划
Issue: FLY-2229 (https://linear.app/geoforge3d/issue/FLY-2229/切号死锁-switch-cooldown-让唯一可切目标变成-no-targetschoolpersonal-切换-30-分钟后)
日期: 2026-09-04
基于: research.md

## 目标

当常规候选扫描得到 `no_target`，且唯一被选中的恢复目标其 cooldown 窗口与 source 的主导阻塞窗口不同时，quota daemon 应只对这个单一目标做一次 live verification，并在验证通过后执行受限的 `cooldown_fallback` 切回。若不满足该窄条件，daemon 必须明确告警 `no_target: all keys unusable, founder action needed`，不得静默停摆。

账号级 cooldown 继续是 anti-thrash 硬门，而不是常规候选的排序惩罚。全局最小切换间隔及其它 fail-closed guard 不变。

## 非目标

- 不把 cooldown 降级为全局排序惩罚，也不建立四档候选排序。
- 不改变 cooldown 的写入时长或 store schema。
- 不改变全局 `minSwitchIntervalMinutes`。
- 不放宽 OAuth freshness、身份、quota、model bench 或 active-witness 约束。
- 不改变手动 `use` / `next` 或 account repair 的选择策略。
- 不处理 FLY-2109 的 live runner 账号接续问题。

## 设计 R1 后的锁定收窄

本计划以 Lead 对设计 R1 的裁定覆盖 research.md 中的四档排序方案：

1. 常规扫描仍使用 `cooldownPolicy: "exclude"`，遇到任一正常可执行候选时绝不考虑 cooldown 账号。
2. monitor 从已经解析、校验并用于日志的结构化 usage 数值计算窗口：`dominantWindow(usage) = usage.sevenD.pct >= 100 ? "7d" : "5h"`。因此 source 的 `triggerScope` 为 `weekly` 或 `both` 时都得到 7d；不得按字面 `scope === "weekly"` 判断。
3. 常规扫描为空且没有 pending model detection 时，从 panorama 的类型化 `excludedBy === "cooldown"` 选择候选，不匹配 `status` 文案。允许候选数 `>= 1`；用 store 中已解析的 `observedSevenDPct` 从低到高选一个，缺失/非有限值排最后，再按账号名稳定破平。这里只确定一个目标，不进行任何 credential/quota I/O。
4. 第二次扫描用 `onlyNames: [fallback]` 与新的显式 selector policy，对选中的账号恰好执行一次 freshness/credential 检查和一次 live usage refresh；不得扫描全部 cooldown 账号。用这次 refresh 返回的结构化 usage 计算 `cooledWindow(target) = dominantWindow(targetUsage)`，当 `cooledWindow(target) === dominantWindow(source)` 时明确拒绝，仅在两者不同时录取。窗口来源不再比较 `switchCooldownUntil`、`weeklyResetAt` 或其它 raw reset 字符串。
5. selector 以结构化 `cooldownFallbacks` 输出铸造一次性豁免。monitor/executor 不从 panorama status 文案反推权限。
6. fallback 仍须通过 pool/store、auth、identity、model bench、active witness、OAuth freshness、credential、实时 5h/7d quota 与 reset 校验。缺失、非法或歧义数据一律 fail closed。
7. fallback 必须在 `openBlockedEpisode` 之前完成；只有 fallback 被拒或执行失败才打开 blocked episode。成功 tick 不得先发 severe `quota_no_target` 再发 recovery。
8. quota 与 model detection 同时存在时不尝试 fallback，也不调用 executor/Keychain；本 tick 明确告警 `deferred: model detection pending`，把 fallback 延后到无 pending model detection 的下一 tick。不得在 destructive switch 后进入 `finalizeModelSwitchIncident`。
9. `account-switch-notification.ts::formatSwitchNotification` 新增显式 fallback copy plumbing，由 `SwitchNotificationContext` 传入被豁免名称，成功通知写 `cooldown fallback to <name>`。
10. 新建一个 token-safe `buildNoTargetBody` helper，首告警传给 `openBlockedEpisode` 的 bodyOverride 与 `quota-monitor.ts::attemptBlockedDelivery` 的 blocked 默认分支都只调用这个 helper。为让重启后的重告警保留现场，`BlockedEpisode` 以可选、向后兼容字段持久化本轮 fallback name/reason/detail；首告警和重告警都包含 `no_target: all keys unusable, founder action needed`，若挑中过目标还包含 `fallback tried=<name>; refused=<reason>`。recovered 文案不变。

## TDD 实施步骤

### 1. 单目标 fallback selector：红 → 绿 → 重构

在 `src/__tests__/account-candidate-selector.test.ts` 先加入失败用例：

- 默认与 `cooldownPolicy: "exclude"` 继续在 freshness I/O 前硬排除 cooldown 账号；
- 新的显式 fallback policy 只有配合单一 `onlyNames` 且传入 source `dominantWindow` 才能绕过 cooldown，否则 fail closed；
- 目标 live verification 成功且 live `cooledWindow` 与 source 主导窗口不同时进入 `ranked`，并在结构化输出中得到 `cooldownFallbacks: [name]`；同为 5h-hot 等同窗口场景必须返回明确的结构化 refusal reason；
- panorama 标记 `bypassed.cooldown=true` 与明确的 `qualified_cooldown_fallback`（低 headroom 对应明确变体）；
- fallback 不得覆盖 freshness、auth、quota、model、pool 或 active-witness 排除，失败时 `cooldownFallbacks` 为空。

确认红灯后，在 `account-candidate-selector.ts` 增加仅供单目标二次扫描使用的显式 policy、基于结构化 usage 的窗口比较与 `cooldownFallbacks` 输出。常规排序仍只有正常/低 headroom 两档；默认、`exclude`、`ignore_explicit_target` 行为保持兼容。加一条 source 与 target 都为 5h-hot 的负向用例，断言不录取并返回明确的 same-window reason；raw reset 字符串故意指向相反结论，证明判定只服从结构化数值。

### 2. 执行器窄豁免：红 → 绿 → 重构

在 `src/__tests__/switch-executor.test.ts` 先加入失败用例：7d-dominant quota trigger（`weekly` 或 `both`）携带本轮 selector 输出的单一 `cooldownFallbacks` 时可选择 `preferredOrder` 中的冷却目标；没有该字段时仍返回 `no_account`。再加负向用例锁定：

- manual trigger 不得使用自动 fallback 字段；
- `scope: "5h"` 与 repair trigger 不得使用该字段；
- fallback 必须恰有一个名称且属于 `preferredOrder`；
- 必须有 `quotaPreverified=true` 与有效 `verifiedAt`；
- auth/model/quota 新事实与 executor 锁内重读仍可否决目标。

确认红灯后，在现有共享 `SwitchInputBase` 增加可选的一次性 `cooldownFallbacks`，不拆分或重构 union；真正的权限边界是 executor 的运行时 trigger/字段校验。校验通过后仅把该单一名称映射为 `SelectInput.eligibilityOverrides.ignoreCooldown=true`。新增专用 `invalid_cooldown_fallbacks` failure code，避免把自动输入错误伪装成 manual override 错误。`attemptSwitchWithDriftRecovery` 重试时必须用已收窄的 `preferredOrder` 同步求交 `cooldownFallbacks`，不得把旧集合原样扩散到 drift 后的候选集。

### 3. daemon 验收闭环：红 → 绿 → 重构

在 `src/__tests__/quota-monitor.test.ts` 写出 issue 的完整两次 tick 顺序：

- 第一次 school 因 5h 达阈值切到 personal，并写下源自 5h reset 的 cooldown；
- 30 分钟后 active personal 的 5h=94%、7d=100%，明确覆盖 `triggerScope="both"` 与 7d-dominant；
- school 仍有 cooldown，live usage 为 5h=93%、7d=33%，明确覆盖 5h-dominant target；
- business 也带 cooldown 但 store 的 `observedSevenDPct` 高于 school，另有其它候选 freshness stale/auth unavailable；
- 全局 `lastSwitchAt` 已越过最小间隔。

先确认第二次 tick 的当前结果是 `no_target` 且未调用第二次 switch。然后在常规扫描为空时，按类型化 exclusion 与最低 7d/账号名规则只挑 school，刷新并 probe 一次，再把其结构化 `cooldownFallbacks` 传给 executor。该尝试发生在 `openBlockedEpisode` 之前。预期第二次结果改为 `switched`，并断言：

- school 只接受一次 fallback freshness 与 live usage 校验，其它 cooldown 账号没有被 probe；
- `preferredOrder=["school"]`；
- `cooldownFallbacks` 只包含 school；
- decision log 的 selected 为 school，panorama 不泄漏 token；
- committed switch 通知包含 `cooldown fallback to school`；
- 成功 tick 没有发送 `quota_no_target` 或同 tick recovery alert。

再写负向验收：source/target 都是 5h-hot（同时让 raw reset 字符串故意指向相反结论）、没有 cooldown exclusion、或单目标 live verification 失败时均不豁免；结果保持 `no_target`，explicit refusal reason 可见。若 probe 失败，首告警必须包含 `fallback tried=<name>; refused=<reason>` 与 token-safe panorama。推进时间超过 `episodeRealertMinutes`、模拟 state reload 后再 tick，断言 `attemptBlockedDelivery` 的无 override 重告警仍由同一 helper 生成并保留 candidate/reason。

增加 model-coexistence 矩阵：active source 同时有 quota trigger 与 pending model detection、常规候选为空且 cooldown fallback 看似可用时，结果为 `no_target`，告警含 `deferred: model detection pending`，executor/Keychain 零调用，store generation、`lastSwitchAt`、`reviveEpoch` 不变，`pendingDetection` 保留给后续 tick。

### 4. 定向回归与静态验证

按 Lead 指令只运行 `flywheel-teamlead` 单 package，固定：

```bash
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-candidate-selector.test.ts
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/switch-executor.test.ts
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/quota-monitor.test.ts
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-switch-notification.test.ts src/__tests__/quota-monitor-alert.test.ts
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/quota-monitor-state.test.ts
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/account-switch-cli.test.ts src/__tests__/account-switch-repair.test.ts
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-teamlead build
```

最后按 implementation node 合同运行 `pnpm lint` 与 `pnpm -r build`。裸 `pnpm test:packages:run` 已确认会收集真实 GUI 用例，禁止执行；用以下等价的全 package 两段式命令无条件排除 `packages/core/test/tmux-viewer.macos.test.ts`：

```bash
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter './packages/*' --filter '!flywheel-core' test:run
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-core exec vitest run --passWithNoTests --exclude test/tmux-viewer.macos.test.ts
```

所有 vitest 固定单线程。PR exact head 的 GitHub checks 作为另一份全仓证据。

### 5. 早开 PR、代码评审与交付

1. 文档与首批测试/实现形成小提交后 push，并尽早创建对 main 的 PR；PR body 必含 Linear 链接与 test plan。
2. 在 code review 前更新进度账本；通过 `codex:rescue` 启动代码评审，并按注入协议注册 `review_code` gate。
3. 评审进行中冻结 push；如有 blocking findings，批量修复后单次 push，再开新 gate/request。
4. 评审 APPROVED 后不再运行会提交 progress 的命令，也不 push docs-only commit。
5. `engineering/doc/milestones/FLY-2229.md` 必须是批准前最后一个本地提交；批准后的说明只改 PR body。
6. 检查 PR exact head CI，报告 Lead 指令完成情况，最后执行 `complete --route needs_review --pr <NUMBER>`；不 dispatch QA、不 merge、不 deploy。

## 完成判据

- issue 的 A(5h)→B、B(7d)→A-cooldown 两 tick 场景测试从红到绿，最终 `outcome=switched`，通知明确标出 cooldown fallback。
- cooldown 继续是常规扫描的硬 anti-thrash 门；只有 source/target 主导窗口不同、无 pending model detection 的单目标 `no_target` 分支可获得一次性豁免；生产正向路径是 7d-dominant source（`weekly` 或 `both`）→ 5h-dominant target。
- stale/auth/quota/model/active-witness 负向 guard 保持 fail-closed。
- 同维度或无法 live-verify 时明确告警 `no_target: all keys unusable, founder action needed`，重告警也保持该文案。
- `account-switch-cli.test.ts` 与 `account-switch-repair.test.ts` 证明手动与 repair 路径回归不变。
- package tests、typecheck、build 通过，PR exact head CI 无阻塞红项，code review verdict 为 APPROVED。
