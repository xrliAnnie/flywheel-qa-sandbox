# FLY-1022 树状 Lead 带 runner — progress

Issue: FLY-1022 (https://linear.app/geoforge3d/issue/FLY-1022/lead-scaling-one-lead-managing-many-runners-via-a-tree-hierarchical)
日期: 2026-07-08
基于: 无

## Phase 1: design co-eval v1 — DONE (Annie GO)
- [x] exploration.md + research.md (核过码现状 + 五轴合成)
- [x] explainer HTML v1 → 发布 → Annie co-eval → GO 写 PRD

## Phase 2: PRD — 本轮已交付,等 Annie QA/收敛
- [x] engineering/doc/FLY-1022-hierarchical-runner-tree/prd.md (折 Lead §1-§9 全部 refine)
    · 353=capacity-aware派发 / 1022=抬单Lead容量;⭐942 tree-aware层层上报;⭐多层设计MVP一层;
      树聚合+DDIA;⭐节点=整条三段式session不拆(对齐1020);⭐per-issue thread 保留硬约束;
      多机放置+Lead-as-child schema;scale-gate(看门狗完+一层稳);build拆分挂Tadashi全标scale-gated
- [x] prd-review.html (过目 co-eval) → publish → https://fw-reports-a53de2.vercel.app/r/5c371de47ac6d261d0b8ea13eba2c44f/

## 本轮止于此(Lead: gate 别碰、不 ship)
next: 发 Lead QA → relay Annie → 收敛 → ship(codex 先跑→冻→核 mergeable→fire gate→Annie→Tadashi)→ create build-issue 挂 Tadashi
