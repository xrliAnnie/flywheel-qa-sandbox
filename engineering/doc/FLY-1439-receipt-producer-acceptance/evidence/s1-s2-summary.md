# FLY-1439 插件收据 producer 真机验收 — S1/S2 证据摘要
Issue: FLY-1439 (https://linear.app/geoforge3d/issue/FLY-1439/qafly-1437-独立真机验收-插件收据核销-producerfork-pr-17-bb0a1509)
日期: 2026-07-23
基于: plan.md

## 结论

S1 与 S2 的有效运行全部通过。所有有效 test root 已到 `processed`，随后等待一个
P1 窗口，三个 S2 root 的 resend child 与 receipt alert 均为 0。

## S1 全周期与 patrol

- M1 `1529794572199133256` 真 Discord 入站后建立 canonical root，
  `created_at=10:17:28.221Z`、`delivered_at=10:17:28.674Z`。
- 真模型 Lead 回复 `1529794587093237810`，Discord
  `message_reference.message_id` 精确指向 M1；root 在
  `10:17:32.021Z` 以 `discord_explicit_reply` 处理。
- 自 processed 起等待满 5 分钟至 `10:22:32Z`，resend child=0、alert=0。
- patrol 阳性对照 M2 `990000000000000011` 以真实 CLI 建账并显式注入
  `FLYWHEEL_RECEIPT_WINDOW_P1_MIN=2`；DB 保存的窗口精确为 120 秒。
  patrol 创建 r1 child，真实 inbox adapter 在 `10:35:12.647Z`
  持久确认，`receipt_resend_deliveries` 同时有 logical round 1，
  Lead inbox 字节包含 `⚠️ 第 1 次重发`。随后从真实 Lead pane、
  generation 30 的 lease 执行 harness cleanup，root 到 `processed`。

## S2a begin 崩溃窗

- `fail-begin` 时 M3 `1529799691280187462` 仍真实投递给 Lead；spool
  目录 mode 0700、intent mode 0600，intent `attempts=1`，DB canonical
  row 数为 0。
- 恢复 passthrough 后用真实消息 kick；worker 补 begin、删除 intent、
  以 `[redelivery]` 再投并 complete。M3 root 唯一且 delivered。
- Lead 按消息要求不发 Discord 回复；观察到恢复重投后在真实 pane 以
  lease generation 30 ack，root 到 processed。
- 用 intent 的原始字节再次 begin，返回同一 receipt/seq；canonical row
  仍恰一行且 processed evidence 未变。

## S2b notify→complete 崩溃窗

有效运行 M4 `1529804847509934192`：

- Discord send 与 barrier 监听在同一 Bun 进程内，避免把 timeout 留下的
  stale barrier 当成活窗口。
- `hang-complete` barrier 被观察时仅 5ms 龄；callId
  `f53d2eff-065a-4ff8-b46c-b8bb8ff03a13` 在 shim 账本只有 start，
  DB root 为 external、`delivered_at/processed_at` 均为空。
- mode 原子恢复后，barrier→`tmux kill-window` 为 2.788ms，command
  status 0。窗口 `@1284` / pane `24056` 被 supervisor 重建为
  `@1287` / pane `38879`，MCP 从 pid `36220` 变为 `48216`，
  launcher 有 restart #4。
- 新 MCP 以 `[redelivery]` 重投并补 complete；
  `delivered_at=10:59:11.565Z`。Lead 不回复 Discord，在真实 pane
  generation 33 ack，`processed_at=10:59:23.745Z`。
- Discord API 上 M4 reply-reference 集合为空；barrier 与 shim pid
  在收尾后均无残留。

## S2c settle write-ahead 崩溃窗

M5 `1529806006593261709`：

- begin/complete 后，真模型 Lead 回复 `1529806019893526528`；Discord
  reference 精确指向 M5。
- `hang-settle` barrier 被观察时仅 8ms 龄；kill 快照同时存在
  mode 0600 的 `settle/<M5>.json`，其 replyId 与真回复一致；shim
  call 只有 start；DB 已 delivered 但尚未 processed。
- mode 恢复后 1457ms 内，unsandboxed helper 校验 MCP pid `48216`
  的完整 pinned script path并发送 SIGKILL；证明旧 MCP 已死后才杀窗口。
  supervisor 重建 `@1291` / MCP pid `60410`，launcher 有 restart #5。
- 新 MCP 的 settle drain 把 root 处理为原 reply evidence并删除 intent。
  用相同 replyId 再次 settle 返回 processed=true，canonical row 恰一，
  `processed_at/evidence` 字节不变。
- exact shim pid `35418` 的收尾探测已显示目标不存在；之后才移走 runtime
  barrier。spool、settle 与 barrier 均无残留。

## Harness invalid 运行（不计产品 verdict）

S1 初次 synthetic patrol control 未给 direct CLI 传 2 分钟 env，得到默认
30 分钟；该 root 被标记为 setup-invalid并从真实 Lead pane清理。随后发现
Bridge 若从受管 Codex shell 派生，其真实 Claude inbox lock 写入会被 sandbox
拒绝；只重启隔离 slot Bridge 到 tmux 后，真实 adapter delivery 与
`receipt_resend_deliveries` 均恢复，Lead 与 pinned plugin 没有重启。

S2b 的早期 driver 迭代分别缺 timing、超过 2 秒预算、或从 stale barrier
开始计时；每轮都按 `HARNESS INVALID` 丢弃，root 逐一关闭。最终有效运行使用
`s2b-discord-crash.ts` 同进程 send+monitor，并同时冻结 barrier 自身年龄，
所以有效证据不依赖这些早期运行。
