# Design: FLY-124 Sandbox Happy-Path — QA E2E dummy change

**Issue**: FLY-124 ([Sandbox] FLY-SBX-1 — dummy issue for QA E2E testing)
**Date**: 2026-07-17
**Status**: Complete (design-phase handoff)
**Exec**: acdd8abd-baa0-4d5a-ad3e-441bbd53802c (slot 3, three-stage pipeline design node)

## 目标

驱动一次完整的 Runner happy path,不影响任何真实产品 issue:
在 sandbox repo (`xrliAnnie/flywheel-qa-sandbox`) 的 `README.md` 末尾追加一行 `Hi`,
开 PR → 等 approve → ship + merge。

## 现状确认(design 节点已核实的事实)

| 事实 | 值 |
|------|-----|
| 本 worktree origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`(即 sandbox repo 本身) |
| 当前分支 | `project-slot-3-FLY-124`,工作区干净 |
| origin 默认分支 | `main` @ `7049f719` |
| 根目录 `README.md` | **不存在**(sandbox 重置后的当前状态没带根 README) |

## 关键假设(已显式化)

Issue spec 说 "append one line `Hi` to the end of `README.md`",但当前根目录无
`README.md`。**处理方式**:`printf 'Hi\n' >> README.md` 对不存在的文件即创建,
产出「新文件 README.md,内容单行 `Hi`」的最小 diff——与 spec 的最小变更意图一致。
若 implement 时 README.md 已被重置回存在,同一命令即为末尾追加,两种情况同一条命令覆盖。

## Implement 阶段步骤(handoff)

1. 在本 worktree、本分支(`project-slot-3-FLY-124`)执行:
   ```bash
   printf 'Hi\n' >> README.md
   ```
   (若文件已存在且末尾缺换行,先补 `\n` 再追加,保证 `Hi` 独占一行。)
2. 提交:`test(FLY-124): append Hi to README (QA sandbox happy path)`
3. `git push -u origin project-slot-3-FLY-124`
4. 开 PR:base = sandbox repo `main`,PR body 带 Linear issue 段(FLY-124)。
5. 按 pipeline 汇报并等 approve;ship + merge 由后续阶段/founder 按门禁走,
   implement 节点不得自 merge。

## 验收标准

- PR diff 恰好一处变更:`README.md` 末尾一行 `Hi`(或新文件单行 `Hi`),无其他文件改动。
- PR base 是 `xrliAnnie/flywheel-qa-sandbox` 的 `main`,不是主 flywheel repo。
- FLY-124 issue 保持 open,scope 零改动。

## 边界与禁区(来自 issue,逐字遵守)

- 不 close FLY-124(QA suite 永久需要它)。
- 不往这个 issue 上挂真实工作。
- 不修改 issue scope。
- sandbox repo 会在 QA run 之间被 wipe/reset——不要依赖仓库内容的持久性。
