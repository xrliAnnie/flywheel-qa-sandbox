# FLY-889 CI job 超时贴边缓解 — 调研

Issue: FLY-889 (https://linear.app/geoforge3d/issue/FLY-889/infraci-ci-job-贴近-10-分钟超时上限-50percent-run-timeout-cancelfleet-wide)
日期: 2026-07-05
基于: `exploration.md`

## 方法

用 `gh run list` / `gh run view --json jobs` / `gh run view --log` 拉取 `ci.yml`（workflow: CI，job: Build & Test）最近的真实 run 数据，逐 run、逐 job-step、逐 vitest-package 打时间戳，不靠猜测。

## 当前 workflow 结构（`.github/workflows/ci.yml`）

单一 job `build-and-test`，`timeout-minutes: 10`，`concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`。18 个 step，顺序执行：

```
checkout → pnpm/action-setup → setup-node → git config → pnpm install
→ install better-sqlite3 prebuilt → Build → Typecheck → Lint
→ Test (pnpm test:packages:run)                                  ← 唯一的大头
→ apt-get install tmux → cmux-sync 集成测试
→ apt-get install lsof → FLY-183 orphan-reaper 测试
→ FLY-519 fleet provisioning 测试(4条bash脚本)
→ FLY-513 global-codex repoint 测试
→ apt-get install sqlite3 → FLY-697 codex-log-guard 测试
```

## 发现 1:timeout-cancel 的真实占比

拉了最近 100 次 run（`gh run list --workflow=ci.yml --limit 100`），按 conclusion 分类，并把 `cancelled` 进一步用**job 级** `startedAt`/`completedAt`（不是 run 级 `createdAt`/`updatedAt`，避免把排队时间算进去）区分「真超时」vs「被新 push 顶掉（`cancel-in-progress`）」：

| 分类 | 数量 | 占比 |
|---|---|---|
| success | 48 | 48% |
| failure（真测试失败） | 21 | 21% |
| **timeout-cancel（job 实跑 550-650s 被砍）** | **14** | **14%** |
| superseded-cancel（新 push 提前顶掉，非本次 root cause） | 16 | 17% |

全量 PR 分支样本里 timeout-cancel 绝对占比是 14%，但 issue 描述的"~50%"是针对 **main 分支** 的观察（FLY-882 runner 原话："查 main 近 10 次 CI，半数 timeout-cancel"）。单独看 main 分支最近 15 次 push run：刨掉同一次 squash-merge 触发的连续快速 supersede-cancel（那些几秒内就被顶掉，不是超时），剩下"真正跑完/跑到超时"的 run 里，success 与 timeout-cancel 大致各占一半——与 issue 描述吻合。两种口径都成立，只是统计口径（全量 PR run vs main 分支 push run）不同。

## 发现 2:超时到底卡在哪一步（推翻 issue 的初始假设)

issue 原文推测「常卡在跟当前 PR 无关的慢 step（如 FLY-183 orphan-reaper）」。抽样几个 timeout-cancel run 的 job step 明细（例:run `28731368650`,main 分支,2026-07-05T06:00 UTC）：

| # | Step | 耗时 |
|---|---|---|
| 1-7 | checkout/pnpm/node/install/better-sqlite3 | ~19s |
| 8 | Build | 49s |
| 9 | Typecheck | 43s |
| 10 | Lint | 6s |
| **11** | **Test（`pnpm test:packages:run`）** | **447s** |
| 12 | Install tmux | 9s |
| 13 | cmux-sync 集成测试 | 8s |
| 14 | Install lsof | 2s |
| 15 | FLY-183 orphan-reaper 测试 | 11s |
| 16 | FLY-519 fleet 测试 | 1s |
| 17 | FLY-513 repoint 测试 | 1s |
| 18 | Install sqlite3 | **cancelled**（此 run 卡在这里，10m09s 处被砍） |

另外 3 个 timeout-cancel run（`28729303784`/`28744857161`/`28733986132`）里，砍的位置分别落在 step 15 之后、17 之后、16 之后——**每次都不一样，且都不是"慢"步骤本身**，纯粹是运气：前面攒下的耗时越多，越早被砍在越靠前的位置。FLY-183 reaper 测试本身只要 ~10s。这证伪了"卡在某个特定慢 step"的假设——真正的问题是 `Test` step 一家独大，把 600s 预算吃掉 75%，后面 30-40s 的 hermetic 脚本测试只是在"剩下的一点点余量"里赌运气。

## 发现 3:`Test` step 内部——`teamlead` 包是真凶

`pnpm test:packages:run` = `pnpm --filter './packages/*' test:run`,在 14 个有测试的包上跑。用 `gh run view --log` 把 vitest 每个 package 的启动行（`packages/X test:run$ vitest run`）和收尾行（`Test Files ... passed`）时间戳全部拉出来（run `28729303784`,Test step 04:22:06 → 04:29:32,共 446s）：

| package | 测试文件数 | 完成时刻 | 单独耗时（估） |
|---|---:|---|---|
| config | 19 | 04:22:17 | 快 |
| core | 18 | 04:22:17 | 快 |
| dag-resolver | 2 | 04:22:19 | 快 |
| qa-framework | 6 | 04:22:23 | 快 |
| token-usage | 11 | 04:22:24 | 快 |
| github-event-transport | 4 | 04:22:28 | 快 |
| linear-event-transport | 1 | 04:22:30 | 快 |
| slack-event-transport | 3 | 04:22:33 | 快 |
| flywheel-comm | 50 | 04:23:06 | ~40s |
| claude-runner | 17 | 04:23:25 | ~19s |
| edge-worker | 88 | 04:24:26 | ~61s |
| **teamlead** | **349** | **04:29:31** | **~304s（5m04s）** |
| agent-team-transport / terminal-mcp | 12 / 3 | （无独立 `test:run` 脚本入口，未在此列出现） | — |

`teamlead` 的 349 个测试文件是第二名 `edge-worker`（88 个）的 ~4 倍，是全部其余 13 个包测试文件总数（~155）的两倍还多。而且它单独跑掉的 304s，就已经占了整个 `Test` step 447s 的 **68%**。

`pnpm --filter` 默认按 workspace 依赖拓扑顺序调度（结合并发上限），`teamlead` 的 `package.json` 依赖了 `flywheel-agent-team-transport` / `flywheel-claude-runner` / `flywheel-comm` / `flywheel-config` / `flywheel-core` / `flywheel-edge-worker`（均为 `workspace:*`）——是全仓依赖链最深的包。日志里能看到它稳定在 `edge-worker` 完成的**同一刻**才开始（04:24:26 → 04:24:27），说明并发调度器把它排在了拓扑序的最后一档：不管并发上限设多高，`teamlead` 都无法在 `edge-worker`（它的依赖）跑完前开始。也就是说，就算把并发拉满，关键路径（critical path）也至少是 `config/core 起步 → claude-runner(~19s) → edge-worker(~61s) → teamlead(~304s)` ≈ 384s+ 打底，这是 **B 方案（拆 job）** 要处理的问题，本次 A+C 不动它。

## 发现 4:其余小项

- 3 处 `sudo apt-get update && sudo apt-get install -y <pkg>`（tmux/lsof/sqlite3）各自独立执行，每次 `apt-get update` 都要重新拉包索引，实测每处 ~5-11s，合并成一处可省 ~15-20s。
- 未发现 `teamlead` 测试文件里有大量真实 `setTimeout` sleep 拖慢整体（grep 出 7 个文件有 ≥200ms 的真实 sleep，量级不足以解释 5 分钟）；304s 主要是 349 个文件的 vitest worker 启动 + 模块转译开销在有限 CPU 并发下的累加，不是个别测试写得慢。这一点留给 B/follow-up 深挖（例如 vitest pool/isolate 配置、`--shard` 分片），本次不展开。
- GitHub-hosted `ubuntu-latest`(ubuntu24 镜像)标准 runner 的具体 vCPU 数未在日志中直接打印出来，只能确认是标准 hosted runner、非 larger runner；这属于 B 方案调研范围,本次不需要确认。

## 结论对 A 方案数值的支撑

`Test` step 447-467s + 前置 ~100-120s + 后置 hermetic 测试 ~40-60s + apt-get 开销 ~15-30s ≈ 总耗时稳定落在 **~600-650s（10-11 分钟）区间的上沿**，这与"贴着 10 分钟硬顶跑"的症状描述完全吻合。改成 20 分钟（1200s）给出 ~500-550s 的净余量（相对当前 ~750s 总耗时约 60%+ headroom），足以吸收 GitHub-hosted 共享 runner 常见的速度抖动，且不需要精确调参——这也是 Tadashi 拍板的数值。
