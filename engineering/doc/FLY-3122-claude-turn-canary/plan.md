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
  node "$FLYWHEEL_COMM_CLI" park --exec-id "$FLYWHEEL_EXEC_ID" --reason "DAG workflow design parked until ship"
  ```

  Expected: phase completion receipt followed by a durable design hold. End the current turn after `park`; do not dispatch a successor, create a PR, request ship, merge, or deploy.

## Task 3: Conditional probe append in the authorized downstream execution

**Files:**
- Create or append: `probe.txt` only if an exact marker instruction is delivered to the current execution

- [ ] **Step 1: Acquire the downstream execution's TURN**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" turn
  ```

  Expected: output begins with `yours`. `not-yours` is a wait state; do not read it as write authority.

- [ ] **Step 2: Consume the native instruction from the turn input**

  Treat the current user turn's native envelope as the primary and authoritative carrier:

  - Claude receives `<teammate-message>` whose body begins `[lead-instruction <id>]`;
  - Codex receives the same envelope through its durable phase-wake/user-turn input.

  Capture the full `instruction_id` and the complete raw body after the envelope prefix. For this canary, **do not run `flywheel-comm inbox` to discover the marker**: `inbox` ACKs a QUEUED/LEASED row with carrier `inbox`, while an already natively delivered row is absent from `inbox`; either outcome destroys or misses the native-receive evidence. The generic inbox path is only a fallback for tasks that do not require native proof, so it does not apply here.

  Branch behavior:

  - no native `[lead-instruction <id>]` input: do not touch `probe.txt`; report that TURN was acknowledged but no native marker instruction arrived, then `park` with reason `FLY-3122 awaiting native marker instruction` and end the current turn;
  - native instruction present: validate the envelope id as a UUID, then use the runner's native text-edit API to write the complete raw body byte-for-byte to a dedicated file under a newly created `/tmp/FLY-3122-receipt.XXXXXX/` directory. Compute its SHA-256 and one-line base64 encoding from that file. Before any probe mutation, persist a supported progress receipt with `--handoff "instruction_id=${instruction_id};state=received;raw_sha256=${raw_sha256};raw_body_base64=${raw_body_b64}"` and put only a short resume summary in `--next`. Do **not** use `--set-chunk`: the CLI cannot create a dynamic chunk and silently drops unsupported statuses.

  On every resume, parse the frontmatter `handoff` receipt before acting. If it records the same id with `state=done` and the same raw-body hash, this is an at-least-once redelivery: do not repeat any mutation or external report. Re-check TURN, park idempotently, and end the turn. If it records `state=received`, resume from the durable raw body; if the same id arrives with a different hash, report an integrity error and park without writing.

- [ ] **Step 3: Extract exact marker line(s) without guessing**

  Accept exactly one of these instruction grammars:

  1. Canonical driver sentence: extract the byte substring between the single prefix `Append the exact line ` and the following single suffix ` to probe.txt`. The delimiters are instruction syntax; the interior substring is the marker and must not be trimmed or rewritten.
  2. Explicit block: after the exact label `Exact marker lines:`, accept one fenced `text` block. Fence lines and line terminators are framing; every non-empty interior line is one marker, preserved byte-for-byte.

  Reject the instruction without writing if neither grammar matches, both match, a delimiter is repeated, the fenced block is malformed, or the prose admits more than one extraction. Ask the Lead for an unambiguous literal and park. Do not infer a marker from the issue title, owner nonce, execution metadata, or surrounding prose.

  For shell-safe handling, write each extracted marker to its own temporary file with the runner's native text-edit API as exactly one line plus `\n`. Load it only with `IFS= read -r marker_line < "$marker_file"`, then require `printf '%s\n' "$marker_line" | cmp -s - "$marker_file"`. Never create a shell assignment by interpolating marker text and never use `eval`; this preserves printable `$`, backticks, backslashes, quotes, `!`, and leading/trailing spaces byte-for-byte.

- [ ] **Step 4: Validate every extracted marker before mutation**

  For each extracted marker line, verify all invariants before any append:

  ```text
  byte length: 1..512
  contains: printable ASCII only
  excludes: NUL, CR, LF, TAB
  matching rule: exact complete line
  ```

  If any line fails, leave `probe.txt` untouched and report the instruction id plus the failed invariant. Extraction removes only the specified instruction framing; never normalize, trim, interpolate, or repair marker bytes.

- [ ] **Step 5: Inspect the worktree file directly**

  Save each validated literal as `marker_line`, then run `grep -nxF -- "$marker_line" probe.txt` when the file exists. For each line:

  - zero matches: eligible to append;
  - one match: already complete, do not duplicate;
  - more than one match: integrity error, report before any write.

  If an existing non-empty `probe.txt` does not end in `\n`, reject the append and report the malformed file rather than joining two records.

- [ ] **Step 6: Handle an already-complete delivery without a false commit**

  If every marker already appears exactly once, do not create an empty commit and do not claim a new append. For each marker, enumerate `probe.txt` history oldest-to-newest and identify the first commit where the exact complete-line count changes from `0` in its parent to `1` in the commit. Inspect `git show --format= --unified=0 "$sha" -- probe.txt` and confirm that, after excluding diff headers, the exact data line `+${marker_line}` is among that commit's additions. A substring-only `git log -S` match is not sufficient. Save the verified introducing SHA(s) for the durable done receipt.

  - If the same instruction id was already `done`, emit no second DONE report.
  - If the id was only `received`, send a truthful receipt saying the exact marker was already present and name the verified introducing SHA(s).
  - If no introducing commit exists, treat the line as uncommitted recovery residue, add it to `expected_staged_markers`, and continue to the staged-diff path instead of inventing provenance.

