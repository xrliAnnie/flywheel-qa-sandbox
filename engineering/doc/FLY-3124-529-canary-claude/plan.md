# FLY-3124 Claude 传输探针 — 实施计划
Issue: FLY-3124 (https://linear.app/geoforge3d/issue/FLY-3124/529-canary-fly2127-canary-606b50d9-b7a4-44bf-b80b-6e932dd2421c-claude)
日期: 2026-10-01
基于: research.md

> **For agentic workers:** 按 phase ownership 执行。Design node 只产文档、HTML 与 review；downstream node 只消费明确送达自己的 exact marker instruction。禁止跨 execution 复制 marker，也禁止为本 issue 创建 PR、ship 或 deploy。

**Goal:** 诚实记录当前 Codex design TURN，产出经批准的下游合同；只有实际写入 execution 收到 exact marker instruction 时才修改并本地提交 `probe.txt`。

**Architecture:** Execution identity、TURN receipt 和 native Lead instruction 是三道独立证据。TURN 只授予当前 phase 写权，不提供 marker 内容；marker 内容只能来自明确送给当前 execution 的输入。Design evidence 与可选 probe commit 分属不同 phase。

**Tech Stack:** UTF-8 plain text、Git、`flywheel-comm`、Mermaid CLI (`mmdc`)。

---

## 文件矩阵

| 路径 | Owner phase | 动作 | 单一职责 |
|---|---|---|---|
| `engineering/doc/FLY-3124-529-canary-claude/exploration.md` | design | Create | 范围、事实、方案比较 |
| `engineering/doc/FLY-3124-529-canary-claude/research.md` | design | Create | identity、driver 与 phase 边界 |
| `engineering/doc/FLY-3124-529-canary-claude/plan.md` | design | Create | phase-safe 下游合同 |
| `engineering/doc/FLY-3124-529-canary-claude/core-flow.mmd` | design | Create | 条件式核心流程 |
| `engineering/doc/FLY-3124-529-canary-claude/data-model.mmd` | design | Create | identity / TURN / instruction / evidence 模型 |
| `engineering/doc/FLY-3124-529-canary-claude/founder-report.html` | design | Create | Founder 友好设计摘要与评论层 |
| `engineering/doc/FLY-3124-529-canary-claude/progress.md` | CLI | Update | restart-resilient cursor |
| `probe.txt` | downstream, conditional | Append only | 保存明确送达当前 execution 的 exact marker lines |

## Task 1: 完成并审查 design artifacts

**Files:**
- Create: `engineering/doc/FLY-3124-529-canary-claude/{exploration.md,research.md,plan.md,core-flow.mmd,data-model.mmd,founder-report.html}`
- Update via CLI: `engineering/doc/FLY-3124-529-canary-claude/progress.md`
- Must not modify: `probe.txt`

- [ ] **Step 1: 确认当前 design TURN**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" turn
  ```

  Expected: output begins with `yours phase=design`. `not-yours` means wait and perform no worktree write.

- [ ] **Step 2: 本地渲染两个 Mermaid diagram**

  Run:

  ```bash
  mmdc -i engineering/doc/FLY-3124-529-canary-claude/core-flow.mmd -o /tmp/FLY-3124-core-flow.svg -w 1000 -b white --svgId FLY-3124-d1
  mmdc -i engineering/doc/FLY-3124-529-canary-claude/data-model.mmd -o /tmp/FLY-3124-data-model.svg -w 1000 -b white --svgId FLY-3124-d2
  ```

  Expected: both exit `0`; SVG ids are distinct. Inline the SVG markup into the HTML; do not load Mermaid at runtime or fetch an external asset.

- [ ] **Step 3: 验证 design-only 路径与 HTML contract**

  Run:

  ```bash
  test ! -e probe.txt
  git diff --check
  git status --short
  ```

  Expected: changes are confined to the issue doc folder. HTML has exactly one `<script nonce="__CSP_NONCE__">`, no inline event attributes, no CSP meta, no external dependencies, a pathname-scoped comment textarea below every section/card, summary chunks beginning `【页面意见汇总】FLY-3124`, and clipboard rejection fallback.

- [ ] **Step 4: Commit and push design artifacts**

  Run:

  ```bash
  git add engineering/doc/FLY-3124-529-canary-claude
  git diff --cached --check
  git diff --cached --name-only
  git commit -m "docs(FLY-3124): design Claude transport probe"
  git push -u origin project-slot-3-FLY-3124
  ```

  Expected: staged paths are confined to the issue doc folder; push is fast-forward; `probe.txt` remains absent.

- [ ] **Step 5: Request explicit design review**

  Run the injected `stage set design_review`, `gate review_design --no-block "Design review requested for FLY-3124"`, and `request-review --type design --question-id <id> --plan engineering/doc/FLY-3124-529-canary-claude/plan.md` commands.

  Expected: review binds committed plan bytes. Poll once per turn until effective `reviewVerdict=APPROVED`; `CHANGES_REQUESTED` requires a fix commit and a new gate/request.

## Task 2: Publish approved design and complete only the design phase

- [ ] **Step 1: Publish committed HTML**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" publish-report --html engineering/doc/FLY-3124-529-canary-claude/founder-report.html --project test-slot-3 --publish-only
  ```

  Expected: output contains a hosted URL. Fetch it and verify HTTP `200`, zero `__CSP_NONCE__` residue, one minted script nonce, both inlined SVG ids, and no external asset requests.

- [ ] **Step 2: Report and complete**

  Send the injected `ask --report "DESIGN-HTML ready: <hosted-url> | repo: engineering/doc/FLY-3124-529-canary-claude/founder-report.html | issue: FLY-3124"`, update progress to `6/6`, and run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" complete --route phase_design_complete
  ```

  Expected: a phase completion receipt. Do not dispatch a successor, create a PR, request ship, merge, or deploy. Follow any completion epilogue emitted by the controller and end the turn.

## Task 3: Conditional exact-marker append in the authorized downstream execution

**Files:**
- Create or append: `probe.txt` only when an exact marker instruction is delivered to that execution

- [ ] **Step 1: Acquire that execution's TURN**

  Run `node "$FLYWHEEL_COMM_CLI" turn`. Only `yours` authorizes a mutation; `not-yours` is a normal wait state.

- [ ] **Step 2: Capture the native instruction or remain read-only**

  Use the current user turn's `[lead-instruction <uuid>]` envelope as the authoritative source. If it is absent, do not touch `probe.txt`; report that TURN was acknowledged but no marker arrived, then park/end the turn as directed. Do not infer a literal from the issue title, owner, external driver, or execution metadata.

  Persist the instruction id and raw-body SHA-256 in `progress.md` before mutation so at-least-once redelivery can be recognized. Same id + same hash + completed receipt is an idempotent no-op; same id + different hash is an integrity error.

- [ ] **Step 3: Extract without rewriting bytes**

  Accept exactly one grammar:

  1. the substring between one `Append the exact line ` prefix and one following ` to probe.txt` suffix; or
  2. non-empty interior lines from one fenced `text` block following `Exact marker lines:`.

  Reject mixed, repeated, malformed, or ambiguous framing. Each marker must be 1..512 bytes of printable ASCII and contain no NUL, CR, LF, or TAB. Do not trim or normalize marker bytes.

- [ ] **Step 4: Check current exact-line state**

  For every marker, inspect the worktree file with complete-line fixed-string matching:

  ```bash
  grep -nxF -- "$marker_line" probe.txt
  grep -cxF -- "$marker_line" probe.txt
  ```

  Zero matches means append is eligible; one means already complete; more than one is an integrity error. Reject an existing non-empty file lacking a final newline.

- [ ] **Step 5: Append only missing markers and verify the staged bytes**

  Append one exact line at a time, preserving existing content. Then run:

  ```bash
  git diff --check -- probe.txt
  git add probe.txt
  git diff --cached --check
  git diff --cached --name-only
  git diff --cached --unified=0 -- probe.txt
  ```

  Expected: every requested marker appears exactly once; staged name list is exactly `probe.txt`; the patch deletes no lines; added data lines equal the missing marker set byte-for-byte.

- [ ] **Step 6: Commit locally and report truthfully**

  Run:

  ```bash
  git commit -m "test(FLY-3124): record requested transport marker"
  git log -1 --format=%H -- probe.txt
  ```

  Verify the commit's changed-path list is exactly `probe.txt`. Send `ask --report` quoting the full `[lead-instruction <id>]`, the SHA copied from the path-filtered log, and `PR: n/a`. Do not push, create a PR, request review/ship, merge, or deploy.

- [ ] **Step 7: Hand control back to the Lead**

  Because this is local-only and the ordinary implement route may be PR-bound, do not fabricate a mismatched completion route. Ask the Lead to close/cancel the bounded workflow and follow the injected park instruction.

## Task 4: Read-only QA contract if a QA node is activated

- [ ] Verify the marker literal came from the write execution's native instruction.
- [ ] Verify each complete line appears once and the commit touches only `probe.txt`.
- [ ] Verify no product file, push, PR, ship, merge, or deployment occurred.
- [ ] Report the bounded no-PR verdict through `ask --report`, then follow the injected park/close route.
- [ ] Do not run a package or repository test suite; exact input, line count, diff, tree, and receipt are the complete evidence set.

## Rollback boundary

Design docs can be reverted as a single docs commit. A downstream marker commit can be reverted independently with `git revert <probe-sha>` because it changes only `probe.txt`; rollback must never rewrite branch history or touch runtime services.
