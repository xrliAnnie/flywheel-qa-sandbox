# Design Review — plan.md (Round 2)
Date: 2026-08-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

R2 质量显著提升，R1 中关于 enqueue identity、真实 Codex seam、flag/settle/nudge、对账口径、QA 与发布栅栏的大部分问题都已被准确吸收，Claude 主路径已经接近可实施。但新的统一 lane 协议尚未覆盖 Codex 旧道的真实权威（LeadJournal + `xdept:`），且 §7.2 仍明确接受一个与“恰好一次”验收冲突的双投窗口；这两个问题会在真实翻转/故障重放中造成重复或丢失，因此本轮仍需修改。

## What's Good (Keep)

- Phase 0 正确承认 `MailboxQueue.enqueue` 是全投影 hash 幂等，且选择专用 Discord 仲裁 API、不放宽通用 enqueue 语义，这是正确的边界。
- Codex 接入已重锚到 `CodexDiscordGateway.handle`，同步 durable accept、cursor boolean、route resolution、字段降级与 attachment-only byte-compat 都与现代码一致。
- fork-local 与本仓 reader 分开、`RECORDER_MODE.kind==='enabled'` 限域、read-error 留证、跨仓 fixture 和原子 `.env` 写入，已补齐 flag 的主要裂脑风险。
- 复用 `nudgeLeadInboxBestEffort`、列出 package exports/CLI async routing、carrier-aware settle，均与当前代码结构一致。
- golden fixture + canonical encoder、时间窗 ingress-id 集合对账、后端分别取 durable receipt，明显强于 R1 的自证 snapshot/sidecar join。
- QA 已修正“Lead 不在必为 QUEUED”、C 期批次、回 OFF 只影响新 ingress、分后端 SLO 等错误；五个 partial index 与 fleet census 也已写实。

## Issues & Recommendations

1. **[BLOCKER] `chat:` mailbox identity 不能仲裁 Codex 的旧直推 lane。** 当前 Codex 普通 Discord 入站在 OFF 路径只以 `messageId` 写入 LeadJournal，不创建 `chat:` mailbox identity；cross-department 才写 external 行，而且 id 是 `xdept:<lead>:<message>`。ON 重放时 Phase 0 查询不到 `chat:`，会插入新 inbox 行；其后 mailbox socket 通过 `LeadJournal.acceptBatch(batchId, memberIds, ...)` 去重，idempotency key 是 batchId，并不会与旧 journal 的 Discord messageId 去重，所以已处理消息会再形成一个模型 turn。反过来，若旧路径已写 `xdept:` 但在 journal accept 前崩溃，ON 也看不见该 pending lane；直接插 inbox 会绕过旧 saga，而仅“跳过”又会让消息最终被 `journal_absent_after_watermark` 标死。建议为 Codex 写单独的 transition table：旧 journal 已有 messageId → `legacy_codex_accepted` 并跳过；存在 active `xdept:` 且 journal 未接收 → 继续/恢复旧 router+saga；两者均无才允许占有 `chat:` inbox lane。必须明确这组跨 store 检查的排序、cursor 语义和崩溃恢复，并测试普通旧消息已接收后翻 ON、xdept 已接收、xdept begin 后 journal 前崩溃、OFF/ON 混合并发。另一可行方案是让 Codex OFF 路径也先占用统一 `chat:` lane，但需写清与既有 `xdept:`/journal 的兼容迁移。

2. **[BLOCKER] 两次结果不明后 raw direct-push 仍未解决 R1 BLOCKER-2，并与本计划自己的验收矛盾。** 第一次 commit 后未回包、第二次 `active_inbox` 后又未回包时，插件会 raw direct；mailbox 行随后仍投递，产生双 turn。comm.db 真不可达时 raw direct 又不留下 lane identity，恢复后同一 Gateway id 重放会插入 inbox，因此 Q6 所写“恢复后同 id 重放不双投(lane 仲裁)”实际上无法成立。§7.2 接受重复也同时违反 §0 的单 lane、Q4/Q7/Q8 的恰一次和生产验收 6；有 BYPASS 标记只能让重复可见，不能让它正确。建议规定：任何 direct 都必须先得到 durable `inserted_external`/bypass-lane 所有权；若仲裁不可达，则先写本地 durable ingest intent 并持续重试，不能在状态未知时 raw direct。可复用改造后的 lane-aware legacy begin 作为 probe/reservation，成功返回 `active_inbox` 就跳过、`inserted_external` 才直推；连仲裁都不可用时延迟交付而不是破坏恰一次。若产品确实选择 at-least-once/重复优先，则必须由 founder 明确豁免并同步改写所有“恰一次/零双投”验收，当前两组承诺不能并存。

