# FLY-2896 满额时征得同意用充值卡续号并切过去 — 调研
Issue: FLY-2896 (https://linear.app/geoforge3d/issue/FLY-2896/claude-切号充值卡-5-小时额度到-80-90percent-且没有别的可用号时挑最晚自然重置的号征得-founder)
日期: 2026-09-25
基于: exploration.md

## 0. 取证方式与安全边界

- 2026-09-25 只对本机 Claude Code **2.1.283**（`~/.local/share/claude/versions/2.1.283`，Bun 编译、JS 明文内嵌）做字符串/正则提取。**没有发出任何网络请求**，没有读或打印任何凭据，没有调用 `reset_rate_limits`。
- 非敏感代码摘录保存在本次会话的 scratchpad（`cedar-ember-excerpts.txt`，约 850 行）；下文引用的是其中原文。FLY-2864 research §2 的只读 GET 实测（2026-09-24）作为状态端点的旁证。
- 「二进制原文确认」与「推断」分开标注。推断项都在 plan 的验证清单里有对应的实测步骤。

## 1. 充值卡（cedar_ember）服务端合同

### 1.1 状态：`GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1`

**二进制原文确认**（字段名 = 响应 JSON 键）：

| 字段 | 含义 |
|---|---|
| `eligible` / `ineligible_reason` | 11 种原因：`config_off, tier, seat, mobile, surface, cli_version, no_grant, tenure, other_experiment, unavailable, unknown` |
| `at_limit` | 该号**当前**是否已触顶 |
| `exhausted[]` | 已触顶的窗（`five_hour, seven_day, seven_day_overage_included, seven_day_opus, …` 共 8 个键） |
| `grants[]` | `id`（`/^[a-z0-9_-]{1,40}$/`）、`label`、`resets_total`、`resets_left`、`starts_at`、`ends_at`、`clears[]`、`blocking[]`、`paused`（默认 false）、`usable_now`（默认 false）、`use_requires_limit`（**默认 true**）、`percent_used` |
| `next_grant_id` | 客户端**只提供这一张**卡 |
| `weekly_resets_at` / `cooldown_until` | 周重置时刻 / 服务端领卡冷却 |

客户端提供卡的条件（原文）：`if (l === void 0 || !l.usableNow || l.paused) return; … if (m !== null && m <= s) return;`（`l` = `next_grant_id` 那张；`m` = `ends_at`，已过期不提供）。已触顶时还要求该卡 `clears` 覆盖触顶的那个窗。`blocking[]` 非空 → 客户端提示「这张卡不补你的 {limit}，要等它重置才能用」。

**UA 门（FLY-2864 实测）**：只有 `claude-cli/<当前版本> (external, cli)` 拿得到 `eligible:true`；`Python-urllib` / `sdk-ts` 得到 `surface`，旧版本号得到 `cli_version`。⇒ `eligible:false` 不等于「没卡」。

### 1.2 领卡：`POST https://api.anthropic.com/api/organizations/{orgUuid}/reset_rate_limits`

**二进制原文确认**：

```js
Dt.post(`/api/organizations/${m}/reset_rate_limits`,
  { program: "cedar_ember", grant_id: s, request_id: l },
  { auth:"async", headers:{"Content-Type":"application/json"}, timeout:25000, refreshOAuth:!0, credentials:a })
```

- `m` = OAuth 账号的 `organizationUuid`（没有就不发：`"[cedar-ember] no OAuth organization; cannot claim"`）。
- 头：`Authorization: Bearer <accessToken>`、`anthropic-beta: oauth-2025-04-20`、`User-Agent: claude-cli/<ver> (external, cli)`、`Content-Type: application/json`。
- 发送前本地校验 `grant_id ~ /^[a-z0-9_-]{1,40}$/`、`request_id ~ /^[A-Za-z0-9_-]{1,64}$/`，不合法拒发。
- **幂等键 = `request_id`**：`crypto.randomUUID()`；未确认的 claim 记 10 分钟（`Qn = 600000`），重试复用同一个 id。
- 只在 401 时刷新 token 后重试一次；HTTP 超时 25 s，外层等待 35 s。
- 响应（zod）：`result ∈ {reset, already_used, not_limited, cooldown, ineligible, unavailable}`（无法解析 → `unavailable`），`reason`（上面 11 种 + `paused, expired, unknown_grant, not_next_grant, grant_id_required, not_limited, already_used, cooldown, stamp_indeterminate, reset_unconfirmed`），`resets_left`、`cleared[]`、`weekly_resets_at`、`cooldown_until`。HTTP 429 → `rate_limited`，401/403 → `auth_error`，其它 → `error`。
- 同一端点还服务另一个 program `juniper_tide`（无 grant_id，周会话限额重置）。**本单只发 `cedar_ember`**，永不发 `juniper_tide`。

**「只在触顶时可用」**（原文）：`Ye(a,s){return !a.useRequiresLimit && !a.clears.some(l=>s.exhausted.includes(l))}` 判断「提前用」；`use_requires_limit=true`（默认）时未触顶领卡 → 服务端 `not_limited`，客户端文案「Your reset only works at a usage limit, and you're not at one now · nothing was used」——**什么也不花**。

**领卡成功后客户端做的事**（原文）：丢弃本地持有的 `cleared` 窗读数（`forgetHeldWindows`），把本地状态设为 allowed，再 `probeQuotaStatus` 读一次真实限额头。**客户端不自己写百分比**，新读数来自服务端。

**推断（未由原文证明，plan 用实测兜底）**：

1. 领卡成功后该号 `cleared` 里的窗读回 ≈0%。→ plan 在切号前**强制**读一次目标号 usage，窗必须回到阈值以下才切。
2. 服务端对 POST 是否也做 UA `surface` 校验——无法从客户端看出。→ 我们照搬 CLI 的 UA（本机真实版本），与 GET 一致。
3. 交互式 `/limit-reset` 是 `local-jsx` 命令，但端点本身是普通 OAuth REST，不依赖 TUI。

### 1.3 CLI 给人看的确认文案（原文，供卡片文案参考）

- 标题 `"Use your reset?"`；正文 `"Refills your {limits} now · your weekly reset day stays {week}"`；`"{resets} left · use by {deadline}"`；按钮 `"Yes, use my reset"` / `"No, keep it"`。
- 成功：`"Limits reset · your weekly reset day stays {week} · {resets} left"`。

⇒ **周重置日不变**：卡把窗清零，但下一次周重置时刻不动。这正是「挑自然重置最晚的号」的理由：离自然重置越远，卡换来的额外额度越多（离重置只剩 1 小时的号，用卡只多拿 1 小时的价值）。

## 2. 代码接入点（本分支 HEAD）

| 需求 | 现有构件 | 结论 |
|---|---|---|
| 判「在用号 ≥85%」 | `pollOnce` 每轮已读在用号 usage（`quota-monitor.ts`，`currentUsage.ok.fiveH/sevenD.pct`） | 复用；新增 `resetCardAskPct` 配置 |
| 判「没有可直接切的号」 | `verifyAndRankCandidates`（`account-candidate-selector.ts:160`）→ `ranked` 为空 | 复用同一函数，口径与正常切号一致 |
| 候选号的新鲜凭据 | `readVerifiedCredential`（`account-candidate-selector.ts:~124`，锁内 witness 校验 + `verifyCandidate` 新鲜度 + `readPoolCredential`） | 复用（导出一个窄包装），冷却中的号也要读 |
| 卡与 at_limit/exhausted | `parseClaudeResetGrants`（`claude-quota/account-detail-observer.ts:111`）只保留张数/到期 | 新写一个**只供本单用**的严格解析，保留 `id / clears / blocking / usable_now / paused / use_requires_limit / next_grant_id / at_limit / exhausted`；不改 2864 的解析与 store |
| orgUuid | `GET /api/oauth/profile` → `organization.uuid`（observer `parseProfile` 已做） | 复用解析逻辑（导出） |
| CLI 版本（UA） | `account-heal/claude-cli-version.ts readClaudeCliVersion` | 复用；版本 null ⇒ 不提议、不领卡 |
| 切号 | `switchAccount`（`switch-executor.ts:679`），CAS + 锁 + `commitSwitch` | 复用；新增窄输入「充值卡目标」只对那一个号忽略冷却，并在 commit 时清掉它的 `quotaExhaustedUntil / switchCooldownUntil` |
| 切后读数 | `refreshNewActive`（`quota-monitor.ts:1225`） | 复用，但本流程要求它返回「已更新且低于阈值」才算「新号可用」 |
| 全量重读 | FLY-2830 `switch-refresh-trigger`（未合入）看 `lastSwitch.generation` 变大 | 不接线；切号照常 +1 generation 即自动触发 |
| 问 founder | `checkReactionConfirmation`（`founder-confirmation.ts:122`）；`postDiscordMessageToChannel / editDiscordMessageInChannel / reactDiscordMessageInChannel`（`bridge/discord-utils.ts`）；`deriveCanonicalFounderId` | 复用；Bridge 在 GatePoller 的 `onLandOperationTick` 里挂一个自限流 `tick()`（同 `codexReadingScheduler.tick()` 的形态） |
| 唤醒守护进程 | `bridge/quota-daemon-wake.ts:68` `createQuotaDaemonWaker()` | 复用一个专用实例 |
| 告警 | `sendQuotaMonitorAlert`（`quota-monitor-alert.ts:209`）+ `ROUTING` + `lead-alert.sh` 的 plain 白名单 | 新增两个 kind（见 plan §5.6） |

### 2.1 跨进程交接：为什么用文件而不是 state 字段

- 守护进程与 Bridge 是**两个进程**（launchd vs Bridge），今天两者之间唯一的交接方式是 `~/.flywheel/` 下的文件 + SIGUSR1（FLY-2830 的 sweep-request 也是这个形态）。
- 不往 `quota-monitor-state.json` 加键：FLY-2830 正在给它追加 V2 键，同改一处必冲突；且 state 是守护进程私有，Bridge 不应读写。
- 采用**单写者文件**：每个文件只有一个进程写，另一方只读，免锁。写法沿用仓内现有「临时名 → fsync → rename」原子写，父目录 0700、文件 0600，读取前 `lstat` 拒软链、限大小、严格键白名单。

### 2.2 回滚安全

- `claude-accounts.json`：不加 triggerKind、不加键（`isAccountLastSwitch` 是闭集 + `hasOnlyKeys`，新值会让旧二进制判整个 store 非法）。用卡后的切号记为 `triggerKind:"quota"`，清冷却只改已有字段。
- 新文件对旧二进制不可见（旧代码不读）。回滚后遗留的「等待同意」提议文件无人消费，Bridge 旧版也不读 ⇒ 卡片停在 Discord 上但不会触发任何花卡动作（旧代码根本没有领卡代码）。
- `quota-monitor.json` 新增可选键：已核实 `parseConfig`（`quota-monitor-config.ts:78-139`）**忽略未知键**，只挑已知字段 ⇒ 旧二进制读到新键无影响。反方向同样要守住：新键值非法时**只让该键回落默认值**（照 `deadProbeStreak` 的写法），绝不能让整份配置判 invalid —— 那会把守护进程打进 monitor-only（永不切号），比没有本功能更糟。

## 3. 「预计能撑多久」的口径

- 输入：在用号本轮读数（`fiveH.pct`、`fiveH.resetsAt`）。5 小时窗开始时刻 = `resetsAt − 5h`；已用时长 `elapsed = now − windowStart`；用速 `rate = pct / elapsed`。
- 目标号用卡后 5h 窗从 0 开始：`runway5h = min(5h, 100 / rate)`。周窗：目标号 `clears` 含 `seven_day` ⇒ 周额度也清零，写「周额度也一并清零」；不含 ⇒ 写目标号周用量现值。
- `elapsed < 15 min` 或 `resetsAt` 缺失 ⇒ 「按当前用速估不出」。卡片上明示「按当前用速粗估」。

## 4. 风险与未知

| # | 风险 | 处理 |
|---|---|---|
| R1 | 推断 1（领卡后窗归零）不成立 | 切号前强制读目标号 usage；未降到阈值以下 ⇒ 不切、告警「卡已用但读数未恢复」 |
| R2 | POST 超时，不知道卡用没用 | 「服务端 10 分钟幂等」只是客户端行为，没有服务端证据 ⇒ **永不重发**（plan v3 I2）；只读核对 cedar_ember：`resets_left` 变少 = 已用；计数未变但窗已恢复 = 可用但未证实；仍触顶 = 不确定，告警，不切、不再发 |
| R3 | Discord 卡发不出（bot 无频道权限） | 同意状态写 `post_failed`；守护进程的 `quota_no_target` 告警正文追加「充值卡候选：<号>，但征询卡发送失败」；**不会**因此用卡 |
| R4 | founder 同意时事实已变（别的号自然重置了 / 她手动切了号） | 守护进程执行前全量复核（plan §5.4），任一不符 ⇒ 取消、不用卡、编辑卡片说明原因 |
| R5 | 同时 ✅ 和 ❌ | 按拒绝处理（保守） |
| R6 | Anthropic 改了合同 | 响应走严格 zod 式校验；未知 `result` ⇒ `unavailable`，不切，告警 |
| R7 | 2830 未合入时本单先合 | 切号后不会有全量重读，但 `refreshNewActive` 仍读新号；功能正确，只是额度页其它号晚一轮刷新。plan 记为依赖而非阻塞 |
