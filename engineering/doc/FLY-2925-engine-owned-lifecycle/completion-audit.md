# FLY-2925 引擎统一体生命周期 — 调研
Issue: FLY-2925 (https://linear.app/geoforge3d/issue/FLY-2925/病根修复-7-codex-体生死只认引擎一侧goal-结束不等于死引擎终结后-goal-不得自续重启只按原会话续接6-张-43)
日期: 2026-09-26
基于: plan.md

## 当前结论

设计交付尚未完成。探索、调研、实施计划和 HTML 草稿已提交；评审注册被引擎拒绝，不存在正在运行的评审。未发布，未运行 phase_design_complete，未改实现或生产数据。

## 按要求逐项核对

| 要求 | 当前证据 | 判定 |
|---|---|---|
| design TURN 与身份 | turn: yours，phase design，epoch 2，exec 0e6daf78-4d2a-4b32-85df-eaa57342e879 | 已核实；每次继续先重核 |
| DOC-FLOW 三份文档与头部 | exploration.md、research.md、plan.md | 已写入并推送 |
| founder 首选独立终端与现状比较 | exploration §3–4、plan §1–2，原生 goal 与 app-server 官方证据 | 已覆盖；不是实际兼容性验收 |
| 近两周失败计数、分布与口径 | evidence/reown-{events,incidents,summary}，validation.json | 100 个报错体 / 62 个明确失败；9 条分层源核对，冻结重放一致 |
| 六张单逐项构造与负例 | plan A1–A6，另 A7/A8 跨进程风险 | 设计已覆盖；真实验收属于后续 implement/QA |
| 与 FLY-2903 协调 | 当前代码及 PR #1343 merge，plan §7 | 已纳入复用，不声称生产验证 |
| FLY-2902 在飞切号/隔离 | plan §13 定义最新 Lead 要求，current #1352 差距已报告 | 设计定义了硬接口；依赖尚未满足，不能宣称原槽实现已经支持 |
| 只跑相关本机验证 | 本阶段没有产品测试；统计重放、HTML 静态/模拟 DOM 验证 | 未运行全仓/全包测试 |
| Mermaid 本地渲染 | 3 个 .mmd，diagram-render.json 各两次失败 | 使用任务允许的明确 pending placeholder；无伪图、无远程渲染 |
| HTML 首屏选择/原因/代价 | founder-design.html，build-html.py | 已有草稿 |
| 每节意见、路径隔离、长文本、复制降级 | 9 sections / 9 inputs；单 nonce script；html-validation.json 四种场景 | 静态与模拟 DOM 通过；未声称浏览器或线上 CSP 执行证明 |
| 精确 reviewer 本机测试 policy | reviewer-policy.json，生产 prompt producer 的首字节比较一致 | 已核实；未创建其他 reviewer |
| 显式 design review 注册 | gate fc8484c6-f03d-4feb-b0a3-aef4d81e894c；request b01b1efa-c985-4fb0-995f-c1d8056d5173 | **422 rejected，reviewer 未启动** |
| 有效 APPROVED 与 plan blob | 计划 blob 673bf7090020589e6bd7168a8d444918348f61a6 | 缺少 APPROVED，不可交卷 |
| 最终 HTML 提交、静默发布、线上核验、Lead 报告 | 尚无 publish receipt / hosted URL | 待 APPROVED 后执行 |
| memory closeout、精确 complete、park | 尚未到 completion | 待所有门槛通过 |

## worktree 绑定拒绝：可执行的恢复边界

本轮只读重核 sessions：worktree_path 正确，但 worktree_binding_path、branch、generation、locked_at 全为空。当前分支与远端均为 6b21045e8af54b003aee7783e5ffb51768731cc9（本核对表提交前）。不能把 worktree_path 或 TURN 当成不可变绑定的替代证据。

`packages/teamlead/src/DirectEventSink.ts:899` 规定只有 Bridge 本地创建通道能调用 bindWorktreeOnce；`bridge/event-route.ts:2520` 明确 HTTP worktree_ready 只是显示元数据，不能创建该绑定。因而 Runner 不能伪造 HTTP 事件或直接改库绕过注册检查。Lead 修复报告 caaec9a2-9bb4-4ddb-b0f5-bd166cc1ae97、c3658145-a416-4e8d-b12a-c2a8cc1c5dee 尚待答。

恢复顺序：TURN → inbox/check 相关答复 → 只读确认引擎已恢复准确 binding → 确认原 review gate 仍有效 → 同 requestId 重试 request-review。只有返回 accepted 的持久回执才算评审开始；若 gate 已终结，先明确其原因，再开新的绑定 gate/request，不能反复盲重试。

发布顺序：有效 APPROVED（核 plan blob）→ 更新 HTML 的评审状态和诚实限制 → 提交推送 → publish-report --publish-only → hosted HTTP 200 / placeholder 已替换 / CSP 与 script nonce 一致 / 源内容一致 → DESIGN-HTML ready 报告 → complete --route phase_design_complete → 按需消费 unread mail 并重试 complete → park。没有走到最后，不把常驻 goal 标为已完成。
