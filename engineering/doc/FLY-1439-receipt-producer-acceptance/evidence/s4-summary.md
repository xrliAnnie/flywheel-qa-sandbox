# FLY-1439 插件收据 producer 真机验收 — S4 证据摘要
Issue: FLY-1439 (https://linear.app/geoforge3d/issue/FLY-1439/qafly-1437-独立真机验收-插件收据核销-producerfork-pr-17-bb0a1509)
日期: 2026-07-23
基于: plan.md

## 结论

S4 companion=true 真机通过：Discord channel 收发保持正常，receipt producer
静默不适用，comm.db、shim 与 companion spool 均零行为。stock 形态按批准计划
不另起真机，将在 S5 用 fork-main byte-compat 快照与 mutation 探针覆盖。

## 生命周期与身份

- 标准 Lead supervisor PID `83816` 先收到 TERM；30 秒后 helper 精确升级，
  确认 PID 死亡，再精确关闭遗留 window `@1291`，满足单 listener。
- 固定 session-id 与 manifest 在 companion 注入前由带 EXIT/INT/TERM trap
  的 guard 原子移出；标准文件 SHA-256 分别为
  `a9a2793c…` 与 `e998de0f…`。
- companion 使用同一 launcher、同一隔离 `CLAUDE_CONFIG_DIR`、专属
  workspace 与 `discord-state-companion`。launcher 明确记录
  `Role: companion`、受守卫的 isolated fork-check skip、`restart #1 Fresh
  start`，没有 `Resuming`。
- pane 白名单证据为 `FLYWHEEL_LEAD_COMPANION=1`、
  `CLAUDE_CONFIG_DIR=/tmp/flywheel-test-slot-1/claude-config` 与专属 state dir。
  expected-config 变量只在 launcher 判定阶段消费、不传进 pane；其逐字相等由
  只有 flag + expected + actual 三者匹配才可能出现的 QA skip log 证明。
- companion supervisor PID `13301` 和 MCP PID `20134` 单实例运行；结束时
  同样 exact TERM→升级确认并关闭遗留 window `@1299`。guard 保存 companion
  state 后恢复标准 session/manifest，复核 SHA-256 与注入前逐字一致。

## M9 真消息与零 receipt delta

- 有效入站 M9 `1529811809945649152` 被 companion pane 接收。
- 真 Lead 回复 `1529811847467892797`，Discord
  `message_reference.message_id` 精确指向 M9。
- M9 前后 `chat:flywheel-test-1:*` 总行数保持 22、`max(seq)` 保持 24；
  M9 exact canonical id 行数为 0。
- shim 账本中包含 M9 id 的调用为 `[]`；companion state dir 前后都只有
  mode 0600 的脱敏 `access.json`，未出现 spool/settle intent。
- Discord/API、launcher log 与 transcript scan 均无 receipt advisory、
  `CHAT RECEIPT WIRING BROKEN` 或伪收据。

## Harness invalid（不计产品 verdict）

首次 probe `1529811294713024625` 的初版最小 access 文件仅带
`allowBots`，漏了 guild channel 的 `groups` subscription，所以 access gate
按设计静默 drop，既无 pane delivery 也无 reply/receipt。补上
`groups[channel]={requireMention:false,allowFrom:[]}` 后才运行有效 M9；启动脚本
已固化完整最小结构。
