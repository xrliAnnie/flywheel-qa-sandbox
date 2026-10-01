# FLY-3121 Canary 传输探针 — 探索
Issue: FLY-3121 (https://linear.app/geoforge3d/issue/FLY-3121/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-phase)
日期: 2026-10-01
基于: 无

## 目标
有界的传输演练(canary):在共享 worktree 持有 TURN 时向 `probe.txt` 追加标记行、本地提交，并通过 flywheel-comm 结构化回执确认 TURN / 原生邮件。Owner: `FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c`。

## 审计
- `turn --exec-id` 返回 `yours phase=design epoch=1 node=eng_design attempt=1`。
- runner mailbox 中无针对本 exec 的消息;`inbox` 为 "No instructions"。
- 分支 `project-slot-3-FLY-3121` 基于 main,原本无 `probe.txt`。
- 任务未给出具体标记文本 → 采用自描述标记(owner + node + exec + activation + turn + UTC 时间戳)。

## 不做
产品代码、push main、ship / merge / deploy、派发后继节点。
