# FLY-2655 语音收音恢复 — 实施计划
Issue: FLY-2655 (https://linear.app/geoforge3d/issue/FLY-2655/2598follow-up-raya-rg-语音会话-live-10-秒即-faileddiscord-audio)
日期: 2026-09-20
基于: research.md

Status: REVIEW_REQUIRED — 2026-09-20 realtime correction; historical approvals below do not approve the new transport. See design-correction.md and §11.
Correction-SHA256: da6b77517031e4066523dbdb0f765a913b72108708556baed7ed7db3dfd50a17 (本轮评审必须同时读取此附录；摘要变化须重新审阅)

Historical Status: APPROVED — current continuation question 237a872c-918f-41cb-8fe7-86e6c2ed6e81, request 6ea79df4-c7a1-48d7-9db0-a0a701c2cf8b, effective reviewVerdict=APPROVED. Historical R3 question 42655ad9-f6c8-4780-925f-8ba2f3b64d9c remains lineage only. Current advisories and inherited dispositions: review-disposition.md; raw current verdict: continuation-design-review.json.

前提更正（Lead 问题 `030dc6c0-4048-4478-aa95-c95c9e2aee73` 已确认）：issue 的“voice-codex 没带 davey”前提作废；cli 复用 voice-bridge createDiscordDeps，pnpm-lock 已带 davey 0.1.12。原场具体解密失败根因仍 **未验证**，不能将有界恢复当作根因已修复。下一场取证方法见 §7.1。

## 1. 目标、权威与交付顺序

保留 Discord DAVE 加密，让接收流故障只降低收音能力，保留仍可用的 Lead 播报；通过有界重新订阅恢复接收，并把健康状态持久化/显示。补齐标准 Codex Lead 可调用的自身语音入口，让 founder 在 #raya 说「语音」即可由 Raya 发起 RG。

本计划不把“未直接声明 davey”作为根因：voice-codex 已经复用 voice-bridge 的 SDK glue，锁定依赖含 davey。当前确证是接收 error → 整场 failed，具体失败包来源仍待 QA 证据。应用层容错不是密码协议修复；若持续失败，真人收听验收必须保持未通过，按同一问题补充证据，不改成“只要播报可用”。

Lead 问题 `3be29af8-0ec9-4397-9295-25570215f846` 的 2026-09-17 答复裁定：

- 生产 Raya 是标准 codex-lead-tui-runtime 载体，但旧 deploy-receipt schemaVersion=1 无 carrier，不能推断已完成 v2 激活。
- FLY-2496 割接依赖 FLY-2657 工具修复与 founder 授权。设计以标准载体为目标，不恢复旧 CoS voiceIntent，不修改凭据。
- 新能力显式 opt-in，激活由 Lead 执行并经 founder 把关；不得默认放开。
- 第一验收组（RG+meeting 真人双向音频）可独立执行；第二组（#raya 自主发起）标为“割接后验”。两组都属于本 issue，不能把第二组删除或冒充完成。

实现顺序 A 依赖/接收 → B 健康持久化/卡片 → C opt-in 标准 Lead 入口 → D 隔离测试与529装房 → E 合入前founder真人验证 → 获准合入/独立updater紧急部署。设计节点只提交本文和报告。合并、独立 updater 部署、Lead 激活、真房验收各自留收据。

## 2. 固定不变的合同

- voiceRoom、projectName/leadId、voiceBotUserId、guildId/channelId、sessionId、threadId 来自既有 resolver/claim projection；显示名不能选 bot 或路由。
- 一房一场、lease 失权立即停流、当前注册表与 self-filter 检查、boundChannelIds、语音镜像和正常回复排除规则不变。
- 不切 Gemini，不启旧 huddle daemon，不增加 bot，不改 OPENAI_API_KEY 交付方式，不给模型 Bridge master/ingest token。
- meetingId port 留兼容用途，不能改为假 meetingId 触发 RG。不新增全局“最后一场”状态或从最新文件名推断目标。
- 不把 codec/接收恢复中的成功当作业务交付；保持 mailbox 与 outbound 的独立回执。

## 3. DAVE 与接收故障隔离

### 3.1 唯一 SDK glue

改 `packages/voice-bridge/src/bots/discordWiring.ts`，为 `createDiscordDeps` 添加可选、类型化 receivePolicy 参数；无参数调用的旧 voice-bridge 保持原行为。voice-codex `cli.ts` 显式传入：

```ts
{ daveEncryption: true, decryptionFailureTolerance: 36 }
```

这两个值固定当前0.19.2已存在的默认值，今天不改变协议行为，只防止上游默认漂移，不能计为解密修复。版本/诊断解析在声明davey依赖的voice-bridge glue包内执行；voice-codex不直接import davey，干净pnpm安装必须验证相同解析路径。

参数在 glue 内只映射到 joinVoiceChannel 的对应公开选项；group 仍为 bot ID，selfDeaf=false。禁止负数、NaN、Infinity，禁止从用户文本透传这些值。不添加重复 davey 依赖，不升级版本，不修改 node_modules，不调用私有 setPassthroughMode，不 monkey-patch SDK。

给 DiscordDeps 增加可选 `receiveEvents(conn)` seam，提供 `onTransition(cb): unsubscribe` 与 `isSpeaking(userId): boolean`，来自公开 transitioned 事件和 speaking map；Room start 时订阅，stop 时解除。连接级 error/stateChange 仍走现有致命/生命周期路线，不能伪装成 receive error。若需要连接监听补齐，只加安全 error handler 和固定 reason；不发起应用层无限 rejoin。

启动诊断通过同一 glue 解析 voice/davey 版本、Node/arch、DAVE configured=true、容错数；记录固定字段，禁止直接转存 SDK debug/完整 dependency report 到 founder 卡片。缺库/原生加载失败是启动能力失败，不能在无 DAVE 的情况下静默进房。

### 3.2 新接收状态机

新增 `packages/voice-codex/src/receive-health.ts`，纯类型与状态转换；`discord-room.ts` 持有实例。对外状态只用一套定义，从 voice-codex 导出不会合适（teamlead 是其上游依赖），因此共享 DTO 放在 **voice-core** `src/receive-health.ts`，并从该包 index 导出；Room 特有计时/重试逻辑仍在 voice-codex。

```ts
type ReceiveState = 'unknown' | 'receiving' | 'degraded';
type ReceiveReason = 'awaiting_audio' | 'dave_decrypt' | 'opus_decode'
  | 'receive_packet' | 'receive_no_pcm' | 'retry_exhausted' | 'audio_observed';
type ReceiveHealth = {
  version: 1; sequence: number; state: ReceiveState; reason: ReceiveReason;
  failures: number; retries: number;
  lastPcmAt: string | null;
};
```

整数为非负 safe integer；sequence 从 1 单调递增，仅在状态/原因或要发送的计数快照变化时增长；计数饱和到 MAX_SAFE_INTEGER。时间为有效 ISO，lastPcmAt 只代表本机观测，不授权或计算 lease。Bridge 另写 server observedAt/bootId，不信任客户端时间的新鲜度。health 是单独维度，绝不新增 lifecycle `degraded` 值或覆盖 terminal reason。

| 触发 | 接收处理 | 会话/播放 |
|---|---|---|
| start / 新 room | unknown/awaiting_audio | 可 warming/live，卡片“等待你说话” |
| 当前 capture 产出连续 10 个完整 20ms PCM 帧，期间无 error | receiving/audio_observed；只证明解码，不证明识别/听见 | 正常 |
| 当前 Opus stream 的任何 error（DAVE、AEAD、RTP解析等） | degraded/dave_decrypt 或 receive_packet，丢坏包，清采集并退避重订阅 | 不 resolve ended，不 fence，播放继续 |
| 当前 decoder error | degraded/opus_decode，同样清采集，单独计数 | 播放继续；反复发生同样熔断 |
| admitted 人有 speaking 包但该 capture 2 秒无有效 PCM | degraded/receive_no_pcm；静音无人 speaking 不触发 | 继续播放；处理库吞包/reinitializing 无 stream error 的情况 |
| 3 次重订阅额度耗尽 | degraded/retry_exhausted，30 秒 cooldown | 文字仍可 stop，提示收音暂不可用 |
| token/身份/lease 失效，frontend 退出，未知连接致命错误 | 不归类为接收降级 | 既有 failed/结束清理 |

恢复计数来自 decoder 当前 capture 的真实 PCM，不来自 Uplink.tick 的静音、不来自输出流。可解码的静音仅证明接收链有帧；显示“已接收音频”而非“已听见你的话”。真人 VAD/转写另验。是否降级由到达通道决定：当前 capture 的 opus.on(error) 一律是接收包失败，不再按错误文字决定 fatal。固定前缀 DecryptionFailed( / Failed to decrypt: 仅选 dave_decrypt 标签，其余包含 AEAD 认证失败、Failed to parse packet、RTP RangeError 统一 receive_packet；decoder.on(error) 单列 opus_decode。身份、token、lease、frontend 和连接级 error 在独立通道保持致命语义。固定 reason 日志与原始错误隔离。

### 3.3 Capture 身份、清理与有限重试

Capture 扩展 `{generation,userId,opus,decoder,settled,pcmFrames}`。generation 为 room 内递增整数；先设置 current capture，再 pipe。同步 subscribe/createDecoder/pipe 抛错也由同一局部清理处理，不能漏出到进程 unhandled；这些是构建/连接故障，清理后经独立 fatal 通道上报，不冒充包解密错误。Room options 增 assertLease()，cli 从当前 context.lease.assert 传入，所有重试/数据转发调用它。每个 data/error/close callback 第一行检查 `!stopped && capture === current && !capture.settled`；老 capture 回调只清自身资源，不碰新的 capture。

故障清理一次：标 settled，解除 pipe，destroy 两个流；取消该 capture watchdog；`uplink.setMicOpen(false)` 清 VAD/jitter/frames，`uplink.speakingEnd(userId)` 清 owner；attribution.speakingEnd 结束该 epoch；activeSpeaker 清空。**不调用正常 endUtterance 去 drain 残片，不清空历史 attribution epochs，不合成 transcript/delivery**。已被 Realtime 接受的合法音频不能撤回；其迟到 final 继续经过既有唯一说话人检查，混合归属拒绝。有效语音片段可能变成不完整一句；卡片要求重说，不能伪称无损恢复。

重试条件：当前 session/lease 有效、未 stopping、该用户仍 admitted 且在 speaking map、无 current capture、上个 opus close 已观察到。等 close 才重订阅，SDK close 尚未清除映射时不取回 destroyed stream。close 超过 1 秒未到则计为一次失败，不密集轮询；清理自身监听，等下一 cooldown。

每个 room 全局共享三次重订阅额度，错误后分别延时 250ms / 1000ms / 3000ms；不能由不同用户/新的 speaking.start 绕过。每次 timer 和 await 后重新核 lease/stopped/capture generation。连续发言通过 timer + isSpeaking 恢复，不依赖新 start；已停止发言则保留下一次 start 可用的额度、不空重试。成功收到 10 帧后恢复显示，但额度只有 **连续 30 秒无故障** 才重置，防止一帧成功诱发风暴。

耗尽后开启 30 秒 cooldown；期间不建新 decoder/subscription。期满有 admitted 人仍在说话或有新 start，允许一次 probation；成功且稳定 30 秒再给完整额度，失败再 cooldown。transitioned 只能唤醒符合上述预算的 probe，不能清预算或自行声明健康。最多一个 timer 和一个 capture，stop/lease fence 取消全部 timer，所有异步 callback 后再次核身份。

重新订阅只替换接收流，不重置 networking.state.dave 或连续失败计数。持续DAVE错误会在每次新订阅的首包继续失败；退避数字不是协议恢复杠杆。成功路径仅适用于后来包已经可被原DAVE状态解开或库自身完成状态切换。持续失败须维持degraded，真实收音仍判失败。记录 subscribe_attempt 与 first_pcm 分开，不能把“尝试过”叫“恢复过”。lastTransitionId为falsy时可抛错，但已执行transitionId=0也可能falsy，因此不能据异常断言“从未完成任何transition”；§7.1继续取证。

## 4. 会话健康从进程到卡片

### 4.1 Room → Session → renew

`RoomHandlers` 新增 onReceiveHealth；GenericVoiceSession 保存最新 snapshot，通过 ActiveVoiceSession `receiveHealth()` 给 SessionLifetime；`BridgeVoiceClient.renew` 可选 body `{receiveHealth}`。不另建阻塞网络循环。每次 renew 重发当前 snapshot， lost ACK 使用相同 sequence；本地 evidence 立即记录，卡片在下次 renew 后可见。watchdog/重试不等待 HTTP，原 4 秒 renew 与本地 lease deadline 优先。

### 4.2 Bridge/存储

`voice_sessions` 增加 nullable `receive_health TEXT`、`receive_health_observed_at TEXT`、`receive_health_boot_id TEXT` 与 `receive_card_digest TEXT`；采用 addColumnIfMissing，不删/重写旧证据。JSON 使用 voice-core DTO 的严格 validator，字段上限/枚举固定。

renew 路由仅接受 master + 当前 lease，与已有 validateSession 合用。store 在同一 transaction 检查非终态、token、expiry、boot，更新 lease 与健康：

- 同 boot 新 sequence：写 snapshot 与 server observedAt。
- 相同 sequence+同值：幂等；可刷新 server observedAt，不能增加 failures/retries。
- 相同 sequence+不同值：400 health_sequence_conflict；更低 sequence：忽略健康但正常续 lease，返回 acceptedHealthSequence 供诊断。
- 缺 health：兼容旧 daemon，只续 lease，不刷新 health 时间。
- 非法 body：400；BridgeVoiceClient.renew 在同一次调用内部捕获400，先重核本地lease/stop，再立即只重试一次无health的renew，使用这次请求的sentAt安装lease；不等待下一次4秒调度。无health成功才返回外层，SessionLifetime.missed保持/重置为0，400本身不消耗miss。fallback也失败才算一次真实renew失败；401/409/lease失效仍按原失权终结，不做此回退。记录固定health_publish_failed，不能让展示编码bug杀掉可播放会话。
- 新 claim/新 boot：清健康为 null，不能延续旧 receiving；终态保留最后观测用于取证，GET 不把它表示为当前收音。

所有 SQL 用绑定参数。GET `sessionBody` 增加 nullable receiveHealth，投影包含服务端 observedAt 及 derived fresh（server now-observedAt ≤ 3×leaseRenewMs 且 session 活跃/lease 有效）。旧行/旧 daemon/过期显示未知，不能用 updatedAt 代替健康上报时间。

### 4.3 根卡投影与失败重试

新增 `bridge/voice-session-card.ts`：纯 renderVoiceSessionCard(row,now) 和编辑调度，使用既有根消息 ID、其父 chatChannel、当场 Lead token；每条文本以 📻 开头，allowed_mentions.parse=[]。服务从固定 registry 身份取 channel，不接收模型指定任意目标。

内容包括 mode、session 短 ID、生命周期、收音说明、文字 stop 提示。degraded/dave_decrypt 显示“收音暂不可用（加密音频未解开），文字回复仍可播报，请稍后重说”；不是“E2EE 已关闭”。receiving 显示“已接收音频；对话是否成功以实际回复为准”。终态显示原因并盖过健康。

卡片投影使用独立 CardProjector timer（3秒），由 services 与 runtime 同生命周期 start/stop；VoiceSessionRuntime.tick 绝不 await 卡片 PATCH，也不等待卡片重试。projector 每轮按sessionId游标最多扫描25行，单独in-flight guard、并发1、每次PATCH timeout≤2秒，运行中下一轮跳过，不影响outbound poll/renew。stop abort在途请求并禁止后续调度。

按会话计算渲染内容digest，变化才PATCH。成功后参数化写digest；HTTP失败不写成功，30秒→300秒退避；重启从已持久健康与成功digest继续，不新发根卡、不重开会话。await validateSession 后、发送前重读state/root/identity；发送中更新了终态，旧结果不得标终态已收敛，下轮更正。

扫描资格明确限定 receive_health_observed_at 非null且root存在的新观测会话；老终态/null-health行不回填、不追发卡片。活跃健康过期时投影未知；终态且digest未匹配最终内容才重试，匹配即退出。长期403/404最多每300秒一次并留固定诊断，不改session状态。卡片不能替代stop或活性证明。

## 5. 标准 Lead 自主入口：现有 broker 上的显式能力

### 5.1 操作与授权

在现有 capability catalog 新增三个 operationId，scope 都是 canonical-project-lead，credentialConsumer=bridge：

| operationId | 分类 | 严格 input | 成功结果 |
|---|---|---|---|
| voice.session.start | write | `{mode:'rg'|'meeting', topic?:string(max200), meetingId?:uuid}`；meetingId 仅 meeting | sessionId、threadId(nullable)、mode、state、accepted:true |
| voice.session.status | read | `{sessionId:uuid}` | 自身会话的 sessionBody DTO |
| voice.session.stop | write | `{sessionId:uuid}` | 同 sessionId 与 state |

MCP proxy 已按 catalog/manifest 自动暴露单个 lead_operation 工具里的 oneOf 操作变体；不往 legacy lead_actions 再造一套工具。通过现有 lead-operation envelope UUID requestId 与 parent broker 传输；parent-only handler `handlers/bridge-voice.ts` 固定调用 `/api/lead-capabilities/voice` 与只读 `/voice-receipt`，不执行 shell、不传 token 给模型。输入不允许 project/lead/bot/channel/token/url/health 字段，路径不能来自模型。

新增 raw registry 可选布尔 `codexVoiceActions`，**只有显式 true** 才可能授予；与 voiceModes 是不同层：voiceModes 表示该 Lead 可使用哪种语音，codexVoiceActions 表示是否允许其模型主动操作。config types/parser、编译身份摘要、capability resolve、manifest、运行时 assertCurrent、Bridge scope 均读取同一 raw 值；缺省 false，不把已有 voiceModes=true 回填成授权。

resolveLeadCapabilities 新增声明确切的voice operation集合：raw opt-in=false/缺省时，三个操作既不进入operations，也不进入missingOperationIds（合法未授权，不是缺provider）；不能放松其他操作的runtime_capabilities_incomplete硬检查。raw opt-in=true时，只有bundle2 + bridge provider + 当前标准dept identity全部满足才加入，缺provider仍作为missing报错。非opt-in的v2 Lead必须能正常启动。Bridge `lead-capability-voice.ts` 复用 captureLeadCapabilityScope，验证 carrierClaim/identityDigest/activation，检查 raw opt-in 与 voiceModes，identity 由 context 固定。start 只为自身 project/lead 解析；status/stop 先参数化取 session，再比对 project/lead，foreign ID 返回统一 scope_denied，无存在性信息。

Bridge route 必须使用与其他 lead-capability 路由相同的 parent bearer + carrier proof，不把全局 generic voice master 路由变成模型可直接代理的任意请求。每个外部 await 和 reserve/stop 前重核 current scope。活跃会话 bot/room 还须匹配冻结 projection/current registry；不能凭同名 session 接管另一个 bot。

### 5.2 幂等与丢回执

provider 侧增加 `voice_intents` 表：`(project_name,lead_id,request_id)` PK，operation_id、input_digest、session_id nullable、result_state、created_at；外键/索引遵循 StateStore 现有约定。它只保存三项 voice 操作的 durable mapping，不替换 broker operation receipts。

start 在完成只读 resolver/preflight 后，在 **同一个 StateStore transaction** 插入 intent 与 reserve session；已有同 requestId/digest 返回原 session（包括终态），不同 digest/operation 返回 conflict。不允许先写 intent 后独立 reserve 形成丢映射窗口。外部 Discord provisioning 在事务后，用已有 provisioner 幂等恢复；provision 不确定时结果 unknown/pending，reconcile 只查已绑定行，绝不再 POST start。

首次新 requestId 遇 active room：exact project/lead/mode/guild/channel/bot tuple 一致且未 ending 时，可把本次 intent 绑定现有 session；不同 tuple、不同有效 meetingId 或 ending 时仍 conflict。room UNIQUE 保留为并发防线。终态后重放原 requestId 返回旧终态，只有新意图/新 requestId 才可新开。失回执必须重用 requestId，不能以随机重试 UUID 突破约束。

stop intent 与既有 stopVoiceSession 状态更新同事务。重复 stop 返回当前/终态，不影响下一场。status 无写入；receipt-only route 只查映射与 session，不 provision、stop 或重开。模型返回不含 leaseToken、carrierClaim、credentialTier 或 secrets。broker succeeded 在此只表示请求已受理，有效音频仍未证明。

### 5.3 发现能力与激活门

在 `packages/teamlead/lead-rules-base/department-lead-rules.md` 增加通用说明：从当前 manifest 查 voice 操作；当 founder 对自己说“语音”且 rg 可用，用自己的 RG；“开会”用 meeting 并保留真实 meetingId（有则传，无则直接 meeting）。保存请求 UUID，收到 sessionId 后查询状态/发送对应 thread 链接，收到 unavailable 报具体能力缺项，不找工程 Lead 代起作为自主入口通过证据。

legacy CLI 继续是运维和兼容工具，不给 capability-v2 模型恢复 CLI 凭据。旧 meeting port 不改。若当前载体没有 v2 激活，只如实不可用；**部署新代码不会自动授予 codexVoiceActions**。

Lead 激活步骤（不是本节点动作）：FLY-2496/2657 割接完成 → 记录当前 carrier activation/manifest/deployed SHA → founder 明确批准 Raya 语音能力 → Lead 将 raya/raya raw codexVoiceActions=true 并走既有受管重编译/激活 → 保存 grant/activation/manifest digest 回执 → 验实际模型 tools/list 的 lead_operation.inputSchema.oneOf 含三项operationId字面量，manifest.operationIds也含三项，再验真实调用；不期待三个独立tool名称。撤销则 false/移除并重建 manifest；broker 与 Bridge 即时拒绝 stale activation。撤销不自动杀掉既有会话，Lead 用既有运维 stop 精确结束。

## 6. 实现任务与红绿验证

每项：先新增以下失败场景，运行定位测试确认红，再最小实现，运行同组确认绿，独立 commit；不要提前修改生产或派后继。测试采用现有 vitest stream/clock/fetch 注入；具体函数名允许跟当前接口统一，以下断言语义不可减少。

### A — 接收恢复与 SDK 配置

文件：voice-core `src/receive-health.ts,index.ts`；voice-bridge `src/bots/discordWiring.ts`；voice-codex `src/receive-health.ts,discord-room.ts,session.ts,cli.ts,pipeline/Uplink.ts`；对应 `__tests__/discord-room.test.ts,session.test.ts`，新增 `receive-health.test.ts` 与 voice-bridge wiring policy tests。

- [ ] 加失败测试：同一连续 speaking，Opus destroy(exact DAVE error)，第2 capture 可收到10帧且不触发 fatal；播放 feedOutputAudio 正常。
- [ ] 补 fake timers：250/1000/3000 顺序；无新 start 仍重订阅；close 不到不重用旧 stream；超预算30秒仅一次 probation；10帧后30秒内再次失败不重置额度。
- [ ] 补老 generation data/error、同步 throw、stop/fence/leave 与 timer 竞态；VAD/队列残片不再发送；迟到 final 不错误归属新用户。
- [ ] 将当前opus stream全部error/decoder错误路由到receive health，补AEAD认证失败、Failed to parse packet、RangeError及未知packet error测试；独立身份/lease/frontend/connection错误仍fatal；显式 DAVE policy、公开事件 unsubscribe。
- [ ] 安装分支探针纳入 lock-version fixture，验证36/37路径；依赖报告只读 smoke，no network。

### B — 健康贯穿 renew 与卡片

文件：voice-codex `bridge-client.ts,daemon.ts` 与测试；teamlead `StateStore.ts`、`bridge/voice-session-{routes,services,runtime,provisioner}.ts`、新增 `voice-session-card.ts`；`StateStore.voice-session*.test.ts` 与对应 bridge tests。

核心用例断言示例：

```ts
expect(sessionOutcome).toBeUndefined(); // 接收故障不终结
expect(status.state).toBe('live');
expect(status.receiveHealth.state).toBe('degraded');
expect(renewAfterLostAck.acceptedHealthSequence).toBe(first.sequence);
expect(renderedCard.startsWith('📻')).toBe(true);
expect(outboundFromCard).toEqual([]);
```

- [ ] 旧 schema 迁移、null health、旧 daemon renew、same/lower/conflicting sequence、wrong boot、过期 lease、终态拒写全覆盖。
- [ ] 400在BridgeVoiceClient.renew同调用内立即去health重试成功，SessionLifetime.missed不增加且无4秒等待；fallback失败只计一次miss，409仍fence。独立CardProjector PATCH挂起/超时期间outbound tick计数与renew不延迟。
- [ ] root PATCH 首次失败重试、重启后 pending、终态覆盖、403/404退避；卡片/警告不进入朗读。
- [ ] 只静音/无人 speaking 不变 degraded；10帧只给 receiving；health freshness 过期显示未知。

### C — opt-in 标准 Lead 操作

文件：config `src/codex-lead-capabilities.ts` 与 raw Lead config types/validation；teamlead `ProjectConfig.ts`；identity 编译源码 `packages/flywheel-comm/src/lead-identity.ts` 的 config projection（若已全字段摘要，只加验证证据不重复字段）；`lead-capabilities/{catalog,resolve,runtime-factory,deployment}.ts`、新增 `handlers/bridge-voice.ts`；`bridge/lead-capability-voice.ts`、Bridge router composition `bridge/plugin.ts`；StateStore voice_intents；`department-lead-rules.md`。

- [ ] config缺省/false时operations与missingOperationIds均无三项voice操作，完整的非opt-in v2 parent可启动；true但provider缺失时仍runtime_capabilities_incomplete。无v2/rg=false不授予相关使用，其他Lead与旧manifest不被隐式扩权。
- [ ] 增 catalog schema/handler 到固定 provider map/deployment 文件集合，proxy真实tools/list测试：lead_operation.oneOf与manifest.operationIds三项均存在；manifest-instructions 保持 hash 校验。
- [ ] 调用使用 canonical own identity；foreign session、伪 project/bot/token/url、stale activation、await 中撤销均拒绝且无副作用。
- [ ] 同请求并发/丢回执/进程重启/终态重放均同 session；digest conflict 拒绝；room由别人占用不返回成功；intent+reserve 注入 crash 点检验事务。
- [ ] status/receipt-only 无 POST side effect；stop 幂等，不能用旧 session stop 新场。
- [ ] 角色固定dept的规则装配snapshot含department-lead-rules语音段，manifest source hash/实际运行时instructions匹配；cos规则不得作为替代；语音工具使用同样的 provider receipts，不用文字“已开”作证。

实现期范围登记（Lead 2026-09-18 授权）：隔离slot暴露出的三处生产路径随本单收紧并回归。`lead-actions/mcp-config.ts` 只接受精确workspace或macOS固定的`/tmp`↔`/private/tmp`拼写，不接受任意symlink；`lead-runtime-tuning.ts` 的空白 `FLYWHEEL_SUMMARY_CONFIG_HOME` 视为未设置，再按最终projects registry推导slot home；`voice-session-start.ts` 保留§5允许的无meetingId直接meeting，标准Lead能力不接收caller evidence路径并由voice daemon写入其受保护的per-session evidence root，通用运维入口显式传入的路径仍须通过host allowlist。对应测试为`mcp-config.test.ts`、`lead-runtime-tuning.test.ts`、`voice-session-start.test.ts`；三项均为现有验收路径的边界修正，不授权额外Lead、房间、凭据或生产写入。

### D — 命令与证据

在实现工作树安装/构建依赖后执行，以下为计划命令，**本设计节点未跑修复测试**：

```sh
pnpm --filter flywheel-voice-core build
pnpm --filter flywheel-voice-bridge test:run
pnpm --filter flywheel-voice-codex test:run
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/voice-session-routes.test.ts src/bridge/__tests__/voice-session-runtime.test.ts src/bridge/__tests__/voice-session-card.test.ts src/bridge/__tests__/lead-capability-voice.test.ts src/__tests__/StateStore.voice-session.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/lead-capabilities/__tests__/bridge-voice.test.ts src/lead-capabilities/__tests__/resolve.test.ts src/lead-capabilities/__tests__/catalog.test.ts src/lead-capabilities/__tests__/runtime-factory.test.ts src/lead-capabilities/__tests__/deployment.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/lead-backends/codex/__tests__/lead-capability-proxy.test.ts src/lead-backends/codex/lead-actions/__tests__/mcp-config.test.ts src/__tests__/lead-rules-bundle.test.ts src/__tests__/lead-runtime-tuning.test.ts src/__tests__/huddle-config.test.ts
pnpm --filter flywheel-config test:run
pnpm --filter flywheel-comm test:run
pnpm --filter flywheel-voice-codex typecheck
pnpm --filter flywheel-teamlead typecheck
pnpm lint
```

新测试文件 `voice-session-card.test.ts`、`lead-capability-voice.test.ts`、`bridge-voice.test.ts` 随 B/C 创建；测试中使用真实 broker/Bridge resolver/store + stub外部Discord，不能全层 mock 后自证。每次存 SHA、命令、exit code、失败/通过数。基线无关失败单列，不以删测试解决。

## 7. 真房验收（全部待执行）

沿用 `../FLY-2598-voice-host-activation/host-runbook.md` §6/§7、self-filter-contract 和两模式身份合同。

**组一：音频链，不依赖 Raya v2 割接。** 按新增§7.2在合入前用本分支构建、QA/529测试Lead bot，完成RG与meeting两场founder真人双向对话；未通过不得QA PASS或出ship卡。生产General部署后复核保留，但不能再将第一次真人测试留到上线后。

在隔离测试环境验证坏包→warning→同session播放继续→当前capture恢复。生产不注入坏包、不抓取密钥；若真房自然再现，记录脱敏 receive state/计数/transition 时间与可用PCM时间，结合实际部署字节分析协议原因。若持续不收音，组一失败，不能以“保持live”结案；窄修复/版本变更需有具体证据与补充设计，不能现场关E2EE兜底。

**组二：自主入口，割接后验。** Lead 提供 FLY-2496/2657 割接与本能力 founder 激活收据；founder 在 #raya 原频道发「语音」→ Raya 当次模型工具调用 voice.session.start → durable requestId/sessionId → thread/房间 → 真人说听 → Raya/文字 stop。记录原 Discord messageId、carrier activation、实际 model tool result 与同一 session，工程 Lead 手工 start 不替代。重放同一操作请求不另开会话；发新意图才新场。无激活时标“未执行：割接/能力激活缺项”，不能从 host RG 成功外推。

### 7.1 原场根因的下一场取证

原场没有协商/成员事件序列，历史 reason 无法区分下列假说；本节点不猜一个作为结论。实现 A 须把 `receiveEvents` 扩为固定 DTO 诊断：room/connection generation、ready/transitioned 时间、transitionId、founder join/leave、admitted speaking start/end、首个有效 Opus/PCM 时间、错误 family 与失败数。不存 SDP、密钥、音频包、原始 SDK debug 或 voice privacy code。

为观察库内吞掉的失败，voice-codex 的 policy 可启 `debug:true`，glue 仅从固定0.19.2连接 debug 事件中用锚定白名单抽取 `DAVE preparing/executed transition` 的数字 version/id、consecutive failure 数、reinitializing boolean；不能把整段文字传出 glue，未匹配记录只增加 unknownDiagnosticCount。测试 fixture 包含类似 token/key 的未匹配字符串，保证日志无泄漏。该诊断不决定权限、成功或是否接受明文；不改 SDK 状态。

| 假说 | 当前结论 | 下一场怎样区分 |
|---|---|---|
| founder/其他成员入房触发 epoch/transition 竞态 | 未验证 | 对齐成员、transition、speaking、首PCM与失败时间，观察过渡后是否恢复；测试房可重复正常进出，不制造生产坏包 |
| 某客户端非 DAVE/协商降级 | 未验证 | 记录 SDK 协商 version 与成员变化，并向参与者确认客户端版本；没有协商证据不能仅凭 Unencrypted 错误认定客户端明文 |
| bot ready 早于 DAVE 状态可收音 | 未验证 | 分别标注 voice connection ready 与 transition ready/first PCM；ready 之后失败不能反证握手完整；重试观察后续 transition 是否恢复 |
| 已部署字节与0.19.2锁文件不同 | 未验证原场，当前主checkout依赖已核 | 实际 daemon loader 同入口记录包版本/部署SHA/策略，与本次session关联；不从锁文件推断加载成功 |

QA 保存原始脱敏 JSONL 与一张时间表，逐项写 verified/disproved/unresolved。如果仍持续失败且无足够协议证据，保留 unresolved 并将真人组一判失败；补充有界测试房采集/上游最小复现，不能升高 tolerance 或关闭加密把它记绿。

### 7.2 合入前 founder 529 真人硬门禁（2026-09-17 范围追加）

权威：founder 19:42Z 原消息 `1550230431658541137`；Linear FLY-2655 updatedAt=2026-09-17T19:44:10.969Z 全文已重新读取；Lead 指令 `3954adaf-8f3f-4a57-b10d-11067d3c6593`。本节取代旧“先部署再真人验证”的顺序，作为 R3 复审内容。没有下面这场真实对话，QA **不得 PASS、不得出 ship 卡**。实际要覆盖 RG 和 meeting 两场；founder 等待期间维持待验，不能用 stub、录音回放、合成音频、仅进房或 keep-live 替代。

#### 拓扑、bot 与当前缺口

选择 **测试 bot 共存**，不借用 Raya/Engineering Lead 的生产 bot，不临时停 `com.flywheel.voice`。首选 slot 2 的实际 Lead `flywheel-test-2`（最终以 room-info 的 canonical project/agentId 为准），当前 test-slots 登记 bot `1493072948683341976` / `TEST_BOT_TOKEN_2`、文字频道 `1493080993173737583`。测试 Lead 的同一 bot 负责房内收音/播报；不是另一个 alerts bot。2026-09-17 只读 Discord channels 返回 QA Testing 分类 `1493080958889496760` 下 type=2 的 `voice-test-2`=`1542708795720081408`，guild=`1485787271192907816`。这些是已观察候选，不是未来 slot 占用或权限证明：QA 启动时重取登记、bot /users/@me、房间类型/分类、Connect/Speak/View 与线程权限、self-filter 实测。slot2忙则等待，不抢占；若换slot必须重新冻结整份精确身份收据。

生产 daemon 保持原 PID/job/配置/房间。测试 daemon 用独立 voiceRoot/voice.lock、Bridge 端口/令牌、CommDB、StateStore、registry、voice CODEX_HOME 和证据根，仅解析测试 Lead。独立文件锁本身不能防同bot跨进程抢房：装房须同时持有 test-deploy 的 slot租约和新增 guild+voiceChannel 的 QA 房租约；验证该测试bot不在生产registry，也未被其他slot借用/加入另一语音房。任何冲突 fail-closed，不挤掉现有bot。生产与QA绝不共享同bot；本设计没有生产“临时让位”分支，所以恢复生产无需重启。

已核当前 `~/.flywheel/voice-host.json` 只有schemaVersion，QA两个allowlist均缺省为空；不能写成现成可用。`test-deploy.sh` 当前未安装 voice 坐标/进程，旧 `fly2446-two-lead-run.mjs` 依赖旧Raya meeting入口、不能直接覆盖此任务。由实现任务 D2 在**新slot私有配置**显式写 `qaVoiceChannelIds=[1542708795720081408]`，`qaAllowUserIds` 仅本场登记的founder/QA用户，founder身份与slot Bridge的discordOwnerUserId一致；生产voice-host与projects不变。allowlist来自本节明确选定测试房及参与者，不把空生产配置当授权或自动回填所有频道。缺权限则准备失败，交Lead安排QA房权限后重验。

#### D2：实现需补的最小隔离启动支持（不是本设计已执行）

1. `scripts/test-deploy.sh` 新增默认关闭 `--voice-fixture <json>`，fixture只含guild/voiceChannel/允许用户及必填founderUserId等公开输入；装房将已核founderUserId显式投影到DISCORD_OWNER_USER_ID，prepare读取slot Bridge实际launch/config身份，拒绝缺失或与登记founder不相等，不依赖caller偶然继承。只允许 `--generalized --mode slot` 有真实Lead模式，拒绝 `--no-lead`、stub和生产频道；沿用generalized的构建SHA/health fence与chat-thread flags，不删除--expect-head来绕过拒绝。这里slot指房间拓扑，不是非generalized lane。装房生成registry时、Lead身份编译与Bridge启动**之前**，将选定测试项目voiceRoom/该Lead voiceModes={rg:true,meeting:true}写进slot registry；保持 `codexVoiceActions` 默认关闭，不在此绕过生产Raya激活。然后从同一最终registry重新生成全部env/file投影与身份摘要，禁止启动后只改磁盘文件。QA房/用户只进slot0600 voice-host，evidenceRoots只含slot根。补slot环境合同的voice/meeting坐标，不改默认非voice房行为。
2. 新 `scripts/qa/fly2655-voice-room.mjs` 用 `prepare|start|stop|verify` 子命令管理**本slot子进程**与收据；受既有slot/Bridge launch contract约束，不能任意shell/env注入。prepare不启动会话；核expectedHead、干净源码、room-info/Bridge health SHA、全部产物hash，显式构建 voice-core、voice-bridge、voice-codex（普通test-deploy构建不含这些）。主代码SHA+产物digest+运行PID/start identity写入slot收据，不仅记录cli.js一个hash。
3. 现有 voice cli 的 `buildDelivery` 硬编码 homedir/.flywheel/comm/<project>/comm.db，即使设FLYWHEEL_COMM_DB也会被显式--db覆盖。**必须修这个隔离缺口**：config加入可选显式commDbPath，cli使用 `config.commDbPath ?? 原有project默认路径`；QA只接受slot canonical路径，真实子进程命令验证--db正是该slot DB。不要改HOME，不建指向生产的symlink，不复制生产DB。生产未设override时完全兼容。
4. launcher以白名单构造spawn env，绝不继承整份caller env：BRIDGE_URL/TEAMLEAD_API_TOKEN=slot，FLYWHEEL_PROJECTS_FILE与任何FLYWHEEL_PROJECTS=同一最终slot registry，FLYWHEEL_STATE_DIR/COMM_DB/VOICE_STATE_DIR/VOICE_CODEX_HOME/VOICE_HOST_CONFIG/MEETING_NOTES_CONFIG=slot内，FLYWHEEL_DIR/COMM_CLI=本分支绝对路径。清caller执行/激活/Lead lease身份，运维CLI使用529既有canonical slot投影。Bridge、Lead、comm子进程均核相同registry/DB；不得默认回落9876或生产state。
5. bot secret仅从test-deploy所建0600 secretEnvironment取得 `TEST_BOT_TOKEN_2`，以/users/@me校验实际bot；slot master由装房生成。Realtime OPENAI_API_KEY由既有受管clean-source只读传给voice父进程，不修改、迁移、打印或把生产凭据文件复制进slot；无已授权source则明确NOT_READY，不能借订阅auth.json。voice CODEX_HOME在slot新建0700，只有既有精确ephemeral API config0600且无auth.json。模型子进程继续沿用voiceCodexEnv的窄白名单，不得到bot/master凭据。收据仅存存在性与公开身份/hash，不存secret值或全env。
6. 新launcher在prepare和每次start前显式验证registry/projection的voiceChannelId属于本次已审QA fixture的qaVoiceChannelIds，并经Discord GET确认type=2和QA Testing分类；claim后再次核session相同tuple，失败精确stop拒绝继续。qaVoiceChannelIds目前不是Bridge服务端强制边界，不能只写配置就称已隔离；新增allowlist mismatch/生产General/错分类/空founder负向测试。不得从用户任意room值自动生成白名单来通过检查。不安装任何生产launchd plist。launcher持有voice进程PID/start identity与子进程所有权，运行本分支 `node packages/voice-codex/dist/cli.js`；先--check-config，再真正spawn。缺坐标、symlink逃逸、旧产物、非TEST token、生产bot/房、slot占用任一失败均不得spawn/start。新增脚本需红绿测试这些拒绝与幂等清理、真实comm --db投影、fixture对env/file/Lead/Bridge一致性。

#### QA 执行顺序

以下命令形状已于2026-09-18按当前分支脚本参数核对；工具已实现，但实际slot仍有身份/receipt启动阻断，未证明可用。参数用实际准备收据中的路径；不要复制占位符直接运行。test-deploy使用 --expect-head；voice-room所有子命令使用 --expected-head，start另需 --topic。

```sh
scripts/test-deploy.sh 2 --generalized --mode slot --expect-head <implementation-head> --voice-fixture <reviewed-public-fixture.json>
node scripts/qa/fly2655-voice-room.mjs prepare --slot-dir /tmp/flywheel-test-slot-2 --expected-head <implementation-head>
node scripts/qa/fly2655-voice-room.mjs start --slot-dir /tmp/flywheel-test-slot-2 --expected-head <implementation-head> --mode rg --topic "FLY-2655 RG 真人验收"
# RG结束并验证离房后，同一被测构建另开meeting。
node scripts/qa/fly2655-voice-room.mjs stop --slot-dir /tmp/flywheel-test-slot-2 --expected-head <implementation-head> --session <exact-session-id>
node scripts/qa/fly2655-voice-room.mjs verify --slot-dir /tmp/flywheel-test-slot-2 --expected-head <implementation-head> --session <exact-session-id>
```

prepare证据齐全后，QA通过其自身注入的 `flywheel-comm ask --lead ... --exec-id ...` 把slot房间链接、bot身份、ready证据交Lead，请Lead叫founder进房；不能用本设计exec代发。founder未到场则标 WAITING_FOUNDER，保留准备收据；长时间等待可停测试子进程，参与时重验并启动，不能超时转PASS。start在launcher受保护的slot-only CLI环境调用现有 voice-session start（不使用旧Raya voice-intent）；rg/meeting串行，同一时刻最多一个session。进入live后founder说本场独有短句并要求Lead复述/回答；至少观察60秒，再说第二句。现场听到回复后请founder确认，不以confirmed推断人耳听见。

| 取证链 | 每场必须绑定的真实证据 | 不通过条件 |
|---|---|---|
| 本分支运行 | implementation SHA、产物digest、Bridge health、voice PID/start identity/boot、DAVE版本/策略、slot与bot/房/用户ID | 只有git HEAD或锁文件，无实际加载证明 |
| 真人输入 | founder在场时间、独有短句、session events同一capture的framesPassed>0、非空transcript、thread镜像messageId/authorId | 全部silenced、仅PCM/静音、合成/回放输入 |
| Lead实际听到 | voice deliveryId与source_kind=voice、精确mailbox/消费回执、Lead针对短句的回复messageId | 只有运输ACK，内容没消费或回复不相关 |
| 真人输出 | 同session的outbound attempt/confirmed、房内实际音频与founder听到确认 | 只写日志、排队请求、无声或错误bot |
| 原因区分 | §7.1四行矩阵逐行verified/disproved/unresolved，成员/transition/firstPCM/错误族时间线 | 缺采集、从错误名武断认定明文/缺库 |
| 恢复与负向 | 隔离坏包回归证据；真实自然重现则同session健康变化、恢复前后PCM/对话对应 | 持续degraded仍标收音成功；到重试就声称恢复 |
| 停止与隔离 | exact session ended、bot离房、slot活跃行0、测试进程/锁清理收据，生产配置/凭据文件未被写 | 遗留进程抢bot、终态不明或生产被修改 |

RG与meeting各有独立session/证据目录。原场原因可诚实保留unresolved，但必须提交本场四行矩阵和真实双向通过证据；若仍收不到人声则FAIL/rework，不能把耐受错误当修复。第二组生产 #raya 自主入口仍按§7已裁定的割接后验；QA测试bot手起证明音频，不冒充Raya自主发起。

#### 收尾、还原与上线

stop只按收据中的slot URL+sessionId结束，等待ended/离房后给本次voice进程SIGTERM，核PID与start identity防PID重用；等它的app-server等子进程退出、关闭SQLite句柄，最后调用既有test-teardown对本次slot清理。异常时先同范围stop，再停精确拥有的测试子进程并等lease过期；不能用pkill/node全杀或卸载生产voice job。未能证明清理完毕保留slot/room锁及收据交Lead，不宣称恢复成功。审计生产projects/voice-host/plist以及受管credential文件的元数据与本地比较结果（不公开secret digest），确认未写；若生产PID因独立updater变化，保留时间线，不私自“还原”到旧PID。证据留slot外已批准QA证据根后再teardown，音频私有不上传，DB用快照控制器而非cp活库。

只有合入前真人硬门禁通过才可进入既有ship流程。founder同条消息授权“2655修好合入后立即重启、不等午夜”：由Lead发紧急重启票交独立updater，绑定合入构建与QA收据；不授权本设计或实现节点自行重启。生产部署后再按2598 runbook做身份/权限/实际载入复核；它不再是第一次真人测试。


## 8. 迁移、回滚与完成边界

先部署 Bridge 向后兼容 schema/renew，再部署新 daemon；旧 daemon 无 health 显示未知。新增 Lead 能力仍默认关闭，最后由 Lead 单独激活。代码回滚保留新增 nullable 列与 voice_intents 证据；旧 reader 忽略它们。不删历史、不得重铸 requestId。

需回退音频策略时先精确 stop 当前session、确认离房与结束，再由独立 updater 回滚；不在活跃 session 卸载依赖或改 bot 身份。撤销 codexVoiceActions 不扩大旧 CLI 路径、不恢复凭据；当前会话按 Lead 运维 stop 结束。

上述实现期范围登记的回滚必须按项恢复：workspace门禁回到精确相等时，同时撤回依赖`/tmp`别名的QA slot写入；summary home回滚时恢复slot launcher/registry的同源路径，不允许退到相对路径；直接meeting若回到强制evidenceDir，则同步撤回模型无meetingId入口，不能只删守卫而留下不可达能力。三项回滚都不改变生产凭据或voice-host注册表。

设计完成证据：三份文档、有效 APPROVED review、提交推送、交互 HTML 静态/托管校验、publish-only 回执、Lead URL 报告、phase_design_complete/park。实现/QA完成证据：A-D/D2 红绿回归 + §7.2合入前founder真人硬门禁 + §7两组实际证据；两者明确分开。


## 9. 2026-09-18 重起节点的增量交接

当前设计重新交接的基线为 `b2656cae6f65f8d1ca2322bcac4f65e5f45588fd`（PR #1243）；沿用R1–R3，不重写架构。历史 exploration/research 中的源码现状是2026-09-17设计时点，后续已实施部分见milestone与本节，不再当作当前待写清单。当前执行 `29871354-a261-4af5-9f63-cdbf0c59372e`，run `19f65593-cb7e-40cd-aa12-5158532475ce`，design TURN epoch=17。

Lead 指令 `1a692f1a-e247-4695-b802-3935af2232cb` 要求保留已推代码和设计；未提交 stash `117e962e492a1f87d7ddf9df5fa8b7802b847170`（7文件）仅由 implement 按精确对象恢复、审查及续作，禁止用共享栈的 stash@{0}。本设计仅只读检查其差异，未应用，也未给予代码审核通过结论。

| 项目 | 当前核对 | 后继动作 |
|---|---|---|
| macOS slot路径与真实loadSlot回归 | 当前loadSlot已导出，使用canonical根；历史QA已验证路径修复 | 保留/tmp及/private/tmp真实目录入口、跨slot/symlink拒绝，不退回纯函数测试 |
| 多句短话后的恢复预算 | 当前stable reset由room持有，正常capture结束不应取消；历史已提交对应修复 | 真房必须覆盖多句短话+中间停顿、live至少60秒；有效frames/transcript/听见回复均不可缺 |
| summary resolver与receipt | 已提交reader scope修复；保全stash另含slot receipt生成与launcher scope，尚未验证 | 同一最终slot registry、真实bot身份和receipt必须一致；通过正式迁移/验证路径产生收据，不能伪造或放宽验证器 |
| 当前最近阻断 | 继承progress停在identity_bot_user_id_invalid；不等于原始DAVE根因已定位 | implement核对实际失败入口、精确bot ID投影与receipt的两个环节；若需超出已有范围，由Lead裁定，不随意追修fixture |
| 代码审核/CI | PR中旧头的结论仅为历史 | implement在最终实际头取得有效代码复审和CI；不以本次设计复审替代 |
| Founder QA | 尚无真实双向通过证据 | QA准备完整后请Lead叫founder；RG+meeting、根因取证四假说、Raya自主入口均保留，不能以合成声音抵扣 |

隔离拓扑仍选测试Lead自己的bot，与生产共存；本设计未授权临时停止生产daemon。历史PR/milestone中“或让生产临时让位”不构成可执行的替代方案：采用该分支前必须取得Lead明确决策并补充精确停止/恢复收据方案。

QA advisory逐条保留：#4短句预算为必须覆盖项；#1重复COMM_DB已在后续实现返工中记录修复，但仍需QA核实际环境；#2语义env守卫、#3 lastPcmAt刷新、#5 automated标记、#6 CAS lease列、#7 active优先、#8 squash后证据引用、#9 capability超时余量沿用Lead的非阻断follow-up裁定，不由本次设计扩大范围。QA报告仍逐项写已覆盖/不适用及理由/follow-up，附tmux路径与版本选择差异（/opt/homebrew/bin/tmux 3.7c vs /usr/local/bin/tmux 3.5a），不可只写总PASS。

本轮只修正§7.2命令与上述交接事实，保留原R3 frontmatter及评审沿革；新的有效设计复审和HTML发布/核验/Lead报告完成后，执行phase_design_complete。等待外部评审时按本轮Lead指令不park；阶段完成后的停驻以控制器回执为准。


## 10. 2026-09-18 23Z 接续核对（当前游标；不重开设计）

权威：Lead 接续指令 b01fb876-50de-4215-9a44-6204dd32ed02；exec 7c77328d-3a37-4a25-96ec-e873d9e968f2，run b15740cb-ea84-47fb-82f1-587d33f2cb74，design TURN epoch=22。继承 origin/flywheel-FLY-2655@bc28daf6d、同一 PR #1243，implement 5/5；§9为历史恢复记录，以下事实取代其中“stash未纳入/identity阻断”的当前状态描述。架构、授权、两组验收与生产边界不变。

- 备份 origin/backup/FLY-2655-wip-stash-20260918=117e962e492a1f87d7ddf9df5fa8b7802b847170 的 resolver 与 receipt 两半分别已在 883e316dc、a3749a15c。对7文件逐一 diff，除 test-deploy-fly1389 的4个短 bot ID 已改为合法 snowflake 外，备份与继承分支一致；禁止再次 apply stash。
- §6 D 的 TeamLead 用例清单已由 5dfe89190 明确补齐；§7.1 诊断 allowlist 已由 e0536526e 扩展；身份摘要由 57d19f01f 绑定显式 codexVoiceActions=true，absent/false 保持旧字节。此处核对提交与源码，不冒充真实运行消费证据。
- 已在本节点 TURN 内无冲突同步 origin/main@d8b3f3cd5（#1267，包含日期用例与Codex账号识别修复）。没有新增实现修改，不重复恢复已提交代码。
- 继承头 bc28daf6d 的 CI run 35396358102 已终结为失败：teamlead 4/4 的唯一失败是 fly2662-predeploy-replay 日期租约用例，main #1267 包含对应修复；scripts 3/5 套件通过但 elapsed tripwire 为1069秒，预算1020秒（cap1200秒）。后者是容量门禁失败，不称为偶发，也不提高阈值掩盖。后继在最终候选头取得完整CI与有效代码复审；若容量失败重现，按Lead决定处理，不能带红进入QA PASS。
- 本轮原生 node voice-room 测试12/12通过；本worktree没有node_modules，定向Vitest命令以“Command vitest not found”退出，未执行用例。未重跑本地全量套件。12/12只证明测试覆盖的工装合同，不是本轮真实slot prepare/start成功。
- 原设计复审 question 29c5e902-978d-497c-8878-96c1fd2fe193 当前返回有效 APPROVED；沿革保留。本轮按注入合同另外登记当前exec设计review，审批不替代代码复审、CI、529真人或Raya割接收据。
- 非阻断advisory继续沿用review-disposition与PR记录。新增Raya persona需要bundle1而voice需要bundle2的激活次序冲突属于FLY-2742/FLY-2496割接跟进；不得为满足自主入口绕过任一启动门禁。lastPcmAt、卡片标记/CAS、可选receiveEvents缺失等不在本次设计中顺手扩修。
- QA仍须隔离529测试bot与生产共存；RG、meeting真人双向，framesPassed>0、transcript、thread镜像、live≥60秒、多句短话+停顿、根因四假说逐项结论。由Lead叫founder；未到场就等。#raya自主开场仍是独立的割接后验组，未删除也未声称通过。

本次设计交接只证明已有计划与实现沿革已核对、范围保持。最终CI与代码复审交给后继节点；不由design派QA、不请求ship或重启。完成仍须当前有效设计review、本轮HTML静默发布/托管核验/Lead报告及phase_design_complete收据。


本轮有效设计review已APPROVED，17项MEDIUM/LOW advisory并非实现通过证据，完整原文见continuation-design-review.json、逐项去向见review-disposition.md。特别是voice-room-loadslot-rejects-migrated-registry：当前源码确认迁移器写pretty JSON，Bridge env重压紧凑JSON，而loadSlot比较原始字符串及旧fixture digest；本节点未运行真实迁移slot，故将其作为需实现优先复现/处置的确定源码差异交接，不冒称prepare已可达。§10的implement 5/5是继承游标，不表示本节点独立证明§6全部测试语义已覆盖。设计批准不抵扣缺失的运行时版本诊断、接收竞态测试或D2隔离/清理证据。


## 11. 2026-09-20 当前实施入口：修到 founder 真听见为止

执行 **design-correction.md** 的 E1–E5。它是本plan的一部分，本轮评审须同时审阅；冲突时该附录只覆盖语音前台transport、该transport证据与QA统计，不改变§3–7已实现收音链或Lead授权范围。先读 exploration/research 新增节、realtime-evidence-audit.json 和 Lead 选路回执。基线177c539ea完整保留，不重做DAVE，不恢复2756拆单，不切Codex版本。

当前设计批准需新有效review；9/18有效审批只是沿革。实现完成仍须新代码复审、准确候选头CI，以及RG/meeting真人≥60s双向、多句短话+停顿和自主开场的原验收。设计本身不得宣称这些完成。
