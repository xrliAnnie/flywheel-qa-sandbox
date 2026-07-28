# Design Review — plan.md (Round 1)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向与 Batch-1 kernel 合同兼容：0005 可以纯加法落地，claim/intent/receipt 的短同步事务也可建，DC1/DC2 的 partial-index 谓词与查询字面匹配。当前仍有多处协议级矛盾，会让旧世代 lease 尚未过期就重发、使 `discord_thread_create` 无法合法入账、把 expected denial 写成 `failed`，以及让 saga 的静态表无法通过自身约束。故本轮不能进入实施。

## What's Good (Keep)

- 范围切得清楚：本批只做 commands 之后的消费侧，零生产接线；FLY-1499/1501/1498 的冻结面总体方向正确。
- 0005 的列和三条索引都是对 0001-0004 的纯加法；现有 `commands` 八态、`result_code`、claim 字段和 `command_dependencies` 禁环约束均被正确识别（`packages/v2-kernel/src/migrations/0001-base-schema.ts:71-113`）。
- 用本机 SQLite 3.51.0 对 plan DDL/查询做的独立 spike 中，DC1/DC2 在 `ANALYZE` 前后均命中 `commands_pending_immediate` / `commands_pending_scheduled`，且无 `USE TEMP B-TREE`；partial-index 字面匹配这一点成立。
- Discord 不造历史扫描消息探针、unknown streak 落库、host_epoch 跨代 absent 降为 unknown，以及 edit/typing/pin 等可重投影表现效果不进 outbox，均符合终版的反 over-reaction 边界。Discord 官方也确认“从消息创建的 public thread 与源消息共享 id”，所以消息锚定方向成立：[Discord Threads](https://docs.discord.com/developers/topics/threads)。
- “补偿 command 不豁免 notify-then-do、planner 自动附带通知依赖”的裁决应保留；问题在补偿 kind 的可表达性，不在这项裁决本身。
- `github_branch_delete` 不必天然归入 founder manual gate；但只有完整继承当前 v1 的 managed-branch、base/protected deny、merge/bundle recovery 和 expected-SHA CAS 合同时，这一裁决才成立，不能只靠一句“SHA 在案可恢复”。

## Issues & Recommendations

1. **[HIGH] startup reconcile 的 `OR claim_generation < current` 直接击穿 2 分钟僵尸静默窗。** Plan 先定义“新世代必须等 lease 过期再动手”（`plan.md:20-28`），但 canonical release SQL 和扫描对象都使用 `(claim_generation < currentGeneration OR lease_expires_at <= now)`（`plan.md:100-104,241-260`）。dispatcher 一注册 generation+1，旧世代所有 executing command 会立刻符合条件；non-probeable Discord 可在旧 HTTP 仍在途时马上回 pending 并双发。**建议**：所有 in-flight 接管都以 `lease_expires_at <= :now` 为必要条件，generation 只做合法世代上界/审计，不得作为提前接管捷径；状态翻转再带所读行的 `claim_owner + claim_generation` token。增加“旧 generation、lease 尚未来、不得 probe/release/resend”的反例测试。

2. **[HIGH] `discord_thread_create` 所需的 source-message 依赖无法由现有 schema 和 admission 同时表达。** Admission 规定所有 `notify_before` 只能指向 `prerequisite_notification`（`plan.md:120-125`），而 `discord_post` 明确是 action（`plan.md:172-177`）；Batch-1 DDL 也只允许 dependency kind=`notify_before`（`0001-base-schema.ts:94-113`）。但 thread create 又要求 `message_ref` 是“一条 discord_post 依赖”，并假设 claim 硬门已保证它 succeeded（`plan.md:126-130,225-231`）。这条 command 目前不存在合法入账形态。**建议**：把“通知前置”和“效果源引用”拆成两个机器概念。若坚持 17 表/只加不改，可让 typed payload 的 `message_ref` 独立引用 command id，并在 admission、claim/accept 同事务分别校验该 command 是 succeeded discord_post 且 receipt 含 message_id；thread action 自己仍另带正常 notify_before。把 source ref 当 notify_before 会污染终版三分类。

3. **[HIGH] 结果分类、retry budget 和 durable `accepted` 状态没有一套可执行的 settle 协议。** 终版要求 `stale|policy_denied|noop → rejected`，但当前 CAS 族只有 executing→failed（`plan.md:86-98`），正常生命周期也明确把 permanent failure 写成 `failed(result_code='policy_denied'/'noop')`（`plan.md:217-236`）；这与后面的 P8 验收“→ rejected”自相矛盾（`plan.md:337-341`）。`EffectExecutor` 只有 `retryable:boolean`，无法表达 stale/policy_denied/noop；reschedule CAS 又无预算谓词，`retry_count>=5` 的 terminal CAS、terminal observation/kernel-decision event、依赖级联原子性都未定义。此外 claimed→accepted→executing 在同一事务 B 内（`plan.md:223-239`），因此测试声称的“accepted 已提交后崩”物理上造不出来。**建议**：列出完整 typed settle 表和 canonical CAS：三种 expected denial→rejected+kernel decision event；预算内 retry→pending；预算耗尽→failed(retryable_failure)+terminal observation+obligation+依赖级联；effect_unknown→failed+obligation；success→succeeded+receipt。明确 retry_count 是“已重试次数”还是“总 attempt 次数”并锁掉 off-by-one。accepted 若保留为恢复态，就必须独立提交后再开 intent 事务；否则删除对应 crash-window 声称和测试，但那将偏离已裁决状态机。

4. **[HIGH] manual-gate 的 at-most-once 保证缺少 intent 时的权威 consume CAS。** Claim 的 GATE_SLOT 在事务 A 检查 capability，事务 B 才消费（`plan.md:195,223-232`）；capability 可在两事务之间过期或被撤销。仅写“consume 与 effect_intent 同事务”不足以保证有效性，也没有对应 canonical SQL。**建议**：在事务 B 以 expected-changes=1 执行 consume CAS，至少重检 `consumed_at IS NULL`、`revoked_at IS NULL`、有效期/absolute deadline、action/audience/task/generation/subject 绑定；FLY-1498 的 exact-head 校验必须作为这个 consume-time hook 的冻结合同，而不只是 claim-time 插槽。新增“claim 后、intent 前 revoke/expire/head change”三组竞态测试。

5. **[HIGH] probe 合同丢失证据，且 `present/absent` 的通用含义对删除类效果是反的。** `probe()` 只返回三个字符串（`plan.md:207-214`），但 present-adopt 必须补写带外部 id/url/observed SHA 的 receipt；例如 PR open、GitHub comment marker 都不能从裸 `present` 恢复 receipt。通用 reconcile 又规定 present→succeeded、absent→重放（`plan.md:249-258`），而 branch delete 行却写 absent=目的已达（`plan.md:186`），terminate 也有同类反向语义。**建议**：把效果探针结果改成 `{outcome:'effect_applied', evidence}` / `{outcome:'effect_not_applied', evidence}` / `{outcome:'unknown', error}`，不要复用 attempts 的“资源在/不在”词义。对 branch delete 明确三支：ref absent→succeeded；ref present 且 SHA 相同→lease 到期后 CAS delete 可安全重试；ref present 且 SHA 不同→stale/rejected，绝不删。并把当前 v1 已有的 managed shape、main/master/default/protected deny、exact merge evidence 或 unmerged bundle recovery 全部带入 payload/admission/executor（`packages/teamlead/src/bridge/branch-cleanup.ts:21-27,330-416`）；满足这些条件后，我支持它不进 manual_gate。

6. **[HIGH] saga 的静态防递归规则会拒绝处置表自己的合法补偿。** 表里 `discord_post`、`linear_comment_create`、`github_comment` 的补偿都是“追加更正”（通常仍是同 kind），但 planner 又静态要求 compensation target 的 disposition 只能是 `{none,forward_repair}`（`plan.md:176,182,185,195-198,331-335`）。按当前表，编译期断言必然失败。**建议**：要么新增语义明确且 disposition=none 的 correction kinds，并同步扩充穷尽表；要么给 command 增加机器可验的 `compensation_of`/bounded compensation 标记，使 planner 永不对补偿 command 再规划补偿。保持“每条补偿自动附一条 notify command”不变，并补 failure/cancel 路径测试。

7. **[HIGH] “same-kind lane FIFO 保证长 Discord 文本分片顺序”不成立。** 候选策略固定 DC1 immediate 优先于 DC2 scheduled（`plan.md:137-165`）。若 chunk 1 unknown/429 后进入 scheduled retry，chunk 2 仍是 immediate，会先发出去；`ORDER BY created_at` 又没有稳定 tie-breaker。单 lane 只保证不并发，不保证跨 retry 的业务顺序，因此会把已知 partial-delivery 坑换成乱序坑（`plan.md:126-128,200-203`）。**建议**：给分片建立 durable group+ordinal/前一片 succeeded 硬门，并在前片 terminal failure 时原子 cancel 后缀；仅加 `ORDER BY created_at,id` 只能解决确定性，不能解决 retry 越序。验收必须覆盖“首片重试、后片仍 immediate”“相同 created_at”“dispatcher 重启”三例。

8. **[HIGH] `effect_key` 冲突被无条件当 noop，会把真正的幂等键碰撞静默变成丢 command。** `admitCommand` 返回 `void`，并规定 UNIQUE 冲突直接 noop（`plan.md:108-124`），却不比较已有行的 kind/payload_digest/task/attempt/generation/cutover/dependency envelope。生产方重放时若 command id 不同，也拿不到 canonical existing id，后续 dependent 可能引用一个从未插入的 id。**建议**：返回 `{inserted|replayed, commandId}`；冲突后只在完整 canonical envelope（含确定性 JSON digest 和 dependency set）相等时视为 replay，否则 fail loud。FLY-1499 和 saga composer 必须使用返回的 canonical id。增加“同 effect_key 不同 payload/依赖/epoch”拒绝测试。

9. **[MEDIUM] research §2/§8 仍有会改变 kind/adapter 设计的事实误差，尚不能作为“35 点全仓审计完成”的可复核证据。** (a) research 把 `:cool:` 含入可嵌 `<!-- fw:ek -->` 的 github_comment，但活代码明确要求 body 逐字为 `:cool:`，加 metadata 会让 workflow 不触发（`packages/teamlead/src/bridge/land-executor.ts:561-579`）；被引用的 `trigger_comment_id=` marker 是后续 workflow receipt，不是触发评论本身（同文件 `:598-620`）。(b) “本仓固定 @linear/sdk 64.0.0”不属实，teamlead/flywheel-cli 仍固定 60.0.0，而其他包用 64.0.0（`packages/teamlead/package.json:29-32`, `packages/flywheel-cli/package.json:22-24`, `pnpm-lock.yaml:1606-1612`）；新 dispatcher 必须自行 pin 并锁类型测试。(c) §8 把 DM 与 edit/typing/pin 一并称为表现层，但 severe alert 的 DM 是活的业务通知路径（`packages/teamlead/src/LeadAlertNotifier.ts:903-909,1509-1536`），应明确由 `notify` payload/executor 覆盖，或列为切换缺口，不能按外观损失排除。(d) GitHub 官方只把 422 定义为 validation/spam 等通用失败，不是“已有 PR”的证明；必须在 422 后按 head+base 精确 re-read 才能认领：[GitHub Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)。**建议**：提交带路径/调用方/效果/kind/退役理由的完整审计清单；为 exact-body `:cool:` 定义独立策略或明确批次3 由 github_merge 替代；修正 §8 的 DM 边界。

10. **[MEDIUM] attempts 探针只会创建 obligation，不会在事实恢复时销账，且 FLY-1501 接缝没有定义销账所有权。** absent/blind 会开 stable episode（`plan.md:267-274`），后续 present 只更新 observed/streak；§6.6 仅说 obligation 是 1501 输入（`plan.md:276-282`）。结果是瞬时 tmux 故障恢复后 open obligation 仍可持续抑制/通知。**建议**：明确由本批在 present/同代确定观测时原子 resolve 对应 `attempt_absent`/`attempt_probe_blind`，或把 exact resolve proposal/API 和验收冻结给 FLY-1501；增加 absent→present、blind→present、旧 episode resolve 后新 episode 可重开的测试。

## Verdict

CHANGES REQUESTED
