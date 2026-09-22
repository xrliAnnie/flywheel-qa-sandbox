# FLY-2746 CI 切换 Ubicloud — 探索
Issue: FLY-2746 (https://linear.app/geoforge3d/issue/FLY-2746/ci切-ubicloud-ciyml-全部-job-从-ubuntu-latest-切到-ubicloudrepo-变量一键切换回滚先跑一次)
日期: 2026-09-18
基于: 无

## 目标与已锁定顺序

founder 已要求立即把主 CI 从 GitHub-hosted runner 切到 Ubicloud，以避免继续产生 GitHub Actions 计费。实现节点必须保持以下顺序：

1. 在默认分支上授权并运行现有 `Ubicloud Canary`，证明工作负载实际分配到 Ubicloud，且 Quick Gate 通过。
2. 只把 `.github/workflows/ci.yml` 与 `.github/workflows/ship-on-comment.yml` 的 job runner 改成 repo 变量控制、缺省回到 `ubuntu-latest`。
3. 提交、有效代码评审、推送并创建 PR；实现节点不得 merge、不得提前设置生产 `CI_RUNNER`、不得派发 QA。
4. PR 合入后的生产切换、第一张真实 PR、删除变量回滚演练由后续授权节点执行，并以真实 run/job receipt 验收。

## 当前事实

- `main` 当前为 `bd2fc7dfe5ebabe281d4125c2114d382f7b1f7f0`，包含已合入的 FLY-2681 同头全量 CI 能力，也包含 FLY-2684 的 `Ubicloud Canary` 工作流。
- FLY-2684 PR #1244 已于 2026-09-18 合入；现有 canary 是手工触发、默认分支限定，并允许 `ubicloud-standard-2`。
- repo 变量中没有 `UBICLOUD_CANARY_AUTHORIZED` 或 `CI_RUNNER`；canary 历史 run 为空。
- canary payload 的 Quick Gate 使用所选 runner，且会输出公开的 `RUNNER_NAME`。现有工作流还要求一个随机、无生产权限的 `UBICLOUD_CANARY_PROBE` test secret；当前该 secret 不存在。
- `.github/workflows/ci.yml` 有 10 个 job，全部硬写 `runs-on: ubuntu-latest`。
- `.github/workflows/ship-on-comment.yml` 有 3 个 job，全部硬写 `runs-on: ubuntu-latest`。
- payload/release workflows 也有 Ubuntu runner，但不在本 issue 明示范围内，保持不动。
- 当前 GitHub 凭据有 `repo` 与 `workflow` scopes；是否允许 repo variable/secret 写入必须以实际命令结果为准。

## 不变量

- runner 表达式固定为 `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`；缺失或空值回退到 GitHub runner。
- 不改变 workflow 触发器、permissions、concurrency、job id/name、needs/if、timeout、matrix、step、命令或 required-check 名称。
- 不修改、删除、跳过任何测试或 job 来获得绿色结果。
- `CI_RUNNER` 在 PR 合入前保持缺失，避免在飞 PR 无预警换机。
- canary 的生产外部改动仅限专用 authorization variable 与随机 test secret；完成取证后清理这两个 canary-only 值。
- 不动 Ubicloud 账号、计费、tier 或 GitHub App scope；App 收窄属于 FLY-2718。

## 可选做法

### A. 每个目标 job 直接读取一个 repo 变量（采用）

在 13 个目标 job 上逐字使用同一表达式。优点是完全符合 founder 要求，切换与回滚只需一个 repo variable，且缺省安全回到现状。缺点是表达式重复，需要结构测试防止未来 job 漏接。

### B. 用矩阵或 reusable workflow 集中 runner 选择

可以减少重复，但会改 job graph、调用边界和 required-check 行为，超出本 issue 的 runner-only 变更，风险高于收益。

### C. 用 YAML anchor 复用表达式

GitHub Actions 对 YAML 能力和 actionlint/startup 校验有自身约束；引入 anchor 只为减少 13 行重复，增加解析风险且没有运营收益。

## 结论

采用 A。先用现有 canary 获得真实 Ubicloud runner receipt，再以测试锁定 10+3 个 job、一条变量名、缺省回退及“除 runner 行外字节不变”，最后做最小替换。post-merge 激活与回滚证据不在 implement 节点伪造或提前执行。
