CHANGES REQUESTED

# Flywheel v2 设计稿 v3 复审 R3

- 评审对象：`/tmp/design/design-v3.md`
- 设计稿 SHA-256：`354579c53fa3af315ce09841ff9c01d2d16760219a673d038b06d4e427b36837`
- R2 基线：`/tmp/design/codex-verdict-r2.md`
- 仓库基线：`main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`
- 评审边界：只核对 R2 的 9 项修改、R2-HIGH-1/2/3、MEDIUM-1，以及 v3 的单库 mailbox 架构决定；不重开 R2 已判闭合的 v1/v2 基础设计。

## 1. 核心架构判定

**mailbox 并入 `flywheel-v2.db` 是正确决定。**

- 正常消费的跨库 apply/ack crash window已类别性关闭：mailbox、`source_receipts`、`events`、`obligations` 同住一个 SQLite 文件，且 `applied` 被定义为目标权威行与 mailbox 状态在同一事务提交（`design-v3.md:24-30`）。不再需要 R2 给出的跨库 saga 备选方案。
- `lead_cursor.last_mailbox_id` 被废除，消费只认 mailbox `state='applied'`（`:27`），因此 R2 的“双消费权威”已类别性关闭。
- generation-fenced claim/ack、lease、重放幂等键与 DLQ 都已进入 schema/协议（`:25-29`），R2-HIGH-1 的主要 crash-safety 缺口已关闭。

但这不等于 R2-HIGH-2 的所有路径自动完成。未消费 business 消息走的是 `dead/DLQ + detector proposal`，不是普通 `applied` 路径；v3 没有明确“mailbox 变 dead、写 proposal/decision event、以及 kernel 选择性创建 obligation”属于同一个 kernel 事务。单库提供了原子能力，但设计还必须把这个能力写成事务合同。

所以本轮回答是：

| 问题 | R3 判定 |
|---|---|
| comm.db → 权威库跨库 apply/ack | **类别性关闭** |
| `lead_cursor` 与 mailbox 双消费权威 | **类别性关闭** |
| R2-HIGH-1 crash-safe mailbox | **主体关闭，但 retry/backoff 与查询索引仍退化** |
| R2-HIGH-2 跨库 retention handoff | **跨库类别关闭，但同库 handoff 事务边界未闭合** |
| R2-HIGH-3 canonical Discord thread | **机器唯一性主体关闭** |

## 2. 阻断项

### HIGH-1：business retention handoff 仍有一个未定义的 crash window

v3 规定超期 business 消息“进 DLQ 并产生 detector proposal”（`design-v3.md:10`），告警章只规定 detector proposal 由 kernel 原子写 obligations（`:51`）。这没有说明以下动作是否同事务：

1. mailbox `claimed/pending → dead`；
2. 以 `message_uid` 写唯一 decision/source receipt/event；
3. kernel 决定创建或不创建 obligation；
4. 记录 proposal 已处理，防止重放双建。

若 retention worker 先把消息置 `dead`、再提交 proposal，二者之间崩溃会永久漏 proposal；若先提交 proposal、再置 `dead`，重跑可能重复提议。普通 apply 的同事务承诺（`:27`）不覆盖这条 `dead` 路径。

必须明确：retention detector 只提交带 `message_uid` 的 proposal；kernel 在**一个 `flywheel-v2.db` 事务**内 CAS mailbox 状态、写唯一 decision receipt/event，并按裁决创建至多一个 obligation。即使裁决为“不建 obligation”，也必须留下幂等终局证据。

### HIGH-2：消息 cutover 仍不能阻止旧 JSON writer 复活

v3 对 comm.db 写了只读归档，但对 JSON 只写“目录归档”，随后声称旧 JSON writer 复活会写只读文件失败（`design-v3.md:53-59`）。这与当前 writer 行为不符：

- 写入前会调用 `ensureFileExists`（`packages/agent-team-transport/src/claude/ClaudeMailboxCodec.ts:931-934`）；
- `ensureFileExists` 会递归重建父目录并重新创建 mailbox 文件（`:1065-1086`）。

