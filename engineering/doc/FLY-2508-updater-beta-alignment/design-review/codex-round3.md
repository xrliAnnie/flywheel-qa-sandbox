# Design Review — plan.md (Round 3)

Date: 2026-09-13
Author: Codex
Status: APPROVED

## Summary

Round 2 的唯一阻塞项及两条 advisory 均已在提交 `54e3a79ee31265cb95b7267b41024b7b1538dcf9` 中一致收口。当前计划在依赖归属、receipt 分支化验收、管理台标签职责和负向测试上已形成可实施且 fail-closed 的合同，可以进入实现。

## What's Good (Keep)

- FLY-2534 现在被明确写成已有 owner 的 workflow 修复和 QA 硬前置；§8、§9、§10 与 F1 口径一致，本单不修改 workflow，也不重复开单。
- `published | no_change`、`covered_by_newer`、缺失/非法 receipt 三条路径已分别定义结算和验收语义；`covered_by_newer` 使用 `occurrence.sourceCommit !== publishedSourceCommit` 这一稳定身份事实，不再依赖稍后可能变化的本机部署状态。
- 标签职责已统一：服务端只投影并校验枚举，`fleet-console-html.ts` 在客户端做固定两值映射；`research.md` 也已同步。
- compare 的业务拒绝与 GitHub 传输/schema 错误保持分层，配置 fixture、运行时装配、迁移幂等和非 vacuous 回滚测试均有明确覆盖。
- 实施和激活顺序继续尊重 #1156、FLY-2534、部署窗口与 FLY-2393 接管步骤，没有扩大到 B3、updater、workflow 或 B4。

## Issues & Recommendations (blocking)

None.

## Advisory (non-blocking)

1. §0 的 `ST → MG` 箭头和 §1 occurrence 行的“历史行显示 `主分支最新(历史)`”仍暗示管理台从 occurrence/history 取展示值；§2.4 已明确页面显示的是当前 tick 的 config 投影，而不是 active occurrence。建议实施前直接删去该箭头与“历史行显示”措辞，或将后者标成“仅数据库审计”，避免读者误解数据流；这不影响实现或验收。

## Verdict

APPROVED — ready to implement
