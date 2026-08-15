# Design Review — FLY-1716 plan.md (Round 2)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

r2 已实质吸收 Round 1 的七项反馈，整体架构、拆分顺序和 Wave 3 的动作安全级别都明显收敛；launch-generation fence 的选择也能正确允许同一 body 多次 `/clear`，方向成立。但两处硬安全契约仍未闭合：`tailBytes / 4` 不是可证明的 token 上界，因而仍可能把已满 session 判成 `safe_resume`；gen fence 只有一次前置比较，没有与 launcher/副作用共享线性化边界，仍有 mutation-time TOCTOU 与同代乱序倒写。修正这两项，并把 action/receipt 的身份与失败态钉死后即可进入实现。

## What's Good (Keep)

- Round 1 #1 的主要结构已修正：三态 gate 只允许 `safe_resume`，`unsafe/unknown` 都 fresh；canonical model decision 被提到 gate 与 launch 共用，`CLAUDE_CONFIG_DIR`/slug/跨块/预算耗尽测试也进入矩阵，launch-gate receipt 与 exit receipt 正确分离。
- gen token 比“永久绑定 launcher 初始 old session-id”更适合同一 body 连续多次 `/clear`；env token 对当前 gen file 的比较，确实能成为跨 physical launch 的 authority fence。这个机制应保留，但需要下面第 2 项的共享锁与 mutation-time 复验才能完成其安全承诺。
- hook 已改成非短路步骤、本地 bootstrap 避开 10s hook 与 15s curl 的矛盾、session-id 路径由 launcher 传入，并明确要求 history、clear receipt 与故障测试；这些都直接回应了 Round 1 #2。
- Wave 3 不再把 status bar 当 idle 证明：专用 Lead action primitive、双 capture fingerprint、明确 veto 优先级、audit-before-keystroke、episode 绑定 session/gen，以及 receipt 才能确认 clear，已经覆盖 Round 1 #3/#4 的主体。
- classifier 已被正确降级为 Wave 3 内部原语，生产 emission/注册显式化，`model-cap` 负向断言保留；statusline sidecar 删除；Wave 4 代码拆出；Wave 1 先合入验收再开放自动 `/clear`。Round 1 #5/#6/#7 均已闭合。

## Issues & Recommendations

1. **BLOCKER — `last usage + tailBytes / 4` 仍不是“可证明安全”的占用上界。** `plan.md:56` 把 `/4` 称为保守高估，但 4 bytes/token 只是经验均值：随机标识符、压缩/编码文本、部分 Unicode 内容都可能低于 4 bytes/token，因此会低估 tail token。算法还没有加入最后一条 assistant response 的 `output_tokens`；该输出位于同一 JSONL 行，不在“其后 tail bytes”中，却会进入下一轮 context。于是可以构造 `input+cache` 低于 70%、`output_tokens + tail` 把真实 context 推过墙、估算值仍低于 70% 的 `safe_resume`，硬验收 B 仍不成立。请把 base 改为 `input + cache_read + cache_creation + output_tokens`，tail 使用有证明的上界（最简单是按 1 UTF-8 byte = 1 token 上界，或只白名单已知零-context 尾行，任何其他 context-bearing/unrecognized tail 直接判 `unknown`），并以整数交叉乘法比较阈值，避免 pct 舍入参与 authority decision。新增“高 output_tokens、1-byte/token adversarial tail、刚好跨阈值”反例；只有这个上界证明通过后才能产生 `safe_resume`。

2. **BLOCKER — gen-fence 覆盖了跨代身份，但当前步骤没有 mutation-time 线性化，尚不能确认完全覆盖 Round 1 race。** r2 在 `plan.md:87` 先比较 gen，随后才 adopt，且只在 session-id 回写时拿 hook 私有 lock（88-91）。旧 hook 可以先通过 gen 检查，新 launcher 再轮换 gen，旧 hook随后仍会 adopt 并写回；这正是“检查时有权、执行时已失权”的 TOCTOU。launcher 也不参与该 lock，因此它可能在 hook 回写同时读取 session-id/做 gate。请让 launcher 与 hook 使用同一个 per-Lead authority lock：launcher 在锁内轮换 gen，并重新读取 session-id、执行 gate/park/fresh identity publish；hook 在同一锁内重新读取 gen，并把 adopt、history、session-id publish、receipt 作为这一代的串行副作用执行（至少每个副作用前都要有锁内 gen 复验，锁获取失败一律不 mutation）。同时钉死 gen-file 写失败/lock 超时的 fail-closed 行为，不能悄悄用旧 authority 继续 resume。

   同 generation 的乱序/重复 clear 也需要第二层 idempotency，而 gen 相等本身无法判断新旧。以 `(gen,newSessionId)` 为 clear receipt key，在锁内先查 completed receipt；同 key 重放必须在 adopt 前 no-op。当前 `adoptInflightForRecipientOnConnection` 只对“当时仍为 LEASED”的行做 UPDATE 并增加 `lease_retry_count`（`mailbox-queue.ts:298-325`）；若 duplicate hook 之间消息被重新 lease，第二次 adopt 会再次改变它，receipt 写在末尾并不能证明“至多一次”。若不在 CommDB mutation 边界增加 idempotency key，就应明确其 crash 窗口并把“恰好一次 adoption”改成可证明的 effect 契约；否则增加 `(gen,newSessionId)` durable claim/receipt，使 duplicate、乱序和 crash-replay 测试验证 `lease_retry_count` 不会多增。gen-fence 的核心选择可保留，不需要退回 baked old-id CAS。

