# FLY-1929 独立复核与范围裁决

Issue: FLY-1929 (https://linear.app/geoforge3d/issue/FLY-1929/infra宿主-内核-panic-致-0135-全机重启-ipc-voucher-泄漏打满-ivac-entries)
日期: 2026-08-20
基于: plan.md, runbook.md

Tadashi 的转向令要求「先独立复核 Mufasa 三条数据再落 plan,引用他的结论时注明来源」。这是复核结果。

## 1. 复核 Mufasa 的三条数据

来源:Mufasa / Annie(经 Tadashi 转述)。以下是**我自己在本机重测**的结果。

### 1.1 「泄漏者 = ecosystemanalyticsd」 ✅ 独立证实(而且我是先于转述独立得到的)

我在收到转述**之前**就用两条独立方法得到同一结论:解析 root `lsmp -a` 转储
(47524 / 49816 = 95.4%),以及断崖归因(pid 616 死亡 ↔ 释放约 48300)。与他一致。

### 1.2 「杀掉它 bank_task 51143 → 1056」 ✅ 证实,且不止一次

`/var/log/voucher-guard.log` 里有三次,我逐行核过:

    07:35:22  51143 -> 1056
    10:03:14 201218 -> 1375
    11:06:02 204349 -> 1154

**顺带纠正我自己的一处错误**:我先前把 07:35 那次写成「自然重启」。它不是 ——
它是 root LaunchDaemon `com.annie.voucher-guard` 的 kickstart。已在 runbook §3.1 更正。

### 1.3 「Rosetta 放大器」 ✅ 证实

- `/usr/local/bin/tmux` 是 `Mach-O 64-bit executable x86_64`,而它在 PATH 里排在
  `/opt/homebrew/bin` **前面**;
- 我自己这个 runner shell 实测 `sysctl.proc_translated = 1`;
- 因此 tmux server 及其整棵子树的通用二进制都按 x86_64 切片启动。

### 1.4 「fork 速率 ~300/s」 ⚠️ **既不能证实也不能证伪** —— 我的方法只给下界

用 pid 集合差分测,把采样间隔逐档收细:

| 采样间隔 | 窗口 | 观测到的新 pid | 速率下界 |
|---|---|---|---|
| 0.4 s | 16 s | 423 | ≥ 27.1 /s |
| 0.2 s | 15 s | 520 | ≥ 34.0 /s |
| 0.05 s | 15 s | 591 | ≥ 39.2 /s |

**估计值随采样变细而单调上升,还没有收敛**,说明活不满一个采样间隔的进程被系统性漏掉了。
所以我能说的只有「至少 39/s」,**推不出**「就是 300/s」,也**推不翻**它。

要真正量到 exec 速率需要 `execsnoop` / dtrace 一类的内核探针,而那受 SIP 限制。
⇒ 引用「~300/s」时请注明**来源是 Mufasa,不是我复核过的数**。
(附带:这个量级不影响任何结论 —— 泄漏源、遏制手段、告警设计都不依赖它。)

## 2. 复核 Cass 的「cmux-sync 占 ~27% churn」 ✅ 数量级一致

我做了独立归因:每 0.05 秒抓一次 `pid,ppid,comm`,对每个新 pid 向上回溯最多 5 层祖先,
判断是否出自 `flywheel-cmux-sync`。

    窗口 40 s,新 pid 共 1692(≥42.1/s)
      cmux-sync    385  (22.8%)
      其它        1307  (77.2%)

**22.8% vs 她的 27%** —— 同一量级,方法不同(她按进程类别,我按祖先链),互相印证。

## 3. D② 的裁决:**我建议不放进本 PR**,请 Tadashi 定夺

转向令把「`flywheel-cmux-sync --watch` 降频或改事件驱动」列为本单 PR 的改动。
我做了功课之后**反对在本 PR 里做**,理由如下,数据都在上面。

### 3.1 它已经是事件驱动的

`scripts/flywheel-cmux-sync.sh` 头部第 4 行写着:
`--watch: event-signaled polling (15s event drain + 60s additive scan)`,即 FLY-102 已经把它
从纯轮询改成了事件驱动。剩下的开销是那个 15 秒的兜底 drain,**不是**一个还没做的架构升级。

### 3.2 收益算得出来,而且很小

- cmux-sync 占 churn 的 22.8%(§2 实测)。
- 就算把它**砍掉一半**,总 churn 只降约 11%。
- 生产的遏制守卫当前约 **60 分钟**一个周期;降 11% 之后约 **68 分钟**。

**它不改变会不会 panic** —— 决定这件事的是 `com.annie.voucher-guard` 有没有在跑。
换句话说 D② 是在给一个**已经被兜住的**问题做边际优化。

### 3.3 代价不小

`flywheel-cmux-sync.sh` 有约 9800 行,而且 15 秒这个节拍是**写进契约的**:
`scripts/flywheel-cmux-sync.sh:7262` 明确写着 "events drain within 15s of firing"。
这个文件近期连着出过事:FLY-1482(lease / handoff 死锁)、FLY-1596(侧栏重建)、
FLY-1672(tmux 3.5a display-message 回落语义)、FLY-102(事件架构本身)。
`sleep_seconds=15` 是硬编码的(`:8527`、`:8586`),**没有现成的 env 旋钮**,
所以改它就是改核心循环的默认节拍,并让若干处注释与时序假设失效。

### 3.4 我的建议

**单独开一单**,带自己的 QA(至少要在隔离 socket 上重跑 `test-cmux-sync`,
它有 570 个用例,正是为这类改动准备的),而不是搭在一个已经在评审中的 PR 上。

如果 Tadashi 仍然要求放进本 PR,我照做 —— 但需要他明确知道上面三条,
尤其是「收益 11%、不改变 panic 与否、动的是刚出过四次事的文件的核心循环」。
**这是范围建议,不是拒绝执行。**

## 4. 另一件我认为该上报而不是自己拍板的事

生产守卫拿 `bank_task` 单独一个数对 `IVAC_ENTRIES_MAX = 524288` 比,阈值 200000。
但 BANK 的 ivac 条目 `bank_task` 与 `bank_account` **两类都算**,而实测在高占用区两者几乎相等
(11:06 那次 204349,同期两者差约 950)。所以存活条目的上包络约 **407000 ≈ 78% 的天花板**,
不是它框架里暗示的 39%。

真实余量在 22%–61% 之间。**我没有证据说那个阈值必须改**,但「200000 out of 524288」
这个说法可能比实际乐观。建议转给那个守卫的作者复核一次 —— 详见 runbook §3.3。

## 5. Code review round 4 —— 未关闭的 findings(交接点)

HEAD `cb9c95e53`,41/41 用例在 bash 3.2 与 bash 5 下全绿,全仓 lint/build 与三道守卫都绿。
但 codex code review 第 4 轮仍是 CHANGES REQUESTED,以下**尚未修复**,带 Codex 给的复现:

1. **BLOCKER 扫描饥饿仍在(反方向)**。我把 `n++` 移到了 symlink/seed 过滤之后,但**仍在匹配之前**,
   所以「不相关的 panic 报告」照样吃预算。newest-first 只解决了一个方向:
   造 1 份**较老**的 voucher 报告 + 25 份**较新**的干净报告 ⇒ 两个 tick 之后 `posts=0`。
   C8 把 voucher 报告放在最新,所以测不到这个反向饥饿。
   **代码注释里「cap 在过滤之后」这句话是错的,必须一并改掉。**
   Codex 明确说:只把 `n++` 挪到匹配之后**不够**(会让遍历无界),要么无状态轮转窗口 + 最新优先通道,
   要么给扫描一个**专属的**小游标(注意:那是扫描的游标,不是投递状态,不违反「无跨 tick 状态」的裁决)。

2. **BLOCKER 目录不可读仍被当成空**。`[ -d ]` 只证明它是目录;`ls ... || true` 把枚举失败吞掉,
   空输出被当成成功。把目录 chmod 000 之后:watcher 正常退出、**零 meta 面包屑**。
   这正是三值设计本来要消灭的静默丢失。要区分「合法的空目录」与「枚举失败」。

3. **BLOCKER matcher 仍有假阴/假阳**。它不做结构化 JSON 解析,冒号只能证明是 key 形状、
   证明不了对象深度;而且 `find_panic_string()` 在**第一个**完整的 key-like 值处就返回了,
   与我写的「扫描每一处」注释矛盾。Codex 在 `/usr/bin/python3` 3.9.6 上的实测:
   - `{"panicString":"unrelated","panicString":"<marker>"}` → rc=1(假阴)
   - 两个 JSON 对象拼接、marker 在第二个 → rc=1(假阴)
   - `{"nested":{"panicString":"<marker>"},"panicString":"unrelated"}` → rc=0(假阳)
   - `_` 转义形式的 marker → rc=1(我故意不解码 `\uXXXX`,这是代价)
   ⇒ 应当真正按「拼接的 JSON 对象」结构解码(`json.JSONDecoder().raw_decode` 逐个对象),
   只取**顶层**的 `panicString`,并解码转义。

4. **HOME 那条 Codex 已按我的论证撤销**(用户域 LaunchAgent,launchd 会给 HOME)。

5. **共享文件的两个契约缺口我没有动**(claims.db 不可用时 lead-alert.sh fail-open 直发、
   TS drain 不回写 `alert_deliveries`)。它们在 `lead-alert.sh` 与 `LeadAlertNotifier.ts` 里,
   属于别的组件的既有缺陷,按「范围冲突上报不自扩权」留给 Lead 裁决,**不在本单改**。
