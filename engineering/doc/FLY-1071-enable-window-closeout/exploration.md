# FLY-1071 enable 窗收尾执行 — 探索
Issue: FLY-1071 (https://linear.app/geoforge3d/issue/FLY-1071/ops-fly-1049-enable-窗收尾执行-双-bot-探针-send-收紧-演练oom-后替身执行单)
日期: 2026-07-09
基于: 无（上游 = 父单文档 `engineering/doc/FLY-1049-fly915-alerts-closeout/`，尤其 `enable-window-runbook.md`）

## 1. 任务定位

父单 FLY-1049 的 enable 窗执行 runner（b71d73fb）在 14:27 OOM 事故阵亡，本单为**替身执行单，纯 ops 不写产品代码**。窗的目标：把 FLY-915 pipeline（925 standup / 927 工单队列 / 928 两 infra bot / 929 self-heal + 通知迁移）真跑起来。前任已完成 env 落机、bot 授权入 server、频道创建、launchd 安装、Bridge 重启 —— 剩 4 件事：

1. 诊断修复 W4（codex-infra）/ W5（claude-infra）两个 crash-loop → verify-windowed-lead 双 bot 逐层验证；
2. 三条入站探针（@claw 真收到 / 无 mention 不醒 / @Codex 不串）；
3. 整理 Annie 的 #flywheel-alerts Send 收紧精确步骤（一次打扰，交 Tadashi 转达）；
4. 演练（真告警走全链）→ 报 Tadashi 收口 → 观察日开始。

本 design 阶段对生产**零改动**（只读探查 + tmux capture-pane 取证）。

## 2. 现场审计 — 已验证事实（2026-07-09 14:40–15:05）

### 2.1 前任遗产核对（全部就位，不用重做）

- **env**：15 个键全在 `~/.flywheel/.env`（10 新 + 5 既有）。非敏感值核对无误：
  `FLYWHEEL_ALERT_ROUTING=1`、`FLYWHEEL_ALERT_TICKETS=1`、`FLYWHEEL_ALERT_RATE_PER_MIN=20`、
  `FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`、
  `FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`、
  `FLYWHEEL_CHECKPOINT_WATCHDOG=1`、`FLYWHEEL_ACCOUNT_SELF_HEAL=1`、
  `FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472`、`FLYWHEEL_NOTIFY_DIGEST_EXPECT=1`、
  `FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID=1524829037825101975`。
- **projects.json** 两条目在：
  - `claude-infra-bot-lead`：chat=1524885436848410705（#claude-infra-bot ✓）、alert=1518793447165661254（统一 Alerts ✓）、model sonnet / effort high、无 backend 字段（= claude-code 默认）。
  - `codex-infra-bot-lead`：chat=**alert**=1523499324573749249（自己的私有频道）。与 C6 §4「alertChannel 应指统一 Alerts」有偏差（此前 task 曾 repoint 到 unified，现值又回私有频道）→ 待与 Tadashi 确认是有意（W4 自身 watchdog 告警进私有频道调试）还是回退遗留。**不 block 本窗**。
- **W5 入站合同**（access.json）✓：chat 频道 `requireMention:false`；Alerts 频道 `requireMention:true`；顶层 allowBots 含 dispatcher（1524831623164596265）+ codex-infra bot（1523219324561522831）。
- **W5 launch env** ✓：plist → `~/.flywheel/env-claude-infra-bot.env`，其中 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=1518793447165661254`（per-lead 文件正确覆盖共享 .env 里指向 roundtable 的同名键）。
- Bridge 在跑（14:43 重启，58 sessions）；claw 对三频道读探 200（父单已证）。

### 2.2 W5（claude-infra-bot-lead）crash-loop 根因 — **已钉死**

**症状**：Claude CLI 启动 4–9s 即 exit 1，观察时已连崩 16 轮（60s/轮），还在持续。

**证据链**（tmux capture-pane 抓到两类死亡画面）：

1. **fresh-start 轮**：pane 死前输出 = Claude CLI 的「可用 agent 列表」报错，列表里**没有 claude-infra-bot-lead**（`--agent claude-infra-bot-lead` 未知 → 打印可用列表 → exit 1）。
2. **resume 轮**：`No conversation found with session ID: <uuid>`（fresh 轮崩得太早、会话从未落盘，衍生症状）。

**根因**：`.lead/claude-infra-bot-lead/identity.md` **缺 YAML frontmatter**。claude-lead.sh 的 agent 安装是裸 `cp`（`claude-lead.sh:592-594`），frontmatter 必须由源文件自带；Claude Code 对没有 frontmatter 的 agent 文件不注册。对照：

- `.lead/flywheel-eng-lead/identity.md`（Claude 后端，正常）：有完整 frontmatter（name/description/model/permissionMode/disallowedTools）；
- `~/.claude/agents/belle-lead.md`（Claude 后端，正常）：同样有 frontmatter；
- `.lead/codex-infra-bot-lead/identity.md`（Codex 后端）：**无 frontmatter — 但 Codex 后端不经 `--agent` 注册**（persona 走 TUI runtime 的 baseInstructions 注入），所以没事。

claw 的 identity.md 是照 codex-infra 的格式写的（两文件开头结构逐字同型），**格式被误移植到了 Claude 后端** —— 这就是根因。

**已排除的候选**：
- dev-channels 交互确认框（`--dangerously-load-development-channels`）：claude-lead.sh 已有 FLY-109 dialog poller 自动 capture-pane + 发 Enter（`claude-lead.sh:972-1028`），非 blocker（resume 轮画面里短暂出现过，属正常流程）。
- 14:17–14:27 restart #2 曾跑 620s 的反例：该时段机器正滑向 14:27 OOM（swap 打满），supervisor 的 pane 死亡检测被系统性延迟拖住的可能性最大；不影响上述根因判定，修复后观察即可。

### 2.3 W4（codex-infra-bot-lead）crash-loop 根因 — **已钉死**

**症状**：wrapper 每 ~80s 重启一轮（日志里 56 次 start），最后一步 `remote-control start failed` → exit 1 → launchd KeepAlive 拉起。

**证据链**（`/tmp/flywheel-lead-flywheel-codex-infra-bot-lead.log` + `~/.codex-infra-bot/app-server-daemon/app-server.stderr.log`）：

- app-server 反复报 401：`refresh_token_reused`（「refresh token 已被用于生成新 access token，请重新登录」）+ `token_expired`；
- 随后 `failed to connect to ~/.codex-infra-bot/app-server-control/app-server-control.sock (No such file or directory)` → remote-control 起不来 → wrapper 退出。

**根因**：隔离 home `~/.codex-infra-bot` 的 auth 失效。auth.json 归属账号 = **xrliannie.b@gmail.com**（= codex-profile 轮转池里的 business profile）。`refresh_token_reused` 的教科书成因是**同一 refresh token 被两处持有**：infra home 的 auth.json 疑似从池里拷贝而来，池侧（或另一进程）后续 refresh 轮换掉 token，拷贝副本随即失效。→ 治本 = 在隔离 home 里做一次 **fresh login**（同账号新 OAuth session，与池互不干扰），而不是再拷一份。

**次生隐患（FLY-513，wrapper 每次启动都在 WARN）**：全局 `~/.local/bin/codex` symlink 解析进 `~/.codex-infra-bot/packages/standalone/releases/...` —— standalone updater / Lead flip 会 churn 它，瞬断全 runner 的 codex review gate。wrapper 给出修复指引（`ln -sfn` 回中性 pinned 路径）。**独立雷，不属本窗必做**，列为建议项交 Tadashi 拍。

### 2.4 Send 收紧影响面排查 — **不误伤**

疑虑：lead-alert.sh 的「发」走 projects.json 的 alertChannel —— 若其他 Lead 也指向统一 Alerts，收紧 Send 会 403 打断它们。实测全 fleet 16 个 lead 条目：**只有 claude-infra-bot-lead 的 alertChannel = 1518793447165661254（统一 Alerts）**，其余各有专属频道或未设。Bridge 侧工单/auto-repair 发送经 env 已指向 dispatcher token。→ 收紧后需要保留 Send 的身份恰好 = **dispatcher + claw + codex-infra 三个 bot**（与 FLY-1049 runbook 步 1b 一致），无额外受害者。

### 2.5 verify-windowed-lead.sh 适配性

脚本在（`packages/teamlead/scripts/verify-windowed-lead.sh`），5 层只读探针：① launchd job running → ② pid 是 TUI runtime → ③ daemon socket → ④ tmux window 活 → ⑤ pane 跑 codex。**为 Codex TUI Lead 而写**；W4 直接跑，W5（Claude 后端，claude-lead.sh supervisor + tmux，无 daemon socket）需逐层等效（research 阶段给出映射表）。

## 3. 方案选项

### W5 修复路径

- **A（推荐）**：`.lead/claude-infra-bot-lead/identity.md` 加 frontmatter（本分支 commit，随本单 PR merge → 生产 git pull 生效）+ **窗内先手补安装副本** `~/.claude/agents/claude-infra-bot-lead.md`（机器状态非 repo，立刻止血）。快 + durable 双保险。手补被覆盖的窗口 = wrapper 进程重启时（supervisor 稳定后不重启，风险可控）。
- B：只手补安装副本不改 repo → wrapper 重启即回归。不 durable，否。
- C：改 claude-lead.sh 让安装时自动生成 frontmatter → 写产品代码，超出「纯 ops 不写码」scope 且需完整 review。否（可提 follow-up）。

### W4 修复路径

- **A（推荐）**：`CODEX_HOME=~/.codex-infra-bot` 下 fresh codex login（沿用 xrliannie.b 业务号，新 OAuth session 与池并存互不失效）。**绝不**动 codex-profile 池的轮转（memory 红线），登录产物**不**拷回池。OAuth 若 Chrome 自动化（codex-relogin 流程）走不完需 Annie 点一次 —— 与 Send 收紧合并成**同一次打扰**。
- B：从池再拷一份 auth.json → 复发 refresh_token_reused。治标，否。
- C：为 infra bot 开独立新 ChatGPT 账号 → 需 Annie 开号，超出本窗必要性。否（可提 follow-up）。

## 4. 范围裁定（需 Lead 确认的点）

1. **演练范围**：FLY-1049 runbook 步 6 有 ①注入工单全链 ②模拟账号封顶 ③全封顶交叉 ④approve-park 措辞 四项；FLY-1071 文本只写「演练（真告警走全链）」。取 **① 为本窗必做**；②③④ 涉及 Claude 账号切换（FLY-696 红线，需 Annie 在场级谨慎），建议留给观察日 / 独立 QA 阶段。
2. **frontmatter 具体字段**：name/description 必填；倾向 `model: sonnet`（与 projects.json 对齐）+ `permissionMode: bypassPermissions`（无人值守必需，belle/eng-lead 同款）+ `disallowedTools: Agent`（belle 同款；claw 需要 Bash 跑救援 CLI，不能照抄 eng-lead 的禁 Write 集）。
3. **W4 alertChannel 偏差**（§2.2）与 **FLY-513 symlink**（§2.3）：只上报，不默认修。
4. FLY-913 护栏若拦 launchctl 类操作：按先例文件递交安装/操作脚本给 Tadashi。

## 5. 边界与风险

- **三段式**：本单 Implement phase 执行 ops；QA phase 独立验证（不由部署者自证 — memory 红线）；观察日清单（runbook 步 9）归 QA/Tadashi。
- **噪音控制**：探针/演练帖标注「(可删)」，演练收口后清理；探针只发统一 Alerts 频道。
- **机器负载**：14:27 刚 OOM 过，实施前查 load/swap 再动（两个 bot session 增量可控）。
- **回滚**：全链 byte-compat —— 移除新 env + 重启 Bridge = 逐字回现状；launchd job 可 bootout（父单 runbook 收口条款照抄适用）。
