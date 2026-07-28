# Flywheel v2 门与派发模型（FLY-1498）

> 评审口径：head `8edee281` 的 APPROVED 只覆盖并稿前 mapping 缩减载荷；本取代版
> 不继承该标签，必须以当前 PR head 绑定的 request-driven review 结果为准。
> 方向权威：founder 批准 v2 终稿；细节来源：
> `engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final.md`。

## 0. 设计合同

1. 每个节点自己携带完成合同，合同满足证据与完成状态同一事务提交。
2. 合同由实际产出派生：product code 要跨族 review；test/docs 不因节点名要 code
   review。
3. ship 是动作，只验 founder approval 绑当前 head、DAG 全成功、head 未漂移。
4. dispatcher 只认 DAG；三段式只是普通图。
5. rework 在同一个 task 上创建新 attempt，旧套件收尾与新套件武装同事务。
6. ship 由 current-generation agent 亲手执行；dispatcher 只唤醒。
7. 不使用 obligations/病历卡、`ownerLeadId`、ship node、action executor registry。

## 1. 数据合同

### 1.1 tasks、attempts 与图

- `tasks` 是稳定 DAG identity；每 task 显式存 `contract_json` 与 `writes_repo`，
  另有 state。task-local attempt generation 由
  `attempts.generation + UNIQUE(task_id,generation)` 承载，不在 tasks 复制 counter。
- `task_dependencies` 只存边；初版 condition 为 NULL。
- `attempts` 保存每次执行；每 task 至多一个 active attempt，历史 terminal attempt
  永不改写。
- `activations` 将 attempt 绑定 session；旧 generation 的迟到写整事务拒绝。
- rework 不创建 successor task 或 graph back-edge。

### 1.2 span 与作者状态

每 canonical worktree 有：

```text
span_tip:<worktree_id> = last completed head

canonical_worktree:<worktree_id> = {
  repo_identity,
  worktree_path,
  branch_ref,
  merge_target_ref,
  initial_anchor
}

writer_chain:<worktree_id> = {
  version,
  chain_head,
  open_attempt: {attempt_id, generation, family, start_head} | null,
  span_author_set: set<vendor_family>
}
```

admission 在事务外读取合并目标 ref 与 canonical HEAD，计算
`initial_anchor=merge-base(merge_target_ref, observed_head)`；事务内把
`span_tip=writer_chain.chain_head=initial_anchor`，并与 immutable
`merge_target_ref/initial_anchor`、canonical worktree 一起创建。禁止用当前 HEAD
惰性初始化 span。若 admission 时 HEAD 已领先 anchor，通用 writer-gap 谓词立即
fail closed；只有 exact from/to head + attribution family 的既有
`adopt_writer_gap` 能把 `chain_head` 推到 admitted HEAD，`span_tip` 仍停在 anchor，
因此首个完成节点必然分类并消费 anchor 以来的全部 diff。

rework/handoff 不改 branch_ref/target/anchor；同 identity 重建只可 CAS path。换
branch 或 history rewrite 后 `span_tip` 不再是 HEAD ancestor 时，当前 identity
拒绝 manifest、expire gate 并发 `span_anchor_diverged`；恢复只能先终态化 active
attempt，再走普通新 worktree admission，以新 merge-base 建新 identity，并按上段
writer-gap 规则归因当前 diff。不得原地把 span_tip 改成当前 HEAD。

```text
effective_author_set(observed_head)
  = span_author_set
    ∪ {open_attempt.family
       if open_attempt != null AND observed_head != open_attempt.start_head}
```

该集合只回答谁实际推进当前 span，不授予 task 或 ship 权限。

### 1.3 actions

`actions` 是 agent 外呼事实账，不是 dispatcher：

```text
effect_key
action_attempt_no
issue_id
kind
target_digest / target_head
gate_id
actor_agent_id / actor_consumer_generation
reconcile_after_ms
max_attempts
retry_backoff_base_ms
retry_backoff_cap_ms
next_retry_at
state = prepared | executing | succeeded | failed | canceled
result_ref
timestamps
```

约束：

- `UNIQUE(effect_key, action_attempt_no)`；
- 同 effect_key 至多一个 prepared/executing、至多一个 succeeded；
- `github_merge` 必须有 gate_id + target_head；通用非 gate action 可为空；
- identity、gate/head/actor 与 policy snapshot immutable；
- 同 effect 的后续 attempt 复制 attempt 1 的 policy snapshot；
- state-dependent timestamp/result/next_retry CHECK。

GitHub merge effect identity：

