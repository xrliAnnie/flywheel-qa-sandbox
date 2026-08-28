# FLY-2097 进/退语音模式的命令化 — 调研
Issue: FLY-2097 (https://linear.app/geoforge3d/issue/FLY-2097/raya语音-ux-进退语音模式的命令化进slash-command退自然语音说一句即退模型-tool-call-slash-兜底)
日期: 2026-08-27
基于: exploration.md

> 本文只记**技术事实**与**方案对比**。每条事实标出处与成色:✅ 实测 / 源码逐行核过 · 📖 官方文档 · ⚠️ 读到但未量 · ⬜ 未验。文末「会过期的结论」逐条给 as-of + 重核命令。
> 被测版本:raya `b7abff4`(origin/main);codex **0.150.1**(`/Users/xiaorongli/.local/bin/codex`,即生产 `RAYA_CODEX_BIN`);discord.js `14.26.4`;`@discordjs/builders` 1.14.1。

## 1. Codex app-server realtime 协议(0.150.1)

### 1.1 方法清单(从生产二进制 `strings` 取,与 2074 research 对照)

| 客户端请求 | 0.149.1(2074 research) | 0.150.1(本单) | 出处 |
|---|---|---|---|
| `thread/realtime/start` / `appendAudio` / `appendSpeech` | 有 | 有 | strings ✅ |
| `thread/realtime/appendText` | — | **新增** | strings ✅;语义 ⬜ |
| `thread/realtime/stop` | **没有**(PoC 只能杀进程) | **新增** | strings ✅;参数 ⬜ |
| `thread/realtime/listVoices` | — | 新增 | strings ✅ |
| `thread/start.dynamicTools` | 未查 | **存在**(见 §1.3) | strings ✅ |

服务端 → 客户端的 **request**(需要客户端应答)清单:`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/permissions/requestApproval`、**`item/tool/call`**、`account/chatgptAuthTokens/refresh`、`attestation/generate`。raya-voice 今天对**任何** server request 都记协议违规并把 realtime 腿判死(`RealtimeTransport.ts:128-130` → `protocolViolation`)✅。

重核:`strings -n 5 "$RAYA_CODEX_BIN" | grep -oE 'thread/realtime/[a-zA-Z]+' | sort -u`

### 1.2 `thread/realtime/start` 的全部字段(0.150.1)

二进制里 `ThreadRealtimeStartParams` 的 serde 字段串(✅ strings):

```
threadId · transport · outputModality · voice · version(隐含) ·
realtimeStartInstructions · realtimeEndInstructions · prompt · realtimeSessionId ·
clientManagedHandoffs · delegationAckFiller · flushTranscriptTailOnSessionEnd ·
codexResponsesAsItems · codexResponseItemPrefix · codexResponseHandoffMode · codexResponseHandoffChannelPrefixes ·
includeStartupContext · initialItems
```

**没有 `tools` / `functions` 一类字段** ⇒ 客户端不能给实时语音模型注册自定义 function。生成的 JSON schema(`codex app-server generate-json-schema`)仍不导出 realtime 请求定义(与 2074 research §1.1 一致),只导出通知与 `ThreadRealtimeStartTransport`(新增 `existingCall` 变体)✅。

实时模型自己的「工具」只有一个:**交办给后台 Codex**。内部事件 `RealtimeHandoffRequested {handoff_id, input_transcript, active_transcript}`、`ConversationHandoffAppend {handoff_id, output_text}`、`DelegationContextAppend` ✅ strings;`realtimeEndInstructions`、`clientManagedHandoffs` 的语义未文档化 ⚠️。

重核:`strings -n 5 "$RAYA_CODEX_BIN" | grep -o '.\{0,40\}realtimeStartInstructions.\{0,200\}' | head -3`

### 1.3 dynamic tools(后台线程的客户端工具)

| 事实 | 出处 |
|---|---|
| `thread/start` 接受 `dynamicTools`(字段串 `…sessionStartSource environments dynamicTools selectedCapabilityRoots mockExperimentalField experimentalRawEvents struct ThreadStartParams`;另有 `thread/start.dynamicTools` 字面) | strings ✅ |
| 生成的 v2 schema 里 `ThreadStartParams` **不含** `dynamicTools`(隐藏 / experimental 字段;Raya 已 `experimentalApi:true`) | schema ✅ |
| `DynamicToolSpec = {type:"function", name, description, inputSchema, deferLoading?}` 或 namespace 包多个 | `codex_app_server_protocol.v2.schemas.json` ✅ |
| 调用 = server request **`item/tool/call`**,params `DynamicToolCallParams {threadId, turnId, callId, tool, arguments, namespace?}`;应答 `DynamicToolCallResponse {success, contentItems:[{type:"inputText", text}]}` | `DynamicToolCallParams.json` / `DynamicToolCallResponse.json` ✅ |
| 持久化表 `thread_dynamic_tools` | strings ✅ |
| `codex features list`:`realtime_conversation under development false`(与 0.149.1 相同) | ✅ |

⇒ 「真 tool call」路径在协议上**是通的**,但只能落在**后台 Codex 线程**:实时模型交办 → 后台 gpt-5.6-sol(xhigh)推理 → 调 `end_voice_session` → app-server 发 `item/tool/call` → raya-voice 应答并拆除。**未实测**(⬜):`--strict-config` 下 `dynamicTools` 是否被接受、realtime 活跃时 `item/tool/call` 是否到达。

### 1.4 交办路径的延迟(不是本单量的,引用)

| 量 | 值 | 出处 |
|---|---|---|
| 她问完 → 首个「在忙」信号(`agentMessage.commentary`) | 7.8 s | 2074 research §3(FLY-1911 B §6.4)✅ |
| → 首个命令 | 12.3 s | 同上 ✅ |
| → 开口 | 57.9 s | 同上 ✅ |
| v2 想事情的沉默 | 8 场 19.3–26.4 s,中位 21.8 s | 同上 ✅ |
| P5 强制交办:31 s 内 6 对 item started/completed | 2074 research §7.6 ✅ |

⇒ 走后台 tool 的退出,从她说完到拆除**不会短于交办 + 一次后台推理**,量级十几秒起;期间等待音在响。

### 1.5 转写通知与真机格式

| 事实 | 出处 |
|---|---|
| `thread/realtime/transcript/delta` / `done {threadId, role: user\|assistant, text}`;transport 已解析成 `TranscriptChunk {role, text, final}` | `RealtimeTransport.ts:301-324` ✅ |
| runtime 已把 final 转写记进 evidence(`kind: realtime_transcript`),但**不做任何动作** | `runtime.ts:639-648` ✅ |
| 真机 r6(2026-08-27T07:42:00Z)assistant final:82 字,以「！」结尾,含中文标点;user final 31–32 字,以「。」结尾 | `~/.flywheel/raya/data/state/voice-evidence/events.jsonl`(只看格式,内容不抄)✅ |

⇒ 结束语匹配必须**归一化**(去中英文标点、空白、语气词),不能拿原串精确相等。

### 1.6 拆除路径(现状,可复用)

`Sigterm` 事件 → `ClearVoiceModeRequest` → `Announce("我下线了")` → `StopCodex` → `Exit(0, "sigterm")`(`Coordinator.ts:414-434`)。`StopCodex` = `stdin.end()` + 1 s 未退则 `SIGKILL`(`AppServerClient.ts:stop`)✅。Exit 0 + marker 已清 ⇒ launchd `SuccessfulExit=false` 不重拉;即使重拉,`run` 看不到 marker 立刻 exit 0(`voice/cli.ts:149-166`)✅。**不需要** `thread/realtime/stop`。

Downlink 暴露 `depth()`(队列里还没写出去的帧数)✅ `Downlink.ts:104`;写出去的帧还在 PassThrough 缓冲(目标 5 帧 = 100 ms)+ Discord 播放延迟。

## 2. Discord slash command 事实

### 2.1 权限 / scope

| 事实 | 出处 |
|---|---|
| 「`applications.commands` scope 允许 app 在 guild 里加命令,**bot scope 默认包含它**」 | Discord API docs(oauth2.mdx)📖 |
| 2074 邀请 URL 只带 `scope=bot`;当时 plan 写「不新增 slash-command scope」 | 2074 plan §14.1 ✅ |
| 只读探针 `GET /applications/1542068543645024257/guilds/1485787271192907816/commands` → **200 `[]`** | 2026-08-28T00:5xZ ✅ |
| 无副作用探针 `PUT …/guilds/…/commands` body `[]`(现状已是空)→ **200 `[]`**;再 GET 仍 `[]` | 同上 ✅ ⇒ 注册权限**已具备**,不需要重邀 |
| app `install_params.scopes = ["applications.commands"]`,`bot_public = true` | `GET /applications/@me` ✅ |

重核:`curl -s -H "Authorization: Bot $RAYA_BOT_TOKEN" https://discord.com/api/v10/applications/1542068543645024257/guilds/1485787271192907816/commands -w '\n%{http_code}\n'`

### 2.2 命令名规则

| 事实 | 出处 |
|---|---|
| CHAT_INPUT 命令名与选项名必须匹配 `^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$` 且为小写 | Discord docs "Application Command Naming" 📖 |
| 本机 node 实测:`进入语音` ✓ `退出语音` ✓ `voice` ✓ `voice-off` ✓;`语音 进入`(带空格)✗ | `node -e` 2026-08-27 ✅ |
| description 1–100 字;支持 `name_localizations` / `description_localizations` | docs 📖 |
| guild 命令**即时生效**;全局命令最长 1 h | docs 📖 |

Founder 2026-08-27 页面批注后采用 `/voice` + `/endvoice`:两者均满足规则;相比 `/voice end`,`/endvoice` 是单层命令,手机输入 `/e` 即可补全。由此抽出的长期约束是:面向 founder 的 slash 命令短、优先英文、关键动作不藏在第二层选择里。

### 2.3 discord.js 14.26.4 API(Context7 `/websites/discord_js_packages_discord_js_14_26_2`)

| 用途 | API | 成色 |
|---|---|---|
| 注册(本单最终采用差量 upsert) | `client.application.commands.fetch({guildId})` 后只对 `/voice`、`/endvoice` 调 `create` / `edit`;不用 `set`,避免覆盖同 app 的其他 guild command | 📖 + code review advisory 后实装 ✅ |
| 命令数据 | `ChatInputApplicationCommandData {name, description, type?, dmPermission?, defaultMemberPermissions?, contexts?}` | 📖 |
| 收命令 | `client.on("interactionCreate", i => i.isChatInputCommand() && …)`;`i.commandName / i.user.id / i.guildId / i.channelId` | 📖 ⚠️ 事件名与字段在实施时以类型为准 |
| 3 秒内必须应答 | `await i.deferReply()` → `await i.editReply(text)`;或直接 `i.reply()` | 📖 |
| intents | `interactionCreate` 不需要额外 intent(`Guilds` 已够) | ⚠️ 常识,实施时验 |

brain 现有 `VoiceModeGatewayClient` 是最小结构类型(`on("messageCreate")` / `login` / `destroy`),测试注入假 client(`voice-mode.test.ts:278-330`)✅ ⇒ 加 `on("interactionCreate")` 与一个 `registerCommands(appId, guildId, commands)` seam,沿用同一注入形状。命令数据最终加 `defaultMemberPermissions:"0"`:Discord picker 默认只向管理员可见,server-side founder allowlist 仍是最终授权边界。

## 3. 代码缝(raya `b7abff4`)—— 改哪里、为什么

| 文件:行 | 现状 | 本单 |
|---|---|---|
| `apps/brain/src/voice-mode.ts:11-20` `parseVoiceModeCommand` | 精确口令 → start/stop/hint | 保留;hint 文案加 slash |
| `voice-mode.ts:84-143` `handleSerial(message)` | 鉴权 + 解析 + 执行揉在一起 | 拆成 `authorize(actor)` + `execute(command, reply)`;文字与 slash 两条入口共用 `execute` |
| `voice-mode.ts:187-197` supervisor `stop()` | 只发 `launchctl kill SIGTERM` 就返回 `signaled` | 发 SIGTERM 后限时轮询 `launchctl print`;超时 `kill SIGKILL`;返回 `signaled \| forced \| absent` |
| `voice-mode.ts:201-260` gateway | 只挂 `messageCreate` | ready 后注册 guild 命令;挂 `interactionCreate`;注册失败只记错、不影响文字口令 |
| `apps/voice/src/cli.ts:56-60` `startInstructions()` | 2030 文件或默认句 | 末尾追加固定「退出协议」段(常量);总长仍受 transport 的 8,192 检查 |
| `apps/voice/src/session/Coordinator.ts:39-77` 事件 | `Sigterm` | 新增 `SpokenExitRequested`,动作同 `Sigterm`,`Exit.reason = "spoken-exit"`,announce 文案区分 |
| `runtime.ts:639-648` `wireTransport` transcript | 只记 evidence | assistant final → 匹配器命中 → 等 Downlink 排空 + grace → `send({type:"SpokenExitRequested"})` |
| `apps/voice/src/config.ts` options | 无 | `spokenExitEnabled`(默认 true)、`spokenExitGraceMs`(默认 1500) |
| `packages/contracts` | — | 不改(无新 env key、无新文件合同) |
| `apps/brain/src/installer.ts` / plist | — | 不改 |

## 4. launchd 语义(不变,引用 2074 §14.2)

voice plist:`RunAtLoad=false`、`KeepAlive.SuccessfulExit=false`、`ThrottleInterval=60`。exit 0 → 停住;exit ≠0 或被信号杀 → 60 s 内重拉;`run` 启动时无 marker → exit 0。当前生产 plist `ProgramArguments` 仍指向 `worktrees/raya-FLY-2074/…`(2074 landing checklist 未执行)✅ `~/Library/LaunchAgents/com.xrli.raya.voice.plist` —— 本单 merge 后的部署同样要重跑 `install-launchd`,否则新代码不生效。

## 5. 方案对比(按部件;结论在 exploration §5)

### 5.1 自然语音退出

| 方案 | 延迟 | 依赖的未验事实 | 新机制 |
|---|---|---|---|
| **A 口头合同**(assistant final transcript 归一化整句匹配) | 一个语音回合(r6 真机:user final → assistant final 17 s,但那是含后台思考的回合;纯 realtime 回复 P3/P4 是秒级)| 实时模型对「只说这句」的遵从率 ⬜(真机量) | 匹配器 + 指令段 + 一个 Coordinator 事件 |
| B 后台 dynamic tool | ≥ 交办 + xhigh 推理(§1.4) | `dynamicTools` 在 strict-config 下被接受 ⬜;realtime 中 `item/tool/call` 到达 ⬜;实时模型愿意交办 ⬜ | transport 应答 server request;工具注册;应答后仍要走同一拆除 |
| C 用户转写关键词 | <1 s | — | 匹配器;但「不想退出这个话题」必误退 |

### 5.2 逃生门

| 场景 | SIGTERM 能退? | 需要 |
|---|---|---|
| 进程健康 | 能(现有 drain) | — |
| realtime / codex 腿死、进程活 | 能(Sigterm 不看腿) | — |
| 事件循环卡死 | **不能**(JS handler 跑不了) | SIGKILL 升级;`kill -STOP <pid>` 可在真机稳定复现这一形状 ✅(POSIX 语义) |
| brain 死 | 无 slash / 无文字 | 离房路径(现有) |

## 6. 探针(交给实施节点;结果按原样存 raya 仓 `probes/evidence/FLY-2097-*/`)

| # | 问什么 | 怎么做 | 尺子(⛔ 不填阈值) |
|---|---|---|---|
| P1 口头合同遵从率 | 实时模型会不会照说结束语;会不会被「不想退出这个话题」骗 | 真机:5 次明确退出句、3 次含糊句、3 次意图相反句;每次记 user/assistant final transcript + 是否拆除 | 三组各自的命中 / 误退计数 n/N |
| P2 卡死逃生 | 进程卡死时 `/退出语音` 还能不能退 | `kill -STOP $(cat run/voice.pid)` → `/退出语音` → 观察 SIGTERM 超时 → SIGKILL → launchd 重拉 → `run` 无 marker exit 0 | `launchctl print` 的 pid / last exit / runs;`#raya` 回话内容 |
| P3(可选,**不在 plan**)dynamic tool | 若 founder 坚持「真 tool call」,量它多慢 | `thread/start` 带 `dynamicTools:[{type:"function",name:"end_voice_session",description:"…",inputSchema:{type:"object",properties:{}}}]` → realtime → 说「我要退出了」→ 记 `item/tool/call` 到达时刻 | 她说完 → `item/tool/call` 的秒数;交办是否发生 |
| P4(可选)`thread/realtime/stop` | 参数与 `closed.reason` | `{threadId}` 试一次 | 是否 `reason=requested` |

## 7. 会过期的结论

| 结论 | as-of | 怎么重核 |
|---|---|---|
| 生产 codex = 0.150.1;`thread/realtime/stop`、`dynamicTools` 存在;realtime start 无 `tools` | 2026-08-27 | `$RAYA_CODEX_BIN --version`;§1.1 / §1.2 的 strings 命令 |
| `realtime_conversation` under development / false | 0.150.1 | `$RAYA_CODEX_BIN features list \| grep realtime` |
| bot 在 guild 有 `applications.commands`(PUT `[]` 200) | 2026-08-28T00:5xZ | §2.1 的 curl |
| 中文命令名合法 | Discord docs 2026-08;builders 1.14.1 | `node -e` 的 regex;实施时以 builders 校验器为准 |
| 交办延迟数字 | FLY-1911 B §6.4(2026-08-2x) | 换模型 / effort 后重量 |
| r6 转写格式(含中文标点) | 2026-08-27T07:42Z | `grep realtime_transcript ~/.flywheel/raya/data/state/voice-evidence/events.jsonl` |
| 生产 plist 仍指向 `worktrees/raya-FLY-2074` | 2026-08-27 | `grep -A3 ProgramArguments ~/Library/LaunchAgents/com.xrli.raya.voice.plist` |
| FLY-2030 分支无 commit | 2026-08-27 | `git -C ~/.flywheel/raya/code log origin/main..fly-2030-raya-brain` |

## 8. 2026-08-28 QA 返工研究：退出协议的有效 Realtime 注入通道

### 8.1 QA 推翻了哪条假设

QA 在 raya `46b5b6b664e7d6c5401a8601237e1e895ea0b575` 上完成真机 S1：5 个明确退出意图 **0/5** 命中。线级证据显示：

- raya 发出的 `RealtimeConversationStart.realtime_start_instructions` 字面含完整退出协议；
- 同一会话 251 条 OpenAI Realtime websocket wire 消息里，该协议 **0 次**出现；
- 发往 Realtime 的 `session.update.instructions` 是 Codex 自己的系统提示，不是 `realtimeStartInstructions`；
- 用 “ALWAYS reply in English only” 作阳性对照，模型仍用中文回答。

因此失败不是退出句措辞或匹配器，而是 Codex 0.150.1 接收字段后没有把它送进模型上下文。完整证据见 `qa-report.md` §2。

### 8.2 返工探针：逐个排除、只保留有行为证据的通道

返工节点用独立 ephemeral thread + `appendSpeech` 跑了两轮阳性对照，不接 Discord、不碰 launchd / marker：

| 通道 | 控制变量 | 模型回答 | 结论 |
|---|---|---|---|
| `thread/start.baseInstructions` + `thread/realtime/start.includeStartupContext=true` | 强制只用英文；用户中文问水果 | 中文「我最喜欢吃草莓……」 | **无效**；startup context 不能作为本单退出协议通道 |
| `thread/realtime/start.prompt` | 同一强制英文指令；同一中文问题 | `My favorite fruit is mango.` | **有效**；该字段真实改变 Realtime 模型行为 |

随后把本单实际 `composeStartInstructions()` 产物放进 `prompt`，同一 session 的语义小样本结果：

| 用户输入 | assistant final |
|---|---|
| `OK，我现在要退出了。` | `好，退出语音模式。` |
| `好了，我要退出语音了。` | `好，退出语音模式。` |
| `先到这里吧，我们结束语音。` | `好，退出语音模式。` |
| `我不想退出这个话题，我们继续聊。` | `没问题，我们接着聊吧。你想聊什么呢?` |
| `我们要不要先结束这个话题？` | 未说退出哨兵，继续澄清话题意图 |

这只是**机制阳性对照**，不能替代 plan §6 的真声 S1/S2/S3；它证明的是新通道有工作面。OpenAI 官方 Realtime 文档也把 instructions / tools / prompt 放在 Realtime session 控制面；但 Raya 使用的是 Codex app-server 封装，客户端必须以本机 0.150.1 的实测字段行为为准，不能把 OpenAI 原生 websocket 字段直接假定为 app-server 可用字段。

### 8.3 返工结论

- 保留已批准的「实时模型说固定结束语 → assistant final 整句匹配 → 安静窗拆除」机制；不改成关键词匹配或后台 dynamic tool。
- `V2WebSocketTransport.start()` 改为把组合后的语音指令放进 `thread/realtime/start.prompt`。
- 删除 `realtimeStartInstructions` 发送；不再宣称 `baseInstructions/includeStartupContext` 能承载本合同。
- 8,192 字符仍作为 Raya 自己的边界校验，防止无界配置进入 Realtime；它不再被描述为死字段的服务器限制。
- QA 重跑前先复跑英文阳性对照；阳性对照失败则直接 FAIL，不再浪费 S1 样本。

Lead 2026-08-28 对返工探针确认：`prompt` 是**当前 app-server schema 下唯一实测可达**的合同通道；不为未来可能开放的 direct `session.update` / custom tools 留 TODO 债。Codex 版本真的开放这些接口时，再以新探针对比后重评。

会过期：以上结论只对 Codex 0.150.1 生效；升级 Codex 后必须复跑两个阳性对照，并检查 `prompt` / `realtimeStartInstructions` 的 wire 与模型行为。
