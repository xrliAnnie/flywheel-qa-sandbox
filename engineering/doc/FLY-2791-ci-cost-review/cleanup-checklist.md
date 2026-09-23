# FLY-2791 CI 清理清单

Issue: FLY-2791 (https://linear.app/geoforge3d/issue/FLY-2791/ci开销与作业梳理-调研迁-ubicloud-后-ci-实际花多少是否比-github-时期更省)
日期: 2026-09-22
基于: research.md

> **本单不执行任何一条。** 边界是"不改 workflow / 不改变量 / 不触发 workflow",清理由后续实现单做。
> 金额一律是**折算**(真实用量 × 公开挂牌单价),不是账单。基线 = 迁移后现状:Ubicloud 约 235,000 计费分钟/月($291/月 standard 档)+ GitHub-hosted 约 2,110 分钟/月($0,在免费额度内)。

---

## C1 · 删除 `ci-ubicloud-canary.yml`(founder 点名)

| | |
|---|---|
| **动作** | 删 `.github/workflows/ci-ubicloud-canary.yml`(31,974 字节、7 个 job);同时确认 `vars.UBICLOUD_CANARY_AUTHORIZED` 已不存在(实测已删),以及 `Validate workflow startup syntax and contexts` / workflow seed 校验里没有对它的硬引用。 |
| **删掉后丢了什么保护** | 丢掉一条**隔离的 runner 试验通道**:它能在不动生产 `ci.yml` 的前提下,拿任意 runner 跑 quick-gate / unit / script 三个代表性 job,外加 1/8/33/54 路的**容量矩阵**和一对**读写隔离探针**(验证两个并发 job 看不见彼此的工作区)。将来要评估第三家 runner 供应商时,这套脚手架要重写。 |
| **为什么可以不要** | ① 迁移已在 2026-09-22 完成(`aa8f6e7c6` + `vars.CI_RUNNER=ubicloud-standard-2`),它要回答的三个问题("跑得起来吗 / 容量够吗 / 隔离对吗")已经被**生产上 14 天、1,000+ 个真实 Ubicloud job** 回答了,证据强度远高于 canary 的 2 次试跑。② 它**只有 `workflow_dispatch` 触发**,全历史只跑过 2 次(都在 2026-09-18)。③ 它的授权闸变量 `UBICLOUD_CANARY_AUTHORIZED` 已被删除 ⇒ **现在就算有人手动 dispatch,preflight 也会拒**,它已经是一具跑不起来的壳。④ 删了还能从 git history 完整取回(`git show <sha>:.github/workflows/ci-ubicloud-canary.yml`),不是不可逆。 |
| **预计省** | **现金 $0/月**(它已经 0 次运行,不产生任何分钟)。省的是维护面:32KB workflow 不再参与每次 CI 的 workflow 语法校验与 seed 校验,CI 结构改动不用再同步它。**请不要把这条当省钱项卖 —— 它是清洁工作。** |
| **风险** | **低**。唯一的真实风险是"将来换 runner 供应商时要重写脚手架";缓解 = 在删除 PR 的 body 里记下取回用的 commit SHA。 |

---

## C2 · 把 `CI_SCOPED_MODE` 从 `off` 打开到 `on`(**唯一的大钱**)

| | |
|---|---|
| **动作** | 把 repo variable `CI_SCOPED_MODE` 由 `off` 改为 `on`。**没有代码改动** —— 机制在 FLY-2681 (PR #1249) 里已经建好并过了设计评审,变量是它的 fail-closed 总闸。 |
| **改了以后行为变什么** | 普通 PR 推送(单父提交的头)只跑 `Classify CI scope` + `Quick Gate`,约 5 计费分钟,聚合 check 叫 `CI Scope OK`;重活(14 个 heavy job)留给**被显式冻结的头**:`flywheel-comm ci-full ensure` 打上 `ci:full` label 的头、merge 提交头、以及 main push(可按 tested tree SHA 复用绿证据)。纯文档头仍走现有的 docs-only 跳过。 |
| **丢了什么保护** | 丢的是**过程中的早期信号**:开发到一半推的那些中间头不再跑单测/脚本套件,问题要等到"冻结头/merge 头"才暴露,一旦红,返工窗口比现在长。对连续小步推进的 runner 来说,发现问题的平均延迟会变大。 |
| **为什么可以不要** | **"能合进 main 的东西"受到的保护一条都没少。** `.github/ci-required-jobs.json` 把 16 个 required job 钉死;聚合 job 逐项要求 `result == success`;required check 名 `CI OK`、ship 的 `await-ci`、land 的 `exactGreenCi`、approve-to-ship 的精确头守卫**全部没有放松**。scoped-only 的头拿不到 `CI OK` ⇒ **自动 fail closed,根本合不进去**。也就是说,少跑的全是"反正也不会被拿来当合入凭据"的那些头。 |
| **预计省** | FLY-2681 用 2026-09-16 的 90 runs / 10,936 计费分钟做过重放:常规 **−59.2%**、每条真实红分支多跑一次全量 **−46.4%**、悲观 **−38.7%**;若 main tree 复用率 50% 则 −66.8% / −54.0% / −46.4%。<br>按当前基线(CI 约 234,000 分/月、$293/月 standard 档)折算:**省 91,000 – 157,000 分钟/月 ≈ $114 – $196/月**(standard 档)。<br>*同一笔省法如果发生在 GitHub-hosted 时期,值 $548 – $941/月 —— 迁 Ubicloud 已经把这条的绝对收益压缩了 4.8 倍。* |
| **风险** | **中**。若 `ci-full ensure` / label 路径有 bug,可能出现"本该全量的头没跑全量";但因为聚合名和守卫都 fail-closed,后果是**合不进去(拒绝)**而不是**错误放行**。<br>**回滚 = 把变量改回 `off`,一步,零代码。**<br>里程碑文件自己写了前置条件:"合入并部署新 flywheel-comm dist 后,**仅 Lead 可在 canary / readback 完成后打开**",以及"**开关启用 7 天后由 Lead 运行同口径复核**"(复核工具就是仓库里的 `ci-cost.py`)。这两步不能跳。 |
| **谁来做** | 按里程碑的话,是 Lead 的动作,不是 runner 的。 |

---

## C3 · `payload-cleanup` 的 cron 从每小时降到每 6 小时

| | |
|---|---|
| **动作** | `.github/workflows/payload-cleanup.yml` 的 `schedule: '17 * * * *'` 改为 `'17 */6 * * *'`。 |
| **丢了什么保护** | 过期 payload 的滞留时间上限从 1 小时变成 6 小时。 |
| **为什么可以不要** | 它是**保留期清理**,不是安全闸或配额闸。14 天 292 次里 286 次成功,**每次中位耗时 0.08 分钟(约 5 秒)** ⇒ 绝大多数是扫了一圈什么都没删的空跑。 |
| **预计省** | 635 → 106 计费分钟/月,省 **529 分钟/月**。在 GitHub-hosted 且仍在免费额度内 ⇒ **现金 $0/月**;即使按 $0.006/min 算也只有 **$3.2/月**。 |
| **风险** | **低,但有一个我没核实的前提**:我**没有**核对分发侧是否存在"过期 payload 必须在 1 小时内清除"的保留期合同 / 合规要求。**执行前必须先核这一条**,否则这是在拿合同换 $3。 |
| **建议** | **优先级最低。** 收益基本是 0,单独为它开 PR 不划算;可以搭车到别的 payload 改动里。 |

---

## C4 · 给 schedule 类 workflow 加"连续失败"告警(不是删,是补)

| | |
|---|---|
| **背景** | `payload-beta-release` 的 6 小时 cron 在 **2026-07-27 → 2026-09-09 连续 7 周 100% failure**(约 190 次全失败),没有任何人发现;2026-09-13/14 又有 121 次 `push` 触发的失败(当时该文件还有 `push` 触发器,现已移除)。FLY-2534 修复后,自 2026-09-15 起基本全绿。 |
| **动作** | 给 `schedule` 触发的 workflow 加一条"连续 N 次 failure → 发工程告警频道"的规则。 |
| **丢了什么保护** | 不丢。这是**加**保护。 |
| **预计省** | **直接现金 $0**(这笔钱已经烧完了)。它省的是**下一次**:一个 4 次/天、每次 3.79 分钟的 cron 连红 7 周 = 约 720 计费分钟白烧 + 7 周里 beta 班车实际没发出去。 |
| **风险** | 低(只加告警,不改发布路径)。注意别做成噪音源 —— 阈值要按"连续 N 次"而不是"任意一次"。 |

---

## C5 · 让 heavy job 共享一次 build,消掉 15 份重复的 install + build

| | |
|---|---|
| **背景** | 15 个 job 各自做一遍 `checkout + pnpm install + pnpm build`。抽一次完整 run 的 step 级时长:约 141 分钟 job 时间里,**约 18 分钟(≈13%)** 是这份重复的 setup。 |
| **动作** | 由一个前置 job 产出构建产物,heavy job 通过 artifact / cache 取用。 |
| **丢了什么保护** | 丢掉"**每个 job 都在干净环境里从源码 build 成功**"这条隐含保证。现在任何一个 job 的环境退化(缺 native module、缺 apt 依赖)都会立刻在该 job 里红;改成共享产物后,这类环境差异会被掩盖到运行期才暴露。 |
| **为什么可以不要(部分)** | `Quick Gate` 本来就已经在做一次权威的 `pnpm build`;heavy job 里的 build 是为了拿产物,不是为了验证可构建性。 |
| **预计省** | 约 13% 的 CI 分钟 ≈ **30,500 分钟/月 ≈ $38/月**(standard 档)。**但如果先做了 C2,基数缩到 1/2~1/3,这条只剩 $13 – $23/月。** |
| **风险** | **中高**。pnpm workspace + native module(`better-sqlite3` 预编译二进制)+ 各 shard 自己 apt 装的 `tmux/lsof/sqlite3/ripgrep`,跨 job 传产物很容易出微妙差异,而这类差异的表现形式往往是**偶发红**——正好是这套 CI 最不需要的东西。 |
| **建议** | **排在 C2 之后再评估。** 收益比 C2 小一个量级,风险大一个量级。 |

---

## C6 · `payload-*` 六个 release 流程 —— **建议维持现状,留在 GitHub-hosted**

founder 的原话:"我唯一想要做的是一种完整性……所有 Flywheel 相对应的 CI/CD,我想还是都迁过去会比较好。但如果这些都只是一些 release 的流程,那放在 GitHub 上,我觉得倒也是可以。"

**这六个确实都只是 release / 分发流程**:`beta-release`(beta 班车)、`cleanup`(保留期清理)、`activation`(一次性分发激活)、`promote` / `promote-commit`(客户版候选与 manifest commit)、`auto-release`(客户版执行器)。所以按她自己给的口径,留在 GitHub 是可以的。三条支撑:

1. **迁过去省不到钱。** 六个加起来约 **2,110 计费分钟/月**,**完全落在 GitHub 私有仓的免费额度内**(Pro/Team 3,000 分/月;即使是 Free 计划的 2,000 分,溢出部分也只有 $0.66/月)。迁到 Ubicloud 省 **$0 – $6/月**。
2. **迁过去要付一次安全评审的代价。** `activation` / `promote` / `promote-commit` / `auto-release` 持有真凭据(Cloudflare API token、npm publish token)。`payload-activation.yml` 的文件头注释写得很直白:这是 *"the deliberate, reviewed reversal of the 'credentials never in CI' posture (FLY-1062 底线一/二/三)"*,Annie 2026-07-18 的指示是"every execution is CI"。**那次评审的前提是 GitHub-hosted。** 把发布凭据交给第三方 runner 的 VM,是换了信任边界,要重走那次评审。为省 $0 去动这个不划算。
3. **它们本来就不怎么跑。** `activation` / `promote` / `promote-commit` / `auto-release` 近 60 天 **0 次运行**。

**但要单独开一张单(不是清理单)**:这四个近 60 天 0 次运行 ⇒ **没有任何证据说明它们今天还能跑通**。建议开一张"发布链路演练"单,在非生产目标上把 promote → commit → auto-release 走一遍。这不是省钱,是防"真要发版那天发现四个 workflow 全坏了"。

---

## C7 · 真正的根因:一个 PR 平均跑 **17.5 次**全量矩阵

| | |
|---|---|
| **实测** | 用仓库自带的 `engineering/doc/FLY-2681-ci-on-demand-matrix/data/ci-cost.py`(同口径、已过评审)跑 2026-09-20 → 09-21 单日:**72 runs / 8,677 计费分钟 / 68 个不同 PR head / 4 个 merged PR ⇒ `full_runs_per_merged_pr = 17.5`**;分档占比 `pr-full 93.2%`。<br>另一面:14 天 962 个 CI run 里 **321 个(33%)被 concurrency supersede 取消**,而每个被取消的 full run 平均已经烧掉 **75–83 计费分钟**(约等于一次完整 run 的 60%)。折算约 **55,000 分钟/月 ≈ $69/月**(standard 档)/ **$330/月**(GitHub 口径)。 |
| **说明** | 这**不是** CI 配置的问题,是"runner 在一个 PR 上推了十几次中间提交"的工作方式问题。**C2 顺带解决它的大半**:打开 scoped mode 之后,被 supersede 掉的绝大多数将是 5 分钟的 quick-gate run,而不是 120 分钟的全量 run。 |
| **建议** | 不在本清理清单里写死动作。若 C2 上线 7 天复核后仍觉得贵,再单独调研"减少中途 push / 给 `synchronize` 加 debounce"。**不预设数字。** |

---

## 明确"看着浪费、其实不花钱"的两项(不要去动)

1. **`ship-on-comment` 被每一条评论触发**:14 天 501 条 run,其中 **345 条(69%)的 job 因为 job 级 `if:`(必须是 open PR 上以 `:cool:` 开头的评论)被 `skipped`**。`skipped` 的 job **不占机器、计 0 分钟**。GitHub 的 `on: issue_comment` 不支持按评论内容预过滤,所以这已经是最省的写法。真实 ship 每次只花约 **0.6 计费分钟**。**无动作。**
2. **`Quick Gate` 在 docs-only 头上照跑**:它没有 `needs: classify`,纯文档 PR 也会跑一遍 build/typecheck/lint(Ubicloud 上约 4 分钟)。但它内部有一批**专门校验文档与结构的契约脚本**(`fly2045-milestone-layout`、`ci-shell-suite-enumeration`、workflow 语法校验、founder disclosure guard 等),纯文档 PR 恰恰需要它们。整条 docs-only run 才约 **6 计费分钟**,占全月不到 0.1%。**不值得为它加复杂度。**

---

## 建议的执行顺序

| 顺序 | 项 | 谁 | 预计省/月(standard 档) | 风险 |
|---|---|---|---:|---|
| 1 | **C1 删 `ci-ubicloud-canary.yml`** | 实现单 | $0(清洁工作) | 低 |
| 2 | **C2 打开 `CI_SCOPED_MODE`** | **Lead**(按 FLY-2681 里程碑:canary/readback 后才能开,开后 7 天同口径复核) | **$114 – $196** | 中,回滚一步 |
| 3 | C4 schedule 失败告警 | 实现单 | $0(防下一次白烧 ~720 分钟) | 低 |
| 4 | C6 的 follow-up:发布链路演练单 | 另开 | $0(防发版日翻车) | — |
| 5 | C5 共享 build | C2 复核之后再评估 | $13 – $38 | 中高 |
| 6 | C3 cleanup 降频 | 搭车 | $0 – $3 | 低,但要先核保留期合同 |

**总计:能省的钱几乎全在 C2 一条上。其余的加起来不到 $45/月。**
**这也是实话的另一半:迁到 Ubicloud 这一步已经把 $1,400 打到 $291,剩下能再挤出来的空间本来就不大了。**
