# FLY-2506 合并权限范围 — 调研
Issue: FLY-2506 (https://linear.app/geoforge3d/issue/FLY-2506/病根-runner-合同before-any-merge-必须-verify-approval把冲突返工的)
日期: 2026-09-10
基于: exploration.md

`packages/claude-runner/agents/codex-runner-contract.md` 是受管 AGENTS.md 的源文件；`packages/claude-runner/src/codex-home.ts` 在 provisioning 时读取并物化。现有 `test/codex-home.test.ts` 已覆盖真实合同物化，但只断言 verify-approval 存在，没有校验其适用范围。无需修改审批实现、数据库或运行时调度。修改源合同只影响后续物化；本任务不更新运行中 runner 的家目录。
