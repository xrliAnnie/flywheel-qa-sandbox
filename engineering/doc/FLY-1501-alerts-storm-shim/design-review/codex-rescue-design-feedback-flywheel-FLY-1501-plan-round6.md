# Design Review — plan.md (FLY-1501) (Round 6)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 6 已补齐 invalid-spool 的可达终态、诊断事件幂等键和五个子命令的完整退出码；此前确定的全历史投影幂等与显式 `ledgerRoot` 合同也保持完整。当前仍有一个高风险工程落点错误：root-only quarantine 没有与 canonical spool 的 child writer 共锁，存在把刚替换出的合法 spool 移走且永久失去 kernel 投影的 TOCTOU；此外 research 的旧协议仍与 plan 的最终合同冲突。

## What's Good (Keep)

- pre-validation 失败先写确定性 `restart_spool_invalid` 事件、且始终产生零 obligation，再由 helper 收敛到 quarantine；这补上了 Round 5 指出的永久 live 重扫缺口。
- `event_uid=restorm-invalid:<basename>`、`INSERT OR IGNORE` 和 A12 的重放断言给出了明确的诊断幂等边界。
- gate/resume/status/mark-applied/quarantine 五个子命令的正常、锁竞争、损坏和用法错误退出码已穷举；非绝对 root、缺参和未知参数统一 fail closed。
- `reconcileRestartStormSpool(kernel, {ledgerRoot, gateHelperPath})`、`restorm:<episode_key>` 全历史主键、commit 后 helper move 以及 resolved/tombstoned 后不 reopen 的合同均保持清晰。
- `research.md §2.5` 已同步到确定性 obligation id、事务前校验、显式 root 和 helper-mediated mark-applied 的最终投影流程。

## Issues & Recommendations

1. **[HIGH] `quarantine` 的 root-only 锁没有与 canonical spool writer 线性化，违反 same-child-lock 合同并可丢失有效投影。** plan.md:41 规定所有 pre-validation failure（包括 invalid JSON 和 filename↔payload mismatch）都由只持 `_quarantine.lock` 的 helper 按 basename rename；但 plan.md:50、plan.md:52-53 和权威设计 `design-FINAL-v2.md:58` 要求 spool 写者/工具在同一 `<child_key>.lock` 下串行。TS 的预校验与随后启动 helper 之间存在窗口：reconciler 先读到坏的 canonical 文件；gate 随后在 child lock 下隔离坏文件并发布同 basename 的合法文件、完成 Discord durable receipt 并把 state 推到 attempted；root-lock-only helper 再按 basename rename，便会把这份新合法文件移入 quarantine。因为 attempted 分支不再 ensure-spool，这个 episode 可能永远没有 kernel obligation。建议把 quarantine 分成明确的两类：能从 canonical basename 安全恢复 child/episode 的文件必须取得同一 `<child_key>.lock`，并在锁内重新读取、重新验证（最好传入/核对预校验时的内容 digest，至少确认当前文件仍 invalid）后才移动；只有确实不能映射为任何合法 gate 目标的 basename 才使用 root `_quarantine.lock`。另一种可行做法是让所有 spool namespace writer 都取得一个固定顺序的 root 外层锁，但不能只让 quarantine 单方面取它。A12 还需加入真实双进程交错：TS 判坏后暂停，gate 在 child lock 下用同 basename 换入合法文件并推进 attempted，再恢复 helper；断言 helper 不隔离新文件、最终 obligation 恰一且文件进入 applied。

2. **[MEDIUM] `research.md` 的同步仍是局部的，而 plan 又把其中旧段落当作逐条实现依据。** plan.md:49 明确要求工件格式和启动分支按 research §2.2/§2.3 逐条实现，但 research.md:155 仍写 `ensure-spool(O_EXCL)`，与 plan.md:52 已冻结的“同目录 tmp+fsync 后 no-clobber link”协议冲突；research.md:172 又写“两腿都 best-effort”，与 plan.md:55 的 Discord durable-receipt 状态机冲突。research.md:117-123 仍只列四个子命令，工件树也没有 quarantine，虽然标注了 plan 优先，但会给 implementer 留下两套可选合同。建议将 research §2.1-§2.4 同步到五子命令、五个 supervised entry、quarantine 目录/锁选择、link 发布和最终 alert-leg mapping；若需保留演进史，则把旧内容移到明确的历史附录，并删掉 plan 中“§2.2/§2.3 逐条”的规范性引用。

## Verdict

CHANGES REQUESTED — address items above
