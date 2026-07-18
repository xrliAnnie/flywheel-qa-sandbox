# Design Review — FLY-1336 plan.md (Round 1)

Date: 2026-07-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确：保持 rescue fail-closed、把 timeout 与真实 hold 分开、修正 committed launch 的假失败，以及收口 pre-launch inflight，均符合 Lead 批准边界。但当前计划的三个核心合同尚未闭合：75s attempt cap 并不覆盖 F=4 下的合法内层路径；202 pending 会被现有 retry route/gateway 误判；RunDispatcher 的无条件外层 catch 会改变 LifecycleParkedError 的既有语义，因此尚不能实施。

## What's Good (Keep)

- Non-goals 写得清楚：案 2、锁机制、连续自适应及 FLY-1329 均不应进入本单。
- rescue 仍以 `scanComplete=false → unknown → no create` fail-closed，且 saturated/split_brain/ambiguous 的判定和 exit code 不放松；这是正确的安全边界。
- load factor 采用一次采样、上限 clamp、探测失败回退 1×，并要求 macOS/Linux 真实格式 fixture，整体工程取向合理。
- 放弃 inspect 内部二次重跑，避免再叠一层不可控 worst-case，是正确收敛。
- 对 generalized launch 做 timeout 后终查，并使用新的 pending code 而不是复用已被证伪的 `GENERALIZED_LAUNCH_NOT_COMMITTED`，语义方向正确。
- 测试矩阵覆盖 hermetic、real-tmux、TS 调用层、Bridge 及真机满载回放；保留这些层次。

## Issues & Recommendations

1. **[BLOCKER] §3.2 的 75s / 180s 预算数学不成立，未满足批准合同“outer cap ≥ inner legitimate worst case”。** 计划用“每条约 5s”的典型耗时计算成功路径（plan.md:75-83），但 F=4 时实际合法 ceiling 是 inspect 24s、command 20s、lock 20s。当前 reachable→verify→re-inspect 路径见 `tmux-server-rescue.sh:286-303`；即使没有任何额外 lsof 候选（N=0），合法上界也是 `20 + 2 × (2 × 24) + 20 = 136s`，已超过 75s；N=2 时是 232s。N 在源码中也没有 ≤2 的上界（`:168-179`），而 orphan recovery 还有 signal 前重验和最多 20 次 inspect（`:455-484`）。因此 75s 仍会 SIGKILL 合法慢成功，180s 只是重复两次同样的截断；且外层 Node kill 是否能杀掉 lock wrapper 的后代进程并未证明，不能把它直接称为“有界 fail-closed”。建议先定义一个真正有限的内层总预算：优先让 rescue 自身持有 wall-clock deadline、每条 bounded exec 使用 remaining budget，并在总预算耗尽时输出结构化 hold；然后令 attempt cap 覆盖该总预算与进程启动余量，deadline 再覆盖至少两次完整 attempt + retry delay。若不做内层总预算，则必须对候选数和 recovery 路径给出明确 fail-closed 上界，再据此重新推导数字。测试要锁定 F=4 下 N=0、N=2、单点 timeout、orphan recovery 的总墙钟，而不是只测“通常 5s”。

2. **[HIGH] Bash 3.2 与现有 env 覆盖合同尚未设计完整。** `load×100` 若直接进入 Bash 算术，`08`/`09` 会被当八进制；本机 `/bin/bash 3.2` 对 `08` 报 `value too great for base`，需要显式十进制处理（如 `10#`）和严格的定点解析。同时计划声称保留三个 timeout env 的覆盖语义（plan.md:53-57），但现有 hermetic 测试真实使用 `FLYWHEEL_TMUX_RESCUE_COMMAND_TIMEOUT_SEC=0.2`（`tmux-server-rescue.test.sh:363-378`）；`0.2 × factor` 不能用 Bash 整数算术。请在计划中明确：load/cores/MAX/factor 的输入语法及 invalid fallback；MAX 必须先验证为正整数再 clamp；effective timeout 要用 Bash-3.2-compatible 的定点实现并保留正小数 timeout，或明确迁移合同并修改现有测试（后者不符合“env 语义保留”）。增加 `08`、`09`、`0.2`、空值、负数、超大值和 invalid MAX 的 hermetic 用例。

3. **[HIGH] `timedOut` 目前无法按计划从所有 inspect 子命令准确传播。** `tmux display-message` 的 rc 在 `tmux_socket_inspect` 可见（`tmux-server-rescue.sh:156-162`），但 `_tmux_rescue_server_pids` 把 ps 的任何非零都折叠成 1（`:122-130`），`_tmux_rescue_pid_has_socket` 又把 lsof timeout 与其它不完整证据都折叠成 2（`:95-107`）。因此 plan.md:59-61 的“任一命令 rc=124/125 → timedOut=true”按现有 helper API 无法实现；用 subshell/global flag 也不能可靠回传。请为 ps/lsof helper 保留独立 timeout 状态（专用 return code 或结构化结果），让 caller 同时设置 `scanComplete=false` 与 `timedOut=true`。分别对 tmux、ps、lsof timeout 写突变测试，并继续断言 saturated/split_brain/ambiguous 的 action/reason 不变。

