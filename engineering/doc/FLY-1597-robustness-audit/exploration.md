# FLY-1597 系统健壮性全面摸底 — 探索

Issue: FLY-1597 (https://linear.app/geoforge3d/issue/FLY-1597/审计founder-直令-系统健壮性全面摸底-消息重构开工前的稳定性裁定dag-能不能用runnerlead-通不通还有什么在真坏)
日期: 2026-08-01
基于: 无

---

## 1. 这份审计存在的理由

founder 原话:

> before we started working on it, is our system stable enough to run these things? like is dag
> working now? are you able to receive msg from runners (we tried to fix it but tbh I have no idea
> whether that is fixed or not), I want the system to be in a relative stable state then we start
> fixing things, so you will need to do a **ultra research** on our current system robust then we
> make plan for the next step

所以本单**不修任何东西**。交付物是:每个子系统一个红/黄/绿裁定 + 复现命令 + 「消息层重构(1570–1576)开工前必须先修什么」的排序。

## 2. 审计边界

| 范围内 | 范围外 |
|---|---|
| DAG / workflow engine 能不能把一个 run 走完 | 修任何一个发现的问题 |
| runner → lead 消息的**抵达面** | 消息层重构本身的设计 |
| 当前在真坏的其它子系统(进程/DB/告警) | 已有结论的 748/743/751/752/749/750/744 |
| 生产机现场状态(本机 = 生产机) | models.json 1M 映射(有意配置)、cmux legacy grouped(Cass 手工救) |

## 3. 方法学:三条写死的纪律

审计的价值全部取决于测量本身可信。今晚已经有过一次「拿标签冒充事实」的教训,所以三条规矩写在动手之前:

### 3.1 每个结论先验仪器

不允许「查出来是 0,所以没有」。**先用一行已知存在的数据证明过滤器能选中东西,再信它的零。**

本次实际抓到的仪器坑(如果不校准,报告会全错):

| 库 / 表 | 时间戳格式 | 踩法 |
|---|---|---|
| `comm.db` `messages.created_at` | `2026-08-01 22:20:15`(空格分隔,UTC) | 用 `T` 格式过滤 → 静默返回 0 |
| `comm.db` `lead_inbox.created_at` | `2026-08-01T22:20:15.000Z`(ISO,UTC) | **同一个库里两张表格式不同** |
| `teamlead.db` `lead_events.created_at` | `2026-08-01 22:18:00`(空格分隔,UTC) | 同上 |
| 本机时区 | 本地 PDT = UTC−7 | 库里全是 UTC,看着像「未来 7 小时」 |

另外两次仪器自救,都写进报告(否则会变成假结论):

1. **模板探针第一版报 17 个模板全挂**,原因是我没给 `buildWorkflowRunSnapshotV2` 传 `canonicalRoot` —— 是我的探针坏,不是系统坏。补齐后 11 通过 / 6 失败。
2. **live-run 探针第一版报 10 个 run 全部 `snapshot JSON is corrupt`**,原因是 `parseWorkflowRunSnapshot()` 收的是 JSON **字符串**,我传了已解析对象。改回字符串后 7 通过 / 3 失败。

⚠️ 第 2 次那版探针里我还打印了一行「两种结果都出现 ⇒ 探针没卡死」,但那行是无条件打印的 —— **自检本身是假的**。这条记在这里当反面教材:自检语句必须由真实计数驱动。

### 3.2 落盘 ≠ 投递,进程活着 ≠ 在干活,CI 绿 ≠ 护栏有效

每条「正常」都要有抵达面的证据。本次三条都各自命中了:

- **落盘 ≠ 投递**:`lead_events` 里躺着完整 payload,Lead 收到的是 `[Event #N] undefined`(§Q2)。
- **进程活着 ≠ 在干活**:Bridge 在 :9876 上 LISTEN,但每个请求要 7–12 秒(§Q3)。
- **CI 绿 ≠ 护栏有效**:`verify-workflow-seeds.mjs` 对 `tpl_generic.yaml` 打 ✅,同一份 manifest 喂给运行时 `resolveWorkflowGateAuthority()` 抛 `incoherent_ship_bundle`(§Q1)。

### 3.3 用生产函数打生产数据

不手写「等价逻辑」再下判断。裁定 DAG 时直接 `require` 生产 dist 的 `resolveWorkflowGateAuthority`,喂 `workflow_run.snapshot` 里那份**真正 pin 住的快照**,不是我重新组装的对象。

## 4. 审计当时的现场

审计开始 5 分钟内就撞上一个**正在发生**的生产事故(§Q3-A),它会污染所有其它测量,所以它既是发现也是所有延迟类读数的解释。现场随审计过程持续劣化:

| 时刻 (PDT) | load | Bridge |
|---|---|---|
| 15:22 | 9.89 | LISTEN,`/health` 12.0s |
| 15:41 | 17.24 | 无 listener,launchd 报 status=143,正在重启 |

**这不是一个稳定到可以开工重构的系统。** 详细裁定见 `plan.md`。

## 5. 三个必答问题(结论摘要,证据见 research.md,裁定见 plan.md)

| 问题 | 一句话回答 |
|---|---|
| **Q1 DAG 现在能不能用?** | **不能收工**。#748 之后新起的 generic run,`resolveWorkflowGateAuthority()` 直接抛异常;5 天内 0 个 run 到达 `completed`。 |
| **Q2 runner→lead 通不通?** | **通,但仪表全瞎**。消息确实被回,可 FLY-161 设计的中继 24h 只响了 2 次(约 2%),真正被投出去的告警里 6072 条正文是 `undefined`。 |
| **Q3 还有什么在真坏?** | 至少 8 项,其中 3 项红:tmux 抢救风暴 / Bridge 崩溃循环 / 2 个 Codex Lead 全死。 |

## 6. 已知不必重查(遵循 issue 指示)

748 / 743 / 751 / 752 / 749 / 750 / 744 均已合并并逐条硬验收;models.json 的 1M 映射是有意配置;cmux legacy grouped 形态是 Cass 手工救的、watcher 警告是真实提醒(FLY-1596 已立)。

本审计**只在 748 与本单结论直接相关时**复查了它 —— 见 Q1,那不是重查它的验收,是审它上线后的运行时后果。
