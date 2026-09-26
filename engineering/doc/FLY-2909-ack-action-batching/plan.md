# FLY-2909 ACK 开关返工 — 实施计划
Issue: FLY-2909
日期: 2026-09-26
基于: research.md

锁定返工：lead_ack_action_batching 默认关、项目级、feature-flags 治理。关闭恢复 e10312c5a^ 的四个规则源字节和相应兼容清单；开启选择 f75e35f14 的规则副本。与 token-savings 正交。新增命名 store wrapper 与只读 launch reader，Claude/Codex 共用选择器。TDD 验证 2×2 字节、治理读写、故障关闭、Bootstrap 不变。相关测试/build/lint；推送新头并走代码评审与 needs_review。QA 负责 529 双载体真批次 ON/OFF、ACK/lease/重投/唤醒与不丢不重证据。
