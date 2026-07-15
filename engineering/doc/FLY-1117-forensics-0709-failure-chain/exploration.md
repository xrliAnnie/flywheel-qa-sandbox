# FLY-1117 2026-07-09 全天故障链深挖 — 探索

Issue: FLY-1117 (https://linear.app/geoforge3d/issue/FLY-1117/forensics-2026-07-09-全天故障链深挖-1427-fleet-全灭-夜间-bridge-双杀攻击-or-系统性)
日期: 2026-07-10
基于: 无（本单第一份文档；输入 = Annie 直令 2026-07-09 23:59 PT + FLY-1082 同文件夹四份文档 + 本单预审计实测）

---

## 1. 任务本质

这不是 feature build，是**证据级取证调查**。Annie 的核心问题只有一个：**「到底是什么把 runner 全关掉了？是不是攻击？」** 她已明确质疑既有解释（「感觉也不是内存的问题，当时用电脑并没有变慢」）。所以本单的交付物是**结论**（凶手/机制/置信度 + 攻击 vs 系统性 bug vs 资源的最终判定），不是代码。三段式流水线在本单的映射：

- **Design（本阶段）** = 摸清证据面 + 锁定调查方法 + **保全易失证据** + 写出可执行的调查计划
- **Implement** = 执行完整调查 → 出结论 → 写 founder 可读报告（HTML）→ 防复发建议
- **QA** = 独立复核证据链（每个结论都能从原始证据复推）

## 2. 三起事件（issue 原文 + 预审计修正）

| # | 事件 | issue 描述 | 预审计修正/补充 |
|---|---|---|---|
| E1 | 14:27 PT fleet 全灭 | tmux server 死 → 30+ runner 阵亡；旧解释「swap 打满压死 tmux」存疑（零 JetsamEvent） | 死亡窗口精确锁定 **14:26:41–14:27:43**（见 §3.1）；同机第二个 tmux server（`-L atlas`）**幸存** |
| E2 | 夜间 Bridge SIGKILL ×2 | 第二次 23:29:14，exit 137，launchd 拉回 | launchd 实证 `last exit code = 137`；现任 Bridge 起于 23:29:59；**第一次的时间还未定位** |
| E3 | OrcaSlicer 连崩 | 今晚 22:26–22:30 连崩 5 次 | 实际**全天 ~17 次**（11:32 起：20:42×2、21:11–21:13×4、22:08–22:30×10）——比 issue 描述严重得多 |

## 3. 预审计已确认的事实（全部有实测证据）

### 3.1 E1 的分钟级实测画面（`~/Library/Logs/system-health/2026-07-09.log`，60s 快照）

| 时刻 (PDT) | load(1m) | 进程总数 | Pages free (16KB/页) |
|---|---|---|---|
| 14:22:34 | 24.71 | 1369 | 5,230 (≈82MB，全天最低) |
| 14:23:36 | **66.38** | 1323 | 49,842 |
| 14:25:39 | 51.55 | 1413 | 28,077 |
| 14:26:41 | 78.22 | **1425** | 17,212 (≈269MB) |
| 14:27:43 | 111.58 | **828** | **1,513,794 (≈23GB 瞬间释放)** |
| 14:28:44 | **154.99**(峰值) | 974 | 124,644 |
| 14:30:44 | 27.04 | 910 | 363,108 |

**读法**：~600 个进程在 14:26:41–14:27:43 之间集体消失（tmux server 之死带走全部子进程树），23GB 内存瞬时回收。死亡前一分钟内存确实紧张（269MB free）但**不是全天最低点**（14:22 更低却没死）；真正异常的是 **load 从 51→78→111 的陡峭爬升**。机器本身未重启（uptime 连续「up 10 days」）。当前 `flywheel` tmux session 由某方于 **14:27:44** 重建（ps lstart 实证）。

### 3.2 关键旁证：atlas tmux server 幸存

`tmux -L atlas`（Mufasa growth，pid 1453，Jun 28 起）**活过了 14:27**。这一条同时约束两类假说：
- **反证宽模式扫杀**（如 `pkill tmux` / `pkill -f tmux` 会两个都杀）；
- **兼容** jetsam 按内存占用挑选（default-socket server 树大得多）、tmux server 自身 crash/abort、或**只针对 default socket 的精确 kill**。

### 3.3 E2 Bridge 死因入口

- launchd `com.flywheel.bridge`：`last exit code = 137`（SIGKILL 实锤，不是 exit(1) 也不是 SIGTERM）。
- Bridge stdout/stderr 全落 `/tmp/flywheel-bridge.log`（358MB，跨重启追加）——重启边界、死前最后输出可从中重建。
- 14:27 那次 Bridge 之死与夜间双杀**机制不同**：FLY-1082 记录 14:27 是 StateStore `sql.js corruption unrecoverable … out of memory — exiting`（进程内 alloc 失败自杀，exit(1)），夜间是外部 SIGKILL。**「谁发的 SIGKILL」是 E2 的核心问题**。
- 时间重叠警示：FLY-1082 的 QA 真机 E2E 恰在 23:27 前后运行（qa-report.md 自称全侧信道隔离、只 kill 自己的隔离 tmux server `qa-fly1082-*`）。issue 已让其自查 23:25–23:30 命令清单，结果需并入本单（在 Linear FLY-1082 评论里找）。

### 3.4 E3 与「同机不稳定」旁证

OrcaSlicer 全天 ~17 崩（user 域 .ips 齐全可逐份读）；另有 BambuStudio 崩（00:26）、biome 崩（17:29）、node 崩（19:43 user 域 .ips）+ node .diag 资源报告（15:14、15:57 system 域）、chrome-headless-shell 崩（21:18）。7 月 9 日**零 JetsamEvent**（系统域最近一份 7 月 6 日）——「jetsam 是否总留报告」需查证 macOS 行为（unified log 的 memorystatus 记录是更可靠的一手证据）。

### 3.5 证据可得性（决定计划可行性的硬前提）

| 证据源 | 状态 | 备注 |
|---|---|---|
| macOS unified log | ✅ **覆盖 14:27 窗口**（catch-all 探针有数据，已见 14:27:00.193 loginwindow 记录 node appDeath） | **易失！随写入量滚动删除**，必须在 research 阶段第一时间全量导出两个窗口 |
| system-health-log | ✅ 60s 快照全天完整 | 无 swap 水位字段（「16384MB 用 14815MB」的出处待考） |
| DiagnosticReports | ✅ 双域清单已取 | 零 JetsamEvent 本身是证据 |
| /tmp/flywheel-bridge.log | ✅ 358MB 跨重启 | /tmp 重启即失，也应保全关键段 |
| launchd 作业清单 | ✅ 已全量枚举 | 见 §4 嫌疑人矩阵 |
| FLY-1082 四份文档 + QA 报告 | ✅ 已读 | QA 命令清单自查在 Linear 评论待取 |
| 3dcb1b94 scratchpad（幻觉注入证伪） | ❓ 预期路径未找到 | research 阶段深挖（`~/.claude/projects` / 其他 tmp 根） |
| sudo 权限 | ❌ 假定不可用 | `log show` 无需 sudo；放弃需要 root 的取证面（/var/audit 等），在报告里声明盲区 |

## 4. 假设空间：每起事件的凶手候选矩阵

### E1（tmux server 之死）候选

| 候选 | 支持证据 | 反对证据 | 判别性检验（research 执行） |
|---|---|---|---|
| H1 内核 jetsam/memorystatus 杀 | 内存紧张属实；jetsam 挑大户（default server 树最大）与 atlas 幸存兼容 | 零 JetsamEvent 报告；死前一分钟 free 在回升 | unified log `memorystatus`/`kernel` 子系统在窗口内的 kill 记录（有=实锤，无+查证「jetsam 必留痕」=排除） |
| H2 tmux server 自身 crash（malloc 失败/abort/bug） | 高压环境下进程自身崩溃常见 | 无 tmux 的 .ips crash 报告 | unified log 中 tmux 的 exit/crash 记录、ReportCrash 活动；查证「crash 报告是否可能因资源耗尽而写不出来」 |
| H3 某自动化脚本误杀（kill/pkill 模式过宽） | 全机存在大量 kill 能力自动化（§4.3）；14:27:44 立即有人重建 session（说明有自动化在现场活动） | atlas 幸存反证宽模式；14:27 无已知 deploy/restart 记录 | 逐嫌疑人 alibi：当时是否活跃（unified log/各自日志）+ kill 模式静态审计 |
| H4 外部入侵者手动杀 | 无（Annie 的担忧，需正面排查而非默认排除） | 需要入侵路径；无已知远程访问迹象（待查） | §5 攻击面核查整体回答 |
| H5 load 风暴连带（fd 耗尽/调度饿死→server 异常退出） | load 66→111 陡升实测；14:23 `npm install` 进大户榜 | server「异常退出」仍需一个具体机制 | unified log 中 tmux server 退出码/信号；当时 fd/spindump 类记录 |

### E2（夜间 Bridge SIGKILL ×2）候选

| 候选 | 支持/反对 | 判别性检验 |
|---|---|---|
| H1 jetsam SIGKILL | 夜间内存水位待查（health-log 有数据）；jetsam kill 通常在 unified log 留 memorystatus 记录 | 窗口 log + health-log 水位 |
| H2 部署/重启脚本 kill（`pgrep -f run-bridge \| xargs kill -9` 是本机已知 workaround；restart-services.sh:523 已知 bug） | issue 称最后部署是 7/8 14:51——但**手动/agent 重启不一定更新 deployed-sha**；当晚确有 in-flight 的「Batched Tier-3 restart」计划（team-lead 任务 #128） | bridge.log 重启边界上下文；当晚各 Lead/agent 会话是否有人跑过 kill；deployed-sha 与 git 状态核对 |
| H3 FLY-1082 QA 误杀 | QA 自称隔离且报告里只 kill 隔离 socket；但时间窗精确重叠（23:27 运行 vs 23:29:14 被杀） | QA 命令清单自查（Linear）+ 其 harness 源码静态审计（kill 目标推导） |
| H4 外部入侵者 | 同 E1 H4 | §5 |
| H5 launchd 自身（如 job 限额/bootout） | launchd bootout 发 SIGKILL 前通常先 SIGTERM；需查 | unified log launchd 对该 job 的完整事件序列（这也是「macOS 不记 signal 发送者」的最大例外：**launchd 自己的动作有日志**） |

### E3（OrcaSlicer 等连崩）

先读 .ips 判崩溃性质（同一崩溃点 = 应用自身 bug；随机地址/内存类 = 系统性资源压力旁证；异常注入痕迹 = 攻击旁证）。E3 的角色是**旁证**，不是主案。

### 4.3 kill 能力自动化嫌疑人清单（已枚举，research 逐个 alibi）

`com.flywheel.cmux-watcher`、`com.flywheel.updater`（日程 6am）、`com.flywheel.bridge` wrapper、`com.flywheel.skills-update`、belle `keepawake/daymode/nightmode`、growth-* 定时任务、`com.macpaw.CleanMyMac2Helper.scheduledScan`（第三方清理软件！）、`com.user.system-health-log`（只读，白）、cron `daily-permission-learn`（0:00）、repo 内 `restart-services.sh` / `test-deploy.sh`（QA Room）/ crash-reaper / close-tmux/close-runner actions / FLY-887 keep-alive / FLY-873 cmux-sync watcher、以及当晚活跃的各 Runner/Lead session 的 Bash 历史。每个查两件事：**①当时活跃吗（日志/launchctl 状态）②kill 模式静态审计能否误中 tmux server 或 Bridge**。

## 5. 攻击面核查（正面回答 Annie 最担心的）

范围（无 root、无 EDR 的诚实边界内）：
1. **远程访问**：`last` + unified log sshd/screensharingd/远程 Apple Events；SSH `authorized_keys` 改动时间；Remote Login/Screen Sharing 当前开关状态。
2. **持久化**：launchd 双域 job 清单逐个认领（§4.3 已枚举，找「陌生 job」）；cron；login items；chezmoi auto-sync 的 diff（配置被外部改动会留 git 痕迹）。
3. **账号面**：GitHub（`gh api` events/audit：非我们发起的 push/PR/token 使用）、Linear（issue/comment 由陌生 actor 创建）、Discord（bot token 滥用迹象 = 非预期消息/频道操作）。
4. **进程来源异常**：两个窗口 unified log 里的 exec 记录里找非预期二进制路径。
5. **网络**：历史连接基本无记录（诚实声明盲区）；当前监听端口/连接 snapshot 作为现状基线。
6. **已证伪的「runner 幻觉注入」事件**（3dcb1b94 scratchpad）作为输入复核其证伪逻辑。

产出 = **「有/无外部入侵迹象」的明确结论 + 每项检查的证据 + 声明的盲区**。

## 6. 方案空间：调查执行放哪个阶段

- **方案 A：design 只写计划，Implement 做全部取证。** 否——unified log 随写入量滚动（本机日志量巨大，358MB bridge log 一天），等 Implement 可能证据已灭失。
- **方案 B：design 阶段做完全部调查，Implement 只写报告。** 违背三段式的阶段边界，design review 也没法审「已做完的调查」的方法论。
- **方案 C（推荐）：research 阶段 = 证据保全 + 初步判定；Implement = 深挖收尾 + 结论 + 报告。** 具体：research 立刻全量导出两个窗口的 unified log 到 evidence 文件（连同 bridge.log 关键段、health-log 全天、.ips 清单快照，落 `evidence/` 子目录随分支提交；单文件过大则精选+压缩），跑完 §4 的判别性检验中「快」的那部分，形成初步凶手判定写进 research.md；plan.md 给 Implement 留：慢检验（逐嫌疑人 alibi 全覆盖、攻击面全清单、jetsam 行为查证）、结论收敛、防复发建议、founder HTML 报告。

## 7. 产出物设计

1. **完整时间线**（全天，分钟级骨架 + 两窗口秒级细化）— research.md 起草，Implement 定稿。
2. **逐事件结论**：凶手/机制/置信度（高/中/低 + 依据）。
3. **最终判定**：攻击 vs 系统性 bug vs 资源——允许复合结论（如「资源压力为主因 + 某自动化为直接执行者 + 无入侵迹象」），但必须明确、可辩护。
4. **防复发建议**：区分「FLY-1082 已 ship 的检测已覆盖」（如 tmux_server_lost/bridge_abnormal_exit/swap 预警——下次直接留现场）vs「需新做」（如 signal 发送者取证钩子、swap 水位入 health-log、嫌疑人 kill 模式收紧）。
5. **founder 可读 HTML 报告**：Implement 阶段产出、committed 进 repo；**投递纪律 = Runner 不 publish、不直接发 founder**，素材/链接经 `flywheel-comm ask` 交 Tadashi 投（feedback_founder_artifacts_lead_only_delivery 终裁版）。

## 8. 边界与假设清单（gate 前显式亮出）

- A1：本单**零生产代码改动**——纯调查 + 文档 + HTML 报告。防复发建议只到「建议 + 建单素材」粒度，落地归各自新单。
- A2：证据保全在 **research 阶段立刻做**（方案 C）——这是对「易失证据」唯一诚实的处理；evidence 文件随分支提交（过大则精选，原始全量留本地固定路径并在文档记路径+sha256）。
- A3：无 sudo/root。放弃 /var/audit、内核级取证；`log show` 用户态可读已覆盖主要需求。盲区如实写进报告。
- A4：攻击面核查按 §5 清单执行；「无入侵迹象」结论的置信度受限于 macOS 默认不记 signal 发送者 + 无历史网络记录，报告中明示。
- A5：不打扰生产系统：只读取证，不重启任何服务、不杀任何进程、不碰生产 DB（SQLite 只读打开或拷贝后读）。
- A6：HTML 报告 = Implement 产物；投递走 Lead（A1 纪律）。
- A7：FLY-1082 QA 的 23:25–23:30 命令清单自查结果从 Linear FLY-1082 取回并入 E2 判定。

## 9. Brainstorm gate 结果（Tadashi，2026-07-10）

**APPROVED —— 按方案 C 开跑**，四点注入：

1. 证据保全提前到 research = 对，易失 unified log 立刻导。
2. **E2 重大新证据**：FLY-1082 的 QA（session b07cb39a）已答复 Tadashi 质询，承认 **23:28:37 在生产 host 后台启动全量 teamlead vitest（20+ 进程），37 秒后内存打爆，Bridge 23:29:14 被 SIGKILL**。其如实报告 + 命令清单在 FLY-1082 worktree 的 `engineering/doc/FLY-1082-fleet-alerts-arc-repair/incident-bridge-2329-analysis.md`（随该分支 commit）。并入 E2：**第二刀高度疑似由此触发**，但仍需本单用 unified log memorystatus 独立钉死机制（jetsam 不总留 .ips 的查证正好覆盖）；**第一刀是否同机制需单独解释**。
3. E1 预审计发现（进程 1425→828、23GB 瞬释、pages-free 非全天最低、atlas tmux 幸存反证宽 pkill）很关键——Annie 的直觉「不是单纯内存」正等这个级别的解释，凶手/机制置信度务必可辩护。
4. A1–A5 全批（零生产改动/只读/无 sudo 盲区如实写）。防复发建议里记一条已定的：**生产 host 禁跑全量测试套件**。founder HTML 素材经 ask 交 Tadashi 投递。
