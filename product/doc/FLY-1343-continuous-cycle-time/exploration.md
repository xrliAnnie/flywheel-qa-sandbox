# FLY-1343 持续周期时间采集与分析 — 探索

Issue: FLY-1343 (https://linear.app/geoforge3d/issue/FLY-1343/prdhl-per-issue-cycle-time-持续研究-并发-load-周期时间采集与分析)
日期: 2026-07-17
基于: 无

> **重心重定向(Annie,2026-07-17 看样子稿后)**:形状(四视图)她认可;PRD 文字重心收窄为**记录 + 展示** —— 不重做「为什么慢」诊断(Tadashi 已研究过)。PRD 主体三章 = ①记录机制 + ②Dashboard + ③每日报告集成。本探索里的诊断结论(空转主导 / 机制 vs 执行)自此作**背景与动机**,不是主线。详见 prd.md。

## 1. 问题定义

**触发点(Annie 原话,[FLY-1327] thread)**:「我确实有点想去研究说,我们每一个 issue 到底都在花多少时间」。最近每张单跑得都长 —— 例:FLY-1314 跑了十几个小时,她觉得不合理。

**要回答的核心问题**:一张 issue 从开单到 ship,墙钟时间到底花在哪个阶段(排队/设计/实现/审查/QA/等闸门/CI/重启损耗),并发数和机器 load 如何影响它 —— 好支撑治理决策:哪里砍、哪里并行、哪里自动接力。

**关键定性**:这是**常驻机制**,不是一次性分析。FLY-1327 已经做过一次快照诊断(七大瓶颈 + 节省测算),回答了「这四个样本此刻慢在哪」;FLY-1343 要的是「持续看见每张单、修复上线后能在曲线上及时看到变化、并能从图上继续发现机制不合理处」。

**核心用户故事**:Tadashi 修了一个机制,几天内曲线上能看到效果。

## 2. 与 FLY-1327 的关系(接缝完全咬合)

FLY-1327(PR #630,分支 flywheel-FLY-1327,尚未合入 main)已建好一整套 **按 issue 传参 · as-of 快照 · 一次性** 的分析工具(纯函数、已测):5 源采集 → 主线归段 → 归类 → 机制vs执行裁决。它生成的 7 条优化建议里:

| 建议 id | 内容 | 对应 |
|---------|------|------|
| halve-ci | CI 分层+并行砍半 | **FLY-1338 CI 砍半** |
| review-loop | review 发现前移减返工 | **FLY-1340 review 前移** |
| handoff-gap | 自动接力 phase handoff / park wake | **FLY-1339 handoff 接力** |
| infra-recovery | 重启 / gate 恢复事务化续跑 | **事务化续跑单** |
| minimize-head-churn | 冻结 head 减 churn 重跑 | (旁支) |
| doc-only-fast-path | doc-only 轻量路径 | 无法测量·需先采集 |
| **concurrency-telemetry** | **持续采集并发×load×周期时间** | **= FLY-1343 本身** |

即:**FLY-1327 报告的第 7 条建议字面上就是 FLY-1343,前 4 条就是 Annie 已拍的四个改进单。** 当时因单日 4 样本不满足门槛,并发×load 部分判「样本不足以定量,建议持续采集」—— 这正是本机制要回答的问题。

所以 **FLY-1343 ≠ 重写方法学,= 把这套一次性诊断变成常驻机制**,补三个「一次性 → 持续」的缺口:

1. **持续触发** —— 谁、多久、对哪些 issue 自动跑(1327 要手工 `--issues X,Y,Z --as-of now`)。
2. **持续存储** —— 每次结果落库累积成时间序列,而不是每次重算全历史。
3. **常驻呈现** —— 在 dashboard 上看趋势 + 改进单前后对比,而不是每次产一张孤立 HTML。

## 3. 现状与真实数据(本探索已真机跑出,非推测)

用 FLY-1327 已测采集工具(只读快照)真机跑了 8 张真实 issue(2026-07-17 as-of):

| Issue | 状态 | 墙钟 | 大头 |
|-------|------|------|------|
| FLY-1252 | Done | 57h52 | 空转 40h23(双 PR + QA 换人,大量等待) |
| FLY-1272 | Done | 45h03 | 空转 39h32 |
| FLY-1307 | Done | 32h26 | QA 运行 25h(R8+ 返工重测) |
| **FLY-1314** | **In Progress** | **23h25(在跑)** | **空转 19h16,真正工作仅 1h56** |
| FLY-1319 | In Progress | 16h20(在跑) | 工作 10h56(真长活) |
| FLY-1333/1334 | Backlog | 9h52 各 | 干完后空等 8h+(工作仅 30-40m) |
| FLY-1309 | Done | 9h06 | 相对均衡(顺畅样本) |

**头号发现**:8 单合计,**空转/排队等待(idle_gap)= 125h46,占 62%**,远超 QA(41h)、返工(2h49)、CI(2h40)。整体裁决 = **慢主要在机制,不在执行**(verdict=mechanism)。

这坐实了 Annie 的直觉:「跑十几小时不合理」的真相不是活多,是**大量墙钟在排队 / 阶段交接 / park 等唤醒 / 干完空等下一步**。直接指向改进单 1339(handoff 自动接力)+ 事务化续跑。

> 诚实边界:「空转」当前含「等 founder ship / 合理睡觉等待」与「机制卡住」两类,进一步拆分是 PRD 要细化的度量口径,不能让机器饱和或合理夜间等待冒充机制成本。

## 4. 核心方法学复用(不重造)

FLY-1327 的以下产物**原样复用**,FLY-1343 不重新发明:

- **主线归段**(不重叠时间轴,Σ段=墙钟):优先级 `infra_incident > gate_waiting_human > rework_loop > qa_running > review_running > ci_waiting > working > idle_gap > unmeasurable`。
- **归类**:working=价值工作;review/qa/ci=必要流程;idle_gap/infra=机制浪费;rework=执行浪费;gate=等人;unmeasurable=不可测。
- **裁决**:机制 vs 执行(pooled + median share,阈值 coverage 0.8 / dominance 0.3)。
- **诚实不变量**:段和=墙钟(I2)、测不到=unmeasurable 不编数(I3)、可溯源(I4)、in-flight 用 as-of 截断不进已完成占比。

FLY-1343 的新增只在「触发 / 存储 / 呈现」三层的工程外壳,方法学内核不动。

## 5. 数据源取舍(Q2,已核实)

Issue brief 说「首选 DAG 节点耗时(FLY-1307 天然落库)」。真机核实后的更准确判断:

- FLY-1307 的 DAG 节点耗时落在 `workflow_run_node`(run_id/node_id/execution_id/started_at/ended_at,耗时需 `ended_at − started_at` 现算)+ `workflow_run_event`(node_dispatched/node_completed/gate_opened…)。
- **但它是与 sessions/session_events 并行的一套新系统**,只对**真正走 DAG 编排**的 issue 落数;当前多数 issue 仍是单节点 monolithic runner,`workflow_run_node` 不覆盖。
- 而 Annie 要的富分解(gate 等人 / CI / review 轮 / rework / load)靠的是 FLY-1327 的**五源融合**(Linear 生命周期 / teamlead sessions+events+review+QA / CommDB 闸门+唤醒 / GitHub PR+CI / system-health load)。

**结论(Honey Lemon 已认)**:采集引擎**复用 1327 五源 extractor**(它已含节点耗时所在的 sessions/events);DAG 的 `workflow_run_event`(gate_opened/node_completed)作为**随 DAG 采用率增长而增强分段的补强源**,不作替代。PRD 数据源节要把「为什么不是只用 DAG」讲清,防止工程侧走回头路。

## 6. 方案选项

- **A. 独立 cycle-time 日报(cron + publish-report + Discord)** —— 同 FLY-614 token 报告形态。省,但多一个会**静默退化**的 cron(614 今早刚被抓到回归),且不满足 Annie「常驻可及时观察」的诉求。不作主选。
- **B. 管理台「时间线」常驻页签(推荐,Annie 已定)** —— 在现有管理台(Bridge GET / :9876,复用 FLY-1038/1262)加一个 Cycle-Time 页签,四视图常驻:每单时间线 / 趋势前后对比 / 并发×load / 瓶颈排行。live 呈现,坏了立刻看得见(天然抗静默退化),满足「修复上线曲线及时反映」。
- **C. 折进已有每日 digest(FLY-727)当一节** —— 抗静默退化(一份报告不是两份),但是快照式非 live,不满足「常驻可交互观察」。作为 B 的补充(趋势摘要可同时进 digest)。

**推荐 B(管理台时间线页签),C 作补充。** 呈现层不再是开放问题 —— Annie 明确要 dashboard 常驻。

## 7. Brainstorm gate 結論(Honey Lemon,2026-07-17)

Gate PASS。五问全答:

- **Q1 最小集** = 窄 MVP。够验证四个改进单 + 撑起视图 A/B/D 就收口;七类全谱系写进「演进」节。每加一段度量必须写明它支撑哪个决策。
- **Q2 数据源** = 认(五源引擎 + DAG 事件补强,§5)。
- **Q3 数据鲜度** = 收口增量 + dashboard 读缓存;in-flight 单走轻量 as-of 现算(几分钟级 tick 或页面加载现算),写清成本边界,别让 in-flight 把「收口增量」拖回全量重算。
- **Q4 不烂自检** = 硬需求。采集失败/覆盖率低于阈值 → 页面显式「数据不可用+原因」+ 报警,绝不静默出空/旧图(614 教训,不可谈判)。
- **Q5 in-flight 可见** = 要。正在跑十几小时的 1314 是这个 dashboard 的情感核心,标「进行中(as-of 截断)」。

**北极星写法(两层分开)**:
- 产品北极星 = 每单周期时间(中位)下降 + 机制浪费占比下降。
- dashboard 自身成功指标 = 一次机制修复能在 ≤N 天内在视图 B 曲线上被肉眼辨认。

**流程(mockup-first)**:① 第一交付物 = 低保真样子稿 HTML(真实数据,已交付,见 mockup.html)→ HL publish 给 Annie 过形状;② 并行写 exploration/research;③ 形状 OK 后才写 prd.md 正文;④ Tadashi 的「为什么长/怎么修」想法进 research 必收节。

## 8. 风险与开放问题

1. **「空转」口径**:等 founder ship / 合理夜间等待 vs 机制卡住,PRD 要给可执行的拆分口径(或至少显式分层标注),否则会高估机制浪费。
2. **DAG 覆盖率**:补强源随 DAG 采用率增长才增值;MVP 阶段主要靠五源,PRD 要说清演进路径。
3. **存储形态**:新表累积 per-issue 段汇总 vs 每次全量重算 —— 幂等 + 收口增量是关键,in-flight 单不能拖垮。
4. **Tadashi 想法未到**:research 留接口,待 HL 转来。
5. **样本量**:并发×load 的甜点并发数需持续采集满足门槛后才定量,MVP 阶段诚实标「累积中」。
