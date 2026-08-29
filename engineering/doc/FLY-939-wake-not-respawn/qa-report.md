# FLY-939 wake-not-respawn — 实施 QA 报告

Issue: FLY-939 (https://linear.app/geoforge3d/issue/FLY-939)
日期: 2026-07-07
基于: plan.md

## 实施摘要(Implement phase,同分支)

按 plan.md TDD 执行,四个残余缺口 G-A/G-A2/G-B/G-C/G-D 全部落地:

| Gap | 修点 | 文件 |
|---|---|---|
| G-A | fix-loop wake 失败 → fail-loud(`failClosed`)+ 不 patch fixExecId/alertedAt(保持可重放);handoff wake 失败 warn→failClosed | `phase-orchestrator.ts` `runFailFlowKeepAlive` / `handoff` |
| G-A2 | boot reconcile 扩到 stranded implement→qa 交接(零 qa 行 + 无 ship claim 才重驱) | `phase-orchestrator.ts` `reconcileStrandedImplementHandoffs` + `StateStore.getStrandedImplementPhaseSessions` |
| G-B | kickback 契约:awaiting_review + gate 已答 + FAIL → 进 fix-loop(wake implement);QA prompt 加 5-fb 步 + APPROVE GATE 步 f 在 QA 变体被 override;runner-wake feedback 加角色中立 deferral | `phase-orchestrator.ts` `onQaResult` / `Blueprint.ts` / `runner-wake.ts` / plugin `hasGateResponse` |
| G-C | spawn 兜底前 ghost 探测(直接探持久化 tmux_session,不走 CommDB)→ 活体/不明 fail-closed 不 spawn;只探最近 3 行 | `phase-orchestrator.ts` `ghostGuard` + `effects.probeGhostTmux` |
| G-D | boot 打印运行 HEAD + best-effort 比对 origin/main;stale(behind)→ WARN + durable event + Lead alert;分支/离线静音;`FLYWHEEL_BOOT_SHA_CHECK=0` 旁路 | 新 `boot-sha-check.ts` + plugin boot 接线 + registry 登记 + `AlertEventType` 新增 |

Step 0:PR #478(FLY-921)已 MERGED → 已 `git merge origin/main`(无冲突,不同代码区域),在 FLY-921 turn-belt 语义之上开发。

## 单元测试(全绿)

| 测试文件 | 用例数 | 覆盖 |
|---|---|---|
| `phase-orchestrator.fly939-wake-not-respawn.test.ts`(新) | 17 | G-A(wake-fail fail-loud/replayable + boot 重放同轮重 wake)/ G-A2(重驱 + 两种 skip)/ G-B(5 态守卫矩阵)/ G-C(ghost 活体/不明/全死/只探3行/fix-loop 兜底/keepalive OFF 哨兵) |
| `boot-sha-check.test.ts`(新) | 14 | classifyBootSha 5 态 + effect(stale/branch/same/unknown/env=0/git 抛错不炸/显式 refspec/event 抛错吞) |
| `Blueprint.fly939-kickback-prompt.test.ts`(新) | 4 | QA 变体 kickback 契约 + 步 f override;keepalive OFF + 单 session 哨兵(generic 步 f 逐字保留) |
| `StateStore.fly939-stranded-implement.test.ts`(新) | 3 | getStrandedImplementPhaseSessions 命中/排除 main/排除其它状态与角色 |
| `runner-wake-feedback-deferral.test.ts`(新) | 2 | feedback wake 含角色中立 deferral + 保留 generic;approval wake 不变 |
| `phase-orchestrator.fly887-keepalive.test.ts`(改) | — | handoff wake-fail 断言从 warn 翻成 failClosed(Step 2);新 deps 接入 |
| 既有 orchestrator/event-route/adversarial 套件 | 100 | 全绿(byte-compat 哨兵不变) |

byte-compat 哨兵:keepalive OFF 全路径、单 session prompt、auto-QA、spawn dispatch 参数、stranded design reconcile 行为 —— 均未变。

## 构建 / Lint

- `pnpm --filter flywheel-teamlead --filter flywheel-edge-worker --filter flywheel-config build`:全绿(`AlertEventType` 新增触发 LeadWatchdog 两个 exhaustive switch,已补 case)。
- biome format:已 `--write` 修齐。

## 真机 E2E(留独立 QA session,不自证)

plan.md Step 8 四场景待独立 QA 在 529 Room / dogfood 验:
1. G-B 全环:三段到 QA PASS + gate 开 → 注入 changes-requested respond → QA kickback → implement 被 wake 修 → QA 被 wake 复验 → PASS → 新 gate。
2. G-A:人为制造 wake 失败 → failClosed 报警 → 恢复 → Bridge 重启 → boot sweep 自动重试接通。
3. G-C:手动把 parked implement/qa 行翻 terminal(留活 tmux)→ 触发 spawn 兜底 → 不 spawn + 报警。
4. G-D:stale checkout 起测试 Bridge → WARN + event;分支 checkout → 无 WARN。

## 部署提醒(Lead 已认领,非本 issue 交付物)

887 + 939 都要求生产 Bridge 一次**带 git pull 的重启**才生效。

---

## 独立 QA 验证(本节,QA phase,同分支)

日期:2026-07-07。验证方式:代码对照 plan.md 逐条核实(非仅信 qa-report 自述)+ 全量/定
向单测重跑 + 三处真实(非 mock)行为验证 + CI/PR 状态核实。

### 1. 代码 vs plan.md 逐条核对

通读 `phase-orchestrator.ts` / `StateStore.ts` / `plugin.ts` / `Blueprint.ts` /
`runner-wake.ts` / `boot-sha-check.ts` 全部 diff(5cc36836..cc1406cd),逐条核对
plan.md Step 1-7 的 RED/GREEN 描述与实际实现一致:G-A(wake 失败不 patch
fixExecId/alertedAt、只在成功时 patch,replayable 语义正确)、G-A2(
`getStrandedImplementPhaseSessions` SQL 谓词 + `hasProgressedPastImplement` 的
fail-closed 语义)、G-B(`isFeedbackKickback` 五个条件 AND 全部命中 plan 矩阵,
approved_to_ship 无条件拒绝)、G-C(`ghostGuard` 只在 keepAliveEnabled 时生效、只
探最近 3 行、alive/indeterminate 两态才 fail-closed)、G-D(`classifyBootSha` 纯
函数 5 态收 4 类、显式 refspec fetch、8s timeout、全程 swallow)均与设计一致,未发
现代码与计划脱节之处。

### 2. 单元测试重跑(独立环境,非信任 implement 自报)

- **环境坑**:本机全量 `pnpm --filter flywheel-teamlead exec vitest run` 两次卡死在
  `fly574-bash-suites.test.ts` 之后(CPU 0%)。核实 `TMPDIR` 落在
  `~/.flywheel/runner-state/<execId>/browser-tmp` 下 —— 命中已知记忆
  `reference_qa_codex_lead_runtime_tmpdir_overlap`(codex-lead-runtime 安全校验拒绝
  workspace 与 `~/.flywheel` overlap)的姊妹问题;换用 scratchpad 目录做 TMPDIR 后,
  该批测试正常跑过,但套件在 `fly574-bash-suites`(真实 launchctl/plist 操作)处仍然
  挂起 —— 这与本 PR 的 diff 无关(该测试文件未被本 PR 触碰),且 **GitHub CI
  `Build & Test` 对本 PR head(cc1406cd)已绿**(`pnpm test:packages:run` 在 CI 环境
  跑完整套件,TMPDIR=/tmp 不 overlap)。判定:本机挂起是环境问题,非回归。
- 定向重跑本 PR 新增/改动的 8 个测试文件:全绿。
  ```
  boot-sha-check.test.ts                              14 tests ✓
  StateStore.fly939-stranded-implement.test.ts          3 tests ✓
  runner-wake-feedback-deferral.test.ts                 2 tests ✓
  phase-orchestrator.fly939-wake-not-respawn.test.ts   17 tests ✓
  phase-orchestrator.fly887-keepalive.test.ts          16 tests ✓（含新增 1 条,见下）
  phase-orchestrator.test.ts                           69 tests ✓
  phase-orchestrator.fly921-adversarial.test.ts         5 tests ✓
  event-route-fly859-three-stage-qa.test.ts             5 tests ✓
  ```
- `flywheel-edge-worker`(1077 tests)、`flywheel-config`(359 tests)全绿(含
  `Blueprint.fly939-kickback-prompt.test.ts` 4 条)。
- `pnpm -r build` 全绿;`pnpm lint` 干净(仅 2 处与本 PR 无关的既有 warning,exit 0)。

### 3. 补的测试覆盖缺口

plan.md Step 6 提到 G-C ghost guard 依赖 `getPhaseSessionsForIssue` 新加的
`rowid DESC` tiebreak(Codex design R1 #2),但既有测试全部走 fake
`listPhaseSessionRows`,**没有一条针对真实 StateStore 在 `last_activity_at` 相同时
`rowid DESC` 是否真的生效**。补了一条真实 sql.js DB 测试(非 mock):
`StateStore.fly887-keepalive.test.ts` 新增 "FLY-939: rowid DESC tiebreak orders
same-timestamp rows newest-inserted-first" —— 4 行相同 `last_activity_at` 写入,验
证返回顺序为插入倒序(r4,r3,r2,r1)。已跑绿,已提交本分支。

### 4. 真实(非 mock)行为验证 —— 单测把 tmux/git/DB 全部 fake 掉了,这里补真机验证

单测里 `effects.probeGhostTmux` / `deps.git` 全是 fake,只证明"编排逻辑对 fake 输入
反应正确",不证明"接到真 tmux/真 git 时管用"。做了三处针对生产代码路径(编译后
dist,非重新实现)的真实验证:

**(a) G-D boot-sha-check 真 git**(不是 fake exec,是真的对着仓库跑 `git fetch` /
`rev-parse` / `merge-base --is-ancestor`):
- 对本仓库当前 checkout(分支领先/发散于 origin/main)跑:只打印
  `running HEAD=...`,无 WARN —— `branch` 分类正确静音。
- 搭了一个真实的双仓库场景(`origin` 有 2 commit,`checkout` 落后 1 commit)跑
  `runBootShaCheck`:输出
  `[WARN] STALE CHECKOUT: running <old> but origin/main is <new> (1 commit ahead)`
  + `recordStaleEvent` 收到 `{headSha, originMainSha, aheadBy:1}` + `alertStale` 被
  调 —— G-D 的核心场景(FLY-887 那种"合并了但没生效"的复现)在真 git 上确认可用。

**(b) G-C ghost guard 真 tmux**(`probeRunnerProcessLiveness` 是复用的既有函数,
`probeGhostTmux` 只是新增的直连包装):起了一个真实 tmux session,验证三态:
- 活体 pane → `alive`
- 不存在的 window → `absent`
- `remain-on-exit on` + kill 掉 pane 进程(模拟 runner crash 后 tmux 窗口仍在的
  "尸体") → `dead_pin`
  三态与 `ghostGuard` 的判定逻辑(alive/indeterminate→拒绝、dead_pin/absent→放行)
  完全对应,确认这条防护在真机上是有效的,不是只在 fake 输入下"看起来对"。

**(c) G-A2/G-C 数据源真 DB**:`getStrandedImplementPhaseSessions` +
`getPhaseSessionsForIssue` 的新 SQL 已经在既有测试里用真实 `StateStore.create(":memory:")`(sql.js,生产同款引擎)跑过,非纯 mock;本节新增的 rowid tiebreak 测试同样用真实 DB。

### 5. PR / CI 状态核实

- `gh pr checks 482`:`Build & Test` pass(9m56s)。
- `gh pr view 482`:`mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`。
- PR body 的三条 test-plan checkbox(Codex code review / CI green / 独立 QA 四场景)
  均未勾选;CI green 已核实为真但 checkbox 未同步勾,这是文档卫生问题,不影响功能
  判定。**Codex code review 的状态未在 PR comments 中找到记录**(只有 Linear
  linkback 评论)—— 这是 code-review 阶段的职责,不在本 QA 验证范围内,但作为已知
  缺口如实记录,供 Lead 决定是否需要补跑。

### 6. 真机 529 QA Room 生命周期 E2E(Annie 选 (b):merge 前真跑一遍,2026-07-07 补做)

Lead 转达 Annie 的决定:不只信单测 + 定向真实行为片段,merge 前在 529 QA Room(guild
`1485787271192907816`,slot-2 `product-lead-test` 频道)把完整生命周期真跑一遍,像
FLY-907/921 那两次一样,模块驱动、发真 Discord thread。

新增 `scripts/qa-fly939-real-discord-wake-not-respawn-e2e.mjs`(与 FLY-921 那次
`qa-fly921-real-discord-turn-belt-e2e.mjs` 同一模式):直接 `import()`
`packages/teamlead/dist/bridge/phase-orchestrator.js` 里编译出的**真实生产
`PhaseOrchestrator` 类**(非 mock),对着一个真实 Discord thread 跑三个场景,精确对
应 Lead 转达的三条:

| 场景 | 覆盖 Gap | 真实驱动路径 | 结果 |
|---|---|---|---|
| ① QA-fail → 唤醒常驻 implement,不 respawn | G-B(founder-feedback kickback) | QA 段 `awaiting_review` 持有自己的 ship gate(已 PASS 过)、`hasGateResponse=true`(founder 已答 changes-requested)、重发 `qa-result fail` → 真实 `onQaResult` 判定 `isFeedbackKickback` → 真实 `grantTurn` 把 TURN 判给**常驻的** `impl-b` | 3/3 PASS |
| ② wake 失败 → fail-loud + 可重放 → 模拟重启后 reconcile 重放,这次成功 | G-A | 首次 `onQaResult` FAIL,wakePhaseRunner 返回 `{ok:false}` → 真实 `failClosed`→`alertLeadPipelineError` 报警,intent 不 patch fixExecId;用**同一个** `event_id`(`V-a1`)重放(等价于 `reconcileQaVerdicts` 在 boot 时重放同一条未消化事件),这次 wake 成功 | 4/4 PASS(fix round 记账真实复用同一轮,未重复计数) |
| ③ 重启 reconcile 想 respawn,真 tmux 探活发现旧窗口还活着 → 拒绝 respawn | G-C(ghost guard) | 真实起一个 tmux session(`fly939-qademo-ghost:implement`,`sleep 300`)代表重启前的 implement 窗口;`listPhaseSessionRows` 返回该行 DB 状态为 `completed`(旁路已翻终态)但 `tmux_session` 指向这个真窗口;`getAlivePhaseSession` 找不到活的 implement(模拟重启后追踪丢失)→ 兜底 spawn 前,真实 `probeGhostTmux` 直接对真 tmux 跑 `probeRunnerProcessLiveness` → 探到 `alive` | 2/2 PASS(真实 `startDispatcher.start` 全程未被调用;真实 `alertLeadPipelineError` 报警文案含 "LIVE tmux process" + "refusing to spawn a duplicate") |

**9/9 checks PASS。** 真实 Discord thread(可点开,narration + 生产代码自己发的
`alertLeadPipelineError`/`postIssueThread` 消息都在里面):
https://discord.com/channels/1485787271192907816/1493080993173737583/1523951414697787444

真实:`PhaseOrchestrator` 生产类、`probeRunnerProcessLiveness` 真 tmux 调用(场景③
起停了一个真实 tmux session,验证 alive→拒绝、kill 后 absent 的完整闭环)、Discord
真 fetch/真 bot token/真 thread。披露的边界(与 FLY-921 那次相同的取舍):
`wakePhaseRunner` 的**邮箱写入**(Agent Team 文件 inbox)没有起真 Claude/Codex runner
进程去消费——这一段是确定性 stub(按场景返回 `{ok:true}`/`{ok:false}`)。除此之外
(证据门槛判定 `isFeedbackKickback`、fix-round 记账、fail-loud/可重放语义、ghost-guard
真 tmux 探测、`grantTurn`、`alertLeadPipelineError`、`postIssueThread`)全部是真实生
产代码路径,不是重新实现的等价逻辑。

跑前发现并修正了一个**测试脚本自身的 bug**(不是被测代码的 bug):场景②③最初把 QA
session 的 `status` 设成了 `"awaiting_review"`,这会误触发 `onQaResult` 里"ship gate
in flight,拒绝"那条分支(该分支只应该在 QA 已经 PASS 过、持有自己的 ship gate 时生
效——那正是场景①的 kickback 前提,不是场景②③的"第一次 FAIL"前提)。改成 `"running"`
(QA 仍在跑、尚未持有 ship gate)后 9/9 全绿。这个坑本身就是"真机跑一遍"比单纯读代
码更有价值的例子——单测里对应的 fake session 默认就是 `"running"`,不会暴露这类因
为手搭场景状态搭错而产生的假失败。

### 7. 结论(最终,含真机 529 Room 三场景)

代码实现与 plan.md 逐条一致,单元测试(含新增的真实 DB tiebreak 测试)全绿,四处
真实(非 mock)行为验证(真 git / 真 tmux 状态机 / 真 DB / 真 Discord 三场景生命周
期)均确认生产代码路径按设计工作,CI 绿且 PR 可合并。**未发现功能性缺陷。**

plan.md Step 8 要求的"四场景"里,G-A/G-B/G-C 三条已经在本节的真机 529 Room 三场景
里覆盖(用模块驱动真实生产类的方式,而非搭一整套隔离三段式 Bridge + 真实 tmux
runner + 真实 Linear issue 的完整基础设施——那个量级的验证成本远高于本次改动的风
险等级,且 887+939 本身要求生产 Bridge 一次 pull+restart 才能真正激活,搭独立
Bridge 验证的是"能否复现同款机制",而不是"生产 Bridge 重启后确实生效",后者结构上
只能在部署后验证)。G-D(stale-checkout 分支/离线静音)已经在第 4 节用真实双仓库
git 场景验证过。四个 Gap(G-A/G-A2/G-B/G-C/G-D)在代码层面 + 真实行为层面均已覆盖。

**PASS。** 可以 ship。
