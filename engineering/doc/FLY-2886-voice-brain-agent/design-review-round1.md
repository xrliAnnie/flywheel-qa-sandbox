# Design Review — plan.md (Round 1)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向可行，但当前计划还不能直接进入实现。主要阻塞是：把结果回送控制误当成后台调度控制；复用能力 parent 时遗漏独占载体与回执恢复的假设；现有幂等机制不能保证常驻 Lead 优先；保真检查允许回答自证；插话重连期间仍可能丢后台完成事件。

评审基线：`flywheel-FLY-2886`，HEAD `61ce45bf2fc27d47597cdcc83f8a2373e37cf464`。已读取项目规约、2886 exploration/research/plan、2799 prior art、2881 v5 与实验代码，以及指定生产源码。2884 文件通过 `git show` 读取，分支解析为 `148e53fe0869e4a1d757a593003620eec34e301b`。接受全部固定 founder 决策，包括后台直接读写、订阅、口语转述、默认 founder Chrome 和连接层分工；以下不重审这些决定。

证据以静态阅读为主；另执行了两个纯内存反例，验证规则 A 的循环来源和共享回执恢复的影响。未运行订阅会话、真实 broker 写操作、浏览器或仓库测试。只写本反馈文件。终检 HEAD 与已跟踪文件均未变化；评审期间另出现未跟踪的 `fly2886-voice-brain-design.html`，本次未修改该文件。

下文 `P` 指 `engineering/doc/FLY-2886-voice-brain-agent/plan.md`；`U` 指本机 `/tmp/voice-research/codex/codex-rs`，已核 Git HEAD 为上游 `44a9bfa1456e51269fa824fa2f93b435e3e800ed`，与 2881 v5 引用一致。`S` 指用户提供的 `browser-tmp/schema157/v2`。代码位置均为本次实际读取的版本。

## What's Good (Keep)

- 保留 Codex 内置后台与同一语音线程，不另建业务 agent；业务能力继续由现有目录、manifest 和 broker 提供。
- `clientManagedHandoffs=true` 为结果检查和择时播报提供了必要控制点；会话级结果信箱、注入时钟、有限重投都值得保留。
- 前后台上下文分开，前台限制体积、完整保留标识符、读取失败如实标注；这些直接改善现有大 prompt 路径。
- Step 0 明确限制真实实验范围，且不把后台订阅等同于当前 WS 实时腿也使用订阅。
- C12 的三态 claim 与 410/409 区分正确：`StateStore.ts:6563-6581` 当前确实把失租约和不可认领都折成 undefined，路由再统一返回 409。
- 默认关闭、按 Lead 开启和不在本单部署的发布边界合理。

## Issues & Recommendations

1. **[blocking] [HIGH] `clientManagedHandoffs` 不提供计划中的 3+1 调度，也不能保证 handoff 与 turn 一一对应。**

   **问题与证据：** P:46、55、125、151 假定收到 h1 后会有独立 t1，并能在第 4 个 handoff 执行前排队。`rtstart.json:145-150` 的含义仅是禁止自动回送 Codex 回答。U/core/src/realtime_conversation.rs:1763-1779 在向客户端发布 handoff 通知前已经路由输入；U/core/src/session/turn_input.rs:567-587 使用 `StartOrSteer`，已有活动回合时可以把新请求并入原回合。同样逻辑也存在于本机 0.156.1 源码的 `core/src/session/turn_input.rs:559-579`。2884 的 bridge.mjs:344-356 只是在 turn 启动后计数并中断，并没有客户端 admission/排队能力。

   **为何重要：** 第二个 handoff 可以没有第二个 `turn/started`，使登记、等待计时和结果归属悬空；客户端收到通知时也已经错过所谓第 4 个请求的执行准入点。只用假 RPC 测试 3+1 会验证一个实际协议不存在的模型。

   **建议：** 保持同线程内置后台，按实际的单活动回合及 start/steer 语义设计，明确多 handoff 对同一 turn 的义务登记和完成方式，删除无依据的并行 3 回合承诺。Step 0 增加“第一个任务未完成时连续提出第二、第三个查询”的真实事件证据，确认通知顺序及结果覆盖；不要为保留 3+1 再造线程池。统一修正 §3 与 §6.4 关于是否中断的矛盾。

