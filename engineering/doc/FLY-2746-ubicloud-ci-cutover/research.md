# FLY-2746 CI 切换 Ubicloud — 调研
Issue: FLY-2746 (https://linear.app/geoforge3d/issue/FLY-2746/ci切-ubicloud-ciyml-全部-job-从-ubuntu-latest-切到-ubicloudrepo-变量一键切换回滚先跑一次)
日期: 2026-09-18
基于: exploration.md

## 官方合同

### GitHub Actions runner 选择

- GitHub 的 [`jobs.<job_id>.runs-on` 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idruns-on) 明确允许一个“包含字符串的单变量”作为 runner selector；job 在发给 runner 前由 GitHub 解析。
- GitHub 的 [configuration variables 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables#using-the-vars-context-to-access-configuration-variable-values) 明确说明：未设置的 `vars` 属性返回空字符串，并展示 `runs-on: ${{ vars.RUNNER }}`。
- GitHub 的 [expression 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#operators) 列出 `||`，并说明空字符串属于 falsy。因此 `${{ vars.CI_RUNNER || 'ubuntu-latest' }}` 在变量缺失或为空时回到 `ubuntu-latest`。

### Ubicloud runner

- Ubicloud 的 [Runner Types](https://www.ubicloud.com/docs/github-actions-integration/runner-types) 列出 `ubicloud-standard-2`：Ubuntu 24.04、x64、2 vCPU、8 GB memory、75 GB disk。
- Ubicloud 的 [GitHub Actions Security](https://www.ubicloud.com/docs/github-actions-integration/security) 说明每个 job 使用干净的 ephemeral VM，完成后 VM 与 block storage 被销毁；JIT runner 至多执行一个 job。
- 官方规格与兼容声明不能代替本仓实跑。现有 canary 会打印 `RUNNER_NAME`、OS、CPU、memory、disk，并实际执行 Quick Gate/一个 unit shard/Script 2，因此它是切换前的仓库级兼容证据。

## 仓库基线

冻结实现基线：`bd2fc7dfe5ebabe281d4125c2114d382f7b1f7f0`。

| 文件 | SHA-256 | job / 当前 runner |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `b7e5d75ff1c7dec54d282d235012f17ca2a2eef72f48d6f739a80c3cb28f88c5` | `classify`, `quick-gate`, `unit-tests`, `script-tests`, `script-tests-2`, `script-tests-3`, `script-tests-4`, `script-tests-5`, `payload-distribution`, `ci-ok`；全部 `ubuntu-latest` |
| `.github/workflows/ship-on-comment.yml` | `ee0f64c6f4c48d94fea15ed5ca527c31979fbc27043291f014942838fa155d58` | `prepare`, `merge`, `report-failure`；全部 `ubuntu-latest` |

边界确认：

- 其他 workflow 的 Ubuntu runner 不在 FLY-2746 明示的 `ci.yml` + `ship-on-comment.yml` 范围。
- `ship-on-comment.yml` 的 3 个 job 都是 Linux job，没有 macOS 要求；它们必须跟随同一变量，否则“一键切换/回滚”不完整。
- `ci.yml` 的 `ci-ok` 聚合 job 也要切；保留 GitHub runner 会违反“全部 job runner_name 显示 Ubicloud”的硬验收。
- 当前变量列表没有 `UBICLOUD_CANARY_AUTHORIZED` 或 `CI_RUNNER`；canary run 列表为空；`UBICLOUD_CANARY_PROBE` secret 名也不存在。

## Canary 操作合同

现有 `.github/workflows/ci-ubicloud-canary.yml` 在选择 Ubicloud 时有两项 preflight 依赖：

1. `UBICLOUD_CANARY_AUTHORIZED=true`。
2. `UBICLOUD_CANARY_PROBE` 非空。该值仅验证 secret delivery，不承载生产权限，生成时不得打印、编码或持久化其值。

授权后的单次 payload dispatch：

```sh
gh variable set UBICLOUD_CANARY_AUTHORIZED --repo xrliAnnie/flywheel --body true
test "$(gh variable get UBICLOUD_CANARY_AUTHORIZED --repo xrliAnnie/flywheel)" = true
openssl rand -hex 32 | gh secret set UBICLOUD_CANARY_PROBE --repo xrliAnnie/flywheel
gh workflow run ci-ubicloud-canary.yml --repo xrliAnnie/flywheel --ref main \
  -f runner=ubicloud-standard-2 -f capacity=0
```

从 dispatch 后新出现的 run ID 绑定 receipt；等待结束后用 jobs API 核验 `quick-gate` 的 `runner_name`、labels 与 conclusion，并核验整个 workflow conclusion。完成取证后删除 canary-only variable 与 secret；`CI_RUNNER` 仍保持缺失。

## 测试设计

新增 `scripts/ci-ubicloud/__tests__/runner-variable.test.mjs`，并由已经在 Quick Gate 中执行的 `scripts/__tests__/workflow-startup.test.mjs` import，避免新增或跳过任何 workflow step。

测试先在当前基线变红，然后只改 runner 行变绿：

1. 动态遍历两个目标 workflow 的每个 job，断言 inventory 非空。
2. 断言每个当前及未来 job 的 `runs-on` 都精确等于 `vars.CI_RUNNER || 'ubuntu-latest'` 对应的 GitHub expression；新增 job 若漏接变量会自动失败。
3. “本 PR 只改 runner 行”属于一次性 diff 属性：实现时以 `git diff --unified=0` 逐行 fail-close，要求恰好 13 个旧 runner 删除和 13 个新表达式新增，并把结果写进 PR body；不把 live workflow 的整文件 hash 永久锁进 Quick Gate。
4. 现有 canary、workflow startup、CI structure、release/ship structure tests 不放宽且继续通过。

## 基线验证

在未改实现的 `bd2fc7dfe` 上已验证：

- `pnpm install --frozen-lockfile` 成功。
- `pnpm build` 成功。
- workflow startup validation：9 workflows。
- `workflow-startup.test.mjs`：15/15。
- canary contracts：2/2。
- `ci-structure.test.sh`：PASS。
- `release-workflows-structure.test.sh`：25/25。

这些结果只证明未改基线健康；不证明 Ubicloud canary 已运行或生产切换已完成。
