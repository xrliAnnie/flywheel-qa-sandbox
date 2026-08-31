# FLY-2159 语音响应恢复 — 调研
Issue: FLY-2159 (https://linear.app/geoforge3d/issue/FLY-2159/raya语音上游-打断后-attributed-user-final-间歇性等不到-assistant-final装机-schema-无)
日期: 2026-08-31
基于: exploration.md

> 验证基座:codex `rust-v0.151.0` tag(`d8673cb`,与装机 standalone 0.151.0 同源);raya `origin/main` `1c71cd2`。以下行号均对该基座逐文件核实,非凭记忆。

---

## 1. codex 补丁的注册链(exploration §7.1)

以既有 `thread/realtime/appendSpeech` 为模板,端到端链路(0.151.0 逐文件确认):

| 层 | 文件 | 现状(模板) | 新方法要加的 |
|---|---|---|---|
| ① 协议类型 | `codex-rs/app-server-protocol/src/protocol/v2/realtime.rs` | `ThreadRealtimeAppendSpeechParams{thread_id,text}` / `...Response{}` | `ThreadRealtimeCreateResponseParams{thread_id}` / `ThreadRealtimeCreateResponseResponse{}` |
| ② 方法注册 | `.../protocol/common.rs`(client_request 宏,~L1009) | `#[experimental("thread/realtime/appendSpeech")] ThreadRealtimeAppendSpeech => ...` | `#[experimental("thread/realtime/createResponse")] ThreadRealtimeCreateResponse => ...` |
| ③ 分发 | `codex-rs/app-server/src/message_processor.rs`(match 臂) | `ClientRequest::ThreadRealtimeAppendSpeech` → turn_processor | 同形新臂 |
| ④ 请求处理 | `codex-rs/app-server/src/request_processors/turn_processor.rs` | `thread_realtime_append_speech_inner`:`prepare_realtime_conversation_thread` 校验 → `submit_core_op(Op::RealtimeConversationSpeech{text})` | 同形,新 `Op::RealtimeConversationCreateResponse` |
| ⑤ core Op | `codex-rs/protocol/src/protocol.rs`(Op enum)+ core 提交循环 | `Op::RealtimeConversationSpeech` → `handle_speech`(realtime_conversation.rs:1762)→ `conversation.append_speech` | 新 Op → `handle_create_response` → `conversation.create_response()` |
| ⑥ 会话内 | `realtime_conversation.rs` `append_speech`(:1002):经 `handoff.output_tx` 发 `RealtimeOutbound::StandaloneSpeech` 进事件循环 | 新 `RealtimeOutbound::CreateResponseOnce` 变体,事件循环持有 `writer` + `response_create_queue`,在收到时调新的 `force_create_once` |

**结论:全链 6 处、每处都有同形模板,是薄暴露。** 事件循环里 `DefaultResponseQueue`(:365-415)与 `request_create("standalone handoff")` 的既有用法证明第⑥步的接线点可达。

### 1.1 `force_create_once` 语义(exploration §5.2 修订)

0.151.0 的 `send_create_now`(:399)在收到 active-response 错误时**转 deferred**(`pending_create=true`,响应结束后自动再建)。这个语义对 handoff 是对的(语义义务必须兑现),**对恢复是错的**:恢复的合同是「没有响应才造一个」,若服务器说已有 active response,补建第二个 = 双响应风险(负向护栏 ⛔5)。

⇒ 新增 `force_create_once`:无视 `active_default_response` 直接发 `response.create`;成功 → `mark_started` 语义(active=true);收到 `REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX`(实际值 `"Conversation already has an active response in progress:"`,:112,经 `ApiError::Stream` message 前缀匹配,:405)→ **只置 active=true,不置 pending_create**,warn 日志;其他错误 → 走既有 error 事件通路。不复用 `send_create_now`,避免改动既有 handoff 语义。

### 1.2 JSON-RPC 应答形状(exploration §5.2 的第二处修订)

`append_speech` 模板在 channel enqueue 成功后立即返回 `{}`——不等 OpenAI 实发。新方法保持同形:**应答 `{}` 只表示「已受理」**,不承诺 outcome。理由:把 oneshot 回执穿过 `RealtimeOutbound` 会显著加大补丁面;客户端行为在 sent/deferred 两种 outcome 下没有分叉(都是继续等),诊断可读性由 codex 侧 warn 日志 + 客户端证据事件覆盖。exploration §5.2 的 `outcome` 应答字段**取消**。硬失败仍经既有 `thread/realtime/error` 通知面到达客户端。

## 2. 客户端错误形状与 feature-detect(exploration §7.4)

- 未知方法:`ClientRequest::try_from` 失败 → `invalid_request` = **code -32600**、message `"Invalid request: ..."`(message_processor.rs:104-108,error_code.rs:3)。**不是** -32601(-32601 常量存在但此路径不用)。
- experimental 未声明:message_processor.rs:894 拒绝 —— raya 已在 initialize 声明 `capabilities.experimentalApi: true`(packages/contracts/codex-session.ts:46),不触发。
- TS 侧:`AppServerClient` 把 `response.error` 变成 `CodexRpcError(method, code, message)`(AppServerClient.ts:329-336),`code` 可判。
- ⇒ feature-detect:`CodexRpcError` 且 `code ∈ {-32600, -32601}` ⇒ 判 `method-missing`,记 `response_recovery_unavailable` 一次,session 内禁用恢复。两个码都收:上游宏生成的解析路径变体间有漂移空间,收窄反而脆。

## 3. R12 法证重读(exploration §7.6)

- `events.jsonl` 共 51 行;user final(20:45:33.646)与 deadline 释放(20:45:55.108)之间**零事件**,全文件无任何 error/closed 类事件(唯一 "closed" 字样是退出后 `audio_counters` 的 `dropped:closed=1` 计数,属 teardown 后半段)。
- `logs/voice.stdout.log` / `voice.stderr.log` 均为 0 字节。
- ⇒ **上游是静默漏发,不是显式报错**。watchdog 必须是定时器驱动;`thread/realtime/error` 通知只能作为解除/中止信号,不能作为触发信号。

## 4. runtime 现有信号与 watchdog 挂点(exploration §7.3)

- `wireTransport()`(runtime.ts,origin/main):
  - `outputAudio` delta → `assistantSpeaking=true` + `lastOutputAudioAt`(:1029-1037)——**解除信号 1**;
  - assistant final transcript → `assistantSpeaking=false`(:1072-1076)——**解除信号 2**(final 本身即响应完成);
  - user final → `TranscriptLog.appendFinal`(归属窗口 `attributionWindowMs`)→ `realtime_transcript` 证据(:1040-1060)——**武装点**;
  - `closed`/`error` → `LegDown` coordinator 事件(:1108-1125;进程内重连是 founder 禁令,LegDown 走退出)——**中止信号**。
- generation 纪律:所有回调都带 `generation` 并与 `this.state.gen.session` 比对 —— watchdog 定时器闭包必须捕获武装时的 generation,触发时不等再弃。
- `Speaker` 播报(appendSpeech)会在 codex 侧 `request_create` 造出 assistant 响应 → 解除 watchdog。**已知边界**:若上游漏答与 briefing 恰好同窗,briefing 的出声会解除对原问题的恢复;这不是双响应风险(方向相反),接受并记入 plan 的诚实边界 —— 房里有声音,「沉默」症状已消,未答之问由 founder 追问或 FLY-1453 产品裁量接。
- 会议模式:`config.meeting`(runtime.ts:144)与普通模式共用 runtime ⇒ watchdog 必须以 `config.meeting == null` 为启用前提(默认),证据里记 gate 原因。

## 5. 配置面(exploration §5.3 的落点)

`config.ts` 既有 `numberOption`/`booleanOption` + `RAYA_VOICE_OPTIONS_JSON` 严格校验(:214-227)。新增(命名沿用 camelCase 家族):

- `responseRecoveryEnabled`(boolean,默认 `true`;会议模式下强制视为 false)
- `responseRecoveryAfterMs`(正整数,默认 🔶 6000 —— R11 正常延迟 2.569s ×2 余量,远小于旧 barge deadline ~21.5s;FLY-2031 合同:数值全部可改、不作验收阈值)
- `responseRecoveryMaxPerSession`(正整数,默认 🔶 3 —— 防病理循环;超限后本 session 只记证据不再恢复)

## 6. 构建与部署链(exploration §7.5)

- 本机 **无 rust 工具链**(`cargo`/`rustc` 不在 PATH)。⇒ 实现节点前置:`rustup` 安装(标准、可逆)后 `cargo build --release -p codex-cli`(产物 `codex-rs/target/release/codex`);48GB RAM 充足。备选:在 fork 上用 GitHub Actions 构建(上游有 release workflow,但适配成本高于本机装 toolchain,不推荐首选)。
- 补丁基座:**必须**是 `rust-v0.151.0` tag(与装机字节同源),不是 fork 旧 main(2026-02-14,行为漂移不可控)、也不是上游 HEAD(未验证的行为差异)。fork 上开 `fly-2159-realtime-create-response` 分支承载。
- 部署形状:产物落 `~/.flywheel/raya/bin/codex-fly2159`(版本后缀,不抢占 `.local/bin/codex` symlink),`raya.env` 的 `RAYA_CODEX_BIN` 指向它。**回滚 = 改回 `/Users/xiaorongli/.local/bin/codex` 一行**,§2 的 feature-detect 保证旧二进制下行为与今天全等。
- 部署执行不在本单设计内自作主张:走既有独立 QA + founder 批准 ship 流程(exploration §5.6)。
- 上游 PR(方案 D 并行腿):同一补丁可向 openai/codex 提交;不作为本单交付依赖。

## 7. QA 复现面(供 plan 的测试篇)

- FLY-2031 隔离场纪律直接沿用(bot-qa-summary.md「隔离场启动纪律」:删 `apps/voice/dist` 重建、断言孤儿 dist 不存在)。
- 对照轮形态:R11/R12 单变量对照已证明「同句一答一不答」;恢复轮的判据是**注入式**的 —— 上游漏发不可稳定复现,故 QA 用 fake transport/fake app-server 注入「user final 后无响应」剧本验 watchdog,真房轮只验「恢复不误触发」(正常轮 watchdog 零 attempted)+ 长时间轮的证据完整性。真房抓到自然复现是加分不是门。
- 证据事件(见 plan 行为规格):`response_recovery_attempted{transcriptId,waitedMs,generation}` / `response_recovery_result{outcome:"requested"|"method-missing"|"error",generation}` / `response_recovery_unavailable{code}` / `response_recovery_suppressed{reason:"meeting"|"max-per-session"|"assistant-active"}`(可合并进 attempted/result 字段,plan 定稿)。

## 8. 调研结论

方案 A(schema 薄暴露 + 客户端有界恢复)在两侧都有同形模板、全部挂点已存在、回滚边界一行环境变量、官方二进制 fail-open 兼容。修订两处 exploration 决定:①服务器语义从「force+deferred」收紧为 `force_create_once`(active 即放手,绝不补第二响应);②JSON-RPC 应答从带 outcome 简化为 `{}` 受理制。无发现任何推翻方案 A 的事实。

---

## 9. 勘误附录(2026-08-31,Codex design review R1 后;上文不改写,以本节为准)

R1 逐文件核对证伪了本文两处结论,plan 已按新事实重设计:

1. **§1.1 的同步错误假设不成立**。`send_response_create()` → `send_json` → `send_payload` 在 0.151.0 只可能同步报 socket 级错误(连接已关/发送失败,methods.rs:478-495);OpenAI 的 active-response 拒绝走**异步** `RealtimeEvent::Error` 事件,且 `handle_realtime_server_event` 对一切 Error 事件判终止(realtime_conversation.rs:2418 `=> true` → bail,会话死)。⇒ 既有 `send_create_now` 里的前缀匹配分支对 v2 WS 实际不可达;恢复语义改为「本地队列空闲才发 + 接收侧相关拒绝非致命化(`recovery_create_inflight` 标记)」,见 plan §2.1。
2. **队列真名是 `RealtimeResponseCreateQueue`**(realtime_conversation.rs:363),本文与 exploration 写的 DefaultResponseQueue 是误称。
3. 补充两个实施面事实(R1 补列):core 侧 Op 分发还有 `codex-rs/core/src/session/handlers.rs`(:515-575)一处 match 臂 ⇒ codex 补丁是 **7 处**;`prepare_realtime_conversation_thread`(turn_processor.rs:1161-1192)**不查 realtime 是否在跑**,`submit_core_op` 是受理制 ⇒ 未启 realtime 时错误以通知形式异步到达,不是同步 JSON-RPC error。
4. 构建 provenance 需同时记 tag object `d8673cb68e349c208659b986697773d3145dbb14` 与 peeled commit `78c290807ce710180111df227df3b7a4fe845452`。
