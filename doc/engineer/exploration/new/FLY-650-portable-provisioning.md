# Exploration: 可移植 provisioning — Linux 兼容 + 核心/项目分离 — FLY-650

**Issue**: FLY-650 (可移植 provisioning：Linux-兼容 + 核心/项目分离，扩展已 Done 的 FLY-519)
**Date**: 2026-06-28
**Status**: Draft
**EPIC**: FLY-648 (Flywheel 可移植 + 可部署产品)
**起点**: FLY-519 (fleet provisioning toolchain, Done, PR #336)

---

## Problem

FLY-519 已经能把一台**干净 macOS (Apple Silicon)** provision 成 Flywheel fleet
主机：capture 活机拓扑 → 脱敏 artifact → 在新机 materialize（装 deps、拉 repo、
bootstrap `~/.flywheel/`、token 占位+校验、部署 launchd、skills-sync、端到端校验）。
全套 hermetic-bash 测试、dry-run 默认、idempotent。

但它有两条硬假设，挡住了 EPIC FLY-648 的三个目标（老公 Windows / 云端 / 产品化）：

1. **只跑 macOS**。supervisor = launchd、包管理 = Homebrew、窗口 = cmux、告警/授权
   = osascript。一台 Linux / WSL2 机器跑不起来。
2. **核心与"我的项目"半缠在一起**。lead 名册（projects.json）虽然已经是配置驱动
   （FLY-247/FLY-371），但**机器/平台/路径**这一层（flywheel checkout 路径、
   `~/.flywheel` state 目录、skills canonical repo、deps 工具链）硬编进脚本，写死成
   "Annie 这台 Mac 的样子"。别人/别的机器拿来跑要改源码。

## Goal

把 FLY-519 升级成**可移植 + 核心/项目边界清晰**的 provisioning：

- **Linux-兼容**：同一套 provisioning 能在 Linux / WSL2 上跑，不只 Mac。抽象掉
  macOS 专属（launchd → 可移植 supervisor seam；cmux/osascript → 降级为可选；
  Homebrew → 平台化包安装；路径·配置外置）。
- **核心 / 项目分离**：把 "Flywheel 核心"（Bridge + lead/runner 运行时 + skills +
  Discord/Linear 控制层 + provisioning 工具链本身）和 "项目配置"（哪些 repo / 哪个
  Linear project / 哪些 Discord 频道 / 要哪些 lead / 装在哪 / 跑什么平台）拆成
  **声明式配置 + 平台无关的核心**。

## 为什么这块是共同地基（EPIC 关键洞见）

| 下游 sub | 怎么 100% 复用本 issue |
|---|---|
| **sub #1 Windows (WSL2)** | 直接在 WSL2 里跑这份 Linux provisioning，最轻的桥。 |
| **sub #3 容器化** | Dockerfile = 把这份 Linux provisioning 步骤塞进镜像；supervisor seam 留 container 后端。 |
| **sub #4 配置驱动项目** | 直接建在本 issue 切出的"项目配置 = 叠在核心上的 config"边界上。 |

一份投资、三个回报。WSL2 不是 throwaway。

## 现状审计（要点；详见 research 文档）

### macOS 耦合面（按 load-bearing 程度分）

| 专属物 | 是否 load-bearing | Linux 对策 |
|---|---|---|
| **launchd**（`flywheel-daemon.sh` generate_plist/bootstrap、`restart-services.sh`、各 plist、validate 的 `launchctl print`） | **是**（常驻 Bridge+Leads 的 supervisor） | **supervisor seam**：darwin→launchd / linux→systemd --user；留 container 后端口子 |
| **Homebrew**（manifest `deps[]` 写死 brew formula、deps phase `brew install`） | 是（装工具链） | 平台化 deps：brew(darwin) / apt·dnf(linux) |
| **tmux** | **是**（Lead/Runner 执行底座，各 *TmuxAdapter） | 已跨平台，无需改 |
| **cmux**（`flywheel-cmux-install.sh` + watcher plist；把 tmux session 同步成可见 tab） | **否**（macOS 窗口可视化便利） | Linux/headless **跳过**；tmux 直接 headless 跑 |
| **osascript**（`meta-alert.sh` 桌面通知；Automation 授权） | 否（告警便利） | Linux 降级到 log / Discord 告警 |
| **plutil**（plist lint） | 否（已有 `FLYWHEEL_DAEMON_PLUTIL` stub seam，缺失即跳过） | 仅 launchd 后端用 |

### 核心/项目分离 — 已分离 vs 还没分离

- ✅ **已分离（数据面）**：`~/.flywheel/projects.json`（FLY-247）= lead 名册的配置
  SSOT。每个项目 `projectName/projectRoot/projectRepo/leads[]/generalChannel/linear
  binding/memoryAllowedUsers`；lead 富配置（agentId/chatChannel/match.labels/
  botTokenEnv/model/backend/codexProfile/...）。Discord 频道 + Linear + 要哪些 lead
  = 全在配置里。
- ❌ **还没分离（机器/平台/部署面）**：脚本写死
  - flywheel checkout 路径 `~/Dev/flywheel`（`flywheel-daemon.sh`、
    `flywheel-bridge-wrapper.sh`、`restart-services.sh`、`fleet-capture.sh` 都写死，
    部分脚本有 `${FLYWHEEL_DIR:-...}` override，**不一致**）。
  - `~/.flywheel` state 目录 = 处处隐式假设，无统一 `FLYWHEEL_HOME`/state 外置。
  - skills canonical repo = 写死 `xrliAnnie/flywheel-skills`。
  - 工具链 deps = mac/brew 写死。
  - 平台/supervisor 类型 = 写死 launchd。

**结论**："核心/项目分离" 对 FLY-650 = 主要补**机器/平台/部署配置的外置**（数据面
projects.json 已经 OK），把这一层从写死 Annie 机器，变成一份声明式 **host /
deployment 配置**。

## 非目标（本 issue 不做，留下游）

- WSL2 实际 bring-up / Windows 体验（→ sub #1 FLY-651?）。
- 真的把步骤塞进 Dockerfile / container 后端实现（→ sub #3）。
- 多租户 / onboarding / 给别人用的产品文档（→ sub #6）。
- 云端 per-project container（→ sub #5）。
- **在本机/真 Linux 机上实际执行 provision**：本机没有 Linux box；沿用 FLY-519 纪律
  = **只写脚本 + hermetic 测试（同时模拟 darwin/linux，stub systemctl 同 FLY-519
  stub launchctl）**，不真跑。真机验证 = sub #1 的 WSL2 bring-up。

## 开放的架构决策（→ brainstorm gate / plan 详述）

1. **D1 — Linux supervisor 选型**：systemd `--user` units（launchd 的天然对应、WSL2
   支持、per-user 常驻）vs 直接做一个**无依赖 process supervisor**（也能进 container，
   一个后端覆盖 Linux+容器）。container（sub #3）通常**没有 systemd**。
2. **D2 — 核心/项目边界的落地机制**：在已有 `fleet/manifest.json` 加一个
   `host`/`deployment` 块（少文件、贴合 FLY-519 capture 模型）vs 新开一份独立
   "deployment config" 文件（边界更显式）。
3. **D3 — scope / 测试纪律**：确认 = 写可移植脚本 + 双平台 hermetic 测试、**不**真跑
   Linux box；cmux/osascript 变 darwin-only 可选（Linux Lead headless）。

> 方向 = founder-facing 架构决策。按 Lead 指令：本 issue **plan-first** —— 出
> exploration + design + plan，present Tadashi review、等 Annie brainstorm 定方向，
> **不进 implement、不开 PR**。
>
> **✅ 方向已定（Annie 2026-06-28）**：**D1=A**（systemd --user，容器后端→FLY-652）·
> **D2=B**（核心/项目物理分开两份配置 + 为产品化 UX 层留地基）· **D3=B**（真跑通：
> Annie 真 Linux+Windows 机器跑验，我交脚本+runbook、够不到她机器=同搬机模型）。
> follow-up（独立 issue）：per-machine lead 启用接口在 plan 预留、本 issue 不实现。
> 详见 plan v1.58.0。
