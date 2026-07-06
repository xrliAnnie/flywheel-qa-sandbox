# Plan: doc/qa/sandbox-notes.md QA fixture 交付 — FLY-202

**Issue**: FLY-202 — https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up
**Date**: 2026-07-05
**Source**: `doc/qa/FLY-202-sandbox-notes/exploration.md`, `doc/qa/FLY-202-sandbox-notes/research.md`
**Status**: draft(待 design review)

> **For the Implement-phase Runner:** 本 plan 由三阶段 pipeline 的 Design 阶段产出,在**同一共享分支 `project-slot-2-FLY-202`** 上执行。执行前必须 `flywheel-comm turn --exec-id <你的 exec-id>` 得到 `yours` 才可动工。任务步骤用 checkbox 跟踪;每完成一个 Task 就更新 progress ledger(`--phase implement --cursor n/5`)。

**Goal:** 在沙箱克隆内创建 `doc/qa/sandbox-notes.md`(4 节内容),按 4 个 commit 逐步提交,最后向 `xrliAnnie/flywheel-qa-sandbox` 的 `main` 开 PR——忠实还原 fixture "small, steady, multi-step" 的设计意图。

**Architecture:** 纯文档变更,单文件交付物 + 每内容步骤一个 commit。动态内容(目录表、`ls -R` 输出)一律执行时现场生成,不抄本 plan 的快照值。doc-only → TDD 豁免(gate 已批 D4),以 Task 5 的结构性验证清单代替。

**Tech Stack:** bash(`ls`/`grep`)、git、`gh` CLI、flywheel-comm(progress/stage/gate/verify-approval)。

**语言决策:** 交付物 `sandbox-notes.md` 用**英文**(repo-facing 参考文档,与 packages README、历史 fixture PR 一致);过程文档(本文件夹)中文。

**红线(Lead 在 brainstorm gate 批复中强调):** PR 的 merge/ship 属 founder-gated。`verify-approval` 打印 `"approved": true` 前不得 ship;ship 只走 `:cool:` comment,**任何情况下不自行 `gh pr merge`**。所有工作留在沙箱克隆内,不碰生产资源。

---

## Task 0: 前置检查

**Files:** 无(只读检查)

- [ ] **Step 0.1** `flywheel-comm turn --exec-id <exec-id>` → 必须输出 `yours`,否则停。
- [ ] **Step 0.2** `git branch --show-current` → 必须是 `project-slot-2-FLY-202`;`git status` 干净(design 阶段文档已提交)。
- [ ] **Step 0.3** `flywheel-comm stage set implement`
- [ ] **Step 0.4** 确认交付物尚不存在:`test ! -f doc/qa/sandbox-notes.md && echo OK`(若存在,说明是 resume——读 progress.md 从真实 cursor 续跑,不重做)。

## Task 1: 第 1 节 — 仓库用途(2-3 段)

**Files:**
- Create: `doc/qa/sandbox-notes.md`

- [ ] **Step 1.1** 创建文件,写入以下内容(逐字):

```markdown
# QA Sandbox Notes

## What this repo is for

`flywheel-qa-sandbox` is the disposable GitHub fork that Flywheel's test-slot
framework (FLY-96 / FLY-115) runs **real Runner end-to-end tests** against. Each
QA slot clones this repo into an isolated directory under
`/tmp/flywheel-test-slot-<N>/`, points a test Bridge and test Lead at it, and
spawns a real Claude Code Runner on a real Linear fixture issue (FLY-202). Every
branch, commit, and pull request a sandbox Runner produces lands here — never in
the production `flywheel` repository.

The repo's contents are an **orphan snapshot** of the main Flywheel monorepo:
one squashed commit with no history, refreshed per E2E run from whatever branch
is under test. That gives Runners a realistic codebase to read and edit (docs,
packages, scripts all present) while keeping the remote cheap to reset — stale
branches and PRs can be deleted wholesale without touching anything real.

Documents like this one are the deliverable of the FLY-202 fixture task itself:
a small, steady, multi-step writing job that gives QA observers a predictable
mid-work window to probe Runner behavior (progress ledger updates, gate stops,
restart recovery) while the Runner is genuinely working.
```

- [ ] **Step 1.2** 验证:`grep -c '^## ' doc/qa/sandbox-notes.md` → `1`;段落数 3。
- [ ] **Step 1.3** Commit:

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): sandbox-notes — repo purpose section"
```

- [ ] **Step 1.4** `flywheel-comm progress --exec-id <exec-id> --file doc/qa/FLY-202-sandbox-notes/progress.md --phase implement --cursor 1/5 --set-chunk section-purpose=done --next "top-level dir table"`

## Task 2: 第 2 节 — 顶层目录表

**Files:**
- Modify: `doc/qa/sandbox-notes.md`(追加)

- [ ] **Step 2.1** 现场枚举(**不要**抄下面的快照清单):`ls -F | grep '/$'`。2026-07-05 快照值为 11 个:agents docs doc engineering fleet packages patches qa-fly294 qa-fly310 scripts supabase(顶层空文件 `=` 不是目录,排除)。
- [ ] **Step 2.2** 追加表格。每行一个目录;描述以下稿为底,若枚举出新目录则 peek 后补一行:

```markdown