```text
github_merge:<repo>:<pr>:<head>
```

## 2. 节点完成合同

### 2.1 declared + derived

```text
contract(task, attempt)
  = declared(parse_contract(task.contract_json))
  ∪ derived(classify(canonical_diff(span_tip, observed_head)))
```

声明项可包含：

- `verdict`：绑 task/attempt/head 的 pass/fail；
- `review_approval(kind)`：绑本次 subject digest；
- `artifact(descriptor)`：path/cardinality/digest 约束；
- 空集合法。

派生矩阵：

| actual diff | 派生义务 |
|---|---|
| product code | exact-subject cross-family code review |
| test-only | 无 code review |
| docs-only | 无 code review |
| empty | 无 code review |

节点名、phase、role、三段式位置都不参与派生。

### 2.2 canonical manifest

runner 完成提案只携带 task/attempt identity；kernel API 在事务外：

1. 读 `base=span_tip`；
2. 观测 canonical head；
3. 要求 `base` 是 observed head 的 ancestor；否则 typed fail closed，走 §1.2
   新 identity recovery；
4. 用 `git diff --raw -z --no-abbrev --find-renames --find-copies-harder` 构造
   manifest；
5. 逐 A/D/M/R/C status 校验 regular blob/mode/path；T/U/X/B、symlink、gitlink、
   非法路径、rename/copy 检测退化、超 10k entries/2MB 一律拒；
6. 路径分类：test conventions → test；批准的 doc prefixes → docs；其余
   product code；rename/copy 两端取最严；
7. 计算 manifest digest、author_set digest 与 review subject digest；
8. `BEGIN IMMEDIATE` 前再取一次 HEAD + writer-chain version observation。

所有 git/GitHub 读取都在 SQLite 事务外；写回调内禁止 network/subprocess/async。

### 2.3 完成事务

事务内校验：

- activation/generation/current attempt；
- `span_tip == manifest.base`；
- pre-transaction HEAD observation == manifest.head；
- writer-chain version 未变；
- declared + derived 每项证据 exact-subject 匹配；
- reviewer family 不在 `effective_author_set`。

同一 commit 写：

- activation terminal；
- attempt completed；
- task done；
- `node_completed`（manifest digest、满足项、evidence refs）；
- `span_tip base→head`；
- 清当前 span author set；
- `maybe_refresh_ship_gate(issue, head)`。

任何校验/CAS 失败，完成状态、tip、gate 全回滚；先前 append-only review/manifest
证据可留审计，但不代表节点完成。

### 2.4 writes-repo 终态归因

任何 writes-repo attempt 进入 completed/failed/canceled/superseded 都调用同一
`finalize_author_state(observation, expected_version)`：

- 活壳收尾由壳在事务外观测；
- crash/idle/absence 收割由驱动终态的 reconciler 观测；
- head 从 start_head 前进则折入 authenticated family、推进 chain_head、清槽；
- 无 observation/version 冲突则整笔终态 fail closed；
- 非写 attempt 不进入作者谓词。

worktree 被清理但 recorded branch ref 仍在时，以 cleanup receipt + process absent
证明后读 exact ref。两者都不可恢复时，只接受一次性
`adopt_writer_gap(lost_open_attempt)`，subject 必须绑定 worktree/open attempt/
version/start/resolution_head=span_tip/open family/fixed reason。事务把 attempt failed、
保守折入 family、复位 chain_head、清槽、consume capability、写 event+mailbox；
task 不 done。即使丢弃了不可观测产出，该 family 仍留在本 span，接手完成前不能做
reviewer。

### 2.5 reviewer family 穷尽

product-code 合同先从现有 consumer/capability 配置读取已认证且具备 review transport
的 `review_capable_families`，再计算：

```text
eligible_reviewer_families
  = review_capable_families - effective_author_set(observed_head)
```

集合非空时，选择其中任一 family 做现有 exact-subject review；集合为空时，不得把
同族 review、founder 批准或风险披露充作 product-code review evidence。completion
事务保持未完成，并 append typed `review_family_exhausted` event + durable mailbox。
唯一通过路径是配置并认证一个不在 author set 内、具备 transport 的第三方
reviewer family，再对同一 subject digest 完成 review；未知/手填 family 仍拒。
这里复用现有 consumer/capability 配置，不新增表或 reviewer 专用 claim。

三个选项的裁决：

- **拆分评审不选：**当前 O(1) author set 没有逐 hunk 的不可伪造归属，也无法证明
  分片 review 覆盖最终集成后的 exact subject；为它新增贡献账会扩成另一套机制。
