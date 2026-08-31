# Design Review — FLY-2137 plan.md (Round 3)

Date: 2026-08-31
Author: Codex
Status: APPROVED

## Summary

Round 3 已完整关闭 Round 2 的 5 项问题：目标 blob `9da28227fbc810054cfda19e1c239d478d399c10` 对 version-qualified `gws` grammar、每日 sweep 状态机、坏 JSONL 收敛、mode transition 和 kind owner 都给出了可实现且可测试的合同。结合前两轮已收口的诚实边界、audit→enforce 顺序、QA 隔离、Raya 回归和 installer，本计划已具备进入实现的完整性；未发现新的阻塞项。

## What's Good (Keep)

- `gws calendar:vN` 现已按严格 `^calendar:v\d+$` 规范化为 Calendar service，`--api-version` 的 `=`/空格形态也进入 global-flag grammar；本轮只读实测再次确认 `calendar:v3 events insert|update|delete --help` 和 `--api-version v3 calendar … --help` 都是当前 CLI 的真实形态。
- introspection 合同与“读方法零误伤”一致，并由具体命令固定：`gog calendar create --help`、`gws calendar help`、`gog --version`、`gws --help` 均短路为只读输出；`--dry-run` 仍不作为写入豁免。
- sweep 已从“固定日签名”补全为显式状态机：同日 receipt 后的新 finding 不借旧 receipt 推 cursor，跨日 pending 合并到一个 PT 日聚合，完整零发现扫描可本地 checkpoint。新增 RED 3 正面覆盖了此前的丢报反例。
- 坏 JSONL 不再导致永久 livelock：quarantine 持久化位置与 hash，parse error 进入完整聚合，receipt 后 cursor 才越过坏行，后续有效 P6 行仍可交付。
- mode 规则现在前后一致：每次 enforce→audit transition（含授权回滚）恰好报告一次，持续 audit 不重复，invalid fail-closed 状态每日重报；`lastObservedMode` 与对应测试使该语义可机械验证。
- `calendar_wild_write` 明确使用现有 `owner: "claude"`，与实际 `KindOwner` union 和 `resolveTicketOwner` 的 Claude infra bot 默认路由一致；无需扩展 owner 类型或扩大本单 scope。
- Round 1 的关键安全与部署合同继续保留：本单不冒充 credential authorization boundary、无 agent ACK、receipt 后 mode 损坏 deny、QA target-set 全等、真实 Raya create/cancel 回归、kind 双面校验以及 founder-gated launchd 安装。

## Issues & Recommendations

1. **[NON-BLOCKING] 实现时把 pending outbox 的不可变性作为状态机断言固定。**

   §5 已规定同日失败重跑必须使用“同一 snapshot/eventId”，这是正确的 durable-outbox 语义。建议 RED 3 再明确断言：已有当前日 `pendingOutbox` 时先逐字节重试其 body 与已保存的 event/log cursor high-watermark，不把重试期间新到的 finding 混入该 eventId；旧 snapshot receipt 后，新 finding 才由下一次扫描进入 deferred outbox。这样可防止一次不确定 delivery 已实际成功、但本地尚未记 receipt 时，新 finding 被旧 `sent` receipt 错误确认。该要求是现有文字的测试加固，不需要改变架构或阻塞实现。

2. **[NON-BLOCKING] 将跨日 re-bucket 明确记录为 at-least-once 取舍。**

   “本地未取得 receipt”在 sweep crash 恰好发生于 `lead-alert.sh` 已持久化 sent/queued 之后时，并不能严格证明外部从未投递；跨日废弃旧 eventId 可能把同一 finding 在不同 PT 日各报告一次。当前设计仍满足每日最多一条并优先保证不丢，属于合理的 bounded duplicate 取舍。建议测试加入“alert 端已记 sent、sweep 尚未提交 dayReceipt 即 crash”的场景，并在实现注释中声明 at-least-once，而不要声称跨进程 exactly-once。

## Verdict

APPROVED — ready to implement
