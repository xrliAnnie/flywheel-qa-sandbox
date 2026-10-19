# FLY-3043 QA 沙箱相关测试说明 — 实施计划
Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-29
基于: research.md

## 范围与约束

执行已锁定的一行 Markdown 修改，不重新设计 contract，不修改运行时代码、测试、`CLAUDE.md` 或 QA 流程。由于没有行为代码变化，TDD 的红灯证据由修改前精确文本搜索无匹配提供；实现后同一断言必须变绿。

## 步骤 1：固化设计产物

1. 提交 `exploration.md`、`research.md`、`plan.md` 与当前 progress ledger。
2. 进入 `design_review`，通过 `review_design` gate 和 `request-review --type design` 注册有效评审。
3. 只有结构化 `reviewVerdict` 为 `APPROVED` 后才进入实现。

## 步骤 2：最小实现

1. 确认指定完整文本在仓库仍无匹配。
2. 用单一补丁把 issue 指定的完整英文 Sandbox note 逐字追加到 `packages/claude-runner/agents/codex-runner-contract.md` 末尾。
3. 不调整目标文件其他内容，也不在其他仓库文件中复制该完整字面值。

## 步骤 3：针对性验证

依次验证：

1. 对 issue 指定完整文本运行全仓库 `git grep -nF`，只返回目标文件一处。
2. `tail -n 1` 与指定文本逐字相等。
3. `git diff --check` 通过。
4. `pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts` 通过；这是直接消费 contract 的唯一保留单测文件。
5. `pnpm lint` 通过。
6. `pnpm --filter "flywheel-claude-runner..." build` 通过。

不运行 full repository/package test suite，不运行无具体文件参数的 Vitest，也不运行只验证未变化路径存在的 `scripts/__tests__/package-onboard-smoke.test.sh`。本任务没有 changed TypeScript，因此不运行 `vitest related`。

## 步骤 4：提交与代码审查

1. 提交目标一行修改和过程文档；推送 issue branch。
2. 在里程碑提交前完成最终 progress ledger 更新。
3. 创建 `engineering/doc/milestones/FLY-3043.md`，将该文件作为当前分支的最后一个提交并推送。
4. 进入 `code_review`，通过 `review_code` gate 和 `request-review --type code` 注册正常代码审查。
5. 若要求修改，修复后重新验证，并重新生成最后一个里程碑提交，再发起新评审；若通过，不再修改分支 HEAD。

## 步骤 5：PR 与交接

1. 在有效代码审查通过的冻结 HEAD 上创建根仓库 PR。
2. 核对 PR head、最后提交、工作树、inbox 与 PR 状态；不请求 full CI，不 dispatch QA，不 merge。
3. 通过 `ask --report` 汇报完成情况。
4. 执行注入的 `complete --route needs_review --pr <NUMBER>`，然后 park 等待后续 phase-wake。
