CHANGES REQUESTED

# Flywheel v2 设计稿 v1 独立复审 R1

- 评审对象：`/tmp/design/design-v1.md`
- 设计稿 SHA-256：`d0029a93ecb386eb12c9e87b8509b2ba554b30e5f85881deaa0f621c41ce3957`
- 前次评审：`/tmp/codex-review-cause-20260726.md`
- 仓库基线：`main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`
- 结论：方向已大幅校正，但协议仍有会在崩溃、重启和逆向打回时破坏核心不变量的缺口，暂不能交付实施。

## 1. 总结

前次要求中，以下内容已经正确吸收：

- 8 个核心概念而非追求 `≤5` 张表；
- attempt/generation 与 task 分离；
- transaction outbox 只原子化 intent，不假装把 spawn 放进 SQLite 事务；
- desired/observed/unknown 三态探针及落库的有界升级；
- LLM 只提议、deterministic kernel 做机械拒绝；
- capability 只存 hash、founder 凭据不复用共享 API token；
- 工作票据与 founder/merge 凭据分开续期；
- 独立、整体事务、fail-loud 的 migrator；
- 目录 `0700`、数据库 `0600`；
- delivery receipt 与 human obligation 分离；
- 告警深度限制、终态 tombstone、confirmed-sent ledger；
- stop-the-world、WAL-safe snapshot、首个 v2 外部副作用后的 forward-repair 边界。

但 v1 仍有八类阻断问题：

1. “逆向打回”与 terminal 单调/terminal command 拒绝自相矛盾，而且只改账、不收敛活进程、能力票据和外部副作用。
2. `runner 先 ack 再执行` 没有区分“已接收”与“副作用已完成”，会留下 ack 后崩溃的假成功窗口。
3. 告警章要求的 obligation、depth、tombstone、delivery outbox/ledger 在数据章没有权威落点。
4. cutover epoch 只出现在手册文字中，schema、command、observation envelope 都没有可校验字段。
5. `notify-then-do` 和 Discord 唯一窗口只写成目标，没有可执行的顺序、收据和 canonical message/thread 契约；P3 双收据问题没有被结构性关闭。
6. projector 与 dispatcher 同时宣称拥有 Discord/GitHub 等副作用，重新引入多个执行入口。
7. 补偿层退役所依赖的 Lead 自身 crash recovery 没有设计；现有 resume 章只覆盖 runner。
8. 14 天热区归档没有定义原子归档、冷区读取与 transcript replay，和“append-only 审计 + transcript 为权威”尚未闭合。

## 2. 逐章吸收判定

### 第 0 章：目标与非目标

判定：**部分吸收，有新增范围矛盾。**

- Discord 唯一窗口、notify-then-do、可逆打回、一次性切换均被列为目标，方向正确。
- 但这些目前只是宣言。现行产品契约把 issue 流程的通知点、founder gate、Lead 唯一入口和 per-issue Discord thread 写得很具体（`doc/architecture/product-experience-spec.md:127-176,178-219`）；v1 没有给出与之对应的状态/命令/收据验收条件。
- `不动 Linear/GitHub/Discord 外部集成`（设计稿第 7 行）与新建 projector/observer、替换 ingress/receipt 所有权（第 35-36 行）冲突。若本意是“不改第三方 API 或 vendor adapter”，应这样写；按当前字面范围，第一章无法实施。
- `Ship+不可逆删除` 作为 notify-then-do 例外没有定义替代门槛。例外不能被理解为“可直接做”；必须分别写明 Ship 的 exact-head founder gate，以及不可逆删除所需的独立 capability/gate、预览范围和审计。

### 第 1 章：数据层

判定：**大部分正确吸收，三个缺口。**

正确吸收：

- 前次 §3.1 的 8 个核心概念、FK 依赖、attempt generation、outbox、gate、capability、source receipt 均被保留。
- 前次 CRITICAL 已正确修正：库只存 token hash，明文仅经私有通道按签发次序交付，founder token 不再等于 API token。
- 前次 HIGH-2 已正确修正：迁移器独立、整体事务、任意错误 fail loud。
- 前次 “god row/无 CHECK/FK” 已正确修正：task state、依赖 FK、partial UNIQUE、generation 等约束进入 schema。