2. **[blocking] [HIGH] C2 尚未定义如何与常驻 Lead 共存；照搬 parent 会触及活跃回执和载体权威。**

   **问题与证据：** `lead-capabilities/runtime-context.ts:74-88` 要求真实的 `validateLeadCarrierAuthorization`；仅有 `activationId=voice:<sessionId>` 不是授权。`runtime-parent.ts:306-312` 在启动时按 project/Lead 调用 `recoverInterruptedParent`；`receipts.ts:200-210` 把该 Lead 全部 prepared/dispatched 回执改成 unknown，不区分仍存活的 activation。`runtime-parent.ts:104-133` 的 delivery context 也只允许一个当前 journal entry。此外，`resolve.ts:25-38` 和 `packages/config/src/codex-lead-capabilities.ts:48-57` 只接受已采用 v2 的 full-access Codex department Lead，并非任意所选 Lead。

   **为何重要：** 共享常驻 journal 会把正在执行的 Lead 写操作误判成中断；另开 journal 又不会自动获得跨 actor 的去重。纯内存执行现有 recovery SQL 已确认：`resident-live/dispatched` 会被改为 `unknown/dispatch_interrupted`。Claude Lead 的语音分身也不能仅调用该 factory 就获得能力。

   **建议：** 在 Step 1 前写清会话权限如何绑定当前 Lead 身份、voice lease 和常驻 carrier，journal/receipt 谁持有，恢复只允许处理哪些已死亡 owner，以及结束/失租约/开关关闭时如何撤销。复用目录和 provider，不调用会扫到常驻在途操作的全 Lead recovery。为非 Codex 本体提供可信身份适配，不能通过伪造其 backend/profile 或抢占常驻 carrier 达成“同权”。集成验收应包含常驻 Lead 正在写时启动及关闭语音 parent，而不只是一次 read 和 reserved 拒绝。

3. **[blocking] [MEDIUM] C1 的实际启动链有明确不兼容点，Step 0 的协议小实验覆盖不到。**

   **问题与证据：** `CodexVoiceContainer.ts:240-252` 复用 `spawnCodexAppServer`；后者在 `codex-lead-runtime.ts:1434-1440` 明确拒绝 `voiceProfile` 与 `capabilityModelEnv` 同时传入。能力 factory 在 `runtime-factory.ts:119-121` 校验 native skill baseline，而 `native-skill-baseline.ts:94-118` 仅收录 0.153.2、0.154.0、0.156.0，计划的 0.156.1/0.157.0 都会得到 `baseline_drift`。另外 C1 的 `account/read authMode=chatgpt` 不是 schema 字段：S/GetAccountResponse.json:23-44、122-148 返回的是 `account.type`；thread/start 回执也不提供 MCP 清单，现有 parent 在 `runtime-parent.ts:352-383` 通过有效 config 检查它。

   **为何重要：** 即使“订阅后台 + API key 实时腿”在独立 app-server 实验中成功，使用生产启动器和 parent 的组合仍然会拒绝启动，或错误地把合法订阅判为失败。

   **建议：** 把受管 voice-capability 启动档、home/config 的唯一构造者、模型环境清洗、二进制与 native baseline 准入列入 C1 的明确改动范围。账户使用 `account.type === "chatgpt"`，权限使用 thread 回执与有效 config，MCP 使用有效配置及实际工具发现。对这条完整组合链做集成验证，并保持旧 voice-only 与普通 Lead 启动守卫。不要靠关闭原断言、误报版本或放宽所有调用方解决。

