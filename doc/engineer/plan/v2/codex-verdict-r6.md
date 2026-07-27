CHANGES REQUESTED

# Flywheel v2 设计稿 v6 全量复审 R6

- 评审对象：`/tmp/design/design-v6.md`
- v6 SHA-256：`4e63113480400f6fd73b5e0ea5db18110124bf643bca09080a19b7932066b18a`
- v5 基线：`/tmp/design/design-final.md`，SHA-256 `ca07832e2e0223934fee523eebb53a038291482de875d850d4f3ce1ccceaffc3`
- 场景表：`/tmp/scenarios/all.md`，SHA-256 `43aff6b4cce1083f66442459e4d4f78ec49da03b4c580ae814e927b4f69d78e4`
- 仓库核对：本地 `main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`；本地 `origin/main` 引用为 `37bcb8e2d4d12869cd5afbc52700d37a5902ed1f`，checkout 落后 1 个提交。与本轮 mailbox 现实核对直接相关的 `lead-inbox-loop.ts`、`lead-inbox-runtime.ts`、`lead-inbox-queue.ts`、`wake.ts` 在该 1 个提交中未变。
- 评审边界：按实质协议变更全量审 v6；对明确“同 v5 不变”的归档、gates、notify-then-do、切换手册等只做一致性核对，不重开其既有设计决定。

## 结论

删除 mailbox 的超时租约方向本身可以成立；问题不在于“必须恢复 15 分钟租约”。问题在于 v6 把 claim/lease 提供的驱动、在途身份和物理单消费者保护一起删掉后，没有补齐不依赖墙钟租约的等价机器协议。

按当前文字实施，会出现永久 pending、硬崩溃毒消息无限重启、普通消息无限饿死、runner/Lead 双计算或旧世代改写 retry、外部回复先发后提交，以及 backlog obligation 无法按已批准 schema 入库等窗口。因此本轮不能批准。

## 阻断项

### HIGH-1：门铃可丢，但系统没有“最终一定再查”的驱动；延迟重试和硬崩溃毒消息都可永久 pending

v6 同时规定：

- 门铃允许丢（`design-v6.md:6,59-60`）；
- 回合末才顺手查（`:61`），但空闲消费者没有“回合末”；
- 超龄 obligation 仅在创建时顺带唤醒（`:62`），该唤醒同样被定义为可丢；
- 查询为空后退出，等待下次唤醒（`:65-70`）；
- 失败只更新 `next_retry_at`（`:72`），没有到点调度器。

因此有两个确定反例：

1. 空闲消费者的入库门铃丢失，之后没有新回合；30 分钟后的 obligation 创建门铃再丢一次，该消息可以永久留在 `pending`。
2. 一次显式失败写入未来 `next_retry_at` 后，循环在到点前退出；如果没有新消息/回合/门铃，到点不会自动重查。

还有一个更严重的 crash 窗口：如果“转化”本身令进程 `kill -9`、OOM 或 vendor 崩溃，进程不可能执行 `:72` 的失败事务，`retry_count` 永远不增。该消息若排在首位，会在每个新世代重复杀死消费者，后续消息也永远走不到。这直接推翻毒消息验收（`:110`）和 N1（`:115`）。

现实代码恰好用启动首拉、持续 1s/30s 定时拉取和 single-flight 来保证“门铃只降时延、不承担活性”：`packages/teamlead/src/bridge/lead-inbox-loop.ts:22-24,124-153,367-382`。v6 可以替换它，但不能删而无替代。

最小修订：

1. 明确每个消费者在注册/启动时必拉一次，并保留低频周期 pull，或由 kernel 持久调度下一次 pull；有 `next_retry_at` 时必须调度到最早 due time。门铃只能提前 pull，不能是唯一驱动。
2. 增加**无租约**的 durable processing-attempt 记录：把 `(message_uid, consumer_generation, attempt_no, started/completed outcome)` 在开始转化前短事务落库。显式失败当场结算；新世代只有在旧进程被 supervisor/探针明确判死后，才把旧世代未完成 attempt 结算为 crash failure。累计 5 个实际失败才 `dead`。不得按“处理已超过 N 分钟”让仍活着的旧进程失权。
3. 对“活着但永久卡住”定义代际切换：先硬终止并确认旧进程 absent，再注册新 generation；不能只靠时间把同一消息交给第二个活进程。
4. 补永久消失/已 supersede 的 runner 收件人：其 business pending 要么原子改投 owning Lead，要么 `dead + decision event + obligation`；notice 可 tombstone。backlog 告警必须通知仍活着的监督者，不能只唤醒已死 runner。

