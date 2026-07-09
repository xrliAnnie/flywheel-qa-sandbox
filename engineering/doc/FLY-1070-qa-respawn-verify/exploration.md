# FLY-1070 替身 QA 验证 PR #528 — 探索

Issue: FLY-1070 (https://linear.app/geoforge3d/issue/FLY-1070/qa-fly-1050-独立验证-pr-528三段式死-qa-干净重生)
日期: 2026-07-09
基于: 无

## 1. 任务本质

**替身 QA**（先例：FLY-1047 / FLY-1060 模式）：父单 FLY-1050 的三段式 QA phase session（818b3587）在 14:27 OOM 事故中阵亡；父单 implement（eb8f00a6）parked 持有 ship gate 不能动。本单独立验证 PR #528 head `5da5fd18`，**不改源码、只验证、绝不 ship**。

- PASS → `qa-result --status pass --target-exec eb8f00a6-286e-4fa2-b830-37cd3054c201` + 报 [FLY-1050] thread；
- FAIL → 具体证据踢回，不发 pass。

讽刺且重要的背景：**本单验证的修复（三段式死 QA 干净重生）正是本单存在的原因**——FLY-1050 自己的 QA 死了没法重生，才需要替身 QA。#528 落地后这类情况应能自动重生。

## 2. 验证对象（PR #528 交付摘要）

- **判据改活性判定**：`hasProgressedPastImplement` 从「有 qa row 即算已交接」改为「pipeline 是否还拥有自己」——ship claim OR 活 qa row OR 最新 qa row 带 FAIL intent（fix-loop 拥有）→ skip；只剩死 row（terminated/failed/completed 无 ship claim）→ 重驱 implement→QA handoff，重生新 QA（epoch+1 经 dispatcher pre-launch seam）。
- **事件驱动定向 respawn**（`reconcileQaLoss`）：terminate action（双挂载 + cleanupPending）/ session_failed（DirectEventSink + event-route）/ crash-reaper 钩子，全部在 belt reconcile **之前**触发。
- **护栏**：cap=3 死 row → failClosed 告警不再 spawn；per-issue in-flight set；alive-row 天然幂等；复用 `onPhaseComplete` 全部现有门（边界/政策/evidence/ghost）。
- **F9（R2 增量，commit d4df18c1）**：merge-blocked implement（`merge_block_reason` marker，如 FLY-1023）永不重生 QA。
- **根因③硬化（不受逃生口控制）**：`terminated` 进 stranded-pass 告警域；活后继 QA 抑制告警。
- **逃生口**：`FLYWHEEL_THREE_STAGE_QA_RESPAWN=0` 回退旧判据 + 事件位点不重驱。
- Codex code review R1+R2 APPROVED，零 findings。CI GREEN at head。

## 3. Design 段关键发现（三条，直接塑形验证方案）

### 3.1 F8a-F8d 命名 fixtures 不在 PR head

FLY-1070 验证面 2 要求逐个验 F8a-F8d（Peter 的 3 个跨 scope 僵尸形态）。取证结果：

- head `5da5fd18` 全树 **无任何 F8 命名测试**；FLY-1050 committed plan/research 的 fixture 表只有 F1-F7（+Codex 补充项）；
- F8 系列定义在「FLY-1050 design addendum」——**该 addendum 从未落 git**（分支历史、worktree 磁盘均无），取证摘要只存于 FLY-1066 issue 描述：
  - 样本① `d2f31930`：CommDB-only 孤儿注册（CommDB 有 row：running、issue_id=NULL；StateStore **无 row**）；
  - 样本②③ `e4d3b29d` / `e90f3962`：StateStore 已终态（failed），CommDB registration 仍 running 占位；
  - F8d：scope-free 判定（Bridge 侧 reconcile 零 leadId scope 检查）。
- FLY-1066 明确边界：FLY-1050 对这些形态只需**防御正确**（不崩、不误 respawn、不算 pipeline 进展），收割归 FLY-1066。
- head 上的**部分等价覆盖**：F7（dead main-role row → reconcileQaLoss 全程 no-op）、各触点的 non-qa/main-role 哨兵测试。但 CommDB 孤儿（getSession → undefined）、issue_id 形态矩阵、scope-free 断言**无显式命名 pin**。

**QA 对策（Lead 已批）**：不假装 fixtures 存在。按 FLY-1066 记载的真实形态，在 QA 自己 worktree 写一次性验证 harness（不进 PR）驱动 head dist，逐形态断言防御正确。行为对 → PASS 附注（fixtures 固化归 FLY-1066 fast-follow）；行为错 → FAIL。

### 3.2 F10：判据缺「issue 已 Done」硬否决（生产取证已完成第一层）

生产 StateStore 只读快照取证（2026-07-09）：

| exec | issue | 形态 |
|---|---|---|
| 3f8be4bb | FLY-1023（Done） | **21:27 OOM 恢复后被新拉起的 implement session**，现 terminated，带 merge_block_reason=`merge_without_approval:review_question_unbound/qa_snapshot_missing_exempt` |
| b7d7adf1 | FLY-1047（Done） | **21:37 同型新拉起 implement**，现 terminated，无 merge_block marker |

head 判据审计：`hasProgressedPastImplement` / `tryRedriveImplementHandoff` / `reconcileQaLoss` 只consult ship claim / 活 QA / 最新 intent / merge_block —— **无任何 Linear issue 状态（Done/closed）consult**。

严谨性说明（Lead 认可）：两例真实样本**当前形态**没有 implement@awaiting_review row，严格说不是 #528 QA-respawn 路径能打到的形态（今天拉起它们的是别的机制）。但「Done issue + implement@awaiting_review + 死 qa row + 无 ship claim + 无 merge_block」这个类是真实存在的（替身 QA 模式 ship 后父单 implement 就长这样——FLY-1050 自己 ship 后 eb8f00a6 即为活标本），#528 部署后 boot reconcile 会对它重生 QA。

**QA 对策（issue 已授权）**：构造该形态 fixture 行为证明缺口 → 如实报 **FAIL-partial + fast-follow**，不阻塞主 verdict。

### 3.3 E2E 深度拍板

**Lead 拍板（brainstorm gate，2026-07-09）：module-driven 隔离 harness，批。** 理由：OOM 恢复期避 529 Room 负载；验证对象是 Bridge 编排逻辑非 runner 行为。issue 原文「行为 E2E（隔离环境）：模拟 kill」读作允许 module-driven，Lead 确认此读法正确。

**Lead 补充硬要求**：④ 的 **cap=3 failClosed 对照组必须真跑**（防无限 respawn 风暴的命门；OOM 事故刚演示过失控级联的代价）。plan 中标记为 MANDATORY，不可 skip。

## 4. 方案选项与取舍

| 决策点 | 选项 | 取舍 | 结论 |
|---|---|---|---|
| E2E 深度 | A. module-driven 隔离 harness（真 dist + 真 StateStore/CommDB + 真 router 双挂载 + fake dispatcher/probe/Discord 出口）；B. 529 Room 真 runner 三段式全链 | A 覆盖全部编排断言、零负载风险；B 多验 runner spawn 真实性但 OOM 恢复期高危、且 runner 行为非本 PR 改动面 | **A（Lead 批）** |
| F8 处理 | A. 只跑 head 既有等价测试（F7 等）宣称覆盖；B. 独立重构 4 形态行为验证 | A 是假装——CommDB 孤儿/issue_id 矩阵/scope-free 无显式 pin；B 诚实且给 FLY-1066 留下可复用取证 | **B（Lead 批，「诚实 QA 样板」）** |
| F10 处理 | A. 只做代码审计下结论；B. 审计 + 行为 fixture 实证 | 审计已明判据无 Done consult，但 QA 的信用来自行为证据 | **B** |
| 单测复跑范围 | A. 全仓 suite；B. 定向（orchestrator ×4 + 触点 ×5） | 全仓甄别 implement 已做且在 PR comment 留档（issue 明令复用别重跑） | **B** |

## 5. 验证面总览（5 面，与 issue 一一对应）

1. **单测独立复跑**：own worktree checkout `5da5fd18` → 重建 dist → 定向复跑 phase-orchestrator ×4（135 tests，含 fly1050 32）+ 触点 5 suites。host 上跑（两个 Express-router 测试要绑 127.0.0.1，sandbox 跑不了——implement 交接已注明）。
2. **回归 fixtures**：F1-F7/F9 复跑即验 + F8 四形态独立 harness（§3.1）+ FLY-1018 现场按 research 记载 DB 形态独立重构 + F9 用生产真实 marker 串验 `isMergeBlocked` 真匹配。
3. **F10**：Done-issue fixture 行为实证判据缺口（§3.2）→ FAIL-partial + fast-follow 分级报告。
4. **行为 E2E（隔离 harness）**：三事件位点分别模拟 kill 活 QA → 断言事件驱动 respawn（epoch+1、belt 一致、thread note）；**cap=3 failClosed 对照组 MANDATORY**；escape-hatch =0 对照组。
5. **全仓甄别**：复用 PR comment 结论，不重跑。

## 6. 边界（QA 纪律）

- 不改 PR 源码、不 push 任何东西到 `flywheel-FLY-1050` 分支；QA harness/一次性测试只存在于 QA 自己的 worktree 与本文件夹 evidence；
- 生产 DB（teamlead.db / comm.db）只读快照取证，绝不写；
- 不占 529 Room、不起真 runner、不重启生产 Bridge；
- 绝不 ship（ship 由父单 implement 在 verified approval 后走）；
- verdict 只有两种出口：qa-result pass（绑 eb8f00a6）或 FAIL 证据踢回。
