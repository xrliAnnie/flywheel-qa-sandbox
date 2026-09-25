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
