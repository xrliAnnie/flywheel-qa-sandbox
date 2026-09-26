# FLY-2912 纯通知只记账 — 调研
Issue: FLY-2912 (https://linear.app/geoforge3d/issue/FLY-2912/token5-纯通知不叫醒扩面stage-changed-session-started-监控恢复-换体预告只记账不叫醒)
日期: 2026-09-25
基于: exploration.md

## 结论
不能只扩大 EventFilter 的名称白名单。普通阶段已经静默，但 code_review 的 owner 查找没有分支、Codex 自己 request-review 不产生旧触发 instruction，session_started 被明确拒绝静默，换体预告 append 默认 model，恢复路径把 openAlert 固定成 false。须在可信 producer 构造证据、持久化 disposition 后阻止所有 model consumer，并补下次真实唤醒的汇总。

## 逐条代码证据（HEAD 801ac86cb）
| 入口/消费者 | 当前行为 | 本单处置 |
|---|---|---|
| bridge/EventFilter.ts:258–452 | notification-v1；六普通阶段与有 owner 的 review/PR 阶段可静默；session_registered 一律 model；action guards 未覆盖 question_id/ask/prompt 等 | 扩展内部 evidence 和保守 payload 边界，统一 notification-v2 |
| bridge/event-route.ts:357 authoritativeReviewOwnerRef | 只查 design_review/pr_created 的旧 bridge instruction；code_review 直接 undefined | 新查 exact execution/type/head 的显式 review request；不能由文字冒充 owner |
| bridge/event-route.ts:2112 | insertStageChangedEvent 先校验并持久化阶段事实 | 保留先校验/持久化/副作用再路由顺序 |
| bridge/event-route.ts:3760 | session.status=running 被当作继承 decision_route 已解决；同时评 raw payload 与 hookPayload | 改为事件所属义务/解决收据；两份 payload 都检查，不能仅凭 running |
| HeartbeatService.ts:2335,2558 | re-adopt 后形成事件；通用兼容函数伪造 openAlert=false；非 running 状态被全拦 | 专用恢复 evidence：确切 exec/episode/probe/告警 lifecycle；已合法 park 的恢复可静默 |
| StateStore.ts:49965–50026 | replacement_candidate/两种 hold 共用预告事件，append 未传 disposition | 只有已持久计划/当前 attempt 的未来 candidate 可静默；hold 仍即时 |
| bridge/workflow-replacement-lead-event.ts:60 | 直接 enqueue；registry 对 audit_only throw | 先查持久行 disposition，正常跳过，不能走异常重试 |
| bridge/runtime-registry.ts:76,112,129 | audit 事件在 dispatch/enqueue 有 guard | 复用，并用真实 producer 集成证覆盖 |
| StateStore.ts:26861–26925 | audit 查询含热账和校验 SHA 的 archive；上限50、稳定 seq 分页 | 扩展 scope/range 汇总，不改 canonical 记录 |
| bridge/bootstrap-route.ts:47 | /api/bootstrap/:leadId/audit-events 已有受保护 JSON 分页 | 复用，补范围参数及只读 HTML 表现；不能伪称已有固定可读页面 |
| bridge/bootstrap-format.ts:51 | 仅提供查询指针，不注入 audit 内容 | 新摘要要在自然唤醒 batch 上落到两载体实际消费字段 |
| bridge/lead-inbox-loop.ts:423–541 | model/discord batch 生成后经 adapter 收据再 queue delivery；没有 audit 摘要 | 只对已存在的合法 batch 附加冻结上下文，不创建队列成员或 wake |
| bridge/lead-delivery-adapter.ts:66,154 | Claude 消费 members[].content；Codex 消费 modelPayload | 必须两条都附加同一摘要，不能只改 modelPayload |
| bridge/lead-inbox-runtime.ts:351 | 每 Lead 组装 loop、admission、registry | 注入汇总读取与 frozen receipt store，作用域绑定 project+lead |
| bridge/question-admission.ts:150–200 / gate-poller.ts | REVIEW gate 与有 exact runner-stop receipt 的 DONE 已静默；ASK 等仍 model | 保持合同，只回归，不新增普通报告静默 |
| bridge/flag-store-runtime.ts:239 | 项目 lead_token_savings；异常/坏值返回 false | 唯一开关，读取失败回 model |

## 当前覆盖 vs 缺口
1. 已覆盖：可信 routine stage；满足旧 owner 合同的 review/pr stage；运行态监控恢复；REVIEW gate；exact stop DONE。现有 61+2 audit 行是已工作证据。
2. 未覆盖：普通 session_started；future replacement candidate；显式 review request 的阶段 owner；合法 parked 状态监控恢复。
3. 必须维持：founder_reply、ASK、普通未证 report、非 REVIEW gate、失败/卡住、审批/ship真实动作、workflow_claim_recorded、实际 replacement、retry/environment hold。
4. 命名不是权限：未知字段/任意正文不能被“normal”“FYI”“done”之类字眼覆盖。事件含自由正文且 producer 不能证明是固定机器模板，保留 model。

## 9-25 证据
只读 SQL 导出（不是 live DB 文件拷贝），窗口 18:00–20:45 PT，239 行，manifest 记录 SHA。系统 snapshot helper 回 snapshot_owner_unavailable；没有绕过它复制约4GB live DB。限制：lead_events.payload 是投影，不等同原始 ingress；delivered_at 也非模型消费。实现节点必须按固定窗口补 session_events 原文、review/attempt/timer/alert 相关历史证明及 adapter batch/turn 证据；真实序列未出现的类别另做合成测试并单列，不能塞入真实 replay 分母。

## 实现形状
只新增两个小内部模块：lead-notification-evidence.ts（把已有权威记录变成分型证据）、lead-audit-summary.ts（无唤醒的确定性汇总）。数据仍在原 lead_events；附加 batch 快照与展示游标仅服务去重，不作授权、不作 ACK。不引入 LLM 分类或定时任务。

## 验证边界
本节点只审代码与设计 HTML；不宣称代码验证、线上收益或真实 Lead 次数已完成。仅运行相关测试；禁止全仓测试。设计审查必须显式 register，reviewVerdict=APPROVED 才发布最终页/交接。

## Lead 确认的回放输入（2026-09-25）
问题 5fbba693-8282-4690-9a9c-0020b7aff927 已答：固定窗口 01:30–04:00Z（18:30–21:00 PDT）。必须含03:58Z重启恢复批（另案FLY-2917），真实待办单列。v2 manifest: 257条，stage 62 audit/18 model，started 21 model，monitoring 26 audit/12 model，replacement 2 model；不是唤醒统计。FLY-2904 证据在 PR #1340 / d4410e7e1 / engineering/doc/FLY-2904-token-waste-census/evidence，derived/recommendations.json 的r9数字仅作问题背景，不作本单验收分母。
