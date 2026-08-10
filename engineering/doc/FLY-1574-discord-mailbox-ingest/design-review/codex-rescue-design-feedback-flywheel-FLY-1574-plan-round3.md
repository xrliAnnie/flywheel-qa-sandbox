# Design Review — plan.md (Round 3)
Date: 2026-08-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

R3 已彻底移除 ON 路径的“状态未知就直推”，五态表、archived settle、CLI/registry 契约也基本闭合，整体设计离可实施只剩恢复协议的最后一层。当前仍有两个会破坏核心保证的缺口：Codex 仲裁只覆盖 ON 读旧权威、没有让 OFF 尊重已取得的 `chat:` inbox 所有权；Claude ingest intent 又不是 write-ahead，且现有 worker 没有定时重试能力，因此崩溃或持续 DB 故障时仍可能丢消息/永久滞留。

## What's Good (Keep)

- 五态 discriminated union 和完整 Claude ON/OFF 动作表已经消除了 identity conflict、并发第二个 OFF handler 直推以及 spool 永不收敛的问题。
- Codex 明确先看 LeadJournal/`xdept:` 再进入 `chat:`，正确识别了旧道权威不在统一 identity 中这一事实。
- ON 未取得权威 verdict 时不再 raw direct，选择 durable retry/hold cursor，终于与“恰好一次”验收方向一致。
- archived lane 从 `mailbox_log` snapshot 判定，无法判定时 `ignored_unknown_archived`，是在不改 schema 下合理的保守方案。
- full-fidelity/零截断、`readonly` registry、无副作用 version probe、verdict JSON 优先于退出状态，都已把 R2 的接口问题写成可测合同。
- QA 新增 ingest 故障、Codex transition 和混合翻转场景；发布 census、旧账 drain、回滚时 intent drain 也保留了诚实语义。

## Issues & Recommendations

1. **[BLOCKER] Codex transition 仍是单向的：ON 会尊重旧 journal/`xdept:`，但 OFF 不会尊重已提交的 `chat:` inbox lane。** 现计划 Phase 3 仍写“OFF 字节等价”。如果 ON 已提交 inbox 行、但进程在 RestPoll cursor 持久化前退出，operator 用 escape hatch 切 OFF 后，重放会进入旧 router/journal；mailbox 行稍后也会进 `acceptBatch`，而它用 batchId 去重，无法与旧 Discord messageId 去重，于是同一消息产生两个 turn。ON/ OFF 两个 runtime 短暂重叠时也可能各自在不同 store 成功，当前所谓混合并发测试没有一个双方共享的 Codex fence，无法保证通过。建议让 Codex transition 在两种 flag 状态都运行：OFF 先检查 active/archived `chat:` inbox owner 并跳过旧直推；更强且能覆盖跨进程并发的方案是让 Codex OFF 也在 `chat:` identity 中事务性取得 `inserted_external` 所有权，再进入旧 router，并为该 marker 定义 journal-based complete/recovery。补测 ON commit→cursor 前崩溃→OFF 重放，以及两个 Codex runtime 一 ON 一 OFF 同 id 竞争。

2. **[BLOCKER] ingest intent 必须在第一次 `chat-ingest` 前 write-ahead，而不是两次失败后才写。** Discord `messageCreate` 没有这里可用的 durable NACK/cursor；若第二次命令无 verdict 后插件在 `writeIntent` 前退出，且 SQLite 实际未提交，则 mailbox、spool、直推三处都没有消息，重启也不会自动重放该 event。建议先原子写入 ingest intent，再尝试 CLI；收到任一权威 verdict 后才删除，删除失败则由幂等 worker 再收敛。intent 写失败要有明确 fail-stop/高优先级告警语义，不能继续假定已有恢复记录。当前生产 spool 的 `SpoolIntentV1` 没有 `kind`，根目录文件名又是 `<messageId>.json`；请使用独立 `spool/ingest/` 子目录，或明确旧无 kind v1→`begin` 的兼容解析与不覆盖测试，避免升级时把已有 begin intent 判 corrupt/覆盖。

3. **[HIGH] “复用现有 worker 定时重放直到 verdict”与当前代码不符，并有 FLY-1646 再自旋风险。** `ChatReceiptRuntime.workerLoop` 在 `workRemains=true && progress=false && no new kick` 时立即退出；除 ready/新消息/kick 外没有周期 timer，所以坏 DB 下 intent 只尝试一轮，五分钟 stall advisory 也不会自行触发。建议为 ingest intent 明确定义一个持久化 `firstFailedAt/nextAttemptAt/attempts` 和单一 unref retry timer，采用有上限的退避；无进展时只安排未来一次唤醒，绝不在 while loop 内热重试。最好让 ingest 子目录有独立 bounded pass，避免为了它高频触发旧 external pending/settle 扫描。用 fake timer 锁定“无人发新消息也会恢复/五分钟会 advise”，并加一个固定时间窗最大 CLI 调用次数的 anti-spin 测试，直接覆盖 FLY-1646 教训。

4. **[HIGH] Codex `xdept:` 两个旧态的收敛动作使用了错误/不完整的 saga 步骤。** 当前 `ExternalReceiptSaga` 的协议是 `begin → router.submit → complete`；`handle(messageId, journalEntryId)` 是模型 turn 完成后的 settlement hook，不能代替 `complete`。表 0c 第 2 格写“router 注入 + saga.handle”，会让 external delivery_pending 不被 ACK。第 1 格也不能一概“跳过一切”：若 journal 已 accept 但对应 active `xdept:` 行仍未 complete（典型崩溃点就在 submit 后/complete 前），跳过后当前 runtime 没有周期 reconcile，该行会一直 pending。建议把表改为：journal hit + active xdept → idempotent `saga.complete` 后返回 true；xdept pending + no journal → `router.submit`（new/duplicate 均可）→ `saga.complete`，后续 outbound completion 仍由既有 `onEntryCompleted → saga.handle`；任何 journal/xdept lookup 或 complete 失败均返回 false 保持 cursor。测试需断言 xdept 行最终 ACK，而不只断言没有双 turn。

5. **[MEDIUM] 几个书面合同仍需与上述过渡例外对齐。** 0c 的混合竞争断言称“败者必须是 `legacy_external`”，但 ON 胜时 OFF 败者应是 `active_inbox`；应按胜者分别断言两组结果。Phase 5/生产验收称直推调用只在 OFF 分支，但 `legacy_xdept_pending` 在 ON 下明确续跑旧 router，这是必要的 fenced legacy-recovery 例外，结构测试应允许且单独锁定它，不能与自己的 transition table 冲突。最后，CLI JSON 写成固定 `{lane, deliveryId, seq}`，但 `archived` identity 没有 live row/seq；请把结果也定义成按 lane 区分的 union（例如 archived 的 `seq` 省略/null），避免实现时伪造序号或违反输出契约。

## Verdict

CHANGES REQUESTED — address items above
