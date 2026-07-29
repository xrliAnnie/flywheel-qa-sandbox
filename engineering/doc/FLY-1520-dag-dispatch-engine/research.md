# FLY-1520 DAG 派发引擎 — 调研
Issue: FLY-1520 (https://linear.app/geoforge3d/issue/FLY-1520/v2上线批次-dag-派发引擎-派发器只认-dag-节点完成合同运行时-generic-ship-执行器-三层模型1498-设计的实现)
日期: 2026-07-28
基于: exploration.md

## 0. 裁定输入(brainstorm gate,Lead 已拍)

- **Q1 = 路线 A(零迁移映射)**,配套三条硬要求:
  1. 解析层 fail-closed:payload 合同字段缺失/不可解析 = 拒,**绝不回退按 kind/节点名猜**;
  2. 静态围栏测试:全仓除 admission API 外无第二个 tasks.payload 合同字段写入点(grep 级);
  3. 有记录的偏离:设计 §8 字面(列/表重建)→ 本单 payload+meta 承载,mapping 文档明写偏离 + 提升路径,跨族评审必须看到。
- ship_gate:{issue_id} meta 键值必须带 epoch/generation 防旧 writer 重放。

## 1. 消费面清单(实测签名,非猜测)

### 1.1 flywheel-v2-kernel

| API | 语义 | 本单用法 |
|---|---|---|
| Kernel.open / write(label, fn) / read(fn) | BEGIN IMMEDIATE 同步事务;嵌套 write 抛 NestedWriteViolation;事务预算 1s;façade 拒连接态 SQL | 所有引擎事务的唯一入口 |
| WriteTx.cas(sql, params, expected=1) | 行数不符抛 CasViolation → 整体回滚 | 状态 CAS/围栏 |
| WriteTx.requireIdentity(key, expected) | meta registry 身份比对 | runner 提交完成提案时校验 |
| FENCE.capabilityConsume | capability 单次消费 CAS(占位,注释指名归 1498 批次接线,第一个 call site + tests 归接手方=本单) | ship intent 事务内消费 |
| FENCE.activationCasActiveTerminal / attemptCasActiveTerminal | activation/attempt 终态 CAS | 完成/换装/收割 |
| recordActionIntent(tx 内 via options.prepare) / recordActionOutcome / runRecordedAction | actions 黑匣子;intent 事务可注入 prepare(tx) 钩子;outcome 有 actor generation 触发器(旧世代拒迟到改写) | ship 执行器 |
| migrateDatabase / DEFAULT_V2_DB_PATH | 全链迁移 | 测试建库 |

**关键约束**:`enqueue`(v2-engine)自带 kernel.write —— 不能在本单事务内调用。
设计要求「typed event + durable mailbox 与业务变化同事务」(如 review_family_exhausted、
unconsumed_span_blocks_gate),因此本单需要内部 `appendMailboxTx(tx, envelope)`
helper:在调用方事务内按 canonical 合同(UNIQUE(source_kind,source_id) 幂等、
retention_class、事务内读 cutover_epoch、收件人存在校验)直接 INSERT mailbox 行。
这是对 1499 mailbox 写入面的一处有记录复用(~20 行 SQL),不是新通道;
1518 不改 mailbox 插入形状。

### 1.2 flywheel-v2-engine(只包级 import,不碰 1518 目标文件)

| API | 语义 | 本单用法 |
|---|---|---|
| registerAgentTx(tx, runtime, agentId, draft, evidence?) | runner 注册**要求 activation 已存在且 active**;换代需 DeathEvidence;新代=旧代+1 | 派发事务预建 activation → spawn → runner 注册 |
| enqueue / provisionAgentRecipient | 独立事务的 mailbox 入队(通知类,不要求同事务时用) | spawn 后的门铃类通知 |
| InjectionShim(hint/deliver) | 已冻结 vendor adapter 合同 | 本单不实现、不复制,E2E 用假 shim |

**1518 退役预告**:attempts 的 observed_state/observation_kind/observed_at 列将随
1518 退役(FLY-1500 mapping 逐块处置表明文)。**本单引擎不得读写这三列**
(INSERT 走默认值即可)。

### 1.3 flywheel-v2-actions

`runRecordedAction({kernel, action, prepare?, perform})`:
intent 事务(prepare 钩子在内)→ 事务外 perform() → outcome 事务。
effect_key 每 attempt 唯一;logical_key 每 effect 一根(partial unique);
重试必须显式 supersedes + retry_basis{evidence_ref,reason};replay 同 key 返回已有行不重呼。

### 1.4 v2-scheduler(FLY-1501)

现状只有 stale-Lead 心跳修复循环(agents.last_poll_at → launchd kickstart)。
其 ports 模式(LaunchdPort/RestartGatePort/MemoryPort 注入)是本单 dispatch ports
的样板。**本单不改 v2-scheduler**;常驻循环把 dispatchOnce 接进谁(scheduler CLI
或独立 launchd target)归 FLY-1502。

## 2. 数据落点(路线 A 全展开)

### 2.1 tasks.payload 合同承载(canonical JSON)

```
tasks.payload = {
  "contract": [ ...declared items,canonical JSON array,可空数组... ],
  "writes_repo": true|false,
  "worktree_id": "<canonical worktree id>" | null   // writes_repo=true 必填
}
```

- **唯一写入点** = admission API(admitIssueDag)。读写双侧 fail-closed:
  解析失败/字段缺失/多余顶层字段 → 该 task 拒绝派发与完成,同事务 typed event
  `task_contract_invalid` + durable mailbox;绝不按 kind/节点名推断。
- declared item 形状(详设 §2.1):`verdict` / `review_approval(kind)` /
  `artifact(descriptor)`;空数组合法。
- 静态围栏测试:grep 断言除 admission 模块外无第二处写 tasks.payload 合同字段。
- **有记录偏离**:设计 §8 要求 contract_json/writes_repo 为 NOT NULL 列;本单以
  payload 承载,不变量由 kernel 唯一写入口强制;提升为列的机械迁移路径留给
  1502/独立 schema 单(payload 字段 → 列拷贝 + NOT NULL 校验,单向、可脚本化)。

### 2.2 tasks.state 子集与含义

现表 CHECK: draft/ready/running/blocked/review/done/canceled。本单使用子集:

| state | 含义 |
|---|---|
| ready | 可参与 eligibility(上游是否全 done 由查询 JOIN 判断,不复制进 state) |
| running | 存在 active attempt(派发事务置) |
| done | 完成事务置(合同满足同事务) |
| canceled | 显式取消 |
| draft / blocked / review | **本单不使用**;admission 一律建 ready。静态围栏:引擎不出现这些字面(review 尤其不能出现——它是节点名味道) |

rework 打回:被打回 task 及下游 done→ready(同事务),按依赖重算的「blocked」概念
由 eligibility 查询表达(上游非 done 就派不出去),不落 state 列——少一份要同步的
冗余状态,消灭 ready/blocked 漂移窗口。

### 2.3 meta 键空间(全部 canonical JSON,值内带 fence 字段)

| 键 | 值(要点) | 写者 |
|---|---|---|
| span_tip:{worktree_id} | {head, updated_by_attempt, revision} | admission(初始=anchor)/完成事务(推进)/adopt_writer_gap(复位) |
| canonical_worktree:{worktree_id} | {repo_identity, worktree_path, branch_ref, merge_target_ref, initial_anchor} — path 可 CAS,其余 immutable | admission |
| writer_chain:{worktree_id} | {version, chain_head, open_attempt:{attempt_id,generation,family,start_head}|null, span_author_set:[family...]} | 派发(acquire)/终态(release+折叠)/writer-gap |
| ship_gate:{issue_id} | {gate_id, kind:"founder_ship_approval", state:open|approved|rejected|expired, tip, dag_digest, contract_digest, revision(单调), cutover_epoch, approved_head?, emitter_agent_id?, actor_agent_id?, actor_generation?, config_digest?, capability_id?} | gate refresh/founder approval/失效原语 |

- 防旧 writer 重放(Lead 要求):值内 revision 单调递增,所有更新 CAS
  形如 UPDATE meta SET value=... WHERE key=? AND json_extract(value,'$.revision')=?;
  另带 cutover_epoch,与库内 epoch 不符即拒。
- gates 表行:每次 gate opened/approved/… 落一行审计(task_id = 触发完成事务的
  emitter task,设计明文允许的 provenance 用法;subject_digest = tip+dag_digest
  复合 digest)。**current 判定只看 meta 键,绝不按 gates rowid 猜**(设计原文)。

### 2.4 attempts / activations 生命周期(三层模型)

```
task ──1..n── attempts(UNIQUE(task_id,generation),至多一 active)
attempt ──1..n── activations(至多一 active;session_ref 至多一 active)
```

- 派发事务:INSERT attempt(desired_state='dispatched', generation=task-local 单调,
  worktree_id, vendor/model 来自 task 声明)+ INSERT activation(active,
  session_ref=派发器预分配,如 v2dag:{attempt_id}:{generation})+ tasks.state
  ready→running CAS + writes_repo 时 writer_chain.open_attempt 占槽(CAS revision)。
  commit 后才 spawn(ports)。崩在 commit 与 spawn 之间 = attempt 挂着无进程,
  由收割路径(§2.6)以 absence 证据终态化,幂等重放安全。
- resume:同 session 体新 activation + agents.generation+1(registerAgentTx 既有
  语义);旧 activation CAS terminal 与新建同事务(设计 §1.1 原子换代)。
- attempts.desired_state 只用 dispatched/terminal(started 可选,不承担正确性);
  observed_* 三列不触碰(1518 将退役)。

### 2.5 完成合同运行时(git 观测边界)

事务外(GitPort,execFile git,注入可测):
1. 读 span_tip、canonical_worktree;
2. git rev-parse 观测 canonical HEAD;要求 span_tip 是 HEAD ancestor
   (git merge-base --is-ancestor),否则 typed fail `span_anchor_diverged` + expire gate;
3. git diff --raw -z --no-abbrev --find-renames --find-copies-harder {span_tip}..{HEAD}
   构造 manifest:逐条 A/D/M/R/C 校验 regular blob/mode/path;T/U/X/B、symlink、
   gitlink、非法路径、rename/copy 退化、>10k entries、>2MB 拒;
4. 路径分类:test conventions→test;批准 doc prefixes→docs;其余 product;
   rename/copy 两端取最严;
5. digest:manifest / effective_author_set / review subject;
6. BEGIN 前重取 HEAD + writer_chain.version observation。

事务内(单 kernel 事务):校验 activation/generation/current attempt、
span_tip==manifest.base、observation==manifest.head、writer version 未变、
declared+derived 每项证据 exact-subject、reviewer family ∉ effective_author_set;
同 commit 写 activation terminal、attempt completed、task done、node_completed
event、span_tip 推进、清 author set、maybe_refresh_ship_gate(issue)。
任一 CAS/证据失败整体回滚。

- effective_author_set = span_author_set ∪ {open_attempt.family if HEAD≠start_head}。
- review_capable_families 来自现有 consumer/capability 配置;
  eligible = capable - authors;空集 → typed `review_family_exhausted` + mailbox,
  task 保持未完成(同族 review/披露/founder 批准都不解锁)。
- test/docs-only/空 diff 不派生 code review(纯 PRD/QA 单验收的机制根)。

### 2.6 writes-repo 终态归因(统一 finalize)

completed/failed/canceled/superseded 全路径调用同一
finalize_author_state(observation, expected_version):head 自 start_head 前进 →
折入 authenticated family、推进 chain_head、清槽;无 observation → 整笔 fail
closed。壳收尾在事务外观测;crash/absence 收割由 reconcile 端口观测(进程不在 +
worktree/ref 读取)。worktree+ref 双失 → 仅 exact `adopt_writer_gap(lost_open_attempt)`
一次性收口(attempt failed、保守折 family、复位 chain_head、清槽;task 不 done)。

### 2.7 rework(同 task 原子换装,设计 §2.5/详设 §3.2)

rework_uid 幂等(同 key 同 payload 返回首次,异 payload conflict);同事务顺序:
先 terminal/revoke/release 被打回 task 与依赖闭包内全部 active 套件(writes-repo
统一 finalize,非写跳过)→ 下游 task done→ready(历史 attempt 不改、不预建 attempt)
→ 断言 writer slot 已空 → 为被打回 task 建新 attempt/activation(需要时 acquire)
→ invalidate_ship_authority。release 必须先于 acquire 求值(上游 done、下游
writes-repo 正持槽的场景)。

### 2.8 generic ship(agent-first,三条谓词)

- founder approval 事务:校验 DAG 全 done + tip==span_tip → ship_gate CAS
  open→approved(绑 exact tip)→ 选 emitter(可重启 + 有 merge capability)或
  merge target ref 上可信配置 default_action_agent_id(config digest 同落)→
  INSERT capabilities 行(subject_digest 绑 {gate_id, logical_key, repo, pr,
  head};one-shot)→ durable mailbox 通知 actor。都不可用 → approval 落库 +
  action blocked typed alert(capability 不签)。= capability mint 点 1。
- ship 执行(runRecordedAction):事务外观测 PR head;prepare(tx) 钩子内:
  requireIdentity(current generation)+ FENCE.capabilityConsume CAS +
  ship_gate CAS(approved 且 tip==观测 head,revision fence)+ DAG all-done
  重查;intent 落账(logical_key=github_merge:{repo}:{pr}:{head})→ commit 后
  GitHub merge(expected_sha=tip)→ outcome 事务结算。
  **谓词恰三条;review/QA/docs/role/CI 不出现**(静态 grep 验收)。
- invalidate_ship_authority(rework/revision/revoke 共用):同 logical_key 有
  intended(在飞)→ 业务变化 conflict 等终判;否则 revoke capability + expire
  gate + 提交业务变化,同一事务。失效先赢则 intent 的 prepare 必失败
  (capability 已 revoke);intent 先赢则业务变化让位 —— 双序线性化。
- reconcile(只读 GitHub probe 端口):stale intended 的 github_merge →
  exact head merged=观察性结算(actor 世代仍 current 时直接 outcome;已换代时
  outcome 触发器拒 → 由当前世代 agent 落 supersede 行记录观察结果,原行留作
  诚实 unknown 窗口)→ 不确定不猜失败,去重 overdue 告警;有界再武装
  (同 approval/tip、DAG 仍全 done、未超限)= capability mint 点 2 +
  action_capability_rearmed 审计。重试预算按设计缺省
  5min/6 次/2min base/15min cap,快照存 ship_gate 值内(immutable)。
- 第 6 次失败:action failed 结算 + 同事务 expire gate + founder mailbox,
  需 fresh approval 重开。

### 2.9 dag_digest / contract_digest

gate refresh 需要「graph/tip/contract 变化 → 先失效」;定义:
- dag_digest = sha256(canonical JSON of sorted [task_id, state, incoming edges]);
- contract_digest = sha256(canonical JSON of sorted [task_id, contract, writes_repo])。
完成/换装事务内以同事务可见数据重算,与 ship_gate 存量比对。

## 3. E2E 与 crash 重放点(验收§4 的展开)

三节点 issue(docs → product-code → verdict 形状,但引擎只见拓扑)全链:
admitIssueDag → dispatchOnce×n → 逐节点完成 → founder approve → ship → 落账。

crash 注入点(每点 kill 后重放幂等):
C1 派发事务 commit 后、spawn 前;C2 完成观测后、完成事务前(HEAD 推进竞态);
C3 完成事务 commit 后、下游派发前;C4 approval 事务后、mailbox 消费前;
C5 ship intent 后、merge 调用前;C6 merge 成功后、outcome 前(reconcile 收口);
C7 rework 换装事务任意边界;C8 adopt_writer_gap 前后。

静态验收 grep:引擎源码零 design/implement/qa/template/review(作为节点语义)字面;
ship 谓词函数零 review/QA/docs/role/CI;tasks.payload 合同字段单写入点。

## 4. 不做清单(边界)

- 不加迁移、不动 v2-engine 文件、不动 v2-scheduler、不动 thread_bindings;
- 不实现告警 3.x 族(typed event + mailbox 落到即止,分层聚合归后续单);
- 不实现 events 归档(FLY-1521,已移出批次);
- 不做生产常驻循环接线与 v2 merge lane 激活探针的执行(形状留好,归 1502);
- 不新建 reviewer 专用 claim/表(复用 consumer/capability 配置,设计 §2.5 原文)。
