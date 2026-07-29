# Design Review — FLY-1520 plan.md (Round 6)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 6 已实质关闭 Round 5 的四项问题：launch token 变为一次性、`launched` 不可 takeover、锁参与者集合扩到所有 claim/terminal writer、admission agent 矩阵和 capability 调用图也已自洽。当前仍有一个 launch-vs-terminal 的阻塞竞态：T4/T6/T7 的 absence evidence 在取得 session lock 前采集，旧证据不能证明取锁时进程仍 absent；此外 crash-after-receipt 的恢复文字与 T6/T7 状态机矛盾，且三个实现映射位置仍保留旧 adapter 合同。因此本轮尚不能批准。

## What's Good (Keep)

- `pending→claimed→launched|tombstoned` 把 launch authorization 做成 activation-scoped one-shot；`launched` 后不再受 lease takeover，堵住了健康 runner 被重复启动的主漏洞。
- adapter 在 OS 锁内先 CAS `claimed→launched` 并写 durable receipt，再 exec；明确选择 at-most-once，且同 token 重放 fail/no-op，方向正确。
- pre-launch takeover 现在同时要求同一 session lock、claimed state、lease 到期、exact-session absent 和新 token CAS；旧 launcher 之后只能因 token 不匹配失败。
- lock ordering 已明确为 `LaunchLockPort → kernel`，禁止 kernel.write 内反向取锁；T4 多 session canonical 排序解决了多锁死锁风险。
- admission 矩阵现在允许合法 clear/active binding 的 generation>0 logical agent 被后续 issue 复用，同时只拒绝 missing/malformed legacy binding。
- capability 写入已拆为一个私有低层 insert 和三个领域 authority helper；github_merge“恰两个入口”与 writer-adoption 第三 namespace 不再矛盾。
- session_ref 的 activation identity、agent/attempt generation 分层、T4 quiesce、evidence closure、ship target snapshot、actions trigger 映射及零迁移/零 v2-engine 编辑边界继续保持。
- M2 已把一次性消费、takeover、锁交错、锁序、单飞与 admission 矩阵列为退出条件，测试组织方向正确。

## Issues & Recommendations

1. **[阻塞] terminal writer 仍可使用取锁前的旧 absence packet，OS 锁尚未封住“旧 probe→新 launch→terminal”交错。** T4 明确先在锁外 `requestStop→ProcessProbe absent`（`plan.md:382-392`），之后才按 §2.2b 获取 session locks；T6/T7 也以事务外 probe/DeathEvidence 驱动。§2.2b 只说“进锁后重验 evidence”，但现有 packet/公开 `DeathEvidence` 只有 agent、generation、confirmedAbsentAt，没有 launch_claim revision 或 receipt binding。可构造：T4 probe absent → adapter 取得锁、CAS launched、exec 并释放 → T4 取得锁，旧 packet 的 agent/generation 仍匹配 → terminal suite。对 closure 中未被重新注册换代的下游 agent，真实 `EngineDriver.attachRunner` 只检查 agents kind/generation（`packages/v2-engine/src/driver.ts:115-133`），activation terminal 不能替代物理 quiescence。**修正**：T4/T6/T7 在取得对应 session lock 后、kernel.write 前重新调用 `ProcessProbePort.probe`，只接受锁内 fresh absent；T4 应先 requestStop，再 canonical-order 取齐锁，在持锁状态下逐 session re-probe，任一 present 则零 DB 变更并释放。另一种等价实现是把 evidence 精确绑定 launch_claim revision/launch_receipt，并强制 `confirmedAbsentAt >= receipt.launched_at` 且 revision 未变，但当前 packet 必须新增这些字段和谓词。增加 exact barrier：旧 absent packet 后 adapter 完成 launch，随后 T4/T6/T7 获取锁，三者都必须拒绝 terminal。

2. **[高] `CAS→launched` 后、exec 前崩溃的恢复路径写成“T6 terminal 后走 T7”，但这在当前三层状态机中不可执行。** §2.2b 说 probe absent → 收割 terminal → T7 新 activation（`plan.md:174-181`）；然而 T6 会 finalize attempt、把 task running→ready 并 tombstone claim（`:454-457`），T7 又要求对旧 active activation/claim 做 terminal/tombstone CAS（`:459-470`）。T6 完成后旧 activation、attempt、claim 均已终态，T7 无可 resume 的 active suite。**修正**：二选一并钉死唯一恢复路径：最简单的是 T6 正常收割 terminal 后由 T2 为 ready task 建立下一 attempt；若必须保留同一 attempt，则需新增独立的 launch-abandoned cutover，只 terminal 旧 activation、不 terminal attempt/task，再由 T7 原子换 activation。不要让 T7 作用于 terminal attempt。把 receipt-after-CAS crash 测试明确断言 expected attempt generation/activation generation。

3. **[中] T2、T7 和 Ports 表仍保留 Round 5 以前的 adapter/锁合同，与 §2.2b 的新权威文字冲突。** T2 仍写 adapter 只验证 `{token+claimed+lease+activation active}` 后 exec，没有 `claimed→launched + receipt` CAS（`plan.md:336-341`）；T7 同样只写“锁内验 token”后 attach（`:471-473`）。Ports 中 SpawnPort 仍是“exec 前重读”，LaunchLockPort 仍称仅“spawn adapter 与收割共用”（`:484-487`），遗漏 claim-confirm、takeover、T3/T4/T7。**修正**：把 T2/T7 改为调用同一个 `launchOnce`/`consumeLaunchClaimTx` 映射，逐步写明锁内 revalidate→CAS launched/receipt→commit→exec；Ports 表同步列出全部参与者和一次性消费责任。T4/T6/T7 各节也应明确“外层取锁、锁内 fresh probe、再 kernel.write”，避免实现者只按模块事务章节落旧行为。增加静态/调用图测试，确保 T2 与 T7 只有一个 one-shot launch adapter 入口。

## Verdict

CHANGES REQUESTED — address items above
