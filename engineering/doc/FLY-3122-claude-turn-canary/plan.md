# FLY-3122 Claude 标签传输探针 — 实施计划
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: research.md

> **For agentic workers:** 按 phase ownership 执行；design node 只产文档、HTML 与 review，implement node 只消费明确送达自己的 Lead instruction。禁止跨 execution 复制 marker，也禁止为本 issue 创建 PR、ship 或 deploy。

**Goal:** 诚实记录当前 Codex design TURN，产出经批准的条件式下游合同；只有实际写入 execution 收到 exact Lead marker instruction 时才修改 `probe.txt`。

**Architecture:** Execution identity、TURN receipt 和 Lead instruction 是三道独立证据。TURN 只授予当前 phase 写权，不提供 marker 内容；marker 内容只能来自明确发给当前 execution 的 message。Design evidence 与可选的 probe commit 分属不同 phase，不能在审查前混写。

**Tech Stack:** UTF-8 plain text、Git、`flywheel-comm`、Mermaid CLI (`mmdc`)。

---

## 文件矩阵

| 路径 | Owner phase | 动作 | 单一职责 |
|---|---|---|---|
| `engineering/doc/FLY-3122-claude-turn-canary/exploration.md` | design | Create | 范围、备选方案与拒绝理由 |
| `engineering/doc/FLY-3122-claude-turn-canary/research.md` | design | Create | execution 事实、driver 边界、phase ownership |
| `engineering/doc/FLY-3122-claude-turn-canary/plan.md` | design | Create | phase-safe 实施合同 |
| `engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd` | design | Create | 条件式核心流程 Mermaid source |
| `engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd` | design | Create | identity / TURN / instruction / evidence 模型 |
| `engineering/doc/FLY-3122-claude-turn-canary/founder-report.html` | design | Create | Founder 可读摘要与评论层 |
| `engineering/doc/FLY-3122-claude-turn-canary/progress.md` | `flywheel-comm` | Update | restart-resilient phase cursor |
| `probe.txt` | implement only, conditional | Append only | 保存当前 execution 被明确要求写入的 exact marker lines |

## Task 1: 完成并审查 design artifacts

**Files:**
- Create: `engineering/doc/FLY-3122-claude-turn-canary/exploration.md`
- Create: `engineering/doc/FLY-3122-claude-turn-canary/research.md`
- Create: `engineering/doc/FLY-3122-claude-turn-canary/plan.md`
- Create: `engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd`
- Create: `engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd`
- Create: `engineering/doc/FLY-3122-claude-turn-canary/founder-report.html`
- Must not modify: `probe.txt`

- [ ] **Step 1: 确认当前 design TURN**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" turn
  ```

  Expected: output begins with `yours`. Do not hardcode a future execution id or phase; `not-yours` means no worktree write.

- [ ] **Step 2: Render diagrams locally**

  Run each diagram separately:

  ```bash
  mmdc -i engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd -o /tmp/FLY-3122-core-flow.svg -w 1000 -b white --svgId FLY-3122-d1
  mmdc -i engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd -o /tmp/FLY-3122-data-model.svg -w 1000 -b white --svgId FLY-3122-d2
  ```

  Expected: both commands exit `0`; SVG ids are distinct. Inline the rendered SVGs into the HTML without adding runtime Mermaid or an external asset.

- [ ] **Step 3: Verify allowed paths and HTML contract**

  Run:

  ```bash
  test ! -e probe.txt
  git diff --check
  git status --short
  ```

  Expected: only the six design artifacts plus CLI-managed `progress.md` are new or modified. Static HTML inspection proves one `<script nonce="__CSP_NONCE__">`, no inline event handlers, no CSP meta, no external dependency, a comment textarea below every section/card, pathname-scoped localStorage, summary chunks beginning `【页面意见汇总】FLY-3122`, and clipboard rejection fallback.

- [ ] **Step 4: Commit and push design artifacts**

  Run:

  ```bash
  git add engineering/doc/FLY-3122-claude-turn-canary
  git diff --cached --check
  git diff --cached --name-only
  git commit -m "docs(FLY-3122): design Claude transport probe"
  git push -u origin project-slot-3-FLY-3122
  ```

  Expected: the staged list is confined to `engineering/doc/FLY-3122-claude-turn-canary/`; push is fast-forward; `probe.txt` is absent.

- [ ] **Step 5: Request explicit design review**

  Run the injected `stage set design_review` and `gate review_design --no-block "Design review requested for FLY-3122"` commands. Save the returned `questionId` as `review_question_id`, then run `request-review --type design --question-id "$review_question_id" --plan engineering/doc/FLY-3122-claude-turn-canary/plan.md`.

  Expected: review binds committed plan bytes at HEAD. Poll once per turn until effective `reviewVerdict=APPROVED`; `CHANGES_REQUESTED` requires a fix commit and a new gate/request.

## Task 2: Publish approved design and complete only the design phase

**Files:**
- Read: `engineering/doc/FLY-3122-claude-turn-canary/founder-report.html`
- Update via CLI: `engineering/doc/FLY-3122-claude-turn-canary/progress.md`

- [ ] **Step 1: Publish committed HTML**

  Run the injected `publish-report --html engineering/doc/FLY-3122-claude-turn-canary/founder-report.html --project test-slot-3 --publish-only` command.

  Expected: the result contains a hosted URL. Fetch the URL and verify HTTP `200`, absence of `__CSP_NONCE__`, one minted script nonce, both SVG ids, and no external asset fetches.

- [ ] **Step 2: Report URL and update progress**

  Save the publisher result as `hosted_url`. Send the injected `ask --report "DESIGN-HTML ready: ${hosted_url} | repo: engineering/doc/FLY-3122-claude-turn-canary/founder-report.html | issue: FLY-3122"`, then update progress to `6/6`.

- [ ] **Step 3: Complete design phase only**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" complete --route phase_design_complete
  ```

  Expected: phase completion receipt. Do not dispatch a successor, create a PR, request ship, merge, or deploy.

