# Spike: `cmux refresh-surfaces` 是否可修 H2 — FLY-129 Phase 0

**Issue**: FLY-129
**Date**: 2026-05-22
**Author**: worker-fly-129
**Status**: PASS (team-lead live-verified 2026-05-22 23:18 UTC) — Path A only, Path B removed

---

## 1. 目的

按 plan §3 Phase 0 decision tree，验证 `cmux refresh-surfaces [--workspace <ref>]` 是否能 invalidate cmux Electron 渲染端缓存、修 H2（Lead daemon 重启后 cmux UI 显示旧 pane snapshot），从而把 Phase 8 实现从 close-and-recreate (~51s UI 闪烁) 缩到 refresh-surfaces (instant)。

## 2. 实测证据

### 2.1 命令存在 + 可调用 (2026-05-22)

```bash
$ cmux --help 2>&1 | grep refresh
  refresh-surfaces
  surface-health [--workspace <id|ref>]
  trigger-flash [--workspace <id|ref>] [--surface <id|ref>]
```

```bash
$ cmux refresh-surfaces
OK Refreshed 1 surfaces   (rc=0)

$ cmux refresh-surfaces --workspace workspace:1
OK Refreshed 1 surfaces   (rc=0)
```

→ 命令在当前生产 cmux 版本中存在、可调用、无 socket 错误、返回 0。

### 2.2 行为观察 — 注意点

```bash
$ cmux refresh-surfaces --workspace workspace:99999
OK Refreshed 1 surfaces   (rc=0)
```

→ **传无效 ref 也返回 "OK Refreshed 1 surfaces"**。这表明 cmux 对 `--workspace` 参数要么静默 fallback 到当前 active workspace，要么 ref 校验是 best-effort。**生产侧不能完全信任 stdout 判断 refresh 是否 hit 目标 workspace**。

这点不影响 Path A 可行性（我们只需调 refresh，命中即可），但意味着 audit log 不能依赖 cmux 返回值断言 refresh 成功 — 只能记录"已调用"。

### 2.3 H2 destructive reproduction — **team-lead live-verified 2026-05-22 23:18 UTC**

worker-fly-129 Phase 0 spike 没做 destructive 验证（怕 disrupt prod ops-lead）。**team-lead 之后在 prod 实地做了**:

1. Annie 撞到 H2: cmux sidebar 显示 11 workspaces 但点进去显示 stale zsh，不是 active Claude
2. team-lead 跑 `cmux refresh-surfaces --workspace <ref>` 对所有 workspace iterate
3. workspace 内容立即正确显示 — H2 修

→ **Path A 行为 confirmed in prod**。worker 后续 hybrid 方案中的 Path B 转为 dead code，已在 PR #188 Codex R1 review 时整体删除。下面 §2.4 historical 段保留 worker 决策当时的 reasoning（reproducibility audit trail）。

### 2.4 Historical: worker-fly-129 spike-time reasoning (deprecated by §2.3)

按 plan Phase 0 step 1-3，完整 spike 需要:
1. kill ops-lead `claude-lead.sh` 进程
2. wait Lead daemon 重启
3. 打开 cmux UI 找到对应 workspace 看是否显示空 zsh
4. 跑 `cmux refresh-surfaces --workspace <ref>` 看是否切到 active Claude
5. 重复 ≥2 次

**未执行原因**:
- 本环境是 Annie 生产机器，ops-lead 正在跑实际工作；杀进程会中断她的 Lead pipeline
- CLI worker 无法打开 cmux Electron UI 做视觉验证
- 自然重现 H2 需等 Lead daemon 重启周期（不可控）

研究 doc §3.2 (FLY-129-cmux-research-followup.md) 已 confirm H2 现象 + close-and-recreate workaround 在 2026-05-17 由 Annie 现场跑通。但当时 cmux 是否已经暴露 `refresh-surfaces` 不清楚（research 写"cmux IPC API 没有 force re-render 入口"，跟今日实测矛盾 —— 要么是 cmux 版本升级新增，要么是 research 当时漏看）。

