# FLY-1500 动作黑匣子 — v2 终稿映射
Issue: FLY-1500
日期: 2026-07-27
基于: `/tmp/v2arch/v2-final-design.html`（SHA-256 `e0078266d1bb852a17e484d9aea0b7f14ad076a9f48c79bac9394f463f334b17`，托管同内容 `https://fw-reports-a53de2.vercel.app/r/c80de4dfa7a2bd33aa6f0d44824634d4/`）+ `[lead-instruction ba5fbb02-d06d-4171-a50c-73be026852f5]` + 本分支 `4abc410b`

> 本文是旧实现到 founder 终稿的单向映射，不延续旧 `plan.md` 的机制结论。旧
> exploration/research/plan/design-correction 仅作历史证据；实施以本文通过的增量评审为准。

### 0.1 仓内旧终版的停用与并稿顺序

`doc/engineer/plan/v2/design-FINAL-v2.md` 当前仍是 dispatcher 版历史终稿，在四张
映射单完成前不得再被实现引用为当前权威。全局设计文档是 FLY-1498 的单写者范围：
FLY-1498 负责给旧稿加 superseded 标记，并在四单映射收敛后并入 founder 新终稿。本单
不抢写该共享文件。

并稿/落码依赖顺序是：

1. FLY-1498/1499/1500/1501 各自 mapping review 通过；
2. FLY-1498 固化全局新权威；FLY-1499 落 `agents` migration 与 generation 语义；
3. FLY-1500 基于该真实迁移实现 actions fence，不建测试/生产 shadow authority；
4. FLY-1501 与后续调度只消费已冻结的 C5/heartbeat 面。

### 0.2 2026-07-28 并稿过渡裁定

FLY-1499 已先合入 main，并在 `v2-engine` 的消息结算事务中继续把 command effect 写入
`commands`；它的运行时与回归测试仍依赖 `commands`、`command_dependencies` 以及
`attempts` 的 observation 列。原映射要求 FLY-1500 的 `0006` 同时删除这些旧结构与
`obligations`，但在 1499 已合、engine 尚未迁到 actions 的当前并稿点照做会让引擎在
fresh migration 后直接报 `no such table: commands`。

Lead 裁定本轮 `0006` **只创建 actions 及其自身索引/约束/trigger**，暂时保留
`commands`、`command_dependencies`、`obligations` 与 attempts observation 列。
这是对 founder 终稿的有记录过渡偏离，不表示旧表重新成为目标架构，也不允许 actions
薄壳 dual-write。后续单 FLY-1518 负责把 FLY-1499 的 command effect 迁到 actions，再经
独立 design/code review 与 QA 删除三张退役表及旧 observation 列；本 PR 不跨单改写
FLY-1499 引擎。

## 1. 终稿落到本单的一句话

FLY-1500 从“异步 dispatcher 执行 commands 并主动 probe/reconcile”改为“Agent
亲手调用工具，工具薄壳在动作前后自动写同一张 `actions` 黑匣子”。黑匣子只回答
“原本要做什么、最后记成什么结果”；它不认领、不执行、不重试、不探测、不补偿，也不
据此派生义务。对外效果允许罕见重复，恢复判断交给 Agent。

本单拥有动作留痕层；不拥有 mailbox 消费、DAG 调度、心跳重启、注入垫片或 ship
批准语义。

## 2. 锁死边界

### 2.1 本单交付

1. 在 `flywheel-v2-kernel` 通过新的前向迁移建立一张 `actions` 表和四个分离的公开动词：
   - 写：`recordActionIntent`、`recordActionOutcome`
   - 读：`readAction`、`listActions`
2. 提供**恰一个**无 kind 枚举、无 kind 分支、无业务知识、无后台循环的通用工具薄壳
   `runRecordedAction`：调用方主动调用时，先记 intent，再在事务外执行传入的真实
   工具调用，最后记 succeeded/failed。它不是 dispatcher。
3. action 写入直接读取 FLY-1499 建立的唯一 generation authority
   `agents(agent_id,kind,generation)`；身份/世代由 `agent_id + generation` 决定，
   `kind` 同行校验 lead/runner 类型；不保留、不新建 shadow meta registry。旧世代只能
   留下已写 intent，不能迟到改写结果。
4. 删除本分支全部 dispatcher/claim/probe/saga/obligation-writer 实现与测试。
5. 删除本分支 dispatcher 的 command/effect-receipt writers；动作黑匣子只写
   `actions`。因 §0.2 的并稿过渡，FLY-1499 既有 engine 暂时继续写 `commands`，
   `commands + command_dependencies` 的迁移删除延后到独立跟进单。共享 domain
   `events` 表继续承载 `mailbox.dead`、DAG 事实、节点完成证据等非动作事实，不能被
   本单误删。
