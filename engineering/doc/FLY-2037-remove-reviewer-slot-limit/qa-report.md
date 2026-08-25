# FLY-2037 去掉 reviewer 全局 slot 上限 — 独立 QA 报告
Issue: FLY-2037 (https://linear.app/geoforge3d/issue/FLY-2037/bridgereview-去掉全局-reviewer-slot-上限founder-直令废-reviewrequestcoordinator)
日期: 2026-08-24
基于: plan.md

## 0. 结论

**PASS**。

被验版本:分支 `flywheel-FLY-2037`,代码 head `1021d368afdb7eadbb490569792fc98e5b45b0b9`
(= PR #944 head,非 draft,MERGEABLE)。QA 期间 worktree 因 progress ledger 多出一个
**仅含 progress.md/qa-report.md 的文档 commit**;`git diff 1021d368a..HEAD -- packages/`
为空,即**被验的产品代码逐字节未变**。

## 1. 改动面(只读核对)

```
packages/teamlead/src/bridge/review-request-coordinator.ts  | 45 +------
packages/teamlead/src/bridge/plugin.ts                      | 10 +-  (纯注释)
packages/teamlead/src/bridge/__tests__/…coordinator.test.ts | 168 +++-
engineering/doc/FLY-2037-…/{exploration,research,plan,progress}.md
```

- `plugin.ts` 的 diff **只有注释行**(去掉 `^[+-]` 的注释/空白后为空集),零可执行行改动。
- coordinator 净删除:`maxConcurrent` 参数/字段/默认值 `?? 2`、`active`、`waiters`、
  `acquireSlot()`、`releaseSlot()`、`stop()` 里的 waiter drain、`enqueue()` 的 slot 等待与
  `finally { releaseSlot() }`。保留 per-execution `execChains` 串行与异常 fail-close。
- grep-zero 复核:`maxConcurrent` / `acquireSlot` / `releaseSlot` / `waiters` / `global concurrency`
  在 coordinator 生产文件与测试文件中命中数为 **0**;全仓 `maxConcurrent` 剩余命中全部属于
  `packages/core/src/Semaphore.ts` 与 edge-worker `DagDispatcher` 的**另一套派工并发**,与 review lane 无关、本单不在范围。
- 未新增 env / config / flag / 依赖 / helper——符合「直接去掉,不做可配置旋钮」的 founder 原话。

## 2. 真机验证(真进程,非 mock)

自建 harness:**真编译产物**(`packages/teamlead/dist`)+ 真 file-backed SQLite `StateStore` +
真 `CommDB`(`flywheel-comm/dist`,真 review gate question 行)+ 真 git worktree(真 rev-parse)+
真 reviewer **OS 子进程**(走生产 `spawn()` 路径与 `washReviewEnv`)。并发用各 reviewer 进程
自己写下的 `[START,END]` 墙钟窗口做区间重叠统计,不是靠代码内计数器。

### 2.1 前后对照(同一 harness、同样 6 个 job、同样 3s reviewer)

| 版本 | reviewer 进程峰值并发 | 墙钟 | gate 应答 |
|---|---|---|---|
| 改前 `88c3df6b9`(main) | **2** | 10,464 ms | 6/6 APPROVED |
| 改后 `1021d368a`(本分支) | **6** | 4,100 ms | 6/6 APPROVED |

这是 founder 原问题「为什么全局只会有两个 reviewer slot」的直接答案:闸没了。
对照组同时证明 harness 的尺子是准的(它能量出旧的 2)。

### 2.2 语义与既有流程未变

| 场景 | 结果 |
|---|---|
| A 同一 execution 3 个 request | 峰值并发 **1**,7.36s ≈ 3×2s,3/3 gate 应答 —— 串行保住 |
| B boot redrive 6 个不同 execution | `redriveOnBoot → 6`,峰值 **6**,3.79s,6/6 gate 应答 |
| C fail-close(reviewer 真 exit 1,4 个 execution) | 4/4 `failed`,**0** gate 被应答,4 条 Lead 告警"gate stays closed" |
| D 同 requestId 重试(C 之后用正常 reviewer 重投 req-0) | `accepted, duplicate:true` → `done` → 真 gate 应答 APPROVED,其余 3 个 job 未被触碰,0 告警 |
| E 最坏 boot fan-out,20 个不同 execution | `redriveOnBoot → 20`,峰值 **20**,4.08s,20/20 gate 应答 |

E 是**如实披露的运营含义**,不是缺陷:按 founder 直令这条链现在没有上限,一次 Bridge 重启
若有 N 个可 redrive 的跨 execution job,就会同时起 N 个真 Claude reviewer 子进程。issue 已明确
容量类背压留给 FLY-2007,本单不造新机制;失败仍 fail-closed 且可同 requestId 重试(D 已实测)。

## 3. 测试自身的可信度(突变检验)

不只看"绿",还量了"能不能变红"。每次都在 worktree 内瞬时改、跑完立刻 `git checkout` 还原,
最终 `git diff --exit-code` 干净。

| 突变 | 预期 | 实际 |
|---|---|---|
| M1 还原 main 的整段 semaphore | 两条吞吐测试红 | ✅ 恰 2 条红,断言收到 `2`;其余 75 条仍绿 |
| M2 把 cap 从 2 调到 10 | —— | ⚠️ **全绿 77/77**(见 §5 诚实边界) |
| M3 删掉 `enqueue()` 的 `if (this.stopped) return;` | HIGH-3 shutdown 测试红 | ✅ 恰 1 条红(`expected 2 to be 1`) |
| M4 把 per-execution chain 改成 `Promise.resolve()` | 串行相关测试红 | ✅ 3 条红(同-exec 串行 / redrive 混合 / HIGH-3) |

M1 证明新测试不是空过绿;M3/M4 证明被**改写过**的 HIGH-3 shutdown 测试和串行 characterization
测试仍然是有牙的检查,不是为了适配新实现而被削平的。

## 4. 门禁

| 门 | 结果 |
|---|---|
| coordinator focused suite | **77/77 绿**(分支 head) |
| `pnpm lint` | **0 error**,8 条既有 warning,**改动文件 0 条** |
| `pnpm -r build` | 22 workspace **全绿** |
| TeamLead 全包 | **9,497 pass / 4 skip / 23 fail(10 文件)** —— 全部逐文件复核为宿主项,见 §4.1 |
| 其余 15 个 package | dag-resolver 33、edge-worker 1,292、gemini-agent 172、github 73、linear 18、qa-framework 83、slack 56、token-usage 166、voice-bridge 673、voice-core 321、voice-headphone 54、core 221 **全绿**;config 1 fail、claude-runner 8 fail、flywheel-comm 2 fail —— 隔离复跑**全部转绿** |

### 4.1 非绿项的归因(不伪报全绿)

第一次 TeamLead 全包是 80 fail / 27 文件。根因先定死在**宿主环境**而不是猜:
本 runner 的 `TMPDIR` 长 89 字符,派生的 unix socket 路径达 137 字符 > `sun_path` 上限 104,
于是一整类 `listen EINVAL` 假失败。换短 `TMPDIR=/tmp/f2037tmp` 后同一套降到 **23 fail / 10 文件**。

对这 10 个文件逐个隔离复跑:**8 个全绿**(bridge 29/29、claude-profile-cli 3/3、
createLeadRuntime-preflight 4/4、workflow-docs-git 4/4、workflow-resume-checkpoint 6/6、
actions-retry-route 27/27、terminal-thread-archive 22/22、worktree-quarantine 5/5)——
即固定 5s 预算在并发负载下的抖动。

剩下 2 个隔离仍红:`fly1674-opus46-real-tmux`(真 tmux socket `ENOENT`)、
`fly247-bash-suites`(真 fleet bash harness)。这两个**不靠推断**:我把两个被改的生产文件
`git checkout` 回 main 版本,在**同一台机器同一时刻**重跑,它们**以同样方式同样失败**
(1 fail / 4 fail)。控制变量只有本 diff,结论是这两条红与 FLY-2037 无关,是宿主基线。

另一条独立的结构性证据:29 个失败文件中,引用 `ReviewRequestCoordinator` /
`review-request-coordinator` / `maxConcurrent` 的文件数为 **0**,且 `plugin.ts` 的 diff 是纯注释。

最终无沙箱结论仍以 PR exact-head CI 为准。

## 5. 诚实边界(honest boundary)

1. **测试只能证明 cap ≥ 10,证明"没有上限"的是代码结构不是测试。**
   M2 实测:把 `?? 2` 改成 `?? 10`,新增的 10-execution 吞吐测试**照样全绿**。
   plan §3.1 写「10 个同时开始也能抓住『只把 cap 调大』的伪修复」——这句只在 cap<10 时成立。
   本次判 PASS 依据的是 **grep-zero + 全 diff 逐行阅读**(semaphore 整段被删,构造器不再接受该参数)
   加上 N=20 实测峰值 20,而不是那条测试。风险:将来若有人重新引入一个 >10 的 cap,
   现有测试不会变红。补法(未做,不阻塞本单):加一条按注入的 execution 数 N 参数化、
   断言 peak === N 的测试。
2. **未跑 529 房真 Discord N-to-N。** 判定依据:本 diff 没有任何 Discord 面 ——
   `plugin.ts` 是纯注释;coordinator 里挨着 Discord 的两个口子
   (`postReviewRulingThread` 发 ruling thread、`alertLead` 发 Lead 告警)**一行未改**;
   改的只是 review job 的**调度时序**,每个 job 自己的 Discord 效果逐字节不变(§2.2 C 已实测告警照发)。
   替代证据是 §2 的真进程 harness(真 spawn / 真 SQLite / 真 CommDB gate 应答 / 真前后对照)。
   这留下的未测部分:没有一次真的多 Lead × 多 Runner 同时撞 review 门的 Discord 现场。
3. **reviewer 是真进程但不是真 Claude。** harness 的 reviewer 是一个真 shell 子进程
   (走真 `spawn()`、真 env wash、真 stdout verdict 解析),但不是真模型。
   因此本次证明的是**调度与生命周期**,不是 reviewer 的评审质量/模型行为 ——
   后者本 diff 一行未改。
4. **未跑生产、未部署、未重启、未 merge。** 本节点只交 verdict。
