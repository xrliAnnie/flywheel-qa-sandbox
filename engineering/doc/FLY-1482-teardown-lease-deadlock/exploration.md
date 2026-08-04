# FLY-1482 test-teardown 拿不到 cmux mutator lease — 探索

Issue: FLY-1482 (https://linear.app/geoforge3d/issue/FLY-1482/p2qa房-test-teardown-永远拿不到-cmux-mutator-lease-测试-slot-无法清理资源永久泄漏)
日期: 2026-08-03
基于: 无

## 1. 问题重述(症状,不预设根因)

```
$ bash scripts/test-teardown.sh 3
[test-teardown] ERROR: cmux mutator lease is held by live mode=watch pid=40842; refusing teardown
[test-teardown] ERROR: unable to acquire qa_teardown mutator lease; no teardown action taken
```

生产的 `flywheel-cmux-sync --watch`(cmux 同步守护进程)在 `mode=watch` 下**持续持有**共享 mutator lease。只要生产 watcher 活着(launchd KeepAlive = 永远活着),`test-teardown.sh` 就永远拿不到 `qa_teardown` lease → QA 测试 slot 无法清理 → 资源永久泄漏。

每次 QA 房 smoke 的 cleanup 都在静默失败(`qa-fly-1189-room-smoke.sh:109` 的 cleanup trap 是 `>/dev/null 2>&1 || true`),没人发现。

## 2. 本机审计确认:这是「三层对着堵」,不是一个 bug

2026-08-03 在本机逐层复核(带行号,以当前 worktree 为准):

### 层 1 — 主 lease:watch 模式整个进程生命周期持锁

`flywheel-cmux-sync.sh:7219-7228`(`--watch` 分支)→ `acquire_watcher_lock`(:7166)→ `acquire_mutator_lease watch`,成功后 lease **只在 EXIT/INT/TERM trap 里释放**。watch 模式没有任何「干完一轮活让出锁」的语义 —— 这是 FLY-1272 的刻意设计(所有 shell mutator 共享一把 incarnation-bound lease,排他到进程级)。

而 `test-teardown.sh:67-84`(`acquire_cmux_teardown_lease`)读到 live owner 直接拒绝(:71-73,就是症状里第一行 ERROR)。**没有任何让 watcher 让出 lease 再拿回来的握手协议。**

### 层 2 — reap mutex:锁类型不匹配(FLY-1608 QA 定位的根因)

同一个路径 `${LOCK_DIR}.reap`,两边用两种不兼容的锁语义:

* `test-teardown.sh:86` — `mkdir "$CMUX_MUTATOR_REAP_MUTEX"`,**目录式互斥**(存在即持有)
* `flywheel-cmux-sync.sh:6903-6944`(`_acquire_reap_mutex`)— `exec 9>>"$WATCHER_REAP_MUTEX"` + `lockf -s -t 0 9` / `flock -n 9`,**retained-file + 内核 advisory lock**(文件常驻,锁在 fd 上)

flock/lockf 语义下文件**永不删除**(这正是它的设计点:没有 stale 文件要比较/清理)。所以只要 cmux-sync 在这台机器上跑过一次 lease 重建,`.reap` 文件就永久存在 → teardown 的 `mkdir` 必失败(EEXIST)→ 报 `cmux mutator lease transition is busy`。**100% 确定性失败,永不自愈。**

本机今天实测:`/tmp/flywheel-cmux-watcher.lock.reap` 是一个 0 字节普通文件(Aug 1 生成),watcher pid 1752 活着持有主 lease(owner: `1752|Sat Aug 1 10:45:06 2026|watch|...`)。两层全部当场复现。

注意方向性:cmux-sync 侧**有** legacy mkdir-目录形态的 upgrade 路径(:6907-6917,census 门控后 rmdir 升级);teardown 侧对 flock-file 形态**没有**任何兼容 —— 单向兼容,断裂点在 teardown。

### 层 3 — maintenance marker 反向互锁

* `test-teardown.sh:657-663` — maintenance marker 存在 → **拒绝整个 teardown**
* `flywheel-cmux-sync.sh` — marker 是让 watcher 停止 mutation 的唯一通道;但当前实现里,**运行中的** watcher 看到 marker 只是让各 tick 函数 no-op(:978, :6233, :6282),lease 依然攥在手里;marker 只在 watcher **启动入口**(:7223 `maintenance_entry_allowed`)拦得住新实例

即:哪怕想借 marker 让 watcher 让路,(a) 运行中的 watcher 根本不放锁,(b) 就算放了,teardown 自己又会因为 marker 存在而拒绝干活。两边对着堵。

## 3. 现实代价

* `scripts/pre-ship-check.sh:63,68` 直接调用 `test-teardown.sh` → E2E 后清理必失败
* `scripts/qa-fly-1189-room-smoke.sh:109` cleanup trap `|| true` → 每次 smoke 留一份残留,静默
* 手工 kill 残留进程撞 FLY-913 restart-guard(PreToolUse hook,禁止 agent 会话手工 kill 生产形态进程)→ 被认可的清理路径只有 teardown 脚本本身,而它坏了
* Issue 里的实锤残留(slot 3 / port 19873 / pid 60450)在 2026-07-24 空跑 3h33m;今天实测该残留已被当晚的绕行手段清掉(port 19873 无监听)

## 4. 方案空间

### 方案 A(推荐)— 统一锁语义 + marker 让锁握手

三件事配套做:

1. **reap mutex 统一成 cmux-sync 的 retained-file + lockf/flock 语义**(teardown 侧改),含 legacy 目录形态的 census 门控升级 —— 修死层 2。
2. **watcher 学会在 marker 下让出 lease**:watch_loop tick 顶检测 marker → release lease → parked(空转等待,定期 log)→ marker 清除 → 阻塞式重新 acquire → additive resync → 恢复 —— 打开层 1。
3. **teardown 用「自有结构化 marker」驱动握手**:放自己的 marker(带 owner pid|incarnation|nonce)→ 有界等待 watcher 让锁 → 以 qa_teardown 身份拿 lease → 清理 → 放锁 → 撤 marker。foreign marker(裸 touch / 别人的迁移窗口)依旧拒绝 —— 层 3 的保护语义保留,只是不再误伤自己。

优点:保持 FLY-1272「单一全局 mutator lease」不变(不重新打开它修掉的并发冲突类);复用 marker 这个既有的「禁止 mutation」通道而不是发明新协议;全程 fail-closed(超时 → 大声失败;foreign marker → 拒绝)。
缺点:要动 watcher(长驻进程,ship 时需受控重启才生效);跨两个脚本的锁兼容性需要契约测试钉死。

### 方案 B — teardown 绕开锁(私有命名空间)

QA 当晚的临时绕行:`FLYWHEEL_CMUX_WATCHER_LOCK_DIR` 指向私有路径。作为正式修法**不可接受**:生产 tmux/cmux 是共享面,绕开锁 = 两个 mutator 并发肆意 mutate 同一个全局 tmux/cmux 面,恰好重新引入 FLY-1272 修掉的整类冲突(watcher sweep 撞上 teardown 半途状态)。仅保留为紧急逃生手段。**拒绝。**

### 方案 C — 域分锁(test-slot 面单独一把锁)

理论上 teardown 只动 test-slot 自己的 session/window,可以按域拆锁。但 watcher 的 sweep(ghost reaping、orphan-pin reaping、dedup)是全局扫描,会看到并可能处置 test-slot 的 session —— 域边界在 watcher 侧并不存在,拆锁等于放弃互斥。且直接违背 FLY-1272 把锁收成一把的设计动机。**拒绝。**

### 方案 D — 信号协议(SIGUSR1 让锁 / SIGUSR2 恢复)

bash trap 的信号处理在命令边界才执行,时序上可行,但要发明一条新的进程间协议,且信号无 durable 痕迹、崩溃后无从判断状态。marker 文件已经是既有的、durable、可观测的「禁 mutation」通道。**拒绝。**

### 方案 E — teardown 杀掉 watcher 再清理

撞 FLY-913 护栏的精神(禁止旁路 kill 生产进程),且 launchd KeepAlive 会立刻重启 watcher,窗口内还会跟 teardown 抢锁重建。**拒绝。**

## 5. 结论

采用方案 A。三处改动(teardown 锁语义、watcher marker-yield、teardown 握手编排)+ 调用方可观测性 + 锁兼容契约回归测试。详细可行性核对见 research.md,实施拆分见 plan.md。

同族提醒(出界,不在本单):FLY-1618 的 scheduler mutation 锁无主楔死 —— 本仓锁机制已出两类缺陷,共享锁原语库的抽取值得单独立项(与 FLY-1577 watcher bin closure 的单文件闭包约束一起权衡)。
