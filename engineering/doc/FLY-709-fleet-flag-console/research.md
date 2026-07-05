# FLY-709 统一 fleet 控制台 — 调研

Issue: FLY-709 (https://linear.app/geoforge3d/issue/FLY-709/dashboard-统一-fleet-控制台-per-项目模型effort-所有-feature-flag-状态-founder-直接)
日期: 2026-06-30
基于: exploration.md

> 本文是**现状技术清单**（方向无关）。给 plan.md 当地基。全部 file:line 来自本仓 `flywheel-FLY-709` 分支审计。

---

## 1. Feature-flag 完整清单（① 注册表的第一批住户）

### 1.1 部署 env kill-switch / toggle（住所 A，`~/.flywheel/.env` → boot 时 `source`）

idiom：`!== "0"` = 默认 ON kill-switch；`=== "1"`/`=== "true"` = 默认 OFF opt-in。

| flag（env） | file:line | category | 默认 | 控什么 | 生效 |
|---|---|---|---|---|---|
| `FLYWHEEL_AUTO_QA` | `bridge/auto-qa-policy.ts:43` | kill_switch | ON | 全局关掉 auto-QA runner spawn（叠在 `qa.auto` 上） | restart |
| `FLYWHEEL_REMOTE_REPORTS` | `bridge/plugin.ts:2108`;`bridge/reports-route.ts:180`;`flywheel-comm/.../publish-report.ts:102` | kill_switch | ON | `/api/reports` 远程报告发布管线（双侧） | restart |
| `FLYWHEEL_FLEET_CONSOLE` | `bridge/plugin.ts:2280` | kill_switch | ON（且 `FLYWHEEL_PROJECTS` 未设） | Fleet console 面 + fleet 路由；`=0` 回退旧 dashboard | restart |
| `FLYWHEEL_MISROUTE_PATROL` | `bridge/gate-poller.ts:615` | kill_switch | ON（transport 接好时） | Lead-inbox 误投巡检 | **hot**（每 poll 读） |
| `FLYWHEEL_PANE_IDLE_SUPPRESS` | `bridge/plugin.ts:3370`;`LeadWatchdog.ts:110` | feature | ON | 抑制 alive-idle Lead pane 的 `pane_hash_stuck` 误报 | restart |
| `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` | `lead-backends/codex/.../config.ts:88` 等 | feature（值型，非 bool） | 空=不可用 | Codex Lead poll+mention-gate 的 `#leads-roundtable` 频道 id | restart |
| `DECISION_MODE`(=`FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE`) | `bridge/founder-consent/config.ts:111` | **governance_gate** | `off` | founder-consent 硬门 `off\|audit_only\|enforce` | restart |
| `FLYWHEEL_COMM_BYPASS_BRIDGE` | `flywheel-comm/.../respond.ts:66` | **governance_gate**（应急 override） | OFF | 绕过 founder-consent 直写 approve gate（loud audit） | 命令级 |
| `FLYWHEEL_ISSUE_STATUS_EMOJI` | `plugin.ts:789,2636`;`auto-qa-effects.ts:310` | feature | ON | issue thread 状态 emoji + 重连标记 | restart |
| `FLYWHEEL_ISSUE_STATUS_WORD` | `HeartbeatService.ts:1153` 等 | feature | ON | word 形状态标注 | restart |
| `FLYWHEEL_ISSUE_ATTACH_PIN` | `plugin.ts:794` | feature | ON | issue thread 钉 `tmux attach` 救援命令 | restart |
| `FLYWHEEL_QUIET_CLASSIFIER` | `plugin.ts:2673` | feature | ON | 抑制安静 runner 的 token-贵 Lead wake | restart |
| `FLYWHEEL_CRASH_REAPER` | `plugin.ts:2707` | feature | ON | crash runner 回收 | restart |
| `FLYWHEEL_LEAD_PANE_READINESS` | `plugin.ts:332` | feature | OFF（opt-in） | 冷启 Lead-pane readiness 检查 | restart |
| `FLYWHEEL_XHS_REVIEW` | `plugin.ts:967` | feature | OFF（opt-in） | 小红书 review localhost 路由 | restart |
| `FLYWHEEL_ALERT_THREADS` | `plugin.ts:3042` | feature | OFF（opt-in） | 统一 alert 分线程 | restart |
| `FLYWHEEL_AUTO_REPAIR` | `plugin.ts:3043` | feature | OFF（opt-in） | 死 agent 自修 | restart |
| `FLYWHEEL_BRIDGE_WATCHDOG` | `bridge/BridgeEventLoopWatchdog.ts:179` | feature | ON | Bridge event-loop watchdog | restart |
| `FLYWHEEL_HEARTBEAT_READOPT` | `HeartbeatService.ts:347` | feature | ON | session 心跳 re-adopt | restart |
| `FLYWHEEL_LIVENESS_PANE_DEAD` | `HeartbeatService.ts:662` | feature | ON | pane-dead liveness | restart |
| `FLYWHEEL_QUIET_PERSIST_DEDUP` | `HeartbeatService.ts:791`;`RunnerIdleWatchdog.ts:292` | feature | ON | quiet-persist 去重 | restart |
| `FLYWHEEL_FOUNDER_THREAD_NOTIFY` | `gate-poller.ts:1177` | feature | ON | gate 上 founder thread 通知 | restart |
| `FLYWHEEL_FOUNDER_REPLY_DELIVER` | `gate-poller.ts:1313` | feature | ON | founder 回复回投 runner | restart |
| `FLYWHEEL_GATEPOLLER_CIRCUIT` | `gate-poller.ts:573` | feature | ON | GatePoller 熔断 | restart |
| `FLYWHEEL_WORKTREE_AUTOCLEAN` | `bridge/worktree-cleanup.ts:44` | feature | ON | run 后自动清 worktree | restart |
| `FLYWHEEL_LEAD_PENDING_ESCALATION` | `bridge/lead-pending-escalation.ts:145` | feature | ON | lead-pending 升级功能 | restart |
| `FLYWHEEL_REPORTS_TTL_DAYS` | `plugin.ts:2117` | feature（值型） | 7d | 报告链接保留期 | restart |

非 `FLYWHEEL_` 前缀但同类：`CYRUS_WEBHOOK_DEBUG`(`EdgeWorker.ts`,OFF)、`TEAMLEAD_CHAT_THREADS_ENABLED`/`TEAMLEAD_REPLY_BY_ISSUE_ENABLED`/`TEAMLEAD_REPLY_GUARD_ENABLED`(`teamlead/config.ts`,OFF)、`TEAMLEAD_OWNS_SLACK`(`lib/setup.ts`,OFF)。

**排除**（plumbing/context 值，非 on/off 门，不进注册表）：`FLYWHEEL_EXEC_ID`/`FLYWHEEL_BRIDGE_URL`/`FLYWHEEL_COMM_DB`/`FLYWHEEL_PROJECT_NAME`/`FLYWHEEL_INGEST_TOKEN`/`FLYWHEEL_CLAIMS_DB`/`FLYWHEEL_GATE_MARKER_DIR`/`FLYWHEEL_RUNNER_BACKEND_ID`/`FLYWHEEL_COMM_BACKEND`/`FLYWHEEL_MEMORY_MODEL` 等。

### 1.2 项目 config keys（住所 B，`<project>/.flywheel/config.yaml`）

解析 `packages/config/src/ConfigLoader.ts`，类型 `packages/config/src/types.ts`。

| key | file:line（validate） | 默认 | 本仓值 | 控什么 | category |
|---|---|---|---|---|---|
| `qa.auto` | `ConfigLoader.ts:349`;`types.ts:213` | OFF | `true` | code-review 后 spawn 独立 QA runner | feature |
| `qa.skip_labels` | `ConfigLoader.ts:359` | `[]` | `[docs,chore]` | 跳过 auto-QA 的 label | feature（值型） |
| `doc_flow.enabled` | `ConfigLoader.ts:316`;inject `edge-worker/Blueprint.ts:863` | OFF | `true` | DOC-FLOW 提示词块 | feature |
| `doc_flow.default_department` | `ConfigLoader.ts:330` | 必填(enabled 时) | `engineering` | doc 落点部门 | feature（值型） |
| `xiaohongshu_learning.enabled` | `ConfigLoader.ts:423` | OFF | 无 | 定期小红书学习 | feature |
| `founder_ux_gate.mode` | `ConfigLoader.ts:379`;`types.ts:241`(默认 `off`) | `off` | 无 | founder-facing UX brainstorm 门 | **governance_gate** |
| `ponytail.enabled` | `ConfigLoader.ts:403`;`types.ts:497` | OFF | 无（Annie-exception） | 代码极简 ponytail 逐项目 rollout | feature（例外默认 OFF） |
| `skills.proofshot.enabled` | `ConfigLoader.ts:112`;`types.ts:101`(默认 false) | OFF | 无 | ProofShot 视觉验证 auto-trigger | feature |
| `skills.enabled` | `types.ts:76`(默认 true) | ON | 无 | skill 注入 | feature |
| `checkpoints.<name>.enabled` | `ConfigLoader.ts:190`;`types.ts:159` | OFF | brainstorm/question/approve_to_ship=true | 人-in-loop 门 | **governance_gate** |
| `decision_layer.autonomy_level` | `ConfigLoader.ts:91` | — | `advisor` | 决策层自治级 | **governance_gate** |
| `roles.<role>.{backend,model,effort}` | `ConfigLoader.ts:249`;`types.ts:436` | 无(=claude-tmux) | 无 | per-role executor 覆盖 | feature（值型） |

### 1.3 治理门（住所 A/B 混，**硬豁免、只读**）

- **founder_consent / `DECISION_MODE`**：`bridge/founder-consent/config.ts`（`resolveDecisionMode` :111，全解析 :139）。`off`=Track-2 evaluator 不构造（byte-compat）；`audit_only`=评估+审计不 block；`enforce`=block。伴随必填 `FLYWHEEL_FOUNDER_USER_ID`（mode≠off 时 fail-fast）+ 一堆 env tunable（threshold 0.85、window 24h、fail_mode closed、LLM haiku…）。pre-ship 权威 = `flywheel-comm/verify-approval.ts:41`（要 `DECISION_MODE=enforce`）。
- **founder_ux_gate**（`config.yaml` `founder_ux_gate.mode`，默认 off，`types.ts:250`）。
- **founder-only-authority**（policy in `config.yaml` decision_layer 注释，FLY-175）。
- **`FLYWHEEL_COMM_BYPASS_BRIDGE`**（应急 override）。

### 1.4 TS code 硬默认

- **ponytail**：纯 ladder `packages/config/src/ponytail.ts:89`（per-run flag > 每-issue Linear label > 每-项目 config > **默认 off** :141）；常量 `PONYTAIL_PLUGIN="ponytail@ponytail"` :28；支持 backend 集 `edge-worker/Blueprint.ts:112`（只 claude-tmux/codex-tmux 消费）；readiness 探针 `Blueprint.ts:129`。本仓无 `ponytail` config key → 项目层 OFF（Annie-exception，dogfood A/B）。
- ProofShot `enabled` 默认 false `types.ts:101`。
- doc_flow / founder_ux_gate / checkpoints「absent=off」默认（`types.ts`）。
- run-infra.ts `:529`/`:488` 的 no-op 是**优雅降级**，非 flag。

---

## 2. FLY-247 Fleet Console 现状（② dashboard 复用基座）

全部在 `packages/teamlead/`。`FLYWHEEL_FLEET_CONSOLE !== "0" && !FLYWHEEL_PROJECTS` 开（`plugin.ts:2280`），否则回退旧 dashboard（byte-compat）。

### 2.1 路由（`plugin.ts`，全 loopback + same-origin，**无 Bearer**，挂在 `/api` Bearer 中间件之前）
- `GET  /`（`plugin.ts:706`）→ `getFleetConsoleHtml()`（否则 `getDashboardHtml()`）。
- `GET  /api/fleet/snapshot`（`plugin.ts:856`）→ `fleetConsole.buildSnapshot()`。
- `GET  /api/fleet/progress`（`plugin.ts:871`，SSE，1s poll 日志）。
- `POST /api/fleet/stage`（`plugin.ts:930`）→ `handleStage`。
- `POST /api/fleet/apply`（`plugin.ts:946`）→ `handleApply`。

### 2.2 处理逻辑（`bridge/fleet-routes.ts`，dep-injected 可单测）
- `handleStage`（:74）：`isSameOrigin` → `buildCanonicalRequest` → **授权门**（`allowedTargets`，:103；FLY-671 effort 门 :134）→ fail-closed audit `staged` → 发 `confirmToken`。
- `handleApply`（:190）：`isSameOrigin` → `verifyAndConsume`(SHA 绑定，replay→append-only `denied`+401) → audit `apply-requested` → `createLaunching` 日志 → `spawnEngine` → `202 {batchId}`。

### 2.3 鉴权原语（`bridge/loopback-origin.ts` + `bridge/fleet-admin.ts`）
- `loopbackSelfOrigin(host)`（anti-DNS-rebind，:19）；`isSameOrigin(headers,origin)`（anti-CSRF，:33）。
- `ConfirmTokenStore`（`fleet-admin.ts:143`）：`issue(sha)` `randomBytes(32)` 60s TTL；`verifyAndConsume` 先删再校验（replay 必失败）。
- DTO：`ConsoleChange`(稀疏 :26)/`CanonicalChange`+`CanonicalRequest`(:42)/`buildCanonicalRequest`(:77)/`canonicalRequestSha`(:118)；`ConsoleLeadView`/`ConsoleSnapshot`(`fleet-console-model.ts:28`，secret-free allowlist，`FORBIDDEN_DTO_KEYS=[botToken,botTokenEnv,match]` :134)。

### 2.4 UI（`bridge/fleet-console-html.ts`，单 template-literal 字符串）
- `getFleetConsoleHtml()`（:21-443）。card-per-Lead `render()`（:227）；backend chip(:191)/level-model chip(:199)/effort chip(:213)；event-delegation 开菜单(:254)+选(:282)；stage→apply `runApply()`(:340)；SSE `watchProgress()`(:377)；`reload()`(:422)。
- **注意**：内嵌 `<script>` 故意用字符串拼接（不用 `${}`/模板字面量），因为它嵌在外层 TS 模板字面量里 —— 加 flag chip 要照此。

### 2.5 apply 引擎（`scripts/flywheel-fleet.sh` + 3 个 lib）
- Bridge `spawnEngine`（`bridge/fleet-console.ts:347`）detached 进程组跑 `bash flywheel-fleet.sh apply --changes-file <cf> --yes`。
- `fleet_batch_apply`（`scripts/flywheel-fleet-batch.sh:277`）：env-pin reject → **owner-claim 先，fail-closed** → **baseline 授权/TOCTOU 门**（flock，whole-config SHA==expected 且每 key 现值==reviewed from）→ **CAS launching→running** → per-key（write-ahead → **锁下原子写 projects.json**：same-dir temp+jq 校验+rename，保模式 → cutover=inc1 单 key `apply --lead <key>` → 失败**锁下条件回滚**）→ 终态归约。
- 写目标 = **`~/.flywheel/projects.json`**（env override `FLYWHEEL_PROJECTS`）。config→plist tail：manifest(model/effort/backendId)→plist env `FLYWHEEL_LEAD_MODEL`（`flywheel-fleet.sh:265`）。

### 2.6 能力规则 + 审计 + poller
- **能力规则**（哪些 tier/effort 可切）：`bridge/fleet-capabilities.ts`（`CLAUDE_TIER_OPTIONS:57`/`CODEX_TIER_OPTIONS:66`/`EFFORT_OPTIONS:75`/`computeAllowedModelTargets:141`/`computeLeadCapabilities:199`）。**UI 不硬编码资格，逐字渲染 server 能力位** —— FLY-709 flag chip 扩这里。
- **审计**：`bridge/fleet-admin-audit.ts`（`fleet_admin_audit` 表，`UNIQUE(batch_id,event,attempt_id)`，events `staged|apply-requested|apply-result|denied`，better-sqlite3 WAL，默认 `~/.flywheel/audit.db`）。
- **poller**：`FleetPoller` 30s 证据收集（`fleet-data.ts:641`，喂 online dot）；`/api/fleet/progress` 1s SSE poll 日志；boot + 30s reconcile 中断批次。

### 2.7 Fleet 拓扑单一真相源
- `~/.flywheel/projects.json`（`FLYWHEEL_PROJECTS` override）。`LeadConfig`（`ProjectConfig.ts:7`）字段 `model?`/`backend?`/`effort?`/`companion`/`codexProfile`/`canSpawnRunners`。`loadProjects()`(:212)→`parseAndValidateProjects()`(:282)。Bridge 读 hot-overlay `ConfigSnapshotProvider`（`fleet-data.ts:533`），console `liveProjects:()=>fleetConfigProvider.snapshot().projects`（`plugin.ts:2293`），model/effort 从文件 fresh 读（`fleet-console.ts:168/195`，`configSha` :153）。

---

## 3. 两种 hosted HTML 模型（决定 dashboard 形态的硬约束）

### 3.1 远程报告管线（FLY-203，`bridge/reports-route.ts` + `flywheel-comm/.../publish-report.ts`）
- `POST /api/reports/publish {projectName,html,title?}` → stage→Vercel deploy→commit→`{url,reportId}`（:191，promise-chain mutex）。`POST /api/reports/deliver` → 一条 Discord 消息（截图+链接）（:292）。
- 托管：`report-registry.ts` `r/<128-bit-token>/index.html`（token=`randomHex(16)` :177），每次 publish 重部署全保留集，7d/100/10MB retention。**noindex + CSP 注入**：`CSP_META = default-src 'none'; style-src 'unsafe-inline'; img-src data:`（:48）；opt-in 交互报告用 `<script nonce="__CSP_NONCE__">` + 每报告 nonce。无 `<head>` → 400。
- CLI `flywheel-comm publish-report`：publish→ProofShot 截图（降级 full-page 2x→1x→link-only）→deliver。Bearer=`TEAMLEAD_API_TOKEN`。
- skill `founder-html-delivery`（base rule `lead-rules-base/founder-html-delivery.md`：**绝不发本地路径/裸 HTML 给 founder**，走 skill 包 `publish-report`）。SKILL.md 由 flywheel-skills 库运行时注入（非本仓物理文件）。
- env `FLYWHEEL_REMOTE_REPORTS`（双侧 kill）。

### 3.2 硬约束（关键）
> **远程 Vercel 报告拿的是 `default-src 'none'` 严格 CSP，无法回调 Bridge `/api/*` toggle 端点（跨域 + CSP 双封）。带 live toggle 的交互控件必须从 localhost loopback 面服务（Fleet Console 式）；远程托管页只能是静态/自包含产物。**

---

## 4. Bridge HTTP 结构 + 加端点/加页的 pattern（`bridge/plugin.ts` 单 Express app）
- `createBridgeApp(...)`（:624）`express()`+`express.json({limit:"512kb"})`；`startBridge(...)`（:2159）→`app.listen`（:2613）。
- 每功能一个 `create*Router()` 工厂（`reports-route.ts`/`runs-route.ts`/…），认证挂载 `app.use("/api/<n>", tokenAuthMiddleware(config.apiToken), create<N>Router(...))`。
- **顺序**：loopback/browser 面挂在**广义 `/api` Bearer 中间件（:1025）之前**（fleet :838、xhs :967、founder-UX :823）。catch-all 404(:2137)+JSON error handler(:2142) 必须最后。
- 鉴权 3 式：**Bearer**（`tokenAuthMiddleware` :427，unset→no-op，`safeCompare` timingSafeEqual）；**reserved**（token unset 时挂「永 503」handler，如 `/api/reports` :2122）；**loopback+same-origin+confirmToken**（browser 面，页里无 token）；+ **founder-consent 中间件**（`founder-consent/wiring.ts`，`decisionMode==="off"`→no-op，否则真门，`plugin.ts:662` helper，用于 action_router/close_tmux/close_runner）。
- state：`BridgeConfig`(`bridge/types.ts:11`)；`StateStore`(SQLite)；late-bound holder 对象（`{current:…}`）给 pre-listen router 够到 post-listen 单例；fleet 拓扑 `fleetConfigProvider.snapshot()`。

### 4.1 给 FLY-709 的复用配方
- **可见 + 可控（localhost 交互）** → 照 Fleet Console：挂在 `/api` Bearer 之前、每 handler `loopbackSelfOrigin` 守卫、两步 stage→confirmToken→apply、复用 `ConfirmTokenStore`/`isSameOrigin`；页里 `fetch("/api/x/stage")`→`fetch("/api/x/apply")`（`fleet-console-html.ts:340` 式）。
- **远程手机只读** → 生成完整 HTML（有 `<head>`）交 `flywheel-comm publish-report`/`founder-html-delivery` skill，自动拿 128-bit token URL + noindex/CSP。**只读，无 toggle。**

---

## 5. FLY-709 的扩展缝（自然接法）

1. **注册表**：新建 `packages/config/src/feature-flags/`（或 `teamlead` 侧）—— `FeatureFlagSpec[]` 声明 + `resolveFlag(name, {env, projectConfig})` resolver（内部逐 flag 复用**现有逐字解析逻辑**，byte-compat）+ CI 校验「登记∧代码读」一致。
2. **可见**：`fleet-console-model.ts` snapshot 加 `featureFlags: FlagView[]`（读注册表 resolver）→ `fleet-console-html.ts` 新增 Feature Flags 区（按 category 分组，只读徽章 + 生效路径）。
3. **可控（安全子集）**：仿 FLY-671 给 `model` 加 `effort` 的方式，给 flag toggle 扩 `ConsoleChange`/`CanonicalChange`（`fleet-admin.ts`）+ stage 授权门（`fleet-routes.ts`，只放行 `toggleable:"direct"` 的 flag）+ 写引擎（**新写目标**：`.env`/`config.yaml`，不是 `projects.json` —— 见 exploration §2.1，需新引擎逻辑或新 route，design 时定）。
4. **治理门**：注册表标 `governance_gate` → UI 永远只读、无 toggle 控件（`default-enable-policy.md` 硬豁免）。

---

## 6. 给 plan.md 的开放技术问题（Codex design review 复核）
- 注册表放 `packages/config`（和 types/ConfigLoader 同仓、跨包可复用）还是 `teamlead`（Bridge 侧，离 console 近）？
- flag toggle 的写引擎：扩 `flywheel-fleet.sh`（但它是 projects.json 专用）还是新建 `.env`/`config.yaml` 写路径？两个写目标要不要各自事务/审计？
- 「需重启」flag 的 toggle：v1 是「写 .env + 标注需重启 + 不自动重启」还是「不给 web-toggle、走对话式」？
- byte-compat 的 resolver 校验：怎么测「resolver(flag) === 原地逐字表达式」（对每个迁移点做 golden/parity 测试）。
