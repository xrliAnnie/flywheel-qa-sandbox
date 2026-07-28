# FLY-1518 迁移 v2-engine 到 actions + 删退役表 — 实施计划

Issue: FLY-1518 (https://linear.app/geoforge3d/issue/FLY-1518/v2上线前置-迁移-v2-engine-到-actions-丢弃-commandsobligationscommand)
日期: 2026-07-28
基于: mapping-v2final.md(上游: research.md ← exploration.md;裁定链 = v2-final-design.html 四 🔴 + FLY-1498 extract + FLY-1500 mapping §0.2 + 本单 brainstorm gate)
状态: **codex-approved**(design review 5 轮:R1=3H+4M / R2=1H+2M+1L / R3=1H+1M / R4=2H+1L 全采纳 → R5 APPROVED(+1 非阻塞 LOW 已就地修);评审报告存 design-review/。Codex 两次上机实证:0008 DDL 带数据最小库全链执行(回执 2/1/2、六退役对象消失、零 FK 违反)、async 时序前缀重入复现)

---

## 0. 目标与边界

三个交付面,一次 PR:

1. **v2-engine**:command-effect 外发路径(sql.ts insertCommand / settlement.ts command 分支 / Effect command 变体)迁到 actions 语义(brainstorm 裁定方案 B);
2. **v2-kernel**:前向迁移 0008 删三张退役表(commands / command_dependencies / obligations)+ 落 FLY-1500 rebase 轮 advisories;
3. **文档**:design-FINAL-v2.md 并稿凌晨修正案成唯一权威真终稿 + FLY-1500 旧 plan superseded 横幅。

边界(mapping §5.2,逐字锁):不做 DAG 派发/切换/v1 告警删除;不给 actions 加 retention/探针/自动重试/执行器;不动 0001/0002 checksum 字节;不动 tasks 形状与 insertTask;不动 attempts observation 三列(有记录偏离,mapping §4);引擎不提供任何"取回 intended 再执行"的驱动面。

## 1. 交付面 1:v2-engine 迁到 actions 语义(方案 B)

### 1.1 转化动作接缝(零 kind 知识)+ 真实调用面(R1-1 定稿)

新文件 packages/v2-engine/src/conversion-actions.ts 承载实现;**对外只暴露一个真实
调用面,两个入口共享同一实现**(Codex R1-1:接缝必须接进真实 lead 转化路径,业务
converter 不得自由持有 kernel):

```ts
// —— 公开运行时接缝(进 root export / api-surface / type-tests)——
export interface ConversionActionSpec {
  kind: string;                             // actions.kind,非空即可,无中央枚举
  payload: JsonValue;
  logicalEffectId: string;
  qualifier?: string;                       // 仅限同一 logical root 的新一次 invocation
                                            // attempt,且必须与 supersedes 成对(见下)
  authorization?: JsonValue;
  supersedesActionId?: string;              // 显式重做链原样透传
  retryBasis?: { evidenceRef: string; reason: string };
}

// 入口一(runner/外部持 handle 方):driver 方法,经 #requireHandleState 验句柄现行
class EngineDriver {
  performConversionAction<R extends JsonValue>(
    handle: AttemptHandle, action: ConversionActionSpec, perform: () => R | Promise<R>,
  ): Promise<RunRecordedActionResult>;
}

// 入口二(lead 自动转化路径):Converter 第二参数注入 conversion context
export interface ConversionContext {
  handle: AttemptHandle;
  performAction<R extends JsonValue>(
    action: ConversionActionSpec, perform: () => R | Promise<R>,
  ): Promise<RunRecordedActionResult>;      // 绑定 kernel/runtime/handle 的闭包,
                                            // 内部与入口一同一实现
}
export type Converter = (message: {…现有五字段…}, ctx: ConversionContext)
  => Promise<ConversionResult>;             // driver.#runLead 组装 ctx 传入
```

内部实现要点(package-private,不进 root export——R1-1:derive/resolve 不对外):

- **invocationUid 派生(R1-4 修正:单射编码,弃 "::" 拼接)**:
  invocationUid = JSON.stringify(["conversion", messageUid, logicalEffectId, qualifier ?? null])
  ——定长形状的 JSON 数组编码,任意输入字符集下单射,无 delimiter 碰撞;uid 只做不
  透明幂等种子。messageUid 跨 processing attempt 稳定(m1#1/m1#2 同 message_uid)
  → 重投递撞 replay;logicalEffectId 分量保证同一消息多个动作互不相撞(Lead gate
  要求)。**qualifier 语义收紧(R1-4)**:qualifier 不改变 logical_key,同 root 第二条
  无链新行会撞 actions_one_root_per_logical——所以"两次独立效果"**必须换新
  logicalEffectId**(FLY-1500 mapping 原文);qualifier 仅用于同一 logical root 的显式
  重做(新 invocation attempt),且必须与 supersedesActionId + retryBasis 成对出现,
  接缝在组装期校验"qualifier 存在 ⇒ supersedesActionId 存在",违者 TypeError。
- **runner DAG 绑定解析**:kernel.read 里
  SELECT a.attempt_id, a.generation, at.task_id FROM activations a
  JOIN attempts at ON at.id=a.attempt_id WHERE a.id=@activationId;
  解析不到行 = FenceViolation(fail closed;0006 CHECK 链要求 runner 动作必绑
  task/attempt);lead = unbound。不加 state 谓词、不复制触发器逻辑——intent 事务内
  0006 current-actor/lineage 触发器是权威兜底。
- **cutoverEpoch 组装 + 双重 fence(R1-2 修正:此前遗漏)**:
  RecordActionIntentSpec.cutoverEpoch 必填且入 logical_key/replay envelope。取值 =
  handle 所绑 mailbox 行的 cutover_epoch(与消息同纪元);组装期 kernel.read 一并
  捕获。**prepare(tx) 内三等式 fence**:mailbox 行 epoch == 捕获值 == 当前 meta
  cutover_epoch(readCutoverEpochTx),不等 = FenceViolation,intent/effect 双双不
  发生——封死"捕获与 intent 之间跨进程 cutover 漂移 → stale epoch 落账/新纪元二次
  执行"窗口。落法:ENGINE_SQL.readAttemptBinding 增列 mailbox cutover_epoch,
  requireAttemptBindingTx 返回值携带,fence 与它同一读。
- actor = handle.agent 形状搬运(RegisteredAgent 与 ActionActor 一一对应);
- id = randomUUID()(行身份不参与幂等;幂等锚是 effect_key,replay 返回既有行 id);
- prepare(tx) = requireCurrentAgentTx + requireAttemptBindingTx(handle) + epoch 三等式
  ——intent 只在"现行 processing attempt 仍 running 且 mailbox 仍 pending 且纪元未漂"
  时落账;supersede 修复流(转化外)不走本接缝,直接用 kernel/v2-actions;
- 调 flywheel-v2-actions runRecordedAction,**不包装返回值、不吞 disposition**。

**settlement barrier(R2-1,driver 不变量:所有 action outcome 先于结算)**:两个
入口都是 async,漏 await 会让 mailbox/task/event/attempt 先提交、action outcome 晚到
——直接违反 D1。屏障做进唯一 driver 实现:

- AgentState 按当前 handle 登记每个 in-flight action Promise;登记即挂 rejection
  observer(防调用方忽略造成 unhandled rejection);结果落回登记表。
- **登记先于执行(R4-1,happens-before 规则)**:runRecordedAction 的同步前缀会先跑
  用户 perform 的同步段——若"先调后登记",该同步段可重入 driver 结算/stop 而守卫
  看不见任何 in-flight。定稿:driver 先登记一个 wrapper placeholder Promise(observer
  已挂),**下一个 microtask 才启动内部 runRecordedAction**;E10 含"同步 perform 前缀
  重入 driver 结算被拒"的回归。
- **生命周期同闸(R4-2)**:stop() 在置 #stopped 或任何库写之前预检全部 state,任一
  in-flight action ⇒ FenceViolation(动作完成后重试 stop 保持原语义);registerLead /
  attachRunner 在 registerAgentTx、#stopState、state 替换**之前**检查本地既有 state
  的 in-flight 登记,悬空 ⇒ 拒绝替换——同 driver 换代不得丢弃/越过屏障。E10 含
  "pending 时 stop / 同 driver 重注册零库写,完成后可行"两例。**registerAgentTx 定位
  澄清**(成文进 §1.2 与 design-FINAL):它是 DeathEvidence 门控的确证死亡跨进程
  接班原语(E6 域),不是活转化结算面;"唯一公开结算面 = driver 两方法"的表述限定
  在转化结算域。
- lead 路径:converter 返回后**先关闭 context**(此后 ctx.performAction 调用一律
  FenceViolation),再 drain 全部已登记 action——任何一个在 drain 中 reject ⇒ 本次
  转化按失败结算(reportConversionFailure,converter 声称 ok 但自己的动作还悬着/
  炸了 = 合同违约,诚实降级);全部 resolve 才允许 success settlement。
- 直接入口(runner/外部):submitProposal / reportConversionFailure 在该 handle 仍有
  in-flight action 时 FenceViolation fail closed(保持同步签名,不隐式等待)——调用
  方必须 await 完自己的动作再结算。
- 回归 = §4 E10 守卫矩阵全九分支(R4-3:此处不再单列子集,以 E10 为准)。

依赖与 API 面(R1-6 补全):packages/v2-engine/package.json 增 flywheel-v2-actions
workspace 依赖(v2-actions 只依赖 v2-kernel,无环)+ **pnpm-lock.yaml 同步**(CI
frozen-lockfile);src/index.ts、__tests__/api-surface.test.ts、type-tests/
public-api.ts 三处同步新公开面(ConversionActionSpec/ConversionContext/驱动方法/
Converter 新签名),Effect 收窄同步。

### 1.2 结算路径收窄(删 command 分支)

- types.ts:Effect 联合删 command 变体;task/event 变体字节不动。
- settlement.ts:validateProposal 删 command 分支(commandKind/effectKey 校验随删);
  writeEffect 删 command 分支;其余(insertTask/insertEvent、mailbox.applied 事件、
  applied CAS、attempt CAS)字节不动。
- sql.ts:删 insertCommand 常量。
- index.ts 导出面随 types 收窄(Effect 类型导出保留,形状变窄)。
- **裸结算函数退出公开面(R3-1)**:index.ts 现导出的自由函数 submitProposal /
  reportConversionFailure(settlement.ts:128/167)不经 AgentState,持 kernel/runtime
  的调用方可绕过 barrier 在 action 悬空时结算——两函数从 root export 撤下,降为
  package-private 实现助手;**EngineDriver.submitProposal / reportConversionFailure
  是唯一公开的活转化(conversion settlement)结算面**——registerAgentTx 是
  DeathEvidence 门控的确证死亡跨进程接班原语(E6 域)例外,不属活转化结算
  (R5-LOW 措辞对齐 §1.1);api-surface/type-tests 同步并加负断言(裸函数不得再出现在
  runtime export 集)。全仓 sweep 无 v2-engine 之外调用方,无兼容代价。留档:本单
  取代 FLY-1499"公开自由结算入口"的原始决定——action/settlement 排序如今要求
  driver 持有的 in-flight 状态,结算必须收口 driver。

### 1.3 引擎测试改造

| 测试 | 改法 |
|---|---|
| settlement-v2 "rolls proposal effects…on an effect FK failure" | 失败注入器从 command FK 换成 task effect 的 lineageRootTaskId 指向不存在 task(tasks.lineage_root_id FK);**effects 排序 = 先一个合法 event/task,再 invalid task(R1-7)**——断言合法前置产出、invalid 产出、mailbox.applied 事件、applied CAS、attempt CAS **五者全部未提交**,证明整事务回滚而非只证第一条失败 |
| poll-loop-v2 "surfaces an asynchronous lead settlement error" | 错误源同上换 FK 注入;只保留"异步结算错误浮到下次 poll"的机制证明职责 |
| helpers.ts:109 / config-registration-enqueue-v2.test.ts:220 | fixture 去掉 observed_state 显式写入(列有 DEFAULT;D2 配套) |
| api-surface.test.ts / type-tests/public-api.ts | 同步 Effect 收窄 + 新接缝公开面(R1-6) |
| 新增 conversion-actions.test.ts | §4 等价矩阵 **E1-E10** 全落此文件(+身份映射/绑定 fail-closed/uid 单射反例/qualifier⇒supersede 校验/epoch 漂移 fence;E10 生命周期九分支亦归此文件,公开面负断言归 api-surface.test.ts——R4-3 归属点名);**E5/E7 必须含一条从 registerLead 进入的端到端形态**(converter 经 ctx.performAction 调用,不许只直调 helper——R1-1) |

## 2. 交付面 2:v2-kernel 0008 迁移 + advisories

### 2.1 0008-drop-retired-command-obligation-tables(fkMode: "rebuild")

```sql
-- FLY-1518: commands/command_dependencies/obligations 按 founder 终稿
-- (v2-final-design.html, actions 黑匣子整包替换 dispatcher/commands;病历卡族删除)
-- 退役。FLY-1500 mapping §0.2 过渡保留至此结清。
-- 弃行回执:退役表带数据时 DROP 即弃,但计数必须留持久账,不静默(Lead D3 裁定)。
INSERT INTO events (event_uid, task_id, attempt_id, kind, source_kind, source_id,
                    payload, cutover_epoch, created_at)
VALUES (
  'migration:0008:retired-rows-discarded', NULL, NULL,
  'migration.retired_rows_discarded', 'migration',
  '0008-drop-retired-command-obligation-tables',
  json_object(
    'commands',             (SELECT count(*) FROM commands),
    'command_dependencies', (SELECT count(*) FROM command_dependencies),
    'obligations',          (SELECT count(*) FROM obligations)
  ),
  CAST(COALESCE((SELECT value FROM meta WHERE key='cutover_epoch'), '0') AS INTEGER),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- 挂在 tasks/attempts 上的 tombstone 触发器不随 DROP TABLE obligations 消失,先显式删
DROP TRIGGER obligations_tombstone_task_terminal;
DROP TRIGGER obligations_tombstone_attempt_terminal;

-- 子表先删(command_dependencies 两条 FK → commands)
DROP TABLE command_dependencies;
DROP TABLE commands;
DROP TABLE obligations;  -- 自引用 FK + 自身触发器/索引随表消失
```

- fkMode rebuild 理由:obligations 自引用 parent_obligation_id,FK ON 下 DROP 的隐式
  DELETE 行序不保证(depth=1 子行的库会瞬时违反);rebuild = FK OFF + 事后
  foreign_key_check + 事务回滚保护,与 0002/0005/0006 同款、migrator-failure 已验。
- 回执写在 DROP 前(要数还得有表);fresh 链回执 = 全零(诚实);event_uid 确定性
  (重放幂等由 migrator checksum 台账保证,events UNIQUE 双保险)。
- 0001/0002 checksum 逐字不动;migrations/index.ts 追加 0008 条目。

### 2.2 advisories 代码落点(research §5 处置定稿)

| # | 改动 | 文件 | 行为 |
|---|---|---|---|
| A1 | supersede 拒重用 predecessor invocationUid | v2-kernel actions.ts recordActionIntent | spec.supersedesActionId 存在且 effect_key 命中既有行 → 抛错(拒走 replay 静默丢 supersede/retry_basis);错误信息点名"supersede 必须换新 invocationUid" |
| A2 | result 序列化诚实终态化 | v2-kernel actions.ts + errors.ts + v2-actions index.ts | **单一共享边界(R1-5 修正)**:kernel 把 canonicalization 失败包装成可类型区分的公开错误 ActionSerializationError(errors.ts 新增,进 kernel public surface / public-api / type-tests);v2-actions 成功路径先按原样 recordActionOutcome(succeeded, result),**仅捕获该类型错误**时改以 {serialization_error:{name,message}, value_kind} 壳重写 succeeded 并返回 performed(效果真发生,失账才是谎);CAS/fence/SQLite 错误原样上抛,绝不伪装成序列化失败。不复制 canonicalizer、不开放第二套 JSON authority |
| A3 | createdAt/completedAt canonical ISO 校验 | v2-kernel actions.ts | 显式传入时校验 canonical ISO(Date.parse 往返相等),非法=TypeError;缺省 new Date() 路径不变 |
| A4 | authorization replay 语义锁定 | v2-kernel actions.ts 测试 + 文档 | 行为不改(envelope 不含 authorization——改了会把合法崩溃重入误判 collision):测试锁死"同 effect_key 不同 authorization → replayed 返回旧行、旧 authorization 不被覆写";语义成文:授权变化 = 新 logicalEffectId 新 root |
| A5 | canonicalizer 边角测试 | v2-kernel actions 测试 | 锁**当前真实行为**(R1-5 措辞修正):callable toJSON **不被调用**——函数值被拒;JSON 值形态的普通 toJSON 字段按数据处理;boxed object(new Number 等非平凡原型)被拒。只锁边界不改行为 |
| A6 | capabilityConsume 注释校正 | v2-kernel fence.ts | 指向 FLY-1498 已合形态,零行为 |
| A7 | schema markers | 0008 DDL 注释 | 已含(§2.1) |
| A8 | retention ownership 成文 | design-FINAL §1.1 actions 条目 | actions 无 retention,归批次3 另审 |
| A9 | superseded plan banner | FLY-1500 旧 plan.md 顶部 | 横幅指向其 mapping-v2final.md;1499 mapping 无冲突不加 |
| A10 | retained command/obligation 测试覆盖 | — | 以 §3 迁移双路径 + 删后 schema 断言整族替代 |

### 2.3 kernel 测试期望集更新

- migrator.test.ts:EXPECTED_TABLES 23→20;EXPECTED_NAMED_INDEXES 删
  obligations_episode_open;applied 全链断言含 0008;幂等重跑覆盖 0008。
- schema-contract.test.ts:触发器清单剔除 obligations 五族 + command_dependencies
  两族;commands/command_dependencies 行为测试删除;新增"0008 后三表/两触发器/一索引
  不存在 + 弃行回执行存在"断言。
- obligations-migration.test.ts:重新定位为 0001..0002 子链历史迁移测试
  (MIGRATIONS.slice 到 0002;0002 仍在链上,历史正确性仍须锁);全链行为归
  migrator.test。
- migrator-failure.test.ts:保留;加 0008 中途失败回滚用例(M4,坏 DDL 变体注入同款)。
- backup.test.ts:61 硬编码迁移列表止于 0007(R1-6)——随 0008 更新;若 A2 新增
  kernel 公开错误,public-api.test.ts / type-tests 同步。

## 3. 交付面 3:文档并稿

### 3.1 design-FINAL-v2.md → 真终稿

按 research §4 逐节清点执行(§T/§1.0 表清单 20 张/§1.1/§1.2e/§1.4/§1.5/§2.9/§2.12/
§3/§5/§6),裁定来源三址写进头注;D2 偏离写进 §1.1 attempts 条目("observed_state
等三列过渡保留,退役归属 post-launch attempts 重建");§4 切换手册写入 0008 恢复
runbook(R2-2:quiesce 全部 writer → backupDatabase 验证 → 跑 0008 → 失败/回滚时
隔离新库及 WAL/SHM、恢复快照、配对 code revert、以 0007 ledger 与旧表数据核对后重启)
+ "0008 已前置完成,切换无退役表残留检查项"一行。
纪律:只删 commands/reconciler/病历卡族与过时表述,**不触碰** 1498 批准的 DAG/节点
合同/ship 三条语义(1520 正按它施工);改完 diff 供跨族评审比对。

### 3.2 FLY-1500 旧 plan.md 横幅(A9)

顶部加"本 plan 为 dispatcher 版历史稿,机制结论已被同目录 mapping-v2final.md(actions
黑匣子)整体取代,仅作评审轨迹保留"。

## 4. 验收矩阵(QA 独立复核的骨架;issue 范围 4/5)

迁移族(M):
- M1 fresh 全链:空库 0001..0008 一次通过;表=20、命名索引集、触发器集、
  schema_migrations 8 行、弃行回执全零。
- M2 幂等:migrate 第二遍 applied=[]。
- M3 带数据升级:0001..0007 库塞旧表行(obligations 含 depth=1 子行与自引用、
  command_dependencies 含边)→ 0008 干净删除 + 回执计数=塞入数。
- M4 0008 中途失败:整体回滚——三表俱在**且旧表数据未失**、两个 tombstone 触发器仍在、
  **弃行回执行不存在**(R1-7:DROP 前已写的回执必须随事务回滚)、台账无 0008 行。
- M5 备份恢复(R1-3 配套;R2-2 落成可执行步骤):具名测试(落 backup.test.ts 新
  用例"restores the pre-0008 database")走完整恢复序:对 0001..0007 库塞旧表数据 →
  backupDatabase 并验证快照 → 应用 0008(旧表消失)→ **切换运行库路径到恢复副本**
  (隔离已迁移 DB 及其 WAL/SHM,恢复快照文件,重新 openKernelDb)→ 断言 ledger 无
  0008、三表与逐行数据俱在。不许退化成 read-only 打开备份文件。恢复 runbook 成文进
  design-FINAL §4 切换手册(见 §3.1):quiesce 全部 writer → backupDatabase 验证 →
  跑 0008 → 失败/需回滚时隔离新库、恢复快照、配对 code revert、以 0007 ledger 与旧表
  逐行数据核对后才重启。

等价族(E,commands outbox → 纯 actions 的语义等价证明):
- E1 恰一次(效果后崩):转化经接缝做效果(计数器)→ 不结算模拟崩溃 → 重投/重注册
  → 转化重跑 → replay 短路,perform 计数=1;结算后 applied/succeeded 正常。
- E2 不丢(intent 前崩):intent 前崩 → 消息仍 pending → 重投 → 效果发生,计数=1。
- E3 结算原子性不变:task/event 产出 + mailbox applied + attempt succeeded 同事务;
  FK 注入失败三者全回滚(接 §1.3 改造后的注入器)。
- E4 诚实窗(intent 后效果前崩):重投 → 接缝返回 replayed+intended;测试锁死转化方
  合同——replayed+intended 不得当成功推进(断言 disposition 分支);显式 supersede
  (新 uid + evidence)恰执行一次。此窗**不自动重做**是 founder 已接受语义
  (1500 mapping §8.1),测试名与注释写明,防 QA 误报。
- E5 一消息两动作(Lead 点名):不同 logicalEffectId 各自恰一次,跨重投递不互撞;
  **含一条 registerLead 端到端形态**(converter 经 ctx.performAction,R1-1)。
- E8 纪元漂移 fence(R1-2):epoch 捕获后、intent 前跨进程改 meta cutover_epoch →
  FenceViolation,零 action 行、零 perform;replay 路径只读旧事实不执行。
- E9 uid 单射与 qualifier 纪律(R1-4):delimiter 碰撞反例(两组不同输入不得同 uid);
  qualifier 无 supersedesActionId = TypeError;同 logicalEffectId 不带链的第二 root
  撞 actions_one_root_per_logical 响亮失败(证明 qualifier 绕不过 root 唯一)。
- E10 settlement barrier 守卫矩阵(R2-1 + R3-2 + R4 全分支):
  ①lead converter 不 await deferred performAction → mailbox 在 action outcome 前
  保持 pending;②runner 在 action pending 时 driver.submitProposal 被
  FenceViolation 拒,await 后可结算;③action pending 时 driver.reportConversionFailure
  同样被拒;④converter 捕获 ctx 后于关闭之后调 performAction → FenceViolation,
  零 intent 零 perform;⑤converter 起了 deferred action 后 throw / 返回 ok:false →
  失败结算同样等 drain,action rejection 恰产生一次失败结算且无 unhandled rejection;
  ⑥裸结算函数不在公开面(负断言,归 api-surface.test.ts,R3-1);
  ⑦登记先于执行:同步 perform 前缀重入 driver 结算被拒(R4-1);
  ⑧pending 时 stop() 零库写 FenceViolation,动作完成后 stop 成功(R4-2);
  ⑨pending 时同 driver registerLead/attachRunner 重注册被拒零库写,完成后可行(R4-2)。
- E6 世代接班:效果已做、旧世代崩、新世代重注册 → replay 返回 intended(新世代不能
  改写旧行 outcome,CAS 拒)→ 不重做不双发;供 QA 验证接班语义。
- E7 混合重投:一消息两动作,第一个已做第二个未 intent 时崩 → 重投后第一个 replay、
  第二个新做,各自恰一次。

收尾族(Z):
- Z1 grep-zero,两道拆分(R1-6;R2-3 修正 allowlist 自洽):
  Z1a 生产运行时(packages/v2-* 的 src,**排除 migrations/ 与 __tests__/**)零
  commands/obligations/command_dependencies **SQL 读写形态**引用(FROM/INTO/UPDATE/
  TABLE 多形态 sweep,FLY-205 教训);
  Z1b 迁移与退役证明面精确 allowlist(区别"生产读写"与"迁移/退役证明"):0001、
  0002、**0008 迁移文件本体**(DDL 必然含表名)、obligations-migration.test.ts
  (0001..0002 子链历史测试)、migrator-failure.test.ts 的 0002 与 0008 用例、
  schema-contract.test.ts 的**负断言**(证三表不存在)、以及承载 M3/M4/M5 的具名
  迁移测试;allowlist 之外零引用。doc/ 归档与 v1 域同名物(teamlead comm.db 族)
  不在扫描面。
- Z2 全仓 pnpm lint + pnpm -r build + 全仓测试(环境性失败单独留证,不冒充通过)。
- Z3 design-FINAL 与已合 schema 一致性抽查(表清单、actions 三态、无 dispatcher 词残留
  ——用脚本抽查关键词,镜像 FLY-1498 verify-design-consistency.sh 思路,轻量版)。

## 5. TDD 顺序(垂直切片,逐条 red→green)

1. kernel advisories:A1(supersede 拒重用 uid)→ A3(时间戳校验)→ A4/A5(锁行为
   测试)——每条先红后绿;
2. kernel ActionSerializationError(typed error + public surface/type-tests 先红绿)
   → v2-actions A2 fallback(R2-4:依赖顺序显式);
3. 引擎接缝 conversion-actions.ts + 双入口 + settlement barrier:uid 单射(E9)+
   身份映射 + 绑定解析 fail-closed 双反例(无 activation 行 / lead unbound)+ epoch
   fence(E8)→ E5 两动作(含 registerLead 端到端)→ E10 守卫矩阵全分支(含
   登记先于执行、stop/重注册生命周期两例——R4);
4. 结算收窄:删 command 变体与分支,§1.3 两个测试换注入器,E3(先合法后 invalid 排序);
5. 等价矩阵 E1/E2/E4/E6/E7(崩溃点用"做效果不结算 + 重建 driver/重注册"模拟,
   同款先例 settlement-v2 已有);
6. 0008 迁移 + kernel 期望集更新(含 backup.test 列表)+ M1-M5 + Z1 allowlist 定稿;
7. 文档并稿(design-FINAL 含 §4 恢复 runbook / 横幅)+ Z3;
8. Z2 全仓收尾。

实现期间 progress.md 每切片一记(--set-chunk)。

## 6. 反 over-reaction 检查(每个新增机制答"哪个已枚举场景需要它")

| 机制 | 已枚举场景 | 根治为何不够 |
|---|---|---|
| invocationUid 含 per-action 分量 | 同消息两动作,第二个撞第一个 replay 短路(Lead gate 点名) | 只靠 messageUid 根治不了多动作;分量进 uid 是最小形 |
| prepare 里 requireAttemptBindingTx | 陈旧句柄(已结算/已换代)迟到记 intent,黑匣子挂上死转化 | kernel 触发器只验 agents/attempts 真实性,不知道 processing attempt 现行性 |
| settlement barrier(in-flight action 登记) | 漏 await 的 performAction 让结算先于 action outcome 提交,违反 D1(Codex R2-1) | prepare 闸只管 intent 时点;结算时点没有任何机制知道还有动作悬着 |
| epoch 三等式 fence | 捕获与 intent 之间跨进程 cutover 漂移 → stale epoch 落账/新纪元二次执行(Codex R1-2) | logical_key 含 epoch,只在组装期读一次防不住写时漂移 |
| 弃行回执(events 一行) | Lead D3:带数据库被静默清空无从审计 | migrator 无日志钩子;stdout 会丢,库内 append-only 行不丢 |
| A1 supersede 拒重用 uid | 重用 predecessor uid 的 supersede 被 replay 静默吞,retry_basis 丢失 | envelope 修正(R1-M3)后 replay 分支天然吞掉 supersede 字段,必须显式拒 |
| A2 诚实终态化 | perform 成功但 result 是 Date/Map → 行永停 intended,效果失账 | canonicalize 严格化(R1-H1)治了假摘要,治不了"真效果记不上账" |

**保护性机制单列(供砍)**:prepare 的句柄现行性闸(砍掉则靠 kernel 触发器 + 调用方
纪律);Z3 一致性抽查脚本(砍掉则靠人工 diff 审阅);E6 世代接班用例(砍掉则接班语义
只有 kernel 层测试,引擎层无端到端证据)。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 方案 B 的"intended 停留"被误当 bug 报 | E4 测试名/注释/design-FINAL §1.2e 三处写明 founder 已接受语义 |
| 0008 在异构历史库上的 FK 行为 | fkMode rebuild + foreign_key_check + M3 塞满自引用/边的升级测试 |
| design-FINAL 大改误伤 1520 施工面 | 只删修正案明杀族;1498 批准三条语义零触碰;diff 供跨族评审比对 |
| 与 1520 的 0008 编号/文件冲突 | 1520 施工纪律明文不加迁移不动 v2-engine;已在 gate 与 Lead 确认 |
| 回滚(R1-3 修正:代码 revert ≠ 数据库降级) | **两段合同**:①0008 尚未应用于任何持久库 → git revert 即回 9455a2b8;②0008 已应用 → migrator 只有前向,revert 后旧引擎 INSERT INTO commands 会撞缺表——必须恢复迁移前 WAL-safe 备份(backupDatabase),或对 pre-launch 可抛弃 v2 库明确整库重建;弃行回执只是审计计数,**不是恢复凭据**。升级 runbook 硬前置:对任何非可抛弃库跑 0008 前先备份并验证可恢复(M5 落测) |

## 8. 完成判据

- 引擎源码零 commands 引用;Effect 无 command 变体;接缝(driver 方法 + Converter
  ctx 双入口)+ settlement barrier 上线且 E1-E10 全绿(含 registerLead 端到端形态)。
- 0008 在链上;M1-M5 全绿;kernel 期望集更新(含 backup.test 迁移列表);三表/两
  触发器/一索引从库里消失,弃行回执可查;恢复 runbook 成文并被 M5 实证。
- advisories A1-A10 全落(代码 5 + 测试锁 2 + 注释/横幅/成文 3)。
- design-FINAL-v2.md 为唯一权威真终稿(头注裁定三址、20 表、actions 三态、
  无 dispatcher/reconciler/病历卡残留、D2 偏离成文);Z3 抽查通过。
- 全仓 lint/build/tests 通过;QA 独立复核 M/E/Z 三族。
