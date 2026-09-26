# Design Review — plan.md (Round 1)
Date: 2026-09-25
Author: Codex (gpt-6-astra)
Status: CHANGES REQUESTED

## Summary

消费端单一入口、保留原告警生命周期的方向可行；目前不能保证“只合并已通知过的同一待办”。存在未投递就建立通知依据、真实对象被规范化抹除、复发工单被合并三类吞待办路径，另有窗口计数和已知 info 载体覆盖缺口。以下五项应在实施前修正，不需要增加 daemon 或新的投递状态机。

审查固定基线为 `1171f645079e2bc8df7d2f3db3d9afe2f022985c`；完整读取 plan、exploration、research、Python 回放和冻结 JSON，并核对请求列出的源码路径及上游 recommendations。plan SHA-256：`362965deb47e22d2007e7c0ebc5aca4cbd4f5facb9b633a7db45516e95d6ecb3`。收尾时 HEAD 已由并行工作推进至 `2b87242a3be311b8f26df774124e46843b6b5572`，该提交只修改 progress.md；已复核计划及所审源码没有变化。

验证：使用 SQLite `mode=ro` 重放冻结区间 `2026-09-25T07:00:00Z` 至 `2026-09-26T04:00:00Z`，复现 154 封信、152 个原批次、Python full 模式 85 个剩余批次（命令退出 0）。另执行了定向只读反例查询和规范化检查。没有运行测试套件、修改源码或写入生产数据库。85 是近似算法结果，不能证明被消除的叫醒都安全。

## What's Good (Keep)

- 保留 fresh-batch / `retry_count` 门槛与冻结批次成员不变式；只修改 `delivery_content`，原 Discord 信封继续供路由解析。这与 `lead-inbox-loop.ts:348–398, 438–490` 一致。
- `settleClaimAsAudit` 复用现有审计列并明确标注机器结算是合理的。`db.ts:2596–2616` 已有 audit 行进入 ACKED 的先例；`mailbox-queue.ts:3089–3128, 3245–3272` 能归档具有合法 `acked_at` 的独立终态告警行。保留 owner/batch/未投递条件和事务内审计日志。
- dispatcher 使用 `authorId` 与运行时身份比对，未知身份或解析失败照投；保留 question admission 的独立语义。
- 开关复用项目级 store 管理面，读取异常恢复逐条投递；固定页复用现有鉴权路由，新增表使用独立 retention fragment。这些接线位置和模式均有源码依据。

## Issues & Recommendations

### 1. [P1] 判定时写入的窗口不能充当“已通知”的证据

**问题：** plan §4（93–115 行）在 adapter 投递前就合并 `objects/actions`、替换唯一 `anchor_delivery_id`，并将任何非 DEAD 的 live 行视为有效通知依据。

**为什么：** `lead-inbox-loop.ts:350–402, 494–535` 明确先逐行重验证，随后才取得 adapter receipt 并记录 delivered；LEASED 本身不证明已经通知。实际队列允许退避中的旧批次与新批次并存（`mailbox-queue.ts:1465–1536`；默认 inflight 上限为 3，`mailbox-queue-config.ts:13–18`）。因此：对象 A 首次判定后投递失败并退避；对象 B 的新批次成功，窗口保留 A/B、锚点换成 B；A 随后重试耗尽成为 DEAD；下一封 A 仍会因为 B 的有效锚点而被直接 ACKED。检查唯一最新锚点无法发现 A 从未交付。这是源码允许的失败序列，不只是跨库事务的理论风险。

此外，`inspectDeliveryState` 的真实 union 包含 `torn_identity`，`archived_terminal` 也可能是 DEAD，`archived_nonterminal` 是 QUEUED/LEASED（`mailbox-queue.ts:44–61, 938–985`）；计划的 `archived_* → ok` 解释不成立。

