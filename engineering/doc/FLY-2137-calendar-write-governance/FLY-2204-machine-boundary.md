# FLY-2137 日历写治理 — FLY-2204 机器边界回链
Issue: FLY-2204 (https://linear.app/geoforge3d/issue/FLY-2204/治理-隔离-founder-google-calendar-写凭据agent-上下文不可读)
日期: 2026-08-31
基于: ../FLY-2204-calendar-cred-isolation/implementation.md

FLY-2137 的 P6 仍是行为护栏，不单独构成对抗性授权边界。其 blocking follow-up FLY-2204 已交付
A/I/W 三 uid、独立 writer caller、PEERCRED、OAuth scope/revoke probe、QA calendar 配置和 root
installer 的代码与 fixture 证据。

当前不得把 FLY-2137 描述为「机器已保证唯一自动写入方」：A/B credential identity 尚待 founder
裁决，生产用户/组、LaunchDaemon、grant、ACL 与冷启动/正路 live gate 均未执行。唯一允许的完成条件是
FLY-2204 `runbook.md` Final gate 同时证明：

- 旧 grant `invalid_grant/401`；
- A 域 current gog/gws 有效但 Calendar 写不足；
- A 读不到 W/I credentials 且不能 connect writer；
- I 是 W 唯一 peer，生产 ingress 只接受 founder human principal；
- QA 只写独立测试日历；
- FLY-2130 create/cancel、冷启动恢复、sweep 独立 readonly client 全绿。

live gate 完成后，应在本文件追加经过独立 QA 复核的 evidence receipt/PR SHA；不得回填 token bytes、
client secret、keyring password 或 Discord token。
