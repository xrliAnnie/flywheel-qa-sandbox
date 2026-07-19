# FLY-1338 CI 分层 + 并行 — 探索

Issue: FLY-1338 (https://linear.app/geoforge3d/issue/FLY-1338/cycle-time-ci-分层-并行-单轮-ci-墙钟砍半)
日期: 2026-07-18
基于: 无(上游输入 = FLY-1327 cycle-time 报告,`engineering/doc/FLY-1327-cycle-time-breakdown/`)

## 1. 问题与目标

FLY-1327 报告实测:单轮 CI(Build & Test job)~17-19 分钟,每次 head 前移(review 修复、QA 返工、rebase)全量重跑一轮,是 review/QA 循环的固定税。报告建议原文:「CI 分层 + 并行,把单轮墙钟砍半 — 46 轮 CI;上界按 CI 主导墙钟的 50% 计算,节省 0–47m/单,成本 M,建」。Annie 2026-07-17 拍板「建」。

**目标**:同一 PR 的典型重跑墙钟 ≤ 现状的 50%(≈9.5 分钟以内),不牺牲任何覆盖(跑的测试集合逐条不变)。

## 2. 现状实测(run 29646776775,2026-07-18,success,总墙钟 18m06s)

Build & Test 单 job 串行,分解如下:

| 段 | 耗时 | 占比 |
|---|---|---|
| Setup(checkout/pnpm/node/install/sqlite3 prebuilt) | ~23s | 2% |
| Build(pnpm -r build) | 63s | 6% |
| Typecheck(pnpm -r typecheck) | 53s | 5% |
| Lint(biome check) | 11s | 1% |
| **Test(pnpm test:packages:run,vitest 全包)** | **12m46s** | **70%** |
| apt-get tmux/lsof/sqlite3 | 7s | 1% |
| ~25 个 shell 套件步骤(多数 hermetic;FLY-1062 real-install smoke 为 SLOW+NETWORK 真 registry install) | 2m46s | 15% |

Test 步内部按包分解(pnpm --filter 并发 4):

| 包 | vitest Duration | 测试文件数 |
|---|---|---|
| **teamlead** | **525.9s(8m46s)**,其中 collect/transform 217s | 615 |
| claude-runner | 74.3s | 26 |
| flywheel-comm | 67.1s | 76 |
| edge-worker | 66.9s | 93 |
| voice-bridge | 30.6s | 60 |
| config / voice-core / core | 13.2s / 11.2s / 8.8s | — |
| 其余全部 | 各 <5s | — |

**结构性结论**:
1. teamlead 单包 525s 是硬下限——只做「包间并行/重排」,墙钟不可能低于 ~9 分钟(勉强擦线砍半,没有余量,且 teamlead 还在持续长大)。**必须把 teamlead 内部切开**(vitest `--shard` 按文件切,天然支持)。
2. shell 套件步骤(2m46s,大头是 FLY-1062 real-install smoke 53s——该步为 SLOW+NETWORK 真 registry install,非 hermetic)与 vitest 完全独立,可整体平移进并行 job。
3. Build 只有 63s → 「缓存构建产物(turbo/nx)」不是杠杆,主要浪费在测试串行。
4. `types` 指向 `dist/` → build 是 typecheck 和跨包测试的硬前置,每个并行 job 都要自带 install+build(~1.6min 开销,可接受)。

## 3. 周边事实(影响方案边界)

- **:cool: ship 路径实际已弃用**:ship-on-comment.yml 近 200 次触发 196 次 skipped,近期 PR 全部由 Annie 直接 merge。它自带一套完整 CI 重跑(且 timeout 10min < 现 Test 12m46s,真触发也必超时)——但它是独立 workflow,不依赖 ci.yml 的 check 名。**本次不动它**(scope discipline;若未来复活另开 issue)。
- **check 名依赖**:生产 gate 无名字依赖——flywheel-comm 的 CI 前置探针(`ship-ci-guard.ts`)用 `gh pr checks` 按全部 check 聚合结论,不认名字。但 **`packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts` 解析真实 ci.yml 并硬读 `jobs["build-and-test"]`**,job 拆分后它会把 missing job 当 sparse checkout 静默绿跳,FLY-889 的 timeout/apt 合同悄悄失守 → 该测试必须随本次改动同步更新(Codex design review R1 抓出;我最初 grep 排除了 __tests__ 目录,claim 错误已修正)。另 GitHub branch protection 按名 required check:实测仓库为 Free 计划,branch protection 功能整体不可用(gh api 403),此风险不存在。
- **仓库 PRIVATE** → Actions 分钟计费。并行拆分不减总计算量,反而每 job 重复 setup+build,总分钟数会上升(估 +60~80%)。这是本设计唯一的真实代价,需 Lead/Annie 知情。
- concurrency cancel-in-progress 已有(同 ref 新 push 取消旧 run),排队税已治。
- payload-distribution job 已是并行独立 job(~1min),不动。

## 4. 方案

### 方案 A(推荐):纯 GitHub Actions job 拆分 + vitest --shard,零新依赖

把单 job 拆成并行 job 家族,全部各自 self-build(不搞 artifact 传递):

```mermaid
graph LR
    subgraph 并行启动于 t=0
        QG[quick-gate<br/>install+build+typecheck+lint<br/>~3.2min]
        T1[test-shard teamlead 1/3<br/>~5min]
        T2[test-shard teamlead 2/3<br/>~5min]
        T3[test-shard teamlead 3/3<br/>~5min]
        TH[test-shard heavy<br/>claude-runner+flywheel-comm+edge-worker<br/>~5.5min]
        TL[test-shard light<br/>其余全部包,负向 filter 兜新包<br/>~3.5min]
        SC[script-tests<br/>apt + 全部 shell 套件步骤<br/>+ test:cycle-time<br/>~5min]
        PD[payload-distribution<br/>不动 ~1min]
    end
    QG & T1 & T2 & T3 & TH & TL & SC & PD --> OK[ci-ok umbrella<br/>needs: 全部<br/>单一稳定 check 名]
```

- **快层早反馈**:quick-gate ~3.2min 内报出编译/类型/lint 错(最常见的快败类),红路径首个失败信号从 18min → ~3min。注意这是「早反馈」不是「快停」:纯并行设计下其他 job 照跑(取舍已在 brainstorm gate 裁定——省的是人等信号的时间,不是失败轮的计算量)。
- **teamlead 3 路 shard**:vitest `--shard=k/3` 按文件切,collect 也随之三分(217s → ~70s/片);新增测试文件自动均衡,无手工维护。每片约 175-200s。
- **light shard 用负向 filter**(`--filter './packages/*' --filter '!flywheel-teamlead' ...`):新包默认落进 light,**结构上保证不漏包**。
- **ci-ok umbrella**:needs 全部 job,任何失败即红。给人和工具一个稳定 check 名(branch protection 经实测不存在——Free 计划整体不可用,无迁移动作,见 §3)。
- 覆盖不变:跑的仍是同一批 vitest 文件 + 同一批 bash 套件,只是换了分布。验收时用「各 job 测试文件数/用例数之和 = 现状单 job 数」对账。

**预期墙钟:~5.5-6min(-65~70%),超额完成砍半**。代价:总计算分钟 +60~80%(私仓计费)。

### 方案 B:引入 turborepo 远端/actions 缓存

按 inputs-hash 缓存 build/test,未变更的包直接跳过。理论上重跑近乎零成本,但:① teamlead 几乎每个 PR 都变,首当其冲的 525s 缓存救不了;② 测试输入建模不全(bash 套件、fixture、scripts/ 交叉引用)→ 缓存假绿风险,和「不牺牲覆盖」直接冲突;③ 新工具链 + 远端缓存基建,成本 L 不是 M。**否**。

### 方案 C:按 diff 面选择性跑测试(pnpm --filter ...[origin/main])

最省分钟,但依赖 pnpm 图谱完整建模所有测试输入——本仓大量 bash 套件跨包驱动 dist、grep 哨兵扫全仓,图谱之外的边一多,漏测即静默。验收红线是「不牺牲覆盖」。**否(v1 不做;若未来分钟计费成为主矛盾可再评估,且必须配突变验证)**。

### 顺手小改(并入方案 A)

- Test 步现状里 teamlead 因 pnpm 并发槽位排队,晚 4 分钟才开跑——拆 shard 后此问题自然消失,无需单独治。
- 每个需要跑测试的 job 保留「Configure git for tests」+ better-sqlite3 prebuilt 步骤(现状证明必需)。

## 5. 风险与开口

| 风险 | 处理 |
|---|---|
| teamlead 测试文件是否有跨文件共享状态,shard 后互相踩 | 每个 shard 在独立 VM,进程/文件系统全隔离,比现状(同机并发 4 包)更干净;vitest.setup.ts 的 CommDB 隔离逐进程生效。实现阶段跑 3 片各自验证绿 + 用例数对账 |
| branch protection 按名 required check | 已闭合:实测 Free 计划下 branch protection 整体不可用(gh api 403),不存在按名 required check;ci-ok umbrella 仍保留作稳定聚合名 |
| FLY-889 守卫测试硬读 build-and-test job 名,拆分后静默绿跳 | 随改动同步更新该测试(第三个改动文件),断言迁移到新 job 集合 |
| 私仓 Actions 分钟 +60~80% | 提交 Lead/Annie 知情决策(见 §6);若不可接受,降级为「teamlead 2 片 + 合并 shard」牺牲 1-2min 墙钟换分钟 |
| 若干已知 flaky 测试(auto-qa-coordinator、claude-profile)拆分后照旧 flaky | 与本设计正交,不在 scope(已有 task 跟踪);shard 缩小重跑半径反而降低 flaky 重跑成本 |
| ship-on-comment.yml 的旧串行套件保持原样 | 刻意不动(实际弃用 + timeout 已坏);标注 known-out-of-scope |

## 6. 提交 Lead 的决策点

1. **方案 A 认可?**(纯 Actions 拆分 + vitest shard,不引 turbo/nx,不做 diff 选测)
2. **分钟计费取舍**:墙钟 -65~70% 换总计算分钟 +60~80%(私仓)。推荐接受——Annie 的核心矛盾是 cycle time,不是 Actions 账单;不接受则有降级档。
3. **check 名变更**:Build & Test → 多 check + ci-ok umbrella;branch protection 已实测不存在(Free 计划),无需任何配置迁移,PR 附 403 证据即可。

## 7. 验收口径(承接 issue 原文)

同一 PR 的典型重跑:before = 本文 §2 实测(18m06s;FLY-1327 样本 17-17.5min);after = 实现 PR 自身及其后续 head 前移的 ci-ok 完成墙钟。目标 ≤9.5min,预期 ~6min。覆盖对账:vitest 测试文件/用例总数与 bash 步骤清单前后一致。
