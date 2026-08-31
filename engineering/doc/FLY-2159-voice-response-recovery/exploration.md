# FLY-2159 语音响应恢复 — 探索
Issue: FLY-2159 (https://linear.app/geoforge3d/issue/FLY-2159/raya语音上游-打断后-attributed-user-final-间歇性等不到-assistant-final装机-schema-无)
日期: 2026-08-31
基于: 无

> 世界标记:[raya] = raya `origin/main` `1c71cd2`(raya#9 已合,含 2026-08-30 Founder replacement rework);[codex-oss] = openai/codex `origin/main` `d58d0e58`(2026-08-31 08:31Z);装机 codex = standalone `0.151.0`(tag `rust-v0.151.0` = `d8673cb`);[flywheel] = 本仓,只承载设计文档,不改代码。

---

## 1. 问题重述

语音房里,founder(或 QA bot)说完一句话、user final 已被归属(attributed)后,**上游间歇性不回 assistant final** —— Raya 沉默。她的体感:「我插嘴问了,它把话让给我了,然后就没有然后了」。

对照证据(同一句中立提问,同一套代码,一答一不答):

| 轮 | user final | assistant final | 结果 |
|---|---|---|---|
| R11 | 2026-08-29T20:39:55.257Z | 20:39:57.826Z(2.569s) | 正常回答 |
| R12 | 2026-08-29T20:45:33.646Z | **无** | 20:45:55.108Z deadline 兜底,20:48:33.746Z runner 超时 |

证据文件:`~/.flywheel/raya/qa/FLY-2031/rounds/bot-experience-20260829-r{11,12}/state/voice-evidence/events.jsonl`。r9/r10 曾疑似「问沉默撞上禁 liveness」,这组单变量对照排除了内容假设 —— 真相是**响应路径间歇性**。

## 2. 情景更新:replacement rework 之后,这个问题变成什么样

⚠️ 本单立案时引用的 `barge_in_user_final` / `barge_in_released{reason:"deadline"}` 事件来自 FLY-2031 的 custom barge-in 层。**该层已于 2026-08-30 被 Founder replacement rework 整层删除**(raya `ae314f4`,-770 行),恢复正常逐轮对话;唯一新增是 `VoiceTextMirror` 把 user final / assistant final / thinking 状态镜像到文字区。FLY-2031 收官报告(bot-qa-summary.md「历史边界」节)明确:**间歇性上游缺口由 FLY-2159 承接**。

在当前 [raya] main 上,失败形态从「barge latch 等到 deadline 释放」变成更糟的形态:

- user final 落地 → 文字区出现 `💭 **Raya**:正在思考`;
- 上游若漏发 response → **没有任何 deadline、没有任何兜底** —— thinking 状态挂着,Raya 无限期沉默,直到 founder 再开口(重新触发上游 VAD)或离房;
- 客户端**没有任何合法恢复手段**(见 §3 schema 审计)。

即:custom barge-in 删除后,本单不但没有失效,反而是当前产品里**唯一**接住这个静默缺口的地方。恢复触发条件从「barge latch 内 user final」泛化为「attributed user final 后 N 秒无 assistant 响应」。

## 3. 审计:三层响应链路与能力缺口

```
Discord 语音房 → [raya] apps/voice(TS 运行时)
    → 装机 codex app-server(JSON-RPC over stdio,experimental thread/realtime/*)
        → OpenAI Realtime API(WebSocket v2,server VAD 自动建响应)
```

### 3.1 装机 schema 面(缺口本体)

[codex-oss] `codex-rs/app-server-protocol/src/protocol/common.rs` 的 realtime 客户端方法,**装机 0.151.0 与上游 2026-08-31 HEAD 一致**:

- 方法:`thread/realtime/start` / `appendAudio` / `appendText` / `appendSpeech` / `stop` / `listVoices` —— 全部 `#[experimental]`。
- 通知:`started` / `itemAdded` / `transcript/delta` / `transcript/done` / `outputAudio/delta` / `sdp` / `error` / `closed`(HEAD 另有 `item/started` / `item/transcript/delta` / `item/completed`)。
- **没有** `response.create` / `commit` / `cancel` 的任何等价方法。⇒ 上游(OpenAI Realtime server VAD)漏建响应时,客户端零恢复手段。**升级装机版本解决不了**:缺口在上游 HEAD 依然存在。

### 3.2 codex 内部已有的机制(补 schema 是薄暴露,不是造新机制)

`codex-rs/core/src/realtime_conversation.rs` 内部已有完整的 response.create 通路:

- `RealtimeWebsocketWriter::send_response_create()`(codex-api methods.rs:374)直接向 OpenAI 发 `response.create`;
- `DefaultResponseQueue` 状态机(`active_default_response` / `pending_create`,`request_create` / `mark_started` / `mark_finished` / `send_create_now`)已在 handoff / standalone speech(appendSpeech)路径上使用,并已处理「response.create 撞上 active response」的竞态(收到 `conversation_already_has_active_response` 前缀错误时转 deferred);
- `ResponseCreated` / `ResponseCancelled` / `ResponseDone` 事件已驱动该状态机。

⇒ 补 schema = 在 app-server-protocol 加一个 experimental 方法定义 + app-server 的 message_processor/turn_processor 转发 + core 的 conversation 上加一个走既有 writer/queue 的入口。不需要动 OpenAI WebSocket 协议层。

### 3.3 [raya] 客户端现状(wiring 点)

- `apps/voice/src/codex/RealtimeTransport.ts`:`RealtimeTransport` 接口 = `start/appendAudio/appendText/appendSpeech` + `on(outputAudio|transcript|closed|error|ackObserved)`;`V2WebSocketTransport` 经 `AppServerClient.request()` 发 JSON-RPC。加新方法在此处。
- `apps/voice/src/runtime.ts` `wireTransport()`:`transcript` final 进 `TranscriptLog.appendFinal()`(带归属窗口 `attributionWindowMs`,产出 `speakerUserId`),emit `realtime_transcript` 证据;`outputAudio` delta 置 `assistantSpeaking=true`,assistant final 置回 false。**恢复 watchdog 的挂点与解除信号都已存在**。
- `initialize` 已声明 `capabilities.experimentalApi: true`(packages/contracts codex-session.ts)⇒ 新 experimental 方法可直接调用。
- 配置机制:`RAYA_VOICE_OPTIONS_JSON`(config.ts `numberOption`/`booleanOption`,启动时严格校验)。FLY-2031 合同:所有时间量都是可改项,默认值 🔶 不设验收阈值。
- 会议模式(`config.meeting`,FLY-2032)与普通模式共用同一 runtime —— 见 §5.5 负向护栏。
- 部署:`RAYA_CODEX_BIN=/Users/xiaorongli/.local/bin/codex` → symlink → `~/.codex-mufasa/packages/standalone/releases/0.151.0-aarch64-apple-darwin`(官方 standalone,自动更新轨道)。**环境变量本身就是部署/回滚边界**。

### 3.4 上游走向

openai/codex 是 Apache-2.0 开源仓;realtime app-server 面全部标 `#[experimental]`(上游自留改动权)。fork `xrliAnnie/codex` 存在但停在 2026-02-14,不能直接做补丁基座;补丁应基于 `rust-v0.151.0` tag(与装机字节同源)。

## 4. 方案选项

| # | 方案 | 判定 | 理由 |
|---|---|---|---|
| A | **补 schema(`thread/realtime/createResponse`)+ 客户端有界恢复** | ⭐ 选它 | issue 指定方向;codex 内部机制已在(§3.2),schema 是薄暴露;客户端只在「attributed user final 后 N 秒无 assistant 响应」时恢复一次,层次正确(与 OpenAI 标准 `response.create` 恢复语义同族) |
| B | `appendText` 重放 user 输入模拟恢复 | ⛔ 已裁定禁止 | FLY-2031 内裁定:层错了,会引入双响应与状态错乱。本单不重开 |
| C | `stop` + `start` 重启 realtime 会话 | ✗ | 违反 founder 8-20「进程内重连」禁令;丢会话上下文;静默数秒变成断流数秒 |
| D | 等上游自己补 | ✗(可并行,不作依赖) | 上游 HEAD 今天仍无此方法;时间不可控。可以向上游提 PR,但本单交付不依赖它 |
| E | 只观测不恢复(维持现状) | ✗ | 不满足 issue;founder 体感问题原样留着 |

## 5. 方案 A 的关键设计决定(研究阶段收口)

### 5.1 新方法命名与形状

`thread/realtime/createResponse`,params `{threadId}`,response `{outcome}`。命名跟随既有面(方法名扁平 camelCase:appendAudio/appendText/appendSpeech/listVoices);语义直接对应 OpenAI `response.create`。🔶 最终名在 research 里跟 codex-oss 命名惯例再核一次。

### 5.2 服务器侧语义:force,经既有队列

恢复调用**必须真的发出去**,不能被 `DefaultResponseQueue` 的 `active_default_response=true` 静默吞成 deferred(如果队列状态是卡死泄漏的,queue-respecting 恢复就是 no-op,恰好治不了要治的病)。语义:经队列走 force 路径 —— 立即 `send_response_create`;若 OpenAI 返回 active-response 错误,按既有竞态处理转 deferred 并把结果如实回给客户端(`outcome: "sent" | "deferred:active-response"`)。队列状态同步更新,不绕过它造二把手。

### 5.3 客户端有界恢复 watchdog

- **武装**:当前 session generation 内,`role=user` 且 final 且正文非空的 transcript 落地(= `barge_in_user_final` 在新世界的等价物;`speakerUserId` 归属结果记入证据,但不作为武装前提 —— 上游听到的是同一段音频,该响就响)。
- **解除**:assistant 的任何响应信号 —— `outputAudio` delta 或 assistant transcript(delta 不进 final 回调,以 `assistantSpeaking` 置位为准)/ assistant final;或新的 user final(重置窗口);或 generation 切换 / `closed` / `error` / teardown。
- **触发**:N 毫秒(`RAYA_VOICE_OPTIONS_JSON.responseRecoveryAfterMs`,默认 🔶 建议 6000 —— R11 正常 2.569s 的两倍多,远小于旧 deadline ~21.5s)无解除信号 ⇒ 调 `createResponse` **一次**;每 armed 窗口至多一次,另设 per-session 上限(默认 🔶 建议 3)防病理循环。
- **失败即放手**:恢复调用返回错误或再等 N 秒仍无响应 ⇒ 只记证据,不再重试。沉默照旧(比现状不差)。

### 5.4 兼容与降级(官方二进制兼容)

方法不存在(JSON-RPC method-not-found)⇒ 记一次 `response_recovery_unavailable` 证据,本 session 内禁用恢复,**其余行为与今天完全一致**。⇒ Raya 可以随时跑回官方 codex 二进制,fail-open,不 fail-closed。

### 5.5 负向护栏(逐条进 plan 的行为规格)

1. ⛔ 不用 `appendText` 重放任何 user 输入(FLY-2031 裁定,B 路)。
2. ⛔ 会议模式(`config.meeting`)默认不启用恢复:会议里人对人说话,user final 不必然期待 assistant 响应,恢复会逼 Raya 插话。
3. ⛔ `assistantSpeaking=true` 期间不武装、不触发。
4. ⛔ 过期 generation 的定时器一律 no-op(与既有 generation-bound 纪律同族)。
5. ⛔ 恢复只造「一个响应」的机会,绝不造第二个:同一 armed 窗口内 createResponse 至多一次;`deferred:active-response` 结果视为「响应在途」,不再补刀。
6. ⛔ 不动 ShipGateFlow / ReadbackGate / VoiceTextMirror / 静音语义 S1–S9 的任何合同。

### 5.6 部署与回滚边界

- 补丁 codex 基于 `rust-v0.151.0` tag(与装机同源)cherry-pick schema 暴露,产出独立二进制(建议落 `~/.flywheel/raya/bin/`);`RAYA_CODEX_BIN` 指向它 —— 只影响 Raya,不动 `.codex-mufasa` 自动更新轨道上的全局 codex。
- 回滚 = `RAYA_CODEX_BIN` 改回官方路径(§5.4 保证客户端自动降级)。二进制部署本身按 Flywheel 规矩走独立 QA + founder 批准,不在本设计单内自作主张执行。
- 并行(不阻塞):把同一补丁提交 upstream PR,若上游接受则未来可回归官方轨道。

### 5.7 证据事件(QA 抓手)

`response_recovery_armed`(可省)/ `response_recovery_attempted{transcriptId, waitedMs}` / `response_recovery_result{outcome}` / `response_recovery_unavailable`。QA 复用 FLY-2031 的隔离场 + fly2031-voice-experience probe 形态做对照轮。

## 6. 影响面与消费者

| 仓 | 改动 | 消费者 |
|---|---|---|
| xrliAnnie/codex(补丁分支,基 rust-v0.151.0) | app-server-protocol 新 experimental 方法 + app-server 转发 + core conversation 入口 | 仅 Raya(经 RAYA_CODEX_BIN);官方轨道零影响 |
| raya | RealtimeTransport 新方法 + runtime watchdog + config 选项 + 证据事件 | voice 进程自身;VoiceTextMirror/ShipGateFlow 等只读 transcript 流,不感知恢复 |
| flywheel(本仓) | 仅设计文档 | — |

## 7. 待研究项(research.md 收口)

1. codex-oss 里 experimental 方法的完整注册链(protocol 宏 → message_processor → turn_processor → conversation)逐文件确认,给出最小 diff 形状。
2. `send_create_now` 的错误前缀匹配(`REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX`)的实际值与 OpenAI v2 错误码,确认 `deferred:active-response` 判定可靠。
3. 客户端 watchdog 与 `Speaker`(appendSpeech 播报)并发时的交互:播报造出的 assistant 响应会解除 watchdog —— 这是可接受的(有响应就不是静默),但要在测试里钉死。
4. method-not-found 的 JSON-RPC 错误形状(code -32601?)在 AppServerClient.request 里的到达形态。
5. 构建链:codex-rs workspace 在本机 aarch64-darwin 的构建可行性与产物体积(研究性构建,不是部署)。
6. R12 的 voice.stdout/stderr 日志与 events.jsonl 全量重读,确认 R12 当时**没有** `thread/realtime/error` 通知(即上游是静默漏发,不是显式报错)—— 这决定 watchdog 是否还要监听 error 通知作为提前触发。

## 8. 不做什么(诚实边界)

- 不修 OpenAI Realtime server VAD 为什么间歇漏建响应(上游黑盒;我们只补客户端合法恢复手段)。
- 不做多次重试/指数退避 —— 一次有界恢复,失败放手。
- 不做会议模式恢复策略(若未来要,走 FLY-1453 产品裁量)。
- 不在本单部署补丁二进制到生产(设计+实现+QA 证据;部署走既有 ship 流程)。
- 不改 thinking 状态的 UI 语义(thinking 挂起超时要不要在文字区提示,属 FLY-1453 产品题)。
