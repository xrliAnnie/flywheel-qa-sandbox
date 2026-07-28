# Design Review — plan.md (FLY-1501) (Round 2)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质关闭 Round 1 中的 parent-open/C3a、notify payload/receipt、Codex 活跃会话事实、告警 kind parity、迁移 replay 语义等缺口，整体工程落点明显更接近可实施状态。但 recipient 的“发送时实时解析”仍读取周期性缓存，restart gate 的 receipt 与磁盘协议仍有会静默漏报或破坏 exactly-once/可恢复性的交错；W5 与 W4 也各留有一处未冻结的实现合同，因此本轮仍需修改。

## What's Good (Keep)

- W1 已改为符合现有 migrator 抽象的 `schema_migrations` ledger skip，并明确 schema drift 失败，不再吞 duplicate-column 错误。
- W2 新增 C3a parent-open 同事务 hook，冻结 `NotifyCommandPayloadV1`，补齐 `cutover_epoch`/`created_at`/receipt 成功条件，并明确更新 exact public API 守卫；这些修订覆盖了 Round 1 的 suppression 合同缺口。
- C4 已给出 additive、向后兼容的 runner identity shape 和跨 issue 写入责任；C5 也正确承认 Codex active session 当前没有 mailbox wake，并将真正的 daemon-turn delivery pump 交由 1499 裁决。
- W3 已把 cmux supervised 分支、五个 alert-kind surface、各 wrapper 的 marker/PID 前插入点以及 held 不污染 legacy crash-streak 纳入明确 scope。
- A4/A5/A9/A14/A15 的覆盖面较 Round 1 完整，尤其加入了 owner handover、parent-after-pending、磁盘 fault injection 和四类 vendor-turn 场景。

## Issues & Recommendations

1. **[HIGH] `resolveNotifyRecipient` 仍没有结构性消除 stale recipient。** 计划称其为“发送时实时解析”，但合同实际只读取 obligation 当前的 `notify_recipient_agent_id`，而该列仅由每分钟 age tick 重推导（`plan.md:34,37,96`）。交错仍然成立：tick 写入 old owner → registry owner 换代 → pending command 在下一次 tick 前被 claim/execute → resolver 读到 old owner；这与终版要求的“换代重推导”及 A4 的旧 owner 0 条不相容。**建议：**把 resolver 冻结为从 obligation 的 subject/`target_agent_id` 出发、在发送授权时读取 live registry 并推导 recipient（可在同一事务顺带刷新 obligation 缓存），而不是只返回缓存列；同时把 1500 的唯一调用点明确为 execute/effect handoff，而非含糊的“claim/execute”。A4 应显式规定 owner 换代与发送之间没有另一次 mailbox-age tick，才能证明修复来自接口本身。

2. **[HIGH] `lead-alert.sh` 的 `duplicate` 不是 durable receipt，不能推进 `held_alert_pending→held_alert_attempted`。** 当前脚本在 delivery row 为 `leased` 且 lease token 属于另一进程时输出 `duplicate`（`scripts/lead-alert.sh:452-456`）；这只证明另一个投递者暂时持有租约，并不证明它最终写下 `sent` 或 `queued` receipt。若该投递者在 Discord POST/receipt 前崩溃，计划当前映射（`plan.md:49,120`）会把 gate 永久置为 attempted，之后不再重试，形成静默漏报。**建议：**只有 `sent` 与 `queued_transient` 允许推进 attempted；`duplicate` 必须保持 pending，待 lease 到期后重试，或由调用方轮询到 `sent|queued_transient|dead_lettered` 的终态再裁决。A9 增加“另一进程持 lease 后在 durable receipt 前崩溃，gate 保持 pending，lease 过期后重试收敛”的用例。

3. **[HIGH] spool/ledger 的 crash-safe 细节仍不能兑现 create-once 与 partial-tail 恢复。** 第一，普通 POSIX `rename` 会覆盖已存在的终址，不会产生计划所写的 “EEXIST 语义”；`plan.md:44` 的 O_EXCL 与 `plan.md:47` 的 rename 也互相矛盾。仓内已有可参考的 no-clobber 原子发布方式：`backupDatabase` 用同目录完整 temp 后 `linkSync(temp, dest)`，终址存在时失败（`packages/v2-kernel/src/backup.ts:76-92`）。第二，kernel reconciler 会把 live spool rename 到 `applied/`（`plan.md:38`），但计划未要求它持 child lock、也未要求 `ensure-spool` 把 `applied/<episode>` 当成功 receipt；在 Discord 仍 pending 时 reconciler 移走 live 文件，下一次 gate 会再次发布同一 episode。第三，“忽略末尾不完整行”后直接 append 会把新 JSON 拼到残尾后面，下一次读取就变成中部损坏；必须先截断到最后一个完整换行。**建议：**明确用 `link`/等价 no-replace primitive 发布完整 temp，成功后 fsync 目录；`ensure-spool` 同时验证 live 与 applied，且 reconciler 的 live→applied 移动加入同一 child lock（并写清 lock order）。ledger 在锁内先定位最后完整记录、truncate 残尾并 fsync，再分配 seq、append、fsync。A9/A12 补“partial tail 恢复后再重启一次仍可读”和“pending 告警期间 reconciler 与 ensure-spool 并发”的测试。

4. **[MEDIUM] W5 把显式非法配置静默降级为 60 分钟，且 production seed 落点仍未选定。** `plan.md:63,126` 将 0/负数/小数/非数值视为默认值，但当前 manifest parser 对显式非法的正整数配置采用拒绝策略（例如 loop `max_iterations`，`packages/teamlead/src/workflow-template.ts:499-502`）；静默回退会把 `180` 的拼写/类型错误伪装成可运行的 60 分钟，正好掩盖本工作块要修复的长 QA 过期问题。并且仓内同时存在八个 `tpl_eng*.yaml` seed，默认 bundled template 是 `tpl_eng_heavy`；“implement 时定位现行 qa 节点 seed”（`plan.md:64`）仍不是工程落点。**建议：**只在字段 absent 时默认 60；字段 present 但不是 positive integer 时让 v1/v2 validator 失败，并相应改 A15。现在就在 plan 中点名要写 180 的确切 seed（以及 land/tier 变体是否同步），不要把选择留到 implement。

5. **[MEDIUM] W4 的阻塞结论在实施顺序中仍自相矛盾。** W4 正文明确“整块 blocked on C5/C7”“不再宣称临时落包可先行”（`plan.md:55-59`），但顺序段仍允许“临落 `agent-team-transport`”（`plan.md:105`），这会重新打开 Round 1 已要求关闭的错误落包路径。**建议：**删除临时落包分支，明确 C5/C7 未签字时本 PR 不实现/不宣称完成 W4；同时把交付物总览中 W3 的“四个 wrapper”更新为当前实际五个 supervised entry。

## Verdict

CHANGES REQUESTED — address items above
