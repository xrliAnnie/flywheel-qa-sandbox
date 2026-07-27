CHANGES REQUESTED

# Flywheel v2 设计稿 v2 复审 R2

- 评审对象：`/tmp/design/design-v2.md`
- 设计稿 SHA-256：`c12e6dce23ad79d27084cf59eda4c2021e72857897b88152dd3a260629995767`
- R1 验收基线：`/tmp/design/codex-verdict-r1.md:274-288`
- 仓库基线：`main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`
- 评审边界：只核对 R1 的 11 项修改及本轮 `[A]` SQLite-only 信箱修订，不重开 R1 已判正确的 v1 基础设计。

## 1. 结论

SQLite 信箱作为唯一消息通道的方向正确，历史修订也与现行实现相符：JSON mailbox 确实在锁内读取、解析并重写整个数组（`packages/agent-team-transport/src/claude/ClaudeMailboxCodec.ts:931-961`），因此不应回抄文件信箱。

但 v2 仍不能批准实施。11 项中，R1-4、R1-11 已闭合；R1-1/2/3/5/6/7/9/10 仅部分闭合；R1-8 的文件归档原子性没有闭合。`[A]` 又引入一个新的阻断窗口：`mailbox.consumed_at` 在 `comm.db`，`lead_cursor/source_receipts/events/obligations` 在权威库，设计没有跨库 apply/ack 协议，也没有 generation-fenced claim。旧 Lead 即使被 kernel 拒绝提议，仍可在 comm.db 把消息标成 consumed，造成永久丢信。

## 2. R1 十一项逐项核对

### R1-1 逆向打回：部分闭合

正确吸收：

- terminal task 不再重开，而是创建带 `rework_of` 的 successor；
- 同事务撤权、取消下游并写 terminate/reconcile intent；
- 旧 writer 明确 absent 前不交接冲突 worktree；
- 删除了“旧代码默认丢弃”，并区分补偿、forward-repair、不可逆 effect。

未闭合：

- v2 写“下游 attempts desired 置 `canceled/superseded`”（`design-v2.md:41`），但继承的 v1 attempts schema 只允许 `planned/dispatched/started/terminal`（`design-v1.md:23-25`）。当前状态转移无法写入数据库。
- R1 要求“每种外部 effect”有处置规则；v2 只列 Discord、Linear、merge、delete 示例（`:43`），没有覆盖 GitHub PR/comment、thread create、spawn/terminate 等实际 command kind，也没有规定未知 kind 必须 fail closed。
- `rework_of` 只说“增列”，没有 FK、lineage root、环/自引用约束；successor 如何复用 canonical Discord thread 也未定义。

### R1-2 command 状态机：部分闭合

`claimed/accepted/executing/succeeded/failed`、`accepted_at/completed_at`、accepted 后 lease/reconcile 和 effect_unknown 禁止盲重发均正确加入（`:18-21`）。

但 §2.1 又要求 `stale|policy_denied|noop` “结清 command”（`:35`），而 §1.1 规定 `succeeded/failed` 只能由 effect receipt 或 terminal observation 驱动（`:20`）。这三类无副作用的 kernel 决定没有合法 terminal transition。必须增加/定义 `rejected|canceled`，或明确由哪种 kernel terminal decision receipt/event 将它们映射到现有终态；同时写清 `result_code` 的持久化字段与 CHECK。

### R1-3 obligation/alert 权威模型：部分闭合

新增 obligations 表、target generation、root/parent/depth、tombstone、resolution，方向正确（`:22-24`）。

未闭合：

- “parent 为 obligation 时禁止再建”与 `parent_obligation_id`、允许 depth=1 自相矛盾：任何 parent 都必然是一条 obligation，按字面所有 child 都会被拒。应规定 root 为 depth=0；仅允许 depth=1 的 child 引用 depth=0 parent；parent.depth=1 时拒绝；并校验 `NEW.depth=parent.depth+1`、继承同一 `root_episode_id`。
- `target_task_id`、`parent_obligation_id`、`resolver_capability_id` 未声明 FK/nullability；target terminal 的 tombstone 触发范围也未覆盖 attempt generation 终止。
- “confirmed-sent 才记 ledger”没有指定 ledger 是 events、source_receipts 还是另一张表，也没有唯一 effect key/receipt FK。
- 标题称“权威库 9 张表”，但正文另增 `meta`、`archive_manifest`、`thread_bindings`、`lead_cursor`、`lead_generation`，这些权威概念没有进入完整 schema inventory、迁移和备份合同。

### R1-4 executor 唯一所有权：已闭合

每个 command.kind 映射到唯一 executor class，projector 被降为 dispatcher adapter，结果统一经 kernel observation API 回写，启动顺序也同步修正（`:30-31,73`）。实施时只需把 github/linear projector 同样约束为 dispatcher 管理的单一 claim loop。

### R1-5 notify-then-do：部分闭合

confirmed-sent prerequisite、effect_unknown reconcile、稳定 effect key 均正确（`:52-56`）。

