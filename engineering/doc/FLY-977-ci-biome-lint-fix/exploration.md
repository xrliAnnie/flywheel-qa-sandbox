# FLY-977 修 main 上 biome lint red — 探索

Issue: FLY-977 (https://linear.app/geoforge3d/issue/FLY-977/修-ci-biome-lint-red-on-main-fly-968-spike-文件-格式化修好不排除)
日期: 2026-07-07
基于: 无

## 问题

`main` 上 CI 是 red。根因是 `pnpm lint`（= `biome check`）对 FLY-968 spike PR #494 引入的一批一次性 `.mjs` 脚本报格式化 / lint 错误。PR #494 被 Annie 授权「直接 merge dummy」，Lead 用 admin 合进去了 → main 现在带着这条 lint red，**任何人往 main 合都会碰到同一个 red CI**（`ci.yml:62` 和 `ship-on-comment.yml:126` 都跑 `pnpm lint`），挡着 Voice 批次和其他人。

## 现状（本地全仓已复现 + 交叉验证）

`pnpm lint` 输出 **20 errors + 17 warnings**。Lead 让我别只盯 FLY-968、跑全仓确认哪些文件 red（特别点名 FLY-960 spike 可能也 red）。**实测三种方法交叉验证**（`--reporter=summary`、`--reporter=github` 逐条列 error 文件、排除 FLY-968 目录后重跑）——结论一致：

- **20 个 error 全部落在 `engineering/spike/FLY-968-voice-bakeoff/` 的 8 个文件**；
- 排除 FLY-968 目录后全仓 **0 error**（`::error` grep 为空）。

FLY-968 的 20 个 error 按规则拆：

| 类别 | 数量 | 级别 | 能否 `--write` 安全自动修 |
|------|------|------|--------------------------|
| Formatter（格式化） | 8 | error | ✅ 是（8 个文件） |
| `assist/source/organizeImports`（import 排序） | 6 | error | ✅ 是 |
| `lint/suspicious/noAssignInExpressions` | 6 | error | ❌ 否，需手改 |

另有 2 个 warning 落在同一批 FLY-968 spike 文件里（`noUnusedImports` × 1、`noUnusedVariables` × 1），一并修。

### FLY-960 spike（Lead 点名，实测确认）
`engineering/spike/FLY-960-dave-stt/` **0 error**，仅 1 warning（`probe-join.mjs` 未用 import `VoiceConnectionStatus`）+ 1 info（`login-smoke.mjs` `useTemplate`）—— **不是** CI red 的来源。但按 Lead「一起修、别漏」，把它这 2 条也弄干净，让两个 spike 文件夹都全绿。

### 明确不碰（out of scope）
`packages/**` 的测试文件（`DirectEventSink.test.ts` 等）+ `scripts/qa-fly-863-*.mjs` 也出现在诊断里，但**全是 warning/info、0 error**、FLY-968 之前就有、不 gate CI，且属生产/测试代码 —— 不在本 issue 范围，不动。

## 关键事实 — warning 不会让 CI red

CI 跑的是裸 `biome check`（无 `--error-on-warnings`）。Biome 默认只在存在 **error** 级诊断时退出非零。所以：

- main 变 red 的**唯一**原因 = 那 20 个 error（全在 spike 里）；
- 仓库其它地方的 ~15 个 warning 在 #494 之前就有、之前 CI 一直是 green ⇒ 佐证 warning 不 gate CI；
- 只要把 20 个 error 清零，`pnpm lint` 退 0 ⇒ CI green。

## 目标 & 约束（Annie 明确 + Lead scope 修正）

- **修好，不排除**：真正把这些文件格式化 / lint 修对，让它们符合仓库 biome 规则。**不**用 `biome.json` ignore、`// biome-ignore` 抑制、或改 lint 规则去绕过 —— 那样代码仍不合规，下一个 spike 落地或有人跑 `--write` 就再 red。
- **全仓视角**（Lead）：目标 = `pnpm lint` 退 0；修 FLY-968 的 20 个 error + 顺手清 FLY-960 的 1 warning + 1 info。
- **不删文件**（spike 脚本保留，作为 FLY-968/FLY-960 证据）。
- **不碰生产代码**（只动 `engineering/spike/FLY-968-voice-bakeoff/` + `engineering/spike/FLY-960-dave-stt/`；`packages/**`、`scripts/**` 不动）。
- **不改 lint 规则**（`biome.json` 不动）。

## 验收

- 本地 `pnpm lint` / `pnpm biome check` 退 0（0 error）⇒ CI green；
- 两个 spike 文件夹（FLY-968 + FLY-960）0 error 0 warning；
- 无文件删除、无生产/测试代码改动、无 `biome.json` 改动。
