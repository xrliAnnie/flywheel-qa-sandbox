# Exploration: S6 retry — Product-Test label routing evidence design — FLY-145

**Issue**: FLY-145 ([QA-FLY-127 sandbox] S6 retry — Product-Test)
**Date**: 2026-08-29
**Status**: Complete
**Phase**: eng_design (DAG node, shared branch `project-slot-2-FLY-145`, open PR #19)

## 1. 问题定义

FLY-145 是 QA-FLY-127 生产镜像多 Lead 矩阵测试中 **S6 场景的 retry 靶标 issue**。
S6 验证：当一个 issue 带 `Product-Test` 标签时：

- **应当**：只有 `flywheel-test-2`（product-lead-test 角色）认领（claim）并 spawn Runner；
- **不应当**：`flywheel-test-1` / `flywheel-test-3` / `flywheel-test-4` 有任何反应（静默）。

约束由两层保证（defense in depth，纵深防御）：

1. **Prompt 规则层**（FLY-127 prompt rule）：每个 Lead 的 identity/prompt 声明其部门标签范围；
2. **Bridge 强制层**（PR #170，FLY-127 dept-scope check）：Bridge 在 claim 入口做部门范围校验，越界 claim 被拒绝。

本 issue 本身是 dummy issue——**不需要任何功能代码改动**。QA agent 在 cos-test 频道发布
issue 标识，Lead bots 做出（或不做出）反应，QA 收集证据。Runner pipeline 的职责是把
branch → commit → PR → review gate 走完，使 QA 能采集 S6 证据链。

## 2. 现状审计（分支继承）

本 worktree 继承 `origin/project-slot-2-FLY-145@0a3e017`，前次 dispatch 已完成
实现形态的产物：

| 产物 | 状态 |
|------|------|
| CLAUDE.md 里程碑表新增 FLY-145 行（镜像 FLY-133/134/135/138 系列格式） | ✅ commit 0a3e017d |
| PR #19（docs-only，OPEN，test plan 含 docs-only waiver） | ✅ 已创建 |
| 设计阶段产物（exploration/research/plan/design HTML） | ❌ 本节点补齐 |

时序上里程碑落档先于 design 落盘是 S6 **retry** 场景的特征：DAG 重派了 eng_design
节点，本节点在既有分支之上补齐设计产物，**不回滚、不 force-push、不改既有产物**。
与 slot-1 分支不同，本分支没有独立的 implement ledger（前次 dispatch 只落了里程碑
行 + PR）；本节点的设计 ledger 是分支上第一个 progress 游标。

## 3. 兄弟 issue 与兄弟 slot 先例

- 同系列 sandbox 里程碑 issue（FLY-133/134/135/138）均为 docs-only 里程碑记录，
  与本 issue 形态一致；FLY-138 是 S1 happy path 的记录，FLY-145 行文措辞镜像
  FLY-133/134/135 的通用格式。
- 同一 FLY-145 在 slot-1 / slot-4 分支上已有各自的 eng_design 产物
  （`doc/FLY-145-s6-retry-product-test/`）。本节点使用带 slot 后缀的目录
  `doc/FLY-145-s6-retry-product-test-slot2/`，避免多个 slot 的 PR 合入 main 时
  同名目录冲突（S6 是多 Lead 矩阵，各 slot 平行走完 pipeline 是预期形态）。

## 4. 关键设计问题（本设计要回答的）

1. **证据链结构**：S6 PASS 需要哪些证据，分别落在哪里（Discord / Bridge 日志 /
   repo 产物），稳定标识是什么？
2. **正反两向断言**：如何同时证明 "test-2 认领了" 和 "test-1/3/4 静默"（负向证据
   需要观察窗口定义，否则不可证伪）？
3. **retry 语义**：S6 retry 与首次 S6 的区别（同一分支继续 vs 重开），失败后的
   rollback 边界在哪里？
4. **清理边界**："archive after S6 PASS" 归谁执行、触发条件是什么（本节点不执行）？

## 5. 方向选择

方案 A（选定）：**沿用 FLY-138 里程碑记录模式，设计文档只补齐证据链定义**。
docs-only、零运行时风险、与兄弟 issue 一致。

方案 B（否决）：在 sandbox 中新增自动化断言脚本验证四个 Lead 的反应。
否决理由：S6 的观察面在 Discord 频道与 Bridge 日志，归 QA agent（FLY-127 campaign
owner = slot 1）所有；在靶标 issue 的 Runner 分支里写断言脚本会把 QA 职责泄漏进
被测产物，且违反 dummy issue "no actual code work" 约束。

方案 C（否决）：复用 slot-1/slot-4 的同名目录 `doc/FLY-145-s6-retry-product-test/`。
否决理由：三个 slot 的 PR 若都合入 main，同名目录下同名文件必然冲突；带 slot 后缀
的目录让每个 slot 的证据包独立可合并，符合矩阵测试"平行 pipeline"的语义。
