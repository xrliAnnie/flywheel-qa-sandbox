# Design Review — plan.md (FLY-1687) (Round 1)

Date: 2026-08-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向可行：复用 GatePoller、走 mailbox 主路、热读数值配置并扩展现有 Lead 巡检规则，都与当前架构和 founder 裁定一致。但当前计划把 `lead_events.delivered_at` 当成“未处理/已处理”账本，既可能在 append→enqueue 崩溃窗口永久楔死巡检，也无法真正封顶卡死 Lead 的 tick；同时 renderer 级测试不能保证生产中 Lead 实际看到的消息没有 transport 指令，因此尚不能实施。

## What's Good (Keep)

- 保留 Bridge 的纯闹钟边界：tick 只承载到点事实与 Bridge 名册声明，核查与处置全部留在 Lead 侧独立信源清单。
- 复用 GatePoller 的既有 3s timer / 20-tick rider，不新增 timer；数值 interval 不是 on/off flag，符合 FLY-1570 与 FLY-1466。
- 名册先按 `project_name` 收窄，再走 `matchesLead`，并包含 `pending` / `design_done` 等容易被遗忘的非终结状态，口径正确。
- 选择扩展 `runner-patrol-rules.md` 是对的：它已在 `claude-lead.sh` 与 `lead-rules-bundle.sh` 双路径接线，现有 guard test 也能保护旧锚点。
- 全局配置仿 `models.json` snapshot cache、项目配置只读 `ProjectEntry.projectRoot` 下的 mainline `.flywheel/config.yaml`，方向上满足热生效与 worktree 安全边界。

## Issues & Recommendations

1. **`delivered_at IS NULL` 不能承担“最多一条未处理 tick”，并且会产生永久楔死。** `appendLeadEvent` 先写 StateStore，随后才向另一份 comm.db enqueue；若进程在两步之间崩溃，或 enqueue 抛错，留下的 patrol row 永远是 NULL，而计划规定以后只跳过、不 redrive。反方向也不成立：`lead-inbox-loop.ts:484-493` 在 adapter receipt 后、mailbox batch ACK 前就调用 `markLeadEventDelivered`；卡死 Lead 未执行 `ack_batch` 时，StateStore 已显示 delivered，后续每个 interval 仍会铸新 tick，直到三批 in-flight 封顶后继续在 QUEUED 侧积压。建议把 canonical mailbox row（`lead_event:<leadId>:<eventId>`）纳入明确的恢复合同：缺 row 时用原 seq/eventId/payload 幂等重投；QUEUED/LEASED 时不铸新 tick；ACKED 才算上一轮已处理；DEAD 必须有可见、有限的退场/恢复路径，不能永久压住 patrol。补 append 后、enqueue 前、adapter receipt 后、audit mirror 后、batch ACK 前后的 crash/restart 矩阵。

2. **GatePoller 接线缺少 patrol pass 单飞，`Date.now()` eventId 也不能证明 replay 幂等。** `polling` 只保护 `poll()` 本体；`onHealthTick` 同款 rider 是 fire-and-forget，回调超过一个 cadence 时下一次会并发进入。两个 pass 可同时读到 due，并生成不同的 `patrol_tick:...:<epochMillis>`，所以 `(lead_id,event_id)` UNIQUE 不会去重。建议为 `onLeadPatrolTick` 增加与 `runReconcilePatrolPass()` 同等级的独立 in-flight guard，并定义可重放的 producer identity/claim；测试必须让第一个 pass 悬住后触发第二个 tick，断言只有一个 append/enqueue，而不只是把同一个 eventId 手工插两次。

3. **计划中的 payload/envelope 形状按现有类型无法编译，也不会命中 renderer。** `LeadEventEnvelope.event` 必须是 `HookPayload`，其中 `event_type`、`execution_id`、`issue_id` 为必填；`sessionKey` 也是必填 string（`lead-runtime.ts:53-61`）。计划却把 payload 定义为 `{ projectName, roster, generatedAt }`，并向 `appendLeadEvent` 传 `undefined` session key；若照写，`e.event_type === "patrol_tick"` 分支不会成立。请在计划中锁定完整的 typed payload（至少 `event_type: "patrol_tick"`, 空的 session/issue identity, `project_name`, roster, generated time），使用稳定且精确作用域的 session key，并把 `patrol-config.ts` / `PatrolConfig` 加入 `packages/config/src/index.ts` 公共导出。共享 `formatPatrolTick` 应由 MailboxLeadRuntime 与 CommDBLeadRuntime 两个分支共同调用并做 parity 测试。

4. **renderer 逐字节测试不能证明 founder 要求的“实际 tick 无指令”。** 生产 queue 开启时，`lead-inbox-loop.ts:427-450` 会在 model payload 前加 `[mailbox-batch ...]` 和 `You must ack this batch...`，且 patrol row 可能与其他 Bridge model rows 合批。因此 Lead 真机看到的文本并非计划中的固定两句，全文 deny-list 也会命中一条真实指令。计划必须先明确 founder 的硬边界是否允许 canonical transport framing：若允许，验收应分别锁定 transport envelope 与其中 patrol body，且证明不会把其他业务消息算作 tick 内容；若不允许，则必须在 mailbox 主路内设计可验证的隔离投递形态，并相应修改“mailbox 不改”的 scope。不能只测 renderer 后在真机验收时才发现冲突。

5. **per-(project, lead) 账本作用域与时间解析还不精确。** `event_id LIKE 'patrol_tick:<project>:%'` 未 escape SQL LIKE；`ProjectConfig` 允许 `_`，所以如 `foo_bar` 会把任意单字符项目误匹配，重新打开计划本来要关闭的跨项目串账。建议用稳定 `session_key` 等值作为 project scope（或至少使用统一 LIKE escape helper + `ESCAPE`），并增加下划线项目对照。`lead_events.created_at/delivered_at` 是 SQLite UTC 文本，不能直接交给 `new Date()`；仓库已有 `parseSqliteUtcMs`。同时不要以旧 tick 的 `created_at` 作为延迟送达后的下一轮锚点，否则积压一小时后刚送达，下一分钟就会再发。请明确以真正 settled 的 delivery/ACK 时间为 cadence anchor，并覆盖非 UTC 时区、延迟送达与 malformed timestamp。

6. **热配置需要把“warn once”绑定到 snapshot，而不是每次消费时重复告警。** `effectivePatrolIntervalMs` 每分钟、每 Lead 调用；若 clamp 时直接 warn，低于 floor/高于 cap 的有效热配置会持续刷日志。项目 YAML 的 malformed/unavailable 也需要像 `model-config.ts` 一样缓存失败 snapshot，并在 key 改变后才重解析/重告警。请规定 interval 必须是 positive finite number（YAML 可表达非有限数），每个 project 每轮捕获一次原子 snapshot供其所有 Leads 使用，并增加同一坏 snapshot 多轮只 warn 一次、原子替换后恢复、以及读取来源始终是 `ProjectEntry.projectRoot` 而非 session worktree 的测试。

## Verdict

CHANGES REQUESTED — address items above