仍未闭合：

1. `events` 的 14 天热区/月度冷文件只给了保留时间，没有定义：
   - copy/校验/manifest/删除的原子边界；
   - seq 连续性和重复归档幂等；
   - 冷文件不可篡改或校验机制；
   - `transcript_cursor` 指向冷区后的读取与 replay；
   - 长于 14 天的 task/Lead 如何恢复。

   这只能判定为**部分吸收**前次 HIGH-3，而不是“retention 已设计完成”。前次报告要求的是不能再次把恢复所需的账本变成不可维护的永久大表（`/tmp/codex-review-cause-20260726.md:56-64,239-242`）。

2. 第三章要求 human obligation “独立表/gate”，但当前 8 表中没有 obligation schema；现有 `gates` 也没有 `root_episode_id/parent_episode_id/depth/tombstoned_at/target_attempt_generation`。因此第三章声称的 DB CHECK 和原子 tombstone 无法由第一章落地。这里不是表数问题，而是权威概念没有选定。

3. P3 没有 canonical inbound message key。保留现有 `lead_inbox` 且声明“不动 Discord 集成”，会保留当前两个 producer：`chat:<lead>:<message>`（`packages/flywheel-comm/src/commands/chat-receipt.ts:86-90,163-199`）与 `founder_msg:<lead>:<message>`（`packages/flywheel-comm/src/founder-reply-routing.ts:19-24`; `packages/teamlead/src/bridge/founder-reply-deliverer.ts:454-473`）。`source_receipts` 只有在两个入口被强制规范为同一 `source_kind/source_id` 时才会关闭双建；v1 没有写这个约束。

### 第 1.3/2.1 章：projector、observer、dispatcher 边界

判定：**前次 §3.8 的 ingress 原则正确吸收，但执行所有权走样。**

- “外部事实只以 provenance + idempotency observation 进入 kernel，外部系统不直接写内部状态表”是正确的。
- 但第 1.3 章说 projector claim `Linear/Discord/cmux` command；第 2.1 章又说 dispatcher 执行 `spawn/Discord/GitHub`；切换启动顺序只列 projector/observer，没有 dispatcher。Discord 至少有两个被声明的执行者，GitHub 的归属也不一致。
- 必须规定每个 `command.kind` 只有一个 executor class。可以把 projector 定义为 dispatcher 的专用 adapter，但不能保留两个平级 claim loop。所有 observation/receipt 也必须通过 kernel API 提交，不能由 executor 直接写 DB。

这意味着前次 “同一语义唯一写入口” HIGH 只被**部分吸收**（前次报告 `:72-76`）。

### 第 2.1 章：LLM/kernel/dispatcher

判定：**正确吸收。**

- 前次 §3.5 列出的七类机械拒绝均被保留。
- LLM 带 `expected_state_version` 提议、kernel CAS、LLM 无 SQL 权限，边界正确。
- 单 worktree writer、exact-head approval、CI-red no-ship 与七个底层不变量没有被“LLM 全权”稀释。

### 第 2.2 章：派发协议

判定：**正确吸收。**

- attempt + generation + launch command 同事务；
- stable execution id；
- commit-before-spawn 和 spawn-before-ack 两个 crash window；
- generation-bound marker 的 adopt-or-terminate；
- 登记失败即派发失败；
- 没有宣称 SQLite 能原子化外部 spawn。

这些与前次 §3.2 完全一致。

### 第 2.3 章：探针

判定：**正确吸收。**

- expected 与 observed 分离；
- 只有同 host epoch、成功枚举且明确 absent 才能判 dead；
- 枚举失败保持 unknown；
- unknown 次数落库；
- N 次后交给 human obligation，而不是依赖进程内 Map 无限 hold。

这正确吸收了前次 §3.3 与 MEDIUM 项。

### 第 2.4 章：resume

判定：**方向正确，但 command ack 协议不完整。**

正确部分：

- app transcript、generation-bound activation、effect intent/receipt、reconcile-before-replay 都被保留；
- vendor handle 只是恢复加速器；
- Claude `--resume` 与 Codex no-rollout 被诚实列为工程缺口，而非假装已支持。

阻断点：