6. `effect_key` 是每次 action attempt 的强制、唯一字段。相同 key 的任何重放只返回
   已有行，绝不再次调用真实工具；上次 failed/unknown 后确需重做时，由人或 Agent
   显式新建一行，并强制写 `supersedes_action_id + retry_basis`，代码不得自动生成。

### 2.2 明确不做

- 不提供每 kind executor、port adapter、执行者注册或候选扫描。
- 不提供 lease、retry budget、HTTP 错误三分类、probe、reconcile、desired/observed
  对账、saga、notify-before 或自动告警/义务。
- 不枚举 GitHub/Discord/Linear/process 动作 kind；新增工具不要求改中央注册表。
- 不查询或批准 ship gate。FLY-1498 完成批准落库后，活着的 Agent 亲手调用 merge
  工具；本单只把这次工具动作写进黑匣子。
- 不实现心跳列或调度读取；列由 FLY-1499 建，调度只读该列。
- 不定义或实现跨单 C5。冻结合同仍是
  `hint(sessionRef)` + `deliver(sessionRef,{messageUid,payload,attemptUid})`，由
  FLY-1499 定义、FLY-1501 实现；本单零 import、零复制。
- 不新增 `ownerLeadId` 消费者。C4 随 obligations/病历卡族作废。

## 3. 当前代码逐块处置

| 当前落点 | 处置 | 终稿映射 |
|---|---|---|
| `packages/v2-dispatcher/**` | **整包删除** | dispatcher、ports、policy、saga、attempt probe、全部测试都与 Agent-first 相悖；同步删除 workspace lockfile 条目 |
| `v2-kernel/src/command-dispatch.ts` | **删除** | 无 claim、dispatcher identity、候选 SQL、suppression slot |
| `v2-kernel/src/command-reconcile.ts` | **删除** | 无 lease recovery、effect probe、unknown streak 或 obligation |
| `v2-kernel/src/attempt-observation.ts` | **删除** | desired/observed 探针模型被“心跳列 + 调度重启”替代，且该列不归本单 |
| `v2-kernel/src/kernel-actions.ts` | **删除** | 不再把 route/timeout 等动作交给中央 executor/delegate；Agent 调对应工具 |
| `v2-kernel/src/commands.ts` | **替换为 `actions.ts`** | 只搬通用 canonical JSON/digest 与 effect-key exact-envelope 校验；删除 command kind 总表、payload 分支校验、requires、notify-before、Discord 分片 |
| `v2-kernel/src/command-lifecycle.ts` | **替换** | 八态 command 状态机缩成 `intended → succeeded\|failed`；无 accepted/executing/rejected/canceled |
| `v2-kernel/src/fence.ts` | **裁剪** | 删除 dispatcher identity/registry key 与 command CAS 族；actions 不消费 meta registry，改由 FLY-1499 `agents(agent_id,kind,generation)` 做 intent/outcome generation/type fence；保留 FLY-1498 接手的 generic capability consume CAS |
| `0005-commands-dispatch-bookkeeping.ts` | **整条删除** | Lead 复核确认它只存在于本分支、未进 main、未被真实库应用；逐列/逐索引审计无存活消费者，全部属于已删除的 dispatcher/claim/probe/saga 记账。FLY-1499 固定占用 0005，本单 actions migration 保持 0006 |
| `0001-base-schema.ts` 的 `commands`/`command_dependencies` | **过渡保留，不由 0006 drop** | 不改 checksum-bound 基线；FLY-1499 已合且 engine 仍把 command effect 写入该表，本轮删除会造成运行时缺表。actions 薄壳不 dual-write；FLY-1518 先改 engine→actions，再删旧表 |
| `0001-base-schema.ts` 的 `events` | **保留表** | 只删本单的 `command_*`/`effect_receipt` writers；domain events 属于 mailbox/DAG/节点证据共享事实，不属于被合并的动作账 |
| `attempts` 的 `observed_state`/`observation_kind`/`observed_at` | **过渡保留，不由 0006 drop** | actions runtime 不读这些列；但 FLY-1499 刚合入的 engine fixtures/合同仍使用旧形状，本轮不跨单改写。FLY-1518 engine→actions 迁移时一并退役 |
| command/probe/kernel-action 测试及 public/type fixtures | **按 owner 收敛** | 删除本分支 dispatcher/probe/kernel-action 测试；actions 公共行为测试保留。FLY-1499 已合的 command/obligation schema 与 engine tests 不得被本单覆盖或删除 |
| `obligations` 基表与 0001/0002 triggers/index | **过渡保留，不由 0006 drop** | founder 终稿仍要求退役；但与 commands 的跨单迁移统一放入 FLY-1518，避免 ship 关头在 FLY-1500 中夹带 FLY-1499/历史 schema 重写 |
| 旧设计文档/HTML | **保留历史** | 不再作为实现权威，避免改写已审计的决策轨迹 |

