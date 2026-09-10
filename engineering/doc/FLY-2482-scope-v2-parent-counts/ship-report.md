# FLY-2482 scope.v2 — 实施交付报告
Issue: FLY-2482 (https://linear.app/geoforge3d/issue/FLY-2482)
日期: 2026-09-09
基于: plan.md、implementation-evidence.md

## 交付

子树不再丢 backlog；scope.v2 保留「日常」范围。items[].parent 来自 Linear，null 显式 no_parent，漂移拒绝。按批准合同，计数放在与 roots 同序的 header.root_counts Cell 数组，可由父链和子单状态重算；不增加 Epic rollup。PRD F3 已在本 PR 的设计提交中指向 §6.2 已裁定结论。

ready.v1、signals.v1、subtraction.v1 及 residual 的计算域保留非 backlog，避免页面范围扩大改变排期汇总。渲染只同步规则号/裁定文案；不做父子 UI、排序或 attention。

## 证据

冻结 Linear 2026-09-10T06:09:09Z：7 根、36 子单，parent 36/36 对齐，7 根计数逐项一致；旧规则仅保留 22 项。重放生成 HTML 469,843 B（≤524,288），200 子单容量文档 949,815 B（≤1,507,328）。快照 hash、逐根计数和可执行重放脚本在同目录。

TDD：查询 backlog/parent 红→绿 8/8；S2 相关集成 244/244；规则文案 19/19；含容量的新合同测试 37/37。lint、递归 build、teamlead typecheck exit 0。

## 门禁与限制

本地两轮 full packages 均失败：R1 config `fly1981-final-ledgers.test.ts:262` 15s 超时（786 pass / 1 fail）；R2 claude-runner `async-exec-file.test.ts` stdin 500ms 超时（1223 pass / 1 fail / 2 skip）并有 onTaskUpdate RPC error。隔离重跑分别 11/11、7/7 通过；不把它们等同于全仓通过。仅 core 真 Terminal GUI 用例按 Lead 授权排除，配置已恢复。

Lead 授权以上披露后，以 exact-head CI 14/14 作完整门禁；最终评审/CI 收据随 PR 和 Lead 报告交付。rescue 在 sandbox 创建线程失败后，Lead 指定只走 Bridge request-review。

Linear 重放的运行事实明确 missing，未读取生产 StateStore/CommDB；这不是线上固定页发布验收。sandbox 无法截图，Lead 明确把视觉确认及真实固定页 bytes/last_version 验证交 QA。

## 交接与回滚

完成精确 HEAD 评审和 CI 后走 `complete --route needs_review --pr <N>`，由 DAG 推进 QA。没有 dispatch QA、merge、deploy 或重启服务。

本单无表迁移，整 PR revert 后下一次生成回旧合同；未来消费 parent/root_counts 的渲染单上线后，回滚需一并评估。
