# FLY-1499 消息消费循环(批次2) — 实施计划

Issue: FLY-1499 (https://linear.app/geoforge3d/issue/FLY-1499/v2批次2-消息消费循环-串行消费公平性处理账活性保证设计终版-12a-f)
日期: 2026-07-27
基于: research.md(上游: exploration.md;设计权威 = doc/engineer/plan/v2/design-FINAL-v2.md §1.2a-f,Codex R13 APPROVED;brainstorm gate 四点裁决已录)
状态: **codex-approved**(design review 10 轮:R1 十项/R2 八项/R3 七项/R4 五项/R5 三项/R6 三项/R7 三项 → R8 APPROVED → 折入跨单合同 C4/C5 → R9 四项 → **R10 APPROVED**;46 项 findings 全采纳零拒绝;评审链存 design-review/)

> **已被取代:** 本计划保留为历史设计记录；当前实施与验收权威是同目录的 `mapping-v2final.md`，两者冲突时以 `mapping-v2final.md` 为准。

---

## 0. 目标与边界

交付设计终版 §1.2a-f 消息消费循环的完整实现设计:**串行消费循环 + 公平性 + processing_attempts 处理账 + 活性保证 + consumer registry/cutover**,以及两条 1497 台账的处置(STAT4 → INDEXED BY 修订;SQL 守卫 → 评估后否决语句注册表,留痕)。

- 纯新增包 `packages/v2-engine`(name: flywheel-v2-engine),**零接线**:不 import 进任何现有运行路径,生产行为零变化;flywheel-v2.db 仍只在测试临时目录出现。
- v2-kernel **只加不改**(gate 裁决 c):新增导出与 FENCE 模板成员;唯一的既有内容修订 = CANDIDATE_SQL 四条(gate 裁决 b 显式批准,D14 手法,见 §3)。
- 不在本单:command 执行/探针/saga(FLY-1500);聚合告警事务/tier/风暴/垫片 vendor 实现(FLY-1501);门与派发(FLY-1498);生产接线/切换/retention/VACUUM(批次3)。
- 设计已 R13 APPROVED,本 plan 不重开设计;设计给了 SQL/公式原文的原样落地(修订处显式标注出处与 diff 合同),设计只给要点的展开处标 `[落地]`。

## 1. 包结构

```
packages/v2-engine/
├── package.json          # name: flywheel-v2-engine; deps: flywheel-v2-kernel(workspace);
│                         # devDeps: better-sqlite3(仅测试盘库);root-only exports map(同批次1 加严先例)
├── tsconfig.json / vitest.config.ts
└── src/
    ├── index.ts              # 导出面白名单(§10)
    ├── types.ts              # EngineRuntime / AttemptHandle / ConversionProposal / Effect / DeathEvidence / ...
    ├── sql.ts                # 引擎侧全部 SQL 常量(模块级,零 ad-hoc 字符串;snapshot 测试绑定点)
    ├── bootstrap.ts          # initializeEngineDb(meta cutover_epoch 显式初始化)
    ├── transitions.ts        # tx-scoped 相变基元:settleFailureMailboxTx / recordInjectedTx / reportDeliveryTimeoutTx
    ├── registration.ts       # registerConsumerTx()(唯一 cutover 原语)+ 精确身份 crash 归因;公开注册入口在 driver.ts
    ├── candidates.ts         # 四路候选读取 + selectNext 纯函数(K 配额/晋升/确定性择序)
    ├── consume-loop.ts       # per-agent 协调器(kind 分支:lead/runner;所有唤醒源汇入)
    ├── settlement.ts         # submitProposal()/reportConversionFailure()(AttemptHandle 全字段绑定)
    ├── enqueue.ts            # mailbox 入队 + admission(epoch 必填 fail-closed/canonical 冲突 fail-loud/notice 过载拒)
    ├── disposal.ts           # 终局收件人处置(每事务重验 authority)
    ├── driver.ts             # 活性驱动:tick(≤T_tick)/注册必拉/周期 pull/runner deliver 泵/两阶段监察
    └── __tests__/            # §11 测试清单
```

- **root-only exports map**(批次1 D16 同款):仅开放 `"."`;deep import 一律 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- sql.ts 纪律:引擎全部 SQL 是**模块级命名常量**,消费点只引常量;测试对 sql.ts 做存在性+快照断言。这是代码纪律(批次1 CANDIDATE_SQL 同款形态),**不是**被否决的运行时注册表机制(§8-R1)。

## 2. v2-kernel 导出面扩展(只加不改;每项标注为谁而加)

| 新增导出 | 类型 | 为谁而加 |
|---|---|---|
| `readRegistry(tx, key)` | runtime(fence.ts 已实现) | registration.ts 注册事务内读旧条目;settlement/disposal 每事务重验 authority |
| `writeRegistry(tx, key, entry)` | runtime(已实现) | registration.ts 注册事务 upsert(唯一 cutover 点) |
| `identitiesEqual(a, b)` | runtime(已实现) | DeathEvidence 核对;disposal/settlement 逐字段身份重验;测试 |
| `FENCE` | runtime(已实现,**加成员**见下) | transitions/settlement/registration/disposal 的 CAS 谓词模板 |

**FENCE 新增成员**(add-only;既有四成员逐字不动;失败/处置两族语义分离,全部绑定 to_agent 谓词):

```ts
// 失败族(消费失败的账;retry_count 是失败计数,dead 也计入第 5 次)
mailboxCasScheduleRetry: `UPDATE mailbox SET retry_count=retry_count+1, next_retry_at=:nextRetryAt
   WHERE message_uid=:uid AND state='pending' AND to_agent=:agent`,
mailboxCasFailureDead: `UPDATE mailbox SET retry_count=retry_count+1, state='dead', next_retry_at=NULL
   WHERE message_uid=:uid AND state='pending' AND to_agent=:agent`,
// 处置族(终局收件人处置;不伪造失败次数)
mailboxCasDisposalDead: `UPDATE mailbox SET state='dead'
   WHERE message_uid=:uid AND state='pending' AND to_agent=:agent`,
mailboxCasDisposalTombstoned: `UPDATE mailbox SET state='tombstoned'
   WHERE message_uid=:uid AND state='pending' AND to_agent=:agent`,
mailboxCasRedirect: `UPDATE mailbox SET to_agent=:newAgent, next_retry_at=NULL
   WHERE message_uid=:uid AND state='pending' AND to_agent=:oldAgent`,
```

- redirect 置 `next_retry_at=NULL` `[落地]`:旧退避是对死收件人失败史的调度,新 owner 应立即可见;retry_count 保留(失败账跨改投延续)。
- 批次1 「导出面恰等断言」(public-api.test)同步更新为新集合;kernel 守卫(关键字层)**维持现状零改动**(gate 裁决 a)。

## 3. 候选 SQL 修订(§1.2f 修订案;gate 裁决 b 批准,D14 手法)

### 3.1 修订内容与理由

1497 QA 实证 + 本设计受控 spike(research §2,七项)+ spike2(四条全 pin 复证)确立:ANALYZE 的 STAT4 直方图会把 F2/N2 改判到基础 scheduled 索引,founder 公平分区悄悄失效。修订 = **兑现设计已承诺的公平分区**:

- 四条候选 SQL 各加 `INDEXED BY <对应 _f/_nf 索引>`(索引缺失/谓词漂移 → prepare fail-loud,spike 第 6/7 项已证「只可能拒绝,不可能错答」);
- 投影加 `created_at`(30min 超龄晋升需要候选年龄;spike 第 4 项已证不改变 plan)。

DETECTOR_SQL 与七索引 DDL **零改动**。

### 3.2 修订后 canonical 文本(实现只许复制;kernel sql/candidates.ts 就地替换;**注释逐字保留 v10 原文**)

```sql
-- F1 founder·immediate(命中 mailbox_pending_immediate_f)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_immediate_f
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind='founder' ORDER BY seq LIMIT 1;
-- F2 founder·scheduled(命中 mailbox_pending_scheduled_f)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_scheduled_f
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind='founder'
 ORDER BY next_retry_at, seq LIMIT 1;
-- N1 非founder·immediate(命中 mailbox_pending_immediate_nf)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_immediate_nf
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind<>'founder' ORDER BY seq LIMIT 1;
-- N2 非founder·scheduled(命中 mailbox_pending_scheduled_nf)
SELECT seq,message_uid,payload,created_at FROM mailbox INDEXED BY mailbox_pending_scheduled_nf
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind<>'founder'
 ORDER BY next_retry_at, seq LIMIT 1;
```

### 3.3 修订合同(D14 手法)

- design-chain 归档原文(design-v10.md)**不改**;本节文本即 canonical。
- snapshot 测试:与 design-v10 原文的 diff **恰为每条两处插入**(投影 `,created_at` + `INDEXED BY <索引名>`),注释与其余文本 byte-for-byte。
- query-plan 验收升级为**带统计矩阵**:{无统计 / 完整 ANALYZE(stat1+stat4)/ 对抗形态(founder 1/7、1/50 两配比 × 3000 行)} × 四候选:恒命中对应 `_f`/`_nf`、恒无 TEMP B-TREE、恒无全表 SCAN;detector 不动但同矩阵跑安全不变量。**阳性对照**:去掉 INDEXED BY 的 free 变体在 1/7+ANALYZE 下翻基础索引(证明断言非恒真);批次1 「受控翻盘观察」测试保留(对象改为 free 变体常量,同一文件内定义)。
- 正确性等价断言:pinned 与 free 变体在多形态数据下逐行同答(spike 第 5 项入测)。

## 4. 消费协议机器化(§1.2a/§1.2c/§1.2d)

### 4.0 核心类型(types.ts)

```ts
export interface EngineConfig {
  k: number;                    // 默认 4;≥1
  promotionAgeMs: number;       // 默认 30min(与 §3.1 detector 阈值同源)
  tMaxMs: number;               // 默认 10min(转化阶段;不含 deliver,§5.4)
  tTickMs: number;              // 默认 60s;构造校验 ≤60s(设计上限)
  tDeliverTotMs: number;        // 默认 5min;构造校验 ≤5min(设计上限)
  tSwitchMs: number;            // 默认 5min;构造校验 ≤5min(设计上限;SLA 公式项)
  retryBaseMs: number;          // 默认 30s
  retryCapMs: number;           // 默认 15min = T_due_cap;构造校验 ≤15min(设计上限)
  leadPullIntervalMs: number;   // 默认 30s;构造校验 ≤30s(SLA 的 T_tick 项依赖 Lead 周期不劣于设计值;codex R2-7)
}
export const MAX_ATTEMPTS = 5 as const;   // 设计钉死(SLA 公式 S=(q−1)×5+R 硬编码 5);不可配置

// 统一运行时上下文:config/clock/scheduler 贯穿全部入口与 tx helper,无隐藏默认(codex R2-7/R4-5)
export interface EngineClock { nowMs(): number; nowIso(): string }
export type CancelTimer = () => void;                    // 取消闭包——不暴露平台 handle 类型(codex R5-2)
export interface EngineScheduler {                       // 可注入定时器(fake-timer 合同;不许直接用全局 setTimeout)
  setTimeout(fn: () => void, ms: number): CancelTimer;
}
export interface EngineRuntime { config: EngineConfig; clock: EngineClock; scheduler: EngineScheduler }

// attempt 句柄:start/deliver 发行,结算入口凭它绑定;事务内仍全字段重验(codex R2-1)
export interface AttemptHandle {
  attemptUid: string;
  messageUid: string;
  identity: AgentIdentity;      // 发行时的消费者身份(runner 含 activationId)
}

// 转化产出(§2.4a:vendor 产出只能以带身份的 proposal 提交 kernel)
export type Effect =
  | { kind: "command"; commandKind: string; payload: string;
      effectKey: string;                       // 必填非空:外发幂等支柱(§1.2 支柱②),UNIQUE 由 DB 兜底
      taskId?: string; attemptId?: string }
  | { kind: "task"; taskKind: string; state: "draft" | "ready"; payload: string;
      projectId: string;                       // tasks.project_id NOT NULL(0001 schema)
      lineageRootTaskId?: string }             // 缺省=新 lineage(root=自身)
  | { kind: "event"; eventKind: string; payload: string };
// 边界(codex R2-8:覆盖整个规范化 proposal,非仅 payload):
export const MAX_EFFECTS_PER_PROPOSAL = 32;
export const MAX_PROPOSAL_TOTAL_BYTES = 262_144;   // 规范化 proposal 全字段 UTF-8 总字节
export const MAX_FIELD_BYTES = 256;                // 单个 id/kind/effectKey/projectId 类字段上限
export interface ConversionProposal {
  handle: AttemptHandle;
  effects: Effect[];
}
export type ConversionResult =
  | { ok: true; effects: Effect[] }
  | { ok: false; error: string };
export type Converter = (msg: {
  messageUid: string; payload: string; kind: string; sourceKind: string; seq: number;
}) => Promise<ConversionResult>;             // 仅 Lead 路径使用;runner 无本地 converter(§4.6)

// 注册身份类型闭环(codex R6-2):draft 不含 generation(由事务计算),返回最终 canonical 身份
export type LeadIdentityDraft   = { kind: "lead"; leadId: string; instanceId: string };
export type RunnerIdentityDraft = { kind: "runner"; agentId: string; instanceId: string; activationId: string;
  ownerLeadId?: string };   // C4(Lead 已签):可选归属 Lead;present 必须非空;缺失时 1501 侧 fail-safe→'founder'
export type IdentityDraft = LeadIdentityDraft | RunnerIdentityDraft;
export interface RegisteredConsumer { identity: AgentIdentity }   // registerConsumerTx 的返回:事务内定稿的最终身份

export interface DeathEvidence {             // 绑定被替换的确切旧身份(codex R1-2)
  deadIdentity: AgentIdentity;               // 必须与事务内重读的旧 registry 条目逐字段相等,否则 fail-loud
  confirmedAbsentAt: string;                 // 探针确认 absent 的时刻(审计)
}
export interface InjectionShim {             // 归属本单定义,1501 实现(gate 裁决 d)
  hint(sessionRef: string): Promise<void>;                                   // 门铃,可丢
  deliver(sessionRef: string, msg: {
    messageUid: string; payload: string; attemptUid: string;                 // [落地] 句柄随注入下发,
  }): Promise<void>;                         // 会话结算时凭其构造 AttemptHandle;可重复,无 ack
}
// —— C5 接口冻结(Lead 仲裁 2026-07-27,冻结权在本单;1501 W4 据此解 block)——
// 1) deliver 可重复(消费幂等兜底,重复注入无害);2) hint 允许实现为 no-op(门铃本可丢,
//    claude-shim 依赖 builtin poller 即合法);3) sessionRef 为 vendor-opaque 字符串:引擎绝不
//    解释其内容,只从 activations.session_ref 派生原样透传(vendor 自行编码所需寻址信息);
// 4) 无 ack(结算只经 kernel 事务)。
// Codex 活跃会话投递泵形态 = **候选(a)**:sessionRef 携带 daemon 连接信息(opaque 编码),
// deliver = 每次调用临时连接 → turn/start → 关闭,shim 无持久状态。候选(b)(teams mailbox
// 写入分支)**不采用**:本单枚举不出需要它的 paused-hold 消费场景——paused/换代由 activation
// 生命周期与重投兜底,泵只对 active 会话注入;按反 over-reaction 原则记入 §8 否决表。
// 5) **连接清理硬规则**(codex R9-3):每次 vendor deliver 自持有界 connect/RPC 超时(不长于
//    引擎单次等待上限),并在 success/error/timeout 三出口的 finally 中关闭本次临时客户端——
//    「无持久状态」是行为合同不是对象属性;engine 侧 Promise.race 只保 coordinator 不被 wedge,
//    不豁免 shim 的自清理。零残留连接的计数验收归 1501(vendor 实现方);T6 的 never-settling
//    假 shim 仍是 engine 侧活性验收。
// 6) **重复语义**:重复 deliver 允许产生重复 vendor turn——收敛靠消费幂等(设计原文),
//    不承诺「恰一 vendor turn」;1501 侧任何「恰一 turn」断言须自带 vendor 级幂等机制。
```

三出口(快答/建 task 派发/登记工作项)是 proposal 的**惯用组合**而非三个特化 API:结算对 effects 泛化落账(§4.4)。设计依据:§2.10 三出口的产物同落 commands/tasks/events 行。

**proposal 事务外预检**(settlement.ts 入口,进 Kernel.write 之前):effects ≤ MAX_EFFECTS_PER_PROPOSAL;规范化 proposal 全字段 UTF-8 总字节 ≤ MAX_PROPOSAL_TOTAL_BYTES;id/kind/effectKey/projectId 类字段各 ≤ MAX_FIELD_BYTES 且非空(按 effect 种类);id(uuid)/payload_digest(sha256)/created_at 预计算——超限/缺字段在事务外被拒(含「小 payload+巨大 effectKey」反例),事务内语句数与字节数双有界(txBudget 1s 红线的输入侧保证,codex R1-7/R2-8)。

### 4.1 注册事务(registration.ts)= 唯一 cutover 点(§1.2c)

**分层**(codex R1-2 可组合性 + R3-4 runner 不设捷径 + R6-1/R6-2 挂接绑定与身份闭环):
- `registerConsumerTx(tx, rt, agent, identityDraft: IdentityDraft, evidence?): RegisteredConsumer` —— **tx-scoped 唯一 cutover 原语**,供 registerLead 与原子换代组合事务在**同一个** Kernel.write 内调用,绝不嵌套 Kernel.write;**返回事务内定稿的最终 canonical 身份**(generation 由事务计算,调用方不得自造)。§1.6 全量换代事务的组合方 = **批次3 生命周期接线**(探针证据来自 1500)——单一归属(codex R2-5)。
- **公开注册入口 = driver 方法**(codex R5-1;不设全局 singleton;不存在独立 register() 导出):
  - `EngineDriver.registerLead(agent, draft: LeadIdentityDraft, converter, evidence?)`:先做全部可失败的输入校验 → 单个 `Kernel.write` 内调 registerConsumerTx(**commit 前不写 driver map,不建 coordinator**)→ commit 返回后用**返回的最终身份**构造 Lead coordinator 并写 map → 同步 ring 一次(注册必拉)+ 安装相位 timer(codex R6-2 顺序钉死);runner draft 一律拒;
  - `EngineDriver.attachRunner(agent, identity: AgentIdentity, shim)`(codex R6-1 fail-closed 绑定):挂接前**同事务校验**——agent subject 一致、`consumer_registry:agent` 当前条目**恰等** identity、activations 该 activationId 行 `state='active'` 且 generation 相等、**且该 agent 的任何 running attempt 的 owner 三元组恰等 identity**(codex R7-3:foreign running = 账面未解释,map mutation 前 fail-loud,与 registerConsumerTx 第 4 步同一哲学);**sessionRef 从 activation 行的 session_ref 派生**(不接受第二份可漂移真相,参数里没有 sessionRef)。attachRunner 只做 commit 后动作,**不碰 registry**;
  - **coordinator map 仲裁 = durable current identity 是唯一裁判**(codex R7-1,取代「不同 identity 永不替换」):incoming ≠ current registry → 拒且零变化;incoming = current 且 map 已是同 identity → 幂等 reconcile no-op;incoming = current 且 map 挂着**过时** identity 的旧 coordinator(换代后的正常状态)→ **先 stop 旧 coordinator + 清其全部 timer,再原子替换**为 current coordinator——合法 successor 必须能接管,否则换代后无人推进(tick/owner-route/SLA 失去承载者)。同 agent 的 attach/map mutation 走 **driver 内串行化**(防「旧 attach 校验后暂停、新 attach 安装、旧 attach 回来覆盖」的调度竞态);
  - **「恰一次必拉」限定为无进程崩溃的单次调用**;registry 已提交但 attach/ring/timer 前崩溃的恢复合同 = **批次3 启动恢复**(§9-7,codex R7-2 分叉):**runner** = 枚举已提交 current registry + active activation → 幂等 attachRunner 重挂,不改 registry;**Lead** = 进程已死,恢复**就是**一次凭 DeathEvidence 的 registerLead 新 cutover(gen+1,由 T_switch 付费)——不存在「registerLead 重挂且不 cutover」的混合语义。

registerConsumerTx 步骤:

1. **subject 一致性**:identityDraft 的 subject 必须 = agent(lead: leadId===agent;runner: agentId===agent),否则拒——`consumer_registry:A` 里永远只可能是 A 的身份(codex R2-5);
2. `readRegistry(tx, consumerRegistryKey(agent))` → 旧条目或 null;
3. **旧条目存在时必须给 DeathEvidence**,且 `identitiesEqual(evidence.deadIdentity, 旧条目)` 逐字段相等,否则抛 FenceViolation(陈旧/复用证据 fail-closed;§1.2c「禁止仅凭时间让活进程失权」的机器化);
4. **旧条目为 null 时**:查该收件人**任何** running attempt(join mailbox)——存在 → fail-loud(账面有未被解释的在途:registry 丢失/被清但账没收,不许静默重建 authority;codex R2-5);
5. 新 identity:`generation = (旧?.generation ?? 0) + 1`;**runner 附加校验**:activations 表中 identityDraft.activationId 行存在、`state='active'`、`generation = 新 identity.generation`,否则拒(authority 不得指向缺失/terminal/错代的 activation;该行由组合换代事务或测试 fixture 先建;codex R2-5);**C4 写入**:runner draft 携带 ownerLeadId 时(present 必须非空 string,空串拒→整事务零残留)原样写入 registry 条目。**硬前置**(codex R9-1):1501 的 kernel 交付物——导出 AgentIdentity 增可选 ownerLeadId、parseIdentity 恰双形(legacy 五键 / 带 owner 六键,多余键仍拒)、writeRegistry 往返、**identitiesEqual 把 ownerLeadId 纳入 exact 比较(present vs absent 亦不同)**——必须先 land/rebase 进本分支,本单类型/注册路径才许 GREEN/merge;现行 parser 会在 SQL 前抛错(fail-before-mutation,无脏数据风险,但那是可用性失败不是顺序豁免)。owner 参与 exact 比较意味着 DeathEvidence/attach/map 的「恰等」全部含 owner 字段,无「owner 不同仍视为同一身份」的缝;
6. **crash 归因(同一事务,exactly-once,精确身份)**:只结算 `pa.outcome='running'` 且 `(pa.instance_id, pa.generation, pa.activation_id)` **恰等于 deadIdentity** 的行(join mailbox 限定 `m.to_agent=:agent`):
   - `FENCE.processingAttemptCasRunningSettled`(outcome='crashed',cas=1);
   - 消息仍 pending → `settleFailureMailboxTx(tx, rt, ...)`(§4.5:retry+1 退避或第 5 次 FENCE.mailboxCasFailureDead);已非 pending(成功后崩,N24)→ 只结 attempt;
   - 发现**不属于 deadIdentity 的其他 running 行** → 抛错整体回滚(fail-loud;codex R1-2);
7. `writeRegistry(tx, key, 新identity)` —— 提交 = cutover;此后旧世代一切写路径被 requireIdentity 拒;
8. **注册必拉的边界精确化**(codex R4-4/R5-1):tx helper **绝不** ring/pull/装 timer(事务回调内起 async 工作会撞 Kernel 非重入/同步合同);「必拉」发生在**最外层 Kernel.write 成功返回之后**,由拥有该消费者的 EngineDriver 同步执行:ring() 一次 + 安装相位 timer(§5.1)。可执行的签名闭环 = `EngineDriver.registerLead` / `EngineDriver.attachRunner`(上述分层条目)。外层事务回滚 → 零 post-commit 动作。验收走真实公开入口:commit 前零候选读/零 deliver;commit 返回后立即恰一次 pull;回滚无后续动作(T1/T5)。

幂等语义:提交后崩溃 → 重启再注册 = 又一次 gen+1(合法新代,旧代 running 已收账,第 6 步查无可结);提交前崩溃 → 旧条目未动,旧世代仍 authority(N18)。

**bootstrap 显式化**(codex R1-9):`initializeEngineDb(kernel)` —— 幂等写 meta cutover_epoch 种子(缺失时置 '1')。独立公开 API,由测试 fixture 与批次3 切换手册显式调用;不藏在 register/enqueue 路径里。

### 4.2 候选读取与选择(candidates.ts;§1.2e/§1.2f)

**读取**:四条修订候选(§3.2)各 LIMIT 1,统一绑定 `{agent, now}`。读取在写事务外(只是工作清单);真相校验在 start 事务内重做(§4.3)。

**选择纯函数**(codex R1-4 修正:配额清账池 = **完整 nf 池**,晋升只影响预算未耗尽时的优先级):

```
selectNext(cands: {f1?, f2?, n1?, n2?}, founderStreak: number, nowMs, cfg):
  { pick: Candidate, nextStreak: number } | null

1  nf  = [n1, n2].filter(存在)                 # 非 founder 候选(无论是否超龄)
2  fdr = [f1, f2].filter(存在)
3  若 nf 空 且 fdr 空 → null
4  若 founderStreak >= cfg.k 且 nf 非空:       # 配额硬闸:清账池=完整 nf,晋升与否无关
5      pick = oldest(nf);nextStreak = 0
6  否则:
7      promoted = nf.filter(age(created_at, nowMs) > cfg.promotionAgeMs)
8      founderClass = fdr ∪ promoted           # 超龄晋升:预算内与 founder 同级竞争
9      若 founderClass 非空:
10         pick = oldest(founderClass)
11         若 pick ∈ fdr → nextStreak = min(founderStreak+1, cfg.k)
12         否则(晋升的 nf)→ nextStreak = 0    # 服务了非 founder 即清账
13     否则: pick = oldest(nf);nextStreak = 0
14 oldest(xs) = created_at 最小,tie 取 seq 最小
```

- **硬保证(性质测试)**:存在 ready 非 founder 候选时,普通消息连续被跳过次数 ≤ k(反例回归:streak=k + 晋升 nf + 更老 founder → 必选 nf);
- 类内择序 `[落地]`:(created_at, seq) 双键最老优先;配额状态进程内,重启保守恢复 founderStreak = k(§1.2e/v9);
- scheduled 候选 due 语义由 SQL 谓词保证,选择函数不看 next_retry_at。

### 4.2a 消费写路径统一 authority 闸(codex R4-1)

包内 `requireActiveConsumerTx(tx, rt, agent, identity)`:`requireIdentity(consumerRegistryKey(agent), identity)` **加** runner 时同事务校验 activations 表该 identity.activationId 行 `state='active'` 且 `generation = identity.generation`——**activation terminal 是提交时 fence,不只是 admission 检查**。适用于**全部**消费写路径:startAttempt / submitProposal / reportConversionFailure / recordInjectedTx / reportDeliveryTimeoutTx(任何 runner 发起或以 runner 为主体的 mutation)。activation 置 terminal 提交后:迟到 proposal 拒、stale coordinator 在 disposal 行事务之间 start 新 attempt 拒(「先收账后处置零 running 尾巴」由此闭环)。终局处置用 §6 的 terminal-authority 校验(要求 terminal),两把闸互斥不混用。双连接验收:terminal 提交先于各入口 → 全拒零 mutation;terminal writer 被在途消费事务阻塞 → 只有 terminal 提交前的旧事务能完成(T4/T6/T8)。

### 4.3 start 事务(§1.2d + per-recipient 单在途)

`startAttempt(kernel, rt, identity, messageUid): AttemptStart`,单个 `Kernel.write("consume.start")`:

1. `requireActiveConsumerTx`(§4.2a;cutover 后旧世代 start 必拒 N25,activation terminal 后 stale start 必拒 R4-1);
2. 事务内重查消息行:`state='pending' AND to_agent=:agent AND (next_retry_at IS NULL OR next_retry_at<=:now)`——不满足 → `{skipped}`;
3. **per-recipient 单在途闸**(codex R1-3):查该收件人**任意** running attempt(join mailbox):
   - 命中且 message_uid = 目标:**exact-owner 核对**——该 running 行的 instance/generation/activation 必须恰等当前 identity,等 → **resume**(返回既有 handle,resumed=true;deliver 重放/同代重入不开新行,v9);不等 → 抛错(外来在途未被归因收账,fail-loud;codex R2-5);
   - 命中且 message_uid ≠ 目标 → `{blocked, inFlightMessageUid}`(串行消费是 per-recipient 性质);
   - 无 → 新行:`attempt_no = COALESCE(MAX(attempt_no),0)+1`;`attempt_uid = message_uid + '#' + attempt_no` `[落地]`(确定性 id;pa_one_running 兜底拒并发);INSERT running(身份三元组 + started_at=clock.nowIso());
4. **Lead 路径同事务写注入标记**(§5.4 两阶段):`recordInjectedTx(tx, rt, handle)`(transitions.ts 同一 helper,Lead 的 deliver 阶段长度为零);runner 路径不在 start 写标记(泵在 deliver 成功后写,§5.3);
5. 返回 `{handle: AttemptHandle, resumed}`——句柄是结算入口的绑定凭据(§4.4)。

### 4.4 成功结算 = submitProposal(settlement.ts;§1.2a 支柱①;codex R1-1/R2-1)

**唯一公开成功入口** `submitProposal(kernel, rt, proposal: ConversionProposal)`(runner 会话与 Lead converter 同走),事务外预检(§4.0)后单个 `Kernel.write("consume.settle.success")`:

1. `requireActiveConsumerTx`(§4.2a;§2.4a「带 generation 的 proposal」+ activation terminal 提交时 fence R4-1);
2. **attempt 全字段绑定核对**(codex R2-1):按 `handle.attemptUid` 读 attempt 行,必须同时满足:`outcome='running'`、`message_uid = handle.messageUid`、`(instance_id,generation,activation_id)` 恰等 handle.identity、对应 mailbox 行 `to_agent = agent` 且 `state='pending'`——任一不符整体回滚。**迟到结果不可能错绑**:uid#1 超时结算后 uid#2 在途时,#1 的迟到 proposal 带 attemptUid=uid#1,其 outcome 已非 running → 拒,#2 不动(具名回归);
3. 落 effects(全部批次1 schema;id/digest/created_at 已事务外预计算):command 行 state='pending'(outbox 写侧,执行归 1500)+ generation=identity.generation + effect_key(UNIQUE 兜底,重复=converter 合同违约整体回滚)+ cutover_epoch 取 meta;task 行(project_id 必填,lineage_root_id=自身或指定);event 行;
4. **引擎自动追加 event**(kind='mailbox.applied',event_uid='mailbox:'+message_uid+':applied:'+attempt_uid)`[落地]`:每次转化必有审计痕;
5. `FENCE.mailboxCasPendingApplied`(cas=1)+ applied_at;
6. `FENCE.processingAttemptCasRunningSettled`(outcome='succeeded',cas=1)。

任一校验/CAS 失败(late success vs failure/crash 交错,N17)→ 整事务回滚,只有一方生效。语句数 ≤ 4+effects(有界,§4.0)。

### 4.5 失败结算(transitions.ts / settlement.ts;§1.2d;codex R1-8)

- **tx-scoped** `settleFailureMailboxTx(tx, rt, agent, messageUid)`(crash 归因/显式失败/deliver 超时共用):读 retry_count:
  - `retry_count+1 < MAX_ATTEMPTS` → `FENCE.mailboxCasScheduleRetry`(next_retry_at = now + min(retryBaseMs×2^retry_count, retryCapMs),cas=1);
  - 否则 → `FENCE.mailboxCasFailureDead`(cas=1;retry_count 同步 +1,死后账面恰 5,SLA 的 R=5−retry_count 全程一致)+ event(kind='mailbox.dead')——DLQ 告警的 obligation 建行归 1501(§9 协调项);
- **公开失败入口** `reportConversionFailure(kernel, rt, handle, error)`:单个 Kernel.write:`requireActiveConsumerTx`(§4.2a)→ **同 §4.4-2 的 attempt 全字段绑定核对** → `FENCE.processingAttemptCasRunningSettled`(outcome='failed',cas=1)→ settleFailureMailboxTx。

**测试硬断言**:5 次失败路径后 processing_attempts 恰 5 行终态且 mailbox.retry_count **恰为 5**、state='dead'。

### 4.6 per-agent 协调器(consume-loop.ts;§1.2a/§1.2c;codex R1-3/R2-4)

每 (进程, to_agent) **恰一个** `ConsumerCoordinator`,构造时按 kind 二选一:`{ kind:'lead', converter }` 或 `{ kind:'runner', shim }`(runner 的 sessionRef 由 attachRunner 从 activation 行派生后持有,§4.1;codex R6-1)——**runner 绝不调用本地 converter**,两套执行模型显式分叉:

```
共享状态: running, dirty, founderStreak = cfg.k(保守初值)
ring():  dirty = true; 若 !running → drain()          # 全部唤醒源(门铃/周期/due/泵 tick)汇入
drain(): running = true
  try:
    loop:
      dirty = false
      inFlight = 查本 agent running attempt(读路径)    # resume-first
      ── lead 分支 ──
      msg = inFlight ?? selectNext(候选读取, ...)       # null → 消化 dirty 或 break
      start = startAttempt(...)                         # skipped→continue;blocked→转在途者
      res = await converter(msg)                        # 事务外;意外异常≡显式失败
      res.ok ? submitProposal(handle, effects) : reportConversionFailure(handle, err)
      founderStreak 更新;continue                      # 批间重查,batch=1
      ── runner 分支 ──
      若 inFlight 存在:
        自 started_at 超 T_deliverTot 且无 marker → reportDeliveryTimeoutTx 路径(§5.4)
        否则若退避序列(30s 起,cap 60s)判本轮应投:
          start = startAttempt(...inFlight.messageUid)     # **每次外部 deliver 前先过 resume exact-owner
                                                           # + active-consumer 闸**(codex R6-1:外部注入不可
                                                           # 撤销,授权校验必须在注入之前,不能只靠事后 marker 事务)
          start 为 resume → shim.deliver(同一 handle,不重置任何锚点);blocked/拒 → 不投
             ——**持续重投直至观察 mailbox 终态(applied/dead)或 activation terminal**(权威 v8 原文;
             marker 只结束 deliver deadline 并锚定 T_max,不是重投停止条件,codex R3-3);投毕让出
      否则:sel = selectNext → startAttempt(发 handle;成功 start 恰一次提交 sel.nextStreak,
           resume/重投不重复计数,codex R3-3)→ shim.deliver → 让出
  finally: running = false;若 dirty → ring()
```

- 同世代 single-flight:running 标志 + 单线程事件循环 + Kernel 禁并发 write(N3/N15);
- **shim.deliver 有界等待**(codex R3-1):每次 deliver 调用以 Promise.race 加时限(单次 ≤ 退避 cap;永不 settle 的 promise 被放弃,不 wedge coordinator);deliver 超时结算(§5.4)由 driver 侧独立执行,不依赖 coordinator 是否被挂住;
- **runner 进度节拍**(codex R2-4/R3-1):会话异步 submitProposal/reportConversionFailure 后,**同进程必须** ring() 该 coordinator(结算提交即推进);跨进程形态(批次3)的接线合同 = proposal 必须路由回拥有该 coordinator 的 EngineDriver 进程(§9-6),使结算后立即推进——tick 只是崩溃恢复兜底,不是每槽推进预算(否则 v11 公式不成立,codex R3-1);deliver 重投严格按退避序列(测试断言两 tick 间调用数受表约束,无忙等);
- 转化**意外异常**≡显式失败 `[落地]`(账上不可区分;毒消息不停循环,N1);结算事务抛错(CAS 竞争/预算超限):该条不结算、消息仍 pending,记录后继续(at-least-once)。

### 4.7 入队与 admission(enqueue.ts;§1.2c/§0.5;codex R1-9/R2-6)

`enqueue(kernel, rt, envelope): {enqueued|duplicate|rejected}`,envelope 含 **`expectedCutoverEpoch: number`(必填)**。单个 `Kernel.write("mailbox.enqueue")`:

1. **epoch 合同(fail-closed)**:expectedCutoverEpoch 缺失 → 拒(公开入口不许以省略升权;codex R2-6);与 meta 当前值不等 → rejected(epoch_mismatch;批次3 切换围栏对接点);meta 无种子 → 抛错(必须先 initializeEngineDb);
2. **可路由校验**(codex R3-2 收紧):consumer registry 无 to_agent 条目 → rejected(unroutable);条目为 runner → **同事务**校验其 activationId 对应 activations 行仍 `state='active'`,非 active → rejected(unroutable)——activation terminal 与本读同库串行,置 terminal 后的新入队一律拒,之前已提交的由 disposal 收尾(死信箱不再无限进水);
3. **notice 过载拒**:`retention_class === 'notice'` 且该收件人 pending lag > 500(`SELECT count(*) FROM (SELECT 1 ... LIMIT 501)`)→ rejected(overload)(§0.5 per-recipient 子集 `[落地]`;全局阈值属批次3);
4. INSERT:message_uid=uuid,state='pending',next_retry_at=NULL,created_at=clock.nowIso();canonical `UNIQUE(source_kind,source_id)` 冲突时**读回既有行比对**:payload_digest/to_agent/kind/retention_class 全等 → duplicate(幂等重放,P3);任一不等 → 抛 CanonicalConflict(fail-loud;codex R1-9)。

门铃(hint)由调用方在事务提交后发,可丢(truth 在表)。

## 5. 活性驱动(driver.ts;§1.2b)

单进程一个 `EngineDriver`,注入 EngineRuntime(测试可控)。**无精确 due setTimeout fast-path**(codex R1-10:tick 即活性保证,SLA 公式已含 T_tick 项)。

### 5.1 tick(崩溃恢复兜底)与相位 deadline 精确调度(SLA 硬性)

- **tick**:周期 ≤ T_tick(60s),单实例互斥(进程内):对每个本进程注册的消费者:due 扫描(scheduled 候选非空 → ring(),N13)/ runner 泵评估(经 coordinator.ring())/ 两阶段监察兜底(§5.4)。
- **相位 deadline 精确调度**(codex R3-1)+ **timer 生命周期合同**(codex R4-5):全部定时经注入的 EngineScheduler(§4.0,fake-timer 可测;不直接用全局 setTimeout)。EngineDriver 维护 per-(agent, attemptUid, phase) 的 **timer registry**:start → 装 deliver timer(started_at+T_deliverTot);marker 落地 → **cancel deliver timer** + 装 T_max timer(marker.created_at+T_max);attempt 结算/activation terminal/driver stop → **清空该 attempt/agent 的全部 timer**(快速成功不留 stale timer 积累,「每收件人至多一在途→至多两枚 timer」的成本论证由 cancel 纪律兑现);callback 触发时**总是**按 AttemptHandle 对 durable 状态重验(stale/early → no-op 或按剩余时间 re-arm),绝不凭 timer 自身裁决;进程重启 timer 丢失 → tick 全量复查重建(崩溃恢复兜底)。验收:replace/cancel、stale callback no-op、restart 重建、stop 零遗留 timer(T6)。
  - 与 §8 已删的「mailbox 到点 fast-path」的区别:那是 retry due 的**时延优化**(活性由 tick 承担,SLA 已按 T_tick 付费);这是相位 deadline 的 **SLA 硬性**(公式没有为每槽 deadline 付 tick 取整的钱)——一删一留各有枚举依据(codex R3-1 明示区分)。

### 5.2 Lead 消费驱动

注册必拉(registerLead/attachRunner 的 commit 返回后由 driver 立即 drain 到空,§4.1-8)+ 周期 pull(leadPullIntervalMs ≤30s → ring())+ 门铃 ring()。对标 v1 lead-inbox-loop 的 1s/30s 现实(research §3)。

### 5.3 Runner deliver 与注入标记(两阶段;codex R2-2)

deliver 执行在 coordinator runner 分支(§4.6);**相变全部走 transitions.ts 的 tx-scoped 基元**:

- **canonical 标记行**(codex R3-5,完整意图,非仅 kind/payload):event_uid='pa:'+attempt_uid+':injected'(**'pa:' 前缀保留给引擎内部**,文档化)、kind='pa.injected'、payload={attempt_uid}、source_kind='v2-engine'、source_id=attempt_uid、cutover_epoch=当前 meta 值;
- `recordInjectedTx(tx, rt, handle)`:`requireActiveConsumerTx`(§4.2a)+ 同事务核对 attempt(`attemptUid` 行 outcome='running' + message/identity 全字段等 handle)→ `INSERT ... ON CONFLICT(event_uid) DO NOTHING`(task_id/attempt_id 置 NULL——marker 不指向 tasks/attempts 行,FK 约束下的显式选择)→ **read-back 全字段核对**:读回该 event_uid 行,kind/payload/source_kind/source_id/cutover_epoch/task_id(NULL)/attempt_id(NULL) 逐字段必须等于 canonical 意图,且 **created_at 有界校验**(codex R4-3):canonical ISO 格式 **且** `attempt.started_at ≤ marker.created_at ≤ txNow`(单次 txNow 快照;单机库内时钟,越界一律拒,不设 skew 宽限)——它是唯一 T_max 锚,预置未来/过去时间戳的同 event_uid 行不得被当幂等成功;任一不符 fail-loud 整事务零残留;attempt 非 running → 拒(**不给 terminal attempt 补标记**);
- deliver 成功后泵调 `Kernel.write("consume.injected", tx => recordInjectedTx(...))`;重复 deliver 幂等(read-back 命中同意图);
- **marker 与 timeout 互斥线性化**(codex R2-2;胜负语义精确化 codex R3-5):`reportDeliveryTimeoutTx(tx, rt, handle)` = `requireActiveConsumerTx`(§4.2a;activation terminal 后账归 disposal,超时路径拒 R4-1)+ **同一事务内**重查 `outcome='running'` **且标记不存在**,同时成立才结算(pa CAS running→failed + settleFailureMailboxTx);**marker 先提交 → timeout 侧 no-op 零 mutation**(转化已开始,交给 T_max 监察);**timeout 先提交 → recordInjectedTx 因 attempt 非 running 抛错拒绝**(泵得知已结算即停)——两个相变同行互斥,先到先赢;败者语义按此非对称合同断言(no-op 断零 mutation,拒绝断 throw),真双连接两向交错入测;
- Lead 路径复用同一 `recordInjectedTx`(start 事务内,§4.3-4),无特例。

### 5.4 两阶段监察(deliver 与 T_max 分离;codex R1-5)

v11 串联语义:attempt 槽 = deliver(≤T_deliver_tot)→ 转化(注入起 ≤T_max)→ 超时换代(≤T_switch)。两个不重叠 deadline,分别锚定两个持久时刻:

- deliver 阶段:锚 = `processing_attempts.started_at`;deadline 由精确调度器到点触发(§5.1),tick 兜底复查:running+无标记+超 T_deliverTot → 走 `reportDeliveryTimeoutTx`(事务内重验,§5.3)——该路径在 driver 侧独立执行,**不依赖 coordinator 状态**(shim 永不 settle 也不失去 T_deliverTot 硬上界,codex R3-1);
- 转化阶段:锚 = 注入标记 event 的 created_at(确定性 event_uid,UNIQUE 索引 O(1));deadline 精确调度+tick 兜底:running+有标记+超 T_max → 触发 `onTMaxExceeded(attempt)`(**level-triggered**:条件持续则每 tick 重发,接收方按 attempt_uid 去重——一次性 callback 丢失不丢活性);
- **崩溃窗口穷举**(真实顺序,codex R2-2;全部入测):①外部注入已发生、deliver Promise 未返回时崩 → 无标记,重启后重投(注入幂等)或 T_deliverTot 超时;②Promise 已返回、标记事务未提交时崩 → 同①(标记缺失=按未注入处理,诚实保守);③标记已提交后崩 → T_max 从标记起算;
- 硬终止+探针确认+register(gen+1) 的真实执行链归批次3 接线;§1.2c 顺序铁律已由 DeathEvidence fail-closed 前置机器化(§4.1)。

## 6. 终局收件人处置(disposal.ts;§1.2b;codex R1-6/R2-3)

`disposeTerminalRecipient(kernel, rt, args): DisposalReport`,args = `{ agent, terminalIdentity: AgentIdentity, owningLead: string | null }`。

**本批处置范围 = runner 收件人**(codex R3-2 收窄):terminalIdentity 必须 kind='runner'(其 terminal 有 activations 行作 durable 证据,enqueue 的 routability 收紧与之同源闭环);Lead 收件人的终局处置需要另一种 durable terminal 证据设计,归批次3(显式边界,不假装覆盖)。

**authority 重验不是一次性前置,而是每个事务的内嵌步骤**(codex R2-3):每一个 attempt 结算事务与每一个 per-message 处置事务,mutation 前**同事务**重验:
1. `consumer_registry:agent` 当前条目**仍恰等 terminalIdentity**——继任已注册 → 本事务拒且整个处置停止,报告 stale(已处置行数如实返回);**registry 为 null 不放行**(处置权证明已丢,拒;codex R2-3);
2. terminalIdentity 为 runner 时:activations 该 activationId 行 `state='terminal'`;
3. redirect 目标 owningLead:当前可路由(registry 有条目)且 ≠ agent。

**先收账后处置**:terminalIdentity 拥有的 running attempt → 逐个单事务精确身份结算(crashed + settleFailureMailboxTx),每事务含上述重验;发现非 terminalIdentity 的 running 行 → 拒(账面未解释)。**处置绝不留 running 尾巴给新 owner 复用**。

**逐消息单事务**(有界批;CAS 绑定 `to_agent=:oldAgent`;每事务重验 authority):
- business / dlq `[落地:dlq 同 business——人工审查队列同样需要活收件人]`:owningLead 可路由 → `FENCE.mailboxCasRedirect`(cas=1)+ event(kind='mailbox.redirected');否则 → `FENCE.mailboxCasDisposalDead` + event;
- notice:`FENCE.mailboxCasDisposalTombstoned` + event。

触发时机(activation terminal 且无继任)由批次3 生命周期接线调用;本单交付操作+交错测试(N16)。**交错验收按真实 Kernel 语义**(codex R3-6:单次 Kernel.write 持 BEGIN IMMEDIATE 写锁,事务中途不可能被第二 writer 插入):(a) successor 在某 per-row 事务开始前提交 → 该事务重验后**零 mutation** + stale 停止;(b) successor 在旧事务持锁期间发起 → 等待/SQLITE_BUSY,旧事务提交后下一 row 事务看到 stale → 停止。总断言 = **successor 提交之后零旧身份 mutation**;边界覆盖 attempt 结算与消息处置之间、两条消息事务之间(双 Kernel 连接,批次1 harness 手法)。

## 7. 公平性参数与 SLA 验收(§1.2e)

- 参数入 EngineConfig(§4.0);构造校验:有限正数 + 设计上限(tTick≤60s / tDeliverTot≤5min / tSwitch≤5min / retryCap≤15min / leadPull≤30s)+ k≥1;MAX_ATTEMPTS=5 常量。
- **SLA 唯一公式**(v11,原样):`S=(q−1)×5+R;A=1+S×(K+1);T(q,R) ≤ T_tick + A×(T_deliver_tot+T_max+T_switch) + (R−1)×(T_due_cap+T_tick)`;默认参数 q=1,R=5 → 585min(诚实数字)。
- **公式成立的前提 = owner-route/ring(codex R4-2,二选一取 a,公式不改)**:结算提交后由 owner 侧**同步 ring** 推进下一槽(同进程直接 ring;跨进程按 §9-6 路由回 owner driver 后 ring)——槽间 handoff **不占** tick 预算,公式里不存在「每槽再等一个 tick」的项。tick 只承担崩溃恢复(进程重启后重建 timer/重新扫描),进程崩溃场景走换代路径由 T_switch 付费,不是常态槽间成本。**T_max 信号的重试同样受 T_switch 预算约束**:从 T_max deadline 起到换代完成(含 level-triggered 重发)≤ T_switch;构造校验 `tTickMs < tSwitchMs`(重发至少有一次机会落在预算内)。
- 验收 = **参数化断言**(EngineRuntime 注入缩小参数,真实驱动全部调度路径,codex R2-7):按公式算期望 deadline,对抗场景断言目标消息在公式值内终态;**ring 是承重件的变异验证**(codex R4-2/Lead 指令 ed63492e-3):把结算后 ring 拿掉 → SLA 断言必须转红(tick 兜底仍保证最终终态=活性,但不再满足公式=SLA);配额边界重启保守恢复与 30min 晋升独立断言;deliver 接近 T_deliverTot 后仍享完整 T_max(两阶段分离);N26/N35 回归。

## 8. 反 over-reaction 检查表(Annie 原则:每机制必答「哪个已枚举场景需要它、根治为何不够」)

| 机制 | 已枚举场景 | 根治为何不够 | 可砍? |
|---|---|---|---|
| INDEXED BY 钉分区 | 1497 QA + 本单 spike 实证的 STAT4 翻盘 | 「不跑 ANALYZE」是脆弱负不变量(PRAGMA optimize 即破) | gate 已批,不砍 |
| 30min 超龄晋升 | N4/N22 founder 洪泛饿死普通消息 | K 配额只保「不连吃>K」,不保积龄优先 | 设计原文机制,不砍 |
| per-recipient 单在途闸 | codex R1-3:泵+循环并发开第二在途,破串行/公平/归因 | pa_one_running 只保 per-message | 不砍(串行消费根基) |
| AttemptHandle 全字段绑定 | codex R2-1:uid#1 迟到结果错结 uid#2 | message+running 解析跨 retry 换行,`pa_one_running` 不保跨时刻同行 | 不砍(exactly-once 账根基) |
| 注入标记 event(两阶段锚) | codex R1-5:deliver 与转化共用 started_at,健康转化被误判卡死 | 无持久注入时刻则 T_max 无法诚实起算;events 事件史正是该用途 | 不砍(两阶段合同兑现) |
| marker/timeout 事务内互斥 | codex R2-2:watcher 读后写,标记与超时双赢 | 读路径观察+另开事务=TOCTOU | 不砍(相变线性化) |
| DeathEvidence 全字段绑定 | codex R1-2:布尔证据错误复用 | 弱证据=fence 被绕入口 | 不砍(fail-closed 根基) |
| 处置逐事务 authority 重验 | codex R2-3:一次性前置被 successor 穿透 | to_agent 谓词非 generation fence | 不砍(stale 处置零容忍) |
| 保守配额恢复 | v9 配额边界重启欠账 | 持久化计数器为省 1 条插队引入持久状态 | 设计选的更简方案 |
| pa 确定性 attempt_uid | crash 后 start 重放双插 | 随机 id 留垃圾行歧义 | 可换随机 id(弱化),默认不砍 |
| 结算自动 event | P 系列病例要证据链 | 口头纪律不可测 | 可砍(损失=审计盲区) |
| admission notice 过载拒 | N7 积压 5000 | retention/告警只暴露不止血 | 可砍(→积压只靠 1501 告警暴露) |
| enqueue canonical 冲突 fail-loud | codex R1-9:digest 不等的「重复」是数据缺陷 | 静默 duplicate 吞双源分歧 | 不砍(fail-loud 哲学) |
| epoch 必填 fail-closed | codex R2-6:省略字段=绕过围栏 | 可选+默认=公开入口升权通道 | 不砍(批次3 切换围栏对接) |
| 相位 deadline 精确调度 | codex R3-1:tick 取整让 T_deliver_tot/T_max 不再是硬上界,v11 公式被超 | tick-only 要么改公式(设计修订)要么失真;精确 timer 便宜(每收件人至多一在途) | 不砍(SLA 硬性;与下行「已删 fast-path」用途不同) |
| enqueue routability 含 activation active | codex R3-2:terminal 收件人死信箱无限进水,disposal 永不收敛 | registry 行存在性不含生死 | 不砍(与 disposal 闭环) |
| **[已删]** 到点 fast-path timer | 无(纯时延优化;tick 已是活性保证,SLA 已按 T_tick 付费) | —— | **本批不实现**(R1-10 自删;与相位 deadline 调度区分见 §5.1) |
| **[已否决留痕]** 语句注册表 allowlist | ——(gate 裁决 a) | 同族再加固非根治:tx.db.prepare 敞口不变,1497 §7.4 已裁 | **不进本 plan** |
| **[已否决留痕]** C5 候选(b) mailbox 投递分支 | ——(枚举不出 paused-hold 消费场景:paused/换代由 activation 生命周期+重投兜底,泵只对 active 会话注入) | 候选(a) 临时连接已覆盖活跃会话投递 | **不采用**(Lead 仲裁预设,本单确认) |

## 9. 跨单协调项(写进两边 plan)

1. **DLQ/dead 告警归属**:本单产 dead 行 + mailbox.dead event;obligation 建行/tier/通知全归 1501(触发源=dead 行可查询真相)。已请 Lead 同步 1501。
2. **垫片接口唯一定义点** = flywheel-v2-engine 导出 InjectionShim(gate 裁决 d);1501 只实现。deliver 载荷含 attemptUid(§4.0 [落地],会话结算凭据)。**C5 已冻结**(§4.0 冻结块六条):四需求 + 连接自清理硬规则 + 重复语义(重复 turn 由消费幂等收敛,不承诺恰一)+ Codex 活跃泵=候选(a);候选(b) 否决入 §8。**1501 侧同步项(经 Lead 转达,codex R9-4)**:1501 plan 须记录候选(a) 定案、删候选(b)、A14 的「恰一 vendor turn」断言与冻结的重复语义对齐(或自带 vendor 级幂等机制)、补零残留连接验收——W4 以此为解 block 条件。
2a. **C4 已签**(Lead 仲裁):runner registry 身份可选 ownerLeadId,**参与 identitiesEqual exact 比较**——fence.ts additive 双形 + identitiesEqual 语义由 1501 实现且为本单注册路径的**硬前置**(§4.1-5,先 land 后 GREEN);kernel 侧双形/多余键拒/空 owner 拒/identitiesEqual mismatch 测试**显式归 1501**(codex R9-2);本单写入落地前 1501 按缺失 fail-safe→'founder'。
3. **探针死亡证据**:DeathEvidence 由 1500 探针/批次3 生命周期产出;本单测试注入。
4. **原子换代组合**:§1.6 全量换代事务由**批次3 生命周期接线**组合(探针证据来自 1500),消费本单 tx-scoped `registerConsumerTx`。
5. **注入标记 retention 约束(批次3)**(codex R2-2):对应 processing_attempt 仍 running 时,其 `pa.injected` 标记 event **不得**被热区归档/删除(或 driver 监察改走冷热统一 reader)——写入批次3 切换/retention 手册的硬前提。
6. **跨进程 proposal 路由合同(批次3)**(codex R3-1):runner 会话跨进程提交 proposal 时,必须路由回拥有该收件人 coordinator 的 EngineDriver 进程执行(结算提交即 ring 推进)——tick 只是崩溃恢复兜底;这是 v11 SLA 公式成立的接线前提,写入批次3 手册。
7. **启动恢复合同(批次3)**(codex R6-2/R7-2):registry 提交后、attach/ring/timer 前崩溃的窗口由启动恢复收口,**Lead/runner 两条路径分叉**——runner:枚举已提交 current registry + active activation → 幂等 attachRunner 重挂(不改 registry);Lead:恢复即一次凭 DeathEvidence 的 registerLead 新 cutover(gen+1,T_switch 付费);写入批次3 手册。

## 10. 导出面收口(index.ts 白名单)

runtime:`ConsumerCoordinator` / `EngineDriver`(含 registerLead/attachRunner 方法)/ `registerConsumerTx` / `initializeEngineDb` / `enqueue` / `submitProposal` / `reportConversionFailure` / `disposeTerminalRecipient` / `selectNext` / `ENGINE_SQL` / `DEFAULT_ENGINE_CONFIG` / `MAX_ATTEMPTS` / `MAX_EFFECTS_PER_PROPOSAL` / `MAX_PROPOSAL_TOTAL_BYTES` / `MAX_FIELD_BYTES`;
type-only:`EngineConfig` / `EngineRuntime` / `EngineClock` / `EngineScheduler` / `CancelTimer` / `AttemptHandle` / `ConversionProposal` / `Effect` / `ConversionResult` / `Converter` / `DeathEvidence` / `InjectionShim` / `DisposalReport` / `IdentityDraft` / `LeadIdentityDraft` / `RunnerIdentityDraft` / `RegisteredConsumer` / `AttemptStart`(T9 type fixture 逐一可导入,codex R5-2/R6-2)。
恰等断言测试同批次1 D15/D16 手法(runtime 集合恰等 + type fixture + deep-import 拒)。**transitions.ts 相变基元(recordInjectedTx/reportDeliveryTimeoutTx/settleFailureMailboxTx)保持包内私有**(codex R3-7:无跨批次消费者——1501 只拥有聚合告警与垫片实现,不该直接动 mailbox retry/dead 或裁决 deliver 超时;settleFailureMailboxTx 自身无 fence,公开=把内部拼装基元伪装成受支持 API;按 §8 原则不导出)。唯一 tx-scoped 公开项 = `registerConsumerTx`(§9-4 批次3 组合确需)。

## 11. 测试清单(验收矩阵映射)

**验收纪律(Lead 指令 ed63492e-3)**:守卫/拒绝/兜底类断言必须**覆盖其声称范围**(枚举矩阵,非单实例);每条此类机制做**变异验证**——把机制拿掉/降级,对应断言必须转红(变异后源码逐字还原,`git diff` 空);做不到变异致红的,在测试注释里如实记「构造保证,无独立致红变异」,不冒充。

| # | 测试文件 | 断言要点 | 对应验收/场景 |
|---|---|---|---|
| T1 | registration.test | 首注册 gen=1;重注册 gen+1;cutover 前后 authority(N18/N25);subject≠agent 拒;runner activation 缺失/terminal/错代拒(R2-5);**registerLead 拒 runner 身份**(R3-4/R5-1);旧条目在而无 evidence 拒;stale evidence 拒(R1-2);null registry+存量 running 行 fail-loud(R2-5);精确身份归因(恰结 deadIdentity/外来 fail-loud/已 applied 只结 attempt N24/重放 exactly-once);第 5 次 crash→dead 且 retry_count=5(N1);registerConsumerTx 组合事务:外层事务任一崩溃点重放后恰一 active activation + 恰一 current registry(R3-4 合同测试);**注册必拉边界走真实公开入口 registerLead/attachRunner**(R4-4/R5-1):commit 前零候选读/零 deliver/零 driver-map 写、commit 返回后用事务返回身份建 coordinator+恰一次 pull+timer 安装、外层回滚零 post-commit 动作、attachRunner 不碰 registry;**attachRunner fail-closed 绑定矩阵**(R6-1/R7-3):stale identity/错 activation/terminal activation/successor 后迟到 attach/**foreign in-flight(attach 事务内查 running owner 三元组)**逐项 → 零 shim 调用+零 timer/map 变化,sessionRef 从 activation 行派生;移除绑定(变异)断言转红;**map 仲裁双向矩阵**(R7-1):(a) 旧 coordinator 在 map + successor 已 cutover + attach 新 identity → 旧被 stop+清 timer、新接管;(b) 新已安装 + 迟到旧 attach → 拒且新不动;同 identity 重复 attach 幂等;stop/清 timer/map 身份/必拉各做变异验证;attach/map mutation 串行化(并发 attach 交错终态由 current registry 决定);**post-commit 崩溃两窗口**(R6-2/R7-2):runner 走 attachRunner 幂等重挂、Lead 走 evidence 新 cutover,各注入崩溃+重放 → 最终恰一 current coordinator、registry 未被 attach 改写、必拉/timer 至少一次且零 stale timer;**C4 矩阵**(R9-2):owner 缺失→legacy 形保写;非空 present→registry 与 RegisteredConsumer.identity 逐字往返;空串→抛且零 mutation;核心字段同而 owner 不同/缺失→exact-identity 拒(DeathEvidence/attach/map 三路)且零归因零 map 变化 | §1.2c/§1.2d |
| T2 | candidates-select.test | selectNext 全分支穷举;R1-4 反例(streak=k+晋升 nf+更老 founder→必选 nf);性质测试:有 ready 普通候选时连续跳过 ≤ k;晋升选中清 streak;保守恢复 streak=k | §1.2e |
| T3 | query-plan-matrix.test(kernel 侧) | §3.3 带统计矩阵四 pinned 候选恒命中/无 TEMP B-TREE/SCAN;pinned vs free 逐行同答;snapshot diff 恰为每条两处插入;阳性对照 free F2 翻盘;DROP `_f` → prepare fail-loud | 台账1/验收② |
| T4 | start-settle.test | start fence 三校验;per-recipient 单在途(running N1+新 F1+交错→恰一 running 恰一次转化,R1-3);resume exact-owner:外来 running 行拒(R2-5);并发 start 被 pa_one_running 拒(真双连接);**迟到绑定回归**:uid#1 超时→uid#2 start→#1 迟到 success/failure 均拒且 #2 不动(R2-1);submitProposal 错配矩阵(错 attemptUid/错 message/旧 activation/错 instance/generation→全拒零残留);成功结算原子+自动 applied event;effect 正反例逐种含「小 payload+巨大 effectKey」事务外拒(R2-8);effect_key 重复整体回滚;失败退避表+第 5 次 retry_count 恰 5(R1-8);late success vs crash 交错仅一方生效(N17);结算在默认 txBudget 内 | §1.2d/§1.2a |
| T5 | consume-loop.test | 100 并发 ring 只一个 drain(N3/N15);全部唤醒源汇入同一 coordinator;resume-first;batch=1 批间重查;lead/runner kind 分支:runner 不触碰 converter、deliver 按退避表节拍(两 tick 间调用数受表约束,无忙等,R2-4);**每次外部 deliver 前过 resume exact-owner+active-consumer 闸**(R6-1:cutover/terminal 提交后重投路径零 shim 调用);**lead/runner 同候选流选择序列等价**+resume/重投不重复计 streak(R3-3);runner 成功 start 恰一次提交 nextStreak(初值 k 下先服务 nf 后 streak 归 0);会话结算后 ring 推进下一条;转化异常≡显式失败;kill 模拟→消息仍 pending 无重复 command | §1.2a/§1.2c |
| T6 | liveness.test | 门铃全丢仅 tick 仍终态(N2);due 无新流量消费(N13);runner hint 全丢仅泵达 applied(N23);两阶段:deliver 持续失败→T_deliverTot 无标记→失败退避,5 次→dead;**marker/timeout 互斥交错**(真双连接两向:marker-first→timeout no-op 零 mutation;timeout-first→recordInjectedTx 抛拒;R2-2/R3-5 非对称合同);**read-back 碰撞矩阵**(R3-5/R4-3):wrong kind/payload/source_kind/source_id/epoch/task_id/attempt_id 逐项 + **时间锚三类**(malformed/早于 started_at/晚于 txNow)逐项 fail-loud 且整事务零残留、terminal attempt 拒补标记;**never-settling shim.deliver**:coordinator 不 wedge、T_deliverTot 仍到点结算(R3-1);deliver 接近 T_deliverTot 成功后仍享完整 T_max(R1-5);**marker 后仍按退避重投直至 mailbox 终态,终态后立即停**(R3-3);标记幂等;崩溃窗口三例(§5.4 顺序);T_max level-triggered+按 attempt 去重且重试 ≤ T_switch;**timer 生命周期**(R4-5):marker 换 timer(cancel deliver/arm T_max)、结算/terminal/stop 清空、stale callback 重验后 no-op、restart 后 tick 重建、stop 零遗留;**activation terminal = 提交时 fence**(R4-1,双连接):terminal 提交先于 start/settle/marker/timeout 各入口 → 全拒零 mutation | §1.2b/§5 |
| T7 | fairness-sla.test | 缩参(经 EngineRuntime 真实驱动)按 §7 公式算 deadline 断言终态(N37);洪泛全程注入上界(N4/N22);30min 晋升;配额边界重启;**owner-route/ring 前提验收**(R4-2):正常路径(ring 在)满足公式;**变异:拿掉结算后 ring → SLA 断言转红**(tick 兜底仍达最终终态=活性不丢);attempt 刚错过 tick 时相位 deadline 调度器仍到点触发(不等下个 tick);T_max 信号重试全程 ≤ T_switch;N26/N35 回归 | §1.2e |
| T8 | enqueue-disposal.test | epoch 必填:缺失拒/不等拒/无种子抛(R2-6);不可路由拒;**runner activation 非 active → 入队拒**(R3-2);canonical 全等→duplicate 恰一行(P3);digest 不等→CanonicalConflict(R1-9);notice 过载拒而 business 不拒;处置:每事务重验矩阵(继任已注册→停+stale 报告/registry null 拒/activation 未 terminal 拒/owningLead=self 拒/不可路由→dead/**terminalIdentity 非 runner 拒**);先收账后处置(零 running 尾巴);**successor 交错按真实 Kernel 语义两分类断言「successor 提交后零旧身份 mutation」**(R2-3/R3-6,双 Kernel 连接,边界=attempt 结算与消息处置间、两消息事务间);**stale-start 反例**(R4-1/R5-3,双连接):terminal 已成立、disposal 完成 running 收账后、首个消息处置事务前,旧 coordinator 触发 startAttempt → active-consumer 闸拒、零新 running 行、disposal 继续完成且无 running 尾巴;把该闸删除/降级(变异)→ 断言转红;**enqueue 与 disposal 逐行事务交错不留永久 pending**(R3-2);business/dlq 改投(绑 oldAgent+due 清零+retry_count 保留)/notice tombstone;逐条单事务 | §1.2c/§0.5/§1.2b |
| T9 | api-surface.test(engine)+ kernel public-api 更新 | engine 导出恰等 §10(**负断言:不存在独立 register 导出**,R6-3);type fixture 含 EngineScheduler/CancelTimer/IdentityDraft/RegisteredConsumer + **跨包 C4 fixture:RunnerIdentityDraft 的 ownerLeadId 与 1501 落地后的 kernel AgentIdentity 形状可组合编译**(R9-2);deep-import 拒;kernel 新导出恰等新集合、FENCE 新五成员谓词逐条正反例、既有四成员逐字未动 | §2/§10 |
| T10 | shim-contract.test | InjectionShim mock:deliver 幂等重复无害(同 handle);shim 抛错→泵退避不崩;无状态(泵重建后继续);**marker 后重投持续、mailbox 终态/activation terminal 后立即停**(R3-3);**C5 冻结面**(R9-4):sentinel vendor-opaque session_ref 逐字节透传且每次重投一致、no-op hint 不影响 durable 进度、结构断言接口恰 hint/deliver 两方法无 ack——vendor 级零残留连接/恰一 turn 归 1501 | §2.4a |

全测试 `PRAGMA foreign_keys=ON`;真双连接/跨进程用批次1 已验 harness 手法;时间与定时**全走注入 clock + scheduler**(EngineRuntime,codex R5-2)。**矩阵分工**(codex R5-3,避免重复描述掩盖缺口):T4 = start/settle 入口级 authority 与绑定矩阵;T6 = terminal 先于五类消费入口的双连接矩阵 + 相位/timer 生命周期;T8 = disposal 期间的交错矩阵(successor 两分类 + **stale-start 插在 running 收账与首个消息处置事务之间**)。

## 12. 实施顺序(Implement 节点,TDD;反例先 RED;依赖顺序修正 codex R2-7)

0. **C4 前置核查**:确认 1501 的 fence.ts 双形+identitiesEqual(含 owner)变更已 land 进本分支基线;未 land → 本单类型/注册路径不得 GREEN(codex R9-1);
1. kernel 侧:候选 SQL 修订 + FENCE 新五成员 + 导出面扩展(RED T3/T9 kernel 部分 → GREEN;批次1 既有测试同步更新);
2. 脚手架 packages/v2-engine + types.ts(EngineRuntime/EngineConfig 构造校验);
3. RED T2(含 R1-4 反例)→ GREEN:selectNext;
4. RED T4 相变与结算核心(含错配矩阵/迟到绑定/单在途/第 5 次计数反例)→ GREEN:transitions.ts + start/settlement——**共享失败相变先于 registration**(registration 依赖 settleFailureMailboxTx);
5. RED T1(含 stale-evidence/subject/activation/null-registry 反例)→ GREEN:registration + bootstrap;
6. RED T5 → GREEN:ConsumerCoordinator(kind 分支);
7. RED T6(含 marker/timeout 互斥反例)→ GREEN:EngineDriver;
8. RED T7 → GREEN:公平性/SLA 场景(缩参);
9. RED T8(含 CanonicalConflict/epoch/处置交错反例)→ GREEN:enqueue/disposal;
10. RED T9/T10 收口:导出面 + shim 合同;
11. 全仓 `pnpm lint` + `pnpm -r build` + 包测试;codex:rescue code review;PR;ship 走 founder gate。

## 13. 不做什么(本单边界)

- 不执行 command/不做探针/不做 saga(FLY-1500);
- 不建 obligation/不做 tier/通知/父抑制子/重启风暴(FLY-1501;dead 行+event 是其触发源);
- 不实现垫片 vendor 适配(1501);不做 Lead 会话回合集成(批次3);
- 不接线生产、不迁移 comm.db、不做 retention/VACUUM/全局过载阈值(批次3;注入标记的 retention 约束已记 §9-5);
- 不做 mailbox retry-due 的精确 fast-path timer(§8 自删;相位 deadline 调度器不属此列,见 §5.1 区分);不加固 kernel 关键字守卫、不做语句注册表(gate 裁决 a)。

## 14. 落地决策记录

| 决策 | 内容 | 依据 |
|---|---|---|
| E1 | 新包 flywheel-v2-engine,kernel 只加不改 | gate 裁决 c |
| E2 | 候选 SQL 修订 = INDEXED BY×4 + created_at;D14 diff 合同(注释保留原文) | gate 裁决 b;spike+spike2;R1-10a |
| E3 | 语句注册表否决留痕;sql.ts 常量为代码纪律 | gate 裁决 a;1497 §7.4 |
| E4 | 垫片接口定义在 engine;deliver 载荷含 attemptUid | gate 裁决 d;R2-1 |
| E5 | 三出口=proposal 惯用组合;normalized effect schema+事务外预检+全字段字节上限 | §2.10;R1-7/R2-8 |
| E6 | attempt_uid 确定性 `uid#n` | 重放幂等;PK+UNIQUE 双保 |
| E7 | 类内择序 (created_at,seq);配额清账池=完整 nf | R1-4 |
| E8 | 转化意外异常≡显式失败 | N1 |
| E9 | 注册与 crash 归因同一事务;DeathEvidence 逐字段 fail-closed;tx-scoped 组合;subject/activation/null-registry 三重校验 | §1.2c 铁律;R1-2/R2-5 |
| E10 | mailbox retry-due 不设精确 fast-path(活性由 tick 承担);相位 deadline 精确调度是例外(E22,SLA 硬性) | R1-10b;R4-5 措辞校正 |
| E11 | admission:notice 过载拒+canonical 冲突 fail-loud+epoch 必填 fail-closed | §0.5;R1-9/R2-6 |
| E12 | DLQ obligation 归 1501,本单只产 dead+event | 单一告警拥有者 |
| E13 | bootstrap = initializeEngineDb 显式 API | R1-9 |
| E14 | AttemptHandle 凭据化结算:handle 发行+事务内全字段重验(attemptUid/message/identity/mailbox 四方绑定) | R1-1/R2-1 |
| E15 | per-recipient 单在途闸 + 唤醒源汇入单 coordinator + kind 显式分叉(runner 无 converter) | R1-3/R2-4 |
| E16 | 两阶段 deadline:deliver 锚 started_at,转化锚注入标记;相变 tx-scoped 且同行互斥(recordInjectedTx read-back / reportDeliveryTimeoutTx 事务内重验);T_max level-triggered | v11;R1-5/R2-2 |
| E17 | 失败 dead 同步 +1(账面恰 5);处置族与失败族 CAS 分离且全绑 to_agent | R1-8/R1-6 |
| E18 | 处置 authority 每事务重验(registry 恰等 terminalIdentity;null 不放行);先收账后处置 | R1-6/R2-3 |
| E19 | MAX_ATTEMPTS=5 常量;时间参数构造校验设计上限(含 leadPull≤30s) | R1-5/R2-7;v10 |
| E20 | EngineRuntime {config,clock,scheduler} 贯穿全部入口与 tx helper,无隐藏默认 | R2-7/R4-5/R5-2 |
| E21 | 注入标记 retention 硬前提记入批次3 手册(§9-5) | R2-2 |
| E22 | 相位 deadline 精确调度(tick 降为崩溃恢复兜底)+ 跨进程 proposal 路由合同(§9-6)+ shim.deliver 有界等待 | R3-1;v11 公式硬性 |
| E23 | enqueue routability 含 runner activation active;disposal 本批收窄为 runner 收件人(Lead 终局证据设计归批次3) | R3-2 |
| E24 | marker 后持续重投直至 mailbox 终态/activation terminal(回归权威 v8 原文;marker 只锚 T_max/结束 deliver deadline);runner streak 在成功 start 恰一次提交 | R3-3 |
| E25 | runner 的 registry cutover 只经组合事务调 registerConsumerTx;driver 侧仅 attach(**被 E32 supersede 的旧表述「register() 仅 lead」作废**——独立 register() 不存在) | R3-4/R6-3;§1.6 原子换代 |
| E26 | 标记 canonical 全字段 read-back(含 source/epoch/created_at 合法性);'pa:' event_uid 前缀保留;败者语义非对称(no-op vs 抛拒)按实断言 | R3-5 |
| E27 | successor 交错验收按真实 Kernel 写锁语义两分类;transitions 基元包内私有(唯一 tx-scoped 公开=registerConsumerTx) | R3-6/R3-7 |
| E28 | requireActiveConsumerTx 统一 authority 闸:activation terminal = 全部消费写路径的提交时 fence | R4-1 |
| E29 | owner-route/ring = SLA 前提(公式不改;槽间 handoff 不占 tick;ring 变异致红;T_max 重试受 T_switch 约束;tTick<tSwitch) | R4-2 选项 a |
| E30 | marker created_at 有界校验(started_at ≤ 锚 ≤ txNow,无 skew 宽限)+ task_id/attempt_id NULL 入 canonical | R4-3 |
| E31 | 注册必拉边界:tx helper 零副作用,pull/timer 安装在最外层 commit 返回后由 owner driver 执行;EngineScheduler 注入 + timer registry 生命周期(cancel/清空/重验/重建) | R4-4/R4-5 |
| E32 | 公开注册入口 = EngineDriver.registerLead / attachRunner(签名闭环;不设全局 singleton;独立 register() 删除);scheduler 返回 CancelTimer 取消闭包(不暴露平台 handle) | R5-1/R5-2 |
| E33 | attachRunner fail-closed 绑定(registry 恰等/activation active+generation/running owner 三元组/sessionRef 从 activation 行派生);runner 每次外部 deliver 前过 resume exact-owner 闸 | R6-1/R7-3 |
| E34 | registerConsumerTx 返回最终 canonical 身份(IdentityDraft 入/RegisteredConsumer 出);registerLead 顺序钉死(commit 前零 map 写);「恰一次」限无崩溃单次调用,崩溃窗口归批次3 启动恢复合同(§9-7) | R6-2 |
| E35 | coordinator map 仲裁以 durable current identity 为唯一裁判(successor 必须能接管:stop 旧+清 timer+原子替换;迟到旧 attach 拒);同 agent attach 串行化;启动恢复 Lead/runner 分叉(Lead=evidence 新 cutover,runner=attachRunner 重挂) | R7-1/R7-2 |
| E36 | C4 折入:RunnerIdentityDraft 可选 ownerLeadId,registerConsumerTx 传写;**1501 kernel 交付物(双形+identitiesEqual 含 owner)为硬前置,先 land 后本单 GREEN**;owner 参与 exact 比较无例外;C5 冻结六条:四需求+连接自清理+重复语义,Codex 活跃泵=候选(a),候选(b) 否决入 §8;1501 侧同步项经 Lead 转达 | Lead 仲裁 dd24d1b3;codex R9 全采纳 |