## 4. `actions` 单表形状

```sql
CREATE TABLE actions (
  id                  TEXT PRIMARY KEY NOT NULL,
  task_id             TEXT REFERENCES tasks(id),
  attempt_id          TEXT REFERENCES attempts(id),
  attempt_generation  INTEGER,
  activation_id       TEXT REFERENCES activations(id),
  actor_kind          TEXT NOT NULL CHECK(actor_kind IN ('lead','runner')),
  actor_agent_id      TEXT NOT NULL REFERENCES agents(agent_id),
  actor_instance_id   TEXT NOT NULL CHECK(length(trim(actor_instance_id)) > 0),
  actor_generation    INTEGER NOT NULL CHECK(actor_generation >= 0),
  kind                TEXT NOT NULL CHECK(length(trim(kind)) > 0),
  payload             TEXT NOT NULL,
  payload_digest      TEXT NOT NULL,
  authorization       TEXT,
  authorization_digest TEXT,
  logical_key         TEXT NOT NULL CHECK(length(trim(logical_key)) > 0),
  effect_key          TEXT NOT NULL UNIQUE CHECK(length(trim(effect_key)) > 0),
  supersedes_action_id TEXT REFERENCES actions(id),
  retry_basis         TEXT,
  cutover_epoch       INTEGER NOT NULL CHECK(cutover_epoch >= 0),
  state               TEXT NOT NULL DEFAULT 'intended'
                      CHECK(state IN ('intended','succeeded','failed')),
  result              TEXT,
  created_at          TEXT NOT NULL,
  completed_at        TEXT,
  CHECK (json_valid(payload)),
  CHECK (
    (attempt_id IS NULL AND attempt_generation IS NULL AND activation_id IS NULL)
    OR
    (task_id IS NOT NULL AND attempt_id IS NOT NULL AND attempt_generation IS NOT NULL)
  ),
  CHECK (actor_kind='lead' OR activation_id IS NOT NULL),
  CHECK (
    (authorization IS NULL AND authorization_digest IS NULL)
    OR
    (authorization IS NOT NULL AND authorization_digest IS NOT NULL
      AND json_valid(authorization))
  ),
  CHECK (
    CASE WHEN supersedes_action_id IS NULL
      THEN retry_basis IS NULL
      ELSE supersedes_action_id <> id
        AND retry_basis IS NOT NULL
        AND CASE WHEN json_valid(retry_basis) = 1
          THEN coalesce(
            json_type(retry_basis,'$.evidence_ref') = 'text'
            AND json_type(retry_basis,'$.reason') = 'text'
            AND length(trim(json_extract(retry_basis,'$.evidence_ref'))) > 0
            AND length(trim(json_extract(retry_basis,'$.reason'))) > 0
            AND lower(trim(json_extract(retry_basis,'$.reason'))) NOT IN ('retry','重试'),
            0
          )
          ELSE 0
        END
    END
  ),
  CHECK (
    (state='intended' AND result IS NULL AND completed_at IS NULL) OR
    (state IN ('succeeded','failed') AND result IS NOT NULL
      AND json_valid(result) AND completed_at IS NOT NULL)
  )
);

CREATE INDEX actions_state_created
  ON actions(state, created_at DESC, id DESC);
CREATE INDEX actions_actor_created
  ON actions(actor_agent_id, created_at DESC, id DESC);
CREATE INDEX actions_task_created
  ON actions(task_id, created_at DESC, id DESC)
  WHERE task_id IS NOT NULL;
CREATE INDEX actions_logical_created
  ON actions(logical_key, created_at DESC, id DESC);
CREATE UNIQUE INDEX actions_one_root_per_logical
  ON actions(logical_key)
  WHERE supersedes_action_id IS NULL;
CREATE UNIQUE INDEX actions_one_successor
  ON actions(supersedes_action_id)
  WHERE supersedes_action_id IS NOT NULL;

CREATE TRIGGER actions_current_actor_insert BEFORE INSERT ON actions
WHEN NOT EXISTS (
  SELECT 1 FROM agents
   WHERE agent_id=NEW.actor_agent_id
     AND generation=NEW.actor_generation
     AND kind=NEW.actor_kind
)
BEGIN SELECT RAISE(ABORT, 'action actor generation is not current'); END;

CREATE TRIGGER actions_lineage_insert BEFORE INSERT ON actions
WHEN NEW.attempt_id IS NOT NULL AND (
  NOT EXISTS (
    SELECT 1 FROM attempts
     WHERE id=NEW.attempt_id
       AND generation=NEW.attempt_generation
       AND task_id=NEW.task_id
  )
  OR (
    NEW.activation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM activations
       WHERE id=NEW.activation_id
         AND attempt_id=NEW.attempt_id
         AND generation=NEW.attempt_generation
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'action attempt/activation lineage mismatch'); END;

CREATE TRIGGER actions_supersedes_insert BEFORE INSERT ON actions
WHEN NEW.supersedes_action_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM actions prior
   WHERE prior.id=NEW.supersedes_action_id
     AND prior.state IN ('intended','failed')
     AND prior.logical_key=NEW.logical_key
     AND prior.task_id IS NEW.task_id
     AND prior.attempt_id IS NEW.attempt_id
     AND prior.attempt_generation IS NEW.attempt_generation
     AND prior.kind=NEW.kind
     AND prior.payload_digest=NEW.payload_digest
     AND prior.cutover_epoch=NEW.cutover_epoch
)
BEGIN SELECT RAISE(ABORT, 'action retry must supersede matching failed/unknown intent'); END;

CREATE TRIGGER actions_immutable_fields BEFORE UPDATE ON actions
WHEN NEW.id IS NOT OLD.id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.attempt_generation IS NOT OLD.attempt_generation
  OR NEW.activation_id IS NOT OLD.activation_id
  OR NEW.actor_kind IS NOT OLD.actor_kind
  OR NEW.actor_agent_id IS NOT OLD.actor_agent_id
  OR NEW.actor_instance_id IS NOT OLD.actor_instance_id
  OR NEW.actor_generation IS NOT OLD.actor_generation
  OR NEW.kind IS NOT OLD.kind
  OR NEW.payload IS NOT OLD.payload
  OR NEW.payload_digest IS NOT OLD.payload_digest
  OR NEW.authorization IS NOT OLD.authorization
  OR NEW.authorization_digest IS NOT OLD.authorization_digest
  OR NEW.logical_key IS NOT OLD.logical_key
  OR NEW.effect_key IS NOT OLD.effect_key
  OR NEW.supersedes_action_id IS NOT OLD.supersedes_action_id
  OR NEW.retry_basis IS NOT OLD.retry_basis
  OR NEW.cutover_epoch IS NOT OLD.cutover_epoch
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'action intent fields are immutable'); END;

CREATE TRIGGER actions_terminal_once BEFORE UPDATE ON actions
WHEN OLD.state <> 'intended'
  OR NEW.state NOT IN ('succeeded','failed')
  OR NEW.result IS NULL
  OR NEW.completed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'action outcome transition is invalid'); END;

CREATE TRIGGER actions_current_actor_outcome BEFORE UPDATE ON actions
WHEN NOT EXISTS (
  SELECT 1 FROM agents
   WHERE agent_id=OLD.actor_agent_id
     AND generation=OLD.actor_generation
     AND kind=OLD.actor_kind
)
BEGIN SELECT RAISE(ABORT, 'action actor generation is not current'); END;

CREATE TRIGGER actions_no_delete BEFORE DELETE ON actions
BEGIN SELECT RAISE(ABORT, 'actions rows are not deletable in this batch'); END;
```