- **显式披露只承接非产品代码：**test/docs-only 本就不派生 code review，可以像
  本单 R3 一样披露现有 v1 路由窗口；披露不能满足 product-code 合同。
- **第三方 family，选定：**它保留“每个 product-code byte 都由真实作者集合之外的
  family 审 exact subject”这一条不变量。若部署暂时只有 Claude/Codex 两族，混合
  作者 product-code span 就诚实 fail closed，直到第三方 transport 可用。

## 3. DAG 与返工

### 3.1 唯一 dispatch eligibility

```text
task.state = ready
AND every incoming dependency task.state = done
AND no active attempt exists
AND (
  task.writes_repo = false
  OR (
    writer_chain.open_attempt IS NULL
    AND observed_head = writer_chain.chain_head
  )
)
```

调度在事务外取 HEAD/version，事务内 CAS 后创建 attempt+activation、推进 task-local
generation，并为 writes-repo attempt 占 open_attempt。commit 后只拉起声明的
vendor/model/effort/capability runner。

PRD 单是一个 docs task；QA 单是一个 verdict task；三段式是三行两边；并行是多个
ready 行。引擎不得出现 design/implement/qa/template 名字面量。

### 3.2 同 task rework 原子换装

1. `rework_uid` 同 key 同 payload 返回首次结果，异 payload conflict；
2. 被打回 task 的 incoming dependencies 必须仍全 done；
3. 事务外取 canonical HEAD + writer-chain version；
4. 同事务先 terminal/revoke/release 被打回 task 与依赖闭包中所有 active 套件；
   writes-repo 统一 finalize author state，非写跳过；
5. 下游 historical attempts 不改，只清 task terminal marker 并按依赖重算
   ready/blocked，不预建 attempt；
6. 断言 writer slot 已空，再为被打回 task 创建新 attempt/activation；若写 repo，
   才 acquire slot；
7. 同事务 `invalidate_ship_authority`；
8. commit 后仍由 §3.1 通用查询派发下游。

release 必须先于 acquire 求值，覆盖“上游 done、下游 writes-repo 正持槽”场景。

### 3.3 gate refresh

completion、revision/excision、cancellation 与 rework 都调用
`maybe_refresh_ship_gate(issue)`。tip 只能读取同一事务里的 current `span_tip`，
调用者不得传 observed HEAD 或自行选 tip：

- 当前成员全 done 且同 tip open/approved → no-op；
- 同 tip rejected → no-op，需显式重开；
- graph/tip/contract 变化 → 同事务先失效，再按新成员状态决定是否开门；
- 任一成员非 done → expire current gate；
- canonical HEAD 不等于 span_tip → expire current gate，发
  `unconsumed_span_blocks_gate`，绝不把未完成 diff 绑进 gate。恢复只允许通过普通
  rework/revision 让某个现行 task 消费该 span，或由显式仓库修复把 HEAD 恢复到
  span_tip；excision/cancellation 本身不吞 diff；
- gate opened event 带 authenticated emitter_agent_id。

“最后”只由查询结果定义，不存在 ship/last 特殊节点。

## 4. agent-first ship

### 4.1 actor 与授权

founder approval 事务把 gate approved 绑 exact tip，并选择：

1. 可重启且具 GitHub merge capability 的 gate emitter；
2. 否则合并目标 ref 上 `.flywheel/config.yaml` 的
   `default_action_agent_id`；
3. 都不可用则 approval 可落库，但 action blocked + typed config alert。

配置无隐式 fallback；admission 与 approval 前都校验 agent/registry/capability。
actor 选择只读 merge target ref 的可信配置快照，snapshot digest 与 target ref
同 approval/gate event 落库；被合并 PR 的配置不得影响本次 actor 选择。
task attempt generation 与 agent consumer generation 分离。

merge capability 的 mint 点恰好两个：

1. founder approval 为 action attempt 1 签发，subject 精确绑定
   `{gate_id,effect_key,repo,pr,target_head,action_attempt_no=1}`；
2. ActionReconciler 在同一 approval/head、DAG 仍全 done、未超限时为 attempt 2..N
   有界再武装，并落 `action_capability_rearmed`。

第二点只是原批准的受限续用，不是新授权。

### 4.2 ship 三条与线性化

agent 事务外观测 PR head，然后短事务：

1. require current consumer generation + unused exact capability；
2. require current approved gate 绑 tip；
3. require current DAG all done；
4. record pre-transaction PR-head observation == tip；
5. CAS action prepared→executing 并 consume capability。

