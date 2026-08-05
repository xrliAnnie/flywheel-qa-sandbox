# Sandbox Notes Implementation Plan

> **For Flywheel Runner:** 按本计划在当前 session 内逐项执行；Flywheel stages 与 gates 负责 review 和 shipping，不调用额外的 execution-orchestration skill。

**Goal:** 在 sandbox clone 内创建 `doc/qa/sandbox-notes.md`，完整满足 FLY-202 的五项内容要求并提供可重复核对的证据。

**Architecture:** 这是单文件文档改动。内容事实来自当前 filesystem、`packages/qa-framework/README.md` 和两份 sandbox E2E guide；验证采用 shell 集合对比、计数和 transcript diff，不引入长期维护脚本。

**Tech Stack:** Markdown, POSIX shell utilities, Git, GitHub CLI

---

### Task 1: Capture Authoritative Inputs

**Files:**
- Read: `packages/qa-framework/README.md`
- Read: `doc/qa/framework/real-runner-e2e-guide.md`
- Read: `doc/qa/framework/sandbox-sync-guide.md`
- Create: `doc/qa/sandbox-notes.md`

- [x] **Step 1: Verify the deliverable is absent (RED)**

Run:

```bash
test -f doc/qa/sandbox-notes.md
```

Expected: exit 1 because the requested document does not exist yet.

- [x] **Step 2: Capture the top-level directory inventory**

Run:

```bash
find . -mindepth 1 -maxdepth 1 -type d -not -path './.git' -exec basename {} \; | LC_ALL=C sort
```

Expected: one sorted row per top-level directory, including `.claude`, `.flywheel`, `.github`, `.lead`, and `.serena`.

- [x] **Step 3: Capture the requested recursive listing**

Run exactly:

```bash
ls -R doc/ | head -50
```

Expected: 50 stdout lines beginning with `VERSION`, `architecture`, and the other entries at the root of `doc/`.

### Task 2: Write the Sandbox Note

**Files:**
- Create: `doc/qa/sandbox-notes.md`

- [x] **Step 1: Write the purpose section**

Write 2–3 English paragraphs explaining that the standalone sandbox mirrors Flywheel closely enough for realistic test-slot work while providing a safe remote for Runner pushes and PRs; describe the deploy/inject/observe/teardown lifecycle and the manual sync boundary.

- [x] **Step 2: Write the complete directory table**

Add one table row for every name printed by Task 1 Step 2, with a one-sentence description grounded in the directory's checked-out contents. Add a note that the top-level `=` entry is a file and therefore is not a directory-table row.

- [x] **Step 3: Write exactly ten README summary bullets**

Summarize these ten topics from `packages/qa-framework/README.md`: reusable framework purpose; two-layer architecture; quick-start configuration; five-step protocol; real-Runner slot isolation; deploy/inject/teardown scripts; prerequisites/start-point behavior; specialized hard-gate suite; mirror/roundtable/alert modes and their boundaries; plan-source and skill-interface contracts.

- [x] **Step 4: Add the exact command transcript**

Add a `## doc/ Listing` section, show the literal command, and paste Task 1 Step 3 stdout unchanged into a `text` fenced block.

### Task 3: Verify Content (GREEN)

**Files:**
- Verify: `doc/qa/sandbox-notes.md`

- [x] **Step 1: Verify required headings and note structure**

Run:

```bash
rg -n '^# |^## |^\| `|^```' doc/qa/sandbox-notes.md
```

Expected: one title; purpose, directory, QA summary, and listing sections; a directory table; and one balanced transcript fence.

- [x] **Step 2: Compare filesystem and documented directory sets**

Extract the filesystem inventory and the first-column backticked names from the directory table into temporary sorted files, then run `comm -3`. Expected: no output.

- [x] **Step 3: Count README bullets**

Count `- ` lines between `## QA Framework Summary` and `## doc/ Listing`. Expected: `10`.

- [x] **Step 4: Compare transcript with a fresh command run**

Extract the `text` fenced block and compare it with fresh output from `ls -R doc/ | head -50`. Expected: `diff` exit 0 and no output.

- [x] **Step 5: Run final Markdown hygiene checks**

Run:

```bash
git diff --check
```

Expected: exit 0 and no output. Then manually confirm the purpose section contains 2–3 paragraphs and every summary statement is supported by the README/guides.

### Task 4: Commit and Open the Sandbox PR

**Files:**
- Commit: `doc/qa/sandbox-notes.md`
- Commit: `engineering/doc/FLY-202-sandbox-notes/{exploration.md,plan.md,progress.md}`

- [x] **Step 1: Commit the verified deliverable**

```bash
git add doc/qa/sandbox-notes.md engineering/doc/FLY-202-sandbox-notes
git commit -m "docs(fly-202): add QA sandbox notes"
```

- [ ] **Step 2: Push a clean, run-unique issue feature branch**

The original harness branch name already exists remotely with a prior open fixture PR, and the first run-unique recovery branch inherited an upstream test start point that conflicts with sandbox `main`. Preserve both histories rather than force-pushing; replay only the FLY-202 documentation commits on a clean `origin/main` branch.

```bash
git switch -c project-slot-1-FLY-202-d716a70d-clean origin/main
git push -u origin project-slot-1-FLY-202-d716a70d-clean
```

- [ ] **Step 3: Open a PR against sandbox `main`**

Use `gh pr create --base main --head project-slot-1-FLY-202-d716a70d-clean` with an English title/body containing the requirement checklist and verification evidence. Then proceed through the mandatory Flywheel code-review, CI, founder-approval, and `:cool:` landing workflow.
