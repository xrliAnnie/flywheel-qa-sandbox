# Design Review — plan.md (FLY-1687) (Round 2)

Date: 2026-08-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质吸收 Round 1 的六项意见：mailbox settlement、单飞与链式 identity、typed payload、batch framing 边界、精确 scope/UTC 解析以及 snapshot 级热配置都回到了正确方向，整体架构可实现且 scope 合理。但当前 settlement lookup 会把已归档的终态 row 误判成 crash 缺口，链式 eventId 也尚未让 loser 的 payload/timestamp byte-stable；再加上名册字段未经单行约束，三个问题都可能破坏本计划声称的“不楔死、结构性幂等、固定无指令正文”契约。

## What's Good (Keep)

- 用 canonical mailbox row 的 `ACKED` / `DEAD` 作为 settlement，并分别以 `acked_at` / `dead_at` 锚 cadence，正确避开了 `lead_events.delivered_at` 早于 batch ACK 的语义错位。
- `QUEUED` / `LEASED` 跳过、row 真缺失时重投旧事件、pass-level in-flight guard，以及 append→enqueue/ACK 前后的 crash matrix，都是必要且与现有 mailbox-first 架构一致的收敛。
- `session_key = patrol:<project>:<lead>` 等值作用域、`parseSqliteUtcMs`、settlement-time cadence anchor，关闭了 LIKE 下划线串账、本地时区误读和延迟 ACK 后连发三个问题。
- 完整 `HookPayload` identity、共享 `formatPatrolTick` 与双 runtime parity，以及把两句正文和 FLY-1573 transport framing 明确分层，令实现与验收边界可测试。
- 热配置补齐 positive-finite 校验、失败 snapshot 缓存、snapshot 级 warn-once、每 project 每 pass 单份读取和 mainline-root 反例，符合既有 hot-read 与安全模式。
- 继续扩展 `runner-patrol-rules.md` 是正确选择；现有双路径接线、既有 guard anchors 与 Lead-only 受众都优于新建规则文件。

## Issues & Recommendations

1. **“mailbox row 缺失”不只表示 append→enqueue crash；已归档的 ACKED/DEAD row 会被当前流程永久误判。** `LeadInboxRuntime` 初始化每个项目时会打开 `CommDB`，而 `CommDB` 默认在 open 时执行 purge（`packages/flywheel-comm/src/db.ts:780-825`）；`MailboxQueue.archiveDueFamilies()` 默认在终态 72h 后归档（`mailbox-queue.ts:2144-2183`），随后保留 `mailbox_identity` / `mailbox_log` 并删除 live `mailbox` row（`:2333-2372`）。此后 `getById()` 返回 missing，但同 identity 的 `enqueue()` 只返回 `{ outcome: "archived" }`，不会重建 row（`:408-435`）。因此“零 runner 超过 72h后重新出现 runner”或“Bridge 停机超过 72h”会让最新 tick 落入计划 §3.2-4 的 missing→重投→本轮结束分支，并在以后每轮重复得到 `archived`，再也不会生成新 tick。建议把读取结果明确建模为 `absent_identity | live(QUEUED/LEASED/ACKED/DEAD) | archived_terminal`：只有 `absent_identity` 才恢复旧事件；`archived_terminal` 应从 archived `row_json` 还原 ACK/DEAD 与终态时间（或建立等价的 typed settlement API）后继续 due 判断。增加 ACKED/DEAD→超过 retention→reopen/purge→有 runner 的测试，断言会生成下一条链式 tick，而真 absent identity 仍只重投旧 tick。

2. **确定性 eventId 只去重 key，尚未使并发/replay 的 mailbox projection 幂等。** `StateStore.appendLeadEvent()` 遇 UNIQUE 仅返回既有 seq，不告诉调用方是否插入，也不返回/校验既有 payload（`packages/teamlead/src/StateStore.ts:10719-10726`）。两个读取同一 `prevSeq` 的 producer 会得到同一 eventId，但可拥有不同的 `generated_at`、roster 和 envelope timestamp；loser 若按自己的内存 envelope 继续 dispatch，`MailboxQueue.enqueue()` 的 immutable projection hash（包含 content 与 `created_at`）会与 winner 不同并抛 `mailbox identity conflict`（`mailbox-queue.ts:347-400, 420-427`）。这意味着当前正确性仍依赖 pass guard，与计划“UNIQUE 真正兜住 race、不依赖 guard”不一致。建议 initial dispatch 和 missing-row recovery 都在 append 后读取 durable `lead_events` row，并统一通过现有 `leadEventEnvelopeFromJournalRow()` 重建 envelope；该 helper 本就声明用于 byte-stable append→crash→retry（`legacy-lead-event-reconciler.ts:17-38`）。补一个绕过单飞核心的对抗测试：相同 prevSeq、不同 now/roster 的两个 producer 最终不抛 projection conflict，mailbox content/timestamp 与 journal winner 完全一致，第二次 enqueue 只是 active/idempotent。

3. **固定正文的动态名册字段没有输入域/转义契约，运行时仍可注入额外行或指令词。** `sessions.session_role` 和 `issue_identifier` 都是无 CHECK 的 TEXT，`/runs` 目前也直接接受任意 string `sessionRole`（`packages/teamlead/src/bridge/runs-route.ts:1218-1225`）。若任一字段含换行、控制字符或模板分隔符，`- identifier (role, status)` 会扩展成模板外文本；正常 fixture 的 byte-compare/deny-list 无法证明 founder 的 negative-control 在真实数据上成立。建议锁定 renderer 输入规范：status 只取查询的闭集，identifier/role 经过共享的 bounded single-line canonicalizer（至少处理 CR/LF/控制字符并限制长度），或对未知 role 使用无歧义转义；增加带换行和 directive 词的恶意 roster fixture，断言输出仍只有既定两句和规范化 roster 行。

## Verdict

CHANGES REQUESTED — address items above
