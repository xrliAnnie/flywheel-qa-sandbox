# FLY-2018 writer_replacement 重生体连环夭折与静默停摆 — 调研

Issue: FLY-2018 (https://linear.app/geoforge3d/issue/FLY-2018/enginebug-writer-replacement-重生体-spawn-与同名窗清理竞速ensure-heldstatusnull)
日期: 2026-08-23
基于: exploration.md

## 0. 结论先行

**真凶是 codex 账号 refresh token 被撤销(auth 死),不是 tmux ensure/同名窗竞速。**每具重生体从同一份源凭据快照 provision,fresh thread 的第一个 turn 立即以 `unauthorized` 失败 → goal 转 blocked → adapter 判 `goal ended non-complete: blocked` → teardown → 引擎再铸下一具 → 继承同一份死凭据 → 再死。共 7 具尸体(横跨 attempt 1/2,含 operator rework 的替换体),直到 00:44:28 `retry_limit_escalated` → run held + 【需人工】告警。

Issue 里的「ensure held(status=null 信号杀)」是 teardown 的**自伤噪声**;「kill returned non-ok」是**窗从未建成**的按名 kill 落空;「重试停后无告警」**不成立**(告警最终发了,只是盲换退避窗内外观像死机)。三个修点经审计重定位为:①诊断性缺陷(真实,保留);②竞速不存在(裁定不做机制,只做诊断小修+回归测试);③重定义为「诊断信号全链丢失 + 环境类失败无断路器 + 退避不可见」。

## 1. 事件账本取证(生产 teamlead.db,只读)

`workflow_run_event`(append-only,run `8bfa33b2-f8c3-4826-9af4-ae4b52acb0f2`,UTC):

```
22:31:06  dispatch_vendor_resolved      implement  050398cd   ← attempt 1 原体,正常跑了 1h42m
00:13:50  generalized_teardown_recorded implement  050398cd   ← 原体死:goal ended non-complete: blocked
00:13:52  writer_replacement            implement  d952fa7a   ← 重生体 1
00:14:03  generalized_teardown_recorded implement  d952fa7a   ← 11 秒死,同签名
00:18:58  workflow_engine_alert_enqueued/posted               ← probe_unknown 告警(liveness 三连 unknown)
00:19:43  writer_replacement            implement  0b813c92   ← 重生体 2(+repeated_dead_execution_pattern №2)
00:20:05  generalized_teardown_recorded implement  0b813c92   ← 22 秒死
00:23:03  operator_rework_requested     implement  0b813c92   ← 死角⑮配方人工恢复(issue 里说的"恢复已完成")
00:23:06  rework_replacement            implement  2e0e9e7f   ← attempt 2 首体
00:23:34  generalized_teardown_recorded implement  2e0e9e7f   ← 28 秒死 —— 人工恢复也被同一病吃掉
00:24:07  writer_replacement            implement  e8fab636   ← 00:24:35 死
00:29:07  writer_replacement            implement  c2e2e8d6   ← 00:29:33 死
00:44:07  writer_replacement            implement  09932cda   ← 00:44:27 死
00:44:28  retry_limit_escalated + workflow_engine_alert_posted ← 【需人工】,run → held
```

`workflow_run_node` 现状:`implement attempt 1 = failed(0b813c92)`;`implement attempt 2 = running(09932cda,已死)`;run status = `held`。即:issue 的「恢复已完成」指 00:23 的 rework 200,但那次恢复随后又被同一病烧穿,run 目前停在 retry_limit 的 held 收口上(这是设计内的escalation,不是新事故;本单不做恢复动作)。

## 2. 死因取证(尸体 CODEX_HOME rollout,只读)

`~/.flywheel/codex-homes/d952fa7a-…/sessions/2026/08/23/rollout-…-01a0311d-….jsonl`(17 行,两个 turn):

```json
{"type":"task_complete","turn_id":"01a0311d-eab0-…","error":{
  "message":"Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
  "codex_error_info":"unauthorized"}}
```

两个 turn(goal kick + ponytail 注入)都以同一错误即刻失败。每具尸体各有独立 fresh threadId(session.json 证实),排除「resume 同 thread adopt 已 blocked goal」(codex-daemon-client.ts:1163 的 adoption 分支)作为死因——那条路径需要同 thread,而这里全是新 thread。

**死链**:startTurn → turn 秒败 unauthorized → daemon 把 goal 置 terminal `blocked` → `runGoalToTerminal` resolve(status=blocked)→ `CodexTmuxAdapter` `classifyGoalOutcome` → `failureKind: "goal_blocked"`, `failureReason: "goal ended non-complete: blocked"`(CodexTmuxAdapter.ts:1218-1222)→ CommDB session 置 `blocked` → 引擎 dead-exec sweep → `rollbackDeadWorkflowNodeExecution` → 再铸。

**auth error 在这条链上没有任何一层被携带**:client 的 `onNotification` 只提取 turnId(codex-daemon-client.ts:728-735),turn 终态的 error 字段被丢弃;`GoalNotification.goal` 只有 status/objective/tokensUsed/timeUsedSeconds。这就是 3a「诊断信号全链丢失」的机制。

**rotation 为什么没接住**:`codex-daemon-goal-runtime.ts` 的 account rotation 只在 daemon **进程死亡**(transport closed / socket 死)时换号重启(`runGoal` 注释:"A daemon death mid-run … restarts on the NEXT account");goal 以 terminal blocked 结束是正常 resolve,daemon 活得好好的,rotation 永不触发。unauthorized 恰好是「daemon 活、turn 死」的形态,完美绕开 rotation。

**spawn 无 auth preflight**:codex-daemon-runtime / CodexTmuxAdapter 无任何 auth 时效检查;每个 runner home 由 provision 从 `sourceCodexDir()`(共享凭据快照)复制 auth.json——源头 token 一撤销,所有新体 DOA。

## 3. ensure-held 噪声的机制闭环(修点①的真相)

Bridge 日志(/tmp/flywheel-bridge.log 539287-539311)d952fa7a 段的**真实顺序**:

```
session_started (00:13:59)
runner-tui-window: terminal visibility loss trigger=run-ended attempts=1 reason=unknown   ← run 已结束,TUI attempt 1 还在飞
runner-tui-window: kill returned non-ok (non-fatal)                                       ← teardown 按名杀窗,窗从未建成 → 落空
codex daemon transport closed: closed by client / group signal SIGTERM
d952fa7a failed: goal ended non-complete: blocked                                          ← 死因已定
runner-tui-window: guarded session ensure attempt 1 held (status=null): {"action":"verified","reachablePid":6234}   ← 事后
runner-tui-window: guarded tmux session ensure held — skipping
```

机制:run 结束 → `activeTuiAbort.abort("run-ended")`(CodexTmuxAdapter.ts:812-822 的 deadline/teardown 路径)→ `spawnCommandAsync` 的 `onAbort → terminate()` 给尚在飞行的 `tmux-server-rescue` helper 发 SIGTERM(codex-runner-tui-window.ts:403-421)→ child close 时 `status: terminationRequested ? null : status` 折叠为 `null`(:442-447)→ `ensureSessionWithRetryAsync` 只看 `result.status === 0`,把它记成 `held (status=null)` 并原样打出已收到的成功 stdout(:334-340)→ post-attempt 检查发现 signal aborted → return false → 外层打「held — skipping」,随即因 `signal.aborted` 返回 **cancellation**(codex-runner-tui-window.ts:806-810),甚至没走到 issue 声称的 `retryable-hold` 分支。

三个可核事实钉死「自伤」而非外部凶手(FLY-1999 QA harness 洗清):

1. 时序:ensure-held 在 `failed:` 之后;
2. 单 attempt 即放弃:外部信号杀(signal 未 aborted)会走 1 秒退避重试(deadline 210s),日志只会先出现 attempt 2/3/…;只有 abort 路径会在 attempt 1 后立即 return false;
3. `visibility loss trigger=run-ended` 在 kill 之前出现,证明 abort 先于一切 tmux 噪声。

**真实缺陷仍在**(即使不是本次死因):

- `spawnCommandAsync` 丢弃 close 事件的 `signal` 参数,且不区分「内部 timeout」「内部 abort」「外部信号杀」——三者都折叠成 `status: null`;
- 包装层丢弃 helper stdout 的成功动作(与姊妹路径 `TmuxAdapter.ensureRunnerSession` 行为不一致——那边解析 JSON 并校验 `action ∈ TMUX_ENSURE_SUCCESS_ACTIONS ∧ reachablePid > 0`,TmuxAdapter.ts:1963-1977);
- 被自家 abort 取消的 attempt 打「held」——正是这条日志把 FLY-2018 的 filing 带偏。

## 4. 修点②竞速:证据裁定不存在

- 旧体(050398cd)teardown 的 killWindow 成功(「runner-tui-window: killed」);
- 新体(d952fa7a)的「kill returned non-ok」发生在**它自己的 teardown**,原因是窗从未建成(attempt 1 在 ensure 阶段就被 abort),按名 kill 无目标;`killRunnerTuiWindow` 不区分「窗不存在」与真失败(codex-runner-tui-window.ts:978-984,exec stdio ignore,stderr 丢弃);
- 「kill 非 ok 时 ensure 被 guard 扣住」的联动机制不存在:teardown 的 kill 是裸 `tmux kill-window`,不经 `tmux-server-rescue`,不持有 rescue lock;ensure 的 hold 语义(`hold_lock_unavailable` 等)来自 rescue helper 自身的锁与裁决,与 kill 结果无耦合;
- 同名窗真冲突场景已有 FLY-1239 provable purge 兜底:按 immutable `@id` kill → re-ensure → re-list 验证零同名窗,验证不过返回 `stale_window_unproven`(retryable),create 永不叠在模糊窗上(codex-runner-tui-window.ts:686-727);TUI 窗全程 fail-open,只损可见性不碰 run。

裁定:不为该竞速建收敛机制。residual 工作:kill 落空 vs 真失败的日志区分 + 一条回归测试证明「同名窗存在且 kill 失败 → purge 收敛不死锁(stale_window_unproven → 重试)」的既有不变量。

## 5. 「静默停摆」的真实构成

| 时段 | 引擎实际在做什么 | 外部可见性 |
|------|------------------|------------|
| 00:14:03–00:19:43 | d952fa7a liveness probe 三连 `unknown`(00:18:58 发 probe_unknown 告警)+ 盲换退避 | 仅一条 unknown 告警;node running+死 exec |
| 00:20:05–00:23:03 | 0b813c92 死后按 `retryDelaysMs = [60s, 5min, 15min]`(workflow-engine-dispatcher.ts:1928)进入退避 | **零信号**。issue 正是在这窗口内 filed「不再重试,静默停摆」 |
| 00:29:33–00:44:07 | 15 分钟档退避 | 零信号 |
| 00:44:28 | retry_limit_escalated → run held + 【需人工】 | 告警发出(带「盲换 3 次仍起不来」,不带 unauthorized) |

即:出口存在且最终走到了,但(a)退避等待完全不可见,(b)最终告警不带真实死因,(c)`repeated_dead_execution_pattern`(deathNumber 2/2/3 三次触发)只写账不出声。「无出口病」在本案的准确表述是「**出口慢 + 全程哑 + 到站后报错标签**」。

## 6. 现有机制盘点(修改落点)

| 机制 | 位置 | 现状 |
|------|------|------|
| turn 通知处理 | codex-daemon-client.ts `onNotification`/`onGoalUpdate`(:721-753) | 只取 turnId/goal.status,error 丢弃;所有 daemon 通知均经 `onNotification(method, params)` 可见,error 数据在协议里有(rollout `task_complete.error` 为证) |
| 失败分类 | CodexTmuxAdapter `classifyGoalOutcome` + `result.failure`(:1200-1223) | `failureKind: "goal_blocked"`,reason 固定文案 |
| teardown fact | StateStore `generalized_teardown_recorded` 事件 + `hasWorkflowExecutionTeardownFact` | payload 无失败分类 |
| 盲换 + 退避 | workflow-engine-dispatcher.ts dead-exec sweep(:1820-2040)+ StateStore `rollbackDeadWorkflowNodeExecution`(:32640-33062) | 退避表内联、无落账;`repeated_dead_execution_pattern` 纯事件 |
| retry_limit 收口 | StateStore :32768-32806 | run→held + 【需人工】alert(`workflowBlindReplacementExhaustedAlertPayload`) |
| patrol 名册 | FLY-1925 `patrol_tick`(liveness 红灯已有) | 不含盲换退避/下次重试时间 |
| ensure 包装(TUI) | codex-runner-tui-window.ts `ensureSessionWithRetry{,Async}`(:242-354)+ `spawnCommandAsync`(:373-450) | 只看退出码;provenance 缺失 |
| ensure 包装(主窗) | TmuxAdapter.ts `ensureRunnerSession`(:1905-2016) | 解析 stdout action(对齐目标) |

## 7. 风险与边界

1. **环境类分类的 fail-safe**:把偶发网络错误误标为环境类 → 早停会伤可自愈场景。设计须白名单精确匹配(如 `codex_error_info === "unauthorized"`),未知错误一律维持现行盲换路径;
2. **信任被信号杀的成功 stdout**:helper 的成功 JSON 打印于动作完成后,JSON 完整可解析 + action 合法 + reachablePid 合法即动作已完成;但保守起见成功裁定前补一发轻量 re-verify(`tmux has-session`,秒级),verify 不过按原 held 语义重试——不引入任何新的成功路径,只避免把已成功的 ensure 误判;
3. **事件账膨胀**:退避可见性若走 `workflow_run_event` 会每次退避追加;选 watch 行(可 UPDATE)物化 `next_retry_at` + patrol 读取,零新增告警通道(FLY-1687/1925 的既有纪律);
4. **auth 轴不越界**:凭据快照时效预检、unauthorized 触发 rotation/AUTH_EXPIRED 上报属账号族(FLY-513 相邻);本单只保证引擎面对 auth 死「快收口 + 说真话」,auth 自愈另立 issue 由 Lead 分诊。

## 8. 会过期的结论(as-of 2026-08-23)

| 结论 | as-of | 重核方式 |
|------|-------|----------|
| run 8bfa33b2 状态 = held,implement attempt 2 running+死 exec 09932cda | 2026-08-23 审计时 | `sqlite3 file:~/.flywheel/teamlead.db?mode=ro "SELECT status FROM workflow_run WHERE run_id LIKE '8bfa33b2%'"` |
| 行号引用(codex-runner-tui-window.ts:806 等) | branch `flywheel-FLY-2018` @ 1c74ea6af | `git log -S` 重定位 |
| `retryDelaysMs = [60s,5min,15min]`、`MAX_BLIND_REPLACEMENTS = 3` | 同上 | 读 workflow-engine-dispatcher.ts / StateStore.ts:146 |
| daemon 通知流中 turn error 的确切方法名/字段形状 | 未实测,由 rollout 数据推定存在 | implement 节点起真 daemon 抓一次通知流(参考 memory: real codex daemon QA harness 配方) |
| codex 源凭据的撤销与恢复状态 | 未核(不在本单范围) | 账号族 issue 处理 |
