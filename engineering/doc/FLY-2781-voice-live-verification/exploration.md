# FLY-2781 语音上线验证 — 探索

Issue: FLY-2781 (https://linear.app/geoforge3d/issue/FLY-2781/语音上线验证-fly-2655-已随-9-22-1224-pt-班车部署codex-1651-pt)
日期: 2026-09-22
基于: 无

## 要回答的问题

founder 问「语音我什么时候可以去用」。工单要求：先真跑一场 rg 会话（bot 入房 → 收到说话 → 回话 → ≥60 秒 → 正常结束落账），再告诉她能不能用。

## 探索结论：工单要求的那场会话，在她不在场时物理上跑不出来

不是故障，是设计。三处源码把这条路封死：

1. `packages/voice-codex/src/discord-room.ts:222` — 在房判定只认 founder 本人的 Discord user id，并且显式排除 bot：
   `if (event.userId !== this.options.founderUserId || event.isBot) return;`
   `start()` 返回的 `founderPresent` 同样只查 `founderUserId`（同文件 231–236 行）。
2. `packages/voice-codex/src/daemon.ts:537` — `presenceGraceMs`（默认 120 秒，`config.ts:180`）内没等到 founder，直接 `outcome = { kind: "failed", reason: "no_human" }`，永远进不了 `live`。
3. `founderUserId` 来自 Bridge projection，源头是 `config.discordOwnerUserId`（`plugin.ts:3107`）= 环境变量 `DISCORD_OWNER_USER_ID` = Annie 本人。

所以「用合成音频注入」也救不了 —— 注入方必然是一个 bot，`event.isBot` 这一关就被挡掉，它既不能让会话 live，也不能被当成在场的人。

## FLY-2655 QA 当时是怎么做的（查过了，不能照搬到生产）

`scripts/qa/fly2655-voice-room.mjs` + `scripts/lib/fly2655-voice-fixture.mjs`：跑在 `/tmp/flywheel-test-slot-N` 隔离槽里，用独立 QA bot、独立 QA 语音频道、独立的 `voice-host.json`，fixture 允许把 `founderUserId` 设成一个 QA bot id。

关键一行（`fly2655-voice-fixture.mjs:75`）：
```js
check(voiceChannelId !== PRODUCTION_GENERAL_VOICE_CHANNEL_ID, "production_general_rejected");
```
它**显式拒绝**生产 General 频道。也就是说这套工装验的是代码，不是生产 bot / 生产房 / 生产配置。

生产的 `~/.flywheel/voice-host.json` 当前是 `{"schemaVersion": 1}` —— `qaAllowUserIds` 和 `qaVoiceChannelIds` 都是空的。要让 QA bot 在生产房里被听见就得改这个文件，而工单明确禁止「动语音配置」。

## 另一处冲突

`packages/teamlead/src/bridge/voice-session-provisioner.ts:386` — 开会话会新建 Discord thread 并把 founder 加进去，也就是必然推送给她。这和工单里「在不打扰 founder 的前提下」直接冲突。

## Lead 裁决

问题 f1854234-7069-46f4-91a2-ce1126a4f9d7。Lead 选 A：不开生产会话，只做零噪声探针 + 给 founder 一页报告 + 她本人的 90 秒自助验收清单。追加两项探针：
- ① OpenAI Realtime 只握手、不发音频；
- ② 确认 raya 的 Codex 号身份、额度、最近一次成功 turn（隔离读法，不切 profile，不往 #raya 发消息）。
B（开生产会话）和 C（搭隔离槽）都不做。

## 顺带修正工单的一处前提

工单写「语音的『脑子』走 Codex，9-22 白天 Codex 全号打满」。源码不是这样：
- 耳朵和嘴走 `OPENAI_API_KEY` 直连 `wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5`（`packages/voice-codex/src/config.ts:119`、`realtime-transport.ts:3`）—— 平台 API，不是 Codex 订阅。
- Codex 订阅那一段是 raya 作为 Lead 生成回复内容的部分。所以 Codex 打满只影响「她说什么」，不影响「她听不听得见、出不出声」。
