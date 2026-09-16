# FLY-2603 标准 Codex Lead summary 回执 — 调研
Issue: FLY-2603 (https://linear.app/geoforge3d/issue/FLY-2603)
日期: 2026-09-15
基于: exploration.md

## 因果链
- codex-lead-runtime.ts buildFullAccessEnv 的正向白名单未包含 summary role/duty/granularity；TUI daemon 同样复用这个过滤器。
- full-access lead-actions MCP 使用明确 env/env_vars，身份字段未投射进去。保持秘密按现有运输方式传递。
- lead-event-queue.ts 已写 source_kind=lead_event、source_ref=seq、type、收件人和稳定 delivery_id。
- ProtocolIngress ack_batch 调用 MailboxQueue.ackBatchByRecipient，仅将 mailbox 改成 ACKED；没有 StateStore 回写。
- StateStore 新事件 ack_required=0，旧 markLeadEventAcked 只允许 ack_required=1，因此不能冒用旧 bearer-token ACK API。
- 用已授权 batch ACK 的 canonical source 关联回写 summary_absorption_round；不改 producer accounting，不将 ACK 等同 merge 或吸收成功。

## R2 更正与第二条结算路径
- 标准启动器 scripts/flywheel-lead.sh:139 的 sanitize_codex_child_env 有意丢弃全局 CROSS_DEPT，仅采信 registry roundtableChannel；MCP channel literal 在 ensure-home 使用未过滤的 launcher 环境生成。初版把频道空值归因于 app-server 白名单的推断不成立。
- Lead 于问题 f984250f-f662-474d-b16f-1b449b66e65e 裁定 NO fallback，已以 receipt-safe 路径配置 Raya roundtableChannel=1512578695468941333，下次重启生效。PR 撤回初版两条频道 allowlist 新增，不改启动器、不声明生产恢复。
- batch ACK 有两条入口：ProtocolIngress 正常 drain；MailboxQueue.reconcileExpiredLeases 在过期窗口处理已持久化 ACK。后者提前终结 protocol receipt 会永久跳过 journal mirror。
- R2 让过期清理只结算 mailbox member，保留 protocol receipt；正常 ingress 随后处理 duplicate batch ACK、回写 journal，再终结 receipt。进程重启后仍可认领该 receipt；DB 写入异常由已有 retry/quarantine 路径处理。
- 新 journal ACK 是消费审计，不替代现有 mailbox 结算、round 分类或 merge receipt；不会建立新的自动合并授权。
