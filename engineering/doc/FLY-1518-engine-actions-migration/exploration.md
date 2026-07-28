# FLY-1518 迁移 v2-engine 到 actions + 删退役表 — 探索

Issue: FLY-1518 (https://linear.app/geoforge3d/issue/FLY-1518/v2上线前置-迁移-v2-engine-到-actions-丢弃-commandsobligationscommand)
日期: 2026-07-28
基于: 无

## 1. 一句话理解

FLY-1499 引擎按旧文档(R13 commands outbox)实现了外发路径,FLY-1500 按凌晨修正案交付了 actions 黑匣子;本单把引擎外发路径迁到 actions 语义、删掉三张退役表(commands / command_dependencies / obligations),并把 design-FINAL-v2.md 更新为含修正案的真终稿——消灭"设计散在对话里"的缝。时机:v2 尚未接线,commands 无生产数据,改代码 + 删空表最便宜;本单合完 → 统一重启 → v2 终态上线。

## 2. 审计事实(codebase ground truth,2026-07-28,分支基线 9455a2b8)

### 2.1 引擎侧(FLY-1499 已合,PR #718)

commands 的**唯一生产写入点**是转化结算事务:

- packages/v2-engine/src/sql.ts:59 — insertCommand(INSERT INTO commands,state='pending')
- packages/v2-engine/src/settlement.ts:89 — writeEffect 的 command 分支(submitProposal 在 consume.settle.success 事务内逐条写 effect + mailbox applied CAS + processing_attempt succeeded CAS)
- packages/v2-engine/src/types.ts:103 — Effect 联合类型的 command 变体 {commandKind, payload(string), effectKey, taskId?, attemptId?}

没有任何代码**读** commands(无候选扫描、无 claim、无 dispatcher)——FLY-1500 修正案把 dispatcher 整包删了,引擎写下的 pending command 在现仓库里**永远无人消费**。这正是"outbox 没有发件员"的断头路径,也是本单要治的缝本体。

测试面:settlement-v2.test.ts(FK 失败回滚断言查 commands 行数)、poll-loop-v2.test.ts(重复 effectKey 撞 commands.effect_key UNIQUE 的报错断言)。其余引擎测试(qa-fly1499 等)不触 commands。

### 2.2 kernel 侧(FLY-1497 + FLY-1500 已合)

- 0001-base-schema.ts 建 commands(8 态 claim 生命周期)、command_dependencies(notify_before + 禁环触发器)、obligations(病历卡);0002-obligations-rebuild.ts 重建 obligations,并在 **tasks/attempts 上挂了两个 tombstone 触发器**(obligations_tombstone_task_terminal / obligations_tombstone_attempt_terminal)——它们不随 DROP TABLE obligations 消失,必须显式 DROP。
- 0006-actions-black-box.ts(FLY-1500)只建 actions 及其索引/触发器;迁移链现到 0007-scheduler-runtime(FLY-1501)。**0008 是本单的空位**。
- kernel 公开动词:recordActionIntent / recordActionOutcome / readAction / listActions(actions.ts);薄壳 runRecordedAction 住独立包 packages/v2-actions(intent → 事务外 perform → outcome,replay 短路)。
- migrator:checksum 台账,0001/0002 逐字不改;fkMode 有 on / rebuild(rebuild = FK OFF + 事后 foreign_key_check)两种。

### 2.3 引用面全图(DROP 爆炸半径)

生产代码引用旧三表的**只有** v2-engine 的 sql.ts/settlement.ts。其余引用全在迁移文件与测试:

| 位置 | 引用 | 处置方向 |
|---|---|---|
| v2-kernel migrations 0001/0002 | 建表 DDL | checksum 锁定,逐字不动;由 0008 前向删除 |
| v2-kernel schema-contract.test.ts | 触发器清单含 obligations/command_dependencies 族;commands/command_dependencies 行为测试 | 随 0008 更新期望集 |
| v2-kernel migrator.test.ts / migrator-failure.test.ts / obligations-migration.test.ts | 表清单断言;0002 中途失败回滚;obligations 行为 | migrator 期望集更新;0002 回滚测试保留(历史迁移仍在链上);obligations 行为测试改为"迁移历史行为"定位或随表退役 |
| v2-engine settlement-v2/poll-loop-v2 测试 | command effect 断言 | 迁到 actions 语义断言 |
| kernel.ts / fence.ts / backup.ts / candidates.ts / v2-scheduler / teamlead / flywheel-comm | 零引用(已 grep 证实;teamlead 的 terminal-receipt-settlement 是 v1 comm.db 域,同名不同物) | 不碰 |

### 2.4 权威裁定链(设计从哪来)

1. founder 终稿 /tmp/v2arch/v2-final-design.html(sha256 e0078266d1bb…,托管 https://fw-reports-a53de2.vercel.app/r/c80de4dfa7a2bd33aa6f0d44824634d4/);四个 🔴 裁决台全部采纳:actions 黑匣子、心跳列+自动重启、世代号保险丝、ship 门形状——固化摘录在 engineering/doc/FLY-1498-gate-dispatch-model/v2-final-approved-extract.md。
2. FLY-1500 mapping-v2final.md:actions 单表形状、两笔事务、invocationUid 纪律、supersede 链;§0.2 = 裁决 A 原始记录,明文把"engine→actions + 删三表 + 旧 observation 列退役"交给 FLY-1518。
3. FLY-1499 mapping-v2final.md:**通篇没有 command 一词**——引擎的 command 外发是按旧 R13 文档实现的,修正案未传导到 1499,这正是 founder 复盘指出的根因。
4. doc/engineer/plan/v2/design-FINAL-v2.md 现状 = R13 + FLY-1498 并稿版:§T 仍写"commands 仅保留内部 outbox claim"、§1.0 十七表含 commands/command_dependencies/obligations、§1.5 仍有 ActionReconciler/prepared→executing 态、§2.9 notify-then-do、§3 告警仍走 notification command + dispatcher claim。**这些与已合入 main 的实际形态(0006 actions 三态、无 dispatcher、无 reconciler)冲突**,是本单文档交付要消灭的。

### 2.5 并行单协调(FLY-1520)

FLY-1520(DAG 派发引擎)施工纪律明文:"不动 FLY-1518 正在改的 v2-engine 文件、不加新迁移"。→ 0008 编号归本单独占,attempts/tasks 运行时归 1520 消费但它不改 schema,无冲突面。

## 3. commands vs actions 语义差异(迁移要对齐的合同)

| 维度 | commands(旧 outbox) | actions(黑匣子) |
|---|---|---|
| 状态机 | pending→claimed→accepted→executing→succeeded\|failed(+rejected/canceled),8 态 | intended→succeeded\|failed,3 态,无认领无执行态 |
| 执行者 | dispatcher 按 kind 认领执行 | **Agent 亲手**调工具,薄壳前后记账;黑匣子不认领、不执行、不重试、不探测、不补偿 |
| actor 身份 | 不记 actor,只记提案者 generation | actor_kind/agent_id/instance_id/generation 必填 + 触发器校验 agents 当前世代;runner 必须带 activation_id **且**必须绑 task/attempt(schema CHECK) |
| 幂等键 | 调用方裸给 effect_key(≤256B 字符串) | 调用方给 logicalEffectId + invocationUid,kernel 派生 logical_key/effect_key(sha256);invocationUid 必须来自 durable 来源,崩溃重入必须复用 |
| payload | TEXT 任意字符串 | canonical JSON(json_valid CHECK + 排序键 canonicalize) |
| 重放 | INSERT 撞 UNIQUE 直接炸(引擎现状) | 同 effect_key + 同 envelope 返回 replayed,绝不再执行;不同 envelope 响亮失败 |
| 恢复 | dispatcher reconcile + 探针 | 无自动恢复;intended 停留 = 诚实"未知",Agent 读黑匣子 + 外部现实,显式 supersede(带证据)才重做 |
| 依赖 | command_dependencies notify_before + requires | 无;通知纪律归 Agent 判断 |

## 4. 关键设计决策(D1-D4)

### D1(核心):引擎外发迁到 actions 的形态 —— 两个候选

**方案 A(settle 事务内记 intent,保留"outbox 形")**:Effect 的 command 变体改成 action 变体,submitProposal 在结算事务内 recordActionIntent(intent 与 mailbox applied 同事务原子),commit 后由同一 agent 亲手 perform + recordActionOutcome。
- 优点:字面上最像旧 outbox("转化事务只写 intent"),结算原子性直观。
- 缺点:commit 后的 perform 需要引擎新增一个"取回 intended → 执行 → 记 outcome"的驱动面——**这就是换皮 dispatcher**,与修正案"黑匣子不执行、不提供执行者注册"直接顶牛;且 agent 崩在 commit 后,消息已 applied 不再投递,intended 行没有任何唤醒者,恢复语义比 B 更差。

**方案 B(转化期 Agent 亲手做,proposal 收窄为 task/event)——推荐**:外部效果在**转化期间**(= agent 的回合)由转化方经 runRecordedAction 亲手做,intent→perform→outcome 全部发生在结算之前;ConversionProposal 删掉 command 变体,只剩 task/event 两种库内产出;结算事务原子性(产出 + mailbox applied + attempt succeeded 同事务)一字不动。
- 与修正案逐字对齐:"Agent 亲手调用工具,工具薄壳在动作前后自动写 actions";引擎里不存在任何执行/认领/扫描面。
- 防重的锚:invocationUid 用 **messageUid 派生**(如 messageUid:ordinal),跨 processing attempt 稳定——转化第 1 次尝试做了效果后崩,消息仍 pending 被重投,第 2 次尝试的同一工具调用派生同一 effect_key → replay 短路,**效果恰一次**。attemptUid(m1#1/m1#2)不可入键,否则跨尝试变键 = 双发。
- 防丢的锚:效果发生在结算前——没做完效果就不会提交 proposal,消息不销账就会重投;旧模型靠"outbox 行不丢"防丢,新模型靠"消息不销账"防丢,两者等价且新模型少一张表。
- 诚实窗口(与 mapping §5 崩溃三态一致,QA 要证的等价形):intent 已记、效果未做、进程崩 → 重投后 replay 返回 replayed+intended = "结果未知",转化方**不得**当成功,由 Agent 判断(读外部现实,显式 supersede 或失败重试)。这是修正案的既定语义,不是本单发明。
- 引擎交付面:类型收窄 + 结算删 command 分支 + 一个**零 kind 知识**的辅助接缝(把 handle → ActionActor 映射、runner 的 task/attempt 绑定解析、messageUid 派生 invocationUid 的纪律代码化),供转化层以正确姿势调 v2-actions;不提供 executor、不提供 kind 表。

倾向 B。A 的"outbox 形"保守但复活了修正案明杀的执行者角色。

### D2:attempts 的 observed_state/observation_kind/observed_at 列

- 1500 mapping §0.2/§3 说这些列随 FLY-1518 一并退役;但 issue 范围(founder/Lead 2026-07-28 写)只列三张表。
- 现状:列只被引擎测试 fixture 写入(helpers.ts:109、config-registration-enqueue-v2.test.ts:220),observed_state 有 DEFAULT 'unknown',生产零读者;删列 = attempts 全表 rebuild 迁移,而 attempts 是 FLY-1520(DAG 引擎)正在消费的运行时域。
- **推荐:本单不动列**(issue 文本为准),测试 fixture 顺手去掉显式写入;列的正式退役并入 1520 之后的 attempts 重建单(design-FINAL §1.1 的 tasks/attempts 重建域)。在 gate 里向 Lead 明示这是对 mapping 的有记录偏离。

### D3:0008 迁移形状

```sql
-- 0008-drop-retired-command-obligation-tables
DROP TRIGGER obligations_tombstone_task_terminal;   -- 挂在 tasks 上,不随表消失
DROP TRIGGER obligations_tombstone_attempt_terminal; -- 挂在 attempts 上,同上
DROP TABLE command_dependencies;  -- 先删子表(FK → commands)
DROP TABLE commands;
DROP TABLE obligations;           -- 其余触发器/索引挂在自身,随表消失
```

- fkMode 用 **rebuild**(FK OFF + foreign_key_check):obligations 有自引用 FK(parent_obligation_id),FK ON 时 DROP 的隐式 DELETE 行序不保证,防御带数据的库(QA/历史库)时的瞬时违反;与 0002/0005/0006 同款纪律。
- 0001/0002 checksum 逐字不动;全链 0001..0008 fresh 联测 + 带旧表数据的升级路径测试(老库有 commands/obligations 行也能干净删除)。
- 顺带清理:kernel schema-contract/migrator 测试期望集、`_agents_cutover_guard` 无涉、backup 合同无表清单(已核,backupDatabase 不列表名)。

### D4:design-FINAL-v2.md 并稿为真终稿

- 单写者:本单(founder 直令 2026-07-28;1500 mapping §0.1 当时归 1498 的安排已被时间线取代)。
- 改法:在原文件上并稿,不另起新文件;头注追加"+ 凌晨修正案(actions 黑匣子)并稿版"与裁定来源(v2-final-design.html sha256 + 1498 extract + 1499/1500 mapping);逐节修:§T(删 commands outbox claim 词条,改 actions 三态)、§1.0(表清单改为 0001..0008 实际形态:去三表,列 agents/config/scheduler 族,= 20 张)、§1.1(commands/command_dependencies 两条删除,actions 条目对齐 0006 真形:intended|succeeded|failed、supersede 链、无 policy snapshot)、§1.2e(外发=outbox 改写为 Agent 亲手 + invocationUid 纪律)、§1.4/§1.5(删 ActionReconciler/prepared→executing/有界再武装,对齐 1498 批准形:ship 三条通用前置、活 agent 亲手 merge)、§2.9(notify-then-do 的 commands 面删除)、§2.11-2.12(dispatcher 措辞对齐"看库拉进程"四循环)、§3(告警从 notification command/obligation 改为 1501 已交付的形态)、§5/§6(病例矩阵中 commands.result_code/bypass 审计等引用同步)。
- 老 plan 挂 superseded 横幅(见 advisory)。

## 5. 并入本单的 1500 rebase 轮 advisories(处置初判)

| advisory | 初判 |
|---|---|
| restore retained command/obligation 测试覆盖 | 表既删,"保留态覆盖"以 0008 迁移测试替代:fresh 全链 + 带旧数据升级 + 删后 schema 断言(表/触发器/索引均不存在) |
| authorization digest replay 语义 | recordActionIntent 的 exact envelope(mapping §4)不含 authorization → 同 effect_key、不同 authorization 的重入会被静默 replay,新授权引用被丢。定义并测死:replay 命中时 authorization 不比对但**不覆写**,快照返回旧行(黑匣子=事实,不追改);文档写明"授权变化 = 新 logicalEffectId 新 root",实现层加防护性断言或注释,plan 里定死 |
| 拒绝重用 predecessor invocationUid 的 supersede | 带 supersedesActionId 的 spec 若派生出的 effect_key 命中**任何既有行**(尤其 predecessor 自己),必须响亮失败而非走 replay 分支——replay 分支现在会静默丢弃 supersede/retry_basis(envelope 不含它们)。kernel recordActionIntent 加一条谓词 + 测试 |
| result serialization 失败的诚实 terminalization | runRecordedAction 里 perform 成功但 result canonicalize 抛错 → 现状是 outcome 写不进去、action 永停 intended、异常上抛,效果已发生却记"未知"。改为:序列化失败时以 canonical 错误壳(如 {serialization_error, value_type})terminalize succeeded,并附测试;绝不因记账格式让真效果失账 |
| LOW: schema markers | 0008 DDL 注释标注三表退役出处(修正案+本单) |
| LOW: capabilityConsume 注释 | fence.ts 保留的 capability consume CAS 注释指向 FLY-1498 已合形态,修正过时指向 |
| LOW: createdAt 校验 | recordActionIntent/Outcome 的 createdAt/completedAt 接受任意字符串 → 加 canonical ISO 校验(引擎 transitions.ts 已有 isCanonicalIso 先例) |
| LOW: canonicalizer exotic shapes | R1 已拒非平凡原型/symbol/undefined;补 toJSON 携带者、Number 包装对象等边角的显式测试,不改行为除非测出洞 |
| LOW: retention ownership | actions 无 retention(0006 no_delete 触发器);design-FINAL 终稿写明归批次3 另审,本单不建 timer |
| LOW: superseded plan banner | FLY-1500 旧 plan.md(dispatcher 版)顶部加 superseded 横幅指向 mapping-v2final.md;FLY-1499 mapping 不需要(无冲突) |

## 6. 范围外(明确不做)

- 不实现 DAG 派发/节点合同/ship 执行器(FLY-1520);不做切换(FLY-1502);不删 v1 告警族(FLY-1503)。
- 不给 actions 加 retention/archiver/探针/自动重试——修正案明杀,不复活。
- 不动 0001/0002 已登记 checksum 的一个字节。
- 不动 tasks 表形状(lineage_root_id 等,1520 域);engine insertTask 保持现状。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 方案 B 的"replayed+intended = 未知"语义,转化方处理不当会把未知当成功 | 引擎接缝的返回类型强制区分 performed/replayed;测试锁死 replayed+intended 不推进下游 |
| runner actor 动作必须绑 task/attempt(schema CHECK),转化上下文若无 DAG 绑定则 runner 无法记账 | 引擎接缝从 activationId 解析 attempt 绑定(activations→attempts);无绑定 = fail closed,与 0006 触发器一致;lead actor 无此约束 |
| 0008 在带数据库上的 FK 行为 | fkMode rebuild + foreign_key_check + 带数据升级测试 |
| 与 1520 抢 0008 编号 | 1520 施工纪律明文不加迁移;gate 里再向 Lead 确认一次 |
| design-FINAL 大改误伤 1520 正要实现的 §1.5/§1.7/§2.12 | 逐节改动对照 1498 v2-final-approved-extract.md,只删 commands/reconciler 族,不碰 DAG/节点合同/ship 三条的批准语义;改完请 1520 侧可见(评审链留档) |
