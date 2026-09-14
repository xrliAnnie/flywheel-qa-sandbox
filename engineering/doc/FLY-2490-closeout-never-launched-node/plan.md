# FLY-2490 shipped 收尾对「起步即 failed 的 Codex 空体」永久保留 — 实施计划

Issue: FLY-2490 (https://linear.app/geoforge3d/issue/FLY-2490/病根-shipped-收尾对起步即-failed无窗口无-commdb-行的体不强清closerunner-的-crash-preserve)
日期: 2026-09-11
基于: research.md

**Version**: v1.5
**Status**: reviewed — Codex 5 轮（R1–R4 全部吸收；R5 为同一 provenance 谱系的物理 DB 边界残留，§10.4）+ Gemini R1 APPROVED；工程 Lead leadAcceptance（ff471511，2026-09-11），交接实现

## 0. 一句话与范围

在 `probeRunExecutionLiveness` 的 Codex 分支里，对 Bridge 进程内 DirectEventSink 写下的 **pre-adapter failure receipt**（§2.6；`failureKind ∈ PRE_ADAPTER_FAILURE_KINDS`，目前只有 `worktree_takeover_failed`，HTTP `/events` 伪造不了）证明「从未进入 `adapter.execute()`」的失败体（launch claim 已 `closed`；状态 `failed|blocked`），在当前 root 也没有任何 daemon 痕迹（session.json 不存在、spawn lock 不存在、socket 无人）时放行到既有 generic 探针（三重缺席才判死，判死后终复核）；其余一切保持 fail-closed。store 事实钩子只在 lifecycle-closeout 接线，其余 5 个调用者字节不变。同时让 land 的 cause 标签从 closeout 报告的节点字段推出 `nodes_not_confirmed_gone`，`lifecycle_conflict` 只留给真正的冲突。**不改** `closeRunner` 的 FLY-116 preserve 门，**不加** env / feature flag；唯一 schema 变更是一张 additive receipt 表（§2.6.1）。

范围外：自动扫 held 的 land op；claude-tmux 体（不受影响）；Codex recovery/revive 的 `probe` 端口（`plugin.ts:8187`）；`terminal-tab-reaper.ts` 自带的 `AUTO_CLOSE_STATES` 副本。

## 1. 变更清单

| # | 文件 | 变更 |
|---|---|---|
| 1 | `packages/teamlead/src/bridge/close-runner-states.ts`（新） | 从 `close-runner.ts` 原样搬出 `AUTO_CLOSE_STATES`、`CRASH_PRESERVE_STATES`、`FINALIZE_DONE_SOURCE_STATES`、`CLOSE_ELIGIBLE_STATES` 四个常量（含注释） |
| 2 | `packages/teamlead/src/bridge/close-runner.ts` | 删除四个常量定义，改为 `export { … } from "./close-runner-states.js"`（re-export，签名与名称不变），并在本文件内 import 使用 |
| 3 | `packages/claude-runner/src/codex-daemon-runtime.ts` | `readPersistedDaemonPgid` 替换为显式四态的 `readPersistedDaemonLedger`（O_NOFOLLOW/O_NONBLOCK/regular-file/1 MiB；有意的 fail-closed 变更，§2.2.1）；`inspectCodexDaemonOwnership` 同一次读取返回 `ledger` 态；`probeCodexDaemonLiveness` 仍是该 inspection 的 `liveness` 投影（不碰 lock）；新增 `inspectDaemonSpawnLock`（四态）、`CodexDaemonEvidence`、`probeCodexDaemonEvidence`（inspection + lock 轴） |
| 4 | `packages/claude-runner/src/index.ts` | 导出 `probeCodexDaemonEvidence`、`CodexDaemonEvidence` |
| 5 | `packages/teamlead/src/bridge/run-quiescence.ts` | `probeRunExecutionLiveness` 的 Codex 分支按 §2.3 改；`session` 形参放宽为含可选 `status`；deps 增加 `probeCodexDaemonEvidence?` 与 `storeFacts?`，保留 `probeCodexDaemon?` 兼容 |
| 5a | `packages/core/src/adapter-types.ts` | 新增 `PRE_ADAPTER_FAILURE_KINDS`（白名单常量，紧挨 failureKind 联合类型） |
| 5b | `packages/teamlead/src/bridge/lifecycle-closeout.ts:1197-1206` | 默认 `probeExecutionLiveness` 闭包传入 `storeFacts`（`getPreAdapterFailureReceipt(id)?.failureKind` + `getLaunchClaim(id)?.state`）；唯一接线点 |
| 5c | `packages/teamlead/src/StateStore.ts` | 迁移：`pre_adapter_failure_receipts` 表；`recordPreAdapterFailureReceipt` / `getPreAdapterFailureReceipt`（§2.6.1） |
| 5d | `packages/teamlead/src/DirectEventSink.ts:1333-` | `emitFailed` 对白名单 kind 写 receipt（唯一写者） |
| 5e | `packages/teamlead/src/bridge/event-route.ts:1388-1414` | `session_failed` 分支拒绝白名单 kind（400 + 审计事件）；传给 `recordEnrolledTerminalSignal` 的 `source` 固定为 `"http-events"`（§2.6.2） |
| 5f | `scripts/lib/fly-2006-retention-registry.mjs`、`scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json`、`scripts/__tests__/fly-2006-database-retention-sweep.test.ts` | 新表登记（§2.6.3） |
| 6 | `packages/teamlead/src/bridge/land-closeout-cause.ts` | 词表加 `nodes_not_confirmed_gone`；`CloseoutCauseReportShape` 节点加可选 `confirmedGone` / `communicationsFinalized` / `transition.prerequisite` / `teardown.reason`；`inferLandCloseoutCauseFromClosureReport` 按 §2.4 推导；`describeLandCloseoutCause` 加文案 |
| 7 | `packages/teamlead/src/bridge/post-ship-finalization.ts` | `:1091` 的 `closeoutCause ??= "lifecycle_conflict"` 改为只对 `outcome === "conflict"` 回落 `lifecycle_conflict`，`blocked` 无可推 cause 时回落 `unknown` |
| 8 | 测试（§4） | 5 个测试文件新增/调整用例 |
| 9 | `engineering/doc/milestones/FLY-2490.md` | ship 时新建（README 合同），本 PR 不写 CLAUDE.md 表格 |

## 2. 精确设计

### 2.1 `close-runner-states.ts`（叶子模块）

```ts
// packages/teamlead/src/bridge/close-runner-states.ts
export const AUTO_CLOSE_STATES: ReadonlySet<string> = new Set([
  "completed", "rejected", "deferred", "shelved", "terminated",
]);
export const CRASH_PRESERVE_STATES: ReadonlySet<string> = new Set(["failed", "blocked"]);
export const FINALIZE_DONE_SOURCE_STATES: ReadonlySet<string> = new Set([
  "running", "ship_parked", "awaiting_review", "approved_to_ship", "design_done",
]);
export const CLOSE_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
  ...AUTO_CLOSE_STATES, ...CRASH_PRESERVE_STATES,
]);
```

`close-runner.ts` 顶部：

```ts
import { AUTO_CLOSE_STATES, CRASH_PRESERVE_STATES, FINALIZE_DONE_SOURCE_STATES } from "./close-runner-states.js";
export { AUTO_CLOSE_STATES, CLOSE_ELIGIBLE_STATES, CRASH_PRESERVE_STATES, FINALIZE_DONE_SOURCE_STATES } from "./close-runner-states.js";
```

理由：`close-runner.ts` 已 import `run-quiescence.ts`；`run-quiescence.ts` 需要 `CRASH_PRESERVE_STATES`，反向 import 会成环。叶子模块保证一个词表；既有生产 importer 全部零改动：`commdb-fsm-reconcile.ts`（AUTO_CLOSE + CRASH_PRESERVE）、`actions.ts`（AUTO_CLOSE）、`lifecycle-closeout.ts`（AUTO_CLOSE + FINALIZE_DONE_SOURCE）、`plugin.ts:247`（CLOSE_ELIGIBLE）、`post-ship-finalization.ts:32`（FINALIZE_DONE_SOURCE），以及 `close-runner.test.ts`。`terminal-tab-reaper.ts:25` 与 `done-thread-reconcile.ts:59` 是**本地副本 / 注释约束**而非 importer，本单不动（范围外；Codex R1 LOW 更正）。

### 2.2 `probeCodexDaemonEvidence`（claude-runner）

Codex R1 HIGH：现有 `readPersistedDaemonPgid`（`codex-daemon-runtime.ts:119-140`）把 ENOENT、权限错误、损坏 JSON、非法对象、非法 pgid 全部折成 `undefined`，所以「pgid 缺失」不能当「从未记录」。Codex R2 HIGH：spawn lock 里写的是 **Bridge 的 pid**（`:1257-1265`），daemon 以 `detached:true` 启动（`:992-1008`），Bridge 在 spawn 之后、同步写 pgid 之前被 SIGKILL/OOM 杀掉时，锁变 `stale` 而 daemon 仍可能活着且 argv 不含 execution id；所以 **`stale` 不是 daemon 缺席证明**。本版把可放行的证据组合收窄到「从未拿过锁」这一种。

#### 2.2.1 一次读取、显式状态的内部 inspection（Codex R2 MEDIUM-3）

```ts
export type CodexDaemonLedgerState =
  | { state: "missing" }                       // session.json ENOENT（目录或文件不存在）
  | { state: "no_group" }                      // 可读、合法 JSON 对象；daemonPgid 与 daemonPid 两个键都不存在（Object.hasOwn）
  | { state: "valid_group"; pgid: number }     // daemonPgid 存在且合法；键不存在时才看 legacy daemonPid（存在且合法）
  | { state: "unreadable" };                   // 其它一切：EACCES/EISDIR/ELOOP、非 regular file、> 1 MiB、JSON 失败、非对象/数组、
                                               // 键存在但值非法（null / boolean / 字符串 / 0 / 负数 / 小数 / 非 safe integer / ≤1）

function readPersistedDaemonLedger(executionId, env): CodexDaemonLedgerState {
  // openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) → fstat 必须 isFile() 且 size ≤ 1 MiB → readSync → finally closeSync
  // ENOENT ⇒ missing；其它 open/fstat/read 错误 ⇒ unreadable；JSON.parse 失败 / 非 plain object ⇒ unreadable；
  // hasOwn(daemonPgid) ? (valid ? valid_group : unreadable)
  //   : hasOwn(daemonPid) ? (valid ? valid_group : unreadable)
  //   : no_group
  // valid := typeof v === "number" && Number.isSafeInteger(v) && v > 1
}

interface CodexDaemonOwnershipInspection {          // 内部：inspectCodexDaemonOwnership 的返回值扩展，同一次 ledger 读取
  liveness: CodexDaemonLiveness; ledger: CodexDaemonLedgerState["state"]; pgid?: number;
  socketPath: string; socketLive: boolean; groupState: ProcessGroupState;
}
async function inspectCodexDaemonOwnership(executionId, deps): Promise<CodexDaemonOwnershipInspection> {
  const ledger = readPersistedDaemonLedger(executionId, env);          // 只读一次
  const pgid = ledger.state === "valid_group" ? ledger.pgid : undefined;
  // 以下与现有 :150-212 逐字相同（pgid undefined ⇒ unknown + socketLive；socket dead ⇒ group absent ? absent : unknown；…）
  return { …existing, ledger: ledger.state };
}

export async function probeCodexDaemonLiveness(executionId, deps = {}) {
  return (await inspectCodexDaemonOwnership(executionId, deps)).liveness;   // 与现在完全相同的调用形状；不碰 lock，不多开任何文件
}
```

`readPersistedDaemonPgid` 删除，唯一调用者就是 `inspectCodexDaemonOwnership`（`:157`）。**有意的行为变更（不是 byte-identical，Codex R2 MEDIUM-3）**：ledger 读取从 `readFileSync`（跟随符号链接、可被 FIFO 阻塞、无大小上限）改为 `O_NOFOLLOW | O_NONBLOCK` + regular-file + 1 MiB 上限。影响面：只有 `session.json` 是符号链接 / FIFO / 目录 / 超大文件时结果改变——原来可能读出 pgid，现在一律 `unreadable ⇒ liveness "unknown"`。适配器只用 `mergeSessionState` 的「写临时文件 + 原子 rename」写 regular file（`CodexTmuxAdapter.ts:2134`），生产数据不会命中；对旧消费者（`plugin.ts:8187` 的 revive `probe`、`reapCodexDaemonForExecution`、`run-quiescence`）是 fail-closed 方向（不 revive、不 reap、不判死）。T-CR-4 的 parity 断言改为「对 regular-file 夹具逐字相同 + 对 symlink/FIFO 夹具新旧都不判 alive/absent」。

#### 2.2.2 lock 轴与对外 evidence

```ts
export type CodexDaemonSpawnLockState = "absent" | "stale" | "live" | "unreadable";
function inspectDaemonSpawnLock(lockPath, deps): CodexDaemonSpawnLockState {
  // openSync(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)：ENOENT ⇒ absent；其它错误 / 非 regular file / > 4096 B / JSON 失败 / 非对象 ⇒ unreadable；
  // pid := parsed.pid；!(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) ⇒ unreadable；
  // try { alive = (deps.isPidAlive ?? defaultIsPidAlive)(pid) } catch { return "unreadable" }；alive ? live : stale。
}

export interface CodexDaemonEvidence {
  liveness: CodexDaemonLiveness;              // 同 probeCodexDaemonLiveness 的值（同一次 inspection）
  ledger: CodexDaemonLedgerState["state"];    // missing | no_group | valid_group | unreadable（同一次读取）
  socketLive: boolean;                        // defaultIsSocketLive：EACCES / 超时 / 其它模糊结果按 true（既有 fail-closed）
  spawnLock: CodexDaemonSpawnLockState;       // absent | stale | live | unreadable
}

export async function probeCodexDaemonEvidence(executionId, deps = {}): Promise<CodexDaemonEvidence> {
  const inspected = await inspectCodexDaemonOwnership(executionId, deps);
  return {
    liveness: inspected.liveness, ledger: inspected.ledger, socketLive: inspected.socketLive,
    spawnLock: inspectDaemonSpawnLock(`${inspected.socketPath}.lock`, deps),
  };
}
```

`CodexDaemonOwnershipDeps` 增加可选 `isPidAlive?: (pid: number) => boolean`（测试注入 lock holder 存活）。`reapCodexDaemonForExecution` 只用 `liveness/pgid/groupState/socketPath`，不受影响。

#### 2.2.3 零 daemon 证据（唯一允许放行的组合）

```
zeroDaemonEvidence := ledger === "missing" && socketLive === false && spawnLock === "absent"
```

v1.4 起这三轴不再是承重证明（承重的是 §2.3.1 门 (2)），只是一致性核对；仍只认 `missing + absent`（Codex R2 HIGH），且 **lock-release 不变量只是辅助条件，不是独立证明**（Codex R3 MEDIUM：`ensureDead()` 在 socket 不再接受连接后即 unlink + release，`:871-902`，不等待进程组退出；`killTree` 组信号失败时退回只信号 leader，`:812-858`）。生产 spawn 前必有非 `missing` 的 ledger（`persistLaunchSnapshot` 在 runtime 构造前调用，`CodexTmuxAdapter.ts:1088-1113`），所以「ledger missing」才是三轴里真正有区分力的一轴。原论证保留如下（注意：其中「只在 daemon 被证明已死后释放」是被 R3/R4 否定的旧假设——实际是 socket-dead cleanup 后释放，不能单独证明进程组消失；保留只为追溯）：
- `acquireLock` 在 `spawnFn` **之前**（`:652` vs `:754`），锁是 daemon 存在的前置条件；`absent` ⇒ 这个 execution 从未在本机拿到过锁，或锁已被「daemon 证明已死」的路径释放（`:896-902` 正常 stop、`:934-936` 失败 cleanup 确认死亡）。唯一的例外路径 `:980`（outer catch 在 `lockHandled=false` 时释放）只在 `spawnFn` 本身抛出（没有 child）或 `cleanupAndThrow` 之前抛出时到达。
- `stale`（holder = Bridge pid 已死）**不放行**：Bridge 在 spawn 与 `onSpawnIdentity` 之间被杀，detached child 可能仍活且未 bind socket，重启后 heartbeat 的 orphan aging 可把行转 `failed`（`HeartbeatService.ts:895-943, 2043-2113`），generic 的 `pgrep -f executionId` 对不含 exec id 的 daemon argv 会 clean-miss。这条竞态留在 `unknown`（现状），见 research §3 follow-up。
- `no_group`（session.json 存在但无 pgid）**不放行**：它与上面的 pre-persist 窗口同形（executeOwned 在 spawn 前就写 `codexAgentHome`/`launchSnapshot`，`CodexTmuxAdapter.ts:866, 1997`）。本单观察到的两具体（`c070fce7`、`9ab658df`）都是 worktree 阶段失败、`missing + absent`，收窄不影响目标族。
- `unreadable`（ledger 或 lock）、`live`、`socketLive` 永远不放行。

### 2.3 `probeRunExecutionLiveness`（run-quiescence.ts）

Codex R3 HIGH：ledger / lock / socket 三轴都按**当前 Bridge 的当前路径**解析（`codex-daemon-runtime.ts:60-95`），所以「三轴缺席」只是「此 root、此刻无证据」——root 漂移、同 UID daemon 自己 unlink 证据、终复核之后才 spawn，三条路径都能让活 daemon 与三轴缺席共存。v1.4 采用 Codex 给出的最小安全范围：**只对 StateStore 能证明「从未进入 `adapter.execute()`」的失败类别放行**。承重事实变成 StateStore 的结构化失败记录，三轴缺席与 generic 三重缺席只是附加的一致性核对。

#### 2.3.1 pre-adapter 失败类别与 store 事实钩子

```ts
// packages/core/src/adapter-types.ts（failureKind 联合类型所在处）
/** FLY-2490：Blueprint 在 `adapter.execute()`（Blueprint.ts:3105）之前就 return 的失败类别。
 *  这类 execution 在任何 root 下都不可能 spawn 过 Codex daemon。白名单只能增不能改，且只准加入 StateStore 能证明发生在 `adapter.execute()` 之前的类别（Lead 裁定 581f8ca0）。 */
export const PRE_ADAPTER_FAILURE_KINDS: ReadonlySet<string> = new Set(["worktree_takeover_failed"]); // Blueprint.ts:1470-1480

// packages/teamlead/src/bridge/run-quiescence.ts
export interface ExecutionStoreFacts {
  /** Bridge-local receipt（§2.6.1）的 failureKind：store.getPreAdapterFailureReceipt(executionId)?.failureKind；无 receipt ⇒ undefined。
   *  绝不从 session_events / session_failed.payload 推导（HTTP 可伪造，Codex R4）。 */
  failureKind?: string;
  /** store.getLaunchClaim(executionId)?.state：starting | active | closed | cancelled；无 claim ⇒ undefined */
  launchClaimState?: string;
}
export interface RunExecutionLivenessDeps {
  probeCodexDaemon?: typeof probeCodexDaemonLiveness;          // 旧注入口，映射为 valid_group + unreadable lock（fail-closed）
  probeCodexDaemonEvidence?: typeof probeCodexDaemonEvidence;
  probeGeneric?: typeof probeGeneralizedLaunchLiveness;
  /** FLY-2490：store 事实钩子。缺失 ⇒ 新分支永不触发（其余 5 个生产调用者字节不变）。 */
  storeFacts?: (executionId: string) => ExecutionStoreFacts;
}
```

生产接线只有一处：`lifecycle-closeout.ts:1197-1206` 的默认 `probeExecutionLiveness` 闭包（它已经持有 `store`）传入

```ts
storeFacts: (id) => ({
  failureKind: store.getPreAdapterFailureReceipt(id)?.failureKind,
  launchClaimState: store.getLaunchClaim(id)?.state,
}),
```

`close-runner.ts:935`、`post-merge.ts:254`、`plugin.ts:7564`、`run-recovery.ts:214`、`collectRunQuiescenceEvidence` 都**不**传 `storeFacts`，因此对它们新分支永不触发——行为字节不变（research §2 更新）。

#### 2.3.2 探针

```ts
export type RunExecutionLivenessSession =
  Pick<Session, "adapter_type"> & Partial<Pick<Session, "status">>;

const isZeroDaemonEvidence = (e: CodexDaemonEvidence): boolean =>
  e.liveness === "unknown" && e.ledger === "missing" && e.socketLive === false && e.spawnLock === "absent";

export async function probeRunExecutionLiveness(session, executionId, projectName, deps = {}) {
  const generic = () => (deps.probeGeneric ?? probeGeneralizedLaunchLiveness)(
    executionId, projectName, { allowMissingTargetHostAbsence: true });
  if (session?.adapter_type !== "codex-tmux") return generic();          // claude 体：字节不变

  const probeEvidence = async (): Promise<CodexDaemonEvidence> => /* 同 v1.3 */;
  const first = await probeEvidence();
  if (first.liveness === "alive") return "alive";
  if (first.liveness === "absent") return generic();                     // 既有路径（FLY-1940）

  // FLY-2490 新分支：四道门全过才问 generic
  if (!deps.storeFacts) return "unknown";                                // (0) 未接线的调用者：现状
  if (!CRASH_PRESERVE_STATES.has(session.status ?? "")) return "unknown";                     // (1) crash-terminal
  const facts = deps.storeFacts(executionId);
  if (!PRE_ADAPTER_FAILURE_KINDS.has(facts.failureKind ?? "")) return "unknown";              // (2) 从未进入 adapter.execute()
  if (facts.launchClaimState !== "closed") return "unknown";              // (3) claim 已 closed（cancelled 可与已出生 Runner 共存，Codex R4 ⇒ 不认）
  if (!isZeroDaemonEvidence(first)) return "unknown";                    // (4) 当前 root 也无任何 daemon 痕迹（一致性核对）
  const verdict = await generic();                                       // (5) tmux marker / CommDB target / pgrep 三重缺席
  if (verdict !== "dead") return verdict;
  const second = await probeEvidence();                                  // (6) 终复核（末端 veto）
  return isZeroDaemonEvidence(second) ? "dead" : "unknown";
}
```

为什么门 (2) 是承重的：`worktree_takeover_failed` 只由 `Blueprint.ts:1470-1480` 产生，该 `return` 早于 `adapter.execute(adapterContext)`（`:3105`）；它经 `emitTerminal → DirectEventSink.emitFailed`（进程内）写成 §2.6.1 的 receipt——HTTP `/events` 不能写 receipt，且对该 kind 直接 400（§2.6.2）。一个从未进入适配器的 execution 在**任何** root 下都没有 spawn 过 daemon，所以 root 漂移、证据被 unlink、`pgrep` 对 hashed-socket argv 的 clean-miss 都不构成反例。门 (3)：目标族 57 具体的 claim 全部 `closed`（快照）；`starting/active` 表示 dispatcher 仍可能 spawn，`cancelled` 按现有合同可与已出生 Runner 共存（`lifecycle-closeout.ts:1236-1246`），都 fail-closed。门 (4)-(6) 不再承担证明责任，只是「若与 (2) 矛盾则宁可不判」。

**终复核后才 spawn 的 TOCTOU**（Codex R3）：门 (2)+(3) 下不存在——receipt 只由「Blueprint 在 adapter 之前返回」这条进程内路径产生，同一 execution id 不会被再次 dispatch（replacement 走新 execution，`enqueueWorkflowReplacementLeadEvent`；claim 已 closed 时 `casLaunchClaimState` 不会再回到 starting）。这是 StateStore 事实，不依赖文件系统，也不依赖 Runner 可写的通道。

真值表（Codex 分支；`*` = 任意）：

| liveness | storeFacts 钩子 | status | receipt failureKind | claim | ledger/socket/lock | 结果 |
|---|---|---|---|---|---|---|
| alive | * | * | * | * | * | alive（不变） |
| absent | * | * | * | * | * | generic（不变） |
| unknown | 缺失 | * | * | * | * | unknown（不变：5 个未接线调用者） |
| unknown | 有 | 非 failed/blocked | * | * | * | unknown |
| unknown | 有 | failed / blocked | 无 receipt（含 HTTP 伪造的 session_failed 事件、goal 类、zombie 类、quota 类失败、本 PR 之前的旧体） | * | * | unknown |
| unknown | 有 | failed / blocked | receipt ∈ 白名单 | starting / active / cancelled / 缺失 | * | unknown |
| unknown | 有 | failed / blocked | receipt ∈ 白名单 | closed | 非 missing+false+absent | unknown（与门 (2) 矛盾，宁可不判） |
| unknown | 有 | failed / blocked | receipt ∈ 白名单 | closed | missing + false + absent | **generic**，dead 后终复核仍零证据才 dead（唯一放行行） |

### 2.4 cause 推导（land-closeout-cause.ts）

```ts
export const LAND_CLOSEOUT_CAUSES = [
  "husk_lease_stale", "phase_shutdown_unacked", "node_process_residual", "node_process_unverifiable",
  "window_identity_mismatch", "window_cleanup_failed", "window_identity_pending", "commdb_finalize_failed",
  "worktree_branch_mismatch",
  "nodes_not_confirmed_gone",   // 新：closeout 有节点未被证明消失（对应审计 closeout_issue_items_blocked.reason）
  "lifecycle_conflict", "archive_failed", "source_session_unavailable", "unknown",
] as const;

type CloseoutCauseReportShape = {
  nodes: Array<{
    transition: { state: string; error?: string; prerequisite?: string };
    teardown: { state: string; error?: string; reason?: string };
    confirmedGone?: boolean;
    communicationsFinalized?: boolean;
  }>;
};

const isAuthorityToken = (s?: string) => s?.startsWith("authority_") === true;

export function inferLandCloseoutCauseFromClosureReport(report) {
  const errors = /* 现有：state==="failed" 的 error */;
  if (errors.length > 0) return inferLandCloseoutCause(errors);           // 1. 失败错误串优先（不变）
  if (report.nodes.some(n =>
        (n.transition.state === "blocked" && isAuthorityToken(n.transition.prerequisite)) ||   // closeoutIssue 循环里的 authorityLost 节点
        (n.teardown.state === "skipped" && isAuthorityToken(n.teardown.reason))))              // closeoutOneNode transition 后 freshAuthority 失败（lifecycle-closeout.ts:1373-1385）
    return "lifecycle_conflict";                                            // 2. 权威变更（两种真实形状，Codex R1 MEDIUM）
  if (report.nodes.some(n => n.confirmedGone === false || n.communicationsFinalized === false))
    return "nodes_not_confirmed_gone";                                       // 3. 节点未证明消失
  return undefined;                                                          // 4.
}
```

`closeRunner` 内部的 `authority_lost:*` 走 `teardown.state === "failed"` 的 error 串，由规则 1 的既有 matcher（`lifecycle_conflict: ["authority_lost", …]`）覆盖，不需要第三种形状。

`describeLandCloseoutCause("nodes_not_confirmed_gone")` ⇒ `"有 Runner 节点尚未被证明已消失（见 closeout_issue_items_blocked 审计事件）"`。`landCloseoutCauseFromReason` 的 `[a-z_]+` 已覆盖新 token；`workflow-engine-dispatcher.ts:2268` 的重试正则只看 `issue_closeout_incomplete` 前缀，新 cause 与旧 cause 同样重试 9 次后 held。

`NodeClosureReport`（lifecycle-closeout.ts:116）已有 `confirmedGone`/`communicationsFinalized` 必填布尔和 `transition.prerequisite`，`plugin.ts:6576` 的 `landIssueCloseoutResultFromClosureReport(report)` 调用零改动。

### 2.5 post-ship 回落（post-ship-finalization.ts:1085-1097）

```ts
if (closeoutRes && (closeoutRes.outcome === "blocked" || closeoutRes.outcome === "conflict")) {
  closeoutBlocked = true;
  closeoutCause ??= closeoutRes.outcome === "conflict" ? "lifecycle_conflict" : "unknown";
  …
}
```

`conflict` 报告没有节点（`baseReport("conflict")` 直接返回），cause 必为 undefined ⇒ `lifecycle_conflict`（语义正确）；`blocked` 在 §2.4 之后几乎总有 cause，兜底 `unknown` 是诚实标签。`huskForce.cause === "authority_lost" ⇒ lifecycle_conflict`（:1051）不变。

### 2.6 承重事实的 provenance：Bridge-local durable receipt（Codex R4 HIGH，Lead 裁定 1bc772cf）

**核实结论（写进 plan 的合同）**：

- `worktree_takeover_failed` 只在 `packages/edge-worker/src/Blueprint.ts:1470-1480` 产生，经 `emitTerminal`（`:3218-3236`）交给 `this.eventEmitter.emitFailed(env, error, undefined, result.failure)`。Bridge 内 Blueprint 的 `eventEmitter` 是 **`DirectEventSink`**（`bridge/run-infra.ts:664, 944`），进程内直写 StateStore，不经 HTTP。
- HTTP emitter `TeamLeadClient`（`ExecutionEventEmitter.ts:151`，走 `postEventReliable → /events`）在生产源码里**没有任何实例化点**（`grep "new TeamLeadClient"` 仅测试）；`flywheel-comm` CLI 没有任何发 `session_failed`/`failureKind` 的命令（只有 `qa-result` 内部的另一组 kind）。⇒ **合法发出者只在 Bridge 进程内**，`/events` 上出现该 kind 只可能是伪造或误用。
- `/events`（`event-route.ts:1496`）把 `event_type` / `payload` / `source` **原样**插入 `session_events`；`:1388-1414` 又把 `payload.failure.failureKind` 交给 `recordEnrolledTerminalSignal`。所以 `session_events` 里任何行（含 `source` 字段）都不能作承重事实；Bridge 已有先例：FLY-1372 的 docTier / issueUrl / codexSkip 只由 DirectEventSink 持久化、HTTP 路径不读（`event-route.ts:1605-1612`）。

#### 2.6.1 receipt 表（只由 DirectEventSink 写）

```sql
-- StateStore 迁移（additive；无回填）
CREATE TABLE IF NOT EXISTS pre_adapter_failure_receipts (
  execution_id    TEXT PRIMARY KEY,
  failure_kind    TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  recorded_at     TEXT NOT NULL
);
```

```ts
// StateStore
recordPreAdapterFailureReceipt(input: { executionId; failureKind; sourceEventId; now }): { ok: true; inserted: boolean } | { ok: false; reason: "kind_not_pre_adapter" } {
  if (!PRE_ADAPTER_FAILURE_KINDS.has(input.failureKind)) return { ok: false, reason: "kind_not_pre_adapter" };
  // INSERT OR IGNORE（execution_id 幂等；重复写不改第一份）
}
getPreAdapterFailureReceipt(executionId): { failureKind: string; sourceEventId: string; recordedAt: string } | undefined
```

写入点只有一处：`DirectEventSink.emitFailed`（`DirectEventSink.ts:1333-`）在算出 `normalizedFailure` 之后、`recordEnrolledTerminalSignal` / `insertEvent` / `upsertSession` 之前：

```ts
if (normalizedFailure && PRE_ADAPTER_FAILURE_KINDS.has(normalizedFailure.failureKind)) {
  this.store.recordPreAdapterFailureReceipt({ executionId: env.executionId, failureKind: normalizedFailure.failureKind, sourceEventId: <同一 randomUUID()>, now });
}
```

`event-route.ts` **不**调用 `recordPreAdapterFailureReceipt`（唯一写者是 DirectEventSink，T-EV-3 用 grep 守卫）。崩溃窗口：receipt 先写、status 后写 ⇒ 若中途崩溃，receipt 在而 status 非 failed ⇒ 门 (1) 挡住；status failed 而 receipt 缺失不可能由本顺序产生（receipt 在前）；旧数据（本 PR 之前的 failed 体）没有 receipt ⇒ 永远 `unknown`（现状，见 §5 现网收敛）。

#### 2.6.2 `/events` 入口隔离

`event-route.ts` 的 `session_failed` 分支（`:1388`）在 `normalizeTerminalFailureInfo` 之后：`if (failure && PRE_ADAPTER_FAILURE_KINDS.has(failure.failureKind))` ⇒ `res.status(400).json({ error: "pre_adapter_failure_kind_http_forbidden", failureKind })` 并 `store.insertEvent({ event_type: "events_pre_adapter_kind_rejected", source: "bridge.event-route", payload: { failureKind, claimedSource: event.source } })` 审计；**不**写 session_failed、**不**改 status（依据：合法发出者只在进程内）。同分支传给 `recordEnrolledTerminalSignal` 的 `source` 改为 Bridge 赋值的固定字面量 `"http-events"`（不再透传 `event.source`）；`:1496` 的通用 `insertEvent` 保持原样（它不承重，改动它超出本单范围，列 follow-up）。

#### 2.6.3 retention registry（新表三处编辑）

`pre_adapter_failure_receipts` 归 `protectedCurrentOrReference`（证据，不进 14 天 sweep）：(1) `scripts/lib/fly-2006-retention-registry.mjs` 组；(2) `scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json`（排序插入）；(3) `scripts/__tests__/fly-2006-database-retention-sweep.test.ts` 的硬计数。与 DDL 同一 chunk（c3），保证 `assertNoUnclassifiedSchema` 不见半注册 schema。

## 3. 负向守卫（必须不变的行为）

1. `closeRunner` 的 preserve 门（`close-runner.ts:484`）逐字不变；`close-runner.test.ts:1712`「crash-preserved close marks nothing」继续通过。
2. `probeCodexDaemonLiveness` 对 regular-file 的 `session.json` 输入与改前逐字相同（§4 T-CR-4 parity）；symlink / FIFO / 目录 / 超大文件是 §2.2.1 声明的有意 fail-closed 变更。
3. `session.json` 有合法 `daemonPgid` 而进程组 `unknown/alive` 的 Codex 体：仍 `unknown`（`run-quiescence.test.ts` 第 2 条不动）。
3a. `session.json` 不可读 / 损坏 JSON / 非对象 / 键存在但值非法（含 `null`）（`ledger === "unreadable"`）：仍 `unknown`——「记录不可信」永远不等于「从未记录」（Codex R1 HIGH、R2 MEDIUM-2）。
3b. spawn lock `live`（holder pid 存活，含失败 cleanup 后被保留的锁）、`stale`（holder 已死——Bridge 死于 pre-persist 窗口时 detached daemon 可能仍活）、`unreadable`（含 pid 非 safe integer / ≤1 / `isPidAlive` 抛错）：仍 `unknown`（Codex R2 HIGH）。
3c. `ledger === "no_group"`（session.json 存在但无 pgid 键）：仍 `unknown`，因为它与 pre-persist 窗口同形（Codex R2 HIGH）。
3d. generic 判 `dead` 后终复核：期间出现锁 / ledger / socket 任一证据 ⇒ 撤回为 `unknown`。
3f. 无 receipt（含 `goal_blocked`、`goal_usage_limited`、`reown_exhausted`、zombie/heartbeat 转 failed 的行、本 PR 之前的旧 failed 体、以及任何只在 `session_events` 里出现的 `worktree_takeover_failed` 字样）：仍 `unknown`，即使三轴全缺席（Codex R3/R4 HIGH）。
3g. launch claim `starting` / `active` / `cancelled` / 缺失：仍 `unknown`（`cancelled` 可与已出生 Runner 共存）。
3i. receipt 的唯一写者是 `DirectEventSink.emitFailed`；`event-route.ts` 不导入 `recordPreAdapterFailureReceipt`（T-EV-3 grep 守卫）；`/events` 对白名单 kind 返回 400，不写 session_failed、不改 status。
3j. `storeFacts` 绝不读 `session_events`（T-RQ-12 / T-LC-4 用「有伪造事件、无 receipt」夹具守卫）。
3h. 未传 `storeFacts` 的 5 个调用者（`close-runner.ts:935`、`post-merge.ts:254`、`plugin.ts:7564`、`run-recovery.ts:214`、`collectRunQuiescenceEvidence`）：Codex 分支行为字节不变。
3e. `probeCodexDaemonLiveness` 不打开 lock 文件、不做 pid 探测；对 regular-file 的 `session.json` 输入与改前逐字相同（§2.2.1 声明的 symlink/FIFO/超大文件例外是有意的 fail-closed 变更）。
4. socket 上有 holder 但无 pgid：仍 `unknown`。
5. StateStore 状态非 `failed|blocked`（含缺失）的零证据 Codex 体：仍 `unknown`。
6. claude-tmux / 无 adapter 体：路径字节不变（仍直接 generic）。
7. `lifecycle_conflict` 仍用于：`huskForce.cause === "authority_lost"`、closeout `conflict`、节点 `authority_*` 阻塞。
8. 无 env、无 flag、无数据回填；唯一 schema 变更是 additive 的 `pre_adapter_failure_receipts`（不回填历史 failed 体）；`closeout_issue_items_blocked` 与 `closeout_report` 审计事件形状不变；新增审计事件 `events_pre_adapter_kind_rejected` 只在 `/events` 被拒时出现。

## 4. 测试（TDD，先红后绿）

| id | 文件 | 用例 |
|---|---|---|
| T-CR-1 | `packages/claude-runner/test/codex-daemon-runtime.test.ts` | `probeCodexDaemonEvidence`：state dir 不存在 + `isSocketLive=false` + 无 lock 文件 ⇒ `{liveness:"unknown", ledger:"missing", socketLive:false, spawnLock:"absent"}` |
| T-CR-1b | 同上 | session.json 存在但只有 `codexAgentHome`/`launchSnapshot`（两个 pgid 键都不存在）⇒ `ledger:"no_group"`，其余同 T-CR-1 |
| T-CR-2 | 同上 | 无 session.json + `isSocketLive=true` ⇒ `{unknown, ledger:"missing", socketLive:true, …}` |
| T-CR-3 | 同上 | 合法 pgid + socket dead + `processGroupState="absent"` ⇒ `{absent, ledger:"valid_group", …}`；`processGroupState="unknown"` ⇒ `{unknown, ledger:"valid_group", …}`；合法 pgid + socket dead + `processGroupState="alive"` ⇒ `unknown`（Codex R1：无 socket 但组仍活） |
| T-CR-3b | 同上 | **ledger 负向**（Codex R1 HIGH / R2 MEDIUM-2）：session.json 为损坏 JSON / 顶层数组 / `daemonPgid:null` / `daemonPgid:"12"` / `daemonPgid:true` / `daemonPgid:0` / `daemonPgid:-5` / `daemonPgid:1` / `daemonPgid:1.5` / `daemonPgid:2**53` ⇒ `ledger:"unreadable"`；`{daemonPid: 4321}`（无 daemonPgid 键）⇒ `valid_group`，`{daemonPgid: 4321, daemonPid: null}` ⇒ `valid_group`（daemonPgid 优先）；session.json 是目录 / 符号链接 / FIFO / > 1 MiB / mode 000（非 root 下 EACCES）⇒ `"unreadable"`；`probeCodexDaemonLiveness` 对这些输入全部返回 `"unknown"` |
| T-CR-3c | 同上 | **lock 四态**：无文件 ⇒ `absent`；`{pid:4321}` 且注入 `isPidAlive=()=>true` ⇒ `live`；`isPidAlive=()=>false` ⇒ `stale`；非 JSON / 无 pid / `pid:null` / `pid:true` / `pid:0` / `pid:1` / `pid:-1` / `pid:1.5` / `pid:"12"` / 符号链接 / > 4096 B / `isPidAlive` 抛错 ⇒ `unreadable`（`isPidAlive` 对非法 pid **不被调用**） |
| T-CR-4 | 同上 | parity：对 T-CR-1..3c 与既有 `:66` 的夹具，`probeCodexDaemonLiveness(x)` 恒等于 `probeCodexDaemonEvidence(x).liveness`；对每个 **regular-file** 夹具，`probeCodexDaemonLiveness` 的三值与改前（git 上一版函数，测试内联旧读法作 oracle）逐字相同；对 symlink/FIFO 夹具新实现返回 `unknown`（有意变更，§2.2.1）；`probeCodexDaemonLiveness` 路径不打开 `<socket>.lock`（用注入的 `isPidAlive` 断言未被调用 + 不存在 lock 时也不 stat） |
| T-RQ-1 | `packages/teamlead/src/bridge/__tests__/run-quiescence.test.ts` | 既有 4 条不改，全过 |
| T-RQ-2 | 同上 | evidence `{unknown, missing, false, absent}` + `status:"failed"` ⇒ generic 被调（参数含 `allowMissingTargetHostAbsence:true`），evidence 被调 **两次**（终复核），结果 `"dead"` |
| T-RQ-3 | 同上 | 同 T-RQ-2 但 `status:"blocked"` ⇒ 同样放行；`ledger:"no_group"` 与 `spawnLock:"stale"` 两个变体 ⇒ `"unknown"`，generic **未**被调（Codex R2 HIGH：fail-closed） |
| T-RQ-4 | 同上 | evidence 同 T-RQ-2 + `status:"running"` ⇒ `"unknown"`，generic **未**被调 |
| T-RQ-5 | 同上 | evidence 同 T-RQ-2 + `status` 缺失 ⇒ `"unknown"` |
| T-RQ-6 | 同上 | `socketLive:true` + `status:"failed"` ⇒ `"unknown"` |
| T-RQ-7 | 同上 | `ledger:"valid_group"` + `status:"failed"` ⇒ `"unknown"`（FLY-1940） |
| T-RQ-7b | 同上 | `ledger:"unreadable"` + 其余全满足 + `status:"failed"` ⇒ `"unknown"`（Codex R1 HIGH） |
| T-RQ-7c | 同上 | `spawnLock:"live"` 与 `spawnLock:"unreadable"` + 其余全满足 + `status:"failed"` ⇒ `"unknown"` |
| T-RQ-8 | 同上 | 旧注入 `probeCodexDaemon: () => "unknown"` + `status:"failed"` ⇒ `"unknown"`（兼容口 fail-closed） |
| T-RQ-9 | 同上 | evidence 同 T-RQ-2 + `status:"failed"` + generic 返回 `"alive"` ⇒ `"alive"`（放行不等于判死），evidence 只被调一次 |
| T-RQ-10 | 同上 | **终复核**：第一次 evidence 零证据、generic `"dead"`、第二次 evidence 变为 `spawnLock:"live"`（或 `ledger:"no_group"` / `socketLive:true`）⇒ `"unknown"` |
| T-RQ-11 | 同上 | **pre-persist parent-crash 时间线回归**（Codex R2 HIGH）：evidence `{unknown, ledger:"no_group", socketLive:false, spawnLock:"stale"}` + `status:"failed"` + generic 返回 `"dead"` ⇒ `"unknown"`，generic **未**被调 |
| T-RQ-12 | 同上 | **storeFacts 门**（Codex R3/R4 HIGH）：T-RQ-2 的夹具但 (a) 不传 `storeFacts` ⇒ `"unknown"`；(b) `failureKind:"goal_blocked"` / 缺失 ⇒ `"unknown"`；(c) `launchClaimState:"active"` / `"starting"` / `"cancelled"` / 缺失 ⇒ `"unknown"`；generic 均未被调 |
| T-EV-1 | `packages/teamlead/src/__tests__/event-route*.test.ts` | POST `/events` `session_failed` + ingest token + `payload.failure.failureKind="worktree_takeover_failed"`（含伪造 `source:"direct-event-sink"`）⇒ 400 `pre_adapter_failure_kind_http_forbidden`；无 receipt、无 `session_failed` 事件、status 不变；审计事件 `events_pre_adapter_kind_rejected` 一条 |
| T-EV-2 | 同上 | 同上但 `failureKind="goal_blocked"` ⇒ 200（既有 `:1961-1998` 用例改 kind 后保留），`recordEnrolledTerminalSignal` 收到的 `source === "http-events"` |
| T-EV-3 | 同上（或 `scripts/__tests__`） | 源码守卫：`grep -c recordPreAdapterFailureReceipt packages/teamlead/src/bridge/event-route.ts` 为 0；`DirectEventSink.ts` 为 1 |
| T-DS-1 | `packages/teamlead/src/__tests__/DirectEventSink*.test.ts` | `emitFailed(env, error, undefined, {failureKind:"worktree_takeover_failed", failureReason})` ⇒ receipt 一行（execution_id / failure_kind / source_event_id）；重复 emit 幂等；`goal_blocked` ⇒ 无 receipt |
| T-RT-1 | `scripts/__tests__/fly-2006-database-retention-sweep.test.ts` | 新表在 `protectedCurrentOrReference`，硬计数 +1，fixture 排序通过 `assertClassifiedSchema` |
| T-RQ-13 | 同上 | **root 漂移 / 证据被 unlink 反例**：`failureKind:"goal_blocked"`（真实 spawn 过的体）+ 三轴 `missing/false/absent` + generic `"dead"` ⇒ `"unknown"`（门 (2) 挡住，不依赖文件系统） |
| T-RQ-14 | 同上 | **no_group + 已释放锁的组合回归**（Codex R3 MEDIUM）：`failureKind:"worktree_takeover_failed"` + claim closed + evidence `{unknown, ledger:"no_group", socketLive:false, spawnLock:"absent"}` ⇒ `"unknown"`，generic 未被调 |
| T-LC-1 | `packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts` | **生产默认探针路径**：`FLYWHEEL_CODEX_SESSION_DIR` / `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT` 指向空临时目录；seed `failed` + `adapter_type:"codex-tmux"` + `store.recordPreAdapterFailureReceipt({failureKind:"worktree_takeover_failed"})` + launch claim `closed`；`closeRunnerFn` 返回 `preserved`；**不覆盖** `probeExecutionLiveness`（走 lifecycle-closeout 的默认闭包，只注入 `probeGeneric: async () => "dead"` 经 deps 透传，或在测试里 stub `probeGeneralizedLaunchLiveness` 模块导出）；`lookupTarget` gone；期望 `outcome:"complete"`、节点 `confirmedGone:true`、`communicationsFinalized:true`、`teardown:{state:"skipped",reason:"crash_preserve"}`，`finalizeCommDbSessionFn` 被调一次 |
| T-LC-2 | 同上 | 同 T-LC-1 但临时目录里写入 `session.json{daemonPgid:<注入 processGroupState="alive" 的组>}`（或注入 `probeCodexDaemonEvidence` 返回 `ledger:"valid_group"`）⇒ `outcome:"blocked"`、`blockedBy` 含 `confirmed_gone_false`（守卫 3） |
| T-LC-2b | 同上 | 同 T-LC-1 但 session.json 为损坏 JSON ⇒ blocked（守卫 3a）；同 T-LC-1 但 `<socket>.lock` 存在且 holder = `process.pid`（本测试进程，必活）⇒ blocked（守卫 3b）；同 T-LC-1 但 lock holder 为已死 pid（先 spawn 一个立即退出的子进程取其 pid）⇒ blocked（守卫 3b stale）；同 T-LC-1 但 session.json 只含 `codexAgentHome` ⇒ blocked（守卫 3c） |
| T-LC-3 | 同上 | 同 T-LC-1 但 seed 状态 `running` 且 closeRunnerFn 仍返回 preserved（模拟并发改状态）⇒ blocked（守卫 5） |
| T-LC-4 | 同上 | 同 T-LC-1 但 (a) 无 receipt、只 `insertEvent(session_failed, payload.failureKind="worktree_takeover_failed", source:"direct-event-sink")`（模拟 HTTP 伪造）⇒ blocked；(b) receipt 为 `goal_blocked` ⇒ 写不进（`kind_not_pre_adapter`）⇒ blocked；(c) claim `active` / `cancelled` ⇒ blocked（守卫 3f/3g/3j） |
| T-CC-1 | `packages/teamlead/src/bridge/__tests__/land-closeout-cause.test.ts` | blocked 报告：节点 `transition:skipped`、`teardown:{skipped,crash_preserve}`、`confirmedGone:false`、`communicationsFinalized:false` ⇒ `nodes_not_confirmed_gone`；`landIssueCloseoutResultFromClosureReport` ⇒ `{outcome:"blocked", cause:"nodes_not_confirmed_gone"}` |
| T-CC-2 | 同上 | 同时存在 `teardown.state:"failed"` error（如 `commdb finalize`）⇒ 仍取 error 推导（优先级 1） |
| T-CC-3 | 同上 | `transition:{blocked, prerequisite:"authority_reopened"}` + `confirmedGone:false` ⇒ `lifecycle_conflict`（优先级 2 高于 3） |
| T-CC-3b | 同上 | `transition:{done}`（及 `{skipped}` 变体）+ `teardown:{skipped, reason:"authority_reopened"}`（及 `authority_unknown`）+ 两个 false 布尔 ⇒ `lifecycle_conflict`（Codex R1 MEDIUM 的真实形状） |
| T-CC-4 | 同上 | `landCloseoutCauseFromReason("retry_exhausted:issue_closeout_incomplete:cause=nodes_not_confirmed_gone")` ⇒ `nodes_not_confirmed_gone`；`describeLandCloseoutCause` 含「尚未被证明已消失」；`renderLandThreadNotification` 不含 `{` |
| T-PS-1 | `packages/teamlead/src/__tests__/post-ship-finalization.test.ts` | `issueCloseout` 返回 `{outcome:"blocked", cause:"nodes_not_confirmed_gone"}` ⇒ 返回 `reason === "issue_closeout_incomplete:cause=nodes_not_confirmed_gone"`、`cause.token` 同 |
| T-PS-2 | 同上 | `{outcome:"conflict"}` 无 cause ⇒ `cause=lifecycle_conflict`；`{outcome:"blocked"}` 无 cause ⇒ `cause=unknown` |
| T-ST-1 | `packages/teamlead/src/__tests__/close-runner.test.ts` | `import { CRASH_PRESERVE_STATES } from "../bridge/close-runner.js"` 与 `"../bridge/close-runner-states.js"` 是同一对象（`toBe`） |

测试命令（本 worktree 已验证需先 `pnpm install --offline --frozen-lockfile` 与 `pnpm -r --filter "flywheel-teamlead^..." build`）：

```bash
pnpm --filter flywheel-claude-runner exec vitest run test/codex-daemon-runtime.test.ts
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/run-quiescence.test.ts \
  src/bridge/__tests__/lifecycle-closeout.test.ts \
  src/bridge/__tests__/land-closeout-cause.test.ts \
  src/__tests__/post-ship-finalization.test.ts \
  src/__tests__/close-runner.test.ts
pnpm -r typecheck && pnpm biome check packages/teamlead/src packages/claude-runner/src
```

## 5. 上线、回滚与现网收敛

- **上线**：普通 PR 合入 main；部署由独立 updater 在其窗口重启 Bridge（本节点与实现节点都不重启服务）。
- **回滚边界**：`git revert` 单 PR；additive 表 `pre_adapter_failure_receipts` 留在库里无害（旧代码不读）。回滚后行为回到「零证据 ⇒ unknown」，不会产生新的错误判死。
- **现网收敛的前提**：receipt 只对合入后新发生的 takeover 失败写入；FLY-2351 / FLY-2382 的两具体是旧数据、没有 receipt，**修复合入后 resume 仍会 blocked**。收敛路径二选一，由 Lead 决定：(i) 一次性运维脚本按快照证据（`session_failed` 事件 `source='direct-event-sink'` + `failureKind` + claim closed + 无 state dir）为这两具体补写 receipt（脚本走 StateStore API，`source_event_id` = 原事件 id，PR 里附脚本与 dry-run 输出）；(ii) 不补写，两个 held op 由 Lead 按 FLY-2486 形状人工收尾。plan 默认 (i)：c6 交付脚本但**不在本 PR 执行**。
- **现网收敛（Lead 手动，一次性）**：Bridge 跑上含修复的 buildSha 后，对 research §6 的两个 held op 各调一次：

```bash
curl -sS -X POST "$BRIDGE/api/lifecycle/land/land:63068a7b30f514a9054ed816913c8865c5fdef4e95c088a2daaf2e392b38caa4/resume" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"actor":"flywheel-eng-lead","reason":"FLY-2490 fix deployed; never-launched codex node now provable dead"}'
# FLY-2382 的 operation_id 以当时 land_operation 表为准（research §6）
```

- **收敛验收 SQL**（只读快照）：`SELECT payload FROM session_events WHERE issue_id='FLY-2351' AND event_type='closeout_report' ORDER BY ts DESC LIMIT 1` 的 `outcome` 为 `complete`；`land_operation.state` 离开 `held`。若仍 blocked，`closeout_issue_items_blocked` 会指出节点与 `blockedBy`，land 的 reason 变为 `…cause=nodes_not_confirmed_gone`（不再是 `lifecycle_conflict`）。

## 6. 可观测性

- 不新增事件；`lead_close_runner_preserved` 仍写一次（event_id 去重）。
- land 告警 / thread 文案通过 `describeLandCloseoutCause` 自动获得新 token 的中文说明。
- 判死后 `recordCommDbFinalizeOutcome(runnerDeathProven:true, source:"bridge.lifecycle-closeout")` 由既有路径记录。

## 7. 实施分块（progress ledger chunk id）

| chunk | 内容 | 完成判据 |
|---|---|---|
| c1 | `close-runner-states.ts` 抽出 + re-export + T-ST-1 | teamlead typecheck 过；`close-runner.test.ts` 全过 |
| c2 | `readPersistedDaemonLedger` + inspection 单次读取 + `inspectDaemonSpawnLock` + `probeCodexDaemonEvidence` + index 导出 + T-CR-1..4（含 1b/3b/3c） | claude-runner 测试过；`probeCodexDaemonLiveness` 对 regular-file 夹具 parity，且不碰 lock |
| c3 | `PRE_ADAPTER_FAILURE_KINDS`（core + 运行时 re-export，§10.1）+ `pre_adapter_failure_receipts` DDL + StateStore 两方法 + retention registry 三处（§2.6.3）+ `run-quiescence.ts` 分支（storeFacts 四道门 + 终复核）+ T-RQ-1..14 + T-RT-1 | 真值表八行各有用例；T-RQ-3 的 no_group/stale、T-RQ-12/13/14 的 storeFacts/root 漂移/已释放锁反例全部 fail-closed |
| c4 | `DirectEventSink.emitFailed` receipt 写入 + `event-route.ts` 拒绝/source 固定 + `lifecycle-closeout.ts` storeFacts 接线 + T-DS-1、T-EV-1..3、T-LC-1、2、2b、3、4 | 生产默认探针 + 默认 storeFacts 闭包在测试里走通；损坏 JSON / live lock / stale lock / no_group / 非白名单 failureKind / active claim 六个负向都 blocked |
| c5 | cause 词表 + post-ship 回落 + T-CC-1、2、3、3b、4 + T-PS-1..2 | 标签正确；authority 两种形状（`transition.prerequisite` / `teardown.reason`）都是 `lifecycle_conflict` |
| c6 | 全量 `pnpm -r typecheck` + 相关包 vitest + biome + `scripts/__tests__` retention 套件；一次性补写 receipt 的运维脚本（dry-run 输出附 PR，不执行）；PR 描述附 research §6 清单与 §5 resume 命令 | CI 绿 |

### 4.1 测试实现须知（吸收 Gemini R1 三条 LOW）

1. 报告夹具里的 FSM 字面量（`state: "failed"`、`"blocked"`、`"skipped"`）一律 `as const` 或显式类型，与 `land-closeout-cause.test.ts:62` 现有写法一致，避免 `pnpm -r typecheck` 在测试文件上报错。
2. T-LC-1..3 / T-CR-1..4 用 `mkdtempSync(join(tmpdir(), "fly2490-"))` 建独立目录，在 `afterEach` 里恢复 `process.env.FLYWHEEL_CODEX_SESSION_DIR` / `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT` 原值并 `rmSync(dir, { recursive: true, force: true })`；vitest 并行 worker 之间不共享目录。socket 路径受 `SUN_LEN` 限制（`assertSocketPathFitsSunLen`），临时根目录用 `tmpdir()` 而不是仓库路径。
3. 新模块间 import 一律带 `.js` 后缀（`"./close-runner-states.js"`），与仓库 ESM 约定一致；re-export 用 `export { … } from "./close-runner-states.js"`。

## 8. 假设与已知边界

- 假设 Bridge 进程与 `CodexTmuxAdapter` 同进程、同 `process.env`（`run-infra.ts` 实例化），故 `FLYWHEEL_CODEX_SESSION_DIR` / `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT` 对探针与适配器一致。
- 「spawn 与写 `daemonPgid` 之间」的窗口（Bridge 死于 pre-persist）会在重启后被 heartbeat 转成 `failed`（Codex R2），但那类体的 `failureKind` 不在白名单（它们没有 Blueprint 产生的 `session_failed` 结构化 failureKind），且 ledger 是 `no_group`：门 (2) 与门 (4) 都挡住。
- 本单不让 run quiescence 对 `completed` 的零证据 Codex 体判死（它们必然有 `daemonPgid`），也不处理 held 列表的自动 resume。

## 9. 评审记录与 Lead 裁定

| 轮次 | 评审者 | 结论 | 处置 |
|---|---|---|---|
| R1（Codex） | Codex companion, xhigh | **未产出**：本机 Codex primary（personal）用量上限，提示 2026-09-17 恢复；反馈文件未写出 | 向 Lead 提非阻塞问题 `cd22cf2c-8d3c-46b3-8f4e-b95b8d7138dd` |
| Lead 裁定 | flywheel-eng-lead, 2026-09-11 18:21Z | 不切共享 `~/.codex`（school 9/16、business 9/14、personal 9/17 全部打满）；等 Codex 最多 30 分钟，未恢复走 gemini-design-review，阻塞级 finding 修完后 design-review.json 写 APPROVED + leadAcceptance{instructionId: cd22cf2c…, codexFinalVerdict: not_run_pool_exhausted} | 照办 |
| R1（Gemini） | gemini-cli 0.59.0（个人 OAuth 通道已被 Google 下线，改用 API-key 认证、隔离 HOME） | **APPROVED**，3 条 LOW（测试 `as const`、临时目录隔离与清理、`.js` import 后缀） | 全部吸收进 §4.1；无阻塞级 finding；原文 `gemini-review-round1.md` |
| R1（Codex，恢复后） | Codex companion, xhigh, 2026-09-11 ~19:00Z | **CHANGES REQUESTED**：HIGH `persistedGroup:false` 把不可读/损坏 ledger 与「从未记录」混同且漏 spawn lock；MEDIUM authority 丢失的真实形状在 `teardown.reason`（transition 已 done/skipped）会被误标 `nodes_not_confirmed_gone`；LOW importer 清单漏 `plugin.ts` / `post-ship-finalization.ts`、`terminal-tab-reaper.ts` 非 importer、`validateRunQuiescenceEvidenceTx` 已 neutralized | 全部吸收：§2.2 四态 ledger + 四态 lock + 零证据定义；§2.3 八行真值表；§2.4 `teardown.reason` 匹配；§3 守卫 3a/3b；§4 新增 T-CR-1b/3b/3c、T-RQ-7b/7c、T-LC-2b、T-CC-3b；§2.1 与 research §2/§4 更正。plan v1.2 |
| R2（Codex） | Codex companion, xhigh, 2026-09-11 ~19:40Z | **CHANGES REQUESTED**：HIGH `stale` lock 只证明 Bridge 死、不证明 detached daemon 死（pre-persist parent-crash → heartbeat 转 failed → generic pgrep clean-miss）；MEDIUM 解析把 `null`/非法 pid 归到可放行态、lock pid 未要求 safe integer、ledger 读取无 O_NONBLOCK/大小上限；MEDIUM 三值 probe「逐字不变」不成立（多开 lock、O_NOFOLLOW 改 symlink 结果、ledger 读两次）；LOW research §5 / chunk 表漂移 | 全部吸收：零证据收窄为 `missing + absent + socket dead`，`stale`/`no_group` fail-closed（§2.2.3、§3 3b/3c）；generic 判死后终复核（§2.3、3d）；解析规则 hasOwn / safe-int>1 / 抛错⇒unreadable / O_NONBLOCK+fstat+1 MiB（§2.2.1-2）；inspection 单次读取、三值 probe 只投影不碰 lock、symlink/FIFO 变更明示为有意（§2.2.1、3e）；T-RQ-3/10/11、T-CR-3b/3c/4、T-LC-2b 更新；research §3/§5、§7 chunk 表同步。plan v1.3 |
| R3（Codex） | Codex companion, xhigh, 2026-09-11 ~20:20Z | **CHANGES REQUESTED**：HIGH 三轴缺席只是「当前 root 当前时刻无证据」（root 漂移 / daemon 自 unlink / 终复核后仍可 spawn），建议只对可证明发生在 `adapter.execute()` 前的失败类别放行并要求 claim 已终结；MEDIUM lock-release 不变量强于实现（`ensureDead` 不等进程组退出、`killTree` 退化）；LOW research/§8/§3.2 漂移 | 全部吸收：§2.3.1 `PRE_ADAPTER_FAILURE_KINDS` + `storeFacts` 钩子（只在 lifecycle-closeout 接线）+ 四道门 + 终复核；§2.2.3 改为「ledger 承重、lock 辅助」并补 T-RQ-14；§3 3f/3g/3h、§3.2、§8、research §1/§2/§3/§5 同步；T-RQ-12/13、T-LC-4。plan v1.4。三轮未过 ⇒ 按安全阀问 Lead（581f8ca0） |
| Lead 裁定 | flywheel-eng-lead, 2026-09-11（581f8ca0） | 选 (A)：在 v1.4 上跑 R4 确认轮，范围只验 R3 三条；新 LOW/MEDIUM 进 follow-up 不修；新 BLOCKER 不动、原文上报。APPROVED ⇒ 正常 design_review gate；若仍只是同三条的更窄反例 ⇒ 不开 R5，Lead 做 leadAcceptance。白名单边界：以 `worktree_takeover_failed` 起步，**只加 StateStore 能证明发生在 `adapter.execute()` 之前的类别** | 照办；边界写入 §2.3.1 |
| R4（Codex，Lead 授权确认轮） | Codex companion, xhigh, 2026-09-11 ~20:50Z | **CHANGES REQUESTED**：R3 三条确认闭合（What's Good）；**新 BLOCKER** HIGH：`session_failed.payload.failureKind` 来自 Runner 可写的 `/events`（Runner 持 `FLYWHEEL_INGEST_TOKEN`，`event-route.ts:1586-1612` 明示 untrusted），可伪造白名单值；`cancelled` claim 可与已出生 Runner 共存（`lifecycle-closeout.ts:1236-1246`）；建议 Bridge-local provenance receipt 或最小入口隔离（`/events` 拒绝白名单 kind + source 由 Bridge 赋值 + storeFacts 只认 Bridge-local）。MEDIUM（follow-up）core `index.ts` 需运行时 re-export；LOW（follow-up）§2.2.3 一句旧 lock 论证 | 按 581f8ca0：新 BLOCKER 未动，原文上报 Lead（1bc772cf）；MEDIUM/LOW 记入 §10 |
| Lead 裁定 | flywheel-eng-lead, 2026-09-11（1bc772cf） | 选 (B)：R4 HIGH 是真实新面，不准当 follow-up；承重事实必须是 HTTP 伪造不了的 Bridge-local provenance（优先 durable pre-adapter receipt，只读它）；先核实合法发出者与 sink（写进 plan）；吸收成 v1.5 后开 R5，范围只验 provenance；R5 绝对终轮 | 照办：§2.6 核实结论 + receipt 表 + `/events` 拒绝 + claim 只认 closed；plan v1.5 |
| R5（Codex，终轮） | Codex companion, xhigh, 2026-09-11 ~21:40Z | **CHANGES REQUESTED**（同一条 provenance 的更窄反例）：R4 的 HTTP 伪造路径确认关闭（producer 核实成立、`/events` 拒绝、storeFacts 不读 session_events、claim 只认 closed、crash ordering fail-closed、registry 合同）；剩余 HIGH：receipt 所在 `teamlead.db`（`config.ts:200-202`）处于 Codex Runner sandbox 的可写 root `~/.flywheel`（`codex-daemon-adapter-helpers.ts:23-45`）且 Runner 环境拿到 `FLYWHEEL_STATE_DB_PATH`（`CodexTmuxAdapter.ts:2432`），Runner 可绕过 TypeScript 写入点直接 SQL 插 receipt（同理可改 status / claim）；建议 Bridge-only store、或 Bridge-only key 的 MAC、或收窄 sandbox root 排除 StateStore 主文件与 -wal/-shm | 按 1bc772cf「同一条更窄反例 ⇒ 不开 R6，原文报 Lead」：全文 `codex-review-round5.md`，上报 Lead 做 leadAcceptance；物理边界作 §10.4 follow-up |
| Lead 裁定（终） | flywheel-eng-lead, 2026-09-11（ff471511） | 选 (A) leadAcceptance：R5 是同一 provenance 谱系的更窄反例，物理 DB 边界是 StateStore 所有既有承重事实共有的面，不由本单修；基础设施前置单（收窄 sandbox writable root 排除 StateStore 主文件及 -wal/-shm，或 Bridge-only store/HMAC）由 Lead 另开，本单不等它 | design-review.json：rounds=5、codexFinalVerdict=CHANGES_REQUESTED@R5(same provenance lineage, physical DB boundary)、residue=§10.4、instructionId=ff471511-4799-4146-8fa2-1acea8256532；正常 design_review gate 交接 |

残留：（v1.2 起）Codex 已恢复并进入评审循环；Gemini R1 保留为补充证据。实现节点的 Codex code review 仍按常规执行。

## 10. Follow-ups（Codex R4 按 Lead 规则不在本轮修）

1. **core 运行时 re-export（MEDIUM）**：`packages/core/src/index.ts:20-32` 对 `adapter-types.ts` 只有 `export type { … }`；实现时需加 `export { PRE_ADAPTER_FAILURE_KINDS } from "./adapter-types.js"`（并补一条 teamlead 侧 import 的编译/运行时用例），否则 `flywheel-core` 拿不到运行时常量。归属位置若改到 teamlead 内部叶子模块也可，但要在 §1 变更清单同步。
2. **§2.2.3 旧 lock 论证（LOW）**：已在原论证前加否定说明；实现者以 §2.2.3 首段与 §2.3.1 门 (2) 为准。
3. **`event-route.ts:1496` 通用 `insertEvent` 仍透传客户端 `event_type` / `source`**：本单只把 `session_failed` 分支的 `source` 固定为 `"http-events"`；通用插入的 provenance 治理是独立单（它不承重任何放行判定）。
4. **receipt 的物理写边界（Codex R5 HIGH，Lead 裁定后的 follow-up）**：`~/.flywheel` 整体是 Codex Runner sandbox 的可写 root，`teamlead.db` 及 `-wal/-shm` 对 Runner 可写，且 Runner env 含 `FLYWHEEL_STATE_DB_PATH`。这不是本单引入的面——StateStore 里所有既有事实（status、launch claim、disposition intent、founder gate 判决）同样处于该边界内。可选修法（独立单）：(a) receipt 加 Bridge-only key 的 HMAC（key 放 Runner 不可读位置，读取时验证）；(b) 收窄 Codex sandbox writable roots 为必要子目录并显式排除 StateStore 主文件与 `-wal/-shm`；(c) Bridge-only durable store。本单的 receipt 表在 (a)/(b) 任一落地前，与 StateStore 其它事实同等可信。
