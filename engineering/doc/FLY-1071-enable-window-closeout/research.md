# FLY-1071 enable 窗收尾执行 — 调研
Issue: FLY-1071 (https://linear.app/geoforge3d/issue/FLY-1071/ops-fly-1049-enable-窗收尾执行-双-bot-探针-send-收紧-演练oom-后替身执行单)
日期: 2026-07-09
基于: exploration.md（同文件夹；brainstorm gate 已获 Tadashi 四点全批）

> 本文回答「怎么修、怎么验、怎么演练」的机制级问题，全部结论有代码/现场出处。
> 生产在本 design 阶段零改动。

## R1 · W5（claude-infra-bot-lead）修复机制

**frontmatter 合同**：claude-lead.sh 以 `--agent "$LEAD_ID"` 启动（`claude-lead.sh:1613`），
Claude Code 按 `~/.claude/agents/*.md` 的 frontmatter `name:` 注册 agent → **`name:` 必须逐字
等于 `claude-infra-bot-lead`**。安装是裸 `cp`（`claude-lead.sh:592-594`），frontmatter 必须源文件自带。

**修复模板**（加到 `.lead/claude-infra-bot-lead/identity.md` 文件头；正文原样保留）：

```yaml
---
name: claude-infra-bot-lead
description: Claude Infra Bot (claw) — Flywheel 基础设施自愈 Bot。#flywheel-alerts 工单默认主力 owner:救 Codex 侧账号/auth、救 runner 卡死、发 #flywheel-notify 例行通知。低频、精准、不开 Runner、不碰产品代码。
model: sonnet
permissionMode: bypassPermissions
disallowedTools: Agent
---
```

字段依据：`model: sonnet` 对齐 projects.json（sonnet/high）；`permissionMode: bypassPermissions`
为无人值守必需（belle/eng-lead 同款）；`disallowedTools: Agent` 取 belle 同款 —— claw 需要 Bash
跑救援 CLI（flywheel-codex-profile 等），不能照抄 eng-lead 的禁 Write 集。

**双落点**：
1. **repo（durable）**：本分支改 `.lead/claude-infra-bot-lead/identity.md`，随本单 PR merge →
   生产 `git pull` 后 wrapper 下次启动重装。
2. **手补（止血，窗内立即生效）**：把修好的完整文件拷到
   `~/.claude/agents/claude-infra-bot-lead.md`（机器状态，非 repo）。Claude CLI **每次启动**重扫
   agents 目录，supervisor 60s 循环自愈 —— **无需重启 wrapper/launchd**，下一轮 fresh start 即恢复。
   覆盖窗口：仅当 wrapper 进程重启（launchd 重拉）时会用 repo 旧源覆盖手补 → 尽快 merge 收敛。

**验证判据**：pane 不再打印「可用 agent 列表」报错；claude 进入常驻 TUI（≥10min 不 exit）；
supervisor 日志 crash count 停止增长；dev-channels 确认框由 FLY-109 dialog poller 自动 Enter
（`claude-lead.sh:972-1028`，无需人工）。

## R2 · W4（codex-infra-bot-lead）修复机制

**修复顺序**（避免 KeepAlive 与 login 竞争写 `~/.codex-infra-bot`）：

1. `launchctl bootout gui/$UID/com.flywheel.lead.flywheel-codex-infra-bot-lead`（停 job；
   **FLY-913 护栏若拦 launchctl → 把 bootout+login+bootstrap 写成脚本文件递交 Tadashi 执行，先例已走通**）；
2. 清残留：确认无孤儿 `codex app-server` / `remote-control` 进程（有则 kill 该 home 名下的）；
3. **fresh login**：`CODEX_HOME=~/.codex-infra-bot codex login` → 浏览器 OAuth（localhost 回调），
   账号沿用 **xrliannie.b@gmail.com**（business）。首选 codex-relogin 流程的 Chrome 自动化；
   走不完 → Annie 点一次（已批：与 Send 收紧合并同一次打扰）。
4. **纪律**：不动 codex-profile 池的轮转（memory 红线）；该 home 的 auth.json **不拷回池、
   池的 auth.json 不再拷进来**（refresh_token_reused 的成因就是共享 session 被轮转顶掉）；
5. 验证：`CODEX_HOME=~/.codex-infra-bot codex login status` 显示已登录且能刷新；
6. `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.flywheel.lead.flywheel-codex-infra-bot-lead.plist`
   → 观察 wrapper 一轮起满：app-server 起来、`app-server-control.sock` 出现、TUI pane 进 codex。

**已知 WARN 不修（只报）**：FLY-513 全局 `~/.local/bin/codex` symlink 解析进该 home 的
standalone releases —— wrapper 每轮打 WARN 并给出 `ln -sfn` 修复指引；Tadashi 已确认本窗不动、
单记 follow-up。

## R3 · verify-windowed-lead 双 bot 逐层

脚本 `packages/teamlead/scripts/verify-windowed-lead.sh <project> <leadId>`：只读、5 层、
exit 0=全绿 / 10+N=第 N 层先红。**原生为 Codex TUI Lead 写**（层2 认 `codex-lead-tui-runtime.js`、
层3 认 daemon socket、层5 认 pane 跑 codex）。

- **W4**：直接跑 `verify-windowed-lead.sh flywheel codex-infra-bot-lead`（默认 codex-home
  即 `~/.codex-infra-bot`）→ 要求 5/5 PASS + cmux 目视 tab（C6 §5.5 证据门）。
- **W5**：脚本层2/3/5 不适用 Claude 后端 → **逐层手工等效**（同为只读探针）：

| 层 | Codex 版 | W5 Claude 等效 |
|---|---|---|
| 1 | launchd job 有活 pid | `launchctl print gui/$UID/com.flywheel.lead.flywheel-claude-infra-bot-lead` 有 pid |
| 2 | pid 是 TUI runtime | pid 进程树里是 `claude-lead.sh` supervisor（bash）且其 tmux 目标窗口存在 |
| 3 | daemon socket 在 | 无 socket —— 等效 = supervisor 日志无新 crash 行（crash count 停增） |
| 4 | tmux window 活 | `tmux list-windows -t flywheel` 有 `flywheel-claude-infra-bot-lead` 且 `pane_dead=0` |
| 5 | pane 跑 codex | `tmux display -pt <win> '#{pane_current_command}'` = node/claude（非 bare shell） |

另加 W5 专属第 6 证据：Discord 侧 bot 在线（#claude-infra-bot 里 claw 显示 online / 对 Annie
指令有响应 —— 探针 ① 会一并证明）。

## R4 · 三条入站探针（机制与判据）

发帖统一用 dispatcher 真 token（工单帖作者=dispatcher 的生产不变量）：

```bash
source ~/.flywheel/.env
curl -sf -X POST "https://discord.com/api/v10/channels/1518793447165661254/messages" \
  -H "Authorization: Bot ${FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN}" -H "Content-Type: application/json" \
  -d '{"content":"<探针文案>"}'
```

| # | 内容 | 预期 | 判据（证据留档） |
|---|---|---|---|
| ① 正向 | 带 `<@1524829037825101975>` 的工单样式帖 + (可删) | claw 被唤醒并响应 | ≤120s 内 W5 pane 出现该 inbound（tmux capture 留档）+ claw 在频道回 ACK；记 message id |
| ② 负向 | 同 token、无任何 mention | claw 不醒 | 观察 ≥120s，W5 pane 无该帖处理痕迹（requireMention:true 挡住）；记 message id |
| ③ 负向 | 带 `<@1523219324561522831>`（@Codex bot） | claw 不醒；W4 收到（顺带正向证 W4 mention-gate） | W5 pane 无处理 + W4 pane 出现 inbound；记 message id |

机制依据：W5 access.json Alerts group `requireMention:true` + allowBots 含 dispatcher（已核）；
FLY-267 mention-gate「没被 @ ⇒ 不动手」。探针帖全部标注「(可删)」，收口后清理。

## R5 · Send 收紧精确步骤（交 Tadashi 转达 Annie，一次打扰）

对象 = #flywheel-alerts（1518793447165661254）。**影响面已排查**（exploration §2.4）：全 fleet 仅
claw 的 alertChannel 指向该频道；Bridge 侧工单/auto-repair 发送经 env 走 dispatcher token →
收紧不误伤任何现有发送方。Annie 操作（频道设置 → 权限）：

1. `@everyone`：Send Messages ❌ deny、Send Messages in Threads ❌ deny（View/History 不动）；
2. 加 3 个成员覆写，各给 Send Messages ✓ + Send Messages in Threads ✓：
   - alerts-dispatcher（1524831623164596265）
   - claw-infra-bot（1524829037825101975）
   - Codex Infra Bot（1523219324561522831）
3. 说明：Annie 自己是 server owner/Administrator，deny 对她无效，无需给自己加覆写。

收紧后回归验证（runner 做）：dispatcher 再发一条探活 200；三身份以外不再可发（结构上由
overwrites 保证，无需借第四个 bot 试 403）。

## R6 · 演练（真告警走全链）机制

**范围（Tadashi 已批）**：只做父单 runbook 步6 的 ①「注入一条工单走全链」；②③④（账号封顶/
全封顶/approve-park 措辞）留观察日/独立 QA。

**链路事实**：工单富化在 **Bridge 进程内**（`packages/teamlead/src/bridge/infra-alert-wiring.ts`
Router，`FLYWHEEL_ALERT_TICKETS=1` 时挂 🎫 头 + 唯一 owner mention；owner 注册表 =
`ticket-owner-map.ts` 读 `FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID` / `FLYWHEEL_INFRA_BOT_USER_ID`）。
入口 = `LeadAlertNotifier.notify()`（Bridge 侧）；shell 路径 `scripts/lead-alert.sh` 直发 Discord
**不过** Router → 不产生工单。Bridge 无 HTTP 注入端点；`alert-queue/` drain 是「已渲染 payload
重试」语义，不是新告警注入口。

**首选注入法（house 配方，FLY-1048/FLY-529 先例）**：module-driven —— 用生产 dist 组一个
最小 node 脚本：`LeadAlertNotifier` + `infra-alert-wiring` Router + 生产 env（真 dispatcher token、
真频道、真 owner ids），发一条 kind 归 claw 的 drill 工单（标题带「演练/可删」）。验证点：

- 🎫 schema 头完整（project + id + kind + first-seen + owner + 状态）；
- @-target 唯一 owner = claw（不 @ Codex、不 @ Annie）；
- claw 被唤醒 → claim → 在频道 ACK；
- 无 founder 升级（默认不 @Annie 铁律）。

**诚实覆盖边界**（QA 报告需明示）：状态 edit 与 20/min 攒批是发起进程内的秩序 —— drill 进程
持有 ticket 状态，生产 Bridge 不接手它的后续 edit；且单条演练本就不触发攒批。这两项由
**观察日的真实工单**验证（LeadWatchdog → 生产 Bridge 全在一个进程里，秩序完整）。若 implement
时发现生产 Bridge 有更直接的注入口（例如内部 event 路由可达 notify），允许换用并在 QA 报告记录
实际路径。演练帖收口后清理。

## R7 · 前置与秩序

- **机器负载**：14:27 刚 OOM 过 —— 每个大步骤前 `uptime` + `vm_stat`（swap）核一眼再动。
- **Bridge**：已于 14:43 重启、健康（/health ok, 58 sessions）；本窗**不需要**再动 Bridge
  （两个 crash 修复都不碰 Bridge 进程）。
- **噪音纪律**：所有探针/演练帖标「(可删)」；探针失败不重试刷屏 —— 修因再发。
- **收尾归属**：观察日清单 = 父单 runbook 步 9（QA/Tadashi 核，不由实施 runner 自报）；
  FLY-925/928 absorbed 关单等收尾条款归父单 FLY-1049，不在本单。

## R8 · 只报不修（Tadashi 已确认，各记 follow-up）

1. codex-infra 的 `alertChannel=1523499324573749249`（自己私有频道）与 C6 §4「应指统一
   Alerts」偏差 —— FLY-871 家族遗留；
2. FLY-513：全局 codex symlink 解析进 `~/.codex-infra-bot`，updater churn 风险。
