# FLY-1499 消息消费循环 — 探索

Issue: FLY-1499 (https://linear.app/geoforge3d/issue/FLY-1499/v2批次2-消息消费循环-串行消费公平性处理账活性保证设计终版-12a-f)
日期: 2026-07-27
基于: 无(本单首文档;设计权威 = doc/engineer/plan/v2/design-FINAL-v2.md,Codex R13 APPROVED)

---

## 1. 这单要做什么(一句话)

把设计终版 §1.2a-f 的「消息消费循环」落成可实施的设计:每个收件人一个串行消费者,从 mailbox 逐条取消息做「转化」,founder 有界优先但不饿死普通消息,每次处理都有账(processing_attempts),消息永远不会因为门铃丢失/进程崩溃而无人处理。

**本设计节点交付的是设计文档(exploration/research/plan + design review),不写实现代码**;实现由同分支的 Implement 节点做。

## 2. 范围(设计终版逐条对应)

| # | 范围条目 | 设计出处 |
|---|---|---|
| 1 | 串行消费循环:batch=1 逐条重查;转化三出口(快答/建 task 派发/登记工作项);处理完成=转化产出已提交 | §1.2a / §2.10(v6/v7) |
| 2 | 公平性:K=4 有界优先 + 30min 超龄晋升 + 四路候选 exact SQL(F1/F2/N1/N2)+ SLA 统一公式 T(q,R) | §1.2e / §1.2f(v9/v10/v11) |
| 3 | processing_attempts 处理账:start fence / pa_one_running 单 running / 成功同事务结算 / 失败与 crash 按 attempt_uid CAS exactly-once / 5 次→dead | §1.2d(v8/v9) |
| 4 | 活性保证:注册必拉 + Lead 30s 周期 pull + 到点调度(due scheduler)+ runner 由 kernel timer 实际查询 + durable deliver | §1.2b(v7/v8) |
| 5 | consumer registry + 注册事务=唯一 cutover 点 + 同世代 single-flight + 终局收件人处置 + admission 拒不可路由地址 | §1.2c(v7) |

加两条**台账**(1497 QA 实证,必须处理,见 §5/§6)。

## 3. 与并行批次的边界(先划清,防重叠)

| 相邻单 | 它拿走的 | 我与它的接口 |
|---|---|---|
| FLY-1500(dispatcher+outbox+探针) | command 执行 claim / effect receipt / reconcile / 探针 / saga | 我的转化事务**只写 pending command 行**(outbox 写侧);执行归 1500。crash 归因所需「探针确认旧进程死亡」作为**前提输入**(布尔证据),探针实现归 1500/批次3 |
| FLY-1501(告警+风暴+垫片) | §3.1 聚合告警四步事务 / §2.11 重启风暴 / 垫片 vendor 实现 | 垫片**接口合同**(hint/deliver 两方法,无 ack)由我定义并消费;vendor 适配实现归 1501。超龄 detector SQL 已在 kernel(批次1),我消费其口径做 30min 晋升;聚合告警事务归 1501 |
| FLY-1498(门与派发) | 节点完成合同 / ship 通用三条 / DAG 派发器 | 无直接接口;转化出口「建 task 派发」产出的 task 行由 1498 的派发模型消费 |
| 批次 3(切换手册) | 生产接线 / comm.db 退役 / stop-the-world 切换 | 本单与批次1 同规矩:**零接线**,生产行为零变化 |

## 4. 核心机制理解(供 brainstorm gate 确认)

### 4.1 串行消费循环(§1.2a)

- 每个 to_agent 恰一个逻辑消费者;同进程内 per-agent single-flight(门铃风暴只置标志位,不并发第二个循环)。
- **batch=1 逐条重查**:每处理完一条,重新跑四路候选查询选下一条 —— 新到的 founder 消息下一轮即可见。
- 每条消息的生命周期(三段,写事务全走 Kernel.write,BEGIN IMMEDIATE):
  1. **start 短事务**:requireIdentity(consumer registry 当前身份)+ 校验 mailbox state='pending' + 无 running attempt(pa_one_running 兜底拒)→ 插 processing_attempts(running,原子分配 attempt_no,稳定 attempt_uid);
  2. **转化(事务外)**:秒到分钟级,T_max=10min 硬上限(started_at 起算);LLM/网络绝不进写事务(§0.5b);
  3. **结算短事务**(三选一,全部 CAS 行数=1 否则整体回滚):
     - 成功:业务行(commands/tasks/events/receipts)+ mailbox CAS pending→applied + pa CAS running→succeeded,**同一事务**;
     - 显式失败:pa CAS running→failed + mailbox retry_count+1 + next_retry_at 退避(30s×2^n cap 15min),≥5 次→dead(DLQ);
     - crash(进程没机会写失败事务):新世代注册后,对旧世代 running 且 message 仍 pending 的 attempt 按 attempt_uid CAS 结算 crashed+retry_count+1,前提=旧进程已被探针确认死亡。
- **转化三出口**:快答(产出=outbox 回复 command)/ 建 task 派发(产出=task 行+派发 command)/ 登记工作项(产出=工作项行+ack command)。「处理完成」=转化产出已提交(回复 command 已入 outbox,不是回复已送达)。处理=转化不背活:长活由 task 层追踪。
- 防丢防重三支柱:同一事务 / 幂等键(message_uid;外发 effect_key)/ generation fence(全部 agent 写带谓词)。

### 4.2 公平性(§1.2e/§1.2f)

- 四路候选各 LIMIT 1:F1/F2(founder immediate/scheduled)、N1/N2(非 founder),应用层在 ≤4 条候选中选 1。
- **选择算法需要本设计给出精确伪码**(设计链只给了原则):候选分两类 —— founder 类 = F1/F2 + **晋升的**非 founder 候选(created_at 超 30min);非 founder 类 = 其余 N1/N2。K=4 配额:连续 founder 类选择满 4 条且存在 ready 非 founder 类候选 → 必选非 founder 类最老一条。类内择序(immediate vs scheduled 跨池比较)设计链未钉,plan 里给确定性规则并说理。
- 配额=进程内计数器,重启保守恢复为「预算已耗尽」(有 ready 普通消息则首选之),永不增加欠账。
- SLA 唯一公式:A=1+S×(K+1),S=(q−1)×5+R;T(q,R) ≤ T_tick + A×(T_deliver_tot+T_max+T_switch) + (R−1)×(T_due_cap+T_tick);默认参数 q=1,R=5 = 585min。验收=参数化断言(测试用缩小的时间参数)。
- 活性定性保证:配额+晋升无饿死;深积压由 admission+超龄告警暴露(告警归 1501)。

### 4.3 活性保证(§1.2b)

- 门铃只降时延不承担活性。活性三机制:注册必拉 / Lead 30s 周期 pull / 到点调度(due scheduler:kernel 持久调度器在最早 next_retry_at 触发该收件人 pull —— 显式失败的重试不依赖新流量)。
- **Runner 不依赖可丢 hint**:kernel timer(T_tick≤60s)实际查询 runner 的 ready mailbox,有 ready 行→durable deliver:经垫片 deliver(message_uid,payload) 注入 vendor 会话,带退避持续重试(T_deliver_tot≤5min 总 deadline)直至观察到该消息进入终态(applied/dead)或 runner activation terminal。deliver 可重复,消费幂等兜底。
- **终局收件人处置**:收件人永久消失/superseded 时,其 pending 由 kernel 单事务处置 —— business:原子改投 owning Lead(改 to_agent+事件)或 dead+decision event+obligation;notice:tombstone。

### 4.4 consumer registry 与 cutover(§1.2c)

- registry = meta 键空间 consumer_registry:agent,值 = discriminated AgentIdentity(批次1 已钉 schema:lead 三元组 / runner 四元组含 activationId)。
- 注册事务提交=唯一 cutover 点;authority 由注册事务定义,不由 apply 竞速定义。cutover 后旧世代所有写路径必败(fence)。
- 活着但卡死(超 T_max)的代际切换:必须先硬终止旧进程+探针确认 absent,再注册新 generation;禁止仅凭时间让活进程失权(租约 bug 的根)。
- admission(mailbox 入队):拒绝不可路由地址(无 registry 行的 to_agent 不收信)。

## 5. 台账 1:STAT4 公平分区翻盘 — 选项与推荐

**问题**(1497 QA 受控实验实证):ANALYZE 产生的 STAT4 直方图会让 planner 把 F2/N2 从 `_f`/`_nf` 公平分区索引改判到基础 scheduled 索引。不是正确性问题(结果集与顺序不变),但 founder 公平分区会悄悄退化成「扫过一堆非 founder 行才够到第一条 founder 消息」。

**本设计阶段已做受控 spike(2026-07-27,better-sqlite3 12.8.0 / SQLite 3.51.3,QA 实验同形态数据:3000 行/founder 1/7/25 收件人/1/3 scheduled)**,七项结论:

1. 无统计:F2→`_f`,N2→`_nf`(基线复现);
2. ANALYZE(stat1+stat4)后:**F2 翻到基础索引(翻盘复现)**,N2 此形态未翻(与 QA 表格一致:配比决定翻哪条);
3. **INDEXED BY 在同一统计下把 F2/N2 钉回 `_f`/`_nf`**,无 TEMP B-TREE;
4. SELECT 投影加 created_at 不改变 pinned plan(候选 SQL 修订安全,见 §7.2);
5. pinned 与 free 首选行完全一致(正确性等价);
6. 索引被删 → prepare 立即报 no such index(**fail-loud,正是想要的**);
7. 谓词与 partial index WHERE 不匹配 → no query solution 拒绝,不静默错行。

**选项**:

- **A(推荐):候选四条 SQL 加 INDEXED BY 钉死公平分区索引**。SQLite 官方对 INDEXED BY 的定位就是防 query-plan 回归;partial index 的 WHERE 已 byte-level 覆盖查询谓词(批次1 逐字合同);索引不可用时 fail-loud 而非静默退化。query-plan 验收升级为**带统计信息矩阵**:{无统计 / 完整 ANALYZE / 对抗数据形态} × 四候选,断言恒命中 `_f`/`_nf`。这是对 §1.2f 的显式设计修订,走 D14 先例(修订可审计,snapshot 断言 diff)。
- B:接受 planner 自由 + 只做带统计断言(观察性)。否——「fairness 分区可能悄悄不再被使用」正是台账要求消除的,观察不消除。
- C:维护纪律「本库永不 ANALYZE」。否——负不变量脆弱;SQLite 官方推荐的 PRAGMA optimize 会跑 ANALYZE,未来任何维护代码引入即破防;靠「永远没人做某事」的保证与本设计 fail-closed 哲学相悖。
- D:调整索引列顺序/改索引形状。否——spike 已证 INDEXED BY 达成同一目的,改索引形状是更大的修订面、更多重验,收益为零。

### 5.1 台账 1 的连带修订:候选 SQL 投影加 created_at

30min 超龄晋升需要比较非 founder 候选的年龄;现候选 SELECT 只投 seq,message_uid,payload。修订:四条候选投影加 created_at(spike 第 4 项已证不影响 plan——这些不是 covering index,行读取本来就发生)。与 INDEXED BY 一并作为 §1.2f 修订提交 design review;批次1 的 byte-for-byte snapshot 合同同步更新(修订前后 diff 精确刻画,同 D14 手法)。

## 6. 台账 2:写入面 SQL 守卫 — 按反 over-reaction 判定

**问题**(1497 两轮绕过实证:前导分号族/EXPLAIN 外壳/注释分隔):关键字层守卫与 SQLite tokenizer 的分歧就是洞;1497 §7.4 已把「守卫防事故不防攻击」写成显式合同,并把结构性根治(写入面不接受裸 SQL)记入本单台账。重问:继续加固关键字层 vs 类型化操作?

**反 over-reaction 检查**:
- 已枚举场景 = 批次 2+ **我们自己的引擎代码**在写事务回调里误用 COMMIT/PRAGMA/SAVEPOINT 类语句。误用是无意的、不伪装。
- 对无意误用,现有关键字层**已经足够**(不伪装的 COMMIT 字面量会被拦);两轮绕过全是对抗性构造,在守卫声明范围之外。
- 所以「继续加固关键字层」**不做**(追对抗变体=投错地方,1497 §7.4 已裁);「完整 per-table 类型化操作 API」**也不做**(三个并行批次都在写库,大 API 重做面,答不出哪个已枚举场景非它不可 = over-reaction)。

**推荐(中间态,成本≈一个 Set 查询):语句注册表(allowlist)**:
- v2-kernel 增加语句注册机制:引擎侧全部 SQL 以模块级常量注册(如批次1 CANDIDATE_SQL 先例);WriteTx.run/get/all/cas 只接受注册过的语句(按字符串身份校验),ad-hoc 字符串一律拒。
- 效果:把「守卫必须识别坏 SQL」(blocklist,两轮实证会漏)结构性翻转为「只放行已审计 SQL」(allowlist)。注册表就是 snapshot/EXPLAIN 测试的绑定点(候选 SQL 已是此形态)——同一机制同时服务台账 1 的 query-plan 矩阵。
- 关键字层守卫**保留**作为第二层(纵深,不再加固)。
- 诚实边界:JS 调用方仍可 tx.db.prepare 绕过(1497 已刻画的敞口),注册表防事故不防攻击——与 §7.4 合同一致,不改变威胁模型宣称。

**哪个已枚举场景需要注册表、根治为何不够**:场景 = 引擎代码(本批次起第一个真实写库消费者)手写 SQL 字符串时夹带连接状态语句;「根治」若指关键字层,1497 已实证它对分歧变体漏;注册表让这类语句根本进不了 prepare(不在注册集合)。若 founder 认为关键字层对无意误用已够、注册表也砍 —— 可砍,损失的是 allowlist 结构性保证,不损失任何已有行为(单列供裁决)。

## 7. 关键设计决策点(plan 要展开)

1. **包结构**:新包 packages/v2-engine(消费 v2-kernel 公开 API),零接线。理由:kernel 保持小(设计 §7 总裁决「kernel 保持 custom 但做小」);engine=§2 概念本就与 kernel 分层;新包验证 kernel 公开 API 是否自足。
2. **kernel 导出面扩展**(已核实 index.ts 现状):readRegistry/writeRegistry/identitiesEqual/FENCE 在 fence.ts 已实现但未导出 —— 批次 2 需要注册/cutover 事务与 CAS 模板。按需扩展导出面 + 更新批次1「恰等断言」测试(刻意、可审计)。加语句注册表时 WriteTx 合同同步修订。
3. **选择算法精确化**:四候选→分类(founder 类含晋升)→K 配额→类内确定性择序,完整伪码入 plan;每分支一条测试。
4. **due scheduler / kernel timer 形态**:批次 2 交付库内 timer 服务骨架(单实例互斥,与 retention/detector 同机制约定),due 调度+runner deliver 泵挂上;1501 的 detector tick 复用同机制。测试用注入时钟。
5. **T_max 监察归属**:kernel timer 观察 running attempt 的 started_at 超 T_max → 触发硬终止换代流程(硬终止+探针确认死亡本体在引擎外,批次 2 以接口+模拟测试交付,真硬终止接线归批次 3)。
6. **转化 proposal 类型**:vendor 产出只能以带 generation 的转化 proposal 提交 kernel(§2.4a);定义 ConversionProposal 判别联合(三出口),结算事务按出口写业务行。
7. **时间参数**:T_tick≤60s / T_deliver_tot≤5min / T_switch≤5min / T_due_cap=15min / T_max=10min 全部可配置,测试注入缩小值,SLA 断言按公式参数化计算。

## 8. 开放问题(brainstorm gate 提请 Lead 确认)

1. 台账 2 推荐「语句注册表」为 plan 主案(关键字层不加固、完整类型化 API 不做),可否?
2. 候选 SQL 显式修订(INDEXED BY + created_at 投影)偏离批次1「原样不得改写」措辞——按 D14 先例走「设计修订+snapshot 断言 diff+EXPLAIN 全矩阵重验」,可否?
3. 新包 packages/v2-engine + kernel 导出面按需扩展(更新恰等断言),可否?
4. 垫片接口(hint/deliver 类型定义)放 v2-engine 由 1501 实现方 import,还是放 v2-kernel?倾向 v2-engine(kernel 不该知道垫片)。与 1501 的 runner 需协调避免同名类型双定义。
