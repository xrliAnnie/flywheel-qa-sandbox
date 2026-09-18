# FLY-2749 纯通知停止唤醒 — 调研
Issue: FLY-2749 (https://linear.app/geoforge3d/issue/FLY-2749/额度lead-成本-lead-会话占-fable-额度-92percent每个小事件都唤醒-lead每轮重读-50-60-万-token)
日期: 2026-09-18
基于: exploration.md

## 结论
FLY-2567/#1204 已部分生效。问题不是总开关没开：生产 flywheel 项目 `lead_token_savings` override=1、last_effective=true、revision=1。漏洞分为两类：普通通知名单/判据不足；question producer 根本没有调用该分类。修复沿用原 audit_only，不增加延期投递系统。

## 证据边界
`evidence/routing-census.json` 为 9/17 00Z 至 9/18 21:34:59Z 的只读 SQL 聚合；`routing-census-7d.json` 为 9/12 00Z 起至采样时刻。7d 指七个 UTC 日期，最后一天未完，不是整168小时。`audit-routing.py` 可重跑；活库会继续增长，两个采样不应硬对齐。只读连接在每次查询后关闭；没有复制生产数据库。受管快照 helper 在 worktree 缺构建产物、主 checkout 返回 snapshot_owner_unavailable；保留这一限制，用 bounded readonly queries 替代，不伪造快照收据。

Lead 输入 `FLY-2749-honeylemon-lead-events-7d.md` 报 8,780 条、约77%候选纯通知，来源为类型/文本近似。我们独立查询不同时间/窗口结果略有差别；不把候选比例当作已验证可压比例。当前 Bridge health buildSha/artifactBuildSha 均 bd2fc7dfe5ebabe281d4125c2114d382f7b1f7f0；代码审计 checkout 在进度提交前为 injected shared branch。部署身份与文件审计是两类证据，真实 audit_only 行证明生产机制部分工作。

## 每类：实际分布、原因、处置
以下计数取 routing-census-7d.json（工程 Lead，9/12起至采样）。model 是分类，不等于模型已经实际消费；delivered_at 也只是链路标记，不能当模型消费证明。

| 类型 | model / audit_only | 当前原因 | 设计处置 |
|---|---:|---|---|
| stage_changed |1247 /659|EventFilter 只允许 onboard/brainstorm/research/plan/implement/test；raw 和 enriched 两份都必须无 guard|验证 producer 的阶段记录及当前义务，补纯 review-start/pr_created；approve/ship/completed 默认保留；清除“历史状态被当成新动作”的分类混淆|
| gate_question |788 /0|QuestionAdmission 和 GatePoller append 未传 disposition；前者绕 registry 直接物化 mailbox|仅 REVIEW_CODE/REVIEW_DESIGN 权威 reviewer lane 用 audit_only；问题仍待 reviewer 回答|
| runner_question |3821 /0|CommDB.insertQuestion 自动建 model mailbox；report 只影响 founder reply 绑定|trusted stop +无待办 receipt、结构化 DONE receipt 可压；ASK 和不明 report 立即|
| session_started |507 /0|event-route 信任参数仅 stageRecord 路径为真，分类也无此类型|普通启动、已验证 owner/attempt 且无后续人工动作可压；替换启动/重试告警或未知保留|
| session_monitoring_reestablished |85 /119|Heartbeat 调同 classifier；status/decision_route/error 等 veto|已确认监控恢复且无未解告警才可压；不能整体删 error guards|
| workflow_replacement_eligibility |205 /0|StateStore 直接 append 默认 model，绕 event-route|纯未来检查时间预告、引擎仍负责调度可压；真实 replacement/hold/失败不压|
| workflow_claim_recorded |141 /0|StateStore 直接 append；formatter 明确要求立即推进返工/汇报/ship|未消费 claim 是待办，继续 model；仅 exact claim 已有处理收据时可压，不能按类型直接吞|
| action_executed |28 /0|actions.sendActionHook 直接 append，注释 Always deliver ALL|仅已完成幂等动作且无后续待办的可信 receipt；批准/驳回/重试需处理、失败/不明保留|

### stageRecord 假说的实际结论
`event-route.ts:2042–2059` 对有效 stage 先生成 stageRecord，失败提前返回；正常通路不是“没有 stageRecord”。近两天 730 stage 行中，447 audit、283 model。model 的254条阶段本就不在六阶段名单，另外29条 implement/test 被 decision_route 拦住。原始样本含 eventId/seq，见 census。因此“stageRecord 缺失导致所有漏拦”被当前样本否定；不能为了修它把信任 guard 删掉。
`event-route.ts:3608` 从 session 混入 status、decision_route、last_error；`:3709` raw/enriched 都过分类。要区分真实未结义务与已履行旧状态，不能只看非空字符串。

### 真实问题链路
1. `flywheel-comm/src/db.ts:1897` insertQuestion → `MailboxQueue.enqueue`，稳定 deliveryId=`question:<lead>:<qid>`，report priority=2，其他=1。
2. `lead-inbox-loop.ts:330` claim model rows → QuestionAdmission.revalidate → materialize。
3. `question-admission.ts:174` appendLeadEvent 默认 model；用 raw runtime render → materializeForDelivery，未过 RuntimeRegistry audit-only 防线。
4. loop 现有 false verdict 会 markDead 或 retry（`:360`）。这两种都不能冒充 audit-only：review 必须可回答，且 audit 不等于死信。
5. legacy `gate-poller.ts:1806` 另一路默认 model，必须复用同一策略。
6. `review-gate-checkpoints.ts` 是唯一 REVIEW 集合；不能另造大写字符串名单，显示名称不等于 checkpoint identity。

### ACK 与义务分开
CommDB `mailbox_message_projection` 是 mailbox 的投影，不是名为 questions 的旧表。`relay_state/resolved_at` 决定待答义务，`state/batch_id/acked_at` 是交付生命周期；设计不得混为一谈。`MailboxQueue.retireAckedRunnerStopReports:1845` 的 report_ack 只能由真实 ACK 触发。抑制投递不得伪造 ACK、response 或 reviewer 完成。

### “转一句状态”不是免费消失的责任
`runner-messaging-rules.md:5` 要求 trusted 三元组 stop 声明“转一次状态，再 ACK”，不可 respond。可把非行动型声明的那一句交给确定性模板，但必须保持真实 issue thread/Lead 身份、持久发送收据、失败可见，不能由单纯文本 DONE 触发任意发帖。失败/blocked/quota/context_full 等仍需要 Lead 判断。

## 统计与验收口径
新 offline `measure-usage.py` 只做设计/验收量测，不改 token-usage 产品。冻结每文件已读字节/hash，精确生产 cwd，UTC 半开区间，message.id 去重并对 requestId 交叉检查；四字段总和=input+cache_read+cache_creation+output。保留 all-model 与 Fable 子集，防换额度池冒充节省。model request 数不等于外部唤醒轮数；整 turn 按外部输入到下一次外部输入分组，工具结果不启动新 turn，混合来源不强分给某类事件。
9/17 独立初测1710请求/983,610,832 token，9/18 21:33Z已出现1012次 Opus请求（510,914,974 token），所以只看 Fable 会失真。最终可重放数字看 baseline-usage.json。已有 FLY-2567 分析器单文件/固定day14、不支持空结果，不适合作原样验收脚本。

## 最新验收裁定
Lead 在 ae5477ac-dea7-4401-86c7-aa256908270a 回答：硬验收改为已证纯通知 model=0、紧急延迟不变、ACK语义不变；全模型24h真实变化必须报告，60%作为监测目标。扩展评估全部上表类别，不能以3类约10%归因排除其他类别；成本归因覆盖整个 turn 的后续工具往返。

## 实现风险
最大风险是抑制 claim/stop 把待办一起吞掉，其次是只修 lead_events 却留下可领取 mailbox，以及重启后镜像分裂复活。需要双存储幂等恢复、既有 batch 成员冻结、kill-switch 新事件恢复、真实模型零调用负证据。所有策略在桥接层复用，不能为某个Lead或vendor特判。
