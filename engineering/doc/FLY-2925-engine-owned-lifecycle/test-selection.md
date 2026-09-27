# FLY-2925 引擎统一体生命周期 — 测试选择与本地验证
Issue: FLY-2925 (https://linear.app/geoforge3d/issue/FLY-2925/病根修复-7-codex-体生死只认引擎一侧goal-结束不等于死引擎终结后-goal-不得自续重启只按原会话续接6-张-43)
日期: 2026-09-26
基于: plan.md

遵循注入的 `local-test-policy/v1`：只跑相关测试，逐文件运行；没有运行任何全仓或全包测试。精确 head 的 PR CI 才是全套证据。

## 1. 改动文件

| 包 | 源文件 |
|---|---|
| flywheel-claude-runner | `src/codex-daemon-client.ts`、`src/codex-daemon-goal-runtime.ts`、`src/codex-daemon-runtime.ts`、`src/CodexTmuxAdapter.ts` |
| flywheel-teamlead | `src/HeartbeatService.ts`、`src/bridge/codex-session-reown.ts`、`src/bridge/event-route.ts`、`src/bridge/plugin.ts`、`src/bridge/resident-receiver-supervisor.ts`、`src/bridge/run-infra.ts`、`src/bridge/runs-route.ts` |

## 2. 发现过程

- 字面量：`git grep -lF` 搜索 `goal_blocked`、`LAUNCH_PENDING`、`launchState`、`RUN_TERMINAL`、`codex_resident_wait`、`codex_goal_blocked_observed`、`residentWaitHold`、`upstreamRetryEpisode`、`resident_wait_confirmed`、`missing_resident_gate`、`adoptCodexDaemon`、`adoptLiveExecution`、`reown_adopt`、`reown_watch_started`、`turn reconciliation failed after recovery commit`。
- 路径：对每个改动文件的 basename 搜索测试文件名；plugin.ts 为枢纽，单独处理（见 §4）。
- TypeScript：claude-runner 运行 `vitest related <4 个改动文件> --run`。

## 3. 保留并运行的测试（逐文件）

| 包 | 测试文件 | 结果 |
|---|---|---|
| claude-runner | `vitest related` 选中 10 个文件 | 537/537 通过 |
| claude-runner | `test/codex-daemon-client.test.ts` | 98/98 通过 |
| claude-runner | `test/codex-daemon-goal-runtime.test.ts` | 63/63 通过 |
| claude-runner | `test/codex-daemon-runtime.test.ts` | 125/125 通过（需短 TMPDIR；FLY-2830 真实 lsof 用例高负载下偶发失败，单跑通过） |
| claude-runner | `test/CodexTmuxAdapter.test.ts` | 179/179 通过 |
| claude-runner | `test/codex-session-state-forward-compat.test.ts`（新增） | 5/5 通过 |
| teamlead | `src/__tests__/event-route.test.ts` | 本改动相关用例（4 个 FLY-2925 与改写的 FLY-2018/FLY-1279 用例）每次都通过；整文件一次 113/113 全过（新增最后一个用例之前），负载 104–117 时另两次为 109–111 通过，失败的始终是同一组 completion/PR 声明用例（超时或 409），其中 "forged generalized completion" 在原始基线文件上同样失败 |
| teamlead | `src/__tests__/runs-route-generalized-pending.test.ts` | 10/10 通过 |
| teamlead | `src/bridge/__tests__/runs-route.dag-entry.test.ts` | 通过 |
| teamlead | `src/bridge/__tests__/codex-session-reown.test.ts` | 59/59 通过 |
| teamlead | `src/bridge/__tests__/codex-session-reown-wiring.structure.test.ts` | 10/10 通过 |
| teamlead | `src/bridge/__tests__/run-infra-codex-recovery.test.ts` | 10/10 通过 |
| teamlead | `src/__tests__/HeartbeatService.zombie-reconcile.test.ts` | 43/43 通过；删掉保护判断的负控使 2 个新用例变红 |
| teamlead | 其余 6 个 `HeartbeatService.*.test.ts` | 全部通过（22/12/22/8/23/6） |
| teamlead | `src/__tests__/DirectEventSink.dag-seam.test.ts`（读 event-route 源码） | 13/13 通过 |
| teamlead | `src/__tests__/DirectEventSink.fly1427-terminal-immunity.test.ts` | 7/7 通过 |
| teamlead | event-route-* 12 个、infra-event-router、resident-receiver-supervisor、run-infra-* 4 个、runs-route-* 5 个、meeting-notes-scheduler、runner-action-http、runner-actions、gateway-main | 27/28 通过；`runs-route-registration.test.ts` 拉起整个 Bridge，内置 15s 超时，负载 104–117 时超时；把 teamlead 全部改动源文件换回基线 fdd1b404d 后同样超时（见 §5） |

## 4. 排除项与理由

- `plugin.ts` 是枢纽：`vitest related` 会展开到几乎整个 teamlead 包，属于被禁止的全包运行。改为运行其改动路径的直接消费者：reowner、run-infra、wiring 结构、HeartbeatService 相关测试。
- `goal_blocked` 字面量命中但未改动语义的测试：`DirectEventSink.test.ts`、`StateStore.fly1385-dead-exec.test.ts`、`StateStore.fly1427-terminal-immunity.test.ts`、`pre-adapter-failure-receipt.test.ts`、`lifecycle-closeout.test.ts`、`run-quiescence.test.ts`、`workflow-engine.fly2302-dead-body-commdb.test.ts`、edge-worker `Blueprint.decision`/`ExecutionEventEmitter`。它们覆盖进程内 DirectEventSink / StateStore / Blueprint 的 goal_blocked 处理，本 PR 没有改动这些路径（只改了 HTTP event-route 与 adapter 的生产端）。
- `reown_watch_started` 命中 `scripts/__tests__/qa-fly-2456-*.test.mjs`：它们只读已持久化事件做报表，事件名未改。
- `LAUNCH_PENDING` 消费者 `runner-action-http`、`runner-actions`、`gateway-main`、`meeting-notes-scheduler` 已纳入运行；它们按 202 + code 判 pending，不依赖 `success`。

## 5. 未闭合与环境说明

- `pnpm --filter "flywheel-teamlead..." build` 通过；claude-runner 与 teamlead `tsc --noEmit` 通过；`pnpm lint` 改动文件干净（仓库其余错误在未改动文件中）。
- 本机负载在验证期间为 80–117（多 runner 并发）。时间敏感的 Bridge 启动类用例（`runs-route-registration`）与部分 event-route completion 用例出现超时；它们不经过本 PR 改动的分支，最终以精确 head CI 为准。
- 需要真实 Codex 的验收（活 daemon 被接管、blocked/429 不判死、旧 goal_blocked 重放不判终态）未在本机执行，交 QA 在 Codex 房间验证，见 PR test plan。

## 6. QA@1 返工（2026-09-26，attempt 2）

QA 判决：精确 head f8f0ba0c9 的全量 CI 仅 `Unit (heavy)` 中 `packages/claude-runner/test/kill-path-inventory.test.ts` 两条断言失败——`adoptCodexDaemon` 新增的两处 `child.kill(...)` 文本调用未落在审计出口。修复：两处改为直接调用同一个审计过的 `createDefaultKillGroup` 包装（`signalGroup`），清单保持 773 条、无需改 golden。529 真实 Codex 场景因 slot 2 launcher 所有权记录与实际监听不一致而未执行（QA 判为台架问题，由 Lead 修 slot）。

同步合并 origin/main（2 个提交，无冲突、锁文件未变），重建 `flywheel-teamlead...`，逐文件复跑：

| 包 | 测试文件 | 结果 |
|---|---|---|
| claude-runner | kill-path-inventory | 5/5 |
| claude-runner | codex-daemon-client / goal-runtime / runtime / CodexTmuxAdapter / forward-compat | 108 / 65 / 125 / 180 / 5 全过 |
| teamlead | event-route / event-route.codex-trigger / runs-route-generalized-pending | 114 / 30 / 11 全过 |
| teamlead | runs-route.dag-entry | 74/74（负载 110–152 时一次 73/74，失败用例单跑两次通过、整文件复跑全过） |
| teamlead | codex-session-reown / wiring / run-infra-codex-recovery / HeartbeatService.zombie-reconcile / DirectEventSink.dag-seam | 59 / 10 / 10 / 43 / 13 全过 |

claude-runner 与 teamlead `tsc --noEmit` 干净。

## 7. QA@2 返工（2026-09-26，attempt 3）

QA 判决：generalized 529 房的 `room-info.json` 同时包含
`generalized: true` 与 `runnerMode: "real"`，但
`isCodexReownExcluded` 只看 generalized/project，导致真 Codex 也在维护心跳进入
reowner 前被排除。修复只把 `runnerMode !== "real"` 的房保留在排除集合；stub
和缺旧字段的房保持原有隔离，real 房进入既有 adoption 路径。

TDD 与直接覆盖：

| 包 | 测试文件 / 命令 | 结果 |
|---|---|---|
| teamlead | `src/bridge/__tests__/codex-session-reown.test.ts`（RED） | 新用例按预期失败：real 房收到 `true`；其余 58 项通过 |
| teamlead | `src/bridge/__tests__/codex-session-reown.test.ts`（GREEN） | 59/59 通过 |
| teamlead | `src/bridge/__tests__/codex-session-reown-wiring.structure.test.ts` | 10/10 通过 |
| teamlead | `src/__tests__/HeartbeatService.zombie-reconcile.test.ts` | 43/43 通过 |
| teamlead + dependencies | `pnpm --filter "flywheel-teamlead..." build` | 通过 |
| teamlead | `pnpm --filter flywheel-teamlead typecheck` | 通过 |
| repository | `pnpm lint` | exit 0；仅报告本次改动文件之外的既存 warning |

按 changed-TypeScript 规则运行的 `vitest related` 展开为 105 个 teamlead 文件：
101 个文件 / 1278 项通过，4 个文件 / 6 项失败。失败均不经过本次谓词：
`flag-scan-route-mount` 与 `epic-residual-plugin-wiring` 逐文件复跑分别 3/3、3/3
通过；`createLeadRuntime-preflight` 逐文件在本机 15s 预检等待超时，
`ship-judgment-routes` 逐文件在本机 30s 统计请求超时。未改这两个无关路径；
基线 `4cc071628` 的 exact-head full CI `36285259307` 已全绿，新头的全量 CI 仍交 QA。

未在本机冒充真房证明。下一轮 QA 仍须在 generalized + runnerMode=real 的真
Codex 房观察首个维护心跳后的 `reown_adopt_started` / `reown_adopt_succeeded`，
并核对 execution/thread/daemon PGID 不变。

## 8. QA@2 代码复审 R1 阻断返工（2026-09-26）

复审 request `968fabaf-e529-4a16-82b4-d8ec96ce7aac` 在 head
`3e5734cff` 提出两条 HIGH。逐项核对后确认根因：goal runtime 在 receipt 前只
detach daemon，但 adapter 外层仍执行普通终态收尾；adopted handle 的 500ms
exit poll 又每次调用完整 ownership proof，反复同步执行 `lsof`。

最小修复：live adoption 在 receipt 前不改既有 CommDB session/TUI，失败时不
stop/drain daemon、不关闭 transcript、不落终态、不处置 doorbell、不退休凭据，
只停止本次 Bridge 的本地 watcher/controller 并释放 owner claim；receipt 确认后
才恢复 TUI。adoption 仍在加锁前后各做一次完整 socket-holder 身份证明，之后的
长期退出观察只用已锁定 PGID 的 `kill(-pgid, 0)` 状态与 socket connect，默认
间隔由 500ms 调为 5s，不再运行 `lsof`。

TDD 与直接覆盖：

| 包 | 测试文件 / 命令 | 结果 |
|---|---|---|
| claude-runner | `test/CodexTmuxAdapter.test.ts`（RED） | 新用例观察到 pre-confirm failure 调用了 `runtime.stop()`；180 个旧用例通过 |
| claude-runner | `test/CodexTmuxAdapter.test.ts`（GREEN） | 181/181 通过；新用例同时断言 session/TUI/doorbell/credential 不变 |
| claude-runner | `test/codex-daemon-runtime.test.ts`（RED） | 30ms 内 socket-holder proof 从初始 2 次增至 6 次 |
| claude-runner | `test/codex-daemon-runtime.test.ts`（GREEN） | 新 exit-watcher 用例通过，socket-holder proof 保持 2 次；整文件 124/126 通过，2 个 FLY-2830 真实 `ps` 探针均为宿主 `spawnSync ps EPERM` |
| claude-runner | `test/codex-daemon-goal-runtime.test.ts` | 65/65 通过 |
| teamlead | `src/bridge/__tests__/codex-session-reown.test.ts` | 59/59 通过 |
| claude-runner + dependencies | `pnpm --filter "flywheel-claude-runner..." build` | 通过 |
| claude-runner | `pnpm --filter flywheel-claude-runner typecheck` | 通过 |

按 changed-TypeScript 规则运行 `vitest related`，选中 8 个文件：7 个文件、408
项通过；唯一非绿文件仍只有上述 `codex-daemon-runtime.test.ts` 的 2 个 FLY-2830
真实 `ps` 探针（`spawnSync ps EPERM`）。本轮新增的 adoption preservation 与廉价
exit watcher 用例均通过。路径 / basename / parent discovery 命中的历史文档、
kill inventory 与 child census 只记录源码路径或旧证据，本改动没有新增 kill
出口，故不重复运行或改写；保留直接消费者 adapter、daemon runtime、goal runtime
与 teamlead reown 测试。精确 head 全量 CI 与真房仍交 QA。
