# FLY-1188 M4d — adapter daemon-mode 接线实施规格 — 实施计划

Issue: FLY-1188 (URL 不可得,只写 issue 号)
日期: 2026-07-12
基于: 同文件夹 plan.md §6(exec-cycle 方案,本文替换其为 daemon-mode)+ t2-daemon-assessment.md(daemon 方向)+ 已建组件 M4a/M4b/M4c-1/M4c-2/M4c-3

> **状态**:M4d 是 FLY-1188 剩下的最后一步。前置的 daemon+cmux 全套组件已写完并逐个 Codex 增量审 APPROVED(103 测)。本规格是「把组件接进 CodexTmuxAdapter」的 eng-buildable 施工图,给一个**能跑 V5(529 真机)的会话**照着执行。M4d 是**破坏性**的(砍旧 exec-cycle)且只能靠 V5 验证 —— 因此本文不在无 529 环境的会话里执行,只作交接图。

## 0. 已建组件(M4d 直接消费,勿重写)

全部从 `flywheel-claude-runner` 导出:

| 组件 | API | 作用 |
|------|-----|------|
| M4a | `CodexDaemonClient` / `runGoalToTerminal` / `GoalRunError` | daemon 客户端 + goal 循环 |
| M4b | `connectDaemonTransport({ socketPath })` / `WsDaemonTransport` | ws-over-unix 传输(**用 socketPath,不用 codexHome 派生**) |
| M4c-1 | `spawnCodexDaemon(opts)` / `resolveDaemonSocketPath(execId)` / `DaemonHandle` | 起 daemon + SUN_LEN 安全短 socket + O_EXCL 锁 |
| M4c-2 | `CodexDaemonGoalRuntime` / `.runGoal(input, events)` / `.stop()` / `.drained()` | 常驻运行时:起→连→设 goal→跨轮→死了换号 resume→收尾 |
| M4c-3 | `ensureRunnerTuiWindow(spec, deps)` / `isRunnerTuiWindowAlive` / `killRunnerTuiWindow` | founder cmux 观察窗(`codex resume --remote`) |

`CodexDaemonGoalRuntime` 已经把 spawn→connect→client→goal→restart/resume 全包了 —— M4d 只需把它 `new` 出来、喂 objective、跑 `runGoal`、终态收尾,**不要**在 adapter 里再手接 daemon/transport/client。

## 1. 改动面(一句话)

`CodexTmuxAdapter.execute()`(`CodexTmuxAdapter.ts:246`)当前是 exec-cycle:`provisionCodexHome` → 建裸 shell tmux 窗 → `injectAtIdlePrompt` 把 `codex exec` 打进去 → exec-cycle 的 completion-signal / parked / reconciler / auto-continue 收尾。M4d 把「建裸 shell 窗 + 注入 codex exec + exec-cycle 收尾」这一段换成「起 daemon 常驻运行时 + 开 cmux 观察窗 + `runGoal` 到终态」。

**保留不动**:`execute()` 开头到 `provisionCodexHome`(`CodexTmuxAdapter.ts:246-292`)—— preflight、`sandboxCwd`/`gitWritableDirs`(FLY-793/1188 sandbox 解析)、`provisionGitHubCredential`(FLY-209)、`provisionCodexHome`(FLY-123)。这些是 daemon 也要的前置(daemon 的 CODEX_HOME = 这个 provision 出来的 home)。

## 2. daemon-mode execute() 骨架(替换 exec-cycle 段)

