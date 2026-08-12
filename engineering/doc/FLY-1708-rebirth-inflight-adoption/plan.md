# FLY-1708 出生自动接管在途批 — 实施计划

Issue: FLY-1708 (https://linear.app/geoforge3d/issue/FLY-1708/lead-换代后在途批无人签收-全舰信箱冻结-出生自动接管在途批投递语义只认身份不认实体)
日期: 2026-08-11
基于: 无(Lead 节约令:Linear issue 正文 + 4 条评论即完整规格,跳过 exploration/research)
Review: Codex design review **R5 APPROVED**(R1 5项 → R2 3项 → R3 1项 → R4 1项,全采纳零拒绝,台账见 §6)

---

## 0. 规格来源与一句话

**规格 = FLY-1708 issue 正文 + 4 条评论**(三案 + 阈值标定 + founder 原话 + 修法方向),本计划不重新考古,只把规格落成可实现的改动清单。

**一句话**:Lead 新身体真正 fork 前的最后一步,把自己名下全部 LEASED 在途批当作未投递收回(复用既有到期回收转移),让既有投递循环立即重投给现在的自己 —— 「新旧实体」从投递语义里消失,founder 无感;同时把两个生产死信输出面从「判死推论」改成「事实陈述 + 探针实况 + 验活后方可处置」。

**红线(issue 原文)**:不碰 `loop_owner` / Bridge 投递循环(8-11 已证其无辜);只动 Lead 侧出生对账。本计划对 `lead-inbox-loop.ts` 的投递/回收/死信循环**零行为改动**(§2.5-2.7 只改死信**渲染与传参**,不改扫描频率 / DEAD 触发 / 投递准入 / 状态机)。

## 1. 事实基础(已逐一在代码中核实;R1 修正两处)

| # | 事实 | 锚点 |
|---|------|------|
| F1 | mailbox 行收件人是**身份**(`to_agent`),状态机 `QUEUED→LEASED→ACKED/DEAD`;在途批 = `state='LEASED' AND batch_id IS NOT NULL`(**R1 修正:不再以 `delivered_at` 分流,见 F13**) | `packages/flywheel-comm/src/mailbox-schema.ts:31-47` |
| F2 | ack 已经**只认身份**:`ackBatchByRecipient` 仅校验全部行 `to_agent == fromAgent`,无任何实体/epoch 检查 —— 新身体天然有权签收 | `packages/flywheel-comm/src/mailbox-queue.ts:1251-1284` |
| F3 | Claude Lead 收件文件路径是**身份键**(`<teams>/<leadId>/inboxes/<leadId>.json`),跨换代不变 | `packages/agent-team-transport/src/path-helpers.ts:110-117` |
| F4 | 实体绑定发生在**吸取动作**:stock poller 以 `read` 标记消费(`messages.filter(m => !m.read)`),旧身体吸进自己会话上下文后被杀,内容只剩在死会话里,新身体看同一文件已无未读 —— 这就是「投到旧实体的对话现场」的机械成因 | claude-code `teammateMailbox.ts:120` |
| F5 | 到期回收转移已存在:`state='QUEUED', lease_retry_count+1, claimed_by=NULL, claim_expires_at=NULL, batch_id=NULL, delivered_at=NULL, last_error='lease_expired_unacked'`;`lease_retry_count >= leaseRetryMax(3)` 时到期转 DEAD | `mailbox-queue.ts:1508-1518`(requeue)/ `:1496-1506`(DEAD) |
| F6 | 重投的 transport 成员 id 带 `#r{lease_retry_count}` 后缀;Claude 侧 sidecar 以该 id 为幂等键,**同键重放 = 幂等成功且不重写 inbox** —— 所以任何「立即重投」若不递增计数,新身体永远收不到 | `lead-inbox-loop.ts:418-427` + `ClaudeMailboxCodec.ts:268-298` |
| F7 | 在途批槽位 = `LEASED AND claim_expires_at > now AND batch_id IS NOT NULL` 计数,上限 `inflightMaxBatches=3`;槽满则不再投新批(8-11 冻结机制)| `mailbox-queue.ts:1036-1044` + `mailbox-queue-config.ts`(ackLeaseMs=30min, leaseRetryMax=3) |
| F8 | Bridge 每 tick 已跑 `reconcileExpiredLeases`(Lead 收件),回收后自动重投 —— 出生对账只需把行放回 QUEUED,**重投由既有循环完成,零新常驻机制** | `lead-inbox-loop.ts:236-247` |
| F9 | Codex Lead 的 journal 是身份键耐久对话现场,daemon 启动自带 recovery(`redispatch/reconcile/resend_output`)—— 结构上已「只认身份」,不需要也不应该再叠出生对账 | `LeadJournal.ts:181-186` |
| F10 | 死信有**两个生产输出面**(R1 修正,原稿只见其一):① routable runner 死信:`scanAndInsertDeadLetterNotices`(措辞硬编码「可能已下线」+「请决定:重新派/丢弃/转给别人」),调用点 `runner-mailbox-lane.ts:247-262`;② Lead 自身 unacked + 无主 runner:`listUncoveredLeadDeadLetters`(摘要 "never acknowledged",`mailbox-queue.ts:1691-1831`)→ durable alert intent → `plugin.ts:7716-7728` sink(正文 "Decide whether to replay, discard, or reassign",无验活前置) | `mailbox-queue.ts:1655-1656` / `runner-mailbox-lane.ts:247-262` / `plugin.ts:7716-7728` |
| F11 | 部署链先 build 后重启(`diff → idle wait → build → restart`),新 launcher 与新 `flywheel-comm` dist 在 Lead 重生前就位 | `scripts/restart-services.sh:3` |
| F12 | Lead 出生有**两条现役路径**(R1 修正,原稿漏 v2):**v2 one-shot body** —— `lead-body.sh:64-77` 设 `FLYWHEEL_LEAD_BODY_V2=1` 后 source 同一 launcher,v2 分支在 `lead_identity_v2_acquire_bind` 后直接 `_launch_claude`(`claude-lead.sh:4526`)然后 exit,**不进** v1 while 循环;**v1 supervisor 循环** —— fresh lease 后经 tmux ensure / takeover / preflight / rules commit 等多道 HOLD 门,最终 `_launch_claude --resume`(`:4792`)或 fresh `--session-id`(`:4832`)。另有 dry-run 调用(`:4331`)与 rc=4/rc=5 收养/监控路径(不 fork 新身体) | `claude-lead.sh:4331,4433-4544,4526,4594-4717,4719-4771,4792,4832` |
| F13 | **`delivered_at IS NULL` 存在真实崩溃孤儿窗**(R1 #2):生产顺序 = adapter receipt → audit → `recordLeadBatchDelivered`(`lead-inbox-loop.ts:459-503`),而 Claude 批在返回 receipt 前已写 main inbox + finalize sidecar(`ClaudeMailboxCodec.ts:268-298`)。Bridge 在两步之间崩溃 → 行是 `LEASED + batch_id + delivered_at NULL`,但旧身体可能已吸取标 read;既有 frozenResend 复用同一 `#r{attempt}` → sidecar 只回 duplicate 不追加 unread → 该类孤儿靠 frozenResend 解不了冻 | `lead-inbox-loop.ts:459-503` + `ClaudeMailboxCodec.ts:268-298` + `mailbox-queue.ts:1480-1488` |

## 2. 改动清单

### §1 出生对账一步(核心)

**2.1 Queue API(`packages/flywheel-comm/src/mailbox-queue.ts`)**

新方法 `adoptInflightForRecipient(input: { recipientKind: "lead" | "runner"; toAgent: string; now: string }): { requeued: number }`:

- 单事务(`BEGIN IMMEDIATE`,与既有方法同款),一条 UPDATE:

```sql
UPDATE mailbox SET state = 'QUEUED',
  lease_retry_count = lease_retry_count + 1,
  claimed_by = NULL, claim_expires_at = NULL, batch_id = NULL,
  delivered_at = NULL, next_retry_at = NULL,
  last_error = 'recipient_reborn'
WHERE recipient_kind = ? AND to_agent = ? AND carrier = 'inbox'
  AND state = 'LEASED' AND batch_id IS NOT NULL
```

设计要点(每条都由 §1 事实强制):

- **复用 F5 到期回收同款转移**,只是把「到期」提前到出生一刻;唯一差异是 `last_error='recipient_reborn'`(可观测性:与真实到期区分)。
- **必须 `lease_retry_count+1`**(F6):否则重投成员 id 与首投相同,被 sidecar 幂等吞掉,新身体收不到。这不是可选项。
- **覆盖全部 `LEASED AND batch_id IS NOT NULL`,不以 `delivered_at` 分流**(R1 #2,F13):`delivered_at IS NULL` 的「inbox 已耐久、delivery receipt 未落」崩溃孤儿必须一并收编,否则本次事故类不能保证自动恢复。与仍在完成中的旧 transport write 竞态 = 有界 at-least-once 重复,接受(§4)。
- **不设 DEAD 分支**:即使行已达 `leaseRetryMax` 也照样 requeue(给活身体最后一次机会);判死权保持只在既有到期回收器手里(F5)—— 出生对账永不销毁 founder 消息。
- **不校验 owner epoch**:该 UPDATE 的 WHERE 即 CAS;与投递循环并发时,循环侧 `recordLeadBatchDelivered`(原 batch_id 已清 → `lost_race`,`mailbox-queue.ts:1194-1228`)与旧 `ackBatchByRecipient`(查无该 batch → `ack_late_noop`,`:1257-1281`)安全退避;ACK 先提交则行已 `ACKED`,本 UPDATE 的 `state='LEASED'` 守卫不碰它(R1 已核实)。不碰 `loop_owner` 表(红线)。
- recipient-kind-agnostic:runner 路径零额外成本地具备同一 API(§3 三案裁定 a)。
- **单一 CAS 源 —— connection 级纯 mutator(R4 #1)**:实际 SQL 落在导出的 `adoptInflightForRecipientOnConnection(db, input)`(只做 `BEGIN IMMEDIATE + UPDATE`,**绝不** ensure schema);`MailboxQueue.adoptInflightForRecipient` 与 maintenance CLI 都委托给它 —— CLI 不 `new MailboxQueue`(其 constructor 无条件 `ensureMailboxQueueSchema` → `ALTER TABLE`/`CREATE INDEX`,`mailbox-queue.ts:316-339,353-368`,违 2.2 合同),也不另抄 SQL(防语义漂移)。**不给公共 constructor 加 `skipSchema` 开关**(易误用)。

**2.2 CLI 命令(`packages/flywheel-comm/src/commands/adopt-inflight.ts` + `index.ts` 注册)**

`flywheel-comm adopt-inflight --recipient <id> --kind lead|runner`:

- **no-create、generation 校验后才写 —— 走新 maintenance-only opener,不走任何既有 constructor**(R1 #3 + R2 #1 + R3 #1):`CommDB` constructor 在 generation 校验**前**就 `mkdirSync` + `new Database` + `journal_mode = WAL`,之后还跑 schema/migration/purge(`db.ts:802-845`);`new MailboxQueue(path)` 也会建库跑 schema(`mailbox-queue.ts:353-368`)—— **禁止使用**。R3 进一步证实 `{readonly:true}` 也不是零写(普通 read-only WAL 连接参与 `-shm` wal-index/read-lock 协调,可改写甚至创建 sidecar,[sqlite.org/wal.html#read_only_databases](https://sqlite.org/wal.html#read_only_databases);本机复现:readonly SELECT 后 SHM SHA 变化)—— **也禁止用 readonly 连接来证明字节合同**。新增 `db.ts` 导出的 maintenance-only opener,打开序:
  1. `fs.stat` 文件不存在 → stderr WARNING + exit 0,**不创建任何文件**;
  2. **裸文件 header 检测(零 SQLite)**:直接 `fs.read` main 文件 header(magic + offset 18/19 —— **两字节均为 2 才是 WAL**,[sqlite.org/walformat.html](https://sqlite.org/walformat.html#the_main_database_file))。非 SQLite 文件或非 WAL → 判 legacy,WARNING + exit 0,**全程未打开 SQLite,零 sidecar、零字节变化**(生产 mailbox comm.db 恒为 WAL;rollback 模式即旧世代,无需开库即可判);
  3. WAL(2)才打开**唯一一条** `{fileMustExist: true}` 写连接(不设任何 journal/schema pragma;`busy_timeout` 有界):先 `PRAGMA query_only=1`(连接本地,零文件写)做 generation + 必需列校验(复用 `assertMailboxGeneration` 判据,`db.ts:756-788`);失败 → 关连接 + WARNING + exit 0;
  4. 校验通过才 `query_only=0`,执行 2.1 的 adoption UPDATE(`BEGIN IMMEDIATE`),不 ensure schema、不 migrate、不 purge。
- **字节合同按可证明口径收窄(R3 #1 采纳其选项二并加强)**:fail 路径合同 =「零逻辑变更」(不建库、不迁移、不写任何行、不改 journal mode)+ 字节断言分型:rollback-journal legacy 库 **main 逐字节不变且零新文件**(header 短路,SQLite 根本没开);live-writer WAL 库 **main + WAL 内容 SHA 不变**(SHM 的 SQLite 锁/索引字节变化 = 协议行为,显式排除在合同外)。孤连接 WAL 库 close 时的 SQLite 自动 checkpoint / 瞬态 sidecar 同属协议行为,文档显式声明,不假称三文件字节全保。
- **fail-open 语义**:上述缺库 / 世代不符 / SQLITE_BUSY 有界重试耗尽 → exit 0 + stderr WARNING(理由:对账失败只是退化回今天的 30min 兜底,而 Lead 起不来是全舰更大的故障;与 launcher 现有 flywheel-comm 缺失 WARNING 分支一致,`claude-lead.sh:521`)。参数错误(`--recipient` 空 / `--kind` 非枚举)exit 2(用法错误必须喊出来)。
- stdout:`adopted: <n>`。

**2.3 出生接线(`packages/teamlead/scripts/claude-lead.sh`)**

- **hook 定义 =「即将实际 fork 一个新 Claude body」**(R1 #1),抽一个 launcher helper(集中 `node "$FLYWHEEL_COMM_CLI" adopt-inflight --recipient "$LEAD_ID" --kind lead` + WARNING 日志;调用形态必须带 `node`,与既有 lease helper 一致,`lead-identity-preflight.sh:24-27`),接在**三个真启动调用**之前、各自所有 HOLD/shutdown 门之后:
  1. v2 one-shot 启动(`claude-lead.sh:4526` 前,rules receipt commit 之后);
  2. v1 resume 启动(`:4792` 前);
  3. v1 fresh 启动(`:4832` 前)。
- **不触发**:dry-run(`:4331`);rc=4/rc=5 收养/监控路径(不经过上述三点,天然不调用 —— 不靠 rc 特判)。
- 放在 HOLD 门之后的原因(R1 #1):若在 lease rc=0 就跑,后续 tmux ensure/takeover/preflight 任一 HOLD 会让「尚未造出身体就反复对账」,每轮白烧 lease retry。
- v1 resume 路径也跑(R1 #1 采纳):`--resume` 恢复的会话虽然带着旧上下文,但不能指望恢复体主动翻旧账;对账保证投递确定性,代价是有界重复(§4)。
- 幂等:重复运行天然 no-op(没有 LEASED 行就零变更),supervisor 重试循环安全。

**2.4 为什么这样就到达 founder 语义**

出生对账 + F2(ack 只认身份)+ F3(文件路径只认身份)+ F8(既有循环自动重投)合起来 = 投递语义里再没有「旧实体」:任何时刻,身份名下的在途批要么正被当前活体处理,要么在出生一刻被收回重投给当前活体。founder 视角:消息永远流向「这个 Lead」,无新旧之分。冻结机制(F7)在出生一刻解除:requeue 清 `batch_id` → 槽位计数立即归零 → 积压 QUEUED 随 tick 排空。

### §2 dead-letter 措辞 / 阈值 / 探针(评论 1+2 验收边界;R1 #4/#5 修正)

**2.5 统一措辞合同 —— 纯 formatter,覆盖两个生产输出面**

新纯函数模块 `packages/flywheel-comm/src/dead-letter-format.ts`(无 IO、无副作用),输出合同三要素:

1. 事实陈述:`<recipient> 有 <n> 封信未签收。未签收 ≠ 已下线：判死需独立探针，勿凭本通知推断状态。`
2. 探针实况行(见 2.6):`探针实况：<结构化 facts>` 或 `探针实况：不可得（处置前请人工 tmux pane 直读 + Bridge 心跳核对）。`
3. 处置前置:`处置前必须先验活体（tmux pane 直读 + Bridge 心跳），确认死透再决定：重新派 / 丢弃 / 转给别人；活着则不要动它。`

三个通知类全部过同一 formatter(R1 #4):

- **routable runner 死信**:`scanAndInsertDeadLetterNotices` 内容拼装改用 formatter(`mailbox-queue.ts:1655-1656` 硬编码删除);调用点 `runner-mailbox-lane.ts:247-262` 不改触发逻辑。
- **lead_unacked + runner_unroutable**:`listUncoveredLeadDeadLetters` 下游的 alert intent 渲染与 `plugin.ts:7716-7728` sink 正文改用 formatter("never acknowledged" / "Decide whether to replay, discard, or reassign" 措辞删除)。
- **只改渲染与传参**,不改 scan cadence / DEAD 触发 / `loop_owner` / 投递准入 —— 不越红线。
- 快照测试 ×3 通知类锁死新文案。

**2.6 探针实况 —— facts 是数据,由调用层在队列事务外采集(R1 #5)**

唯一合同(消除原稿自相矛盾):**探针行永远渲染** —— 有 facts 渲染 facts,无 facts 渲染「不可得」;不做「不传参数字节兼容」声明,快照测试按新输出锁定。

- formatter 签名收 `probeFacts?: string`(纯数据,调用方负责采集与格式);**队列事务内禁止任何探针回调/IO**。
- **逐收件人数据流(R2 #2)**:`scanAndInsertDeadLetterNotices` 的 recipients 在 `BEGIN IMMEDIATE` 内才枚举(`mailbox-queue.ts:1561-1604`),调用方事前不知道 ID → 采用**不可变快照 Map** 方案:`LeadInboxRuntime` 在触发 scan **前**(事务外)按项目构建 `Map<runnerId, string>`(逐 runner 的 facts 行,来源 = StateStore 会话登记视图 + 心跳时间戳;带快照完整性标记),lane 把纯 Map 传给 queue 新参数 `probeFactsByRecipient?: ReadonlyMap<string, string>`;**事务内只做 Map lookup,零 IO**。Map 缺项 → 诚实渲染「不可得」。
- **Lead 与 Runner 事实源分型(R2 #2)**:`lead_unacked` 的 recipient 是 Lead ID,**禁止**套 `resolveRunnerRecipientState`(会把「无 Runner session」误报成 Lead missing,`StateStore.ts:5714-5724` 只认 runner session);本单没有可靠的 Lead 独立事实源 → `lead_unacked` 一律渲染「不可得」,真源接线归 §3 c' 伴随单。
- v1 诚实口径:runner facts 也只是 StateStore 登记视图,**不是**独立 pane 实况,且正是 issue 点名可能说谎的视图。v1 facts 格式:`StateStore 视图=<alive|missing|terminal> / 最近心跳=<age>（注意：此为登记视图非 pane 直读，处置前仍须人工验活）`;取不到就「不可得」。
- **真 pane 直读 facts 接线 = 拆伴随探针单**(§3 c'):在 alert 渲染层(Bridge 进程、队列事务外)接既有 tmux 探针能力。本单不假称「零新探针已覆盖」。

**2.7 阈值审计(评论 2:任何「多久没 ack」存活判定 ≥30min 且不得单独作判据)**

- 时间型判死路径:`lease_expired_unacked` 需 3 次 × 30min ack lease ≈ ≥90min ✓ 已在量级之上,不改。
- 探针型判死路径:`recipient_terminal` 由 recipientState 视图驱动,非时间推断 ✓(该视图自身可能说谎 = sessions/runs-start 视图不一致,按裁定拆单,§3 b)。
- 措辞修掉后,通知层不再存在任何「没 ack ⇒ 下线」的单判据推论。**不改** `FLYWHEEL_MAILBOX_ACK_LEASE_MS` 下限(10s 下限是 QA 房快速测试在用的旋钮;生产默认 30min 已达标)。

### §3 与 FLY-1559/1561 边界 + 三案裁定

- **1559/1561(B 方案 MCP 信箱换装)**:本单是现役栈窄修。若 B 方案先行落地,本单语义要求 ——「投递只认身份不认实体 + 出生自动接管在途批」—— 作为 B 方案验收项**继承**,勿重复建设。本计划的 queue API 与验收脚本按现役 schema 写,不为 B 方案预留抽象(YAGNI)。
- **三案裁定(评论 1/3/4,design 阶段必须给出、禁止静默吞掉)**:
  - (a) **runner 收件路径身份接管**:queue API 已 recipient-agnostic(2.1,零额外成本);但 runner 出生 wiring 在 dispatcher/spawn preamble,风险面不同,且 runner 同身份重生仅 resume 场景 → **拆伴随单**(由 Lead 建单;标题建议「runner resume 出生对账接线 — 复用 FLY-1708 adopt-inflight」)。
  - (b) **聋 runner + sessions/runs-start 视图矛盾**(exec 5f13771a:GET /api/sessions 查无、POST /api/runs/start 称占位):出生接管**天然不覆盖** —— 这是活实体上的**投递面死亡**(投递目标解析指向无人监听的信箱),没有出生事件可挂钩 → **拆独立单**(由 Lead 建单;标题建议「sessions/runs-start 视图不一致 — 槽位既不可用也不可释放」)。
  - (c) **阈值标定**:已折入 §2(2.5-2.7)。
  - (c') **真 pane 直读探针接线**(R1 #5 新增):死信通知附真实 pane 活性 facts → **拆伴随单**(由 Lead 建单;标题建议「dead-letter 通知接真 pane 探针 facts — Bridge 渲染层、队列事务外」)。v1 先以 StateStore 视图 facts + 显式 caveat 顶上。
- **术语精确化(评论 4,写进实现注释与死信文档)**:「**聋**」= 投递面死亡(消息进无人监听的信箱,根本没收到);「**签收断链**」= 已送达实体但 ack 永不来(本单)。两类病,两种修法,通知措辞不得混用。

### §4 部署自举

修复自身要经过「会冻结的系统」上船,链路必须自洽:

1. merge → updater `git pull` → `restart-services.sh`(先 build 后重启,F11)→ 全舰重启**本身就是一次换代**,会制造新一批在途孤儿。
2. 但重启后每个 Lead 新身体跑的已是新 launcher + 新 `flywheel-comm` dist → 三个真启动点(2.3)出生第一步 adopt → **本次部署制造的孤儿被本修复自己收编**。零人工步骤。
3. 退化安全:任何一环缺失(dist 未 build / CLI 报错 / 库世代不符)→ fail-open 起 Lead → 行为退回今天的 30min lease 兜底 + 死信通知,不比现状差;下次重启自愈。
4. ship 观察项(不阻塞 merge):部署重启后 `sqlite3 comm.db "SELECT COUNT(*) FROM mailbox WHERE state='LEASED'"` 应在 Lead 出生后即刻归零、QUEUED 随 tick 排空;launcher 日志应见 `adopted: <n>`。

## 3. 验收与测试(TDD)

**vitest(`packages/flywheel-comm/src/__tests__/mailbox-adopt-inflight.test.ts`)**:

1. 孤儿批(LEASED+batch_id,**含 delivered_at NULL 与 NOT NULL 两态**)→ adopt → QUEUED、`lease_retry_count+1`、`last_error='recipient_reborn'`、batch/claim/delivered 清空;
2. QUEUED/ACKED/DEAD 不动;别的 to_agent / recipient_kind / carrier='external' 不动;
3. 已达 leaseRetryMax 的行照样 requeue(不 DEAD);
4. 幂等:连跑两次,第二次 `requeued=0`;
5. 竞态:adopt 后旧 batchId 的 `ackBatchByRecipient` → `ack_late_noop`;`recordLeadBatchDelivered` → `lost_race`;ACK 先提交 → adopt 不碰 ACKED 行;
6. **crash-seam(R1 #2)**:真 Claude adapter 已 durable accept(inbox 写入 + sidecar finalize)、旧 inbox 项标 read、故意跳过 `recordLeadBatchDelivered` → 出生对账后下一 tick 必须写出 `#r{n+1}` 新 unread 项(不是再等 30 分钟);并覆盖与仍在完成的旧 transport write 竞态;
7. 端到端(既有 lead-inbox-loop 测试台架):3 孤儿批打满槽 + 积压排队 → adopt → 下一 tick 槽位可用、重投成员 id 带 `#r{n+1}`(sidecar 不吞)、新批可投 —— 8-11 冻结场景复现→解除。

**formatter 测试(`dead-letter-format.test.ts`)**:三通知类(routable runner / lead_unacked / runner_unroutable)快照,**逐类断言 facts 来源与 caveat**(runner=StateStore 视图行;lead_unacked=不可得;R2 #2);probeFacts 有/无 两态(探针行永远渲染);合同三要素逐条断言;Map 缺项 → 不可得。

**CLI 测试**:参数校验(exit 2);**no-create/no-mutate 证明(R1 #3 + R2 #1 + R3 #1 分型)**:① missing path → exit 0 且路径未被创建;② rollback-journal legacy 库(sidecar 原本不存在)→ exit 0、main 逐字节不变、**零新文件**(header 短路);③ **live-writer WAL 库**(另一连接保持打开)世代不符 → exit 0、main SHA + WAL SHA 不变(SHM 显式排除);④ 正常路径 `adopted: <n>`;⑤ **非 vacuous schema-ensure 反证(R4 #1)**:构造世代正确、必需列齐全但缺 `mailbox_lease_expiry` index 的库 → adoption 成功且该 index 仍不存在(证明 CLI 真没走 `ensureMailboxQueueSchema`)。

**shell(`scripts/__tests__/test-claude-lead-adopt-inflight.test.sh`,R1 #1 覆盖面)**:hermetic 台架(CLI 打桩记录调用):① 经真实 `lead-body.sh` / v2 manifest 路径恰好调用一次且在 `_launch_claude` 前;② v1 resume 路径调用一次;③ v1 fresh 路径调用一次;④ dry-run 零调用;⑤ prelaunch HOLD(如 tmux ensure 失败)时零调用;⑥ CLI 失败(非零/缺失)不阻断 launch。

**真机验收(issue 原文,由独立 QA 节点执行)**:模拟换代(杀 Lead 体重生,529 房或隔离 comm.db + 真 launcher)→ 在途批零人工自动续流;founder 视角零盲区(积压排空、无手工捞 batch_id)。

**门**:`pnpm lint` 全仓 + `pnpm -r build` + `pnpm test:packages:run` + 新 shell 测试。

## 4. 诚实边界

- **有界重复投递**:三类来源 ——(i)换代瞬间「已投进文件但旧身体未吸取」的行;(ii)F13 崩溃窗行与仍在完成的旧 transport write 竞态;(iii)v1 resume 路径恢复体上下文里已有的批 —— 新身体都会既见旧件又收 `#r{n+1}` 重投件(≤3 批 × ≤5 条,仅出生时)。at-least-once 是既有契约(30min 到期重投今天就产生同类重复);去重需解析 stock 收件文件 read 标记,增加格式耦合 —— 按 founder 删复杂度原则**接受重复、拒绝耦合**(rejected alternative #1)。
- **每次换代烧 1 次 lease retry**:连续 3 次换代仍无人 ack 的批会 DEAD + 死信通知 —— 这是「同一封信历经三代身体都没被处理」的真实病理信号,判死正确。
- **v1 死信探针 facts 是登记视图不是 pane 实况**(措辞里显式 caveat);真 pane facts 拆伴随单(§3 c')。
- **Codex Lead 不接线**(F9):journal recovery 已覆盖;叠加对账会双重重放。若未来 Codex journal recovery 被证伪,再补接线(同一 CLI 一行)。
- **不修**聋 runner / 视图不一致(§3 b 拆单)、runner 出生接线(§3 a 拆单)、Bridge 投递循环(红线)。
- **rejected alternatives**:①文件核对去重(上文);②Bridge 侧换代探测触发对账 —— 违红线且引入常驻机制;③缩短 ack lease 加快兜底 —— 违评论 2 阈值裁定(≥30min);④出生盲 ack 清槽 —— 内容没人处理过就签收 = 丢信,违 at-least-once;⑤在 lease rc=0 处接 hook —— HOLD 门前对账会空烧 retry(R1 #1)。

## 5. 改动面汇总

| 文件 | 改动 |
|------|------|
| `packages/flywheel-comm/src/mailbox-queue.ts` | 新增 connection 级纯 mutator `adoptInflightForRecipientOnConnection` + 实例方法 `adoptInflightForRecipient`(双委托);死信内容拼装改用 formatter(删硬编码措辞)+ `probeFactsByRecipient` Map 参数(事务内仅 lookup) |
| `packages/flywheel-comm/src/db.ts` | 新增 maintenance-only opener(raw header 短路 → 单 `fileMustExist` writer + `query_only` 校验,零 schema/migration/purge)(R2 #1 + R3 #1) |
| `packages/flywheel-comm/src/dead-letter-format.ts`(新) | 纯措辞 formatter(合同三要素 + probeFacts 数据参数) |
| `packages/flywheel-comm/package.json` | `exports` map 新增 `./dead-letter-format` 子路径(R2 #3,跨包导入合法化;全仓 build 作解析门) |
| `packages/flywheel-comm/src/commands/adopt-inflight.ts`(新) + `index.ts` | CLI `adopt-inflight`(no-create、generation 校验、fail-open) |
| `packages/teamlead/scripts/claude-lead.sh` | adopt helper + 三个真启动点前调用(v2 `:4526` / v1 resume `:4792` / v1 fresh `:4832`);dry-run、rc=4/5 不触发 |
| `packages/teamlead/src/bridge/lead-inbox-runtime.ts` | scan 前(事务外)构建逐 runner 不可变 facts Map(R2 #2) |
| `packages/teamlead/src/bridge/runner-mailbox-lane.ts` | 把 facts Map 作纯数据传给 scan |
| `packages/teamlead/src/bridge/plugin.ts:7716-7728` | 死信 alert sink 正文改用 formatter(`lead_unacked` facts=不可得,见 2.6) |
| 测试 | vitest ×3 文件(adopt / formatter / CLI)+ shell ×1 |

Bridge 投递循环(`lead-inbox-loop.ts`)、`loop_owner`、FSM、StateStore schema:**零改动**。

## 6. Review 台账

- **R1(Codex,xhigh)CHANGES REQUESTED,5 项全采纳**:#1 漏 v2 出生路径 + hook 应锚定「真 fork 前」三点(F12 重写、2.3 重写、shell 测试覆盖面扩);#2 `delivered_at IS NULL` 崩溃窗孤儿(F13 新增、2.1 谓词放宽、crash-seam 测试);#3 CLI 需 `node` 调用形态 + no-create/generation 校验 + 字节级证明(2.2 重写、CLI 测试);#4 死信有两个生产输出面,统一纯 formatter(F10 修正、2.5 重写);#5 探针合同矛盾 + 所称快照不存在 → facts 作数据、事务外采集、v1 诚实口径 + 拆伴随探针单(2.6 重写、§3 c' 新增)。
- **R2(Codex,resume)CHANGES REQUESTED,3 项全采纳**:#1 `CommDB`/`MailboxQueue` constructor 都在世代校验前写库 → 新增 db.ts maintenance-only opener(2.2 重写);#2 scan recipients 在事务内才枚举 + Lead/Runner 事实源未分型 → 不可变 facts Map 事务外构建、事务内仅 lookup + `lead_unacked` 一律不可得(2.6 重写、lead-inbox-runtime.ts 入改动面);#3 `dead-letter-format` 缺 package export → package.json exports 子路径入改动面。
- **R3(Codex,resume)CHANGES REQUESTED,1 项采纳**:`{readonly:true}` 在 WAL 下仍改写/创建 `-shm`,不能证明三文件字节全保 → 2.2 重写为「裸 header 检测短路 rollback legacy(零 SQLite)+ 唯一写连接 `query_only` 校验后放开」,字节合同按选项二收窄分型(main+WAL 内容保真;SHM/协议行为显式排除),CLI 测试拆 ①-④ 两态覆盖(live-writer WAL / 无 sidecar rollback)。与本仓既有实证一致(agent-memory:readonly WAL 探针造 0444 `-shm`、journal 模式读 header byte 18/19 别开库)。
- **R4(Codex,resume)CHANGES REQUESTED,1 项采纳**:CLI 缺「不 ensure schema 又复用同一 CAS」的调用 seam → 导出 connection 级纯 mutator `adoptInflightForRecipientOnConnection(db, input)`,queue 方法与 CLI 双委托,不加 `skipSchema` 开关(2.1 增注);CLI 测试加 ⑤ 缺 index 反证;§5 db.ts 行口径同步;header 判据精确到「offset 18/19 两字节均为 2」。
- **R5(Codex,resume)APPROVED — ready to implement**。零阻塞;非阻塞注记(共享 helper 直接测试 + 缺 index 反证测试在后续重构中保留;头部 Review 状态与 §5 helper 行已按注记更新)。
