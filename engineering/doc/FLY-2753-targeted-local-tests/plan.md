# FLY-2753 本机定向测试守则 — 实施计划
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-18
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 implement、qa、engineer runner 本机只跑 lint、受影响包 build/typecheck 与直接相关定向测试，把全量包套件唯一交给 frozen-head full-mode exact-head CI。

**Architecture:** 只改三份 node domain 手册的既有 verification 段；`packages/teamlead/phase-protocols/` 保持跨项目平台层，不重复 Flywheel 专属命令。用已有 package-gate、FLY-2121 与 FLY-2533 prompt tests 锁定新合同，并用 `sync-phase-protocols.mjs --check` 证明 canonical projections 未漂移。

**Tech Stack:** Markdown runner handbooks、Node test runner、Bash contract test、Vitest、pnpm monorepo。

---

## 文件结构

- Modify: `scripts/__tests__/package-gate.test.mjs` — 三份守则的新合同主断言，替换旧 receipt route 断言。
- Modify: `scripts/__tests__/fly2121-node-contract-and-setup.test.sh` — implement 的 affected-package build / no-local-full-suite 合同。
- Modify: `.flywheel/agents/nodes/implement.md` — 本机定向验证与 implement 红 job 处置；修正 frontmatter 的 full-repo 描述。
- Modify: `.flywheel/agents/nodes/qa.md` — 同一选择规则与 QA 的 FAIL/交回作者动作。
- Modify: `.flywheel/agents/nodes/engineer.md` — 同一选择规则与 engineer 红 job 处置；修正 frontmatter 的 full-repo 描述。
- Modify: `packages/edge-worker/src/__tests__/fixtures/fly2533-phase-baseline.json` — implement/qa 的改动前 composed-prompt budget anchor 与增长记录。
- Create: `engineering/doc/FLY-2753-targeted-local-tests/implementation.md` — RED/GREEN、prompt budget 与本地定向证据。
- Create last: `engineering/doc/milestones/FLY-2753.md` — PR literal-last milestone commit。

`packages/teamlead/phase-protocols/*.md`、managed protocol blocks、`scripts/sync-phase-protocols.mjs`、CI workflow 与 package-gate implementation 均不修改。

### Task 1: RED — 把旧合同测试改成新合同

- [ ] **Step 1: 改写 package-gate handbook contract test**

把 `scripts/__tests__/package-gate.test.mjs` 的 `all active runner package gates...` 用例改名并替换为：

```js
test("active runner handbooks require targeted local verification and CI-owned full evidence", () => {
  for (const name of ["implement", "engineer", "qa"]) {
    const text = readFileSync(
      new URL(`../../.flywheel/agents/nodes/${name}.md`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      text,
      /pnpm test:packages:run|PACKAGE_GATE_RECEIPT|onTaskUpdate/,
      name,
    );
    for (const required of [
      "pnpm lint",
      "affected package",
      "pnpm --filter \"<pkg>...\" build",
      "git grep -lF",
      "full path, file name, and parent directory",
      "document every excluded match",
      "vitest related",
      "scripts/__tests__/*.test.sh",
      "no local full package suite",
      "full exact-head CI",
      "CI OK",
      "CI Scope OK",
      "skill defaults",
    ]) assert.ok(text.includes(required), `${name}: ${required}`);
    assert.match(text, /red .*CI job/i, name);
  }
});
```

- [ ] **Step 2: 更新 FLY-2121 的两个旧正向断言**

在 `scripts/__tests__/fly2121-node-contract-and-setup.test.sh` 保留 `pnpm lint` 断言，把 `pnpm -r build` / `pnpm test:packages:run` 两行替换为：

```bash
assert_contains 'pnpm --filter "<pkg>..." build' 'implement node scopes build to affected packages and dependencies'
assert_contains 'no local full package suite' 'implement node delegates the full package suite to CI'
```

- [ ] **Step 3: 运行 RED，确认两个测试只因旧守则失败**

Run:

```bash
pnpm --filter "flywheel-edge-worker..." build
node --test scripts/__tests__/package-gate.test.mjs
bash scripts/__tests__/fly2121-node-contract-and-setup.test.sh
```

Expected: build exit 0；两项测试非零，失败分别显示旧 `pnpm test:packages:run`/缺失 `affected package` 与缺失新 FLY-2121 needles，不是 dist 依赖或语法错误。

- [ ] **Step 4: 提交 RED 锚点**

```bash
git add scripts/__tests__/package-gate.test.mjs scripts/__tests__/fly2121-node-contract-and-setup.test.sh
git commit -m "test(FLY-2753): require targeted local verification"
```

### Task 2: GREEN — 最小改写三份活守则

- [ ] **Step 1: 替换 implement 的验证行**

保持 work loop 其他行不动。新第 6 步必须同时写明：

