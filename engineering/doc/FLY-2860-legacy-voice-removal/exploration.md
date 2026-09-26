# FLY-2860 删除三套旧语音命令 — 探索
Issue: FLY-2860 (https://linear.app/geoforge3d/issue/FLY-2860/语音清理-删掉-geminigeminigemini-advancedelevenlabseleven与-glaw)
日期: 2026-09-25
基于: 无

## 1. 要解决的问题

founder 2026-09-24 直令：7 月那几套旧语音——`/gemini`（含 `/gemini-advanced`）、`/eleven`、`/glaw`——连同实现和测试台架全部删掉。它们今天还在 main 上，每一轮语音 QA 都要为它们跑台架，并且和生产语音（voice-codex 引擎 B）共享同一批文件，拖慢每一次语音改动。

一句话：**让仓库里只剩生产在用的语音（voice-codex + voice-headphone + voice-core 的公共件 + voice-bridge 的 Discord 库面），其余旧命令的代码、测试、台架、配置、部署步骤一次清干净。**

## 2. 基线（Lead 2026-09-25 裁定）

| 分支 | 状态 | 本单怎么对待 |
|---|---|---|
| `origin/main` a084f3a99 | 现状 | **基线** |
| #1306 FLY-2799（引擎 B 常驻容器） | OPEN，即将合入 | **基线的一部分**：它实际用到的 voice-bridge / voice-core 面必须保留 |
| #1309 FLY-2796（耳机模式 / RoomIO 迁入 voice-bridge） | 暂停，不一定合 | 不作基线；若先于本单合入，按 §6 的「重算规则」处理 |
| #1312 FLY-2798（引擎 A Live 前台） | 已关闭不合入 | 忽略 |

> 早先 issue 描述里的「入场条件：等 #1309 合入」已被 Lead 裁定取代。实现开工前只做一件事：`git merge origin/main`，然后**重跑引用图脚本**（§6），以当时的真实头为准。

## 3. 现状盘点（main + #1306）

### 3.1 进程与部署

- **生产语音进程只有一个**：launchd `com.flywheel.voice` → `scripts/flywheel-voice-wrapper.sh` → `packages/voice-codex/dist/cli.js`。
- 旧命令的宿主是 **voice-bridge 守护进程**（`packages/voice-bridge/src/cli.ts` 的 `runVoiceBridge`，launchd `com.flywheel.voice-bridge`，入口 `scripts/run-voice-bridge.ts`）。本机 `~/Library/LaunchAgents` 里**没有**这个 plist，进程也不在跑。
- `~/.flywheel/projects.json` 7 个项目**全都没有 `huddle` 块**（只有 `voiceRoom`）。voice-bridge 守护进程启动必须读 `huddle` 块 → 它在生产上根本起不来。voice-codex 反过来在 `huddle != null` 时直接拒启（`legacy_voice_conflict`）。
- `restart-services.sh` 的 Step 3.5 `ensure_voice_bridge_for_deploy` 在生产上走的是 `not_configured` 空操作分支。

结论：**voice-bridge 守护进程 = 三套旧命令的壳**，删命令就等于删这个壳（Lead 已同意 Q1）。

### 3.2 代码引用图（脚本算出，不是手数）

用 `refgraph.mjs`（见 research.md §2）在 main+#1306 树上算：从「生产根」（voice-codex / voice-headphone / teamlead 的非测试源码）出发能到达的文件 = 必须保留；从「旧命令根」（voice-bridge 的 `assistant/` `eleven/` `huddle/` `cli.ts`、gemini-agent 整包）出发、但生产根到不了的文件 = 只被旧命令使用。

| 分类 | 数量 | 例子 |
|---|---|---|
| 只被旧命令到达（可删） | 62 个源文件 | `assistant/*`、`eleven/*`、`huddle/*`、`cli.ts`、`config.ts`、`SessionSlot.ts`、`VoiceRoomRuntime.ts`、`roomEars.ts`、`EarsReceiver.ts`、`BrainPort.ts`、gemini-agent 18 个文件、voice-core 的 `TalkSessionRotator` / `ResidentBrainManager` / `ResidentClaudeBrain` |
| 生产与旧命令共用（保留） | 18 个 | voice-bridge `bots/BotRegistry`、`bots/discordWiring`、`audio/LeadSpeaker`、`audio/VoiceConnSupervisor`；voice-core `emitter`、`scrub`、`types`、`transcript`、`config`、`factory` 等 |
| 混合文件（保留但要删其中的旧段落） | voice-core `factory.ts` / `config.ts` / `cli.ts` / `index.ts`，voice-bridge `index.ts` / `bots/discordWiring.ts` / `package.json` | 见 plan.md §3 |

完整清单见 research.md §3。

### 3.3 Lead 复审带来的 4 条附带必修，删完后的状态

| # | 问题 | 删除后 |
|---|---|---|
| 1 | RoomIO 24 kHz 帧喂给 16 kHz 消费方（/gemini、/eleven） | 两个消费方随删除消失。main+#1306 上 **RoomIO 本身不存在**（它是 #1309 的产物）；voice-codex 自己的房间层按 24 kHz 处理。QA 用 grep 表逐个列 `onFrame` 消费方与采样率（plan §7） |
| 2 | VoiceRoomRuntime 单槽订阅被 /gemini、/eleven 覆盖 | `VoiceRoomRuntime.ts` 与 `SessionSlot.ts` **只被旧命令使用**，整文件删除 → 不再有多个订阅方；QA 断言文件与引用为零 |
| 3 | 租约 close 传 Bridge 未登记的 reason | 唯一调用方 `resident-voice-session.ts`（常驻租约客户端，#1309 才有）与 voice-bridge 守护进程一起删；QA 断言仓内无 `close("ended"` 类残留调用方 |
| 4 | /glaw 租约不续约 | /glaw 整体删除；QA 断言无 `claimSession`/`mode: "meeting"` 的 voice-bridge 侧调用 |

## 4. 候选方案

### 方案 A（采用）：按引用图整删 + 守护进程面一起下线
- 删三套命令、gemini-agent 整包、voice-bridge 守护进程壳（cli.ts、run-voice-bridge.ts、launchd plist、wrapper、restart 库与 restart-services 步骤）、voice-core 的 Gemini Live 与 POC `talk` 面、所有只服务它们的测试 / 台架 / spike / flag 登记。
- voice-bridge 包保留为**纯库**（voice-codex 用它的 Discord 接线）。
- 已注册在 Discord 的旧斜杠命令用一个**可复跑的退役脚本**删掉（进程停了命令不会自己消失）。

### 方案 B（否决）：只删命令模块，保留一个空壳 voice-bridge 守护进程
- 守护进程没有 huddle 配置起不来，保留它只会让 restart-services 继续维护一条永远空转的部署步骤，并留下 BrainPort 这种已无调用方的鉴权端口。没有收益。

### 方案 C（否决）：顺手删 Bridge 侧 gemini-agent scoped token / resident claim 路由
- 属 Bridge 鉴权面（约 50 处路由中间件）与 FLY-2796 新增的 Bridge 路由，改动面和风险跟「删语音」不是一个量级。Lead 裁定（Q2/Q4）：写进 PR follow-ups，本单不动。

## 5. 明确不删

- Gemini 作为**编码 runner**（`packages/config` runner-label、`packages/core` schema、`packages/edge-worker` Gemini runner、`@google/genai` 在 edge-worker 的依赖）。
- Gemini 评审通道与 gemini-image 等技能 / 脚本、`scripts/fly349-engine`（内容分析用 Gemini File API，非语音）。
- 生产语音：voice-codex（引擎 B）、voice-headphone、voice-core 的公共件（edge-tts、headphone、scrub、transcript、receive-health、types…）。
- Bridge 侧：`/api/voice/sessions/*`（含 resident claim，被 meeting/rg 模式与 voice-codex 共享）、`geminiAgentToken` scoped token、`ship_approval_request` 路径 → PR follow-ups。
- 历史文档（`engineering/doc/**`、`doc/**`、`product/doc/**`、milestones）：档案，不删（Lead Q3）。
- `scripts/install-voice-launchd.sh` 里「发现旧 voice-bridge 服务就拒绝安装」的负向守卫：保留，它在退役后依然有意义。

## 6. 风险与未知

1. **#1309 若先合入**：它把 voice-codex 的房间层搬进 `voice-bridge/src/room/*`，并让 SessionSlot / VoiceRoomRuntime 继续挂在旧命令上。引用图脚本已在 #1309 头上验证过：`room/*` 全部落在「共用」一侧，旧命令侧多出 `resident-voice-session.ts`、`room/adapter.ts`、`GlawLeaseHeartbeat.ts`。所以规则不变，只是清单变长——**以实现时重跑的脚本输出为准**。
2. **#1306 未合入前**：main 上 voice-codex 还 import `upsample24kMonoTo48kStereo`（`audio/resample.ts`），#1306 合入后它变成只被旧命令使用。同样由重跑决定。
3. **Discord 残留命令**：进程停了命令还挂在 guild 上；哪个 bot 注册的只有当年的 huddle 配置知道（现已不存在）→ 退役脚本要枚举本机所有语音相关 bot × 所有 voiceRoom guild，只删名字在白名单里的命令。
4. **别的机器上可能装着 `com.flywheel.voice-bridge`**：部署新代码后它的入口文件消失会崩溃重启。退役脚本同时负责检测并 bootout 这个 launchd 单元；`install-voice-launchd.sh` 的守卫保留。
