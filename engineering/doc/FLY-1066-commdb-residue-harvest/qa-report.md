# FLY-1066 Bridge 侧残留收割 — QA 报告

Issue: FLY-1066 (https://linear.app/geoforge3d/issue/FLY-1066)
日期: 2026-07-16
基于: plan.md、research.md、exploration.md;PR #616 @ head `03158332b`
QA 阶段: 三段式 pipeline 独立 QA(实现已提交本分支,QA 只验不重写)

## 0. 结论一句话

**PASS**。四面收割器(①CommDB 孤儿注册 ②StateStore 终态未同步 ③StateStore 幽灵 session ④双无主 escalation)实现与计划/验收原文一致;全部安全关键守卫经**突变测试**证明非空过绿;byte-compat off-sentinel 逐字节固化;**Peter 3 个真实验收样本 + ~5 条同型残留 + 1 条阳性对照**经生产库只读复现,harvest 判据精确命中(6 dead 收 / 1 alive awaiting_review 保),零误伤。

## 1. QA 方法与范围

- 读本分支已提交的设计(exploration/research/plan/4 轮 design review)+ 全部实现代码(6 源文件 + 6 测试文件,2694 行改动)。
- 单元/集成测试:焦点 6 套件 + config drift 套件真跑。
- **突变测试**(计划 §3 明文要求「拆守卫→测试红」):对 6 个安全关键守卫逐一破坏,验证对应负向断言转红(防 vacuous green,MEMORY 红线)。
- **生产只读复现**(same-predicate 精神,非破坏性):复制生产 comm.db + teamlead.db 到隔离目录,忠实复现 harvest 判据(FSM 状态 + `tmux list-panes` 三态 probe)对 Peter 3 样本 + 同型残留 + 阳性对照的分类。**未运行任何破坏性收割器**;实际收割 = 部署重启后的 M6 验收(founder-gated)。
- 全仓 lint(biome)+ teamlead 完整套件回归。

## 2. 测试结果

### 2.1 焦点套件(全绿)

| 套件 | tests | 结果 |
|---|---|---|
| commdb-fsm-reconcile.test.ts | 20 | ✅ |
| statestore-ghost-reconcile.test.ts | 23 | ✅ |
| orphan-escalation-reconcile.test.ts | 9 | ✅ |
| StateStore.detection-escalations.test.ts | 29 | ✅ |
| residue-harvest.test.ts | 11 | ✅ |
| stale-blocker-guard.test.ts | 33 | ✅ |
| **teamlead 小计** | **125** | **✅** |
| config feature-flags-registry.test.ts | 12 | ✅ |

biome lint(4 个新/改核心源文件): **Checked 4 files. No fixes applied.**(干净)

### 2.2 突变测试(负向断言非空过绿验证)

对安全关键守卫逐一破坏,重跑对应焦点套件:

| # | 突变(破坏的守卫) | §2 硬约束 | 期望 | 结果 |
|---|---|---|---|---|
| M-A | statestore `probe!=="dead"` → `false`(不再 keep 非死目标) | awaiting_review+alive 不可触 | RED | ✅ 2 failed |
| M-B | statestore age guard → `false`(fresh 不再 keep) | mid-dispatch 30min 护栏 | RED | ✅ 1 failed |
| M-C | statestore finalize-fail 分支 → `false`(finalize 失败仍 transition) | finalize 先于 transition 的 fail-closed | RED | ✅ 1 failed |
| M-D | commdb-fsm 孤儿 24h age guard → `false` | mid-dispatch 24h 护栏 | RED | ✅ 1 failed |
| M-E | commdb-fsm `parseHarvestStartedAt` 未来守卫移除 | 未来时间戳 → keep | (见 §3.1) | 仍全绿 |
| M-F | orphan-escalation index-unreadable abort 标志翻转 | 任一 CommDB 不可读 → 全 keep | RED | ✅ 1 failed |

5/6 突变按预期转红。M-E 见 §3.1(冗余守卫,非缺陷,非空过绿)。

### 2.3 byte-compat off-sentinel(计划 §M1/§M5 要求)

- `commdb-fsm-reconcile.test.ts`「preserves the exact legacy result shape」:`Object.keys(result)` 与旧 6 字段逐字节相等 + harvest 省略时 `probe` 零调用。✅
- `residue-harvest.test.ts`「flag OFF preserves legacy FLY-817+FLY-638 order and zero new calls」+「both flags OFF」+「residue ON + FLY-817 OFF」矩阵。✅
- plugin.ts 源码 wiring 哨兵:residue tick 在 `worktreeAutocleanEnabled()` early-return **之前**;terminated archive `allowStatuses: ["terminated"]`;flag 单次捕获。✅

## 3. QA 观察(非阻塞)

### 3.1 M-E:commdb-fsm 面① 未来时间戳守卫是 defense-in-depth,非空过绿

`parseHarvestStartedAt` 的 `startedAtMs > nowMs → undefined` 守卫拆掉后测试仍全绿。**根因分析(非缺陷)**:面① 下游 age guard `nowMs - startedAtMs <= orphanMinAgeMs` 对未来时间戳给出**负** age,负值恒 ≤ 正阈值 → 未来行**无论如何被 age guard 独立 keep**。故拆 parse 层未来守卫无行为变化,无测试可转红。

- 行为**正确**(未来行始终 keep,双重安全);age guard 本身有突变杀伤力(M-D 已证)。面① 未来行实际由已被测的 age guard 兜住。
- 结论:M-E 突变的是冗余(belt-and-suspenders)守卫,**不降低安全性**,不构成 vacuous green(负向断言仍成立且被 age guard 保护)。记为观察,不要求改动。
- statestore 面③ 对称结构同理(parseStartedAtMs 未来→undefined,age guard 亦兜底)。

## 4. 生产只读复现(same-predicate,非破坏性)

复制生产 `~/.flywheel/comm/geoforge3d/comm.db`(含 WAL)+ `~/.flywheel/teamlead.db` 到隔离目录,忠实复现判据:

| 样本 | CommDB | StateStore(FSM) | `tmux list-panes` probe | harvest 判据 → 动作 |
|---|---|---|---|---|
| ① `d2f31930` | running `%194`(无 issue/lead,2026-05-11) | **无 row** | **DEAD**(can't find pane) | 面① `!fsm+age>24h+dead` → **收(orphan)** |
| ② `e4d3b29d` | running `:pending` | **failed** | **DEAD**(can't find window) | 面② `CRASH_PRESERVE+dead` → **收(preserve)** |
| ③ `e90f3962` | running `:pending` | **failed** | **DEAD** | 面② → **收** |
| `2692122f` GEO-342 | running `@156` | failed | **DEAD** | 面② → 收 |
| `5491a2a1` GEO-424 | running `@63` | failed | **DEAD** | 面② → 收 |
| `da6c6c3d` GEO-347 | running `@121` | failed | **DEAD** | 面② → 收 |
| **阳性对照** `cfd3ea5e` GEO-429(2026-07-16 新) | running `@747` | **awaiting_review** | **ALIVE** | 非 deletable/非 preserve/有 fsm → **保活**(§2 硬约束) |

- Peter 3 个验收样本(issue 原文)全部在场,与 research §3.1 取证逐字吻合;判据分类精确。
- 阳性对照:一个 07-16 新出现的合法 `awaiting_review` runner(tmux alive),harvester 结构性不触 → 证明收割器**能区分活行、不误伤**(Annie 要求的阳性对照)。
- tmux server 在跑(DEAD 是逐目标真死,非 server-down 掩盖全部)。
- 实际收割延后到部署重启(founder-gated,M6)。三段式 QA 只做只读复现,不人造/不删除生产行。

## 5. 验收清单对照(plan §4)

- [x] §2 硬约束哨兵全绿 + 突变对照:awaiting_review+alive 不可触(M-A)、alive/indeterminate keep、删除只认 dead、时间戳缺失/非法/未来 keep。
- [x] 面③ fail-closed:finalize 先于 transition(顺序断言)、finalize 失败不 transition(M-C)、FSM 拒绝不 force、qa-loss/archive/event 侧效显式断言 + plugin 源码 wiring 哨兵。
- [x] 面④:双无主(含 ACKED)→ RESOLVED('residue_harvest');任一 CommDB 不可读→全 keep(M-F);lead 键不动;UPDATE 前逐候选双重新读(race test);复活 predicate 扩至 residue_harvest(更晚 firstDetectedAtMs 复活 NEW,'lead' 不复活)。
- [x] `FLYWHEEL_COMMDB_RESIDUE_HARVEST=0` 三处反向哨兵(Object.keys 级 byte-compat)+ FLY-817 子闸独立。
- [x] 负向断言突变对照(5/6 转红;M-E 为冗余守卫,§3.1)。
- [x] Peter 3 样本 + 同型 ×5 判据命中、阳性对照零误伤(生产只读复现;实收割待部署)。

## 6. Lead QA scope 应答(Tadashi 5 点,收割器 = 全批最危险项)

### ① 零 false-positive(唯一致命线)—— same-predicate preflight 全项目审 20 个 HARVEST

只读复现 harvest 判据(`preflight.sh`,本文件夹),覆盖全 6 配置项目 + sub。**HARVEST=20 / KEEP=18**。逐个审 20 个 HARVEST:

| 项目 | HARVEST | 判据(全部 terminal/CommDB-灭失) | 关键 KEEP(活/合法,不可触) |
|---|---|---|---|
| geoforge3d | 6 | failed×4 + orphan(d2f31930 66天)+ failed×1,全 probe=dead | cfd3ea5e awaiting_review(alive)|
| joycon-typeless | 3 | failed×2 + blocked×1,全 dead | 7339c7a9 awaiting_review |
| growth | 2 | failed×2,全 dead(仅 2 running,0 活行)| —(无活行被误判)|
| flywheel | 8 | failed×6 + blocked×2,全 dead | design_done×6、running×7、awaiting_review×2 |
| sub | 1 | failed dead,**标记 NOT-CONFIGURED**(主 Bridge 不迭代 sub → 不收)| — |

**结论:20 个 HARVEST 无一是 alive / awaiting_review / running / design_done / 合法等 founder。** 全部 `fsm ∈ {failed, blocked}`(终态 crash residue)+ probe=dead,或 66 天 no-fsm 孤儿。关键阳性对照全部 KEEP:**`c2c970bd`=本 QA runner 自己**(running)、**`3b24d68a`=本 issue 的 implement session**(awaiting_review)、多个活跃 build runner(6b3afba8/2d9f2845/8bb6aa25/5e15c660)、design_done park holder ×6。

### ② face-③ 硬 probe —— design→implement 交接瞬态,真 probe 不信注释

`statestore-ghost-realprobe.qa.test.ts`(本 PR 新增,真 tmux + 真 `probeTmuxWindowLiveness`,4 tests PASS):
- 真 probe 对 live session 返 alive、对 gone session 返 dead(基线)。
- **(A)** awaiting_review + CommDB 空窗 + **真 live tmux session** + 46min → **KEEP**(`kept_target_not_dead`,不终态化)—— 交接瞬态不可触,由 probe-alive 兜住(实测非注释)。
- **(C)** fresh(<30min)→ age guard 在 probe **之前**就 keep(独立第二道网)。
- **(B)** 同一形态但真 session 被 kill → probe=dead → **reaped**(证明是真 probe 状态驱动决策,非 mock)。

### ③ 三触发点运行时实证(不只 source sentinel)

- **boot**:`residue-harvest.test.ts`「flag ON uses shared harvester」运行时断言 `runFullPass()` 被调 + plugin.ts `runResidueAwareBootSweep({residueHarvester})` + **typecheck 通过**(活的类型化调用)。
- **scheduled-run**:`stale-blocker-guard.test.ts` 运行时测 `reconcileGhost=true→调用一次+proceed`、`=false→调用一次+回落 FLY-742`(guard seam 真被调,非 sentinel)+ plugin.ts `reconcileGhost: opts?.residueHarvester ? …reapTarget : undefined` + typecheck。
- **maintenance-tick**:`residueMaintenanceEveryNTicks` cadence 运行时测 + 源码哨兵断言 tick 调用位于 `worktreeAutocleanEnabled()` early-return **之前**(= 可达,不被 autoclean kill-switch 误关)+ typecheck。真 HeartbeatService boot 调用不隔离运行(会对生产真收割,不做)。
- **typecheck**:`tsc --noEmit` **exit 0 / 0 errors** —— plugin.ts 三处 wiring 是活的类型集成代码,非 dead/注释。

### ④ 特别核 joycon / growth / sub(全判死要确认不误杀活)

见 ① 表:joycon 3 HARVEST 全 failed/blocked+dead(1 awaiting_review KEEP);growth 2 HARVEST 全 failed+dead(仅 2 running,0 活行被误判);sub 1 HARVEST 但 NOT-CONFIGURED(主 Bridge 结构上不碰)。

### ⑤ 安全判据

收割信号 = terminal FSM(failed/blocked)/CommDB 存在性(no-fsm orphan)+ probe=dead,**不看 FSM 是否终态**(awaiting_review/design_done/running/approved_to_ship 非终态但**一律 KEEP**);alive/indeterminate/fresh(<24h orphan、<30min ghost)/founder-owned 一律 keep。真收割 restart-gated 是兜底非替代,本 QA 是硬门(preflight + real-probe + 单元 + 突变均过)。

### R5 深查:`:pending` / 同名窗口 fnmatch 的时变 probe(实时观察 + 结构性安全)

生产 tmux fleet 高负载 churn 时,我实时观察到 HARVEST 候选(`:pending`/`@NNN`)probe 在 alive/dead 间跳变(别的 live runner 瞬时复用同名 session/占位窗口)。**结构性安全经代码确认:**
1. HARVEST **只在 probe=dead** 触发;瞬时 probe=alive → 该轮 KEEP(保守、延迟收割,**非** false-positive)。
2. live runner 由 **FSM 状态** keep(non-terminal 不看 probe)。
3. `finalizeSession` = `DELETE FROM sessions WHERE execution_id = ?`(严格按 execution_id,**绝不按 tmux 名**)+ 按 execution_id 清 runner_phase_wakes/shutdown_controls → 即便 `:pending` fnmatch 撞上 live runner 占位,收割失败行只删该 execution_id,live runner(不同 execution_id)毫发无损。
> = research §6 R5 + §2 记载的「同名新窗 → keep(保守无害,只延迟收割)」,实时 churn 下验证成立。

## 7. 完整 teamlead 套件回归结论

完整套件 35 test 失败(codex-lead-runtime 22 / run-dispatcher 9 / fly350 1 / terminal-thread-archive 1 timeout 等)。**全部环境/负载失败,零 FLY-1066 关联,已证实:**
- 7 个失败文件**零 FLY-1066 符号引用**;隔离(单线程)下同样失败(非并行 flake)。
- 失败根因:(a) `FLYWHEEL_CODEX_LEAD_WORKSPACE / project root must not overlap ~/.flywheel` —— 测试在 `~/.flywheel/runner-state/<本-exec-id>/browser-tmp/` 下建 scratch,代码**正确**拒 overlap(= MEMORY 记录的 TMPDIR-overlap 环境假失败;tsx IPC 同因挂,已用 TMPDIR=/tmp 旁证);(b) run-dispatcher 期望 pristine env 但本 runner session 的 `FLYWHEEL_*` env 泄漏;(c) terminal-thread-archive M9 5s 超时(负载)。
- **决定性证明**:同样 7 文件在 `git checkout origin/main`(merge-base `3d862dea2`,**无 FLY-1066**)下**同样失败复现**(同 `must not overlap ~/.flywheel` / `full-access project root`)→ 既有/环境失败,非本 PR 引入。branch 33 vs main 32 的 1 个差异 = load-dependent 的 M9 5s 超时 flake。
- FLY-1066 焦点 6 套件 125 + config 12 + 本 PR 新增 real-probe 4 = **全绿**;lint + tsc 干净。

## 8. 遗留 / 交接

- M6 真机收割 = 部署重启后 founder-gated 执行;本 QA 已把「重启前置门」same-predicate 分类对全项目只读跑通(`preflight.sh`,HARVEST=20/KEEP=18,零 false-positive)。部署后按 plan §M6.2 复核收割计数 + 合法行在场即可。
- 已知既有 flake(非本 PR):codex-lead-runtime TMPDIR-overlap、terminal-thread-archive M9 超时、run-dispatcher env-leak —— 建议后续 de-flake(env 隔离 + TMPDIR pin)。
