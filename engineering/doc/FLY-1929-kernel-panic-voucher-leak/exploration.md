# FLY-1929 内核 panic 致全机重启 — 探索

Issue: FLY-1929 (https://linear.app/geoforge3d/issue/FLY-1929/infra宿主-内核-panic-致-0135-全机重启-ipc-voucher-泄漏打满-ivac-entries)
日期: 2026-08-20
基于: 无

## 1. 事故复述

2026-08-20 01:35:28 PT 宿主机内核 panic 重启,13 个 runner 的 tmux 现场全灭。

panic 字符串:

    Cannot grow ipc space beyond IVAC_ENTRIES_MAX. Some process is leaking vouchers @ipc_voucher.c:573

从 panic 报告里核出来的硬事实(不是转述 issue,是我自己解析 4.9MB 的 panic-full 得到的):

| 项 | 值 | 出处 |
|---|---|---|
| 开机时刻 | 2026-08-18 19:45:36 PT | Epoch Time Boot = 0x6a8518d0 |
| panic 时刻 | 2026-08-20 01:35:28 PT | Epoch Time Calendar = 0x6a86bc50 |
| 存活时长 | 29.8 小时 | 上面两者之差 |
| panicked task | pid 567 launchservicesd,2135 pages,16 threads | panicString |
| 系统 | macOS 26.6.2 (25G83) / Mac17,8 / xnu-12377.161.14 | 报告头 |
| panic 瞬间进程总数 | **1103** | processByPid 有 1103 条 |

panic 瞬间的进程画像(前几名):node 122、zsh 57、tmux 54、bash 49、login 47、bun.exe 28、
Claude CLI(以版本号 2.1.237/2.1.235 命名)34、distnoted 22、codex 22、contactsd 19、cfprefsd 15。

一句话:一台跑着 1100 个进程的开发机,其中绝大多数是我们舰队自己拉起来的。

## 2. panic 报告给不出凶手 —— 这点必须先说清楚

issue 里写「泄漏 voucher 的客户端报告未点名」,我核过了,确实点不了名,而且是结构性的点不了:

- `panicString` 里的 "Panicked task ... launchservicesd" 是**触发者不是泄漏者**。IVAC 表是全局的,
  谁最后一个申请不到条目谁就被记进 panic 字符串。launchservicesd 是所有进程都要跟它说话的服务,
  所以它最可能第一个撞墙 —— 它是受害者。
- panic 报告的 per-process 字段我全列了一遍:codeSigningAuxiliaryInfo / copyOnWriteFaults /
  csFlags / donatingPids / flags / jetsamCoalition / pageFaults / pageIns / portlabels / procname /
  residentMemoryBytes / suspendCount / threadById / turnstileInfo / waitInfo …
  **一个 voucher 计数都没有**。`donatingPids` 是 importance 捐赠链,不是 voucher 持有量;
  我逐条看过 122 个有 donatingPids 的进程,最大的 chronod 才 20 条,跟"泄漏了几十万条"完全不是一个量级。

结论:**靠这份 panic 报告永远查不出泄漏源**。要定位只能在运行时取证。这决定了本单的形态 ——
本单的主体不是"读日志找凶手",是"造一把能在下次泄漏发生时点名的尺子,并让它常驻"。

## 3. 关键突破:找到了一个不需要 root 的活体仪器

原以为 per-process 取证必须 root(`lsmp -a` 要 task_for_pid,非 root 直接失败,实测过)。
但 `zprint` 不需要 root,且它把相关的内核 zone 直接暴露出来了:

    ipc.vouchers      inuse
    bank_task         inuse
    bank_account      inuse
    Bank.ledger       inuse
    ipc.task.importance / ipc.importance.inherit

`ipc_voucher.c:573` 那个 IVAC 表属于 **BANK attribute manager**(每个 bank_account 占一个 ivace 条目),
所以 `bank_account` / `bank_task` 的 inuse 就是逼近 IVAC_ENTRIES_MAX 的那个量。

### 3.1 先证明尺子是活数不是累计计数器

这是必须做的阳性对照,否则"单调涨"毫无意义:

- 同一份 zprint 输出里,`ipc.spaces`(991→980)和 `ipc.task.importance`(1000→992)在同一窗口内**有涨有跌**,
  说明 inuse 列是活数。
- 而后来实测到 `bank_task` 从 50248 **一次性掉到 1338**(见 3.3),更是直接证明它会回收。

尺子成立。

### 3.2 泄漏量级(实测)

某个采样时刻:`bank_task` inuse = **48563**,而同一时刻活着的任务只有 **约 990 个**。
一个活任务应当对应一个 bank_task,**48563 / 990 ≈ 49 倍**。这就是泄漏本身,肉眼可见。

### 3.3 但它不是单调泄漏,是锯齿 —— 这一条推翻了我自己的第一个结论

我最初测到 14:25:50→14:30:58 的 308 秒里 `ipc.vouchers` 从 38129 涨到 46979(约 28.7 个/秒),
据此外推"4 到 5 小时后再 panic",并已按这个口径向 Tadashi 报过一次。

**这个外推是错的,我在同一轮探索里把它自己证伪了**:随后一次 45 秒窗口的环境测量得到 **-24**(在降),
再往后 `bank_task` 从 50248 **骤降到 1338**。所以真实形态是:

    累积 → 某个持有者死亡/回收 → 断崖式释放 → 重新累积

推论随之改变:**IVAC 表只增不缩(`ivac_grow_table` 只 grow,空闲条目走 free list 复用),
所以决定生死的是"并发峰值"而不是"累计速率"**。当前负载下峰值约 5 万,离 524288 还有约 10 倍余量。
panic 意味着那一晚的峰值比现在高一个数量级。

因此"再过 N 小时就 panic"这种点估计一律不能报;能报的只有峰值和余量。

### 3.4 断崖释放 = 免费的点名机会(本单的方法论核心)

那次 50248→1338 的骤降,意味着**大约 4.9 万个 bank_account 是被同一批(很可能是同一个)刚刚退出的进程持有的**。
换句话说:

> 谁死的时候计数断崖式掉下来,谁就是持有者。

这给了一条**不需要 root 的 per-process 归因路径**:高频采样 `bank_task` + 全量 pid 快照,
一旦检测到断崖,就报出"这个采样间隔内消失了哪些 pid"。已写出原型并在跑。

这条路径比 `lsmp -a` 弱(只能在持有者死亡的瞬间抓到,抓不到"此刻谁持有最多"),
但它**不需要任何提权**,可以常驻。root 那条路仍然值得走,已就授权向 Tadashi 报备,不阻塞。

## 4. "是不是我们的锅"——目前的证据指向

倾向于**是我们的舰队放大的,但根因可能是 macOS 侧的回收缺陷**。理由:

1. **时间线强烈异常**。`last reboot` 显示:8 月 1 日 10:41 开机后连续跑到 **8 月 18 日 16:34,17 天没有 panic**;
   8 月 18 日 19:45 重新开机后 **29.8 小时就 panic**。同一台机器同一个 macOS,17 天 vs 30 小时。
   说明这不是长期常态,是最近变坏的。
2. **进程 churn 是数量级级别的**。panic 瞬间 1103 个进程;实测每 spawn 一个进程大致 +1 个 voucher/bank 条目
   (500 次 spawn 的对照实验里增量与 spawn 数同量级)。舰队是这台机器上唯一能制造这种 churn 的东西。
3. 但 **churn 本身不足以解释 10 倍峰值**。正常 churn 下有 GC 把它压回 1500。要打到 52 万,
   需要一个"持有着不放"的角色 —— 长命进程(Bridge / Lead / watcher / cmux)最符合。
4. 8 月 18 日之后新进场的执行器(bun 系 MCP、Antigravity、Kimi 等)是需要排查的新增嫌疑面,但目前**没有证据**,
   不能写成结论。

需要留意的反面:如果最终证明是纯 macOS bug,我们做的监控依然有价值(它是复发的唯一早期信号),
但"降 churn"这类缓解就白做了。所以本单**不承诺修根因**,承诺的是"看得见 + 抓得到 + 复发即告警"。

## 5. 本单要解决的问题(范围)

对齐 issue 的验收:「泄漏源定位(或排除我方进程)+ 复发监控就位(panic 报告出现即告警到 eng channel)」。

拆成三件:

- **A. 复发告警**:panic 报告一出现就告警。这是唯一 100% 能做到、且零争议的一件,优先级最高。
  注意 panic 报告是**重启后才落盘**的(本次 01:35 panic,07:09 才写盘),所以它天然是"事后"信号 ——
  它保证"再来一次我们立刻知道",但救不了那一次。
- **B. 早期预警 + 取证**:常驻采样 `bank_account` / `bank_task` 峰值,逼近 IVAC_ENTRIES_MAX 时提前告警;
  同时记录断崖事件与消失的 pid,积累归因语料。这是"救得了下一次"的那一半。
- **C. 定位**:用 B 采到的真实数据点名,或明确写下"排除我方进程"。**C 依赖 B 跑一段时间**,
  不可能在本节点内拿到最终结论 —— 这一点必须诚实地对 Lead 讲明,不能假装本单能结案。

## 6. 明确不做的

- **不改舰队并发/不降 churn**。issue 自己写了"同款 panic 再来一次就要动真格(降低 LS churn / 降 fleet 并发)",
  即"再来一次"才是那个扳机。现在就动会在没有归因的情况下损害产能。
- **不合并 FLY-1887**。issue 已明确:那单是冻死,这单是 panic,机理不同。
- **不上报 Apple**。同样是"再来一次"之后的动作,且需要归因数据支撑,现在报没有内容。
- **不碰 sudo / 不自扩权**。root 采样的授权已向 Tadashi 报备,等他的裁决。

## 7. 待 Lead 确认的开放问题

1. **root 授权**:是否允许在本机跑只读的 `sudo lsmp -a` 采样?有它能点名"此刻谁持有最多",
   没有它只能靠断崖归因(只在持有者死亡瞬间生效)。已发 ask,不阻塞。
2. **告警落点**:验收写的是 "eng channel"。现有两条既有通路 —— `lead-alert.sh`(Discord,带 claims.db 去重)
   与 `meta-alert.sh`(Discord 无关的兜底:桌面通知 + 本地文件)。panic 告警发生在**刚重启完**的时刻,
   Bridge 未必起来,倾向两条都走。需 Lead 拍板频道。
3. **告警 kind**:`lead-alert.sh` 的 `--kind` 是一个封闭枚举,新增 host 级 kind 需要动那张表;
   或者复用既有 kind。倾向新增,但这是会碰到共享文件的改动,先问。
