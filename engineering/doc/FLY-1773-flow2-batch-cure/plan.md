# FLY-1773 Flow 2(Batch 通道)三件治病 — 实施计划

Issue: FLY-1773 (https://linear.app/geoforge3d/issue/FLY-1773/机制-flow-2batch-通道治病三件真送达才盖章-未读不占位-读者可判活-两条规则终稿的主刀单)
日期: 2026-08-14
基于: research.md
Status: codex-approved(design review 6 轮:R1 7 条 → R2 3 → R3 5 → R4 4 → R5 2 → R6 APPROVED,全部折入见 §8。R6 non-blocking advisory:EXPLAIN QUERY PLAN 断言必须跑**生产 SQL 本体**,不许测复制的等价查询)

## 0. 总则

- **交付三件**:① 真送达才盖章(`delivered_at` 只在收件人真实接收后落);② 未读不占位(in-flight cap 退化为纯传输背压);③ 读者可判活(Lead 批接判活面 + retired Lead 收尾)。
- **边界**:Flow 1(runner)零行为变化(research §5 六条红线);`lead_events` 不并账;无新配置表、无新 feature flag、无新 timer。
- **TDD**:每步 RED → GREEN;既有套件(research §6)全绿是每步的地板。唯一允许改语义的既有断言:直接断言病灶行为的用例(在各步中逐条点名),改动理由必须写进测试注释。
- **统一谓词**:「该批从未成功传输」全库唯一写法 `COALESCE(notified_at, delivered_at) IS NULL`(过渡读:存量 LEASED 行只有 delivered_at,一个 ack-lease 周期内收敛)。所有判定点共用,禁止各写各的。
- 改动范围:`flywheel-comm`(mailbox-queue / db / mailbox-schema / mailbox-migration)、`inbox-mcp`(delivery/index)、`teamlead`(lead-inbox-loop / lead-inbox-runtime / gate-poller reconcile rider / plugin 装配)。单次 Bridge 重启部署,Lead 端 ack 工具契约不变。

## Step 1 — schema:`notified_at` 列 + projection view 版本化重建 + adoption 列表

**改**(`mailbox-queue.ts:272` `ensureMailboxQueueSchema` + `mailbox-schema.ts` + `db.ts`):
1. 幂等 `ADD COLUMN notified_at TEXT`(与 `delivered_at`/`lease_retry_count` 同款);`MailboxRow` 加字段
2. **projection view 原子幂等升级**(R1-#3 + R2-#2 + R3-#4 收紧):`CREATE VIEW IF NOT EXISTS` 对已部署旧库是 no-op —— 在列升级成功后,同一事务内**先探 view、再决定做不做后续两步**(顺序即护栏):
   - **探测**:`mailbox_message_projection` view **不存在**(caller-owned 最小 mailbox schema —— `mailbox-queue.ts:339-344` 与 schema test fixture,连 `type/claimed_by/batch_id` 列都没有)→ 只做列/索引升级,**view migration 整段结束**(不 prepare、不执行 backfill,不创建 view;完整 schema 的 view 创建仍归 CommDB 既有路径)
   - view 存在但**缺少 v2 指纹**(full/compat 旧 schema 分支)→ **先幂等 backfill 存量 legacy-push 行**(R2-#2:这些行 base `delivered_at` 从未写,retry-window 证据只活在旧 view 的 `LEASED→claim_expires_at` 派生里,DROP 旧 view 即丢失):`UPDATE mailbox SET notified_at = claim_expires_at WHERE type='instruction' AND state='LEASED' AND claimed_by='legacy-push' AND batch_id IS NULL AND notified_at IS NULL`;view 已有 v2 指纹 → 在 backfill 前直接结束,避免把当前 pre-notify claim 误盖成已通知
   - 再按**版本指纹**重建:view 的 `sqlite_master.sql` 不含新版指纹(`delivered_at` 派生仅 ACKED)时 `DROP VIEW` + `CREATE VIEW`;重复执行幂等
3. `notified_at` 加入 `MAILBOX_ADOPTION_COLUMNS`(`db.ts:727-739`),使 maintenance adopt SQL 的列守卫在旧 schema 上按既有 guard 语义失败,而不是执行期 `no such column`

**测(先 RED)**:
- `mailbox-queue-schema.test.ts`:新库/老库升级后列存在、默认 NULL、重复升级幂等
- **旧库 view 重建**:先按旧定义手工建 view → 用生产 `CommDB` 打开 → 断言 `sqlite_master.sql` 为新定义、LEASED 行 projection `delivered_at IS NULL`
- **legacy-push 存量行不重发风暴**(R2-#2):造一条 retry window **内**的真实 legacy-push 行(走 `markInstructionDelivered` 旧字节)→ 升级 → 断言仍隐藏;窗口过期后**恰好重投一次**
- 最小 schema 兼容(R3-#4):保留现 fixture 的**真实最小列集合**(仅 `seq/state/carrier/claim_expires_at` 等)跑 `ensureMailboxQueueSchema` → 不创建 view、**backfill 未被 prepare/执行**、零错误(阴性对照)
- adoption 列守卫:去列旧库 → adopt 走 guard 失败路径(非 runtime SQL 错)

## Step 2 — 病 1a:批路径盖章移位(含 claim 热路径全部判定点)

**改**(`mailbox-queue.ts`):
1. `recordBatchDelivered`(:1207):按 `recipientKind` 分写 ——
   - runner 行:`notified_at = COALESCE(notified_at, now)` **且** `delivered_at = COALESCE(delivered_at, now)`(双写,旧读点恒等)
   - lead 行:只写 `notified_at`;**不再写 `delivered_at`**。ack lease(`claim_expires_at = now+ackLeaseMs`)照旧
2. `ackBatchByRecipient`(:1274):置 ACKED 时补 `delivered_at = COALESCE(delivered_at, ?)`(与 `acked_at` 同刻 —— 收件人签收即真送达)
3. **「从未成功传输」判定点全量换统一谓词**(R1-#1):claim 热路径 frozen-batch 选择(:1004)、frozen 成员选择(:1024)、frozen UPDATE CAS(:1040),reconcile frozenResend(:1511)—— 四处全部 `delivered_at IS NULL` → `COALESCE(notified_at, delivered_at) IS NULL`。漏任何一处 = lead 成功批在 ack lease 内被当 frozen 批立即重投
4. **重置点全量同步**:新批 claim UPDATE(:1160,`delivered_at = NULL` 处)、`adoptInflightForRecipientOnConnection`(:318)、reconcile requeue(:1544)/terminal(:1427/:1504)、runner batch failure 路径(:2065 附近)—— 凡清 `delivered_at` 处同步 `notified_at = NULL`;凡保留处两列同保留

**测(先 RED)**:
- lead 批:transport receipt 后 `delivered_at IS NULL` 且 `notified_at` 非空;ack 后 `delivered_at = acked_at`
- **热路径回归**(R1-#1):lead receipt 成功、ack lease 未过期 → 下一 tick `claimLeadBatchQueue` 返回空(不得把成功批当 frozen 重投);lease 过期 reconcile 后才走 lease retry
- runner 批:receipt 后两列同刻非空 —— 现有 runner 断言全绿 + frozen 判定等价锁(runner 新旧行各一)
- frozenResend:lead 批从未成功传输 → 冻结重发不涨 lease_retry;传输过 → lease retry
- `mailbox-adopt-inflight.test.ts`:adopt 后 `notified_at` 清空

**点名的既有断言改动**:`mailbox-queue.test.ts` 中直接断言「recordLeadBatchDelivered 后 delivered_at 非空」的用例改为断言 `notified_at`(该断言即病 1a 本身)。

## Step 3 — 病 1b:push 路径盖章移位(ownership 在 notify **之前**,queue-enabled 时关停 content push)

**改**(R1-#4 + R2-#1 + R3-#1/#2/#3 定稿):
1. **queue-enabled 时关闭 instruction content push**:inbox-mcp 的 poll loop(`index.ts:197-219`)在 queue flag 为 true 时不再做 content notification —— Lead 消息一律 Flow 2 批投递(issue 两条规则的字面落实);MCP 的 ack 工具照常提供。
   **flag 热读权威**(R3-#2):inbox-mcp **每次 poll** 从 canonical `~/.flywheel/.env` 用既有 `readEnvFileSource`/`readEnvFileValue` 做 `dotenv_live` 读取,再交 `mailboxQueueEnabled`(该 helper 只读传入 env,`config/src/feature-flags/mailbox-queue.ts:2-5`;Lead 启动链 `env -i` allowlist 不传此变量,静态 env 不可依赖);缺文件/不可读 → 视为 **enabled**(fail 向单 lane)。该 read site 登记进 feature-flag registry
2. **`enabled:false` legacy 分支:可恢复的 pre-notify claim 状态机**(R3-#1,推翻 R2 版「QUEUED-only CAS + 长驻 LEASED」—— 那个状态机第二次重投永远 CAS miss,且两个 crash 缝会永久卡行):
   - **稳态 = QUEUED**,可见性由 `notified_at` retry window 控制(不再用长驻 LEASED 表示已通知)
   - **顺序权威统一为 `seq`**(R5-#2:现 pending SQL `ORDER BY created_at` 与 FIFO fence 的「更早 seq」是两套可互相矛盾的顺序 —— migrated/caller-stamped 行或时钟回拨下 SELECT 先给 seq 2、CAS 又被 seq 1 挡,投递顺序被静默改写):pending SELECT 改 `ORDER BY m.seq`(mailbox durable insertion order 为 canonical total order;`db.test.ts` 的「FIFO by created_at」断言 = **合法 retarget**,测试注释点名),SELECT / CAS / 测试逐字同源
   - pending SQL:`(state='QUEUED' AND 窗口过期或未通知) OR (state='LEASED' AND claimed_by='legacy-push' AND claim_expires_at <= now)`(后者 = crash 恢复面),恒有 `batch_id IS NULL` 且排除他人 claim
   - notify **前** IMMEDIATE `tryClaimInstructionForPush(id, retryCutoff, now)`(R5-#1:retry window 是 inbox-mcp 的 `FLYWHEEL_INBOX_RETRY_WINDOW_SEC` 配置,CommDB 不持有 —— **caller 计算绝对 `retryCutoff` 传入**,目标行 eligibility 与 FIFO `NOT EXISTS` 子查询**共用同一 cutoff 谓词**):CAS `WHERE id=? AND type='instruction' AND batch_id IS NULL AND (state='QUEUED' OR (state='LEASED' AND claimed_by='legacy-push' AND claim_expires_at <= ?))` 且 CAS 内重验 eligibility(`notified_at IS NULL OR notified_at <= retryCutoff`)+ **FIFO 顺序 fence**(R4-#2:CAS 断言不存在同收件人**更小 seq** 的「未过期 legacy claim 在途行」或「eligible 未 claim 行」;DB 侧 fence 抗双 MCP 进程)→ `state='LEASED', claimed_by='legacy-push', claim_expires_at = now + 短真实 transport TTL(30s)`;miss → 跳过,**notifier 零调用**。**返回本次 attempt 的 fence**(= 本次写入的精确 `claim_expires_at` 值)。热路径新 CAS 跑 `EXPLAIN QUERY PLAN`,predecessor 子查询必须命中 `mailbox_live(to_agent, seq)` 族索引,不许全扫
   - notify 成功 → `recordInstructionNotified(id, fence)`:`WHERE state='LEASED' AND claimed_by='legacy-push' AND claim_expires_at = :fence`(R4-#1:**attempt-fenced** —— attempt A 超 TTL 后 attempt B 续取,A 的迟到 success/failure 不得动 B 的新 lease)→ **回 QUEUED、清 owner/claim、`notified_at = now`(每次成功刷新)**;notify 失败 → 同 fence 释放回 QUEUED 不写 notified_at
   - crash 缝语义:claim→notify 间死 / notify→record 间死 → 行留 LEASED+30s claim → 过期后被 pending/CAS 恢复面重取(at-least-once,可能重发一次,幂等由 message_id 兜)
3. **push lane 单一 lane 守卫**:`PENDING_PUSH_INSTRUCTIONS_SQL`(`db.ts:56`)排除 `batch_id IS NOT NULL` 与他人 claim —— 被 Flow 2 批 claim 的行 push lane 永不碰。FIFO predecessor fence 让 queue-OFF rollback lane 每个 1s poll 只推进一个 head(100 条 backlog 约 100s),这是为跨进程严格顺序接受的 rollback-only 吞吐变化
4. **ON 切换的 legacy→batch handoff**(R3-#3 + R4-#1 收紧):lead-inbox-loop tick 的 `queueConfig.enabled` 分支内(reconcile 之后、claim 之前)做幂等有界 handoff —— `state='LEASED' AND claimed_by='legacy-push' AND batch_id IS NULL AND claim_expires_at <= now` 的行安全回 QUEUED(保留 notified_at)。**谓词只认 lease 到期**(R4-#1:R3 版的 `notified_at IS NOT NULL OR ...` 会把第二次 retry 的**未过期 active claim**(带上次的 notified_at)立即抢走,与正在执行的 legacy notifier 并发双投;已通知行的稳态本来就是 QUEUED,LEASED+已通知 = 恰是 crash 缝或 active retry,让其 30s lease 到期自然收敛,无需绕过)
5. **依赖声明**(R4-#3):`packages/inbox-mcp/package.json` 新增 `"flywheel-config": "workspace:*"` + `pnpm-lock.yaml`(pnpm 包边界不能吃 `flywheel-comm` 的传递依赖);inbox-mcp 独立 build/typecheck 作验证
6. retry window 判定改读 `COALESCE(m.notified_at, p.delivered_at)`(Step 1 已 backfill 存量行)
7. projection(`mailbox-schema.ts:145-148`):`delivered_at` 派生改为 **仅 ACKED → acked_at**(配合 Step 1 的 view 重建落地)
8. `delivery.ts` / `inbox-mcp/index.ts` 头注释改为新语义;**现役 QA 合同同步迁移**(R4-#4):`packages/qa-framework/suites/fly-60-hard-gate.md`(:49-58/:132-174 含 V1 crash-recovery 判据)、`packages/qa-framework/README.md:111`、`scripts/qa-fly-60-driver.sh:15-16` 中「notification 成功即 delivered_at」的语义全部改为「base `notified_at` = transport receipt;projection `delivered_at` 仅 ACK 后出现」,V1 的 timing/evidence 查询同步修正;加**静态残留断言**(测试 grep 旧定义指纹)防漂回

**测(先 RED)**(R2-#1 + R3-#1/#2/#3 收紧):
- **queue enabled**:instruction 只经 Flow 2 批投出,push notifier **零调用**(两条规则合同锁)
- **flag 热切**(R3-#2):真实 `applyFlagToggle` 改 `~/.flywheel/.env`、MCP 进程**不重启** → ON→OFF→ON 两次 lane 切换生效
- **legacy 状态机四景**(R3-#1,非真空):claim 后进程死 → 30s 后恢复重投;notify 成功后 record 前死 → 同上(at-least-once);重叠 poll → 第二个 poll CAS miss、notifier 恰一次;正常窗口过期 → **恰好重投一次**并重新隐藏(R2 版此景不可达,本版必须 GREEN)
- **attempt fence 竞态两组**(R4-#1):attempt A 超 TTL、attempt B 续取 → A 迟到 success/failure 均不得改变 B 的 lease(fence CAS `changes=0`);带旧 `notified_at` 的第二次 retry 中热切 ON → 不并发进 Flow 2,B 完成或 lease 到期后才收敛
- **FIFO 顺序 fence**(R4-#2):挂起 m1 的 notifier → 触发第二次 poll → **m2 notifier 零调用**;m1 失败 → 仍不送 m2;m1 成功结算 → 下一 pass 才投 m2
- **retryCutoff 语义**(R5-#1,非真空):同一行在 5s/30s 两种窗口下分别 claim/miss;SELECT 后另一 poll 刷新 `notified_at` → CAS miss;自定义窗口正常 expiry 仍只重投一次
- **顺序权威**(R5-#2):`created_at` 与 `seq` 反序行 + 同 `created_at` 行 → SELECT 与 CAS 均按 seq 一致推进;新 CAS `EXPLAIN QUERY PLAN` 命中 `(to_agent, seq)` 族索引
- **ON handoff**(R3-#3):旧字节 batchless LEASED 行 → 热切 ON → 被 Flow 2 投出;legacy notify 执行中切 ON → 无并发双副作用、最终收敛
- **QA 合同静态残留断言**(R4-#4):grep 旧「notify 即 delivered_at」指纹 = 零命中(阳性对照:注入一行旧定义变红)
- SELECT 后被 batch 抢占 → CAS miss → notifier 零调用
- notify 成功未 ack → projection `delivered_at IS NULL`;`flywheel_inbox_ack` 后 = acked_at
- 既有 at-least-once 断言全绿;legacy 分支外部行为兼容锁

## Step 4 — 病 2:未读不占位(cap = 真实传输背压)

**改**(`mailbox-queue.ts:1058-1068`,lead 分支)in-flight 计数谓词(R1-#2 修正版):

```sql
SELECT COUNT(DISTINCT batch_id) FROM mailbox
 WHERE to_agent = ? AND recipient_kind = 'lead' AND carrier = 'inbox'
   AND state = 'LEASED' AND batch_id IS NOT NULL
   AND COALESCE(notified_at, delivered_at) IS NULL
-- 语义:所有「尚未成功通知、仍冻结在 LEASED 的批」构成背压 ——
-- 覆盖 claim 中(claim_expires_at 未来)与 transport 失败 backoff 中
-- (recordLeadDeliveryFailure 清 claimed_by/claim_expires_at、留 batch_id+LEASED)两种形态;
-- 不设 claim_expires_at 条件(失败批该列为 NULL,设了就数不到 —— R1-#2 的洞)。
-- 已通知未 ack(notified 非空)不占位:忙只影响何时读,永不堵死能否投。
```

runner 子查询(:1078-1084)字节不动。`inflightMaxBatches` 默认 3 不动。

**改**(`lead-inbox-loop.ts:433`)header 文案:删「once 3 batches are unacked, no further batch will be delivered」,改为「ack promptly so the sender can see you received it; unacked batches are redelivered and eventually dead-letter」。

**测(先 RED)**:
- **8-13 事故复刻**:3 个 LEASED+notified 未 ack 批 → enqueue founder 消息(priority=1)→ tick → 新批 claim 成功、deliverBatch 被调、消息在批内。改动前必须 RED
- **传输背压阴性对照**(R1-#2 构造法):经**三次真实 `recordLeadDeliveryFailure`** 造出 3 个 backoff 失败批(不许手工造带未来 lease 的行)→ 第四批被挡;其中一批成功通知或进入终态 → 槽位释放
- ack lease 重投链不变:未 ack 批 lease 过期重投、≥leaseRetryMax DEAD、死信闸触发 —— 既有断言全绿

**点名的既有断言改动**:`mailbox-queue.test.ts` / `lead-inbox-loop.test.ts` 中断言「3 批 delivered 未 ack → 停投」的用例反转为「照常投」(该断言即病 2 本身);传输背压另立新用例。

## Step 5 — 病 3(进程层):Lead 判活接入 reconcile

**改**:
1. `mailbox-queue.ts:1477-1481`:删 lead 硬编码,统一 `input.recipientState(batch.to_agent)`(runner/lead 同路)
2. `lead-inbox-loop.ts:241-250`:`recipientState` 改为注入的 `opts.recipientState`(新可选 opt,缺省 `() => "alive"` 保兼容)
3. **判活 reader seam**(R1-#5):由 `LeadInboxRuntime` 在装配时**创建一次** lease reader、`close()` 时释放(`LeadLeaseStore` 构造有副作用 —— 建目录/WAL/迁移,严禁 per-tick 新建)。判定规则:
   - canonical `leadKey` 来源 = 装配该 loop 时的 lead identity(FLY-1726 canonical projection),不做二手推导
   - **只认 holder tuple**(`LeadLeaseRow` 的 holder pid+start;supervisor tuple 活着不代表收件进程活着 —— R1-#5):bound 且 holder tuple 有效 → `processTupleStateWithStart` → `alive→"alive"`,`dead|sensor_error→"unknown"`(hold:不重投不涨 retry,等 launchd 拉回或新代 adopt)
   - unbound / malformed / legacy 行、无 lease 行、读取异常 → **回退 `"alive"`**(保守:维持现状重投,避免 lease 基建未覆盖的 Lead 永久 hold)
   - PID reuse 由 pid+start_time tuple 语义天然防护
4. per-tick 判活结果缓存(runner lane 同款 Map,同 tick 多批只探一次)

**测(先 RED)**:
- lead 批过期 + `unknown` → 不重投、`lease_retry_count` 不变、`skippedUnknown` 计数(改前 RED:现状必重投)
- holder dead + supervisor alive → `"unknown"` hold(R1-#5 点名);恢复 alive → 下一轮照常重投;新代 `adopt-inflight` → `recipient_reborn` requeue(既有断言)
- unbound / malformed / 无行 / 读取异常 → `"alive"`,行为与现状逐字节一致(阴性对照)
- 同 tick 多批 → 探针恰一次;`close()` 后 reader 释放
- runner 分支断言全绿(共享函数等价锁)

## Step 6 — 病 3(registry 层):retired Lead 收尾 + 告警可达 founder

**改**:
1. **queue 能力:独立 scoped terminal sweep**(R1-#6 + R2-#3 定稿):不借用 `reconcileExpiredLeases`(其 LEASED selector 硬要求 `claim_expires_at <= now`,:1445-1449/:1488-1490 —— `recordLeadDeliveryFailure` 留下的 **NULL-lease** backoff 批和未来 ack-lease 批永远选不到,retired recipient 会占住 LIMIT 造成饥饿)。新增 `sweepRecipientTerminal(input: { recipientKind:'lead', toAgent, ownerEpoch, now, maxRows })`:owner fence + IMMEDIATE transaction 下,把该 recipient 的**所有** `state IN ('QUEUED','LEASED')` inbox 行 —— 含 NULL/future lease、legacy-push LEASED —— 按行预算置 `DEAD(recipient_terminal)`(复用既有 DEAD 字段语义 :1498-1510),返回 `{ dead, remaining }`
2. **收尾入口**:`LeadInboxRuntime` 暴露有界 `reconcileRetiredLeadMailboxes()`:
   - 活 roster = 每轮从 canonical projects 配置**重新读取的当前 Lead 集合**(不能用 Bridge 启动快照;新 Lead 可先收到 writer 入队再等 Bridge 重启)。显式 `FLYWHEEL_PROJECTS` env-pinned 部署以该静态值为本进程权威,且 fleet 工具拒绝对其做文件侧结构热改;读取失败、项目缺失或空集 → 本轮零 mutation,fail-closed
   - 候选发现 = **环形 keyset 扫描**(R3-#5:`enqueue` 不做 roster 校验,「retired 后不再有新行」不是不变量 —— 旧 writer 可持续向 retired id 灌行,或单个超大 backlog 每轮占住 LIMIT 头部;固定「每轮取 LIMIT 开头」会饿死后面的 recipient):复用 runner terminal scan 的既有环形 keyset 模式(`mailbox-queue.ts` `runnerTerminalScanCursor` 同款)—— 按 `to_agent` 稳定排序、持 cursor、到尾 wrap,SQL 侧继续 `NOT IN (live roster)`;每个候选调 `sweepRecipientTerminal`(行预算 `maxRows`)。cursor 保证 recipient 级公平推进,行预算保证单轮有界
   - **挂载位点 = `onReconcilePatrolTick`**(gate-poller 既有 ~60s mutation rider,带 pass-level single-flight —— R1-#6 指正;不塞进标为 pure-alarm-producer 的 `onLeadPatrolTick`,零新 timer)
3. **告警路由改道**(R1-#7):`lead_unacked` 死信候选现把 recipient 自己当 destination(`lead-inbox-runtime.ts:557-570`)—— retired Lead 必然 `unknown-lead` dead-letter,且 `settleDeadLetterAlertFromReceipt` 不辨 outcome 即置 accepted → **静默假绿**。修:recipient 不在活 roster 时,destination 改为**该 project 仍存活的 canonical Lead**(project primary;project 已无 Lead → fleet/founder 告警身份),title/body/source-key 保留原 recipient;30min 聚合(既有 `deadLetterWindowMs`)照旧

**测(先 RED)**:
- registry 有该 Lead → rider 零 mutation(阴性对照)
- registry 无该 Lead(QUEUED + 过期 LEASED + **真实 `recordLeadDeliveryFailure` 造出的 NULL-lease backoff 批** + 未来 ack-lease 批各有)→ 全部 DEAD(`recipient_terminal`)+ 零重投(改前 RED:QUEUED 行按现 API 无法处理、NULL-lease 批 expired selector 永远选不到 —— R1-#6/R2-#3)
- **反饥饿**(R2-#3 + R3-#5):首个 retired recipient 持远大于 `maxRows` 的 backlog **且每轮被继续 enqueue 新行** + LIMIT 收紧 → 断言后续 retired recipient 仍在**有界轮数**内被处理(keyset cursor 推进,不只证明有限小集合最终清空)
- roster 当前值包含启动后新增 Lead → 其 founder 消息保持 QUEUED;读取异常/空集 → 零 mutation;重入 → single-flight 挡
- **告警穿透真 notifier**(R1-#7):断言产出 founder-visible `sent|queued_durable` receipt、**无 `unknown-lead`** dead-letter;只断言 mailbox DEAD 或 intent 行存在不算过
- 多 retired Lead + LIMIT 有界:有限轮次内全部收敛(`remaining` 语义)

## Step 7 — 全链验收 + 收尾

1. **issue 三条验收各一条端到端用例**(loop+queue+ProtocolIngress 全链):
   - 复刻 8-13:3 批在途未读 + founder 新消息 → 下一 tick 照常投出
   - 真送达:receipt 成功未 ack → `delivered_at` NULL;ack → 落
   - 判活:terminal → DEAD+死信(真 notifier 收到)零重投;进程 dead → hold → 恢复后重投
2. 幂等阴性对照全链:duplicate ack、`ack_late_noop`、重投后旧 batch ack 迟到、`enabled:false` legacy 分支逐字节、push/batch 互斥(Step 3 四景)
3. **全仓 gate**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(host 全量按既有纪律,超时/环境项如实留证不伪报)
4. Codex code review(`codex:rescue`)循环至 APPROVED;PR 尾 commit 带 CLAUDE.md 里程碑 + doc 归档

## 8. Codex design review 折入记录

R1(七条,全接受):

| # | 指摘 | 处置 |
|---|------|------|
| 1 | claim 热路径三处 frozen 判定漏改 → 成功批被当 frozen 立即重投 | Step 2.3/2.4 统一谓词全量点名 + 热路径回归测试 |
| 2 | cap 谓词数不到 `recordLeadDeliveryFailure` 的 backoff 失败批(claim_expires_at 为 NULL)→ 无界开新批 | Step 4 谓词去掉 claim_expires_at 条件,改「LEASED+batch_id+未成功通知」;阴性测试用真实失败路径构造 |
| 3 | `CREATE VIEW IF NOT EXISTS` 旧库 no-op → 生产继续假盖章;`MAILBOX_ADOPTION_COLUMNS` 缺列 | Step 1.2/1.3 版本化 view 重建 + adoption 列 + 旧库测试 |
| 4 | push lane 无 ownership:batch 已 claim 行会被 push 双投;重投后 notified_at 不刷新 → 1s 重发风暴 | Step 3(R2-#1 后重写)single-lane + notify 前 CAS |
| 5 | lease 探针未定 tuple 选择(supervisor≠holder)、store 构造有副作用、unbound/malformed 未分类 | Step 5.3 reader seam(runtime 单例)、holder-tuple-only、形态分类表、回退 alive |
| 6 | lead 的 QUEUED terminal scan 按现 API 不存在;DISTINCT+内存过滤会饿死 retired;rider 位点错(onLeadPatrolTick 是 pure alarm) | Step 6(R2-#3 后重写)独立 sweep、SQL 排除活 roster、挂 onReconcilePatrolTick |
| 7 | retired Lead 死信告警 destination=retired 自己 → unknown-lead 黑洞 + receipt 假 accepted | Step 6.3 destination 改道存活 canonical Lead/fleet 身份;验收穿真 notifier 断言 receipt |

R2(三条,全接受):

| # | 指摘 | 处置 |
|---|------|------|
| 1 | ownership CAS 在 notify **之后**,挡不住已发生的双投副作用;且 queue-enabled 下 legacy push 仍与 Flow 2 抢投,违反两条规则合同 | Step 3 重写:queue-enabled 关停 content push(复用既有 flag);legacy 分支拆 `tryClaimInstructionForPush`(notify 前 CAS)+ `recordInstructionNotified`(成功后 fenced 写);测试断言 notifier 零调用 |
| 2 | view 重建丢存量 legacy-push 行的 retry-window 证据(base delivered_at 从未写,证据只活在旧 view 派生里)→ 部署即重发风暴;且 `ensureMailboxQueueSchema` 会收到无 view 的最小 schema,无条件 CREATE 会砸兼容入口 | Step 1.2 重写:DROP 前同事务幂等 backfill `notified_at = claim_expires_at`(严格限定 legacy-push 行);view 仅在「已存在且无新指纹」时重建;新增窗口内存量行测试 + 最小 schema 阴性对照 |
| 3 | retired sweep 借用 expired selector 吃不到 NULL/future-lease LEASED 批 → retired recipient 清不空,占 LIMIT 饿死后续 | Step 6.1 重写:独立 `sweepRecipientTerminal` 全形态(QUEUED|LEASED 含 NULL/future lease)预算化置 DEAD;真实 failure 路径构造 + 反饥饿测试 |

R3(五条,全接受):

| # | 指摘 | 处置 |
|---|------|------|
| 1 | R2 版 legacy push 状态机不可恢复:QUEUED-only CAS + 长驻 LEASED → 第二次重投永远 miss;claim→notify / notify→record 两个 crash 缝永久卡行;`claim_expires_at=now` 不隔离重叠 poll | Step 3.2 重写:稳态回 QUEUED(可见性靠 notified_at 窗口)、pre-notify claim 用 30s 真实 transport TTL、CAS 接受 QUEUED 或到期 self-owned claim 并重验窗口、record 时回 QUEUED 清 owner;四景 crash/重叠/重投测试 |
| 2 | `mailboxQueueEnabled` 只读传入 env;Lead 启动链 `env -i` 不传该变量;flag-toggle 只写 `~/.flywheel/.env`+Bridge 自身 process.env → inbox-mcp 拿不到热 OFF/ON | Step 3.1:inbox-mcp 每次 poll 从 `~/.flywheel/.env` dotenv_live 读(既有 readEnvFileSource/readEnvFileValue)再喂 helper;缺文件→enabled;read site 登记 flag registry;真实 applyFlagToggle 热切测试 |
| 3 | ON 切换后存量 batchless `LEASED/legacy-push` 行失联(batch claim 只吃 QUEUED、adopt/reconcile 只吃 batch_id 非空、push 已停,live recipient 无消费者) | Step 3.4 新增:lead loop tick 内幂等有界 legacy→batch handoff(已通知或 claim 过期 → 回 QUEUED 保留 notified_at;active claim 不接管);旧字节行热切 ON 测试 + 并发 notify 中切 ON 测试 |
| 4 | backfill 在 view 探测之前无条件执行 → minimal schema(缺 type/claimed_by/batch_id 列)UPDATE 直接报错 | Step 1.2 顺序改为「先探 view,不存在则整段结束(backfill 不 prepare)」;最小列集合阴性对照 |
| 5 | 「SQL 排除 + LIMIT 取头」不公平:超大 backlog / 持续被 enqueue 的 retired id 每轮占位;`enqueue` 无 roster 校验,「不再有新行」不是不变量 | Step 6.2 改环形 keyset cursor(runner terminal scan 同款):稳定排序 + cursor + wrap;反饥饿测试改为「持续新增行的超大 backlog 在前,后续 recipient 有界轮数内被处理」 |

R4(四条,全接受):

| # | 指摘 | 处置 |
|---|------|------|
| 1 | claim 回写不带 attempt fence:A 超 TTL 后 B 续取,A 迟到 success/failure 命中 B 的 lease;handoff 的 `notified_at IS NOT NULL` 分支会抢走第二次 retry 的未过期 active claim | Step 3.2 claim 返回 attempt fence(精确 claim_expires_at),record/release CAS 核对 fence;Step 3.4 handoff 谓词只认 `claim_expires_at <= now`;两组竞态测试 |
| 2 | 逐行 claim 让重叠 poll 越过在途 FIFO head(m1 在途时 pending 只见 m2 → m2 先送) | Step 3.2 CAS 加 DB 侧 FIFO 顺序 fence(不越过同收件人更早 seq 的在途/eligible 行;抗双 MCP 进程);挂起-m1 三段测试 |
| 3 | `packages/inbox-mcp` 无 `flywheel-config` 直接依赖,pnpm 边界吃不到传递依赖 | Step 3.5:package.json + lockfile 入改动清单;独立 build/typecheck 验证 |
| 4 | 现役 QA 合同(fly-60-hard-gate.md / qa-framework README / qa-fly-60-driver.sh)仍写「notify 成功即 delivered_at」,V1 crash-recovery 判据依赖旧语义 | Step 3.8 全部迁移到新语义 + 静态残留断言防漂回 |

R5(两条窄修正,全接受):

| # | 指摘 | 处置 |
|---|------|------|
| 1 | CAS 签名 `(id, now)` 缺 retry-window 输入(窗口是 inbox-mcp 的 `FLYWHEEL_INBOX_RETRY_WINDOW_SEC`,CommDB 不持有),mutation-time staleness 重验无法实现 | Step 3.2:caller 计算绝对 `retryCutoff` 传入;目标行与 FIFO `NOT EXISTS` 共用同一 cutoff 谓词;5s/30s 双窗口 + 并发刷新 + 自定义窗口 expiry 三组非真空测试 |
| 2 | FIFO fence 用 `seq`、pending SELECT 用 `created_at`,两套顺序可矛盾(反序行被 fence 卡死/顺序静默改写) | Step 3.2:顺序权威统一为 `seq`(durable insertion order),pending 改 `ORDER BY m.seq`,legacy「FIFO by created_at」断言点名合法 retarget;反序+同时间戳测试;`EXPLAIN QUERY PLAN` 索引断言 |

## 9. 风险与显式假设

| # | 风险/假设 | 处置 |
|---|-----------|------|
| 1 | 未读不占位后,从不 ack 的 Lead 收新批不间断 | 30s 是并箱横界而非限速;活跃 tick 最坏新批 ≤1/s,每批 ≤10 条/4MiB,重投 ≤1 轮/ack-lease,死信闸兜底。设计上接受(founder 拍板:堵死比灌爆更痛) |
| 2 | `COALESCE` 过渡读期间存量行为 | 仅影响部署时刻已 LEASED 的行,≤1 个 ack-lease 周期收敛;过渡读语义单测锁定 |
| 3 | 进程层判活误报 dead → 批 hold | hold 无损(不 DEAD 不涨 retry);恢复即重投。误报代价 = 延迟,无丢失 |
| 4 | registry 层误判 terminal → 活 Lead 批被 DEAD | 正常生产 roster 每轮重新读取 canonical projects 文件而非启动快照;env-pinned QA slot 使用其静态权威且禁止结构热改;读取失败/项目缺失/空集 fail-closed;DEAD 走死信有 founder 可见回执,可人工恢复 |
| 5 | 共享函数改动破坏 runner 路径 | research §5 红线 + Step 2/4/5 等价锁测试;runner 子查询/断言字节不动 |
| 6 | projection 改派生影响未知读者 | research §4 全仓矩阵;唯一行为读者(PENDING SQL)换真源,其余为注释/异表同名;view 重建带版本指纹幂等 |
| 7 | push lane CAS 让渡语义(被 batch 抢占时 no-op) | 消息仍由批路径投递,at-least-once 不破;测试锁定「恰一条 lane 投出」 |

## 10. 附录:封口时机(founder 提案「封口推迟到投递那一刻」,Lead 8-14 指令并入;Codex R7 四条已折入)

**先核实现状(以代码为准,Lead 要求)**:封口(成员定格)发生在 **claim 时刻**(`claimQueueBatch` UPDATE 置 LEASED,`mailbox-queue.ts:1157-1164`)。claim 之后、adapter 交接之前还有一段**异步缝**:loop 逐成员 `await revalidateModel`(`lead-inbox-loop.ts:322-363`,异步 Promise 契约,可能做 CommDB 查询/materialization)之后才 `deliverModelBatch` → adapter(:365-366/:459)—— 在这段缝里到达的新消息**不会**被吸入本批(进下一批)。Tadashi 对 founder 说的「攒批即封口,10条/30s」与代码一致,需补两个澄清:
1. **30s 是以 head 为锚的并箱横界(FLY-1751 用语),不是等待窗**:窗口 = `[head.created_at, head.created_at + batchWindowMs]`(:1100-1102),只筛「claim 时已在队列里」的消息;系统**不会为凑批等 30 秒**。活跃 Lead(1s tick)下批经常只有 1-2 条
2. **成员还要求同发件人、同 msg_class、同 retry 代**(:1110-1118;Discord 批再按频道分区,另有 4MiB byte cap):「持续吸新消息」天然限于同源同代消息

**合同裁定(R7-#2,需 founder 知悉的边界)**:本设计采用 **「原子 claim = durable 封口 = 投递尝试的起点」** 语义 —— seal 前的 QUEUED 池是 open cohort(持续吸新),claim 一发生成员即定格,claim 后到达者进下一批(deferred-revalidation 测试锁定)。若要字面上的「直到 adapter 交接那一刻才吸收」,必须新造可 crash-recover 的 OPEN→SEALED 两阶段机制(durable handoff 证据、扩员对账)—— **不在本单做**:该缝健康路径通常很短且正确性不依赖其时长,拒绝的依据是 durable 复杂度与 crash 歧义,收益配不上机制成本。

**提案与「未读不占位」(Step 4)的合成语义**:两机制是同一张图的两半 —— Step 4 保证**投递永不被未读堵住**(封住 8-13 事故);封口即投递起点保证**被迫等待期间堆积的消息在解锁后尽快大批打包**。精确恢复时序(R7-#4 + R8 措辞):失败批消耗传输槽,**达到 cap(3)才阻止新批**(单个失败批不全停);恢复后,若 frozen 批已到 `next_retry_at` 则下一 claim 优先重发它(原成员),否则 fresh claim 仍可先行;frozen 结算后的 fresh claim 把堆积 backlog 并成新批(受上限与同源/同代/分区/横界/byte cap 截断;顺序 = `priority, seq`)。

**本单裁定(R8 实现校准)**:issue 终稿的直接合同是「攒 10 条 / 30s」且 Flow 1 零变化,因此**不采用**附议中的 Lead=30 参数变更。Lead 与 runner 默认上限均保持 10;30s 仅作为以 head 为锚的并箱横界。若未来要把 Lead 上限改为 30,应另开参数变更单并单独评估活跃 1s tick 下的 pane 流量。

**两条工程约束的落点(Lead 点名,必须守住)**:
- **① durable batch-id 重投语义不破**:唯一「同批重发」是 **frozen resend**(传输失败重投,`#r{attempt}` 后缀、原 batch_id 原成员冻结)—— **保持冻结不重开吸新**(吸新破坏 adapter dedupe 与签收对账)。ack-lease 过期重投:回 QUEUED 清 batch_id **且 `lease_retry_count`+1**(:1539-1548)→ 重组为**新 batch id、原代成员同批**;因 fresh SELECT 的同代筛选(:1113),**不会**与新到的 generation-0 消息合批(R7-#3 更正:此前「可与新消息合批」的说法不可达,已删;跨代合批 = 新的 retry/幂等机制变更,不做)
- **② 上限 + 顺序保持**:成员 SELECT 本就 `ORDER BY priority, seq` + LIMIT(:1119),上限改 30 不动顺序;同代筛选照旧

**新增测试(R7/R8 收紧)**:11 条**同 sender/同 priority/同 partition/同代/横界内/小 payload** 的 Lead 堆积 → 首批恰 10 条、下一批 1 条;混合 priority → 断言 `priority, seq` 顺序;runner 阴性锁:默认配置下 11 条同代 runner instruction 首批仍恰 10;deferred-revalidation:claim 后到达的消息进下一批;frozen resend 不吸新(阴性对照);ack-lease 重投 = 新 batch id + 原代成员同批 + 新代消息另批(既有语义锁)。
