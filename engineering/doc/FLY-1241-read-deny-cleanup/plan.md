# FLY-1241 read-deny + content-coordination 删除 — 实施计划(Codex design APPROVED R4)

Issue: FLY-1241 (https://linear.app/geoforge3d/issue/FLY-1241/flag-cleanup-delete-codex-lead-read-deny-flag-read-deny-profilets-code)
日期: 2026-07-14
基于: research.md · Codex design review R1(8 条)+ R2(6 条)全部采纳

## 目标 & 边界

删净 read-deny(flag `FLYWHEEL_CODEX_LEAD_READ_DENY` + `read-deny-profile.ts` + 全部 plumbing + template + 测试 +
registry entry)**和** content-coordination profile 的**全部**独占 plumbing(enum 值 + runtime guard + TUI broker/
config-gate 生命周期 + **lead-actions child 的 broker mode** + 契约 md + shell 分支 + 打包/fleet 残留)。
**字节兼容** full-access / companion / write-capable Lead。lead-actions child 变为 **env-token-only**(full-access)。

## 🔒 生产现役路径(删除必须不碰 —— Codex R1 #2/#6)

- projects.json:`growth/mufasa-lead` = `companion=true, codexProfile 未设`(full-access 由 launcher pin,live
  LaunchAgent 跑 `flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh`);`flywheel/codex-infra-bot-lead` =
  `codexProfile=full-access`(显式)。**两个现役 full-access windowed(TUI)消费者**:Mufasa + Codex Infra Bot。
- **windowed(生产)full-access 的 lead-actions MCP 走 shell** `append_full_access_lead_actions_mcp` 写 config.toml
  + TUI full-access §10 gate 校验;**headless** 才走 runtime argv(`fullAccessLeadActionsMcpConfig`)。
- ⚠️ 命名陷阱:删 `append_lead_actions_mcp`/`write_read_deny_config`(content-coordination/read-deny),**保留**
  `append_full_access_lead_actions_mcp`/`write_full_access_config`(full-access,生产)。逐名核对。

## 🧭 KEEP / DELETE 边界(Codex R1 #8 + R2 #1:broker-only 死代码全删)

**KEEP:**
- `secret-broker.ts`(`SecretBroker`+`washActionSecretEnv`+`fetchSecretsFromBroker`)—— write-capable gateway
  (`gateway-main.ts:496`)+ codex-lead-runtime(`washActionSecretEnv` 1225)在用,**非 content-coordination 独占**。
- 全部 full-access 变体:`buildFullAccessEnv`、`assertFullAccessLeadActionsConfigGate`、`assertFullAccessSandboxConfig`、
  `buildFullAccessLeadActionsMcpServerConfig`、`fullAccessLeadActionsMcpConfig`、full-access `default_permissions` 禁止断言。
- shell `write_full_access_config`+`append_full_access_lead_actions_mcp`+其 ensure_home 调用 + full-access
  stop-before-start(pin ⑤)。
- lead-actions core 的 **env-token(full-access)** 路径:`runDiscordSend`、alias/rate/idempotency/audit、
  channel 解析。
- companion(read-only 无 read-deny)+ write-capable(Z gateway)两条现役路径。

**DELETE(content-coordination + read-deny 独占,删后无生产 caller):**
- `read-deny-profile.ts` 模块 + template + 测试。
- **TUI runtime content-coordination broker/secret-wash/config-gate 生命周期**(见 Step 2)。
- **lead-actions child broker mode**(Codex R2 #1):`config.ts` 的 `mode:"broker"|"env-token"` + `brokerSocketPath`
  解析(→ 恒 env-token,读 `DISCORD_BOT_TOKEN`);`lead-actions-main.ts` 的 `fetchSecretsFromBroker` import + broker
  token 分支;`mcp-config.ts` 的 `buildLeadActionsMcpServerConfig` + `assertLeadActionsConfigGate`,以及删后 `rg` 确认
  无 caller 的 `toMcpServerToml`/`LeadActionsMcpServerConfig`/`BuildLeadActionsMcpOptions`/`assertLeadActionsInventory`
  /`InventoryMismatchError`(实测均 0 非测试 caller)。
- shell `write_read_deny_config`+`append_lead_actions_mcp`+content-coordination/read-deny ensure_home 分派。
- `content-coordination-contract.md`、content-coordination enum 值 + guards、registry entry、read-deny plumbing。

## TDD 策略(删除型)

- **RED**:sentinel(Step 1)删除前 RED。
- **GREEN**:删除后 sentinel GREEN + 相关 vitest 文件在每个 checkpoint 绿 + 全套 test + typecheck + build +
  **shell 回归(bash 显式,Step 7)** + shellcheck 全过。
- **字节兼容正向断言**:`codex-lead-runtime.test.ts` 保留 companion/full-access/write-capable 的 sandbox pin 断言
  (证明去 read-deny 后 `buildThreadParams` 恒 `params.sandbox=sandboxMode`);`codex-lead-tui-runtime.test.ts` 保留
  full-access/companion case。
- **注意 typecheck 盲区(Codex R2 #2)**:`packages/teamlead/tsconfig.json` 排除 `**/*.test.ts` → `pnpm -w typecheck`
  **不**校验测试对已删符号的引用。故每个原子步必须**把配套测试改动放同一步**并跑对应 vitest 文件,不能靠 typecheck。

## 执行顺序(源码 + 配套测试同步的原子小步 —— Codex R1 #7 + R2 #2)

### Step 0 — 基线
- 记录真实 `git status`:`engineering/doc/FLY-1241-*` untracked(保留随 PR),其余 clean。基线 `pnpm -w typecheck` 绿。

### Step 1 — sentinel 守护网(RED)—— Codex R2 #6 + R3 #3
- 加 `packages/teamlead/src/lead-backends/codex/__tests__/read-deny-removed.sentinel.test.ts`:
  候选集 = `git ls-files -z` + `git ls-files --others --exclude-standard -z`(**NUL 分隔**),再过滤:
  只保留 roots `packages/**`、`scripts/**`、`packages/teamlead/lead-rules-base/**` 下、源/脚本/契约扩展名
  (`.ts/.js/.mjs/.sh/.toml/.md/.yaml/.yml/.json/.allow`——含 `package-onboard-files.allow`)、**且 `existsSync` 为真的常规文件**(跳过 index 里已删但未 commit
  的路径 → 不 ENOENT,Codex R3 #3)、显式跳过 `dist`/`node_modules`/coverage/binary;排除 sentinel 自身 +
  `doc/**`/`qa-fly310/**`/`.claude/**`。断言零命中(每文件归一化:去注释前导 `*` + 折叠空白/换行后再匹配):
  - read-deny:`FLYWHEEL_CODEX_LEAD_READ_DENY`、`codex_lead_read_deny`、`read-deny-profile`/`codex-read-deny-profile`、`readDeny`;
  - content-coordination:`contentCoordination`、`content-[\s*]*coordination`(覆盖 exact + JSDoc 跨行);
  - **broker-only 死符号(Codex R3 #3)**:`FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET`、`buildLeadActionsMcpServerConfig`、
    `assertLeadActionsConfigGate`、`toMcpServerToml`、`LeadActionsMcpServerConfig`、`BuildLeadActionsMcpOptions`、
    `assertLeadActionsInventory`、`InventoryMismatchError`。
  - 附 sentinel 自测 fixture(内嵌拆行 `content-\n * coordination` 字符串常量)证明归一化匹配能命中(避免假绿)。
  删除前 **RED**。

### Step 2 — 原子步 A:两 runtime + tui-window 消费面 + content lifecycle + 配套测试
- `codex-lead-runtime.ts`:去 read-deny import/字段/解析/guard;`CODEX_LEAD_PROFILES` 去 `content-coordination`;
  content-coordination 两条 guard;`buildThreadParams` readDeny 参数 + omit 分支→恒 `params.sandbox=sandboxMode`;
  ensureThread read-deny 块;启动日志行。**保留** write-capable/full-access guard + `fullAccessLeadActionsMcpConfig`
  + `washActionSecretEnv`(1225)。
- `codex-lead-tui-runtime.ts`:去 `resolveReadDenyThread`/`assertLeadActionsConfigGate`/`buildLeadActionsMcpServerConfig`
  import + **去此文件不再用的 `SecretBroker`/`washActionSecretEnv` import**(`noUnusedLocals` 会抓,清单显式列,Codex R3 #5);
  `buildTuiDaemonEnv` content-coordination secret-wash 分支;`main()` content-coordination broker 判定/socket/
  config-gate/listen(~834-892);shutdown/startup-failure broker close(~978-1003);`FLYWHEEL_CODEX_LEAD_READ_DENY:"0"`
  pin;ensureThread read-deny 块;`readDeny` spec 传递;TUI 支持范围错误消息 + config-gate 注释泛化。**保留** full-access
  §10 gate + `assertFullAccess*`/`buildFullAccessLeadActionsMcpServerConfig`/`buildFullAccessEnv` + full-access daemon env。
- `tui-window.ts`:去 `readDeny?` spec + `buildTuiCommand` 三元化简。
- **配套测试同步**:改 `codex-lead-runtime.test.ts`(去 read-deny 用例,保留 sandbox pin)、`codex-lead-tui-runtime.test.ts`
  (去 content-coordination case,保留 full-access/companion)、`tui-window.test.ts`(去 readDeny)。
- **checkpoint**:`pnpm -w typecheck` 绿(read-deny-profile 仍在盘但已无 import → 不 fail)+ 跑
  `pnpm -C packages/teamlead test codex-lead-runtime codex-lead-tui-runtime tui-window` 绿。

### Step 3 — 原子步 B:删 module/template + lead-actions broker mode 全删 + 外围 TS + 配套测试
- 删 `read-deny-profile.ts` + `__tests__/read-deny-profile.test.ts`。
- **lead-actions child → env-token-only**(Codex R2 #1):
  - `config.ts`:删 `mode`/`brokerSocketPath`/`FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET` 解析(恒 env-token);注释去 read-deny。
  - `lead-actions-main.ts`:删 `fetchSecretsFromBroker` import + `mode==="broker"` 分支 → 恒读 `DISCORD_BOT_TOKEN`(fail-closed)。
  - `mcp-config.ts`:删 `buildLeadActionsMcpServerConfig`+`assertLeadActionsConfigGate`;删后 `rg` 确认无 caller 再删
    `toMcpServerToml`/`LeadActionsMcpServerConfig`/`BuildLeadActionsMcpOptions`/`assertLeadActionsInventory`/
    `InventoryMismatchError`;**保留** `assertFullAccessSandboxConfig`/`buildFullAccessLeadActionsMcpServerConfig`/
    `assertFullAccessLeadActionsConfigGate` + full-access `default_permissions` 断言(注释去 read-deny)。
  - **配套测试**:删 `config.test.ts`/`token-resolve.test.ts` 的 broker 用例;**`lead-actions-integration.test.ts`
    必须重写为 env-token real-spawn(不可删——它是唯一真 spawn `lead-actions-main.js` over StdioClientTransport 的测试,
    Codex R3 #2)**:child env 传 `DISCORD_BOT_TOKEN`、保留 repeated-spawn + tool-inventory(恰 `discord_send`)覆盖、
    把 down-broker 负例换成 **missing/empty-token fail-closed** 负例、删所有 broker/socket fixture + import;改
    `mcp-config.test.ts` 去 broker gate 用例。
- `ProjectConfig.ts`:union 去 `content-coordination`;注释;校验分支;错误消息列全 `companion|write-capable|full-access`;
  **配套** ProjectConfig 校验测试同步。
- `registry.ts`:删 `codex_lead_read_deny` entry。
- `fleet-capabilities.ts`(去跨行 content-/coordination)+ **配套** `src/__tests__/fleet-capabilities.test.ts`(去
  `codexProfile:"content-coordination"` fixture)同步。
- `gateway/gateway-main.ts`、`scripts/codex-lead.sh`:profile 专有说明泛化(gateway 仍用 fetchSecretsFromBroker,不动逻辑)。
- **checkpoint**:`pnpm -w typecheck` 绿 + 跑 `pnpm -C packages/teamlead test lead-actions mcp-config ProjectConfig fleet-capabilities`
  + `pnpm -C packages/config test` 绿。

### Step 4 — Shell
- `codex-lead-tui-home.sh`:删 `write_read_deny_config`+`append_lead_actions_mcp`+ ensure_home read-deny 分派(439-440);
  **保留** `write_full_access_config`+`append_full_access_lead_actions_mcp`+ full-access 调用(430-431)+ full-access
  stop-before-start;去 read-deny 注释;**保留 FLY-694 modern-bash re-exec 覆盖**(删大段 heredoc 改字节布局,Codex R1 #3)。
- 删 `templates/codex-read-deny-profile.toml` + `scripts/package-onboard-files.allow` 中该条目(与 asset list 锁步,R1 #4)。
- `run-codex-lead-mufasa-tui.sh`:删 codexProfile 派生 + content-coordination persona/坐标/read-deny export 块 +
  **content-only deferred `ensure-daemon` 分支(~219-224,塌回 companion 正常路径,Codex R3 #5——此分支在本文件而非 home.sh)**
  → **纯 companion launcher,显式 pin `FLYWHEEL_CODEX_LEAD_PROFILE=companion` + read-only sandbox**(Codex R2 #5 / R3 #5:
  选定「pin companion」策略,不让 ambient full-access 混入;hostile ambient 测试断言最终发出的 tier = companion)。
- `run-codex-lead-mufasa-tui-fullaccess.sh`/`run-codex-infra-bot-tui.sh`/`scripts/package-onboard.sh`:去 read-deny 引用,
  保留 full-access 语义 + lead-actions 坐标不变。
- 改动 shell 全过 `bash -n`+`shellcheck`。

### Step 5 — 契约文档
- 删 `content-coordination-contract.md`。PR 描述注明「content-coordination 由 AI-agnostic 全权限决策取代」(审计线索,注意②)。

### Step 6 — 全局收尾(sentinel + 残留清扫 + Infra Bot 回归)
- 删 `scripts/__tests__/fly260-read-deny-enforcement.test.sh` + `fly260-read-deny-appserver-probe.mjs`。
- `codex-lead-tui-home.test.sh`/`run-codex-lead-mufasa-tui*.test.sh`:去 read-deny/content-coordination 断言;
  `run-codex-lead-mufasa-tui.test.sh` **加 hostile ambient-profile 用例**(设 ambient `FLYWHEEL_CODEX_LEAD_PROFILE=full-access`
  调 launcher,断言最终发出的 tier 仍 = companion,R2 #5 / R3 #5)。
- **新增 `packages/teamlead/scripts/__tests__/run-codex-infra-bot-tui.test.sh`(Codex R3 #1,确定文件)**:镜像 Mufasa
  full-access dry-run harness,对 `run-codex-infra-bot-tui.sh` 断言 profile=full-access / sandbox / mode、project root、
  lead-actions 坐标(token-by-name,非 broker)、governance bundle、**已删的 read-deny env pin 不再出现**。
- sentinel 转 **GREEN**。

### Step 7 — 全量验证(证据)

```
pnpm -w typecheck
pnpm -w build
pnpm -C packages/teamlead test        # vitest（sentinel + 字节兼容正向断言）
pnpm -C packages/config test
pnpm -w lint
# shell 回归（vitest 不收编 .test.sh，必须显式 bash —— Codex R1 #3 / R2 #3）:
bash packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
bash packages/teamlead/scripts/__tests__/run-codex-lead-mufasa-tui.test.sh
bash packages/teamlead/scripts/__tests__/run-codex-lead-mufasa-tui-fullaccess.test.sh
bash scripts/__tests__/package-onboard.test.sh                 # 若存在
bash scripts/__tests__/package-onboard-smoke.test.sh           # 若存在
bash scripts/__tests__/package-onboard-version-injection.test.sh     # 现有 CI 测试，改了 package-onboard.sh 必跑（R2 #3）
bash packages/teamlead/scripts/__tests__/run-codex-infra-bot-tui.test.sh  # 新增，第二个生产 full-access launcher（R3 #1）
# 改动 shell:bash -n + shellcheck
# grep-zero（sentinel 同 scope，零输出；含 broker-only 死符号 R3 #3）:
git grep -nE "FLYWHEEL_CODEX_LEAD_READ_DENY|read-deny-profile|codex_lead_read_deny|readDeny|content-coordination|contentCoordination|FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET|buildLeadActionsMcpServerConfig|assertLeadActionsConfigGate|toMcpServerToml|LeadActionsMcpServerConfig|BuildLeadActionsMcpOptions|assertLeadActionsInventory|InventoryMismatchError" \
  -- packages/ scripts/ ':!**/read-deny-removed.sentinel.test.ts' ':!doc/**' ':!qa-fly310/**' ':!.claude/**'
```

## 风险 & 缓解

| 风险 | 缓解 |
|------|------|
| 误删 full-access shell 函数切断现役 Mufasa/InfraBot | KEEP 清单锁死;逐名核对;Step 7 跑 Mufasa + **Infra Bot** launcher 测试 |
| 误删 SecretBroker/fetchSecretsFromBroker(gateway 在用) | KEEP;gateway-main.ts:496 有 caller,只删 lead-actions child broker 分支 |
| lead-actions broker mode 残留死代码/latent secret mode | Step 3 全删 broker mode + rg 死 export;grep-zero |
| test 引用已删符号但 typecheck 漏(tsconfig 排除 *.test.ts) | 配套测试与源删同步 + 每 checkpoint 跑对应 vitest |
| companion launcher 被 ambient full-access 污染 | 显式 pin companion+read-only 或 fail-loud;hostile ambient 用例 |
| enum 收窄致 fixture fail | fleet-capabilities.test.ts + ProjectConfig test 同步 |
| grep-zero 假绿(跨行/camelCase/dist) | sentinel 归一化跨行 + contentCoordination + git-tracked scope（跳 dist）+ 自测 fixture |

## 回滚
纯删除 PR;回滚 = revert commit。生产不依赖 read-deny/content-coordination,revert 零副作用。

## Ship 纪律
单独 codex code review(触及 codex-lead runtime + full-access 现役路径 + lead-actions child)。本段做到**开 PR +
code review**;ship 永远 founder-gate,不自 merge / 不自 :cool:。
