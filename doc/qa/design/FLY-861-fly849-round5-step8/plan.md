# Plan: FLY-849 Round 5 Marker — FLY-861

> **For the Implement phase (Opus):** 本 plan 由同分支 Design 阶段（Fable）产出，brainstorm 硬门已过（Lead 四点全批）。任务是 docs-only、无代码/测试面；交付物内容已字节级钉死，照抄即可，勿"改进"措辞。Steps 用 checkbox 便于跟踪。

**Issue**: FLY-861（QA·FLY-849 harness round 5 — verify FLY-859 Step 8）
**Date**: 2026-07-04
**Source**: `doc/qa/design/FLY-861-fly849-round5-step8/exploration.md`, `.../research.md`
**Status**: codex-approved（design review 1 轮 APPROVED，2026-07-04，verdict JSON 见 `.flywheel/runs/0d4aea83-.../codex/design-review.json`）
**Branch**: `project-slot-2-FLY-861`（3-stage 共享分支，勿另建分支）
**PR base**: `qa/fly849-793-batch-combined`（acceptance criteria 明确；**不是** `main`）
**Goal**: 新建 `doc/qa/harness/FLY-849-round5-marker.md`（恰两行内容），commit 后向 `qa/fly849-793-batch-combined` 开 PR；随后的 founder gate + ship 由 QA phase 的 FLY-859 Step 8 机制承担。

**变更分桶（commit / verification / PR body 统一口径）：**

- **Bucket A（Design 阶段已提交，Implement 不改内容）**：`doc/qa/design/FLY-861-fly849-round5-step8/{exploration,research,plan}.md`
- **Bucket B（Implement 阶段允许改动的全部文件）**：`doc/qa/harness/FLY-849-round5-marker.md`（新增）+ `doc/qa/design/FLY-861-fly849-round5-step8/progress.md`（仅勾 checkbox / 补记录）

---

## Task 1: 创建 round 5 marker 文件

- [x] **Step 1: 环境断言**

```bash
git remote -v               # 必须是 xrliAnnie/flywheel-qa-sandbox（fetch+push）
git branch --show-current   # 必须是 project-slot-2-FLY-861
git log --oneline -5        # 应含 Design 阶段设计文档 commit + baca27c/1253524 两个 merge
```

若 remote 指向生产 `xrliAnnie/flywheel` → 立即停止，`flywheel-comm complete --route blocked`。

防御性回退：若 `git status --short` 显示 `?? doc/qa/design/`（Bucket A 意外未入库），先单独 commit（`docs(FLY-861): add design docs`）再继续。

- [x] **Step 2: 创建文件（内容字节级钉死，含末尾换行，共 3 行：标题 + 空行 + 一句话）**

路径：`doc/qa/harness/FLY-849-round5-marker.md`（目录不存在，随文件创建）

```markdown
# FLY-849 round 5 marker

This is the FLY-859 Step 8 verification round of the FLY-849 combined-batch harness (Design=Fable, Implement=Opus, QA=Sonnet, no manual simulation).
```

- [x] **Step 3: 自检**

```bash
head -3 doc/qa/harness/FLY-849-round5-marker.md   # 与上方逐字一致
git status --short                                 # 仅 Bucket B 文件
```

- [x] **Step 4: commit**

```
docs(FLY-861): add FLY-849 round 5 marker — FLY-859 Step 8 verification round
```

（连同 progress.md 的 checkbox 更新一起提交即可。）

## Task 2: push + PR + pipeline 收尾

- [ ] **Step 1: push**：`git push -u origin project-slot-2-FLY-861`
- [ ] **Step 2: 开 PR**（base 必须核验）：

```bash
gh pr create --base qa/fly849-793-batch-combined \
  --title "docs(FLY-861): FLY-849 round 5 marker — FLY-859 Step 8 verification" \
  --body "<summary + test plan + '## Linear Issue' section (FLY-861)>"
gh pr view --json baseRefName -q '.baseRefName'   # 必须输出 qa/fly849-793-batch-combined
```

PR body 说明分桶：本轮交付物 bucket = marker 单文件；设计文档 + 已合入的 FLY-856/859 内容是共享累积分支固有 diff。

- [ ] **Step 3: `flywheel-comm stage set pr_created`**（Bridge 自动触发 Codex code review；按注入协议 `await-codex-gate` / inbox 处理反馈）
- [ ] **Step 4: 按 Implement 阶段注入协议收尾。⚠️ 不做 merge、不自 ship** —— founder gate 由 QA phase 在 PASS 后经 FLY-859 Step 8 自持久化并自 ship，这正是本轮被验行为；Implement 越权 ship = 本轮 QA 目标直接作废。

## Verification（QA phase 复核清单，在 reviewed commit 上独立执行）

- [ ] `doc/qa/harness/FLY-849-round5-marker.md` 存在，首行 == `# FLY-849 round 5 marker`
- [ ] 正文恰一句话，含 "FLY-859 Step 8"、三模型分工（Design=Fable, Implement=Opus, QA=Sonnet）与 "no manual simulation"，与 plan Step 2 逐字一致
- [ ] PR base == `qa/fly849-793-batch-combined`，交付物 bucket 仅 marker 单文件新增
- [ ] Bucket A/B 之外零文件改动（`git diff --name-only <merge-base>..HEAD` 范围核验，排除 combined 分支既有内容）
- [ ] QA verdict 经 `flywheel-comm qa-result` 上报（PASS → Step 8 gate 链路开启；这之后的 gate/approve/self-ship/finalization 观测由 harness/Lead 侧完成，不是 QA Runner 的复核项）
