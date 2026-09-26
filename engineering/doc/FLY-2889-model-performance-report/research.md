# FLY-2889 模型表现报告 — 调研（数据源地图）
Issue: FLY-2889 (https://linear.app/geoforge3d/issue/FLY-2889/模型表现报告-设计-实现-qa-各节点分流的各模型正确度速度花费三维度实测-结合额度给调整比例的建议一页可评论-html)
日期: 2026-09-25
基于: exploration.md

全部只读：`~/.flywheel/teamlead.db` 用 `sqlite3 file:...?mode=ro`；CommDB `~/.flywheel/comm/<project>/comm.db` 同样只读。

| 需要的量 | 来源 | 备注 |
|---|---|---|
| 执行的模型 | `workflow_execution_runtime`（vendor/model/effort，不可变） | 分组键 = 节点角色 × vendor/model/effort |
| 随机分组 | `workflow_run_event.kind=model_arm_assigned`（新）/`design_model_arm_assigned`（旧） | 人工 override 不产生 arm |
| 激活/完成 | `workflow_execution_binding.bound_at`（spawn/wake/replacement）；`workflow_node_completion.completed_at`；QA 完成 = `workflow_claims` qa_passed/qa_failed 的 `issued_at` | |
| Codex 作者的评审轮 | `codex_review_job`（review_type design/code，status=done，verdict APPROVED/CHANGES_REQUESTED） | 每轮一行，failed 行是基础设施失败不算轮 |
| Claude 作者的代码评审轮 | `codex_review_record.rounds`（runner 自报） | 覆盖不全 |
| Claude 作者的设计评审轮 | worktree `.flywheel/runs/<exec>/codex/design-review.json`（大多已清）；transcript 中 codex-companion 评审调用次数 | manifest revision ≠ 轮数（实测 rev1 有 7 轮） |
| QA 判决 | `workflow_claims` predicate qa_passed/qa_failed，带 issuer_model、subject_producer_execution_id | |
| 打回 | `workflow_rework_request.authority` qa/founder/lead/engine × source_node；`workflow_founder_gate_verdict` | |
| founder/Lead 等待 | CommDB `mailbox` type=question 且 checkpoint∈{question,founder_review,approve_to_ship}，对应 type=response 的 ref_id | 非阻塞 ask（checkpoint 空）不扣 |
| 额度暂停 | `codex_quota_execution_pause` / `codex_quota_admission_wait` | 生产均 0 行 |
| 重启/换体 | 事件 `execution_dead_rolled_back`、`writer_replacement`、`rework_replacement*`、`resume_target_unrecoverable` | 作为噪声标记 |
| token | 09-23 23:46Z 起 `workflow_scorecard_usage`（按 turn 归属 activation）；之前 transcript/rollout | 见 plan §4 |
| 额度读数 | 额度页数据源（Claude/Codex 各账号周百分比读数） | 见 plan §4 |
