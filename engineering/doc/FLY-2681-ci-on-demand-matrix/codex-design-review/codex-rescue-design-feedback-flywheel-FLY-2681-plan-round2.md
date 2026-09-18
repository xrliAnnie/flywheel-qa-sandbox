# Design Review — plan.md (Round 2)

Date: 2026-09-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的七个方向都已进入计划正文：G4 例外被收窄到两个精确旧检查名并增加 Actions API 回验；`ensure` 改为复用 `withMkdirLock`、write-ahead 回执和同 run rerun；历史 run 不再读取当前 repo variable；main 复用不再下载 artifact；协议投影、rollout canary、`script-tests-5` 守卫和 clean-run 成本口径也已补齐。计划整体已接近可实施，但仍有三个阻塞缺口：`ensure` 用 run 原始 `createdAt` 排序，导致文档给出的 rerun 补救不能清除 `superseded_by_scoped_run`；G4 对 `gh pr checks` 的异常退出/超时仍可能接受部分 JSON；Actions API 回验仍未证明完整 16-job 全量形状。因此本轮不能批准。

本次复审绑定 commit `857c2918c3a47258fbf7cff1a5dd2ed2d94db7c8`；工作区 `plan.md` 与该 commit 的 blob 一致（SHA-256 `46912b9cbb508d3af555565ba7b1b5f8aec3e3c4888eb3c5d4ad65c5cb98a7ab`）。仓库中既有的 diagrams / founder HTML 未提交改动未被纳入或修改。

## What's Good (Keep)

- G4 的例外面现在是可审计的：只有严格早于最新 `CI OK`、名字恰为 `CI Scope OK` 或 `Unit (${{ matrix.name }})`、bucket 属于 `{skipping,cancel,pass}`、且 run id 不同的条目可豁免；更晚的 scoped Quick Gate 或其它非 pass 条目仍拒绝。
- `K` 不再靠 workflow display name 建立身份，而是通过 run API 绑定精确 head、`pull_request`、`.github/workflows/ci.yml`、本仓 repository/head_repository 与 completed success；jobs 查询要求零 skipped 并包含 `CI OK`。`gh pr checks` 当前版本确实提供计划使用的 `startedAt`、`event`、`workflow`、`link` 字段，退出码 8 表示 pending。
- `ensure` 的核心结构已经正确收敛：共享的 `withMkdirLock`、外发前原子回执、锁内重读 head、有回执不自动 toggle、cancelled 只自动 rerun 同一个 run 一次，以及对 action_required / neutral / skipped / stale / unknown 的闭合表，均解决了 Round 1 的主要 crash/concurrency 问题。
- full/scoped 身份不再读取当前 `CI_SCOPED_MODE`；on→off、off→on、旧头回访和 merge head 均被列入 C6。空 `mode` 命名为 `CI Scope OK` 也正确消除了“classify 前取消就留下 cancelled `CI OK`”的主要毒化路径。
- main 复用现在把 artifact 限定为树到 run id 的索引，不下载内容；候选 run 的仓库、workflow path、事件、最新 attempt jobs 与 git tree 都另行回验，且 classify 权限维持 `{contents: read, actions: read}`。C2 明确钉住不调用下载端点。
- C7 已包含 canonical 协议、`.flywheel/agents/nodes/{qa,implement}.md` 生成投影、`--write`/`--check` 与 FLY-2533 packed asset suite；上线前四项 canary 也覆盖 CLI、dist G4、fresh runner Blueprint 和协议投影。
- [verified by executing] 以禁止 `json.dump` 写盘的方式复跑 `data/replay.py`：clean single-attempt full green 样本为 `n=32`、median `139.0`、mean `141.1`，并复现 10,936 基线以及 59.2% / 46.4%（main 不复用）和 66.8% / 54.0%（main 复用）的常规/最坏数字；`FULL=140` 的两个 ±2 断言通过。
- [verified by executing] run `35151422945` 的 latest attempt 7 返回恰好 16 个 job、全部 success 且包含 `CI OK`，证明 `jobs?filter=latest` 能提供计划需要的 latest-attempt job 视图。

