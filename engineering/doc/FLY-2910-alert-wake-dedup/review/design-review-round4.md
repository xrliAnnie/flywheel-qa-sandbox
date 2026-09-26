# Design Review — plan.md (Round 4)
Date: 2026-09-25
Author: Codex (gpt-6-astra)
Status: APPROVED

## Summary

本轮按 Engineering Lead 授权，仅验证 R3 的跨代严重级别证据和逐 delivery 幂等两项。两项均在设计合同层面关闭，未发现本轮范围内的 BLOCKER/HIGH。

Reviewed head：`0aa3924523d440d72e6a3e2841df411445b9f873`；修订来自 `d6143f837`；plan SHA-256：`67f18808da94d69a3b57edeaaf4fbfe4433d0040c5533a7eebc3504abf55abed`。核对了 §4、§5.1 DDL、§8.2c/2d、§13 R3 记录及相关源码接口。

验证使用计划中的原始 DDL 和最小内存 SQLite 合同模型：跨代升级返回 `severity_up`；A、B 两种 carrier 的重复回调均只累计两个 delivery；事务内异常使标记和计数一起回滚，重试只记一次。命令退出 0。这不代表生产实现测试已完成；未运行 TypeScript 套件，未修改源码或生产数据库。

## What's Good (Keep)

- 严重级别证据与工单代次一同更新，同代才取最大值，固定窗口保持不变。
- 复用 `alert_wake_letter` 保存逐 delivery 标记，标记和计数同事务提交；删除单一的 `last_recorded_delivery_id`。
- §8.2c/2d 已直接覆盖 R3 的两个反例，保留为实施验收用例。

## Issues & Recommendations

1. **R3 #1：已关闭。** §4（139–143 行）明确换代时将 `max_severity` 重建为本行级别。因此 G1 severe → G2 warning 送达后，状态为 G2/warning；随后 G2 severe 命中 `severity_up`。§8.2d（290 行）与此一致，最小合同模型已验证。

2. **R3 #2：已关闭。** §4（133–138 行）将 A 类条件 UPDATE、B 类 INSERT OR IGNORE 的单行成功结果作为计数前置条件，并要求与计数更新处于同一个 StateStore 事务。§5.1（204–210 行）的主键和可空关联列支持两条路径。回调 A→B→A→B 的变更数为 1、1、0、0，最终 occurrences=2；事务异常也不会留下“已标记但未计数”的半完成状态。现有 `StateStore.ts:718–764` 提供受影响行数和事务接口，现有回执→逐行钩子→queue 落账顺序（`lead-inbox-loop.ts:524–535`）无需改变。§8.2c（289 行）已覆盖完整冻结批次重投。

## Non-blocking advisories (follow-up)

无新增 MEDIUM/LOW 项。

## Verdict

APPROVED

R3 两项设计缺陷已关闭，可进入实施；本次结论限于授权的两项修正。
