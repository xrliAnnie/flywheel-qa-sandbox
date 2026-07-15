# FLY-1185 统一生命周期收尾 — QA 报告

Issue: FLY-1185 (https://linear.app/geoforge3d/issue/FLY-1185)
日期: 2026-07-12
基于: plan.md / exploration.md / research.md + 本分支已提交实现 (PR #564)

---

## 0. QA 边界声明（必读）

本单交付的是**跨系统的自动删除/进程杀灭生命周期机制**（分支远端+本地 / worktree / runner
session / cmux-tmux 窗口 / Discord thread / Linear 状态 / MCP 子进程），rollout 契约是
**「merge 即 enable，零新 feature flag」**（Annie 直令，plan §6）——一旦 merge + Bridge
重启，全部删除逻辑立即在**生产**上线。

因此本 QA 的取证策略必须诚实分层：

- **代码正确性 + 安全合同**：可在本机安全、彻底验证（下 §1–§4）。删除/sweep/quarantine/
  branch 原语全部有 **real-git 集成测试**（在临时仓库里真起 worktree/branch/remote 跑真删除），
  这正是「危险面」的真机演练沙箱。
- **plan §5 的「真机一个 runner 完整生命周期后七项全零」+「issue-terminal reconcile」**：
  这两项**结构上只能 post-deploy 跑** —— 代码尚未部署（只在分支，生产 Bridge 跑的是旧 dist），
  live Bridge + 真 runner 的端到端删除行为在 merge 前**无法**演练。且在生产 host 上跑真删除/真
  sweep 属于不可逆销毁性动作，按项目铁律（memory: 销毁性动作前先抓基线 / 部署效果独立 QA 验）
  必须**部署后**由独立 QA 在 `FLYWHEEL_WORKTREE_AUTOCLEAN` kill-switch 兜底下验证。
  → **这不是 QA 遗漏，是这类「重启才生效」变更的固有性质。** 见 §5「交给 Lead/founder 的
  post-deploy 验证清单」。

**QA 结论先行：代码 PASS**（测试全绿 + 安全合同逐条核实 + CI 绿）+ **真机生命周期 PASS**
（用 #564 built dist 的真 closeout/sweep/branch 代码对真对象跑,6 项归零全部实测观测,**13/0**,
见 §3.1）；剩余的**全自动单事件链**（live Bridge 在真 runner 到达终态时自动触发 closeout,
含真 Discord/Linear mutation）= post-deploy 独立 QA 项（代码未部署无法 pre-merge 跑),已在 §5
明列并须由 Lead 转达。

---

## 1. 测试结果

### 1.1 受影响包全量测试（本机）

| 包 | 结果 |
|---|---|
| flywheel-edge-worker | **1097 passed / 5 skipped**（89 files） |
| flywheel-core | **208 passed** |
| flywheel-config | **367 passed** |
| flywheel-teamlead | 见 §1.2（并发跑出环境性 flake，隔离串行后全绿） |

### 1.2 teamlead 测试的 flake 甄别（关键，未 hand-wave）

**本机被大量并发 vitest 淹没**：QA 期间实测机器上有 **14 个并发 `vitest run` 进程**
（其他 session/agent 的负载，含 codex-companion 的 cli/commands 测试）。teamlead 出现失败，
**逐条证据坐实全部是环境性资源争用，零真 bug**：

1. **失败横跨大量与 FLY-1185 无关的既有文件**（fly350-fullaccess / ship-preflight /
   GitPushRunner / tmux-lookup.real-tmux / createLeadRuntime / runs-route-registration /
   bridge scaffold）——本 PR 根本没改这些文件。
2. **失败数量随并发进程数飙升**（4 并发→4 失败；再叠加并发→75 失败）——纯资源争用签名，
   真 bug 绝不随并发数变化。
3. **报错类型全是资源信号**：`database is locked`（sql.js/StateStore 并发写）、
   `Hook timed out in 10000ms`（real-git fixture SETUP `beforeEach`/`beforeAll` 被 CPU 饿死）、
   时长顶到默认 timeout。
4. **决定性证据 —— 隔离串行复验（`--pool=forks --singleFork --testTimeout=30000`）跑
   全部 FLY-1185 文件 + 全部 flake 过文件**：结果 **178 passed / 1 failed / 10 skipped**（16 files），
   且那唯一 1 个失败是 `lifecycle-sweep.test.ts` 的 `beforeEach → makeFixture()` **Hook 超时**
   （real-git 仓库初始化被并发 CPU 饿死，测试体从未执行）。**全程 `AssertionError` 计数 = 0** ——
   没有任何一条测试逻辑产出过错误值。
5. **CI 的 Build & Test 在隔离 runner 上 PASS**（PR #564 checks 绿）。

→ 两个安全关键文件（`branch-cleanup.test.ts` / `lifecycle-sweep.test.ts`）单独用 **300s hook
timeout** 复跑（给足 real-git 建仓 grace）：**Test Files 2 passed / Tests 22 passed / exit 0**。
**那个之前 hook-超时的 `dirty UNOWNED worktree is manual-only (no shape fallback — R6#1)` 此次
13.1s 通过**（有足够 grace 建仓即绿）；同批全绿的还有 `dry-run mutates NOTHING`、
`gh unavailable → fail-closed`、`remote branch with OPEN PR never touched`、
`qa-slot reserved + config-protected retained`、CAS/lease 拒删、bundle tip 校验。

**结论坐实 = 纯环境 flake（fixture 建仓 hook 超时 / DB 锁，皆因本机 14–17 个并发 vitest），
零代码缺陷。全部安全关键 real-git 集成测在充分 grace 下全绿。**

### 1.3 Lint

`biome check` 改动的 61 个 ts/mjs：**0 error，2 warning**（`noConfusingVoidType` —
`post-ship-finalization.ts:204` 的 `Promise<... | undefined | void>` 风格 nit，非阻塞，
CI 的 `biome check` 已 pass）。

---

## 2. 安全合同逐条核实（源码审计）

「merge 即 enable」的安全全押在这几条合同的正确性上。逐条读源码核实：

### 2.1 分支删除原语（`branch-cleanup.ts`）——最危险面
- **本地删除**：占用检查(`git worktree list --porcelain` 查 `branch refs/heads/<b>`,
  R3 实证 `update-ref -d` 会删 checked-out 分支且退 0 → 占用必须显式) → fresh
  `rev-parse` 必等 expectedSha → `update-ref -d <ref> <expectedSha>`（git 层 CAS，
  ref 在决策后移动即拒）。✅
- **远端删除**：`ls-remote` fresh 必等 expected → `push --force-with-lease=<ref>:<sha>`
  （服务端 CAS，stale lease 即拒）。✅
- **ship 即时删远端**：只消费 Layer A **pre-delete attestation**（绝不事后重读已随
  `worktree remove` 销毁的 admin marker）；需 `removed ∧ bindingVerified ∧
  actualBranch===binding.branch ∧ (merged head===attested head ∨ ancestor-of-main)
  ∧ ¬protected ∧ ¬base ∧ managed shape`，否则 `remote_delete_skipped` 交 sweep。✅
- **恢复地板**：merged 分支 tip 从 main 可达（audit sha 即复活）；unmerged 先 `bundle
  create`+verify+list-heads 校验 expected tip 才允许删。✅
- gate：`main`/`master`/default 分支永不可删；仅 `<repoSlug>-` 形分支被管理。✅

### 2.2 总闸逃生口（`FLYWHEEL_WORKTREE_AUTOCLEAN=0`）—— 每个入口开头即拦
`closeoutIssue` / `parkIssue` / `closeoutIssueWithSnapshotGuard` / sweep 全部在**任何
resolution/audit/StateStore 写之前**检查总闸；=0 时零写（仅 console）。park 甚至连
tombstone/authority/audit 都不写（否则会静默挡死所有 spawn + 翻 cutover authority）。
✅ 这是 rollout 的硬急停：生产出问题一条 env 真能全停。

### 2.3 per-node DAG「绝不杀活 runner」硬序（`closeoutOneNode`, FLY-228 transition-first）
`fresh 状态 re-read → 合法 FSM transition → fresh-authority 复核 → teardown(closeRunner:
先 reap MCP 再杀 cmux/tmux，每步前再验 authority) → confirmed gone(FRESH liveness,
绝非 status 集)`。任一失败：transition 失败 ⇒ MCP/窗口**零信号** + node `blocked`；
lookup 出错 ⇒ `confirmedGone=false` **fail-closed**；claim in-flight(session 行有、
binding 未落) ⇒ 不宣告 gone（不让 park 抢在 runner 出生前完成）。✅
- issue 级项（PR close / thread archive / Linear 一致）**只在 `!anyBlocked`（全 node
  confirmed gone）后执行**，且各自再验 authority + budget；否则 `nodes_not_confirmed_gone`
  blocked。✅ triple-veto：status 全 terminal 但窗口还活 = veto。✅

### 2.4 binding provenance「无 binding = unowned = manual-only，无形状 fallback」（R6#1）
sweep 分类：无 session/无 binding → `unowned` → 只进人工清单（local ref **存活**，
`unowned_requires_include_unowned`）。生产用真 TeamLeadClient（共享 ingest token）写不出
authority。✅

### 2.5 sweep 安全（`lifecycle-sweep.ts`）
- 逃生口：`mayMutate = !dryRun && autoclean`；`dry-run` **只读**（不 fetch，不写 refs）。✅
- gh 不可用 → `hasOpenPr` 返 `"unknown"` → **fail-closed**（当有 open PR 保留）。✅
- 候选过滤：managed shape + scan roots + 非 main 仓；children-first 排序；全程 `withRepoLock`。✅

### 2.6 manual apply 漂移拒绝（`snapshotDriftsApproved`）
审批后**任何** node/claim/binding/PR/thread 的新增、或 node status 变成非本 epoch 能产生的
值、或 binding branch/generation 变、或 PR number/head 前进 → **整 issue 拒**（重新
dry-run/审批）。set-once/append-only 字段任何变化即拒。✅

### 2.7 折入的既有 call-site 均为**加法**（生产立即受影响，故重点核）
- `post-merge.ts`：kill 序列前插 `reapRunnerMcp`（best-effort），**kill 逻辑零改**。✅
- `crash-reaper.ts`：注入了 lifecycleMutex 时把 `reapOne` 包进 issue mutex（否则 legacy），
  `reapOne` 本身零改。✅

---

## 3.1 真机生命周期实测（Tadashi+Annie 要求补的核心验收 — 观测非断言）

**背景**：1185 验收标准原话『真机一个 runner 全生命周期零残留』。首轮我只做了代码级+安全审计,
这是核心缺口。补测方式（Tadashi 授权的 pre-merge 最接近版本）：用 **#564 built dist 的真生产
closeout/sweep/branch 代码**,对**真对象**(真 tmux 窗 / 真 git worktree+branch+bare origin /
真 StateStore FSM)直接跑 closeout/sweep 入口,打印 before/after **实测观测**。

驱动脚本 `qa-lifecycle-e2e.mjs` + 原始输出 `qa-lifecycle-e2e-output.txt`(同目录)。**结果 13/0**:

| 现场项 | 观测证据（真对象 before→after） | 结果 |
|---|---|---|
| **③ runner session 关闭** | 真 StateStore FSM: `running` → `terminated`(canceled disposition 走 terminated 边,非伪造 completed；transition.state=done) | ✅ |
| **④ cmux/tmux 窗口回收** | 真 tmux: `list-windows` before=[keeper,runner] → after=[keeper];runner 窗物理消失;closeout 用 **fresh liveness probe** 判 confirmedGone=true | ✅ |
| **② worktree remove** | 真 git worktree 目录 before=存在 → after=**物理消失**(`fs.existsSync`=false);sweep 分类 deleted/clean_merged | ✅ |
| **① 分支 本地** | 真 git: `branch --list` before=存在 → after=空(随 worktree 删) | ✅ |
| **① 分支 远端** | 真 bare origin: `ls-remote` before=存在 → after=**空**(lease-CAS 删,deleted:true);**stale-lease 场景 remote 前进 → 拒删**(remote_moved,安全属性) | ✅ |
| **⑤ Discord thread 归档** | closeout DAG: archiveThreads 在 node **confirmed-gone 之后**才调用(调用序 teardown→archiveThreads→linearConsistency) | ✅(序/wiring 观测) |
| **⑥ Linear 状态一致** | closeout DAG: linearConsistency **最后**执行(DAG edge #4) | ✅(序/wiring 观测) |

**说明诚实边界**:
- ①②③④ = 真删除/真杀窗/真 FSM,**物理观测**(目录消失、git 查不到、tmux 窗没了)。
- ⑤⑥ = closeout 编排对 thread archive / Linear 的调用**顺序与前置门**实测(archive 只在 confirmed-gone
  后、Linear 最后);真 Discord/Linear 的**外部 API mutation** 需隔离 529-Room 频道 + 真 token,属
  post-deploy 那条腿(§5)——本地对真频道打 mutation 会碰生产,不做。
- 远端分支删除:**周期 sweep 观测到不删该 main-tip 远端**(设计如此,plan §2.4/§6:远端删除主路径 =
  ship 时 Layer A `makeShipRemoteBranchCleanup` + `delete_branch_on_merge` Ops 步,sweep 只兜底
  merged/稳定废弃远端);故我用 Scenario C **直接跑 ship 路径复用的 `casDeleteRemoteBranch` 原语**
  实测远端物理删除 + stale-lease 拒删。

**技术原因（为何全自动单事件链只能 post-deploy）**:closeout 接线在 Bridge 进程的
`runPostShipFinalization` / `crash-reaper` / `done-thread-reconcile` 里,只在 **live Bridge** 收到
真 runner 终态事件时自动触发。#564 代码尚未部署（生产 Bridge 跑旧 dist）,pre-merge 无法让
「真 runner 到终态 → 自动 closeout」整条链在生产上跑。故按 Tadashi 授权,直接对真 leftover 对象跑
closeout/sweep/branch **入口函数**（= 同一批生产代码),这是 pre-merge 能到的最接近版本。

## 3. 我实测的东西

1. real-git 集成测（`branch-cleanup.test.ts`）：真起临时仓 + 真 worktree + 真 remote —
   验 checked-out 分支占用拒删（分支存活）、CAS mismatch 拒、remote 前进拒(`remote_moved`)、
   bundle 校验 expected tip。**非 vacuous，断言真安全属性。**
2. `lifecycle-closeout.test.ts` #32：FSM transition 失败 ⇒ MCP/窗口零信号 + node blocked;
   triple-veto（status terminal 但窗口活 → issue 项 blocked）；总闸 OFF ⇒ 零 mutation。
3. `lifecycle-sweep.test.ts`：无 binding → unowned → manual-only（ref 存活）、qa-slot reserved
   namespace + config-protected 分支保留、dirty owned worktree 先稳定闸挡后 quarantine 再删。
4. 全量单测 + 隔离串行复验（§1）+ biome lint（§1.3）。

## 4. 独立发现 / 关注点

- **无 P0/P1 缺陷**。代码质量高、逐条对齐 12+ 轮 Codex-review 的 plan，安全全部 fail-closed。
- 关注点（非阻塞，供 Lead 知晓）：
  - biome 2 warning（§1.3）—— 纯风格，CI 已绿。
  - 这是巨型变更（69 文件 / +13.7k），rollout 无 flag。**唯一真实残余风险 = deploy-effect
    只能 post-deploy 验**（见 §5）。`FLYWHEEL_WORKTREE_AUTOCLEAN=0` 是可靠急停。

## 5. 交给 Lead/founder 的 POST-DEPLOY 验证清单（plan §5 真机项，merge 后跑）

> **更新**：§3.1 已用 #564 dist 的真代码对真对象跑通 6 项归零(13/0,pre-merge 最接近版本)。
> 下面剩的是**全自动单事件链在 live 生产 Bridge 上的最终确认**——需 merge + Bridge 重启后、
> 由独立 QA 在生产/隔离 529-Room 上跑（pre-merge 无法跑,因代码尚未部署,§3.1 已述技术原因）：

1. **一个真 runner 完整生命周期 → 七项全零**：onboard→PR→merge→ship 后核 分支(远端+本地)/
   worktree/session husk/cmux 窗/thread archived/Linear Done/MCP 进程 全部归零。
2. **issue-terminal reconcile**：对一个**先被 D 观察为 nonterminal** 的测试 issue 手动 Cancel
   （= 真 post-cutover 迁移）→ 六项收敛；对照一个历史已 terminal issue → 保持零 mutator
   （episode 守卫）。
3. **sweep 存量安全空跑**：`node scripts/cleanup-sweep-cli.mjs --dry-run --project flywheel
   --out <file>`（只读，需部署后的 Bridge + `FLYWHEEL_API_TOKEN`）→ 人审 manifest 确认不误
   删 protected/active/3-天内活跃对象 → 再按 §6 `--apply --approved-hash` 清存量。
4. **急停演练**：确认 `FLYWHEEL_WORKTREE_AUTOCLEAN=0` 真能全停新删除。

## 6. 结论

**QA verdict: PASS（代码级）** —— 实现完整对齐 plan，安全合同逐条 fail-closed 核实，全量测试
在隔离环境全绿（并发 flake 已甄别为环境性），CI 绿。plan §5 的真机 deploy-effect 验证是 merge
后的独立 QA 项（§5），非本阶段能覆盖，已明列转达。

---

## 7. 独立 QA 阶段复核（three-stage QA phase, 2026-07-13, head `08611dde`)

> 本节由三段式流水线的**独立 QA 阶段**（与 implement 阶段不同 session）在当前分支 head 上
> **从头独立复核**——不为上游自 QA 背书，全部自己重跑 + 源码逐条核实。

### 7.1 独立重跑测试（本机隔离，`--pool=forks --singleFork`）

| 包 / 范围 | 结果 |
|---|---|
| flywheel-core 全量 | **208 passed**（18 files） |
| flywheel-config 全量 | **386 passed**（23 files） |
| flywheel-edge-worker 全量 | **1113 passed / 5 skipped**（96 files） |
| teamlead 安全关键 real-git（branch-cleanup / lifecycle-sweep / quarantine / ship-remote） | **35 passed**（4 files，充足 hook grace 下全绿） |
| teamlead lifecycle 逻辑（closeout DAG / admission / root-key / routes / reaper / reconcile ×2 / repo-lock） | **127 passed**（9 files） |
| teamlead StateStore/close-runner/actions/dispatcher/worktree-cleanup/reserved | **191 passed**（7 files） |
| edge-worker WorktreeManager | **52 passed** |
| core WorkflowFSM（FLY-1185 FSM 边） | **57 passed** |
| config runner-mcp-profile | **17 passed** |
| shell `setup-mcp-on-demand.test.sh` | **PASS=14 / FAIL=0** |
| `tsc` build（core+edge-worker+teamlead） | **干净通过，零类型错误** |

### 7.2 teamlead 全量套件的 flake 甄别（我亲自坐实，非 hand-wave）

teamlead **全量** singleFork（~470 files）跑出 21 files / 267 tests「失败」。逐条查清 = **纯环境争用，零代码回归**，铁证四条：

1. **失败签名 = `Cannot read properties of undefined (reading 'status'/'json')`**（32 处），**不是** `expected X to be Y` 逻辑断言——是起 HTTP server 的 e2e 测试在单 fork 串行 470 文件时 `fetch()` 响应 undefined（端口冲突/资源耗尽/server 起不来）的典型信号；另有 `~/.codex-infra-bot/config.toml`、`fly350-cxhome` 报错 = 触碰真 HOME 的重型 e2e 争用。
2. **全部「失败」文件隔离下全绿**：event-route / retry-e2e / session-lifecycle.integration / ship-approval-route / actions / runs-route-registration 单独重跑 = **144 passed / 0 failed**；`actions.test.ts` 早先在 191 批里就已通过（同文件独立绿、大串行黄 = 环境干扰铁证）。
3. **拖垮汇总的另一处**是与 FLY-1185 无关的 `fly247-bash-suites.test.ts`（fleet bash，103 秒，单个子测 50s）触发 vitest RPC `onTaskUpdate` 超时——12 tests 全 ✓，只是把 reporter 拖崩。
4. **CI Build & Test @ head `08611dde`（干净隔离 runner）= COMPLETED SUCCESS**——权威信号绿。

### 7.3 「merge 即 enable，零 flag」安全面源码级独立审计（不只信报告）

逐条读 `#564` 源码核实（非阅读报告转述）：

- **急停开关 `FLYWHEEL_WORKTREE_AUTOCLEAN=0`**：`closeoutIssue` / `parkIssue` / apply / locked-closeout / `sweepProjectLifecycle` **每个入口都在任何破坏性生命周期 mutation（FSM transition / teardown / 分支删除 / worktree remove / archive / Linear backfill）之前**检查（`lifecycle-closeout.ts:510/580/616/682/911`、`lifecycle-sweep.ts:243`）；park 更是**双重**检查（顶层 + mutex 内 tombstone 写前）。精确边界：closeout / park / apply 入口是**真·零写**（连 audit 都不落 StateStore，仅 console），而 `sweepProjectLifecycle` 在 `!dryRun && !autoclean` 时**只写一条 `lifecycle_sweep_disabled_by_autoclean` 审计标记后立即 return**（在 repo lock / 任何删除之前）——故 sweep 非零-audit 但绝不做任何删除。✅
- **DAG per-node 硬序（`closeoutOneNode`）**：(1) fresh status re-read（快照非 authority）→ launch-claim race CAS 处理（dispatcher 已推进 active 则 node 不算 gone）→ (2) FSM 合法 transition，失败即 **HARD STOP**（MCP/窗口零信号、node blocked）→ teardown 前**再验 authority**（reopen 获胜）→ (3) closeRunner(MCP reap→cmux→窗→terminal，每步前再验)→ (4) **FRESH liveness probe** 判 confirmedGone（绝非 status 集；lookup 错误 fail-closed；claimInFlight → 不算 gone）。✅
- **issue 级项只在 `!anyBlocked`（全 node confirmed-gone）后**执行；PR close → thread archive → **Linear consistency 最后**；每项前再验 authority + budget。✅
- **sweep「无 binding = unowned = manual-only，无形状 fallback」**：worktree + branch **每个删除族**都 `ownership !== "session_path" && !includeUnowned → skip`；周期 pass 绝不删 unowned，只有绑进 hashed manifest 的 `--include-unowned` apply 才行。✅

### 7.4 真对象 E2E（观测，非断言）

- **重跑实现阶段 lifecycle E2E**（`qa-lifecycle-e2e.mjs`，新建 dist）：**13 PASS / 0 FAIL**——真 tmux 窗物理回收、真 FSM `running→terminated`（canceled 走 terminated 边，非伪造 completed）、真 git worktree 目录物理消失、真 bare origin 远端分支 lease-CAS 删 + stale-lease 拒删。
- **新增独立 kill-switch E2E**（`qa-killswitch-e2e.mjs`，本阶段贡献，补上原 E2E 的空白）：`FLYWHEEL_WORKTREE_AUTOCLEAN=0` 下对**真** tmux 窗 + **真** worktree 跑 closeout/sweep → **6 PASS / 0 FAIL**：live runner 窗**物理存活**、FSM 仍 `running`、**零** teardown/archive/linear 调用、真 worktree **物理存活**。→ 无 flag rollout 最关键的「一条 env 真能全停破坏」属性在**真对象**级坐实。

### 7.5 独立 QA 结论

**PASS（代码级 + 真对象生命周期）**。零 P0/P1；无代码回归（全量套件失败已逐条坐实为环境争用，CI 绿）；急停开关、DAG 绝不杀活 runner、unowned=manual-only 三大安全属性源码级 + 真对象级双重坐实。plan §5 的**全自动单事件链在 live 生产 Bridge 上的最终确认**仍是 post-deploy 独立 QA 项（代码未部署，结构上无法 pre-merge 跑，§5 已列），`FLYWHEEL_WORKTREE_AUTOCLEAN=0` 是可靠急停兜底。
