# FLY-2266 Lead 面板重连可见性 — 调研
Issue: FLY-2266 (https://linear.app/geoforge3d/issue/FLY-2266/cmux-先于全舰重启时v2-lead-面板会全体孤儿且无自愈-昨夜-1115-冻结-12h45m-无人发现潜伏缺口非每日发作)
日期: 2026-09-04
基于: exploration.md

## 1. 要回答的问题

1. 仓内是否已经存在不依赖画面文字的 Lead 面板存活判据？
2. 为什么 Tadashi 的格子重连失败后没有告警？
3. 怎样用最少代码证明“先重启 cmux、再全舰重启”的差异会被报告？

## 2. 当前实现证据

### 2.1 名册与目标地址是权威数据

`scripts/flywheel-cmux-sync.sh` 的 `derive_lead_roster()` 只在全部已加载 Lead plist、manifest、carrier 与规范 socket 校验通过后发布 `LEAD_ROSTER_ROWS`。v2 Claude 行格式为：

```text
claude-private|com.flywheel.lead.<slug>|<project>-<lead>|<canonical-private-socket>
```

因此期望数量可以直接数 `carrier=claude-private` 的名册行；无需数侧边栏标题，也无需读屏。

### 2.2 已有非画面 liveness oracle

`_private_session_client_count(socket)` 的合同：

1. `tmux -S <socket> has-session -t '=main'` 必须成功；
2. `tmux -S <socket> list-clients -t '=main' -F '#{client_name}'` 必须成功；
3. 返回客户端行数。

`_v2_lead_heal_surface()` 只把 `clients > 0` 判为 healthy。屏幕内容只在 `clients == 0` 后参与“是否能安全 send 重连命令”的分类，不能把残影升级成 healthy。这个结构正好满足 issue 要求的不看画面判据。

### 2.3 静默路径是一个明确分支

`recover_attach_surface()` 的 `bare` 分支先持久化每次尝试，再执行最多三次受 guard 保护的 `cmux send`。下一次仍是 bare 且额度耗尽时：

```text
phase=dead
status=连接失效 · 点击重连
return 0
```

这里没有任何告警调用。相比之下：

- `exited|empty|no-pty` 终局调用 `_report_dead_attach_surface()`；
- `unclassified` 连续两轮后调用 `_alert_cmux_cleanup()`；
- `missing` 至少由 `reconcile_lead_roster()` 的 `lead-window-missing` episode 覆盖底层 session 缺失。

所以 clean bare-shell 恰好是 preserve-for-manual 终局中唯一的静默洞，和事故“面板掉回空 shell，三次没接上，之后无人知道”一致。

### 2.4 已有可复用 episode 机制

`roster_alert_unhealthy(kind, subject, ...)` 与 `roster_mark_healthy(kind, subject)` 使用 `ROSTER_EPISODE_STATE` 保存 `kind|subject|episode|healthy|unhealthy`。它已经覆盖 Lead 窗缺失与 Runner orphan，具备：

- 同一故障 episode 只报一次；
- 恢复后重新武装；
- 再次发生时 signature 带递增 episode，避免下游 durable dedup 吞掉复发。

因此不应新建状态文件或告警器。新增 subject kind `lead-attach-missing` 即可。

## 3. 方案裁决

### 方案 A：补齐 dead 分支告警 + 整轮 census（采用）

- `recover_attach_surface()`：仅当 `kind=v2` 且 bare 重连额度已经耗尽时调用 `roster_alert_unhealthy lead-attach-missing <title>`。
- `_v2_lead_heal_surface()`：当规范 socket 的 `main` 客户端数重新大于 0 时调用 `roster_mark_healthy lead-attach-missing <title>`。
- `reconcile_v2_lead_workspaces()`：每轮遍历后用同一个客户端计数统计 `expected/attached/missing`，输出单行 census；读取失败不得计作 attached。

优点：复用现有 oracle、重试 debounce、episode 状态与 alert 通道；不增加后台任务、依赖或 mutation。

### 方案 B：按画面底行或 Lead 名称判断（否决）

残影会保留 Lead 名称、状态栏和旧 context；这是事故已经证伪的尺子。画面只可决定能否安全注入，不可证明连接健康。

### 方案 C：新增独立 watcher/数据库/Bridge API（否决）

现有 60 秒 reconcile 已拥有完整名册、socket 与 alert 通道。新子系统会复制权威数据与生命周期，违反 Ponytail，且不能比在现有循环末尾对账更直接。

### 方案 D：M≠N 首轮立刻告警（否决）

全舰重启的正常窗口会短暂出现 0 client。直接报警会把预期重连过程变成噪音。已有三次持久重试预算正是合适的 debounce；只有预算耗尽的终局需要主动发声。census 日志仍会逐轮提供即时事实。

## 4. TDD 尺子

新增一个 hermetic shell test，source 生产脚本并替换 tmux/cmux 外部边界。场景严格按 issue 顺序：

1. cmux 先重启：两个 v2 workspace 都有私有 socket client，census 为 `expected=2 attached=2 missing=none`；
2. 全舰重启：两个新 server 的 client 数归零，surface 模拟保留旧 Lead 内容但底行是 bare shell；
3. 三轮有界 send 后，A 恢复到一个 client，B 仍为零；
4. B 下一轮进入 dead，断言：
   - census 精确为 `expected=2 attached=1 missing=demo-b-lead`；
   - `lead-attach-missing|demo-b-lead|e1` 只告警一次；
   - alert body 点名失败 Lead；
5. B 恢复后再次耗尽，断言出现 `e2`，证明复发不会被永久 dedup。

为了防假绿，测试还必须有三个对照：

- A 的正 client 必须被计入 attached；
- B 的屏幕即使含旧 Lead 名称，只要 client 为 0 就不得计入 attached；
- client 查询失败不得被解释为 attached。

## 5. 验收与边界

实现节点只做 hermetic 回归与现有相关 shell suites，不重启生产服务。独立 QA 应在隔离/受控环境执行真实顺序，并观察：

- 正常重连最终 census `N/N`；
- 故意阻断一格时 census `N/(N-1)` 且 missing 精确点名；
- 预算耗尽后 alert 通道收到一次 episode；
- screen 仍显示旧 Lead 名时结论不改变。

不在本单修改 cmux 重连算法、Lead 生命周期或 codex-tui 的共享 tmux carrier。这里修的是 `claude-private` v2 direct-attach 路径的可观测性。
