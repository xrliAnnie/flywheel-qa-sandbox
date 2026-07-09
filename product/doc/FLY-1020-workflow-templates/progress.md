# FLY-1020 progress ledger

Phase: plan (PRD Codex-APPROVED + 终审卡已发 · 待 Annie 终审)
Cursor: 终审/1 (终审 HTML published, awaiting Annie sign-off)

## Chunks
- [done] onboard + 核码 + homerail grounding
- [done] co-eval v1→v6(6 轮),v6 Annie 拍板(三层设计;UI 拆出 FLY-1038)
- [done] 非 UI 详细 PRD:engineering/doc/FLY-1020-workflow-templates/prd.md
- [done] Codex design-review R1(10)→R2(5)→R3 **APPROVED**;3 条非阻塞注记折入;证据存档 codex-review-r1/r2/r3.md
- [done] **PRD 冻结 head f6f39c6e**(其后所有 commit 均未动 prd.md,已 git diff 核实)
- [done] Lead QA PRD 过
- [done] 终审 HTML(结论版,照 353 c5f664d6 风格)commit d6b45ac1 + publish + curl 自验
- [wait] Lead QA 终审卡 → relay Annie 终审(§2 MVP 收敛需她拍板)
- [next] Annie OK → 按 §13 九步拆 build issue 交 Tadashi

## Publish artifacts
- 终审卡 (current): https://fw-reports-a53de2.vercel.app/r/41631d6833489c7238eaa3d9beee4b8f/ · msg 1524657811064361041
- v6 co-eval 设计卡(设计阶段已完成,历史): .../bdcfb9ead0683e0c75c05cf6a0554443/

## ⭐ 需 Annie 拍板的一条(终审卡 §2)
MVP 只做内建 design/implement/qa;任意节点类型(创作视频 Research/生成视频)挪阶段 2。
理由:三角色硬编码在 持久化/展示/ship收尾/retry/重启对账 五个生产面。
**不是砍功能,是排期** —— 三层设计 + 注册表 seam 原样保留。

## Codex 逼出的实质修正(全部独立核过源码)
auto-QA 是 default-ON opt-out(非 opt-in,被 types.ts:616 stale 注释误导)· **ship-gate 死锁**(qa_required 索要 auto_qa_record,三段式只写 three_stage_verdict)· product skip-QA 搭不上 main-only 的 onMainAwaitingReview · snapshot 须物化(+workflow_run_id)· loop 须含 founder_feedback_kickback · MVP 收敛 · build 顺序:ship-gate 证据契约先于 orchestrator · workflow_qa_passed 的 head 服务端校验、不信 runner 自报

## Notes
- 遵 Lead steering:不 ship、gate 别碰。PR #514 = doc 载体不 merge。Annie 睡了不急。
