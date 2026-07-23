# FLY-1439 插件收据 producer 真机验收 — G0 门禁证据
Issue: FLY-1439 (https://linear.app/geoforge3d/issue/FLY-1439/qafly-1437-独立真机验收-插件收据核销-producerfork-pr-17-bb0a1509)
日期: 2026-07-23
基于: plan.md

## 结论

G0.1–G0.3 已通过；G0.4 的生产前快照已冻结，生产后快照按计划在
teardown 后拍摄并逐字节比较。可以进入 S1–S5。

## G0.1 隔离插件字节

- pinned checkout HEAD:
  `bb0a150989c0d7477bbb03543052c87ee229d368`。
- 真 MCP 进程 argv 指向
  `/tmp/flywheel-test-slot-1/claude-config/plugins/cache/.../server.ts`；
  没有生产插件路径。
- 隔离 `installed_plugins.json` 与 `known_marketplaces.json` 的插件路径均在
  `/tmp/flywheel-test-slot-1/claude-config/` 下。
- pinned source 与真运行 cache 的 30 个受控文件 SHA-256 manifest
  `diff` 为空。
- Lead/plugin 日志没有 `CHAT RECEIPT WIRING BROKEN`。

证据：`g0.1-mcp-process.txt`、`g0.1-config-paths.json`、
`g0.1-source-manifest.sha256`、`g0.1-runtime-manifest.sha256`、
`g0.1-manifest.diff`。

## G0.2 shim 透明

- direct 根 `990000000000000001` 与 shim passthrough 根
  `990000000000000002` 均唯一，且状态均为
  `external -> delivered -> processed`，无 resend child。
- shim 的 begin / complete / settle 三次调用各有且仅有
  `start,end`，三次 exit 均为 0。

证据：`g0.2-direct-output.jsonl`、`g0.2-shim-output.jsonl`、
`g0.2-db-rows.json`、`g0.2-shim-ledger.jsonl`、
`g0.2-ledger-pairs.json`。

## G0.3 真 Discord gate

- driver bot `1493072948683341976` 发出真消息
  `1529793610114007142`。
- 真模型 Lead bot `1493068669444427927` 发出回复
  `1529793659070058527`；Discord API 返回的
  `message_reference.message_id` 精确等于入站消息 id。
- comm.db 根行已 `delivered` 且 `processed`；
  `processed_evidence.kind=discord_explicit_reply`，fence 精确指向入站消息。

证据：`g0.3-inbound.json`、`g0.3-reply.json`、`g0.3-db-row.json`。

## G0.4 生产零写前置

`g0.4-production-pre.txt` 冻结生产插件配置、active cache / marketplace
server 与 `.fork-sha`、生产 fork repo HEAD / status、delivery marker /
secret 文件内容 hash 与 mode。后快照必须逐字节相同，否则最终 verdict
不能为 PASS。
