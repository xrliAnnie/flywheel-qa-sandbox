# FLY-1663 拆除 Lead lifecycle 层，回归 launchd 原生 — 调研

Issue: FLY-1663 (https://linear.app/geoforge3d/issue/FLY-1663/拆除-lead-lifecycle-层回归-launchd-原生根治非补丁)
日期: 2026-08-08
基于: exploration.md

> 本文 = 现状取证 + 本地 spike 实测。四路并行代码审计（lifecycle 层 / launchd 现状 / cmux 可见性 / rescue+批E）+ 一组隔离 socket 上的 tmux 行为实验。所有结论均给出文件路径或实测输出。

## 1. 对 issue 两个前提假设的更正（先说结论）

**更正 1：per-Lead launchd job 不是要新建的东西——它已经是生产形态。**
17 个 `com.flywheel.lead.<project>-<leadId>.plist` 已存在于 `~/Library/LaunchAgents/`（`KeepAlive=true`、`ThrottleInterval=30`、`RunAtLoad=true`），由 `scripts/flywheel-daemon.sh:231 generate_plist_to()` 生成，FLY-247 建好了 config→manifest→plist→wrapper 全套机器。**真正的现状是三层**：

```
launchd job（已存在）→ claude-lead.sh supervisor（4494 行，病灶）→ Lead 本体（claude CLI，从没病过）
```

本单的活 = **抽掉中间那层**，让 launchd 直接管到 Lead 本体，不是引入 launchd。

**更正 2：Bridge 此刻就在 launchd 下，"孤儿直跑"是事故窗口的历史形态。**
实测（launchctl print）：`com.flywheel.bridge` state=running、KeepAlive=true、ppid 1、由 `scripts/flywheel-bridge-wrapper.sh` 拉起（plist 今日 15:53 重写过，`.bak-batchA` 为证）。FLY-1651/1661 两次事故时它确实脱管（plist 在盘上但未 bootstrap、restart-services.sh 以子进程 nohup 拉起）。**真实 gap 是两个口子**：
- `scripts/restart-services.sh:1178-1202 start_bridge()` 仍带 legacy `nohup npx tsx run-bridge.ts` fallback（TODO 注释都写着要删）——plist 没加载时静默产出孤儿 Bridge；
- Bridge plist 没有 install 脚本（Lead 有 `flywheel-daemon.sh install`，Bridge 只有 docs 里的手工 `cp` + `launchctl load`）——所以会漂移。

## 2. 现状五层机制地图（拆除对象清单）

### 2.1 supervisor（claude-lead.sh，4494 行）

- 调用链：launchd plist → `~/.flywheel/bin/flywheel-lead-wrapper.sh <manifest>`（238 行：PID 单实例守卫 `:129`、restart-storm-gate 刹车 `:148`）→ `exec packages/teamlead/scripts/claude-lead.sh`。
- Layer 1 预备（`:72-3985`，约 3900 行）：参数/角色解析、workspace、manifest 写入、隔离 config 校验、rules bundle、hooks 安装、MCP config——**这部分是 Lead 本体的正规装配，不是生命周期机制**，目标形态里大部分保留。
- Layer 2 恢复循环（`:4143-4493`）：`while true` + `CRASH_COUNT` 退避（5/15/30/60s）+ `resume_recovery_decide()`（`lib/resume-recovery.sh`，92 行：resume 后 <60s 死 ×3 → 删 session-id 转 fresh）+ crash_loop 告警 + HOLD 指数退避——**这就是自研 KeepAlive**。
- 建窗机制（`_lead_create_tmux_window():2254`）：FIFO 门控 client + pending intent（13 字段）+ client fence + archive 提交 + lease 绑定 + 两阶段改名——为"在共享 session 里安全建窗"付出的全部复杂度。
- 死亡检测（`_wait_tmux_window():2904`）：3s 轮询 pane_dead + archive tuple 比对 + 三态 sensor（rc2=不确定→HOLD）。

### 2.2 全局 tmux 锁（scripts/lib/tmux-server-rescue.sh，1760 行）

- 每 socket 一把互斥锁 `~/.flywheel/locks/tmux-<hash>.lockf`（flock→lockf→python fcntl 三级 backend），带 acquisition/decision 收据、episode 台账、崩溃重放。
- 共享者：**supervisor**（ensure `:1528` / recover `:2972`）和 **Runner 侧 TmuxAdapter**（`packages/claude-runner/src/TmuxAdapter.ts:1665` 经 `tmux-server-rescue ensure`）——Lead 和 Runner 在同一把锁上排队。FLY-1659 锁风暴、FLY-1482 lease 死锁都长在这里。
- cmux-sync **不**用这把锁（自有 watcher lease + ledger 锁）——同一台 server 上两套互不知晓的锁体系。

### 2.3 身份租约 + preflight（≈3,460 行 TS + 245 行 shell）

- lease 库：`packages/flywheel-comm/src/lead-lease.ts`（2654 行，better-sqlite3，`~/.flywheel/lead-lease.db`）：lead_lease / generation_history / audit 三表 + pid+lstart 活性三态判定。
- preflight 链（每轮循环）：launch authority（launchctl 报告的 PID==$$）→ lease acquire（rc 3=HOLD / 4=孤儿 / 5=已绑定）→ 全量 `ps -axo` 扫描找同身份进程（`lead_identity_preflight_first_conflict()`）→ 启动前二次复查。**FLY-1662 自撞循环**：preflight 把 supervisor 自己上一轮的孩子判成陌生活体 → HOLD → 孩子死 → 再拉，每 Lead 空转 21-61 轮。
- lease 还耦合进消息层：`flywheel-comm` 每次写都校验 `FLYWHEEL_LEAD_LEASE_KEY`+`FLYWHEEL_LEAD_GENERATION`。

### 2.4 共享 tmux（默认 socket 一台 server + 一个 `flywheel` session）

- 全部 Lead 挤在 session `flywheel`（`claude-lead.sh:1530`），窗名 `<project>-<leadId>`；Runner 按项目 `runner-<project>` session，**同一台 server**。
- Bridge 侧假定共享 session 的消费者：`LeadWindowLocator.ts:46`（watchdog 找 pane）、`lead-alert-helpers.ts:36`、`bridge/tmux-lookup.ts:152`（attach 目标解析）。
- cmux 显示层为补偿"多 Lead 一个 session"而生：每窗建 `cmux-<窗名>` 隔离 view session（`link-window`，**仅限同 server**）、view ledger、restoredv1 收养、watcher 单写者 lease（`/tmp/flywheel-cmux-watcher.lock`）——`scripts/flywheel-cmux-sync.sh` 共 **9807 行**。FLY-1578/1596 两个单全是这套机器的病。

### 2.5 archive / 收养 / rescue

- archive：`~/.flywheel/pids/<key>.claude.tmux`（server_pid/pane_pid/pane_lstart/window_id 四元组，`lib/tmux-supervisor-guard.sh` 178 行）。
- 收养：FLY-1602 加 → FLY-1634 拆 → **FLY-1659 换实现重加**（`_lead_try_adopt_body():1655`，lease rc4 时三重证据收养孤儿 body）。FLY-1662 证明它仍在伤人。
- 账号 rescue（捞号）：**已经不在 lifecycle 脚本里**。grep 六个 lifecycle 脚本，rescue/quota/login 相关命中为零（只有 tmux server rescue，是另一个器官）；FLY-83/109 早已把 blocked 分类迁到 Bridge 侧 `LeadWatchdog`（claude-lead.sh:1247、:4431 只剩指针注释）。现状分布：
  - 检测：`LeadWatchdog.ts`（pane 分类 rate_limit/usage_limit/login_expired）、`account-heal/detection-classifier.ts`（三级判定阶梯，fail-suspicious）；
  - 执行：`bridge/rescue.ts`（435 行，5 条结构护栏）+ `rescue-runtime.ts`——动作就是 **`launchctl kickstart -k gui/<uid>/com.flywheel.lead.<project>-<leadId>`**（`rescue-runtime.ts:89-118`），天然假定 per-Lead launchd job；
  - 入口：`POST /api/rescue` + 独立 CLI `flywheel-rescue-lead`（薄 HTTP client）+ `flywheel-claude-profile`（Keychain 切号）；
  - 配额切号：独立 launchd daemon `com.flywheel.quota-monitor`（quota-monitor.ts 1854 行族），login_expired pane 明确跳过并移交 Bridge rescue。
  - **结论：删除 supervisor 层，捞号能力零损失**；唯一契约 = `com.flywheel.lead.*` label 命名不变。

### 2.6 体量账（生产机制代码，不含测试）

| 组件 | LOC |
|---|---|
| claude-lead.sh（含 Layer1 装配 ≈3900） | 4494 |
| restart-services.sh | 2115 |
| tmux-server-rescue.sh | 1760 |
| flywheel-daemon.sh（plist 生成，保留） | 1105 |
| restart-storm-gate.py | 1053 |
| lead-restart-lifecycle.sh | 848 |
| lead-body-sweep.sh | 474 |
| lead-identity-preflight.sh + tmux-supervisor-guard.sh + lead-launch-authority.sh + resume-recovery.sh + wrapper | 862 |
| lease TS 族（lead-lease.ts + CLI + mode + canonical） | 3459 |
| **lifecycle 层合计** | **≈17,000** |
| （另）flywheel-cmux-sync.sh 中 Lead view 机器 | 9807 行中的主要部分 |

它复刻的 launchd 能力，在 plist 里是两行：`KeepAlive=true` + `ThrottleInterval=30`。

## 3. tmux 行为 spike（隔离 socket 实测，tmux 3.5a）

目标形态的核心疑问是"launchd 怎么直接管一个必须活在 pty 里的 TUI 进程"。实测答案：**让 launchd job 进程 = 前台 tmux server 本身**（`tmux -D`）。

| # | 实验 | 结果 |
|---|------|------|
| S1 | `tmux -D -L <sock> -f conf`，conf 内 `set -g exit-empty on` + `new-session -d -s body "<cmd>"` | server 前台运行、session 由 conf 创建；**body 退出 → session 消失 → exit-empty → server 进程退出**（launchd 视角 = job 死了，KeepAlive 重拉） |
| S2 | 对 server 发 SIGTERM（= launchctl kickstart -k / bootout 的路径） | **server、pane shell、pane 内孙进程全部死亡**——一条 SIGTERM 干净拆整树，无孤儿 |
| S3 | 对已被占用的 socket 再起一个 `-D` server | **exit 1**（"open terminal failed: not a terminal"，退化成 client 且无 TTY）——同 socket 双 server 结构性不可能 |
| S4 | man 确认 | `-D`：server 不 daemonize、不许带 command、默认关 exit-empty（conf 里显式 `set -g exit-empty on` 拨回） |

推论：
- **KeepAlive 语义端到端成立**：Lead 死 → server 退 → launchd 重拉 → conf 重建 session/body。全链无自研代码。
- **重启一个 Lead = `launchctl kickstart -k`**，SIGTERM 整树干净（S2），quiesce/hard-clear/杀窗瞄准问题机制性消失。
- 残余窗口（诚实边界）：launchd 在 SIGTERM 后超时才 SIGKILL；SIGKILL server 不走清理路径，pane 进程理论上可短暂遗孤（pty 已死，TUI 进程随后自退）。S2 证明 SIGTERM 路径正常收树，SIGKILL 仅在 job 不响应 SIGTERM 时发生（tmux server 响应迅速）。
- 启动器需要一行清障：`tmux -L <sock> kill-server 2>/dev/null || true`——job 启动时该 socket 上如有 server，必然不是 launchd 的（前一实例已死），杀之即清场（S3 保证不会误伤共存 server，因为不可能共存）。

## 4. cmux 可见性：约束与机会

### 4.1 现状约束（per-Lead server 会打破的东西）

`flywheel-cmux-sync.sh` 当前假定单 server：`link-window` 建 view 仅限同 server；发现/hook/generation 身份/ledger 唯一性全部锚定裸 `tmux`（默认 socket）；`claude-lead.sh` 硬编码 `=flywheel` 目标。已有唯一跨 server seam：`FLYWHEEL_CMUX_ATTACH_TMUX_BIN`（cmux surface 的 attach 命令可指到别的 tmux 可执行文件）。

### 4.2 关键机会：view-session 机器本来就是共享 session 的补偿物

cmux 每窗建 `cmux-<窗名>` 隔离 view session 的唯一原因：多个 client attach 同一个多窗 session 会共享"当前选中窗"。**per-Lead server 一台 server 一 session 一窗后，这个问题不存在**——cmux workspace 直接 `env -u TMUX tmux -L <lead-sock> attach` 即可，view session / link-window / view ledger / restoredv1 收养对 Lead 全部不再需要。FLY-1578（5 轮 Codex 未过的 grouped-view 迁移方案）、FLY-1596（A1 重建）这两单的病灶随之对 Lead 消失。

### 4.3 Lead 行的新来源

watcher 已有独立于 tmux 的 Lead 名册权威：`derive_lead_roster()` 读 `~/Library/LaunchAgents` plists + `~/.flywheel/manifests`。Lead 行改为**名册驱动**：每个 Lead ensure 一行 workspace（attach 命令指向它的 socket），不再做任何 Lead 侧 tmux 变更。Runner 机器（per-project session、view、reaper）原样保留——Runner 生命周期不在本单 scope。

### 4.4 需要适配的 Bridge 侧消费者（共享 session 的读者）

| 消费者 | 现状 | 适配 |
|---|---|---|
| `LeadWindowLocator.ts` | `list-windows -t flywheel` 找窗 | 改为确定性地址：socket=`flywheel-<project>-<leadId>`，session=`main`（无需查找） |
| `lead-alert-helpers.ts` | DEFAULT_TMUX_SESSION=flywheel | 同上，共享一个 pane 地址 helper |
| `bridge/tmux-lookup.ts` | 解析 `=cmux-<窗名>` attach 目标 | Lead 分支改 per-socket attach |
| `rescue-runtime.ts` / quota-revive-scan | kickstart 按 label（不变）；send-keys 按 pane | pane 定位走同一 helper |

## 5. FLY-1661 解剖（供必答 6/7 判定）

死因链（issue 取证 + 二次 boot 对照实验）：cutover 全量积压（stage-emoji stamp timeout ×54 + terminal-receipt-settlement 冲突无终态出口，每 tick 重试）一次性涌入 boot → event loop 堵死 → EventLoopWatchdog 判 stall SIGKILL 自己 → **当时无 launchd 兜底** → 永久死，log 175MB。二次 boot 烧完积压后 60 秒零增长 = 积压型，非稳态循环。

现状已存在的防洪件：admission pause（FLY-1638，30min，但只闸 runner/workflow 准入，不闸 Bridge 自身 boot 扫描）、redelivery 有界（FLY-1646 已修）、disposition-receipt 每 pass 5 条 + 单飞（好范本）。缺的：boot 期统一预算/节流、stage-emoji 有界重试、receipt 冲突终态出口、日志限流。

批E（FLY-1574，Backlog/Urgent，依赖的批C 已落地）= Discord 收编进 mailbox 统一投递 + **拆掉 chat-receipt 影子收据机器**；FLY-1645（founder 已裁"拆不修"）= 拆整个 relay_state/settle 收据台账，排在批F 后。**FLY-1661 的 receipt 燃料恰好长在批E/FLY-1645 要拆的机器里**。KeepAlive 兜底恢复后，boot-storm 从"永久死"降级为"自愈重启"（二次 boot 实验已证收敛）。

## 6. 其他取证要点

- **Mufasa 先例**：`com.flywheel.lead.growth-mufasa-lead` 已是两层形态（launchd → wrapper source .env → exec TUI runtime），PID ppid=1，KeepAlive 实测 <1s 重拉（`doc/engineer/implementation/companion-lead-ship-discipline.md`）。本单 = 把"launchd 直管"推广到全部 Claude Lead（Mufasa/codex 形态本次不动）。
- **launchd 纪律文档已在**：`companion-lead-ship-discipline.md`（wrapper 契约：set -a source .env / PATH 展开 / exec 交 PID）、`bridge-ship-discipline.md`（先改 config 再 kill，KeepAlive 秒回）。
- **socket 命名约束**：AF_UNIX sun_path ≤104 字符（FLY-1659 R2 教训）——per-Lead socket 用 `-L` 短名（落 `/tmp/tmux-<uid>/<name>`），名字 = `fw-<project>-<leadId>` 级别长度，安全。
- **QA 框架**：529 房已有 `FLYWHEEL_TMUX_SOCKET_OVERRIDE` 隔离 seam 和 `qa-` session 命名合同；per-Lead socket 形态下 QA 房用自己的 socket 前缀即可，互不相扰。
- **launchd 原生刹车**：`ThrottleInterval=30` = OS 级重启限速（每 30s 至多一次）。restart-storm-gate.py（1053 行自研刹车）与之同职。
- **lease 的消息层耦合**：拆 lease 需同步摘除 flywheel-comm 写路径上的 lease 校验（`lead-lease.ts:2465+`）。该校验防的是"旧 body 冒名写入"——目标形态下旧 body 被 SIGTERM 整树收走（S2），冒名场景的产生机制消失。
