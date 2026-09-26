# FLY-2830 Codex 切号器够不到实现节点 — 实施计划
Issue: FLY-2830 (https://linear.app/geoforge3d/issue/FLY-2830/codex-切号器-号打满了活却没切到有额度的号上读数-25-小时没刷新认错当前号切号到不了-implement)
日期: 2026-09-25
基于: exploration.md, research.md

状态：codex-approved（Codex design review R1–R3 正式轮 + R4–R7 限定验证轮，R7 APPROVED；逐轮记录见 §14 与 `design-review/`）。源码基线 `e1fde75c2`（生产 dist `59123848a`，含 FLY-2864/2869/2877）。

## 0. 一句话

让自动切号在生产真正打开（修两处证据链误判；修好后已结束执行体的后台进程也能当场收掉，不再挡住它），让读数不再被竞态跳过，并在每次切号后把全部账号重读一遍（依赖正常时 2 分钟内完成，前提见 §6.3）；读不到的地方写清楚为什么读不到。

## 1. 交付切片

| # | 切片 | 修的根因 | 主要文件 |
|---|------|---------|---------|
| W1 | socket 持有者探针先解析软链 | R1 | `claude-runner/src/codex-daemon-runtime.ts`、`claude-runner/src/index.ts`（导出）、`teamlead/src/bridge/codex-runner-orphan-reaper.ts` |
| W2 | resident 执行体认 TUI 客户端 | R3 | `teamlead/src/codex-quota/host-readiness.ts`、`host-process-snapshot.ts`（只加 argv 数组）|
| ~~W3~~ | ~~已终态执行体 10 分钟可收~~ —— R1 评审后删除，见 §4 | — | — |
| W4 | 占用盘点按自己那次结果作答 | R2 | `teamlead/src/codex-quota/occupancy.ts`、`codex-accounts-observer.ts`、`codex-account-quota-store.ts` |
| W5 | 切号后全量重读 + 页面逐格标注 | R4 | 新 `teamlead/src/bridge/switch-refresh-trigger.ts`、新 `bridge/switch-record.ts`、`account-quota-page.ts`/`account-quota-view.ts`、`account-quota-refresh.ts`、`plugin.ts`；quota-monitor：`account-heal/quota-monitor.ts`、`quota-monitor-state.ts`、新 `account-heal/sweep-request.ts` |
| W6 | 调度一轮也读 Claude 卡/订阅 | 读数新鲜度 | `codex-quota/reading-scheduler.ts` 的调用方（`plugin.ts`）、`account-quota-refresh.ts` |
| W7 | 呈现：到期时分、每行读于几点、读不到的真实原因、Claude 扣费日原因 | R5 | `bridge/account-quota-view.ts`、`bridge/account-quota-page.ts` |
| W8 | 全部 Codex 号打满的中文告警列出各号恢复时刻 | 验收 3 | `bridge/codex-quota-store.ts`（`recordPoolExhausted` 固化快照）、`codex-quota/outbox.ts` |

每个切片先写失败测试（RED），再实现（GREEN）。本机只跑与改动文件直接相关的测试文件，整包交给 CI。**跑任何含 `startBridge` 的 teamlead vitest 前必须 `export FLYWHEEL_CODEX_HOMES_ROOT=<scratchpad 隔离根>`**（否则会用真实 HOME 清掉生产 Codex lease）；排除 `**/tmux-viewer.macos.test.ts`。

## 2. W1 — socket 持有者探针先解析软链

**改动**

- 新纯函数（`codex-daemon-runtime.ts`，**经 `packages/claude-runner/src/index.ts` 从包根导出**，teamlead 按现有方式从 `flywheel-claude-runner` 导入；不做深层 import）：
  ```ts
  export function resolveSocketProbePath(p: string, deps?: { lstat; realpath; stat; uid }): 
    { kind: "plain"; path: string } | { kind: "link"; path: string } | { kind: "untrusted"; reason: string }
  ```
  - `lstat(p)` 不是软链 → `plain`（原路径）。
  - 是软链 → `realpath(p)`；要求 `stat(target).isSocket()` 且 `stat(target).uid === uid`，否则 `untrusted`（`link_target_not_socket` / `link_target_foreign_owner` / `link_unresolvable`）。
  - 其它错误 → `untrusted`。
- `defaultSocketHolderPids`（同步，runtime）：`plain`/`link` 对 `path` 跑 `lsof -t -- <path>`；`untrusted` → `[]`（无证据，维持 fail-closed）。
- orphan reaper 的异步 `defaultSocketHolderPids`：同一个解析；`untrusted` → `{status:"unknown", error:<reason>}`（与现有「lsof 出错」同一处理）。
- 收割器 unlink：只 unlink 我们自己的路径（`resolveDaemonSocketPath` 的那个软链或普通 socket），**不**跟着删软链目标。

**不变量**：可杀对象的判定权不变 —— runtime 侧：持有者 pid 落在 ledger 记录的 pgid，`probeCodexDaemonProcessBinding` 另核 start identity；收割器侧：canonical home、argv socket、fresh pgid、fresh lsof 持有者（收割器今天不核 start identity，本单不改收割器的判定规则，也不改它的 2h 年龄门槛）。解析软链只是让 lsof 找得到它本来就该找到的持有者。

**测试**（`codex-daemon-runtime.test.ts`、`codex-runner-orphan-reaper.test.ts`、`claude-runner` 包根导出测试）

- RED：`resolveSocketProbePath` 纯函数表驱动：普通 socket → `plain`；软链 → 本用户 socket → `link` + 目标路径；软链 → 普通文件 / 他人所有的 socket / 悬空 → `untrusted`（各自 reason）。
- runtime 默认探针与收割器默认探针都**只**通过这个 resolver 选路径（代码审阅点：两处都不再直接对入参跑 lsof）。
- 收割器：`defaultSocketHolderPids` 已是导出的异步函数 —— 真实 socket 集成用例：`net.createServer().listen(<tmp>/real.sock)`、`symlinkSync(real, link)`，断言 `defaultSocketHolderPids(link)` 返回 `{status:"ok"}` 且含 `process.pid`；软链指向普通文件 → `{status:"unknown"}`。CI 镜像须有 `lsof`：实现节点先 `which lsof` 确认；若 ubuntu 镜像没有，该用例只在 darwin 注册并在 PR body 写明（不静默 skip）。
- runtime 接线的真实 socket 回归（不导出私有 helper）：临时 `FLYWHEEL_CODEX_SESSION_DIR` 与 socket 目录下，用 `net.createServer()` 在真路径 listen、在 `resolveDaemonSocketPath(execId)` 处建软链指向它，写一份 ledger 记录当前测试进程的真实 pgid，然后调用公共入口 `probeCodexDaemonLiveness(execId)`（默认 `socketHolderPids`）断言 `alive`；同一 fixture 调 `probeCodexDaemonProcessBinding(execId, {pid: process.pid, startIdentity})` 断言 `bound`。软链改指普通文件 → `unknown` / 非 bound。与收割器用例同一 CI `lsof` 平台策略。三层（resolver、runtime 接线、收割器接线）各有失败测试。
- reaper 软链 socket 孤儿 fixture：走完 pre-signal → after-term → after-kill，after-kill 只 unlink 软链、不碰目标。
- 包根导出测试：`resolveSocketProbePath` 可从 `flywheel-claude-runner` 导入。

## 3. W2 — resident 执行体认 TUI 客户端

**改动**

- `host-process-snapshot.ts`：进程观测多保留 `argv: string[]`（从现有 `command=` 解析，沿用现有空白切分；解析失败则无 argv，按「不认」处理）。不加 `ppid`（没有规则用它）。
- `host-readiness.ts` resident 分支（`:629-689`）改成两遍：
  1. 按 `executionId` 分组。每组先找 daemon：对组内进程逐个调**现有 `residentEvidence` 全链路**（CommDB 在、StateStore 活状态且 adapter=`codex-tmux`、project/role、持久 home 绑定、launch snapshot、最后 `probeDaemonProcessBinding`），第一个返回 `verified` 的就是该组 daemon。组内没有任何进程 `verified` → 整组失败（`resident_evidence_incomplete` + 该组第一个失败 reason），与今天相同。
  2. daemon verified 后，组内其余进程只接受 **TUI 客户端**形状，全部满足才计入：
     - `argv[1] === "resume"`；
     - argv 中 `--remote` **恰好出现一次**、不是 `--remote=…` 形式、后面紧跟一个 token 且该 token **全等** `unix://` + `resolveDaemonSocketPath(executionId)`；
     - 进程 env 里的 `executionId` 全等该组（盘点本来按 `CODEX_HOME` 归 home）；
     - `startIdentity` 非空。
     任一不满足 → `resident_evidence_incomplete`，新 reason `resident_process_unbound`（带 pid）。
- lease 分支、`independent` 分支、`comm_orphan` / stale running 规则一律不动。

**测试**（`host-readiness.test.ts`，resident fixture 用注入的 `residentEvidence`）

- RED：FLY-2874 形状 —— daemon（全链路 verified）+ 客户端（`codex resume --remote unix://<本执行体 socket> -C /wt`，同 exec env）→ home `active`、无阻塞诊断。
- daemon 的 StateStore 状态非活 / launch snapshot 不一致 / persistent home 不一致（任一）→ 阻塞，客户端不能补救。
- 客户端 `--remote` 指向别的执行体 socket、`--remote` 出现两次、`--remote=unix://…`、`--remote` 缺值 → 各自阻塞（`resident_process_unbound`）。
- 客户端 env 执行体 id 不同 → 阻塞。
- 第三种 `ucomm=codex` 形状（例如 `codex exec …`）→ 阻塞。
- 只有客户端、没有 daemon → 阻塞。
- 进程枚举顺序打乱（客户端在前）结果一致。

## 4. W3 — 删除（R1 评审第 2 条）

原计划把孤儿收割器的年龄门槛从「进程 ≥2h」放宽到「执行体终态 ≥10 分钟」。评审指出终态集合的权威与 start identity 门都不牢。改为不做：W1 修好后，执行体结束时的正常收尾（`reapCodexDaemonForExecution`）当场就能证实并收掉 daemon，孤儿本不该出现；2h 收割器只是收尾失败时的兜底，今天的 86434（已 13 小时）在 W1 上线后的第一个收割周期即可被收。代价：若某次收尾失败，readiness 最多被挡 2h + 一个收割周期，届时 `resident_evidence_incomplete` 诊断会指出是哪个 home。列为已知边界（§12）。

## 5. W4 — 占用盘点按自己那次结果作答

**改动**（`occupancy.ts` → `codex-accounts-observer.ts` → `codex-account-quota-store.ts`）

- 显式结果类型：`type OccupancyAnswer = { verdict: boolean | "unknown"; detail?: string }`，`detail` 限定 `^[a-z0-9_:.-]{1,80}$`、不含路径/堆栈。
- 纯函数 `occupancyVerdict(inventory, accountKey, canonical: {known: true; accountKey} | {known: false; detail}): OccupancyAnswer`，逐 key 规则：
  1. `activeUnsharedAccountKeys` 含该号 → `true`；
  2. `canonicalChainActive` 为假 → `false`；
  3. chain 活跃且 canonical 身份已知 → 该号是否等于 canonical 号；
  4. chain 活跃但 canonical auth 读不出身份 → `unknown`（`detail=canonical_identity_unreadable`）——**所有**未被第 1 条证实的号都 unknown，因为不知道活进程拿的是哪个号，绝不能让任何号走隔离 app-server 路径。
- `collect()`：返回值与共享快照的「谁最后开始谁发布」规则不变；切号 runtime 的同步围栏 `isInUse` 仍读共享快照、仍把 unknown 当 in use。
- `guard()`：`const inventory = await this.collect()`，再读一次 canonical auth 身份，返回 `(accountKey) => occupancyVerdict(inventory, accountKey, canonical)`；`collect()` 抛错 → 全部 `{verdict:"unknown", detail:"collector_failed:<code>"}`（`<code>` 取错误的受限原因码，否则 `error`）。
- `codex-accounts-observer.ts`：`refreshInUse` 的类型改为返回 `(accountKey, slot) => OccupancyAnswer`（`isInUse` 选项同步改类型）；`inventory_unavailable` 时把 `detail` 写到读数的新可选字段 `noteDetail`；`refreshInUse` 自身 reject → `detail=guard_failed`。
- `codex-account-quota-store.ts`：`CodexAccountReading` 加 `noteDetail?: string`；**写入前**也跑与读取相同的结构校验（`validReading`，含 `noteDetail` 正则），不合法则整次写入抛错（调用方现有错误路径记 `refresh_failed`），不落盘。
- `plugin.ts` `refreshInUse` 接线处类型随之更新；runtime 的 `accountInUseGuard()` 若仍有调用方，改为映射 `answer.verdict`。

**测试**（`occupancy.test.ts`、`codex-accounts-observer.test.ts`、`codex-account-quota-store.test.ts`）

- RED（竞态回归）：source 用可控 promise；A 开始 collect → B 开始 collect → A 完成 → A 的 guard：在用号（canonical，`canonicalChainActive=true`）答 `{verdict:true}`（今天答 `unknown`）。
- B 后完成且结果不同：A 的 guard 仍按 A 的 inventory 答；共享快照 = B。
- chain 活跃 + canonical auth 不可读 → 非 unshared 的号全部 `unknown` + `canonical_identity_unreadable`；unshared 的号仍 `true`。chain 不活跃 + canonical 不可读 → 全部 `false`。
- collect 抛错 → 全部 unknown + `collector_failed:…`。
- 观察者：在用号走 WHAM 只读路径（注入 `readInUseQuota` 被调用、读数更新）；unknown → `note=inventory_unavailable`、`noteDetail` 与 answer 一致。
- store：含非法 `noteDetail`（如 `<script>`、超长、含 `/`）的写入被拒且文件不变；合法值往返。

## 6. W5 — 切号后全量重读

### 6.1 Bridge：`SwitchRefreshTrigger`（新文件 `bridge/switch-refresh-trigger.ts`）

```ts
createSwitchRefreshTrigger({
  readCodexGeneration: () => number | null,   // store.codexQuota.getRoot(rootKey)?.generation
  readClaudeGeneration: () => number | null,  // accounts.json lastSwitch.generation（复用 consumer 的 readStore）
  refreshAfterSwitch: (reason) => Promise<void>,
  now, throttleMs = 10_000, log,
}): { tick(): Promise<void> }
```

- 首次成功读到某 vendor 的 generation 时记为基线，不触发。之后：**变大** → 更新基线并调 `refreshAfterSwitch("codex_switch" | "claude_switch")`；**合法地变小**（store 重建/恢复）→ 更新为新基线、不触发、记日志；**读失败**（null/抛错）→ 保留旧基线、不触发、记日志。
- 挂在 GatePoller 已有的 tick 上（与 `onAccountSwitchTick` 同处），fire-and-forget，错误只记日志。
- `refreshAfterSwitch(reason)` 两路**互相独立**（`Promise.allSettled`，任一路失败不阻断另一路，尾随轮同样）：
  - 路 A `requestClaudeSweep(reason)`（§6.2）；
  - 路 B `refreshAccountQuotaForSwitch()`：`createAccountQuotaRefresh` 的一个不含 Vercel 的实例，与页面刷新共享同一个 Codex 单飞。
  - 外层「尾随一次」合并：进行中再来请求 → 只记一个 pending，本轮两路都结束后再跑一轮。
- 日志（固定契约）：`[switch-refresh] reason=<codex_switch|claude_switch> codexGen=<n> claudeGen=<n> sweepRequest=<ok|failed:code> wake=<signaled|throttled|unsafe_pidfile|unsupported|identity_mismatch|signal_failed> bridgeRefresh=<ok|failed:code>`。

### 6.2 quota-monitor：全量 sweep 请求

- 新 `account-heal/sweep-request.ts`：
  - 路径 `~/.flywheel/claude-quota/sweep-request.json`（`FLYWHEEL_CLAUDE_SWEEP_REQUEST_PATH` 可覆盖，测试用）；父目录 0700、文件 0600。
  - `writeSweepRequest({reason})`：临时名写入 → fsync → rename（沿用现有原子 store 写法），失败清理临时文件；内容 `{schemaVersion:1, requestId: randomUUID(), requestedAt: ISO, reason}`，`reason ∈ {codex_switch, claude_switch}`。
  - `readSweepRequest()`：先 `lstat`（非普通文件 → 无请求），大小上限 4 KiB；严格校验（未知键 / 非 UUID / 非法时间 / `requestedAt` 在未来 >60 s 或早于 24 h → 视为无请求并记日志）。
- Bridge `requestClaudeSweep` = `writeSweepRequest` + 调一个**专用的** `createQuotaDaemonWaker()` 实例（自带 60 s 限流，不与告警路径的 waker 共用限流窗）。
- `quota-monitor-state.ts`（V2 schema 追加，旧文件兼容）：
  - `lastSweepRequestId: string | null`（UUID 或 null，默认 null）；
  - `lastSweepRequestOutcome: "swept" | "partial" | "blocked_monitor_only" | null`（闭集，默认 null）。
  - 两键都进白名单、默认值、解析、写出与测试；旧 state（无这两键）读成 null。
- 请求模式的「一轮」= 在用号 usage 读数 + 全部应读候选号 sweep（不改它扫哪些号、怎么扫）。结构化结果：
  ```ts
  type SweepRoundResult = {
    active: "updated" | { failed: string };          // projectObservation 的返回值，非 "updated" 即 failed
    candidates: { name: string; outcome: "updated" | { failed: string } }[];  // 只列应读号
    aborted?: "no_active_credential" | "identity_failed" | "identity_mismatch" | "witness_changed";
  }
  ```
  - 「应读号」= 池里、AccountStore 未标 `unavailable` 的非在用号（`unavailable` 是已持久化的操作员终态排除，不算失败，也不读）。
  - 候选号只有 `recordObservation === "updated"` 才算 `updated`；`fetchUsage` 返回 network/rate_limited/unauthorized、凭据校验后仍过期、projection 返回 `stale_generation`/`missing_account`/`invalid_store`/`write_failed`、锁失败，都记 `failed:<code>`。
- `quota-monitor.ts` 每轮开头：`req = readSweepRequest()`；`req && req.requestId !== state.lastSweepRequestId`：
  - monitor-only → 直接 ack，`outcome=blocked_monitor_only`（monitor-only 是最终拒绝，§6.3 的时间承诺不适用于该模式）。
  - 否则本轮 `nextUsageDueAt = now`（先读在用号）并强制 sweep（`:2000` 条件与 `forceSweep` 取或）。scope/model-limit 这类瞬态闸门挡住时不 ack、不计次，闸门解除后重试。
  - 待处理请求的身份与计数一起持久化：`state.pendingSweepRequest: { requestId: string; attempts: number } | null`。读到的 `req.requestId` 等于 `lastSweepRequestId`（已 ack）→ 跳过；不等于 pending 的 requestId（新请求，含覆盖了旧 pending 的情形）→ `pendingSweepRequest = {requestId: req.requestId, attempts: 0}`；等于 pending → 沿用其计数。
  - 一轮结束：`active === "updated"` 且全部候选 `updated` 且无 `aborted` → ack，`outcome=swept`。否则不 ack，`pendingSweepRequest.attempts += 1`（只有该请求**实际跑完**的失败轮才计数；瞬态闸门挡住不计），下一轮（≤60 s 后）重试。
  - 任何 ack（`swept` / `partial` / `blocked_monitor_only`）都写 `lastSweepRequestId=req.requestId`、`lastSweepRequestOutcome`，并把 `pendingSweepRequest` 清为 null。
  - **重试上限 3 轮**：`attempts` 达到 3 仍未全成功 → ack，`outcome=partial`，并把每个失败号与原因写一行日志 `[quota-monitor] sweep_request_partial name=<n> reason=<code>`。上限是为了防止一个坏号让守护进程每分钟全量 sweep 一次（每次都会强制刷新每个候选号的 token）。页面每行「用量读于」照实显示哪几个号没更新。
- state 的 V2 追加键因此是三个：`lastSweepRequestId`（UUID|null）、`lastSweepRequestOutcome`（闭集 `swept|partial|blocked_monitor_only|null`）、`pendingSweepRequest`（`{requestId: UUID, attempts: 0..3}` | null）；都进白名单、默认值、解析、写出与测试。

### 6.3 端到端时间（QA 判据 3 的前提）

| 段 | 依赖正常时 |
|---|---|
| Bridge 看到 generation 变化 | Codex ≤3 s；Claude ≤10 s（trigger 节流）|
| 写请求 + SIGUSR1（专用 waker，每次切号的首次唤醒不会被自己的限流挡住）| ≈0 |
| 路 B：Bridge 全量刷新（与路 A 并行）| 通常 10–30 s；现有 ceiling 90 s |
| 路 A：quota-monitor 请求模式一轮 | 在用号 usage + 身份核对 + 每个候选号（token 校验 + usage），每个调用正常 1–2 s，合计通常 <20 s |

**契约（best-effort，不是硬上界）**：在「SIGUSR1 送达、Anthropic/OpenAI 接口正常响应、没有长时间锁争用」这一前提下，切号后 2 分钟内全部账号读数时间更新。不给 sweep 加硬 deadline（那要改 lock / token 校验 / usage 三处接口，收益不抵复杂度）。前提不成立时：wake 失败会在日志写 `wake=<outcome>`，守护进程最迟 60 s 后自己看到请求；接口慢或失败时按上面的重试规则补读，页面每行「用量读于」照实显示。QA 判据 3 按此前提执行，并在报告里附切号那次的 `[switch-refresh]` 日志行与各号时间戳。

### 6.5 页面必须如实标注「切号后尚未刷新」（Lead 2026-09-25 硬要求；R4 后简化）

只持久化「最近一次切号是什么时候」，不记录刷新过程状态；页面逐格用自己的读数时间对比。刷新失败的表现就是那一格一直没更新，页面照实标出；失败原因在 `[switch-refresh]` 与各观察者日志里。

- **记录**：新 `bridge/switch-record.ts`（纯函数 + 小文件 I/O）。`SwitchRefreshTrigger` 是唯一写者：每次观察到 generation 变大，在触发刷新**之前**写 `~/.flywheel/codex-quota/last-switch.json`：
  ```ts
  { schemaVersion: 1,
    codex:  { generation: number; observedAt: ISO } | null,
    claude: { generation: number; observedAt: ISO } | null }
  ```
  - 只更新变化的那个 vendor 的条目；同一 vendor 只接受 generation 更大（或基线合法回退后的新值）的写入 → 单写者、单调、无并发改写。
  - 写：父目录 0700、临时文件 0600、fsync、rename，失败清理临时文件、记日志、**不阻断刷新**。
  - 进程内兜底：trigger 在调用磁盘写之前，先同步更新进程内的 `latestSwitchRecord`（同样按 vendor 单调）。磁盘写失败时同一进程内页面照样能标注；Bridge 重启且持久化一直失败属于磁盘故障，降级为无标注并留高信号日志 `[switch-record] persist_failed`。
  - 读（`readSwitchRecord()`）：`lstat` 只接受普通文件、≤4 KiB、拒绝未知键；`generation` 为非负安全整数；`observedAt` 为 canonical ISO 且不在未来 >60 s；任一不合法 → 返回 null 并记日志。
- **页面**（不改 renderer 的纯函数性质）：`plugin.ts` 的 accounts-page 路由 best-effort 调 `readSwitchRecord()`（捕获所有错误 → null），与 trigger 的进程内 `latestSwitchRecord` 按 vendor 取较新者，再把 `lastSwitchAt = max(codex.observedAt, claude.observedAt)`（及是哪个 vendor）作为可选参数传给 view/page renderer；renderer 不做 I/O、不等待刷新；参数为 null → 不标注，页面照常。
- **逐格判定按数据源时间，不按显示格**：每行携带经校验的**数据源读数时间**（Codex 三个、Claude 两个）（直接取自各 store，而不是 `QuotaCell.observedAt`，因为现有 `missingCell()` 会把机器读到的负结果——例如 Codex 订阅 `status:"none"`——的时间丢成 null）：
  - `codexQuotaAt` = `codex-accounts.json` 该号 `observedAt`（5h/周用量与重置格、plan 档位）；
  - `codexResetCreditsAt` = 该号 `resetCreditsObservedAt ?? observedAt`（兑换卡格，即现有 `creditsCell`，与页面现有 staleness 判定同源）—— 观察者在配额读成功但接口没给卡时会沿用上一轮的卡值与时间，所以这一格必须看自己的时间；
  - `codexSubscriptionAt` = `codex-subscriptions.json` 该号 `observedAt`（订阅/下次扣费格，含 `status:"none"`）；
  - `claudeUsageAt` = `claude-accounts.json` 该号 `lastObservedAt`（5h/周/Fable 用量格）；
  - `claudeDetailAt` = `account-details.json` 该号 `observedAt`（卡、订阅档位等 detail 格；现有 `subscriptionTier` 用 snapshot `generatedAt` 建 cell，本单改为 `detailObservedAt`）。
  renderer 按「格 → 数据源」的固定映射判定：该数据源时间为 null 或早于 `lastSwitchAt` → 标「切号后尚未刷新（切号 HH:MM，读于 HH:MM）」/「切号后尚未读到（切号 HH:MM）」；否则不标（即使该格显示的是「读不到（无有效订阅）」这类机器负结果）。Vercel、手工字段、已标 `unavailable` 的 Claude 号不套此规则。
- **横幅**：`lastSwitchAt` 非空且至少一格被标注 → 顶部写「HH:MM <Codex|Claude> 切号后，还有 N 格未刷新」；全部已更新 → 「HH:MM <vendor> 切号后已全部重读」。不宣称任何一路「已完成/失败」，只陈述读数时间事实。
- **转义**：所有派生文本（vendor 名、时间、计数）都经现有 `escapeHtml`；记录文件里没有自由文本字段。
- **测试**（`switch-record.test.ts`、`account-quota-page.test.ts`、`switch-refresh-trigger.test.ts`）：往返；软链 / 超大 / 未知键 / 非法时间 / 未来时间 / 负 generation → null；读抛错时路由仍出正常页面；trigger 在触发刷新前写记录、写失败不阻断刷新；某格 `observedAt` 早于切号 → 标注、晚于 → 不标注、null → 「尚未读到」；Codex 配额新但订阅格旧 → 只标订阅格；切号后订阅返回 `status:"none"` 且其 `observedAt` 晚于切号 → 该格不标；订阅本轮未读且无切号后读数 → 该格标注；Claude 档位格按 `detailObservedAt` 判定；切号后配额 `observedAt` 前进但兑换卡沿用切号前的值与 `resetCreditsObservedAt` → 只标兑换卡格，`resetCreditsObservedAt` 晚于切号后标注消失；Vercel 格不标；横幅计数正确；记录文件缺失 → 无标注无横幅；**磁盘写失败 + 刷新尚未完成时，路由仍用进程内记录标注旧格，且刷新确实被调用**。

### 6.4 测试

- `switch-refresh-trigger.test.ts`：首读只记基线；Codex gen +1 → 一次 `codex_switch`；Claude gen +1 → 一次 `claude_switch`；10 s 内两次 tick 只读一次；gen 合法回退 → 更新基线不触发，其后 +1 仍触发；读失败 → 保留基线不触发；路 A 抛错时路 B 仍执行（反之亦然）；进行中再触发 → 恰好尾随一次。
- `sweep-request.test.ts`：往返；坏文件（未知键 / 非 UUID / 未来时间 / 超 24 h / 超 4 KiB / 软链）→ null；原子写（临时名 → rename，失败时临时文件被清理）；权限 0600/0700。
- `quota-monitor.test.ts`（现有夹具）：新 requestId → 本轮 sweep 与在用号读数都发生，即使 `lastCandidateSweepAt` 是 1 分钟前；全成功才 ack `swept`；在用号 projection 失败、某候选 usage 返回 network、某候选 projection 返回 `stale_generation`、identity 失败、witness 变化 —— 各自不 ack、下一轮成功后 ack；连续 3 轮某号失败 → 第 3 轮 ack `partial` 且有失败日志、第 4 轮不再强制；请求 A 已失败两轮后请求文件被 B 覆盖 → B 从 0 计数、A 不再被处理；同一 A 失败一轮后守护进程重启 → 从 attempts=1 继续；`unavailable` 号不读也不算失败；同一 requestId ack 后不再强制；monitor-only → ack `blocked_monitor_only`；scope 闸门 → 不 ack 不计次；守护进程重启后未 ack 的请求仍被处理。
- `quota-monitor-state.test.ts`：三个新键进白名单；非法 outcome / 非 UUID / attempts 越界（<0 或 >3）→ 视为损坏（与现有键同处理）；旧 state 读成 null。
- 注入时钟：wake 被限流 / 不支持时，trigger 日志带 `wake=<outcome>`，守护进程下一轮仍处理请求。

## 7. W6 — 调度一轮也读 Claude 卡/订阅

- `plugin.ts` 里 FLY-2869 调度器现在调 `refreshCodexReadings`（只 Codex）。改为调一个「Codex + Claude 卡/订阅、不含 Vercel」的刷新实例（与 W5 同一个实例，共享单飞）。
- Claude 卡/订阅观察者只做 GET、不刷新 token（research §4 已核实），15 分钟一轮的请求量 = 每号 3 个 GET。
- 调度器用的刷新返回**分路结果** `{codex: ok|failed:code, claude: ok|failed:code}`（不再让 Claude 失败把组合 promise 打成 reject）：「读数停更」告警（FLY-2869 `reading_stale`）与 `failureCode` 只看 Codex 那一路；Claude 一路失败只记日志 `[reading-scheduler] claude_details_failed:<code>`。页面刷新路由（`/api/codex-accounts/refresh`）保持现有语义不变。
- 测试：调度器到期 → Claude 观察者被调用一次、Vercel 没被调用；Claude 观察者抛错 → Codex 读数照写、`reading_stale` 状态机收到 success、`failureCode` 不是 `refresh_failed`。

## 8. W7 — 呈现

| 项 | 改动 | 测试 |
|---|---|---|
| 卡到期 | `formatCardExpiry` 显示 PT `MM/DD HH:mm`（例：`10/22 13:22`）| 两张到期同日不同分的卡 → 两个不同字符串 |
| 每行读于 | Codex 行「读于 HH:MM」取该号 `observedAt`；Claude 行「用量读于 HH:MM · 卡读于 HH:MM」；任一时间为 null / 不可解析写「从未读到」| 快照断言，含 null |
| 读不到的原因 | `inventory_unavailable` → 「占用盘点失败（<noteDetail>），本次未读，沿用 HH:MM 读数」（`observedAt=null` 时改为「本次未读，从未读到」；无 `noteDetail` 时省略括号）；`readonly_forbidden` → 「被 chatgpt.com 拒绝（HTTP 403）」；`readonly_unauthorized` → 「只读凭据已过期（HTTP 401）」；其它 note 保持现文案 | 每种 note 一条 |
| 切号后标注 | 见 §6.5（逐格对比 `lastSwitchAt`）| 见 §6.5 |
| Claude 扣费日 | 非「已取消」时：「读不到：Anthropic 只在 claude.ai 网页账单页给出（需浏览器登录，已决定不取）」| 文案断言 |
| 转义 | 所有来自 store 的字符串（`noteDetail`、账号名）经现有 HTML 转义函数；`noteDetail` 在写入端已限定字符集 | 含 `<script>` 的 noteDetail 被拒写入；渲染端对非法值也转义 |

## 9. W8 — 全部 Codex 号打满的告警

**改动**

- `codex-quota-store.ts` `recordPoolExhausted`：在**同一事务**里把一份规范化、限长的告警快照写进它 enqueue 的 founder_alert payload：
  ```ts
  alertSnapshot: {
    observedAt: number,
    accounts: {                       // 按 profile 排序；≤16 个账号
      profile: string;                // 现有 profile 名校验
      windows: { usedPercent: number; resetsAt: number | null }[];   // ≤4 个窗口
      reached: boolean;
      recoveryAt: number | null;
    }[],
    earliestRecovery: { profile: string; at: number } | null,
  }
  ```
  - 每号 `recoveryAt`：该号至少有一个 `usedPercent >= 100` 的窗口、且这些窗口的 `resetsAt` **全部已知** → 取最大值；否则（有 100% 窗口但 reset 为 null，或只因 `reached=true` 被判 limited、没有 100% 窗口）→ `null`。
  - `earliestRecovery`：**所有**账号的 `recoveryAt` 都已知 → 取最小者；任一账号未知 → `null`（不能拿已知的最小值冒充全舰队最早恢复）。
  - 数据就是写 capacity fact 用的那份 `input.observations`。不写窗口名（持久化窗口没有「周/5h」维度）。不使用 `nextAttemptAt` 作为恢复时刻。
  - 序列化后超过 8 KiB → 丢弃快照（payload 不带 `alertSnapshot`，走旧文案）并记日志。
- `outbox.ts` founder_alert 渲染：payload 里的 `alertSnapshot` 先按上面的类型与上限**严格解析**（持久化边界必须重验）；合法 → 用它渲染中文正文；不合法 → 记日志并走旧英文正文；没有（旧行）→ 保持现有英文正文。**只读 payload，不读「当前最新 fact」**，所以歧义重放时正文逐字不变。
  ```
  Codex 全部账号都已打满，暂停自动切号，不做盲目替换。
  | 账号 | 各窗口用量 · 重置（PT） | 恢复 |
  | business | 100% · 9/30 13:59 | 9/30 13:59 |
  | personal1 | 100% · 9/26 21:04；37% · 9/26 02:00 | 9/26 21:04 |
  …
  最早可恢复：9/26 21:04（personal1）。也可以兑一张重置卡。
  ```
  某号 `recoveryAt=null` → 该行「恢复」写「无法确定（接口未给重置时间）」或「无法确定（被判打满但没有 100% 窗口）」；`earliestRecovery=null` → 末行写「最早可恢复：无法确定（有账号没给重置时间）」。
  事件类型、severity、mention、幂等键不变。

**测试**（`codex-quota-store.test.ts`、`outbox.test.ts`）

- 集成（均为 selector 判 `pool_exhausted` 的真实可达形状）：① 全部号重置已知、各不相同、有一号两个窗口都 100% → `recoveryAt` 取最大、`earliestRecovery` 取最小；② 某号 100% 但 `resetsAt=null` → 该号 `recoveryAt=null`、`earliestRecovery=null`；③ 某号 `reached=true` 且无 100% 窗口 → 同 ②。三者都断言没有用 `nextAttemptAt` 伪造恢复时间。
- 解析：超限（>16 账号 / >4 窗口 / >8 KiB）与字段类型错误的 payload → 走旧文案且有日志。
- 渲染：正文逐行断言；首次 send 不落 receipt → 之后同 generation 再写入一条新 fact → 重放同一 event，正文与第一次**逐字相等**。
- 旧 payload（无 `alertSnapshot`）→ 现有英文正文不变。
- formatter 单测（隔离）：窗口数组为空的防御分支输出「读不到」，不抛错。

## 10. 上线与迁移

- 无 DB 迁移（W5 没有新表；quota-monitor state 追加三个键：`lastSweepRequestId`、`lastSweepRequestOutcome`、`pendingSweepRequest`，旧文件兼容）。
- 部署后需要 **Bridge 与 quota-monitor 都重启**才生效（quota-monitor 由 launchd 管，由独立 updater 在其窗口重启；本单不手动重启）。
- 回滚：revert 本 PR 即回到今天的行为（自动切号保持 manual，读数照旧）；W5 写的 sweep-request 文件旧版本不读，无副作用。**quota-monitor state 里新增的三个键在旧版本严格白名单下会被判损坏**（可能丢 alertOutbox/confirmation），所以回滚顺序必须是：① `launchctl bootout` 停 quota-monitor；② 用一次性脚本原子删除这三个键（临时文件 → rename），并用旧版本的 state 解析器校验通过；③ 再装旧版本、启动。实现节点在 PR body 里给出这段可复核的命令。
- 部署后第一个收割周期（W1 生效后），FLY-2873 的孤儿 app-server 86434 由收割器收掉（它已远超 2h 门槛）。

## 11. QA 判据映射（Linear 6 条 + Lead 追加 1 条）

| 判据 | 怎么验 |
|---|---|
| 1 十个号逐行对照真接口 | 生产跑 `accounts-page`；Codex 6 号用只读 WHAM/观察者原始返回、Claude 4 号用 usage/profile 原始返回（只留非敏感字段）逐格对照；卡到期对到分钟 |
| 2 在用号读数非「无」 | 当时 canonical 是哪个就看哪个：读数时间在本轮内、数值与 WHAM 原始返回一致 |
| 3 切号后 ≤2 分钟全部更新 | 事先 ask Lead 定目标号；各做一次 Claude、Codex 手动切号，记切号时刻，2 分钟内 `codex-accounts.json` 全部 Codex 号 `observedAt`、`account-details.json` 全部 Claude 号 `observedAt`、`claude-accounts.json` 全部应读 Claude 号（未标 `unavailable`）`lastObservedAt` 都晚于切号时刻；报告附 `[switch-refresh]` 日志行（含 `wake=`）。每次切号都必须有一次全量刷新与日志（硬要求）；前提（§6.3）成立时 ≤2 分钟全部更新；前提不成立时，看日志与页面 §6.5 逐格标注是否如实（任何读数早于切号时刻却没有标注 = FAIL）；测完切回 |
| 4 周期刷新 | 观察 ≥2 个 15 分钟周期，Codex 与 Claude 卡读数时间逐周期前进 |
| 5 Claude 扣费日 | research §5 的来源表 + 页面文案 |
| 6 readiness | 用 `evidence/readiness-replay-probe.mjs.txt`（本单附）对生产 dist 回放两轮：`ready=true`；或逐条列出剩余阻塞并证明不是误判（例如确有无法归属的活进程）|
| 7 FLY-2873 收尾（Lead 追加）| 上线后生产只读核：FLY-2873 的孤儿 app-server 86434 被正常收掉（Bridge 日志有对应成功审计行、`ps` 无此 pid），FLY-2873 land 收尾不再以 `partial nodes_not_confirmed_gone` 重试、最终完成。⛔ 不手动杀进程、不动 FLY-2874 |

## 12. 风险与已知边界

- **自动切号打开后第一次真切号就在生产**：FLY-2869 已用 fixture 证明「A 打满 → 真探 B → 切 → 通知」，本单不改那条路径，但它从未在生产跑过。QA 判据 6 只证明 readiness 能过，不主动制造打满。建议 Lead 在上线后第一次真打满时盯一次。
- 删掉 W3 后：若某次执行体收尾 reap 失败，它的 app-server 会让 readiness 关着最多 2h + 一个收割周期（诊断 `resident_evidence_incomplete` 会指出 home）。
- W2 只放行「TUI 客户端」一种形状；将来 Codex 若再加别的 `ucomm=codex` 常驻子进程，readiness 会重新关上（fail-closed，会有 `resident_process_unbound` 诊断指路）。
- 访问令牌 9-30 21:0xZ 全部到期：在用号走的只读路径不刷新 token，届时读的是 canonical auth（活进程刷新后会写回 canonical），不受影响；非在用号由 app-server 读并持久化刷新。若 9-30 后出现 `readonly_unauthorized`，页面会写清原因（W7）。
- 切号通知里附的额度页（`lead-alert.sh` 的 `--publish-only`）仍是切号瞬间的快照，不等重读；页面每行有「读于」可辨新旧。不在本单改。
- Claude 扣费日继续读不到（founder 已否决 cookie 路径）。

## 13. 不做

- 不碰 desktop Codex / FLY-2729、不清宿主残留、不改 Claude 切号决策与 sweep 刷 token 策略、不改自动切号的选号/安装/通知路径、不改切号通知附页、不加 Vercel 到调度。

## 14. Design review 记录

**R1（Codex，CHANGES REQUESTED，7 条）→ R2 处理**

| # | 意见 | 处理 |
|---|------|------|
| 1 | W2 daemon 必须走完整 resident 证据链；客户端 argv 须无歧义 | 采纳：daemon 走现有 `residentEvidence` 全链路；`--remote` 恰好一次、非 `=` 形式、值全等；补对应阻塞测试；删 `ppid`（advisory）|
| 2 | W3 终态时间权威不清、收割器无 start-identity 门 | 采纳其风险判断，**整条删除 W3**：W1 让正常收尾当场可收，2h 收割器只作兜底；不再宣称收割器有 start-identity 门 |
| 3 | W4 返回类型表达不了原因；canonical 不可读时不能让其它号判 false；store 写入不校验 | 采纳：`OccupancyAnswer{verdict,detail}` 贯穿三层；canonical 不可读 + chain 活跃 → 未证实号全部 unknown；store 写入前校验 |
| 4 | sweep 请求会把未完成的 sweep ack 掉；outcome 字段没进 schema | 采纳：`sweepCandidates` 返回结构化结果，只有 completed 才 ack；瞬态闸门不 ack；两键进 V2 schema |
| 5 | generation 回退卡死、两路级联失败、2 分钟预算不闭合 | 采纳：合法回退重设基线；两路 `allSettled`；专用 waker；sweep 75 s deadline；写出端到端预算与超出条件 |
| 6 | 告警不能读「当前最新 fact」、没有窗口名、fixture 不可达 | 采纳：`recordPoolExhausted` 同事务固化 `alertSnapshot`，按 payload 重放；不写窗口名；fixture 改为真实可达形状 |
| 7 | 跨包导出缺口、私有函数不可测 | 采纳：resolver 从包根导出；真实 socket 用例走已导出的收割器探针 |
| Advisory | W6 分路 outcome、sweep-request 文件权限/大小/陈旧、W7 null | 采纳（成本小）：见 §7、§6.2、§8 |

**R2（Codex，CHANGES REQUESTED，4 条）→ R3 处理**

| # | 意见 | 处理 |
|---|------|------|
| 1 | runtime 默认 holder 接线没有测试 | 采纳：公共入口 `probeCodexDaemonLiveness` / `probeCodexDaemonProcessBinding` + 真实软链 socket + 真 pgid ledger 的回归 |
| 2 | 部分失败被当 completed ack | 采纳：请求模式一轮 = 在用号 + 全部应读候选号，全部 `updated` 才 ack；只有已持久化的 `unavailable` 算终态排除。另加**3 轮上限**后 ack `partial`（防坏号引发每分钟全量 sweep 与 token 刷新风暴）；计数与请求 ID 绑定（R3）|
| 3 | 75 s 不是硬 deadline，与无条件 2 分钟验收矛盾 | 选减法：删除 75 s deadline，2 分钟改为「依赖正常」前提下的 best-effort 契约，QA 判据 3 按前提执行并附日志证据 |
| 4 | 快照表示不了 null reset / `reached=true` | 采纳：`resetsAt`/`recoveryAt`/`earliestRecovery` 可空，任一未知则全舰队「无法确定」；补两个可达 fixture；不以 `nextAttemptAt` 冒充恢复时刻 |
| Advisory | §10 键数、回滚步骤、快照上限与 consumer 重验、日志含 wake | 全部采纳 |

**Lead 裁定（2026-09-25 ask 8fd11093）**：同意 2 分钟改为前提明确的 best-effort；新增硬要求 —— 每次切号必须触发全量刷新并留日志；刷新未完成或失败时页面必须标注「切号后尚未刷新/刷新失败 + 时间」，不得静默显示旧数 → 新增 §6.5。同意删除 W3。

**R3（Codex，CHANGES REQUESTED，1 条）→ R4 处理**

| # | 意见 | 处理 |
|---|------|------|
| 1 | 重试计数没有绑定待处理请求 ID，覆盖/重启时计数错位 | 采纳：`sweepRequestAttempts` 改为 `pendingSweepRequest {requestId, attempts}`；新 ID 归零、同 ID 续计、ack 清空；补覆盖与重启测试 |

R4 为严格限定的验证轮：只验 R3 这一条，以及 R3 之后按 Lead 裁定新增的 §6.5（页面切号后标注）。

**R4（Codex 限定验证轮，CHANGES REQUESTED）→ R5 处理**

R3 那条已关闭。§6.5 被指出 3 条（状态文件无事件身份、旧轮回写与重启后假「进行中」；单一 refresh 状态粒度不足、订阅格与 null 会漏标；reader/转义/fail-open 合同不清）。条数在长，按规则做减法：**§6.5 改为只持久化「最近一次切号时间」**（单写者、单调），页面逐格用自己的 `observedAt` 对比、null 视为尚未读到；不再记录两路刷新状态，因而没有多写者、没有重启假状态、没有分路粒度问题；reader 在路由里 best-effort，renderer 只收可选参数；记录文件无自由文本，派生文本经现有 `escapeHtml`。R5 只验这一节。

**R5（Codex 限定验证轮，CHANGES REQUESTED，2 条）→ R6 处理**

| # | 意见 | 处理 |
|---|------|------|
| 1 | 记录写失败时页面静默 | 采纳：trigger 先更新进程内 `latestSwitchRecord`，路由取进程内与磁盘较新者；补端到端测试 |
| 2 | 显示格的 `observedAt` 会丢机器负结果的时间 | 采纳：每行携带四个数据源读数时间（直接取自 store），按「格→数据源」映射判定；`subscriptionTier` 改用 `detailObservedAt`；补 `status:"none"` 与未读两条对照测试 |

R6 只验这两条。

**R6（Codex 限定验证轮，CHANGES REQUESTED，1 条）→ R7 处理**

| # | 意见 | 处理 |
|---|------|------|
| 1 | Codex 兑换卡有独立的 `resetCreditsObservedAt`，映射到配额时间会漏标 | 采纳：新增 `codexResetCreditsAt`（= 现有 `creditsCell` 的时间来源）；已核对页面上 Codex 没有独立的余额格，不另加；补对照测试 |

R7 只验这一条。

