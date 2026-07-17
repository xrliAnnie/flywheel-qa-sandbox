# FLY-1327 issue 周期时间分解 — 探索

Issue: FLY-1327 (https://linear.app/geoforge3d/issue/FLY-1327/分析-issue-周期时间分解-时间都花在哪-机制优化建议annie-直令)
日期: 2026-07-16
基于: 无

## 1. 问题定义

Annie 直令(2026-07-16 ~22:41 PDT):「给我画个图,展示比较长的时间都花在什么地方,哪些地方可以优化…拿两三个典型 issue 做时间分解…我觉得我们现在好像有点不合理的慢,是不是机制设计的不太合理?」

要回答的核心问题:**一个 issue 从开始到 Done 的墙钟时间,分解到段之后,大头在哪?慢是机制设计造成的,还是执行造成的?** 数据驱动,不许估。

产出三件:
1. 一页可视化 HTML(Apple 浅色风):每个 issue 一条横向分段时间轴 + 全样本汇总占比图。
2. 优化建议清单:每条按互动评审模板做成可勾选项(建/不建 + 评论框 + copy-export),标注预期节省 + 实施成本。
3. 一句话结论:慢的是机制还是执行。

交付:publish-report 进本 issue thread(由 Lead 侧投递纪律约束,实施阶段按当时规则执行)。

## 2. 样本(对比组,Annie 指定)

| Issue | 角色 | 特征 |
|-------|------|------|
| FLY-1309 | 顺畅样本 | Backlog→Done ~9h,一次过 |
| FLY-1307 | 重返工样本 | review 跑到 R8+,双 PR |
| FLY-1319 | 被基建坑的样本 | 重启杀 session + QA FAIL 返工 |
| FLY-1252 | 双 PR + QA 换人样本 | 两轮 design,QA 换 session |

**已核实的现状(2026-07-17 ~06:00 UTC 快照)**:FLY-1309 全链路已完成;FLY-1307 / FLY-1319 / FLY-1252 仍有 QA / review 环节在跑。→ 分析必须做「as-of 快照」:实施时取当时数据,仍在进行的段显式标「进行中」,不算进已完成时长的占比结论。

## 3. 数据源核实(本探索已逐一真机验证,全部可查)

| # | 数据源 | 位置 | 能测什么 | 核实结果 |
|---|--------|------|----------|----------|
| 1 | sessions 表 | `~/.flywheel/teamlead.db` | 每个 phase session(design/implement/qa 分角色)的 started_at / terminal_at / status / session_stage / pr_number | ✅ 4 个样本 issue 共 23 条 session 记录 |
| 2 | session_events 表 | 同上 | stage_changed(分钟级阶段切换)、qa_result、session_started/completed、checkpoint_park_nudged、founder_ship_reply_waked、three_stage_fix_round 等 26 种事件 | ✅ 4 issue 合计 500+ 条事件 |
| 3 | codex_review_job 表 | 同上 | cross-family review 每轮 created_at / responded_at / verdict(APPROVED/CHANGES_REQUESTED)/ failed | ✅ FLY-1252 可见 8+ 轮、FLY-1307 可见 10 轮含 2 次 failed |
| 4 | CommDB messages 表 | `~/.flywheel/comm/flywheel/comm.db` | gate 等待:checkpoint(brainstorm/review_code/approve_to_ship)question created_at → response created_at | ✅ 含样本 issue 的 gate 问答对 |
| 5 | gh PR + gh run list | GitHub API | PR createdAt/mergedAt;每轮 CI run 的 createdAt→updatedAt 时长与结论 | ✅ PR #620:4 轮 CI,单轮 3~17.5 分钟 |
| 6 | Linear stateHistory | Linear GraphQL(`LINEAR_API_KEY` 在 `~/.flywheel/.env`,已确认存在) | Backlog→In Progress→In Review→Done 状态时间戳(外部视角的 T0/T_end) | ✅ key 存在;GraphQL history 查询实施阶段验证 |
| 7 | auto_qa_record 表 | teamlead.db | 每次独立 QA 的 started_at / completed_at / status / retry | ✅ schema 核实 |

**时区**:所有 DB 时间戳为 UTC(`datetime('now')`),报告统一换算 PDT(Annie 本地)展示。

## 4. 核心方法学问题:并行活动怎么归段

时间分解最大的坑:CI、review、QA 可能与编码并行。若各段独立求和,总和会超过墙钟,占比失真。

**决定:主线归段(mutually-exclusive timeline segmentation)**。把 issue 生命周期([T0, T_end])切成**不重叠**的连续区间,每个区间按「当时的主导等待/活动」打唯一标签;并行的次要活动作为区间的附注(evidence),不重复计时。这保证 Σ段时长 = 墙钟,占比图诚实。

主导标签优先级(区间同时有多个活动时,取最能解释「为什么还没往下走」的那个):

```
基建事故(session 被杀/重启/gate 绑定 bug 修复期)
  > gate 等人(founder approve / lead brainstorm 答复)
  > 返工循环(CHANGES_REQUESTED→fix→re-review / QA FAIL→fix→re-verify)
  > 独立 QA 运行中
  > cross-family review 运行中
  > CI 等待(head push 后 CI 未绿且无其他活动)
  > 编码/design 工作中(session active 且 stage 在干活)
  > 空转 gap(无任何活动:段间 handoff、park 等 wake、排队等 dispatch)
```

具体判定规则表在 plan 阶段细化成可执行算法;每个区间必须能溯源到具体记录(event id / review round / CI run id),报告里可展开看证据。

**「无法测量」预告**(诚实原则,报告里显式标注):
- implement session 内部「纯写码」vs「本地跑测试」vs「等内部子步骤」分不开 —— 只能给整段「implement 工作中」。
- Lead 人工转发/决策的思考时间与 Bridge 自动流转分不开的部分。
- founder 夜间不在线:gate 等人段会按 PDT 时段标注「夜间」,但「合理的睡觉等待」vs「白天漏看」只能标注不能裁决。

## 5. 方案选项

**A. 纯手工 SQL + 手写 HTML(一次性)** — 最快,但数字不可复现、无法溯源、下次想看别的 issue 要重来。违背「不许估」的精神(手工汇总最容易出错)。不建议。

**B. 参数化分析脚本 + 数据快照 + 静态 HTML(推荐)** — 一个 Node 脚本(repo 内,如 `scripts/cycle-time-report.mjs`)输入 issue 列表,从 6 个源抽数 → 生成中间 JSON(每 issue 的 segments + evidence)→ 渲染单页 HTML。中间 JSON 与 HTML 一起落 doc 文件夹 commit,可审计可复跑;以后任何 issue 都能重跑。成本比 A 略高,但这是「分析必须数据驱动」的最低可信形态。

**C. 常驻 dashboard(并进 FLY-1262 统一管理台)** — 超出本 issue 范围(Annie 要的是一次性的诊断 + 机制建议)。作为优化建议清单里的候选项提出(「周期时间持续监测」),本 issue 不建。

**推荐 B**:一次性诊断用可复跑脚本做,长期化交给建议清单让 Annie 勾选。

## 6. 产出设计要点

- **可视化**遵循 dataviz skill + 全局 HTML 报告规范(Apple 浅色、#f5f5f7 底、卡片、系统字体)。每 issue 一条横向 stacked 时间轴(分段着色,hover/点击看证据),顶部一张全样本「段类型占比」汇总条图。深浅色只做浅色(founder 规范默认)。
- **建议清单**复用现有「互动评审标准模板」(FLY-349 评审页一脉的可勾选 + 评论框 + copy-export 形态;research 阶段定位现成模板文件并确认复用方式)。每条建议:预期节省(从本次数据外推,标注前提)+ 实施成本(S/M/L)+ 建/不建勾选 + 评论框。
- **候选优化方向**(实施阶段用数据验证后增删,不预设结论):CI 时长砍半(并行/分层)、doc-only 改动免全套 review、review 轮并行化、head 变更最小化(减 churn 重跑)、handoff gap 消除(park/wake 灵敏度)、gate 等人时段安排。
- **结论一句话**:「机制 vs 执行」用数据说话 —— 若空转+等待+重复轮次(机制可消除项)占比显著大于工作段,则结论指向机制。

## 7. Brainstorm gate 结论(Tadashi,2026-07-16)

两项关键取舍**均获批**:① 主线归段口径(不重复计时、段和=墙钟、优先级序合理,并行活动作附注);② repo 内可复跑脚本(符合 Flywheel infra 定位)。附加三点要求,折入设计:

- **(a) in-flight 快照纪律**:进行中的段单独标注,不进已完成时长的占比结论(与 §2 一致,升级为硬要求)。
- **(b) load 饱和标注**:汇总图上标注「2026-07-16 晚 load 106 时段」—— 机器饱和是独立变量,不能让它冒充机制成本。→ research 阶段落实 load 数据源与时段边界。
- **(c) 甜点并发数**:优化建议清单里加一条「甜点并发数」待定量项(Annie 在主频道点名问过)。→ 用全量 sessions 表重建并发数-时间曲线,与段时长相关联,给出数据支撑的并发区间建议或标注「样本不足以定量」。

## 8. 风险与开放问题

1. **样本仍在跑**:FLY-1307/1319/1252 的 QA/review 未收口 → as-of 快照 + 「进行中」标注解决;若实施时已 Done 则用完整数据。
2. **segment 判定规则的主观性**:优先级表是分析假设,不是客观事实 → 规则表全文放进报告方法学附录,每段可展开证据,读者可自行复核。
3. **单机数据完整性**:重启事故期间部分 event 可能缺失(FLY-1319 正是被重启坑的样本)→ 缺失区间按「无法测量/事故窗口」标注,不填补。
4. **Linear stateHistory 的 GraphQL 形态**未真机跑过(仅确认 key 存在)→ research 阶段第一件事验证;若不可用,T0/T_end 退化用 sessions/PR/merge 时间,并标注口径差异。
