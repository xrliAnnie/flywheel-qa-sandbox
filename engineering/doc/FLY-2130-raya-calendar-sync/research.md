# FLY-2130 Raya 排会同步 Google Calendar — 调研
Issue: FLY-2130 (https://linear.app/geoforge3d/issue/FLY-2130/raya会议-排会同步写入-founder-的-google-calendar)
日期: 2026-08-28
基于: exploration.md

## 1. 依赖代码核验

核验对象：Raya PR #5，branch `fly-2032-raya-meeting`，head `7743dab`。

| 事实 | 证据位置 | 结论 |
|---|---|---|
| 当前快照 | `packages/contracts/src/meeting.ts:meetingPath/writeCurrentMeeting` | `meeting.json` 是本地当前会议真源 |
| Discord thread receipt | 同文件 `meetingNotificationReceiptPath` / `recordMeetingNotificationDeliveries` | thread id 已有 owner-private 原子 JSON 落点 |
| 排会顺序 | `apps/brain/src/meeting.ts:scheduleMeeting/createMeetingRuntime.schedule` | 先写 meeting，再发卡/thread |
| 重试入口 | 同文件 `createMeetingRuntime.tick` | scheduled meeting 每 15 秒已有补交循环，无需新 scheduler |
| 取消入口 | 同文件 `createMeetingRuntime.cancel` | 只允许 scheduled，转 cancelled 后归档 |
| 改期入口 | 不存在；`IMMUTABLE_FIELDS` 包含 `scheduledAt` / `durationMinutes` | 必须新增受限 API，不能放宽通用 patch |
| runtime 配置 | `apps/brain/src/config.ts` + `cli.ts` | env 解析与 dependency wiring 都在 brain |

### 1.1 为什么接在 thread 之后

需求里的会议 thread URL 只有 Discord publish 成功后才存在。Raya 已持久化 `threadId`，链接可确定构造为：

```text
https://discord.com/channels/<guildId>/<threadId>
```

所以 Calendar 同步不需要再调 Discord，也不需要存一份可漂移的手工 URL。

### 1.2 为什么不用 `meeting.json` 塞 event id

候选有三种：

| 方案 | 代价 | 结论 |
|---|---|---|
| 给 `Meeting` 加 `calendar` 字段 | 外部投影状态混入会议域 schema；每次外部重试都改当前快照 | 不选 |
| 从 `meeting-events.jsonl` 反向折叠 event id | 要新增日志 scanner/fold，取消与改期恢复更复杂 | 不选 |
| `meetings/<id>/calendar.json` receipt | 与现有 `notifications.json` 同形，单文件原子覆盖，终局后仍可审计 | 选 |

receipt 至少保存 `meetingId/account/calendarId/eventId/threadUrl/scheduledAt/durationMinutes/syncedAt`，取消成功后加 `cancelledAt`。`scheduledAt + durationMinutes` 是检测 Google 投影是否落后于 `meeting.json` 的最小游标。

## 2. 本机 `gog` 合同

实测 binary：`/usr/local/bin/gog`，v0.10.0 (`a92bd63`)。

### 2.1 创建

```text
gog --account=<account> --json --results-only --no-input \
  calendar create <calendarId> \
  --summary <title> --from <RFC3339> --to <RFC3339> \
  --description <text> \
  --private-prop raya_meeting_id=<uuid> --visibility private
```

dry-run 已证明 request 可携带 RFC3339 start/end、description 与 private extended property。真实成功输出预期至少含 Google event `id`；adapter 对缺 id/坏 JSON fail-closed。

### 2.2 查找与幂等

`calendar events` 支持：

- `--private-prop-filter key=value`
- `--from` / `--to`
- `--max`
- `--fields`
- JSON / results-only

本机 v0.10.0 的两个易错事实已经按 reviewer R1 从源码核实：

- `--fields` 对 `calendar events` 直接进入 Google events.list partial-response，不会被 desire-path rewrite；正确值是 `items(id)`，不是顶层不存在的 `id`。
- 未显式给 `--from/--to` 时，`gog` 只查 `[now, now+7d]`。幂等查询必须给显式时间窗，否则刚结束的 event 会被漏掉。

每次 create 前按 `raya_meeting_id=<meeting.id>` 查 0–2 条，固定 argv：

```text
calendar events <calendarId>
  --private-prop-filter=raya_meeting_id=<uuid>
  --from=<windowStart> --to=<windowEnd>
  --max=2 --fields=items(id)
```

时间窗围住本地 current time 与旧 receipt time（两者的最早 start - 24h 到最晚 end + 24h）；所以 create 后崩溃、event 已结束、以及大跨度改期后找旧 event 都不会退回 `gog` 默认窗口。

查询结果：

- 0 条：create；
- 1 条：复用该 id，必要时 update；
- 2 条：fail-closed，明确报告 duplicate，而不是任选一个。

这关闭了「Google create 成功、local receipt 未落盘」的崩溃窗口。private property 不是安全边界，只是幂等键；meeting UUID 不含秘密。

### 2.3 更新

```text
gog --account=<account> --json --results-only --no-input \
  calendar update <calendarId> <eventId> \
  --summary <title> --from <RFC3339> --to <RFC3339> \
  --description <text> --visibility private
```

改期只变 `scheduledAt` 与可选 `durationMinutes`，Lead/topic/thread 不变。若 receipt 指向的 event 已被手工删除，private-property 查找为 0 后重新 create，保证 Calendar 最终仍有这场会议。

### 2.4 删除

```text
gog --account=<account> --json --results-only --no-input --force \
  calendar delete <calendarId> <eventId>
```

取消先按 private property reconcile：找不到 event 即视为外部取消已经完成；找到一条才 delete。这样 delete 后崩溃的重试不依赖解析 Google 的 404 文案。

### 2.5 当前账号证据

只读命令：

```text
gog --account personal --json --results-only calendar calendars
```

探索时返回 `oauth2: "invalid_grant"`。2026-08-28 founder 完成 `personal` re-auth 后，Lead 已实测 calendars 列表与 `primary` 事件读取成功。代码仍不特殊吞掉 OAuth 错误，也不尝试自动 re-auth。

## 3. Node 调用边界

Raya 已经在 `apps/brain/src/voice-mode.ts` 用 Node 标准库 `execFile` 调 `launchctl`。Calendar adapter 沿同一形状：

- binary 与 argv 分离；
- `encoding: "utf8"`；
- timeout 与 `maxBuffer` 有界；
- 测试注入 `run(args)`，不触碰真 Calendar；
- stderr/exit error 转成一条不含凭据的明确错误。

不需要 `execa`、Google SDK 或 shell helper。

## 4. 改期的最小可达形状

任务要求改期同步，但依赖没有改期入口。为了不造通用 edit API，最小形状是：

```text
改期会议 [明天] HH:MM [时长 N]
```

约束：

- 只作用于当前 `scheduled` meeting；
- 不换 meeting id / Lead / topic / thread；
- 未给时长则沿用原时长；
- 通过专用 `rescheduleCurrentMeeting` 改时间，通用 `updateCurrentMeeting` 继续把它视为 immutable；
- 精确解析，不猜、不接受「晚一点」等模糊时间。

Lead question `520d026a-79d2-429f-9fbc-81e6d2c72941` pending；如果 Lead 否决 UI 入口，就保留专用 runtime/API 与测试、删除 parser/controller 分支，不扩大其他设计。

## 5. 失败与恢复矩阵

| 失败点 | durable state | 下一步 |
|---|---|---|
| Discord card/thread 失败 | `meeting.json` 在，notification receipt 不全 | 既有 tick 补 Discord；Calendar 不提前建 |
| Calendar lookup/create 失败 | meeting + thread 在，calendar receipt 缺 | 回复明确降级警告；tick 可继续补 Calendar，但不阻断会议开始/missed |
| create 成功、receipt 前崩溃 | Google event 在，本地 receipt 缺 | private property 找回 event，不 duplicate create |
| 改期 update 失败 | meeting 是新时间，receipt 是旧时间 | 回复降级警告；tick 比较游标后重试，同时照常到点 |
| delete 失败 | Google event 可能仍在 | 回复取消成功 + Calendar 警告；本地照常归档/清除，避免 meeting 子系统被锁死 |
| delete 成功、receipt 前崩溃 | Google event 不在，本地 receipt 未 cancelled | 同次调用查询不到则闭合；若进程已死，本地取消仍必须可归档，不能以 Calendar 阻断 |
| receipt 损坏 | 文件在但 validation 失败 | fail-closed，禁止猜 event id |
| 查到多个相同 private prop event | Google 有重复 | fail-closed 并报告人工去重 |

Calendar 的 fail-closed 仅指「不猜 Google event id/不声称同步成功」；会议本地 FSM 一律 fail-open。另加显式 `RAYA_MEETING_CALENDAR_ENABLED=false` kill switch，在 OAuth/binary 故障期间保住整个会议功能。

## 6. 仓与分支

- Flywheel worktree `flywheel-FLY-2130`：full-tier 三件套、progress、最终 milestone；
- Raya 实现：从未合并的依赖 `origin/fly-2032-raya-meeting@7743dab` 建独立 `fly-2130-raya-calendar-sync` worktree；
- 不直接改 FLY-2032 worktree，不 force-push，不把 Flywheel runtime 依赖引进 Raya；
- 两个 repo 各自 PR；Raya PR 明确 base/dependency 是 PR #5，避免把 4,484 行依赖 diff 伪装成本单代码。