4. **[BLOCKER] 202 pending 不是端到端合同；当前实现会把“已 dispatch”重新解释成“未 dispatch”。** 精确 grep 未发现仓内消费者匹配被删的两个 code 字符串，但响应 status/body 的结构消费者会出问题：`actions.ts:1735-1760` 将任何 `success:false` 变成 HTTP 400；即使改成计划中的 202，Codex gateway 仍把任意 2xx + `success:false` 映射成 `not_dispatched`（`gateway-main.ts:230-250,460-482`），从而允许 recovery re-drive。更严重的是 actions 的 delivery wait 位于 lineage/WAL bookkeeping 之前（`actions.ts:1165-1188`）；pending 早退会漏掉 `setRetrySuccessor` 与 `markRetryDispatchDispatched`，而 marker reconciler 不会替它补这两项。另一方面 Gemini BridgeClient 和小红书 scheduler 都只看 `res.ok`（`bridge-client.ts:80-100`、`scripts/xiaohongshu-scheduler.ts:226-244`），会把同一个 `{success:false,pending:true}` 当成功，形成互相矛盾的解释。请在计划中定死一个 accepted-pending schema（优先考虑 `202 + success:true + pending:true`，或让所有消费者显式识别 pending），并逐点列出：ActionResult 类型、actions route 的 202 保真映射、gateway 的 accepted/no-redrive 映射、Lead/Gemini/scheduler 行为。actions 必须在返回 pending 前先完成 successor lineage 与 gateway WAL 的 post-dispatch bookkeeping。测试必须穿过真实 HTTP route 和 `mapHttpDispatchOutcome`，断言 pending 后不重派且 lineage/WAL 已落地。

5. **[HIGH] “所有 waitForSession timeout 都改 202 且最终必收敛”超出案 4 的已证事实，也没有现成收敛保证。** 非 generalized 的 `runs-route.ts:1306` 路径没有 generalized launch owner/fence；Blueprint 若在 emitStarted 前真实失败，返回 `START_PENDING` 后可能永远没有 session event，无法满足 plan.md:163-164 的“202 出现时最终 session 必收敛”。同时 workflow engine 当前的 `return false` 并不等于立即重派：下一次 reconcile 先查 session，launch busy/hold 会继续 hold，committed 但 liveness unknown 也不 repair，只有 positive dead evidence 才 claim delivery repair（`workflow-engine-dispatcher.ts:111-130,305-336,484-490`）。建议按 narrow boundary 收缩：只改变有 durable generalized execution/launch evidence 的 case-4 路径；classic `START_NOT_LIVE` 若要异步化，需要另行定义 durable status/reconcile 合同，不应靠文案“do not retry”承诺。对 workflow engine 以终查 + 现有 fence 行为的回归测试为主，不要把已有的 safe `false` 路径描述成待修的 immediate respawn。

6. **[BLOCKER] §4.3 的无条件外层 catch 会改变 LifecycleParkedError 语义，并造成重复 lifecycle cleanup。** 两条现有 commit-refusal 分支故意调用 `abortPreLaunch(..., false)` 后抛 `LifecycleParkedError`（`run-dispatcher.ts:796-804,1367-1374`），因为 park 已把 claim 置为 cancelled；而默认 `abortPreLaunch` 会调用 `onSpawnFailed`（`:916-938`）并在生产把 claim 改为 closed。现有回归甚至逐字断言 parked refusal 时 `onSpawnFailed` 不得调用（`run-dispatcher-fly887-turn-seam.test.ts:347-372`）。计划保留局部 cleanup 再无条件调用默认 outer cleanup，因此“catch-rethrow 即语义不变”和“双触发无害”均不成立。建议 outer catch 只在 `this.inflight.get(key) === entry` 时 cleanup；这样既覆盖真正漏网的中段异常，又能识别局部分支已经清理，且不会误删同 key 的新 entry。或者显式跟踪 cleanup/notify 状态，并对 `LifecycleParkedError` 使用 `notifySpawnFailed=false`。start/retry 两条都要增加：中段 throw 清槽、局部 cleanup 只通知一次、parked refusal 保持 cancelled/onSpawnFailed=0 的测试。

7. **[MEDIUM] TUI 测试与日志方案还没有可实现的 seam。** `defaultEnsureSession` 是私有函数，retry 内部直接调用 imported `spawnSync`，而现有 `deps.ensureSession` 会整体替换它（`codex-runner-tui-window.ts:97-112,130-157,294-305`）。因此 plan.md:146 所述“桩 ensure 前两次失败、第三次成功”若通过现有 deps 注入，只会绕过待测 retry loop。请抽出一个可注入 spawn/clock/sleep 的小 helper（或导出受测纯 helper），复用与 TmuxAdapter 相同的 positive-int 规则，并说明 stdout tail 通过哪个 logger 输出；当前 `defaultEnsureSession` 本身拿不到 `deps.log`。同时给 `EnsureRunnerSessionOptions` 增加 attempt-cap 注入会比测试间改全局 env 更 hermetic。

8. **[MEDIUM] 三个提交单元的依赖顺序与窄 scope 需要修正。** PR-1 若先把内层 timeout 放大/按 load 缩放，而外层仍是 10s，会让中间提交更容易被外层杀掉，所以它并非 plan.md:36 所称“独立可测”。建议把 rescue 内层预算与两个 TS caller 的外层预算合成一个原子 budget-chain commit；若必须拆，先落兼容旧内层的外层 cap/deadline，再落内层缩放。§4.4 对未知 sentinel/memory/`~/.flywheel` 载体的搜索和修改不属于 Lead 明示的三个批准项，应移出实现 PR，仅在本 issue 收尾记录事实或另开 follow-up。生产 symlink 重指可保留为部署前置步骤，但应明确它是让本 PR 生效的运维动作，不是“顺手”扩面修安装器。

## Verdict

CHANGES REQUESTED — address items above
