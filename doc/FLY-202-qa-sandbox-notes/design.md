# Design: QA Sandbox Notes Fixture — FLY-202

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Issue URL**: https://linear.app/flywheel (team FLY, fixture issue — test-slot only, 生产 Lead/Runner 不认领)
**Date**: 2026-07-23
**Status**: Complete (design node handoff)
**Node**: design（本文档是 design 节点交付物，implement 节点按此执行）

## 1. 一句话总结

在 sandbox 仓库内全新创建 `doc/qa/sandbox-notes.md`（4 个内容段落分 4 步增量写入、逐步 commit），最后对 sandbox `main` 开 PR——为 slot harness 的 real-Runner E2E 提供一个小而稳定、有 mid-work 观测窗口的多步骤任务。

## 2. 背景与约束

- 本仓库是 `xrliAnnie/flywheel-qa-sandbox`（standalone sandbox，非真 fork，靠手动同步与生产 main 对齐，见 `doc/qa/framework/sandbox-sync-guide.md`）。
- FLY-202 的存在意义：`scripts/inject-linear-issue.sh` / `POST /api/runs/start` 需要一个真实、PreHydrator 可见的 Linear issue（FLY-197 发现文档引用的 `FLY-SBX-1` 不存在，FLY-202 补位）。
- 历史上该 fixture 已多轮执行（sandbox PR #29、#30 等），每轮 E2E 重建一次 `sandbox-notes.md`。**当前分支上该文件不存在**（后续 test commit 已移除），implement 节点将全新创建，无需处理冲突。
- 硬边界：所有产物落在 sandbox clone 内；不碰生产资源；不 self-merge。

## 3. 核心流程（implement 节点执行顺序）

```
branch: project-slot-1-FLY-202 (WorktreeManager 已建好，即任务要求的 feature branch)

Step 1  创建 doc/qa/sandbox-notes.md
        └─ 段落 A: Overview（2-3 段，讲清 sandbox 仓库的用途与隔离动机） → commit
Step 2  追加 段落 B: Top-Level Directories 表
        └─ 以 implement 时的 live 仓库状态为准枚举（ls -d */ + .claude/.github/.serena），
           每行一句话描述 → commit
Step 3  追加 段落 C: packages/qa-framework/README.md 摘要（~10 bullets） → commit
Step 4  执行 `ls -R doc/ | head -50`，原样贴入 fenced code block → commit
Step 5  push 分支，`gh pr create` 对 sandbox main 开 PR（PR body 带 Linear Issue 段），
        按 Runner 完成合同上报（PR 证据），merge 交给 harness/QA，Runner 不自行 merge
```

每步一个独立 commit（`docs(FLY-202): ...`）——这正是 issue 要的 "small, steady, multi-step"：QA 在任意中间点都能观测到部分完成状态（mid-work window）。

## 4. 数据 / 结构模型

`doc/qa/sandbox-notes.md` 单文件，四段固定顺序，与任务步骤一一对应：

| 段落 | 内容 | 来源 |
|------|------|------|
| A. Overview | 2-3 段：sandbox 是什么、为何独立（real-Runner E2E 不支持 synthetic 模式，避免污染生产历史）、本文件本身即 fixture 产物 | 本 design + `doc/qa/framework/` 指南 |
| B. Top-Level Directories | 表格：每个顶层目录一行一句描述 | implement 时 live `ls`（含 `.claude/.github/.serena`；忽略 `memory.db`、`review.json`、杂散 `=` 等非目录文件） |
| C. qa-framework 摘要 | ~10 bullets | `packages/qa-framework/README.md`（316 行，注意覆盖 5-Step Protocol、Test Slot Framework/FLY-115、FLY-60 suite） |
| D. doc/ 树快照 | fenced block 内的 `ls -R doc/ | head -50` 原样输出 | implement 时实跑 |

抬头沿用既有 fixture 形态：标题 + `**Issue**: FLY-202 (...)` + `**Date**: <当日>`。

## 5. 关键取舍与被否方案

| 决策 | 选择 | 被否方案与原因 |
|------|------|----------------|
| 内容来源 | 从 **live 仓库状态**重新生成 | ❌ 直接复刻历史版本（b5f3c165）：仓库已漂移（新增 `agents/ engineering/ fleet/ product/ qa-fly294/ qa-fly310/` 等顶层目录），复刻会产出陈旧事实，fixture 失去"真实文档任务"的性质 |
| commit 粒度 | 每步一 commit（4+ 个） | ❌ 单 commit 一次性写完：丢掉 mid-work 观测窗口，违背 issue 对 "multi-step" 的明确动机 |
| 分支 | 复用 Runner 分支 `project-slot-1-FLY-202` | ❌ 另开 `feat/...` 分支：WorktreeManager 派生分支就是任务语义上的 feature branch，历史各轮（#29/#30）均如此；另开分支徒增清理负担 |
| D 段确定性 | 接受 `ls -R` 输出跨轮不一致 | ❌ 固化快照保证 byte-stable:fixture 的价值在"多步真实工作流"，不在输出字节稳定；固化反而与 live 生成原则矛盾 |
| PR 处置 | 开 PR + 上报证据，不 merge | ❌ Runner self-merge：违反节点合同（ship/merge 归 harness / founder 流程） |

## 6. 诚实边界

**本设计做的**：一个 doc-only 的多步骤 fixture 任务的执行蓝图——文件结构、步骤切分、commit/PR 纪律、内容来源规则。

**本设计不做的**：
- 不改任何 `packages/` 代码，不测 qa-framework 本身的正确性；
- 不保证 `sandbox-notes.md` 内容跨 E2E 轮次字节稳定（D 段天然漂移）;
- 不覆盖 PR merge 之后的环节（merge/teardown 由 harness 与 QA 驱动）;
- 不触碰生产 flywheel 仓库、生产 Bridge/Lead 或任何生产 Linear 资源。

## 7. Implement 节点验收清单

- [ ] `doc/qa/sandbox-notes.md` 存在且含 A-D 四段（顺序正确、抬头合规）
- [ ] B 表覆盖 implement 时全部顶层目录（含隐藏配置目录），无凭空目录
- [ ] C 段 ~10 bullets，事实与 README 现状一致
- [ ] D 段为实跑输出的 fenced block
- [ ] ≥4 个 `docs(FLY-202):` commit，全部只触碰 `doc/`
- [ ] PR 开向 sandbox `main`，body 含 Linear Issue 段；未 self-merge
