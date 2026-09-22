# FLY-2746 CI 切换 Ubicloud — 实施计划
Issue: FLY-2746 (https://linear.app/geoforge3d/issue/FLY-2746/ci切-ubicloud-ciyml-全部-job-从-ubuntu-latest-切到-ubicloudrepo-变量一键切换回滚先跑一次)
日期: 2026-09-18
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先用现有 canary 证明 `ubicloud-standard-2` 可执行本仓工作负载，再让 `ci.yml` 与 `ship-on-comment.yml` 的全部 job 通过一个缺省安全的 `CI_RUNNER` repo variable 切换或回滚 runner。

**Architecture:** GitHub 在调度 job 前解析 `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`。两个生产 workflow 的 job graph、检查名和 steps 完全不动，只替换 13 个 runner scalar；永久 contract 动态覆盖所有 job，一次性 fail-close diff 审计证明本 PR 没有夹带其他 workflow 改动。实现节点只交付 review-ready PR，post-merge variable write 与真实 PR/回滚验收留给被授权的后续节点。

**Tech Stack:** GitHub Actions YAML、Node.js `node:test`、GitHub CLI、现有 Flywheel workflow startup/structure contracts。

---

## 文件责任图

| 文件 | 责任 |
| --- | --- |
| `.github/workflows/ci.yml` | 10 个生产 CI job 读取同一个 runner variable |
| `.github/workflows/ship-on-comment.yml` | 3 个 ship job 与 CI 使用相同的 runner variable |
| `scripts/ci-ubicloud/__tests__/runner-variable.test.mjs` | 动态遍历当前及未来 job，锁定精确变量表达式与缺省语义 |
| `scripts/__tests__/workflow-startup.test.mjs` | 把 runner contract 纳入现有 Quick Gate 的 root Node suite |
| `engineering/doc/FLY-2746-ubicloud-ci-cutover/canary-receipt.md` | 保存不含 secret 的 canary run/job/runner evidence |
| `engineering/doc/FLY-2746-ubicloud-ci-cutover/pr-body.md` | 保存 PR 的范围、证据、边界与后续验收说明 |
| `engineering/doc/milestones/FLY-2746.md` | PR 最后一个 commit 的里程碑账本记录 |

## Task 1: 运行并取证 Ubicloud canary

**Files:**
- Create after the run: `engineering/doc/FLY-2746-ubicloud-ci-cutover/canary-receipt.md`
- Read: `.github/workflows/ci-ubicloud-canary.yml`

- [ ] **Step 1: 再次确认生产变量未被提前设置**

Run:

```sh
test -z "$(gh variable get CI_RUNNER --repo xrliAnnie/flywheel 2>/dev/null || true)"
test -z "$(gh run list --repo xrliAnnie/flywheel --workflow ci-ubicloud-canary.yml --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
```

Expected: 两条命令 exit 0；`CI_RUNNER` 缺失且 canary 仍无历史 run。

- [ ] **Step 2: 创建 canary-only 授权变量与随机 probe secret，并回读变量**

Run:

```sh
gh variable set UBICLOUD_CANARY_AUTHORIZED --repo xrliAnnie/flywheel --body true
test "$(gh variable get UBICLOUD_CANARY_AUTHORIZED --repo xrliAnnie/flywheel)" = true
openssl rand -hex 32 | gh secret set UBICLOUD_CANARY_PROBE --repo xrliAnnie/flywheel
gh secret list --repo xrliAnnie/flywheel --json name --jq 'any(.[]; .name == "UBICLOUD_CANARY_PROBE")' | grep -Fx true
```

Expected: 变量精确回读为 `true`，secret 名存在；命令与日志都不显示 secret 值。

- [ ] **Step 3: 在 main 上 dispatch 一次 Ubicloud payload canary 并绑定新 run id**

Run:

```sh
canary_previous_id="$(gh run list --repo xrliAnnie/flywheel --workflow ci-ubicloud-canary.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
gh workflow run ci-ubicloud-canary.yml --repo xrliAnnie/flywheel --ref main -f runner=ubicloud-standard-2 -f capacity=0
for canary_poll in $(seq 1 12); do
  canary_run_id="$(gh run list --repo xrliAnnie/flywheel --workflow ci-ubicloud-canary.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
  if [ "$canary_run_id" != 0 ] && [ "$canary_run_id" != "$canary_previous_id" ]; then break; fi
  sleep 5
done
test "$canary_run_id" != 0
test "$canary_run_id" != "$canary_previous_id"
printf 'canary_run_id=%s\n' "$canary_run_id"
```

Expected: 输出唯一的新 run id。

- [ ] **Step 4: 等待该 run，并核验 Quick Gate 的真实 runner**

Run:

```sh
gh run watch "$canary_run_id" --repo xrliAnnie/flywheel --exit-status
gh api --paginate "repos/xrliAnnie/flywheel/actions/runs/$canary_run_id/jobs?per_page=100" \
  --jq '.jobs[] | select(.name == "Ubicloud Canary / Quick Gate") | {id,name,status,conclusion,runner_name,labels,started_at,completed_at}'
gh run view "$canary_run_id" --repo xrliAnnie/flywheel --json databaseId,headSha,status,conclusion,url,createdAt,updatedAt
```

Expected: workflow conclusion `success`；Quick Gate conclusion `success`；`runner_name` 非空并标识 Ubicloud，labels 含 `ubicloud-standard-2`。如失败，先使用 systematic-debugging 查明真实 runner 差异；不得通过删 step、跳 job 或改测试来凑绿。

- [ ] **Step 5: 写入脱敏 receipt，然后清理 canary-only 状态**

`canary-receipt.md` 必须写入实际 run id/URL/head SHA、Quick Gate job id/conclusion/runner_name/labels/时间，以及全 workflow conclusion；不得写 probe secret 值。

Run:

```sh
gh secret delete UBICLOUD_CANARY_PROBE --repo xrliAnnie/flywheel
gh variable delete UBICLOUD_CANARY_AUTHORIZED --repo xrliAnnie/flywheel
test -z "$(gh variable get UBICLOUD_CANARY_AUTHORIZED --repo xrliAnnie/flywheel 2>/dev/null || true)"
test -z "$(gh secret list --repo xrliAnnie/flywheel --json name --jq '.[] | select(.name == "UBICLOUD_CANARY_PROBE") | .name')"
```

Expected: 两个 canary-only 值都不存在；`CI_RUNNER` 仍未设置。

## Task 2: RED — 增加 runner variable contract

**Files:**
- Create: `scripts/ci-ubicloud/__tests__/runner-variable.test.mjs`
- Modify: `scripts/__tests__/workflow-startup.test.mjs`

- [ ] **Step 1: 创建精确 contract test**

Create `scripts/ci-ubicloud/__tests__/runner-variable.test.mjs` with:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(
	new URL("../../../packages/teamlead/package.json", import.meta.url),
);
const { parse } = require("yaml");

const runnerExpression = "${{ vars.CI_RUNNER || 'ubuntu-latest' }}";
const workflows = [
	{
		name: "CI",
		url: new URL("../../../.github/workflows/ci.yml", import.meta.url),
	},
	{
		name: "Ship on :cool: Comment",
		url: new URL(
			"../../../.github/workflows/ship-on-comment.yml",
			import.meta.url,
		),
	},
];

test("CI and ship jobs use one rollback-safe runner variable", () => {
	for (const workflow of workflows) {
		const source = fs.readFileSync(workflow.url, "utf8");
		const parsed = parse(source);
		assert.equal(parsed.name, workflow.name);
		const jobs = Object.entries(parsed.jobs ?? {});
		assert.ok(jobs.length > 0, `${workflow.name} must contain jobs`);
		for (const [jobId, job] of jobs) {
			assert.equal(
				job["runs-on"],
				runnerExpression,
				`${workflow.name} job ${jobId} must use CI_RUNNER`,
			);
		}
	}
});
```

Add this import beside the existing canary imports in `scripts/__tests__/workflow-startup.test.mjs`:

```js
import "../ci-ubicloud/__tests__/runner-variable.test.mjs";
```

- [ ] **Step 2: 运行 RED，确认失败原因是 runner 仍为字面量**

Run:

```sh
node --test scripts/ci-ubicloud/__tests__/runner-variable.test.mjs
```

Expected: FAIL at a `runs-on` assertion, actual `ubuntu-latest`, expected `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`。不是 syntax/import error。

## Task 3: GREEN — 做 13 行最小 workflow 修改

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/ship-on-comment.yml`

- [ ] **Step 1: 替换两个目标 workflow 的每个 job runner**

For all 10 `ci.yml` jobs and all 3 `ship-on-comment.yml` jobs, replace exactly:

```yaml
runs-on: ubuntu-latest
```

with:

```yaml
runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
```

Do not modify any other line.

- [ ] **Step 2: 运行 GREEN**

Run:

```sh
node --test scripts/ci-ubicloud/__tests__/runner-variable.test.mjs
```

Expected: 1 test pass, 0 fail。

- [ ] **Step 3: 审计实际 diff**

Run:

```sh
git diff -- .github/workflows/ci.yml .github/workflows/ship-on-comment.yml
git diff --check
python3 - <<'PY'
import subprocess

paths = (
    ".github/workflows/ci.yml",
    ".github/workflows/ship-on-comment.yml",
)
diff = subprocess.check_output(
    ["git", "diff", "--unified=0", "--", *paths], text=True
)
removed = 0
added = 0
for line in diff.splitlines():
    if line.startswith(("diff --git ", "index ", "--- ", "+++ ", "@@")):
        continue
    if line == "-    runs-on: ubuntu-latest":
        removed += 1
        continue
    if line == "+    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}":
        added += 1
        continue
    raise SystemExit(f"unexpected workflow diff line: {line}")
if (removed, added) != (13, 13):
    raise SystemExit(f"expected 13 runner replacements, got removed={removed} added={added}")
print("runner-only workflow diff: 13/13 replacements")
PY
```

Expected: 输出 `runner-only workflow diff: 13/13 replacements`；任何非 runner 行、漏换或多换均 fail；无 whitespace error。该一次性证据写入 `pr-body.md`，永久测试不锁 live workflow 的整文件 hash。

## Task 4: Focused verification and implementation commit

**Files:**
- Test: `scripts/ci-ubicloud/__tests__/runner-variable.test.mjs`
- Test: `scripts/__tests__/workflow-startup.test.mjs`
- Test: `scripts/__tests__/ci-structure.test.sh`
- Test: `scripts/__tests__/release-workflows-structure.test.sh`
- Create: `engineering/doc/FLY-2746-ubicloud-ci-cutover/pr-body.md`

- [ ] **Step 1: 运行完整 workflow-focused gates**

Run each command separately:

```sh
node --test scripts/ci-ubicloud/__tests__/runner-variable.test.mjs
node --test scripts/ci-ubicloud/__tests__/canary.test.mjs
node scripts/check-workflow-startup.mjs
node --test scripts/__tests__/workflow-startup.test.mjs
bash scripts/__tests__/ci-structure.test.sh
bash scripts/__tests__/release-workflows-structure.test.sh
```

Expected: all exit 0；runner test 1/1，canary 2/2，startup validator 9 workflows，combined startup suite 16/16，CI structure PASS，release structure 25/25。

- [ ] **Step 2: 确认生产变量仍缺失**

Run:

```sh
test -z "$(gh variable get CI_RUNNER --repo xrliAnnie/flywheel 2>/dev/null || true)"
```

Expected: exit 0。

- [ ] **Step 3: 写 PR body，明确已证与未证边界**

Create `engineering/doc/FLY-2746-ubicloud-ci-cutover/pr-body.md` with the required title/Issue/date/based-on preamble, then these sections with actual evidence: `Summary`, `Canary receipt`, `RED/GREEN`, `Verification`, `Rollback`, `Boundaries`. It must state that `CI_RUNNER` remains absent until merge and that the real production PR plus deletion-based rollback runs are successor-owned acceptance evidence.

- [ ] **Step 4: 提交实现批次**

Run:

```sh
git add .github/workflows/ci.yml .github/workflows/ship-on-comment.yml scripts/ci-ubicloud/__tests__/runner-variable.test.mjs scripts/__tests__/workflow-startup.test.mjs engineering/doc/FLY-2746-ubicloud-ci-cutover/canary-receipt.md engineering/doc/FLY-2746-ubicloud-ci-cutover/pr-body.md
git commit -m "ci(FLY-2746): make CI runner switchable"
```

Expected: commit succeeds with only the scoped workflow, contract, import, and canary receipt files.

## Task 5: Full local verification

**Files:**
- Verify the committed tree

- [ ] **Step 1: 运行 lint、build 与 package aggregate**

Run each command separately:

```sh
pnpm lint
pnpm -r build
pnpm test:packages:run
```

Expected: all exit 0。若 package gate 只出现允许的 `onTaskUpdate` RPC noise，保留完整 PACKAGE_GATE_RECEIPT；任何 assertion failure 都必须修复。

- [ ] **Step 2: 复跑 workflow-focused gates 与 clean diff checks**

Run:

```sh
node --test scripts/__tests__/workflow-startup.test.mjs
bash scripts/__tests__/ci-structure.test.sh
bash scripts/__tests__/release-workflows-structure.test.sh
git diff --check HEAD^ HEAD
git status --short
```

Expected: tests pass, diff check clean；除待提交的 process docs/progress 外没有意外修改。

## Task 6: 里程碑作为最后 commit，并获取有效 code review

**Files:**
- Create: `engineering/doc/milestones/FLY-2746.md`
- Update before milestone commit: `engineering/doc/FLY-2746-ubicloud-ci-cutover/progress.md`

- [ ] **Step 1: 在 milestone 前最后一次写 progress ledger**

Run the injected progress command with cursor `7/8`, completed chunks `canary`, `tdd`, `implementation`, and `verification`, and next step `Create literal-last milestone commit, request code review, push and open PR`.

- [ ] **Step 2: 按 `engineering/doc/milestones/README.md` 创建里程碑并作为最后 commit**

The milestone records: canary run/job receipt, 10+3 variable-backed jobs, focused/full local verification, `CI_RUNNER` intentionally absent, and post-merge switch/rollback still pending for the authorized successor.

Run:

```sh
git add engineering/doc/milestones/FLY-2746.md
git commit -m "docs(FLY-2746): record Ubicloud CI cutover milestone"
test "$(git show --format= --name-only HEAD)" = "engineering/doc/milestones/FLY-2746.md"
```

Expected: milestone is the sole file in literal last commit。

- [ ] **Step 3: 请求 effective code review**

Run:

```sh
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set code_review
review_question_id="$(node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js gate review_code --lead flywheel-eng-lead --exec-id 6844038d-f8c7-4dc1-b849-a3a3032cd71b --no-block "Code review requested for FLY-2746" | jq -r '.questionId')"
test -n "$review_question_id"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js request-review --type code --question-id "$review_question_id"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js check "$review_question_id"
```

Expected: effective `reviewVerdict=APPROVED`。`CHANGES_REQUESTED` 时只修 blocking finding、重新完成验证，把 milestone 再次放到最后一个 commit，并开新的 review gate。APPROVED advisories 通过 `ask --report` 转交 Lead。

## Task 7: Push, PR, exact-head CI and bounded handoff

**Files:**
- Verify only; no more worktree commits after the literal-last milestone

- [ ] **Step 1: push feature branch and create PR**

Run:

```sh
git push -u origin flywheel-FLY-2746
gh pr create --repo xrliAnnie/flywheel --base main --head flywheel-FLY-2746 \
  --title "FLY-2746: switch CI jobs to Ubicloud by repo variable" \
  --body-file engineering/doc/FLY-2746-ubicloud-ci-cutover/pr-body.md
```

`pr-body.md` must include the canary run/job runner receipt, exact 10+3 scope, RED/GREEN and local verification, rollback semantics, and explicit post-merge acceptance still pending. It must not claim `CI_RUNNER` is set or that a real production PR/rollback run exists.

- [ ] **Step 2: 等待普通 exact-head PR CI；不请求或模拟 ship/QA**

Run:

```sh
pr_number="$(gh pr view --repo xrliAnnie/flywheel --json number --jq .number)"
pr_head="$(git rev-parse HEAD)"
test "$(gh pr view "$pr_number" --repo xrliAnnie/flywheel --json headRefOid --jq .headRefOid)" = "$pr_head"
gh pr checks "$pr_number" --repo xrliAnnie/flywheel --watch --fail-fast=false
```

Expected: exact-head required checks conclude success；do not run `ci-full ensure` because the injected handoff did not freeze this implement head for QA-owned full CI.

- [ ] **Step 3: final audit and structured completion**

Audit current head, remote branch, PR head, effective review head, exact-head CI, milestone-last property, canary receipt, absent `CI_RUNNER`, and every explicit requirement. Then:

```sh
commit_list="$(git log --format='%h' origin/main..HEAD | paste -sd, -)"
pr_url="$(gh pr view "$pr_number" --repo xrliAnnie/flywheel --json url --jq .url)"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js ask --lead flywheel-eng-lead --exec-id 6844038d-f8c7-4dc1-b849-a3a3032cd71b --report "DONE: [lead-instruction e9e26f9d-2004-464c-8c9c-93940f96b118] canary and review-ready FLY-2746 PR delivered; post-merge CI_RUNNER switch and rollback receipts remain for successor | commits: $commit_list | PR: $pr_url"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete --route needs_review --pr "$pr_number"
```

Expected: DONE report accepted and completion returns `session_completed`。Do not merge, set `CI_RUNNER`, dispatch QA, or perform the post-merge rollback exercise in this implement phase.
