# FLY-202 QA Sandbox Fixture Implementation Plan

> **Execution:** 在当前 Flywheel Runner session 内逐项执行；Flywheel 负责 orchestration，不派发 subagent。

**Goal:** 创建 `doc/qa/sandbox-notes.md`，准确说明 sandbox 仓库用途、当前顶层目录、QA framework README 要点，并保存指定目录命令的真实输出。

**Architecture:** 产物是单一 Markdown 文档，不引入代码、生成器或运行时依赖。所有易过期内容都从当前 `HEAD` 取证：目录表以 `git ls-tree -d --name-only HEAD` 为准，README 摘要以 `packages/qa-framework/README.md` 为准，目录输出由题目指定的命令直接生成。

**Tech Stack:** Markdown、Git、POSIX shell utilities。

---

### Task 1: Establish the RED baseline

**Files:**
- Create later: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Confirm the requested artifact is absent**

Run:

```bash
test -f doc/qa/sandbox-notes.md
```

Expected: exit status `1`, proving the requested artifact does not yet exist on this branch.

- [ ] **Step 2: Capture the authoritative directory set**

Run:

```bash
git ls-tree -d --name-only HEAD
```

Expected: the tracked top-level directory names that the document table must cover exactly once; `.git/` is excluded because it is repository metadata rather than a tracked project directory.

### Task 2: Create the fixture document

**Files:**
- Create: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Write the overview**

Write a title and 2–3 Chinese paragraphs that explain:

- `flywheel-qa-sandbox` is the isolated target repository for test-slot real-Runner E2E.
- `test-deploy.sh`, `inject-linear-issue.sh`, and `test-teardown.sh` exercise the real pipeline without touching production resources.
- FLY-202 is the stable, PreHydrator-visible Linear fixture used to give the spawned Runner a small multi-step task.

- [ ] **Step 2: Add the top-level directory table**

Add one row for every directory returned by:

```bash
git ls-tree -d --name-only HEAD
```

Each row must contain the directory name and a one-line description grounded in its current contents.

- [ ] **Step 3: Add the QA framework summary**

Add exactly 10 bullets summarizing `packages/qa-framework/README.md`, covering its reusable purpose, two-layer architecture, quick start, five-step protocol, configuration/types, examples, real-Runner slot framework, lifecycle scripts, prerequisites/start point, and guides/contracts.

- [ ] **Step 4: Capture the requested command output**

Run:

```bash
ls -R doc/ | head -50
```

Append the literal 50-line output in a fenced `text` block under a clearly named section.

### Task 3: Verify and commit

**Files:**
- Verify: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Verify structure and content**

Run shell checks that prove:

- the file exists;
- the overview has 2–3 paragraphs before the first content section;
- the directory rows equal the current tracked top-level directory set with no missing or extra rows;
- the README summary has exactly 10 bullets;
- the fenced block equals fresh output from `ls -R doc/ | head -50`;
- no unfinished placeholder markers remain.

Expected: every check exits `0`.

- [ ] **Step 2: Review the diff**

Run:

```bash
git diff --check
git diff -- doc/qa/sandbox-notes.md
```

Expected: no whitespace errors and a focused documentation-only diff.

- [ ] **Step 3: Commit the artifact**

Run:

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): add QA sandbox fixture notes"
```

Expected: one focused documentation commit on the existing runner-created feature branch.

### Task 4: Push, review, and land

**Files:**
- No additional product files.

- [ ] **Step 1: Push the current feature branch and open a PR against sandbox `main`**

- [ ] **Step 2: Register and pass the mandatory cross-family code review for the frozen PR head**

- [ ] **Step 3: Probe CI, write the flywheel-land readiness signal, and open the founder approval gate**

- [ ] **Step 4: After verified approval, trigger the project merge workflow, confirm the PR is merged, rewrite `land-status.json` to `merged`, and report `completed`**
