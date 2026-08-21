# FLY-1795 runner lane ACK 饿死 — 实施计划(v2 极简版)

Issue: FLY-1795 (https://linear.app/geoforge3d/issue/FLY-1795/消息层bug-某个-runner-lane-的收件永不-ack-3-个-in-flight-槽被占死后续指令按租约每-10)
日期: 2026-08-20
基于: one-pager-minimal.md(founder 已批)、exploration.md / research.md 的审计事实(全部沿用)

> **v2-R9 amendment(2026-08-20,Lead 裁决 + R8 review)**:设计评审 findingKey=`frozen-exit-retry-count-budget-collision` 以代码实证推翻原「复用 `retry_count`」选择:`retry_count` 已同时承载 runner `maxAttempts=6`、Lead `maxModelAttempts=5` / `unavailableRetryMax=55` 的真实投递失败预算,再拿绝对值与 `leaseRetryMax=3` 比较会把合法重试后的下一次 crash 静默判 DEAD。Tadashi 裁决改用既有 `last_error` 的严格命名空间 `delivery_unconfirmed:N` 记录**连续** frozen expiry;零 schema,任何真实 transport error 文本无条件覆盖 marker,`retry_count` 与 `lease_retry_count` 在 frozen 周期均不变,transport id 继续稳定 `#r0`。R8 review 又发现旧 frozen UPDATE 不清 `claim_expires_at`,同一过期行会每 tick 重复命中;R9 要求 marker UPDATE 同时置 `claim_expires_at=NULL`,故只有一次实际 reclaim 重新设 lease 后才可能推进下一轮。此 amendment 取代下文任何旧的 use-`retry_count` / per-tick 口径。

## 0. 版本裁定依据(为什么这份 plan 取代之前的一切)

* **v1 复杂版 plan**(R6 Codex APPROVED,git 历史 blob 3936ed2f)被 founder **整层打回**,逐字裁定:「整个设计层需要完全重新思考。我觉得现在整个设计得太复杂了。我们一直以来的理念就是要尽量的简单和 generic,但现在的设计非常琐碎、非常复杂。这其实有可能会带来更多的麻烦,而不是益处。」并点名否决自动收尾钩子(错签风险)与整个 dwell 告警层(watchdog 洪水史)。
* **`design-correction.md`**(实现期中间修正:0a 精确 ID 绑定 + 零主动告警)同被整层打回覆盖:其「零主动告警」方向在本版保留;其 0a 精确绑定路线作废——本版用「投递即销账」结构性消除错签面(没有独立签收动作,就没有可签错的账)。
* **v2 极简一页纸**经 Tadashi 转呈,founder 批准(原话「可以」);read-signal 之问的回答见已交付 HTML 第③节(design-report-v2.html,https://fw-reports-a53de2.vercel.app/r/a016f562e863015112c938c107c69d00/)。

## 1. 问题(一句话)

给 runner 发的消息投递成功、runner 也照做了,但销账要等 runner **自己想起来**跑一条命令——不跑,3 个 in-flight 槽被同一批消息永久占住,后面的指令每 10-30 分钟才漏一条(复发 ~20 分钟量级,曾阻塞三条产品线)。

## 2. 改动清单(核心两处 + 裁定追加三处)

### 改动 1:投递成功即销账(runner lane)

位置:`packages/flywheel-comm/src/mailbox-queue.ts` — `recordBatchDelivered` 的 **runner 分支**(经 `recordRunnerBatchDelivered` 调用;现 ~1382-1433 行)。

现状:transport 成功后该 UPDATE stamp `delivered_at` 并续 `claim_expires_at`,行**停留 LEASED** 等自愿回执。
改后:同一笔 UPDATE 直接终态——`state='ACKED', acked_at=COALESCE(acked_at,:now), notified_at=COALESCE(notified_at,:now), delivered_at=COALESCE(delivered_at,:now), last_error=NULL, claimed_by=NULL, claim_expires_at=NULL, next_retry_at=NULL`。**原有的精确圈定与 owner 栅栏一字不动**(`WHERE batch_id=? AND recipient_kind='runner' AND state='LEASED' AND claimed_by=:ownerEpoch`)——销的恰好是刚送出的那几行,无扫描、无时间窗、无相邻行,错签面结构性不存在。

**settle 谓词(R1 BLOCKER-1/2 收窄,正确性边界)**:终态化只适用于「**完整正文已 durable 进入该 backend 的实际 session 消费面且销账后仍可取**」的投递结果——今天满足此契约的是 **Claude Agent Team adapter**(成功返回发生在邮箱正文原子写入并验证之后,`wakeRunnerMailbox` verified write)。**Codex 与 `no_transport` 分支逐字节保留现状**:
* Codex 的 `deliver()` 成功只是外部 JSON carrier 写入(`CodexAdapter.ts:121-172`),doorbell 由 watcher 之后异步落库;若行先 ACKED,doorbell 走 `already_settled` 不建 wake、普通 `inbox` 查询又排除 ACKED ⇒ 正文从消费路径消失。故 Codex 维持既有「pull/doorbell 消费后销账」,emission 记账由改动 2 覆盖。
* `no_transport`(vendor=none / backend=commdb,`runner-mailbox-lane.ts:53-76` resolve 非失败)= 从未推送,**零终态化**,保留既有 pull 契约。
若未来要 Codex 也投递即销,必须先把它的交付边界改到 doorbell/session admission 完成之后并证明销账后正文仍可取——那是另一单,不在本 plan。

**typed settle disposition(v2-R2 BLOCKER-1:谓词必须由「实际执行写入的 adapter」编码,不能靠调用前猜测)**:现状 `RunnerMailboxDeliveryResult` 只有 `delivered|no_transport|failed`,`wakeRunnerMailbox` 不返回实际 adapter,且 `sessions.vendor` 允许 NULL(legacy 行由 `fromEnv()` 现场选 Claude **或 Codex**)——仅凭 `status:'delivered'` 判终态会误签 Codex 或漏签 legacy Claude。契约:delivery success 必须携带 `settlement: 'on_delivery' | 'on_consume'`(可附 actual backend 供诊断),值由**实际创建并成功写入的 adapter** 返回——actual Claude verified write → `on_delivery`;actual Codex → `on_consume`;`no_transport`/`failed` 保持独立 variant。lane **只在 `on_delivery`** 调 terminal UPDATE;类型上让缺 disposition 的 `{status:'delivered'}` 无法编译(mock/未来 adapter 不能静默落成 terminal)。这是 typed outcome,非新持久化机制。

**post-delivery 行为矩阵(v2-R2 HIGH-2:四行钉死,测试逐列断言 state / delivered_at(or notified_at) / claim_expires_at / 下一 tick 是否再投)**:
| 结果 | 行为 |
|---|---|
| actual Claude,`on_delivery` | ACKED,terminal 字段齐(本 plan 的改动 1) |
| actual Codex,`on_consume` | **现状原样**:`recordRunnerBatchDelivered` 非终态 UPDATE(stamp notified/delivered + 续 lease,保持 LEASED),消费后经既有 pull/doorbell 路径销账 |
| `no_transport` | **仍调用同一非终态 recorder(现状)**——它防止下一次 claim 立即重取同一 frozen batch;其 stamp 语义明写为「正文已可用于 pull surface 的 emission」(carrier availability),pull 时 `ack()` 的 COALESCE **不会**把时间改成 pull 时刻——账上讲的是「何时可取」,与「一条 SQL 讲清路径」口径一致 |
| `failed` | 现状 failure/retry 原样 |

连带(同一改动的组成部分,非新增机制):
* batch envelope 文本删除「You must ack this batch (…)」一句(`runner-mailbox-lane.ts` 的 `renderRunnerMailboxBatchEnvelope`,~176-184 行)——没有要 runner 履行的回执义务了。
* **lead 分支零改动**:`recordLeadBatchDelivered` 与 lead lane 的 ack 契约逐字节不变。

### 改动 2:任何销账至少留下送出时刻(pull 记账)

位置:`packages/flywheel-comm/src/mailbox-queue.ts` — 单行 `ack()`(现 ~2306 行)。

改后:该 UPDATE 增加裸表列 `mailbox.delivered_at=COALESCE(mailbox.delivered_at, :now)`(不覆盖更早的章)。效果:runner 主动来取(`inbox` CLI / gate 轮询 `consumeGateResponse`)、bridge 协议行自答等一切经 `ack()` 的销账,裸表账上从此必有送出时刻——「拉取消费」与「静默丢弃」不再同形。语义明写:这里的裸表 `mailbox.delivered_at` = **送出那一刻**(emission),不是「被看见」;`mailbox_message_projection.delivered_at` 目前由 ACKED 行的 `acked_at` 派生,本单**有意不改投影版本/SELECT**,也禁止用它验证 emission。「runner 已读」的判据仍然只有远端产物逐字引 id 的对账,不变。

**覆盖面收口(R1 HIGH-4)**:`ack()` 之外,现存**投递/消费类**直接 ACK 写点还有两处,同样各加一列 COALESCE(同性质的一行字段变化,非新机制):① `enqueueRunnerPhaseWake` 的 source-instruction UPDATE(durable-accept 即投递,merge-base `db.ts:2894-2902`);② `inbox-check.sh:84-86` legacy 裸 SQL(它注入内容即投递)。**验收范围如实限定**:「任一销账行 delivered_at 非空」只对**部署后经投递/消费路径**销账的行成立;明确不覆盖——历史已 ACKED 行(不回填)、处置类 ACK(如 `finalizeSession` 收尾清账,那不是 emission,不伪造章)。验收 SQL 带部署时间下界。

### 改动 3:从未投递的有界退出(2026-08-20 活体证据,Tadashi 指令;零新层)

实证(HL 06:09,1911/1851 双 lane):幽灵 carrier(`claimed_by=89a82153`,非任何活 session/进程)占满两 lane 全部槽——「领取→从未执行投递→租约到期→再领取」20 分钟循环、`last_error` 与 `delivered_at` 全空、零 ACK。**机制根源**:`reconcileExpiredLeases` 的 **frozenResend 分支**(全员 `notified_at`/`delivered_at` 皆空 = 从未投递的批)只清 `claimed_by` 保批重投,**不递增 `lease_retry_count`** ⇒ `leaseRetryMax` 永不触发,无限循环。改动 1 的送到即销治不了「从未送到」。

修法(在既有 reconciler 分支内,复用既有列,零新层)。**计数面选型(v2-R8 HIGH 修正:两个 retry counter 都不能复用)**:两 lane 的 transport 去重 id 都由 `lease_retry_count` 派生(runner envelope `${batch_id}#r${lease_retry_count}`、lead `${batchId}#r${attempt}`),frozen 周期递增它会把 crash-window 重试伪装成新消息,破坏 adapter 去重;`retry_count` 又已承载 runner 6 次与 Lead 5/55 次真实 transport failure 预算,比较或递增它会在「合法失败重试 + 一次 crash」混合路径中过早 DEAD。故两个 counter 在 frozen 周期**都保持不动**。

**连续 frozen marker(Lead 裁决,R9 tick 隔离)**:只在全批 `notified_at=delivered_at=NULL` 的过期分支里使用既有 `last_error` 严格命名空间 `delivery_unconfirmed:N`。合法文法精确定死为大小写敏感、无空白、全串锚定的 `/^delivery_unconfirmed:([1-9][0-9]*)$/`;捕获值还须 `Number.isSafeInteger(N) && N > 0`。`:0`、溢出、带前后空白、额外后缀(即使以 `delivery_unconfirmed:` 开头)全部非法。若全批成员都带同一合法 marker,下一 **new-lease expiry** 取 `N+1`;任一成员为 NULL、真实错误文本、非法/不一致 marker,均从 1 重新起算(方向上宁可多投递,不误杀)。

未达阈值时全批单笔 UPDATE 原子写同一 marker、`claimed_by=NULL, claim_expires_at=NULL`,保留 batch membership;`claim_expires_at=NULL` 使该批仍可被 frozen reclaim 立即领取,但在真正 reclaim 重新写入未来 lease 前不再满足 reconciler 的 `claim_expires_at <= now`,所以 marker **每个新领取租约至多推进一次**,绝不按 tick 推进。`claimQueueBatch` 的 queue-enabled frozen reclaim 改为**完全保留当前 `last_error`**(不再写 `last_error=NULL`):合法 marker 留作下一轮证据;若历史/异常行带真实 error,它也保留到真实 transport 结果或下次 expiry,不伪造 clean streak。随后任何真实 transport failure writer 无条件写真实 error text并覆盖 marker;成功 delivery recorder 继续 `last_error=NULL`。同形的 legacy `claimLeadBatch` reclaim 仍清 `last_error`,但它只在 queueConfig disabled 时运行、而本 reconciler 只在 enabled 时运行,故有意不动并以 census/静态守卫钉死。默认 max=3 ⇒ 第 1/2/3 次**各自有新领取的** clean expiry 分别写 `:1/:2/:3`,第 4 次 DEAD;`leaseRetryMax=0` ⇒ 首个 eligible expiry DEAD。全程 `retry_count` / `lease_retry_count` 不变,transport id 稳定 `#r0`。

**writer/reader census(v2-R8 修正)**:`retry_count` writers 包括 `recordRunnerDeliveryFailure`、`recordRunnerBatchDeliveryFailure`、`recordLeadDeliveryFailure`;readers 包括 runner `deadLettered` 判定、Lead question materialization、`maxModelAttempts=5` 与 `unavailableRetryMax=55` attempt 判定。因为 frozen path 不再读写它们,原行为全部保留,先前计划的 `lead-inbox-loop` materialization predicate 改动**撤销,不实施**。

**命名诚实(v2-R3 BLOCKER-2)**:`dead_reason='delivery_unconfirmed_exhausted'`(新枚举值,非新列)——**不叫** delivery_never_executed:`notified_at=delivered_at=NULL` 只证明「delivery record 未提交」,不证明「transport 从未执行」(Claude/Codex durable 写成功后、CommDB recorder 提交前崩溃,留下的行与 ghost-before-I/O 完全同形;既有同批重投幂等正是为这个 crash 窗设计,保留)。

**终态迁移原子定义(v2-R3 HIGH-4)**:达阈值的 DEAD 是**全批同一原子结果**(不得部分 DEAD 部分 resend),单笔 UPDATE 齐设:`state='DEAD', dead_at=:now, dead_reason='delivery_unconfirmed_exhausted', last_error=同值, claimed_by=NULL, claim_expires_at=NULL, next_retry_at=NULL, batch_id=NULL`;计入 `result.dead`,**与 `result.frozenResend` 互斥**(「保批、清 claimed_by」只描述未达阈值的 resend 路径)。`recipientState='unknown'` 的 fail-closed skip **保留** ⇒ 有界退出只承诺 known-alive recipient(见 §7 风险 5 与 T8 阴性对照)。正常路径(投递在 N 个周期内真实发生)不受影响。

**该 DEAD reason 不入既有主动死信链(v2-R4 BLOCKER-2)**:现有两个扫描器只按 `state='DEAD'` 选行无 reason 过滤(`scanAndInsertDeadLetterNotices` 主动给 owning Lead 发 `dead_letter_notice`;`listUncoveredLeadDeadLetters` → durable alert intent → `mailbox_dead_letter` notifier)。实核前者已有「每收件人每 30 分钟至多一条」的限流与聚合摘要,因此这里**不再声称逐行洪水**;排除的依据是 founder 对本版的更强裁定——`delivery_unconfirmed_exhausted` 只允许 query-only,不得新增或复用任何主动推送面。定稿:生产代码导出一个与现有 `CHAT_DELIVERY_UNCONFIRMED_REASON` 明确区分的单一常量 `FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON='delivery_unconfirmed_exhausted'`;writer、两个扫描器全部 9 条 eligibility SELECT(recipient ring / aggregate / summary)与静态守卫都引用这一常量。SQL 统一使用 null-safe 精确谓词 `dead_reason IS NOT '${FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON}'`(不得用裸 `<>`——会顺带排除 legacy `dead_reason IS NULL` 的行)。代价如实接受:若发送方没有保存 message id 并主动运行改动 5,这一类死亡对它**零信号**;其他既有 DEAD reasons(含 NULL)行为逐字不变。阴性测试:routable runner / unroutable runner / lead 三种目标各证零 notice、零 alert intent;**mixed-recipient 用例(v2-R5 HIGH-3)**:同一收件人同时有普通 DEAD 与 excluded DEAD → 普通 reason 照常通知,excluded 不入 count/through-seq/summary 渲染。静态守卫逐条枚举两个方法内所有 `state='DEAD'` eligibility SELECT,漏 predicate 即失败。

**lane 范围(Tadashi 裁定 = 分叉2(i),both lanes)**:幽灵证据本就双 lane,frozen-exit 语义对称——改动 3 作用于共享分支的 **lead 与 runner 两 lane**;lead lane 的**投递/ACK 状态机契约**不变,但 production diff 允许三类显式例外:共享 frozen-exit 分支、queue-enabled `claimQueueBatch` frozen reclaim 保留 `last_error`、共享 `ack()` 的 emission-only `delivered_at` COALESCE。佐证(HL 追加):体积已排除(卡住的行比送达的还小,不查大小);该队列实测为死亡排空(~3 条/小时判死,积压大概率静默丢失而非最终送达);runner 活着投递照样不发生 = 投递侧执行从未发生的又一证。

### 改动 4:接收方可见消息写入时刻(Tadashi 裁定条件②,纯显示零机制;v2-R4 HIGH-4 定语义)

两个 surface 分开定义(**绝对 `created_at` 永远展示,它才是最终事实;相对文案只是注解**):
* `inbox` CLI 渲染:相对超龄按 **pull/render 时刻**计算(动态,合法)。
* durable batch envelope:相对文案标为**「打包投递时的年龄快照」**(如「入队于 HH:MM,打包时距创建 N 分钟」)——envelope 是静态载荷,adapter 按 `flywheelId` 去重且幂等命中保留首份内容,不能把快照描述成读取时年龄;lane 每个 envelope 只 capture 一次 `now`。测试:渲染含绝对时刻+标注;重试/幂等命中下文案不被误解为当前年龄(含 B1 的 crash replay 场景);零状态/投递行为变化。

### 改动 5:死信对发送方可查(HL 死亡排空证据;founder 禁推送——查询态;v2-R4 HIGH-3 钉死 seam)

* **seam 定死**:扩展既有 `MailboxQueue.inspectDeliveryState`(已按 exact id/delivery_id 查 live 裸表行 + 经 `mailbox_identity` 与归档快照跨 72h 读终态),返回值补裸表证据 `dead_reason / last_error / created_at / delivered_at / notified_at`;绝不经 `mailbox_message_projection.delivered_at`。`search` 命令是 tmux pane 抓取器,**不是**可复用面(实现期不留分叉)。
* **薄 CLI**:`flywheel-comm message-status <message-id> [--json]`,`CommDB.openReadonly` 打开(查询绝不触发 migration/purge/ACK);输出三态 `live | archived | absent`(exit 0/0/1,JSON 带 state/dead_reason/stamps);DB 错误非零。
* **访问模型如实**:exact-id **capability**(持有 id 即可查),不是身份授权——与 §6.0 本地信任边界一致;不声称「只能查自己的」(caller 报的 --from 证明不了归属,不做假承诺)。
* 测试:live frozen marker、live DEAD、archived DEAD、unknown id;live/archived 都断言 `last_error` 与裸表 stamps;查询前后 DB 快照零变化。**明确不做**:任何推送/通知/扫描层。

### 净帐

**删**:runner lane 的「等回执」状态、自愿回执契约、envelope 回执指令、以及 v1 为它们准备的全部机制(钩子/告警层/新表/新列/召回命令——一概不做),外加 Step 0 对分支上 v1 残留的确定性清账。**加**(裁定后完整账本):1 处终态化(Claude `on_delivery` 分支)+ typed settle disposition wiring + 3 处 emission COALESCE(ack()/phase-wake claim/legacy hook)+ frozen-exit `last_error` streak(含 `claim_expires_at=NULL`)与 DEAD 口径 + queue-enabled frozen reclaim 保留 `last_error`(共享双 lane)+ 单一 reason 常量与两扫描器 eligibility exclusion + 渲染层 created_at/年龄快照标注(纯显示)+ 发送方死信只读查询(inspectDeliveryState 扩展含 `last_error` + message-status 薄 CLI)。无 schema 迁移、无新配置、无新表、无新列(dead_reason 新枚举值除外)、无任何推送告警。

## 3. 为什么够了

* 主病 = actual-Claude runner 槽在等一个可能永远不来的回执 → 改 1 后该路径**没有回执可等**,这一条路径上的楔死类别消失。Codex / `no_transport` 仍依赖既有 pull/doorbell 消费,不在此覆盖承诺内。
* 副病 = 账上分不清拉取消费与静默丢弃 → 改 2 后同形消失,一条 SQL 出答案。
* 回执在 runner lane 上买到的主要保证(正文已进入消费面),由 Agent Team 的 verified durable 写提供;**不再声称「下一 turn 必然渲染」**。仓内 `mailbox-prune.ts` 已注明 stock `useInboxPoller` 存在 read-then-mark-all 竞态,可能「durable 写成功但正文未渲染」;投递即销会移除旧 lease 重投兜底,这是 founder 批准的明确赌注,列入 §7 风险并由 T3 负向记录。已证事实:pull 是合法投递(物证 inbox-200205.txt);重投对「没在看」实测无效(22-176 分钟硬卡里重发从未唤起阅读),对死 session 更救不了——救济一直是换工人(FLY-1628 域),本改动不动它。

## 4. 不做什么

| 不做 | 依据 |
|---|---|
| Stop hook 机械回执(任何形态,含精确 ID 绑定) | founder 点名错签风险;改 1 后无存在理由 |
| 任何主动告警(dwell/禁令/episode/outbox) | founder 整层否决(watchdog 洪水史);且「占槽超时」对象已不存在 |
| mailbox_transitions / 新列 / replay 命令 | v1 复杂度主体,全砍;正文本体 72h 存活 + 归档 row_json,永不因销账消失,找回命令另议 |
| lead lane 的投递/ACK 状态机契约改动 | Lead 回执在用且 ~3min 自愈,烦恼非事故,另日再议;允许的非契约差异只有共享 frozen-exit、queue-enabled frozen reclaim marker 保留、共享 `ack()` emission stamp |
| 拦/清 QUEUED 类机制 | pull=合法投递已物证定案,该类修法砍合法投递,禁选 |
| 租约/攒批/in-flight 参数 | 一概不动 |

## 5. 实施步骤(TDD)

**Step 0 — v1 残留的确定性清理(R1 BLOCKER-3,取代先前「revert 或无视」的模糊表述)**:分支相对 merge-base `ff0fa64f4`(实现时重新验证唯一 merge-base)仍带 ~50 文件、+4198/-182 的 v1 机制差异(transitions 表、first_delivered_at/acked_via 列、late-ACK 与 stop-hook API 如 `ackDeliveredRunnerInstructionsThrough`、replay 命令及其测试);冻结 commit `54961692d` 只拆了告警层——**无视它=在半拆 v1 上续建,单独 revert 它=把已删的告警层复活,两者都违反净帐**。确定性动作:以 merge-base 为 functional baseline,列账并删除全部 v1-only 生产机制与测试,再只重施本 plan 的最小 delta。**PR 硬门**:
1. rejected-artifact 零命中清单(stop-hook 机械 ACK / late-ACK / transitions·审计 schema / 告警·outbox·episode·inhibition / replay)——生产源码与测试 grep 零;
2. lead lane 的投递/ACK **状态机契约**零变化;production diff 只允许三类已列明例外(v2-R9):① 共享 reconciler 的 frozen-exit 分支;② queue-enabled `claimQueueBatch` frozen reclaim 保留 `last_error`;③ 共享 `ack()` 的 emission-only `delivered_at` COALESCE(不改 state/claim/真实 transport retry 语义);legacy `claimLeadBatch` reclaim 有意零 diff;
3. production final diff 闭集清单:超出「runner settle 谓词 + typed disposition、envelope 文本、三处 emission COALESCE、frozen-exit `last_error` streak/`claim_expires_at=NULL`/DEAD + queue-enabled frozen reclaim marker 保留(共享双 lane)、单一 reason 常量与两扫描器全部 eligibility exclusion、渲染 created_at/年龄快照标注、inspectDeliveryState 扩展含 `last_error` + message-status CLI、必要测试与守卫更新」的任何生产改动 fail-closed。
(历史设计文档保留;约束的是生产代码与测试。)

**Step 1 — 改动 1(RED→GREEN)**:
* T1:**actual Claude `on_delivery`** → 该批行在同一事务内 ACKED(acked_at/delivered_at 齐,claim 清空);owner 栅栏不匹配 → 零行(现有 lost_race 语义保留);Codex `on_consume` / `no_transport` 同组阴性对照 → 保持 LEASED 直至既有 consume 路径销账(post-delivery 矩阵逐列断言)。
* T2:transport 失败 → 行保持 LEASED,重试/requeue 路径逐字节不变(负对照)。
* T3:**「假报成功」语义测试(founder 之问的赌注,钉死;R1 修正为真实 adapter 边界用例,不是源码顺序断言)**:(a) Claude:mock adapter 在 durable 写入前抛错/返回失败 → 零销账;durable 写入成功 → 终态且正文销账后仍可从 session mailbox 读取;另以具名负向用例记录 stock poller 仍可能在 durable 写后、渲染前 mark read——本改动接受该竞态且没有 lease 重投兜底,测试不得把 mailbox 可读偷换成「模型必然看见」;(b) **Codex carrier 写入成功但 watcher 未回调 → 零终态**;doorbell admission 失败/无 consumer → 零终态;(c) **`no_transport`(vendor=none / backend=commdb)→ 零终态**,既有 pull 路径原样可取(两个非 vacuous 负测);(d) **nullable vendor 两边界(v2-R2)**:vendor=NULL + env/默认实际选中 Claude → `on_delivery` 终态;vendor=NULL + env=codex → `on_consume` 零终态——disposition 必须来自实际写入的 adapter,不来自调用前 vendor 猜测。
* T4:envelope 文本不再含回执指令;lead 分支快照逐字节不变。
* T7:in-flight 门行为:**Claude `on_delivery` 批**销账后门不再因其阻塞;Codex/no_transport 批照旧计入门(现状);突发断言按真实上界(单批大小 × adapter 延迟 × maxPerTick)。
* T8(改动 3,lead 与 runner 各一组):幽灵 carrier 仿真——领取后 delivery record 持续未提交,连续 clean **new-lease** expiry marker 达阈值后转 DEAD 且 `dead_reason='delivery_unconfirmed_exhausted'`,全批原子、result.dead 与 frozenResend 互斥;**tick 隔离回归(R8 HIGH)**:同一收件人同时放 3 个 frozen 批,第一次 reconcile 后不 reclaim 其中后两个,连续跑 N 个 tick——其 marker 必须停在 `:1`、不能推进/DEAD;只有分别实际 reclaim 写入新 `claim_expires_at` 且该新 lease 再过期后才到 `:2`。**三 adapter crash-dedupe逐字验收**:lead / Claude runner / Codex runner 各自——adapter durable accept → recorder 提交前崩溃 → frozen expiry 写 marker + 清 lease → 重投命中**同一 transport id**(`#r0`),sink 恰好一份,并显式断言 frozen 周期中 `retry_count` 与 `lease_retry_count` 均不变。**碰撞回归(v2-R8 HIGH)**:先构造真实 transport failure 合法消耗 runner/Lead `retry_count` 预算,再发生 recorder crash/frozen expiry——真实 error 保留至 expiry 后才被 `:1` 替换,该批不得因 `retry_count >= leaseRetryMax` 被 frozen-exit DEAD,只有随后连续 N 次 clean new-lease expiry 才终态;周期内真实投递发生 → marker 清空且计数路径不触发(负对照);完全保留 `last_error` 的 queue-enabled reclaim 与仍清它的 dormant legacy reclaim 各有静态/行为对照;marker 文法逐项对抗测试(`:0`/overflow/空白/后缀/大小写/成员不一致都从 1 fail-open 重计);`leaseRetryMax=0` 边界;`recipientState='unknown'` fail-closed skip;未达阈值保批、清 claim 与 lease。

**Step 2 — 改动 2(RED→GREEN)**:
* T5:`ack()` 销账后 `delivered_at` 非空;已有更早章不被覆盖(COALESCE);全部现有 `ack()` 调用方测试照旧全绿;phase-wake claim 与 legacy hook 两处 COALESCE 各一条路径测试。
* T6:codex runner 路径(doorbell/pull)行为不变;`consumeGateResponse` 消费后账上有送出时刻;处置类 ACK(finalizeSession 等)不因本改动获得伪造 emission(负测)。

**Step 3 — E2E 正对照(issue 验收)**:构造永不主动销账的 **Claude** 消费者(只有 Claude 能不 pull 就拿到正文并执行),连发多批 → 全部按投递节奏销账,零楔死、零饿死、队尾不饥饿;LEASED 停留时长 ≈ transport 窗(作**度量**,无告警)。Codex/no_transport 阴性对照分两组:消费者按既有 pull/doorbell 路径取信 → 照常销账;消费者永不 pull → 仍会占满 in-flight,按既有 ack lease 节奏重投并最终 `lease_expired_unacked` DEAD/进入既有死信链,**不得**误写成改动 3 能兜住。
**Step 3b — ghost 有界退出验收 + 残余风险显式记录(v2-R3 BLOCKER-1 后 Tadashi 裁定 = 分叉1(b),措辞不得静默降格)**:本 plan **不承诺**「撤销令 B 绝不早于被撤销指令 A 生效」——Codex 以可执行反例证明:ghost 持有的 A 在租约未到期时既不可回收也不占 in-flight,B 会先被 claim 投出,A 随后重投即倒挂;改动 3 只保证 A **有界退出**,挡不住租约窗口内的越过。**残余风险显式记录**:租约窗口内的到达序倒挂仍可能发生;撤销/新鲜度排序语义属 FLY-1792 重设计域(founder 已划归)——1851 族的根治在那张卡,不在本 plan。验收改为:(a) ghost 批在阈值口径内转 DEAD(T8);(b) **零机制缓解生效**:见改动 4。

**Step 4 — 守卫对齐(裁定变更,PR 描述显式声明)**:`fly1773-delivery-semantics.test.sh` 与相关静态守卫按「runner lane **actual-Claude `on_delivery` 投递即销账** / 裸表 `mailbox.delivered_at`=emission」的新裁定更新——这是 founder 批准的语义变更,不是绕守卫。`MAILBOX_MESSAGE_PROJECTION_VERSION='mailbox_projection_delivered_on_ack_v2'` 与 projection SELECT 有意零 diff;另加守卫覆盖 9 条 DEAD eligibility predicate 的单一 reason 常量,以及 legacy `claimLeadBatch` reclaim 有意仍清 `last_error`。

**Step 5 — 全仓门**:`pnpm lint` + `pnpm -r build` + 定向 vitest + 相关 shell 套件(host 全量照惯例不作门,canonical 以 CI 为准)。

## 6. 验收(证人纪律沿用)

1. 正对照:永不销账消费者的多批流转零楔死(Step 3);真机段由独立 QA 按 dwell 度量 + DONE 引 id 对账验证(不数 acked 行——ACKED 计数在新语义下更不是「已读」证据)。
2. 阴性对照:lead lane 投递/ACK 契约与 codex runner 行为不变(**shared frozen-exit 为裁定例外**);pull 拉取照常;既有其他 DEAD reasons 的死信通知行为逐字不变。
3. 取证:直接查**裸表 `mailbox`**——部署后经投递/消费路径销账的行 `mailbox.delivered_at` 非空,一条 SQL(带部署时间下界)讲清经哪条路送出;不得查 `mailbox_message_projection.delivered_at`(它仍是 ACKED→`acked_at` 的兼容投影)。历史行与处置类 ACK 明确不在此承诺内。

## 7. 风险与边界(如实)

1. **赌注**:一切押在「投递成功」那一笔的严格性——若投递路径谎报成功,新设计会销账丢消息。T3 语义测试钉死;这是 founder 过目并接受的取舍。
2. **stock poller 竞态**:活 session 也可能在 durable 写成功后被 `useInboxPoller` mark read、但正文未渲染;改动 1 会先销账并移除旧 lease 重投兜底。T3 只证明 durable mailbox 边界,不把它夸成模型必读;这是明确接受的剩余丢读风险。
3. 送达但 session 已死 → 行已销账不再重投——旧重投同样救不了死 session,救济一直是换工人;行为差异仅在账面(死信 vs 已销)。
4. **backpressure 变化如实(R1 HIGH-5 纠正原表述)**:in-flight cap 失去「等回执」含义(Claude 路送完即空)。`batchWindowMs=30s` 只是攒批**成员窗**不是节流,runner lane 单 tick 最多顺序投 `maxPerTick=100` 个批——改后真实突发上界 = 单批大小 × 同步 adapter 延迟 × maxPerTick,**没有 30 秒节流兜底**。这是已知取舍(cap 本是此 bug 的放大器;Agent Team 邮箱是 durable 文件,注入按 turn 边界自然分页),不加新 throttle;T7/Step 3 按真实上界断言。
5. `delivered_at`=送出非被看见(实测 8 分钟差);任何「runner 已知」表述必须走 DONE 对账,禁止拿 delivered_at 顶替。
6. **unknown-recipient 边界**:`recipientState='unknown'` 在 reconciler 中 fail-closed skip(既有安全语义保留)⇒ 改动 3 的有界退出只对 known-alive recipient 成立;recipient 状态长期 unknown 的 frozen 批不在退出承诺内(T8 阴性对照)。
7. **残余倒挂风险**(Step 3b):租约窗口内后继消息越过 ghost 持有行仍可能;根治属 FLY-1792 撤销/新鲜度域。

## 8. 部署与回滚

* 单 PR(实现体执行);merge 后 Bridge 重启一次;无 schema/config 迁移。
* **回滚 = 选择性 backout,不是逐字节恢复(v2-R5 BLOCKER-2)**:代码整体 revert 会移除 reason exclusions,而已产生的 `delivery_unconfirmed_exhausted` DEAD 行**留在库里**——旧扫描器只按 state='DEAD' 选行,下一 tick 即触发 founder 禁止的主动通知。定稿:其余行为可整体回退,**单一 reason 常量驱动的两方法 eligibility exclusions 作为兼容 tombstone 保留**,直至只读 count 确认 live mailbox 中该 reason 为零或已全部归档(回退前后各查一次);并如实记录:已落的 ACKED/DEAD 状态与 `last_error` marker 不会被代码回退逆转。交付账本终版(与 §2 净帐、Step 0 闭集同源):1 处 terminal write(Claude on_delivery 分支)+ settle-disposition typed wiring + 3 处 emission COALESCE + frozen-exit(`last_error` streak + `claim_expires_at=NULL` + 原子 DEAD)+ queue-enabled frozen reclaim 保留 marker(共享双 lane)+ 单一 reason 常量与两扫描器全部 eligibility exclusion + 渲染 created_at/年龄快照标注 + inspectDeliveryState 扩展含 `last_error` + message-status 薄 CLI。**回退性质如实(v2-R9)**:writer/类型可回退,但**已落的 reason 值不随代码消失**——全部 eligibility filter predicates 因此是临时兼容依赖,仅在 zero-live-row 后置条件确认后方可另行移除;不存在「无持久痕迹依赖」。
* 部署后首验(独立 QA):活 **Claude** runner 收一条指令 → 行在投递事务内 ACKED;Codex runner 收一条 → LEASED 至其 pull 后销账(阴性对照);pull 一条 → delivered_at 非空;健康 lead lane 前后零变化。
