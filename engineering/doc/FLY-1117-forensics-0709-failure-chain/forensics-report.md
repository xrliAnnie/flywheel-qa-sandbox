# FLY-1117 2026-07-09 全天故障链深挖 — 取证报告(终判)

Issue: FLY-1117 (URL 不可得,只写 issue 号)
日期: 2026-07-10
基于: research.md(同文件夹;其上游 exploration.md、plan.md)

> **可复推性合同**:本报告每个结论都能从同文件夹 `evidence/` 复推。证据完整性:`cd evidence/ && shasum -a 256 -c SHA256SUMS.txt` 全绿;来源与命令见 `evidence/INDEX.md` 与 `evidence/transcripts/`。时间一律 PDT(watchdog log 原始时间戳为 UTC,PDT = UTC−7)。
> **主机事实**:Apple Silicon Mac(内核 ARM64_T6050;取证 shell 跑在 Rosetta 下故 `uname -m` 报 x86_64),macOS 26.3.2,事故日不间断运行(up 11 days)。

---

## 0. 终判(一段话版)

**未发现任何外部入侵迹象。issue 点名的三起现象要拆成两类**:
- **E1(14:27 fleet 全灭)+ E2(夜间 Bridge 多杀)= 同一个容量/护栏问题**。在 30+ runner(每个 0.4–0.6GB)已把内存吃到贴地的生产 host 上,**三个互不相干的工作流各自跑了全量构建/测试扇出**(14:2x = FLY-1062 打包管线含两次全量 vitest;21:30 = FLY-1018 runner post-rebase 全量 vitest;23:28 = FLY-1082 QA 全量 vitest),每次都在数十秒内把机器推进 load 风暴/内存饥饿。这三次扇出对应的是 **E1 + E2 的三刀**(14:2x→第 1 杀 + E1;21:30→第 5 杀;23:28→第 6 杀);Bridge 的 event-loop 看门狗当天按设计自杀 6 次,而 14:27 那次危机的极端形态压垮了承载全部 runner 的 tmux server(与资源耗尽下 tmux `fatalx→exit(1)` 零痕迹退出相容的最佳解释,无直接观测)。
- **E3(OrcaSlicer ~18 崩)= 独立的应用自身 bug 簇,与机器稳定性/容量/攻击均无关**,只是时间上与 E1/E2 之外的晚间时段共现(§4)。它不属于上面的容量模式,也不该由 fleet 检测覆盖。

攻击维度的结论是**「未发现与这些事件相关的外部入侵迹象」**(60 天登录记录全本地、SSH 信任面一年未动、持久化无异动、事故窗口无未知二进制、崩溃报告零注入 image;在无 EDR/auditd/历史连接记录的机器上不存在「证明无入侵」,盲区如实声明于 §9)。

置信度:E2 六杀机制 = **高**(逐刀双源同秒对齐);E1 tmux 死亡机制 = **中高**(相容最佳解释,无直接观测);三次触发行为的指认 = 第 5/6 杀**高**、14:2x 扇出行为存在性**高**(其对 E1 的因果贡献 = 中高);「无外部入侵迹象」= **高**(在本机可得数据源范围内)。

---

## 1. 全天时间线(修订定稿)