- `commands` 只有 `state/acked_at/result`，第 2.4 章又要求 `runner 先 ack 再执行`。如果 `acked_at` 被消费端当成 terminal ack，runner 在 ack 后、执行前崩溃时 command 会被误判完成；如果它只是 delivery acceptance，则 schema/状态机没有这样写。
- 必须把 receipt acceptance 与 effect completion 分开，例如：
  `pending → claimed → accepted/executing → succeeded|failed`，
  并使用独立的 `accepted_at/completed_at`。accepted 后崩溃仍必须进入 lease/reconcile/replay，只有 effect receipt 或 terminal observation 才能完成 command。

因此前次 §3.4 是**部分吸收**；“先 ack”这个词被照搬了，但它在正式 schema 中没有消歧。

### 第 2.5 章：逆向打回

判定：**未形成可执行协议，并引入新的不变量冲突。**

当前文字称“目标节点 generation+1、失效下游 attempts、默认丢弃旧代码，结构上只是加行”。这同时有四个问题：

1. `tasks.done/canceled` 被定义为 terminal 且 terminal 单调，第 2.1 章还要求 kernel 拒绝 terminal task command。一个已经完成、需要被打回的目标 task 无法再合法创建 generation+1 attempt。
2. 只把下游 attempt 标成失效，不会停止仍活着的 tmux/vendor 进程，也不会撤销 capability/gate。新 attempt 可能与旧下游进程同时写同一个 worktree，直接违反第一红线。
3. Git commit、PR、Discord/Linear 写入、merge、删除等外部 effect 不能靠“加一行”回滚；必须区分可补偿、只可 forward-repair、不可逆三类。
4. “旧代码默认丢弃”不是安全默认值；它可能删除尚未合并但有价值的工作，也没有 founder/capability 边界。

需要把逆向打回改成明确的 rework saga：

- 若目标 task 已 terminal，创建带 `rework_of/supersedes` 的新 task，不重开 terminal 行；
- 同一 kernel 事务内关闭旧 active attempt、把下游 desired state 置为 cancel/superseded、撤销下游 capability/gate、写 terminate/reconcile/revert commands；
- 在旧 writer 被同 epoch 明确观测为 absent 前，不授予冲突 worktree 的新 writer；
- 每种外部 effect 定义 compensate/reconcile/forward-repair 规则；
- merge 与不可逆删除不能由 Lead 自行“revert/discard”，必须走独立高权限 gate。

### 第 2.6 章：旁路

判定：**正确吸收。**

- 可旁路与不可直接旁路已分类；
- reason/actor/TTL/audit 齐全；
- break-glass 使用独立更强凭据，而非复用 API token；
- capability/generation 和三条红线未被隐藏 flag 绕过。

这正确修正了原成因报告“所有机制都无旁路”的过度概括，也吸收了前次 §3.6。

但 P10/P12 仍需在第 5 章补机制级验收：carrier 错位时走哪条显式 transition、旧 `no-three-stage` 类逃生门如何证明可达。只写“可旁路分类”还不能证明这两个病例回归关闭。

### 第 2.7 章：凭据生命周期

判定：**正确吸收。**

- 自动续期条件覆盖 active attempt、identity/audience、cancel、gate scope、首次冻结的 absolute deadline；
- founder/merge capability 不跟心跳续；
- exact head、single-use；
- TTL 集中配置。

这正确吸收了前次 §3.7，并修正了原报告“所有 TTL 都是同一个值/都应跟心跳续”的错误。

### 第 3 章：告警

判定：**语义正确，数据和错误分类未闭合。**

正确吸收：

- delivery receipt 与 human obligation 分离；
- `depth IN (0,1)` 且 alert parent 不再生 alert；
- target terminal 原子 tombstone；
- founder ledger 只记 confirmed sent，失败进 delivery outbox；
- 明确修正了 `9,104 ledger rows ≠ 3,683 confirmed pages`；
- alert 不再回写它所监管的普通 lead receipt 管道。

未闭合：

