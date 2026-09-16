# FLY-2608 Raya 线程双向对话 — 调研
Issue: FLY-2608 (https://linear.app/geoforge3d/issue/FLY-2608/raya工程修复-discord-thread-中的-founder-提问必须送达-raya并在原线程回复)
日期: 2026-09-15
基于: exploration.md

## 基线与证据分级
源码基线 557d2b00e；2026-09-16T03:16Z /health buildSha 与之相同。以下源码事实已核验；事故两条原消息已由 Lead 定位；精确 live/archive 收件证明仍请求补充，不由源码推断替代。

| 判断 | 证据 | 处置 |
|---|---|---|
| by-thread 的 flywheel 就是误路由根因 | tools.ts:1023 从 getSessionByIssue 取 project_name，没有收件操作 | 未证实；展示值本身不是路由依据，不修改其语义 |
| Codex 自动订阅任意自己创建的 issue thread | codex-lead-tui-runtime.ts:1120 只传 config.channelIds；RoundtableThreadDiscovery.ts:123 仅遍历已有 registry | 源码反例；不为本单新增另一个收件器 |
| 当前持久化订阅含两条线程 | Raya inbound-cursor.json 只有主频道/roundtable频道；roundtable-subscriptions.json entries=[] | 当前文件观察否定；不能证明历史收件为零 |
| Bridge 会扫描所有注册 issue thread | gate-poller.ts:2353 取 listNonTerminalSessions，:2439 按 session.project_name、matchesLead 选线程；另有 ship judgment 历史扫描 | 源码否定。raya/raya 没有相应 session 时不能由该路径覆盖 |
| 新线程首次扫描可收到刚发的问题 | founder-reply-deliverer.ts:324 无 cursor 时取 limit=1，保存 HEAD 后返回 noop | 源码否定；简单扩大扫描会永久跳过首次发现前输入 |
| Bridge thread ingest 自带回帖目的地 | founder-reply-deliverer.ts:456 传 chatId/originChannelId，未传 replyChannelId | 源码否定；chatId 不等于自动回帖字段 |
| mailbox 已有目的地与去重机制 | discord-chat-ingest.ts:149-235；chat-delivery-envelope.ts；lead-inbox-loop.ts:424；lead-delivery-adapter.ts:156；CodexLeadInboxSocket.ts:332；LeadInputRouter.ts:327 | 可复用，补 envelope 字段而非改协议/新表 |

路径除另注外均位于 packages/teamlead/src/bridge/；Codex 类位于 packages/teamlead/src/lead-backends/codex/；ingest/envelope 位于 packages/flywheel-comm/src/。

## 可复用的数据与消费者
StateStore.getUnarchivedIssueChatThreads() 和 getUnarchivedPhaseChatThreads() 返回 thread_id/channel_id/issue_id/lead_id。前者按创建时间排序，过滤 archived/missing；后者覆盖仍可见的 legacy phase thread。两者都是只读查询。chat-thread-register.ts 用 project 配置中的 lead.agentId 和 chatChannel 校验注册。以注册行 lead_id + channel_id 反查当前配置的唯一 project/lead，得出通信 owner；issue_id 仅关联业务上下文，不能覆盖这个 owner。

既有 scanBudget、founderReplyScanCursor 提供轮转公平性；保留 questioned 优先和现有历史审批扫描。新增普通注册线程必须有明确 ingest-only 模式，不把其内容送 processFounderMessage：该函数仍处理审批卡、旧卡与决策收敛，仅传空 questions 不足以隔离副作用。

现有 cursorStore 按 threadId 保存读取进度；持久化收件成功后才能推进。mailbox 的 deliveryId=chat:<leadId>:<messageId>，首个写入载荷不可变；同一 id 重投不会替换旧目的地。discordBatchPartitionKey 已按 chatId/replyChannelId/replyRoute 分组，防止不同线程同批。parseDiscordChatRoute → lead-inbox-loop → v2 lead-delivery-adapter → socket.submitBatch → LeadInputRouter → sender 保留 replyChannelId。v1 明确拒绝携带路由的 batch；不能降级后声称正确。

## 最小修改选择
复用 Bridge 当前扫描器，以注册表补足缺失线程。不要新加数据库、依赖、定时服务、Raya 专属收件系统或在 roundtable 中伪造订阅。StateStore 已有两个查询，优先直接组合；只有测试发现有查询边界缺失才修改查询，不复制表。

新增注册线程模式第一次没有游标时从 threadId 开始（Discord thread 的创建雪花 id，即不包含根消息、包含之后消息）；每次只读现有页上限，按 oldest-first 成功推进，跨 tick 完整追上，不能跳到当前 HEAD。存量既有游标不后退；两条已报告线程如有过早推进游标，使用逐条审计后的标准补投，不全局重置。

需要用官方 Discord 文档核实 REST 的 after 分页方向，实施测试必须 >100 条证明跨页连续性，不能只依赖源码注释。权限/429/5xx 保持游标，按既有轮转重试；未知 owner 暂不消费并给出诊断。

## 历史与上线边界
FLY-2226 仅参考其注册表覆盖、游标初始化、首次载荷归属风险；当前分支没有其描述的独立对账器，不能把旧设计当成已部署能力。当前源码仍有审批解释路径，必须显式隔离。

设计期取证限制：by-thread 两次401；受管 raya 快照拒绝 runner_snapshot_context_invalid。已报 Lead，问题 f65445d7-a479-4cd5-8a6c-5ae6c79a54ad。没有直接复制数据库、修改权限、修改身份、调用发消息/恢复接口。历史恢复及真实会话验收是后续交付的硬条件。


## 2026-09-15 20:22 PDT 证据补记（Lead 提供）
问题 f65445d7-a479-4cd5-8a6c-5ae6c79a54ad 已回答。Lead 在约03:2xZ读取的证据如下；Runner无直接Lead读取权限，没有借用token。

| 线程 | founder 原消息 | 时间（UTC 2026-09-16） | 正文 | Lead 查询结论 |
|---|---|---|---|---|
| 1549573426547658793 / FLY-2131 | 1549573491060244602 | 00:11:49 | 这是什么东西呀？ | Raya mailbox未见；后续机器人帖无对应回答 |
| 1549573438937767977 / FLY-2382 | 1549573499914297409 | 00:11:52 | 这是什么东西呀？ | Raya mailbox未见；后续机器人帖无对应回答 |

Lead 的 by-thread 读取确认 issue session 项目为 flywheel；lead_events 没有引用这两个id的任一Lead记录。Raya mailbox该分钟只有主频道投递，正文检索也未命中。Lead将此判为入站未送达；本设计把它作为Lead提供的事故证据，精确live/archive计数与登记owner仍请求补充。原先“原消息id未知”仅是早期取证状态，现在已定位；实施必须用上述真实id核对、恢复并补实际同线程回答。不可把后续机器人普通消息当作回答。

## 官方协议核对
已于本轮阅读 [Discord Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages)：返回数组按新到旧排序，after为指定id之后，limit为1–100，缺READ_MESSAGE_HISTORY权限可能返回空数组。因此200空数组不是“历史不存在”的证据；QA必须核对权限。文档未明确说明after多页选取最近还是最早的一批，保留T2受控>100条分页核验，不将源码注释当协议证明。


### 登记行补证与查询边界（Lead，约03:3xZ）
问题 ee3d76ac-8f88-40d9-aaf7-858808009f2c 返回：两条 chat_threads 的 channel_id 都为1542079099928059987、lead_id=raya、archived_at=NULL、discord_missing_at=NULL；created_at 分别为2026-09-16 00:11:34/00:11:37。满足本方案按父频道与lead确定通信owner的前提。

Lead 的 content LIKE 源id计数：raya.mailbox各0，flywheel.mailbox各2；但调查ask/report本身含源id，不能把substring命中当实际discord_chat投递。mailbox_log.content查询失败（no such column），不能判archive为空；实际表列表还含mailbox_terminal_archive、mailbox_identity，flywheel另有mailbox_archive。已请求问题22c03203-c166-475d-9f94-ccf720a63c36按精确deliveryId/source kind查询。上述失败与不确定性保留，不声称误送另一个Lead。
