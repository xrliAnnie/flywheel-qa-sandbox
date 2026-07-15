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

### 1.3 Rate limit 约束（真机探测定量，2026-07-14 16:41 PDT）

**探测方法**（Annie 批注⑤触发——「每 5 分钟查」与旧猜测值「~5 次」自相矛盾，须实测；Tadashi 裁定①）：对 active 账号 token 以 1s 间隔顺发请求直到首个 429（上限 30 次），记录 429 响应头/体；再于 `retry-after` 期满后单发验证恢复。脚本存 scratchpad `probe-phase1.sh`。

**结果**：
- 连续 **5 次 200**，第 6 次 **429**；429 响应头 **`retry-after: 300`**（体：`rate_limit_error`）。
- 即真实契约 ≈ **每 token 每 5 分钟窗口 5 次**（200 响应无任何 `x-ratelimit-*` 头，限额只在 429 时经 retry-after 暴露）。
- **旁证隔离性**：探测打满限额期间，本机同账号的活 Claude session（本 runner 自身）推理全程正常——usage endpoint 的限流桶与推理通道相互独立，探测/轮询不影响干活。
- 恢复验证（phase 2，已闭环）：429（16:41:16）→ 等 retry-after 满 → **16:47:36 单发恢复 200**。契约完整实证：**5 次/5 分钟/token，429 附 retry-after: 300，窗口过后立即恢复**。

**设计含义**（Annie 第三轮终版：怕查太频被封号，查询次数压到最低）：
- 基础 poll = **20min，只查当前号**；当前号 5h >70%（可配）→ 加密到 **10min**（她给 5-10 区间取上限，明令不再用 2 分钟）；此时**才开始**每 ~60min 扫一遍候选号（预热排序数据，用池内未过期 accessToken，过期即跳过标 unknown——**绝不为例行扫描 probe-refresh**，token 轮转只发生在切号时刻）；闲置号平时零查询。切号时刻按需逐个验证候选（权威数据，probe-refresh + usage 查询）。
- 90% 触发 + 10-20min 间隔存在「两次 poll 之间冲过 100%」窗口——按 Annie 哲学可接受，恢复扫描（§9）兜底。全部间隔运行时可调（§8）。预算占用各档均远低于实测 5 次/5min。
- 429 处理：读 `retry-after`（实测总是给出）按其退避；缺失时指数退避（60s 起、上限 30min）。
- 目标验证的每候选 1 次调用打在**候选自己的 token 桶**上（per-token 限流），不消耗 active 桶。
- statusline 缓存被 daemon 持续刷新后，statusline 自己的刷新分支（cache 永不过期）**不再发起任何调用**——active 桶的唯一常驻消费者就是 daemon，预算独占。

## 2. statusline 滞后根因（issue 调研交付②，事故①解释）

因果链（`~/.claude/statusline-command.sh`，四层叠加）：

1. **10 分钟缓存**（:72 `CACHE_MAX_AGE=600`）——显示值最坏落后真值 10 分钟；
2. **后台异步刷新**（:83-112 `refresh_cache` 是 `(...)& ` 子进程）——缓存过期后的**当前帧仍渲染旧值**，新值要等下一帧；
3. **只在 Claude Code 重绘 statusline 时才执行**——session 空闲期间脚本根本不跑，显示无限期冻结；
4. **每 token ~5 次/突发的 429 预算**（:6 注释）逼出前三层的保守设计。

事故①「54%→79% / 20min 且滞后于 Annie 端」完全被 1+2+3 解释：fleet 高速烧配额时，10 分钟前的缓存 + 一帧延迟 = 显示比真值低一大截；Annie 端（Anthropic 官网）是服务端真值。

**修复（随本单交付，零改 statusline 脚本）**：daemon 每次 poll 把 200 响应原样原子写入 `~/.claude/usage-api-cache.json`（tmp+rename，与脚本自身写法 :108 相同）→ 缓存 mtime 永远新鲜 → 脚本自己的刷新分支（:114-119）不再触发（成为 daemon 停摆时的自然 fallback），显示值最坏落后一个 poll 间隔（默认 120s，见 §1.3 实测）。两个写者都是原子 rename，last-writer-wins，无撕裂风险。

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

