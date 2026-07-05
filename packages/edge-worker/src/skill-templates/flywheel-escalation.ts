export const template = `---
name: flywheel-escalation
description: Flywheel escalation procedures for blocked or failing sessions.
allowed-tools: Bash Write
metadata:
    skill-author: flywheel
    skill-version: 0.1.0
---

# Flywheel: Escalation Procedures

## Overview

Flywheel 的核心设计原则：**人类注意力是瓶颈，不是 AI 能力**。
大多数问题你应该自主解决。但有些情况确实需要人类决策。

## When to Escalate

1. **Credentials / Secrets 缺失** — 需要 API key 但 \`.env\` 中没有
2. **架构决策歧义** — 两种以上合理方案，无法从代码中推断
3. **外部系统故障** — 第三方 API 持续返回错误
4. **Scope 超出** — 修复本 issue 需要大规模重构另一个模块
5. **持续失败（3次以上）** — 同一个错误在 3 次修复后依然出现

## When NOT to Escalate

- 语法错误、typo — 直接修复
- 测试失败（你的代码导致）— 修复代码
- linting 错误 — 修复格式
- CI 第一次失败 — 先尝试修复

## Escalation Procedure

### Step 1: Document the Blocker

\`\`\`bash
cat > /tmp/flywheel-escalation-{{issueId}}.md << 'ESCALATION'
## Escalation Report

**Issue**: {{issueId}} — {{issueTitle}}
**Timestamp**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

### Blocker Type
<credential_missing | architecture_ambiguity | external_failure | scope_exceeded | repeated_failure>

### Description
<详细描述遇到的问题>

### What I Tried
1. <尝试 1>
2. <尝试 2>

### What I Need
<需要人类提供什么>
ESCALATION
\`\`\`

### Step 2: Save Work in Progress

\`\`\`bash
git add <files-with-real-progress>
git commit -m "wip({{issueId}}): partial implementation - blocked on <reason>"
git push -u origin feat/{{issueId}}-<branch-suffix>
\`\`\`

### Step 3: Stop — Do Not Loop

一旦决定升级：停止所有实现尝试，等待 Flywheel 的 Decision Layer 处理。

## Decision Tree

\`\`\`
遇到问题 → 已尝试 ≥ 3 次？
  ├── 否 → 继续尝试
  └── 是 → 升级（按上述流程）
\`\`\`
`;
