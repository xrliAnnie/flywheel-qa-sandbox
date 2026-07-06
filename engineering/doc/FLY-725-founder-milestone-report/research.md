# FLY-725 Bridge 侧里程碑 → founder push — 调研

Issue: FLY-725 (https://linear.app/geoforge3d/issue/FLY-725/founder-ux-lead-不主动报告-runner-完成-状态只在频道名没-push-报告founder-被迫-pull)
日期: 2026-06-30
基于: exploration.md

> Brainstorm gate 已确认（Tadashi 替 Annie）：去向 = issue [FLY-XX] thread + @founder；
> cadence = Bridge-primary 保证 ping；覆盖先按「都 ping」默认写 plan（completions 实时 vs 归 FLY-727
> 日报 = 留在 725 thread 待锁）；详细度 = 一行状态 + 结果 + PR + @founder。

---

## 1. 确认的现状（谁改标题、谁通知、缺口在哪）

| 环节 | 代码位置 | 行为 |
|---|---|---|
| stage 改 thread 标题 | `event-route.ts:1469` `stampStageEmojiForSession` → `ChatThreadCreator.stampStageEmoji` → `writeTitleOnce` PATCH channel name | **只改名，不发消息、不 ping**（blocked 的 🔴 v1 根本不 stamp） |
| session_completed 路由 | `event-route.ts:774`；route→status map:900-976（needs_review→awaiting_review、merged→completed、blocked→blocked、pr_handoff/no_code→completed） | 无 founder 动作 |
| session_failed | `event-route.ts:1338` | 只写 FSM `failed` + `last_error`，无 founder emission |
| 唯一的"通知" | `event-route.ts:1889-1940` always-deliver：`appendLeadEvent` + `runtime.deliver` | 送进 **Lead 的 inbox**，不是 founder |
| Lead 手动 relay | `POST /api/chat-threads/send` → `postDiscordMessageToChannel`（discord-utils.ts:104 硬编码 `allowed_mentions {parse:[]}`） | **passive、不 ping Annie** |
| auto-QA ship-ready | `auto-qa-effects.ts:207` `notifyShipReady` → `postThread`（无 mention opts） | "✅可以 ship 了" **passive、不 ping** |
| 唯一真 @founder-ping | `founder-thread-notifier.ts` `emitFounderThreadNotification`（`allowed_mentions.users:[ownerUserId]`），经 `gate-poller.ts:1207` `maybeEmitFounderThreadFallback` | **仅 gate（brainstorm/approve_to_ship）、仅 Lead 沉默 ≥10min fallback** |

**缺口**：`completed` / `failed` / `blocked` 三个终态 + ship-ready(QA 过) 都没有 `@founder`-ping 的 push。

---

## 2. 可复用 primitives（已存在，逐条核对）

- **GatePoller poll 循环**（`gate-poller.ts:241-490`）：`setInterval` ~3s，per `(project, lead)` 迭代
  （290-291），已 piggyback 多个 patrol（misroute 431、lead-pending prune 446、founder-reply 468）——
  **零新 timer 的落点**。misroute patrol 用 `patrolEveryNTicks`（默认 20 tick ≈60s）做**低频**巡检，
  里程碑报告同样不需要 3s 延迟 → 复用这个 cadence 模式。
- **`emitFounderThreadNotification`**（`founder-thread-notifier.ts:113`）：往 thread POST + `@founder`，
  已处理 429/5xx(transient)/4xx(permanent) 分类 + `isDiscordSnowflake` owner 校验 + audit event。
  当前 `FounderGateCheckpoint = "brainstorm" | "approve_to_ship"` + `buildBody`（68-90）——
  需扩里程碑类型 + 里程碑 body。POST/classify 核心可抽成私有 helper 让 gate 路径**字节不变**。
- **`StateStore` 终态枚举**：`getStaleCompletedSessions(hours)`（StateStore.ts:2068）=
  `WHERE status IN ('completed','failed','blocked') AND last_activity_at < now-Nh`（GEO-270 清理用、
  时间方向相反）。里程碑巡检要的是"**最近**到终态、**未通知**" → 新增一个 lookback-window 查询
  （`> now-Nh`，bound 住扫描面 + 防首次部署 ping 历史 session）。
- **去重**：`insertEvent` + `getEventsByExecution`（FLY-605 用 `founder-thread-notify-<qid>` event
  做 restart-safe 幂等）→ 里程碑用 `founder-milestone-notify-<execId>-<status>` marker（一个终态一次）。
- **thread 解析 / 身份**：`getChatThreadByIssue(issueId, channel)`（StateStore.ts:2406）、
  `lead.botToken ?? config.discordBotToken`、`config.discordOwnerUserId`（GatePoller 已持有）。
- **lead 归属**：`matchesLead(session, leadId, projects)`（`lead-scope.ts:51`）；
  `ACTIVE_SESSION_STATUSES`（`gate-poller.ts:189`）—— 里程碑巡检要的是**非** active（终态），
  所以自定义终态集合。
- **配置 wiring**：`new GatePoller({...})`（plugin.ts:2934）传 `chatThreadsEnabled` / `discordOwnerUserId` /
  `patrolEveryNTicks` / `founderThreadNotifyGraceMs` 等 —— 新 config 旋钮加在这里。

## 3. 报告内容字段（Session 接口，StateStore.ts:306）

`status`、`issue_identifier`、`issue_title`、`decision_route`（needs_review/blocked/pr_handoff/merged）、
`pr_number`、`pr_head_sha`、`summary` / `diff_summary` / `commit_count` / `files_changed`、`last_error`（失败/阻塞）、
`session_role`（**只报 `main`，跳过 QA runner**）、`last_activity_at`（终态时间戳代理；sessions 表无独立 completed_at）。
→ 一行 body 可组：`{emoji} {identifier} {issue_title} — {中文状态}｜{route/PR #n/summary 摘要} @founder`。

## 4. QA-hold 交互（FLY-579）

`isQaHeld()`（auto-qa-held.ts:43）：`session_role=main` && `status=awaiting_review` && 存在非-passed 的
`auto_qa_record` → founder 不被打扰。**v1 巡检覆盖 completed/failed/blocked（不含 awaiting_review）**
→ 天然不撞 QA-hold。`awaiting_review`（= approve 待批 gate）交给已有 FLY-605 fallback，不重复。
ship-ready（QA **passed**）= 把现有 `notifyShipReady` 的 passive post 加上 `@founder` mention（同 feature flag），
turn 成真 push —— 一处小改，不新增第二套机制。

## 5. Byte-compat / 配置策略（对齐 qa.auto 先例）

- **per-project opt-in**：新 config `founder_milestone_report`（absent = 关 = 字节兼容）；flywheel 自身
  config.yaml default-enable（同 FLY-707 enablement）。
- **fleet kill-switch env**：`FLYWHEEL_FOUNDER_MILESTONE_NOTIFY=0` 硬关（同 `FLYWHEEL_AUTO_QA=0`）。
- 未配 = GatePoller 巡检直接 return（零行为变化）。

## 6. 开放项（写 plan 时按「都 ping」默认，锁定后 implement）

- **覆盖集**：默认 `[completed, failed, blocked, ship_ready]` 全 ping；config `milestones` 列表让 Annie
  以后能把 `completed` 挪去 FLY-727 日报（只留 failed/blocked/ship_ready 实时）而无需改代码。
- **grace**：Bridge-primary 但给极短 grace（如 0–2min）容忍 last_activity_at 抖动 + 避免和 Lead relay
  抢跑造成观感重复；grace=0 = 纯即时。默认取小值，config 可调。
- **lookback**：默认 24h（首次部署不 ping 历史 session）。
