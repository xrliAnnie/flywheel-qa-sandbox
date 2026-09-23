# FLY-2762 Codex 号池按目录枚举 — 调研
Issue: FLY-2762 (https://linear.app/geoforge3d/issue/FLY-2762/codex-号池五号-flywheel-codex-profile-把号池写死为-schoolpersonalbusiness)
日期: 2026-09-22
基于: exploration.md

## 1. 「固定三号」消费者全清单(2026-09-22 全仓只读普查)

普查范围:`packages/`(排除 node_modules、dist)、`scripts/`、仓库内 `.claude/`。Claude 账号(shopping/business/personal/school 的 Claude 号)
那一族与本单无关，单列在 §1.4 排除。

### 1.1 生产代码(9 个文件，11 处)

| 位置 | 现状 | 依赖它的行为 |
|---|---|---|
| `claude-runner/bin/codex-account-core.mjs:19-20` | `PROFILE_NAMES` 常量 | 根白名单 |
| 同上 `:112,117,129,154,161` | `validateRegistry`:恰好 3 条、名字 ∈ 三号、primary 必须 personal | 注册表多一条 → 所有加载方抛错 |
| 同上 `:302-319` | `assertIdentityMatchesRegistry` | 非注册号的台账写入抛错(best-effort,只记日志) |
| `claude-runner/bin/codex-account-core.d.mts` | `type CodexProfileName = "school"\|"personal"\|"business"` | 类型已与运行时不符(FLY-2750 起会返回 `account-*`) |
| `claude-runner/bin/flywheel-codex-profile.mjs:68,202,316-325,411` | 帮助文案、`expectedProfile` 报错、`list` 的 Untracked、`next` 文案 | `use/save` 非三号直接失败 |
| `claude-runner/bin/codex-account-install.mjs:340` | `installCodexQuotaCredential` 名字白名单 | 自动切到第四个号 → `probe_failed` |
| 同上 `:489` | `persistCodexCandidateCredential` 名字白名单 | 恢复写回第四个号 → `identity_mismatch` |
| `claude-runner/agents/codex-account-registry.json` | 三条 + primary | 唯一号池来源(随 codex-guard 发版) |
| `claude-runner/src/codex-home.ts:737-751` | `discoverAccountPool` 按注册表过滤目录 | 只导出，无生产调用方 |
| `teamlead/src/codex-quota/candidate-selector.ts:24,79` | 候选池写死三号 | **其它号的观测被静默丢弃**;「全池打满」只按三号判 |
| `teamlead/src/codex-quota/switch-notification.ts:4,27` | 三号 Set | 其它号的切号卡片降级成 n/a |
| `teamlead/src/codex-quota/outbox.ts:242,250` | 三号字面量 | 源号显示 unknown、目标号显示 none |
| `teamlead/src/bridge/codex-quota-store.ts:283` | `reconcileExternalRoot` 三号校验 | canonical home 装着第四个号时抛 `invalid_quota_external_identity` |
| 同上 `:369` | `recordInstalling` 三号校验 | **凭据已装上之后**才抛 `invalid_quota_installation` |
| 同上 `:692` | `recordSwitchAudit` 三号校验 | 抛 `invalid_quota_audit` |
| `teamlead/src/codex-quota/reset-credit-selector.ts` | `CODEX_QUOTA_PROFILES`、`length !== 3` | **生产未接线**(只有测试导入) |
| `teamlead/src/bridge/account-quota-view.ts:24-28,687` | `MANUAL_CODEX` 三条手填兜底行 | 机器快照缺席时兜底页固定三行 |
| `scripts/codex-with-fallback.sh:187` | 提示文案 | 仅文案 |

### 1.2 已经是 N 号的部分(不用改逻辑)

- `teamlead/src/codex-quota/codex-accounts-observer.ts`(FLY-2688):`listCodexProfileSlots` 已按目录枚举。
- `codex-account-install.mjs` 的 `persistCodexProfileQuotaRefresh`:注释里已点名 FLY-2762,不带名字白名单。
- `teamlead/src/codex-quota/runtime.ts:134-138` 的 `observe()`:遍历 `registry.profiles`,所以**只要注册表对象变成现算的 N 号，它自动变 N 号**。

### 1.3 测试与夹具(需随改)

- `claude-runner/test/codex-account-identity.test.ts:75-86`「ships exactly school/personal/business」
- `claude-runner/test/codex-shim.test.ts:241-254`「list exposes only the canonical three」、`:303-306`
- `teamlead/src/codex-quota/__tests__/codex-quota-candidates.test.ts:42,66-80,83`(personal1 被当「退役号」排除)
- `teamlead/src/codex-quota/__tests__/reset-credit-selector.test.ts:530`
- `teamlead/src/bridge/__tests__/codex-quota-bench.test.ts:97`、`teamlead/src/__tests__/StateStore.codex-quota.test.ts:431`(类型联合)
- 另有 18 个测试/脚本文件以 v1 注册表 JSON 作夹具，需要改成 v2 策略文件 + 目录夹具。

issue 里点名的 `reports-route.test.ts:462 toHaveLength(3)` 与 `switch-executor.test.ts:1267` 经核实属于别的语义
(报告行数、Claude 切号执行器),不是 Codex 三号假设；实施时逐个打开复核，不按字面量批量改。

### 1.4 排除(Claude 账号族，不属本单)

`account-heal/quota-pool-rebuild.ts` 的 `CANONICAL_POOL_IDENTITIES`、`account-quota-view.ts` 的 `MANUAL_CLAUDE`、
`setup-quota-monitor.sh`、`qa-fly-1252/1256/2271` 三个 QA 脚本、`flywheel-claude-profile`。

### 1.5 持久层

- SQLite 里所有 profile 列(`codex_quota_root.profile`、`install_material.profile`、`binding.profile`、
  `incident.target_profile`、`observation.profile`、`external_generation.profile`、`switch_audit.from/to`)
  都是 `TEXT NOT NULL`,**没有 CHECK 约束**。约束只在上面三处 TS 校验。→ 无需迁移。
- `~/.flywheel/codex-quota/codex-accounts.json`(FLY-2688 快照):`name` 已按目录名，校验正则
  `CODEX_ACCOUNT_SLOT_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/`。
- `~/.flywheel/codex-account-ledger/<profile>.json`:按 profile 名一文件，现有三个文件的 email/role 在新规则下仍一致。

## 2. accountKey 变化分析(最容易出事的地方)

`codexInstallAccountKey(identity) = sha256("<profile>:<accountId 或 email>")`。

| 号 | 旧 profile 名 | 新 profile 名 | accountKey |
|---|---|---|---|
| school / personal / business | 同名 | 同名 | **不变** |
| personal1 / personal2 / shopping | `account-xrliannie-1` 等(FLY-2750 派生名) | 目录名 | **变** |

accountKey 用在三处，逐一核实：

1. **账号租约与待恢复标记**(`.codex-quota-account-locks/<digest(accountKey)>.pending.json`):
   升级瞬间若有旧键的 pending 文件，新代码会看不见它 → 一次 refresh token 轮换可能没写回。
   2026-09-22 实测该目录**为空**。部署前置检查：目录里没有 `*.pending.json`。
2. **在用检测**(`host-readiness.ts` 的 `activeUnsharedAccountKeys`):每次都从活 home 的 auth.json 现算，
   新旧代码各自一致，不跨版本持久化 → 安全。
3. **额度库的 root / install_material / binding 行**:这三个号的旧键**从未入库**(三号校验一直拒绝它们),
   所以不存在「库里是旧键、代码算新键」的失配。

结论：三个老号零变化；三个新号的键变化不会撞上任何持久化的旧键，前提是部署时锁目录无 pending。

## 3. 「真探」的唯一实现

只有 Bridge 的 FLY-2688 观察器有资格真探：
- 在用检测：活着的 Codex 进程正在用的号不探(同一个 refresh token 不能两个进程共用，否则一方被吊销)。
- 账号租约 + 待恢复标记：探的过程中 refresh token 若轮换，保证写回目录。
- 单飞 + 90s 硬上限。

CLI 若自己起 app-server 探，这三件事都要重做一遍，且 CLI 不知道哪些号在用 → 直接可能吊销正在跑的 runner。
**所以 CLI 只读快照，不自己探。** 刷新走 Bridge:
- 现有入口 `GET /api/accounts-page.html?refresh=1`(token 鉴权，返回 HTML)。
- 本单新增一个 JSON 入口 `POST /api/codex-accounts/refresh`(同一 `tokenAuthMiddleware`、同一单飞函数),
  返回 `{ generatedAt, accounts: [...] }`。CLI 用 `TEAMLEAD_API_TOKEN` + `FLYWHEEL_BRIDGE_URL`(默认 `http://127.0.0.1:9876`)。
  这两个变量是 flywheel-comm 已有约定，不引入新凭据。

## 4. token 失败细分的错误码

`quota-reader.ts:89` 目前把以下错误码统一归为 `refresh_invalid`:
`invalid_grant | refresh_token_reused | refresh_token_expired | refresh_token_invalidated | token_revoked`。
细分规则(按出现的码，优先级从上到下):

| 码 | 细分 | 页面文案 |
|---|---|---|
| `token_revoked`、`refresh_token_invalidated`、`refresh_token_reused` | revoked | 凭据已吊销·需重新登录 |
| `refresh_token_expired` | expired | 凭据已过期·需重新登录 |
| 仅 `invalid_grant` | invalid | 凭据失效·需重新登录 |

`authHealth` 取值集合不变(仍是 `refresh_invalid`),细分只进 `note`(`token_revoked` / `token_expired` / `refresh_invalid`)。
`note` 在快照校验里本就是 ≤128 字符的自由 token,**快照格式不升版本**,新旧 Bridge 读写互不破坏。

## 5. 部署与混版本

- codex-guard(CLI + 注册表)由 `restart-services.sh` → `converge-nonlead-daemons.sh` → `install-codex-guard.sh`
  以**内容哈希目录 + current 软链原子切换**发布，代码和注册表永远同版。
- Bridge / runner 出生路径从同一 checkout 的 `packages/claude-runner/agents/` 读注册表，也同版。
- 所以不存在「旧代码读到新 v2 注册表」:每个进程读的是自己那一版的文件。回滚 = 回滚 commit 后再跑一次部署，
  旧 release 带回 v1 三号文件。
- 注意：`install-codex-guard.sh` 发布时**不校验注册表内容**。本单在安装脚本里加一步 `node` 校验 v2 策略文件，
  坏文件不发布(fail closed,保留上一版 current)。

## 6. 现有测试夹具形态

- claude-runner 的 codex 测试大多用 `mkdtemp` 造 `profiles/<name>/auth.json` + 一个注册表 JSON。
  v2 下注册表只剩 `{version:2, primary}`,身份全由目录夹具决定——夹具反而更简单。
- teamlead 的 observer 测试已经用 `shopping` 这种非三号名字(FLY-2688),可直接复用其夹具工具。
