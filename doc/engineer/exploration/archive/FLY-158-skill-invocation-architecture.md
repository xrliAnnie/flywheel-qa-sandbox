# Exploration: Skill invocation architecture — FLY-158

**Issue**: FLY-158 (Designer Runner `Skill(onboard-designer)` blocked by `disable-model-invocation` frontmatter)
**Date**: 2026-05-17
**Status**: Draft — awaiting Codex plan-phase decision on fix mechanism
**Linear**: https://linear.app/geoforge3d/issue/FLY-158

## TL;DR

- **症状**: Designer Runner spawn 后调 `Skill(onboard-designer)` 直接被 Claude Code harness block — onboarding 流程跑不起来。
- **根因（已验证）**: `~/Dev/GeoForge3D/.claude/skills/onboard-designer/SKILL.md` frontmatter 第 3 行 `disable-model-invocation: true`。这是 Claude Code 官方机制 — AI 通过 `Skill(...)` 触发会被 harness 直接拒，只允许 user 手动 `/onboard-designer` slash command。
- **影响面**: 不是 onboard-designer 一个 skill — `~/Dev/GeoForge3D/.claude/skills/` 下 **21 个 skill** 全部带这条 flag，**7 个 executor agent** 都会撞上同一个墙。
- **Annie 决策（scope）**: 一刀切修 21 个 skill；不动 9 个 worktree（合 main 后自然带 fix）。
- **Open question（plan 阶段）**: 具体修复机制（删行 / 设 false / 加 allowed-tools allowlist）由 Codex 评估。

## Problem

### Peter 的假设
Peter 在 FLY-158 issue 中怀疑：Designer Runner 的 `Skill(onboard-designer)` 失败是因为 SKILL.md frontmatter 有 `disable-model-invocation` 字段，封死了 AI invocation。

### 验证结果：✅ 假设成立

`~/Dev/GeoForge3D/.claude/skills/onboard-designer/SKILL.md`:

```yaml
---
name: onboard-designer
disable-model-invocation: true
description: Onboard Designer
---
```

Claude Code harness 对 `disable-model-invocation: true` 的 skill 行为：
- `Skill(...)` tool call → 立即 block，return InputValidationError 风格错误
- 只允许 user 在 CLI 直接打 `/onboard-designer` 触发
- Runner 是 AI session（无 user 在前端），永远没机会触发，等于 skill 死锁

### 这不是 onboard-designer 一个 skill 的问题

Audit 整个 `~/Dev/GeoForge3D/.claude/skills/`（21 个 skill 全部 `disable-model-invocation: true`）：

| 类别 | Skills |
|------|--------|
| Onboarding (Runner spawn 第一步) | `onboard`, `onboard-designer`, `onboard-marketing`, `onboard-operations`, `onboard-product`, `onboard-qa` |
| Implementation (Runner 主流程) | `backend-implementation`, `frontend-implementation`, `designer-implementation`, `product-implementation` |
| Validation / Test | `backend-integration-test`, `backend-premerge-validation`, `frontend-integration-test`, `frontend-premerge-validation`, `e2e-integration-test`, `cli-test` |
| Handoff (Plan 阶段) | `handoff-to-backend-plan`, `handoff-to-frontend-plan`, `plan-to-linear` |
| Brainstorm / Orchestrator | `brainstorm`, `orchestrator` |

**Runner-critical 的全在里面**。AI executor 走 `Skill(...)` 一个都通不过。

### 受影响的 executor agent（7 个）

`~/Dev/GeoForge3D/.flywheel/agents/`：

- `product/designer-executor.md` — Designer Runner（FLY-158 直接 trigger）
- `product/qa-executor.md`
- `product/qa-parallel-executor.md`
- `qa-plan-generator-executor.md`
- `plan-generator-executor.md`
- `operations/operations-executor.md`
- `marketing/marketing-executor.md`

每个 executor prompt 都引用了 onboard-* / *-implementation / *-test / handoff-* 中至少一项。Designer 是第一个被 Annie 实际跑到的 — 其余 6 个一旦 spawn 也会同样 dead。

### Worktree 状态

9 个 active worktree（`~/Dev/GeoForge3D/worktrees/`）各自带一份 stale `.claude/skills/` 拷贝。Annie 决定：**不动 worktree**，主 checkout 修完合 main 后，worktree 后续 merge/rebase 自然带 fix。Runner 通常在主 checkout 跑，worktree 里 spawn Runner 是少数 case，可接受 transitional risk。

### 上游 marketplace（不动）

`~/.claude/plugins/marketplaces/...` 下若干 official skill（claude-automation-recommender, command-development, code-review 等）也带 `disable-model-invocation: true`。那是上游 plugin 作者的 user-only 约定，**不在 FLY-158 范围**，不要碰。

