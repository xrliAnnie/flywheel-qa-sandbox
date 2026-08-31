# FLY-2169 socket 直连 Codex runner 在 cmux 零可见 — 实施计划

Issue: FLY-2169 (https://linear.app/geoforge3d/issue/FLY-2169/可见性-socket-直连-codex-runner-在-cmux-零可见-founder-主观察窗照不到-implement-段一晚四问)
日期: 2026-08-29
基于: research.md

**Status**: codex-approved(R7,2026-08-29;R1-R6 反馈全部吸收,R5 起 deletion-oriented 收敛)

## 0. 一句话

把 codex 体的 founder cmux 窗口从「寄生在 `codex resume --remote` TUI 健康上的交互终端」
(当晚 47 次 DIED immediately,6 窗全灭)换成「Bridge 自己拥有的只读 transcript tail」:
spawn 并发开窗、创建即向 comm.db 注册真实窗口名、事件流实时落盘渲染、终态窗口处置与
claude 体**完全同构**(普通非-timeout 终局 adapter 不杀 — 成功交 Blueprint 杀 / 失败留
诊断;timeout 与 closeout/pin 兜底在 adapter 就地杀,见 §4.3)— 窗口出生与
codex binary / rollout 时序彻底解耦;终局现场的永久留痕载体是 transcript 文件本身。

## 1. 目标(对 issue 四条要求的映射)

| issue 要求 | 本计划的落点 |
|---|---|
| 1. spawn 时开窗,canonical 命名,内容 = goal/transcript 实时 tail | 窗口 attempt 与 daemon spawn **并发**发起(命名沿用现有 `sanitizeTmuxName(ctx.label)` = `FLY-XX-role-...`),内容 = `tail -F transcript.log`;transcript 由 app-server 会话流(`onNotification`)增量渲染落盘 |
| 2. 窗口生命周期与体绑定 | 与 execute() 生命周期同扣:spawn 并发开窗;终态处置走 issue 允许的「按既有 close 规则」分支 = 与 claude 体同构(普通非-timeout 终局 adapter 不杀:成功交 Blueprint 既有规则杀 / 失败留诊断,失败窗由 `HeartbeatService.checkStaleCompleted` 既有 StateStore 谓词收;timeout 与 closeout/pin 失败 → adapter 就地杀窗,§4.3);终局现场由 transcript 文件永久留痕 |
| 3. comm.db 写真实窗口名 | 窗口创建成功即 `pinCommDbSessionWindow`(现有函数,只提前触发时机);`runner-flywheel:pending` 存续时间从「永远」缩到秒级 |
| 4. founder 在 cmux 点开 implement 段能看到工人在说什么 | transcript 渲染含 agent message 全文、tool call 摘要、turn 边界、goal 状态;窗口 header 含 execId/issue/goal/socketPath/threadId 元数据(无干预命令,见 §2) |

## 2. 非目标(诚实边界)

- **不修探活轴**:`probeRegistered`/patrol/zombie-scan 的判定逻辑归 FLY-2155。本单只保证
  tmux_window 写真名 + 生命周期规则让 pane 轴不产生新误判(见 §4.4);
- **不提供窗口内打字干预**:tail 窗口只读。header **不再打印**手动 `codex resume --remote`
  命令(R1 #6:该命令本身携带 active-writer fork 隐患,且干预是非目标)— header 只留
  execId/issue/socketPath/threadId 元数据,需要干预的操作者自行组装并自担风险;
- **不动 claude / antigravity / kimi 体**的窗口机制;
- **不处理 Bridge 进程自身崩溃**留下的残窗(既有 crash-reaper/patrol 按 comm.db 轴收割,
  与 claude 体同待遇);
- **不修既有 reap 谓词缺口**:`StateStore.getStaleCompletedSessions`(:8781)不含
  `timeout` 状态。对窗口这不构成泄漏 — claude 与 codex 的 adapter 都在 timeout 终局
  就地杀窗(FLY-86 / 本单 §4.3 R6 对齐);缺口只影响 session 行的其他清理语义,
  既有行为,不归本单(R4-R6 review 发现,建议另开 issue);
- **不保证 notification 全集美化渲染**:白名单外事件降级为紧凑单行,协议演进不黑屏。

## 3. 变更清单

| # | 文件 | 变更 |
|---|---|---|
| 1 | `packages/claude-runner/src/codex-transcript-sink.ts`(新) | transcript 渲染 sink:`renderCodexNotification`(纯函数)+ `CodexTranscriptSink`(append 串行队列、header、轮转、fail-open) |
| 2 | `packages/claude-runner/src/codex-runner-tui-window.ts` | 新 `RunnerTailWindowSpec` + `buildRunnerTailCommand`(`exec tail -F <path>`);`ensureRunnerTuiWindow` 骨架(session ensure / purge / settle / kill)按新 spec 复用;删除 resume-TUI 专属命令构造 `buildRunnerTuiCommand` 及 spec 中 threadId/codexHome/socketPath 字段(见 §7 dead code) |
| 3 | `packages/claude-runner/src/CodexTmuxAdapter.ts` | 窗口 attempt 与 daemon spawn 并发;`onNotification` 接 sink(心跳保留);teardown 按 §4.3 规则;threadReady 后 setThreadScope + 追加 threadId 元数据行 |
| 4 | `packages/claude-runner/src/index.ts` | 导出面同步 |
| 5 | `packages/flywheel-comm/src/db.ts` | `updateSessionTmuxWindow` 返回修改行数(R1 #1;better-sqlite3 `prepare().run().changes`;调用方零破坏 — void → number) |
| 6 | 相关测试(见 §5) | 新增 + 改造 |

R5 后**撤销**的改动(deletion-oriented 收敛,理由见 §4.3):`Blueprint.ts` 成功路径杀窗
gate、`adapter-types.ts` 的 `windowRetention` 字段、`HeartbeatService` 跨账本候选并集、
CommDB stale 枚举 helper — 终态处置改为与 claude 体同构后全部不需要。

零改动自动受益:issue-display attach(FLY-923 前缀校验)、`onTuiWindowLost/Restored`
告警通道(触发面收窄为真 tmux 层失败)。

`flywheel-comm` 侧的最小必要改动(R1 #1):`updateSessionTmuxWindow` 返回是否真的更新了行
(better-sqlite3 `prepare().run().changes`),供 pin 报告成功;`%:pending` 语义与 schema 不动。

**终态窗口的生产收割者是 `HeartbeatService.checkStaleCompleted`**(24h 阈值 / 6h sweep,
canonical teardown 路径),不是 `cleanup.ts`(它只在 legacy `run-issue.ts` 启动路径与独立
脚本被调用,且只收 completed/timeout — failed/blocked 是 FLY-1066 有意的 crash-preserve
契约,本单不动它)。R5 收敛后本单**不改**收割者任何代码 — codex 失败窗口落进它既有的
StateStore 谓词,与 claude 体同构(R1 #2 / R5)。

## 4. 详细设计

### 4.1 transcript sink(新模块)

```ts
// codex-transcript-sink.ts
export interface CodexTranscriptSinkOptions {
  path: string;              // codexSessionStateDir(execId)/transcript.log
  maxBytes?: number;         // 默认 5MB,超限 rename -> .1 后重开(tail -F 实测无缝跟随)
  maxQueuedBytes?: number;   // R1 #5: append 队列字节上限(默认 1MB),超限丢弃 + 落
                             // "── output dropped (backpressure) ──" 可见标记
  closeDeadlineMs?: number;  // R2 #3: close() flush 有界(默认 5s)— 卡死的 fs 写不得
                             // 拖住 teardown;超时放弃 flush 并 log truncation
  fsOps?: {                  // R2 #3 / R3 #2: 注入 seam(测试 5/9/16/21 的实现基础,
    appendFile; rename;      // 不用模块 mock)。mkdir 在内 — 父目录
    stat; mkdir;             // (codexSessionStateDir(execId))由 sink 自建(recursive),
  };                         // header 不因目录缺失静默丢失(R3 #2,测试 23)
  render?: typeof renderCodexNotification; // R3 #2: 渲染器注入(默认真实现;测试 9 的
                                           // throwing renderer 走这里)
  log?: (m: string) => void; // fail-open:任何写失败只 log,绝不 throw 进 run
}
export function renderCodexNotification(method: string, params: unknown): string | undefined;
export class CodexTranscriptSink {
  writeHeader(meta: { executionId; issueId?; label?; cwd; objective?; socketPath? }): void;
  setThreadScope(threadId: string): void;    // onThreadReady 设定;换代际时更新
  appendMeta(line: string): void;            // threadId / daemonPgid / restart / 终局行
  onNotification(method: string, params: unknown): void; // 过滤+render → append(串行队列)
  close(finalLine?: string): Promise<void>;  // flush + "── run ended: <status> ──"
}
```

**intake 安全边界**(R1 #5,全部进单测):

- **thread 归属过滤**:daemon 可为 foreign thread 发通知(client 注释明示)。带
  threadId/turn 归属的 scoped 事件只在匹配 `setThreadScope` 当前值时落盘;scope 尚未
  设定(threadReady 前)时 scoped 事件缓冲或丢弃(落一行 pre-thread 标记);不带归属的
  unscoped 事件(如 goal 级)按白名单落全局行;
- **no-throw 总边界**:`onNotification` 整体 try/catch(渲染/appendFile/logger 任何异常
  吞掉只 log)— `handleFrame` 调回调无保护,sink 异常不得逃进协议层;心跳与 sink 各自
  独立包裹,一方异常不影响另一方;
- **终端控制序列消毒**:落盘前剥离 ESC/CSI/OSC 等控制字符(保留 `\n` `\t`)— raw 文本
  可能携带能操纵 founder 终端的序列;
- **背压有界**:见 maxQueuedBytes。

**adapter 侧注入通道**(R3 #2):CodexTmuxAdapter 的 deps(现有 `ensureWindow` 等所在的
注入对象)新增 `transcriptSinkFactory?: (opts: CodexTranscriptSinkOptions) =>
CodexTranscriptSink`(默认真实现)— 测试 16/21 经此把 never-resolving/throwing fsOps
从 adapter 层注入,不做模块 mock。

渲染规则(`renderCodexNotification`,纯函数):

- 白名单美化:`turn/started` / `turn/completed`(分隔行 + 时间);item 完成类事件 —
  agent message **全文**、reasoning 摘要行、command/tool call 一行(命令 + exit)、
  file change 一行;goal 状态变化;
- 丢弃:token_count、delta/流式增量类(高频噪音);
- 未知 method:`[<method>] <params 单行 JSON,截断 500 字符,消毒后>` — 保底可见;
- 实施第一步用真 daemon 采样确定确切 method 名集与归属字段形状
  (reference_real_codex_daemon_qa_harness 的 dist 拼真 app-server 方式),白名单以采样
  为准,本节列的是渲染类别契约。

### 4.2 窗口:命令与时机

- `buildRunnerTailCommand({ transcriptPath })` → `exec tail -F "<transcriptPath>"`
  (`SAFE_PATH` 校验沿用;`exec` 顶掉 shell,pane 进程即 tail);
- CodexTmuxAdapter.execute() 顺序变为(R1 #3:开窗**绝不 gate** daemon spawn —
  `ensureSessionWithRetryAsync` 最长 210s,await 它会把 fail-open observer 变成
  runner 启动依赖):

```
registerCommDbSession (pending)          # 不变
→ sink 建文件 + writeHeader              # 新(同步、本地 fs,毫秒级)
→ 异步发起窗口 attempt(不 await)        # attemptOpen 链启动;deadline 锚点 = 此刻
→ runtime spawn(daemon)立即开始          # 不变;onSpawnIdentity → sink.appendMeta(daemonPgid)
   (窗口 create 异步 commit 时 → wireCreated(现有):pin comm.db 真名(见 §4.3 pin 报告)
    + persistSessionWindowState + restored 回调)
→ onThreadReady → sink.setThreadScope(threadId) + appendMeta(threadId)   # 不再触发开窗
```

- **FLY-1239 重试链的保留/删除边界**(R1 #6 精确化):
  - 保留:attemptOpen 单飞链、退避表、`retryable-hold`/`retryable-transient-ipc` 分类、
    deadline 机制、lost/restored 上报;
  - 删除:rollout-race 专属的语义(`window_died` 归因文案)、threadReady-gated 触发、
    threadReady fallback 补窗(:1013-1030);
  - **persisted episode 迁移**:`tuiWindowEpisodeStartedAt` 是 resume-TUI 时代的 episode
    锚,旧值会让升级后的执行体直接判 deadline 已过、跳过新窗口尝试 — observer 路径
    **不读取旧值**,spawn 时无条件重置(写新值);
  - **lost 触发条件放宽**:现 `emitTuiLost` 要求 `threadReadySeen || outcome?.threadId`,
    spawn 即开窗后改为「窗口 attempt 已发起且未成功」即可上报(threadReady 之前的失败
    也要可见);
- daemon 同账号重启(restart+resume)不动窗口(窗口 tail 的是文件,与 daemon 代际无关);
  sink 追加一行 restart 标记,`setThreadScope` 随新代际 threadId 更新。

### 4.3 teardown 规则(替换现状「两分支无条件 killWindow」)

现状:controlledShutdown 分支(:1137)与 ordinary 分支(:1195,"terminal-window-first"
是 resume TUI 连着 daemon socket 的遗留约束)都先杀窗再 closeout。tail 窗口不连 socket,
约束消失。**在两个既有分支内就地修改**(R1 #4:不重排 FLY-1269 的 heartbeat /
credential scrub / request-bound ack / phase-controller 顺序),窗口相关步骤的新次序:

```
finally(每分支内,其余既有步骤原位):
  1. runtime stop + drained 确认            # 先停源头 — 通知不再产生
  2. sink.close("run ended: <status>")      # 后关 sink — 终局事件已入盘(R1 #4);
                                            # 有界:flush deadline(默认 5s,R2 #3)超时
                                            # 放弃 flush、log truncation,teardown 继续
  3. comm.db closeout(updateSessionStatusIfRunning → completed/timeout/blocked)
  4. 终态窗口处置(R5/R6 收敛 — 与 claude 体同构,含 timeout 规则):
     → **timeout 终局**:closeout 后 killWindow — 与 TmuxAdapter 的 FLY-86 规则一致
       (:1077-1111,timeout 后就地杀 zombie 窗口;transcript.log 保留)(R6 #1);
     → closeout 成功 且 pin 曾报 ≥1 行 且非 timeout:adapter **不杀窗**(删除现
       两分支对这些终局的无条件 killWindow)。处置权交既有下游规则,与 claude 体
       (TmuxAdapter)完全一致:
       · 成功 → Blueprint 既有成功路径杀窗(:2910-2913 / :3039-3042,不改);
       · 失败/blocked → 窗口留作诊断现场(Blueprint 失败路径本就不杀),
         由 HeartbeatService.checkStaleCompleted 既有 StateStore 谓词收割;
     → closeout throw 或 pin 报 0 行(注册缺失,账面无法标终态):killWindow 兜底 —
       防「session=running + pane 永活」的探活误判面(run 结果不受影响 —
       可见性 fail-open 契约)
```

- **为什么撤销 R1-R4 期间的留痕证明/所有权契约**(R5 决策):R4 的「CommDB read-back
  留痕」需要 Blueprint 跳杀契约(windowRetention)+ 跨账本 reap 对齐,R5 又暴露该并集
  需要跨 CommDB 枚举 provider + close 链新 authority — 评审条数 1→3 回涨,机制在生长。
  泄漏角落(StateStore 丢终态)的真实代价只是「一个窗口多留几天」,而 transcript
  文件已经是终局现场的永久载体(`codexSessionStateDir(execId)/transcript.log`,
  不随窗口消失)。与 claude 体同构后:任何 reap 缺口都是**既有**系统行为(§2 边界),
  本单零新增回收机制;
- `pinCommDbSessionWindow` 改为**报告成功**(底层 `updateSessionTmuxWindow` 返回
  `prepare().run().changes` 行数 — better-sqlite3;0 行 = 注册缺失 → 兜底杀窗)
  (R1 #1 / R2 #2);
- late in-flight create 的清理(attemptAtTeardown join + cleanupLateWindow)保留。

### 4.4 探活契约(FLY-2155 接缝,写死在代码注释与本文档)

- codex 体的 pane 从此是 **observer(tail)**:`pane_dead` 轴对 codex 仅在 §4.3 规则
  正确执行的前提下近似成立(pane 活 → 「体活 或 已落账终态」);
- FLY-2155 若需要真进程轴:`codexSessionStateDir(execId)/session.json` 的 `daemonPgid`
  已持久化,transcript header 同样打印 — 消费点现成;
- 本单落地后,「daemon 活着干活但 probe 假失联」类误判(pending → discover → pgrep 兜底
  失配)直接消失,FLY-2155 的修复面变小。

## 5. TDD 测试计划

RED → GREEN → REFACTOR,vitest,owning package = `packages/claude-runner`。

**新 `codex-transcript-sink.test.ts`**
1. 白名单事件渲染快照(turn 边界 / agent message 全文 / tool call 单行);
2. token_count/delta 丢弃;未知 method 降级单行 + 500 字符截断;
3. header / appendMeta / close 终局行;
4. 轮转:超 maxBytes → rename `.1` + 重开,追加继续;
5. fail-open:injected fs 抛错 → 不 throw,只 log;
6. (R1 #5)foreign-thread scoped 事件拒收;scope 未设时 scoped 事件的 pre-thread 政策;
7. (R1 #5)终端控制序列消毒(ESC/CSI/OSC 剥离,`\n` `\t` 保留);
8. (R1 #5)队列饱和:超 maxQueuedBytes 丢弃 + dropped 标记落盘;
9. (R1 #5 / R3 #2)注入 throwing logger + 注入 throwing `render` → onNotification
   不外抛(渲染器经 options.render seam 注入,非模块 mock)。

**`codex-runner-tui-window.test.ts`(改造)**
10. `buildRunnerTailCommand` 构造 + SAFE_PATH 拒注入;
11. 骨架行为(ensure/purge/settle/kill)在 tail spec 下不回归(现有用例换 spec);
12. `buildRunnerTuiCommand` 删除后的编译面清理。

**`CodexTmuxAdapter.test.ts`(改造 + 新增)**
13. (R1 #3)窗口 attempt 在 runtime 启动前/同时**发起**且不 await:tmux ensure 挂起
    (永不 resolve 的 injected ensure)时 daemon spawn 不被延迟;
14. 窗口创建 commit → comm.db `updateSessionTmuxWindow` 真名;pin 0 行(注册缺失)
    被记录并导致 teardown 走杀窗兜底(R1 #1);
15. `onNotification` 同时打心跳 + 进 sink,任一方 throw 不影响另一方(R1 #5);
16. (R1 #4)teardown 顺序:runtime drained **之后** sink.close(drain 前一刻入队的
    通知必须已 flush 落盘);
17. (R1 #1 / R5/R6 收敛)终态处置矩阵,期望值钉死:timeout → 杀(FLY-86 同构)且
    transcript.log 保留;closeout 成功 + pin ≥1 行 + 成功/失败/blocked → 不杀
    (处置权归下游);closeout throw → 杀;pin 0 行(注册缺失)→ 杀;
18. controlledShutdown(phase 退休)同规则,且 FLY-1269 ack 顺序不变(现有用例不回归);
19. threadReady → sink.setThreadScope + threadId 行;restart 代际 → scope 更新;
20. (R1 #6)persisted `tuiWindowEpisodeStartedAt` 旧值不被读取:带过期旧值的状态文件
    下,新执行仍发起窗口 attempt;threadReady 之前的 attempt 失败也触发 lost 上报;
21. (R2 #3)never-resolving 注入 append:sink.close 在 closeDeadlineMs 内返回(log
    truncation),CommDB closeout 与 FLY-1269 ack 不被延迟;
22. (R3 #2)state 目录不存在时 sink 自建父目录(fsOps.mkdir recursive),header 落盘
    不静默丢失;mkdir 失败 → fail-open(log,后续 append 同样 fail-open)。

**集成断言**(R5 同构验证):codex adapter 的 result 形状(tmuxWindow 返回值)与
claude 体一致地流经 Blueprint — 成功路径窗口被 Blueprint 既有逻辑杀掉(现行为,
不回归);失败路径窗口留存且 result.tmuxWindow 保留。不需要改 Blueprint 或其测试。

**全仓门**(FLY-224/248 教训):`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`
(注意 reference_pnpm_packages_gate_aborts_before_teamlead:失败即停,确认 teamlead 包
真的跑过)。

## 6. QA / 验收

1. **真 daemon 采样**(实施第一步):dist 拼真 `codex app-server`,采集 notification
   method 全集 → 定稿渲染白名单(进 PR);
2. **E2E(真环境形状)**:spawn 一个 codex phase runner(qa harness),验证:
   - spawn 后 ≤10s `tmux list-windows` 出现 `FLY-XX-...` 窗口,pane 进程 = tail,且
     daemon spawn 时刻不晚于无窗口对照组(开窗不 gate);
   - comm.db `tmux_window` = `runner-flywheel:@N`(非 pending);
   - 窗口内容随 goal 推进滚动(turn 边界 + agent message 可读,无控制序列穿透);
   - 终态矩阵(R1 #2 / R5/R6 收敛):成功终局 → Blueprint 杀窗(与 claude 体一致);
     timeout 终局 → adapter 杀窗(FLY-86 同构)且 transcript.log 保留;
     失败/blocked 终局 → 窗口留作诊断 + comm.db 终态;transcript.log 在两种终局后都
     完整存在(终局行可读);closeout 人为致败的对照组走杀窗兜底;
3. **founder 验收面**:cmux 点开 implement 窗口能读到工人当前输出(issue 要求 4)。

## 7. Dead code 与删除面(founder 红线:只删不加)

- `buildRunnerTuiCommand` + spec 的 threadId/codexHome/socketPath/codexBin 字段:唯一
  消费者是 CodexTmuxAdapter,切换后删除(连同其注入校验用例)。**不保留**等价的手动
  resume 命令输出(R1 #6:非目标 + active-writer 隐患,见 §2);
- `resolveWindowId` 等骨架保留(仍被 wireCreated 用);
- threadReady-gated 开窗路径(fallback `outcome.threadId` 补开窗,CodexTmuxAdapter:1013-1030)
  删除 — spawn 并发开窗后无意义;
- persisted `tuiWindowEpisodeStartedAt` 的 resume-TUI 语义废弃:observer 路径不读旧值、
  spawn 无条件重置(R1 #6 迁移决策);
- 两分支终态的无条件 killWindow 删除(§4.3 — 兜底分支保留);
- 净变化:模块 +1(sink),机制 -4(rollout-race 开窗门、threadReady fallback 补窗、
  manual-resume 命令面、终态无条件杀窗),跨包契约 +0(R5 撤销了 windowRetention /
  Blueprint / HeartbeatService 改动),脆弱面(codex TUI 健康依赖)-1。

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| notification 格式演进 → 渲染劣化 | 未知事件降级单行,永不黑屏;白名单纯函数,改动成本一行级 |
| transcript 写放大 | 白名单 + 轮转 5MB;实测 rollout 61 item ≈ 渲染 <200KB |
| closeout 失败 + 窗口留存 → 探活误判 | §4.3:closeout throw / pin 0 行即兜底杀窗;探活契约(§4.4)写进代码注释 |
| foreign-thread / 控制序列 / 背压 | §4.1 intake 安全边界(过滤 + 消毒 + 有界队列 + no-throw) |
| 旧 persisted episode 抑制新窗口 | §4.2 observer 路径不读旧值,spawn 重置 |
| tail 不在 PATH(极端) | ensureWindow settle 验活捕获 → 走现有 lost 告警,run 不受影响(fail-open 契约不变) |
| 卡死的 fs 写拖住 teardown | sink.close 有界 deadline(R2 #3),超时放弃 + log truncation |
| timeout 终局窗口无人收 | 不存在 — timeout 由 adapter 就地杀窗(FLY-86 同构,§4.3);StateStore 谓词缺口只余 session 行语义,§2 边界 |
| 回滚 | 单 PR,revert 即回 resume-TUI 现状;无 schema/数据迁移 |

## 9. 交付物

- 实施 PR(base=main,branch `fix/FLY-2169-codex-tail-window`),含上述代码 + 测试;
- milestone 文件 `engineering/doc/milestones/FLY-2169.md`(PR 最后一条 commit,不碰 CLAUDE.md);
- 部署:随 00:00/12:00 班车,不投重启票(FLY-1959)。
