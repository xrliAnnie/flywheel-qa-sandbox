# FLY-2130 Raya 排会同步 Google Calendar — 探索
Issue: FLY-2130 (https://linear.app/geoforge3d/issue/FLY-2130/raya会议-排会同步写入-founder-的-google-calendar)
日期: 2026-08-28
基于: 无

## 1. Founder 要的结果

Founder 在 FLY-2032 ship 报告页的要求是：Raya 排会除了写入 `meeting.json`，还要进入 founder 的 Google Calendar，免得她忘记。任务补充把闭环写清了：

- 成功排会时创建 Calendar event；
- event 带准确时间、参与 Lead、议题和会议 Discord thread 链接；
- 取消时同步取消 Calendar event；
- 改期时同步更新 Calendar event；
- 本机已经安装 `gog`，账号默认 `personal`，最终以 founder 确认为准。

这不是另造一套日历服务。Calendar 是 FLY-2032 持久排会的一个外部投影，`meeting.json` 仍是当前会议的本地真源。

## 2. 当前事实

### 2.1 FLY-2032 的真实落点

依赖实现不在 Flywheel runtime，而在独立 Raya 仓的 PR `xrliAnnie/raya#5`，当前 head `7743dab`。关键顺序是：

1. `scheduleMeeting` 写 `RAYA_STATE_DIR/meeting.json`；
2. `deliverMeetingNotifications` 发共享排会卡、打真 `@` 并创建 thread；
3. `notifications.json` 持久化 Discord message/thread id；
4. Raya 才回复「已安排」。

Calendar event 必须带 thread 链接，因此不能在第 1 步之前创建；最早且信息完整的接点是第 3 步之后。

### 2.2 已有命令边界

FLY-2032 已有精确命令：

- `安排会议 ...`
- `取消会议`
- `结束会议`

它没有改期命令，而且 `scheduledAt` / `durationMinutes` 当前被视为不可变字段。任务明确要求改期同步，因此需要决定这单是否增加一个最小、精确的改期入口。已向 Lead 发非阻塞问题 `520d026a-79d2-429f-9fbc-81e6d2c72941`；未收到相反指令时，本设计按 `改期会议 [明天] HH:MM [时长 N]` 实现，不做模糊 NLP。

### 2.3 账号与本机状态

本机 `gog` 是 v0.10.0，支持 Calendar create/update/delete 和按 private extended property 查询。探索时对 `personal` 的只读 calendar-list 探针返回 OAuth `invalid_grant`；2026-08-28 founder 完成 re-auth 后，Lead 已实测 calendars 列表与 `primary` 事件读取成功，activation 前置已解除。本单不读取、复制或修改凭据。

账号确认问题已通过 `111f2902-d9d7-4520-9ae8-6019aec06819` 非阻塞发给 Lead。未收到相反指令时：account 默认 `personal`，calendar id 默认 `primary`，均允许由 owner-private env 覆写。

## 3. Ponytail 决策梯

| rung | 判断 | 结论 |
|---|---|---|
| 1 Skip | Founder 明确要求，不能跳过 | 继续 |
| 2 标准库 | Node `child_process.execFile` 足够安全调用现有 CLI | 使用 |
| 3 原生平台 | Google Calendar 没有本地原生写入口 | 不适用 |
| 4 已装依赖 | `gog` 已安装并已经覆盖 CRUD/查询 | 使用，不加 npm 包 |
| 5 一行 | 需要 event id、崩溃重试和取消/改期，单行 shell 无法正确闭环 | 不适用 |
| 6 最小实现 | 一个 `gog` adapter + 一个小型 durable receipt + 三个 runtime 接点 | 采用 |

明确不造：Calendar SDK wrapper 层、队列服务、数据库表、通用外部投影框架、凭据管理器、Google Meet、重复会议、邀请邮件。

## 4. 必须守住的不变量

1. **不报假成功**：Calendar 成功时才回复普通「已安排」；Calendar 失败时会议本身仍排好，但回复必须显式带「Google Calendar 未同步」降级警告，不能把它包装成完整成功。
2. **不重复建 event**：进程若在 Google create 成功、写本地 receipt 前崩溃，重试必须找回既有 event，而不是再建一个。
3. **取消不锁死会议系统**：Google delete 失败必须显式警告，但本地会议照常归档/清除，founder 仍能排下一场。
4. **改期可恢复**：本地 `meeting.json` 已改而 Google update 失败时，receipt 仍显示旧时间，后续 tick 可补齐；失败不阻断到点生命周期。
5. **外部失败可见且 fail-open**：`gog` 不存在、超时、OAuth 失败、输出损坏都显式警告，不吞掉；Calendar 失败永远不能阻止开始、missed、结束、取消归档或下一次排会。
6. **不把 shell 当 parser**：所有参数通过 `execFile(argv)`，不拼 shell command。
7. **凭据不进仓、不进 argv**：只传 account selector；OAuth token 仍由 `gog` 自己的 store 管理。
8. **Calendar 不改变会议生命周期语义**：正常结束/错过保留 event；只有明确 `取消会议` 才尝试删除；失败只降级 Calendar，不锁住 `meeting.json`。

## 5. 范围

### 本单做

- Raya brain 接入 `gog calendar`；
- 创建、改期、取消闭环；
- event 标题/描述包含 Lead、议题、thread URL，开始/结束时间准确；
- 持久 receipt、幂等崩溃恢复与 fail-open 降级；
- account/calendar/bin 配置与边界校验；
- hermetic 单元/集成测试；
- 基于 FLY-2032 head 的 Raya PR，以及 Flywheel 设计/里程碑文档 PR。

### 本单不做

- 修复或轮换 founder 的 Google OAuth；
- 生产部署、launchd 重启或真写 founder Calendar（需 owner/Lead 窗口）；
- 把 AI Lead 当 Google attendee 发邀请；
- Calendar 反向修改 `meeting.json`；
- 手工编辑 Calendar 后的双向冲突合并；
- 改主题、换 Lead、批量/重复会议或模糊自然语言改期。

## 6. 验收口径

- 自动化证明 create argv 的起止时间、Lead、议题、thread URL 与 private property；
- 同一 meeting 重试不会 second-create；
- 改期走 update，不换 meeting id；
- 取消走 delete，重复取消不报假失败；
- `gog` 失败时发明确降级警告，会议生命周期和后续排会不受阻；
- 既有 FLY-2032 meeting tests 与 Raya 全仓 gates 保持绿；
- 真账号验收单列为部署操作证据，不能用 mock 绿替代；`personal` re-auth 后的 calendars 列表与 `primary` 事件读取已由 Lead 验证通过。
