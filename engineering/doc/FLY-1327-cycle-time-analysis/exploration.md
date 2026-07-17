# FLY-1327 issue 周期时间分解 — 探索

Issue: FLY-1327 (https://linear.app/geoforge3d/issue/FLY-1327/分析-issue-周期时间分解-时间都花在哪-机制优化建议annie-直令)
日期: 2026-07-17
基于: 无

## 1. 问题定义

Annie 直令(2026-07-16 ~22:41 PDT):「给我画个图,展示比较长的时间都花在什么地方,哪些地方可以优化…拿两三个典型 issue 做时间分解…我觉得我们现在好像有点不合理的慢,是不是机制设计的不太合理?」

核心问题:**issue 从开始到 Done 的墙钟时间,分解到段之后,大头在哪?慢是机制设计问题还是执行问题?**

这是一个**分析型任务**,不改产品代码:产出 = 数据驱动的一页可视化 HTML + 可勾选的机制优化建议清单 + 一句话结论。

## 2. 样本(对比组,Lead 已指定)

| Issue | 定位 | 数据侧初步核实 |
|-------|------|----------------|
| FLY-1309 | 顺畅样本:Backlog→Done ~9h,一次过 | 3 个 session(design/implement/qa 各 1),PR #620,4 轮 CI(2 次失败),4 轮 code review |
| FLY-1307 | 重返工样本:review 跑到 R8+,双 PR | 7 个 session(1 design + 2 implement + 4 qa),3 个 merged PR(#617/#623/#626),code review 累计 14 轮记录(含 failed) |
| FLY-1319 | 被基建坑的样本:重启杀 session + QA FAIL 返工 | 8 个 session,其中 2 failed(6d85da07 implement、7c568e73 qa);**注意:1 个 implement session(4f0fd842)在数据拉取时仍 running,issue 未闭环** — 分析截至快照时刻,诚实标注 |
| FLY-1252 | 双 PR + QA 换人样本 | 9 个 session(4 design 形态含 1 failed + 1 terminated,2 implement 含 1 terminated,3 qa 含 1 terminated),重启杀过一批(2026-07-16 15:53 集中 terminated) |

样本核实结论:**4 个样本的 session 级数据全部在库**,无需换样本。FLY-1319 未闭环这一点在报告里显式标注(不等它闭环 — Annie 要的是「时间都花在哪」的机制诊断,不是完美闭环样本)。

## 3. 数据源核实(全部真机验证过,不是假设)

| 数据源 | 能给什么 | 核实结果 |
|--------|----------|----------|
| ~/.flywheel/teamlead.db 「sessions」表 | 每 phase session 的 started_at / terminal_at / status / session_role(design·implement·qa) / pr_number | ✅ 4 样本全有 |
| teamlead.db 「session_events」表 | stage_changed 事件带时间戳(onboard→brainstorm→…→completed 全链),qa_result、session_failed、runner_crash_reaped、three_stage_fix_round 等 | ✅ 实测 FLY-1309 stage_changed 链完整 |
| teamlead.db 「codex_review_job」表 | 每轮 cross-family review 的 created_at → responded_at、round、verdict(APPROVED / CHANGES_REQUESTED / failed) | ✅ 实测 4 样本共 ~35 条轮记录 |
| CommDB(~/.flywheel/comm/flywheel/comm.db)「messages」表 | gate question 的 created_at → resolved_at(= gate 等人时长),checkpoint 字段区分 brainstorm / approve_to_ship | ✅ 表结构核实 |
| gh PR + gh run list | PR createdAt / mergedAt;每分支 CI run 的 createdAt → updatedAt(= CI 时长),conclusion | ✅ 实测 FLY-1309 分支 4 轮 CI,每轮 ~17-18 分钟 |
| Linear(MCP get_issue) | issue 整体 createdAt / startedAt / completedAt(Backlog→Done 墙钟外包络) | ✅ MCP 可用(linear_state_observations 本地表只存末态,历史用 Linear API) |

## 4. 分解到段的口径(关键设计决策)

**段的枚举**(issue 要求 + 数据可测性核实):

1. **design** — design session started_at → design_done / phase 完成
2. **implement 编码** — implement session 活跃段(started_at → pr_created / completed)
3. **CI 等待** — 每次 head 变更触发一轮 CI,gh run createdAt → updatedAt;失败轮单独着色(失败 CI = 纯浪费)
4. **cross-family review** — codex_review_job 每轮 created_at → responded_at × 轮数;CHANGES_REQUESTED 轮触发的返工循环单独计
5. **独立 QA** — qa session 活跃段
6. **空转等待** — 三类:(a) 段间 handoff gap(前一 phase 完成 → 后一 phase session 启动);(b) gate 等人(CommDB question created_at → resolved_at);(c) park 等 wake(可测性待 research 确认,测不到就标「无法测量」)
7. **返工** — qa_result FAIL → 后续 fix session/活动 → re-verify 的循环圈数与时长
8. **基建事故损耗** — 重启杀 session(terminated/failed 且非正常闭环)、gate 绑定 bug 等;FLY-1252 的 2026-07-16 15:53 集中 terminated、FLY-1319 的 2 个 failed session 都属此类

**诚实原则的落地**:任何段,数据够不着就在图上标「无法测量」灰块 + 报告里写明缺口,不许拿估计冒充测量。

**重叠问题(本分析最大的方法论坑,必须显式处理)**:review、CI、QA 经常并行(例:FLY-1307 QA session 与 code review 轮同时在跑)。若把各段时长直接加总,总和会超过墙钟,图就是骗人的。设计决策:

- **每 issue 时间轴 = 多泳道(lane)横向时间轴**:design / implement / CI / review / QA / gate·空转 各一条泳道,同一时刻允许多泳道并行,不假装可加总。
- **「空转」定义为墙钟上没有任何泳道活跃的区间**(纯 gap,可加总、不重叠)。
- **汇总占比图**用「墙钟归因」口径:把 issue 全程每一分钟归因给当时活跃的段(多段并行时归给关键路径段,归因规则在 research 里定死并写进报告方法论小节),保证各段占比加总 = 100% 墙钟,不虚报。

## 5. 方案选项

**方案 A(推荐):一次性分析脚本 + 数据快照 JSON + 单页交互 HTML**
- 一个独立脚本(不进产品代码路径)从 4 个数据源抽取 → 归一化成 per-issue 分段时间线 JSON(快照落盘,可核对可重跑)→ 由 JSON 生成单页 HTML。
- 优点:数据可核对(JSON 快照 = 中间证据)、可重跑(以后想分析别的 issue 直接换参数)、零 Bridge 改动、零重启、零产品风险。
- 缺点:比手工多花一点实现时间。

**方案 B:做成 Bridge 常驻 cycle-time dashboard**
- 否。过度工程:Annie 要的是一次机制诊断,不是常驻功能。若诊断结论值得固化成 dashboard,那是后续独立 issue。

**方案 C:纯手工拉数、数字写死进 HTML**
- 否。不可重跑、无中间证据、数字核对困难 — 与「数据驱动,不许估」的要求冲突,诚信风险高。

选 A。

## 6. 产出物(三件)

1. **可视化 HTML(Apple 浅色风,单页)**:每 issue 一条多泳道横向时间轴(分段着色,失败 CI / 返工圈 / 基建事故特殊标色)+ 一张全样本汇总「哪类时间占比最大」图 + 方法论小节(归因口径 + 无法测量清单)。
2. **优化建议清单(嵌在同一页 HTML)**:每条按互动评审标准模板做成可勾选项(建/不建 + 评论框 + copy-export),标注**预期节省(从本次测量数据推算)+ 实施成本**。候选方向(以数据验证后增删):CI 时长砍半(测试并行/分层)、doc-only 改动免全套 review、review 轮并行化、head 变更最小化(减少 churn 重跑)、handoff gap 消除。**建议先行原则:数据说什么,清单就写什么 — 候选清单只是研究起点,不是结论。**
3. **一句话结论**:慢的是机制还是执行,数据说话。

交付方式:按 issue 指示 publish-report 进本 issue thread 给 Annie(implement 阶段执行;若 publish-report 对 Runner 受限,则素材 relay 给 Lead 投递 — 两条路径都在 plan 里写明)。

## 7. 边界(不做什么)

- 不改任何产品代码、不加 Bridge 功能、不建常驻 dashboard。
- 不替 Annie 决定「建/不建」— 建议清单只给数据支撑 + 成本估计,决策权在她的勾选。
- 不等 FLY-1319 闭环 — 快照截至分析时刻,显式标注。
- 优化建议不在本 issue 内实施 — 每条被勾「建」的建议由 Lead 拆后续 issue。
