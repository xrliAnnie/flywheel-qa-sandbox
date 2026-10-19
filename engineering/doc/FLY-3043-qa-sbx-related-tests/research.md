# FLY-3043 QA 沙箱相关测试说明 — 调研
Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-29
基于: exploration.md

## 当前状态

- 目标文件 `packages/claude-runner/agents/codex-runner-contract.md` 已存在，共 113 行。
- 文件末尾当前是 Environment Translation 的 precedence 条款。
- 新增目标文本及其核心短语在当前仓库中均无匹配，因此不存在重复说明。
- 本任务只改变 Markdown contract 内容，不改变文件路径、TypeScript 源码、导出 API 或运行时数据结构。

## 消费路径

- `packages/claude-runner/src/codex-home.ts` 通过 `codexRunnerContractSource()` 定位该文件，并由 `provisionCodexHome()` 写入每个 runner 的 `$CODEX_HOME/AGENTS.md`。
- `packages/claude-runner/test/codex-home.test.ts` 验证 contract 会被物化，并检查关键 contract anchors。
- `packages/claude-runner/package.json` 的 `files` 包含 `agents`，所以发布包会携带该 Markdown 文件。
- `scripts/__tests__/package-onboard-smoke.test.sh` 只验证发布镜像中的该路径存在，不检查文件内容。

## 针对性验证选择

保留：

- `packages/claude-runner/test/codex-home.test.ts`：直接覆盖该 contract 的读取和物化路径；使用 owning package 的单文件 Vitest 命令运行。
- 精确文本计数与 `tail -1`：直接证明新说明恰好出现一次且位于目标文件最后一行。
- `git diff --check`、`pnpm lint`、`pnpm --filter "flywheel-claude-runner..." build`：分别覆盖 diff 格式、仓库 lint 与受影响包及其依赖构建。

排除并记录：

- `scripts/__tests__/package-onboard-smoke.test.sh`：发现于 basename/path 搜索，但该测试只断言文件存在和打包路径；本任务不创建、删除或移动目标文件，因此不重复执行昂贵的 packaging smoke。
- `vitest related`：仅对 changed TypeScript 强制；本任务没有 TypeScript 改动。
- dependent typecheck：没有导出 API 或类型变化。

## 风险结论

风险限于文字位置或重复。最小实现是在保留原文件全部内容的前提下，将指定说明追加为唯一的最后一行；无需新增测试或修改生产代码。
