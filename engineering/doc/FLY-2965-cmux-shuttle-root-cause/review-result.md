# FLY-2965 评审批准与交接 — 实施计划
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: plan.md

有效reviewVerdict=APPROVED，round=3，question a0561884-9d84-48ce-a16a-0e4bc1ce8ec4，request c6796e5c-2655-4855-b5a2-832610b8563d。裁定见evidence/review-round3.json。plan.md保留送审原文及其DRAFT字样以便验证同一内容，本文件记录其已批准状态，不修改送审plan blob。

## 非阻断Follow-up

LOW final-aggregation-drops-confirmed-failure-precedence：现有restart汇总使先前confirmed fail优先于随后unproven，pass会清confirmed；R3逐项最新结果与此略有差异。两者均不pass、均保留marker。已向Lead报告，请其决定是否保留原统计/文案优先级并补J反例；此项不阻断设计交接，不是overrule或新批准。

## 交付边界

无产品实现、无生产重启、无后继派发、无ship/merge。隔离协议复现是根因机制证据，不是事故cmux内部堆栈或修后验证。HTML评论逻辑做过Node VM DOM替身验证，不冒充浏览器QA；浏览器工具受approval-never策略拒绝。mmdc两次本地渲染失败，按本单明确例外保留Mermaid源与DIAGRAM PENDING LOCAL RENDER占位。发布后还须验证HTTP与实际nonce/CSP并报告URL，再执行phase_design_complete与park。

## Lead已处置LOW：保留原汇总优先级

问题2ad5c757-88b4-4a0c-a8c9-1f9b1e128022的正式答复：沿用原优先级，同一目标已有confirmed fail时，后批unproven不能覆盖，最终fail并保留marker；实现节点加J用例，先confirmed fail、后批unproven→最终fail。Lead明确“不重开已通过的设计，写进实施交接即可”。这是对R3逐项最新结果描述的交接澄清，保留源码既有汇总语义（真正后续pass仍按既有逻辑清除confirmed，符合延迟收敛通过的验收）。实施必须同时保留fail→unproven与fail→pass两个反例，不因本条废掉真实收敛成功。
