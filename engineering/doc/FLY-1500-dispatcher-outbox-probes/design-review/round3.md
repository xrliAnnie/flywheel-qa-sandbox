# Design Review — plan.md (Round 3)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已实质关闭 R2 的 malformed-JSON、索引覆盖、probe streak 清零、head+base 认领和大部分文字漂移；新版候选 SQL 也通过了本机 SQLite 3.51.0 实证。不过 commands 仍缺“每次执行尝试唯一”的 CAS token，迟到的旧 probe/receipt 可以结算重排后的新 attempt；新增 kernel-action K 也没有可用的 granted terminal CAS。另有 branch-delete 护栏与声称新增的验收项未完整落盘，因此仍不批准进入实施。

## What's Good (Keep)

- `CASE` 惰性 JSON 门是正确方向。我按计划原样实测，前置 malformed payload 被挡住，后续合法 command 仍可被选中，查询不再报 `malformed JSON`。
- 两条 partial index 追加 `id` 后与稳定排序完全对齐；DC1/DC2 均命中目标索引且不再出现 `USE TEMP B-TREE`。
- `commandCasRescheduleAfterProbe` 把确定未生效、重排和 unknown streak 清零收进同一 CAS，关闭了跨 attempt 串案。
- `github_pr_open` 的 422 重读与 crash probe 已统一为 repo+open+head+base 的唯一精确匹配；同 head 异 base 不认领的合同正确。
- kernel-action 与外发 adapter 分流、事务 K 原子写业务效果与 `bypass_used`、delegate 未注册 fail-closed 的架构方向正确，姊妹批次所有权也切得清楚。
- `github_branch_delete` 在副作用前 fresh 重验 policy/merge/ref 的方向正确；只要下面的 binding/bundle 分支补全，我仍支持它不进 manual_gate。
- 补偿 command 不豁免 notify-then-do、由 planner 自动附通知依赖，以及 Discord 表现层效果不进 outbox，这三项裁决继续成立。

## Issues & Recommendations

1. **[HIGH] owner+dispatcher generation 不是“每次 claim 唯一”的 token，迟到的旧 attempt 仍能结算新 attempt。** Round 3 的 release CAS 精确匹配 `claim_owner + claim_generation`（`plan.md:113-124`），但同一 dispatcher 在 retry 后会复用这两个值；`retry_count` 才会从 0 变 1。所有 accepted/executing/success/reject/reconcile CAS 仍只匹配 owner/generation（`:75-133`），而 §6.4 又声称 probe 后若 command 已被别人翻走，CAS 必然失败（`:341`）。我按 canonical SQL 实测：attempt 0 executing→被重排到 retry_count=1→同 dispatcher 再 claim 到 executing；此时 attempt 0 的迟到 success CAS 更新 1 行，把 attempt 1 写成 succeeded。旧 release 在后续 claim 的 lease 也过期后同样会更新 1 行，并不满足所声称的“旧快照必须 0 行”。**建议**：把 `retry_count`（或新增不可复用的 `claim_attempt_id`）纳入 claim 时读出的 token，并加入 claimed 之后的每条 CAS、probe settle、receipt settle、BudgetExhausted 和 K 路径；release 可再精确匹配 observed lease。新增两个竞态测试：旧 release 对 reclaim 后的 attempt 永远 0 行；旧 probe/execute completion 不得 settle 新 retry attempt。

2. **[HIGH] kernel-action 的 granted 路径没有任何 canonical CAS 可从 `claimed` 到 `succeeded`。** 事务 K 明确从普通 claim 后直接执行业务 CAS并终局（`plan.md:363-375`），但 §3.2 唯一 success CAS 是 `state='executing' → succeeded`（`:88-90`）；K 又明确不走 B1/B2/C，因此按“canonical SQL 原样使用”无法实现 granted 分支。denied 可勉强复用允许 `claimed` 的 rejected CAS，但 dependency cascade、事件 uid、delegate 返回类型也未落定。**建议**：新增精确 token 的 `commandCasClaimedSucceeded`/`settleKernelAction` typed op，事务内固定顺序为：requireIdentity→确认 delegate 已注册→校验/消费 capability→同步 `delegate(tx, cmd)` 业务 CAS→deterministic `bypass_used`→command terminal→依赖级联；delegate 接口必须接收现有 `WriteTx`、禁止 async/嵌套 `Kernel.write`，并返回封闭的 granted/denied 结果。未注册检查应在 consume 前，避免零效果却烧掉单次 capability。补 crash-before-K、K 中途异常全回滚、granted/denied dependency cascade 测试。

3. **[HIGH] branch-delete 的“不进 manual_gate 前提”仍有两个缺口：binding 未重验，bundle recovery 与 merged-only executor 互相矛盾。** Admission 允许“merge evidence 或 unmerged-bundle recovery”（`plan.md:172-176`），payload 也声称持久化 bundle 凭据；但 executor 行只列 merged PR head/merge-base evidence，没有 binding check，也没有验证 bundle 确实携带 expected SHA（`:246`）。当前 v1 ship 路径会 fresh 校验 worktree binding 再查 exact merged head/ancestor（`packages/teamlead/src/bridge/branch-cleanup.ts:367-404`）；unmerged 恢复路径还会 `bundle verify` 并确认 list-heads 含 expected SHA（`:458-475`）。**建议**：把 executor 明确拆成两个互斥模式：merged cleanup=exact binding+fresh merge proof；recovery delete=exact binding+已验证 bundle containing expected SHA。任一证据缺失/不确定均零删除。随后补齐用户所列的 no-merge-evidence、protected-policy change、binding mismatch、bundle missing 四个 executor 级测试；完成后维持“不进 manual_gate”的裁决。

4. **[MEDIUM] Round 3 声称新增的多数回归测试实际上没有进入 plan 的 §8。** 当前 §8.2-§8.5（`plan.md:399-435`）没有旧 release snapshot/reclaim、malformed 行不阻塞、跨 attempt streak、`retry_count=5 + effect_not_applied`、四个 branch-delete 零删除、同 head 异 base或 schema-contract exact-set 测试；相对 Round 2，整个 §8 验收段没有这些 diff。只有 P12 测试写在 §6.7 行内（`:378`）。这会让本轮最关键的竞态/变异修复在实施时没有红绿锁。**建议**：把上述用例逐条落到 §8，并为 token、JSON CASE、branch guard、head+base 各保留对应的 mutation control；迁移测试明确断言新增列集合“完全等于”5+3，而非仅为旧列的超集。

5. **[MEDIUM] research 仍与“EffectExecutor 四出口为唯一权威”冲突。** Plan 已把显式 429/限流归为 `retryable_failure`（`plan.md:284-287`），但 research 仍把限流列入 unknown（`research.md:83,161`）；其 v1 GitHub 摘要仍写 422 后“按 head”认领（`:54`），Discord 分片结论仍声称仅靠 same-kind FIFO 保序（`:63`），接缝表也没有新 kernel-action delegates（`:145-151`）。**建议**：同步为 429→retryable、422/probe→repo+open+head+base、分片顺序→requires 链，并把 1498/1501 delegate 注册面写进 research 接缝，避免实现者从上游文档重新引入已修掉的协议。

## Verdict

CHANGES REQUESTED