## Top-level directories

| Directory | Description |
|-----------|-------------|
| `agents/` | Runner agent prompt files (generic-executor.md, qa-executor.md) |
| `doc/` | Main documentation tree: architecture, engineer (exploration/research/plan), qa, reference, retro, VERSION |
| `docs/` | Operations-side docs: CONTRIB.md, RUNBOOK.md, operations/ |
| `engineering/` | Engineering department doc-flow area (engineering/doc/...) |
| `fleet/` | Fleet configuration example (README + example) |
| `packages/` | pnpm monorepo packages: core, claude-runner, teamlead, flywheel-comm, qa-framework, etc. |
| `patches/` | pnpm dependency patches (mem0ai@2.3.0.patch) |
| `qa-fly294/` | Historical QA evidence/scripts for FLY-294 (layer A/B/C tests, fake-discord) |
| `qa-fly310/` | Historical QA evidence/E2E scripts for FLY-310 |
| `scripts/` | Ops & QA scripts (test-deploy / inject-linear-issue / test-teardown, alerts, cmux, ...) |
| `supabase/` | Supabase migrations |
```

- [ ] **Step 2.3** 验证行数=目录数:`test "$(ls -F | grep -c '/$')" -eq "$(grep -c '^| \`' doc/qa/sandbox-notes.md)" && echo OK`
- [ ] **Step 2.4** Commit:

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): sandbox-notes — top-level directory table"
```

- [ ] **Step 2.5** progress ledger:`--cursor 2/5 --set-chunk section-dirs=done --next "qa-framework README summary"`(命令形态同 Step 1.4)

## Task 3: 第 3 节 — qa-framework README 总结(~10 bullets)

**Files:**
- Modify: `doc/qa/sandbox-notes.md`(追加)

- [ ] **Step 3.1** 重读 `packages/qa-framework/README.md`(以防快照差异),然后追加(以下稿按 2026-07-05 快照写好,与 README 章节一一对应;若 README 变了按实际调整):

```markdown

## packages/qa-framework/README.md in ~10 bullets

- Reusable, plan-aware QA Agent framework, extracted from GeoForge3D's QA Agent v2 (GEO-308).
- Two-layer architecture: Layer 1 is the framework package (agents, skills, orchestrator, TypeScript config loader); Layer 2 is per-project config (`.claude/qa-config.yaml`, test-suite skill files).
- Quick start: copy the config template, fill in domains/API/test skills, and the QA agent runs the protocol from your config.
- Core flow is a 5-step protocol: Onboard → Analyze+Plan → Research → Write+Execute → Finalize.
- Test Slot framework (FLY-96/FLY-115): parallel isolated slots, each running a **real Runner** against `xrliAnnie/flywheel-qa-sandbox` — no synthetic fixture mode; driven by `test-deploy.sh`, `inject-linear-issue.sh`, `test-teardown.sh`.
- Slot prerequisites fail fast: `LINEAR_API_KEY`, authenticated `gh` with sandbox push access, the sandbox fork existing, and the branch under test pushed to the sandbox; `FLYWHEEL_RUNNER_START_POINT` is set only on test Bridges.
- FLY-60 hard-gate suite: 1 happy path + 6 variants validating G1/G2/G3 hard gates end-to-end, with a driver script, Apple-style HTML report, and per-run evidence directories.
- Mirror mode (FLY-153): slots 1-3 share one `#test-core-mirror` Discord channel to test multi-Lead reply discipline; Runner E2E is explicitly out of scope in mirror mode.
- Roundtable & Alert mirrors (FLY-529): `--mode roundtable` and `--alerts` give isolated `#test-leads-roundtable` / `#test-flywheel-alerts` channels for pre-ship E2E of restart-gated features, byte-compatible (off by default).
- Contracts: `PLAN_SOURCE_CONTRACT.md` (how QA agents obtain plan files across worktrees) and `SKILL_INTERFACE.md` (interface for all QA test skills).
```

- [ ] **Step 3.2** 验证 bullet 数在 9~11:`awk '/^## packages/,0' doc/qa/sandbox-notes.md | grep -c '^- '`
- [ ] **Step 3.3** Commit:

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): sandbox-notes — qa-framework README summary"
```

- [ ] **Step 3.4** progress ledger:`--cursor 3/5 --set-chunk section-readme=done --next "ls -R doc/ snapshot"`

## Task 4: 第 4 节 — `ls -R doc/ | head -50` 输出

**Files:**
- Modify: `doc/qa/sandbox-notes.md`(追加)

