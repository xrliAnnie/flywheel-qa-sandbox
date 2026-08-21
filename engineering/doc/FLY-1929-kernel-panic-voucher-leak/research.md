# FLY-1929 内核 panic 致全机重启 — 调研

Issue: FLY-1929 (https://linear.app/geoforge3d/issue/FLY-1929/infra宿主-内核-panic-致-0135-全机重启-ipc-voucher-泄漏打满-ivac-entries)
日期: 2026-08-20
基于: exploration.md

## A. 机理:从 XNU 源码核实,不是推测

以下四条全部从 apple-oss-distributions/xnu 主干源码原文核过,不是凭印象:

**A1. 天花板值 = 524288。**`osfmk/ipc/ipc_voucher.h`:

    #define IVAC_ENTRIES_MIN        512
    #define IVAC_ENTRIES_MAX        524288

**A2. panic 点在 `ivac_grow_table`,条件是表已经到顶还要再长。**`osfmk/ipc/ipc_voucher.c`:

    if (ivac->ivac_table_size >= IVAC_ENTRIES_MAX) {
        panic("Cannot grow ipc space beyond IVAC_ENTRIES_MAX. Some process is leaking vouchers");
        return;
    }

**A3. 这张表只增不缩,空闲条目走 free list 复用。**源码里没有任何缩小 `ivac_table_size` 的路径;
释放走 `ivace->ivace_next = ivac->ivac_freelist`。

> 推论(本单最重要的一条):**决定生死的是并发峰值,不是累计速率。**
> 任何形如"按每秒 N 条外推还剩几小时"的说法都是错的。我自己在 exploration 阶段先犯过这个错并已更正。

**A4. 装在这张表里的是 BANK 的 bank_task / bank_account,而且回收是延迟的。**`osfmk/bank/bank.c`:

- bank_account 不是简单的"每对 (holder, merchant)",而是按
  **(holder, merchant, secure originator, proximate process, thread_group, persona_id)** 这个六元组去重。
- 关键:**任务退出时不会立刻释放**。`bank_task_destroy()` 只减引用;
  **bank_account 只要还有 voucher 引用着就一直活着**,真正释放要等 `bank_release_value()`。

A4 直接给出了泄漏者的画像:

> 泄漏者是一个**长命的 merchant(服务端)**。它不断收到来自大量**短命 holder(客户端)**的带 voucher 的消息,
> 每来一个新客户端就多一条 ivace,而它迟迟不释放 voucher 引用。
> 短命客户端**自己死掉也不会让条目消失**。

这也顺带解释了为什么 panic 字符串点的是 launchservicesd:它是所有进程都要打交道的 merchant,
所以它最可能第一个申请不到条目 —— 它是撞墙的那个,不一定是攒下条目的那个。

## B. 仪器:三把尺子,一把都不需要 root

| 尺子 | 命令 | 需要 root | 给什么 |
|---|---|---|---|
| 全局占用量 | `zprint` 的 `bank_account` / `bank_task` / `ipc.vouchers` 三行 inuse 列 | 否 | 逼近 524288 的实时余量 |
| per-process 持有量 | `lsmp -a` | **是** | 此刻谁持有最多(最强,但被权限挡住) |
| 断崖归因 | 高频采 `bank_task` + 全量 pid 快照,骤降时报消失的 pid | 否 | 谁死的时候释放了几万条 = 谁是持有者 |

`lsmp` 非 root 实测直接 `task_for_pid() failed`,连自己的进程都读不了。已就只读 root 采样向 Tadashi 报备授权,不阻塞。

### B1. 尺子的阳性对照(必须做,否则单调上升毫无意义)

- 同一份 zprint 里,`ipc.spaces`(991→980)和 `ipc.task.importance`(1000→992)在同窗口内**有涨有跌** ⇒ inuse 是活数,不是生命周期累计计数器。
- 更硬的一条:实测到 `bank_task` 从 **50248 一次性掉到 1338** ⇒ 它确实会被回收。

## C. 实测数据(全部本机实测,2026-08-20 UTC 14:2x–14:4x)

**C1. 泄漏量级。**某一刻 `bank_task` inuse = **48563**,同一刻活着的任务约 **990** 个。
一个活任务本该对应一条,**约 49 倍**。

**C2. 形态是锯齿,不是单调。**观测到完整的一轮:累积到 50248 → 断崖掉到 1338 → 重新累积。
GC 之后的正常基线在 **1500–2500** 之间小幅波动。所以那次 48563 是一次真实的约 20 倍偏移。

**C3. 舰队的 fork 速率(这是驱动量)。**用 0.4 秒间隔的 pid 集合差分测了 75 秒:

    观测到的新 pid = 1257 → ≈ 16.7/s ≈ 1004/min

必须标注的两个边界:
- 这是**下界**。活不满 0.4 秒的进程采不到。
- 其中约 187 个是**我自己的测量**(每 0.4 秒一次 `ps`)造成的。扣掉之后舰队本身仍有 **约 850/min**。

**C4. 一次 fork 不止一条条目。**在 C3 那 75 秒里,`bank_task` 从 1262 涨到 5967(+4705),
同期新 pid 约 1257 ⇒ **平均每个新进程约 3.7 条 bank_account**(它跟几个 merchant 说过话就有几条)。

**C5. 量级自洽性检查。**850 fork/min × 3.7 ≈ 3100 条/min。若一条都不回收,**2.8 小时**就能打满 524288;
实际那晚撑了 **29.8 小时**。两者相差约 10 倍 ⇒ **绝大多数条目是被正常回收的,泄漏的是一个不大的持久残留比例**。
这条反过来也说明:**光靠"降 churn"未必治得了根**,真正要找的是那个"不放手"的 merchant。

**C6. 已排除的嫌疑人(一个)。**那次 50248→1338 的断崖发生时,Bridge **没有重启**
(`/health` 的 uptime 连续,同一进程 14:09:52 起至今)⇒ 释放者不是 Bridge 的死亡。
注意这只排除了"Bridge 死亡触发释放",不排除 Bridge 主动释放。

## D. 时间线:为什么说"是最近变坏的"

`last reboot`:

    Aug 20 01:35   ← 本次 panic
    Aug 18 19:45   ← 上一次开机,29.8 小时后 panic
    Aug 18 16:51
    Aug  1 10:41   ← 到 8/18 16:34 连续 17 天,无 panic

同一台机器、同一个 macOS 26.6.2。**17 天 vs 30 小时**。所以这不是长期常态。
`/Library/Logs/DiagnosticReports/` 下**只有这一份 panic 报告**,没有历史同类 panic。

诚实边界:我**无法**回溯 8 月 1–18 日那段时间的 fork 速率或 bank_account 占用(当时没有任何采样),
所以"最近变坏"只能归因到"时间上的巧合 + 那段时间舰队负载更低"这个层面,
**给不出"是哪个改动引入的"**。这正是本单要装常驻采样的理由 —— 下一次不能再没有 before 基线。

## E. 检测器该怎么设计(本单最核心的设计结论)

朴素做法是"占用量超过阈值就告警",但 C2 证明它会被锯齿刷屏:峰值 5 万是正常 churn,不是事故。

正确的判据是**看地板不看天花板**:

> 每一轮 GC 之后的**回落底部(rolling minimum)**才是真正回收不掉的残留。
> **地板在小时尺度上单调抬升 = 真泄漏**;峰值忽高忽低只是 churn。

所以检测器要采的是滚动最小值,而不是瞬时值或峰值。这条直接决定实现形态:

- 采样频率要高到能看见地板(锯齿周期是分钟级 ⇒ 采样间隔 ≤ 1 分钟);
- 告警判据用"最近 N 分钟的最小值"对 524288 的占比;
- 同时留原始时间序列上盘,供事后回溯(下次不能再"没有 before")。

## F. 复用哪些既有基建(不新造轮子)

审计过仓库,以下都已存在,直接接:

| 需求 | 既有件 | 备注 |
|---|---|---|
| Discord 告警 + 去重 | `scripts/lead-alert.sh` | eventId = sha1(project|lead|kind|signature),claims.db 单次事务去重;`--kind` 是**封闭枚举**,新增 host 级 kind 要动那张表 |
| Discord 无关的兜底告警 | `scripts/meta-alert.sh` | 桌面通知 + `<state>/meta-alert/<reason>.txt`,按 reason 去重,永远 exit 0 |
| 周期性只读监控 job 的范本 | `scripts/codex-log-guard.sh monitor` + `scripts/launchd/com.flywheel.codex-log-guard.plist` | FLY-697;只读、追加尺寸日志、越界才 meta-alert。形态与本单几乎一一对应 |
| launchd 单元登记 | `scripts/launchd/units.manifest` | FLY-1814 的磁盘权威分母。**新 job 必须登记**,否则反向 census 会把它当漂移 |
| 安装器范本 | `scripts/install-log-janitor.sh` | FLY-1330 |
| 报告投递 | `flywheel-comm publish-report` | FLY-1330 用它把 janitor 汇总投到 `FLYWHEEL_NOTIFY_CHANNEL` |

### F1. 一个必须先知道的约束:flag 治理闭网(FLY-1455)

`packages/config/src/__tests__/feature-flags-drift.test.ts` 会 **AST 扫描 `scripts/*.sh`**,
任何 `FLYWHEEL_*` 环境变量读点都必须落在三本账之一:flag registry、`NON_FLAG_ALLOWLIST`、或 exemption,
否则报 `unknown FLYWHEEL environment variable`。

同时 Annie 有明确的**「不加新 flag」**铁律(FLY-1466)。

⇒ 本单的做法:**不引入任何新的 on/off 开关**。确需的少量参数(阈值、频道覆盖)按 FLY-1330 的
`FLYWHEEL_JANITOR_REPORT_CHANNEL` 先例,登记为 `NON_FLAG_ALLOWLIST` 里的 **config value**(不是 flag),
并在描述里写明"tri-state 配置值,不是持久开关"。能不加的一律不加,用常量。

## G. panic 告警的两个硬约束(不能想当然)

**G1. panic 报告是重启之后才落盘的,而且会迟。**本次实测:panic 发生在 01:35:28,
`/Library/Logs/DiagnosticReports/panic-full-2026-08-20-070924.0002.panic` 的落盘时间是 **07:09**。
**迟了 5 小时 34 分。**所以:

- panic 告警天然是**事后**信号,它保证"再来一次我们立刻知道",**救不了那一次**;
- 检测器**不能**依赖"panic 后立刻有文件",必须容忍数小时延迟;
- 也因此,E 节那个"地板抬升"的提前告警才是救得了下一次的那一半,两件都要做。

**G2. 告警发出的时刻,Bridge 很可能还没起来。**panic 之后是冷启动,launchd 在拉各种服务。
所以 panic 告警**不能只走依赖 Bridge 的通路**,`lead-alert.sh`(它自己就是 Bridge-independent 的设计)
加 `meta-alert.sh` 兜底,两条都走。

## H. 遗留的不确定性(诚实清单)

1. **凶手仍未点名。**目前只排除了"Bridge 死亡触发释放"这一条。断崖归因原型已在跑,但断崖是偶发事件,
   本节点窗口内不一定能抓到第二次。
2. **root 授权未定。**没有它,"此刻谁持有最多"这个最直接的问题答不了。
3. **无法回溯 8 月 1–18 日**,所以"哪个改动引入的"给不出答案。
4. **zprint 的 inuse 与 ivac_table_size 不是同一个数。**inuse 是当前活着的对象数,
   `ivac_table_size` 是历史最高水位(只增不缩)。所以 zprint 读到的是**下界**:
   它告诉你"至少用到这么多",真实的表尺寸只会更大。用它做余量估计是**偏乐观**的,
   告警阈值必须相应压低。这一条必须写进实现注释,否则以后有人会把它当精确余量。
