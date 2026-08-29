# FLY-1246 独立 QA·PR #584 — 调研（方法论 + 隔离方案）

Issue: FLY-1246 (https://linear.app/geoforge3d/issue/FLY-1246/qa-fly-1240-独立验证-pr-584删-founder-image-approval-死码)
日期: 2026-07-14
基于: exploration.md

## 独立性保证（零共享）

- **隔离 worktree**：`git worktree add worktrees/fly1240-qa ed9823622`（detached HEAD 在
  被测 commit）。与实现 runner 的工作目录、node_modules 完全隔离。
- **fresh install**：worktree 内 `pnpm install --frozen-lockfile`，从共享 store 重建
  node_modules（不复用任何实现侧构建产物）。
- **不碰被测分支**：所有 QA 产物写到我自己的 `flywheel-FLY-1246` 分支，**绝不**推
  `flywheel-FLY-1240`——保 head `ed9823622` 冻结、review 绑定不失效（head-freeze 纪律，
  经 Lead 确认）。

## 验证手段与判据

| 维度 | 手段 | PASS 判据 |
|------|------|-----------|
| ① fresh checkout | worktree @ ed9823622 + `git rev-parse HEAD` | HEAD == ed9823622 |
| ② config 套件 | `pnpm --filter flywheel-config test` | 394 passed，含 `feature-flags-drift`(3) |
| ② teamlead 套件 | `pnpm --filter flywheel-teamlead test` | approval-signal 相关全绿；无新增失败 |
| ② typecheck | config + teamlead `tsc --noEmit` | 0 errors |
| ② biome | `biome check --changed --since=origin/main` | 0 errors |
| ③ 零残留 | grep 全仓（排除 node_modules/dist/.git） | 代码层 0 命中 |
| ④ 行为不变 | diff name-only + types 变体 + 三 source 文件 unchanged | reaction/text/voice 完整未波及 |
| ⑤ CI | `gh pr checks 584` + 6 个 pre-existing 失败在干净 main 复现 | CI 绿；6 失败非本 PR 引入 |

## 关键 grep pattern（③ 零残留）

- `founder_image_approval`
- `FLYWHEEL_FOUNDER_IMAGE_APPROVAL`
- `imageApproval`
- `evaluateImageImpl`
- `image-approval-source`
- `ImageAttachment`
- `source: "image"`（ApprovalSignal 变体）

**注**：PR 自带的 `exploration.md`（实现侧 doc）会为了描述"删了什么"而提到这些词——那是
文档叙述，不是代码残留。判据只看**代码文件**（.ts/.js/.mjs）中的活引用。

## 依赖构建注意

`flywheel-config` 的 `main`/`types` 指向 `dist/`（fresh checkout 无 dist）。teamlead 的
`tsc --noEmit` 需要 config 的 `dist/*.d.ts` 才能解析跨包类型 → typecheck 前需先
`pnpm -r build`（或至少构建 config 及 teamlead 的 workspace 依赖）。此构建从 ed9823622 源码
产生，仍属零共享。vitest 侧本地 source 直跑，approval-signal 测试是否依赖 config dist 由实测
确认。
