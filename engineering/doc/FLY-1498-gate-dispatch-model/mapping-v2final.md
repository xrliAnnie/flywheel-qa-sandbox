# FLY-1498 门与图 — v2 终稿映射
Issue: FLY-1498
日期: 2026-07-28
基于: `v2-final-approved-extract.md`、`plan.md`

## 0. 权威、本单边界与 supersession

本映射以仓内 `v2-final-approved-extract.md` 固化的 founder 批准终稿为方向权威；
裁定来源为 `[lead-instruction 319d7eb7-2ea6-4e60-984f-fc493c8e2022]`。四个已确认
默认项是 actions 黑匣子、心跳列、generation、ship 门「使 DAG 达到全成功的事务
内查询 + founder approval 落 `gates` 绑 head」。

FLY-1498 仍是**门与图的设计单**：交付为本映射、细节设计并稿与
`design-FINAL-v2.md` 的权威修订，不新增 `packages/` 实现。当前分支相对 `main`
没有 `packages/` 差异。

评审标签不得跨 head 继承：`8edee281` 的 APPROVED 只覆盖当时的 mapping 缩减载荷；
本映射并入 detail/FINAL 后，以当前 PR head 绑定的 request-driven review 为准。

本映射 APPROVED 后**取代** `plan.md` 中下列旧口径；旧文本不得再按
`plan.md` §3「精确并稿」：

- S2「dispatcher 是 GitHub executor」；
- D3「terminal task 返工创建 `rework_of successor`」；
- C2/C3 中所有 obligation 产出；
- §2.1-§2.4 内引用上述三项的 FINAL 草稿。

保留 `plan.md` 的可信 manifest、`span_tip` 新鲜度链、
`effective_author_set`、完成合同同事务、ship 通用三条与 DAG 零特判；本文件
给出它们在无 obligations、agent-first ship 下的完整收敛形态。

## 1. 终稿 → FLY-1498 范围映射

| 终稿裁定 | 现有 FLY-1498 设计 | 处置 | 收敛后的唯一口径 |
|---|---|---|---|
| 节点自己带完成合同 | `plan.md` C1-C4 | **保留** | `contract = declared ∪ derived`；证据满足清单、activation/attempt/task 完成状态与 tip 推进同一 kernel 事务提交 |
| 合同按实际产出派生 | C2/C3 的可信 manifest、subject digest | **保留并补明作者谓词** | product code → exact-subject 跨族 review；test/docs/空 diff → 免 code review；不读节点名 |
| ship 只验通用三条 | S3 | **保留** | ① current founder approval 绑 tip ②当前 DAG 所有 task 成功 ③fresh GitHub head==tip；无 review/verdict 第四项 |
| ship 是方案乙动作 | S2 的 dispatcher `github_merge` executor | **整块替换** | current-generation agent 亲手 merge；调度只唤醒；agent 工具薄壳用 actions 线性化与记账 |
| actions 黑匣子 | command/effect-key 审计意图 | **落独立 actions 语义** | actions 记录 agent 外呼的 prepared/executing/result；授权仍来自 gate+capability，actions 不是派发器 |
| DAG 是数据 | D1/D2 | **保留** | task dispatch 只读状态、边、active attempt 与 task capability；1/2/N 形状同查询 |
| 返工=同 task 新 attempt | D3 的 successor/lineage 形状 | **整块替换** | 原 task 上原子收尾旧套件并创建新 attempt；DAG 形状不变 |
| generation 防僵尸 | C3 的 generation fence | **保留** | 旧进程迟到写被 current agent/task generation 拒绝 |
| 跨族 review 必须覆盖所有实际作者 | C3 `effective_author_set` | **保留，去 obligation 依赖** | per-worktree `writer_chain` 只做 O(1) span 作者归因/新鲜度，不授予 ship 或外部动作执行权 |
| 病历卡族作废 | gap/超限原来建 obligation；基础 kernel 已有 obligations | **删除 obligation 依赖并标基础代码待清算** | conflict/失败写 event + mailbox；不创建、查询、消费 obligation |
| `ownerLeadId` 作废 | 本单与 v2-kernel 零字段 | **不新增消费者** | gate/action/task/调度均不引入该字段 |
| 调度只「看库→拉进程」 | D1 可用；S2 越界执行 action | **保留 D1，删除 S2 执行权** | dispatcher 仍只有 task dispatch、mailbox 冷启动、heartbeat 重启、风暴刹车四类；另有 kernel-owned、GitHub read-only 的 ActionReconciler 只归档外部既成事实，不拉进程、不路由、不执行 effect |

## 2. 已写代码盘点与删除移交

### 2.1 本分支

- **保留代码：无。** `git diff --name-only main...HEAD` 没有 `packages/` 路径。
- **删除代码：无。** 本单不借设计映射跨范围修改 kernel/v1 runtime。
- **保留文档主干：** `exploration.md`、`research.md` 的问题/现状证据；
  `plan.md` 的 manifest 分类、subject digest、作者集合、span 新鲜度、通用三条、
  DAG 零特判与验收场景。
- **由本映射替换的文档块：** dispatcher GitHub executor、successor/lineage 返工、
  obligation 产出，以及它们在 `plan.md` §2 的 FINAL 草稿副本。

### 2.2 基础 kernel 的 obligations 待删面

以下不是本分支新增，也不由本单删除；schema 所有者必须用**新的前向迁移**清算，
绝不可原地编辑已经登记 checksum 的 0001/0002：

- `packages/v2-kernel/src/migrations/0001-base-schema.ts` 中 obligations 表、索引及
  hierarchy/inherit/task-terminal/attempt-terminal triggers；
- `packages/v2-kernel/src/migrations/0002-obligations-rebuild.ts` 与注册；
- obligations 专属测试及其他 schema/migrator/backup 测试中的相关断言。

