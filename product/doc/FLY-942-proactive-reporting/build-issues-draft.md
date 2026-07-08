# FLY-942 Build-issue 提案(交 Tadashi)— 只提议,不 create-issue

Issue: FLY-942 (https://linear.app/geoforge3d/issue/FLY-942/watchdog-lead-主动汇报机制-产品设计-prd让-annie-不再当人肉-qa)
日期: 2026-07-08
基于: prd.md(Codex design-review APPROVED,3 轮)、母 Epic FLY-989

> 本文把 PRD §9 workstreams 拆成给 Tadashi 的 eng issue 提案(parent=FLY-942,挂 Epic FLY-989)。**Annie lgtm 定稿**(升级流 = 统一 Lead-first + ~30min)。927:**detection → 942 / channel → 915**,两侧不重叠。

## 提议的 build issue(4 个,含依赖排序)

### BI-1 · 检测层准确性(核心,最大)— PRD §3.0–3.2c / §7
**做什么**:把"卡没卡"从粗信号(idle 时长/alive-flag/message 匹配)升级到**读 per-pane 富态**(token-flow + 会话 FSM 态)判三态 **a 在跑 / b parked / c 真卡死**;机械快路初筛 + **FLY-976 LLM 判断层**(便宜小模型、**跑 Codex 不占 Claude 额度**、读文字、ad-hoc 无状态)兜可疑;**观察窗 ≥2 帧二次确认**(输入=live-region diff/token-flow/FSM/近 CommDB 事件/时长);修 `isIdleHealthyPane` 单帧误压(FLY-975);扩错误串(+`Server error`/`Not logged in`/`ENOENT`)+ 重复错误签名;认不出 → `fail-suspicious` 附 pane 原文不静默。
**依赖**:FLY-976(LLM 层)/ 975(isIdleHealthyPane)/ 937(lead capture-pane 协议)/ 778(自动读 pane)/ 927(detection)。
**验收**:FN0-FN4(真态 c,含 910×2/546/837/574)**100% 不漏** + fail-suspicious 兜底;FP0-FP3(真态 a/b,含 915 长turn)不误报;L1(937 协议)。
**前置于**:BI-3(汇报依赖 a/b/c 分类)。

### BI-2 · 检测 cadence / 时延契约 — PRD §4.6
**做什么**:廉价 gap/state 扫描每 N 分钟(读 CommDB `runner_declared_states`/ask/stage,不抓 pane)+ pane 观察帧 M 分钟内 + **检测那刻即通知 Lead**。现 `DEFAULT_IDLE_POLL_MS = 3_600_000`(~1h)必须改(否则 30min 阈值达不到)。
**验收**:写明 max 检测时延;廉价 gap 检测足够高频以支撑"发现→立刻通知 Lead"。

### BI-3 · 统一升级流(汇报层)— PRD §4.2–4.5 / §9 W1
**做什么**:检测(**两漏** runner 没找 Lead / Lead 漏应答 **+ 真卡死 case-c**)→ **立刻通知责任 Lead**:进对应 [FLY-XX] thread(自然语言)+ 经 **Lead inbox/mailbox**(FLY-161 `runner_question`→Lead inbox / FLY-168 mailbox wake;**不用 founder-only 的 `founder-thread-notifier`**);目标 Lead = 按 parent issue dept label 解析。**Lead ~30min 没解决/无 ACK/不可达 → @Annie**(经 `founder-thread-notifier` 仅 founder @)。**Lead-ACK 契约**(disposition/relay/dismiss)。**fleet 级排除**(走 915)。
**依赖**:BI-1(分类)、Lead inbox/mailbox、founder-thread-notifier。

### BI-4 · over-notify 抑制 — PRD §3.4 / §9 W4
**做什么**:已知/正清理/已升级的问题**绝不 re-alert**(治 FLY-970 ghost 死着刷 session_stuck);复用 claims.db/episode-latch + "清理中"抑制态 + owner 归属链。
**依赖**:970/973。

## 排序
BI-1(检测)+ BI-2(cadence)先行(准确性/时延地基)→ BI-3(统一升级流,依赖 BI-1 分类)→ BI-4(可并行)。

## 明确移出 942 build(follow-up / sibling,非本次)
- **auto-QA-spawn gate**(product/no-three-stage issue 不该自动 spawn QA,治 ghost 源头)= **FLY-579 / 707**。
- **ghost 清理 / 子 session scope**(归 parent lead)= **FLY-970 / 973 / 962 / 978**。
- **mid-turn hard-stop**(kill 当前 turn)= **独立 issue**(harness 能力,待 Annie 定是否纳入)。
- 持久显示(置顶/标题)= **FLY-964**;通知管线(频道/工单/profile 切换)= **FLY-915**。

## 边界铁律(给 eng)
- 汇报 **全进对应 [FLY-XX] thread、自然语言**;**无 founder 频道 / 无决策卡模板 / 无 digest**。
- Lead 提醒走 Lead inbox/mailbox;**统一 Lead-first**:检测(两漏+case-c)→ 立刻通知 Lead → **只有 Lead ~30min 没解决才 @ Annie**;fleet 级走 915。
- 942 的"无频道/digest"**不动** FLY-915 的 infra alert 管线(独立)。
