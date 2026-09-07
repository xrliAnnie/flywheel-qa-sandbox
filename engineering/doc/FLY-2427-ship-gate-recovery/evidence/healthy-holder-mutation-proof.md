# FLY-2427 Ship gate 死卡收敛 — 健康 holder mutation 证明
Issue: FLY-2427 (https://linear.app/geoforge3d/issue/FLY-2427/批准通路-lead-对-approve-to-ship-gate-的非批准回复被接受并消耗掉这道门却不铸-source-event)
日期: 2026-09-07
基于: plan.md

2026-09-07T19:33:11Z 手工把收敛命中条件从：

```ts
!inspection.answerable && !inspection.founderSourceEventExists
```

临时放宽为仅检查 `!inspection.founderSourceEventExists`，然后执行：

```bash
pnpm exec vitest run \
  src/bridge/__tests__/unanswerable-workflow-gate-reconciler.test.ts \
  -t "recovers only an unanswerable source-less question"
```

预期红，exit 非 0。关键 diff：

```text
newQuestionIds:
  replacement-broken
+ replacement-healthy
- recovered: 1
- skipped: 2
+ recovered: 2
+ skipped: 1
```

随后立即恢复严格条件，同一命令为 `1 passed, 5 skipped`。生产副本的独立逐字段
对照还证明四个健康 holder 及其 gate-node 数组全部 unchanged；因此该测试不是
“收敛器碰巧没报错”的假绿，命中条件一旦放宽会直接把健康卡算作新卡并红。
