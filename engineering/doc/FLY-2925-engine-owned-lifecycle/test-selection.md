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

## 9. QA@3 真房可控接缝返工（2026-09-26，attempt 4）

Lead 授权仅补 529 QA 接缝，不改 `packages/*/src` 产品语义：Bridge 重启脚本增加
`--stop-only` / `--start-only`，沿用同一个 launch spec、cycle lock、guard 与
`cycle-failed` 所有权哨兵；新增只监听 `127.0.0.1` 的 Codex upstream fault stub，
按显式序列返回 429 / 5xx / capacity / quota / 401。只有
`--generalized --codex-runner --mode slot --codex-fault-sequence ...` 会把该 slot 的
Bridge `FLYWHEEL_CODEX_SOURCE_HOME` 指向 slot 内 source home；宿主 auth 仅以同 inode
hardlink 暴露给既有 slot reconcile，宿主 `config.toml` 不写、不 chmod。stub、split
cycle 和 teardown fault 分支在监听或发信号前均校验精确
`/tmp/flywheel-test-slot-N`、0600 `room-info.json` 与 `mode == "slot"`。

### 9.1 RED → GREEN

- RED：旧 `test-cycle-bridge.sh` 对 `--stop-only` / `--start-only` 只返回 usage；新增
  H4/N29 后先失败。GREEN：33/33。
- RED：fault stub 不存在、随后缺 `prepare-source`、再缺 deploy 显式开关；逐步补最小
  实现后 `qa-generalized-codex-stub.test.mjs` 6/6。
- RED：默认 cycle stdout 多了 `mode`，`test-deploy-fly1389.test.sh` 的 FLY-2237
  公共合同 1 项失败；恢复默认 JSON 原样，新字段只出现在 split 模式，29/29。
- RED：kill-path inventory 识别 6 个新增 QA-only probe/signal，779 != 773；登记到
  golden 后 5/5。没有新增 runner-affecting mutation。

### 9.2 保留并逐文件运行

| 所有者 | 测试 / 检查 | 结果 |
|---|---|---|
| scripts | `node --test scripts/__tests__/qa-generalized-codex-stub.test.mjs` | 6/6 |
| scripts | `bash scripts/__tests__/test-cycle-bridge.test.sh` | 33/33 |
| scripts | `bash scripts/__tests__/test-deploy-fly1389.test.sh` | 29/29 |
| scripts | `bash scripts/__tests__/test-deploy-generalized.test.sh` | 全部通过 |
| scripts | `bash scripts/__tests__/qa-slot-env-contract.test.sh` | 通过 |
| claude-runner | `vitest run test/kill-path-inventory.test.ts` | 5/5 |
| repository | `pnpm lint` | exit 0；仅报告未改文件的既存 warning |
| claude-runner + dependencies | `pnpm --filter "flywheel-claude-runner..." build` | 通过 |
| changed files | `bash -n`、`node --check`、Biome changed-file check、`git diff --check` | 通过 |

本轮没有改 TypeScript，故不运行 `vitest related`。没有运行本地全仓或全包测试；
精确 head 全量 CI 仍由 QA 冻结头执行。

### 9.3 discovery 命中但排除的测试

已对旧/新 usage、`--codex-fault-sequence`、stub 文件名、`cycle-failed`、
`openai_base_url` 运行 `git grep -lF`，并对每个改动文件的全路径、basename 与父目录
运行路径搜索。父目录命中大量仅列举 `scripts/` / `scripts/__tests__/` 的历史文档和
suite enumerator；它们不是运行时消费者，按目录级非消费者整体排除。测试文件命中
逐项处置如下：

- `qa-fly-2456-dry-run.test.mjs`：只检查既有 cycle/reown 事件报表，事件名未改。
- `codex-home-reconcile-cadence.test.sh`：fault 开关明确禁止与 reconcile drill 同开；
  cadence 路径未改。
- `fly1663-qa-launchd-mutants.test.sh`、`fly1679-dev-channels-v2.test.sh`、
  `fly2655-voice-room.test.mjs`、`fly2867-claude-lead-inbox-lease.test.sh`、
  `qa-lead-coordinates.test.sh`、`qa-room-env.test.sh`、
  `runner-test-discipline-deploy.test.sh`、`test-auto-approve-identity.test.sh`、
  `test-deploy-discord-pointer.test.sh`、`test-deploy-launch-boundary.test.sh`、
  `test-deploy-multilead.test.sh`、`test-deploy-preflight-github.test.sh`、
  `test-deploy-qa-room.test.sh`、`test-qa-executor-529-nton-contract.sh`：命中通用
  `test-deploy.sh` 文本，但不进入新增的显式 real-Codex fault flag；其通用默认合同由
  `test-deploy-fly1389`、generalized 合同由 `test-deploy-generalized`、env 隔离由
  `qa-slot-env-contract` 覆盖。
