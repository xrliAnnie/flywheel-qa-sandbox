# FLY-696 账号自愈 — 调研

Issue: FLY-696 (https://linear.app/geoforge3d/issue/FLY-696/infraresilience-账号自愈-跨-provider-bot-自动切账号quota-用完时-手动-login-兜底)
日期: 2026-07-03
基于: exploration.md

---

## 0. 调研结论速览 (给赶时间的人)

1. **切换机制 = pool 轮转,不是热换(D1 定论)**。长驻 Claude session 撞额度上限时其 OAuth token 仍有效(实测 349min 寿命),额度错误不触发 claude 重读凭据 → 换文件对当前 session 无效。**codex 侧先例(本仓)也是 `exec` 一个全新进程来轮转,从不热换活进程**。→ 机制:**换掉共享账号凭据源,新 spawn 的 runner/lead 立刻用新账号;当前卡住的 session 等 reset 或(founder-gated)重启**。这就是 Tadashi 已认可的"新 runner 无感、当前 session 等 reset"。
2. **整条 fleet 共享一个账号 → 检测只需盯 Lead 就够**。本机 fleet 今天全跑一个 Keychain 账号(`claude-lead.sh` 默认不设 `CLAUDE_CONFIG_DIR`)。任何 session 撞顶 = 该共享账号封顶;`LeadWatchdog` 已在盯所有常驻 Lead → 足以触发一次让**全 fleet(含 runner)受益**的轮转。**不需要 per-runner 额度检测**。
3. **切换的落地手段:换 Keychain 条目(推荐,低侵入)**。实测 `security add/find/delete-generic-password` 在已解锁 keychain 下**无提示 headless 可用**;真实条目 `svce="Claude Code-credentials", acct="xiaorongli"`。轮转 = 把选中账号的凭据写进这个 Keychain 条目,新 claude 进程启动即读到新账号。**免去把整条 fleet 迁到 file-based `CLAUDE_CONFIG_DIR` 的高风险改造**。
4. **5h vs weekly 可从状态栏解析**:`5h ██ NN% reset <when> | 7d ██ NN% reset <when>`(fixture 已确认格式),今天无人解析 → 新写 parser。
5. **手动 login 兜底 = 人的动作**:首次 provision + token 过期,由 Annie 在浏览器登每个账号,脚本只做 Keychain↔pool relocate;实测隔离登录态很挑版本(见 §7),更坚定"provision 是人工步、切换是自动步"的分工。

## 1. Claude 凭据机制 (实测)

- **默认 `CLAUDE_CONFIG_DIR`(`~/.claude`)→ 读 macOS Keychain**;条目 `svce="Claude Code-credentials"`, `acct="xiaorongli"`。本机 `~/.claude/` 下**没有** `.credentials.json`。
- **非默认 `CLAUDE_CONFIG_DIR` → 读 file `$DIR/.credentials.json`,不读 Keychain**(FLY-572 定论,本次复核)。
- **凭据结构**(两种存储同一 JSON):
  ```json
  { "claudeAiOauth": {
      "accessToken": "sk-ant-oat01-…",   // 短期(实测寿命 ~349min / expiresAt 字段)
      "refreshToken": "…",
      "expiresAt": 1751000000000,          // ms epoch
      "scopes": [...],
      "subscriptionType": "max",
      "rateLimitTier": "default_claude_max_20x"
  } }
  ```
  → **一个账号的可切换单元 = 这个 JSON**。pool 里每个账号存一份。
- **Keychain 读写 headless 可行(实测)**:`add`/`find -w`/`delete`/`add … -U`(更新)全无提示成功(session keychain 已解锁)。⚠️ **风险**:launchd 后台 Bridge 若在 keychain 锁定态下跑,`security add` 可能提示/失败 → 需在实现期确认 Bridge 运行上下文 keychain 解锁(登录后通常解锁)。
- **已运行进程读凭据的时机**:启动时读一次进内存;token 近过期时用 refreshToken 刷新并写回文件/Keychain。**额度上限(429/quota)不是 auth 失败(token 仍有效)→ claude 无理由重读凭据** → 换凭据对当前活 session **无效**。这是 D1 的技术根因。

## 2. D1 定论 — 机制是 pool 轮转,不是热换

**三条汇聚证据**:

1. **codex 先例(本仓 `flywheel-codex-with-fallback`)**:撞 `usage.?limit|429` 时 `"$PROFILE_BIN" next`(换 `$CODEX_HOME/auth.json`)后**重跑/`exec` 一个新 codex 进程**;从不对活进程热换。设计对齐 → Claude 也该如此。
2. **额度上限 ≠ auth 失败**:token 有效(实测 349min),quota 错误不触发重读凭据 → 内存里旧 token 常驻 → 换文件/Keychain 对当前 session 是 no-op。
3. **实测隔离登录态很挑**(§7):连"起一个隔离已登录 claude"都版本敏感,更说明健壮/可测的路径是**spawn 时选账号 + 重启**,不是活进程热换。

**→ 机制定型**:
- **切换点 = 共享账号凭据源**(Keychain 条目 或 file-based `.credentials.json`)。
- **撞顶时**:选下一个最优账号 → 写进凭据源 → 更新 state store → 发 Alerts 通知。
- **效果**:此后新 spawn 的 runner/lead 用新账号(无感);当前卡住的 session 等 reset(5h 几小时自愈)或走 founder-gated 重启(MVP **不**自动重启,尊重 FLY-175 / AutoRepairBot "NEVER restart" 铁律)。
- Tadashi 已认可这个诚实退化。**不硬吹"当前 session 也无感"**。

## 3. 共享账号模型 → 检测简化

fleet 今天 = 单一共享账号。撞顶影响全体,`LeadWatchdog`(已盯所有 Lead、30s 轮询 `capture-pane`)必然先撞到 → 触发一次**全 fleet 受益**的轮转即可。**MVP 检测只做 Lead 侧**(复用 `LeadWatchdog.classify()`),不新建 per-runner 额度检测(`RunnerIdleWatchdog`=FLY-92 只做 idle/stuck,不分 quota,MVP 不碰)。

> 注:未来若要**并发多账号分流**(不同 runner 同时用不同账号,提高聚合吞吐)才需要 per-runner 隔离 home(`claude-home.ts` 仿 `codex-home.ts`)。Annie MVP 是"撞顶切下一个"= 顺序 fallback,不是并发分流 → **MVP 用共享单活账号模型**,更简单。列入 follow-up。

## 4. 切换落地 — 两候选(plan 里让 Codex design review 拍)

| 手段 | 做法 | 优 | 劣 |
|---|---|---|---|
| **A. 换 Keychain 条目(推荐)** | pool 存 4 份 file 凭据;切换=`security add-generic-password -a xiaorongli -s "Claude Code-credentials" -w '<credJSON>' -U`;fleet 保持默认(读 Keychain) | 低侵入、不迁 fleet、实测 headless 可行 | 依赖 keychain 解锁态;写共享登录 keychain |
| **B. file-based 共享 `CLAUDE_CONFIG_DIR`** | fleet 统一指向 `~/.flywheel/claude-active`(全量 config + `.credentials.json`);切换=原子换那一个文件 | 纯文件、可脚本、无 keychain 依赖 | **要把整条 fleet 迁离 Keychain**(FLY-572 全套 gotcha:plugin cache 路径、trust 态、cred 过期)= 高风险 fleet-wide 重启改造 |

**推荐 A**(MVP 侵入最小、实测可行)。B 作为 keychain-lock 兜底或未来 per-runner 隔离的基础。**最终由 Codex design review + Tadashi 定**。

## 5. 5h/weekly 检测设计

- **现状**:`LeadWatchdog` `BLOCKED_KEYWORDS` 只有单一 `usage_limit` 桶(`/(?<!not your )\busage[-\s]?limit\b/i`);`isTransientThrottlePane()` 已把 529 短路(**保留不动**)。
- **新增**:parse 状态栏 live region 行
  ```
  5h ██████████ 100% reset today 21:30  |  7d ████████░░ 82% reset Mon 09:00
  ```
  正则(草案):`5h\s+[█░]+\s+(\d+)%\s+reset\s+(.+?)\s*\|\s*7d\s+[█░]+\s+(\d+)%\s+reset\s+(.+)`
  + "Claude usage limit reached. Your limit will reset at 9:00 PM (America/Chicago)." 文案取 reset 时刻。
- **判定**:`usage_limit` 事件带 `scope: "5h" | "weekly"` + `resetAt`。哪个 gauge 是 100%(或 usage-limit 文案的 reset 时刻落在 5h vs 7d 窗口)决定 scope。
- **喂给切换逻辑**:5h → 该账号标记 `exhausted5hUntil=resetAt`(几小时后可回);weekly → `exhaustedWeeklyUntil=resetAt`(这周别回)。

## 6. account-state store 设计

新建小 store(建议 `~/.flywheel/claude-accounts.json` 或 better-sqlite3 侧表,与现有 `~/.flywheel/*.db` 一致)。per-account:
```
{ name, provider:"claude"|"codex",
  active:bool,
  fivehPct, fivehResetAt,
  weeklyPct, weeklyResetAt,
  exhausted5hUntil, exhaustedWeeklyUntil,
  lastSwitchedAt }
```
**选下一个可用账号**:
- 过滤掉 `now < exhaustedWeeklyUntil`(这周废了的)。
- 5h 场景:从"未 weekly-废"里挑一个非当前、`now >= exhausted5hUntil` 的;当前账号 5h reset 后可回(不删出池)。
- weekly 场景:从"未 weekly-废"里挑 **weeklyResetAt 最近** 的(周五先用周一 reset 的)。
- 全废 → 发"所有账号已用尽,需人工"给 Annie(手动 login 兜底 / 等最近 reset)。

## 7. Provisioning + 手动 login 兜底 (实测friction)

- 4 账号各要一份 `claudeAiOauth` 凭据进 pool。每个账号 = **Annie 在她浏览器登一次 claude**(claude-in-chrome 是别的 profile,不能替)。
- 脚本(`flywheel-claude-profile`,仿 `flywheel-codex-profile`:list/use/next/status)只做 pool↔Keychain relocate,**不碰 login**。
- **实测 friction(本次 spike)**:用 FLY-572 配方(rsync 生产 `~/.claude` 935M + relocate Keychain 凭据 → `.credentials.json`)起隔离 claude,claude 2.1.200 仍走 theme→login onboarding(隔离 `.claude.json` 的 `oauthAccount`/onboarding 检测版本敏感)。→ **结论:provision 是易碎的人工步,别指望全自动;切换(换凭据)才是自动步**。这与 issue"手动 login 兜底"一致。
- token 过期 → 走现成 `/codex-relogin` 同思路的人工重登(Claude 版),或提示 Annie。

## 8. Codex 侧增量 (D2:不重写)

现成 `flywheel-codex-with-fallback` 已在撞 `usage.?limit` 时轮转 + 重跑。增量:
- **加 5h/weekly 智能**:codex 也有 5h/weekly reset;轮转时优先"最近 reset"账号(可在 profile 侧 state 记 reset,与 §6 store 统一,或轻量各自记)。
- **加通知**:轮转发生时给 Bridge 发一条(shell → 写 marker / 调 flywheel-comm → Bridge → Alerts),让 codex 轮转也在 Alerts 可见(今天完全静默)。
- **不动** codex 的 exit-and-retry 核心(它本就是对的模型)。

## 9. 通知 — 复用 FLY-368 AutoRepairBot / AlertChannelHub

- 今天 `AutoRepairBot`:`usage_limit` 硬编码 `HUMAN_ONLY_REASON` → `needs_human` 页 Annie;`AUTO_ATTEMPT_EVENT_TYPES` 只含 `runner_stuck_unhandled`/`pane_hash_stuck`(**测试锁定**:`AutoRepairBot.test.ts` 断言 `usage_limit → needs_human`)。
- **改**:给 AutoRepairBot 注入一个 `switchAccount` dep(仿 `runnerNudge`/`leadResumeEnter`),把 `usage_limit` 从 `HUMAN_ONLY_REASON` 移到"可 attempt";attempt 成功返回 `{outcome:"attempted", action:"account_switch", detail:"🔧 已切账号 personal→school(5h 到, reset 21:30);新 runner 用新账号,当前 session 等 reset"}`。
- **通知白拿**:`AlertChannelHub.openOrReplaceThread()` 已把 repair detail 贴进 Alerts 线程;`resolve()`/`reconcile()` 在账号回血/session 恢复时贴 ✅。→ **切换通知复用整条 FLY-368 管线,不新造 Discord 代码**。
- 全废(选不出下一个)→ 保持 `needs_human` 页 Annie(手动兜底)。
- ⚠️ 要**同步改锁定测试**(`AutoRepairBot.test.ts` / `LeadWatchdog-fly368.test.ts`),这是预期的契约变更。

## 10. D3(cross-provider Infra Bot)— TBD

Tadashi 已把"Bridge 直接切 vs 两个字面 Infra Bot"surface 给 Annie。**plan 里 D3 留 TBD**:MVP 先用 Bridge 侧(AutoRepairBot/AlertChannelHub)落地自动切+通知(不需要独立 agent,Bridge 不烧额度不存在自修自);两个常驻 cross-provider Bot(开 channel / 自动 re-login / 接管所有 infra)= follow-up。Annie 一确认 Tadashi 回，再定 plan 该块。

## 11. 风险 & 开放项

| 项 | 说明 | 处置 |
|---|---|---|
| Keychain 锁定态 | launchd Bridge 若 keychain 锁 → `security add` 失败 | 实现期确认;失败则 fail-closed 退回 needs_human(不静默) |
| 当前 session 不自愈 | 尊重 FLY-175 不自动重启;5h 几小时自愈,weekly 久 | 诚实通知;"自动重启到新账号"列 follow-up(需 FLY-175 carve-out) |
| 契约测试变更 | `usage_limit` 从 human-only 变 auto-attempt | 预期;同 PR 改测试 + Codex review 把关 |
| 全废 | 4 账号全 exhausted | needs_human + 手动 login 兜底;通知给最近 reset 时刻 |
| provision 易碎 | 隔离登录态版本敏感 | 人工步、非自动;脚本只做 relocate |
| 误切 529 | 绝不能把临时 529 当额度上限切账号 | 保留 `isTransientThrottlePane` 短路;QA 专项验不误切 |
| D3 未定 | 两 bot vs Bridge 直切 | 等 Annie;plan 该块 TBD |