新增验收：无任何后续流量时丢门铃仍最终 applied/dead；单条 retry 到点自动重跑；转化中连续 `kill -9` 五次后 dead 且第 2 条消息可继续；runner 永久终止后其 pending 有确定终局。

### HIGH-2：“每个 to_agent 一个活消费者”只是断言；generation fence、runner 注入和外发提交边界没有形成一套协议

`to_agent` 唯一并不推出物理消费者唯一。v6 的 fence 只定义为 `meta.lead_registry` 的 Lead 世代（`design-v6.md:10,56,90`），但角色又包含 runner（`:58`）。以下边界未定义：

- 重复/风暴门铃是否会并发启动两个同世代循环；`:77` 只宣称“处理中不重读”，没有 mutex/actor 约束；
- 两个进程或旧/新 runner shim 同时读取同一 pending 时，谁是当前 generation；
- 失败事务（`:72`）没有 `state='pending' + current generation` 的 CAS，旧世代仍可能增加 retry、推迟 `next_retry_at`，甚至把新世代正在处理的消息打进 dead；
- N12 写成“新旧世代首个 apply 即分胜负”（`:115`），这把 authority 交给调度竞速。正确语义应是：**注册事务提交定义 cutover**；cutover 前的旧事务可先完成，cutover 后旧世代必败，而不是谁先 apply 谁成为 owner。

runner 契约还有直接冲突。v6 说注入垫片“不变”（`:89`），而 v5 的正式接口仍是 `poll → messages / inject(message) / ack(message_uid)`（`design-final.md:53-59`）；v6 新协议却把注入改成不带消息本体的门铃（`design-v6.md:6,60`），并要求业务效果与 applied 同事务。旧 shim 若继续独立 `ack`，会重新产生“ack 与业务效果分离”的窗口；若两个 shim 都 inject，vendor 会话还会收到重复正文。当前 `wakeRunnerMailbox` 也确实把 `content` 写入 transport，而不是纯门铃（`packages/flywheel-comm/src/wake.ts:30-39,113-126`）。

外发边界同样自相矛盾：§1.2a 正确要求转化事务只写 pending command（`design-v6.md:54-55,80`），但 §2.10 又把成功定义成“回复已发出”（`:93`）。若按后者直接发送，发送后、mailbox CAS 前崩溃就会重发；发送失败又无法与 SQLite 原子回滚。

最小修订：

1. 为每个可收件的 `to_agent` 定义机器可查的 consumer registry/activation，至少绑定 `{agent_id, instance_id, generation, kind=lead|runner, runner_attempt/session activation}`；mailbox admission 拒绝不可路由地址。可以落 `meta` 键空间，也可以正式加表，但必须进入迁移、备份和 schema inventory。
2. 注册 generation 的事务提交是唯一 cutover 点；新消费者在注册成功前不得读/转化。每个进程内以 `to_agent` keyed single-flight 串行化重复门铃。
3. apply、retry、dead 等所有 agent 发起的 mailbox 写都带同一 current-generation 谓词；CAS 影响行数必须恰为 1，否则抛错并回滚整个事务。不能只 fence `pending→applied`。
4. 重写 §2.4a：shim 只能发送 hint，不能 ack；或它可把 `{message_uid,payload}` 交给 vendor 计算，但最终只能向 kernel 提交带 generation 的“转化 proposal”。只有 kernel 的短事务能写业务行/command 并 `pending→applied`。
5. 把“回复已发出”改为“回复 command 已持久入 outbox”。真实发送和 receipt 仍由既有唯一 dispatcher 执行。

新增验收：同世代 100 次并发门铃只出现一个消费循环；两个物理进程同时读同一 UID 只有一个业务提交；旧 Lead 的 success/failure 两条写路径都失败且零副作用；runner replacement 后旧 activation 的 proposal 必拒。

### HIGH-3：founder 优先队列会让普通消息无限饿死，N4 的“有界”结论不成立

