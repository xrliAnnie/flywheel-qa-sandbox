# FLY-849 Round 3 Marker Implementation Plan

> **For agentic workers:** 本计划由 FLY-855 Design 阶段（Fable）产出，供 Implement 阶段（Opus）在**同一分支**上执行。任务为 doc-only，单任务即可完成；按步骤逐项打勾。

**Goal:** 新增单个标记文件 `doc/qa/harness/FLY-849-round3-marker.md`，作为 FLY-849 combined-batch QA 第 3 轮（full-auto 三阶段）验证的落盘证据。

**Architecture:** 静态 markdown 文件（exploration 方案 A）：无脚本、无运行时行为；heading 逐字匹配验收标准，正文恰好一句话。

**Tech Stack:** git / GitHub PR（`gh`）。无代码、无依赖。

**Issue**: FLY-855
**Date**: 2026-07-04
**Source**: `engineering/doc/FLY-855-round3-marker/exploration.md`
**Status**: design-complete

---

### Task 1: 创建 round-3 marker 文件并开 PR

**Files:**
- Create: `doc/qa/harness/FLY-849-round3-marker.md`（唯一产品交付物）

- [ ] **Step 1: 写入 marker 文件**

以实现时刻 UTC 日期替换 `<YYYY-MM-DD>`（取法：`date -u +%Y-%m-%d`）：

```markdown
# FLY-849 round 3 marker

This is the full-auto three-stage verification round (Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation), created on <YYYY-MM-DD> (UTC).
```

注意：目录 `doc/qa/harness/` 已存在（round 1/2 marker 在内），无需 mkdir。

- [ ] **Step 2: 验证（doc-only 的 "test"）**

```bash
test -f doc/qa/harness/FLY-849-round3-marker.md && echo FILE-OK
grep -Fx '# FLY-849 round 3 marker' doc/qa/harness/FLY-849-round3-marker.md && echo HEADING-OK
grep -E 'full-auto three-stage verification round.*Design=Fable.*Implement=Opus.*QA=Sonnet.*no manual simulation' doc/qa/harness/FLY-849-round3-marker.md && echo SENTENCE-OK
```

Expected: 依次输出 `FILE-OK`、heading 原文 + `HEADING-OK`、句子原文 + `SENTENCE-OK`。任一缺失即修正文件后重跑。

- [ ] **Step 3: Commit**

```bash
git add doc/qa/harness/FLY-849-round3-marker.md
git commit -m "docs(FLY-855): add FLY-849 round 3 marker (full-auto three-stage verification)"
```

- [ ] **Step 4: Push 并开 PR（base = sandbox mirror 分支）**

```bash
git push -u origin project-slot-2-FLY-855
gh pr create --base qa/fly849-793-batch-combined \
  --title "FLY-855: FLY-849 round 3 marker (full-auto three-stage)" \
  --body "## Summary

Add \`doc/qa/harness/FLY-849-round3-marker.md\` — the round-3 marker for FLY-849 combined-batch QA, verifying the full-auto three-stage pipeline (Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation). Sandbox only.

## Acceptance criteria

- [x] File exists with the exact heading \`# FLY-849 round 3 marker\`
- [x] PR against \`qa/fly849-793-batch-combined\` with this single product file added (design docs + progress.md on the branch are the pipeline's own process artifacts)

## Linear Issue

FLY-855: QA·FLY-849 harness round 3 — full auto three-stage run
https://linear.app/studio/issue/FLY-855

## Test plan

- [x] \`grep -Fx '# FLY-849 round 3 marker'\` heading check
- [x] Sentence contains Fable/Opus/Sonnet + no manual simulation (doc-only change, no runtime surface — unit/E2E waived)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

之后按 Runner 自身 baseline 规则走 `stage set pr_created` → approve gate 流程。

---

## Acceptance criteria（issue 原文）

1. 文件存在且 heading 逐字为 `# FLY-849 round 3 marker`。
2. PR 开向 `qa/fly849-793-batch-combined`，产品交付物仅此单文件（分支上的设计文档 + progress.md 为三阶段管线固有形态，见 exploration 假设 1）。

## Out of scope

- 不写生成脚本、不加 exec-id/模型版本号等元数据（exploration 方案 B/C 已拒绝）。
- 不改 round 1/2 的既有 marker 文件。
