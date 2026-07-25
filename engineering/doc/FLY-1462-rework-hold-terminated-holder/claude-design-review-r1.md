# FLY-1462 独立对抗性 design review 记录(Claude stopgap R1)

Issue: FLY-1462 (https://linear.app/geoforge3d/issue/FLY-1462/infra引擎-rework-永久-holdpersisted-target-missing-terminated-holder-空)
日期: 2026-07-24
基于: plan.md (v1, commit 64b5f43f)

背景:codex-design-review 撞硬配额(school profile usage limit 至 2026-07-29 22:35,唯一有 Codex 权限的账号)。Tadashi 裁决(question c9c55457):放行但不裸 waive——照 FLY-1405 办法,先做一轮独立 Claude staff-engineer 对抗性 review,结论并入 plan;codex 正式补审显式标 **PENDING**,7/29 配额恢复后补跑;不 hold(本单 Urgent,解 FLY-1150)。

Reviewer:独立 Bar-Raiser 子 agent(Fable,与设计作者不同上下文,实读代码 37 次工具调用)。
Verdict:**CHANGES REQUIRED**(2 HIGH + 3 MED + 4 CLEAN)。全部发现已由设计者逐条 file:line 复核为真,并入 plan v2(commit 见 git log)。

## 发现摘要与处置

| # | 级别 | 发现 | 复核 | 处置(进 plan v2) |
|---|---|---|---|---|
| 1 | HIGH | `probeRegistered` wiring 用 `getTmuxTargetFromCommDb`,把 CommDB **读错误**(锁/损坏)折叠成 `absent`(`tmux-lookup.ts:268-276` NOTE 原文 + `plugin.ts:9479-9486` `!target→"absent"`)。v1 方案下,terminate 杀窗失败(cleanupError,registration 保留、pane 活)的 ghost,在任一 CommDB 读错误 tick 会被判 absent → 空 target → terminated ∈ proven-dead → **不可逆 replace = 双写者**。现状代码同场景只是无害 hold、下 tick 自愈 | CONFIRMED | Fix A:probe wiring 改用 `lookupTmuxTarget`,`kind==="error"` → 返回 `"indeterminate"`(语义 tmux-lookup.ts:218-221 已定义;保守模式 plugin 中已有先例) |
| 2 | HIGH | v1 的核心安全论证"cleanupPending 的 terminate 一定带 tmux target,不会落入空 target 分支"**为假**:cleanup 的已知 target 存在于 **CommDB**,从不在 `session.tmux_session`;全仓无生产代码写该列;生产实锤(fly1329 pin test):**1423 行 session 全部 tmux_session NULL** → 有-target 探针路径生产不可达,新分支实为 registration-absent 后的**全部**决策路径 | CONFIRMED(grep 写方仅列名映射;pin test 104/223 行原文) | plan v2 §2.1 注释改写(删除错误断言)+ §1/§7 风险框架按"新分支=生产主路径"重标定;真正的守卫 = registration 保留(Fix A 后 error 不再穿透)+ Fix B 正面死亡证据 |
| 3 | MED | terminate/close 从"registration 查无"**推断**物理死亡(`actions.ts:1509-1546` `gone→physicalGone=true` 不尝试 kill;close-runner 同):从未注册的活 runner(FLY-793/855 记录的真实生产形态)被 terminate 后 = terminated + 无 registration + tmux_session NULL,v1 直接 replace = 双写者;旧逻辑的 hold 在这里**是在干活**,不只是死锁 | CONFIRMED | Fix B:空 target + proven-dead 分支要求**正面死亡证据** —— `discoverTmuxTargetByExecutionId`(FLY-1374 `@flywheel_exec_id` 全局 marker 扫描,`tmux-lookup.ts:76-124`,marker 由两个 runner adapter 建窗时设置):`missing` → replace;`found`/`ambiguous`/`indeterminate` → hold |
| 4 | MED | "第二消费者 `isWakeTargetProvenDead` 同受益"是**死代码**:两个调用点(1594/1906)的行都来自 `getAlivePhaseSession`,生产 wiring 过滤 `{running, awaiting_review, approved_to_ship, design_done}`(`plugin.ts:9368-9375`),与 proven-dead 六态不相交 | CONFIRMED | 文档更正(research 附录 + plan §3):消费者 2 不可达 → 既无收益也无风险,blast radius 实际缩小到 rework coordinator 单消费者 |
| 5 | MED | `completed` + 失 target 的姊妹永久 hold 仍在(patrol/restart 关停 parked completed 窗 → 同样 980-generation 空转),exploration"根治整类"措辞过宽;且 hold 无可见性(方案 D 被推迟)正是 FLY-1150 坐到 generation 980 才被人发现的原因 | CONFIRMED(逻辑成立) | 措辞收敛(research 附录);方案 D(generation 阈值告警)follow-up 建议随 DONE 报告提给 Tadashi 立单;completed 行为本身维持 hold(有意保守,不变) |
| — | CLEAN | 集合成员/复活竞态(FSM 六态无出边回活;retry=新 executionId 不复活旧行)、reason 字面量/测试 blast radius、自愈论证(无 generation 上限)、快照竞态方向(只会错向 hold=安全侧) | — | 无需改动 |

## Codex 正式补审状态

**PENDING** — 待 school profile 配额 2026-07-29 22:35 恢复后按原流程补跑 `/codex-design-review`;在此之前本记录 + plan v2 是 design 阶段的 review 证据。**本文件不是、也不得被当作 codex APPROVED 结果**;`.flywheel/runs/<exec>/codex/design-review.json` 未写入(不伪造)。
