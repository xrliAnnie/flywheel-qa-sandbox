# Research: cmux IPC silent failure — Production cmux 侧栏不显示 Runner — FLY-129

**Issue**: FLY-129 (Production Runner sessions 不出现在 cmux 侧栏)
**Date**: 2026-05-05
**Source**: live audit of `~/.flywheel/logs/cmux-sync.log` + cmux app prefs + binary strings
**Status**: root cause confirmed; fix Option A+D implemented in plan `v1.25.0-FLY-129-cmux-ipc-fix.md` (branch `feat/v1.25.0-FLY-129-cmux-ipc-fix`)

## TL;DR

cmux app preference `socketControlMode = cmuxOnly` 让 cmux **拒绝任何不是 cmux app 后裔进程的 IPC 连接**。Watcher (`flywheel-cmux-sync --watch`, PID 76031) 一开始由 cmux pane 内的 .zshrc 触发，PPID chain 包含 cmux app；当它的源 pane 被关掉之后，watcher 被 reparent 到 PID 1 (orphan)，**不再是 cmux 后裔**，所有后续 `cmux new-workspace` / `cmux list-workspaces` 调用都被 app silently 拒绝。

cmux-sync.sh 用 `cmux ... 2>/dev/null` 把真实的 access-denied 错误丢掉了，所以 log 只看到误导性的 `WARNING: cmux new-workspace failed for X (cmux not running?)` — 但 cmux app 真的在跑。

## 现象 (what Annie sees)

- Production GEO-366 / GEO-101 / GEO-371 Runner Terminal 都开了，tmux session 起来了
- cmux 侧栏 **完全不显示** 这些 Runner workspace（也不显示 ops/product/cos lead）
- 仅显示 cmux app 启动时通过 GUI 手动建立的旧 workspace
- `~/.flywheel/logs/cmux-sync.log` 每分钟刷一遍：
  ```
  [cmux-sync 16:38:21] Creating workspace for: geoforge3d-ops-lead (@38) from session flywheel
  [cmux-sync 16:38:21] WARNING: cmux new-workspace failed for geoforge3d-ops-lead (cmux not running?)
  ```
- watcher process 还在跑 (PID 76031, parent 1)，没死，纯粹是 IPC 被拒

## 直接证据

### 1. socket file 存在，cmux app 持有

```bash
$ stat /tmp/cmux.sock
srw-------@ 1 xiaorongli wheel 0 May  3 19:24:51 ...

$ lsof -p 678 | grep cmux.sock
cmux 678 xiaorongli 7u unix 0xacda74b955a497ba 0t0 /tmp/cmux.sock
```

PID 678 = `/Applications/cmux.app/Contents/MacOS/cmux`（GUI 主进程）。

### 2. 直接 nc 连接到 socket → app 返回 access-denied

```bash
$ echo "ping" | nc -U /tmp/cmux.sock -w 2
ERROR: Access denied — only processes started inside cmux can connect
```

这就是 cmux CLI 调用得到的结果，但 CLI 把 stderr 吞了，只用 exit 码 141 (SIGPIPE，因为 app 单方面关连接) 退出。

### 3. cmux app prefs 配置

```bash
$ defaults read com.cmuxterm.app | grep socket
    socketControlMode = cmuxOnly;
```

binary strings 中的 enum：

```
SocketControlMode
cmuxOnly       — Only processes started inside cmux terminals can send commands.
allowAll       — Disables ancestry and password checks; opens socket to all local users.
automation     — Require socket authentication with a password stored in your keychain.
```

### 4. Watcher 的 ancestry 不是 cmux 后裔

```text
watcher (76031) ancestry:
  76031     1  /bin/bash flywheel-cmux-sync --watch    ← orphan (PPID=1)

cmux-attached tmux client (73359) ancestry:
  73359 73179 tmux attach -t =cmux-geoforge3d-cos-lead
  73179 73178 -/bin/zsh
  73178   678 /usr/bin/login -flp xiaorongli /bin/bash --noprofile --norc -c exec -l /bin/zsh
    678     1 /Applications/cmux.app/Contents/MacOS/cmux         ← cmux app
```

