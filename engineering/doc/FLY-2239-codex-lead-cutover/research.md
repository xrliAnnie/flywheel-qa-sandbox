# FLY-2239 Codex Lead 全员 cutover — 调研
Issue: FLY-2239 (https://linear.app/geoforge3d/issue/FLY-2239/cutover-resident-codex-lead-全员切换2216-ship-后名册-opt-in-激活五步-pane-告警对齐)
日期: 2026-09-05
基于: exploration.md

> 成色标记:✅ Lead 已裁(ask e4d85416,2026-09-05 07:1x UTC)· 【实核】本机只读读码/读状态 · ⬜ 工程判断。本节点零生产写入。

## 0. Lead 裁定(ask e4d85416)

| # | 裁定 | 本文承接 |
|---|---|---|
| 1 | 09-02 那两次 opt-in 查不到执行记录;**没有任何假死演练、recovery-receipt 或 `codex_lead_residency_stalled` 真告警证据** ⇒ 收官表不许引用「已演练」,两位按从未演练处理;真机强停验自愈正是本单要交的 | §4 演练合同、§6 收官表 |
| 2 | 「整体计划页」= founder 那张由 Lead 维护的本地计划页(Lead 私有工具),不在本单交付面;本单在 founder-design.html 出一张收官状态卡,并把事实(哪个 Lead、几点停、几点自愈、证据链接)ask 给 Lead,页面 Lead 更新 | §6 |
| 3 | InfraBot 按 **codex-infra-bot-lead** 解读,不需 founder 再确认(名册只能纳 Codex 常驻体、实际翻的也是它、founder 今晚 06:54Z 授权强停的「InfraBot」就是名册里这个体);页面并排写明歧义。⛔ 红线:**claude-infra-bot-lead(Claw)不在授权内**,任何触碰先 ask | §5、plan 安全边界 |
| 4 | **founder 强停授权原话**(2026-09-05 06:54:46Z,#flywheel-engineer msg 1545688627189645372):「we could do 2239 常驻验收演练 too, I am not using them recently so stop is fine」;Lead 指令 `2239-auth-20260905T0700` 定为 per-instance 授权:仅限 mufasa-lead 与 codex-infra-bot-lead、仅限演练所需次数。三条铁律:① 每次强停前先记 label、pid、时间与**预期自愈路径**,停后逐分钟记录恢复证据(pid 换代、`/health`、Discord 可达);② **自愈超过 10 分钟未发生 = FAIL**,立即用该 Lead 自己的 launchd kickstart 拉起,停止后续强停、ask Lead;③ 不动 Bridge、不动任何 runner、不改 plist。演练结论写进交付文档;FLY-2263 的前置只在 QA 判 PASS 后成立 | §4 D0/D1/D6 已按此改写 |

## 1. 代码地图(本单会碰或依赖的每个文件,全部【实核】)

| 层 | 文件 | 合同 | 本单动不动 |
|---|---|---|---|
| 名册枚举 | `packages/teamlead/src/resident-codex-lead-roster.ts` | `findResidentCodexLeadTargets(projects)`:`codexResidencyPatrol===true` ∧ `backend==="codex-app-server"` ∧ `canSpawnRunners===false` ∧ (companion ∨ codexProfile) ⇒ `{projectName, projectRoot, leadId, leadKey=<project>-<lead>}` | 不动(唯一真相源) |
| 名册读取(runtime) | `codex-lead-tui-runtime.ts:151-162` `loadResidentCodexLeadProjectsSafely` | 读失败 ⇒ `[]` + warning「roster unavailable; observer disabled」 | 复用读取;**warning 文案改为「…lifecycle observer and pane-loss guard disabled」**(同一份空名册现在同时关两路),`__tests__/codex-lead-tui-runtime.test.ts:36` 断言同步改 |
| runtime 进程作用域 | `codex-lead-tui-runtime.ts:468`(读名册)、`:482`(建 guard)、`:528`(`guard?.record(healthy)`)、`:628`(每代建 observer) | 名册与 guard 在同一作用域,先后相差 14 行 | **改 `:482` 调用:多传 `projects` 与 `leadKey`** |
| pane guard | `packages/teamlead/src/lead-backends/codex/tui-window-alert.ts` | `createTuiWindowAlertGuard` `:284-287` 两个字面量身份;`:166-168` 第二套字面量选标题;fail-soft:无 `FLYWHEEL_ROOT`/脚本不存在 ⇒ null + warning;episode latch 文件 `<stateDir>/tui-window-lost-episode.json` | **改:名册驱动 + 统一标题 + ARMED 日志** |
| guard 单测 | `.../__tests__/tui-window-alert.test.ts`(18 个 it) | `:127` 断言两套标题;`:206/:217/:244` 断言 allowlist 语义 | **改 4 个、加 6 个** |
| Bridge 侧文案镜像 | `packages/teamlead/src/bridge/alert-kind-copy.ts:276` 返回 `"Infra Bot TUI window not visible"` | 【实核】该 case 注释明言「never routed through this table…case exists for switch exhaustiveness」,只为 switch 穷尽 | **改一行**为 `"Codex Lead TUI window not visible"`,消掉最后一处身份镜像词汇 |
| lead-alert 壳测试 | `packages/teamlead/scripts/test-tui-window-lost-alert.sh:105-136` | 用「Infra Bot…」「Raya brain…」当**输入**测 `lead-alert.sh` 的 claims 去重与持久化标题 | 不动(测的是 shell 去重,标题只是夹具) |
| 告警 kind 面 | `scripts/lead-alert.sh:200`、`LeadAlertNotifier.ts` 的 union、`kind-contract.ts` | `tui_window_lost` 已在三面 | 不动 |
| launcher | `run-codex-lead-mufasa-tui-fullaccess.sh:35`、`run-codex-infra-bot-tui.sh:49-50`、`run-codex-lead-raya-tui-fullaccess.sh:10` | 三者都已 `export FLYWHEEL_ROOT`(2259 补了 mufasa)⇒ guard 的脚本解析对三位都能成立 | 不动 |
| Bridge 巡逻 | `plugin.ts:9830-9905`、`resident-codex-lead-patrol.ts` | 启动读一次名册;每 20 GatePoller tick 一次;健康不打日志;`recover` 走 `scripts/resident-codex-lead-recover.sh --recover --expected-pid/lstart/generation/carrier-instance` | 不动 |
| 恢复 helper | `scripts/resident-codex-lead-recover.sh` | `--probe` 输出 exact 身份 JSON;`--recover` 前核三方权威 + pid/lstart/argv/CODEX_HOME + generation,先写 `recovery-receipts.jsonl`(`phase:pre_mutation`,`old.pid/lstart`)再 `bounded-run 30 launchctl kickstart -k` exact label | 不动;演练判据引用它的回执格式 |
| guard 壳消费者 | `packages/teamlead/scripts/__tests__/raya-activation-preflight.test.sh:28,74-97` | import 已构建的 `tui-window-alert.js` 直接调 `createTuiWindowAlertGuard`;夹具 `projects.json` 无 opt-in 旗 | **改**:夹具加 `codexResidencyPatrol:true`,node 片段传 `projects`(解析夹具)与 `leadKey: env.FLYWHEEL_LEAD_KEY`,加一格空 roster ⇒ `disabled` 负控(plan T11;Codex R1-1/R3-2) |
| 只读验活 | `packages/teamlead/scripts/verify-windowed-lead.sh <project> <lead>` | 五层 PASS/FAIL,rc = 10+N 指第一坏层;第 6 层日志只诊断 | 不动;收官表第一列的证据来源 |
| Raya 激活 | `engineering/doc/FLY-2259-raya-brain-cutover/activation-runbook.md` §4.0–§4.11 | 已含 Raya 五步、停止线、逆序回滚、§4.10 SIGSTOP 演练 | 不复制;引用 |

## 2. pane 告警名册化的改动面(O1,exploration §3.3)

### 2.1 接口

```ts
export interface CreateTuiWindowAlertGuardOptions {
  stateDir: string;
  leadId: string;
  projectName: string;
  /** NEW — the runtime's stable lead key (`<project>-<lead>`), same as the observer's target match. */
  leadKey: string;
  /** NEW — the already-loaded roster (loadResidentCodexLeadProjectsSafely result; [] when unavailable). */
  projects: ReadonlyArray<ProjectEntry>;
  env: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  exists?: (p: string) => boolean;
  now?: () => number;
  threshold?: number;
  runAlert?: (args: string[]) => void;
}
```

装不装的判定(替换 `:284-287`):

```ts
const target = findResidentCodexLeadTargets(opts.projects).find(
  (c) => c.projectName === opts.projectName && c.leadId === opts.leadId && c.leadKey === opts.leadKey,
);
if (!target) return null;           // not opted in / roster unavailable / key mismatch → byte-compatible no-op
```

三元匹配与 `createResidentCodexLeadLifecycleForGeneration`(`:134-139`)**逐字同形**——两处用同一把尺子,pane 告警与 observer 永远同进同出。

### 2.2 标题

删掉 `:166-168` 的 displayName 分支,统一为:

```
`Codex Lead ${projectName}/${leadId} TUI window not visible`
```

⬜ 理由:身份已在 `--lead/--project` 参数里,标题里再维护一张「好听名字」表就是第二真相源;founder 面的可读性由 `<project>/<lead>` 保证(与 Bridge 巡逻告警标题 `${projectName}/${leadId} resident Codex Lead business-liveness …` 同形)。签名 `tui_window_lost:<startedAt>` 与 claims 去重不含标题 ⇒ 去重语义不变。

### 2.3 ARMED 正证据

现状:guard 装上时**零日志**,只有禁用才打「guard DISABLED」。2259 runbook 用 `! grep 'guard DISABLED'` 当证据——这是「两种状态同一痕迹」(记忆库 feedback_two_states_one_trace):脚本没跑到那一行也是「没有 DISABLED」。加一行:

```
tui-window-alert: silent-no-pane guard ARMED for <project>/<lead> (roster opt-in, threshold=<K>)
```

收官表与 Raya runbook 改为断言这一行**存在**。(不改 2259 runbook 文件;在本单收官表里用 ARMED 行。)

### 2.4 runtime 调用点(`:482`)

```ts
const tuiWindowAlertGuard = createTuiWindowAlertGuard({
  stateDir: config.stateDir,
  leadId: config.leadId,
  projectName: config.projectName,
  leadKey: config.leadKey,
  projects: residentCodexLeadProjects,
  env: process.env,
  log: (m) => logger.warn(m),
});
```

`residentCodexLeadProjects` 在 `:468` 已存在。`config.leadKey` 存在(`:138` 已用)。

### 2.5 测试改动面

| 既有测试(`tui-window-alert.test.ts`) | 处置 |
|---|---|
| `:127` "uses distinct founder-facing titles for InfraBot and Raya" | 改为 "title is derived from project/lead (single source)":两位输出 `Codex Lead flywheel/codex-infra-bot-lead …` / `Codex Lead raya/raya …` |
| `:206` "enables the canonical InfraBot without an env flag" | 改为 "enables an opted-in roster target (full-access tier)":传含 InfraBot 行(`codexResidencyPatrol:true`)的 projects |
| `:217` "enables only the exact canonical Raya identity" | 改为 "enables only the exact roster tuple":同名 lead 在别 project ⇒ null;`leadKey` 不匹配 ⇒ null |
| `:244` "does not enable a non-InfraBot Lead even with the retired env" | 保留,改名 "does not enable a Lead absent from the roster even with the retired env" |
| 其余 14 个(状态机、路径解析、fail-soft、latch 文件) | 不动;但 `createTuiWindowAlertGuard` 的调用都要补 `leadKey`/`projects` 两个字段(夹具函数统一提供) |

新增(负控优先):

1. companion 层 opt-in(mufasa 形状)⇒ 装上(这是本单要修的那个缺口的正例)。
2. `codexResidencyPatrol:false` 或缺省 ⇒ null(**今天的 mufasa 若关旗必须回到无告警**)。
3. `backend !== "codex-app-server"` 但旗为 true ⇒ null(名册规则透传,不在 guard 里复制规则——用 roster 函数的真实现,不 mock)。
4. `projects = []`(名册读失败的 fail-safe 形状)⇒ null,且**不**打 DISABLED 日志(那是脚本解析的语义)——⬜ 打一条 `roster has no opt-in for <project>/<lead>; silent-no-pane guard not armed` debug 级?否:非 opt-in 的普通 TUI Lead 每次出生都会多一行噪音。**不打**。
5. 装上时打 ARMED 行(断言 log 收到含 `ARMED for raya/raya` 的一条)。
6. 变异对照:把 `find` 条件里的 `leadKey` 比较去掉,测试 3 的「同名 lead 别 project」仍红(因为 projectName 也不同)——所以需要一个 **只有 leadKey 不同** 的用例:同 project 同 lead 但传入的 `leadKey` 是别的串 ⇒ null。这条专门保护第三元。

【实核】名册函数已有独立测试(`resident-codex-lead-roster.test.ts` 2 个 it:枚举两位 opt-in 不激活未 opt-in、无 Raya 专有符号),本单不重复测名册规则。

### 2.6 安全核查

- `projectName`/`agentId` 经 `ProjectConfig` 校验为 `SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`(`ProjectConfig.ts:432,627`)⇒ 进标题的两个串无空白、无 shell 元字符;且 `runAlert` 走 `execFile('/bin/bash',[script,...args])` 数组参数,不经 shell。
- `lead-alert.sh:410` 再次核 lead 在 projects.json 内,不在 ⇒ 丢弃并记日志。
- guard 不读 stdin、不写名册;唯一写点仍是 latch 文件(0600,同目录 rename)。

### 2.7 部署与生效时点

- 改动只在 runtime(`packages/teamlead/dist/...`),随班车部署;**已在跑的两位 Lead 进程用旧字节**,下一次出生(KeepAlive 拉起、班车重启或本单演练的 kickstart)才装新 guard。⇒ 收官表「pane 告警 ARMED」一格必须取**演练之后**那一代的日志行。
- Raya 未出生 ⇒ 她第一次出生就是新字节(前提:本单先于 2259 窗口 land;若后于,则 Raya 靠旧 allowlist 出生,班车 N+1 后才换成名册,收官表如实写)。

### 2.8 回滚

revert 本 PR ⇒ 回到两身份 allowlist;名册旗、plist、巡逻、observer 全不受影响(它们不依赖 guard)。零数据迁移:latch 文件格式不变。

## 3. InfraBot 打架面(exploration §1.3 的收口)

【实核 2026-09-05】两位 `lifecycle.jsonl` 各 28.6 万行、3 天,事件分布(InfraBot):`gateway_poll_attempt` 142599、`gateway_poll_ok` 142589、`gateway_poll_failed` 9、`message_consumed` 1078、`generation_lost` 15、`online` 16、**`turn_started/turn_completed/turn_failed` = 0**。mufasa 同形(`generation_lost` 16、turn 0)。

读码:`CodexTurnExecutor.ts:163,238,250` 在 `runTurn` 里调 `lifecycle.turnStarted/turnFinished`,runtime `:648` 把 observer 注入 executor。1078 条消费、0 条 turn ⇒ 这两位的 turn 没走过 executor 的 observe 路径(⬜ 推测:TUI 载体把消息投给 `codex remote-control` 侧的会话,executor 的 turn 计数不经这里)。**后果**:`heartbeat.activeTurn` 恒 null ⇒ `turn_stalled` 分类在生产从未可能触发 ⇒ exploration 担心的「30 分钟长救援被判假死」**今天不可能发生**;同时 `turn_stalled` 检测本身是死的——这是 FLY-2216 机制的一个真实缺口,**不在本单范围**,plan 里作为另立单项。

结论:InfraBot 纳入(I1)与巡逻现有的两条真实触发(`poll_loop_stalled` 120s、`heartbeat_stalled` 180s)都只看 gateway 轮询与心跳写,与 InfraBot 正在做什么救援无关;唯一交集是 ENOSPC 之类让心跳写失败的机器级故障(exploration §1.6),那时 kickstart 一个健康进程是可接受的(KeepAlive 30s 内回来,损失一次 turn)。

## 4. 真机演练合同(两位存量 Lead 各一次;Raya 走 2259 §4.10)

参数化自 2259 §4.10(逐字语义,只把 `raya/raya/RAYA_LABEL` 换成变量):

```
PROJECT, LEAD, LABEL=com.flywheel.lead.<PROJECT>-<LEAD>, HB=~/.flywheel/state/codex-lead/<LEAD>/brain/heartbeat.json
```

判据(全部谓词;**成功 = D0–D5 全过且 D6 未进入**;任一失败即失败,不许 `&&` 裸链):

| # | 谓词 | 证据文件 |
|---|---|---|
| D0 | 开窗停止线:`df /` 使用率 < 80%;claims.db 近 24h 该 lead `crash_loop` = 0;Bridge `/health ok`;`patrol-observed-generation.json` 的 pid/lstart = `--probe` 的 pid/lstart;heartbeat `state:online` 且 updatedAt 距今 < 60s;两个 Codex Lead 之外的 Lead 不动。**强停前先写下**(铁律 ①):目标 label `com.flywheel.lead.<PROJECT>-<LEAD>`、pid、T0 时间、预期自愈路径 = **Bridge residency 巡逻 → `resident-codex-lead-recover.sh --recover` → 有界 `launchctl kickstart -k`**(不是 launchd KeepAlive:SIGSTOP 后进程仍在,KeepAlive 不会动;不是 cmux watcher;不是 R3 rescue) | `T0-probe.json`、`T0-heartbeat.json`、`df.txt`、`pre-stop.md` |
| D1 | `kill -STOP <pid>` 后 **≤ 10 分钟**内(铁律 ②)达到**完整收敛元组**——四项同时成立才算「已自愈」:① `--probe` 返回 exact 身份且 pid 或 lstart ≠ T0;② heartbeat `processPid == 新 pid` 且 `state:online`;③ `generationId` 与 `carrierInstanceId` 都 ≠ T0;④ `recovery-receipts.jsonl` 新增 `phase:"pre_mutation"` 行且 `old.pid/old.lstart == T0`(即 D2+D3 并入 10 分钟线,只换 pid 不算收敛)。期间**每分钟**追加一行 `minute-log.txt`(时刻 · probe pid/lstart/state · heartbeat updatedAt/state · `/health` ok · 本 lead 的 claims 计数) | `new-probe.json`、`minute-log.txt` |
| D2 | 新 heartbeat `processPid == 新 pid`、`state:online`、`generationId != T0`、`carrierInstanceId != T0` | `new-heartbeat.json` |
| D3 | `recovery-receipts.jsonl` 新增行含 `phase:"pre_mutation"` ∧ `old.pid == T0_pid` ∧ `old.lstart == T0_lstart` ∧ `at >= T0_at` | `new-receipts.jsonl` |
| D4 | #flywheel-alerts 出现 `codex_lead_residency_stalled`,标题含 `<PROJECT>/<LEAD>`,两条(detected、recovery=converged),时间戳 ≥ T0_at。claims.db 判据**按 target 与 phase 绑定**(Bridge 把这类 claim 写在 fleet lead id `codex-lead-residency` 下,target/phase 在 `event_id` 里:`codex_lead_residency_stalled:<leadKey>:<phase>:<episode>`):强停**前**对 `event_id GLOB 'codex_lead_residency_stalled:<leadKey>:detected:*'` 与 `…:recovery:*` 各拍一次计数(用 GLOB 不用 LIKE:LIKE 会把 `_` 当单字符通配,Codex R3-1;并保留 `event_type`/`lead_id` 精确过滤);收敛后各**恰好 +1**;两条 URL 分别绑到这两个 phase。别的 Lead 同时发的 residency 告警不计入 | `alert.detected.url`、`alert.recovery.url`、`claims.before/after` |
| D5 | pane:`verify-windowed-lead.sh <PROJECT> <LEAD>` 五层 PASS(演练后);Lead 日志新一代含 `tui-window: real TUI up (<PROJECT>-<LEAD>` 与(部署本单后)`guard ARMED for <PROJECT>/<LEAD>` | `verify.log`、`pane.log` |
| D6 | **失败分支,成功路径不进入**(铁律 ②):10 分钟到点 D1 元组仍不完整——无论快照形状是「pid 仍 = T0」「pid 已换但 heartbeat 未 online / 代号未换 / 无回执」还是「probe uncertain」——先按 exact 身份复核一次(`--probe` + heartbeat),仍不完整 ⇒ **立即 `launchctl kickstart -k gui/$(id -u)/<label>`**(该 Lead 自己的 launchd job,不手搓其它机制;`-k` 对 SIGSTOP 的进程同样生效)⇒ 60 s 内 probe 出 exact 新 pid 且 heartbeat `online`(服务已恢复,这是可用性兜底不是收敛证据)⇒ 记 **FAIL** ⇒ **停止后续所有强停**(第二位不再做)⇒ ask Lead。若兜底后 60 s 仍不 online:再 ask Lead,不再动手 | `drill-failed.txt` |

预期时序(默认阈值):SIGSTOP 后心跳停 → 180s 判 `heartbeat_stalled` → 连败 3 次(每次 20 tick)→ helper 核身份 → kickstart → 新代 online。deadline 按 Lead 铁律 ② 取 **10 分钟**(2259 §4.10 的 12 分钟对 Raya 仍由 2259 自己管;本单两位一律 10 分钟)。【实核】生产 GatePoller `pollIntervalMs = 3000`(`plugin.ts:9871`,bridge.log `[GatePoller] Started (interval: 3000ms)`)⇒ 巡逻每 20 tick = **60 s** 一次。最坏推算:心跳过期 180 s + 最多一个巡逻周期 60 s + 连败再两次 120 s + helper 核身份与 kickstart(有界 30 s)+ 新代出生到 heartbeat online(≤ 60 s)≈ **7.5 分钟 < 10 分钟**,余量 2.5 分钟;实现节点在 `cutover-status.md` 初版里把这段推算连同当日实核的 interval 再抄一遍,若开窗当日实核值变大到推算 > 10 分钟,先 ask Lead 再开窗。

⛔ 顺序:两位**串行**,一位收敛并 `verify-windowed-lead` 全绿后再做下一位;先 mufasa(companion,影响面小)后 InfraBot;任一位 FAIL 即停(铁律 ②)。授权范围(铁律 ③):只这两个 Lead、只演练所需次数;不动 Bridge、任何 runner、任何 plist。演练期间 InfraBot 不在岗 ≈ 1–5 分钟,#flywheel-alerts 工单无人认领——Lead 知情。

## 5. 权限与红线

- 本节点(design)与实现节点都**不**执行 §4;执行者 = Lead 在 founder 在场窗口。
- ⛔ `claude-infra-bot-lead`(Claw)零触碰。
- 不改巡逻阈值、不改 helper、不改 wrapper/plist、不动 `com.xrli.raya.brain`。
- 名册文件 `~/.flywheel/projects.json` 本单**不改**(两位已 opt-in;Raya 由 2259 registrar 改)。

## 6. 收官状态卡的字段(founder-design.html 与 ask 给 Lead 的事实包同源)

每位 Lead 一行:`opt-in 时间` · `plist/manifest 在` · `observer 活(heartbeat 时间)` · `巡逻观察本代(observedAt)` · `pane 五层(verify rc)` · `假死演练(T0_at → 收敛时刻,receipt 行号)` · `真告警 URL(detected/recovery)` · `pane 告警 ARMED 行(出生时间)` · `证据目录`。当前值:三位全部「演练 = 未做」「告警 URL = 无」,mufasa「ARMED = 不可能(未名册化)」,Raya 整行「未出生」。

## 7. 顺带发现(不在本单,建议另立单)

1. `brain/lifecycle.jsonl` 无界增长,约 20 MB/天/Lead,未登记 retention(§exploration 1.6)。
2. TUI 载体下 `turn_started/finished` 从未写入 ⇒ `turn_stalled` 死代码 + `activeTurn` 永 null(§3)。
3. `infra_bot_down` 传感器在生产未配置 `FLYWHEEL_CODEX_INFRA_BOT_JOB`(exploration §1.3)——是否有意,归 Lead。

## 8. Codex 设计评审残留(3 轮,R3 APPROVED;plan 已绑定不再改)

- R3-1(LOW):claims.db 的 target/phase 谓词一律用 `GLOB 'codex_lead_residency_stalled:<leadKey>:detected:*'`(plan §2.4 overlay 文字仍写着 LIKE,实现节点写 `cutover-status.md` 与演练命令时按本条用 GLOB 或转义 `_`)。
- R3-2(LOW):本文 §1 已补 `raya-activation-preflight.test.sh` 一行。