1. 如第一章所述，没有可执行上述 CHECK/tombstone 的 authority schema。
2. “告警器只读”需要写成：detector 只读并向 kernel 提 proposal；kernel 原子写 obligation/event/command。否则“只读”与“产生 alert”缺少写入所有者。
3. P8 的核心不是仅限制告警种类，而是把 expected denial 与 execution failure 类型隔离。当前代码就是把保护性 409（`runner-recovery-nudge.ts:195-213`）压成 `nudged:false` 后升级（`runner-receipt-patrol.ts:172-197`）。v1 必须规定 kernel/executor 的机器枚举结果，例如 `stale|policy_denied|noop|retryable_failure|effect_unknown|succeeded`；前三类返回调用方并结清 command，不能转成 alert。仅写“只报三类事”仍可能把 denial 误装成“权威账与现实矛盾”。

因此前次 §3.9 与 P5 已大体吸收，P8 只被**部分吸收**。

### 第 4 章：切换手册

判定：**9 步方向基本正确，但关键 fence 和验收未落地。**

逐项判定：

1. 预演：**部分吸收**。有 standalone migrator、隔离路径、抽样 replay；还应保留 row counts、状态映射、FK/唯一性和业务 invariant 对账。
2. 冻结：**部分吸收**。有关闭 admission 和枚举在途，但漏了持久化 cutover intent，以及每个不能 drain 的 durable checkpoint。
3. 停旧写者：**正确吸收**。Bridge、Lead、runner CLI、巡逻均覆盖；实施清单还应包含 daemon/supervisor 的 PID/tmux 清点。
4. 一致快照：**正确吸收**。使用 online backup API，并明确不能漏 WAL 中已提交内容。
5. 迁移：**部分吸收**。有 FK/CHECK/UNIQUE 与 `integrity_check`，但漏写 `foreign_key_check` 和业务 invariant queries。
6. 安全重置：**基本吸收**。应明确旧共享 API token 也在拒绝清单中，不只撤销旧 workflow capability。
7. epoch fence：**仅写到概念，无法执行**。`tasks/events/commands/source_receipts` 均没有 `cutover_epoch`，observation envelope 也没定义；`attempts.host_epoch` 不能替代 cutover epoch。
8. 启动顺序：**部分吸收**。漏列 dispatcher，且 projector/dispatcher 所有权尚冲突。
9. 回滚点：**正确吸收**。首个 v2 外部 effect 前可回切，之后只能 forward-repair。

此外，“附 go/no-go 清单 7 条”不是实际附录。正式稿必须逐条写出前次七条：

- 所有旧 writer PID/tmux/daemon 已退出；
- 旧 API token 与旧 capability 被拒；
- 每个 active task 至多一个 active attempt；
- 每个 dispatch command 有唯一 generation/effect key；
- 每个 in-flight effect 有 receipt 或进入 reconcile；
- 每个 migrated gate 绑定 exact subject/head；
- DB 权限、integrity、FK、WAL backup 测试通过。

还应补上：旧库切换后只读归档；当前 cutover epoch 持久化；kernel 对 command/observation epoch mismatch fail closed。

### 第 5 章：病例回归矩阵

判定：**覆盖了编号，但映射过粗，四个病例尚未证明关闭。**

- P1/P4/P11：单一权威 + observation/projector 的方向正确。
- P2：outbox 派发与三态探针正确关闭原病理。
- P5：告警深度/tombstone/delivery 分离方向正确，但需 obligation schema。
- P6/P7/P9：分别由 credential lifecycle、独立 founder capability、exact-head gate 正确覆盖。
- P3：不能只映射到“单写者/observation ingress”；必须增加“一 Discord message → 一个 canonical delivery receipt”的唯一约束及无业务义务时不建 human obligation。
- P8：不能只映射到告警章；必须有 expected-denial/result taxonomy。
- P10/P12：不能只映射到抽象“旁路分级”；必须列出具体 escape transition、权限、TTL、audit 和 reachability 回归测试。

前次对病例证据的四项诚实修正也应在正式稿的回归基线中保留：不是“6 个活跃概念双写”；不是“所有机制都无旁路”；founder confirmed pages 是 3,683 而非 ledger 总行数；P3 是“同一消息可能双建”，不是每条消息必然双建。

## 3. v1 新引入但尚未覆盖的问题

### HIGH-1：Lead 可靠性没有目标协议

目标写“补偿层退役换 Lead 可靠”，但 v1 的 supervisor、generation、activation、transcript replay 都只明确用于 runner。现行产品契约要求 “Lead 自己挂了 → 自动恢复，恢复之前的状态继续工作”（`doc/architecture/product-experience-spec.md:221-228`）。