watcher 的 source pane 死了之后被 reparent 到 launchd (PID 1)，从此 cmux app 看到 caller 不是后裔，全部拒绝。

### 5. 历史日志佐证：早上 09:36-09:39 watcher 还能正常跑

`/tmp/flywheel-cmux-watcher.log:286-302`：

```
[cmux-sync 09:36:59] Creating workspace for: test-slot-4-flywheel-test-4
OK F67FF838-A000-4D4E-AE3A-D218BFAD42D9
OK workspace:19
[cmux-sync 09:39:39] Creating workspace for: FLY-124-claude-Issue-FLY-124
OK 69D54E39-BCA8-4B56-8413-DB85D1DFEC56
OK workspace:20
```

之后某个 cmux pane 被关掉，watcher 被 reparent，从此再也没有成功记录。`/Users/xiaorongli/.flywheel/logs/cmux-sync.log` 里 13:00 之后全是 WARNING。

## 为什么 cmux-sync.sh 把错误吞了

`scripts/flywheel-cmux-sync.sh:156`:

```bash
# FLY-98: protect against SIGPIPE/exit 141 when cmux is unavailable
if ! cmux new-workspace --command "tmux attach -t '=${view_session}'" 2>/dev/null; then
  log "WARNING: cmux new-workspace failed for $window_name (cmux not running?)"
  return 0
fi
```

FLY-98 的注释说 `2>/dev/null` 是为了防 SIGPIPE；但实际效果是把所有真实错误（包括 access-denied）也 silent 掉了。FLY-98 的修复假设了"失败 == cmux not running"，但还有一种 silent 失败模式：cmux 在跑但拒绝 caller。

## 修复 options

### Option A — `socketControlMode = allowAll` + watcher fail-loud

**改动：**

1. 一次性 `defaults write com.cmuxterm.app socketControlMode -string allowAll`（重启 cmux 生效）。
2. `flywheel-cmux-autostart.sh` 启动时检查 mode，若不是 `allowAll`（且 watcher 不在 cmux pane 内）→ 大声 log + warn user。
3. `flywheel-cmux-sync.sh`：移除 `2>/dev/null`，改 `2>>$ERR_LOG`；watcher 启动时跑 `cmux ping`，access-denied 立即 exit 1（让外层重新 spawn）。

**安全 tradeoff：**

`allowAll` 是 cmux app 全局 preference，**关闭 caller-PID-validation 并且主动放宽** `/tmp/cmux.sock` 文件 mode 到 `0666` (`srw-rw-rw-`)。本机所有 user 都能通过该 socket 控制 cmux（建 workspace、跑 command、读 terminal output）。

接受该 tradeoff 仅因为 Annie 这台是单用户 dev box，本机只有 1 个 local user。**多用户 / 共享 host / SSH 多用户机不可使用此 mode**。Install script 显示警告 + 交互确认；watcher 启动时也 advisory log 提示当前 mode。

### Option B — `socketControlMode = automation` + keychain password

**改动：**

1. Annie 在 cmux Settings 设 socket password → 保存到 keychain（label `local-socket-password`）。
2. watcher 启动时 `security find-generic-password -l local-socket-password -w` 取密码，export `CMUX_SOCKET_PASSWORD`。
3. cmux CLI 自动用环境变量 auth。

**优点：** 最严，符合 cmux app 设计意图。
**缺点：** Annie 需要手动操作 GUI 设密码；keychain access 在非交互环境可能会弹 prompt（除非 "Always Allow"）。

### Option C — Watcher 改由 launchd KeepAlive 管理 + cmux pane bootstrap

**改动：**