```ts
// 前置照旧: preflight / sandboxCwd / gitWritableDirs / ghToken / codexHome
const codexHome = provisionCodexHome({ executionId: ctx.executionId, ghToken });
const socketPath = resolveDaemonSocketPath(ctx.executionId); // 短 SUN_LEN 安全路径

// 常驻运行时: 一个 issue 一个,codexHomes = 账号轮换池(429 rotation)
const runtime = new CodexDaemonGoalRuntime({
  executionId: ctx.executionId,
  codexBin: flywheelCodexBin(),
  codexHomes: [codexHome, ...rotationPoolHomes], // M1 已有 discoverAccountPool
  cwd: sandboxCwd,
  socketPath,
  sandbox: "workspace-write",
  approvalPolicy: "never",
  model: ctx.model,
  env: this.buildDaemonEnv(ctx, codexHome), // stripSecretEnv 已在 spawnCodexDaemon 内做
  logger: (m) => this.log(m),
});

// M4c-2 的 runGoal 是「跑到终态」的整轮; goal = issue 目标 + pipeline 合同(§3)。
// 第一轮 startThread → 拿 threadId → 开 cmux 窗(founder 可视)。
// events.onNotification 里第一次拿到 threadId 时 ensureRunnerTuiWindow:
let tuiOpened = false;
const outcome = await runtime.runGoal(
  { objective: buildGoalObjective(ctx), overallTimeoutMs: ... },
  {
    onNotification: (method, params) => {
      const tid = /* threadId from params */;
      if (tid && !tuiOpened) {
        tuiOpened = true;
        ensureRunnerTuiWindow({
          tmuxSession: this.sessionName,
          windowName: ctx.label ?? ctx.issueId, // FLY-272 Linear identifier
          codexHome, socketPath, cwd: sandboxCwd, threadId: tid,
          codexBin: flywheelCodexBin(),
        }, { log: (m) => this.log(m) });
      }
      // M3 CodexJsonlRenderer 降级为兜底(TUI 本体即可视); 保留不删
    },
  },
);

// 终态收尾: 关窗 + 停 daemon + 等真退出
killRunnerTuiWindow({ tmuxSession: this.sessionName, windowName: ctx.label ?? ctx.issueId });
runtime.stop();
await runtime.drained(); // 观察 SIGKILL-unconfirmed(极罕见)
return this.mapOutcomeToAdapterResult(outcome); // outcome.result.status → route
```

**要点**:
- `threadId` 从 goal 通知流第一次出现时开窗(不是 spawn 时 —— thread 还没建)。M4c-2 的 `runGoal` events 会透传 `onNotification`;从 `notificationThreadId(params)` 取 threadId。
- goal 通知流(`onGoalUpdate`)可喂给 M3 的 pane 渲染兜底(exec-cycle 回退路径若保留)。TUI 本体已是真可视,渲染降级。
- 终态映射:`outcome.result.status === "complete"` → 正常完成;`blocked/usageLimited/budgetLimited` → 按现有 route(usageLimited/budgetLimited 是协议级配额信号,见 t2 §5.1,1188 不特殊处理,当 blocked 类走);`GoalRunError kind timeout/setup_failed/goal_replaced` → 失败 route(`complete --route blocked`)。

## 3. goal objective = issue 目标 + pipeline 合同

`buildGoalObjective(ctx)` 把现有 Blueprint 提示词(issue + role + pipeline 规则 + gate 说明)组成一条 `/goal` 的 objective。**关键**:objective 里要含 Baseline Rules 的 pipeline 契约(onboard→brainstorm gate→plan→implement→PR→approve gate),这样 daemon 的 /goal 自主推进时按合同走 gate。gate 本身仍走现成 `flywheel-comm gate`(blocking,daemon /goal 内执行,等 mailbox/gate 响应 —— 机制无关,见 t2 §4)。

## 4. §6 exec-cycle 删除清单(破坏性 —— V5 绿后才做)

plan §6 的四件整体作废(daemon 原生常驻取代):
- 6.1 completion signal 重写
- 6.2 parked 状态机
- 6.3 codex-session-reconciler
- 6.4 auto-continue

对应 adapter 里 exec-cycle 的:`injectAtIdlePrompt` 的 codex-exec 注入、done-marker 轮询、parked/resume 循环、auto-continue 触发。**删前先 `ls` 出所有引用点,列 newly-unreachable,按 CLAUDE.md dead-code hygiene 逐一确认再删**(FLY-1188 exec-cycle 有 FLY-123/209/245/793 的历史约束缠在里面 —— 逐个核,别连带删掉 sandbox/credential 前置)。

## 5. M2 契约改文字(V5 绿后 —— 契约只述已存在能力)

M2 的 AGENTS.md/提示词里现在写的 exec-cycle 语义(「exit 是 pause point」「done marker 触发下一轮」等)改成常驻语义(「/goal 自主跨轮推进直到终态」「daemon 死了自动 resume」)。**硬约束(Lead)**:契约只能写当前已存在的能力 —— 所以这步必须在 daemon-mode 真接上、V5 验过之后做,不能提前写「常驻」而代码还是 exec-cycle。

## 6. V5 验收清单(529 隔离真机 —— Lead 硬前置)

