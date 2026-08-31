# FLY-2137 founder 日历写入权治理 — 调研
Issue: FLY-2137 (https://linear.app/geoforge3d/issue/FLY-2137/治理-founder-的-google-calendar-写入权必须定规矩qa-期间实测第二条未授权写入路agent-自建假会议邮件提醒)
日期: 2026-08-31
基于: exploration.md

本文验证 exploration 选定方向(A1 扩展 restart-guard + B1 launchd sweep + C1/C2 QA 豁免)
的每个实现级依赖。全部结论来自本 worktree 代码与本机 CLI 实测(2026-08-31)。

## 1. 拦截层宿主:`flywheel-restart-guard.py` 的可扩展点(实读代码)

文件:`scripts/hooks/flywheel-restart-guard.py`(834 行)。与 P6 集成直接相关的事实:

1. **判定入口** `scan_block(cmd, depth)`(:577):先查 restart 族 P1–P4,再查 P5(brew)。
   P6 作为新分支加在此处;restart 权威优先的既有排序不受影响。
2. **主流程**(`main()`,:784):hit 后构造 `base_rec{ts,session_id,cwd,pattern,command}`,
   然后:bypass 前缀 → ①审计行写入成功 ② `fire_bypass_alert` 返回 strict OK(`sent|queued_transient`)
   **两者都满足才放行**;否则 deny。plain deny 的审计是 best-effort,失败绝不翻 allow。
   P6 沿用同一骨架,只需:
   - 在 bypass 判定处按 pattern 选择 ACK 环境变量(P6 用 `FLYWHEEL_CALENDAR_WRITE_ACK`,
     P1–P5 继续用 `FLYWHEEL_RESTART_GUARD_BYPASS`;两者**互不通用**,防止一次 restart 授权
     顺带解锁日历写);
   - 在 bypass 告警处按 pattern 选择 kind/title/body;
   - 新增 P6 专属 deny 文案与 QA 日历豁免分支(见 §4)。
3. **deny 输出**(:769):PreToolUse JSON `permissionDecision: "deny"` + reason —— 无需新机制。
4. **审计日志**(`audit_path()`,:695):`~/.flywheel/logs/restart-guard.log`,JSON lines,
   自带 10MB 轮转 + 锁。P6 记录复用同一日志(`pattern: "P6"` 可区分),sweep 可关联。
5. **规避对抗机制全部可复用**:segment 切分、透明 wrapper 剥离(`env/sudo/exec/…`)、
   `bash -c` payload 一层重扫(`_extract_c_payload`)、命令替换标记 fail-closed。
   P6 的匹配放进与 P2 同型的「全命令正则 + segment 判定」层即可继承这些。
6. **注册与部署**:`~/.claude/settings.json` PreToolUse(Bash) 已指向
   `~/.flywheel/bin/flywheel-restart-guard.py`(实读 settings 确认);
   installer = `scripts/hooks/install-restart-guard.sh`;
   `packages/teamlead/scripts/claude-lead.sh` :1276–1299 与 :1518–1524 对**每个角色**
   converge。**改同一文件 = 零新增注册面**,部署是 Tier-1(cp,零重启)。
7. **测试基座**:`scripts/hooks/test-flywheel-restart-guard.py` 已存在,P6 用例直接追加。

## 2. 被拦 CLI 写面(本机实测 `--help`)

### 2.1 `gog` v0.10.0(`/usr/local/bin/gog`,brew symlink)

写子命令(含别名,来自 `gog calendar --help`):

```
create|add|new   update|edit|set   delete|rm|del|remove
respond|rsvp|reply   focus-time|focus   out-of-office|ooo   working-location|wl
```

顶级别名 `gog cal …` 等价 `gog calendar …`。读子命令
(`calendars/acl(list)/events/event/search/freebusy/conflicts/colors/time/users/team`)不拦。

### 2.2 `gws`(`~/.npm-global/bin/gws`,npm 全局;凭据 `~/.config/gws/credentials.enc`)

实测三种可写形态:

1. `gws calendar +insert --summary … --start … --end …`(helper,**默认 calendar=primary**);
2. `gws calendar events <verb>` 与顶级 `gws events <verb>` 等价(help 实测同一 usage),
   mutating verbs:`insert|update|patch|delete|quickAdd|import|move`;
3. `gws calendar calendars|calendarList|acl <mutating verb>`——特别注意
   `calendars clear`(清空 primary 全部事件)与 `acl insert`(**给其他账号授写权 =
   绕过全部治理的提权面**),必须在拦截族内。

`gws` 顶级 service 列表(实测 error 输出):`drive, sheets, gmail, calendar, …, events, …`。
匹配必须带 calendar 语境 token(`calendar|cal|events|+insert`),避免误拦
`gws gmail`/`gws drive` 的同名 verb。

### 2.3 其他入口

`gam`/`gcalcli`/`gcal` 本机不存在(`which` 实测)。直接 API 调用不在本单(exploration §5)。

## 3. 正路豁免无需白名单(实测进程)

Raya brain 以独立 daemon 运行:`com.xrli.raya.brain.plist` →
`node ~/.flywheel/raya/code/apps/brain/dist/cli.js run`(ps 实测在跑)。
其 `execFile(gog …)` 不产生 Claude Code PreToolUse 事件 → P6 天然不触碰唯一写入方。
**guard 内不存在任何「Raya 白名单」代码路径** —— 攻击者无法伪装成正路。

## 4. QA 测试日历豁免的数据依赖

- `~/.flywheel/qa-calendar-id`:单行 calendarId 文件;guard 读取(缺失/空 = 无豁免,fail-closed);
- 豁免判定:segment 解析出的目标 calendarId token 与文件内容**逐字相等**才 allow
  (仍写审计行 `decision: allow, note: qa_calendar`);
- Google calendarId 形如 `<hash>@group.calendar.google.com`,与 `primary`/邮箱地址无碰撞;
- `gws +insert` 不显式给 `--calendar` 时默认 primary → 无显式 QA id 一律 deny,豁免不可能被
  「省略参数」骗过。

## 5. 检测层数据面(只读实测)

用最小字段探针实测(不取 summary,避免在 transcript 留 founder 日程内容):

```
gog --account personal --json calendar events primary --days 5 --max 2 \
  --fields "items(id,created,updated,extendedProperties,reminders)"
```

返回确认:`id/created/updated/reminders` 逐事件可得;`extendedProperties` **缺失时整个 key
不出现** —— 「无 `raya_meeting_id`」的判定就是 key 缺失或 `private.raya_meeting_id` 缺失。
`events` 另支持 `--from/--to/--all-pages/--private-prop-filter`(help 实测)。

诚实边界(设计必须写明):Calendar API 不暴露「创建方 client」;gog 建的事件 creator 就是
founder 本人。sweep 的「机器嫌疑」只能是启发式:
`无 raya_meeting_id` ∧ `created/updated ≥ 游标` ∧ 关键词命中
(`FLY-\d+|GEO-\d+|flywheel|raya|discord\.com/channels|QA|验收|测试|Tadashi|…`)。
**report-only,绝不删除。**

## 6. 告警通道合同(实读代码)

1. `scripts/lead-alert.sh`:kind 是 **fail-closed 白名单**(:200 case 分支,未知 kind =
   config_error)。新增 kind 必须显式进该 case + 头部 usage 注释。先例:FLY-913 的
   `restart_guard_bypass` 就是这样加的。
2. Bridge 侧共享 union:`packages/teamlead/src/LeadAlertNotifier.ts` :357
   `AlertEventType = (typeof ALERT_EVENT_TYPES)[number]`;
   copy 表 `packages/teamlead/src/bridge/alert-kind-copy.ts` 的
   `titleFor/severityFor/bodyFor` 均为 exhaustive switch —— 新 kind 需三处同步
   (union 数组 + title + body;severity 走默认或显式)。注释明示「shell 独占 kind 也要进
   union 保持 exhaustive」。
3. `fire_bypass_alert`(guard :723)固定 `--kind restart_guard_bypass`;P6 需要
   pattern-conditional kind。签名 `make_signature` 每次全局唯一(`duplicate` 结果视为异常
   deny)—— P6 沿用。
4. 本单新增两个 kind(显式加白,不复用旧 kind —— 依据「悄悄把新枚举塞进旧白名单本身就是
   finding」的既有教训):
   - `calendar_guard_bypass`(severe):P6 ACK bypass 被使用;
   - `calendar_wild_write`(warning):sweep 发现嫌疑事件。

## 7. sweep 宿主先例(实测本机)

`~/Library/LaunchAgents/` 已有同型日任务:`com.flywheel.log-janitor` /
`com.flywheel.quota-monitor` / `com.flywheel.daily-standup` / `com.flywheel.token-usage-daily`。
仓内先例:`scripts/com.flywheel.log-janitor.plist` + `scripts/daily-digest.sh`
(env 文件 snapshot/restore 模式,R4 #3/R9 教训已内建 —— sweep 脚本照抄该 env 处理模式)。
plist 安装属机器配置变更,按既定规矩由 Lead/founder 在部署窗口执行,不在 CI/QA 自动装。

## 8. 结论:选型确认

| 层 | 选型 | 关键依据 |
|---|---|---|
| 拦截 | A1:restart-guard 加 P6(gog+gws,双 CLI) | §1 零新增注册面 + 规避对抗继承;§2 双 CLI 写面已枚举 |
| 豁免 | C1 QA 日历 id 文件逐字匹配 + C2 独立 ACK env(记账合同不减配) | §4 fail-closed 可实现;§6 bypass 告警链路可复用 |
| 检测 | B1:`scripts/calendar-write-sweep.mjs` + 每日 launchd,report-only | §5 数据面已实测;§7 宿主先例充分 |
| 告警 | 新增 2 个 kind,显式进 shell 白名单 + Bridge union/copy 表 | §6 |

待 Lead 裁决(非阻塞,已发 ask `a4f9a8b1`):动词族含 respond/三马甲、sweep 每日一次、
QA 日历由 Lead 部署窗口创建。未获回复即按上述默认进入 plan。
