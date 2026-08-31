# FLY-2190 Rosetta 退场前把载体换成原生 — 调研

Issue: FLY-2190 (https://linear.app/geoforge3d/issue/FLY-2190/全舰-16-个-lead-的载体是-x86-64-only-的-tmux跑在-rosetta-上-rosetta-退场那天载体直接起不来)
日期: 2026-08-30
基于: exploration.md

> ## ⚠️ 更正横幅（2026-08-30，设计评审 R1/R2 之后追加）
>
> **本文 §4.1 的「安全序」表、以及 §4.1 末尾「可逐个 Lead 滚动做、每次只断一个」的推论已被撤回。** 以 `plan.md` §0.1、§3.1（精确到版本对的不变量）与 §3.2（P1–P7 待解决问题）为准。
>
> 逐条撤回理由：
> 1. **§2 的实测强度被我用过头了。** 表里的两行读数本身没错，但它们只覆盖**握手与 `list-sessions`**。据此写「✅ 工作正常 / 零中断」超出证据；attach、control mode、`new-window`、`send-keys`、hook 管理、kill 族**均未验证**。正确表述见 plan §3.1。
> 2. **§4.1 的滚动序不是可执行方案。** 它没有接上 `host-terminal-cutover.sh` 的准入暂停 / 静止证明 / 预算闸 / 收据机制，也没处理非 Lead 的 tmux server（实测机上活 server 数远多于 Lead 数），且混合态下的回滚方向是错的（必须先清掉所有 3.7c server 才能把 client 降回 3.5a）。
> 3. **§4.3「S1 的风险已实测清空」不成立。** 我当时只按自己列的白名单查了几个命令。正确的方法是从被改的 carrier 反查子进程实际调用的裸命令。完整 sweep 已跑完，查出 8 个仓库代码自己拥有的命令名：`python3`、`npx`、`gh`、`ffmpeg`、`ffplay`、`npm`、`openssl`、`brew`（其中 `ffmpeg` 被 voice-bridge 启动前置探测）。**`ffprobe` 零消费者**，不在其中。见 plan §1.5。
> 4. **§4.1 表内「client 版本 >= server 版本」是过度泛化。** 实测只覆盖 3.5a/3.7c 这一对具体版本的一个命令，不构成语义化版本律。
> 5. **§6 关于 provisioning 挂载点的结论有一处事实错误**：`package-onboard.sh:100` 只是把脚本**打进 payload**，并不在 provisioning 时执行它。见 plan §2.1。
>
> **仍然成立的**：§0 的过期结论表、§1（FLY-1944 复用面清点）、§2.1 **仅限于「审计那句 mismatch 推断在其断言点上不成立」这一条**（该节内「完全正常」与「第 0 步安全」两句已就地撤回，见节内标注）、§2.2（rc=1 的受害面）、§3（Rosetta 机制 M1–M3）、§4.2（被否决的备选 A–F）、§5 的约束与陷阱。

## 0. 会过期的结论表（续接者先读）

| 结论 | as-of | 重核命令 |
|---|---|---|
| arm64 tmux 3.7c 已装在 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`，未 link 到 `/opt/homebrew/bin` | 2026-08-30 | `ls -l /opt/homebrew/bin/tmux; /opt/homebrew/Cellar/tmux/3.7c/bin/tmux -V` |
| cutover receipt / 回滚闭包均不存在 ⇒ FLY-1944 W2 从未启动 | 2026-08-30 | `ls ~/.flywheel/state/host-terminal-cutover.json ~/.flywheel/backup/tmux-3.5a-closure` |
| 活着的 tmux server 全部是 3.5a x86_64 | 2026-08-30 | 用 `host-terminal-cutover.sh` 的 `inventory_tmux_servers` / `extract_tmux_image`（三证 census）。**不要用 `lsof … \| head -1`** —— Rosetta 进程可能暴露多个 `txt` 条目，第一行不权威（详见 plan §3.4 纠错） |
| tmux 协议单向兼容：3.7c client → 3.5a server = rc 0；反向 rc 1 | 2026-08-30 实测 | 见 §2 复现脚本 |
| 承重 python 脚本零第三方依赖，arm64 python 3.14.5 下 221+108 测试全绿 | 2026-08-30 实测 | `/opt/homebrew/bin/python3 scripts/hooks/test-flywheel-restart-guard.py` |
| 登录 shell 里 `/usr/local/bin` 位置 2、`/opt/homebrew/bin` 位置 16 | 2026-08-30 | `env -i HOME=$HOME /bin/zsh -lc 'echo $PATH \| tr : "\n" \| cat -n'` |
| FLY-1944 两轮 PR（#912 / #923）均已合入 main | 2026-08-30 | `git log --oneline --grep=1944` |

## 1. 复用面清点：FLY-1944 留下了什么

本单的第一结论是**几乎所有工装都已存在**。逐个核过可用性：

| 资产 | 位置 | 状态 | 本单如何用 |
|---|---|---|---|
| cutover **原语工具箱**（⚠️ 非「可直接执行的事务」，评审 R5 更正） | `scripts/host-terminal-cutover.sh`（551 行） | 已 ship，未执行 | S3 复用其原语，**但它不含滚动操作、也不含可执行的回滚事务** —— 见 plan 的 P1/P2/P3 |
| 3.7c 兼容门 | `scripts/qa-tmux-3.7c-compat.sh` | 已 ship，fail-closed（缺二进制不 SKIP 而是 FAIL） | S3 的验证器 |
| 精确版本门 | `packages/claude-runner/test/tmux-3.7c-exact.gate.ts` | 已 ship | 同上 |
| brew 护栏 | `scripts/hooks/flywheel-restart-guard.py` | 已 ship，硬拦 Runner 侧 brew 变更（含 `arch -x86_64 brew` 绕过） | S3 的约束，见 §5 |
| PATH 卫生扫描器 | `scripts/check-global-path-hygiene.sh` + `scripts/lib/path-hygiene.sh` | 已 ship（FLY-1389），挂在 `converge-flywheel-bin.sh:653`，由 `package-onboard.sh:100` 装机 | **S2 的挂靠载体** |

`host-terminal-cutover.sh` 的 preflight 断言在今天仍然全部成立（两个 Cellar 二进制在位、版本字符串精确匹配、双 Homebrew 都可执行），唯一会 die 的是 bottle manifest —— 它要求两侧 `brew fetch --deps tmux` 的缓存产物都在，这是开窗口前的准备动作，不是腐化。

**判断：工装未腐化，其原语可复用。**
⚠️ **「可直接用」这个措辞已撤回（R5）** —— 未腐化说的是这些**原语**仍然可用，不等于 S3 的**事务**已经就绪。S3 缺的是 plan §3.2 的 P1–P7，与原语是否齐备无关。

## 2. 核心实证：tmux 协议单向兼容

这是本单唯一能定死实施顺序的证据，因此记录完整复现方式。全程隔离 socket，不碰生产。

```bash
ARM=/opt/homebrew/Cellar/tmux/3.7c/bin/tmux
OLD=/usr/local/bin/tmux

# 方向一：新 client → 旧 server
"$OLD" -S ./z.sock new-session -d -s zt 'sleep 30'
"$ARM" -S ./z.sock list-sessions      # → "zt: 1 windows ..."  rc=0  ✅

# 方向二：旧 client → 新 server
"$ARM" -S ./y.sock new-session -d -s yt 'sleep 30'
"$OLD" -S ./y.sock list-sessions      # → "server exited unexpectedly"  rc=1  ❌
```

补充测定的严重性边界：方向二失败后，**3.7c server 进程存活**（用 3.7c client 复查 `list-sessions` 仍正常）。也就是说旧 client 是 fail-closed 的 —— 它自己失败，不会把 server 带走。这把「混用期」的风险从「server 被打死」降级为「调用静默返回 rc=1」。

### 2.1 对既有判断的一处纠正

仓库审计（本 runner 派出的只读审计 agent）在没有实测的情况下推断：

> server 由 A 组 PATH 起（Intel 3.5a），attach client 由 GUI/B 组 PATH 起（若 `/opt/homebrew/bin/tmux` 存在则是 arm64 3.7c）→ `protocol version mismatch`。当前之所以没炸，只是因为 3.7c 没被 `brew link`。

**这个推断在它断言的那一点上是错的**：实测方向一 rc=0 —— 被测的那次 `list-sessions` 调用**没有**出现协议不匹配。会失败的只有反方向。

⚠️ **措辞已按评审 R4 收窄，原文的两句话已撤回**：
- 曾写「新 client 驱动旧 server **完全正常**」→ 超出证据。已验证的只有**握手与 `list-sessions`**；attach、control mode、`new-window`、`send-keys`、hook 管理、kill 族**全部未验证**（= plan 的 P4 门）。
- 曾写「这个纠正直接决定了 §4 的第 0 步是安全的」→ **不成立**。`brew link` 会立即改变所有已是原生优先的 carrier 所选中的 client，属于**执行期的生产变更**，受 P1/P4/P5 与 founder 授权约束。以 plan §0.0.1 的 **⛔ DO NOT LINK** 为准。

### 2.2 rc=1 的实际受害面

一旦某个 server 变 3.7c 而 client 侧还是 3.5a，以下调用会静默失败：

- **`tmux.conf` 的自清理 hook**（生产 conf 第 3 行，实测原文）：
  ```
  set-hook -g pane-exited 'run-shell "if [ #{hook_pane} = %0 ]; then tmux -S <sock> kill-server; fi"'
  ```
  裸 `tmux`，由 server 自己 `run-shell` 执行，走 server 环境的 PATH。它断掉 = Lead 退出时 server 不自杀 ⇒ 孤儿 server 累积（而 FLY-1944 的 A6 条款正是在治孤儿 socket）。
- **50+ 个裸 `tmux` 调用点**，跨 `claude-runner` / `teamlead` / `edge-worker` / `flywheel-comm` / `core` 五个包；`scripts/flywheel-cmux-sync.sh` 另有十余处（含通用包装 `tmux_call_guarded()`）。
- **`scripts/flywheel-lead-attach.sh:38`**：唯一既无 env seam 又无 PATH pin 的 attach 客户端，由 cmux GUI 启动，PATH 来源与 launchd server 完全不同 —— 版本漂移的最短路径。

**没有集中的 tmux 二进制解析层。** `packages/terminal-mcp/src/tmux-exec.ts` 有契约测试强制集中，但只覆盖 `terminal-mcp` 一个包，且它解决的是环境变量清洗（`sanitizeTmuxEnv` 删 `TMUX`/`TMUX_PANE`），不是二进制选择。因此**唯一的实际决策者是 PATH**，这也是为什么本单必须从 PATH 入手而不是从调用点入手。

## 3. Rosetta 机制的三段结论

| # | 结论 | 证据 |
|---|---|---|
| M1 | CPU 偏好由父进程继承，universal 二进制（如 `/bin/zsh`）跑哪个 slice 不由自己决定 | E1=1 / E2(`arch -arm64`)=0 / E3(再传一层)=0 |
| M2 | 换 arm64 tmux 能根治，但父进程链偏好必须干净 | B（x86 父进程起 arm64 tmux）=1；D（`arch -arm64` 起同一二进制）=0 |
| M3 | PATH 那一半独立存在，换 tmux 不顺带解决 | F2：完全原生的 shell 里 `python3` 仍解析到 `/usr/local/bin/python3`（x86_64） |

M2 在生产上不构成障碍：实测 Lead 的 tmux server `PPID=1`，`~/Library/LaunchAgents/com.flywheel.lead.*.plist` 全部无 `PATH`、无 arch 偏好，launchd 自身原生。**但这是推断链的末端，必须在 cutover 后用 `proc_translated` 实测确认，不能只靠 plist 检查。**

M1 同时解释了 MEMORY 里那条整机重启观察（「14 个 Lead 并行跑 `launchd-census.sh` 对 88 个 plist 各 fork 一个 x86 Python 走 Rosetta」）：不是 census 脚本选错了 python，是它继承了 x86 偏好 + PATH 命中 Intel python 的叠加。

## 4. 方案取舍

### 4.1 选定：三段式，PATH 先行

```
S1 (代码, 无破坏性)  统一仓库 PATH 顺序为原生优先
S2 (代码, 无破坏性)  加 provisioning 守卫
S3 (宿主, 破坏性)    执行 W2 窗口 —— founder 择时, 本单不执行
```

安全序的推导（依据 §2）：

| 步骤 | 动作 | 中间态 | 是否安全 |
|---|---|---|---|
| 0 | `brew link` arm64 tmux | B 组 client=3.7c，全部 server=3.5a | ✅ 方向一 |
| 1 | S1 合入并部署 | A 组 client 也=3.7c，server 仍=3.5a（进程未重启） | ✅ 方向一 |
| 2 | 逐个 Lead 重启 | 该 Lead server=3.7c，全机 client 已=3.7c | ✅ 同版本 |
| ✗ | 先重启 Lead、PATH 未改 | server=3.7c，client=3.5a | ❌ 方向二，全链 rc=1 |

**由此得出本单对 founder 判断的两点修正：**

1. founder 认为「① PATH 顺序只解 hook 那一半」。实际上 ① 同时把 tmux **client** 升到 3.7c，是 ② 的**强制安全前置**。两半在「python 归属」上确实正交（M3），但在「执行顺序」上不正交。
2. founder 认为 ②「要重启全舰，17 个 server 全断，属于需要择时的破坏性操作」。做对顺序后，因为新 client 能驱动旧 server，**第 2 步可以逐个 Lead 滚动做，每次只断一个，中途可停**。仍是破坏性（每个 Lead 丢当前 pane 上下文），仍需 founder 授权，但不再需要「一次全断」。

### 4.2 被否决的备选

| 备选 | 否决理由 |
|---|---|
| **A. 用 `FLYWHEEL_LEAD_V2_TMUX_BIN` 钉绝对路径，绕开 PATH** | `flywheel-lead-wrapper-v2.sh:245` 确实有这个 seam，能让 server 精确用 3.7c。但它**只管 server**，不管那 50+ 个 client 侧裸调用 —— 恰好造成 §4.1 表里的 ✗ 行（server 新、client 旧）。它是 cutover 期的调试工具，不是方案。 |
| **B. 只改 PATH，不换 tmux** | 解掉 python 半边，但 tmux 仍是 x86_64-only，Rosetta 退场当天照样起不来。不解本单的核心风险。 |
| **C. 把 50+ 个裸 `tmux` 收敛到统一解析层** | 正确的长期方向，但是跨 5 个包的大重构，与「到期」这个唯一理由不成比例。本单只需保证 PATH 解析出的版本正确即可达成同样效果。列为独立 issue 候选。 |
| **D. 改 `/etc/paths` 或用户 shell rc** | 宿主级全局改动，超出本单授权；且 `restart-guard` 已把这类命令列为硬拦对象。更关键的是**没必要** —— Lead 明确不读用户 rc（`flywheel-lead-wrapper-v2.sh:281-284`，走 `env -i` 载体），修仓库代码就够。 |
| **E. 重写一套 cutover** | 违反「只调用已合入机制，不重写」（FLY-1944 继承的设计红线）。`host-terminal-cutover.sh` 的预算闸 / quiescence / 回滚闭包 / 三证 census 都是本单需要的。 |
| **F. 用 `arch -arm64` 包一层启动** | 能强制原生（实验 D），但那是给 x86 二进制打的补丁式绕行；生产的 launchd 父链本就是原生的，加 wrapper 只会多一层不必要的间接。 |

### 4.3 S1 的风险已实测清空

S1 把 Bridge / Lead / hook 的 `python3` 从 x86_64 3.14.6 切到 arm64 3.14.5。两个真实风险：

1. **第三方依赖丢失**（两个 Homebrew 的 site-packages 互相独立）—— 实测**不存在**：五个承重脚本（`restart-storm-gate.py`、`flywheel-restart-guard.py`、`discord-reply-enforcer.py`、`voucher-panic-match.py`、`flywheel-config-lock.py`）全部只 import 标准库。
2. **版本行为差异**（3.14.6 → 3.14.5，降一个 patch）—— 实测**未发现**：两个 hook 的自带测试套件在 arm64 python 下 **221 passed / 0 failed** 与 **108 passed / 0 failed**；仓库版与 `~/.flywheel/bin/` 生产版均 `py_compile` 通过；`restart-storm-gate.py --help` 冒烟通过。

注意 3.14.5 < 3.14.6 是**降版本**。它不是本单引入的选择 —— 原生侧就装着 3.14.5。若要求两侧同版本，属于 Homebrew 维护动作，不在本单范围，但应在 plan 的边界里写明。

## 5. 约束与陷阱

1. **`flywheel-restart-guard.py` 会拦 cutover 自己的 brew 命令。** 这是 FLY-1944 立的护栏，理由原文：「tmux/git/node/Homebrew link 等宿主工具是全舰单点;在用版本被无声替换会让所有 Runner 与 cmux 同时断连」。它只作用于 Claude Code 的 Bash 工具（PreToolUse hook），founder 在自己终端手打不受影响。**若 S3 由 runner 执行，必须显式处置这条护栏，不能绕过** —— 绕过它正是它被造出来防的事。
2. **W2 有前置门未确认。** FLY-1944 plan.md:143：「绿才授权 W2 运维窗口;不绿即停排查,不拿 founder-gated 全 server 重启当实验」。本单不重开 FLY-1944 的验收，把它作为 S3 的显式待核前置。已就此向 Lead 提问（非阻塞）。
3. **验收标准需要补一条。** founder 给的「Lead shell 里 `proc_translated` 读到 0」只验 shell 自己；实验 F2 证明原生 shell 里 exec 一个 x86_64-only 的 `python3`，那个进程照样 `proc_translated=1`。验收必须同时覆盖 shell 与它实际解析到的解释器。
4. **改 PATH 会碰到锁死顺序的测试**：`scripts/test-cmux-sync.sh:3746`（断言 autostart 必须原生优先 —— 与 S1 方向一致，不冲突）、`packages/claude-runner/test/runner-env-isolation.real-tmux.test.ts:120,131`（pin 了 canonicalPath，需同步）。
5. **`flywheel-cmux-autostart.sh:24-25` 的注释会变成谎话**：它写着「the watcher shells out to `cmux` (/opt/homebrew/bin) and `tmux` (/usr/local/bin)」并自称「Mirrors the Lead launch wrapper」（当前顺序其实是反的）。S1 之后 tmux 不再来自 `/usr/local/bin`，注释须一并更正。
6. **本单不声称任何性能收益。** 继承 founder 的边界：被翻译的是 shell / python 这类短命进程，开销未测量，理由只有「到期」一条。

## 6. S2 的设计取向

founder 原话：「保留一条检查：将来 provisioning 新机器时，PATH 里原生 Homebrew 必须排在 Intel 之前」。

调研结论是**扩展 `check-global-path-hygiene.sh`，而不是新建脚本**：

- 它已经是只读扫描器 + 违规打印 + `exit 1` 的形状，判据集中在 `scripts/lib/path-hygiene.sh` 单一真源。
- `--alert` 走**现成的** `lead-alert.sh` 管道并带 claims.db 去重 —— 满足 FLY-1944 红线「新 alert kind 走现有管道=允许;新守护 daemon/新通知通道=禁止」。
- 它已挂在 `converge-flywheel-bin.sh:653`，并由 `package-onboard.sh:100` 装进 `~/.flywheel/bin`。
  ⚠️ **本条原文推出的「provisioning 新机器时这条检查自动生效」已撤回（R2/R5）**：实测 `package-onboard.sh:100` 只是**打包清单**，并不执行该脚本；`converge` 的现调用点也只跑**全局态**扫描、不传源码树模式。**本单只声称 CI 这一个挂载点**，见 plan §2.1。
- 有配套的 `scripts/__tests__/check-global-path-hygiene.test.sh`，新规则可直接加用例。

守卫的判据应当是**对仓库内 PATH 声明的静态断言**（每一处声明里 `/opt/homebrew/bin` 必须先于 `/usr/local/bin`），而不是读当前进程的 `$PATH` —— 后者会随调用者漂移，做不成稳定判据。同时应覆盖 §4 表里 A/B 两组的全部声明点，避免再次分叉。