查询每批始终把全部 founder 消息排在普通消息前，随后 `LIMIT 200`（`design-v6.md:66-68`）。如果 founder 到达速率持续大于处理速率，每一批都可由 200 条 founder 填满，普通消息永远不会进入 batch。批间重排不会改变这一点，超龄告警也不会替消息完成处理。因此 `:78` 的“插队时延有界”和 N4（`:115`）均为假。

另外，单条转化被允许耗时“秒到分钟”（`:7,79`），预取 200 条意味着新 founder 消息也可能等待前一批数小时；只用“条数 200”不能给出有意义的时间上界。

最小修订：

1. 给出机器公平策略，例如每批最多连续处理 K 条 founder、至少处理 1 条最老的 ready 非 founder，或用 aging 把超龄普通消息提升到同级；必须保证持续 founder 洪泛下，某条已 ready 的普通消息仍有有限服务上界。
2. 每条或很小时间片后重新查询，不预取一个可能执行数小时的 200 条不可打断工作清单；写出 founder 最大插队延迟的量化上界。
3. 新验收必须在 founder 生产速率高于消费速率的整个测试期间持续注入，而不是先灌一批再停；断言早先普通消息在上界内进入 applied/dead。

### HIGH-4：§1.6 重新打开 terminal task 的旧矛盾，且新增 session 层没有权威 schema/activation 关系

v6 一方面说 15 表和其余 schema 不变（`design-v6.md:33-36`），另一方面新增 `task→attempt→session` 层（`:82-86`），但已批准的 15 表清单没有 `sessions` 或 attempt-session binding（`design-final.md:16-19`）。

更关键的是，`:84-85` 规定打回/loop 一律在同一 task 新建 attempt，只有“issue 已 Done 后”才建 `rework_of` successor。这与已闭合的不变量冲突：

- task 的 `done/canceled` 是 terminal，kernel 拒绝 terminal task command；
- DAG 上游 task 必须先完成，才能解锁下游；下游发现上游问题时，上游 task 通常已经 terminal；
- R1/R2 正是因此确定“target task terminal → 新建 `rework_of` successor”，而不是以整个 issue 是否 Done 为判断条件。

“原 session 活着就 resume”也没有说明同一个 session 如何绑定新 attempt generation、旧 generation 凭据如何撤销、一个 session 能否属于多个 attempt。现实代码为此使用不可变 `activation_id` 和 `(execution_id, run_id, node_id, attempt)` binding（`packages/teamlead/src/StateStore.ts:1367-1378`）；v6 的新权威模型不能只靠一句 resume 省掉该关系。

最小修订：

1. 恢复已闭合规则：**目标 task 非 terminal**时可同 task 新 attempt；目标 task 已 terminal 时，无论 issue 是否 Done，都创建 `rework_of` successor 并继承 `lineage_root_id/thread`。如果坚持 terminal task 内重开，则必须全面重写 task terminal 单调、dependency unlock、kernel terminal 拒绝、obligation tombstone 等既有合同；这不是最小改动。
2. 明确持久关系：新 attempt 每次获得新 activation/generation；resume 可复用外部 session/execution body，但必须有权威 binding 把该 session 的本次 activation 绑定到新 attempt，并撤销旧 generation capability。保持每 task 至多一个 active attempt、每 worktree 至多一个活 writer。
3. 把新增列/表纳入 15 表 inventory（必要时修正表数）、迁移、FK/UNIQUE、备份与 crash-replay 验收。

### HIGH-5：§3.1 的 per-agent obligation 与 v5 schema 不可入库；通知升档也有漏发/错 episode 窗口

v6 只给 obligations 增 `episode_key` 和 open partial UNIQUE（`design-v6.md:35-36`），但继承的 v5 schema 要求 `target_task_id FK NOT NULL`，并会在 target task/attempt terminal 时 tombstone（`design-final.md:25`）。`mailbox_backlog:<to_agent>` 是 agent 级健康 episode（`design-v6.md:98-101`），未必有合法 task 可挂；随便挂到某 task 又会在该 task 终态时误销账，即使 agent backlog 仍存在。

此外，§3.1 没有把这些动作规定成同一个 kernel 事务：

1. 在事务内重新读取当前超龄集合；
2. upsert/tombstone open episode；
3. 持久推进已通知 tier；
4. 以稳定 effect key 写通知 command。

