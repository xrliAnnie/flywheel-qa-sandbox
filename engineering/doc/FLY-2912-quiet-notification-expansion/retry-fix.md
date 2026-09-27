# FLY-2912 摘要重试正文冻结 — 验证记录
Issue: FLY-2912
日期: 2026-09-26
基于: plan.md, review-fix.md

本轮处理 review question `a3137b2c-f4c7-4b07-929c-6922526c4287` / request `b8997e28-72e9-4a28-8277-af60537996f3` 在 `95b137b89efab3e85d5a3bdbadad43fc02563f8c` 的 HIGH `summary-attach-on-retry-after-unfrozen-attempt-membership-conflict`。该旧头 CI Scope OK，通过不等于完整 CI 或 QA。

## 根因与修复

总开关 OFF 时原 helper 不写 offer。同一 batch 的 adapter 已接收但收据丢失，随后开关 ON 或升级，helper 看到无 offer 就新建非空摘要。同一 transport ID 的正文被改写，ClaudeMailboxCodec 的 fingerprint 和 Codex SqliteJournalStore 的 payload equality 都返回 membership_conflict，loop 随即把真实任务 DEAD 或隔离 founder Discord。

`LeadInboxLoop` 将 claim 时的 freshBatch 及所有成员 retry_count===0 合并为内部 canBuildSummary；该字段不取自消息 payload。摘要 helper 首先复用原 offer，不受当前开关或新事件影响。没有 offer 时，OFF 或缺少首次发送证明均冻结空附件；只有确切的新批次首次发送才允许读取并冻结新摘要。空附件不推进摘要游标；后续新批次仍能携带未展示的账目。

没有修改 mailbox content/delivery_content、传输 ID、去重规则、队列 schema 或通知分类。上一轮混合 ACK 修复保留。

## 先红后绿

新增用例使用真实 MailboxQueue、LeadInboxLoop、buildLeadAuditSummaryOffer，以及真实 Claude 文件邮箱适配器或 Codex SQLite LeadJournal（不启动模型或生产服务）。覆盖普通任务与 founder Discord 两条路径：OFF→ON、ON→OFF、升级时 retry_count=1，以及接收后崩溃且 retry_count=0。重启 loop 后必须得到 accepted_duplicate_same_membership、正文逐字相同、任务仍正常待 ACK；空附件不读摘要源，下一新任务仍能附带摘要。

校正测试中 duplicate 状态枚举后，修复前 12 failed / 4 passed（12 个失败均为 real-task DEAD / membership_conflict）；helper 2 failed / 4 passed。最初一次另有 4 个测试使用错误的状态名，明确不计作产品缺陷。最小修复后 16/16 与 helper 6/6 通过。

最终验证：16 个具体文件逐个执行，262 passed（含下述 4 个降级风险诊断）；受限 related 10 文件 / 191 passed（与显式文件重叠，不相加），配置收集的 15 个候选文件无重复。lint 通过（25 warnings），teamlead 及依赖 build 通过；导出的 callback 输入类型增加字段，因此另外通过 teamlead 与依赖它的 voice-codex typecheck。完整命令、源码 blob 和 28 份日志归档在 evidence/retry-fix-verification.json；消费者选择及逐项排除理由见 evidence/retry-fix-selection.json。没有本机整包测试或新的 full-CI 请求。

## 降级边界与已知自动回滚风险

Lead 在问题 `f51fe18d-51a3-43d8-83ac-b21afed3239b` 已确认支持的手工降级边界：当前二进制关闭总开关 → 带摘要的在途批次结算 → 降级；不改 mailbox content/delivery_content，不执行 live deployment 或队列变更。

**自动健康检查失败回滚仍有已知风险。** updater 自动回退旧 SHA 不会先关闭开关。若非空摘要已到达 adapter 而收据未入队列，旧二进制忽略 offer，重试原正文会得到 membership_conflict。普通任务进入 DEAD；founder Discord 进入 discord_undeliverable 隔离，不能保证安全降级。没有据此声称消息最终被模型消费或完全无损。

本轮另加 4 个明确标为 unsupported downgrade 的诊断用例：关闭 prepareAuditSummary hook 模拟旧协议，对真实 Claude 邮箱/Codex SQLite journal 重试。它们确认上述冲突和队列终态，原 delivery_content 保留，载体只存在一次 durable intake。未执行旧部署二进制或生产 updater；`33fa00747` 的 membership_conflict 分支与当前源码逐字相同，证明记录归档于验证文件。诊断测试通过只证明风险可复现，不表示降级验收通过。最初 2 个诊断断言漏写 Discord 隔离原因的前缀，已按实际独立路径校正，没有修改生产行为。

## 验收与建议

历史 wake 对比仍 acceptance.complete=false：845/1,855 条 UNKNOWN，改后实际 wake 为 null。源数据不足的既定结论不因本次代码修复变化。完整 CI 与 QA retest 仍属 QA。

当前非阻断建议：摘要同步归档扫描、offer 表保留期限、已投递 monitoring_lost 后的恢复、OFF started 稳定 ID 去重、无 registry 的 pending model 行、摘要 title/recovered 展示。它们未混入这次 HIGH 的最小修复，待 Lead 选择后续。
