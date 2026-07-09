# FLY-1020 progress ledger

Phase: plan (PRD Codex-APPROVED, head 冻结, 待 Lead QA)
Cursor: PRD/3 (Codex design-review 3 轮 APPROVED)

## Chunks
- [done] onboard + 核码 + homerail grounding
- [done] co-eval v1→v6(6 轮),v6 Annie 拍板通过(三层设计;UI 拆出 FLY-1038)
- [done] 非 UI 详细 PRD:engineering/doc/FLY-1020-workflow-templates/prd.md
- [done] Codex design-review R1(10 findings 全采纳)→ R2(5 findings 全采纳)→ R3 **APPROVED**(3 条非阻塞注记已折入)
- [done] review 证据存档(codex-review-r1/r2/r3.md)+ 冻 head **f6f39c6e**
- [wait] Lead QA PRD → 拆 build issue 交 Tadashi
- [next] Lead QA 过 → build issue 拆分(§13 九步)

## Codex review 逼出的实质修正(全部独立核过源码)
1. auto-QA 是 **default-ON opt-out**(FLY-752),不是 opt-in —— 原 PRD 写反,被 types.ts:616 的 stale 注释误导(doc drift 已列入验收)
2. **ship-gate 死锁**:evaluateQaShipGate 在 qa_required=1 时索要 passed auto_qa_record,而三段式内部 QA 只写 three_stage_verdict → 复用 qa_required 会永久挂死 ship。改为 workflow-aware 分支(workflow_qa_required/passed/exempt),遗留路径字节不变
3. product skip-QA **不能**搭 onMainAwaitingReview(coordinator + 两个 sink 都只处理 main 行)→ 改为入口写 workflow_qa_exempt
4. snapshot 必须**物化**(归一化 nodes/edges/skip/counters + workflow_run_id),不能只存 id/hash —— session_params 是 per-execution,handoff/retry 都起新 execution
5. loop 条件源必须含 **founder_feedback_kickback**(保留其守卫),否则回归现有 founder 反馈修复路径
6. MVP 收敛到内建 design/implement/qa;任意节点类型降为阶段 2(持久化/展示/finalizer/retry 全硬编码三角色)
7. build 顺序重排:**ship-gate 证据契约先于 orchestrator**
8. workflow_qa_passed 的 head **不得信 runner 自报**(qa-result 的 prHeadSha 默认取 runner git HEAD)→ 服务端 capture 或校验,不一致 fail-closed

## Notes
- 遵 Lead steering:不 ship、gate 别碰。PR #514 = co-eval doc 载体不 merge。
- UI/dashboard → FLY-1038(cross-ref,不在本 PRD)。消费方 → FLY-353。scale → FLY-1022。
