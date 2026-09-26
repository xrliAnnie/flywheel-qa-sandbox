# FLY-202 QA 沙箱说明夹具 — 实施计划
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Execute inline in the authorized implementation node; do not dispatch subagents or successors.

**Goal:** 从当前 sandbox checkout 重新取证，确保 `doc/qa/sandbox-notes.md` 逐项满足 FLY-202；只在 evidence mismatch 时最小修改，并把现有 branch fast-forward push 到 PR #196。

**Architecture:** 目标 Markdown 是由三类 source facts 生成的 materialized view：repository root directories、`packages/qa-framework/README.md`、live `doc/` listing。实现先运行 bounded validator；PASS 时保持目标字节不变，FAIL 时只修复失败字段。现有 PR #196 是唯一 carrier，不重写 published history。

**Tech Stack:** Markdown、POSIX shell、Git、GitHub CLI (`gh`)、只读 Node.js 验证脚本

---

## 文件结构

| 文件 | 操作 | 单一职责 |
| --- | --- | --- |
| `doc/qa/sandbox-notes.md` | Verify; modify only on mismatch | FLY-202 用户可见 fixture |
| `packages/qa-framework/README.md` | Read only | QA framework 摘要 source of truth |
| `engineering/doc/FLY-202-sandbox-notes-e2e/progress.md` | Flywheel command only | restart-resilient cursor；不得手工与 target 同 commit 编辑 |

不新增 verifier、runtime code、migration、config 或测试文件。preserved baseline `ab1d379b1` 已包含上一轮
implementation milestone；不要回滚它，也不要为了产生新 commit 而无条件改写 target。

### Task 0: 取得实现节点写权限并核对 carrier

**Files:** none (read-only checks)

- [ ] **Step 1: 取得 implementation TURN 并检查 inbox**

运行 implementation dispatch 注入的精确 `flywheel-comm turn` 与 `inbox` 命令。

Expected: `turn` 返回 `yours phase=implement`。若为 `not-yours`，每 60–90 秒继续 poll；不得写 shared
worktree，也不得把正常 wait 标为 blocked。

- [ ] **Step 2: 核对 branch、remote 与 PR**

Run:

```bash
git fetch origin main --quiet
git remote get-url origin
git branch --show-current
git rev-list --count HEAD..origin/main
gh pr view 196 --json number,state,isDraft,headRefName,headRefOid,baseRefName,url
```

Expected:

- origin = `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`；
- branch = `project-slot-1-FLY-202`；
- behind = `0`；
- PR #196 = OPEN、非 draft、head 为当前 branch、base=`main`。

若 behind > 0，不自行 rebase 或 force-push；记录事实并按 implementation node 的 technical-sync authority
处理。不要因为 PR title/body 仍描述 FLY-2456 而另开 PR。

- [ ] **Step 3: 更新 progress cursor**

用 dispatch 注入的 exact exec id 和 progress path 写 `implement 1/6`，next step 指向 Task 1。只能通过
`flywheel-comm progress` 更新该文件。

### Task 1: 发现相关测试与收集 source facts

**Files:**

- Read: `doc/qa/sandbox-notes.md`
- Read: `packages/qa-framework/README.md`

- [ ] **Step 1: 按 local-test-policy 搜索所有消费者**

Run:

```bash
git grep -lF -- 'doc/qa/sandbox-notes.md' || true
git grep -lF -- 'sandbox-notes.md' || true
git grep -lF -- 'doc/qa' || true
git grep -lF -- 'FLY-2456 drill marker r2 B1' || true
git grep -lF -- 'Flywheel QA Sandbox Notes' || true
```

Expected: exact target/name matches只包含 FLY-202 docs/report/milestone；`doc/qa` 的 test matches 只消费
generic config/path，不解析 target。逐项记录排除原因；没有 concrete test file 时不得运行 bare Vitest、
package suite 或 repository suite。

- [ ] **Step 2: 枚举 tracked 与 live 顶层目录**

Run:

```bash
git ls-tree -d --name-only HEAD | LC_ALL=C sort
find . -mindepth 1 -maxdepth 1 -type d -not -name .git -exec basename {} \; | LC_ALL=C sort
```

Expected: 两份集合相同。设计时是以下 17 项：

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

