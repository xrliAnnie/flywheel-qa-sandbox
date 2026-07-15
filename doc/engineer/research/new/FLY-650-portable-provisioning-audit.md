# Research: 可移植 provisioning — 现有耦合面审计 — FLY-650

**Issue**: FLY-650
**Date**: 2026-06-28
**Source**: `doc/engineer/exploration/new/FLY-650-portable-provisioning.md`

审计结论一句话：**load-bearing 的 macOS 耦合只有一处真硬骨头 = launchd supervisor**；
其余（cmux/osascript/plutil）非 load-bearing、可降级为可选；Homebrew 是平台化 deps；
核心/项目分离的"数据面"（projects.json）已 Done，缺的是"机器/平台/部署面"的外置。

---

## 1. FLY-519 已有 toolchain（要扩展的对象）

| 件 | 路径 | 作用 |
|---|---|---|
| capture | `scripts/fleet-capture.sh` | 活机 → 脱敏 artifact `fleet/{projects.json,env.example,manifest.json}`；secret-scan 红线 gate |
| provision | `scripts/provision-fleet-host.sh` | phased / dry-run 默认 / idempotent。phases: `preflight deps repos flywheel-home tokens skills launchd validate` |
| sanitize lib | `scripts/lib/fleet-sanitize.sh` | `redact_env_to_keys` + `scan_for_secrets`（3 层防泄密） |
| daemon | `scripts/flywheel-daemon.sh` | 单 lead manifest→plist 生成 + `plutil -lint` + 原子 rename + launchctl bootstrap |
| fleet | `scripts/flywheel-fleet.sh` | 从 projects.json 批量 model/backend cutover（事务/journal/recover） |
| restart | `scripts/restart-services.sh` | Bridge + 辅助 launchd 任务的 (re)load（idempotent） |
| 测试 idiom | `scripts/__tests__/*.test.sh` | 纯 bash、hermetic：`HOME`=mktemp sandbox、stub 外部二进制（`FLYWHEEL_DAEMON_LAUNCHCTL`/`FLYWHEEL_DAEMON_PLUTIL`、PATH stub brew/git/launchctl/curl/pnpm）、`pass`/`fail` 计数、`*_SOURCED=1` guard source |

## 2. macOS 耦合面（逐项 + load-bearing 判定）

### 2.1 launchd —— ✅ load-bearing，**唯一真硬骨头**

- `flywheel-daemon.sh`：`PLIST_DIR=~/Library/LaunchAgents`；`generate_plist_to()` 生成
  `.plist`、`plutil -lint`、原子 rename；`launchctl bootstrap/bootout/kickstart/print`；
  双实例守卫（old PID 存活不 bootstrap）；事务 journal + recover。**已有 seam**：
  `LAUNCHCTL="${FLYWHEEL_DAEMON_LAUNCHCTL:-launchctl}"`、`PLUTIL="${FLYWHEEL_DAEMON_PLUTIL:-plutil}"`（测试可 stub）。
- `restart-services.sh`：`com.flywheel.bridge` + 辅助任务（cmux-watcher / daily-standup /
  skills-update / updater / ...）经 `launchctl kickstart -k`；plist 缺失时 fallback nohup。
- `provision-fleet-host.sh`：`phase_launchd` 委托 `restart-services.sh`；`phase_validate`
  用 `launchctl print gui/$uid/$label` 验 loaded。
- **辅助 launchd 任务**（非 projects.json 驱动）：`com.flywheel.{bridge,cmux-watcher,
  daily-standup,skills-update,updater,sub-daily-loop,xiaohongshu-learning}`。

> ⇒ Linux 需要一个**功能等价的常驻服务管理**：install service / start / stop /
> restart / status / is-loaded。launchd 的天然对应 = **systemd --user** units
> （WSL2 `systemd=true` 支持；per-user 常驻；`systemctl --user`）。container 通常
> **无 systemd** → 需要第三个"foreground/process-supervisor"后端（sub #3，本 issue
> 只留 seam 不实现）。

### 2.2 Homebrew —— ✅ load-bearing（装工具链），平台化即可

- `fleet-capture.sh` 的 `DEPS_JSON` 写死 brew formula：
  `node/pnpm/tmux/gh/jq/git`（brew）+ `cmux/codex/claude/kimi/agy`（manual）。
- `provision-fleet-host.sh` `phase_deps`：`brew install ${formula}`，缺 brew 时
  narrate 装 Homebrew。
- **Linux 对策**：manifest `deps[]` 每项带 per-platform 包名/channel（brew formula vs
  apt/dnf package vs "已present/corepack/nvm"）；provisioner 按 `uname` 选。node/pnpm
  Linux 上常走 nvm/corepack 而非系统包 → deps 描述要能表达"present 即可、不强装"。

### 2.3 tmux —— ✅ load-bearing，**已跨平台无需改**