清算顺序：新 migration 先 drop 引用 tasks/attempts 的 tombstone triggers，再 drop
obligations 自身 triggers/index/table；旧 0001/0002 文件与
`schema_migrations.checksum` 保持逐字不动。同步更新 schema-contract、backup、
migrator 与 migration failure 测试。

`ownerLeadId`/`owner_lead_id` 在 `packages/v2-kernel` 零命中；禁止新增 v2 consumer。
`packages/teamlead` 同名 v1 detection/ack 字段不是 v2 跨单接口，不在本单删除范围。

### 2.3 tasks、actions、gates 与 thread bindings 前向迁移移交

actions 也必须由新的前向 migration 创建，不改 0001。可以与 obligations 清算合并为
同一 migration（drop obligations + create actions，使权威表数保持不变），也可拆为
连续两条；两种形态都要由 schema 所有者在一个 PR 内原子交付。最小 DDL 合同：

- `effect_key TEXT NOT NULL` 表示稳定的外部 effect identity，
  `action_attempt_no INTEGER NOT NULL CHECK(action_attempt_no > 0)` 表示执行轮次，
  `UNIQUE(effect_key, action_attempt_no)`；同一 effect 至多一个
  `prepared|executing` 行、至多一个 `succeeded` 行（两个 partial unique index）；
- `state CHECK(state IN ('prepared','executing','succeeded','failed','canceled'))`；
- `kind TEXT NOT NULL`；`reconcile_after_ms`、`max_attempts`、
  `retry_backoff_base_ms`、`retry_backoff_cap_ms` 均为正整数不可变策略快照，
  `next_retry_at` 受 state-dependent CHECK；
- `actor_agent_id`、`actor_consumer_generation` 非空；`gate_id`、`target_head` 对通用
  action 可空，但
  `CHECK(kind != 'github_merge' OR (gate_id IS NOT NULL AND target_head IS NOT NULL))`；
- executing/result timestamps 与 result_ref 的 state-dependent CHECK；
- effect identity、attempt number、gate/head/actor 与策略快照字段 immutable triggers；
  同 effect_key 后续 attempt 的策略快照必须等于 attempt 1。

同步更新迁移注册、权威 schema 表清单/表数、backup round-trip、schema-contract、
migrator checksum/failure 测试。`commands` 保留给内部 outbox，actions 不复用其
dispatcher claim 语义。

同一前向迁移还必须显式承接本设计已经改变的三张存量表语义：

- `tasks` 保留稳定 id/project/external issue/kind/state/version/priority/payload/timestamps，
  但以 SQLite table rebuild 新增
  `contract_json TEXT NOT NULL CHECK(json_valid(contract_json) AND
  json_type(contract_json)='array')` 与
  `writes_repo INTEGER NOT NULL CHECK(writes_repo IN (0,1))`。`contract_json`
  是 declared completion descriptors 的 canonical JSON array；无 declared 项必须
  显式写 `[]`。存量行只能从 cutover 时的 canonical task/admission descriptor
  回填这两列；来源缺失整笔 migration fail closed，禁止由 `kind`、节点名、phase
  或路径猜 `writes_repo`；
- 同一次 `tasks` rebuild 删除 `rework_of`、`lineage_root_id` 与
  `tasks_no_self_rework_ins|upd`。task-local generation 继续由
  `attempts.generation + UNIQUE(task_id,generation)` 权威承载，不在 tasks 复制第二份
  counter。rebuild 保留 task id，并在提交前对 attempts/dependencies/events/
  commands/gates/capabilities 等引用执行 `foreign_key_check`；
- `gates` 从现有必填 `task_id` 重建为 issue-scoped gate：`issue_id`、kind、tip、
  DAG membership/contract digest 非空；task_id 仅可作 emitter provenance。以
  partial unique 保证每 issue 至多一个 `open|approved` 的
  `founder_ship_approval` current gate，拒绝用 rowid/opened_at 猜“最新”；
- `thread_bindings` 重建为
  `{binding_kind CHECK(task|issue), binding_id, thread_id, state}` canonical key；
  task attempt 重用 task binding，issue/DAG 共用 issue binding，二者不得混用
  `lineage_root_id` 冒充。

这三项与 drop obligations/create actions 在 schema owner 的同一 PR 原子交付；不改
0001/0002 checksum，表总数仍为 17。迁移完成后的 task 创建 API 必须要求调用者显式
提交 contract_json + writes_repo，不提供按 kind/模板名字的兼容 fallback。

## 3. 节点完成合同与作者归因

### 3.1 manifest 与 fresh span

完成提案只携带当前 task/attempt 身份。事务外由 kernel API：

1. 读取 `base = meta['span_tip:<worktree_id>']`；
2. fresh 观测 canonical worktree `head`；
3. 要求 `git merge-base --is-ancestor base head` 成立；否则
   `span_anchor_diverged` fail closed；
4. 构造 canonical raw diff/manifest 并分类；
5. 用 §3.2 的 `effective_author_set(head)` 构造 review subject digest。

事务外在 manifest 构造后立即再取一次 canonical HEAD observation；所有 git/GitHub
观测都在 `BEGIN IMMEDIATE` **之前**完成，kernel 写回调内禁止网络、subprocess 或
async。进入事务后只校验 observation 携带的 expected 值/version 与库状态：

- identity generation、activation、attempt 仍 current/active；
- `span_tip == manifest.base`；
- pre-transaction HEAD observation 等于 `manifest.head`；
- author-state version 与 manifest 构造时一致；
- declared 与 derived 合同证据全部绑定本次 digest。