1. 写 `com.flywheel.cmux-watcher.plist`，KeepAlive 重启 watcher。
2. Watcher 启动时若不是 cmux 后裔 → 用 osascript 让 cmux 开新 pane → pane 内 exec `flywheel-cmux-sync --watch` → 退出当前 process。

**优点：** 无安全 tradeoff。
**缺点：** 复杂、fragile。每次 watcher restart 都要 cmux GUI 弹新 pane（视觉污染）；osascript 需要 cmux 支持 AppleScript 命令。

## 推荐

**Option A (allowAll) + Option D 改 watcher fail-loud**。理由：

- `allowAll` 是 cmux app 全局 preference：关闭 ancestry/password 检查 **并且**主动放宽 `/tmp/cmux.sock` 文件 mode 到 `0666`。本机所有 user 都能通过 socket 控制 cmux。
- 接受该 tradeoff 仅因为 Annie 这台是单用户 dev box（本机只有 1 个 local user）。**多用户 / 共享 host / SSH 多用户机不可使用此 mode**。
- watcher 改 fail-loud + 周期 ping 自检后，未来任何 IPC 故障（包括 cmuxOnly mode 误改回）都能立刻发现，不再 silent。
- Install script 显示警告 + 交互确认；watcher 启动时也 advisory log 提示当前 mode。

**短期 workaround**（让 production 立即恢复，不动代码）：

```bash
# 1. switch mode
defaults write com.cmuxterm.app socketControlMode -string allowAll
# 2. quit cmux app, reopen
osascript -e 'quit app "cmux"'  # or via Cmd+Q
open -a cmux
# 3. watcher 已经在跑 — 它会在下一次 60s 扫描时把所有 missing workspaces 补回来
```

## 跟 worker-fly-60 W5 的关系

team-lead 提到 worker-fly-60 在做 FLY-60 v2 W5 "cmux IPC fix"。但实际 PR #165 (FLY-60) 是 **Hard Gate E2E QA suite**，**不**是 cmux 修复。已 SendMessage 给 worker-fly-60 sync 真实方向。

如果 W5 后续要修同一处，**合并到一个 PR**（避免相同 file 的 merge conflict / 重复修复）。否则 FLY-129 走独立 PR。

## 待决策

1. **Annie**: 选 A（allowAll，推荐）/ B（automation+password）/ C（launchd）
2. **worker-fly-60**: W5 实际方向 → 决定合并/分开 PR
3. **team-lead**: 是否需要先做 short-term workaround 让 production 立即恢复

## 实施 outline (假设 Option A)

文件：

- `scripts/flywheel-cmux-sync.sh`
  - 移除 `cmux ... 2>/dev/null` → `2>>$CMUX_ERR_LOG`
  - watcher 入口跑 `cmux ping` 自检，失败 log + exit 1
  - 检测 `socketControlMode != allowAll` 时 warn
- `scripts/flywheel-cmux-install.sh`
  - 安装时 `defaults write com.cmuxterm.app socketControlMode allowAll`（带 prompt 让 Annie 确认）
  - 检查 cmux app 在跑 → 提示重启
- 单元测试：mock `cmux ping` access-denied → 断言 watcher 退出码 = 1

## 验收

- Annie spawn 5 个 Runner（5 个 tmux window）→ 60 秒内 cmux 侧栏全部出现
- 关闭一个 cmux pane → watcher 不影响
- `cmux ping` 从 watcher context 永远成功
- cmux 重启 / 用户登出登入 → watcher self-heal（fail-loud + restart）

## 附录：诊断命令

```bash
# 状态自检
defaults read com.cmuxterm.app | grep socketControlMode
echo "ping" | nc -U /tmp/cmux.sock -w 2
ps -o pid,ppid,command -p $(cat /tmp/flywheel-cmux-watcher.lock/pid)
tail -50 ~/.flywheel/logs/cmux-sync.log

# 修复（不动代码）
defaults write com.cmuxterm.app socketControlMode -string allowAll
osascript -e 'quit app "cmux"' && sleep 2 && open -a cmux
```
