# FLY-3122 Claude 标签传输探针 — 实施计划
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: research.md

> **For agentic workers:** 按 phase ownership 执行；design node 只产文档/HTML/review，implement node 只消费明确送达自己的 Lead instruction。禁止跨 execution 复制 marker，也禁止在本 issue 创建 PR、ship 或 deploy。

**Goal:** 诚实记录当前 Codex design TURN，产出经批准的条件式下游合同；只有当前 implement execution 收到 exact Lead marker instruction 时才修改 `probe.txt`。

**Architecture:** Execution identity、TURN receipt 和 Lead instruction 是三道独立证据。TURN 只授予当前 phase 写权，不提供 marker 内容；marker 内容只能来自明确发给当前 execution 的 Lead message。Design evidence 与可选的 probe commit 分属不同 phase，不能在审查前混写。

**Tech Stack:** UTF-8 plain text、Git、`flywheel-comm`、Mermaid CLI (`mmdc`)。

---

## 文件矩阵

| 路径 | Owner phase | 动作 | 单一职责 |
|---|---|---|---|
| `engineering/doc/FLY-3122-claude-turn-canary/exploration.md` | design | Modify | 范围、备选方案与拒绝理由 |
| `engineering/doc/FLY-3122-claude-turn-canary/research.md` | design | Modify | execution 事实、driver 边界、DAG mismatch |
| `engineering/doc/FLY-3122-claude-turn-canary/plan.md` | design | Modify | phase-safe 实施合同 |
| `engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd` | design | Modify | 条件式核心流程 Mermaid source |
| `engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd` | design | Modify | identity / TURN / instruction / evidence 模型 |
| `engineering/doc/FLY-3122-claude-turn-canary/founder-report.html` | design | Modify | Founder 可读摘要与评论层 |
| `engineering/doc/FLY-3122-claude-turn-canary/progress.md` | flywheel-comm | Update | restart-resilient phase cursor |
| `probe.txt` | implement only, conditional | Append only | 保存当前 execution 被明确要求写入的 exact marker lines |

## Task 1: Design node 修复、提交、再审查

**Files:**
- Modify: `engineering/doc/FLY-3122-claude-turn-canary/exploration.md`
- Modify: `engineering/doc/FLY-3122-claude-turn-canary/research.md`
- Modify: `engineering/doc/FLY-3122-claude-turn-canary/plan.md`
- Modify: `engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd`
- Modify: `engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd`
- Modify: `engineering/doc/FLY-3122-claude-turn-canary/founder-report.html`
- Must not modify: `probe.txt`

- [ ] **Step 1: 确认当前 design TURN**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" turn --exec-id "$FLYWHEEL_EXEC_ID"
  ```

  Expected: output begins with `yours`. Do not hardcode execution id or phase; `not-yours` means no worktree write.

- [ ] **Step 2: 修复 review findings**

  Required content changes:

  - remove every claim that the issue title authorizes Claude BOOT / R4 literals;
  - state that current vendor is Codex and mailbox has no marker instruction;
  - move all `probe.txt` mutation to the conditional implement contract;
  - document external driver absolute path plus commit `a6174863d1889d009ed3d635a8d633afdea55245`;
  - document `tpl_code` no-shipping mismatch and Lead question `2add653c-7fb8-4cdd-ae4e-67651c476e39`;
  - use dynamic `$FLYWHEEL_EXEC_ID` and direct worktree `grep -nxF` in downstream steps.

- [ ] **Step 3: Render diagrams locally**

  Run:

  ```bash
  mmdc -i engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd -o /tmp/FLY-3122-core-flow.svg -w 1000 -b white --svgId FLY-3122-d1
  mmdc -i engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd -o /tmp/FLY-3122-data-model.svg -w 1000 -b white --svgId FLY-3122-d2
  ```

  Expected: both commands exit `0`; the SVG ids are distinct and the HTML contains the freshly rendered self-contained SVGs.

- [ ] **Step 4: Verify allowed paths and HTML contract**

  Run:

  ```bash
  test ! -e probe.txt
  git diff --check
  git status --short
  ```

  Expected: only the six design artifacts above are modified. Static HTML checks must prove one nonced script, no inline handlers/CSP meta/external dependencies, one comment textarea below every card, pathname-scoped localStorage, live summary chunks beginning `【页面意见汇总】FLY-3122`, and clipboard rejection fallback.

- [ ] **Step 5: Commit design artifacts before review binding**

  Run:

  ```bash
  git add engineering/doc/FLY-3122-claude-turn-canary/exploration.md \
    engineering/doc/FLY-3122-claude-turn-canary/research.md \
    engineering/doc/FLY-3122-claude-turn-canary/plan.md \
    engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd \
    engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd \
    engineering/doc/FLY-3122-claude-turn-canary/founder-report.html
  git diff --cached --check
  git commit -m "docs(FLY-3122): correct canary execution boundaries"
  git push origin HEAD:project-slot-2-FLY-3122
  ```

  Expected: clean index/worktree and fast-forward push. `probe.txt` is absent from the commit.

- [ ] **Step 6: Open a new review gate and request**

  Run the injected `gate review_design --no-block "Design review requested for FLY-3122"`, save its returned `questionId` as `review_question_id`, then run `request-review --type design --question-id "$review_question_id" --plan engineering/doc/FLY-3122-claude-turn-canary/plan.md`.

  Expected: manifest binding sees committed plan bytes at HEAD. Poll once per turn until effective `reviewVerdict=APPROVED`; another `CHANGES_REQUESTED` requires a new fix commit and another new gate/request.

## Task 2: Publish approved design and complete only the design phase

**Files:**
- Read: `engineering/doc/FLY-3122-claude-turn-canary/founder-report.html`
- Update via CLI: `engineering/doc/FLY-3122-claude-turn-canary/progress.md`

- [ ] **Step 1: Publish the committed HTML**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" publish-report \
    --html engineering/doc/FLY-3122-claude-turn-canary/founder-report.html \
    --project test-slot-2 --publish-only
  ```

  Expected: JSON contains a hosted URL. `curl` that URL and verify HTTP `200`, no `__CSP_NONCE__`, one minted script nonce, both SVG ids, and no external asset fetches.