### 5.1 选号策略无处表达（Annie 2026-07-14 拍板：两段式）
`selectNextAccount`（`account-store.ts:78`）现规则：5h → 字母序第一个可用；weekly → 本地缓存 weeklyResetAt 最近优先（常为 null）。Annie 终版的选号规则（资格 = 两窗「有余额就行」→ 合格者按**实时 seven_day.resets_at 最早优先**「先到期先用」→ founder 固定顺序仅平手裁决；触发只看 5h ≥90%）没有对应实现——排序键需要切号时刻各候选的实时 API 数据，本地 store 给不了。→ **daemon 在体外完成两段式计算**（资格筛 + 实时 reset 排序 + 平手裁决），把算好的有序合格名单经 **`SelectInput` 新可选字段 `preferredOrder?: string[]`** 传进 `switchAccount`：present 时候选排序 = 在列表中的下标（未列出的账号不参与选择），既有 usability 过滤（authExpired/cooldown）保留；absent 时行为 byte-identical（既有测试全绿为证）。Bridge 被动路径不传该字段，行为零变化。既有 weekly 启发式与 Annie 规则同哲学（`account-store.ts:10-16`「周五先用周一 reset 的」），差别在数据源实时性。

### 5.2 切前不验目标配额
`switch-executor.ts:165-207` 候选环只处理 auth freshness，`selectNextAccount` 只看本地 `quotaExhaustedUntil`（且该字段只在切号 commit 时对源账号写入，目标账号真实余量从未查过）。→ daemon 在调 `switchAccount` **之前**对全部候选完成验证（§3.3 四步，两段式需要每个候选的实时数据来排序），`preferredOrder` = **已通过「有余额 + freshness」资格筛、按 7d reset 排好序的合格名单**——switchAccount 内部的 freshness 候选环只会在这份名单里走（榜首在竞态窗口内变 stale 时自动落到榜二，仍是配额已验账号），不可能落到未验证配额的账号上。

### 5.3 监控盲区（v1 文档化边界）
active 账号 accessToken 过期（`expiresAt` 已过）且机器上无任何活 Claude session 来刷新它时，daemon 无法读 active 用量（401），且红线 R1 禁止它自己刷。v1 行为：读 Keychain `expiresAt` 预判、跳过 API 调用、进入 blind 态并发一条（claims.db 日去重的）`quota_read_blind` 告警。本机 fleet 24/7 运转，blind 态罕见；「全员因配额假死」场景 token 仍有效（quota≠auth），**不落入盲区**。

## 6. Bridge 被动引擎退役方案（Annie 2026-07-14 拍板：不保留，直接退役）

Annie 批注⑦推翻此前「保留为兜底」决定（「从来就没 work 过」）——daemon 成为**唯一**自动切号器。退役是外科手术式的，边界如下：

**退（Bridge 内的自动切号触发-执行管线）**：
- `AutoRepairBot` 的 accountSwitch 路由（`AutoRepairBot.ts:148/256-257` 的 `canAttempt`/`enqueue`）；
- `account-switch-watchdog.ts` 的 poll-piggyback 执行 tick（`plugin.ts:8002` 挂接点）及其 `pending-store` durable 队列的**自动切号用途**；
- FLY-1182（点火单，In Progress，PR #562）随之**停止点火**——被本单取代，处置（关闭/重定向）由 Lead 定。

**留（daemon 的地基 + 与自动切号无关的功能）**：
- 共享库：`switch-executor.ts`（switchAccount）、`account-store.ts`、`claude-profile-cli.ts`、`freshness.ts`、`mkdir-lock.ts`——daemon 直接复用，**不许删**；
- `flywheel-claude-profile` bash 全套（手动换号 + daemon 的 applyProfile 后端）；
- pane 配额**检测与告警**（LeadWatchdog/runner-quota-scan 的 usage_limit 告警）——退的是「检测后自动切」，不是检测本身；封顶告警仍有运维信息价值；
- FLY-1049 rescue/login-expired 救援链（与配额切号无关）。

**迁移注意**：
- 手动 CLI（`flywheel-claude-profile use`）与 daemon 仍经同一把 mkdir 锁 + store CAS 串行化（`switch-executor.ts:142-163`），人机并发安全性不变；
- 退役后 daemon 的可靠性要求升级（唯一切号器）：launchd KeepAlive + 健康快照（state 文件）+ 停摆告警是硬要求；
- 退役的具体代码改动（拆 AutoRepairBot 路由/watchdog tick、相关测试处置、FLY-1182 收尾）列入 plan 的独立里程碑，与 daemon 构建同 PR 或紧邻 PR，由 implement 阶段执行。

## 7. QA 可注入面（「Claude 全员假死」场景可测性）