- 本机 `pnpm lint`；
- build affected package + dependencies：`pnpm --filter "<pkg>..." build`；导出 API/type 改动再 typecheck dependents：`pnpm --filter "...<pkg>" typecheck`；
- tests = changed files' owning package + direct test consumers；以完整相对路径、文件名、父目录路径三种 needle 跑 `git grep -lF`，明确无关的命中可排除但必须逐条写理由；TS 用所属包 `vitest related`；运行所有保留命中与新 `scripts/__tests__/*.test.sh`；
- 此规则覆盖 skill defaults 的 `pnpm test`、`pnpm -r test`、`pnpm -r build`；`no local full package suite`；
- full evidence 只认 frozen-head full-mode full exact-head CI `CI OK`，不认 `CI Scope OK`；implement 修复当前 HEAD 实际运行的任一 red CI job；
- 保留 PR artifact 与 `codex:rescue` / 禁止 raw `codex exec` / blocking re-review 条款。

同时把 frontmatter description 的 `full-repo verification` 改为 `targeted local verification`。

- [ ] **Step 2: 替换 qa 的验证行**

用同一 build/test discovery/full-CI 规则替换 qa work loop 第 3 步，保留 real behavior / proofshot / Claude-in-Chrome 验证。权限差异写清：any red CI job means FAIL，交回 author，QA 不修产品代码。

- [ ] **Step 3: 替换 engineer 的验证行**

用同一 build/test discovery/full-CI 规则替换 self-verify 第 5 步；red current-HEAD job 由 engineer 修复。frontmatter description 的 `full-repo gates` 改为 `targeted local gates`。

- [ ] **Step 4: 运行两个 GREEN 合同测试**

```bash
node --test scripts/__tests__/package-gate.test.mjs
bash scripts/__tests__/fly2121-node-contract-and-setup.test.sh
```

Expected: 两者 exit 0。

- [ ] **Step 5: 提交 domain 实现**

```bash
git add .flywheel/agents/nodes/implement.md .flywheel/agents/nodes/qa.md .flywheel/agents/nodes/engineer.md
git commit -m "fix(FLY-2753): use targeted local verification"
```

记录这个 commit SHA，作为 Task 3 的 `baselineRevision`。

### Task 3: 更新直接依赖的 prompt budget anchor

- [ ] **Step 1: 先复现 stale-baseline 失败**

```bash
pnpm --filter "flywheel-edge-worker..." build
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.generalized-workflow.test.ts -t FLY-2533
```

Expected: implement/qa domain equality因旧 `platformMigration.after` 与新手册不一致而失败；这证明 fixture 是直接消费者。

- [ ] **Step 2: 对 implement/qa 建立改动前 composed-prompt anchor**

在 `packages/edge-worker/src/__tests__/fixtures/fly2533-phase-baseline.json`：

- 选 Task 1 RED commit（node 尚未改）作为 pre-change SHA；把 implement/qa `baseline` 更新为该 SHA 的真实 composed prompt：`protocol.trimEnd() + "\n\n---\n\n" + oldDomain`；
- `baselineRevision` 写该 pre-change SHA；
- `platformMigration` 第一条把开头的 `protocol.trimEnd() + "\n\n---\n\n"` 替换为空，使 expected domain 回到 domain-only；后续逐条把旧验证行替换成新验证行，implement 另替换旧→新 frontmatter description；
- `rebaseNote` 写明 `BUDGET ANCHOR (FLY-2753)`、anchor 是改动前实际交付的 composed prompt、旧/新 prompt UTF-16/UTF-8 与增长百分比。10% 门因此直接量 FLY-2753 的真实增量，而不是 protocol 固定开销。

不改其他七个 node entry 或 fixture-level `revision`。

- [ ] **Step 3: 运行 FLY-2533 GREEN 并保存 measurement**

```bash
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.generalized-workflow.test.ts -t FLY-2533
```

Expected: 18/18 role/vendor cases通过；输出 `FLY2533_PROMPT_MEASUREMENT`。implement/qa 的 before 是旧 composed prompt，after 是新 composed prompt，增长均 ≤10%，与 rebase note 对账。

- [ ] **Step 4: 提交 fixture re-pin**

```bash
git add packages/edge-worker/src/__tests__/fixtures/fly2533-phase-baseline.json
git commit -m "test(FLY-2753): anchor targeted verification prompts"
```

### Task 4: 本机按新规做定向验收

- [ ] **Step 1: projection 与静态负断言**

```bash
node scripts/sync-phase-protocols.mjs --check
! rg -n 'pnpm test:packages:run|PACKAGE_GATE_RECEIPT|onTaskUpdate' .flywheel/agents/nodes/{implement,qa,engineer}.md
```

Expected: 九个 projection checked；三份守则旧本机全量/receipt 文本零匹配。

- [ ] **Step 2: 静态正断言**

```bash
rg -n 'affected package|git grep -lF|vitest related|no local full package suite|full exact-head CI|CI OK|CI Scope OK|red .*CI job' .flywheel/agents/nodes/{implement,qa,engineer}.md
```

