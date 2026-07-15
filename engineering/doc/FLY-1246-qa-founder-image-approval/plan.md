# FLY-1246 独立 QA·PR #584 — QA 执行计划

Issue: FLY-1246 (https://linear.app/geoforge3d/issue/FLY-1246/qa-fly-1240-独立验证-pr-584删-founder-image-approval-死码)
日期: 2026-07-14
基于: research.md

## 执行步骤（checklist）

1. **[①] Fresh checkout**
   - `git worktree add worktrees/fly1240-qa ed9823622` → 校验 `HEAD == ed9823622`
   - `pnpm install --frozen-lockfile`（fresh）

2. **[③] 零残留 grep**（先做，便宜的信号）
   - 全仓扫 7 个 pattern，排除 node_modules/dist/.git
   - 判据：代码文件 0 命中

3. **[②] config 套件**
   - `pnpm --filter flywheel-config test` → 期望 394 passed（含 drift-guard 3）

4. **[②] teamlead 套件**
   - `pnpm --filter flywheel-teamlead test` → approval-signal 相关全绿
   - 观察是否有 PR 声称的 6 个 pre-existing 失败

5. **[④] 行为不变抽查**
   - `git diff --name-only origin/main...ed9823622` → 确认触及文件集 == PR 描述
   - `types.ts` 现存 `reaction`/`text`/`voice` 三变体、仅 image 删
   - `reaction-approval-source.ts` / `text-approval-source.ts` 与 main byte-identical
   - `voice-approval-source.ts` / `founder-reply-deliverer.ts` 仅注释改动

6. **[②] typecheck**
   - `pnpm -r build`（产 config dist 供跨包解析）
   - config + teamlead `tsc --noEmit` → 0 errors

7. **[②] biome**
   - `biome check` 变更文件 → 0 errors

8. **[⑤] CI 状态 + pre-existing 复现**
   - `gh pr checks 584` → 全绿
   - 若 teamlead 有失败：`git stash`/checkout 干净 `origin/main` 复跑同一批失败文件，
     确认相同失败复现（环境性，非本 PR 引入）

9. **产出**
   - 写 `qa-report.md`（PASS/FAIL verdict + 逐项证据）到本分支
   - push `flywheel-FLY-1246` + 开 QA PR（不碰 #584）
   - emit qa-result verdict + 报 Lead
   - **不 ship 不合并**

## PASS 条件

①–⑤ 全绿：fresh checkout OK + config/teamlead 套件相关全绿 + typecheck/biome clean +
零代码残留 + 三路径完整未波及 + CI 绿且 pre-existing 失败已归因为环境性。

## FAIL 条件（任一）

- 代码层残留任一 pattern（悬挂引用）
- config drift-guard 用例红
- reaction/text/voice 任一路径被波及（types 变体缺失 / source 文件被逻辑改动 / 相关测试红）
- typecheck 或 biome 报错
- teamlead 出现**非** pre-existing 的新失败（在干净 main 不复现）
