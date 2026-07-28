# Design Review — FLY-1499 plan.md (Round 1)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向正确：新建 `v2-engine`、零接线、kernel add-only、INDEXED BY 显式修订、短事务/事务外转化和 kernel-first TDD 顺序都与既定裁决一致。当前计划仍有多处会破坏 §1.2a-f 核心不变量的阻断项，集中在 attempt 与消息/身份绑定、cutover 死亡证据、runner 单在途、晋升配额、deliver/T_max 分阶段语义及终局改投交错，因此还不能直接进入实现。本轮按当前 HEAD `b239f005` 核对了实际 schema/API；本地包测试因工作树未安装 `node_modules` 无法复跑，此环境限制不影响以下源码级结论。

## What's Good (Keep)

- 范围划分清楚：`packages/v2-engine` 零接线，1500/1501/1498/批次3 的所有权基本没有被抢占；kernel 仅扩导出/FENCE，唯一既有内容修订明确限于已批准的候选 SQL。
- STAT4 台账处置是技术上成立的。`INDEXED BY` 与现有七索引谓词匹配，研究 spike 覆盖了 ANALYZE、正确性等价、索引缺失 fail-loud 和谓词不匹配拒绝；带统计矩阵比批次1的空统计快照更接近真实运行。
- start、成功、显式失败均以短 `Kernel.write` 为边界，LLM/网络在事务外；这符合当前 `Kernel.write` 的同步、`BEGIN IMMEDIATE`、默认 1000ms budget 和禁止嵌套合同。
- `pa_one_running`、attempt CAS、mailbox CAS、generation fence、重启保守恢复为 K、批次间重查等既定机制都被保留，且测试矩阵已有大量正确的故障注入方向。
- 对语句注册表的“评估后否决”忠实记录了 Lead 裁决，没有借台账之名扩张运行时安全机制；`sql.ts` 仅作为代码纪律的定位合理。
- 实施顺序先改 kernel 的 SQL/导出/快照，再搭 engine，最后做 loop/driver/场景验收，整体顺序正确。

## Issues & Recommendations

1. **[HIGH] Runner 没有可调用的 proposal 结算入口，且当前结算形状允许 attempt/message/identity 错配。** `InjectionShim.deliver` 只给 vendor `{messageUid,payload}`（plan §4.0），但 `settleSuccess` 还要求另传 `attemptUid`（§4.4），而 §10 的 root export 又没有 `settleSuccess`、`settleFailure` 或 `submitProposal`。更严重的是，mailbox CAS 使用 `proposal.messageUid`，processing-attempt CAS 使用独立的 `attemptUid`；计划没有验证该 attempt 行的 `message_uid/instance_id/generation/activation_id` 与 proposal 一致，因此把消息 B 与 attempt A 配对会原子地得到“B applied、A succeeded”的错误账。建议定义唯一公开入口 `submitProposal(proposal)`（以及明确的 runner failure 入口）：事务内按 `messageUid + outcome='running'` 取唯一 attempt，逐字段校验 owner identity 与当前 registry/to_agent，再落 effects 和双 CAS；调用方不得自由拼接 attemptUid。补交叉 UID、旧 activation、错 instance/generation 的负向测试。

2. **[HIGH] 注册事务的 death evidence 和 runner cutover 没有绑定到它实际替换的 authority，也无法与 1498 的 activation 换代原子组合。** §4.1 只接收 `priorConsumerConfirmedDead: true`，这个布尔值可被错误复用于另一个 instance/generation/activation；查询又用 `pa.generation < newGen` 批量归因，而不是精确绑定旧 registry identity。计划也没有校验 runner 的 activation 存在、仍 active、generation/agent 匹配。权威设计还要求 runner 的“旧 activation terminal + capability revoke + 新 attempt/activation + registry cutover”处于同一 immediate 事务，但当前 `register()` 自己拥有一个 `Kernel.write`，1498 无法在外层组合；若直接复用 §4.5 的 `settleFailure()` 还会命中当前 kernel 的 nested-write 拒绝（`kernel.ts:273-280`）。建议把证据改成绑定旧完整身份的 typed `DeathEvidence`，事务内重读旧 registry 并逐字段核对；crash attribution 只结算该 exact identity 的 running attempt，遇到更古老/foreign running 行 fail-loud。另提供 tx-scoped 内部 helper 或由 engine 拥有的高阶原子换代 API，让 1498 只贡献 activation/capability mutation，且 crash settlement 复用 `settleFailureTx(tx,...)` 而不是嵌套 `Kernel.write`。

