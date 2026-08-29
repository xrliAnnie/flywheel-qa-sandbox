# FLY-869 流水线纪律收口 — 探索

Issue: FLY-869 (https://linear.app/geoforge3d/issue/FLY-869/infrapipelineconsolidated-流水线纪律收口-qa-该起没起原-868-merge-抢跑提前)
日期: 2026-07-04
基于: 无

## 1. 问题（Annie 的原始诉求）

一条 pipeline 从「Linear issue → brainstorm → 实现 → QA → founder 批 → ship/Done」，
现在**起点闸和终点闸都漏了**，导致两类事故反复发生：

- **没想清就做**：runner 不确定要修什么就开写，做出来跟 Annie 想的完全不一样。
- **没验就过**：QA 该起没起、QA 没过也能标 Done；runner 抢跑自 merge、提前 complete/Done。

三半是同一主题「pipeline discipline」的三道闸：

| 半 | 闸 | 症状 |
|----|----|------|
| **C**（最优先）| brainstorm 硬门（起点·对齐）| runner 不跟 founder 对齐就开做（722 这类 infra issue 完全不触发现有门）|
| **B**（并列最优先）| merge 抢跑（终点·批准）| 没经批准的 merge 也被标 completed/Done（joycon 复发，FLY-799 gap）|
| **A** | QA 该起没起 + QA 没过也 Done（起点·验证 + 终点·验证）| 819 建了从没跑；865 auto-QA 被静默卡；rebase 换 head 绑定失效；QA 没 pass 照样 Done |

## 2. Annie 的拍板决定（2026-07-04，经 Lead relay）

1. **C 半豁免默认**：所有 issue **默认必须过跟 founder 对齐这道门**，只有显式打
   trivial/纯机械豁免 label 才跳过。原话「这是必须的」。
2. **C 半 rollout**：**直接硬启用（enforce），不走 audit-only**。她的标准规矩 ——
   功能做了就 default ON、出问题紧急关。**别 default off**（她今天为此发过火）。
3. **B 半 merged-but-unapproved**：**不自动 revert**（太危险）。只做「不标 Done +
   issue 留 open + 响亮告警她」。
4. **A 半 QA 硬门豁免口**：纯文档 / no-code route / 显式 no-qa label / qa.auto:false
   不卡。
5. **交付形态**：**一个 PR** 三半一起 + 全链真机 E2E。

## 3. 关键约束 / 红线

- **fragile hot-spot**（58/115/120/208/799 都碰过）：B 半改 `merged→completed` 时
  **绝不能 regress「批准后已 merge 却卡 awaiting_review」老 bug**（FLY-115 v1.24.5 /
  FLY-120）。→ 测试里加**显式回归用例**。
- **姊妹 sink 同改**：B 半的 `merged→completed` 逻辑同时存在于
  `DirectEventSink.ts`（in-process sink）和 `event-route.ts`（HTTP /events sink），
  两者历史上必须字节级一致，否则踩坑。
- **flag 全部 default ON**（Annie 决定 ②）：与项目惯常「default off 字节兼容」相反 ——
  这是 founder 明确指令，覆盖惯例。保留紧急关的 kill-switch（env / config）。
- **不重造**：C 半复用 FLY-598（#369）已建好的验签/解锁/fail-close 全套，只改「谁触发」；
  B 半复用 `verify-approval` 已有的 durable 批准判定。

## 4. 不做什么（scope discipline）

- **不**自动 revert 抢跑的 merge（决定 ③）。
- **不**重写 founder-ux gate 的验签服务端逻辑（只翻触发条件）。
- **不**改 Codex review 硬门（FLY-827）—— QA 门与它**对称新增**，不动它。
- **不**碰与三闸无关的 pipeline 代码。