3. **HIGH — “单一 Lead 注入收口”还需列出真实迁移面与带身份的 target 类型。** 当前 `LeadWindowRef` 只有 socket/window 地址（`LeadWindowLocator.ts:31-38`），不携带 project、Lead 或 generation；若 primitive 真的“只接受 LeadWindowRef”，它无法从类型上证明计划要求的三元身份。请定义 `LeadActionTarget {projectName, leadId, expectedGen, windowRef}`（或等价 branded type），并让 primitive 自己从 canonical locator 重建/比对 window，而不是信任调用者拼出的 ref。生产里 Lead rescue 仍在 `plugin.ts:8855-8857` 直接调用 `sendEnterToWindow`；计划必须把这个 callsite 明列为迁移项，并为 `resume_menu_enter | compact | clear` 建窄 allowlist/predicate，使静态测试能证明 Bridge 内没有其他 Lead send-keys 绕过 choke point。AutoContinue 实际是 Runner 路径；人工输入也不可能被 mutex“互斥”，只能靠双 capture/fingerprint 检出并 fence，请相应收窄 `plan.md:123,188` 的表述。launcher 内的 dev-channels poller若不纳入共享 primitive，也要写明为何其启动期窗口与 relief episode 不重叠，并用测试锚住。

4. **HIGH — filesystem “读-校验-条件写”不是 CAS，且 clear 已发生但 adopt 失败时状态机会永久悬在 `clear_requested`。** `plan.md:129` 指定 JSON sidecar 并称 transition 为 CAS；tmp+mv 只能保证单文件原子发布，不能提供 compare-and-swap。请复用现有 StateStore/SQLite transaction，或为 episode/action ledger 规定跨 Bridge instance 的同一锁 + revision compare；`nextScanAt` 在无 active episode 时放在哪里也需明确。clear receipt 应回带发键前 durable action ledger 的 `actionId`，否则仅凭“same gen + newSessionId 不同”只能证明某次 clear 发生，不能证明是本 episode 的请求。

   另外，hook 被设计为 adopt/write/bootstrap 互不短路；因此完全可能 session-id 已换代、会话已清空，但 receipt 中 `adopt.ok=false`。此时不能再次 `/clear`，也不能无限等待 `cleared_confirmed`。增加 terminal `cleared_degraded`（或等价）分支：确认 clear/writeback 已发生后停止所有按键，针对 adopt/bootstrap 失败做一次有界、幂等的 continuity reconcile 或明确 severe ticket；缺 receipt 超时也只升级可观测性，不重发 clear。测试要覆盖“clear accepted + adopt failed”“clear accepted + receipt publish failed”和 Bridge restart 后的恢复决策。

5. **MEDIUM — 把新 kind 的运行时合同和值钉死，避免 rider 已修、告警层却再次自动修或直接 @Annie。** `plan.md:106` 只写“注册 KIND_CONTRACTS/route”，没有指定 `owner/arc/remediationRef`。`AlertChannelHub`/`AutoRepairBot` 对未知 repair 分支会走 `needs_human`；若 Flow 2 暂时关闭、失败或回滚到 raw sink，新 `context_limit` 可能在 rider 正处理时产生误导升级。计划应明确例如 `owner: claude, arc: auto, remediationRef: leadContextPressureScan`，并让告警 payload/AutoRepairBot 将 rider 的 detection-time action 诚实映射为 attempted/observing，而不是触发第二次修复；同时加 routing=1 和 raw fallback 两条测试。V2 的“逐字节一致”也应改为“resume argv/既有语义兼容”：本方案必然新增 gate receipt、gen 文件和 child env，不可能整体逐字节相同。

## Verdict

CHANGES REQUESTED — address items above
