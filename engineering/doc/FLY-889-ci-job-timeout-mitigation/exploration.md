# FLY-889 CI job 超时贴边缓解 — 探索

Issue: FLY-889 (https://linear.app/geoforge3d/issue/FLY-889/infraci-ci-job-贴近-10-分钟超时上限-50percent-run-timeout-cancelfleet-wide)
日期: 2026-07-05
基于: 无

## 问题回顾

`.github/workflows/ci.yml` 的 `Build & Test` job 硬顶 `timeout-minutes: 10`。实测约一半「真正跑到底、没被新 push 提前顶掉」的 run 会精确卡在 ~600s 附近被 GitHub 判 `exceeded maximum execution time` 强制 cancel，而不是测试失败。更严重的是：timeout-cancel 会**掩盖真 bug**（FLY-882 PR #452 的先例——第一次红是 timeout-cancel，retry 后才跑得够远暴露出 `_pool_file_mode` 的 BSD/GNU `stat` 跨平台真 bug）。

## 我的假设 vs 实测结果

issue 原文猜测「常卡在跟当前 PR 无关的慢 step（如 FLY-183 orphan-reaper）」——**这个假设被数据推翻**。拉了近 100 次 CI run 的 job/step 级时间戳后发现：

- FLY-183 orphan-reaper 测试实际只要 ~10s，根本不慢。
- cancel 卡在哪一步是**随机的**——纯粹取决于前面已经吃掉了多少预算，跟那一步本身是不是"慢步骤"无关。
- 真正吃时间的是单一的 `Test` step（`pnpm test:packages:run`），稳定 446-467s，占 600s 预算的 ~75%。
- 再往下拆到 per-package 时间戳：`teamlead` 包（349 个测试文件，是第二大 `edge-worker`（88 个）的 4 倍）在 pnpm workspace 拓扑依赖链的最末端（`core/config → claude-runner → edge-worker → teamlead`），必须等前面全部跑完才轮到它执行，它自己单独跑就要 ~5 分钟。

详细数据见 `research.md`。

## 与 Lead（Tadashi）的 brainstorm 结论

通过 `flywheel-comm gate brainstorm` 对齐（记录见下），确认方案与范围：

**这个 PR 只做 A + C，B 和 D 明确排除在外（各自开 follow-up）：**

- **A（立即止血）**：`timeout-minutes` 10 → 20。实测 suite 总耗时 ~750s（Test ~450s + 前后其余 step ~150-190s + apt-get 开销），20 分钟给 ~60% headroom，足够且稳，不用精算到刚刚好。
- **C（顺手免费）**：3 处 `apt-get update && apt-get install -y <pkg>`（tmux / lsof / sqlite3）合并成 1 处，省 ~15-20s，风险几乎为零。
- **B（治本：拆 job 并行）明确排除，记为 follow-up**：把 `teamlead` 测试拆成独立 job、其余包 + hermetic bash 脚本测试合并另一 job（两-job 拆法，非 per-package 14-job matrix——checkout/install/build 重复 14 次反而更慢）。排除理由：当前 FLY-882 / FLY-886 / FLY-887 三个 PR 都在等这条 CI 线绿了才能被 Annie 早上 merge，**优先级要求最快、最低风险**把线抬起来；B 涉及 job 间共享 build 产物/artifact 上传下载/job 依赖，属于需要自己反复验证绿的迭代性改动，不能拖住这个"现在就要"的止血 PR。
- **D（`concurrency: cancel-in-progress` race，FLY-871 已认领）明确排除**：不同 root cause，不并入本次 scope，plan 里提一句即可。

Tadashi 追加提示：做 B 的 follow-up 时，自己跑 `git log .github/workflows/ci.yml` 查一下这个 workflow 是否有拆分-合并的历史，以及 GitHub Actions 对本仓库并发 job 是否有额度限制——他自己也不确定，需要执行者到时候查。

## 范围边界

- 只改 `.github/workflows/ci.yml`，不碰任何业务代码。
- 不新增/修改任何测试逻辑本身（root cause 不是"测试写错了"，是"总量 + 拓扑顺序 + 单 job 硬顶时间"）。
- follow-up 项（不在本次 PR 内，仅记录）：
  1. FLY-889-B：拆分 `Build & Test` job（teamlead 单独 job + 其余合并 job），需要新开 issue 或作为本 issue phase-2 处理。
  2. FLY-871：`concurrency: cancel-in-progress` race，已有独立 owner，不动。
