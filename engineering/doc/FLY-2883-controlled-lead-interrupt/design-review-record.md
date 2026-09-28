# FLY-2883 受控打断 Lead — 设计评审记录
Issue: FLY-2883 (https://linear.app/geoforge3d/issue/FLY-2883/语音耳机bridge-受控打断-lead先记审计-正文进信箱标加急-插进它当前这一轮不让它停下手上的活-回复回到发起方claudecodex)
日期: 2026-09-25
基于: plan.md(v4,blob 44655e5701a27e97d4a87d81c41e49bddff3a9f5)

## 结论

APPROVED(R4,窄范围验证轮,Lead 裁定 1516eb97 选 A)。实现须在 FLY-2882 合入之后开始(Lead 同意并记账)。

| 轮 | 模型 / effort | 结果 | blocking + advisory |
|---|---|---|---|
| R1 | companion 默认(gpt-5.6-sol)/ xhigh,thread 01a0da36-9924-7d60-905e-d6de3d8dff30 | CHANGES REQUESTED | 8 + 1 |
| R2 | 同上(resume) | CHANGES REQUESTED | 4 + 2 |
| R3 | 同上(resume) | CHANGES REQUESTED | 1 + 2 |
| R4(窄范围:R3#1 修法 + v4 改动) | gpt-6-astra(manifest 指定)/ xhigh,thread 01a0da55-d41e-7cc3-89c6-bac979dd3c29 | **APPROVED** | 0 + 2 |

说明:R1–R3 用的是本机 companion 默认模型,不是 manifest 指定的 gpt-6-astra;Lead 裁定 R4 必须用 manifest 模型,R4 即按此执行。每轮处理明细见 plan.md §13。

## R4 advisory → 实现须知(不改 plan,以免批准绑定的 blob 失效)

1. **R3#1 测试要真能抓住 await**:除「调用前 tracker 已收到 `turn/started` → 走 steer」外,再加一例:fake snapshot 为 connected、seeded、activeTurns 空,返回时安排一个 microtask;断言 `submitBatch` 在该 microtask 执行前已被同步调用。只约束「读快照 → 发出副作用」这一段,不禁止等待 steer 回执。
2. **plan §10 的探针名过时**:§10 写的 `probeV2LeadPane("send")` 应读作 `probeV2LeadPane(…,"send_claude_child")`(capture 全部身份检查 + 恰一个 claude 直接子进程),以 §6.2 为准。旧 `send` / `sendEnterToWindow` 仍是 §12b 的 follow-up。
3. (R4 正文第 4 条顺带指出)`defaultLeadPaneCapture` 是返回 CaptureFn 的工厂:实现写 `const capture = defaultLeadPaneCapture(); await capture(ref, 150)`,plan 里的 `defaultLeadPaneCapture(ref, 150)` 是简写。

R3 的两条 advisory 已写进 plan §12(其中 R3#3 随 v4 失效)。