- `fly2874-slot-pool.test.sh`、`qa-teardown-finalize.test.sh`、
  `restart-cmux-watcher.test.sh`、`test-teardown-cmux-ownership.test.sh`、
  `test-teardown-lease-contract.test.sh`、`test-teardown-live-watcher-e2e.test.sh`、
  `test-worktree-removal-contract.test.sh`：新增 teardown 分支仅在精确 fault receipt/pid
  同时存在时激活；原 cmux、lease、watcher、worktree 路径未改，默认 teardown 已由
  `test-deploy-fly1389` 覆盖。
- edge-worker `resolveBridgeUrl.test.ts` / prompt fixtures、flywheel-comm
  `strength-two-contract.test.ts`、teamlead `StateStore.strength-two-evidence-record.test.ts`：
  只把脚本路径当静态证据或 prompt 文本，不执行新增分支。

真 Codex 生命周期 7 场景与 fault 序列的产品级分类仍须 QA 在 Lead 提供的 529
real-runner slot 1/3/5 执行；本地结果只证明接缝本身及默认路径没有回归，不冒充真房
或全量 CI 证据。

## 10. 接管与 main 技术同步（2026-09-27）

接管 `ad0687350` 后先重建 frozen dependencies，并在原样 WIP 上逐文件验证第 9 节
接缝。为消除 PR conflict，又将 `origin/main@975822f5d` 合入：三处人工冲突均只做
并集整合——daemon client 同时保留 resident/reown 与 quota-resume 观察和 preflight，
Heartbeat crash reaper 同时保护 live Codex body 与 quota standby，adapter 测试同时
保留 daemon handle 与 session-state import。没有扩展 QA-only seam 的生产作用域。

最终合并头的直接覆盖：

| 所有者 | 测试 / 检查 | 结果 |
|---|---|---|
| claude-runner | `codex-daemon-client` / `codex-quota-resume-preflight` / `CodexTmuxAdapter` / `codex-daemon-goal-runtime` | 378/378 |
| teamlead | `codex-session-reown` / `HeartbeatService.zombie-reconcile` | 104/104 |
| teamlead | `HeartbeatService.fly2912-quiet-recovery` | 21/21；首次运行的 8 项红来自合并后尚未重建的旧 `config/dist`，按依赖链 build 后同文件全绿 |
| scripts | `qa-generalized-codex-stub.test.mjs` | 6/6 |
| scripts | `test-cycle-bridge.test.sh` | 33/33 |
| scripts | `test-deploy-fly1389.test.sh` | 29/29 |
| scripts | `test-deploy-generalized.test.sh` / `qa-slot-env-contract.test.sh` | 全部通过 / 通过 |
| claude-runner | `kill-path-inventory.test.ts` | 5/5 |
| teamlead + dependencies | `pnpm --filter "flywheel-teamlead..." build` | 13 个相关包构建通过 |

Claude runner 的 changed-TypeScript `vitest related` 选中 11 个文件：10 个文件、571
项通过。`codex-daemon-runtime.test.ts` 的默认 macOS 临时根先让 4 个 adoption fixture
socket 达到 106 bytes（超过 SUN_LEN 103）；改用任务专用短临时根复跑同一具体文件后，
这 4 项及其余 120 项通过，只剩既有的 2 个 FLY-2830 真实 `ps` 探针因宿主
`spawnSync ps EPERM` 非绿。Teamlead `HeartbeatService.ts` 的 `vitest related` 会展开到
近全包，按第 5/7 节已记录的选择规则不重跑；保留上述三个直接消费者文件，避免把
本地全包测试伪装成相关测试。

生产不可达证明保持不变：fault stub 只监听 `127.0.0.1`，入口同时要求显式
`--generalized --codex-runner --mode slot --codex-fault-sequence`、精确
`/tmp/flywheel-test-slot-N` 根、0600 `room-info.json` 和 `mode == "slot"`；split cycle
与 teardown 在发信号前复验同一房间身份和 receipt/PID/argv。普通部署没有这些开关，
本轮 QA seam 提交也没有修改 `packages/*/src`。exact-head 全量 CI 与 529 真房七场景
仍由 QA 冻结头执行。
