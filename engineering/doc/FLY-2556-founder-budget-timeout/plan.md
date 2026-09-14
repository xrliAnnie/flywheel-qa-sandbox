# FLY-2556 容量测量超时 — 实施计划
Issue: FLY-2556 (https://linear.app/geoforge3d/issue/FLY-2556/main-红热修-founder-budgettestts60measures-the-combined-child-cap-200)
日期: 2026-09-14
基于: research.md

**Domain:** TypeScript test-only

1. Red：保留 main CI rerun 的精确失败证据；安装锁定依赖并构建。
2. Minimal fix：只给第三条 it 添加 `{ timeout: 60_000 }` 参数，保持测试体和其它两个测试逐字不变。优先使用尾参数避免整段重排。
3. Green：该文件单跑三次，记录测试耗时；运行 pnpm lint、pnpm -r build、pnpm test:packages:run。没有新增 shell 测试。
4. 比较 base 确认唯一测试差异是 timeout、生产代码零 diff；记录实际失败，不把 focused green 代替 aggregate green。
5. 提交进度、里程碑为开 PR 前最后提交，push/open PR；注册 code review 并获取有效 APPROVED，检查精确头所有 CI，特别是 Unit (teamlead 1 of 4)。
6. 报告并 complete --route needs_review --pr NUMBER；不派 QA、不 merge、不部署。QA 负责 C3 ship-report 模板托管 HTTP 200；交接提示用测量集大小 × 共享 2 核 runner 描述机制。

回滚：撤销唯一 timeout 参数即可。设计评审 APPROVED 前不改测试。

设计评审 a0482f6b-957d-48c2-ad04-aeda1dc1e251 round 1 APPROVED。采纳等价数字尾参数 `}, 60_000);`，避免 Vitest 3 弃用告警，测试体逐字保持。本地三跑仅为无回归证据，修复有效性仍需精确头 CI。成本表刷新留作 Lead follow-up。本地 aggregate 与 reviewer 所引舰队限制冲突已向 Lead 询问，等待决定。
