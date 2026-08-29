# Exploration: Fleet Provisioning 脚本 — FLY-519

**Issue**: FLY-519 ([infra] fleet provisioning 脚本 — 自动化机器 setup)
**Date**: 2026-06-23
**Status**: Complete
**关联**: FLY-517 (16GB near-OOM → 扩容/多机), interim MBP 迁移, 9 月 Studio provision

---

## Problem

fleet 搬新机当前是一次**手搬迁移**：13 个 lead launchd plists + Bridge + Discord bots +
repos + token + skills-sync + `.flywheel` config/manifests，全套靠人肉。Cass (CoS) 在
2026-06-23 machine-scaling 讨论里提醒：interim 新机 (MBP 16" M5 Max 48GB) 即将到货，
**到货当天现写 provisioning 脚本会拖长迁移窗口**。决定先做成**可复用 provisioning 脚本 + runbook**。

复用半径：interim MBP 迁移 (近期) + 9 月 Studio provision + FLY-517 多机编排每个新节点。

## Goal

一个**可复用、idempotent** 的 provisioning 工具链 + runbook，把一台干净 macOS
(Apple Silicon) provision 成 Flywheel fleet 主机：装 deps → 拉 repos → bootstrap
`~/.flywheel/` → token 占位 + 校验 → 部署 launchd plists → skills-sync wiring →
端到端校验 (Bridge up / leads / health / dispatcher)。

## 关键约束 (Annie / Tadashi 拍)

1. 🔴 **密钥红线**：脚本**只占位 + 校验非空、绝不碰真值**。密钥 Annie 经手。capture
   产物 (commit 进 git) 必须**零 secret** —— `.env` 值 / `*.db` / auth token /
   codex-homes 全剥，只留**结构 + key 名清单**。**额外加一个 secret-scan 校验/测试**：
   capture 产物 grep 不到任何 token/secret pattern (防泄密进 git)。
2. **不在本机现跑 provision/launchd** —— v1 只**写脚本 + hermetic 测试** (同 FLY-516)。
   provision 脚本默认 dry-run，须显式 `--apply`，且检测到本机已有 live fleet 时拒绝执行。
3. **idempotent** —— 重跑收敛、已存在不破坏。
4. **NO-CODEX** (Annie 指令)：Codex design/code review 跳过，由 Tadashi 直接 over-read。

## 决策 (brainstorm gate 已确认 D1/D2/D3)

### D1 — v1 scope = 单主机全量 provision
v1 只做**单台主机** (跑 Bridge + 全部 leads) 的全量 provision，服务 interim MBP 迁移。
**多机 host/node 拆分**（compute-only worker 节点、跨机编排）留 **FLY-517**。不 over-scope。

### D2 — fleet 真相来源 = capture + provision hybrid
- **capture 模式**：在**当前活机**上把 `~/.flywheel/` 拓扑**脱敏快照**成 repo 内
  committed artifact (`fleet/`)：保留 `projects.json` 结构 + 生成 `.env` key 清单 +
  记录 repo 远端 URL + launchd 任务清单 + skills-sync wiring，**剥掉所有 secret/db/auth**。
- **provision 模式**：在**新机**上从 committed artifact materialize。
- 好处：自动快照当前 13-lead fleet，**不用手抄**，且产物是可复现的真相来源。

### D3 — 迁移边界 = v1 只立基础设施
v1 自动化只到「**基础设施 + token 占位 + 校验**」。**状态迁移** (memory DB / thread-id
延续 / 真 token / codex-homes auth) = **Annie 经手 + runbook 手动 restore 清单**，
不进自动脚本 (守密钥红线 + 状态延续要人确认)。runbook 把「Annie 到货后手动做的几步」列清楚。

## 非目标 (v1 不做)

- 多机 / compute-node 编排 (→ FLY-517)
- 自动创建 Discord bots / Linear teams (账号操作 Annie 经手；runbook 列步骤)
- 自动迁移 memory DB / thread 延续 / 真 token (→ runbook 手动清单)
- 在本机实际执行 provision (只写 + 测)
- Linux / Intel mac 支持 (目标机=Apple Silicon)

## 形态

参照已有的 `setup-new-project.sh` / `flywheel-daemon.sh` / `flywheel-fleet.sh`：
**orchestrator 脚本按 phase 编排已有脚本 + 只补干净机器缺口**。绝大部分 per-lead/bridge
launchd 机制已存在，FLY-519 = 胶水 + capture/provision + 校验 + runbook。详见 research 文档。
