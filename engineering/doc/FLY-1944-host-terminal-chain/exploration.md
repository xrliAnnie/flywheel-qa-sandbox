# FLY-1944 宿主终端链收口 — 探索

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-21
基于: 无(本单首篇;上游证据 = issue 正文 + 两条 comments + FLY-1929 存档 `engineering/doc/FLY-1929-kernel-panic-voucher-leak/verification-and-scope.md`)

## 0. 一句话

宿主终端可见性一条链(tmux 二进制 → tmux server → cmux 镜像 → founder 眼睛)上的五个断点,一次设计收口:watcher 无监护、tmux 版本错配、宿主工具链裸奔、Codex TUI 开窗静默放弃、playwright 起可见浏览器。

## 1. 范围(五块,不是三块)

Issue 正文三块 + 两条 comment 追加两块(Tadashi 指引点名必读):

| # | 块 | 来源 | 一句话症状 |
|---|---|---|---|
| W1 | cmux-sync watcher 守护 + 镜像 SLA + fork 优化 | 正文一(原 1944) | watcher 活着但循环死了,4 小时无镜像,无人发现 |
| W2 | tmux 统一升 3.7c | 正文二(原 1950,founder 已放行) | ARM 3.7c client + Intel 3.5a server 错配 → 全舰 "not a terminal" |
| W3 | 宿主工具链护栏(brew) | 正文三(原 1951) | 任何 runner 会话能无声 `brew install` 压掉在用 tmux |
| W4 | Codex TUI 开窗锁竞争收口 | comment 06:17Z | ensure 抢锁超时 → 静默放弃开窗,账面仍 delivered,founder 盲 |
| W5 | playwright-mcp 可见浏览器 | comment 07:23Z(founder 点名) | runner 会话挂 playwright,首次调用弹**有头** Chrome |

## 2. 设计红线(Tadashi 指引,founder 口径)

1. **简单优先** —— 能复用现有机制绝不造新的。
2. **净删除优先** —— 开新路必须同 PR 删老路。
3. **不加新告警层** —— 一切告警走现有 lead-alert.sh / LeadAlertNotifier 管道(新增 alert *kind* 走现有管道 = 允许;新守护 daemon / 新通知通道 = 禁止)。

## 3. 全链视角:为什么这五块是一条链

```
brew (W3 护栏)
  └─ tmux 二进制 (W2 统一 3.7c)
       └─ tmux server(per-Lead 私有 socket ×15 + default runner server)
            ├─ Codex runner 查看窗 (W4 开窗收口)
            └─ cmux-sync watcher (W1 守护) ──镜像──▶ cmux 侧栏 ──▶ founder
runner Claude 会话
  └─ playwright-mcp (W5) ──有头 Chrome──▶ founder 桌面(不该出现)
```

一个隐藏纽带把 W1 和 W2 连起来(FLY-1929 复核实测,本 runner 已当场复证):
**`/usr/local/bin/tmux` 是 x86_64 二进制,整棵 tmux 子树在 Rosetta 下跑**(本 runner shell `sysctl.proc_translated=1`)。watcher 每分钟 ~750 个 fork 出来的 universal 二进制(bash/awk/grep/ps)全按 x86_64 切片翻译执行。W2 的"server 启动路径统一"如果统一到 ARM 二进制,就同时消掉版本错配和 Rosetta 放大器——这是 D②(fork 开销)最大的单一杠杆,比任何 fork 数量优化都大。

## 4. 各块方向与备选

### W1 — watcher 守护 + SLA + fork 优化

**审计结论**(细节见 research.md §1):watcher 是 9837 行 bash 单体,15s tick + 60s additive,**没有任何 stall watchdog**;三大卡死路径:①遗留裸 `cmux-maintenance` marker → 1s 空转永久停车(仓库内无写入方,是运维手工暂停开关,忘删即永久盲);②所有 cmux IPC 无 timeout(Electron 半开 socket = 永久阻塞在每 tick 第一个 ping 上);③173 处 tmux 调用无 timeout。KeepAlive 救不了"活着但不动"。日志是 transition-only 设计静默,mtime 不能当心跳。

**方向(四刀,全部复用现有机制):**

