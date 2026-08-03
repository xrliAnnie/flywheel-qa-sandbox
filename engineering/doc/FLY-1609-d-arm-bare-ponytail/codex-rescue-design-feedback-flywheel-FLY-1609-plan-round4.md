# Design Review — plan.md (FLY-1609, Round 4)

Date: 2026-08-03
Author: Codex
Status: APPROVED

## Summary

Round 4 已关闭 Round 3 的两个剩余阻塞：retry 现在有可实现的双份 carrier，并由唯一掌握最终 mode 的 Blueprint 决定 frozen arm 与 fresh signal；kill 合同也已收窄为只停止 arm-derived ponytail，不误伤独立 FLY-615 信号。结合前三轮已补齐的 ladder、assembly、归因、分析、CI、运维和持久化边界，本计划可按当前架构实施。

## What's Good (Keep)

- `ponytailRetry: { frozen?, freshSignal }` 明确解决了互斥 `PonytailInput` 无法同时保存 frozen arm 与 kill fallback 的问题；ownership 顺序正确：actions 采集事实，RetryRequest/RunDispatcher 只透传，Blueprint 在最终 mode 已知后决策。
- 计划准确指出 `retry-dispatcher.ts:41-142` 的 `RetryRequest` 当前没有 ponytail 字段，且 :286-290 的 `ponytailInput` 属于 `StartRequest`、不能误当现成 retry seam；实施位点和类型边界现在无歧义。
- `freshSignal` 的信任语义完整：只有本次 fresh fetch 成功才 readable；无 key、fetch failure 或 carrier 缺失均 fail-closed 为 unreadable，stored labels 不参与伪造可信读取。
- kill 行为矩阵现在精确：signal-less D predecessor → A + `off:default`；真实 label/project 信号可得到 A + `on:label` / `on:project`；所有路径都禁止残留 `on:arm`。
- retry 测试落在最终 envelope/adapter 行为，并覆盖 D frozen、readiness 重探、`off:run`、kill、selector/conflict reresolve、refresh 成功无 labels 以及 freshSignal 缺失，能够抓住删线和错误 ownership 的变异。
- 四值 bucket、`skillAssemblyBaseArm` 全 assembly seam、C-arm exact sentinel、D effective eligibility、强制 rollout epoch、SQLite self-test、显式 CI step，以及 StateStore/event-route/DirectEventSink round-trip 共同形成了完整验收链。
- 未新增 feature flag、持久化列或插件机制；对 founder 要验证“是否过度工程”的实验而言，生产改动保持在必要边界内。

## Issues & Recommendations

1. **无阻塞问题。** 实施时保持 `ponytailRetry` 为 retry 专用 carrier，不要把最终 mode 判断前移到 actions/RunDispatcher；按 Task 3b 的最终行为测试和全仓 build/test 门验证即可。

## Verdict

APPROVED — ready to implement
