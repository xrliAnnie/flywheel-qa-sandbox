# FLY-1504 ship-on-comment 超时 — 调研

Issue: FLY-1504 (https://linear.app/geoforge3d/issue/FLY-1504/基建卡点-ship-on-comment-流水线-10-分钟超时-拦住所有-cool-ship)
日期: 2026-07-27
基于: exploration.md

> 精简版:Lead 在 brainstorm gate 批准走加速通道(基建卡点,堵着 2 张已批 + 4 张排队的 ship)。核心量化证据已在 exploration.md,本文只补齐实测数据表与结论出处。

## 实测数据

### 1. 失败 run(30305893305,step 级)

- 前置(Set up → Lint):21:12:54 → 21:16:02 = 3m08s,全 success
- Test(pnpm test:packages:run):21:16:02 起跑,21:23:07 被 cancel(跑了 7m05s)
- job 总时长 10m18s = `timeout-minutes: 10` 触顶;Merge / Report failure 均 skipped(job cancel 时 `if: failure()` 不触发)

### 2. 常规 CI 成功 run(30145247672,main,2026-07-25,墙钟 8m39s)

| Job | 耗时(含各自 ~2min setup/build) |
|-----|------|
| Quick Gate (build+typecheck+lint) | 3m05s |
| Unit (teamlead 1/3, 2/3, 3/3) | 5m32s / 5m57s / 5m07s |
| Unit (heavy) | 5m39s |
| Unit (light) | 2m54s |
| Script Tests | 8m28s |
| payload-distribution | 55s |

→ 折算 ship job 单机 Test 步(teamlead 三 shard 净测试 ~3.5–4min ×3 + heavy ~3.5min + light ~1min;包任务 pnpm 默认 ≤4 路并发但受限 4 核 runner,shard 折算给出的是量级估算而非实测)≈ 14–17min;加前置 3min → **job 全程估 ≈ 18–20min**(实测下界:Test 7m05s 被砍时远未结束;完整实测待合入后首跑回填)。

### 3. 超时取值先例

- `ci.yml`:quick-gate 10 / unit 矩阵 15 / script-tests 15 / payload 15(FLY-1338 拆分后)
- `payload-activation.yml` / `payload-beta-release.yml` / `payload-promote.yml`:均 30
- FLY-889(2026-07-05):同病同修 —— 当时 ci.yml 单 job 10→20,注释量化留档;其数据显示套件 22 天增长 30%+ → 本单取 20 余量不足,取 **30**

## 关键机制事实

1. `issue_comment` 触发的 workflow **永远执行 main 上的定义**(GitHub Actions 语义)→ 分支上的修复对 :cool: 无效 → 本 PR 必须由 Annie 在 GitHub 网页直接 Merge(死循环唯一解;Lead/Runner 不代合,FLY-945/248)。
2. `concurrency: ship-pr-<N>` + `cancel-in-progress: false` → 排除并发抢占;历史 `skipped` run 均为重复评论排队跳过。
3. 次生缺陷(不在本单):`Blueprint.ts:2307` Runner 协议 :cool: 后仅轮询 10min 即报 blocked,而 blocked 会作废活批准 → **FLY-1505**(Tadashi 已建单 + 已对 ship 中 runner 下临时硬指令:未合入不许走 blocked)。
