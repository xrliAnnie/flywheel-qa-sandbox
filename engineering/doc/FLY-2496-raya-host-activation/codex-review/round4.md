# Design Review — plan.md (Round 4)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮严格只复核 Round 3 的三个 finding。v4 已接受并明确化三项关键设计选择：`baseline=quiet15m` 是 Lead/founder 明示的历史范围裁定而非处理证明；main fast-forward 已移到 quiesce 前；activation 也被重新定义为跨标准 Lead 进程换代保持不变的迁移事务身份。这些方向本轮不再重议。但对照真实代码，三个 disposition 各仍缺一个会影响执行结果的机械闭环：stop-window 中人工确认 processed 后没有推进最终 seed cursor；目标 SHA 删除旧 CLI 后，现有 legacy matcher 无法在 ff 后通过；rebind 对 ledger 与 stale proof 的双文件更新没有崩溃安全顺序。前两项会分别造成重复副作用和确定性无法 quiesce，后一项会把合法漂移变成下一班 `proof-invalid` severe。因此仍需 `CHANGES REQUESTED`。

## What's Good (Keep)

- `CURSOR-BOUNDARY` 不再从任意 Raya bot 出站推断处理完成；pre-stop quiet gate、[T0,T1] 内人类消息一律 unresolved、以及 founder 明示 `baseline=quiet15m`，都准确区分了“授权划定范围”与“机器处理证明”。本轮接受 Lead 对历史 baseline 的裁定，不重新争论 15 分钟窗口本身。
- `PRESTOP-PREFLIGHT` 已把 package install/build 和 main ff 移到停旧壳之前；quiesce 后只晋升已验证候选并调用标准 Lead install，关闭了 Round 3 指出的“停机后再决定构建字节”问题。
- `SHA-FREEZE` 将 activation 明确定义为 `<migration_id>:<activated_at>`，同时把 PID/start/thread/TUI 保留为 proof 时刻的 live-process 证据；这一语义在现有 `raya_p6_evidence_valid` 的非空/equality 检查下可实现。完整 pin restart-status、Bridge buildSha、live verify，以及 proof 工具共用 Raya deploy lock，也关闭了并发 proof writer 与 updater 互相穿越的主要竞态。

## Issues & Recommendations

1. **stop-window 的 processed resolution 仍没有形成最终连续 cursor。**  
   `findingKey: FLY2496-R1-CURSOR-BOUNDARY`  
   **Issue:** v4 正确拒绝 processed/unprocessed 交错，但 §5 B 仍固定 `B = 最后一条时间 < T0 的消息`（`:154`）；§5 C（`:155`）只说明 `confirmed_unprocessed` 会把 B 压到最早 unprocessed 之前，没有说明 `confirmed_processed` 如何把 B 向前推进。反例：m1 是 [T0,T1] 内唯一的人类消息，Lead 人工确认它已经由旧壳完成副作用并标为 `confirmed_processed`；unresolved 被清空后，seed 仍是 `<T0` 的 B，真实单标量 cursor 会再次拉取 m1。若 m1 processed、m2 unprocessed，正确 cut 应在 m1 与 m2 之间，当前公式仍停在 T0 前。`confirmed_processed` resolution 因而没有兑现“留在连续前缀”的语义。
   **Why it matters:** P4b 会在 `unresolved=[]` 后继续，但已确认完成的 stop-window 输入仍被新 owner 重放，calendar/meeting/回复可能重复；这正是该 finding 要避免的副作用。
   **Suggested fix:** 明确定义 `B_final`：从授权 baseline `B0` 开始，按 snowflake 排序验证 stop-window resolution 必须是零个或多个 processed/reconciled 项组成的前缀，随后才允许 unprocessed 后缀。存在 unprocessed 时，`B_final` 是最早 unprocessed 之前的最后一条频道消息；全部 processed 时，`B_final` 是 T1 之前的最后一条消息。任何 processed 出现在 unprocessed 后仍拒绝。把 `B_final` 落账本并用真实 seed CLI 覆盖“processed-only”“processed→unprocessed”“unprocessed→processed 拒绝”三例。