约束补充：

- runtime API 不暴露 DELETE，本批次也不归档或删除任何 `actions` 行。未来批次 3 只有在
  另行评审并原子保留 `logical_key` root 唯一、`effect_key` 去重和
  `supersedes_action_id` 链接（例如不可删除的热区哨兵）后才能纳入通用归档；仅有
  durable manifest 不足以授权删除。该合同落地前 `intended|succeeded|failed` 全部留在热表。
  本单不新建第二套 retention timer。
- UPDATE 只允许当前 `agents(agent_id,kind,generation)` 与行内 actor token 完全相同的
  Agent 把 `intended` 一次性改成 succeeded/failed；身份、intent、
  effect key、关联 task/attempt 等列不可改，terminal 行不可再写。
- `kind` 只要求非空字符串，不建中央枚举。
- `payload`/`result` 是 canonical JSON；`payload_digest` 独立校验 intent 内容。
- `actor_kind`、`actor_instance_id`、runner 必填的 `activation_id` 都从认证 Agent
  shell context 派生并作不可变审计快照，不接收调用点自由伪造；它们不参与 current
  authority，唯一写闸仍是 `agents(agent_id,kind,generation)`。
- `authorization` 是可选 canonical JSON 审计引用。FLY-1498 的 merge tool 必须在同一
  intent 事务验证 gate/head/capability，并写入 `{gate_id,target_head}`；通用 actions
  层不按 kind 分支。旧 command/kernel-action capability consumers 只有在 FLY-1498
  替代写面落地后才删除，`gates`/`capabilities` 基表与通用 consume CAS 保留。