3. **[HIGH] “每个收件人串行、batch=1”目前只在单个 `ConsumeLoop` 内成立，runner pump 可以为同一 agent 开第二条消息。** 当前 `pa_one_running` 仅保证“每 message 一条 running”（实际 schema `0003...ts:11-23`）；`startAttempt` 也只查目标 message 的 running。若普通消息已 deliver 成功但尚未结算，此时新 founder 消息到达，下一 tick 可选 founder 并为它再开一条 attempt，形成同 recipient 多在途；普通 loop 与 runner pump 并发触发也没有共享 single-flight。这样会破坏串行消费、公平计数、crash attribution 的有界性和 1s 注册事务预算。建议所有 wake source 汇入同一个 per-agent coordinator；start 事务先 join mailbox 检查该 `to_agent` 是否已有任意 running attempt，有则只允许 resume 那一条，禁止新 message start。测试必须覆盖“running N1 + 新 F1 + tick/ring 交错仍只有一行 running、一次 vendor conversion”。

4. **[HIGH] §4.2 的晋升算法违反 K=4 的硬保证。** 伪码把 promoted non-founder 从 `normalClass` 移除；当 `founderStreak=K` 且唯一 non-founder 已晋升时，`normalClass` 为空，算法仍进入 founderClass，并可能因较老的 founder 候选而继续选 founder。于是 ready non-founder 在连续 K 个 founder 后仍可被跳过，和设计“最多 K 个 founder 后必须服务一条最老 ready non-founder”直接冲突。建议始终保留完整 `nf` 作为配额清账池：若 `streak>=K && nf.length>0`，无条件选最老 nf（无论是否 promoted）并清零；只有预算未耗尽时，promotion 才把 nf 提到 founder 同级参与优先选择。增加 `streak=K + promoted nf + 更老 founder` 的最小反例和 property test。

5. **[HIGH] Runner 的 deliver 与 T_max 使用同一个 `processing_attempts.started_at`，没有实现 v11 的串联阶段语义。** §5.3 在 deliver 前先 `startAttempt`，并从该 started_at 计算 5 分钟 deliver deadline；§5.4 又从同一 started_at 计算 10 分钟 T_max。若注入恰耗 5 分钟，健康转化实际只剩 5 分钟就会被判卡死，而 v11 明确规定 `deliver → conversion` 串联、T_max 不包含 deliver（`design-v11.md:6-11`）。此外 `maxAttempts` 被做成可配置，但 §7 的公式仍硬编码 5；构造校验也只限制 T_tick，没有兑现 T_deliver_tot/T_switch/T_due_cap 的设计上限。建议在不违反“schema 不改”的裁决下明确一个可重放的 phase transition 和两个不重叠 deadline（并列出 deliver 成功前后每个 crash window）；若现有 schema 无法诚实表达，必须先回 Lead 选择最小兼容方案，不能用同一时间戳冒充两阶段。`maxAttempts` 要么固定为 5，要么把公式正式参数化为 M 并走设计修订；同时补“deliver 接近 5min 后仍享有完整 10min conversion budget”测试。T_max 信号也应有成功接收/重试合同，不能用未确认的一次性 callback 冒充活性保证。

6. **[HIGH] 终局收件人处置会留下旧 running attempt，并可用陈旧 lifecycle 信号抢走新 generation 的消息。** §5.3 规定 activation terminal 后 pump 停止、消息保持 pending；§6 随后只改 mailbox `to_agent/state`，没有结算对应 running attempt。改投 owning Lead 后，新 owner 的 `startAttempt` 会看到旧 running 行并按 §4.3 的 resumed 分支复用它；旧 proposal 也可能晚到。处置事务还未重查“旧 activation 仍 terminal 且无继任/current registry 未切到新代”，`mailboxCasRedirect` 甚至没有 `to_agent=:oldAgent` 谓词，因此 stale disposal 可在新 runner 注册后继续改投。建议处置输入绑定 terminal activation/generation，事务内重验 registry/activation/no-successor；先以精确 owner CAS 终结旧 running attempt，再按 retention class 改投/dead/tombstone。所有 mailbox CAS 均绑定旧 recipient；redirect 应清除未来 `next_retry_at` 以便新 owner 立即可见，并穷举 `dlq`、owningLead=self、目标 Lead 不可路由。补 disposal vs successor-register、late-success、new-owner-start 三组交错测试。