| 注入点 | 机制 |
|---|---|
| usage API | daemon 新 env `FLYWHEEL_QUOTA_API_BASE`（默认 `https://api.anthropic.com`）→ QA 指向本地 mock（可脚本化返回任意 utilization 序列） |
| Keychain | 既有 `FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE`/`FLYWHEEL_CLAUDE_KEYCHAIN` → scratch item，真 login item 零接触 |
| 池/store/锁 | 既有 `FLYWHEEL_CLAUDE_PROFILES_DIR`/`FLYWHEEL_CLAUDE_ACCOUNTS_PATH`/`FLYWHEEL_CLAUDE_ACCOUNTS_LOCK` |
| statusline 缓存 | 新 env `FLYWHEEL_QUOTA_STATUSLINE_CACHE`（默认 `~/.claude/usage-api-cache.json`）→ scratch 路径 |
| Discord | `lead-alert.sh` 既有 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` + `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` → 529 Room 隔离频道 |
| 「全员假死」 | 隔离环境内不起任何 claude 进程即是该场景（daemon 全链不依赖 Claude）；QA 以 ps 证明 daemon 存续期间零 claude 进程参与 |
| 恢复扫描 | 既有 env `FLYWHEEL_QA_TMUX_*` 风格隔离 tmux server（`tmux -L <socket>`）+ 抓屏 fixture 回放 |

## 8. 运行时配置契约（Annie 第二轮：阈值不许硬编码，接 dashboard）

**契约 = `~/.flywheel/quota-monitor.json` 文件本身**（单一真相，不新建服务面）：

- **读**：daemon 每 tick 重读 + schema 校验——改值即时生效（≤1 个轮询周期），零重启；校验失败退 monitor-only + 告警（fail-safe，不 crash-loop）。
- **写**：任何写者（founder 手编 / dashboard 经 Bridge / setup 脚本）必须原子写（tmp+rename）——daemon 的重读因此永不见撕裂 JSON。
- **dashboard 集成边界**：daemon 侧交付到文件契约为止（schema + 原子性 + 重读语义 + 本节文档）；Bridge 暴露该文件读写 API 给 Honey Lemon 的 dashboard 属 Bridge/dashboard 侧工作，Tadashi 与 HL 协调，**不在本单**。schema 字段即 plan 的配置表（阈值/资格线/回流/轮询两档/冷却/顺序）。

## 9. 切号后恢复扫描（Annie edge case (a)——核心组件的可行性）

**需求**：完全用尽才切时，在跑 runner 卡在配额 rate-limit 对话框；切号后需自动「解除 + 续跑」（替代 Tadashi 2026-07-14 的手工逐个戳）。

**可复用资产**：
- pane 签名识别：`detection-classifier.ts:65` Layer1 正则表已定义 usage_limit/rate_limit pane 形态；`usage-gauge.ts` gauge 行；FLY-193 live-region 识别（锚定底部渲染区、防 scrollback 残留误判）是同类问题的成熟方法论。daemon **移植签名模式**（同包代码直用），不依赖 Bridge 运行时。
- tmux 操作：`tmux list-panes -a` + `capture-pane -p` + `send-keys`——任何进程可用，无 Bridge 依赖（体外前提保持）。

**安全边界（FLY-313 resume-menu 误按教训）**：只对**高置信匹配配额对话框签名**的 pane 动手；识别到 resume-menu/compact/login 等其他形态一律不碰（login-expired 形态 = edge case (b)，只告警）。确切「解除 + 续跑」按键序列今天无现成 fixture——**implement 阶段第一步 = 真机抓一个卡配额对话框的 pane fixture**（FLY-193 committed-fixture 惯例），按键契约以 fixture 为准，绝不凭想象写 send-keys。

**触发时机**：切号 commit 成功后立即扫一轮 + 之后每个 poll tick 复扫（本地 tmux 扫描零 API 成本），直到无卡 pane；每 pane 有界重试 + 结果入 Discord 通知。

**已知 edge case (b)（Annie 实测）**：未用尽就切 profile，偶发个别窗口要 re-login。v1 边界：恢复扫描识别到 login-expired 形态 → **只告警不自动 re-login**（re-login 属 FLY-1049 救援链）。根因调查线索：live session 在 Keychain 已切换后 mid-session 刷新 token，新账号 refresh 结果与 `~/.claude.json` 身份/会话状态不一致（FLY-865 疆域）——实现阶段若能抓到复现 fixture 则记档，不阻塞 v1。