- **D1a 有界化**:cmux IPC(ping/call/read-screen/list-workspaces)与热路径 tmux 调用套仓库已有的 `scripts/lib/bounded-run.sh`(autostart 已在用),超时归入**现有** unhealthy/backoff 路径。永久阻塞 → 既有降级,不新增状态。
- **D1b 显式心跳**:watch_loop tick 顶部 + maintenance park 轮询内,用 bash 内建 `printf > heartbeat`(零 fork)写心跳文件。现有副作用文件(roster-episodes / stale.state)各有失真前提,不够格当唯一判据。
- **D1c 外部守护 = Bridge GatePoller rider**(FLY-1560 确立的现有 rider 模式,零新 timer、零新 daemon):判活式 `launchd job 在 + lease owner 匹配 + (心跳超龄 ∨ events 积压超龄) + 非合法 park` → SIGTERM lease owner pid(launchd KeepAlive 重生)+ 经现有 lead-alert 管道一条 per-episode 告警。park 中(marker 在):**不杀**,park 超 TTL 只告警(marker 是运维意图,自动删它比不删更危险)。kill 目标锚定 lease owner——实测宿主上有两个 `--watch` 进程共存(一个持锁一个 supervised 等待),pgrep 首个匹配会杀错。
- **D1d 镜像 SLA**:健康态 sleep 从整条 15s 改为 event-aware 切片(每 3s 一次纯 `stat` 探 event 文件,零 IPC——复用 unhealthy 态已有的切片睡眠形态)→ hook 事件典型 ≤10s 建镜像;60s additive 保持为兜底。**诚实边界**:hook 丢失场景最坏 ~65s,略破 1 分钟;SLA 验收量 hook 主路径。
- **D1e fork 优化(D② 并入)**:pass 级 workspaces JSON 快照(40 个调用点 → 每 pass 一次)、`get_tmux_agent_windows` 每 pass 4 次 → 1 次、lease owner 解析纯 bash 化(每 tick 18 fork → ~2)。**诚实边界照抄 FLY-1929 存档**:cmux-sync 占全机 churn 22.8%,砍半只降总量 ~11%,panic 已被 voucher-guard 兜住;真正大头是 Rosetta(W2 决策 B)。

**弃选**:
- 独立 watchdog daemon / launchd 周期 job —— 违反"不加新告警层/新机制";FLY-1814 manifest 也要多一行。
- watcher 内自带 SIGALRM 死人开关 —— `kill -STOP` 冻结全进程时自救逻辑一起冻结,只有外部监护能兜 issue 验收的 STOP 场景。
- additive 从 60s 降到 30s 追 SLA —— fork 成本 +100%,与 D1e 打架;event 切片以 5 个 stat/tick 的成本达成更好的典型延迟。

### W2 — tmux 统一 3.7c

**宿主实况**(本 runner 实测):Intel brew 3.5a 已 link(x86_64);ARM brew 3.7c 已装未 link(事故日临时态);Intel 侧 `brew upgrade --dry-run tmux` 确认可升 3.7c(bottle 556KB,连带 6 个依赖);所有 Lead server 以绝对路径 `/usr/local/bin/tmux` 起(wrapper `command -v` 按 PATH 解析的结果)。

**审计结论**:「代码仅一处写死旧路径」字面成立(`decommission-legacy-companion-daemon.sh:42-45`,且旧路径优先),但**真病灶是 8 处 wrapper/plist PATH `/usr/local` 优先**(launchd plist 派已是 homebrew 优先,两派并存);TS 与 rescue 全部裸 `tmux` 靠 PATH。`tmux -V` 从不被 parse,所有 3.5a workaround 是硬编码行为假设。

**方向(两阶段,一个重启窗口):**

