# FLY-939 QA-fail rework / 重启 reconcile 必须 wake 常驻 session — 探索

Issue: FLY-939 (https://linear.app/geoforge3d/issue/FLY-939/pipelinekeepalive887-qa-fail-rework-重启-reconcile-必须-wake-常驻-session绝不)
日期: 2026-07-07
基于: 无(本 issue 首个文档;上游背景 = engineering/doc/FLY-887-phase-session-keepalive/{exploration,research,plan,qa-report}.md)

## 1. Issue 原文的三条乱象(Annie 2026-07-07 观察)

1. **QA-fail → rework**:FLY-543 QA round-2 FAIL 后,pipeline 新 spawn 了 implement(a1b3d836),而不是 wake 原 parked 的 implement(5af30635,work 在 PR #480)。
2. **重启 reconcile**:Bridge 重启后又 spawn 一批 implement(648/907/921 各出现 2 个 implement runner = 重复)。
3. **QA 跑完就 complete**,而不是常驻等复验。

Issue 判断:「这正是 887 要治的,但 keepalive 没覆盖 rework/reconcile/复验 这些路径」。

## 2. 审计结论:三条乱象全部跑在 **pre-887 代码** 上(merged-but-never-deployed)

本 session 对生产 DB(`~/.flywheel/teamlead.db`)+ 生产进程 + git 历史做了独立审计,
**issue 的「keepalive 没覆盖这些路径」前提在代码层面不成立**——887 as-merged 恰好覆盖了这三条;
真正的直接根因是 **FLY-887(PR #458)merge 了但从未部署到运行中的 Bridge**:

### 2.1 部署链铁证

- 生产 Bridge 以 `tsx scripts/run-bridge.ts` **直跑 `~/Dev/flywheel` 的 TypeScript 源码**(非 dist),
  即运行代码 = 进程启动时该 checkout 的 HEAD。
- 生产 checkout HEAD = `4b18a1f4`(2026-07-05 22:41 PT);FLY-887 merge commit `27c90111`(PR #458)
  是 2026-07-06 **12:10 PT** 才进 origin/main。`git merge-base --is-ancestor 27c90111 4b18a1f4` → **NOT ancestor**。
- 生产 Bridge 进程(PID 35439)启动于 2026-07-06 **17:29 PT** ——在 #458 merge **之后**重启,
  但 checkout 没有 pull,重启加载的仍是 pre-887 源码。`~/.flywheel/deployed-sha` 同为 `4b18a1f4`。
- DB 时间戳为 UTC:所谓「00:30 的重启 reconcile」= 00:30 UTC 07-07 = **17:30 PT 07-06**,正是这次重启。

### 2.2 行为铁证(teamlead.db)

`session_events` 显示每个 implement 段在 `session_completed`(route=needs_review)的**同一秒**紧跟
`state_transition ×2 + lead_close_runner_finalized + lead_close_runner + worktree_cleanup_done`:

| exec | issue | 关闭时刻(UTC) | 含义 |
|---|---|---|---|
| 07b24369 | FLY-648 | 07-07 00:48:53 | implement→qa 交接时被 **close**(legacy close+respawn),非 park |
| e4a81150 | FLY-921 | 07-07 02:16:00 | 同上 |
| 5af30635 | FLY-543 | 07-07 02:02:41 | 同上 → 状态=completed,QA round-2 FAIL(02:12)时 wake 查询自然找不到活体 |

887 的 park 化交接下,implement 应停在 `awaiting_review` 且**不 close、不删 worktree**。
close+cleanup 是 keepalive OFF / pre-887 的 legacy 路径特征。

重启 reconcile 的重复 spawn(dup implement 全部诞生于重启后 30 秒内):

| dup exec | issue | started(UTC) | 结局 |
|---|---|---|---|
| 067c55a7 | FLY-648 | 00:30:08 | completed `no_code`(白跑) |
| 0e72e64d | FLY-921 | 00:30:14 | completed `no_code`(白跑) |
| fd08e901 | FLY-907 | 00:30:26 | completed `no_code`(白跑) |

pre-887 的 `reconcileOnStartup`(FLY-793 版)对 stranded `design_done` 盲目重放 handoff
(close design + spawn implement),不查已有活体。887 加的 `hasProgressedPastDesign`
(phase-orchestrator.ts:468-474:任一 implement/qa 活体存在或已有 ship-finalization claim → skip)
正是治这个的——当时 648/907/921 的 implement 都活着(running/awaiting_review),887 下会全部 skip。

FLY-543 round-2 FAIL(02:12:28 QA completed → 02:12:32 spawn a1b3d836):pre-887 的 legacy
`runFailFlow` = close QA + spawn Implement-fix。887 的 `runFailFlowKeepAlive`
(phase-orchestrator.ts:862-987)= wake 活体 parked implement + QA park 等复验——若已部署,
5af30635 会停在 awaiting_review 被 wake,QA 3befb08b 会 park 而非 completed。

### 2.3 结论

- **直接根因(占三条乱象的全部)= 部署缺口**:887 merged 12:10,Bridge 17:29 重启用了没 pull 的
  stale checkout。「restart ≠ deploy」;launchd KeepAlive 自动拉起也永远不会带来新代码。
- 但 Annie 的诉求(「所有重跑/复验路径必须 wake 常驻 session、绝不 respawn」)在 887 as-merged
  上仍有**真实残余缺口**(§3),这才是 FLY-939 的代码 scope。

## 3. 887 as-merged 的真实残余缺口(FLY-939 scope)

### G-A wake 失败 = 一次性,无人重试(静默 stall,FLY-934 ② 同型)

- `handoff`(phase-orchestrator.ts:1117-1137)与 `runFailFlowKeepAlive`(:930-950)在 wake 失败时
  只 `warn("... TURN set, held for reconcile")`——但**没有任何 reconcile 真的重试这个 wake**:
  - `runFailFlowKeepAlive` 在 wake 尝试后**无条件** `patchIntent({fixExecId})`(:939),而
    `onQaResult` 的重放恢复条件是 `!existing.fixExecId`(:622)→ wake 失败后 replay 永远短路,
    fix-loop 死在原地,QA parked、implement parked、无报警。
  - `reconcileOnStartup` 只重驱 stranded `design_done`;implement→qa 交接的 wake 失败、
    fix wake 失败都不在其视野。
- 修法方向:wake 失败要么 fail-closed 升级 Lead(与 assertPhaseWorktreeReady 同款),要么落一个
  可重试的 durable 标记 + 真正的 reconcile 消费者;`fixExecId` 只在 `woke.ok` 时 patch。

### G-B live-patch 复验没有路(QA PASS 之后的 founder feedback)

- 三段式 QA PASS 后,QA 段是 ship-gate holder(awaiting_review)。founder 在 approve gate 上
  提修改(changes-requested feedback)时:
  - wake 会按通用 APPROVE GATE 契约投给 gate 开启者 = **QA 段**,其 prompt 步骤 f
    (Blueprint.ts:1480)写的是「address it, push your fixes」——**让 QA 自己改代码,角色错位**
    (违反 Annie「implement 和 QA 必须是两个不同 session、runner 绝不测自己写的」铁律)。
  - 同时 `onQaResult` 把 `awaiting_review` 状态下的 FAIL 拒掉(:669-680「ship gate in flight」)
    → PASS 后管线**无法回到 fix-loop**。
- Annie 的「QA 常驻等 live-patch 复验」指向:feedback → **wake implement 修**(它活着、有全部
  context)→ push 新 head → **wake QA 复验** → QA 重开 gate。这条路今天不存在。

### G-C spawn 兜底没有「活体最后一道防线」(重复 runner 的结构性口子)

- wake 目标查询 `getAlivePhaseSession`(plugin.ts:4463-4475)只看 **DB 状态**
  (ALIVE = running/awaiting_review/approved_to_ship/design_done)。任何把 parked 行翻成
  terminal 的旁路(手动 DB 手术、崩溃窗口、未来新增的 reaper/evidence 路径)都会让下一次
  wake 查询 miss → 走 spawn 兜底 → **tmux 里活着的原 session 被晾着 + 重复 runner**
  ——正是 543 事故的形状(尽管 543 的翻转来自 pre-887 close)。
- 「绝不 respawn」的结构性保证:**spawn 兜底前必须做 tmux 活体探测**(复用
  `probeRunnerProcessLiveness` 四态):该 issue+role 若存在活进程窗口(即使 DB 行已 terminal)
  → fail-closed(alert Lead,不 spawn);确认无活体才允许 spawn。

### G-D 部署缺口的防复发(scope 待 Lead 拍)

- 纯 ops 纪律已有教训记录(「补装 config 后必须再重启一次 Bridge」),但本次是反向
  (「merge 后必须 pull+重启」)。最小代码位:Bridge 启动时 log 运行 HEAD sha,与
  `origin/main` 不一致时打一条 WARN(或 alert channel 一条)——让「stale checkout 重启」
  变得可见。重量级方案(自动 pull、版本 gate)不建议(动生产部署面,归 FLY-913/ops line)。

## 4. 边界(与相邻 issue 的切分)

- **FLY-921(turn-belt,PR #478)**:不动。它修 QA 相位抢跑 + turn-belt 死 holder。
- **FLY-934**:① 交接没触发 → 归 921 域;② 检测盲区(无 live session 的 stall 检测)→ 归
  FLY-778;③ operator 干净恢复操作 → 归 934 本体。FLY-939 不做检测器、不做恢复命令;
  但 G-A(wake 失败可重试/可报警)天然减少 934 ③ 需要人工救的场景。
- **auto-QA(FLY-579 issue 流)/ 单 session 路径**:byte-compat,不碰。
- kill-switch 沿用 `FLYWHEEL_THREE_STAGE_KEEPALIVE`(不新增开关;G-C 探测挂在 spawn 兜底
  路径内,keepalive OFF 时行为不变)。

## 5. 方案雏形(供 brainstorm gate 确认)

1. **G-A**:`runFailFlowKeepAlive` 仅在 `woke.ok` 时 patch `fixExecId`;wake 失败 →
   fail-closed 升级 Lead(复用 `failClosed`,一次性报警,不静默)。`handoff` wake 失败同款。
   (方向 B 备选:durable retry 标记 + reconcile 消费者——更重,首选报警式 fail-closed,
   与 887 全篇 fail-closed 哲学一致;人是最后的 reconciler。)
2. **G-B**:三段式 QA 段的 APPROVE GATE feedback 契约改写(prompt)+ Bridge 侧新路由:
   feedback 到 QA 段时,orchestrator wake implement(kind:'fix',带 feedback 摘要)→
   implement 修完 needs_review → 既有 handoff 唤 QA 复验 → QA 重跑场景 + 重开 gate。
   `onQaResult` 的「ship gate in flight」守卫对**新 round 的 FAIL**放行(gate 已被 feedback
   作废时),精确条件在 research 定。
3. **G-C**:spawn 兜底(handoff spawn / QA-FAIL spawn / reconcile spawn)统一前置
   「同 issue+role 活进程探测」:探到活体 → 不 spawn + alert;`indeterminate` → fail-closed。
4. **G-D**:启动 sha 可见性 WARN(一行日志 + alert),不做自动 pull。

## 6. 未决问题(带进 gate)

- G-D 是否收进本 issue(最小 WARN 版)还是完全归 ops/913 line?
- G-B 的 feedback 路由:Bridge 怎么识别「这个 wake 是 changes-requested」——直接挂在
  approve-gate respond 路径(respond.ts / GatePoller)还是靠 QA prompt 契约让 QA 自己转发
  (QA 收到 feedback → 发 qa-result fail 形态的 kickback)?倾向后者(零新事件类型,
  改 prompt + 放宽 onQaResult 守卫),research 阶段定。
- 887 部署本身(pull + 重启)不是本 issue 交付物,但必须在 report 里向 Lead 点名,
  否则 939 修完照样跑不到。