## Issues & Recommendations

1. **阻塞 — `superseded_by_scoped_run` 的 rerun 补救按当前排序合同永远无法生效。** §2.3 把 `N` 定义成 `F` 中 `createdAt` 最新的 run（第 220、229 行），随后用“是否有比 `N` 更新的 scoped run”决定返回 `superseded_by_scoped_run`，并要求运行 `gh run rerun <N>` 恢复（第 237、301、432 行）。但 rerun 只增加同一 run 的 attempt，不改变顶层 run 的原始 `created_at`。实际 run `35151422945` 已直接证明这一点：顶层 run 在 attempt 7 时仍为 `created_at=2026-09-16T21:16:13Z`，而 attempt 7 的 `run_started_at=2026-09-16T22:59:13Z`、jobs 从 `22:59:19Z` 开始。反例：full run A 在 21:00 绿，scoped run B 在 22:00 产生，按文档于 23:00 rerun A；G4 会因新的 `CI OK.startedAt` 晚于 B 而恢复为绿，但 `ensure` 仍按 A 的 21:00 `createdAt` 判断 B 更新，永久返回 1。QA 协议要求 PASS 前 `ensure == 0`，因此流程会被永久卡住。请为每个 run 定义“latest-attempt epoch”（可调用 `/actions/runs/{id}/attempts/{attempt}` 读取 `run_started_at`，或从 `jobs?filter=latest` 的时间戳严格推导），用它选择 `N`、比较 full/scoped 新旧，并与 G4 的 `K.startedAt` 语义对齐。C6 增加两条时序负控：A full → B scoped → rerun A 应为 0；A scoped → B full → rerun A scoped 应为 `superseded_by_scoped_run`。

2. **阻塞 — G4 会在 `gh pr checks` 超时或异常终止时接受可解析的部分 JSON，破坏 fail-closed。** §2.5 把执行器改成 `{stdout,status}`，但规范写成“stdout 能解析为非空数组就按规则判”，只对 `gh pr view` / `gh api` 明确要求非零即失败。子进程超时并不保证 stdout 为空。[verified by executing] Node `spawnSync` 子进程先输出一个合法的 pass JSON、再挂住并命中 timeout 时，结果是 `stdout` 合法、`status=null`、`signal=SIGTERM`、`error.code=ETIMEDOUT`。若部分输出恰好含合法 `K`、但尚未包含更晚的 fail/pending 条目，后续 K API 回验仍会通过，G4 会错误返回绿。请把正常终止纳入合同：runner 至少保留 `status`、`signal`/`error`（或等价 `timedOut`），`gh pr checks` 仅在无 signal/error 且 status 属于明确允许的正常集合（当前语义为 0、1、8）时解析；`null`、未知状态及其它 CLI/认证错误一律不绿。§4.2 增加“合法绿色前缀 + timeout/status null”“合法 JSON + 未知非零状态”的负控，同时保留 exit 1/8 的完整 JSON 用例。

3. **阻塞 — Round 1 要求的“完整 16-job 全绿形状”仍未被 G4 回验。** §2.5 第 5 条只要求 `total_count ≤ 100`、存在 `CI OK`、返回的每个 job 都 success；一个只剩 `Classify CI scope`、`Quick Gate`、`CI OK` 的 3-job run 也满足这些条件。计划自己在 §1.1 / §2.2 明确当前全量形状是 16 个检查，C2 对 main reuse 也至少要求 job 数 ≥16，但 G4 的 §4.2 没有“15 个或 3 个全 success job”负控。这意味着 job 图意外缩短或未产生某个重 job时，API 证明并没有证明“全量义务已满足”。请让 G4 校验由 `ci-structure` 同源钉住的完整 required job name multiset（或至少 `total_count == 16` 加精确必需名字），并新增缺任一 matrix row、缺任一 script shard、总数 15 但其余全 success 的负控；C2 的 full-shape 判断也应复用同一合同，避免两个验证器漂移。

## Verdict

CHANGES REQUESTED — fix the latest-attempt ordering, abnormal `gh pr checks` termination handling, and complete 16-job shape proof above