- **Phase A(本单承诺范围,founder 已拍)**:两个 brew 都升 3.7c + ARM relink → 任何 PATH 解析都得到 3.7c,版本一致性与 PATH 顺序解耦。一次重启窗口全 tmux server 重生(时机挑在飞清空,founder 拍);cmux 零改动(镜像由 watcher 重建)。`decommission` 脚本硬编码块改 `command -v`(净删除)。
- **Phase B(推荐,同窗口执行,需 founder 加拍)**:server 收编到 ARM 二进制,消 Rosetta。机制 = Intel 侧 `brew unlink tmux`(Cellar 3.7c 留作回滚)+ 兼容 symlink `/usr/local/bin/tmux → /opt/homebrew/bin/tmux`。一处变更让全部 173 个裸调用、wrapper `command -v`、绝对路径引用透明拿到 ARM 3.7c;交互 shell PATH 缺 `/opt/homebrew` 的机器现状也不受影响。回滚 = 删 symlink + relink Intel。
- **弃选:通用 PATH 翻转(8 处 wrapper 改 homebrew 优先)** —— 实测两 prefix 有 **373 个同名二进制**,翻转会改变 git/node/python 等全部工具的 provenance,爆炸半径远超本单。PATH 两派并存的技术债记 follow-up,不在本单动。
- **弃选:只升不统一(保持 x86_64 server)** —— 满足验收但放弃 Rosetta 杠杆;作为 Phase B 被否时的兜底形态,Phase A 本身已完整可 ship。

**兼容门**:3.6 把 hooks 改为 array options 存储、`show-hooks` 输出形态可能变——`register_session_hooks` 的幂等 grep 是最高风险点。以测试为门,不以 changelog 阅读为门:`test-cmux-sync`(570 例,隔离 socket,3.7c 二进制)+ TmuxAdapter 79 例 + hooks integration 脚本 + FLY-1672 window-identity 回归,全绿才进重启窗口。

### W3 — 宿主工具链护栏

**审计结论**:现成范式完整——FLY-913 restart-guard 已证明 `PreToolUse(matcher:"Bash")` 装进 `~/.claude/settings.json` 同时覆盖 Lead + 所有 Claude runner(runner 继承同一 `~/.claude`,零 `CLAUDE_CONFIG_DIR` 注入);判定输出 = JSON `permissionDecision:"deny"` + 恒 exit 0;bypass = 锚定前缀 env + audit 写成功 + strict-delivery 告警双前置。

**方向**:**扩展 `flywheel-restart-guard.py` 加一类 P5(brew mutation)**,不新建 guard 文件。
- 拦截集(mutation):`brew install|reinstall|upgrade|uninstall|remove|rm|link|unlink|pin|unpin|tap|untap|services|update-reset|cleanup`;放行(read-only):`list|info|deps|outdated|--version|--prefix|doctor`。
- **判别信号 = `FLYWHEEL_EXEC_ID`**(hook 进程 env):有 → runner 上下文 → deny(拒绝文案给正路:`flywheel-comm ask` 请 Lead);无 → Lead/founder 会话 → 放行 + audit 一行。
  - **不用 `FLYWHEEL_LEAD_ID`**:本 runner 当场实测 runner pane **继承**了它(TmuxAdapter 只清 `LEAD_ID`)——用它判 Lead 会把 runner 误放行。这同时暴露一个既有归因 bug(runner 的 restart-guard bypass 审计会记成 Lead 名),记 follow-up,不在本单扩伤口。
- bypass 复用现有 `FLYWHEEL_RESTART_GUARD_BYPASS` 机制原样(audit + strict alert 走现有管道)。
- **诚实边界**:hook 只覆盖 Claude 会话面。Codex runner 有 workspace-write 沙箱天然拦 `/usr/local` 写;Codex full-access Lead 本来就是 Lead(白名单侧);agy/kimi runner 无 Claude hook——v1 接受此边界,写明。founder 自己的终端无 hook,天然白名单。

**弃选**:
- 新建独立 brew-guard 脚本 + 第二个 hook 条目 —— 复制一套安装器/测试骨架,违反简单优先。
- runner worktree 局部 hook(SkillInjector 挂载点)—— 机器级已可达且覆盖更全(含非 worktree cwd 的会话),不需要 per-worktree 机制。
- 沙箱级拦截(seatbelt/权限系统)—— Claude runner 跑在 bypassPermissions,无现成沙箱面;造一个 = 大新机制。

### W4 — Codex TUI 开窗收口