4. **[blocking] [HIGH] “已有幂等/409 ⇒ 常驻 Lead 优先”不成立；部分成功后的额度 fallback 还可能重复写。**

   **问题与证据：** P:89、157、210 将冲突/幂等命中视为常驻 Lead 已处理，并在额度耗尽时回旧 handoff。`broker.ts:224-259` 的键是 project、Lead、operationId、requestId，且 input digest 冲突只针对同一个 requestId；两个 agent 各自产生 UUID 不会相撞。`handlers/linear.ts:262-299` 最终直接 `updateIssue(issue.id, patch)`，没有资源版本 CAS 或常驻 owner 优先判断。`broker.ts:308-334、355-371` 还允许 provider 已执行后因检查/超时返回 unknown。旧 `CodexVoiceHandoff.ts:44-60` 只转交原始话语及 intent，没有此前写回执。

   **为何重要：** 两个 actor 对同一 issue 的不同写入都可能成功，后写覆盖先写而没有 409。后台创建 issue 后下一次模型请求撞额度，把原话重新交给 Lead 可能再创建一次；unknown 更不能当作“没执行”。同请求重试命中也不证明执行者是常驻 Lead。

   **建议：** 明确哪些写由现有业务键/版本约束保护，哪些需要在可信 broker/Bridge 的实际执行边界补最小的目标冲突保护，并为常驻 Lead 指定优先语义。错误文案按真实回执归属生成。失败交接应携带已成功、未执行和结果未知的操作及稳定 requestId；成功项不重做，unknown 先查回执/对账。补“两个 actor、不同 requestId、同目标”以及“写成功后额度耗尽/回执未知”的验收。

5. **[blocking] [HIGH] 保真来源包含待检回答自身，规则 A 对后台稿恒真。**

   **问题与证据：** P:129、136-137 将 `final_answer` 全文放入 C，而 S 就从该回答中解析。故 S 的任意字段天然已经出现在 C。纯内存反例：工具只返回 `FLY-2886 / PR #2886`，回答写成 `FLY-9999 / PR #9876`，按计划规则 A 仍全部通过。

   **为何重要：** 最核心的“凭空编号必须兜底”负向测试与算法本身矛盾，当前设计不能支持其保真声明。

   **建议：** 从来源集中排除待检回答及其文字版；只使用本次可信输入、选定上下文和实际完成的工具结果，并保留来源 item/turn 标识。模型可以选择引用来源，但不能自己增加被认可的字段。按完整字段比较，避免把 `12` 在 `312` 中出现当成依据；没有独立依据的字段进入明确兜底。将上述循环来源反例加入测试，不恢复已否定的逐字转写检查。

6. **[blocking] [HIGH] 会话级信箱不能弥补 transport 在重连空档丢掉的后台事件，且执行 item 仍有第二条中断路径。**

   **问题与证据：** P:58 只列 `turn/started` 不中断和新增 `turn/completed` 解析。当前 `RealtimeTransport.ts:483-486` 在处理 turn 之前要求 realtime transport 为 active；`CodexVoiceContainer.ts:437-453` 先 cancel 旧 transport，再建/start 新 transport。后台若在这段空档完成，没有任何 active transport 接收它。另外 `RealtimeTransport.ts:546-570、650-656` 在 commandExecution/mcpToolCall 的 item/started 上仍会执行 `turn/interrupt`。

   **为何重要：** Step 0 证明服务端回合能跨 realtime restart 存活，也不能证明客户端收到结果；结果可能从未进入信箱。仅改 turn/started 后，后台第一次实际用工具仍被掐掉。

   **建议：** 在 process/conversation 生命周期上建立一次持续的后台 turn/item 订阅，先按 threadId/turnId 分发，再把 realtime 音频按 generation 隔离；后台收集不依赖 realtime active 状态。enabled 档一并处理执行 item 的中断守卫。明确 failed/interrupted/无 final 的终态如何结束等待，并测试完成事件分别落在 stop 等待、新 transport opening、start 完成后的三种位置，以及真实工具 item 序列。

