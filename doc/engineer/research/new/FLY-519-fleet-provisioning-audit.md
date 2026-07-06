# Research: Fleet Provisioning — 现有基础设施审计 — FLY-519

**Issue**: FLY-519
**Date**: 2026-06-23
**Source**: `doc/engineer/exploration/new/FLY-519-fleet-provisioning.md`

审计结论一句话：**绝大部分 per-lead/Bridge 的 launchd 机制已存在**，FLY-519 = 编排 +
capture/provision + 干净机器缺口 + 校验 + runbook，**不重造轮子**。

---

## 1. 已存在的复用件 (REUSE — 不重写)

| 件 | 路径 | 作用 | provision 里怎么用 |
|---|---|---|---|
| 单 lead manifest+plist 生成 + launchctl bootstrap | `scripts/flywheel-daemon.sh` (`generate_plist_to`, `install`) | 从 manifest 生成 plist、`plutil -lint`、原子 rename、bootstrap | launchd phase 直接调 |
| fleet plan/apply/rollback | `scripts/flywheel-fleet.sh` | 从 `~/.flywheel/projects.json` 批量起 leads (事务/journal/recover) | launchd phase 调 apply |
| Bridge / lead launchd wrapper | `scripts/flywheel-bridge-wrapper.sh`, `scripts/flywheel-lead-wrapper.sh` | `set -a; source ~/.flywheel/.env`、token 间接查找、backend dispatch | 装到 `~/.flywheel/bin/` |
| cmux 安装 + watcher plist | `scripts/flywheel-cmux-install.sh`, `com.flywheel.cmux-watcher.plist.template` | cmux 集成 + launchd watcher (sed 渲染 `__HOME__`) | deps/launchd phase 调 |
| 新项目脚手架 + gated cutover 清单 | `scripts/setup-new-project.sh` | 形态参考 (phase 化 + founder-gated checklist) | 形态借鉴 |
| skills 分发 | `~/.flywheel/bin/skills-sync.sh` (FLY-216) + `~/Library/LaunchAgents/com.flywheel.skills-update.plist` | launchd 每天从 canonical repo 同步 skills | skills phase 调 |
| Bridge 健康 smoke | `docs/operations/bridge-daemon-management.md` (`curl /api/runs/active`) | Bridge HTTP 探活 | validate phase 用 |

## 2. 真相来源 = `~/.flywheel/projects.json` (FLY-247)

- **lead 配置单一真相** = `~/.flywheel/projects.json`，schema 在
  `packages/teamlead/src/ProjectConfig.ts` (`LeadConfig`: agentId / chatChannel /
  match.labels / **botTokenEnv** (token env 名, 非值) / model / backend / companion /
  codexProfile / canSpawnRunners)。
- manifest (`~/.flywheel/manifests/<proj>-<leadId>.json`) 是**派生**件，由 daemon/fleet 生成。
- plist (`~/Library/LaunchAgents/com.flywheel.lead.<proj>-<leadId>.plist`) 也是**派生**件，
  由 `generate_plist_to` 从 manifest 生成 → 新机只要有 projects.json，跑 daemon/fleet apply 即重建。
- ⇒ **capture 只需快照 projects.json (+ 远端 URL / 辅助任务清单 / env key 清单)；
  provision 跑 daemon/fleet 重建 manifest + plist**。

## 3. 当前活机 fleet 实况 (capture 要覆盖的)

- **13 个 lead plist** (与 issue 吻合)：flywheel-cos, flywheel-eng, geoforge3d-cos,
  geoforge3d-ops, geoforge3d-product, growth-mufasa, growth-rafiki, growth-reflection,
  joycon, personal-assistant-belle, sub, tidal-echo-content, tidal-echo-cos。
- **辅助 launchd 任务** (非 projects.json 驱动, 各有 repo 模板/静态 plist)：
  `com.flywheel.bridge` (`scripts/launchd/`), `com.flywheel.cmux-watcher` (template),
  `com.flywheel.daily-standup`, `com.flywheel.skills-update`, `com.flywheel.updater`,
  `com.flywheel.sub-daily-loop`, `com.flywheel.xiaohongshu-learning`。
- **`~/.flywheel/bin/`** 的运行时脚本 (lead/bridge wrapper, skills-sync, cmux-sync,
  update-flywheel, post-compact-bootstrap 等)。
- **secret 所在 (capture 必须剥)**：`~/.flywheel/.env` (真值), `*.db` (teamlead/audit/
  cipher/dedup), `codex-homes/` (codex auth), `~/.config/gh` (gh auth)。

## 4. Token 处理现状

- 真值在 `~/.flywheel/.env`，wrapper 用 `set -a; source` 导出 (FLY-142)。
- manifest 只存 `botTokenEnv` (env **名**)，wrapper 用 bash 间接展开
  `DISCORD_BOT_TOKEN="${!BOT_TOKEN_ENV}"`。
- **现状缺口**：无 `.env.example`、无 token 占位/非空校验机制。← FLY-519 要补。

## 5. 缺口 (FLY-519 要补的)

1. **toolchain 装** —— 现状假设 node/pnpm/git/jq/brew/cmux/codex/claude 都预装。
2. **repo clone** —— 无初始 clone (flywheel + projects.json 引用的各 project)。
3. **`~/.flywheel/` bootstrap** —— 目录骨架 + materialize projects.json + `~/.flywheel/bin/`。
4. **token 占位 + 非空校验** —— `.env` 占位模板 + 启动前校验。
5. **capture/脱敏** —— 把活机拓扑脱敏快照成 committed artifact + secret-scan。
6. **端到端 validate phase** —— Bridge up / plist loaded / 进程活 / dispatcher smoke。
7. **runbook** —— Annie 手动步骤 (真 token / 状态 restore / 账号)。

## 6. 测试 idiom (照抄)

`scripts/__tests__/*.test.sh` —— 纯 bash，hermetic：`HOME` = `mktemp -d` sandbox、
env 覆盖 stub 外部二进制 (如 `FLYWHEEL_DAEMON_PLUTIL`)、`pass`/`fail` 计数、失败 exit 1、
函数经 `*_SOURCED=1` guard source。参考 `flywheel-daemon-plist-env.test.sh`。

## 7. 平台事实

- 目标机 = MBP 16" M5 Max 48GB (Apple Silicon) → Homebrew 在 `/opt/homebrew`。
- 当前活机 PATH 已含 `/usr/local/bin`, `/opt/homebrew/bin` (restart-services.sh)。
