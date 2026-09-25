# Design Review — plan.md (Round 2)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 已修正 R1 的主要架构误判，但仍有 6 项阻塞和 1 项建议。剩余问题集中在请求与结果归属、授权贯穿 provider、常驻优先的并发保证、播报时序，以及新增改稿进程的订阅启动合同。

本轮完整重读了 v2（279 行），范围限于 R1 第 1–12 项及修订引入的回归。接受全部固定 founder 决策，也接受新增的“权限下限为所有 Lead 权限并集”；不建议退回只读、不缩减 Claude Lead 的语音能力、不重审 founder Chrome 风险。

评审基线：HEAD `61ce45bf2fc27d47597cdcc83f8a2373e37cf464`；工作区 v2 plan SHA-256 `38eb7fe1ab4cf1a6302cab90d1efac33bb52bed901def84a5284f3775d04b91e`。以下结论由静态阅读计划、R1 报告及相关调用链得出；未运行订阅实验、真实业务写入或仓库测试。Step 0/1 仍是实现期必须完成的验证，不在此报告中视为已通过。

下文 `P` = `engineering/doc/FLY-2886-voice-brain-agent/plan.md`；`T` = `packages/teamlead/src`；`V` = `packages/voice-codex/src`；`U` = `/tmp/voice-research/codex/codex-rs`（R1 已核验的上游源码）。所有行号指本轮读取版本。

| R1 项 | R2 结论 |
|---|---|
| 1 调度与映射 | 单活动回合/StartOrSteer、取消 3+1 已修正；归属及覆盖判定仍需补齐，见本轮 1 |
| 2 parent 共存与授权 | 独立 journal、activation 范围恢复、delivery context 与撤销方向已修正；provider 授权合同未闭合，见本轮 2 |
| 3 启动链 | 设计层面关闭：专用档、唯一 home 构造者、binary baseline、正确账户字段及配置/工具断言均已纳入 |
| 4 常驻优先与失败账本 | 失败账本与真实 owner 文案已修正；目标冲突机制仍有漏洞，见本轮 3 |
| 5 保真循环来源 | 设计层面关闭：排除回答及文字版、独立工具来源、完整 token、发布回执及反例测试 |
| 6 重连丢事件/第二条中断路径 | 设计层面关闭：进程级路由、item 守卫、异常终态、三种重连时机测试 |
| 7 地板与确认语 | 仲裁入口已统一；复位与确认语竞态仍在，见本轮 4、5 |
| 8 founder 拒绝与虚假提交 | 原阻塞关闭：真实错误、目录 reserved、卡片/信箱回执约束已纳入；新增错误分类过宽，见建议 7 |
| 9 浏览器装配及写日志 | 设计层面关闭：可信模式输入、同一门面、保留网络代理、回执补送与三档工具发现 |
| 10 议程/纪要/重投 | 设计层面关闭：终态后回执、独立 attempt key、释放前导出 unplayed |
| 11 改稿隔离 | 隔离、超时中断、迟到丢弃已修正；所选启动档与订阅登录冲突，见本轮 6 |
| 12 新事件时效/重开/关闭档 | 设计层面关闭：限定 enabled Engine B、播前复核、有限上下文重装、关闭时丢弃 context |

## What's Good (Keep)

- 保留一个业务后台线程，以 obligation 表达多次委派；删除没有协议依据的线程池式调度。
- `voice_session` 与常驻 carrier 分离，独立 journal 只恢复本 activation；这是避免误伤常驻在途操作的正确方向。
- 进程级后台事件订阅与 realtime generation 分离，且把真实工具 item 和异常终态纳入测试。
- 保真检查不再让回答自证；“已发 thread / 已记给 Lead”均要求实际写入成功。
- 浏览器复用目录和 broker 门面，三档同时决定装配与断言；原有默认模式和固定风险边界均保留。
- 议程终态回执、重投 attempt 身份、未播内容导出及事件播前复核，均是对既有交付链的必要补全。

## Issues & Recommendations

1. **[blocking] [MEDIUM] obligation 仍按通知到达时的活动回合和回答段数归属，可能挂错回合或结算错请求。（R1#1 剩余）**

   **问题与证据：** P:54–55 规定“当前活动回合，否则下一个 started”，并用段数判断哪些义务未覆盖。U/core/src/realtime_conversation.rs:1763–1779 先路由后台输入，再发送 handoff 通知；U/core/src/session/turn_input.rs:567–587 使用 StartOrSteer，但不会把 Started/Steered 的归属结果随 handoff 返回。P:165 的图仅画了 handoff 先于 started 的一种顺序。另外 P:128 的 `【口语】` 段不含请求标识；上游组装后台输入时也未传入 handoff_id（U/core/src/realtime_conversation.rs:1850–1862）。

   **为何重要：** 若回合已终态才收到迟到 handoff，“没有活动回合”会把它留给一个可能永远不来的下一回合；不能由单活动回合推出通知必按客户端期望顺序到达。覆盖还有一个独立反例：请求 A、B 同在 t1，模型只答 B 一段，段数算法却会把 A 当作已覆盖、称 B“没查完”。Step 0 的正常三连问不足以覆盖这些分支。

   **建议：** 明确迟到/重复 handoff 与已终态回合的归属规则，保留足够的输入关联和终态记录；无法可靠关联时明确结算为未确认，不能无期限挂到下一回合。回答须能关联到具体请求；若使用请求标识，写清如何让自动路由的后台输入知道该标识。无法判定覆盖时保守处理整批/对应义务，不能用段数宣称前 N 个请求已完成。补 `started→completed→handoff`、回合交界迟到通知、只答第二问及回答乱序的测试；仍无需引入线程池。

