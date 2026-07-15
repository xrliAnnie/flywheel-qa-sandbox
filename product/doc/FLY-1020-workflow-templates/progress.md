# FLY-1020 progress ledger

Phase: plan → ship-prep(PRD Codex 6 轮 APPROVED · 终审卡已发 · 待 fire approve gate)
Cursor: PRD-final

## 里程碑
- [done] co-eval v1→v6(Annie 拍板三层)+ §2 深挖(agent.md vs DAG,Annie converged)+ FLY-1038 拆 UI
- [done] 非 UI 详细 PRD:engineering/doc/FLY-1020-workflow-templates/prd.md
- [done] Codex design-review **6 轮 APPROVED**:R1(10)+R2(5)+R3 APPROVED → Annie converged 加 generic 节点 → R4(7)+R5(3)+**R6 APPROVED**;证据 codex-review-r1..r6.md
- [done] fold DAG↔agent.md 分层 + 通用节点(generic,agent.md-参数化)+ 8 面 substrate + Gate A/B + 物理安全性质
- [done] **prd.md 冻结 head 55f1729a**(终审卡为纯新增 commit)
- [done] 终审卡 prd-final.html(结论定稿 + 三层 inline SVG + §3 醒目 generic 决定)commit bd992d92 + publish + curl 自验
  - 卡 URL: https://fw-reports-a53de2.vercel.app/r/112c95e7b8662347263c6ab5e1541ece/ · msg 1524679221840973834
- [wait] fire approve_to_ship gate(单 gate,FLY-1041 已确认无 stale)→ 报 Lead questionId+head → Lead QA → cue Annie 一拍 → verify-approval → Tadashi executor-merge → Lead 建大 epic

## Codex 逼出的实质修正(全部独立核过源码)
auto-QA default-ON opt-out(非 opt-in)· **ship-gate 死锁**(qa_required 索要 auto_qa_record,三段式只写 three_stage_verdict → workflow-aware 分支)· product skip-QA 搭不上 main-only hook · snapshot 物化+内容寻址+workflow_run_id · loop 含 founder_feedback_kickback · MVP 收敛到内建三节点+generic · **静默 role 归一数据损坏陷阱**(fail-closed 不归一)· workflow_qa head 服务端校验不信 runner 自报 · generic output 独立写入通道+replay 契约 · frontmatter-inert 收窄到 Runner 派发路径

## 约束
- 不自 ship / 不自 merge(Tadashi executor-merge)/ 不自 approve gate · docs-only PR #514