7. **[blocking] [MEDIUM] 地板结束信号与首句去重条件不足以兑现等待/不打断合同。**

   **问题与证据：** P:58 依赖 `input_audio_buffer.speech_stopped`。U/codex-api/src/endpoint/realtime_websocket/protocol_v2.rs:24-78 只解析 speech_started，不解析 speech_stopped；其他未知类型落入 None。当前适配器使用 user item completed 清理 openSpeechItem（`RealtimeTransport.ts:510-523`），并非现成 stopped 事件。P:145 的“handoff 到达时还没有音频”也不能排除随后才来的模型 filler；2881 v5 的时序明确是 13.8s handoff、14.0s 模型确认语（voice-design-review-v5.html 的逐步时序）。

   **为何重要：** 等待一个永不暴露的 stopped 会把地板永久占住；只看当前有没有音频会在模型稍后出声时双说“我去看一下”。`delegationAckFiller=false` 又只对 V3 有效。

   **建议：** 给连接层接缝定义实际可实现的 user-active/output-active 状态来源及缺失、cancel、断线时的复位规则；V2 从已有 item/RoomIO 信号派生，V3 明确对应来源。地板判定与首句、心跳、结果共用一个播报仲裁点。将“handoff 先到、模型 filler 后到”和首句期间用户重新开口纳入协议验证，确定 enabled V2 的确认语抑制/择一策略后再承诺只说一次。

8. **[blocking] [MEDIUM] reserved 拒绝的真实返回值不同，而且拒绝不等于提交了 founder 请求。**

   **问题与证据：** P:91、164、194 等待 `founder-workflow-required`，并允许说“我已经把请求提上去了”。但 `lead-capability-proxy.ts:196-201` 对 manifest 外操作返回 `operation_not_in_manifest`；直接到 broker 则 `broker.ts:164-165` 返回 `reserved_operation`。`catalog.ts:979-1000` 中的 denied/reason 是输出 schema 定义，没有 handler 会创建审批卡。正常 resolver 还把 reserved 分别放在 `deniedOperations`，factory 只将 `resolved.operations` 交给 manifest（`resolve.ts:52-70`、`runtime-factory.ts:141-153`），不能假定现成生成结果带齐计划所说的 denied 名册。

   **为何重要：** 验收会等不到指定错误，founder 听到“已提交”却没有可审批请求；这不是 founder gate 本身的问题，而是语音入口到既有 gate 的缺失步骤。

   **建议：** 保留现有 gate，显式把目录 reserved 信息用于能力说明和拒绝分类，并按真实错误码处理。定义复用哪个既有请求/Lead 信箱入口提交 founder 操作、幂等键和接受回执；只有收到该回执或确实已有卡片时，才能说“已提交/可在卡片上批”。补一条从拒绝到现有 founder 工作流中可见请求的验收。

9. **[blocking] [MEDIUM] C3 的三档浏览器不能只追加/删除 MCP；默认 founder Chrome 的写操作也绕过 C11 日志钩子。**

   **问题与证据：** `runtime-factory.ts:386-420` 总会装配隔离 browser/provider（同时提供模型网络代理）；`buildCodexLeadMcpArgv.ts:167-180` 硬要求 browserGeneration、browser tools 和固定 browser integration，并在 :185-209 生成两个 MCP。`runtime-parent.ts:352-383` 又精确比较 MCP 配置。因而 off 直接删 browser 会不满足准入；founder 模式直接追加第三个 MCP 会与有效配置断言冲突，保留默认配置则可能同时暴露两种浏览器。更关键的是，P:62、157 仅捕获 lead_operation 成功回执，直接调用 `chrome_devtools_founder` 不经过它；目录对 browser 操作本来已有 read/write 分类（`catalog.ts:1001-1025`）。

   **为何重要：** 默认模式可能启动即失败，或能力简报与实际暴露不一致；经她 Chrome 完成的写操作没有进入 Lead 本体信箱，违反固定的每次写同步要求。

   **建议：** 将 browser 模式作为同一能力装配的可信输入，一起决定 provider、manifest、MCP、有效配置检查和生命周期；off 仍保留需要的模型网络代理。保持 founder Chrome 为默认，不重审已接受风险。为其工具调用增加受信的分类/回执通知适配，复用目录分类并确保每次写进入既有信箱；写回执已成功但通知失败时，应能按同一回执幂等补送，不能依靠模型自报。三个模式都要验证实际工具发现，而不只测试配置字符串。

