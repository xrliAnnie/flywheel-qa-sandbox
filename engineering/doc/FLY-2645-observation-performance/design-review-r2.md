# FLY-2645 observation performance CI 随机红 — 设计评审 R2
Issue: FLY-2645 (https://linear.app/geoforge3d/issue/FLY-2645/cimain-红-observation-performance-计时预算测试在-main-上连红93ms214ms-vs-50ms)
日期: 2026-09-16
基于: design-review-r1.md

## 结果

- question: `cdeb223d-5627-4b80-af38-1e9411e9ae7c`
- request: `c16d9c67-c9f3-4883-ab92-97a9510e4f93`
- effective verdict: `APPROVED`
- blocking findings: 无

## 非阻塞 advisories

1. 可增加测量组 WAL frame 上限，确定性证明窗口内未触发 auto-checkpoint。
2. 红侧 checkpoint receipt 断言应放在 50/100ms 预算断言之前。
3. `before_tail` 最好明确放在 steady 之后、第一条 tail event 之前。
4. production modeTick 的 auto-checkpoint 事件循环成本应作为独立 follow-up 跟踪。

已通过结构化 report 报给 Lead；这些不改变 R2 effective approval。实现严格按批准的 checkpoint 隔离计划执行，不创建未经授权的新单。
