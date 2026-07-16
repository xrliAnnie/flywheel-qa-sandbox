# FLY-1285 tmux server 丢失 + 恢复配置漂移 — QA 报告

Issue: FLY-1285 (https://linear.app/geoforge3d/issue/FLY-1285/incident-2026-07-15-0016-runner-tmux-server-丢失10-runner-阵亡-恢复机制以)
日期: 2026-07-15
基于: plan.md（codex-approved, 10 轮）、research.md、PR #611 @ e2c80e908

## 结论：**FAIL** — 不可 ship

**在真 tmux 上，事故原样复现。** 本 PR 要防的那件事（饱和 server 的 socket 被"恢复"动作顶替）
在打了这个补丁的代码上仍然发生：`ensure` 返回 `action:"created"`、socket inode 被换、
第二个 server 被 fork、老 server 连同全部 window 变孤儿 —— 与 00:16 事故链条逐字一致。

根因是一个平台事实错误，不是逻辑错误：**候选扫描在 macOS 上永远返回空**。
分类逻辑本身是对的（下方 A/B 对照实证），但它建立在一个本机不成立的前提上。

CI 绿、Codex design review 10 轮 APPROVED、28 条 shell 测试全过 —— 这些**都没有伪证**，
它们只是全部建立在同一个错误前提上（见 §4）。

---

## 1. 根因：候选扫描在 macOS 上恒为空

`scripts/lib/tmux-server-rescue.sh:119-127` 的 `_tmux_rescue_server_pids`：

```bash
case "$command" in
  *"tmux: server"*|*"tmux server"*) printf '%s\n' "$pid" ;;
esac
```

**macOS 的 tmux server 不改进程名**，daemonize 之后保留原始 argv。本机实测：

```
$ ps axww -o uid=,pid=,ppid=,command= | awk '$1==501 && $3==1 && /tmux/'
  501  1269  1 /usr/local/bin/tmux -L atlas new-session -d -s atlas-growth ...
  501  3738  1 tmux new-session -Ad -s flywheel            ← 事故当晚被顶替的老 server
  501 93009  1 tmux new-session -Ad -s flywheel -x 200 -y 50  ← 现役生产 server

$ _tmux_rescue_server_pids
  (空)
```

三个真实 server，一个都不匹配 `tmux: server` / `tmux server`。

### 后果：七态坍缩成两态，且坍缩方向是 fail-open

`candidatePids` 恒空 ⇒ `tmux_socket_inspect:165-185` 只可能产出：

| 需要候选的 verdict | 是否可达 |
|---|---|
| `saturated`（socket 在 + 不可达 + server 活） | **永不可能** |
| `missing_single_orphan`（可 SIGUSR1 复活） | **永不可能** |
| `split_brain`（E3 护栏） | **永不可能** |
| `ambiguous`（多候选） | **永不可能** |
| `reachable` / `dead` | 只剩这两个 |

而 `dead` 是**唯一**授权"不带 `-N` 的、会启动 server 的 create"的分支
（`_tmux_socket_ensure_locked:325-346`）。也就是说：**server 活着但连不上 → 判 dead → 建新 server → 顶替 socket = 事故本身。**

这直接违反 plan「核心安全原则 1：破坏性动作只接受正向证明…绝不 fail-open」。
代码注释（:174-177）写的是"完整扫描证明没有 owner，创建就是安全的"——
但扫描是瞎的，所以这个"正向证明"是空证。

### 生产实证：库看不见此刻就在机器上的 split-brain

```
$ tmux_socket_inspect /private/tmp/tmux-501/default
{"verdict":"reachable", ..., "reachablePid":93009, "candidatePids":[], "scanComplete":true}
```

3738（事故遗留孤儿，research §4 记录在案）此刻**真实存活并持有 default 路径的旧 inode**，
库报告 `candidatePids:[]` + `scanComplete:true` —— 即"我完整扫描过，确认没有别的 server"。
这正是 Bridge boot leg 表格里 `reachable（scanComplete+零候选）→ 正向证明单 server 换代 → server_fresh 成组迁移`
所依赖的判据。**该判据恒真 ⇒ 成组埋葬恒发生 ⇒ split-brain 保护是空转。**

---

## 2. 决定性 A/B 对照（同条件，单变量）

socket 置于 `/private/tmp` 下（归一化=恒等、lsof 匹配成立），即**与生产 default socket 同形**。
条件：server SIGSTOP + backlog 灌满（实测恰 128，与 research E1 的 `kern.ipc.somaxconn` 一致）。

| | verdict | ensure | socket inode | 结果 |
|---|---|---|---|---|
| **A：本 PR 原样** | `dead` | rc=0 `action:"created"` | 233531537 **→ 233531831** | **事故复现** |
| **B：只改 ps 匹配一行** | `saturated` | rc=2 `hold_saturated` | 233531953 **不变** | **事故被挡住** |

唯一变量 = `_tmux_rescue_server_pids` 的匹配式。
**这同时证明了两件事**：缺陷是承重的（不是纸面问题），且 §5 的修复方向确实翻转行为。

对照组（证明断言非空转）：同条件下裸 `tmux new-session -Ad`（= 修复前 claude-lead.sh 的调用）
同样换 inode → 确认 E1 场景真实、fix 确实是承重件。

---

## 3. 第二个缺陷：lsof 路径归一化（独立、半径较小）

`_tmux_rescue_pid_has_socket:108` 用 `grep -Fqx "n${socket_path}"` 精确比对归一化后的路径，
但 **lsof 报告的是 tmux 绑定时的原始路径**：

```
requested            /tmp/fly1285-lsof.sock
library normalized   /private/tmp/fly1285-lsof.sock
lsof reports         n/tmp/fly1285-lsof.sock        ← 不相等
predicate rc         1  (= "确定不持有该 socket")
```

**危险点在 rc=1 的语义**：它被当作"确定没有 owner"的**正向证据**，`scanComplete` 保持 `true` →
verdict 落 `dead` → 授权 create。比对失败被读成了"证明没有"，而不是"证据缺失"。

**半径（已核实，不夸大）**：生产 default socket **不受影响** —— tmux 自己就把 default 路径解析成
`/private/tmp/tmux-501/default`，lsof 报的也是它，比对成立（3738/93009 实测 rc=0）。
受影响的是**任何经符号链接前缀传入的 `-S` 路径**（`/tmp/...`、`/var/folders/...`），
即 `FLYWHEEL_TMUX_SOCKET_OVERRIDE` 这个 QA seam 与 plan §2.5「真 tmux 隔离段」要用的隔离 socket。
**副作用**：它恰好挡住了本可以发现缺陷 A 的那类真机测试。

---

## 4. 为什么全绿的测试没抓住 —— fixture 把错误前提写死了

`scripts/__tests__/tmux-server-rescue.test.sh` 是**完全 hermetic** 的（107 处 `FAKE_`，
tmux/ps/lsof 全部 PATH 打桩，零真 tmux）。它的 `ps` 桩输出：

```bash
export FAKE_PS_ROWS='6161 1 tmux: server\n'
```

**`tmux: server` 这个格式 macOS 的真 ps 从来不会产出。** 于是 21 条测试在一个
本机不成立的世界里验证逻辑，全绿，且恰好绕开了唯一的真问题。
这属于 memory 里记的 `label-substituting-for-fact` bug class：
fixture 的**标签**（"tmux: server"）冒充了**事实**（ps 实际打印什么）。

Codex design review 10 轮全部在评审 plan 文本，未触及"macOS ps 到底打印什么"这个事实层；
CI 亦然（且 Linux 的 tmux **确实**会重命名成 `tmux: server`，所以 Linux CI 天然发现不了——
但生产是 Annie 的 Mac）。

### 附带发现：锁的并发测试测的是生产不走的后端（非缺陷，是覆盖盲区）

`_tmux_rescue_select_lock_backend` 的探测链是 flock → lockf → python。本机：
`flock` **缺失**、`/usr/bin/lockf` **存在** ⇒ 生产选中 **lockf**。
但 `tmux-server-rescue-lock.test.sh` 唯一的行为级互斥测试直接调
`_tmux_rescue_python_lock`（python 后端），且 python 不可用时 `exit 1`。
链路测试（`tmux-server-rescue.test.sh:505-517`）只断言选择器**返回哪个字符串**，不验证被选中后端真的互斥。

⇒ plan §2.1(c) 要求的「两个真实进程同时抢锁证明临界区并发恒为 1」**在生产后端上从未被验证过**。

**我实测了 lockf 后端本身：互斥是成立的**（112 段临界区、14 并发 × 8 轮，零重叠；
macOS lockf 实现了 unlink 检测 + 重取循环）。所以**这不是活缺陷，是覆盖盲区**——
生产后端一旦回归，测试不会红。
（我最初根据 man page 的 `-k` 警告推断"互斥已破"，**实测推翻了该假设**；此处按实证记录，不按 man page 记录。）

---

## 5. 修复方向（已实证可行，实现由 implement 阶段决定）

**缺陷 A**（承重、必须修）：`_tmux_rescue_server_pids` 用 argv[0] basename 识别，保留原有重命名格式兼容 Linux：

```bash
case "${command%% *}" in
  tmux|*/tmux) printf '%s\n' "$pid" ;;
  *) case "$command" in *"tmux: server"*|*"tmux server"*) printf '%s\n' "$pid" ;; esac ;;
esac
```
Run B 已实证此改动让 E1 从"顶替"翻成 `hold_saturated`。
（注意：`tmux -S` 的**客户端**也叫 tmux，但 `ppid==1` 已把客户端排除——客户端 ppid 是 shell；
且是否持有目标 socket 仍由 lsof 决定，故不会引入误判。此点建议 implement 阶段补测。）

**缺陷 B**：比对前把 lsof 报告的路径也做同样归一化（或双向比对 requested/normalized 两种形式）；
更重要的是**把"比对不上"与"证据缺失"分开**——`grep` 不匹配不应等价于"确定无 owner"。

**fixture**：`FAKE_PS_ROWS` 改用真 macOS 格式（`tmux -S /path new-session ...`），
否则 hermetic 测试会继续为错误前提背书。

**锁**：把行为级互斥测试参数化跑遍**每个可用后端**（至少覆盖选择器实际选中的那个）。

---

## 6. 本次新增的守卫测试

`scripts/__tests__/tmux-server-rescue-real-tmux.test.sh`（本 PR 分支已提交）——
对**真 tmux** 断言整个设计所依赖的两个平台前提，并端到端重演事故。

**当前 head 上的实跑结果（RED，如实记录）**：

```
[TEST] a real daemonized tmux server is recognized as a server candidate
  ✗ server scan is BLIND to a real tmux server (pid=16315, command: tmux -S ... new-session -d -s live)
[TEST] a real server is recognized as the owner of its socket
  ✓ lsof ownership predicate matches the real socket path
[TEST] ownership survives a socket path that traverses a symlink
  ✗ ownership predicate breaks on a symlinked socket path
[TEST] a reachable server yields the reachable verdict with no orphan candidates
  ✓ reachable verdict binds the real server generation
[TEST] THE INCIDENT: a live-but-saturated server must hold, never be replaced
  ✗ saturated server misclassified as 'dead' (a 'dead' verdict authorizes a replacing create)
  ✗ FLY-1285 REPRODUCED: ensure rc=0 (want 2), socket inode 233551877 -> 233552154

Results: 2 passed, 4 failed
```

2 过 4 挂 ⇒ 该测试**有区分度**，不是一律红。tmux/lsof 缺失时 skip（CI 安全）。

---

## 7. 验收清单对照（plan §6）

| # | 项 | 结论 |
|---|---|---|
| 2 | E1 重演：hold 不顶替 | **FAIL** —— 顶替发生，verdict=dead |
| 3 | E2 重演：recover 找回窗口 | **FAIL** —— 判 dead，永不 SIGUSR1 |
| 4 | 并发赛跑：临界区并发恒 1 | 实测**通过**（lockf 后端 112 段零重叠），但**生产后端无回归测试**（§4） |
| 5 | `-N` 故障注入：绝不自启第二 server | **FAIL** —— 走的是 dead 分支，`-N` 根本没参与 |
| 7 | split-brain：零埋葬、ticket 恰一 | **FAIL** —— split_brain 恒不可达 |
| 10 | marker 缺失/坏权限拒 SIGUSR1 | 通过（但因 A，SIGUSR1 路径本就到不了） |
| 12 | 字节兼容锚（28 条 shell 测试） | 通过（但见 §4：前提错误） |
| 1/8/9/11 | PR-0 / Fix B / Fix C / hold 权威 | **未验** —— A 是结构性阻断，先修再验 |

未验项非"通过"。缺陷 A 让整条 rescue 链路不可达，继续验下游意义不大。

---

## 8. 环境卫生

- 全部实验用私有 socket（`/private/tmp/fly1285-*`、临时目录），**从未触碰 default socket**。
- 实验期间库自行创建的顶替 server 已逐个核对 argv 后 reap；
  收尾核查：仅剩 `1269`(atlas) / `3738`(事故孤儿，research §4 待 Tadashi 处置) / `93009`(生产, 31 sessions)。
- **绝未对 3738 发 SIGUSR1**（research §4 铁律：E3 反向抢占会把 93009 打成孤儿）。
- 生产 Bridge / Lead / runner 未重启、未改配置。

## 9. 交接

`--route blocked` 不适用；按三段式 QA FAIL 路径：verdict 已 `qa-result --status fail`，
本 Runner park，等 implement 阶段在同分支修复后唤醒复验。

复验时请直接跑：
```bash
bash scripts/__tests__/tmux-server-rescue-real-tmux.test.sh   # 必须 6/6 全绿
bash scripts/__tests__/tmux-server-rescue.test.sh             # 且 fixture 改真格式后仍绿
```
