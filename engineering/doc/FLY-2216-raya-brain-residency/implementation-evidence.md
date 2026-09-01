# FLY-2216 Raya 脑常驻体制 — 实施证据
Issue: FLY-2216 (https://linear.app/geoforge3d/issue/FLY-2216/raya驻场-raya-脑常驻体制与-codex-lead-同级的常驻-pane-假活自愈-可观察日志8-31我下线了僵尸一天无人知)
日期: 2026-08-31
基于: plan.md

## 范围声明

本实现与验证只改 Flywheel 驻场、管护和观测。所有 launchd、tmux、heartbeat 与 recovery 验证均使用临时目录、fake launchctl/ps 或 isolated tmux server；没有注册、重启或探测生产 Raya，没有接触 `com.xrli.raya.brain`，没有删除 `Raya-brain` 应急窗，也没有 deploy/merge。

2026-09-01 founder 返工选择 B 后，业务驻场机制从 Raya 专用实现提升为所有**显式 roster opt-in**
的 resident Codex CLI Lead 共用：`codexResidencyPatrol:true` 是 lifecycle、patrol 与 recovery
authority 的共同开关。载体 identity/plist/wrapper 仍沿用各 Lead 已审核的既有实现；Raya carrier 本身
没有被泛化或重写。返工时只读检查生产 `projects.json`，现有 Mufasa/InfraBot 均未设置该字段，故默认
不创建新 observer/patrol，生产路径不变；本节点没有修改生产 registry。

## 载体与真实会话面

- canonical registry/launchd/tmux/cmux identity 固定为 `raya/raya`、`com.flywheel.lead.raya-raya`、`raya-raya`；full-access、`canSpawnRunners:false`、non-companion 同时受 activation preflight 与 restart authority 约束。
- fixed plist 只执行安装到 state bin 的 `flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh`；wrapper 继续走 host-tmux selection gate，launcher 投影真实 repo root、fixed thread、Raya CODEX_HOME 与真实 TUI runtime。
- `raya-activation-preflight.test.sh` 使用 repo-shaped 临时 tree 执行真实 launcher，捕获其实际 runtime env，再把该 env 交给真实 `createTuiWindowAlertGuard`；结果为 `armed`。这不是手造 `FLYWHEEL_ROOT` 的 unit fixture。
- `tui-window.test.ts` 的 13 个测试通过，锁定窗口创建命令为 `codex resume --remote`、canonical selector 与 liveness 重建，而非 rollout `tail`。

隔离渲染检查：

```text
$ tmux -L fly2216-evidence-<pid> display-message ...
flywheel-host:raya-raya:sleep

$ tmux -L fly2216-evidence-<pid> capture-pane ...
Raya canonical TUI fixture
command: codex resume --remote thread-fixture
```

该 isolated server 随检查删除。当前会话没有可安全使用且不改 founder cmux workspace 的截图通道，因此未伪造 production cmux 截图；`fly1446-cmux-roster.test.sh`、`test-cmux-sync.sh` 与 host-tmux fixture 分别承担 roster、同名 workspace、missing-window alert-only 和不建 duplicate 的可执行证明。

## 可 tail 生命周期面

只有 `findResidentCodexLeadTargets()` 选中的 opt-in target runtime 才会构造
`ResidentCodexLeadLifecycleObserver`。它把脱敏事件 append 到每个 Lead 自己的
`brain/lifecycle.jsonl`，并通过同目录 temp+rename 更新 `brain/heartbeat.json`。覆盖的真实业务边界包括：

- gateway baseline/delivery fetch 前的 poll attempt，以及 closed HTTP/transport result class；
- journal 接受、cursor persist 结果与最近消费 message id/time；
- turn started 与唯一 terminal state；
- online、generation lost、shutdown。

独立 QA 取证确认 issue 病案中的“我下线了”由 `com.xrli.raya.voice` 在正常语音退出时发送，
不经过本载体的 assistant output；原 detector 既没有生产者，又会让
`lastOfflineDeclarationAt` 永久污染同一 generation。返工因此净删除 assistant-output detector、
heartbeat 字段和两条 declaration classifier branch，不从 voice 侧另接信号，也不再宣称这句话已被
本 PR 消费。legacy heartbeat 即使残留该未知字段，也必须按 poll/turn/heartbeat 证据正常分类。

## 假活分类与自愈

`ResidentCodexLeadPatrol` 复用 GatePoller 既有 60 秒 rider，没有新增 timer/daemon。20 个 focused patrol 测试锁定：

- 正常 idle 与 poll attempt 持续推进为 healthy；fresh auth/rate-limit/server/network/unknown failure 均为 `upstream_unavailable`，只告警不恢复；
- 只有 `poll_loop_stalled`、`turn_stalled`、`heartbeat_stalled` 三条业务停滞分支是 recovery candidate；legacy offline 字段对 healthy/stall 结论零影响；
- current pid+lstart 从未产出 valid heartbeat 为 `observer_missing`，只告警；durable observed-generation 后的 stale/missing/malformed heartbeat 才可进入共享连败；
- candidate category 改变不重置共享计数，healthy、identity 或 generation 改变重置 episode；每 episode 最多一次 recovery；
- controlled replacement 只在 exact old pid+lstart marker 匹配时 suppression；symlink 文件和 symlink parent ancestry 都不构成可信证据；
- cross-family review R1 的阻断项已用 RED→GREEN 回归收口：foreign-process heartbeat 与早于当前 process start 的 same-pid heartbeat 都不能写入 durable observed-generation marker，也不能给后续 recovery 提供 authority；
- hook 独立于 cmux watcher；Bridge 从 projects roster 枚举所有 opt-in target，为每个 target 构造独立
  patrol/episode，并将告警固定走 `machine/codex-lead-residency` 的
  `codex_lead_residency_stalled` infra ticket，不寄往被巡检 Lead 自己。
- 同一 host adapter 测试用 `raya/raya` 与 `growth/mufasa-lead` 两组不同 label、wrapper、CODEX_HOME、
  state dir 和 helper 参数分别触发 `poll_loop_stalled` detection + alert；一个 target 的 adapter/异常不
  共享另一个 target 的 episode 或阻断其 tick。

## 529 真 Discord 与告警投递

返工头 `8ea3a21bc` 使用 QA contract 允许的 module-driven 529 路径加载真实编译产物，使用两个
529 test bot 和真实 Discord REST 完成 N-to-N：bot-1 request 被 bot-2 的
`RestPollDiscordInboundSource` 消费，bot-2 reply 再被 bot-1 的同一生产 source 消费；reply reference、
两端 bot identity 与 `authorBot=true` 均核验。两端真实 `RayaBrainLifecycleObserver` 各写出
`online → gateway_poll_attempt → gateway_poll_ok → message_consumed`，没有 retired offline event：

- [bot-1 request](https://discord.com/channels/1485787271192907816/1519417773304975450/1544295913873342484)
- [bot-2 reply](https://discord.com/channels/1485787271192907816/1519417773304975450/1544295918088749107)

同一 compiled notifier 随后把当时的 Raya 专用 `raya_brain_stalled` 投到隔离 alert channel，并通过 Discord GET
回读 message id 与定稿文案：`category=poll_loop_stalled`、tuple identity、poll age evidence、
`recovery=not attempted`，不含对话正文或“我下线了”分类：

- [真实 raya_brain_stalled 投递](https://discord.com/channels/1485787271192907816/1519421055805165842/1544295921355858055)

该链接是 founder B 通用化之前的历史 transport 证明，不冒充当前 generic kind 的真实投递。返工后的
`codex_lead_residency_stalled` 已由 TypeScript union、shell allowlist、ticket ownership、severity 与
copy contract 的 33 个测试闭合；本 implement 节点没有再向 Discord 发送测试消息。

先尝试的 launchd-based roundtable smoke 在任何 Discord assertion 前因测试 Lead bootstrap 的 macOS
`Input/output error` 停止；本 runner 的 process-control sandbox 又令 canonical teardown claim fail-close。
它没有产生通过证据，也没有触碰生产 Raya。随后采用 QA 规范明确支持的 compiled-module real-Discord
路径完成上述验收；遗留的 test-slot teardown failure receipt 交独立 QA 环境按 canonical teardown 清理。

`resident-codex-lead-recover.test.sh` 的 18 个测试使用 fake home/projects/manifest/plist/launchctl/ps，证明：

- helper 必须收到 bounded `--project/--lead`，并只接受 exact label/backend/profile/capability、
  `codexResidencyPatrol:true`、已审核 wrapper/CODEX_HOME/runtime argv；
- 同一个 helper 分别验证 Raya 与 Mufasa 两种 carrier；未 opt-in 的既有 Codex Lead 在读取 launchd
  process 前 fail closed，零 mutation；
- expected pid+lstart 与 generation evidence 一致后，二次 authority/process check、durable pre-mutation receipt 完成，才执行 bounded `kickstart -k gui/<uid>/com.flywheel.lead.raya-raya`；
- backend/tuple/TOCTOU/receipt drift 都是零 mutation；never-observed heartbeat loss 也是零 mutation；
- 已 durable observed 的 generation 在 heartbeat 丢失后仍可恢复；新 pid/lstart 与新 generation heartbeat 均出现才返回 converged；
- 缺新 heartbeat 明确失败；call log 从未包含 `com.xrli.raya.brain`。
- `ps eww` 的完整 environment（含 bot token）只通过 fd 3 进入 parser，不出现在 Python argv；带 unmatched quote 的 secret 仍能完成 exact probe。

## 窗口告警单一所有权

pane loss 不进入 brain patrol。既有 `tui_window_lost` guard 的 exact allowlist 现在仅包含 `(flywheel,codex-infra-bot-lead)` 与 `(raya,raya)`；InfraBot 标题保持不变，Raya 使用独立标题。真实 `lead-alert.sh` hermetic test 证明同 episode 去重、同日新 episode 可重报，以及 InfraBot/Raya 即使 kind/signature 相同仍产生不同 identity claim 和持久化 title。

## 回滚与 replay

- 从 target roster row 移除 `codexResidencyPatrol:true`，Bridge 与对应 TUI runtime 下次启动即不构造
  patrol/observer；它不会替该 Lead 启动任何 job。
- 对 exact `com.flywheel.lead.raya-raya` 执行 operator-owned bootout 可停止常驻 carrier；产品 job 不在 helper 权限面内。
- 恢复 roster 后先跑 activation preflight，再 converge wrapper/helper、lint fixed plist、bootstrap exact label；runtime 继续使用 durable thread/cursor，既有 turnless `-32600` self-heal 路径未修改。

## 验证命令

已通过的 targeted gates：

```text
pnpm --filter flywheel-teamlead build
pnpm --filter flywheel-teamlead exec vitest run <9 changed suites>
  162 passed
bash packages/teamlead/scripts/__tests__/raya-activation-preflight.test.sh
  6 passed
bash packages/teamlead/scripts/test-tui-window-lost-alert.sh
  PASS
bash scripts/__tests__/resident-codex-lead-recover.test.sh
  18 passed
bash scripts/__tests__/raya-resident-carrier.test.sh
  12 passed
bash scripts/__tests__/package-onboard.test.sh
  28 passed
bash scripts/__tests__/packaged-seams.test.sh
  17 passed
bash scripts/__tests__/converge-flywheel-bin.test.sh
  15 passed
bash scripts/__tests__/fly1577-cmux-bin-closure.test.sh
  31 passed
bash scripts/__tests__/converge-fly1389.test.sh
  22 passed
bash scripts/__tests__/fly1577-alert-arrival.test.sh
  7 passed
bash scripts/__tests__/check-global-path-hygiene.test.sh
  21 passed
pnpm --filter flywheel-config exec vitest run \
  src/__tests__/flag-truth.test.ts \
  src/__tests__/feature-flags-drift.test.ts
  48 passed
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
  PASS: 246 shell suites and 3 generalized Node suites classified
bash scripts/__tests__/ci-structure.test.sh
  PASS
bash scripts/__tests__/simba-grep-zero.test.sh
  5 passed
```

## CI 红→绿闭环

PR 首次完整 CI 暴露了三项 FLY-2216 自有遗漏，均先复现 RED 再修复：

- 五个 `FLYWHEEL_RAYA_BRAIN_*` 数值阈值没有进入 flag truth accounting，导致
  `feature-flags-drift.test.ts` 2 项失败；现已作为带 FLY-2216 理由的
  `NON_FLAG_ALLOWLIST` numeric tuning 登记，并有 focused truth test。
- 两条新增 shell suite 未被 workflow/manual inventory 枚举，且两个新增 payload
  脚本缺 packaged-path audit disposition；现有 dedicated Script Tests 2/2 step、
  `ci-structure` 固定顺序与完整 audit row。
- recovery helper 首次进入 state-bin converge 权威时会被误报为既有文件漂移；现
  使用一次性 0600 adoption receipt 静默完成首次安装，后续 drift 仍 severe，
  `packaged-seams` 17/17 与 converge C9b/C9c/C9d 锁定该边界。

第二轮完整 CI 又发现安全 fixture 原样写入已退休 Simba token env 名，触发 repo-wide
grep-zero。fixture 现在用分段 shell 字面量生成相同的 secret-bearing environment，
所以 unmatched-quote/secret-off-argv 回归仍有辨别力，而源码 grep-zero 为 5/5。

最终 exact code head `c61482535` 的 GitHub Actions run
[`33479775008`](https://github.com/xrliAnnie/flywheel/actions/runs/33479775008)
全绿：Quick Gate、Script Tests 1/2、Script Tests 2/2、Unit light/heavy、三个
Teamlead shard、payload distribution 与 `CI OK` 全部 success。

Required full-repository gates:

```text
pnpm lint
  PASS: exit 0 with 14 unrelated warnings; the FLY-2216 changed TypeScript
  files also pass targeted Biome checks.

pnpm -r build
  PASS: all 22 runnable workspace projects built successfully.

pnpm test:packages:run
  FAIL: packages/core completed 219 passing tests and 2 failing macOS-only
  Terminal automation tests. The failures are host-environment errors from
  osascript/Terminal ("Connection Invalid" and AppleScript syntax errors), not
  FLY-2216 assertions. The final shell-only repair run also hit the known
  parallel 5-second config census timeout; its isolated rerun passed 27/27 in
  3.4 seconds. All 162 changed-suite teamlead tests pass independently.

bash scripts/__tests__/raya-resident-carrier.test.sh
  PASS: 12 passed

bash scripts/__tests__/resident-codex-lead-recover.test.sh
  PASS: 18 passed
```

The unrelated lint warnings were preserved rather than folded into this
bounded change. The local package-test failures are confined to the macOS GUI
host path plus the parallel census timeout described above; the authoritative
Linux CI package shards are green at the reviewed code head.

Cross-family code review R6 APPROVED exact code head `c61482535`; the R1
blocking marker-poisoning finding, the Lead-required secret-in-argv advisory,
and both post-review CI contract regressions are closed. Six MEDIUM and seven
remaining LOW non-blocking advisories were reported to the Lead by durable
`findingKey` for follow-up triage; none was a blocking review verdict.

## QA FAIL 返工验证

返工代码 commit `56e4dde75` 对 QA blocking finding 做净删除并新增两个 RED→GREEN regression：

- observer 实例不再具有 `assistantCompleted`，runtime 不再把 completed output 送入脑健康面；
- 带历史 `lastOfflineDeclarationAt` 的 legacy heartbeat 在新 classifier 中仍分别得到 `healthy` 与
  `poll_loop_stalled`，不会产生 declaration-only 告警或覆盖真实 stall category；
- `TMPDIR=/definitely-missing/fly2216` 下 carrier 12/12、recovery 16/16，证明测试根固定 `/tmp` 后
  不再依赖 runner 的 ambient TMPDIR。

返工头的本地全仓门：

```text
pnpm lint
  PASS: exit 0，14 条与本单无关的既有 warning。

pnpm -r build
  PASS: 22 个 runnable workspace projects 全部 build。

pnpm test:packages:run
  FAIL: 仍是 packages/core 的两个 macOS Terminal/osascript host case；其余 core 219 项通过。
  失败签名与初版头逐字相同（Connection Invalid + AppleScript syntax），不涉及本单文件。

9 个受影响 teamlead suites
  PASS: 160/160。

config flag truth + drift
  PASS: 48/48。

TMPDIR hostile shell gates
  PASS: carrier 12/12；recovery 16/16。
```

返工后 production source 全树不再存在 `assistant_declared_offline`、
`declared_offline_unconfirmed`、`declared_offline_correlated_stall` 或
`lastOfflineDeclarationAt`；唯一保留的 offline 字段出现在兼容性 regression fixture 中，用于证明旧
heartbeat 不再影响分类。

## Founder B 通用化返工（implement attempt 5）

返工代码 `705de8b48`、`78a6c5898` 将专用绑定改为通用、默认关闭的 resident Codex Lead 机制：

- `ProjectConfig` 新增严格布尔 opt-in；只有 `codex-app-server + canSpawnRunners:false + recognized tier`
  的 Lead 可被 selector 枚举。Raya 与 Mufasa 正例、未 opt-in InfraBot 负例均锁定。
- lifecycle、patrol、GatePoller hook、阈值 env 与告警 kind 全部改用 generic Codex residency 名称；
  production source 中不再存在 `RayaBrain`、`raya_brain_stalled`、`FLYWHEEL_RAYA_BRAIN_*` 或旧 helper 名。
- Bridge 为每个 target 独立构造 patrol，并用 `Promise.all` 隔离 target 失败；告警 event id 含 lead key，
  防止跨 Lead episode/claim 碰撞。
- 恢复 helper 由 target 参数导出 manifest、plist、state 与 marker 路径；mutation 前仍执行原来的 authority
  digest 二次核验、pid+lstart+argv+CODEX_HOME 二次核验、durable receipt、有界 exact-label kickstart 与
  new-generation convergence。未增加任意 wrapper 的破坏权限。
- 三条 recovery candidate 保持只有 `poll_loop_stalled`、`turn_stalled`、`heartbeat_stalled`；offline
  declaration 信号继续为零生产代码命中。

返工后的 focused 证明：teamlead 7 suites 118/118、ProjectConfig/REST poll/turn/lifecycle 199/199、
config flag truth 34/34、recovery 18/18、carrier 12/12，以及 converge/package/arrival 回归
15/15、31/31、7/7、22/22 全绿。

cross-family review 在 `bd64fb4a7` 发现一个 HIGH：TUI runtime 无条件执行 `loadProjects()`，因此
projects registry 中任意一个与本机制无关的 invalid row 都可能让**未 opt-in** 的 resident Codex Lead
启动失败。修复 `5da329148` 先用 failing regression 复现，再让 roster load fail-safe 为“禁用 observer +
通用 warning”；真实 runtime call site 也走同一 helper，不再把可选 residency observer 变成 carrier
可用性的前置条件。修复后 7 suites 为 118/118，teamlead typecheck 与两条新增 shell gate 均通过。

fresh review round 4 在 exact head `f49dd20dbd566da3bf98f0c3064a9f3326003afe`
`APPROVED`，确认上述 HIGH 已关闭；4 个 MEDIUM 与 6 个 LOW advisory 已按 findingKey 通过 durable
report 交 Lead 后续分单，不是本轮 blocking verdict。

同一 exact code head 的 GitHub Actions run
[`33538674675` attempt 2](https://github.com/xrliAnnie/flywheel/actions/runs/33538674675)
全绿。attempt 1 的全部 shell assertion（末段 94/94）已经通过，唯一失败是 FLY-1870 elapsed
tripwire：1032 秒超过 1020 秒 warning budget 12 秒；未改代码的 failed-job rerun 随后通过
Script Tests 1/2 与最终 `CI OK`。其余 Quick Gate、两个 shell shard、全部 unit/teamlead shard 与
payload distribution 在该 run 均为 success。

规定全仓门在当前 resident 环境的结果：

```text
pnpm lint
  PASS: exit 0（14 条既有 warning）

pnpm -r build
  PASS: 22 个 runnable workspace projects 全部 build

pnpm test:packages:run
  FAIL: 唯一失败仍为 packages/core 的两个既有 macOS real-Terminal tests；当前镜像的
  Terminal.app 由 LaunchServices 启动即返回 kLSNoExecutableErr，osascript 同时返回
  com.apple.hiservices-xpcservice Connection Invalid。该测试的 isolated rerun 同签名失败；
  FLY-2216 focused suites 全绿，未修改/跳过该测试。

bash scripts/__tests__/raya-resident-carrier.test.sh
  PASS: 12 passed

bash scripts/__tests__/resident-codex-lead-recover.test.sh
  PASS: 18 passed
```
