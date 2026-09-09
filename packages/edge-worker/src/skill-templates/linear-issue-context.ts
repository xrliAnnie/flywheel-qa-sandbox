export const template = `---
name: linear-issue-context
description: Linear issue context for the current Flywheel task. Dynamically generated per-issue.
allowed-tools: Read
metadata:
    skill-author: flywheel
    skill-version: 0.1.0
---

# Linear Issue Context

## Current Issue

**ID**: {{issueId}}
**Title**: {{issueTitle}}
**Assignee**: Flywheel (automated)

## Description

{{issueDescription}}

## Definition of Done

完成本 issue 的标准：

1. 所有 acceptance criteria 满足
2. 写了相关测试（unit + integration，按需 E2E）
3. 测试全部通过（\`{{testCommand}}\`）
4. 代码已 commit 到 feature branch
5. PR 已创建并关联本 issue（{{issueId}}）
6. PR description 包含：变更摘要 + 测试计划
7. 若本 issue 改动的是独立生产仓（如 Raya 仓）：**合入 ≠ 上线**。Done 还要求生产 checkout 已到目标 Raya SHA、\`com.flywheel.lead.raya-raya\` 经 public \`flywheel-lead.sh verify\` 核验，并有绑定 Raya/Flywheel 两仓 SHA、文字、summary、Bridge identity 与 alert 证据的 \`~/.flywheel/raya/deploy-receipt.json\`（\`schemaVersion:2\`、\`carrier:standard-lead\`）；旧 v1 回执或 anchor 不算上线。

## What NOT to Do

- 不要处理不属于本 issue 的依赖问题
- 不要更改与本 issue 无关的文件
- 不要在本 issue 中修复 "顺便发现" 的 bug（创建新 Linear issue）
`;