授权写者的 generation + writer_chain 单槽保证事务期间没有第二个合法 writer；
旁路进程在 observation 后写入属于诚实边界，最晚由下一 completion gap 或 ship
expected-sha 拒绝。若 task capability `writes_repo=false`，还必须
`observed HEAD == span_tip` 且 manifest 为空，不能把并发写者的 diff 吸进自己的
verdict span。

成功事务按一个 commit 完成 activation terminal、attempt completed、task done、
`node_completed`（manifest digest + 满足项 + evidence refs）、
`span_tip base→head` 与本 span 作者集合清空。任何 fresh-head/base/证据/CAS 失败，
完成状态、tip 与 gate 全部回滚；manifest/review request 等先前 append-only 证据
可留审计但不等于 task 已完成。

### 3.2 authoritative `effective_author_set`

跨族不信 payload、git author 或单个当前 session。每 worktree 保留 kernel-owned、
有界 O(1) 的作者状态：

```text
writer_chain:<worktree_id> = {
  version,
  chain_head,
  open_attempt: {attempt_id, generation, family, start_head} | null,
  span_author_set: set<vendor_family>
}

effective_author_set(observed_head)
  = span_author_set
    ∪ {open_attempt.family
       if open_attempt != null AND observed_head != open_attempt.start_head}
```

它不是 TURN、executor registry 或 ship claim：

- writes-repo task 的 attempt/activation 创建事务顺手登记 `open_attempt`；谁可运行仍
  由 DAG eligibility、active-attempt 唯一约束与 generation 决定；
- **任何 writes-repo attempt** 移入 completed/failed/canceled/superseded 的路径
  都必须调用同一
  `finalize_author_state(observation, expected_writer_chain_version)` 谓词。终态写的
  发起者是 observation owner：活壳正常收尾时由壳负责；runner 崩溃、idle/absence
  收割或恢复对账时由驱动该终态的 reconciler 负责。owner 一律先在事务外观测
  canonical HEAD 并读取 writer-chain version，再把不可变 observation packet
  交给短事务；事务内只校验 version/CAS。若 observed head 从 `start_head` 前进，
  就把 authenticated activation 的 vendor family 折入 `span_author_set`，推进
  `chain_head` 并清 `open_attempt`。非写 attempt 不进入该谓词，照常终态化。
  writes-repo 路径无法取得 fresh observation 或 version 冲突时，**整个终态事务
  fail closed**；任何路径都不得只清 `open_attempt` 而跳过 family 折叠；
- rework/handoff 后保留的未完成 diff 因旧 family 已折入，后续 reviewer 必须不在
  **整个集合**中；
- review request 与 completion 必须调用同一谓词；reviewer family 从当前 reviewer
  execution 的认证 adapter 派生。`reviewer_family ∈ effective_author_set`、未知
  family/source、digest 不同均拒。

这覆盖两条已证实反例：

1. Codex 首个 attempt 推进 H1 后由 Codex 自审；
2. Codex 写一半失败/被 supersede，Claude 在同 span 接手保留 diff，再由 Codex 审。

两者的 author set 都含 Codex，因此不能完成 product-code 合同。

若 `review_capable_families - effective_author_set(observed_head)` 为空，说明当前
product-code span 已穷尽全部可用 reviewer family。选定策略是第三方 reviewer
family fail-closed：completion 不消费同族 review、founder approval 或风险披露，
而是保持 attempt 非终态并原子 append typed `review_family_exhausted` event +
durable mailbox；监督者必须在现有 consumer/capability 配置中增加并认证一个不在
author set 内、具有真实 review transport 的 family，再为同一 subject digest
提交 exact review。未知/手填 family 继续拒绝，不新增 reviewer 表或专用 claim。

没有选择 split review，因为当前 O(1) author set 不提供逐 hunk 的不可伪造归属，
分片也不能证明最终集成后的 exact subject；没有选择“显式披露即通过”，因为披露
不能作为 product-code review evidence。test/docs-only 本来不派生 code review，
可披露既有路由风险而无需伪造合同满足。若部署只有 Claude/Codex 两族，混合作者的
product-code span 就诚实阻塞到第三方 transport 可用；这是保住跨族不变量的可观测
边界，不是按节点场景特判。

canonical HEAD 的正常 observation 先读 worktree；若 worktree 路径已被清理，但
kernel 记录的 canonical branch ref 仍存在，则在验证 cleanup receipt 与进程 absent
后读同 repo 的 exact `refs/heads/<recorded_branch>`，不把 session 快照当权威。
该记录在 issue/worktree admission 事务与 `span_tip`、`writer_chain` 同时写入
`meta['canonical_worktree:<worktree_id>'] =
{repo_identity, worktree_path, branch_ref, merge_target_ref, initial_anchor}`。
admission 事务外计算
`initial_anchor=merge-base(merge_target_ref, observed_head)`，事务内把
`span_tip=writer_chain.chain_head=initial_anchor`；禁止以 admitted HEAD 惰性
初始化。若 observed HEAD 已领先，立即形成普通 writer gap，必须用下段 exact
adoption 归因并只推进 chain_head，span_tip 留在 anchor，保证首个完成节点消费
anchor 以来的全部 diff。

rework/handoff 只换 attempt，不改 branch/target/anchor。清理/重建同一 worktree
identity 只能更新 path，且必须 CAS 原 repo_identity+branch_ref；改变 branch 或
history rewrite 导致 span_tip 不再是 head ancestor 时，expire gate 并拒绝 manifest。
恢复只能先终态化 active attempt，再走普通新 worktree admission 建新 identity；
不得原地把 span_tip 改成当前 HEAD。

若无 `open_attempt` 时 canonical HEAD 不等于 `chain_head`，新 attempt 创建事务
fail closed，append `writer_gap_detected` event 并写 durable mailbox 给监督者；
不建 obligation。恢复仅接受一次性、exact from/to head + attribution family 绑定的
`adopt_writer_gap` capability；同事务记录 adoption event、consume capability、
折入 family、推进 chain。

