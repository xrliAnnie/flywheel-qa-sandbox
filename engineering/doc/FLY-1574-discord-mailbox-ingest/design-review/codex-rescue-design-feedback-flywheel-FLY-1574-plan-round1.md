# Design Review — plan.md (Round 1)
Date: 2026-08-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

整体方向可行：在 gate 之后把 Discord 入站收敛到现有 mailbox，并保持最后一公里和旧链路可回切，符合 FLY-1569 的总体设计。但当前计划对 mailbox identity、跨进程提交结果不确定性、Codex 实际接入点和“零绕行”证明存在关键误判；按现方案实现，ON/OFF 竞态可能造成重复投递、永久 spool 欠账，甚至复现 FLY-1646 类型的恢复风暴，因此尚不能进入实现。

## What's Good (Keep)

- 分叉位置选择原则正确：保留 permission/pairing/roundtable/typing/reaction 等 gate 与路由，只替换 gate 后的投递动作。
- `carrier='inbox'`、`recipient_kind='lead'`、`msg_class='model'`、`type='discord_chat'` 能进入现有 LeadInboxLoop；`QuestionAdmission.revalidate` 对非 question 的确直接放行。
- 以 comm.db 为权威、nudge 仅作尽力而为门铃，符合现有 durable queue 模型；D 未合时明确接受 C 期语义也符合依赖图。
- 默认 OFF、运行时读取、保留旧路径、隔离房先验以及杀 Bridge/幂等/回切/失败注入等 QA 场景，风险意识与本链路等级匹配。
- ON 行与旧 external 重投 worker 的谓词隔离思路正确；`listExternalPending` 当前确实只扫描 `carrier='external'`。

## Issues & Recommendations

1. **[BLOCKER] “同一 `chat:` id 的 external 行会天然幂等短路”与当前队列实现相反。** `MailboxQueue.enqueue` 的 identity hash 覆盖 carrier、type、content、from/to 等完整 insert projection；同 id 从 `external/external_delivery` 改成 `inbox/discord_chat` 会抛 `mailbox identity conflict`，归档后的 identity 也仍然保留并继续冲突。ON→OFF 的 Gateway 重放同样会让旧 `begin` 冲突并写入无法收敛的 spool intent。建议先设计一个事务内的 Discord lane 仲裁 API，由 `mailbox_identity` 对 message id 一次性决定所有权并返回明确结果（例如 `inserted_inbox | active_inbox | legacy_external | archived`），让 ON ingest 与 OFF legacy begin 都遵守该结果；补齐 active/delivered/DEAD/settled/archived external、ON→OFF、OFF→ON 和并发竞争测试，而不是把 UNIQUE 当作成功。

2. **[BLOCKER] 插件子进程失败后的“重试一次，再直推”存在不确定提交窗口，会双投。** `chat-ingest` 可能已经提交 inbox 行，却在 nudge、stdout 或进程退出前超时/被杀；调用方看见非零后再走旧直推，已提交的 inbox 行稍后仍会由 LeadInboxLoop 投递。若 fallback 再执行旧 `begin`，同 id 还会触发上述 identity conflict 并留下反复重试的 spool，正好踩中 FLY-1646 的历史风险。建议把 enqueue 成功与 nudge/JSON 完全解耦，并在任何 timeout/spawn/非零结果后用权威状态探针确认 lane；只有事务性地证明 inbox 未提交且成功取得 legacy lane 所有权时才允许直推。为“commit 后、回包前崩溃”等 crash points 写测试，不能依据进程退出码直接选择投递通道。

3. **[HIGH] flag 的所有权、有效范围和异常语义尚未闭合。** 计划把 reader 放在 `flywheel-comm`，但又规定 CLI 不判 flag、外部插件调用方自行判定；插件无法直接消费本仓库 TypeScript 库。全局 flag 还必须限定为 `FLYWHEEL_MAILBOX_DISCORD=1 && RECORDER_MODE.kind==='enabled'`，否则 stock/isolated/broken-wiring 插件实例也会尝试 ingest。读文件失败或畸形值目前静默按 OFF 直推，又不会产生 BYPASS 证据，和“ON 期间零绕行”硬检查矛盾。建议明确插件 fork 自有 live reader、Codex 本仓 reader（共享契约 fixture，而非虚构单一代码调用点），区分 explicit OFF 与 read error，并对 read error 输出带 message/lead/project 的结构化 bypass/flag-error 证据；生产修改使用原子 `.env` 写入。

4. **[HIGH] Codex 的实际接入点与数据契约不符合计划假设。** 真正协调 filter、reply route、ExternalReceiptSaga、journal accept 和 cursor advance 的位置是 `CodexDiscordGateway.handle`，不是 runtime 中一个抽象的“进入 LeadInputRouter 前”；其 handler 还是同步 `boolean`，`false` 才能阻止 REST cursor 前移。`DiscordInboundMessage`/`RawDiscordMessage` 当前没有 authorName、attachments 或 msgKind，且 `passesFilters` 明确丢弃 attachment-only 消息；ExternalReceiptSaga 也只覆盖 cross-department，id 为 `xdept:`。建议把 mailbox ingest 作为 Gateway 的可注入 durable-accept strategy，在 filters 与 route resolution 之后执行，明确同步 enqueue、异步 best-effort nudge 和 cursor 语义；若要求两后端同 envelope，先扩展 RestPoll source/type/fixtures，否则明确 Codex 的降级字段。测试应落在 Gateway、RestPoll source 和 runtime wiring 三层。

