# FLY-1518 迁移 v2-engine 到 actions + 删退役表 — 调研

Issue: FLY-1518 (https://linear.app/geoforge3d/issue/FLY-1518/v2上线前置-迁移-v2-engine-到-actions-丢弃-commandsobligationscommand)
日期: 2026-07-28
基于: exploration.md(brainstorm gate 已过:D1=方案B、D2=不动列、D3=批准,Lead 补充三条要求见 mapping-v2final.md §3)

## 1. actions API 机械细节(实现要对齐的既有合同,零改动区默认)

### 1.1 recordActionIntent(packages/v2-kernel/src/actions.ts:323)

- 键派生(actions.ts:368-384,机械、调用方不可拼 raw key):
  - logical_key = sha256(canonical({attemptGeneration, attemptId, cutoverEpoch, kind, logicalEffectId, taskId, unboundActorAgentId: taskId===null ? actorAgentId : null}))
  - effect_key = sha256(canonical({invocationUid, logicalKey}))
- replay(actions.ts:385-399):effect_key 命中既有行 → exact envelope 比对(kind + payload_digest + task_id + attempt_id + attempt_generation + logical_key + cutover_epoch)→ 相等返回 {outcome:"replayed"},不等抛 collision。**envelope 不含 supersedesActionId/retryBasis/authorization**(Codex R1-M3 修正后的形态)——这正是两条 advisory(authorization replay、supersede 重用 predecessor uid)的机理入口。
- options.prepare(tx) 在 INSERT 前、同事务运行(capability consume 等原子组合点)。
- spec.createdAt 缺省 new Date().toISOString(),**无 canonical ISO 校验**(advisory LOW-createdAt 的落点;引擎侧有先例 transitions.ts:61 isCanonicalIso)。

### 1.2 recordActionOutcome(actions.ts:447)

单条 CAS:WHERE id=@id AND state='intended' AND 全 actor token(kind/agent_id/instance_id/generation/activation_id IS)AND EXISTS agents 当前世代行。0 行 = CasViolation(kernel tx.cas 语义)。result 必经 canonicalize——**canonicalize 抛错发生在 CAS 之前**,效果已发生但 outcome 永远写不进去(advisory result-serialization 的机理)。

### 1.3 schema 硬约束链(0006,对引擎接缝的直接影响)

runner actor ⇒ activation_id NOT NULL(CHECK actor_kind='lead' OR activation_id IS NOT NULL)⇒ task_id+attempt_id+attempt_generation 全非空(CHECK 绑定三元组)⇒ 触发器 actions_lineage_insert 要求 attempts(id=attempt_id, generation=attempt_generation, task_id=task_id)与 activations(id=activation_id, attempt_id, generation=attempt_generation)真实存在。
→ **runner 发起的 action 必须解析出它的 DAG 绑定**;lead actor 三元组可全空(unbound,logical_key 加 actorAgentId 命名空间)。

### 1.4 runRecordedAction(packages/v2-actions/src/index.ts:28)

事务A recordActionIntent → replayed 则短路返回(**不 perform**)→ 事务外 perform → 事务B recordActionOutcome(succeeded);perform 抛错 → 尽力写 failed 后原样 rethrow。返回 {disposition:"performed"|"replayed", action}。调用方合同:只有 performed 才算做了;replayed+intended=未知,replayed+failed=上次失败观察。

## 2. 引擎接缝(方案 B)的调研输入

### 2.1 身份映射(零翻译成本)

engine RegisteredAgent(types.ts:76)与 kernel ActionActor(actions.ts:10)字段一一对应:lead{agentId,instanceId,generation} / runner{+activationId}。接缝只做形状搬运,不造新身份。

### 2.2 runner DAG 绑定解析

活 activation 行自带绑定:activations(id, attempt_id, generation);attempts(id → task_id)。解析 SQL(kernel.read 只读):

```sql
SELECT a.attempt_id, a.generation, at.task_id
  FROM activations a JOIN attempts at ON at.id = a.attempt_id
 WHERE a.id = @activationId
```

解析后放进 RecordActionIntentSpec 的 taskId/attemptId/attemptGeneration。解析与 intent 事务之间的竞态(换代/终态化)由 0006 lineage/current-actor 触发器在 intent 事务内兜底 fail-closed——接缝不加第二套校验,不复制触发器逻辑。解析不到行 = fail closed(FenceViolation),与"runner 无绑定不得记账"的 schema 语义一致。

### 2.3 invocationUid 纪律(Lead gate 补充要求的落法)

mapping(FLY-1500)允许的 durable 来源之一 = "已落库 proposal/event id"。mailbox 行是 durable、messageUid 跨 processing attempt 稳定(m1#1/m1#2 共享同一 message_uid)。**per-action 分量必须进 uid**(Lead 裁定:同一消息多个外发动作不得共享 uid,否则第二个动作撞第一个的 replay 短路):

```
invocationUid = messageUid + "::" + logicalEffectId [ + "::" + qualifier ]
```

> 2026-07-28 更正(Codex design review R1-4):上式非单射("::"拼接可碰撞),定稿为
> JSON 数组编码 JSON.stringify(["conversion", messageUid, logicalEffectId,
> qualifier ?? null]);qualifier 语义收紧为"仅同一 logical root 的显式重做,必须与
> supersede 成对"。以 plan.md §1.1 为准。

- 用 logicalEffectId 而非序号作默认分量:转化重跑时调用顺序可能变(分支/重试),序号会漂;logicalEffectId 是业务身份,重跑天然稳定。
- 同一消息内同一 logicalEffectId 调两次 = 同一逻辑效果 = replay(正确语义);确需两次独立执行的罕见形态用显式 qualifier 区分,由调用方保证 qualifier 的 durable 稳定性。
- 必测(Lead 点名):一条消息两个动作(不同 logicalEffectId),跨重投递各自恰一次。

### 2.4 转化流程的时序(方案 B 定稿形)

```
poll → available(handle) → 转化期间: 每个外发动作 = 接缝(runRecordedAction:
  intent(A) → 外部效果 → outcome(B))
→ 转化完成: submitProposal({task/event effects}) = 结算事务(产出+applied+succeeded 原子)
失败路径: reportConversionFailure 不变(退避/dead 语义零改动)
```

崩溃窗口对照(QA 等价证明的骨架):

| 崩溃点 | 旧 commands 模型 | 新 actions 模型 | 等价性 |
|---|---|---|---|
| 效果前 | 消息 pending 重投,outbox 未写 | 消息 pending 重投,intent 可能已记(intended) | 重投后:旧=重写 outbox;新=replay 返回 intended=未知,Agent 判断。新模型不自动重做,是修正案既定语义(诚实窗) |
| 效果后、结算前 | outbox 行在,dispatcher 会发 → 结算重放靠 attempt CAS | 效果已做+outcome 已记;重投后 replay 短路不重做 → 结算 | 均恰一次;新模型少一跳 |
| 结算后 | 消息 applied;dispatcher 异步发 | 消息 applied;效果早已完成 | 新模型无"结算后未发"窗口(旧模型该窗口靠 dispatcher 活性,修正案已删) |

### 2.5 结算路径的收窄

- types.ts Effect 联合:删 command 变体;task/event 保持字节不动(tasks 是 1520 域)。
- settlement.ts:validateProposal 删 command 分支(effectKey/commandKind 校验随删);writeEffect 删 command 分支;insertCommand 从 sql.ts 删除。结算事务其余(mailbox.applied 事件、applied CAS、attempt CAS)零改动。
- MAX_EFFECTS_PER_PROPOSAL 等常量不动。

## 3. 迁移 0008 机械细节

### 3.1 DDL 草案(plan 定稿,此处记调研结论)

顺序:①弃行数持久回执 → ②DROP 挂在 tasks/attempts 上的两个 tombstone 触发器 → ③子表先删(command_dependencies → commands → obligations)。

弃行数"不静默"(Lead D3 要求)的落法:migrator 是纯 DDL 字符串 + checksum 台账,无日志钩子;改 migrator 加钩子 = 碰已验证机械。**用库内持久回执替代 stdout 打印**:0008 DDL 里先 INSERT 一行 events(append-only、备份合同内),event_uid 确定性 = 0008 固定字符串,payload = json_object 三表行数;fresh 链回执为全零(诚实),带数据升级回执 = 实际弃数。测试断言回执行存在且计数正确。events.cutover_epoch NOT NULL:迁移期 meta 可能还没 cutover_epoch(引擎 bootstrap 在迁移后),用 COALESCE((SELECT value FROM meta WHERE key='cutover_epoch'),'0') CAST 兜底。

### 3.2 fkMode 选择

rebuild(FK OFF + foreign_key_check + 事务回滚保护):obligations 自引用 parent_obligation_id,FK ON 下 DROP TABLE 的隐式 DELETE 行序不保证,带数据库(depth=1 子行)可能瞬时违反;rebuild 模式与 0002/0005/0006 同款,migrator-failure.test 已证其回滚正确性。

### 3.3 测试期望集清点(逐文件)

| 文件 | 现状 | 改法 |
|---|---|---|
| v2-kernel migrator.test.ts:9-32 | EXPECTED_TABLES 23 张含三退役表;EXPECTED_NAMED_INDEXES 含 obligations_episode_open | 表清单 -3(=20);索引 -1;applied 列表加 0008;幂等重跑断言自动覆盖 0008 |
| v2-kernel schema-contract.test.ts:50-57,110-130 | 触发器清单含 obligations 五族 + command_dependencies 两族;commands/command_dependencies 行为测试 | 触发器清单剔除;行为测试删除(表已不在);新增 0008 后"表/触发器/索引不存在"断言 |
| v2-kernel obligations-migration.test.ts | 0002 行为测试(insertFinalObligation 等) | 重新定位为"历史迁移 0001..0002 子链"测试(0002 仍在链上,历史正确性仍须锁);在子链上跑,不上全链 |
| v2-kernel migrator-failure.test.ts | 0002 中途失败回滚 | 保留(子链语义);可加 0008 失败回滚同款用例 |
| v2-engine settlement-v2.test.ts:82-122 | command FK 失败证结算原子回滚 | 换 task effect 的 FK 失败源(lineageRootTaskId 指向不存在 task → tasks.lineage_root_id FK 违反),原子回滚断言不变——**回滚测试的证明力保持,只换失败注入器** |
| v2-engine poll-loop-v2.test.ts:134-161 | 重复 effectKey 撞 commands UNIQUE 证"异步结算错误浮到下次 poll" | 错误浮出机制用别的结算错误保留(同上 FK 注入);effect 幂等语义的测试整体迁到接缝层(replay 短路) |
| v2-engine helpers.ts:109 / config-registration-enqueue-v2.test.ts:220 | fixture 显式写 observed_state='present' | 去掉显式列(有 DEFAULT),D2 配套 |

### 3.4 grep-zero 收尾面

FLY-205 教训(多形态 sweep):删除后全仓 grep 检查 commands/obligations/command_dependencies 的**表名引用形态**(FROM/INTO/UPDATE/TABLE/json 引用),排除:迁移历史文件(0001/0002 逐字保留)、历史文档(doc/ 归档评审链)、v1 域同名(teamlead 的 terminal-receipt-settlement 等 comm.db 物,与 flywheel-v2.db 无关)。范围收在 packages/v2-* 的非迁移源码 = 必须零。

## 4. design-FINAL-v2.md 并稿清点(逐节改动面)

以 FLY-1498 v2-final-approved-extract.md(四 🔴 裁定固化)+ FLY-1500 mapping §4/§5 为裁定来源:

| 节 | 现状(R13+1498 并稿版) | 终稿改法 |
|---|---|---|
| 头注 | R13 + FLY-1498 复审版 | 追加凌晨修正案并稿说明 + 裁定来源三址(v2-final-design.html sha256 / 1498 extract / 1500 mapping)+ 本单落地记录 |
| §T | "commands 仅保留内部 outbox claim"、注入垫片等 | claim 词条改"已全删";commands 词条删除;actions 词条对齐三态黑匣子;补 invocationUid/logicalEffectId 术语 |
| §1.0 | 17 表含 commands/command_dependencies/obligations,meta 含 consumer_registry | 表清单改 0001..0008 实际形态 20 张(+agents/config/scheduler 三件套,-三退役表);注明 consumer_registry 已由 agents 表替代(0005) |
| §1.1 | commands 6+2 态、command_dependencies notify_before、actions prepared/executing 态+policy snapshot | 前两条删除;actions 条目重写对齐 0006 真形(intended/succeeded/failed、supersede 链、replay、无 snapshot);attempts 条目加"observed_state 等三列过渡保留,退役归 post-launch attempts 重建"(D2 偏离记录) |
| §1.2e | 外发=outbox,处理完成=回复 command 已入 outbox | 重写:外发=Agent 转化期间亲手 runRecordedAction;处理完成=转化产出(task/event)已提交;防丢=消息不销账必重投,防重=durable invocationUid;诚实窗=intended 停留 |
| §1.4/§1.5 | ActionReconciler、prepared→executing CAS、有界再武装、5min reconcile/6 attempts 退避表 | Reconciler/自动 retry 族全删(修正案明杀);ship 语义对齐 1498 extract:三条通用前置、活 agent 亲手 merge、批准落库;显式 supersede 链为唯一重做出口 |
| §2.9 | notify-then-do 的 commands 内部 outbox 双校验 | commands 面删除;通知纪律归 Agent 判断(黑匣子只记账) |
| §2.12 | dispatcher 四循环 + ActionReconciler 第三角色 | 保留"看库拉进程"四循环(1498/调度已批形态);删 ActionReconciler |
| §3 | typed episode 写 durable mailbox/notification command,dispatcher claim suppression | 对齐 1501 已交付形态(告警 shim);obligations/病历卡族已删的表述统一 |
| §5/§6 | 病例矩阵 bypass 封闭(commands.result_code)、场景引用 | commands.result_code 审计位改 actions/events 表述;逐处同步 |
| §4 切换手册 | 无变 | 加一行:0008 已在上线前置完成,切换 Go/No-Go 无退役表残留检查项 |

单写者纪律:本单是当前唯一 design-FINAL 写者(founder 直令);1520 只读 §0/§1.4-1.6/§1.7/§2.12——改动不触碰 DAG/节点合同/ship 三条的批准语义,改后 diff 供跨族评审与 1520 侧比对。

## 5. advisories 的代码级锚点(处置定稿进 plan)

| advisory | 锚点 | 处置 |
|---|---|---|
| authorization digest replay | actions.ts:385-399 envelope 不含 authorization | 语义定死:replay 不比对、不覆写 authorization(黑匣子=当次事实);授权变化=新 logicalEffectId 新 root。加测试锁行为 + mapping/design-FINAL 成文。不改 envelope(改=把授权当身份,会把合法崩溃重入误判 collision,R1-M3 同理) |
| supersede 重用 predecessor invocationUid | actions.ts:346-357(supersede 参数)+ 385(replay 分支) | recordActionIntent 加谓词:spec.supersedesActionId 存在且 effect_key 命中既有行 → 响亮失败(不得走 replay 静默丢 supersede/retry_basis);测试:重用 predecessor uid 的 supersede 被拒 |
| result serialization 诚实 terminalization | v2-actions index.ts:60-67(成功路径 canonicalize 在 CAS 前抛) | perform 成功后先行试 canonicalize(result);失败 → 以 canonical 错误壳 {serialization_error:{name,message}, value_kind} terminalize **succeeded**(效果真发生了,失账才是谎),原始异常并入返回;测试:Date/Map 返回值效果成功且行 terminal。同款处理 failed 路径的 error 壳(已是受控形状,验证即可) |
| createdAt 校验 | actions.ts:437/462 | recordActionIntent.createdAt / recordActionOutcome.completedAt 加 canonical ISO 校验(isCanonicalIso 同型),非法=TypeError |
| canonicalizer exotic shapes | actions.ts:145-191 | 行为不改;补显式测试:toJSON 携带者按自身键序列化(非 toJSON 产物)、包装对象(new Number 等)非平凡原型被拒——锁死 R1-H1 修复的边界 |
| schema markers | 0008 DDL | 注释标注退役出处(修正案 + FLY-1518) |
| capabilityConsume 注释 | fence.ts FENCE 族 | 核对注释指向 1498 已合形态,过时则改注释(零行为) |
| retention ownership | design-FINAL §1.1 actions 条目 | 成文:actions 无 retention,归批次3 另审(0006 no_delete 触发器为证) |
| superseded plan banner | engineering/doc/FLY-1500-dispatcher-outbox-probes/plan.md 顶部 | 加横幅:本 plan 为 dispatcher 版历史稿,已被 mapping-v2final.md(actions 黑匣子)取代;1499 mapping 无冲突不加 |
| retained command/obligation 测试覆盖 | §3.3 清单 | 以 0008 双路径迁移测试 + 删后 schema 断言整族替代 |

## 6. 全链联测与 QA 等价证明矩阵(issue 范围 4/5 的验收骨架)

- M1 fresh 全链:空库 0001..0008 一次通过;表=20、命名索引集、触发器集、checksum 台账 8 行。
- M2 幂等重跑:migrate 两遍,第二遍 applied=[]。
- M3 带数据升级:0001..0007 库 + 三退役表塞行(含 obligations depth=1 子行、command_dependencies 边)→ 0008 干净删除 + 弃行回执计数正确。
- M4 0008 中途失败回滚(migrator-failure 同款)。
- E1 恰一次:转化做效果后、结算前杀进程 → 重投 → replay 短路,外部 perform 计数=1。
- E2 不丢(intent 前窗):intent 记录前崩 → 重投 → 效果发生,计数=1。**注意**:intent 已记、效果未做的窗口**不会**自动重做(replay 短路对 intended 同样生效)——那是 E4 的诚实窗语义,恢复出口=显式 supersede,founder 已接受的残余风险(1500 mapping §8.1-1/2),不是本单 bug。
- E3 结算原子:task/event 产出 + applied + attempt succeeded 同事务;注入 FK 失败全回滚。
- E4 诚实窗:intent 后效果前崩 → 重投 → replayed+intended 浮出且不得当成功。
- E5 一消息两动作:各自恰一次(Lead 点名)。
- E6 grep-zero + schema 无退役物。
- E7 一消息两动作中一个 replay 一个新做的混合形态(重投后部分完成)。
