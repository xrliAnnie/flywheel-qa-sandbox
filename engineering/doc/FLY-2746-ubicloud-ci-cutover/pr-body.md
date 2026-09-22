# FLY-2746 CI 切换 Ubicloud — PR 说明
Issue: FLY-2746 (https://linear.app/geoforge3d/issue/FLY-2746/ci切-ubicloud-ciyml-全部-job-从-ubuntu-latest-切到-ubicloudrepo-变量一键切换回滚先跑一次)
日期: 2026-09-18
基于: plan.md

## Summary

- 将 `.github/workflows/ci.yml` 的全部 job（实现时 10 个；合入 main 的 FLY-2755 六分片后为 11 个）改为 `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`。
- 将 `.github/workflows/ship-on-comment.yml` 的 3 个 job 改为独立变量 `runs-on: ${{ vars.SHIP_RUNNER || 'ubuntu-latest' }}`；原因与切换条件见下文「ship 路径为何不随 CI_RUNNER 切」。
- 新增解析真实 YAML 的回归测试 `scripts/ci-ubicloud/__tests__/runner-variable.test.mjs`：枚举 `.github/workflows/` 全目录，每个文件要么受 `CI_RUNNER` 合同约束、要么是带原因的显式排除项（`ship-on-comment.yml` 是显式排除项，并逐 job 断言使用 `SHIP_RUNNER`；canary 与 `payload-*.yml` 排除并注明原因）。新增或改名 workflow 会直接红。
- 保留所有测试、矩阵、权限和 job 条件；本 PR 不跳过、不删除、不弱化任何 CI job。

## Canary

Ubicloud Canary Run [`35395475216`](https://github.com/xrliAnnie/flywheel/actions/runs/35395475216) 在 `ubicloud-standard-2` 上成功。Quick Gate job `105763821476` 的 `runner_name=grv1p8pfjrge6nycxbkkgnhncp`，Unit、Script 2、Isolation Writer/Reader 同样分配到 `gr…` Ubicloud runner 并成功；完整逐 job 回执见 `engineering/doc/FLY-2746-ubicloud-ci-cutover/canary-receipt.md`。

## TDD 与定向验证

- RED：对实现前 blob `1e2cae6c2^` 运行同一枚举断言，首个 `ci.yml:classify` 即得到 `ubuntu-latest !== ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`。
- RED（round 3）：合同测试改为期望 ship job 使用 `SHIP_RUNNER` 后，在未改 workflow 时得到 `ship-on-comment.yml job prepare must use ${{ vars.SHIP_RUNNER || 'ubuntu-latest' }}`。
- GREEN：`node --test scripts/ci-ubicloud/__tests__/runner-variable.test.mjs scripts/__tests__/workflow-startup.test.mjs` — 21/21。
- GREEN：`bash scripts/__tests__/ship-merge-token.test.sh` 3/3、`bash scripts/__tests__/ship-report-failure.test.sh` PASS（ship 工作流的直接消费者）。
- GREEN：`bash scripts/__tests__/ci-structure.test.sh` — PASS。
- GREEN：`bash scripts/__tests__/release-workflows-structure.test.sh` — 25/25。
- 已完成 `pnpm lint`（0 errors，25 warnings，少于 main 的 25/26：合同测试里两处刻意包含 `${{ }}` 的字符串加了 `biome-ignore` 说明）与 `pnpm -r build`。

曾启动的全量 package suite 由 Lead 主动 SIGTERM；Lead 明确认定本 PR 仅改 workflow、与包级全量无共享代码路径，并要求不再重跑，只以以上定向验证和 exact-head PR CI 为准。终止前出现的两个包级观测均不在本分支差异中，其中 retry-route 用例隔离复跑 1/1 通过；`offline-inventory` 在当前 `origin/main` 同代码上仍越过既有 5 秒时限，本 PR 未修改或跳过该测试。

## exact-head CI（Ubicloud 上的第一次全量运行）

Run [`35572539036`](https://github.com/xrliAnnie/flywheel/actions/runs/35572539036)（head `407110cdc`，`CI_RUNNER=ubicloud-standard-2`）：17 个 job 的 `runner_name` 全部是 Ubicloud runner（`gr…`），labels 全为 `ubicloud-standard-2`，无一落回 GitHub-hosted；16 个 job 成功，最长分片 Script Tests 4/6 797s、最长 job Unit (teamlead 2 of 4) 827s，均在 1020s 预算内。逐 job 表见 `canary-receipt.md`「exact-head CI 回执」。

第二次同头 CI（run [`35576396527`](https://github.com/xrliAnnie/flywheel/actions/runs/35576396527)，head `0a340bbf7`，加宽等待上限之后）：17 个 job 仍全部在 Ubicloud runner 上；`fly1697-v2-lease-body` 全部 18 用例通过（同一步骤 8.3s）；两处红分别是 Quick Gate lint（本 PR 新合同测试两行未按 biome formatter 换行，已修）与 Script Tests 6/6 里 `scripts/test-cmux-sync-hooks-integration.sh` 的 Scenario F（`reset_scenario` 先 `kill-server` 再立即 `new-session`，日志出现 `no server running on …tmux-hooks-integration.sock`；同一场景在前一次 Ubicloud 运行与 main 的 GitHub-hosted 运行均通过，经 Lead 裁定按「Ubicloud 差异二」处理，见下节）。

第一次同头 CI 的唯一红点是 Script Tests 6/6 里 `scripts/__tests__/fly1697-v2-lease-body.test.sh` 的两个「Claude 子进程 10 秒内出现」断言：该测试 `start_body` 只等 200×0.05s，而 launcher 在拉子进程前的启动链 + bootstrap 失败后的固定 3s sleep 在 GitHub-hosted main 上最近一次已经跑到 10.0s（run `35570340588`），Ubicloud standard-2 慢约 1s 即越线（10.5s）。该断言两侧的被测脚本本 PR 未动，本地 18/18 通过；处置见下方「Ubicloud 差异」。

## Ubicloud 差异

本次切换发现的唯一差异是**启动时序余量**，不是工具缺失或产品行为差异。`scripts/__tests__/fly1697-v2-lease-body.test.sh` 的 `start_body` 用 200×0.05s≈10s 的上限等待 Claude 子进程写出 env 文件，同一步骤（`pre-materialize` → `live v2 body`）的四个样本：

| 样本 | Runner | Run | 耗时 | 结果 |
| --- | --- | --- | ---: | --- |
| QA1，2026-09-19 | `ubicloud-standard-2` | `35424774620` | 8.6s | 过 |
| main `58078bfee` | GitHub-hosted `ubuntu-latest` | `35554025391` | 8.7s | 过 |
| main `e82193650` | GitHub-hosted `ubuntu-latest` | `35570340588` | 10.0s | 过（贴线） |
| 本 PR `407110cdc` | `ubicloud-standard-2` | `35572539036` | 10.5s | 败 |

launcher 在拉起子进程前要跑 bin 收敛、launchd 普查、规则拼装、上下文恢复门与对不存在 Bridge 的 bootstrap curl（必败后固定 `interruptible_sleep 3`），main 上已经贴着 10s；standard-2 慢约 1s 即越线。自 QA1 绿以来启动链只有 `487799b80`（FLY-2523）动过。

**改动（差异一）**：经 Lead 2026-09-21 明确授权，本 PR 只把该测试 `start_body` 的轮询上限从 200 提到 600（≈30s）。不改任何断言、不改被测脚本 `claude-lead.sh` / `lead-body.sh`；子进程仍必须真的出现并写出正确的 lease/summary 投影，超时依旧失败。issue 的「不改测试内容」指断言与被测语义，等待上限不属于其中（Lead 裁定原文见 Discord/问答 `8b45187c`）。

### 差异二：cmux-sync Scenario F 在 standard-2 上 kill-server → new-session 竞争

`scripts/test-cmux-sync-hooks-integration.sh` 的 Scenario F（FLY-1272 linked view）在 Ubicloud 上 0/2（run `35576396527`、`35581822376`；第一次 run 该步骤因前置步骤先红被跳过），GitHub-hosted main 同场景稳过，两边 tmux 都是 3.4，同一 job 里 Scenario I/E 的 `new-session` 都成功。失败形态是从场景标题到 `no server running on …/tmux-hooks-integration.sock` 只隔 20ms，而三条建环境命令都 `2>/dev/null`，真实 tmux 错误没进日志。Lead 同晚在 FLY-2693 的 PR 上也观察到同一场景连败两次，判定为 standard-2 上 `reset_scenario` 的 `kill-server` 返回后 server 尚未退出、紧接着的 `new-session` 撞上垂死 server 的时序问题，而非抖动。

**改动（差异二）**：经 Lead 2026-09-21 授权，① Scenario F 的 `new-session` / `new-window` 不再吞 stderr，失败时真实 tmux 错误进 CI 日志；② `reset_scenario` 在 `kill-server` 后有界轮询（≤40×0.05s=2s）`has-session`，等 server 真正消失再进入下一场景。不动任何断言；本地 macOS（tmux 3.7c）13/13 通过。

## 主线同步

本分支已合入 `origin/main`（到 e82193650，含 FLY-2755 六分片、FLY-2753 定向验证、FLY-2763 同家族评审），合并后 `runner-variable.test.mjs` 仍枚举全部 11+3 个 job 通过；本 PR 对 main 的差异未新增任何硬编码 runner。

## 切换与回滚

- `ci.yml` 11 个 job：repository variable `CI_RUNNER` 决定 runner，删除即回退 `ubuntu-latest`，切换/回滚都不需要 PR。
- `ship-on-comment.yml` 3 个 job：repository variable `SHIP_RUNNER` 决定 runner，语义同上；本 PR 合入时 `SHIP_RUNNER` 不存在，ship 路径继续在 `ubuntu-latest`。
- 实现节点未激活生产切换；`CI_RUNNER=ubicloud-standard-2` 由 QA 于 2026-09-19T05:44Z 设置（QA1 已在该变量下跑绿 16 个 job），本轮 exact-head CI 即在 Ubicloud 上运行。
- 注意：`ship-on-comment.yml` 持有 `secrets.SHIP_PAT || secrets.GITHUB_TOKEN` 与 land-ticket 公钥并对受保护 `main` 做 squash-merge，`scripts/ci-ubicloud/README.md` 的「Current repository baseline」已同步写明，避免读者把 Ubicloud 路径当成无密钥路径。

## ship 路径为何不随 CI_RUNNER 切

issue 边界允许「某 job 在 Ubicloud 上有真实差异时只对该 job 保留 `ubuntu-latest` 并写明原因」。ship 工作流满足这一条，且 Lead 已于 2026-09-21 同意：

1. `issue_comment` 工作流只从默认分支加载，合并前无法在 Ubicloud 上跑一次 ship 路径（此前 `CI_RUNNER` 已设的情况下，ship run `35429540936` / `35553999891` / `35570304439` 仍全在 GitHub-hosted runner 上）。跟着 `CI_RUNNER` 走等于在合并瞬间盲切仓库的合并授权路径。
2. `ci.yml` 没有任何 job 使用 `actions/github-script` 或真实 `gh` CLI，而 ship 三个 job 都用 `actions/github-script@v7`，`prepare` 还依赖 `scripts/ship-await-ci.sh` 里的 `gh`、`jq`、`timeout`。Ubicloud 上这些依赖没有被任何绿灯证明过。
3. 失败形态是静默的：`ship-await-ci.sh` 里 `gh` 缺失会被 `2>/dev/null` 吞掉，循环空转满 1500s 后报 `await_ci_timeout`，与真实 CI 超时不可区分；而 `prepare` 在此之前已写入 `status=started` 回执，重放守卫会拒绝同一 ticket 重试，等于烧掉一张 land ticket。

**切换条件**：在目标 Ubicloud label 上拿到一次 `gh --version`、`jq --version`、`timeout --version` 和一个 `actions/github-script@v7` 步骤成功的回执（最便宜的做法是 `main` 上一个 `workflow_dispatch` smoke job），再设 `SHIP_RUNNER=ubicloud-standard-2`；出问题删除变量即回滚。

## Follow-ups（不开新 issue，按 founder 2026-09-20 直令）

- 拿到上述 Ubicloud 依赖回执后设置 `SHIP_RUNNER=ubicloud-standard-2`，并保存第一张真实 ship run 三个 job 的 `runner_name`。
- 合入后保存第一张真实 PR 全部 job 的 Ubicloud `runner_name` 与全绿 CI；随后删除 `CI_RUNNER`，保存下一次 run 回到 `ubuntu-latest` 的 run ID（回滚演练）。
- canary 冻结 fixture 与现网 `ci.yml` 的漂移已记录在 `canary-receipt.md`「限制」一节；下次刷新 canary payload 时按 README 流程更新 fixture 与 `sourceFixtureSha256`。

## 验收边界

本 PR 交付 canary 硬证据与可逆配置机制。合入后的后继节点仍须补齐两张生产回执：第一张真实 PR 全部 job 运行在 Ubicloud 且全绿；删除变量后的下一次 run 回到 `ubuntu-latest`。本 PR 不操作 Ubicloud 账号或计费设置，不收窄 GitHub App，不合并、不部署、不 dispatch QA。
