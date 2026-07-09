# FLY-1022 树状 Lead 带 runner — progress

Issue: FLY-1022 (https://linear.app/geoforge3d/issue/FLY-1022/lead-scaling-one-lead-managing-many-runners-via-a-tree-hierarchical)
日期: 2026-07-08
基于: 无

## Phase 1-5 — DONE
- explainer v1 → Annie GO;PRD;web-grounded 8 机制;ChatGPT DR 真跑(8m/29 引用/521 搜);DR substance fold
- grounded-research 卡 v2 (aff33ffb) = current,Lead QA 过
- Codex design review 2 轮 → APPROVED;R1 六项(§8.3 owner-resolution 契约/SWIM 收敛/§9 merge/§7 频道/§11 可度量/软化定量)+ R2 三项 cleanup 全修

## Phase 6: 整体架构(Annie ok)— 本轮
- [x] PRD 新增 §4B「整体架构」:Mermaid 全景 + **9 机制装在哪一层**表(①bounded fan-out ②typed 摘要上汇 ③有界队列+credit ④circuit-breaker+bulkhead ⑤soft-suspicion ⑥OTP restart ⑦health-rollup ⑧owner-resolution ⑨summary-merge)
- [x] §4A 来源标注:不再等 A/B;用现有 14 条一手来源 + DR exec;29 条精确 URL 待补(FLY-541 导出坑)
- [x] git commit 存住(Lead 指示:quota 99%,先保工作)

## PARKED(quota 5h/7d 99%,今晚 22:20 reset;Annie 睡了不急)
恢复后:① 终审卡 inline SVG(架构图,Apple-light 参 353)② head 动了 → 重跑 codex → 冻 head ③ 发 Lead 一张 current 终审卡 QA
撞限流菜单选「3. Stop and wait」。gate 别碰、不 ship。