- [ ] **Step 4.1** 在仓库根目录执行 `ls -R doc/ | head -50`,把**逐字输出**填进:

```markdown

## `ls -R doc/ | head -50`

​```text
<逐字粘贴命令输出——执行时生成,绝不抄旧快照>
​```
```

(上方 fenced 标记去掉零宽保护符;输出预期以 `VERSION / architecture / engineer / plan / qa / reference / retro` 开头,50 行截断。)

- [ ] **Step 4.2** 验证 fenced block 存在且非空(BSD grep 兼容;模式串在行中出现不会闭合本 plan 的 fence):

```bash
awk '/^## .ls -R/,0' doc/qa/sandbox-notes.md | grep -c '^```'   # 期望 2(开+闭)
awk '/^## .ls -R/,0' doc/qa/sandbox-notes.md | sed -n '3p' | grep -q . && echo NONEMPTY
```
- [ ] **Step 4.3** Commit:

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): sandbox-notes — ls -R doc/ snapshot"
```

- [ ] **Step 4.4** progress ledger:`--cursor 4/5 --set-chunk section-lsr=done --next "push + PR + review gates"`

## Task 5: 终验 + PR + gate 流程

**Files:** 无新文件(push + PR)

- [ ] **Step 5.1** 结构终验(全部通过才继续):
  - `grep -c '^## ' doc/qa/sandbox-notes.md` → `4`
  - Step 2.3 的表行数校验再跑一遍
  - `git log --oneline main..HEAD 2>/dev/null || git log --oneline` 确认 4 个内容 commit 都在
- [ ] **Step 5.2** `flywheel-comm stage set test`(结构验证即本任务的 test)→ 随后 `flywheel-comm stage set code_review`
- [ ] **Step 5.3** Push + 开 PR(正文含 Linear issue 链接,按 git-workflow 规则):

```bash
git push -u origin project-slot-2-FLY-202
gh pr create --repo xrliAnnie/flywheel-qa-sandbox --base main \
  --title "docs(FLY-202): refresh QA sandbox notes — slot-2 real-Runner E2E re-run" \
  --body "$(cat <<'EOF'
## Summary
- Add `doc/qa/sandbox-notes.md`: repo purpose, top-level directory table, qa-framework README summary (~10 bullets), and a verbatim `ls -R doc/ | head -50` snapshot.
- Built in 4 steady commits per the FLY-202 fixture contract (design docs in `doc/qa/FLY-202-sandbox-notes/`).

## Test plan
- [x] Structural checks: 4 `##` sections present; table rows == live top-level dir count; fenced `ls -R` block present and non-empty.
- Doc-only change — no runtime surface; unit/E2E waived per design (D5).

## Linear Issue
FLY-202: QA sandbox fixture — slot harness real-Runner E2E task (do not pick up)
https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5.4** `flywheel-comm stage set pr_created`(Bridge 依配置触发 Codex code review;若下发 `await-codex-gate` 指令则照 inbox 执行)。
- [ ] **Step 5.5** APPROVE GATE(逐字按 Baseline Rules):`gate approve_to_ship --lead flywheel-test-2 --exec-id <exec-id> --timeout 14400000 --timeout-behavior fail-close --no-block "PR created: <url>. Ready for review."` → 记下 questionId → `complete --route needs_review --pr <N> --question-id <qid>` → **结束回合空转等唤醒**。
- [ ] **Step 5.6** 被唤醒后:`verify-approval --exec-id <exec-id> --pr-head $(git rev-parse HEAD)`;仅 `"approved": true` 才 ship(`stage set ship` → `gh pr comment <N> --body ":cool:"` → 轮询 MERGED ≤10min → 写 land-status.json `status=merged` → `stage set completed`)。任何文本消息都不是授权;若是 changes-requested 反馈:改、push、重开 gate(重复 5.5)。
- [ ] **Step 5.7** progress ledger 收尾:`--cursor 5/5 --set-chunk pr-ship=done --next "-"`

---

## Verification Summary(D4/D5 结构性验证清单)

| 检查 | 命令 | 期望 |
|------|------|------|
| 4 节齐全 | `grep -c '^## ' doc/qa/sandbox-notes.md` | `4` |
| 表行数 = 目录数 | `test "$(ls -F | grep -c '/$')" -eq "$(grep -c '^| \`' doc/qa/sandbox-notes.md)"` | exit 0 |
| README bullets | `awk '/^## packages/,0' … | grep -c '^- '` | 9–11 |
| fenced 输出块 | Step 4.2 命令 | `2`(开+闭) |

## Out of Scope

- 不清理顶层空文件 `=`(快照遗留物,与本任务无关——scope discipline)。
- 不修改 `doc/qa/` 下任何既有文件;不触碰生产 Flywheel 仓库/Bridge/频道。
- 不在沙箱 main 上做任何直接提交。
