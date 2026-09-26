# FLY-2860 删除三套旧语音命令 — 调研
Issue: FLY-2860 (https://linear.app/geoforge3d/issue/FLY-2860/语音清理-删掉-geminigeminigemini-advancedelevenlabseleven与-glaw)
日期: 2026-09-25
基于: exploration.md

## 1. 调研方法

1. 把 `origin/main`、#1306（FLY-2799 头 4eec26461）、#1309（FLY-2796 头 96915fd36）、#1312（FLY-2798 头 dc859fcc3）四棵树用 `git archive` 导出，分别跑同一个引用图脚本。Lead 裁定的基线是 **main + #1306**（下文数字均出自 `graph-1306`），另外三棵用来验证「规则在哪个头上都成立」。
2. 非代码引用（脚本、CI、launchd、flag 登记、env、打包清单、spike、runbook）用 `git grep` 逐类盘点，并用本机生产状态（`launchctl`、`~/.flywheel/projects.json` 的键名、`.env` 的键名——只看名字不看值）核对「生产是否在用」。

## 2. 引用图脚本 `refgraph.mjs`

放在本目录，实现阶段必须在 `git merge origin/main` 之后重跑，以当时的真实头为准：

```bash
node engineering/doc/FLY-2860-legacy-voice-removal/refgraph.mjs . --json /tmp/fly2860-graph.json
```

它做的事（纯静态、只读）：
- 扫描 `packages/{voice-bridge,voice-core,gemini-agent,voice-codex,voice-headphone}`、`packages/teamlead/src`、`scripts` 下的 ts/mjs/js。
- 解析 `import … from` / `export … from` / `import("…")` / 裸 `import "…"`；相对路径按 `.js→.ts` 解析；对 `flywheel-voice-bridge` / `flywheel-voice-core` / `flywheel-gemini-agent` 的包导入，**按符号穿过包的 `src/index.ts` 桶文件**解析到真正定义该符号的文件（所以「voice-codex 用了 index.ts」不会把整个桶都拉进保留集）。
- **生产根** = voice-codex、voice-headphone、teamlead 的全部非测试源码；**旧命令根** = voice-bridge 的 `assistant/`、`eleven/`、`huddle/`、`cli.ts` 与 gemini-agent 全部源码。
- 输出：`onlyOld`（旧根可达、生产根不可达 → 删）、`shared`（两边都可达 → 保留，并列出每个共用文件在保留侧的导入方作为证据）、`orphan`（两边都不可达）、每个测试文件的分类（delete / mixed / keep）、生产侧实际消费的包符号清单。

已知局限（plan 里用别的闸补上）：
- 它是**文件级**的：混合文件（一个文件里既有生产段落也有旧段落，如 voice-core `factory.ts`）会让旧文件显示为「共用」。这类文件在 plan §3 逐个点名、手工剪段落，剪完后重跑脚本 + `tsc` 验证。
- 它不看 shell 脚本与 JSON 清单 → §5 的非代码盘点用 `git grep`。

## 3. 引用图结果（main + #1306）

### 3.1 只被旧命令到达的源文件（62 个，整文件删除）

| 目录 | 文件 |
|---|---|
| `packages/gemini-agent/src` | `audit.ts`, `cli.ts`, `client.ts`, `config.ts`, `context.ts`, `delegate.ts`, `errors.ts`, `index.ts`, `loop.ts`, `session.ts`, `truncate.ts`, `types.ts` |
| `packages/gemini-agent/src/discord` | `bindings.ts`, `daemon.ts`, `render.ts` |
| `packages/gemini-agent/src/tools` | `bridge-client.ts`, `registry.ts`, `schemas.ts` |
| `packages/voice-bridge/src` | `SessionSlot.ts`, `VoiceRoomRuntime.ts`, `cli.ts`, `config.ts`, `preflight.ts`, `roomEars.ts` |
| `packages/voice-bridge/src/assistant` | `AssistantLanding.ts`, `AssistantSession.ts`, `AssistantSpeaker.ts`, `BriefingEngine.ts`, `GeminiCommand.ts`, `advanced.ts`, `config.ts`, `tools.ts`, `wiring.ts` |
| `packages/voice-bridge/src/audio` | `EarsReceiver.ts`, `GeminiTurnMouth.ts`, `TextTurnMouth.ts`, `defaultCues.ts`, `resample.ts`(*) |
| `packages/voice-bridge/src/brain` | `BrainPort.ts` |
| `packages/voice-bridge/src/discord` | `TivPresenter.ts` |
| `packages/voice-bridge/src/eleven` | `ElevenCommand.ts`, `ElevenSession.ts`, `ElevenWs.ts`, `config.ts`, `landing.ts`, `wiring.ts` |
| `packages/voice-bridge/src/huddle` | `AddressRouter.ts`, `ConclusionPipeline.ts`, `ConfirmationLadder.ts`, `FeedPipeline.ts`, `GlawCommand.ts`, `HuddleSession.ts`, `ReadOnlyLeadBrain.ts`, `ResidentLineDriver.ts`, `confirm-heuristics.ts`, `huddleTiv.ts`, `residentMinutes.ts`, `wireMeeting.ts` |
| `packages/voice-bridge/src/linear` | `BridgeLinearClient.ts` |
| `packages/voice-core/src` | `TalkSessionRotator.ts` |
| `packages/voice-core/src/brain` | `ResidentBrainManager.ts`, `ResidentClaudeBrain.ts` |

(*) `audio/resample.ts`：在**纯 main** 上 voice-codex `audio.ts` 还 import `upsample24kMonoTo48kStereo`，属共用；#1306 重写了 voice-codex `audio.ts`，不再用它，于是变成只被旧命令到达。**以实现时重跑结果为准**——这正是必须重跑的原因。

说明：`TalkSessionRotator` 在图上的旧侧来源有两个——旧命令（`assistant/wiring.ts`、`huddle/wireMeeting.ts`）与 voice-core 自己的 POC CLI `talk` 子命令（Gemini Live 对话 POC）。后者本身就是一套 Gemini 语音实现，按 founder「Gemini 语音所有实现都删」一起删（plan §3.4）。

### 3.2 共用文件（保留，附「谁在用」证据）

| 共用文件 | 仍在用它的保留方（非测试） | 处理 |
|---|---|---|
| `voice-bridge/src/bots/discordWiring.ts` | `voice-codex/src/cli.ts`、`discord-room.ts`、`receive-health.ts` | 保留；剪掉斜杠命令注册成员（plan §3.2） |
| `voice-bridge/src/bots/BotRegistry.ts` | `discordWiring.ts`、`voice-codex/src/discord-room.ts` | 保留原样 |
| `voice-bridge/src/audio/LeadSpeaker.ts` | `discordWiring.ts`（仅类型 `PlayerLike`/`ResourceSource`） | 保留原样 |
| `voice-bridge/src/audio/VoiceConnSupervisor.ts` | `discordWiring.ts`（类型 `VoiceConnHandle`） | 保留原样 |
| `voice-core/src/factory.ts`、`config.ts` | `voice-headphone/src/daemon.ts`（`buildEdgeTtsBackend`、`resolveConfig`） | 混合文件：剪 Gemini 段落（plan §3.4） |
| `voice-core/src/backends/gemini/*`（4 个） | 只有 `factory.ts` 的 Gemini 段落 | 随 factory 剪段后变成只被旧侧到达 → 删 |
| `voice-core/src/emitter.ts` | `voice-codex/src/codex/CodexVoiceBackend.ts` | 保留 |
| `voice-core/src/scrub.ts` | voice-codex `delivery.ts`/`speech.ts`/`CodexVoiceHandoff.ts`、teamlead `voice-session-poller.ts` | 保留 |
| `voice-core/src/transcript.ts` | `voice-codex/src/cli.ts` | 保留 |
| `voice-core/src/types.ts`、`errors.ts`、`process.ts`、`backends/edge-tts/*` | edge-tts / headphone / voice-codex | 保留 |
| `voice-core/src/brain/HeadlessClaudeBrain.ts`、`stream-parse.ts` | 只有 `factory.ts` 的 `buildHeadlessBrain`（POC `talk` 用） | **不是 Gemini 组件**：保留，列入「删后新变不可达」清单交 Lead 决定（CLAUDE.md dead-code 规则） |

生产侧实际消费的 voice-bridge 符号（证据，脚本 `prodSyms`）：`BotRegistry`、`RegistryClientLike`、`createDiscordDeps`、`DiscordDeps`、`DiscordReceiveDiagnostic`、`DiscordReceivePolicy`、`DiscordReceiveRuntimeDiagnostic`（纯 main 另有 `upsample24kMonoTo48kStereo`）。voice-core 被消费的 40 余个符号里，没有任何一个来自 `backends/gemini/*`、`TalkSessionRotator`、`Resident*Brain*`。

### 3.3 `DiscordDeps` 成员级核对

`DiscordDeps` 是 voice-bridge 暴露给 voice-codex 的 Discord 接线接口。逐成员在 voice-codex / voice-headphone 非测试源码里计数：

| 成员 | 保留侧引用 | 处理 |
|---|---|---|
| `createClient` `joinVoice` `subscribeManual` `createDecoder` `createPlayer` `createResource` `speakingEvents` `sendMessage` `onVoiceStateUpdate` `voiceChannelHumanCount` `userVoiceChannelId` `memberDisplayName` `leaveVoice` | >0 | 保留 |
| `registerGuildCommand` `onChatCommand` `onChatInteraction` | 0 | **删**——这就是「斜杠命令注册」能力本身；删掉后仓内没有任何代码能再注册语音斜杠命令 |
| `tivPort` `moveMember` `moveMemberDetailed` `sendMessageForId` `editMessage` | 0 | 只服务旧命令（TIV 卡片 / 把 founder 拖进 VC）→ 删 |
| `receiveRuntime?` `isHumanFactory` `connectionEvents` `voiceConnHandle?` `receiveEvents?` | 0 | 通用接收诊断能力，`createDiscordDeps` 内部与 #1309 的 RoomIO 会用 → **保留**，列入新不可达清单 |

## 4. 测试分类（脚本输出，main + #1306）

- **整删（49）**：全部 import 只落在删除集里，如 `glaw-command`、`eleven-*`、`assistant-*`（大部分）、`huddle-*`、`brain-port`、`session-slot`、`voice-room-runtime`、`resample`、gemini-agent 全部 12 个测试等。
- **混合（28）**：测的是旧模块，只是顺带 import 了保留件（多为类型或 `discordWiring`）。逐个看过：主语全是旧命令 / Gemini Live / Resident brain → **整删**。例：`assistant-wiring.test.ts`（测 /gemini 接线）、`qa-fly545-r4.test.ts`（测 /glaw）、voice-core `rotator*.test.ts`、`resident-*.test.ts`、`inject-context.test.ts`。
- **保留但要改（voice-core）**：`gemini-live`、`extra-tools`、`genai-config`、`genai-connector`、`turn-accumulator` 五个测的就是 Gemini Live 后端 → 随后端删；`cli-factory.test.ts`、`config.test.ts`、`public-exports.test.ts`、`registry.test.ts` 删其中 Gemini 用例、保留其余。
- **保留原样**：voice-bridge `bot-registry`、`discord-wiring-policy`、`lead-speaker`、`voice-conn-supervisor`；voice-core headphone / edge-tts / scrub / transcript / receive-health / process 等；voice-codex、voice-headphone 全部。
- **图标为 no-lib-import 的测试**：`voice-bridge/src/__tests__/rig-config.test.ts` 实际 import `../../e2e/lib/rig-config.mjs` 并读两个 Gemini 台架（脚本只统计 lib 依赖，漏了这条边）→ 随台架删。
- **台架**：`packages/voice-bridge/e2e/` 14 个文件全部驱动旧守护进程（`../dist/cli.js`）或旧模块（`EarsReceiver`、`StereoDownmixDecimator` 16 kHz 链路、`AssistantLanding`），`packages/voice-core/e2e/fly1065-live-aggregation.mjs` 是 Gemini Live 聚合台架 → 全删。

## 5. 非代码引用盘点

### 5.1 voice-bridge 守护进程壳（Q1，Lead 同意删）

| 文件 | 现状 | 处理 |
|---|---|---|
| `scripts/run-voice-bridge.ts` | 守护进程入口 | 删 |
| `scripts/flywheel-voice-bridge-wrapper.sh` + `scripts/__tests__/voice-bridge-wrapper.test.sh` | launchd 包装 | 删 |
| `scripts/launchd/com.flywheel.voice-bridge.plist` + `units.manifest` 第 30 行 | 本机未安装 | 删 plist 与 manifest 行；`launchd-units-manifest.test.sh`、`launchd-census.test.sh` 同步 |
| `scripts/lib/restart-voice-bridge.sh`（87 处） | 生产走 `not_configured` 空操作 | 删 |
| `scripts/restart-services.sh`（17 处：source 行、DRY RUN 文案、Step 3.5 `ensure_voice_bridge_for_deploy`、回滚分支 `rollback-voice-bridge-failed`） | 同上 | 删这些段落；**新增专属脚本测试先红后绿**（Lead 要求） |
| `scripts/__tests__/restart-services-voice-bridge.test.sh`（CI ci.yml:1126 调用） | 测上面这条步骤 | 删，并从 ci.yml 摘掉；由新测试取代 |
| `scripts/test-restart-services.sh`、`restart-storm-gate.test.sh`、`restart-deploy-consistency.test.sh`、`restart-services-admission-pause.test.sh`、`qa-fly1501-*`、`host-tmux-selection-*`、`check-global-path-hygiene.test.sh`、`lib/path-hygiene.sh`、`ci-structure.test.sh`、`ci-shell-suite-manual-only.txt` | 各自对 voice-bridge 步骤 / 文件有 1–9 处断言或桩 | 逐个改到「不再有 voice-bridge 步骤」 |
| `packages/claude-runner/test/fixtures/kill-path-inventory.json` | 登记了 wrapper 与 restart 库里的 kill 路径 | 删对应条目 |
| `scripts/install-voice-launchd.sh:94` | 发现旧 voice-bridge 单元就拒装 | **保留**（负向守卫） |
| `scripts/test-deploy.sh:570`、`scripts/qa/fly2655-voice-room.mjs`、`scripts/qa/fly2446-two-lead-run.mjs` | 构建 / 引用 voice-bridge **库** | 保留（库还在） |

### 5.2 ProjectConfig 的 `huddle` 块

- `packages/teamlead/src/ProjectConfig.ts` 解析 `huddle`（guildId、voiceChannelId、orchestratorBotTokenEnv、earsBotTokenEnv、commandName、moveMembers…），唯一消费者是 voice-bridge 守护进程的 `loadHuddleBridgeConfig`。
- 但 `huddle != null` 还被当作**负向守卫**用：Bridge `voice-session-preflight.ts:99`、`voice-session-services.ts:121`、`voice-session-start.ts:111` 与 voice-codex `config.ts` 都在看到 `huddle` 时拒绝（`legacy_voice_conflict`）。
- 处理：删 `HuddleConfig` 的字段级校验与类型字段（issue 3b「commandName glaw 等」），**保留「存在即冲突」的守卫语义**：`huddle` 键退化为 `unknown` 的退役标记，四处守卫不改。生产 7 个项目零 `huddle` 块，行为零变化。`packages/teamlead/src/__tests__/huddle-config.test.ts` 改成只测「退役标记仍触发冲突守卫」。

### 5.3 flag / env 登记（`packages/config/src/feature-flags/*`）

删除后在仓内**已无读取方**的名字（脚本扫描删除集 + 全仓剩余读取方得出）：

| 名字 | 登记位置 | 处理 |
|---|---|---|
| `FLYWHEEL_GEMINI_AGENT_*`（11 个） | `truth.ts:100-110` | 删；`scripts/gemini-agent-guard.sh` 与 ci.yml 的 guard 步骤一起删 |
| `FLYWHEEL_GEMINI_AUTOSTART`、`FLYWHEEL_ELEVEN_AUTOSTART` | `exemptions.ts:217/224` + drift / store-policy 测试 | 删 |
| `FLYWHEEL_HUDDLE_*`（6 个） | `truth.ts:116-121` | 删 |
| `FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT`、`FLYWHEEL_BRAIN_PORT_TOKEN` | `truth.ts:228/13` | 删 |
| `FLYWHEEL_VOICE_GEMINI_MODEL`、`FLYWHEEL_VOICE_GEMINI_KEY_ENV` | `truth.ts:235-236`，读取方 voice-core `config.ts` / `genaiConnector.ts` | 随 voice-core Gemini 段落删 |
| `FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE` | `exemptions.ts:56` + registry / store-policy 测试 + `fly1981-legacy-snapshot.ts` + `fly2102-flag-freeze.test.sh` 的冻结清单 | 读取方只剩 /gemini 台架 → 删；冻结测试按它自己的合同更新（实现时先读清楚它是「不许新增」还是「精确集合」） |
| `GEMINI_API_KEY` | voice-core 读取点随 Gemini 段落删；**edge-worker 的 Gemini runner 读取保留** | 只删语音读取点 |
| `ELEVENLABS_API_KEY`、`ELEVENLABS_AGENT_ID`、`ELEVEN_*` | 只在删除集与其测试里 | 随代码删；本机 `~/.flywheel/.env` 里有 `ELEVENLABS_API_KEY` 这一行（只核了键名）→ 属运维数据，**不在仓内**，列为 PR 的运维后续：由 founder 决定是否吊销 / 删行 |

### 5.4 CI 与打包

- `.github/workflows/ci.yml`：删 `Test — FLY-1018 gemini-agent guard`（1071-1076）与 `restart-services-voice-bridge.test.sh` 调用（1126）；`scripts/__tests__/ci-structure.test.sh:1140` 的期望步骤名同步。按包跑的测试由工作区自动枚举，删包即不再跑。
- `scripts/package-onboard.sh`：`PO_PACKAGES` 含 `voice-bridge`（库仍被 voice-codex 用）→ 保留；`voice-bridge:models` 资产（Silero，只在 #1309 上存在）不动。`package-onboard-files.allow` 用 `dist/*` 通配，而两包的 build 只是 `tsc`、不清理已删源码的产物，`package-onboard.sh:713-714` 又原样复制 dist → **复用的 checkout 会把旧产物带进 payload**（Codex R1 实验复现），plan 用 C2.5 处理。gemini-agent 本来就不在打包清单里。
- 依赖：voice-core 的 `@google/genai` 只被 `genaiConnector.ts` 用 → 删依赖；voice-bridge 的 `flywheel-edge-worker` 只被 `cli.ts` 的 /glaw worktree 动态 import 用 → 删依赖；voice-bridge `bin`（`flywheel-voice-bridge`）删；`pnpm-lock.yaml` 随之更新（只允许 lockfile 里这几处变动）。edge-worker 自己的 `@google/genai` 保留。

### 5.5 spike 与其它

| 路径 | 处理 |
|---|---|
| `engineering/spike/FLY-980-eleven/`、`FLY-1006-eleven/`、`FLY-997-gemini-agent/`、`FLY-967-live-assistant/`、`FLY-545-huddle/` | 整目录删（都只服务三套旧命令） |
| `engineering/spike/FLY-968-voice-bakeoff/` | 只删 `s4-gemini-multisession.mjs`、`s4a-gemini-voice-sweep.mjs`、`s4b-voice-judge.mjs`（Gemini 声音评审）、`s5-elevenlabs-agent.mjs`；OpenAI / edge-tts 的 bakeoff 留作历史 |
| `engineering/spike/FLY-960-dave-stt/` | 保留（Discord DAVE 接收探针，通用接收链路；提到 Gemini 只是离线转写工具） |
| `packages/voice-core/evidence/gemini-*.json`、`real-live-models-list.json` | 删（Gemini Live 证据文件） |
| `packages/teamlead/lead-rules-base/*department-lead-rules.md` 的「不要调用旧 huddle 入口」 | 保留（负向规则，删了反而失去提醒） |
| `packages/flywheel-comm`、`edge-worker/Blueprint.ts` 注释里的 `/eleven` 事故引用 | 保留（历史注释，不是实现） |

### 5.6 Discord 已注册命令

- 注册方式：`deps.registerGuildCommand(orchClient, guildId, def)`（guild 级，不是全局）；命令名默认 `glaw`（可配）、`gemini`、`gemini-advanced`、`eleven`；gemini-agent 守护进程另注册过 `gemini-advanced`。
- 进程停止后 guild 命令**仍然留在 Discord**，所以需要主动删。
- 注册它们的 bot 是当年 huddle 配置里的 orchestrator bot；配置已不存在 → 退役脚本要枚举候选：本机 env 中所有 Discord bot token（projects.json 各 Lead 的 `botTokenEnv`、以及 `HUDDLE_ORCH_BOT_TOKEN` 若存在）× 所有 `voiceRoom.guildId`，调用 `GET /applications/{appId}/guilds/{guildId}/commands`，**只删名字在固定白名单里的**命令。

## 6. 其它确认过的事实

- Bridge 侧 `POST /api/voice/sessions/resident/claim`：在 #1309 上唯一调用方是 voice-bridge 的 `resident-voice-session.ts`；main + #1306 上 voice-bridge 根本没有这个客户端。Bridge 路由与 `meeting`/`rg` 模式被 voice-codex 共享 → 不动，写进 follow-ups（Lead Q4）。
- Bridge 侧 `geminiAgentToken`（`TEAMLEAD_GEMINI_AGENT_TOKEN`）：生产 `.env` 未设；约 50 处路由中间件 + `ship_approval_request` 路径 + `runner-tier-token-preflight.sh` → 不动，写进 follow-ups（Lead Q2）。
- RoomIO 输出 24 kHz（#1309 `RoomIO.ts:372`）；main + #1306 上没有 RoomIO。#1309 头上 voice-bridge 内订阅 `onFrame` 的文件是 `VoiceRoomRuntime`、`roomEars`、`cli`、`assistant/AssistantSession`、`assistant/wiring`、`eleven/ElevenSession`、`audio/EarsReceiver`——**全部在删除集里**；voice-codex 通过 `RoomIOOptions` 构造参数接 24 kHz 上行、以 24 kHz 回放（`discord-room.ts:45`）。所以删除后不存在 16 kHz 消费方挂在 RoomIO 上。
