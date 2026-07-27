# FLY-1504 ship-on-comment 超时 — 实施计划

Issue: FLY-1504 (https://linear.app/geoforge3d/issue/FLY-1504/基建卡点-ship-on-comment-流水线-10-分钟超时-拦住所有-cool-ship)
日期: 2026-07-27
基于: research.md
Status: lead-approved(brainstorm gate,Tadashi 批准加速通道:方案、取值、注释先例、合入路径、follow-up 拆分全部确认)

## 改动(唯一)

`.github/workflows/ship-on-comment.yml` ship job:

```yaml
    # 30min, not 10 (FLY-1504): this single job runs setup+build+typecheck+lint
    # (3m08s measured) plus the FULL `pnpm test:packages:run` suite (packages in
    # topo order, <=4-way concurrent on the 4-core runner) — estimated ~18-20min
    # total from CI shard timings. Regular CI only fits ~10min wall-clock because
    # FLY-1338 split tests into 5 parallel 15-min-budget shards; this job never
    # followed. At 10min every :cool: ship got force-cancelled mid-Test (run
    # 30305893305: cancelled at 10m18s, Merge skipped). 30 leaves ~10-12min
    # headroom (~33-40% of the cap) and matches the payload-* workflows.
    timeout-minutes: 30
```

不碰其他任何行为:steps、concurrency、权限、merge 逻辑全部原样。

## 明确不做(已批)

- ship job 复用 PR CI 结论 / 只跑子集(改变 merge 前信任模型,留 follow-up)
- ship job 内并行 shard(复杂度不配一行止血)
- Blueprint.ts:2307 Runner 轮询窗口(产品代码,**FLY-1505** 承接;过渡期 Tadashi 运营指令兜底:ship 触发后未合入不许走 blocked)

## 合入路径(特殊)

`issue_comment` workflow 永远执行 main 上的定义 → 本 PR 走坏流水线自证死循环 → **Annie 在 GitHub 网页直接点 Merge**(她的权限;Lead/Runner 不代合)。PR 常规 CI(ci.yml)不受影响会正常跑绿。

## 验收

1. 本 PR 合入 main 后,FLY-1497(PR #710)重发 :cool:,job 跑完(预期 ~18–20min)且真 merge;
2. ship job 时长对 30min 上限余量 ≥ 30%。