若集合变化，当前命令输出优先；先解释 tracked/live 差异，再决定是否更新 table。

- [ ] **Step 3: 完整读取 QA README 与 live listing**

Run:

```bash
sed -n '1,180p' packages/qa-framework/README.md
sed -n '181,360p' packages/qa-framework/README.md
LC_ALL=C ls -R doc/ | head -50
```

Expected: README 仍覆盖 framework purpose、two-layer model、five-step protocol、adoption/config、real
Runner slots、deploy/inject/teardown、prerequisites、start-point boundary、special modes、guides/contracts；
listing 恰有 50 行。

- [ ] **Step 4: 更新 progress cursor**

写 `implement 2/6`，next step 指向 Task 2。

### Task 2: 先运行 bounded validator（RED-or-already-GREEN）

**Files:**

- Verify: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: 运行单文件结构与 live-output validator**

Run:

```bash
node <<'NODE'
const fs = require('node:fs');
const cp = require('node:child_process');
const text = fs.readFileSync('doc/qa/sandbox-notes.md', 'utf8');
if (!text.startsWith('# Flywheel QA Sandbox Notes\n')) throw new Error('wrong title');
const intro = text.split('\n## Top-level directories\n')[0].split('\n\n').slice(1).filter(Boolean);
if (intro.length < 2 || intro.length > 3) throw new Error(`expected 2-3 intro paragraphs, got ${intro.length}`);
const tracked = cp.execFileSync('git', ['ls-tree', '-d', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').sort();
const liveDirs = cp.execFileSync('sh', ['-c', "find . -mindepth 1 -maxdepth 1 -type d -not -name .git -exec basename {} \\; | LC_ALL=C sort"], { encoding: 'utf8' }).trim().split('\n');
if (JSON.stringify(tracked) !== JSON.stringify(liveDirs)) throw new Error('tracked/live directory sets differ');
const directorySection = text.split('## Top-level directories\n')[1].split('\n## `packages/qa-framework/README.md` summary')[0];
const tableDirs = [...directorySection.matchAll(/^\| `([^\u0060]+)\/` \|/gm)].map(match => match[1]).sort();
if (JSON.stringify(tableDirs) !== JSON.stringify(tracked)) throw new Error('directory table mismatch');
const summary = text.split('## `packages/qa-framework/README.md` summary\n')[1].split('\n## `doc/` listing')[0];
const bullets = summary.match(/^- /gm) || [];
if (bullets.length !== 10) throw new Error(`expected 10 summary bullets, got ${bullets.length}`);
const block = text.match(/Command: `ls -R doc\/ \| head -50`\n\n```text\n([\s\S]*?)\n```/);
if (!block || block[1].split('\n').length !== 50) throw new Error('listing fence must contain 50 lines');
const liveListing = cp.execFileSync('sh', ['-c', 'ls -R doc/ | head -50'], {
  encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
}).replace(/\n$/, '');
if (block[1] !== liveListing) throw new Error('captured doc listing does not match current checkout');
if (!text.includes('- FLY-2456 drill marker r2 B1')) throw new Error('inherited marker removed');
console.log('sandbox-notes structure: PASS');
NODE
```

Expected on design baseline: `sandbox-notes structure: PASS`.

- [ ] **Step 2: 分支选择**

- PASS：记录 already-GREEN；不得改写 target，直接进入 Task 4。
- FAIL：错误消息就是 Task 3 的精确 repair scope；先保存 RED output，再进入 Task 3。

- [ ] **Step 3: 更新 progress cursor**

写 `implement 3/6`；PASS 时 next=`Task 4 final verification`，FAIL 时 next=`Task 3 minimal repair`。

### Task 3: 只在 mismatch 时最小修复

**Files:**

- Modify conditionally: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: 修复 intro（仅当 paragraph / content mismatch）**

保持 2–3 段，并完整覆盖：

1. sandbox 是 test slots 运行 genuine Runner E2E 的 isolated GitHub fork；
2. 隔离允许真实 Git、GitHub 与 gate 行为而不影响 production；
3. repository 是 disposable test infrastructure，工作留在 slot clone，production Leads/Runners 不得拾取
   fixture issues。

