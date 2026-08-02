# FLY-202 Sandbox Notes Implementation Plan

> **For Flywheel Runner:** Execute this plan inline under the injected pipeline and gate instructions; do not dispatch nested agents.

**Goal:** Create a source-accurate `doc/qa/sandbox-notes.md` that satisfies every FLY-202 fixture requirement and can be validated deterministically.

**Architecture:** This is a documentation-only change. Git supplies the complete top-level directory set, the current QA framework README supplies the summary, and the prescribed `ls` pipeline supplies the fenced evidence block. A Node.js requirements check provides RED→GREEN evidence without adding production code.

**Tech Stack:** Markdown, Node.js, shell utilities, Git, GitHub CLI

---

### Task 1: Establish the RED documentation check

**Files:**

- Target missing before GREEN: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Run the requirements check before creating the document**

```bash
node - <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const target = "doc/qa/sandbox-notes.md";
assert.equal(fs.existsSync(target), true, `${target} must exist`);
const text = fs.readFileSync(target, "utf8");
const purpose = text.match(/^## Purpose\n\n([\s\S]*?)\n\n## /m);
assert.ok(purpose, "Purpose section must exist");
assert.ok(purpose[1].split(/\n\s*\n/).filter(Boolean).length >= 2, "Purpose needs 2-3 paragraphs");
const dirs = execFileSync("git", ["ls-tree", "-d", "--name-only", "HEAD"], { encoding: "utf8" }).trim().split("\n");
for (const dir of dirs) assert.ok(text.includes(`| \`${dir}/\` |`), `missing directory row: ${dir}`);
const summary = text.match(/^## packages\/qa-framework\/README\.md Summary\n\n([\s\S]*?)\n\n## /m);
assert.ok(summary, "README summary section must exist");
assert.equal(summary[1].split("\n").filter((line) => line.startsWith("- ")).length, 10, "README summary needs 10 bullets");
const documented = text.match(/^## `ls -R doc\/ \| head -50` Output\n\n```text\n([\s\S]*?)\n```$/m);
assert.ok(documented, "tree output block must exist");
const actual = execFileSync("bash", ["-c", "LC_ALL=C ls -R doc/ | head -50"], { encoding: "utf8" });
assert.equal(`${documented[1]}\n`, actual, "tree output must match the requested command");
console.log("FLY-202 documentation requirements: PASS");
NODE
```

Expected: FAIL with `doc/qa/sandbox-notes.md must exist` because the target does not yet exist.

### Task 2: Create the sandbox note

**Files:**

- Create: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: Write the purpose narrative**

Create a title plus date metadata and three prose paragraphs:

1. Explain that `flywheel-qa-sandbox` is the isolated repository where test-slot real-Runner branches, commits, PRs, CI, and merge effects are allowed to land without touching production.
2. Explain the concrete lifecycle: `test-deploy.sh` creates an isolated slot with a test Bridge and Lead, `inject-linear-issue.sh` calls `POST /api/runs/start`, and `test-teardown.sh` cleans processes, worktrees, temporary files, and CommDB state.
3. Explain that FLY-202 is a stable PreHydrator-visible Linear fixture designed to create an observable mid-work window and must not be picked up by production Leads or Runners.

- [ ] **Step 2: Add the complete top-level directory table**

Add exactly one row for every output line from:

```bash
git ls-tree -d --name-only HEAD
```

The table must cover:

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

Each row must describe the directory's observed contents in one concise sentence.

- [ ] **Step 3: Add ten QA framework summary bullets**

Summarize `packages/qa-framework/README.md` in exactly ten bullets covering:

1. framework purpose and two-layer architecture;
2. Quick Start and the five-step protocol;
3. real-Runner test-slot lifecycle and the no-synthetic-mode rule;
4. prerequisites and `FLYWHEEL_RUNNER_START_POINT`;
5. FLY-60 hard-gate suite and evidence boundaries;
6. FLY-153 Mirror Mode;
7. FLY-529 Roundtable and Alert mirrors;
8. config schema, TypeScript type import, and GeoForge3D example;
9. production approve wire plus StateStore, CommDB, and alert evidence boundaries;
10. plan-source and skill-interface contracts.

- [ ] **Step 4: Append the exact command output**

Run:

```bash
LC_ALL=C ls -R doc/ | head -50
```

Copy the output verbatim under `## \`ls -R doc/ | head -50\` Output` in a fenced `text` block.

### Task 3: Verify GREEN and commit

**Files:**

- Verify: `doc/qa/sandbox-notes.md`
- Verify: `engineering/doc/FLY-202-sandbox-notes/exploration.md`
- Verify: `engineering/doc/FLY-202-sandbox-notes/plan.md`

- [ ] **Step 1: Re-run the complete requirements check**

Run the exact Node.js block from Task 1.

Expected: exit 0 with `FLY-202 documentation requirements: PASS`.

- [ ] **Step 2: Check Markdown diff hygiene**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the requested note and process documents are uncommitted.

- [ ] **Step 3: Inspect the final deliverable**

```bash
sed -n '1,260p' doc/qa/sandbox-notes.md
```

Expected: three Purpose paragraphs, 17 directory rows, ten summary bullets, and the exact 50-line command output.

- [ ] **Step 4: Commit the implementation**

```bash
git add doc/qa/sandbox-notes.md engineering/doc/FLY-202-sandbox-notes/exploration.md engineering/doc/FLY-202-sandbox-notes/plan.md
git commit -m "docs(FLY-202): add QA sandbox fixture notes"
```

Expected: one documentation commit containing the requested deliverable and its process documents; progress commits remain separate.

### Task 4: Publish and enter the landing flow

**Files:**

- Update through CLI only: `engineering/doc/FLY-202-sandbox-notes/progress.md`
- Write through landing workflow: `.flywheel/runs/5e7a9498-274a-44b5-ad59-35d20541f8c8/land-status.json`

- [ ] **Step 1: Check Lead inbox and guard the injected identity**

```bash
node "$FLYWHEEL_COMM_CLI" inbox --exec-id 5e7a9498-274a-44b5-ad59-35d20541f8c8
test "${FLYWHEEL_ISSUE_ID:-FLY-202}" = "FLY-202"
test -f "$FLYWHEEL_COMM_CLI"
```

Expected: no unhandled Lead instruction and exit 0.

- [ ] **Step 2: Push the harness-created feature branch**

```bash
git push -u origin "$(git branch --show-current)"
```

- [ ] **Step 3: Open a PR against sandbox `main`**

```bash
gh pr create \
  --base main \
  --head "$(git branch --show-current)" \
  --title "docs(FLY-202): add QA sandbox fixture notes" \
  --body $'## Summary\n- describe the QA sandbox and slot lifecycle\n- inventory every tracked top-level directory\n- summarize the QA framework and capture the requested tree output\n\n## Verification\n- deterministic documentation requirements check\n- git diff --check'
```

- [ ] **Step 4: Complete mandatory review and approval controls**

Register a request-driven cross-family code review for the frozen PR head. After an `APPROVED` or governance-level `SKIPPED` verdict, run `gh pr checks <number>`, open the bound `approve_to_ship` gate, and call `complete --route needs_review` with that question id. Do not push after either head-bound gate opens.

- [ ] **Step 5: Ship only through the project workflow**

After `verify-approval` returns `"approved": true`, set stage `ship`, post exactly one `:cool:` comment, and track that attempt's receipt and workflow run until the PR is merged. Then write the actual PR number and merge SHA to the required landing signal and set stage `completed`.
