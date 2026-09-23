# FLY-2791 CI 开销与作业梳理 — 调研

Issue: FLY-2791 (https://linear.app/geoforge3d/issue/FLY-2791/ci开销与作业梳理-调研迁-ubicloud-后-ci-实际花多少是否比-github-时期更省)
日期: 2026-09-22
基于: exploration.md

---

## 0. 先说数据来源与它的边界

| 项 | 状态 |
|---|---|
| **真实账单（GitHub）** | **未取得**。本机 `gh` token scope 只有 `gist, read:org, repo, workflow`;`GET /users/xrliAnnie/settings/billing/actions` 与 `/settings/billing/usage` 均返回 `404 + "This API operation needs the \"user\" scope"`(2026-09-23 实测)。本单边界不允许改 auth,未执行 `gh auth refresh`。 |
| **真实账单（Ubicloud）** | **未取得**。Ubicloud 用量与账单只在控制台 `/project/<ubid>/billing`,无 CLI/API 路径(FLY-2718 已实测控制台形状)。 |
| **GitHub 自己的计费读数 `/actions/runs/{id}/timing`** | **不可用**。对本仓所有 run 都返回 `billable.UBUNTU.total_ms = 0`、每个 `job_runs[].duration_ms = 0`,包括确认是 `ubuntu-latest` 的 17-job run `35677235982`。这是该端点在新计费平台下的已知失真,**不能**当账单用。 |
| **真实用量（本报告的地面真值）** | **已取得**。`GET /repos/xrliAnnie/flywheel/actions/workflows/*/runs` + `GET /actions/runs/{id}/jobs`,逐 job 的 `started_at / completed_at / conclusion / labels`。这是**真实发生的机器时间**,不是估算。 |
| **金额** | **是折算,不是账单**:真实用量 × 各家**公开挂牌单价**。凡出现 `$` 的地方都标注了口径。 |

> ⚠️ founder 口头说"GitHub Actions 本月已花 800+、上限 850"。这个数字本报告**无法核对**,下面第 3 节会把它和用量折算的差距如实摊开,并写清需要她提供什么才能收口。

**计费口径**:GitHub 对每个 **job** 按分钟**向上取整**计费,所以本报告一律用 `Σ ceil(job 秒数 / 60)`,记作"计费分钟"。`conclusion = skipped` 的 job 不占机器、计 0。Ubicloud 是否同样按 job 向上取整,官方文档未写明 ⇒ 本报告对 Ubicloud **也用向上取整**(保守,偏贵);若它按秒计费,Ubicloud 侧实际还要再低约 8%。

**时间窗**:
- GitHub-hosted 时期:`2026-09-08T00:00Z → 2026-09-22T04:00Z`
- Ubicloud 时期:`2026-09-22T04:00Z → 2026-09-23T04:00Z`(**只有 24 小时**)

**切换点的准确认定**:`vars.CI_RUNNER` 在 `2026-09-22T03:00:25Z` 被设为 `ubicloud-standard-2`,但让 job 真正读这个变量的代码 `aa8f6e7c6 (FLY-2746, PR #1271)` 是 `2026-09-22T04:00:03Z` 合入 main 的。所以 03:00–04:00 之间仍有 5 个 CI run 跑在 `ubuntu-latest` 上(分支还没 rebase 到该 commit)。**判 runner 归属一律看 job 的 `labels` 字段,不看时间。** 04:00Z 之后抽到的 CI job 100% 是 `ubicloud-standard-2`,切换是干净的。

---

## 1. 单价(公开挂牌价,2026-09-23 查)

| runner | vCPU | 单价/分钟 | 出处 |
|---|---|---|---|
| GitHub-hosted `ubuntu-latest` (Linux x64 2-core) | 2 | **$0.006** | GitHub 2026-01-01 调价后价目(原 $0.008,降 25%);该价内已含 $0.002/min 的 Actions cloud platform charge |
| Ubicloud `ubicloud-standard-2` — **standard 档** | 2 | **$0.00125** | Ubicloud 官方 pricing 文档 |
| Ubicloud `ubicloud-standard-2` — **premium 档** | 2 | **$0.002** | 同上 |

两条必须说清的附加事实:

1. **GitHub 对自建/第三方 runner 的 $0.002/min 平台费没有生效。** 它在 2025-12-16 宣布、原定 2026-03-01 起征,48 小时内被撤回重评估;2026-03-01 当天没有开征,截至 2026-08 仍无新日期。⇒ **跑在 Ubicloud 上的分钟目前不向 GitHub 付任何钱。** 这条一旦反转,下面所有 Ubicloud 金额要加 $0.002/min(约翻 2.6 倍),是本方案最大的单点外部风险。
2. **`ubicloud-standard-2` 这个 label 到底按 standard 还是 premium 计费,取决于 Ubicloud 控制台里 installation 级的 Premium Runners 开关。** premium 不是另一个 label,而是"同一个 label 分配到更快的机器族并按 premium 价计费"的 toggle。FLY-2718 (2026-09-18) 在 founder 的控制台**实测**:新装完成后 Premium Runners 带橙色 Enabled badge、toggle 是**开着的**(与读源码默认值推出的结论相反)。⇒ **本报告给出 standard / premium 两套金额,哪一套成立需要 founder 看一眼控制台 Settings 页。**

**免费额度**:GitHub 私有仓每月含 2,000 分钟(Free 计划)或 3,000 分钟(Pro / Team)——Annie 的计划本报告未取得。Ubicloud 每个账号每月送 $2.50 credit。

---

## 2. 迁移前后:同一批 job 在两家机器上跑多久

只取 `conclusion = success` 的 job(cancelled 的时长被截断,不能比),按 job 名逐一比中位数。

| job | GitHub n | GitHub 中位(分) | Ubicloud n | Ubicloud 中位(分) | UB/GH |
|---|---:|---:|---:|---:|---:|
| Unit (teamlead 1 of 4) | 137 | 14.88 | 38 | 10.93 | **0.73** |
| Unit (teamlead 4 of 4) | 142 | 13.87 | 43 | 10.22 | **0.74** |
| Unit (teamlead 3 of 4) | 137 | 13.70 | 44 | 10.29 | **0.75** |
| Unit (teamlead 2 of 4) | 129 | 13.47 | 38 | 11.23 | **0.83** |
| Unit (observation performance) | 181 | 3.22 | 58 | 2.41 | 0.75 |
| Unit (heavy) | 147 | 10.87 | 43 | 9.63 | 0.89 |
| Unit (light) | 170 | 4.67 | 48 | 6.15 | **1.32** |
| Quick Gate (build + typecheck + lint) | 171 | 5.78 | 66 | 4.13 | **0.71** |
| Script Tests 1/6 | 20 | 11.82 | 42 | 10.28 | 0.87 |
| Script Tests 2/6 | 20 | 11.87 | 45 | 9.90 | 0.83 |
| Script Tests 3/6 | 20 | 12.01 | 42 | 11.80 | 0.98 |
| Script Tests 4/6 | 20 | 11.93 | 42 | 11.97 | 1.00 |
| Script Tests 5/6 | 20 | 11.90 | 38 | 13.18 | **1.11** |
| Script Tests 6/6 | 18 | 11.88 | 40 | 12.73 | **1.07** |
| NPM payload distribution | 182 | 3.08 | 58 | 2.88 | 0.94 |
| Classify CI scope | 221 | 0.33 | 86 | 0.40 | 1.20 |
| CI OK | 87 | 0.08 | 35 | 0.13 | 1.60 |
| **按时长加权平均** | | | | | **0.837** |

**读法**:Ubicloud standard-2 在这套负载上**比 GitHub-hosted 快约 16%**,不是更慢。记忆里"Ubicloud 慢约 1s 翻红三条时序测试"(FLY-2746)说的是**个别时序敏感用例**的抖动,不是整体吞吐——Script Tests 5/6、6/6 和 Unit (light) 确实变慢了(1.07–1.32),其余大多变快。

**但是**——把同一个 run 的所有 job 加起来、按 job 向上取整之后,**每次 run 的计费分钟几乎没变**:

| run 类型 | GitHub-hosted | Ubicloud | 差 |
|---|---:|---:|---:|
| full · success | 155.6 分 | 153.4 分 | −1.4% |
| full · failure | 153.9 分 | 149.4 分 | −2.9% |
| full · cancelled | 75.3 分 | 83.1 分 | +10.4% |
| **full(全部结论)** | **126.6 分** | **119.8 分** | **−5.4%** |
| docs-only(heavy 被跳过) | 约 6 分 | 约 6 分 | ≈0 |

⇒ **规划时按"分钟数不变"算最稳。省下来的钱几乎全部来自单价(4.8 倍),不是来自跑得快。**

---

## 3. 花了多少钱

> 本节的 `$` 全部是**折算**:真实用量分钟 × 公开挂牌单价。账单**未取得**。

### 3.1 作业量(14 天实测,2026-09-09T00:00Z → 2026-09-23T04:00Z)

| workflow | run 数 | success | failure | cancelled / skipped |
|---|---:|---:|---:|---|
| `ci.yml` | **962** | 448 (47%) | 192 (20%) | **321 cancelled (33%)** |
| `ship-on-comment.yml` | 501 | 156 | 0 | 345 job 层 skipped(0 分钟) |
| `payload-beta-release.yml` | 179 | 45 | 134 | — |
| `payload-cleanup.yml` | 292 | 286 | 6 | — |
| `payload-activation / auto-release / promote / promote-commit` | **0**(近 60 天) | — | — | — |
| `ci-ubicloud-canary.yml` | **0**(近 14 天;全历史只有 2026-09-18 的 2 次) | — | — | — |

### 3.2 每 run 计费分钟(实测)

见 §4.1 的汇总表。核心两个数:GitHub-hosted 时期 CI 平均 **112.0** 计费分钟/run;Ubicloud 时期 **112.1（同一 docs-only 占比口径下；见下）**。

### 3.3 月度折算

**每 run 计费分钟(去偏后的抽样)**

| | 抽样 run 数 | full run 均值 | docs-only 均值 | docs-only 占比 | **全部 run 均值** |
|---|---:|---:|---:|---:|---:|
| GitHub-hosted `ubuntu-latest` | 368 | **119.8 分** | 4.8 分 | 7% | **112.0 分** |
| Ubicloud `ubicloud-standard-2` | 90 | **119.8 分** | 6.0 分 | 23% | 93.3 分 |

> GitHub 侧的样本是两段合并去重的:最近 250 个 run + 从更早的 653 个里每 5 个抽 1 个(130 个),覆盖 2026-09-08 → 2026-09-22 整个窗口,消除"只抽最近 3 天"的偏差。
> Ubicloud 侧 `93.3` 比 GitHub 低,**纯粹是因为这 24 小时里恰好有 23% 的 run 是纯文档 PR**(GitHub 期只有 7%),不是机器更省。
> **把 docs-only 占比拉齐到同一个 7%,两边都是约 112 分/run —— 分钟数一模一样。**

**月度折算(口径 A:按最近 14 天的强度折全月)**

| | 计费分钟/月 | 单价 | 金额/月 |
|---|---:|---|---:|
| **迁移前**:全部 GitHub-hosted | 237,115 | $0.006 | **$1,405** |
| **迁移后**:CI + ship 在 Ubicloud(**standard** 档) | 235,115 | $0.00125 | $291 |
| &nbsp;&nbsp;+ `payload-*` 留 GitHub | 2,110 | $0.006 | $0(在 3,000 免费额度内) |
| &nbsp;&nbsp;**合计** | | | **$291** |
| **迁移后**:CI + ship 在 Ubicloud(**premium** 档) | 235,115 | $0.002 | $468 |
| &nbsp;&nbsp;+ `payload-*` 留 GitHub | 2,110 | $0.006 | $0 |
| &nbsp;&nbsp;**合计** | | | **$468** |

**口径 B(按 2026-09-01 → 09-22 的实际 run 数,交叉验证)**

- ci 1,659 次 × 112.0 + ship 818 × 0.60 + beta 210 × 3.79 + cleanup 288 × 1.00 = **187,383 计费分钟 / 22 天**
- 扣 3,000 免费 → × $0.006 = **$1,106(这 22 天实际发生)**;折成整月 = **$1,538/月**
- 同法看 8 月:ci 2,425 次 → 272,541 分 → **$1,617/月**

两个口径落在 **$1,400 – $1,620/月** 区间,彼此印证。

### 结论(一句话)

**省了,而且省得很多。同样的 CI 工作量、同样的分钟数,月成本从约 $1,400–1,600 降到 $291(standard 档)或 $468(premium 档),降 79% / 67%。**
Ubicloud standard-2 单价是 GitHub-hosted 的 **1/4.8**,而跑同一套负载消耗的分钟数**几乎完全相同**(每 run 均 112 分)。
**不存在"用 Ubicloud 比以前还贵"的情形** —— 除非 GitHub 把那条已经撤回的 $0.002/min 自建 runner 平台费重新开征(那时 Ubicloud 侧会变成 $0.00325–0.004/min,合计约 $760–940/月,仍比 $1,400 便宜,但优势会腰斩)。

### 3.4 和 founder 说的 "800+" 对不上的地方,如实摊开

founder 说"GitHub Actions 本月已花 800+、上限 $850"。用量折算给出的是 **9 月 1–22 日 $1,106**。差约 **28%**,这个差我**没有收口**,原因如实列在这里:

- **账单页读不到**(scope 不足),所以无法确认 $800+ 指的是哪个计量口径、哪个日期、是否含免费额度抵扣。
- **不是被账单墙挡掉的 run**:检查了窗口内全部 903 个 GitHub-hosted run,**没有一个 `startup_failure`,抽样 368 个 run 的计费分钟最小值是 2 分、没有 0 分钟的 run** ⇒ 这段时间没有发生"额度耗尽被拒跑"。(FLY-2746 记录过一次 0-step 计费墙拒跑,但不在本窗口内。)
- **可能的差异来源**(都未验证,不作结论):她的计划含的免费分钟多于 3,000;$800+ 是她当时看到的非当期值;或 9 月上半月的 run 比我抽样的 09-08→09-22 更轻。

**需要 founder 提供才能收口的东西(两张图就够)**:
1. GitHub → Settings → Billing → **Actions 用量页**(能看到本期已用分钟数 + 金额 + 计划含的免费分钟)。
2. Ubicloud 控制台 → **Billing 页**(迁移后至今的实际消费)+ **Settings 页的 Premium Runners toggle 状态截图**(决定是 $0.00125 还是 $0.002/min,两者差 $177/月)。

---

## 4. 逐个 workflow / job 梳理

### 4.1 `ci.yml` — 唯一的大头

- **触发**:`pull_request` 到 main(`opened / synchronize / reopened / labeled`)+ `push` 到 main。
- **并发**:`group: ci-${{ github.ref }}`,`cancel-in-progress: true`。
- **runner**:11 处 `runs-on` 全部是 `${{ vars.CI_RUNNER || 'ubuntu-latest' }}` ⇒ 当前 `ubicloud-standard-2`。
- **job 展开后是 17 个**(不是 11 个;`unit-tests` 是 7 路 matrix):

| job | 何时跑 | Ubicloud 中位耗时 | 说明 |
|---|---|---:|---|
| `Classify CI scope` | 总是 | 0.40 分 | 判 docs-only / scoped / full 三档 |
| `Quick Gate (build + typecheck + lint)` | **总是**(没有 `needs: classify`,也没有 `if`) | 4.13 分 | build + typecheck + lint + 约 20 个内联契约脚本 |
| `Unit (teamlead 1..4 of 4)` | `heavy != skip` | 10.2–11.2 分 ×4 | teamlead 包分片 |
| `Unit (observation performance)` | 同上 | 2.41 分 | 单个性能用例独占一个 job |
| `Unit (heavy)` | 同上 | 9.63 分 | claude-runner + comm + edge-worker |
| `Unit (light)` | 同上 | 6.15 分 | 其余 packages |
| `Script Tests 1..6/6` | 同上 | 9.9–13.2 分 ×6 | 290 个 shell 套件按 6 路人工均衡分片 |
| `NPM payload distribution` | 同上 | 2.88 分 | endpoint + release pipeline |
| `CI OK` / `CI Scope OK` | `always() && !cancelled()` | 0.13 分 | 聚合 required check |

- **有没有重复跑同一份测试?** **没有。** `scripts/__tests__/ci-shell-suite-enumeration.test.sh` 是一道硬闸:它 diff "仓库里所有 `*.test.sh`" vs "ci.yml 里字面枚举的" vs "reviewed 的 manual-only 清单",三者必须不重不漏(`comm -12 enumerated manual-only` 有交集就红)。实测 ci.yml 里 290 个 shell 套件 + 85 个 node 套件**无一重复**,manual-only 54 个。**"跑了重复的 CI job"这个猜想,在套件粒度上不成立。**
- **重复的是 setup,不是测试。** 15 个 job 各自做一遍 `checkout + pnpm install + pnpm build`。抽 1 次完整 run 的 step 级时长:一次 full run 约 141 分钟 job 时间里,约 **18 分钟(≈13%)**花在重复的 checkout/install/build 上。
- **真正的大头是"同一个 PR 反复跑全量"。** 用仓库里 FLY-2681 自带的 `engineering/doc/FLY-2681-ci-on-demand-matrix/data/ci-cost.py`(同一套口径,已过设计评审)对 `2026-09-20 → 2026-09-21` 单日实跑:
  - 72 runs / **8,677 计费分钟** / 68 个不同的 PR head
  - `full_matrix_runs = 70`,`minutes_per_full_matrix = 121.5`
  - **`merged_prs = 4`,`full_runs_per_merged_pr = 17.5`** ← 一个 PR 从开到合,平均跑 **17.5 次**全量矩阵
  - 分档占比:`pr-full 93.2%` / `push 4.8%` / `pr-scoped 1.9%` / `docs-only 0.1%`

### 4.2 `CI_SCOPED_MODE` 现在是 `off` —— 已经做好的省钱开关没有打开

`gh variable list` 实测:`CI_SCOPED_MODE = off`(2026-09-18T02:12:58Z 设置)。

`scripts/ci-scope.sh` 的逻辑:

```
NO_CODE=true                      -> heavy=skip, mode=docs_only     （这一档不受开关控制，现在就在生效）
CI_SCOPED_MODE != "on"            -> 保持全量（fail-closed）         ← 当前状态
CI_SCOPED_MODE == "on":
  push 且有可复用的绿 tree 证据   -> heavy=skip, mode=reuse
  PR 头是 merge 提交(2 个父)      -> 全量
  PR 头是普通提交(1 个父)         -> heavy=skip, mode=scoped
  带 ci:full label 的 labeled 事件 -> 全量
```

即:开关打开后,**普通 PR 推送只跑 Classify + Quick Gate(约 5 分钟),重活留到被显式冻结的头**(`flywheel-comm ci-full ensure` 打 `ci:full` label,或 merge 头)。`.github/ci-required-jobs.json` 已经把 16 个 required job 钉死,`CI OK` / `CI Scope OK` 双名聚合、ship-await-ci、land `exactGreenCi`、approve-to-ship 的精确头守卫都没放松 ⇒ **scoped-only 的头拿不到 `CI OK`,自动 fail closed,合不进去。**

FLY-2681 自己用 2026-09-16 的 90 runs / 10,936 计费分钟做过重放,给出三档预期降幅:常规 **−59.2%**、每条真实红分支多跑一次 **−46.4%**、悲观 **−38.7%**;若 main tree 复用率 50%,则 −66.8% / −54.0% / −46.4%。里程碑文件写明"合入并部署新 flywheel-comm dist 后,仅 Lead 可在 canary/readback 完成后打开",以及"开关启用 7 天后由 Lead 运行同口径复核"。**到今天(2026-09-23)开关仍是 `off`,复核也就无从谈起。**

### 4.3 `ship-on-comment.yml`

- **触发**:`issue_comment: [created]` —— 仓库里**任何** issue/PR 评论都会产生一条 run 记录。
- 但 `prepare` job 有 job 级 `if:`(必须是 open PR 上、正文以 `:cool:` 开头的评论),不满足就 `skipped` ⇒ **不占机器、0 计费分钟**。14 天 501 条 run 里 345 条(69%)就是这种空跑记录。
- 实跑的 `prepare` 中位 0.30 分、均值 0.46 分(最大 4.63 分);`merge` 0.15 分。**每条真实 ship 只花约 0.6 计费分钟。**
- `timeout-minutes: 30`、内部 `await-ci` 最多等 25 分钟——**理论上**可能出现"runner 空转等 CI"的浪费,但实测没发生(均值 0.46 分),因为 `:cool:` 基本都在 CI 已绿之后才发。
- runner:`${{ vars.SHIP_RUNNER || 'ubuntu-latest' }}` ⇒ 已是 `ubicloud-standard-2`。

### 4.4 `payload-*` 六个 —— 全都是 release / 分发流程

| workflow | 触发 | 14 天次数 | 每 run 计费分钟 | 性质 |
|---|---|---:|---:|---|
| `payload-beta-release` | `schedule: 0 */6 * * *` + `workflow_dispatch` | 179 | 3.79 | beta 班车发布 |
| `payload-cleanup` | `schedule: 17 * * * *`(每小时) | 292 | 1.00 | 过期 payload 清理 |
| `payload-activation` | 仅 `workflow_dispatch`(要手打 `ACTIVATE`) | 0 | — | 一次性分发激活,碰真 Cloudflare / npm |
| `payload-promote` | 仅 `workflow_dispatch` | 0 | — | 客户版候选 prepare |
| `payload-promote-commit` | 仅 `workflow_dispatch`(要手打 `COMMIT`) | 0 | — | manifest commit / abandon / withdraw |
| `payload-auto-release` | 仅 `workflow_dispatch`(Bridge 派发) | 0 | — | 客户版执行器 |

这六个的 `runs-on` 全部**硬编码 `ubuntu-latest`**,没有走 `vars.CI_RUNNER`。

**`payload-beta-release` 有一段长期白烧的历史**:2026-07-27 → 2026-09-09,每 6 小时一次的 cron **连续 7 周 100% failure**(约 190 次全失败);2026-09-13/14 两天又有 121 次 `push` 触发的失败(那时该文件还有 `push` 触发器,现已移除)。FLY-2534 修复后,自 2026-09-15 起 schedule 基本全绿。**这笔钱已经烧完了,现在的形态是健康的**,但"一个 cron 连红 7 周没人发现"本身是个缺口。

### 4.5 `ci-ubicloud-canary.yml` —— 迁移试验脚手架,已完成使命

- **触发**:**只有** `workflow_dispatch`,且 `preflight` 读 `vars.UBICLOUD_CANARY_AUTHORIZED` 作为授权闸。
- `gh variable list` 实测:**`UBICLOUD_CANARY_AUTHORIZED` 这个变量已经不存在** ⇒ 即使有人手动 dispatch,preflight 也会拒。
- **全历史只运行过 2 次**,都在 2026-09-18(一次 failure、一次 success),之后再没跑过。
- 文件 31,974 字节,7 个 job(preflight / capacity 矩阵 / quick-gate / unit / script / isolation reader+writer / result)。
- **当前持续成本 = $0。** 它的代价是维护面:每次 CI 的 `Validate workflow startup syntax and contexts (FLY-2534)` 和 workflow seed 校验都要扫它,任何 CI 结构改动都要同步改这 32KB。
- 迁移已于 2026-09-22 完成(`aa8f6e7c6` + `vars.CI_RUNNER`),canary 要回答的问题("Ubicloud 上跑得起来吗 / 容量够吗 / 隔离对不对")已经被**生产上 14 天、1,000+ 个真实 job**回答了。

---

## 5. 清理清单

单独成文:[`cleanup-checklist.md`](./cleanup-checklist.md)。七条(C1–C7)+ 两条"看着浪费其实不花钱、不要动"的说明 + 建议执行顺序。

一句话预览:**能省的钱几乎全在"打开 `CI_SCOPED_MODE`"这一条上($114–196/月);其余全部加起来不到 $45/月。删 `ci-ubicloud-canary.yml` 是清洁工作,现金收益是 $0。**

---

## 6. 复现方法

```bash
# 1) 每个 workflow 的 run 元数据（按 created 窗口分页，API 单次上限 1000 条）
gh api --paginate "repos/xrliAnnie/flywheel/actions/workflows/ci.yml/runs?per_page=100&created=%3E%3D2026-09-08" \
  --jq '.workflow_runs[] | {id,created_at,status,conclusion,event,head_branch}'

# 2) 逐 run 的 job 时长与 runner label（判 runner 归属只看 labels，不看时间）
gh api "repos/xrliAnnie/flywheel/actions/runs/<RUN_ID>/jobs?per_page=100" \
  --jq '.jobs[] | {name, conclusion, started_at, completed_at, labels: (.labels|join(","))}'

# 3) 计费分钟 = Σ ceil(job 秒数 / 60)；conclusion=skipped 计 0

# 4) 交叉验证（仓库自带、已过设计评审的同口径工具）
python3 engineering/doc/FLY-2681-ci-on-demand-matrix/data/ci-cost.py \
  --from 2026-09-20 --to 2026-09-21 --repo xrliAnnie/flywheel --json
```

**不要用** `GET /actions/runs/{id}/timing` —— 本仓所有 run 都返回 `billable.UBUNTU.total_ms = 0`(含确认是 `ubuntu-latest` 的 17-job run `35677235982`),它在新计费平台下失真,当账单用会得出"CI 一分钱没花"。

## 7. 待 founder 确认 / 未取得的事实(不要当成已知)

| # | 事项 | 影响 |
|---|---|---|
| 1 | **GitHub Billing → Actions 用量页**(本期已用分钟 + 金额 + 计划含的免费分钟) | 收口 "$800+" 与折算 $1,106 之间 28% 的差;确认计划是 Free(2,000 分)还是 Pro/Team(3,000 分) |
| 2 | **Ubicloud 控制台 Settings → Premium Runners toggle 状态** | 决定单价是 $0.00125 还是 $0.002/min ⇒ 月成本 **$291 vs $468**,差 $177/月。FLY-2718 实测"装完后是 ON",但那是 2026-09-18 的状态,之后可能被改过 |
| 3 | **Ubicloud 控制台 Billing 页**(迁移后至今实际消费) | 验证本报告的折算是否成立 |
| 4 | Ubicloud 是否按 job 向上取整计费 | 官方文档未写明。本报告按向上取整(保守);若按秒计费,Ubicloud 侧实际还要低约 8% |
| 5 | `payload-cleanup` 是否有"1 小时内必须清除"的保留期合同 | 决定 C3 能不能做 |