因此把旧 JSON 目录移去 archive 后，旧进程一旦由旧 supervisor/config 复活，完全可能在旧路径重建一套新信箱；新 kernel 看不到它，双轨会被重新打开。`mailbox.cutover_epoch` 只保护新库，无法拦截不访问新库的旧 writer。

切换合同必须增加：

- 旧 writer 的启动入口、supervisor、token/capability 一并撤销或替换；
- 在**原旧路径**保留不可写 tombstone/父目录 fence，不能只把目录移走；
- Go/No-Go 真启动一次旧 JSON writer 与旧 comm.db writer，断言进程 fail loud，旧路径无新文件/`-wal`/`-shm`，新 mailbox 无旧 epoch 行。

### HIGH-3：notify-then-do 仍可被“零 dependency”绕过，并缺少 notification 自身的基例

`command_dependencies` 表和“已有 `notify_before` 依赖必须 succeeded”已经补上（`design-v3.md:20,47-49`），但这个谓词只检查**已经存在**的依赖。对一个本应知会、却根本没有插 dependency 的 action，`所有 notify_before 依赖均 succeeded` 是空集真，action 仍可 claim。

同时 v3 说 allowlist 只有四个 read kind，“其余一律先知会”（`:49`），而 command kind 清单里又有 `notify`/`founder_page`（`:42-43`）。若按字面执行，notification command 自己也需先 notification，形成无限前置链；若它们不算 action，必须在机器分类中明说，不能靠实现者猜。

必须增加：

- command admission 时校验：每个非豁免 **action kind** 必须有至少一个 `notify_before` dependency，否则拒绝建 command；
- 明确 `notify`/`founder_page` 是 prerequisite notification kind，可无 `notify_before` 领取，或把它们加入严格基例 allowlist；
- 禁 self-edge/环，并规定 notification `effect_unknown` 时 action 不可 claim。

## 3. 其余 R2 修改逐项核对

### R2-1 mailbox 协议与 schema：部分闭合

已补 stable `message_uid`、canonical source key、digest conflict、epoch、claim owner/generation/lease、CAS ack、retry budget、DLQ、at-least-once 与幂等 apply（`design-v3.md:24-30`）。

未闭合的是 R2 明确要求保留的 retry/backoff 与有界 pending 查询。当前 comm.db 已有：

- partial pending index（`packages/flywheel-comm/src/lead-inbox-queue.ts:194-197`）；
- `next_retry_at` 与有 cap 的指数 backoff（`:1860-1899`）；
- claim 查询尊重 `next_retry_at`（`:2007-2060`）。

v3 只有“lease 过期回 pending”，没有 `next_retry_at`、backoff base/cap 或相应索引；连续失败可按固定 lease 高频重领。正式 schema 还应给 `message_uid/source_kind/source_id/payload_digest/state/retention_class/cutover_epoch` 明确 `NOT NULL`，并给 `retention_class` CHECK。

### R2-2 同库 apply 与唯一消费权威：部分闭合

正常 apply/ack 与双权威已完全闭合；仅剩 HIGH-1 所述 retention `dead → proposal/decision/obligation` 事务未写全。补上后本项可关闭。

### R2-3 消息通道 cutover：部分闭合

双源冻结、canonical 去重、原 UID/digest、双向 row count、WAL-safe backup、integrity、epoch 和两条新增 Go/No-Go 都已写入（`design-v3.md:53-59`）。旧 JSON writer 的可重建路径仍使“复活 fail loud”不成立，见 HIGH-2。

### R2-4 events 归档：已闭合

唯一 staging、file fsync、hash/row count、内容寻址终址、atomic rename、directory fsync、单 DB 事务 manifest+delete，以及 staging/orphan reconcile 均与 R2 要求一致（`design-v3.md:31-33`）。也不再错误声称 DB 与文件系统是一个事务。

### R2-5 权威 schema inventory：部分闭合

