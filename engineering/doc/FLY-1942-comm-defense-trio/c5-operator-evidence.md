# FLY-1942 通信层防线三件套 — C5 查询与退订证据
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: plan.md

此记录仅覆盖 C5 的 operator socket / CLI 部分。账本状态机、TTL、恢复时序、运行时接线与 launcher 另验。

- Socket 新增 v2 `listSubscriptions` / `unsubscribeThread`；沿用同一 HMAC、Lead 绑定与 Unix socket。仅接受声明字段、合法 snowflake、非空 reason；退订 actor 固定 `cli`；不调用 router.submitBatch。
- CLI `list|unsubscribe --project <p> --lead <id> [--thread <id>] [--reason <r>] [--json]`。项目/Lead 精确选择；state dir 同 `resolveCodexLeadStateDir`；secret 同 `lead.botToken ?? DISCORD_BOT_TOKEN`。
- list 只调用无副作用 parser，标记 active/expired。missing ledger 列空；corrupt 返回 4 且原文件/目录不变；缺 secret 返回 2；socket 不存在返回 3；CLI 从不写账本。

RED：新增 socket 测试因 client 方法不存在失败；新增 CLI 测试因模块不存在失败。日志 `/tmp/fly1942-sub-socket-red.log`、`/tmp/fly1942-sub-cli-red.log`。

GREEN：`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/codex-lead-subscriptions-cli.test.ts src/lead-backends/codex/__tests__/CodexLeadInboxSocket-subscriptions.test.ts src/lead-backends/codex/__tests__/CodexLeadInboxSocket.test.ts`，3 文件 17 项通过。日志 `/tmp/fly1942-c5-operator-tests.log`。

包括真实临时 Unix socket 请求、备用 secret 的 CLI→server 退订、错误 secret/Lead/线程拒绝；原 submitBatch/capabilities 10 项回归通过。CLI 读取测试比较原始文件字节与目录清单，证明确实没有 quarantine/rewrite。

上述不是活 Codex Lead 的生产订阅回放，也不代表 C5 整体或全仓门禁已通过。

补充集成回归：真实 socket `submitBatch` → LeadInputRouter → wiring.onInputAccepted；accepted_new 将 TTL 从 1100 推到 1150，重复批次不续期，下一批 disk-full 时接受输入但内存 TTL 与原始账本字节保持不变。此项为整合回归，未记作初始 RED。
