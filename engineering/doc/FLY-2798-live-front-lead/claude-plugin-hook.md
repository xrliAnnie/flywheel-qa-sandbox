# FLY-2798 前台快答与后台 Lead — Claude 插件钩子
Issue: FLY-2798 (https://linear.app/geoforge3d/issue/FLY-2798/语音v4-引擎-a前台快答-后台-lead-在现有通用管道上让实时模型自己答简单的复杂的交给)
日期: 2026-09-24
基于: lead-result-producer-design.md

## 第二 PR 的锁定改动
- 仓库：`claude-plugins-official` 的干净 worktree；不要修改当前脏 clone。
- 位置：`external_plugins/discord/server.ts:1199-1268` 的 `reply(reply_to=...)` 路径。
- 仅当 `reply_to` 严格匹配 `voice-handoff:<uuid>` 时进入 voice 分支；普通 Discord snowflake 路径字节不变。
- 从可信 `FLYWHEEL_PROJECT_NAME`、`FLYWHEEL_LEAD_ID` 与 `reply_to` 构造 canonical `sourceDeliveryId=chat:<leadId>:voice-handoff:<handoffId>`；正文不参与 handoff 匹配。
- voice 分支不调用插件内的 `fetchAllowedChannel`、reply guard、`sendReplyChunks` 或 `ch.send`；改为用 `TEAMLEAD_API_TOKEN` 向 `BRIDGE_URL/api/lead-outbound/send` 发鉴权 POST，复用本 PR 的 producer-first 合同。
- POST 提交 project、Lead、目标 chat channel、正文、canonical `deliveryContext` 与 operation id；Bridge 先 durable commit result，既有 Discord mirror 若启用仍在关键路径之外。
- operation id 固定为 `claude-voice-reply:<sha256(sourceDeliveryId)>`，一次 handoff 只接受一次正文；重放同正文幂等，异正文冲突并 fail closed，绝不按正文生成绑定键。
- Bridge 非 2xx、超时、鉴权缺失、绑定冲突或 producer 失败都返回 MCP `isError=true`；不得静默回落到 Discord 直发。
- 测试覆盖 voice 正路、重放、异正文冲突、错 Lead、畸形 uuid、Bridge 失败零 Discord side effect，以及普通 Discord reply 回归。

## 合入门槛
本 issue 的 Done 需要主仓 PR 与上述插件 PR 都合入；第一 PR 可先进入 Raya/Codex QA，插件 PR 由 Lead 在第一 PR/QA 后另行派发。