- [ ] **Step 7: Append only missing exact lines with a runner-neutral operation**

  Preserve all existing content. Use the runner's native text-edit tool, or load `marker_line` from its verified temporary file and append one line with the tool-neutral command `printf '%s\n' "$marker_line" >> probe.txt`. Repeat only for markers whose exact-line count was zero. Do not substitute issue-title text, driver-derived Claude literals, execution metadata, or a guessed marker.

- [ ] **Step 8: Verify the staged bytes and commit only the probe locally**

  For every delivered line, run `grep -nxF` and `grep -cxF`; every count must equal `1`. Then inspect and commit:

  ```bash
  git diff --check -- probe.txt
  git diff -- probe.txt
  git add probe.txt
  git diff --cached --check
  git diff --cached --name-only
  git diff --cached --unified=0 -- probe.txt
  git commit -m "test(FLY-3122): record requested transport marker"
  ```

  Expected: the staged name list is exactly `probe.txt`; the staged diff deletes no lines; and its added data lines (excluding diff headers) equal `expected_staged_markers` byte-for-byte. That set is the ordered union of previously missing markers and verified uncommitted recovery-residue markers. This staged-diff assertion is mandatory when `probe.txt` is new because an unstaged diff does not show untracked content. The local commit contains only that append or recovered append. Do not push, create a PR, request ship, merge, or deploy.

- [ ] **Step 9: Persist completion and acknowledge the instruction truthfully**

  Send this receipt through the injected `ask --report` channel:

  Obtain the probe commit with `git log -1 --format=%H -- probe.txt`, verify its changed-path list is exactly `probe.txt`, then update the supported progress `handoff` field to `instruction_id=${instruction_id};state=done;raw_sha256=${raw_sha256};raw_body_base64=${raw_body_b64};probe_shas=${probe_shas}` and set `--next` to a short completion/park summary. Re-read `progress.md` and verify the receipt survived serialization before sending:

  ```text
  DONE: [lead-instruction ${instruction_id}] appended the exact requested marker line(s) and committed only probe.txt locally | commits: ${commit_sha} | PR: n/a
  ```

  Do not use `git log -1` without the `-- probe.txt` path filter, because a progress commit may be newer. Do not use a remembered SHA. If only TURN was delivered, report TURN acknowledgment without claiming a marker commit.

- [ ] **Step 10: Park for Lead-controlled workflow close/cancel**

  This DAG's implement completion route is pinned to `needs_review`, which requires a PR. The issue forbids push/PR/ship, and a changed repository makes `no_code` stale; therefore the implement node must not call `complete` with a fabricated or mismatched route. Ask the Lead to close or cancel the bounded run without dispatching QA/land, capture that question id, then run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" park --exec-id "$FLYWHEEL_EXEC_ID" --reason "FLY-3122 bounded local-only probe complete; awaiting Lead workflow close/cancel"
  ```

  End the current turn. On wake, run `turn` first, check the close/cancel question, and remain read-only unless TURN still answers `yours` and a new explicit instruction requires action.

## Task 4: QA evidence contract

**Files:**
- Inspect: `probe.txt` if an implement commit exists
- Inspect: implement commit metadata and Lead instruction receipt

- [ ] **Step 1: Follow the no-PR QA path only if QA was already activated**

  The intended terminal action is Lead close/cancel before QA dispatch. If a QA node nevertheless exists, it first acquires its own TURN, remains read-only, and never opens an approve gate or calls a PR-dependent completion route.

- [ ] **Step 2: Verify provenance**

  Confirm every marker literal appears in the actual Lead instruction addressed to the write execution, the commit touches only `probe.txt`, and every exact complete line appears once.

- [ ] **Step 3: Verify negative boundaries**

  Confirm no driver-derived Claude receipt was added without instruction, no product file changed, and no push / PR / ship / deploy action occurred.

- [ ] **Step 4: Report the bounded no-PR verdict and park**

  Send a structured `ask --report` with either `DONE: FLY-3122 no-PR QA PASS` plus the verified instruction id / marker / probe SHA, or `DONE: FLY-3122 no-PR QA FAIL` plus the exact contradiction. Ask the Lead to close/cancel the run, then `park` with reason `FLY-3122 no-PR QA awaiting Lead workflow close/cancel` and end the current turn. Do not emit a PR-bound `qa-result`, open an approve gate, request ship, or dispatch another node.

- [ ] **Step 5: Do not run a test suite**

  This is a pure text transport probe. Exact-line, diff, commit and message provenance are the complete evidence set; repository/package test suites are outside scope and locally forbidden.

## Rollback and handoff boundaries

- Before a probe commit, use the runner's native text-edit operation to remove only newly appended line(s) if the instruction is revoked.
- After a local probe commit, use a new corrective commit; never force-push without explicit Lead confirmation.
- Design completion hands control back to the DAG orchestrator. It does not authorize successor dispatch, PR creation, ship, land, or deployment.
- Lead question `861c3d24-e859-4352-bd91-93fc3e4af0c1` is resolved: no exact marker is currently verifiable; only a later execution that actually receives one may append it, and no PR / ship / deploy action is allowed. This ruling cannot retroactively authorize a marker written before delivery.
