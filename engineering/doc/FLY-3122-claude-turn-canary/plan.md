# FLY-3122 Claude TURN 金丝雀 — 实施计划
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: research.md

> **For agentic workers:** 逐项执行本计划；这是 bounded transport canary，不分派 subagent，不进入产品实现流程。

**Goal:** 在持有 FLY-3122 design TURN 时，把 FLY-2127 driver 定义的两条 exact marker 幂等追加到 root `probe.txt`，留下 feature-branch commit evidence。

**Architecture:** `probe.txt` 是唯一探针载体；owner nonce 绑定本次 canary，两个 suffix 分别表示 boot 与 R4 Claude marker。Git commit 是持久回执，`flywheel-comm turn` 的 `yours` 是写入授权。

**Tech Stack:** UTF-8 plain text、Git、`flywheel-comm`。

---

## 文件矩阵

| 路径 | 动作 | 单一职责 |
|---|---|---|
| `probe.txt` | Create or append | 保存两条 exact canary marker line |
| `engineering/doc/FLY-3122-claude-turn-canary/exploration.md` | 已创建 | 记录范围、选择与拒绝方案 |
| `engineering/doc/FLY-3122-claude-turn-canary/research.md` | 已创建 | 锁定 driver 来源与 literal |
| `engineering/doc/FLY-3122-claude-turn-canary/plan.md` | 本文件 | 给出可执行步骤与验收证据 |
| `engineering/doc/FLY-3122-claude-turn-canary/founder-report.html` | Create | Founder 可读的设计摘要与评论层 |
| `engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd` | Create | 核心流程 Mermaid source |
| `engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd` | Create | 数据/结构 Mermaid source |
| `engineering/doc/FLY-3122-claude-turn-canary/progress.md` | flywheel-comm 管理 | restart-resilient phase cursor |

### Task 1: 确认授权与前置状态

**Files:**
- Inspect: `probe.txt`

- [ ] **Step 1: 重查 TURN**

  Run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" turn --exec-id 4514c33a-ba5c-4eb3-a046-08bb14e6b209
  ```

  Expected: 输出以 `yours phase=design` 开头；若为 `not-yours`，不触碰 worktree，按 TURN WAIT LAW 停驻。

- [ ] **Step 2: 检查 exact literals 与当前文件**

  Run:

  ```bash
  git grep -nF -- 'FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-CLAUDE-BOOT' -- probe.txt || true
  git grep -nF -- 'FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-R4-CLAUDE' -- probe.txt || true
  ```

  Expected: fresh branch has no matches. A pre-existing complete-line match means that line must not be duplicated.

### Task 2: 追加 bounded marker

**Files:**
- Create or modify: `probe.txt`

- [ ] **Step 1: 用 patch 幂等追加 exact lines**

  Required final content for a fresh file:

  ```text
  FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-CLAUDE-BOOT
  FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-R4-CLAUDE
  ```

  If `probe.txt` exists, preserve every existing byte and append only missing complete lines with a terminal newline.

- [ ] **Step 2: 验证 exact-line multiplicity**

  Run:

  ```bash
  test "$(grep -cxF 'FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-CLAUDE-BOOT' probe.txt)" -eq 1
  test "$(grep -cxF 'FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-R4-CLAUDE' probe.txt)" -eq 1
  ```

  Expected: both commands exit `0`.

- [ ] **Step 3: 检查负向边界**

  Run:

  ```bash
  git diff -- probe.txt
  git status --short
  ```

  Expected: `probe.txt` contains only the two intended additions; all other changes are this phase's required docs/HTML/progress artifacts，no product source files.

### Task 3: 完成设计审查与 Founder artifact

**Files:**
- Create: `engineering/doc/FLY-3122-claude-turn-canary/core-flow.mmd`
- Create: `engineering/doc/FLY-3122-claude-turn-canary/data-model.mmd`
- Create: `engineering/doc/FLY-3122-claude-turn-canary/founder-report.html`

- [ ] **Step 1: 请求显式 design review**

  Run exact injected `stage set design_review`、`gate review_design --no-block` 和 `request-review --type design --plan .../plan.md` commands.

  Expected: `check <questionId>` 最终返回 effective `APPROVED`；`CHANGES_REQUESTED` 必须先修复并以新 gate/new request 重审。

- [ ] **Step 2: 构建并验证 HTML**

  Render two Mermaid sources locally with unique SVG ids `FLY-3122-d1` and `FLY-3122-d2`, inline their self-contained SVG, and keep all JavaScript in one `<script nonce="__CSP_NONCE__">` block.

  Expected: every card has autosaving comments; summary chunks start with `【页面意见汇总】FLY-3122`; no external dependencies, inline handlers, CSP meta, or unescaped derived HTML.

### Task 4: Commit、push、publish 与 phase handoff

**Files:**
- Commit: `probe.txt`
- Commit: `engineering/doc/FLY-3122-claude-turn-canary/*`

- [ ] **Step 1: 提交并推送 feature branch**

  Run:

  ```bash
  git add probe.txt engineering/doc/FLY-3122-claude-turn-canary
  git diff --cached --check
  git commit -m "test(FLY-3122): record Claude TURN canary"
  git push -u origin project-slot-2-FLY-3122
  ```

  Expected: clean index/worktree, push is fast-forward, and no main/ship action occurs.

- [ ] **Step 2: Publish and inspect hosted artifact**

  Run the injected `publish-report --publish-only` command, then `curl` the returned URL.

  Expected: HTTP `200`; hosted page contains a minted script nonce, contains no `__CSP_NONCE__`, and makes no external asset fetch.

- [ ] **Step 3: Structured report and completion**

  Report the hosted URL with injected `ask --report "DESIGN-HTML ready: ..."`, update progress to `6/6`, then run:

  ```bash
  node "$FLYWHEEL_COMM_CLI" complete --route phase_design_complete
  ```

  Expected: phase completion receipt. Do not dispatch a successor; the DAG orchestrator owns advancement.

## Verification coverage

- Exact literals: complete-line count equals one for BOOT and R4.
- Write authority: current TURN remains `yours` at mutation time.
- Scope: `git diff --name-only` contains only `probe.txt` plus required issue docs.
- Safety: no product tests are needed because no product code changes; no broad local suite is permitted.
- Rollback boundary: before push, revert only the new canary commit if review rejects it; after push, use a new corrective commit—never force-push without explicit Lead confirmation.
