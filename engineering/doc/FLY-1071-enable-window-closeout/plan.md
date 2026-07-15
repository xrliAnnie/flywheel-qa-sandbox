# FLY-1071 enable 窗收尾执行 — 实施计划
Issue: FLY-1071 (https://linear.app/geoforge3d/issue/FLY-1071/ops-fly-1049-enable-窗收尾执行-双-bot-探针-send-收紧-演练oom-后替身执行单)
日期: 2026-07-09
基于: research.md（同文件夹；exploration.md 的方案经 brainstorm gate 四点全批）

> **For agentic workers（三段式 Implement phase runner）**：本计划是**纯 ops 执行单**，
> 不写产品代码；唯一 repo 改动 = Task 1 的 persona frontmatter（配置）。按 Task 顺序逐步执行、
> 逐步留证据；证据统一落 `engineering/doc/FLY-1071-enable-window-closeout/evidence/`（随分支 commit）。
> 步骤用 checkbox 跟踪，每完成一个 Task 更新 progress.md（flywheel-comm progress）。

**Goal**：修复 W4/W5 两个 infra bot crash-loop → 双 bot 逐层验证 → 三条入站探针 →
Send 收紧步骤交 Tadashi → 注入演练走全链 → 报 Tadashi 收口、观察日开始。

**Approach**：两个已钉死的根因各走最小修复（W5 = persona frontmatter 双落点；W4 = 隔离 home
fresh login）；验证全部只读探针 + 真 Discord 消息证据；演练复用 FLY-529 的 plugin.ts 逐字组合脚本。

**不做**（Tadashi 已批边界）：runbook 步6 ②③④（账号封顶/全封顶/approve-park）；
codex-infra alertChannel 偏差；FLY-513 symlink —— 后两者只上报（Tadashi 各记 follow-up）。

---

## 全局纪律

- **FLY-913 护栏**：任何 `launchctl` 被拦 → 把该步骤写成脚本文件，经 flywheel-comm ask 递交
  Tadashi 执行（先例已走通），等结果再继续（用 check 轮询，不空转）。
- **打扰预算**：Annie 只打扰一次 —— Task 5 的 Send 收紧；若 Task 2 的 OAuth 自动化走不完，
  把 OAuth 请求并进同一条转达（Tadashi 已批）。
- **噪音纪律**：所有探针/演练帖标「(可删)」；失败不重试刷屏，修因再发。
- **负载预检**：每个大 Task 前跑 `uptime`；load1 > 逻辑核数 或 `vm_stat` 显示 swap 持续增长
  → 暂停 10min 再查（14:27 刚 OOM 过）。
- 消息里不用反引号（zsh 会当命令替换吞 token）—— 标 code 用「」。

---

## Task 0 · 前置核对（只读）

- [ ] 0.1 分支/工作区：`git -C /Users/xiaorongli/Dev/flywheel-FLY-1071 branch --show-current`
      → 期望 `flywheel-FLY-1071`；`git status` 干净（除本单 docs）。
- [ ] 0.2 负载：`uptime && vm_stat | head -8 && sysctl -n hw.logicalcpu` →
      「load1 > 逻辑核数」的门有了机械判据，正常再动。
- [ ] 0.3 Bridge：`curl -s --max-time 2 http://localhost:9876/health` → `"ok":true`。
- [ ] 0.4 现场快照（证据基线；用 per-job print —— `launchctl list | grep` 在部分 shell 下
      会空结果，弱证据）：

```bash
EV=/Users/xiaorongli/Dev/flywheel-FLY-1071/engineering/doc/FLY-1071-enable-window-closeout/evidence
mkdir -p "$EV"
launchctl print gui/$UID/com.flywheel.lead.flywheel-claude-infra-bot-lead > "$EV/task0-w5-launchd-before.txt" 2>&1 || true
launchctl print gui/$UID/com.flywheel.lead.flywheel-codex-infra-bot-lead > "$EV/task0-w4-launchd-before.txt" 2>&1 || true
tail -20 /tmp/flywheel-lead-flywheel-claude-infra-bot-lead.log > "$EV/task0-w5-log-before.txt"
tail -20 /tmp/flywheel-lead-flywheel-codex-infra-bot-lead.log > "$EV/task0-w4-log-before.txt"
```

- [ ] 0.5 `node <flywheel-comm> stage set implement`（进入执行）。

## Task 1 · 修 W5（claude-infra-bot-lead）— persona frontmatter

**Files**：Modify `.lead/claude-infra-bot-lead/identity.md`（本 worktree）；
手补 `~/.claude/agents/claude-infra-bot-lead.md`（机器状态）。

- [ ] 1.1 在 worktree 的 `.lead/claude-infra-bot-lead/identity.md` **文件最顶部**插入
      frontmatter（正文一字不动）：

```yaml
---
name: claude-infra-bot-lead
description: Claude Infra Bot (claw) — Flywheel 基础设施自愈 Bot。#flywheel-alerts 工单默认主力 owner:救 Codex 侧账号/auth、救 runner 卡死、发 #flywheel-notify 例行通知。低频、精准、不开 Runner、不碰产品代码。
model: sonnet
permissionMode: bypassPermissions
disallowedTools: Agent
---
```

      合同要点：`name:` 必须逐字 = `claude-infra-bot-lead`（claude-lead.sh:1613 以
      --agent "$LEAD_ID" 启动）。
- [ ] 1.2 手补安装副本（立即止血，wrapper 不必重启）：

```bash
cp /Users/xiaorongli/Dev/flywheel-FLY-1071/.lead/claude-infra-bot-lead/identity.md \
   ~/.claude/agents/claude-infra-bot-lead.md
head -8 ~/.claude/agents/claude-infra-bot-lead.md   # 确认 frontmatter 在
```

- [ ] 1.3 观察 supervisor 自愈（60s 循环，无需任何重启）：

```bash
tail -f /tmp/flywheel-lead-flywheel-claude-infra-bot-lead.log
```

      期望：下一轮 restart 后 **不再出现** crash 行；pane 进入常驻 TUI。≥10min 无新 crash 才算过。
      若仍崩：抓 pane（tmux capture-pane -pt flywheel:<win>）看新报错 —— 若是 dev-channels
      确认框卡住（dialog poller 未及时 Enter），手动向该 window 发一次 Enter；其他新报错 = 停下，
      按 R1 重新诊断，勿盲试。
- [ ] 1.4 证据：恢复后的 log 片段 + 一张 pane capture（claude TUI 空闲态）→
      `$EV/task1-w5-recovered-{log,pane}.txt`；crash count 停增的对照行。
- [ ] 1.5 Commit（只这一个文件 + 证据）：

```bash
git add .lead/claude-infra-bot-lead/identity.md engineering/doc/FLY-1071-enable-window-closeout/evidence/
git commit -m "fix(lead): add agent frontmatter to claude-infra-bot-lead identity (FLY-1071 W5 crash-loop root cause)"
```

## Task 2 · 修 W4（codex-infra-bot-lead）— 隔离 home fresh login

**顺序固定**（避免 KeepAlive 与 login 竞争写 `~/.codex-infra-bot`）：

- [ ] 2.1 停 job：`launchctl bootout gui/$UID/com.flywheel.lead.flywheel-codex-infra-bot-lead`
      （FLY-913 拦 → 走「全局纪律」的文件递交支线：把 2.1/2.4 两条 launchctl 写成
      `$EV/task2-w4-launchctl-handoff.sh` 交 Tadashi）。
- [ ] 2.2 清孤儿进程：`pgrep -fl codex | grep codex-infra-bot` → 若有该 home 名下的
      app-server / remote-control 残留进程，逐个 kill；再 `pgrep` 确认清零。
- [ ] 2.3 fresh login（新 OAuth session，账号 xrliannie.b@gmail.com）：

```bash
CODEX_HOME=~/.codex-infra-bot codex login
```

      首选 codex-relogin 流程的 Chrome 自动化驱动 OAuth；走不完 → **不阻塞**：把 OAuth 请求
      并进 Task 5 的转达（同一次打扰），先跳去做 Task 4 里不依赖 W4 的探针 ①②。
      **纪律**：不动 codex-profile 池；该 home 的 auth.json 不拷回池、池的不拷进来。
- [ ] 2.4 验证 + 拉起：

```bash
CODEX_HOME=~/.codex-infra-bot codex login status        # 期望:已登录
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.flywheel.lead.flywheel-codex-infra-bot-lead.plist
```

- [ ] 2.5 观察一轮起满（≤2min）：log 出现 config gate PASSED 且**无** 401/refresh 报错；
      `ls ~/.codex-infra-bot/app-server-control/app-server-control.sock` 存在；
      wrapper 不再 ~80s 重启（10min 观察 `grep -c "Starting Codex InfraBot" <log>` 不增）。
- [ ] 2.6 证据：`$EV/task2-w4-recovered-log.txt`（gate PASSED + 无 401 的片段）+ sock ls 输出。

## Task 3 · 双 bot 逐层验证（C6 §5.5 证据门）

- [ ] 3.1 W4 直接跑：

```bash
/Users/xiaorongli/Dev/flywheel/packages/teamlead/scripts/verify-windowed-lead.sh \
  flywheel codex-infra-bot-lead | tee "$EV/task3-w4-verify.txt"
```

      期望：layer 1-5 全 PASS，exit 0；另 cmux 目视 tab 存在（截屏或文字记录）。
- [ ] 3.2 W5 逐层等效（research R3 映射表，全只读）：

```bash
{
  launchctl print gui/$UID/com.flywheel.lead.flywheel-claude-infra-bot-lead | grep -E "pid|state"
  tmux list-windows -t flywheel -F '#{window_name} #{pane_dead}' | grep claude-infra-bot-lead
  WIN=$(tmux list-windows -t flywheel -F '#{window_id} #{window_name}' | grep claude-infra-bot-lead | awk '{print $1}')
  tmux display -pt "flywheel:$WIN" '#{pane_current_command}'
  tail -5 /tmp/flywheel-lead-flywheel-claude-infra-bot-lead.log
} | tee "$EV/task3-w5-verify.txt"
```

      判据：① 有活 pid ② window 存在且 pane_dead=0 ③ pane_current_command = node/claude
      （非 bash/zsh 裸壳）④ log 末尾无新 crash 行。
- [ ] 3.3 双 bot Discord 在线目视（cmux tab + #claude-infra-bot / #codex-infra-bot 里 bot
      头像 online）→ 记录进 `$EV/task3-online-visual.md`。

## Task 4 · 三条入站探针

发帖统一用 dispatcher token（source ~/.flywheel/.env 后取
FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN）。频道 = 1518793447165661254（#flywheel-alerts）。
每条探针记录：message id、发帖时间、观察窗内的 pane capture。
**token 纪律**：Authorization 头一律走 `curl -K -`（stdin config，仓库 lead-alert.sh 同款
加固模式）—— **绝不**放进 argv；证据文件只留 message id/content，token 不落盘。

- [ ] 4.1 探针 ①（正向 @claw）：

```bash
source ~/.flywheel/.env
BODY='{"content":"🎫 [FLY-1071 探针① 可删] <@1524829037825101975> 工单测试:请 ACK 本帖"}'
curl -sf -X POST "https://discord.com/api/v10/channels/1518793447165661254/messages" \
  -H "Content-Type: application/json" -d "$BODY" -K - <<CURLCFG | tee "$EV/task4-probe1-post.json"
header = "Authorization: Bot ${FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN}"
CURLCFG
```

      判据：≤120s 内 W5 pane 出现该 inbound（tmux capture 存 `$EV/task4-probe1-pane.txt`）
      且 claw 在频道回了 ACK。
- [ ] 4.2 探针 ②（负向,无 mention）：同 4.1 的加固 curl 模式（-K - stdin）,content =
      `🎫 [FLY-1071 探针② 可删] 无点名工单,任何 bot 都不应响应` →
      观察 ≥120s：W5 pane **无**处理痕迹（capture 存档）,频道无 bot 回复。
- [ ] 4.3 探针 ③（负向,@Codex）：同 4.1 的加固 curl 模式,content 带 `<@1523219324561522831>` →
      判据：W5 pane 无处理；W4 pane 出现 inbound（顺带正向证 W4,capture 存档）。
      （若 Task 2 尚未完成,W4 侧判据顺延到 W4 恢复后补跑一次 ③。）
- [ ] 4.4 三条全过 → `node <flywheel-comm> progress ... --set-chunk probes=done`;
      任何一条不过 → 停,回 access.json/mention-gate 诊断（对照 exploration §2.1 已核状态）,
      修因后只重发失败的那条。

## Task 5 · Send 收紧步骤交付（一次打扰）

- [ ] 5.1 用 research R5 的三步整理成给 Annie 的操作卡（中文、无术语、频道名+三个 bot 名 + 逐点
      点击路径）,存 `$EV/task5-send-tighten-card.md`。
- [ ] 5.2 若 Task 2 需要 Annie OAuth：卡里加第二段（Codex Infra Bot 重新登录,浏览器点一次授权）。
- [ ] 5.3 经 flywheel-comm ask 递交 Tadashi 转达（**不直接找 Annie**,founder 打扰由 Lead 出面）。
      **两个模板按真实状态二选一,严禁虚报探针进度**（Codex R1 #1）:
      - **正常路径**（Task 2 完成且探针③已过）:
        「FLY-1071 Send 收紧操作卡已备好:<卡路径>,请转达 Annie;探针三条已过(证据在 doc evidence/)」
      - **OAuth-pending 路径**（W4 登录需 Annie）:
        「FLY-1071 Send 收紧操作卡已备好:<卡路径>,同卡含 Codex Infra Bot 重登录授权(浏览器点一次);
        探针①②已过,③待 W4 登录后补跑;授权到位后我补跑③再进演练收尾」
- [ ] 5.4 Annie 完成收紧后（经 Tadashi 回话或观察频道权限变化）→ 回归验证:dispatcher 再发一条
      探活（同 4.1 格式,标「收紧后回归 可删」）→ 200 + claw 正常收 → `$EV/task5-post-tighten-probe.txt`。
      若 Annie 未在本窗完成 → 该回归项移交观察日清单,不阻塞 Task 6。

## Task 6 · 注入演练（真告警走全链,只做 runbook 步6 ①）

**前置**：演练不作为最终验收,直到 Task 2（W4 fresh login）与探针③都已过。

- [ ] 6.1 以 `scripts/lib/qa-fly-529-fire-bridge-alert.mjs` 为模板建演练脚本
      `$EV/task6-drill-fire.mjs`（不进 scripts/,不算产品代码）:同款组合
      （StateStore.create(":memory:") + createClaims* + LeadAlertNotifier + unifiedAlert）,
      **外包一层** `buildInfraAlertRouting`（packages/teamlead/dist/bridge/infra-alert-wiring.js,
      rawSink = notifier）。
      **sender 不变量（Codex R1 #2）**:脚本 env 必须 source 生产 `~/.flywheel/.env` 并显式
      确认/打印两个指针（root sender 由 **SENDER** 那个 env 决定,不是 REPAIR）:
      - `FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`
      - `FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`
      **payload 合同（Codex R1 #3,provider 由 leadId 的 backend 派生,kind 本身不够）**:
      - `projectName: "flywheel"`、`leadId: "codex-infra-bot-lead"`（codex 后端 → provider=codex）
      - `eventType: "login_expired"`（ACCOUNT_AUTH_KINDS 内的账号/auth 类）
      - **无 sessionKey**;标题带「FLY-1071 演练 可删」
      **preflight 门**:先核 dist 导出
      （`node -e "import('<dist>/bridge/infra-alert-wiring.js').then(m=>console.log(Object.keys(m)))"`）,
      再让脚本**先打印 rendered content、不满足「恰好一个 owner mention 且 = claw」就拒绝 POST**。
- [ ] 6.2 运行演练,验证五点并留证:
      ① 🎫 schema 头完整（project+id+kind+first-seen+owner+状态）;
      ② **root 帖作者 = dispatcher bot**（sender≠owner 不变量,Codex R1 #2）;
      ③ @-target 唯一 = <@1524829037825101975>（无 @Codex,无 @Annie）;
      ④ claw 被唤醒 → claim → 频道 ACK（pane capture + 消息链接）;
      ⑤ 全程无 founder 升级。
      → `$EV/task6-drill-{post.json,pane.txt,notes.md}`。
- [ ] 6.3 **硬证据边界写进证据文件（Codex R1 #4,逐条列覆盖/不覆盖）**:
      - 覆盖:root 帖 POST、🎫 工单头、owner-only allowed_mentions、dispatcher sender、
        claw 唤醒/ACK、共享 claims.db 去重行为。
      - **不覆盖**:AlertChannelHub 的 thread 生命周期、root 状态 edit、T2 升级、
        rate-limiter 攒批/溢出汇总（生产由 plugin.ts 注入 createAlertRateLimiter,独立脚本
        不自建）、生产 Bridge 进程内秩序 —— 全部**推迟到观察日真实工单取证**,不做结论性断言。
- [ ] 6.4 清理:删除演练帖与探针帖（或标 resolved 保留 24h 由观察日清理,二选一,记录选择）。

## Task 7 · 收口

- [ ] 7.1 `node <flywheel-comm> progress ... --phase implement --cursor 7/7 --next "报 Tadashi 收口"`;
      commit 全部 evidence。
- [ ] 7.2 报 Tadashi（ask --report,DONE 格式）:双 bot 修复根因一句话 + 探针 3/3 + Send 收紧卡
      已转达状态 + 演练五点结果 + 两个只报不修项 + 观察日清单指针（父单 runbook 步 9）。
- [ ] 7.3 走标准 PR/review/approve 流程（Runner baseline 规则,分支已含 identity.md 修复 + 全部
      docs/evidence）。观察日属 QA phase/Tadashi,本 runner 不自报观察结论。

---

## 回滚

- W5:revert identity.md commit + 删手补文件 → 回 crash-loop 现状（无更坏面）。
- W4:home 内 auth 失效回原状即 crash-loop 现状;job 可 launchctl bootout 摘除（C6 §5.6:
  bootout 不跨 login 持久）。
- 频道权限:Annie 撤三个覆写、恢复 @everyone Send 即回原状。
- 全链 byte-compat 总回滚（父单条款）:移除新 env + 重启 Bridge = 逐字回现状。

## 验收标准（对应 issue 待执行 1-4）

1. W4 `verify-windowed-lead` 5/5 PASS;W5 等效 4 判据全过;双 bot ≥10min 稳定无 crash。
2. 探针 ①②③ 判据全过,证据(message id + pane capture)在 evidence/。
3. Send 收紧操作卡已经 Tadashi 转达 Annie(收紧本身完成与否不阻塞验收,未完成则入观察日)。
4. 演练五点全过（含 root 帖作者=dispatcher）+ 硬证据边界逐条记录;演练只在 W4 修复 +
   探针③过后才算收尾;Tadashi 收到 DONE 报告;观察日开始(移交 QA/Tadashi)。
