# FLY-1499 消息消费循环 — 调研

Issue: FLY-1499 (https://linear.app/geoforge3d/issue/FLY-1499/v2批次2-消息消费循环-串行消费公平性处理账活性保证设计终版-12a-f)
日期: 2026-07-27
基于: exploration.md(brainstorm gate 已过,Lead 四点裁决:a 语句注册表否决/b INDEXED BY+created_at 批准走 D14/c v2-engine 批准且 kernel 导出面只加不改/d 垫片接口归本单)

---

## 1. 批次1 交付物的实际状态(逐一核实,非凭 plan 记忆)

### 1.1 v2-kernel 公开导出面(index.ts 实测)

**已导出(runtime)**:Kernel / migrateDatabase / backupDatabase / CANDIDATE_SQL / DETECTOR_SQL / leadRegistryKey / consumerRegistryKey / DEFAULT_V2_DB_PATH / 五个错误类(CasViolation/FenceViolation/NestedWriteViolation/TxBudgetExceeded/TxLifecycleViolation)。
**已导出(type-only)**:AgentIdentity / ReadTx / WriteTx / KernelOpenOptions / MigrateOptions。

**已实现但未导出**(fence.ts 内,批次 2 需要,按 gate 裁决 c「只加不改」扩展导出):

| 符号 | 批次 2 用途 |
|---|---|
| readRegistry(tx,key) / writeRegistry(tx,key,entry) | 注册事务(cutover 点)与 crash 归因读取旧世代身份 |
| identitiesEqual(a,b) | 引擎侧身份比较(避免重写校验逻辑) |
| FENCE 模板对象 | 已含 mailboxCasPendingApplied / processingAttemptCasRunningSettled / activationCasActiveTerminal / attemptCasActiveTerminal —— 批次 1 已为本批次预铺的 CAS 谓词模板 |

### 1.2 Kernel.write 行为合同(kernel.ts 实测,引擎设计的硬约束)

- BEGIN IMMEDIATE(db.transaction().immediate());回调必须同步(AsyncFunction 构造直接拒,thenable 返回值在 wrapper 内拒);**事务时长闸 txBudgetMs 默认 1000ms**(回调 elapsed 超限=提交前抛 TxBudgetExceeded 回滚)——引擎的 start/结算事务都必须是短事务,转化绝不能在写事务内做(与 §0.5b 一致,且被机器强制);
- WriteTx.cas(sql,params,expected=1):changes≠expected → CasViolation 整事务回滚;
- WriteTx.requireIdentity(registryKey,expected):同事务读 meta registry 全字段比较,缺失/畸形/不符一律 FenceViolation fail-closed;
- **同一 Kernel 实例禁嵌套/禁并发 write**(#inWrite 标志)——引擎每消费者进程持一个 Kernel 实例,循环天然串行,与 single-flight 相容;
- 连接状态 SQL 守卫(读写两面,关键字层+EXPLAIN 剥壳+tokenizer 对齐规则)= 1497 三轮修复后现状;**gate 裁决 a:维持现状,不加固,不加注册表**;
- Kernel.read = 只读访问面而非只读事务(无 BEGIN)——跨多次读的一致性判断必须自开事务;引擎凡「读了就要据此写」的判断(候选选择→start)一律放进写事务内重查(与 §1.2a「逐条重查」「start 事务内校验 pending」自然一致)。

### 1.3 迁移与索引(批次1 已落库,本批次只消费不改)

17 表 + 13 命名索引已建;mailbox 家族 7 索引 + pa_one_running + activations 双 partial unique 是本批次消费循环的地基。CANDIDATE_SQL(F1/F2/N1/N2)与 DETECTOR_SQL 是常量导出,query-plan.test 对其做 EXPLAIN 断言 + design-chain byte-for-byte snapshot;**修订这些常量必须同步修订两类测试的合同**(D14 先例:snapshot 断言 diff 精确刻画)。

## 2. 台账 1 受控 spike(本设计阶段实测,better-sqlite3 12.8.0 / SQLite 3.51.3)

数据形态 = 1497 QA 翻盘实验逐字段同形(3000 行 / founder 1/7 / 25 收件人 / 1/3 scheduled / 1/11 applied / 查询 agent=runner-1):

| # | 实验 | 结果 |
|---|---|---|
| 1 | 无统计基线 | F2→_f,N2→_nf(与批次1 断言一致) |
| 2 | ANALYZE(stat1+stat4) | **F2 翻到基础 scheduled 索引(翻盘复现)**;N2 此配比未翻(与 QA 表格一致,配比决定翻哪条) |
| 3 | 同一统计下 INDEXED BY | F2 钉回 _f、N2 钉在 _nf;无 TEMP B-TREE |
| 4 | 投影加 created_at | 不改变 pinned plan(候选索引非 covering,行读取本就发生) |
| 5 | pinned vs free 取行 | 首选行完全一致(正确性等价) |
| 6 | DROP 目标索引后 prepare pinned SQL | 立即报 no such index(fail-loud,契合权威库哲学) |
| 7 | 谓词与 partial index WHERE 不匹配 | no query solution 拒绝(不静默错行)——钉死「INDEXED BY 只可能拒绝,不可能错答」 |

结论:INDEXED BY 是 §1.2f 公平分区在有统计世界里的**兑现手段**(gate 裁决 b 已批)。风险面收敛为「索引缺失/谓词漂移→prepare 失败」,而这恰是想要的 fail-loud。

## 3. v1 现实对标(设计链引用的锚点,核实现状)

| v2 机制 | v1 现实(实测位置) | 对标要点 |
|---|---|---|
| Lead 周期 pull 30s | packages/teamlead/src/bridge/lead-inbox-loop.ts:ACTIVE=1s / IDLE=30_000ms,at-least-once,authority 留在 comm.db 直到 durable receipt | v2 的 30s 周期 pull 有现实先例;v2 把 authority 收进 flywheel-v2.db 单库单事务 |
| 门铃=hint 无 authority | packages/flywheel-comm/src/wake.ts 显式注释「a wake is a HINT, never authority」 | v1 已确立的哲学,v2 结构化为「门铃可丢,truth 在表」 |
| runner durable deliver | v1 无等价物(wake 是 best-effort 单发)——这正是 v2 §1.2b 要补的活性缺口 | kernel timer 实查+重试至观察终态,是新增合同 |

## 4. 并行批次协调状态

- gate 裁决 d:垫片接口(hint/deliver 类型)定义在 v2-engine,由本单给出;1501 只实现 Claude/Codex 适配。Tadashi 已同步 1501 避免双定义。
- 1500(dispatcher):我的结算事务只写 pending command 行(outbox 写侧);command 的 kind/payload 形状已由批次1 schema 钉死(commands 表 8 态机),写侧不新增列。crash 归因「探针确认死亡」在本批次以注入的证据接口出现(测试模拟),探针实现归 1500/批次3。
- 包名:v2-engine 由本单启用并只放消费循环域;1500/1501 落点由各自设计定,不在此预占。

## 5. 对 plan 的直接约束(调研结论汇总)

1. 引擎全部写路径必须塞进 ≤1s 的同步回调(txBudgetMs 默认)——start/结算/注册/处置各事务的语句数都很小,预算充足;plan 不调大预算,反而以之为红线。
2. kernel 导出面扩展清单(只加不改):readRegistry / writeRegistry / identitiesEqual / FENCE(+若干新增 CAS 模板常量,见 plan)——每项标注「为谁而加」;批次1 恰等断言测试同步更新。
3. 候选 SQL 修订面 = CANDIDATE_SQL 四条(INDEXED BY + created_at 投影);DETECTOR_SQL 不动;修订走 D14 手法:design-chain 原文不改,plan 内文本即 canonical,snapshot 断言 diff 恰为已批修订。
4. 选择算法在 ≤4 条候选上做纯函数决策(founder 类含晋升/K 配额/类内确定性择序)——可单测穷举。
5. 由 §1.2c「同世代 single-flight=每进程内以 to_agent 为 key 串行化」+ Kernel 禁并发 write:引擎形态=每消费者一个单线程循环对象,门铃只置 dirty 标志。
6. due scheduler/kernel timer:批次 2 交付进程内 timer 服务(注入时钟,可测),持久性由「注册必拉+重启后重建最早 due」承担,不需要跨进程持久 timer 状态(mailbox 的 next_retry_at 本身就是持久真相)。
7. T_max 监察=timer 扫 running attempt started_at;触发的「硬终止+探针确认+换代」以接口边界交付(注入模拟),真接线归批次3。