commit 后 agent 调 `GitHub merge(expected_sha=tip)`；GitHub expected-sha 承担世界侧
head 未漂移。结果结算 executing→succeeded|failed。

review、QA、docs、session role 不在该谓词。CI/branch protection 是 GitHub 世界
约束，不是 Flywheel 第四条门。v2 激活 Go/No-Go 必须先证明 target branch 的
required checks 已启用，且所有可获 merge capability 的 agent credential 都是
不可绕规则的 non-admin actor；不满足则保留 v1 ship lane、不得激活 v2 merge。
激活后红 CI 由 GitHub 原子拒绝并进入本 action 的有界 retry，ship 短事务不重读 CI。

这里的“证明”是启动时真实 GitHub probe，不是配置声明：读取 target branch
ruleset/required checks 与 token actor repository permission/bypass actors；403、
unknown、required checks 空集、actor=admin 或 actor 在 bypass list 均 fail closed。
失败时不向该 agent 注册 v2 GitHub merge capability，写 typed deployment alert，
并保持 v1 lane；成功结果只决定 lane 是否启用，不写入某次 ship 的第四个谓词。

### 4.3 失效双序

`invalidate_ship_authority`：

- 同 target action executing → 业务变更 conflict，等待 effect 终判；
- 否则 cancel prepared、清同 gate/effect failed.next_retry_at、expire gate，再提交
  业务变化；
- action/gate/business CAS 同一事务。

失效先赢则 action 永不能 executing；executing 先赢则业务变化让位。

### 4.4 retry 与 reconcile

actions 行固化：

```text
executing_reconcile_after = 5min
max_attempts = 6
retry_base = 2min
retry_cap = 15min
retry intervals = 2 / 4 / 8 / 15 / 15min
```

ActionReconciler 是 kernel-owned、GitHub read-only probe；与 kernel 同进程但不属于
dispatcher，没有 merge credential：

- stale executing：exact head merged → succeeded；确定拒绝 → failed；不确定 →
  保持 executing、去重 overdue event+mailbox、bounded-backoff 重查；
- due failed 且 gate/head/DAG/PR/count 全满足 → 新 prepared attempt+capability+
  agent mailbox；
- gate 已合法失效 → 清 next_retry_at，静默终局；
- gate 仍 approved 但 head/DAG 意外变化 → 失效并发 typed alert；
- 第 6 次失败 → 先 action failed，再同事务直接 expire gate+founder mailbox；该
  action 自身结算不调用会对 executing 自冲突的失效原语。

## 5. 三个独立运行循环

1. **task dispatch**：只跑 DAG eligibility，创建 attempt/activation 并拉 runner。
2. **agent wake**：pending mailbox/action notification + absent/stale heartbeat +
   restart budget → 重启 consumer_registry 中同一 logical agent，generation+1。
3. **ActionReconciler**：只读 GitHub 对账既成事实与到点重试，不拉进程、不 merge。

FLY-1499 建 heartbeat 列；本设计只读。vendor adapter 已冻结；这是仅有两条跨单
依赖。

## 6. 验收矩阵

1. PRD 单：docs task 完成后 gate/approve/ship 畅通，无 code review 查询。
2. QA 单：verdict + test-only diff 只满足 verdict，不索要 code review。
3. product code：任意节点实际 diff 含 product code，必须消费跨族 exact review。
4. 首写者自审、跨 attempt 保留 diff 后同族 review 均拒。
5. manifest 后 observation 前 push 在 completion 拒；observation 后 push 由下一
   gap 或 ship expected-sha 拒。
6. 1/2/N、串/并行、三段式都走同一 eligibility/gate refresh。
7. 活下游持 writer slot 时打回上游，先 release 后 acquire，事务成功无双槽瞬态。
8. rework/revision/founder revoke 与 prepared/executing action 的双序均线性。
9. failed retry 等待期发生正常 rework，会同事务清 next_retry_at，后续不告警。
10. 原 agent 退出后，consumer generation 重启；旧进程 action 写拒。
11. lost worktree/ref 只有 exact lost-open capability 可清槽；task 不 done，旧 family
    仍禁止做当前 span reviewer。
12. stale executing 在原 agent 永久消失后仍能 reconcile；不确定结果不猜失败。
13. 第 6 次 merge failure 结算 failed 后 gate expired，必须 fresh founder approval。
14. ship preflight 静态 grep 无 review/QA/docs/role；DAG engine grep 无节点名/模板名。
15. admission HEAD 已领先 merge-base 时先形成 writer gap；首个 done 前必须归因并
    分类 anchor 后全部 diff，不能以 admitted HEAD 惰性开链。
