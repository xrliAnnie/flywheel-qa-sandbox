# FLY-1082 fleet 级故障告警 + ARC 真修 — 探索

Issue: FLY-1082 (https://linear.app/geoforge3d/issue/FLY-1082/infra-alerts-fleet-级故障oom-tmux-server-死-跨-lead-僵尸无人认领-arc-真修那一环没生效)
日期: 2026-07-09
基于: 无(本单第一份文档;上游 spec = FLY-915 PRD + PR #530 补节 §4.4/§8.1)

---

## 1. 触发事件与问题陈述

2026-07-09 14:27 PT:swap 打满(16384MB 用 14815MB)→ Bridge StateStore `sql.js corruption unrecoverable … out of memory — exiting` → 承载全部 runner 的 tmux server 整个消失 → 3 个 Lead 名下 13+ runner 全灭。**告警系统表现 = 零**:无 bot ACK、无自动修复尝试,Annie 本人先发现。

暴露 PRD(FLY-915)两个真窟窿:
1. **§4.1 工单 kind 白名单没有 fleet 级故障**(机器 OOM / swap 阈值 / tmux server 死 / Bridge 异常退出 / 跨 Lead 僵尸 session)→ 无人认领,按设计落到 Annie 头上。
2. **§4.3 承诺链的「ARC 真修」那一环没在跑** —— FLY-927 交付了队列 + 路由 + @-target 门禁 + Watchdog v2,但事故当晚没有任何证据表明「bot 真正去修」这一环生效。北极星 N1 直接被打脸。

## 2. 现状审计(代码证据)

### 2.1 检测 → 入队 → ACK → ARC → 升级:每一环今天长什么样

| 环节 | 现状实现 | 证据 |
|---|---|---|
| **kind 白名单** | 22 个 kind,全部是单体粒度(单 Lead 冻结 / 单 runner 卡死 / 账号 / auth / 门禁…),**零 fleet 级 kind** | `LeadAlertNotifier.ts:62-164` `ALERT_EVENT_TYPES` |
| **owner 路由** | `resolveTicketOwner()`:账号/auth 类交叉指派(谁都不救自己),其余默认 Claude bot;`NO_OWNER_KINDS`(permission_blocked / runner_lead_pending_unhandled)显式无 owner。**owner env 未配 ⇒ userId=null ⇒ 不 @、也不武装 unclaimed fallback** | `bridge/ticket-owner-map.ts:52-88` |
| **入队 + 生命周期** | AlertChannelHub 管 `NEW/ACK/REPAIRING/RESOLVED/ESCALATED`,reconcile 搭 watchdog `onPollComplete` 顺风车(零新 timer) | `bridge/AlertChannelHub.ts`、`bridge/ticket-escalation.ts:1-15` |
| **修不掉判定(T2)** | 2 次尝试 或 5 分钟超时 → escalate;NEW 无人认领 5 分钟 → escalate(**仅当 owner 已配置**) | `bridge/ticket-escalation.ts:26-77` |
| **ARC 执行(真修)** | `AutoRepairBot`(Bridge 内进程,actor=aunt-cass,`FLYWHEEL_AUTO_REPAIR=1` 已开):**只修 3 类**(runner_stuck_unhandled / runner_throttle_stalled → audited continue nudge;pane_hash_stuck → resume-menu 单 Enter)+ usage_limit 账号切换(FLYWHEEL_ACCOUNT_SELF_HEAL 接线时)。其余一律 needs_human。**绝不 restart/kill**(FLY-175 founder-gated;重恢复引擎留给 FLY-271) | `bridge/AutoRepairBot.ts:1-105` |
| **owner bot(工单认领方)** | 双 infra bot(claw-infra-bot / Codex Infra Bot)= FLY-928 产物,**事故当晚 launchd job crash-loop 中**(FLY-1071 记录 W5 exit1×8),owner env 未全武装 | FLY-1071 issue;`ticket-owner-map.ts:13-15` 注释 |
| **Bridge 自身死亡** | StateStore 不可恢复 → `process.exit(1)` → launchd KeepAlive respawn。**没有任何 kind 表达「Bridge 死过」**;wrapper 的 fail-loud(`bp_fail_loud` → lead-alert.sh `bridge_wrapper_fail`)只覆盖「起不来」,不覆盖「死了(且成功重启)」 | `StateStore.ts:640-651`;`scripts/flywheel-bridge-wrapper.sh:76-110` |
| **runner 死亡的事后处理** | crash-reaper(FLY-720):heartbeat tick 上把 dead-pin runner 收尸(dump scrollback → 拆窗 → terminated)。**是清理,不是告警** —— 13 个 runner 同时死,系统的反应是逐个静默收尸 | `bridge/crash-reaper.ts:1-27` |
| **Bridge 独立告警通道** | `scripts/lead-alert.sh`(Discord 直发 + claims.db 去重 + kind allowlist),已有先例:tui_window_lost / restart_guard_bypass / bridge_wrapper_fail | `scripts/lead-alert.sh:97-105` |

### 2.2 为什么 2026-07-09 零告警(结构性根因链)

1. **白名单没有 fleet kind** → 即便 Bridge 14:29 复活后,也没有任何检测器把「tmux server 没了 / 20 个 session 集体消失」翻译成一张工单。
2. **检测面全部活在 Bridge 进程内**(LeadWatchdog / AlertChannelHub / AutoRepairBot 都是 Bridge 组件)→ Bridge 自己 OOM 死的那一刻,整个 检测→入队→修复 平面一起死。唯一的 Bridge 独立腿(wrapper fail-loud)只在「起不来」时响。
3. **复活后的对账是「逐个收尸」不是「集体死亡=fleet 事件」** —— crash-reaper / reapOrphans 按 session 粒度清理,没有聚合视角,没有任何一处会说「一大片同时挂了」。
4. **owner bot 不在岗**:双 infra bot crash-loop(FLY-1071 待修),且 owner env 未配 ⇒ 按 FLY-927 的保守设计,连 unclaimed-5min 升级都不武装(纯 config flip 前 = Cass 现状)。
5. **swap 水位无传感器**:没有任何代码读 `sysctl vm.swapusage` / memory_pressure —— 预警窗口(事故前 30+ 分钟水位爬升)完全浪费。

> FLY-942 §3.3b 佐证:「fleet 级(一大片同时挂)照旧走 FLY-915,不走 30min」—— 产品侧已明确把 fleet 级检测归到 FLY-915 体系,本单就是那块落地。

## 3. 方案空间

### 3.1 新增 kind 集合(提案,进 PRD §4.1 + 代码白名单)

沿用 §4.4 契约:每个 kind 要么 (a) 有 remediation + owner,要么 (b) 明确标「无 ARC、直接升级」+ owner。**不允许无主 kind。**

| 新 kind | 检测(放哪) | owner(@ 谁) | ARC 动作(可修边界) | 修不掉/升级 |
|---|---|---|---|---|
| `swap_pressure_high`(OOM 预警) | Bridge tick 顺风车读 swap 水位(`sysctl vm.swapusage`),阈值默认 80% + 滞回;**传感器 seam 可注入**(QA 用) | Claude bot | (a) 置 Bridge「暂停派新 runner」flag(可逆,水位回落自动解除)+ 通知各 Lead 降载。**与 FLY-1072 的派活门槛共用同一水位读数 seam,门槛本体归 1072** | 水位持续超阈 >T 或 pause 无效 → @Annie |
| `tmux_server_lost` | ① Bridge tick:tmux socket probe 失败 且 StateStore 有 running session;② boot reconcile:上次 running N≥阈 且 pane 集体消失(与逐个 dead-pin 区分) | Claude bot | (a) 批量标记死亡 session(复用 crash-reaper 收尸腿)→ **按 Lead 分组通知**,附各自阵亡 runner 清单 + resume 指针($FLYWHEEL_PROGRESS_PATH / FLY-795);**respawn 由各 Lead 驱动**(Lead 管 runner lifecycle 铁律 + 防 respawn stampede:通知里带当前内存水位) | 通知投递失败 / Lead 不响应(走 FLY-637-ext 梯子)→ @Annie |
| `bridge_abnormal_exit` | **三腿**:① **wrapper 腿(Bridge-independent,快路径)**:Bridge 进程非 clean-shutdown 退出 → lead-alert.sh 直发(扩 bp_fail_loud 覆盖「死了」);② **boot 自检腿**:clean-shutdown marker 缺失 → 复活后的 Bridge 给自己开工单;③ **外部心跳兜底(慢路径,gate 补充,Tadashi 2026-07-09)**:Codex Infra Bot(独立 launchd home / 独立 auth / 独立进程)定期探 Bridge health,**连续 down 超过 N 分钟 → 直接升级 @Annie**,不依赖 Bridge 复活、不依赖 wrapper 那一发 —— 覆盖「死了且没活过来」(launchd 卡死 / 反复 crash-loop / wrapper 腿也失败)的静默洞。本单只定职责 + 触发判据;bot 本体 enable/部署归 FLY-1071/928 | Claude bot(外部心跳腿的执行者 = Codex bot,真「谁都不救自己」:Claude/Bridge 侧死了归 Codex 侧从外面看) | (a) launchd respawn 本身就是 remediation;工单动作 = ACK + 复活自检(StateStore 完整性 / boot 对账跑完)→ 安静 resolve | crash-loop(复用 `scripts/lib/bridge-port.sh` 已有 crash-loop 检测)或 外部心跳判「一直没起来」→ @Annie |
| `infra_bot_down` | Bridge tick 探两个 bot 的 lead session / launchd job 存活(bot 本身是 windowed Lead,已在 watchdog 视野;job 级死亡补 launchctl 探针) | **交叉**:Claude bot 死 → @Codex bot;Codex bot 死 → @Claude bot(issue 原文「它自己死了归 Codex Infra Bot」) | (a) `launchctl kickstart` 对应 job(可逆) | kickstart 两次失败 → @Annie |
| `zombie_session_backlog`(跨 Lead 僵尸) | Bridge 低频扫描 CommDB↔StateStore 对账(检测口径 = FLY-1066 已取证的三形态:CommDB-only 孤儿 / StateStore 终态未同步 / scope 挡住的残留),积压 ≥N 才开单 | Claude bot | (b) **v1 无 ARC、直接升级**(带样本清单);收割机制 = FLY-1066,其落地后把本 kind 从 (b) 升 (a)(remediation = 调 scope-free 清理入口) | 直接 @Annie(带清单 + 一个决定) |

取舍说明:issue 里「机器 OOM」和「swap 打满」合并为一个预警 kind(`swap_pressure_high`)—— 真 OOM 已经发生时,后果必然表现为 `bridge_abnormal_exit` / `tmux_server_lost`,单独一个「OOM 已发生」kind 与这两个 100% 重叠,不设。

### 3.2 ARC「真修」执行层:谁来修

三层分工(全部尊重 FLY-175 founder-only-authority + §4.4 五条立刻升级):

1. **AutoRepairBot(Bridge 内,即时层)** —— fleet kind 的 remediation 大多是 Bridge 本地动作(置 pause flag / 批量收尸+分组通知 / kickstart launchd job),扩展 `AUTO_ATTEMPT_EVENT_TYPES` + 对应 attempt 分支最顺路,且天然被 T2(2次/5分)和全部既有安全闸约束。
2. **owner infra bot(Discord 认领层)** —— ACK + 按 runbook 核验修复效果 + 判 escalate 文案(kind · 试了什么 · 为何失败 · Annie 只需拍的那一个决定)。bot 不直接碰 runner lifecycle(reserved actions)。
3. **Lead(runner 复活层)** —— tmux server 死后的 runner respawn 一律 Lead 驱动(通知带清单+resume 指针),bot/Bridge 不代劳。

「自己救自己」红线的落法:fleet kind 的 remediation 执行体是 Bridge,不是任一 bot,不触犯 actorBackend===provider;唯一例外 `infra_bot_down` 按交叉指派。**Bridge 修自己(abnormal_exit)的实质是 launchd,Bridge 只做复活后自检**,不算自救。

### 3.3 fail-loud 启动校验(Tadashi 硬约束)

新模块 `kind-contract.ts`:`Record<AlertEventType, KindContract>`,每个 kind 声明 `{ owner, arc: "auto" | "none_escalate" | "human_by_design", remediationRef? }`。
- **编译期**:Record over union = 少一个 kind 编译不过。
- **启动期**:Bridge boot 时校验每个 kind 满足 (a)/(b),缺 → **打印缺哪个 kind + 拒绝启动**(throw before listen),不做「警告继续跑」。
- 存量 `NO_OWNER_KINDS`(permission_blocked=人类决策 / runner_lead_pending_unhandled=梯子已响应完)映射为显式 `human_by_design` / `none_escalate` 条目 —— 行为零变化,只是把「为什么没 bot 管」写成契约。

### 3.4 反复升级 → 自动立 eng 单(§4.4 ⭐,N1 唯一单调下降机制)

escalate 路径上(AlertChannelHub)统计:同一 kind 近 7 天 ESCALATED 次数 ≥N(默认 3)→ 自动建 Linear eng issue「补 <kind> runbook」(FLY team / Flywheel project / Flywheel label),**去重 = 每 kind 最多一张 open 单**(状态记录在 Bridge 侧,或建单前查重)。founder 面文案规则照旧(不带上游 PRD 号、说人话)。

### 3.5 端到端实证(验收,不接受「代码合了」)

复用 FLY-529 QA Room 隔离(隔离 alert 频道 + `FLYWHEEL_ALERT_QUEUE_DIR/DEADLETTER_DIR/CLAIMS_DB`):
- `swap_pressure_high`:传感器 seam 注入超阈读数 → 工单 → ACK → pause flag 置位 → 注入回落 → 安静 resolve。
- `tmux_server_lost`:QA bridge 用隔离 tmux socket + 测试 runner → `kill -9` 该 tmux server → 工单 → 分组通知 → resolve/escalate。
- `bridge_abnormal_exit`:`kill -9` QA bridge → wrapper 腿直发 + 复活后 boot 自检开单 → ACK → resolve。
- 证据链:测试频道里可见 `NEW → ACK → 修复中 → 已修/已升级` 全程 + 修复动作副作用实证。

## 4. 边界(别揽别人的活,但对得上)

| 相邻单 | 它做什么 | 本单与它的缝 |
|---|---|---|
| FLY-1072(Urgent) | **防发生**:runner 可存活性 / 内存水位派活门槛 / 并发上限 / 水位 watchdog | 水位**传感器读数 seam 共用**;派活门槛本体归 1072;本单只做「预警 kind + 工单 + pause flag」这条告警链 |
| FLY-1066 | 跨 Lead 残留**收割**(CommDB 孤儿清理 + 终态同步 + scope-free 入口) | 本单只做**检测 + 开单 + 升级**(v1 kind 为 (b) 型);1066 落地后 remediation 升 (a) |
| FLY-1071 | enable 窗:双 bot 真跑起来(crash-loop 诊断 + 探针 + 演练) | 本单验收的「bot ACK」依赖它先落地;owner env 未配时本单机制按 FLY-927 惯例优雅降级(不 @、不武装 fallback) |
| FLY-1092 | reconcile 给已 Done 的 issue 重起 QA | 不碰 |
| FLY-271 | 重恢复引擎(restart/kill 级动作) | 本单 ARC 只做可逆动作,重动作照旧归 271/founder-gated |
| FLY-928/929 | bot 部署 / 通知迁移 | 不碰部署;N1/N2 digest 聚合(§8.1)**不在本单**,本单只保证工单生命周期字段写齐(N1 可算的前提) |

## 5. 假设清单(gate 前显式亮出)

- A1:kind 集合 = §3.1 的 5 个;「OOM 已发生」不单设 kind(由 abnormal_exit / tmux_lost 承接)。
- A2:swap 预警的 remediation = 可逆 dispatch-pause flag(本单)+ 水位 seam 共享(1072 接走门槛)。
- A3:反复升级自动立单阈值 N=3 / 7 天,可配。
- A4:N1/N2 的 digest 聚合不在本单 scope(只保证字段可算)。
- A5:tmux server 死后 runner 复活 = Lead 驱动,Bridge/bot 只通知不代劳。
- A6:wrapper 腿(Bridge-independent)只做 fail-loud 直发,不做工单生命周期(队列 host 是 Bridge,Bridge 不在就没有工单可言 —— 诚实边界)。

## 6. 推荐方向

按 §3 全套做:5 个 kind + 三层 ARC 执行 + kind-contract fail-loud 启动校验 + 反复升级自动立单 + QA Room 三注入实证。核心哲学:**检测面允许活在 Bridge 里(它有 launchd 兜底、死了会回来),但「死过」这件事必须留下不可磨灭的信号**(wrapper 腿 + dirty-exit marker),复活后的第一件事是把 fleet 事件翻译成有主的工单;**再加一条 Bridge 进程外的独立视角**(Codex bot 外部心跳)兜住「死了且没活过来」。

> **架构铁律(Tadashi,2026-07-09 implement 段落定)**:fleet 级检测不得塞回 Bridge 进程内(否则事故时同死)—— 具体指「Bridge 自身死亡」的检测腿(wrapper dirty-marker 直发 + 进程外心跳探针)必须永远活在 Bridge 进程之外;以后任何重构都不许把这两条腿折回 Bridge 内(那正是 2026-07-09 零告警的结构性根因)。

## 7. Brainstorm gate 结果(Tadashi,2026-07-09)

**通过**,逐条认可(kind 划分 / fail-loud 注册表含存量映射 / ARC 三层 / respawn stampede 防护 / 自动立单 / QA Room 验收),**一条硬性补充已折进 §3.1**:
- Bridge 进程外的「还没活过来」心跳兜底 —— Codex Infra Bot 定期探 Bridge health,连续 down 超 N 分钟直接升级,与 wrapper 快路径互补(wrapper 抓死亡瞬间;外部心跳抓「一直没起来」)。今晚的事故正是「没活过来、也没人从外面看」。
- 分界:本单定「外部心跳职责 + 触发升级判据」;Codex bot 本体 enable/部署照旧归 FLY-1071/928。