3. **[HIGH] Phase 0 的 verdict 集合和双方动作表仍不完整。** 文档称“四态”，实际还出现 `inserted_external`，共五个结果；更关键的是 OFF 调用方遇到 `legacy_external` 没有定义动作。第二个并发 OFF handler 或旧 spool replay正常会得到该结果，如果继续 direct 会重复，如果当错误 spool 会不收敛。建议定义一个精确的 discriminated union，并把 ON/OFF 对每个结果的动作全部列满；通常 OFF+`legacy_external` 应由既有 external lane/worker 继续负责、当前 handler 跳过 direct 并 kick recovery。并发测试需包含 ON-vs-OFF 混合竞争：OFF 胜时另一方得到的是 `legacy_external`，不是文中笼统的 `active_*`。同时把“legacy_external = 已直推过”改为“legacy lane 已取得所有权”，因为该行可能仍是 QUEUED、尚未 notify。

4. **[HIGH] archived inbox 的 carrier-aware settle 缺少可实现的数据来源。** 活行可以读 `mailbox.carrier`，但归档后 `mailbox_identity` 只剩 opaque `insert_projection_hash` 与 `archived_at`，没有 carrier；计划又要求 archived identity 下区分 inbox 的 `ignored_inbox` 与旧 external 的可 settle 行为。建议明确从 `mailbox_log` 的 `archived` row snapshot 读取 carrier，或在 identity 中持久化 lane（若选择 schema 变更则更新迁移/清理范围），并覆盖“归档 external 后迟到 reply 仍可 settlement”与“归档 inbox reply ignored”两条测试，不能只写一个笼统 archived case。

5. **[MEDIUM] 渲染器引用了不存在的 mailbox content 上限，并计划静默截断权威消息。** 当前 mailbox `content` 是 SQLite TEXT，`MailboxQueue.enqueue` 没有通用长度 cap；`CONTENT_REF_THRESHOLD=2048` 是部分命令采用的外置阈值，不是队列上限。将 founder Discord 正文截断会与“内容完整/不丢”目标及 golden fixture 冲突。建议定义本功能自己的明确 byte/code-point 输入上限及超限语义；优先基于 Discord 已验证的输入约束完整保存，若为 last-mile/context 需要缩短，则把完整原文保存在可恢复的 content_ref，并清楚区分 authority content 与 delivery preview，而不是声称沿用不存在的上限。

6. **[MEDIUM] 三处发布/验收契约还需要落成精确接口。** 第一，`chat-ingest --version-probe` 只在 runbook 出现，Phase 1e 没有定义其无 DB 副作用的版本化 JSON、退出码和测试。第二，`toggleability` 必须落为 registry 联合类型中的一个具体值（按当前手工原子改文件流程应优先考虑 `readonly`），不能只写“非 direct”。第三，生产验收的“ON 代码路径无 MCP direct callpoint”与 ON 失败时 BYPASS fallback 直推冲突，静态 `rg` 也无法证明控制流；应改成“无未受 lane verdict + BYPASS fence 保护的 direct call”，并用单一 fallback 函数及单测/结构检查验证。另请注意当前插件 `runCommand` 等到子进程退出并收完整 stdout，单纯在 child 内先 flush JSON 并不会让 caller 提前获得裁定；若保留该协议，需要让 caller 流式解析第一条完整 JSON，且定义有效 lane JSON 与后续非零退出谁优先。

## Verdict

CHANGES REQUESTED — address items above
