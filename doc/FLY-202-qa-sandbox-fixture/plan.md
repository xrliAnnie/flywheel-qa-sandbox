# FLY-202 QA Sandbox Fixture Refresh Implementation Plan

> **For Flywheel Runner:** 在当前 resident session 内逐项执行;Flywheel stages、gates 与 shipping workflow 掌握编排,不派发 subagent。

**Goal:** 按当前 `flywheel-qa-sandbox` baseline 原位刷新 `doc/qa/sandbox-notes.md`,逐项满足 FLY-202 的五个交付要求并创建以 `main` 为 base 的 PR。

**Architecture:** 只改 Markdown:过程合同保存在本 issue 文件夹,主交付物保持稳定路径 `doc/qa/sandbox-notes.md`。目录表以 `git ls-tree` 的 tracked 顶层目录为准,命令证据以本次 checkout 的真实 `ls -R doc/ | head -50` 输出为准。

**Tech Stack:** Markdown、POSIX shell、Git、GitHub CLI (`gh`)

---

### Task 1: Capture the current repository snapshot

**Files:**
- Read: `packages/qa-framework/README.md`
- Read: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Capture every tracked top-level directory**

Run:

```bash
git ls-tree -d --name-only HEAD | sort
```

Expected: 17 directories, from `.claude` through `supabase`, with no `.git` metadata directory.

- [ ] **Step 2: Capture the required live command evidence**

Run:

```bash
ls -R doc/ | head -50
```

Expected: exactly 50 output lines beginning with the current `doc/` entries and issue-document folder contents.

- [ ] **Step 3: Re-read the QA framework source**

Run:

```bash
sed -n '1,280p' packages/qa-framework/README.md
```

Expected: source material covering framework architecture, the five-step protocol, test-slot lifecycle, Runner start-point override, E2E modes, and QA contracts.

### Task 2: Refresh the sandbox notes

**Files:**
- Modify: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Refresh the repository-purpose introduction**

Keep exactly three prose paragraphs. Explain that the repository is an isolated, disposable target for real-Runner test-slot E2E, that it validates the true Git/GitHub/gate lifecycle without production impact, and that slot scripts preserve concurrency isolation and cleanup.

- [ ] **Step 2: Refresh the complete top-level directory table**

Keep one table row for each tracked directory returned by Task 1. Describe the five hidden project directories and twelve visible directories in one concise sentence each.

- [ ] **Step 3: Refresh the QA README summary**

Write exactly ten bullets covering: reusable framework purpose; generic/project layers; five-step protocol; adoption; no-synthetic real-Runner slots; deploy/inject/teardown lifecycle; prerequisites; `FLYWHEEL_RUNNER_START_POINT`; E2E suite modes; and plan/test-skill contracts.

- [ ] **Step 4: Replace the captured `doc/` listing**

Keep the literal command label and a fenced `text` block whose contents exactly match the Task 1 command output.

### Task 3: Verify every issue requirement

**Files:**
- Verify: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Run Markdown and Git hygiene checks**

Run `git diff --check`; expect exit 0 with no output.

- [ ] **Step 2: Verify table completeness against the repository tree**

Compare `git ls-tree -d --name-only HEAD` with the backtick-wrapped first table column. Expect no missing or unexpected directory names.

- [ ] **Step 3: Verify prose, bullets, and captured output**

Run a bounded parser that asserts three introductory paragraphs, exactly ten summary bullets, a fenced listing block, and byte-for-byte equality between its content and `ls -R doc/ | head -50`. Expect `sandbox-notes verification: PASS`.

### Task 4: Commit, publish, and enter review

**Files:**
- Commit: `doc/qa/sandbox-notes.md`
- Commit: `doc/FLY-202-qa-sandbox-fixture/design.md`
- Commit: `doc/FLY-202-qa-sandbox-fixture/plan.md`
- Commit: `doc/FLY-202-qa-sandbox-fixture/progress.md`
- Commit: `doc/FLY-202-qa-sandbox-fixture/workflow-output.json`

- [ ] **Step 1: Inspect the final diff and Lead inbox**

Run `git diff --check` and `git diff --stat origin/main...HEAD`. Expect Markdown-only changes scoped to the FLY-202 fixture.

- [ ] **Step 2: Commit the refreshed deliverable**

Write the final workflow-output JSON first, then stage all five listed files and commit with `docs(FLY-202): refresh QA sandbox fixture notes`. If the refreshed files are already byte-identical to the committed branch, keep the existing commit instead of issuing an empty `git commit`.

- [ ] **Step 3: Push and create or reuse the PR**

Push the feature branch, then query `gh pr list --head "$(git branch --show-current)" --base main --state open`. Reuse the matching open PR when one exists; otherwise run `gh pr create --base main`. Expect exactly one open PR in `xrliAnnie/flywheel-qa-sandbox` with base `main` and the current branch as its head.

- [ ] **Step 4: Submit the workflow handoff**

After the final push, do not run `flywheel-comm progress` or create any further commit. Re-read the selected PR and verify local `HEAD` exactly matches its `headRefOid`; if it does not, push the current head and repeat the check. Submit the already-committed generalized workflow output JSON with `workflow-output --payload-file <absolute-json-path>`, then complete this bounded node with `complete --route needs_review --pr <number>`. The DAG orchestrator owns review, approval, and landing.
