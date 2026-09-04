# FLY-2313 pending 占位窗口收账 — 探索
Issue: FLY-2313 (https://linear.app/geoforge3d/issue/FLY-2313/病根-closeout-只在杀窗成功时才收-commdb-账而-pending-占位窗口按设计永远杀不掉-merge-后-thread)
日期: 2026-09-03
基于: 无

## 问题

`closeRunnerInner` 目前只在 `killTmuxWindow` 返回 `killed: true` 时调用
`finalizeCommDbSession`。这把两个不同事实绑成了一个判据:

- tmux 杀窗是否执行成功;
- 该执行体是否已有可证明的死亡/终态证据,因而可以结清 CommDB 会话。

`runner-flywheel:pending` 是尚未物化的占位身份。`killTmuxWindow` 对它返回
`{ killed: false, error: "tmux window identity is still pending" }`,以免把未经确认的
窗口身份交给 tmux。这项安全拒绝必须保留。`:pending` 自身也不是死亡证据:活体完全
可能因为注册没有跟上而仍保留占位名。

## 锁定范围

- 修改 `packages/teamlead/src/bridge/close-runner.ts` 及其回归测试。
- 按 Lead 对 design-review HIGH 的范围放宽,修改 `lifecycle-closeout.ts` 及其回归测试,
  消费显式 `physicalGone:false` 并阻止 teardown 失败后误归档。
- 修改 `packages/teamlead/src/bridge/land-closeout-cause.ts` 及其回归测试,让 pending 拒绝
  映射到 `window_identity_pending`。
- 不修改 `killTmuxWindow` 的 `:pending` 拒绝语义。
- 不修复上游为何未把 `tmux_window` 从 `:pending` 替换成真实窗口名。
- 不修改 founder authority、gate、claim、approval 或 land retry policy。
- 不修改 `post-merge.ts` 或 `post-ship-finalization.ts`;当前两条路径的判据差异作为发现
  上报 Lead,不在本单暗中抹平。
- 不提前归档 thread:`closed` 与归档仍要求 `res.killed === true`。

## 方案比较

### A. 所有杀窗失败都继续收账

把 `finalizeCommunications()` 完全无条件化。改动最小,但 `permission denied`、超时或
`:pending + running` 都可能对应仍存活的执行体;这会在活体存在时删除通信账并退休其
仍在等待的 gate,风险高于原 bug。

### B. 用既有死亡/终态证据解耦收账（采用）

保留 `res.killed` 作为物理关闭与 UI 清理、检测清理、thread 归档的判据。通信收账改用
三个相互独立的证据,任一成立即可:

1. `res.killed === true`;
2. 对非 pending 的可探测目标,复用 `cleanupTmuxTarget` strictState 已采用的进程探针
   `probeRunnerProcessLiveness`,且只接受 `absent | dead_pin`;pending 占位目标不执行该探针;
3. session 行带结束时间,且 status 属于 `completed | timeout | failed`。

这让 `:pending + completed + ended_at` 可以收账,但 `:pending + running` 仍 fail-closed。
对非 pending 目标,若探针明确返回 `alive`,该正面存活证据会否决 terminal-session 析取项;
终态 status 不能覆盖“仍活着”的事实。
每次不能收账都写
`commdb_finalize_skipped:<killTmuxWindow 原话>`,不再按失败种类决定是否记录。

### C. 看到 `:pending` 就视为可收账（拒绝）

名字判断容易实现,也能让已完成的两个生产实例收尾,但会把“身份未知”错误翻译成
“执行体死亡”。它可能删除活体的 CommDB 路由与 pending gate,违反安全边界。

## 成功标准

1. `tmuxWindow` 以 `:pending` 结尾、session 为 `completed + ended_at` 时,杀窗仍被拒绝,
   但 CommDB finalizer 被调用且 `commDbFinalized` 反映真实结果。
2. `:pending + running` 即使测试 seam 预设会返回 `absent`,也不执行进程探针、不调用 finalizer,并返回
   `commdb_finalize_skipped:tmux window identity is still pending`。
3. 非 pending 杀窗失败只有在探针证明 `absent | dead_pin` 或 session 终态证据成立时才收账;否则同样
   保留原始拒绝原因。
4. `closed` 始终等于 `res.killed`;pending 路径不写 cmux pin、不关 Terminal view、不触发
   thread archive。
5. `inferLandCloseoutCause` 把 pending 原话归为 `window_identity_pending`,不再是 unknown。
6. `killed: true` 的既有输入、返回值和副作用逐字节不变。
7. 把通信判据变异回 `res.killed` 后,终态 pending 回归测试必须变红;删除 pending probe
   跳过条件后,`pending + running + probe preset absent` 回归测试也必须变红。
8. `pending + terminal CommDB + killed:false` 返回显式 `physicalGone:false`;lifecycle 不把
   finalization 后消失的 CommDB 行反推成 gone,thread archive 不运行。删除该传递时测试必红。
9. 未杀窗分支在收账前只读重验既有 `authorityCheck`;失权只拒绝 finalizer并走
   `authority_lost:pre_commdb_finalize`,绝不授予或修改 authority/gate/approval/claim。
10. 非 pending + terminal CommDB + probe alive 时不收账;删除 alive veto 后测试必须变红。
