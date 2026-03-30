# Exploration: Ship :cool: Flow — CI Green Gate + Fix Loop — FLY-2

**Issue**: FLY-2 ([Infra] Ship :cool: 流程 — CI green gate + fix loop before merge)
**Date**: 2026-03-30
**Status**: Complete

## 问题

当前 Flywheel PR merge 缺少质量门：
1. `gh pr merge` 可以在 CI 红的情况下直接执行
2. orchestrator.md 有 fix loop 文档，但只是文字约束，没有强制执行
3. 手动 `/ship-pr` 用的是 GeoForge3D 全局 skill（含 deploy、`:cool:` 触发、Terraform 等），不适用于 Flywheel

## 约束

| 约束 | 影响 |
|------|------|
| **Private repo + GitHub Free plan** | Branch protection rules 不可用（需 Pro） |
| **Flywheel 不部署** | 无需 deploy 步骤，`:cool:` reaction 无意义 |
| **CLI 工具/本地运行** | Ship = merge PR + 清理 worktree + 归档文档 |
| **Orchestrator + 手动** | 两种使用场景都需覆盖 |

## 方案分析

### A. GitHub Branch Protection（排除）

- **GitHub Free plan 不支持** private repo branch protection
- 即使可用，也只能 block，不能 fix loop
- **结论：不可行**

### B. Custom GitHub Action — `:cool:` trigger（排除）

- Flywheel 无 deploy 流程，`:cool:` reaction 语义不匹配
- 增加 GitHub Action 复杂度，收益低
- GeoForge3D 的 `:cool:` 是因为要触发 Terraform + Cloud Run deploy
- **结论：过度设计**

### C. Flywheel-specific `/ship-pr` skill（推荐）

创建项目本地 `.claude/commands/ship-pr.md`，覆盖全局 GeoForge3D 版本。

**Phase 1: CI Green Gate**
- `gh pr checks {PR} --watch` 等待 CI 完成
- CI 红 → 读失败日志 → 分类（code bug vs flaky vs config）→ 修复 → push → 重新等
- 3 次修不好 → 上报（orchestrator: SendMessage to team-lead; manual: 直接提示用户）

**Phase 2: Merge**
- `gh pr merge {PR} --squash --delete-branch`
- 仅在 CI 绿后执行

**Phase 3: Post-merge**
- 归档文档 (`git mv doc/plan/inprogress/ → archive/`)
- 更新 MEMORY.md、CLAUDE.md
- 更新 Linear issue → Done
- 清理 worktree

### D. Orchestrator 层面增强（互补）

- orchestrator.md Ship Gate 段已有文档，但可以简化为「调 `/ship-pr`」
- 减少 orchestrator.md 的 inline 步骤，统一入口

## 推荐方案

**C + D 组合**：
1. 创建 Flywheel 项目本地 `/ship-pr` skill — 核心实现
2. 更新 orchestrator.md — Ship Gate 引用 `/ship-pr` 而非 inline 步骤
3. 无需 GitHub Action 或 branch protection

## 交付物

| 交付物 | 路径 | 说明 |
|--------|------|------|
| Flywheel ship-pr skill | `.claude/commands/ship-pr.md` | CI gate + fix loop + merge + post-merge |
| orchestrator.md 更新 | `.claude/commands/orchestrator.md` | Ship Gate 段引用 `/ship-pr` |
| spin.md 更新 | `.claude/commands/spin.md` | Archive 段对齐 ship-pr |

## Acceptance Criteria 映射

| AC | 方案覆盖 |
|----|----------|
| PR 不能在 CI 红的情况下被 merge | `/ship-pr` Phase 1 强制 CI green |
| Ship 流程有 fix loop | Phase 1 classify → fix → push → recheck |
| 3 次修不好自动上报 | Phase 1 escalation logic |
| 流程对所有 Flywheel PR 生效 | 项目级 skill，orchestrator + 手动共用 |

## 风险

| 风险 | 缓解 |
|------|------|
| 无 branch protection → 可以绕过 skill 直接 `gh pr merge` | 文化约束 + orchestrator 强制走 skill |
| Fix loop 可能引入新 bug | 3 次上限 + 每次修复后完整 CI 重跑 |
| CI flaky test 导致无限循环 | 分类 flaky vs code bug，flaky 用 `gh run rerun` |