同一 capability 另有 `lost_open_attempt` 模式，专门覆盖已枚举的「runner 崩溃后
worktree 与 recorded branch ref 均被不可恢复清理」终局。capability 必须绑定
`{worktree_id, open_attempt_id, writer_chain_version, start_head,
resolution_head=span_tip, attribution_family=open_attempt.family,
reason='worktree_and_ref_unrecoverable'}`；事务前探针证明 runner
absent、worktree/ref 均不存在且 resolution_head 在 repo 可达。单事务把 attempt
标 failed、把已认证 open attempt family 折入集合、`chain_head` 复位到
resolution_head、清槽、consume capability，并落 `lost_writer_span_adopted` event
与 durable mailbox。它显式丢弃不可观测产出，task 不会 done，也不产生 ship gate。
该 break-glass 只恢复 lease-between gap 与 lost-open-attempt 两个已枚举场景，不形成
病历卡或执行者认领。

## 4. DAG 事务

### 4.1 task 派发 eligibility

```text
task.state = ready
AND every incoming dependency task.state = done
AND no active attempt exists for this task
AND (task writes repo ⇒ writer_chain.open_attempt is null
     AND pre-transaction HEAD observation == writer_chain.chain_head)
```

调度先在事务外取得 canonical HEAD observation 与 writer-chain version；事务内只
CAS 这些 expected 值。满足后同一事务创建该 task 的 attempt/activation，推进
**task-local `attempt_generation`**，并为 writes-repo attempt 登记 §3.2
`open_attempt`；commit 后调度只负责拉起声明 vendor/model/effort/capability 的
runner。这里不推进 agent 壳的 consumer generation。引擎代码不得含
`design`/`implement`/`qa` 或模板名字面量。

三段式只是三行 task + 两条边；PRD 是单 docs task；QA 是单 verdict task；并行是
多行同时 ready。

### 4.2 同 task 返工原子换装

返工不创建 successor task、不新增回边：

1. `rework_uid` 同 key 重放返回首次结果，异 payload conflict；
2. 直接被打回 task 的 incoming dependencies 必须仍全 done，否则拒绝并要求先打回
   真正的上游；
3. rework actor 先在事务外取得 canonical HEAD observation 与 writer-chain version；
4. 在**武装任何新套件之前**，同一事务先终结/撤销该 task 尚活的旧
   attempt+activation+capability（已 terminal 历史不改），generation 前进，并通过
   §3.2 的统一谓词收尾作者状态；再处理依赖闭包中的下游：
   - 有 active writes-repo attempt → rework actor 复用同一个事务前 canonical HEAD
     observation packet，同事务 supersede attempt、terminal activation、revoke
     capability、收尾 author state；非写 attempt 不需要作者折叠；
   - 已 done 或无 active attempt → 历史 attempt 不改；
   - 两类都只清 terminal marker 并把 task state 按依赖重算为 ready/blocked，
     **不创建新 attempt**；等上游重新 done 后由 §4.1 逐个派发；
5. 断言 `writer_chain.open_attempt IS NULL` 后，才在同一 task 创建新
   attempt/activation；若 writes-repo，再占用唯一 `writer_chain.open_attempt`；
6. 调用 §5.4 ship authority 失效原语；
7. commit 后调度仍只跑 §4.1 查询。

只有直接被打回、且依赖仍满足的 task 在本事务换装；下游不绕过 eligibility，也不
预占唯一 writer 单槽。SQLite 语句顺序必须先执行步骤 4 的全部 release，再求值步骤
5 的 acquire；因此「上游 done、下游 writes-repo attempt 正持槽」时也能在一笔事务
内先收尾下游再武装上游。新套件武装好与旧套件收尾没有分步窗口；DAG identity 与
task id 稳定。

### 4.3 graph membership 变化时开/关门

`maybe_refresh_ship_gate(issue)` 是 kernel 内共享事务谓词，tip 只能读取同一事务
里的 current span_tip；调用者不得传 observed HEAD。所有可能改变
「现行成员是否全 done」的写路径都调用：

- node completion；
- revision/excision；
- cancellation 与 excision 的组合事务；
- rework（只会使条件转 false，走失效原语）。

幂等/失效规则：

- 现行成员全部 done，且 current gate 已是同 tip 的 open/approved → no-op，绝不把
  approved 静默换回 open；
- current gate 是同 tip rejected → no-op，必须由显式重新请求开新 gate；
- tip、DAG membership/digest 或合同实际变化 → 先走 §5.4 失效原语；若变化后的
  现行成员仍全部 done，再在**同一业务事务**开新
  `founder_ship_approval` gate 绑 current tip；
- 无 current gate 且全 done → 开 gate；任一现行成员非 done → expire current。
- canonical HEAD 不等于 span_tip → expire current gate 并发
  `unconsumed_span_blocks_gate`；excision/cancellation 不能吞掉未消费 diff。恢复
  必须由普通 rework/revision 让现行 task 消费该 span，或显式仓库修复把 HEAD
  恢复到 span_tip。

gate_opened event 同事务记录 founder report 引用。没有 scanner；「最后」仍是
查询结果，不是节点身份。这样并行分支被合法 excise 后也不会永远开不出门，同 tip
重复 refresh 也不会抹掉批准。

## 5. agent-first ship

### 5.1 actions 是黑匣子兼线性化记录，不是执行者

`actions` 是 v2 新的 agent 外呼黑匣子，不是旧 `commands` 的改名：

- `commands` 继续承载调度/通知等内部 outbox；
- `actions` 专门记录 agent 亲手触发的外部 effect，最小字段：
  `effect_key, action_attempt_no, issue_id, kind, target_digest/head, gate_id,
  actor_agent_id, actor_consumer_generation, reconcile_after_ms, max_attempts,
  retry_backoff_base_ms, retry_backoff_cap_ms, next_retry_at, state, result_ref,
  timestamps`；