Expected: 三份守则都命中完整共同规则；QA 行明确 FAIL/author，implement/engineer 明确 fix。

- [ ] **Step 3: 直接依赖 discovery 自证**

对三个 node 分别以完整相对路径、文件名、父目录 `.flywheel/agents/nodes` 运行 `git grep -lF`。父目录会扩大命中；逐项判读，保留 package-gate、FLY-2121、FLY-2533 fixture/test，所有排除项在 implementation.md 写明不直接依赖本次验证行的理由。规则是“运行所有保留的直接消费者”，不是盲跑全部字符串命中。

- [ ] **Step 4: 全仓 lint + 受影响 package build/typecheck**

```bash
pnpm lint
pnpm --filter "flywheel-edge-worker..." build
pnpm --filter flywheel-edge-worker typecheck
```

Expected: 每条 exit 0。依赖 build 是 edge-worker test 的前置，不扩大为 `pnpm -r build`。

- [ ] **Step 5: 重跑全部直接相关测试**

```bash
node --test scripts/__tests__/package-gate.test.mjs
bash scripts/__tests__/fly2121-node-contract-and-setup.test.sh
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.generalized-workflow.test.ts -t FLY-2533
```

Expected: 全部 exit 0。本地不运行 `pnpm test:packages:run`。

- [ ] **Step 6: 写 implementation evidence 并提交**

`engineering/doc/FLY-2753-targeted-local-tests/implementation.md` 记录 RED 原因、GREEN counts、prompt measurement、grep/sync/lint/build/typecheck 输出与边界：普通 implement CI 可能是 scoped，full evidence 归 QA frozen-head `ci-full ensure`。

```bash
git add engineering/doc/FLY-2753-targeted-local-tests/implementation.md
git commit -m "docs(FLY-2753): record targeted verification evidence"
```

### Task 5: final-head review、PR 与 handoff

- [ ] **Step 1: 提交 literal-last milestone**

按 `engineering/doc/milestones/README.md` 新建 `engineering/doc/milestones/FLY-2753.md` 并提交。此后 HEAD 不再改变；若 code review 要求修复，修复后必须再做一笔 milestone-only literal-last commit 并重新 review。

- [ ] **Step 2: 注册 final HEAD effective code review**

执行注入的 `stage set code_review`、`gate review_code --no-block`、`request-review --type code`，轮询 structured `reviewVerdict`。CHANGES_REQUESTED 只修 blocking finding 并新开 review gate；APPROVED with advisories 通过 `ask --report` 转报。

- [ ] **Step 3: push 并创建 PR**

PR body 分开列：本机定向证据、scoped CI 证据、full-mode frozen-head CI 尚由 QA 获取。不得加 `ci:full` label、不得自行运行 `ci-full ensure`、不得请求 ship。

- [ ] **Step 4: 处理 implement HEAD 实际运行的 CI**

观察当前 PR HEAD 实际启动的 jobs；任一红都定位并处理。`CI Scope OK` 只能证明 scoped jobs，不写成 full-suite green。full evidence 只由 QA 对 frozen HEAD 取得的 `CI OK` 提供。

- [ ] **Step 5: role-memory closeout、report 与 completion**

写最多五条 durable role judgments；若无新增则明确 unchanged。通过注入 CLI 报告 PR、HEAD、本机定向结果、review 与 CI scope，然后：

```bash
PR_NUMBER=$(gh pr view --json number --jq .number)
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$PR_NUMBER"
```

不 merge、不 deploy、不 restart、不 dispatch QA。

## 计划自检

- 目标 1：Task 2 明确 affected package selectors、direct-test discovery、TS related tests 与新增 shell tests。
- 目标 2：Task 1/2/4 删除并负断言本机 aggregate 与 receipt 例外；Task 2/5 保留 red job 处理且符合角色权限。
- 目标 3：canonical/projections 不改，Task 4 用 sync `--check` 证明九个投影一致；FLY-2533 fixture 用改动前 composed prompt 直接度量本次增长。
- 目标 4：不改 CI workflow/package-gate implementation/其他条款；本机只跑列出的定向 tests，full-mode CI 由 QA frozen-head 负责。
- 评审 HIGH 全覆盖：三个 stale tests/fixture 已列入文件与命令；canonical duplication 被删除，prompt budget 以 pre-change composed-prompt anchor 明示处理。
- 评审 advisories：selectors、三 needle discovery + documented exclusions、`CI OK` vs `CI Scope OK`、三份目标守则内的 skill-default 优先级、frontmatter、QA red-job 权限、milestone/review 顺序与 `$FLYWHEEL_COMM_CLI` 均已落实。
- 已知范围外：`general.md` 的 full-repo 摘要仍在；按本单明确的 implement/qa/engineer 三份范围与“不要顺手改别的条款”不动，implementation.md 如实记录。
- 无待定项、占位步骤、未定义接口或跨 issue 重构。
