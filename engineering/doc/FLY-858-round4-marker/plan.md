# FLY-849 Round 4 Marker Implementation Plan

> **For agentic workers:** 本计划由 FLY-858 Design 阶段（Fable）产出，供 Implement 阶段（Opus）在**同一分支**上执行。任务为 doc-only，单任务即可完成；按步骤逐项打勾。

**Goal:** 新增单个标记文件 `doc/qa/harness/FLY-849-round4-marker.md`，作为 FLY-849 combined-batch QA 第 4 轮（FLY-856 handoff-leadid-fix 验证轮）的落盘证据。

**Architecture:** 静态 markdown 文件（exploration 方案 A）：无脚本、无运行时行为；heading 逐字匹配验收标准，正文恰好一句话。

**Tech Stack:** git / GitHub PR（`gh`）。无代码、无依赖。

**Issue**: FLY-858
**Date**: 2026-07-04
**Source**: `engineering/doc/FLY-858-round4-marker/exploration.md`
**Status**: codex-approved（design review Round 1 直接 APPROVED，无阻塞项；反馈唯一建议已折入 Step 4 的 diff 预检）

> **本轮被测的不是这个文件**：issue 的两个验证点（Implement/QA runner tmux window ship 后自关；归档 Discord thread 不被残留 post unarchive）是 Bridge/cmux 侧运行时行为，由 harness 带外观察。Implement 阶段的职责 = 如实、全自动地走完标准流程，让被测行为在真实路径上发生。**不要**为这两点添加任何额外产物或断言。

---

### Task 1: 创建 round-4 marker 文件并开 PR

**Files:**
- Create: `doc/qa/harness/FLY-849-round4-marker.md`（唯一产品交付物）

- [ ] **Step 1: 写入 marker 文件**

以实现时刻 UTC 日期替换 `<YYYY-MM-DD>`（取法：`date -u +%Y-%m-%d`）：

```markdown
# FLY-849 round 4 marker

This is the FLY-856 handoff-leadid-fix verification round (Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation), created on <YYYY-MM-DD> (UTC).
```

注意：**目录 `doc/qa/harness/` 在本分支血统里不存在**（基分支合入 FLY-856 fix 时被重建，round 1–3 的 merge 已不在），写文件时需一并创建目录（Write 工具自动建；用 shell 则 `mkdir -p doc/qa/harness`）。这一点与 round 3 plan 相反，勿照搬。

- [ ] **Step 2: 验证（doc-only 的 "test"）**

```bash
test -f doc/qa/harness/FLY-849-round4-marker.md && echo FILE-OK
grep -Fx '# FLY-849 round 4 marker' doc/qa/harness/FLY-849-round4-marker.md && echo HEADING-OK
grep -E 'FLY-856 handoff-leadid-fix verification round.*Design=Fable.*Implement=Opus.*QA=Sonnet.*no manual simulation' doc/qa/harness/FLY-849-round4-marker.md && echo SENTENCE-OK
```

Expected: 依次输出 `FILE-OK`、heading 原文 + `HEADING-OK`、句子原文 + `SENTENCE-OK`。任一缺失即修正文件后重跑。

- [ ] **Step 3: Commit**

```bash
git add doc/qa/harness/FLY-849-round4-marker.md
git commit -m "docs(FLY-858): add FLY-849 round 4 marker (FLY-856 handoff-leadid-fix verification)"
```

- [ ] **Step 4: Push 并开 PR（base = sandbox mirror 分支）**

先做 diff 预检（Codex design review 建议）：确认 PR 内容 = marker + 已知管线过程文档（`engineering/doc/FLY-858-round4-marker/*`），无意外文件混入：

```bash
git diff --name-status qa/fly849-793-batch-combined...HEAD
```

然后 push + 开 PR：

```bash
git push -u origin project-slot-2-FLY-858
gh pr create --base qa/fly849-793-batch-combined \
  --title "FLY-858: FLY-849 round 4 marker (FLY-856 handoff-leadid-fix verification)" \
  --body "## Summary

Add \`doc/qa/harness/FLY-849-round4-marker.md\` — the round-4 marker for FLY-849 combined-batch QA, verifying the FLY-856 handoff-leadid fix (PR #442, resolveLeadId) via the same full-auto three-stage pipeline as round 3 (Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation). The round's real verification points — Implement/QA runner tmux windows self-close after ship, and the archived Discord thread staying archived — are observed Bridge-side by the harness during this run. Sandbox only.

## Acceptance criteria

- [x] File exists with the exact heading \`# FLY-849 round 4 marker\`
- [x] PR against \`qa/fly849-793-batch-combined\` with this single product file added (design docs + progress.md on the branch are the pipeline's own process artifacts)

## Linear Issue

FLY-858: QA·FLY-849 harness round 4 — verify FLY-856 handoff-leadid fix (tmux self-close + no unarchive)
https://linear.app/studio/issue/FLY-858

## Test plan

- [x] \`grep -Fx '# FLY-849 round 4 marker'\` heading check
- [x] Sentence contains FLY-856 + Fable/Opus/Sonnet + no manual simulation (doc-only change, no runtime surface — unit/E2E waived)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

之后按 Runner 自身 baseline 规则走 `stage set pr_created` → approve gate 流程（`--no-block` + `complete --route needs_review`，唤醒后 `verify-approval` 通过才 ship）。**Ship 之后不要做任何多余动作**——本轮恰恰在观察 ship 完成后 tmux window 是否自关、归档 thread 是否被打扰;残留的 post/轮询本身就是被测反例。

---

## Acceptance criteria（issue 原文）

1. 文件存在且 heading 逐字为 `# FLY-849 round 4 marker`。
2. PR 开向 `qa/fly849-793-batch-combined`，产品交付物仅此单文件（分支上的设计文档 + progress.md 为三阶段管线固有形态，见 exploration 假设 1）。

## Out of scope

- 不写生成脚本、不加 exec-id/commit SHA 等元数据（exploration 方案 B/C 已拒绝）。
- 不补回 round 1–3 的旧 marker（基分支重建的预期结果，见 exploration 假设 4）。
- 不为 tmux 自关 / thread 不 unarchive 两个带外验证点添加任何断言或产物（harness 侧观察）。