- state=`prepared|executing|succeeded|failed|canceled`；
- actions 行不选择 actor、不派发、不授予权限。授权只来自 current approved gate、
  current agent generation 与 exact-subject one-shot capability。

GitHub merge 的稳定 identity 是
`effect_key = github_merge:<repo>:<pr>:<head>`，每次实际调用递增
`action_attempt_no`。同 key 的失败重试不是第二个 effect；partial unique index
保证同一时刻只有一个 live attempt，GitHub PR + expected-sha 保证最终最多产生一个
merge effect。

### 5.2 ship actor 身份与唤醒

task activation 与 agent shell identity 分开：

- task 完成事务把 task activation terminal；
- agent 壳仍以权威 `consumer_registry` 的
  `(agent_id, consumer_generation)` 作为 mailbox/action 写身份，直到进程退出；
  consumer generation 只在进程注册/cutover/restart 时推进，绝不随 task dispatch
  的 `attempt_generation` 变化；
- `maybe_refresh_ship_gate` 同事务写的 `gate_opened` event 带 authenticated
  `emitter_agent_id`（node completion 时是完成者，revision/excision 时是该变更
  actor）；actor 选择在 founder approval 事务内确定：先选该 emitter（其
  `consumer_registry` 配置存在、可重启且具 GitHub tool capability），否则选
  合并目标 ref 上可信配置快照的 `config.default_action_agent_id`（同样必须可重启
  且具 capability）。二者都不满足
  则 approval 可落 gate，但 action 保持 blocked 并发通用配置错误告警，绝不自报
  actor 或回退 `ownerLeadId`；
- founder approval 事务给选定 logical agent 写 durable mailbox，并签发
  `github_merge` one-shot capability（audience=agent id、subject 精确绑定
  `{gate_id,effect_key,repo,pr,target_head,action_attempt_no=1}`）；
- 若其 current consumer generation 在线，agent 收信后执行；若不在线/heartbeat
  stale，调度只按 `consumer_registry` 中现有 vendor/session 配置重启**同一
  logical agent**，consumer generation+1。旧 generation 不能写；新 generation
  使用同一 logical audience 的 capability；
- 不创建 ship task/attempt，不增加 DAG 节点，也没有 executor registry/claim。

merge capability 的签发点恰好两个且穷举：

1. founder approval 事务为 action attempt 1 签发新授权；
2. ActionReconciler 在同一 current approval、同 head、DAG 仍全 done、未超限的
   §5.3 谓词下，为 attempt 2..N 有界再武装，并落
   `action_capability_rearmed` event。

第二项不是模型自授权或新批准，只是对同一未变化 founder authority 的受限续用；
除这两点外 kernel 拒绝任何 `github_merge` capability mint。

`default_action_agent_id` 是项目级 `.flywheel/config.yaml` 的可选顶层配置，不写入
kernel meta，也没有隐式默认值。actor 选择只读 merge target ref 的可信配置快照，
把 target ref + snapshot digest 记进 approval/gate event；被合并 PR 的配置不能
选择自己的 merge actor。ConfigLoader/admission 先校验它引用现有、可重启且声明
GitHub merge capability 的 logical agent；founder approval 事务前再用该可信快照与
`consumer_registry` 复核。缺失或任一校验失败都走上面的
blocked+typed config alert，不临时挑别的 agent。action recovery 的超龄阈值同样是
项目配置 `actions.executing_reconcile_after_ms`；重试策略是
`actions.max_attempts_per_effect`、`actions.retry_backoff_base_ms` 与
`actions.retry_backoff_cap_ms`。ConfigLoader 要求全为正整数，版本化代码缺省依次为
5 分钟（executing reconcile）、6 次、2 分钟、15 分钟；重试间隔依次
2/4/8/15/15 分钟，总窗口 44 分钟，覆盖一次本仓 10-15 分钟矩阵 CI 后的恢复机会。
approval/prepared 事务把 effective policy snapshot **只写入 actions 行**。
prepared event 仅写 action uid + policy digest 作审计，不复制数值；
运行与重启判定一律读 actions 行，消灭双权威。

如果已选 agent 之后配置被删或无法连续重启，prepared action 不换 audience（防
隐式扩权），按通用 restart budget 失败后告警；修复配置或显式重新批准时重新选择。
批准/gate/action intent 均在库中，不依赖原进程活着。

### 5.3 merge 不可撤销点

收到批准的 agent 先在事务外立即观测 GitHub PR head，然后开一个短 kernel 事务；
写回调内不发网络请求：

1. require current consumer generation + unused exact-subject capability；
2. 只复核库内两条（current approved gate 绑 tip、当前 DAG 全 done），并记录
   pre-transaction PR-head observation==tip；
3. CAS action `prepared→executing` 并 consume capability；
4. commit 后才调用 GitHub merge(expected_sha=tip)；GitHub 的 expected-sha 是
   世界侧第三条的原子兜底，若 observation 后漂移则 merge 拒绝；
5. 结果以 action `executing→succeeded|failed` 结算。

失败/重试是 action 协议，不烧掉仍有效的 founder approval：

- agent 收到 GitHub 的确定失败结果时写 `failed` + typed result_ref；若
  `action_attempt_no == max_attempts`，同一失败结算事务先 CAS
  `executing→failed`，再直接 CAS expire 仍指向同 gate/head 的 current gate、令
  next_retry_at=NULL，并发 `action_retry_exhausted` event + founder mailbox；
  否则按 actions 行固化策略写
  `next_retry_at = failed_at + min(base * 2^(action_attempt_no-1), cap)`；
