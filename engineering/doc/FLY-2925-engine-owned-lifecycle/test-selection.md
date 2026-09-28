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

## 11. QA@4 native usageLimited 移交标记返工（2026-09-27）

QA 在 exact head `e20b0c440` 的真实 529 房通过其余 release-N 生命周期场景后发现：
第一次 HTTP 429 已持久化 `upstreamRetryEpisode.attempts=1`，重试过程中引擎直接把
goal 更新为 `usageLimited` 时，client 从通用终态分支直接返回，未走只挂在
`blocked` 分支下的 quota handoff，因此既有 episode 没有升级为
`quotaExhausted=true`。修复把 quota handoff 提升为两个终态入口共用的持久化路径；
native `usageLimited` 会先按现有 crash-recovery 规则核对持久 episode 与 thread 最后
失败回合，再写移交标记并交额度治理。没有改变其他终态、退避或额度治理语义。

TDD 与本地相关验证：

| 所有者 | 测试 / 检查 | 结果 |
|---|---|---|
| claude-runner | `test/codex-daemon-client.test.ts`（RED） | 新场景缺 `quotaExhausted:true`，108/109 通过 |
| claude-runner | `test/codex-daemon-client.test.ts`（GREEN） | 109/109 通过 |
| claude-runner | `test/codex-daemon-goal-runtime.test.ts` | 65/65 通过 |
| claude-runner | `test/CodexTmuxAdapter.test.ts` | 189/189 通过 |
| claude-runner + dependencies | `pnpm --filter "flywheel-claude-runner..." build` | 通过 |
| changed files | Biome、`git diff --check` | 通过 |
| repository | `pnpm lint` | exit 0；仅未改文件的既存 warning |

changed-TypeScript `vitest related` 选中 11 个文件：10 个文件、572 项通过；唯一非绿
文件 `codex-daemon-runtime.test.ts` 有 6 个与本次逻辑无关的宿主环境失败，其中 2 个
真实进程探针为 `spawnSync ps EPERM`，4 个 adoption fixture 因默认 macOS 临时根令
socket 达 106 bytes、超过 SUN_LEN 103。精确回归、goal runtime 与 adapter 均全绿；
未把环境失败冒充产品回归，也未改这些无关路径。字面量/路径 discovery 命中的历史
设计文档与 `claude-profile.test.ts` 的 `quotaExhaustedUntil` 属不同账号池合同，排除；
`usageLimited` 的 daemon adapter、goal runtime、quota preflight 等直接消费者已由上述
逐文件测试和 related 选择覆盖。新 head 的 exact-head full CI 与真房 quota 场景复测
仍由 QA 执行。

## 12. QA@4 代码复审 + fault stub 回收返工（2026-09-27）

代码复审在 head `f42ace7c1` 指出一条 HIGH：额度恢复成功后，已落盘的
`{attempts:3, quotaExhausted:true}` episode 没有清除；同 thread 之后第一次新的 429
会被误算为第 4 次并再次终态移交。新增回归先观察到错误的 `usageLimited`，最小修复
在额度恢复产生模型输出时清除旧 episode；如果清除本身失败，则保留边界清理机会，
同时明确禁止把 `quotaExhausted:true` 的旧标记认作新的同一 episode。这样新失败从
attempt 1 开始，未改变额度终态或既有退避间隔。

Lead instruction `dcc869b9-3bff-4821-8afe-bf51b7eea4ec` 同轮要求修复 529 fault stub
泄漏。根因是 deploy 先发布权威 `receipt.json`，完成 source-home 准备后才另写 PID
sidecar；两步之间被中断时，teardown 虽看见 receipt，却因缺 sidecar fail closed，
stub 因而继续监听。修复删除第二份 PID authority：deploy 不再写 sidecar，teardown
只从 0600 receipt 读取 PID，并在发信号前继续复验精确 slot 根、room identity、
loopback host/port/base URL、receipt room path 与 live argv。旧 sidecar 只作为“存在
清理残留”的兼容触发器，不参与身份决定。

### 12.1 RED → GREEN 与相关验证

| 所有者 | 测试 / 检查 | 结果 |
|---|---|---|
| claude-runner | `test/codex-daemon-client.test.ts`（RED） | 新的“额度恢复后再遇 429”场景错误终态；109/110 通过 |
| claude-runner | `test/codex-daemon-client.test.ts`（GREEN） | 110/110 |
| claude-runner | `test/codex-quota-resume-preflight.test.ts` | 16/16 |
| claude-runner | `test/codex-daemon-goal-runtime.test.ts` | 65/65 |
| claude-runner | `test/CodexTmuxAdapter.test.ts` | 189/189 |
| scripts | `qa-generalized-codex-stub.test.mjs`（RED） | receipt-only teardown helper 不存在；5/6 通过 |
| scripts | `qa-generalized-codex-stub.test.mjs`（GREEN） | 6/6；真实 loopback stub 被 teardown，随后 PID 不可观察 |
| scripts | `test-deploy-generalized.test.sh` | 全部通过 |
| claude-runner | `kill-path-inventory.test.ts` | 5/5；没有新增未登记 signal 路径 |
| claude-runner + dependencies | `pnpm --filter "flywheel-claude-runner..." build` | 通过 |
| changed files | `bash -n`、Biome、`git diff --check` | 通过 |
| repository | `pnpm lint` | exit 0；仅未改文件的既存 warning |

