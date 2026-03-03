export const template = `---
name: flywheel-tdd
description: Flywheel TDD workflow enforcement. Use BEFORE writing implementation code.
allowed-tools: Bash Read Write Edit
metadata:
    skill-author: flywheel
    skill-version: 0.1.0
---

# Flywheel: TDD Workflow

## Overview

Flywheel 强制要求 TDD。不写测试直接实现是被禁止的。

**Project**: {{projectName}}
**Test framework**: {{testFramework}}

## TDD Cycle

### Phase 1: RED — Write Failing Test

**先写测试，此时它应该失败。**

\`\`\`bash
{{testCommand}} -- --testPathPattern="<test-file>"
\`\`\`

**RED 阶段检查清单**：
- [ ] 测试文件已创建
- [ ] 测试描述清晰表达了期望行为
- [ ] 运行测试 → 确认 **FAIL**

### Phase 2: GREEN — Make Test Pass

**写最少的代码让测试通过。**

\`\`\`bash
{{testCommand}} -- --testPathPattern="<test-file>"
\`\`\`

GREEN 阶段原则：
- 写**最简单**的实现让测试通过
- 暂时不考虑边界情况
- 不要提前抽象

### Phase 3: REFACTOR — Clean Up

**在所有测试仍然通过的前提下，改善代码质量。**

\`\`\`bash
{{testCommand}}
{{lintCommand}}
\`\`\`

### Commit 节奏

\`\`\`bash
# RED：测试写完后
git commit -m "test(<scope>): add failing tests for <feature>"

# GREEN：实现通过后
git commit -m "feat(<scope>): implement <feature> (tests passing)"

# REFACTOR：重构后
git commit -m "refactor(<scope>): clean up <feature> implementation"
\`\`\`

## Coverage Requirements

Flywheel 要求 **80%+ 测试覆盖率**。

重点覆盖：
- Happy path
- Error/exception paths
- Edge cases（空输入、null、边界值）
- Async 操作的 rejection

## Anti-Patterns（禁止）

- 写完实现再补测试（事后测试）
- 测试只测 happy path
- mock 所有依赖导致测试不测任何真实逻辑
- 为了通过测试而 hardcode 返回值
`;
