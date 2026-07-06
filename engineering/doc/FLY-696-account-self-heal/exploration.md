# FLY-696 账号自愈 — 探索

Issue: FLY-696 (https://linear.app/geoforge3d/issue/FLY-696/infraresilience-账号自愈-跨-provider-bot-自动切账号quota-用完时-手动-login-兜底)
日期: 2026-07-03
基于: 无

---

## 1. 问题 (Problem)

Flywheel 的 Claude Code Lead / Runner 跑久了会撞到账号的**订阅额度上限**:

- **5h 限**:滚动 5 小时窗口的用量上限。撞到后临时不可用,几小时后**回血**(账号没废掉整周)。
- **weekly (7d) 限**:滚动一周的用量上限。撞到后**这一周基本废了**,要等到该账号的 weekly reset 日才回。

今天撞到额度上限时:

- **Claude 侧**:长驻的 `claude` tmux 交互 session **不会退出**,只在屏幕上打印 `Claude usage limit reached. Your limit will reset at 9:00 PM`,并在状态栏渲染 `5h ██ 100% reset today 21:30 | 7d ██ 82% reset Mon 09:00`。`LeadWatchdog` 每 30s 扫 pane,把它归类成 `usage_limit`,`AutoRepairBot` 直接判 `needs_human`("Claude usage cap hit — needs an account top-up"),页 Annie。**没有自动切账号,人不在就卡死。**
- **Codex 侧**:`flywheel-codex-with-fallback` 在 codex 进程非零退出、输出含 `usage.?limit|429|rate.?limit` 时,调 `flywheel-codex-profile next` 轮转 `$CODEX_HOME/auth.json` 到下一个 pool profile 再重试。**但**:纯 shell、round-robin(无 5h/weekly 区分、无 reset-date 逻辑)、**无 Discord 通知**、只对一次性退出的 codex exec 起作用(Codex Runner),Codex Lead 不走它。

**核心痛点**:Claude 侧完全没有自动切账号能力;Codex 侧有一半(轮转)但盲、无通知、无 5h/weekly 智能。人不在时,一个账号 5h 撞顶 = 整条 fleet 卡到人回来。

## 2. 目标 (Annie MVP 定稿 2026-07-03)

Claude Code runner 的账号 5h / weekly 额度用尽 → **自动无感切到下一个可用 profile** + 在 **Flywheel Alerts** 发一条切换通知。

- **触发**:只在真 5h-limit 或 weekly-limit 用尽才切;临时 rate-limit / 529 那种**不管、立刻重试**(保留现有 `isTransientThrottlePane` 短路)。
- **切换逻辑(最大化 quota)**:
  - 5h 到 → 临时切走,过几小时那账号回血了**可以切回**。
  - weekly 到 → 切到「weekly reset **最近**」的账号(周五先用周一 reset 的,用完再周二…,这周别回已废的)。→ 需追踪每个账号的 weekly reset 日 + 当前 5h/weekly 状态。
- **账号池(4 个独立 Claude 账号)**:personal / school / business / shopping。
- **分期**:本 issue **MVP = quota → 自动切 profile + 通知**;「Infra Bot 接管所有 infra」= 之后 iterate;跟 **FLY-368** 统一 Alerts 对齐。

## 3. 现有基建盘点 (Codebase audit)

| 能力 | 现状 | 缺口 |
|---|---|---|
| 检测真额度上限 vs 临时 529 | ✅ `LeadWatchdog.classify()` + `isTransientThrottlePane()`(`packages/teamlead/src/LeadWatchdog.ts`) | 可直接复用 |
| 区分 5h vs weekly | ❌ 只有单一 `usage_limit` 桶 | 状态栏 `5h ██ NN% reset … \| 7d ██ NN% reset …` **今天无人解析**(fixture `usage-limit-real.txt:12` 已示精确格式);要新写 parser |
| Codex 账号轮转 | ✅ `flywheel-codex-profile` + `-with-fallback` + `codex-home.ts`(Runner-only、round-robin、无 reset 逻辑) | 无通知、无 5h/weekly 智能、Lead 不走 |
| Claude 账号轮转 | ❌ **完全没有** `flywheel-claude-profile` 等价物 | 要新建。FLY-572 的 Keychain→`.credentials.json` relocate 配方是**手工做的、没落成脚本** |
| Claude per-runner 隔离 auth home | ❌ `TmuxAdapter.ts` 零 `CLAUDE_CONFIG_DIR`/profile 注入(对比 `CodexTmuxAdapter`+`codex-home.ts`) | 要建 `claude-home.ts` 等价 |
| Discord 切换通知 | ✅ `AlertChannelHub` + `AutoRepairBot`(FLY-368)→ `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`("Flywheel Alerts") | `usage_limit` 现在硬编码 `needs_human`;要加一个「切账号」repair action(改 `AUTO_ATTEMPT_EVENT_TYPES` / `HUMAN_ONLY_REASON` + 锁定它们的测试) |
| 账号状态/reset 追踪 | ❌ 无(`token-usage` 包显式 out of scope) | 要新建小 state store(per-account 5h/weekly % + reset 日 + exhausted flag) |
| cross-provider "谁 down 另一个救" bot | 部分先例:FLY-368 的 Cass-fixes-everyone(`alert-bot-chain.ts`) | 两个字面 Infra Bot = 之后 iterate |

**关键约束**:`AutoRepairBot` 明确 "NEVER restarts/kills a Lead or Runner; those stay founder-gated (FLY-175)"。长驻 Claude session 撞顶后,换账号若需**重启进程**,受 FLY-175 founder-gate 约束且会丢 session 上下文(**不"无感"**)。

## 4. 关键技术未知 (决定架构方向,必须先 research spike)

**Q-核心:长驻 Claude session 撞顶后,能不能"无感"切账号而不重启进程?**

- Claude Code 的 OAuth 凭据存在 `$CLAUDE_CONFIG_DIR/.credentials.json`(或 macOS Keychain)。
- **若** Claude 每次 API 调用都重读 `.credentials.json`(而非进程启动时缓存到内存)→ 我们把该文件原子换成另一个账号的凭据,session 下一次请求就走新账号 = **真·无感**、不重启、不丢上下文。
- **若** Claude 把 token 缓存在内存整个进程生命周期 → 换文件无效,只能重启进程(founder-gated + 丢上下文)或走 pool 轮转(当前 session 等 reset,新 spawn 的 runner 用新账号)。

这个问题的答案**决定了整个"无感"能不能达成**,是 research.md 的第一优先 spike(真机验:跑一个撞顶 session,swap 凭据文件,看下一次请求走哪个账号)。

## 5. 需要 Lead/Annie 拍板的架构决策 (Decisions)

### D1 — 切换机制(取决于 Q-核心)
- **A. Pool 轮转 + 通知(保守、必然可 ship)**:检测到额度上限 → 在共享 Claude 账号 pool 里标记该账号 exhausted(带 reset)+ 切 active 指针 → **新 spawn** 的 runner/lead 用下一个账号;当前 session 等 reset(或走 founder-gated 重启)。通知 Alerts。
- **B. 热换凭据 + session 续跑(理想"无感",取决于 spike)**:swap `.credentials.json`,当前 session 下一次请求走新账号,零重启零丢上下文。
- **推荐**:先 spike 验 B;B 可行就上 B(fallback A),不可行就 A(诚实告诉 Annie"无感"退化为"新 runner 无感、当前 session 需等/重启")。

### D2 — 目标范围:Lead / Runner / 两者?
- 检测(`LeadWatchdog`)今天只覆盖 **Lead** pane;Codex 轮转只覆盖 **Runner**。二者错位。
- **推荐**:MVP 覆盖 **Claude Lead + Claude Runner 两者**(它们才是长驻烧额度的),用同一套 pool + state store + 通知;Codex 侧把现成 `flywheel-codex-with-fallback` 接上通知 + 5h/weekly 智能(增量,不重写)。

### D3 — cross-provider Infra Bot 是不是 MVP 必需?
- 「切 profile」本身是 **Bridge(Node 进程,不烧 Claude/Codex 额度)** 的操作,**不需要**一个独立的"Codex-Bot 去修 Claude" agent —— Bridge 永远在,不存在"自己修自己"问题。
- 需要 cross-provider **agent** 的是**手动 re-login 兜底**(所有账号都要重登时,Claude 全down 就得 Codex agent 去登)和"Infra Bot 接管所有 infra"—— 这些是 **iterate 阶段**。
- **推荐**:MVP 用现有 Bridge 侧 `AutoRepairBot`/`AlertChannelHub`/`LeadWatchdog` 落地自动切 + 通知;两个字面常驻 Infra Bot(含开 channel/re-login)列为 follow-up。**先跟 Tadashi/Annie 确认这个收窄不违背她的意图。**

### D4 — 账号池怎么建 & 手动 login 兜底
- 4 个账号各自一个 `CLAUDE_CONFIG_DIR` + `.credentials.json`(FLY-572 配方脚本化)。
- 首次 provision + token 过期 re-login = **人的动作**(Annie 在自己浏览器登),脚本只做 relocate/pool 组织。这是 issue 标题的"手动 login 兜底"。
- Discord 权限:列一份「有用+安全」清单(开 channel OK;删 channel/改权限慎)给 Annie 勾 —— **文档产物,不是代码**;授权那步她自己在 server 设置做。

### D5 — 状态存哪
- 新建小 store(mirror `codex-home` 风格的文件,或 `~/.flywheel/` 下一个 SQLite/JSON):per-account `{provider, 5hPct, 5hResetAt, weeklyPct, weeklyResetAt, exhausted}`。喂"下一个可用账号"选择(5h 临时 vs weekly 最近 reset)。

## 6. 建议的 MVP 切片 (待 gate 确认)

1. **5h/weekly 检测**:parse 状态栏 `5h/7d` gauge + "reset at" 文案,给 `usage_limit` 打 `scope: "5h" | "weekly"` + resetAt(保留 529 短路)。
2. **`flywheel-claude-profile`**(list/use/next/status)+ pool 布局 + provision/relocate 脚本(手动 login 兜底)。
3. **account-state store**:reset 追踪 + exhausted flag + "选下一个可用账号"逻辑(5h vs weekly 分治)。
4. **切换 action**:接入 `AutoRepairBot`(usage_limit → 切账号),机制取决于 D1(spike 后定 A/B)。
5. **通知**:`AlertChannelHub` 发 from→to 账号 + 原因(5h/weekly)+ reset 信息。
6. **不误切 529**:保留 `isTransientThrottlePane`。
7. **Discord 权限清单**(给 Annie 的 doc)。

## 7. 明确 out-of-scope (MVP)
- 两个字面常驻 cross-provider Infra Bot 做任意 infra。
- Infra Bot 自动开 Discord channel / 设权限。
- 全自动 re-login(所有账号过期时)—— 保留人工兜底。
- 若 spike 证明热换不可行,当前 session 的"完全无感续跑"退化为 pool 轮转 + founder-gated 重启。