Lead 原话:『先在 529 隔离验「真常驻多轮 + founder cmux 可视」,验绿再铺全队』。V5 checklist:
1. 529 隔离起一个 codex runner(daemon-mode),真 dispatch 一个小 issue。
2. **真常驻多轮**:观察 daemon /goal 自主跨轮推进(≥2 turn),不是一轮就停 —— pane/log 里看到多个 turnId + tokensUsed 递增 + 真 active→complete。
3. **founder cmux 可视**:Annie 在 cmux 窗里能真看到 `codex resume --remote` 的 TUI 跑,不是快照渲染。
4. daemon 死了(杀进程/换号)→ 自动 resume 同 thread 续跑(V2 已隔离验过机制,V5 验产线形态)。
5. gate 流(brainstorm/approve)在 daemon /goal 内正常等 Lead 响应。
6. 终态回收:issue 完成 → 关窗 + 停 daemon + 干净退出(无孤儿 daemon/socket/lock —— M4c-2 已单测,V5 验真机)。
7. 资源:单 runner 常驻约 145MB(t2 §3),并发观察是否撞 OOM 前科(7-10 事故),终态立即回收。

V5 全绿 → 才做 §4 删除 + §5 改文字 → 收口成**单 PR**(Lead 硬要求)→ 停 founder ship gate → **绝不自 merge**。

## 7. 排序建议(已上报 Lead,待其拍板)

M4d 是破坏性 + V5-bound,而 V5 要 529 真机环境。已上报 Lead 两条路:(a) 先架 529 V5 环境(或派真机 QA),M4d 接线 + 删除 + 改文字都在能跑 V5 的会话里做;(b) 现在就接 M4d(接受没法从当前机器验 V5,风险自负)。默认走 (a) —— 不拿能跑的 exec-cycle 做没法验的实验(Lead『绝不拿全队做实验』)。

## 8. 实施记录(M4d DONE — Lead 拍板『实现后走 529』)

Lead 回复(gate 4a81885c):『进 M4 实现,go … V5(Annie 的 cmux 可视验收)实现后走 529』。据此在本会话完成 M4d 全部四段(单 PR、都在 branch、未 merge),V5 是 merge 前的下游真机门。

- **M4d-1(0c0d29ab)delivery-mechanism 更正**:design 说 writable-roots 经 config.toml 下发;实测 `codex app-server --help` **支持 `-c/--config` override**(例子 `-c 'sandbox_permissions=[...]'`)。改用 exec-cycle 那套已验证的 `-c sandbox_workspace_write.writable_roots=[...]` + `network_access=true` 发到 daemon spawn(`buildDaemonSandboxArgs`)——不碰 config.toml 表(seed config.toml 声明的是顶层 `sandbox_mode` 不是 `[sandbox_workspace_write]` 表,append 会撞 TOML 重定义)。**比 design 更干净、且与 exec-cycle 同机制**。
- **M4d-2a(42b976a0)纯 helper**:`buildGoalObjective` / `buildDaemonSandboxWritableRoots` / `notificationThreadId` / `classifyGoalOutcome`(13 测)。
- **M4d-2b(9e95efc2)execute() 换 daemon 模式**:砍整段 exec-cycle(runCycle/injectAtIdlePrompt/idle-gate/done-marker/awaiting_gate/gate_timed_out/parseThreadId/findAnsweredMarker);保留 provision 前置 + P5 scrub + CommDB vendor=codex + onTmuxWindowCreated。runtime+window 注入(`CodexDaemonAdapterDeps`),18 daemon-mode 测替换旧 exec-cycle 测;全 claude-runner 453/453 绿。**§4 的 exec-cycle 删除已在此完成**;plan §6 的 parked/reconciler/auto-continue 是 **Bridge 侧共享基建**(claude runner 也用),**非 codex 专属死码,不删**。
- **M4d-4(671aacff)M2 契约改文字**:`codex-runner-contract.md` v1→v2,exec-cycle 语义(`codex exec` 进程 / exit 是 pause point / 别常驻 / END YOUR TURN)→ 常驻 /goal 语义。**保守选择**:gate 仍 `--no-block` + `check` 轮询(常驻模式原生支持、V5-safe),**不引入未验证的 turn 内 blocking-gate**。

### MVP 边界(V5-refinable,均不改 execute() 形状)
- **账号轮换**:单 home `codexHomes=[codexHome]`(daemon restart-resume 在单账号成立)—— **Lead 批准单-home MVP**(gate bc7667df);跨账号 429 池 = **fast-follow FLY-1202**(独立多-home provisioning,不阻塞核心 resident /goal,不改 execute() 形状)。
- **daemon codexBin**:`flywheelCodexBin()`(承 WS-B);shim-vs-raw 对长驻 daemon 的交互 = V5 观察项。
- **resultText**:daemon GoalRunResult 无 lastMessage,`resultText` 暂空(exec-cycle 有);如 DecisionLayer 需要 PR 摘要,从 notification 抓 last agentMessage = follow-up。