核心权威概念、`meta` lead registry、`archive_manifest`、`thread_bindings`、command dependency 与 ledger 落点都已进入清单（`design-v3.md:13-23`），obligation trigger 也已修正。

仍需三个精确修订：

- v1 明确另有 `schema_migrations`（`design-v1.md:30`），v3 却称“共 14 张表”；应纳入全量清单或明确它为何不计数；
- `thread_bindings.canonical_key=lineage_root_id` 应写成 `REFERENCES tasks(id)` 的明确 FK，而不是只写等号语义；
- `command_dependencies` 声明列名是 `depends_on_command_id`，PK 却写 `depends_on`（`design-v3.md:20`），DDL 名称需统一。

### R2-6 状态机与 rework effect：已闭合

attempt cancellation 统一映射到 `desired_state='terminal' + terminal_reason='superseded'`，无非法新状态；command 增 `rejected/canceled` 与持久 `result_code`，无副作用终局由 kernel decision event 驱动；effect 处置表覆盖列出的 command.kind，未知 kind fail closed（`design-v3.md:17-22,40-44`）。

### R2-7 notify 与 Discord window：部分闭合

canonical thread 已选 lineage root，`canonical_key` PK、`thread_id` UNIQUE、rework 继承和稳定重建 key 均已写入（`design-v3.md:23`），R2-HIGH-3 主体关闭。notify dependency 的“必须存在”约束与 notification 基例仍未闭合，见 HIGH-3。

### R2-8 回归验收：部分闭合

P10 已给出 `≤5 分钟` 与起点；旧 Lead CAS、同事务 crash replay、retention、双源 cutover、archive 断电测试也已补上（`design-v3.md:61-65`）。

P12 仍不是真正穷举：

- v3 继承的 §2.6 仍声明可旁路“提醒/超时建议/路由策略”（`design-v1.md:58-59`，经 v2/v3 继承），但 v3 的 P12 inventory 没列这三类；
- “每项：所需 capability/TTL/audit”只是字段占位，没有逐项给出 capability、具体 TTL、audit event/result code；
- archive orphan adopt、probe unknown 升 obligation 是 recovery/escalation transition，不应替代对真正 bypass 的枚举。

应给一张封闭矩阵：每个 bypass/escape transition 对应 exact command kind、actor、capability、TTL、audit event、正向可达测试、反向未授权拒绝测试。

### R2-9 规模故事：部分闭合

绝对化的“永不重写/严格 O(1)”已正确删除；retention 天数、row/WAL/age/lag 阈值、batch delete、checkpoint 与 overload 行为均已给数值（`design-v3.md:6-10`）。

但 R2 要求的以下项仍缺：

- pending/claim/retry 的具体 partial/composite index DDL；
- authority DB bytes 告警阈值（当前只有 row count 与 WAL bytes）；
- retention tick 的唯一调度者和周期；
- `VACUUM`/`auto_vacuum` 策略，或明确“不在线 VACUUM、只 checkpoint”的理由及离线维护门槛；
- retry backoff base/cap 与 `next_retry_at`。

## 4. R4 最小修改集

1. 把 business retention 的 mailbox CAS、decision receipt/event、可选 obligation 写成以 `message_uid` 幂等的单个 kernel 事务。
2. 对旧 JSON/comm writer 增加原路径 fence、启动入口撤销和“真复活必失败”Go/No-Go；不能只 archive 路径。
3. 给 mailbox 增 `NOT NULL`/CHECK、pending+retry indexes、`next_retry_at` 和有界 backoff。
4. 在 command admission 强制非豁免 action 必有 notification dependency，并定义 notification 基例与 dependency 无环约束。
5. 补 `schema_migrations`/FK/列名，列全 P12 矩阵，并补 DB bytes、retention scheduler、VACUUM 策略。

上述修改都不要求撤回 SQLite-only，也不要求恢复 comm.db。单库方向已经正确；本轮不批准的原因是若直接按 v3 实施，仍可在 retention crash、旧 JSON writer 复活和零 dependency action 三个窗口分别造成漏义务、重开双轨或绕过 notify-then-do。
