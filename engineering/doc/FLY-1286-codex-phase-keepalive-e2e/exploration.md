# FLY-1286 Codex 常驻三段式 529 Room 真机 E2E — Exploration

Issue: [FLY-1286](https://linear.app/geoforge3d/issue/FLY-1286/qa-fly-1269-codex-常驻三段式-529-room-真机-e2edesigncodex-implementcodex)
日期: 2026-07-15
基于: FLY-1269 PR #604 head `cad61a078`、首次 529 FAIL 证据 `ec78d792`、当前 test-slot-2 真机状态

## Problem

FLY-1286 不是功能开发票，而是 FLY-1269 PR #604 的隔离真机验收载体。它需要在
529 Room 对一条真实的 Design → Implement → QA 链做不可替代的运行时证明：

1. phase 路由锁定为 Design=Codex、Implement=Codex xhigh、QA=Opus；
2. Codex phase 完成本阶段后仍保留同一 execution、thread、native goal 与上下文，
   进入 paused/parked，而不是退出或由新 session 冒充恢复；
3. parked phase 能从真实 mailbox 收到 durable wake，以同一 goal 重新激活，并在下一
   phase boundary 再次进入 hold；
4. phase-hold 期间 active/hard deadline 与 token 消耗冻结；daemon 崩溃后仍恢复同一
   thread/goal/hold；
5. shared branch 的 TURN 在三个 phase 之间单调交接，任何被唤醒但不持有 TURN 的 phase
   不触碰 worktree；
6. issue 终态时 Codex phase 走 `runner_shutdown_controls` request/ack，再清理 TUI、
   app-server、session 与 TURN，不留下孤儿。

边界同样重要：业务数据与 repo mutation 只发生在 `/tmp/flywheel-test-slot-2`、
test-slot-2 CommDB 与 QA sandbox remote。Flywheel runtime 本身还会按协议写该 execution
唯一可归因的 `~/.flywheel/state/codex-sessions/<exec>`、
`~/.flywheel/codex-homes/<exec>`、`~/.flywheel/cdx-sock/<exec-hash>.sock*`，以及
gate/review-request marker；这些路径必须逐项 allowlist。不得触及其他 project 的 CommDB、
其他 execution state、production repo/branch，不得向 FLY-1269 加 production code，也不得
把自报或静态测试冒充真机证据。

## Context Audit

首次链的 Design execution `c552669e-611b-47fc-98ca-63371c81cbe8` 已由 Implement
阶段证明 **A2 FAIL**：它虽保留同一 execution/thread/socket，却没有 `phaseHold`，native
goal 保持 `active`，5 秒内 `tokens_used +683`、`time_used_seconds +5`。原始证据已固定在
shared branch `ec78d792`；该链永久归类为 failed attempt，不能从 crash/wake 步骤续跑，也
不能被新结果覆盖。

FLY-1269 随后在 `7d20e4a76` 增加 parked-boundary hold：当 native goal 尚未发出
`complete`、但 CommDB 已持久化 `declared parked` 时，goal loop 也必须先
`enterPhaseHold()`。production PR #604 当前 head 为 `cad61a078`。本次 fresh Design root
固定为 `464064c0-a711-4aa7-9426-5633dcef590d`，其权威 baseline 为：

- `StateStore.sessions`: `status=running`、`adapter_type=codex-tmux`、
  `chat_thread_role=design`、`runner_model=gpt-5.6-sol`；
- `three_stage_turn`: FLY-1286 的 holder 为该 execution，`phase=design`、`epoch=3`；
- Codex session state: thread `019f654c-e651-71c2-9ab9-c4e68bcdcfd5`，有独立
  `daemonPid`；
- native `thread_goals`: 同一 thread 的 goal 当前为 `active`；
- shared branch 起点保留首次失败证据 `ec78d792`，production runtime candidate 为
  `cad61a078`。

runtime attestation 不能只读旧 `bridge.log`：该文件保留了一次 `8c4de74de` boot，但当前
listener 的 `/health` 在 `2026-07-15T10:29:43Z` 报告 uptime `783.36s`，推算启动于
`10:16:39Z`；fixed source/dist 分别在 `10:15:58Z` / `10:16:00Z` 落盘，listener cwd
指向 FLY-1269 QA worktree，live dist 同时包含 `observeBoundary()` 与 parked
`enterPhaseHold()` 分支。Design preflight 已在 pinned `cad61a078` candidate dist 上用
同一 control-flow 邻域的有界顺序检查验证该语义，而不是假定某一种 TypeScript 表达式
文本。因此本次 execution 是 fix 后新 spawn；Implement 仍需把这组
attestation 写进 manifest，不能仅用 commit label 推断运行代码。

同一 issue 在本次 fresh spawn 前已有 blocked/terminated 预检和一条完整 A2 FAIL 链。因此验收不得断言
“FLY-1286 只有三条 session”或“turn history 只有三行”；必须从当前成功 Design
execution 建立 chain manifest，再只追踪它产生的 downstream Implement/QA execution。
`three_stage_turn` 当前行是 worktree authority，append-only history 仅是审计证据。

FLY-1269 已有单测和 isolated app-server probe，证明 complete→paused、同 goal wake、
deadline 恢复及 DB 状态机，但那些证据不能证明 Bridge、dispatcher、529 Room、真实
mailbox、真实 TURN 和 issue-terminal closeout 已连成一条完整链。

## Questions Resolved

### Q1: 这张票是否需要生产实现？

不需要。candidate snapshot 已包含被验收实现。本票只新增过程文档与隔离 E2E 证据；
任何发现的实现缺陷都应 FAIL 并回到 FLY-1269 修复、重新 review 后再跑，而不是在
FLY-1286 热补生产代码。

### Q2: 谁能证明 phase 在自己结束后仍活着？

phase 自己不能作为唯一见证。Design 在 `complete` 后只能 park；Implement/QA 必须从
StateStore、CommDB、session state、native goal DB 与真实进程/TUI 反向观察上游 phase。
issue terminal 后三个 phase 都应下线，因此最终 shutdown 必须由 issue 外的 FLY-1269
收尾会话（source session `5506dbbc`）或 Lead 侧观察器记录。

### Q3: 为什么不能只在终态后查 `runner_shutdown_controls`？

成功 closeout 会调用 lifecycle cleanup，删除 `runner_phase_wakes`、
`runner_shutdown_controls` 与 CommDB session registry。事后只看到“行不存在”无法区分
“正确 request→ack→delete”和“从未 request 便直接 kill”。因此外部观察器必须在终态
前启动，轮询并持久化 `requested` 与 `acked` 帧，再用终态后的行消失、进程消失与
StateStore close events 完成闭环。

### Q4: mailbox wake 应唤醒哪个 phase？

优先唤醒已 parked 的 Design。由 Lead 使用现有 `flywheel-comm send` 发送无 worktree
副作用的 probe 指令。Design 收到 `[phase-wake <id>]` 后先执行 TURN；此时 Implement
持有 TURN，Design 必须报告 CLI 的真实值 `not-yours`、重新 park，并在同一 native goal 的下一次
complete 后重建 `phaseHold`。这同时验证 mailbox intake、wake activation、stable id
与 TURN 拒写语义。

### Q5: crash recovery 应杀什么？

`session.json.daemonPid` 不是 app-server pid，而是 Flywheel 启动的 detached rotation shim，
同时也是只包含该 shim 与其 `codex app-server` 子孙的 process-group leader。只 kill 这个
正 pid 会留下仍占 control socket 的 app-server orphan，无法触发 transport close。因此
fault injection 必须先用 execution-private socket、`lsof` 与 PGID 三方证明 holder 属于
记录的 detached group，再对整个 group 发一次 SIGKILL；任一身份探针 indeterminate 都
不得 signal。前置还必须校验 execution、issue、thread、`phaseHold=paused` 与 TURN 已在
下游 phase。期望 adapter 重新拉起新 group，复用同一 thread/goal，并保持 paused 与预算
冻结。若 group leader 未变化、socket 未恢复、thread/goal 变化或出现新的 Design session，
立即 FAIL。

### Q6: 首次 A2 FAIL 后应该续跑还是整链重跑？

必须整链重跑。A2 是后续 crash、wake、Implement resident 与 terminal shutdown 的共同
前置；旧 Design 从未进入 paused hold，后续任何通过都不能补回那段缺失事实。fresh manifest
以 `464064c0-…` 为 root，把 `c552669e-…` 及其 Implement execution 只放进
`priorAttempts`，再从 A1 开始重新证明 A1–A8。

## Approaches

本次 rerun 额外比较了三种恢复方式：

1. **续跑旧链**：省时，但 A2 的失败窗口不可逆，直接拒绝；
2. **只重测 A2**：能验证补丁，却无法证明补丁没有破坏 wake/re-hold/shutdown，证据范围
   小于原验收，直接拒绝；
3. **fresh root 重跑完整矩阵**：保留旧 FAIL，使用新 execution 重跑 A1–A8。成本最高，
   但这是唯一可形成 FINAL PASS 的方式，也是本次采用方案。

### Approach A — Passive observation only

只让三段正常完成，查询 session/backend/状态并截图。

优点：最少扰动；最接近普通用户流。

缺点：无法证明 mailbox wake、同 execution reactivation、daemon crash recovery 与
shutdown request/ack；最多证明“看起来 parked”。不满足核心验收。

### Approach B — Synthetic harness replay

写一个独立脚本直接构造 CommDB、goal client 与 fake phase sessions，完整跑状态机。

优点：可重复、断言精确、失败定位快。

缺点：绕过了本票要验收的真实 dispatcher、Bridge、tmux、mailbox 与 phase handoff；
FLY-1269 已有这类 unit/integration/protocol probe，再做一份不能提高真机置信度。

### Approach C — Real chain + independent witness + bounded fault injection

让真实三段链自然运行；每个下游 phase 反向见证上游 parked 状态；Lead 对 Design 注入
一次 bounded mailbox wake；在 hold 中对已证明的 Design daemon process group 做一次可恢复故障；
外部收尾会话在 issue terminal 前预置 shutdown observer。

优点：覆盖用户要求的真实集成面；每个高风险动作都有窄前置与明确 fail-close；不改生产
代码；证据可绑定 execution/thread/goal/message/request id。

缺点：需要跨 phase 时序协调；终态证据必须由外部观察者完成；一次真实 daemon crash
会增加本次 E2E 时间。

## Recommendation

采用 Approach C。它是唯一同时满足“真机”“同 session 常驻”“wake”“预算冻结”与
“shutdown 落库”的方案。执行中保留 Approach A 的被动采样作为基线，并复跑已有窄测试
作为回归保护；不采用 Approach B 替代真机链。

## Design

### Chain manifest

建立一份只增不改语义的 manifest，至少记录：

- issue id、sandbox project、candidate SHA、CommDB/StateStore 路径；
- Design/Implement/QA 的 execution id、role、backend、model、effort、thread id、
  daemon pid、tmux target；
- 每次 TURN 的 holder、phase、epoch、granted_at；
- wake 的 CommDB instruction id、mailbox message id、source_instruction_id；
- shutdown 的 request id 与状态时间线；
- 每个证据帧的 UTC 时间与采集者。

manifest 以当前 fresh Design execution `464064c0-a711-4aa7-9426-5633dcef590d` 为 root。
首次 A2 FAIL 与更早预检尝试单独列为 `priorAttempts`，
不得混进 PASS chain。

### Evidence planes

每个核心结论至少使用两个相互独立的证据面：

| Claim | Primary evidence | Corroborating evidence |
|---|---|---|
| phase vendor/model/effort 正确 | StateStore session + daemon argv | live TUI capture |
| phase 完成后仍常驻 | session row/heartbeat + tmux + control-socket listener/holder group live | session.json `phaseHold` + goal paused |
| budget freeze | 两次 native goal tokens/time/updated_at 采样 | `phaseHold` 剩余 deadline 字段稳定 |
| mailbox wake 激活 | `runner_phase_wakes` pending→started→finished | same thread/goal tokens 增后再次 paused |
| TURN 正确 | `three_stage_turn` 当前 holder | append-only `turn_source_history` + phase 自身 `turn` 输出 |
| crash recovery | shim/PGID A→B、socket listener/holder 重建、same thread/goal/phaseHold | 无新 Design session、TURN 不漂移 |
| terminal shutdown | 外部 observer 捕获 requested→acked 或同 request id 的 durable graceful-close event | heartbeat/tmux 决定路径分类 + socket holder/session/turn 最终消失 |

### Phase responsibilities

Design phase 只产出 exploration/research/plan，记录成功链 baseline，完成 design review，
commit/push 后 `phase_design_complete` + `park`。它不执行自己的 hold 验收，因为这需要
在它结束后由下游观察。

Implement phase 不写生产代码。取得 TURN 后捕获该 successful chain 的 Design/Implement
epoch，要求 holder/phase 正确且 Implement epoch 严格大于 Design epoch；再验证 Design 已 paused/parked ≥60s，
采集冻结样本；再在严格 socket/PGID 前置下对 Design daemon group 做一次 crash；恢复稳定后通过 Lead 请求
一次 bounded Design wake。Implement 只整理隔离证据并推进既有三段协议，自己的阶段完成
后同样 park，供 QA 反向验证。

QA Opus 作为独立 verifier，取得 TURN 后捕获 QA epoch，要求其严格大于已记录的 Implement
epoch 且在复核期间不变；随后核对 Design 与 Implement 两个 Codex
phase 都是原 execution/thread 且 parked；验证 Implement 的 xhigh argv/TUI、Design 的
crash/wake 时间线、TURN history 与证据文件；复跑触及的窄测试。任一 claim 缺权威证据
即 FAIL，不用“未发现问题”推导 PASS。

FLY-1269 收尾会话/Lead 观察器在 founder/ship terminal 之前开始记录两个 Codex phase
的 shutdown rows，直到捕获 ack 和 cleanup；随后把最终结果回写 FLY-1269 qa-report。
三段内的 qa-report 在此之前必须明确标为“terminal closeout pending”，不能提前宣称
FINAL PASS。

### Failure policy

- wrong backend/model/effort、execution/thread/goal 变化、duplicate phase spawn：FAIL；
- hold 60s 内 token/time 增长或 goal 非 paused：FAIL；
- mailbox delivered 但无 durable wake row，或 row 不绑定 source instruction：FAIL；
- wake 后没有再次 phaseHold，或 stable id 重放产生第二次外部副作用：FAIL；
- crash 后出现新 Design execution、thread/goal 变化、预算重置：FAIL；
- TURN holder/epoch 不匹配仍修改 worktree：FAIL；
- live 且 heartbeat-fresh controller 未 request/ack 或无同 request id durable graceful-close
  佐证就消失：FAIL；若 controller 已被证明 dead/absent/stale，则把合法 direct path 单独
  分类，不能伪装成 graceful pass，也不能仅因没有 handshake 就归因成 candidate defect；
- terminal 后 execution-private socket 仍可连接或 `lsof` 仍报告 holder：orphan FAIL；
- 任何证据只能来自生产路径、无法限定在 test-slot-2：停止并报告，绝不扩大作用域。

## Non-goals

- 不修改 FLY-1269 production source 或 tests；
- 不在 qa-sandbox 合并/发布生产代码；
- 不验证 FLY-1269 之外的 generic Codex、Claude single-session 或 Auto-QA 全矩阵；这些由
  FLY-1269 原测试与 PR CI 负责，本 E2E 只做必要回归抽样；
- 不以终端截图、自报文本、stage label 或单一 SQLite snapshot 作为最终证明；
- 不在 phase 完成后人为关闭 Design/Implement；它们必须活到 issue terminal。
