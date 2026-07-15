# FLY-921 三段式相位误推进 + turn-belt stale-holder 恢复 — 实施计划

Issue: FLY-921 (https://linear.app/geoforge3d/issue/FLY-921/bugpipeline-三段式流水线qa-相位抢先跑-turn-belt-死-holder-不释放锁-qa-边角覆盖补强)
日期: 2026-07-06
基于: research.md
版本: r2(Codex design review R1 六项修订,见 §9)

## 0. 总览

四个 fix + 对抗测试,全部 TDD(先红后绿)。改动面:

| Fix | 包 | 文件 |
|---|---|---|
| A sessionId 校验 | core / edge-worker / claude-runner | `core/src/hook-callback-types.ts`、`HookCallbackServer.ts`、`TmuxAdapter.ts` |
| B 相位推进证据闸 | teamlead | `bridge/phase-orchestrator.ts`(+接线点传字段) |
| C turn-belt reconcile | teamlead / flywheel-comm | `bridge/phase-orchestrator.ts`、`bridge/plugin.ts`、`bridge/event-route.ts`、`DirectEventSink.ts`、`flywheel-comm/src/db.ts` |
| D fallback 不数 ledger commit | edge-worker | `decision/FallbackHeuristic.ts` |

不动:FLY-918 release 结构、Blueprint prompt 协议文本、`turn` CLI(保持只读)、单会话流水线路径(仅 A/D 的 bug-fix 语义变化,见 research §3)。默认无新 env 开关 —— A/B/C/D 都是修 bug 而非新特性;若 Codex design review 要求逃生口,再加 `FLYWHEEL_PHASE_EVIDENCE_GATE=0`(仅 Fix B)一个。

## 1. Fix A — completion callback 校验 sessionId

### chunk A1(测试先行)
`packages/edge-worker/src/__tests__/HookCallbackServer.test.ts`(补):
- `waitForCompletion(token, ms, expectedSessionId)`:POST 携带同 token 但**不同** sessionId → promise 不 settle;随后 POST 匹配的 sessionId → settle 且返回该 event。
- 不传 expectedSessionId → 现行为逐字节不变(任意 sessionId 都 settle)。
- 不匹配时产生一条 warn 日志(spy console.warn,内容含 expected/got 两个 id)。

### chunk A2(实现)
- `packages/core/src/hook-callback-types.ts`:`IHookCallbackServer.waitForCompletion(callbackToken, timeoutMs, expectedSessionId?: string)` 接口加可选第三参(TmuxAdapter 依赖的是 core 接口,不是 edge-worker 具体类 —— Codex R1 #3)。
- `HookCallbackServer.waitForEvent(token, eventType, timeoutMs, expectedSessionId?: string)`:`onHook` 增加 `expectedSessionId === undefined || event.sessionId === expectedSessionId` 条件;不匹配分支 `console.warn("[HookCallbackServer] ignoring hook event: sessionId mismatch (expected=… got=… token=…)")` 并继续等待。`waitForCompletion` 透传。
- claude-runner 路径加编译/测试断言,确保跨包签名一致。

### chunk A3(TmuxAdapter 接入 + 测试)
`TmuxAdapter.waitForCompletion` 调 `this.hookServer.waitForCompletion(callbackToken, hardTimeoutMs, claudeSessionId)`。
`packages/claude-runner/test/TmuxAdapter.test.ts`(补):模拟嵌套会话 callback(同 token 异 sessionId)→ 不 settle;随后 pane_dead → settle。既有 79 测全绿(claude 路径字节兼容红线,参照 FLY-493 先例)。

## 2. Fix B — implement→QA handoff 证据闸

**证据定义(Codex R1 #1 修订)**:真 runner 驱动的完成证据 = `review_question_id` 在场且 ≠ REVIEW_BINDING_UNBOUND(`"unbound"`)。**不要求 `pr_number`** —— 源码核实:`complete.ts` 对 needs_review 不强制 `--pr`,且 `collectEvidence` 只在 pr_handoff/`--merged` 路径写 `landingStatus.prNumber`,即正常 `complete --route needs_review --pr N --question-id Q` 也可能不落 `sessions.pr_number`;拿它当必要条件会误伤合法 happy path。`review_question_id` 单独已是充分判别子:合成完成(FallbackHeuristic / decision_error_fallback)不可能带 questionId;runner 忘带 `--question-id` 时 Bridge 落 `"unbound"` 哨兵且 verify-approval 本来就拒绝它 —— 此时不拉 QA + 告警 Lead 恰是正确行为。不采纳「complete.ts 对 needs_review 强制 --pr」的替代方案:那会扩大到单会话流水线协议面,超出本 bug 的最小修复范围(若未来需要,单独立项)。

### chunk B1(测试先行)
`packages/teamlead/src/__tests__/phase-orchestrator.test.ts`(补,沿用现有 deps-mock 形状):
- implement@awaiting_review 且 `review_question_id` 空 → 不调 startDispatcher/grantTurn/wake;`alertLeadPipelineError` 收到 reason 含 "without runner-driven review evidence";`refreshPhaseStatusLine` 被调。
- `review_question_id = "unbound"`(REVIEW_BINDING_UNBOUND)→ 同上 fail-closed。
- `review_question_id` 为真实 qid 但 `pr_number` 空 → **handoff 照旧**(pr_number 非必要条件的反证用例,钉死 Codex R1 #1)。
- 证据齐备 → handoff 照旧(keep-alive ON 走 wake-or-spawn、OFF 走 close-and-respawn,两组用例)。
- design@design_done 边界**不受**证据闸影响(照旧 handoff)—— 钉死「合成产不出 design_done」的边界假设。
- 三段式 disabled + implement@awaiting_review + 证据缺失 → 仍走 FLY-902 的 disabled-warn(不发证据闸告警)—— 钉死 §B2 的判定顺序(Codex R1 #6)。
- `reconcileOnStartup` 重放一个证据缺失的 implement@awaiting_review → 同样 fail-closed(复用 onPhaseComplete 天然覆盖,用例证明)。

### chunk B2(实现)
`phase-orchestrator.ts`:
- `PhaseSession` 接口不需要新字段(`review_question_id` 已有;pr_number 不再是条件)。
- 判定顺序(Codex R1 #6 修订):**边界 → policy(FLY-902 disabled-warn 原语义保留)→ 证据闸 → handoff**。即在 `policy.enabled` 通过之后、`nextPhase` 之前插入:

```ts
if (phase === "implement" && !hasRunnerDrivenReviewEvidence(session)) {
    await this.failClosed(session, `implement reached awaiting_review WITHOUT runner-driven review evidence (review_question_id=${session.review_question_id ?? "absent"}) — synthesized completion suspected (nested-session callback / early process death / kill); QA NOT started. Lead can re-drive after verifying the implement session.`);
    await this.deps.refreshPhaseStatusLine(session.issue_id);
    return;
}
```

- `hasRunnerDrivenReviewEvidence(s)`:`s.review_question_id` 在场且 ≠ REVIEW_BINDING_UNBOUND。
- 两个接线点(`DirectEventSink.ts:744`、`event-route.ts:2199`)确认传入的 session 快照含 `review_question_id`(来自 StateStore 行)。

## 3. Fix C — turn-belt stale-holder reconcile

### chunk C1(CommDB listTurns,测试先行)
`packages/flywheel-comm/src/__tests__/three-stage-turn.test.ts`(补):`CommDB.listTurns()` 返回该 DB 全部行;readonly 打开且表不存在 → 返回 `[]` 不抛(语义照抄 `getTurn`)。实现于 `db.ts`。

**项目归属契约(Codex R1 #5 修订)**:`three_stage_turn` 是 per-project CommDB 的表,行内没有 projectName。orchestrator 层的 dep 定义为返回**项目限定**的行:`listTurns(): { projectName: string; turn: ThreeStageTurn }[]` —— `plugin.ts` 遍历已配置项目、逐项目开 CommDB 调底层 `listTurns()` 后拼装;orchestrator 绝不接触无项目归属的 turn 行,`grantTurn`/`deleteTurn` 恢复动作全部带 projectName 回到正确的 CommDB。

### chunk C2(orchestrator 判定/恢复,测试先行)
`phase-orchestrator.test.ts`(补)。新增 deps(plugin.ts 注入):`listTurns()`(项目限定,见 C1)、`getTurn(issueId, projectName)`(单 issue 读,供 C3 守卫 1 的 holder 比对 —— Codex R3 non-blocking #2:守卫必须显式走 scoped 读,不得在成功 handoff 后误跑完整 stale 矩阵)、`deleteTurn(issueId, projectName)`、`getSessionForTurnHolder(execId)`(薄封装 StateStore.getSession → {status, …});探针复用既有 `probePhaseAlive`。新方法 `reconcileTurnBelt(scope?: { issueId: string; projectName: string; terminalExecId?: string })`:

stale 判定矩阵(每格一个用例):

| holder 会话 | 动作 |
|---|---|
| 不存在 / status ∈ {completed, failed} | stale → 恢复 |
| 非终态 + probe alive | 健康,跳过 |
| 非终态 + probe dead_pin/absent | stale → 恢复 |
| 非终态 + probe indeterminate | fail-closed 跳过(不告警) |

恢复目标选择(Codex R1 #2 修订 —— **不得**直接复用 status-only 的 `getAlivePhaseSession`,否则非终态的死 holder 自己会被再选中,epoch 自增而 TURN 仍指死 exec):
- 候选 = 该 issue 的相位会话(`getPhaseSessionsForIssue` 形态),按 qa → implement → design 优先级,**排除 stale holder 的 exec_id**,只留非终态行。
- 对每个候选**逐个 probe 真实 liveness**:`alive` → `grantTurn`(epoch 自增)+ `alertLeadPipelineError` 一次(old holder/epoch → new holder/epoch,写明 stale 原因),结束;`dead_pin`/`absent` → 跳过看下一个;`indeterminate` → fail-closed:本 issue 本轮**不动 TURN**、不告警(下轮再看 —— 绝不在候选活性未知时改变归属)。
- 候选耗尽且无 indeterminate 拦截 → `deleteTurn` + 告警(文案:TURN released;后续 spawn 由 pre-launch seam 重建)。
- 幂等:恢复后再跑一遍 reconcile → 无动作、无二次告警(新 holder alive)。
- 回归钉子用例(Codex R1 #2 场景):holder=QA 非终态(awaiting_review)+ probe absent,同一 QA 行若不排除会被 status-only 选择器选中 → 断言 TURN 落到 probed-alive 的 design,绝不回到 QA 自己。

### chunk C3(触发位点接线)

**spawn 竞态守卫(Codex R2 #1 修订)**:`RunDispatcher.start()` 在 launch 前预授 TURN 后立即返回,而 `session_started` 行是 fire-and-forget(`Blueprint.ts` emitStarted `.catch(()=>{})`)—— handoff 刚 spawn 的下一相位,其 TURN holder 在 StateStore 里可能**暂时查无此行**。若 reconcile 把「holder 无会话行」直接判 stale,会把刚授出的 TURN 抢回来,破坏 FLY-887 的 pre-launch happens-before。两层守卫:

1. **事件位点按 holder 限定**:事件驱动的 reconcile 只在 `getTurn(issueId).holder_exec_id === 刚终态的那个会话的 execution_id` 时才做 stale 判定 —— 目标只有一个:「死的就是 holder 本人」的 FLY-543 形态。handoff 已把 TURN 移交给新 QA 的场合,holder ≠ 终态 exec → 无操作,竞态窗口不存在。
2. **启动位点 granted_at 宽限**:startup 全表扫里,「holder 会话行缺失」且 `turn.granted_at` 距今 < 宽限窗(常量 `TURN_GRANT_GRACE_MS = 5 min`)→ 视同 indeterminate 跳过(boot-drain 重放可能刚 spawn 过下一相位,session 行在途)。granted_at 超窗且行缺失 → 真 remnant(dispatch 与 Bridge 一起死了),照 stale 恢复。

- **启动**:`plugin.ts` 在 `phaseOrchestrator.reconcileOnStartup()` 之后 `await reconcileTurnBelt()`(全项目全表,带守卫 2)。
- **事件驱动 · session_completed**:两个 onPhaseComplete 接线点(`DirectEventSink.ts:744`、`event-route.ts:2207`)之后,当会话是三段式 phase 时顺带 `reconcileTurnBelt({ issueId, projectName, terminalExecId })`(单 issue,带守卫 1)。
- **事件驱动 · session_failed(Codex R1 #4 修订 —— 现网 failed 路径不经过 onPhaseComplete,必须显式新接)**:`DirectEventSink.emitFailed()` 持久化 failed 之后,以及 `event-route.ts` 的 session_failed 分支持久化之后,各加一次同样的单 issue `reconcileTurnBelt` 调用(仅三段式 phase 会话,带守卫 1)。两个 surface 各配一条测试,防止两侧漂移。
- 零新周期 timer。
- 集成用例:模拟 FLY-543 —— QA holder 会话置 failed(kill 后形态)→ failed 事件位点触发 → TURN 落到 parked-alive design,`turnStatus(design)` = yours。
- 竞态回归钉子(Codex R2 #1 场景):implement 完成 → handoff spawn QA(TURN 已授 QA、session_started 未落库)→ 紧随的事件位点 reconcile **不得**移动/删除 QA 的 TURN(守卫 1:holder=QA ≠ 终态 exec=implement → 无操作);startup 场景:holder 行缺失 + granted_at 刚刚 → 跳过;granted_at 超窗 → 恢复。

## 4. Fix D — FallbackHeuristic 不数 ledger commit

### chunk D1(测试先行)
`packages/edge-worker/src/__tests__/FallbackHeuristic.test.ts`(补):
- commitMessages 全部匹配 `/^chore\(progress\):/` 且 commitCount>0 → `blocked`,reasoning 含 "progress-ledger-only"。
- 混合(ledger + 真 commit)→ 现行为不变(不落 Rule 1)。
- commitCount=0 → 现行为 blocked 不变。

### chunk D2(实现)
Rule 1 判定改为 `effectiveCommits = commitCount 减去 ledger-only 情形`(实现上:`commitCount === 0 || (commitMessages 全为 chore(progress) 前缀)` → blocked 分支,reasoning 区分两种情形)。

## 5. 对抗/场景测试(issue ③)

`packages/teamlead/src/__tests__/phase-orchestrator.fly921-adversarial.test.ts`(新文件,orchestrator 级全链模拟,复用 deps-mock):

1. **FLY-543 重放**:implement 合成 needs_review(无 binding)→ QA 不 spawn、Lead 告警、状态线刷新;随后 holder(implement)置 failed → reconcile → TURN 归 parked design。
2. **kill-holder 恢复**:QA 持 TURN 被 kill(failed + probe absent)→ reconcile 重授 design、epoch+1、告警一次;重复触发不双告警。
3. **founder 中途改 scope 撞自动推进**:design parked、TURN 在死 QA 手里、design 收到修正指令轮询 turn —— reconcile 后 `turnStatus(design)===yours`(即 Lead 无需手改 DB 的验收标准)。
4. **嵌套会话不完成**(A3 已盖,引用):同 token 异 sessionId callback → 不 settle。
5. **合成完成不推相位 × keep-alive OFF**:kill-switch 关闭路径同样 fail-closed。
6. **indeterminate 不动**:probe 超时 → TURN 原样、无告警。

真机 QA 移交(第三段,独立 QA runner,写进 PR 的 test plan):
- 隔离房间起三段式 issue,implement 内跑一个嵌套 `claude -p` → 断言 Bridge 不误判完成(FLY-543 直接反例)。
- kill 当前 holder → 重启 Bridge(或等事件位点)→ 断言 TURN 自愈、design `turn`=yours、Lead 收到一条恢复告警。

## 6. 验收标准

1. FLY-543 全链重放(单测层)全绿:嵌套 callback 不误判;若仍有合成 awaiting_review,QA 不被拉起且 Lead 收告警;kill holder 后 TURN 自动恢复,无需手改 DB。
2. 既有测试全绿(重点:TmuxAdapter 79 测、phase-orchestrator 既有套件、flywheel-comm three-stage-turn 套件、FallbackHeuristic 既有用例)。
3. `pnpm lint` 全仓干净;push 前全仓测试跑一遍(项目纪律)。
4. 字节兼容红线:不设新 env 时,非三段式流水线与「证据齐备的三段式正常流」行为不变(A 的可选参、B 的不可达分支、C 的纯新增、D 仅 fallback 分支 —— 各有反证用例)。

## 7. 实施顺序与风险

顺序:A(独立,含 core 接口)→ D(独立)→ B(证据闸)→ C(依赖 B 的 fail-closed 形态定型)→ 对抗套件 → 全仓回归。每 chunk 一 commit,ledger 同步(implement 0/12 → 12/12,chunk 粒度 = 上表 A1..D2 + 对抗 + 回归)。

风险与对策(详见 research §3):B 若误伤未知合法路径 → 代价仅「不自动拉 QA + 告警」,可人工续推;C 与 handoff 的竞态由事件流内串行 + epoch 单调性化解;探针成本可忽略。

## 8. Follow-ups(不进本 PR,交 Lead 建单)

1. GatePoller orphan question 刷屏(runner 打错 exec-id 场景的去重/隔离)—— Lead 已认领建单。
2. kill/crash 的完成语义重塑(「被 kill」在单会话流水线也不该表达为 needs_review/PR-ready;牵动 DecisionLayer 全局路由语义)。
3. 无 API key 部署下 DecisionLayer 的长期形态(永久 fallback 是本次事故的放大器;可考虑订阅制机器用本地 claude -p 做 triage)。

## 9. Codex Design Review 记录

- R1(2026-07-06,xhigh):CHANGES REQUESTED,6 项。处理:
  1. `pr_number` 证据前提不成立(complete.ts 对 needs_review 不强制 --pr、evidence 不落 prNumber)→ **部分采纳**:证据闸改为只认 `review_question_id`(≠unbound);不采纳「complete.ts 强制 --pr」替代方案(扩单会话协议面,超最小修复范围)。
  2. status-only `getAlivePhaseSession` 会把 TURN 重授给死 holder 自己 → **采纳**:专用恢复选择器(排除 stale holder + 逐候选 probe)+ 回归钉子用例。
  3. TmuxAdapter 依赖 core 的 `IHookCallbackServer` 接口 → **采纳**:chunk A 增加 `core/src/hook-callback-types.ts`。
  4. session_failed 不经过 onPhaseComplete → **采纳**:两个 failed 持久化位点显式新接 reconcile。
  5. `listTurns` 需项目归属契约 → **采纳**:orchestrator dep 返回 `{projectName, turn}[]`,plugin 逐项目拼装。
  6. 证据闸顺序改变 FLY-902 disabled-warn 语义 → **采纳**:顺序改为边界 → policy → 证据 → handoff,加钉子用例。
- R2(2026-07-06,xhigh):CHANGES REQUESTED,2 项。处理:
  1. 事件位点 reconcile 与 fresh spawn 竞态(pre-launch grant 先于 fire-and-forget 的 session_started 落库,「holder 无行」会被误判 stale 抢走刚授出的 TURN)→ **采纳**:守卫 1 = 事件位点只在 holder === 刚终态的 exec 时判定;守卫 2 = 启动位点对「行缺失 + granted_at < 5min 宽限」视同 indeterminate;各配回归钉子用例。
  2. research/exploration 残留 pr_number 必需的旧说法 → **采纳**:全量 sweep 同步(机制段、byte-compat 表、测试面、scope、gate 记录五处)。
- R3(2026-07-06,xhigh):**APPROVED**。2 条 non-blocking 建议已顺手落实:① research §3 风险条措辞更正(complete.ts 只透传 --question-id 不强制,缺 qid → unbound 哨兵 fail-close);② C2 deps 显式加 scoped `getTurn(issueId, projectName)`,守卫 1 走 scoped 读,成功 handoff 后不跑完整 stale 矩阵。