## 3. 决策 (updated 2026-05-22 post team-lead live-verify)

**Path A only**. Path B 已删除 (commit 见 PR #188 Codex R1 round)。 historical hybrid reasoning preserved below.

### 3.0 Historical decision (deprecated by §2.3)

worker 当时 spike 受限于不能 disrupt prod ops-lead，选 hybrid:

### 3.1 Path A as primary (新增, 默认启用)

- 在 `trigger_cmux_refresh` 的 `--refresh` 之后 schedule `cmux refresh-surfaces --workspace <ref>` (覆盖 flywheel session 所有 lead workspace)
- 由 `FLYWHEEL_CMUX_H2_FIX` env var gate (默认 `refresh-surfaces`，可设 `none` 关掉)
- Audit log: `[audit] refresh-surfaces ws=<ref> rc=<rc>` per ref
- 不调阻塞主路径：失败/超时不影响 `--refresh` 已经完成的 tmux 侧修复

### 3.2 Path B retained as escape hatch (不删)

- 保留 `scripts/flywheel-cmux-sync.sh --close-for-restart` mode + pending-invalidation file 逻辑
- 不在 trigger_cmux_refresh 默认路径调用
- Annie 手动需要时可 `bash scripts/flywheel-cmux-sync.sh --close-for-restart --session flywheel`
- 日后 Path A 在 prod 验证 ≥1-2 周稳定后，开新 issue 删 --close-for-restart

### 3.3 为什么 hybrid 不是 over-engineering

Plan §3 Phase 0 决策树 binary 假设我们能完整 spike。当我们只能验证"命令存在 + 调用 OK"但无法验证"修了 H2"时:
- 直接走 Path A 删 Path B = risk: 如果 prod 实际 H2 cache scenario refresh-surfaces 不够，无 fallback
- 直接走 Path B 不用 refresh-surfaces = 浪费已知的 cheap fix
- Hybrid = 既享受 refresh-surfaces 廉价正常路径，又保留 close-and-recreate 应急路径，env var 1 行翻转

代价: Phase 8 多 ~30 行代码（Path B 已经在 plan §3 P8 详写），多 5 个 unit test (Path B 全部测试都跑)。**净 PR size 多 ~40 行**。比起删错路径的运维风险，值得。

## 4. 对 Plan 的影响

- Phase 8 实现 **同时包含 Path A + Path B 代码**（不互斥）
- Phase 8 unit tests 都跑（Path A 2 个 + Path B 6 个 = 8 个）
- Plan §3 P8 文字 "两条路径，由 Phase 0 spike 结果决定" 需调整为 "Path A 默认执行，Path B 保留为 escape hatch"
- AC14 / AC15 同时覆盖
- 新增 env var: `FLYWHEEL_CMUX_H2_FIX={refresh-surfaces|none}` (default: `refresh-surfaces`)
- 新增 doc note: "Path B 删除需待 Path A prod 验证 ≥1 周后开新 issue"

## 5. 后续 issue

如果 Path A 在 prod 跑 1-2 周稳定 (i.e. 观察到至少 3 次 Lead daemon 重启后 cmux UI 立即恢复, Annie 不再 manual workaround), 开 issue **FLY-129-followup-remove-path-b**:
- 删 `--close-for-restart` mode + pending-invalidation file 逻辑
- 删 Path B unit tests
- 更新 plan §3 P8 文字

如果 Path A 在 prod **不**够 (H2 仍出现 ≥1 次 post-Path-A)，开 issue **FLY-129-followup-promote-path-b**:
- 把 Path B 接入 default trigger_cmux_refresh
- env var 默认改 `none` 或 `close-and-recreate`

## 6. 结论

PARTIAL PASS — `cmux refresh-surfaces` 命令存在且可调用。无法做 destructive H2 重现（需 disrupt prod ops-lead）。采取 hybrid Path A + Path B 策略 + env var gate，实现 Phase 8 时两条路径都写、都测，prod 用 env var 控制启用哪一个。
