# FLY-2444 任意仓起一个 Lead — 探索

Issue: FLY-2444 (https://linear.app/geoforge3d/issue/FLY-2444/产品-任意仓起一个-lead最小闭环flywheel-lead-launcherclaude-codex-注册一行-一页文档raya)
日期: 2026-09-08
基于: 无(上游 = FLY-2439 v3 `lead-paths.md` / `research.md §G`、FLY-2259 `activation-runbook.md`、Epic FLY-2441)

> 成色标记:【实核】= 本机读码 / 实测(命令与 file:line 在 research.md);⬜ = 工程判断;✅ = founder / Lead 已拍。
> 本文只回答三个问题:今天「起一个 Lead」到底要动哪些东西、哪些已经是通用的、哪些还是「一个 Lead 一套脚本」。方案在 §5 只给方向,细节在 plan.md。

## 0. 一句话

今天 **Claude Lead 已经是「注册一行 → 通用启动器」**(projects.json 行 → manifest → `flywheel-lead-wrapper-v2.sh`),
而 **Codex Lead 仍是「一个 Lead 一套手写脚本」**(mufasa / raya / infra-bot 各一份 launcher + wrapper + plist 模板,频道 id 与路径写死);
两条路都**没有**一个面向外仓的「注册 + 起 + 验」入口,而且**注册一行**在现实里是「改 projects.json + 重铸 summary 回执 + 重启 Bridge」三件事,不是一行。

## 1. Epic 里本单的位置

| 子单 | 内容 | 与本单关系 |
|---|---|---|
| ① FLY-2442 | Codex 出站改经 Bridge(launcher 配置)+ 「mailbox → 适配器」合同一页 | 本单的 Codex launcher **默认选 bridge 出站**,合同文档由 ① 出,本单引用不复制 |
| ② FLY-2443 | Claude fail-open 旁路改 fail-closed | 本单不动 Claude 入站代码;文档的「验证第一条消息走了 mailbox」以 ② 落地后的语义为准 |
| **③ FLY-2444(本单)** | `flywheel-lead` launcher(Claude / Codex)+ 注册一行 + 一页文档 | — |
| ④ FLY-2445 | Raya 迁为标准 Codex Lead | 依赖本单最小版;Raya 是第一个外仓用户 |

founder 原话(Epic 描述):**Flywheel 是产品(harness),最终是 npm 包。任何 Lead(Claude / Codex,任何仓)装上即当 Lead。**
本单只定「装了包之后怎么当 Lead」;发布流水线(FLY-2388)与打包闭包门(FLY-1835)不重复造。

## 2. 现状:起一个 Lead 今天要动的东西【实核】

### 2.1 身份与注册(两种 harness 共用)

- **唯一权威源 = `~/.flywheel/projects.json`**(FLY-1726):`projectName` + `leads[].agentId` 一行就是 Lead 身份;其余每张「脸」(env、state dir、token 选择器、bot id、launchd 键)都是它的派生投影。
  `flywheel-comm lead-identity resolve --projects-file … --project … --lead … --format json` 是唯一解析器;两种 launcher 都从它取坐标。
- 一行必须有:`agentId` `chatChannel` `match.labels`(非空!)`botTokenEnv` `botUserId` `summaryRole`(FLY-2030 起必填,缺了整份配置加载失败);
  项目级必须有 `projectName` `projectRoot`。`agentId` 在**全部项目里全局唯一**(Bridge `projectByLead` 只按 agentId 建索引)。
- 【实核】把一行 raya 加进一份 projects.json 副本,`lead-identity resolve` **能直接解析**(role=cos、hasSummaryDuty=false 由 summaryRole 派生),不需要别的登记。
- 🔴 **但 summary registry 回执会立刻失配**:`~/.flywheel/state/summary-registry/migration-receipt.json` 记的是全部 Lead 的 summaryRole 投影摘要;
  任何一行增删都让 `summary-registry verify-activation` 报 `summary_registry_projection_mismatch`,而 `restart-services.sh:1860` 把它当 fail-closed preflight ——
  **不重铸回执,下一次 restart-services 直接拒绝**。重铸 = `scripts/migrate-summary-registry.sh <projects> <assignments.json> <receipt> <sha>`,
  manifest 必须「给每个 registry Lead 恰好一条」(`applyManifest`)。FLY-2259 runbook §4.1/§4.2 已经把「注册行 + 重铸回执」写成同事务,但只为 raya 手工执行,且**窗口从未执行**(本机没有 `com.flywheel.lead.raya-raya.plist`)。
- 🔴 **Bridge 不热加载**:`LeadInboxRuntime` 在构造时按当时的 `projects` 为每个 (project, lead) 建一条 `LeadInboxLoop`(`lead-inbox-runtime.ts:251-552`),之后 `loadProjects()` 只用于名册核对。
  新注册的 Lead **要等 Bridge 重启**才有泵;重启只走班车(00:00 / 12:00)或 founder 单次票。

### 2.2 Claude 路径:已经通用

```
launchd com.flywheel.lead.<project>-<lead>
  → ~/.flywheel/bin/flywheel-lead-wrapper-v2.sh <manifest>     (FLY-1663,通用,只认 backend=claude-code)
    → packages/teamlead/scripts/lead-body.sh <manifest>        (通用)
      → claude-lead.sh <lead> <projectDir> <project>            (3 387 行,通用)
        → claude --dangerously-load-development-channels plugin:discord@flywheel-plugins
```

- manifest 由 `scripts/materialize-lead-manifests.sh` 从 projects.json 机械生成(`<project>-<lead>.json`),plist 由 `flywheel-daemon.sh generate_plist_to` 渲染(只认 v2 carrier)。
- 外仓要提供的只有 **`<projectRoot>/.lead/<leadId>/identity.md`**(`claude-lead.sh:957-985`,缺则 fail-fast)。
- 打包态(FLY-1062)`scripts/packaged/bootstrap-services.sh:113-131` 已能从 manifest 渲染 per-Lead supervisor job —— **但只装 Claude v2,遇到 `codex-app-server` 打 warn 跳过**(`:127`)。
- 入站:插件 bun 适配器 → 本地 spool → `flywheel-comm chat-ingest` → **同一张 `mailbox` 表** → 门铃 `POST /api/lead-inbox/nudge` → Bridge `LeadInboxLoop` → Claude JSON inbox。
  三个 env(`FLYWHEEL_COMM_CLI` `FLYWHEEL_COMM_DB` `FLYWHEEL_LEAD_ID`)缺一走 legacy 直推(② 要改 fail-closed)。

### 2.3 Codex 路径:三份手写 launcher

```
launchd com.flywheel.lead.growth-mufasa-lead
  → ~/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh    (手写,一 Lead 一份)
    → packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh     (手写,140 行,频道 id / 路径写死)
      → node dist/lead-backends/codex/codex-lead-tui-runtime.js
```

- 同款还有 `run-codex-lead-raya-tui-fullaccess.sh`(FLY-2131/2216/2259 为 raya 写,写死 `raya/raya`、`RAYA_*` 路径)与 `run-codex-infra-bot-tui.sh`;plist 模板三份(`packages/teamlead/scripts/templates/`)。
- 【实核】`packages/teamlead/scripts/codex-lead.sh`(FLY-224,177 行)是**通用的 dormant launcher**:与 `claude-lead.sh` 同样的位置参数 `<lead> <projectDir> [project] [--subdir]`,
  `canonical_lead_identity_resolve` 取身份,推导 state dir(hex 可逆编码,与 Bridge `resolveCodexLeadStateDir` 同款),full-access 时装 governance bundle,`FLYWHEEL_CODEX_LEAD_MODE=tui` 时走 `codex-lead-tui-home.sh ensure-home` 再 exec TUI runtime。
  它**缺**的是手写 launcher 里那一段「从名册/约定推出来的 env」:`CODEX_HOME`(`derive_codex_lead_home <key>`)、`FLYWHEEL_CODEX_BIN`、`FLYWHEEL_LEAD_CHAT_CHANNEL_ID`、`FLYWHEEL_CODEX_LEAD_PROFILE/SANDBOX`、`FLYWHEEL_CODEX_LEAD_PROJECT_DIR`、`FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES`、`FLYWHEEL_LEAD_ACTIONS_*`、`FLYWHEEL_CODEX_LEAD_OUTBOUND`、`FLYWHEEL_COMM_DB`。
  也就是说:**Codex 缺的不是运行时,是「把名册一行变成这一组 env」的那层**。
- 运行时硬要求(`codex-lead-runtime.ts:516-560`):`FLYWHEEL_LEAD_ID/PROJECT_NAME/LEAD_KEY/LEAD_BACKEND/LEAD_IDENTITY_DIGEST`、`DISCORD_EXPECTED_BOT_USER_ID`、`DISCORD_BOT_TOKEN`、`FLYWHEEL_LEAD_CHAT_CHANNEL_ID`、`FLYWHEEL_CODEX_LEAD_STATE_DIR`、`FLYWHEEL_CODEX_BIN`、`CODEX_HOME`、`FLYWHEEL_COMM_DB`;
  `FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge` 时再要 `FLYWHEEL_BRIDGE_URL` + `FLYWHEEL_API_TOKEN`,且**与 cross-dept 频道互斥**(bridge 出站会 403 roundtable)。
- 入站:`RestPollDiscordInboundSource`(3s 轮询)→ `CodexDiscordMailboxStrategy` → `ingestDiscordChat` → **同一张 `mailbox` 表** → Bridge `LeadInboxLoop` → `CodexLeadDeliveryAdapter` → unix socket `<stateDir>/lead-inbox.sock` → journal → Codex。
  Bridge 侧 socket 路径由 `resolveCodexLeadStateDir(project, lead)` 推:先看 legacy `~/.flywheel/state/codex-lead/<leadId>`,没有就用 hex 形 —— 与 `codex-lead.sh` 的推导一致。
- 出站:生产 `direct`;`bridge` 模式已实现(`CodexOutboundSender.ts` → `POST /api/lead-outbound/send`,Bridge 端 `buildAuthorizeLeadChannel` 只放行 chatChannel + generalChannel)。① 把它翻成 bridge。
- Codex 独有前置:standalone codex 装在**隔离 `CODEX_HOME=~/.codex-<key>`**(`derive_codex_lead_home`,FLY-2259 通用规则),auth 由 founder 登录后经 `codex-home-link-truth.sh` 共享(FLY-2404);lead-actions MCP dist;host tmux selection gate。

### 2.4 打包态(装了包之后)

- payload(FLY-1062 `package-onboard.sh`)已把两种 launcher 的运行时闭包都装进 `node_modules/flywheel-teamlead/scripts/`(`claude-lead.sh` `lead-body.sh` `codex-lead.sh` `codex-lead-tui-home.sh` `lead-rules-bundle.sh` …)和 `scripts/`(`flywheel-lead-wrapper-v2.sh` `materialize-lead-manifests.sh` `lib/lead-address.sh` …);
  **三个手写 Codex wrapper 也被整个打进去了**(`flywheel-codex-lead-wrapper-{mufasa,raya,codex-infra-bot}.sh`)—— 客户机上装着三份写死别人频道 id 的脚本。
- `packages/flywheel-cli`(`flywheel init/doctor`)是 runner 侧的 agent-registry 工具,**不是客户运行时**(payload 明确排除),与 Lead 注册无关。
- 供应侧的 supervisor 抽象(`scripts/lib/supervisor.sh`,FLY-650)已能按 spec JSON 在 launchd / systemd-user 装 service;plist 模板路径写死 `/Users/xiaorongli/...`。

### 2.5 Raya 现状(第一个外仓用户)

- projects.json **没有** raya 行(`grep -c raya` = 0);`~/Dev/raya-lead-workspace` 不存在;`~/.codex-raya` 不存在;launchd 只有产品 job `com.xrli.raya.brain` / `.voice`。
- FLY-2131 `activation-checklist.md §B` 已写好 raya 行的字段值(`projectName=raya` `agentId=raya` `backend=codex-app-server` `codexProfile=full-access` `canSpawnRunners=false` `summaryRole=recipient` `botUserId=1542068543645024257` …);FLY-2259 runbook 把「注册 + 重铸回执 + converge + manifest + plist + 出生 + 活了 + 退应急面 + 回滚」写成 801 行,**全部手工、全部 raya 专用路径**。
- ④ 的迁移应该只剩「按本单文档跑三条命令 + 删 raya 仓旧壳」。

## 3. 差距(founder 期望 vs 现状)

| # | founder 期望 | 现状 | 差 |
|---|---|---|---|
| G1 | 一个 launcher,选 Claude / Codex | Claude 通用;Codex 三份手写 | Codex 缺「名册 → env」层 + 统一入口 |
| G2 | 注册 = 一行 | 一行 + summary 回执重铸 + 等 Bridge 重启;写法散在 runbook / python 材料里 | 缺一个持锁、原子、带回执的注册命令;缺「什么时候生效」的明说 |
| G3 | 装了包就能起 | 打包态只装 Claude;Codex 被跳过;plist 模板路径写死 | 缺按 spec 渲染的 Codex service;缺路径参数化 |
| G4 | 一页文档 | 只有 raya 专用 801 行 runbook 与散落的 launcher 头注释 | 缺面向外仓的「装 / 注册 / 验」三段 |
| G5 | 验证第一条消息走了 mailbox | 有 `flywheel-comm message-status <id>`、`POST /api/lead-inbox/nudge`(404 = 泵不存在)、Codex socket 文件、Bridge outbound dedup db —— 但没人把它们串成一条检查 | 缺一个 `verify` |
| G6 | 回复经 Bridge 出站 | Codex 生产 direct;bridge 模式与 cross-dept 互斥 | 由 ① 翻;本单 launcher 默认 bridge,cross-dept 留空 |

## 4. 边界(本单不做)

- 不造发布流水线、不改 payload 打包机制(FLY-2388 / FLY-1835);本单只**登记**新脚本进 allowlist。
- 不改 Bridge 投递泵、不做 projects.json 热加载(生效 = 下次 Bridge 重启,明写进文档;热加载另立单)。
- 不迁移 mufasa / infra-bot 的手写 launcher(它们继续跑;本单新 launcher 与之并存,零字节改动);不删三份手写脚本。
- 不动 Claude 入站(②)、不写 ① 的合同、不做 Raya 迁移本身(④)、不做语音(⑤)。
- 不在本 design 节点写实现码。

## 5. 方案方向(细节见 plan.md)

**一个入口 `flywheel-lead`,四个动词,零新运行时:**

1. `flywheel-lead register` —— 把「一行」真正变成一行:持 `projects.json.cfglock`、校验(复用 `compileLeadIdentityRows` + `compileSummaryAssignments`)、原子写行、**同事务重铸 summary 回执**(manifest 自动 = 现回执全部 assignment + 新行)、materialize manifest;打印「生效于下次 Bridge 重启」。
2. `flywheel-lead run --project P --lead L` —— 从名册解析一次身份,按 `backend` 分叉:
   `claude-code` → exec `flywheel-lead-wrapper-v2.sh <manifest>`(零改动);
   `codex-app-server` → 从名册 + 约定合成那组 env(见 §2.3),exec 通用 `codex-lead.sh L <projectRoot> P`(TUI 模式,默认 `OUTBOUND=bridge`)。
3. `flywheel-lead install` —— 用 supervisor spec 渲染 `com.flywheel.lead.<P>-<L>`,exec = `flywheel-lead run …`;darwin 走 launchd,linux 走 systemd-user;填上打包态 bootstrap 跳过 Codex 的洞。
4. `flywheel-lead verify` —— 串起已有探针:身份可解析 → Bridge 健康 → 泵存在(nudge 202)→ Codex socket 在 → 给一个 message id 查 `message-status` 有行且被投递 → 出站在 Bridge dedup db 有记录。

约定(不加新名册字段):persona 文件 = `<projectRoot>/.lead/<leadId>/identity.md`(两种 harness 同一处);Codex home key = `agentId`(`~/.codex-<agentId>`);state dir = `codex-lead.sh` 的 hex 形。

**一页文档** = 「装(前置 4 条)→ 注册(1 条命令)→ 起(1 条命令)→ 验(1 条命令 + 在频道打一句)」,Claude / Codex 各一列只在前置不同。

## 6. 要向 Lead 确认的点(非阻塞,先按默认走)

- Q1 Codex 通用路径默认 **TUI 窗口形态**(FLY-398 硬规则:生产 Codex Lead 必须 windowed)—— 默认 tui,headless 只留 `--mode headless` 给 QA。
- Q2 新 Lead 的 `codexProfile` 默认 `full-access`(= Claude-equal,Raya 的既定裁定);`companion` 与 full-access 互斥沿用 FLY-350。
- Q3 `match.labels` 对纯聊天 Lead 是多余的必填项(校验要非空)—— 本单 register 默认填 `[<agentId>]`,不改校验(改校验牵动 dispatcher,另立单)。