- §6.3 的 ActionReconciler 是唯一自动重试触发者；到点前 agent、dispatcher 与
  reconciler 均不能新建 attempt；
- 到点后只有 current gate 仍 approved、仍绑同一 tip、当前 DAG 仍全 done、
  PR 仍未 merged、observed head 仍等于 tip，且
  `action_attempt_no < max_attempts`，recovery 事务才可为同一 effect_key 签发新的
  exact-subject one-shot capability、插入 attempt_no+1 的 prepared 行并写选定
  agent 的 durable mailbox；否则先走 §5.4 失效/重批；
- 新 capability subject 同时绑定 gate/head/effect_key/action_attempt_no，不能拿
  前一轮 capability 重放；同 key 的 prior attempt 必须已 terminal，且 partial
  unique index 仍在事务内兜住并发恢复；
- 达到 max_attempts 后只有 fresh founder approval 才能重新开始，不存在静默解除
  上限的路径；
- CI/branch protection 暂时拒绝但 head 未变属于可重试失败；head 漂移绝不是重试，
  必须失效当前 gate 并重新批准。

review、QA、docs、session role 不在该事务谓词中。CI/branch protection 是 GitHub
世界侧 merge 约束，不是 Flywheel 第四条门。v2 激活 Go/No-Go 必须先实测 target
branch required checks 已启用，且所有 merge-capable agent credential 都是不能
bypass rules 的 non-admin actor；任一不满足则继续使用 v1 ship lane，不得激活 v2
merge。激活后红 CI 由 GitHub 原子拒绝并成为可重试 action 失败，ship 短事务不重读
CI。

实测由 v2 lane bootstrap 的真实 GitHub probe 完成：读取 target branch
ruleset/required checks，以及 token actor 的 repository permission 和 bypass
actors。403/unknown、required checks 空集、actor=admin 或命中 bypass list 一律
fail closed，不注册 v2 merge capability，发 typed deployment alert，保持 v1 lane。
probe 结果是 deployment enablement，不进入 gate/ship transaction。

超限结算不调用 §5.4：§5.4 的 executing conflict 保护并发业务变更，不能拿来与
正在结算的 action 自我冲突。这里先把本行 CAS 到 failed、再在**同一事务**直接
expire current gate；SQLite 写串行化保证并发 rework/revision 只能观察整笔结果。

### 5.4 `invalidate_ship_authority`

rework、revision、excision、gate supersession/revocation 与 founder 撤回共用：

- 若同 target action 已 `executing`，业务变更 conflict，等待该不可撤销 effect
  reconcile/终判；
- 否则 CAS cancel `prepared` ship action，把同 gate/effect 下所有 `failed` action
  的 `next_retry_at` 清为 NULL、expire current gate，再提交业务变更；
- action CAS、gate expire、业务状态变更同一事务。

因此两种顺序都线性：

1. 失效事务先赢 → action 永远不能进入 executing；
2. agent 的 executing CAS 先赢 → 失效业务变更让位，不会在批准作废后悄悄 merge。

actions 仍只是事实/互斥账本；GitHub 调用者始终是 agent。

## 6. DAG dispatch、agent wake 与独立 action 对账

### 6.1 task dispatch

只跑 §4.1 DAG eligibility，结果是创建 attempt/activation 并拉 runner。它不读
mailbox 内容、不执行 action。

### 6.2 agent wake/recovery

独立判据：

```text
pending mailbox/action notification exists for agent
AND (agent absent OR heartbeat stale)
AND restart budget permits
```

结果只重启 `consumer_registry` 中的 logical agent 并推进
`consumer_generation`。heartbeat 列由 FLY-1499 建，本单只读；反复失败才告警。
此查询不改变 DAG eligibility，也不把 vendor/model/capability 条件偷偷加进 task
状态判定。

### 6.3 ActionReconciler：executing 对账与有界重试

ActionReconciler 是 kernel-owned 的独立 probe owner：与 kernel 服务同进程、复用
启动/tick 生命周期，但不挂在 dispatcher 接口下；它使用 GitHub read-only
credential，没有 merge 权限。它「读 GitHub 归档已经发生的事实」不等于 founder
终稿禁止的「调度执行外部动作」：dispatcher 仍只看库拉进程，真正 merge 仍只能由
agent 发起。

ActionReconciler 在服务启动与 tick 查询超过 actions 行
`reconcile_after_ms` 的 `executing` 行；也查询到达 `next_retry_at` 的 failed 行。
它不要求原 agent 仍存活，先在事务外读 GitHub，再以 action uid/state、gate/head
与 observation version 做短事务 CAS：

- exact target head 已 merged → `executing→succeeded`，记录 merge commit/ref；
- GitHub 给出该调用的确定拒绝/失败，且 PR 未 merged → `executing→failed`，随后才
  能按 §5.3 的同 gate 重试协议新建 action attempt；
- GitHub 结果仍不确定 → 保持 executing，不把「PR 尚 open」臆断成失败；写去重的
  `action_reconcile_overdue` event + durable mailbox，按 bounded backoff 至少一次
  持续重查并升级人工处理。
- failed 行到点且 §5.3 的 gate/head/count 谓词全满足 → 原子创建下一 prepared
  attempt、签发 one-shot capability、写 agent mailbox；
- gate 已被 rework/revision/revocation 等合法路径失效 → 只把 failed 行
  next_retry_at 清 NULL，静默收尾，不重复 expire、不告警；
- gate 仍 current approved 但 head/DAG 等其他谓词意外变化 → 失效 gate 并发
  `action_retry_precondition_changed` 告警，不调用 GitHub；超限按 §5.3 单独结算。

