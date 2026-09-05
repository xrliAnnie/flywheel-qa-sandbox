# FLY-2284 slot Bridge 环境隔离 — 设计更正
Issue: FLY-2284 (https://linear.app/geoforge3d/issue/FLY-2284/529-房隔离-test-deploysh-起的-slot-bridge-继承调用-shell-全部-env包括生产-flywheel)
日期: 2026-09-04
基于: plan.md

## 权威与生效范围

`plan.md` 已在 R4 设计审查通过并固定，不再改写。本文件只把审查中的完成审计建议带入实现交接，
不改变已批准的实现范围、自动化验收门或 QA 所有权。

## 废除概念

- 不把 fly1389 的通用 200 stub、任意路径 listener 或其他 fixture 假响应记作真实 Bridge 可用性证明。
- 不把真实 Bridge 手动探针加入五条实现期自动化门，也不因当前实现机器缺少真实 slot 凭据而伪造 PASS。
- 不改动 `plan.md` 中已批准的 prerequisite-gated 手动步骤、动态环境 deny 边界或 credential 范围决定。

## 保留器官

- 实现期 GREEN 继续只由环境隔离断言证明：危险坐标被 scrub、slot 坐标被显式恢复、普通 caller
  环境与命名的 GitHub token exception 保留。
- QA 继续按 `test-slots.json` 中已获取的固定 slot，使用真实 Bridge、`--generalized --stub-runner --no-lead`
  和 bearer probe 验证 200 + `generatedAt`；trap/finally teardown 必须证明锁释放。
- 完成交接审计必须逐字记录一行 `real-Bridge manual probe: PASS`，或在前置条件不足时记录
  `real-Bridge manual probe: not run (prerequisites absent)`。本 implement 节点不代替 QA 启动外部服务。

## 审查建议原文引用

> reviewer LOW manual-probe-not-in-completion-audit

该 LOW 建议只补足完成审计的可追溯性；另一条 `missing-required-env-inventory` LOW 按 Lead 裁定维持
既有 scope decision，不触发代码或文档范围变化。