| 时刻 (PDT) | 事件 | 证据 |
|---|---|---|
| 00:26 | BambuStudio 崩(headless 切片,近空指针,应用 bug) | evidence/ips/ + transcripts/e3-ips-classification.md |
| 06:05:41 | Bridge 例行重启(每日 updater 窗口) | bridge-restart-history-linenos.txt |
| 11:32 | OrcaSlicer 当日第 1 崩(SIGABRT,/private/tmp 安装位单例) | e3-ips-classification.md |
| 12:51 | FLY-886 激活:growth-*/sub-* plist 簇改写(.bak-fly886 备份) | transcripts/bridge-launchd-plist.txt(LaunchAgents mtime 全景) |
| 12:59:16 | 生产 checkout `pull --ff-only` → bc9c9bfb | transcripts/deployed-sha-and-prod-checkout.txt(reflog) |
| **13:09:18/56** | **Bridge 主动重启 ×2**:边界前有 `Shutting down...` + `close() exceeded 20000ms — forcing exit(1)`(优雅关闭签名);首 boot 无遗言死于启动后 ~38s,38s 后节流 respawn(ThrottleInterval=30)——与 restart-services.sh 的 TERM→kickstart 编排相容;窗口动机 = FLY-886 配置采纳(`ConfigSnapshotProvider structural change … restart the Bridge to adopt it` 在 shutdown 前反复出现) | bridge-seg-130918-pre.log |
| 14:20:26–14:22:53 | FLY-1062 打包管线开跑:`npm pack` ×2、测试 Bridge boot(`npm exec tsx scripts/run-bridge.ts`)、`npm install <payload.tgz>` | transcripts/e1-lifecycle-rebuild.txt(启动台账) |
| **14:23:07** | **全量 vitest #1(`npm exec vitest run` 无参数)**;14:23:1x–14:23:5x 出生风暴 ~361 进程/50s(vitest workers + tsc 等) | 同上 + CHECKIN 出生曲线 |
| 14:22:34–14:23:36 | Pages free 5,230(≈82MB,全天最低)→ load 24.7→**66.38**;top-RSS 见 npm install | system-health-2026-07-09.log.gz |
| 14:24:30–14:24:55 | 定向 vitest 批(fly1050 QA 测试等)+ 第二个测试 Bridge boot | e1-lifecycle-rebuild.txt |
| **14:25:13** | **全量 vitest #2** | 同上 |
| ~14:25:19 | Bridge 主循环停跳(= 14:26:20 − 61.3s;全量 #2 启动后 6 秒) | bridge-watchdog-log-snapshot.log 倒推 |
| **14:26:20** | **看门狗第 1 杀**(stall 61.3s → SIGKILL 自身);wrapper 同秒重启 | watchdog log(21:26:20Z)+ restart-history |
| 14:26:40–14:27:13 | **滴漏 123 死/33s(加速 1→8 个/秒)——修订:全部是窗口内新生进程(churn),不是长命 runner** | e1-death-join-table.txt(123/123 BORN_IN_WINDOW) |
| 14:27:12 | cmux-sync 最后一次在旧 tmux server 上成功挂 hooks | cmux-watcher-incident-window-0709.log |
| **≈14:27:13–14** | **默认 socket tmux server 倒下** | 雪崩起点 |
| 14:27:14–21 + 14:27:42 尾 | **雪崩 145 死(核心 143 于 14:27:14–21 的 8s + 尾 2 于 14:27:42)——其中 106 个是 14:20 前出生的长命进程(与 runner 大军一致;个体身份不可反查,见 §3 覆盖率声明),39 个窗口内新生** | e1-death-join-table.txt(39 BORN + 106 PRE_EXISTING = 145) |
| 14:27:43 | Pages free 1,513,794(≈23GB 瞬释);load 111.58;进程数 1425→828 | health-log |
| 14:27:44 | cmux-autostart 重建 `flywheel` session;14:28:25 三 session hooks 全部回归 | cmux-watcher log |
| 14:28:44 | load 峰值 154.99,此后回落 | health-log |
| **14:40:37/14:41:08** | **Bridge 主动重启 ×2**(同 13:09 优雅关闭签名;恢复期采纳 14:14 新建的 claude-infra-bot-lead 配置——boot 后 RuntimeRegistry 15→16) | bridge-seg-144037-pre.log |
| 14:51:42 | deployed-sha 写入 bc9c9bfb(部署脚本收尾) | deployed-sha mtime |
| 15:14/15:57 | node .diag 磁盘写入资源通告(非崩溃;两段共 ~10.7GB 写入) | e3-ips-classification.md |
| 17:29 / 19:43 | biome SIGABRT(单例)/ **node V8 FatalProcessOutOfMemory(当日唯一有实证的资源型崩溃)** | 同上 |
| 18:14–18:24 | load 风暴 50→84→91→**102**;Pages free 反复贴地(3,791 页≈60MB);top-RSS = 30+ runner ×~500MB + Discord ~1GB,无单一异常进程 | health-log 18:1x 段 |
| **18:16:58 / 18:23:24** | **看门狗第 2、3 杀**(风暴中两次 stall>60s) | watchdog log + restart-history 同秒 |
| 20:42–21:13 | OrcaSlicer 崩溃簇第一波(SIG-A 签名 ×6,自动化切片任务) | e3-ips-classification.md |
| **21:03:41** | **Bridge 主动重启**(同优雅关闭签名;boot 修复了 agent-team-transport 指向 FLY-1048-pr-c worktree 的 stale symlink) | bridge-seg-210341-pre.log |
| 21:08–21:13 | load 24→51→**62** 突升,与 OrcaSlicer 崩簇同窗 | health-log |
| **21:12:45** | **看门狗第 4 杀**(触发者未唯一指认;上下文 = load 突升 + 崩簇共窗) | watchdog log |
| 21:28:09–21:28:14 | FLY-1018 runner 跑定向 teamlead 测试批(ship-approval-route + 8 文件批) | catchall-2128-2136-raw.log.gz |
| **21:30:11** | **全量 vitest #3(`npm exec vitest run` 无参数)= FLY-1018 runner post-rebase 验证**(归属三证:21:09:25 该分支 commit 改 ship-approval-route 测试、21:36:35 post-rebase hygiene commit 只在 flywheel-FLY-1018 分支、21:30:50 top-RSS 首位是 FLY-1018 scratchpad node 进程) | transcripts/kill5-* ×3 |
| ~21:34:22 | Bridge 主循环停跳;21:34:55 top-RSS 见 vitest workers(pid 68874/68975,各 ~450MB);load 42→**66** | health-log + watchdog 倒推 |
| **21:35:23→24** | **看门狗第 5 杀**;launchd `ran for 6875094ms` 倒推前任出生 = 本秒,闭环 | watchdog log + launchd 导出 |
| 21:38–翌日 00:20 | ReportSystemMemory 周期报告开始;21:41 起 jetsam kill 行——**全部是 Apple 遥测/系统 daemon 的 per-process-limit/idle-exit,零 fleet 进程** | transcripts/step5-memorystatus-classification.txt |
| 22:08–22:30 | OrcaSlicer 崩溃簇第二波(SIG-B/C ×11) | e3-ips-classification.md |
| 22:42:53–57 | 生产 checkout pull → 5c6c14f0(FLY-1062 ship 后动作;Bridge 未随之重启) | reflog |
| 23:14–23:27 | FLY-1082 QA 窄范围测试 + 隔离 E2E(其自查报告,本单独立复核一致) | FLY-1082 incident-bridge-2329-analysis.md |
| **23:28:37** | **全量 vitest #4 = FLY-1082 QA 后台全量 teamlead 套件(20+ worker)** | 同上(自认)+ catchall-2325 slice |
| 23:28:48 | Pages free 5,097(≈80MB,临界) | health-log |
| ~23:28:56 | Bridge 主循环停跳(vitest 启动后 19 秒) | watchdog 倒推 |
| **23:29:59** | **看门狗第 6 杀**;launchd 同秒记 `exited due to exit(137)` → respawn 现任(48951,存活至今) | watchdog + launchd 双证 |

> 澄清:issue 里的「23:29:14」与「双杀」均不精确——权威时刻 23:29:59,当日看门狗共开火 **6 次**。看门狗史(6/19 起 16 行)显示该机制平日约每 1–2 天开火一次,7/9 单日 6 次即「异常之处是频率,不是机制」。

## 2. E2 定案 — Bridge 六杀对齐表(机制/触发分列)

**机制(全部 6 刀,置信度:高)**:`BridgeEventLoopWatchdog`(部署源 bc9c9bfb,`packages/teamlead/src/bridge/BridgeEventLoopWatchdog.ts`)独立 worker 线程监测主循环 Atomics 心跳,停跳 >60s → best-effort 写 forensic 行(`appendFileSync` in try/catch,transcripts/watchdog-source-bc9c9bfb.txt 第 88 行)→ `process.kill(process.pid, "SIGKILL")`(第 106 行)→ launchd KeepAlive 拉活。6 条 forensic 行与 6 次 wrapper 重启逐条同秒对齐。**这是 by-design 自愈,不是外部攻击。**

**源码级事实(按证据修正研究稿)**:
1. **进程树修正**:wrapper 末行 `exec npx tsx scripts/run-bridge.ts` 把 bash 替换为 npm 进程(launchd 跟踪的 PID),真正的 Bridge node(tsx)是 npm 的**子进程**(实测:launchd pid 48951 = `npm exec tsx`,其子 49074 = node/tsx run-bridge.ts)。watchdog SIGKILL 的是 Bridge node 本体;npm 父进程把子进程的 signal-9 死亡折算为 exit code 137 上报 launchd——**存在一层退出码传播,但 137 仍唯一对应 Bridge 本体被 SIGKILL**,`ran for` 计时闭环不受影响。(transcripts/bridge-process-tree-and-watchdog-source.txt)
2. **forensic 行 best-effort 确认**:写入被 try/catch 吞——「有行」是强正证据,「无行」不构成单独绝对排除。另一自洽细节:worker 的 console.error 需经主线程 stdout 管道,而主循环正 stall,故 bridge.log 永远看不到看门狗遗言——与 6 次死亡前日志静默完全一致。

| 刀 | 时刻 | 机制置信度 | stall 起点(倒推) | 触发者/上下文 | 触发置信度 |
|---|---|---|---|---|---|
| 1 | 14:26:20 | 高 | ~14:25:19 | **E1 危机本身**(全量 vitest #2 启动后 6 秒开始停跳;npm install + 扇出风暴 + fleet 底载) | 中高 |
| 2 | 18:16:58 | 高 | ~18:15:57 | fleet 容量饱和风暴(load 44→52,Pages free 12k→3.8k 页;top-RSS 全是常规 runner)——**无单一触发者可指认** | 中 |
| 3 | 18:23:24 | 高 | ~18:22:21 | 同一场风暴延续(load 93→102) | 中 |
| 4 | 21:12:45 | 高 | ~21:11:40 | load 24→51→62 突升,与 OrcaSlicer 崩簇(21:11–21:13 ×4)同窗——**未唯一指认**(共现不下因果) | 中低 |
| 5 | 21:35:23 | 高 | ~21:34:22 | **21:30:11 全量 vitest(FLY-1018 runner post-rebase 验证)**;stall 时刻 top-RSS 实见其 workers | **高** |
| 6 | 23:29:59 | 高 | ~23:28:56 | **23:28:37 全量 teamlead vitest(FLY-1082 QA,自认+独立证实)**;Pages free 80MB | **高** |

**三组非看门狗重启定因(13:09×2 / 14:40×2 / 21:03,置信度:中高)**:三组边界前**全部**带同一优雅关闭签名(`[run-bridge] Shutting down...` + `[GatePoller] Stopped` + `close() exceeded 20000ms — forcing exit(1)`)= 主动运维重启,各有配置采纳动机(13:09 = FLY-886 迁移 + config structural change 提示;14:40 = 事故恢复 + 采纳 claude-infra-bot-lead;21:03 = 修 FLY-1048-pr-c stale symlink)。**双起机制**:restart-services.sh(部署版 7/9 06:06)的编排 = TERM 旧进程 → launchd KeepAlive 立即拉起新 boot → 脚本随后 `kickstart -k`/kill 该新 boot 完成干净重启 → ThrottleInterval=30 节流后二次 respawn(首 boot 无遗言死亡 + 38s/31s 间隔与此相容;launchd 类目日志已滚,无法直接观测编排每一步——如实声明)。**与「谁杀了 Bridge」无未解之谜。**

## 3. E1 定案 — tmux server 之死(置信度:中高;相容最佳解释,非直接观测)

**机制措辞(红线版)**:tmux server 之死**与系统级资源耗尽危机中 tmux 自身 fatal 路径退出相容,为无直接观测下的最佳解释**(不含退出码/signal/发送者的任何直接观测)。tmux 3.5a 源码级事实(逐字引文见 `transcripts/tmux-35a-fatal-path-source.txt`,经 WebFetch 取自 tmux/tmux tag 3.5a 的 xmalloc.c/log.c;本机安装二进制对应该 tag,sha256 见 tmux-binary-forensics.txt):三个分配包装(xmalloc/xcalloc/xreallocarray)分配失败均 → `fatalx("x…: allocating %zu bytes: %s", …)` → `exit(1)`;且 log_level=0(默认,未加 -v)时 `log_vwrite` 开头 `if (log_file == NULL) return;` **什么都不写**——干净退出(非信号非 abort,不产 .ips)、零 crash 报告、零日志,与「没有任何 tmux 死亡记录」完全相容。研究稿中 `fatal("out of memory")` 的措辞按上述准确引文更正(无泛化 "out of memory" 字符串)。

**证据链(含修订)**:
1. **死亡形状(修订版)**:滴漏段 123 死/33s 的死者**全部是 14:20 后出生的短命进程**(出生 2 秒~4 分钟;出生风暴 ~361 个/50s 与死亡同窗 = 高压 churn,出生率一度超过死亡率——进程总数 1413→1425)。雪崩段 145 死(核心 143 于 14:27:14–21 + 尾 2 于 14:27:42)中 **106 个是窗外(14:20 前)出生的长命进程**——与「宿主倒下带走 runner 大军」一致,但**这 106 个只能证明「14:20 前已出生」,无 pid/父进程/所属 runner 的直接身份**(死亡记录不含 pid,窗外出生者无窗内 CHECKIN 可反查)——个体是否 runner 属推断,如实声明。该形状反对一次性批量扫杀(瞬时不呈 33 秒加速滴漏),且滴漏死者是新生儿而非被扫射的老进程——与「资源饥饿下 spawn/子进程大批夭折 + 宿主最终倒下」相容。(e1-death-join-table.txt,268/268 全分类:滴漏 123 全 BORN_IN_WINDOW;雪崩 145 = 39 BORN + 106 PRE_EXISTING。身份反查覆盖率:窗口内出生的 162 个可反查 pid,窗外出生的 106 个不可反查)
2. **atlas 反证**:`-L atlas` socket 的第二个 tmux server 及其进程全部幸存——任何按名字/模式的宽杀无法解释。
3. **jetsam 排除(阳性对照加固版)**:全天 memorystatus 导出内,**所有** jetsam kill 行(309 条)都在 21:38–翌日 00:20、全部来自 ReportSystemMemory(CoreDiagnostics)、目标全部是 Apple 遥测/系统 daemon(spotlightknowledged 118、ecosystemanalyticsd 59 等)的 per-process-limit/idle-exit——**零 pressure 类、零 fleet 进程**;14:00–15:00 窗口零 kill 行,同导出晚间对同类记录捕获正常(阳性对照)。限定:导出捕获面是用户态 daemon(零 kernel: 行),负证据受 unified log 类目滚动约束;措辞维持「该窗口内本谓词无 memorystatus kill/快照记录」。
4. **JetsamEvent 缺失之谜解除(本机实证)**:7/9 有 300+ 条 jetsam kill 行但**零** JetsamEvent 报告落盘(最近一份 7/6)——本机直接证明 jetsam kill 不必然产生 JetsamEvent 报告;「零 JetsamEvent」不携带任何信号。
5. **内存/负载实测**:14:22 Pages free 82MB(全天最低)→ 扇出风暴 → load 66→78→111 → server 倒下瞬间 23GB 释放。swap「16384MB 用 14815MB」查明**只有一个出处**(FLY-1082 exploration §1 叙述行,无时间戳/命令/测量者)→ 降级为二手转述;当晚 23:30 前后倒是有 QA 的同期测量(92.1%,16977/18432M)。
6. **Bridge 无嫌疑 / 全机自动化无嫌疑**:见 §5 嫌疑人矩阵——静态审计无任何主体具备打中默认 tmux server 的杀伤面。
7. **残余不确定性(不变)**:tmux server 的退出没有任何直接记录;「资源耗尽 → fatalx 干净退出」是从死亡形状+幸存者+排除法收敛的推断。无法 100% 排除某未留痕进程对 server 发信号,但没有任何证据支持该方向,且滴漏形状与 atlas 幸存均反对。

**根因层(更新)**:14:22–14:27 的内存耗尽不是缓慢泄漏,而是「fleet 底载(30+ runner ≈15GB+)+ FLY-1062 打包管线(npm pack/install + 测试 Bridge)+ **两次全量 vitest 扇出**」的叠加瞬时冲击。**这与第 5、6 杀是同一行为模式**——全量构建/测试在生产 host 上扇出。三次,三个不同行为体(FLY-1062 管线 / FLY-1018 runner / FLY-1082 QA),证明是**系统性纪律/护栏缺口**,不是某个 agent 的个例失误。

## 4. E3 定案 — 27 份崩溃/资源报告(置信度:高)

全量逐份解析(transcripts/e3-ips-classification.md,分类总表+签名聚类在内):**21/24 = 应用自身 bug**(OrcaSlicer 18 份含 17 份 SEGV 聚成 3 个高重复近空指针签名 + 1 份启动早期 SIGABRT 单例,全部落在 filament flush-volume/tool-ordering 代码族的 headless CLI 切片调用;BambuStudio 1 份同源同族;chrome-headless-shell 2 份孪生 CHECK-crash;共 18+1+2=21);**1 份资源实证**(node 19:43 = V8 FatalProcessOutOfMemory,当日内存压力的独立正证据);**注入/攻击旁证 = 0**(24 份 usedImages 逐份核查无未知 provenance);2 份单例未归桶(Google Chrome GUI abort + biome)。24 = 21 + 1 + 2。(注:e3-ips-classification.md 子 agent 报告 §⑥ 写「20/24」系把 chrome-headless-shell 两份孪生并计为一,实为 21——此处按逐行分类修正。)关键再定性:**全部崩溃进程隶属 Flywheel bridge/cos-lead coalition——OrcaSlicer「连崩」其实是我们自己的自动化切片任务反复撞同一个应用 bug**,与「同机不稳定」无关,更与攻击无关。3 份 .diag 是磁盘写入通告(非崩溃),只作当日 I/O 高压共现描述。

## 5. 嫌疑人矩阵(附录 A) — 全部 kill 能力自动化逐项 alibi

五列:①两窗口活跃证据 ②实际执行体(mtime/sha 见 transcripts/step3-*-batch1/2.txt) ③终止命令清单 ④能否误中默认 tmux server / Bridge ⑤结论。静态审计方法:对每个执行体全文 grep 终止动词(kill/pkill/bootout/kickstart/kill-server/-session/-window/SIGKILL/SIGTERM),逐条人工判读目标推导。**下表 exploration §4.3 全部枚举项各占一行、一个不省**。
**两个合同点的统一声明**(避免逐行重复):(a)**两窗口各答一次**——凡 ① 标「日程 + 两窗口非日程」的定时任务,即表示 14:2x 与 23:2x 两个事故窗口**均非其触发时段、均未运行**(launchctl 记录的 last-exit 时刻与日程佐证),两窗口同答「未触发」;运行时活跃性无法确证的按 **unknown** 标注(如 CleanMyMac、fleet.sh)。(b)**事发版本已直接核对**——growth/sub 的 12:51 mtime **早于** 14:27(E1)与 23:28(E2 第6杀)两个窗口,故 12:51 版本即两窗口的事发版本;daily-standup 的 22:42 mtime 虽晚于 14:27,但**已直接审计 14:27 运行版本(生产源 SHA bc9c9bfb)的 daily-standup.sh**——只含 `kill -0`(探测),且 `git diff bc9c9bfb 5c6c14f0 -- scripts/daily-standup.sh` 证实**两版本无任何 kill 行改动**(见 transcripts/incident-version-scripts-audit.txt)。故所有行的 alibi 均对事发时版本成立,非「当前版本+断言」替代。

| 嫌疑人 | ①活跃(14:2x / 23:2x) | ②执行体(事发版本) | ③终止命令 | ④杀伤面分析 | ⑤结论 |
|---|---|---|---|---|---|
| cmux-watcher(launchd job) | 活跃(14:27:44 触发重建) | com.flywheel.cmux-watcher → flywheel-cmux-autostart | 委托 autostart,自身无终止逻辑 | 无 | **排除**(高) |
| cmux-autostart | 活跃(14:27:44 重建 session) | flywheel-cmux-autostart.sh(6/16 版,git 上次改动 6/1) | **零终止动词**;纯 exec watcher | 无 | **排除**(高;只建不杀实证) |
| cmux-sync(watcher,FLY-873) | 活跃且正常操作旧 server(14:27:12 挂 hook 成功)/ 活跃 | flywheel-cmux-sync.sh(7/4 版) | `tmux kill-session -t "=$view_session"`(=精确名 view session);TERM/KILL 具名 watcher-lock pid(仅 --wait-for-watcher-exit 安装辅助模式) | kill-session≠kill-server;目标是具名 viewer session 与自身锁持有者 | **排除**(高) |
| com.flywheel.updater | 日程 6am(launchctl last exit 0);两窗口非日程 | update-flywheel.sh(3/31 版) | **零终止动词** | 无 | **排除**(高) |
| bridge wrapper | 每次 Bridge 起动时 | 部署版 ~/.flywheel/bin(7/9 06:06,sha a6b6bd7f;repo 版 22:42 FLY-1062 改动**未部署**) | 仅 `kill -0`(存在性探测) | 无 | **排除**(高) |
| skills-update(skills-sync) | 日程型;两窗口 unknown | skills-sync.sh(6/5 版) | kill 自身 sync 子进程(超时看门狗) | 自限 | **排除**(高) |
| daily-standup | 日程 6am;两窗口非日程 | 14:27 版=生产源 bc9c9bfb 已直接审计(22:42 版 kill-face 无变化,diff 证) | 仅 `kill -0 $BRIDGE_PID`(探测) | 无 | **排除**(高) |
| token-usage-daily | 日更;两窗口非日程 | token-usage-daily.sh(7/9 06:00 版) | **零终止动词** | 无 | **排除**(高) |
| cron daily-permission-learn | 00:00;两窗口非日程 | daily-permission-learn.sh(6/12 版) | **零终止动词** | 无 | **排除**(高) |
| growth-improve tick | 12:51 被 FLY-886 改写;last exit 2(失败) | growth-improve-tick.sh(7/9 12:51 版) | **零真实终止动词**(命中为 runner-prompt 文案子串,非终止) | 无 | **排除**(高) |
| growth-learn tick | 同上;last exit 2 | growth-learn-tick.sh(7/9 12:51 版) | **零终止动词** | 无 | **排除**(高) |
| growth-report tick | 日程;last exit 0 | growth-report-tick.sh(7/9 12:51 版) | **零终止动词** | 无 | **排除**(高) |
| growth-retro tick | 日程;last exit 0 | growth-retro-tick.sh(7/9 12:51 版) | **零终止动词** | 无 | **排除**(高) |
| sub-create-nightly | 日程夜间;两窗口非日程 | sub-create-nightly-tick.sh(7/9 12:51 版) | **零终止动词** | 无 | **排除**(高) |
| sub-daily-loop | 日程;两窗口非日程 | sub-daily-loop-tick.sh(7/9 12:51 版) | 命中仅「NOT terminating…paging human」日志文案(不终止) | 无 | **排除**(高) |
| belle keepawake | 日程;两窗口非触发时段 | caffeinate -d(纯保持唤醒) | 无终止能力 | 无 | **排除**(高) |
| belle daymode | 日程 day;两窗口非触发时段 | ~/bin/daymode(6/28 版) | **零终止动词** | 无 | **排除**(高) |
| belle nightmode | 日程 night;两窗口非触发时段 | ~/bin/nightmode(6/28 版) | **零终止动词** | 无 | **排除**(高) |
| CleanMyMac scheduledScan | loaded,last exit 0;两窗口活跃性 **unknown** | 2013 年二进制(静态 grep 不可行) | 不可静态审计 | 行为面 = 磁盘清理器;无已知进程杀伤面;死亡形状(churn 滴漏+宿主雪崩)与清理器不符,atlas 幸存反对 | **无嫌疑证据;活跃性 unknown 如实标注**(中) |
| CleanMyMac trashWatcher | loaded;两窗口活跃性 **unknown** | 同上二进制 | 不可静态审计 | 同上;watch trash 行为面无进程杀伤 | **无嫌疑证据;unknown 标注**(中) |
| restart-services.sh | 13:09/14:40/21:03 重启窗口(运维调用);两事故窗口本体无被调用证据 | 部署版(7/9 06:06) | TERM 循环 over Bridge $pids + 120s 后 kill -9 + `kickstart -k`(Bridge/Lead 具名 label) | 目标 = run-bridge 进程与 lead label,**打不中 tmux server**;其编排解释非看门狗双起 | **排除对 E1;对 E2 三组主动重启 = 已定性执行者**(中高) |
| test-deploy.sh(QA Room) | 两事故窗口 unknown(仅 QA Room 显式调用;当日无调用证据) | 7/7 版 | `kill -0` 探测 + `kill $LEAD_BG_PID`/`kill $BRIDGE_PID`(**均脚本自身 spawn 的隔离子进程 pid 变量**) | 目标限自起隔离子进程;无 kill-server、无生产 pid/pattern | **排除**(高) |
| crash-reaper(HeartbeatService) | Bridge 存活期间 | teamlead 源码 @ bc9c9bfb | 走 applyTransition,无 server 级终止;仅状态机 | 无 tmux server 杀伤面 | **排除**(高) |
| close-tmux action | Bridge 存活期间 | teamlead 源码 @ bc9c9bfb | `kill-session -t =viewer-<execId>`/`kill-window -t <具名>`;founder-consent 门控 | 精确名,打不中默认 server | **排除**(高) |
| close-runner action | Bridge 存活期间 | teamlead 源码 @ bc9c9bfb | 同上精确名 kill-window | 精确名,打不中 server;14:26:20 boot 的 Bridge kill 尝试全 `Command failed`(fail-closed) | **排除**(高) |
| FLY-887 keep-alive | Bridge 存活期间 | teamlead 源码 @ bc9c9bfb | park/keepalive 状态,无进程终止 | 无 | **排除**(高) |
| FLY-873 cmux-sync watcher | =上「cmux-sync」行(FLY-873 即该 watcher 的实现单) | 同 cmux-sync | 同 cmux-sync | 同 cmux-sync | **排除**(高) |
| flywheel-fleet.sh | unknown(仅 console 显式触发;FleetPoller 只读) | 7/2 版 | `bootout` 具名 lead plist label | lead daemon 专用,打不中 server/Bridge 之外目标 | **排除**(中高;活跃性 unknown 标注) |
| FLY-1082 QA harness | 23:14–23:35 活跃(自认+独立核) | 其 E2E harness | 隔离 socket(`-L qa-fly1082-<pid>`)kill-server;23:35 `pkill -f vitest`(机器级,但 Bridge/tmux 不匹配该 pattern,且晚于第 6 杀 6 分钟) | 隔离 socket ≠ 默认 socket;其**全量 vitest 是第 6 杀触发**(资源路径,非信号) | **排除直接杀;定性为第 6 杀资源触发者**(高) |
| xiaohongshu-deep-learning.qa528 | last exit 127(temp 脚本已灭失,job 空转失败) | /var/folders 下已不存在 | n/a | 无执行体 = 无行为 | **排除**(高) |
| chezmoi auto-sync | 日程 02:00(git log 证实) | chezmoi-auto-sync.sh(2/8 版) | 仅 kill -0 | 无 | **排除**(高) |
| system-health-log | 全天 60s 周期(白名单) | system-health-log.sh(5/18 版) | **零终止动词** | 无 | **排除**(高) |

**矩阵总结论**:全机具备 kill 能力的自动化,**没有任何一个具备打中默认 tmux server 的杀伤面**;Bridge 的死全部对齐到看门狗自杀(6 次)与运维主动重启(3 组)。issue 特别点名的「pkill -f 模式过宽」类:当日仅见 FLY-1082 QA 的 `pkill -f vitest`(23:35,晚于第 6 杀,pattern 不匹配 Bridge/tmux)。

## 6. 攻击面矩阵(路径 → 预期痕迹 → 检查结果 → 负证据强度)

| 攻击路径 | 预期痕迹 | 实际数据源 | 保留窗 / 权限 preflight | 检查结果 | 负证据强度 |
|---|---|---|---|---|---|
| SSH/远程 shell 登录 | 远程来源列的 wtmp 条目 / sshd 会话行 | wtmp(`last`)、unified log sshd | wtmp = 滚动到 ~60 天(2681 条覆盖);sshd 走 remote-access 全天导出(design 阶段近实时);权限:用户态可读,OK | wtmp 60 天**全部本地** console/ttys,零远程来源;全天 sshd/sshd-session **0 条** | 强(双源) |
| 屏幕共享/远程桌面 | screensharingd 会话、CRD 进程/agent | unified log + 进程 + LaunchAgents | 全天导出覆盖;权限 OK | 全天 0 条;无进程;CRD 无 agent 无进程 | 强 |
| Remote Apple Events | AEServer 进程/日志 | 进程 + 全天导出 | **导出谓词未显式含 eppc = 部分覆盖(gap)**;权限 OK | 无进程;全天导出 0 条 | 中 |
| 覆盖网络(Tailscale/VPN/booster) | tailnet 成员、VPN/booster 会话 | 各 daemon 状态 + log | tailscaled log **可能已轮转(gap)**;`tailscale status` 用户态可读 | tailnet 仅 2 台自有设备(本机+离线 Pixel);ExpressVPN/booster daemon 未运行 | 中高 |
| SSH 信任面植入 | authorized_keys 新增 key / 文件近期 mtime | ~/.ssh 文件 mtime + key 指纹 | 文件常驻,无保留窗;权限 OK | authorized_keys = **1 把 Annie 自己的 ED25519**(mtime 2025-07-31);全部 key 文件 mtime ≥8 月前 | 强 |
| launchd/cron 持久化植入 | 陌生 job / 近期 plist mtime | 双域 launchctl list + plist + crontab | 常驻,无保留窗;system 域 plist 可读(root job **运行时状态**受限=部分 gap) | 双域全部可认领(已知第三方枚举);7/9 mtime 变动全对应已知工作(FLY-886 12:51、infra-bot 14:06/14:14);cron 仅 1 条 | 强 |
| dotfile/rc 篡改 | chezmoi diff 异常 / rc 近期 mtime | `chezmoi diff` + git log + rc mtime | 常驻 + git 历史;权限 OK | diff 仅 1 个本地新增文档;auto-sync 02:00 正常节律;rc mtime 事发前数周+ | 强 |
| login items | 陌生自启动项 | System Events 查询 | **需自动化权限(本次成功;失败则 gap)** | 仅 Typeless | 强 |
| 事故窗口未知二进制 | 非白名单 exec/CHECKIN 路径 | 两窗口 unified log 切片 | design 阶段近实时导出 + 0710 复导出;权限 OK | 全部已知(node Cellar/cmux.app/osascript/screencaptureui;夜窗 + OrcaSlicer/npm 工具) | 强 |
| 进程注入 | 崩溃报告非常规 image | 27 份 .ips/.diag usedImages | 报告常驻;权限 OK | 24 份逐份核查,零未知 image | 强 |
| 网络驻留/回连 | 历史外连记录 | 历史连接(无)+ 现状 lsof | **历史连接 macOS 默认无记录 = 永久盲区**;lsof 仅本用户可见(root socket 不可见=gap) | 现状监听全部可认领;两个全接口监听(Python \*:8799/\*:8931、node \*:8980)建议收紧(加固,非入侵) | 盲区如实声明 |
| GitHub 账号面 | 陌生 actor 的 push/token 使用 | 公开 events(`gh api`) | **personal security log 仅 Web UI = 盲区**;events API 用户态可得 | 100 条 events 全部自有两 repo;7/9 的 44 push/11 PR/11 comment 与 fleet 当日工作一致 | 中;**无法排除「同账号 token 被盗用且行为拟态」** |
| Linear/Discord 账号面 | 陌生 actor / 非预期频道动作 | Bridge 日志 + 线程往来 | 全量 actor 导出未做(P1 深度=gap);API 用户态可得 | 当日活动均为已知 bot/founder 形态(自洽) | 中低(同上拟态局限) |
| 「runner 幻觉注入」旧事件(3dcb1b94) | 原证伪 scratchpad | scratchpad + bridge.log 旁证 | **scratchpad 已被 tmp 清理灭失(gap)**;bridge.log 常驻 | 旁证重建:该 runner = FLY-545 implement runner,bridge.log 129 条正常生命周期;E3 注入面独立为零 | 原始证伪不可复核(如实);独立证据面一致于无注入 |

**攻击面终判措辞**:**未发现与这三起事件相关的外部入侵迹象**(置信度:高——在本机可得数据源范围内;依据 = 上表全部强负证据;盲区 = 历史网络连接、root 域数据、GitHub 安全日志 Web-only、token 拟态不可排除性,均如实声明)。在无 EDR/auditd/历史连接记录的机器上不存在「证明无入侵」,但**每一条可查路径都查了,且全部干净**。

## 7. 直接回答 Annie 的三个问题

1. **「到底是什么把 runner 全部关掉了?」** 承载全部 runner 的默认 tmux server 在 14:27:13–14 倒下,带走了它名下所有 pane(106 个长命进程一秒内集体消失,与 runner 大军一致)。**没有发现任何杀它的主体或证据**(全机具杀伤能力的自动化逐项审计,无一够得着默认 server;atlas 第二 server 幸存反对任何宽杀)——最佳解释是它在系统级内存耗尽中自己分配失败、按 tmux 源码的 fatal 路径干净退出(这种死法零痕迹,所以当时查不到「凶手」;§3 已声明无法 100% 排除某未留痕进程发信号,只是没有任何证据支持该方向)。把机器推到耗尽的是:30+ runner 底载之上,FLY-1062 打包管线在 5 分钟内叠加了 npm install + **两次全量 vitest 测试扇出**(~361 个进程/50 秒出生风暴)。
2. **「是不是攻击?」** **未发现任何外部入侵迹象**(60 天登录全本地、SSH 信任面一年没动过、持久化无异动、事故窗口无未知程序、崩溃报告零注入、GitHub/网络面干净);同时,三起事件每一起都有完整的内部机制解释链。在无 EDR/auditd/历史连接记录的机器上不存在「证明无入侵」,盲区(macOS 不记历史网络连接、token 拟态不可排除等)如实列于 §6/§9——但每一条可查路径都查了、全部干净,没有任何一条证据指向攻击方向。
3. **「为什么感觉不像内存问题(电脑没变慢)?」** 直觉方向是对的——这不是「内存越来越满、越来越卡」的那种问题。急性危机只有约 5 分钟(14:23→14:28),之后立刻恢复;死的不是前台(WindowServer/GUI 受保护),是后台 runner 大军;而且**当天 memorystatus 谓词全天无任何指向我们 fleet 进程的内核 jetsam kill 记录**(晚间的 jetsam kill 全部是 Apple 系统 daemon 的 per-process-limit/idle-exit,与我们无关;此为谓词负证据,非「内核绝对没杀任何东西」)——夜里的刀是 Bridge 自己的看门狗按设计自杀,14:27 的最佳解释是 tmux 自身分配失败耗尽退出(相容的最佳解释、无直接观测,见 §3)。真正的问题是「满负荷的机器上有人间歇性点燃全量测试」,不是恒定的内存不足。

## 8. 对既有记录的更正

1. **FLY-1082 exploration §1**:sql.js OOM FATAL 属六月底旧事故,非 7/9;swap 数字为二手转述 →(注记块见 corrections-to-FLY-1082-records.md,Tadashi 裁决:不改原文,注记交付)。
2. **FLY-1082 QA 报告(incident-bridge-2329-analysis.md)**:pid 48951 是重启后现任的 launchd 顶层(`npm exec tsx`);当晚 stall 并被看门狗 SIGKILL 的是前任(launchd pid 73504 = 前一个 npm 顶层,其 Bridge node 子进程实际吃 signal-9,npm 折算成 exit(137) 上报——见 §2 进程树);「内核 OOM」推测不成立(是看门狗,当窗零指向 fleet 进程的 jetsam kill)——其「全量 vitest 是触发」自认**成立且被独立证实**。
3. **本单 research.md 两处按证据自我修正**:①「wrapper exec 使 launchd 观察的 exit(137) 就是 Bridge 本体、不存在传播」→ 实测存在 npm 父进程一层折算(结论不变,表述修正);②「滴漏 = 长命进程逐个死亡」→ 实测滴漏全部是新生进程 churn,长命进程(与 runner 大军一致但个体身份不可反查,见 §3)死于雪崩段;③ tmux fatal 措辞按 3.5a 真实引文(`fatalx("xmalloc: allocating …")`)修正。
4. **运维状态记录**:deployed-sha(bc9c9bfb,7/9 14:51)已落后于生产 checkout(5c6c14f0,7/9 22:42 pull)与现任 Bridge 实际运行源(23:29:59 boot 时读的 5c6c14f0)——deployed-sha 作为部署审计标记存在漂移,列入防复发建议。

## 9. 防复发建议(建单素材粒度;只产素材,不自建单)

**FLY-1082 四态(as_of 2026-07-10 05:46 PDT)**:commit=f4bcd0bf;PR #538 **MERGED**(2026-07-10 00:49 PDT);**未部署激活**(deployed-sha=bc9c9bfb 7/9 14:51;现任 Bridge 23:29:59 起跑 5c6c14f0,均早于 #538 merge;需一次 Bridge 重启激活)。事故时刻生产源:06:05–12:59 boots=2db55f96,13:09–21:35 boots=bc9c9bfb,23:29:59 现任=5c6c14f0。

| # | 问题 | 建议 | 归属 | 建单素材 |
|---|---|---|---|---|
| 1 | 两起基础设施事件(E1 fleet 全灭 + E2 Bridge 六杀)检测全部缺位(当日 6 杀无人知晓) | **部署激活 FLY-1082**:tmux_server_lost 覆盖 E1、bridge_abnormal_exit 覆盖 E2、swap_pressure_high 提前预警。已核实:watchdog self-SIGKILL 不写任何 marker、进程即死 → FLY-1082 的 running-marker 保持 dirty → 下次 boot latch → bridge_abnormal_exit 腿**理应触发**(其 QA harness 已真机验证该腿)。**注:E3(OrcaSlicer 应用自身 bug)属应用层,不在 fleet 检测覆盖范围内,也不应由 fleet 告警覆盖** | 并入 FLY-1082 ship(激活=重启 Bridge) | 「FLY-1082 已 merge 未激活;下一次 Bridge 重启即激活;激活后 E1/E2 两起基础设施事件均有检测覆盖;E3 属应用 bug 不在范围」 |
| 2 | **生产 host 全量测试扇出**一天引爆三次(FLY-1062 管线×2、FLY-1018 runner、FLY-1082 QA),是 E1+E2 两起基础设施事件的共同根因(不含 E3) | Tadashi 已定政策「生产 host 禁跑全量套件」→ 落协议文本 + **硬护栏**:①runner/QA 提示词协议红线;②可选技术闸(如 vitest wrapper 检测无参数 `vitest run` + 生产 host 标记时拒跑/降并发 maxWorkers) | 新单 | 「无参数 vitest run 在生产 host = 事故级行为;三次实证 14:23/14:25、21:30、23:28 → 6 次 Bridge 死亡中的 3 次 + tmux server 之死;需政策落地 + 技术闸」 |
| 3 | 看门狗压力下自杀是否合理(Tadashi 追问) | 6 杀全部是「机器过载→主循环饿死→SIGKILL 自身→KeepAlive 拉活」,重启本身无害且自愈成功;但**压力风暴中反复自杀-重启会放大抖动**(重启 boot 本身耗资源)。建议:①stall>60s 时先记录+告警(FLY-1082 腿),自杀阈值提高或加「连续 N 次 stall 才杀」;②或 stall 时先降级(暂停非关键 poller)再杀。设计权衡归新单 | 新单(与 FLY-1048 看门狗族协同) | 「watchdog 60s SIGKILL 在容量风暴中一天开火 6 次;评估 kill vs degrade;当前行为 by-design 且自愈成功,非缺陷,是调优项」 |
| 4 | system-health-log 无 swap 水位;`claude_agents=0` 计数 bug(全天恒 0,实际 30+) | 增采 `sysctl vm.swapusage`;修计数正则 | 新单(小) | 「事后取证时 swap 无实测序列(本案被迫降级二手转述);agent 计数恒 0」 |
| 5 | launchd unified log 类目保留窗实测仅 ~1 小时级 → 事后取证靠抢 | 关键 fleet 事件(watchdog 开火/兜底重启)触发时**同步抓 log show 窗口切片**落盘 | 并入 FLY-1082 系(检测已有落盘管道) | 「launchd 权威记录 1 小时即滚;本案 design 阶段抢救成功纯靠运气+纪律」 |
| 6 | Remote Login(sshd)launchd 层 enabled 但从未使用 | 关闭或确认需要(减攻击面);顺带收紧两个全接口监听(Python \*:8799/\*:8931、node \*:8980)到 loopback | 新单(加固,低优先) | 「零使用的开放入口;非入侵迹象,纯加固」 |
| 7 | deployed-sha 漂移(§8.4) | 生产 checkout 被 pull 而 Bridge 未重启时,deployed-sha 与实际运行源脱钩;ship 流程收口 | 新单(小)或并入 ship 纪律文档 | 「审计标记与真实运行源不一致,事故取证时需 reflog 反推」 |

## 10. 盲区与置信度总声明

- 永久盲区:历史网络连接(macOS 默认无记录)、signal 发送者(内核不记)、root 域数据(/var/audit、`log config`、root socket——无 sudo,按纪律未提权)、GitHub personal security log(Web-only)、token 拟态不可排除性。
- 已滚证据:launchd 类目日志(~1h 窗)、3dcb1b94 scratchpad(tmp 清理)。
- 复导出弱化声明:14:20–14:40 与 21:28/23:25 窗口的 0710 复导出发生在事发 11–34 小时后,负证据弱于 design 阶段近实时导出,两代并存互证(INDEX.md B2 注)。
- 所有「排除」「相容」「未唯一指认」的置信度已逐条标注;出现新证据(尤其 tmux 死亡的直接观测手段)时 §3 机制结论应重新评估。
