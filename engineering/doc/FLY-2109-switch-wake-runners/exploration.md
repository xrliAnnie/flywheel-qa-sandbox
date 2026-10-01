# FLY-2109 切号后唤醒活体 — 探索
Issue: FLY-2109 (https://linear.app/geoforge3d/issue/FLY-2109/病根-切号后活着的-runner-不接新账号旧号周额度打满即全体静默只能人眼发现-8)
日期: 2026-10-01
基于: 无

## 0. 本次设计节点的仓库边界（先讲清楚）

本工作树是 QA 沙盒快照（origin = `flywheel-qa-sandbox`，`doc/VERSION` = v1.55.0）。它**没有**生产仓里的
quota-monitor 守护进程、`flywheel-claude-switch` CLI、`account-switch-consumer`、`MailboxQueue`、`lead-inbox-loop`，
也没有账号库里的 `lastSwitch` 字段。生产仓（`/Users/xiaorongli/Dev/flywheel`）上 PR #1428（分支 `flywheel-FLY-2109`，
头 `81d7ebb75`）已对本 issue 做了一版实现并通过 Codex design review 4 轮；它的 Lead 裁定（见下 §4）本设计沿用，
但**接缝按本仓真实存在的代码定**，不假装沙盒里有生产的基础设施。

所以本设计回答的问题是：**在这份代码里，切号成功后怎样用现有信箱通道把活着的 Claude runner / Lead 叫醒。**

## 1. 问题

机器 Claude 账号从 A 切到 B 之后，切换前就在跑的 Claude runner / Lead 仍握着 A 的 token。A 的周额度已满时，
它们在 pane 上撞 "You've hit your weekly limit" 后停在空提示符，不报错、不告警、不重试；Bridge / Linear / session 表
看全是 running，只有逐个看 pane 才发现（8 次复现，首见 2026-08-28T00:38Z）。

实测（8-27 18:28 PT）：给活体投一条 `flywheel-comm send`，它下一个 turn 会重读 Keychain，45 秒内切到新账号复工。
**能救，只是没人推。**

## 2. 派单口径（Lead 2026-09-30，founder 同意派）

1. 切号成功后，枚举所有正在跑的 Claude runner 和 Claude Lead（status=running 且 pane 活着），逐个投一条固定唤醒消息；幂等，重复投无副作用。
2. 把本次叫醒了哪些 exec / Lead、投递结果写进切号日志（quota-monitor 的 outcome 旁边）。
3. 只唤醒：⛔ 结束/替换体，⛔ 改额度判定，⛔ 手动切号。Codex 不在范围（已有热换号）。
4. 投递走现有信箱通道（与 Lead 的 `flywheel-comm send` 同一路），不另造通道。

## 3. 现状（本仓代码事实）

### 3.1 切号链路：一个执行器、两个 Bridge 内入口、都已有「切号成功」钩子

| 入口 | 位置 | 成功后钩子 |
|---|---|---|
| 看门狗（30s poll 搭车，无新 timer） | `packages/teamlead/src/bridge/plugin.ts:8147-8175` → `accountSwitchWatchdogTick` | `onSwitchSuccess`（`account-heal/account-switch-watchdog.ts:55`） |
| `POST /api/account-switch`（Infra Bot 认领） | `bridge/account-switch-route.ts:260-268` | `rt.onSwitchSuccess` |

两个入口都调 `makeAccountSwitchRepair().executeSwitch()`（`account-heal/account-switch-repair.ts:171-213`）→
`switchAccount()`（`account-heal/switch-executor.ts:126-217`）。执行器在锁内完成 CAS、Keychain 写入、
`commitSwitch` 把账号库 `generation + 1` 并原子写回（`:209-216`），只有 `outcome:"switched"` 代表「本进程刚提交了一次切号」。

两个钩子现在都只做 `rescueRuntime.postSwitchRescueSweep()`（`bridge/rescue.ts:397-437`）——它只救
**已确认 login_expired 告警**的 session（重启），不发任何唤醒；额度打满的体不在它视野里。

**坑**：钩子的触发条件是 `disposition.outcome === "attempted"`，而 `noop_already_switched`（重复触发）也返回 `attempted`
（`account-switch-repair.ts:190-195`）。真切号的唯一标志是 `disposition.notifySuccess` 存在（FLY-929 只在 `switched` 时填，`:180-188`）。
`notifySuccess` 目前没有 `generation`，但执行器结果里有（`switch-executor.ts:214`）。

沙盒里没有手动 `flywheel-claude-switch` CLI；bash `flywheel-claude-profile use`（`packages/claude-runner/bin/flywheel-claude-profile:556-607`）
只换 Keychain + `.active`，**不碰** `claude-accounts.json` 的 `generation`，也没有钩子。它不在本仓 Bridge 的视野里（§6 边界）。

### 3.2 账号库

`~/.flywheel/claude-accounts.json`，路径由 `FLYWHEEL_CLAUDE_ACCOUNTS_PATH` 覆盖（`account-heal/account-store.ts:116-122`）；
文件存在即自愈开启（`accountPoolConfigured()`，`:128-130`）。schema `{generation, activeAccount, accounts[]}`。
`generation` 单调递增、仅由 `commitSwitch` 推进 → 它就是「一次已提交切号」的天然代次号。

### 3.3 信箱通道（`flywheel-comm send` 走的那条路）

`send.ts:31-112`：① `CommDB.insertInstruction(from,to,content)` 落审计行 → ② `clearDeclaredState` → ③ 查 `sessions.vendor`，
`"none"` 不唤醒 → ④ `wakeRunnerMailbox({content:"[lead-instruction <id>]\n…", metadata:{flywheelId:id}, backend:vendor})`
（`packages/flywheel-comm/src/wake.ts:58-121`）→ ⑤ `markInstructionDelivered(id)`。

`wakeRunnerMailbox` 物理上是往 Claude Code Agent Team 收件箱文件
`<CLAUDE_CONFIG_DIR>/teams/<leadId>/inboxes/runner-<exec8>.json` 写一条 JSON（`agent-team-transport/src/path-helpers.ts:110-168`），
runner 内置的 inbox poller 读到就起一个新 turn——这正是 8-27 实测「投一条消息就复工」的机制。它从不抛错，返回 `{ok, skippedReason?, error?}`。
`CLAUDE_CONFIG_DIR` 不随切号变，所以收件箱路径切号前后一致。

**幂等原语已有两层**：
- CommDB `insertInstructionWithId(id, …) → boolean`（`db.ts:898-913`）：同 id 再插返回 false。
- 收件箱 sidecar 按 `metadata.flywheelId` 去重（`agent-team-transport/src/types.ts:49-106`）：同 id 再写被跳过。

Bridge 自己已经用这条路发唤醒：`bridge/runner-wake.ts:105-200`（`sendRunnerWake`，`fromAgent:"bridge"`，
no-transport 守卫 `EXECUTOR_TO_TRANSPORT[adapter_type]==="none"` 跳过并记 `runner_wake_no_transport` 事件；失败记 `runner_wake_failed` 事件）。
它的 `WakeKind` 是封闭联合，文案由 `wakeText()` 生成——加一种 kind 即可复用。

### 3.4 Lead 怎么收消息

Lead 不是任何 sessions 表里的行；来自 `projects[].leads[]`（`ProjectConfig.ts:241-245`，`backend` 未设 = claude-code，
`lead-backends/lead-backend.ts:18-40`），运行时在 `RuntimeRegistry.getForLead(agentId)`（`bridge/runtime-registry.ts`）。
给 Lead「起一个 turn」的原语是 `LeadRuntime.deliver(envelope)`（`bridge/lead-runtime.ts:52-58`）；mailbox 模式下
`MailboxLeadRuntime` 写 `teams/<leadId>/inboxes/<leadId>.json`，`flywheelId = <leadId>-<seq>-<exec|no-exec>`（`bridge/mailbox-lead-runtime.ts:66-180`）。
标准调用（`HeartbeatService.ts:2146-2172`）：`store.appendLeadEvent(leadId, eventId, type, payload)` → `deliver` → `markLeadEventDelivered(seq)`；
`lead_events` 表 `UNIQUE(lead_id, event_id)`，同 eventId 再 append 返回已有 seq（`StateStore.ts:6513-6547`）→ 天然幂等。
Lead 的 pane 是 tmux 会话 `flywheel` 里的窗口 `<project>-<leadId>`。

### 3.5 枚举活着的 Claude runner

- 权威 running 名单：StateStore `getRunningSessions()`（`StateStore.ts:3610`，`status='running'`）。列有 `adapter_type`
  （`claude-tmux | codex-tmux | antigravity-tmux | kimi-tmux`，legacy 行可能为空）。
- 真实注册 vendor：每项目 CommDB `sessions.vendor`（`claude-code | codex | none | NULL`，`flywheel-comm/src/db.ts:313-327`）。
- pane 活性：`bridge/tmux-lookup.ts` 的 `getTmuxTargetFromCommDb(exec, project)` → found/gone/error，
  `probeRunnerProcessLiveness(tmuxWindow)` → `alive | dead_pin | absent | indeterminate`（`:371`）；
  `HeartbeatService.isSessionTmuxAlive` 把 `indeterminate` / `error` 当活（fail-open）。

### 3.6 切号日志

沙盒没有 quota-monitor 守护进程，但生产上它的 stdout/stderr 由 launchd 固定落到 `~/.flywheel/logs/quota-monitor.log`
（JSON 行，`{"ts","component":"flywheel-quota-monitor","level","event":"quota_poll","outcome":"switched",…}`），
`FLYWHEEL_QUOTA_LOG_PATH` 是 wrapper / setup 脚本里的同名变量。本仓 Bridge 侧目前只把切号结果贴进 Alerts thread
（`plugin.ts:7182-7218` `postSwitchResult`）。「写进切号日志、放 outcome 旁边」= 往这同一个文件追加一行同形 JSON。

### 3.7 现有「黑洞巡检」会不会被唤醒消息打扰

- `detection-gap-scan.ts` 的 `delivery_unconsumed`（D6）查的是 CommDB `messages` 表（`:369-371`），不是 `instructions` 表 → 不受影响。
- runner 协议要求对 `[lead-instruction <id>]` 回 DONE（FLY-208）。唤醒消息若用这个前缀，每个被唤醒的体都会给 Lead 回一条 DONE——
  这是**可见的、可核对的**副作用（Lead 看到「谁醒了」），prod 已接受同样形态。本设计沿用该前缀（§4 裁定 ④「同一路」）。

## 4. 沿用的 Lead 裁定（来自生产 PR #1428 的 lead-decisions / plan，不重新开题）

1. 唤醒文案只陈述事实 + 接着做，不带改行为的指令：`【账号切换】额度已切到新账号 \`<to>\`，请接着做刚才的事。`
2. 切号失败 / `no_account` / `noop_already_switched` → **不投**；只有真 `switched`（代次前进）才投。
3. 同代次重复触发不重投（幂等按 `generation + 目标` 键）。
4. Lead 全部入队，是否活着由投递通道判断；非 Claude 后端的 Lead 不投。
5. 日志落 quota-monitor.log，紧跟 switched 行；记录逐目标结果，结果词止于「已入队」，不宣称复工。
6. 测试房隔离：`FLYWHEEL_CLAUDE_ACCOUNTS_PATH` / `FLYWHEEL_QUOTA_LOG_PATH` 两个重定向，生产默认路径不变。

## 5. 候选方案

| 方案 | 要点 | 结论 |
|---|---|---|
| A. 在两个 `onSwitchSuccess` 钩子里直接枚举 + 投信 | 改动最小；但钩子不区分真切号与 noop、Bridge 在「切号已提交、唤醒未投」之间崩溃就丢；两处各写一遍 | 不单独采用 |
| B. Bridge 内按**代次**消费：持久回执表 `account_switch_wake_receipts(generation PK)`，`tick()` 比较账号库 `generation` 与最后完成代次，前进即 sweep；钩子立即触发一次 tick，30s poll 搭车做崩溃补投 | 一份逻辑覆盖两入口；崩溃可重放；真切号判定靠代次而非 `attempted`；无新 timer | **采用** |
| C. 守护进程 / bash CLI 自己投 | 沙盒没有守护进程；bash 不持 StateStore / CommDB / Lead runtime | 拒绝 |
| D. 复用 revive scan 走 `tmux send-keys` | 生产有、沙盒无；且派单明确「走信箱通道」 | 拒绝 |

## 6. 诚实边界

- 只覆盖 Bridge 进程内的两条切号入口（看门狗 + `/api/account-switch`）。沙盒里 bash `flywheel-claude-profile use` 不推进 `generation`，Bridge 看不见它 → 不唤醒（生产由 `flywheel-claude-switch` 推进 `lastSwitch` 覆盖，本仓无此 CLI）。
- 唤醒 = 让体起一个新 turn 并重读 Keychain；**不保证**它一定复工（例如新号也打满），结果只记到「已入队」。
- Lead 侧无「过期作废」：离线 Lead 回来会读到这条唤醒（本仓 Lead 收件箱无 TTL 原语）；用「Lead pane 窗口存在」做准入，窗口不存在不投。
- 不结束 / 不替换体、不改额度判定、不切号、Codex / Antigravity / Kimi 体不投。

## 7. 待调研（→ research.md）

- `RuntimeRegistry` 枚举 Lead 的方式（无 iterator，只能 `getForLead`）与 Lead 窗口定位函数名。
- `appendLeadEvent` 的 eventType 是否需要进 `RETRYABLE_LEAD_EVENT_TYPES`（heartbeat 重投 5 次）——唤醒是否要重投。
- feature flag 注册表条目形态与 `resolve.ts` 的直接可切换证明测试要求。
- 日志追加器的安全写法（O_NOFOLLOW、0600、VITEST 下不写真实 HOME）。