- 调用方不直接拼 raw key，而是提供 `logicalEffectId + invocationUid`。这里的
  `invocationUid` 是**一次 durable 工具调用意图**的稳定 id，不是
  `processing_attempts.attempt_uid` 或 DAG `attempts.id`。允许来源只限现有 durable
  transcript tool-call id、已落库 proposal/event id，或 task-bound
  `${attemptId}:${toolCallOrdinal}` 派生值；不得为 invocation UID 新建独立表/文件/小账。
  相同调用因崩溃或同一 session 重入时必须复用同一 `invocationUid`，禁止每次进程调用
  随机生成。全新 session 若没有能力恢复原 UID，只能先读 actions/外部证据，再走显式
  supersede，不能自编 UID 假装 replay；只有带
  `supersedes_action_id + retry_basis` 的显式重做才生成新 `invocationUid`。
  kernel 机械派生：
  `logical_key = sha256(canonical({cutoverEpoch,taskId,attemptId,
  attemptGeneration,unboundActorAgentId:taskId===null?actorAgentId:null,
  kind,logicalEffectId}))`；
  `effect_key = sha256(canonical({logicalKey,invocationUid}))`。actor generation、
  actor instance、time、action row id 不入 key；但无 task 绑定时加入稳定
  `actorAgentId` 命名空间，避免两个 Lead 的同名动作互相封死；同一 agent 的
  generation 接班仍命中同一逻辑 effect。不同调用点只有显式使用同一
  `logicalEffectId` 才会共享去重域。
- `effect_key` 必填。相同 key + 完全相同 envelope 返回已有 action；相同 key +
  不同 envelope 响亮失败。同 key replay 无论旧 state 为何都不再次执行 effect。
- 一个 `logical_key` 只允许一条 root；同一 `invocationUid` 重入返回
  `disposition:"replayed"`；误用新 `invocationUid` 且不带 supersedes 会撞 root 唯一约束并
  fail loud。合法重做必须以新 `invocationUid` 派生新 effect key，
  并同时携带 `supersedes_action_id` 与 canonical
  `{evidence_ref,reason}`。prior 必须是相同 envelope 的 `intended|failed`，一行只能有
  一个直接 successor，`succeeded` 不可 supersede。链深不设上限，但每一跳都必须是人
  或 Agent 的显式调用；任何 timer/循环/error handler 都不得自动生成。
- supersede 只表示**相同 envelope** 的再次执行。payload、kind、task/attempt 绑定或
  cutover epoch 任一改变，就是新的逻辑效果，必须换新 `logicalEffectId` 开新 root；旧
  action 留作原事实，不得用 supersede 伪装成同一次效果。
- `retry_basis` 的 `evidence_ref` 必须指向外部观测或新授权（如 GitHub run/response、
  gate/人工批准 id），`reason` 不得只写 “retry/重试”。空引用、废话理由、跨 envelope
  supersede 或分叉都 fail loud。
- exact envelope 只含逻辑效果字段（kind、payload digest、task/attempt 绑定、
  logical key、cutover epoch），不含 action id、时间或 actor generation；接班后的
  current generation 因而能安全读回旧 action，但不能伪造旧 outcome。
- `cutover_epoch` 与 mailbox/domain events 使用同一 canonical epoch，避免动作审计在
  v1→v2 切换时成为无纪元孤岛。
- 不加自动 retry/probe/lease/depends-on/notification/result-code 列。

## 5. 两笔事务与工具薄壳

```text
Agent 主动调用写工具
  → 事务 A: recordActionIntent（require 当前 agents generation）
  → COMMIT
  → 工具薄壳在事务外执行真实调用
  → 事务 B: recordActionOutcome（同一 actor token + 当前 agents generation）
  → COMMIT
```

