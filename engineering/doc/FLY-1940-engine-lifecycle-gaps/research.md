# FLY-1940 引擎生命周期三缺口收口 — 调研

Issue: FLY-1940 (https://linear.app/geoforge3d/issue/FLY-1940/引擎生命周期-三缺口收口死-session-复活直通-ship-卡-交棒不唤醒-孤儿闸监控并-19411946)
日期: 2026-08-21
基于: exploration.md

## 0. 方法与基线

- 4 个并行只读代码审计,基线 = 本 worktree(main `03ca386f0` 之后仅有 progress commit)。全部结论带 file:line。
- 「EXISTS/ABSENT」均指**本分支现状**;CLAUDE.md 里程碑标注的在飞 PR 不在本分支,分工对照见 §8。
- 行号会过期:重定位一律用 `git log -S "<符号名>"` 或直接搜符号,见 §9 过期表。

## 1. 切面① ship 卡前置 — 现状与缺陷

### 现状机制(epoch-1 主路径)

QA verdict → `submitWorkflowDecisionByCredential`(StateStore.ts:35880)→ `commitWorkflowTransitionTx`(:36224)→ `createWorkflowGateHolderTx`(:39655,**开卡决策点**)→ `gate-materializer.ts:148` 发 founder 卡。

开卡前置的完整清单(今天):run active + writer fence + QA 节点**最新 attempt** 上有一条未撤销/未过期的 `qa_passed` claim(subject_kind='git_head')+ 该 claim head 的 PR binding + carrier session ∈ {running, ship_parked} 且 `pr_head_sha` 匹配。

### 缺陷(全部实锤)

| # | 缺陷 | 证据 |
|---|---|---|
| 1a | **卡上的 head 是从 QA claim 派生的,不是对照当前 head 验证的** | StateStore.ts:39647-39651;`input.runnerShipHeadSha`(transition 携带的 head)只在 `required.length===0` 分支消费(:39541),从不与 proof 比对(:39674 后 ABSENT) |
| 1b | 唯一「新鲜度」= attempt 相等(:39597-39601, :39932-39937)——同 attempt 上的 6 轮修复推 head 完全不扰动 | `sessions.pr_head_sha` 只在 completion(:32678)和 gate binding(:39738)写;之后推的 commit 谁都不知道 |
| 1c | **`failed` 不是终态免疫态**:`isNoOutEdgeTerminalStatus`(core/workflow-fsm.ts:198)只认零出边状态 {approved, completed, shelved, terminated},而 `failed→[shelved,terminated]` 有出边(:183)→ FLY-1427 全部围栏对 force-fail 复活体是 no-op | 三套「终态」词表互相不一致:workflow-fsm vs OPERATIONAL_TERMINAL_STATUSES vs ZOMBIE_IRREVERSIBLE(StateStore.ts:417) |
| 1d | **writer fence 只看 node state 不看 session status**:`assertCurrentWorkflowWriterTx`(StateStore.ts:32740)要求 `node.state ∈ {pending,admitted,running}`——force-fail session 不改 node state,复活窗口仍是合法 writer | |
| 1e | dead-exec reconciler 只处理探针=dead:复活窗口探活 → `continue` 零动作(workflow-engine-dispatcher.ts:1941-1979);re-entry 分类对探活体直接 wake(phase-actor-reentry.ts:29-67) | |
| 1f | `holder_authoritative` 绕过 admission 的 `revoked_terminal_session` 与 `revoked_qa_hold` 两道栅栏(question-admission.ts:278-311) | |
| 1g | gate binding 主动去终态化:绑 carrier 时 `terminal_at = NULL`(StateStore.ts:39738-39747) | |
| 1h | 「复活重置 needs_review」逻辑 ABSENT;PR #898(FLY-1894)是纯 rules 层 md,零 runtime 代码 | `git show --stat 33682ea27` |
| 1i | founder 免 QA 概念 ABSENT:`qa_exempt` 仅 bridge_policy 签发、snapshot_digest-only、只对全 no-write run 自动发一次(StateStore.ts:38053, :20839-20872) | |

### 现成可复用机制(净删除形态的关键)

- **`design_review_approved` 已有 head-supersede 撤销**:materialization 推 head 时撤销 `subject_digest ≠ remote_head` 的 review claim,理由 `materialized_head_superseded`(StateStore.ts:41064-41079)。**`qa_passed` 没有这个孪生**——补上它,后续 `resolveWorkflowDecisionClaim` 的 revoked 检查(:39951)免费拦下开卡。
- claim 撤销总账 `workflow_claim_revocation`(:18405,append-only)+ 冻结证据 `workflow_gate_holder_evidence`(:17799,immutable)。
- merge 时 `verifyApproval`/`evaluateEngineShipClaims` 的 head 校验(verify-approval.ts:590-612;StateStore.ts:40074-40146)已存在——**问题只是开卡时没有等价断言**。

## 2. 切面② 交棒唤醒 — 现状与缺陷

### QA-FAIL→交棒全链

`qa-result --status fail` → `/api/workflow/decision` → transition 铸 `workflow_rework_request/route_revision/delivery(pending)`(StateStore.ts:36912-36978;preferredActor = 目标节点最高 attempt 的原实现体,:36816)→ dispatcher 1s tick → `WorkflowReworkCoordinator.reconcile`(workflow-rework-coordinator.ts:287):claim → 活性分类(:354)→ `assertWorktreeReady`(:391)→ activate → `grantTurn`(:516,**成为持棒人的瞬间**)→ `wakeActor`(:569)→ **`turn_granted → wake_delivered`(:584)**。

### 缺陷

| # | 缺陷 | 证据 |
|---|---|---|
| 2a | **`wakeRunnerMailbox` 的「成功」= inbox JSON 文件写成功**(wake.ts:157-178),零接收方证明。对无活 watcher 的 Codex 体 = 必然假阳性。**这是缺口二的根** | |
| 2b | **`wake_delivered` 之后引擎零停滞检测**:stall 巡检的 state 过滤器默认只有 `{pending, turn_granted, replacement_pending}`(StateStore.ts:25842-25846),`escalateWorkflowReworkStall` 显式拒其它态(:23792)。文件写一成功就进 `wake_delivered` → 永远不再被看 | |
| 2c | 活性证明取自 step 2,与 `wake_delivered` 写入之间隔 4 个 await 边界,**不复探**(workflow-rework-coordinator.ts:354→584) | 8-21 案 4:wake_delivered 投给死体 |
| 2d | **活性探的是 TUI viewer pane,不是 goal runtime**:`probeRunnerProcessLiveness` = `tmux list-panes #{pane_dead}`(tmux-lookup.ts:565);Codex pane 里跑的是 `codex resume --remote` TUI(codex-runner-tui-window.ts)。TUI 活 ≠ watcher 活。Lead 敲 pane 能动是因为键击经 TUI 直接开 turn,绕过了死 watcher——**这解释了「wake sent/acked 但体不动」** | |
| 2e | **Codex watcher 只在 `confirmHoldPaused()` 里启动**(codex-phase-lifecycle.ts:378-426);goal 结束没走到 phase hold、或 transport/agentName/teamName 缺一(CodexTmuxAdapter.ts:521-527)→ watcher=null → 停驻体**永久邮箱不可达**,而 wake 照样返回 ok:true | |
| 2f | wake 失败全静默:`runner_wake_failed/skipped/no_transport` 只写 StateStore event + console(runner-wake.ts:122-269),**无任何 Lead/Discord 消费者**;`sendRunnerWake` 返回 `Promise<void>`,所有 caller 丢弃结果 | |
| 2g | FLY-1448 的 `wake_failed` episode 生产者存在(db.ts:3546-3760)但**零生产消费者**;`runner_phase_wakes.envelope_json`/`admission_state` 无写入者 → 整条 receipt-wake 账本 + T2 升级路径是死代码 | |
| 2h | turn_wake_outbox push 上限 = 2(db.ts:152 CHECK),之后永不再推;唯一在工作的告警 = 20 分钟后 `insertQuestion` 发进 **Lead inbox**(db.ts:5252-5302)——恰是 FLY-1876 降级的那个面 | |
| 2i | doorbell 现状:`runner-wake-sweep` 只扫 mailbox 表行、只在 Codex 自己 turn-end 的 Stop hook 触发(runner-stop-notify.sh:190),**盖不住 TURN wake**;`wake_pointer` tmux doorbell 代码存在但无 caller 传 mode、deps 不齐 = 不可达(runner-recovery-nudge.ts:39-315) | |
| 2j | rework 5-hold 升级(1/2/4/8/16min → needs_lead + severe alert,StateStore.ts:26862-27170)只在 `wakeActor` 返回 !ok 时消耗——文件写基本必成,**事故形态永远走不进这条已有的响亮路径** | |

### FLY-1795(#902,已 merge)边界

只改了 Lead→runner 指令 lane 的 ACK 结算(claude `on_delivery` 直落 ACKED;codex 保持 `on_consume`)。**没动 turn handoff、sendRunnerWake、push cap、wake 失败告警、Codex watcher 生命周期**。它的遗产恰恰是把「Codex wake 在消费前不可证」写进了类型——而 turn-handoff caller 拿到的还是文件写的 ok:true。

## 3. 切面③ 孤儿闸 + TURN 存量 — 现状与缺陷

### 闸生命周期(全部 gate 同一张 CommDB `mailbox` 表)

- `superseded_at/superseded_by` 字段 **EXISTS**(mailbox-schema.ts:103-104)。issue 里「supersede 路径没写它」的线索**字面错、效果对**:唯一写入路径是「同 run 新一轮 gate」(gate.ts:201-207 → `retireQuestionGuarded`,db.ts:1479-1480);runner 死了/换 run_id/活被放弃 → 永远不写。
- **所有 Bridge 侧 supersede 机制结构性排除 founder_review**:sweeper 候选查询 `checkpoint IN ('approve_to_ship','review_design','review_code')`(db.ts:1536/1556/1579);`retireShipGate` 硬编码 approve_to_ship(:1344);**`TerminalGateRetirement`(issue Done/PR merged ⇒ 关闸——正是 FLY-1758 需要的机制)在 terminal-gate-retirement.ts:132,181 显式 skip 非 approve_to_ship**。
- founder_review 永远 `--no-block` 开(Blueprint.ts:905),gate.ts:236-258 注释明言「无进程内超时巡检」;Codex 的 marker deadline watcher 随 execute() 返回即死(CodexTmuxAdapter.ts:1254);`getPendingQuestions` 不查 `expires_at`(db.ts:2504-2517);MailboxQueue 只归档 ACKED/DEAD → **未答闸行不朽**。
- 「答了」= 存在 `type='response'` 子行(无 answered_at 列);`resolved_at/resolved_via` 是**处置**标记不是回答——`finalizeSession` 会对未答闸写 resolved(db.ts:5786-5813),两者不可混。

### 四条判据的数据可证性

| 判据 | 现状 | 备注 |
|---|---|---|
| 闸开着 | ✅ `relay_state != 'terminal_disposed'`(canonical answerable 谓词,db.ts:1466) | 别用 expires_at |
| run 活着 | ✅ 但跨两库两跳:mailbox.from_agent(execId)→ StateStore `workflow_execution_binding` → `workflow_run.status`;或 gate content JSON 里的 runId(founder-review.ts:294) | mailbox 无 run_id 列/无 FK;**held 算不算活必须显式定**(QA 四格实测:真死 run 多半已 held,「持棒者不活跃」红灯只看 active → 两头都不报) |
| 未 superseded | ⚠️ 列在但跨 run 不写(见上)——**只按此列监控会 page 到 1758 形态的孤儿** | 先补写入者,或监控用判据 2+4 兜住排除 |
| 没人答 | ✅ `NOT EXISTS response 子行`(db.ts:1485-1487) | |

- 额外强信号:founder_review 无 `founder_review_card_binding` 行 = **从未渲染给 founder、构造上不可答**(founder-review-response.ts:71-73)——比闸龄更硬的孤儿证据,查询便宜。
- 名册盲区实锤:`getPatrolRosterSessions` 只出 6 个非终结 status(StateStore.ts:6731-6747),patrol-tick 输出**完全没有 gate 数据**;全仓无任何 surface 计算闸龄。

### three_stage_turn 存量(158 死棒)——与孤儿闸是同一个 bug

- 表无 expires/lease/state 列(db.ts:119-129);`grantTurn` 是 overwrite 型指针;park 不释放、runner 死不释放。
- 释放路径只有:ship 成功(post-ship-finalization.ts:528)/ 外部 merge 回收 / `TurnBeltReconciler`。**Reconciler 对 engine-owned run 全跳过(turn-belt-reconcile.ts:133,错误还 fail-closed 成 true)= 对现代 DAG 全体 no-op;全量清扫只在 Bridge boot 跑一次(plugin.ts:9533)**。
- **死棒 → `finalizeSessionUnlessTurnHolder` 否决(db.ts:5876)→ session prune/FSM reconcile 双双跳过 → `finalizeSession` 里那条顺手关孤儿闸的 UPDATE(db.ts:5790-5813)永远不执行**;同时幸存的 CommDB 行又让 zombie-gate-hygiene Z1 跳过(而 Z1 生产本来就 disabled)。158 死棒 = 158 个不可 finalize 的 session = 源源不断的不可关孤儿闸。
- CAS 释放原语 `deleteTurnIfCurrent`(db.ts:5405-5419,epoch-guarded)**已存在**,缺的只是一个不被 engine-owned 压制、有节奏的 caller。

### 现成告警位点(满足「不加新告警层」红线)

- 首选 `store.enqueueWorkflowEngineAlert`(样板 workflow-gate-materialization-alert.ts:22-115):幂等 escalationUid、severe、run-scoped、自带 `run.status!=='active'→return`。
- 或 GatePoller rider(已有 ~12 个同形 rider,per-N-ticks + kill-switch env 的现成缝,gate-poller.ts:135-181)。新 alert kind 需同步 5 处 allowlist(LeadAlertNotifier/kind-contract/ticket-owner-map/infra-event-router/lead-alert.sh)。

## 4. 切面④ needs_lead/quiescence/start 预约 — 现状与缺陷

| # | 缺陷 | 证据 |
|---|---|---|
| 4a | **quiescence 门结构性不可过**:`collectRunQuiescenceEvidence` 调探针**不传** `allowMissingTargetHostAbsence`(run-quiescence.ts:28);CommDB 行被 canonical terminate 删掉 → `lookupTmuxTarget`=gone(tmux-lookup.ts:242)→ 探针在 generalized-launch-recovery.ts:59 直接返 unknown(不看 tmux marker、不 pgrep);严格校验器要求 liveness==='dead'(StateStore.ts:28763)→ unknown 判 live。**拆得越干净越判不死**。对照:dispatcher 同一探针**传了**这个 flag(workflow-engine-dispatcher.ts:206-215)——quiescence 是唯一漏传的消费者,全部 4 个 call site 均漏 | |
| 4b | needs_lead **无 resume 端点**(全仓 grep 仅类型 union);唯一出口 = 新 clientRequestId 的 rework,被 4a 堵死 | heldNeedsLead 分支前置清单见审计(StateStore.ts:30533-30721) |
| 4c | **start 预约无终态失效**:`workflow_start_reservation` 触发器禁 UPDATE/DELETE(StateStore.ts:18697-18705),stage 只进不退;exec 终结后 `inspectWorkflowStartReplay` 永远 `start_attempt_not_current`,且按 run_id UNIQUE 键,**任何新 idempotencyKey 都撞 409 STALE_START_RESPONSE**(runs-route.ts:1346-1368);`:pending` 子案曾被单独热修(generalized-launch-recovery.ts:77-90 自述此楔子) | |
| 4d | worktree baseline 精确相等断言:`rev-parse HEAD == sessions.pr_head_sha`(rework 开单时冻结,plugin.ts:9290-9295;写入 StateStore.ts:30715-30721)。QA 在分支顶推报告 commit 是常态 → 每轮 `head_mismatch` → 烧光 5-hold 预算 → needs_lead → 撞 4a。ship-carrier 侧有结构相同的第二份拷贝(plugin.ts:9420) | |
| 4e | **`resumeHeldLandOperation` 是现成模板**(lifecycle-routes.ts:277-308 + land-executor.ts:212-253 + StateStore.ts:49433-49639):actor+reason → 外部真值校验 → 逐项 `resume_refused:*` → CAS re-arm(retry_count=0, generation+1)→ 不可变审计行 → kick。needs_lead resume 端点照抄此三层结构 | |

## 5. 切面⑤ terminate 进程树 — 现状与缺陷

- `handleTerminate`(actions.ts ~1580-1700)/`closeRunner`/`close-tmux` 的物理动作 = `reapRunnerMcp`(**Playwright-only**,mcp-process-classifier 全宇宙就是 `@playwright/mcp`)+ `killCmuxLinkedSession` + `tmux kill-window` + 删 CommDB 行。**全仓无任何按 FLYWHEEL_EXEC_ID 的 kill**(grep 仅只读 pgrep 证据一处)。
- Codex daemon 是 **Bridge 的 detached 子进程**(codex-daemon-runtime.ts:694-705),Bridge 死后 reparent 到 init;真身 app-server 是 rotation shim 的 fork 孙。tmux kill-window 碰不到它——**僵尸续命是构造出来的**。
- **正确的树杀已存在但 Bridge 够不着**:`killTree`/`handle.stop()`/`ensureDead()`(codex-daemon-runtime.ts:556-;按进程组 + socket 验尸 + SIGKILL 升级,`createDefaultKillGroup` 拒 pgid≤1/自身/Bridge 组)只被 runner 进程内生命周期调用;`prepareCodexPhaseShutdown` 只从 `closeRunner` 进(不从 `handleTerminate`),且 gated 到 resident codex phase。
- daemonPid 已持久化在 `~/.flywheel/.../session.json`(CodexTmuxAdapter.ts:1176-1200)且有读回函数——**Bridge 侧树杀的原料齐了**。
- FLY-1759 worktree reaper **已 merge**(#830;CLAUDE.md 标注过期):按 worktree cwd 发现进程——daemon cwd 在 worktree 外 = 不可见,不解决本缺陷,但 `pid+lstart+command` 身份栅栏模式可直接复用。

## 6. 切面⑥ finalization partial — 现状与缺陷

- 步骤链完整存在(post-ship-finalization.ts:643-1369):closeout(1.7)→ terminal 通知(2.5)→ **thread archive(3)→ Linear Done(3.5)**;30s sweep 重驱动 `state ∈ {intent,partial}`(plugin.ts:7951);8 级退避,retryCount>8 → held。**归档在 happy path 里,手动端点只是逃生口**。
- 卡 partial 的三个静音机制:
  - **`announce` 每 stage 只发一次**:receipt 键在 stage 不在 reason(land-executor.ts:436)→ FLY-1795 的 `notification:finalization_partial` 就是这一条,之后 8 轮重试跨 reason 变化零消息;
  - `finalization_partial` 不在 plugin.ts:5969-5976 的 workflow_engine alert allowlist;引擎侧 `recordWorkflowLandPartial` 的 escalationUid 摘要含 reason → 同 reason 重复 = 幂等静音(StateStore.ts:49666)→ FLY-1867 重试 7 次只 1 条告警;
  - **epoch 键 = `${stepCount}:${current_step}`(StateStore.ts:49374-49377),任何 step receipt 进展就清零 retryCount** → 振荡型 partial 可无限重试永不 held/升级。
- **三缺口同一个结(本调研最重要的综合发现)**:closeout 的 `anyBlocked` 由逐节点 `confirmedGone` 驱动 → `confirmedGone` 依赖的正是切面⑤没杀干净的进程 + 切面④返 unknown 的活性探针 → **没杀干净 ⇒ confirmedGone=false ⇒ closeout blocked ⇒ 归档+Linear Done 一起被短路 ⇒ `issue_closeout_incomplete` partial 循环**。⑤ 和 ④ 修好,⑥ 的大头自动通;⑥ 剩下的是告警诚实化与 epoch 漏洞。

## 7. 病灶统一图(修复设计的地基)

```
⑤ terminate 不杀树 ──┐
                     ├─→ ④ 探针 unknown(拆干净=判不死) ──→ needs_lead 死路 / 幻影态
② wake 假阳性 ────────┤                                        │
                     └─→ ⑥ confirmedGone=false → closeout 卡 partial → 不归档
③ 死棒不释放 ──→ finalize 被否决 ──→ 孤儿闸不可关 ──→ (监控又只看活 session=全盲)
① failed 无免疫 + head 不复验 ──→ 复活直通 ship 卡
```
公共根:**「absent/unknown ≠ dead」的判死学 + 「写成功 ≠ 到达」的投递学 + 「终态 ≠ 免疫」的状态学**,三个学缺一门,六个切面各表一枝。

## 8. 依赖分工对照(R2 更正:merge-ancestry 实证,替代 CLAUDE.md 里程碑口径)

> ⚠️ R1 初稿把「CLAUDE.md 标 ⏳」直接当「不在分支」,被 Codex design review R1 #10/#11 抓出并经 `git merge-base --is-ancestor` 逐一实证更正。教训:分工判断只认 merge-ancestry,不认里程碑标注。

| 单 | 实证状态(2026-08-21 @ HEAD) | 与本单重叠 | 本单立场 |
|---|---|---|---|
| FLY-1770 land closeout 自愈 | **已 merge**(`f09a3f19b` #845,ancestor 实证) | 切面⑥ retry/epoch | **跨 epoch 收敛归本单**:1770 的预算刻意 per progress-epoch(epoch 键 = COUNT(land_operation_step)+current_step),新 step receipt 会复位预算——本单 6-C 补耐久总预算,6-A 禁独立先行 |
| FLY-1628 pane-loss reconciler | **已 merge**(`acbf39bee` #776) | 切面①force-fail 来源 | 已是现状,本单在其上补免疫 |
| FLY-1759 worktree 进程收割 | **已 merge**(`e4ae3893e` #830) | 切面⑤ | 其 `pid+lstart+command` 栅栏复用;它按 cwd 发现,盖不住 daemon |
| FLY-1912 typed 409 拒绝机制 | **已 merge**(`f4d789396` #908) | ①A/①B 的拒绝通道 | 复用 `WorkflowEngineInvariantError` 事务内捕获(裸 Error 会漏成 500) |
| FLY-1638 self-ship 收尾 + launch lease | **基座已 merge**(`f02ecbc87` #779)+ diverged follow-up 在飞 | 切面④c start 预约 | 4c 与已合基座对齐;实现前 JIT 重读 follow-up 分支 |
| FLY-1655 terminal land 重设计 | 未在 HEAD(code review 中) | ship→land 终态收敛 | ①开卡断言在 holder 层,正交叠加安全 |
| FLY-1731 completion_disposition | 部分在分支(StateStore.ts:34517 实证) | 切面② completion 语义 | 已是现状 |
| FLY-1448 wake_failed episode + receipt 账本 | 生产者在分支、消费者 ABSENT(审计实证) | 切面②f/g | plan 决策:**退役生产者**(语义被 2-A 覆盖),不接消费者 |
| FLY-1772 打回返工新 ship 卡 | 未在 HEAD(PR #846) | ①supersede writer 家族 | 正交,叠加安全 |

## 9. 会过期的结论表

| 结论 | as-of | 重核命令 |
|---|---|---|
| 行号全表(本文所有 :NNNNN) | 2026-08-21 @ main 03ca386f0 | `git log -S "<符号>"` + 直接搜符号名;不要按行号信 |
| FLY-1759/1628/1770/1912/1638基座 已 merge;1655/1772/1638-followup 未在 HEAD | 2026-08-21(R2 实证) | `git merge-base --is-ancestor <sha> HEAD`(sha 见 §8 表);CLAUDE.md 里程碑标注不可信 |
| three_stage_turn 存量 158 死棒 | 2026-08-21(Tadashi 转 1925 QA 只读回放) | 生产 CommDB `SELECT COUNT(*) FROM three_stage_turn`+逐条探活;数字必变,形态待复核 |
| turn_wake push cap=2、20min Lead-inbox 告警是唯一在工作的 wake 告警 | 2026-08-21 | 搜 `CHECK(push_count`、`materializeTurnWakeNoReceiptAlerts` |
| zombie-gate-hygiene Z1 生产 disabled | 2026-08-21 | 读 zombie-gate-hygiene.ts 头部开关 |
| quiescence 校验器 `validateRunQuiescenceEvidenceTx` 已被 founder 指令中性化(return ok) | 2026-08-21 | 搜该符号;若恢复,④a 修法需重估 |
| FLY-1876(Lead inbox nudge 降级)仍在别单 | 2026-08-21 | Linear FLY-1876 状态 |
