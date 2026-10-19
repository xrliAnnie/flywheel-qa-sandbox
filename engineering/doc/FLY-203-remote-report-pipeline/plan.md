# FLY-203 远程报告管线 — 实施计划
Issue: FLY-203 (https://linear.app/geoforge3d/issue/FLY-203/remote-report-pipeline-html-报告自动发布托管-discord-截图链接送达)
日期: 2026-08-30
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不复制当前基线既有 FLY-203 生产机制的前提下，修复已证实的文档断链，并用聚焦测试、全仓 gates 和独立 Codex 评审证明远程报告管线可交给 QA 做真 Discord 手机验收。

**Architecture:** 当前基线已实现 CLI 编排、Vercel registry 托管、ProofShot 降级、Discord multipart 投递和 fail-closed Bridge mount。实施只修复 reference guide 指向不存在的 plan 路径；任何新产品代码必须先由现有 acceptance test 暴露失败，并按 red-green-refactor 最小修复，禁止建立第二套 endpoint、registry 或投递链。

**Tech Stack:** TypeScript 5、Vitest、Express、Node fs/crypto/fetch、pnpm workspace、Biome、Flywheel comm/review gates。

---

## 文件职责与锁定范围

- Modify: `doc/reference/remote-report-pipeline.md` — 修复已归档 plan 的唯一权威链接。
- Create: `engineering/doc/FLY-203-remote-report-pipeline/verification.md` — 记录 implement 节点的可复现命令与结果，不冒充 QA 真机证据。
- Maintain: `engineering/doc/FLY-203-remote-report-pipeline/progress.md` — restart-resilient 游标，由 `flywheel-comm progress` 独立提交。
- Create last: `engineering/doc/milestones/FLY-203.md` — PR handoff 摘要，必须是分支最后一个 commit。
- Do not modify: `packages/flywheel-comm/src/commands/publish-report.ts`、`packages/teamlead/src/bridge/report-registry.ts`、`packages/teamlead/src/bridge/reports-route.ts`、`packages/teamlead/src/bridge/plugin.ts`，除非下列原样测试在已构建 workspace 中出现与 FLY-203 acceptance criteria 相关的真实红灯。
- Do not modify: `CLAUDE.md`；动态任务明确禁止。

### Task 1: 用失败检查锁定 reference guide 断链

**Files:**
- Test: `doc/reference/remote-report-pipeline.md`
- Modify: `doc/reference/remote-report-pipeline.md:5`

- [ ] **Step 1: 运行归档路径检查并确认 RED**

Run:

```bash
rg -q 'doc/engineer/plan/archive/v1\.32\.0-FLY-203-remote-report-pipeline\.md' doc/reference/remote-report-pipeline.md
```

Expected: exit 1，因为当前文件仍引用不存在的 `plan/inprogress` 路径。

- [ ] **Step 2: 做最小文档修复**

Replace exactly:

```markdown
**Plan**: `doc/engineer/plan/inprogress/v1.32.0-FLY-203-remote-report-pipeline.md`
```

with:

```markdown
**Plan**: `doc/engineer/plan/archive/v1.32.0-FLY-203-remote-report-pipeline.md`
```

- [ ] **Step 3: 运行同一检查并确认 GREEN**

Run the same `rg -q` command.

Expected: exit 0；再运行：

```bash
test -f doc/engineer/plan/archive/v1.32.0-FLY-203-remote-report-pipeline.md
```

Expected: exit 0。

- [ ] **Step 4: 提交最小修复**

```bash
git add doc/reference/remote-report-pipeline.md
git commit -m "docs(FLY-203): repair remote report plan link"
```

### Task 2: 重跑 FLY-203 聚焦行为证据

**Files:**
- Test: `packages/teamlead/src/__tests__/report-registry.test.ts`
- Test: `packages/teamlead/src/__tests__/vercel-deploy.test.ts`
- Test: `packages/teamlead/src/__tests__/discord-post-file.test.ts`
- Test: `packages/teamlead/src/__tests__/reports-route.test.ts`
- Test: `packages/teamlead/src/__tests__/reports-route-mount.test.ts`
- Test: `packages/flywheel-comm/src/__tests__/publish-report.test.ts`

- [ ] **Step 1: 运行 teamlead 聚焦套件**

```bash
cd packages/teamlead
pnpm exec vitest run src/__tests__/report-registry.test.ts src/__tests__/vercel-deploy.test.ts src/__tests__/discord-post-file.test.ts src/__tests__/reports-route.test.ts src/__tests__/reports-route-mount.test.ts
```

Expected: 5 files、89 tests PASS。测试必须覆盖 registry 事务/retention、Vercel reverse-compat、Discord multipart、preview attack matrix、route/mount kill switch 与 auth。

- [ ] **Step 2: 运行 CLI 聚焦套件**

```bash
cd packages/flywheel-comm
pnpm exec vitest run src/__tests__/publish-report.test.ts
```

Expected: 1 file、23 tests PASS，包含单行 JSON envelope、截图 2x→1x→link-only 降级、stop-finally、publish 后 deliver 失败仍保留 URL。

- [ ] **Step 3: 若出现真实行为红灯，严格 TDD 修复**

只有在 workspace 已 build 且同一命令可重复失败时执行：保留最小失败用例，确认失败原因对应 AC1–AC10，修改最少生产代码，重跑单测试与两套聚焦命令。不得把缺少 `dist/` 或依赖未安装当产品 bug。

### Task 3: 记录 implement 验证证据

**Files:**
- Create: `engineering/doc/FLY-203-remote-report-pipeline/verification.md`

- [ ] **Step 1: 写验证报告**

文件必须使用 DOC-FLOW 四行抬头，记录：测试命令、精确 pass 数、全仓 gate 结果、工作树状态、AC1–AC10 证据摘要、AC11 明确标记为独立 QA 待做。不得写真 Discord PASS 或手机 PASS。

- [ ] **Step 2: 自审报告**

```bash
rg -n '真 Discord.*PASS|手机.*PASS|待补|稍后填写' engineering/doc/FLY-203-remote-report-pipeline/verification.md
```

Expected: no matches。

- [ ] **Step 3: 提交验证报告**

```bash
git add engineering/doc/FLY-203-remote-report-pipeline/verification.md
git commit -m "docs(FLY-203): record implementation verification"
```

### Task 4: 运行精确全仓 gates

**Files:**
- Verify only; no planned file changes.

- [ ] **Step 1: lint**

```bash
pnpm lint
```

Expected: exit 0。

- [ ] **Step 2: build**

```bash
pnpm -r build
```

Expected: exit 0 for all workspace packages。

- [ ] **Step 3: package tests**

```bash
pnpm test:packages:run
```

Expected: exit 0。保存包级 pass/fail 汇总；若命令 fail-fast，必须定位缺席或失败 package，不能把部分输出当全仓 PASS。

- [ ] **Step 4: shell test delta audit**

```bash
git diff --name-only origin/main...HEAD -- 'scripts/__tests__/*.test.sh'
```

Expected: no output，因为本计划不新增 shell test；若出现文件，逐个运行 `bash <path>` 并记录结果。

### Task 5: Codex code review 与 PR handoff

**Files:**
- Create last: `engineering/doc/milestones/FLY-203.md`

- [ ] **Step 1: 检查 Lead inbox、工作树与提交范围**

```bash
node "$FLYWHEEL_COMM_CLI" inbox --exec-id d95dba57-de31-4201-8fd0-635c41977170
git status --short
git diff --stat origin/main...HEAD
```

Expected: 无未处理 Lead 指令；无未提交文件；diff 只含 FLY-203 docs/evidence（除非 Task 2 产生经 TDD 证明的最小代码修复）。

- [ ] **Step 2: 写 milestone 并作为最后一个 commit**

`engineering/doc/milestones/FLY-203.md` 必须说明：当前 sandbox baseline 已含生产实现、本 PR 的实际 delta、聚焦/全仓验证和 AC11 QA handoff。然后：

```bash
git add engineering/doc/milestones/FLY-203.md
git commit -m "docs(milestone): record FLY-203 implementation handoff"
```

此后不得产生新的 commit；如果必须修复，修完后重新生成 milestone commit 使其再次成为最后一个 commit，并重新跑绑定 head 的 review/gates。

- [ ] **Step 3: 对包含 milestone 的最终 head 运行跨家族 Codex code review**

按 runner contract 使用 `codex:rescue` 对当前最终 head 做 review；随后注册新的 `review_code` gate + `request-review --type code`。若 verdict 为 CHANGES_REQUESTED，修复 HIGH correctness/security finding，重新跑相关测试，重写 milestone 使其再次成为最后一个 commit，并开新 review round；只有 APPROVED 且 reviewed head 等于当前 head 才继续。

- [ ] **Step 4: push 与开 PR**

```bash
git push -u origin project-slot-2-FLY-203
gh pr create --base main --head project-slot-2-FLY-203 --title "docs(FLY-203): verify remote report pipeline" --body "Verifies the existing remote report pipeline against FLY-203 acceptance criteria, repairs the archived-plan reference, and hands real Discord/mobile validation to independent QA."
```

不得 push main、不得 merge、不得请求 ship approval。

- [ ] **Step 5: 报告与 implement phase completion**

用 `flywheel-comm ask --report` 向 Lead 发送 self-contained DONE（commits、PR、聚焦/全仓 gates、review verdict、AC11 QA pending），再运行：

```bash
gh pr view --json number,url
gh pr view --json number --jq '.number' | xargs node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr
```

完成后 park 当前 implement turn，等待 DAG orchestrator 唤醒；不 dispatch QA。

## Plan self-review

- Spec coverage: AC1–AC10 均由 Task 2/4 的现有测试或 full gate 证明；AC11 明确交独立 QA，未偷换成 mock 证据。
- Placeholder scan: 无未填写章节、模糊后续项或未定义签名。
- Type consistency: 本计划不改变现有 API/types；若真实红灯要求代码修复，必须新增/保留先失败的测试并重新设计评审，不得隐式扩 scope。
- Scope: 只修复当前 worktree 的实证缺口，不复制已经存在的 FLY-203 feature。
