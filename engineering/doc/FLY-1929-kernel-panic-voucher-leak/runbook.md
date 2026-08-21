# FLY-1929 IPC voucher / 内核 panic — 运维 runbook

Issue: FLY-1929 (https://linear.app/geoforge3d/issue/FLY-1929/infra宿主-内核-panic-致-0135-全机重启-ipc-voucher-泄漏打满-ivac-entries)
日期: 2026-08-20
基于: as-built.md(实现权威), plan.md(设计史)

## 0. 一分钟版

- **谁在攒**:macOS 自带的 `ecosystemanalyticsd`。2026-08-20 07:34 的 root `lsmp -a` 快照里它持有
  **47524 / 49816 = 95.4%** 的 voucher。**我们自己的进程人均约一条,完全正常,已被排除。**
- **为什么会 panic**:BANK 的 ivac 表撞上 `IVAC_ENTRIES_MAX = 524288`。表只增不缩,
  但释放的条目回 freelist 可复用 ⇒ **决定生死的是同时在手的存活条目数,不是累计速率。**
- **倒计时挂在哪**:挂在 `ecosystemanalyticsd` 的**进程年龄**上,不是机器开机时长。
  它一重启,持有量清零(实测 5 万 → 552)。
- **谁在兜**:root 守卫 `com.annie.voucher-guard`(**不是我们做的**,已在生产),
  `bank_task` 超 200000 就重启 `ecosystemanalyticsd`,实测约一小时一轮。见 §3。
- **我们做了什么**:`com.flywheel.voucher-watch`,每分钟一次的**只读看守**。它盯三件事 ——
  那个 root 守卫还在不在、`bank_task` 有没有涨过它本该动手的水位、有没有新的 voucher panic 报告。
- **我们没有做什么**:**任何自动补救**。补救是上面那个守卫的事,不是我们的。

## 1. 日常:看一眼现在什么情况

    bash ~/Dev/flywheel/scripts/flywheel-voucher-watch.sh status

输出会给出 `bank_task`(**告警判据用的就是它**)、root 守卫的触发点与我们的两条阈值、
三个原始 zone 数与上包络、`ecosystemanalyticsd` 的实例数与 pid,以及那个 root 守卫在不在。

原始时间序列(**下一次事故的 before 基线**,这次我们就是因为没有它才答不出「哪个改动引入的」):

    ~/Library/Logs/flywheel/voucher-watch.ndjson

> **告警判据是 `bank_task`,故意跟 root 守卫用同一个数**,所以一条告警的含义就是
> 「它本该在 200000 动手,它没动」。阈值 warn 260000 / severe 350000 都**高于**它的触发点,
> 因此健康的一小时周期(峰值约 204k)永远不告警。
> `bank_task + bank_account` 这个上包络仍然记进遥测(字段 `envelope`),但**不参与判据** ——
> 它在健康周期里就会到约 407k,拿它当判据等于每小时刷两条。标定过程见 `calibration-derivation.md`。

## 2. 手工动作前后请打标记

任何会大量 attach pane / 起停进程的手工操作,前后各打一次标记,否则事后没法把人为抬升和真实泄漏分开
(实测每个 tmux attach client 约 +430;我自己有一次速率读数就是被这个污染掉的):

    bash ~/Dev/flywheel/scripts/flywheel-voucher-watch.sh mark "开始手工 attach"
    ... 手工操作 ...
    bash ~/Dev/flywheel/scripts/flywheel-voucher-watch.sh mark "结束手工 attach"

标记只是往同一份 NDJSON 里追加一行,**不参与任何告警判据**。
(attach 造成的尖峰本来也够不到 260000 这条线,所以它不会把告警刷起来。)

## 3. 遏制动作 —— **已经在生产,不是待办**(2026-08-20 更正)

### 3.1 我之前写错了什么

本文件早先写「重启 ecosystemanalyticsd 是候选动作,需要 root + founder 拍板」,
并把 07:35 那次持有量归零说成「**自然**重启」。**两句都是错的。**

真相(Tadashi 转述,我独立复核过):

- 遏制**早就装好了**,而且不是我们做的:root LaunchDaemon **`com.annie.voucher-guard`**
  (Mufasa / Annie 于 2026-08-20 07:31 装),跑 `/usr/local/sbin/voucher-guard.sh`,
  每 60 秒查一次 `bank_task`,**超过 200000 就 kickstart `ecosystemanalyticsd`**。
- 07:35 那次归零**就是它开的火**。我当时把「pid 616 消失、新 pid 83903 生于 07:35:25」
  读成了自发行为 —— 那其实是它的 kickstart 结果。

我复核到的实测证据(`/var/log/voucher-guard.log`):

    07:35:22 bank_task=51143  -> restarting ecosystemanalyticsd ; 07:35:30 =1056 (ok)
    10:03:14 bank_task=201218 -> restarting ecosystemanalyticsd ; 10:03:23 =1375 (ok)
    11:06:02 bank_task=204349 -> restarting ecosystemanalyticsd ; 11:06:11 =1154 (ok)

`launchctl print system/com.annie.voucher-guard` 显示 `runs=274`、`last exit code = 0`。
**所以 panic 的倒计时目前是被兜住的,大约一小时一个周期。**

### 3.2 于是真正的残余风险变成了:**那个守卫自己悄悄死掉**

它一死,占用量就再没人清,机器重新走向 panic,而且**没有任何人会收到通知**——
它自己不发告警。这正是本单这个 watcher 存在的理由,也是它盯的**第一等指标**。

### 3.3 一个留给运维的疑问(是疑问,不是结论)

那个守卫拿 **`bank_task` 单独一个数**跟 `IVAC_ENTRIES_MAX = 524288` 比,阈值 200000,
看起来还剩约 60% 余量。但实测在高占用区 `bank_account` 与 `bank_task` **几乎相等**
(11:06 那次 bank_task=204349,同期两者只差约 950)。
而 BANK 的 ivac 条目**两类对象都算**,所以存活条目数的上包络是
`bank_task + bank_account ≈ 407000`,也就是**约 78% 的天花板**,不是 39%。

⇒ 真实余量落在 22% 到 61% 之间(取决于有多少 zone 对象真的被 intern 成 voucher 值)。
**这不是「守卫设错了」的结论**——我没有证据说它必须改;
但「200000 out of 524288」这个说法可能比实际乐观,值得那个守卫的作者复核一次阈值。

### 3.4 需要人手动跑那条命令的场合

正常情况下**不需要**,守卫会自己做。只有当守卫已经死了、又来不及修的时候,由人在裸终端执行:

    sudo launchctl kickstart -k system/com.apple.ecosystemanalyticsd

**为什么必须人来跑,而不是 agent 跑 Bash**:需要 root,而 runner 没有、也不该有 root。

顺带更正另一处我写错的说法:仓库里 FLY-913 那道部署护栏**并不会**拦上面那条命令 ——
它的规则是 `launchctl` + 变更类子命令 **并且**同命令里出现 `com.flywheel.` 或
`restart-services` / `self-ship-restart` / `update-flywheel` 这类标识;`com.apple.*` 两者都不匹配。
我用阴性 / 阳性两个探针实测确认过(而且写这份 runbook 时又被它拦了一次 ——
因为这段文字里同时出现了那两个 token,算第三次独立确认)。
**拦住那条命令的是权限,不是护栏。**

### 3.5 验收这次动作

跑之前先 `status` 记下 `bank_task`;跑完等 30 秒再 `status`。预期它断崖式下降到千位数。
若没有下降,说明持有者已经不是 `ecosystemanalyticsd` 了 —— 那就要重做 §5 的点名。

## 4. 告警投递坏了怎么办

**这个 watcher 不保存任何投递状态。**去重与重投全部是 `lead-alert.sh` 的事
(它有永久回执表 `alert_deliveries`、spill queue、死信和 drain)。
watcher 只做一件事:调用它,然后按 stdout 那一行**和**退出码一起判断要不要在本地留个痕。

| 结果 / 退出码 | watcher 的处置 |
|---|---|
| `sent` / 0、`queued_transient` / 2、`duplicate` / 0 | 视为已交付,什么也不做 |
| 其它一切(`config_error`、`dead_lettered`、空输出、超时) | 调一次 `meta-alert.sh` 留本地痕迹,并在 stderr 打一行 |

`meta-alert.sh` 是桌面通知 + 本地文件,**永远 exit 0、best-effort**,
**绝不能拿它当「eng 频道已收到」的证据**。它只是「投递这条路自己坏了」的提示。

### 4.1 怎么让一条没送出去的告警重来

因为 watcher 无状态,恢复只需要处理 `lead-alert.sh` 那一侧:

- **占用量类**(`bank-task-high:<level>:<日期>`)与**守卫失踪类**(`guard-absent:<日期>`):
  signature 带日期,所以**第二天会自动重发**,只要问题还在。急着让它今天重发,
  就清掉 `alert_deliveries` 里对应的那条永久回执。
- **panic 类**(`panic:<报告文件名>`):signature 是文件名,**设计上就是永久一次**。
  要让它重发,只能清掉那条永久回执。

> 判断「今天到底有没有发出去过」,看 `alert_deliveries` 与 `~/.flywheel/alerts/claims.db`,
> **不要**去 watcher 那边找状态 —— 它没有。

## 5. 换了持有者怎么重新点名

常驻守卫**不含** root 采样,所以它只能告诉你「涨了」,点不了名。重新点名需要一次性的 root 走查:

    sudo lsmp -a > /tmp/fly1929-lsmp.txt

然后按**每个进程末尾汇总块里的大写 `VOUCHERS =` 行**解析(注意:文件里 grep 不到小写的
"voucher" 字样,当初就卡在这里):

    python3 - <<'PY'
    import re, collections
    cur=None; rows=[]
    pat=re.compile(r'^Process \((\d+)\) : (.*)$')
    for line in open('/tmp/fly1929-lsmp.txt', errors='replace'):
        m=pat.match(line)
        if m: cur=(int(m.group(1)), m.group(2).strip()); continue
        if line.startswith('VOUCHERS') and cur:
            rows.append((int(line.split('=')[1]),)+cur); cur=None
    rows.sort(reverse=True)
    print("total", sum(r[0] for r in rows))
    for n,pid,name in rows[:15]: print(f"{n:8d}  pid {pid:7d}  {name}")
    PY

**第二条不需要 root 的点名路径(断崖归因)**:高频采 `bank_task` 同时记全量 pid 快照,
一旦计数断崖式下降,就看这个间隔内消失了哪些 pid —— 谁死的时候计数掉下来,谁就是持有者。
2026-08-20 就是用这条独立验证了 lsmp 的结论(pid 616 消失 ↔ 释放约 48300)。

## 6. 会过期的结论(带 as-of,别当永久真理)

| 结论 | as-of | 怎么重核 |
|---|---|---|
| 持有者是 `ecosystemanalyticsd`(95.4%) | 2026-08-20 07:34 快照 | §5 重跑一次 lsmp 解析 |
| `IVAC_ENTRIES_MAX = 524288` | xnu `main` / `xnu-12377.121.6` | 换 macOS 大版本后重查 `osfmk/ipc/ipc_voucher.h` |
| 分子 = `bank_task + bank_account` 是上包络 | 720 样本 @ 2026-08-20 | 见 `calibration-derivation.md`,换内核后重做 |
| 阈值 warn 260000 / severe 350000(判据 = `bank_task`) | 相对 root 守卫 200000 触发点定的**策略取值** | root 守卫改阈值、或健康周期峰值变了,就要跟着重定 |
| 健康周期峰值约 204k、约一小时一轮 | 2026-08-20 三次开火 | 重读 `/var/log/voucher-guard.log` |
| 「我们的进程人均一条」 | 2026-08-20 快照 | §5 重跑;新执行器(agy/kimi 等)进场后尤其要重核 |
| 源码结论适用于宿主构建 | **推断**,非验证 | 宿主是 `xnu-12377.161.14`,评审期只拿得到邻近修订 |