- [ ] **Step 2: 修复目录表（仅当 set mismatch）**

第一列必须与 Task 1 的 current tracked/live intersection 一一对应，带 trailing `/`；第二列各用一句
plain-language description。`.git` 与临时目录不得加入。

- [ ] **Step 3: 修复 README 摘要（仅当 count / semantic mismatch）**

写恰好 10 条，每条分别覆盖 Task 1 Step 3 的十个概念组；用原创摘要，不复制 source 大段文字。

- [ ] **Step 4: 修复 listing（仅当 byte mismatch）**

用 `LC_ALL=C ls -R doc/ | head -50` 的 exact stdout 替换 fenced `text` block 内容，保留 command label 与
fence 后的 inherited marker。

- [ ] **Step 5: 重跑 Task 2 validator**

Expected: `sandbox-notes structure: PASS`。若仍失败，只处理该错误，不扩大范围。

- [ ] **Step 6: 更新 progress cursor**

写 `implement 4/6`，next step 指向 Task 4。

### Task 4: Final verification

**Files:**

- Verify: `doc/qa/sandbox-notes.md`
- Verify: branch diff and PR state

- [ ] **Step 1: 重跑 Task 2 validator 与 whitespace check**

Run Task 2 Step 1 again, then:

```bash
git diff --check
```

Expected: validator PASS；`git diff --check` exit 0、无输出。

- [ ] **Step 2: 核对 scope**

Run:

```bash
git diff --name-status ab1d379b1...HEAD
git status --short
```

Expected: 本轮只包含 authorized FLY-202 process docs/report/progress；若 Task 3 触发，可额外包含
`doc/qa/sandbox-notes.md`。不得出现 `packages/**`、runtime、migration、secret 或 production config。

- [ ] **Step 3: lint（非 test-suite evidence）**

Run:

```bash
pnpm lint
```

Expected: exit 0。报告时只称 repository lint，不称 full tests。没有 TypeScript change，故不运行
`vitest related`；discovery 没有 concrete target consumer，故没有 retained concrete test file。

- [ ] **Step 4: 更新 progress cursor**

写 `implement 5/6`，next step 指向 Task 5。

### Task 5: Commit（如需要）、push、核对 PR 并 handoff

**Files:**

- Commit conditionally: `doc/qa/sandbox-notes.md`
- Progress: injected progress path via Flywheel command

- [ ] **Step 1: 若 Task 3 有 target diff，提交最小修改**

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-202): refresh sandbox notes from current evidence"
```

Expected: commit 只含 target。若 Task 2 already-GREEN，跳过本步且不得创建 empty commit；preserved
history 已满足 issue 的 commit requirement。

- [ ] **Step 2: push 当前 branch**

```bash
git push origin HEAD:project-slot-1-FLY-202
```

Expected: fast-forward success；不得使用 `--no-verify`、force 或 force-with-lease。

- [ ] **Step 3: 核对 remote head 与 PR**

```bash
local_head=$(git rev-parse HEAD)
remote_head=$(git ls-remote origin refs/heads/project-slot-1-FLY-202 | awk '{print $1}')
test "$local_head" = "$remote_head"
gh pr view 196 --json number,state,isDraft,headRefName,headRefOid,baseRefName,url
```

Expected: local = remote = PR head OID；PR OPEN、非 draft、head current branch、base main。

- [ ] **Step 4: 最终 progress 与 completion**

用 injected command 写 `implement 6/6`，报告 exact SHA、PR URL、target changed/no-op、validator 与 lint
结果，然后按 implementation dispatch 的 exact completion route 完成节点。不得 merge、request ship
approval 或 dispatch successor。

## Requirement-to-evidence map

| Issue requirement | Authoritative evidence |
| --- | --- |
| 2–3 purpose paragraphs | bounded parser count + direct content review against three required statements |
| every top-level directory | tracked/live enumeration equality + table-set equality |
| approximately 10 README bullets | complete source read + direct semantic review + exact ten-bullet count |
| command output in fenced block | live command vs fenced block byte equality + 50-line count |
| feature branch and PR against main | Git branch/remote + PR #196 head/base/state + remote-head equality |
| sandbox only / no production | diff-scope review + absence of deploy/merge/DB/config actions |