但“durable dependency”只有一句话，commands schema 没有 `depends_on_command_id`，也没有 `command_dependencies` 表；kernel 无字段可校验。所谓“明确列举”的 allowlist 实际只写了“纯只读查询等”，仍是开放类别而非穷举的 command.kind 集合。Ship 的交叉引用 `§1.6` 不存在（`:7`）。

### R1-6 P3/P8：部分闭合

P8 的机器结果分类和“expected denial 零 alert”已写入；Discord message 的 canonical key 也统一成 `('discord_msg', message_id)`，并明确退役 `chat:`/`founder_msg:` 双 producer（`:29,35`）。

但端到端 P3 仍未闭合：

- mailbox 的 `id` 未定义为 stable canonical/business key，也没有 `source_kind/source_id/payload_digest` UNIQUE，无法把 comm.db delivery 与权威库 source_receipt 做确定性一一对应。
- 入 mailbox、插 source_receipt、创建 event/obligation、标 consumed 分属两个 SQLite 文件，未定义 crash-safe apply/ack 次序。先 consumed 后 apply 会丢信；先 apply 后 consumed 会重放；后者只有在每种 apply 都绑定同一 canonical idempotency key 时才安全，v2 没有写。
- §0.5 说“未消费超期转 obligation”（`:12`），§1.2 又说“无可路由业务目标不产生 obligation”（`:29`）。普通通知/闲聊超期时两条规则直接冲突。

现行 comm.db 恰好已有 v2 瘦身删掉的护栏：稳定 `id UNIQUE`、业务 `ref_message_id` 唯一索引、pending 索引（`packages/flywheel-comm/src/lead-inbox-queue.ts:152-197`），以及 owner epoch + lease 的原子 claim（`:2007-2060`）。新设计可以重写语义，但不能无替代地删掉这些可靠性原语。

### R1-7 Lead crash recovery：部分闭合

launchd、lead generation、durable cursor、replay 和 Lead 不可用时的 fail-closed 边界均已补充（`design-v2.md:47-51`）。

但 generation fence 只保护 kernel proposal，没有保护 comm.db 的 claim/consume。旧 Lead 复活后仍可更新 `consumed_at`；kernel 随后拒绝它的旧-generation proposal，新 Lead又因消息已 consumed 不会重放。`lead_cursor.last_mailbox_id` 与 mailbox `consumed_at` 还是两个消费权威。必须指定唯一消费权威，并用 lead generation/lease CAS 保护 claim 与 ack。

### R1-8 events 归档：未闭合

manifest、hash、row count、seq range、冷区 reader 和跨冷热 replay 都已补齐，这是正确进展（`:26`）。

阻断点是“单事务内 SELECT→写冷文件→manifest→校验→DELETE”不能让 SQLite 事务与普通文件系统写入原子化。崩溃可能留下：

- 冷文件已写、DB 事务回滚后的孤儿文件；
- manifest/DELETE 已提交，但文件或目录尚未 fsync，断电后 manifest 指向缺失文件；
- retry 覆盖一个尚未确认来源/哈希的同名文件。

应改成可恢复协议：冻结 seq range → 写唯一 staging 文件 → fsync 文件 → 校验 → 原子 rename 到内容寻址的只读 final path → fsync 目录 → 单个 SQLite 事务 `INSERT manifest UNIQUE(seq_range/hash) + DELETE hot rows`。启动 reconcile 删除 staging、验证 final orphan，并允许同 hash orphan 被幂等 adopt。不能再声称跨 DB/文件系统“单事务”。

### R1-9 cutover fence：主体闭合，但被 `[A]` 重新打开

commands/events/observation epoch、持久 current epoch、mismatch fail closed、cutover intent、checkpoint、foreign_key_check、业务 invariant、旧 token、启动顺序和旧库只读归档均已补齐（`:25,66-75`）。

新增唯一信箱通道却没有进入九步切换：没有冻结并对账 JSON 与当前 comm.db 两条消息来源，没有迁移未读消息和 stable id，没有禁止旧 JSON writer/consumer 复活，没有 mailbox cutover epoch，也没有 comm.db 的 WAL-safe backup/integrity/retention 验收。因此“一次性切换不双轨”对消息通道仍不可执行。

### R1-10 go/no-go 与病例验收：部分闭合

七条 go/no-go 已实际写出，P3/P8 也有明确断言（`:75,80-83`）。

P10 仍保留占位符“N 分钟”（`:84`），没有可执行时间界限；P12 要测试“每个声明的 bypass”，但 §2.9 没有列出完整 allowlist，测试集合无法封闭。应给定数值/SLO、完整 bypass inventory、每项所需 capability/TTL/audit 及正反测试。

### R1-11 范围文字：已闭合

第三方 API/vendor adapter 不改、我方 ingress/projector/receipt wiring 必改的边界已明确（`:5-7`）。不可逆删除也不再被描述成无门槛动作。仅需修复不存在的 `§1.6` 引用。

## 3. `[A]` 修订引入的新问题

### HIGH-1：七列 mailbox 不是 crash-safe queue

`mailbox(id,to_agent,kind,payload,created_at,consumed_at,retention_class)`（`:27-29`）没有：