崩溃语义只有三种：

1. 事务 A 前崩：没有 action 行，也没有对外调用。
2. A 后、真实调用前崩：action 留在 `intended`。
3. 真实调用后、B 前崩：action 也留在 `intended`，诚实表示“是否做成未知”；不自动
   probe/retry/开 obligation。Agent 以后读黑匣子和外部现实；若证明确需重做，显式
   创建新 action/new effect key，并把旧 action id 与证据写入 supersedes/retry_basis。
   同 key 永远只读回，不会盲目再做一次。

薄壳是独立小包 `flywheel-v2-actions` 中**唯一的 runtime helper**
`runRecordedAction`（只依赖 `flywheel-v2-kernel`）：接受 action spec、当前
`agent_id + generation` 和调用方传入的 `perform` 函数；实现中不得出现 kind switch、
kind set、port registry 或任一 GitHub/Discord/Linear/process 名称。intent replay
返回已有 action 并在 `perform` 前短路。查询只走 kernel 的 `readAction/listActions`，
不和写工具共享一个“可能查询也可能动手”的动词。

`runRecordedAction` 可接一个 generic `prepare(tx)` callback，在事务 A 内、intent
INSERT 前运行；它只用于调用方把现有授权校验/one-shot capability consume 与 intent
原子组合，不把 gate 语义写进通用 wrapper。返回合同是：

```ts
type RunRecordedActionResult =
  | { disposition: "performed"; action: ActionSnapshot & { state: "succeeded" } }
  | { disposition: "replayed"; action: ActionSnapshot };
```

`perform` 抛错时 wrapper 先尽力写 `failed` 再原样 rethrow，不返回“失败即成功”。
调用方只有在 `disposition === "performed"` 时才能把本次调用视为真的执行；
`replayed + intended` 明确表示结果未知，`replayed + failed` 明确表示上次观察到失败，
二者都不能冒充成功继续下游。

`listActions` 的公开 options 恰为
`{state?, actorAgentId?, taskId?, logicalKey?, effectKey?, createdBefore?, limit}`：
`limit` 必填且为正整数，不设隐藏默认；排序固定 `created_at DESC, id DESC`。
`actions_state_created`、`actions_actor_created`、`actions_task_created`、
`actions_logical_created` 分别支撑事故现场最常用的 state/actor/task/retry-chain
读取，query-plan test 固定这四条命名索引。

## 6. 昨夜 WIP `4abc410b` 的搬用判断

| WIP 修复 | 判断 | 原因 |
|---|---|---|
| notify dependency target 缺失时 claim fail-closed | **删除，不搬** | notify-before 与 claim 整族删除 |
| success 先过 command CAS 再插 receipt，避免重复 receipt UID 抢先报错 | **旧代码删除；只保留“一次性 terminal CAS”不变量** | 新模型无独立 action receipt event，`recordActionOutcome` 直接一次性 terminalize 单行 |
| probe adoption 必须含外部 locator | **删除，不搬** | 无 probe/adoption |
| HTTP 4xx/429/5xx 分类 | **删除，不搬** | 无中央 executor；工具只把实际返回记 succeeded/failed，不替 Agent 推导重试策略 |

结论：WIP 没有一段代码原样保留；仅“终态写必须先通过世代+state CAS”这一内核不变量进入
新 `recordActionOutcome`。

## 7. 增量 TDD 接缝（本文 APPROVED 即视为确认）

测试只从以下公开接缝观察，不测私有 SQL helper：

1. `recordActionIntent` + `readAction`：当前 `agents` generation 的 intent 先持久化，
   任意非空 kind 可用；缺少/旧 generation fail closed。
2. `recordActionOutcome` + `readAction`：同 actor token 一次性完成；terminal 重写与旧世代
   回写均抛 `CasViolation`，原行不变。
3. `recordActionIntent`：调用方只给 logicalEffectId/invocationUid，kernel 稳定派生
   logical/effect key；同 effect key + envelope replay 返回同 id，不同 envelope、
   同 logical root 的第二条无链新行均 fail loud；同一 durable 调用重入复用
   invocationUid 得到 replay，显式重做换新 invocationUid；两个无 task 绑定的不同
   actorAgentId 可使用相同 logicalEffectId 而互不冲突。
4. `listActions`：只读筛选能找出 `intended` 黑匣子行，不产生任何写。
5. `flywheel-v2-actions` 单个通用薄壳 + fake 外部边界：fake 执行时 intent 已可读；
   success/throw 分别补 succeeded/failed；同 key replay 的 fake 调用次数保持不变；
   replay 返回 `disposition:"replayed"` 且保留旧 state/result，调用方不能把
   intended/failed replay 当成功；模拟 effect 后进程中断则行保持 intended。只 mock
   外部调用，不 mock kernel。
