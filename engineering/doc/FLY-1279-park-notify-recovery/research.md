# FLY-1279 runner park 在门口无人知会 — 调研

Issue: FLY-1279 (https://linear.app/geoforge3d/issue/FLY-1279/fix-runner-park-在门口无人知会-founder-审批门-goal-blocked-qa-静默死掉都缺主动通知lead)
日期: 2026-07-14
基于: exploration.md

> 目的:把 exploration 批准的方案 B(B1 park-watch / B2 QA 死亡回踢 / B3 goal-blocked 传真)落到精确的接入点、数据源、状态机与防风暴设计,供 plan 直接引用。所有 file:line 基于本分支(flywheel-FLY-1279,base=main b11ebb4f0 前后)。

## R1. B1 park-watch — 真相源与枚举

### R1.1 等待态全集(真相源=session 状态,gate row 只是佐证)

| 等待态 | 数据源 | 判据 | "在等谁" |
|--------|--------|------|---------|
| 开着的 gate(brainstorm/question/approve_to_ship/自定义) | CommDB `messages`(`getPendingQuestions`,db.ts:760) | 未答未过期 question | checkpoint→party(checkpoint-park.ts `deriveParkTuple`) |
| founder 审批窗口 | StateStore `sessions.status='awaiting_review'` + `awaiting_review_entered_at`(StateStore.ts:2876) | 状态本身 | founder(或 QA:见 R1.3) |
| 批准后未 ship | `sessions.status='approved_to_ship'` | 状态 + `stale-approved-ship-reconciler` 已有 rewake | runner/ci |
| goal/route blocked | `sessions.status='blocked'`(B3 落地后含 goal-blocked) | 状态 | lead |
| 自声明 park | CommDB `runner_declared_states`(kind='parked',db.ts:1017) | 未过期声明 | lead(超长时) |
| **gate 行丢失**(Lead 补充,1262/1264 实证) | sessions 有 `review_question_id`/stage 显示等 gate,但 CommDB 无对应未过期 row | **交叉验证不一致 = 事故态** | lead(事故) |

关键点:**巡检以 StateStore sessions 为主表**,CommDB gates 做交叉验证。1254 形态(gate row 被 `evictTerminalGateQuestion` 驱逐/过期)和 1262/1264 形态(Bridge 重启窗口 gate 行消失)都只有 session 侧还留着事实。

### R1.2 措辞与推导:复用 `deriveParkTuple` / `formatParkAlert`

`packages/teamlead/src/bridge/checkpoint-park.ts:65-146`(FLY-927/912)已实现无猜测推导 `{stage, party(founder|lead|runner|ci), ownerLeadId, waitingSince, notifiedEvidence, nextStep}`。B1 需要扩展输入面:现在它只吃 gate question + session,需补 `runner_declared_states`、goal-blocked、QA-record 交叉(R1.3),以及"gate 行丢失"的不一致判定。

### R1.3 QA-held 精细化(穿透 1238 静默的关键)

现状 `isReviewHeld`/`isQaHeld`(auto-qa-held.ts:71-173)只回答"有没有 running QA record";park-watch 必须区分:

- **健康 hold**:`auto_qa_record.status='running'` 且 QA session `status='running'` 且心跳新鲜 → 维持一切压制(设计意图),但 QA 运行 > N3(2h,env 可调)→ 仅通知 Lead(不 page founder)。
- **事故 hold**:record `running` 但 QA session 终态(`failed`/`terminated`)或不存在 → **park-watch 立即通知 Lead**(B2 同时负责修复回踢)。判据全部是可验证事实(两张表交叉),不做时长猜测。

### R1.4 巡检宿主与 cadence

- 宿主:GatePoller 新 `onParkWatchTick` callback slot,照 `onGapScanTick`(gate-poller.ts:205-213)模板:cheap、零 pane、错误隔离、cadence 以 tick 计。建议 **20 tick(~60s)**,与 misroute patrol/founder-reply deliver 同档。
- 枚举成本:`getActiveSessions()`(StateStore.ts:3145)+ 每 project 一次 `getPendingQuestions` + `auto_qa_records` 活跃行——全部是已有索引查询,60s 一次可忽略。
- FLY-927 现有 patrol(gate-poller.ts:1758-1943,per-pending-gate、默认 OFF)的处置:**park-watch 是它的超集,吸收后退役旧入口**(保留 env 兼容语义,见 R6)。

## R2. B1 通知阶梯 — 三个现成状态机对比与选型

| 维度 | FLY-637-ext lead-pending(gate-poller.ts:1529) | FLY-1048 detection-escalation(detection-escalation.ts) | FLY-927 checkpoint-park(gate-poller.ts:1758) |
|------|------|------|------|
| 覆盖 | 阻塞 question 门 | 检测类事故 | brainstorm/approve_to_ship 门 |
| 持久化 | `lead_pending_escalation` 行 | `detection_escalations` 行(时钟锚 DB,漏 tick 不重置) | `session_events` once-marker |
| 阶梯 | nudge Lead ×N(指数退避 20min→cap 120min)→ page Annie 一次 | Lead-first → 30min grace → founder page(issue thread) | 1h → wake owner;再 1h → founder page |
| 去重 | 每 attempt 独立 eventId | 行状态机(LEAD_NOTIFIED→ESCALATED,ESCALATED 永不再报) | once-marker |

**选型:以 FLY-1048 的行状态机为骨架**(durable 行 + 状态推进 + 时钟锚 DB + ESCALATED 不再报),叠加 FLY-637 的"多轮 nudge + backoff"作为 Lead 档内的重复提醒策略。理由:1048 的 episode 语义已在生产验证(C5:CLEARING mute + TTL rebound),且"漏 tick 只延迟不重置"正是 60s cadence 巡检需要的性质。

新表(或复用 detection_escalations 加 kind 列——plan 定):`park_watch_episodes`,键 `(execution_id, park_kind)`,状态 `OBSERVED → LEAD_NOTIFIED → FOUNDER_PAGED → CLEARED`;`CLEARED` 由"等待态消失"(gate 答复/approval/QA verdict/unpark)在巡检 tick 判定,恢复后再阻塞=新 episode(对齐 FLY-1220 的 episode-latch 教训)。

### R2.1 阈值(per-party,全部 env 可调)

| park 类型(在等谁) | N1 → Lead | N2 → founder page | 备注 |
|---|---|---|---|
| 等 Lead(brainstorm/question/gate 行丢失/事故 hold/blocked) | 10min | +30min | 对齐 brainstorm 门先例 + 1048 的 30min grace |
| 等 founder(approve_to_ship/awaiting_review) | 10min(确认 ship 卡片已发;未发=事故,立即) | 卡片本身即 founder 面;N2 改为**重提醒**(+2h,温和) | 不与 FLY-1041 15s 卡片重复;park-watch 管"卡片之后没人动" |
| 等 QA(健康 hold) | N3=2h 仅 Lead | 不 page founder | QA-held 压制哲学保留 |
| 等 CI/runner 自身 | 30min 仅 Lead | 不 page | 低噪 |

### R2.2 投递通道

- → Lead:guardrail lead event(`appendLeadEvent`+`runtime.deliver`,新 event type 进 `GUARDRAIL_EVENT_TYPES` lead-runtime.ts:18-31 获得重投);同时可选 LeadAlertNotifier 镜像(新 kind 须同步 `ALERT_EVENT_TYPES`+kind-contract+lead-alert.sh allowlist——三处单一真相契约)。
- → founder:只走 `emitIssueThreadInfraNotification`(founder-thread-notifier.ts:611,issue thread + @owner);**绝不 alert channel**(FLY-523 铁律,Lead gate 里再次硬确认)。

## R3. B2 QA 死亡检测 + 回踢 — 接入点

### R3.1 event-scoped hook(主路径)

- 位置:`event-route.ts` `session_failed` 分支(:1567-1614 附近)+ `DirectEventSink` 对应位(三段式的 `reconcileQaLoss` 挂点 :2168-2184 / DirectEventSink.ts:1023-1067 是模板)。
- 逻辑:死者 execId 反查活跃 `auto_qa_record`(`qa_execution_id` 匹配,不依赖 fire-and-forget 的 `chat_thread_role`——修掉三段式 hook 的已知弱点)→ record 标 `stuck` + Lead 告警(复用 `alertLeadPipelineError`/`auto_qa_stuck`,auto-qa-effects.ts:409-449)→ **clean-retry 一次**。
- clean-retry:复用 `driveRetest` 的死-QA-respawn 路径(auto-qa-coordinator.ts:946-1012 已会"dead QA → re-spawn into the same QA issue"),前置 `WorktreeManager.removeIfExists`(FLY-99 清理,WorktreeManager.ts:382-464)。retry cap:每 record 1 次自动重试(计数落 record 列),再失败 → 保持 `stuck` + Lead 告警升级(park-watch R1.3 的事故 hold 通知兜底)。

### R3.2 周期 sweep 兜底(event 丢失时)

`reconcileOnStartup` sweep(3)(auto-qa-coordinator.ts:1795-1845)的逻辑本身正确,只是 boot-only(plugin.ts:6183)。把同一函数挂上周期宿主(GatePoller park-watch tick 顺带调用,或 HeartbeatService 5min cycle——plan 定,倾向前者:与 park-watch 同 tick 保证"检测到事故 hold"与"修复"同步)。幂等性已具备(record 状态机 + marker)。

### R3.3 worktree_takeover_failed 分场景

- **auto-QA(FLY-795 resume 误入 takeover)**:结构性修复=auto-QA 的 spawn 不该走 takeover——`run-dispatcher.ts:1074` 的 `resume→shareParentBranch=true` 对 auto-QA 是误伤;plan 里评估"auto-QA 场景显式 `shareParentBranch:false` 走 FLY-99 清理+重建"(QA 需要的只是 startPoint 的干净 checkout,没有 parked 前序 phase 要保护)。若评估有风险,退而求其次:takeover 失败后按 R3.1 clean-retry。
- **三段式(真 takeover)**:维持 fail-closed(不能丢 parked phase 未提交工作,Blueprint.ts:762-766 设计意图),但失败要发**专属告警**(新 alert kind,含 dirty/HEAD-mismatch 原因)而非只有泛化 session_failed;`reconcileQaLoss` 的 `chat_thread_role` 依赖同样换成 record/phase 表反查。

### R3.4 spawn 失败可见性(1238 第一层)

`RunDispatcher.start()` 先返回、Blueprint detached(run-dispatcher.ts:1149-1220)——不改这个结构(改=大手术)。靠 R3.1 的 `session_failed` hook 兜:takeover_failed 也是 `session_failed`,同一 hook 覆盖"spawn 后立即死"与"中途死"。

## R4. B3 goal-blocked 传真 — 改动点

1. **CodexTmuxAdapter.ts:691-695**:goal 终态 `blocked` 时 CommDB session status 写 `blocked`(不再写 "timeout"),`failureReason`(codex-daemon-adapter-helpers.ts:168 的 "goal ended non-complete: blocked")写进 session 记录字段(`last_error` 或 summary——正是 milestone patrol ground-truth guard(gate-poller.ts:2355-2373)要读的字段,一改两得)。
2. **Blueprint/DecisionLayer 透传**:goal-blocked 的终态 emit 带 route/status=blocked(对齐 `complete --route blocked` 的既有 Bridge 处理 event-route.ts:1072-1077),让 StateStore 状态真实为 `blocked` 而非 `failed`。
3. **milestone patrol 放开 role 过滤**(milestone-report-policy.ts:72-75):blocked → **所有 role 通知 Lead**;founder page 分级(main role 保持现状 page;phase role 只 Lead,park-watch N2 兜底升级)。
4. **与 FLY-1257 接缝**:1257(未 merge)加了 gate-hold latch——blocked-while-waiting 不算终态。本票判定"真 blocked"=goal blocked 且无未答 gate marker(`isWaiting()===false`)。写法上不 import 1257 的新模块,只按"到达终态才走本票路径"排序:若 1257 已 merge,被 latch 住的 blocked 根本不会到终态;若未 merge,本票把(可能误标的)blocked 也如实通知——比现状静默严格更好。**两个顺序都安全。**

## R5. 防风暴与去重(FLY-1218/1220 教训)

1. **episode 语义**(R2 状态机):每 (execId, park_kind) 一个 episode,LEAD_NOTIFIED 后同档静音(除 backoff nudge),FOUNDER_PAGED 后永久静音直到 CLEARED;恢复检测在每 tick(等待态消失→CLEARED),新阻塞=新 episode。
2. **eventId 设计**:`park-<execId>-<parkKind>-<episodeSeq>-<step>`——重启后同 episode 不重发(episode 行 durable),新 episode 可发。claims.db 原子 claim(LeadAlertNotifier 已有)做跨进程第二道。
3. **聚合**:同一 tick 发现 >5 个新 park 事故(如 Bridge 重启后批量)→ 聚合成一条 Lead 摘要而非逐条(misroute patrol 的 >10 聚合先例,FLY-208)。
4. **速率**:LeadAlertNotifier 自带 `FLYWHEEL_ALERT_RATE_PER_MIN`;founder page 每 issue 每 episode 最多一次。

## R6. 开关、灰度、兼容

- 主开关 `FLYWHEEL_PARK_WATCH`(default **ON**;`=0` 完全旁路,回字节现状)。分项:`FLYWHEEL_PARK_WATCH_FOUNDER=0` 只关 founder 档;阈值 `FLYWHEEL_PARK_N1_MS`/`_N2_MS`/`_QA_N3_MS`。新 flag 进 `packages/config/src/feature-flags/registry.ts`。
- FLY-927 `FLYWHEEL_CHECKPOINT_WATCHDOG`:park-watch 吸收其职责后,旧 env 仍被读——设 `=1` 时不双发(park-watch 优先,旧 patrol 短路),避免两套同时叫。plan 里写明退役路径。
- 灰度:**不做 audit-only 阶段**(Lead gate 已拍 default-ON;等待态通知本身低频、有 episode 去重,风暴风险可控;且 audit-only 会让验收第 4 条"真机重演"失真)。逃生口=`FLYWHEEL_PARK_WATCH=0` 单 env。
- reverse-compat sentinel:`=0` 时对 gate-poller tick 行为零增量(测试断言)。

## R7. 测试与真机重演底料

- 单测:episode 状态机(推进/CLEARED/重启幂等)、per-party 阈值路由、QA-held 健康/事故判别、gate 行丢失交叉验证、聚合、`=0` sentinel。
- 集成:module-driven 跑真 GatePoller tick + 内存 StateStore/CommDB,注入四类场景(审批门 park、goal-blocked、QA 死、gate 行丢失),断言 Lead event / founder thread 调用序列。
- 真机(QA phase,529 Room):重演 7-14 夜——(a) 起 implement→PR→审批门,杀 QA session(或注入 takeover_failed),验 Lead N1 通知 + clean-retry + implement 不永等;(b) 注入 goal-blocked,验 Lead/founder 通知;(c) Bridge 重启窗口建 gate 复现 1262 形态,验事故态通知。检测类 QA 必含真机段(memory 铁律)。

## R8. 与在飞工作的接缝

| 在飞 | 关系 |
|------|------|
| FLY-1257(未 merge 分支) | R4.4:接缝对其存在与否都安全 |
| FLY-1225/fix-cycle 缺陷清单(task #139:FAIL wake、belt flip、RE-TEST wake 等) | 不重叠:那是 verdict 之后的修复回路;本票是等待态通知+死亡检测。B2 的 clean-retry 复用其修复对象(driveRetest)但不改其逻辑 |
| FLY-560 thread-title badge | park-watch 不改 badge;事故 hold 时 badge 仍 🧪 是已知呈现瑕疵,不在本票范围 |
| FLY-1041 ship 卡片 | park-watch 不重复发卡;管"卡片之后"(R2.1) |
