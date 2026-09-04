# FLY-2331 Bridge 异步子进程稳态化 — 实施计划
Issue: FLY-2331 (https://linear.app/geoforge3d/issue/FLY-2331/引擎稳定性urgent-bridge-主线程用-execfilesync无超时跑-adapter-shell-证据收集-approve-的)
日期: 2026-09-04
基于: research.md

## 0. 成功定义

对 Bridge 实际可达的 runtime 做 repo-wide child-process census，而不是只检查 issue
最初点名的文件。`run-infra`、approve、workflow docs、WorktreeManager、Blueprint
readiness 与 Codex adapter 的高风险子进程全部离开主事件循环，并且每个 async
入口都有独立于 stdio `close` 的硬截止。worktree 本地 Git、远端 materialize/fetch、
approve 单步均不超过 120 秒；超时会杀整个进程组、Promise 必定 settle，现有
`RunDispatcher` rejection/finally 清理 inflight lane，不能把一次响亮重启变成永久静默
占槽。

PATH 前置的 70 秒 fake git 运行期间，真 `BridgeEventLoopGuard` 持续收到 heartbeat
且不杀 Bridge；同 fixture 的同步 mutant 必被 guard 杀死。仍有意保留的短同步入口
必须同时具备显式 timeout 与既有 `withSyncOpMarker`，使 stall 当刻进入
`last_sync_op`。FLY-2324 拥有 delivery baseline / divergence 的业务修法；本单只给
这些同步 DB span（首次 5 分钟 heartbeat maintenance 的 baseline/projector/watch/
operations）和 re-adopt 快照加 marker，并在 baseline 后、每项目完整链后 yield，既不改
业务逻辑也不改项目内顺序。Guard 的 60 秒阈值、family 判定、forensic schema 与 SIGKILL
语义不变。

## 1. TDD Task 1 — 加固现有共享 async exec 合同

**RED**

新增 `packages/claude-runner/test/async-exec-file.test.ts`（不与既有
`TmuxAdapter.test.ts` 的 adapter seam 用例重复），覆盖：

- 成功返回 stdout/stderr；non-zero、ENOENT、maxBuffer、timeout 均 reject，error
  保留 stdout/stderr/code/signal/timedOut；
- child 忽略 SIGTERM 时仍在 deadline 内收敛；
- child fork 一个继承 stdout/stderr、在 parent exit 后继续存活的 grandchild 时，
  Promise 也必须在 deadline 内 settle，且整组退出、无 pipe 永久持有；
- timeout 与 parent-exit 后的 stdio drain 都不依赖 `close` 才开始结算；
- 慢 child 等待期间 event-loop interval 持续推进；
- `envMode=replace` 时 child 只能观察调用方显式给出的最小环境，parent 中的
  `GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_SSH_COMMAND` 与 credential-helper 变量均不得
  泄漏；默认 merge 模式保持现有 adapter 行为。

**GREEN**

不新增 teamlead-local duplicate helper；把已生产使用并从
`flywheel-claude-runner` 导出的 `defaultAsyncExecFile` / `AsyncExecFileFn`：

- 从 callback `execFile` **重写为 `spawn`**，同时保持现有 error 的
  stdout/stderr/code/killed/signal shape 与新增 timedOut；继续只接受 executable + argv，
  不启 shell；options 增加所需的 `cwd`、`input`、`maxBuffer` 与
  `envMode: "merge" | "replace"`，默认 UTF-8、1 MiB 上限和 merge；replace 必须原样传入
  调用方环境，绝不与 `process.env` 合并；
- child 以独立 process group 启动；硬 timer 到点对 group 发 SIGKILL，并保证 public
  Promise 不晚于硬 deadline reject；同时分别监听 `exit` 与 `close`：正常成功要看到
  exit+close，timeout/error 的 terminal cleanup 两者都幂等处理，grandchild 持 pipe
  不能阻止 deadline；底层 listener 必须保留到 child handle 终结，Promise 提前
  settle 不能跳过 wait/reap；
- parent `exit` 后只给 stdio 一个短且有界的 drain window；若 `close` 不到，杀 group、
  关闭 pipe 并 fail-loud，绝不无限等待；
- 导出稳定的 timeout/drain error shape 与 sync seam adapter。若调用方显式注入旧
  `ExecFileFn` 而没注入 async seam，adapter 仍走那个 fake，不会偷跑真实 binary。

Bridge consumer 自己持有命名 timeout：`BRIDGE_CHILD_TIMEOUT_MS=120_000` 与
`BRIDGE_GIT_PROBE_TIMEOUT_MS=20_000`；不创建无消费者的第三个常量。

## 2. TDD Task 2 — 异步化 `run-infra` 四个漏斗

**RED**

扩展 `run-dispatcher.test.ts`、`run-dispatcher-fly887-turn-seam.test.ts` 与
`progress-resume.test.ts`：

- `probePhaseRetryBranchTip()` 变为 Promise，但 found/missing/indeterminate 完全保持；
- deferred phase probe 未 resolve 时，TURN/Blueprint 不得越过对应边界；
- TURN 前后仍调用两次，后一次 SHA 仍是 launch 的 authoritative startPoint；
- timeout/ENOENT/exit 128 不得误判 missing；
- restart resume 按 ref 串行读取，不能跨 ref 拼 snapshot，且每个 git read 的
  20 秒 timeout 可观测；
- evidence 与 shell 等待期间 interval 可推进；shell non-zero 仍返回
  `{exitCode != 0}`；helper timeout 后 dispatch rejection 会触发既有 inflight cleanup。

**GREEN**

修改 `run-infra.ts`、`run-dispatcher.ts` 与 `progress-resume.ts`：

1. 删除 `run-infra.ts` 的 `execFileSync` import。
2. evidence/GitResultChecker execFn 委托共享 async runner，timeout 120 秒。
3. Blueprint `ShellRunner` 委托共享 async runner，保留 stdout/exitCode 协议。
4. phase branch-tip probe 用共享 async runner，timeout 20 秒；错误三态不变。
5. `PhaseRetryStartPointComputer` 返回 Promise；dispatcher 的两处 probe 分别 await，
   保持 TURN 前后 fence 顺序。
6. `ProgressResumeDeps` 的 branch reads 允许 Promise，`computeProgressResume` 与
   `computeProgressResumeAcrossRefs` 逐层 async 化；同一 ref 先 resolve immutable commit
   SHA，后续 `ls-tree` 与 `show` **只用该 SHA**（不再重复用可移动 ref name），依次读取
   tree/blob，失败后再进入下一 ref。所有 restart-resume git 步骤显式 timeout 20 秒，
   绝不复制 plan_path → discovered dir → default path 的优先级逻辑。

## 3. TDD Task 3 — approve 默认执行器异步化

**RED**

扩展 `ActionExecutor.test.ts`，不注入 ExecFn 时以 PATH fake `gh` 验证：

- `gh pr list` 与 `gh pr merge` 期间 event loop 可推进；
- 超时/非零退出走 `ApproveHandler` 现有失败响应，不返回 success；
- stdout JSON 与 repo/cwd/argv 形状不变。

**GREEN**

`ActionExecutor.ts` 默认 ExecFn 改用共享 async runner，timeout 120 秒，删除动态
`execFileSync` import。上层注入 seam 不改。`gh pr merge` 远端成功但本地进程在
120 秒边界被杀时，结果本质是 indeterminate，不得在新增文案中断言“必定未 merge”；
恢复动作应先查 PR state 再决定是否重试。

## 4. TDD Task 4 — WorktreeManager Git 漏斗加硬上限

**RED**

在 `WorktreeManager.test.ts` 的 PATH fake git fixture 中：

- 断言 production default 是 120,000ms；测试可注入缩短后的 deadline；
- 忽略 TERM / 留存 stdout grandchild 的 git 到期后 reject，create rollback 仍执行；
- 正常慢调用期间 timer 可推进。

**GREEN**

`WorktreeManager.ts` 的 `defaultExec` 复用共享 async runner，默认 120 秒；config 仅加
测试可缩短的 internal timeout seam，`WorktreeExecFn` 注入协议不变。该 seam 同时承载
本地 `worktree add/prune/remove/list`、branch/config/rev-parse，及 resume rebuild 的
`ls-remote`/`fetch` 网络 Git，因此统一保留 120 秒上限。Task 2 的
`materializeRemoteBranch` 是另一条独立 120 秒远端路径。

## 5. TDD Task 5 — workflow docs Git 全链异步化

FLY-2058 已把 network 步降到 10 秒、local 步 30 秒并在相邻步骤间 yield；本单保留
安全配置、askpass、确定性 ref 与错误文案，仅替换每步内的同步等待。

**RED**

扩展 `packages/teamlead/src/__tests__/workflow-docs-git-stall.test.ts` / integration test：

- 原八步 network ordinal 顺序不变，local/network 等待时 heartbeat 均推进；
- network timeout 仍为 10 秒，local timeout 仍为 30 秒；
- parent 退出但 helper/grandchild 持有 pipe 的 fixture 仍在 deadline 内 fail-loud；
- timeout 后同一 repo 重试收敛、无活 helper/阻塞 lock；
- stdout/stderr/status/timedOut 归一化不变；
- fake child 捕获的环境严格等于现有最小 Git 环境（受限 PATH、locale、禁用 global/
  system config、terminal prompt/optional locks、askpass/token），且不含 parent 的 HOME、
  GIT_DIR、GIT_WORK_TREE、GIT_INDEX_FILE、GIT_SSH_COMMAND 或 credential-helper 变量；
  management cron source/writer 对其 replace-env 合同做同类断言。

**GREEN**

`workflow-docs-git.ts` 的 `execute/run/runNetwork/runOrThrow/...` 改为 Promise 并逐层
await；共享 async runner 的 `input`/cwd 与 `envMode=replace` 支持替代 `spawnSync`，保持
现有最小环境的 hermetic 边界。deadline 杀整个
process group，并在硬 timer 当刻 settle，不等待 `close`。public `WorkflowDocsGit`
接口本来就是 Promise，不改 materializer 合同。

按最新 Lead governance ruling，`workflow-docs-git` 全链 async 化后不再持有 sync-op
marker 文件；改为现有 `EventLoopAttribution.recordSpan` 同形的 async span start/end 合同，
在 `finally` 记录固定 `workflow-docs-git:<subcommand>` label、开始与结束时间。把 FLY-2058
两条 coverage 从“child 内可读 sync marker”改为：注入的 raw recorder spy 对每一步恰收
一组 start/end 参数，异常与 timeout 也在 `finally` end；另用真实
`EventLoopAttribution` + >500ms fake 验证 production long-span 留存。真实 recorder 的
`LONG_SPAN_MS=500` floor 有意丢弃更短的非阻塞 child，不拿毫秒级 fixture 误证 production
归因。`GitWorkflowDocsGit` options 新增 recorder，并在唯一 production construction
`plugin.ts:5796` 显式传入 `eventLoopAttribution.recordSpan`；mount/源结构测试防止 wiring
被遗漏。不能用会立即 clear 的 `withSyncOpMarker(() => Promise)`，也不能把 sync marker
跨非阻塞 await 持有。接受的取舍：async span 只在 finally 写入内存，Bridge 若在操作中途
被外力杀死不会留下 kill-time marker；该路径已不阻塞 loop，kill-time `last_sync_op` 承诺
只适用于仍保留的同步入口。
`workflow-resume-checkpoint.ts` 暂保留其 10 秒同步漏斗与 marker；它嵌在同步
authority predicate，另改 API 才能安全 async 化。

## 6. TDD Task 6 — 补全 Bridge runtime child-process census

**RED**

新增 checked-in repo-wide reachability manifest。生成/校验测试每次重新 sweep
production `execFileSync|spawnSync|execSync` **和所有** `withSyncOpMarker|markSyncOp`
call site，
再从 Bridge composition root 追踪跨包调用；每项按三类 fail-closed：`async+deadline`、
`sync+marker+timeout`、明确不在 Bridge PID 内的 gateway/一次性 CLI/guard-worker
例外。任何新命中未登记即失败，不能再靠手写六文件 grep。行为测试覆盖：

- `Blueprint.ts` 的 ponytail / matt `claude plugin details` 两次 readiness probe；
- `CodexTmuxAdapter` 的 tmux/codex preflight、gh token、两次 git config、window-id 与
  git-dir resolve；
- `design-review-manifest`、`workflow-menu-routes`、`workkind-cutover`；
- management cron source/writer、fleet recovery、runner admission、terminal reaper；
- Bridge 可达的 `flywheel-comm/lead-lease` `getProcessStart/getProcessState/processEnvHas`：
  FleetPoller、lead inbox、Codex lead runtime、Codex lead TUI runtime、`/lead-lease`
  diagnostics 与 self-check route 六类调用边界；
- `TmuxAdapter.defaultExecFile` 的其余默认同步操作；
- 保留的 workflow-resume-checkpoint、tmux scrub、codex TUI/daemon marker。
- `Blueprint → captureRepositoryBaselineSet → flywheel-config git()` 的跨包同步漏斗。

同一 census 还枚举 Bridge 可达 raw `spawn` lifecycle：每一处必须具备 awaited
close/exit、显式 long-lived `onExit` owner，或 detached fire-and-forget 的 error/exit
观察；不允许只有 `unref()` 而没有可审计 terminal contract。

**GREEN — async 路径**

- `Blueprint` readiness callback 改成 Promise-compatible，`run()` 在 event envelope
  前 await；默认 probe 用共享 async runner + 20 秒 timeout，positive-only cache 与
  fallback 语义不变。
- `CodexTmuxAdapter` 保留现有同步 `execFileFn` 这一个 constructor positional seam，不
  扩成 result-or-Promise；加 private Promise adapter，production 的 adapter 调共享 async
  runner，显式注入的旧 sync fake 则由 `Promise.resolve` 提升，不能绕过 fake 偷跑真实
  binary。health tmux/codex、gh token、两次 git config、preflight tmux/codex、
  git-dir resolve 全部 await，固定 10 秒上限；`provisionGitHubCredential` 与
  `resolveGitWritableDirs` 显式 async。唯一例外是
  `wireCreated` 内的 `resolveWindowId`：该 callback 保持同步与原子状态顺序，继续走现有
  seam，固定 5 秒 timeout + fixed marker；测试锁住 resolve 与 `tuiOpened`/CommDB pin 的
  无 await 顺序。app-server 既有 async `spawn` 不动。
- fleet `reconcileOnStartup/runRecover` 改为 async，默认 recover 复用共享 helper +
  120 秒 deadline；每个 batch await recover 后才 reconcile audit。`FleetConsole` 加真正
  的 single-flight mutex：private `reconcileInFlight: Promise<void> | null` 持有完整 pass，
  仅由 owner Promise 的 `finally` 释放；boot 与 30 秒 tick 都显式
  `void ...catch`，第二 tick 在 mutex 被持有时为 no-op。RED 用 deferred recover 证明同一
  batch 不会并发启动两次，rejection 后 mutex 可再次获取。
- `fleet-console.spawnEngine` 与 `WorktreeManager.defaultBgDelete` 保持 intentional
  detached/unref，但补一次性 error/exit observation；fleet 必须覆盖异步 ENOENT，
  不能用 spawn 周围的 try/catch 冒充 error handling。

**GREEN — 有意保留的短同步路径**

- management cron snapshot/writer 现有 provider/writer API 保持同步，本单不重写整套
  management snapshot contract；其 `launchctl/plutil` 默认漏斗加入固定白名单 label、
  10 秒 timeout 与 SIGKILL。source 仍可能在大 plist 集合上累计冻结，这是已知残余，
  但每个当刻均可被 guard 指名；另开 follow-up 做 provider async/cache 化。
- design/menu/workkind/runner-admission/terminal-reaper 各在唯一漏斗包固定 label 并补
  2–20 秒上限；`TmuxAdapter.defaultExecFile` 在未被外层 marker 覆盖时提供固定
  command-family marker，避免其余 adapter sync 调用无名。
- labels 只由组件名与白名单 subcommand 构成，不含 argv/path/URL/token。
- `captureRepositoryBaselineSet` 保持同步合同：Blueprint 调用边界加固定 marker，
  config `git()` 每步加 20 秒 timeout；多 repo 累计预算作为明确残余登记。
- `flywheel-comm/lead-lease.ts` 的三个同步 primitive
  `getProcessStart/getProcessState/processEnvHas` 每个 `ps` 加 2 秒 timeout + SIGKILL，并让
  timeout 成为可区分的 `ProcessProbeTimeoutError`（`processEnvHas` 的 readiness 合同仍归一
  为 `null`）。`processTupleStateWithStart` 把它归为 `sensor_error`，不能归为 dead。
  `processAliveWithStart` 只在 PID/lstart 确认死亡或不匹配时返回 false；timeout 必须向上
  传播为 indeterminate，不能被 catch-all 折叠成 false。
- 两个 authorization consumer 锁定反向语义：FleetPoller materialization 遇 timeout
  直接放弃本轮 evidence write，让上次文件/`last` snapshot 原样保留；carrier write
  authorization 在 evidence freshness、identity digest、instance claim 均已验证后，把
  timeout 记为 `carrier_process_indeterminate` audit 并沿用该 fresh evidence 允许
  passthrough，绝不生成 `carrier_process_stale`、`LeadLeaseDeniedError` 或
  `lead_backend_drift` alert。只有确认 dead/mismatch 仍拒绝。RED 分别断言“旧 evidence
  byte-for-byte 保留”和“timeout 不撤活跃 Codex Lead 写权限”；`processTupleStateWithStart`
  的 sensor_error 阴性对照也保留。
- FleetPoller、lead inbox、Codex lead runtime、Codex lead TUI runtime、diagnostics route 与
  self-check route 的 Bridge 适配边界分别用固定 label 包住同步 probe，label 不含
  pid/lstart/env。diagnostics 最坏会发起约 `5 × configured leads` 次 probe，因此增加
  request-local 20 秒总预算：每次 probe 前检查 monotonic deadline，耗尽即停止并返回
  sensor-unavailable/503，不继续累计到 guard 阈值。行为测试覆盖 route timeout、总预算与
  marker 清理。其余 one-shot CLI 调用同一 bounded primitive，但因不在 Bridge PID 内无需
  marker。

`flywheel-comm` 不得按 package glob allowlist：manifest 必须列出 sweep 命中的每个具体
file/funnel，并从 Bridge composition root 单独判断 reachability。只有逐项证明为 CLI
entrypoint 的命中才可进入 one-shot allowlist；共享 library export 一律继续追踪 caller。

`GitPushRunner` / `ship-preflight` 在独立 gateway 进程；account-heal `*-cli.ts`、build
script 与测试 fixture 是一次性工具；guard worker 在 main loop 已 stall 后同步 `ps`
是取证机制。它们进入 census 的明确 allowlist，不冒充 Bridge main-loop 修复。

### 6.1 当前 census disposition（Lead ruling 锁定）

| funnel | disposition |
|---|---|
| run-infra phase/evidence/shell/resume（4） | async shared runner；probe/resume 20s，其他 120s |
| ActionExecutor gh（1） | async shared runner，120s |
| Blueprint plugin readiness（2） | async shared runner，20s |
| workflow-docs-git spawnSync（1） | async shared runner，10s network/30s local；sync marker 改配对 async span |
| fleet-console recover（1） | async shared runner，120s |
| CodexTmuxAdapter health 2、gh 1、git config 2、preflight 2、resolve-git-dirs 1 | 现有 sync seam 经 private adapter 提升；production async，10s；移除 sync marker |
| CodexTmuxAdapter resolve-window-id 1 | keep sync callback；5s + fixed marker，保持 TUI state 原子顺序 |
| management cron source/writer（2 defaults，多 call sites） | keep sync；每步 10s + fixed marker |
| design/menu/workkind（3） | keep sync；10–20s + fixed marker |
| runner-admission / terminal-reaper（2） | keep sync；现有 2–3s + fixed marker |
| workflow-resume-checkpoint / tmux scrub | keep sync；既有 timeout + marker |
| TmuxAdapter defaultExecFile | keep sync；default 20s + command-family marker |
| codex daemon ps/lsof、Codex TUI/tail | keep sync；既有 2–10s + marker |
| config repository baseline Git（Blueprint transitive） | keep sync；Blueprint span marker + 20s/step |
| lead-lease ps start/state/env（FleetPoller / lead inbox / Codex lead / Codex lead TUI / diagnostics / self-check） | keep sync；每个 ps 2s + Bridge caller fixed marker；timeout=indeterminate，diagnostics 总预算 20s |
| BridgeEventLoopGuard worker ps | worker forensic exception，非 main loop |
| gateway GitPushRunner/ship-preflight | separate gateway process，既有 timeout |
| 其余 flywheel-comm / account-heal / flywheel-cli entrypoints | one-shot CLI，保留 bounded sync；不得覆盖上述 Bridge-reachable lead-lease |
| EdgeWorker legacy GitService / agent-team transport CodexAdapter | 当前 Bridge composition root 不可达；manifest 标 legacy runtime |
| core tmux-viewer | 当前 Bridge composition root 不可达；独立 viewer runtime |

## 7. TDD Task 7 — 非 child 同步热点归因 + 有界 yield，不与 FLY-2324 抢修

2026-09-04 生产证据把 410–444 秒 boot-offset 簇定位为：Bridge 启动耗时 +
`TEAMLEAD_STUCK_INTERVAL` 默认 300 秒的首次 Heartbeat tick + 60 秒 stall threshold。日志
反复以 parked-phase sweep → delivery baseline（有时首个 watch attempt）→ 下一次
`run-bridge Starting` 结束一轮。因此扩展 marker coverage，给以下同步 DB span 固定
label：

- plugin boot/maintenance 与 `HeartbeatService` 的 `getReadoptCandidateSessions()` 快照；
- `checkStaleParkedPhases()` 内部每段同步 candidate materialization 批次（不把 marker
  跨 async await 持有）、`baselineWorkflowDeliveryContracts()` 的 boot 与 maintenance
  span；
- maintenance 六项目循环中每次 `DeliveryProjector.runPass`、
  `DeliveryContractWatch.runPass`、`DeliveryOperations.runPass`（label 只含组件名，不含
  project/path）；
- divergence candidate scan / observation span（仅在不覆盖 FLY-2324 当前改动的边界
  加 wrapper）。

按 Lead 明确授权，在首次/后续 maintenance 的 baseline attempt 结束后，以及每个项目的
完整 `projector → watch → operations` 顺序链结束并关闭该项目 CommDB 后，
`await setImmediate` 让出一次事件循环；项目内三步不拆分、不并发，项目间次序不变，
maintenance single-flight 不变。抽出可注入 scheduler 的最小 sequential-chunk helper；RED
用多个“单 chunk 低于缩放 guard threshold、累计超过 threshold”的同步 busy fixture，证明
无 yield mutant 必 stall，而 production boundary 让 heartbeat 在每个 chunk 间推进，同时
记录的业务调用序列 byte-for-byte 相同。单个 chunk 自身若超过 60 秒仍由上述 fixed marker
精确指名，绝不靠调 guard threshold 掩盖。

不改 StateStore query、episode、uid 或 delivery classification 逻辑。FLY-2324 独占
delivery baseline/divergence convergence；本单只在 `plugin.ts` composition wrapper 与独立
scheduler helper 加 instrumentation/yield。若需要结构性改造，先通过 Lead 协调。marker
测试断言原始文件不存在 path/token，finally 后被清理。

## 8. TDD Task 8 — 70 秒行为回归与负控

新增 `scripts/__tests__/fly2331-bridge-async-child.test.sh` 及最小 child fixture：

1. 创建隔离 temp HOME/STATE_DIR/SYNCOP_DIR/log；禁止读取生产状态。
2. PATH 首位放 fake `git`；先断言调用记录，证明桩真生效。
3. **async arm**：真 guard 在线，fake git 对 spawn/worktree 路径 sleep 70 秒；断言
   child 正常退出、heartbeat 至少推进多个阈值窗口、forensic log 无 terminal stall。
4. **sync mutant arm**：相同 fake git/guard，仅换成 `execFileSync`；断言 child close
   signal 是 SIGKILL、forensic 行存在，且 fake git 调用记录非空。
5. 另有缩放的 process-group arm：fake git fork 持有 stdout 的 grandchild，断言
   deadline 后 Promise 与整组都收敛。
6. **reap arm**：受控短寿命 detached/unref child 写出“即将退出”时间，parent 保持
   event loop 活跃并轮询 `ps`；断言 child 在有界时间内消失。`etime` 只作启动时长，
   不被解释为 zombie age。
7. harness 有总超时、trap 清理、明确分母；任一 SKIP 计失败。

最终实际跑一次 70 秒参数，并把命令、时长与结果写入同目录
`acceptance-evidence.md`。

## 9. Refactor、验证与提交顺序

建议小提交：共享 executor；run-infra+approve；worktree+workflow docs；runtime census
与 marker；70 秒 harness；verification docs。每片严格 RED（记录预期失败）→ minimum
GREEN → refactor，并在批次后更新 progress ledger。milestone 文件必须是 literal last
commit。

## 10. 验证矩阵

统一设置 `VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1`，用
`pnpm --filter <pkg> exec vitest run <files>` 做真正的定向单包测试；分别 build
claude-runner、edge-worker、teamlead，再跑 `pnpm lint` 与本分支新增的每个
`scripts/__tests__/*.test.sh`。按任务专属纪律不运行 `pnpm -r build`、
`pnpm test:packages:run`，并绝不触发 `packages/core/test/tmux-viewer.macos.test.ts`。

最终证据必须包括：

- repo-wide production sync child census 的每一命中都有分类与可执行测试；
- run-infra、ActionExecutor、workflow-docs-git、Blueprint readiness 与 Codex adapter
  除 resolve-window-id 外无同步 child；WorktreeManager async default 为 120 秒；
- 所有保留同步入口 marker + timeout；异步路径不持有 sync marker；
  workflow-docs-git 按 Lead ruling 发配对 async span start/end；
- Bridge 可达 lead-lease 三个 `ps` primitive 每步 2 秒并在六类调用适配边界有固定
  marker；timeout 不得变成 carrier dead/authorization denial，diagnostics 总预算 20 秒；
- 70 秒真时长正/负两臂和 grandchild-pipe deadline arm；
- raw spawn lifecycle census 与短寿命 detached/unref reap arm；
- FLY-2324 所有权文件仅有 instrumentation（若有），无业务逻辑 diff；
- 首次 heartbeat maintenance 在 baseline 后和每项目完整链后 yield，累计同步 chunk 不再
  饿死 guard heartbeat，业务步骤次序完全不变；
- `BridgeEventLoopGuard` threshold/kill 判定无 diff。

## 11. 风险、回滚与不做项

| 风险 | 缓解 / 回滚 |
|---|---|
| async phase probe 改变 TURN 顺序 | 两次 deferred-probe 测试锁前后 fence；Task 2 可独立 revert |
| descendant 持 pipe 让 Promise 永不 settle | process group + hard timer immediate reject + bounded drain + grandchild fixture |
| Promise 提前 settle 后 child 未回收 | terminal listener 保留到 child handle 终结；已知退出时刻的 reap fixture |
| async error 丢 stderr/exit code | Task 1 参数化 error shape；三类上层语义分别测 |
| injected fake 被新 async seam 绕过 | sync→async adapter 与真实 binary 零调用测试 |
| TUI window resolve async 化破坏原子顺序 | 保持 sync 5s+marker；测试锁 callback 内无 await |
| async fleet recover 被 30 秒 tick 重入 | FleetConsole Promise mutex + deferred second-tick no-op/rejection-release 测试 |
| replace-env consumer 泄漏 Bridge 环境 | helper 双模式；docs-git/cron fake child 精确环境断言 |
| liveness sensor timeout 被误判 dead | typed indeterminate；保留旧 evidence；fresh identity/claim 下 audit-allow，不发 drift alert |
| diagnostics 多 Lead 串行 probe 累计过 60 秒 | 每步 2s + request-local 20s 总预算，耗尽返回 sensor-unavailable |
| docs-git span 只在测试 fake 存在 | plugin production wiring guard + 真实 >500ms recorder 测试；短 span floor 明示 |
| delivery yield 引入项目内重入/乱序 | 只在 baseline 后与项目 CommDB close 后 yield；single-flight 保持；调用序列测试 |
| marker 泄露 path/token | 固定/白名单 label，读取 raw marker 做负断言 |
| management cron 仍累计同步预算 | 每步 10 秒+marker；明确 follow-up async/cache，不宣称本单消除该残余 |
| approve 远端成功、本地 timeout | 结果标为 indeterminate；恢复先查 PR state |
| 70 秒测试假绿 | 桩调用前置断言、正负同 fixture、总超时、SKIP=FAIL |

不重启 Bridge/Lead，不部署、不 merge，不改 guard 阈值；不处理 FLY-2328 的 daemon
takeover，也不改 FLY-2324 的 baseline/divergence 业务逻辑。批准后不再修改本 plan。
