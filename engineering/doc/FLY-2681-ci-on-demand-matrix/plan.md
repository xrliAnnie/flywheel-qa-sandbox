# FLY-2681 CI 按需矩阵 — 实施计划
Issue: FLY-2681 (https://linear.app/geoforge3d/issue/FLY-2681/ci成本按需矩阵-push-复审修订头只跑受影响的包和分片全量-16-job-只在-qa-冻结头与立卡前各跑一次不买机器就能先省一大半)
日期: 2026-09-17
基于: 无

**Status**: draft（待 design review）
**Doc tier**: plan_only（本文件同时承载审计、调研结论与实施计划）

---

## 0. 结论先行

1. **单子字面做法（改哪个包跑哪个包、改脚本跑对应 Script 分片）省不到钱。** 按 2026-09-16 的 90 次 `ci.yml` run 重放，只省 −8%～21%（§1.3）。原因是结构性的，不是映射写得不够细：当天 76 个 PR run 里 55 个碰了 `packages/teamlead`、46 个碰了 `scripts/`、36 个碰了 `packages/flywheel-comm`；`flywheel-teamlead` 在 workspace 依赖图顶端；33 个 shell suite 文件读 teamlead `src/`、39 个读它的 `dist/`，111 个 teamlead 测试文件读仓库根目录。按路径裁，裁不掉东西。
2. **省钱来自「分层」，不是「按路径裁剪」。** Lead 已裁定（question `8c89c538`，2026-09-17 21:15Z）：普通 PR 头只跑 `Classify CI scope` + `Quick Gate`（约 7 计费分钟）；全量 16 job 只在**被请求**时跑。不做路径→分片映射表。
3. **安全性靠一个不变式守住：名字叫 `CI OK` 的检查，只在「这个头的全量义务已满足」时才会出现并为绿。** 聚合 job 动态改名：全量 / 纯文档 / main 复用时叫 `CI OK`，只跑廉价门时叫 `CI Scope OK`。三个按名字读 `CI OK` 的硬门（分支保护、`scripts/ship-await-ci.sh`、land `exactGreenCi` / `contentCarryoverCiReason`）**零改动**，对没跑全量的头自动 fail-closed。
4. **全量触发 = 给 PR 打 label `ci:full`**（`pull_request: labeled` 事件），由新命令 `flywheel-comm ci-full ensure` 幂等地执行。触发者：QA runner 开场第一步；`gate approve_to_ship` 前置守卫发现缺全量时自动补请求后**照旧拒绝**；land refresh 产生的合并头由 classify 直接判为全量（Bridge 零改动）。
5. **main push 内容复用**：全量绿时留下以「所测树 SHA」为键的证据 artifact；main push 查到同树证据且独立回验通过 ⇒ 跳过重 job。PR 头复用留 follow-up。
6. **开关与回滚**：仓库变量 `CI_SCOPED_MODE`，默认 off = 今天的每头全量。合入且新 flywheel-comm dist 部署后由 Lead 打开；关掉即回滚，不需要 revert PR。
7. **重放节省**（§1.4）：常规 59%（main 不复用）/ 67%（main 复用 50%）。最坏情形取决于「全量首跑红、修完再跑一次全量」的次数：+5 次 = 53% / 60%，+10 次（当天每个出过真实红的分支各一次）= 46% / 54%。Lead 落定的判据：常规 ≥59%，最坏（+10）≥46%（§1.4 末，含一次订正记录）。

---

## 1. 审计与实测

### 1.1 现状（`.github/workflows/ci.yml`，1594 行）

| 事实 | 位置 |
|---|---|
| 触发：`push: [main]` + `pull_request: [main]`（默认 types = opened / synchronize / reopened） | `ci.yml:3-7` |
| `concurrency: ci-${{ github.ref }}`，`cancel-in-progress: true` | `ci.yml:19-21` |
| 10 个 job id：`classify`、`quick-gate`、`unit-tests`（7 行矩阵）、`script-tests`、`script-tests-2..5`、`payload-distribution`、`ci-ok` ⇒ 16 个检查 | `ci.yml:27,50,191,269,499,896,1213,1319,1441,1571` |
| 7 个重 job 统一 `needs: [classify]` + `if: needs.classify.outputs.no_code != 'true'` | 例 `ci.yml:198-199` |
| `ci-ok`：`quick-gate`、`classify` 必须 success；重 job success，或（`no_code=="true"` 且 skipped） | `ci.yml:1571-1594` |
| `scripts/ci-classify.sh`：纯 git、不看 CI 历史（FLY-1877 founder 裁定）、任何不确定 ⇒ `no_code=false` | 全文 129 行 |
| `engineering/doc/**` 目录级 inert；`doc/`、`product/doc/`、`content/doc/` 按 26 个后缀 inert；24 条精确路径围栏 | `ci-classify.sh:49-99` |
| 分支保护：required check 只有 `CI OK`（app_id 15368 = GitHub Actions），`strict=false`，`enforce_admins=true` | `gh api repos/xrliAnnie/flywheel/branches/main/protection`，2026-09-17 实测 |

治理守卫（改 job 图必须同步改，属于交付物而不是绕过）：

- `scripts/__tests__/ci-structure.test.sh`（1477 行，跑在 always-on 的 quick-gate）：job id 集合与顺序、重 job 的 `needs == ["classify"]` 与 `if` 归一化后**逐字**等于 `needs.classify.outputs.no_code!='true'`（`:379-393`）、`classify.permissions` 字典相等（`:394-398`）、`ci-ok.needs` 集合相等与 jq 聚合体**逐字**（`:517-574`）、`concurrency` 逐字（`:417-422`）、unit 矩阵 7 行 name/cmd 逐字（`:430-515`）、shard 步骤清单逐字（`:750-865`）。**它不读 `on:`，也不钉 `classify.outputs`。**
- `scripts/__tests__/ci-shell-suite-enumeration.test.sh`：每个 `scripts/__tests__/*.test.sh` / `*.test.mjs` 必须在 `ci.yml` 里**字面**出现（不关心在哪个 job）；两条自变异对照要求 `endpoint-client-etag.test.mjs`、`qa-lead-diagnostics.test.mjs` 各**恰好出现一次** ⇒ 不能把 suite 列表复制到第二条 lane。
- `scripts/__tests__/ci-classify.test.sh:404-424`：`ci-classify.sh` 里不得出现 runs API、`gh`、`jq`。
- `scripts/__tests__/ci-matrix-coverage.test.sh`：静态矩阵的并集必须等于 `./packages/*` ⇒ 矩阵必须保持静态字面量。
- `scripts/__tests__/workflow-startup.test.mjs:93-97`：`ci-ok.steps[0].run` 必须匹配 `$needs["quick-gate"].result == "success"` ⇒ 聚合步骤必须保持在 index 0。
- `packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts`：quick-gate 无 `if`/`needs`；`ci-ok.needs` 须含它列出的 script shard——但它的 `scriptShardIds`（`:24-29`）只列了 `script-tests`…`script-tests-4`，**漏了 `script-tests-5`**（FLY-2562 遗留）。本单既然要改这个文件，就一并补上并加变异对照。

### 1.2 「精确头 CI 绿」今天由谁读、怎么读（本单的安全面）

| # | 消费者 | 读法 | 对 skipped | 绑定精确头 |
|---|---|---|---|---|
| G1 | 分支保护 | required check 名 `CI OK`（Actions app） | 缺失 ⇒ `Expected`，不可合并 | GitHub 自身 |
| G2 | `scripts/ship-await-ci.sh:53-66`（`:cool:` 后真正的合并前门） | `commits/$HEAD_SHA/check-runs?filter=latest`，取名为 `CI OK` 中 `started_at` 最新者，`conclusion == "success"` | 非 success ⇒ 继续等，25 分钟后 `await_ci_timeout` | 是（`:45-51`） |
| G3 | land `exactGreenCi`（`land-executor.ts:828-858`）与 `contentCarryoverCiReason`（`StateStore.ts:70095-70134`） | `gh pr view --json statusCheckRollup`（**不去重**）；存在名为 `CI OK` 的条目时只看它们，全部须 `COMPLETED`+`SUCCESS`；不存在时退回「所有条目 COMPLETED+SUCCESS」 | `SKIPPED` ≠ `SUCCESS` ⇒ `content_carryover_ci_failed` | 是（`:934-947`） |
| G4 | runner 侧 `probeShipCiGreen`（`packages/flywheel-comm/src/ship-ci-guard.ts:34-125`），被 `gate approve_to_ship`（`gate.ts:96-101`）与 `verify-approval`（`verify-approval.ts:655-686`）共用 | `gh pr checks --json bucket,name,state`；**所有**条目 `bucket == "pass"`；`skipping` 被测试钉为 fail-closed（`ship-ci-guard.test.ts:145`） | 任何 skipped ⇒ 不绿 | 是 |

实测补充（2026-09-17）：

- `gh pr checks`（gh 2.97.0）按 `name/workflow/event` 去重，保留最新一条。PR #1212 的同一头有两次 `pull_request` run（一次 cancelled、一次 success）：check-runs API 与 `statusCheckRollup` 都返回 20 条（两个 check suite 各 10 条），`gh pr checks` 返回 10 条。⇒ **只有「同一 workflow、同一事件」的新 run 才能在 G4 视角里盖掉旧条目；`workflow_dispatch` 触发的 run 盖不掉 `pull_request` run 留下的 skipped。**
- 矩阵 job 在 job 级被 skip 时，留下的检查名是未展开的模板 `Unit (${{ matrix.name }})`（PR #1212、#1235 实测）。之后同一头上的全量 run 产生的是 `Unit (teamlead 1 of 4)` 等展开名 ⇒ **这条占位检查永远不会被盖掉**。
- 纯文档 PR 今天过不了 G4（#1235：`pass:3, skipping:7`），实际经 Lead 直接 `:cool:`（`ticket_id=legacy`）→ G2 → G1 合入。本单不改变这一点（§2.5）。
- QA 会话在 `/decision` 路由里**没有**任何 CI 读取（`workflow-decision-routes.ts` 全文零 check 读取）；`gate-origin-preflight.ts` 立卡物化路径也不读 checks。「QA PASS 前看精确头 CI」目前只是 runner 纪律。
- 仓库里没有任何代码会打 label、`repository_dispatch` 或 `gh workflow run`；已有的外发动作是 `gh pr comment`（land `triggerCool`）、`update-branch`、`gh run rerun`（`ship-await-ci.sh:95`），身份均为本机 `gh` 登录。

### 1.3 重放：单子字面做法为什么不行

数据：`GET /repos/xrliAnnie/flywheel/actions/workflows/ci.yml/runs?created=2026-09-16`（90 次）+ 每个 run 的 `/jobs?filter=all`（1832 条）。计费口径沿用 FLY-1987 `derive-lib.mjs`：每个 job `ceil(秒/60)`，skipped 计 0，rerun 带过来的同名同时间戳 job 只计一次。原始数据与脚本在本目录 `data/`。

| 项 | 数值 |
|---|---|
| 当天 `ci.yml` run | 90（PR 头 75、合并 main 的 PR 头 1、main push 14） |
| 计费分钟（去重） | **10,936**（PR 头 9,116；合并头 147；main push 1,673） |
| 一次干净全量 | 当天 32 次「单 attempt、16 job 全 success」的 run：计费中位数 139、均值 141.1（131–150）⇒ 取 **140**，`replay.py` 对这两个数做断言；各 job 时长中位数合计 131.9 分钟；Script Tests 5 片 = 61.6，teamlead 4 片 + observation = 47.6 |
| PR run 结论 | success 40、failure 16、cancelled 20 |
| main push 结论 | success 6、failure 2、cancelled 6（被下一次合入顶掉） |
| 当天 QA 会话 | 15（`teamlead.db` `sessions` 只读查询，`workflow_node_id='qa'`） |

每个头的改动区域（相对 merge-base 的累计 diff）：76 个 PR run 里 55 个碰 `packages/teamlead`，46 个碰 `scripts/`，36 个碰 `packages/flywheel-comm`，57 个至少碰其中之一；纯文档 6 个。按「包 + 反向依赖闭包 → Unit lane；shell 类路径 → Script lane」重放：

| 选择依据 | PR 头计费 | 加 15 次冻结头全量后总计 | 节省 |
|---|---|---|---|
| 累计 diff（FLY-1877 式不看历史） | 7,883 | 11,803 | **−7.9%** |
| 本次 push 的增量 diff（依赖 `github.event.before`） | 5,545 | 9,465 | **13.5%** |
| 同上 + main 复用 50% | 5,545 | 8,628 | 21.1% |

即使用增量 diff，shell 分片（62 分钟）也必须在碰到 teamlead/comm 源码时跑（shell suite 直接读它们的 dist），裁不掉。

### 1.4 重放：分层做法

固定项：75 个普通 PR 头的廉价门 544 + 合并头 147 + main push。全量单价 140。「+n」= 全量首跑红、修完后在新头上再跑一次全量的次数。

| 全量次数 | main 不动（1,673）总计 | 节省 | main 复用 50%（836）总计 | 节省 |
|---|---|---|---|---|
| 15（每个 QA 会话一次，无红） | 4,464 | **59.2%** | 3,627 | **66.8%** |
| 20（+5） | 5,164 | 52.8% | 4,327 | 60.4% |
| 25（+10） | 5,864 | **46.4%** | 5,027 | **54.0%** |
| 31（+16） | 6,704 | 38.7% | 5,867 | 46.4% |

计算过程：`544` = 当天 75 个普通 PR 头 run 中 `Classify CI scope` + `Quick Gate` + 聚合 job 的真实计费之和（均 7.3 分钟/头）；`15` = 当天 QA 会话数；main 复用 50% = 12 次可归属的 main push 里 6 次「main 合入后的树 == 该 PR 最后一次绿跑所测的合并树」（`git merge-tree --write-tree` 重算，§2.6）。

「+n」怎么取：当天 76 个 PR run 里 16 个以 failure 收场，分布在 21 个 PR 分支中的 10 个上（其中 5 次含 Quick Gate 红，廉价门照样拦得住；若干次是 FLY-2663 已修掉的 observation-performance 抖动）。今天这些红分散在各个中间头上被逐个发现；新方案下同一分支的多处红会在第一次全量里**一起**暴露，修完再跑一次。所以合理上界是「每个出过真实红的分支 +1」= **+10**；+16（每次红都单独多跑一次全量）是不会发生的悲观上界。抖动类的红用 `gh run rerun --failed` 只重跑红的 job（约 12 分钟/个），不重跑全量。

**判据（Lead 已于 2026-09-17 按订正后的数落定并同步进 issue 描述）**：常规 ≥59%（含 main 复用 ≥66%）；最坏（+10）≥46%（含 main 复用 ≥54%）；+16 的 38.7% / 46.4% 只作参考不作判据。合入 7 天后用真实数据复核（§5）。

订正记录：我在 question `8c89c538` 里报过「最坏 49% / 57%」，用的是 +8，那是在拉失败数据之前估的、没有依据；Lead 曾据此写下「最坏 ≥49%」。拉完数据后我用 report `2260ff9c` 发了订正，Lead 接受并宣布原 49% 判据作废。

---

## 2. 设计

### 2.1 模式判定（classify job）

`scripts/ci-classify.sh` **一个字节不动**（docs-only 判定继续是纯 git、不看历史）。新增两个脚本，作为 classify job 里紧随其后的步骤：

- `scripts/ci-scope.sh`：纯函数，输入全部来自 step `env`（`github.*` / `vars.*` 上下文）与本地 git；**不调用 `gh` / `jq` / 任何 API**。
- `scripts/ci-full-reuse.sh`：只在 `github.event_name == 'push'` 时运行；允许调用 `gh api`（§2.6）。

classify 输出（全部写入 `$GITHUB_OUTPUT`，每个键恰好写一次）：

| 输出 | 取值 | 说明 |
|---|---|---|
| `no_code` | `true` / `false` | 现有，语义不变 |
| `heavy` | `run` / `skip` | 重 job 的唯一开关 |
| `mode` | `full` / `docs_only` / `scoped` / `reuse` | 聚合 job 命名、聚合判定、审计摘要都读它 |
| `tested_tree` | 40 位 hex 或空 | checkout 出来的树（PR = merge ref 的树；push = main 提交的树） |
| `reuse_run` | run id 或空 | 仅 `mode=reuse`：证据 run，供审计 |

判定表（自上而下，首条命中；任何脚本异常、输入不合法、git 失败 ⇒ 落到最后一行）：

| # | 条件 | `heavy` | `mode` |
|---|---|---|---|
| 1 | `no_code == 'true'` | `skip` | `docs_only` |
| 2 | `CI_SCOPED_MODE != 'on'`（未设、空、任何其它值） | `run` | `full` |
| 3 | `event_name == 'push'` 且 `ci-full-reuse.sh` 回验通过 | `skip` | `reuse` |
| 4 | `event_name == 'pull_request'` 且 `action == 'labeled'` 且 `label.name == 'ci:full'`（逐字、大小写敏感） | `run` | `full` |
| 5 | `event_name == 'pull_request'` 且 PR 头提交的父提交数 ≥ 2（合并提交） | `run` | `full` |
| 6 | `event_name == 'pull_request'` 且 `action ∈ {opened, synchronize, reopened, labeled}` 且 `HEAD_SHA` 为 40 位 hex 且 `git rev-list --parents -n 1 $HEAD_SHA` 成功 | `skip` | `scoped` |
| 7 | 其余一切（含 fail-closed） | `run` | `full` |

不变式（由 `scripts/__tests__/ci-scope.test.sh` 逐条钉住）：`heavy == 'skip'` ⇔ `mode ∈ {docs_only, scoped, reuse}`；`mode == 'docs_only'` ⇔ `no_code == 'true'`；输出缺失或为空时：重 job 的 `if` 写成 `!= 'skip'` ⇒ 照跑；聚合 job 名只在 `mode` **显式**属于 {`full`, `docs_only`, `reuse`} 时才是 `CI OK`，空值落到 `CI Scope OK` ⇒ 头上没有 `CI OK`，所有门关闭。两个方向都是 fail-closed。

规则 5 的理由：land refresh（`update-branch`）产生的候选头 C 按 FLY-2632 内容证明合同**恰好两个父提交**（`land-content-proof.ts:675-690`）；runner 为解冲突 merge `origin/main` 产生的头同形。这类头的 main 侧内容是新的，本来就该全量；并且这样 G3 在 C 上永远不会遇到 scoped run（否则 `exactGreenCi` 会把 skipped 判成终态 failed）。判定只看父提交个数，不判断第二父是否在 main 上——判断失误的方向只会多跑，不会少跑。

规则 4 只认 `labeled` 这个**动作**，不认「label 还挂在 PR 上」：之后 `synchronize` 的新头回到规则 6。全量请求因此天然绑定到打 label 那一刻的头。其它 label 被加上时也会触发一次 run（走规则 6，约 7 分钟）；本仓 PR 基本不用 label，接受。

### 2.2 workflow 接线（`ci.yml`）

```yaml
run-name: ${{ (github.event.action == 'labeled' && github.event.label.name == 'ci:full') && format('CI full-request {0}', github.event.pull_request.head.sha) || '' }}

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, labeled]
```

- `run-name` 为空时 GitHub 回落到默认标题。实施第一步用一次真实 push 验证；若平台不接受空值，改为 `|| github.event.pull_request.title || github.event.head_commit.message`，并在 PR 描述里记下采用了哪一种。标记前缀 `CI full-request ` 是 `ci-full ensure` 识别「该头的全量请求 run」的唯一依据（API 字段 `display_title`），`triggering_actor` 给出谁打的 label。
- **全量形状清单**（新文件 `.github/ci-required-jobs.json`）：`{"schema": 1, "aggregate": "CI OK", "aggregate_scoped": "CI Scope OK", "always": ["Classify CI scope", "Quick Gate (build + typecheck + lint)"], "heavy": [<7 个 Unit 展开名、5 个 Script Tests 名、payload 名，共 13 个>]}`。「一次全量 run」的定义从此只有一个：最新 attempt 的 job 名多重集 **恰好等于** `always + heavy + [aggregate]`（16 个，不多不少），且每个 `conclusion == "success"`。三个验证器（G4、`ci-full-reuse.sh`、`ci-full ensure`）都读这一份清单，`ci-structure.test.sh` 把它与 `ci.yml` 展开后的检查名逐字钉住（含变异对照）⇒ 改 job 图而不改清单会在 quick-gate 直接红，验证器之间不会漂移。
- `concurrency` 逐字不动。打 label 时若该头的 scoped run 还在跑，会被同组的全量 run 顶掉——正是想要的。
- classify job：`permissions` 保持 `{contents: read, actions: read}` 不变。步骤顺序：checkout（`fetch-depth: 0`，不变）→ `bash scripts/ci-classify.sh`（`id: classify`，不变）→ `bash scripts/ci-full-reuse.sh`（`id: reuse`，`if: github.event_name == 'push'`）→ `bash scripts/ci-scope.sh`（`id: scope`）。
- 7 个重 job：`needs: [classify]` 不变；`if` 统一改为 `${{ needs.classify.outputs.heavy != 'skip' }}`。矩阵、步骤、shard 清单、timeout、tripwire 全部不动。
- 聚合 job：

```yaml
ci-ok:
  name: ${{ contains(fromJSON('["full","docs_only","reuse"]'), needs.classify.outputs.mode) && 'CI OK' || 'CI Scope OK' }}
  needs: [classify, quick-gate, unit-tests, script-tests, script-tests-2, script-tests-3, script-tests-4, script-tests-5, payload-distribution]
  if: ${{ always() && !cancelled() }}
```

  `jobs.<id>.name` 可用 `needs` 上下文；已用与 CI 同版本的 actionlint 1.7.12 在本机验证该表达式、`run-name`、`labeled` 触发与 `vars` 引用均通过。名字采用「白名单才叫 `CI OK`」的极性有一个具体理由：run 在 classify 产出 `mode` 之前就被取消时，聚合 job 仍会留下一条 cancelled 的检查。QA 在 PR #1250 的真实 run `35296884034` 进一步证明：表达式尚未求值时，GitHub 会把 `jobs.ci-ok.name` 的原始表达式文本记成 check 名，而不是 `CI Scope OK`。它仍对 G1–G3 不可见；G4 从精确头的 `ci.yml` 读取这段原始表达式，只把早于成功 `CI OK` 的同名 cancelled 条目当作受限例外。

- 聚合步骤（保持 `steps[0]`），Lead 硬条件「全量模式逐个断言必需 job」落在这里：

```
printf '%s\n' "$NEEDS_JSON" | jq -e --arg no_code "$NO_CODE" --arg heavy "$HEAVY" --arg mode "$MODE" '
  . as $needs
  | ["unit-tests", "script-tests", "script-tests-2", "script-tests-3", "script-tests-4", "script-tests-5", "payload-distribution"] as $heavy_jobs
  | ($needs["quick-gate"].result == "success")
    and ($needs.classify.result == "success")
    and (
      ( $mode == "full" and $heavy == "run" and $no_code != "true"
        and ($needs["unit-tests"].result == "success")
        and ($needs["script-tests"].result == "success")
        and ($needs["script-tests-2"].result == "success")
        and ($needs["script-tests-3"].result == "success")
        and ($needs["script-tests-4"].result == "success")
        and ($needs["script-tests-5"].result == "success")
        and ($needs["payload-distribution"].result == "success") )
      or
      ( $heavy == "skip"
        and ( ($mode == "docs_only" and $no_code == "true")
              or (($mode == "scoped" or $mode == "reuse") and $no_code != "true") )
        and ($heavy_jobs | all(. as $job | $needs[$job].result == "skipped")) )
    )
'
```

  `unit-tests` 的 `result` 只有在 7 行矩阵全部 success 时才是 `success`，所以 9 个 `needs` id 覆盖了 16 个检查里除聚合 job 自身以外的 15 个。全量分支**不接受** skipped / cancelled / failure 中的任何一个；跳过分支要求 7 个重 job **全部** skipped（不接受一半跑一半跳）。
- 聚合 job 第二步（`if: always()`）：把 `mode`、`heavy`、`no_code`、`tested_tree`、`reuse_run` 写入 `$GITHUB_STEP_SUMMARY`，供人审计。
- 聚合 job 第三步：全量绿时上传证据（§2.6）。

### 2.3 触发全量：`flywheel-comm ci-full ensure`

新子命令（`packages/flywheel-comm/src/commands/ci-full.ts`，在 `index.ts` 注册 `case "ci-full"`）。只新增、不删不改名 ⇒ 不触发 FLY-1914 消费者 sweep 义务。

```
flywheel-comm ci-full ensure [--pr <n>] [--head <sha>] [--retry-lost] [--json]
退出码：0 = 该头 CI OK 为绿   8 = 已请求 / 正在跑 / 刚重跑   1 = 需要人处理的确定性失败   2 = 无法判定（任何观测异常、状态不自洽）
```

**核心纪律：对同一个头，label 最多打一次。** 之后的一切恢复都在**同一个 run** 上用 `gh run rerun` 完成（新 attempt 会替换旧 attempt 的检查；实测 run `35151422945` 第 7 个 attempt 下 `jobs?filter=latest` 只返回最新一组）。原因：同一头上两个独立的全量 run 会各留一条 `CI OK`，而 G3 要求**所有**名为 `CI OK` 的条目都 SUCCESS（PR #1212 实测同头两条 `CI OK` 并存）——一条 cancelled 的旧 `CI OK` 会让这个头在 land 路径上永久 failed。

**run 的身份只由不可变证据决定，绝不读当前的 `CI_SCOPED_MODE`**（变量会变，历史 run 不会）：

- 「全量请求 run」：`displayTitle == 'CI full-request ' + H`。
- 名字集合来自 `git show H:.github/ci-required-jobs.json`（§2.2）；读不到或不合 schema ⇒ 退出 2。常驻集合 = `always` ∪ {`aggregate`, `aggregate_scoped`}。
- 「全量形状」：该 run 最新 attempt 的 job 里，存在名字不在常驻集合内、且 `status`/`conclusion` 不是 `skipped` 的 job。
- 「scoped 形状」：存在名为 `aggregate_scoped` 的 job，或常驻集合之外的 job 全部 `skipped`。
- 「未定形」：run 未完成且目前只看得到常驻集合内的 job。
- **run 的时间 = 最新 attempt 的开始时间** `epoch(run)` = `gh api repos/{r}/actions/runs/{id}` 的 `run_started_at`（rerun 会重置它；顶层 `created_at` 不会变——实测 run `35151422945` 第 7 个 attempt：`created_at` 仍是 21:16:13Z，`run_started_at` 是 22:59:13Z）。所有「新旧」比较一律用 `epoch`，与 G4 用 `K.startedAt`（同样来自最新 attempt）的语义一致；`run_started_at` 缺失或不可解析 ⇒ 退出 2。
- `F` = 头 H 上属于「全量请求 run」或「全量形状」的 run 集合；`N` = `F` 中 `epoch` 最新的一个。

**耐久回执**（write-ahead，先于任何外发动作落盘）：`$FLYWHEEL_STATE_DIR/ci-full/<owner>__<repo>/<pr>/<H>.json`，原子写（临时文件 + rename），字段 `{schema: 1, head, pr, state: intent|labeled|aborted_head_moved, requested_at, requester_exec_id, lost_retries: 0|1, reran: [<run id>…]}`。`$FLYWHEEL_STATE_DIR` 为本机所有 runner 与 Lead 共享。

**互斥**：复用仓库已有、flywheel-comm 已在用的 `withMkdirLock`（`packages/config/src/mkdir-lock.ts:304`；现有调用方 `stage-queue.ts`、`qa-result.ts`），锁键 `<owner>__<repo>__<pr>`，覆盖下面步骤 2–5；陈旧锁回收沿用该 helper 的既有语义。拿不到锁 ⇒ 退出 8。（本机 Node v25.6.1 的 `fs.constants.O_EXLOCK` 为 `undefined`，不用它。）

算法（每个 `gh` / `git` 子进程 15 秒超时；任何解析失败 ⇒ 退出 2，不做外发动作）：

1. `gh pr view [n] --json number,state,isCrossRepository,headRefOid,url`：须 `OPEN`、非跨仓。H = `--head`，否则 `git rev-parse HEAD`；`H != headRefOid` ⇒ 2（`head_mismatch`）。
2. 取锁。读回执。`gh run list --workflow ci.yml --commit H --event pull_request --limit 50 --json databaseId,status,conclusion,displayTitle,createdAt,url,attempt`；返回恰好 50 条 ⇒ 2（`too_many_runs`）。对每个 run 读 `gh api repos/{r}/actions/runs/{id}`（取 `run_started_at`）与 `…/jobs?filter=latest&per_page=100`（判形状；`total_count > 100` ⇒ 2）。
3. 毒条目检查：`F` 中除 `N` 以外的任何 run，若其最新 attempt 有名为 `CI OK` 且结论不是 `success` 的 job ⇒ 1（`stale_non_success_ci_ok`，打印该 run 的 `url` 与补救命令 `gh run rerun <id>`）。`ensure` 自己永远不会制造这种状态，它只可能来自外部动作（有人手动重复打 label、手动取消）。
4. 按下表处理（自上而下首条命中）：

| 状态 | 动作 | 退出 |
|---|---|---|
| `N` 未完成（`queued` / `in_progress` / `waiting` / `requested` / `pending`） | 无 | 8 `full_running` |
| `N` 完成且 `success`，`N` 最新 attempt 的 job 多重集恰等于清单的 16 个且全部 `success`，且 H 上没有 `epoch` 晚于 `epoch(N)` 的 scoped 形状 run | 无 | 0 `full_green` |
| 同上，但 H 上有 `epoch` 晚于 `epoch(N)` 的 scoped 形状 run（有人在全量绿之后 reopen / 打了别的 label） | 无；打印补救 `gh run rerun <N>`。rerun 之后 `epoch(N)` 前移到新 attempt 的开始时间，晚于那个 scoped run ⇒ 下一次调用落到上一行返回 0；G4 侧新的 `CI OK.startedAt` 也同步变晚（§2.5） | 1 `superseded_by_scoped_run` |
| `N` 完成且 `success`，但 job 多重集不等于清单（缺 job、多 job、有 skipped） | 无；打印 `url` | 2 `inconsistent` |
| `N` 完成且 `cancelled`，回执 `reran` 里没有 `N` | 先把 `N` 记入回执 `reran`，再 `gh run rerun <N>` | 8 `full_rerun_after_cancel` |
| `N` 完成且 `cancelled`，回执 `reran` 里已有 `N` | 无；打印 `url` | 1 `cancelled_again` |
| `N` 完成且 `failure` / `timed_out` / `startup_failure` | 无；打印 `url`。抖动 ⇒ 人或 runner 跑 `gh run rerun <N> --failed`；账单受限的 `startup_failure` ⇒ 恢复后 `gh run rerun <N>`；真问题 ⇒ 修完推新头 | 1 `full_failed` |
| `N` 完成且结论为 `action_required` / `neutral` / `skipped` / `stale` / 任何未列出的值 | 无；打印 `url` | 2 `unrecognized_conclusion` |
| `F` 为空，但 H 上有未定形的在跑 run | 无（等它定形；合并头与开关关着时的 run 都会在约 30 秒内长出重 job） | 8 `run_shape_pending` |
| `F` 为空，回执 `state ∈ {intent, labeled}`，`requested_at` 距今 ≤ 10 分钟 | 无 | 8 `request_pending_visibility` |
| `F` 为空，回执存在且超过 10 分钟，未带 `--retry-lost` 或 `lost_retries == 1` | 无；打印人工恢复说明 | 2 `request_lost` |
| `F` 为空，回执超过 10 分钟，带 `--retry-lost` 且 `lost_retries == 0` | 回执 `lost_retries = 1`、刷新 `requested_at`，转步骤 5 | — |
| `F` 为空，无回执 | 转步骤 5 | — |

5. 请求（仍持锁）：(a) 原子写回执 `state: intent`；(b) **再读一次** `gh pr view --json headRefOid`，不等于 H ⇒ 回执改 `aborted_head_moved`，退出 2；(c) `gh label create ci:full --color 5319e7 --description "Request the full CI matrix for the current PR head" --force`；(d) 若 PR 已挂该 label：`gh pr edit <n> --remove-label ci:full`；(e) `gh pr edit <n> --add-label ci:full`；(f) 回执改 `labeled`；(g) 每 5 秒重读 run 列表直到出现标题为 `CI full-request H` 的 run，最多 60 秒；无论是否等到都退出 8。本机 `gh` 是用户令牌，事件会触发 workflow（`GITHUB_TOKEN` 产生的事件不会，所以这个动作不能放进 Actions 里做）。

崩溃与丢响应：(a) 之后、(e) 之前崩溃 ⇒ 回执停在 `intent`，label 没打上，10 分钟内后续调用只观察，之后报 `request_lost`，由显式的 `--retry-lost` 至多再请求一次；(e) 成功但响应丢失或进程崩溃 ⇒ 回执停在 `intent`，run 会在 API 里出现，后续调用在步骤 4 命中 `N`；run 可见性超过 60 秒 ⇒ 后续调用落在 `request_pending_visibility`。**任何分支都不会在没有显式 `--retry-lost` 的情况下第二次 toggle label。**

幂等性（Lead 判据「同一头重复调用不产生第二次全量」）：`F` 非空时没有任何分支会打 label；`F` 为空时有回执就不会打 label。并发调用由锁串行化。

谁调用：

| 时刻 | 调用者 | 形式 |
|---|---|---|
| QA 冻结头 | QA runner | `packages/teamlead/phase-protocols/qa.md` 第一步：`ci-full ensure`，8 则继续做 QA，发 `qa-result --status pass` 前必须再跑一次且得到 0 |
| 立卡前 | `gate approve_to_ship` 前置守卫（`gate.ts:96-101`） | `probeShipCiGreen` 不绿时 best-effort 调一次 ensure（不带 `--retry-lost`），然后**照旧抛错**：`CI not green: <detail>; full CI: <ensure 的状态词>` |
| 立卡前（提示词层） | `packages/edge-worker/src/Blueprint.ts:1843` 的 `CI PRECONDITION` | 把 `gh pr checks` 探针换成 `ci-full ensure` 的退出码合同（0 继续 / 8 等待并保活 / 1、2 = 真失败，按打印的补救处理） |
| land refresh 候选头 | classify 规则 5 | 无需任何调用 |
| 人工 | Lead / founder | GitHub UI 打 label（只在该头从未请求过时），或跑同一条命令 |

**触发时机只关乎成本与延迟，不关乎安全。** 没人触发的后果是「头上没有 `CI OK`，所有门拒绝」，可见、fail-closed。

### 2.4 四个门在新方案下的行为

| 头的状态 | G1 分支保护 | G2 `ship-await-ci.sh` | G3 land `exactGreenCi` | G4 `probeShipCiGreen`（§2.5 改后） |
|---|---|---|---|---|
| 只有 scoped run（绿） | `CI OK` Expected ⇒ 不可合并 | 无 `CI OK` ⇒ 等满 25 分钟 `await_ci_timeout` | 无 `CI OK` ⇒ 退回全条目规则 ⇒ 有 SKIPPED ⇒ `failed` | 无 `CI OK` ⇒ 旧的 ALL-pass 规则 ⇒ skipping ⇒ 不绿 |
| scoped run + 全量 run 进行中 | 同上 | 等 | 无 `CI OK`，有未完成条目 ⇒ `pending` | 不绿（旧规则，pending） |
| scoped run（完成或被顶掉）+ 全量绿 | 可合并 | success | 唯一的 `CI OK` 条目 SUCCESS ⇒ green | `K` pass、API 回验每个 job success、其余条目 pass 或属于受限例外 ⇒ 绿 |
| scoped run + 全量红 | `CI OK` failure | `ci_failure` | failed | 不绿 |
| 全量被取消后经 `gh run rerun` 同 run 重跑变绿 | 可合并 | success | 新 attempt 替换旧检查，只有一条 `CI OK` ⇒ green | 绿 |
| 同一头上有两个独立全量 run，其一 `CI OK` 非 success（只可能来自外部手动动作） | 以最新为准 | 以最新为准 | failed（今天同样如此） | 以最新 `K` 为准；`ensure` 报 `stale_non_success_ci_ok` 并给出 rerun 补救 |
| 全量绿之后又触发了 scoped run | 可合并 | success | green | 不绿（晚于 `K` 的 skipped 条目，与今天的 ALL-pass 结论相同）；`ensure` 报 `superseded_by_scoped_run` |
| run 在 classify 出结果前被取消 | 无 `CI OK` | 等 / 看后续 run | 遗留的是 cancelled `CI Scope OK`，G3 不看它 | 早于 `K` ⇒ 受限例外 |
| 纯文档（`docs_only`） | 可合并（今天同） | success（今天同） | green（今天同） | 不绿（今天同：判定 run 内有 skipped） |
| 合并头（规则 5），全量绿 | 可合并 | success | green | 绿 |
| `CI_SCOPED_MODE` off | 与今天逐项相同 | 同 | 同 | 同（多一次 API 回验；结论不变） |

G1/G2/G3 的代码零改动。G2 在「只有 scoped run」的头上要等满 25 分钟才报超时，这是体验问题不是安全问题，留 follow-up（§8）。

### 2.5 G4 的最小改动（W3，Lead 已裁定；Codex R1 后收紧）

问题：全量 run 盖不掉两类**更早的**遗留条目——矩阵占位检查 `Unit (${{ matrix.name }})`（skipped）与旧 scoped run 的 `CI Scope OK`（打 label 顶掉了还在跑的 scoped run 时它是 cancelled）。按今天的 ALL-pass 规则，这个头永远不绿。

原则：**豁免面只有「早于最新 `CI OK`、名字恰为 `CI Scope OK`、矩阵占位名、或精确头 `ci.yml` 中 `jobs.ci-ok.name` 的原始表达式」的条目；其余一切与今天同样严格，晚于 `CI OK` 的任何非 pass 条目照旧拒绝。** 原始表达式必须从精确头读取并按当前固定 YAML 形状解析；读取或解析失败就不加入例外集合，保持 fail-closed。

命令执行器改造：`ShipCiCommandRunner` 从「返回 stdout、非零退出即抛错」改为返回 `{stdout, status, signal, error}`。`gh pr checks` 在有 fail / cancel 条目时退出 1、有 pending 时退出 8，而 stdout 仍是合法 JSON；今天的 `execFileSync` 会在读到 JSON 之前抛错，导致带一条遗留 cancelled 条目的头永远无法被判绿。执行器返回 `{stdout, status, signal, error}`。`gh pr checks` **只有在正常终止时**才解析 stdout：`error` 为空、`signal` 为空、`status ∈ {0, 1, 8}`（gh 的全过 / 有失败 / 有 pending）。超时（`status === null`、`signal === 'SIGTERM'`、`error.code === 'ETIMEDOUT'`）、被信号杀死、任何其它退出码（认证失败、网络错误等）⇒ 不绿，**哪怕 stdout 恰好是一段可解析的 JSON**——子进程超时并不保证 stdout 为空，半截输出里可能只有绿的那部分。正常终止后 stdout 解析不成非空数组 ⇒ 不绿。`gh pr view` 与 `gh api` 调用仍然「非零即不绿」。

新规则（`gh pr checks --json bucket,name,state,workflow,link,startedAt,event`）：

1. `mergeStateStatus` 与精确头校验不变。
2. 自己做一遍去重（不依赖 gh 版本）：按 `(workflow, name, event)` 保留 `startedAt` 最新的一条；`startedAt` 缺失或不可解析的条目不参与去重、原样保留并按第 6 条从严处理。
3. 不存在名字**恰为** `CI OK` 的条目，**或** `git show H:.github/ci-required-jobs.json` 读不到 / 不合 schema（别的项目仓库、尚未合入本单的旧头）⇒ 沿用旧规则：`gh pr checks` 退出 0 且所有条目 `bucket == "pass"`，没有任何例外（scoped-only 的头落在这里 ⇒ 不绿）。清单取自 PR 头自己的提交：PR 本来就能改自己的 `ci.yml`，这份清单防的是「job 图被意外改短 / classify 出 bug」，它与 `ci.yml` 的一致性由常驻的 `ci-structure.test.sh` 钉住。
4. 存在：取 `startedAt` 最新的 `CI OK` 为 `K`；要求 `K.bucket == "pass"`；从 `K.link` 用 `^https://github\.com/([^/]+/[^/]+)/actions/runs/(\d+)/` 取仓库与 run id，取不到、或仓库与 `gh pr view --json url` 的仓库不一致 ⇒ 不绿。
5. 用 Actions API 把 `K` 绑定到不可伪造的事实，任一不满足 ⇒ 不绿：`gh api repos/{r}/actions/runs/{id}` 的 `head_sha == H`、`event == "pull_request"`、`path == ".github/workflows/ci.yml"`、`status == "completed"`、`conclusion == "success"`、`repository.full_name == head_repository.full_name == {r}`；`gh api repos/{r}/actions/runs/{id}/jobs?filter=latest&per_page=100`：`total_count ≤ 100`；job 名多重集**恰好等于** `git show H:.github/ci-required-jobs.json` 的 `always + heavy + [aggregate]`（16 个；缺任何一个矩阵行、缺任何一个 script shard、多出未知 job、同名重复，都不等）；**每一个** job `conclusion == "success"`（零 skipped / cancelled / failure）。⇒ Lead 担心的「classify 出 bug 全 skipped 而 `CI OK` 绿」在这里被拒；纯文档头也照旧被拒（同一 run 内有 skipped），与今天一致，不借机放宽。显示名 `workflow` 不作身份依据，身份来自 run 的 `path`。
6. `K` 之外的每一个条目必须 `bucket == "pass"`，**唯一例外**是同时满足以下全部条件的条目：名字恰为 `CI Scope OK`、`Unit (${{ matrix.name }})`，或从精确头 `.github/workflows/ci.yml` 读取的 `jobs.ci-ok.name` 原始表达式；`startedAt` 可解析且**严格早于** `K.startedAt`；`bucket ∈ {skipping, cancel, pass}`；link 里的 run id 可解析且不等于 `K` 的 run id。
7. 因此：全量绿之后同一头上又触发的 scoped run，其 Quick Gate 的 fail / pending / cancel，以及它那批 skipped 的重 job 条目（晚于 `K`、名字不在例外集合）都会让守卫拒绝——与今天的 ALL-pass 结论相同。这个状态由 `ci-full ensure` 识别为 `superseded_by_scoped_run`，补救是 `gh run rerun <K 的 run id>`（§2.3）。它只会由「全量绿之后 reopen PR 或打了别的 label」引发；本仓 PR 不用其它 label，`ensure` 在 `F` 非空时也绝不打 label。

与 Lead 裁定文字的关系：Lead 写的是「fail/pending/cancelled 仍拒」。本规则逐字满足，仅有一处受限例外——**早于** `K` 的旧聚合条目允许是 cancel（正常求值时名为 `CI Scope OK`；尚未求值时名为精确头的原始表达式），因为打 label 顶掉在跑的 scoped run 是主路径，不豁免它这个头就永远过不了门。PR 描述里明示这一点。Lead 的第二个要求（区分 `full` 与 `docs_only`）由第 5 条以更强的形式满足：守卫独立回验「判定 run 的每个 job 都 success」，不依赖 classify 自报的 `mode`；`mode` 仍写进 step summary 供人读。

### 2.6 main push 内容复用（单子第 4 点）

**写证据**（聚合 job 第三步，条件：聚合步骤 success 且 `mode == 'full'` 且 `tested_tree` 为 40 位 hex）：`actions/upload-artifact@v4`，名字 `ci-full-green-<tested_tree>`，`retention-days: 14`，内容是一行给人看的说明。**artifact 只是「树 → run id」的索引：读取方只用 API 返回的元数据（`workflow_run.id`），从不下载、从不读取 artifact 的内容**，因此没有压缩包解析面，也没有可被伪造的自述字段。

**读证据**（`scripts/ci-full-reuse.sh`，仅 push 事件，仅 `CI_SCOPED_MODE == 'on'`）：令 `M = $GITHUB_SHA`，`T = git rev-parse M^{tree}`，`P = git rev-parse M^1`（main 在这次合入之前的尖端）。任何一步不满足、任何命令失败或超时 ⇒ 输出 `reuse=false`，照常全量：

1. `gh api "repos/{r}/actions/artifacts?name=ci-full-green-T&per_page=10"`，取 `expired == false` 的，按 `created_at` 倒序最多看 5 个。
2. 对每个候选取 `R = workflow_run.id`，`gh api repos/{r}/actions/runs/R`：`path == ".github/workflows/ci.yml"`、`status == "completed"`、`conclusion == "success"`、`repository.id` 与 `head_repository.id` 都等于本仓、`event ∈ {pull_request, push}`。记 `h = head_sha`（API 给的，不可伪造）。
3. `gh api "repos/{r}/actions/runs/R/jobs?filter=latest&per_page=100"`：`total_count ≤ 100`；job 名多重集**恰好等于** checkout 里 `.github/ci-required-jobs.json` 的 `always + heavy + [aggregate]`；**每个** job `conclusion == "success"`。与 G4、`ensure` 用的是同一份清单、同一个定义（§2.2）。
4. **独立重算所测树**：
   - `event == push`：`git rev-parse h^{tree} == T`。
   - `event == pull_request`：`git fetch --no-tags origin h`，然后 `git merge-tree --write-tree P h` 的输出首行必须等于 `T`。含义：那次全量测的是「h 合到当时的 main 尖端」，只有当那个尖端就是 `P`（从全量开跑到合入之间 main 没动）时，所测的树才可能等于今天 main 的树；用 `P` 重算既不需要 run 自述它当时的 base，又恰好覆盖了可复用的全部情形（§1.4 实测的 6 个命中全部是 main 未动）。`git merge-tree --write-tree` 不可用、有冲突、fetch 失败 ⇒ 不复用。
5. 全部通过 ⇒ `reuse=true`、`reuse_run=R`。

classify job 的 `permissions` 保持 `{contents: read, actions: read}` 不变（artifact 与 run 查询只需 `actions: read`；不读任何 PR 端点）。

为什么这不放松任何门：main push 的 CI 不是任何合并门的输入（合并已经发生）；它的作用是发现「合并偏斜」。树相同 ⇒ 被测输入逐字节相同（含 `ci.yml` 与全部脚本），不存在偏斜。伪造面：artifact 名字可以被任何 run 随意写，但命中后的每一项判断都来自 API 元数据与本地 git 重算——要让树 `T` 命中，必须真的存在一个本仓 `ci.yml` 的 run，它的 `head_sha` 合到 `P` 上恰好得到 `T`，并且它的每个 job 都 success。CI 本来也不是本仓的安全边界（FLY-1861 裁定）。

**PR 头复用本单不做**，原因写明：复用 run 必然让重 job 处于 skipped，而 G4 第 5 条要求判定 run 的每个 job 都 success ⇒ 复用的头过不了 runner 门。要做就得让 G4 去独立回验证据，那是另一个门的语义变更，单独立项（§8）。09-16 全天只有 1 个这样的头，收益也小。

### 2.7 第 3 点（设计产物不触发 Unit）

已经满足，不需要新代码：`engineering/doc/**` 目录级 inert（FLY-2245），`product/doc/**`、`doc/**`、`content/doc/**` 按 26 个后缀 inert（FLY-2001）。09-16 的 6 次纯文档 PR run 平均计费 6.5 分钟（Classify + Quick Gate + `CI OK`）。

**不**把「任意位置的 `*.md`」加进 inert：仓库里 doc 前缀之外有 259 个 `.md`，其中 `packages/teamlead`（62）、`.claude/skills`（56）、`packages/edge-worker`（31）、`.flywheel/agents`（11）被 shell suite 与 vitest 直接读取；FLY-1987 research §4.6 已用两个真实反例否掉「某类文件一律 inert」。新方案下这类改动在普通头上本来也只跑廉价门，第 3 点的成本诉求已由分层覆盖。

### 2.8 开关、上线顺序、回滚

| 步骤 | 谁 | 核对 |
|---|---|---|
| 合入本 PR | 正常 land | 变量未设 ⇒ 判定表第 2 行 ⇒ 每头全量，与今天相同；唯一可见差异是 `labeled` 事件也会触发一次全量 |
| 等主仓部署，并逐项 canary | 独立 updater；Lead 核对 | (1) `node $FLYWHEEL_COMM_CLI ci-full ensure --pr <任一已合 PR> --json` 能跑出结构化状态；(2) 新 G4 已在 dist：`grep -c "CI Scope OK" $(dirname $FLYWHEEL_COMM_CLI)/ship-ci-guard.js` ≥ 1；(3) 新派一个 runner，其提示词里的 `CI PRECONDITION` 已是 `ci-full ensure` 合同（Blueprint 来自已部署的 edge-worker dist）；(4) `.flywheel/agents/nodes/qa.md` 与 `implement.md` 的 managed block 含 `ci-full ensure`（`node scripts/sync-phase-protocols.mjs --check` 绿）。四项齐了才打开 |
| 打开 | Lead：`gh variable set CI_SCOPED_MODE --body on` | 下一个普通 PR 头：只有 3 个检查在跑，聚合检查名为 `CI Scope OK`，没有 `CI OK` |
| 回滚 | Lead：`gh variable set CI_SCOPED_MODE --body off`（或删除） | 下一个头恢复 16 job + `CI OK`；已经在 scoped 状态的头需要一次新的事件（push 或打 label）才会拿到 `CI OK` |

先开变量、后部署 dist 的后果：冻结头全量绿后，旧 dist 的 G4 会被矩阵占位检查卡住（fail-closed，不是放行）。所以顺序写死为「先部署、后打开」，PR 描述里带这张表。

PR 分支上的 `pull_request` run 用的是 PR 自己 merge ref 里的 `ci.yml`，其它在飞 PR 在 merge main 之前继续用旧 `ci.yml`（忽略变量）⇒ QA 期间打开变量只影响本 PR，不影响别人。

---

## 3. 改动清单（按 chunk）

| Chunk | 文件 | 内容 |
|---|---|---|
| C1 | `scripts/ci-scope.sh`（新）、`scripts/__tests__/ci-scope.test.sh`（新） | §2.1 判定表；测试用真实临时 git 仓库覆盖 7 行判定 + 不变式 + 负面对照（脚本里无 `gh`/`jq`/API 的残留标尺，带阳性对照，仿 `ci-classify.test.sh:404-424`） |
| C2 | `scripts/ci-full-reuse.sh`（新）、`scripts/__tests__/ci-full-reuse.test.sh`（新） | §2.6 读证据；测试用 PATH 注入的 `gh` 桩 + 真实 git 仓库，逐条打掉回验条件（run 非 success、`path` 不是 `ci.yml`、仓库 id 不符、有 skipped job、缺 `CI OK` job、缺任一矩阵行、缺任一 script shard、总数 15 但全 success、多一个未知 job、清单文件缺失或畸形、merge-tree 结果不等 / 冲突、`git fetch` 失败、push 证据树不等、artifact 过期、候选超过 5 个、API 失败 / 超时、`total_count > 100`）各自 ⇒ `reuse=false`；并断言脚本**从不**请求 artifact 的下载端点（对 `gh` 桩的调用日志做负面断言，带阳性对照） |
| C3 | `.github/workflows/ci.yml`、`.github/ci-required-jobs.json`（新） | §2.2：全量形状清单；`run-name`、`types`、classify 权限与三步、7 个 `if`、聚合 job 名 / jq / summary / 证据上传；把两个新 suite 字面登记进 `quick-gate`（治理类、纯 bash、秒级） |
| C4 | `scripts/__tests__/ci-structure.test.sh`、`packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts`、`scripts/__tests__/workflow-startup.test.mjs` | 同步钉新合同：重 job `if` 新字面量；classify 权限字典**保持**原值、三个 run 步骤的字面量 / id / 顺序 / `reuse` 步骤的 `if`；`.github/ci-required-jobs.json` 与 `ci.yml` 展开后的检查名（7 个矩阵行逐个展开）逐字相等，`aggregate` / `aggregate_scoped` 与聚合 job `name` 表达式里的两个字面量相等，并配变异对照（删一个 shard 名、改一个矩阵行名各自必须红）；fly-889 守卫补上 `script-tests-5`；**新增** `on:` 与 `run-name` 的逐字断言（今天不读 `on:`）；`classify.outputs` 五个键（`no_code`、`heavy`、`mode`、`tested_tree`、`reuse_run`）；聚合 job `name` 表达式逐字；jq 聚合体逐字；证据上传步骤的 `if` 与 artifact 名。每条新钉子配一条变异对照（仿 `:301-324`）：把 `!= 'skip'` 改成 `== 'run'`、删掉 jq 里任一重 job 的 success 断言、把 `'CI Scope OK'` 与 `'CI OK'` 对调、去掉 `labeled`，各自必须红 |
| C5 | `packages/flywheel-comm/src/ship-ci-guard.ts` + `__tests__/ship-ci-guard.test.ts` | §2.5：执行器改为返回 `{stdout, status, signal, error}`，`gh pr checks` 只在正常终止（status ∈ {0,1,8}）时解析；新规则；测试矩阵见 §4.2。`gate.ts` / `verify-approval.ts` 的注入桩签名随之更新 |
| C6 | `packages/flywheel-comm/src/commands/ci-full.ts`（新）+ 测试、`src/index.ts` 注册、`src/commands/gate.ts` 前置守卫补请求 + 测试 | §2.3；`gh` / `git` / 锁 / 时钟 / 状态目录全部可注入；测试逐行覆盖步骤 4 的状态表，外加：add-label 成功后崩溃、响应丢失、可见性延迟 > 60 秒、> 10 分钟的丢失请求（带与不带 `--retry-lost`、第二次丢失）、锁内头移动、陈旧锁、两进程并发、`CI_SCOPED_MODE` on→off 与 off→on 后回到旧头、合并头、cancelled 后只 rerun 一次；两条时序对照（用 `run_started_at` 而非 `created_at`）：「A 全量 → B scoped → rerun A」⇒ 0，「A scoped → B 全量 → rerun A」⇒ `superseded_by_scoped_run`；`N` 的 job 多重集缺一个 ⇒ `inconsistent`；清单读不到 ⇒ 2；对 `gh` 桩的调用日志断言「每个头 `--add-label` 至多一次（`--retry-lost` 时至多两次）」。`gate.ts` 的改动不得让任何原来抛错的路径变成不抛错（测试逐条断言） |
| C7 | `packages/edge-worker/src/Blueprint.ts:1843`、`packages/teamlead/phase-protocols/{qa,implement}.md`（canonical）、`.flywheel/agents/nodes/{qa,implement}.md`（生成投影） | §2.3 文本。先改并审阅 canonical，再跑 `node scripts/sync-phase-protocols.mjs --write` 生成投影，两份投影列入本 PR；以 `--check`（`packages/teamlead` 的 `prebuild` 强制）与 FLY-2533 packed phase protocols suite 验证；同步所有钉住 `CI PRECONDITION` 字符串的测试（实施前 `grep -rn "CI PRECONDITION"`） |
| C8 | `engineering/doc/FLY-2681-ci-on-demand-matrix/data/ci-cost.py`（新）、PR 描述 | §5 度量；PR 描述含 §1.3–1.4 两张表、§2.8 开关与 canary 表、§2.5 的受限例外说明 |

不改：`scripts/ci-classify.sh`、`scripts/ship-await-ci.sh`、`.github/workflows/ship-on-comment.yml`、`land-executor.ts`、`StateStore.ts`、`gate-origin-preflight.ts`、`workflow-decision-routes.ts`、unit 矩阵、任何 shard 的步骤清单、`concurrency`、required check 名。

实施顺序：C1 → C2 → C5 → C6（都可独立 TDD、互不依赖）→ C3 + C4（一起改，`ci-structure.test.sh` 本地先红后绿）→ C7 → C8。

---

## 4. 测试与 QA 判据

### 4.1 判据映射（按 Lead 修订后的判据）

| 判据 | 证据 |
|---|---|
| 普通头只跑廉价门 | 真实 PR 头（`CI_SCOPED_MODE=on`）：检查列表只有 `Classify CI scope`、`Quick Gate`、`CI Scope OK` 为已执行，7 个重 job skipped，**不存在** `CI OK`；`gh api …/check-runs` 原始输出贴进 QA 报告 |
| 被请求全量的头：16 job 全跑、`CI OK` 有确定结论 | 同一头上 `ci-full ensure` ⇒ 8；run 标题 `CI full-request <sha>`；16 个检查全部 success；`CI OK` success；`ensure` 再跑 ⇒ 0 |
| `ensure` 重复调用不产生第二次全量 | 全量跑的过程中与跑完后各调 3 次；`gh run list --commit H --event pull_request` 的 run 数保持为 2（1 scoped + 1 full）；并发两进程同时调一次，run 数仍为 2 |
| 纯文档头 `CI OK` 有确定结论 | 合入前：`ci-classify.test.sh`（不变）+ `ci-scope.test.sh` 第 1 行 + 用 `ci.yml` 里抽出的 jq 聚合体对 `docs_only` 的 needs 夹具求值（`ci-structure.test.sh` 内）。**合入前无法在真实 PR 上演示**：docs-only 由整个 PR 的累计 diff 决定，而本 PR 含代码；合入后第一个设计节点 PR 由 Lead 观察，写进 7 天复核 |
| 三个硬门对未请求全量的头 fail-closed | G1：`gh api repos/{r}/commits/H/status` + PR 页 `CI OK — Expected`；G2：`scripts/__tests__/ship-await-ci.test.sh` 新增一例（check-runs 里只有 `CI Scope OK`）⇒ 不 success；G3：`land-executor.test.ts` 新增一例（rollup 里无 `CI OK` 且含 SKIPPED）⇒ `failed`——这两例只加测试，不改被测代码，用来把「零改动仍 fail-closed」钉成回归 |
| 冻结头没有全量绿就不能出卡 | `gate approve_to_ship` 在 scoped-only 头上抛 `CI not green`（单测 + 真实 PR 上手动跑一次）；`verify-approval` 同头返回 `ci_not_green` |
| 合并头直接全量 | 真实 PR 上 merge 一次 `origin/main`：该头无需 label 即 16 job + `CI OK` |
| 节省：常规 ≥59%（含 main 复用 ≥66%）；最坏（+10）≥46%（含 main 复用 ≥54%） | §1.4 + `data/replay.py` 可复跑 |
| 开关关着 = 今天 | 变量未设时的真实 PR 头：16 job + `CI OK`；`ci-scope.test.sh` 第 2 行 |

### 4.2 G4 单测矩阵（`ship-ci-guard.test.ts`）

| 输入 | 期望 |
|---|---|
| 无 `CI OK`，全 pass，gh 退出 0 | 绿（旧规则） |
| 无 `CI OK`，含 skipping（scoped-only 头） | 不绿 |
| `K` pass + API 回验通过；另有**早于** `K` 的 `Unit (${{ matrix.name }})` skipping 与 `CI Scope OK` cancel；gh 因 cancel 条目退出 1 但 stdout 是合法 JSON | 绿 |
| 同上，但旧聚合 job 在取消前未求值，名字是精确头 `ci.yml` 的原始 `jobs.ci-ok.name` 表达式 | 绿；若原始名不匹配精确头或时间不早于 `K` 则不绿 |
| 同上，但遗留条目的 `startedAt` **晚于** `K` | 不绿 |
| 同上，但遗留条目名字是 `Quick Gate (build + typecheck + lint)`（fail / pending / cancel 各一例，晚于 `K`：全量绿后又触发的 scoped run） | 不绿 |
| 早于 `K` 的 `CI Scope OK` 为 fail | 不绿 |
| 遗留条目 `startedAt` 缺失 / 不可解析，或 link 无 run id，或 run id 等于 `K` 的 | 不绿 |
| `K` pass，但 API：`head_sha` ≠ H / `event` 不是 `pull_request` / `path` 不是 `ci.yml` / 仓库不符 / `conclusion` 不是 success（各一例） | 不绿 |
| `K` pass，但 API jobs 里有一个 skipped（纯文档 / classify bug）/ cancelled / failure / 缺 `CI OK` job / `total_count > 100` | 不绿 |
| 另一个 workflow 的显示名也叫 `CI`，它有一条 skipping | 不绿（显示名不作身份） |
| 其它 workflow 有一条非 pass | 不绿 |
| 两条 `CI OK`：旧 pass、新 fail | 不绿（取最新） |
| 两条 `CI OK`：旧 fail、新 pass，新 run 回验通过 | 绿（G3 此时仍会 failed，由 `ensure` 的 `stale_non_success_ci_ok` 暴露；本守卫只回答 G4） |
| `K` pass，API jobs 全 success 但只有 3 个（Classify / Quick Gate / `CI OK`）；或 15 个（缺一个 script shard）；或缺一个矩阵行；或多一个未知 job；或同名重复 | 不绿 |
| PR 头上没有 `.github/ci-required-jobs.json`（或畸形），其余同「绿」的那一行 | 退回旧规则 ⇒ 因遗留条目不绿 |
| `gh pr checks` 输出了一段合法、全绿的 JSON 后超时（`status: null`、`signal: SIGTERM`、`error.code: ETIMEDOUT`） | 不绿 |
| `gh pr checks` 合法 JSON + 未知退出码（2、4、127 各一例） | 不绿 |
| `gh pr checks` 退出 1 / 8 且 stdout 是完整合法 JSON | 按规则判（分别对应上面的绿例与 pending 例） |
| `gh pr checks` 正常终止但 stdout 不是合法 JSON / 是空数组 | 不绿 |
| `gh api` 任一调用失败或超时 | 不绿 |
| 现有全部用例（argv 钉子随新字段更新；`--required` 仍禁止；`UNSTABLE`/`DIRTY`/头不匹配） | 保持原结论 |

### 4.3 本单自己的 CI

Actions 账单可能仍受限。实施与 QA 如实记录每次 run 的 `conclusion`；`startup_failure` / 「job was not started because … spending limit」不算测试结论，等恢复后 `gh run rerun`，不绕过任何门。

---

## 5. 度量（单子第 5 点）

`data/ci-cost.py --from <day> --to <day>`：

1. `GET /repos/{r}/actions/workflows/ci.yml/runs?created=<day>`（分页）→ 每个 run `GET …/runs/{id}/jobs?filter=all`。
2. 计费分钟 = Σ `ceil((completed_at − started_at)/60)`，skipped 计 0，按 `(run_id, name, started_at, completed_at)` 去重（rerun 带过来的绿 job 不重复计费）。
3. 每个 run 归类：`push` / PR-scoped（聚合 job 名 `CI Scope OK`）/ PR-full（`display_title` 前缀 `CI full-request ` 或聚合名 `CI OK` 且重 job 非 skipped）/ docs-only / reuse。
4. 输出：日 run 数、日计费分钟、各类占比、「每个 PR 头平均分钟」「每次全量平均分钟」「全量次数 ÷ 当日合入 PR 数」。
5. 「同等派工量」归一：Lead 在本机补一列当日 QA 会话数（`sqlite3 -readonly ~/.flywheel/teamlead.db "select count(*) from sessions where project_name='flywheel' and workflow_node_id='qa' and started_at >= … "`），主指标 = 计费分钟 ÷ QA 会话数。基线：2026-09-16 = 10,936 ÷ 15 = **729 分钟/QA 会话**。目标：常规 ≤ 299（59%）；最坏（+10、main 不复用）≤ 391（46%）。

合入并打开变量 7 天后由 Lead 复跑并把结果写进 `engineering/doc/milestones/FLY-2681.md`。

---

## 6. 风险与诚实边界

| 风险 / 边界 | 处置 |
|---|---|
| 单测 / shell 红要到全量那次才暴露（Lead 已接受） | 实现体本地跑聚焦测试是既有纪律；实现体也可以在交给 review 前自己跑 `ci-full ensure`。§1.4 已按每天多 5 / 10 / 16 次全量给出敏感度 |
| `run-name` 空值回落未经本仓验证 | 实施第一步验证，备选表达式已给（§2.2） |
| `gh pr checks` 的去重行为随 gh 版本变化 | G4 新规则自己按 `startedAt` 排序、按 run id 分组，不依赖 gh 去重 |
| 打 label 到 run 在 API 可见之间的窗口；进程崩溃；响应丢失 | 先写耐久回执再外发；有回执就绝不自动再 toggle；`withMkdirLock` 串行化（§2.3）。跨主机并发不覆盖——当前全部 runner 在一台主机上 |
| 账单受限时全量 run `startup_failure` | `ensure` 返回 1 并给 run 链接；恢复后 `gh run rerun <同一个 run>`；不自动循环请求 |
| 同一头上出现第二个独立全量 run（有人手动重复打 label） | `ensure` 自己绝不这么做；一旦发生，G3 会因旧的非 success `CI OK` 而 failed（今天的 G3 语义），`ensure` 报 `stale_non_success_ci_ok` 并给出 rerun 补救 |
| 全量绿之后 reopen PR 或打了别的 label | 新的 scoped run 让 G4 不绿（与今天同样严格）；`ensure` 报 `superseded_by_scoped_run`，补救 `gh run rerun <全量 run>` |
| 任何人都能打 `ci:full` | 它只会**增加** CI，不会减少任何门 |
| G2 在 scoped-only 头上空等 25 分钟 | 不改 G2（它是最后一道硬门）；follow-up 做快速失败 |
| 同树 ≠ 同提交：依赖提交元数据或 `GITHUB_EVENT_NAME` 的测试在复用时没重跑 | 仅影响 main push；quick-gate（含 `fly1645 --main-only`）每次都跑；接受并写明 |
| main 第一父链判断需要完整历史 | classify 已是 `fetch-depth: 0` |
| PR 改了 `ci.yml` 自己 | 与今天相同：PR 本来就能改自己的 CI；安全边界在 ship 门，不在 CI（FLY-1861 裁定） |

本设计**不做**：不引入自托管 runner；不碰 perf 计时测试；不改 required check 名；不改 G1/G2/G3；不给 QA `/decision` 路由加服务端 CI 守卫；不做 PR 头复用；不做路径→分片映射；不动 unit 矩阵与 shard 划分。

---

## 7. 被否方案

| 方案 | 否决理由 |
|---|---|
| 按包 / 按路径选 lane（单子字面） | 重放 −8%～21%（§1.3）；FLY-1987 research §8.4 早已指出跨层接缝测试不能按路径裁 |
| 用 `github.event.before` 做增量 diff | 依赖 push 序列；被 cancel 的头的改动在中间头上永远没测到；founder 在 FLY-1877 已否掉看历史的判定；收益也只有 13.5% |
| `vitest --changed` 只跑相关测试 | `StateStore.ts` 被几乎所有 teamlead 测试 import，一改就是全量；`fs` 读取的 `.md` / 脚本不在模块图里；新增一条要维护的 lane；留作 follow-up 候选 |
| 普通头 `CI OK` 也绿 + 新增第二个 required check | 三个硬门都得学会认新名字，漏改一处就是静默放宽；还要改分支保护 |
| workflow 级 `paths:` / `paths-ignore:` | required check 永远不上报，PR 卡死（FLY-1861 / FLY-1987 已否） |
| `workflow_dispatch` 触发全量 | 事件不同 ⇒ `gh pr checks` 盖不掉 `pull_request` run 留下的 skipped（§1.2 实测）；且测的是分支头而不是 merge ref |
| 在 Actions 里（`ship-on-comment`）自动打 label | `GITHUB_TOKEN` 产生的事件不触发 workflow |
| PR 评论做请求账本 | 多一个写点与噪音；run 列表 + `run-name` 标记已经是可审计账本 |
| W5：把 unit 矩阵拆成 7 个显式 job（YAML anchor） | 要重写 4 个 CI 结构守卫，风险大；而且解决不了旧 `CI Scope OK` cancelled 条目，G4 仍然得改 |
| 让 G4 认 `docs_only` 并放行 | 区分信号来自同一个可能出 bug 的 classify，不构成独立校验；保持今天的拒绝 |
| 证据只认「PR 头树 == main 树」，不用 artifact | 命中率 3/14，比「所测合并树」的 6/12 低一半；Lead 裁定用所测树为键 + 独立回验 |
| 由 Bridge 引擎在 QA 激活时触发 | 要在 Bridge 加 gh 外发、重试、幂等与失败语义；触发只关乎时机不关乎安全，CLI + 协议步骤 + 门前补请求已经闭环 |

---

## 8. Follow-ups（本单不做，合入后由 Lead 决定是否立单）

1. PR 头内容复用（同树的 rebase / 合并头）：需要 G4 独立回验证据。
2. `ship-await-ci.sh` 在「头上只有 scoped run 且无在跑 run」时快速失败为 `full_ci_missing`，不空等 25 分钟。
3. 纯文档 PR 过不了 G4（今天就是如此，靠 Lead 直接 `:cool:`）：是否让 G4 在本地独立重算 docs-only 后放行。
4. main push 被下一次合入顶掉（09-16：6/14，约 500 分钟）：`concurrency` 对 main 是否改为排队。
5. 中间头的「相关测试」lane（`vitest related`），如果 7 天数据显示全量首跑红率过高。

---

## 9. 假设

- A1 全部 runner 与 Lead 运行在同一台主机上，`$FLYWHEEL_STATE_DIR` 共享 ⇒ `withMkdirLock` 与回执目录足以串行化并去重 `ensure`。
- A2 本机 `gh` 登录对本仓有 label 写权限与 variables 读权限（runner 共用 founder 登录，既有事实）。
- A3 `pull_request` run 所测的树 = `git merge-tree --write-tree <当时的 main 尖端> <PR 头>`；§1.4 的 6 个命中就是用这条命令在本地重算并与 main 提交的树逐一比对得到的。不成立的后果只是复用不命中。
- A4 `git merge-tree --write-tree` 在 ubuntu-latest 可用（git ≥ 2.38）；不可用 ⇒ 不复用。
- A5 「每个 QA 会话请求一次全量」是 §1.4 的计价假设；实现体若也主动请求，次数会更多——7 天复核时用真实全量次数替换。