6. fresh migration/schema contract：`0005-agents` 后精确运行 `0006-actions`，有
   `actions`、共享 `events` 以及 §0.2 明示的过渡
   `commands`/`command_dependencies`/`obligations`；历史 0001/0002 checksum 不漂移，
   FLY-1499 engine command 读写与 FLY-1500 actions 写读同时通过；无 dispatcher
   package/导出/lockfile residue。
7. lineage/authorization：actor kind/instance 是不可变快照；attempt generation 与
   activation 绑定错误 fail closed；FLY-1498 merge prepare callback 在 intent 同一事务
   消费 capability，并把 gate id/head 写入 immutable authorization。
8. `listActions` 四种主查询各自使用命名索引、固定倒序且受 caller-required limit 限制。
9. 显式重做链：failed/intended prior + 新 invocationUid + 有效 evidence_ref/reason 才新增
   successor 并恰调用一次 perform；缺 basis、废话 basis、跨 envelope、分叉或
   succeeded prior 全部拒绝；payload/envelope 变化用新 logicalEffectId 开新 root；
   任何 throw/timer/重启路径都不会自动生成 successor。
   除公开动词用例外，schema test 必须直接执行裸 SQL，逐个证明
   `retry_basis` 缺列值/NULL、缺 `evidence_ref`、缺 `reason`、字段为 JSON null 或非 text
   都被数据库自身拒绝，不能只靠 TypeScript 校验冒充 DB 闸。

实施按垂直切片逐条 red → green；不先批量写测试。

## 8. 反 over-reaction 检查

| 机制 | 已枚举场景 | 根治为何仍不够 |
|---|---|---|
| actions 黑匣子 | 断电发生在真实工具调用与结果落库之间 | SQLite 无法和 GitHub/Discord/进程副作用做同一事务；只能诚实留下 intent |
| 世代 outcome fence | 旧会话被杀后迟到写“成功”，覆盖新会话判断 | “先杀干净”不能证明外部进程/HTTP 回调绝无迟到；库内 generation 是最后保险丝 |
| 工具薄壳自动前后记账 | Agent/工具作者忘记手写一边记录 | 靠 prompt 记忆不能形成稳定黑匣子；一个通用 wrapper 即可，不为 kind 写 executor |
| 强制 effect-key UNIQUE + wrapper replay short-circuit + 显式 supersedes 链 | merge 等危险动作在断电恢复时被同一 attempt 再次发起；intent 后 effect 前崩又必须有恢复出口 | 同 key 永久短路防盲重放；新 key 只有带外部观测/新授权证据并引用旧行才能重做，避免 one-shot 把动作烧死 |
| terminal 行不可改；runtime 无 delete API | 事后业务代码误改/误删结果，黑匣子失真 | DB trigger 守不可变；本批次无 archiver，未来只有先解决热区唯一键与 retry 链引用后才可另审删除 |

### 保护性机制，单列供 founder 砍

1. `effect_key` exact-envelope 冲突响亮失败、root/successor 唯一与 retry-basis
   fail-loud；强制 UNIQUE + 显式 supersedes 是 Lead 已锁口径，不列为可砍项。
2. immutable-field/terminal/current-generation DB triggers（其中 generation 是 founder
   已锁保险丝；本批次 `actions_no_delete` 保证归档另行评审；其余可砍成只靠 kernel
   写面纪律，但本稿默认保留）。
3. 通用 `flywheel-v2-actions` helper（可砍后只交付 kernel 四动词，由批次 3 各工具自行薄封装）。

明确不复活的“保护”：dispatcher 唯一执行者、claim lease、retry budget、probe unknown
升级、notification dependency、saga、自动 obligation、kind 穷举、HTTP 分类。

### 8.1 founder 已接受的残余风险

1. effect 已发生但 outcome 未落库时，action 永远可能停在 `intended`；本单不自动 probe。
2. 显式 supersedes 虽要求 evidence/new authorization，SQLite 仍无法证明外部世界的
   “absent”观测绝对正确；新 key 重做可能产生罕见外部重复，但不会无证据或漏账。
3. 工具返回失败只表示调用方观察到失败，不证明外部 effect 必然 absent；Agent 读外部
   现实后再决定。