- Lead/Runner 执行底座（`TmuxAdapter` + `Codex/Kimi/AntigravityTmuxAdapter`）。
  tmux 在 Linux 原生。

### 2.4 cmux —— ❌ 非 load-bearing（macOS 窗口可视化），Linux 跳过

- `flywheel-cmux-install.sh` 装 zsh 集成 + symlink + watcher plist，把 tmux session
  **同步成 cmux（macOS Electron）可见 tab**，方便 Annie 在屏幕上看。
- runtime TS 里 cmux 引用（Blueprint / tmux-lookup / event-route / codex-lead-tui）=
  attach/pin 这些 session **可见性**逻辑，执行不依赖 cmux 本身存在。
- **Linux 对策**：provisioner 在 Linux **跳过 cmux phase**；runtime 在无 cmux 时
  headless 跑 tmux（degrade gracefully）。需逐处确认 cmux 调用点在缺失时不致命。

### 2.5 osascript —— ❌ 非 load-bearing（告警便利 + 授权），Linux 降级

- `meta-alert.sh`：macOS 桌面通知（`osascript display notification`）。
- runbook §C：首次 `osascript` 触发 Terminal Automation 授权（人工点 Allow）。
- **Linux 对策**：告警降级到 log + 已有的 Discord 告警通道（lead-alert.sh）；
  Automation 授权步骤 darwin-only。

### 2.6 plutil —— ❌ 非 load-bearing（plist lint），仅 launchd 后端

- 已有 `FLYWHEEL_DAEMON_PLUTIL` seam，缺失即跳过 lint。systemd 后端用 `systemd-analyze
  verify` 或不验。

## 3. 核心/项目分离审计

### 3.1 已分离（数据面 — projects.json，FLY-247/FLY-371）

`packages/teamlead/src/ProjectConfig.ts`：`loadProjects()` 读
`FLYWHEEL_PROJECTS` env 或 `~/.flywheel/projects.json`。`ProjectEntry`:
`projectName/projectRoot/projectRepo?/leads[]/generalChannel?/memoryAllowedUsers?/
linear?`。`LeadConfig`: 富配置 + 严格 schema 校验 + 跨字段不变量。
⇒ **"哪些项目 / 哪些 lead / 哪个 Discord 频道 / 哪个 Linear" 已经是声明式配置**。

### 3.2 还没分离（机器/平台/部署面 — 写死在脚本里）

| 写死的东西 | 位置 | 现状 |
|---|---|---|
| flywheel checkout 路径 | `flywheel-daemon.sh:28`、`flywheel-bridge-wrapper.sh:13`、`restart-services.sh:26`、`fleet-capture.sh:110` | 写死 `${HOME}/Dev/flywheel`；部分脚本（lead-wrapper / xiaohongshu / update-flywheel / self-ship-queue）有 `${FLYWHEEL_DIR:-...}` override —— **不一致** |
| state 目录 | 全脚本 | 隐式 `~/.flywheel`，无统一 `FLYWHEEL_HOME` 外置 |
| skills canonical repo | skills-sync.sh / manifest | 写死 `xrliAnnie/flywheel-skills` |
| deps 工具链 | `fleet-capture.sh` DEPS_JSON | 写死 mac/brew |
| 平台 / supervisor 类型 | 全 launchd 脚本 | 写死 launchd（无平台分支） |

⇒ **FLY-650 的"核心/项目分离"重点 = 把上面这层外置成一份声明式 host/deployment
配置**，让别的机器/别人拿来跑只改配置、不改源码。

## 4. 平台事实（决策依据）

- **WSL2 + systemd**：WSL2 自 2022 支持 systemd（`/etc/wsl.conf` `[boot] systemd=true`）。
  `systemctl --user` 在 WSL2 + 多数 Linux 发行版可用 → systemd --user 是 launchd 的
  自然对应。
- **container 无 systemd**：Docker 镜像默认无 init/systemd；sub #3 会用单一 entrypoint
  + 简单 process supervisor（或 foreground）。⇒ supervisor 接口要让 sub #3 能加
  "foreground/process" 后端，不被 systemd 绑死。
- **包管理**：Linux = apt/dnf/pacman；node/pnpm 常走 nvm/corepack（非系统包）。
- macOS Homebrew 在 `/opt/homebrew`（Apple Silicon）。

## 5. 复用 / 不重造

- secret 红线 + `scan_for_secrets` + dry-run 默认 + idempotent + 双实例守卫 + 事务
  journal —— **全部保留**，跨平台同样适用。
- launchd 机制不删：darwin 后端继续用 `flywheel-daemon.sh`（已有 stub seam）。
- 测试 idiom 照抄：linux 后端的 hermetic 测试 stub `systemctl`（同 FLY-519 stub
  `launchctl`），在非 Linux 机上也能跑全绿。