- [ ] **Step 2: Report the URL and update progress**

  Save the publisher's returned URL as `hosted_url`, run the injected `ask --lead flywheel-test-2 --exec-id "$FLYWHEEL_EXEC_ID" --report "DESIGN-HTML ready: ${hosted_url} | repo: engineering/doc/FLY-3122-claude-turn-canary/founder-report.html | issue: FLY-3122"`, then update progress to `6/6`.

- [ ] **Step 3: Complete design phase only**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" complete --route phase_design_complete
  ```

  Expected: phase completion receipt. Do not dispatch a successor, create a PR, request ship, or merge.

## Task 3: Conditional implement contract — only after Lead resolves DAG mismatch

**Files:**
- Create or append: `probe.txt` only if an exact marker instruction is delivered to the current implement execution

- [ ] **Step 1: Verify downstream authorization**

  Before any mutation, the implement node must have both:

  1. its own `node "$FLYWHEEL_COMM_CLI" turn --exec-id "$FLYWHEEL_EXEC_ID"` result beginning `yours`; and
  2. a Lead resolution that cancels/re-routes the creates-PR/land path or explicitly constrains this run to no-PR/no-ship.

  If item 2 is absent, ask the Lead, register a watcher on that question, and park. Template capability is not authorization.

- [ ] **Step 2: Inspect current-execution instructions**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
  ```

  Expected branch behavior:

  - no `[lead-instruction <id>]` with exact marker line → do not create or modify `probe.txt`; report that TURN was acknowledged and no marker was delivered;
  - exact marker instruction present → retain its full instruction id and exact literal, then continue.

- [ ] **Step 3: Check the worktree file, not only tracked Git content**

  Save the exact literal from the Lead message as `marker_line`, then run `grep -nxF -- "$marker_line" probe.txt` when the file exists. This is complete-line matching against the worktree, so it sees untracked recovery residue.

  Expected: zero matches means append once; one match means no duplicate; more than one match is an integrity error to report before commit.

- [ ] **Step 4: Append only the delivered line**

  Use `apply_patch` to preserve all existing lines and append the exact Lead-supplied literal with a terminal newline. Never substitute the issue title, driver-derived Claude literals, execution metadata, or a guessed marker.

- [ ] **Step 5: Verify and commit locally**

  Run complete-line verification with `grep -nxF` and `grep -cxF`, inspect `git diff -- probe.txt`, then:

  ```bash
  git add probe.txt
  git diff --cached --check
  git diff --cached --name-only
  git commit -m "test(FLY-3122): record requested transport marker"
  ```

  Expected: the staged name list is exactly `probe.txt`; marker count is exactly one. Do not push, create a PR, request ship, merge, or deploy under the current issue scope.

- [ ] **Step 6: Acknowledge the instruction**

  Use the required structured receipt:

  ```text
  DONE: [lead-instruction ${instruction_id}] appended the exact requested marker and committed only probe.txt locally | commits: ${commit_sha} | PR: n/a
  ```

  Send it through `ask --report`, never terminal prose. If there was no instruction, report TURN-only acknowledgment without claiming a marker commit.

## Task 4: QA contract

**Files:**
- Inspect: `probe.txt` if an implement commit exists
- Inspect: implement commit metadata and Lead instruction receipt

- [ ] **Step 1: Verify provenance**

  Confirm the marker literal is present in the actual Lead instruction addressed to the implement execution, the commit touches only `probe.txt`, and the exact complete line appears once.

- [ ] **Step 2: Verify negative boundaries**

  Confirm no driver-derived Claude receipt was added without instruction, no product file changed, and no PR / ship / deploy action occurred.

- [ ] **Step 3: Do not run a test suite**

  This is a pure text transport probe. Exact-line, diff, commit and message provenance are the complete evidence set; repository/package test suites are outside scope and locally forbidden.

## Rollback and handoff boundaries

- Before a probe commit, remove only the newly appended line with `apply_patch` if the instruction is revoked.
- After a local probe commit, use a new corrective commit; never force-push without explicit Lead confirmation.
- Design completion hands control back to the DAG orchestrator. It does not authorize successor dispatch, PR creation, ship, land, or deployment.
- The downstream no-shipping mismatch remains a Lead-owned orchestration decision until question `2add653c-7fb8-4cdd-ae4e-67651c476e39` is answered.
