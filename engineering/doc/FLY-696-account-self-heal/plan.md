# FLY-696 账号自愈 — 实施计划

Issue: FLY-696 (https://linear.app/geoforge3d/issue/FLY-696/infraresilience-账号自愈-跨-provider-bot-自动切账号quota-用完时-手动-login-兜底)
日期: 2026-07-03
基于: research.md

> Rev 6 (Codex R5 全采纳,内部术语统一)。切换手段 = **A(Keychain swap,Tadashi 拍)**。**机械切换 MVP 只做 Claude**(Codex 保留现成 per-runner fallback + 加通知,不重写);re-login **只对 auth-expiry**(绝不对 quota-exhaustion)。评审历程:M1 核心 Codex R3+R4 APPROVED;R4 补 M2/M3(两 Infra Bot + re-login)8 项安全/契约;R5 补 provider-scope 收窄 + 术语统一。

---

## 1. 目标 & 范围

**MVP**:Claude fleet 撞 5h/weekly 额度上限 → Bridge 自动切下一个可用 Claude 账号 + Flywheel Alerts 通知;**两个常驻 cross-provider Infra Bot** 触发/协调切换 + 兜 **auth-expiry re-login**;临时 529/rate-limit 绝不切。

**In scope(MVP,内部三里程碑 M1→M2→M3)**
- **M1 — Bridge 核心切换(Claude)**:5h/weekly parser(绝对时间+tz)+ `flywheel-claude-profile` 账号池 + account-state store + Lead+Runner 检测 + **Bridge Claude 机械切换 executor**(Keychain swap + account-keyed CAS + flock)+ durable pending/watchdog 状态机 + AlertChannelHub 通知。M1 单独即可自动切(无 bot 时 watchdog 兜底)。
- **M2 — 两个 Infra Bot**:Codex-Bot / Claude-Bot 常驻 Alerts,cross-provider 触发/协调(机械切换交给 M1 Bridge executor,经专用 fail-closed 路由)+ 让 Annie 实时看切换状态。
- **M3 — auth-expiry re-login 兜底**:某账号 **token/auth 过期**(非 quota 耗尽)→ cross-provider bot 跑 re-login(自动能做的自动)+ `capture` 进池;撞 MFA/人工闸 → 结构化页 Annie(= "手动 login 兜底")。
- **Codex 侧(不重写,仅增量)**:现成 `flywheel-codex-with-fallback` per-runner 轮转保留 + 加**专用轮转通知事件**(轮转变可见)。**MVP Codex 无 Bridge 机械 executor**(它 per-runner 自轮转);Codex auth-expiry re-login 由 Claude-Bot 协调(M3)。
- 全 flag-gated(`FLYWHEEL_ACCOUNT_SELF_HEAL` 默认 off = 字节兼容)。
- Approach A operator-accepted runbook + Discord 权限清单(`discord-permissions.md`,已产出)。

**Out of scope(follow-up)**
- **Codex 的 Bridge 机械 switch executor**(与 Claude 同 rigor 的 fleet Codex 账号轮转)—— MVP 只 Claude 机械切换,Codex 保留 per-runner fallback。
- 自动重启当前卡住 session 到新账号(需 FLY-175 carve-out;当前 session 仍等 reset/founder 重启)。
- per-runner 并发多账号分流(需 `claude-home.ts`)。A = **全 fleet 单账号顺序轮转**,非并发吞吐;要并发 → B/per-slot follow-up。
- Codex 轮转的 5h/weekly 最近-reset 智能(先 round-robin)。
- Infra Bot"接管所有 infra"更广职责。

## 2. 架构总览

```mermaid
flowchart TD
    L[Claude Lead pane] -->|30s| W[LeadWatchdog.classify]
    R[Claude Runner pane] -->|RunnerQuotaDetector| W
    W -->|isTransientThrottlePane?| T{529 临时?}
    T -->|是| IG[忽略, 立即重试]
    T -->|否, 真 cap| P[parseUsageGauge pane,now,tz<br/>scope 5h|weekly|both, 绝对 resetAt<br/>ambiguous→null→needs_human]
    P --> EA[emitAlert usage_limit<br/>accountLimit: provider=claude, scope, resetAt,<br/>observedAccount, observedGeneration]
    EA --> HUB[AlertChannelHub → Flywheel Alerts thread]
    HUB --> PEND[写 durable account_switch_pending<br/>keyed sourceAlertId+observedAccount+generation + deadline<br/>贴 bot assignment]

    PEND -.对端 provider bot 认领.-> BOT[Codex-Bot 处理 Claude cap<br/>server gating 强制 actorBackend != provider]
    BOT -->|经专用 fail-closed 路由| ROUTE[Bridge /account-switch<br/>token 必需·不挂 /actions·audit]
    PEND -->|deadline 到无 bot 终态| WD[Bridge watchdog 兜底]
    WD --> ROUTE
    ROUTE --> SW[switchAccount executor Claude]

    SW --> LOCK[flock ~/.flywheel/claude-accounts.lock]
    LOCK --> CAS[CAS active==observedAccount?]
    CAS -->|否, 已切| NOOP[no-op: 已切 X→Y]
    CAS -->|是| SEL[selectNextAccount 5h临时/weekly最近/both]
    SEL --> PROF[flywheel-claude-profile use next<br/>Keychain 写无argv → verify]
    PROF -->|ok| ST[原子更新 state + bump generation]
    PROF -->|失败/锁| FC[fail-closed → needs_human]
    ST --> MSG[Alerts 贴 🔧 machine account switched personal→school<br/>5h reset 21:30;新 spawn 用新账号,当前 session 等 reset]
    MSG --> KEEP[线程保持 open 直到 pane 真恢复/founder 重启]

    AE[Claude/Codex auth 过期<br/>authExpired/refreshTokenInvalid/profileVerifyFailed] --> AEB[authLimit metadata]
    AEB -.对端 bot.-> RELOGIN[M3 re-login:隔离 Chrome 登录 + capture 进池<br/>撞 MFA→结构化页 Annie]

    subgraph Codex 增量-仅通知
      CX[flywheel-codex-with-fallback per-runner 轮转] -->|account-rotation 专用事件<br/>非 artifact_emitted| HUB
    end
```

## 3. 关键设计决策

| # | 决策 | 状态 |
|---|---|---|
| D1 | 机制 = pool 轮转(换共享凭据源,新 spawn 无感、当前 session 等 reset),非活进程热换 | ✅ 定 |
| D2 | Claude Lead+Runner 两侧检测 + **Bridge 机械切换只做 Claude**;Codex 增量只加通知(不重写) | ✅ 定(Tadashi + Codex R5) |
| 切换手段 | **A. Keychain swap** | ✅ Tadashi 拍(§3.1);Annie 有 veto 窗口 |
| D3 | 两个字面 Infra Bot in-scope,触发/协调 + auth-expiry re-login | ✅ Annie 拍;机械切换交 Bridge |

### 3.1 Approach A(Keychain swap)
换 Keychain 条目 `Claude Code-credentials`。机器级(改本机所有 Claude Code 活跃账号)—— 但 Annie 现只经 Fleet 用 Claude、不自己敲 `claude`,故"连她终端一起切"这个 A 唯一缺点不成立 → A 更简单够用(Tadashi 拍)。
- **caveat(进 PR)**:A = 全 fleet 单账号顺序轮转,非并发多账号;要并发 → B/per-slot,follow-up。
- **veto**:Annie 可改 B(Tadashi relay)→ 现在先铺核心+契约,别抢跑 A-specific 破坏性 Keychain 写。
- **QA 硬要求**:必须覆盖"别把 claude 登录写坏/写脏"(verify-before-commit + fail-closed + 真机)。
- 启用硬门:provision 进池 → `status` 显示机器活跃/来源 → runbook 回滚 → 起 2 Infra Bot → 设 flag → 重启 Bridge。通知写 "machine active Claude account switched X→Y"。

### 3.2 D3 — 两个 Infra Bot 分工
- cross-provider:Claude cap/auth-expiry → **Codex-Bot** 处理;Codex cap/auth-expiry → **Claude-Bot** 处理。避免自修自,**server-side 结构强制**(C8b gating,非 prompt)。
- 机械切换仍交 Bridge(Node,不烧额度,永远在,可 CAS/flock);bot 独特价值 = ① 协调/可观测 ② **auth-expiry re-login**(要 agent 开浏览器,Bridge 干不了)。
- 部署:**复用 companion-Lead launcher/launchd 机制**,但 capability = **新 infra-bot profile 非 companion**(companion 清掉的正是 infra-bot 要的高权面,见 C8a);persona **精简**(infra bot 非聊天 agent)。
- **Codex cap 特例**:Codex 无 Bridge 机械 executor(它 per-runner 自轮转)→ Codex cap 时 Claude-Bot 的角色 = 观测/通知可见 + Codex **auth-expiry** re-login 协调,**不**调 Bridge 机械切换(Codex 不需要)。
- re-login 诚实边界(Tadashi):自动能做的自动;撞 Google OAuth **MFA/人工闸 → 结构化页 Annie**。**明确不追全自动过 MFA**(① MFA 本需真人 ② 自动绕 MFA = 安全反模式)。优化人在环:给 Annie 上下文齐全、尽量预填的页/链接,她只点一下 MFA。

### 3.3 硬边界 — 只在 🔴 真配额耗尽才切(founder + Lead 拍定,0e83cb38)
账号轮转**只**在 🔴 真·5h / weekly 配额用尽时触发。**🟡 普通限流 / 🟠 529 Room-busy = 原地重试,绝不换账号** —— 换账号解决不了瞬时限流,还白烧一次轮转、可能把好账号也拖进冷却。
- 这是 detection 的**核心判据**(不是边角 case):`isTransientThrottlePane()`(+ 其反遮蔽守卫)在 `parseUsageGauge`/switch 之前短路,命中即"原地重试"、零切换、零 Keychain 变动、零 pending 记录。
- parseUsageGauge 只在过了 529 短路后、且 gauge 明确 100% 时才给 `scope`(否则 null → needs_human,也不切)。
- QA(§8 #4)+ 单测显式验:🟡/🟠 注入 → 零切换。这条是**红线**,与"别把 claude 登录写坏"并列。

## 4. 组件分解

### M1 — Bridge 核心切换(Claude)

#### C1 — `flywheel-claude-profile`(bash)— Codex R1#3 / R2#1
`packages/claude-runner/bin/flywheel-claude-profile`:`list/status/use <name>/next/capture <name>`。Pool `${FLYWHEEL_CLAUDE_PROFILES_DIR:-~/.flywheel/claude-profiles}`(0700,拒 symlink),每账号 `<name>/.credentials.json`(0600)。
- **`use <name>` 无 argv 泄密**:凭据绝不进 argv;实现路径 = 小 Node/native Keychain helper(password 从 0600 文件/stdin 私道读)。**删 `-X`**(hex 仍进 argv)。绝不 `-w "$(cat)"`。
- **verify-before-commit**:写 Keychain 后读回校验才更 `.active`/state;否则非零+stderr → fail-closed。
- **`capture <name>`**:`security find … -w` → temp+fsync+rename 落 pool(0600,拒 symlink)。
- 写 Keychain/`.active` 前先拿 flock(§C5)。
- 单测:mock,use/next/capture/空池/单账号/权限位/symlink 拒/verify 失败/无 argv。

#### C2 — parser + account-state(TS)— Codex R1#5
- `usage-gauge.ts`:`parseUsageGauge(pane, now, timezone)` → `{fivehPct, weeklyPct, fivehResetAt:ISO|null, weeklyResetAt:ISO|null, scope:"5h"|"weekly"|"both"|null, confidence}` | null。绝对 ISO(`today 21:30`/`Mon 09:00`+TZ,跨日/跨 host-tz 不漂);both→"both"(选择时 weekly 主导);ambiguous/缺失→null→needs_human。fixture(已建):`usage-limit-real.txt`(5h=100%/7d=82%→scope=5h)、`usage-limit-weekly.txt`、`usage-limit-both.txt`、`usage-gauge-ambiguous.txt`。
- `account-store.ts`:`~/.flywheel/claude-accounts.json`(含 `generation`);`selectNextAccount(state,{scope,currentName,now})`:双重过滤 `quotaExhaustedUntil`(5h+weekly);weekly/both 挑 weeklyResetAt 最近(unknown 最悲观);5h 挑非当前已回;全废→null(+最早 next reset)。全分支单测。

#### C3 — Lead 检测:`LeadWatchdog` 附 accountLimit metadata — Codex R1#2/#6, R4#4/R5#3
`usage_limit` 命中调 parser,塞 `AlertMetadata.accountLimit = {provider:"claude", scope, resetAt, observedAccount, observedGeneration}`(**含 provider,在 producer 处加**)。parser null→emit 但无可切 metadata→needs_human。`isTransientThrottlePane` 短路+反遮蔽守卫不动。单测:5h/weekly/both/ambiguous/529,且断言 `provider:"claude"`。

#### C4 — Runner 检测:`RunnerQuotaDetector` — Codex R1#1
复用 `RunnerIdleWatchdog`(FLY-92)采集骨架,对 Claude runner pane 跑同一短路+parser;命中真 cap → emit(accountLimit 含 `provider:"claude"` + execution/session 身份 + observedAccount/generation)。当前 runner 不自动重启。单测:runner cap→emit(provider:"claude");529→不 emit。

#### C5 — Claude switchAccount executor + CAS + flock — Codex R1#2, R2#2/#3, R5#4
- **`switchAccount(input)` 机械 executor**(仅 Claude):
  1. **flock**(`~/.flywheel/claude-accounts.lock`)—— Node executor 与 bash `flywheel-claude-profile use/next` 都先拿锁,罩住 读active→CAS→select→Keychain写+verify→更state 整条临界区。
  2. 读 active → **CAS** `active===observedAccount`? 否→no-op(不重复切/不误标 exhausted);是→`selectNextAccount`→`flywheel-claude-profile use`(verify-before-commit)→原子更 state(旧账号 `quotaExhaustedUntil`,bump generation)。
  3. **crash 恢复**:标 state pending→写 Keychain+verify→提交 `.active`+bump;"Keychain 变 state 未提交"→下次持锁 reconcile(`.active`/Keychain 为 active 权威)。
  4. profile-use 失败/锁/verify 不过→fail-closed,state 不变,needs_human。
- **触发不再即时**(见 C8c):account-cap **不**走今天 `AlertChannelHub → bot.attempt()` 即时流。`canAttempt`/`repairDisposition(payload)` 对 account-cap 返回 **"pending/assigned"**(写 durable pending 记录),**不**立即 switch。真正 `switchAccount` 由 ① bot 经 C8b 路由认领执行,或 ② Bridge watchdog deadline 后兜底。M1-only(无 bot)= deadline 短,watchdog 及时切。
- **`canAttempt` payload-aware**:`canAttempt(payload)`;`AlertChannelHub` 传整 payload;判定共用(ack 不漂移)。flag off / parse-null / 全废 / CAS-fail-closed → needs_human。
- 改锁定测试 + reverse-compat sentinel。

#### C6 — 通知复用 AlertChannelHub + 不误 resolve — Codex R1#6
attempt/switch detail 贴 Alerts。**account_switch 不 resolve 线程**(pane 仍卡,直到真恢复/founder 重启;weekly 可能挂几天,文档写明)。**改 `bodyFor`** 接受 accountLimit:self-heal on→"usage cap hit;account switch pending/attempted";off→原"Top up billing"。

#### C7 — Codex 增量:专用轮转通知事件 — Codex R1#4
新增 `flywheel-comm account-rotation-notify`(Bridge drain→`LeadAlertNotifier`/`AlertChannelHub`),payload=`provider:"codex"`/from/to/reason/resetAt/context,无 runner 身份也安全。`flywheel-codex-with-fallback` 轮转分支发它,不动 exit-and-retry 核心。单测:轮转发新事件(非 artifact_emitted)+ `provider:"codex"`。

### M2 — 两个 Infra Bot(D3)

#### C8a — infra-bot capability profile(非 companion)— Codex R4#1
显式 `codex-infra-bot`/`claude-infra-bot`:复用 companion launcher/launchd 机制,capability **非 companion**(companion 清 `TEAMLEAD_API_TOKEN`/`BRIDGE_URL`/`FLYWHEEL_COMM_*` + 只给 `discord_send`,正好是 infra-bot 要的)。Codex-Bot 窄工具 = 仅 `account_switch_request`+`account_relogin_request`;Claude-Bot noncompanion infra role 窄 MCP/env。`ProjectConfig` 加校验防误当普通 companion/eng Lead。

#### C8b — 专用 fail-closed Bridge `account-switch` 路由 — Codex R4#2/#4, R5#1
- **不用**通用 `createActionRouter`(它 `/actions` 无 auth、`tokenAuthMiddleware` 无 token 时 no-op)。
- 新专用路由/命令:**`TEAMLEAD_API_TOKEN` 必需否则 503**、**不挂 `/actions`**、仿 founder-consent tokenless-503 前例。body 必带 `provider`、`observedAccount`、`observedGeneration`、`scope`、`resetAt`、`sourceAlertId`、`actorBotId`、`actorBackend`。
- **server-side provider gating**:拒 `actorBackend===provider`(自修自)除非 operator override → Claude cap 只 Codex-Bot 能调。
- **MVP 只接受 `provider:"claude"`**(Codex 无 Bridge 机械 executor;传 codex → 400/未支持)。idempotency-keyed;switch 前后 audit row;内部落 C5 `switchAccount`。

#### C8c — durable bot-timeout 状态机 — Codex R4#3, R5#4
account-cap 流程:alert 开线程 → 贴 **bot assignment** → 写 **durable `account_switch_pending`**(StateStore,keyed `sourceAlertId+observedAccount+generation`+deadline)→ bot 经 C8b 路由认领执行 → **Bridge watchdog 仅 deadline 后、无 bot 终态**才兜底(重启不丢)。CAS 保双触发只切一次;ack 与状态机不漂移。M1-only:deadline 短,watchdog 即时兜底。

#### C8d — inbound resident bot 设计 — Codex R4#8
FLY-368 `alert-bot-chain`/`AlertChannelHub` 是**出站**,非常驻 bot 入站派发器。明确:这俩 bot 是否 `projects.json` Lead runtime、订阅哪些 channel、**不回自己/对方状态帖**(bot-authored 过滤+loop 防护)、thread 路由、消费**结构化事件**(非爬散文)、与 Bridge 帖 dedup。测:bot-authored alert / status 帖 / 重复更新 / 重启 stale 重放。

### M3 — auth-expiry re-login 兜底(不碰 quota)

#### C9a — auth-expiry vs quota-exhaustion 分离 — Codex R4#5/#6, R5#2
- **re-login 只对 auth 过期,绝不对 quota 耗尽**(quota token 仍有效,只靠时间/换账号)。
  - `quotaExhaustedUntil`/`allQuotaExhausted` → 等/reset 或页 Annie,**绝不 auto-login**。
  - `authExpired`/`refreshTokenInvalid`/`profileVerifyFailed` → **re-login 候选**。
  - `unprovisionedAccountAvailable` → 可选人工 provision。
- **`authLimit` metadata**(与 `accountLimit` 并列):`provider`、`observedAccount`、`observedGeneration`、`evidence`。产生者 = LeadWatchdog `login_expired` 分类 映射到 pool profile + observed account;切换后 active 可能已变 → generation 防误标错 profile。
- re-login 先拿 `~/.flywheel/claude-accounts.lock` 才 `capture`/更 state;verify captured 才清 `authExpired`;generation 变则 no-op(除非显式 reconcile)。

#### C9b — re-login 具体浏览器/安全契约 — Codex R4#7 + Tadashi
硬门 tool/runbook:隔离 browser profile(per provider/account,除非 Annie 显式接受默认 Chrome,参照 `visual-capture` agent-browser profile hook);per provider/account 一把 relogin 锁;secret 不进 argv/env/日志/截图;bounded timeout;登录新鲜度证明;`flywheel-claude-profile capture` 在 account 锁内 verify-before-commit;撞 MFA → 结构化页 Annie(上下文齐全+尽量预填,她只点一下 MFA);Chrome 进程 cleanup;**明确不追全自动过 MFA**;**mock Chrome 不够 → M3 上线前真机 QA gate**。fail-closed:失败不静默,页 Annie。

#### C10 — Discord 权限清单(已产出 `discord-permissions.md`)+ Approach-A runbook

## 5. 契约 & 数据变更
- `AlertMetadata` 加 `accountLimit?:{provider:"claude"|"codex"; scope:"5h"|"weekly"|"both"; resetAt:string; observedAccount:string; observedGeneration:number}`(可选,向后兼容;provider 在 producer C3/C4/C7 处填)。
- `AlertMetadata` 加并列 `authLimit?:{provider; observedAccount; observedGeneration; evidence:string}`(M3)。
- `AutoRepairBot.canAttempt` → `canAttempt(payload)`;`AlertChannelHub` 传整 payload;account-cap 返回 pending/assigned(非即时 switch)。`RepairResult.action` 增 `"account_switch"`。
- account-state 字段:`quotaExhaustedUntil`/`allQuotaExhausted` vs `authExpired`/`refreshTokenInvalid`/`profileVerifyFailed`(**不用**单一 `needsRelogin`);`generation`。
- 新 `~/.flywheel/claude-accounts.json` + `.lock`(flock)+ `account_switch_pending` StateStore 记录(durable)。
- 新 pool `~/.flywheel/claude-profiles/`(0700)。
- **新专用 Bridge 路由 `account-switch`**(token 必需否则 503,不挂 `/actions`,server-side provider gating,**MVP 仅 `provider:"claude"`**,idempotency,audit)。
- 新 comm 事件 `account-rotation-notify`(`provider:"codex"`,Bridge 路由 Alerts)。
- 两 infra-bot capability profile + `ProjectConfig` 校验 + launchd(复用 companion launcher)+ bot token env + 精简 persona 文件。

## 6. Flags & byte-compat
- `FLYWHEEL_ACCOUNT_SELF_HEAL`(默认 off):off = `usage_limit` 走今天 needs_human,`canAttempt`/`attempt` 不认它,bodyFor 原文案,无 pending/bot → **字节兼容**(reverse-compat sentinel)。
- 依赖既有 `FLYWHEEL_AUTO_REPAIR=1` + AlertChannelHub(FLY-368 前置)。
- 上线硬门(§3.1):provision → Annie 接受 → 起 2 Infra Bot(launchd)→ 设 flag → 重启 Bridge。

## 7. 测试策略(TDD)
- **纯函数 RED→GREEN**:parseUsageGauge(5h/weekly/both/ambiguous/tz/跨日)、selectNextAccount(全分支+unknown resetAt+全废)、bash script(mock,verify-fail/symlink 拒/无 argv)。
- **集成(M1)**:switchAccount(mock profile bin)flock+CAS;**双触发(两 Lead / Lead+Runner / bot+watchdog 同 tick)→ 只切一次**;profile-use 失败→fail-closed;parse-null→needs_human;`canAttempt(payload)` account-cap 返回 pending(非即时);flag-off→needs_human;accountLimit `provider:"claude"`。
- **状态机(M1/M2)**:account_switch_pending 写入→bot claim 成功;bot 超时→watchdog 兜底;**Bridge 重启恢复 pending 记录**;bot 与 watchdog race→CAS no-op。
- **Infra Bot(M2)**:C8b 路由 token 缺→503;`actorBackend===provider`→拒;`provider:"codex"`→拒(MVP);inbound bot-authored/status-post/重复更新/重启 stale 重放。
- **re-login(M3)**:`authExpired`→对端 bot re-login(mock Chrome);**`allQuotaExhausted` 不触发 re-login**(断言只等/页 Annie);MFA→结构化页 Annie;失败→页 Annie 不静默;generation 变→no-op。
- **529 不误切** + **reverse-compat sentinel**。覆盖 ≥ 基线。

## 8. 独立 QA(真机,gate ship)
1. 切换机制:注入 5h cap pane→Keychain 真变→新 claude 读新账号。
2. **不写坏 claude 登录**(Tadashi 硬要求):切换前后 claude 仍能正常认证;verify-before-commit 生效;写脏→fail-closed 不落。
3. 通知 + 不误 resolve:Alerts 现 🔧 + 线程仍 open。
4. 不误切 529。
5. 双触发幂等(两 Lead/Lead+Runner/bot+watchdog)→ 只切一次。
6. runner-only cap → 仍切。
7. Keychain 锁/写失败 → fail-closed needs_human。
8. argv 无泄密(`ps`/审计确认 refresh token 不在 argv)。
9. parse 失败 → needs_human。
10. weekly 最近-reset 选择 + both weekly 主导。
11. 全废 → needs_human 带最早 reset(**不 re-login**)。
12. Codex 轮转 → 新 account-rotation 事件到 Alerts(非 artifact_emitted,`provider:"codex"`)。
13. **状态机重启恢复**:pending 记录跨 Bridge 重启不丢,watchdog 正确兜底。
14. **Infra Bot(M2)**:真机 —— Claude cap → **Codex-Bot** 协调/触发切换(不是 Claude-Bot 自修);C8b 路由拒 `actorBackend===provider` + 拒 codex;Annie 能看到。
15. **re-login(M3,真机 gate)**:模拟 **authExpired** → 对端 bot 起隔离 Chrome re-login;MFA 分支真结构化页 Annie;`allQuotaExhausted` 不触发 re-login。
16. byte-compat:flag-off → usage_limit 仍 needs_human + 原文案。
> 真 usage limit 难强制 → 注入 pane + 真 Keychain/真新-claude 端到端(mock 不算)。

## 9. 风险 & 开放项
- **切换手段 A(机器级)Annie 有 veto 窗口** → 先铺核心+接口,别抢跑 A-specific 破坏性写。
- **两 infra-bot profile 落地风险**(Codex R5#5):新 profile 要对上现有 launcher/runtime 约束(companion 清权面),实现+校验+真机验。
- **re-login 自动化最险**:版本敏感+MFA 需真人 → 诚实=自动+人在环,不追全自动;M3 上线前真机 QA gate。
- **Codex 无 Bridge 机械 executor(MVP)**:Codex cap 靠 per-runner fallback + 通知;要 Bridge Codex executor = follow-up。
- **Keychain 锁定态**:launchd Bridge keychain 锁→fail-closed needs_human(实现期确认)。
- **契约测试变更**:预期,同 PR 改 + Codex code review。
- **MVP 体量大**:M1→M2→M3 内部顺序,Annie 可增量看到(M1 先可观测)。
- **weekly-cap 线程长挂**:切账号不 resolve 原线程,文档写明,非 bug。

## 10. 交付物清单(MVP PR;M1→M2→M3)
- [ ] M1: `flywheel-claude-profile`(无 argv+verify+0700)/ `usage-gauge.ts`+`account-store.ts`(+fixtures)/ `runner-quota-detector.ts` / `LeadWatchdog` accountLimit(provider)+bodyFor / `switchAccount`+CAS+flock+durable pending+watchdog / `canAttempt(payload)` account-cap→pending / `account-rotation-notify`+codex hook / 单测+集成+sentinel
- [ ] M2: 两 infra-bot profile(C8a)+ 专用 `account-switch` 路由(C8b,Claude-only+gating+503)+ durable 状态机(C8c)+ inbound bot(C8d)+ launchd/persona + 测试
- [ ] M3: auth/quota 分离(C9a)+ re-login 浏览器安全契约(C9b)+ capture 进池 + 真机 QA gate + 测试
- [ ] `discord-permissions.md`(已产出)+ Approach-A runbook
- [ ] 归档 doc(exploration/research/plan git mv 到 archive 随主 PR 末 commit)

## 11. RESUME ANCHOR — fresh 接力锚点(2026-07-04)

**分支 `flywheel-FLY-696`,11 commits,全绿(179 tests,biome + tsc-strict clean,零 FLY-368 回归)。所有 FLY-696 代码在 `packages/teamlead/src/account-heal/` + `LeadWatchdog` 接线 + `AutoRepairBot` seam。整个 M1 切换机器已建完;剩 live 集成 + A 脚本 + M2 + M3。**

### ✅ 已建 + TDD + committed(M1 机器)
- `usage-gauge.ts`(parser,tz/DST 绝对时间)· `account-store.ts`(selectNextAccount 最大化-quota + 原子 IO)· `account-limit.ts` + `derive-account-limit.ts`(pane→accountLimit metadata,含 provider + CAS 快照 + tz 抽取)· `switch-executor.ts`(`switchAccount`:flock+CAS+fail-closed+crash-recovery reconcile)· `mkdir-lock.ts`(`withMkdirLock` 跨进程跨语言锁)· `pending-store.ts`(durable `account_switch_pending`,upsert/resolve/claim/duePending)· `account-switch-repair.ts`(`makeAccountSwitchRepair`={canAttempt,enqueue,executeSwitch})
- `AlertMetadata` 加 `accountLimit`/`authLimit`(byte-compat) · `LeadWatchdog.emitAlert` flag-gated 附 accountLimit(529 守卫未碰) · `AutoRepairBot.canAttempt(payload)` + usage_limit→`accountSwitch.enqueue`(**accountSwitch 是 optional dep → 未接线=字节兼容**) · `AlertChannelHub` 传整 payload
- `discord-permissions.md` · plan §3.3 硬边界

### ⏭️ 剩余(fresh 按序)
1. **plugin.ts 组装真 accountSwitch**(点亮 seam):`plugin.ts:3727` `new AutoRepairBot({...})` 处,gated on `FLYWHEEL_ACCOUNT_SELF_HEAL=1` + provisioned pool,构造 `makeAccountSwitchRepair({ switchDeps:{ withLock:withMkdirLock, applyProfile:(name)=>execFile flywheel-claude-profile use name, readActiveProfile:()=>flywheel-claude-profile status } })` 传入 `accountSwitch`。deadlineMs 默认 20s。
2. **watchdog**(点亮 enqueue→switch):piggyback 现有 poll(`LeadWatchdog.onPollComplete` 或 `AlertChannelHub.reconcile` 的 30s cadence,别加新 timer)→ `readPending` → `duePending(now)` → 每条 `accountSwitch.executeSwitch(pending)` → 结果贴回 alert 线程。restart-safe(pending 落盘)。
3. **RunnerQuotaDetector**(C4,边角:共享账号下 LeadWatchdog 已覆盖核心):扫 active Claude runner pane(复用 `RunnerIdleWatchdog` 采集骨架)→ `isTransientThrottlePane` 短路(§3.3)+ `parseUsageGauge` → 命中 cap 用 `deriveAccountLimitForAlert` emit usage_limit alert(带 runner 身份)→ 同 notifier → AutoRepairBot enqueue。
4. **account-rotation-notify**(C7):新 `flywheel-comm account-rotation-notify`(provider/from/to/reason/resetAt,**非** artifact_emitted)+ Bridge route → LeadAlertNotifier/Hub;hook 进 `flywheel-codex-with-fallback` 轮转分支。Codex 轮转可见。
5. **`flywheel-claude-profile` bash(A Keychain,最后隔离 commit + 红线 QA)**:仿 `packages/claude-runner/bin/flywheel-codex-profile`;`list/status/use <name>/next/capture <name>`;`use`=Node/native Keychain helper 写(**凭据绝不进 argv**,删 `-X`)+ verify-before-commit + 拿 `withMkdirLock`(`~/.flywheel/claude-accounts.lock`);pool `~/.flywheel/claude-profiles/<name>/.credentials.json`(0700,拒 symlink)。**红线:切账号绝不写坏 claude 登录**(verify + fail-closed + 真机 QA)。
6. **byte-compat sentinel**:`FLYWHEEL_ACCOUNT_SELF_HEAL` unset = 现状(usage_limit→needs_human,bodyFor 原文案)—— 加 reverse-compat 测试。
7. **M2**(C8a-d):两 infra-bot capability profile(非 companion,复用 companion launcher)+ 专用 fail-closed `/account-switch` 路由(token 必需、不挂 `/actions`、server provider gating、MVP 仅 claude)+ bot inbound(loop 防护、消费结构化事件)。bot claim pending → executeSwitch。
8. **M3**(C9a-b):auth-expiry(authLimit metadata,与 quota 分离,**re-login 不修 quota**)+ 隔离 browser re-login(参照 `visual-capture` profile hook,secret 不泄、MFA 结构化页 Annie,不追全自动过 MFA)+ 真机 QA gate。
9. **独立 QA**(§8 全 16 项,含红线"不写坏登录" + 双触发幂等 + 不误切 529)→ **M1 完整开 PR,hold 等 batch,不 self-ship**。

### fresh 注意
- `accountSwitch` optional dep 是点亮开关;`applyProfile`=A 脚本(第 5 步,最后)。
- 别碰 `LeadWatchdog` 的 529/masking 守卫(FLY-218/220)。
- teamlead 测试从 `packages/teamlead/` 内跑(root cwd 会 resolver 找不到 better-sqlite3)。
- Codex design review 6 轮 APPROVED(design-review.json 已写);实现完走 code review + 独立真机 QA。

### PROGRESS 2026-07-04b — ①②③ 已做完 + pushed(分支 flywheel-FLY-696,~19 commits,全绿)
**M1 self-heal 环已端到端接线(dormant/byte-compat,等 A 脚本+flag 点亮)**:Lead cap → accountLimit metadata → AutoRepairBot **enqueue** → durable pending → **watchdog executeSwitch**(piggyback `onPollComplete`)→ switchAccount → post Alerts。
- ✅ **①** plugin.ts 组装:`claude-profile-cli.ts`(SwitchDeps:applyProfile=`flywheel-claude-profile use`,readActiveProfile=`status`,execFile **arg-array 无 shell**)+ plugin.ts hoist `accountSwitchRepair`(gated)+ `alertDiscordOps` 共用,接进 AutoRepairBot。
- ✅ **②** watchdog:`account-switch-watchdog.ts`(`accountSwitchWatchdogTick`:duePending→executeSwitch→post,best-effort 不 wedge)+ plugin.ts `onPollComplete` piggyback(30s,无新 timer)。
- ✅ **③** `runner-quota-detector.ts`(`detectRunnerQuotaCap`:§3.3 transient 短路 + 共享 metadata builder)—— **纯决策已建**;**剩 live scan wiring**:piggyback `RunnerIdleWatchdog` 的 runner-pane 采集(它已 `createStatusQuery` 采 active runner),每 pane 跑 `detectRunnerQuotaCap` + emit usage_limit alert(带 runner 身份,provider:"claude")经同 notifier → AutoRepairBot enqueue。(边角:共享账号下 Lead 也会撞到同一 cap,LeadWatchdog 本就覆盖核心。)

### ⏭️ 剩余(fresh 接,按序)
- **④ account-rotation-notify**(跨包):新 `flywheel-comm account-rotation-notify`(provider/from/to/reason/resetAt,**非** artifact_emitted)+ Bridge route → LeadAlertNotifier/Hub;hook 进 `packages/claude-runner/bin/flywheel-codex-with-fallback` 轮转分支。Codex 轮转可见。
- **⑤ `flywheel-claude-profile` bash(A Keychain,最后隔离 commit + 红线 QA)—— 🔴 关键难点 = 无 argv 泄密的 Keychain 写**:macOS `security add-generic-password -w '<json>'` 会把凭据放进 argv(`ps` 可见)。安全路径(需**真机验证**):`-w` 交互从 tty 读不可脚本化;`-X`=hex 仍进 argv(删);候选 = 小 Node/native helper 用 Security framework(或验证 `security` 能否从 stdin/私道读)。verify-before-commit(读回校验)+ 拿 `withMkdirLock`(`~/.flywheel/claude-accounts.lock`,与 Node 侧同锁)。pool `~/.flywheel/claude-profiles/<name>/.credentials.json`(0700 拒 symlink,0600)。**红线:切账号绝不写坏 claude 登录 → verify + fail-closed + 真机 QA**。仿 `packages/claude-runner/bin/flywheel-codex-profile`。**这块最需要 fresh context + 真机验 no-argv,别赶**。
- **⑥ byte-compat sentinel** + **⑦ M2 两 bot**(C8a-d)+ **⑧ M3 re-login**(C9a-b)+ **⑨ 独立 QA(§8)→ M1 PR、hold 等 batch、不 self-ship**。

### PROGRESS 2026-07-04c — ⑥ + ④(emit side)已做 + pushed(分支 20 commits,全绿)
- ✅ **⑥** reverse-compat sentinel(`account-selfheal-bytecompat.test.ts`):flag unset(真 env 默认)→ canAttempt false + enqueue needs_human = 字节兼容,守 dormant-by-default。
- ✅ **④-a**(emit)`packages/flywheel-comm/src/commands/account-rotation-notify.ts`:POST `/events` event_type=**`account_rotation`**(非 artifact_emitted,Codex R1#4)payload=provider/from/to/reason/resetAt;fail-closed 缺 bridgeUrl、fail-loud 非2xx、Bearer ingest token;4 测(mock fetch)。
- ⏭️ **④ 剩 3 小块**(fresh 接):
  1. **CLI 注册**:`packages/flywheel-comm/src/index.ts` 加 `case "account-rotation-notify"` + arg 解析(--provider/--from/--to/--reason/--reset-at/--bridge-url/--exec-id)+ help 行。
  2. **Bridge /events handler**:teamlead Bridge 的 `/events` 处理里(plugin.ts 或 event-route)加 `event_type==="account_rotation"` 分支 → 用 `alertDiscordOps.postToThread(unifiedAlertChannelId, "🔁 Codex 账号轮转 from→to（reason, reset …）")`(与 watchdog 同 post 路径)。
  3. **bash hook**:`packages/claude-runner/bin/flywheel-codex-with-fallback` 三个 `"$PROFILE_BIN" next` 之后各加一条 `flywheel-comm account-rotation-notify --provider codex --to "$(...status)" --reason "<rate_limit|auth_expired|model_unsupported>"`(best-effort、`|| true` 不阻塞轮转)。

### 🔴 ⑤ A-Keychain 脚本 = fresh + 真机(Tadashi 确认)
`security add-generic-password -w '<json>'` 明文进 argv(ps 可见);`-X` hex 也进 argv;`-w` 放最后不带值走 tty getpass(从 /dev/tty 读、非 stdin、脚本化不确定)→ **安全 no-argv 路径必须真机验证** + 红线 QA「切账号绝不写坏 claude 登录」。别在高 ctx 赶。仿 `flywheel-codex-profile`;`use` 拿 `withMkdirLock`(`~/.flywheel/claude-accounts.lock`)+ verify-before-commit;pool `~/.flywheel/claude-profiles/<name>/.credentials.json`(0700 拒 symlink,0600)。点亮 = 设 `FLYWHEEL_ACCOUNT_SELF_HEAL=1` + `FLYWHEEL_CLAUDE_PROFILE_BIN` 指向脚本 + provision 账号进池 + 重启 Bridge。

### PROGRESS 2026-07-04d — M1 全部代码完成(④③⑤ 收尾 + 真机 spike + 开发侧 QA 冒烟 PASS)
**M1 剩余三块全部 committed(a50ccf19 ④ / e49d9e26 ③ / a34540da ⑤),195+ 相关测试绿,tsc-strict + biome clean。**
- ✅ **④ 完成**:CLI 注册(`flywheel-comm account-rotation-notify`,parseArgs+help)+ Bridge `/events` `account_rotation` 分支(fleet-global,在必填字段校验**之前**处理;`formatAccountRotationNotice` 纯函数 + 晚绑 `accountRotationPostHolder` → 与 watchdog 同一 `postToThread` 路径;无 unified channel = ack 不发,byte-compat)+ `flywheel-codex-with-fallback` 三个轮转位点挂 `rotate_and_notify`(best-effort,绝不阻塞轮转,只传 profile 名)。
- ✅ **③ 完成**:`RunnerIdleWatchdog` 加 optional `runnerQuotaScan(session, pane)` dep(同 poll 的 capture 上跑,无新 timer;capture infra error 跳过;scan 抛错被兜住;不装=逐字节兼容)+ `bridge/runner-quota-scan.ts`(`makeRunnerQuotaScan`:§3.3 短路在 detectRunnerQuotaCap 内 → 真 cap 用 `resolveLeadForIssue` 找 owning Lead → emit usage_limit(accountLimit metadata + runner 身份,eventId=`runner-quota:<exec>:<generation>` 同 cap 去重/切换后重报)经共享 alertSink)+ plugin.ts 装配(gated on `accountSwitchRepair` 存在 = flag on)。
- ✅ **⑤ 完成 — 写入路径 = C(`security -i`),三方案真机 spike 定案**:
  - A(python helper + allow-all ACL)⚠️:能跑但降级 ACL,且自编 helper 首次触碰弹 GUI 授权框;
  - B(signed helper + partition-list)❌:provision 弹 GUI keychain 密码框(Annie 亲历、headless 过不去)+ **不扛 re-login**(delete+recreate 丢 provision,真机验证)+ ad-hoc cdhash 每次重编译变;
  - **C(`security -i`)✅ 全真机验证**:整条 add-generic-password 命令(含 -w 值)经 **stdin** 进 `/usr/bin/security` → argv 零凭据(924 条 ps 采样零泄露);1950B 含引号 JSON + 含空格 service 名**精确 roundtrip**(argv 形式 `-w 值` 进 argv ❌、交互 stdin 有 128B readpassphrase 截断 ❌ 都被排除);read-only dump 真 login keychain:4 个 Claude item 全是 security-owned 形态(claude 登录本来就走 security CLI)→ security 的 Apple 签名身份**免提示、免 provision、扛 re-login 重建**。
  - 脚本 `packages/claude-runner/bin/flywheel-claude-profile`:list/status/use/next/capture;`use` = withMkdirLock(与 Node 同锁协议:mkdir+holder{pid,at}+120s stale)→ 快照当前值 → `security -i` 写(值经 builtin printf,fail-closed 校验 compact 无空白 JSON object)→ **verify-before-commit 读回精确比对** → 才写 `.active`;mismatch → **回滚快照** + 非零。16 单测(fake security stub,两条红线:argv log 零凭据 / corrupt-write 回滚)。
- ✅ **开发侧真机 QA 冒烟(scratch keychain + dummy service,全程 security CLI 零弹框,绝未碰真 item)**:QA-1 真 Keychain swap 1060B 精确 ✅ / QA-2 next 轮转+.active ✅ / QA-3 argv 采样 924 条零泄露 ✅ / QA-4 whitespace 拒写、Keychain+.active 不动 ✅ / QA-5 活锁 fail-closed、释放后通过 ✅ / QA-6 并发双触发 3 轮全串行、状态一致 ✅。
- 教训(已报 Tadashi):spike 期间 python/C helper 改「非自己建的」item 的 ACL 测试在 Annie 屏幕弹了授权框(她只能 deny)——**任何自编 helper 路径都有 GUI 授权风险面,security CLI 路径没有**;这本身是 C 优于 A/B 的第 4 条理由。
- 全 suite:flywheel-comm 678 全过;teamlead 4349 过/27 挂 = 全部 pre-existing 环境性(codex-lead-runtime TMPDIR 22 + real-tmux/bash 类 8 + LeadAlertNotifier 1 个是 shell env 真 bot token 污染 mock)。

### PROGRESS 2026-07-04e — Annie 拍定 C 路 + Codex code review 2 轮 APPROVED + PR #439
- ✅ **Annie 拍了 C**(`security -i`,lead-instruction 2c742a0c)——⑤ 实现与终拍一致,dummy service 全链真机 QA(QA-1~6)已 PASS。
- ✅ **Codex code review xhigh 2 轮**:R1 CHANGES REQUESTED(HIGH×1+MED×3)→ 全修(c1f8d351:notify AbortSignal.timeout 5s + bash 后台 fire-and-forget / rotation post 门控 self-heal flag / switchAccount CAS 加 generation 检查 / profile name 白名单+凭据文件 0600/0400 fail-closed)→ R2 **APPROVED**。Codex 沙箱无网发不了 PR review,verdict 已由 runner 代发 PR comment 存档。
- ✅ **PR #439 开出、hold 等 batch、不 self-ship**。

### ⏭️ 剩余(非代码)
- **独立真机 QA**(非本 runner;§8 M1 项:红线不写坏登录 / 双触发幂等 / 不误切 529 / 全链注入)→ M1 PR **hold 等 batch、不 self-ship**。
- 点亮 runbook(§3.1 硬门):Annie 浏览器逐账号登录 + `flywheel-claude-profile capture <name>` provision 进池 → 设 `FLYWHEEL_ACCOUNT_SELF_HEAL=1` + `FLYWHEEL_CLAUDE_PROFILE_BIN` → 重启 Bridge。
- M2(两 Infra Bot)+ M3(auth-expiry re-login)= FLY-841,不在本 PR。
