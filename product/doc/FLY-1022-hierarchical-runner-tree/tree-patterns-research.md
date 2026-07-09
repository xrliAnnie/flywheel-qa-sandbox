# FLY-1022 树/层级/分布式系统里可借的成熟机制 — grounded research

Issue: FLY-1022 (https://linear.app/geoforge3d/issue/FLY-1022/lead-scaling-one-lead-managing-many-runners-via-a-tree-hierarchical)
日期: 2026-07-08
基于: prd.md（同 issue）；Annie 要求把 PRD 里偏概念的 DDIA 段换成 grounded 机制 + 权衡 + 来源

> **目的**：Annie 觉得 PRD 的「DDIA 树聚合」太概念化。本文把 Lead→sub-lead→runner 树需要的每一块能力，
> 落到 DB / 分布式系统里**成熟、可直接抄的机制**上，每条给：**机制（怎么做）+ 权衡（代价）+ 来源 + 映射到我们的树**。
> 末尾 §9 收敛成「MVP 现在抄哪几条 / 哪几条只设计留位」——服从 Annie「别过度设计」红线。
>
> **深度声明（诚实）**：本文是 web-research + 领域综合，带具体机制/权衡/一手概念来源。**不是**一份 ChatGPT Deep Research
> 级的学术长综述。若 Annie 要更深（形式化证明 / 完整 paper 综述），建议 Lead 用 deep-research skill 补一轮喂回（§10）。

---

## 0. 一句话结论

我们要的树，**不用发明**——它是四类成熟机制的组合，每类都有几十年的 DB/分布式实践：
**① 部分聚合上汇（partial aggregation）· ② 两级调度委派（two-level scheduling）· ③ 子树故障隔离（bulkhead / cell）·
④ 背压 = 容量信号（backpressure）**。外加两条「什么时候加/合并/分配 sub-lead」的机制（**B-tree 分裂合并 + 一致性哈希**）
作**设计留位**、MVP 不上。**观测**那半边（谁卡了）用 **SWIM「susp疑-再判死」** 的思路喂回 942。

---

## 1. 部分聚合上汇（partial aggregation / tree aggregation）—— 健康/负载往上压缩

**机制**：叶子产出局部结果，**中间层先做部分聚合**，只把聚合值往上送，**对数轮**收敛到顶。
- Spark `treeReduce` / `treeAggregate`（Spark 1.1+）：数据在一小批 executor 上**分层部分聚合**后才送 driver，
  driver 负载**大幅下降**，partition 之间以**对数轮数**通信。
- MapReduce **combiner**：map 侧先聚合再送 reducer，减少 I/O。**rack combiner** = 在机架交换机层做**分层 fan-in 聚合**。

**权衡（关键，直接约束我们的 schema）**：combiner/部分聚合**只对 associative + commutative 的聚合函数成立**（sum/max/count），
**不能**无损上汇「需要完整明细才能算」的东西。→ 顶层 Lead 拿到的**必然是有损摘要**；细节留在下层。用**中间层的内存/算力**换**顶层的 I/O（注意力）**。

**映射到我们的树**：sub-lead 把「本组 N 个 runner」压成一个**可结合聚合**：`{running, parked_ok, needs_founder, stuck}` 计数 +
一个**冒泡上来的少数异常个案**列表。**PRD §9 的健康摘要 schema 必须是这种 associative aggregate**（计数 + 异常列表），
不能是「把每个 runner 的原始 pane 往上堆」。这就是「压缩层」的**精确**含义。

**来源**：[Spark treeReduce/treeAggregate](https://umbertogriffo.gitbook.io/apache-spark-best-practices-and-tuning/rdd/treereduce_and_treeaggregate_demystified) · [MapReduce combiner / rack combiner](https://data-flair.training/forums/topic/what-is-combiner-in-mapreduce/)

---

## 2. 两级调度委派（two-level scheduling）—— Lead 委派给 sub-lead

**机制**：把「资源分配」和「任务放置」拆开。资源管理器把资源 offer 给多个独立的 framework 调度器，各自定制策略。
- **Mesos**（首创两级）：resource manager offer 资源给 app 级 framework 调度器 → 每个 framework 自己决定放置。
- 对比 **Borg / Kubernetes**（monolithic）：单一逻辑端点、全局视图，但单调度器是瓶颈/复杂点。**Omega**：共享状态 + 乐观并发。

**权衡（必须写进 PRD 当已知代价）**：两级的代价 = **下层 framework 看不到全局放置选项**，只看到被 offer 的那部分 →
**跨组优先级抢占 / 全局最优很难做**；资源囤积还可能 gang-schedule 死锁。**委派 = 顶层放弃全局视图换可扩展。**

**映射到我们的树**：Lead = resource manager，把活 offer/派给 sub-lead（= framework 调度器），sub-lead 自己安排它那摊。
**已知代价**：root Lead **失去对单个 runner 的全局细粒度视图**（跨组优先级、抢占难）——这正是**为什么 MVP 只做一层、
且跨组协调仍回到 root/founder**。**这条权衡是 PRD 该诚实列的，不是 bug 是设计取舍。**

**来源**：[Mesos, Omega, Borg: a survey (umbrant)](https://www.umbrant.com/2015/05/27/mesos-omega-borg-a-survey/)

---

## 3. 子树故障隔离（bulkhead + circuit breaker + cell）—— 检测 + 隔离卡住的子树

**机制**：
- **Bulkhead（隔舱）**：把资源分成独立池，一处失败不耗尽全局，**限制爆炸半径（blast radius）**。
- **Circuit breaker（熔断）**：某依赖反复失败 → **跳闸、停止再打**，防级联、优雅降级。
- **Cell-based architecture**：blast radius = **1/N**（N=cell 数）→ 可靠性变成一个**可调的 scaling 旋钮**，不是靠某次工程突破。

**权衡**：**隔离限制爆炸半径，但降低利用率**（被隔开的空闲 slack 不共享）。

**映射到我们的树**：每个 sub-lead 的**子树 = 一个 bulkhead / cell**。一个 runner（或整组）卡住/出错，被隔在该子树内，
**不级联**到兄弟组或 root。**circuit breaker** = 如果**某个 sub-lead 自己**冻住/失联，root 可以「跳闸」它——重路由或直接升级到 founder，
而不是干等。**这就是 Lead 说的「检测 + 隔离卡住子树」的成熟对应**。代价（利用率↓）对我们可接受——注意力隔离本就是目的。

**来源**：[Azure Bulkhead pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead) · [Cell-based architecture / blast radius](https://mayankraj.com/blog/cell-based-architecture-blast-radius-containment/)

---

## 4. 背压 = 容量信号（backpressure）—— 过载沿树往上传，喂回 353

**机制**：下游处理不过来 → **向上游发信号让它减速**，不是让队列无界膨胀。
- **Reactive Streams**：subscriber 主动 request N 个；跟不上就 backpressure 上游降速（Reactor/Akka/RxJava）。
- **Queue-based load leveling**：用**有界**缓冲削峰；**无界缓冲会 OOM/级联失败**。

**权衡**：背压**故意压低过载时的吞吐**换不崩溃。

**映射到我们的树（⭐ 跟 353 的精确接缝）**：sub-lead 饱和（它那摊到容量）→ **向上发背压** → root Lead / **353 派发器停止往这个子树派新活**。
**sub-lead 的饱和信号，就是 353 capacity-aware 派发要消费的容量信号**——这把 1022 的树和 353 的流控**用一个具体机制接上了**
（不是两套东西，是背压信号在两层之间流动）。约束：sub-lead 的待办**必须有界**，不能无界堆。

**来源**：[Reactive Streams backpressure](https://codelit.io/blog/backpressure-flow-control) · [Back pressure in distributed systems (GfG)](https://www.geeksforgeeks.org/computer-networks/back-pressure-in-distributed-systems/)

---

## 5. 可扩展故障检测（SWIM / gossip）—— 观测半边喂回 942，防误报

**机制**：**SWIM**（Das/Gupta/Motivala 2002）= outsourced heartbeat + gossip 传播。
- **可扩展性**：检测时延、误报率、每进程消息负载**与组大小无关**（传统 heartbeat 是 O(N²)）。传播时延随成员数**对数**增长。
- **⭐ suspect-before-declare**：先「怀疑」一个进程、再「宣告」死亡 —— **降误报**。

**权衡**：gossip = 弱一致（失败要几轮才传到顶）——对我们**异步 + 人在环**完全可接受。

**映射到我们的树（喂回 942）**：
- 树 + 逐层上报 = 一个**分层故障检测器**。**suspect-before-declare** 正对 942/FLY-218/220 的**误报**痛点：sub-lead 先 suspect
  （对该 runner 加一档观察）、确认才升级——不一有静默就顶到上层。
- **对数传播** = 就算 50+ agent，卡住信号升到 root 的时延仍低。
- **每进程负载与组大小无关** = 加 sub-lead / runner 不会让检测负载 O(N²) 爆——**这是树观测能 scale 的理论依据**。

**来源**：[SWIM 协议 (Wikipedia)](https://en.wikipedia.org/wiki/SWIM_Protocol) · [SWIM paper (Das/Gupta/Motivala)](https://www.semanticscholar.org/paper/SWIM%3A-scalable-weakly-consistent-infection-style-Das-Gupta/068f65c0271ed16a6bf4a1c2de1a962eec08edbf)

---

## 6. 何时加/合并 sub-lead（B-tree 分裂/合并）—— 设计留位，MVP 不自动

**机制**：B-tree 靠**大 fan-out**保持浅而快；节点满 → **在中位数分裂**成两个；占用率跌破阈值（underflow）→ **合并或借**兄弟节点。
- Postgres 为并发**不做** underflow 合并；MySQL 后台离线做。

**权衡**：分裂/合并有 churn；频繁增删会 thrash → 实践用**滞回阈值**（高水位分裂、低水位合并、中间留 gap）避免抖动。

**映射到我们的树**：sub-lead = 有容量（≈5-6 runner）的树节点。**超容量 → 分裂**（起一个新 sub-lead、把一半 runner 挪过去，中位数分割保平衡）；
**两个都低于阈值 → 合并**（并一个、退休另一个）。**MVP 手动/配置，不自动分裂合并**（避免 thrash + 复杂度）；这条是**设计留位**、later。

**来源**：[B-tree (Wikipedia)](https://en.wikipedia.org/wiki/B-tree) · [B+tree underflow: merge or borrow](https://jacobsherin.com/posts/2025-08-16-bplustree-compare-borrow-merge/)

---

## 7. runner 分到哪个 sub-lead（一致性哈希 + 虚拟节点）—— 设计留位，MVP 静态

**机制**：一致性哈希——加/删一个节点只重映射 **~K/N** 的 key（朴素取模要重映射 ~99%）。**虚拟节点**（如 128/节点）→ 负载标准差压到均值的 5-10%，
且加节点时**从多个节点各拿一小片**，而非从一个邻居拿一大片。

**权衡**：环 + vnode 的**元数据复杂度**；我们只有一小把 sub-lead 时是**过度设计**。

**映射到我们的树**：把 runner 分给 sub-lead。**MVP 用简单静态/轮询分配就够**（sub-lead 数很少）；一致性哈希是**当我们要动态增删 sub-lead
又不想全体重洗**时的成熟机制——**设计留位、later**。

**来源**：[Consistent hashing / virtual nodes (Dynamo)](https://www.systemoverflow.com/learn/partitioning-sharding/rebalancing/hash-based-assignment-strategies-consistent-and-rendezvous-hashing)

---

## 8. 每个 sub-lead 该带多宽（fan-out 放大权衡，LSM 视角）

**机制/权衡**：LSM 的 leveled compaction，**写放大 = fanout**；fanout 越大 → 树越浅但每层聚合越重；fanout=2 → 写放大低但**层数翻倍、读时延翻倍**。
—— 一般的 fan-out 权衡：**宽（每 sub-lead 带更多 runner）= 树浅、升级跳数少、查任意 runner 状态快，但每个 sub-lead 聚合负担重**；
**窄 = 树深、跳数多**。

**映射到我们的树**：每个 sub-lead 带多少 runner = fan-out。**上界由「一个脑扛得住」定 ≈5-6**（人/agent 的注意力瓶颈，不是磁盘）；
所以我们的 fan-out 天然被**认知容量**钉在 ~5-6，不用调优到 128。**这条把「每 sub-lead 多宽」的直觉，接到了经典放大权衡上。**

**来源**：[LSM leveled vs tiered compaction / write amplification (RocksDB)](https://github.com/facebook/rocksdb/wiki/Compaction) · [Leveled compaction overview](https://fjall-rs.github.io/post/lsm-leveling/)

---

## 9. 收敛：MVP 现在抄哪几条 / 哪几条只留位（服从别过度设计）

| 机制 | 抄进 MVP? | 具体落到 1022 |
|---|---|---|
| **部分聚合上汇**（§1） | ✅ **MVP** | 健康摘要 schema = associative aggregate（计数 + 异常列表），对数深度上汇 |
| **子树隔离 bulkhead/cell + circuit breaker**（§3） | ✅ **MVP** | 每 sub-lead 子树 = 一个隔舱；sub-lead 自身冻住 → root 跳闸重路由/升级 |
| **SWIM suspect-before-declare**（§5） | ✅ **MVP（喂回 942）** | 逐层上报 = 分层故障检测；先 suspect 再升级，降误报（正治 FLY-218/220 病） |
| **背压 = 容量信号**（§4） | ✅ **MVP（接 353）** | sub-lead 饱和 → 背压上传 → 353 停派该子树；待办有界 |
| **两级委派的已知代价**（§2） | ✅ 写进 PRD 当**取舍** | 委派 = root 失全局细粒度视图 → 所以 MVP 只一层、跨组仍回 root/founder |
| **fan-out 放大权衡**（§8） | ✅ 写进 PRD | 每 sub-lead ~5-6（认知容量钉死 fan-out），不调到 128 |
| **B-tree 分裂/合并**（§6） | ⏸ **设计留位 later** | 何时加/合并 sub-lead 的机制；MVP 手动/配置，不自动（防 thrash） |
| **一致性哈希 + vnode**（§7） | ⏸ **设计留位 later** | 动态增删 sub-lead 不全体重洗；MVP 静态/轮询分配 |

**净收获**：PRD 的「DDIA 一句话」换成上面 8 条**带机制 + 权衡 + 来源**的具体设计，且**MVP 只抄 4 条 + 2 条取舍写清**，
其余 2 条明确 later —— 既 grounded 又克制。

---

## 10. ChatGPT Deep Research 已跑（2026-07-08）—— 独立印证 + 两条新增

按 Annie 要求真跑了一轮 **ChatGPT Deep Research**（『Hierarchical Command Trees for Autonomous Coding Agents』,
8 分钟 / **29 citations / 521 searches**,conversation `6a4f1346`）。它**独立**收敛到跟本文（web-research）**同一套 MVP-vs-later 判断**:

- **Executive 结论**:树 = **bounded-fan-out 聚合 + 监督层级**,不是加标签的平铺派发;最可借三处 = associative tree aggregation ·
  high-fan-out 平衡树 + minimal-movement hashing · backpressure + supervision。
- **⭐ 小规模（几十 agent）人在环最该先上 6 条**（= 本文 §9 MVP,DR 独立同批）:固定小 fan-out · typed associative summaries ·
  **带显式 credit 的有界队列** · 子树边界 circuit-breaker + bulkhead · **soft-suspicion-before-declare** · **Erlang 式 restart 策略**。
- **⭐ 此规模下通常过早**（= 本文 §9 later）:full gossip membership · heavy virtual-node hashing · LSM 式后台 compaction。
- **相对本文 web-research 的两条新增**:①『**有界队列 + 显式 credit**』(比『背压』更具体的容量语义,已并入 PRD §4A-4)②『**Erlang/OTP
  supervision tree**』的 restart-strategy 语言(one_for_one / restart intensity / let-it-crash,已并入 PRD §4A-9)。

**⚠️ 精确一手引用 URL 待补**:DR 报告在跨域 sandbox iframe(oaiusercontent OOPIF);自动导出被 synthetic-click 的 OOPIF hit-test
挡住(FLY-541,本机 headed 仍复现;坐标已标定证明 100% 准,click 落 IFRAME 元素但不入子帧)。→ 走人手 2 步 Export to Markdown
(真人手势能过 OOPIF)拿全文 + 29 条解析引用 URL,补进 §11。**substance 已先落地**(上面 + PRD §4A)。若还要更深(形式化/benchmark)可再跑一轮。

---

## 11. 参考（全部一手/权威来源）

- 部分聚合：Spark treeAggregate · MapReduce combiner
- 两级调度：Mesos/Omega/Borg survey (umbrant)
- 故障隔离：Azure Bulkhead pattern · Cell-based architecture (blast radius)
- 背压：Reactive Streams · Back pressure in distributed systems (GfG)
- 故障检测：SWIM protocol (Das/Gupta/Motivala 2002)
- 树节点分裂/合并：B-tree (Wikipedia) · B+tree underflow merge-or-borrow
- 分配/rebalance：Consistent hashing + virtual nodes (Dynamo)
- fan-out 权衡：LSM leveled vs tiered compaction (RocksDB) · DDIA（《Designing Data-Intensive Applications》，聚合树/背压/分区章节，作总纲对照）