旧调用与恢复对账即使重叠，effect_key partial uniques、GitHub PR 单次 merge 语义与
expected-sha 仍把世界侧结果收敛为至多一个 merge。所有 GitHub 读取都发生在 SQLite
事务外；对账事务内仍只有 expected observation/CAS。原 agent 永久消失不会让事实
归档失主；外部世界持续不给确定结果时允许 fail-closed 阻塞业务变更并告警，这是
不可伪造外部原子性的诚实边界。

## 7. 推论验收

1. **PRD 单：**单 docs task完成 → 同事务开 gate → founder approve → agent 三条
   复核 → ship；无 code-review 查询。
2. **QA 单：**单 verdict task、test-only diff → 只欠 verdict，不因 task/session 名
   索要 code review。
3. **产品代码：**任意 task 的实际 diff 含 product code，完成事务必须消费
   exact-subject 跨族 review；ship 不复查。
4. **author-set：**首个单写者自审与跨 attempt 保留 diff 后同族 review 均拒；
   genuine cross-family review 成功。
5. **freshness：**manifest 后、pre-transaction HEAD observation 前的 push 在
   completion 拒；observation 后的旁路 push 由下一 span gap 或 ship
   expected-sha 拒；base≠span_tip 仍在 completion 拒。
6. **任意图：**1/2/N、串/并行使用同一 task eligibility 与 gate-refresh 谓词；
   引擎零三段式分支。
7. **返工：**同 task 新 attempt 原子换装；旧 generation 迟到写拒；图形不变。
   含两个 writes-repo 下游的闭包只重算 ready/blocked，不预建 attempt；上游重新
   done 后 §4.1 串行派发，writer_chain 永远至多一个 open attempt。上游 done、
   下游 writes-repo attempt 正持槽时打回上游，事务先 release 下游槽再 acquire
   上游槽，整笔成功且不存在双槽瞬态。
8. **gate refresh：**移除最后一个未完成现行成员的 revision 事务可以当场开 gate；
   同 tip 重复 refresh 不动 open/approved；graph/tip 真变化先失效再按新状态开门；
   rejected 不被自动重开。
9. **ship 三组双序：**rework/revision/founder 撤回各自与 prepared/executing ship
   action 竞态，只有失效先赢 cancel 或 executing 先赢让位两种结果。failed action
   正在退避时 rework 会在同一失效事务清 next_retry_at；到点 reconciler 不再重告
   founder。
10. **冷 ship：**所有 task activation terminal、原 agent 已退出时，调度按
    `consumer_registry` 重启 emitter 的新 consumer generation；emitter 配置不可
    重启时 approval 事务确定性选择 `config.default_action_agent_id`；两者均不可用
    则 fail closed 告警。
11. **generation 解耦：**新 task attempt 只推进 attempt generation，不作废 prepared
    ship actor 的 consumer generation；agent restart 才推进 consumer generation，
    旧进程 action 写被拒。
12. **gap break-glass：**gap 使 attempt 创建 fail closed 并落 event+mailbox；
    capability 不能复用到第二段 gap；adoption 后 HEAD 再漂移/无 attribution family
    均拒；成功折入的 family 会让随后同族 review 拒绝。open attempt 的 worktree 与
    branch ref 均被清理时，普通 adoption 拒，只有绑定 lost-open 全 subject 且
    resolution_head=span_tip 的一次性 capability 能折入 family、failed attempt、
    清槽；task 不 done。
13. **非写者绊线：**并发 writer 推进 HEAD 后，writes_repo=false verdict task
    completion 因 observed HEAD≠span_tip 拒，不吸收 writer diff。
14. **静态守卫：**ship preflight 中无 review/QA/docs/role 条件；DAG engine 中无
    design/implement/qa/template 名字面量。
15. **崩溃终态作者折叠：**writes-repo runner 推进 HEAD 后崩溃，absence
    reconciler 在 failed 事务前取得 observation；该 family 被折入后才清
    open_attempt，随后同族 review 仍拒。缺 observation/version 冲突时 attempt
    保持非终态并告警；非写 verdict attempt 崩溃不经过作者谓词，可正常 failed。
16. **action 恢复：**确定失败且 gate/head 未变可在同 gate 创建递增 attempt 并
    按 2min 指数退避（15min cap）重试，最多 6 次；未到 next_retry_at 无新行，
    第 6 次失败会先结算 failed、再直接 expire gate 并通知 founder；
    head 漂移必须重批。原 agent 消失且 action 卡 executing 时，ActionReconciler
    能采纳已 merged 或结算确定失败；不确定结果保持 executing、反复对账并发超龄
    告警。
17. **配置 fallback：**项目未配/错配 `default_action_agent_id` 且 emitter 不可用时，
    approval 落库但 action blocked+告警；合法配置在 admission 与 approval 前均
    通过 registry/capability 校验。
18. **本设计暴露的真实同族窗口：**R3 `request_id=d323b56b`、reviewed
    head `04bf3335` 可复核：`c777ccae..04bf3335` 同时包含 Claude QA 会话写入的
    测试/报告产物与 Codex implement 会话写入的修复；当前 coordinator 却只按发起
    请求的 implement session family 路由为 `author_family=codex` /
    `reviewer_family=claude`，所以 Claude reviewer 实际审到了 Claude 写的 QA
    增量。风险有界于测试与报告而非产品代码，且 checker 的既有阴性对照实测能发现
    5 处破坏，但这不等价于独立 review，也不消除同族窗口。这个自指证据说明
    `effective_author_set` 必须取该 diff 的真实作者集合，不能取发起请求的会话是谁；
    它不是按 QA session 名写的特例。
19. **reviewer family 穷尽：**混合作者 product-code span 使
    `review_capable_families - effective_author_set = ∅` 时，完成事务写
    `review_family_exhausted` 并保持未完成；披露不能满足 product-code 合同。认证
    第三方 reviewer family 对原 subject digest 做 exact review 后才可重试完成。

