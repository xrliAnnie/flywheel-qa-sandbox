# FLY-2318 Blueprint golden 同步 — 实施计划
Issue: FLY-2318 (https://linear.app/geoforge3d/issue/FLY-2318/main-%E7%BA%A2%E7%B4%A7%E6%80%A5-1067-%E4%B8%8E-1056-%E8%AF%AD%E4%B9%89%E5%90%88%E5%B9%B6%E5%86%B2%E7%AA%81blueprint-%E6%8F%90%E7%A4%BA%E8%AF%8D%E6%94%B9%E5%8A%A8%E6%9C%AA%E5%90%8C%E6%AD%A5%E5%88%B0-fly-2147-%E6%96%B0%E5%A2%9E%E7%9A%84-golden5-%E6%9D%A1)
日期: 2026-09-03
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:systematic-debugging`,
> `superpowers:test-driven-development`, and `superpowers:verification-before-completion`; execute inline in this
> resident implementation node because the DAG TURN and shared branch are bound to this session.

**Goal:** 把 #1067 已证明正确的 inbox-pending 提示词同步进 #1056 新增的两份完整 prompt fixture，让指定
五条漂移守卫恢复为绿，同时用逆向变异证明守卫仍能抓住旧内容。

**Architecture:** Blueprint、测试断言和已更新 snapshot 均不改；只推进两份手工 golden 的共同 prompt
基线。测试继续对生产 prompt 做既有路径归一化并逐字节比较，因此 FLY-2147 的“只插入 runner-memory
段”与“未触碰 backend 保持不变”语义仍由原断言完整约束。

**Tech Stack:** TypeScript、Vitest、pnpm workspace、纯文本 golden fixtures、GitHub Actions。

---

## 0. 锁定范围与证据

允许的行为修改文件只有：

- `packages/edge-worker/src/__tests__/fixtures/fly1188-prompt-before-fly2147.txt`
- `packages/edge-worker/src/__tests__/fixtures/fly2147-prompt-golden-unsupported-backend.txt`

流程文档位于 `engineering/doc/FLY-2318-blueprint-golden-sync/`；PR 最后一笔只新增
`engineering/doc/milestones/FLY-2318.md`。明确不改：

- `packages/edge-worker/src/Blueprint.ts`；
- 两个 `Blueprint.*.test.ts`；
- `Blueprint.fly1188-codex-prompt.test.ts.snap`；
- 任何 mailbox 生产实现、配置、依赖或其他 fixture；
- `CLAUDE.md`。

批准设计的外部判据来自 research.md：FLY-2222 计划、3 条 prompt 语义测试、162 条 mailbox
DB/command/CLI 测试，以及 #1067 主动更新的 snapshot；禁止把当前失败输出单独当 oracle。

## Task 1：冻结计划并通过设计评审

- [ ] **Step 1.1：自审文档**

运行：

```bash
rg -n 'T[B]D|T[O]DO|implement lat[e]r|fill i[n]' engineering/doc/FLY-2318-blueprint-golden-sync/{exploration,research,plan}.md
git diff --check
```

预期：placeholder 搜索零命中，`git diff --check` exit 0；exploration 的三种方案、research 的三方来源
证据与本计划的两文件范围一致。

- [ ] **Step 1.2：提交并推送设计文档**

先检查 Lead inbox，再提交三份文档：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js inbox --exec-id 222f7ee4-f362-4528-8380-dbecf46999cf
git add engineering/doc/FLY-2318-blueprint-golden-sync/exploration.md engineering/doc/FLY-2318-blueprint-golden-sync/research.md engineering/doc/FLY-2318-blueprint-golden-sync/plan.md
git commit -m "docs(FLY-2318): plan Blueprint golden synchronization"
git push -u origin flywheel-FLY-2318
```

- [ ] **Step 1.3：request-driven design review**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set design_review --plan engineering/doc/FLY-2318-blueprint-golden-sync/plan.md
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js gate review_design --lead flywheel-eng-lead --exec-id 222f7ee4-f362-4528-8380-dbecf46999cf --no-block "Design review requested for FLY-2318"
```

从 JSON 回执读取真实 `questionId`，随后运行：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js request-review --type design --question-id "$FLY2318_DESIGN_QID" --plan engineering/doc/FLY-2318-blueprint-golden-sync/plan.md
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js check "$FLY2318_DESIGN_QID"
```

`$FLY2318_DESIGN_QID` 只取自本轮 gate JSON，不复用旧 id。只有结构化 `reviewVerdict=APPROVED` 才进入
Task 2；`CHANGES_REQUESTED` 只改计划所指问题，然后以新 gate/new question id 重走本步骤。批准后不再
修改 plan.md。

## Task 2：RED — 重新证明五条守卫抓住旧 golden

**Files:** 不修改；运行既有测试。

- [ ] **Step 2.1：进入实施并运行精确 RED**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set implement
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.fly1188-codex-prompt.test.ts src/__tests__/Blueprint.fly2147-runner-memory.test.ts
```

预期：exit 1，`Test Files 2 failed (2)`，`Tests 5 failed | 34 passed (39)`；五个 diff 都只缺同一条
FLY-2222 inbox-pending 规则。若失败数或 diff 形状改变，停止修改并重新做 root-cause investigation。

## Task 3：GREEN — 最小同步两份 fixture

### 3.1 `fly1188-prompt-before-fly2147.txt`

- [ ] **Step 3.1：在当前第 31 行后插入归一化规则**

使用 `apply_patch`，在 `Your Lead may send you instructions...` 完整行与后续空行之间只加入：

```text
Treat an inbox pending summary as unread runner-mailbox traffic, not as an empty inbox. Pending runner mailbox items may include answers to outstanding questions. Run `node <COMM_CLI> check <question-id>` for every question id shown before proceeding; inbox does not consume response bodies.
```

### 3.2 `fly2147-prompt-golden-unsupported-backend.txt`

- [ ] **Step 3.2：在当前第 40 行后插入原始路径规则**

使用 `apply_patch`，在对应 Lead 指令行与空行之间只加入：

```text
Treat an inbox pending summary as unread runner-mailbox traffic, not as an empty inbox. Pending runner mailbox items may include answers to outstanding questions. Run `node /Users/xiaorongli/Dev/flywheel-FLY-2147/packages/flywheel-comm/dist/index.js check <question-id>` for every question id shown before proceeding; inbox does not consume response bodies.
```

- [ ] **Step 3.3：检查补丁范围与字节形状**

```bash
git diff --check
git diff -- packages/edge-worker/src/__tests__/fixtures/fly1188-prompt-before-fly2147.txt packages/edge-worker/src/__tests__/fixtures/fly2147-prompt-golden-unsupported-backend.txt
git diff --exit-code origin/main -- packages/edge-worker/src/Blueprint.ts packages/edge-worker/src/__tests__/Blueprint.fly1188-codex-prompt.test.ts packages/edge-worker/src/__tests__/Blueprint.fly2147-runner-memory.test.ts packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prompt.test.ts.snap
```

预期：fixture diff 每文件恰加一行；第二条命令 exit 0，证明生产代码、断言和 snapshot 未改。

- [ ] **Step 3.4：运行精确 GREEN**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set test
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.fly1188-codex-prompt.test.ts src/__tests__/Blueprint.fly2147-runner-memory.test.ts
```

预期：`Test Files 2 passed (2)`、`Tests 39 passed (39)`。

## Task 4：变异阳照 — 证明守卫没有失去判别力

- [ ] **Step 4.1：临时逆转本次两行 fixture 变更**

使用 `apply_patch` 从两份 fixture 各删掉 Task 3 加入的完整一行。不得修改测试、snapshot 或生产文件。

- [ ] **Step 4.2：运行同一命令并核对精确五红**

```bash
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.fly1188-codex-prompt.test.ts src/__tests__/Blueprint.fly2147-runner-memory.test.ts
```

预期：exit 1，仍为 `5 failed | 34 passed`，失败测试名称与 Task 2 五条完全一致，diff 仍只显示缺少
FLY-2222 规则。这是验收要求的旧 golden 变异阳照。

- [ ] **Step 4.3：恢复两行并再次 GREEN**

用 Task 3 两个精确 `apply_patch` 恢复新 golden，再重复同一 Vitest 命令。预期 39/39 通过。

- [ ] **Step 4.4：提交最小修复**

提交前检查 inbox 与 diff：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js inbox --exec-id 222f7ee4-f362-4528-8380-dbecf46999cf
git diff --check
git diff --stat origin/main...HEAD
git add packages/edge-worker/src/__tests__/fixtures/fly1188-prompt-before-fly2147.txt packages/edge-worker/src/__tests__/fixtures/fly2147-prompt-golden-unsupported-backend.txt
git commit -m "test(edge-worker): sync Blueprint prompt goldens"
git push
```

## Task 5：全仓验证

- [ ] **Step 5.1：重跑语义来源套件**

```bash
pnpm --filter flywheel-comm exec vitest run src/__tests__/db.test.ts src/__tests__/commands.test.ts src/__tests__/cli.test.ts
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.fly1188-codex-prompt.test.ts src/__tests__/Blueprint.fly2147-runner-memory.test.ts
```

预期分别为 162/162、39/39。

- [ ] **Step 5.2：运行实施节点要求的完整门禁**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
git diff --name-only origin/main...HEAD -- 'scripts/__tests__/*.test.sh'
git diff --check origin/main...HEAD
```

前三条都必须 exit 0。shell suite 列表预期为空，因为本单不改 `scripts/__tests__`；若出现路径，逐个以
`bash <真实路径>` 执行并要求 exit 0。

## Task 6：request-driven code review

- [ ] **Step 6.1：冻结已验证 head 并开 review gate**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set code_review
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js gate review_code --lead flywheel-eng-lead --exec-id 222f7ee4-f362-4528-8380-dbecf46999cf --no-block "Code review requested for FLY-2318 Blueprint golden synchronization"
```

从 JSON 回执读取本轮真实 `questionId`，再运行：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js request-review --type code --question-id "$FLY2318_CODE_QID"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js check "$FLY2318_CODE_QID"
```

`request-review` 是本仓 Codex 作者的 `codex:rescue` review lane；不存在 `pnpm codex:rescue` 脚本，也
禁止 raw `codex exec`。只接受结构化 `reviewVerdict=APPROVED`。若 `CHANGES_REQUESTED`，按 findingKey
修复、重跑 Task 4/5、push，并用全新的 review gate/question id 再审。APPROVED advisories 用
`ask --report` 转给 Lead。

## Task 7：draft PR、里程碑最后提交与 CI

- [ ] **Step 7.1：创建 draft PR 获取真实编号**

用最终标题 `test(edge-worker): sync Blueprint prompt goldens (FLY-2318)` 创建 draft PR。正文必须列出：

- #1056/#1067 provenance；
- 仅两份 fixture 每份新增一行；
- 初始五红、修复后 39/39、逆变异精确五红、恢复后 39/39；
- 162 条 mailbox 来源测试与三条全仓门禁；
- 明确未改测试、断言、snapshot、Blueprint 生产代码。

记录 `gh pr view --json number,url` 返回的真实 PR number/url。

- [ ] **Step 7.2：在 milestone 之前完成最终 progress 写入**

把 progress 更新为 8/8、code review/full gates/mutation complete。此后不再调用 `progress`，避免 milestone
不是 literal last commit。

- [ ] **Step 7.3：以实际 PR number 新增 milestone 并单独提交**

使用 `apply_patch` 新建 `engineering/doc/milestones/FLY-2318.md`，其中 `**PR**` 写 Step 7.1 返回的实际
数字，不留占位符：

```markdown
# FLY-2318 — Blueprint golden 同步

**Status**: ⏳ Pending ship
**PR**: #实际数字
**Date**: 2026-09-03

同步 FLY-2222 已批准的 inbox-pending 提示词到 FLY-2147 的两份完整 golden；保留逐字节断言，并以旧
golden 逆变异精确重现五红。
```

然后：

```bash
git add engineering/doc/milestones/FLY-2318.md
git commit -m "docs(FLY-2318): add milestone"
bash scripts/__tests__/fly2045-milestone-layout.test.sh
git show --name-only --format= HEAD
git push
gh pr ready
```

预期 `git show --name-only --format= HEAD` 只列 milestone，守卫 exit 0。

- [ ] **Step 7.4：等待 PR CI 得出权威结果**

运行短探针 `gh pr checks`；exit 8 表示仍在运行，后续 turn 继续查询，不视为失败。只有全部 checks exit
0，特别是 `Unit (heavy)` 通过，才满足验收。其他非零先读取失败 job 日志并按系统化调试处理；不得把
本地窄测试代替 PR CI。

## Task 8：报告与 implement completion route

- [ ] **Step 8.1：终态审计**

重新检查 inbox、PR head 与文件范围，确认 milestone 是 HEAD、CI 全绿、无未提交改动，且所有验收项
均有直接证据。

- [ ] **Step 8.2：向 Lead 报告并结束 bounded node**

通过唯一报告通道发送 self-contained `DONE`，包含 commits、PR URL、5-red → 39-green → mutation
5-red → 39-green、full gates 与 `Unit (heavy)` 结果；若期间收到任何 `[lead-instruction <id>]`，另以完整
id 发对应 DONE 回执。最后运行：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete --route needs_review --pr "$FLY2318_PR_NUMBER"
```

本节点不 dispatch QA、不请求 ship approval、不 merge、不 deploy。

## 计划自审

- 需求覆盖：五条现有失败、两份 stale fixture、正确 prompt 独立来源、测试不可修改、变异阳照、
  `Unit (heavy)`、完整门禁、review、PR 与 completion route 都有对应步骤。
- 类型/路径一致：两份 fixture 的不同路径形态与各自 normalize helper 一致；没有引入新 API。
- 范围一致：唯一产品变动是两份 golden 每份一行；snapshot 与 production 均为显式 no-touch。
- 无模糊实现步骤：所有内容、命令、成功/失败判据和重试分支均已写明；运行时 id/PR number 只从命令
  回执获得并写入实际值，不硬编码占位值。