4. 没有中央 HTTP 分类、自动 retry、notify-before 或 saga；这些旧机制覆盖过的场景
   仍存在，但 founder 选择用 Agent 判断 + 黑匣子留痕换掉常驻流程机器。
5. 本批次保留全部 actions，选择先承受热表增长；批次 3 不能只凭 manifest 删除 terminal
   行，否则会释放 root/effect 唯一键并切断 supersedes 链。未来归档必须先设计原子热区
   哨兵或等价约束并单独评审，在此之前不得把 actions 纳入通用归档。

## 9. 实施/删除清单

### 9.1 硬前置

FLY-1499 已先合入 main；其正式
`0005-agents-config-mailbox-rebuild` 是唯一 agents authority，FLY-1500 的
`0006-actions-black-box` 紧随其后。本单 production migration 不创建 `agents`；
kernel migration 测试从空库运行真实 `0001..0006` 链，不再预装 frozen/shadow agents
DDL。本单按 0005 的最终键形消费：

- current authority 的身份/世代恰为 `agent_id + generation`，另读取同一行的
  `kind` 做 lead/runner 类型一致性约束；generation 只在 register/cutover/restart 事务推进；
- 缺行、generation 不同或 actor kind 不同一律 fail closed；
- instance/activation 只写 actions 审计快照，不加入 current authority。

若 FLY-1499 后续获批改成复合键或增加 current instance，本单必须先同步 §4 actor 列与
两条 generation trigger，并重新跑 mapping/code review，不能用兼容 meta 镜像顶住。

### 9.2 TDD 顺序

1. Schema tracer：fresh migration 先红；保留 0001/0002 checksum 字节，删除本分支
   未发布且零消费者的旧 `0005-commands-dispatch-bookkeeping`，正式链为
   1499 `0005-agents` → 1500 `0006-actions`。0006 只创建 actions 自身；按 §0.2 暂不
   drop obligations、commands/dependencies 或 attempts observation 列，共享 events
   保留。联合 migration、schema trigger 与 1499 engine command 读写均做回归。
2. Intent tracer：落 `actions.ts` 类型、canonical envelope、record/read、lineage/
   authorization snapshot。
3. Outcome tracer：读取 FLY-1499 `agents` generation + terminal immutable。
4. Thin-shell tracer：新增 `flywheel-v2-actions`，恰一个 generic function，只做
   before/perform/after/replay short-circuit；显式 successor 仍走同一函数的新 intent，
   wrapper 自己不决定何时 retry。
5. Deletion tracer：删 `v2-dispatcher` 整包和 kernel 旧 action machinery，逐项清 exports、
   tests、lockfile、文档引用之外的生产引用。
6. 运行 v2-kernel/v2-actions tests、public type boundary、`pnpm lint`、`pnpm -r build` 和
   全仓测试；环境性失败单独留证，不把窄测试冒充全仓通过。

## 10. 完成判据

- `packages/v2-dispatcher` 不存在，仓内无 dispatcher/claim/probe/saga 运行时代码。
- fresh v2 schema 已有 `actions`；actions 薄壳只写 actions，不写 command receipt
  dual账。§0.2 的 `commands`/`command_dependencies`/`obligations` 是 1499 兼容过渡
  表，不是恢复 dispatcher 方案；共享 domain events 仍在。
- Agent 发起的通用工具薄壳可证明 intent-before-effect、outcome-after-effect。
- 崩溃窗口只留下 `intended`，没有自动副作用或虚假成功。
- query 与 write 是分开的公开动词；任意查询测试都不能触发 action。
- 世代旧写、terminal 重写、effect-key envelope 冲突、无证据/分叉 supersede 均
  fail closed。
- 跨单运行时合同恰为 §11 两条；C5、heartbeat/agents、ship gate 各守其 owner，
  本单不再新增第三条。

## 11. 跨单依赖（仍只有两条）

1. 跨单原编号 C5 仍由 FLY-1499 冻结、FLY-1501 实现；本单不 import、不复制。
2. FLY-1499 建 `agents(agent_id,kind,generation,last_poll_at,...)`：heartbeat 写侧归
   1499，调度只读 heartbeat；本单 actions 写侧只读同一行的
   `agent_id + generation + kind` 做身份/世代 fence。actions migration 不创建
   agents、不保留 meta registry、不建第三份 authority。

C4 `ownerLeadId` 已作废。共享 domain `events` 是同库事实表，不是新增跨单接口；
本单只承诺不再向它写 action command/receipt。§0.2 的 engine→actions 与旧表删除债由
post-launch 跟进单 FLY-1518 承接，不视为本 PR 已验或已完成。
