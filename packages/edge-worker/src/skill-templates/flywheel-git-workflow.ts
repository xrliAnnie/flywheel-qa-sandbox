export const template = `---
name: flywheel-git-workflow
description: Flywheel Git workflow enforcement. Follow precisely so GitResultChecker can detect completed work.
allowed-tools: Bash Read Write
metadata:
    skill-author: flywheel
    skill-version: 0.1.0
---

# Flywheel: Git Workflow

## Overview

Flywheel 通过 GitResultChecker 检测工作是否完成（\`commitCount > 0\`）。
本 skill 规定了精确的 Git 工作流，必须严格遵守。

## Step 1: Verify Branch

Flywheel 已经在一个独立的 git worktree 中为你创建了 \`flywheel-{{issueId}}\` 分支。
**不要创建新分支** — 直接在当前分支上工作。

\`\`\`bash
# 确认你在正确的分支上
git branch --show-current
# 应该显示: flywheel-{{issueId}} 或类似的 flywheel- 前缀分支
\`\`\`

## Step 2: Make Commits

\`\`\`bash
git add <specific-files>
git commit -m "feat(<scope>): <description>"
\`\`\`

**Commit 规范**：
- 每个逻辑变更一个 commit
- description 使用英文，动词开头
- **至少要有 1 个 commit** — 这是 Flywheel 判定成功的标准

## Step 3: Push & Create PR

\`\`\`bash
git push -u origin HEAD

gh pr create \\
  --title "feat: <description> ({{issueId}})" \\
  --body "## Summary
- <变更点>

## Test Plan
- [ ] \\\`{{testCommand}}\\\` passes
- [ ] Manual verification

## Linear Issue
{{issueId}}: {{issueTitle}}"
\`\`\`

## Pre-commit Checklist

\`\`\`bash
{{lintCommand}}
{{testCommand}}
git diff --staged
\`\`\`

## Critical Rules

1. **在 Flywheel 提供的 worktree 分支上工作** — 不要创建新分支
2. **必须有至少 1 个 commit**
3. **PR 必须关联 Linear issue**
4. **不要 \`git add -A\`** — 只 add 相关文件
5. **不要 force push** — 例外：仅在 flywheel-land 流程中 rebase 解决 merge conflict 时允许，且仅限 single-author PR
`;