2. **[blocking] [HIGH] 新 voice_session 授权尚未定义如何贯穿实际 provider 和 Bridge 路由；仅替换 parent 准入无法兑现权限并集。（R1#2 剩余）**

   **问题与证据：** P:70–79 声明替代 carrier 授权，P:215–216 的落点主要在 resolver/parent/broker。现有 provider 会再次创建并校验旧授权：T/lead-capabilities/runtime-context.ts:30–47 再走 Codex 准入，:74–88 再查 carrier；T/lead-capabilities/handlers/bridge-read.ts:143–155、219–227 要求该校验并把 carrierClaim 发给 Bridge。Bridge 的 T/bridge/lead-capability-scope.ts:35–48 再要求 carrier、Codex backend、dept、full-access、bundle v2；runner 路由还有独立 strict envelope 与相同校验（T/bridge/lead-capability-runners.ts:20–33、92–134）。

   **为何重要：** 新 resolver 生成再完整的 manifest，也不能让 Claude Lead 的请求通过这些实际读写入口。不传 carrierClaim 会被 strict envelope 拒绝；传语音会话 ID 代替 carrierClaim 也不会通过载体校验。为了使其工作而临时伪造 profile/carrier，恰好违反已明确的设计边界。这是现有调用链的额外准入，不是对权限并集决定的异议。

   **建议：** 把可信授权上下文定义为可贯穿 provider、请求 envelope、Bridge scope 和最终副作用边界的明确合同：resident 保持原 carrier 路径，voice 使用绑定 project/lead/session/当前租约 owner 或 fence 的授权证明，并在实际 dispatch 前验证撤销。列出共享 context、provider 转发和 Bridge scope/runner 等入口的改动，避免只改 parent 外层。Step 1 使用真实 Claude Lead 身份经完整链路完成一次读取和一次非 reserved 写入，再验证失租约/flag off 后拒绝写；普通 resident 路径仍保持原准入。

3. **[blocking] [HIGH] 写前读取常驻 journal 不是目标互斥，且现有回执没有可查询的目标字段。（R1#4 剩余）**

   **问题与证据：** P:85–86 只增加 `targetKey(input)`，在 voice 写前查询常驻 prepared/dispatched/近 10 分钟完成项，并声明常驻不受 voice 约束。T/lead-capabilities/receipts.ts:31–38、88–95 目前仅存 inputDigest、activation、状态等，没有输入或 targetKey；仅凭摘要不能还原目标。实际执行会跨 await（T/lead-capabilities/broker.ts:292–310），Linear 最终仍是无版本前提的 `updateIssue`（T/lead-capabilities/handlers/linear.ts:297–299）。P:259 的验收只覆盖常驻已经在写的顺序。

   **为何重要：** 反向交错仍会丢更新：voice 查到无常驻写→发出慢请求→resident 开始并完成写→voice 请求最后落地，覆盖 resident。把检查挪到更靠近 dispatch 或增加 10 分钟窗口均不能消除这个窗口。另需明确常驻侧如何记录目标；Claude 本体也不能假定拥有 Codex broker 的完整操作 journal（T/lead-backends/lead-backend.ts:5–7 区分两条载体路径）。

   **建议：** 明确目标归一化、持久化、查询索引及常驻侧的记录接入；跨操作、别名及入口要能命中同一业务目标。对可覆盖的写采用双方实际执行边界共享的目标序列化/仲裁，或 provider 支持的版本前提，定义 voice 已派发后 resident 到来的处理方式。常驻可拥有排队优先权，但不能绕过保护后仍声称不会被在途 voice 覆盖。保留失败账本，并补两种到达顺序、慢 provider、超时 unknown、Claude resident 的覆盖测试；未知在途写不能因计时到期就当作不存在。