**修正：** 只有对应待办的可靠投递证据才能授权永久 audit 结算。最小安全方案是仅依据一个已确认交付、仍有效的等价告警合并，删去把未确认对象并入“已通知集合”的行为；同批次尚未交付的行、缺证据或失效的引用照投。明确处理完整 settlement union，不能让别的对象的成功掩盖失败对象。补上述 A 失败/B 成功/A 再现，以及投递前崩溃或 fence 失败的集成用例；无需新增 outbox。

### 2. [P1] 对象提取和动作规范化已把真实的不同待办折叠为同一个

**问题：** plan §3.2–3.3、§4 使用单个 `session/issue/UUID` 作为对象，动作签名则删除所有 UUID、issue ID、数字，再对正文行去重。它不能证明“同一对象、同一动作”。

**为什么：** 已有具体反例：

- `[verified by executing]` 9-25 UTC `08:26:45.027` 与 `09:05:02.218` 的 `zombie_session_backlog` 中，后者可见样本新增一个 session，数量 11→12；规范化后的正文集合相同。两封信按计划都会把正文说明中的 **FLY-1066** 识别成对象，因其优先于样本 UUID。生产者实际把待检查 session 清单写在正文，FLY-1066 只是收割机制的文档引用（`fleet-sensors.ts:666–695`、`zombie-scan.ts:114–122`）。第二封没有翻倍，也没有规范化后的新动作，会漏掉“不同 session 必须叫醒”的升级。
- `[verified by reading code; synthetic normalization executed]` `review_job_failed` 的 `sessionKey` 是执行 ID，真正要重试的对象是正文里的 `requestId`（`review-governance-effects.ts:46–61`、`review-request-coordinator.ts:2010–2016, 2172–2176`）。同一执行的两个 UUID requestId、相同失败原因与重试指令，会得到相同 object/actionSig。只读数据中也实际存在同 session、不同 requestId/round 被折叠的两封信（UTC `19:58:04.123`、`20:05:48.810`）；这两封是自动重排通知，不能冒充人工待办证据，但同样的碰撞规则会覆盖源码中的人工重试分支。

独立的 `objects` 与 `actions` 集合还会误认交叉组合：已经通知 A/X 和 B/Y，不代表已经通知 A/Y。

**修正：** 标题归类与待办等价判定分开。去重证明须保留 requestId、session 集合、动作参数等业务身份，并绑定对象与动作；不要对动作参数使用通用数字/UUID 抹除。无法可靠识别的 kind、截断的聚合清单或未知对象照投，不能用 `-` 或文档 issue 引用证明等价。优先缩小允许合并的已知形状，而非扩张启发式解析。用上述真实反例和同执行不同 requestId 的人工重试文案作回归，再重算节省量。

### 3. [P1] 工单复发不能作为“诚实边界”被永久结算

**问题：** plan §10（220 行）明确允许 B 类同对象同文案在 resolve 后再次发生时被合并；A 类只比较 `ticketOpenedAt > win.anchor_at`，但 anchor 是整个标题类别最近的消费时间。

**为什么：** resolve 后的新 incident 是新的待办，Discord 上仍有帖子不能代替 Lead 收件箱交付。B 类“没有映射”的依据也不准确：信封自带 `messageId`，Hub 保存 `root_message_id/event_id/session_key`（`AlertChannelHub.ts:391–412`）；现成 `StateStore.getAlertThreadByRootMessageId`（25960–25971 行）正被 duty lookup 使用（`alert-duty-router.ts:217–228`）。查不到映射时应视为缺少合并依据。

A 类也有正常时序反例：对象 A 在 t1 重开并入队，另一对象 B 在 t2 被消费并刷新同键 anchor，A 在 t3 才被消费；此时 t1 < t2，重开条件失效，A 又已在 objects 集合中。账本 `opened_at` 是开单时间（`StateStore.ts:24776–24809`），不能与别的对象的消费时间比较来判断同一代工单。

**修正：** 对可关联的行比较已通知的对应工单/episode 身份；B 类复用上述查询，映射缺失、被覆盖或尚未落账时照投。A 类也不能用类别级时间戳替代对应 episode。若不想增加状态，直接让无法证明同一未解决 episode 的告警绕过去重。补 resolve→原文复发和跨对象排队重开用例。