7. **[HIGH] `Effect` 类型目前不能按实际 17 表 schema 落账，且“≤十几条语句/1s 内”没有输入边界保证。** `task` effect 没有 `projectId`，但真实 `tasks.project_id` 是 NOT NULL（`0001-base-schema.ts:2-14`）；command/event/task 的稳定 ID、created_at/digest 生成规则也未定义，command 还允许 `effectKey:null`，与外发 effect_key 幂等支柱不一致。`effects: Effect[]` 和 payload 都无上限，却据此断言事务只有十几条语句。建议补齐可执行的 normalized effect schema（至少 projectId、所需关联字段、外发 command 的非空稳定 effectKey），在事务外完成边界校验、ID/digest 预计算并限制 effect 数量/总 payload bytes；事务内只做有界 INSERT/CAS。逐种 effect 做真实 schema 正反例，并验证超限 proposal 在进入 `Kernel.write` 前被拒。

8. **[HIGH] 第 5 次失败的 mailbox 账会停在 `retry_count=4`。** §4.5 在前四次使用 `mailboxCasScheduleRetry` 自增；第 5 次改用 `mailboxCasPendingDead`，而 §2 的该 SQL 只改 `state='dead'`、不增加 retry_count。结果与“5 次实际失败→dead”以及 SLA 的 `R=5-retry_count` 不一致，也把“失败致 dead”和“终局处置致 dead”混成同一 CAS。建议新增两个不同模板：failure-dead 原子执行 `retry_count=retry_count+1,state='dead',next_retry_at=NULL`，disposal-dead 不伪造失败次数；失败类模板同时绑定 `to_agent`。测试除断言 state 外，必须断言五个 processing_attempt 终态和 mailbox.retry_count 恰为 5。

9. **[MEDIUM] enqueue 把数据冲突静默伪装成 duplicate，并且 notice/epoch 合同不完整。** §4.7 将任意 `UNIQUE(source_kind,source_id)` 冲突都翻译为 duplicate，却没有比对 existing `payload_digest/to_agent/kind/retention_class`；设计 v5 明确要求同 canonical key 的 digest 冲突 fail-loud。过载分支写的是“kind 属 notice 类”，实际权威字段是 `retention_class='notice'`。此外公开 enqueue envelope 没有 caller `cutover_epoch`，而 `ensureCutoverEpoch` 会静默猜默认 1；这不能兑现设计“当前 epoch 持久于 meta、mismatch fail-closed”，并会迫使批次3修改公开 API。建议仅在完整 canonical envelope 相等时返回 duplicate，否则抛冲突；按 retention_class 判 notice；现在就给 ingress 定义 expected epoch 并在事务内与 meta 比较。默认 1 若只为测试 bootstrap，应改成显式初始化 API/fixture，不能藏在生产 register 路径。

10. **[MEDIUM] 两处书面测试/范围合同需要在实现前修正。** 第一，§3.3 声称与 v10 的 diff“每条恰两处插入”，但 §3.2 同时把四条 SQL 注释从“命中”改成了“钉死”，现有 byte-diff 测试按该文本不可能通过；保留原注释即可让两处插入合同成立，或把注释替换明确纳入允许 diff。第二，§8 已承认精确 due `setTimeout` 没有任何枚举场景且 tick 已承担活性，按本计划自己的 anti-over-reaction 原则应直接从本批实现/TDD 删除，而不是一边标“可砍”一边继续交付。TDD 矩阵还应在写 GREEN 前加入以上最小反例：错配 proposal、stale death evidence、同 agent 双在途、promoted quota、deliver+T_max 串联、disposal/cutover 交错、第五次 retry_count、canonical digest 冲突。

## Verdict

CHANGES REQUESTED — address items above