## 6′. V5 验收清单(修订 —— 头号 gate 提前)

**#1(make-or-break,先验)**:daemon runner 在 **linked worktree 里能 `git commit`** —— 即 `codex app-server` 真把 `-c sandbox_workspace_write.writable_roots` 应用到它 spawn 的 thread。单测 mock 不了,**纯真机**;若 NOT honored,改的只有 spawn 层(`buildDaemonSandboxArgs` 换 delivery),execute() 重写不动(风险已收敛在 delivery 层)。

其余同 §6 原 1–7(真常驻多轮 / founder cmux 可视 / 换号 resume / gate 流 / 终态回收无孤儿 / 资源 OOM 观察)。全绿 → 单 PR → founder ship gate → 绝不自 merge。

## 9. Codex M4d review 遗留 punch-list(R1 修完 / R2 又开的真缺口)

Codex 增量审两轮(xhigh,thread 019f53f9)。R1(commit 4da0441f 修完)6 HIGH+2 MEDIUM 全是砍 exec-cycle 丢的不变量。**R2 又判 CHANGES,更深**——Codex 真读了 `check.ts` / `respond.ts` / Blueprint 真派发链,发现几处**运行时契约级**缺口。分两类:

### 深层(要设计决定,V5-capable 会话 + Lead 拍板才闭合)
1. **gate 超时对 polling runner 不可见**:watcher 把 DB question `resolveGate()` 了,但 runner poll 的 `flywheel-comm check` 只查 *response*,resolve 后仍返 `pending` → runner 永远看不到超时;fail-open 不能继续、fail-close 不能停 goal。且 24h overall budget 早于默认 48h gate deadline。**需求**:改 `check` 让它透出「timed-out(fail-open→continue / fail-close→stop)」的解析,或另设 runner-可见的超时信号。协议改动,要设计。`check.ts:18`。
2. **crash-recovery resume 只写不读**:`session.json` 生产无读者;Blueprint 建 adapter context 时没传 `previousSession`(codex 路径)。单测直接注入 `previousSession` 绕过真链路 → Bridge 崩后新执行拿不到 threadId,resume 不成立。**需求**:Blueprint 派发链读 `session.json` → 传 `previousSession.threadId`(codex-tmux 分支);且处理『崩后遗留 daemon 占同 socket』(daemon 随 Bridge 死 → stale socket 可 reclaim,需真机确认)。`Blueprint.ts` context 构造。
3. **codex 提示词还有一堆 exec-cycle 残留**:总说明 / `question` checkpoint / generic checkpoint / approve 标题都还讲 `END YOUR TURN` + 承诺自动 resume;还有 identity test 仍断言 `END YOUR TURN`。R1 只改了 brainstorm + approve-step-c 两处。**需求**:全量扫 codex 分支 → 全部改常驻 polling;更新 identity test 断言。

### 浅层(清晰可修,任何路径都要,durable 到 branch)
4. **周期 heartbeat**:新 adapter 只启动时 `onHeartbeat` 一次;长任务 / 48h gate 会 stale,monitor 可能把活 daemon 当 orphan。需给 runGoal 传 notification/heartbeat callback,或起周期 heartbeat。`CodexTmuxAdapter.ts:315/413`。
5. **drained() 失败时 CommDB 别写 `completed`**:AdapterResult 已失败(HIGH-6),但 finally 里 CommDB 仍按 timedOut 写 completed → 清理/路由层把未确认退出的 daemon 当已结束。用含 teardownError 的判定写 status。`CodexTmuxAdapter.ts:444`。
6. **watcher 查 `answeredAt` + `seen` 顺序**:`respond` 保留 marker 并写 `answeredAt`;watcher 到 deadline 会把**已回答**的 gate 误 resolve+删+发 gate_timed_out。且 `seen` 在 DB op 成功前就加 → resolve 失败也永久停重试+删 marker。需先查 answeredAt 跳过,`seen` 挪到成功后。`respond.ts:158`。
7. **launch-commit 挪到 goal-set 之后**:`onThreadReady` 在 `setGoal`/`startTurn` 之前触发;此时写 commit 后崩 → dispatcher adopt 一个没 goal 的 thread。且 commit 写失败被吞、`committed` 已 true。需把 commit point 挪到 goal 真设上之后,写失败不吞。`codex-daemon-goal-runtime.ts:382`。
8. **MEDIUM TUI restart 恢复**:`tuiOpened` 首次成功后永久 true;daemon restart 后 `onThreadReady` 重触发但不查 pane liveness / 不重建因旧 socket 关闭而退的 remote TUI。需 restart 时探 pane + 需要时重开。