5. **[HIGH] 渲染器既未证明“同形”，也缺少内容信任边界。** 今天的 `<channel ...>` 外壳由 MCP notification 通道生成，而 mailbox 会先成为 `from='bridge'` 的 teammate message；仅给新函数做 snapshot 是自证，不能证明 Lead 实际看到的 prompt 形态。现插件还明确把附件只放 meta，因为任一 allowlisted sender 都可伪造 in-content annotation；新方案把 envelope/XML/附件写入 content 后，必须处理属性转义、`</channel>`、换行/控制字符、长度上限和文本边界。建议用真实旧链路捕获的 golden fixture 定义可接受的可见形态，采用严格的 canonical encoder，并加入恶意 closing tag/属性/newline/control-char/attachment-name 测试。另需定义 `from_agent`：现有 begin 永远写 `founder`，插件只有 author Discord id，没有“来源 Lead id”映射，不能按计划凭空生成该值。

6. **[HIGH] “reply settle 仅对 external 行继续”目前没有实现机制。** Discord reply handler 只拿 `reply_to`，在 recorder enabled 时无条件写 settle intent 并调用 `chat-receipt settle`；`MailboxQueue.settle` 不检查 carrier，因此 ON 的 inbox 行也会被写入旧工作 settlement ledger。切换重放时 settlement intent 还可能因 lane/identity 冲突永久重试。建议让 settle 命令/队列查询 carrier 并返回稳定的 `ignored_inbox`，或让插件持久化 intake lane 后只为 external 建 intent；覆盖 ON reply、旧 external reply、归档 identity 和翻转后重放测试。

7. **[MEDIUM] 计划重复造了 nudge helper，并漏了实际构建/导出步骤。** `packages/flywheel-comm/src/lead-inbox-nudge.ts` 已有 `nudgeLeadInboxBestEffort`，含 200ms 默认超时、401/403 后 live token refresh 和 best-effort 日志；新建 1.5s/boolean helper 会造成两套语义并拉长 CLI 不确定窗口。Teamlead 若库内直调新 ingest，还必须更新 `packages/flywheel-comm/package.json` exports 和/或 `src/lib.ts`；CLI `src/index.ts` 也要增加命令、usage、async 调度。建议复用/小幅扩展现 helper（如确需 observation 再返回 boolean），并把 package export、CLI routing、结果字段契约列为显式实施项。

8. **[HIGH] 当前“sidecar↔mailbox 对账”不能证明零绕行。** Claude sidecar 只记录已经由 mailbox adapter 写入的内容；旧 MCP 直推或 BYPASS 根本不会进入 sidecar，所以该 join 天然看不见要找的事件。mailbox 活行还会归档，而 identity 永久保留；路径也不能硬编码 `~/.claude`，QA slot 可能通过 `CLAUDE_CONFIG_DIR` 改根目录，Codex socket 路径又没有 Claude sidecar。建议在限定时间窗保存实际 Discord ingress message ids，用这些 ids 对 `mailbox_identity`/mailbox lane、external 新增量、结构化 BYPASS 日志和各后端 durable-accept receipt 做集合对账；若要长期自动证明，则增加独立的 durable ingress/bypass audit。runbook 应给出可执行脚本/查询、shard 枚举和预期行数，而不是注释式 SQL。

9. **[HIGH] QA 与 rollback 有数处不符合现有运行语义。** Lead 会话不在时，Claude adapter 仍可把 batch 写入 inbox/sidecar 并 ACK mailbox；因此 Q4 不保证“行留在 QUEUED”，正确判据是“QUEUED 或已被最后一公里 durable-accept，恢复后只出现一次”。将 flag 置 OFF 也只停止新 inbox 入站，已提交/LEASED 的 ON 行仍会继续投递，不能称为“立止血”；回切需要 watermark、drain 与跨 lane replay 规则。D 未合时每条消息的 nudge 可能让三条分三个 tick，不能预期同 tick 合批；Codex 无 nudge 凭据时已知可达 +30s，也与统一 ≤3.5s 目标冲突。建议重写这些判据，分别定义 Claude/Codex durable receipt、回切后的既有队列处理、C-only 行为以及有/无 nudge 的延迟 SLO。

10. **[HIGH] 跨仓部署与 registry 方案缺少可执行的发布栅栏。** `FeatureFlagSpec` 还要求 `source/envVar/valueKind/default/description/toggleable`，direct 时必须有 `directToggleProof`；drift scanner 只读取本仓 repo-relative 文件，不能把部署 cache 或外部 fork 路径当作可验证 readSite。更重要的是，全局 `.env` 一次翻转会同时命中所有 Lead；任一未加载新插件/CLI/runtime 的实例都会继续无标记直推。建议 registry 只登记本仓可扫描 readsite，并在 note/跨仓契约测试记录外部 consumer；根据 `dotenv_live` 的 split-brain 语义选择正确 toggleability。发布顺序应是主仓兼容版本 → 插件全 fleet 部署并重启 → 对每个 Lead/shard 做 `chat-ingest` capability/version census → 清完 `chat:` 旧账并确认 Codex `xdept:` reconciler 水位 → 才允许全局 ON；回滚也需同一套 census/drain 检查。

11. **[LOW] 清理清单中的 schema 数量已过时。** 当前 `mailbox-schema.ts` 有五个 `carrier='inbox'` partial indexes（`mailbox_claim`、`mailbox_lead_reclaim`、`mailbox_claim_runner`、`mailbox_claim_bridge`、`mailbox_bridge_reclaim`），不是四个。建议修正文档并让清理单用 schema introspection/test 锁定完整对象集合，避免最终漏删。

## Verdict

CHANGES REQUESTED — address items above
