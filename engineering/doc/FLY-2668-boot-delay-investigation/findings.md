# FLY-2668 — Mac 重启 30 分钟取证结论

**日期**: 2026-09-17 · **性质**: 纯只读调查,无代码改动
**founder 报告**(7 天有效): https://fw-reports-42fba7.vercel.app/r/2e9df0a2ebe848dacaee4deea2b556bf/

## 三句话

1. **卡在哪**:不是等输密码,也不是登录后。卡在 **密码被接受(09:53:34 PT)→ 真正用户态启动(10:23:25 PT)** 之间的 **29 分 52 秒**。Data 卷在密码通过后 1 秒就挂好了,登录后到桌面只用 7 秒。
2. **是不是我们造成的**:**直接不是** —— 该窗口内 macOS 用户态尚未启动,39 个 `com.flywheel.*` 全是 `gui/501` 用户级 agent,`/Library/LaunchDaemons` 无 Flywheel 条目。**间接是** —— 同一段在最近四次重启是 9s → 22s → 5m19s → 29m52s,与连续运行时长(<1d / 1.3d / 6.9d / **21.4d**)单调同向。
3. **怎么避免**:重启周期压到 ≤7 天;重启前腾出 Data 卷空间(重启前仅约 41 GB 可用 / 87% 满);有序停 Flywheel 再重启。

## 关键时刻(PT)与证据

| 时刻 | 事件 | 证据 |
|---|---|---|
| 08:54:25 | macOS 判定关机超时,抓 shutdown stall | `DiagnosticReports/shutdown_stall_2026-09-17-085441…`(`spindump -i` 解出 Time Since Boot 1850108s = 21.4 天) |
| 08:54:27 | 209 个进程逐个抓诊断后超时 | `/var/log/shutdown_monitor.log` |
| 08:55:11 | 内核启动 | `kern.boottime` / `last reboot` / 内核 uptime 反推 |
| 08:55:16 | FileVault 预登录环境 logd 起来 | `Preboot/<UUID>/PreLoginData/diagnostics/logd.0.log` `15:55:16+0000` |
| 09:53:34 | **密码被接受**,预登录环境被拆除 | 同上 `16:53:34+0000` "No userlevel firehose clients left";`shutdown.0.log` 同刻落盘 |
| 09:53:35 | Data 卷已解锁可写 | `/private/var/run/syslog` birthtime |
| 09:53:35→10:23:25 | **黑盒 29m52s**:两套日志库 0 条记录,Data 卷只多出上面那一个 socket | `log show` 该区间 0 行;`find -newermt` 全盘扫描 |
| 10:23:25 | 用户态启动 | `pmset -g log` "powerd process is started" |
| 10:23:26 | fsck_apfs 全部 QUICKCHECK CLEAN,<1s | `/var/log/fsck_apfs.log` |
| 10:23:31 | Finder / 桌面 | 统一日志 |
| 10:23:39–40 | 23 个 flywheel agent 同一秒拉起 | launchd "Successfully spawned" |
| 10:36–10:38 | apfsd 全盘 `fts_read` 遍历,76% CPU | `apfsd_2026-09-17-103828.cpu_resource.diag` |

## 已排除

OS 更新(前后都是 25G83,无暂存更新)· kernel panic(无 panic 文件)· fsck 长跑(<1s)· 登录项/keychain/网络超时(7s 进桌面)· Flywheel 任务(窗口内无用户态)。

## 最可能机制(未验证)

APFS 挂载后在内核里清算待回收块(free queue)。旁证:登录瞬间可用空间 41 GB → 约 91 GB,20 分钟内再到约 135 GB。**该窗口无任何日志(预登录日志库已拆、主日志库未起),所以这是推断不是证据。** 要证实只能开 verbose boot(`sudo nvram boot-args="-v"`,需 founder 执行)。

## 关联

FLY-2636(swap 打满 / fseventsd 6 GB / 当日 4 次 OOM)· FLY-2664。
