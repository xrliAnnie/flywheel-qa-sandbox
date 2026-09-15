# FLY-2447 Raya 统管业务 — 实现验证
Issue: FLY-2447 (https://linear.app/geoforge3d/issue/FLY-2447)
日期: 2026-09-14
基于: plan.md

## 当前边界

实现进行中，A–G 尚未完成。设计 R3 effective APPROVED 已重新查询确认。
Lead instruction `51832ca5-f707-4993-9c7e-f8c4f5e3a185` 要求恢复指定 stash、禁止嵌套仓、完整包测试交给 exact-head CI、review 运行期间不 push；已遵循。
Question `1926e27e-20a3-4eab-9f46-f3175a2f0000` 已授权独立 checkout `~/.flywheel/worktrees/raya-FLY-2447`。已从 Raya origin/main `9d63a2b` 创建 `flywheel-FLY-2447`，锁定依赖安装完成；业务代码尚未修改。交接须一张非 draft Raya PR，与 Flywheel PR 互链，两仓独立可合并。生产 checkout 未动。

## Summary expected head（C 的平台部分）

可选 `summary merge --expected-head` 贯通为 `expectedHeadSha`，在机械验证前拒绝不匹配的当前 HEAD；对已合并 PR 的对账路径也生效。原完整 diff 检查和 GitHub match-head 原子合并约束保留。
红灯：5 个新增测试失败；实现后 summary merge / command / verifier 共 40 项通过。尚未接 Raya 理解状态机，不能据此声称 summaries 业务完整。

## B2 回复引用

新增可选 v1 `replyTo`，校验 message/channel/可选 author 数字 ID；保持无引用 envelope 的编码和 render 字节不变。平台参考与 outbound replyRoute 分开。
REST → DiscordInboundMessage → CodexDiscordMailboxStrategy → CommDB/queue → envelope → 实际 channel 属性已贯通。Bridge founder-reply-deliverer 和 CLI `--reply-to-json` 同步；CommDB 通过 IngestDiscordChatArgs 类型转发，不另造引用。forward 类型不充当 quote reply。
重复投递在 claimDiscordLane 的同一事务内比对原引用；不能补写或更换原引用。partition key 仅在有引用时加入该字段，旧 key 不变。现有 ACK/hold 不重写 content。

红灯证据：恢复的 ingest 测试 8 failed / 17 passed；CLI 拒绝未知 reply-to 参数；Bridge canonical-row 测试缺少 reply 属性。
绿色证据：

- comm summary + ingest 四文件：65 passed。
- CLI chat-ingest 聚焦：3 passed（其余 57 未选中）。
- REST source：20 passed，含跨频道、删除目标、缺省当前频道及 forward。
- Codex mailbox strategy：7 passed，含真实 REST fixture → mailbox → 重开 DB → rendered content 整链。
- founder-reply-deliverer：46 passed。17 个旧夹具原先用非数字 card/wrong-thread ID，被新引用校验拒绝；改成具相同对应关系的 snowflake 常量，保留原断言。
- `pnpm --filter flywheel-comm build` 通过。锁定依赖 install 与 comm/core 必要依赖 build 完成；初次缺 dist 的 typecheck/collection 失败保留为环境预备失败，不计行为红灯。

尚无全仓 CI、有效 code review、PR、真人旧日报 quote-reply 或生产运行证据。B1 主动圆桌和 Raya 全部业务批次仍待实现；B2 的业务来源纪律及真机验收也未完成。

## B 目录工具

`compileBusinessDirectory` 保留全部项目和 Lead；无元信息行明确列出 missing，无可读根目录则 unavailable；workingSubdirectory 的 lexical/realpath containment 不通过时不投影工作路径。display/alias 多义时拒绝并列稳定 ref，目录不授予文件权限，不输出 token/env 值或 writableRoots。

标准 `lead_actions.directory` 由宿主指定 registry 路径；只读一次字节，SHA-256 与 parseAndValidateProjects 基于同一字节。新增只读选项 allowEmptyLeads，让无 Lead 项目仍可展示；默认运行时校验保持拒绝空 leads，原 170 项 ProjectConfig 测试通过。错误输出不带可能含秘密的原始校验文本。

配置消费者已接 MCP config、shell renderer 的 env builder、headless runtime 和 TUI expected config。工具清单新增 directory。实际 stdio MCP 客户端在 Bridge/direct 与多次重启的子进程中调用 directory 并核对项目返回，5 项 integration 测试均执行通过，未因缺 dist 跳过。

验证：目录/ProjectConfig/runner MCP 共 180 项通过；config/MCP/integration 共 36 项通过；headless registry 传播聚焦 1 项通过；旧 lead-directory 2 项通过。teamlead 及所需依赖构建通过，构建期间补正 B2 raw channel_id 可选类型，使缺失频道继续交由 envelope 必填校验拒绝。完整 host package suites 未运行，按 Lead 要求留给 exact-head CI。

目录已完成平台接线；B 的主动圆桌和结构化发送回执仍待实现。A–G 不因这些聚焦绿灯被标成完成。


## B 通用业务唤醒

可选 businessWakeFile 仅接受 state/business-wakes.json；复用现有 GatePoller tick，不新增 timer/service。读取限制为 16KiB，拒绝 state/file symlink，严格检查 version、schedule 数量、未知字段、时刻和时区。每拍固定 now/founder timezone，候选入库前重读同字节 digest；配置变化留给下一拍。

只取最近到期当地日；春季缺失时刻向前移过 DST 缺口，秋季重复时刻取第一次。事件身份不含 revision，冻结 localDate/dueAt/timezone/configDigest。先写 lead_events 再投递，重启补投仍使用原事件，关闭日程不撤销已入库事件。两种 Lead runtime 均完整渲染冻结身份，避免默认摘要截断。

验证：schedule/pass 7 项、ProjectConfig 170 项、GatePoller health 11 项、完整消息渲染 1 项，共 189 项聚焦测试通过；teamlead 类型构建通过。首次构建暴露缺失 LeadEventEnvelope type import，补正后通过。retention consumer gate 返回 ok:true/errors:[]；恢复查询只读取 live lead_events 的未投递业务事件，未新增归档重放消费者。此前行为红灯及恢复用例由本批测试保留。

尚待 Raya 日程 seed/CLI/部署导入接线、主动圆桌与结构化发送回执。没有全仓 exact-head CI、有效代码评审、真实晚间日报或生产验收证据。


## B1 主动圆桌持久化基础（尚未开放入口）

outbound_dedup 增加可空 binding/engagement 列；旧表原地迁移，旧行不获得主动圆桌权限。新 claim 冻结 project/lead/parent/payloadHash，同 key 不同绑定拒绝；sent 与 engagement pending/ready 分开保存，只有绑定及 messageId 都匹配的 sent 行才能转 ready。新绑定的已发 receipt 不可替换。in-memory 参考实现保持相同语义，出入均复制 binding。

红灯：新增 SQLite 测试 2 failed / 原 9 passed，分别显示重开后无 binding/engagement、旧行可被新 binding 认领。实现后 dedup 12、handler 16、inspect CLI 7，共 35 项聚焦测试通过。包含 pending/ready 重开、旧 schema 迁移、新表按旧列读取、错误 receipt 与调用方 mutation 拒绝。retention consumer gate 返回 ok:true/errors:[]。首次类型构建发现数组解构可能 undefined，增加字段类型检查后，teamlead 构建与 dedup 12 项复验均通过。

本批仅提供持久化接口；Bridge handler 主动分支、owner capability、订阅预算/catchup 与客户端 outbox 仍待实现。原 FLY-676 主动发送 guard 保持生效，不能据此声称主动圆桌可用。


## B1 内部 socket owner 协议

现有认证 inbox socket 增 engageProactiveTopic，严格校验字段并签名 lead/owner/parent/真实 messageId/eventId/payloadHash；线程 ID 仅由 messageId 返回。可选宿主 hook 同时检查运行期接收权、socket inode/dev 与 accepting，才宣告 roundtable_proactive_engage_v1。入口、await 返回及 hook 每次写前使用同一个 assertCurrentOwner。请求不调用 submitBatch、不启动模型 turn。

红灯：新增 2 项测试分别缺 capability 与 client method；实现后 socket 15 项聚焦测试通过，包括认证、错误 lead/parent/owner、格式、无 hook、await 中接收权失效和实际 socket 路径替换拒绝。teamlead 类型构建通过。当前 runtime 尚未注入 proactive hook，因此本提交不会宣告尚未完成的业务能力；下一步接 durable subscription admissions/catchup，再接两个 runtime、Bridge 和 client。


## B1 持久化 continuation budget

subscription ledger 保持 version:1，新增可选 continuation.remaining/admissions；读取校验，registry 返回深拷贝。运行期 mention gate 通过共享 wiring 将 sourceMessageId 准入判定与预算余额在一次原子文件替换中保存，然后更新内存；重复 human/bot 消息复用已持久判定，不重新补满/扣减。旧 ledger 无余额视为耗尽。新话题 seed 随 membership 同次写入，在 addChannel/drain 前提交，重复 engagement 只读取现有余额。

gateway 将 policy 调用纳入失败处理：落盘失败返回 false，source 保留游标，不把失败当成终态过滤。业务投递仍由原 durable intake/journal 做消息去重；admissions 只保留预算判定，允许失败投递原样重试。

红灯：2 项新增测试失败（重复 human 补满、无落盘失败反馈）。修复后共 102 项不同聚焦测试通过，覆盖 budget、legacy restore、重复消息、gateway retry、mention gate、reply wiring、subscription startup/ledger。teamlead 类型构建通过；retention consumer gate ok:true/errors:[]。当前仍缺 proactive engagement 绑定、root 到已有 cursor 的补读及 runtime/Bridge/client 接线，不能宣告 B1 完成。


## B1 REST 根消息补读基础

现有 REST source 增 catchUpProactiveChannel，必须有 durable cursor 和 handler；先保存根游标，全部读取带 after，不走最新消息 baseline。通过回调保存独立补读游标；可指定冻结的 through 边界，不回退公共游标。每次最多 20 页，达到页数限制或投递要求重试时返回 pending，读完后才激活动态频道。await 返回后、投递/进度写入/激活前检查 owner。

同时修复 FileInboundCursorStore 的失败缓存：原实现在写失败时先修改 cache，相同值重试会跳过落盘；现在 rename 成功后更新 cache。

红灯：REST 新增 3 failed / 原 20 passed；cursor 新增 1 failed / 原 5 passed。实现后 REST/cursor/dynamic/lifecycle 共 43 项聚焦测试通过，teamlead 类型构建通过。覆盖订阅前第一条回复、已有公共游标不回退、分页 pending 续读、await 中 owner 失效、写失败同值重试。下一步必须把进度回调接入 subscription ledger，并完成真实 runtime/Bridge/client 通路；当前 source 方法尚未由 proactive wiring 调用。


## B1 proactive subscription 接线

onProactiveTopicEngaged 串行处理回执，校验 parent/eventId/payloadHash 后沿原 ensureThreadFromMessage 建/确认线程。新回执、membership、seed 和冻结 after/through 在补读前同次持久写入；REST 补读回调逐条保存进度，未完成保持 pending，完成后写 ready。重启普通 activateSource 跳过 pending 项，待同回执继续补读。共享 source 新增可选 cursor/catchup 能力，旧 source 无能力拒绝主动路径。

ledger 仍为 v1，新增可选 proactive 状态与 proactiveBindings 历史绑定；取消/TTL/容量移除 membership 后保留绑定，避免旧 receipt 重建并再次 seed。await ensure 后再次检查取消状态，owner guard 在后续写入与激活前复核。历史绑定只存非秘密身份和 hash。

红灯：缺少 proactive 方法；新增退休重放用例原先错误返回 ready。修复后 24 项聚焦测试通过（proactive 4、durable budget 4、startup 6、wiring 8、ledger 2），类型构建通过。真实 REST source+mention gate+ledger 组合用例接收了订阅前无@回复且预算只扣一次；另验证重启续游标、取消后重放、await 期间取消。尚未注入两个 runtime 的 socket hook，Bridge/client 尚未开放主动发送，B1 与 A-G 整体仍未完成。


## B1 两种 runtime 的主动接收 hook

headless 与 TUI 的实际 CodexLeadInboxServer 构造点在 autoContinue 开启时注入相同 proactive hook，parent 来自解析后的 replyInThread 配置，执行委托给已实现的 durable wiring。isCurrentOwner 读取 CodexDiscordRuntimeOwnership.proactiveReady：running、gatewayStarted、socketListening 以及 socket/ingress 两把锁必须同时成立。此检查与 socket inode/owner 检查叠加。

新增 ownership 红灯测试证明原先无 readiness 方法；实现后 ownership 6、headless 128、TUI 29 共 163 项聚焦测试通过。测试区分 mailbox 已可用但 gateway 尚未启动的阶段，并验证 stop 开始即撤销主动能力。首次类型构建暴露 owner/socket 循环推断，给 callback 明确 boolean 返回类型后，teamlead 构建通过。

尚待 Bridge 服务端主动请求校验/能力探测、dedup 续订阅、客户端 outbox 与 MCP 入口，未声称真实主动发送已可用。


## B1 Bridge 主动发送与续订阅

现有 outbound handler 接受可选 roundtableEngage:true；发送/主动 probe 先走 registry 精确 parent、external 排除及认证 inbox capability。plugin 已注入生产 hook，stateDir 复用现有 Lead inbox 解析。prepare 冻结 socket owner，调用 engage 前重新探测同一 owner；runtime 再检查实时 owner/lease。

新路径冻结 project/lead/parent/text+nonce hash，原 dedup claim 后只发一次。发送已证实但订阅未就绪时 HTTP 202 返回 status:pending/sendStatus:sent/messageId/engagement:pending；重试沿旧 messageId 续订阅，全部 ready 才返回 sent/threadId。旧未绑定行不可用于 proactive，同 key 不同绑定或去掉 proactive flag 都拒绝。并发 in-flight 保持 ambiguous；失去 capability 后仍保留已发回执。HTTP 适配层同步透传这些可选字段，旧响应字段不变。

红灯：handler 新增 3 failed；Bridge helper 新增 2 failed；HTTP 回执字段丢失新增 1 failed。最终 handler/proactive/dedup/Bridge adapter 共 51 项聚焦测试通过，teamlead 构建通过；含同 key 并发仅一条父消息、重建 handler 后续订阅、external/错 parent 无 probe、owner 变化拒绝及 capability 消失不重发。客户端 outbox 与 MCP 入口仍待接线，不能据此声称 B1 端到端已可用。


## B1 客户端 outbox 状态

CodexOutboundSender 为 outbox 增 roundtable_engage/engagement/project_name 兼容列，enqueue 冻结主动模式及项目绑定；主动 probe 与 POST 透传 flag。sent+pending 保留真实 messageId 并允许同 key 续订阅，只有 ready 才短路。后续断网或不兼容回应不会降级已发事实；初次不兼容回执仍按 ambiguous 拒绝盲试。allocator 对 pending engagement 不因 TTL 轮换事件 ID；跨项目/Lead 打开主动 outbox 时拒绝投递。

红灯：原客户端把 202 pending 误判为 incompatible success；跨项目 reopen 原先错误允许。实现后 sender 28 项聚焦测试及 teamlead 构建通过，覆盖文件数据库重开、已发后网络错误恢复、ready 本地短路、flag 绑定冲突、TTL 保持 key 与跨项目拒绝。MCP/core 仍未调用新增主动参数，下一步接标准工具入口及结构化结果。


## B1 标准工具入口与结构化回执

runDiscordSend 新增宿主 bridgeRoundtableEngage probe；只有 Bridge send 与实时能力同时可用才绕过主动 roundtable guard。MCP bridge 模式使用现有 outbound.probeAuthorization(channel,true)，然后 enqueue 固化 flag 并传回完整 pending/ready 结果；没有新模型参数或自报能力 env。现有 headless/TUI 的 Bridge/outbound/autoContinue 配置已贯通，无需新增另一份能力配置。旧 gateway/direct 无 hook，原 guard 仍生效。

pending 不进入成功去重缓存，使用同 eventId 续做；ready 结果包含 threadId。MCP 返回 structuredContent（含 eventId），并保留文本；限流结果新增 status:rate_limited 和准确 retryAfterMs。

红灯：core 新增主动 pending/ready 测试被原 guard 拒绝。修复后 core/guard 33 项、实际 MCP 子进程 6 项，共 39 项通过；teamlead 构建通过。MCP integration 全部实际执行，未 skip；本机假 HTTP endpoint 验证 probe/两次同 key 主动 POST 及结构化 pending→ready。尚需将真实 socket、Bridge handler、REST source/durable intake 组合做一条完整集成验证和故障矩阵；真人两 Lead/生产证据仍未取得，A-G 整体未完成。


## B1 完整本地链路与失败矩阵

新增组合测试使用实际 HTTP、CodexOutboundSender 文件 outbox、Bridge handler/SQLite dedup、HMAC inbox socket、proactive wiring、REST source、mention gate、CodexDiscordMailboxStrategy 和 CommDB。仅 Discord 网络回应与进程接收权检查为 fixture；没有调用真实 Discord 或启动 Lead 模型。

四个失败点（建线程、ledger 写入、source 激活前、补读进度落盘后）均在父消息已发且首条无@回复已存在的条件下注入。关闭并重开客户端、dedup/CommDB 与 inbox runtime 后均沿同 key 续做；每例父消息总数为 1，早到回复进入持久 mailbox，预算剩余 1，最终 ready。扩展 fixture 时曾出现 failurePoint 未声明的测试装配错误，修正后四例实际执行通过。

按 plan §2.2 审计补齐 MCP structuredContent 的 project/leadId/target/deduped，并从 core 真实缓存/Bridge结果取 deduped；无状态错误明确 unavailable。新增 MCP 身份断言先失败，修复后 chain 4 + core 20 + real MCP 6 = 30 项全部通过；teamlead 构建通过。未选中的首次聚焦 MCP 测试不计绿色用例；最终六项均执行无 skip。

平台 B1 本地主通路已连通；真实双 Lead 和生产窗口仍未验收，完整审计还需覆盖全部批准计划条目与 exact-head CI/review。下一步进入独立 Raya checkout 的 A/C/D/E/F/G 业务实现和日程 seed/部署文档。

## A Raya 操作账本基础

独立非生产 Raya checkout 的 e2f06cd 新增 OperationStore：operationId 哈希文件名、schemaVersion 2、revision CAS、冻结 inputDigest/kind；短同步事务使用 wx owner nonce 锁，同目录临时文件 fsync/rename/目录 fsync。遗留锁显式暂停，不用 PID/TTL 偷锁；读到坏 JSON/schema 不清空、不覆盖。读写前检查 state/cos/operations 目录，文件 O_NOFOLLOW；构造后替换成 symlink 也拒绝。此处没有声称能对抗恶意并发替换所有父目录的完整文件系统竞态。

新增测试最初因模块不存在失败；实现后 6 项通过，覆盖文件重开、stale revision、绑定冲突、损坏保留、遗留锁及 symlink。Biome 初检报告 finally 内 throw，重构为分别捕获事务/清理失败，双失败保留 AggregateError 后，两个文件 Biome 与 CoS build 通过。未运行 host 全包套件。

这仅是 A 的持久基础，尚无 prepare/record/resume 消费者；不声明 A 完成。下一步按批准计划接业务协议、旧两条 CLI 兼容、实际 summary/question/report/meeting 消费者，再推进其余批准批次。两仓均未 push/开 PR；review/CI 与生产验收未完成。

## A prepare/record/resume 的可执行 announcement 协议

Raya a342d5f 新增 BusinessRound 并接入实际 CLI 的 prepare/record/resume/status。prepare 版本/字段校验后冻结 sourceRefs、eventId、target、body 与摘要；同输入重入读取原状态，同 operationId 换正文拒绝。record 绑定 operation/revision/tool/callId 和 Raya 标准工具 structured result，保存调用来源；JSON 校验不声称机械认证来源。roundtable sent 要求真实 message/channel 与 ready/thread 匹配；已知 message/channel 不允许改写。pending 保留同一意图，ambiguous 保留 unknown 且不返回发送意图，rate_limited 保存截止时间并等待。

CLI 输入仅接受 workspace 内普通 JSON（≤1 MiB、无 symlink），status 枚举原操作且不将损坏状态当空。identity/README 给出实际 node business/current 路径、当前 turn 的工具调用/record 与 batch ACK 边界，并删除旧 persona 中 posting 无 receipt 盲重发和“宁重复”的指令；summary 指令新增 understood head。此阶段 announcement 是已接通消费者，其余 summary/question/report/meeting 业务状态机仍需后续接入，不声称 A/C/E/F 完成。

红灯：business-round 模块缺失；CLI prepare 原先 unknown command。实现后业务 round 6、store 6、CLI 4、能力边界 7，共 23 聚焦测试通过；六个修改 TS 文件 Biome clean，CoS build 通过。旧两条 CLI 测试实际执行。包含真实临时 workspace 的 prepare→resume→record→status，以及外部路径、symlink、大文件和未知 flag 拒绝；未运行 host 全包套件、未外发工具或部署。

## C 定向追问与纯 summary 准备

Raya 本批将 kind:question 接入现有 prepare/record/resume CLI。输入使用 durable sourceRefs（无 founder message 要求）、requestId/revision 和标准 directory 的精确 canonical ref；唯一非external且有 bot/roundtable 的目标才能准备。冻结目录摘要、目标 bot/parent、正文、来源与问题身份，生成含 mention/关联 ID 的 roundtable 意图。已发但 engagement pending 为 sent，ready 才 awaiting_reply，不伪造 deliveryId。

lead_inbound record 验证 author、channel/topic、replyTo 或 exact requestId/revision；不匹配不结清。过期由 resume 持久标记，迟到保留 late 且不改 answered；取消有本地 reason/source receipt，后续旧消息不能复活。JSON 来源仍由标准 Lead 的真实入站纪律保证，不将结构校验声称为机械身份认证。未关联材料目前由当前 turn 保留，统一待关联索引尚需后续完善。

summary-absorption 的 mergeCandidates 改为 reviewCandidates；缺 Facts/Judgment 仅返回定向问题材料，规划不调用 request transport。无问题/空轮也验证 roundId。persona 同步空轮对账 report_line 要求。完整 summary 执行器（理解+完整diff/head、legacy round行、merge对账、memory provenance/commit、轮次报告）仍未接齐，C 未完成。

红灯：question 新增四项拒绝未知输入；expiry/cancel 两项分别保持 awaiting 与 tool mismatch；summary 两项显示规划实际发送和空轮不验证。修复后 question 7、business-round 6、CLI 4、summary 3、原能力边界 7 共 27 聚焦测试通过；五个修改 TS 文件 Biome clean、CoS build 通过。没有 host 全包套件或真实双 Lead 外发/生产验证。

## C 单 PR 理解、head 复核和 merge 对账

Raya summary-workflow 已接实际 BusinessRound/CLI kind:summary：冻结 mainCommit、PR head、完整文件材料与来源，范围/大小校验后进入 reviewing。当前标准 turn 的 understanding record 必须匹配 PR/head、覆盖全部文件证据且理解非空；Facts/Judgment 缺失不能 understood。字段齐全不直接生成 merge。之后返回标准 gh head check；相同 OPEN head 才生成唯一 flywheel-comm summary merge 意图并带 --expected-head，changed head 停止旧操作。

真实 merge structured result 验 verifiedHeadSha/文件集合/action；unknown 改走 canonical gh 对账，重建 BusinessRound 后 MERGED 仍保留 merged。这里 merged 是业务恢复索引，不复制 GitHub 作为合并真相；没有标完整业务完成。CLI 不执行工具或授予 merge 权限，原 Flywheel mechanical guard 保留。

红灯：新增四项因 kind 不支持失败；后加多文件证据测试发现少引一个文件也可 understood，补齐集合覆盖后通过。最终 summary-workflow 6、summary planner 3、question 7、business-round 6、CLI 4 = 26 项聚焦测试通过，三个修改 TS 文件 Biome clean，CoS build 通过。没有实际 gh merge/发信/部署，也未运行 host 全包套件。

仍需汇总层冻结 round inventory、写原 legacy round 行并确保先于效果、对已合并 provenance 缺口采样、每轮 memory commit/push 恢复、report_line 与空轮报告；当前 per-PR 协议不是完整 C 验收。后续必须把这些前置和后续接到同一可恢复轮次，不能仅凭单 PR 绿色宣布 summary 可用。

## C 冻结 inventory 与 legacy round 前置

Raya 新增 kind:summary_round CLI 注册：冻结 mainCommit、完整 inventory 与原 frozenEvent（含 report_line/producers/缺交状态），派生固定 round operationId。source unavailable 不可伪造空队列；成功空轮保留原 report_line。短事务先保存 registering，再用 exclusive owner 锁向原 state/summary-merge-receipts.jsonl 追加 fsync round 行，最后提交 registered。坏 JSON/不完整尾行/symlink/冲突 inventory 均保留并拒绝；不偷遗留锁。

单 PR prepare 和 record 现在必须匹配已 registered 的同 round/main/head/project/lead inventory；登记失败不能越过前置执行 merge 意图。原 legacy round 存在时同输入重放不重复追加；同 round 换主线/集合拒绝。此处不把目录逐步检查夸大为对抗恶意父目录并发替换的完整证明。

红灯四项确认旧单 PR 可绕过登记、summary_round 未支持；实现后新增注入 registered 状态写失败：legacy 行已经落盘，PR仍拒绝，重开同输入登记成功且只有一行。最终 round 5、summary-workflow 6、question 7、business-round 6、CLI 4，共 28 聚焦测试通过；修改文件 Biome clean，CoS build 通过。未运行 host 全包套件，未执行外部 merge/发信/部署。

仍待：已合并 summary 的 memory provenance 缺口采样、每轮一次 memory commit/push 及失败恢复、真实 report receipt 与空轮 report_line 输出、待关联入站索引，随后 D/E/F/G 与最终双仓 gate。registering 失败当前通过重复原 prepare 恢复，status 返回冻结材料供续办；完整 round 完成仍未声称。

## C canonical merged 与 memory provenance 对账

summary_round 的 current_turn record 已接受标准只读工具提供的 canonicalMerged 与 memory observation，冻结主线 SHA 校验；每个 canonical summary 的 PR/head/path/原 roundId 精确比对 provenance。空未读轮也检查历史已合并缺口，不将本地 merge row 缺失解释为 unread。跨项目路径或 stale main 拒绝。未知 GitHub/不可读 memory/dirty memory 分为 unknown/memory_dirty；有缺口为 memory_needed，clean且无缺口才 ready。

round 进度和原 frozen snapshot 分离但兼容已写 schemaVersion 2 文件，保留每次真实来源 callId/result 供恢复。单 PR prepare/record 增加 ready 对账前置，不能绕过未对账/脏/缺口状态继续新未读工作。结果 JSON 的平台来源仍由标准 Lead 工具纪律保证，不声称这一纯业务校验独立认证 GitHub 或 sender。

红灯：四项 reconciliation 因旧 record 不支持失败；新增前置测试确认原先未对账仍可准备 PR。实现后 reconciliation 4、round 6、workflow 6、question 7、business 6、CLI 4 共 33 聚焦测试通过，修改 TS Biome clean、CoS build 通过。没有 host 全包套件，也未写生产 memory/执行工具或部署。

尚待把 memory_needed 绑定完整材料的提炼/补写、每轮唯一 commit/push 及其未知结果恢复，再以真实 message receipts 完成含原 report_line 的报告；当前 record 提供对账/暂停状态，不声称已自动完成 memory 更新或 C 批次。其余 D/E/F/G 与最终 exact-head gates 保持未完成。

## C memory 草稿基础与提交顺序问题

current_turn memory_plan 已接 summary_round record。以标准只读观察的 memory commit/bodySha256 绑定 baseBody，保留原文前缀；仅接受精确匹配 canonical 缺口或本轮确认 merged summary 的提炼条目。草稿固定原基准，重入可读但不能换基准/改已准备条目，body/hash/provenance/预定 round commit message 一起持久保存。没有写 memory 文件、执行 git 或把草稿记成 committed。

红灯：新增两个 memory_plan 路径原先 invalid summary object。实现后 memory draft 3、reconciliation 4、round 6、summary workflow 6 共 19 聚焦测试通过；三个修改 TS 文件 Biome clean、CoS build 通过。负向验证 stale base、空理解、外来 provenance、修改原文及替换已准备条目。

向 Lead 发出非阻塞执行顺序澄清：历史 provenance 缺口先吸收与每轮只一次 memory commit，是否允许先持久历史提炼草稿再处理新 PR、轮末统一 commit，或历史恢复需独立 round。当前代码仍保留 actual clean provenance ready 前置，未按推测放开，草稿不计作已提交。继续可独立实现 commit/push 的精确结果与未知恢复，但完整 C 和记忆最终提交尚未完成。

## C memory 收尾与 Lead 排序裁定

Lead instruction `56ed5fc0-a0bf-453f-9e29-7489b358cdfc` 明确：历史缺口用同轮冻结草稿吸收，不另开 recovery round；只在轮末提交一次；草稿不得冒充已提交 provenance，历史与本轮新合并条目必须可区分。Raya `c8eb247` 实现条目 origin=historical/current_round，保留精确 PR/head/path/original round。未读前置要求干净观察基准与冻结 body digest 匹配、全部历史缺口均有不可替换的提炼；missing/dirty/unknown 仍拒绝，reconciliation 状态不伪改为 committed。

memory_finalize 要求冻结 inventory 每项具有最终 review/merge 结果，所有缺口及本轮 merged 文件均被草稿覆盖。之后禁止重开草稿；memory_result 对提交 parent、唯一 MEMORY.md 路径、正文 digest、固定 message 与 commit SHA 精确核对。unknown 时返回标准只读 git 对账指引，不盲重提；已确认 commit 的 push 失败/unknown 保留原 commit 恢复，已 pushed 不可降级。业务代码仅保存状态/返回当前 turn 工具协议，不运行 git、不写生产 memory。实际工具观察仍由标准 turn 提供，JSON 结构校验不构成来源认证。

红灯：恢复现场 2 条测试确认未实现 finalize，补入 inventory/provenance 覆盖守卫后共 4 failed；排序测试另经历 1 failed。实现后 summary memory 8、reconciliation 4、round 6、workflow 6 共 24 项通过，3 个修改 TS 文件 Biome clean，CoS build 通过。未跑全仓 gates、未做真实 memory git/remote 故障验收，不能据此宣称 C 完成。

下一步：summary 每轮实际 report receipt（含空轮 report_line）、无 memory 修改轮次收尾、待关联入站；继续 D/E/F/G，最后双仓有效代码评审、完整验证及 exact-head CI/PR。生产运行与连续两天日报仍留给授权 QA/部署验收。

## C 每轮 report receipt 与无记忆变更收尾

Raya `0db04b9` 将 report_prepare/report_confirm 接入现有 summary_round CLI。报告从冻结 inventory 的实际终态计算检查/吸收/需追问数量，已发送问题要求关联 summary operationId、对应 target 与真实 messageId；包含原 report_line、roundId、项目数和 PR 列表。报告生成固定 announcement prepareInput，沿原发送状态机限流/unknown恢复；report_confirm 读取匹配正文/eventId 的 complete announcement，不接受模型自报 messageId 作为成功。真实 receipt 先追加原 legacy report 行，再完成 round；重入匹配原行，不重发。

空轮仅在 clean/ready 且没有 memory 缺口/新增 merged 时可无提交收尾。memory 已提交但 push未确认时，报告明确保留失败，round 为 reported_pending；下一轮仅恢复原 commit push，成功后 complete，不重复报告。identity 与 README 已接上述实际命令。

红灯：report 路径初始 2 failed；push失败报告后曾错误 complete，新增恢复测试1 failed后修复；legacy report行测试1 failed后补齐。CoS 全包在补legacy投影前通过37文件/187项；最后legacy/文案改动后，summary report/memory/round/CLI共21项通过，5个修改TS文件Biome clean、CoS build通过。这是业务包本地证据，不等同于双仓全repo gate、代码评审、CI或生产验收。无真实外发/生产写入。

仍待 C 的旧 question 账本兼容与待关联入站持久索引、实际source边界/迁移覆盖；D/E/F/G及最终双仓完整gates仍未完成。

## C 待关联入站回复

Raya `b97971e` 增 kind:inbound_reply，标准 CLI prepare 按 channel/message ID 冻结原始 author/body/time/replyTo/request correlation，重放改正文或作者拒绝。未能关联时保留 pending_association；current_turn associate 只允许精确问题作者、话题和回复/请求关联通过原 observeQuestionReply 校验。先冻结 questionOperationId，再调用原问题入站 record，最后保存关联完成。中断于问题已answered后，恢复读取原 inbound callId/content 的回执，仅补关联完成；错误作者/关联不推进，cancelled/expired 不重开，迟到原文在入站记录中保留。

红灯新增2项因原 CLI 不识别 inbound_reply 失败；实现后 question 10/business 6/CLI 4/summary report 2 共22项通过，3个修改TS文件Biome clean，CoS build通过。故障注入证明问题已更新但关联落盘失败后重开只保留一条回复回执；另验证取消后真实回复为late。手写fixture只验证格式/关联与恢复，不证明来源认证；实际平台author/replyTo验收仍需B2/QA真实来源。

C仍待旧question posting/posted账本兼容及迁移覆盖；D/E/F/G未完成。本批未运行新的完整CoS套件或Flywheel全repo gates，未外发或部署。

## C legacy question posting/posted 投影

Raya `51923d5` 接入旧 summary ledger。问题 sourceRefs 精确引用单个已登记 summary operation 时，冻结原 roundId/PR 与目标 Lead；先保存 registering，再追加带 eventId/body digest/requestId/revision 的 posting 行，成功后才返回发送意图。写行成功而 prepared 状态失败时，status不暴露发送，重开沿同一行恢复。实际发送 receipt 先存 operation，record/resume 再幂等追加 posted；通用巡视问题不伪造 summary PR。

旧 posting/posted 无可核 event/body binding 时保持 unknown，不换 key 重发，不凭缺 posted 推断未发送。只保留 message/channel 身份，不伪造无法从现有receipt证明的guild消息链接；完整旧账迁移与可见恢复告警仍需G批次。新增统一 hasConfirmedQuestionSend：ambiguous 单带 tentative messageId 不能成为 posted 或报告已发送计数。

红灯两项分别为无posting行、旧未知行仍返回发送；tentative messageId新增负向原先误写posted（1 failed）后修复。最终 summary round9/question10/business6/report2/CLI4，共31项通过；5个修改TS文件Biome clean，CoS build通过。故障注入证明posting已落盘、prepared失败后的恢复只保留一行。未重复CoS全包或运行Flywheel全repo gates，无外发/生产操作。

下一步推进D目标/全项目采样/偏离的当前turn消费者及移除默认transport，随后E日报/F会议/G迁移打包；最终仍须逐项审计A–G，不以C局部green宣布整体完成。

## D 移除默认驱动与当前turn采样入口

Raya `97d6c69` 删除 sampler/goal-store 的默认 child_process 驱动与 sampler 的隐式global fetch；兼容接口要求显式host adapter，GitHub probe无adapter明确unavailable。旧GoalStore回归测试显式注入已有测试runGit，仍用真实临时Git仓验证原提交/并发/回滚语义。新增2项边界测试先红；边界2+sampler6+goal-store10共18项通过，Biome/build通过。这里未把无adapter当成D可用验收。

Raya `1a82718` 接实际 BusinessRound/CLI kind:portfolio_sample：冻结 sourceRefs 与完整directory.projects，保留无repo/无summary项目，禁止未知项目字段携带额外配置；逐项目核repo/Linear绑定、完整reading组、明确ok/unavailable及值形状，成功读数必须位于当前轮观察窗口。返回标准工具10s/整轮90s预算；超出整轮拒绝结果，不能作为fresh。聚合all/activityAvailable由实际读数推导，不接受调用方汇总；v1 snapshot含稳定snapshotId/sequence，持久保存operation material，重开不丢材料。

新增采样3项初始因kind未支持失败；最终sample4/boundary2/sampler6/coordinator4/business6/CLI4共26项通过，3个新/修改TS文件Biome clean，CoS build通过。验证全集遗漏、外来repo、缺组、stale/deadline、unavailable项目、成功读数聚合与重开；无实际GitHub/Linear读取或生产操作。

D仍未完成：新snapshot尚未投影原SnapshotStore/接patrol消费者，超时轮的durable截止恢复待补；旧注入型采样的请求编排仍需最终边界审计。普通对话goal inference/纠正、逐目标项目证据与发布前fresh校验均待后续。继续D，再E/F/G与双仓完整gates；不以本地读取协议测试冒充真机业务可用。

## D 超时采样与原SnapshotStore投影恢复

Raya `d53ed91`：portfolio_sample collecting超过90秒时，resume/同输入prepare将本轮全部未提交读数保存为明确deadline快照，仍包含冻结目录全集，sampledAt固定原截止点，不用恢复时间伪装fresh。迟到工具结果不再能改写完成快照；纯status保持只读。

完成读数先持久保存operation material，再投影原state/portfolio/snapshots与latest.json；失败后resume只重试冻结字节，不重新采样。新序号从现有latest与操作账最大序号延续，保留旧snapshot消费者。投影成功单独保存snapshotProjected，未完成投影的status给出resume指引。

SnapshotStore补齐消费者前置：corrupt latest明确抛错且保留原文件，O_NOFOLLOW/regular-file/大小边界与目录symlink检查；同ID不同正文、同seq不同快照拒绝；writer使用exclusive owner锁，不偷旧锁；原子替换带fsync。保留50份按seq而非随机snapshotId字典序淘汰。这里不宣称对抗恶意并发替换所有父目录的完整路径竞态。

红灯：超时resume仍collecting(1 failed)，旧store可覆盖固定ID/跟随symlink(2 failed)，未投影(1 failed)，序号未继承(1 failed)；均修复。最终sample6/snapshot4/coordinator4/business6/CLI4共24项通过，5个修改TS文件Biome clean、CoS build通过。注入投影失败证明旧seq9保留直到恢复，新seq10及原观察时间不变。未重跑全包与Flywheel全repo gates，无真实外部采样/生产操作。

D继续普通对话goal inference/纠正/撤回、goal项目范围与发布前fresh校验；E/F/G和最终双仓gates仍未完成。

## D 普通对话目标、纠正与提交恢复

Raya `a1d3c7a`：goals格式增加可选kind/projects/revision/supersedes元数据；inference使用“提炼”而非“原话”，commitment保留逐字来源；旧无metadata格式/ID/Unicode/撤回行保持往返兼容。元数据项目集合/类型/修订与多行注入在边界拒绝。新增kind:goal_update CLI冻结实际source身份与链接、项目全集、clean goals基准。普通话无marker即可由当前turn记录最多5项record/correct/withdraw；推断不得冒充逐字承诺，外来项目和非匹配founder作者拒绝。纠正撤回旧ID并追加supersedes新修订，旧文本/来源/操作ID不丢。

计划冻结goals.md正文/digest/base commit/固定message，通过标准工具执行唯一文件commit；unknown结果只读对账，实际parent/path/body/message精确匹配后记录commit；push失败留原commit恢复。CLI不执行Git、不写生产memory。身份检查只能校验host提供材料之间的一致性，不把调用方JSON或unit fixture当真实founder认证；平台元数据和persona端到端证据仍需最终QA。

红灯：格式2 failed，CLI4 failed（kind未支持）。格式/旧GoalStore真实临时Git/evidence gate共23项通过；最终goal round4/contracts8/CLI4/business6共22项通过，修改TS Biome clean、CoS build通过。覆盖普通推断、逐字承诺拒伪、dirty/foreign scope、纠正保留旧目标、未知commit对账和push失败恢复。无实际业务Git提交/外发/生产验证。

D尚需将目标项目范围/修订与fresh读数接到实际偏离发布前守卫及主动巡视消费者；E/F/G及完整双仓gate/review/CI未完成。

## D 偏离发布的项目范围、新鲜度与恢复守卫

Raya `b38e52d`：scoped drift校验在旧envelope基础上要求被引用goal仍active且有明确projects，每个goal至少匹配一条被引用项目读数、每条读数至少对应一个引用goal；拒绝重复目标/项目、未来或过期snapshot、单独过期reading。旧publishPatrolJudgment入口必须传入证据context，缺失或无效时不会调用announce。

新增kind:patrol通过实际BusinessRound/CLI冻结已完成且已投影的portfolio_sample、latest.json及memory/goals.md正文。current_turn可保存silent(reason)或observation；仅验证后的内容生成标准discord_send意图。每次返回意图都重新读取目标和最新快照，以五分钟新鲜窗口保守拒绝陈旧观察。目标变更、snapshot被替换、symlink/不可读目标与过期读数返回next:null和publishBlocked；不通过换key重发。原发送回执通路保存unknown等待核实；证据过期后收到确切sent回执仍保存事实并完成，不抹去已发生外部动作。

红灯：scoped validator缺失2 failed；原发布入口绕过证据2 failed；patrol kind未支持3 failed。最终patrol round5/patrol3/drift3/scoped2/business6/CLI4共23项通过；7个修改TS文件Biome clean、CoS build通过。覆盖准备后撤回目标、超时、快照替换、不安全目标文件、ambiguous后迟到confirmed回执与幂等resume。未执行真实消息发送、全包/双仓aggregate、review或exact-head CI。

D尚未完成：durable patrol内question(target,evidenceRefs)与已有question操作关联仍待实现；当前可独立使用既有durable question协议。E日报/F会议/G迁移打包及最终A–G逐项审计、双仓完整gates仍待继续。没有QA/生产验收证据。

## D 主动提问关联与确认发送结果

Raya `cef05b6`：patrol current_turn新增question决定，冻结questionOperationId、target和evidenceRefs。被关联的既有question必须以当前patrol operation为来源、目录接收者一致；证据路径必须实际存在并属于目标项目，可引用明确unavailable读数发起澄清。返回resume_question意图使用同一现有question流程，未增加网络/模型驱动或私有Lead问答通路。

patrol恢复时校验question不可变inputDigest，只有实际sent且engagement ready的圆桌回执才投影questionOutcome:asked；ambiguous不返回新执行意图并保留needsReconciliation。取消/过期未确认问题保存对应结果，不冒充已问。已有inbound_reply继续负责原问题的精确回复关联。

新增2项测试先因invalid patrol decision失败，实现后增加取消未发测试。Focused执行实际匹配3文件18项通过（命令中另两个不存在的文件过滤器未计入覆盖）；随后完整CoS suite 42文件220项通过，包含question-round10及所有summary/goal-store回归。修改TS Biome clean、CoS build通过。实际生产双Lead往返仍无证据。

下一步E日报当前turn协议与去默认驱动，随后F会议/G迁移打包和A–G完整审计。D本地消费者进展不代替产品QA，双仓全repo门禁/review/exact-head CI/PR仍未完成。

## E 日报驱动边界与生成材料修正

Raya `3e80d06`：移除collector/repo-writer内默认execFile；兼容接口显式要求host command adapter，不改变固定repo/main、create-only及冲突采用逻辑。旧默认驱动取消测试移到测试侧注入实际子进程adapter，仍验证取消后不能把缓冲HTTP404当有效不存在，未放宽断言。

当前turn生成prompt保留完整source manifest（state/PR/head/blob/contract/omitted等），open明确未吸收，merged不冒充memory provenance已落账。正文要求两个非空真实二级章节、16KiB UTF-8限制，拒绝空标题及fenced code内伪标题，允许无新材料的短事实/判断。

红灯：默认驱动边界2 failed；去驱动后旧测试1 failed（显式迁移测试adapter后35/35通过）；生成非空/状态遗漏2 failed。日报目录9文件76项通过，最终生成2项复核和CoS build通过，修改TS Biome clean。此处尚未接daily_report持久化current_turn操作，不能声称日报端到端可用。

下一步：按plan §6将冻结wake日期/时区、source manifest、正文清洗/引用校验接到BusinessRound；再接create/adopt恢复、context索引、分片限流与真实replyTo反馈。F/G、A–G审计及双仓最终gates/review/PR均未完成，无真实报告发布或生产操作。

## E 日期唯一的持久化日报生成

Raya `1627bb0`：BusinessRound/CLI kind daily_report采用真实平台business_wake字段scheduleId/revision/configDigest/localDate/dueAt/timezone，校验日期和本地时区一致、不提前触发。固定daily-report:date操作身份，配置修订/重启复用原冻结日期操作，不重算今日。sourceRefs仍须来自实际平台envelope，调用方JSON不是认证。

current_turn collect冻结mainCommit/source manifest/silent/清洗后的内容；复用原严格report metadata契约，保留omitted，不接受伪造省略内容。generate只接受本轮可读索引引用，拒绝外来引用与raw URL/path绕过；正文先清洗，索引转为固定head的可读project/Lead链接，open显式未吸收，再检查非空facts/judgment与16KiB限制，重算文档hash。原始含secret-like正文不写入receipt；generated保存正文/document/manifest，可跨日恢复原字节。

红灯：daily_report入口未支持3 failed。最终round4/generator2/business-contract3/business-round6/CLI4共19项通过；链接展开后round4复核、CoS build和修改TS Biome clean。未运行本批全包或双仓aggregate；没有产品外部写入。

后续仍需probe/create/adopt实际回执reducer、安全bodyFile/context投影、分片限流/未知发送恢复与replyTo索引；当前generated仅给固定仓路径probe意图，不代表已发布。F/G与A–G总审计、双仓gates/review/PR仍未完成。

## E 固定仓文件创建与冲突采用恢复

Raya `92fe11f`：日报generated/reconciling_file只接受标准turn probe固定xrliAnnie/raya/main/reports/date.md；absent才冻结create-only意图，不提供update sha。create冲突或unknown进入reconciling_file，恢复仍只读probe，不重放未核实写入；created必须Git blob SHA与冻结document实际字节一致。

已有合法文件校验日期、frontmatter/body digest、非空事实判断和完整Git blob后采用正文/manifest/meta，保留原draftDocument及draftCitedSources，不沿用草稿引用指向被采用文件。record保存安全结构化status/repo/ref/path/fileSha审计字段，未把未确认文件算成file_written。所有工具事实仍必须来自真实标准工具结果，不把调用方JSON当独立认证。

红灯：新仓回执3项先失败（stage未支持）。最终日报目录10文件83项通过，CoS build与修改TS Biome clean。覆盖创建前不存在、unknown后重启只读、外来path、错误blob、冲突文件采用和禁止替换已冻结正文。无实际GitHub业务写入/消息发送；完整双仓aggregate/review/CI尚未运行。

下一步安全bodyFile/context投影与分片计划/限流/unknown恢复，再replyTo反馈。file_written不是已送达。F/G及A–G审计、双仓最终gates和PR仍未完成。

## E 正文与讨论context的安全投影

Raya `b48224d`：generated正文通过内容hash写入state/daily-report/date.body.hash.md；file_written回执先持久保存，再投影不可变date.context.json并进入context_ready。索引含repo/main/path/fileSha/bodyHash和冻结title/body/footer分片、顺序、hash及稳定eventId。每片按UTF-16最多1800、不拆surrogate；只保护manifest中的确切GitHub来源URL免于通用secret-pattern误删，其他文本仍清洗。

文件使用owner-only临时文件fsync、exclusive hard-link发布与目录fsync；同字节重放不重写，已存在不同字节/损坏context保留并拒绝推进。目录lstat和文件NOFOLLOW/nonblocking/regular-size读守卫拒绝symlink。恢复重新校验正文与context，人工修复冲突后只重试原已保存操作，不重复仓写。此处不声称覆盖所有恶意父目录并发替换竞态；旧compat storage接口尚未全面替换，最终边界审计仍须检查其使用者。

红灯：缺bodyFile/未拒绝冲突context/缺symlink恢复检查共3 failed。最终日报+business-round+CLI共13文件96项通过，CoS build与修改TS Biome clean。旧仓回执测试的外部view更新为context_ready，对应新增自动投影；未放宽Git blob或create-only断言。无真实消息/生产操作。

下一步E分片实际receipt、每60秒最多4次尝试与平台retryAfterMs、unknown对账，以及replyTo/日期讨论关联。context_ready不是posted；F/G、A–G总审计与双仓最终门禁仍未完成。

## E 分片发送尝试、共享限流与未知结果对账

Raya `aa679a9`：context_ready/posting先current_turn begin_send，在共享CAS预算账预留一次尝试后保存inFlight，再仅本次返回标准discord_send。不同日报日期共用rolling60s最多4次；预算与操作之间崩溃可保守消耗slot，不能额外授权发送。实际发送仍走平台原chat总限流，未改通用5/60s配置。

sending重启/恢复不重新返回外发意图；ambiguous/pending保持send_unknown，仅真实匹配sent解除当前分片。失败/限流保留同eventId，retryAfterMs控制nextAttemptAt；明确其他失败等60秒。sent须匹配project/lead/chat/eventId及有效message/channel，拒绝复用其他分片messageId和换channel；每片都确认才posted。未知状态之后的瞬时失败不抹掉未知事实。安全artifact核验在begin/send record前进行，context冻结不被回执更改。

红灯：发送入口缺失3 failed；实现时共享账摘要不符合OperationStore格式3 failed，改为正常SHA256未放宽契约。最终日报+business+CLI共14文件100项通过，CoS build与修改TS Biome clean。新增跨日期预算/status验证；无真实平台消息。本地posted fixture不构成产品送达验收。

下一步E按真实replyTo/source author关联报告讨论，日期无歧义回退、幂等反馈与失败通知；随后F/G、A–G审计和双仓最终gates/review/PR。整体未完成。

## E 日报回复关联与可恢复反馈

Raya `7d98ec7`：kind report_reply按source channel/message生成唯一操作，校验host founder与实际author一致。replyTo只关联同channel、observedAt前已确认sent分片；外来replyTo不退回日期猜测。无replyTo时仅一个明确日期可关联现有context，多义/无匹配保留needs_clarification；澄清使用稳定eventId和原announcement协议，避免重放另发。

关联后先标准工具读确切Git blob，再record verify_report校验blob/bodyHash。当前turn interpret保存忠实反馈note和原source，重启重放返回同记录，同ID不同内容拒绝。反馈记录不自动写承诺；需要goal_update时沿用原平台source，不能把模型note冒充原话。ID一致性校验不是独立身份认证，真实平台envelope仍是权威。

红灯：report_reply入口缺失3 failed；focused3/build/Biome通过。默认完整CoS运行结果为47文件通过/1失败、240项通过/1失败：SnapshotStore newest50测试超过5000ms。保留该非RPC超时失败，不适用PACKAGE_GATE_RECEIPT豁免。未改生产实现、测试断言、skip或timeout。该文件单独4项通过（保留测试约1257ms）；受控 `vitest run --maxWorkers=1` 全包48文件241项通过，40.59s，日志 /tmp/FLY-2447-cos-report-reply-serial.log。此为独立受控绿色证据，不把原默认并行红灯改称绿色。最终build通过。

下一步E失败通知与后续恢复，随后F/G、A–G审计/双仓最终门禁/review/PR。没有实际founder回复、连续两天真实日报或产品送达验收证据。

## E 独立失败通知与原阶段继续恢复

Raya `7e484db`：current_turn failure保存实际阶段、清洗reason和sourceRef，保留全部原正文/context；冻结同日报唯一notice input，后续失败不改已冻结正文/eventId。普通announcement流程负责真实发送/unknown恢复，confirm_failure_notice只接受同source/operation/event/body的完整sent回执，不能用prepared/ambiguous冒充通知。日报原阶段可独立collect/reconcile/posting，不等通知或次日日报。posted拒绝新建“未完成”警告。

只读核验历史实现：在 ~/.flywheel/raya/code 对象库读取研究锁定41b26fa4e8baaddf076a33e7291772de979ffb8c 的 apps/brain/src/daily-report/{controller,delivery}.ts，旧nonce输入确为daily-report:date:(fileSha或40个0):notice:0。当前保留该业务tuple；旧REST wire nonce与新平台eventId跨transport去重并未因此证明，G迁移必须先处理原sent/unknown状态。未修改或运行旧部署代码；当前独立checkout及remote无该历史对象。

红灯：failure入口未支持2 failed。最终日报+business+CLI16文件105项通过，CoS build与修改TS Biome clean；未重复默认全包，前述SnapshotStore并行超时仍保留。没有真实通知外发或连续两天产品验收证据。

下一步F现有MeetingRecord/公共voice接线，随后G迁移打包，及A–G完整审计、双仓最终gates/review/PR。E的当前turn协议已有本地执行路径，仍需在最终审计证明完整collector provenance、persona触发和真实产品验收边界。

## F 标准MeetingRecord字段兼容

Raya `a41e211`、格式补正 `ca24333`：新增纯业务toMeetingRecord，保留现有meeting UUID/schedule/topic/requester，显式duration与continuation；rescheduled映射scheduled，cancelled要求endedAt。不将calendar/通知receipt或业务revision误作voice状态。只允许单目标internal Lead，目录中leadId全局唯一且project匹配，因为实际Bridge通过resolveLeadByAgentIdAcrossRegistry读取记录中的leadId。

现场源码确认公共入口为flywheel-comm voice-session（平台负责凭据/HTTP），Bridge只按受信meeting-notes配置读取meeting.json，start要求starting/live/interrupted，不能从scheduled直接启动。未调用任何真实voice命令。

红灯：缺适配模块导致suite加载失败；实现后adapter3+meeting-store/calendar/context各1共6项通过，CoS build通过。用当前Flywheel dist/meeting-notes-scheduler.js真实parseMeetingRecord对scheduled/rescheduled/cancelled三个适配结果做deepEqual，均原样接受。新增index导出排序首次Biome失败后shell仍提交了a41e211；随后补正导出顺序为ca24333并明确复核3文件Biome clean，没有将首次失败改称通过。

F仍需持久化会议current-turn操作、可信meeting.json写入/版本恢复、独立calendar与roundtable通知回执、starting-before-start和真实voice session绑定、改期/取消迟到事件守卫。G及A–G完整审计/双仓最终门禁/review/PR仍未完成；没有会议运行或生产验收证据。

## F 持久化会议版本与独立日历回执

Raya `4b4b054`：kind meeting冻结原平台source、UUID、单目标记录与必要目录身份字段。相同source/target不能换UUID重建；同一多目标邀请可拆为不同UUID的独立单目标会议。reschedule/cancel记录新实际source，仅应用一次，保留历史record/calendar/notification与原请求来源；改期和取消提升业务revision，未引入第二套voice session身份。

calendar回执需当前meetingRevision；成功与通知分离。unknown/失败仍保留已有calendar eventId，后续改期继续用同事件，避免重复日历。输入source与host founder一致性校验仍不是独立认证。当前source/history用于恢复，directory只冻结所需字段，不复制其他工具配置。

红灯：meeting入口缺失3 failed；追加多目标分场回归1 failed后将去重从整条source收窄为source/target，保持批准范围。meeting round/adapter/store/calendar/context/business/CLI初次19项通过，最终round4复核、build与修改TS Biome clean。尚未实际写入既有生产meetingStateDir（当前受信配置指向 ~/.flywheel/raya/data/state），未调用voice或日历。

下一步F可信meeting.json安全投影、roundtable通知关联、starting-before-start及session/revision回执；然后G迁移与A–G完整审计/双仓最终gates/review/PR。当前scheduled持久状态不代表真实会议可用。

## F 按会议版本绑定圆桌通知

Raya `5e7b18e`：prepare_notification要求当前meetingRevision与fresh标准directory，重新校验单目标internal/global leadId，再冻结bot mention、目标channel、UUID/revision和正文。缺bot/channel时明确unavailable；已有冻结通知在联系资料缺失时拒绝变化，不清空原input或改eventId。旧通知未知结果继续由原announcement操作对账，不创建新消息身份。

confirm_notification仅接受当前revision、source/operation/body/event匹配的完整roundtable announcement，必须真实sent且engagement ready、channel/message/thread一致。日历成功不参与通知确认；取消/改期后旧版本回执不能结算新通知。确认后保留原冻结input及真实messageId，未执行任何实际平台发送。

红灯：未支持通知动作2 failed。最终meeting-round7/adapter3/business6/question10/CLI4共30项通过，CoS build与修改TS Biome clean。覆盖准备未确认、真实ready回执、取消新版本、旧回执拒绝、unavailable恢复与冻结身份保留。

下一步F可信meeting.json投影、starting-before-start、公共voice-session状态/停止回执与迟到版本守卫。G及A–G审计/双仓最终门禁/review/PR仍未完成，当前通知fixture不构成双Lead实际往返或会议可用验收。

## F 启动前可信meeting.json投影

Raya `c00e10d`：due scheduled会议begin_start校验当前业务revision，先持久保存starting记录/旧文件hash/固定字节，再对workspace/state/meeting.json做exclusive owner lock、NOFOLLOW/nonblocking/regular-size读、CAS旧hash、fsync临时文件与原子替换。其他当前会议/已变化记录拒绝覆盖；遗留锁需显式确认owner退出后恢复，不按TTL偷锁。恢复沿同一projection与revision，不重新生成UUID或状态；已经投影的文件变化时停止并要求对账。

红灯：begin_start缺失3 failed；实现后Biome指出finally直接throw可能遮盖原错，改为保存写入及清理错误并聚合，未放宽检查。最终meeting-round10/adapter3/business6/CLI4共23项通过，CoS build与修改TS Biome clean。另在临时非生产工作区通过实际BusinessRound生成starting文件，由当前Flywheel dist/meeting-notes-config.js loadTrustedCurrentMeeting原样读出同UUID/status，验证真实加载器而非仅本地类型。

运行时配置必须使受信meetingStateDir对齐注册业务workspace/state，此代码不接受caller自由evidence路径、不修改host配置。当前生产目录未写入，未启动voice。这里尚不宣称对抗所有恶意并发父目录替换竞态。

下一步F标准voice-session start/status/stop真实回执、accepted不冒充live、session/revision关联和终态文件同步；随后G与A–G总审计/双仓最终门禁/review/PR。整体未完成。

## Public meeting voice lifecycle receipts — Raya 86d8036

- Added current-turn public voice-session start/status/stop intentions; Raya contains no invocation, transport or credential driver.
- Persist start intent before exposing the command. Resume queries status. Acceptance does not establish live; only status bound to meeting UUID, project, Lead and session updates the record.
- Founder-sourced stop waits for full terminal status. Reject old business revisions, older status timestamps, equal-time conflicting states and invalid terminal time order. Unknown command outcome remains reconciliation-required.
- Tests: initial two lifecycle cases failed as unsupported actions; added uncertainty guard failed on false reconciliation status. After minimal fixes, meeting-round 13 + meeting-record 3 + business-round 6 + CLI 4 = 26 passed. TypeScript build and Biome on all four changed files passed.
- Limits: fixture evidence only, no real voice invocation. Terminal slot archival/turnover, G migration and packaging, full A-G audit, aggregate gates, effective review and PRs remain pending. Earlier aggregate timeout receipt remains unresolved; this focused green does not replace it.

## Trusted terminal meeting archive — Raya 666c785

- Added explicit archive_terminal for ended/cancelled/missed records at the current business revision. Persist archive intent, publish fixed state/meetings/<UUID>/meeting.json under the meeting write lock, then remove only the exact matching current slot. Existing archive conflicts fail closed; resume retries the frozen artifact. Archived operations resume from their archive after the next meeting starts.
- Existing transcript files remain intact. Archived voice mutations reject. Pending cancellation notifications retain priority over archive guidance.
- TDD: initial archive action failed unsupported; archived voice mutation test then exposed a missing guard. A notification-priority regression was observed and corrected without relaxing the assertion.
- Final focused meeting-round13 + adapter3 + business6 + CLI4 =26 green; build and four-file Biome green. Temp-only end-to-end generation of a cancelled archive was accepted by the actual Flywheel loadTrustedMeetingArchive function.
- This proves source/fixture compatibility, not real voice or transcript availability. G migration/packaging, full A-G audit, aggregate checks, reviews and PRs remain.

## G legacy daily report migration inventory — Raya 51d9212

- Added read-only strict legacy state decoding and daily-report-migration-plan CLI. The existing mutating readDailyReportState quarantine reader is deliberately not used for dry-run.
- Inventory freezes state/body hashes and sizes; generated/file_written require repository reconciliation, ingesting/ingested require current context reconciliation, ambiguous posting states require delivery reconciliation, posted remains posted. Corrupt/unknown state or changed/missing body produces quarantine_required without moving or erasing original files.
- Tests reproduced missing module/unknown CLI before implementation. Final migration11 + CLI5 + historical recovery8 =24 passed; build and five-file Biome passed. The requested contracts/daily-report.test.ts filter matched no file; no separate contract suite is claimed.
- Scope remains incomplete: this is the read-only planning prerequisite, not an applied migration. Backup/apply and paired SHA receipts, operation conversion/recovery, other business state inventory, packaging/persona, full gates and review/PR remain.

## G backup and legacy report identity import — Raya 7d9306b

- Added daily-report-migration-apply with frozen inventory digest and paired SHA arguments. It rejects inventory changes, unresolved quarantine and foreign target ownership; saves exact original state/body in an atomic OperationStore backup before reserving each original daily-report:<date> operation. Original files remain unchanged.
- Backups bind plan digest and supplied Flywheel/Raya SHAs; these arguments are recorded provenance, not verification that a deployment runs those heads. Replays preserve existing migrated operations; partial batches resume per date without overwriting progress.
- Legacy posted stays posted with no next send. Other states retain original state, backup and recovery classification in legacy_reconciliation; status hides internal backup operations.
- TDD red: missing apply function and missing CLI command. Final migration14 + CLI6 + business6 + report-round7 =33 passed; build and six-file Biome clean.
- Remaining: evidence-driven reconciliation handlers must connect legacy_reconciliation to the complete report/reply flow. This import alone is not full migration acceptance. Other business state types, packaging/persona, A-G audit/full gates/reviews/PRs remain. Only temporary fixtures were applied; no production migration.

## G imported report repository reconciliation — Raya d01c5d4

- Added reconcile_legacy_repository: exact fixed repo/main/date path, valid complete report document and matching Git blob required. Previously delivered fileSha bindings cannot change. The report metadata supplies historical date/timezone; no synthetic platform wake receipt is asserted.
- Confirmed pre-send legacy generated/file_written/ingesting/ingested can materialize the new hashed context. Posting/unknown remains send_unknown; posted stays posted. Any unknown receipt, in-flight send or partial message IDs prevents promotion to ready even when the coarse status says ingested.
- TDD red: absent recovery action; added contradictory ingested+unknown fixture exposed unsafe ready promotion and was fixed. Final migration18 + report7 + artifacts3 + business6 + CLI6 =40 passed; build and three-file Biome clean.
- Remaining: actual delivery reconciliation and reply association for old receipts, missing repository file recovery, other business state migration and packaging. Source/temporary fixtures only, no production acceptance or complete A-G gate claim.

## G historical delivery evidence and reply association — Raya 67b51b6

- Added reconcile_legacy_delivery using original chunk plan/hash, stored message ID or historical SHA256(tuple).slice(0,25) nonce, and actual Discord message author/bot/channel/content. Historical nonce semantics verified from reference commit 41b26fa4e8baaddf076a33e7291772de979ffb8c delivery.ts.
- Every original chunk needs independent evidence before unknown becomes posted; partial observations stay unknown. Read evidence remains separately labeled legacyDelivery, never a fabricated new lead_actions send receipt. Confirmed old message IDs can bind subsequent founder replyTo messages.
- TDD reproduced unsupported recovery action; tests cover changed content, wrong author/nonce, partial chunk completeness and reply association. Focused35 passed, then TypeScript caught an observedAt reference/shadowing error. Corrected it; affected migration19+reply3=22 rerun green and final build/Biome passed.
- Remaining limits: historical replies predating observation are conservatively not auto-associated; missing chunk plans/messages remain unknown, never re-sent. Missing repository file/generation/failure recovery and remaining G types/packaging still pending. No actual Discord call or production acceptance performed.

## G missing-file draft recovery — Raya 146170d

- Legacy repository observations now retain absent/unknown without treating either as successful publication. For generated states with no delivery evidence, recover_legacy_draft verifies the bound backup body hash/size, preserved generation identity/main SHA/source manifest and historical timezone, then resumes the same date through repository probe and create-only publication.
- Historical controller reference confirms bodyFile stores body, with report metadata serialized on write. New recovery preserves body bytes; unsafe sanitization changes reject instead of silently rewriting the draft.
- Separate legacy delivery-reconciliation flag prevents a new send failure after draft/context recovery from being routed back to old-message lookup.
- TDD red: absent repository observation rejected. Final migration20 + report7 + send4 + reply3 =34 passed, build and three-file Biome clean. The fixture reaches context_ready only after a bound create receipt.
- Still pending: ungenerated/failure legacy states, other business data migration, packaging/persona and A-G audit/full gates/review/PR. No production writes or overall acceptance claimed.

## G generation resumption and terminal failure — Raya 5069abf

- Ungenerated legacy reports can resume the original date via normal validated daily_report prepare only after absence evidence, with no body/file/delivery evidence. The operation keeps its backup and migration binding, records the actual supplied wake/sourceRefs, and repeated prepare does not reset progress.
- Legacy failed imports as terminal failed with no next action. Existing repository evidence also permits an interrupted generating state to adopt its valid report without rerunning generation.
- TDD reproduced both missing generation resume and failed-state preservation. Final migration22 + report7 + failure2 + CLI6 =37 passed; build and four-file Biome clean.
- Pending: historical failure-notice reconciliation, other business state migration and packaging/persona; A-G audit/full gates/review/PR still required. No production mutation or full migration acceptance.

## Full Raya package verification — exact head 5069abf8e31f23786783253845ccc8ef3ee44ee9

- No Raya source or test changes during this verification.
- pnpm --filter @raya/cos lint:114 files clean.
- Default pnpm --filter @raya/cos test:52 files,51 passed/1 failed;283 tests,282 passed/1 failed. SnapshotStore newest50 retention case exceeded5000ms. This is not an onTaskUpdate RPC waiver. Full raw receipt: cos-5069abf-default-test.log.
- Isolated SnapshotStore4 tests passed; retention case1295ms. Source/test last changed in d53ed91, before recent migration work.
- Controlled pnpm --filter @raya/cos exec vitest run --maxWorkers=1:52 files/283 tests passed in39.19s. Full raw receipt: cos-5069abf-serial-test.log. No assertions, test timeouts or production semantics changed.
- Evidence supports parallel-load sensitivity; default aggregate failure remains unresolved, not relabeled green. No effective review, CI, PR, production or QA acceptance claimed.
- Next implementation remains historical failure-notice reconciliation and other G migrations/packaging. The pending default-test issue must be resolved or accurately carried into the final gate evidence.

## G historical failure notices — Raya cdc5fb5

- Reconcile attempted old notices using exact historical content, stored messageId or original notice nonce, actual bot/channel identity. Preserve read evidence separately and end the report as failed, never posted.
- A legacy notice with zero prior attempts may prepare one fixed announcement. Standard announcement sent receipt is required before confirmation ends failed. Unknown/attempted old notices cannot use this path; generic failure creation cannot bypass it.
- TDD reproduced absent notice handlers and an integration defect where pending announcement input was not exposed. Fixed both. Final migration25 + failure2 + report7 =34 green; build and four-file Biome clean.
- No real message sent; temp fixtures only. Default full-suite timeout from5069abf remains unresolved. Other G business migrations/packaging/persona and A-G audit/full gates/review/PR remain.

## G deployed package loading and persona — Raya 3007b4e

- Actual updater filter already copies only .lead/raya/identity.md plus packages/cos/package.json and dist. Added reproducible verify:business-package using precisely that filtered copy, all-export import, empty child environment and business/current symlink CLI calls; rejects nonfiles/symlinks/stale dist. No runtime dependencies required.
- First isolated artifact execution exited0 with empty stdout: CLI entrypoint compared an unresolved argv path to resolved import.meta.url. Realpath normalization fixed the actual deployment symlink case. This was executable red/green evidence, not only markup assertions.
- Final rebuilt artifact:128 files,sha256 bc482f4ba79123b6753e01f74443bff64a3802e51925dc0a8307feda7ef67dc6. Export loading, CLI date/status and migration-plan passed. CLI/business12 tests green; Raya whole-repo lint140files clean and build passed.
- Persona now covers daily-report generation/repository/delivery and meeting notification/voice/archive flows. README documents package proof and operator-only migration boundaries. No external seed file is referenced by current runtime sources; no historical goals were manufactured.
- This is package proof only: no registration/activation, live voice, natural-evening reports, QA, or same-activation v2 receipt. Other business-state migration audit, default full-test timeout and final A-G gates/review/PR remain.

## G standalone legacy question import — Raya cc3715d

- Added strict read-only question decoder, legacy-questions-plan and legacy-questions-apply. Original source bytes remain; digest/paired SHA-bound backup precedes each atomic imported operation. Duplicate askId, corrupt state, changed inventory and foreign target reject.
- Legacy question rows preserve askId, statuses and all original fields. Terminal statuses stay terminal unless the old record explicitly says transport unavailable, which remains reconciliation work. Missing revision/expiry is not manufactured. status/resume exposes a read-evidence intention, never a send.
- TDD reproduced missing module/CLI. Final legacy4 + old store2 + question10 + CLI6 =22 passed; build and full Raya lint142files clean. Filtered130file package verification passed with no runtime dependencies.
- Import is not full question recovery: original metadata/message evidence must still be connected to current question/reply state, including a guarded once-only retry of proven unavailable transport. Meeting migration and other compatibility fixtures, default timeout, final gates/review/PR remain.

## 2026-09-15 legacy unavailable question recovery — Raya fa9b014

- Added current-turn original metadata receipt, frozen recovery input and deterministic standard-question operation. Original askId/revision/body/target/expiry preserved; supplied metadata source reference and current directory required. The module validates receipt shape/bindings, not the external truth of caller-supplied observations.
- Only explicit unavailable `posting` with no sent/answer/finished evidence may recover. Terminal rows remain terminal even with an unavailable marker. Missing metadata, expired originals and any delivery uncertainty reject retry.
- Standard prepare checks imported identity and exact frozen input. Restart links the import to the same child; normal sent/engaged/reply receipts reach answered; replay does not send/create another request.
- Red: 2 new tests failed because legacy record was unsupported. Green: legacy/questions/CLI 22 tests; build; full Raya lint 142 files; package verifier 130 files, digest a653a5bda45cdc47cc38f14c98c1f01392471b687d13ff1834b343e30fa176aa, productionActivated:false.
- Default full Raya suite remains RED: 53 files, 52 passed/1 failed; 292 tests, 291 passed/1 failed. SnapshotStore newest-50 prune test exceeded default 5000ms. This is not an onTaskUpdate RPC waiver. Raw output: cos-fa9b014-default-test.log. No timeouts/assertions/production behavior relaxed.
- No product notifications, production activation, voice, QA dispatch or ship performed. Meeting import/compatibility and final gates/review/paired PRs remain.

## 2026-09-15 legacy meeting inventory/import — Raya dc26d1f

- Packaged CLI legacy-meetings-plan/apply reads only old state/meetings/current.json and archive/UUID.json. Strict bounded regular-file inventory; rejects unknown schema/status, malformed receipt IDs, archive identity mismatch, conflicting UUID copies, symlinks, changed digest and existing standard operation conflicts.
- Binds exact original bytes and paired source SHAs into a durable backup before imports. Original UUID, revision, calendar ID, old delivery fields and source paths survive. Cancelled archives stay terminal; other records require explicit reconciliation. Replay preserves existing imported state.
- Tests prove old source bytes, trusted state/meeting.json and existing transcript bytes remain unchanged. Missing requester/duration/source metadata is not invented; mailbox delivery does not prove a Discord notification or live voice. v2 adoption/reconciliation is still outstanding.
- Red: missing CLI commands, then unknown-schema acceptance. Green: legacy meetings + meeting round/store/record + CLI: 26 tests; build; full Raya lint 144 files; package verifier 132 files, digest 766816d6162e58d7d0487e438aabcad253890902918516226c8691af208eb1f3, productionActivated:false.
- Full default suite not rerun for this bounded import batch; previous SnapshotStore 5000ms failure remains unresolved. No production mutation, QA dispatch, merge or ship.

## 2026-09-15 legacy scheduled meeting adoption — Raya e627de4

- Current-turn adopt_legacy_meeting requires original invitation source, requester, duration, metadata source reference and directory; converts old minimal record through existing v2 mapper without changing UUID, revision or calendar ID.
- Standard operation binding includes original migration digest and exact adoption input. Import and adoption replay reuse that operation, including after restart. Calendar starts unknown with original eventId; no calendar success or notification/voice success is invented.
- Same-revision old delivery remains legacy_unknown and blocks notification preparation; explicit unavailable with no outbound/mailbox identity is eligible for normal preparation. New founder reschedule advances revision and retains calendar ID, allowing a fresh revision notification. Tests cover unknown delivery and revision advance; unavailable branch still needs an explicit fixture.
- Trusted current record must be absent or exactly the compatible scheduled v2 record; existing trusted archive blocks adoption. Occupied live record is preserved and requires public voice reconciliation, which remains to implement. No current/archive/transcript file is written by adoption.
- Red: legacy record unsupported. Green: migration/meeting round/record/CLI 27 tests; build; full lint 144 files; package verifier 132 files, digest c923ebc8581c7ebd669a0401eb4681290d567a58ef8f1201ef2cacaa76fa800a. Default full-suite SnapshotStore timeout remains open. No production actions.

## 2026-09-15 trusted legacy voice/archive reconciliation — Raya 8304103

- Adoption accepts an explicit SHA256 observation of the existing trusted current/archive record, validates its original UUID/target/topic/schedule/requester/duration, status and session identity, and binds the exact bytes as an already-projected artifact. No file replacement occurs during adoption.
- Existing live session is retained with unverified status and an unknown status-query call, so resume queries the public voice session rather than starting another one. Different session receipts reject; a matching public status receipt can continue the existing projection flow. Local live state is historical state, not new production health evidence.
- Terminal trusted archives retain the existing document and completed archive marker. Resume reads that archive while preserving a newer current meeting and original transcript bytes. Missing/changed digest and incompatible identity/status reject adoption.
- Added explicit unavailable-notification fixture: original meeting revision produces one frozen notification intent and replay preserves it. No old mailbox receipt is promoted to Discord success.
- Red: trustedRecordSha256 input unsupported. Green: legacy meeting/round/store/record/CLI 31 tests; build; full lint 144 files; package verifier 132 files, digest 40fd8581c827ab1c09e5f87c758a8238c671c6890a91bde442e8d230a97131e6. No production activation.
- Next: bounded unchanged-state compatibility/rollback fixtures and full mandatory gates, including unresolved default SnapshotStore timeout; effective code review, paired PRs/exact-head CI remain pending.

## 2026-09-15 compatibility and full-gate progress — Raya 7dade99 / Flywheel 95a4eeefe

- SnapshotStore retention test now seeds the first 50 persisted snapshots as fixture files, then exercises both pruning writes (51 and 52) through the real durable store. All five retention/count/callback assertions remain unchanged, as do the default timeout and production source. Prior default-red receipts remain in this folder; no skip, timeout increase or assertion waiver.
- Focused SnapshotStore4 green (335ms total). Default full Raya suite GREEN:54 files/300 tests,28.81s. This run includes the snapshot fixture fix, before the separately verified new compatibility test.
- Added compatibility fixture: real migration/import/replay plus normal status/snapshot/goals reads preserve original goal/operation IDs, snapshot ID/seq, summary ledger and historical patrol bytes, old expired question identity, and temporary memory Git HEAD/clean worktree. Compatibility1 green. This proves retained v1 read compatibility, not a production rollback or permission to restart a legacy driver.
- Raya build and whole-repo lint145 green. Runtime business package unchanged from 8304103 (test-only changes).
- Flywheel full pnpm lint initially failed one organizeImports error in this branch's discord-chat-ingest test; sorted imports only in95a4eeefe. Re-run exit0 (18 displayed warnings,135 additional diagnostics). Full pnpm -r build exit0.
- Flywheel pnpm test:packages:run still RUNNING, exec session29872, log /tmp/FLY-2447-final-packages.log; do not restart while handle exists. No new scripts/__tests__/*.test.sh in origin/main...HEAD inventory. Full review/paired PRs/exact-head CI remain pending.

## 2026-09-15 final Raya suite and paired review binding

- Exact Raya source head7dade993648173edda85869cb68f8327f719f6f5 default suite passed55files/301tests in18.08s, including the new compatibility test. Raw log cos-7dade99-final-test.log. No assertion/timeout changes beyond previously documented fixture setup.
- Flywheel package aggregate session29872 remains live and uncompleted; no aggregate verdict yet. The same process is being polled, not restarted.
- Server resolveReviewTarget requires target strictly contained in the execution worktree and a nested Git root. The authorized Raya checkout is external. Asked Lead for the supported paired review/completion binding under question7ceb407f-2249-45e9-ac25-82f553ab994c; pending. No validation bypass/symlink workaround attempted.
- Prepared qa-handoff.md retaining all plan9.1 N1-N13 and9.2 real product gates. Preparation is not QA dispatch. Two repository PRs remain unopened.

## 2026-09-15 resumed execution c7df5069 — abort correctness repair

- TURN epoch11 held. Both Flywheel #1206 and Raya #139 marked ready. Flywheel remote5afe4d2d800e468df57796483fc59ea739e7309e has all15 CI checks green (run34941243956).
- Raya remote84d63fd6de38608b493da1f9442b10e7cccd65fb CI34941566567 failed: repo-writer buffered HTTP output after abort returned null instead of aborted (300 pass/1 fail). This is a production correctness gap: runChecked only classified cancellation on rejected host calls; resolved buffered output bypassed the check.
- Added deterministic host fixture that aborts before resolving HTTP404. RED reproduced null; minimal post-await throwIfAborted preserves existing aborted classification. Original subprocess regression retained. GREEN13; full55files302tests,19.59s; build and lint145 exit0. Filtered package132files/zero runtime dependencies verified, digest f149be88f472f1df347fd8ee96a98c99b1713c76bc68c28a5c14501fb3f7cb7b. Raw logs beside this document.
- Local Raya commit4454602 is retained on implement-c7df5069-FLY-2447 in paired/raya (initial paired checkout was detached; original branch remains checked out externally). No force push or symlink. Eventual push must explicitly target origin/flywheel-FLY-2447.
- Old aggregate handle29872 is missing; old log ends without verdict. New required package run has live handle3514 and /private/tmp/FLY-2447-resume-packages.log; no aggregate pass claimed.
- Scoped read-only live review query: primary request0d0e1ab0-7ef7-4474-af6f-f2ec1458b849 running; pairedc60f3d3a-6db7-46e0-b550-7da0c93cbbe7 pending; both bind previous execution13366ff6. Both question checks remain not yet. No pushes while those reviews run. Lead question77bf7ca7-b7e9-4a4d-b218-2984db7b71c4 asks status/binding route.
- Final docs/milestone and new exact-head reviews/CI under executionc7df5069 remain necessary. No QA dispatch, deployment, production verification or completion receipt. All plan9.1/9.2 requirements retained.

## 2026-09-15 primary review correction — source304e4e4ee

- Raya reviewada867b3/gate118e00f5 effectively APPROVED at44546026c1a9fecfd10ae3b01fe6ef92f49f9be5; five non-blocking advisories reported to Lead. Source/head unchanged.
- Primary reviewf9cf0f26/gate0058cdb5 atb9ce5c570 effectively CHANGES_REQUESTED: HIGH replyto-strict-reingest-conflict-stalls-founder-ingress. Full structured reviews retained beside this document. Other MEDIUM/LOW findings forwarded, not absorbed into this correction.
- Removed ingest's strict optional-reference comparison before existing-lane return. The atomic first claimant remains canonical: no body/reference replacement, no enrichment/backfill, no second delivery. Missing references across producers/upgrades, missing authors across REST rereads, and changed reference proposals all return the existing lane without cursor-poisoning exceptions. New deliveries still normalize and validate reference fields. This implements the plan's refusal to rewrite, without claiming later metadata can replace stored provenance.
- RED:5 ingress tests failed with replyTo conflict. Actual temporary CommDB founder ingress with plugin-style first delivery followed by Bridge quote-reply and another message failed process_failed. GREEN:29 ingress tests;47 founder-deliverer tests. Canonical body/rendered content remains unchanged while both founder messages are handed off and the cursor advances. The integration fixture uses the existing complete review-card store stub after diagnosis of a missing method in the initial minimal stub.
- Added /paired/ to .gitignore because Biome does not honor the local Git info/exclude for nested root config discovery; pnpm lint otherwise rejected paired/raya/biome.json. Whole-root lint then passed3741files (existing18warnings); pnpm -r build passed. No changes inside the paired approved repo.
- Original aggregate3514 remains active, receipt directory flywheel-package-gate-udJ4Qe. Its initial build/head predates this correction; retain that limitation. Updated full comm run53014 is active at /private/tmp/FLY-2447-reingest-comm-full.log. Current focused changes passed as above; final full package evidence and new exact-head CI/review still required.
- Review gates must be serialized within this execution: a later review_code gate supersedes the earlier gate even after registration. Paired effective verdict was obtained before reopening the primary gate. No QA dispatch, completion or production claim.

## 2026-09-15 cross-package expectation correction

- Review5c3eda71/gate6d4a7ad1 at e1f164110 confirms the ingress HIGH is fixed, but effectively CHANGES_REQUESTED for stale-mailbox-strategy-replyto-test-red. CodexDiscordMailboxStrategy.test.ts still expected retry when the same message's reply reference differed.
- Reproduced7tests/1failure, then updated only the test: expect handled and compare the entire canonical mailbox row before/after. GREEN7 and file Biome check. Production source remains304e4e4ee; no assertion of immutable content removed. Consumer sweep found no other same-family changed-reference/replyTo retry assertions.
- Full updated comm run53014 completed190files/2576passed/3existing skips, exit0,423.78s; raw log /private/tmp/FLY-2447-reingest-comm-full.log. Full lead-backends run31649 started with no exclusions, currently pending. Original aggregate3514 remains active; preserve any stale-test red and distinguish it from later corrected runs.
- Other primary review advisories remain non-blocking and reported. Raya4454602 approved/CIgreen unchanged. New primary exact-head CI and effective review required after this test correction.

## Engine conflict rework — 2026-09-15

Request: rework:f22aac3fd1a1637a281243d65b2a38174e06af86d2553e0ca1d95d8463976c24; implement attempt 2, execution cec3f253-ec78-4f11-8391-690669b76ab5, TURN epoch 13.
Base head 2c75a370204f335741df16ab74da2cb0f1cc65ca merged with origin/main 156601a2e98985faa8b0d1bf1a9a093b7eb1845d in 4baf05da8.
Only manual conflict: founder-reply-deliverer.ts. Retained main's scoped withCommDb ownership and this branch's optional replyTo reference/author metadata. No product redesign.

Fresh local verification: frozen install, pnpm lint (warnings remain), pnpm -r build all exit 0. Founder-reply-deliverer 50 tests plus CodexDiscordMailboxStrategy 7 tests pass, covering canonical replay and scoped database ownership.
Logs: /private/tmp/FLY-2447-rework-{install,lint,build,focused}.log.
Required package aggregate running under session 77095 at /private/tmp/FLY-2447-rework-packages.log; no aggregate success claimed.
No new shell tests in the feature diff against refreshed main. Inherited main documentation whitespace warnings were not changed.
Raya paired worktree remains clean at 44546026c1a9fecfd10ae3b01fe6ef92f49f9be5.
New effective review and exact-head CI remain required; prior approvals/QA do not prove this merged head. No QA dispatch, ship approval request, merge into main, deployment or production action.
