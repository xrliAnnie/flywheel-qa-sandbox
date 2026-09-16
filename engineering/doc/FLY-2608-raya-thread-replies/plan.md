# FLY-2608 Raya 线程双向对话 — 实施计划
Issue: FLY-2608 (https://linear.app/geoforge3d/issue/FLY-2608/raya工程修复-discord-thread-中的-founder-提问必须送达-raya并在原线程回复)
日期: 2026-09-15
基于: research.md

状态: R2 CHANGES_REQUESTED 已修订，待 R3。设计节点不实现、不部署、不恢复线上消息。

## 给 founder 的说明
让已登记的 Raya 讨论线程进入现有 Bridge 收件扫描，并把回答的目的地固定为问题所在的线程。无需 @，也不用重述问题。修复复用标准收件队列；完成与否以真实提问、收件凭证和同线程回答三段证据判断。

目前已确认代码覆盖缺口与缺少回帖字段；两条旧提问的原始 message id 已由 Lead 定位（见证据补记）；精确归档收件仍待核对，因此不声称已恢复。完成设计不等于完成生产修复。

```mermaid
flowchart LR
  A[Annie 在线程提问] --> B[Bridge 扫描已登记线程]
  R[线程登记与 Lead 配置] --> B
  B --> C[标准 mailbox 持久化收件]
  C --> D[Raya 读取并回答]
  D --> E[原线程收到回答]
  C --> F[按源消息编号去重]
```

## 1. 范围及固定决策
- 复用 `GatePoller.founderReplyDeliverPass`、`emitFounderReplyDeliveryForThread`、现有 cursorStore 和 mailbox；不新加收件服务/数据库/依赖/feature flag。
- 本单新增覆盖的生产owner集合固定为 `{projectName:raya, leadId:raya}`，父频道必须匹配当前Raya配置（本事故为1542079099928059987）。同一标准组件按冻结迁移数据的owner集合筛选，不在共享源码中硬编码Raya收件实现。其他Lead的新增覆盖不在本单，留待独立验收；不添加全舰放量开关。补该owner在 `chat_threads` 与 `phase_chat_threads` 中活跃、可解析唯一 owner 的普通 issue thread。现有 session/审批历史/pending-question 路径保留，先形成完整 byThread，再按 threadId 合并一次扫描。
- Owner 用注册行的 `lead_id` 与父频道 `channel_id` 对应的当前项目 Lead 配置确定。issue 的项目、标题、显示名称均不能改变收件人。Raya 例子为 `raya / raya / 1542079099928059987`。
- 仅新增覆盖使用 `ingestOnly`（只收原文）路径，成功入队后跳过全部 `processFounderMessage`。空 questions 不是隔离措施。旧有已授权 gate 路径按原规则执行。
- 仅已冻结owner集合内的 Bridge issue-thread ingest（含该owner既有扫描路径）明确写 `replyChannelId=ctx.threadId`；沿既有 v2 mailbox 路由回原线程。保留 `replyTo` 引用，但不以它替代目的地。不伪装成 roundtable。
- 本单不改 issue parent、不承担 summary 业务、不过问 roundtable 主动参与预算；不因注册表项目展示不一致重命名或迁移收件身份。

## 2. 数据与不变量
| 数据 | 真值来源 | 用途 |
|---|---|---|
| thread_id / channel_id / lead_id | StateStore 两张现有线程表 | 线程和所有者候选 |
| projectName / leadId / botToken | 当前唯一匹配的 ProjectEntry.leads | 凭据和标准 comm.db 选择；不得 fallback 到全局 bot |
| issue_id / session.project_name | 原有 issue/session | 上下文与显示，不用于覆盖通信 owner |
| cursor(threadId) | 现有 cursorStore | 最后可安全跨过的消息 |
| messageId / authorId / channel_id | Discord 原消息 | 真正输入身份、founder身份和源线程 |
| deliveryId | `chat:<leadId>:<messageId>` | 已有全程去重键，不造新 id 绕过去重 |
| replyChannelId | 经验证的 source threadId | mailbox 分批、journal、sender 目的地 |

入站验证：雪花 id 格式、对象/数组形状、响应消息 channel_id（若提供必须匹配）、authorId 为配置 founder 且非 bot；正文/附件延续现有 envelope 验证，外部输入绝不参与动态 SQL。保留参数化查询。HTML/报告中的外部文本使用转义，运行时只写 textContent/value。

Owner 决议：在所有 project.leads 中先找 `chatChannel===row.channel_id`，有 lead_id 时还要求 agentId 相等；恰好一个才纳入。lead_id 缺失可接受唯一父频道配置；零个或多个均跳过并记录 threadId+原因，禁止按 issue project 猜。重复 threadId 若 owner 冲突整条暂停，不能 first-wins。session/历史路径若同 id 的 owner 与注册行不一致也暂停并报告，禁止双 Lead 入队。每轮读取当前配置/注册表；入队前确认此轮绑定仍是当前绑定，配置变化不能让旧任务继续投递。

## 3. 实施任务（TDD：先失败用例，再最小实现）

### T1 注册表补覆盖
修改 `packages/teamlead/src/bridge/gate-poller.ts`，直接组合 StateStore 已有 `getUnarchivedIssueChatThreads()` 与 `getUnarchivedPhaseChatThreads()`，先按本单冻结owner集合过滤，再纳入扫描。不修改现有其他消费者的查询语义。

建立去重/owner 校验后，先完成session、historical、pending-question三源byThread，再把原来不在这个完整byThread中的登记线程加到同一 tasks，`questions=[]`、`ingestOnly=true`。使用 owner 项目的标准 comm 路径及 owner 自身 token，不借用另一个 Lead 或全局凭据。缺 owner token 时跳过且记录 owner_token_missing + project/lead/threadId，不得静默跳过。保留 questioned 优先与现有 scanBudget、轮转游标；不能为每个线程新开 timer。`founderReplyScanCursor`还被`listShipJudgmentReplyThreads(after)`用作分页起点，测试必须覆盖新增Raya线程进入后、有限轮数内历史集合仍完整扫描，不能把它改成只属于新集合的游标。

测试：`bridge/__tests__/gate-poller-founder-reply.test.ts` 增加 raya thread + flywheel session 的反例，以及无 session、phase 表、空 lead_id 唯一父频道、冲突 owner、archived/missing、相同 thread 重复出现，特别是仅pending-question分支引入的线程+同id登记行：只产生一个非ingestOnly task，其pin/waterline不被覆盖。断言只调用一次 scanner 且目标 raya/raya。主频道 Codex polling 不改。

### T1b 已归档线程重新提问
复用现有 `bridge/discord-guild-active-threads.ts:listGuildActiveThreads`，在同一已有扫描周期内按冻结owner读取活动线程：`botToken=lead.botToken`，`guildId=config.discordGuildId`（Bridge已有DISCORD_GUILD_ID解析，不读owner.guild或语音huddle配置）（不另起timer，不使用resolveInfraDiscordIdentity借infra凭据）。本单只对Raya去重后每轮一次guild请求；其他owner不调用。过滤真实parent_id等于该owner.chatChannel；对每个id调用`StateStore.getChatThreadByThreadId`，该既有参数化查询刻意不滤archived_at，且同时覆盖main/phase表。与登记owner交叉校验后并入上述byThread补覆盖集合。这样Discord因founder发言自动解档、而本地仍archived时也会收件。

不清空本地archived_at、不发unarchive PATCH、不修改done-thread-reconcile或bot-send-rearchive；纯发现即可恢复通信，归档治理仍由原owner负责。活动线程响应失败/缺guild/token按类型留诊断并重试；guild解析缺失时关闭T1b子能力，记录guild_unavailable，QA不得以普通新线程通过代替归档恢复验收；不得将失败当空集合或删除既有候选。新增发现线程与普通注册线程用同一固定rolloutAfter和cursor规则。测试包含本地archived+Discord active+新founder提问，无登记/错parent/missing线程均不纳入；生产受控验收必须先归档，再由founder发言自动解档，再证明同线程闭环。

### T2 首次扫描与失败行为
修改 `bridge/founder-reply-deliverer.ts` 的上下文增加可选 `ingestOnly`。只对此模式，使用固定上线边界，禁止从创建时刻全量回放旧线程：`after=max(threadId, rolloutAfter, savedCursor if any)`（按BigInt比较），直接读取第一页面，不取 HEAD 后返回。rolloutAfter 是本修复在该Bridge首次启用前一次性冻结的雪花下界，不是每次发现/每次启动的now。新线程创建于上线之后，因此首次发现前的提问仍全部位于下界之后；存量线程仅处理上线之后输入。两条已报告的旧问题仅走T4定点恢复。

上线边界路径必须由`plugin.ts`在当前Bridge环境中解析为`join(getStateDir(), "founder-thread-ingress-rollout.json")`，与founder-reply-cursor.json共用同一`FLYWHEEL_STATE_DIR`解析，禁止硬编码homedir或默认生产目录。slot QA与生产分别在各自state dir独立初始化，不复制marker/receipt。

部署授权窗口内，用Node标准库O_EXCL、0600冻结marker：`{v:1, environment:{stateDir, teamleadDbPath, commRoot}, owners:[{projectName,leadId,chatChannelId}], rolloutAfter, createdAt}`。三个environment路径取该Bridge实际已解析绝对路径的realpath；QA解析缺失不得回退生产默认。生产owners仅raya/raya，QA使用其隔离配置的对应测试owner并逐一记录映射，不加入真实生产owner。本文任何「固定上线边界」都指此环境绑定后的值。

marker只读且不可自动覆盖；启动逐项校验schema、雪花/时间一致性、当前真实environment及owner配置。初次启用必须距createdAt不超过15分钟且不在未来（允许30秒时钟误差），否则rollout_boundary_unavailable，保留文件并要求重新走部署决策与dry-run，绝不把旧值或now静默沿用。

为区分「初次启用」和「正常重启」，在同一getStateDir下使用最小采纳回执`founder-thread-ingress-activation.json`，内容为`{v:1, markerSha256, environment, activatedAt}`。回执不存在时，校验新鲜度并完成固定边界dry-run后，以O_EXCL、0600创建；只有回执完整落盘且重读校验成功才启用新增扫描。回执已存在时必须匹配marker字节SHA256与当前environment，正常重启不再次套15分钟门槛、不改原rolloutAfter。marker/回执损坏、错环境、hash不匹配，或并发O_EXCL失败且重读不匹配，均关闭新增覆盖并诊断，不覆盖、不重新生成。两文件使用标准库写入/fsync/关闭；不引入新数据库或业务写API。它们是迁移数据与一次采纳凭证，不是消息队列或feature flag。

T5部署顺序为只读盘点→本环境冻结marker→对固定边界最终dry-run→15分钟内创建采纳回执→启用；任一步失败不启动新增覆盖。现有GatePoller配置注入该值，测试传固定值。既有非ingestOnly路径和已有审批游标不改。

复用该marker的部署配置/读取接线落在`bridge/plugin.ts`及`gate-poller.ts`，不修改全局InboundCursorStore语义。每个新增线程实际保存的游标从不低于此固定下界；旧marker/现有cursor均不得删除来触发重放。

每轮最多现有 GET_LIMIT 一页，消息按数值 id 升序处理；每条成功持久化或已有同 id 收件后才能跨过。写入失败停在前一条；cursor 写失败下轮重读，由 deliveryId 去重。全页则后续 tick 继续；启动追赶与实时扫描使用同一游标。超时/429/5xx不推进，401/403/404记录明确 read_failed，不自动换token或将输入当作已处置。读取异常不影响其他线程轮转。

`ingestOnly` 在入队成功后直接进入安全游标推进，不访问 pending gate/旧卡/审批/决策/自动回复处理；测试用 spies 断言所有这些回调零次，即使内容为“通过”且携带真实形状 reply reference。

测试：`bridge/__tests__/founder-reply-deliverer.test.ts` 覆盖首次发现前已有消息、空线程后提问、>2×GET_LIMIT 条多页（当前GET_LIMIT=50）、重启、429、enqueue失败、cursor保存失败、重复投递、附件-only、非founder、自己bot、错channel响应、无效id。不得凭 mock 自造分页语义通过；用受控 Discord API 只读分页证据核对。

### T2b 收件返回值与游标处置
必须读取 `DiscordLaneVerdict`，禁止以“不抛异常”作为入队成功：
- inserted_inbox且无deadLettered：标准新收件，保存deliveryId/seq后可推进；通过可选`FounderReplyDeliverDeps.nudgeLeadInbox?: () => void`唤醒；GatePoller以闭包注入`runtimeRegistry.nudgeLeadInbox(leadId, projectName)`，测试spy断言真实agentId在前、projectName在后，失败不撤销持久化收件，正常loop仍可补拉。
- active_inbox：已有同id标准收件，可推进但记deduplicated，不宣称本次新恢复；另查其批次/消费/回帖。
- inserted_external / legacy_external：属于既有外部carrier，记其真实lane并交现有carrier证据核查；未确认可消费状态则pin并报告，绝不改键强制转inbox。
- archived：记录already_archived，可按去重终态推进扫描，但绝不记本次恢复成功；T4进入归档处置分支。
- deadLettered=true：持久化失败处置，不记已送达，pin并使用现有诊断/升级路径，不无限创建新id。
- 无法验证的返回/抛错：保持前一游标并重试。

T4定点恢复只有新增非deadletter标准carrier、实际batch_id/送达凭证、模型消费与真实回帖齐全后才标成功；active/archived等返回先查最终状态，不能误报成功。为每一lane和重复恢复增加测试。

### T3 保留返回地址
同一 `founder-reply-deliverer.ts` 仅对本单冻结owner集合内的 thread ingress 设置 `replyChannelId: ctx.threadId`，包括Raya既有路径，避免该 producer 先写入无目的地载荷。其他owner的既有入站/回帖目的地不改。保持 msgKind=guild。

验证既有 `packages/flywheel-comm/src/discord-chat-ingest.ts` 的 immutable first writer、route partition 和 `parseDiscordChatRoute`；`bridge/lead-inbox-loop.ts`、`bridge/lead-delivery-adapter.ts`、`lead-backends/codex/CodexLeadInboxSocket.ts`、`LeadInputRouter.ts` 的 v2 batch/journal/sender 全链。通常只需新增跨模块测试，无需重写这些消费者。不同线程不能合批，重投不会二次唤醒/回答，发送失败按现有 journal/outbox retry 原目的地，不能 fallback 主频道。

生产者重叠防护：Raya现有主频道及roundtable轮询保持原样。新增Bridge候选必须来自owner.chatChannel；配置中若该频道也等于owner.roundtableChannel或同一thread进入Codex listSubscriptions，则跳过新增覆盖并报告producer_overlap，交Lead确认既有主路，不竞写。复用CodexLeadInboxSocket.listCodexLeadSubscriptions在每轮快照与实际读取前检查（认证继续使用owner现有socket凭据）；能力明确未启用等同无roundtable订阅，传输失败不等同空集。配置父频道互斥与订阅检查双重约束；若接收期间订阅可越过不同parent加入，则实施须补父频道绑定校验，不能靠一次检查声称消除竞态。测试两路径不能同时为同一own-issue-thread写入不同路由。此为新增覆盖的准入约束，不更改既有questioned审批路径。

同一 message 若已被其他 producer 写入缺路由载荷，补投不能修正 immutable envelope，必须单独处置。禁止改 deliveryId、删 dedup 或原地改 ACK 历史。

### T4 两条旧线程取证与按需恢复
在具备标准读取权限的 Lead/QA 身份下读 Discord 历史，分页覆盖线程创建至本次报告时间；找到每条 founder 提问的真实 id、时间、source thread、引用/附件及必要正文摘要。同时读取 by-thread 与当前注册 owner，分别查 owner 项目和可疑误路由项目的 live/archive mailbox，`message-status`、batch、journal、outbox、Discord 实际回帖。

每条分类必须为：尚未入队／已入队待消费／已消费未回复／已回复但错位／同线程已回复／原消息不可读（明确权限或删除证据）。缺失证据不得写“丢失已确认”。两条线程各建 evidence 表，不用用户主频道追问 id 代替。

恢复操作按真实状态：
- 确认从未入队：通过现有标准 `chat-ingest`/Bridge scanner，使用原始 id、owner、原始正文与 replyChannelId，同一去重键；非设计节点执行。
- 已入队待消费：让标准队列恢复，保留原 id，不重复创建新输入。
- 已消费缺回复、目的地错误或旧载荷缺路由：由 Lead 经标准通信交给 Raya 核对消费/回帖状态并补原线程回答，记录原 deliveryId 与补答 messageId；不可伪造重入队成功。若无受支持恢复动作，升级 Lead 明确处置，QA不得通过。
- 已同线程正确回复：标已处理，禁止补答。

不回退全局 cursor，不扫全部历史后自动重放，不要求 Annie 复制问题。新覆盖自动扫描不读rolloutAfter之前的历史；T4定点恢复前，先完成这两条审计，确认它们仍未被处理；若历史由旧系统处理而无标准记录，须先由 Lead 对这两条源消息做处置，不可盲目制造重复回答。恢复窗口与逐条状态留在 evidence。

### T5 验证和交接
上线前dry-run硬前置：逐线程输出owner、创建时刻、已有cursor、固定rolloutAfter、effective after、将纳入的founder消息数及排除原因；汇总每Lead/全局数量。rolloutAfter之前自动回放数必须=0（两条旧事故单列T4，不混入自动回放）。R1全舰盘点72活跃候选证明扩面风险；R3已限定Raya，部署dry-run必须同时列出其他owner被排除数及各owner实际扫描/入队增量=0（Raya之外），不采用旧全舰数量作为本单候选数；dry-run异常或边界文件未冻结即禁止新增扫描。先冻结边界，再对固定同一边界做最终dry-run与启动，禁止检查后换成新的now；硬断言marker/activation的environment与当前stateDir/DB/commRoot一致，QA产物不能被生产采用。测试：QA先创建marker→生产独立冻结仍成功；互拷marker/receipt均拒绝；初次采纳过期拒绝；同环境正常重启保留原值；损坏/缺失/哈希不匹配拒绝。

相关命令（在安装好锁文件依赖的 checkout 中）：
```
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/gate-poller-founder-reply.test.ts src/bridge/__tests__/founder-reply-deliverer.test.ts src/lead-backends/codex/__tests__/CodexDiscordMailboxStrategy.test.ts
pnpm --filter flywheel-comm exec vitest run src/__tests__/discord-chat-ingest.test.ts
pnpm --filter flywheel-teamlead typecheck
```
按实际测试位置增加 mailbox→sender 集成用例，并运行既有相关 v2 socket/delivery/router 套件。设计阶段不以这些未来命令冒充已测试。

## 4. QA 硬验收矩阵
| 验收 | 所需证据 |
|---|---|
| 新线程首问无需@ | 新 Raya issue thread；founder 立即提问；source messageId、threadId、owner绑定；从首次发现前输入也成功 |
| 标准收件与模型实际消费 | `chat:raya:<sourceId>` live/archive、batch id、接收/消费记录；transport ACK与模型消费分开写 |
| 原线程真实回答 | Raya botId、Discord reply messageId/URL、channel_id 与源thread相等，内容实际回应问题；不以发送API调用或typing代替 |
| 无串线无重复 | 第二线程并行提问；其他Lead无对应收件；重扫/重启后无第二次答复；按sourceId统计并观察至少两轮扫描/重试 |
| 归档后再问 | 本地archived但Discord因founder发言解档，实际收件与同线程回答；无注册线程不进入 |
| 主频道回归 | 1542079099928059987 新提问同样闭环，原主频道poll不受影响 |
| 历史两线程 | 两张逐条源消息与最终处置表；所有待恢复输入有标准恢复及实际答复，或有明确不可恢复证据与Lead处置 |
| 错误与隔离 | 429/权限故障不跨过输入；新增 ingestOnly 内容不触发任何批准/旧卡指导/门状态变化 |

记录扫描周期、当前候选数/预算和实测端到端延迟；分组记录(a)新增Raya线程、(b)一条既有活跃session线程上线前后的延迟；旧线程transport延迟不得比同负载基线增加超过一个实际扫描周期（约60秒），超出不报通过并交Lead处置。生产扩面限定Raya，仍要测试75个总候选的边界与既有历史游标公平性。采用既有25线程/轮、约60秒周期，明确接受有限延迟：本次验收负载至多75条无question候选，source→mailbox≤240秒、source→同线程回答≤360秒；同时记录模型执行耗时。超过此负载或故障导致越界时不能报告验收通过，保留队列并向Lead报告容量问题；不承诺即时响应，也不在本单扩充调度机制。受控测试需真实 founder 输入或明确授权验证身份，bot合成输入只作集成证据。设计/实现无预授权生产重启、终止、merge，独立 updater 部署窗口与 ship 权限另行办理。

## 5. 迁移、回滚与风险
零 schema migration；无需改身份/credential/注册项目。新增环境绑定的固定上线边界元数据与采纳回执；存量 cursor 不重置，新覆盖仅处理固定上线边界之后输入，旧事故输入按T4逐条恢复。正常追加轮询持续拾取新注册线程，无需为每个线程重启 Raya。

回滚代码停止新增覆盖；保留本环境marker/采纳回执、已入队载荷、游标、去重身份及回帖记录，不删除证据。继续处理已入队数据，不能假称撤回已发消息。owner变更时暂停并由Lead检查旧队列（deliveryId含leadId，换owner会改变去重空间），不自动迁移/重放。

限制：本修复覆盖已登记活跃 issue thread及Discord已经自动解档的已登记线程，不扩到DM/任意未登记频道。归档恢复依赖本环境配置有效guildId；缺失时不能声称完整修复。T1b显式验收本地archived标记落后，不以它排除founder重新发言的线程。本阶段已依据Lead提供的精确证据定位两条未入队输入；后续恢复前仍必须执行T4最新状态复查。

## 6. 设计交付
探索/调研/计划、review有效APPROVED、diagram-first HTML、每节自动保存评论与汇总复制、提交并推送、静默发布和托管CSP验证、向工程Lead报告、exact `complete --route phase_design_complete`，随后 park。不创建实现或QA successor。


## 2026-09-15 20:22 PDT 证据补记（Lead 提供）
问题 f65445d7-a479-4cd5-8a6c-5ae6c79a54ad 已回答。Lead 在约03:2xZ读取的证据如下；Runner无直接Lead读取权限，没有借用token。

| 线程 | founder 原消息 | 时间（UTC 2026-09-16） | 正文 | Lead 查询结论 |
|---|---|---|---|---|
| 1549573426547658793 / FLY-2131 | 1549573491060244602 | 00:11:49 | 这是什么东西呀？ | Raya mailbox未见；后续机器人帖无对应回答 |
| 1549573438937767977 / FLY-2382 | 1549573499914297409 | 00:11:52 | 这是什么东西呀？ | Raya mailbox未见；后续机器人帖无对应回答 |

Lead 的 by-thread 读取确认 issue session 项目为 flywheel；lead_events 没有引用这两个id的任一Lead记录。Raya mailbox该分钟只有主频道投递，正文检索也未命中。Lead将此判为入站未送达；本设计把它作为Lead提供的事故证据，精确live/archive计数与登记owner仍请求补充。原先“原消息id未知”仅是早期取证状态，现在已定位；实施必须用上述真实id核对、恢复并补实际同线程回答。不可把后续机器人普通消息当作回答。


### 登记行补证与查询边界（Lead，约03:3xZ）
问题 ee3d76ac-8f88-40d9-aaf7-858808009f2c 返回：两条 chat_threads 的 channel_id 都为1542079099928059987、lead_id=raya、archived_at=NULL、discord_missing_at=NULL；created_at 分别为2026-09-16 00:11:34/00:11:37。满足本方案按父频道与lead确定通信owner的前提。

Lead 的 content LIKE 源id计数：raya.mailbox各0，flywheel.mailbox各2；但调查ask/report本身含源id，不能把substring命中当实际discord_chat投递。mailbox_log.content查询失败（no such column），不能判archive为空；实际表列表还含mailbox_terminal_archive、mailbox_identity，flywheel另有mailbox_archive。已请求问题22c03203-c166-475d-9f94-ccf720a63c36按精确deliveryId/source kind查询。上述失败与不确定性保留，不声称误送另一个Lead。


### 最终精确收件核对（Lead提供，问题22c03203-c166-475d-9f94-ccf720a63c36已答）
以完整 `chat:raya:1549573491060244602` / `chat:raya:1549573499914297409` 的delivery_id/source_ref核对：raya与flywheel的mailbox、mailbox_identity、mailbox_terminal_archive两条各0；flywheel.mailbox_archive亦0。此结果替代先前substring及mailbox_log失败查询。结论限定在已核查的raya/flywheel标准收件库：两条输入均无live、identity或archive收件记录，尚未恢复；结合真实源消息和线程无对应回答，支持本事故入站缺口。

邻近主频道对照为 `chat:raya:1549573168706879539` (00:10:33Z)、`chat:raya:1549573538451562527` (00:12:01Z)、`chat:raya:1549574793370533941` (00:17:00Z)，均为discord_chat/to_agent=raya/state=ACKED。这是运输收件对照，不单凭ACK证明模型消费。上述Lead-provided证据满足设计选型；T4仍须上线前重读最新状态，避免并行恢复重复回答。