## Annie 决策记录

| 问题 | 决策 |
|------|------|
| Scope | **21 个 skill 全修，一刀切** — 不挑食、不保留 user-only 入口（`orchestrator` / `onboard` 也开放给 AI invoke） |
| 修复方式 | **延后到 plan 阶段，由 Codex 评估** — 删行 / 设 false / 加 `allowed-tools` allowlist 三选一 |
| Worktree 同步 | **不动 worktree** — 等 main merge 后自然带 fix |

## Open Questions for Codex（Plan 阶段）

Plan 阶段需要 Codex 评估并定方案，brainstorm 阶段不预先选。

### Q1: 三个修复 candidate，哪个更对？

**Option A: 直接删 `disable-model-invocation: true` 行**
- ✅ 简洁、frontmatter 最小化
- ✅ Claude Code default 行为就是 AI invocation enabled，删行 = 恢复 default
- ⚠️ 如果 Annie 未来手动管理 / 想关掉某些 skill 的 AI 入口，要重新加回来

**Option B: 改成 `disable-model-invocation: false`**
- ✅ 显式 — frontmatter 明说 AI 可以调
- ✅ 未来 toggle 一行就够，不用记 default
- ⚠️ 多一行噪音；和「删除」语义上等价但更啰嗦

**Option C: 加 `allowed-tools` allowlist 同时设 false**
- ✅ 最严格的 security posture — 明确每个 skill 允许哪些 tool
- ❌ 工程量大 — 21 个 skill 每个都要枚举 allowed-tools，且每加新 tool 都要 maintain
- ❌ 和 FLY-158 解决的问题（AI invocation block）正交 — allowed-tools 是 sub-permission，不解决主问题

**Worker 倾向**: Option A（删行）— 简洁、和上游 default 对齐、维护负担最低。但**等 Codex 拍板**。

### Q2: 是否需要在 repo 加 lint / pre-commit hook 防回归？

每次 skill creator 工具（`skill-creator` agent / `/skill-create` 等）新建 skill 时，default template 可能带 `disable-model-invocation: true`（上游 sample 经常这么写）。如果不加 guard，下一个新 skill 又会复现。

**Plan 阶段需要 Codex 评估**:
- 加一个简单 `bash` 脚本扫 `.claude/skills/*/SKILL.md` 报错？
- 还是改 skill-creator agent prompt 显式禁用这条 flag？
- 还是接受人工 review？

### Q3: 主 checkout 修完，是否 announce + 通知所有 active Runner / Lead session 重启？

- Skill metadata 是 Claude Code session 启动时 load 的 — 修完 main 后，**正在跑的 Runner / Lead 不会 hot-pickup**
- 选项：
  - (a) 只 commit + 通知，让 active session 自然死掉重启
  - (b) Lead 主动 force-restart 所有 Runner？
  - (c) 留个 followup ticket 单独处理 hot-reload 机制

**Plan 阶段决定**。

### Q4: GeoForge3D 还是 Flywheel？

FLY-158 是 Flywheel issue，但被修文件全在 `~/Dev/GeoForge3D/.claude/skills/`。

- PR 目标 repo：**GeoForge3D**（21 个文件都在那）
- Flywheel 这边：只在 `doc/engineer/exploration/new/` 留 brainstorm + plan + retrospect

Plan 阶段需要 confirm — 但应该没有歧义。

## Out of Scope

- 修上游 `~/.claude/plugins/marketplaces/...` 的 skill（那是别人代码）
- 重写 onboard-designer 内容 / 改 onboarding 流程本身
- 改 Skill tool 本身的 harness 行为（这是 Claude Code 上游）
- Worktree stale copy 批量 patch（Annie 决策不动）

## Next Steps

1. ✅ Brainstorm（本文档）— 提交 Annie review
2. ⏭ Research / Plan 阶段：Codex 评估 Q1-Q4，产出 `doc/engineer/plan/draft/v1.27.x-FLY-158-skill-invocation-fix.md`
3. ⏭ Implement：跟 GeoForge3D PR + Flywheel doc archive PR
4. ⏭ Retrospect：merge 后写 retro 记录上游 frontmatter pitfall

## Appendix: Audit commands

```bash
# 找所有受影响 skill
grep -rln "disable-model-invocation" ~/Dev/GeoForge3D/.claude/skills/

# 找所有调 onboard-* skill 的 agent
grep -l "onboard-designer\|onboard-product\|onboard-marketing\|onboard-operations\|onboard-qa\|^onboard$\|/onboard " \
  ~/Dev/GeoForge3D/.flywheel/agents/*.md ~/Dev/GeoForge3D/.flywheel/agents/*/*.md

# 验证 frontmatter
head -8 ~/Dev/GeoForge3D/.claude/skills/onboard-designer/SKILL.md
```
