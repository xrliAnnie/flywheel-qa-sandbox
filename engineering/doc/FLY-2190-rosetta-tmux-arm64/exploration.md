# FLY-2190 Rosetta 退场前把载体换成原生 — 探索

Issue: FLY-2190 (https://linear.app/geoforge3d/issue/FLY-2190/全舰-16-个-lead-的载体是-x86-64-only-的-tmux跑在-rosetta-上-rosetta-退场那天载体直接起不来)
日期: 2026-08-30
基于: 无（本 issue 首份文档；重度复用 FLY-1944 已 ship 的 W2 工装）

> ## ⚠️ 更正横幅（2026-08-30，设计评审 R1/R2 之后追加）
>
> **本文 §6「安全序」与 §0 中「② 可滚动、每次只断一个」的结论已被撤回。** 以 `plan.md` §0.1 与 §3 为准。
>
> 撤回原因（评审查出、本 runner 复核属实）：
> 1. 滚动变体缺三样未设计的东西 —— 事务保证、非 Lead server 的处置、混合态下可执行的回滚。§6 把它写成了可照做的顺序，实际上不是。
> 2. §3 的单向兼容只测了**握手与 `list-sessions`**，不足以支撑「零中断 / 工作正常」。生产命令面（attach、control mode、send-keys、hook、kill 族）未验证。
> 3. §5「S1 …无破坏性」低估了风险面：改 PATH 顺序会切换 372 个解析到不同路径的条目，不止 `python3`/`tmux`（含 `ffmpeg`/`ffplay`/`gh`/`npm`/`openssl`）。
>
> **仍然成立的**：§1（FLY-1944 W2 工装已 ship 未执行）、§2（Rosetta 机制三段实证）、§3 表格里那两行原始实测读数、§4（仓库 PATH 顺序自相矛盾）。
> 读本文时请勿据 §6 恢复出任何执行方案。

## 0. 一句话

founder 判断的两半（① PATH 顺序 ② tmux 换原生）都成立，但本轮实测推翻了「它们相互独立」这个前提：**tmux 的 client/server 协议是单向兼容的（就实测的那条 `list-sessions` 而言，新 client 能驱动旧 server；旧 client 连不上新 server）**，所以 ① 不是「只解 hook 那一半」，而是 ② 的**强制安全前置**。

⚠️ **本段原有的后半句已撤回**：曾写「做对了顺序，② 就从『17 个 server 全断的择时窗口』降级成可逐个 Lead 滚动、每次只断一个的操作」。评审证明滚动变体缺事务保证、非 Lead server 处置、混合态回滚等共 7 项（plan 的 P1–P7），**本单不主张任何滚动方案**。以 plan §3 为准。

## 1. 最重要的发现：这件事 80% 已经做过了（FLY-1944 W2）

本单不是从零开始。FLY-1944「宿主终端链收口」在 2026-08-21/22 已经 ship 了完整工装，它的 exploration 里 **B2 行**就是本单：

| 条款 | 现状（FLY-1944 exploration.md 原文） |
|---|---|
| B2 | W2 tmux 3.7c 运维窗口(founder-gated) — **工装齐,窗口未执行**。`host-terminal-cutover.sh` 9 步 runbook + 预算闸 + quiescence + 回滚闭包全部 ship;mutation 全部 operator 手打 |

真机复核（2026-08-30，本 runner 实测）确认它确实停在「装好了，没执行」：

| 事实 | 实测值 | 判读 |
|---|---|---|
| `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux` | 存在，`Mach-O arm64`，`tmux 3.7c`（Aug 20 07:54） | **原生 tmux 早就装好了** |
| `/opt/homebrew/bin/tmux` | **不存在** | 没有 `brew link` — 这就是 founder 看到「/opt/homebrew 没有安装 tmux」的原因 |
| `/usr/local/bin/tmux` | → `Cellar/tmux/3.5a`，`Mach-O x86_64` | 在用的是它 |
| `~/.flywheel/state/host-terminal-cutover.json` | **不存在** | cutover 事务从未启动 |
| `~/.flywheel/backup/tmux-3.5a-closure` | **不存在** | 回滚闭包未构建 |
| 活着的 tmux server | 20/20 全部 = `/usr/local/Cellar/tmux/3.5a/bin/tmux` | 全舰仍在 Intel 二进制上 |

已 ship 且可直接复用的资产（都在 main 上）：

- `scripts/host-terminal-cutover.sh`（551 行）— 9 步事务：`preflight-receipt` / `build-closure` / `rehearse-rollback` / `pause-admission` / `quiescence` / `run-step` / `verify-receipt` / `resume-admission`。带单调时钟预算闸、rollback 预算 900s、Bridge 准入暂停、三证 server census（ps 身份 + lsof socket 归属 + `file` 架构）。
- `scripts/qa-tmux-3.7c-compat.sh` — 3.7c 兼容性 QA 脚本。
- `packages/claude-runner/test/tmux-3.7c-exact.gate.ts` — 精确版本门（缺 `FLYWHEEL_TMUX_3_7C_BIN` 直接 throw，不允许 skip）。
- `scripts/hooks/flywheel-restart-guard.py` — 已硬拦 Runner 里的 brew 变更命令（含 `arch -x86_64 brew install tmux` 这类 wrapper 绕过）。

**设计红线：本单不重造 W2。** 本单的价值在于补上 FLY-1944 没做的三件事（见 §5）。

## 2. 机制：为什么整条链都在翻译层，而 node 逃掉了

founder 的观察（`sysctl.proc_translated=1`、node 是原生）都对，但根因不是「PATH 里 python 排错了」这一条。本轮实测拿到了完整机制。

### 2.1 CPU 偏好是**继承**的，不是每个二进制各自决定

| 实验 | 命令 | `proc_translated` |
|---|---|---|
| E1 | 当前 shell 直接 spawn `/bin/zsh` | **1** |
| E2 | `arch -arm64 /bin/zsh` | **0** |
| E3 | `arch -arm64 zsh` 里再 spawn 一层 `zsh` | **0**（可传递） |

`/bin/zsh` 是 universal binary（同时含 x86_64 和 arm64 两个 slice）。它跑哪个 slice **不由它自己决定，由父进程传下来的 CPU 偏好决定**。x86_64 的 tmux server fork 出的 shell 因此被钉在 x86 slice 上，整条子进程链跟着进翻译层。

`node` 之所以逃掉：`/opt/homebrew/bin/node` 是 **arm64-only** 二进制，没有 x86 slice 可选，macOS 只能原生跑它。这解释了 founder 说的「最贵的那部分没被翻译」。

### 2.2 换 arm64 tmux 确实根治 —— 但父进程链的偏好必须一起干净

| 实验 | 做法 | server 子进程 `proc_translated` |
|---|---|---|
| B | 从**当前 x86 shell** 起 arm64 tmux 3.7c | **1** ← 意外 |
| D | `arch -arm64` 重置偏好后起同一个 arm64 tmux | **0** ✅ |
| C | 从当前 shell 起 x86 tmux 3.5a（对照） | 1 |

B 的意外结果是本轮最容易被误判的地方：**光把二进制换成 arm64 还不够**，如果启动它的父进程带着 x86 偏好，这个偏好会继续传给它的子进程。

生产环境幸运地不受这个影响 —— 实测 Lead 的 tmux server `PPID = 1`（launchd），`~/Library/LaunchAgents/com.flywheel.lead.*.plist` 全部**没有设 PATH，也没有 arch 偏好**，launchd 自身是原生的。所以换掉二进制 + 重启 job，链路就是干净的。**但这一条必须在 cutover 后用 `proc_translated` 实测验证，不能推断。**

### 2.3 PATH 那一半是真正独立的 —— 有实测证据

| 实验 | 命令 | 结果 |
|---|---|---|
| F1 | 当前 shell | `/usr/local/bin/python3` → **x86_64** |
| F2 | `arch -arm64 zsh -lc` （完全原生的 shell） | `/usr/local/bin/python3` → **仍然 x86_64** |

即使 shell 完全脱离翻译层，`python3` 仍然先命中 Intel Homebrew 那个 —— 它是 x86_64-only 二进制，于是那个 python 进程自己又进了翻译层。**founder 说的「两半」在这个方向上成立：换 tmux 不会顺带解决 python。**

### 2.4 PATH 根因：`brew shellenv` 现在会重排 PATH

用户的 `~/.zshenv:2` 和 `~/.zshrc:2` 都写着 `eval "$(/opt/homebrew/bin/brew shellenv)"`，注释也写着「arm64 Homebrew」。但现代 `brew shellenv` **不再前置** `/opt/homebrew/bin`，它发出的是：

```sh
eval "$(/usr/bin/env PATH_HELPER_ROOT="/opt/homebrew" /usr/libexec/path_helper -s)"
```

`path_helper` 按 `/etc/paths` 重建 PATH，而 `/etc/paths` 第一行就是 `/usr/local/bin`；Homebrew 的目录被**追加到尾部**。实测干净登录 shell 里 `/usr/local/bin` 在位置 2、`/opt/homebrew/bin` 在位置 16，中间还隔着 `/usr/bin`。

**结论：用户的 shell rc 文件无论怎么写都改不动这个顺序**，这不是配置写错，是 Homebrew 行为变更。

## 3. 决定性实测：tmux 协议**单向兼容**

这是本单最重要的技术发现，也是唯一能定死实施顺序的证据。隔离 socket 实测（不碰生产）：

| 方向 | 结果 | server 是否受损 |
|---|---|---|
| **3.7c client → 3.5a server** | ✅ `rc=0`，`list-sessions` 正常返回 | 存活 |
| **3.5a client → 3.7c server** | ❌ `rc=1`，`server exited unexpectedly` | **存活**（fail-closed，只是 client 自己失败） |

两个推论：

1. **新 client 向下兼容旧 server** ⇒ 就被测的那条 `list-sessions` 而言，新 client 能驱动存量 3.5a server。
   ⚠️ **本条的两个推论已撤回（评审 R4/R5）**：不能据此说「先升级 client 侧（PATH / link）是安全的」，也不能说旧 server 会被「正常驱动」。只验了握手与 `list-sessions`；attach / control mode / send-keys / hook / kill 族未验（plan 的 P4）。且 `brew link` 是**执行期生产变更**，见 plan §0.0.1 的 ⛔ DO NOT LINK。
2. **旧 client 连不上新 server** ⇒ 如果先让某个 server 变成 3.7c 而 PATH 里的 client 还是 3.5a，所有对它的裸 `tmux` 调用会**静默返回 rc=1**。

第 2 条的实际受害面（来自审计，非推断）：

- **`tmux.conf` 里的自清理 hook**：生产 conf 第 3 行是 `set-hook -g pane-exited 'run-shell "... tmux -S <sock> kill-server ..."'` —— 裸 `tmux`，走 PATH。它断掉意味着 Lead 退出时 server 不自杀，变孤儿。
- **50+ 个裸 `tmux` 调用点**，分散在 `claude-runner` / `teamlead` / `edge-worker` / `flywheel-comm` / `core` 五个包，外加 `flywheel-cmux-sync.sh` 的大量 shell 调用。没有集中的二进制解析层（`terminal-mcp/src/tmux-exec.ts` 的契约测试只覆盖那一个包，且只管环境变量清洗，不管二进制选择）。
- **`scripts/flywheel-lead-attach.sh:38`** 是最短的漂移路径：唯一既无 env seam 又无 PATH pin 的 attach 客户端，由 cmux GUI 启动，PATH 来源与 launchd 起的 server 完全不同。

> **一处对既有判断的纠正（措辞已按评审 R4 收窄）**：仓库审计推断「一旦 `brew link` 3.7c 就会 protocol version mismatch」。实测表明这个方向（新 client → 旧 server）**在被测的那一条 `list-sessions` 调用上没有出现协议不匹配**，rc=0。会失败的是相反方向。
>
> ⚠️ **但不能据此说「link 本身是安全动作」** —— 那句话曾经写在这里，现已撤回。理由有二：(1) 实测只覆盖握手与 `list-sessions`，生产命令面（attach、control mode、send-keys、hook、kill 族）**未验证**，即 plan 的 P4 门；(2) `brew link` 会**立即**改变所有已是原生优先的 carrier 所选中的 client，因此它是**执行期的生产变更**，不是准备动作。以 plan §0.0.1 的 **⛔ DO NOT LINK** 为准。

## 4. 仓库现状：PATH 顺序已经自相矛盾

审计查出 PATH 硬编码点分成方向相反的两组，且**没有任何测试或文档声明哪个是对的**：

**A 组 — Intel 优先（`/usr/local/bin:/opt/homebrew/bin`）**

| 位置 | 影响面 |
|---|---|
| `packages/claude-runner/src/tmux-server-environment.ts:21` | **tmux server 出生环境的权威 PATH** — 每个 Lead / runner 及其全部子进程继承 |
| `scripts/flywheel-lead-wrapper-v2.sh:82` | 16 个 Lead 的载体；`:362` 把这份 PATH 原样注入 server env |
| `scripts/flywheel-bridge-wrapper.sh:54` | Bridge（`restart-storm-gate.py` 在此运行） |
| `scripts/restart-services.sh:33`、`flywheel-voice-bridge-wrapper.sh:45`、`flywheel-quota-monitor-wrapper.sh:35` | 其余 daemon |
| `packages/teamlead/scripts/templates/flywheel-codex-lead-wrapper-mufasa-tui.sh:37` | Codex Lead TUI |
| `scripts/launchd/com.flywheel.updater.plist:18` | 独立更新器 |

**B 组 — 原生优先（`/opt/homebrew/bin:/usr/local/bin`）**

`scripts/flywheel-cmux-autostart.sh:27`、`scripts/meeting-notes-tick.sh:12`、`scripts/xiaohongshu-learning-tick.sh:19`，另有 5 个 launchd plist（voucher-watch、daily-digest、token-usage-daily、codex-log-guard、bridge-liveness-probe）也是原生优先。

后果是同一台机器上 **python3 解析成两个不同架构**：Bridge / Lead / hook 拿 x86_64 3.14.6，cmux watcher / tick 脚本 / voucher matcher 拿 arm64 3.14.5。

`flywheel-cmux-autostart.sh:24-25` 的注释还把当前状态写成了事实假设：「the watcher shells out to `cmux` (/opt/homebrew/bin) and `tmux` (/usr/local/bin)」，并自称「Mirrors the Lead launch wrapper」—— 实际顺序是反的。`scripts/test-cmux-sync.sh:3746` 还断言了这个顺序，改动要同步。

**关键有利条件**：`flywheel-lead-wrapper-v2.sh:281-284` 明确设计成「Lead boot 不依赖用户 login shell 或 rc 文件」（`set -g default-shell /bin/bash`，走 `env -i` 载体）。所以 **Lead 侧的 PATH 完全由仓库代码控制**，修 ① 是一个纯代码改动，不需要碰 `/etc/paths` 或用户的 shell rc。

## 5. 本单该做的三件事（FLY-1944 没做的）

### S1 — 把 PATH 顺序在仓库里统一成原生优先（代码改动，无破坏性）

A 组 8 处改成 `/opt/homebrew/bin:/usr/local/bin`，与已有的 B 组对齐。副作用是 tmux client 侧同时升到 3.7c（**前提是 §6 的 link 已做**），而这恰好是 §3 要求的安全前置。

需同步的测试：`scripts/test-cmux-sync.sh:3746`、`packages/claude-runner/test/runner-env-isolation.real-tmux.test.ts:120,131`（pin 了 canonicalPath）。

### S2 — 加一条 provisioning 守卫（founder 明确点名要的）

founder 原话：「保留一条检查：将来 provisioning 新机器时，PATH 里原生 Homebrew 必须排在 Intel 之前」。这在 FLY-1944 里**完全没有**。做成仓库内的自动化断言（对 A/B 两组 PATH 声明统一断言原生优先），而不是一份人读的 checklist —— checklist 不会在 provisioning 时自己跑。

### S3 — 执行 W2 窗口（破坏性，founder 择时）

复用 `host-terminal-cutover.sh`，不重写。本单的增量是给它一个**基于 §3 实测的安全序**，并论证它可以滚动做。

## 6. 安全序（本单的核心产出）

实测的单向兼容性给出唯一安全的顺序，且每一步都可独立回滚：

```
第 0 步  brew link arm64 tmux（/opt/homebrew/bin/tmux 出现）
         → B 组 client 升 3.7c，驱动存量 3.5a server = rc=0 ✅ 零中断

第 1 步  S1 代码改序合入 + 部署
         → A 组 client 也升 3.7c；server 进程仍是旧的 3.5a，继续被新 client 正常驱动 ✅
         → 同时 python3 转原生（解掉 hook 那一半）

第 2 步  逐个 Lead 重启（可分批，每次只断一个）
         → 该 Lead 的 server 变 3.7c；此时全机 client 已是 3.7c ✅
         → 每重启一个就用 proc_translated 验一个

❌ 危险序：先重启 Lead 让 server 变 3.7c、但 PATH 未改
         → 全机 3.5a client 对它的裸 tmux 调用静默 rc=1（含自清理 hook）
```

**这把 founder 认为的「17 个 server 全断的破坏性窗口」降级成了可滚动、可中途停下的操作。** 但第 2 步仍然是破坏性的（每个 Lead 重启会丢当前 pane 上下文），仍需 founder 择时授权 —— 只是不再需要「一次全断」。

## 7. 待确认的前置门与开放问题

1. **FLY-1944 阶段 2 门是否已绿。** FLY-1944 plan.md:143 明写「**绿才授权 W2 运维窗口;不绿即停**排查,不拿 founder-gated 全 server 重启当实验」。其 `progress.md` 停在 `implement 13/14`（2026-08-22），但两轮 PR（#912、#923）都已合入。本单**不重开 FLY-1944 的验收**，但必须把这个门作为 S3 的显式前置列出并给出重核命令。→ 已就此向 Lead 提问。
2. **验收标准需要补一条。** founder 给的「在 Lead 的 shell 里 `sysctl.proc_translated` 读到 0」只验 shell 自己。实测 F2 证明：一个完全原生的 shell 里 exec 一个 x86_64-only 的 `python3`，那个 python 进程照样 `proc_translated=1`。验收必须**同时**覆盖 shell 与 hook 实际解析到的解释器。
3. **`flywheel-restart-guard.py` 会拦 cutover 自己的 brew 命令**（FLY-1944 立的护栏，设计如此）。它只作用于 Claude Code 的 Bash 工具，founder 在自己终端手打不受影响；但如果 S3 由 runner 执行，需要显式处置这条护栏，不能绕过。
4. **本单不声称任何性能收益** —— 继承 founder 的边界，理由只有「到期」这一条。

## 8. 明确不做

- 不重写 `host-terminal-cutover.sh`，不造第二套 cutover。
- 不在本单执行 W2 窗口（破坏性，founder 择时）。
- 不动 `/etc/paths`、不改用户 shell rc、不碰 Homebrew 全局配置（宿主级改动超出本单授权，且 `restart-guard` 已把这类命令列为硬拦对象）。
- 不收敛那 50+ 个裸 `tmux` 调用点到统一解析层 —— 那是独立的大重构，本单只需保证 PATH 解析出的 client 版本正确。
