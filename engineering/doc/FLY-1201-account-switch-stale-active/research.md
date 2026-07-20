# FLY-1201 账号切换 stale .active 覆盖 live 凭据 — 调研

Issue: FLY-1201 (https://linear.app/geoforge3d/issue/FLY-1201/bug-account-switch-引擎带外登录留下-stale-active-时切号会覆盖-live-凭据跳过-capture-back)
日期: 2026-07-19
基于: exploration.md

以下全部为 worktree(main @ e59a02389)实读,行号为当前文件行号。

## 1. bash 脚本事实清单(`packages/claude-runner/bin/flywheel-claude-profile`,2063 行)

### 1.1 环境 seam(L74-99)—— 全部可注入,测试 hermetic 基础

| 变量 | 默认 | 作用 |
|---|---|---|
| `FLYWHEEL_CLAUDE_PROFILES_DIR` | `~/.flywheel/claude-profiles` | 池目录;`.active` = `$POOL_DIR/.active` |
| `FLYWHEEL_CLAUDE_JSON` | `~/.claude.json` | display identity(machine truth 来源) |
| `FLYWHEEL_CLAUDE_SECURITY_BIN` | `/usr/bin/security` | Keychain 读写(测试用 stub) |
| `FLYWHEEL_PROFILE_CURL_BIN` / `FLYWHEEL_PROFILE_IDENTITY_ENDPOINT` | curl / api.anthropic.com oauth/profile | 身份 probe(测试用 stub) |
| `FLYWHEEL_CLAUDE_ACCOUNTS_PATH` | `~/.flywheel/claude-accounts.json` | Node 台账(ledger) |
| `FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN` | teamlead quota-guard-cli | quota / identity-verify / active-sync 助手 |

### 1.2 切换主链

- `get_active()` L1595:`cat "$ACTIVE_FILE"` —— **`.active` 是唯一来源,零对账**。
- `use_profile()` L1864-1877:`acquire_lock` → `reconcile_after_acquire`(仅 transition-journal 崩溃恢复,L1350)→ `configure_identity_bypass` → `active=$(get_active)`(L1873)→ `switch_profile_locked "$name" "$active"`。
- `next_profile()` L1879-1944:同样 `active=$(get_active)`(L1886)后进入候选循环,每个候选 `prepare_profile_locked "$candidate" "$active"` → `commit_profile_locked "$candidate" "$active"`。
- `switch_profile_locked` L1857-1862 = prepare 一次 + commit 一次。

### 1.3 两处 `.active` 短路(bug 本体)

- **freshness 跳过** `prepare_profile_locked` L1704-1717:
  ```bash
  if [[ "$name" != "$active" ]]; then
    freshness_check "$name" "$active" || rc=$?
  ```
  注释自述:「Re-selecting the current active (name == active) skips the probe (it re-writes the same account)」。`quota_check`(L1115,总是跑)与 FLY-1182 assertion C(目标池内凭据 vs 目标 anchor,L1723-1737)不受此短路影响 —— 但 assertion C 挡不住 incident:business 池内快照是**真的** business token(只是过期),anchor 断言 match。
- **capture_back 跳过** `commit_profile_locked` L1768-1790:
  ```bash
  if [[ -n "$active" && "$active" != "$name" ]]; then
    ... identity_assert_value "$active" "$backup" → capture_back / emit_identity_drift ...
  ```
  `name == active` → 整块跳过,当前 Keychain live 凭据(`$backup`)不回存。

### 1.4 第二条丢 capture 缝(exploration §3)

同块 L1773-1788(FLY-1182 assertion B):`active` stale 且目标 ≠ active 时,`identity_assert_value "$active" "$backup"` 拿 **stale 槽的 anchor** 断言 live token → 必 mismatch(86)→ `emit_identity_drift` + **跳过 capture、切换继续**。live 凭据不落任何槽。

### 1.5 可复用的修复原语

| 原语 | 位置 | 语义 | 复用注意 |
|---|---|---|---|
| `read_display_identity()` | L717 | `~/.claude.json` `oauthAccount` → `uuid\temail`;要求 accountUuid/emailAddress/organizationUuid/organizationName 四字段齐且合法,否则非零 | 纯本地读,零网络 |
| `read_identity_anchor <name>` | L609 | 槽 `identity-anchor.json` → `uuid\temail`;校验 0600/属主/schema,坏 → 87 | 纯本地读 |
| `identity_assert_value <name> <cred>` | L642 | anchor + `identity_probe`(网络,10s timeout)→ match / 86 mismatch / 87 untracked / 88 unavailable | 网络调用,仅在 drift 已检出后用 |
| `capture_back <active> <value>` | L1184 | best-effort 回存;内含 `identity_verify_payload … capture_back pool_write`(L1202,非 match 即跳过写)+ 原子 tmp+mv | **best-effort(警告不失败)** —— 对账场景需要 fail-closed,须包一层检查结果(见 plan) |
| `write_active_from_reconcile <label>` | L1301 | 原子写 `.active`(要求槽目录存在)+ lease fence | 现被 journal reconcile 与 capture recovery 使用 |
| `active_sync_store <name> [force]` | L1161 | quota-guard `active-sync` 投影台账;delegated 模式默认 no-op,`force` 才写 | capture recovery 用的就是 `force` |
| `emit_identity_drift` | L663 | 稳定 drift 标记 stderr | |
| `audit_append` / `begin_audit` / `AUDIT_SUMMARY` | L139/184 | 审计行;已有 summary 值:identity_check_pending / match / mismatch / untracked / unavailable / bypass_* | 新增 summary 值向后兼容(自由文本) |

### 1.6 exit code 占用表

| 码 | 语义 |
|---|---|
| 30 / 31 | freshness:目标 stale / 助手不可用(stderr 标记 `FLYWHEEL_TARGET_STALE` / `FLYWHEEL_FRESHNESS_UNAVAILABLE`,L873/860) |
| 32 / 33 | quota:耗尽 / 证据不可用 |
| 34 / 35 / 38 | identity payload:mismatch / 未知失败 / unauthorized |
| 36 / 37 | Keychain read-back 回滚成功 / 回滚失败 |
| 39 | lease 丢失 |
| 44 | security(1) not-found(Keychain 项缺失) |
| 86 / 87 / 88 | anchor 身份:mismatch / untracked / unavailable |
| 130 / 143 | 信号 |

**40-43、45-49 空闲** → 新码选 46(marker 不可对账)/ 47(对账动作失败)。

### 1.7 边界现状(保持不变的行为)

- `.active` 文件缺失:`active=""` → prepare 里 `name != ""` 成立 → freshness 照跑;commit 里 `-n "$active"` 为假 → capture_back 跳过(没有已知 active 可回存,合理)。
- `IDENTITY_BYPASS=1`(仅手动,delegated 被拒,L1691-1702):跳过 assertion B/C。
- `capture` 命令自身安全:强制「Keychain identity == 目标槽 anchor」(L1955+)。

## 2. TS 侧事实清单

### 2.1 `machine-account.ts`(133 行,#615 引入,2026-07-18 merge)

三见证:`.active` marker(`readActiveProfileName`)+ 台账 `store.activeAccount` + `~/.claude.json` identity email → 池内 `oauthAccount.json` 匹配。**三者必须一致才 `resolved`**;identity 匹配 0 或 >1 槽 → `untracked`;三者有分歧 → `conflict`(L123)。**incident 态(marker=business ≠ identity=shopping)今天在此返回 `conflict`。**

### 2.2 `switch-executor.ts`(689 行)

- L426-433:`deps.resolveMachineAccount?.(store)` 非 `resolved` → `outcome:"failed"`,reasonCode `machine_account_conflict`(fail-closed,不碰 Keychain)。**`resolveMachineAccount` 是 optional dep**;生产 `makeClaudeProfileSwitchDeps` 必注入(cli L182-187),未注入的 legacy 调用方退回 `readActiveProfile()`(= bash `status` = `.active`,即 pre-1182 行为)。
- 候选循环错误分类 L534-606:`TargetStaleError`(30)→ flag `authExpired` + 换候选;`FreshnessUnavailableError`(31)→ **environmental fail-close,不 flag、不轮转** —— 新「marker drift」错误应比照后者。
- 时间线结论:**issue(07-12)描述的引擎 clobber 链在 #615(07-18)后已被 TS conflict fail-close 挡住;但 stale marker 不自愈,quota cap 被丢弃,alert 把人引向 bash 直连命令 —— 根因层修复(本单)仍完整成立。**

### 2.3 `claude-profile-cli.ts`(417 行)

- `applyProfile` = exec `use <name>`,delegated env + 洗 4 个 bypass env(L215-218);exit code **或** stderr 标记双通道映射 → typed error(L249-293)。新 46/47 + 新标记在此加映射。
- `readActiveProfile` = `status` 输出解析(= `.active`,stale 时同样给 stale 名;仅 legacy 无 authority 路径使用)。
- `FLYWHEEL_APPLY_REPORT_FILE` identityChecks 白名单:checkpoint ∈ {pre_write, capture_back, capture}(L67);**新增 checkpoint 会让旧解析器整个丢弃 report** → 对账里的 capture_back 复用现有 checkpoint 即可,不加新枚举。

### 2.4 daemon / alert 下游

- `quota-monitor.ts` L1388-1397:snapshot 层 authority ≠ resolved → severe alert `machine_account_conflict`(human_by_design,LeadWatchdog/AlertChannelHub/kind-contract 已注册)。
- SwitchResult `reasonCode` 在 daemon 侧只作字符串进 alert body/signature(L1066/1783+),**无穷举 switch** → 新 reasonCode 零额外注册。

## 3. 测试基建事实

- `packages/claude-runner/test/claude-profile.test.ts`(2461 行):全 hermetic —— stub `FLYWHEEL_CLAUDE_SECURITY_BIN`(文件模拟 Keychain)、scratch pool、scratch `FLYWHEEL_CLAUDE_JSON`、stub `FLYWHEEL_PROFILE_CURL_BIN` + 测试 `IDENTITY_ENDPOINT`、每 profile 可写 `identity-anchor.json`。新场景(stale marker 检测/修复/fail-close)可直接落此文件。
- 已知 flake:`claude-profile.test.ts:47` 文件级 `testTimeout 15_000`,高负载下有历史 flake 记录([[reference_ship_eligibility_test_local_env_flake]] 同类);新增测试注意别加重单测耗时(drift 检测路径零网络,可控)。
- TS 侧:`packages/teamlead/src/__tests__/claude-profile-cli.test.ts` + `claude-profile-cli.integration.test.ts`(exit code → typed error 映射断言),switch-executor 单测在 `__tests__` 内 —— 新错误类/新 reasonCode 各补映射断言。

## 4. 调用面盘点(谁会踩到 bash 直连)

`use`/`next` 的非 TS-authority 调用方:founder 手动终端、Infra Bot(claw)runbook、`scripts/qa-fly-1182-isolated-switch-drill.sh`、`scripts/qa-fly-1252-quota-state-e2e.sh`、recovery-runbook.md 文案。全部经 `use_profile`/`next_profile` → 一处对账全覆盖。

## 5. 对 exploration 悬而未决项的回答

1. **exit code**:46 = stale marker 不可对账(display 不可读 / anchor 坏 / 0 或 >1 槽匹配 / Keychain token ≠ display);47 = 对账动作失败(capture/marker 写/store sync 半途失败)。两码都属 environmental(不该 flag 任何账号)。CLI 映射为一个新 error class(带 detail 区分),executor reasonCode `active_marker_drift`。
2. **边界行为**:`.active` 缺失照旧(§1.7);display identity 不可读时**若 marker 与池一致性无法证实即 fail-closed 46**(例外:`IDENTITY_BYPASS=1` 手动逃生舱沿用,delegated 拒绝照旧)。注意:display 不可读 + `.active` 缺失(全新机器)时无需对账 —— `active=""` 无短路可保护,保持现状直通。
3. **崩溃安全**:对账三步(capture → `.active` 写 → store sync)任一步后崩,重跑幂等:capture 重复 = 同字节覆盖;`.active` 未写 → 重新检出 drift → 重跑;`.active` 已写 store 未 sync → marker 已正确,后续 `active_sync_store` 在正常 commit 里还会跑(且 TS 权威把 marker/ledger 分歧兜为 conflict alert,不会静默错切)。全程在 accounts lock 内,无并发窗口。
4. **next_profile**:对账放在 `active=$(get_active)` 之后、候选循环之前,循环用修正后的 `active` 变量 —— 单点更新。
5. **identityChecks 不加新 checkpoint**(§2.3);观测走 stderr 稳定标记 + `audit_append` 新 summary + 47/46 exit code。
6. **测试矩阵**:见 plan §5(incident 复现为突变对照:旧代码红/新代码绿)。

## 6. 风险清单(带进 plan 的设计权衡)

- **R1 网络依赖**:drift 修复路径需要 identity probe(网络)。网络断 + marker stale → fail-closed 46,切换不可用 —— 可接受:此态本来就不该盲切;stderr/audit 指明人工路径(`claude /login` 后 `capture <slot>`)。健康路径零网络新增。
- **R2 active 槽 anchor 缺失**(legacy 未迁移槽):`read_identity_anchor` 87 → 无法证实 marker → fail-closed 46。现有 anchor 迁移路径(`anchor --migrate`)是解法,错误文案要指路。
- **R3 delegated(引擎)路径重复防御**:TS authority 已在 conflict 态拒绝进入 applyProfile,bash 对账在 delegated 模式下理论上见不到 drift;保留它作纵深(legacy 无 authority 调用方 + TS/bash 视角漂移窗口),成本为两次本地文件读。
- **R4 `use` 与并发 `claude /login`**:对账与切换同锁串行,但带外 login 不拿这把锁 —— 对账后、kc_write 前 login 仍可插入。这是 pre-existing 窗口(commit 的 verify-before-commit + read-back 兜底),本单不扩大也不缩小它,明确不在 scope。
