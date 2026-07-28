# FLY-1499 定时唤醒者 A/B — 独立设计裁决
Issue: FLY-1499
日期: 2026-07-27
基于: mapping-v2final.md

## 裁决对象

外部定时唤醒者只负责每分钟触发一次 **level-triggered sweep**：启动 ready node、冷启动有 pending
mailbox 的离线收件人、修复 stale heartbeat 对应的 runner。它不参与 agent 自己的 1 秒 mailbox poll，
也不保存消息消费进度。

- **A — 自有常驻小进程**：一个长期存活的 `while sleep` 服务定期 sweep。
- **B — OS timer + 短命脚本**：`launchd` / `systemd` / Windows Task Scheduler 定期启动一次
  `scheduler-once`，执行完退出；没有 OS timer 时才启用约 30 行 fallback loop。

## Lead 的立场（对辩材料，独立保留）

Lead 倾向 **B**：机器本来就有成熟的定时/拉起设施，不应再造一个必须被照看的常驻 timer daemon。
Flywheel 只保留一层很薄、可替换的 backend abstraction：macOS 用 `launchd`，Linux 用
`systemd timer`，不具备二者的环境用小型 loop fallback；平台差异停在配置/适配层，业务 sweep
保持同一个命令。

## Codex 的独立判断

**我也选择 B，但理由和通过条件比“用现成设施”更严格：B 的优势不是 OS timer 永不失败，而是把
计时、进程回收、重启后的重新装载交给更低层的 supervisor，同时把 Flywheel 自己的可错状态压缩成
一个短命、可重复、可观测的事务。** 若没有下面的 DB single-flight、durable heartbeat 和独立观测，
B 不能通过；只写三份平台配置不构成活性保证。

| 维度 | A：常驻小进程 | B：OS timer + `scheduler-once` |
|---|---|---|
| 崩溃 | 要靠 OS supervisor 重启，实际仍依赖 `launchd`/`systemd`/Service Control Manager | 本轮失败即退出；下一 tick 重试，天然缩小故障持续时间 |
| 挂死 | PID 仍活，`KeepAlive` 看不见；需 event-loop watchdog、自杀和外部 probe | 单轮必须有硬超时；超时由 supervisor 杀掉，下一 tick 重试 |
| 状态漂移 | 长期连接、缓存、时钟跳变、内存/FD 泄漏、热更新旧进程都可积累 | 每轮从 DB 重查，不保留跨轮内存状态，部署切换更清楚 |
| 重复实例 | deploy/重启交错会 split-brain，需 generation/lease | OS 可抑制重入，但仍按 at-least-once 对待，用同一 DB lease 兜底 |
| 漏 tick / 休眠 | loop 暂停；恢复策略要自己定义 | 各 OS 的 missed-run 语义不同，不能当成一致；level-triggered 重查使一次补跑即可收敛 |
| 资源 | 常驻内存、连接和日志生命周期 | 每分钟一次短进程；当前 workload 足够轻 |
| 调试 | 要同时看进程、内部 loop、watchdog、supervisor | 看 timer 状态、最近 run receipt、退出码和日志，边界更少 |
| 适用阈值 | 需要亚分钟延迟、持久 OS handle、连续订阅或昂贵 warm state 时更合理 | 当前分钟级、DB level-triggered 三类 sweep 更匹配 |

### B 的不可省略合同

1. **一个 portable command**：三平台只负责启动同一个有界 `scheduler-once`；业务 SQL、重试、
   cooldown、日志语义不复制进 plist/unit/XML/PowerShell。
2. **DB single-flight**：运行开始先原子获取带 expiry 的 scheduler lease；OS 的“不重叠”设置只是
   降噪，不是正确性边界。所有启动/重启动作自身还要有 durable idempotency key 和 cooldown。
3. **level-triggered + 有界**：每轮从 DB 重查当前 ready/pending/stale；设 wall-clock timeout，
   超时或局部失败留状态给下一轮，不在进程内等待未来时间。
