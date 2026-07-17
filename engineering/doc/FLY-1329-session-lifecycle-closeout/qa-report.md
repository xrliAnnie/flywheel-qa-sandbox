# FLY-1329 session 生命周期底座收口 — QA 报告(PR-A)

Issue: FLY-1329 (https://linear.app/geoforge3d/issue/FLY-1329)
日期: 2026-07-17
基于: plan.md(v5)、implementation on branch flywheel-FLY-1329
PR: #632 「[FLY-1329] PR-A: session lifecycle floor — a restart must never kill a park-alive runner」
QA head: 47561e217a0d6e1bf1a3d1dafd4d35058a3cea66(= PR headRefOid,已核对一致)

## Verdict: PASS(scope = PR-A / D1)

本次 QA 验的是 **PR-A** —— D1「重启/收尾路径不得杀 park-alive」这一层。plan 的 PR-B(executor-merge finalize)、
PR-C(QA-first hold)、PR-D(turn/complete 滞后)与 A6(effect 拆分 seam)是后续 PR,不在本 PR 范围,本报告
不为它们背书。

## 1. Scope 核对(PR #632 实改面 = PR-A)

32 文件,+3239/-19。核心新增:`destructive-verdict.ts`(纯裁决模块)、`liveness-evidence.ts`(A2 告警注释)。
改动点覆盖 plan §1 的 A1–A5:

| 编号 | 落点 | 状态 |
|---|---|---|
| A1 四输入破坏性裁决 | `destructive-verdict.ts` + `phase-orchestrator.ts` handoff 消费 | ✅ |
| A2 活动证据=告警注释 | `liveness-evidence.ts`(结构上不进 verdict 输入) | ✅ |
| A3 全角色 re-adopt | `StateStore.getReadoptCandidateSessions` + `HeartbeatService.seedReconnecting` | ✅ |
| A4 prune parked-veto(两个删除口) | `commdb-fsm-reconcile.ts`(running-face)+ `commdb-session-prune.ts`(terminal-face) | ✅ |
| A5 FLY-324 veto(boot + live 两处) | `done-running-reconciler.ts`(boot)+ `event-route.ts:2156`(live) | ✅ |
| kill-switch 注册 | `config/feature-flags/registry.ts` 四个 flag 全在册 | ✅ |

## 2. 测试执行(全绿)

直接用 vitest 跑目标文件(避开 `pnpm -r test` 首失败即 bail 的坑):

- **新增 FLY-1329 测试:81 passed**(destructive-verdict 25 / liveness-evidence 10 / phase-orchestrator park-alive 7 /
  commdb-fsm-reconcile veto 4 / commdb-session-prune veto 4 / done-running veto 6 / HeartbeatService readopt-parked 18 /
  statestore readopt-candidates 7)。
- **被改动的既有测试(byte-compat 回归):196 passed**(HeartbeatService monitor-loss / zombie-offpath-golden /
  zombie-reconcile / commdb-fsm-reconcile / commdb-session-prune / done-running-reconciler / event-route)。
- **config:14 passed**(feature-flags-resolve)。
- **CI**:Build & Test `pass`(18m20s)+ payload distribution `pass`,跑在本 QA head 上。
- **lint**:10 个改动源文件 biome check 干净。

## 3. 反-空过绿测:7 变异全部被抓(核心证据)

memory 铁律:负向断言(「不得 close」「不得 prune」「不得 force-complete」)必须突变验证,否则可能是空过的绿测。
自建 mutation battery(`qa-mutation-battery.sh`,与本报告同目录归档),对**生产代码**逐个注入精确单点变异,证明
每条守卫的测试非空过。**harness 三重刚性(Codex 增量 review 折入,见 §6.2)**:① 变异前先确认目标测试 **GREEN
baseline**(否则「红」不能归因给变异);② 变异后的「红」必须是**真断言失败**(vitest 的 `Tests N failed` 汇总行 +
排除 compile/collection 错误标记)—— 不把「任意非零退出」当作 caught;③ **trap 兜底的中断安全复原**(EXIT/INT/TERM
都 `git checkout` 还原,末尾硬校验 tree 干净,失败即 loud exit)。变异锚点断言恰 1 处匹配(没打上 = harness 自身失败)。
下表为初次运行结果(Codex 独立复现了 M1–M4 的精确失败数):

| 变异 | 打回的是什么 | 目标测试 | 结果 |
|---|---|---|---|
| M1 | handoff `absent` 重新授权 close(= FLY-1319 原 bug) | phase-orchestrator.park-alive | RED(2 failed)✅ |
| M2 | A4 running-face veto 去掉 | commdb-fsm-reconcile.parked-veto | RED(2 failed)✅ |
| M3 | A4 terminal-face veto 去掉 | commdb-session-prune.parked-veto | RED(1 failed)✅ |
| M4 | A5 boot sweep veto 去掉 | done-running-reconciler.parked-veto | RED(2 failed)✅ |
| M5 | A5 live-handler veto 失效 | event-route(A5 组) | RED(3 failed)✅ |
| M6 | A3 re-adopt 收窄回 running-only | statestore.readopt-candidates | RED(4 failed)✅ |
| M7 | A1 核心裁决 absent 重新授权破坏 | destructive-verdict | RED(3 failed)✅ |

7/7 全部 CAUGHT,0 vacuous,复原后 tree 干净。**每一条守卫的负向断言都真的在防守。**

## 4. 生产真路径核对(防「fixture 开了、生产没开」陷阱)

- **A4 两个 veto 的 declared-state 读取是真 CommDB**:测试 `seedRunning` 用真 `CommDB.upsertDeclaredState`,reconciler
  默认路径读真 `getEffectiveDeclaredState`(非注入 mock);只有 fail-closed 用例注入 throwing stub(真 CommDB 无法制造
  throw)。生产 `plugin.ts` 调 `reconcileCommDbRunningAgainstFsm` / `pruneDeadTerminalCommDbSessions` **不注入 isParked**
  → 走同一条真 `getEffectiveDeclaredState` 路径。A5 boot sweep 生产传的 `isParked` 闭包 = `probeDeclaredStateFromCommDb(...)`,
  也是真读。→ **veto 在生产可达,不是只在测试里。**
- **A3 re-adopt 用真 StateStore**:`statestore.readopt-candidates` 打真 sql.js WASM 库(206ms);`seedReconnecting` 生产
  用 `getReadoptCandidateSessions()`(running + awaiting_review + design_done + approved_to_ship),kill-switch
  `FLYWHEEL_READOPT_PARKED=0` 回退 running-only。这正是事故里「QA 被重收养、parked implement 没被收养」的根因查询。
- **A5 live 用真隔离 CommDB**:`event-route.test` 的 A5 组用隔离 `a5CommRoot` 真 comm.db,覆盖 veto / kill-switch /
  corrupt-db fail-closed / project-mismatch(用 resolved session project 而非 event envelope)四形态。
- **R-1319 fixture 是生产形态**:`review_question_id` 必填(否则 FLY-921 Fix B 会在 liveness 分支前先 fail-close,
  断言全为错误原因而过)、`tmux_session` 缺省(对齐生产 1423 行 0 非空,给它赋值 = 触碰生产走不到的 FLY-1224 direct-probe 分支)。

## 5. 验收对照(仅 PR-A 覆盖项)

| issue 验收 | 本 PR 落点 | QA 结论 |
|---|---|---|
| 重启不杀活 park-alive / 不丢 CommDB row | A1 handoff 不再 absent→close;A4 两口 veto 不删 row | ✅ 单测+真 CommDB+变异 |
| re-adopt 覆盖所有 role(今晚漏了 implement) | A3 `getReadoptCandidateSessions` 含全角色 park 态 | ✅ 真 StateStore+变异 |
| FLY-324 completed 强转要认 parked 声明 | A5 boot + live 两处 veto | ✅ 真 CommDB+变异 |
| 回归重演 1319 | `phase-orchestrator.fly1329-park-alive`(532c634b 精确形态)+ 变异必红 | ✅ |
| executor-merge finalize / FSM-side finalize / QA-first | **PR-B/C/D 范围,不在本 PR** | ⏭ 后续 |

## 6. 边界与遗留(诚实标注,非静默跳过)

1. **真机 live-Bridge-restart E2E 未在本 QA 段跑**。理由:PR-A 是纯 Bridge 侧生命周期**决策**逻辑,无 Discord/founder
   surface、无检测启发式;它触碰的真实底座(CommDB declared-state、StateStore WASM、隔离 comm.db)已被上面的真-substrate
   集成测试 + 变异验证覆盖;tmux 探针结果(absent/dead_pin)是逻辑的**输入**,每个取值的处理都被穷举测过;Bridge boot
   orchestration(seedReconnecting)是未改的既有管道,变的只是它消费的 query(已对真 StateStore 测)。要跑真正的
   live-restart E2E,只能 (a) 拿未合并代码重启**生产** Bridge(红线禁止),或 (b) 为一个 partial PR 单独起隔离 Bridge
   (529 Room 当前被 FLY-314/368 QA 占用)。**建议**:把 park-alive-survives-restart 的真机确认放到 (a) 部署批次上线后
   的自然重启观测(fail-safe 方向 + 全 kill-switch 兜底),或 (b) 529 Room 腾出后与 PR-B/C/D 合批跑。
2. **§6.2 Codex 增量 code review(已跑,已折入其发现)**。QA 阶段推 QA 证据 commit 把 head 从「已 4 轮 Codex APPROVED」的
   `47561e217a` 推到 `9ae306186`(delta=3 纯文档),据 Tadashi 指令跑 Codex **增量** review。Codex(school profile,xhigh):
   ① 独立核实 delta 确为 doc-only(`packages/`/`scripts/` 均无变化);② 独立复现了本报告 M1–M4 的**精确失败数**(证明结论真);
   ③ 对 `qa-mutation-battery.sh` 提了两条 harness 稳健性意见——(a)把「任意非零退出」当 caught、缺 green baseline / 失败类型
   校验,(b)restore 失败被吞、非中断安全。**两条已折入**(§3 三重刚性:baseline + 真断言失败分类 + trap 中断安全复原;
   name-filter 提速),**非 waive**。中断安全那条在本轮实测被验证:一次 SIGTERM 触发 trap 自动还原了被变异的 7 个生产文件,tree 干净。
   merge 前置:最终 head 上的 codex_review_record 落库(await-codex-gate 绑 `9ae306186`)+ founder 放行;ship-eligibility
   (FLY-827 codex gate)会硬拦缺记录的 merge,不会被静默绕过。
3. **A6 未做**、PR-B/C/D 未做:progress.md 记 「剩 A6/PR-B/PR-C/PR-D」。本 PR 只交付 D1 层。
4. **FLY-1224 留档**:生产 `sessions.tmux_session` 从未写入(1423 行 0 非空)→ FLY-1224 direct-probe 分支
   (`phase-orchestrator.ts:1884`)生产不可达,其 T6/T8 测走不到的路径。本单不动,给 FLY-1224 留档(implement 已记)。

## 7. 结论

PR-A 的 D1 层实现**正确、测试非空过、生产路径可达、字节兼容有 kill-switch 兜底**。QA 维度 **PASS**。
merge 前置:Codex code review 在最终 head 跑过 + founder 放行。真机 live-restart 确认按 §6.1 建议安排。
