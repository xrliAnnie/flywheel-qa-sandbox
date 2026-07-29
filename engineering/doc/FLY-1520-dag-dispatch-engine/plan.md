# FLY-1520 DAG 派发引擎 — 实施计划
Issue: FLY-1520 (https://linear.app/geoforge3d/issue/FLY-1520/v2上线批次-dag-派发引擎-派发器只认-dag-节点完成合同运行时-generic-ship-执行器-三层模型1498-设计的实现)
日期: 2026-07-28
基于: research.md(Codex design review R2 修订版)

## 0. 权威与边界

- 设计权威:`doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md` +
  `design-FINAL-v2.md` §0/§1.4-1.7/§2.5/§2.12。方向锁死,本计划只做实现细分。
- Lead 裁定(brainstorm gate 2026-07-28):**路线 A 零迁移映射** + 三条配套
  (解析层 fail-closed / 静态围栏测试 / 有记录偏离)+ meta 值带
  revision+cutover_epoch 防旧 writer 重放。
- 铁律:不加迁移;不动 packages/v2-engine 与 packages/v2-actions 的任何文件
  (只包级 import v2-engine index 导出);不动 v2-scheduler;生产常驻接线归 1502。
- **有记录的偏离(跨族评审必读)**:
  1. 设计 §8 字面要求 tasks 重建(contract_json/writes_repo NOT NULL 列)+
     gates 重建 issue-scoped + thread_bindings 重建。本单按 Lead 裁定以
     tasks.payload canonical JSON + meta 键空间承载同等不变量,强制点从 DDL
     降到 kernel 唯一写入口;提升为列的机械迁移归 1502/独立 schema 单。
  2. ship 执行不经 `runRecordedAction` 薄壳,改为直接编排 kernel 公开动词
     `recordActionIntent`/`recordActionOutcome`:薄壳的 outcome 是独立事务、
     无钩子,无法满足「第 6 次失败结算与 expire gate + founder mailbox 同一
     事务」。因此本包**不依赖 flywheel-v2-actions**(R2-8c;薄壳继续服务
     简单动作场景,本包零 import)。
  3. 「合同字段唯一写点」的静态围栏只对 packages/v2-dag 成立;v2-engine 公开的
     Effect kind:"task" 仍可插任意 payload 的 task 行。**语义收口**:本引擎只认
     admission 回执成员(dag_issue:{issue}.task_ids),非成员一律不派发、不完成、
     首遇落 typed event。generic task-effect lane 合流归 1502(§9)。
  4. 每 issue 本批**恰一个 shippable worktree**(admission 必填
     ship_worktree_id,fail-closed);多 shippable worktree 归 1502+(R2-5)。

## 1. 交付物

新包 `packages/v2-dag`(npm 名 `flywheel-v2-dag`),依赖恰二:
flywheel-v2-kernel、flywheel-v2-engine(enqueue/registerAgentTx/attachRunner
所需类型;均为 index 导出)。

```
packages/v2-dag/
├── package.json / tsconfig.json / vitest.config.ts
├── src/
│   ├── contract.ts        # 合同+admission descriptor parse(fail-closed)
│   ├── digests.ts         # canonical JSON + sha256;shim-contract 测试对齐 kernel canonicalize
│   ├── meta.ts            # meta 键空间(统一信封 + 三种写形状)
│   ├── mailbox-append.ts  # appendMailboxTx(同事务 durable mailbox)
│   ├── events.ts          # typed event append + evidence 事件 schema
│   ├── families.ts        # review_families bootstrap API + family 权威
│   ├── admission.ts       # admitIssueDag + writer_gap_detected
│   ├── dispatch.ts        # dispatchOnce + prepareDispatchTx + launch claim
│   ├── manifest.ts        # manifest 构造/分类(全部事务外)
│   ├── completion.ts      # submitNodeCompletion + recordEvidence
│   ├── finalize.ts        # finalizeAuthorState / adoptWriterGap / 收割 / T7 resume
│   ├── rework.ts          # reworkTask
│   ├── gate.ts            # maybeRefreshShipGateTx / approveShipGate / invalidateShipAuthorityTx
│   ├── ship.ts            # executeShip(intent/outcome 直接编排)
│   ├── reconcile.ts       # reconcileShipActions(只读 probe;mint+通知,不建 successor)
│   ├── ports.ts           # §4
│   ├── sql.ts             # 本包全部 SQL 常量(静态验收扫这里)
│   ├── types.ts / errors.ts / index.ts
│   └── __tests__/
```

## 2. 数据合同(逐键逐列)

### 2.1 admission descriptor 与 tasks 逐列映射

```json
{ "admissionUid": "...", "projectId": "...", "issueId": "...",
  "notifyAgentId": "<监督者/告警收件 agent_id,须在 agents 表>",
  "shipWorktreeId": "wt:...(必填,恰一,须在 worktrees 内)",
  "worktrees": [{ "worktreeId": "wt:...", "repoIdentity": "owner/repo",
                  "worktreePath": "...", "branchRef": "refs/heads/...",
                  "mergeTargetRef": "refs/heads/main" }],
  "tasks": [{ "localId": "t1", "kindLabel": "<透传标签,引擎不读语义>",
              "contract": [DeclaredItem...], "writesRepo": bool,
              "worktreeId": "wt:..." | null,
              "executor": { "logicalAgentId": "<稳定跨 attempt>",
                            "family": "<认证 vendor family>",
                            "vendor": "...", "model": "...", "effort": "..." } }],
  "edges": [["t1","t2"], ...] }
```

tasks 逐列:id=uuid;project_id/external_issue_id=descriptor;
kind=kindLabel **透传,引擎零分支读它**(围栏 a);state='ready';
payload=§2.1a;rework_of=NULL;lineage_root_id=自身 id(settlement.ts 自指
先例);created_at=clock。

§2.1a payload 顶层恰四键 {contract, writes_repo, worktree_id, executor}。
parse(contract.ts,读写共用):键集精确;writes_repo boolean;
writes_repo=true ⇒ worktree_id∈descriptor.worktrees;executor 五字段合法,
family ∈ families 权威;contract 逐项判型:
- `{"kind":"verdict"}`;
- `{"kind":"review_approval","review":"<kind>"}`;
- `{"kind":"artifact","path":"...","cardinality":"one"|"many","digest":"sha256?"}`。
违反 ⇒ ContractParseError;**错误路径绝不读 kind/名字回退**;拒绝落
`task_contract_invalid` event + mailbox(收件人=dag_issue.notify_agent_id)。

### 2.2 meta 键空间(统一信封 + 三种写形状)

信封:`{v:1, revision:int≥1 单调, cutover_epoch:int, data:{...}}`。本包所有
meta 键都用它;非本包键(cutover_epoch 纯数字串等)不经此 parser。写形状恰三:

```sql
-- 首建(恰四处:admission / gate 首开 / families bootstrap / 首次 dispatch 的
-- agent_binding+launch_claim(R4-3);冲突=并发 fail-closed 抛):
INSERT INTO meta(key,value,updated_at) VALUES(:key,:v1,:now)
-- 更新(唯一 UPDATE 形状,tx.cas 包裹):
UPDATE meta SET value=:next, updated_at=:now
 WHERE key=:key AND json_extract(value,'$.revision')=:expectedRevision
   AND json_extract(value,'$.cutover_epoch')=:epoch
-- 读:SELECT + 信封校验;epoch≠库内 cutover_epoch ⇒ FenceViolation
```

| 键 | data |
|---|---|
| dag_issue:{issue} | {admission_uid, notify_agent_id, ship_worktree_id, task_ids:[...], worktree_ids:[...]}(成员回执,immutable) |
| canonical_worktree:{wt} | {repo_identity, worktree_path, branch_ref, merge_target_ref, initial_anchor}(path 可 CAS,其余写时比对 immutable) |
| span_tip:{wt} | {head, updated_by_attempt} |
| writer_chain:{wt} | {chain_head, open_attempt:{attempt_id, generation, family, start_head}|null, span_author_set:[...], pending_gap:{from,to}|null} |
| ship_gate:{issue} | {gate_id, state, tip, dag_digest, contract_digest, emitter_task_id, emitter_agent_id, **target:{repo, pr, head}|null**, actor_agent_id?, actor_generation?, config_digest?, capability_id?, approval_ref?, settled:{action_id?, merged_sha, at}|null, retry:{reconcile_after_ms:300000, max_attempts:6, base_ms:120000, cap_ms:900000, attempt_count, next_retry_at|null}} |
| review_families:{project} | {families:{"<family>":{reviewer_agent_id}}}(§2.5) |
| agent_binding:{logicalAgentId} | {state:'active'|'clear', activation_id|null, attempt_id|null, session_ref_current|null, session_ref_last:string|null, host_epoch|null}(单飞绑定;**精确转移表见 §2.2a,R4-3**) |
| launch_claim:{session_ref} | {state:'pending'|'claimed'|'launched'|'tombstoned', owner_token|null, lease_until|null, launch_receipt:{token, activation_id, host_epoch, launched_at}|null}(launch fence;**状态机与 OS 锁合同见 §2.2b,R4-2/R5-1**) |

gate 状态机(gates CHECK 四态原样,无第五态):首开 INSERT(revision=1,
state=open,tip=ship worktree 当时 span_tip);refresh/approve/reject/expire =
revision+1 CAS;**reopen 完整 next envelope(R3-5)**:revision+1 CAS,
state→open + 新 gate_id + 新 tip/digests + target/actor_agent_id/
actor_generation/config_digest/capability_id/approval_ref **全部归 null** +
retry 重置(attempt_count=0, next_retry_at=null);settled 必须仍为 null
(settled gate 不 reopen)。**settled 是终局**:merge 确认
⇒ settled 字段 CAS(state 保持 approved),此后 execute/retry/invalidate/
reopen 一律要求 `settled IS NULL`,settled gate 不再 expire/reopen(R2-6)。
gates 审计行仅四态迁移时 INSERT(id=gate_id+':'+revision,
task_id=emitter_task_id provenance,subject_digest=sha256(tip+dag_digest+
contract_digest))。ship 事实=actions 行/`ship_completed` event + settled。

### 2.2a agent_binding 精确转移表(R4-3)

| 转移 | 写形状 | 字段效果 |
|---|---|---|
| absent→active(首次 dispatch) | INSERT(首建点 4) | current=新 session_ref, last=null, activation/attempt/host_epoch 置 |
| clear→active(再 dispatch) | revision CAS | current=新, last 不动(仍是上一段的尾巴), activation/attempt/host_epoch 置 |
| active(old)→active(new)(T7 resume) | revision CAS | **last=old.current, current=新**, activation 换新 |
| active→clear(T3/T4/T6 终态) | revision CAS | **last=current, current/activation/attempt=null** |

probe 目标:T7 的 DeathEvidence probe = **session_ref_current**(要证死的是
现任);后续 dispatch 的 DeathEvidence probe = **session_ref_last**(上一段
尾巴)。parser 与本表逐字段一致;M1 全转移 + 旧 revision replay 测试。
**admission 对 executor agent 的精确矩阵(R4-4 + R5-3)**:

| agents 行 | agent_binding | admission 裁决 |
|---|---|---|
| 不存在 或 generation=0 | — | 接受(fresh/provisioned) |
| generation>0 | 合法同 epoch binding(clear) | 接受 |
| generation>0 | 合法同 epoch binding(active) | 接受(admission 不挡;派发由 T2 单飞挡) |
| generation>0 | 缺失或畸形 | **typed reject**(legacy/失联,收养 API 归 1502) |

不允许 dispatch loop 无限静默跳过。测试三例:gen>0+clear 接受;
gen>0+active admission 后 dispatch skip;gen>0+missing binding 拒。

### 2.2b launch_claim 状态机与 OS 锁合同(R4-2 + R5-1/R5-2)

状态机(activation-scoped,键=session_ref):

```
pending ─(claim-confirm CAS,恰一胜出,铸 owner_token+lease_until)→ claimed
claimed ─(适配器锁内一次性消费:CAS→launched + launch_receipt{token,
          activation_id, host_epoch, launched_at},然后才 exec)→ launched
claimed ─(接管:锁内 + probe exact session absent + CAS 换新 token)→ claimed
claimed|pending|launched ─(收割/终态路径,锁内)→ tombstoned
```

一次性消费语义(R5-1):
- **唯一 launch 入口 = `launchOnce`(R6-3)**:T2/T7 commit 后都只经它——
  锁内 {revalidate:token+claimed+lease 未过期+activation active} → CAS
  claimed→launched + 落 launch_receipt → **commit 后仍在锁内 exec** → 释放。
  静态/调用图测试断言 exec 只此一处。
- **exec 至多一次/activation**:同 token 第二次调用见 state='launched' ⇒
  fail/no-op;`launched` 后 lease 过期**不可接管**(claim 已终局,只能由
  收割 tombstone)。
- **CAS→launched 与 exec 之间崩溃(R6-2)**:该 activation 永不再 exec——
  锁内 fresh probe absent → **T6 正常收割(terminal 套件 + task→ready)→
  T2 重派下一 attempt(新 activation/新 session_ref)**。T7 不参与此恢复:
  **T7 只作用于非 terminal 的 active attempt**(live resume),其谓词断言
  attempt 未终态。receipt 前/后崩溃测试断言恢复后的 attempt/activation
  generation 期望值。
- 接管仅限 pre-launch(state='claimed' 且 launcher 死):同一 session 锁内 +
  **锁内 fresh probe** exact session absent,才 CAS 换新 token。

**OS 锁合同(R5-2 + R6-1)**:LaunchLockPort(flock,§2.11 fcntl 先例)的
参与者=**所有** claim/终态写者:claim-confirm、expired takeover、launchOnce、
T3 completion terminal、T4 closure terminal、T6 收割、T7 cutover。
锁序铁律:**先 LaunchLockPort(session_ref)、后 kernel read/write;任何
kernel.write 内禁止反向取 OS 锁**;T4 多 session 按 canonical session_ref
排序逐个取锁(防死锁)。**absence 证据必须是锁内新鲜的(R6-1)**:
T4/T6/T7 在持锁后、kernel.write 前**重新** probe,只接受锁内 fresh absent;
锁外旧 packet 只作预筛,不作 terminal 依据;packet 另带 launch_claim
revision,事务内断言未变(锁内 launch 发生过 ⇒ revision 已变 ⇒ 拒 terminal)。
测试:双 T7 launcher;lease 过期接管;同 token 双调用;launched+lease 过期
进程仍 present(不可接管);receipt 前/后各崩一次;**旧 absent packet →
adapter 完成 launch → T4/T6/T7 持锁后三者均拒 terminal(exact barrier)**;
takeover×adapter、T4×adapter、T7×adapter 交错;多 session 锁序。

### 2.3 capabilities(bearer 模型)

信任边界:同机同库经 kernel 单写路径;bearer = capability 行 id + 完整绑定
校验 + FENCE 单次消费 CAS + agents 世代围栏;无明文 token。token_hash 列填
sha256('v2dag:'+id+':'+subject_digest)(确定性判别值,非秘密,文档化;跨信任
域时 1502 重估)。

- **capability 写入结构(R4-6 + R5-4)**:私有低层 `insertCapabilityTx`
  仅被三个领域授权 helper 调用(静态测试按调用图断言恰三处 + 各自
  authority predicate 单测):①②为 github_merge 双入口(下),③为
  writer-adoption 独立 namespace(mintWriterAdoptionCapability,见下文)。
  **action='github_merge' 的授权入口恰两个**:
  ① founderAuthorizedMintTx——caller 恰二:approveShipGate 与
  recoverShipAuthority(共用 authority 谓词:approved、settled null、
  target/tip/DAG 未变、无 intended action、founder-authorized ref 幂等);
  ② reconcilerRearmMintTx——caller 恰二:due-retry 槽与 same-actor
  generation recovery(共用谓词见 T6)。
  行:{id, token_hash(上式), issuer='ship_gate:'+gate_id,
  audience=actor_agent_id, action='github_merge', task_id=NULL,
  attempt_generation=NULL, subject_digest=sha256(canonical {gate_id,
  logical_key, repo, pr, head})}(repo/pr/head 取自 gate.target 快照)。
- 消费(唯一 call site=ship.ts intent 事务):SELECT 行校验
  {issuer=='ship_gate:'+gate.gate_id(完整串,R2-8a), audience==caller,
  subject_digest==本地重算} + **gate.actor_agent_id/actor_generation==caller
  身份 + gate.capability_id==所持 id(R2-1)** → FENCE.capabilityConsume CAS
  (显式 taskId:null, attemptGeneration:null)。
- 可恢复交付:approval mailbox 载荷 {capability_id, gate_id, repo, pr, head,
  tip};approveShipGate 以 approval_ref 幂等(同 ref 同 payload 重放返回首次
  结果含既有 capability_id,异 payload conflict)。
- **writer 收养独立名字空间(不在「恰两点」内)**:action='adopt_writer_gap'
  | 'lost_open_attempt';subject_digest 绑 {worktree_id, from_head, to_head,
  attribution_family, reason}(lost-open 再绑 {attempt_id, writer_revision,
  start_head, resolution_head=span_tip});mint 走
  mintWriterAdoptionCapability(audited `writer_adoption_minted` event,调用
  方=监督 Lead/founder 路径);consume 在 adoptWriterGap 事务内同款 CAS。
- digest 防漂移:shim-contract 测试——recordActionIntent 造已知 payload,
  读回 snapshot.logical_key/payload_digest,与 digests.ts 推导逐字节相等。

### 2.4 actions 映射

- ship action:kind='github_merge',payload 恰 {repo, pr, head, tip}
  (无 gate_id ⇒ payload_digest 跨 gate reopen 稳定,supersede 链不断);
  logicalEffectId='github_merge:{repo}:{pr}:{head}';
  invocationUid=capability_id(每 attempt 新 mint ⇒ 无 replay 短路)。
- **同 logical agent 规则**(actions.ts logical_key 含 actorAgentId,实证):
  successor 只能由同一 actor_agent_id(新 generation 可)建立;换 actor =
  fresh approval → reopen 新 gate_id → 新 actorAgentId 的新 logical root;
  旧链 intended 尾留作诚实 unknown 窗口 + typed event。
- **链规则与序号来源(R3-5)**:attempt_no 由 actions 链长派生(链尾读取),
  **不是** gate.retry.attempt_count(后者是 per-gate 授权预算镜像,reopen 归
  零;链跨 gate 延续)。executeShip 按 gate.target+actor 算 logical_key 后读
  唯一链尾:无尾 ⇒ root;尾∈{intended,failed} ⇒ 必须 successor +
  retry_basis={evidence_ref,reason};尾 succeeded ⇒ 终局冲突(拒)。第 6 次
  失败 → expire → reopen → 同 actor/target fresh approval 时,新 intent 是
  旧链的合法 successor(payload_digest 稳定),不撞 one-root(测试钉死)。
- reconciler 不建 successor(invocationUid replay 短路/越权双坑);只
  mint+通知;successor intent 由 actor 在 executeShip intent 事务内自建。
- **观察性结算(按 probe 结果 × actor 世代四格,R2-6)**:
  | probe | actor 世代 current | actor 已换代 |
  |---|---|---|
  | merged | recordActionOutcome(succeeded)+同事务 settled CAS+`ship_completed` | action 永留 intended;同事务 `ship_completed` event + settled CAS + `action_unsettleable_generation`(不伪造 outcome) |
  | 确定拒绝 | recordActionOutcome(failed)+同事务 retry 记账(§T5-4) | action 永留 intended;`action_unsettleable_generation`(probe 证据)+同事务 retry 记账(next_retry 或达上限 expire);**绝不写 settled** |
  | 不确定 | 保持 + 去重 overdue event(不猜失败) | 同左 |

### 2.5 family 权威与 bootstrap

- 认证来源恰二:①task.payload.executor.family(admission 单写点)=
  open_attempt.family;②review_families:{project} meta。
- **registerReviewFamilies(bootstrap API,R2-8b)**:部署期单写者;首建
  INSERT-first,更新 revision CAS;每次变更落 `review_families_updated`
  event;reviewer_agent_id 必须在 agents 表。运行事务只读该键。
- recordEvidence(review_approval):reviewer agent 在 agents current
  generation,family 由 review_families **反查**(不接受自报)。
- eligible = review_families − effective_author_set;空 ⇒
  `review_family_exhausted`(完成拒绝,设计 §2.5 原文)。

### 2.6 evidence 事件与匹配闭合(R2-3)

| kind | payload | producer 绑定 |
|---|---|---|
| evidence.verdict | {task_id, attempt_id, head, verdict:'pass'|'fail', by_agent, by_generation, by_activation} | by_agent==该 task payload.executor.logicalAgentId,current generation,by_activation 是该 attempt 的 active activation |
| evidence.review_approval | {review, subject_digest, reviewer_agent, reviewer_family, reviewer_generation} | review_families 反查 + agents current |
| evidence.artifact | {task_id, attempt_id, path, digest} | 同 verdict(产出者=本 attempt 执行者) |

匹配规则(完成事务内):
- verdict:**verdict=='pass' 必须**(fail 不满足合同——R2-3 反例钉死);绑
  {task, attempt, head==本次 head subject(§T3)};
- review_approval:review kind 相符 + subject_digest==本次 review subject +
  reviewer_family∉effective_author_set 且∈review_families;
- artifact:path 相符;cardinality='one' ⇒ 恰一条匹配(同 digest 重复幂等,
  异 digest conflict);'many' ⇒ ≥1;declared.digest 存在 ⇒ 逐字节相等,缺省
  ⇒ 接受任意但记录;
- event_uid 幂等键 `{kind}:{task_id}:{attempt_id}:{判别}`;UID 撞车 ⇒ 比对
  完整 canonical payload digest(同=幂等,异=conflict)。

## 3. 事务规范(T1-T7;git/GitHub/spawn/probe 全事务外)

### T1 admitIssueDag

**先查回执**(R2-4):事务外任何 worktree 读取前,kernel.read 按
admissionUid 查 `admission:{uid}` event;命中且 request digest 同 ⇒ 返回首次
结果,异 ⇒ conflict。未命中才:逐 worktree 读 merge_target_ref + HEAD,
anchor=merge-base。事务内:再查幂等(写窗竞态)→ descriptor 全量 parse
(任一 task 违反 ⇒ 整单拒)→ notifyAgentId 在 agents 表 →
shipWorktreeId∈worktrees 断言 → 建 tasks + edges(内存判环)→ 每 worktree
建三键(chain_head=anchor;HEAD>anchor ⇒ pending_gap 落值 +
`writer_gap_detected` event,durable)→ dag_issue 回执 → `dag_admitted`。
gap 恢复:adoptWriterGap 独立事务消费 adopt_writer_gap capability →
chain_head→to CAS + 清 pending_gap + 折入 family + event;level-triggered
可重放。**gap 未清 ⇒ 该 worktree writes-repo 派发 fail-closed**(T2 谓词
天然);span_tip 恒停 anchor ⇒ 首个完成消费 anchor 起全部 diff。

### T2 dispatchOnce(prepareDispatchTx 共用件 + launch claim)

事务外:候选粗筛 SQL + 涉及 worktree 观测 HEAD + **目标 logical agent 的
agents 行 generation>0 时收集 DeathEvidence packet**(ProcessProbePort
对 agent_binding.session_ref_last 的 absence 确认;拿不到 ⇒ 该候选跳过本轮,
fail-closed)。
每候选独立事务 prepareDispatchTx(tx, taskId, observation, evidence?):
1. 事务内重跑完整 eligibility:state='ready' + dag_issue 成员 + incoming 全
   done + 无 active attempt(R1-3)+ **logical agent 全局单飞(R3-6):
   agent_binding:{logicalAgentId} 不存在或 state='clear';binding 还 active
   (旧 task 未收割)⇒ 本候选跳过,必须先走 T6 收割,不得借新 task 偷渡
   cutover**;
2. parse contract(失败 ⇒ event+mailbox,跳过);
3. writes_repo ⇒ writer_chain(revision fence):open_attempt IS NULL 且
   pending_gap IS NULL 且 observation.head==chain_head;
4. INSERT attempt{generation=attempt 新代=MAX+1, desired_state='dispatched',
   worktree_id, vendor, model, host_epoch=ports.host.hostEpoch()} + INSERT
   activation{id=预生成 uuid, active,
   **session_ref='v2dag:{attempt_id}:{attempt_generation}:{activation_id}'
   (R4-1:activation identity 进键,T7 换 activation 即换 session_ref,
   仍确定可重建)**, **generation=attempts.generation(R3-1)**} +
   **registerAgentTx(同事务;instanceId:=session_ref,确定性可重建)** +
   agent_binding 转移(§2.2a:absent⇒INSERT,clear⇒CAS)+ launch_claim
   INSERT{state:'pending'}(§2.2b)+ tasks ready→running CAS + writes_repo
   ⇒ open_attempt 占槽(family=executor.family, start_head=chain_head)+
   `attempt_dispatched` event(canonical payload {agent_id,
   instance_id=session_ref, agent_generation, activation_id, attempt_id,
   session_ref, host_epoch},durable 重建源);
5. 返回 durable spawn request{attempt, activation, session_ref,
   RegisteredAgent(领养身份), executor}(可自 attempt_dispatched payload +
   tasks.payload.executor 全量重建,launcher 崩后新 spawner 按此重构)。
**launch fence(§2.2b)**:commit 后 spawner 走 claim-confirm 竞争小事务
(launch_claim pending→claimed CAS 铸 owner_token+lease_until,恰一胜;
首次 launch 同小事务 attempts CAS dispatched→started{started_at})→
**launchOnce(唯一入口,R6-3:锁内 revalidate → CAS claimed→launched +
launch_receipt → exec)**;runner 以 attachRunner(领养身份)接入,不自行
register。
收割边界(T6):'started' 且 probe(session_ref)=absent 且逾 grace;
'dispatched' 且逾 claim-grace。收割在同一 OS 锁内先 tombstone 再 terminal
(§2.2b;barrier 测试两组+锁交错三例)。

### T3 submitNodeCompletion + recordEvidence

recordEvidence(独立小事务):§2.6 绑定校验 → INSERT event(幂等)。
submitNodeCompletion:{taskId, attemptId, activationId, agent, completionUid}。
**第一步(任何 Git 调用前,R2-4)**:receipt 查——completionUid +
stable request digest 命中 node_completed ⇒ 返回首次结果;异 digest ⇒
conflict。未命中才走观测:
- writes_repo=true:manifest 全流程(§研 2.5)+ BEGIN 前重取 HEAD/writer
  revision;ancestor 破坏 ⇒ 独立事务 expire gate + `span_anchor_diverged`;
- writes_repo=false:**零 Git 观测**;head subject := 事务内 ship worktree
  的 current span_tip(R2-4;head 绑定证据对着它验);gate refresh 的
  observation map 仍由调用方提供(freshness tripwire)。
事务内:
1. 幂等再查(写窗竞态);
2. 绑定链:agents{agent_id,generation} current 且 kind='runner' →
   activation{id==agent.activationId, active, attempt_id==attemptId,
   **generation==attempt.generation(R3-1)**} →
   attempt{task_id==taskId, 非 terminal;写任务再核
   ==writer_chain.open_attempt.generation} → task{running, 成员};family 取
   payload.executor.family(权威);
3. 写任务:span_tip==base、观测 head==manifest.head、writer revision 未变;
4. 合同求值:declared(§2.6)∪ derived(写任务:product⇒cross-family
   exact review,test/docs/空⇒无;非写:derived=∅);eligible 空 ⇒ 事务改写
   为仅 `review_family_exhausted` event+mailbox,task 保持 running;
5. 全过 ⇒ 同 commit:activation terminal、attempt terminal(completed)、
   task→done(terminal_at)、node_completed(含 request digest)、
   **写任务才**:span_tip 推进 + writer_chain 折作者清槽;
   **agent_binding 清为 clear + launch_claim tombstone(R3-6:每条终态路径
   ——T3 完成/T4 finalize/T6 收割——统一清绑定,session_ref_last 保留;
   均为 §2.2b OS 锁参与者,先锁后事务)**;
   maybeRefreshShipGateTx(issue, observationMap)。非写任务零 span/author 步。
**runner 生命周期(R3-6)**:runner 在 submitNodeCompletion 返回成功(或
终态失败)后必须退出进程;后续同 logicalAgentId 的 dispatch 以
session_ref_last 的 absence probe 取 DeathEvidence,不会因 runner 恋栈永久
跳过。

### T4 reworkTask

**quiesce 前置 = stable-set acquisition loop(R4-5 + R6-1 + R7-1)**:
① 预读 dependency closure 与其 active session_ref 集合 S(canonical 排序);
② requestStop(S) 并按序取齐 §2.2b 锁;
③ **持锁后重读 closure 当前 active 集合,不精确等于 S ⇒ 释放全部锁、
   回到①重试**(并发 T2 在取锁窗口塞进的新 suite 由此被发现,绝不 terminal
   未持锁 session);
④ 对 S 锁内逐 session fresh re-probe;任一 present ⇒ 零 DB 变更、释放全部
   锁、返回 typed `ReworkAwaitingQuiescence`(level-triggered 重试);
⑤ 进入单一 kernel.write 后**再次断言 closure active set==S + 每个 claim
   revision/evidence 未变**,才执行 release→reset→acquire;断言失败 ⇒
   整事务回滚重试。
stop 与该 runner 完成事务的竞态由 completion 先赢自然消解(rework 重入后按
新状态重算)。barrier 测试:T4 预读后 ready downstream 经 T2 提交并进入
launchOnce ⇒ T4 必须检出 locked-set mismatch、零业务写并重试。
事务外 observation 集合(R2-7)= 闭包内待 finalize 的 active writer
worktrees ∪ **被打回 task 的 dispatch worktree** ∪ gate refresh 所需
worktrees,每 packet {head, writer_revision};agents 换代所需 DeathEvidence
同 T2 规则收集(此时 quiesce 已给出 absence)。
事务内:reworkUid 幂等 → incoming 全 done 断言 → 逐 packet 复核 →
闭包 active 套件全 release(writes-repo 走 finalizeAuthorState(superseded,
packet),非写直接 terminal)→ 受影响 task(done 或 running)→ready CAS +
清 terminal_at → 断言目标 writer slot 空 → prepareDispatchTx(被打回 task,
目标 worktree packet, evidence)→ invalidateShipAuthorityTx(issue) →
`task_reworked`。commit 后同 T2 launch claim → spawn。release 先于 acquire
硬序(无双槽瞬态测试)。

### T5 approveShipGate + executeShip

approveShipGate:{issueId, approvalRef, shipTarget{repo,pr}, observedTip,
actorConfig{defaultActionAgentId, configDigest}}。事务内:approval_ref 幂等
→ DAG 全 done(回执逐 task)+ gate.state=open + settled IS NULL +
tip==observedTip + **shipTarget.repo==ship worktree 的
canonical_worktree.repo_identity(R2-5)** → CAS approved + **target:{repo,
pr, head=tip} 持久化进 gate data** → actor 选择(emitter_agent_id current
可用,否则 defaultActionAgentId;都无 ⇒ approved 落库 + `ship_action_blocked`
event/mailbox,不 mint)→ actor_agent_id/actor_generation 落 gate → mint 1
+ capability_id 落 gate → gates 审计行 + `gate_approved` + actor mailbox。
此后 capability/mailbox/intent/reconcile 的 repo/pr/head **全部从 gate.target
快照重算,不信调用方重传**。

executeShip(直接编排,偏离 2):
1. 事务外:GitHubObservationPort.readPrHead(gate.target);
2. intent 事务:agents 世代 + §2.3 全绑定校验(含 gate.actor==caller、
   gate.capability_id==所持)+ FENCE CAS + gate CAS{approved, settled IS
   NULL, tip==观测 head, revision, retry.attempt_count+1} + DAG all-done
   重查 + **链尾读取(§2.4/R3-5):按 gate.target+actor 算 logical_key,
   无尾 ⇒ root;尾 intended/failed ⇒ supersede+retryBasis;尾 succeeded ⇒
   拒** + recordActionIntent;
3. 事务外 perform:GitHubMergePort.merge(repo, pr, expected_sha=tip);
4. outcome 事务:recordActionOutcome + 同事务:succeeded ⇒ settled CAS +
   `ship_completed`;failed ⇒ 达 max ⇒ gate expired + founder mailbox;未达
   ⇒ next_retry_at=backoff(2/4/8/15/15min)。
crash 于 3/4 间 ⇒ intended 无 outcome,T6 收敛。**谓词恰三条;ship.ts 零
review/QA/docs/role/CI token**。

invalidateShipAuthorityTx:settled IS NULL 前提;同 logical_key 尾 intended
⇒ ShipInFlightConflict;否则 capability revoke + gate expired + 业务写同
事务。双序线性化同前。

### T6 reconcileShipActions + 收割

- stale intended:probe → §2.4 四格表处置(merged/拒绝/不确定 × 世代)。
- **due retry 原子槽(R2-6 + R3-3 双 basis)**:单事务 CAS{gate revision,
  state=approved, settled IS NULL, next_retry_at 到期, 链尾 basis 二选一:
  ①尾==failed;②尾==intended 且存在匹配的 `action_unsettleable_generation`
  definitive-rejection event(绑 action_id+probe digest)且无 successor}:
  清 next_retry_at + mint 2(新 capability_id + actor_generation 落 gate)+
  mailbox;新代 actor 对 intended 尾建 successor(0006 允许)。到上限直接
  expire。双 reconciler 竞争同 slot ⇒ revision CAS 恰一胜(测试)。
- **approved-authority recovery(R3-4,mint 2 家族的 level-triggered 补路)**:
  谓词{approved, settled IS NULL, target/tip/DAG 未变, 无 intended action,
  且(capability 未消费但 gate.actor_generation 落后于 agents 当前世代)}⇒
  同一 logical actor 仅世代前进:revoke 旧 capability + gate CAS
  actor_generation/capability_id + mint + mailbox。**actor 缺失(approval 时
  blocked)或需换 actor/config:不得静默重选**——走 founder-authorized
  `recoverShipAuthority`(approvalRef 同款幂等,重读 config+digest,CAS
  actor 三字段 + mint,audited event);覆盖「blocked 后配置修复」与
  「cap 未消费即 T7 换代」两例。
- gate 已合法失效 ⇒ 清 next_retry_at 静默。
- 收割(T2 边界;§2.2b 锁内,**持锁后 fresh re-probe absent + claim
  revision 未变才可 terminal,R6-1**):**先 launch_claim tombstone CAS,再**
  finalizeAuthorState(failed, exact packet)+ task running→ready CAS +
  agent_binding 清为 clear(session_ref_last 保留)+ typed event;
  launched-未-exec 的 claim 同走此收割 → task ready → T2 重派(R6-2);worktree+ref 双失 ⇒ 仅
  adoptWriterGap(lost_open_attempt)(§2.3 全绑定,一次性消费;task 不 done)。

### T7 resumeActivation(单事务 cutover,R2-1)

{attemptId, evidence(DeathEvidence)}。**一个 kernel.write 内**:校验
evidence(agents current 世代匹配,**probe 目标=agent_binding.
session_ref_current,R4-3**)→ 旧 launch_claim tombstone → 旧 activation
CAS terminal → INSERT 新 activation{id=新 uuid, active,
session_ref='v2dag:{attempt_id}:{attempt_generation}:{新 activation_id}'
(R4-1:新键,不撞旧 tombstoned claim), generation=attempts.generation 不变}
→ registerAgentTx(agent 世代 CAS + 旧 running 收尾;instanceId:=新
session_ref)→ agent_binding 转移(§2.2a:last=old current,current=新)
+ 新 launch_claim INSERT{'pending'} → 旧授权围栏(gate.actor_generation
落后 ⇒ capability 待 approved-authority recovery 按新代再武装,T6)→
`activation_resumed` event(绑新 activation/session)。**前置(R6-1/R6-2):
T7 只作用于非 terminal 的 active attempt;整个 cutover 在 §2.2b 锁内,
DeathEvidence 必须锁内 fresh probe(目标=session_ref_current)**。commit 后
走 claim-confirm 竞争(双重构 launcher 恰一胜)→ **launchOnce**(领养身份
attachRunner)。测试:同 attempt 连续 resume 两次,两条 tombstoned claim
保留、第三条唯一;旧进程迟到写被 agents 世代围栏整体拒(双连接竞态)。

## 4. Ports

| Port | 方法 | 边界 |
|---|---|---|
| GitPort | readHead / mergeBase / isAncestor / rawDiff / readRef | 只读,事务外 |
| GitHubObservationPort | readPrHead / readMergeState | 只读;reconciler 仅持此口 |
| GitHubMergePort | merge(repo,pr,expectedSha) | 仅 executeShip 持有 |
| SpawnPort | spawn(request 含 owner_token) | 仅被 launchOnce 调用(唯一 exec 位点);一次性消费责任见 §2.2b(R6-3) |
| ProcessProbePort | probe(sessionRef)→present/absent+confirmedAt | 收割/DeathEvidence |
| RunnerControlPort | requestStop(sessionRef) | T4 quiesce(R4-5) |
| LaunchLockPort | withSessionLock(sessionRef, fn) | §2.2b OS 锁;参与者=claim-confirm/takeover/launchOnce/T3/T4/T6/T7 全部 claim与终态写者(R5-2/R6-3) |
| WorktreeRefPort | readExactRef / worktreePresent | lost-open 证据 |
| HostPort | hostEpoch() | attempt.host_epoch(R2-2) |
| DagClock | nowMs/nowIso | 全注入 |

## 5. 里程碑(TDD;M0 垂直 spike 先钉合同)

| M | 内容 | 退出条件 |
|---|---|---|
| M0 | 真库 spike(0001..0007):admission 单行、activation+registerAgentTx 同事务、attachRunner 领养、capability consume(null bindings)、同 agent 新代 successor 通过/异 actor 拒(logical_key 实证)、failed outcome 链;**agent=3/attempt=2/activation=2 分叉 fixture 钉死 0006 lineage 触发器(R3-1)**;200/500-task admission 耗时 | 合同假设全钉死;admission 上限定数(初值 500,fail-closed);public-surface 断言本包依赖恰二(R2-8c) |
| M1 | contract/digests/meta/mailbox/events/families | parse 全反例;信封 CAS 拒重放;digest shim-contract;evidence 幂等+UID 撞车双例;families bootstrap 幂等 |
| M2 | admission + dispatch + launch fence(T1/T2) | 拓扑序;gap fail-closed+adoption;replay-first;stale 候选交错;**§2.2b 全测例(一次性消费/接管/锁交错/锁序)**;**单飞三例(R3-6)**;**admission 矩阵三例(R5-3)** |
| M3 | manifest + completion + evidence(T3) | 派生矩阵;绑定链反例(伪 activation/伪 family/错 subject/**fail verdict/异 attempt 产者/many 0-1-N/重复证据**);replay-first(Git 零调用断言);非写零 span 步 |
| M4 | rework(T4) | release→acquire 硬序;**done 上游+异 worktree 下游** observation 集合;换装后 claim+spawn;gate expire/unconsumed/reopen 全分支;**quiesce 三例(present 拒不改库/stop→absent 通过/stop×完成竞态,R4-5)**;**stable-set loop barrier(T2 并发插入新 suite ⇒ mismatch 重试,R7-1)** |
| M5 | ship + reconcile + resume(T5/T6/T7) | 三谓词;target 快照单源;可恢复交付;双序;6 次上限同事务 expire;**四格×世代六例**;due-slot 双 reconciler + **双 basis(failed 尾/intended 尾+拒绝证据)端到端(R3-3)**;**approved-authority recovery 两例(blocked 后修复/cap 未消费即换代,R3-4)**;**6 败→reopen→fresh approval→合法 successor(R3-5)**;T7 单事务 cutover+旧进程迟到写拒 |
| M6 | E2E + crash 重放 + 静态围栏 | §6 全绿;pnpm lint + pnpm -r build + 全包测试 |

## 6. 测试计划

- 单元/竞态/crash:research §3 C1-C8 + R1/R2 全反例(§5 各里程碑退出条件)。
- E2E:三节点全链;纯 PRD 单;QA 单。
- 静态围栏:a) src 零节点语义字面;b) ship.ts 零 review/QA/docs/role/CI;
  c) 本包 tasks.payload 合同写点唯一 + 成员回执运行时闸;d) 零 v2-engine 深
  路径 import、零 attempts.observed_* 引用、**依赖恰 kernel+engine 二包**。

## 7. 验收映射

| issue 验收条 | 落点 |
|---|---|
| 纯 PRD 单 ship 畅通零 code review | E2E-PRD + 派生矩阵 |
| QA 单合同=verdict(且必须 pass) | E2E-QA + §2.6 匹配 |
| 零按场景特例 | 围栏 a/b + 单一 eligibility |
| 三节点全链 + kernel 单写 + crash 重放 | E2E-3node + C1-C8 |
| ship 不重问 code review | T5 三谓词 + 围栏 b |
| resume/一 worktree 一活 writer | T7 + M2/M3 竞态组 |

## 8. 风险与对策

1. 1518 rebase:接触面=v2-engine index 导出 + actions 语义;合同测试红出漂移。
2. 事务预算 1s:admission 上限 M0 定数,不上调生产预算。
3. actions/registration 语义:M0 先钉死再写业务。
4. GitPort 子进程:execFile 白名单,拒 shell 拼接。

## 9. 诚实边界与跟进(1502 清单)

- agent 物理持有 GitHub credential;non-admin + required-checks 探针归 1502;
- observation 后旁路 push 最早在下一 gap/ship expected-sha 被拒;
- payload/meta 承载的强制点在 kernel 唯一写入口,直改库不设防;列提升归
  1502/schema 单;
- generic task-effect lane 与成员回执合流归 1502;
- **legacy agent(generation>0 无 binding)收养 API 归 1502**(本批 admission
  直接拒,R4-4);
- 每 issue 恰一 shippable worktree(偏离 4);多 shippable 归 1502+;
- 原 actor 整体消失时 action 行永留 intended(§2.4 表,事实经 event+settled);
- 超上限 DAG admission 拒绝,1502 复核。

## 10. Founder 硬约束增量(2026-07-28)

来源:`[lead-instruction 7f1402a0-b0a8-4ea4-955c-3c1a616b54fe]` 转达的
founder 原话。此增量不改变已批架构,只把 payload 上游来源钉死:

- 每个节点的 declared contract 来自该角色自己的 markdown/config 数据文件;
  admission 调用方在运行时读取并写入 `tasks.payload`,TypeScript 引擎不内置任何
  角色合同常量、模板或角色名分支。
- 本包只解析通用 evidence shape;改角色合同只改数据文件,无需修改或重新编译
  `flywheel-v2-dag`。
- M6 静态围栏增加 role-contract scan:生产源码拒绝角色/场景合同文本;运行时
  配置验收用两份不同 contract 数据连续 admission,证明不重编译即可对新节点生效。