16. target branch required checks + non-admin merge actor 的激活探针失败时 v2 lane
    不启用；ship 事务仍只有三条。
17. 本设计自身已经产生一次真实同族窗口：R3 `request_id=d323b56b`、reviewed
    head `04bf3335` 的 `c777ccae..04bf3335` 增量同时含 Claude QA 会话写的测试/
    报告与 Codex implement 修复；现有路由只看发起请求的 implement session，
    因此记录为 author=codex/reviewer=claude，Claude 实际审到 Claude QA 产物。
    该风险有界于测试/报告且 checker 既有 selftest 实测检出 5 处破坏，但仍是已知
    同族窗口。它直接证明 reviewer 必须由 diff 的真实作者集决定，不能由请求会话
    family 决定；这不是按 QA 节点名特判。
18. product-code span 的 `effective_author_set` 穷尽全部 review-capable families
    时，completion 写 `review_family_exhausted` 并保持未完成；同族 review、披露与
    founder approval 均不能解锁。配置并认证第三方 reviewer family 后，同一
    subject digest 的 exact review 才能满足合同。test/docs-only 不派生该合同。

## 7. 反 over-reaction 与诚实边界

| 机制 | 已枚举场景 | 为什么更简单的根治不够 |
|---|---|---|
| writer_chain + author set | 首写者自审、跨 attempt 保留 diff | current attempt/git author 会漏真实作者 |
| reviewer-family exhaustion | 同一 product-code span 已由所有可用 family 推进 | 同族披露破坏跨族不变量；拆分 review 缺逐贡献归属且不证明最终 exact subject，故选第三方 family fail-closed |
| merge-base initial anchor | 复用既有 feature branch/残留分支 | 以 admitted HEAD 惰性开链会让首节点前代码永远不进合同 |
| lost-open adoption | crash 后 worktree+ref 被清理 | fresh observation 永久不可能，单 fail-closed 永久占槽 |
| actions executing CAS | approval/rework 与 merge 双序 | expected-sha 不挡 head 不变但批准撤回 |
| bounded retries | CI/branch protection 暂拒 | 单 one-shot 无法安全续用；无界则 GitHub 风暴 |
| ActionReconciler | merge 外呼后断电 | gate/attempt 账不能证明外部 effect |
| consumer generation | task terminal 后 cold ship | gate 落库不等于仍有合法 actor |
| heartbeat | pending 信但 agent 假活 | durable mailbox 不会自己恢复处理者 |
| gate refresh query | 并行最后完成/excision | 预命名 last node 会复活形状特例 |

诚实边界：

- agent 物理持有 GitHub credential，kernel 不能阻止其绕 wrapper；founder authority、
  one-shot capability、non-admin actor + required checks 是 v2 激活前的世界侧
  结构边界，actions 只能记账/对账；该结构边界未满足时不得声称 v2 ship 安全等价。
- git/GitHub 不在 SQLite 原子域；事务外 observation + CAS + expected-sha 收窄竞态，
  observation 后的旁路写可能到下一周期才被发现。
- provider 长期不给 executing 的确定结果时，只能 fail closed + alert，不能猜失败。
- lost-open family 保守多算会拒绝一个本可安全的 reviewer；这是防同族自审的有意
  假阴性。

## 8. 删除与后续实现边界

- obligations/病历卡与 `ownerLeadId` v2 consumer 删除；失败改 typed event + durable
  mailbox。
- 已登记 checksum 的 0001/0002 migration 不改；schema owner 以后向 migration：
  1. 重建 tasks，新增 canonical-JSON-array `contract_json` 与 boolean
     `writes_repo`，只从 canonical task/admission descriptor 回填，缺失 fail
     closed；删除 `rework_of`、`lineage_root_id` 与两个 self-rework trigger，保留 id
     并在提交前跑 foreign_key_check；
  2. drop obligations/create actions；
  3. 重建 gates 为 issue-scoped current gate（含 issue_id/tip/DAG digest/同 issue
     单 current partial unique）；
  4. 把 thread_bindings 重建为显式
     `{binding_kind=task|issue,binding_id}` canonical identity。
  四项在同一 schema-owner PR 原子交付，并同步 schema/backup/migrator tests；task
  创建 API 必须显式提交 contract_json+writes_repo，不得按 kind/节点名回退。
- `commands` 继续做内部 outbox；actions 不复用 dispatcher claim。
- 本设计不加 feature flag，不修改 v1 runtime，不引入 PRD/QA/三段式特例。
