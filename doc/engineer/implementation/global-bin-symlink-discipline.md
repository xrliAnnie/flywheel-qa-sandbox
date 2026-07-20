# Global Bin / Symlink Discipline — 全局装订守则(FLY-1389)

**Issue**: FLY-1389
**Date**: 2026-07-20
**Status**: Active(写入时防线已落地;违规由 `check-global-path-hygiene.sh` 机器化检查)

## 背景(为什么有这份守则)

2026-07-20 529 房事故:`~/.flywheel/bin/agent-team-transport` 曾被一个 **worktree 里跑的 Bridge** 改写成指向该 worktree 的 dist;worktree 被清理后链接断掉,新起的 Lead 在 transport preflight 直接 FATAL——而且是**静默**死(没有 alert)。同类违规还包括 `tmux-server-rescue` 断链、matt-skills marketplace 注册指向 worktree 路径。

根因类别:**安装/启动路径用「脚本自身所在目录」推导根路径并写进全局配置**——谁在临时目录跑一次,全局就永久记住临时地址。

Annie 红线:**一开始就不许指错**(写入时拒绝),检测修复只是第二道兜底。

## 守则(hard rules)

1. **全局 bin 链接一律指主仓**。`~/.flywheel/bin` 下的 symlink 目标必须在主 checkout(`.git` 是目录)或 packaged 树内,绝不允许指向 temp(`/tmp`、`/private/tmp`、`/var/folders`、`/private/var/folders` canonical 形态)或 linked worktree(root 的 `.git` 是**文件**)。
2. **任何全局持久化面的 writer 必须过 `scripts/lib/path-hygiene.sh` 判据**(TS 侧镜像:`packages/teamlead/src/bridge/path-hygiene.ts`)。全局持久化面 = `~/.flywheel` 生效态、`~/.claude` settings/plugins、`~/Library/LaunchAgents`。判据是精确形态判定(canonical temp 前缀 + `.git` 文件形态),**不是**命名启发(本仓自己的 worktree 路径就不含 `/worktrees/`)。
3. **本地 directory marketplace 只走 `scripts/register-local-marketplace.sh`**。禁止把调用目录直接交给 `claude plugin marketplace add`——受管入口先把内容拷到稳定位置 `~/.flywheel/marketplaces/<name>`(staged copy + backup/promote/rollback 事务),再注册稳定路径。
4. **`~/.claude/settings.json` 的 hook command 只指稳定副本**(`~/.flywheel/hooks/…`),由 `scripts/install-hooks.sh` 作为 deploy owner 原子部署;不允许 checkout 路径条目与稳定条目并存。

## 现有防线一览

| 层 | 落点 | 行为 |
|----|------|------|
| 写入时防线(主修) | `syncFlywheelCliBin()`(Bridge boot) | 全局 bin + temp/worktree repoRoot → 整批拒写,`errors` + ERROR 日志;逃生口 `FLYWHEEL_SYNC_BIN_ALLOW_TEMP_ROOT=1` |
| 写入时防线 | `converge-flywheel-bin.sh` | 同判据 → 零写入 + ONE alert + `rc=1`;逃生口 `FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT=1` |
| 写入时防线 | `flywheel-cmux-install.sh` / `install-hooks.sh` / `provision-fleet-host.sh` | temp/worktree source → 拒绝 + 非零退出,零全局写入 |
| 断链兜底 | converge 的 symlink health 段(每次 Lead start / daily / pre-kickstart 挂载) | 断链或 temp/worktree target → 本 root 源存在则原子重指 + ONE alert;源缺 → alert only;temp/worktree root 下绝不 repair |
| 机器化验收 | `scripts/check-global-path-hygiene.sh`(只读) | 扫 `~/.flywheel/bin` symlink + `known_marketplaces.json`(`.source.path` 与 `.installLocation` 独立)+ settings.json hook command;违规逐条列出 + `exit 1`;挂载在 converge 末尾(rc OR)与 test-deploy preflight(warn 不阻断) |

## 违规处置流程

1. 跑 `bash scripts/check-global-path-hygiene.sh`(主仓)看违规清单。
2. bin symlink 违规:从**主仓**跑 `bash scripts/converge-flywheel-bin.sh`(symlink health 段自动重指)或手工 `ln -sfn <主仓源> ~/.flywheel/bin/<name>`。
3. marketplace 违规:经受管入口重指——`bash scripts/register-local-marketplace.sh <name> <主仓内容目录>`。
4. settings.json hook 违规:从主仓跑 `bash scripts/install-hooks.sh`(legacy 条目会被替换成稳定路径)。
5. 复跑 hygiene 确认全局 `exit 0`。

## 已知边界

- Bridge 侧 hooks **内容拷贝**(`syncFlywheelHooks`,拷 `inbox-check.sh`)v1 不拦:拷贝无断链形态,且 slot Bridge 已被 `FLYWHEEL_HOOKS_DIR` 隔离。
- `.git`-文件判据对 submodule 也成立;本仓无 submodule 部署形态。误伤时用对应逃生口并回报。
- packaged 树(`.flywheel-prebuilt`)与 fleet 自定义 root 是合法非主仓形态,判据天然放行(拒临时形态,不限定唯一路径)。