### 4. [P2] 每次升级刷新 anchor，却保留旧集合和计数，会把六小时窗口无限延长

**问题：** plan §4（93、107 行）用 `anchor_at` 判断窗口到期，每次 wake 又将其改成 now，同时保留历史 objects/actions、最高 severity 和累计次数。

**为什么：** 0h 通知 A，5h 因 B 叫醒，10h 因 C 叫醒：窗口不会过期，计数含十小时前的 A。10h 后 A 再现仍被视为已通知，即使六小时内根本没有 A 的通知。既可能过度抑制，也会将生命周期累计数写成“6 小时内次数”。这还与 Python 回放只在首次/过期时设置 `opened` 的实现不同（`replay_0925.py` 的 `replay`）。

**修正：** 最简单是固定窗口起点，仅首次或到期重建时更新，升级只更新最近交付依据；到期清空用于去重的集合和窗口计数。把该规则同步到回放与消息文案，补跨多个升级、超过六小时后旧对象再次出现的用例。

### 5. [P2] 已知 plain 告警不符合 B 类格式，纯 info 通知仍会逐条叫醒

**问题：** plan §3 的 B 类解析要求 emoji、加粗标题与 `(lead / kind)`；research §2 只给代表性表，遗漏了已存在的 `deliveryStyle: "plain"` 形状。

**为什么：** `LeadAlertNotifier.ts:2110` 对 plain 直接返回 body，没有计划要求的三个字段。`codex-quota/outbox.ts:281–301` 就生成 info 级 `quota_switch_confirmation` plain 通知；生产接线直接调用 notifier（`plugin.ts:13772–13792`）。当它经 dispatcher 的 Discord 信进入本入口时，必然走 unparsed→照投，无法满足 info 只进摘要的要求。这是已知生产分支，不应归入未来未知格式。另一 plain info `codex_quota_automation_disabled` 还可能明确写着“需要手工切号”（`outbox.ts:393–406`），也说明补齐覆盖时不能直接按 info 全吞。

**修正：** 补全可核查的生产者/载体清单，至少覆盖 ticket、plain、shell 和 replay 的实际形状。为已知纯 info 的 plain 路径明确可信的 kind/severity 来源及摘要处理，必要时调整最小范围的接线；带手工待办和未知文案仍照投。新增这两种 plain 样例测试，不能仅以标准 ticket 格式的 `review_advisory_pass` 代表全部 info 验收。

## Non-blocking advisories

- **删除无效的两次失败计数兜底。** plan §5.4 说普通告警重验证抛错后下一 tick 会再次判定；实际上它保留原 batch，`freshBatch=false`，只有未 materialize 的 question 有例外（`lead-inbox-loop.ts:348–365, 408–419`；`mailbox-queue.ts:1465–1523`）。普通告警会沿冻结批次照投。直接描述并测试这一现有行为即可，不要为让计数器生效而放宽冻结批次合同。
- **冻结“计数翻倍”的验收口径。** §9 记录的是已报 Lead 的解释选择，不是回复。标题内数量与告警出现次数的含义不同；把最终采用的口径及无数字标题的行为明确写入验收。本轮不把有歧义的另一种解释另列为阻塞。
- **回放需解释规则差异，不能只看 ±10%。** 当前 Python 与计划在 kind 是否入键、UUID fallback、窗口续期、工单重开方面不同。实现阶段应以最终生产判定器及完整批次成员为准，逐项验证被合并样本没有新对象/动作；即使改后节省小于 44%，也应如实接受。固定页和至多一次摘要的现有取舍不需要扩张为可靠摘要 outbox。

## Verdict

CHANGES REQUESTED

先修正以上五项，再实施。保留消费端入口、带 fence 的 audit 结算、项目开关与现有固定页；优先减少无法证明安全的合并范围。
