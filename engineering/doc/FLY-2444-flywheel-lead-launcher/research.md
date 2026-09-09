# FLY-2444 任意仓起一个 Lead — 调研

Issue: FLY-2444 (https://linear.app/geoforge3d/issue/FLY-2444/产品-任意仓起一个-lead最小闭环flywheel-lead-launcherclaude-codex-注册一行-一页文档raya)
日期: 2026-09-08
基于: exploration.md

> 取证锚点:worktree `flywheel-FLY-2444` @ main `296d9a413`;生产 `~/.flywheel`(只读);Bridge `/health` buildSha `1a9b9e9a`;
> Discord 插件 `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.6/`。所有行号用 `grep -n` / `sed -n` 取过。
> 本文只记事实与实验;方案在 plan.md。

## 1. 名册与身份:注册「一行」的真实成本

### 1.1 一行的最小字段【实核】

| 字段 | 校验 | 依据 |
|---|---|---|
| `projectName` / `projectRoot` | 必填;`projectName` 匹配 `SAFE_IDENTIFIER_RE`(成为路径分量) | `ProjectConfig.ts:424-437` |
| `leads[].agentId` | 必填,同一正则;派生 `child_key` ≤128 字节;exact-key 不得碰撞 | `ProjectConfig.ts:630-645` |
| `leads[].chatChannel` | 非空 | `ProjectConfig.ts:478` |
| `leads[].match.labels` | **非空数组**(纯聊天 Lead 也要) | `ProjectConfig.ts:484-495` |
| `leads[].summaryRole` | 必填(FLY-2030),缺/未知 ⇒ 整份加载失败 | `ProjectConfig.ts:14-15` |
| `leads[].botTokenEnv` / `botUserId` | managed Lead 必须有;Codex launcher 缺 `botUserId` 直接拒启 | `canonical-lead-identity.sh:94-100` |
| `leads[].backend` | `claude-code` \| `codex-app-server`;`carrier` 只对 claude 合法 | `ProjectConfig.ts:692 / :717` |
| `leads[].codexProfile` | `companion` \| `write-capable` \| `full-access`;`full-access` 与 `companion:true` 互斥 | `ProjectConfig.ts:796-835` |
| `agentId` 全局唯一 | Bridge `projectByLead` 只按 agentId 建索引,跨项目重名抛错 | `lead-inbox-runtime.ts:313-317` |

### 1.2 解析器【实核 — 实验 E1】

把 FLY-2131 检查单里的 raya 行追加到 `~/.flywheel/projects.json` 的**副本**,跑
`lead-identity resolve --projects-file <副本> --project raya --lead raya --format json` ⇒ 成功:
`role=cos`、`summaryRole=recipient`、`hasSummaryDuty=false`、`discordStateDir=~/.claude/channels/discord-raya`、三个 digest 齐全。
**结论:解析器不需要任何额外登记;一行就够它。**

### 1.3 summary registry 回执栅栏【实核】

- `restart-services.sh:200-215` 的 `summary_registry_activation_preflight` 跑 `summary-registry verify-activation --projects-file ~/.flywheel/projects.json --receipt-file ~/.flywheel/state/summary-registry/migration-receipt.json`;`:1860` 失败即拒绝整次 restart(fail-closed)。
- `verifySummaryRegistryActivation`(`summary-registry-migration.ts:465-484`)把**当前 projects.json 的全部 Lead 投影摘要**与回执 `summaryAssignmentDigest` 比对,不等 ⇒ `summary_registry_projection_mismatch`。
- 生产回执:16 条 assignment,digest `b4be7ea6…`,`migratedAt 2026-08-28`。**加任何一行就失配。**
- 重铸路径:`scripts/migrate-summary-registry.sh <projects> <assignments.json> <receipt> <expected-sha256>` → 持 `projects.json.cfglock` → `summary-registry migrate`;
  `applyManifest`(`:209-262`)要求 manifest **给每个 registry Lead 恰好一条**,否则 `summary_registry_manifest_invalid`;`expectedSha256` 不等于当前文件 ⇒ `summary_registry_stale`。
- FLY-2259 runbook §4.1-4.2 因此把「注册行」与「重铸回执」写成**不得跨班车**的同事务;材料 `register-codex-lead.py`(原子替换、保模式)+ `assignments.json`(手写 17 条)。

**结论:「注册一行」= 行 + 回执重铸,两者必须在同一把 `cfglock` 里完成;缺后者不是「以后再说」而是「下次 restart-services 拒绝」。**

### 1.4 生效时机【实核】

- `LeadInboxRuntime` 构造时 `for (const project of opts.projects)` 建 queue(`lead-inbox-runtime.ts:251-264`),再 `for (const [leadIndex, lead] of project.leads.entries())` 每个 Lead 一条 `LeadInboxLoop`(`:313-552`);`start()` 只启动已建的 loop(`:556-558`)。
- `plugin.ts:5771` 的 `loadProjects()` 只做名册核对(`currentLeadRecipientsForProject`),不建新 loop;`grep reloadProjects|fs.watch|SIGHUP` 零命中。
- 门铃 `POST /api/lead-inbox/nudge` 对未建 loop 的 Lead 回 **404 `Lead inbox loop not found`**(`plugin.ts:3040-3057`)—— 这是现成的「泵存不存在」探针。

**结论:新 Lead 的泵在下次 Bridge 重启才出现;文档必须明写;`verify` 可用 nudge 202/404 判定。**

## 2. Claude 路径:已经是「一行 → 通用启动器」【实核】

| 环节 | 事实 | 依据 |
|---|---|---|
| plist | `ProgramArguments = /bin/bash ~/.flywheel/bin/flywheel-lead-wrapper-v2.sh ~/.flywheel/manifests/<p>-<l>.json`,label `com.flywheel.lead.<p>-<l>` | 生产 plist `com.flywheel.lead.flywheel-flywheel-eng-lead.plist`;`flywheel-daemon.sh:303-316`(只认 v2) |
| manifest | 由 projects.json 机械生成,只带 selector + model/effort/leadBackend;身份字段禁止出现 | `materialize-lead-manifests.sh:1-16`;`flywheel-lead-wrapper-v2.sh:200-216`(forbidden fields) |
| wrapper | 一次 `lead-identity resolve`;`backend != claude-code` ⇒ `identity_backend_mismatch` 退出 | `flywheel-lead-wrapper-v2.sh:227-277` |
| body → claude-lead.sh | `FLYWHEEL_DIR/packages/teamlead/scripts/lead-body.sh`,再 source `claude-lead.sh` | `flywheel-lead-wrapper-v2.sh:341`;`lead-body.sh:1-6` |
| 外仓要给的 | `<projectRoot>/.lead/<leadId>/identity.md`(或 `agent.md`),缺则 fail-fast | `claude-lead.sh:957-985` |
| comm.db | `~/.flywheel/comm/<projectName>/comm.db`;`FLYWHEEL_COMM_CLI` 指向 `packages/flywheel-comm/dist/index.js` | `claude-lead.sh:676-681`;`resolve-db-path.ts:21` |
| 插件 | `--dangerously-load-development-channels plugin:discord@flywheel-plugins`;启动前 `~/.flywheel/bin/check-discord-plugin.sh` 门 | `claude-lead.sh:2559 / :1058-1125` |
| 入站三 env | `FLYWHEEL_COMM_CLI` `FLYWHEEL_COMM_DB` `FLYWHEEL_LEAD_ID` 缺一 ⇒ `RECORDER_MODE.kind='broken'` ⇒ legacy 直推(② 改 fail-closed) | 插件 `chat-receipt-recorder.ts:98-114`;`server.ts:1750-1782` |
| 打包态 | `bootstrap-services.sh:117-131` 从 manifest 渲染 spec `{name:"lead-<p>-<l>", exec: wrapper-v2 <m>}`;`backend != claude-code` ⇒ warn 跳过 | 同文件 `:126-128` |

⚠️ 打包态 spec 名 `lead-<p>-<l>` 经 `_sup_darwin_label`(`supervisor.sh:169`,`com.flywheel.<name>`)得到 `com.flywheel.lead-<p>-<l>`(**连字符**),而本机 / restart-services / patrol 全部认 `com.flywheel.lead.<p>-<l>`(**点**)。这是既有不一致,本单不修,但本单的 spec 名必须用 `lead.<p>-<l>` 以对齐本机约定。

## 3. Codex 路径:运行时通用、launcher 手写【实核】

### 3.1 手写 launcher 里「只有它在做」的那层

对比 `run-codex-lead-mufasa-tui-fullaccess.sh`(140 行)与 `run-codex-lead-raya-tui-fullaccess.sh`(99 行),去掉注释后两者的差异全部是**常量**:

| 常量 | mufasa | raya | 来源应是 |
|---|---|---|---|
| selector | `growth` / `mufasa-lead`(`:48`) | `raya` / `raya`(`:26`) | 命令行参数 |
| `FLYWHEEL_LEAD_CHAT_CHANNEL_ID` | 写死 `1500600400238084307`(`:54`) | 写死 `1542079099928059987`(`:30`) | 名册 `chatChannel` |
| `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` | roundtable id(`:56`) | roundtable id(`:31`) | 可选;bridge 出站下必须为空(§3.3) |
| `FLYWHEEL_CODEX_LEAD_STATE_DIR` | legacy `state/codex-lead/mufasa-lead`(`:61`) | legacy `state/codex-lead/raya`(`:32`) | `codex-lead.sh:83-87` 的 hex 推导(Bridge 同款) |
| `FLYWHEEL_CODEX_LEAD_HOME_KEY` → `CODEX_HOME` | `mufasa`(`:62-64`) | `raya`(`:33-35`) | `derive_codex_lead_home <key>`(`lead-address.sh:22-40`) |
| `FLYWHEEL_CODEX_BIN` | `$CODEX_HOME/packages/standalone/current/codex`(`:66`) | 同(`:36`) | 约定 |
| `FLYWHEEL_CODEX_LEAD_PROJECT_DIR` = `FLYWHEEL_CODEX_TUI_CWD` | `~/Dev/growth`(`:75-87`) | `RAYA_LEAD_WORKSPACE`(`:56-57`) | 名册 `projectRoot` |
| `FLYWHEEL_CODEX_LEAD_PROFILE/SANDBOX` | `full-access` / `workspace-write`(`:71-72`) | 同(`:54-55`) | 名册 `codexProfile` |
| `FLYWHEEL_LEAD_ACTIONS_MAIN_JS/NODE_BIN/STATE_DIR` | teamlead dist 路径(`:90-92`) | 同(`:58-60`) | 约定(teamlead root) |
| `FLYWHEEL_CODEX_LEAD_OUTBOUND` | `direct`(`:104`) | `direct`(`:61`) | ① 改 `bridge` |
| `FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES` | `~/Dev/growth/.lead/mufasa-lead/identity.md`(`:109-110`) | `IDENTITY.md,MEMORY.md`(`:70`) | 约定 `.lead/<lead>/identity.md` |
| `FLYWHEEL_COMM_DB` | `~/.flywheel/comm/<project>/comm.db`(`:52`) | `~/.flywheel/comm/raya/comm.db`(`:29`) | 约定 |

其余(`canonical_lead_identity_resolve`、`lead-rules-bundle.sh` governance、`codex-home-link-truth.sh`、`codex-lead-tui-home.sh ensure-home`、`exec node codex-lead-tui-runtime.js`)两份**逐字相同**。

### 3.2 通用 dormant launcher `codex-lead.sh` 已覆盖的部分【实核】

- 同 claude-lead.sh 的位置参数与校验(`codex-lead.sh:25-63`);`canonical_lead_identity_resolve`(`:67`);
- state dir hex 推导 `state/codex-lead/<SAFE_P>__<SAFE_L>-<hex>`(`:83-90`)—— 与 Bridge `resolveCodexLeadStateDir` 的 hex 分支逐字一致(`lead-inbox-runtime.ts:1236-1241`;先查 legacy `<root>/<leadId>` 再用 hex);
- full-access governance bundle(`:112-127`);
- TUI 模式:`ensure-home` + **`ensure-daemon`** + exec TUI runtime(`:133-160`)。

⚠️ **一处必须改**:`:146` 在 launcher 侧调 `ensure-daemon`。full-access 的 TUI runtime **自己拥有 daemon 生命周期**(`codex-lead-tui-runtime.ts:1052-1075` `DaemonConnectionSupervisor.ensureDaemon`,注释 `:216-219`「stop-before-start,不让 stale read-only daemon 活过 flip」),mufasa/raya launcher 因此**刻意不调** ensure-daemon(mufasa `:127-130` 注释 pin ⑤)。通用路径在 `full-access` 下必须跳过 `:146`。

它**不做**的:§3.1 表里的每一项 env 合成。`CODEX_HOME` 在 `:145` 被引用但从未设置(依赖外部 env)。

### 3.3 运行时硬要求与 bridge 出站【实核】

- `parseCodexLeadRuntimeConfig`(`codex-lead-runtime.ts:516-560`):必填 `FLYWHEEL_LEAD_ID/PROJECT_NAME/LEAD_KEY/LEAD_BACKEND/LEAD_IDENTITY_DIGEST`、`DISCORD_EXPECTED_BOT_USER_ID`、`DISCORD_BOT_TOKEN`、`FLYWHEEL_LEAD_CHAT_CHANNEL_ID`、`FLYWHEEL_CODEX_LEAD_STATE_DIR`、`FLYWHEEL_CODEX_BIN`、`CODEX_HOME`、`FLYWHEEL_COMM_DB`;`leadId==="raya"` 时额外 `RAYA_METRICS_DIR`(`:544`,raya 专有残留,④ 处理)。
- `FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge` ⇒ 必填 `FLYWHEEL_BRIDGE_URL` + `FLYWHEEL_API_TOKEN`(`:528-529 / :545-552`);**与 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` 互斥**,否则启动即抛(`:616-628`)。
- full-access TUI 还要 `FLYWHEEL_LEAD_ACTIONS_MAIN_JS` + `FLYWHEEL_LEAD_ACTIONS_STATE_DIR`,缺则 fail-closed(`codex-lead-tui-runtime.ts:1002-1009`)。
- Bridge 端 `/api/lead-outbound/send` 仅在 `config.apiToken` 配置时注册(`plugin.ts:3060-3084`);`buildAuthorizeLeadChannel(projects)` 只放行该 Lead 的 `chatChannel` + 项目 `generalChannel`;bot token 由 `buildResolveBotToken(projects, env)` 按名册取。
  出站去重库 `~/.flywheel/codex-lead-outbound-dedup.db`(`plugin.ts:3067-3069`)—— 可作「回复确实经 Bridge」的证据。

### 3.4 Codex 独有前置【实核】

| 前置 | 事实 | 依据 |
|---|---|---|
| standalone codex + 隔离 home | `CODEX_HOME=~/.codex-<key>`,key `^[a-z][a-z0-9-]{0,31}$`;`FLYWHEEL_CODEX_BIN=$CODEX_HOME/packages/standalone/current/codex`;npm codex 无 daemon 后端 | `lead-address.sh:20-40`;mufasa launcher `:65-66` |
| auth | `codex-home-link-truth.sh --lead <p>/<l> <home>` 校验共享凭据链接(FLY-2404);`auth.json` 缺则 `ensure-home` fail-loud | mufasa `:115-119`;`codex-lead-tui-home.sh:16-20` |
| lead-actions MCP | `packages/teamlead/dist/lead-backends/codex/lead-actions/lead-actions-main.js` | mufasa `:90` |
| host tmux gate | wrapper 层 `host-tmux-selection-gate.sh`,失败 fail-loud 不出生 | raya wrapper `:25-70` |
| 生产形态 | 必须 windowed TUI(FLY-398 硬规则) | `CLAUDE.md` Codex Lead Deployment |

### 3.5 现有 CLI 探针(可直接串成 verify)【实核】

| 探针 | 判定 | 依据 |
|---|---|---|
| `lead-identity resolve … --format json` | 行合法、身份可解析 | `flywheel-comm/src/commands/lead-identity.ts` |
| `summary-registry verify-activation --projects-file --receipt-file` | 回执与名册一致 | `summary-registry-migration.ts:465-484` |
| `GET /health` | Bridge 活、`buildSha` | 本机实测 `{"ok":true,…}` |
| `POST /api/lead-inbox/nudge {leadId, project}` | 202 = 泵在;404 = 泵不在(未重启) | `plugin.ts:3040-3057` |
| `<stateDir>/lead-inbox.sock` 存在 | Codex Lead 进程在收 socket | `CodexLeadInboxSocket.ts:64-66` |
| `flywheel-comm message-status <id> --project <p>` | 一条 mailbox 行的 live/archive 投递证据 | `index.ts:130 / :297`;`commands/message-status.ts` |
| `codex-lead-outbound-dedup.db` 有该 idempotencyKey | 回复走了 Bridge 出站 | `plugin.ts:3067-3069`;`CodexOutboundSender.ts:180-200` |

## 4. 打包态与安装面【实核】

- payload 白名单(`scripts/package-onboard-files.allow`)已含:`scripts/flywheel-lead-wrapper-v2.sh`、三份手写 codex wrapper、`materialize-lead-manifests.sh`、`lib/lead-address.sh`、`lib/lead-restart-lifecycle.sh`;
  `node_modules/flywheel-teamlead/scripts/{claude-lead,lead-body,codex-lead,codex-lead-tui-home,lead-rules-bundle}.sh`。新脚本需登记同表(否则 FLY-1835 闭包门红)。
- `converge-flywheel-bin.sh:81` 的 `FILES` 列表决定哪些 `scripts/*.sh` 被复制到 `~/.flywheel/bin` 并做「安装副本 == 仓库源」校验;新增入口要加进去(mode 555)。
- supervisor 抽象:`supervisor_install <spec>`(`supervisor.sh:247-273`);darwin 真装需 `FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1`,否则 no-op 委托旧流程;spec 字段 `name kind exec keepAlive throttleInterval stdout`(`:178-200`),**没有 env 字段**(launchd `EnvironmentVariables` 不可经 spec 注入 —— 因此 `FLYWHEEL_LEAD_MODEL` 这类只能由 launcher 从名册自取,不能靠 plist env)。
- 家配置 `host.json`(`lib/host-config.sh`)缺省 = 今天的写死值(`FLYWHEEL_DIR=~/Dev/flywheel`);打包态由 bootstrap 写 `flywheelDir=<state>/runtime/current`。新入口通过 `host_config_load` 取 `FLYWHEEL_DIR`,不再自己写死。
- CI:根 `scripts/__tests__/*.test.sh` 必须在 `ci.yml` 里**逐个枚举**或进 `ci-shell-suite-manual-only.txt`(`ci-shell-suite-enumeration.test.sh:1-20`);`packages/teamlead/scripts/__tests__/*.test.sh` 由 teamlead 包的测试步骤跑。

## 5. Raya 与 FLY-2259 材料的可复用性【实核】

- `engineering/doc/FLY-2259-raya-brain-cutover/materials/register-codex-lead.py`:追加一个 project 行,原子替换、保模式、拒符号链接 —— 逻辑通用,只是没有校验、没有回执、没有锁(锁由外层 `flywheel-config-lock.sh` 提供)。
- `materials/assignments.json`:手写 17 条(16 现有 + raya)—— 正是「manifest = 现回执 + 新行」可机械生成的证据。
- `packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist`:路径写死 `/Users/xiaorongli/...`。
- runbook §4.5-4.7 的「converge → materialize → plist → bootstrap → 活了」谓词序列,是 `install` + `verify` 的现成验收清单。
- FLY-2216 已把 `codexResidencyPatrol:true` 做成**任何** Codex Lead 的 opt-in 常驻自愈开关(`resident-codex-lead-roster.ts:10-33`:要求 `backend=codex-app-server` + `canSpawnRunners=false` + `companion|codexProfile`)—— 新 Lead 想要巡视只需名册加一字段,不在本单范围。

## 6. 决策记录(本单内)

| # | 决策 | 理由 |
|---|---|---|
| D1 | **不写新运行时**,Claude 走 wrapper-v2 零改动,Codex 走 `codex-lead.sh` + 一层「名册 → env」合成 | §2/§3.2:两者运行时都已通用;缺的只是合成层与入口 |
| D2 | 「注册一行」= 一条命令内:持锁 → 校验 → 原子写行 → 自动 manifest 重铸回执 → verify-activation → materialize manifest | §1.3:否则下次 restart-services 拒绝;§5:FLY-2259 已证明同事务可行 |
| D3 | 生效 = 下次 Bridge 重启,命令输出与文档明写;不做热加载 | §1.4;热加载动 Bridge 泵,超出最小闭环 |
| D4 | Codex 默认 `mode=tui`、`profile=full-access`、`outbound=bridge`、`cross-dept` 留空 | FLY-398 硬规则;Raya 既定裁定;① 的方向;§3.3 互斥 |
| D5 | persona 约定 `<projectRoot>/.lead/<leadId>/identity.md`,两 harness 同处;不加名册字段 | Claude 已如此(§2);mufasa Codex 也如此(§3.1) |
| D6 | Codex home key = `agentId`(`~/.codex-<agentId>`);不加名册字段 | raya 的既定 key 恰为 agentId;mufasa 等继续用手写 launcher,不迁 |
| D7 | `codex-lead.sh:146` 的 `ensure-daemon` 在 `full-access` 下跳过 | §3.2 ⚠️:runtime 拥有 daemon;与生产 launcher 对齐 |
| D8 | launchd label 沿用 `com.flywheel.lead.<p>-<l>`,spec 名 `lead.<p>-<l>`;打包态的连字符形态记为既有不一致,不在本单修 | §2 ⚠️ |
| D9 | 三份手写 Codex launcher / wrapper / plist 模板**零字节不动**;新入口与之并存 | 范围纪律;mufasa/infra-bot 在生产跑 |
| D10 | 一页文档放本 issue 文件夹 `lead-in-any-repo.md`;是否随 payload 出货归产品化线 | payload 明确排除 `doc/`(FLY-1062) |