## 8. 反 over-reaction 与诚实边界

| 机制 | 已枚举场景 | 根治为何不够 |
|---|---|---|
| effective author set + writer chain | 首写者自审；Codex→Claude 接手保留 diff→Codex 审 | 单 current attempt/vendor 会漏前一作者；git author 可伪造 |
| reviewer-family exhaustion | 同一 product-code span 同时含全部可用 family 的产出 | 同族披露会破坏合同；split review 缺逐贡献权威且不证明最终 subject，故选择第三方 family fail-closed |
| `adopt_writer_gap(lost_open_attempt)` | runner 崩溃后 worktree+branch ref 被清理 | 正常 fresh observation 永久不可能，单纯 fail closed 会永久占 writer 槽 |
| span tip + fresh head 重验 | manifest 后 push；末端旁路 push | 只绑 review head 不能证明 diff span 连续 |
| merge-base initial anchor | 复用带既有 commit 的 feature/残留分支 | admitted HEAD 惰性开链会让首节点前产品代码永远不进合同 |
| actions executing CAS | approval/rework 与在途 merge 双序 | expected-sha 不挡「head 不变但批准已撤」 |
| consumer registry generation identity | DAG 全 done 后 task activation 已 terminal | gate 落库保证授权不丢，但没有 current actor 就无法合法写 action |
| actions 黑匣子/reconcile + 有界 attempt_no | merge 外呼后断电；CI/branch protection 暂拒 | gate/attempt 账不能证明外部 effect；one-shot capability 不能表达同一批准下的安全重试；无上限会形成 GitHub 风暴 |
| heartbeat（FLY-1499） | pending 信但 agent 假活 | mailbox 保证不丢，不能恢复处理者 |
| 事务内 gate refresh | 并行最后节点或 excision 后全 done | 预命名 last/ship node 会重引入形状特例 |

已知场景与终稿取舍：

- **病历卡/obligation 删除：**gap、超限、重启失败场景仍存在；改由 typed event +
  durable mailbox + 通用失败告警承接，不保留一套独立销账卡。
- **无 executor registry/claim：**并发 agent 的唯一外呼由 actions effect-key/CAS
  仲裁；actor 身份来自通用 consumer registry+generation，不建 action 专用认领系统。
- **无 ship node/review-at-ship：**节点合同已在 done 事务消费证据，ship 只读三条。
- **writer_chain 保留但降权：**它只回答「哪些认证 family 实际推进当前 span」与
  fresh gap，不决定谁获得任务或谁能执行 ship，因此不复活 TURN。
- **lost-open adoption 保守多算作者：**即使不可观测产出已显式丢弃，仍把旧
  open-attempt family 折入当前 span；因此接手者完成前该 family 不能做 reviewer。
  这是防同族自审的 fail-closed 取舍，不应“优化”为清槽但不折叠。
- **agent 持有 GitHub merge credential：**方案乙让模型物理持有外呼能力，kernel
  无法阻止跑偏 agent 绕过 wrapper 直接调用 GitHub。事前红线由 founder-only
  authority 合同、one-shot capability、non-admin merge actor + required checks
  的 v2 激活探针承担；探针失败时不得启用 v2 merge lane。
  actions effect-key + GitHub reconcile 只能事后发现/归档绕过，不能把它伪报成
  kernel 已物理消除的风险。
- **世界观测不在 SQLite 原子域：**git/GitHub observation 全在事务外；事务内
  expected values/version/CAS 加 GitHub expected-sha 将竞态收窄并 fail closed，
  但旁路进程仍可能在 observation 后制造下一周期才发现的 gap；provider 持续不给
  executing action 的确定结果时也只能保持阻塞并升级，不能猜测失败。

## 9. 跨单依赖（只保留两条）

1. **vendor adapter 接口（跨单原编号 C5）**已冻结；本单只消费认证后的
   agent/reviewer family 与 generation，不重谈垫片。
2. **heartbeat 列**由 FLY-1499 建；本单 agent wake/recovery 查询只读。

跨单原编号 C4 的 `ownerLeadId` 已随病历卡族作废，不形成第三条依赖。

## 10. APPROVED 后并稿影响面

为避免旧权威自相矛盾，不能只追加三个新节。并稿必须同时：

1. §T：新增 actions、span tip、effective author set；删除 obligation 作为 v2 核心；
2. §1.0/§1.1：schema/terminal rule 改为 actions 黑匣子与同 task 多 attempt；
   meta 键空间增加 `canonical_worktree:<worktree_id>` 的稳定 repo/path/branch 记录；
3. §1.4：dispatcher 只管拉进程，明确不执行外部 action；
4. §1.5：替换为 §5 的 gates/actions/三条/线性化模型；
5. 新 §1.7：写入 §3 完成合同与 author-set/fresh span；
6. §2.5/§2.9：外部 effect 改为 agent wrapper+actions reconcile，不走 dispatcher
   command claim；
7. 新 §2.12：写入 §4/§6，区分 DAG dispatch 与 agent wake；
8. `.flywheel/config.yaml`/ConfigLoader：增加可选
   `default_action_agent_id`、`actions.executing_reconcile_after_ms`、
   `actions.max_attempts_per_effect`、`actions.retry_backoff_base_ms` 与
   `actions.retry_backoff_cap_ms` 的住所、校验和版本化缺省测试；
9. §5/§6：追加 §7 的回归与竞态案例。

`plan.md` §2 的旧并稿文本先由本映射 supersede；mapping review APPROVED 后才按上表
一次性改写 `plan.md`、细节 design-chain 与 `design-FINAL-v2.md`，再进行最终设计
一致性检查。`mapping-v2final-r5-delta.md` 只是 parser 故障下的缩小送审记录，随本
文件同目录留审计；它不是第二份规范，也不并入 FINAL/design-chain。
