# FLY-2229 切号冷却降级 — 探索
Issue: FLY-2229 (https://linear.app/geoforge3d/issue/FLY-2229/切号死锁-switch-cooldown-让唯一可切目标变成-no-targetschoolpersonal-切换-30-分钟后)
日期: 2026-09-04
基于: 无

## 现象

2026-09-01 的生产链路先因 school 的 5h 用量达到阈值切到 personal，30 分钟后 personal 的 7d 用量耗尽。此时 school 的凭据和周额度仍可用，但它携带上一次切出时写入的 `switchCooldownUntil`，候选选择器把它硬排除；其余账号 freshness 校验失败，daemon 最终返回 `no_target`，直到 founder 手动切回。

## 问题定义

账号级 cooldown 的本意是排序防抖，却同时承担了硬安全门的效果。滚动 5h 与 7d 窗口不同步时，刚切出的账号可能很快成为唯一仍有可执行额度的账号。把它硬排除会把“次优但可运行”错误地降为“没有目标”。

当前链路有两道独立排除：

1. `account-candidate-selector.ts` 在 freshness 与实时 quota I/O 之前直接把冷却账号记为 `switch_cooldown`。
2. `switch-executor.ts` 内的 `selectNextAccount` 会再次按 store 中的 cooldown 过滤，即使上游把账号放入 `preferredOrder`。

只改其中一处无法形成可执行结果。

## 锁定边界

- 自动 daemon 的账号级 cooldown 改为最后一档排序惩罚；只要存在任一无冷却、live-verified、quota 可用的候选，冷却账号不得被选中。
- 冷却候选仍必须通过 pool/store、auth、identity、model bench、freshness、实时 5h/7d quota 和 reset 数据校验。
- 全局 `minSwitchIntervalMinutes` 保持原样，继续阻止短间隔连续切换。
- 手动 `use` 的显式 cooldown bypass 与手动 `next`、repair 的硬排除合同保持原样。
- 自动执行器的 cooldown 豁免必须来自本轮选择结果，且只能指向 `preferredOrder` 内的账号。

## 方案比较

### A. 只发 `quota_no_target` 告警

现有 blocked episode 已能路由 `quota_no_target`，但它仍需要 founder 人工救援，不能恢复全舰执行。它满足验收的最低告警分支，不解决已知可用目标被错误排除的问题。

### B. 清除 store 中的 cooldown 后重跑

这会把一次候选决策升级成持久状态改写，扩大竞态与恢复面；也会抹掉原始切出原因，不采用。

### C. live 验证后将 cooldown 候选作为最后一档，并给执行器一次性豁免

这是最小闭环：排序层保留防抖优先级，安全门保持不变，执行层只消费本轮选择器铸造的窄豁免。采用此方案。

## 验收场景

构造 A=school、B=personal：A 因 5h 达阈值切出并仍在账号级 cooldown；B 当前 7d=100%；其余账号 freshness stale。第二次 tick 必须 live 验证 A，并将 A 作为唯一 fallback 交给 executor，最终返回 `switched`，而不是 `no_target`。
