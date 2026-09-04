# FLY-2229 切号冷却降级 — 调研
Issue: FLY-2229 (https://linear.app/geoforge3d/issue/FLY-2229/切号死锁-switch-cooldown-让唯一可切目标变成-no-targetschoolpersonal-切换-30-分钟后)
日期: 2026-09-04
基于: exploration.md

## 1. 当前生产路径

`quota-monitor.ts::pollOnce` 的相关顺序是：

1. live 读取 active account 的 5h/7d 用量并确定 trigger scope；
2. 先用 `state.lastSwitchAt + minSwitchIntervalMinutes` 执行全局短防抖；
3. `verifyAndRankCandidates` 调用共享 `account-candidate-selector.ts`，当前固定传 `cooldownPolicy: "exclude"`；
4. 把 `ranked` 作为 `preferredOrder` 交给 `switch-executor.ts`；
5. executor 在 account lock 内重读 store，并用 `account-store.ts::selectNextAccount` 再做一次 eligibility 判断。

第 2 步没有造成 2026-09-01 的 `no_target`：日志 panorama 明确出现 `school:switch_cooldown`，说明 tick 已进入候选扫描。真正死锁来自第 3、5 步的账号级 cooldown 双重硬过滤。

## 2. 候选选择器合同

`verifyAndRankCandidates` 当前依次守卫：

- store/pool 交集；
- identity mismatch 与 auth flags；
- switch cooldown；
- model bench；
- lock 内 active witness 不变；
- OAuth freshness；
- credential 存在；
- live usage 获取成功；
- 5h 与 7d 均低于 100%；
- reset instant 可排序。

之后候选分为正常 headroom 与 5h 已过 trigger 但未耗尽两档。只有正常档为空时才选择低 headroom 档。当前 cooldown 检查在 freshness 之前 `continue`，所以 daemon 不知道冷却账号此刻究竟是可执行目标还是死钥匙。

共享选择器还服务：

- 手动 `use`：`ignore_explicit_target`，仅单一显式目标可绕 cooldown；
- 手动 `next`：`exclude`；
- account repair：`exclude`；
- quota daemon：`exclude`。

因此默认行为不能全局改成 fallback；应新增显式策略，仅 quota daemon 采用。

## 3. 执行器合同

`SwitchInput` 允许 `preferredOrder` 与 `verifiedAt`，但 `account-store.ts::selectNextAccount` 明确规定：live verification 可覆盖旧 quota fact，不能覆盖 cooldown，除非 `eligibilityOverrides[name].ignoreCooldown` 为真。

现有 override 只从 `manualOverrides` 进入，且 executor 会拒绝非 manual trigger 携带它。这条安全边界应保留。自动 fallback 需要独立字段，并满足：

- 只允许 quota/model 自动触发；
- 账号必须同时出现在 `preferredOrder`；
- 必须携带成功的 live verification 时间；
- 只绕过 cooldown，不绕过 auth、model、quota 或 freshness；
- executor 锁内仍重读 store，并保留所有其它 guard。

## 4. 排序矩阵

为了满足“冷却是排序惩罚、仅无其它候选时使用”，候选优先级应为：

1. 无 cooldown，5h 低于 trigger；
2. 无 cooldown，5h 达 trigger 但低于 100%；
3. cooldown fallback，5h 低于 trigger；
4. cooldown fallback，5h 达 trigger 但低于 100%。

每一档内部继续按 weekly reset 从早到晚、再按账号名稳定排序。这样任一无冷却可执行账号都会压过冷却账号，同时在唯一可用目标处于 cooldown 时仍有结果。

## 5. 可观测性与失败面

- fallback 候选在 panorama 标记 `qualified_cooldown_fallback` 或 `qualified_low_headroom_cooldown_fallback`，并保留 `bypassed.cooldown=true`，使日志/通知可审计。
- 如果 cooldown 候选 freshness stale、usage network、quota exhausted 或 model benched，它仍按真实原因排除；现有 `openBlockedEpisode` 继续发送 `quota_no_target` severe alert，不会伪造切换成功。
- 若 selector 已给出 fallback，但 executor 锁内观察到新的 auth/model/quota 状态，executor 返回 `no_account`，既有 switch failure/no-target episode 负责告警。

## 6. 回归测试范围

单 package `flywheel-teamlead`：

- selector 单测：无冷却候选优先；无其它候选时 live 验证并排序 cooldown；冷却候选不绕过 stale/quota/model；低 headroom 分档顺序。
- executor 单测：自动 fallback override 仅对排序内目标生效；非法 trigger/非法目标 fail-closed。
- daemon 验收测试：school 在 cooldown、personal 7d=100%、其余 freshness stale 时，tick 调用 switch，传递窄 override，返回 `switched`；反向无 override 应保持红灯。

所有测试使用 `VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1`，不运行 packages-wide 套件，并排除 `packages/core/test/tmux-viewer.macos.test.ts`。