4. **[blocking] [MEDIUM] user-active 的复位需要绑定语音段，不能被迟到 final 或 realtime generation 切换清空。（R1#7 剩余）**

   **问题与证据：** P:191 把 user final、对应 completed、RoomIO 段结束列为复位来源，P:192 又规定 generation 切换“全部复位”，但未规定异步来源如何关联同一语音段。V/codex/RealtimeTransport.ts:495–501 已有 item_id；:515–516 清理 openSpeechItem 时会核对 ID。V/codex/CodexVoiceBackend.ts:463–467 的通用 transcript 事件却不携带 itemId；:307–356 表明 barge-in 会重开 generation，并在重开期间缓存、随后回放她仍在说的话。

   **为何重要：** A 的转写 final 晚于 B 的 speech_started 到达时，无条件复位会把正在说的 B 清掉，800ms 后可以主动插话。barge-in 重连时清空用户状态也会产生同样的假空闲：房间仍有语音，新的服务端 speech_started 尚未返回。输出取消可以释放旧播放，不能证明用户已经停说。

   **建议：** 用语音段/item 身份关联开始与结束，旧段终态不能清除新段；明确本地 RoomIO 与 provider 信号的合并规则。用户占用状态随房间输入延续，跨 realtime 重开保留；未知/重开期间应等待本地结束证据或约定的无输入超时，再开放主动播报。输出仍以现有播放完成语义为准。补“A final 迟到而 B 正在说”“她连续说话跨 restart，后台结果同时就绪”的假时钟测试。

5. **[blocking] [MEDIUM] 700ms 宽限仍允许双说，10 次中允许 1 次不能作为“只说一次”的实现合同。（R1#7 剩余）**

   **问题与证据：** P:194 在 700ms 内没音频就启动客户端确认语，只有双说率大于 1/10 才换策略。P:190 的仲裁点明确不控制前台自发语音，因此没有规定如何处置 700ms 后才来的模型 filler。当前音频直接播放（V/codex/CodexVoiceBackend.ts:422–452）；clientManagedHandoffs 仅控制后台答案自动回送，用户提供的 rtstart.json:145–150、190–195 也明确区分这一选项与仅 V3 生效的 delegationAckFiller。

   **为何重要：** 一条确定的反例就能绕过该方案：handoff 后客户端已开始确认语，模型 filler 随后到达；两个出口都能播放。延长宽限只能改变发生概率，不能完成去重。重写后的验收实际上放宽了固定的一次确认语要求。

   **建议：** 在开始播放前确定唯一确认语生产者。V2 若不能可靠关闭/识别模型 filler，可预先选模型独占确认语，不再追加一个基于超时的客户端竞争者；客户端独占则必须明确另一路的可靠抑制办法。V3 接缝记录相应 filler 开关。保留实测作为兼容性验证，添加宽限边界前后及明显迟到的确定性测试，不把双说率阈值当成去重机制。

6. **[blocking] [MEDIUM] 改稿进程所称“今天的 voice-only 配置，订阅登录”相互冲突。（R1#11 修订回归）**

   **问题与证据：** P:209、220 直接复用现有 voice-only 启动档并要求订阅。但 V/codex-home.ts:11–13 强制 API 登录及 ephemeral 凭据，:45–50 明确拒绝存在 auth.json，:64–66 要求配置逐字相等；V/codex/CodexVoiceContainer.ts:632–645 会执行该校验并传入实时 API key。P:215 新建的是承载业务能力的 VOICE_CAPABILITY_HOME，不能直接拿它满足改稿进程空工具集要求。

   **为何重要：** 照所选档位启动，改稿进程无法同时通过现有 home 准入并使用订阅；复用原 API 档会把改稿回合放到 API 计费，而复用业务 home 又会重新引入可写 MCP。本轮已解决隔离方向，但还没有一个满足全部条件的启动配置。

   **建议：** 显式定义“无工具 + 订阅”的改稿配置/验证分支：复用禁用工具的设置，独立受管 home、宿主 auth 真源软链接，不继承实时 API key 和业务 MCP，保留旧 voice-only 档原样。列出构造与销毁责任；用完整启动链验证 account.type=chatgpt、空有效工具集、一次普通 turn/start 和超时清理。只需清楚地区分工具策略与登录策略，无需再造业务 agent。

7. **[advisory] [MEDIUM] operation_not_in_manifest 不能一律分类成 founder_only_denied。（R1#8 修订回归）**

   **问题与证据：** P:108 将该错误与 reserved_operation 无条件合并。T/lead-backends/codex/lead-capability-proxy.ts:196–201 对任何未出现在 manifest 的 operationId 都返回前者；缺凭据、browser=off、未知操作名均可能触发。P:63、100 本身就允许非 reserved 操作不被装配。

   **为何重要：** “此会话没有浏览器/集成”会被误说成“只能你本人做”，还可能生成无意义的 Lead 信箱通知。原 R1 的虚假提交问题已解决，不必为此重新设计 founder gate。

   **建议：** 结合请求 operationId 在可信 catalog 中的 classification 分类：reserved 才进入 founder-only 文案；缺少非 reserved 能力按 unavailable/revoked 处理；未知操作按 invalid/unknown 处理。补 browser=off 和缺集成凭据的反例。

## Verdict

CHANGES REQUESTED

完成本轮第 1–6 项的合同修订后再进入实现；第 7 项可随拒绝分类实现修正。已关闭的 R1 项不要求重开架构讨论，后续按计划验证即可。全程仅写本 Round 2 反馈文件，未修改仓库文件。

