# FLY-1252 自动切号 robust 化 — 调研

Issue: FLY-1252 (https://linear.app/geoforge3d/issue/FLY-1252/infra-claude-accountsjson-配额状态过期不可信-切号器切到已耗尽账号拖垮-lead)
日期: 2026-07-16
基于: exploration.md

## 0. 代码 baseline 声明

本分支已按 Lead 拍板（brainstorm gate Q4=a）merge 旧 PR #618 分支（Codex design review 5 轮 APPROVED 的「状态文件治真」实现）。**以下所有「现状」均指 merge 后的分支代码**；「生产现状」单独标注（生产 daemon 跑的是 main dist，尚无 #618）。

#618 已带进来的地基（不重做）：
- `account-store.ts`：`lastObservedAt/observedFiveHPct/observedSevenDPct` 观察字段、`applyObservation`（weekly 支配的 exhausted 标记语义）、`recordObservationInStore`（不取锁、typed result、generation CAS、last-observed-wins、corrupt store 绝不覆写）、`selectNextAccount` 的 `verifiedAt` TOCTOU 闸。
- `quota-monitor.ts`：active 轮询 / 候选验证 / sweep 三处观察回写；`verifyAndRankCandidates` 已移除 cooldown 预过滤（候选纯 live 判定）。
- `quota-guard-cli.ts` + `bin/flywheel-claude-quota-guard`：手动 `use/next` 切前实测硬闸（exit 0/32/33）、拒绝消息带全景建议、bypass 响亮告警（`quota_guard_bypassed`）。
- `mkdir-lock.ts` 锁租约（唯一 holder marker、renewMkdirLock、dead-PID stale 判定、非递归释放）；`switch-executor.ts` 的 `renewLock`/`TargetQuotaExhaustedError`/`lock_lease_lost`。
- `account-ledger.ts::buildAccountSummary` 余额取源「谁新用谁」。

## 1. 生产运行时事实（2026-07-16 实测）

| 项 | 值 | 出处 |
|---|---|---|
| daemon | launchd `com.flywheel.quota-monitor`，wrapper → `quota-monitor-cli.js`（main dist） | `launchctl list` + plist |
| daemon 日志 | `/tmp/flywheel-quota-monitor.log`（stdout/stderr 合并；重启即丢/tmp 定期清） | plist |
| config | `~/.flywheel/quota-monitor.json`：trigger5hPct=90、base 20min、accelerated 10min、minSwitchInterval 15min、order=[shopping, school, business, personal, personal1] | 实读 |
| cutover | `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1` → Bridge 侧 attachAccountSwitch=false、runAccountSwitchWatchdog=false、account-switch HTTP route 退役、pending 隔离 | `~/.flywheel/.env` + `quota-daemon-cutover.ts:25-33` |
| 告警通道 | `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=1518793447165661254`（#flywheel-alerts）+ `FLYWHEEL_ALERT_TICKETS=1`；quota-monitor 调用链**未传** `--mention-user` | `.env` + `quota-monitor-alert.ts:44-65` |
| 告警账本 | `~/.flywheel/alerts/claims.db`（event_id 主键=sha1(project\|lead\|kind\|signature)，claim 先于投递） | `lead-alert.sh:289-346` |
| pending | `~/.flywheel/account-switch-pending.json` **不存在**（cutover 后无写者） | 实查 |
| store | `~/.flywheel/claude-accounts.json`：generation=3、activeAccount=school（**实际 Keychain/.active=personal，15:43 UTC 手动切的，3 小时未同步**） | 实读 |

设计意图出处（Annie「本来就做了」的两个机制）：`engineering/doc/FLY-1256-external-quota-autoswitch/plan.md` §17 —— 阈值切号（5h≥trigger5hPct(默认90) OR weekly≥100 触发）与候选排序（7d-reset-最早）都是 FLY-1256 已落地的设计。本单是「诊断它们为何失效 + 补强」，不是从零建。

## 2. 事故取证要点（代码路径级，补 exploration §2）

1. **触发正常**：`pollOnce` 每 poll 在 gauge 行之后执行 `triggerScope`（`quota-monitor.ts:462`，main 版行号）；school five_h=100 ≥ trigger5hPct=90 → scope="5h"，12 个 poll 全部进入切换流程。12:06 那个 poll 因 `lastSwitchAt=11:56:49` + minSwitchInterval=15min 走 cooldown **静默** 返回。
2. **候选验证全拒**：12:16:58 `verifyAndRankCandidates` 返回 ranked=[] → `quota_no_target`（claims 实证）。候选逐一判定路径：pool 成员 → store 条目 → `isAuthUnusable` → store cooldown（main 版仍有预过滤）→ `readCandidateCredential(refresh=true)`（锁内 freshness probe-refresh，10s 超时 fail-closed）→ `fetchUsage`。business 当时被 store cooldown 正确排除（至 14:30）；personal/shopping/personal1 的拒因 ∈ {freshness_stale, credential_missing, usage_*}，Discord 原文（唯一 panorama 载体）不可获取（频道不在任何本地会话的 allowlist），本地零记录。
3. **静默机制**：quota_no_target 签名 `quota-no-target-5h-<day>`（`quota-monitor.ts:499`）→ claims 日级去重 → 12:37-14:27 的 11 次重复触发全部 `duplicate` 静默。`already claimed` 行只写到 lead-alert.sh 的 stderr → 被 `execFileAsync` 捕获后丢弃。
4. **outcome 无日志**：`pollOnce` 只在 usage fetch 成功后打一行 gauge（`quota-monitor.ts:458`）；cooldown/no_target/switched/switch_failed/noop 均无日志行。今晨两次成功切换在本地日志里不可见（只能从 gauge 行的 account 变化反推）——Lead 的「零切换尝试」误判即源于此。
5. **硬限 pane 侧零告警**：claims.db 全天零 `usage_limit`/`rate_limit` claim。LeadWatchdog `classify()` 的 usage-limit 识别用词正则（`(?<!not your )usage[-\s]?limit`），而 Claude TUI 的 5h 硬限画面措辞待采样确认（可能是 "5-hour limit reached ∙ resets …"，不含 "usage limit" 子串）；另一候选解释是 FLY-218 transient 抑制误伤。**开放项 V-1**：下次真硬限时 `tmux capture-pane` 采样 + 对 classify() 跑回归。runner 侧 `runner-quota-scan` 用 gauge 解析（`derive-account-limit.ts`，对措辞鲁棒），但它只覆盖 Runner session，Lead pane 不在其扫描面。
6. **cutover 断链是刻意设计**：`plugin.ts:8786-8788` 注释明示「CUTOVER deliberately keeps this detector alive while omitting accountSwitchRepair, so a cap still alerts but can no longer enqueue a Bridge-side switch」。恢复第二条执行路径会破坏单执行者不变式 —— 设计选择改为唤醒信号（§4-P3）。

## 2c. P7 身份核验的代码级事实（2026-07-16 追加，FLY-1182 结论落设计）

- `capture_back`（`packages/claude-runner/bin/flywheel-claude-profile:551-570`，调用点 `:792-795`）：Keychain 值按 `.active` 标签写回池槽——防 symlink/whitespace/非 JSON，但**零身份核验**。污染向量实锤（exploration §2b）。
- `freshness.ts` 只调 `https://console.anthropic.com/v1/oauth/token`（`freshness.ts:47`）——probe-refresh 证明 token 可刷新，**不证明属主**。
- 全代码库 grep 零 `/api/oauth/profile` 调用——身份原语需新建（plan 新文件 `account-identity.ts`）；端点能力（一个 GET 返回 email/uuid）来自 FLY-1182 结论，实现期以证据文件核实（V-2）。
- `AccountEntry.profileVerifyFailed`（`account-store.ts:51`）是 M3 auth family 的保留 flag，已被 `isAuthUnusable`（`:88-92`）与 `account-ledger.ts:418` 消费——**事实陈述仅此**；P7 不复用它（无 provenance、跨域所有权不安全——Codex R10#3），改用自有 `identityMismatch` 字段 + isAuthUnusable 一行新增（见 plan §3.6.8）。
- store 解析容忍度：`readStore` = `JSON.parse(raw) as AccountStore`（宽容），`readStoreStrict` 做结构校验——新增 optional `identity` 字段 backcompat 可行，但**既有写者重写 store 时必须 spread 保留未知字段**（实现期断言，T-21）。
- **R9 补证（Codex 对真码核出的执行面事实）**：① `claude-profile-cli.ts:103-120` 适配层现仅映射 exit 30/31/32；`switch-executor.ts:239-263` 候选循环仅对 `TargetQuotaExhaustedError`/`TargetStaleError` 续试，其余 apply 错误终止为 `apply_failed`——身份失败要续试必须新增 typed error + 映射。② `commit_profile_locked` **先写 Keychain 后写 `.active`**（`flywheel-claude-profile:798-813`）——切后校验失败若不回滚，Keychain 装错身份而 `.active` 还指旧号，下一次 capture_back 就把错 token 写进旧槽（污染复刻路径）。③ `capture_profile`（`:886-900`）是**第二个**按标签写池的直接写者。④ 候选 freshness 已在 `withAccountsLock` 锁内（`quota-monitor.ts:234-254`）；`switchAccount` 单锁贯穿整个候选循环、仅在每次 applyProfile 前 renew（`switch-executor.ts:157-285`、`:203-216`）；delegated bash 子进程不 renew 父 marker；锁竞争 waiter 超时 30s。⑤ active 观察在切换判定前就 commit+投影到标签（`quota-monitor.ts:477-531`）——漂移检查必须前置否则错号记账。

## 3. 四条 scope 在 merge 后 baseline 上的差距地图

| Scope | #618 已覆盖 | 仍缺（本单要做） |
|---|---|---|
| ①A 用满就切（daemon） | 候选 cooldown 预过滤已移除（误标可清）；观察回写让 store 标记趋真 | unverifiable 候选处理=躺平；quota_no_target 日级去重；无恢复通知；无降落策略；outcome/panorama 无日志 |
| ①B 硬限触发 | 无涉及 | pane 硬限 → daemon 唤醒信号；classify 措辞采样回归（V-1） |
| ② 选号顺序 | 手动 next 已有 guard 候选循环（exit 32 换下一个） | daemon 主排序（7d-reset-最早）已确认保留；legacy `selectNextAccount` 5h 分支字母序孤儿要统一 |
| ③ 通知 | quota_guard_bypassed 新 kind 已注册全链 | account_switched/quota_no_target 无 mention、无 founder 视线频道、无 episode 语义、无恢复收尾 |
| ④ 状态一致 | recordObservationInStore 明确**不碰** activeAccount/generation | 手动 `use` 成功后同步 store.activeAccount+generation；daemon 侧漂移对账兜底 |

## 4. 关键机制核实（设计依赖的事实）

- **唤醒机制已有半成品**：`quota-monitor-cli.ts::main` 的 sleep 用 `wakeWaiter` 包装（SIGTERM/SIGINT 已接）；加 `SIGUSR1 → wakeWaiter` 即得「立即 poll」，进程身份由 pidfile（`~/.flywheel/quota-monitor.pid`，含 processStartTime 校验字段）提供。Bridge 侧现成 hook 点：`routedAlertSink.alert`（LeadWatchdog + runner-quota-scan 共用汇点）。
- **mention 机制已有**：`lead-alert.sh --mention-user <id>`（FLY-1081，content + allowed_mentions 双写）；`sendQuotaMonitorAlert` 未透传 → 加 opts + env 即可。
- **episode 形态有成熟先例**：FLY-220 的 episode-latch（进入报一次、恢复清 latch、恢复后再阻塞=新 episode 可重报）。daemon 侧状态文件 `quota-monitor-state.json` 已有版本化 load/save + 保守恢复路径，可加 episode 字段。
- **kind 新增的全链清单**（FLY-1256/#618 两次验证过的形态）：`lead-alert.sh` case 白名单 → `LeadAlertNotifier.ALERT_EVENT_TYPES`（+是否 INFORMATIONAL）→ `LeadWatchdog.titleFor/bodyFor` exhaustive switch（noImplicitReturns 硬约束）→ `bridge/kind-contract.ts` + drift 测试。
- **降落切换的安全兜底已存在**：`switchAccount → applyProfile = bash use` 自带 freshness 硬闸（stale target exit 30 → TargetStaleError → 标 authExpired 换下一个；helper 缺失 exit 31 → 环境性 fail-closed）。即降落模式「信 store 选目标」最坏结果 = freshness 拒绝、原账号不动，**不会写坏 Keychain**（FLY-871 红线不动）。
- **store 写并发纪律**（#618 §2.3）：三写者（commitSwitch / daemon recordObservation / guard CLI caller-holds-lock）。④ 的手动 activeAccount 同步 = 第四个写点，必须走同一模式：bash `use` 持锁期间调 caller-holds-lock 的 node helper（复用 quota-guard-cli 的进程形态与 bin launcher 模式）。
- **日志**：wrapper `scripts/flywheel-quota-monitor-wrapper.sh` + plist StandardOutPath 均指 /tmp。structuredLog 已是 JSON 行格式，改造成本低。

## 5. 验证矩阵

| # | 断言 | 验证方式 | 状态 |
|---|---|---|---|
| F-1 | daemon 今晨两次切换成功且告警送达 #flywheel-alerts | claims.db 两条 account_switched + queue 零 spill | ✅ 实证 |
| F-2 | 12:16:58 起触发但候选全拒，此后日级去重静默 | claims quota_no_target ×1 + state lastSwitchAt=11:56:49 + 日志 12 行 gauge=100 | ✅ 实证 |
| F-3 | cutover=1 下 Bridge 无任何切号执行路径 | env 实读 + quota-daemon-cutover.ts 真值表 + plugin.ts 注释 | ✅ 实证 |
| F-4 | 手动 use 不写 store.activeAccount | bash 源码 grep 零命中 + 生产 store 与 .active 实际背离 3h | ✅ 实证 |
| F-5 | daemon 主排序 = 7d-reset-最早优先 | `verifyAndRankCandidates` sort + Lead Q2 确认 | ✅ 实证+拍板 |
| F-6 | 11:56 UTC 切换选中了已 ~95% 的 school（bug①：资格线只排除 ≥100%，排序不看 5h 余量） | 12:06 首个 active gauge five_h=95 + `quota-monitor.ts` 资格判定 `pct >= 100` 才排除 | ✅ 实证 |
| F-7 | Lead bug② 两假设排除：cooldown 只挡 12:06 一个 poll；active 被显式排除不可能自选 noop | state lastSwitchAt + minSwitchInterval=15min 时间线；`verifyAndRankCandidates`/`selectNextAccount` 源码 | ✅ 实证 |
| H-1 | 12:16 personal 被拒的具体原因 | 有界未知 ∈ {freshness_stale, credential_missing, usage_*}；排除 cooldown（store 无标记）/not_in_pool | ⚠️ 不可恢复（设计按失败类别修） |
| H-2 | 11:56 时 personal 是否 qualified（区分「排序压过健康号」vs「school 唯一可选」） | 同 H-1 不可恢复；两种情况修法相同（资格分档 + 验证鲁棒化），不依赖区分 | ⚠️ 有界未知 |
| V-1 | Lead pane 硬限措辞 vs classify() 正则 | 下次真硬限 capture-pane 采样 + 回归 fixture | ⏳ 开放项（实现期/QA 期做） |
| F-8 | capture_back 按标签写回、零身份核验 | bash 源码 `:551-570`/`:792-795` 实读 | ✅ 实证 |
| F-9 | 代码库零 `/api/oauth/profile` 调用；freshness 只走 `oauth/token` | 全库 grep + `freshness.ts:47` | ✅ 实证 |
| F-10 | `profileVerifyFailed` 已接入 isAuthUnusable 候选排除链 | `account-store.ts:88-92` + `account-ledger.ts:418` | ✅ 实证 |
| H-3 | pool:personal 实装 shopping token（池污染）；10:00-10:17 PDT 静默切号细节；profile 端点响应形态 | Lead 转述 FLY-1182 结论（[f478f0bb]）；证据文件截稿时未 push | ⚠️ 待证据文件（V-2，实现期核对） |

## 6. 约束与风险

1. **单执行者不变式**：daemon 是唯一自动切号者。①B 只做唤醒信号，绝不给 Bridge 恢复执行面。
2. **Q1/Q3 待 Annie**：降落策略默认值（允许受控降落 vs 纯 fail-closed）与 severe 事件投递频道 —— 设计必须做成**运行时可切换**（config/env），Annie 的答复只改默认值不改代码形态。
3. **锁内网络预算**：降落模式不增加锁内网络调用（选目标只读 store；freshness 闸在 applyProfile 里本来就有）。**P7 修订（R10#1 后终版）**：锁内新增 = 每次 apply 尝试至多 2 次 profile GET（预写闸 + capture_back 守卫，各 10s 超时；候选身份 GET 全部锁外、切后断言零 GET）；全循环最坏 = N(≤池 5)×(freshness 10s + 2×GET + 写)，由**父进程心跳续租**覆盖（delegated 子进程 renew 对父 marker 是 no-op——`flywheel-claude-profile:199-215,259-281` 实证）；手动竞争方 30s acquire 超时显式接受——预算显式接受（Lead 直令 [f478f0bb]）。
4. **告警风暴反弹**：episode 重报是 FLY-218/220 治好的刷屏病的邻居 —— 重报必须带间隔下限 + episode 内计数上限 + 恢复清 latch，签名设计避开「整屏哈希漂移」旧坑（用 episode 起点时间戳，不用内容哈希）。
5. **byte-compat**：cutover env 不动；不设新 env 时新行为的默认值要么保守要么与现状一致（降落开关默认值待 Annie，见 plan）；`lead-alert.sh` 新 kind 走既有白名单模式。
6. **/tmp 日志迁移**是运维面小改（wrapper+plist），但 plist 改动需要 launchd 重载 —— 归入 ship 步骤，不新增重启面（daemon 本来就要随本单重启）。