若 detector 先读、kernel 后写而不重验，消费者可在两者间清空或形成 backlog，产生陈旧创建/错误销账。若 obligation 先提交、通知 command 后写，二者之间崩溃会永久漏掉“创建时通知”；若没有持久 `last_notified_tier`，每分钟 tick 会重复升档或在 oldest 被处理后错误降档。新 episode 若复用 `mailbox_backlog:<to_agent>:<tier>` 作为通知 effect key，还会被上一 episode 的历史 command 错误去重。

最小修订：

1. 给 obligation 增可执行的 agent target：例如 `target_kind` + `target_agent_id`，并与 `target_task_id` 做 exactly-one CHECK；task terminal trigger 只作用于 task-target，agent backlog 只按“无超龄 pending”销账。或定义等价的永久 agent-health authority，不能挂任意 task。
2. kernel 在一个 immediate transaction 内重新计算该 `to_agent` 的 overdue 集合，并完成 episode upsert/tombstone、payload 更新、tier 单调推进和通知 command 插入。detector proposal 只可作 hint，不能携带最终 count/clear authority。
3. 持久化 `last_notified_tier`；通知 `effect_key` 必须含**本次 obligation/episode id + tier**，不能只含稳定 `episode_key`。定义 backlog 清空时未执行通知 command 是取消还是仍发送历史告警。
4. 对新 detector 查询补合适索引和真实 query-plan 验收。

新增验收：create/clear 与 consumer apply 的交错；每个 tier 的事务 crash replay；episode 1 tombstone 后 episode 2 的 30m 通知仍可发送；目标 runner 已 terminal 时告警路由到 owning Lead。

## MEDIUM 阻断项

### MEDIUM-1：v5 的索引实证不能覆盖 v6 的新查询；按 v6 伪代码会退化为全表扫描

v6 声称“索引同 v5，R4/R5 已实证”（`design-v6.md:49`），但 R5 实证的是 immediate/scheduled **两个分支**分别命中两个 partial index。v6 的实际伪代码改成单个 `OR`，又增加表达式排序 `ORDER BY (source_kind='founder') DESC, seq`（`:66-68`）。

用本机 SQLite `3.51.0` 按 v6 schema/两索引执行该 exact query 的 `EXPLAIN QUERY PLAN`，结果为：

```text
SCAN mailbox
USE TEMP B-TREE FOR ORDER BY
```

把 due 条件拆成 `UNION ALL` 后两个分支可重新命中索引，但 founder 排序仍需临时排序，且若不限制每支候选数仍会物化全部 ready 行。§3.1 每分钟按 `created_at` 扫超龄行也没有相应新索引。

最小修订：给出与公平策略一致的 exact SQL + executable DDL；分别对 immediate、scheduled、founder/aging 公平选择和 overdue detector 做真实迁移与 query-plan 断言。不能复用 R5 对旧查询的证明。

### MEDIUM-2：episode 历史与“行数恒 ≤1”矛盾

partial UNIQUE 只保证每个 `episode_key` 至多一条 **open** 行（`design-v6.md:36`）。`:101` 又要求清空后 tombstone、再出现时创建新 episode，因此同一收件人的历史行会自然多于 1。验收却要求“告警行永不超过 1 条/收件人”（`:111`），N10 也写“行数恒≤1”（`:115`）。

最小修订：统一为“任一时刻 open 行 ≤1；历史 tombstoned episode 可多行且保留审计”，并增加“两次清空重建后总行数=2、open 行数=1”的断言。若要复用同一物理行，就不能称为新 episode，且会损失 episode 级通知/audit 身份。

### MEDIUM-3：claim/lease 术语清理过度，和继承的 command 执行协议冲突

术语表把 claim/租约写成全系统“已删除”（`design-v6.md:9`），但 §1.3-1.5 明确继承 v5（`:81`）；v5 的 dispatcher/projector 仍是 command 的单一 claim loop（`design-final.md:47`），commands 的 accepted/executing/reconcile 语义也没有被本轮废除。mailbox 不需要租约，不等于所有 command 外发执行也不需要所有权。

最小修订：全文统一为“删除 **mailbox message claim/lease**”；明确 commands/dispatcher 的执行 claim、effect receipt 和 reconcile 保持 v5 不变，避免实施者误删另一个状态机。

### MEDIUM-4：N1-N12 不能声称“全部闭合”，还缺少协议级交错场景

附录称 N1-N12 全部闭合（`design-v6.md:113-115`），但至少缺少：

