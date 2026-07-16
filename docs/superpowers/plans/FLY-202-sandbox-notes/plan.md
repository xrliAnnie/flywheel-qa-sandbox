# FLY-202 QA Sandbox Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 `flywheel-qa-sandbox` clone 中重建 `doc/qa/sandbox-notes.md`，覆盖 FLY-202 的四项内容要求，并通过 feature branch + PR 完成第五项发布要求。

**Architecture:** 以当前 Git tree 和仓库内 QA 指南为唯一事实来源：`git ls-tree` 决定顶层目录全集，`packages/qa-framework/README.md` 决定摘要内容，`ls -R doc/ | head -50` 决定快照文本。实现只新增目标 Markdown 文件；永久过程文件限于本 plan 与 runner progress ledger，不修改代码或生产配置。

**Tech Stack:** Markdown、Git、POSIX shell、Node.js（仅用于一次性内容校验）

---

### Task 1: Establish the RED baseline and source evidence

**Files:**
- Read: `doc/qa/framework/sandbox-sync-guide.md`
- Read: `doc/qa/framework/real-runner-e2e-guide.md`
- Read: `packages/qa-framework/README.md`

- [ ] **Step 1: Confirm the requested artifact is absent**

From the repository root, run:

```bash
test -f doc/qa/sandbox-notes.md
```

Expected: exit status `1`, proving the fixture deliverable is missing on the current branch.

- [ ] **Step 2: Capture the authoritative top-level directory set**

Run:

```bash
git ls-tree -d --name-only HEAD
```

Expected: exactly these 17 entries, in Git order:

```text
.claude
.flywheel
.github
.lead
.serena
agents
doc
docs
engineering
fleet
packages
patches
product
qa-fly294
qa-fly310
scripts
supabase
```

- [ ] **Step 3: Capture the requested document-tree snapshot**

Run:

```bash
ls -R doc/ | head -50
```

Expected: 50 lines beginning with `VERSION`, `architecture`, `engineer`, `plan`, `qa`, `reference`, and `retro`. Preserve this machine-local output byte-for-byte inside the target document.

### Task 2: Create the sandbox notes

**Files:**
- Create: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Write the document header**

Start the file with this project-conforming metadata block:

```markdown
# QA Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-07-15
```

- [ ] **Step 2: Write the overview**

Write 2–3 Chinese paragraphs explaining that the repository is a standalone mirror seeded from `xrliAnnie/flywheel`, provides an isolated push/PR target for real-Runner test-slot E2E, and that FLY-202 is the stable PreHydrator-visible Linear fixture used to exercise the full runner pipeline without production impact.

- [ ] **Step 3: Add the complete directory table**

Add one row for each Task 1 directory with these responsibilities:

```text
.claude      Claude Code commands and orchestration configuration
.flywheel    Flywheel project and agent-routing configuration
.github      GitHub Actions and ship workflows
.lead        Lead identity definitions
.serena      Serena project indexing configuration
agents       Shipped generic and QA runner prompts
doc          Primary architecture, engineering, QA, reference, and retro docs
docs         Contributor/operations runbooks and Superpowers plan ledgers
engineering  Issue-scoped engineering designs, evidence, and spikes
fleet        Fleet deployment examples and manifests
packages     pnpm monorepo packages, including qa-framework
patches      pnpm dependency patches
product      Issue-scoped product research and planning artifacts
qa-fly294    FLY-294 QA harness and report artifacts
qa-fly310    FLY-310 Discord E2E harness and reports
scripts      Development, operations, and QA/E2E automation
supabase     Supabase configuration and database migrations
```

- [ ] **Step 4: Add exactly 10 README summary bullets**

Cover: framework purpose/origin; two-layer architecture; quick start; five-step protocol; config/types/examples; real-Runner slot model; deploy/inject/teardown scripts; prerequisites and start-point behavior; specialized manual-gate and mirror/room suites; contracts and skill interface. Contract links must be repository-root-resolvable: `packages/qa-framework/contracts/PLAN_SOURCE_CONTRACT.md` and `packages/qa-framework/skills/SKILL_INTERFACE.md`.

- [ ] **Step 5: Embed the exact command output**

Append a section titled ``## `ls -R doc/ | head -50` Output`` and place the current command output in one fenced `text` block.

### Task 3: Verify the document

**Files:**
- Verify: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Run the structural and exact-output verifier**

