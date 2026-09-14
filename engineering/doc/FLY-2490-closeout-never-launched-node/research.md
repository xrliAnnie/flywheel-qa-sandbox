# FLY-2490 shipped 收尾对「起步即 failed 的 Codex 空体」永久保留 — 调研

Issue: FLY-2490 (https://linear.app/geoforge3d/issue/FLY-2490/病根-shipped-收尾对起步即-failed无窗口无-commdb-行的体不强清closerunner-的-crash-preserve)
日期: 2026-09-11
基于: exploration.md

## 1. 三个候选修点的对比

| 修点 | 做法 | 否决 / 采纳 |
|---|---|---|
| A. `closeRunner` preserve 门前置「无 target ⇒ alreadyGone」 | 把 `getTmuxTargetFromCommDb` 提到 :484 之前，无 CommDB target 的 failed 体直接走 `alreadyGone` | **否决**。CommDB 行在 finalize 时被删（快照里 592 个 failed/blocked 无 tmux 的行只有 9 个还有 CommDB 行），「无行」不是「从未起过」；且 `closeRunner` 是 Lead/founder 的 reserved action 入口，这里放宽等于把「CommDB 行被删过」的崩溃体都判死，正是 FLY-2313 修掉的那类假死。 |
| B. `closeoutOneNode` 对 shipped + failed 传 `forcePreserved:true` | issue 描述的第二方向 | **否决**。`forcePreserved` 会让 `closeRunner` 走 kill 序列：有窗口的崩溃体在 shipped 收尾时会被杀窗，破坏 FLY-116「崩溃窗留给人看」。而且它对本体也没必要——本体的问题不在门，在证据。 |
| C. `probeRunExecutionLiveness` 区分「零 daemon 证据」与「daemon 状态不确定」 | Codex 探针在 session.json 不存在、spawn lock 不存在、socket 无人监听、且 StateStore 状态 ∈ `{failed,blocked}` 时，放行到 generic 探针（三重缺席才判死，判死后再复核一次） | **采纳**。既有救援路径（`lifecycle-closeout.ts:1481`）与既有测试（`lifecycle-closeout.test.ts:460`）已证明 `dead + gone ⇒ complete`；只补证据源这一格，`closeRunner` 零改动。 |

加一条独立的标签修正 D：`landIssueCloseoutResultFromClosureReport` 对 `blocked` 报告从节点的 `confirmedGone / communicationsFinalized / transition.prerequisite / teardown.reason` 推出 cause；post-ship 只在 `conflict` 时回落 `lifecycle_conflict`。

## 2. 修点 C 的消费者 sweep（`probeRunExecutionLiveness` 全部生产调用点）

| 调用点 | 传入的 session | 对返回值的用法 | 本单影响 |
|---|---|---|---|
| `bridge/lifecycle-closeout.ts:1200` | `store.getSession(executionId)` | `"dead"` ⇒ 救援路径判死 | **目标路径，也是唯一接 `storeFacts` 钩子的调用者**（v1.4；v1.5 起钩子只读 `pre_adapter_failure_receipts` + launch claim，不读 `session_events`）。只对 `preserved`（closeRunner 已确认 status ∈ failed/blocked）节点调用 |
| `bridge/close-runner.ts:935` | `session`（完整行） | 只在 `target.tmuxWindow` 以 `:pending` 结尾且（CommDB 已 ended 或 crash status）时调；`"dead"` ⇒ `runnerDeathProven` | 不传 `storeFacts` ⇒ Codex 分支字节不变（v1.4） |
| `bridge/post-merge.ts:254` | `session` | `:pending` + CommDB ended ⇒ `physicalGone` | 同上，字节不变 |
| `bridge/plugin.ts:7564`（quota admission replay 的 `liveness` 端口） | `store.getSession` | 三值透传 | 不传 `storeFacts` ⇒ 字节不变；`run-recovery.ts:214` 同一端口，同样不变（v1.4 收窄） |
| `workflow-template-selection.ts:370` / `bridge/runs-route.ts:589,787,1295` 经 `collectRunQuiescenceEvidence` | `store.getSession` | run hold / terminate / dead-exec sweep 的证据。**注意**（Codex R1 LOW 更正）：`StateStore.validateRunQuiescenceEvidenceTx`（`:39043`）已按 founder 2026-07-24 指令 neutralized（恒 `ok:true`），**不再**重查任何东西；只有 `validateNeedsLeadReworkQuiescenceTx`（`:39058`，替换 fenced needs_lead activation 前）仍检查 status / lifecycle_revision / 新鲜度 / dead。所以不能把「线性化点重查」当作安全栅栏——放行条件必须在探针内部自足（ledger + socket + lock + status 四重门） | 不传 `storeFacts` ⇒ 字节不变（v1.4）。FLY-2456 演练里「起步即失败体拖住 run」那一族**不**由本单顺带修复，留作 follow-up（接线 `storeFacts` 即可，但要单独评审 run 级后果） |

`probeCodexDaemonLiveness` 的另一个直接消费者 `bridge/plugin.ts:8187`（Codex recovery runtime 的 `probe`）**不改**：那条线 `unknown` 语义是「别 revive」，保持 fail-closed。本单不改 `probeCodexDaemonLiveness` 的签名和返回，只新增一个更丰富的只读函数。

## 3. daemon 证据的真值表（`inspectCodexDaemonOwnership`，`codex-daemon-runtime.ts:150-212`）

| `session.json.daemonPgid` | socket 有人监听 | 进程组 | 现返回 | 新语义 |
|---|---|---|---|---|
| 无 | 否 | — | `unknown` | **`no_evidence`**（新）：从未 spawn，或 spawn 后持久化失败已被 kill（`onSpawnIdentity` fail-close） |
| 无 | 是 | — | `unknown` | `unknown`（有人在 socket 上，可能是持久化前的极窄窗口或残留 holder）—— fail-closed 不变 |
| 有 | 否 | absent | `absent` | 不变 |
| 有 | 否 | alive/unknown | `unknown` | 不变 |
| 有 | 是 | alive 且 holder ∈ 组 | `alive` | 不变 |
| 有 | 是 | 其它 | `unknown` | 不变 |

**Codex R1 HIGH 更正**：上表的「无 pgid」在现有 `readPersistedDaemonPgid` 里是把 ENOENT、EACCES、损坏 JSON、非法 pgid 全部折成 `undefined`，所以「无 pgid」≠「从未记录」。plan §2.2 把它拆成 `missing / no_group / valid_group / unreadable` 四态；v1.3 起只有 `missing` 可进入零证据组合（`no_group` 见下一段），`unreadable` 永远 `unknown`。另外 spawn 前先拿 `<socket>.lock`（`codex-daemon-runtime.ts:652`），失败 cleanup 无法证明 daemon 死时锁被保留（`:934-940`），所以锁是第三路证据（v1.2 曾允许 `stale`，v1.3 起只认 `absent`，见下一段）。

**Codex R2 HIGH 再收窄**：`stale` lock（holder = Bridge pid 已死）不能证明 detached daemon 已死——Bridge 在 `spawnFn` 返回之后、同步 `onSpawnIdentity` 写 pgid 之前被 SIGKILL/OOM 杀掉，child 仍在自己的进程组里活着且可能尚未 bind socket；重启后 heartbeat 的 orphan aging 可把行转 `failed`（`HeartbeatService.ts:895-943, 2043-2113`），而 daemon argv 只有 `--listen unix://<sha1 socket>`，`pgrep -f execId` 会 clean-miss。`no_group` 与这个 pre-persist 窗口同形。所以 plan v1.3 只放行 `ledger:"missing" ∧ spawnLock:"absent" ∧ socket 无人`，并在 generic 判死后终复核一次。**留下的 follow-up**（本单不做）：Bridge 死于 pre-persist 窗口的 Codex 体（`no_group` + `stale`）仍永远 `unknown`；要覆盖它需要一条「按精确 socket 路径枚举 app-server 进程」的独立证据轴（可复用 `codex-runner-orphan-reaper.ts` 的解析思路，枚举失败必须 `unknown`）。

**Codex R3 HIGH 定稿**：三轴缺席（session.json 不存在 ∧ lock 不存在 ∧ socket 无人）只是「当前 root、当前时刻」无证据——root 漂移（`codex-daemon-runtime.ts:60-95` 全按当前 env 解析）、同 UID daemon 自己 unlink 证据（workspace-write roots 含整个 `~/.flywheel`，`codex-daemon-adapter-helpers.ts:30-45`）、终复核之后才 spawn，都能让活 daemon 与三轴缺席共存。所以 plan v1.4 的承重证据改为 **StateStore 的结构化失败记录**（`failureKind ∈ PRE_ADAPTER_FAILURE_KINDS`，目前只有 `worktree_takeover_failed`，由 `Blueprint.ts:1470-1480` 在 `adapter.execute()`（`:3105`）之前 return 产生）+ launch claim 已 `closed`（快照：该族 57 具全部 closed；`cancelled` 可与已出生 Runner 共存，不认）。

**Codex R4 HIGH（provenance）定稿**：`session_failed` 事件本身不能当承重记录——`/events`（`event-route.ts:1496`）把 `event_type` / `payload` / `source` 原样写入 `session_events`，`:1388-1414` 又把 `payload.failure.failureKind` 交给 `recordEnrolledTerminalSignal`，而 Runner 持有 `FLYWHEEL_INGEST_TOKEN`（`CodexTmuxAdapter.ts:2422`）。核实：`worktree_takeover_failed` 的合法发出者只有 Bridge 进程内的 `DirectEventSink`（Blueprint 的 emitter = `DirectEventSink`，`run-infra.ts:664/944`；HTTP emitter `TeamLeadClient` 无生产实例；`flywheel-comm` 无发 `session_failed` 的命令）。因此 plan v1.5 §2.6：新增只由 `DirectEventSink.emitFailed` 写的 `pre_adapter_failure_receipts` 表，`storeFacts` 只读它；`/events` 对白名单 kind 返回 400 并审计；HTTP `session_failed` 分支的 `source` 由 Bridge 固定为 `"http-events"`。先例：FLY-1372 的 Bridge 可信字段只由 DirectEventSink 持久化（`event-route.ts:1605-1612`）。从未进入适配器的 execution 在任何 root 下都没 spawn 过 daemon；三轴缺席与 generic 三重缺席退为一致性核对。区分 `missing` 的承重事实是 spawn 前的 `persistLaunchSnapshot`（`CodexTmuxAdapter.ts:1088-1113`）——pre-persist 窗口对应的是 `no_group`，不是 `missing`。

## 4. 状态门：为什么是 `failed | blocked`，且如何拿到它

- closeout 只对 `closeRunner` 返回 `preserved:true` 的节点调救援探针，而 preserve 门只对 `CRASH_PRESERVE_STATES = {failed, blocked}` 触发 ⇒ 目标路径天然在这两个状态内。
- 对 run quiescence 等其它调用者，把放行也限制在这两个状态，是「最窄改动」：`completed` 的 Codex 体必然写过 `daemonPgid`（否则 goal 不会跑起来），`terminated/rejected/…` 由 `closeRunner` 的 AUTO_CLOSE 路径直接 kill/alreadyGone，不需要探针放行。
- 循环 import：`close-runner.ts` 已 `import { probeRunExecutionLiveness } from "./run-quiescence.js"`；`run-quiescence.ts` 若反向 import `CRASH_PRESERVE_STATES` 会成环。处理：把 `AUTO_CLOSE_STATES / CRASH_PRESERVE_STATES / FINALIZE_DONE_SOURCE_STATES / CLOSE_ELIGIBLE_STATES` 四个常量抽到叶子模块 `bridge/close-runner-states.ts`，`close-runner.ts` 原样 re-export。现有生产 importer（零改动）：`commdb-fsm-reconcile.ts`、`actions.ts`、`lifecycle-closeout.ts`、`plugin.ts:247`（`CLOSE_ELIGIBLE_STATES`）、`post-ship-finalization.ts:32`（`FINALIZE_DONE_SOURCE_STATES`）；测试 `close-runner.test.ts`。`terminal-tab-reaper.ts:25` 是本地副本、`done-thread-reconcile.ts:59` 是注释约束，都不是 importer（Codex R1 LOW 更正）。一个词表，不镜像。
- `probeRunExecutionLiveness` 的 `session` 形参从 `Pick<Session,"adapter_type">` 放宽为 `Pick<Session,"adapter_type"> & Partial<Pick<Session,"status">>`：全部生产调用者都传完整行；`status` 缺失时视为不满足门（fail-closed），既有的 `{ adapter_type: "codex-tmux" }` 测试字面量继续编译。

## 5. cause 词表（修点 D）

`land-closeout-cause.ts` 是闭合词表 `LAND_CLOSEOUT_CAUSES`，消费者：`post-ship-finalization.ts`（推 cause / 组 reason）、`StateStore.ts:48237`（告警文案）、`workflow-engine-dispatcher.ts:2268`（重试正则只看前缀 `issue_closeout_incomplete`，任何 cause 都重试）、`landCloseoutCauseFromReason`（`[a-z_]+`）、`describeLandCloseoutCause`（中文说明）、`land-closeout-cause.test.ts`。

新 token：`nodes_not_confirmed_gone`，说明文案「有 Runner 节点尚未被证明已消失（closeout 审计事件 closeout_issue_items_blocked 列出节点）」。推导优先级（在 `inferLandCloseoutCauseFromClosureReport` 内）：

1. 任一节点 `transition/teardown.state === "failed"` 的 error ⇒ 现有 `inferLandCloseoutCause`（不变，优先级最高）。
2. 任一节点 `transition.state === "blocked"` 且 `prerequisite` 以 `authority_` 开头（`closeoutIssue` 循环里的 authorityLost 节点），**或** `teardown.state === "skipped"` 且 `reason` 以 `authority_` 开头（`closeoutOneNode` transition 之后 `freshAuthority` 失败，`lifecycle-closeout.ts:1373-1385`，此时 transition 可能已是 done/skipped）⇒ `lifecycle_conflict`（Codex R1 MEDIUM）。
3. 任一节点 `confirmedGone === false` 或 `communicationsFinalized === false` ⇒ `nodes_not_confirmed_gone`。
4. 否则 `undefined`（post-ship 对 `blocked` 回落 `unknown`，对 `conflict` 回落 `lifecycle_conflict`）。

`CloseoutCauseReportShape` 的节点形状加两个可选布尔（`confirmedGone?`, `communicationsFinalized?`）、`transition.prerequisite?` 与 `teardown.reason?`，`NodeClosureReport` 结构上已满足，`plugin.ts:6576` 调用零改动。

## 6. 现网同族清单（2026-09-11 10:58 快照，只读）

| issue | PR | land state | last_error | 阻塞节点形状 |
|---|---|---|---|---|
| FLY-2351 | #1133 | held (retry 9, resume_generation 1) | `retry_exhausted:issue_closeout_incomplete:cause=lifecycle_conflict` | `c070fce7…` codex-tmux / failed / `worktree_takeover_failed` / 无 state dir |
| FLY-2382 | #1107 | held (retry 9) | 同上 | `9ab658df…` codex-tmux / failed / `worktree_takeover_failed` |

FLY-2115 / 2169 / 2166 / 2152 / 2045 也是 held，但 cause 是 `worktree_branch_mismatch` / `unknown`，不属本族。今日（09-11）FLY-2509、FLY-1949 各一次 blocked，节点是 `completed` 且有 state dir 的正常体，不属本族。

## 7. 测试面（现状）

- `packages/teamlead/src/bridge/__tests__/run-quiescence.test.ts`（4 用例）——第 2 条「indeterminate codex group fail-closed」必须继续通过：新逻辑只在**零证据**时放行，`probeCodexDaemon: () => "unknown"` 的旧式注入仍视为 fail-closed。
- `packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts`（41 用例）——`:460` 已覆盖 `dead + gone ⇒ complete`；本单在这里补的是「生产默认探针」而非 deps 注入的用例（用 `FLYWHEEL_CODEX_SESSION_DIR` / `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT` 指到临时目录）。
- `packages/teamlead/src/__tests__/close-runner.test.ts:1712`「a crash-preserved close (failed, not forced) marks nothing」——本单不动 closeRunner，此用例是负向守卫。
- `packages/claude-runner/test/codex-daemon-runtime.test.ts:66`「requires both socket and process-group absence before classifying absent」——新函数复用同一 deps 注入形状。
- `packages/teamlead/src/bridge/__tests__/land-closeout-cause.test.ts:62`——现有 enum 优先级用例保持；新增 blocked 报告的推导用例。
- 本地测试面：worktree 需 `pnpm install --offline --frozen-lockfile` + `pnpm --filter flywheel-core --filter flywheel-comm --filter flywheel-claude-runner build` 之后 `npx vitest run <file>`（2026-09-11 本 worktree 实测：未 install 时 `ERR_MODULE_NOT_FOUND`）。

## 8. 恢复路径（无迁移）

- 代码合入 + Bridge 重启（独立 updater 窗口）后，FLY-2351 / FLY-2382 的 land op 仍是 `held`，需要 Lead 各调一次 `POST /api/lifecycle/land/<operation-id>/resume`（`{actor, reason}`；`lifecycle-routes.ts:277`，走 Bridge API token 守卫）。resume 会重放 finalization → closeout → 新探针判 `dead` → `finalizeCommDbSession`（无行 ⇒ 0 changes、`ok:true`）→ thread 归档 / Linear Done（均幂等，已人工做过）。
- 不自动扫 held 列表；上表就是清单。
