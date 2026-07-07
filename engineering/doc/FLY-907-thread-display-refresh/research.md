# FLY-907 thread 显示批次:状态随真实状态刷新 — 调研

Issue: FLY-907 (https://linear.app/geoforge3d/issue/FLY-907/uxdisplay-thread-显示批次-状态行标题随真实状态刷新parkwakekillresetfinalize-全触发-绿标)
日期: 2026-07-06
基于: exploration.md

本文钉住 plan 依赖的全部代码事实(文件:行号以 flywheel-FLY-907 分支当前 HEAD 为准,`27c90111`)。

## 1. 三个显示面:精确锚点

### 面 A — thread 标题前缀

- 渲染入口:`packages/teamlead/src/bridge/event-route.ts:398 stampStageEmojiForSession(deps, session, stage)`。deps = `{store, projects, config, chatThreadCreator}`。
- 三段替换逻辑:event-route.ts:432 `phaseThreadBadge(session.chat_thread_role)` → 非空则**替换** stage badge。`phaseThreadBadge` 在 `packages/config/src/three-stage-phases.ts:142`(仅认 design/implement/qa,main→"")。
- 写入器:`ChatThreadCreator.stampStageEmoji`(ChatThreadCreator.ts:488),内部 coalesce-to-latest + 429 Retry-After(FLY-630,titleWriters map)。**复用它就自动获得限速安全**。
- 徽章词汇:`packages/teamlead/src/bridge/stage-utils.ts` — `STAGE_EMOJI`/`STAGE_WORD`(FLY-560)、`BLOCKED_EMOJI 🔴`(未 stamped,v1 保留)、`RECONNECTING_EMOJI ⚠️`(FLY-623,HeartbeatService 在 re-adopt 时 stamp)、`splitStatusEmoji` 剥离/重stamp 幂等契约。模型码 `[F]` front-marker(FLY-755)随同一次 rename。
- 现有触发:**唯一** event-route.ts:1811(stage_changed 分支);另 auto-qa-effects.ts:472-530 有一个镜像(auto-QA 段 stamp 🧪)。HeartbeatService.ts:1270 在 reconnect 时 stamp ⚠️重连中。
- flag:`FLYWHEEL_ISSUE_STATUS_EMOJI!=="0"` 开(plugin.ts:973);`FLYWHEEL_ISSUE_STATUS_WORD!=="0"` 带词(event-route.ts:387)。

### 面 B — 置顶 pipeline header(FLY-892)

- 渲染入口:event-route.ts:486 `pinRunnerAttachForSession(deps, session)`;三段分支 event-route.ts:544-611:`getLatestPhaseSessionsForIssue` → 逐 role 组 `PhaseHeaderRow` → `buildPipelineHeaderContent`(ChatThreadCreator.ts:221)→ `ensureRunnerPipelineHeaderPin`。非三段 fallback = 单-runner attach pin(byte-compat 红线)。
- 状态词:`PHASE_STATUS_BADGE`(ChatThreadCreator.ts:205)= `planned: "⬜ 未开始" / active: "▶ 进行中" / done: "✅ 完成"`。done 判定 `HEADER_DONE_STATUSES`(event-route.ts:469)= completed/failed/blocked/merged/design_done。
- attach 命令:`getTmuxTargetFromCommDb(ps.execution_id, ps.project_name)`(tmux-lookup.ts:197,CommDB readonly per-exec 行)→ `resolveCmuxAttachTarget`(tmux-lookup.ts:63,读 `#{window_name}` → 精确探 `cmux-<window_name>`)→ `buildAttachCommand`(tmux-lookup.ts:113)。
- 异步边界:整链在 `Promise.resolve().then(...)` 后跑(event-route.ts:542,Codex R1 MED-1:CommDB busy_timeout 不得占请求栈)——新触发点必须保持同样纪律。
- 现有触发:**唯一** event-route.ts:1821(stage_changed 分支,`issueAttachPinEnabled` 才开,env `FLYWHEEL_ISSUE_ATTACH_PIN!=="0"`,plugin.ts:978)。
- CommDB 写侧(FLY-560 Feature C 的 pin 状态):StateStore `setRunnerAttachPinState/getRunnerAttachPinState`(StateStore.ts:4019-4076,chat_threads 列)。header pin 有自己的 ensure 幂等。

### 面 C — 三段状态行(FLY-887)

- 纯派生:`computePhaseLineStates(sessions)`(phase-orchestrator.ts:129,四态 pending/active/parked/done,输入 = `getPhaseSessionsForIssue` 全量行的 `status`)+ `renderPhaseStatusLine`(phase-orchestrator.ts:153,`🎨design(parked)·🔨implement(active)·🧪qa(pending)`,写死 `PHASE_LINE_ORDER` 三元素)。
- 发帖/编辑:`AutoQaEffects.refreshPhaseStatusLine`(auto-qa-effects.ts:181,post-or-edit + 零churn跳过 + 404 重发;消息记录在 StateStore `phase_status_line`)。
- 组装:plugin.ts:4055 `refreshPhaseStatusLineEffect(issueId)`,存进 `phaseStatusLineRefreshHolder`(plugin.ts:3082,前向引用 holder 模式)。
- 现有触发:phase-orchestrator.ts:580/701/706(handoff/verdict 边界)+ post-ship-finalization.ts:228(ship 收尾,经 holder)。

## 2. 生命周期变更源(触发面要覆盖的全集)

### 2.1 status 变更 = `applyTransition`(唯一入口)

`packages/teamlead/src/applyTransition.ts:26` — 注释明言 "Unified entry point for ALL status changes"。`ApplyTransitionOpts = {store, fsm, executor?}`。共享实例只有一个:**plugin.ts:2738 `const transitionOpts: ApplyTransitionOpts = {store, fsm, executor}`**,向下穿透到所有调用方:

| 调用方 | 覆盖的生命周期节点 |
|---|---|
| event-route.ts(5 处) | session_completed / complete 各 route、qa_result 等 |
| actions.ts(3 处) | approve / **terminate** / retry / reject / defer / shelve |
| close-runner.ts | close-runner(kill) |
| crash-reaper.ts | 崩溃 reap → terminated |
| HeartbeatService.ts | orphan/stale reconcile → failed 等 |
| done-running-reconciler.ts / complete-marker-reconciler.ts / stale-blocker-guard.ts | 各 reconcile 落 status |
| founder-consent/wiring.ts、plugin.ts(2 处) | founder 动作路径 |

均通过传入的同一 `transitionOpts` 引用(实测 HeartbeatService `this.transitionOpts`、crash-reaper `deps.transitionOpts`)→ **在 opts 上加可选 `onTransition` 回调,plugin 组装处赋值一次,即覆盖上表全部**。StateStore 内的 `applyTransition` 字样只是注释;`updateSessionStatus` 已标 `@deprecated`(StateStore.ts:2190)。

FSM 状态全集(workflow-fsm.ts):running → awaiting_review/design_done/... → approved_to_ship → completed;terminal = completed/terminated/shelved(无出边者);kill 路径落 terminated,heartbeat 落 failed。

### 2.2 非-status 的显示相关变更

| 变更 | 位置 | Bridge 可见? |
|---|---|---|
| park | plugin.ts:4339 `parkPhaseRunner` effect(orchestrator 调) | ✅ 效果函数内 |
| wake(fix/retest,含重授 turn 的正常路径) | plugin.ts:4399 `wakePhaseRunner` effect | ✅ |
| stage_changed(session_stage metadata) | event-route.ts:1784 patchSessionMetadata | ✅(现有触发) |
| CommDB tmux_window 注册(attach 命令从无到有) | runner 侧写 CommDB | ❌(靠下一次触发/sweep) |
| 手动重授 turn / CommDB-only 操作 | flywheel-comm CLI 直写 comm.db | ❌ → **sweep 兜底**(gate 已拍:分钟级可接受) |

### 2.3 自愈 sweep 的挂点

`gate-poller.ts:332-336`:FLY-208 A2 巡检 piggyback 在现有 poll tick 上(`this.tickCount++`,`patrolEveryNTicks` 默认 20 ≈ 60s@3s)。同款模式再挂一个 display-reconcile 计数器即可,零新 timer。sweep 范围查询:StateStore 已有 `getChatThreadByIssue`/`getPhaseStatusLine`/phase sessions 查询,需补一个「非终态显示候选 issue」查询(有 phase_status_line 记录或 chat_threads 记录、且 sessions 存在非 terminal 行,或显示文本≠终态渲染)。

## 3. attach 串线:锚点与防御

- 窗口名单一真相:`packages/core/src/tmux-naming.ts:36 buildWindowLabel(issueId, runner, title)` = `${issueId}-${runner}-${cleanIssueTitle(title)}`;displayId 优先 Linear identifier(Blueprint.ts:1630,FLY-272)。→ **校验锚 = `window_name` 以 `${issue_identifier}-` 开头**(大小写按原样;identifier 形如 `FLY-907`)。
- 防御位置:面 B 组行处(event-route.ts:587-597 现逻辑)。`resolveCmuxAttachTarget` 已读回 `window_name` 但**丢弃**了它(只用于拼 cmux session 名)→ 需让它把 windowName 暴露出来供校验,或在调用处独立读一次。
- 失配处理:不渲染 attach 命令,行内降级(如 `_(终端待解析)_`),同时 `console.warn` 一条带 exec-id/期望 identifier/实际 window_name 的告警(供 FLY-923 查注册侧根因)。**绝不渲染错误链接**。
- 注意:identifier 可能缺失(session.issue_identifier 可空)→ 无锚可验时保持现行为(渲染),不新增误杀。

## 4. 终态派生:issue 级聚合的输入

- `getLatestPhaseSessionsForIssue(issueId)`(StateStore.ts:2564):per-role 最新一行(last_activity_at DESC, rowid DESC),缺 role 则缺行。
- `getPhaseSessionsForIssue(issueId)`(StateStore.ts:2486):全量 phase 行,面 C 用。
- 三段终态判据(gate 批准的聚合公式):所有已存在 phase 的最新行 status ∈ {completed}(finalize 后 parked design/implement 会被 `makeFinalizeThreeStagePhases` 关成 completed,post-ship-finalization.fly887.test.ts 有既有行为钉)→ 标题 = ✅完成。有 blocked/failed/terminated 最新行 → 🔴受阻(BLOCKED_EMOJI 已在词汇表,FLY-560 预留未用——本 issue 启用它有现成剥离/重stamp 支持)。否则 = 当前作业 phase 的 badge(取序列中最靠后的非 done 且已有 session 的 phase;全 pending 则 design)。
- 单 session(chat_thread_role='main'/无 phase 行):**保留现行公式**(上报 stage → FLY-560 badge),byte-compat。

## 5. 词汇统一(面 B + 面 C)

- Annie 拍的字形:完成=✅(绿)、进行中=▶、未开始=灰(⬜白色明确否掉;候选 ⚫/🩶/◾,plan 定稿)。
- 面 C 现渲染英文四态 `(parked)`,与面 B 三态中文是两套 → 统一为一套四态:✅ 完成 / ▶ 进行中 / ⏸ 已暂存(parked) / <灰> 未开始。parked 字形不在 Annie 原话里,plan 里给默认并标注可改。
- 两面 done 判据不一致(HEADER_DONE_STATUSES vs computePhaseLineStates):统一到**一个共享派生模块**,两面读同一状态机(pending/active/parked/done/blocked),消除同 phase 两面矛盾。

## 6. 测试基座

- 现有:`stage-utils-badge.test.ts`(徽章/剥离)、`phase-orchestrator.test.ts` + `.fly887-keepalive.test.ts`(computePhaseLineStates/renderPhaseStatusLine 已有直测)、`post-ship-finalization.fly887.test.ts`、`auto-qa-effects.test.ts`(refreshPhaseStatusLine post/edit/404)、`chat-thread-*.test.ts`。
- vitest;快照可用 `toMatchInlineSnapshot`(仓内已有使用先例)。纯派生函数(issue 级标题聚合、统一状态派生、header/状态行渲染)全部可无 I/O 直测——生命周期矩阵(park/wake/qa-pass/qa-fail/kill/terminate/reset/finalize/ship 终态)逐节点钉三面输出。
- byte-compat 哨兵:非三段单-session 路径(标题公式、单-runner attach pin)输出逐字节不变;flags 关闭路径不变。

## 7. 协调事实

- **FLY-921**(High,未动工):turn-belt/相位排序内部。本 issue 零代码交集(只读 sessions/CommDB,不写 turn)。
- **FLY-905**(Urgent):段序 3→2。风险点:`PHASE_LINE_ORDER`(phase-orchestrator.ts:112)与面 B 循环都已经从常量/`THREE_STAGE_PHASE_SEQUENCE` 出发,但 `PHASE_LINE_ORDER` 是本地复制 → 统一改为从 `THREE_STAGE_PHASE_SEQUENCE` 派生,905 改序列显示自动跟随。
- **spinner 串扰**:确认属 tmux/cmux 渲染层(cmux-sync/pane 内容),与本子系统(Discord REST 渲染)无共享代码 → 移出 scope,plan 里给 Lead 留 follow-up TODO(gate 已拍)。
- Bridge 重启部署:纯 Bridge 侧改动(event-route/plugin/orchestrator/ChatThreadCreator),单次 Bridge 重启生效,无需重 Lead/Runner;attach 校验读 CommDB 只读。
