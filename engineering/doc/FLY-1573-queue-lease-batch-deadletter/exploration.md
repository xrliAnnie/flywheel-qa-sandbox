# FLY-1573 队列能力三合一:租约重投 + 合批投递 + 死信闸 — 探索
Issue: FLY-1573 (https://linear.app/geoforge3d/issue/FLY-1573/消息层重构-d-批次2-队列能力三合一租约重投-合批投递-死信闸)
日期: 2026-08-10
基于: 无(上游权威 = `doc/messaging-rework/design.md`(FLY-1569,含 FLY-1580 勘误)+ FLY-1572 已合入实现)

## 0. 一句话

在 C 单(FLY-1572)已合入的 `mailbox` 单表 + 三条 lane 之上,补齐设计定稿 §3/§4/§6 留给 D 的三件事——**租约到期原地重投**(零新建行)、**合批投递**(同 from_agent + 60s 窗 + 上限 5,批级 ack,in-flight 上限 3 批)、**死信闸**(terminal 立死 / 3 次封顶 / 打包给 owning Lead,每收件人每 30min 限流)——并按 founder 2026-08-05 硬要求带一个独立可回切 flag `FLYWHEEL_MAILBOX_QUEUE`。

## 1. 三个病,三味药(设计定稿已定,不重开)

| 病 | 旧形态(v1 实测) | 药(design.md 定稿) |
| -- | -- | -- |
| 重发 = 复制新行 | `lead_inbox` 44,567 行里 42% 是重发副本,自激膨胀 | §1/§6:**同一行重新变可见**(SQS visibility timeout 形状),`state` 回 `QUEUED`、`retry_count+1`,❌ 绝不 INSERT |
| 收件人死了没人管 | 门铃和 stop hook 都要求收件人活着 | §6:租约是唯一不要求收件人活着的机制;terminal → 立刻 DEAD;死信打包换收件人 |
| 逐条门铃刷屏 / 队头阻塞 | 每条一响;窗口=1 会堵死后面所有信 | §4:合批(≠折叠)+ in-flight 3 批 + ack 才有下一批 |

这三件事改的是**同一片代码**(投递循环 + mailbox 状态机),所以合成一单——这是 issue 明示的打包理由,本探索不再质疑。

## 2. 起点:C 单已经给了什么(合入 main 的实况)

- `mailbox` 单表 + `QUEUED→LEASED→ACKED/DEAD` 状态机、`mailbox_identity`(身份永久占用)、`mailbox_log`(settlement CAS)已在生产(r4/r5 迁移窗已执行,后续加固见 FLY-1649/FLY-1657)。
- 三条 lane 已在跑:per-Lead `LeadInboxLoop`(1s/30s,零新增定时器)、per-project `RunnerMailboxLane`(挂在 leadIndex 0 的 admit 里)、bridge protocol lane。
- **Lead 行 ACK = 适配器 durable-accept**(批次 C 显式过渡口径,design.md §3 注记):adapter receipt 后 loop 立刻 `ackBatch`。
- **Runner 行**:`claimRunner` 单行认领 → LEASED(30min)→ 投递成功**停在 LEASED**,由拉取(`flywheel-comm inbox`/`check`)ACK;投递失败走 `recordRunnerDeliveryFailure` 退避重试(这是**投递失败**重试,不是**没 ack** 重试——D 补的是后者)。
- **没有**任何租约到期扫描、没有死信打包、没有 per-recipient in-flight 上限、合批不看 from_agent/时间窗(Lead 批一把抓 10,000)。

## 3. 方案空间与取舍(本单真正要拍的板)

### 3.1 租约重投的「原地」怎么落

**采纳:到期 → `state='QUEUED'`、`lease_retry_count+1`(plan 定稿的独立计数,与投递失败的 `retry_count` 分账)、清 `claimed_by/claim_expires_at/batch_id/delivered_at` → 下一 tick 自然重投。** 行数零增长,重投批由正常合批逻辑重新组批(组批键含 ack-class 与两计数,plan §2.3)。

否决的替代:
- ❌ 保持 LEASED 原批原样重发(不回 QUEUED):要给 claim 路径加「到期可重领」旁路,和 C 已有的 frozen-batch 语义搅在一起;且 Claude sidecar 对同 member 同 batch 重写返回 `accepted_duplicate_same_membership`——**重投会被 transport 去重吞掉,Lead 永远看不到第二响**(research.md §4 有证据)。
- ❌ 新建重投行:就是旧病本身,设计定稿红字禁止。

**连带决策(两个新列,plan 定稿):加 `delivered_at` + `lease_retry_count`。** `delivered_at` 区分「投达了在等 ack」(30min 租约到期才算没响应)和「认领了但 transport 没确认」(frozen 同键幂等重发,不消耗任何计数);`lease_retry_count` 把 no-ack 重投(max 3)与 transport 投递失败 `retry_count`(runner 6/lead 5/bridge 3,原语义不动)分账。幂等 `ALTER TABLE ADD COLUMN`,生产库已迁移完,必须走 open 时守卫式迁移(FLY-1267 先例)。**投递失败(含 runner)一律 frozen 式**:保批保键退避重发,不回 QUEUED(Codex R2#3)。

### 3.2 「60 秒窗」是约束不是等待

**采纳解释:合批是「凑当下可投的」,不是「攒满 60 秒再投」。** 窗口约束(plan 定稿为唯一 SQL 规则,Codex R1#9):头行按 `(priority, seq)` 选出后,成员 = 同组批键且 `head.created_at <= created_at <= head.created_at + 60s`(单侧、含边界),上限 5 条;tick 到了有什么投什么。空闲收件人单条秒投(低延迟不变差);连发/收件人忙时自然攒批。
否决的替代:❌ 延迟投递攒批——给每条 gate answer 平白加最长 60s 延迟,设计定稿 §4 的 tick 流程也没有任何「等」的语义。
验收含义:验收 5「连发 3 条一次收到」的成立条件是 3 条在同一次 claim 前入队(同秒连发/收件人在忙),真机脚本按此构造。

### 3.3 tick 内的判断顺序

设计定稿 §4 的编号顺序(1. in-flight≥3 跳过;2. 先处理租约到期)如果按字面执行会死锁:3 批全到期时,先「跳过」就永远轮不到回收。**采纳:到期处理(§1/§3 判断)每 tick 无条件先跑,in-flight 上限只闸「新批投递」。** 「2. **先**处理租约到期的」的「先」字本就是这个意思;in-flight 计数 = 未到期的 LEASED 批。

### 3.4 死信通知的收件人路由

- **runner 收件人**(设计已定):打包成一封普通信给 owning Lead(`resolveLeadForIssue` 从 session labels 推导),每收件人每 30min 最多一封(FLY-1580 勘误口径,❌ 不是全生命周期一封,必须有测试)。通知幂等键 = 确定性 id(收件人 + 已纳入的最大 dead seq),crash 重放靠 `mailbox_identity` 天然去重;「哪些死信已通知过」由 `dead_at > 上一封通知 created_at` 推导,**不加新表不加新列**。
- **Lead 收件人**(设计空白,本单拍板):「它的 Lead」不存在。**建议:走既有直发 alert sink(FLY-1586 `onQuarantineAlert` 同款结构与理由——报告队列堵塞的告警不能走这条队列自己)**,聚合一条、同 30min 限流;备选 = 本单边界只落 DEAD 可查不通知。已非阻塞 ask Tadashi(question `8dcfba7c`),plan 定稿前折入答复;无答复按建议方案走。
- **bridge 收件人**:保持 C 现状(`maxProtocolAttempts=3` → DEAD + `onProtocolQuarantine` 通知发起 Lead),不重复建设。

### 3.5 「收件人 session 已 terminal」的判定源

**采纳:StateStore(teamlead.db)`sessions.status ∈ TERMINAL_STATUSES`**(设计定稿点名 StateStore;`approved_to_ship` 明确非 terminal)。session 行不存在 → 视同「收件人不存在」→ 立死(「不存在 ≠ 没响应」)。判定只对 `recipient_kind='runner'` 生效;Lead 由 launchd KeepAlive 常青,恒视为活着;bridge 是自己。**terminal 真值表(Codex R1#1 修正,plan §2.2 定稿)**:terminal 收件人的 **QUEUED** 行立刻 DEAD(§6 括号注 + 验收 3,「立刻」= 下一 tick);**未到期的 LEASED 行不动**(§6 规则 1 优先,上限一个租约期);到期的 LEASED 行不分已投未投一律 DEAD 不重试(规则 2)。

### 3.6 Lead 的 agent-ack 怎么闭环

C 留好了关联数据(batch_id/delivery_id/source_ref)。**采纳:新 MCP 工具 `flywheel_inbox_ack_batch`(batch id 在门铃头部给出)→ 写一行 `type='ack_batch'` protocol 行(to_agent='bridge',durable)→ protocol lane 消费 → `ackBatch`。** 授权检查 = ack 行的 `from_agent` 必须等于批的收件人 + 批 membership 存在(batch id 本身是只投给该 Lead 的 128-bit capability),不新造 token 机制。既有 per-event `flywheel_inbox_ack_event`(lead_events 审计闭环)原样保留,两者正交。
否决:❌ 复用 per-event ack 推导「全成员 acked = 批 acked」——把审计层和队列层耦死,且 model 批里并非每成员都有 event ack 义务。

### 3.7 transport 去重 vs 重投(本次调研发现的硬约束)

Claude sidecar(`prepareBatchSidecar`)对 member id 有**跨批冲突闸**:同 `delivery_id` 出现在新 batch id 下 → `MailboxBatchConflictError` → loop 把整批 `markDead('membership_conflict')`。**重投若直接复用 delivery_id 会被判死。** **采纳(plan 定稿升级为双身份):transport 边界批与成员都 attempt-scoped —— `<batchId>#r<n>` + `<delivery_id>#r<n>`,`n = lease_retry_count`,ON 首投恒 `#r0`(ON 永不占用裸 id,ON↔OFF 切换才不撞同批身份,Codex R1#2)**;runner 批一批 = 一次 `writeMailboxEntry`,sidecar 键 = transport batch id,且必须 `verified: true`(假成功缝,Codex R2#3)。耐久身份(`mailbox.delivery_id`/`batch_id`、`[receipt:...]` 文本、ack capability、settlement 链)不变——同一 attempt 的 crash 重试仍幂等,新 attempt 是真新投递。Codex journal 同构处理。

### 3.8 flag 形态(founder 2026-08-05 硬要求,覆盖 1569 禁 flag 条款)

- **`FLYWHEEL_MAILBOX_QUEUE`:default-on kill-switch(`!== "0"` 为 ON),交付即启用;`=0` = 回滚到 C 现状(字节兼容)。**(极性由 founder 2026-08-10 指令定死:「带 feature flag 的要直接 enable」,避免「做了但没开导致看不到」;原 opt-in 方案作废。)
- 注册进 FLY-709 中央 flag registry;所有读点 `call_time`(lane 每 tick 读 process.env)→ 满足 registry 的 direct-toggleable 条件 → fleet flag console 可**运行时热切**,超额满足「不需重新部署」。
- **flag 只放 teamlead lane 层一个入口**(`MailboxQueue` 新方法全部显式传参,flywheel-comm 内零 flag 读点),旧流代码路径加边界注释——为将来「独立清理单删 flag+旧流」把结构成本压到最低(founder:删 flag 不在本单收尾)。
- 双向切换必须自愈:ON→OFF 时在途未 ack 批被旧流 frozen-batch 重领并 durable-accept 收敛;OFF→ON 无残留语义。QA 必测 ON 全量 + OFF 回切 + 再 ON。
- 参数(租约 TTL/窗口/批上限/in-flight/重试上限/死信窗)= 配置项带默认值,不是开关;QA 用短租约加速验收。

## 4. 本单明确不做

折叠/去重(`collapse_key` 只留字段位)、优先级排序逻辑(`priority` 只读)、消息分类、欠账数(F 单;门铃第③句省略)、task 表、Discord 直推收编(E 单)、DAG 对接、`runner_phase_wakes` 改革。投递循环红线①原样:mailbox 没有可投的信时一个字都不发。

## 5. 风险雷达(research/plan 展开)

transport 去重与重投的组合(§3.7,最大暗礁);frozen-batch 重领与 30min ack 租约的边界(需要 `delivered_at` 区分);ON→OFF 在途状态收敛;flag-truth CI 门要求新 env 全部注册;死信通知绝不能变成新的 watchdog(只由真实状态变化触发,幂等,限流)。
