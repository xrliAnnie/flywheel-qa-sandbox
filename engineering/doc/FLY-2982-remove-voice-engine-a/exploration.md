# FLY-2982 删除旧语音引擎 A — 探索
Issue: FLY-2982 (https://linear.app/geoforge3d/issue/FLY-2982/语音-删除旧语音引擎-abwebrtc-订阅-语音大脑成为唯一引擎写好马上合)
日期: 2026-09-27
基于: 无

## 0. 一句话

引擎 A = `packages/voice-codex` 里的 `openai-realtime` 后端(`RealtimeFrontend` 直连 `wss://api.openai.com/v1/realtime`,`gpt-realtime-1.5`,靠平台 `OPENAI_API_KEY` 计费,声线字段 `realtimeVoice`)。
引擎 B = 同一个守护进程里的 `codex-realtime` 后端(`src/codex/*`,codex app-server 0.156.1 + WebRTC + ChatGPT 订阅,声线字段 `liveVoice`,FLY-2885 已合入)。
两者共用一个守护进程、一个房间层(`discord-room.ts`)、一个会话层(`session.ts`),靠环境变量 `FLYWHEEL_VOICE_BACKEND` 选择。

## 1. 生产现状(2026-09-27 实测,只读)

| 事实 | 取证 |
|---|---|
| 生产 `~/.flywheel/.env` **没有** `FLYWHEEL_VOICE_BACKEND`,有 `OPENAI_API_KEY` | `grep -c` 只看变量名 |
| `config.ts:198` 缺省值是 `"openai-realtime"` ⇒ **今天生产跑的是 A** | 源码 |
| launchd `com.flywheel.voice` → `scripts/flywheel-voice-wrapper.sh` → `packages/voice-codex/dist/cli.js`;plist 与安装脚本都不设该变量 | plist / `install-voice-launchd.sh` |
| B 的前置都在:`~/.codex-infra-bot/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex` 是可执行普通文件;`~/.codex/auth.json` 是本用户 0600 普通文件 | `ls -la` |
| `~/.flywheel/projects.json` 17 个 Lead 全带 `realtimeVoice`(15 个 marin,eng-lead verse,product-lead alloy);8 个没有 `liveVoice`(缺省 cove);没有任何 `huddle` 块 | 只读解析 |
| `voice_sessions` 表没有引擎/后端列;历史行的 `end_reason` 可能是 `realtime_capacity`(只有 A 会报) | `StateStore.ts:11422-11458`、`:5867-5872` |
| 插件缓存 `~/.claude/plugins/cache/*/` 22 个根全部可读,零命中 `openai-realtime` / `realtimeVoice` / `FLYWHEEL_VOICE_BACKEND` | 子代理扫描 |
| `~/Library/LaunchAgents/com.xrli.raya.voice.plist` 指向 Raya 自己仓库 `~/.flywheel/raya/code/apps/voice`,未加载,不在本仓 | plist |

⇒ **删掉 A 等于把生产语音在下一次部署时切到 B。** founder 已接受「A 删掉到 2886 上线之间没有(可用的)语音」。

## 2. 引擎 A 盘点清单

分类:**删** = 只为 A 存在;**改** = A/B 共用,只剪掉 A 分支;**留** = 共用或与引擎无关;**史** = 历史文档,不动。
「2886」列 = FLY-2886(PR #1360,`origin/flywheel-FLY-2886` @ `6ed39eb4`)也改了这个文件。

### 2.1 packages/voice-codex(守护进程)

| 位置 | 内容 | 分类 | 2886 |
|---|---|---|---|
| `src/realtime.ts` `RealtimeFrontend`、`isApprovedRealtimeModel`、`buildFrontendPrompt` 等(1165 行) | A 的前台实现 | **删**(文件里只留共用类型 `RealtimeAudioOwner`,见 research §2) | 否 |
| `src/realtime.ts:57-61` `RealtimeAudioOwner` | 纯数据形状 `{utteranceId, ownerUserId, ownerName}`,被 `session.ts`、`discord-room.ts`、`codex/CodexRoomFrontend.ts`、`codex/CodexVoiceBackend.ts` 引用 | **留** | 四个引用者都是 2886 文件 |
| `src/realtime-transport.ts` | `OPENAI_REALTIME_URL`、`createRealtimeSocket`(ws + Bearer key) | **删** | 否 |
| `src/config.ts` `backendId`、`realtimeApiKey`、`FLYWHEEL_VOICE_BACKEND` 解析、`OPENAI_API_KEY is required`、`codexBin` 绝对路径检查的 B 条件 | 选择器 + A 凭据 | **改** | 是 |
| `src/cli.ts:180,182,230,422,538-555,574-596,611-616,659` | `backendId` 分支;`RealtimeFrontend` 构造;A 的 `buildDelivery` 抓取分支;`openai_realtime_direct` 证据字段 | **改**(B 分支变无条件) | 是 |
| `src/daemon.ts:33` `VoiceEnd` 里的 `"realtime_capacity"` | 只有 A 报 | **改** | 是 |
| `src/projection.ts:32` `isRealtimeV2Voice(row.realtimeVoice)` 必填校验;`:64` 注释 | A 声线 | **改** | 否 |
| `src/bridge-client.ts:17` `VoiceSessionProjection.realtimeVoice` | A 声线 | **改** | 是 |
| `package.json` `ws`、`@types/ws` | 只有 `realtime.ts` / `realtime-transport.ts` 用 | **删** | 否 |
| `src/__tests__/realtime-transport.test.ts`、`realtime-live.test.ts` | 只测 A | **删** | 否 |
| `src/__tests__/config.test.ts`(`OPENAI_API_KEY is required`、`backendId: "openai-realtime"`、key 夹具) | 混合 | **改** | 是 |
| `src/__tests__/projection.test.ts:12,25,45-48` | `realtimeVoice` 校验 | **改** | 否 |
| `realtimeVoice: "marin"` 夹具行:`codex-readback-replay`、`codex-room-webrtc:398`、`codex-room:608`、`daemon-health`、`daemon`、`qa2701-final-read-race`、`recovery`、`session-state`、`session` | 夹具数据 | **改**(删行) | codex-room / daemon / session 是 |
| `src/__tests__/codex-container.test.ts:340,425` key 清洗断言 | B 的负向守卫 | **留** | 是 |
| `src/speech.ts`、`__tests__/realtime-speech.test.ts` | 共用口语投影(`CodexProofSpeaker`、`SpeechOverrun` 用) | **留** | 否 |
| `__tests__/health-heartbeat-realtime.test.ts` | 「realtime」指墙钟,测共用 `health.ts` | **留** | 否 |
| `src/audio.ts` `WaitingMouth` + `discord-room.ts` `downlink: "pcm-mouth"` | 生产里只有 A 走 pcm-mouth(B 固定 `opus-passthrough`) | **留 + follow-up**(2886 正在扩写 `WaitingMouth`,+157 行) | 是 |
| `src/delivery.ts` `VoiceDelivery` / `journal.ts` / `recovery.ts` / `session-state.ts` | 抓取分支只有 A 用;恢复路径重放磁盘上 A 遗留的 journal | **留 + follow-up**(2886 给 journal 加 `close_snapshot`) | journal 是 |

### 2.2 packages/teamlead(Bridge)

| 位置 | 内容 | 分类 | 2886 |
|---|---|---|---|
| `src/realtime-voices.ts:1-18` `REALTIME_V2_VOICES` / `RealtimeV2Voice` / `isRealtimeV2Voice`;`:22` 注释 | A 声线表 | **删**(留 `LIVE_V3_VOICES` 等) | 否 |
| `src/ProjectConfig.ts:16,19,240-241,244,713-719` | `realtimeVoice` 字段与加载校验 | **改** | 否 |
| `src/bridge/voice-session-services.ts:257-258` | 投影里 `realtimeVoice: lead.realtimeVoice ?? "marin"` | **改** | 是 |
| `src/StateStore.ts:5871` `daemonEndReasons` 里 `"realtime_capacity"` | 只有 A 报;只是转移准入表,不是 CHECK 约束 | **改** | 否 |
| 测试:`huddle-config.test.ts:97-181`(v2 声线)、`voice-session-services.test.ts:240-273`、`StateStore.voice-session.test.ts:266,690`、`voice-session-start.test.ts:57`、`voice-session-routes.test.ts:401-402` | A 断言 / 夹具 | **改** | services / StateStore.voice-session 是 |
| `src/bridge/voice-session-context.ts` `realtimePrompt` | B 的 `CodexVoiceContainer` 在用 | **留** | 是 |

### 2.3 packages/voice-core、config

| 位置 | 内容 | 分类 | 2886 |
|---|---|---|---|
| `voice-core/src/types.ts:160` `VoiceBackend.id` 联合里的 `"openai-realtime"` | A 名字 | **改**(删字面量) | 是 |
| `config/src/feature-flags/truth.ts:411-412` `FLYWHEEL_VOICE_BACKEND` 登记 | 选择器登记 | **删** | 否 |

### 2.4 scripts/

| 位置 | 内容 | 分类 |
|---|---|---|
| `scripts/check-voice-api-auth-local.mjs` | 离线 A 协议回执;**零调用者**(CI、脚本、包都不引用) | **删** |
| `scripts/flywheel-voice-wrapper.sh:23,69-85,95,213` | `voice_api_key_unset`、`elif` 缺 key 分支、B 检查的 `== codex-realtime` 条件 | **改**(B 检查无条件) |
| `scripts/__tests__/flywheel-voice-wrapper.test.sh:100,144,238-251,289,307,358` | A 缺省夹具、缺 key 用例、`FLYWHEEL_VOICE_BACKEND=codex-realtime` 夹具 | **改 / 删** |
| `scripts/voice-host-configure.mjs:42-53,192-193,198` | v2 声线副本、`invalid_realtime_voice`、`lead.realtimeVoice ??= "marin"` | **改** |
| `scripts/__tests__/voice-host-configure.test.mjs:69,131-132` | `realtimeVoice` 夹具/断言 | **改** |
| `scripts/qa/fly2655-voice-room.mjs:142-146,382-400,423-461,726-735` | `readManagedOpenAiKey`、`openAiApiKey`、`codexBackendRequested` 可选 | **改**(只留 B) |
| `scripts/__tests__/fly2655-voice-room.test.mjs:441,477,513-519` | A 环境形状 | **改 / 删** |
| `scripts/qa/fly2799-codex-container.mjs:340`、`__tests__/fly2799-codex-container.test.mjs:160-179` | 向子进程设 `FLYWHEEL_VOICE_BACKEND`、`openAiApiKey` 缺省路径 | **改** |
| `scripts/test-deploy.sh:1678-1682` | Bridge 环境里清掉 `OPENAI_API_KEY`(机密卫生) | **留**(只改注释) |
| `scripts/qa/fly2799-codex-container.mjs:136` `gpt-realtime-2.1` | B 的 v2 钉版清单,不是 A | **留** |

### 2.5 其他

| 位置 | 分类 |
|---|---|
| `engineering/spike/FLY-968-voice-bakeoff/s2-openai-text-out.mjs`、`s3-openai-basics.mjs`(A 的早期直连原型) | **删**(同目录 `s2b-edge-tts-firstbyte.mjs` + `lib/events.mjs` 与 A 无关,留) |
| CI `.github/workflows/ci.yml`、`scripts/__tests__/ci-structure.test.sh`、`claude-runner/test/fixtures/kill-path-inventory.json` | 不点名任何 A 文件 ⇒ 不改 |
| `engineering/doc/**`、`doc/**`、`product/doc/**`(约 120 个文件) | **史** |

### 2.6 issue 点名的旧入口(与引擎无关)

| 入口 | 现状 | 结论 |
|---|---|---|
| `huddle` | FLY-2860 已删 huddle 守护进程;剩下的是负向守卫 `legacy_voice_conflict`(`ProjectConfig.ts:340`、`voice-session-preflight.ts:99`、`voice-session-services.ts:146`、`voice-session-start.ts:111`、`voice-codex/config.ts:356`、`voice-host-configure.mjs:181` 等) | **留**:守卫拒绝复活的旧配置,不是入口 |
| CoS `voiceIntent` | `raya-cos` 的 `voice-intent` 命令(接的是 `createUnavailablePorts`)与 `teamlead/cos-ports/voice-intent.ts`,都打通用的 `/api/voice/sessions`,不认引擎 | **留**:与引擎无关;Lead 规则已禁用 |
| voice master | 只出现在 Lead 规则的禁令里(`department-lead-rules.md:187-196`,`lead-rules-bundle.test.ts:183` 断言这句话) | **留** |
| gemini / eleven / glaw | 只剩 FLY-2860 墓碑(`retired-outputs.json`、`retire-legacy-voice.*`) | **留** |
| `codex-lead-runtime.ts:1415-1454` `voiceProfile.openAiApiKey` | B 在 FLY-2885 前的 API-key 模式,**零调用者**,不是 A | **留 + follow-up**(死代码,按 CLAUDE.md 只列不删) |

## 3. 挂在 A 上的 Linear 单(交 Lead 逐张处理,本单不实现)

| 单 | 状态 | 与 A 的关系 | 建议 |
|---|---|---|---|
| FLY-2863 · PR #1314 | In Progress | 分支在 `voice-codex/cli.ts` 两处用 `realtimeVoice`、import `RealtimeFrontend`,另走 `api.openai.com` 朗读端点 | 关 PR,按 B 重开;内容并入 FLY-2888(其标题已写「挪 2796 / 2863 可用」) |
| FLY-1451 EPIC | In Progress | 9-25 已写「引擎 A 整条线不做」 | 更新 Epic 文字:A 已删(本单) |
| FLY-2021 | Backlog | 「codex v3 WebRTC 握手被拒」— FLY-2885 已在 0.156.1 上打通 | 关闭(已被 2885 解决) |
| FLY-1172、FLY-963 | Backlog | Gemini Live 时代的观测/转写单,FLY-2860 已退役 Gemini | 关闭(过时) |
| FLY-2796 | Canceled | 「A、B 两个引擎都能用」的耳机模式 | 已取消,无动作 |
| FLY-2730 | Backlog | 房间层 DAVE 诊断,B 共用 | 不受影响 |
| FLY-2886 / 2887 / 2888 / 2963 | — | 都是 B | 不受影响 |

查询方式:Linear GraphQL,未完成单按标题(语音/voice/引擎/realtime/huddle/会议/耳机)与描述(openai-realtime/realtimeVoice/引擎 A/gpt-realtime/voice-codex/耳机模式)两轮过滤。

## 4. 与 FLY-2886(PR #1360)的重叠

2886 改动的非文档文件共 215 个(`git diff --name-status $(merge-base) origin/flywheel-FLY-2886`)。本单**不可避免**要碰的重叠文件:

| 文件 | 本单改动量 | 冲突预期 |
|---|---|---|
| `voice-codex/src/cli.ts` | 剪掉约 6 处 `backendId` 分支和 A 前台构造 | 2886 在同文件新增了 2 处 `config.backendId === "codex-realtime"`;合 main 时这两处要按「永远是 B」解 |
| `voice-codex/src/config.ts` | 删 `backendId` / `realtimeApiKey` / 选择器 | 中 |
| `voice-codex/src/daemon.ts` | 删 1 个联合成员 | 低 |
| `voice-codex/src/bridge-client.ts` | 删 1 个字段 | 低 |
| `voice-core/src/types.ts` | 删 1 个字面量 | 低 |
| `teamlead/src/bridge/voice-session-services.ts` | 删 2 行 | 低 |
| 测试:`config.test.ts`、`daemon.test.ts`、`session.test.ts`、`codex-room.test.ts`、`voice-session-services.test.ts`、`StateStore.voice-session.test.ts` | 删夹具行 / A 用例 | 低 |

**刻意不碰**:`session.ts`、`discord-room.ts`、`codex/CodexRoomFrontend.ts`、`codex/CodexVoiceBackend.ts`(靠保留 `realtime.ts` 里的共用类型)、`audio.ts`、`journal.ts`。
按 issue:本单先合,2886 合 main 时解冲突;PR 附一段「2886 合并指南」。
