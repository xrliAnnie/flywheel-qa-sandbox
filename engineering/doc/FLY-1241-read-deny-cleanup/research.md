# FLY-1241 read-deny + content-coordination 删除 — 调研(编辑点清单)

Issue: FLY-1241 (https://linear.app/geoforge3d/issue/FLY-1241/flag-cleanup-delete-codex-lead-read-deny-flag-read-deny-profilets-code)
日期: 2026-07-14
基于: exploration.md

Tadashi 拍板 **Option A**:read-deny + content-coordination profile 一起删。保留共享 lead-actions
MCP 基建(full-access 在用)。

> **权威来源**:实施的**完整**编辑点 + 原子步骤 + 测试改动 + 验证命令以 **`plan.md` Steps 1-7 为准**
> (经 Codex design review R1×8 + R2×6 + R3 收敛)。本 research 是面上的勘察;两者冲突时 plan.md 胜。

## 生产 dormancy 复核(删除安全的前提 —— Codex R1 #6 纠正后的准确事实)

- `~/.flywheel/projects.json` 实况(双证据):
  - `growth/mufasa-lead` = `backend=codex-app-server, companion=true, codexProfile 未设`;full-access 姿态由
    **launcher pin**(live LaunchAgent 跑 `flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh`),不是 projects.json。
  - `flywheel/codex-infra-bot-lead` = `codexProfile=full-access`(显式)—— 另一条现役 full-access windowed 消费者。
  - **无任何** content-coordination / read-deny 配置 → 删除安全。
- read-deny flag opt-in、default false、生产从未启用。
- **两个现役 full-access windowed(TUI)Lead**:Mufasa + Codex Infra Bot。删 `run-codex-lead-mufasa-tui.sh`
  的 content-coordination 分支不影响现役 Mufasa(它走 fullaccess wrapper,Tadashi 注意①,已确认)。
- **full-access lead-actions MCP 注入路径矩阵**(Codex R1 #2 纠正):
  - **windowed(生产)** → shell `codex-lead-tui-home.sh::append_full_access_lead_actions_mcp` 写 config.toml
    + TUI runtime full-access §10 gate 校验。**必须保留**。
  - **headless**(保留能力,非生产形态)→ runtime argv(`fullAccessLeadActionsMcpConfig`)。
  - content-coordination 走的是 **另一套** broker-mode(`append_lead_actions_mcp` + `buildLeadActionsMcpServerConfig`
    + `assertLeadActionsConfigGate` + SecretBroker),删除它不碰 full-access 的两条注入路径。
- content-coordination 在 TS runtime 不止两条 guard:**TUI runtime 还有完整 broker/secret-wash/config-gate 生命周期**
  (buildTuiDaemonEnv 分支 / main broker listen / shutdown close),见 plan.md Step 2。

## A. TS 源码

### A1. `packages/teamlead/src/lead-backends/codex/read-deny-profile.ts` — **删整个文件**

### A2. `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts`
- import(55-57):删 `isReadDenyEnabled, resolveReadDenyThread`。
- `CODEX_LEAD_PROFILES`(200-206):删 `"content-coordination"`。`CodexLeadProfile` type 随之收窄。
- `CodexLeadRuntimeConfig.readDeny`(125-130):删字段。
- read-deny 解析 + guard(653-662):删 `readDeny = isReadDenyEnabled(env)` + read-deny×sandbox throw。
- content-coordination 分支(675-680):删 `content-coordination requires read-only` guard(enum 已去)。
- content-coordination×read-deny guard(715-723):删。
- config 对象(827):删 `readDeny,`。
- `buildThreadParams`(983-1002):删 `readDeny?` 参数;`if (!(config.readDeny && sandboxMode==="read-only"))`
  → 直接 `params.sandbox = config.sandboxMode`(非-read-deny 字节兼容行为)。
- ensureThread(1564-1574):删 `if (config.readDeny) { resolveReadDenyThread }` 块 → fall-through 到
  legacy `if (saved) resumeThread else startThread`(即现有非-read-deny 行为)。
- 启动日志(1809):删 `read-deny : ...` 行。
- ⚠️ 复核:删 content-coordination 后,`sandbox=workspace-write requires write-capable|full-access` guard
  (706-714)、write-capable / full-access guard 全部保留不动。

### A3. `packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts`(**含完整 content-coordination lifecycle**)
- import:删 `resolveReadDenyThread`、`assertLeadActionsConfigGate`、`buildLeadActionsMcpServerConfig`、此文件不再用的
  `SecretBroker`/`washActionSecretEnv`。
- `buildFullAccessEnv` 的 `FLYWHEEL_CODEX_LEAD_READ_DENY: "0"` pin(150):删。
- `buildTuiDaemonEnv()` content-coordination secret-wash 分支(~135-137):删。
- `main()` content-coordination broker 判定/socket/config-gate/listen(~834-892):删。
- shutdown/startup-failure broker close(~978-1003):删。
- ensureThread(510-523):删 read-deny 块 → fall-through legacy;`readDeny: config.readDeny`(698):删。
- TUI 支持范围错误消息 + config-gate 注释泛化。**保留** full-access §10 gate(~901-949)+ `assertFullAccess*`
  / `buildFullAccessLeadActionsMcpServerConfig` / `buildFullAccessEnv` + full-access daemon env/pin。

### A4. `packages/teamlead/src/lead-backends/codex/tui-window.ts`
- `TuiWindowSpec.readDeny?`(41-45):删字段。
- `buildTuiCommand` 三元(94-98):`fullAccess ? ["-s workspace-write"] : readDeny ? [] : ["-s read-only"]`
  → `fullAccess ? ["-s workspace-write"] : ["-s read-only"]`。注释去 read-deny 措辞。

### A5. `packages/teamlead/src/lead-backends/codex/lead-actions/mcp-config.ts`(**broker-mode 死代码删除**)
- **删** broker-mode `buildLeadActionsMcpServerConfig` + `assertLeadActionsConfigGate`;删后 `rg` 无 caller 再删
  `toMcpServerToml`/`LeadActionsMcpServerConfig`/`BuildLeadActionsMcpOptions`/`assertLeadActionsInventory`/
  `InventoryMismatchError`(均 0 非测试 caller)。
- **保留** full-access「must NOT set default_permissions」断言(356-361)+ `assertFullAccessSandboxConfig` /
  `buildFullAccessLeadActionsMcpServerConfig` / `assertFullAccessLeadActionsConfigGate`,仅注释去 read-deny 措辞。

### A6. `packages/teamlead/src/lead-backends/codex/lead-actions/{lead-actions-main.ts,config.ts}`(**env-token-only 化**)
- `config.ts`:删 `mode:"broker"|"env-token"` + `brokerSocketPath` + `FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET` 解析(恒 env-token)。
- `lead-actions-main.ts`:删 `fetchSecretsFromBroker` import + `mode==="broker"` 分支 → 恒读 `DISCORD_BOT_TOKEN`(fail-closed)。
- 注释去 read-deny/broker 措辞。**保留** `secret-broker.ts`(write-capable gateway `gateway-main.ts:496` 在用)。

### A7. `packages/teamlead/src/lead-backends/codex/{discord-send-core.ts,lead-actions/alias-allowlist.ts}`
- 注释提及 content-coordination → 更新为「lead-actions MCP(full-access 在用)」中性措辞。

### A8. `packages/teamlead/src/ProjectConfig.ts`
- `codexProfile` type union(154-158):删 `"content-coordination"`。
- 注释(126-142):删 content-coordination 那条说明。
- enum 校验(712-724):删 `content-coordination` 分支 + 错误消息里的它。
- cross-field 校验错误消息(739):去 `content-coordination`。

### A9. `packages/config/src/feature-flags/registry.ts`
- `codex_lead_read_deny` flag entry(1865-1884):**删**。

## B. Shell 脚本

### B1. `packages/teamlead/scripts/codex-lead-tui-home.sh`
- `write_read_deny_config()`(read-deny config 写入函数,~95-187):**删**。
- `append_lead_actions_mcp()`(189-247,content-coordination-only,gate `= "content-coordination"`):**删**。
  ⚠️ 只删这个 —— **windowed(生产)full-access 保留另一个同名近似函数 `append_full_access_lead_actions_mcp`
  (~338-389)+ `write_full_access_config`(~254),ensure_home 430-431 调它们写 config.toml**(生产 Mufasa/InfraBot
  的 lead-actions MCP 靠它);headless full-access 才走 runtime argv。删错切断现役 discord_send。
- ensure_home 主流程里对 read-deny / content-coordination 的分派调用(439-440 调 write_read_deny_config /
  append_lead_actions_mcp 的位点):删;companion + full-access(430-431)路径保留。
- `ensure_daemon` 的 read-deny stop-before-start 注释(539-543):full-access 也需 stop-before-start
  (pin ⑤,line 544)→ 保留逻辑,注释去 read-deny 措辞。
- 复核:确保删后 companion / full-access 两条 config 写入路径完整(write_full_access_config 不动)。

### B2. `packages/teamlead/scripts/templates/codex-read-deny-profile.toml` — **删**

### B3. `packages/teamlead/scripts/run-codex-lead-mufasa-tui.sh`
- codexProfile 派生分支(119-159,只认 content-coordination):**删**。
- persona-contract 选择(166-177):删 content-coordination 分支 → 恒用 companion contract。
- lead-actions 坐标 + `FLYWHEEL_CODEX_LEAD_READ_DENY=1` export 块(180-193+):**删**。
- 复核:删后此脚本 = 纯 companion TUI launcher(rollback 用),Mufasa 现役走 fullaccess wrapper 不受影响。

### B4. `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh`
- read-deny 引用(4 处,多为「full-access 不带 read-deny」的说明/pin):删 read-deny export/断言,保留
  full-access 语义。

### B5. `packages/teamlead/scripts/run-codex-infra-bot-tui.sh` / `scripts/package-onboard.sh`
- 单处 read-deny 引用(注释 / 打包清单):更新或删。

## C. 契约文档

### C1. `packages/teamlead/lead-rules-base/content-coordination-contract.md`(44 行)— **删**
- PR 描述注明「由 AI-agnostic 全权限决策取代」留审计线索(Tadashi 注意②)。
- 复核:`codex-lead.sh` 若有加载 content-coordination-contract.md 的分支 → 一并删。

## D. 测试(删 / 改)

- **删**:`__tests__/read-deny-profile.test.ts`、`scripts/__tests__/fly260-read-deny-enforcement.test.sh`、
  `scripts/__tests__/fly260-read-deny-appserver-probe.mjs`。
- **改**(去 read-deny / content-coordination 断言,保留其余;broker 用例整删):`__tests__/codex-lead-runtime.test.ts`、
  `__tests__/tui-window.test.ts`、`__tests__/codex-lead-tui-runtime.test.ts`、`lead-actions/__tests__/mcp-config.test.ts`、
  `lead-actions/__tests__/{config.test.ts,token-resolve.test.ts}`(删 broker 用例)、
  `scripts/__tests__/codex-lead-tui-home.test.sh`、`scripts/__tests__/run-codex-lead-mufasa-tui.test.sh`(+ hostile ambient
  用例)、`scripts/__tests__/run-codex-lead-mufasa-tui-fullaccess.test.sh`、`src/__tests__/fleet-capabilities.test.ts`
  (去 content-coordination fixture)、`ProjectConfig` 校验用例。
- **重写**:`lead-actions/__tests__/lead-actions-integration.test.ts` broker-spawn → **env-token real-spawn**(唯一真 spawn
  child 的测试,不可删)。
- **新增**:`scripts/__tests__/run-codex-infra-bot-tui.test.sh`(第二个生产 full-access launcher 回归);
  sentinel `__tests__/read-deny-removed.sentinel.test.ts`(git-tracked scope + broker 死符号 + JSDoc 跨行 + 自测 fixture)。
- **保留**:companion/full-access/write-capable 的 sandbox pin 正向断言(证明去 read-deny 后 buildThreadParams 恒 pin sandbox)。
- 详见 plan.md Steps 1/3/6/7。

## 不动(历史存档)

`doc/engineer/plan/{new,archive,inprogress}/*`(FLY-260/350/398 计划)、`qa-fly310/*`、
`product/doc/FLY-1091-*/audit.md`、`.claude/skills/*`(本 issue 注入 context)、`doc/qa/*` = 历史,不改写。

## 风险 & 复核清单

1. **enum 收窄 byte-compat**:`CodexLeadProfile` / `ProjectConfig.codexProfile` 去掉 content-coordination 后,
   任何持久 config/test fixture 带 content-coordination 会 fail-loud —— 生产无(projects.json = full-access)。
2. **buildThreadParams**:去 read-deny 后恒 `params.sandbox = sandboxMode` = 非-read-deny 现状,full-access
   /companion/write-capable 字节兼容。
3. **shell 幂等**:删 `append_lead_actions_mcp`(content-coordination)后,config.toml 不再有 content-coordination
   的 MCP append。full-access 的 lead-actions MCP:**windowed(生产)由 shell `append_full_access_lead_actions_mcp`
   写 config.toml(保留)**;headless 才由 runtime argv 提供。删 content-coordination 不碰这两条。
4. **lead-actions child broker mode = content-coordination 独占死代码**(Codex R2 #1):`config.ts` 的
   `mode:"broker"` 仅当 `FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET` 存在时启用,而该 socket **只由 content-coordination
   shell(`append_lead_actions_mcp`)设**;full-access 不设 → 恒 env-token。删 content-coordination 后 broker mode
   无 caller → 把 lead-actions child 改成 **env-token-only**(删 `config.ts` 的 mode/broker socket、
   `lead-actions-main.ts` 的 `fetchSecretsFromBroker` 分支、`mcp-config.ts` 的 broker builder/gate + 删后无 caller 的
   `toMcpServerToml`/`LeadActionsMcpServerConfig`/`BuildLeadActionsMcpOptions`/`assertLeadActionsInventory`/`InventoryMismatchError`)。
   **保留** `secret-broker.ts` + `fetchSecretsFromBroker`(write-capable gateway `gateway-main.ts:496` 在用)。
4. **daemon stop-before-start**:read-deny 与 full-access 共用此逻辑(pin ⑤),删 read-deny 措辞不删逻辑。
5. **grep-zero sentinel**:实现末尾全仓 grep 确认 `FLYWHEEL_CODEX_LEAD_READ_DENY` / `read-deny-profile` /
   runtime `readDeny` / `content-coordination` profile 在 **产品源码 + 脚本 + 契约** 里清零(历史 doc 除外)。