2. **ff 后的 legacy owner 复验按现有 matcher 会确定性失败。**  
   `findingKey: FLY2496-R1-PRESTOP-PREFLIGHT`  
   **Issue:** 目标 `9d63a2b2…` 已删除 `apps/brain` 和 `apps/voice`。现有 `raya_legacy_plist_matches` 从当前 `$RAYA_CODE_DIR/apps/$app/dist/cli.js` 构造期望 argv，并要求 `args[0]` 仍是存在、非 symlink、可执行的普通文件（`updater-raya-deploy.sh:196-216`）；`raya_quiesce_legacy_owner` 在每次 bootout 前直接调用它（`:220-230`）。v4 却先把同一 checkout ff 到删除这些路径的目标 SHA，再“复验两份 legacy owner identity”并进入现有 quiesce。届时 matcher 在 `os.path.isfile(args[0])` 必然失败，两个旧 job 不会被停，班车也到不了 P3/P5。
   **Why it matters:** 这不是残余概率风险，而是给定固定 target SHA 的确定性不可达路径；“ff 是最后一个可逆步骤”的 disposition 尚未与真实 destructive identity fence 对齐。
   **Suggested fix:** 在计划中选择并写死一种可实现的 fence。最小改法是在 ff 前持久记录并核验 plist SHA、label/argv/cwd/env、旧 CLI digest 及 live PID/start tuple；ff 后不再要求已删除路径仍存在，而是 CAS 核验 plist 字节和同一 live PID/start 未变，再凭该快照授权精确 bootout。若不愿改变 legacy matcher，则 main checkout 必须保持旧头直到 quiesce，候选晋升和后续 frozen-source 校验需与 main HEAD 解耦。新增一条使用真实 0f77e977→9d63a2b2 删除布局的测试，证明 ff 后的身份 fence能通过且任何 plist/PID/start 漂移仍零 bootout。

3. **rebind 的 ledger/proof 双文件变更仍不是 crash-resumable。**  
   `findingKey: FLY2496-R1-SHA-FREEZE`  
   **Issue:** 共享 `deploy.lock.d` 能排除并发 writer，但不能让两个文件原子更新。§4/§5 A（`:142,153`）按文字顺序先 CAS 更新 ledger 的 `flywheel_deployed_sha`/checkpoint，再把旧 `proof.json` 改名。若进程在 ledger rename 成功后、proof rename 前崩溃，下一班看到 ledger SHA 已等于 current，因而不再进入 rebind；随后现有 `raya_standard_collect_proof` 会读取仍绑定旧 Flywheel SHA 的 proof，`raya_validate_proof` 失败并走 `proof-invalid` severe。现有测试清单覆盖“P6 后 crash 再 rebind”，但没有注入 rebind 自身两个持久写之间的 crash。
   **Why it matters:** 合法 Flywheel 漂移仍可能因一个明确的 crash point 变成 severe 且不能自动续跑，违反该 disposition 的 `awaiting_rebind_proof`、无 severe 合同。
   **Suggested fix:** 在同一锁内先把旧 proof 原子 quarantine，再 CAS ledger；此顺序中任一点崩溃都可重试：若只完成 quarantine，ledger 仍漂移，下一班继续 rebind；ledger 提交后则不存在可被误读的旧 proof。或者增加持久 rebind intent 并让 pass 在 collect 前收敛 intent。P6→P5 的同一 manifest CAS 应同时清除或明确标记旧 proof-derived fields。增加 proof quarantine 前、quarantine 后、ledger CAS 后三个 crash-injection 用例，并断言恢复结果均为 `awaiting_rebind_proof`、零 severe。

## Advisory (non-blocking)

- research §4 的证据表述不准确：`apps/brain/src/runtime.ts:279-305` 是 voice down/recovered alert 的裸 POST，不是人类消息回复路径；真实 voice/meeting gateway 在 `voice-mode.ts:629-638`、`meeting.ts:1036-1045` 调用 `message.reply(content)`。这不推翻 Lead/founder 已裁定的 quiet15m baseline，也不提供完整 durable processing ledger，但应把“所有文字回复都无 message_reference”改成可由源码支持的较窄结论。
- exploration 仍有旧算法残留：§2.7 和 §4.3 还写“未应答消息/更早视为已处理”，与 v4 的“零处理推断 + founder-authorized out-of-scope baseline”不同。实现前应同步，以免工程师从 exploration 复活已否定逻辑。
- pre-stop quiet check 当前只写一次 `GET …?limit=100`。若返回页最老消息仍落在 15 分钟内，应继续分页或 fail-closed；否则大量 bot 消息可遮住同窗口内的人类消息。P3 会再次阻止 seed，所以这里不构成漏信，但会把本可在停机前发现的 `channel-active` 延后到停机后。
- 稳定 transaction activation 是已裁定语义；它不保证 rebind 后的 text/summary E2E 证据来自当前 PID。若验收方还想证明当前进程而不只是同一 activation，rebind 后需重做 H4.1 并等待当前进程之后的新 summary round；否则文档应保持“restart-status + live verify 为当前进程证据”的诚实边界。
- 本轮仅做三项 disposition 的 source-grounded static confirmation，没有运行会生成产物的测试/构建命令。

## Verdict

CHANGES REQUESTED — address items above