**结论(接 §7 排序 + 9a16feab)**:R2 的深层三条印证『M4d 破坏性、成不成靠 V5 + 设计决定』——不是这台不能验 V5 的机器盲修能收口的。branch 作 durable WIP 保留(daemon 全栈 + 两轮审 + 本 punch-list = 真进展);收口放能验 V5 的会话 + Lead 拍那几个设计点。

**punch-list 收口状态(本会话,Lead a098b9d4 授权深层设计决定)**:R2 全 8 条已修 + R3 再审(0 HIGH / 0 MEDIUM / 仅 2 LOW,已清)—— Codex M4d review **3 轮全收敛**。深层三条闭合方式:①gate-timeout 用 `resolveGateOnTimeout` 写 synthetic timeout **response**(`insertResponseIfGateOpen` 原子写 → runner 的 `check` 读 response 看得见,真 Lead 回答 wins 返 raced);②crash-recovery 改成 codex adapter **自持**(`readPersistedThreadId` 读自己的 `session.json` 作 resumeThreadId,不依赖 Bridge 侧 previousSession 布线 —— daemon 是 Bridge child 随其死,自持才对);③codex 提示词全量 sweep + `resumed automatically` 入 `BANNED_IN_CODEX_PROMPT`。测试:claude-runner adapter 24/24 + edge-worker identity/prompt 16/16 + tsc/biome 全绿。

## 10. V5 执行结果(本会话真机跑,2026-07-12)

**Lead a098b9d4**:『机器缓过来了…你自己判 load 安全就上 V5』。load 13/18 核 + 48% mem free = 安全,执行 focused #1-gate 真机验证。

### #1 gate(make-or-break)= **PASS ✅**
harness `scratchpad/v5-writable-roots-gate.mjs` 驱动**真生产 runtime**(`CodexDaemonGoalRuntime`,rebuild 后的 dist 确含 M4d 符号)against 真 `codex app-server --remote-control`(v0.144.1)+ 真 linked worktree + 真 `~/.codex` auth:
- `codex app-server` **真把 `-c sandbox_workspace_write.writable_roots=[...]` 应用到它 spawn 的 thread** —— resident /goal daemon thread 在 **linked worktree**(其 `.git` 元数据在 main repo 下、thread cwd 之外)里 **`git commit` 成功**(commit `53a4228` 落地,`v5-proof.txt` tracked)。这是整个 M4d daemon 设计唯一不能单测的赌注,**决定性通过**。
- `onThreadReady` fired ×1(authoritative own-thread 信号)+ `onGoalActive` fired ×1(goal 确认 SET,FLY-245 launch-commit point)。
- goal 到终态 `complete` / `succeeded:true`(1 turn,20520 tok);完整 notification 流(`thread/goal/updated` → `turn/started` → `turn/completed`)观测到 → **常驻 daemon + goal RPC 协议端到端跑通**;干净 teardown(transport closed by client),daemon(pid 27001)已退,无孤儿 daemon(唯一 `app-server` 残留进程是无关的生产 codex-infra-bot)。

### 其余 V5 项(诚实边界)
- **真常驻 + goal 协议 + 换号 resume 机制**:daemon 常驻、hosted thread、drove goal to terminal + notification 流 = 已真机证;resume(resumeThreadId)路径本 harness 未跑,靠 24 单测 + 自持 session.json 逻辑覆盖。
- **多轮跨真 gate**:本 goal 1 turn 完成(任务简单);常驻 + turn/goal 机制已证,真 brainstorm-gate 多轮未强制触发。
- **founder cmux TUI pane 可视**:本 headless harness 未开 tmux 窗(未接 `ensureWindow`);复用 FLY-350/398 已在生产验过的 `codex resume --remote` TUI 机制(Mufasa 生产在跑),adapter 的 `openWindow` → `ensureWindow` 走同一套。
- 以上两条 ⚠ + resume 由 **PR 后的独立 auto-QA(FLY-579)** 兜底真机全流程,且 **founder ship gate 是终态控制**。

**决定**:#1 make-or-break gate 决定性通过 + Codex 3 轮收敛 + 全测绿 → 按 Lead a098b9d4『收敛后单 PR、HOLD 在 founder ship gate、绝不自 merge / 不自 :cool:』**收口成单 PR**。
