# FLY-1679 wrapper-v2 缺 dev-channels 自动确认 — 调研

Issue: FLY-1679 (https://linear.app/geoforge3d/issue/FLY-1679/wrapper-v2-缺-dev-channels-自动确认-lead-冷启动卡确认框直到人工按键该-lead-discord-下线)
日期: 2026-08-10
基于: exploration.md

---

## 1. 生产账本：poller 在 v2 切换那天停笔（before/after 铁证）

`_log_startup` 在 `claude-lead.sh` 里**只有 5 个调用点，全部在 `_poll_dev_channels_dialog` 函数体内**（`:1465 / :1470 / :1479 / :1484 / :1492`）。因此 `~/.flywheel/logs/lead-<id>-startup.log` 是一份**纯 poller 日志**——它有没有新行，等价于 poller 有没有跑。这消除了「文件不可写 / 换路径了」这类替代解释（同一路径、同一权限、同一写入者）。

13 个生产 Lead 的**最后一行** poller 日志：

| Lead | 最后一行时间 |
|------|------|
| claude-infra-bot-lead | 2026-08-07T21:28:58 |
| cos-lead | 2026-08-07T21:29:45 |
| flywheel-cos-lead | 2026-08-07T21:29:14 |
| flywheel-eng-lead | 2026-08-07T23:07:35 |
| flywheel-product-lead | 2026-08-07T21:29:51 |
| joycon-lead | 2026-08-07T21:30:59 |
| ops-lead | 2026-08-07T21:30:06 |
| product-lead | 2026-08-07T21:30:12 |
| rafiki-lead | 2026-08-07T21:30:34 |
| reflection-lead | 2026-08-07T21:30:52 |
| sub-lead | 2026-08-07T21:31:30 |
| tidal-echo-content-lead | 2026-08-07T21:31:57 |
| tidal-echo-cos-lead | 2026-08-07T21:31:51 |

v2 载体合入时间：`dfc8848b feat: replace Lead lifecycle with launchd-native carrier (#794)` → **2026-08-09 17:40:28 -0700**。

之后生产至少经历了 2026-08-10 08:34 与 12:39 两轮重启（issue 记录的两次活体），**零新增 poller 行**。

> 补充判据：所有历史 poller 行都带 `window=@N`（共享 server 的 window id）。v2 body 根本不建 window（`_launch_claude:2873` 分支直接 `env -i … claude … &`），所以**不存在**一条 v2 出身的 poller 日志。QA 槽 `flywheel-test-*` 在 08-09/08-10 仍有 `window=@22680 / @22760` 这类行，说明那几次是共享 server 的 v1 形态启动（另一条 harness 路径），不是 v2 body —— 它们不能当成「v2 也会自动确认」的反证。

历史行为参考（修好后应该恢复成这样）：匹配几乎都在 **1–2 秒**内完成，例如
`21:29:27 start window=@1286` → `21:29:28 matched`。

---

## 2. 识别文本：搬什么、要不要收紧

### 2.1 现存三处识别逻辑，用的是同一族标记

| 处 | 正则 |
|----|------|
| `claude-lead.sh:1477`（v1 poller） | `Loading development channels\|am using this for local development\|development channels` |
| `test-deploy.sh:1225`（QA 外部代偿） | `Loading development channels\|am using this for local\|development channels` |
| `expect-dev-channels.exp:66-84`（FLY-109 原始 expect，v2 未接） | 三条独立 `-re`：`Loading development channels` / `I am using this for local development` / `WARNING: Loading development channels` |

expect 脚本的注释解释了为什么用短子串：

> Claude 的 Ink TUI 会在词之间插 ANSI 颜色码，所以只匹配 `DevChannelsDialog` 里**短的、基本连续**的子串。

### 2.2 第三段 `development channels` 是前两段的超集

`Loading development channels` 必然包含 `development channels`。所以三段式在语义上等价于

```
development channels | am using this for local development
```

`development channels`（裸词组）是**最松**的一段：pane 上任何出现「development channels」的文本都会触发一次 `1` + `Enter`。

### 2.3 这条松匹配在 v2 下会不会真的误按？

分两种情形讨论：

**(a) 冷启动 fresh** —— 确认框是 claude 启动后屏幕上的第一个东西，poller 第 1 秒就命中并 `return 0` 退出。历史 13 个 Lead × 数十次启动，全部 1–2 秒命中，从未观察到误按。

**(b) resume** —— `claude --resume <id>` 同样先弹确认框（flag 级，先于会话渲染），所以正常也是先命中框。**但**如果某次确认框没出现（Claude Code 版本变更 / flag 语义变了），poller 会继续轮询 90 秒，而此时 pane 上渲染的是历史对话。若这个 Lead 曾经讨论过「development channels」（例如**本单 FLY-1679 本身**就会让 eng-lead 的会话里反复出现这个词组），poller 就会往 REPL 里打一个 `1` + 回车 —— 相当于凭空给 Lead 发一条内容为「1」的消息。

情形 (b) 不是纯理论：本单一旦上线，讨论过它的 Lead 的会话里必然含这个词组。

### 2.4 结论：收紧到「确认框特征」，但不发明新识别

验收 #3 逐字要求「自动确认只匹配 dev-channels 框的**特征文本**」。裸词组 `development channels` 不是框的特征，它是话题词。

采纳做法 —— **仍然只用 FLY-109 已经在生产上证明过的两条框内文本，删掉那条冗余且过松的裸词组**：

```
Loading development channels | am using this for local development
```

理由逐条：
- 这两条**都来自 FLY-109 的 expect 脚本**（`-re {Loading development channels}` 与 `-re {I am using this for local development}`），是原版就有的标记，不是新造的。
- 删掉的第三段在**匹配框本身**这件事上不提供任何额外能力（它是第一段的子串，框出现时第一段必中）。
- 保留的两条各自对应框的两块：标题行 `WARNING: Loading development channels…` 与选项行 `1. I am using this for local development`。ANSI 插码风险由「两条任一命中即可」兜住。

这属于「搬运时去掉一段冗余且危险的兜底」，不是发明新机制：识别面**只缩不扩**，对真框的命中能力不变（第一段本来就覆盖第三段能覆盖的所有真框场景）。

> 明确留在 v1 的不动：`claude-lead.sh:1477` 的 v1 函数**逐字不改**。`scripts/__tests__/supervisor-storm-regression.test.sh:311` 用 `sed` 抽这个函数体并断言它含 `_tmux_target_matches_archive_fast`；同时 v1 路径要保持字节兼容。

---

## 3. v2 的目标寻址与存活闸

### 3.1 socket 必须显式给，不能靠 `_tmux`

`_tmux()`（`:1301`）在 `FLYWHEEL_TMUX_SOCKET_OVERRIDE` 非空时会打 `-S "$FLYWHEEL_TMUX_SOCKET_OVERRIDE"`。那是 v1 共享拓扑的概念。v2 body 必须打**自己的**私有 socket，否则在设了 override 的环境里会把 `1` + `Enter` 敲进别人的 pane。

私有 socket 从 pane 自己的 tmux 身份推：tmux 约定 `TMUX=<socket_path>,<server_pid>,<session_id>` ⇒ `${TMUX%%,*}`。

证据：`_launch_claude` v2 分支（`:2884-2886`）显式把 `TMUX` / `TMUX_PANE` 透传给 claude 子进程，说明 body shell 环境里两者存在。

`TMUX` 为空时（非 tmux 环境，例如直接手跑 body 做诊断）⇒ 记一行日志，直接 `return 0`，不做任何按键。fail-safe 方向正确：宁可不按，不可乱按。

### 3.2 pane 目标

- 首选 `${TMUX_PANE}`（body 自己的 pane，最精确）。
- 缺失时退回 `%0`：`wrapper-v2.sh:224` 固定 `new-session -d -s main -n main`，且 `tmux.conf` 的 pane-exited hook 硬编码 `#{hook_pane} = %0`（`:162`）—— `%0` 由 wrapper 与 conf 双重保证。

活体核对：
```
$ tmux -S ~/.flywheel/sock/fw-flywheel-claude-infr-*.sock list-panes -a \
    -F '#{session_name}:#{window_name}.#{pane_id} pid=#{pane_pid} cmd=#{pane_current_command}'
main:main.%0 pid=82117 cmd=bash
$ ps -p 82117 -o command=
/bin/bash …/packages/teamlead/scripts/lead-body.sh …/flywheel-claude-infra-bot-lead.json
```

### 3.3 存活闸：v1 的归档闸在 v2 不成立，换成 pane 探活

v1 用 `_tmux_target_matches_archive_fast`（读 `TMUX_ARCHIVE_FILE` 归档，确认这个 window 还是「我这一代」的）。v2 没有归档文件，也不需要——私有 server 一 Lead 一个，pane `%0` 退出时 `exit-empty on` + pane-exited hook 会直接 `kill-server`。

所以 v2 的等价闸就是：**发键前确认这个 pane 在这个私有 server 上还活着**（`display-message -p -t "$pane"`）。server 没了 ⇒ tmux 命令非零退出 ⇒ 直接收工。

---

## 4. 起停时机：v1 与 v2 的关键差异

| | v1 | v2 |
|---|---|---|
| `_launch_claude` 语义 | 建 tmux window 后**立即返回**（`:2948` log 后就 return） | `env -i … claude … &` 后 **`wait` 阻塞**直到 claude 退出（`:2888-2895`） |
| poller 起点 | `_launch_claude` 之后（`:4525`） | **必须在 `_launch_claude` 之前** |
| poller 收点 | `_wait_tmux_window` 之后 kill + wait（`:4535`） | `_launch_claude` 返回之后 kill + wait |

若照抄 v1 的「launch 后再起」，在 v2 里那行代码永远等到 claude 退出才执行 —— 等于没有。

其它可以直接沿用的：
- `INBOX_MCP_ENABLED = true` 才起（`:3208 / :3233` 决定，`:3403` 才加 `--dangerously-load-development-channels`）。没有这个 flag 就没有这个框。
- 超时预算 `FLYWHEEL_DIALOG_TIMEOUT_SEC`（`:1260`，默认 90，可由 `FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC` 覆盖）。不新增 env。
- 日志走 `_log_startup`（**写文件**，不写 stdout）—— 这一点在 v2 尤其关键：poller 是 body shell 的后台作业，与 claude 共用 pane 的 tty，任何 stdout 输出都会污染 Ink TUI 的渲染。

---

## 5. 后台作业与 tty 的相容性核查

v2 里 claude 是 `env -i … claude … &` 起的后台作业，poller 也是后台作业，两者同属 body shell。

- 非交互 bash **不开 job control**（`set -m` 未设），所有后台作业留在 shell 自己的进程组 = pane 的前台进程组 ⇒ claude 能正常读 tty，不会吃 SIGTTIN。这是现网既成事实（Lead 被人工按掉之后就正常工作）。
- poller 不读 tty、不写 tty：它只跑 `tmux capture-pane`（输出被 `$(...)` 吃掉）、`tmux send-keys`、以及写文件的 `_log_startup`。
- `wait "$CLAUDE_CHILD_PID"` 是**按 pid 等**，多一个后台作业不影响它。
- launchd 停止 job ⇒ tmux kill-server ⇒ pane 进程组被清 ⇒ poller 随之消失；正常路径由 `_launch_claude` 返回后的显式 `kill` + `wait` 回收。

---

## 6. QA 杠杆：`SKIP_DEV_CHANNELS_WORKAROUND=1`

`scripts/test-deploy.sh:1216` 的 `confirm_dev_channels_prompt()` 是 QA 房的**外部代偿**，用的正是 v2 拓扑（`-S "$socket" -t '=main:main.%0'`）。它一直在替生产打这一针，所以 QA 房从来没暴露过这个洞。

`SKIP_DEV_CHANNELS_WORKAROUND=1`（`:1218`）关掉外部代偿 ⇒ **冷启动只能靠启动链自己确认** ⇒ 这就是验收 #1 的现成杠杆，不需要为本单新建 QA 能力。

该分支现有日志文案 `"… relies on expect-dev-channels.exp"` 是 FLY-109 时代遗留：v2 完全没接 expect 脚本（`expect-dev-channels.exp` 只在 `package-onboard.sh:73` 的打包清单里出现，没有任何 v2 调用点）。这行文案会把 QA 引向错误的观察对象，值得一行订正。

外部代偿**不删**：修好之后生产 poller 先命中，QA 那一轮 grep 不到框，只会打一行 `No dev-channels prompt observed` —— 幂等、无副作用，且保住 QA 房现有用例稳定性。

---

## 7. 测试面盘点

现有可复用的 harness 形态：

| 文件 | 形态 |
|------|------|
| `scripts/__tests__/supervisor-storm-regression.test.sh` | `sed` 抽函数体 → `eval` → 打桩依赖 → 断言。已有一条断言依赖 v1 poller 函数体 |
| `packages/teamlead/scripts/__tests__/expect-script.test.sh` | 真 `expect` + mock child，含 Test 4「泛化 confirm 屏幕不得发 1」的反例守护 |
| `scripts/__tests__/lead-body-hard-clear.test.sh` | 真 tmux 形态 |

记忆里的两条硬教训直接适用：
- **`TMUX_TMPDIR` 不隔离，要用 PATH shim**（`reference_tmux_tmpdir_does_not_isolate_use_path_shim`）—— 打桩 tmux 必须靠 PATH 前置的假 `tmux`，不能指望环境变量把真 tmux 隔开。
- **Mock 需 real-tool 补位**（`feedback_mock_tests_need_integration_complement`）—— 纯打桩证明不了「真 tmux 上 send-keys 真的进得去 pane」，需要一条真 tmux 的 E2E。

因此测试分两层：
1. **桩层**（PATH shim 假 tmux）：命中/不误按/超时/pane 消失 四个分支 + 目标寻址正确（socket 与 pane 参数逐字）。
2. **真 tmux 层**：起一个真的私有 tmux server，pane 里跑一个「先打印确认框文本、再读一行」的假 claude，断言它真的读到了 `1`。这条证明按键真的落进了 pane，而不是只证明「我调用了 send-keys」。

第三层（真 launchd 冷启动、零人工按键、Discord 上线）= 验收 #1/#2，属于独立 QA 节点在 QA 槽/生产窗口做的事，不由实现节点自证。
