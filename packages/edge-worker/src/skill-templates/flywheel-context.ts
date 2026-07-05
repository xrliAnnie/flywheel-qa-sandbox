export const template = `---
name: flywheel-context
description: Flywheel project context injection. Loaded at the START of every Flywheel-orchestrated session.
allowed-tools: Read Bash
metadata:
    skill-author: flywheel
    skill-version: 0.1.0
---

# Flywheel: Project Context

## Overview

你正在参与一个由 Flywheel 编排的自动化开发任务。

**Project**: {{projectName}}

## Coding Conventions

### TypeScript
- 使用 \`type\` 而非 \`interface\`（除非需要 declaration merging）
- 所有公共 API 使用 JSDoc 注释
- 错误处理：显式处理，不 swallow errors
- 严格模式：\`"strict": true\`，不用 \`any\`

### Git & PR
- 分支命名：\`feat/<issue-id>-<short-desc>\`
- Commit format：\`<type>(<scope>): <description>\`
- PR 标题：简洁，< 70 字符
- 每个 PR 必须关联 Linear issue

### Commands
- Test: \`{{testCommand}}\`
- Lint: \`{{lintCommand}}\`
- Build: \`{{buildCommand}}\`

## Do NOT

- 修改 \`.env\` 文件或 hardcode secrets
- 跳过错误处理
- 使用 \`console.log\` 作为生产日志（使用项目的 logger）

## Related Skills

- \`linear-issue-context\` — 获取当前 Linear issue 的详细信息
- \`flywheel-git-workflow\` — 具体的 Git 操作规范
- \`flywheel-tdd\` — TDD 工作流要求
`;
