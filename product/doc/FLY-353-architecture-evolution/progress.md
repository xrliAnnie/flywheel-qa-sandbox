---
issue: FLY-353
phase: plan
phaseCursor: 8/8
updated: 2026-07-09T00:00:00.000Z
nextStep: rich PRD-HTML rebuild (make it as detailed/rich as design HTMLs) — candidate for fresh run (ctx 97%)
chunks: []
pointers: {}
---

# FLY-353 主动 DAG 编排 — progress（供 fresh run 续跑）

**phase**: plan (8/8) — 详细 PRD 已写 + Codex APPROVED(3 轮);Annie 要 PRD 和设计 HTML 一样丰富

## 已完成
- research(3 家架构)+ co-eval v1→v7(Annie 逐节确认)+ 详细 PRD
- **PRD 全文**: `engineering/doc/FLY-353-dag-orchestration/prd.md`(Codex design review APPROVED 3 轮)
- 设计 HTML(v7,accumulated): `product/doc/FLY-353-architecture-evolution/dag-orchestration-design.html`(在 thread: f2c75670)
- 上游: exploration.md / research.md
- 已发 thread 的 PRD-HTML(精简 b8c4e20 作废 → 详细 md→html 54f47941,Lead 已 relay Annie)

## 未完成 / 下一步(fresh run 接这里)
Annie 第 2 次反馈:PRD-HTML 比设计 HTML 内容少很多,要把 detail 都放进去。
我的分析(见 flywheel-comm question 34391dcd):PRD .md 内容其实是设计 HTML v7 的超集,问题在**我的 md→html 渲染太糙**
(段落碎、无 callout 框、只 1 SVG)→ 视觉单薄。
**下一步 = 重做 PRD-HTML,做得和设计 HTML 一样丰富**:
- 双 inline SVG(架构全景图 + 毕业曲线,可从 dag-orchestration-design.html 直接搬)
- 每条 Annie 原话用 callout 框(像设计 HTML 的「你说…」框)
- 加表格:两层模板表(eng 三段式/product 更短/未来各一套)+ 三形态对照表(静态DAG/现在动态/提议)
- 干净排版 + 全文详细一节不落 → 视觉丰富度 ≥ 设计 HTML
- 若 PRD .md 也要更细,同步补(但内容已很全)
- 做完 curl 验 → publish-report --channel 1524481089081577532(deprecate 54f47941)→ 发 Lead QA → relay Annie
待 Lead 对 34391dcd 的确认(读法对不对 / 哪块具体缺 / 含不含 arch-research)。

## 硬约束
不 ship、gate(07784b54/68f0a379)别碰、eng issue 别建(Lead 按 910 建 umbrella)。
