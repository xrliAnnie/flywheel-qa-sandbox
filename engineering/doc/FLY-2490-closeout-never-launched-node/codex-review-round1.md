# Design Review — plan.md (Round 1)

Date: 2026-09-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案总体方向正确，改动点集中、与现有 preserve gate 和三值 fail-closed 策略兼容，调用点与回滚面也基本清楚。但当前对“零 daemon 证据”的表示会把不可读或损坏的 ownership ledger 当成“从未记录”，并遗漏 spawn lock 这一并发证据；cause 推导也漏掉了 transition 完成后 authority 丢失的真实报告形状。前者会破坏 FLY-1940 / FLY-2313 的死亡证明纪律，因此本轮不能批准实施。

## What's Good (Keep)

- 修点放在 `probeRunExecutionLiveness`，没有放宽 `closeRunner` 的 FLY-116 crash-preserve 门；这是正确的责任边界。
- `close-runner-states.ts` 作为叶子模块并由 `close-runner.ts` re-export，能消除反向 import 环，同时保持现有公开名称和对象身份。
- Codex 分支的状态门、旧 `probeCodexDaemon` 注入口的 fail-closed 兼容，以及 `probeCodexDaemonLiveness` 返回值 parity 都设计得很窄；六类生产调用路径均能传到完整 session/status。
- generic 探针仍要求 target、tmux discovery、host process 三重缺席，socket 探针对 EACCES、超时等模糊结果仍按 live 处理；这些负向守卫应保留。
- `conflict` 回落 `lifecycle_conflict`、普通 `blocked` 无证据时回落 `unknown`，比当前一律标记 `lifecycle_conflict` 更诚实；无 schema/env/flag 改动，回滚边界清晰。
- 测试分块和先红后绿顺序合理，特别是默认生产探针的 lifecycle 集成用例与旧注入口守卫。

## Issues & Recommendations

1. **HIGH — `persistedGroup: false` 不能证明“零 daemon 证据”，会把不确定 ownership 降级为可判死。** `readPersistedDaemonPgid` 在 `codex-daemon-runtime.ts:119-140` 对 ENOENT、权限错误、损坏 JSON、非法对象、非法 pgid 和字段缺失全部返回同一个 `undefined`；计划中的 `persistedGroup: inspected.pgid !== undefined` 因而无法区分“确实没有记录”与“记录无法可信读取”。现有逻辑在“有效 pgid + socket dead + group alive/unknown”时刻意返回 `unknown`，但同一运行体只要 ledger 损坏，计划就会把它视为 `{unknown,false,false}`，在 failed/blocked 状态下交给 generic 探针；而 generic 的 `pgrep -f executionId` 并不能证明不带 execution id argv 的 detached Codex daemon 已死。lifecycle 路径随后可设置 `executionDeathProven`、finalize CommDB，并允许 post-ship 删除 worktree，直接违反 FLY-1940 / FLY-2313 的 fail-closed 约束。另有 `<socket>.lock` 在 spawn 前获取，并在 cleanup 无法证明 daemon 已死时被故意保留（`codex-daemon-runtime.ts:647-665, 906-940`）；计划完全不读取它，也没有证明 failed/blocked 状态绝不可能与 pre-persist spawn 或保留锁并存。建议把 ledger 读取改成显式状态，例如 `missing | readable_without_group | valid_group | unreadable_or_invalid`，只有可明确证明的 missing/readable-without-group 才能进入新分支；不可读/非法必须保持 `unknown`。同时将 live/unreadable spawn lock 作为 veto，或在计划中给出覆盖所有状态写入和 Bridge crash/restart 的不变量证明。补充损坏 JSON、非法 pgid、注入式 read error、live/unreadable lock，以及无 socket 但组仍 alive/unknown 的负向测试；`probeCodexDaemonLiveness` 的既有三值行为仍须保持不变。

2. **MEDIUM — authority cause 的优先级规则漏掉了真实的 `teardown.reason` 路径。** `closeoutOneNode` 在 transition 后重新检查 authority；若此时 issue reopened/unknown，它返回 `teardown: { state: "skipped", reason: "authority_reopened" | "authority_unknown" }`（`lifecycle-closeout.ts:1373-1385`），而 transition 可能已经是 `done` 或 `skipped`，并不是计划检查的 `transition.state === "blocked"`。此报告同时保持 `confirmedGone:false` / `communicationsFinalized:false`，所以计划会错误推导为 `nodes_not_confirmed_gone`，与 §3.7“真正 authority 阻塞仍为 lifecycle_conflict”冲突。建议在 `CloseoutCauseReportShape` 加 `teardown.reason?`，authority 优先级同时匹配 `transition.prerequisite` 与 `teardown.reason` 的 `authority_` 前缀；新增用例：transition `done`（或 `skipped`）+ teardown `skipped/authority_reopened` + 两个 false 布尔，期望 `lifecycle_conflict`。

3. **LOW — consumer/importer sweep 有两处与当前源码不符，需修正文档以准确界定 blast radius。** 状态集的真实生产 importer 还包括 `plugin.ts` 的 `CLOSE_ELIGIBLE_STATES` 和 `post-ship-finalization.ts` 的 `FINALIZE_DONE_SOURCE_STATES`；`terminal-tab-reaper.ts` 是本地副本而非 importer。另 `run-quiescence.ts` 注释及 research §2 称 StateStore 会在线性化点重查所有 run evidence，但 `validateRunQuiescenceEvidenceTx` 已按 founder directive 完全 neutralized，只有 `validateNeedsLeadReworkQuiescenceTx` 仍检查 status、lifecycle revision、freshness 和 dead。re-export 本身仍可行，且这两处不单独阻塞实现；建议更新 importer 清单和各 consumer 的实际约束说明，避免把不存在的 recheck 当成安全栅栏。

## Verdict

CHANGES REQUESTED — address items above
