# FLY-1446 tmux server 死因取证 — 取证报告

Issue: FLY-1446 (https://linear.app/geoforge3d/issue/FLY-1446/cmux-稳态-retro-修复包-roster-对账-唯一启动者-合并即部署-server-死因-收养竞态去重)
日期: 2026-07-24
基于: research.md、evidence/

## 结论

**现有可读取证据不能把 2026-07-23 的 tmux server 退出归因到某一个确定
killer。** 能钉死的是：

1. 受影响命令访问的是默认 socket
   `/private/tmp/tmux-501/default`，并非从现存 Bridge 原文中可证明的 UUID
   socket。
2. 03:39 PDT 起 Bridge 已连续把多个 runner 标成 monitoring lost，并记录
   `tmux-server-rescue inspect /private/tmp/tmux-501/default` 失败。
3. 04:28:45 PDT，至少两个不同窗口的 `list-panes` / `capture-pane` 同时报
   `server exited unexpectedly`；此后同类错误在当天继续出现。
4. tmux rescue 审计在 00:22:12–09:35:08 PDT 之间没有任何记录，事故 T0
   落在这个空档；因此现存审计不能证明 rescue 触发了退出，也不能证明它在
   事故点完成过恢复。
5. retained zsh history 没有 `kill-server`、`pkill tmux`、`killall tmux`、
   `kill-session` 或 `kill-window` 命中，但该历史无逐行时间戳，也不能排除
   其他进程、其他 shell、未落盘命令或 tmux 自身退出。
6. macOS unified log 是区分 SIGKILL/OOM/正常退出的关键来源，但当前 Runner
   sandbox 明确拒绝读取；没有这条证据就不能诚实声称找到显式 killer 或 OOM。

所以本报告的死因等级是：**indeterminate（证据不足）**。`exit-empty` 连带退出
是一个机制上成立、且当前确实未被防护的高价值候选，但不是已证实的历史结论。

## 时间线

| 时间（PDT） | 证据 | 能证明什么 |
|---|---|---|
| 00:22:12 | rescue audit line 36 | 事故前最后一条 rescue 审计 |
| 03:39:07–03:39:23 | Bridge JSON events | FLY-1413/1436/1364 多个 runner monitoring lost |
| 03:39 后（日志行 1923064，无独立时间戳） | Bridge 原文 | default socket 的 rescue inspect 失败；只能界定在相邻可见事件之后，不能给精确秒 |
| 04:28:45 | Bridge lines 1940811–1940816 | 不同 runner 窗口的 tmux 命令同时收到 `server exited unexpectedly` |
| 09:35:08 | rescue audit line 37 | 事故后下一条 rescue 审计；开始出现大量 ensure/recover |

所有原文、命令与 SHA-256 清单在 `evidence/`。

## 候选死因判定

### 显式 kill：未证实

- 支持：整个 server 级故障与显式 `kill-server`/进程信号相容。
- 反证/缺口：retained shell history 无匹配；unified log 不可读；没有当时 server
  PID 的终止状态。
- 结论：不能确认，也不能排除。

### OOM / jetsam：未证实

- 支持：server 整体消失与外部 SIGKILL 相容。
- 反证/缺口：没有 contemporaneous memory-pressure/jetsam 记录；Bridge 原文只含
  tmux client 错误。
- 结论：不能确认。不得把“server exited”改写成 OOM。

### `exit-empty` 连带退出：机制成立，历史未证实

- 当前真机 `tmux show-options -sv exit-empty` 返回 `on`。
- 取证冻结时的基线 `scripts/lib/tmux-server-rescue.sh` ensure 成功路径既不设置
  server option，也不创建 sentinel session；本单代码随后补上这条防线。
- 因此基线存在“最后一个 session 被移除 → server 正常退出”的无防护窗口。
- 但事故时缺少 session inventory、当时的 `exit-empty` 值及最后一次
  kill-session/kill-window 记录，所以不能把机制可复现性当成历史归因。

## 防复发措施

本单实施以下与历史 killer 无关、覆盖 `exit-empty` 与“最后 session 被清空”类事故的
最小 postcondition：

1. 所有 tmux server ensure 成功出口在同一 rescue socket lock 内执行
   `set-option -s exit-empty off`。
2. 同锁内确保 detached `flywheel-keepalive` sentinel session 存在。
3. policy 前后校验 server PID 未换代；任一步失败都 fail-loud，ensure 不得返回成功。
4. 新增同一锁/receipt/replay 体系内的 `policy-enforce <socket>` 运维入口，用于发布后
   一次性 seed。
5. `FLYWHEEL_TMUX_KEEPALIVE=0` 只停止后续 enforcement，不冒充自动回滚已落入 server
   的持久状态。

隔离真 tmux QA 已验证：enforcement 开启时，policy 前后 server PID 相同、
`exit-empty=off`、删除最后一个业务 session 后同一 PID 仍存活；`=0` 时不建
sentinel，删除最后一个 session 后 server 按旧行为退出。当前 Runner sandbox
禁止 `ps`，所以依赖完整进程枚举的 real-tmux 分类 suite 在本机明确 skip；CI
在具备 `ps` 的 host 上继续执行完整分类与 policy 用例。

如果再次发生，取证必须在 server 被重建前保存：socket inode、server PID、
`show-options -sv exit-empty`、完整 session inventory、最后一次 session/window
mutation receipt，以及 unified log 中该 PID 的 exit/signal/jetsam 记录。