10. **[advisory] [MEDIUM] 补上议程完成、文字兜底与“未播结果”进入现有交付链的合同。**

    **问题与证据：** P:59 改为把 outbound 行交给 C4，但现有 `daemon.ts:890-947` 把 claim、等待 speak、receipt 视为一条顺序链；`StateStore.ts:6626-6635` 结束时把 queued/claimed 分别变成 dropped/ambiguous。现有纪要入口 `voice-codex/src/cli.ts:609-629` 只读取转写，pending/handoffs 都为空，读不到 C4 内存里的未播答案。`CodexProofSpeaker.ts:106-138` 的 pendingKey 又绑定 generation 和文本，重投若沿用旧 key 会冲突。

    **为何重要：** 入队不等于已经播完；仅修改 C4 而不接这些调用方，会提前确认 outbound，或关场后纪要遗漏未播结果。

    **建议：** 定义议程 enqueue 返回的完成结果何时允许提交 outbound receipt；每次重投使用独立 attempt 身份，保留稳定业务消息 ID。关闭时先导出未播稿到现有 minutes queue，再释放容器；文字版发布失败不能仍说“已经发到 thread”。列出 cli/minutes/bridge-client 的必要接线与测试，无需另建一套消息库。

11. **[advisory] [MEDIUM] “无工具改稿线程”应给出隔离和超时取消的具体验证。**

    **问题与证据：** P:57 在同 app-server 上起第二条 read-only ephemeral thread；父进程已通过 argv 装入可写 MCP。read-only 只约束 exec sandbox，现有 `buildCodexLeadMcpArgv.ts:220-223` 明确说明 MCP 子进程在其外运行。当前旧容器之所以无工具，还依赖 `mcpArgv:[]` 与 thread config 的多项禁用（`CodexVoiceContainer.ts:634-674`）。

    **为何重要：** ephemeral 与 read-only 本身不能证明改稿线程没有能力；只在 15s 后返回兜底也不会停止未完成回合。

    **建议：** 显式列出该线程禁用全部 MCP、shell/web 等工具的 thread config，验证实际有效工具集为空，并按独立 threadId 分流通知。超时中断该 thread 的目标 turn、丢弃迟到结果；原始消息按数据输入，输出 JSON/长度在本地验证。仍可复用同进程，无需新增 agent 服务。

12. **[advisory] [MEDIUM] 新事件去重还需考虑过期事实、realtime 重开和关闭档兼容。**

    **问题与证据：** P:95-105 只发送从简报键集中新出现的键，没有定义注意力项已解决、runner 从受阻恢复后的更新，也没有说明排队 tell 播出前复核。realtime 重开仍用开场时捕获的 `realtimeStart`（`CodexVoiceContainer.ts:679-697、437-453`）；此前 context outbound 若已确认，就不会再次出现在 `listVoiceOutbound`（`StateStore.ts:6554-6560`）。P:61 的默认 delivery_class=tell 也不能自动让旧 daemon 理解新增 context 行。

    **为何重要：** 她在文字卡片上已经处理的问题可能随后仍被语音通知；一次普通插话后，前台可能忘掉刚注入的状态；未按 enabled/backend 限制的新事件生产会改变关闭档或 Engine A 的行为。

    **建议：** 在既有 poller 中记录必要的当前事实版本/撤销，并在播前复核待批事项；重开时从会话保存的最新有限上下文重新装载。明确仅为相应 enabled Codex 会话生成新事件，以及关闭/回滚时旧 context 队列如何处置。补解决后不再播、重开后仍知道更新、关闭档不生产新事件的用例。

## Verdict

CHANGES REQUESTED

先修正第 1–9 项并同步 Step 0/1 的验证目标，再进入实现。保留固定 founder 决策与现有能力体系；不需要为了这些修正引入独立业务 agent、线程池或第二套消息存储。
