# Design Review — FLY-1730 plan.md (Round 2)

Date: 2026-08-12
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的五项问题都已被实质性吸收：checker 先行、managed updater、延后 closeout、JIT version 和寄生进程 fail-closed census 均已形成可执行路径。剩余问题集中在两阶段部署的“本次波次”绑定、回滚后仍需保持的 founder-channel 硬不变量，以及恢复 checker 的直接测试与跨项目窗口锁；修正这些窄点后，整体设计无需再改架构。

## What's Good (Keep)

- B1 正确识别并修复了生产 blocker：pointer 与 legacy checker 都改为保留 `allowBots`、`[reply-guard]` 两个必选标志，并接受 `ChatReceiptRuntime | ChatIngestRuntime`，没有在新插件中伪造旧 sentinel。
- Phase A 先部署兼容 checker、显式运行 `install-discord-plugin-ops.sh` 收敛 live bin，再进入 fork merge；这与当前 installer 不会自动运行的事实一致，也使 0.0.4 过渡保持惰性。
- Phase B 已完全移除裸 `claude plugin update` 和 uninstall/install fallback，复用现有全机锁、锁内复检、CLI 单写者及 restart wave，方向正确。
- 完成门现在同时检查 registry scope/version/SHA、cache 内容、restart status 和真实进程路径；入队或单个命令成功不再冒充部署完成。
- FLY-1645 retired flag 直到 QA 全过且 rollback 窗关闭前都保持 `=1`，消除了“回旧插件但 flag 已删”的组合事故。
- JIT patch+1、#21 先落后的 rebase/retest/re-review，以及从 merged manifest 读取版本，正确闭合了 marketplace 版本语义。
- 旧进程不再被假定会随 Lead wave 自然消失；无法归属的 adapter 会 fail-closed，归档保留 state-dir 与 root/settle/meta 层级并严格排除 `ingest/`。

## Issues & Recommendations

1. **HIGH — Phase B 的 restart receipt 仍未绑定到 Phase B 这一次波次，Phase A 的旧终态可以满足当前文字判据。** Phase A 和 Phase B 冻结的是同一个主仓 main SHA；两次标准 updater 波的 status 都会是 `reason=updater`。现有 `leads-restart-status.json` 只有 `codeDeployedSha/status/failed/skipped/reason/recordedAt`，没有 request/attempt ID（`scripts/restart-services.sh:210-230`）；完成播报也只携 reason 和 SHA（`:2158-2174`）。因此 `plan.md:79-84` 若只要求“reason=updater 播报到达 + codeDeployedSha 等于冻结 SHA”，可以重用 Phase A 的 healthy status/broadcast，而不能证明插件更新后的 Phase B wave 真跑过。波后进程 census 能证明当前活 adapter 字节，但不能把 status 中的全舰 restart 结论绑定到这一次部署。**建议：**Phase B 入队前冻结一个 `phase_b_started_at`（以及 request marker 名/nonce，如可读），要求 status 的 `reason == updater` 且 `recordedAt > phase_b_started_at`，并记录一条时间/消息 ID 同样晚于该边界的 completion broadcast；再要求这些时间早于或覆盖波后 census。可直接使用既有字段，不需新 schema/机制。

2. **HIGH — 一级“revert faulty delta”会重新打开本单明令禁止的 founder-channel advisory 通路。** PR #20 本身仍保留 `AdviseFn`、`adviseWithMarker` 和 server.ts 的 `channel.send('⚠️ …')` 四类 ingest plumbing advisory；D1/D2 正是把它们删掉。`plan.md:105-107` 的一级回滚若回退整个 delta commit，就会恢复该通路，违反 `plan.md:15,35` 的硬不变量，即便 settle 机器仍保持删除。**建议：**把 Tier 1 改成“修复性 roll-forward”，允许撤销有问题的日志/latch 实现，但必须保留结构门：无 `AdviseFn`/advise option、无 plumbing `channel.send`、server runtime options 无 advise、对应负测继续绿。只有已单列且需 founder 拍板的 Tier 2 才可以有意识地回到 0.0.4/事故态；不要把 PR #20 原样部署写成普通一级回滚。

3. **MEDIUM — B1 点名了两个 checker，但当前测试文件并不直接执行 legacy checker，计划需要把这条覆盖写死。** 现有 `discord-plugin-ops.test.sh` 只执行 pointer `CHECKER`；`LEGACY_CHECKER` 仅做“文件存在”和 installer 后 `cmp`（`:129-135`, `:288-305`）。`discord-plugin-cutover.test.sh` 使用的是生成的 fake checker，`:324` 的 server fixture 不会运行 canonical legacy checker。因此仅把这些 fixture 字符串换成 `ChatIngestRuntime` 仍可能让 `check-discord-plugin-legacy-overlay.sh:31-34` 的 OR 逻辑写坏而测试全绿。**建议：**在 ops suite 中新增直接调用 canonical legacy checker 的 hermetic fixture，构造 registry、dedicated recovery clone、cache 与 marketplace 两个 target，并对旧 marker、新 marker、两个 runtime marker 都缺失三态逐一断言；pointer checker保持同样三态。cutover suite 只承担 installed-byte/编排覆盖即可，不要把 fake checker 当 B1 行为证据。

4. **MEDIUM — 两阶段窗口还缺一个在 Phase A 之前建立、持续到 Phase C 的显式排序 hold。** `plan.md:88-89` 只在最后通知 FLY-1676 重新盘点；若 FLY-1676 cutover 在 Phase A 与 Phase B 之间启动，它会冻结其他 deploy、改变 checker/updater/cutover authority，并使本计划冻结的 patch 数和 runbook 前提失效。FLY-1645 closeout 同样不能只靠最后“解锁”反推出之前已经被所有 owner 看见的禁令。**建议：**在 Phase A 第一步前由 Tadashi 明确登记：FLY-1676 PR #19/cutover 与 FLY-1645 retired-flag removal 均 HOLD；该 hold 覆盖 A→B→QA 全窗，只在 Phase C 按现有条件释放。继续允许 #21 先落，但按既定 rebase/version/re-review 路径处理。

## Verdict

CHANGES REQUESTED — address items above
