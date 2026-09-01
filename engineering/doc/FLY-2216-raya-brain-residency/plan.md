# FLY-2216 Raya 脑常驻体制 — 实施计划
Issue: FLY-2216 (https://linear.app/geoforge3d/issue/FLY-2216/raya驻场-raya-脑常驻体制与-codex-lead-同级的常驻-pane-假活自愈-可观察日志8-31我下线了僵尸一天无人知)
日期: 2026-08-31
基于: research.md

## 1. 目标与验收

本 PR 只修改 Flywheel 驻场/管护/观测，不修改 Raya 产品行为。合入后的代码应允许 updater/既有 operator 流程把 canonical `raya/raya` 注册为 `com.flywheel.lead.raya-raya`：launchd 常驻、真实 fixed-thread TUI 以 `raya-raya` 出现在 canonical tmux/cmux、生命周期写入可 tail JSONL、业务心跳假死时由现有 GatePoller rider 分类并在 exact identity 栅栏内原地恢复。

验收必须同时满足：

1. 不再以“最新 rollout tail”作为正式会话面；关闭/丢失 `raya-raya` pane 后由 TUI runtime 的既有 window liveness 重建真会话，FLY-2207 roster/watcher 负责观测并重新对齐 cmux workspace；
2. 正常空闲只要 Discord poll **attempt** 在推进就判 loop 健康；上游 Discord/auth/rate-limit 失败与本地 poll loop 停滞必须分开，前者只告警、不重启；
3. assistant 窄匹配自宣下线必须落日志并告警，但单独不授权重启；只有随后出现独立 poll/turn/heartbeat stall，且满足同 generation 共享连败阈值，才自愈；健康样本清零，episode 内最多自愈一次；
4. 恢复只作用于 exact Raya launchd job，并在 mutation 前二次核验 pid+lstart+argv/home；identity 不确定时只告警；
5. JSONL 可 `tail -f`，heartbeat 原子可读，最近消费只含 id/时间，不含用户或 assistant 正文；
6. 除 exact `com.flywheel.lead.raya-raya` 常驻 carrier 本身外，不增加第二个 watchdog timer/LaunchAgent 或告警输送层；不把 2032 的 missing env 噪音纳入本单；
7. 本节点不注册/重启生产 Raya，不删除应急窗，不 deploy、不 merge。

## 2. 锁定设计

### 2.1 身份与命名

- Registry identity：`projectName=raya`, `leadId=raya`, `backend=codex-app-server`, `codexProfile=full-access`, `canSpawnRunners=false`, `companion` absent/false。FLY-350 禁止 full-access 与 `companion:true` 共存；activation preflight 同时继续钉住 role、bot identity、model/effort/context 与 summary role。
- launchd label：`com.flywheel.lead.raya-raya`。
- tmux window 与 cmux workspace：`raya-raya`，沿现有 Lead canonical naming；`Raya-brain` 只保留为应急现场名，不进入正式配置。
- fixed thread、CODEX_HOME、workspace 继续由 `run-codex-lead-raya-tui-fullaccess.sh` 提供，不新建第二身份。

### 2.2 数据协议

新增 `RayaBrainLifecycleObserver`，只在 `projectName === "raya" && leadId === "raya"` 时构造。固定输出：

```text
<FLYWHEEL_CODEX_LEAD_STATE_DIR>/brain/lifecycle.jsonl
<FLYWHEEL_CODEX_LEAD_STATE_DIR>/brain/heartbeat.json
```

heartbeat schema v1 至少包含 `generationId`、`threadId`、`processPid`、`carrierInstanceId`、`state`、`onlineAt`、`lastGatewayPollAttemptAt`、`lastGatewayPollResultAt`、`lastGatewayPollStatus`、`lastGatewayPollFailureClass`、`lastConsumedMessage`、`activeTurn`、`lastTurn`、`lastOfflineDeclarationAt`、`lastLifecycleEvent`、`updatedAt`。所有字符串有长度/字符边界；文件/目录拒绝 symlink，目录固定权限，JSONL 追加与 heartbeat 同目录 temp+rename。observer 写失败只写 redacted stderr，不抛入业务主循环。

### 2.3 分类与默认阈值

`RayaBrainPatrol` 的纯 classifier 输入为 heartbeat 快照、exact carrier evidence、当前时间、durable observed-generation marker 与 controlled-wave marker。默认值以保守、可测试 env 解析承载：startup grace 120 秒、poll-attempt stale 120 秒、turn stale 30 分钟、ambiguous consecutive failures 3；测试注入 clock/threshold，不依赖 sleep。

分类分两组：

- **alert-only / no mutation**：`uncertain_identity`；当前 pid+lstart 从未见过 valid heartbeat 的 `observer_missing`；poll attempt 新鲜但结果为 auth/rate-limit/5xx/network 的 `upstream_unavailable`；业务面仍健康的 `declared_offline_unconfirmed`。
- **recovery candidate**：active turn 超时的 `turn_stalled`；最后 poll **attempt** 超时的 `poll_loop_stalled`；曾观察当前 pid+lstart 后 heartbeat stale/missing/malformed 的 `heartbeat_stalled`。若 stall 发生在 offline declaration 之后，诊断分类提升为 `declared_offline_correlated_stall`，但仍不跳过连败门。

只有 recovery candidate 进入共享连续失败计数；healthy 清零，identity/generation 变化换 episode。controlled wave 只有 exact Raya tuple 匹配才返回 `suppressed_controlled_wave`，不按可执行文件名泛化。

### 2.4 自愈权限

TypeScript patrol 不直接 kill。它调用仓内固定 `scripts/raya-brain-recover.sh`；脚本只接受无用户路径的固定 action/可注入 test root，并执行：

1. 从 canonical projects + manifest + plist 调用 `lead-restart-lifecycle.sh` 的 authority validator，验证 exact `raya/raya/codex-app-server` 与 fixed wrapper；
2. 读取 launchd pid、UTC lstart、完整 argv 与环境中的 canonical CODEX_HOME，写 pre-mutation recovery receipt/claim；
3. mutation 前重读 authority digests 和同一 pid+lstart+argv/home；任一变化以 distinct nonzero code fail-close；
4. 通过 bounded launchctl `kickstart -k gui/<uid>/com.flywheel.lead.raya-raya` 原地替换；不调用 `kill`、`pkill` 或按进程名扫描；
5. 等待新 pid/new generation heartbeat，在 episode 结果中返回 converged/failed。

receipt 采用 append-only JSONL，字段与 FLY-2211 的 future kill-ledger seam 分离命名；若 FLY-2211 在实施前已进入 base，则直接调用其 canonical ledger helper，不保留平行 schema。无论哪种 base，mutation 前必须先有 durable receipt。Bridge 另以 atomic observed-generation marker 记住“该 pid+lstart 已至少产出一次 valid heartbeat”，从而在 Bridge/Lead 分步升级时对旧 build fail-safe 为 alert-only。

observed marker 固定为 `<homeDir>/.flywheel/state/codex-lead/raya/brain/patrol-observed-generation.json`；`homeDir` 由 patrol constructor 注入（生产为 `homedir()`，测试必须用 temp home），拒绝 symlink、同目录 temp+rename。文件只保存当前一个 `{pid,lstart,generationId,carrierInstanceId,observedAt}` tuple；新 exact job 的第一份 valid heartbeat 原子替换旧 tuple，因此空间恒定，不能由 QA fixture 污染生产 state。

## 3. TDD 实施批次

每批严格执行：先写一个能描述缺失行为的失败测试并确认预期失败，再写最小实现使其变绿，最后只做保持绿灯的重构。每批独立提交并更新 `progress.md`。

### Batch A — exact Raya resident carrier

先新增/扩展 shell 测试：

- `scripts/__tests__/raya-resident-carrier.test.sh`：exact identity 必须是 `raya/raya + codex-app-server + codexProfile:full-access + canSpawnRunners:false + companion!=true`；相近 project/lead/backend/profile/capability 均不命中；fixed plist template 只含 fixed wrapper 且不接受 manifest launcher；wrapper dry-run 投影 canonical env；
- 扩 `raya-activation-preflight` 测试：上述 profile/capability 与既有 FLY-2131 identity/model/workspace/summary latch 同时通过才 PASS；任一漂移在零 activation mutation 前失败；
- 加结构性 authority-binding 断言：template 的 Label 与 `ProgramArguments[0..1]` 必须逐字匹配 `lead-restart-lifecycle.sh`、`host-tmux-selection-gate.sh`、`converge-flywheel-bin.sh` 接受的 exact label/wrapper basename；任一侧 rename 漂移测试必红；
- 扩 `host-tmux-selection-gate.test.sh`、`lead-restart-controlled-wave.test.sh`、`test-cmux-sync.sh` 的 exact carrier/census/roster 正负例；`materialize-lead-manifests.test.sh` 只断言 `raya-raya.json` 的 backend 为 `codex-app-server`，不虚构 carrier 字段；
- 扩 `flywheel-daemon`/`flywheel-fleet` 测试，锁定 bespoke Raya 仍由 daemon 跳过、fleet 仍报告 `external-confirmed`，防止 relaxed classifier 把它卷入 v2 staged bootout/bootstrap；
- 扩 package/converge/path-hygiene 结构测试，先证明新 wrapper 未进入闭包而红。

最小实现：

- 新增 `scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh` 与 fixed `packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist`，镜像 Mufasa 的 env、host-tmux gate、fail-loud 和 fixed launcher 形状，但文案/transaction/carrier 全部为 Raya，且不能从 manifest 注入路径；
- 修改 `packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh`，像 infra-bot launcher 一样显式 `export FLYWHEEL_ROOT=<repo root>`，让 `createTuiWindowAlertGuard` 能解析 existing `scripts/lead-alert.sh`。测试必须运行真实 Raya launcher 的 dry-run/stub runtime 捕获其实际 projected env，再用该 env 断言 guard 对 `raya/raya` 非 null；禁止直接手造含 `FLYWHEEL_ROOT` 的测试 env 掩盖生产漏线；
- 扩 `packages/teamlead/scripts/raya-activation-preflight.sh`，把 profile/capability、wrapper、plist label/argv、packaged closure 纳入现有只读 fail-closed 激活门；operator 顺序固定为 preflight → converge installed wrapper → copy/lint fixed template → bootstrap exact label，本节点只验证、不执行生产步骤；
- **不修改** `flywheel-daemon.sh::classify_plist_lead_carrier` 或 staged transaction；bespoke Codex 继续由 daemon 跳过。更新 `host-tmux-selection-gate.sh`、`flywheel-cmux-sync.sh`、`lead-restart-lifecycle.sh`、`restart-services.sh`、`converge-flywheel-bin.sh`、`package-onboard*`、`path-hygiene.sh`、provision/packaged allowlist 的闭合 carrier 集；
- 不改变 generic v2、Mufasa、infra-bot byte path。

渲染断言：测试中的 tmux fixture 必须看到 `raya-raya` window/真实 launcher，而不是 `tail` 命令；runtime 20 秒 liveness 负责重建被关闭的 window。cmux sync dry-run/fixture 必须识别 roster、得到同名 workspace，duplicate/config drift 不建第二窗；它只告警 missing window，不冒充 window creator。

### Batch B — 可 tail 生命周期 observer

先新增 `packages/teamlead/src/lead-backends/codex/__tests__/raya-brain-lifecycle.test.ts`：

- online/poll/consume/turn/offline/shutdown 事件顺序；
- heartbeat atomic replacement 与 generation reset；
- message/output redaction；目录或文件 symlink、oversize/corrupt prior state、write/rename failure；
- assistant declaration detector 的锚定正例，以及用户引用、否定、代码块、解释文本、子串负例。

最小实现 `packages/teamlead/src/lead-backends/codex/raya-brain-lifecycle.ts`：纯 detector + schema validator + observer writer。默认用真实 fs/clock/uuid，测试可注入；最大单行与快照尺寸闭合；writer 失败经 logger 软失败。

### Batch C — 把健康信号接到真实业务边界

逐个先红后绿扩现有测试：

- `RestPollDiscordInboundSource.test.ts`：**baselineChannel 与 ready-channel delivery 两条 fetch 路径**都在 fetch 前收到 attempt，并分别收到 success 或带 closed failure class/status 的 failure；全 channel 永远 UNREADY + baseline 401 的循环仍每 3 秒刷新 attempt，永远归 upstream/no-mutation；handler durable-accepted 后记录 consumed id/时间与 `cursorPersisted` 结果；handler 拒绝不谎报 consumed，cursor save 失败仍如实表示 journal 已接受且保留 at-least-once replay；未传 observer 完全兼容；
- `CodexTurnExecutor.test.ts`：start 成功后发 started，resolve/reject/exit 发唯一终态；start 失败不遗留 active turn；observer throw 不改变 executor result；
- `codex-lead-tui-runtime.test.ts`：仅 exact Raya 创建 observer并写 `online`；hooks 贯穿 source/executor/router；completed entry 的 `output` 只进 detector 不进日志；generation teardown 写 lost/shutdown；其他 Lead 不创建 brain 文件。

`LeadInputRouter` 已有 completed hook，不改 journal 状态机；runtime 组合 external receipt 与 lifecycle 回调，确保既有 receipt 永远不被覆盖。

poll failure 不从 Error message regex 反推。`RestPollDiscordInboundSource.ts` 增加内部 structured failure shape（`class: auth|rate_limit|server|network|unknown`, `status?:number`）：HTTP response 还在 scope 时按 status 构造，transport/Abort/DNS 在 catch 边界映射，所有未识别残余统一为 `unknown`。observer 只收 closed class/status，不收 URL/token/message；任何 fresh failed attempt（包括 `unknown`）都是 degraded alert-only，绝不 fall through healthy 或 recovery。

### Batch D — 假活 classifier、episode 与告警

新增 `packages/teamlead/src/bridge/__tests__/raya-brain-patrol.test.ts`，先覆盖纯状态机：

- 空闲但 poll 新鲜、turn 正常进行均 healthy；
- explicit offline + 健康业务面、fresh failed attempts/upstream outage、current pid+lstart 从未见 heartbeat 均 alert-only 且零 helper；offline 后独立 stall、poll loop stale、turn stale、observed-generation 后 heartbeat stale/missing/corrupt 才是 candidate，并需共享连续失败阈值；category 改变不重置 shared count，identity/generation 改变会重置；
- healthy 清零；startup grace；exact controlled wave suppression；过期/错误 tuple 不 suppression；
- episode 一次 recovery/一次 alert，converged 后关闭，helper fail/timeout 不重复自旋；single-flight；
- identity evidence 缺 plist/manifest、label/backend/wrapper 不符、PID reuse、lstart/argv/home 改变都 no-mutation。

最小实现 `packages/teamlead/src/bridge/raya-brain-patrol.ts`：pure parser/classifier + stateful episode wrapper + injectable recovery/alert。heartbeat 限尺寸、拒绝 symlink、解析失败不 crash GatePoller。

给 `GatePoller` 增加独立 optional `onRayaBrainPatrolTick`，使用现有 60 秒 timer/cadence 与自己的 single-flight；`plugin.ts` 只为 projects roster 中 exact Raya target 构造它。该 hook 在 `flywheel` project 缺失、cmux watcher patrol 为 null 时仍注册并运行。复用 `leadPendingAlertHolder.current.alert`，不增加 timer/daemon/sink。

脑健康告警固定使用新 kind `raya_brain_stalled`，route 固定 `{projectName: FLEET_ALERT_PROJECT("machine"), leadId:"raya-brain"}`，由 unified fleet chain 投给仍活着的 sender，绝不寄往 Raya 自己。kind 在 `LeadAlertNotifier.ts`、`infra-event-router.ts`、`kind-contract.ts`、`alert-kind-copy.ts` 与 `scripts/lead-alert.sh` 的共享 face 登记为 infra ticket；body 只含 category、last attempt/result、identity/generation 与 recovery 结果，不含对话。禁止复用 runner `crash_loop`。

pane loss 明确不进 `RayaBrainPatrol`。扩 `tui-window-alert.ts` exact identity allowlist 为 infra-bot 或 `raya/raya`，继续复用既有 `tui_window_lost` 连败、durable episode latch 与 shell alert；live shell alert title/body 按 project/lead 参数化（Raya 显示 “Raya Codex TUI”，infra-bot 保持其身份），同时更新 exhaustiveness copy。这样 window 只有 runtime guard 一位 pager，脑 stall 只有 Bridge patrol 一位 pager。

### Batch E — exact recovery helper 与 replay/negative guards

新增 `scripts/__tests__/raya-brain-recover.test.sh`，用 fake home、plist/manifest/projects、launchctl/ps/proc fixtures 先证明：

- healthy/未达阈值、fresh upstream failures、unconfirmed offline、never-observed heartbeat 均不调用 helper；eligible exact tuple 先落 receipt 再 kickstart；
- label、wrapper、backend、manifest path、CODEX_HOME、pid、lstart 或 argv 任一错误均零 mutation；
- snapshot 后 PID reuse/authority digest 改变，二次检查阻断；
- receipt 写失败、launchctl timeout/nonzero、新 pid 未出现、新 heartbeat 未出现均显式失败；
- retry 同 episode 幂等，new generation 可开启新 episode；controlled restart marker exact-match 豁免；
- restart 后 durable cursor 从原消息后继续、observer generation 重建；已有 persisted rollout 的 thread id 不变，turnless saved thread 允许沿既有 `-32600` self-heal 生成新 id；不触碰 `com.xrli.raya.brain`。

实现固定 helper、bounded command 与 receipt writer，并把所需文件加入 package/converge/path hygiene。测试不得使用生产 `$HOME` 或真实 launchctl。

### Batch F — 集成证明与操作文档

在 `engineering/doc/FLY-2216-raya-brain-residency/implementation-evidence.md` 记录可复现命令与脱敏输出：

1. temp home 的 FLY-2131 activation preflight → materialize backend manifest → fixed plist lint → fake launchd start；
2. isolated tmux server 启动 canonical `raya-raya` window，`capture-pane` 证明是真 `codex resume --remote` 会话；
3. 分开证明 ownership：runtime fixture 关窗后在 liveness cadence 重建同 thread window；cmux sync fixture 观测 roster、告警 missing window、在 window 恢复后重建/复用 workspace，不 flap 健康窗；
4. tail JSONL，注入 upstream outage、poll-loop stall、turn stall、offline-only 与 offline+stall fixtures，证明 no-mutation 分类、连败、一次恢复、generation 收敛；
5. rollback：禁用项目 roster/bootout exact test job 后 patrol 只报告 absent，不误启动产品 job；重新 materialize/bootstrap 可 replay。

不将任何 token、真实 Discord 正文、真实 production mutation 或被拒读 secret 写入证据。

## 4. 预计文件面

新增：

- `scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh`
- `scripts/raya-brain-recover.sh`
- `scripts/__tests__/raya-resident-carrier.test.sh`
- `scripts/__tests__/raya-brain-recover.test.sh`
- `packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist`
- `packages/teamlead/src/lead-backends/codex/raya-brain-lifecycle.ts`
- `packages/teamlead/src/lead-backends/codex/__tests__/raya-brain-lifecycle.test.ts`
- `packages/teamlead/src/bridge/raya-brain-patrol.ts`
- `packages/teamlead/src/bridge/__tests__/raya-brain-patrol.test.ts`
- `engineering/doc/FLY-2216-raya-brain-residency/implementation-evidence.md`
- `engineering/doc/milestones/FLY-2216.md`（PR 前 literal last commit）

修改：

- Codex TUI runtime、`RestPollDiscordInboundSource.ts`、`CodexTurnExecutor.ts`、`run-codex-lead-raya-tui-fullaccess.sh` 及对应测试；
- Bridge `gate-poller.ts`、`plugin.ts`、`LeadAlertNotifier.ts`、`infra-event-router.ts`、`kind-contract.ts`、`alert-kind-copy.ts` 与对应测试；
- `tui-window-alert.ts`、`raya-activation-preflight.sh` 及对应测试；
- materializer（仅 backend characterization）、restart/census/cmux/converge/package/path-hygiene 脚本及现有结构测试；`flywheel-daemon.sh`/`flywheel-fleet.sh` 只加“不接管 bespoke Raya”的锁定测试，不改生产 classifier。

若红测试证明某闭包由单一共享 helper 生成，可减少文件面；不得通过放松 identity gate 或跳过负例来减范围。

## 5. 验证与完成顺序

1. 每批运行最窄测试；涉及 shell 的测试用 `bash <test>`，TypeScript 用对应 package test filter。
2. Batch 完成后跑受影响 package/build 与所有受影响既有 shell suites。
3. 实现结束执行准确全仓门：

   ```bash
   pnpm lint
   pnpm -r build
   pnpm test:packages:run
   bash scripts/__tests__/raya-resident-carrier.test.sh
   bash scripts/__tests__/raya-brain-recover.test.sh
   ```

4. 对 rendered pane 做 isolated tmux `capture-pane`；若当前环境可用 cmux screenshot/proof 工具，再做同名 workspace 视觉证据，否则把 capability 缺失与可执行 fixture 证明写入 evidence，不伪造 production 截图。
5. `stage set code_review` 后注册新的 `review_code` gate/request；CHANGES_REQUESTED 每轮修复、推新 head、开新 gate。APPROVED advisories 通过 `ask --report` 转给 Lead。
6. 推分支，创建 PR；最后写 `engineering/doc/milestones/FLY-2216.md`，把 milestone 作为 literal last commit，再更新远端 PR head。
7. 通过 `ask --report` 报告 commits、测试、PR 与“生产未激活”；执行 `complete --route needs_review --pr <number>`。不 dispatch QA、不请求 ship approval、不 merge/deploy。

## 6. 设计评审 R1 finding 处置

| findingKey | 处置 |
| --- | --- |
| `raya-carrier-companion-invariant-contradiction` | carrier 改为 exact `codexProfile:full-access + canSpawnRunners:false + companion!=true`，并由 FLY-2131 activation preflight 共验 |
| `intake-stalled-restarts-on-upstream-discord-failure` | attempt freshness 与 result 分离；fresh upstream failure 永远 alert-only，只有 loop 本身 stale 才可恢复 |
| `declared-offline-immediate-kill-on-model-utterance` | declaration 单独只日志+告警；必须被之后的独立 stall 佐证，且仍需共享连败 |
| `patrol-tick-coupled-to-flywheel-project` | 独立 `onRayaBrainPatrolTick`，复用同一 GatePoller timer 但不依赖 cmux watcher/flywheel row |
| `alert-route-and-kind-unspecified` | 固定 machine sentinel route + 新 `raya_brain_stalled` kind；不复用 `crash_loop`，共享 registry 全列入文件面 |
| `daemon-carrier-classifier-fanout-untested` | 不改 daemon/fleet classifier；bespoke path 继续 external-confirmed，并加负向锁定测试 |
| `existing-tui-window-alert-guard-not-reconciled` | pane 由既有 `tui_window_lost` guard 独占；brain patrol 明确不看 pane |
| `cmux-sync-does-not-restore-windows` | runtime 负责重建 window；cmux sync 只观测 roster/告警并对齐 workspace，证据拆开 |
| `heartbeat-missing-cannot-distinguish-stale-build` | 当前 pid+lstart 从未见 heartbeat 时只报 observer_missing；durable observed-generation marker 后才可把缺失视为 stall |
| `activation-preflight-not-in-operator-path` | 扩 FLY-2131 preflight 并把它放在 operator 顺序第一步 |
| `fixed-thread-id-assertion-ignores-turnless-selfheal` | thread 不变只要求 persisted rollout；turnless 保留既有 `-32600` fresh-thread self-heal |
| `materializer-has-no-carrier-concept` | materializer 只测 backend manifest；carrier 权威留给 fixed plist/projects/restart validator |

R2 新增 findings 同样闭合：`tui-window-guard-cannot-arm-for-raya` 由真实 launcher 导出/投影 `FLYWHEEL_ROOT` 的测试关闭；baseline 与 delivery fetch 共用 attempt/result observer；failure class 在 HTTP response scope 内结构化且 unknown 只告警；plist template 与三处 carrier authority 做逐字结构绑定；live `tui_window_lost` title 按 identity 参数化；observed marker 使用 injected temp-safe home 与单 tuple 恒定空间。

## 7. 风险与回滚

- **误杀健康 Raya**：identity uncertainty 一律 no mutation；二次 authority/pid+lstart+argv/home 核验；episode 一次恢复；测试覆盖 PID reuse/TOCTOU。
- **正常空闲/上游故障误报**：健康以内生 REST poll attempt freshness 为主，不要求消息或 rollout 活跃；fresh failed attempt 分类为 upstream alert-only，turn 只在 active 时计 deadline。
- **“我下线了”提示注入**：只扫描完成 assistant output 的独立宣告，排除 user/prompt/history/quote/code/negation；不持久化正文；宣告单独永不授权 mutation，必须由之后的独立 stall 佐证。
- **observer 反噬主流程**：全部 hook 可选、sync failure 隔离；其他 Lead 的 byte path 不变。
- **双 watcher/双告警**：window 由 runtime liveness + 既有 `tui_window_lost` guard 独占；brain stall 由 GatePoller 独立 hook + `raya_brain_stalled` 独占；cmux sync 只做 roster/workspace。无新 launchd watchdog、timer 或 webhook。
- **与 1955/2211 竞合**：Lead 已确认本单保持 origin/main base、不 stack 两条未合入分支；若它们先合入则 rebase 后删除重复 seam，复用 canonical category/ledger helper。
- **回滚**：移除 Raya roster entry/bootout exact `com.flywheel.lead.raya-raya` 即停止正式 carrier；代码层 observer/patrol 因 target 缺失不动作，产品 `com.xrli.raya.brain` 与 durable conversation files 保持不变。
