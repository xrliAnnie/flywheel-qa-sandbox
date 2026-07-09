# FLY-1022 — ChatGPT Deep Research 待跑简报(给 Lead / Annie 交互 session 跑)

Issue: FLY-1022 (https://linear.app/geoforge3d/issue/FLY-1022/lead-scaling-one-lead-managing-many-runners-via-a-tree-hierarchical)
日期: 2026-07-08
基于: tree-patterns-research.md(我已做的 web-grounded 一轮);Annie §10 明确要「让 Runner 在 ChatGPT 上做 deep research」

> **为什么这份简报交给你跑**:Annie 明确要一份 **ChatGPT Deep Research** 级别的深度(尤其 DDIA / 经典 data structure /
> database 怎么建树)。我(headless Runner)**无法安全驱动** ChatGPT Deep Research —— claude-in-chrome 强制一步交互式
> 「选浏览器 + 点 Connect」配对(headless 无人可点、会挂),且会抢占 Annie 正在用的 Chrome(deep-research 单客户端/串行)。
> 探测确认:本机有 1 个已连 Chrome,但上述交互限制在。→ 按你 gate 的 offer,这轮 ChatGPT DR 由**你的交互 session / Annie** 跑。
> **下面是可直接粘贴进 ChatGPT Deep Research 的 prompt**;跑完把结果喂回我,我 fold 进 tree-patterns-research.md + PRD §4/§5。

---

## 可直接粘贴的 ChatGPT Deep Research prompt(英文,DR 对英文源更全)

```
I'm designing a HIERARCHICAL COMMAND TREE for managing many autonomous AI coding agents
("runners"). A manager ("Lead") delegates to sub-managers ("sub-leads"); each sub-lead
oversees a handful of runners; the Lead sees only COMPRESSED SUMMARIES, not every runner's
detail. The problem: a single manager's attention/context grows O(N) with the number of
runners it directly oversees, and degrades past ~5-6.

Do a grounded survey of what CLASSIC DATA STRUCTURES and DATABASE / DISTRIBUTED-SYSTEMS
designs (especially as covered in "Designing Data-Intensive Applications" / DDIA) teach us
about BUILDING and OPERATING such a tree. For EACH pattern give: (1) the concrete mechanism,
(2) the key tradeoffs (quantitative where possible), (3) authoritative primary sources
(papers / books / official docs, not blogs), and (4) how it maps to our Lead→sub-lead→runner
tree.

Cover at least:
1. How databases BUILD and BALANCE trees: B-tree / B+tree fan-out (branching factor), node
   SPLIT on overflow, MERGE / borrow on underflow, why large fan-out keeps trees shallow —
   and what this implies for "WHEN to add / merge a sub-lead" and "HOW WIDE each sub-lead
   should be."
2. LSM-trees & compaction (leveled vs tiered), write / read / space amplification, level
   fan-out — as a lens on the tree-depth vs per-node aggregation-cost tradeoff.
3. Hierarchical / tree AGGREGATION & rollup: partial aggregation, MapReduce combiners, Spark
   treeAggregate, in-network aggregation — for rolling health / load summaries UP the tree;
   and the ASSOCIATIVITY constraint on what can be losslessly aggregated.
4. Assigning items to sub-trees & REBALANCING: consistent hashing, virtual nodes, rendezvous
   hashing — minimal-movement rebalance when sub-leads are added / removed (quantify key
   movement, e.g. ~K/N).
5. Hierarchical / two-level SCHEDULING & delegation: Mesos two-level, Borg, Omega, YARN —
   delegation tradeoffs, especially loss of the top scheduler's global view / preemption.
6. Scalable FAILURE DETECTION at scale: SWIM, gossip / epidemic dissemination, phi-accrual
   failure detectors, hierarchical failure detectors — detecting silently-stuck nodes WITHOUT
   O(N^2) load; suspect-before-declare to cut false positives.
7. FAULT ISOLATION / blast-radius containment: bulkhead, circuit breaker, cell-based
   architecture — isolating a stuck SUB-TREE so it doesn't cascade to siblings or the root.
8. BACKPRESSURE / flow control: reactive streams, queue-based load leveling — propagating
   overload UP the tree so the dispatcher stops feeding a saturated sub-tree.

End with a SYNTHESIS: for a SMALL (tens of agents), human-in-the-loop agent tree, which of
these patterns are DIRECTLY applicable now vs which are overkill / premature, and why. Favor
primary sources; include quantitative tradeoffs wherever the literature gives them.
```

---

## 我已 grounded 的部分(DR 应在此之上加深,别重复)

我 web-research 已覆盖并落到 PRD 的 8 条(`tree-patterns-research.md`):部分聚合(Spark treeAggregate/combiner)·
两级调度(Mesos)· bulkhead/cell+熔断 · 背压(Reactive Streams)· SWIM 先疑再判死 · B-tree 分裂/合并 · 一致性哈希+vnode ·
LSM leveled/tiered。**DR 的增值点** = 一手 paper 的形式化保证 + 定量权衡 + DDIA 章节精确对应 + 「小规模 agent 树该抄哪些」的权威判断。

## 结果回来后我做什么

把 DR 报告 fold 进 `tree-patterns-research.md`(升级每条的来源到一手 paper + 定量)+ 复核 PRD §4/§5 的机制选择是否要调 →
再发你 QA → relay Annie。