4. **durable receipt**：记录 `started_at`、`finished_at`、`result`、`host/backend`，并只在完整 sweep
   成功后推进 `last_scheduler_success_at`。这才是“它在走”的证据。
5. **唯一 backend**：安装时只能选择 OS timer 或 fallback loop；fallback 不得与 OS timer 自动并跑。
6. **安装后自证**：bootstrap/provision 必须 fail-loud 验证 job 已加载、下一触发时间可读，并执行一次
   probe run；“文件写到了目录”不算安装成功。

## 跨平台迁移判断

- **macOS**：`launchd` 原生支持 `StartInterval`/`StartCalendarInterval`；仓库已有 supervisor
  abstraction 和多条短命 tick 先例。补 interval spec 与 loaded/next-run 验证即可，不新增 resident
  daemon。
- **Linux**：现有 abstraction 已生成 `Type=oneshot` service + `OnCalendar` timer，并启用
  `Persistent=true`。需要补 hard timeout、run receipt 与 lease；user timer 还必须验证 linger/DBus，
  否则登出后会失去活性。
- **Windows**：当前仓库只把 Windows 作为 WSL2/Linux 路径支持；**native Windows 是新 backend，
  不是改一份配置**。Task Scheduler 可用 minute trigger，配置 `MultipleInstancesPolicy=IgnoreNew`
  与 `StartWhenAvailable`，还要处理 service account、最小环境、绝对路径和 task history。A 同样需要
  新建 Windows Service 与恢复策略，因此 native Windows 不构成改选 A 的理由。
- **fallback**：容器、精简发行版或无 user supervisor 时，用同一个 `scheduler-once` 外包一层短
  loop；它是显式 backend，不是悄悄启动的第二计时器。

## 谁看着 timer

没有 timer 能可靠地证明“自己没有运行”。A 的 loop 挂死但 PID 仍在，B 的 OS job 被 disable/unload，
都不能靠同一条执行链自报。

1. **第一层（本机）**：OS supervisor 提供 loaded/disabled、last exit、next run；provision 和启动
   自检读取这些状态。
2. **第二层（独立 failure domain）**：既有 infra probe/舰队健康检查读取 DB 中
   `last_scheduler_success_at`，超过阈值才告警；它不能由被监控的同一个 timer 触发。
3. **最终观察者**：外部 probe 自身缺席只能由更外层平台监控或人发现。不要递归制造
   “timer-watch-timer-watch-timer”；明确这条 failure-domain 终点。

仓库已有把 Bridge 外部 probe 放在另一个 launchd 域的先例（“nobody rescues their own side”），
也已有一分钟级短命 tick + 原子重入锁的生产形状，说明此处无需新增长驻 A 才能获得可观测性。

## 最终建议

**采用 B：OS timer 启动 portable、bounded、level-triggered 的 `scheduler-once`；用 DB lease 保证
single-flight，用 durable success heartbeat 接独立外部 freshness probe；保留显式 fallback loop
backend。**

只有当以后出现明确的亚分钟 SLA、长期订阅/handle 或高成本 warm state，且测量证明每分钟短进程不够，
才重新开启 A 的 ADR。当前问题不具备这些条件，A 只会把“谁看 timer”变成“谁看常驻进程及其内部 timer”。

## 依据

- 仓库：`scripts/lib/supervisor.sh`（macOS/Linux service/timer abstraction）；
  `scripts/xiaohongshu-learning-tick.sh`（bounded oneshot + re-entry lock）；
  `engineering/doc/FLY-1393-watchdog-minset-landing/research.md`（独立 failure-domain probe）。
- Apple：[`launchd` 支持 timed intervals，并建议按需拉起](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。
- systemd：[`systemd.timer` 的 active-unit 合并、休眠补触发与 `Persistent=` 语义](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml)。
- Microsoft：[`MultipleInstancesPolicy`](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-multipleinstancespolicy-settingstype-element)；
  [`StartWhenAvailable`](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable)；
  [`schtasks /create`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create)。