正式稿必须说明：

- 谁监督并重启 Lead；
- Lead 的 durable event cursor/transcript checkpoint 在哪里；
- 同一 Lead generation 如何防止旧进程复活成双写者；
- crash 后怎样重放未处理 founder message/obligation；
- Lead 不可用时 kernel/dispatcher 哪些动作继续、哪些 fail closed。

否则删除旧补偿巡逻后，只是把“复杂但会补偿”换成“简单但 Lead 一挂即停”。

### HIGH-2：notify-then-do 没有 crash-safe ordering

transactional outbox 本身只保证 command 被持久化，不保证“通知 confirmed sent 后才允许动作”。需要在 kernel 中把它变成机械不变量：

- notification command 与 action command 有 durable dependency；
- 只有 notification 的 confirmed-sent receipt 到账，action 才可 claim；
- 通知发送 unknown 时先 reconcile，不能猜测重发或越过；
- retry 使用稳定 effect key；
- 例外 command kind 是明确 allowlist，并分别要求 Ship/delete 的强 gate。

### HIGH-3：Discord 唯一窗口没有 canonical thread/message 契约

应把 `project/issue → canonical Discord thread_id` 作为权威绑定或 gate/source receipt 的明确字段，规定所有 founder ingress、Lead 回复和 Runner 转达都使用该绑定；thread 缺失时由唯一 projector 幂等重建。否则“Discord 唯一窗口”仍只是体验口号，P3 的双 receipt producer 也可能原样保留。

## 4. 必须执行的修改清单

1. **重写 §2.5 逆向打回**：解决 terminal task 不可重开矛盾；引入 successor/rework task lineage；同事务撤权、取消下游并写 terminate/reconcile commands；旧 writer absent 前不授新 writer；为外部 effect 建 compensate/forward-repair/irreversible 分类，删除“默认丢弃旧代码”。
2. **补 command 状态机**：拆分 claim、accepted、executing、succeeded/failed；拆分 `accepted_at` 与 `completed_at`；写清 ack 后崩溃和 effect unknown 的恢复规则。
3. **给 obligation/alert 一个唯一权威模型**：新增 `obligations`，或明确扩展 `gates`；必须能在 schema 中表达 target generation、root/parent/depth、tombstone、resolution，并让 delivery outbox/confirmed ledger 映射到 commands/receipts。
4. **消除 projector/dispatcher 重叠**：为每个 command kind 指定唯一 executor；统一 executor → kernel observation API；同步修正 §1.3、§2.1 和启动顺序。
5. **把 notify-then-do 写成 kernel 可校验协议**：confirmed notification receipt 是后续 action 的 durable prerequisite；明确 Ship 与不可逆删除不是无门槛旁路。
6. **关闭 P3/P8 的具体机制**：canonical Discord source key 消除 `chat:`/`founder_msg:` 双建；增加 expected-denial/result taxonomy，保护性拒绝只返回调用方并结清，不进入 alert。
7. **补 Lead crash recovery**：supervisor、Lead generation/epoch fence、durable cursor/checkpoint、inbox/obligation replay 和旧 Lead 复活拒绝。
8. **补 archive 协议**：原子归档/校验/manifest/幂等、冷区 reader、跨冷热 seq replay、长任务 transcript 恢复。
9. **让 cutover fence 真正可执行**：给 command 与 observation/event envelope 增加 `cutover_epoch`，持久化当前 epoch，kernel fail-closed 校验；补 persisted cutover intent、`foreign_key_check`、业务 invariant queries、旧库只读归档、dispatcher 启动步骤。
10. **把七条 go/no-go 清单实际写入正式稿**，不要只写“照 Codex 原文”；同时把 P3/P8/P10/P12 的具体回归验收加入第 5 章。
11. **修正 §0 范围文字**：说明哪些第三方 API/adapter 不改、哪些 ingress/projector/receipt wiring 必须改，消除“外部集成不动”与第一章方案的冲突。

上述 11 项完成前，v1 仍可能在 ack 后崩溃、逆向打回、旧 epoch 复活和 Lead 崩溃四个窗口重建双写者或假成功，因此结论为 **CHANGES REQUESTED**。
