# FLY-1256 外部配额监控 + 自动切号器 — 调研

Issue: FLY-1256 (https://linear.app/geoforge3d/issue/FLY-1256/build-外部配额监控-自动切号器跑在-claude-体外-p1今天事故实证)
日期: 2026-07-14
基于: exploration.md

## 1. 实时配额来源（issue 调研交付①）

### 1.1 结论：OAuth usage endpoint 是实时源（真机验证 2026-07-14）

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <claudeAiOauth.accessToken>   ← macOS Keychain "Claude Code-credentials"
anthropic-beta: oauth-2025-04-20
Accept: application/json
```

真机响应（本机 active 账号，节选）：

```json
{
  "five_hour":  { "utilization": 10.0, "resets_at": "2026-07-15T04:00:00.420470+00:00" },
  "seven_day":  { "utilization": 22.0, "resets_at": "2026-07-21T14:00:00.420493+00:00" },
  "limits": [
    { "kind": "session",       "group": "session", "percent": 10, "severity": "normal", "resets_at": "…", "is_active": false },
    { "kind": "weekly_all",    "group": "weekly",  "percent": 22, "severity": "normal", "resets_at": "…", "is_active": false },
    { "kind": "weekly_scoped", "group": "weekly",  "percent": 24, "…": "…" }
  ],
  "extra_usage": { "is_enabled": false }
}
```

- `five_hour`/`seven_day.utilization` = 百分比（浮点），`resets_at` = 绝对 ISO 时刻——正是阈值判断需要的两个数。
- `limits[]` 还带 `weekly_scoped`（模型分档 weekly，如 Opus）——v1 只用顶层 `five_hour`/`seven_day`（与 statusline 语义一致），`limits[]` 留作 v2 精细化。
- **任意账号可查**：只要拿到该账号的 accessToken（池文件里有），即可查它的用量——这就是「切前验目标配额」的实现基础。`account-ledger.ts:24-26` 注释「无法安全查询 idle 账号剩余配额」写于此 endpoint 被验证之前，本调研推翻该前提（安全性见 §3.2：非 active 账号 probe-refresh 是既有安全操作）。

### 1.2 候选来源对比

| 来源 | 实时性 | 覆盖 | 结论 |
|---|---|---|---|
| **OAuth usage endpoint**（上） | 请求即真值 | **任意账号**（有其 token 即可） | ✅ 选定，唯一能做切前目标验证的源 |
| Claude Code statusline stdin 的 `rate_limits` 结构化字段（`account-ledger.ts:172` `parseRateLimits` 解析；`five_hour`/`seven_day`.`used_percentage`+`resets_at` epoch 秒） | 随**该 session** 最近一次 API 响应更新；session 空闲即冻结 | 仅活跃账号、仅有活 session 时 | 辅证源；体外 daemon 拿不到（它在 Claude 进程的 stdin 管道里） |
| pane 渲染 gauge（`usage-gauge.ts:47` 正则刮 `5h ██ 100% reset …`） | 同上且更糙（渲染文本） | 仅活跃账号 | FLY-696 现状，被动兜底继续用，daemon 不用 |
| `~/.claude/usage-api-cache.json`（statusline 脚本的缓存） | 至多 10 分钟旧 | 仅活跃账号 | daemon 的**回写目标**（§2），不是读取源 |

### 1.3 Rate limit 约束

- 响应无 rate-limit 头（真机验证 `HTTP/2 200`，无 `retry-after`/`x-ratelimit-*`）。
- 经验值（`statusline-command.sh:6` 注释，实测得出）：**每 accessToken 突发 ~5 次即 429**。statusline 因此用 10 分钟缓存（`CACHE_MAX_AGE=600`，:72）。
- 设计含义：daemon 默认 poll 间隔 180s（20 次/小时，远低于 statusline 曾经的安全水位 6 次/小时？——不，10min 缓存 = 6 次/小时；180s = 20 次/小时是 3 倍。**保守起见默认 300s（12 次/小时），可配下探**），429 时指数退避（上限 30 分钟）+ 尊重 `retry-after`（若出现）。目标验证是一次性调用（每候选 1 次，仅在切号时），不构成持续压力。

## 2. statusline 滞后根因（issue 调研交付②，事故①解释）

因果链（`~/.claude/statusline-command.sh`，四层叠加）：

1. **10 分钟缓存**（:72 `CACHE_MAX_AGE=600`）——显示值最坏落后真值 10 分钟；
2. **后台异步刷新**（:83-112 `refresh_cache` 是 `(...)& ` 子进程）——缓存过期后的**当前帧仍渲染旧值**，新值要等下一帧；
3. **只在 Claude Code 重绘 statusline 时才执行**——session 空闲期间脚本根本不跑，显示无限期冻结；
4. **每 token ~5 次/突发的 429 预算**（:6 注释）逼出前三层的保守设计。

事故①「54%→79% / 20min 且滞后于 Annie 端」完全被 1+2+3 解释：fleet 高速烧配额时，10 分钟前的缓存 + 一帧延迟 = 显示比真值低一大截；Annie 端（Anthropic 官网）是服务端真值。

**修复（随本单交付，零改 statusline 脚本）**：daemon 每次 poll 把 200 响应原样原子写入 `~/.claude/usage-api-cache.json`（tmp+rename，与脚本自身写法 :108 相同）→ 缓存 mtime 永远新鲜 → 脚本自己的刷新分支（:114-119）不再触发（成为 daemon 停摆时的自然 fallback），显示值最坏落后一个 poll 间隔。两个写者都是原子 rename，last-writer-wins，无撕裂风险。

## 3. 凭证与 token 生命周期（安全约束）

### 3.1 存储形态（全部既有，本单零新增落盘）

| 位置 | 内容 | 形态 |
|---|---|---|
| Keychain item `Claude Code-credentials`（service 名，`flywheel-claude-profile:47`） | 机器当前 active 账号凭证 | JSON：`claudeAiOauth.{accessToken, refreshToken, expiresAt(ms), refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier}` |
| `~/.flywheel/claude-profiles/<name>/.credentials.json` | 各池账号凭证快照 | 同上结构，0600、0700 目录、拒 symlink |
| `~/.flywheel/claude-profiles/<name>/oauthAccount.json` | 显示身份（FLY-865） | email/org/uuid，0600 |
| `~/.flywheel/claude-profiles/.active` | active 指针 | 纯文本账号名 |
| `~/.flywheel/claude-accounts.json` | CAS store（generation/activeAccount/accounts[]） | 0600 JSON，`account-store.ts:117` |

真机现状：池 = business/personal/personal1/school/shopping 五个；store 里四个（无 personal1）；active=business。**accessToken 生命周期为小时级**（真机 `expiresAt` 距今 ~5h）→ 池里非 active 账号的 token 大概率过期，目标验证前需 probe-refresh（§3.3）。

### 3.2 refresh 家族轮转与「绝不刷 ACTIVE」红线（事故②机理）

OAuth refresh 是**轮转式**：refresh 一次，旧 refreshToken 全家作废。若体外进程刷新了 **active** 账号的 token，活 session 下次刷新时撞 `refresh_token_reused` → 全员登出（FLY-871 的 2026-07-04 事故根因）。事故②是它的镜像：Keychain 被切到断粮账号后，活 session 的下一次 token 刷新从 Keychain 读到断粮账号 → Lead 失能。两条事故共同确立：

- **红线 R1：daemon 绝不对 active 账号做 token refresh**（读 Keychain 里现成的 accessToken 调 usage API 是只读、安全的）。
- **推论**：主动切号（阈值 90%）后，活 session 继续用内存里旧账号 token 干活，直至各自自然刷新时迁移到新账号——留的 10% 余量就是给这段迁移期烧的（`flywheel-claude-profile:10` D1 语义）。

### 3.3 freshness helper（既有，目标验证的前置件）

- `freshness.ts:150` `verifyPoolCredential({name, activeName, poolDir})`：对**非 active** 池账号做 probe-refresh（endpoint `https://console.anthropic.com/v1/oauth/token`，public client_id，`freshness.ts:46-48`），成功则把**轮转后的新凭证原子写回池**再返回 fresh；active 账号绝不刷（红线内建）。
- CLI 形态 `flywheel-claude-freshness verify …`（`packages/teamlead/bin/`）exit 0=fresh / 30=stale / 31=环境错误；`flywheel-claude-profile use` 在写 Keychain 前自动跑它（:302-331 `freshness_guard`）。
- **设计含义**：daemon 验证目标配额 = ① `verifyPoolCredential`（Node 直调，同包）→ ② 读池文件新 accessToken → ③ usage API 查该账号 → ④ 低于水位才作为切换目标。步骤①的轮转写回是既有安全操作（FLY-871 全套测试覆盖）。

## 4. 可复用资产清单

| 资产 | 位置 | daemon 用法 |
|---|---|---|
| `switchAccount()`（锁+CAS+freshness 候选环+commit） | `switch-executor.ts:126` | 直调（同包），传 `makeClaudeProfileSwitchDeps` |
| `makeClaudeProfileSwitchDeps()`（bash use 封装，FLY-852 委托锁 + exit 30/31 映射 + FRESHNESS_BYPASS 洗刷） | `claude-profile-cli.ts:59` | 直用 |
| `selectNextAccount()` / `readStore` / `writeStore` | `account-store.ts:78` | 直用 + byte-compat 扩展（§5.1） |
| `withMkdirLock`（Node↔bash 同锁） | `mkdir-lock.ts` | 经 switchAccount 间接用 |
| `verifyPoolCredential()` | `freshness.ts:150` | 目标验证步骤① |
| `flywheel-claude-profile`（Keychain 换号全套） | `packages/claude-runner/bin/` | 经 switchAccount→applyProfile 间接用 |
| `lead-alert.sh`（Bridge-independent Discord：直连 REST :472、token 经 curl -K - stdin :475-477、claims.db 去重 :307-338、queue 兜底、kind 白名单 :115） | `scripts/lead-alert.sh` | 通知通道；新 kind 需白名单 + `LeadAlertNotifier.ts` union + `kind-contract.test.ts` 三处同步 |
| launchd 范式（label `com.flywheel.*`、KeepAlive+ThrottleInterval 30+RunAtLoad、wrapper source `~/.flywheel/.env`、日志 `/tmp/flywheel-<name>.log`、token 不进 plist） | `scripts/com.flywheel.cmux-watcher.plist.template`、`scripts/token-usage-daily.sh:26,38` | 照搬 |
| 隔离 QA env（scratch keychain service/pool/lock 全套 env override） | `flywheel-claude-profile:33-41` | 真机 QA 隔离 |

## 5. 缺口与设计含义

### 5.1 founder 顺序无处表达
`selectNextAccount`（`account-store.ts:78`）现规则：5h → 字母序第一个可用；weekly → weekly reset 最近优先。「shopping→school→…」没有对应配置。→ **扩展 `SelectInput` 加可选 `preferredOrder?: string[]`**：present 时候选排序 = 在列表中的下标（未列出的账号不参与选择），既有 usability 过滤（authExpired/cooldown）保留；absent 时行为 byte-identical（既有测试全绿为证）。Bridge 被动路径不传该字段，行为零变化。

### 5.2 切前不验目标配额
`switch-executor.ts:165-207` 候选环只处理 auth freshness，`selectNextAccount` 只看本地 `quotaExhaustedUntil`（且该字段只在切号 commit 时对源账号写入，目标账号真实余量从未查过）。→ daemon 在调 `switchAccount` **之前**完成目标验证（§3.3 四步），并把 `preferredOrder` 收窄为**已通过验证的那一个候选**——这样 switchAccount 内部的 freshness 候选环不可能落到未验证配额的账号上（验证失败→`no_account`→daemon 取下一候选重试，外层有界）。

### 5.3 监控盲区（v1 文档化边界）
active 账号 accessToken 过期（`expiresAt` 已过）且机器上无任何活 Claude session 来刷新它时，daemon 无法读 active 用量（401），且红线 R1 禁止它自己刷。v1 行为：读 Keychain `expiresAt` 预判、跳过 API 调用、进入 blind 态并发一条（claims.db 日去重的）`quota_read_blind` 告警。本机 fleet 24/7 运转，blind 态罕见；「全员因配额假死」场景 token 仍有效（quota≠auth），**不落入盲区**。

## 6. 与 FLY-1182（Bridge 被动引擎）共存性推演

两路都收敛到 `switchAccount()` → 同一把 mkdir 锁（`claude-accounts.lock`）+ 同一 store 的双重 CAS（name+generation，`switch-executor.ts:142-163`）：

- daemon 先切（阈值 90%）→ Bridge 稍后 pane 观察到旧账号 100%（generation 已 bump）→ CAS 失配 → `noop_already_switched`。✅
- Bridge 先切（daemon poll 间隙撞了 100%）→ daemon 下一 poll 读到新 active，阈值未过 → 无动作。✅
- 并发进锁 → 锁串行化，后进者 CAS 失配 noop。✅
- 崩溃恢复：`readActiveProfile()`（真实 `.active`）优先于 stale JSON（`switch-executor.ts:136-140`），双方同享。✅

结论：**零 Bridge 代码改动**（除告警 kind 注册三处同步），共存结构安全。

## 7. QA 可注入面（「Claude 全员假死」场景可测性）

| 注入点 | 机制 |
|---|---|
| usage API | daemon 新 env `FLYWHEEL_QUOTA_API_BASE`（默认 `https://api.anthropic.com`）→ QA 指向本地 mock（可脚本化返回任意 utilization 序列） |
| Keychain | 既有 `FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE`/`FLYWHEEL_CLAUDE_KEYCHAIN` → scratch item，真 login item 零接触 |
| 池/store/锁 | 既有 `FLYWHEEL_CLAUDE_PROFILES_DIR`/`FLYWHEEL_CLAUDE_ACCOUNTS_PATH`/`FLYWHEEL_CLAUDE_ACCOUNTS_LOCK` |
| statusline 缓存 | 新 env `FLYWHEEL_QUOTA_STATUSLINE_CACHE`（默认 `~/.claude/usage-api-cache.json`）→ scratch 路径 |
| Discord | `lead-alert.sh` 既有 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` + `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` → 529 Room 隔离频道 |
| 「全员假死」 | 隔离环境内不起任何 claude 进程即是该场景（daemon 全链不依赖 Claude）；QA 以 ps 证明 daemon 存续期间零 claude 进程参与 |
