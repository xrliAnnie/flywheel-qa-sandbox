# Design Review — plan.md (Round 3)

Date: 2026-09-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

v1.3 已正确修复 Round 2 的核心反例：生产适配器在 spawn 前同步写入 launch snapshot，因此 parent-crash / failed-cleanup 形状至少会留下 `no_group`，而 `no_group` 与 `stale` 现在都 fail-closed。剩余阻塞点是 `missing + absent + socket dead` 仍只是“当前文件坐标、当前时刻无证据”，不是 execution-wide、mutation-fenced 的死亡证明；源码中仍有活 daemon 或即将出生的 daemon 与该组合共存的可达路径。

## What's Good (Keep)

- `missing / no_group / valid_group / unreadable` 四态 ledger、`Object.hasOwn` 优先级、safe-integer PID 校验及 `O_NOFOLLOW | O_NONBLOCK`/regular-file/大小上限，把 Round 1/2 的解析与阻塞风险闭合得很完整。
- 将 `stale` lock 和 `no_group` 明确留在 `unknown` 是正确修正。`executeOwned` 的首次 dispatch 在 runtime 构造前调用 `persistLaunchSnapshot`（`CodexTmuxAdapter.ts:1088-1113`），recovery 又必须先从同一 snapshot 恢复，所以“spawn 后 Bridge 死在 pgid persist 前”的真实形状确实不是 `missing`。
- `inspectCodexDaemonOwnership` 单次读取 ledger、旧三值 probe 只投影 `liveness` 且不碰 lock，消除了 v1.2 的双读与旧 consumer 扩面；对异常文件形状的有意 fail-closed 变化也已如实声明。
- generic 返回 `dead` 后重读 daemon evidence 能封住探测期间出现 ledger/socket/lock 的变化；虽然它不是完整 mutation fence，但应保留为必要的末端 veto。
- authority cause 已同时覆盖 `transition.prerequisite` 和 `teardown.reason`，错误串优先于 authority、authority 优先于 `nodes_not_confirmed_gone` 的顺序与 ClosureReport 真实形状一致。
- importer/caller sweep、`closeRunner` 的 FLY-116 preserve 门、FLY-1940 的 valid-group fail-closed 行为及无 schema/env/flag 的范围约束均保持清楚。

## Issues & Recommendations

1. **HIGH — `missing + absent + socket dead` 仍不能证明该 execution 没有活 daemon，且终复核没有阻止之后的 spawn。** 三个轴都由“当前 Bridge 的当前路径”解析：session root 和 socket root 完全来自当前 `process.env`/HOME（`codex-daemon-runtime.ts:60-95`）。旧 Bridge 在 root A spawn detached daemon 后崩溃、重启 Bridge 使用 root B 时，B 下自然得到 `missing + absent + socket dead`，但 A 下 daemon 可继续存活；generic 只做 `pgrep -f executionId`，而真实 daemon argv 只有 hashed socket path、没有 executionId（`:754-770`; `generalized-launch-recovery.ts:25-37`），因此会 clean-miss。即使 root 不漂移，daemon 的 workspace-write roots 明确包含整个 `~/.flywheel`（`codex-daemon-adapter-helpers.ts:30-45`; `CodexTmuxAdapter.ts:1035-1041`），同 UID 的 model-driven shell 可 unlink 自己的 `session.json`、lock 和 Unix socket pathname，而 app-server 进程及已有连接仍可存活；代码其它位置已经把 “tampered session.json” 当作现实威胁（`codex-daemon-runtime.ts:679-682`）。另一个独立 TOCTOU 是：首次 dispatch 在 `persistLaunchSnapshot` 前确实短暂为 missing，`startSession()` 在 `beforeCodexDaemonStart` 后直接进入 spawn，并不重新核对 StateStore status/closeout fence（`codex-daemon-goal-runtime.ts:317-357`）；若行被并发置为 failed/blocked，第二次 evidence 读完后仍可继续写 snapshot、拿锁并 spawn。现有 `claimInFlight` 只 veto “open claim 且无 worktree binding”的节点（`lifecycle-closeout.ts:179-191`），不能作为全体 6 个调用者的 spawn fence。建议本单采用最小、安全范围：把放行条件再限定为 StateStore 中可证明发生在 `adapter.execute()` 之前的失败类别，例如当前两个目标共有的 `last_error/failureKind === worktree_takeover_failed`（该返回位于 `Blueprint.ts:1470-1480`，早于 `adapter.execute()` 的 `:3105`），并增加“其它 failed/blocked + 三轴缺席仍 unknown”的守卫；同时拒绝任何尚未关闭/取消的 launch claim。若仍要覆盖任意 failed/blocked，则必须补 durable root provenance、exact-socket/app-server process census（枚举失败为 unknown）以及能阻止终复核后出生的 mutation-time launch fence，单次末端重读不够。测试至少加入 root A daemon/root B probe、终复核后继续的 delayed pre-snapshot launch，以及当前-root evidence 被 unlink 但 app-server PID 仍活的反例。

2. **MEDIUM — §2.2.3 的 lock-release 不变量仍比实现更强，不能作为 `absent` 的独立证明。** `ensureDead()` 在 socket 不再接受连接后就 unlink + release，并不等待 child/process group 退出（`codex-daemon-runtime.ts:871-902`）；failed-spawn cleanup 也只要求 spawned leader reaped 加 socket dead（`:915-936`）。而 `killTree` 的 audited group signal 失败时会退回只 signal leader（`:812-858`），所以“lock 只在 daemon 被证明已死后释放”并非源码实际合同：一个不再监听但仍活/挂在 shutdown 的进程，或脱离/幸存的 descendant，都可与 absent lock 共存。v1.3 在稳定、未被删除的 pre-spawn ledger 下仍会靠 `valid_group/no_group` veto 这些形状，所以这不恢复 Round 2 的旧反例；但计划应把安全论证改成“生产 spawn 前必有非-missing ledger，absent lock 仅是辅助条件”，并补一条组合回归：group kill 未生效、leader 已退出、socket dead、lock 被释放时，`no_group` 仍必须让 run-quiescence 返回 `unknown`。

3. **LOW — v1.3 仍有几处文档陈述与已接受设计漂移。** `research.md:44` 仍用 `onSpawnIdentity` 论证“session.json 不存在”的安全性并声称只剩 spawn→pgid 窗口；真正区分 `missing` 的承重事实是 spawn 前的 launch-snapshot 写，pgid 窗口对应的是 `no_group`。plan §8 仍说该窗口“只在 running/pending 出现”，与 Round 2 已确认的 parent-crash 后 heartbeat 可转 failed 的时间线冲突；§3.2 又写三值 probe 对“任意输入”不变，而 §2.2.1/§3.3e 已承认 symlink/FIFO/oversize 的有意变化。`research.md:15,64` 的 cause 摘要也还漏 `teardown.reason`。建议同步这些文字，避免实现或后续审计引用已经被本轮设计否定的理由。

## Verdict

CHANGES REQUESTED — address items above
