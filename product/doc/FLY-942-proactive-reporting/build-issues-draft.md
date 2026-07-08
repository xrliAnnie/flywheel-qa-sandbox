# FLY-942 Build-issue 提案(交 Tadashi)— 只提议,不 create-issue

Issue: FLY-942 (https://linear.app/geoforge3d/issue/FLY-942/watchdog-lead-主动汇报机制-产品设计-prd让-annie-不再当人肉-qa)
日期: 2026-07-08
基于: prd.md(Codex design-review APPROVED,3 轮)、母 Epic FLY-989

> 本文把 PRD §9 workstreams 拆成给 Tadashi 的 eng issue 提案(parent=FLY-942,挂 Epic FLY-989)。**不 create-issue**(founder-gated:Annie 拍 + Tadashi 建)。**⚠️ BI-4 的 T1 时序待 Annie 终确认(§4.3 HIGH-1)。**

## 提议的 build issue(5 个,含依赖排序)

### BI-1 · 检测层准确性(核心,最大)— PRD §3 / W3
**做什么**:把"卡没卡"从粗信号(idle 时长/alive-flag/message 匹配)升级到**读 per-pane 富态**(token-flow + 会话 FSM 态)判三态 **a 在跑 / b parked / c 真卡死**;机械快路初筛 + **FLY-976 LLM 判断层**兜可疑;**观察窗 ≥2 帧二次确认**(输入=live-region diff/token-flow/FSM/近 CommDB 事件/时长);修 `isIdleHealthyPane` 误压(FLY-975);认不出 → `fail-suspicious` 附 pane 原文不静默。
**依赖**:FLY-976(LLM 层)/ 975(isIdleHealthyPane)/ 937(lead capture-pane 协议)/ 778(自动读 pane)/ 927(park 元组/归因)。
**验收**:FN0-FN3(真态 c)**100% 不漏** + fail-suspicious 兜底;FP0-FP2(真态 a/b)不误报;L1(937 协议)。
**前置于**:BI-3/BI-4(汇报依赖 a/b/c 分类)。

### BI-2 · 检测 cadence / 时延契约 — PRD §4.6 / W-cadence
**做什么**:廉价 gap/state 扫描每 N 分钟(读 CommDB `runner_declared_states`/ask/stage,不抓 pane)+ pane 观察帧 M 分钟内 + **首个 actionable Lead 提醒 ≤ ~20min**(global+per-project 可配)。现 `DEFAULT_IDLE_POLL_MS = 3_600_000`(~1h)必须改。
**验收**:写明 max 检测时延;20min 至少保证廉价 gap 检测(pane 诊断可更粗,eng 定)。

### BI-3 · 两漏兜底 → Lead 提醒(汇报层)— PRD §4.2/4.5 / W1
**做什么**:漏① runner 没找 Lead / 漏② Lead 漏应答,超阈值 → **进对应 [FLY-XX] thread(自然语言)+ 经 Lead inbox/mailbox 通知 owner Lead**(复用 FLY-161 `runner_question`→Lead inbox / FLY-168 mailbox wake;**不用 founder-only 的 `founder-thread-notifier`**)。目标 Lead = 按 parent issue dept label 解析。**Lead-ACK 契约**:disposition/relay/dismiss;超 grace 无 ACK/不可达 → 升级 **@Annie(T2)**。
**依赖**:BI-1(分类)、Lead inbox/mailbox。

### BI-4 · case-c founder page(T1)— PRD §4.3 / W2　⚠️ 时序待 Annie 确认
**做什么**:检测判定 case-c(真卡死)→ **看门狗当场立刻 @ Annie**(经 `founder-thread-notifier` 的 founder @ 路)**+ 并行通知 owner Lead**(Lead 仍按 937 capture pane 去修)。这是系统唯一"立即打断 Annie"。
**依赖**:BI-1。**⚠️ 若 Annie 要 case-c 也走 Lead-grace(而非立即),改本 issue 的时序(先 Lead grace,再 @)。**

### BI-5 · over-notify 抑制 — PRD §3.4 / W4
**做什么**:已知/正清理/已升级的问题**绝不 re-alert**(治 FLY-970 ghost 死着刷 session_stuck);复用 claims.db/episode-latch + "清理中"抑制态 + owner 归属链。
**依赖**:970/973。

## 排序
BI-1(检测)+ BI-2(cadence)先行(汇报准确性/时延的地基)→ BI-3/BI-4(汇报,依赖 BI-1 分类)→ BI-5(可并行)。

## 明确移出 942 build(follow-up / sibling,非本次)
- **auto-QA-spawn gate**(product/no-three-stage issue 不该自动 spawn QA,治 ghost 源头)= **FLY-579 / 707**。
- **ghost 清理 / 子 session scope**(归 parent lead)= **FLY-970 / 973 / 962 / 978**。
- **mid-turn hard-stop**(kill 当前 turn)= **独立 issue**(harness 能力,待 Annie 定是否纳入)。
- 持久显示(置顶/标题)= **FLY-964**;通知管线(频道/工单/profile 切换)= **FLY-915**。

## 边界铁律(给 eng)
- 汇报 **全进对应 [FLY-XX] thread、自然语言**;**无 founder 频道 / 无决策卡模板 / 无 digest**。
- Lead 提醒走 Lead inbox/mailbox;**只有** T1 case-c / T2 Lead-接不住 才 @ Annie。
- 942 的"无频道/digest"**不动** FLY-915 的 infra alert 管线(独立)。
