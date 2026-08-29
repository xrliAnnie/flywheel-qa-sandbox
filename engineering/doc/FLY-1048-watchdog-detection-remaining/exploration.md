# FLY-1048 Watchdog detection 剩余实现 — 探索

Issue: FLY-1048 (https://linear.app/geoforge3d/issue/FLY-1048/build-fly-942-watchdog-detection-剩余实现prd-fly-942排除已-ship-的-watchdog)
日期: 2026-07-09
基于: 无(本文件夹首篇);跨文件夹上游 = product/doc/FLY-942-proactive-reporting/prd.md(权威 PRD,Annie 定稿 + Codex 3 轮 APPROVED)、同文件夹 build-issues-draft.md(4 个 detection BI 提案)、engineering/doc/FLY-927-alert-ticket-queue/plan.md + qa-report.md(已 ship 的 Watchdog v2 范围)

> 本文 = issue 点名的起手交付物:「剩余 detection 缺口清单」(PRD 要求 vs main 现状 vs 927 已覆盖),用于 brainstorm gate 确认 scope。所有 main 现状断言均经三路并行代码审计核实,附 file:line。审计基线:分支 flywheel-FLY-1048(= main,HEAD 6eff19b8)。

---

## 0. 一句话

FLY-942 PRD 的 detection 侧要求「读 per-pane 富态判三态(a 在跑 / b parked / c 真卡死,C 绝不漏)+ 观察窗 ≥2 帧 + LLM 判断层 + 分钟级 cadence + 统一 Lead-first ~30min 升级流 + 两漏兜底」;FLY-927 只落了其中的 **park 元组归因 + 1h founder-gate 巡检 + 真话措辞 + runner_throttle_stalled 细分 + idle 验收 fixture** —— 检测准确性(BI-1)、cadence(BI-2)、统一升级流(BI-3)、over-notify 抑制的 ghost 部分(BI-4)在 main 上**全部或大部未实现**。

## 1. FLY-927 已覆盖(不重做,红线)

| 927 落地物 | 位置 | 对应 PRD |
|---|---|---|
| ParkTuple 派生(4 类 party:founder/lead/runner/ci,stage 取权威 session_stage 绝不猜) | packages/teamlead/src/bridge/checkpoint-park.ts:22-146 | §3.2 归因 |
| 1h checkpoint 巡检(仅 party=founder;两窗:先 wake owner runner+Lead → 再 1h 无 evidence 才 page founder 进 issue thread) | gate-poller.ts:1461-1646,FLYWHEEL_CHECKPOINT_WATCHDOG(默认 OFF)+ FLYWHEEL_CHECKPOINT_STUCK_MS(默认 1h) | §3.2b 升级流(部分) |
| 真话措辞收口(formatParkAlert 模板;three_stage_stuck + lead-pending 文案从 tuple 派生;stage 缺失渲染「(stage未上报)」) | checkpoint-park.ts:153-161;plugin.ts:4649-4678;gate-poller.ts:1333-1347 | §3.1 归因不猜(FLY-912) |
| runner_throttle_stalled kind(529 残留 + 无行级 retry → 细分 stagnation) | stuck-candidate.ts:349-363 | §3.3 rate-limit 类 |
| idle≠冻结验收 fixture(断言现状抑制行为,**不是**修 isIdleHealthyPane) | LeadWatchdog 测试(927 Task 3.5) | §7 FP 组(仅固化现状) |
| 告警频道侧(Router 三分路由/工单 schema/门禁/20min 令牌桶/owner map/T2)——**属 FLY-915 channel 侧,与 1048 无关** | infra-event-router.ts 等 | PRD §8 边界 |

## 2. 剩余 detection 缺口清单(PRD 要求 vs main 现状 vs 927)

### BI-1 检测层准确性(PRD §3.0–3.2c / §7)— 缺口:全部未实现

| # | PRD 要求 | main 现状(code-grounded) | 927 覆盖? |
|---|---|---|---|
| 1.1 | 三态 a/b/c 判定,读 per-pane 富态(token-flow + FSM 态) | 无三态概念。Lead 侧 classify = 单帧 regex(LeadWatchdog.ts:598);runner 侧 = 全文 sha256 指纹相等去抖(stuck-candidate.ts:157-159, 285) | 否 |
| 1.2 | 观察窗 ≥2 帧跨时间**内容比对**(live-region diff / token-flow delta / 静默 delta) | 不存在任何 ≥2 帧内容 diff。LeadWatchdog 是 liveHash 布尔相等 + stuckCycles 计数(:315-341);stuck-candidate 的"两帧"本质是去抖:指纹变 = 重置 firstStagnantAt,永远看不到"变了什么" | 否 |
| 1.3 | 修 isIdleHealthyPane 单帧误压(FLY-975/546:error-then-idle 判 healthy) | 仍是单帧白名单(LeadWatchdog.ts:826-841);自认盲点:frozen-mid-thinking 与 idle-after-thinking 单帧不可分,favouring no-spam 压掉(:678-682) | 否(Task 3.5 只加 fixture 固化现状) |
| 1.4 | 错误串扩充:「Server error mid-response」「Not logged in」「ENOENT」 | **三个全无识别器**(grep 全 teamlead src 确认)。BLOCKED_KEYWORDS 只有 rate/usage/login-expired/permission 四类(LeadWatchdog.ts:138-154)。「Not logged in」不匹配 login+expired 正则;ENOENT 只出现在 Node fs 错误码判断,从不作 pane 模式 | 否 |
| 1.5 | 重复错误签名(变但循环同错,FN1 910 ENOENT 死循环) | stuck-candidate.ts:16-20 **自认 MISS**:任何字节变化重置停滞计时,retry-loop/spinner 永远到不了阈值 | 否 |
| 1.6 | LLM 判断层(= FLY-976 eng:便宜小模型、跑 Codex 不占 Claude 额度、读文字、generic prompt、ad-hoc 无状态;可疑才升级) | 检测路径 100% 确定性正则/hash,零 LLM 调用(全路径 grep 确认)。相邻积木:account-heal/detection-classifier.ts 有可选 Haiku Layer-2(FLY-799),但未接入任何 watchdog 路径,且跑 Claude 非 Codex | 否 |
| 1.7 | fail-suspicious:认不出 → 附 pane 原文上报,绝不静默压掉 | Lead 侧无此路径:isIdleHealthyPane / isTransientThrottlePane 命中即静默回 Healthy(LeadWatchdog.ts:364-367, 404-411),不确定则 fail-open 成 pane_hash_stuck 但**不带 pane 原文**(:1045-1052 隐私剥离);runner 侧 escalation 带 evidence.tail 15 行(stuck-candidate.ts:315-320)但只在 10min 停滞门之后 | 否 |

> 验收合同(PRD §7):FN0-FN4(真态 c)100% 不漏 + FP0-FP3 不误报 + fail-suspicious 兜底。当前 main 对 FN0(910 auth)/FN1(910 ENOENT 循环)/FN2(546/975 error-then-idle)/FN3(837 /compact silent)**结构性全漏**;FN4(574 draft-not-sent)属传输层对账,部分积木已在(mailbox writeVerified / lead_events delivery_attempts / founder-thread onUndeliverable)但无统一对账检测。

### BI-2 检测 cadence / 时延契约(PRD §4.6)— 缺口:未实现

| # | PRD 要求 | main 现状 | 927 覆盖? |
|---|---|---|---|
| 2.1 | 廉价 gap/state 扫描每 N 分钟(读 CommDB runner_declared_states / ask / stage,不抓 pane) | 分钟级 CommDB 读取者只有 GatePoller(3s tick,gate-poller.ts:329;60s 子巡逻),但它**只扫 messages**(gate/ask relay + 阻塞 gate 催办),**不读 runner_declared_states**;唯一读 declared states 的是 ~1h 的 RunnerIdleWatchdog/HeartbeatService,且只用于**抑制**唤醒(stuck-escalation.ts:241-256 → quiet-classifier) | 否 |
| 2.2 | pane 观察帧 M 分钟内 ≥2 帧 | RunnerIdleWatchdog 默认 DEFAULT_IDLE_POLL_MS = 3_600_000(~1h,FLY-628 band-aid;stuck-escalation.ts:88);stagnant 确认需相邻两次 poll → 最坏 ~2h+ 才到 candidate | 否(927 沿用 1h) |
| 2.3 | 首个 Lead 提醒 ≤ ~20min;验收写明 max 检测时延 | 现状最快 ~75min(乐观下限):1h poll + 10min 停滞 + 5min Lead grace | 否 |

> 约束(FLY-628 血统,设计红线):poll 拉到 1h 是为了止血 token(假警唤醒 Lead 烧 context)。BI-2 的高频部分必须**零 token**(纯 SQL/文字 diff),贵的 pane capture + LLM 只对可疑对象窄化触发 —— 这正是 PRD 机械快路 + LLM 慢路的用意。

### BI-3 统一升级流(PRD §4.2–4.5 / §9 W1)— 缺口:大部未实现

| # | PRD 要求 | main 现状 | 927 覆盖? |
|---|---|---|---|
| 3.1 | 统一规则:检测(两漏 + case-c)→ **立刻通知责任 Lead**(对应 [FLY-XX] thread + Lead inbox/mailbox)→ Lead ~30min 没解决 → 才 @ Annie | **不存在统一流**。5 条碎片 ladder 阈值各异:checkpoint-park(1h+1h,仅 founder-gate)/ stuck-runner(10min+5min grace → Q7 page)/ lead-pending(20min×2^n cap 2h,3 轮 → page Annie,仅阻塞 gate)/ founder-thread fallback(10min grace 直推 founder)/ idle(无 founder 升级)。「~30min」阈值不存在 | 部分(碎片之二属 927/637) |
| 3.2 | 两漏①:runner parked/需要人但没找 Lead → 提醒 Lead | **零检测,且语义相反**:park 只写 runner_declared_states(db.ts:31-38),不通知任何人;唯一消费者用它**抑制** watchdog 唤醒(quiet-classifier self_parked → mayWake=false)。无任何代码 join declared_states × messages(to_agent=lead)判断「parked 但没告诉 Lead」 | 否 |
| 3.3 | 两漏②:runner 找了 Lead、Lead 漏应答 → 再提醒 Lead | 只覆盖**阻塞 gate**(FLY-637 ladder,gate-poller.ts:1238 硬过滤 checkpoint==="question");**非阻塞 ask(checkpoint=NULL)投递一次后裸奔**:无催办、不在 guardrail 重投集合;更糟,pending question 让 hasPendingQuestionsFrom 返回 true → **反而抑制** stuck 检测(stuck-escalation.ts:226 硬门) | 部分(仅阻塞 gate) |
| 3.4 | Lead-提醒投递契约:thread 帖(自然语言)+ Lead inbox,**不用 founder-only notifier** | 积木在、组装缺:emitIssueThreadInfraNotification 支持任意 mentionUserId(founder-thread-notifier.ts:644-647)但**所有现有 caller 都传 founder id,无 @Lead thread 通知路径**;lead_event(appendLeadEvent + runtime.deliver)与 mailbox(MailboxLeadRuntime.deliver)可复用 | 否 |
| 3.5 | Lead-ACK 契约(disposition/relay/dismiss)+ ~30min 计时器 | stuck-runner 有 per-episode disposition + 5min grace(单一场景);无统一 ACK/计时器 | 部分 |
| 3.6 | fleet 级排除(一片同挂走 915 即时 Alerts,不走 30min) | 915/927 频道侧已 ship,可直接约定边界 | 是(边界侧) |

### BI-4 over-notify 抑制(PRD §3.4 / §9 W4)— 缺口:部分

| # | PRD 要求 | main 现状 | 927 覆盖? |
|---|---|---|---|
| 4.1 | 已知 / 已升级问题绝不 re-alert | 大体已有:claims.db + episode-latch(FLY-218/220)、stuck episode escalated flag、founder_page_ledger、checkpoint-park durable markers | 大部是 |
| 4.2 | 「正在清理中」抑制态 + ghost(status=running 但进程/pane 死,FLY-970)检测+清理挂钩 | 无「清理中」态;ghost 检测部分由 HeartbeatService reapOrphans(60min heartbeat stale → force-fail)兜,但 FLY-970 型「死着还 fire session_stuck」的抑制态缺 | 否 |

## 3. 关键设计张力(brainstorm gate 要确认的)

1. **FLY-976 归属**:BI-1 的 LLM 判断层 = FLY-976 的 eng 实现。build-issues-draft 把它并进 942 build(BI-1 依赖清单第一位)。→ 建议:1048 直接落地 LLM 判断层(便宜档、跑 Codex、ad-hoc 无状态),完成后 976 关联/关闭;不另开 issue。
2. **两漏检测 = 语义反转**:现在「parked / pending-ask」是**抑制**信号,942 要它们变成 gap①/② 的**触发**信号。必须精确定义「需要人」判据(park + 无 Lead 通信 / awaiting_review 无 evidence / ask 未答超时),否则每个健康 parked runner 都会变 Lead spam —— 与北极星(不刷屏)直接冲突。
3. **~30min 统一 vs 已拍的 637 阶梯**:PRD §4.3 说统一 Lead-first ~30min;但 FLY-637 阻塞-gate 阶梯(20min×2^n、3 轮页 Annie)是 Annie 已拍的阈值,927 plan 明确「party=lead 不新发,637 在管」。→ 建议:统一升级流管**新检测类**(case-c + 两漏①② + 非阻塞 ask 超时),637 阻塞-gate 阶梯保留不动;二者不重叠(637 管阻塞 gate,942 流管其余)。
4. **cadence vs token(FLY-628 红线)**:高频层必须零 token;1h pane poll 不能简单调小 —— 要新增「廉价 CommDB gap 扫描(分钟级,piggyback GatePoller tick)」+「可疑对象窄化 pane 取帧(≥2 帧,分钟间隔)」两层,而不是全局提频。
5. **FN4(574 draft-not-sent)**:传输层对账,非 pane 检测。验收含它(FN 组 100%),但实现是另一类机制(send-confirm/outbox 对账)。→ 建议:纳入 scope 但独立小块,复用 lead_events delivery_attempts / mailbox writeVerified 现有审计。
6. **明确不在 1048**(PRD §9 已移出):tool-call-leak(FLY-941)、ghost 清理/scope 归属(970/973/962/978,BI-4 只做「不 re-alert」+「清理中」抑制态挂钩)、mid-turn hard-stop、持久显示(964)、频道/工单管线(915,已 ship)、auto-QA-spawn gate(579/707)。

## 4. 建议 scope(待 gate 拍)

**FLY-1048 = 942 build 的全部 4 个 detection BI(减 927 已覆盖行)**,按依赖切 PR:

- **PR-A(地基)**:BI-1 机械层 + BI-2 cadence —— 错误串扩充、重复错误签名、≥2 帧观察窗(跨帧静默/重复签名 delta)、isIdleHealthyPane 多帧化、廉价 CommDB gap 扫描(分钟级)、可疑对象窄化取帧、fail-suspicious 输出契约。
- **PR-B**:BI-1 LLM 判断层(FLY-976:Codex 便宜档 ad-hoc 判 a/b/c + 归因 + 建议动作;机械快路可疑才升级;不确定 → fail-suspicious)。
- **PR-C**:BI-3 统一升级流(两漏①② 检测 + case-c → 立刻通知责任 Lead:thread 帖 + Lead inbox → ~30min 无解 → @ Annie 经 founder 通路;Lead-ACK;fleet 级排除)+ BI-4 补齐(清理中抑制态)。

全部 env-gated、未设 = 字节兼容现状;ship founder-gated,标准三段式。

## 5. 附:审计中发现的现状事实速查(研究阶段直接引用)

- Lead 侧 pane 链:tickLead → ownStateRegion(剥 echo)→ liveRegion(锚输入框/末 12 行)→ classify(BLOCKED_KEYWORDS)→ isTransientThrottlePane(529 短路)→ isIdleHealthyPane(单帧抑制)→ 3-cycle pane_hash_stuck。
- Runner 侧链:RunnerIdleWatchdog(~1h poll)同一 capture 喂 stuckDetector(evaluateStuckCandidate:全文指纹 + 10min 停滞 + 硬门 gate/comm-30min/declared-state)→ runner_stuck_escalation(lead_event,guardrail 重投)→ 5min grace 无 disposition → Q7 runner_stuck_unhandled(ticket 或 founder page 进 issue thread)。
- HeartbeatService(5min tick)管 heartbeat/activity 时间戳类(15min session_stuck advisory、60min orphan reap、24h stale terminal、48h review timeout),不看 pane 内容,与 pane 链正交。
- 通知积木:lead_event(appendLeadEvent+runtime.deliver,GUARDRAIL_EVENT_TYPES 定义可重投集合)、mailbox wake(wakeRunnerMailbox,wake.ts:57-116)、issue-thread 帖(emitIssueThreadInfraNotification,可带任意单 mention 或无 mention)、founder page(emitFounderStuckNotification/emitFounderThreadNotification,founder-only)。
- CommDB 证据面:messages(question/response,checkpoint 列分阻塞/非阻塞)、runner_declared_states(park/long_task)、StateStore lead_events(投递审计)、session_events(founder_thread_notified / checkpoint-park markers)。「runner 告诉过 Lead」今天要自行 join messages(from=exec,to=lead),无现成谓词。
