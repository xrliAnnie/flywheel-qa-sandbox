# Exploration: S6 retry — Product-Test label routing evidence design — FLY-145

**Issue**: FLY-145 ([QA-FLY-127 sandbox] S6 retry — Product-Test)
**Date**: 2026-08-29
**Status**: Complete
**Phase**: eng_design (DAG node, shared branch `project-slot-1-FLY-145`, open PR #56)

## 1. 问题定义

FLY-145 是 QA-FLY-127 生产镜像多 Lead 矩阵测试中 **S6 场景的 retry 靶标 issue**。
S6 验证:当一个 issue 带 `Product-Test` 标签时:

- **应当**:只有 `flywheel-test-2`(product-lead-test 角色)认领(claim)并 spawn Runner;
- **不应当**:`flywheel-test-1` / `flywheel-test-3` / `flywheel-test-4` 有任何反应(静默)。

约束由两层保证(defense in depth):

1. **Prompt 规则层**(FLY-127 prompt rule):每个 Lead 的 identity/prompt 声明其部门标签范围;
2. **Bridge 强制层**(PR #170,FLY-127 dept-scope check):Bridge 在 claim 入口做部门范围校验,越界 claim 被拒绝。

本 issue 本身是 dummy issue——**不需要任何功能代码改动**。QA agent 在 cos-test 频道发布
issue 标识,Lead bots 做出(或不做出)反应,QA 收集证据。Runner pipeline 的职责是把
branch → commit → PR → review gate 走完,使 QA 能采集 S6 证据链。

## 2. 现状审计(分支继承)

本 worktree 继承 `origin/project-slot-1-FLY-145@46cc7bc`,前次 dispatch 已完成
implement 形态的产物:

| 产物 | 状态 |
|------|------|
| CLAUDE.md 里程碑表新增 FLY-145 行(镜像 FLY-138 记录格式) | ✅ commit 4108252 |
| implement 阶段 ledger `doc/qa/FLY-145/progress.md`(cursor 2/2) | ✅ commit 46cc7bc |
| PR #56(docs-only,OPEN) | ✅ 已创建 |
| 设计阶段产物(exploration/research/plan/design HTML) | ❌ 本节点补齐 |

时序上 implement 先于 design 落盘是 S6 **retry** 场景的特征:DAG 重派了 eng_design
节点,本节点在既有分支之上补齐设计产物,**不回滚、不 force-push、不改实现产物**。

## 3. 兄弟 issue 先例

同系列 sandbox 里程碑 issue(FLY-133/134/135/138)均为 docs-only 里程碑记录 +
progress ledger,与本 issue 形态一致。FLY-138 是 S1 happy path 的记录;FLY-145
镜像其格式,场景字段改为 S6 retry / Product-Test。

## 4. 关键设计问题(本设计要回答的)

1. **证据链结构**:S6 PASS 需要哪些证据,分别落在哪里(Discord / Bridge 日志 /
   repo 产物),稳定标识是什么?
2. **正反两向断言**:如何同时证明 "test-2 认领了" 和 "test-1/3/4 静默"(负向证据
   需要观察窗口定义,否则不可证伪)?
3. **retry 语义**:S6 retry 与首次 S6 的区别(同一分支继续 vs 重开),失败后的
   rollback 边界在哪里?
4. **清理边界**:"archive after S6 PASS" 归谁执行、触发条件是什么(本节点不执行)?

## 5. 方向选择

方案 A(选定):**沿用 FLY-138 里程碑记录模式,设计文档只补齐证据链定义**。
docs-only、零运行时风险、与兄弟 issue 一致。

方案 B(否决):在 sandbox 中新增自动化断言脚本验证四个 Lead 的反应。
否决理由:S6 的观察面在 Discord 频道与 Bridge 日志,归 QA agent(FLY-127 campaign
owner = slot 1)所有;在靶标 issue 的 Runner 分支里写断言脚本会把 QA 职责泄漏进
被测产物,且违反 dummy issue "no actual code work" 约束。

方案 C(否决):把设计产物并入 `doc/qa/FLY-145/`(implement ledger 所在目录)。
否决理由:设计节点完成契约明确要求 `doc/FLY-145-<slug>/` 目录承载 founder design
HTML 与设计 ledger;implement ledger 保持原位不动,避免改写既有阶段游标。
