# Design Review — FLY-1716 plan.md (Round 9)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

r9 已正确关闭 Round 8 的三项意见：winner 现在绑定实际 70–80% 占用并要求 telemetry 归因，旧的“死开关”/pointer 合同已清除，E4 也有合法的预算不足终态。计划只剩一个 model-tier correctness 缺口：E3 在 200k 上得到的固定 token-window winner 不能原值推广或原样验证到 1M，而当前 amendment/E4 还没有钉死这条隔离边界。

## What's Good (Keep)

- 保留 winner 的四重 authority：无手动 compact、compact boundary + ctx drop、实际 pre-compact 占用在真实 model window 的 70–80%、debug/telemetry 证明不是 reactive-first。
- 保留 `works_outside_target` 独立结论态，以及所有 window 尝试值预登记、允许基于首轮实测校准但禁止 post-hoc cherry-picking。
- 保留 fresh isolated config/session、固定 binary/model/account/prefix/load 和 fresh-session 重复至少两次的实验纪律。
- 保留 winner 先进入 plan amendment，写清 key/value/scope/version/rollout/rollback/tests 后才允许部署。
- 保留 E4 的显式授权边界：Runner 不得自批成本，未获数值批准即 `inconclusive_budget_not_approved`，且不得把未运行的实验报作通过。
- B 的简化 keyed claim、gen fence、共享 authority lock、manual `/clear` write-back/adopt/bootstrap 仍完整自洽；active plan 已无 pointer/seq/actionId 残留。
- Knife C 仍正确保持 out-of-scope，FLY-1764 的 ordinary-Lead broadcast 删除结论没有被重新扩成代码任务。

## Issues & Recommendations

1. **[HIGH] winner 和 rollout scope 必须绑定 model tier；E4 不能把 200k 的固定 window 值原样套到 1M。** 若 E3b 的 winner 是 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=140000`，在 200k 上它接近目标区间，但对 `[1m]` 是约 14% 的 effective cap，减去 summary buffer 后还会更早 compact；“E4 重跑 winner 配置”因此必然测试错目标，若后续 amendment 只写 workspace/global scope，也可能把该值错误推广给 1M Lead。请把 winner identity 扩为 `{binaryVersion, modelId/modelWindow, key, value}`，把 amendment scope 从 workspace/global 扩为同时包含 model tier。E4 对固定-token window winner 应预登记一个 1M-specific candidate（按 70–80% 目标及 summary buffer 校准），而不是复用 140000；仍按实际 trigger occupancy 判 winner。V6/rollout 合同明确：只有 E4 在 1M 上重复 ≥2 次得到 in-band winner，配置才可覆盖 `[1m]`；`inconclusive_budget_not_approved`、failed 或 `works_outside_target` 时，任何 200k winner 只能进入 200k-only amendment，1M 保持未配置。增加 launcher 测试，断言 model resolver 对 200k/1M 选择各自批准值，绝不把 200k 固定 window 泄漏到 1M。

## Verdict

CHANGES REQUESTED — address item above
