# Research: Auto-Restart Trigger — FLY-20

**Issue**: FLY-20 (follow-up)
**Date**: 2026-03-31
**Source**: `doc/plan/archive/v1.18.0-FLY-20-auto-restart-cd.md`

## 问题

merge PR 后需要自动触发本地 `restart-services.sh`。核心难点：**GitHub 是 remote，Mac 是 local**。需要一个可靠的 remote → local 通知机制。

当前方案及不足：
- **Orchestrator/spin prompt** — 不一定在运行；agent 可能跳过
- **launchd 12h 轮询** — 延迟太高，只能作为兜底
- **Git post-merge hook** — 环境变量不继承、并发问题、只对 `git pull` 触发

## 方案对比

| # | 方案 | 可靠性 | 复杂度 | 安全性 | 延迟 | 维护成本 |
|---|------|--------|--------|--------|------|---------|
| A | **短间隔 launchd 轮询**（3 min） | ★★★★ 高 | ★★★★★ 极低 | ★★★★★ 无暴露 | ≤3 min | 几乎为零 |
| B | **GitHub Actions self-hosted runner** | ★★★★★ 极高 | ★★★ 中 | ★★★★ runner auth | 30-60s | 中（runner daemon） |
| C | ~~**launchd WatchPaths** `.git/refs/heads/main`~~ | — | — | — | — | — |
| D | **GitHub Webhook + 本地 HTTP** | ★★★ 中 | ★★ 高 | ★★ 端口暴露 | 5-10s | 高（tunnel） |
| E | **fswatch 守护进程** | ★★★★ 高 | ★★★ 中 | ★★★★★ 无暴露 | 即时 | 中（进程管理） |
| F | **Git post-merge hook** | ★★ 低 | ★★★★ 低 | ★★★★★ 无暴露 | 即时 | 低 |

### 方案 A: 短间隔 launchd 轮询（推荐）

将现有 `com.flywheel.updater.plist` 从 12h 改为 3 分钟轮询。

**优点**：
- 改动最小（`StartCalendarInterval` → `StartInterval: 180`）
- 覆盖所有场景（orchestrator / 手动 / Lead / 外部 merge）
- `restart-services.sh` 已有幂等保护（deployed-sha check）
- 零额外基础设施
- `git fetch` 开销微乎其微（~0.006 ops/sec，远低于 GitHub 15 ops/sec/repo 限额）

**缺点**：
- 最差延迟 3 分钟（对 CD 流程可接受）
- Mac 睡眠时不执行（但 self-hosted runner 也有同样问题）

### 方案 B: GitHub Actions Self-Hosted Runner

Mac 上注册 self-hosted runner，`on: push: branches: [main]` → `runs-on: self-hosted` → restart。

**优点**：最可靠，30-60s 延迟
**缺点**：常驻 runner daemon、凭证管理、升级维护、排队/掉线恢复。本地 Mac 不是 always-on server，睡眠时 runner 同样无法执行。

**结论**：仅在明确需要 <30s push-driven 低延迟时值得。当前不需要。

### ~~方案 C: launchd WatchPaths~~（Codex 反驳后放弃）

~~监听 `.git/refs/heads/main` 文件变化~~

**放弃原因**（Codex 指出）：
1. `.git/refs/heads/main` **不是稳定 API**。`git pack-refs --all` 会把 loose ref 打包到 `packed-refs`，loose ref 文件可能消失。Git 文档明确说这只是"当前存储实现"，不是契约。
2. **同一 plist 只有一套 ProgramArguments**。不能按触发源（poll vs WatchPaths）分流到不同脚本。要么用同一个入口（WatchPaths 基本失去意义），要么拆两个 plist（增加并发面）。
3. **制造多余触发**。poll 路径已经 fetch+pull+restart，WatchPaths 只会在 pull 更新 ref 后再触发一次冗余 restart。
4. **不解决核心问题**。WatchPaths 不触发 `git pull`，只响应本地 ref 变化。核心问题是"谁做 pull"，不是"pull 后谁 restart"。

### 方案 D/E/F: 不推荐

- **D (Webhook + tunnel)**: 端口暴露、tunnel 断线、认证维护、过度复杂
- **E (fswatch)**: 与 launchd WatchPaths 功能重叠但更复杂，需要额外进程管理
- **F (Git hook)**: 环境变量不继承、不覆盖 `gh pr merge`、`.git/hooks/` 不受版本控制

## Codex 讨论关键发现

### 锁竞态问题

Codex 指出当前 `update-flywheel.sh` 存在竞态：

```
update-flywheel.sh:  fetch → pull  (无锁)
                          ↓
restart-services.sh: ... → line 171 才加锁
```

如果两个 trigger 同时运行，第一个在 idle wait 持锁时，第二个可以先 `git pull` 更新 checkout，然后进 restart-services.sh 被锁拒。但第一个 restart 的 `CURRENT_HEAD` 变量已过时，build 的却是更新的代码，最后可能把错误 SHA 写入 `deployed-sha`。

**修复**：锁应前移到 `update-flywheel.sh` 最外层，确保 fetch → pull → restart 整体是一个临界区。

### 显式调用 vs 隐式监听

Codex 建议：
- Orchestrator/spin 在自己 pull 之后显式调用 `restart-services.sh`（已有）
- 手工运维统一走 `update-flywheel.sh`
- 不要用隐式文件监听替代显式调用

## 推荐方案

### 唯一推荐：方案 A（短间隔轮询 + 锁前移）

```
┌──────────────────────────────────┐
│  launchd plist                   │
│  StartInterval: 180 (3 min)      │
│       ↓                          │
│  update-flywheel.sh              │
│    ┌─ 全局锁（最外层）───────┐   │
│    │  git fetch              │   │
│    │  git pull (if needed)   │   │
│    │  restart-services.sh    │   │
│    └─────────────────────────┘   │
└──────────────────────────────────┘
```

**补充路径**（belt-and-suspenders）：
- Orchestrator/spin: pull 后直接调 `restart-services.sh`（现有）
- 手动: `bash scripts/update-flywheel.sh`

### 实现计划

**Step 1**: 更新 `com.flywheel.updater.plist`
```xml
<!-- 替换 StartCalendarInterval 为 StartInterval -->
<key>StartInterval</key>
<integer>180</integer>
```

**Step 2**: 锁前移到 `update-flywheel.sh`
- 在 fetch 之前加 `mkdir` 锁
- 整个 fetch+pull+restart 在锁内
- trap cleanup 释放锁

**Step 3**: 测试验证
- 手动 `bash scripts/update-flywheel.sh` — 正常执行
- 并发两个 `update-flywheel.sh` — 第二个被锁拒
- 等 3 分钟 — launchd 自动触发

## 参考来源

- [GitHub Actions Self-Hosted Runners](https://docs.github.com/actions/hosting-your-own-runners)
- [launchd.plist man page](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [Git pack-refs](https://git-scm.com/docs/git-pack-refs)
- [Git Hooks](https://git-scm.com/docs/githooks)
- [GitHub Repository Limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- Codex design discussion (2026-03-31) — challenged WatchPaths approach, identified lock race condition