changed-TypeScript `vitest related` 选中 11 个文件：10 个文件、573 项通过；唯一非绿
仍是 `codex-daemon-runtime.test.ts` 的 6 个宿主限制（2 个 `spawnSync ps EPERM`，4 个
默认 macOS TMPDIR 令 socket path 超过 SUN_LEN）。直接消费者均全绿，没有以目录、
glob 或包别名补跑任何全包测试。

### 12.2 discovery 排除记录

对旧/新 retry marker 字面量、`CODEX_FAULT_PID_FILE` / 新
`CODEX_FAULT_LEGACY_PID_FILE`、`qa_teardown_codex_fault_stub`，以及三份改动脚本的全
路径、basename、父目录均执行 `git grep -lF`。保留并运行上表中的直接动态消费者。
其余测试命中按以下原因排除：

- `test-deploy-fly1389`、launch-boundary、multilead、QA-room、Discord pointer、Lead
  coordinates、slot-pool、cmux ownership/lease/live-watcher 与 worktree-removal：只消费
  通用 deploy/teardown 路径，不创建 `state/codex-fault/receipt.json`；本轮分支只有该
  receipt 存在才激活，默认路径已由 generalized 合同测试覆盖。
- edge-worker、flywheel-comm 与 teamlead 的脚本路径 fixture：只把路径写进 prompt、
  evidence 或 strength-two 静态合同，不执行 fault lifecycle。
- `.github/workflows/ci.yml`、kill-path golden 与历史文档：分别是 exact-head CI 枚举、
  机械清单或旧证据；kill-path 的实际 scanner 测试已单独 5/5。

本地证明只覆盖可控 QA seam 与 daemon retry 语义；exact-head full CI、529 房七场景和
真实 provider 链仍由 QA 在冻结头执行。

## 13. QA@5 Bridge cycle 构建产物漂移返工（2026-09-27）

QA 在 base head `7c5a01d74` 的旧 slot 1 房中保留了 295 条 kill ledger，其中 228 条
isolation boundary 拒绝为 `outside_root`：168 条来自 `codex_daemon_runtime`，60 条来自
`codex_orphan_reaper`。每条都把 root 算成
`/private/tmp/flywheel-test-slot-1`，但 socket / ledger / Codex home 仍以
`/tmp/flywheel-test-slot-1` 开头。当前源码与同头重新构建的
`packages/claude-runner/dist/isolation-boundary.js` 对这些原始路径都返回
`{ok:true, mode:"isolated"}`；旧房在 dist 重建前出生，之后的 Bridge cycle 只回放
immutable launch spec，没有验证正在回放的构建产物。因此 room/source SHA 可以保持
正确，运行时仍复用会错误拒绝 `/tmp` alias 的旧 artifact。

最小修复仍只在 QA seam：`test-cycle-bridge.sh` 在读取旧 PID、发 TERM 或改 ownership
之前，动态载入该 repo 的实际 `claude-runner/dist/isolation-boundary.js`，用目标 slot
的 lexical `/tmp` 根及 socket / ledger / Codex home 三类证据执行边界检查。缺 artifact、
缺导出或返回非 isolated 都 fail closed，并明确要求 redeploy 以重建产物；没有修改
`packages/*/src` 产品语义。

### 13.1 RED → GREEN 与相关验证

| 所有者 | 测试 / 检查 | 结果 |
|---|---|---|
| scripts | `test-cycle-bridge.test.sh`（RED） | 33/34；旧脚本接受会拒绝 lexical slot path 的 stale artifact |
| scripts | `test-cycle-bridge.test.sh`（GREEN） | 34/34；拒绝发生在 TERM / ownership mutation 前 |
| scripts | `test-deploy-fly1389.test.sh` | 29/29；public cycle、worktree cycle 与 report-host cycle 均通过 |
| claude-runner | `isolation-boundary.test.ts` | 12/12；包含 `/tmp` alias 正向合同 |
| claude-runner | `kill-path-inventory.test.ts` | 5/5；没有新增 signal / runner mutation 出口 |
| changed files | `bash -n`、`git diff --check` | 通过 |
| repository | `pnpm lint` | exit 0；仅未改文件的既存 warning |

本轮没有改 TypeScript，故不运行 `vitest related`；没有运行本地全仓或全包测试。

### 13.2 discovery 排除记录

对新错误文案、`isolation-boundary.js`、两个改动文件的全路径 / basename / 父目录均
运行 `git grep -lF`。保留并运行真正执行 cycle 的 `test-deploy-fly1389`、边界 API 的
直接合同 `isolation-boundary.test.ts`，以及因脚本本身已有 signal 原语而必须守住的
kill-path inventory。其余命中按以下原因排除：

- `qa-fly-2456-dry-run.test.mjs` 只分析已持久化的 cycle/reown 事件，不执行 artifact
  preflight，事件名也未改。
- `run-bridge-isolation-boot.test.sh` 与 `qa-slot-env-contract` 覆盖首次 Bridge boot 的
  env/contract；本轮只在既有 cycle replay 前调用同一 built boundary API，首次启动
  路径未改。
- teamlead 的 orphan/reaper、tmux lookup 与真实进程 boundary 测试覆盖产品消费者；
  本轮不改这些消费者或 boundary 源码，实际 API 合同已由 12/12 直接测试覆盖。
- playbook、历史设计文档、workflow 枚举和静态 fixture 只列出脚本路径，不执行本轮
  分支。

新 head 的 exact-head full CI 与 529 real-runner 七场景仍由 QA 执行；本地结果只证明
cycle 会在破坏 live room 前识别错误构建产物，不冒充已修复的真房或完整生命周期证明。
