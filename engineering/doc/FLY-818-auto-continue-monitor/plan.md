# FLY-818 auto-continue（/loop-native + 安全网直达 founder）— 实施计划

Issue: FLY-818 (https://linear.app/geoforge3d/issue/FLY-818/infraepicrobustness-系统健壮性追踪-runner-完成idle-不上报-founder-lead-status-不准)
日期: 2026-07-03
基于: research.md, exploration.md（同文件夹;spike 全 PASS）· Codex design review R1+R2 全部采纳

---

## 0. 范围（Annie 认方向 + Lead go 后锁定,别过度设计)

**只做 2 件:**
1. **① /loop-native goal-driven 自动续跑** —— runner 按 goal 自己往下做到「本阶段完 / 开 PR」,续跑间隔模型自定(~60s–30min 量级),遇 blocking gate/question 停、真卡住升级。
2. **② 现成 stuck-detector 安全网 → 真卡住时可靠 page founder**(不再只提示 Lead / 不靠 Lead 转发 = FLY-163 core / 818 最初痛点正解)。

**不做**:不自造 Bridge-side auto-continue Monitor(research.md 已论证);C/D/E/F 已拆子 issue(FLY-820/821/822/823)。

**集成约束**:phase-aware,跟 **FLY-793 三段式(Design/Implement/QA,PR #430)** 干净集成;跟 **FLY-368**(AlertChannelHub,in-flight)复用不撞;**默认 off / opt-in / byte-compat**;先单 runner canary → 放大(FLY-400 C1)。

> **Codex R1 采纳记录**:R1 8 条 finding **全部采纳**——把「最小方案」补齐到能在生产兑现(arming readiness seam / founder page 真实语义 / blocking-question vs non-blocking-ask / FLY-793 role 绑定 / restart+compaction 恢复 / mandatory budget / 精确调静)。均非新增 scope,而是让原方案可实施。

---

## 1. 现状锚点（file:line,已审计 + Codex R1 复核)

- runner 启动:`TmuxAdapter.execute`→`buildClaudeArgs`(`packages/claude-runner/src/TmuxAdapter.ts:705-773`),`claude [options] [prompt]`,**无 `--max-turns`**;`--append-system-prompt-file`(`ctx.appendSystemPrompt`)= 注入点。**注意(R1#1)**:`new-window` 里直接 `claude … <prompt>`(`:518-531`),`onTmuxWindowCreated` 在 launch 之后才回调(`:591-605`),此时初始 turn 很可能仍在跑——**没有现成「Claude 已到 idle input box」的 seam**;`AdapterExecutionContext.onTmuxWindowOpened`(`packages/core/src/adapter-types.ts:316-326`)已定义但 TmuxAdapter 未调用。
- durable launch record 机制存在:`launchCommitPath`/gateway launch(`TmuxAdapter.ts:534-560`)——arming state 可复用同类持久化。
- runner bootstrap:`packages/edge-worker/src/Blueprint.ts` 组装。**关键契约(R1#3/#4)**:Blueprint 明确 `flywheel-comm ask` 是 **NON-BLOCKING、runner 应继续**(`:1012-1026`);`pr_handoff`/no-transport runner **不走 approve gate/wake/ship**(`:1143-1161`);已有 `sessionRole`/`qaContext`/QA lane/no-transport lane(`:803-884`,`:1087-1098`;`run-dispatcher.ts:123-185`),但**无 FLY-793 三段 role 的真实字段/label**(793 代码不在本 branch)。
- 安全网:`StuckRunnerDetector` **Lead-first**——先发 `runner_stuck_escalation` 给 owning Lead,grace 后才 `alertUnhandled`(`stuck-runner-detector.ts:374-433`,`:453-555`);默认 stuck 阈值 10min、Lead grace 5min,但 **watchdog poll 默认 ~1h**(`stuck-escalation.ts:75-107`;`plugin.ts:3813-3835`)。`RunnerIdleWatchdog` **同一 tick 先跑 stuckDetector 再决定发 idle**(`RunnerIdleWatchdog.ts:177-273`)——**不能整体静音 watchdog**。
- 告警出口(R1#2):`runner_stuck_unhandled` 已接 `alertSink`(`plugin.ts:3790-3800`),但 `alertSink` 仅在 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`+`FLYWHEEL_ALERT_THREADS=1`+repair chain 成立时才是 `AlertChannelHub`,否则是 raw `LeadAlertNotifier`(`:3544-3559`,`:3645-3688`,`:3751-3754`);`LeadAlertNotifier` root alert **显式 `allowed_mentions:{parse:[]}`(不 @)**(`LeadAlertNotifier.ts:693-715`);真实 `<@founder>` **只**在 `AlertChannelHub` 的 AutoRepairBot 返 `needs_human` + 合法 founder snowflake 时发(`AlertChannelHub.ts:295-330`);AutoRepairBot 成功 nudge 只发 "attempted"、**不 @founder**(`AutoRepairBot.ts:134-165`)。→ **「真卡住直达 founder」当前不成立为稳定契约,必须显式补 founder page path。**

---

## 2. ① /loop-native — goal-driven 自动续跑

### 2.1 入 loop 机制 = R1b(有 readiness probe + durable arming,取代原 R1;Codex R1#1)

spike 只证「已在 self-paced loop 的 session 能 ScheduleWakeup」,**没证 Flywheel spawn 后能可靠 arming**。故:

**R1b = lifecycle-bound arming observe(env-gated,默认 off;Codex R2#1)**:spawn 成功后**不立即 send**,持续观察直到以下**任一**成立(不是从 spawn 起算的短总窗口——真 runner 首轮 onboard/读 repo/写 plan/跑测试**可能几分钟到几小时**,短 timeout 会让最需要续跑的长首轮 runner 永远进不了 /loop = FLY-818 没真修):
1. **input box 出现**(pane capture 检测 Claude 已到 idle input box,复用 `stuck-candidate.ts` `detectInputBoxPresent`/fingerprint)→ **一次性** send `/loop <goal 文件绝对路径>`(见 2.3),写 `autocontinue_armed`。
2. runner **terminalized / completed / failed / pane dead** → 不 arm,写 terminal audit。
3. blocking gate/question **已持久化为 pending** → 不 arm,写「blocked by gate」audit。
4. 达到**显式 `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS`**(默认应**足够长、跟正常 runner timeout 同量级,绝不是 90s**;per-probe/infra wait 才用短 timeout)→ fail-closed audit,退回普通 runner(byte-compat)。
- **durable arming state**(见 2.5):`autocontinue_armed` 幂等,Bridge 重启后可安全补发、**绝不重复 arming**。

- **备选 R2**(bootstrap prompt 让模型自 invoke `/loop`)**不采用**,除非先做真 runner spike 证「初始 turn 能可靠触发 slash command」。
- 落点:dispatcher/adapter spawn 后的 arming 步骤;gated on flag。

### 2.2 goal 契约（借 FLY-512 `/goal` 6 要素精简,注入 durable goal 文件)

- **Outcome**:完成 = 跑完你这一段 → 到本段 handoff/gate/开 PR(见 2.4 phase-aware)。
- **Verification**:证据驱动(测试/CI/PR/verdict 文件),不靠「感觉做完了」。
- **Stop conditions(硬,R1#3 区分两类)**:
  - **blocking checkpoint = hard stop**:`gate`(brainstorm/question/approve/design_review)——gate CLI 天然阻塞 turn(`checkDynamicTimeout` 把 pending-question 不计入 timeout);turn 不结束 → /loop 不排续跑。runner **停下等答**。
  - **non-blocking `flywheel-comm ask` = 继续 + 周期查**:按 Blueprint 现有语义(`Blueprint.ts:1012-1026`)runner **继续朝 goal 干、周期性 check 回复**,**不停 loop**。
  - 到 outcome → 停。
- **Iteration policy(防空转)**:一次续跑 turn **无实质进展 / 无 tool call → 停,不再排续跑**(FLY-512 §1.5)。
- **Blocked→escalate**:反复失败 / 无可行路径 / 续不动 → 走 §3 安全网(stuck detector,可靠 page founder)。

### 2.3 durable goal 文件（R1#6:restart/compaction 恢复)

- spawn 时给每个 execution 写确定性 goal 文件:`<runner-state-dir>/<executionId>/autocontinue-goal.md`(含 2.2 契约 + 2.4 phase 模板)。
- prompt/`/loop` 只**引用该路径**(不内联),所以 compaction 后 runner 仍能重读 goal(loop 每轮指令 = 「重读 goal 文件 → 干 → 判续/停」)。
- **权限/路径卫生(Codex R2#3)**:goal 文件敏感度≈append system prompt(含 issue/phase contract)。用 **resolved 绝对路径**(绝不把 literal `~` 传给 `/loop`),目录 **0700**、文件 **0600**(照 `TmuxAdapter.ts:723-738` append-prompt 的做法);**复用现有 runner state dir resolver / `FLYWHEEL_STATE_DIR`/`FLYWHEEL_RUNNER_STATE_DIR` 约定**,避免把 QA room / 多实例状态写到错根目录。列入 M1 验证清单。
- goal 文件是「不变目标」;runner 自己的 RUN 进度另计(不在本 scope)。

### 2.4 phase-aware（跟 FLY-793 三段集成;绑定见 M0)

goal 随阶段-agent 变(**793 off = 单体 runner byte-compat default**,goal = 全流水线到 PR);**绑定到 M0 敲定的真实 `sessionRole`/label/metadata**,不是纸面表:

| 阶段-agent | goal（outcome) | 停在（hard stop) |
|---|---|---|
| Design | exploration/research/plan committed + 过 design_review gate | design_review gate → handoff(close Design sub-issue) |
| Implement | implement(TDD)+ code review + 开 PR | approve gate |
| QA | 跑 QA + 写 verdict | verdict 落地 |
| 单体(793 off) | 全流水线到 PR | approve gate |

- **no-transport / `pr_handoff` / 非-Claude backend(agy/kimi)显式排除**:它们不走 approve gate/wake/ship(`Blueprint.ts:1143-1161`),**/loop 绝不改这条 contract**;这些 backend arming = no-op(byte-compat)。

### 2.5 loop 安全 + mandatory budget（R1#7,从 optional 升为必做)

- gate 阻塞 = 结构护栏(续跑永远到不了自合并,ship 仍 founder-gated)。
- 「无进展 turn → 停」防空转。
- **mandatory per-session budget**(env-gated conservative defaults,不是 optional):最大 continuation turns / 最大 wall-clock / 最大 no-progress count。**预算耗尽 → 停 loop + 发可观测 event**(接安全网)。
- durable arming state 记 `autocontinue_arm_attempts`;单 runner canary → 放大。

---

## 3. ② 安全网 → 真卡住可靠 page founder（R1#2/#5/#8)

### 3.1 founder page 语义(写死契约)

**产品契约(Annie 要的 818 core)**:runner **真卡住**(`runner_stuck_unhandled` fires)时,**founder 被可靠 page,不依赖 Lead 注意到 / Lead 转发**。

- **改**:给 `runner_stuck_unhandled` 增**显式 founder page path**——保证 root alert 或 guaranteed thread post **带真实 `<@founder>`**(合法 `FLYWHEEL_FOUNDER_DISCORD_USER_ID`),**不依赖 AutoRepairBot 的 `needs_human` 分支**(成功 nudge 也不能把 founder page 吞掉:nudge 是「试过了」,真卡住的 fallback page 仍要到 founder)。
- **delivery contract 绑 `alertUnhandled` return 语义(Codex R2#2,关键)**:`StuckDetector` 在 `alertUnhandled` 返 true 时才把 episode 标 `annieAlerted`、停重试(`stuck-runner-detector.ts:540-555`);现 `createStuckUnhandledAlerter` 把 `sent || queued || duplicate` 都当 resolved(`stuck-escalation.ts:427-492`)。**改**:alerter **只在真 founder page 成立时返 true**(可接受条件写死:root alert accepted **且** explicit founder mention post accepted,**或** durable queue item 明确含 founder mention 且会重试)。**missing/invalid founder id、thread create/post 失败、deadletter、只发了 root-alert 从没产生 founder page 的 duplicate → 一律不得标 `annieAlerted`,返 false 或写 durable retryable state + 发 meta-alert/ops-visible error**。若为免重复 ping 允许 `duplicate` 成功,**dedupe 的必须是 founder-page event 本身,不是只 dedupe root alert event**。「有日志/有 root alert」不等于 page 成功。
- **时间语义(R1#5,选 A + 可调 cadence)**:保留现有 **Lead-first + Q7 fallback**;「直达 founder」= **fallback page path 保证到 founder、不靠 Lead relay**。autoloop canary/prod 下可选**缩短 stuck poll cadence**(独立 knob / 调 `FLYWHEEL_IDLE_POLL_MS`)让 true-stuck 更快浮到 founder。
- **测试矩阵(必须覆盖)**:Hub on/off;`FLYWHEEL_ALERT_THREADS` on/off;AutoRepairBot attempted vs needs_human;founder id missing/invalid(fail 要可观测、不静默吞);deadletter/queue 失败。

### 3.2 与 /loop 协同 + 精确调静（R1#8,不误伤安全网)

- `RunnerIdleWatchdog` 同 tick 先驱动 stuck detector 再决定发 idle(`RunnerIdleWatchdog.ts:177-273`)——**M4 只允许静音 `runner_idle_detected` 的 Lead-facing 噪音,绝不关 stuck detector evaluation**。
- 保留 `quiet-classifier`(`quiet-classifier.ts:23-91`):`pending_gate`/`self_parked`/等合法 quiet 仍 suppress,「正在等 gate/答复」的 runner 不误报。

### 3.3 不做

不改 stuck-detector 检测算法;不删 watchdog;不碰 founder-only-authority。

---

## 4. 实施顺序（per-milestone,每段带验证;TDD)

> 每步先写失败测试 → 最小实现 → 过;每 milestone 后跑验证再前进。

- **M0 FLY-793 head reconcile（前置,R1#4)**:基于 PR #430 head(或合并后)列出确切 role enum/label/session metadata;定义 793-off 单体 byte-compat default;显式标注 no-transport(`runnerTransportMode==="none"`)/`pr_handoff`/非-Claude backend 的 arming = no-op。**产出:phase→goal 模板的真实字段绑定表。** 验:单测 role→模板映射;no-transport/pr_handoff arming no-op;793-off = 单体默认。
- **M1 durable goal 文件 + goal 契约模板 + budget**:写 goal 文件(phase 模板 + blocking/non-blocking 区分 + mandatory budget);env-gated 默认 off。验:flag off = 注入 byte-identical;flag on = goal 文件内容正确 + phase 模板选对 + non-blocking ask 不阻断 loop / blocking question gate 硬停 + budget 字段在。
- **M2 R1b 入 loop(lifecycle-bound arming + one-shot + durable state)**:观察到 input box → send `/loop <goal 绝对路径>` 一次;terminal/gate-pending 不 arm;显式长 `ARM_WINDOW_MS` 才 fail-closed;durable `autocontinue_armed`。验:flag off 无 send;spawn 失败无 send;initial prompt active 时不 send;**长首轮(超过短 probe interval)结束后 input box 出现→仍恰 arm 一次**(Codex R2#1:这条是 FLY-818 是否真被修的关键测试);idle input box 后只 send 一次;**Bridge retry / restart 不重复 arming**;超长窗 fail-closed 有 audit;terminal/gate-pending 各写对应 audit。
- **M3 founder page 显式化 + delivery contract(R1#2/#5 + R2#2)**:`runner_stuck_unhandled` → guaranteed founder `<@founder>` page(不依赖 needs_human 分支);`alertUnhandled` **只在真 founder page 成立才返 true**。验:§3.1 测试矩阵全覆盖 + **断言「no real founder page ⇒ `alertUnhandled` false / detector 会重试」**(不只断言有日志/deadletter);missing/invalid founder id、thread 失败、root-only-duplicate 都不得标 `annieAlerted`。
- **M4 精确调静(R1#8,轻)**:只静音 `runner_idle_detected` Lead 噪音;stuck evaluation 不受影响。验:autoloop on + quiet pending gate 不报 idle;autoloop on + true stuck 仍进 `runner_stuck_unhandled`;pending gate/self-parked 仍被 quiet-classifier suppress。
- **M5 real-runner E2E(R1#6)**:真 Flywheel runner 自续跑跑完一段、blocking gate/question 停、non-blocking ask 继续、真卡住 → founder 收到 @page;**含 Bridge restart before/after arming + 长上下文/compaction 后仍能找到 goal**。验:真机 PASS(独立 QA)。

## 5. 测试策略

- 单测:goal 注入 byte-compat(flag off)、phase 模板选择、blocking vs non-blocking 区分、budget 耗尽不 reschedule / 不误触 founder-only ship、stuck→founder page 矩阵、quiet 不误报、arming 幂等/fail-closed。
- 集成:与 FLY-793(PR #430)、FLY-368 AlertChannelHub 不撞(基于/兼容其分支;实现时核 in-flight head)。
- real-runner E2E(QA):自续跑 / blocking 停 / non-blocking 继续 / 真卡住→founder @page / Bridge restart arming / compaction goal 恢复。

## 6. Rollout & gates

Codex design review(本 plan)→ **回来给 Annie 过目** → implement(TDD)→ Codex code review → 独立 QA(real-runner)→ founder ship。默认 off、opt-in、单 runner canary → 放大。

## 7. 风险 & 依赖

- **arming readiness / durable state**:R1b + M2 覆盖;fail-closed 兜。
- **FLY-793 / FLY-368 in-flight**:M0 reconcile;基于其分支或干净合并,实现时核 head。
- **模型跑偏(方向错但有进展)**:/loop + 安全网都不专抓(现状也没解决);靠 goal 契约 + gate + 「无进展就停」+ budget 缓解,不在本 scope 强攻。
- **续跑烧 token**:mandatory budget + gate 阻塞 + opt-in 灰度。

## 8. 交付物

代码(M0-M4)+ 测试 + 本 plan 归档 + real-runner QA 证据(M5)。C/D/E/F(FLY-820–823)独立推进。

---

## 9. 实现状态（2026-07-03,PR-1）

- **M0 ✅**（`resolveAutocontinueTarget`:claude-tmux 判 + role→phase,monolithic 默认 byte-compat;codex/agy/kimi 排除）。
- **M1 ✅**（`buildGoalContract` phase-aware + blocking/non-blocking 区分 + mandatory budget;durable goal 文件 0700/0600 + `FLYWHEEL_RUNNER_STATE_ROOT` 隔离)。
- **M2 ✅**（`decideArmingAction` lifecycle-bound + 命门『长首轮结束恰 arm 一次』测;`AutoContinueArmer` worker + durable armed marker 抗重启幂等;plugin.ts 接线 gated `FLYWHEEL_RUNNER_AUTOCONTINUE=1` 默认 off）。
- **M3 ✅（issue-thread,Annie 定稿 · lead-instruction 7bb06c0f/0807c747 + Lead gating 拍板)**：founder page 复用 **FLY-605 现成的 issue-thread 推送通道**(`emitFounderStuckNotification`,新增在 `founder-thread-notifier.ts`,复用 `postFounderThreadCore` + `allowed_mentions:{users:[owner]}`)—— 往**卡住 runner 自己的 [FLY-XX] issue chat_thread** post 带真 `<@founder>` 的消息,用**该 runner 所属 lead 自己的 bot**(`lead.botToken ?? config.discordBotToken`)。**不是 DM、不是 alert channel**(alert channel = 代码库 FLY-523 已否决的路,我先误建了 channel-only 版 f1d82ec6/039f2aaf 后作废)。落点在 `createStuckUnhandledAlerter`(stuck-escalation.ts,它手头有 session.issue_id + 已解析 lead + `getChatThreadByIssue`),**Hub M3 全撤**(`ensureFounderPaged`/`postToChannel`/`unifiedChannelId`/`AlertResult.founderPaged` 删,Hub 回到只管 alert-thread+auto-repair);**no secrets in payload**(botToken 绝不进 AlertPayload metadata)。ledger 单调收敛 + `founderPaged` 门控 `annieAlerted`(真 posted 才 resolve,否则 detector 重试;`no_chat_thread`=transient)。**gating = default-ON + kill-switch `FLYWHEEL_STUCK_FOUNDER_PAGE=0`**(Lead 拍:安全网 default-off 等于没做,合 Annie『真卡住必须有人告诉我』+ default-enable 原则;额外要 owner id + store,否则 legacy byte-compat 不 storm)。① autocontinue 半仍 default-OFF。**返工 head 变 → 重过 Codex code review + 独立 QA 真机验 issue-thread 版。**
- **M4 ⏳ DEFER(follow-up,不阻塞 PR-1)**：idle-watchdog 协同静音 = 「可选,轻」。因 autocontinue **默认 off**,production 行为零变化;M4 只在 canary(autocontinue on)时才有意义(避免 idle-watchdog 与 /loop 双重打扰 Lead),且需 watchdog 感知 autocontinue 状态(耦合)。留作 canary 观察到 idle 噪音时的 fast-follow。**绝不关 stuck evaluation** 的约束已在 M3 天然保住(M3 只加 founder page、没碰 idle/stuck 检测)。
- **M5 = QA**(独立 real-runner E2E,含 Lead 硬要求:真机验 **founder 在卡住 runner 自己的 [FLY-XX] issue thread 真收到带 `<@founder>` 的 page**(真卡住 → 该 issue thread 出现 @founder 消息 + @ 真推送到 Annie)、ledger 收敛零 spam)—— 由独立 QA runner 做。

测试:102 FLY-818 单测绿 + 全 teamlead 测试套 byte-compat 过 + teamlead tsc 0 错 + biome 干净。
