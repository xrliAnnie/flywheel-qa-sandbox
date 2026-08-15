# Design Review — FLY-1716 plan.md (Round 10)

Date: 2026-08-14
Author: Codex
Status: APPROVED

## Summary

r10 已关闭 Round 9 的最后一个 blocker：native-config winner、实验、amendment 和 launcher 选择现在都绑定 binary + model tier，200k 固定 window 不可能泄漏到 1M。结合前序已收口的 standalone B、founder scope cut、可归因 native 实验、override 风险披露和 FLY-1764 边界，本计划在当前架构下已可实施。

## What's Good (Keep)

- winner identity 明确为 `{binaryVersion, modelId/modelWindow, key, value}`，不再把同名配置误当作跨模型可移植结论。
- E4 对固定-token winner 使用预登记的 1M-specific candidate，并继续以真实 pre-compact occupancy 的 70–80% 区间判定，不复用 200k 的 140000。
- 1M rollout gate 足够严格：只有 1M fresh sessions 中 in-band 成功至少两次才可覆盖 `[1m]`；budget inconclusive、失败或越界时，1M 保持未配置。
- amendment scope 同时包含 workspace/global 与 model tier，且 launcher test 明确防止 200k window 泄漏到 1M。
- native 实验保留隔离配置、固定版本与负载、预登记参数、telemetry attribution、重复验证和合法 inconclusive 状态，能够形成可审计而非事后解释的结论。
- B 的 pre-resume tri-state gate、可证明占用上界、共享 authority lock/gen fence、keyed clear claim 与 manual `/clear` 接力保持独立完整，没有重新引入已裁掉的运行时泄压机械。
- override 删除按“条件有效但不可作为保证”处理，顺序、风险接受、环境留证和回滚条件均明确。
- Knife C 继续保持 out-of-scope；计划只记录 FLY-1764 已物理删除 ordinary-Lead broadcast 的核验结论，没有偷带新告警工作。

## Issues & Recommendations

1. **无阻塞项。** 实现时严格保持“实验结果先落档、winner 再走 plan amendment”的停线点；当前批准不等于预先批准任何尚未实测出的 native key/value。

## Verdict

APPROVED — ready to implement