- retry 到点且没有任何新门铃/回合；
- 转化中 hard crash 与活着卡死；
- 两个同世代循环、两个物理消费者、runner activation 换代；
- 收件人不存在/terminal/superseded；
- retention `pending→dead` 与正在计算的 apply 竞态；
- generation 注册事务前/后 crash；
- obligation create/clear 与消费并发；
- tier 通知 intent 的事务 crash；
- 同一 agent 的第二个 episode；
- 持续 founder 到达速率高于消费速率。

最小修订：把以上场景加入 §6，并把 N5/N10/N12 改成准确结果：

- N5a commit 前崩溃：业务行、command、applied 全回滚；N5b commit 后外发前崩溃：mailbox 已 applied、command 仍 pending，重启 dispatcher 后发送，**不是事务回滚**；N5c 外发后 receipt 前崩溃：按 §1.2a 的 probe/effect_key/允许罕见 Discord 重复收敛。
- N10：恒 ≤1 的是 open episode，不是历史总行数。
- N12：注册 cutover 决定 authority，不是首个 apply 竞速决定。

## 已闭合项核对

以下 v5 决定在 v6 中未被实质触碰，或本轮一致性核对通过，不要求重开：

1. **单库方向与内部原子 apply**：mailbox、commands/tasks/receipts/events 同住 `flywheel-v2.db`，内部业务行与 `pending→applied` 可在一个 SQLite 事务提交（`design-v6.md:18,53-56`）。这是删除 mailbox lease 后仍应保留的正确核心。
2. **mailbox schema 主体清理**：`claimed` 状态及 `claim_owner/claim_generation/lease_expires_at` 已从 v6 mailbox DDL 删除，state CHECK 与 business retention 的 `pending→dead` 修订一致（`:18,37-49`）。stable `message_uid`、canonical source key、payload digest、cutover epoch、retry/backoff/dead 仍保留。
3. **外部世界不假装 exactly-once**：§1.2a 诚实保留“已发未记”的边界残留，并区分可探测效果与 Discord 罕见重复（`:80`）。需要修的是 §2.10/N5 的冲突文字，不是撤回这条诚实基线。
4. **events 归档、执行所有权、gates**：v6 明确继承 v5（`:81`），未发现改写 staging/fsync/manifest、每 command.kind 唯一 executor 或 exact-head gate 的新文字。
5. **notify-then-do**：v6 明确不变（`:91`）；既有 nonempty dependency、notification 基例、claim-time succeeded/effect_unknown reconcile 合同仍成立。
6. **retention/VACUUM/cutover**：§0.5 和切换手册保持 v5，且 business 状态替换为 `pending→dead`（`:17-18,104`）；旧 writer 三重围栏、WAL-safe backup、真实复活测试不需重开。
7. **DAG 不绑三段式**：前提条款仍明确 task 数量/形状由 issue DAG 决定（`:14-15,86`），方向正确。
8. **聚合告警的 DB 去重方向**：`UNIQUE(episode_key) WHERE state='open'` 能正确封住同一 agent 同时多条 open episode（`:36,99`）；30m/2h/8h 升档与清空后新 episode 的产品语义也合理。阻断点是 target schema、原子通知和验收措辞，而不是要求恢复逐消息告警。

## R7 最小修改集

1. 增加不依赖消息租约的可靠 pull/due 调度、durable processing-attempt crash 归因，以及 terminal recipient 处置。
2. 机器化所有 Lead/runner 的 consumer registration、generation cutover、同世代 single-flight，并 fence apply/retry/dead 全部写路径。
3. 重写 InjectionShim 与 §2.10：shim 不独立 ack；回复等外发只落 command；修正 N5。
4. 给 founder 优先增加可证明的公平性和时间上界，并按 exact 查询重做索引/query-plan。
5. 恢复 terminal task→successor 规则；为跨 attempt resume 定义持久 activation/session binding。
6. 让 agent backlog obligation 有合法 target；在单个 kernel 事务内重验 predicate、推进 tier、写通知 command，并以 episode id 去重。
7. 修正 open episode 与历史行数、mailbox-vs-command claim 术语，并补齐 §6 所列并发/crash 场景。

这些修订不要求恢复 mailbox 的 15 分钟租约，也不要求撤回 SQLite-only、generation fence 或聚合告警方向；需要补的是删除租约后缺失的驱动、身份、提交与恢复协议。
