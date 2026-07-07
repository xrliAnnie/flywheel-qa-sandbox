# FLY-939 wake-not-respawn — 调研

Issue: FLY-939 (https://linear.app/geoforge3d/issue/FLY-939/pipelinekeepalive887-qa-fail-rework-重启-reconcile-必须-wake-常驻-session绝不)
日期: 2026-07-07
基于: exploration.md(审计结论:三条乱象 = 887 merged-but-not-deployed;939 代码 scope = G-A/B/C/D,brainstorm gate 已批)

## 0. 基线与前提

- 基线代码 = origin/main `2741c119`(含 FLY-887 R1+R2 全部 keepalive 机制)。
- **并行风险**:PR #478(FLY-921 turn-belt,OPEN、在 ship gate)触碰 `phase-orchestrator.ts` /
  `plugin.ts` / `event-route.ts` / `flywheel-comm/db.ts`——与本 issue 的 G-A/G-C 改动点同文件。
  Implement 段开工前**必须先看 #478 是否已 merge**;已 merge → merge origin/main 后再动工
  (镜像 887 R2 Step 1 的两侧语义保全);未 merge → 照常开工,但 plan 记录 ship 时可能要 rebase。
- 生效前提:本修 + 887 都要求生产 Bridge 做一次**带 git pull 的重启**(Lead 已认领安排)。

## 1. G-A:wake 失败 = 一次性(代码证据与修点)

### 1.1 fix-loop wake 失败永久短路

`phase-orchestrator.ts` `runFailFlowKeepAlive`(:930-950):

```
const woke = await this.deps.effects.wakePhaseRunner({...kind:'fix'...});
this.deps.qaVerdicts.patchIntent(execId, { fixExecId: impl.execution_id });  // ← 无条件
if (woke.ok) { log } else { warn "... TURN set, held for reconcile" }        // ← 只 warn
```

而 `onQaResult` 的重放恢复条件(:619-637)是 `existing.status==='fail' && !existing.fixExecId
&& !existing.alertedAt` → **fixExecId 已被 patch,任何重放(同 verdict 重放、boot 的
reconcileQaVerdicts sweep)都短路**。"held for reconcile" 是一句空话——没有任何 reconcile
消费者会重试这个 wake。结果:QA parked、implement parked、TURN 指向 implement、零报警、
管线静默停摆(FLY-934 ② 同型,但连"死 session"都没有,更隐蔽)。

### 1.2 handoff wake 失败同款

`handoff`(:1117-1137):TURN 先记 → `wakePhaseRunner({kind:'retest'})` 失败 → 只
`warn("... held for reconcile")`。`reconcileOnStartup`(:407-448)只重驱 stranded
`design_done`;implement→qa 的 retest wake 失败没有任何 boot 重驱(该 session_completed
事件已被处理,complete-marker 已 drain,不会重放)。

### 1.3 修法(设计定案)

fail-loud + 保留可重放性,与 887 全篇 fail-closed 哲学一致(人是最后的 reconciler):

- `runFailFlowKeepAlive`:`fixExecId` **仅在 `woke.ok` 时 patch**;`!woke.ok` →
  `failClosed(impl, ...)`(升级 Lead)且**不 patch fixExecId、不 patch alertedAt**——
  intent 保持「fail + 无 fixExecId + 无 alertedAt」形态,boot 的 `reconcileQaVerdicts`
  重放 latest qa_result → `onQaResult` 恢复条件命中 → 整条 fix 流(记账 insert-or-read
  恢复原轮次、assertPhaseWorktreeReady、grantTurn 幂等覆盖、wake)天然重试。
- `handoff`:`!woke.ok` → 由 `warn` 升级为 `failClosed(prev, ...)`(alert Lead)。
  boot 重驱补口:见 G-A2。
- 语义注意:failClosed 每次触发都会报警;重启风暴下同一故障可能多次报警——可接受
  (loud beats silent stall),不做去重(报警聚合归 FLY-368 域)。

### 1.4 G-A2:boot 重驱扩到 stranded implement→qa 交接

`reconcileOnStartup` 现只查 `listStrandedDesignPhases()`(role='design' AND
status='design_done')。对称补:**stranded implement**(role='implement' AND
status='awaiting_review' AND 该 issue 无任何 qa 段 session 行 AND 无 ship-finalization
claim)→ 重放 `onPhaseComplete(implementSession)` → 走既有 handoff wake-or-spawn。

- 守卫必须收窄到「该 issue **零** qa 行」:qa 行存在(无论 alive/terminal)即说明交接
  fired 过,不重放(terminal QA 的 stranded-pass 已有 checkStrandedPass 报警;alive QA
  说明管线活着)。这镜像 `hasProgressedPastDesign` 的「只补从未 fired 的交接」哲学。
- StateStore 新查询 `getStrandedImplementPhaseSessions()`(或复用
  `getPhaseSessionsForIssue` 在 plugin 侧过滤;实现取简)。
- 注意与「implement@awaiting_review 是正常态」的区分:正常态下 QA 行必然已存在
  (handoff 在 implement complete 事件里同步 spawn/wake QA)——零 qa 行 + awaiting_review
  只可能是 crash/wake-fail 残骸。onPhaseComplete 的 HANDOFF_STATUS 门(implement 边界
  = awaiting_review)保证重放安全幂等。

## 2. G-B:QA PASS 后 founder feedback 无路回 fix-loop

### 2.1 现状机制

- 三段式 QA PASS 后按 prompt(Blueprint.ts:1011)自己走 APPROVE GATE 流:
  `gate approve_to_ship --no-block` + `complete --route needs_review` → QA 段停
  `awaiting_review` = ship-gate holder。
- founder/Lead 在 gate 上回 changes-requested → `respond.ts` 走
  `wakeNoBlockGateRunnerBestEffort`(:119,137)直写 **QA 段** mailbox,文本为通用
  feedback 措辞(runner-wake.ts:84-89 同款语义):「address the feedback, push your
  fixes, re-request review」——**指挥 QA 自己改代码**,违反「implement 与 QA 必须两个
  session、绝不自测自写」铁律(Annie 2026-07-06 拍板,见 887 plan.md R2 resume 注记)。
- 同时 `onQaResult`(:669-680)把 `awaiting_review`/`approved_to_ship` 状态下的 FAIL
  一律拒掉(「ship gate in flight」)→ 即使 QA 想 kickback 也进不了 fix-loop。

### 2.2 设计(gate 已批:QA-prompt 契约转发,零新 Bridge 路由/零新事件类型)

**QA prompt 契约**(Blueprint 三段 QA 块,PASS/gate 段追加):

> If you are woken with FEEDBACK (changes requested — NOT an approval) on your
> approve_to_ship gate: do NOT edit code yourself — you are the verifier, the
> implement phase (alive, parked, full context) does the fixing. Instead emit a
> kickback verdict: `qa-result --status fail --summary "founder feedback kickback:
> <feedback 摘要>"`, then park again and WAIT for the RE-TEST wake (identical to the
> FAIL path in step 5). The pipeline wakes the implementer to fix, then wakes you to
> re-verify; on PASS you re-open a NEW approve gate (step 4 — fresh gate --no-block +
> fresh complete --route needs_review; the review window resets, exactly like the
> single-session re-request flow).

**Bridge 侧守卫放行**(`onQaResult` :669-680 的精确放宽):

- 现条件:`status==='fail' && (session.status==='awaiting_review' || 'approved_to_ship')` → 拒。
- 新条件:`awaiting_review` 且**绑定的 review question 已有 response**(gate 已被回答,
  不再 pending)→ **放行**(这就是 kickback 场景:feedback 即 response);question 仍
  pending / 无绑定 / `approved_to_ship` → 照旧拒(verified approval 已消费后绝不 kickback)。
- 判定数据源:session.review_question_id(StateStore 列)+ 该项目 CommDB
  `getResponse(questionId)`(db.ts:342,已有 API)。经 deps 注入
  (`qaVerdicts.hasGateResponse(session): boolean` 之类的薄 closure,plugin.ts 接线),
  orchestrator 保持可单测。
- `review_question_id === 'unbound'` sentinel / 缺失 → 拒(现行为,防御性)。
- 边界:response 是**真 approval** 但 QA 误发 kickback → 放行也安全:fix-loop 只是让
  implement 重推新 head + QA 重开新 gate,verify-approval 的 pr_head_sha 绑定使旧
  approval 自然作废,绝不会误 ship。

**通用文案冲突治理**(Codex design R1 #1):仅追加 kickback 段不够——通用 APPROVE GATE
块步骤 f(Blueprint.ts:1480)与 runner-wake.ts:84-89 的 feedback wake 文本都仍指挥收信者
「push your fixes」,且 QA PASS 后 QA 正是 TURN holder,turn 自查挡不住它。故:三段 QA
keepalive 变体里步骤 f 被替换/紧跟显式 override(「For THIS role, FEEDBACK = kickback;
never edit code yourself」),runner-wake.ts feedback 文本追加角色中立 deferral 句
(role prompt 定义了别的 feedback 协议则以 role prompt 为准),单 session 语义不变。

**轮次记账**:kickback FAIL 走既有 `runFailFlowKeepAlive` → `recordFixRound` 同一账本、
同 cap(maxFixRounds=3)。founder 反馈轮占用 QA-fail 轮次是**接受的取舍**(cap 到顶 =
refuse 升级 Lead,人接手;不为 feedback 开独立账本)。

**PASS 后重开 gate 的 FSM 兼容**:QA 段已在 `awaiting_review`,复验 PASS 后再跑
`complete --route needs_review` 是 FLY-191 生产已验的 re-request 形态(单 session 步骤 f
同款),无新 FSM 边。

## 3. G-C:spawn 兜底前的活体探测(「绝不 respawn」结构性保证)

### 3.1 现状

wake 目标查询 `getAlivePhaseSession`(plugin.ts:4463-4475)只看 DB 状态
(ALIVE = running/awaiting_review/approved_to_ship/design_done)。parked 行被任何旁路翻成
terminal(手动 DB 手术、崩溃窗口、未来 reaper)后,下一次 wake 查询 miss →
`handoff`(:1140+)/ `runFailFlowKeepAlive`(:955-987)直接 `startDispatcher.start` 兜底
spawn → tmux 里活着的原 session 被晾着 + 重复 runner + 共享 worktree 出现第二个 writer。

### 3.2 设计

三段式 keepalive 分支内的**每个 spawn 兜底点**(handoff spawn、QA-FAIL fix spawn;
reconcile 走 handoff 天然被盖)前置「幽灵活体探测」:

- 新 deps 查询 `listPhaseSessionRows(issueId, phase)`:该 issue+role 的**全部** session 行
  (不过滤状态;StateStore `getPhaseSessionsForIssue` 已返回全 status,plugin 侧按
  chat_thread_role 过滤即可——与 getAlivePhaseSession 同源,少一个 ALIVE 过滤)。
- 对其中有 `tmux_session` 的行(新→旧,排序 last_activity_at DESC + rowid DESC tiebreak)
  逐个 **新独立 effect `probeGhostTmux(row)`**:直接以持久化的 `row.tmux_session` 调
  `probeRunnerProcessLiveness`。**不能复用现 `probePhaseAlive`**(Codex design R1 #2):
  它走 CommDB `getTmuxTargetFromCommDb`(plugin.ts:4329-4335),CommDB 注册被清/未修复时
  返回 absent——恰好漏掉「StateStore 行 terminal 但 tmux 窗口活着」的污染形状。四态语义同:
  - 任一 `alive` → **fail-closed**:`failClosed(row, "terminal-status session still has a
    live tmux process — refusing to spawn a duplicate <phase>; operator must reconcile")`,
    不 spawn,return。
  - 任一 `indeterminate` → 同样 fail-closed(探测不明绝不 spawn——宁可停下报警)。
  - 全部 `dead_pin`/`absent`(或无行/无 tmux_session)→ 放行 spawn(现行为)。
- 探测上限:只探最近 N=3 行(防古老行堆积拖慢;老行的窗口早被 close-clean 收走,
  absent 极快)。
- kill-switch:探测只存在于 keepalive 分支内;`FLYWHEEL_THREE_STAGE_KEEPALIVE=0` →
  legacy 路径逐字不变(byte-compat 哨兵)。

### 3.3 为什么不做「探到活体就 re-adopt/wake」

探到「DB 说 terminal、tmux 说活着」= 状态污染(某个旁路违约翻了行,或人工手术)。此时
自动 re-adopt 需要凭空重建 FSM 状态(从 terminal 回 awaiting_review 的边不存在,伪造它
会打穿 FLY-228 terminal-immunity 的语义)。这超出 939 的「绝不 respawn」目标——探测 +
fail-closed 报警把「重复 runner + 争用」变成「零重复 + 一条报警」,operator 干净恢复
归 FLY-934 ③。

## 4. G-D:启动 sha 可见性 WARN

### 4.1 场景还原

生产 Bridge 用 tsx 直跑 checkout 源码;launchd KeepAlive / 人工重启都不 pull。本次:
merge 12:10 → 17:29 重启加载 stale checkout(4b18a1f4)→ 887 从未生效,且无任何信号。

### 4.2 设计

Bridge 启动序列(plugin.ts boot 段,连同其它 boot 日志)加一次性 best-effort 检查:

1. `git -C <projectRoot> rev-parse HEAD` → 启动日志必打一行
   `[bridge-boot] running HEAD=<sha> (<subject>)`(无条件,让每次重启都留下运行版本的证据)。
2. best-effort `git -C <projectRoot> fetch --quiet origin +refs/heads/main:refs/remotes/origin/main`
   (timeout ~8s;失败/离线 → log 一行 skip,不再比对——**stale 的本地 origin/main ref 会
   产生假阴性,必须 fetch 后才比**)。显式 remote-tracking refspec 是 Codex design R1 #3
   要求:裸 `git fetch origin main` 在部分配置下只刷 FETCH_HEAD、不刷
   refs/remotes/origin/main,后续 rev-parse 读旧 ref 仍假阴性。
3. `git rev-parse origin/main`;若 HEAD ≠ origin/main 且 HEAD 是 origin/main 的祖先
   (`merge-base --is-ancestor HEAD origin/main`)→
   `console.warn("[bridge-boot] STALE CHECKOUT: running <headSha> but origin/main is
   <mainSha> (N commits ahead) — merged work is NOT live; pull + restart to deploy")`
   + 一条 durable StateStore event(`bridge_boot_stale_checkout`)+ best-effort
   LeadAlertNotifier 报警一条。HEAD 不是祖先(本地领先/分叉,如 dev 环境跑分支)→
   只 log 不 WARN(避免对 worktree/QA slot Bridge 误报)。
4. 全程 try/catch 包裹:任何 git 失败绝不影响 Bridge 启动(纯可观测性)。
5. 新 env `FLYWHEEL_BOOT_SHA_CHECK=0` 旁路(默认 ON;登记 feature-flags registry ——
   FLY-871 教训:新 env 必登记)。QA slot / worktree Bridge 通常跑分支 → 非祖先规则
   已天然静音,env 是双保险。

## 5. 测试面(汇总,细化在 plan)

- G-A:fake deps 单测——wake 失败不 patch fixExecId + failClosed 被调;boot 重放
  (reconcileQaVerdicts 路径)在 wake-fail 后能重驱并恢复原轮次;wake 成功路径逐字不变
  (哨兵);handoff wake 失败 → failClosed。
- G-A2:stranded implement(awaiting_review + 零 qa 行)→ 重放 handoff;有 qa 行
  (alive 或 terminal)→ skip;有 ship claim → skip;design 路径行为不变(哨兵)。
- G-B:守卫矩阵——awaiting_review+question answered → FAIL 放行进 runFailFlow;
  question pending → 拒;unbound/缺失 → 拒;approved_to_ship → 拒;QA prompt 快照断言
  kickback 契约文案(含「do NOT edit code yourself」);keepalive OFF prompt 不变(哨兵)。
- G-C:spawn 兜底矩阵——terminal 行 probe alive → 不 spawn + failClosed;indeterminate →
  不 spawn;dead_pin/absent/无行 → spawn(现行参数逐字);只探最近 3 行;keepalive OFF
  → 无探测(哨兵)。
- G-D:纯函数抽取(比对逻辑)单测:same/behind/ahead/diverged/fetch-fail 五态;
  env=0 旁路;git 全挂不炸 boot。registry 哨兵测试(新 env 已登记)。
- byte-compat:单 session / auto-QA / keepalive OFF 全路径逐字(prompt 快照 + dispatch
  参数哨兵),沿用 887 测试套的既有哨兵基建。

## 6. 改动面预估

| 文件 | 改动 |
|---|---|
| packages/teamlead/src/bridge/phase-orchestrator.ts | G-A(两处 wake-fail 分支)+ G-A2(reconcile 扩展)+ G-B 守卫 + G-C 探测;deps 接口 +2(hasGateResponse / listPhaseSessionRows)+1(listStrandedImplementPhases) |
| packages/teamlead/src/bridge/plugin.ts | 新 deps 接线(CommDB getResponse closure、全行查询、stranded implement 查询、boot sha 检查调用) |
| packages/teamlead/src/StateStore.ts | `getStrandedImplementPhaseSessions()`(一条 SQL) |
| packages/edge-worker/src/Blueprint.ts | 三段 QA prompt kickback 契约段 |
| packages/config/src/feature-flags/registry.ts | `FLYWHEEL_BOOT_SHA_CHECK` 登记 |
| 新 boot-sha 模块(teamlead/src/bridge/boot-sha-check.ts) | G-D 纯函数 + effect |
| 测试 | 上述 §5 全部 |

不碰:FLY-921 turn-belt 语义、auto-QA、单 session、WorktreeManager、FSM 边、
verify-approval/merge authority、检测器(778)、operator 恢复(934)。