- stable producer/business id 与 payload-conflict 检查；
- claim owner、lead generation、lease expiry；
- delivered/processed/disposed 的不同语义和证据；
- retry/backoff/dead-letter；
- cutover epoch；
- 与 source_receipt/event/obligation 的 apply id。

这不是简单“瘦身”，而是把目前防重复、旧 owner 误写和失败重试的机制一并删除。SQLite-only 可以保留，但至少要把 mailbox 定义成 generation-fenced、at-least-once、idempotently-applied 的 transport queue。

### HIGH-2：跨库 retention handoff 会丢或重复 obligation

“未消费超期转 obligation”需要从 comm.db 更新 mailbox，又在 flywheel-v2.db 插 obligation；普通 SQLite 事务不能原子覆盖两个 WAL 数据库。必须选择：

1. 将 mailbox 放进权威库，由 kernel 在同一事务完成 claim/apply/obligation；或
2. 明确定义跨库 saga：comm.db generation-fenced claim → 权威库按 `mailbox_message_uid` 幂等插 source receipt/event/obligation → comm.db CAS ack；crash 后重放，以权威库 receipt 判定已 apply。

不得先删除/consume mailbox 再建 obligation。无业务目标的消息不能因年龄自动升级成人工 obligation；应按受约束的 `retention_class` 进入已定义的 tombstone/DLQ 策略。

### HIGH-3：Discord canonical thread 仍没有机器唯一性

`thread_bindings(project_id,task_id,thread_id,state)`（`:63-64`）未定义 PK、FK 或 UNIQUE；两个 active row 仍可同时存在。并且 rework successor 使用新 task_id，可能创建新 thread，破坏“同一 issue 唯一窗口”。

应明确 canonical key 是 `(project_id, external_issue_id)`、lineage root，还是 task；增加“每 canonical key 至多一个 active binding”和 thread_id 唯一约束；rework successor 必须继承原 binding。幂等重建还需 stable command effect_key 与 reconcile 规则。

### MEDIUM-1：规模故事使用了错误的绝对表述

“行级 append”“永不重写旧内容”“写入 O(1) 不随信箱体积退化”（`:12`）都过强。SQLite 是 page-oriented；`consumed_at` UPDATE、DELETE、checkpoint 都会写页，索引插入也不是严格 O(1)。正确优势是：单条 append/update 不再每次解析和重写整个 JSON 文档；配合有界索引查询、批量 retention、checkpoint/backpressure，成本不会线性扫描全部历史行。

此外“N 天”和“到什么量级”仍是占位符，违反本节自己的元规则。正式稿至少要给出：

- 每个 retention_class 的具体期限、未消费例外和法律/审计保留；
- pending 查询索引；
- 单批删除上限、调度者、VACUUM/checkpoint 策略；
- row count、DB bytes、WAL bytes、oldest-unconsumed age/消费 lag 的告警阈值；
- 过载时 admission/backpressure/DLQ 行为。

## 4. 必须执行的修改清单

1. **补全 mailbox 协议与 schema**：stable `message_uid`/source key、payload digest conflict check、cutover epoch、generation-fenced claim/lease/CAS ack、retry/DLQ；明确唯一 writer/consumer 与 at-least-once 语义。
2. **闭合 comm.db → 权威库 apply**：选择同库事务或写出上述幂等跨库 saga；消费成功的定义必须是权威 event/source receipt 已提交，不是 Lead“读过”。消除 `last_mailbox_id` 与 `consumed_at` 双权威。
3. **补消息通道 cutover**：冻结两条旧 producer/consumer，按 canonical key 对账和迁移未读消息，验证 row count/payload digest，epoch fence 新通道，禁止旧 JSON writer 复活，WAL-safe 备份后只读归档旧文件。
4. **重写 archive crash protocol**：staging + fsync + hash verify + atomic rename + directory fsync，再在一个 DB 事务中写 manifest/delete；定义 startup orphan/staging reconcile。
5. **补全权威 schema inventory**：把 meta/archive_manifest/thread_bindings/lead generation/cursor/command dependency/confirmed ledger 纳入正式 schema；补 FK/UNIQUE/CHECK/partial UNIQUE。修正 obligation depth trigger。
6. **消除状态机矛盾**：给 attempts 增加合法 canceled/superseded transition或统一映射到 terminal reason；给 stale/policy_denied/noop 定义合法 command terminal transition和持久 result_code。
7. **机器化 notify 与 Discord window**：为 notification dependency 提供真实字段/表，穷举 allowlist；为 canonical issue/lineage binding 加唯一约束并规定 rework 继承。
8. **完成回归验收**：把 P10 的 N 换成数值和测量起点；列全 P12 bypass inventory；新增旧 Lead consume CAS 失败、跨库两个 crash window、retention handoff、JSON/comm cutover、archive 断电/孤儿文件测试。
9. **改正规模故事**：保留“不整文件重写”的真实优势，删除 SQLite “永不重写/O(1) 不退化”的绝对承诺，并为 retention、容量、lag、WAL 与 backpressure 给出具体阈值。

SQLite-only 的产品决定无需撤回；完成上述协议后再进入 R3。
