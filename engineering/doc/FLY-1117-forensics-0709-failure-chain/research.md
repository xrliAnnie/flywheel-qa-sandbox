# FLY-1117 2026-07-09 全天故障链深挖 — 调研（证据保全 + 初步判定）

Issue: FLY-1117 (https://linear.app/geoforge3d/issue/FLY-1117/forensics-2026-07-09-全天故障链深挖-1427-fleet-全灭-夜间-bridge-双杀攻击-or-系统性)
日期: 2026-07-10
基于: exploration.md（同文件夹）

> 本文档 = design 阶段的取证成果：易失证据已保全 + 主体机制已初步判定。**结论可从 `evidence/` 子目录复推**（SHA256SUMS.txt 锁定）——例外如实声明：`.ips` 目前只有目录 listing 快照（原件由 plan Step 0 开工即补入）；INDEX/exact-command 元数据同样归 Step 0 补录（非逐字留存的旧采集命令须标 not contemporaneously recorded）。剩余深挖项移交 plan.md → Implement。
> 时间约定：正文一律 PDT；`bridge-watchdog.log` 原始时间戳为 UTC（PDT = UTC−7），正文已换算。

---

## 1. 证据保全（已完成，`evidence/` 随分支提交）

| 文件 | 内容 | 为什么关键 |
|---|---|---|
| `bridge-watchdog-log-snapshot.log` | `~/.flywheel/bridge-watchdog.log` 快照 | **本案最重要单件证据**：每次 Bridge event-loop 看门狗自杀的 forensic 行（appendFileSync，SIGKILL 前落盘） |
| `catchall-142640-142750-raw.log.gz` | unified log 14:26:40–14:27:50 全量（10,082 行） | E1 死亡瞬间的完整系统视角（appDeath 级联） |
| `appdeath-per-second-142640-142750.txt` | 上件的逐秒死亡计数（衍生） | E1 死亡形状：滴漏 vs 雪崩 |
| `memorystatus-fullday-0709.log.gz` | 全天 memorystatus/jetsam 谓词导出（110k 行） | jetsam 全天活动分布（14:27 = 零） |
| `launchd-flywheel-2320-2335-0709.log.gz` | 23:20–23:35 launchd + flywheel 记录 | 第二刀的 launchd 权威序列（exit(137)、ran for、respawn） |
| `remote-access-fullday-0709.log` | 全天 sshd/screensharingd/loginwindow 导出 | 攻击面：全天 **0 条** sshd/screensharing |
| `system-health-2026-07-09.log.gz`（+7-10 partial） | 60s 快照全天（load/进程数/top-RSS/vm_stat） | 分钟级内存与负载实测 |
| `bridge-restart-history-linenos.txt` | bridge.log 全部「Starting Bridge」行+行号 | Bridge 重启全史（wrapper 带 HH:MM:SS） |
| `bridge-boot-142620-segment.log.gz` | bridge.log 14:26:20 boot → 14:40:37 段 | 14:27 期间 Bridge 视角（kill 尝试全失败） |
| `cmux-watcher-incident-window-0709.log` | cmux-sync 事发窗口段 | tmux server 最后存活时刻 14:27:12 + 重建证据 |
| `diagreports-{system,user}-listing.txt` | 双域 DiagnosticReports 清单快照 | 零 JetsamEvent / 零 tmux .ips / OrcaSlicer ~17 崩 |
| `SHA256SUMS.txt` | 全件哈希 | 证据完整性 |

**保全过程中实测到的关键易失性事实**：unified log 中 **launchd 类目的保留窗只有 ~1 小时级**——00:20 时 23:2x 的 launchd 行还在、21:3x 和 14:2x 的已被滚掉（同窗口 loginwindow/runningboardd 行还在，证明是按类目滚动不是整体滚动）。**「证据保全先行」这个设计决定直接救了本案**；这也解释了为什么"macOS 不记 signal 发送者"之外，事后取证这么难——launchd 权威记录窗口极短。

## 2. 全天时间线（全部有证据指针）

| 时刻 (PDT) | 事件 | 证据 |
|---|---|---|
| 00:26 | BambuStudio 崩溃 | user .ips |
| 06:05:41 | Bridge 例行重启（每日 updater 窗口） | restart-history |
| 11:32 | OrcaSlicer 当天第 1 崩 | user .ips |
| 13:09:18/56 | Bridge 重启 ×2（watchdog forensic log 无对应行——该记录是 best-effort，缺行非绝对排除；原因待查→Implement；双起间隔 ~30s 的工作假设 = launchd `ThrottleInterval=30` 节流 respawn） | restart-history |
| 14:22:34 | Pages free 5,230（≈82MB，全天最低）；load 24.7 | health-log |
| 14:23:36 | **load 冲 66.38**；top-RSS 出现 `npm install`（FLY-1062 payload 构建） | health-log |
| **14:26:20** | **看门狗当日第 1 杀**：Bridge 主循环已停跳 61.3s → 自我 SIGKILL；wrapper 同秒重启 | watchdog log（`2026-07-09T21:26:20Z`）+ restart-history `14:26:20` |
| 14:26:40–14:27:13 | **加速滴漏**：~120 个 node 进程以 1→8 个/秒逐个死亡 | catchall 切片 appDeath 计数 |
| 14:26:41 | load 78.22；Pages free 17,212（≈269MB，紧张但非最低） | health-log |
| 14:27:12 | cmux-sync 最后一次成功给 flywheel/runner-flywheel/runner-sub 挂 hooks —— **旧 tmux server 此刻还活着** | cmux-watcher log |
| **≈14:27:13–14** | **默认 socket tmux server 倒下** | 下一行的雪崩起点 |
| 14:27:14–20 | **雪崩**：7 秒 ~142 个 CAS appDeath（快照间共 ~600 进程消失） | catchall 切片 + health-log（1425→828） |
| 14:27:43 | Pages free 1,513,794（**≈23GB 瞬间释放**）；load 111.58 | health-log |
| 14:27:44 | cmux-autostart 重建 `tmux new-session -Ad -s flywheel` | ps lstart（预审计）+ cmux-watcher |
| 14:28:25 | 三个 session 全部回归，hooks 重挂成功 | cmux-watcher log |
| 14:28:44 | load 峰值 154.99；此后逐分钟回落 | health-log |
| 14:40:37/14:41:08 | Bridge 重启 ×2（恢复期；watchdog 缺行同 13:09 行 caveat，原因待查→Implement） | restart-history |
| 15:14 / 15:57 | node .diag 资源报告（system 域） | diag listing |
| 17:29 | biome 崩溃 | user .ips |
| **18:16:58 / 18:23:24** | **看门狗第 2、3 杀**（两次无人上报的 Bridge 死亡） | watchdog log + restart-history 同秒对齐 |
| 19:43 | node 崩溃（user .ips） | diag listing |
| 20:42–21:13 | OrcaSlicer 崩溃簇（20:42×2、21:11–21:13×4）；Chrome 21:17、chrome-headless-shell 21:18 崩 | diag listing |
| 21:03:41 | Bridge 重启（watchdog 缺行同 13:09 行 caveat，原因待查→Implement） | restart-history |
| **21:12:45** | **看门狗第 4 杀**（恰在 OrcaSlicer 崩溃簇中） | watchdog log |
| **21:35:23** | **看门狗第 5 杀 =「夜间第一刀」**：stall 61.4s（主循环 ~21:34:22 停跳）；load 同分钟 66.20 | watchdog log + launchd「ran for 6875094ms」倒推 73504 出生 21:35:24，同秒对齐 |
| 21:41–翌日 00:20 | 内核 jetsam 快照记录持续（每 1–2 分钟一条，跨午夜延续到 7/10 00:20；**reason 分类待做**——已见 `ecosystemanalyticsd … per-process-limit` 等进程私限记录，不可未分类即当全机压力旁证 → plan Step 5。注意 7/9 00 时段的「jetsam」命中全部是 `dasd` 调度 telemetry，非 kernel snapshot） | memorystatus 导出 |
| 22:08–22:30 | OrcaSlicer 崩溃簇第二波（×10） | diag listing |
| 23:14–23:27 | FLY-1082 QA 窄范围测试 + 隔离 E2E（自查报告） | FLY-1082 `incident-bridge-2329-analysis.md` |
| **23:28:37** | FLY-1082 QA 在生产 host 后台起**全量 teamlead vitest（20+ worker）** | 同上（QA 自认） |
| 23:28:48 | Pages free 掉到 **5,097（≈80MB，临界）** | health-log |
| ~23:28:56 | Bridge 主循环停跳（= 23:29:59 − stall 63.1s；vitest 启动后 19 秒） | watchdog log 倒推 |
| **23:29:59** | **看门狗第 6 杀 =「夜间第二刀」**；launchd 同毫秒级记录 `exited due to exit(137), ran for 6875094ms` → 同秒 respawn 现任 pid 48951 | watchdog log + launchd 导出（双源同秒互证） |
| 23:29:49 | Pages free 回升 103,509（死亡进程被收割） | health-log |

> 命名澄清：issue 里的「23:29:14」与「双杀」均不精确 —— 权威时刻是 **23:29:59**（watchdog + launchd 双源）；且当日看门狗共开火 **6 次**，「双杀」只是被注意到的两次。

## 3. E2（夜间 Bridge 死亡）判定 — 置信度：高

**凶手 = Bridge 自己的 event-loop 看门狗（`BridgeEventLoopWatchdog`，默认 ON，FLY-83/FLY-887 家族机制）**。机制：独立 worker 线程监测主循环心跳，停跳 >60s → 写 forensic 行 → `process.kill(self, SIGKILL)` → launchd KeepAlive 拉活。这是 by-design 的自愈动作，不是外部攻击，也不是内核 jetsam。

证据链（三源互证）：
1. `bridge-watchdog.log` 六条 forensic 行，PDT 换算后与 bridge.log 六次 wrapper 重启**逐条同秒对齐**（14:26:20 / 18:16:58 / 18:23:24 / 21:12:45 / 21:35:23→24 / 23:29:59）。
2. launchd 权威记录（23:29:59）：`exited due to exit(137)` —— wrapper 脚本用 `exec` 把 bash PID **替换**为 Bridge 进程（`scripts/flywheel-bridge-wrapper.sh`），launchd 观察到的 73504 就是 Bridge 本体、137 就是 SIGKILL 本身；watchdog forensic 行（23:29:59.149）与 launchd 收尸（23:29:59.229）同秒；`ran for 6875094ms` 倒推 73504 出生 = 21:35:24 = 第 5 杀重启时刻，闭环。
3. 死前 bridge.log 无任何 FATAL/错误输出（SIGKILL 特征：没机会留遗言）。

**为什么主循环会停跳 >60s**（深层因，按刀分述）：
- **第 6 杀（23:29:59）**：FLY-1082 QA 自认 23:28:37 后台起全量 vitest（20+ worker）→ 19 秒后主循环停跳 → Pages free 同分钟掉到 80MB。触发链清晰。QA 报告两处需更正：① 它写「Bridge (pid 48951) 被回收」——48951 是**重启后的现任**，被杀的是 73504；② 它推测「37 秒够不上 60s 阈值,所以是内核 OOM」——实际是看门狗（stall 从 23:28:56 起算 63s），**不是内核**（该窗口无 jetsam kill 记录）。其「全量 vitest 是触发」的自认成立。
- **第 5 杀（21:35:23）**：同机制；触发者待钉（→ Implement 按 plan Step 1a 查 bridge.log 21:12:45–21:35:24 段 + health-log 21:30–21:36 top-RSS 变化；候选须含 21:34 top-RSS 可见的 vitest 进程）。
- 其余四杀同一 self-kill 机制；**触发者逐刀均为 TBD**（plan Step 1c 合同：每刀独立取证 + 独立置信度）。已观测的时段上下文仅作记录不作归因：14:26 与 E1 危机同窗、21:12 与 OrcaSlicer 崩溃簇同窗、18:16/18:23 上下文未查。

**事实更正（对 FLY-1082 记录）**：其 exploration §1 把「StateStore `sql.js corruption unrecoverable … out of memory — exiting`」归因给 7/9 14:27 —— 经查该 FATAL 在 bridge.log（6/28 起 360MB）**全文件仅出现一次**，紧跟 6 月底的 `16:08:23 Starting Bridge`，属**六月底旧事故**。7/9 14:26:20 的 Bridge 死因是看门狗。

## 4. E1（14:27 fleet 全灭）判定 — 置信度：中高

**机制（相容最佳解释，非直接观测——限定语适用于本节全部机制表述）= 系统级内存耗尽危机中的「有机崩塌」：进程各自撞上内存分配失败逐个死亡，最终 tmux server 本体的分配失败令其退出，带走全部 pane（30+ runner）。无外部杀手证据。**

证据链：
1. **死亡形状**：14:26:40–14:27:13 加速滴漏（1→8 个/秒，~120 个 node）→ 14:27:14–20 雪崩（~142 个/7 秒）。该形状**反对一次性批量扫杀**（如单发 pkill——瞬时不呈滴漏）；但循环/逐目标推进类自动化不能仅凭形状排除——那正是 plan Step 3 嫌疑人矩阵要逐项检验的。滴漏 + 末端雪崩与「个体资源死亡 + 宿主倒下带走全体」相容。
2. **atlas 反证**：`-L atlas` socket 的第二个 tmux server（6/28 起）及其 claude/node 进程全部幸存 —— 任何「按名字杀 tmux/node」的宽模式扫杀都无法解释这个幸存。
3. **jetsam 排除（限定措辞）**：全天 memorystatus 导出在 14:2x 窗口内**本谓词零 kill、零快照记录**（快照记录始于 7/9 21:41，延续至 7/10 00:20）；双域零 JetsamEvent 报告。注意这是负证据——谓词覆盖范围的阳性对照验证 + reason-code 分类归 Implement（plan Step 5）；晚间簇中已见 `per-process-limit` / `MEMORY_IDLE_EXIT` 等**非全机压力**的 reason，不可把快照簇不分类型地当「系统 OOM」旁证。
4. **零 crash 报告的解释**：tmux 的 OOM 路径是 `fatal()` → 干净 exit（非信号、非 abort）→ 不产生 .ips —— 「没有 tmux 崩溃报告」与本机制**相容**（此点的源码级确认 → Implement）。
5. **内存实测**：14:22 起 Pages free 贴地（82–269MB 区间波动），FLY-1082 记录 swap 打满（16384MB 用 14815MB，出处考证 → Implement），load 51→78→111 = 换页/压缩风暴。每个进程死亡释放的内存立即被吞没，直到 server 倒下瞬间释放 23GB。
6. **死亡窗口精确**：cmux-sync 14:27:12 还在旧 server 上成功操作 → 死亡时刻 ≈14:27:13–14（雪崩起点），14:27:44 由 cmux-autostart 重建。
7. **Bridge 无嫌疑**：14:26:20 新 boot 的 Bridge 的 kill 尝试全部「Command failed」（且只针对 viewer session），收尸逻辑 fail-closed 拒绝执行 —— 没有任何成功的杀 session 记录。

**残余不确定性（如实声明）**：tmux server 的退出原因没有任何直接记录（没有 launchd 管它、没有 crash 报告、unified log 不记 signal 发送者、launchd 类目日志已滚掉）——「分配失败 → fatal() 退出」是从死亡形状 + 幸存者 + 排除法收敛的推断，不是直接观测。无法 100% 排除「某个未留痕的进程对该 server 发了信号」，但没有任何证据支持该方向，且滴漏形状与 atlas 幸存都反对它。

**根因层**：为什么 14:22–14:27 内存耗尽 —— 30+ runner × 0.4–0.6GB + Discord ~0.9GB + npm install 构建 + 常驻应用，物理内存 + 16GB swap 全部吃满。这是**容量问题**（FLY-1072 派活门槛 / FLY-1082 swap 预警正是治它的），不是泄漏或攻击。

## 5. E3（OrcaSlicer 等连崩）初判 — 置信度：中（待 Implement 分类）

全天 ~17 次 OrcaSlicer 崩溃（11:32 起，密集于 20:42–22:30），伴 BambuStudio/biome/node/chrome-headless-shell 各 1–2 崩。与晚间 jetsam 快照簇（21:41 起）时段共现——**共现只是描述,不承担因果**。已知抽样线索：晚间簇多为近空地址 `EXC_BAD_ACCESS 0x0/0x4/0x8` 重复签名（预期主桶 = 应用自身 bug），11:32 为 `SIGABRT`/boost::log 路径。**待 Implement 按 plan Step 4 的分类合同定案**（exception+termination reason、符号化签名、image provenance、同签名重复率、同分钟水位;「资源压力」须有 allocation failure/EXC_RESOURCE/jetsam 记录实证,「注入」须有 provenance 实证——随机地址不算）。

## 6. 攻击面核查 — 初判：未发现与三事件相关的外部入侵迹象（置信度与盲区随终判给出；终判 → Implement 按 plan Step 7 攻击路径矩阵收口）

| 检查项 | 结果 | 状态 |
|---|---|---|
| SSH / 屏幕共享（unified log 全天） | **0 条** sshd / sshd-session / screensharingd 记录 | ✅ 已查 |
| 夜间双杀的「手」 | = Bridge 自身看门狗（进程内 worker 线程），非外部进程 | ✅ 已钉死 |
| E1 的「手」 | 无杀手证据；有机崩塌 + atlas 幸存反证扫杀 | ✅ 中高置信 |
| launchd 双域 job 清单 | 已全量枚举（exploration §4.3）；初看均可认领（flywheel 系 / Adobe/Google/腾讯/搜狗/Canon/Zoom/Docker/VPN 等已知软件） | ⏳ 逐个认领表 → Implement |
| authorized_keys / chezmoi 配置改动 | 未查 | ⏳ Implement |
| GitHub / Linear / Discord 非我方动作审计 | 未查 | ⏳ Implement |
| 3dcb1b94「runner 幻觉注入」证伪复核 | scratchpad 未在预期路径找到，需深挖 | ⏳ Implement |
| 历史网络连接 | macOS 默认无记录 —— **永久盲区，报告如实声明** | 📌 盲区 |

## 7. 内存假说复核（直接回答 Annie 的质疑）

Annie：「感觉不是内存的问题,用电脑并没有变慢」。数据说：**是内存，但不是她想象的那种「越来越卡」的内存问题**——
1. 急性危机只有 **约 5 分钟**（14:23 load 冲 66 → 14:28 峰值 155 → 14:32 回落到 8.8）。不在那 5 分钟里重度用机，感知不到很正常。
2. 死法不是 jetsam（macOS 桌面上 jetsam 对普通进程相当克制,当天 14:2x 窗口内本谓词零记录）——最佳解释是**进程各自分配失败**（直接观测缺位,为推断,见 §4 残余不确定性）。前台 GUI（WindowServer 等 wired/高优先级）恰恰是受保护的那一侧，牺牲的是后台 runner 大军。「电脑不卡但 runner 全死」与机制一致。
3. 「swap 打满压死 tmux」的旧说法**方向对、机制存疑**：「压死」无证据（无 jetsam、无 SIGKILL 证据）；相容最佳解释是 tmux 自己分配内存失败、按自身 fatal 路径退出（无直接观测,见 §4 残余不确定性）。JetsamEvent 缺失不再是谜——该窗口本就没有 jetsam kill 记录。
4. 旧叙事里「Bridge sql.js OOM 死亡」属 6 月底事故，7/9 的 6 次 Bridge 死亡全部是看门狗（§3）。

## 8. 移交 Implement 的开放项（→ plan.md）

1. E1 收尾（plan Step 2）：tmux 二进制/源码取证；swap 数字出处考证；滴漏与雪崩两侧的**进程生命周期与退出语义复建**（LSASN→pid→身份→首末记录→termination reason,含覆盖率声明）。
2. E2 收尾（plan Step 1）：第 5 杀触发者（候选含 21:34 top-RSS 的 vitest 进程）；13:09 / 21:03 / 14:40 三组重启定因（watchdog 缺行仅为弱证据）；六杀对齐表按「机制/触发」分列置信度。
3. 嫌疑人矩阵（plan Step 3,Linear 原单硬要求）：全部 kill 能力自动化逐项五列 alibi。
4. E3（plan Step 4）：按新分类合同定案。
5. 攻击面（plan Step 7）：攻击路径矩阵收口,含 SSH 文件取证与远程服务使用痕迹。
6. macOS 行为查证（plan Step 5）：reason-code 分类先行;JetsamEvent 落盘条件;ReportCrash 解释仅在 2c 证明 crash-eligible 后才适用。
7. 防复发建议 + founder 交付物（plan Step 8/9;**条件分支**——HTML ownership 例外在生产前经 Tadashi 确认：获授权则 Runner 产 HTML,未获授权/被拒则交结构化素材包由 Lead 产投,两种形态各有对应验收口径）。
