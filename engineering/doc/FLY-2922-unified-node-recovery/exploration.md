# FLY-2922 held 统一恢复口 · QA@3 返工 — 探索
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: 无

## 1. 这一轮要解决什么

产品设计（统一恢复口：删多种 hold 类型只留一个「重派当前节点」出口、放行必须真铸出派发、complete 不先翻终态、关死体不连带终结 run）**已于先前轮次 APPROVED**（gate d9ab4f85，plan c4d40fbed），并已在 PR #1374 实现。本轮是 **QA@3 FAIL 返工重开**，不重新打开产品设计，只处理 QA 给出的两条结论：

| # | QA 结论 | 性质 |
|---|---------|------|
| 1 | slot 4 真房跑 `qa-529-generalized-e2e.mjs 4 --issue FLY-2922 --real`，卡在 step 4「implement ship park」近 2h | **QA harness（driver）缺陷**，不是产品缺陷 |
| 2 | PR 头被推到 36b143b2（未经 QA 交接的 main sync），且与 origin/main 在 `scripts/test-deploy.sh` 冲突（DIRTY） | **分支卫生**：需 merge origin/main 并解冲突 |

## 2. 现象复盘（driver 缺陷）

- 房内真相：实现体 08ed6083 已 `ship_parked` / `pr_created`，QA 节点已派出——即 step 4 期望的状态**已经成立**。
- driver 判定：`classifyImplementPark` 需要 `liveness=alive`，而 driver 探 pane 时用的是**宿主机** tmux 命名空间（未带房间的 `TMUX_TMPDIR=/tmp/flywheel-test-slot-N`），在宿主 tmux server 上找不到 `runner-test-slot-4:@5` → 判 dead → 分类永远返回 `null` → step 4 永不通过。
- 房间隔离合同：`scripts/lib/qa-slot-env-contract.json` 规定房间 Bridge 以 `TMUX_TMPDIR=<slotDir>` 起 runner pane，所以 pane 只活在房间自己的 tmux server socket（`<slotDir>/tmux-<uid>/default`）上。

一句话：**房间里的人活着，driver 却敲错了门（问了宿主机的 tmux），于是以为人死了。**

## 3. 审计范围（本轮会碰/不碰的消费者）

审计了 PR 头的 `scripts/qa-529-generalized-e2e.mjs` 与 `scripts/lib/qa-generalized-e2e-lib.mjs`：

- driver 里**唯一**的 tmux 调用是 `probeExecution → pane 探活`（`display-message -p -t <target> "#{window_id}|#{pane_id}|#{pane_dead}|#{@flywheel_exec_id}"`）；没有 capture-pane、send-keys 等其它 tmux 调用 → 修一处即可覆盖全部 tmux 面。
- `processAlive(pid)` 走 `kill(pid,0)`，与 tmux 命名空间无关，不动。
- `classifyImplementPark` 的分类规则本身正确（给定 alive 即返回 `rework_reachable_wait`），**不改规则，只修输入**。
- 产品代码（StateStore hold / resume 处理器 / complete 顺序 / carrier-close 级联）**一行不动**。

## 4. 待定问题与我的默认答案（非阻塞）

| 问题 | 默认答案 | 理由 |
|------|---------|------|
| 用 `TMUX_TMPDIR` 还是 `-S <socket>`？ | `TMUX_TMPDIR=<slotDir>` 注入子进程 env | 与房间合同同一个真相来源；`-S` 需自己拼 `tmux-<uid>/default`，复制了 tmux 的路径规则 |
| 宿主 `TMUX` / `TMUX_PANE` 要不要清？ | 清 | 在 tmux 里跑 driver 时 `TMUX` 会把客户端钉到宿主 server，`TMUX_TMPDIR` 失效 |
| slotDir 缺失/相对路径怎么办？ | fail-closed 抛错 | 静默回落到宿主命名空间就是本 bug 本身 |
| test-deploy.sh 冲突取舍？ | 两边都保留（main 侧 FLY-2405 起房拆房 / FLY-2902 等 + 本分支 generalized 房间逻辑） | Lead 指令；两侧为加性改动 |
