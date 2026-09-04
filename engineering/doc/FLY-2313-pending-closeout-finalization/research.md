# FLY-2313 pending 占位窗口收账 — 调研
Issue: FLY-2313 (https://linear.app/geoforge3d/issue/FLY-2313/病根-closeout-只在杀窗成功时才收-commdb-账而-pending-占位窗口按设计永远杀不掉-merge-后-thread)
日期: 2026-09-03
基于: exploration.md

## 调研方法

本调研只使用当前分支 `86387f17d` 的仓库源码、git 历史与现有单测。没有依赖外部网页
或生产写入。沿数据流从 CommDB tmux 身份追到 close result,并与仓库内已有的四态
runner process liveness 和 terminal-session 判据比较。

## 证据链

### 1. 安全层有意拒绝占位身份

`packages/teamlead/src/bridge/tmux-lookup.ts` 的 `killTmuxWindow` 在任何 tmux 命令前执行:

```ts
if (tmuxWindow.endsWith(":pending")) {
  return { killed: false, error: "tmux window identity is still pending" };
}
```

现有 `tmux-lookup.exec-identity.test.ts` 已断言该路径不执行底层 kill。这个防护不是缺陷,
也不能改成 `killed: true`。

### 2. `closeRunnerInner` 把通信收账绑定到杀窗结果

`packages/teamlead/src/bridge/close-runner.ts` 的末段只在 `res.killed` 时调用
`finalizeCommunications()`。因此任何杀窗拒绝都会固定得到 `commDbFinalized: false`,无论
是否存在另一条独立的死亡/终态证据。

同文件已经在“CommDB 没有 target”的 already-gone 分支直接收账,证明函数既有语义并非
“只有本次亲手 kill 才能收账”。

### 3. 复用现有 strictState 的已死亡判据

`cleanupTmuxTarget` 的 strictState 已用 `probeRunnerProcessLiveness` 区分
`alive | dead_pin | absent | indeterminate`,且只把 `absent | dead_pin` 当成 `gone`。
本单对非 pending 的可探测目标直接复用同一 probe 和同一二值集合,不另写一套窗口存活
定义。该 probe 自身没有 pending guard;若拿 `runner-flywheel:pending` 占位串去问 tmux,
“找不到这个占位目标”会被译为 `absent`,却不能证明未知的真实窗口不存在。因此 pending
目标必须跳过该 probe,只允许独立的 CommDB session 终态证据授权收账。名字形状仅拒绝
无意义的探测证据,绝不构成死亡证据。

### 4. session 终态是第三种独立证据

生产证据中的 FLY-2166 / FLY-2169 CommDB 行已经是 `status=completed` 且有 `ended_at`,
但 `tmux_window` 仍是 `runner-flywheel:pending`。这组字段表示 session 生命周期已经落入
终态,即使窗口注册从未物化。

安全集合必须保持窄为 `completed | timeout | failed` 且结束时间非空。`running` / `blocked`
即使名字也是 pending 也不能收账;FLY-2045 / FLY-2080 就属于需要保留并诊断的上游问题。

### 5. post-merge 当前判据与本次裁定并不完全相同

`cleanupTmuxTarget` 的 strict 分支会在身份 unresolved 时调用四态 process probe,把
`absent | dead_pin` 视为 `physicalGone`。但 `postMergeTmuxCleanup` 的生产调用没有传
strict 配置,所以实际 non-strict 返回的 `physicalGone` 只是 `killResult.killed`。

因此 close-runner 复用 strictState 的 `absent | dead_pin` 判据后会比现有 post-merge
路径更宽。该差异已经上报 Lead;按范围不改 `post-merge.ts` 或 post-ship 调用。PR body
必须明示 close-runner 多认哪两种证据、为何本单不联改,以及后续应在独立验证后把
post-ship 对齐到同一判据。

### 6. 当前错误诊断仍不闭合

当前 `CloseRunnerResult.error` 已是 `res.error ?? finalizeError`,所以 raw kill 原话没有在
这个返回对象里完全消失。但 `finalizeError` 本身仍只在 `res.killed` block 内赋值,无法
表达“为什么没有收 CommDB 账”。正确形状是每次跳过 finalizer 都写
`commdb_finalize_skipped:<raw kill error>`。

`land-closeout-cause.ts` 当前没有 `window_identity_pending`;即使 raw error 到达下游,
`inferLandCloseoutCause` 仍返回 `unknown`。Lead 已把新增 enum、matcher 与中文说明纳入
本单边界。

### 7. 当前测试缺口

`close-runner.test.ts` 覆盖无 target、successful kill、permission denied 与 finalizer
failure,但没有同时建模 target 字符串、liveness、session status/结束时间三维组合。
`land-closeout-cause.test.ts` 也没有 pending identity 归类。

### 8. finalization 不能替代 physical-gone 证据

设计审复核出新增链路风险:`lifecycle-closeout.ts` 先写
`communicationsFinalized = closeRes.commDbFinalized`,再在 finalizer 删除 CommDB row 后重查
target。此时 lookup 返回 gone,会把 `confirmedGone` 置 true;teardown 虽 failed,但
`anyBlocked=false`、outcome 变 partial。`done-thread-reconcile.ts` 接受 partial,而 veto3
同样因 session row 已删看不到活体,最终可能归档 thread。

因此 finalization 结论必须同时携带上游已经知道的物理证据。`CloseRunnerResult` 在
`killed:false` 的收尾结果上显式带 `physicalGone`:非 pending probe 的
`absent | dead_pin` 为 true,仅靠 terminal CommDB 证据为 false。lifecycle 只在字段显式
false 时保持 `confirmedGone=false`;旧的 killed=true 路径字段 undefined,语义不变。

### 9. 新破坏性分支必须复用现有 authority 收紧点

未杀窗路径新增 finalizer 后,它前面跨过 kill/probe I/O,不能沿用 kill 前的旧授权快照。
`authorityCheck` 契约已经要求每个后续外部 mutation 前重验。本单只在
`!res.killed && commDbCanFinalize` 时再次只读调用现有 `authorityLostReason`;失败或异常
只会 `abortAuthorityLost("pre_commdb_finalize", reason)` 并拒绝 finalizer。它不写
authority/gate/approval/claim,不改变任何批准判据,也绝不把拒绝变允许。

### 10. terminal status 不能覆盖明确 alive

非 pending 目标会得到真实 process probe。若 kill 失败且 probe 返回 `alive`,这是比终态
status 更强、更新的正面存活事实;直接把 terminal session 作为无条件析取项会删除活体
路由与 gate。终态证据因此只在 `runnerLiveness !== "alive"` 时授权。pending 不执行 probe,
其值为 undefined,所以原目标不变;indeterminate 也仍可由独立终态记录授权。

## 根因假设与最小验证

单一假设:把 finalization 判据从 `res.killed` 扩成

```text
res.killed OR (target not pending AND liveness in (absent, dead_pin)) OR (ended_at present AND status in completed/timeout/failed)
```

即可让已结束的 pending session 收账,同时让 pending running 保持 fail-closed 且不对占位
字符串执行 liveness probe。`closed` 仍由 `res.killed` 单独决定。

最小验证先写两个相反的 pending 测试:terminal row 必须 finalize,running row 必须 skip。
当前代码前者必红;后者在新增判据后防止最危险的 name-based shortcut。再分别覆盖
liveness absent/dead_pin、liveness alive/indeterminate、structured skipped error 和 cause mapping。

## 风险边界

- `:pending` 永不直接构成死亡证据,也不允许把“占位目标不存在”当作真实窗口 absent。
- `alive` 明确否决 terminal-session 授权;`indeterminate` 本身不能授权,但独立终态记录仍可。
- 终态 session 必须同时满足窄 status 集合与 non-null 结束时间。
- `closed`、Terminal/cmux pin、detection CLEARING、thread archive 仍只看 `res.killed`。
- `finalizeCommDbSession` 的原子 gate/ask retirement 语义保持原样,不修改授权数据结构。
- `physicalGone:false` 与字段缺失不同;前者是已知未证死,后者保留 killed=true 老路径形状。
