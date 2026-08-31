# FLY-2159 语音响应恢复 — 实施计划
Issue: FLY-2159 (https://linear.app/geoforge3d/issue/FLY-2159/raya语音上游-打断后-attributed-user-final-间歇性等不到-assistant-final装机-schema-无)
日期: 2026-08-31
基于: exploration.md、research.md

> 世界标记:[raya] = `origin/main` `1c71cd2`;[codex] = fork `xrliAnnie/codex` 新分支 `fly-2159-realtime-create-response`,基座 **tag `rust-v0.151.0`**(tag object `d8673cb68e349c208659b986697773d3145dbb14`,peeled source commit `78c290807ce710180111df227df3b7a4fe845452`,与装机 standalone 0.151.0 同源;两个 SHA 都进构建 provenance);[flywheel] = 本仓,仅文档 + 锚 PR。
> 合同沿用 FLY-2031:所有时间/数量默认值 🔶 = 可由 `RAYA_VOICE_OPTIONS_JSON` 改的占位,不作验收阈值;验收判据只看行为规格,不看具体毫秒数。
> **Codex design review R1(2026-08-31)修订记录**:R1 证伪了「active-response 拒绝会同步返回给 `send_response_create().await`」的假设 —— 0.151.0 的写侧只报 socket 级错误,上游拒绝走异步 `RealtimeEvent::Error` 且该事件在事件循环里一律终止会话。§2.1 的服务器语义、§2.2 的 watchdog 触发模型、C2/C3/C6/I1 按 R1 重设计;会议模式改为武装前拦截;transport 补 generation 绑定。队列真名是 `RealtimeResponseCreateQueue`(此前误写 DefaultResponseQueue)。
> **Codex design review R4(2026-08-31)修订记录(Lead 裁决 A,三条全采纳照 reviewer 修法)**:①「函数体零 diff」在 Rust 上不可能成立(unit→struct variant 后构造行必须变)—— C5 判据改为**签名/行为/wire 字节等价**,`send_response_create()` 保留签名、构造行改 `ResponseCreate { event_id: None }`,恢复调用名统一为 `send_response_create_with_event_id`;②I5 改**三态判定**(PASS / FAIL-and-redesign / INCONCLUSIVE 可有界重跑)——「没观测到拒绝」≠「schema 无 event_id」,时序 miss 与结构缺失分开;③记账段措辞收窄(generation 门只管 await 后的 result/unavailable,不管已预留计数与 await 前 attempted 证据),11 处清单标注为**生产代码面**、测试/探针面另列。
> **Codex design review R3(2026-08-31)修订记录**:R3 认可精确 event_id 相关模型,收掉四个实施面缺口:①I5 探针原设计不可达(第二次 createResponse 会被本地 active 门跳掉,根本到不了上游)→ 改为**队列之下**的手动探针(§3 I5 重写);②补丁面 10→**11 处**(`app-server/src/bespoke_event_handling.rs` 对 `RealtimeEvent` 是穷举 match,新变体必须加臂)、前缀常量迁 `codex-protocol`(codex-api 不依赖 core,引不到 core 私有常量)、保留旧 `send_response_create()` 不动而新增 `send_response_create_with_event_id`(维持 C5 零 diff 承诺);③客户端 `responseRecoveryMaxPerSession` 钉死校验区间 [1,4](与服务器侧 outstanding 上限 4 成对),`attemptedCount` 改为 await 前同步预留、永不回滚;④S1/S3/S4/§5/§6 的过期区间与计数全部对齐(B1–B21、I5 入 S4 出口、原始上游帧证据独立归档)。
> **Codex design review R2(2026-08-31)修订记录**:R2 证伪了 R1 版的 `recovery_create_inflight: AtomicBool` 相关性设计 —— 无关生命周期事件(先入队的 `ResponseCreated`/`Done`/`Cancelled`)会在拒绝到达前清掉标记,致命竞态仍在;裸布尔还可能误吞 handoff/steering 来源的拒绝。改为**精确 event_id 相关**(§2.1 第 7-10 处):恢复 create 带唯一客户端 `event_id`,解析侧保留上游错误帧的 `error.event_id`,只有精确命中未决恢复 id 集合的拒绝才非致命;状态放 `RealtimeResponseCreateQueue` 内(`handle_realtime_server_event` 已持 `&mut` 队列,单 select! 任务,无跨任务共享)。另:method-missing 记账改 generation-scoped 并在触发时复查(B18/B19);构建命令钉死 `-p codex-cli`。

---

## 0. 一句话

给 codex app-server 的 experimental realtime 面补一个 `thread/realtime/createResponse`(把 codex 内部已有的 `response.create` 通路薄暴露给客户端),再在 Raya voice runtime 加一个定时器 watchdog:**user final 后 N 毫秒无任何 assistant 信号 ⇒ 调它一次**;失败放手,官方二进制下自动降级为今天的行为。

### 0.1 非目标(诚实边界)

- 不修 OpenAI Realtime 上游为什么间歇漏建响应(黑盒;本单只补客户端合法恢复手段)。
- 不做多次重试/退避;不做会议模式恢复(FLY-1453 产品裁量);不改 thinking 状态 UI 语义。
- 不用 `appendText` 重放任何输入(FLY-2031 裁定,⛔);不做 stop+start 会话重启(founder 8-20 进程内重连禁令)。
- 不在本单部署补丁二进制到生产:实现节点交付 PR + QA 证据;`RAYA_CODEX_BIN` 切换走既有独立 QA + founder 批准 ship 流程。
- 恢复**零新增口播**:Raya 不说「让我再想想」之类;用户可见的唯一变化是「本来沉默的地方开口回答了」。
- 上游 PR(把同一补丁提给 openai/codex)是并行加分腿,不是交付依赖。

### 0.2 已知边界(接受并写明,不掩饰)

- **尾巴竞态**:被打断的旧响应,其截断 final/尾音 delta/转写 delta 若在新的 user final **之后**才到,会被当成「有响应」而解除一次 watchdog(客户端面没有响应/条目 ID 可辨源)。后果 = 少救一次,与今天行为等同,零双响应风险。
- **卡死的 speaking 态不救**(R1 修订新增):若被截断响应的 final 一直不到、`assistantSpeaking` 停在 true,watchdog 按 ⛔3 不武装/不触发 —— 该场景与「响应还在进行」在客户端面不可分辨,宁可不救也不冒双响应险;后果与今天等同(沉默)。
- **播报解除**:恰逢 `Speaker` 播报(appendSpeech)造出 assistant 响应,会解除对原问题的恢复 —— 房里有声即非沉默,原问题由 founder 追问接。
- **状态失同步下的兜底是「非致命化」而不是「救活」**(R1 修订新增):若本地队列以为空闲、服务器实际有 active response,恢复 create 会被上游拒绝;补丁把**精确命中恢复 event_id 的**拒绝从「终止会话」改判为「非致命吞掉」——沉默仍在,但会话不死(比今天在同场景下的表现不差:今天根本发不出 create)。
- **无相关性的拒绝仍按今日语义终止**(R2 修订新增):若拒绝帧不带 `error.event_id` 或 id 不命中(含 handoff/steering 来源的拒绝),保持终止 —— 这只发生在会话已失同步(客户端漏收生命周期事件)时,终止走 LegDown 干净退出,不比僵死沉默差。I5 真帧探针在实现期 fail-closed 验证 `error.event_id` 确实存在。
- 恢复是**尽力而为**:createResponse 已受理但上游仍不回,沉默照旧(不比今天差)。

## 1. 架构与流程

```mermaid
sequenceDiagram
    participant U as Founder(语音房)
    participant R as raya voice runtime
    participant X as codex app-server(补丁)
    participant O as OpenAI Realtime(v2 WS)
    U->>R: 说话(打断后说完)
    R->>X: appendAudio(20ms 帧,持续)
    X->>O: 音频流
    O-->>X: user transcript done
    X-->>R: thread/realtime/transcript/done (user)
    Note over R: user final 落地且武装门全过 ⇒<br/>捕获 assistantSignalSeq,调度 N ms 检查点
    alt 正常(R11 形态)
        O-->>X: response + 音频/转写
        X-->>R: outputAudio/delta + transcript delta/done (assistant)
        Note over R: 检查点看到 seq 前进 ⇒ no-op
    else 上游漏发(R12 形态)
        Note over R: N ms 内 seq 未动且 assistantSpeaking=false
        R->>X: thread/realtime/createResponse {threadId}(受理制,回 {})
        Note over X: 事件循环:本地队列空闲才发<br/>response.create(active ⇒ 跳过不排队)
        X->>O: response.create
        alt 无 active response
            O-->>X: response.created + 音频/转写
            X-->>R: 正常响应流(与常规轮无异)
        else 服务器有 active response(本地失同步)
            O-->>X: active-response 错误事件(带 error.event_id)
            Note over X: event_id 精确命中未决恢复 id ⇒ 非致命吞掉,<br/>会话不死;绝不补第二响应;不命中 ⇒ 今日语义终止
        end
    end
```

## 2. 合同变更

### 2.1 [codex] 补丁(**生产代码面 11 处**;R4 修订后)

> R4 说明:下列 11 处是**生产代码面**;C 系列 harness、C9/C10 单测与 I5 探针还会新增/修改 crate 内测试与探针源文件(如 `codex-api` 的 ignored 真上游测试、core/app-server 的测试模块),它们不计入生产面清单,§6 的 provenance 判据据此只约束生产面 diff,允许测试/探针面的非生产新增。

1. `codex-rs/app-server-protocol/src/protocol/v2/realtime.rs`:`ThreadRealtimeCreateResponseParams { thread_id: String }` + `ThreadRealtimeCreateResponseResponse {}`(serde 惯例同 AppendSpeech)。
2. `codex-rs/app-server-protocol/src/protocol/common.rs`:`#[experimental("thread/realtime/createResponse")] ThreadRealtimeCreateResponse => "thread/realtime/createResponse" { params, response }`。
3. `codex-rs/app-server/src/message_processor.rs`:新 match 臂 → turn_processor。
4. `codex-rs/app-server/src/request_processors/turn_processor.rs`:`thread_realtime_create_response_inner`,复用 `prepare_realtime_conversation_thread` 校验(注意:它**不查 realtime 是否在跑**,只查 thread/direct-input/listener/Feature 支持),`submit_core_op(Op::RealtimeConversationCreateResponse)`(acceptance-only),回 `{}`。**未启 realtime 时错误不走同步 JSON-RPC**:core 侧 `conversation.create_response()` 返回 `conversation is not running`,经既有 error 事件通路以通知形式到达客户端(C3/I1 按此写)。
5. `codex-rs/protocol/src/protocol.rs`:Op enum 新变体 `RealtimeConversationCreateResponse`;`RealtimeEvent` 新**内部**变体 `CreateRejected { client_event_id: Option<String>, message: String }`(只在 core 事件循环内消费,**永不**经 `events_tx` 外发 —— 终止路径转成今日同形的 `Error(message)` 再转发,wire 形状零变化)。
6. `codex-rs/core/src/session/handlers.rs`(R1 补列;:515-575 的 Op 分发 match):新臂 → `handle_create_response(sess, sub_id)`。
7. `codex-rs/core/src/realtime_conversation.rs`(R2 重设计;相关性状态全部放队列内 —— `handle_realtime_server_event` 签名已持 `&mut RealtimeResponseCreateQueue`(:2288-2296),与出站处理同属 `run_realtime_input_task` 的单 `tokio::select!` 任务,无跨任务共享,不用 AtomicBool):
   - `create_response()`:同 `append_speech` 形状,经 `handoff.output_tx` 发新 `RealtimeOutbound::CreateResponseOnce`;
   - 队列新增字段 `outstanding_recovery: Vec<String>`(未决恢复 id 集合,服务器侧硬上限 4,客户端本就 ≤ maxPerSession);
   - 事件循环收到 `CreateResponseOnce`(**V2-only:V1 session_kind 一律跳过**)→ `RealtimeResponseCreateQueue::create_once_if_idle(writer)`(**新方法,不改既有 `send_create_now` 与 handoff/steering 的 deferred 语义**):
     - `active_default_response == true` 或 `outstanding_recovery.len() >= 4` ⇒ **跳过**(warn 日志),不发送、不置 `pending_create`(⛔ 绝不排队第二响应);
     - 空闲 ⇒ 生成唯一 `event_id`(如 `recovery-<uuid>`),`send_response_create_with_event_id(event_id)`(R4 统一调用名),成功后置 `active_default_response = true` 并把 id push 进 `outstanding_recovery`;
   - **接收侧非致命化(精确相关,R2 重设计)**:`handle_realtime_server_event` 对新变体 `CreateRejected{client_event_id, message}`:id 精确命中 `outstanding_recovery` ⇒ **非致命吞掉**(从集合移除、置 `active_default_response = true`、warn、不终止、不外发);未命中(id 为 None / 不在集合 / V1)⇒ 还原为 `Error(message)` 按今日语义终止转发。`RealtimeEvent::Error` 本身的处理**一字不动**。
   - **清除规则(R2 竞态修复核心)**:`outstanding_recovery` **不因** `ResponseCreated` / `ResponseDone` / `ResponseCancelled` 清除(先入队的无关生命周期事件不再能洗掉相关性),只在 ①拒绝精确命中时逐个移除 ②会话 teardown 时整体丢弃。残留 id 的唯一代价 = 同名拒绝永远精确可辨,无误吞路径;集合上限防增长。
8. `codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs`:`RealtimeOutboundMessage::ResponseCreate` 由 unit variant 改为携带 `#[serde(skip_serializing_if = "Option::is_none")] event_id: Option<String>` —— `None` 时序列化字节与今天全等(C9)。
9. `codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs`(R4 修订):**保留 `send_response_create()` 原公开签名**,其函数体内唯一一行构造随 variant 形状改为 `ResponseCreate { event_id: None }`(Rust 下 unit→struct variant 后构造行必须变,「函数体零 diff」在语言上不可能成立 —— C5 的验收判据相应改为**签名/行为/wire 字节等价**);新增 `send_response_create_with_event_id(event_id: String)`(恢复路径专用);`send_create_now` 本身不动。同文件 `update_active_transcript` 的穷举 match 补 `CreateRejected` 显式 no-op 臂。
10. `codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_v2.rs`:错误帧解析在 **v2 路径**特例:message 以 active-response 前缀开头 ⇒ 产出 `CreateRejected{client_event_id: error.event_id, message}`(0.151.0 的 `parse_error_event` 现在丢弃 `error.event_id`,protocol_common.rs:68-83);其余错误与 v1/frameless 路径的 `parse_error_event` 不动。**前缀常量迁移(R3)**:`REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX` 从 core 私有迁至 `codex-rs/protocol`(codex-api 依赖 codex-protocol、不依赖 core,引不到 core 私有常量);core 改为 `use` 该共享常量(`send_create_now` 函数体零 diff,仅 use 行变化)。
11. `codex-rs/app-server/src/bespoke_event_handling.rs`(R3 补列):对 `RealtimeEvent` 的穷举 match(:439-558)补 `CreateRejected` 臂 —— 按 **fail-closed error 等价**处理(理论上 core 永不外发该变体;万一外泄,当 error 对待而不是静默吞)。

**关于上游帧形状的前置断言(fail-closed on assumption)**:本设计依赖 OpenAI 拒绝帧携带嵌套 `error.event_id`(= 引发错误的客户端 event id;OpenAI Realtime 官方 server-event 合同如此定义,R3 复核认可)。实现节点在 S4 必须用 I5 真帧探针实录验证;**若实测拒绝帧无 `error.event_id`,停下升级设计修订再审**,不得擅自退化为裸前缀匹配(那正是 R2 否掉的误吞路径)。⚠️ R3 修正:探针**不能**走 `thread/realtime/createResponse` 连发两次(第二次会被本地 active 门跳掉,帧根本不出去)—— 必须在队列之下直接驱动 writer,见 I5 重写。未命中相关性的拒绝按今日语义终止 —— 该场景仅发生在会话已失同步(客户端漏收生命周期事件)时,终止并走 LegDown 干净退出,不比僵死沉默差;此残留边界记入 §0.2。

**稳定标识**:wire 方法名 `thread/realtime/createResponse` 是跨仓合同,冻结;experimental 标记与上游其余 realtime 面一致。

### 2.2 [raya] 客户端(R1 修订后)

**`apps/voice/src/codex/RealtimeTransport.ts`**(generation 绑定,仿 `appendAudio` 家族):

```ts
// 接口新增(runtime 内部 RuntimeTransport 接口与测试 fake/fixture 同步扩)
createResponse(
    expectedSessionGeneration: number,
): Promise<"sent" | "dropped:stale-generation" | "dropped:closed">;
// V2WebSocketTransport 实现:进入时先查 this.generation === expected、this.active、this.threadId,
// 不满足立刻返回对应 dropped:*;满足才发 client.request("thread/realtime/createResponse", {threadId}, 30_000)。
// CodexRpcError(method-missing / 其他 RPC 错)原样向上抛,由 watchdog 分类。
```

**`apps/voice/src/config.ts` + `apps/voice/src/cli.ts`**(R1 补列:选项要经 cli.ts 装进 `VoiceRuntimeConfig` 传给 runtime):

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `responseRecoveryEnabled` | boolean | `true` | 总开关(kill switch;会议模式下无视此值强制关) |
| `responseRecoveryAfterMs` | 正整数 | 🔶 6000 | user final 后无 assistant 信号的等待窗 |
| `responseRecoveryMaxPerSession` | 正整数,**校验区间 [1,4]**(R3:与服务器侧 `outstanding_recovery` 硬上限 4 成对;越界 ⇒ 启动时配置错误拒起,与既有严格校验族一致) | 🔶 3 | 每 session(每 generation)恢复调用上限 |

**`apps/voice/src/runtime.ts`**(watchdog;单一事实源 = 单调递增信号序号,时间戳只进证据):

- `wireTransport()` 维护 `assistantSignalSeq`(单调递增计数器):**任何** assistant 信号 —— outputAudio delta、非空 assistant transcript **delta**、assistant final —— 各 +1(全部 generation-gated;R1 修订:delta 也算信号,响应可先出转写后出声)。
- **武装门(在 user final 处、创建任何状态之前判,R1 修订:会议模式等不再武装后拦,而是根本不武装)**:
  1. `config.meeting` 非空 ⇒ 不武装;首个被拦的 user final 记一次性 `response_recovery_suppressed{reason:"meeting"}`;
  2. `!responseRecoveryEnabled` ⇒ 同上,`reason:"disabled"`;
  3. session 已判 method-missing ⇒ 不武装,零新证据;
  4. attempted 已达 `maxPerSession` ⇒ 不武装,`reason:"max-per-session"` 一次性;
  5. `assistantSpeaking === true` ⇒ 不武装(⛔3;截断 final 未到的卡死场景宁可不救,见 §0.2);
  6. user final 正文空/纯空白 ⇒ 不武装。
  - 全过 ⇒ `armed = {transcriptId, seqAtArm: assistantSignalSeq, atMs, generation}`,`setTimeout(check, afterMs)`(`unref`)。
- **同步失效**:transport `closed` / `error` 回调与 runtime teardown 处**立刻**清 `armed`(不等 LegDown 排队处理;R1 修订)。generation 切换同样即时失效。
- **记账 generation-scoped(R4 修订措辞)**:`recoverySession = {generation, attemptedCount, unavailable}` 随 session generation 切换整体重置。generation 门**只管 await 之后的变更**:`result` 证据与 `unavailable` 置位在 promise resolve 后先核 result 所属 generation === 当前 `recoverySession.generation`,不匹配 ⇒ 丢弃(只记 debug 级证据,不动状态)。**已同步预留的 `attemptedCount` 与 await 前发出的 `attempted` 证据明确不在此门内**(预留永不回滚,见检查点第 6 步)。
- **检查点 `check`**(最新 user final 独占:闭包 transcriptId ≠ 当前 armed.transcriptId ⇒ no-op):
  1. `armed` 已被清 / generation ≠ 当前 session gen ⇒ 静默 no-op;
  2. `recoverySession.unavailable === true` ⇒ no-op(R2 修订:method-missing 在触发时**复查**,不只在武装时查 —— 官方二进制下并行窗口零二次调用);
  3. `assistantSignalSeq > armed.seqAtArm` ⇒ no-op(有响应);
  4. `assistantSpeaking === true` ⇒ no-op(触发前二道 speaking 门);
  5. `recoverySession.attemptedCount >= maxPerSession` ⇒ no-op(计数复查;武装门 4 只挡新武装,这里挡在飞重叠);
  6. 否则:**先同步预留计数 `attemptedCount += 1`(R3 修订:在 await 之前、在证据之前;预留永不回滚 —— 它数的是「尝试」,dropped/error 也算尝试)** → `attempted{transcriptId, waitedMs, generation}` 证据 → `transport.createResponse(armed.generation)` → resolve 后先核 generation 再记 `result{outcome:"requested"|"dropped:stale-generation"|"dropped:closed"|"method-missing"|"error", code?, generation}`;`method-missing`(`CodexRpcError` 且 code ∈ {-32600, -32601},research §2)⇒ 同 generation 前提下:记一次性 `response_recovery_unavailable{code}`、置 `recoverySession.unavailable`、**同步清除当前 armed**(若有,R2 修订 —— 在飞的重叠窗口立即作废)。
- 每个 armed 窗口至多一次 attempted;`attemptedCount` 只增不减,per-generation;suppressed/no-op 不计。多个未决并发窗口也不可能超过 maxPerSession 次 transport 调用(预留在 await 前,B21 钉死)。

**证据事件(稳定词汇,QA 抓手)**:`response_recovery_attempted` / `response_recovery_result` / `response_recovery_unavailable` / `response_recovery_suppressed`。

### 2.3 迁移与回滚

- **迁移:无。** 无持久化 state 变更;evidence JSONL append-only 加新 kind;配置项全部有默认值,旧 env 零改动可跑。
- **回滚双杠杆(相互独立)**:① `RAYA_VOICE_OPTIONS_JSON.responseRecoveryEnabled=false` —— 只关客户端 watchdog;② `RAYA_CODEX_BIN` 改回 `/Users/xiaorongli/.local/bin/codex`(官方 0.151.0)—— feature-detect(B8)保证客户端自动降级,行为与今天全等。
- 补丁二进制落 `~/.flywheel/raya/bin/codex-fly2159`(带版本后缀,不碰 `.local/bin/codex` symlink 与 `.codex-mufasa` 自动更新轨道)。

## 3. 行为规格(逐条可测)

### [codex] C 系列(Rust 测试,复用既有 test_app_server / realtime harness;R1 修订后)

| # | 场景 | 判据 | 层 |
|---|---|---|---|
| C1 | realtime 运行中调 `createResponse`,本地队列空闲 | mock 上游收到恰一条 `response.create`;JSON-RPC 回 `{}` | app-server 集成 |
| C2 | (R2 重写)恢复 create(带 event_id)后按**全部逆序排列**注入真实原始帧:①`create → 先入队的 ResponseCreated → 命中 id 的拒绝`;②`create → 先入队的 Done/Cancelled → 命中 id 的拒绝`;③`create 被接受后 → 稍后一条无关 active-prefix 错误(无 id / 异 id)`;④非前缀错误 | ①②会话**不终止**、`pending_create` 保持 false、后续 `ResponseDone` 不触发第二条 create;③④按原语义**终止**(handoff/steering 拒绝不被误吞) | core 集成 |
| C3 | (R1 重写)thread 存在但未启 realtime | JSON-RPC 回 `{}`(acceptance-only);随后经 error 事件通路出现 `conversation is not running` 类通知;会话/进程不崩 | app-server 集成 |
| C4 | initialize 未声明 experimentalApi | 既有 experimental 拒绝路径生效 | app-server 集成 |
| C5 | 回归:appendSpeech / handoff / steering 的 `request_create` deferred 语义不变 | 既有测试全绿;`send_create_now` 零 diff(仅前缀常量 use 行随迁移变);`send_response_create()` **签名/行为/wire 字节等价**(R4:构造行随 struct variant 必须变,不再承诺函数体零 diff);恢复走独立的 `send_response_create_with_event_id` | 既有套件 |
| C6 | (R1 重写)`active_default_response == true` 时收到 `CreateResponseOnce` | **跳过**:零 `response.create` 发出,零 `pending_create` 置位,warn 留痕 | core 单测 |
| C7 | (R2 重写)`outstanding_recovery` 集合生命周期 | 发送时 push 唯一 id;`ResponseCreated`/`Done`/`Cancelled` **不清除**;命中拒绝逐个移除;达上限 4 时 `CreateResponseOnce` 跳过;teardown 整体丢弃 | core 单测 |
| C8 | (R2 新增)V1 session_kind 收到 `CreateResponseOnce`;及 v1 路径的 active-prefix 错误 | 前者跳过零发送;后者仍走 `Error` 终止(CreateRejected 只在 v2 解析产出) | core 单测 |
| C9 | (R2 新增)`ResponseCreate{event_id: None}` 序列化 | 字节与今日 unit variant 全等(既有 handoff/steering 出帧零变化) | codex-api 单测 |
| C10 | (R3 新增)app-server 侧穷举 match 收到理论上不该外泄的 `CreateRejected` | `bespoke_event_handling.rs` 新臂按 fail-closed error 等价处理(不静默吞);`update_active_transcript` no-op 臂不 panic | app-server/codex-api 单测 |

### [raya] B 系列(vitest,fake transport 注入剧本;R1 修订后)

| # | 场景 | 判据 |
|---|---|---|
| B1 | 正常轮:user final 后 N ms 内 assistant 信号(**delta 或 final 或音频**)到 | 检查点 no-op;`attempted` 零条(真房正常轮同判据) |
| B2 | 漏发轮:user final 后 N ms 零 assistant 信号 | 恰一次 `createResponse(gen)` + `attempted`/`result{requested}` 证据 |
| B3 | 恢复后响应到达 | transcript/mirror/thinking 走既有路径,零新代码分叉 |
| B4 | 恢复后仍无响应 | 同窗口不二发;后续证据只有首次 attempted |
| B5 | 连续两个 user final | 前一窗口作废(latest-owner),只有最新窗口可触发 |
| B6 | (R1 强化)会议模式(`config.meeting` 非空) | **不产生 armed 状态、不产生定时器**、零调用;`suppressed{meeting}` 至多一条 |
| B7 | 超 `maxPerSession` | 不武装、零调用;`suppressed{max-per-session}` 至多一条 |
| B8 | 官方二进制(fake 抛 CodexRpcError -32600/-32601) | `result{method-missing}` + `unavailable` 一次;session 内不再武装;其余行为与今天全等 |
| B9 | 其他 RPC 错误(如 timeout) | `result{error}`;不重试 |
| B10 | (R1 强化)触发前 generation 切换 / closed / error / teardown ⇒ armed **同步清除**;另注入「检查点判定通过后、transport 写之前 generation 才变」的竞态 | 前者零调用零证据;后者 transport 返回 `dropped:stale-generation`,记入 result,不算 requested |
| B11 | ⛔ appendText 零使用 | watchdog 路径 spy 断言 `appendText` 未被调(FLY-2031 裁定的静态+动态双保险) |
| B12 | 播报解除:窗口内 Speaker 播报致 assistant 信号 | 解除,零 attempted(§0.2 已知边界钉死为测试) |
| B13 | `responseRecoveryEnabled=false` | 不武装;`suppressed{disabled}` 至多一条 |
| B14 | user final 正文空/纯空白 | 不武装 |
| B15 | (R1 新增)仅 assistant transcript **delta**(无音频无 final)持续到达 | 视为有响应,检查点 no-op |
| B16 | (R1 新增)`assistantSpeaking === true` 时 user final 到达 | 不武装(⛔3);speaking 恢复 false 后的下一个 user final 正常武装 |
| B17 | (R1 新增)信号与 user final 同毫秒到达 | 以 `assistantSignalSeq` 序判定(seq 在 arm 后 +1 ⇒ 解除),不依赖时间戳分辨率 |
| B18 | (R2 新增)官方二进制并行窗口:user final A 的 `createResponse` promise 未决时 user final B 通过武装门;A 随后 resolve -32600 | A 的结果置 unavailable + **同步清除 B 的 armed**;B 的定时器触发时走 no-op;全程恰一次 transport 调用、一条 `unavailable` |
| B19 | (R2 新增)`createResponse` promise 在 generation 切换后才 resolve | 旧 generation 的结果不改新 generation 的 unavailable/计数/证据状态 |
| B20 | (R3 新增)`responseRecoveryMaxPerSession` 配置越界(0 / 5 / 非整数) | 启动时配置错误拒起(与既有 RAYA_VOICE_OPTIONS_JSON 严格校验族同形) |
| B21 | (R3 新增)maxPerSession 个窗口的 RPC 全部未决时又有新窗口触发 | transport 调用总数 ≤ maxPerSession(`attemptedCount` await 前同步预留、永不回滚,B21 钉死上限) |

### 集成 / 真机(I 系列;R1 修订后)

| # | 场景 | 判据 |
|---|---|---|
| I1 | (R1 重写)raya ↔ 补丁 codex 真二进制:未启 realtime 的 thread 上调 `createResponse` | JSON-RPC 回 `{}` 且随后收到 error 类通知(而非 -32600)⇒ 证明方法已注册、schema 缺口已补(**不消耗 OpenAI realtime 额度**) |
| I2 | raya ↔ 官方 0.151.0 真二进制:同一调用 | 收到 -32600 `Invalid request` ⇒ B8 feature-detect 走真错误形状,非拟造 |
| I3 | 隔离房正常轮(FLY-2031 隔离场纪律:删 dist 重建、断言孤儿 dist 不存在) | 全程 `attempted` 零条;念读/文字镜像/静默/audio_counters 与 R16 硬门同绿 |
| I4 | 隔离房长时轮 | evidence 完整性:新 kind 不破既有 judge;若自然命中漏发则 attempted→响应链完整(加分,不是门) |
| I5 | (R4 重写,三态判定)真帧形状探针,**队列之下直接驱动 writer**(原「连发两次 createResponse」不可达:第二次被本地 active 门跳掉,帧不出去):在补丁源码上加**稳定命名**的手动 `#[ignore]` 真上游测试(codex-api,建议名 `realtime_recovery_rejection_event_id_probe`),拿低层 `RealtimeWebsocketWriter`,在真 v2 会话里直接发两条各带唯一 event_id 的 `ResponseCreate` 帧(第二条在观测到第一条的 `response.created` 后立发),实录两条原始请求帧 + 全部响应帧 | **三态**:①PASS = 实际观测到 active-response 拒绝且其嵌套 `error.event_id` 精确等于被拒客户端 id;②FAIL-and-redesign = 观测到 active-response 拒绝但嵌套 id 缺失/不匹配 ⇒ **停下、上报、设计修订再审**;③INCONCLUSIVE = 没观测到 active-response 拒绝(第一响应可能在第二帧到达前已完成 —— 时序 miss ≠ schema 缺失)⇒ 可重跑:改用刻意加长的第一响应,或两帧背靠背直发;重跑只存在于手动探针,生产恢复路径永不重试。探针名、精确命令、所需 env、有界重跑规程与归档 trace 路径一并写入证据;生产 `create_once_if_idle` 门不为探针削弱;唯一消耗少量 realtime 额度的探针,Lead 排窗口 |

## 4. 实施阶段(实现节点执行;每步过测试再进下一步)

| 步 | 内容 | 出口判据 |
|---|---|---|
| S0 | 实现前置:本机装 rust 工具链(rustup,标准可逆);fork 上从 `rust-v0.151.0` 开 `fly-2159-realtime-create-response`(provenance 记 tag object + peeled commit 双 SHA) | `cargo test -p codex-app-server-protocol` 基线绿 |
| S1 | [codex] 十一处补丁 + C1–C10 | 目标 crate 测试绿;`cargo build --release -p codex-cli` 产出并归档 `codex-rs/target/release/codex`(aarch64) |
| S2 | [raya] transport `createResponse(gen)` + config/cli 三项([1,4] 校验)+ RuntimeTransport 接口与测试 fake 同步扩 | 类型/配置单测绿 |
| S3 | [raya] runtime watchdog + 证据 + B1–B21 | `pnpm --filter @raya/voice test` 全绿 |
| S4 | I1/I2 双二进制集成 + **I5 真帧探针(fail-closed 出口判据,三态)** | I1/I2 两种真实形状(`{}`+通知 vs -32600)实录;I5 必须以 **PASS** 收口才进 S5(INCONCLUSIVE 按有界重跑规程重试;FAIL-and-redesign 停下上报设计修订) |
| S5 | I3/I4 隔离房轮(Lead 安排真环境窗口) | evidence JSONL + SHA-256 归档,FLY-2031 纪律 |
| S6 | 双仓 PR + flywheel 锚 PR(见 §7 ship 段) | PR body 含变更摘要 + 测试计划;code review 门走既有流程 |

## 5. 测试证据要求

- Rust:`cargo test -p codex-app-server -p codex-core -p codex-app-server-protocol -p codex-api -p codex-protocol`(realtime 相关目标;R2 起含 codex-api 序列化/解析测试,R3 起含 codex-protocol 常量/变体)输出留档。
- TS:`pnpm --filter @raya/voice test` 全绿输出留档;B 系列逐条对应测试名。
- I 系列:I1/I2 的 app-server JSON-RPC 帧、隔离房 events.jsonl 及 SHA-256;**I5 的原始上游 WebSocket 请求帧与拒绝帧单独归档**(R3:与 app-server JSON-RPC 证据分开,不混一个文件)。
- 判 PASS 前拉对应 head 的 CI 结论(raya 仓 CI;flywheel 仓 CI 对文档分支)。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 恢复 create 撞上服务器 active response → 错误事件杀会话(R1 发现的原设计致命伤;R2 发现裸布尔相关会被先入队生命周期事件洗掉) | 三层:本地队列空闲才发(C6)+ 接收侧 event_id 精确相关非致命化、不因生命周期事件清除(C2 全排列/C7)+ handoff/steering 原语义零改动(C5/C8);相关性前提由 I5 真帧探针 fail-closed 验证 |
| 补丁二进制与装机 0.151.0 行为漂移 | 基座钉死同源 tag(双 SHA 留档);**生产面** diff 只含 §2.1 十一处(测试/探针面新增另列,不入生产面判据);C5 回归 |
| 上游 experimental 面未来改名/删除 | 恢复整条链 fail-open(B8);升级装机版本时 I2 形态的探测轮先行 |
| watchdog 误触发造成插话 | 武装门六条(§2.2)+ 触发前 seq/speaking 双查 + 真房 I3 正常轮零 attempted 硬门 |
| 双响应 | codex 侧 create_once_if_idle 不排队(C6)+ 拒绝不 defer(C2)+ 客户端单窗单发(B4)三层保险 |
| toolchain 安装失败/构建不过 | S0 独立出口判据,失败即上报 Lead,不 silent 降级 |

## 7. Ship 段:外部仓派工铁律(Lead 指令 b8a5368f,2026-08-31,原样入档)

本单代码在 raya 仓(worktree 按流程),但这是 flywheel 编排的外部仓 issue。FLY-2031 用血换来的规矩(FLY-2203 死锁教训),实现节点必须照办:

1. **implement 开工时先在 flywheel 主仓开 docs/进度锚 PR**(分支 = 本单 flywheel 分支 `flywheel-FLY-2159`)。
2. **会话 PR 登记(`complete --pr`)必须用【flywheel 锚 PR 号】,绝不许登记 raya 仓 PR 号** —— 登记错仓 = ship 卡永久死锁且事后修不了(FLY-2203)。
3. **raya 仓 PR 在锚 PR body 里列为伴生**,merge 需 founder 单独授权。

codex fork 分支同理按伴生处理:在锚 PR body 里列出 fork 分支与构建 provenance(双 SHA),不单独登记。
