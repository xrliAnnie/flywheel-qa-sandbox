# FLY-2925 引擎统一体生命周期 — 调研
Issue: FLY-2925 (https://linear.app/geoforge3d/issue/FLY-2925/病根修复-7-codex-体生死只认引擎一侧goal-结束不等于死引擎终结后-goal-不得自续重启只按原会话续接6-张-43)
日期: 2026-09-26
基于: plan.md

## 当前结论（重开执行 926640ee）

本次 TURN 已核为 design epoch 3；分支从交接指定 b00dafc81 继续。onboard 已重新报告并完成，已进入 brainstorm/research/plan，按明确指令不请求 brainstorm 或 ship gate。旧执行的 422 仅保留为历史，不复用其 gate/request 身份。当前无 unread instruction。

| 要求 | 当前证据 / 状态 |
|---|---|
| 沿用既有三份设计与统计 | exploration/research/plan、冻结 evidence 保留；无实现改动、无产品测试或生产操作 |
| 对齐最新 Lead 裁定 | plan §13；FLY-2902 已批准原槽合同替代旧在飞切换硬要求；六单 A1–A6、A7/A8 仍保留 |
| 独立宿主首选比较与可见 TUI | plan §1–4；HTML 首屏明确选择、原因、代价 |
| 近两周统计 | 冻结 458 事件、100 个报错体、62 个明确失败；分母限制不变 |
| 设计正式评审 | 本执行 request 9b8acb0b-8a17-4726-8d52-4e1eafef51ad 已 accepted；gate 3d0bd288-23a3-46e2-a652-86e1fb8e9b88 待有效 verdict；plan blob acfadbf46b5252dafa1b30d5a38fa02ec75f6d8a。旧 b01b1efa 的 422 只属历史 |
| reviewer 测试政策 | 当前生产 producer 首字节加载 policy；SHA256 69b512badb5fdd37ebe6db6dd3f9f22ca7db577c6539c69252b10ff87858c363 与注入政策一致 |
| HTML 与图 | 草稿已对齐最新账号边界；原 3 图各两次本地失败记录保留，明确 pending；不远程渲染 |
| 发布与交接 | 等有效 APPROVED 后最终提交推送、静默发布、HTTP/CSP/源核验、DESIGN-HTML ready、complete phase_design_complete、park |

旧执行 0e6daf78 的 immutable binding 缺失由本次重开替代，不能自行改库或伪造 HTTP worktree_ready 修补。新评审 accepted 回执才证明注册成功。没有当前 APPROVED 与发布/完成回执，不将设计标完成；阶段交卷也不终结常驻 goal。

## R1 返工状态

question 3d0bd288-23a3-46e2-a652-86e1fb8e9b88 已返回有效 CHANGES_REQUESTED（2 HIGH、7 MEDIUM）。plan §4.4/6.1/9/14 已补快照、真实首次接管与两步发布/回滚守卫，全部九项有处置与验收；待新请求评审，不沿用旧 accepted 当批准。HTML 已补首屏成本和首次失败的诚实边界；无实现/构建/重启。
