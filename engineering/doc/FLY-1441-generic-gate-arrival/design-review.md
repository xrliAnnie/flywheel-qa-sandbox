# FLY-1441 Gate 到达发射 — Codex design review 记录(design epoch 4)
Issue: FLY-1441 (https://linear.app/geoforge3d/issue/FLY-1441/规则回迁-qa-绿了才发-ship-gate-把-fly-579-定过的规矩在-dag-引擎上重新落地-加防丢测试)
日期: 2026-07-23
基于: plan.md(R6)

- 工具:codex-companion(persistent thread `019f8fe0-a857-7912-b8bb-70baa14c1154`),effort xhigh,共 **7 轮 → APPROVED**;每轮 finding 数收敛:R1 6H+3M → R2 7H+1M → R3 7H → R4 4H+2M → R5 1H → R6 1H(rollout)→ R7 0(APPROVED)。
- **R1(全采纳)**:runner_ship 无 awaiting_review session 可绑(projectGeneralizedCompletionTx 无条件写 completed —— 旧 HIGH `ship-approval-carrier-removed` 未闭);merge classifier 被 scanner 让位排除;engine_terminal snapshot digest 撞 git_head 合同;non-land feedback 撞 land-only authority guard;call-time flag 混代死锁+backfill;grep 中立声明不实;classifier 未限 approve_to_ship;exactly-once 超卖;creates_pr 单一能力不足。
- **R2(全采纳)**:pre-Gate awaiting_review 在 display/HeartbeatService/park-watch 提前呈现审批 → 新 FSM 态 `ship_parked`;supersede 会杀 rework 复用的同一 execution → 逻辑件/物理 session 分离;rogue merge 不可达;subject 合同重定(head 取 passing claim,generic 才 snapshot);validator 拒 founder_feedback loop → 拓扑合同扩展;authority=lead 撞 CHECK → 机器 outcome+审计;decision binding 未真冻结;prompt epoch 谓词。
- **R3(全采纳)**:feedback 两阶段状态边;ship_parked 七族消费者矩阵;同 exec 二次 activation 的 current-activation fail-closed 解析器;subject kind 由冻结 claim topology 推导;**verdict 证据 Gate 时冻结(1h TTL vs 48h 审批窗死锁根除)**;merge pass 含 materializing;loop-reentry 恢复两段 confirm + 幂等。
- **R4(全采纳)**:`workflow_gate_holder_evidence` 证据集合子表;credential janitor 纳入迁移矩阵;`workflow_loop_reentry_request` 单事务状态机(receipt-first 重放);`gate-carrier-rebind` 取代业务 loop 修复。
- **R5→R6(采纳)**:rebind = 单一原子 authority 事务(holder CAS+session flip+binding+window 戳+audit receipt),materializer 只消费 bound holder;holder +`carrier_binding_state`,旧行 NULL≡bound 兼容。
- **R7:APPROVED**。

反馈原文:`/tmp/codex-rescue-design-feedback-flywheel-FLY-1441-gate-arrival-round{1..7}.md`(要点已全部折入 plan.md 修订记录)。
