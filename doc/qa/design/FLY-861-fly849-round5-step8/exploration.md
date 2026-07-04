# Exploration: FLY-849 Round 5 Marker — FLY-859 Step 8 Verification — FLY-861

**Issue**: FLY-861 (QA·FLY-849 harness round 5 — verify FLY-859 Step 8: QA-PASS self-ship gate + full finalization)
**Date**: 2026-07-04
**Status**: Complete
**Pipeline**: 3-stage (Design → Implement → QA) on shared branch `project-slot-2-FLY-861`

## Problem

FLY-861 是 FLY-849 combined-batch QA 的第 5 轮 harness issue。**交付物本身刻意琐碎**（一个 2 行 marker 文件）——本轮验证的是链路而非内容：

1. 真实多模型三阶段接力（Design=Fable → Implement=Opus → QA=Sonnet），zero-simulation full-auto；
2. **FLY-859 Step 8 新行为**：QA 阶段 PASS 后自持久化 founder ship gate（挂在 QA phase 自身而非 Implement phase）→ approve → QA phase 自 ship → auto-finalization（Implement + QA 两 phase tmux 自关、archived Discord thread 保持 archived）。

combined 分支 `qa/fly849-793-batch-combined` 本轮新增 FLY-856（PR #442，resolveLeadId fix）+ FLY-859 Step 8（PR #443，ThreeStageQaCoordinator）在 793+795+799+cmux 之上；共享分支 `project-slot-2-FLY-861` 已确认以其为祖先（`git merge-base --is-ancestor` ✓）。

**Sandbox-only**：remote 已核验为 `xrliAnnie/flywheel-qa-sandbox`（非生产仓）。

## 交付物要求（issue 原文）

新建 `doc/qa/harness/FLY-849-round5-marker.md`：

- 一行标题：`# FLY-849 round 5 marker`
- 一句话注明这是 FLY-859 Step 8 verification round（Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation）

Acceptance：文件存在且标题正确；PR 开向 `qa/fly849-793-batch-combined`（sandbox mirror），本轮交付物 bucket 仅此单文件。

## Options Considered

### Option A: 极简确定性 marker（推荐 ✅，Lead 已批）

恰两行内容（标题 + 一句话），内容字节级钉死在 plan 中，Implement/QA 可逐字核验。

- ✅ harness 验链路不验内容 —— 零 diff 噪音
- ✅ 确定性：QA 阶段可 byte-for-byte 复核，无时间戳/exec-id 类非确定输入
- ✅ 与 acceptance criteria 逐字对齐

### Option B: metadata 丰富的 marker（exec id、时间戳、commit SHA 表）

- ❌ diff 噪音；时间戳/exec-id 引入非确定性，QA 无法钉死预期
- ❌ acceptance 只要求标题 + 一句话，多余内容是 scope 蔓延

### Option C: 简单任务跳过设计文档（doc tier none 形态）

- ❌ 三阶段 Design 阶段契约明确要求 commit exploration/research/plan + progress.md
- ❌ 本轮恰恰在看全链闭合，设计文档是可观测链路的一部分

## Decision

**Option A**。brainstorm 硬门已过：Lead（flywheel-test-2）明确批准，四点全部确认——极简两行、PR base、doc/qa/design/ 布局、"single file added" 指交付物 bucket 单文件（共享累积分支的 PR 总 diff 天然含设计文档 + 已合入的 FLY-856/859 内容，是 pipeline 固有形态）。marker 路径与 round4 命名一致。
