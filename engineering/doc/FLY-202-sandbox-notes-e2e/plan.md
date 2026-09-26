# FLY-202 QA 沙箱说明夹具 — 实施计划
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Execute inline in the authorized implementation node; do not dispatch subagents or successors.

**Goal:** 按当前 sandbox checkout 原位刷新 `doc/qa/sandbox-notes.md`，逐项满足 FLY-202 的五个任务要求，并把结果 push 到现有 PR #196。

**Architecture:** 主交付物保持一个稳定 Markdown 路径。目录表由当前 repository root 生成，QA 摘要由当前 source README 归纳，命令证据由当前 checkout 实际执行后原样嵌入；现有 PR 是 carrier，不重写 published history。

**Tech Stack:** Markdown、POSIX shell、Git、GitHub CLI (`gh`)、只读 Node.js 验证脚本

---

## 文件结构

| 文件 | 操作 | 单一职责 |
| --- | --- | --- |
| `doc/qa/sandbox-notes.md` | Modify | FLY-202 的用户可见 fixture 产物 |
| `engineering/doc/FLY-202-sandbox-notes-e2e/progress.md` | Flywheel command only | restart-resilient phase cursor；不与主交付物同 commit 手工编辑 |

不修改 `packages/qa-framework/README.md`；它只是摘要的 source of truth。不新增 verifier、
runtime code、migration、config 或测试文件。

### Task 0: 取得实现节点写权限并核对 carrier

**Files:** none (read-only checks)

- [ ] **Step 1: 读取实现节点注入命令并取得 TURN**

运行 implementation dispatch 提供的精确 `flywheel-comm turn` 与 `inbox` 命令。

Expected: `turn` 返回 `yours phase=implement`。若是 `not-yours`，按 TURN WAIT LAW
每 60–90 秒继续 poll；不得写 shared worktree，也不得把正常等待标为 blocked。

- [ ] **Step 2: 核对 branch、PR 与 main 基线**

Run:

```bash
git fetch origin main --quiet
git branch --show-current
git rev-list --count origin/main..HEAD
git rev-list --count HEAD..origin/main
gh pr view 196 --json number,state,headRefName,headRefOid,baseRefName,url
```

Expected:

- branch = `project-slot-1-FLY-202`；
- PR #196 = OPEN，head 为同一 branch，base=`main`；
- behind = 0；ahead 只包含 inherited FLY-2456 marker、本 issue 设计产物和 progress commits。

不要因为 PR title/body 仍描述 FLY-2456 而另开 PR，也不要重锚、rebase 或 force-push。

### Task 1: 建立会失败的当前证据检查（RED）

**Files:**

- Read: `doc/qa/sandbox-notes.md`
- Read: `packages/qa-framework/README.md`

- [ ] **Step 1: 重新枚举顶层目录**

Run:

```bash
git ls-tree -d --name-only HEAD | LC_ALL=C sort
find . -mindepth 1 -maxdepth 1 -type d -not -name .git -exec basename {} \; | LC_ALL=C sort
```

Expected: 两份输出相同，当前为下列 17 项：

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

若集合变化，以当前两份命令的交集/差异为事实并在 commit 或交接中解释；不要照抄本计划。

- [ ] **Step 2: 执行 test discovery，记录排除理由**

Run:

```bash
git grep -lF -- 'doc/qa/sandbox-notes.md' || true
git grep -lF -- 'sandbox-notes.md' || true
git grep -lF -- 'doc/qa' || true
git grep -lF -- 'FLY-2456 drill marker r2 B1' || true
git grep -lF -- 'Flywheel QA Sandbox Notes' || true
```

Expected discovery record:

- exact path/name matches are historical FLY-202 design artifacts and the current process docs；无 concrete
  test file consumes the target document；
- parent-directory matches include `packages/qa-framework/__tests__/*.test.ts` and shell suites only
  because they mention generic `doc/qa` paths；它们不解析 `sandbox-notes.md`，故排除；
- the marker literal matches only the target file and current design docs；必须保留 inherited marker；
- title literal matches only the target file；用本计划的 bounded parser 直接验证它。

不得因为没有 concrete test match 而退回 bare Vitest、package suite 或 repository suite。

- [ ] **Step 3: 先证明当前 fenced listing 已过期**

Run this read-only parser:

```bash
node <<'NODE'
const fs = require('node:fs');
const cp = require('node:child_process');
const file = fs.readFileSync('doc/qa/sandbox-notes.md', 'utf8');
const match = file.match(/Command: `ls -R doc\/ \| head -50`\n\n```text\n([\s\S]*?)\n```/);
if (!match) throw new Error('missing required doc listing block');
const live = cp.execFileSync('sh', ['-c', 'ls -R doc/ | head -50'], { encoding: 'utf8' }).trimEnd();
if (match[1] !== live) throw new Error('captured doc listing does not match current checkout');
console.log('captured doc listing: PASS');
NODE
```

Expected before editing: FAIL with `captured doc listing does not match current checkout`. This is the
documentation contract’s RED evidence; do not “fix” the validator to accept stale output.

### Task 2: 刷新目标 Markdown（GREEN）

**Files:**

- Modify: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: 复核并保留 2–3 段仓库用途说明**

The introduction must remain exactly three prose paragraphs and cover these complete statements:

1. the sandbox is an isolated GitHub fork used by test slots to run a genuine Runner end to end；
2. isolation allows real Git/GitHub/gate behavior without production impact；
3. the repository is disposable test infrastructure, work stays in the slot clone, and production Leads/Runners
   must not pick up fixture issues。

Keep the existing precise explanations of slot-suffixed clones, `FLYWHEEL_RUNNER_START_POINT`, and
deploy/inject/teardown when they remain true after rereading the source docs.

- [ ] **Step 2: 复核完整目录表**

Keep one and only one row for every Task 1 directory. The first column must use these exact Markdown labels:

```markdown
| `.claude/` | Claude Code project commands, skills, QA configuration, and orchestrator helpers. |
| `.flywheel/` | Project-local Flywheel configuration and executor role definitions. |
| `.github/` | GitHub Actions workflows for repository CI and automation. |
| `.lead/` | Per-Lead identities and shared Lead rules. |
| `.serena/` | Serena project configuration and local metadata. |
| `agents/` | Runner executor role prompts. |
| `doc/` | Primary architecture, engineering, QA, plan, reference, and retrospective docs. |
| `docs/` | Contributor guidance and operational runbooks. |
| `engineering/` | Department-scoped engineering documents under doc-flow. |
| `fleet/` | Fleet manifests and managed-environment examples. |
| `packages/` | pnpm workspace packages for Flywheel runtime and tooling. |
| `patches/` | Version-controlled dependency patches. |
| `product/` | Issue-scoped product research, specifications, and prototypes. |
| `qa-fly294/` | Checked-in FLY-294 QA harness evidence. |
| `qa-fly310/` | Checked-in FLY-310 E2E scripts and evidence. |
| `scripts/` | Development, deployment, maintenance, and QA automation. |
| `supabase/` | Supabase CLI metadata and database migrations. |
```

If Task 1 finds a different directory set, update the table from that evidence rather than forcing 17 rows.

- [ ] **Step 3: 复核 QA README 摘要为恰好 10 条**

Read the complete current source:

```bash
sed -n '1,180p' packages/qa-framework/README.md
sed -n '181,360p' packages/qa-framework/README.md
```

Keep ten original-language summary bullets, one each for: framework purpose; two-layer model; five-step protocol;
adoption/config; real-Runner/no-synthetic slots; deploy/inject/teardown; prerequisites;
`FLYWHEEL_RUNNER_START_POINT`; hard-gate plus mirror/roundtable/alert modes; guides/contracts. Do not copy
source prose verbatim when a concise summary expresses the same fact.

- [ ] **Step 4: 替换 live command output 并保留 inherited marker**

Run `ls -R doc/ | head -50` after Steps 1–3, copy its exact stdout, and use `apply_patch` to
replace only the content inside the existing fenced `text` block. Keep the visible command label unchanged.
Keep `- FLY-2456 drill marker r2 B1` after the fence; it predates this run and is not authorized for removal.

### Task 3: 针对主交付物验证

**Files:**

- Verify: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: 重跑 listing parser**

Repeat Task 1 Step 3 exactly.

Expected: `captured doc listing: PASS`.

- [ ] **Step 2: 验证标题、段落、目录、bullet 和 fence**

Run:

