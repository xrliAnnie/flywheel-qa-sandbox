# FLY-2137 founder 日历写入权治理 — 探索
Issue: FLY-2137 (https://linear.app/geoforge3d/issue/FLY-2137/治理-founder-的-google-calendar-写入权必须定规矩qa-期间实测第二条未授权写入路agent-自建假会议邮件提醒)
日期: 2026-08-31
基于: 无

## 1. 问题与实测事件

2026-08-29 01:3x,FLY-2130 QA(f5bb4933)在 529 房测试期间实测:另一个 Flywheel agent
(FLY-2130 issue thread 自动化,qa-lead-B,Claude Code 会话)看到测试消息后,自行向
founder 的**真** Google Calendar 创建了「FLY-2130 日历同步验收 — 与 Tadashi」事件——
无 `raya_meeting_id`(非 FLY-2130 正路代码所建)、带 10 分钟邮件提醒。QA 手工删除止损。

问题本质:founder 日历是个人高敏面,但当前**不止一条路能写**:

- **正路**(FLY-2130):Raya meeting 模块,带 `raya_meeting_id` private extended property
  标记 + `calendar.json` receipt + 事件审计,幂等、可归因;
- **野路**:`gog` 凭据(`personal` account,macOS Keychain)机器全局可用,任何拿到 shell
  的 agent 都能 `gog calendar create` —— 零标记、零审计、事后无法归因。

## 2. 现状审计(攻击面)

### 2.1 正路(唯一合法写入方)

- Raya brain 是独立 daemon:`com.xrli.raya.brain.plist` →
  `~/.flywheel/raya/code/apps/brain/dist/cli.js run`(实测在跑,pid 级确认);
- 它通过 `execFile('/usr/local/bin/gog', …)` 直接调用,**不经过任何 Claude Code hook**;
- 每个写事件带 `raya_meeting_id=<meetingId>` private prop,receipt 落
  `meetings/<id>/calendar.json`,详见 `engineering/doc/FLY-2130-raya-calendar-sync/plan.md`。

关键性质:**正路不在 agent 会话里**。因此拦截层可以做成「agent 会话内一律禁止日历写」,
不需要为 Raya 开任何白名单/豁免 —— 唯一写入方规则的实现反而变简单了。

### 2.2 野路清单(本机可写 founder 日历的入口)

| 入口 | 位置 | 凭据 | 写能力 |
|---|---|---|---|
| `gog` v0.10.0 | `/usr/local/bin/gog`(brew symlink → Cellar) | Keychain(config: `~/Library/Application Support/gogcli/config.json`) | ✅ 完整 |
| `gws` | `~/.npm-global/bin/gws`(npm 全局) | `~/.config/gws/credentials.enc` + token_cache | ✅ 完整(`gws calendar events insert/update/delete…`、`+insert` helper) |
| 直接 Google API | 任意进程读取上述凭据后直连 | 同上 | ✅(本单不治理,见 §5) |

`gam` / `gcalcli` / `gcal` 本机不存在。**只拦 `gog` 会给 `gws` 留一扇明门,拦截层必须同时覆盖两个 CLI。**

`gog calendar` 写子命令全集(v0.10.0 实测 `--help`,含别名):

- `create|add|new`、`update|edit|set`、`delete|rm|del|remove`
- `respond|rsvp|reply`(改写事件出席状态,组织者可见 → 算写)
- `focus-time|focus`、`out-of-office|ooo`、`working-location|wl`(三者都是「创建事件」的马甲)

读操作(`events/event/search/freebusy/conflicts/calendars/colors/time/acl/team/users`)不设限。

### 2.3 可复用的既有机制

1. **`scripts/hooks/flywheel-restart-guard.py`**(834 行,FLY-913):user 级 PreToolUse
   (matcher: Bash)hook,已注册在 `~/.claude/settings.json`,部署为
   `~/.flywheel/bin/flywheel-restart-guard.py`(Tier-1:cp 即生效,零重启)。
   - 它**已经不只是 restart guard**:P5 是 FLY-1944 的 Homebrew 宿主工具链护栏 ——
     该文件的真实身份是「Flywheel 机器边界 Bash 护栏」;
   - 自带 battle-tested 的规避对抗机制:segment 切分(`;/&&/||/|`)、透明 wrapper 剥离
     (`env/sudo/exec/time/…`)、`bash -c` payload 重扫、命令替换 fail-closed;
   - 自带 bypass 记账合同:`FLYWHEEL_RESTART_GUARD_BYPASS=<reason>` 前缀,放行前置 =
     「审计 JSON 行写入成功 **且** `lead-alert.sh --strict-delivery` 返回 sent/queued_transient」
     缺一不可,记账失败绝不放行;deny 分支审计 best-effort、永不因审计失败翻成 allow;
   - installer `scripts/hooks/install-restart-guard.sh` + `claude-lead.sh` 每角色 converge。
2. **launchd 周期任务先例**:`com.flywheel.log-janitor` / `quota-monitor` /
   `daily-standup` / `token-usage-daily` 等 —— 独立 sweep 脚本 + plist 是既定模式。
3. **`scripts/lead-alert.sh`**:告警投递通道(strict-delivery 语义已被 guard 依赖)。
4. **gog 检测面数据可用性**:`gog calendar events` 支持 `--from/--to`、`--fields`、
   `--private-prop-filter`、`--all-pages`、`--json` —— sweep 能拿到
   `extendedProperties/created/updated/creator/reminders` 判定野路事件。

## 3. 方案选项

### 3.1 拦截层(规矩 1:唯一写入方)

| 选项 | 内容 | 评估 |
|---|---|---|
| **A1(推荐)** 扩展 restart-guard 加 P6「日历写」模式族 | 在同一 hook 文件加 P6:任一 segment 调用 `gog`+`calendar|cal`+写子命令,或 `gws`+calendar 写形态 → deny;QA 测试日历豁免 + `FLYWHEEL_CALENDAR_WRITE_ACK` bypass(复用记账合同) | 复用注册/converge/installer/审计/告警/规避对抗全套;新增面最小;P5 先例证明该文件就是机器边界护栏 |
| A2 新建独立 `flywheel-calendar-guard.py` | 独立文件、独立注册 | 关注点干净,但要新增 settings.json 注册 + converge 接线 + 复制或抽公共库整套 bypass/审计/告警 plumbing —— 纯增机制,违反「只删不加」精神 |
| A3 wrapper 二进制 / PATH shim 包住 gog | 覆盖所有进程(含 Codex 直连 shell) | `brew upgrade gogcli` 会还原 symlink(静默失效);动 `/usr/local/bin`/全局 PATH 违反机器配置纪律;且 Raya 正路也会被包进去,需要反向豁免,复杂度倒挂。**否决** |

A1 细节裁决:

- **全会话 deny**(含 Lead/founder 交互会话),不按 `FLYWHEEL_EXEC_ID` 区分:实测事件的
  肇事者 qa-lead-B 正是 Lead 类会话;founder 自己的合法路径 = 普通终端直接跑 gog,或 ACK 前缀;
- **ACK bypass**:`FLYWHEEL_CALENDAR_WRITE_ACK=<reason>` 锚定前缀,语义对齐
  `FLYWHEEL_FORCE_PUSH_ACK`(须 founder/Lead 明确授权后单条命令使用),放行前置沿用
  「审计写入 + 告警确认送达」缺一不可 —— bypass 自带广播,不存在无声越权;
- **dry-run 也拦**:`-n` 不产生写,但 fail-closed 更简单,agent 没有正当理由 dry-run 建会;
- 读命令与 `gmail`/`drive` 等其他 service 完全不动(scope 纪律)。

### 3.2 检测层(规矩 2:越权写入 sweep)

| 选项 | 内容 | 评估 |
|---|---|---|
| **B1(推荐)** 独立 launchd 每日 sweep 脚本 | `scripts/calendar-write-sweep.mjs` + `com.flywheel.calendar-sweep.plist`;列 founder primary 未来窗口事件,标记「无 `raya_meeting_id` 且 created/updated 晚于游标且命中机器嫌疑启发式」→ `lead-alert.sh` 报告 | 复用成熟模式;不动 Bridge;部署独立 |
| B2 Bridge patrol 内置 | patrol-config + Bridge 代码 | 有 liveness 监护,但要动 Bridge 代码 + 等重启班车,机制更重。**否决(v1)** |

诚实边界:Google Calendar API **不暴露**「事件由哪个 client 创建」——「机器创建」无法精确
判定(gog 创建的事件 creator 就是 founder 本人,与手工创建无异)。sweep 用启发式
(`FLY-\d+|GEO-\d+|flywheel|discord\.com/channels|QA|验收|测试` 等关键词 + 新近 created)
圈嫌疑,**report-only,绝不自动删**(误删 founder 真实日程不可接受)。

### 3.3 QA 例外(规矩 3:测试日历)

- founder/Lead 一次性在 `personal` account 下建专用「Flywheel QA」日历(非 primary),
  其 calendarId 落 `~/.flywheel/qa-calendar-id`(单行文件);
- P6 豁免:命令中写目标 calendarId 与该文件内容**逐字相等**才放行(仍写审计行);
  文件缺失/为空 = 无豁免,fail-closed;
- QA 文档/skill 更新指向该日历。

## 4. 覆盖矩阵(拦截层 A1)

| 写入路径 | 是否被 P6 拦 | 备注 |
|---|---|---|
| Claude Code 会话(Lead/Runner/QA/交互)Bash 工具跑 gog/gws 写 | ✅ | **实测事件路径即此类** |
| `bash -c` / wrapper(`env`、`sudo`、`nohup`…)包裹 | ✅ | 复用既有 payload 重扫 |
| Raya brain daemon(正路) | 不经过 hook,天然放行 | 唯一写入方,无需白名单 |
| Codex / Gemini / Kimi runner 直连 shell | ❌ hook 不覆盖 | 检测层兜底;见 §5 |
| agent 把调用写进脚本文件再执行 | ❌ hook 只见 `./x.sh` | 检测层兜底 |
| 直接读凭据调 Google API | ❌ | 凭据隔离 = future work |

## 5. 明确不做(本单边界)

- 不做凭据隔离(Keychain ACL / 按 agent 分票据)—— 是根治方向,但改动面横跨所有
  Google Workspace 用法,单独立项;
- 不拦 `gmail send`/`drive` 等其他写面(issue scope = calendar);
- 不做 sweep 自动删除/自动修复;
- 不给 sweep 加 dead-man 监护(v1 接受;后续可挂 quota-monitor 类心跳)。

## 6. 待 Lead 裁决(非阻塞,按推荐默认前进)

1. P6 动词族是否含 `respond`(RSVP)与 `focus-time/ooo/working-location` 三马甲?
   —— 默认**含**(fail-closed);
2. sweep 频率与告警去向 —— 默认每日一次,报 `lead-alert.sh` 既有告警通道;
3. QA 测试日历由谁建 —— 默认 Lead 在部署窗口一次性建好并落 id 文件。
