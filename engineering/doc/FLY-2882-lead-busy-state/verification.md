# FLY-2882 Lead 忙闲只读接口 — 实现验证记录
Issue: FLY-2882 (https://linear.app/geoforge3d/issue/FLY-2882/语音耳机bridge-某个-lead-现在在忙什么只读接口在不在一轮活里在做哪张单已经多久claudecodex-两种载体)
日期: 2026-09-25
基于: plan.md

本文件只记实现节点**本机实际跑过**的东西。没有请求 full CI、没有派 QA、没有进 529 房、没有合并或部署。

## 0. 设计修正

实现期间,设计节点按 manifest 指定的 gpt-6-astra 补审了 plan v3,3 条 blocking + 2 条 advisory 由 Lead 核实后下发;修正层见 `design-correction.md`(C1 原始生命周期接缝、C2 Claude 子进程活体证据、C3 实时事件校验、A1 截止时间、A2 分钟精度),已全部实现。下表第 5、6 行是修正前的做法,已被 C1/C3 取代,保留在这里是为了说明演变。

## 1. 与 plan v3 的偏差(均为加性,评审时逐条交给 Codex 判)

| # | 偏差 | 原因 |
|---|---|---|
| 1 | 新增 unknown 原因 `read_failed` | 读取器意外抛错时需要一个真实原因;plan 的原因表里没有能如实描述「意外错误」的项。只影响那一个 Lead。 |
| 2 | sidecar binding 新增 `{status:"unavailable"}` → 触发原因 `attribution_unavailable` | sidecar 内读 journal 抛错时,如果报 `pending` 会被说成「刚开始还没绑定」,不真实。 |
| 3 | `trigger.undetermined` 带固定中文 `detail`(「判断不了:…」) | 满足 issue QA 判据 2「给不了必须明写判断不了」。文案是常量表,不拼接任何运行时内容。 |
| 4 | `readLatestTurn` 接受 Codex `Turn` 上的额外字段,但只拷出 `id/status/startedAt`;进行中却没有 `startedAt` 视为 seed 失败 | 读 `~/Dev/codex-oss` 的 `app-server-protocol/src/protocol/v2/thread_data.rs`:`Turn` 带 `items/itemsView/error/completedAt/durationMs`,`startedAt` 是 `Option<i64>`。严格拒绝额外字段会让生产 seed 永远失败。 |
| 5 | ~~完成事件在 demux 之前也喂给 tracker~~ → **C1**:start 与完成都在原始 `notification` 接缝观察(`demux.route` 之前,只吃一次),demux 只经 `setOrigin` 补来源;`TurnDemux.toObserver` 新增 `provenance`,abort/溢出 flush 与认领失败保持 `unknown` | astra #1:扣住的 start 会在 `turn/start` 未返回时读成 idle,tombstone 会让 busy 卡住。 |
| 6 | ~~只按 threadId 过滤~~ → **C3**:绑定线程上 start 必须 `inProgress`、完成必须终态、必须有合法 turnId 与 threadId;畸形事件作废信任并经 `onTrustLost` 重新 seed | astra #3 / Codex 代码评审 R1。 |
| 8 | Claude 读取在截屏前后各查一次 Claude 子进程 pid(`readV2LeadClaudePid`,只读 pid/ppid/内核名),同一个活进程才解析;新原因 `lead_process_not_running` / `lead_process_unverified` | **C2**(astra #2):外壳 bash 还在、Claude 已退出时旧画面会读成 idle。 |
| 9 | 单 Lead 8 s 截止 → `read_timed_out`;fleet 并发 6;CLI `--all` 45 s | **A1**。 |
| 10 | ≥1 天的时长(分钟被截断、无秒位)按区间中点 +30 s | **A2**:读 2.1.282 二进制 `en()` 源码,天/时/分 `Math.floor`、秒 `Math.round`。 |
| 11 | 载体按 `effectiveLeadBackend(lead.backend, FLYWHEEL_LEAD_BACKEND)` 判定(与投递适配器一致);显式非法值仍 `carrier_unsupported`;Codex 认证密钥同投递适配器的回退顺序(`botToken`/`botTokenEnv` → `DISCORD_BOT_TOKEN`) | Codex 代码评审 R1 第 3 条。 |
| 7 | 既有 rotation 测试原先把「出现过 `thread/turns/list`」当作「rotation 做过探测」;现在改为用 spy 扣除 seed 读次数后再断言 0,不是放宽 | 每个 generation 新增一次 seed 读(同名 RPC)。「consumes pending…」用例的精确序列末尾多了一条 seed 读,并断言它读的是新线程。 |

## 2. 只读冒烟(本分支代码 × 本机生产 Claude Lead)

2026-09-25,用 tsx 直接跑本分支的 `readClaudeLeadActivity`(真 `locateConfiguredLeadWindow` + 真 `defaultLeadPaneCapture`,150 行只在内存里解析),只打印 `leadId / state / reason`:

- 14 个 Claude Lead:13 `idle`,1 `unknown / no_turn_status_line`(`tidal-echo-cos-lead`)。
- 与设计期同形态实测(12 idle / 1 busy / 1 无状态行)一致:都能定位到带 `@leadId` 的输入框,没有一个落到 `pane_unrecognized`。
- 3 个 Codex Lead 没测:生产 sidecar 还是旧代码,没有 `turn_state_v1`,接口会如实答 `sidecar_lacks_turn_state`;runner 环境也没有它们的 bot token。
- C2 落地后重跑一次(同时做截屏前后的 Claude 子进程检查):结果同上,14 个 Claude 子进程全部识别为 `running`(生产进程名为版本号 `2.1.282`,是 pane 里 `bash lead-body.sh` 的直接子进程),没有误报 `lead_process_*`。

没有向任何 pane 输入,没有落盘任何画面文字。

**没做到的**:想在隔离 tmux 里用一个改名的 `sleep` 当 "claude"、杀掉它来真机验证 `absent` 分支,这条命令(含 `pkill` / `kill-server` / `rm -rf`)被权限拒绝,我没有绕开。`absent` / `indeterminate` 分支由按生产进程表形态构造的单测覆盖;「Claude 已退、外壳和旧画面还在」的真机验证留给 QA 判据 3。

## 3. 定向测试(规则:无本地全量)

统一环境:`TMPDIR=/tmp/f2882t`(runner 的 TMPDIR 89 字符,真 unix socket 用例会超 104 字节上限)、`FLYWHEEL_CODEX_HOMES_ROOT` / `FLYWHEEL_CODEX_SESSION_DIR` 指向一次性临时目录(防止调 `startBridge` 的测试清掉生产 Codex lease)、`--exclude "**/tmux-viewer.macos.test.ts"`、每批 ≤ 6 个文件。判据三条同时满足:进程退出码 0、无 Unhandled、Test Files / Tests 条数与预期一致。

**在头 `d9f1352b3`(设计修正全部落地后)跑:**

| 范围 | 文件 | 用例 | 结果 |
|---|---|---|---|
| teamlead 保留集合(§4) | 212(36 批) | 2916 | 全部 exit 0、unhandled 0 |
| flywheel-comm 保留集合 | 16(3 批) | 318 | 全绿 |
| config 扫描类守卫 | 5 | 124 | 全绿 |
| 脚本测试 `.sh` | 5 | — | 4 过;`audit-discord-mailbox-ingest.test.sh` 失败,见下 |
| 脚本测试 `.mjs`(`node --test`) | 26 | 全部 `fail 0` | 全绿 |

`audit-discord-mailbox-ingest.test.sh` 的失败与本单无关:它断言 `chat-ingest --version-probe` 输出 `"protocolVersion":2`,而 `origin/main` 的 `flywheel-comm/src/index.ts:874` 自 FLY-2446(#1140)起就输出 `3`;该测试最后一次修改在 FLY-2443(#1125)。本分支对 `index.ts` 只新增了 `lead-activity` 的 import / 帮助文本 / 分派三处。

**Codex 代码评审 R2 的修复(`3f1630aae`,只动 `CodexLeadInboxSocket.readCodexLeadTurnState` + 新错误类、`readLatestTurn`、`codex-lead-activity` 的 catch 分支)之后,在新头重跑:** 这三个文件解析出的全部直接依赖 + 路由测试共 18 个文件、401 条用例,全绿。

**构建 / 类型 / lint(在 `3f1630aae`):** `pnpm --filter "flywheel-teamlead..." --filter "flywheel-comm..." build` exit 0;`pnpm --filter "...flywheel-teamlead" --filter "...flywheel-comm" typecheck` exit 0(8 个项目,0 个 `error TS`;`voice-codex` 需要先 `pnpm --filter "flywheel-voice-codex^..." build` 生成 `flywheel-voice-bridge` 的 dist,否则报找不到模块——与本单无关的本地构建顺序问题);`pnpm lint` exit 0(0 error,25 条既有 warning)。

**变异验证:**
- 解析器:把「可跳过行」放宽为「任何不认识的行都跳过」→ 4 条 fail-closed 用例变红;已还原。
- Codex 原始接缝:删掉 `wireDemuxedProcess` 里的 `turnState.observeLifecycle(method, params)` → 7 条用例变红;已还原。

## 4. 消费者扫描(git grep:完整路径 / 文件名 / 父目录)

对 19 个改动的非测试源文件(设计修正后新增 `LeadWindowLocator.ts`、`TurnDemux.ts`),各用 5 个模式 `git grep -lF`:完整路径、包内相对路径、`<stem>.js`、`<stem>.ts`、父目录(去掉 `packages/<pkg>/`)。排除 `engineering/doc`、`product/doc`、`doc`、`*.md`。命中的测试文件(`__tests__/` 或 `*.test.{ts,mjs,sh}`)共 **1041 个**;另外把每个测试文件的相对 import 真正解析到文件,得到精确的「直接依赖」集合(`direct-deps.mjs`,见 §3)。

**保留(264 个,全部跑过,结果见 §3):**

- 解析后直接 import 了改动模块的测试:`CodexLeadInboxSocket` 14、`LeadJournal` 16、`SqliteJournalStore` 28、`codex-lead-thread-rotation` 3、`codex-lead-tui-runtime` 9、`LeadTurnStateTracker` 4、`bridge/plugin.ts` 83(全部;新增的模块级 import 若引入循环依赖,任何 import plugin 的测试都会炸)、`lead-activity/*` 与路由、flywheel-comm `commands/lead-activity.ts` 各自的测试。
- 按文件文本扫描改动文件的守卫:扫 `plugin.ts` 的 35 个 teamlead 测试 + 4 个 config 测试 + 4 个脚本测试;扫 `StateStore.ts` 的 12 个 teamlead/config 测试 + 12 个 `qa-fly-2456-*.test.mjs` + `fly2403`、`fly1674` 两个脚本;读 flywheel-comm `src/index.ts` 的 6 个 flywheel-comm 测试 + `audit-discord-mailbox-ingest.test.sh` + `qa-codex-lead-parity.test.mjs`。
- 与 `getLeadEventBySeq`(新 getter 的邻居)有关的 3 个测试。
- 遍历源码目录的清册类守卫 27 个(`bridge-child-process-census`、`automated-message-inventory`、`fly1560-teardown-guard`、`db-open-hardening` …),新文件都落在它们扫描的目录里。
- 下面 E 类里 8 个 teamlead TS 测试,判断成本高于运行成本,直接跑了。
- `LeadWindowLocator.ts` 的直接依赖(`LeadWindowLocator.test.ts`、`lead-v2-io.test.ts`、Claude 读取器测试)与按路径引用它的 `fly1680-v1-extinction.test.sh`;`TurnDemux.ts` 的直接依赖 `TurnDemux.test.ts`。

**排除(801 个),按原因:**

| 类别 | 数量 | 原因 |
|---|---|---|
| A 只因 import `StateStore` 命中 | 399 | 解析后确实 import 了 `StateStore.ts`,但本单对它只加了一个只读方法 `getLeadEventSessionKeyBySeq`;没有改任何既有方法、schema、迁移。这 399 个测试用的是其它 API。 |
| A2 提到 `StateStore` 路径但不读本文件 | 3 | 夹具里写假的 `StateStore.ts`(如 `auto-narrow-rollback-precheck.test.sh` 往临时目录写 `// old projector`)。 |
| B 同名碰撞 | 124 | 命中的是别的 `types.js` / `index.js` / `index.ts`(各包自己的模块或夹具字符串),import 解析结果不是本单文件。 |
| C 只有父目录字符串 | 180 | 只因提到 `src/bridge/`、`src/lead-backends/codex/`、`src/commands/`、`src/` 下**其它**文件的路径。遍历目录的守卫已单列并保留。 |
| D 只由 A/B/C 组合命中 | 73 | 同上理由的组合。 |
| E 其它 | 30 − 8 已跑 = 22 | 逐个看过:`packages/teamlead/scripts/__tests__/*.sh`、`scripts/__tests__/*lead*.sh` 等 14 个 launcher/部署脚本测试只把 `dist/lead-backends/codex/codex-lead-tui-runtime.js` 或 `flywheel-comm/dist/index.js` 当**进程入口路径字符串**用 —— 入口路径、argv、env、既有 CLI 命令都没变;`run-bridge-isolation-boot`、`packaged-seams` 用的是**桩** `plugin.js`;`discord-plugin-ops`、`skill-framework-variants` 命中的是 `plugin.json`;`agent-team-transport` 与 `claude-runner` 的两个测试、`gemini-agent` 的 mock-bridge 夹具、`config` 的 `drift-scan/index.ts` 辅助模块都是同名/字符串碰撞。 |

`vitest related`:本单每个 teamlead 改动模块都会经 `bridge/plugin.ts` 或 `StateStore.ts`(这两个是被 83 / 529 个测试直接 import 的枢纽)被传递依赖,`vitest related` 等价于整包全量,违反「无本地全量」;按项目既有做法改用上面的解析 import + git grep 集合。flywheel-comm 的 `commands/lead-activity.ts` 只被 `index.ts` 与自己的测试引用,其解析依赖集合就是它自己的测试(已跑)。

## 5. 代码评审

用 `codex:rescue`(companion,xhigh),只读评审,不改文件:

| 轮次 | 模型 | 头 | 结论 | 处置 |
|---|---|---|---|---|
| R1 | companion 默认(gpt-5.6-sol) | `66f266dce` 之后的分支 | CHANGES REQUESTED,3 × MEDIUM | 前两条与 astra 设计补审 #1/#3 重合,按 C1/C3 修;第三条(载体没走 `effectiveLeadBackend` + legacy)按投递适配器同款修复 |
| R2 | gpt-6-astra(与设计门 manifest 同一模型) | `d9f1352b3` | CHANGES REQUESTED,2 × MEDIUM | `readCodexLeadTurnState` 回包封装严格化(`CodexLeadInboxProtocolError` → `sidecar_protocol_invalid`);`readLatestTurn` 拒绝任何带 `error` 的 JSON-RPC 回包 |
| R3 | gpt-6-astra | `3f1630aae` | **APPROVED**,无 findings | — |

R1 用的是 companion 默认模型,这里如实披露;R2 起改用设计门 manifest 指定的 gpt-6-astra 并从头全量评审。

**有意没改(建议另开单)**:`codex-lead-thread-rotation.ts` 既有的 `boundedTurnsList()`(rotation 围栏,不属于本功能)同样没有拒绝「`error` 与 `result` 并存」的回包;本单按 plan 保持它行为不变。

## 6. QA 返工(implement attempt 2)

QA(exec `df988ce0`)在头 `2acf312c4` 判 FAIL。与本单代码有关的只有一条:exact-head CI `36194820697` 的 Quick Gate 最后一步「Enforce FLY-2006 retention consumer gate」报 `unclassified_retention_consumer:packages/teamlead/src/bridge/lead-activity/turn-trigger-attribution.ts:mailbox:read`。

- **原因**:`mailbox` 是 FLY-2006 保留窗清扫(有效窗口 14 天;目录名里的 30-day 是历史命名)的目标表;任何生产源码里 `FROM/JOIN` 目标表的读者都必须在 `scripts/fly-2006-retention-consumer-gate.config.json` 里按 `file + relation + baseTable + usage` 登记处置。这本清册是**扫全部生产源码的 CI 脚本**,不是依赖改动文件的测试,所以 §4 按「谁引用了我的文件」做的消费者扫描找不到它——漏检的是我。
- **修复**(`5c33ef82a`):登记为 `candidate_guarded`(与其它普通 `mailbox` 读者一致)。依据:归因读者能容忍行被清扫——成员行缺失只会答 `unmapped_delivery`(「判断不了」),既不会给出单号,也不会影响 busy/idle;它不把「行不存在」当作任何权威。
- **本地验证**:`node scripts/fly-2006-retention-consumer-gate.mjs` → `ok:true`、0 error;`node --test scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs` 10/0;biome 干净。该守卫就是 Quick Gate 的最后一步,前面 25 步在 exact-head CI 上已全部通过;同一次 CI 的其它 unit / script 分片也都通过。
- **Script Tests 5/6 E 的红(Lead 要求核实)**:`scripts/__tests__/qa-fly-1986-load-probe.test.sh` 一条断言在 exact-head CI `36194820697` 失败:「an all-401 block was certified as 'incomplete_expected=3'」。核实结论:**不是本单引起,也不是 main 上稳定复现的既有失败;表现为间歇性失败,确切根因未证实**。
  - 同一分片在 main `9e3ba1175`(run `36195488444`)、main `ef47e9a05`(run `36188390006`)、FLY-2830 `ce128505c`(run `36192986884`)上都是 success。
  - 失败的头 `2acf312c4` 相对 main 的 diff 完全没有碰 `scripts/`;该测试只驱动 `scripts/qa-fly-1986-load-probe.sh` 去打本地 python mock 的 `/health` 与 `/api/sessions`,不经过本单任何代码。
  - 直接触发点:探针的汇总在样本数与期望值**不相等**时(`n != expected`,见 `scripts/qa-fly-1986-load-probe.sh` 汇总段)先判 `incomplete_expected=3` 并退出,不再走「全 401 拒绝认证」那条判定;该用例的 9 秒区块期望恰好 3 个样本,所以这次 CI 里样本数不是 3(多或少都会这样)。同一用例里「401 被归类为 invalid_auth」的断言是通过的。为什么这次样本数不是 3,没有直接证据;调度 / 负载导致的时序差异只是推测,未证实。
  - 本地在本分支头上跑 `passed=62 failed=0`。
  - 修它属于 FLY-1986 的测试,不在本单范围;按规矩也不自行重跑 CI,交 Lead 裁定。
- 529 房没进成(slot 2 launchd bootstrap I/O error)与 QA 机制问题属 QA 侧,本节点不处理。

### 生产只读探测「17 个 Lead 全部 unknown」是预期还是缺陷(Lead 要求核实)

QA 的生产只读探测列出了全部 17 个 Lead,全部 fail-closed 答 unknown。结论:**预期行为,不是缺陷**——QA 是沙箱里的 Codex 体,连不上各 Lead 私有的 tmux socket、也没有 Codex Lead 的 bot token,读取器按设计全部答 unknown 并给出原因,没有一个被误答成 idle。

对照:同一天从非沙箱的 Claude runner 用**生产装配工厂** `createProductionLeadActivityService` 只读跑一次 `readFleet()`(只打印 leadId / 载体 / 状态 / 原因):

- 17 个 Lead,fleet DTO 通过严格校验,耗时 2.8 s。
- 14 个 Claude Lead:11 `idle`,2 `busy`(`flywheel-cos-lead` 14 s、`flywheel-eng-lead` 58 s,trigger 为 `causality_unproven`),1 `unknown / no_turn_status_line`(`tidal-echo-cos-lead`,与之前两次冒烟一致)。
- 3 个 Codex Lead:`unknown / sidecar_unreachable`。原因是这三个 Lead 的 bot token 都经 `MUFASA_BOT_TOKEN` / `CODEX_INFRA_BOT_TOKEN` / `RAYA_BOT_TOKEN` 注入,runner 环境里没有这些变量(也没有 `DISCORD_BOT_TOKEN`),读取器在碰 socket 之前就因认证不可用答 unknown。Bridge 进程里有这些变量,会真正连上 sidecar;在 sidecar 进程重启到本分支代码之前,答案会是 `sidecar_lacks_turn_state`。

没有向任何 pane 输入,没有落盘画面文字;Codex sidecar 这次没有被连接。

## 7. QA 返工(implement attempt 3,QA attempt 2 FAIL)

QA attempt 2(头 `fb3b3db53`)判 FAIL 的两条,Lead 查实后下发返工:

1. **Claude 载体在 529 房里按构造恒为 `unknown / lead_window_unavailable`**:定位器只读生产 launchd 权威(`~/Library/LaunchAgents/com.flywheel.lead.<key>.plist` + `<stateDir>/manifests/<key>.json`),而 529 房的 Claude Lead 登记在房自己的 `launchd-leads.json`。
2. **Codex 长回合证据缺失**:没有能稳定造出 ≥60 秒回合的夹具。

### 7.1 改了什么(`753732e68`,评审修复 `7576d2f33`、`add4cdc12`、`e6dc0b8d1`、`d908a2296`、`efe8e61c6`)

- **定位器按「本 Bridge 自己的 launchd 权威」找 Lead**(`bridge/fleet-lead-locator.ts`):新增可选 `launchdRegistryPath`。
  - **未设置(生产)**:行为逐字不变——只读 LaunchAgents plist + `manifests/<key>.json`,缺 plist / 非 v2 / 身份不符一律不可见。
  - **设置了(529 房)**:它是**唯一**权威,绝不回落到生产 LaunchAgents。链路逐跳交叉核验:注册表里**恰好一行**标签为 `com.flywheel.qa.lead.slot-<n>.<leadId>`、且不是 Codex 行(带 `carrier` 即拒);plist / manifest / Lead 自己的 state dir 必须是规范绝对路径且位于注册表所在目录之内;plist 用严格的结构化解析器读取(固定开头;只认 dict/key/string/array/integer/true/false;键名必须按字面写、不许实体编码;任何层级重复键即拒;没有注释、属性或尾随内容),`Label` 等于该行标签,`ProgramArguments` 恰为 `[绝对路径的 …/flywheel-lead-wrapper-v2.sh, 该行的 manifest]`,`FLYWHEEL_STATE_DIR` 只从 `EnvironmentVariables` 里取;之后原样交给 `locateLeadWindow`(manifest 的 projectName/leadId 身份 + 由 Lead 自己 state dir 推出的规范 socket + pane 探针)。
- **显式配置,不猜路径**:`scripts/lib/qa-slot-env-contract.json` 新增 redirect `FLYWHEEL_LEAD_LAUNCHD_REGISTRY=${SLOT_DIR}/launchd-leads.json`(boot `mustBeUnderRootIfSet`:设了就必须在房根之内;缺席只意味着回到生产读法,而生产 plist 里没有 `test-slot-*` 项目,照样答 unknown)。`qa-slot-env-contract.test.sh` 断言渲染结果,并锁住它与 `test-deploy.sh` 的 `QA_LEAD_REGISTRY` 是同一路径。
- **只接到 lead-activity**:`lead-activity-service.ts` 的 `claudeLeadLocatorOptions(env, stateDir)` 读该变量(空白 = 未设置)。`plugin.ts` 里另一个定位器消费者(`locateFleetLeadWindow`)**有意不改**——超出本单范围。
- **≥60 秒回合夹具** `scripts/qa-lead-activity-long-turn.mjs`(两种载体通用):经插件同款 `chat-ingest` 通道给房里的 Lead 发一条消息,请它前台跑一条 `sleep <hold>`(默认 75 秒);前后与期间轮询 `GET /api/lead-activity`,并采满整段 hold(不在第一次 idle 就停)。真实开始时间取 mailbox 行的 `notified_at`——对 Lead 收件人,Bridge 投递循环在载体接收这批时写它(`delivered_at` 要到 ACK 才写);取不到即「不确定」。**按夹具自己的时钟判,不信接口自报的时长**:夹具这轮 = 在真实开始**之后**读到、报告开始时间落在真实开始 ±30 秒内、且与这轮第一个这样的应答开始时间相差 ≤5 秒(同一轮只有一个开始时间)的 busy 应答——投递前读到的 busy 永远不算这轮;检查窗口从「真实开始 + 15 秒」一直到这轮最后一个 busy **之后的第一个 idle**(没有 idle 收尾就到采样结束),窗口里每个应答都必须是这轮的 busy(出现 idle / unknown / HTTP 错误 / 别的开始时间即 FAIL,包括之后又被这轮 busy 推翻的 idle);夹具自己看到的**不间断** busy 跨度(以这轮最后一个 busy 结尾、中间没有任何别的应答的那一段,首末采样之差)≥60 秒——「投递到开始」的等待、以及被打断之前的 busy 都不计入;在要求的 hold 结束前读到 idle 一律不算通过;前后都要读到 idle;由聊天引起的回合必须是「判断不了」(给出单号即 FAIL)。退出码:0 通过 / 1 接口与夹具不一致(FAIL 证据)/ 2 环境或用法错误 / 3 不确定(Lead 没照做、始终没回到 idle、或投递时间证不出——**不算通过**)。基线读不出 idle 时先发一条不用工具的热身消息。chat-ingest 子进程环境恰为 `PATH/HOME/BRIDGE_URL/PROJECT_NAME/TEAMLEAD_API_TOKEN`(房内值),HOME 是一次性空目录——门铃在 401/403 时会回退读 `$HOME/.flywheel/.env`,给真 HOME 就会把生产 token 发给房里的 Bridge。CommDB 路径必须规范化且在房内。证据只含状态 / 时间 / 来源 / 原因字段,不含消息或画面正文。已列入 `ci.yml` 的 `node --test` 枚举。

QA 用法(房须带 API token 文件,即 `--generalized` 或 `TEST_REPLY_BY_ISSUE=1`):
`node scripts/qa-lead-activity-long-turn.mjs --slot <n> --agent <leadId> [--hold-seconds 75] --out /abs/evidence.json`,两种载体各跑一次。

### 7.2 本机验证(只跑与改动直接相关的)

统一环境同 §3(`TMPDIR=/tmp/f2882t`、隔离的 `FLYWHEEL_CODEX_HOMES_ROOT` / `FLYWHEEL_CODEX_SESSION_DIR`、排除 `tmux-viewer.macos.test.ts`)。判据:退出码 0、无 Unhandled、条数与预期一致。

| 范围 | 结果 |
|---|---|
| teamlead(`753732e68`):`fleet-lead-locator`(25)、`lead-activity-service`(12)、`claude-lead-activity`、`lead-activity-route`、`bridge-child-process-census`、`fly-889-ci-workflow-timeout-guard` | 6 文件 / 70 条,exit 0 |
| teamlead(`7576d2f33` 评审修复后):`fleet-lead-locator`(34)、`lead-activity-service`、`claude-lead-activity`、`lead-activity-route`、`bridge-child-process-census` | 5 文件 / 74 条,exit 0 |
| config `flag-truth.test.ts`(读 env 合同) | 43 条,全绿 |
| claude-runner `kill-path-inventory.test.ts`(扫 `scripts/`) | 5 条,全绿;本次没有新增任何 kill 路径 |
| `node --test`:`qa-lead-activity-long-turn`(新;`753732e68` 19 条,`7576d2f33` 27 条,`add4cdc12` 29 条,`e6dc0b8d1` 31 条,`d908a2296` 35 条,`efe8e61c6` 36 条,`8b9fa8de1` 38 条,含一条带种子的性质测试)、`fly2655-voice-room`(19)、`teamlead-shards`(9)、`workflow-startup`(7) | 全部 fail 0 |
| shell:`qa-slot-env-contract`、`run-bridge-isolation-boot`、`fly1680-v1-extinction`、`codex-home-reconcile-cadence`、`test-deploy-launch-boundary`、`ci-structure`、`ci-matrix-coverage`、`ci-shell-suite-enumeration`、`qa-codex-lead-layers`、`test-deploy-generalized`、`test-cycle-bridge` | 全部 exit 0 |
| `test-deploy-fly1389.test.sh`(写死槽 30–35;跑前 `pgrep` 确认无他人实例;真实 launch spec 期望 vs 实际 Bridge 环境逐项比对,覆盖新 redirect) | 29 passed / 0 failed,exit 0 |
| `pnpm lint`(两个头各一次) | exit 0,0 error(25 条既有 warning) |
| `pnpm --filter "flywheel-teamlead..." build` / `pnpm --filter "...flywheel-teamlead" typecheck`(两个头各一次) | exit 0 / exit 0,0 个 `error TS` |
| 真实渲染器产物:用 `qa_launchd_render_plist` 生成房内 plist(`plutil -lint` OK),定位器解析通过并探到由 Lead 自己 state dir 推出的规范 socket | 通过 |

**变异验证(定位器)**:逐条去掉房内链路的 10 个检查(Label、state dir 在房内、Codex 行拒绝、wrapper 名、manifest 绑定、wrapper 绝对路径、唯一行、plist 在房内、重复键、注册表绝对路径),每一条都让至少 1 个用例变红。首轮有一个存活者(plist 在房外的用例因为文件读不到而「顺便」通过),已补一个「房外 plist 存在且其余全合法」的用例把它杀掉;另外两条负向用例改成只让被测检查起作用(state dir 在房外但 manifest socket 对该目录是规范的;Codex 行带合法 manifest)。评审修复后又对新增守卫做了同样的变异:结构化解析器的重复键、键名字面、单一顶层值、尾随内容 4 条(尾随内容那条首轮存活,补「`</plist>` 后跟纯文本」用例后杀掉);夹具的夹具时钟判时长、回合内只许 busy、缺投递证据判不确定、采满 hold、CommDB 规范化、一次性 HOME 6 条;R2、R3 修复后又对「busy 跨度按夹具首末采样算」「hold 结束前 idle 不算通过」「只算投递后读到的 busy」「同一轮开始时间稳定」4 条做了变异——全部让至少 1 个用例变红。

**消费者扫描**(`git grep -lF`:完整路径、文件名、父目录):
- `fleet-lead-locator`:自身测试、`lead-activity-service`、`plugin.ts`(未传新选项,行为不变)、`fly1680-v1-extinction.test.sh`(按路径引用)——全跑。
- `lead-activity-service`:自身测试、`plugin.ts`、路由测试——全跑。`vitest related` 对两者都会经枢纽 `plugin.ts` 退化为整包全量,不用。
- `qa-slot-env-contract.json` / `.sh`:12 个消费者,除下一条外全跑。**排除** `test-deploy-qa-room.test.sh`:在 manual-only 清单里,需要真房与真 Discord;合同变化由 `fly1389`(真实 launch spec 期望 vs 实际环境逐项比对)与 `run-bridge-isolation-boot`(boot 校验)覆盖。
- `ci.yml`(只加一行 `node --test`):跑了会解析 node 套件枚举 / 结构的 5 个守卫(`ci-shell-suite-enumeration`、`ci-structure`、`ci-matrix-coverage`、`teamlead-shards`、`workflow-startup`)与 `fly-889` 超时守卫。**排除** `ci-full`、`ship-ci-guard`、`required-wall-clock-thresholds`、`ci-full-reuse`、`fly1663-launchd-foundation`、`fly2102-flag-freeze`、`qa-fly-2007-phase0-analyze`、`test-runner-workspace-trust`、`test-worktree-removal-contract`、`update-flywheel-sources`:它们读的是 ci.yml 里与本行无关的 job / 键(full-CI 触发、超时、flag 冻结、工作区信任等)。另:`required-wall-clock-thresholds` 与 `feature-flags-drift` 在 main 的 full CI 上有确定性 ENOBUFS 红,归 FLY-2907,与本单无关(Lead 2026-09-26 告知)。

**没做的**:没有进 529 房。房内 Claude 定位与长回合夹具的真机效果只由单测(按 `qa-launchd-lead.sh` 真实布局构造)证明;夹具依赖 Lead 照做「前台 sleep」,不照做时答 3(不确定)而不是通过。

### 7.3 代码评审(`codex:rescue`,gpt-6-astra,只读)

| 轮次 | 头 | 结论 | 处置 |
|---|---|---|---|
| R1 | `753732e68`(返工增量) | CHANGES REQUESTED:3 HIGH(chat-ingest 子进程的真 HOME 让门铃 401/403 回退读生产 `.env`;夹具信接口自报时长、回合内持续 unknown 也能 PASS,且第一次 idle 就停采;CommDB 路径可用 `..` 逃出房间)+ 2 MEDIUM(plist 正则解析认不出实体编码的重复键和 `EnvironmentVariables` 外的键;缺投递证据时退回注入时刻仍能 PASS) | 五条全部采纳,`7576d2f33` 修复,见 7.1 与 7.2 |
| R2 | `7576d2f33`(只验 R1 五条) | R1 五条全部 RESOLVED;新发现 1 HIGH:修复里新增的 `idleBeforeHoldEnd` 只记录不参与判定,且时长从真实开始算、把启动等待算进去,一个 56 秒的回合(busy 10–66 秒、hold 75 秒)会被判 PASS → CHANGES REQUESTED | 采纳,`add4cdc12`:跨度按夹具首末 busy 采样算;hold 结束前 idle 判不确定;复现用例两条 |
| R3 | `add4cdc12`(只验 R2 那条) | R2 那条 RESOLVED;新发现 1 HIGH:投递前读到的另一轮 busy(报告开始时间也在 ±30 秒内)会被当成这轮的起点,把 56 秒的回合撑到 60 秒(`--poll-seconds 30` 可复现)→ CHANGES REQUESTED | 采纳,`e6dc0b8d1`:只算投递后读到、开始时间稳定的 busy;回合内出现别的开始时间即 FAIL;复现用例两条。提 R4 前自查了其余 PASS 条件(稀疏采样、容差内的别的轮、hold 前 idle、投递前 idle),没有再找到放行路径 |
| R4 | `e6dc0b8d1`(只验 R3 那条) | R3 那条 RESOLVED;新发现 1 HIGH:「稳定开始时间」筛选把检查窗口缩到最后一个稳定 busy,之后的 unknown 与别的开始时间都掉出窗口 → CHANGES REQUESTED | 采纳,`d908a2296`:窗口改到「这轮最后一个 busy 之后的第一个 idle」;连续三轮都是修复引入新的放行路径,因此不再逐例打补丁,改为**性质测试**:另写一条与判定代码无关的 PASS 不变式,随机生成 20 万条采样序列,凡判 PASS 必须满足它——当前头 0 违例(17829 次 PASS);同一探针对 `e6dc0b8d1`、`7576d2f33` 分别找出 2546、7642 次违例,证明它测得出这类缺陷。以 8000 次、固定种子的形式进了测试文件 |
| R5 | `d908a2296`(只验 R4 那条 + 不变式本身是否够强) | R4 那条 RESOLVED;新发现 1 HIGH,且**不变式有同样的盲点**:连续性从「真实开始 + 15 秒」才查,跨度却从 grace 内被 idle 打断之前的第一个 busy 算起(busy@5s、idle@10/15s、busy 20–75s 被算成 70 秒)→ CHANGES REQUESTED | 采纳,`efe8e61c6`:判定与不变式都只算以这轮最后一个 busy 结尾的不间断一段。又发现随机生成器根本造不出这种形状(`d908a2296` 与当前头在 20 万条上判定逐条相同),改为连续取值、偏向早期,并加一半「单轮 + 一段短中断」的结构化样本;改后同一性质在测试文件里(3000 次、固定种子)对 `7576d2f33`、`e6dc0b8d1`、`d908a2296` 三个旧判定全部报错,对当前头通过;20 万条本地复跑 0 违例(`d908a2296` 1025 次违例) |
| R6 | `efe8e61c6`(只验 R5 那条 + 不变式强度) | R5 那条 RESOLVED;**判定逻辑本轮没有再找到放行路径**。2 MEDIUM 都在测试里的不变式:计入跨度的 grace 内 busy 没查 trigger;30 秒开始界限只查了第一个样本 → CHANGES REQUESTED | 采纳,`8b9fa8de1`(只改测试):对所有计入的 busy 逐个查 30 秒界限与 trigger;评审给的两个反例进测试(判定都答 FAIL,不变式指出违例);性质测试仍对三个旧判定报错、对当前头通过;20 万条本地复跑 0 违例 |
| R7 | `8b9fa8de1`(只验 R6 两条) | R6 两条 RESOLVED;不变式与合同之间未发现剩余缺口;评审自己复跑定向测试与 3000 次性质测试(179 次 PASS、0 违例),三个旧判定都被拦下 → **APPROVED** | — |

R4 起每轮都只验上一轮的条目。连续几轮「修复引入新的放行路径」都出在 QA 夹具的判定逻辑(不是产品代码);定位器与房内注册表那部分自 R2 起没有新的发现。已给 Lead 发非阻塞说明(`eae7d543`),在 APPROVED 前没有收到不同裁定。

### 7.4 最终头的本机结果

`8b9fa8de1`(之后只有文档、进度与里程碑提交):`packages/` 自 `7576d2f33` 起无改动,7.2 表里 `7576d2f33` 那几行对它仍然有效;夹具测试 38/38(含 3000 次固定种子性质测试);`ci-shell-suite-enumeration`、`kill-path-inventory` 通过;`pnpm lint` exit 0、0 error。没有请求 full CI,没有进 529 房。


## 8. QA 返工(implement attempt 2 @ 本 DAG,QA attempt 3 FAIL)

QA(exec `ebc27720`)在头 `a34acbf28` 判 FAIL。产品部分 Codex 载体在 529 slot 2 用本分支 dist 实测通过:夹具 exit 0,idle → 不间断 busy 92 秒 → idle,开始误差 0.7 秒,聊天引起的回合答「判断不了」;杀掉 sidecar / app-server 后每个采样都是 `unknown / sidecar_unreachable`,从不答 idle。Claude 载体这轮没有空闲的 Claude 槽,只用本分支的房内定位器对 FLY-2906 的活房做了只读探测(slot3 / slot4 的 Claude Lead 读成 idle,与画面真值一致;同一 Lead 用生产读法答 `lead_window_unavailable`)。Claude 长回合与「进程不在」这轮没有证据,留给下一轮 QA。

**阻断项(本单引起)**:exact-head 全量 CI `36219247904` 的 Quick Gate 最后一步「Enforce FLY-2006 retention consumer gate」报 `unclassified_retention_consumer:scripts/qa-lead-activity-long-turn.mjs:mailbox:read`——新夹具读 `mailbox`(取 `notified_at` 作真实开始时间),没在 `scripts/fly-2006-retention-consumer-gate.config.json` 登记。本地 `node scripts/fly-2006-retention-consumer-gate.mjs` 确定性复现。

- **这是第二次同类漏检**(§6 是 `turn-trigger-attribution.ts`)。原因相同:我的消费者扫描是「谁引用了我改的文件」,而这个守卫是扫全仓「谁读了目标表」的 CI 脚本,新增一个读 `mailbox` 的文件就会触发,跟谁引用它无关。
- **修复**(`82f601950`):登记为 `candidate_guarded`,与其它 QA 读者(`qa-529-discord-roundtrip.mjs`、`qa/fly2446-two-lead-run.mjs`、`lib/qa-fly-2456-db.mjs`)一致。依据:夹具只读几分钟前自己插入的那一行,远在 14 天窗口之内;万一行被清扫,取不到 `notified_at` 就答「不确定」(`no_delivery_evidence`),不会通过。
- **这次不再只跑定向集合**:在本机把 `ci.yml` 的 **Quick Gate 全部步骤**逐条跑了一遍(除 `pnpm install`,以及全仓 `pnpm build` / `pnpm typecheck`——包代码自 `7576d2f33` 起没有改动,受影响包的 build 与下游 typecheck 已在 §7 通过)。结果:FLY-2006 守卫 `ok:true`、测试 10/10;其余 60 余步 exit 0,两处本地红已查明与本单无关:
  - `raya-cos-cli-dist.test.mjs`:本地没有 `packages/raya-cos/dist`(CI 在前面的 `pnpm build` 里生成)。补建 `raya-cos` 后 5/5 通过。
  - `qa-fly-2519-browser-node.test.mjs` 的「final Seatbelt policy boots pinned Node, MCP and native Chrome」:本机真 Chrome + Seatbelt 启动 60 秒后 `browser_lost`,当时负载均值约 150–240。该用例在非 macOS 上 `t.skip("host-only …")`,CI 的 Linux runner 不会跑;本分支没有碰它或 browser worker。
- **另一处 CI 红** `qa-fly-1986-load-probe.test.sh`(Script Tests 5/6,「all-401 block certified as incomplete_expected=3」)与 §6 同一条、第二次出现;本分支不碰该脚本,按规矩不自行重跑 CI,交 Lead 裁定。
- 按实现节点规矩,我没有请求 full CI(冻结头的 full CI 归 QA)。
- **代码评审**:`codex:rescue`(gpt-6-astra,只读)只审 `a34acbf28..82f601950` 这一条登记 → **APPROVED**:`candidate_guarded` 符合该读者「只看本次注入的那一行、缺证据不会判通过」的行为;四字段键与扫描结果精确匹配;评审实测缺行 → `Date.parse("")` 为 `NaN` → `inconclusive / no_delivery_evidence`,旧配置复现唯一的未登记错误,新配置 `ok:true`。