From the repository root, run this exact one-off Node.js assertion:

```javascript
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync, execSync } = require("node:child_process");

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
assert.equal(process.cwd(), root, "verifier must run from the repository root");

const path = "doc/qa/sandbox-notes.md";
assert.ok(fs.existsSync(path), `${path} must exist`);
const text = fs.readFileSync(path, "utf8");

assert.match(
  text,
  /^# QA Sandbox Notes — flywheel-qa-sandbox\n\n\*\*Issue\*\*: FLY-202 \(QA sandbox fixture — slot harness real-Runner E2E task\)\n\*\*Date\*\*: 2026-07-15\n/,
  "title and Issue/Date metadata must match",
);

function between(start, end) {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section ${start.trim()}`);
  const contentStart = startIndex + start.length;
  const endIndex = end ? text.indexOf(end, contentStart) : text.length;
  assert.notEqual(endIndex, -1, `missing section boundary ${end.trim()}`);
  return text.slice(contentStart, endIndex).trim();
}

const overview = between("## Overview\n", "## Top-Level Directories\n");
const paragraphs = overview.split(/\n\s*\n/).filter(Boolean);
assert.ok(
  paragraphs.length >= 2 && paragraphs.length <= 3,
  "Overview must contain 2–3 blank-line-separated paragraphs",
);

const table = between(
  "## Top-Level Directories\n",
  "## packages/qa-framework/README.md Summary\n",
);
const actualDirectories = [...table.matchAll(/^\| `([^`]+)\/` \|/gm)].map(
  (match) => match[1],
);
const expectedDirectories = execFileSync(
  "git",
  ["ls-tree", "-d", "--name-only", "HEAD"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
assert.deepEqual(actualDirectories, expectedDirectories);

const summary = between(
  "## packages/qa-framework/README.md Summary\n",
  "## `ls -R doc/ | head -50` Output\n",
);
assert.equal((summary.match(/^- /gm) || []).length, 10);
assert.match(
  summary,
  /packages\/qa-framework\/contracts\/PLAN_SOURCE_CONTRACT\.md/,
);
assert.match(
  summary,
  /packages\/qa-framework\/skills\/SKILL_INTERFACE\.md/,
);

const snapshot = between(
  "## `ls -R doc/ | head -50` Output\n\n```text\n",
  "\n```",
);
const expectedSnapshot = execSync("ls -R doc/ | head -50", {
  encoding: "utf8",
  shell: "/bin/zsh",
}).trimEnd();
assert.equal(snapshot, expectedSnapshot);

console.log("PASS: doc/qa/sandbox-notes.md satisfies FLY-202");
```

Expected: `PASS: doc/qa/sandbox-notes.md satisfies FLY-202`.

- [ ] **Step 2: Review working-tree scope**

Run:

```bash
git status --short
git diff --check
```

Expected: only the issue plan/ledger and `doc/qa/sandbox-notes.md` are staged or committed by this runner; externally supplied untracked QA fixtures remain untouched; `git diff --check` exits `0` with no output.

### Task 4: Publish and land through Flywheel gates

**Files:**
- Commit: `doc/qa/sandbox-notes.md`
- Commit: `docs/superpowers/plans/FLY-202-sandbox-notes/plan.md`
- Existing committed ledger: `docs/superpowers/plans/FLY-202-sandbox-notes/progress.md`

- [ ] **Step 1: Commit and push the feature branch**

Run:

```bash
git add doc/qa/sandbox-notes.md docs/superpowers/plans/FLY-202-sandbox-notes/plan.md
git commit -m "docs(FLY-202): recreate QA sandbox notes"
git push -u origin project-slot-2-FLY-202
```

- [ ] **Step 2: Open the PR and write the pending landing marker**

Create a PR against `main`, then write `{"status":"pending"}` to the execution's required `land-status.json` path.

- [ ] **Step 3: Pass cross-family code review and CI monitoring**

Register a `review_code` gate for the exact PR head, address any blocking findings in a new review round, and follow `flywheel-land` until CI/review are ready.

- [ ] **Step 4: Request founder approval and ship**

Open a fresh `approve_to_ship` gate bound to the reviewed head. Only after `verify-approval` returns `approved: true`, post `:cool:`, wait for the repository workflow to merge, write the merged landing signal with the merge SHA, and set stage `completed`.
