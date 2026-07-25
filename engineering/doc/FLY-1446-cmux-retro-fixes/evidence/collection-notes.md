# FLY-1446 tmux server 事故证据保全

采集时间: 2026-07-24
采集时区: America/Los_Angeles (UTC-07:00)
事件首个可钉时间 T0: 2026-07-23 04:28:45.564 PDT

## 原始来源

- `/tmp/flywheel-bridge.log`（采集时约 324 MiB，launchd `com.flywheel.bridge`
  的 stdout/stderr；文件本身仍在持续追加）
- `/Users/xiaorongli/.flywheel/logs/tmux-rescue-audit.log`
- `/Users/xiaorongli/.zsh_history`
- macOS unified log（本 Runner sandbox 无读取权限；失败结果保存在
  `system-log-access.txt`）

## 采集命令

```sh
rg -n -i "server exited unexpectedly" /tmp/flywheel-bridge.log
sed -n "1922800,1923300p" /tmp/flywheel-bridge.log
sed -n "1940750,1940900p" /tmp/flywheel-bridge.log
rg -n "^(1784791325|1784791332|1784824508)" \
  /Users/xiaorongli/.flywheel/logs/tmux-rescue-audit.log
rg -n -i \
  "kill-server|pkill.*tmux|killall.*tmux|tmux.*kill-session|tmux.*kill-window" \
  /Users/xiaorongli/.zsh_history
/usr/bin/log show --style syslog \
  --start "2026-07-23 03:55:00" --end "2026-07-23 04:40:00" \
  --predicate '(process == "tmux") OR (eventMessage CONTAINS[c] "tmux")'
```

## 边界

Bridge 日志多数行没有自己的时间戳，所以不能把相邻无时间戳行机械等同于紧邻
JSON 事件的精确时刻。`bridge-timeline-excerpt.log` 只保留能证明的原文和行号；
解释与置信度见 `../server-death-forensics.md`。
