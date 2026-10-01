# FLY-3125 原生传输探针 — 实施计划
Issue: FLY-3125 (https://linear.app/geoforge3d/issue/FLY-3125/529-canary-fly2127-canary-23c3c581-a0f6-45a5-af84-804d707f1ed5-native)
日期: 2026-10-01
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use the workflow skill required by the active phase. Follow phase ownership and the injected TURN; do not dispatch successors. This bounded canary never creates a PR, pushes a marker commit, ships, merges, deploys, or runs a test suite.

**Goal:** Produce an approved, founder-visible design that records this execution's TURN and defines how a later execution may append only marker bytes delivered natively to that same execution.

**Architecture:** Execution identity, TURN receipt, and native instruction are three independent facts. TURN grants one phase permission to write the shared worktree; only an exact instruction bound to the same execution supplies marker bytes. Design evidence and a conditional local-only marker commit therefore have separate owners and lifecycles.

**Tech Stack:** UTF-8 plain text, Git, `flywheel-comm`, Mermaid CLI (`mmdc`), self-contained HTML/CSS/JavaScript.

---

## 文件矩阵

| 路径 | Owner phase | 动作 | 单一职责 |
|---|---|---|---|
| `engineering/doc/FLY-3125-native-transport-canary/exploration.md` | design | Create | 范围、事实与方案比较 |
| `engineering/doc/FLY-3125-native-transport-canary/research.md` | design | Create | identity、driver 与 provenance 边界 |
| `engineering/doc/FLY-3125-native-transport-canary/plan.md` | design | Create | phase-safe 执行合同 |
| `engineering/doc/FLY-3125-native-transport-canary/core-flow.mmd` | design | Create | 条件式核心流程 Mermaid source |
| `engineering/doc/FLY-3125-native-transport-canary/core-flow.svg` | design | Create | 本地渲染的核心流程 SVG |
| `engineering/doc/FLY-3125-native-transport-canary/data-model.mmd` | design | Create | identity / TURN / instruction / evidence 模型 |
| `engineering/doc/FLY-3125-native-transport-canary/data-model.svg` | design | Create | 本地渲染的数据模型 SVG |
| `engineering/doc/FLY-3125-native-transport-canary/founder-report.html` | design | Create | Founder 友好摘要与逐节评论层 |
| `engineering/doc/FLY-3125-native-transport-canary/progress.md` | progress CLI | Update | restart-resilient cursor |
| `probe.txt` | downstream, conditional | Append only | 保存绑定当前 writer execution 的 exact marker lines |

### Task 1: 完成并审查 design artifacts

**Files:**
- Create: `engineering/doc/FLY-3125-native-transport-canary/{exploration.md,research.md,plan.md,core-flow.mmd,data-model.mmd,founder-report.html}`
- Update via CLI: `engineering/doc/FLY-3125-native-transport-canary/progress.md`
- Must not modify: `probe.txt`

- [ ] **Step 1: 确认当前 design TURN**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" turn
  ```

  Expected: output begins with `yours phase=design`. `not-yours` means wait and perform no worktree write.

- [ ] **Step 2: 本地渲染两个 Mermaid diagrams**

  Run:

  ```bash
  mmdc -i engineering/doc/FLY-3125-native-transport-canary/core-flow.mmd -o engineering/doc/FLY-3125-native-transport-canary/core-flow.svg -w 1000 -b white --svgId FLY-3125-d1
  mmdc -i engineering/doc/FLY-3125-native-transport-canary/data-model.mmd -o engineering/doc/FLY-3125-native-transport-canary/data-model.svg -w 1000 -b white --svgId FLY-3125-d2
  ```

  Expected: both exit `0` with distinct SVG ids. Inline the SVG markup into HTML; do not load Mermaid at runtime or fetch remote assets.

- [ ] **Step 3: 验证 design-only scope 与 HTML contract**

  Run:

  ```bash
  test ! -e probe.txt
  git diff --check
  git status --short
  ```

  Expected: changes are confined to the issue doc folder. HTML has exactly one `<script nonce="__CSP_NONCE__">`, no inline event attributes, no CSP meta, and no external dependencies. Every section/card is immediately followed by a pathname-scoped comment textarea; the summary chunks begin with `【页面意见汇总】FLY-3125`; clipboard promise rejection uses the `document.execCommand('copy')` fallback.

- [ ] **Step 4: Commit and push design artifacts**

  Run:

  ```bash
  git add engineering/doc/FLY-3125-native-transport-canary
  git diff --cached --check
  git diff --cached --name-only
  git commit -m "docs(FLY-3125): design native transport canary"
  git push -u origin project-slot-3-FLY-3125
  ```

  Expected: staged paths are confined to the issue doc folder, push is fast-forward, and `probe.txt` remains absent.

- [ ] **Step 5: Request explicit design review**

  Run the injected `stage set design_review`, `gate review_design --no-block "Design review requested for FLY-3125"`, and `request-review --type design --question-id <id> --plan engineering/doc/FLY-3125-native-transport-canary/plan.md` commands.

  Expected: review binds committed plan bytes. Poll once per turn until effective `reviewVerdict=APPROVED`; `CHANGES_REQUESTED` requires fixes and a new gate/request.

### Task 2: Publish the approved design and complete only the design phase

- [ ] **Step 1: Publish committed HTML**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" publish-report --html engineering/doc/FLY-3125-native-transport-canary/founder-report.html --project test-slot-3 --publish-only
  ```

  Expected: output contains a hosted URL. Fetch it and verify HTTP `200`, zero `__CSP_NONCE__` residue, one minted script nonce, both inlined SVG ids, and no external assets.

- [ ] **Step 2: Report and complete**

  Send the injected `ask --report "DESIGN-HTML ready: <hosted-url> | repo: engineering/doc/FLY-3125-native-transport-canary/founder-report.html | issue: FLY-3125"`, update progress to `6/6`, and run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" complete --route phase_design_complete
  ```

  Expected: phase completion receipt. Do not dispatch a successor, create a PR, request ship, merge, or deploy. Follow the controller's park/handoff epilogue.

### Task 3: Conditional exact-marker append in an authorized downstream execution

**Files:**
- Create or append: `probe.txt`, only when that execution receives an exact marker instruction bound to itself

- [ ] **Step 1: Acquire that execution's TURN**

  Run `node "$FLYWHEEL_COMM_CLI" turn`. Only `yours` authorizes mutation; `not-yours` is a normal wait state.

- [ ] **Step 2: Verify current-execution provenance**

  Require a current user/native instruction envelope containing the exact marker. The recipient identity must equal `$FLYWHEEL_EXEC_ID`; the sender must be the authorized Lead. A driver source file, issue title, owner nonce, previous execution transcript, inbox summary, or copied historical evidence is not a substitute.

- [ ] **Step 3: Extract without rewriting bytes**

  Accept exactly one grammar:

  1. the substring between one `Append the exact line ` prefix and one following ` to probe.txt` suffix; or
  2. non-empty interior lines from one fenced `text` block following `Exact marker lines:`.

  Reject mixed, repeated, malformed, or ambiguous framing. Each marker must be 1..512 bytes printable ASCII, contain no NUL, CR, LF, or TAB, and begin and end with a non-space byte. Do not trim or normalize marker bytes.

- [ ] **Step 4: Check exact-line state**

  If `probe.txt` is absent, the count is zero. For an existing file, run complete-line fixed-string checks for each marker:

  ```bash
  grep -nxF -- "$marker_line" probe.txt
  grep -cxF -- "$marker_line" probe.txt
  ```

  Zero matches means append is eligible, one means idempotently complete, and more than one is an integrity error. Reject an existing non-empty file without a final LF.

- [ ] **Step 5: Append only missing markers and inspect staged bytes**

  Store each validated marker as exact bytes plus LF in a temporary file, then append it as data. Never interpolate marker text into shell source or `eval`. Verify:

  ```bash
  git diff --check -- probe.txt
  git add probe.txt
  git diff --cached --check
  git diff --cached --name-only
  git diff --cached --unified=0 -- probe.txt
  ```

  Expected: every requested marker appears exactly once; staged paths equal `probe.txt`; the patch deletes no lines and adds only requested bytes.

- [ ] **Step 6: Commit locally and report truthfully**

  Run:

  ```bash
  git commit -m "test(FLY-3125): record requested transport marker"
  git log -1 --format=%H -- probe.txt
  git show --format= --name-only HEAD
  ```

  Expected: the commit changes exactly `probe.txt`. Report the native instruction id, path-filtered SHA, and `PR: n/a` through `ask --report`. Do not push, create a PR, request ship, merge, or deploy.

### Task 4: Read-only QA contract if a QA node is activated

- [ ] Verify marker bytes came from the write execution's own native instruction.
- [ ] Verify each complete marker line appears once and the commit changes only `probe.txt`.
- [ ] Verify no product path, push, PR, ship, merge, deployment, or test suite was involved.
- [ ] Report the bounded verdict through the injected structured receipt and follow the authorized park/close route.

## Negative guards

- `TURN=yours` must never be interpreted as marker content.
- A historical exact marker with the same owner must never be copied into a new execution.
- Design review approval authorizes the design only; it does not authorize a marker mutation, PR, ship, merge, or deploy.
- The comment summary marker `【页面意见汇总】FLY-3125` is revision feedback, never an approval signal.
- HTML-derived strings use `textContent`/`value`; issue/repository text is escaped before static markup interpolation.

## Rollback boundary

Design docs can be reverted as one docs commit. Any later marker commit is separate and local-only; it can be reverted with `git revert <probe-sha>` because it changes only `probe.txt`. Rollback must not rewrite branch history or touch runtime services.
