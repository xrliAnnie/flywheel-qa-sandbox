# Design Review — plan.md (Round 2)

Date: 2026-09-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

v1.2 已实质修复 Round 1 的 ledger 不可读折叠、authority cause 字段遗漏和 consumer/importer 清单问题，整体实现方向仍然可行。但 lock 的 `stale` 只证明持锁的 Bridge 进程已死，不能证明该 Bridge 已经 `detached:true` spawn 出来的 daemon 子进程已死；源码中存在一条可让该行随后变成 `failed` 并被 generic 误判为 dead 的完整竞态。因此死亡证明仍未闭合，本轮继续请求修改。

## What's Good (Keep)

- 四态 ledger 把 `missing` / `no_group` 与 `unreadable` 分开，修正了 Round 1 最核心的“不可读等于未记录”错误；`live` / `unreadable` lock 保持 fail-closed 也是正确方向。
- 新状态门仍限定于 `failed|blocked`，旧三值注入口被保守映射为 `valid_group + unreadable lock`，不会因兼容口缺字段而放行。
- socket 的 EACCES、超时和其它模糊结果继续按 live 处理；generic 仍要求 target、tmux discovery、host process 三重缺席。
- authority cause 现在同时覆盖 `transition.prerequisite` 与真实的 post-transition `teardown.reason`，且 T-CC-3b 对应 `lifecycle-closeout.ts:1373-1385` 的生产形状；Round 1 MEDIUM 已闭合。
- importer 清单已补齐 `plugin.ts` / `post-ship-finalization.ts`，并正确说明普通 `validateRunQuiescenceEvidenceTx` 已 neutralized、只有 needs-lead rework validator 仍做线性化重查；Round 1 LOW 的安全边界陈述已修正。
- `closeRunner` preserve gate、cause fallback、无 schema/env/flag 以及手工 resume 的上线边界均保持窄范围。

## Issues & Recommendations

1. **HIGH — `spawnLock:"stale"` 不是 daemon absence proof，仍存在“活 daemon + failed 行 ⇒ generic dead”的完整竞态。** lock 文件写入的是 `process.pid`（Bridge PID，`codex-daemon-runtime.ts:1257-1265`），daemon 则通过 `detached:true` 启动并明确可在 Bridge 死后继续运行（`:992-1008`）。时间线是：已有 `running` 行和 pre-spawn `session.json`（`no_group`）→ Bridge 取得 lock → `spawn()` 返回 detached child（`:754-784`）→ Bridge 在同步 `onSpawnIdentity` 写 pgid 之前（`:945-958`）崩溃。此时 lock 为 `stale`，但 child 仍可活着且尚未 bind socket，或卡在 bind 前；失去父进程后也没有 30 秒 startup timeout 来杀它。重启后的 heartbeat 使用 tmux/CommDB 视角而非 Codex daemon ownership；无 target 会得到 `gone` 并交给 orphan aging，后者可执行 `running → failed`（`HeartbeatService.ts:895-943, 2043-2113`）。随后 v1.2 得到 `{ledger:"no_group", socketLive:false, spawnLock:"stale", status:"failed"}` 并放行 generic；但 daemon argv 只有 `--listen unix://<hashed socket>`，没有 executionId（`codex-daemon-runtime.ts:754-770`），所以 generic 的 `pgrep -f executionId` 可 clean-miss，最终制造假的 execution death proof并允许 CommDB finalize/worktree cleanup。建议最小范围先将 `stale` 保持 `unknown`，且针对本单两个“无 state dir、无 lock”的目标只放行 `ledger:"missing" + lock:"absent"`。若确实要覆盖 `no_group` / `stale`，必须增加独立的 exact-socket argv 进程轴（可复用 `codex-runner-orphan-reaper.ts` 已有的 app-server command/socket 解析思路）：只有进程枚举成功且确认没有引用该精确 socket 的 app-server 才可继续，枚举错误必须 `unknown`；并在 generic 返回 dead 后做最终复核。将当前 T-RQ-3 的 stale-lock 期望改为 fail-closed，增加上述 pre-persist parent-crash 时间线的回归测试。

2. **MEDIUM — 四态解析的伪代码仍有两处把“格式非法”错误归为可放行状态。** Ledger 使用 `candidate = raw.daemonPgid ?? raw.daemonPid` 后以 `candidate === undefined` 判 `no_group`；因此 `{daemonPgid:null}` 且无 legacy 字段会被归为 `no_group`，与“字段存在但非法 ⇒ unreadable”的文字合同冲突。Lock 路径沿用 `readLockHolderPid` 的 `typeof pid === "number"` 形状，没有要求 safe integer 且 `>1`；例如本机 Node 对 `process.kill(1.5, 0)` 抛 `ERR_INVALID_ARG_TYPE`，当前 `defaultIsPidAlive` 会将其折成 false，于是恶意/损坏的 `{pid:1.5}` 会被标成 `stale` 并进入零证据组合。建议使用 `Object.hasOwn` 区分 absent 与 present-null，明确 daemonPgid 优先及 legacy fallback 规则；lock pid 只接受 `Number.isSafeInteger(pid) && pid > 1`，非法值和 `isPidAlive` 抛错均为 `unreadable`。补充 null、boolean、0、负数、fractional pid 和 throwing liveness seam 测试。Ledger reader 也应像 lock reader一样使用 `O_NONBLOCK`、`fstat` regular-file/大小上限和 `finally close`，否则 FIFO/超大文件仍可阻塞或耗尽 Bridge。

3. **MEDIUM — “旧三值 probe 行为逐字不变”与所列实现并不成立，且 evidence 会拼接两次 ledger 读取。** v1.2 把 `probeCodexDaemonLiveness` 改为调用新 evidence，这会为 `plugin.ts:8187` 等旧消费者新增 lock 打开、解析和 PID 探测；任何未被内部折成 `unreadable` 的异常都会把原来的三值结果变成 rejection。新的 `O_NOFOLLOW` ledger 读取也会把旧实现可跟随的 valid `session.json` symlink 从有效 pgid 改为 undefined，因此“任意输入 byte-identical”并非 `valid_group ? pgid : undefined` 投影即可保证。另 `probeCodexDaemonEvidence` 先让 `inspectCodexDaemonOwnership` 读一次 ledger，再在 await 后重读一次来填 `ledger`，返回的 `liveness` 与 `ledger` 可能来自不同 inode/时刻。建议让一次内部 detailed inspection 返回同一次读取的 ledger state、pgid、socket/group 结果；新 evidence 在其上增加 lock/process 轴。旧 `probeCodexDaemonLiveness` 最稳妥地继续直接投影该 inspection 的 `liveness`，不触发只供 FLY-2490 使用的额外探针；若决定接受 symlink/FIFO 等 fail-closed 行为变化，则应明确列为有意变更并覆盖旧 recovery consumer，而不要声称 byte-identical。

4. **LOW — 两份设计文档和 progress ledger 仍有少量漂移。** `research.md §5` 仍只列 `transition.prerequisite`，没有 v1.2 已接受的 `teardown.reason` authority 形状；plan c3 仍写“真值表六行”，c4/c5 的完成判据也没有列出新增的 T-LC-2b / T-CC-3b。建议在下一版同步，以免实现节点按 research 或 chunk ledger 漏项。

## Verdict

CHANGES REQUESTED — address items above
