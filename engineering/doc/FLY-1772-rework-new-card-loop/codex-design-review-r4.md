# Design Review — plan.md (FLY-1772) (Round 4)

Date: 2026-08-14
Author: Codex
Status: APPROVED

## Summary

Round 4 已关闭上一轮全部四项：不可绑定 deadletter 的 fallback 现在以可重读的 durable queue receipt 为准，project drain 保持 rowid 顺序；D4 reaction watch 有固定 expiry/cadence，text leg 也能在 identity 漂移与 enqueue race 下安全收敛。结合现有 `StateStore`、`LeadInboxRuntime`、GatePoller、Discord binding 与 workflow alert outbox 接口复核后，方案可实现、边界完整，已达到 implement-ready。

## What's Good (Keep)

- D3 的两分支可靠性合同明确：可绑定输入由 StateStore 单事务提交 deadletter、outbox 与 run event；不可绑定输入先进入 idempotent `LeadInboxRuntime.enqueueInfraAlert` durable queue，拿到 receipt 后才允许 legacy deadletter/cursor advance。
- fallback 拒绝或异常会立即停止当前 project drain，保证 row N 未处置时 row N+1 不会越过 cursor；single-flight 与 boot early-holder 测试覆盖了启动和慢投递重入。
- `card_watch_expires_at` 在 void→done 时一次性固定，`card_watch_next_at = now + 10min` 使用绝对时间推进；48h GET 上界、公平性、长停机无 catch-up burst 均可被非空测试验证。
- 旧卡 REPLY 的 exact reference 高于 sole-current-gate fallback，alert 未 durable 前 pin、成功后不触碰任何 gate，准确满足“旧卡永不接受操作、founder 零回执”。
- D4 text leg 的 existing-outbox same-run 快路及 conflict 后重读，关闭了 reaction 先告警、Lead identity 后漂移导致 cursor 永久 pin 的窗口。
- 五个 supersede writer 已统一并保留 founder_feedback exactly-one fence；void 第五次失败的状态、告警和 run event 同事务，精确 binding/audit 仍是 Discord edit 的唯一 authority。
- materializer 同时处理 `{ok:false}`/throw，并在告警前重读 holder/run；静态 payload、closed disposition union 和 real handler/CommDB E2E 测试共同钉住了 fail-loud 合同。
- 方案复用现有 timer、durable queue、outbox 与 PATCH primitive，没有新增 env/flag，也没有打开旧卡复活或 terminal-land 边界，符合 founder 的 scope 裁定。

## Issues & Recommendations

1. 无阻断项。实现时可做一个非必要优化：void edit 得到 exact 404 时卡已不存在，可将 watch deadline 直接结清，避免对已删除消息进行后续 bounded reaction GET；这不影响本计划的正确性或批准结论。

## Verdict

APPROVED — ready to implement