**审计结论**(故障链完整还原,见 research.md §4):锁是 per-socket 文件锁,等待方单次 acquire 5–20s(load factor),持有方合法预算 60s(inspect/recover 串行,33.8s 在预算内)→ 并发下等待方必然超时;HEAD 的 ensure 重试是 deadline 驱动(210s 总额,90s 单次 spawn cap)——高负载下 90s cap 吃满,210s 只装得下 2 次 attempt(与"两次尝试超时"逐字吻合,已排除 build 不一致);`create-failed` 后**静默放弃**(只有 `died` 会重试),无 log 无告警无补开;CommDB 在窗口创建**前**写名字型 `tmux_window` 覆盖 `:pending` 哨兵,绕过全部下游 pending 兜底;`delivered` 由 setGoal 驱动与开窗解耦(设计意图,fail-open:窗口失败只损可见性不损 run)。

**方向(四刀):**
- **D4a 后台重试梯子**:`create-failed`(含 hold_lock_unavailable 证据)改为可重试——复用现有 `scheduleReopen` 机制,退避 5s/15s/60s/5min/15min,总窗 ~30min,每次尝试一行 log;耗尽才终局。删掉静默 fallthrough(净删除)。锁竞争是瞬时态,与 `tmux-absent`(永久)语义分开。
- **D4b 登记时序归位**:删掉创建前的名字型 CommDB 写入(`CodexTmuxAdapter.ts:463`),保持 Bridge 预登记的 `:pending` 直到 `wireCreated` 拿到真实 `@id` 一次写入。下游 `started-evidence` / `generalized-launch-recovery` 的 `:pending` 兜底对 codex runner 恢复生效 = **账面诚实即可见标记**。前置验证项:确认无 send 路径消费创建前的名字型 target(codex send 走 mailbox,不打 tmux 键)。
- **D4c 失败上浮**:梯子耗尽 → 复用现有 `tui_window_lost` alert kind + `tui-window-alert.ts` episode-latch(现只在 Lead 侧 opt-in),接到 runner 开窗路径。走现有管道,非新层。
- **D4d 预算匹配**:常量不动;梯子本身把"210s 耗尽即永久放弃"改成"30min 内持续补开",即验收③的实质。文档化 90s attemptCap 高负载下只容 2 attempts 的事实。

**弃选**:调大 210s deadline / 调小 90s cap —— 治标;真问题是"耗尽后永久放弃",梯子治本且不动被 FLY-1483 系测试钉住的常量。

### W5 — playwright 可见浏览器

**审计结论(最重要)**:**FLY-1867 (PR #904) 已把机制全部造好,但这台宿主的 cutover 从未执行**——`~/.claude/settings.json` 里 playwright 插件仍 `true`、`PLAYWRIGHT_MCP_HEADLESS` 缺失、receipt 不存在。且上游 0.0.79 的 Chrome 本来就是 first-tool lazy;真实浪费是 19 个空挂 node MCP server;可见窗口来自首次工具调用时的**有头** persistent context。

**方向**:**零新代码,执行既有 cutover** —— `bash scripts/setup-mcp-on-demand.sh apply ~/.claude/settings.json`(machine default-off + `PLAYWRIGHT_MCP_HEADLESS=true`,脚本自带 receipt/rollback/flock/原子写)。效果:普通 runner → 无 playwright server(验收①③);QA runner → 结构性 opt-in 保留但 headless,首调起无头 Chrome(验收②);退出回收 P0 已 ship(验收④)。前置:`FLYWHEEL_RUNNER_SLIM_MCP` 未设或 ≠0(kill-switch 缺口会连 QA 一起关)。
**follow-up 记录**:`@playwright/mcp@latest` 未钉版本(上游一变 headless env 名/ppid 安全垫需重验)。

## 5. 交付切分(供 plan 细化)

一个 PR 可能过大;初步切分:PR-1 = W1(watcher,纯 shell + Bridge rider)/ PR-2 = W4(TS,Codex adapter)/ PR-3 = W3(guard py + 测试)/ W2 与 W5 主体是**运维动作**(brew/cutover/重启窗口),代码改动极小(decommission 一处 + runbook),搭 PR-1 或独立小 PR;重启窗口本身 founder-gated。

## 6. 开放问题(带到 design review / founder)

1. W2 Phase B(ARM repoint)是否与 Phase A 同窗口执行?(推荐同窗口:一次重启,回滚路径清晰)
2. W1 watchdog 心跳超龄阈值(建议 5 min)与 park TTL 告警阈值(建议 30 min)。
3. W4 重试梯子总窗(建议 30min)——超过后该 runner 的窗口交给谁?(建议:alert 后人工 `--once` 补开,不无限重试)
