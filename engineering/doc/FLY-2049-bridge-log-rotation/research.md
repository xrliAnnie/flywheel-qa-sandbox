# FLY-2049 Bridge 日志轮转真运行 — 调研
Issue: FLY-2049 (https://linear.app/geoforge3d/issue/FLY-2049/infra日志-bridge-日志轮转未生效部署后-bridge-日志-94106mb-持续增长无任何轮转产物-查根因并让轮转真跑起来)
日期: 2026-08-25
基于: exploration.md

## 1. 结论

根因链已经闭合：

1. launchd 在 Bridge wrapper 启动前打开 `/tmp/flywheel-bridge.log`；wrapper `exec` Node 后，Node 继承长期 file description；
2. FLY-1887 只建设了 per-append rename helper，并在源码中明确排除 long-lived launchd FD；
3. Bridge 的三条非测试启动链都没有持续 size check/reopen owner，其中 daily-standup 与 R4 还会绕过 canonical wrapper；
4. 所以部署 SHA 已含 FLY-1887 并不构成主日志轮转，106 MiB 且零产物是现有代码的确定结果；
5. 外部 rename 后旧 FD 继续写 `.1` 的隔离 harness 已复现，排除了“补 timer”这条假修复。

采用的修复是：**Bridge 进程内部把正常 JS stdout/stderr 变成同步、每次短 FD 的 rotated append；raw fd 1/2 进入每次启动截断的 startup capture，uncaught stack 回写主日志；日志层所有 failure 均保持 Bridge 在线，并用固定大小 state marker + 外部周期提醒留证。**

## 2. 权威代码链

### 2.1 canonical launchd 路径

| 层 | 权威文件 | 当前行为 | 修改后 |
|---|---|---|---|
| service spec | `scripts/lib/supervisor.sh` | stdout `/tmp/flywheel-bridge.log` | spec 不变，兼容已安装 plist |
| wrapper | `scripts/flywheel-bridge-wrapper.sh` | preflight 后直接 `exec node/tsx` | 导出 main/startup/marker env，exec 前用 `>` 截断 raw-startup capture |
| entry | `scripts/run-bridge.ts` | 第一条应用日志直接走继承 FD | 先安装 rotating stdio + uncaught monitor，再 dynamic import 其余 runtime |
| writer | `packages/config/src/log-rotate.ts` | `appendRotatedLogSync` 已有且逐次 open/close | 新 strict result 模式增加 no-follow、symlink/stall 可见性 |

不能只改 plist：本节点部署后 updater 未必立即重装用户 plist，且旧 plist 仍会打开主日志。wrapper 最终 exec 前的 `exec > "$raw_startup" 2>&1` 会关闭继承的主日志 FD。单个 `>` 在每次启动时重建 capture，所以 crash loop 始终只保留最后一次 module/tsx/V8/native stderr，而不是跨重启无限 append。

### 2.2 daily-standup 自救路径

`scripts/daily-standup.sh:77-79` 在 health down 时直接 `nohup node/tsx >> /tmp/flywheel-bridge.log`。保留它的 packaged/monorepo 双 seam，但为命令显式导出与 canonical wrapper 相同的 main/marker absolute defaults，并把 nohup raw fd 用单个 `>` 指向独立的 daily startup capture。state root 使用 set-u 安全的 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state`，保留 host config；canonical wrapper 写 `bridge-startup.log`，daily 写 `bridge-startup-daily.log`，避免 daily fallback 截断仍在线 wrapper owner 的 capture。

### 2.3 R4 trial 路径

`scripts/r4/r4-window.sh:435` 是短时迁移 trial，不是 production owner。它当前直接污染主日志，并用启动前行号切片；若生产日志在 trial 第一条写时轮转，旧行号会让 stormwatch 漏读。

R4 改为每次 window 的独立 `R4_TRIAL_LOG`：trial 仍启用同一 rotating writer，但 stormwatch 只读自己的文件，cleanup 删除该有界 fixture。结构测试钉住它不再重定向生产主日志。

### 2.4 测试/操作路径

`scripts/test-deploy.sh` 等 QA 入口使用自己的 fixture/log 重定向，不是生产 `/tmp/flywheel-bridge.log` owner。手工 `npx tsx scripts/run-bridge.ts` 在没有 `FLYWHEEL_BRIDGE_LOG_PATH` 时保持原终端行为，避免单元测试或开发命令暗写生产日志。

## 3. rotating stdio adapter

新增 `packages/config/src/rotating-stdio.ts`，不另造第二套 rotation 算法。

### 3.1 API

```ts
installRotatingStdio({
  logPath,
  maxBytes,
  keep,
  stdout,
  stderr,
  onWriteError,
}): () => void

installRotatingStdioFromEnv({ env, stdout, stderr }): (() => void) | undefined
```

- `logPath` 未配置时返回 `undefined`，保留原 stdout/stderr；
- max/keep 复用 `DEFAULT_LOG_MAX_BYTES`（10 MiB）与 `DEFAULT_LOG_RETENTION`（3）；
- env 出现非法 max/keep 时安装仍成功，改用 default；安装完成后通过 bounded 主日志写一次降级诊断；
- adapter 保存绑定后的 original writes；每次成功写调用 strict short-FD append 并返回 `true`；只有 `typeof callback === "function"` 时才用 microtask 触发；
- `rotation_stalled` 只关闭当前进程后续 rotation attempt，当前与后续 bytes 仍以 no-follow short-FD 写入 active；其它 write failure 才置 failed latch 并降级到 original raw-startup stream；两类 failure 都只调用一次 `onWriteError` 写 bounded marker，不退出 Bridge；
- restore 函数带 closed latch，只执行一次；恢复后旧 closure 即使被持有，也走 original write，不会在 close 后 re-entry。

测试注入 fake stdout/stderr，生产传 `process.stdout` / `process.stderr`。不使用 `NODE_OPTIONS` preload：preload 会被 Bridge 拉起的 Node 子进程继承，可能劫持 Codex/Claude stdout 协议。

### 3.2 阈值语义

现有 helper 的权威语义是“写入前若 active 已达阈值，则 rotate，然后完整 append 当前 chunk”：

- 不在行/chunk 中间切割，因此单条日志不会跨 generation；
- active/每代最多可能比阈值大一个 write chunk；下一次 write 触发轮转；
- 生产 106 MiB 文件会在 Bridge 启动后的第一条日志前立刻变成 `.1`，第一条新日志进入小 active；
- 若一个单独 chunk 本身大于 10 MiB，它会完整落一代而非被切开。这是证据完整性优先的明确 tradeoff。

消费者按 oldest generation → `.1` → active 搜索。默认 active + 3 代，不新增 gzip 依赖。

### 3.3 并发与 FD 语义

`appendRotatedLogSync` 每次 append 都重新 open，rotation 用 mkdir lock 串行化 generation rename。Bridge strict 模式在每次 write 验证 active 是 regular non-symlink，并用 `O_NOFOLLOW | O_APPEND` 打开；rotation due 时还验证 generation surface。可能出现的第二个 Bridge（daily 与 launchd 启动竞态）仍不会长期持有主日志 inode。

短暂 lock contention 继续 fail-open，下一次 write 重试。锁回收同时接受 stale directory 与 stale regular file（默认 mtime ≥5 分钟），但拒绝 symlink/FIFO。rotation due 时，任何 unsafe generation 都先被原子改名为 `<generation>.corrupt.<pid>.<ts>`，不跟随 symlink、不删除内容，然后继续轮转。若 active 已达到 `2 × maxBytes` 且仍无法轮转，adapter 将 rotation latch 为 disabled，但当前与后续 write 继续 short-FD append；bounded marker 保持存在，外部 liveness probe 首次立即提醒、之后每 60 分钟重醒，Bridge 始终在线。

主路径与 `.1` 在 write 返回后都没有 producer-held FD。与 sidecar 方案不同，不需要 process-lifetime owner claim、孤儿检测或启动握手。

## 4. raw stderr、崩溃证据与失败可见性

wrapper 必须在所有 port/PID/restart-storm 防线之后才用单个 `>` 截断 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/bridge-startup.log` 并 exec，因此 duplicate `already-healthy` invocation 不会启动第二个应用 writer。安全路径仍要求 absolute、non-symlink directory parent 与 existing regular non-symlink capture；若这些检查失败，wrapper/daily 不再退出，而是不碰 unsafe target、把 raw fd 降级到 `/dev/null` 并继续启动。正常高流量日志不走 raw FD；它只保留 adapter 安装前/以下层级诊断。正常安全路径每次启动截断，始终留下最后一次启动证据。

Node 的 `console.*`、`process.stdout/stderr.write` 与 warnings 都经过 adapter；但默认 uncaught stack 直接写 raw fd 2。`run-bridge.ts` 因此：

1. 只静态 import logging adapter；
2. 安装 adapter 与 `uncaughtExceptionMonitor`；
3. 再 dynamic import config/teamlead/edge-worker runtime；
4. monitor 在 Node 默认 raw stack/exit 前同步把 origin + stack 写进 bounded 主日志。

rotation/write failure 只覆写 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/bridge-log-rotation-error.json`（临时文件 + rename，内容截断、0600、固定上限），不退出 Bridge。marker 不是 append log，不会随日志量增长，也不在下一次 boot 时自动清除；external liveness probe 在 Bridge 健康时仍会对它首报、小时重醒，人工清 marker 后发 all-clear。operator copy 同时指向主日志、raw-startup capture 与 marker：wrapper dirty-exit、external liveness down、daily startup failure、`deploy_failed` alert-kind copy。

持续 `rotation_stalled` 不再触发 launchd respawn 或 restart-storm hold。Bridge 保持在线并继续写 active；operator 根据 marker 检查 fresh lock/权限/I/O 根因，清除故障后在正常部署窗口重启以重新启用 rotation，再用 `/health`、`.1` 与 active 复验。unsafe generation 已由代码 recoverable quarantine；陈旧 ordinary-file/directory lock 会在 5 分钟后自动回收。不得在 Bridge 仍在线时删除/移动 active。

## 5. side-log 审计

| 日志 | 是否需要有界 | 是否纳入本 PR | 原因/后续方向 |
|---|---|---|---|
| Bridge | 是 | 是 | Node 应用日志，可安全在自身入口安装同步 writer |
| cmux watcher | 是 | 否 | Bash producer、stable-bin 无 Node 依赖合同；应另做 shell/launchd-native reopen 设计，并先消除双重 `>>` |
| Codex infra-bot Lead | 是 | 否 | TUI/子进程 stdout 带协议与交互语义；需按 backend 明确区分 UI stream 与 audit log，不能继承全局 patch |

这不是把已确认的大日志留成“没看”：本单给出生产大小、open-FD 根因和为什么不能共用 Bridge adapter。Lead 通过 handoff question `aabcbf7c-14ce-4b74-9ce6-236a0e174537` 建立族单 **FLY-2056**，分两节承接 cmux watcher 与 infra-bot，按 founder freeze 留账不派；FLY-2049 milestone 两处都引用 FLY-2056，不在 Bridge 修复里混入两套生命周期改造。

## 6. TDD 与正向证据

### 6.1 RED

1. `packages/config/src/__tests__/rotating-stdio.test.ts` 先 import 不存在的 adapter；
2. 故意用 80 B threshold 连续写四段，当前没有 `.1` 且 producer write 仍走 fake stream；
3. callback 缺省、write failure marker callback、invalid env fallback-to-default、strict symlink/stall、restore/re-entry 契约先红；
4. `scripts/__tests__/flywheel-log-rotate.test.sh` 新增 dist-level live producer 与三入口 wiring guard；
5. packaged seam 与 R4 结构测试先钉住 truncate-on-start raw capture/env/trial-log placement，而不是只 grep 函数名。

### 6.2 GREEN 正向 proof

shell harness 启动真实 Node producer，阈值 80 B，分段写入大于阈值的序号 payload：

- `.1` 出现时 `kill -0 $pid` 仍成功；
- 主文件在轮转点回落，轮转后 sentinel 位于 active；
- 等 producer 结束后，generation oldest→active 拼回与 input `cmp` 完全相等；
- `lsof` 证明 producer 没有持有 active 或 `.1`；
- normal-path raw-startup capture 只有 launcher/startup 诊断，不含高流量 payload；另一个 crash harness 证明 uncaught stack 同时出现在主日志，module-resolution failure 则保留在 raw-startup capture。

这条测试直接执行构建后的 `flywheel-config/dist`，而不是只断言源码“看起来接上了”。

### 6.3 2026-08-25 实跑证据

`bash scripts/__tests__/flywheel-log-rotate.test.sh` 最终为 **14 passed / 0 failed**。故意把真实 Node producer 灌过阈值后的证据为：

```text
[PROOF FLY-2049] pid=87620 online=true active_inode=592419304 active_bytes=367 archive_inode=592419293 archive_bytes=528 holders=none sentinel=active
[PROOF FLY-2049] generation_cmp=identical expected_bytes=895 actual_bytes=895 raw_startup_bytes=0
[PROOF FLY-2049] uncaught_exit=1 main_stack_bytes=138 raw_stack_bytes=234
```

这三行同时证明：同一 PID 在线时 `.1` 已出现且 active 回落；active/archives 没有长期 holder；oldest→active 字节级重组无丢失/重复；轮转后 sentinel 继续进入 active；正常流量不泄入 startup capture；uncaught stack 在主日志与 Node raw stderr 两侧都可查。另一个 module-resolution fixture 证明 bootstrap 前错误只进入 truncate-on-start capture。

strict failure marker 的独立 fixture 实测为 3161 bytes、mode `0600`、regular file、JSON 可解析；marker parent 不存在或 marker 自身写失败时，次生错误被吞掉，Bridge 仍继续启动/运行。

### 6.4 gate 结果与未改基线失败

| gate | 结果 |
|---|---|
| `pnpm lint` | exit 0；仅仓库既有 warning/info，改动文件无新增 lint 错误 |
| `pnpm -r build` | exit 0 |
| `pnpm --filter flywheel-config test:run` | 671/671 passed |
| 四个规定 shell gate | log rotate 14/14、packaged seams 17/17、R4 PASS、wrapper fail-loud 18/18 |
| `package-onboard.test.sh` | 默认 npm cache 因宿主 `~/.npm` root-owned file 报 EPERM；改用 `/private/tmp/fly2049-npm-cache` 后 27/27 passed |
| `pnpm test:packages:run` | **exit 1，不标 PASS**：未改的 macOS real-Terminal tests 在无 GUI/XPC runner 上失败；并行全仓运行还触发 teamlead/claude-runner 默认 5–15s timeout 与 Vitest `onTaskUpdate` worker timeout |

为了把实现回归与宿主/负载问题分开，随后做了顺序和定向复核：core 排除唯一 real-Terminal 文件后 19 files / 219 tests passed；19 个其余 package 顺序执行中各包断言通过，teamlead 最终汇总 719 files / 9567 tests passed，失败集中在 8 个未改 test files 的 timeout、一个 `~/.npm` EPERM 和一个 worker RPC timeout；这些失败文件缩小重跑后 FLY-1998、inventory、shell publish、StructuredInboxRouter、Bridge scaffold 均通过，给慢测试提高仅本次命令 timeout 后 terminal archive 22/22、Claude profile 3/3 也通过。未改的 `createLeadRuntime-preflight.test.ts` 在单文件默认 timeout 下仍有 2/4 失败；本 PR 未修改其 production/test 文件，也不把它伪报成通过。

### 6.5 attempt 2 fresh gate（2026-08-25 17:09 PT）

| gate | 结果 |
|---|---|
| `pnpm lint` | exit 0；仅仓库既有 warning/info |
| `pnpm -r build` | exit 0，22 个 workspace 拓扑完成 |
| `pnpm test:packages:run` | exit 1；未改 `packages/core/test/tmux-viewer.macos.test.ts` 2 条 real Terminal/osascript 用例因当前 runner GUI/XPC connection invalid 失败；同次 config 673/673 通过 |
| FLY-2049 shell | log rotation 14/14、packaged seams 17/17、probe 31/31、wrapper 18/18、R4 PASS、launchd 3/3 |

fresh 正向 producer 为 PID 64968；`.1` 528 bytes、active 367 bytes，轮转时进程在线，active/`.1` 无长期 FD，oldest→active 895 bytes 与 expected 895 bytes 逐字节一致，post-rotation sentinel 位于 active。

## 7. 设计审查 R1 findings 处置

| finding | R2 处置 |
|---|---|
| cmux bin closure unmanaged | cmux 不纳入 Bridge Node adapter；无 installer/converge 新依赖 |
| single-writer invariant unenforced | 不再依赖 sidecar 单写者；daily 改 truncate-on-start raw capture + adapter，R4 改独立 trial log，三入口有 placement 测试 |
| autostart path / Node dependency | 不改 cmux autostart，不新增其 Node 依赖 |
| packaged-seams exec sentinel | adapter 位于 `run-bridge.ts`/config dist；stub 仍只记录最终 node/npx，新增 env/raw-startup 断言而不放松旧 sentinel |
| stdout pipe crash-tail | 完全移除 pipe；每次写同步 append；uncaught monitor 在默认 raw stack 前留证 |
| rotator liveness | 无 sidecar；failure 覆写 bounded marker、Bridge fail-open，external probe 在线首报并小时重醒 |
| wiring grep placement | tests 验证 run-bridge 调用先于首条 log、wrapper redirect 先于两条 exec、daily 两分支、R4 trial path |
| infra-bot enabled branch | infra-bot 不修改；避免扩大 XPC fixture/行为面 |
| PR body mismatch | PR body 单独写 Summary/Test plan/Linear link/正向证据，不把 research.md 冒充 PR body |
| midline split | 不拆 write chunk；文档明确“一代可超阈值一个 chunk”与读取顺序 |
| writer re-entry after close | restore 使用 closed latch；旧 closure 在 restore 后只走 original write |

## 8. 设计审查 R2 findings 处置

| finding | R3 处置 |
|---|---|
| fallback log unbounded/undetected | 正常 full-rate output 不走 raw FD；raw-startup 用单个 `>` 每次重建；stall 后仍写主日志；failure marker 由 probe 周期提醒 |
| optional callback fatal | `typeof callback === "function"` 才排 microtask，并新增 bare `process.stdout.write` case |
| silent rotation fail-open | active 保持 `O_NOFOLLOW`；unsafe generation recoverable quarantine；2× stall marker + hourly reminder、Bridge 在线 |
| malformed env kills Bridge | invalid numeric env 使用 default，并在 adapter 安装后写一次 bounded diagnostic |
| deferred side logs unowned | Lead 已建合并族单 FLY-2056（两系统分节），milestone 引用该 ID |
| existing readers | R4 使用 trial log；FLY-1586 evidence reader按 `.3 → .2 → .1 → active` 聚合 |
| stale XPC test text | 删除；改为 packaged fixture 显式使用 fixture path 并断言真实 `/tmp` 未变化 |
| existing 106 MiB transient peak | milestone 说明旧文件先进入 `.1`，按当前速率约 1.5 天/三轮后淘汰 |

## 9. 设计审查 R3 findings 处置

| finding | R4 处置 |
|---|---|
| `/dev/null` destroys startup evidence | raw fd 改为每次启动单 `>` 截断的 state-dir startup capture，copy/tests覆盖 module failure |
| daily marker unbound | wrapper/daily 使用 set-u 安全的 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/...`，保留 host config |
| dynamic import ordering | placement guard 除 install/console 顺序外，钉住 module-scope package specifier 仅 config logging；其余只能 `import type`/`await import()` |
| stall can hold Bridge down | attempt 2 删除退出路径；stall 只禁 rotation、继续 active append，恢复在正常部署窗口完成 |
| marker helper rethrows | markerPath 缺失短路；marker write 用 catch 吞次生错误，logging failure 不再调度 exit |

## 10. 设计审查 R4 advisories 落地

| advisory | 实现 |
|---|---|
| state root 不得硬编码 HOME | wrapper/daily/探针均用 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state`；fixture 显式传 custom state root |
| raw startup path 需安全 | redirect 前验证 absolute/non-symlink/regular；异常时不碰 target，降级 `/dev/null` 后继续启动 |
| daily 不能截断 wrapper capture | daily 默认改为 `bridge-startup-daily.log`，与 canonical `bridge-startup.log` 分离 |
| hermetic proof 必须覆盖三 path | packaged/monorepo 四个 fixture 都 snapshot stale capture，断言 main/startup/marker env 与 truncate 行为；R4 另验三条 isolated path |

## 10.1 Code review R1 四条 MEDIUM 最终处置（attempt 2）

| finding | 最终处置 |
|---|---|
| startup evidence 被下一次 boot 清掉 | 已修：`run-bridge` 不再启动即清 rotation marker；unsafe raw capture 也不再导致 restart loop。raw capture 正常路径仍只保留最近一次 pre-bootstrap 诊断，marker 作为 durable operator evidence 保留到人工清除。 |
| strict short-FD append syscall 成本 | 接受并保留：这是消除 long-lived inode FD 的正确性代价；当前已消除日志洪水，10 MiB 阈值下实测产量低。若 profiler 显示显著 CPU/I/O，再单独做批量 writer，不在本次可用性返工中引入 buffer/crash-tail。 |
| world-writable `/tmp` unsafe generation 可杀 Bridge | 已修：`.1/.2/.3` 的 symlink/non-regular entry 原子改名为 `.corrupt.<pid>.<ts>`，target 不被跟随，随后继续轮转；任何 quarantine I/O failure 也不会退出 Bridge。 |
| stale rotate lock 可造成 crash loop | 已修：5 分钟 stale directory 与 regular-file lock 都可 identity-checked reclaim；fresh/不可回收锁到 2× 后只停 rotation、继续写 active，并由 marker + probe 周期提醒。 |

## 11. 会过期的结论

| 结论 | as-of | 过期条件 | 重核 |
|---|---|---|---|
| `appendRotatedLogSync` 是 10 MiB / 3 代、per-append short-FD helper | commit `fe795ecbe` | config helper 改造 | `packages/config/src/log-rotate.ts` + tests |
| Bridge 非测试主日志入口是 wrapper、daily、R4 | commit `fe795ecbe` | 启动链变化 | `rg -n '/tmp/flywheel-bridge.log|run-bridge' scripts` |
| packaged run-bridge import 会重写 config dist 路径 | commit `fe795ecbe` | payload compiler 变化 | `po_compile_run_bridge` + package-onboard tests |
| cmux stable-bin closure没有 Node runtime 新依赖 | commit `fe795ecbe` | cmux installer/converge 变化 | FLY-1577 suites + `flywheel-cmux-install.sh` |
