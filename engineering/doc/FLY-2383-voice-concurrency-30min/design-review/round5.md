# Design Review — plan.md (Round 5)

Date: 2026-09-06
Author: Codex
Status: APPROVED

## Summary

v5 已关闭 Round 4 唯一的数据 blocker，并吸收三条 minor。点名复核的 §1.1、§1.2、§1.5.1、§1.8、§3.2 现在形成一致、可执行且 fail-closed 的测量契约；没有发现仍会让有效场次数据不可采信的问题。

最关键的修正确实成立：audio/instrument eligibility 与 recognition outcome 已彻底拆开。STT 缢失、错误文本或 nonce 不匹配会作为 miss 永久留在已 audio-eligible 的分母中，不能再通过标 ineligible 被消失；ON 与 OFF 分别使用 bed-present 和 bed-absent 条件，OFF 不会再天然得到零分母。目标 N、最大总 attempts 和补打规则也都在运行前冻结，禁止补到凑出 N 个 hit。

本轮批准的是 plan v5 的设计与测量口径。实际数据仍须以计划要求的 pilot、negative control、holdout、lifecycle tests、原始 receipts 和最终 manifest 为准；批准计划不预先批准未来的实现或测量结果。

## What's Good (Keep)

- §1.8 的两个阶段正交：阶段一只看播放、音频类别、barge/cancel、sampling/clock；阶段二才判 user final 的 hit/miss。
- A 要求 confirmed bed，B 要求 confirmed bed absence；OFF 出现 bed signature 会使 classifier/negative control `INSTRUMENT_FAIL`，不会被弱化成普通 ineligible。
- `attempted / audio-eligible / hit / miss` 四项和按原因拆分的 ineligible 同时进入附录，读者可以重建分母并识别补打或样本损耗。
- 目标 N 是预先冻结的 audio-eligible playback attempts，而不是成功识别数；miss 永久留在分母，补打受预先冻结的最大 attempts 与调度规则约束。
- pre-join `voiceReadyCensus` 与 post-join `bothPresentCensus` 已分名并分别定义，不再存在 emitter 尚未 join 却要求双方同时在房的死等契约。
- SHA/dirty/dist 校验已移动到任何跨仓 import 之前，避免 drifted module 的 top-level code 先执行。
- decoder 与 PCM tap error 都有旁路监听；即使 error receipt 本身遗漏，packet/PCM progression 与秒桶空洞仍会 fail closed。
- `createPcmFrameTap`、strict seq、T0 baseline、Prism dependency anchor 和 stereo→mono 契约保持完整，没有被本轮改动回退。
- §3.2 的报告表与 §1.8 一致，且继续报告 unknown、真实可观测的断档证据、边界、作废场次和 provenance。

## Issues & Recommendations

没有 blocking issue。

实现与代码评审阶段保留两点非阻塞核对：

- 为 §1.8 加一组直接反例单测：`no transcript`、`wrong nonce`、`mismatched text` 都必须是 audio-eligible miss，且 denominator 不变；OFF 正常无 bed 的样本必须能进入分母，OFF 出现 bed signature 必须升级为整场 instrumentation failure。
- 报告生成测试应校验恒等式 `audioEligible = hit + miss`，并校验 `attempted = audioEligible + ineligible`（若实现另有明确的 aborted/instrument-fault 类别，则在 schema 中显式列出并保持总账可重建）。

## Verdict

**APPROVED**
