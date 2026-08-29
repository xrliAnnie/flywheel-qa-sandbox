# FLY-1070 替身 QA 验证 PR #528 — QA 报告

Issue: FLY-1070 (https://linear.app/geoforge3d/issue/FLY-1070/qa-fly-1050-独立验证-pr-528三段式死-qa-干净重生)
日期: 2026-07-09
基于: plan.md

## Verdict: **PASS**(附 FAIL-partial 分级段:F10 Done-否决缺口,fast-follow,不阻塞)

- 验证对象:PR #528 head `5da5fd180bfd88abefbcb5035008ba998ac63241`(三段式死 QA 干净重生,FLY-1050)
- QA 环境:自建 detached worktree `worktrees/qa-fly-1070` @ 5da5fd18,重建 dist,全程未触碰 parked implement 工作区(`/Users/xiaorongli/Dev/flywheel-FLY-1050`)与生产 DB/env
- head/CI 校验:QA 开始与 verdict 前两次复核 `origin/flywheel-FLY-1050 == 5da5fd18`、PR OPEN、CI Build & Test SUCCESS at head(evidence/step0-head-check.md)
- 目标 exec:`eb8f00a6-286e-4fa2-b830-37cd3054c201`(FLY-1050 parked implement)

## 五面结果矩阵

| 面 | 内容 | 结果 | 证据 |
|---|---|---|---|
| 1 | 定向单测独立复跑(9 文件,自建 worktree + 重建 dist) | ✅ 全绿。orchestrator ×4 = 69+32+18+16 = **135 tests**(与 implement 交接口径逐字一致);触点 ×5 = 32/7/5/18/7。零 fail;零真 skip(日志中 2 处 "skipped" 是测试名字面词,非 vitest skip) | step1-unit-rerun.log |
| 2 | 回归 fixtures:F1-F7/F9 映射核对 + F8a-F8d 独立行为补位 + FLY-1018 重构 + F9 生产 marker | ✅ 全过(对照表见下) | step2-3-f8-f10-harness.log + qa-f8-harness.mjs |
| 3 | F10 Done-否决缺口实证 | ✅ 按预期:两例实锤现状形态零触发(防御正确);缺口类行为实证成立 → **FAIL-partial**(见下) | 同上,Case 9-11 |
| 4 | 隔离 module-driven 行为 E2E(E1-E8b,含 MANDATORY E6/E7) | ✅ 全过 | step4-e2e-harness.log + qa-e2e-harness.mjs |
| 5 | 全仓失败甄别 | ✅ 复用 implement 交接结论(PR #528 comment 2026-07-09 21:24:3 个 isolation 失败 base 同红 = pre-existing;FLY-1050 触面 suites isolation 全绿),未重跑 | PR #528 comment |

## 验证面 2 — fixture 对照表(证据来源标签)

| Fixture | 覆盖方式 | 标签 | 结果 |
|---|---|---|---|
| F1 / F1-boot(FLY-967 形态) | head 单测 fly1050 :214-:273(复跑绿) | head-test | ✅ |
| F2 = FLY-1018 / F3 cap | head 单测 :275-:315(复跑绿)+ harness Case 7 独立重构(恰 1 spawn、sessionRole=qa、startPoint=head、TURN 落 CommDB) | head-test + **real-store** | ✅ |
| F4/F4b/F4c(FAIL intent 域) | head 单测 :317-:383(复跑绿) | head-test | ✅ |
| F5/F6/F7 哨兵 | head 单测 :384-:526(复跑绿) | head-test | ✅ |
| 并发/幂等/evidence 门/ghost 门/belt/stranded-pass | head 单测 :528-:768(复跑绿)+ E2E E8a/E8b 真 store 重证 | head-test + real-store | ✅ |
| F9 merge-blocked | head 单测 :558-:597(3 tests 复跑绿)+ harness Case 8 用**生产真实 marker 串** `merge_without_approval:review_question_unbound/qa_snapshot_missing_exempt` 双路径(scoped+boot)零 spawn 零告警,skip log 在 | head-test + **real-store** | ✅ |
| **F8a**(CommDB 孤儿,样本① d2f31930:CommDB row issue_id=NULL、StateStore 无 row) | harness Case 1:真 CommDB registerSession(issueId 省略→NULL)+ 真 StateStore 无 row → reconcileQaLoss 不 throw、零 spawn(getSession→undefined 走 main-role 默认 no-op) | **CommDB-only** | ✅ |
| **F8b**(死 qa 形态但 chat_thread_role='main') | harness Case 2:真 store main-role terminated row → 全程 no-op(与 head F7 单测互证) | **real-store** | ✅ |
| **F8c**(issue_id 形态矩阵) | Case 3:issue_id=空串死 qa row,scoped+boot 双路径不崩零 spawn;Case 4:跨 project 僵尸形态(无 stranded implement)不崩零 spawn;Case 5:依赖级 throwing seam 注入查询异常 → `hasProgressedPastImplement` fail-closed 返 progressed(不重驱)+ 告警日志逐字命中 "treating as progressed"。**注**:StateStore `sessions.issue_id` 为 TEXT NOT NULL,NULL 形态只在 CommDB 侧可构造(归 F8a)——矩阵按 Codex R1 #1 拆两桶 | **real-store** ×2 + **fault-injected** ×1 | ✅ |
| **F8d**(scope-free 判定) | code-audit:`reconcileStrandedImplementHandoffs`(phase-orchestrator.ts:560-590)与 `reconcileQaLoss`(:655-669)全链无 `checkLeadScope` 类检查(对照 actions.ts terminate 路由 :1371-:1378 有 checkLeadScope)——Bridge 侧 reconcile 是 store-wide;harness Case 6 佐证:跨 project stranded implement 被 boot reconcile **真遍历到**(skip log 逐字点名 `impl-other`)但因判据(alive qa)no-op,零 spawn。不因 scope 漏看形态,也不因 scope 越权收割(收割本就不做,归 FLY-1066) | **code-audit** + **real-store** | ✅ |
| FLY-1018 现场重构 | harness Case 7(见 F2 行) | **real-store** | ✅ |

**F8 附注**:F8 命名 fixtures 未随 PR #528 落库(FLY-1050 design addendum 未落 git,全树无 F8 命名测试——与 research.md §2/§3 溯源一致)。本 QA 已按 FLY-1066 形态规格独立行为验证补位(各 case 证据来源标签如上);fixtures 固化归 FLY-1066 fast-follow。

## 验证面 3 — F10 结果(FAIL-partial 段)

1. **样本现状防御验证 ✅**(real-store,Case 9/10):按生产库只读快照形态(research.md §4)重构 FLY-1023(design completed / implement completed / qa completed+merge_block / implement terminated+merge_block)与 FLY-1047(design+implement completed / qa terminated / implement terminated)——两者**均无 implement@awaiting_review** → scoped + boot 双路径零 spawn 零告警。**两例 closed-Done 被 respawn 的实锤不是 #528 的暴露面**(拉起者是 pre-#528 既有机制),#528 判据对样本现状不触发,防御正确。
2. **缺口类实证 ⚠️ FAIL-partial**(real-store + code-audit,Case 11):构造「issue 已 Done(Linear 状态;StateStore **无任何关联字段**——缺口本体)+ implement@awaiting_review + 死 qa row + 无 ship claim + 无 merge_block」→ boot reconcile → **spawn 被触发**(start=1)。code-audit:`hasProgressedPastImplement`(phase-orchestrator.ts:701-720)只 consult ship claim / alive qa / latest intent,**无任何 issue Done/closed consult**;`isMergeBlocked`(merge-ship-gate.ts:70-74)只看 merge_block_reason。**判据未覆盖「issue 已 Done/founder 已关」硬否决。**
   - 复现 fixture:见 qa-f8-harness.mjs Case 11(与合法搁浅 issue 字节全同——正因 store 侧无字段可分辨)。
   - 真实世界后果:替身 QA 模式下,父单 ship 后其 parked implement 正是此形态(**FLY-1050 的 eb8f00a6 ship 后将成活标本**)——#528 部署后下一次 Bridge boot 会对已 Done 的 issue 重生 QA(cap=3 兜底限幅,但仍是 3 次无谓 spawn + 3 条告警)。
   - **fast-follow 建议**(issue 原文已授权此结果不阻塞主修复;修复方案 QA 不越权设计,只列方向):
     a. 判据补 issue-Done 硬否决(需给 sessions 或判据引入 issue 终态信号——如 ship/close 时打标);或
     b. ship/close 收尾时终结 awaiting_review 的 implement row(替身 QA 模式的 finalization 把父单 implement 收进终态,消灭形态本身);
     建议在 FLY-1066(fixtures 固化)同窗或单开 issue 处理。
3. 意外分支未触发:head 未覆盖此缺口(spawn 真发生),结论维持 FAIL-partial。

## 验证面 4 — E2E 剧本结果(每条独立 tmp 环境,串行)

真:dist、StateStore(tmp sqlite)、CommDB(tmp,FLYWHEEL_COMM_DIR)、express 双挂载(createBridgeApp)、真 PhaseOrchestrator/DirectEventSink/event-route(/events HTTP)/crash-reaper(reapCrashedRunners)。fake 3 面(dispatcher 记录+pre-launch seam 模拟 / tmux probe 注入 / Discord+alert 记录)。**fire-and-forget 纪律**:正向断言有界轮询(5s/25ms);负向断言等满 800ms 静默窗口(时长已记 evidence,Codex R2 note)。

| # | 剧本 | 结果 |
|---|---|---|
| E1 | `/api/actions` terminate 活 QA → 事件驱动 respawn:start 恰 1、sessionRole=qa、startPoint=implement head、shareParentBranch、CommDB TURN holder=新 QA、**epoch 1→2 严格 +1**、零 STALE-TURN 告警、thread note 恰 1 | ✅ |
| E2 | `/actions` dashboard alias 同触发(FLY-175 双挂载) | ✅ |
| E3a | terminate + 死 qa 残留 LIVE tmux(probe 注入 alive)→ qa-loss 照触发、**ghostGuard fail-closed 挡 spawn + 告警**、belt TURN 逐字节不动(terminated 不进终态快路径) | ✅ |
| E3b | **cleanupPending 真实形态**(CommDB 读损坏 → lookup error;HOME 覆盖到 tmp 构造,零接触真 ~/.flywheel):HTTP 400 + cleanupPending:true + FSM 已 terminal → qa-loss **照触发** → respawn(守卫 `(success \|\| cleanupPending)` 实证,Codex R1 #2) | ✅ |
| E4 | session_failed 两条产线路径:DirectEventSink.emitFailed 与 /events event-route 各一次 → respawn,qa-loss 先于 belt(TURN=新 QA、零告警) | ✅ |
| E5 | crash-reaper:stale-heartbeat QA 被 reap → `onQaPhaseTerminated` 闭包(逐字镜像 plugin.ts:3477)→ respawn | ✅ |
| E6 | **cap 风暴(MANDATORY)**:连杀 3 轮 → 第 1/2 轮 respawn 成功(epoch 2→3 递增、holder 逐轮换新);第 3 条死 row → **failClosed 告警 + 零 spawn**;经第二产线路径(emitFailed)再触发 → **告警再发(离散事件语义)+ 仍零 spawn** | ✅ |
| E7 | **escape-hatch 对照(MANDATORY)**:`FLYWHEEL_THREE_STAGE_QA_RESPAWN=0` → (a) scoped 全 inert(零 spawn);(b) boot 判据回退 row-exists(skip);(c) **terminated stranded-pass 硬化不随开关回退**(=0 下告警仍发) | ✅ |
| E8 | 幂等/并发:respawn 落 alive row 后经 emitFailed 再触发 → no-op;同 issue 双并发 reconcileQaLoss(dispatcher 50ms 延迟窗口)→ spawn 恰 1 | ✅ |

### E2E 过程记录(非缺陷,如实记录)

- **lookupTmuxTarget 硬编码 homedir 路径**(tmux-lookup.ts:172 `join(homedir(), ".flywheel", "comm", …)`,不走 `FLYWHEEL_COMM_DIR`):对本 harness 的隔离 project 恒 gone(只读 existsSync,零写生产)。E3b 因此用 HOME 覆盖构造。**这是 pre-#528 既有代码**,非本 PR 引入,不影响 verdict;仅注:`commdb-path.ts` 的 FLYWHEEL_COMM_DIR 测试逃生口未覆盖此函数,测试隔离性上是个既有小坑。
- E6 re-trigger 时 belt 对 failed holder 做了一次 STALE-TURN 恢复(epoch 3→4 给 probe-alive 的候选)——harness 的 probePhaseAlive 恒 "alive" 所致,符合 belt 语义(cap 拒绝 respawn 后 belt 恢复 TURN 正是设计内分工),cap 核心断言(零 spawn + 再告警)不受影响。
- 首轮 F8 harness 3 case 假红为 QA 环境因素(`upsertSession` 不带 review_question_id/merge_block_reason,生产走 `setReviewBinding`/`setMergeBlock` 专用 setter),改用生产 setter 播种后全绿——按 systematic-debugging 甄别为 harness 缺陷修正,非被测代码问题(经过留 log)。

## Evidence 索引(engineering/doc/FLY-1070-qa-respawn-verify/evidence/)

| 文件 | 内容 |
|---|---|
| step0-head-check.md | head/CI/worktree/负载预检记录 |
| step0-build.log | pnpm install + teamlead dist 重建输出 |
| step1-unit-rerun.log | 9 文件串行复跑全量输出(每文件 EXIT 码 + tests 计数) |
| qa-f8-harness.mjs | 验证面 2/3 行为 harness(F8a-F8d/FLY-1018/F9/F10,import dist) |
| step2-3-f8-f10-harness.log | 上述 harness 运行输出(11 cases ALL PASS) |
| qa-e2e-harness.mjs | 验证面 4 E2E harness(E1-E8b,真 express/StateStore/CommDB/触点) |
| step4-e2e-harness.log | E2E 运行输出(ALL PASS;含静默窗口 800ms 记录) |

## 交付

- `qa-result --status pass --target-exec eb8f00a6-286e-4fa2-b830-37cd3054c201`(本报告 commit+push 后发出)
- [FLY-1050] thread 报告经 Lead relay(Runner 不直投 Discord)
- QA worktree `worktrees/qa-fly-1070` 保留至 Lead 确认 verdict(QA 证据纪律)
- **绝不 ship**——ship 决策归 founder gate(FLY-1050 侧)