```bash
node <<'NODE'
const fs = require('node:fs');
const cp = require('node:child_process');
const text = fs.readFileSync('doc/qa/sandbox-notes.md', 'utf8');
if (!text.startsWith('# Flywheel QA Sandbox Notes\n')) throw new Error('wrong title');
const intro = text.split('\n## Top-level directories\n')[0].split('\n\n').slice(1).filter(Boolean);
if (intro.length < 2 || intro.length > 3) throw new Error(`expected 2-3 intro paragraphs, got ${intro.length}`);
const liveDirs = cp.execFileSync('git', ['ls-tree', '-d', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').sort();
const section = text.split('## Top-level directories\n')[1].split('\n## `packages/qa-framework/README.md` summary')[0];
const tableDirs = [...section.matchAll(/^\| `([^\u0060]+)\/` \|/gm)].map(m => m[1]).sort();
if (JSON.stringify(tableDirs) !== JSON.stringify(liveDirs)) throw new Error('directory table mismatch');
const summary = text.split('## `packages/qa-framework/README.md` summary\n')[1].split('\n## `doc/` listing')[0];
const bullets = summary.match(/^- /gm) || [];
if (bullets.length !== 10) throw new Error(`expected 10 summary bullets, got ${bullets.length}`);
const block = text.match(/Command: `ls -R doc\/ \| head -50`\n\n```text\n([\s\S]*?)\n```/);
if (!block || block[1].split('\n').length !== 50) throw new Error('listing fence must contain 50 lines');
if (!text.includes('- FLY-2456 drill marker r2 B1')) throw new Error('inherited marker removed');
console.log('sandbox-notes structure: PASS');
NODE
```

Expected: `sandbox-notes structure: PASS`.

- [ ] **Step 3: 运行文档与 repository hygiene checks**

Run:

```bash
git diff --check
pnpm lint
git diff --name-status origin/main...HEAD
```

Expected:

- `git diff --check` exit 0 with no output；
- lint exit 0；
- diff includes inherited `doc/qa/sandbox-notes.md` plus FLY-202 design/progress artifacts only；
- no `packages/**`, runtime, migration, config, secret, or production-resource change。

There is no changed TypeScript, so `vitest related` does not apply. Discovery found no concrete test file for
this Markdown; record that exclusion instead of running a broad test command.

### Task 4: Commit、push 并复用 open PR

**Files:**

- Commit: `doc/qa/sandbox-notes.md`
- Do not manually stage unrelated files

- [ ] **Step 1: 更新 implementation progress cursor**

Use the implementation dispatch’s exact progress command and cursor. The command path-limits its own progress
commit; do not manually add `progress.md` to the deliverable commit.

- [ ] **Step 2: 检查 inbox 与 final diff**

Run the injected `inbox --exec-id ...` command, then:

```bash
git status --short
git diff -- doc/qa/sandbox-notes.md
git diff --check
```

Expected: only the intended notes refresh is unstaged; inherited and design commits remain committed.

- [ ] **Step 3: Commit 主交付物**

Run:

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): refresh QA sandbox notes — slot-1 real-Runner E2E"
```

Expected: one docs commit. If the file is byte-identical after evidence refresh, do not create an empty commit;
report the no-op with the validation evidence and follow the implementation node’s injected handoff.

- [ ] **Step 4: Push without rewriting history**

Run:

```bash
git push origin project-slot-1-FLY-202
```

Never use `--force`, `--force-with-lease` or `--no-verify`. A non-fast-forward rejection requires
the Lead protocol from the injected task; do not set an ACK without explicit authorization.

- [ ] **Step 5: Prove PR #196 carries the pushed head**

Run:

```bash
LOCAL_HEAD="$(git rev-parse HEAD)"
gh pr view 196 --json number,state,headRefName,headRefOid,baseRefName,url,files
printf '%s\n' "$LOCAL_HEAD"
```

Expected: PR OPEN, base=`main`, head branch=`project-slot-1-FLY-202`, and `headRefOid` equals
`LOCAL_HEAD`. Do not merge or request ship authority.

### Task 5: Implementation-node handoff

Follow the implementation dispatch’s exact code-review gate, report, completion route, and park epilogue.
The DAG orchestrator—not this plan and not the implementation runner—dispatches QA. Any later QA node should
re-run Task 3’s two bounded parsers and verify PR #196 remains open and unmerged.

## Requirement-to-evidence map

| Issue requirement | Authoritative evidence |
| --- | --- |
| 2–3 purpose paragraphs | bounded parser paragraph count + direct file review |
| every top-level directory | two live enumeration commands + exact table-set equality |
| ~10 README bullets | complete README read + exact 10-bullet count |
| command output in fence | live command vs fenced block byte comparison + 50-line count |
| feature branch + PR against main | Git branch + PR #196 head/base/state + remote head equality |
| sandbox only / no production | diff scope, no external deploy/merge/DB action, phase completion route |
