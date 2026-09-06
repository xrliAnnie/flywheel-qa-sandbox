# FLY-2239 Codex Lead 全员 cutover — 探索
Issue: FLY-2239 (https://linear.app/geoforge3d/issue/FLY-2239/cutover-resident-codex-lead-全员切换2216-ship-后名册-opt-in-激活五步-pane-告警对齐)
日期: 2026-09-05
基于: 无

> 成色标记:【实核】= 本机只读读码/读状态,命令附在各节;⬜ = 工程判断;❓ = 待 Lead/founder 裁。
> 本节点零生产写入:没有改 `~/.flywheel/projects.json`、plist、launchd、tmux、Discord,没有重启任何进程。

## 0. 一句话

issue 写的是「2216 ship 后给三个 Codex Lead 各做一遍五步激活」,但【实核】生产已经走完了其中两位(mufasa-lead、codex-infra-bot-lead 于 2026-09-02 06:57Z / 07:27Z opt-in,今天观察者与 Bridge 巡逻都真在跑),founder 对 InfraBot 纳入的原话也已落在 Discord(2026-09-02 06:37Z/06:38Z);所以本单真正剩下的是 **① Raya 按 FLY-2259 runbook 激活 ② 两位已激活 Lead 补齐三项真机验收(假死自愈、真 Discord 告警、pane 活)③ pane 告警从两个写死身份改成名册驱动(唯一代码改动)④ 把决策与收官状态落成一页**。

## 1. 现状审计(全部【实核】,2026-09-05 06:5x–07:0x UTC)

### 1.1 三个 Codex Lead 的现状表

| 项 | raya / raya | growth / mufasa-lead | flywheel / codex-infra-bot-lead |
|---|---|---|---|
| `projects.json` 行 | **不存在**(registrar 物料在 2259 `materials/projects.raya-row.json`,行内已带 `codexResidencyPatrol:true`) | 存在,`codexResidencyPatrol:true`,companion 层 | 存在,`codexResidencyPatrol:true`,`codexProfile:full-access` |
| opt-in 时间 | — | 2026-09-02 06:57Z(备份 `projects.json.bak-infra-1788332234` 已含) | 2026-09-02 07:27Z(备份 `projects.json.bak-2238-1788334059` 已含) |
| launchd plist | `com.flywheel.lead.raya-raya.plist` **不存在** | `com.flywheel.lead.growth-mufasa-lead.plist` 在 | `com.flywheel.lead.flywheel-codex-infra-bot-lead.plist` 在 |
| manifest | 无 `raya-raya.json` | `growth-mufasa-lead.json` 在 | `flywheel-codex-infra-bot-lead.json` 在 |
| 状态目录 `state/codex-lead/<lead>/brain/` | 无 | heartbeat.json `state:online` updatedAt 06:58Z,pid 86997 | heartbeat.json `state:online` updatedAt 06:58Z,pid 80640 |
| Bridge 巡逻已观察本代 | — | `patrol-observed-generation.json` observedAt 2026-09-05T06:12:22Z | observedAt 2026-09-05T06:10:05Z |
| 自愈回执 `recovery-receipts.jsonl` | — | **不存在**(从未触发过恢复) | **不存在** |
| `codex_lead_residency_stalled` 告警历史(claims.db) | — | 0 条 | 0 条 |
| `tui_window_lost` pane 告警 guard | allowlist 内(但未出生) | **不在 allowlist ⇒ guard 为 null,没有 pane 告警** | allowlist 内 |
| 真机 kill→自愈实测 | 未做 | 未做(无回执) | 未做(无回执) |

命令:`node -e '…projects.json…'`、`ls ~/Library/LaunchAgents ~/.flywheel/manifests`、`cat ~/.flywheel/state/codex-lead/*/brain/{heartbeat,patrol-observed-generation}.json`、`sqlite3 ~/.flywheel/alerts/claims.db`。

### 1.2 机制在跑的证据链

- Bridge `/health`:`buildSha 79f6fc39b`(= 当前 main 头,含 FLY-2216 与 FLY-2259),`bridge_started_at 2026-09-05T06:09:26Z`。
- `plugin.ts:9830-9905`:插件构造时 `findResidentCodexLeadTargets(projects)` 读一次名册,为每个 target 建 `createHostResidentCodexLeadPatrol`,挂在 GatePoller 每 20 tick 一次的 `onResidentCodexLeadPatrolTick`。
- 巡逻健康时**不打日志**(`ResidentCodexLeadPatrol.runPass` healthy 分支直接 `resetEpisode` 返回),所以 `/tmp/flywheel-bridge.log` 里 0 条 `residency` 是正常的;「已观察本代」文件才是巡逻活着的直接证据。
- runtime 侧 `codex-lead-tui-runtime.ts:468` 在进程作用域 `loadResidentCodexLeadProjectsSafely()` 读一次名册,`:628` 每代按 target 建 `ResidentCodexLeadLifecycleObserver`;两位的 `lifecycle.jsonl` 都在实时追加 `gateway_poll_attempt/ok`。

### 1.3 InfraBot「自己的 rescue 机制」到底是什么

issue 说 InfraBot「已有自己的 rescue 机制(R3 carve-out),重复看护可能打架」。【实核】两条线:

1. **FLY-871 R3**(`engineering/doc/FLY-871-codex-rescue-bot/plan.md:18,121`):R3 是 InfraBot **作为救援者**的 playbook——对被 Bridge 分类为 `login_expired/runner_login_expired` 的 session 做 restart-in-place(kickstart wrapper)/rescue-retry;carve-out 是写在 `founder-only-authority.md` 里的窄授权。它不是「InfraBot 被谁救」。
2. **`infra_bot_down` fleet 传感器 + AutoRepairBot kickstart**(`fleet-sensors.ts:553-600`、`AutoRepairBot.ts:149`、`plugin.ts:11973`):按「谁都不救自己」由对侧 bot 认领。但探针只在 `FLYWHEEL_CODEX_INFRA_BOT_JOB` 有值时才跑;【实核】生产 `~/.flywheel/.env` 与 Bridge plist 里**都没有**这个变量,bridge.log 0 条 `[fleet` / `infra-bot` 探针行 ⇒ 这条线对 codex bot **在生产没有武装**。

所以真实的「打架」面只有一个:**residency 巡逻在 InfraBot 正执行一次长救援 turn 时把它当假死 kickstart**。巡逻只对 `poll_loop_stalled(120s)/turn_stalled(30min)/heartbeat_stalled(180s)` 三类做恢复,且要连败 3 次(每次 20 tick),恢复前 helper 再核 pid+lstart+generation。一次超过 30 分钟的救援 turn 会被判 `turn_stalled` ⇒ 被 kickstart。阈值只有全局 env(`FLYWHEEL_CODEX_LEAD_RESIDENCY_TURN_STALE_MS` 等四个),没有按 target 的旋钮。

### 1.4 founder 对 InfraBot 纳入的原话(已存在)

2259 调研 §0 第 4 条已把两条 Discord 消息记为直接引用:2026-09-02 06:37Z「InfraBot(Claw)纳入」、06:38Z「go + InfraBot 纳」(#flywheel-engineer,链接见 `engineering/doc/FLY-2259-raya-brain-cutover/research.md`)。时间线:06:37Z founder go → 06:57Z mufasa opt-in → 07:27Z codex-infra-bot opt-in。

❓ 一个必须写明的歧义:agent 定义里 **Claw = claude-infra-bot-lead**(Claude 侧),而名册只允许 `codex-app-server` 后端 opt-in,实际被翻的是 **codex-infra-bot-lead**。在 residency 语境下只有 codex 这一位能纳入,所以解读唯一;但本单的记录页要把这句原话与「实际纳入对象 = codex-infra-bot-lead」并排写清,并请 founder 在计划页确认一次,不能默认。

### 1.5 pane 告警现状(2216 QA 诚实边界第 4 条)

`packages/teamlead/src/lead-backends/codex/tui-window-alert.ts:284-287`:`createTuiWindowAlertGuard` 用两个字面量 `(flywheel,codex-infra-bot-lead)`、`(raya,raya)` 决定装不装 guard;`:171-174` 标题用第二套字面量选「Raya brain」/「Infra Bot」。runtime `:482` 在进程作用域建 guard,而 `:468` 同一作用域**已经**有名册 `residentCodexLeadProjects`——名册驱动只差把这份已读好的名册传进去。mufasa 今天有业务活体巡逻、没有 pane 告警,正是 issue 描述的不对齐。

### 1.6 今天这台机器的状态(cutover 窗口的停止线素材)

- 两位 Lead 日志各 340+ 条 `lifecycle write failed … ENOSPC`(根卷曾写满,记忆库 FLY-2337 同事件);现在 `df /` 13% 已恢复。
- claims.db:mufasa-lead `crash_loop` 2026-09-04 20:05Z、2026-09-05 00:25Z;codex-infra-bot-lead `crash_loop` 2026-09-04 23:47Z。Bridge 于 2026-09-05 06:09Z 重启。
- `brain/lifecycle.jsonl` 两位各 **58 MB / 28.6 万行,从 2026-09-02 起 3 天** ⇒ 约 20 MB/天无界增长,retention registry 未登记。**不在本单范围**,但必须写进边界并建议另立单。

## 2. issue 文本与现实的三处差异

| issue 写法 | 现实 | 本单承接 |
|---|---|---|
| 「每个 Codex Lead 一遍五步」 | mufasa/InfraBot 五步已走完(名册/plist/bootstrap 都在,巡逻在跑);只有 Raya 五步没走 | Raya 走 FLY-2259 §4 runbook(它已把五步展开成 4.1–4.9);两位只补验收 |
| 「InfraBot 要不要纳入由 founder 拍」 | founder 已于 09-02 06:37Z 拍「纳」,且已执行 | 记录原话 + 「Claw」歧义确认 + 打架面分析与建议 |
| 「pane 告警要么名册驱动要么记录后果」 | 仍写死;mufasa 无 pane 告警 | 选名册驱动(唯一代码改动,见 §3.3) |

## 3. 问题拆解与选项

### 3.1 Raya 激活

只有一条路:执行 FLY-2259 `activation-runbook.md` §4.0–§4.9(Lead 在 founder 在场的安静窗口手工执行),§4.10 是班车 N+1 后的真机自愈/pane 重建/语音对照。本单不复制那份 runbook,只在计划页里引用它并把它的证据目录(`~/.flywheel/state/FLY-2259-window/evidence-*`)纳入收官表。⬜ 顺序建议:先 land 本单的 pane 名册化,再开 Raya 窗口——这样 Raya 的 pane guard 从名册来,不再依赖 allowlist;若窗口先开也不坏(Raya 在 allowlist 里),只是收官表多一行「靠旧 allowlist」。

### 3.2 mufasa / InfraBot 补验收(不再做「激活」)

每位三项,全部真机:

1. **常驻 pane 活**:`verify-windowed-lead.sh <project> <lead>` 五层全 PASS + `resident-codex-lead-recover.sh --probe` 返回 exact 身份。
2. **假死自愈**:复用 2259 §4.10 的有界 SIGSTOP 演练(参数化 project/lead/label),判据 = 新 pid/lstart + 新 generation + `recovery-receipts.jsonl` 出现 `pre_mutation` 且 old.pid = T0;12 分钟不收敛则 SIGCONT 并记失败。⬜ 不用 `kill -9`:那是 launchd KeepAlive 的路径,验的不是巡逻;issue 写「真机 kill→自愈」,SIGSTOP 才是「假死」的忠实形状,kill -9 可作为第二个对照(可选)。
3. **告警可达**:同一演练必然产生 `codex_lead_residency_stalled`(detected + recovery 两条)真 Discord 消息;记录 URL,并核 claims.db 新增行。

### 3.3 pane 告警对齐:三个选项

| 选项 | 做法 | 取舍 |
|---|---|---|
| **O1 名册驱动(建议)** | `createTuiWindowAlertGuard` 增加 `projects` 入参,用 `findResidentCodexLeadTargets` 匹配 `(projectName, leadId, leadKey)` 决定装不装;标题统一为 `Codex Lead <project>/<lead> TUI window not visible`;删掉两套字面量;名册读失败 fail-safe 为不装 + warning(与 observer 同形) | 一个真相源(名册),mufasa 立即获得 pane 告警;代价:InfraBot/Raya 标题文案变(2216 QA 曾断言「Raya brain」/「Infra Bot」标题,测试要改);若某位从名册 opt-out,pane 告警随之消失(这是想要的耦合:「被看住」是一个整体) |
| O2 保留 allowlist,只记录后果 | 零代码;计划页写明 mufasa 无 pane 告警 | 边界永久存在,下一位 Lead 又要改代码;违背 founder「每个 codex lead 都是 generic 的」 |
| O3 名册 ∪ allowlist | 两个来源取并 | 两套词汇镜像,正是角色规则要避免的 |

选 O1。负控必须有:非 opt-in 的 TUI Lead(如今天的 mufasa 若把旗关掉)必须得到 null;`leadKey` 不匹配(同名 lead 在别的 project)必须 null;名册抛错必须 null 且打日志。

### 3.4 InfraBot 纳入/豁免

| 选项 | 后果 |
|---|---|
| **I1 纳入(维持现状,建议)** | 与 founder 原话一致;唯一打架面 = 超过 30 分钟的救援 turn 会被判 `turn_stalled` 并 kickstart。缓解:① 在计划页明写这个阈值;② 演练时顺带核 InfraBot 近 3 天 `lifecycle.jsonl` 里最长 turn(`turn_started`→`turn_finished`)是否曾接近 30 分钟;③ 若曾接近,另立单给巡逻加按 target 的 `turnStaleMs`(本单不做) |
| I2 豁免 | 关旗 ⇒ 失去 observer、巡逻与(O1 后)pane 告警;而 `infra_bot_down` 传感器在生产未武装 ⇒ InfraBot「活着但僵住」将无人知晓——正是 FLY-2216 病案形状。除非 founder 明确要,不建议 |

### 3.5 「整体计划页」

❓ issue 没说是哪一页。⬜ 本单交付一页 founder-design.html(设计节点合同要求),其中一张「收官状态」卡按 §1.1 的表逐格填 done/pending,并在 cutover 完成后由持棒者以 design-correction.md 附录方式更新。已向 Lead 询问是否另有既存页面需要同步。

## 4. 风险与边界

- **巡逻目标在 Bridge 启动时读一次名册**(`plugin.ts:9830`)⇒ Raya 注册后必须一次 Bridge 重启(班车或单次 `request-restart.sh` 票)巡逻才会看她;2259 runbook 已含。
- **同名 helper 的 state-bin 副本缺 `lead-restart-lifecycle.sh`**(2259 研究实核)⇒ 运行权威是仓库路径 helper;本单不动。
- **ENOSPC 复发**会让 heartbeat 写失败 ⇒ 巡逻判 `heartbeat_stalled` ⇒ 对健康进程做 kickstart。cutover 窗口前置停止线必须含 `df /` 与最近 24h `crash_loop` 计数。
- **lifecycle.jsonl 无界增长**(§1.6)另立单。
- 本单**不**改巡逻分类器、阈值、helper、wrapper、plist 模板;**不**动 `com.xrli.raya.brain`。

## 5. 已向 Lead 提出的非阻塞问题

1. 2026-09-02 06:57Z/07:27Z 那两次 opt-in 是谁执行的、当时是否已做过演练/告警证据(若有,收官表直接引用,不重做)。
2. 「整体计划页」指哪一页。
3. 「InfraBot(Claw)纳入」在名册语境下按 codex-infra-bot-lead 解读,是否需要 founder 再确认一次。

## 6. 下一步

research.md:把 O1 的改动面、测试改动面、演练脚本参数化、收官表字段与证据路径逐项实核;plan.md:TDD 任务序 + 窗口 runbook 引用 + 回滚边界。
