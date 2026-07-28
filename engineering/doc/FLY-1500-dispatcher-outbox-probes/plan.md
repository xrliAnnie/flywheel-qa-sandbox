# FLY-1500 dispatcher + outbox + 探针 — 实施计划

Issue: FLY-1500 (https://linear.app/geoforge3d/issue/FLY-1500/v2批次2-dispatcher-outbox-探针-外发执行与应有实际状态对账)
日期: 2026-07-27
基于: research.md(上游: exploration.md;设计权威 = `doc/engineer/plan/v2/design-FINAL-v2.md`,Codex R13 APPROVED)
状态: **codex-approved**(design review 6 轮:R1=8H+2M/R2=5H+3M/R3=3H+2M/R4=4H/R5=1H+2M 全采纳 → R6 APPROVED;评审链存 `design-review/`。R1-R6 期间 Codex 四次上机实证:DC 索引命中、malformed JSON 毒 lane、attempt token 迟到结算、NULL-epoch/snapshot CAS)

---

## 0. 目标与边界

交付 v2 外发执行层:**transactional outbox 消费侧(command dispatcher)+ 效果探针 + saga 处置总表 + notify-then-do 双校验**。

- 两个交付面:
  1. **`packages/v2-kernel` 增量**(所有写路径 SQL 仍收口在 kernel 包):迁移 0005(只加不改)、dispatcher 身份、FENCE commands CAS 族、`admitCommand`/claim/settle 类型化 op、候选 SQL 常量。
  2. **新包 `packages/v2-dispatcher`**:引擎(claim loop、executor adapters、探针、reconcile、saga planner)。**零接线**:不 import 进任何现有运行路径,无 daemon 启动项,生产行为零变化(与批次1 同纪律;接线=批次3 切换手册)。
- 忠实 design-FINAL-v2,不重开设计;展开处标 `[落地]`。
- 不在本单:mailbox 消费循环/公平性(FLY-1499)、告警聚合/抑制规则内容/垫片(FLY-1501)、gate 语义与 task 级派发(FLY-1498)、切换执行(批次3)。

## 1. 术语基石:两个 claim,只保留一个(Lead 强化①)

| | mailbox 消息层 | commands 执行层(本单) |
|---|---|---|
| claim/租约 | **已删除**(FINAL §T):每条消息唯一收件人,无竞争;"未销账即未处理,重启重放" | **保留不变**(FINAL §T "commands/dispatcher 的执行 claim 协议保持不变") |
| 为什么不同 | 消费=库内转化,崩溃后重放零外部代价 | 执行=外部副作用,崩溃后"发没发过"必须有账;claim 是外发所有权与崩溃归因的锚 |
| 租约含义 | (无) | **不是竞争仲裁**(单 dispatcher 无竞争),是**僵尸副作用静默窗**:fence 挡旧世代 DB 写,挡不住已在途的 HTTP;新世代 reconcile 等 lease 过期再动手,把双发窗口约束在旧进程单次外发调用的存活上限内 |

实现层守则:任何人在 mailbox 相关代码里写 claim/lease 字样=违背设计;任何人在 commands 生命周期里绕过 claim 直接执行=违背设计。

## 2. 迁移 0005-commands-dispatch-bookkeeping(只加不改,Lead 强化③)

```sql
-- [落地] FINAL §1.1 commands 重试预算与探针簿记(设计给了语义,列为本批落位):
-- 退避/预算镜像 mailbox 家族(FINAL §0.5:30s×2^n cap 15min,≥5 → 终局)
ALTER TABLE commands ADD COLUMN retry_count          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commands ADD COLUMN next_retry_at        TEXT;
ALTER TABLE commands ADD COLUMN probe_unknown_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commands ADD COLUMN first_unknown_at     TEXT;
ALTER TABLE commands ADD COLUMN last_probe_at        TEXT;

-- [落地] v1 §2.3 attempts 探针"计数落库不落内存"的落位
ALTER TABLE attempts ADD COLUMN probe_unknown_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN first_unknown_at     TEXT;
ALTER TABLE attempts ADD COLUMN last_probe_at        TEXT;

-- [落地] dispatcher 候选索引家族(镜像 mailbox 七索引家族的 immediate/scheduled 两分区形态)
CREATE INDEX commands_pending_immediate ON commands(kind, created_at, id)
  WHERE state='pending' AND next_retry_at IS NULL;
CREATE INDEX commands_pending_scheduled ON commands(kind, next_retry_at, created_at, id)
  WHERE state='pending' AND next_retry_at IS NOT NULL;
-- (id 进索引尾列:候选查询 ORDER BY …,id 稳定 tiebreaker;Codex R2 实测缺 id 列必出
--  USE TEMP B-TREE FOR LAST TERM OF ORDER BY,加列后消失)
CREATE INDEX commands_inflight ON commands(lease_expires_at)
  WHERE state IN ('claimed','accepted','executing');
```

- 不加表:17 表清单不变。不动任何既有列/索引/触发器。
- 迁移形态沿用批次1 migrator(id=`0005-commands-dispatch-bookkeeping`,DDL 字符串+checksum 台账)。
- `first_unknown_at`:双条件升级(次数+跨度)需要"本轮 unknown 连续段的起点";任一次 present/absent 确定答案将 streak/first_unknown_at 一起清零。

## 3. kernel 增量

### 3.1 dispatcher 身份(fence.ts,纯加法)

```ts
| { kind: "dispatcher"; dispatcherId: string; instanceId: string; generation: number }
```
- registry 键:`dispatcher_registry:<dispatcherId>`(`dispatcherRegistryKey()`,与 lead/consumer 同构)。
- 启动注册=单 IMMEDIATE 事务:读旧行→generation+1→upsert(与 Lead 注册同款 cutover 语义);每个写事务首行 `requireIdentity`。
- `parseIdentity` 增第三分支,exact-keys 校验同构;既有 lead/runner 分支字节不动。

### 3.2 FENCE 增量:commands 生命周期 CAS 族(canonical SQL,实现原样使用)

```sql
-- commandCasPendingClaimed(:id,:owner,:generation,:leaseExpiresAt)
UPDATE commands SET state='claimed', claim_owner=:owner, claim_generation=:generation,
       lease_expires_at=:leaseExpiresAt
 WHERE id=:id AND state='pending';

-- 【claim token 合同(R3-1)】claim 事务读出 token = {owner, generation, retry_count, lease_expires_at};
-- owner+generation 跨 retry 会复用(同一 dispatcher 进程),retry_count 每次回 pending 必 +1
-- → (owner,generation,retry_count) 是**每次执行尝试唯一**的 token。claimed 之后的
-- **每一条** CAS(accept/intent/settle/release/K 路径)都必须带 AND retry_count=:tokenRetryCount,
-- 否则迟到的旧 attempt 结算会命中重排后的新 attempt(Codex R3 上机复现)。

-- commandCasClaimedAccepted(:id,:owner,:generation,:tokenRetryCount,:acceptedAt)
UPDATE commands SET state='accepted', accepted_at=:acceptedAt
 WHERE id=:id AND state='claimed' AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount;

-- commandCasAcceptedExecuting(:id,:owner,:generation,:tokenRetryCount) —— 与 effect_intent 事件同事务
UPDATE commands SET state='executing'
 WHERE id=:id AND state='accepted' AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount;

-- commandCasExecutingSucceeded(:id,:owner,:generation,:tokenRetryCount,:completedAt,:result) —— 与 effect_receipt 同事务
-- (原子清探针簿记:terminal 行不携带存活的 unknown 状态,probe-adopt 成功同用此条,R4-1)
UPDATE commands SET state='succeeded', result_code='succeeded', completed_at=:completedAt, result=:result,
       probe_unknown_streak=0, first_unknown_at=NULL
 WHERE id=:id AND state='executing' AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount;

-- commandCasClaimedSucceeded(:id,:owner,:generation,:tokenRetryCount,:completedAt,:result)
-- kernel-action(事务K)granted 专用:claimed 直达 succeeded,不经 executing(R3-2)
UPDATE commands SET state='succeeded', result_code='succeeded', completed_at=:completedAt, result=:result
 WHERE id=:id AND state='claimed' AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount;

-- commandCasExecutingRejected(:id,:owner,:generation,:resultCode∈('stale','policy_denied','noop'),:completedAt,:result)
-- expected denial → rejected(终版 §2.1:前三类结清永不告警);同事务写 kernel decision event(终态驱动源)
UPDATE commands SET state='rejected', result_code=:resultCode, completed_at=:completedAt, result=:result
 WHERE id=:id AND state IN ('claimed','accepted','executing')
   AND claim_owner=:owner AND claim_generation=:generation AND retry_count=:tokenRetryCount;

-- commandCasExecutingFailedUnknown(:id,:owner,:generation,:completedAt,:result)——unknown 有界升级终点
UPDATE commands SET state='failed', result_code='effect_unknown', completed_at=:completedAt, result=:result
 WHERE id=:id AND state='executing' AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount;

-- commandCasRescheduleRetry(:id,:owner,:generation,:nextRetryAt)——可重试失败回 pending;预算谓词进 SQL
UPDATE commands SET state='pending', claim_owner=NULL, claim_generation=NULL, lease_expires_at=NULL,
       retry_count=retry_count+1, next_retry_at=:nextRetryAt
 WHERE id=:id AND state IN ('claimed','accepted','executing')
   AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount AND retry_count < 5;

-- commandCasBudgetExhausted(:id,:owner,:generation,:completedAt)——预算耗尽终局;谓词与上条互斥
UPDATE commands SET state='failed', result_code='retryable_failure', completed_at=:completedAt
 WHERE id=:id AND state IN ('claimed','accepted','executing')
   AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount AND retry_count >= 5;

-- commandCasReconcileRelease(:id,:observedOwner,:observedGeneration,:now,:nextRetryAt)
-- reconcile 专用:零副作用窗回收。资格(lease 过期+generation<=当前上界)判在候选 SELECT;
-- 这条 CAS 本体精确匹配**候选时读到的 claim token**(R2-1:上界只是资格,不是所有权证明——
-- 迟到的 reconcile 不得误翻后来者的 claim);R1-1:接管必要条件只有 lease 过期,
-- generation 绝不是提前接管捷径(否则新世代注册瞬间击穿 2min 僵尸静默窗→双发)
UPDATE commands SET state='pending', claim_owner=NULL, claim_generation=NULL, lease_expires_at=NULL,
       retry_count=retry_count+1, next_retry_at=:nextRetryAt
 WHERE id=:id AND state IN ('claimed','accepted')
   AND claim_owner=:observedOwner AND claim_generation=:observedGeneration
   AND retry_count=:observedRetryCount AND lease_expires_at=:observedLease
   AND lease_expires_at <= :now AND retry_count < 5;
-- (release 也计一次 re-enqueue:统一"每次回 pending 都入账"语义,毒 payload 在 claim/accept 段
--  反复弄崩 lane 时同样被预算封顶;retry_count>=5 的 claimed/accepted 走 BudgetExhausted)

-- commandCasRescheduleAfterProbe(:id,:owner,:generation,:nextRetryAt,:now)
-- 效果探针得到确定 effect_not_applied 后的重排:**同一 CAS 清 unknown 簿记**(R2-4:
-- 不清则新一轮执行继承旧 streak/first_unknown_at,跨 attempt 串案提前冻结)
UPDATE commands SET state='pending', claim_owner=NULL, claim_generation=NULL, lease_expires_at=NULL,
       retry_count=retry_count+1, next_retry_at=:nextRetryAt,
       probe_unknown_streak=0, first_unknown_at=NULL, last_probe_at=:now
 WHERE id=:id AND state='executing'
   AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount AND retry_count < 5;

-- commandCasRecordProbeUnknown(:id,:owner,:generation,:tokenRetryCount,:now)
-- 效果探针 unknown 簿记:与其余翻转同族,**完整 attempt token 谓词**(R4-1:attempt 0 的慢 probe
-- 在重排/re-claim 后回写=0 行丢弃,不得污染 attempt 1 的 streak);typed op recordCommandProbeOutcome
-- 在同一 kernel 事务内跑本 CAS→读回 streak/first_unknown_at→达阈值(≥3 且跨度≥5min)则同事务
-- 直接走 ExecutingFailedUnknown+obligation——"加簿记/读阈值/终局"三步绝不拆事务
UPDATE commands SET probe_unknown_streak=probe_unknown_streak+1,
       first_unknown_at=COALESCE(first_unknown_at,:now), last_probe_at=:now
 WHERE id=:id AND state='executing' AND claim_owner=:owner AND claim_generation=:generation
   AND retry_count=:tokenRetryCount;

-- attemptObservationCas(:attemptId,:snapshotGeneration,:snapshotHostEpoch,:snapshotDesiredState,
--                        :observedState,:observationKind,:observedAt)
-- attempts 探针回写围栏(R4-2/R5-2):精确匹配 snapshot 的 desired_state(dispatched→started 赶在
-- 回写前=0 行丢弃,防启动交错假 obligation);host_epoch 用 NULL-safe 的 IS(0001 允许 NULL);
-- recordAttemptObservation typed op 的首条 CAS,0 行=整个结果丢弃(零 event 零 obligation)
UPDATE attempts SET observed_state=:observedState, observation_kind=:observationKind, observed_at=:observedAt
 WHERE id=:attemptId AND generation=:snapshotGeneration
   AND host_epoch IS :snapshotHostEpoch
   AND desired_state=:snapshotDesiredState
   AND desired_state IN ('dispatched','started');

-- capabilityConsume(:capabilityId,:now,:action,:audience,:taskId,:attemptGeneration)——manual_gate 的 intent 时权威消费
-- 在事务 B2(intent)内执行,expected-changes=1;claim 时的 GATE_SLOT 只是早失败,这条才是 at-most-once 的权威
UPDATE capabilities SET consumed_at=:now
 WHERE id=:capabilityId AND consumed_at IS NULL AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > :now)
   AND (absolute_deadline_at IS NULL OR absolute_deadline_at > :now)
   AND action=:action AND audience=:audience
   AND (task_id IS NULL OR task_id=:taskId)
   AND (attempt_generation IS NULL OR attempt_generation=:attemptGeneration);
```

每条 CAS 期望行数=1,不符=CasViolation 整事务回滚。**claimed 之后所有翻转都带完整 attempt token(claim_owner+claim_generation+retry_count)谓词**——迟到的旧执行者(wedged lane/僵尸进程/上一轮 attempt)的写入干净失败(0 行),这就是 fence 的 commands 面(R3-1)。
retry_count 语义锁定(防 off-by-one,R2-8 措辞修正):**retry_count=已发生的"回 pending 重排"次数**;首次执行时=0;retry_count=4 仍可完成第 5 次重排(计到 5),retry_count=5 不得再重排 → BudgetExhausted,即**共 5 次重排、最多 1+5=6 次执行尝试**(逐字镜像 mailbox "retry_count+1;≥5→dead")。专项测试锁两条 CAS 谓词互斥且无缝(retry_count=4 可重排、=5 必终局)。
capabilityConsume 失败(CasViolation:claim 后被 revoke/过期/绑定不符)→ 同事务改走 commandCasExecutingRejected(result_code='policy_denied')+decision event——不外发、不重试、审计留痕。exact-head(subject_digest)校验作为 consume-time hook 冻结给 FLY-1498(接缝,§6.6),不在本批实现但 SQL 谓词位已留。

### 3.3 `admitCommand` 类型化 op(admission 单点)

```ts
admitCommand(tx: WriteTx, spec: {
  id: string; kind: CommandKind; taskId?: string; attemptId?: string; generation?: number;
  payload: KindPayload[kind];            // 每 kind 结构化定义;可含 requires(见下)
  effectKey: string;                     // 非 readonly 类必填;kind 前缀化:`<kind>:<business-key>`
  notifyBefore: string[];                // 依赖的 prerequisite_notification command id 列表
  cutoverEpoch: number;
}): { outcome: 'inserted' | 'replayed'; commandId: string }
```

**两个机器概念,严格分开(R1-2)**:
- **notify_before(command_dependencies 行)**:只表达"先知会后动作",只允许指向 prerequisite_notification 类——终版 §2.9 三分类不被污染。
- **requires(payload 顶层字段 `requires: string[]`,引用 command id)**:表达"效果源/顺序前置"——如 discord_thread_create 引用其锚定 discord_post(receipt 里的 message_id 是它的输入),长文分片 chunk N+1 引用 chunk N(跨 retry 保序,R1-7)。claim 时全部 requires 必须 succeeded(§4 REQUIRES_SLOT,fail-closed:引用缺行=挡);任一 requires 终局非 succeeded → 本 command 被巡检级联 canceled(§3.4)。不动 command_dependencies 的 CHECK(0001 只认 notify_before,改 CHECK=重建表,违背只加不改)。

校验序(全部同一事务内,违规=抛错整体回滚):
1. kind ∈ 编译期联合类型(运行期表外 kind=拒,fail-closed)。
2. 分类查表:`action` 类 → `notifyBefore.length ≥ 1`(空集不为真,final §2.9a 逐字);`readonly`/`prerequisite_notification` 类 → 忽略依赖参数(readonly 不入 outbox 生命周期,只留审计行)。
3. 被依赖的 command 必须存在且 kind ∈ prerequisite_notification 类(notify_before 指向 action=概念错误,拒);requires 引用必须存在(任意 kind 皆可作前置,但不得自引/成环——requires 图在 admission 内做 DAG 校验,payload 级,无触发器兜底故校验必须严)。
4. INSERT commands(payload_digest=**确定性 canonical JSON** 的 sha256)+ INSERT command_dependencies(禁环触发器兜底)。**effect_key UNIQUE 冲突处理(R1-8)**:读出既有行,仅当完整 canonical envelope 相等(kind+payload_digest+task_id+attempt_id+generation+cutover_epoch+notify_before 集合)才返回 `{outcome:'replayed', commandId:<既有 id>}`——调用方(FLY-1499 转化/saga planner)必须用返回的 canonical id 做后续引用;envelope 不等=**fail loud 抛错**(真键碰撞绝不静默吞)。
5. `manual_gate` 类 kind(github_merge/destructive_delete):payload 必含 `capability_id`,admission 校验 capability 行存在且未消费未撤销(早失败);**权威消费=事务 B2 的 capabilityConsume CAS**(§3.2,R1-4);exact-head 语义归 FLY-1498。
6. per-kind payload 结构校验,其中硬规则:
   - `discord_post`/`notify`/`founder_page` 内容 **≤2000 字符**(admission 拒超长);kernel 包导出 `splitDiscordContent(text) → chunks` 供调用方拆 N 条命令,**splitter 自动给 chunk i+1 填 `requires:[chunk_i]`**(跨 retry 不越序;前片终局失败→后缀级联 canceled)。依据:v1 分块部分失败丢 `remainingText` 实证(research §2.3-2)。
   - `discord_thread_create` payload 必须以 `requires:[<discord_post command id>]` 锚定源消息(禁独立式建 thread),admission 校验该引用 kind=discord_post;message_id late-binding 见 §6.3。
   - `github_branch_delete` payload 必含 expected_sha + 分支形状校验(继承 v1 branch-cleanup 合同:managed 命名形状、main/master/default/protected 拒删、merge evidence 或 unmerged-bundle 恢复凭据,`branch-cleanup.ts:21-27,330-416`)——这是它不入 manual_gate 的前提(R1-5)。
   - `notify`/`founder_page` payload 支持 `target: channel|dm`(severe alert 的 DM 是活业务路径,research §8 修正,R1-9c)。

**为什么不能用触发器做 admission**:SQLite 无 deferred trigger;INSERT commands 时依赖行(同事务稍后插)必然还不存在,BEFORE/AFTER INSERT 触发器谓词"必须已有 ≥1 依赖"物理上永假。故 admission 住类型化 op;SQL 层的强制落在 claim 谓词(§4)。双保险,单独供砍(§9)。

### 3.4 settle 的依赖级联(kernel 终局裁定)

command 到 terminal `failed`/`rejected`/`canceled` 的同一事务:
1. **notify_before 级联**:所有经 `command_dependencies.depends_on_command_id=该 command` 的**未终态** dependent → CAS `canceled`(result 记 `dep_failed:<id>`)+ 每个被级联者一条 events 行。级联深度由禁环触发器保证有界。
2. **requires 级联**:同事务扫 pending/claimed 中 requires 含该 command id 的行 → CAS `canceled`(result 记 `require_failed:<id>`)+ events 行;被级联者再触发自身的两类级联(admission 已保 requires 图无环,递归有界)。**扫描用与硬门③同一把安全解析器**(`json_valid`+`json_type='array'` 的 CASE 惰性形态,R2-2):malformed 行跳过不入级联、更不得中断无关 settle 事务。低频路径(仅终局失败时扫一次),pending 行数有界,不建索引。
(依据:FINAL §1.1 "rejected/canceled:kernel 终局裁定…依赖取消→canceled";R1-7 前片终局失败→后缀分片原子取消。)

## 4. claim 协议(候选 SQL + 硬门谓词)

镜像批次1 candidates.ts 形态:**候选 SELECT 与 CAS 分离,同一 IMMEDIATE 写事务内先选后翻**(无 TOCTOU)。每 kind lane 每次取一条(batch=1)。

```sql
-- DC1 immediate(命中 commands_pending_immediate)
SELECT c.id FROM commands c
 WHERE c.kind=:kind AND c.state='pending' AND c.next_retry_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM command_dependencies cd
                     JOIN commands dep ON dep.id=cd.depends_on_command_id
                    WHERE cd.command_id=c.id AND cd.kind='notify_before'
                      AND dep.state<>'succeeded')                          -- 硬门①依赖全 succeeded
   AND (:isActionKind=0 OR EXISTS (SELECT 1 FROM command_dependencies cd
                    WHERE cd.command_id=c.id AND cd.kind='notify_before')) -- 硬门②action 必有依赖
   AND CASE                                                                -- 硬门③requires 全 succeeded
         WHEN NOT json_valid(c.payload) THEN 0                             -- 坏 payload=不可 claim,
         WHEN json_type(c.payload,'$.requires') IS NULL THEN 1             --  但绝不炸整条扫描(R2-2:
         WHEN json_type(c.payload,'$.requires') <> 'array' THEN 0          --  Codex 实测裸 json_each 遇
         ELSE NOT EXISTS (SELECT 1 FROM json_each(c.payload,'$.requires') je -- malformed JSON 直接报错,
                            LEFT JOIN commands rq ON rq.id=je.value        --  一条毒行毒死整条 lane;
                           WHERE rq.id IS NULL OR rq.state<>'succeeded')   --  CASE 惰性分支只把合法数组
       END                                                                 --  交给 json_each;缺行=挡,fail-closed)
   /* SUPPRESSION_SLOT:notify 类 kind 由 FLY-1501 注入 AND NOT EXISTS(<suppression>);本批默认恒真 */
   /* GATE_SLOT:manual_gate 类 kind 追加 AND EXISTS(<valid capability>)(早失败;权威=B2 consume CAS) */
 ORDER BY c.created_at, c.id LIMIT 1;   -- 稳定 tiebreaker(R1-7:相同 created_at 的确定性)

-- DC2 scheduled(命中 commands_pending_scheduled;谓词同上,仅入口分区不同)
SELECT c.id FROM commands c
 WHERE c.kind=:kind AND c.state='pending' AND c.next_retry_at IS NOT NULL AND c.next_retry_at<=:now
   AND (…同 DC1 硬门①②③与插槽…)
 ORDER BY c.next_retry_at, c.created_at, c.id LIMIT 1;
```

分片乱序问题的完整答案(R1-7):lane 串行只保证不并发;**跨 retry 的业务顺序由硬门③保证**——chunk 1 进 scheduled 重试期间,chunk 2 的 requires:[chunk 1] 未 succeeded,DC1 不会选中它;chunk 1 终局失败 → §3.4-2 级联 canceled 后缀。`json_each` 是候选行上的后置过滤(partial index 驱动扫描不受影响,EXPLAIN 验收覆盖含 requires 的形态)。

- 候选顺序:DC1 先、DC2 后(即时优先,重试按到点)。
- 硬门②:`:isActionKind` 由分类表静态展开(每 kind 的 lane 常量,非运行时猜测)。
- **effect_unknown 依赖挡门**:依赖 state='failed'(含 result_code='effect_unknown')≠'succeeded' → 硬门①天然挡住 action(final §2.9b "任一依赖 effect_unknown → action 不可 claim"),且 settle 级联(§3.4)会在依赖终局失败时取消 dependent——挡门是瞬时保护,级联是终局处置,两层不冗余。
- 验收:两条候选 EXPLAIN QUERY PLAN 命中对应 partial index、无 TEMP B-TREE;**加 ANALYZE(STAT4)变体断言**(FLY-1497 QA 实证 STAT4 会改判 mailbox 家族,commands 两分区家族同形状,主动纳入)。

## 5. 每 kind 处置总表(单一权威表,代码即表)

> kind 词表=设计终版 §2.5/§2.9 给定集 + research §2 审计校准的活效果扩展(每个扩展 kind 都有活代码出处);审计见到但不进词表的效果及理由见 research §8(诚实边界)。
> 表结构六列即 TS 类型六字段:`executor / notifyClass / idempotency / probeability / absentDisposition / sagaDisposition`。

| kind | executor | notify 分类 | 幂等机制 | 可探测性 | executing 崩溃窗·absent 处置 | saga 处置 |
|---|---|---|---|---|---|---|
| spawn | process | action | session/窗口名=execId,已在则 adopt(v2 §2.2);实施沿用 v1 gated-launch commit 点先例(launch_claims+commit 文件,research §2.1) | exact(has-session+`@flywheel_exec_id` 窗口选项) | 安全重放(adopt-or-spawn) | compensate→terminate |
| terminate | process | action | absent 即成功(noop) | exact | 安全重放 | none |
| discord_post | discord | action | **无**(API 无幂等键)——罕见重复入基线;**admission 限单条 ≤2000 字符**,长文=splitter 拆 N 条命令+requires 链(消灭 v1 分块丢文本坑且跨 retry 保序,research §2.3-2/R1-7) | non-probeable | 重发一次(D6;预算内) | compensate→discord_correction_post |
| discord_thread_create | discord | action | **v2 强制锚定消息**:payload `requires:[discord_post 命令]`,accept 时从其 receipt late-bind message_id(§6.3);Discord 消息 thread 的 id==源消息 id=天然键。v1 两步孤儿 gap(ChatThreadCreator 非原子)由此结构性关闭 | exact(GET channel by message id) | 安全重放(已在=adopt) | compensate→discord_thread_archive |
| discord_thread_rename | discord | action | 目标态天然幂等(活用例:stage emoji 改名) | exact(GET→name) | 安全重放 | none |
| discord_thread_archive | discord | action | 目标态天然幂等 | exact(GET→archived) | 安全重放 | none(自身常作 thread_create 的补偿) |
| linear_update | linear | action | setter 天然幂等(v1 TOCTOU 双读先例保留在 executor 内) | exact(读回) | 安全重放 | forward_repair(重投影) |
| linear_issue_create | linear | action | **客户端 UUID=effect_key 派生**(research §3.1 实证)——根治 v1 "建完→落库前崩=重复 issue"实证 gap(audit L2) | exact(按 id 查) | 安全重放(同 id 冲突=已在) | compensate→linear_update 置 canceled |
| linear_comment_create | linear | action | 客户端 UUID 同上(v1 现状=catch{} 静默吞,audit L4) | exact(按 id 查) | 安全重放 | compensate→linear_correction_comment |
| github_pr_open | github | action | 自然键:**422 后必须按 head+base 精确 re-read 才认领**(422 是 validation 通用码,不是"已存在"的证明,R1-9d;v1 先例 GitPushRunner:543 的完整形态) | exact(**repo+state=open+head+base 唯一精确匹配**,必要时绑 head sha——同 head 异 base 的 PR 不得认领,R2-7;422 后重读与 crash probe 共用同一谓词) | 安全重放 | compensate→关闭 PR |
| github_pr_close | github | action | 已关=noop(v1 先例 canceled-pr-close 先查 state) | exact(pr view state) | 安全重放 | none |
| github_comment | github | action | **无**——body 嵌 `<!-- fw:ek:<effect_key> -->` marker(v1 land-executor `trigger_comment_id=` 反查思路;注意该 marker 在 v1 是 workflow receipt 非触发评论)。**exact-body `:cool:` 不进本词表**:v2 的 ship=github_merge(manual_gate),:cool: 工作流是 v1 合并机制,批次3 切换时整体替代(R1-9a) | marker(评论列表有界扫描) | 探后:未生效→重放 | compensate→github_correction_comment |
| github_branch_delete | github | action | `--force-with-lease=<sha>` CAS;payload 持久化 expected_sha+attestation/recovery 字段(merge evidence 引用/bundle 凭据);**executor 在副作用前 fresh 重验,两个互斥模式(R3-3)**:merged-cleanup=exact binding 重验(经 §6.6-1498 的 resolveBranchBinding 只读接缝,R4-4)+fresh merge proof(merged PR head/merge-base ancestor);recovery-delete=exact binding 重验+`git bundle verify` 且 list-heads 证明 bundle 含 expected_sha(镜像 v1 branch-cleanup.ts:367-475 全套)。任一证据缺失/不确定→unknown 或 rejected,**零删除**;admission 结构校验只是早失败,防不了 admission 后 policy/merge facts 变化(R2-5) → **不入 manual_gate 的前提就是这套执行时护栏**(R1-5,Codex 有条件支持) | exact(ls-remote) | 三支:ref 不在=effect_applied→succeeded;ref 在且 sha 相同=未生效→lease 到期后安全重试;ref 在且 sha 不同=stale→rejected 绝不删 | none |
| discord_correction_post / github_correction_comment / linear_correction_comment | 同基 kind executor | action | 同基 kind(更正帖=独立新效果,带 correction 语义前缀) | 同基 kind | 同基 kind | **none(静态保证补偿不再生补偿,R1-6)** |
| github_merge | github | action(**manual_gate**) | 已 merge 再 merge=API 拒(noop 可判) | exact(pr view state,mergeCommit) | **绝不自动重放**:capability 已消费+absent→obligation 交人 | **不入自动 saga**(final §2.5) |
| destructive_delete | (按目标系统) | action(**manual_gate**) | — | 按目标 | 同上 | **不入自动 saga** |
| notify | discord | prerequisite_notification(基例,无需前置) | 无(同 discord_post,≤2000) | non-probeable | 重发一次 | none(信息类) |
| founder_page | discord | prerequisite_notification | 无 | non-probeable | 重发一次 | none |
| mute_reminder / extend_timeout / route_override / emergency_transition | kernel-action(§6.7 单事务协议,无外发) | action(bypass 矩阵,final §5-P12) | effect_key | (库内,无探针) | (库内事务,无崩溃窗) | none |
| status_read / probe_query / mailbox_read / events_read | (只读) | readonly(豁免) | — | — | — | — |
| (预留不实现)vercel_deploy | — | — | 批次3 分解 publish-report 链时落地(research §8) | — | — | — |

- **manual_gate 的 at-most-once 合同**:claim 谓词(GATE_SLOT)要求 payload.capability_id 对应 capability 有效;**capability 消费(consumed_at)与 effect_intent 同事务**——崩溃后无论探到什么,capability 已消费=自动路径关闭,只能 obligation 交人。普通效果=at-least-once+幂等;merge/删除=at-most-once+人工恢复。这是"effect_unknown 永不猜测重发"在不可逆类上的极限形式。
- saga planner:`Record<CommandKind, SagaDisposition>` 编译期穷尽(缺行=类型错误);运行期收到表外 kind → saga 拒绝启动+obligation(fail-closed)。补偿目标 kind 的 disposition 静态断言 ∈ {none, forward_repair}(防补偿递归,§9-3)。
- saga 边界:**本批交付 planner(commands→补偿 spec 列表)与补偿执行(就是普通 command)**;rework 事务本体(task/attempt supersede)归 task 域批次,调用方在同一 kernel 事务里拿 planner 结果经 admitCommand 入账。
- 补偿 command 的 notify-then-do:补偿是 action 类,**不豁免**——saga planner 对每条补偿 spec 自动附带一条 notify command 作为其 notify_before 依赖(同一入账事务)。不给 saga 开"免通知"特权通道;代价=补偿多等一条通知落地(通知本身是 prerequisite_notification 基例,可立即 claim),对 P10 ≤5min 无实质影响。

## 6. dispatcher 引擎(packages/v2-dispatcher)

### 6.1 进程模型
单进程;启动序:registry 注册(generation+1)→ **startup reconcile(§6.4,先对账后开闸)** → per-kind lane 启动。lane=同 kind 串行(天然保序:同一 PR 两条评论不乱序)、lane 间并行。唤醒:门铃(可丢,unix socket 一字节)+ T_dispatch_tick≤60s 兜底扫描(活性不依赖门铃)。

### 6.2 executor adapter 合同(纯外发,无 DB 权)

```ts
interface EffectExecutor {
  execute(cmd: ClaimedCommand): Promise<
    | { outcome: 'ok'; evidence: Evidence }                    // 外部确认(id/url/sha/exit 0)
    | { outcome: 'denied'; code: 'stale'|'policy_denied'|'noop'; error: string } // expected denial→rejected(R1-3)
    | { outcome: 'retryable_failure'; error: string }          // 429/连接前失败→预算内重试
    | { outcome: 'unknown'; error: string }>;                  // 超时/请求已出连接断/5xx
  // 效果探针(probeable kind 必备):问"效果生效了吗",不是"资源在不在"(R1-5:
  // 对删除类,资源不在=效果已生效——不复用 attempts 的 present/absent 词义)
  probe?(cmd: ClaimedCommand): Promise<
    | { outcome: 'effect_applied'; evidence: Evidence }        // 生效证据(补记 receipt 用,adopt 必须带外部 id)
    | { outcome: 'effect_not_applied'; evidence: Evidence }    // 确证未生效(可含 stale 佐证,如 sha 不符)
    | { outcome: 'unknown'; error: string }>;
}
```

错误分类判据(可执行,research §7-D5;唯一权威=上面 EffectExecutor 四出口 + §6.3 typed settle 表,R2-8 统一措辞;失败分类语义沿用 v1 LeadAlertNotifier 生产验证先例,research §2.1-4):
- **retryable_failure**:429/限流(请求被**拒收未执行**——即使 Discord 也安全重试)、连接前失败(DNS/拒连)→ 预算内重试。
- **denied(code∈stale|policy_denied|noop)**:401/403/404/参数错/前置态不符等外部明确拒绝 → **rejected**(result_code=code)+decision event,**绝不盲重试、永不告警**(P8;v1 实证:盲重排队曾积压 1669 文件;v2 的账在 commands 表,有界)。
- **unknown**:超时/连接中断(请求已出)/5xx(可能已执行)→ §6.4 对账路径。
adapter 单次调用带 T_effect 超时。adapter **无 DB 写权**;需要库内事实时(如 branch binding),经 dispatcher 注入的**只读 facade**(kernel read API)获取——与 v2 §1.3 "executor 经 kernel API 提交结果"一致,写永远回到 dispatcher 的 kernel 事务。

### 6.3 单条命令的正常生命周期(库内四事务 A/B1/B2/C + 事务外外发)

```
事务A : claim  = requireIdentity + DC1/DC2 候选 + CAS pending→claimed(lease=now+T_lease)
事务B1: accept = CAS claimed→accepted(accepted_at)
                 [同事务做 payload late-binding 校验:requires 引用(如 discord_thread_create
                  锚定的 discord_post)经其 effect_receipt 事件解析出外部 id(message_id);
                  requires 必 succeeded(claim 硬门③已保证);receipt 缺外部 id=fail-loud 转 rejected]
                 —— accepted 独立提交=可入库的恢复态(R1-3:否则"accepted 已提交后崩"窗口造不出来)
事务B2: intent = CAS accepted→executing + events('effect_intent', event_uid='ei:<id>:<retry_count>')
                 [manual_gate 类:capabilityConsume CAS 同此事务(§3.2,R1-4);
                  CasViolation(claim 后被 revoke/过期/绑定不符)→ 同一恢复事务改走
                  commandCasExecutingRejected('policy_denied')+decision event,零外发]
(事务外)      : executor.execute()   ← 唯一发生外部副作用的位置,绝不在任何事务内
事务C : settle = 按 execute 结果四分支(typed settle 总表,R1-3):
  ok                → events('effect_receipt', event_uid='er:<id>:<retry_count>') + CAS →succeeded('succeeded')
  denied(code)      → CAS →rejected(result_code=code) + events kernel decision(终态驱动源=decision event)
  retryable_failure → retry_count<5:CAS 回 pending+退避 | retry_count>=5:CAS →failed('retryable_failure')
                      + terminal observation event + obligation(episode_key='cmd_retry_exhausted:<id>')
  unknown           → 不翻终态,留 executing,进入 §6.4 对账路径
```

event_uid 确定性派生(`ei:/er:<command_id>:<retry_count>`)→ 崩溃重放时 UNIQUE(event_uid) 幂等,不双记账。
依赖级联(§3.4)挂在每个到达 terminal 的 settle 事务内,原子完成。

### 6.4 reconcile 协议(startup + 每 tick;Lead 强化②的可执行序)

**接管资格(R1-1,唯一必要条件=租约过期)**:`state IN ('claimed','accepted','executing') AND lease_expires_at <= now AND claim_generation <= 当前世代`(commands_inflight 索引)。generation 只作合法世代上界与审计,**绝不是提前接管捷径**——新世代注册后,旧世代 in-flight 的 2min 静默窗必须完整等完(旧进程在途 HTTP 的存活上限),否则 non-probeable 类立即双发。同世代未过期租约的 in-flight 一律不碰(活 lane 的领地)。

```
claimed / accepted(租约已过期)→ commandCasReconcileRelease 回 pending(retry_count<5,否则 BudgetExhausted)。
  依据:accepted 的定义=尚未产生副作用(v2 §1.1),零副作用窗,安全重放。

executing(有 intent,无 receipt,租约已过期)→ 按 kind 可探测性:
  probeable:
    probe() → effect_applied     → 补记 receipt(adopt,evidence 必含外部 id/url/sha,R1-5)+ CAS →succeeded;streak 清零
            → effect_not_applied → 查处置表 absentDisposition:
                          安全重放类 → commandCasRescheduleAfterProbe(R2-4:**同 CAS 清
                            probe_unknown_streak/first_unknown_at**,否则新一轮执行继承旧簿记跨 attempt 串案;
                            retry_count>=5 → BudgetExhausted+terminal observation+obligation,显式分支)
                          stale 佐证(如 branch_delete 的 sha 不符)→ CAS →rejected('stale')+decision event
                          manual_gate → CAS →failed('effect_unknown')+obligation(capability 已消费,绝不自动重放)
            → unknown  → typed op recordCommandProbeOutcome(§3.2 recordCommandProbeUnknown CAS,
                          完整 token,0 行=陈旧回写丢弃):同一事务簿记+读阈值,
                          streak≥3 且 now-first_unknown_at≥5min → ExecutingFailedUnknown
                          +obligation(episode_key='cmd_effect_unknown:<id>');
                          否则留 executing,下 tick 再探(重试的是探针,不是效果)
  non-probeable(discord 族):
    CAS 回 pending(retry_count+1,退避)——重发一次,接受罕见重复(FINAL §1.2e 诚实基线);
    retry_count≥5 → BudgetExhausted+obligation。
```

- **顺序保证**:先 probe 后处置,同一 command 的 probe 与状态翻转在不同事务(probe 是事务外只读外呼);翻转 CAS 带完整 attempt token(owner+generation+retry_count)谓词,期间若被别人翻走/重排=0 行 CasViolation 静默弃(R3-1)。
- 升级参数(N=3,5min,T_lease=2min,退避 30s×2^n cap 15min,预算 5)集中在参数模块(§7)。

### 6.5 attempts 进程探针(desired vs observed)

- 每 T_attempt_probe_tick=20s:一次 `tmux list-sessions` 枚举(单次批量,非逐 attempt 外呼),对所有非 terminal attempts(desired ∈ dispatched/started)比对。**回写一律经 typed op `recordAttemptObservation(tx, snapshotToken, result)`(R4-2)**:snapshotToken=扫描起点读出的 {attempt_id, generation, host_epoch, desired_state};写回事务首条 CAS=§3.2 attemptObservationCas(绑 `id+generation+host_epoch IS :snapshot+desired_state=:snapshot 精确值`,R5-2:不止 IN 集合——snapshot=dispatched 而 1498 已推进 started 时旧观测必须 0 行),0 行=attempt 已被终结/换代/推进→**整个结果丢弃,零 event 零 obligation**——0002 的 tombstone 触发器只管"终结时已存在的 obligation",管不了终结后才插入的(Codex R4 实测:terminal 后插入的 episode 永久 open),这道 CAS 是唯一防线。observation event 与 episode open/resolve 与该 CAS 同事务:
  - 命中(session 名=execution id,host_epoch 同代)→ observed='present';写库仅在**值变化**或距上次刷新 ≥5min(防 20s 一拍的行churn)。
  - 枚举成功+未命中+host_epoch 同代 → observed='absent' + events('observation') + **obligation(episode_key='attempt_absent:<attempt_id>')**——"权威账与现实矛盾"类,交 Lead 判断(C1:重开 attempt 还是升级;判断不在本批)。
  - 枚举调用失败/超时(T_probe=10s)→ unknown:streak+1 落库(attempts 新列);streak≥3 且跨度≥5min → obligation(episode_key='attempt_probe_blind:<attempt_id>')。**探针只回答在不在,绝不判"卡住"**(C2 归 Lead/T_max,v1 §2.3)。
- host_epoch 跨代的 absent 不可信 → 记 unknown 不记 absent(v1 §2.3 逐字)。
- **探针自产 obligation 的销账归探针(R1-10)**:同代确定观测恢复时,同一写事务原子 resolve 本引擎开的 episode——present 恢复 → resolve `attempt_absent:<attempt_id>`;任何确定答案(present/absent)→ resolve `attempt_probe_blind:<attempt_id>` 并清 streak。resolved 后同 episode_key 可重开(obligations_episode_open 是 partial UNIQUE WHERE open)。1501 只消费 open obligation 做聚合/通知,不负责这两类的销账(接缝写进 §6.6)。`cmd_effect_unknown:<id>`/`cmd_retry_exhausted:<id>` 例外:command 已终局,无自动恢复事实,只能人工 resolve。
- P2 验收:spawn 后立杀,20s 拍×60s 窗 ≥2 拍 → observed='absent'+obligation 在 60s 内成立。

### 6.6 与姊妹批次的接缝(冻结面)

| 对手 | 冻结面 |
|---|---|
| FLY-1499 | `admitCommand`(§3.3)是转化事务写 outbox 的唯一入口;**必须消费返回的 canonical commandId**(replayed 分支,R1-8);"处理完成=回复 command 已入 outbox"引用其提交语义 |
| FLY-1501 | ①claim 候选 SQL 的 `SUPPRESSION_SLOT`(notify 类 kind;本批恒真+插槽位测试);②obligation 行(§6.4/§6.5 产出)是 1501 聚合/通知的输入;③**销账分工(R1-10)**:attempt_absent/attempt_probe_blind 由本批探针在事实恢复时原子 resolve,1501 不重复销;cmd_* 两类终局 episode 归人工/Lead 处置 |
| FLY-1498 | ①`GATE_SLOT` 谓词(claim 早失败):本批只验 capability 结构有效;②**权威消费点=B2 capabilityConsume CAS(§3.2)**,exact-head(subject_digest)校验作为该 CAS 的追加谓词由 1498 冻结落地(R1-4)——不是 claim-time 插槽;③kernel-action delegate 注册(§6.7):route_override/emergency_transition 的业务 CAS;④**`resolveBranchBinding(repo, branch)` 只读接缝(R4-4)**:返回 {boundWorktreeId, attemptId, generation, state}|unknown,权威=1498 的执行所有权域(批次3 切换期可由 v1 StateStore.getWorktreeBinding 的只读 transitional adapter 供数,**退役条件可验收**:批次3 完成 v2 binding backfill+双向核对(v1/v2 逐行一致)后、旧 StateStore 原路径 fence(切换手册步骤)之前删除 adapter,切换 Go/No-Go 清单加对应一条);branch-delete executor 在外发前经 dispatcher 注入的只读 facade fresh resolve,resolve 不到/unknown=零删除 |
| FLY-1501(补) | kernel-action delegate 注册(§6.7):mute_reminder/extend_timeout 的业务 CAS |

### 6.7 kernel-action 执行协议(bypass 四 kind;R2-3,final §5-P12 审计合同的机器化)

bypass 四 kind 无外部副作用,**不走 B1/B2/C 外发生命周期**;claim(事务A,同普通 lane)后,执行=**单个 kernel 写事务**原子完成:

```
事务K(单事务,typed op settleKernelAction;固定顺序,R3-2):
  1. requireIdentity(dispatcher 身份)
  2. delegate 已注册确认 —— 在 capability 消费**之前**(未注册不得烧掉单次 capability)
  3. capability/actor/TTL 校验+消费(逐 kind 按 P12 矩阵行:mute/extend/route=Lead 凭据+TTL 上限,
     emergency_transition=独立 founder 凭据单次)——capabilityConsume 同款 CAS 形态
  4. 业务效果 —— delegate **不持有 WriteTx,也不返回 SQL**(R4-3+R5-1:任意 {sql,params} 仍可表达
     "有副作用但 changes=0"——Codex 实测单条 CREATE TABLE 后 changes()=0 而表真实存在;且 owner 批次
     生成 SQL 会破坏 §0"写路径 SQL 收口 kernel 包")。delegate=纯函数
     `buildBusinessCas(cmd) → BusinessCasSpec`(discriminated:{specKey, params}),
     **canonical 业务 UPDATE 常量与 kind→specKey allowlist 全部住 v2-kernel**(owner 批次把自己域的
     单行 UPDATE 常量提交进 kernel 常量表,注册时只绑 specKey+参数构造);kernel 执行前先验
     specKey ∈ 该 kind 的 allowlist(表外/DDL/任意 SQL 在类型与运行期两层都不可表达),
     再跑对应单行 UPDATE:changes=1→granted;changes=0→denied(canonical UPDATE 未命中=零副作用);
     changes>1→FenceViolation 整事务回滚。多行效果不存在于 P12 四 kind
     (mute/extend/route=单行 setter;emergency_transition 的额外 obligation 由 kernel 自己写,非 delegate)
  5. events.kind='bypass_used' 一行(event_uid 确定性='bu:<command_id>:<retry_count>'),payload 逐字含
     {command_id, bypass_kind, actor, reason, capability_id, expires_at, outcome:'granted'|'denied'}
     (P12 审计合同:**拒绝也必写,零静默**)
  6. command 终局 CAS(带完整 attempt token):granted→commandCasClaimedSucceeded(§3.2,claimed 直达,
     不经 executing);denied→commandCasExecutingRejected('policy_denied',其谓词含 claimed 态)
  7. 依赖级联(§3.4)同事务
```
K 中途任何异常=整事务回滚(capability 未消费、bypass_used 未写、command 仍 claimed→lease 过期后 release 重放)。

- **delegate 注册表**:每 kind 的业务 CAS 由其 owner 批次注册(mute_reminder/extend_timeout→obligations/超时域=FLY-1501;route_override/emergency_transition→派发/gate 域=FLY-1498);注册物=`buildBusinessCas` 纯函数(BusinessCasSpec 封闭形态,SQL 常量随 owner 批次进 kernel 常量表)。本批交付协议壳+注册接口+**未注册=rejected('policy_denied')+bypass_used(outcome=denied, reason=delegate_unregistered)**——bypass 在 owner 批次落地前结构性不可用,而不是"看似可用实则半截"。emergency_transition 额外建 obligation 记录(final §5-P12 逐字,kernel 写)。
- 验收:P12 矩阵每行正反两测(授权 actor→succeeded+bypass_used granted;未授权→403 语义 rejected+bypass_used denied+零业务副作用);denied 路径 obligation/告警零行(P8);delegate 未注册 fail-closed 测试;变异对照(去掉步 3,断言审计断言转红)。

## 7. 参数表(集中配置,禁散落魔法数)

| 参数 | 值 | 依据 |
|---|---|---|
| T_dispatch_tick | 60s | 门铃快路+tick 兜底;门铃全丢最坏延迟一拍 |
| T_lease | 2min | 僵尸副作用静默窗 > 最慢外发(spawn~60s)+超时余量 |
| T_effect | spawn 60s/其余 30s | 单次外发超时,超时=unknown |
| 退避 | 30s×2^n,cap 15min | 镜像 mailbox 家族(FINAL §0.5) |
| 重试预算 | 5 → failed+obligation | 镜像 mailbox ≥5→dead;C7 升级给人 |
| T_attempt_probe_tick | 20s | P2 的 60s 窗内 ≥2 拍 |
| T_probe | 10s | 只读探查秒级;超时记 unknown 一次 |
| unknown 升级 | streak≥3 **且** 跨度≥5min | 双条件防风暴误升/瞬断慢愈(research §4) |
| observed 刷新 | 变化即写;不变 ≥5min 心跳一写 | 防 20s 行 churn;§0.5b 写纪律 |

## 8. 验收矩阵(TDD;含变异验证,Lead 强化④/指令③)

### 8.1 迁移
- 0005 fresh 全链 / 从 0004 已有库升级 / checksum 台账 / **只加不改断言**:0004 库与 0005 库对 17 表逐表 `PRAGMA table_info` 对照,旧列集合完全一致,**新列集合精确等于** commands 5 列+attempts 3 列(equal-set 断言,非超集断言,R3-4);既有索引/触发器零变化;新索引恰为 §2 三条。

### 8.2 claim 协议(每条守卫配"变异对照":把该谓词从 SQL 中去掉后断言违规**能**通过——证明测试真的在测这道门)
- 双连接并发 claim 同 kind:恰一赢(better-sqlite3 双连接实测,参照批次1 concurrency-cross-process)。
- 旧世代 dispatcher claim/settle 全拒(requireIdentity+CAS owner/generation 谓词)。
- 硬门①:依赖未 succeeded(含 failed/effect_unknown)的 action 不可 claim。
- 硬门②:action 类零依赖不可 claim(绕过 admitCommand 裸插的兜底)。
- 硬门③requires:未 succeeded 的 requires 挡 claim;**引用缺行=挡(fail-closed LEFT JOIN 形态专项)**;requires 全 succeeded 放行。
- 分片保序三例(R1-7):首片进 scheduled 重试、后片 immediate 不越序;相同 created_at 靠 id tiebreaker 确定;dispatcher 重启后顺序不变。前片终局失败 → 后缀级联 canceled(§3.4-2)。
- SUPPRESSION_SLOT 默认恒真+插槽可注入(1501 接缝回归)。
- GATE_SLOT:无 capability/已消费/已撤销的 github_merge 不可 claim。
- **capability 竞态三例(R1-4)**:claim 后 intent 前 revoke / 过期 / 绑定不符 → B2 consume CasViolation → rejected('policy_denied')+decision event,零外发。
- **kernel-action(§6.7)五例(R3-2/R4-3)**:crash-before-K(command 留 claimed,lease 过期后 release 重放);K 中途异常整事务回滚(capability 未消费/bypass_used 未写);granted/denied 各自的依赖级联;delegate 未注册在 consume 前拒(capability 零消耗);**denied 零副作用结构性验证**——canonical UPDATE 命中 0 行 → denied 且全库快照不变;**spec 逃逸变异组(R5-1)**:尝试注册返回 DDL/非 allowlist specKey/裸 SQL 的 delegate,必须在执行前被类型层或运行期 allowlist 拒绝(变异对照:放开 allowlist 断言 CREATE TABLE 后 changes()=0 仍被误判 denied——证明这道门在测真东西)。
- **同 head 异 base 不认领(R2-7)**:github_pr_open 的 422 重读/crash probe 用 repo+open+head+base 精确谓词,仅 head 匹配的 PR 不得 adopt。
- **僵尸静默窗反例(R1-1)**:新世代注册后,旧世代 executing 且 lease 未过期 → reconcile 不 probe、不 release、不 resend(变异对照:把 lease 谓词换回 OR generation,断言双发测试转红)。
- **attempt token 竞态两例(R3-1,变异对照:去掉 retry_count 谓词断言转红)**:①旧 release 快照后 command 已被 release+re-claim → 旧 release CAS 必 0 行;②attempt 0 executing→重排→re-claim 到 attempt 1 后,attempt 0 的迟到 success/probe settle 必 0 行(不得把 attempt 1 写成 succeeded)。
- **malformed payload 两例(R2-2,变异对照:去掉 CASE 换裸 json_each 断言转红)**:坏行在前、同 kind 好行仍可 claim(扫描不炸);无关坏行存在时 terminal settle 的 requires 级联照常完成。
- DC1/DC2(含带 requires 的形态)EXPLAIN 命中 partial index、无 TEMP B-TREE;**ANALYZE(STAT4)变体**同断言。

### 8.3 admission
- action 无依赖=拒;依赖指向非 prerequisite_notification=拒;表外 kind=拒(fail-closed);manual_gate 缺 capability=拒。
- **effect_key 冲突(R1-8)**:envelope 完全相等 → `{replayed, canonical id}`(调用方拿到既有 id);kind/payload_digest/task/attempt/generation/epoch/依赖集任一不等 → fail loud 抛错(真键碰撞绝不静默);payload digest=确定性 canonical JSON(键序无关)专项。
- requires:引用缺行=拒;自引/环=拒(admission DAG 校验);discord_thread_create 无 requires 锚定或锚定非 discord_post=拒。
- discord_post/notify/founder_page >2000 字符=拒;`splitDiscordContent` 拆分后逐条 ≤2000、拼接还原原文、chunk i+1 的 requires 自动指向 chunk i。
- github_branch_delete:缺 expected_sha=拒;protected/default 分支形状=拒(v1 护栏合同专项)。
- notify/founder_page 的 target=dm 路径结构校验(R1-9c)。
- late-binding:requires 的 receipt 缺外部 id 时 accept 失败转 rejected(fail-loud,不带空 id 外发);正常路径解析出的 message_id 与 receipt 一致。

### 8.4 崩溃窗口重放(四窗口 × kind 类别,kill 点注入)
- claim 后崩(claimed 已提交)/ accept 后崩(**accepted 已独立提交,B1/B2 拆分使该窗口真实可造,R1-3**)→ lease 过期后回收重放,外部零重复(spawn 计数=1)。
- executing 崩·probeable·效果已生效 → probe present → adopt receipt,无第二次外发。
- executing 崩·probeable·效果未生效 → absent → 安全重放类恰好补做一次;manual_gate 类冻结+obligation(**github_merge 永不自动重放**的专项断言+变异对照)。
- executing 崩·non-probeable → 重发一次(允许重复),receipt 恰一条(event_uid 幂等)。
- 崩溃重放的 events 幂等:同 retry_count 重放不产生第二条 intent/receipt 行。

### 8.5 探针
- P2 原文:spawn 后立杀进程,60s 内 attempt observed='absent' 且 obligation 建立(v2 §5-P2)。
- host_epoch 跨代 absent → 记 unknown(不误判死)。
- unknown 双条件:3 次未满 5min 不升级;满双条件恰升级一次(episode_key 幂等);中途确定答案 → streak/first_unknown_at 清零。
- streak 跨进程重启保持(落库断言:杀 dispatcher 重启,streak 延续)。
- **陈旧回写围栏两例(R4-1/R4-2,变异对照:去掉 token/快照谓词断言转红)**:①attempt 0 的慢 unknown probe 在重排+re-claim attempt 1 后回写 → recordCommandProbeUnknown 0 行,attempt 1 streak 不变;②attempts 探针外呼期间 attempt 被终结/host_epoch 换代 → recordAttemptObservation 0 行,零 observation event、零 open obligation(对照 0002 tombstone 触发器管不到的"终结后插入"路径);③dispatched→started 推进赶在回写前 → snapshot desired_state 精确谓词 0 行(R5-2);④host_epoch 为 NULL 的 attempt,unknown 观测经 IS 谓词可正确回写(NULL-safe 专项)。
- **销账闭环(R1-10)**:absent→present 恢复原子 resolve `attempt_absent`;blind→确定答案 resolve `attempt_probe_blind`;resolved 后新故障可重开同 episode_key(partial UNIQUE WHERE open 专项)。
- 效果探针 adopt 必带 evidence(外部 id/url/sha)——`effect_applied` 无 evidence=测试拒绝(R1-5);branch_delete 三支各一例(不在=成、同 sha=可重试、异 sha=stale rejected)。
- **跨 attempt streak 串案(R2-4)**:unknown×2→effect_not_applied 重排(RescheduleAfterProbe 清簿记)→新 attempt unknown×1 → 不得升级(first_unknown_at 已清);`retry_count=5 + effect_not_applied` → BudgetExhausted 终局(不再重排)。
- **branch-delete executor 级零删除四例(R3-3)**:no-merge-evidence / protected-policy 在 admission 后变化 / binding mismatch / bundle 缺失或不含 expected_sha —— 全部零删除且按 unknown/rejected 归类(变异对照:去掉 fresh 重验断言转红)。

### 8.6 saga
- 处置表编译期穷尽(新 kind 缺行=类型错误,以 tsd/期望编译失败用例锁住)。
- 运行期表外 kind → saga 拒启+obligation(fail-closed)。
- 补偿防递归静态断言(compensate 目标的 disposition ∈ {none,forward_repair})——**correction kinds(disposition=none)使该断言对全表真实成立**(R1-6:不再有"补偿=同 kind"的静态矛盾);断言对全表逐行执行,非抽查。
- 补偿失败/取消路径:correction command 走普通 settle(重试预算/obligation),saga 不追加二层补偿(表内 none 静态保证)。
- P10:人为 carrier 错位 → saga 首事务 commit 到改道完成 ≤5min(计时验收)。

### 8.7 结果分类(P8)
- policy_denied/noop/stale → rejected 结清,**零 obligation/零告警行**(P8 断言+变异对照:把结清逻辑改成告警,断言转红)。

### 8.8 依赖级联
- 依赖 failed → dependent 同事务 canceled+events 行;链式依赖有界(禁环触发器已保证,断言级联终止)。

### 8.9 mock 与真工具互补(memory 纪律)
- adapter 层单测用 fake 外部;**每个 probeable executor 至少一条真工具 spike 测试**(tmux 真 has-session;gh/linear 真 CLI 的 dry 探测在 CI 不可用时标记 local-only,实施节点真机跑)——mock 测试需 real-tool 补位。

## 9. 反 over-reaction 总表(逐机制两问;保护性机制单列供砍)

### 9.1 必要机制(两问全答)

| 机制 | 哪个已枚举场景需要它 | 根治为何不够 |
|---|---|---|
| outbox(转化只写 pending) | A7/C4/C8 | 外发进 SQL 事务物理不可能;"发出去就忘"=A7 复发 |
| 执行 claim+owner/generation 谓词 | C4/C7+FLY-176/172 本机实证 | "单实例"是运维意愿非机器事实 |
| lease(2min 静默窗) | 僵尸进程在途 HTTP 的双发窗 | fence 只挡 DB 写,挡不住已出网的调用 |
| intent/receipt 同事务 | executing 崩溃窗归因(P2/A7) | 不记 intent=只能猜;猜=重发风暴或静默丢 |
| 三窗口 reconcile+错误三分类 | C4/C5/C7/C8 | 无分类=把 4xx 当 unknown 冻结吞吐,或把超时当失败重发 |
| 探针三态+host_epoch | C1/C2;FLY-1234 误报家族本机实证 | 二态(在/不在)就是 v1 病根:探不到≠死了 |
| unknown 有界升级(落库) | 探针自身坏(tmux server 挂)不能无限 hold | 内存计数=重启清零,永不升级 |
| saga 总表 fail-closed | B2/P10 | 不穷举=新 kind 静默无处置 |
| notify-then-do claim 硬门 | P11 族(先斩后奏) | admission 单点可被裸写绕过 |
| manual_gate at-most-once + B2 权威 consume CAS | D1(merge 不可逆);claim→intent 间 revoke/过期竞态(R1-4) | claim-time 检查是快照,消费点才是真相;不 consume=可重复 merge |
| requires(payload 效果源/顺序前置) | thread 锚定(v1 两步孤儿实证)、A7 长文分片跨 retry 乱序(R1-7) | notify_before 被终版三分类锁死只指向通知,混用=污染分类;lane 串行只防并发不防 retry 越序 |
| correction kinds(disposition=none) | B2/P10 补偿表必须静态自洽(R1-6) | "补偿=同 kind"使防递归断言编译期必炸;运行时 depth 计数=把结构问题变运行时状态 |
| accepted 独立提交(B1/B2 拆分) | 终版状态机 accepted=可入库恢复态(R1-3) | 合进一个事务=该状态对崩溃恢复不可见,状态机名存实亡 |
| effect_key 冲突 envelope 比对 | 重放安全 vs 真键碰撞两个场景必须可区分(R1-8) | 无条件 noop=真碰撞静默丢 command,P1(账实不符)复发 |

### 9.2 保护性机制(供 founder 砍;砍了会怎样)

| # | 机制 | 砍了会怎样 | 成本 |
|---|---|---|---|
| 1 | claim 硬门②(action 必有依赖的 EXISTS) | 绕过 admitCommand 的裸 INSERT 可直接被 claim;内部 bug 时通知前置从双保险变零保险 | 一个 EXISTS 子查询 |
| 2 | 门铃(unix socket) | 无:tick 仍保活性;最坏延迟从秒级变 60s 一拍 | ~30 行代码 |
| 3 | 补偿防递归静态断言 | 错误配置可造补偿环(编译期本可拦住) | 编译期零运行时成本 |
| 4 | unknown 双条件的"跨度"分量 | 探针毫秒级连败 3 次即升级(风暴误升级,告警噪声) | 一列 first_unknown_at |
| 5 | observed 5min 心跳刷新(不变也写) | 探针活性只能靠告警侧推断,"最近一次确认在"的时戳变陈旧 | 每 attempt 每 5min 一行 UPDATE |
| 6 | ANALYZE/STAT4 query-plan 变体断言 | STAT4 改判候选索引时(1497 实证发生过)公平分区静默退化,无测试报警 | 每索引一条测试 |

## 9.5 实施提示(Codex R6 非阻塞建议)

1498/1501 各自贡献的 BusinessCasSpec 常量放 `v2-kernel` 分域模块(如 `src/ops/business-cas/{alerts,gates}.ts`),中心 allowlist 聚合——减少并行批次改同一文件的 merge 冲突;不改变已冻结的所有权与协议。

## 10. 不做什么(本单边界)

- 不接线:无 daemon/launchd/启动项;dispatcher 包零生产 import。
- 不做 mailbox 消费/公平性/processing_attempts(1499);不做告警聚合/抑制规则内容/注入垫片(1501);不做 gate 语义/task 派发/ship 前置(1498);不做切换手册执行(批次3)。
- 不重开设计终版任何已裁决项(含:Discord 不造历史扫描探针;kernel 自研不引 MQ)。
- readonly 四 kind 只保留枚举位与豁免分类,不实现查询服务(那是 kernel HTTP API/批次3)。

## 11. plan 自证(设计阶段已做实证)

1. Linear 客户端 UUID:@linear/sdk **60.0.0 与 64.0.0 两版** `_generated_documents.d.ts` 均实读确认 `CommentCreateInput.id`/`IssueCreateInput.id` 存在;仓内混 pin 事实已核(research §3.1),dispatcher 包自行 pin+类型锁。
2. 批次1 kernel 合同逐条实测(research §1.1):write 事务纪律/CAS/requireIdentity/registry/迁移器形态。
3. commands/command_dependencies 现状逐列核对(research §1.2),缺口清单由此得出(§1.3)。
4. v1 外发路径全仓审计已完成(research §2,35 个外发点+四个半成品 outbox 先例+休眠链排除)→ kind 词表与幂等/探测事实全部有活代码出处;v1 三个实证 gap(Discord 分块丢文本/ChatThreadCreator 两步孤儿/Linear 建单落库前崩重复)在本设计中逐一结构性关闭(§3.3-6/§5)。
5. SQLite 无 deferred trigger→admission 触发器方案不可行的论证(§3.3)。
6. 失败分类与队列上限的取舍有生产事故背书(1669 积压文件,research §2.1-4)。
