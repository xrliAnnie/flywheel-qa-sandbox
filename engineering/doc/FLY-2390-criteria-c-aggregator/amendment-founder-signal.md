# FLY-2390 判据 c 聚合 — 实施计划补充
Issue: FLY-2390 (https://linear.app/geoforge3d/issue/FLY-2390)
日期: 2026-09-11
基于: plan.md

Lead 对问题 d3fbd3cf-89c0-4356-80c2-d745b5dd5cf7 的裁定，依据 PRD 1098 §4 的 fail-closed 判据：founder 信号缺席必须为 unknown，不能 green。批准的 plan.md blob 不改写。

- 窗口内零 publication：增加 founder_signal_unobserved，整体 unknown；仍收集其它腿的全部理由。
- FLYWHEEL_READINESS_REPORT_CHANNEL 未配置或空白：增加 founder_channel_unset，整体 unknown，并在日报原因区呈现；不抛错。脚本无目的频道时仍不发送，评估器不得因此放行。
- 有 publication、扫描健康且无 👎 时，其他证据健康仍可 green；👎 sticky 与窗口规则不变。
- 修复 readiness-outbox-root-splits-on-flywheel-state-dir：FLYWHEEL_STATE_DIR 为 ~/.flywheel 同级根，shell 写入与 Bridge 读取统一追加 state/release-readiness。

只处理两项 HIGH；本轮 review 的 MEDIUM/LOW 继续延期，批准计划 §12 follow-ups 的边界不变。
