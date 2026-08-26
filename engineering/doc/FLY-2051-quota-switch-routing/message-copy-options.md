# FLY-2051 切号通知按 kind 路由 — 文案方案
Issue: FLY-2051 (https://linear.app/geoforge3d/issue/FLY-2051/quota-monitor路由-claude-切号通知改发-flywheel-notification切号家族-per-kind)
日期: 2026-08-25
基于: qa-evidence.md

## Founder 定稿

Founder 先选定 A，随后要求把账号 email 改为 profile `identity-anchor.json` 真值，并将配额改成 Discord 等宽表格：窗口、用量、剩余、下次重置四列。最终使用 Discord 普通消息：不走 alert box，不显示 `info / lead / kind`，不带告警标题或 ticket header；`account_switched` / `account_switch_degraded` 保留真实 founder mention。

### A — 最终正文

~~~text
<@founder> Claude 已自动切号：**shopping → school**

原账号 **shopping**
xrliannie.shopping@gmail.com
```text
window  used   left   reset (PT)
5h      91%    9%     08-25 Tue 17:00
7d      74%    26%    08-31 Mon 08:00
Fable   92%    8%     08-30 Sun 08:00
```

新账号 **school**
xiaorongli2011@u.northwestern.edu
```text
window  used   left   reset (PT)
5h      12%    88%    08-25 Tue 19:00
7d      8%     92%    09-01 Tue 08:00
Fable   12%    88%    08-31 Mon 08:00
```
~~~

`account_switch_degraded` 在首行后加：“配额读数不完整，已按备用顺序完成切换。”缺失 email 写“邮箱暂时未读到”；对齐块内只允许 printable ASCII，缺失 quota / reset 在对应单元格写 `n/a`，尚未开始的 reset 写 `not started`，不猜值。

## pane revive 状态不进通知

Founder 终裁删除 blocked-session / continue / pending / login-expired 整段。daemon 仍照常执行 revive，
但 `account_switched` / `account_switch_degraded` 正文不呈现任何 pane revive 状态；通知只保留切号事实、
原账号表和新账号表。

原 B / C 方案因 founder 已选 A 而作废，不再进入实现。