## Task 3: Conditional probe append in the authorized downstream execution

**Files:**
- Create or append: `probe.txt` only if an exact marker instruction is delivered to the current execution

- [ ] **Step 1: Acquire the downstream execution's TURN**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" turn
  ```

  Expected: output begins with `yours`. `not-yours` is a wait state; do not read it as write authority.

- [ ] **Step 2: Inspect current-execution instructions**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
  ```

  Branch behavior:

  - no `[lead-instruction <id>]` containing exact marker line(s): do not create or modify `probe.txt`; report that TURN was acknowledged and no marker was delivered, then wait for the specific question or instruction;
  - exact marker instruction present: retain its full instruction id and raw literal line(s), then continue.

- [ ] **Step 3: Validate every delivered marker before mutation**

  For each raw marker line, verify all invariants before any append:

  ```text
  byte length: 1..512
  contains: printable ASCII only
  excludes: NUL, CR, LF, TAB
  matching rule: exact complete line
  ```

  If any line fails, leave `probe.txt` untouched and report the instruction id plus the failed invariant. Never normalize, trim, interpolate, or repair the literal.

- [ ] **Step 4: Inspect the worktree file directly**

  Save each validated literal as `marker_line`, then run `grep -nxF -- "$marker_line" probe.txt` when the file exists. For each line:

  - zero matches: eligible to append;
  - one match: already complete, do not duplicate;
  - more than one match: integrity error, report before any write.

  If an existing non-empty `probe.txt` does not end in `\n`, reject the append and report the malformed file rather than joining two records.

- [ ] **Step 5: Append only missing exact lines**

  Use `apply_patch` to preserve all existing content and append each missing raw literal once with a terminal newline. Do not substitute issue-title text, driver-derived Claude literals, execution metadata, or a guessed marker.

- [ ] **Step 6: Verify and commit only the probe locally**

  For every delivered line, run `grep -nxF` and `grep -cxF`; every count must equal `1`. Then inspect and commit:

  ```bash
  git diff --check -- probe.txt
  git diff -- probe.txt
  git add probe.txt
  git diff --cached --check
  git diff --cached --name-only
  git commit -m "test(FLY-3122): record requested transport marker"
  ```

  Expected: the staged name list is exactly `probe.txt`, and the local commit contains only the requested append. Do not push, create a PR, request ship, merge, or deploy.

- [ ] **Step 7: Acknowledge the instruction**

  Send this receipt through the injected `ask --report` channel:

  Save the full instruction id as `instruction_id` and the output of `git log -1 --format=%H` as `commit_sha`, then send:

  ```text
  DONE: [lead-instruction ${instruction_id}] appended the exact requested marker line(s) and committed only probe.txt locally | commits: ${commit_sha} | PR: n/a
  ```

  Do not use a remembered SHA. If only TURN was delivered, report TURN acknowledgment without claiming a marker commit.

## Task 4: QA evidence contract

**Files:**
- Inspect: `probe.txt` if an implement commit exists
- Inspect: implement commit metadata and Lead instruction receipt

- [ ] **Step 1: Verify provenance**

  Confirm every marker literal appears in the actual Lead instruction addressed to the write execution, the commit touches only `probe.txt`, and every exact complete line appears once.

- [ ] **Step 2: Verify negative boundaries**

  Confirm no driver-derived Claude receipt was added without instruction, no product file changed, and no push / PR / ship / deploy action occurred.

- [ ] **Step 3: Do not run a test suite**

  This is a pure text transport probe. Exact-line, diff, commit and message provenance are the complete evidence set; repository/package test suites are outside scope and locally forbidden.

## Rollback and handoff boundaries

- Before a probe commit, remove only the newly appended line(s) with `apply_patch` if the instruction is revoked.
- After a local probe commit, use a new corrective commit; never force-push without explicit Lead confirmation.
- Design completion hands control back to the DAG orchestrator. It does not authorize successor dispatch, PR creation, ship, land, or deployment.
- Lead question `861c3d24-e859-4352-bd91-93fc3e4af0c1` is resolved: no exact marker is currently verifiable; only a later execution that actually receives one may append it, and no PR / ship / deploy action is allowed. This ruling cannot retroactively authorize a marker written before delivery.
