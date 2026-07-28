# Design Review — plan.md (Round 6)

Date: 2026-07-27
Author: Codex
Status: APPROVED

## Summary

Round 6 已完整关闭 R5 的 1H+2M：kernel-action delegate 不再能携带 SQL，attempt observation 使用精确且 NULL-safe 的 snapshot CAS，research 与批次3 binding adapter 退役合同也已同步。结合前五轮已经锁定的 crash window、重试预算、probe/reconcile、saga、notify-then-do 与 branch-delete 护栏，本计划现已具备在批次1 kernel 地基上实施的完整性与可验证性。

## What's Good (Keep)

- `BusinessCasSpec{specKey,params}` 把动态 delegate 降为参数构造器；SQL 常量、kind→specKey allowlist 和执行权全部留在 `v2-kernel`，同时有编译期联合类型、运行期 allowlist 和 spec 逃逸 mutation 三层约束。
- canonical business effect 只允许单行 UPDATE，`changes=1/0/>1` 分别映射 granted/denied/FenceViolation；这既满足 P12 denied 零业务副作用，也保持所有写 SQL 收口 kernel 的批次1纪律。
- `attemptObservationCas` 逐字段匹配 id/generation/snapshot desired state，并用 `host_epoch IS` 覆盖 NULL；我按计划 SQL 在 SQLite 3.51.0 实测，NULL epoch 的合法 unknown 回写命中 1 行，随后 dispatched→started 的旧 snapshot 回写命中 0 行。
- command probe unknown 的 token CAS、同事务阈值升级、probe-adopt 清 streak，以及 attempt probe 的 terminal/epoch/desired-state 三类陈旧结果丢弃，现已形成完整的事务外 probe→库内 CAS 边界。
- `resolveBranchBinding` 的 1498 权威归属、v1 transitional adapter、双向 backfill 核对、adapter 删除与旧路径 fence 的先后顺序均已冻结；branch-delete“不进 manual_gate”因此仍有可执行且 fail-closed 的前提。
- R5 的旧 WriteTx delegate 文案已从 research 清除，BusinessCasSpec 与 binding resolver 接缝在 plan/research 一致；1499/1501/1498 的生产、抑制、gate、kernel-action 与 binding 所有权边界清楚。
- 补偿 command 不豁免 notify-then-do、由 planner 自动附通知依赖，以及 Discord edit/typing/pin 等表现层效果不进 outbox，这三项特别裁决均可批准。

## Issues & Recommendations

1. **无阻塞问题。** 实施时建议把 1498/1501 各自贡献的 BusinessCasSpec 常量放在 `v2-kernel` 的分域模块，再由中心 allowlist 聚合，以减少并行批次改同一文件的 merge 冲突；这不改变已冻结的所有权或协议。

## Verdict

APPROVED
