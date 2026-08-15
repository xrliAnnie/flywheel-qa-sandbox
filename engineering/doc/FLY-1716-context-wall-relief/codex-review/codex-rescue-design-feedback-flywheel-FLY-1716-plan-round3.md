# Design Review — FLY-1716 plan.md (Round 3)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

r3 已关闭 Round 2 的两个核心 blocker：context gate 现在有真正保守的 token 上界，launcher/hook 也通过共享 authority lock 在 gen 轮换与 mutation 之间建立了线性化边界；整体已非常接近 implement-ready。剩余阻塞集中在 clear idempotency 的持久化形状：计划声明按 `(gen,newSessionId)` 查 claim，但仍只定义一个会被后续 clear 覆盖的 per-Lead receipt 文件，因此 delayed replay/同代乱序仍可能重复 adopt 并倒写旧 session-id。另有三个窄合同需在实现前钉死：action-specific pane predicate、degraded/abandoned 告警的独立去重身份，以及 action-ledger 查询失败不能伪装成人工 clear。

## What's Good (Keep)

- Round 2 #1 已闭合：base 加入 `output_tokens`，tail 改为 1 token/byte 上界，authority decision 使用整数交叉乘法；高输出、对抗 tail、整数边界和 conservative false-park tradeoff 均已进入计划与测试。
- Round 2 #2 的跨 physical launch race 已闭合：launcher 在共享锁内轮换 gen、重读 session-id 并做 gate，hook 在同一锁内 mutation-time 复验；launcher 的 lock/gen 失败明确 abort，不再用不明 authority 继续 resume。这个 gen-fence 可以确认保留。
- claim-before-effect 对两个 crash window 的取舍写得诚实：允许一次 bounded missed-adopt，但不重复增加 `lease_retry_count`，并依靠下一次 launcher adoption/lease expiry 保证 lossless；没有为了“完美 exactly-once”越界改 mailbox SQL。
- Round 2 #3/#4/#5 的主体已闭合：identity-bearing `LeadActionTarget`、rescue callsite 迁移和静态绕过守卫；StateStore transaction+revision CAS、durable `nextScanAt`、`cleared_degraded/cleared_external/abandoned`；以及明确的 `context_limit` owner/ARC/remediation contract 与 raw/routed 两条测试。
- Wave 1 先独立合入、Wave 2+3 后开放自动按键的顺序仍正确；statusline/mailbox loop/Wave 4 代码继续保持在 scope 外。

## Issues & Recommendations

1. **BLOCKER — `(gen,newSessionId)` claim 目前没有真正按 key 持久化，单一 current receipt 会被下一次 clear 覆盖。** `plan.md:87-95` 要求按 key 查 pending/completed claim，但步骤 6 仍只定义 `~/.flywheel/state/lead-clear-receipt/<project>-<lead>.json`，schema 也是单条 `{key,...}`。反例：同 gen 下 B clear completed；随后 C clear 把文件覆盖为 `(gen,C)`；B 的 delayed replay 再进锁时查不到自己的 completed key，于是会再次 adopt，并把 session-id 从 C 倒写回 B。不同 newSessionId 的两个 hook 若锁获取顺序反转也同样不会被 gen fence 或“同 key no-op”识别。请把 claim 变成真正的 durable keyed ledger：最小实现可用 `lead-clear-receipt/<project>-<lead>/<gen>/<newSessionId>.json`（pending→completed 原地更新，另设 current pointer），或 StateStore 表 `PRIMARY KEY(gen,new_session_id)`；任何后续 clear 都不得删除/覆盖旧 key。若依赖 Claude Code 的 SessionStart hook 同步串行来排除“不同 session 的乱序首次执行”，必须把这个 upstream contract 和 timeout-kills-child 行为列为证据与测试；否则增加可比较的 session-birth ordinal/predecessor，拒绝比 current receipt 更旧的首次 claim。测试必须覆盖“B completed → C completed → replay B”，并断言 session-id 仍为 C、adopt 调用不增加、`lease_retry_count` 不多增。

2. **HIGH — primitive 的通用 safety sequence 会把它必须支持的 `resume_menu_enter` 自己 veto 掉。** `plan.md:124-128` 将 `resume_menu_enter` 放入 allowlist，却又统一要求“真实空 input box”并把 `resume menu` 列为 veto；现有 rescue 的合法动作恰恰只在 `isSafeResumeMenuForEnter()` 命中时发送 Enter（`rescue.ts:180-186`）。请改成 action-specific predicate：`resume_menu_enter` 必须命中既有 exact resume-menu recognizer 且不得有 compact prompt；`compact` 必须是真空 idle input；`clear` 必须是专用 context-wall-with-input，或 compact escalation 下重新证明的 idle input。project/Lead/gen/window revalidation、双 capture、fingerprint、audit-before-key 和 mutex 作为三类动作的共同 gate。迁移等价测试要同时证明合法 resume menu 仍会 Enter、compact/resume prompt 和普通 idle 不会被 Enter。

3. **HIGH — `cleared_degraded/abandoned` 若复用 episode eventId，承诺的 severe ticket 会被现有强去重吞掉。** 计划在 `clear_requested` 已用 `eventId=episode id` 发一次 `context_limit`，又要求 `cleared_degraded` 用同一 episode id 发 severe。实际 notifier 会对已 claim 的 eventId 返回 duplicate（`LeadAlertNotifier.ts:879-932`），Flow 2 mailbox 的 delivery id 也包含 `eventType+eventId`（`lead-inbox-runtime.ts:411-443`），所以第二条不会成为新的严重告警；`abandoned` 的 ticket identity 也未定义。请二选一：更新/追加到现有 ticket 的同一 incident lifecycle，而不是重新 enqueue；或为终态使用稳定且不同的 eventId（例如 `<episode>:continuity_degraded` / `<episode>:receipt_missing`，必要时用独立 kind/contract 以免 `arc:auto` 文案仍声称修复中）。对 routing=1 与 raw fallback 都加“初始 clear_requested 已发过，随后 degraded/abandoned 仍恰好可见一次”的非空过绿测试。

4. **HIGH — actionId lookup 需要三态，查询失败不能与“已证明人工 clear”共用 null。** r3 规定 hook 从 Wave 3 的 StateStore ledger 读取 actionId，`null` 即 `cleared_external`；但 hook 属 Wave 1，action tables 到 PR-2 才出现，且跨进程读取 WAL 中的 `teamlead.db` 可能遇到表未部署、busy、路径/reader 失败。把所有失败折成 null 会把一次自动 clear 的断链误判为人工成功，并静默跳过 `cleared_degraded/abandoned`。请定义 `actionLookup = matched(actionId) | none_proven | unknown(error)`：只有查询成功且证明 10min 窗内无 eligible action 才是 `none_proven/cleared_external`；DB/table/busy/parse/path 失败必须写进 receipt 并进入 degraded/causality-unknown 可观测路径。PR 拆分也要写实：PR-1 的 hook reader 必须对“表尚不存在”稳定降级，PR-2 要么包含对应 shell 更新，要么 PR-1 先钉死兼容 schema/helper；reader 使用明确的 `$FLYWHEEL_STATE_DIR/teamlead.db`、WAL-aware readonly/query-only 连接和短于 hook timeout 的 busy budget，绝不能在 hook 中创建/迁移 StateStore。

## Verdict

CHANGES REQUESTED — address items above
