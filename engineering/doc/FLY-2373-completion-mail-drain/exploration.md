# FLY-2373 完工消息排空 — 探索
Issue: FLY-2373 (https://linear.app/geoforge3d/issue/FLY-2373/病根-完工-drain-与中途延后门铃互锁codex-体在一个-turn-里轮询等-lead-答案-deferred-midturn)
日期: 2026-09-25
基于: 无

## 目标与授权
Founder 2026-09-25 的“嗯，那就修呗”批准修复完工死锁。此节点只设计；实现和 QA 明确使用 Opus，QA 必须在 529 房启动真实 Codex 实现体，拆房前 ask Lead。本机只跑相关检查。
成功意味着：已读正文或没有正文的门铃，不再让交卷永久 409；真实未读指令必须交给模型并被消费，不能通过机械改状态“排空”。

## 当前依据与范围
基线 801ac86cb；design TURN epoch=1，execution bc7d47b8-a833-426e-ba06-ace67285b54e，activation activation:bc7d47b8-a833-426e-ba06-ace67285b54e:110e738b-87ff-4332-91a4-a29be96018be:eng_design:1。
用户提供的 ×34 与事故形状是任务输入，设计阶段不声称重新验证全部历史事故。
当前源码证实：completion 检查 mailbox ACKED 和 wake started/finished；活跃 turn 里的 receiver wake 延后，而只有 turn barrier 才提升；普通 goal continuation 又不保证 phase hold。
首个反例：legacy enqueueRunnerPhaseWake 在转交正文时就 ACK mailbox。因此 ACKED 不总是模型消费凭据。
第二个反例：没有 sourceInstructionId 的所有 legacy wake 都标 park_wake；这个标签不能证明“没有正文”。

## 选择
采用正文消费凭据驱动的排空：从门铃解析真实义务，消费可在当前 turn 的工具输出中完成。门铃运行状态只保留运输审计意义。
保留 gate、TURN、执行身份、rework delivery、ship authority 等所有独立授权检查。plan 不把门铃结算凭据当批准。
拒绝简单忽略 deferred_midturn、把 queued 改成 started、对所有 park_wake 放行、complete 内自动 ACK 未读正文，以及要求人为 terminate/改库。

## 产品语义
已读 Lead send、已 check 的复审判决，长 turn 内第一次 complete 成功。若 complete 才发现真正未读正文，必须先把正文返回给模型，模型执行并确认后再提交；这个交互可以在同一 turn 内完成。
CLI 调用尚未返回时模型不能读该调用输出，不能宣称“未读正文自动消费后一次调用成功”。该解释已通过问题 63ea323f-de86-46cc-8dce-51fa4987ca9b 交 Lead 核对；无回复时保留安全默认，不削弱正向两种验收。
第四项旧体活 pane 收尾有独立 authority/身份风险，列明归属和正式恢复接口，不把 stale heartbeat 当死亡。

## 交付
research.md 给源码闭包；plan.md 给数据合同、实现步骤、并发与旧数据策略、真实 QA 矩阵；founder-design.html 给中文图解和逐节评论。有效 reviewVerdict=APPROVED 后才发布并完成设计。

## Lead 裁定（已收到）
问题 63ea323f-de86-46cc-8dce-51fa4987ca9b：认可方向；纯信号/已消费正文一次complete；真实未读由第一次complete返回原文和ACK步骤，同turn ACK后第二次complete成功，零park/terminate/Lead介入。Lead send新指令按≤2次验收，已消费复审/park通知按1次。已报告回执 c271bea2-b31a-4cd7-bf59-10a4a4d9b178。
