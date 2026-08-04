# FLY-1482 test-teardown 拿不到 cmux mutator lease — 调研

Issue: FLY-1482 (https://linear.app/geoforge3d/issue/FLY-1482/p2qa房-test-teardown-永远拿不到-cmux-mutator-lease-测试-slot-无法清理资源永久泄漏)
日期: 2026-08-03
基于: exploration.md

本文核对方案 A(统一锁语义 + marker 让锁握手)的每个技术前提,全部基于本机当日实测与逐行代码审计。

## 1. 涉事代码清单(当前 worktree 行号)

| 位置 | 内容 |
|---|---|
| `scripts/test-teardown.sh:27-32` | lease 路径/reap 路径/marker 路径定义(全部有 env override) |
| `scripts/test-teardown.sh:46-58` | `read_cmux_mutator_owner` — 解析 4 字段 owner 文件 `pid\|incarnation\|mode\|nonce`,mode 白名单含 `qa_teardown` |
| `scripts/test-teardown.sh:67-117` | `acquire_cmux_teardown_lease` — live owner 拒绝(:71-73);**:86 `mkdir` reap mutex(缺陷点)**;stale/malformed 分类;拿锁后写 owner |
| `scripts/test-teardown.sh:119-128` | `release_cmux_teardown_lease` — own 验证(pid+incarnation+nonce)后 rm;**:127 无条件 `rmdir` reap(配套要改)** |
| `scripts/test-teardown.sh:649-663` | main:拿不到 lease → exit 1;**:660 marker 存在 → 拒绝整个 teardown(反向互锁点)** |
| `scripts/flywheel-cmux-sync.sh:107-109` | `WATCHER_LOCK_DIR`(默认 `/tmp/flywheel-cmux-watcher.lock`)+ `WATCHER_REAP_MUTEX`(`${LOCK_DIR}.reap`) |
| `scripts/flywheel-cmux-sync.sh:6903-6944` | `_acquire_reap_mutex` — **retained-file + fd 9 + `lockf -s -t 0` / `flock -n`**;:6907-6917 legacy mkdir-目录形态的 census 门控升级;symlink/怪节点 fail-closed |
| `scripts/flywheel-cmux-sync.sh:6707-6731` | `_snapshot_live_mutator_processes` — 两次快照 census,配 `_mutator_command_matches`(:6664)识别 live mutator 进程 |
| `scripts/flywheel-cmux-sync.sh:6952-7033` | `acquire_mutator_lease` — 所有 lease 创建/重建都在 reap mutex 临界区内;stale owner 走 census rebuild(dead-owner lease 可自愈重建) |
| `scripts/flywheel-cmux-sync.sh:7044-7052` | `release_mutator_lease` — own 验证后 `rm -rf $WATCHER_LOCK_DIR`(→ 让锁后 lease 目录**整个消失**) |
| `scripts/flywheel-cmux-sync.sh:7067-7083` | `maintenance_entry_allowed` — 仅入口生效;supervised watch 等 marker 清除,其它模式直接不启动 |
| `scripts/flywheel-cmux-sync.sh:6385-6439` | `watch_loop` — 15s tick(degraded 退避至 300s;`reopen_aware_sleep` 已有切片机制);tick 内各函数(:978/:6233/:6282)见 marker no-op **但不放锁** |
| `scripts/flywheel-cmux-sync.sh:7166-7204` | `acquire_watcher_lock` — supervised(launchd)拿不到锁就循环等;unsupervised exit 0 |
| `scripts/flywheel-cmux-sync.sh:7212-7216` | `BASH_SOURCE` guard — 脚本可被 source(现有测试 harness 就这么用),只有直接执行才进 case dispatcher |
| `scripts/pre-ship-check.sh:63,68` | 两处直调 teardown;脚本 `set -euo pipefail` |
| `scripts/qa-fly-1189-room-smoke.sh:109` | `cleanup() { bash test-teardown.sh "$SLOT" >/dev/null 2>&1 \|\| true; }` — 完全静默 |

## 2. 本机实况(2026-08-03 实测)

```
/tmp/flywheel-cmux-watcher.lock/          目录,owner: 1752|Sat Aug  1 10:45:06 2026|watch|1785606310-1752-20298
/tmp/flywheel-cmux-watcher.lock.reap      0 字节普通文件(Aug 1 生成 — lockf retained-file 形态)
pid 1752                                  /bin/bash ~/.flywheel/bin/flywheel-cmux-sync --watch(活着,launchd 管;当日 11:00 经 Annie 直令更替为 pid 44797,见 §2.1)
~/.flywheel/bin/flywheel-cmux-sync        symlink → ~/Dev/flywheel/scripts/flywheel-cmux-sync.sh(主仓 main checkout)
锁工具                                     /usr/bin/lockf 存在;flock 不存在(brew 未装)
maintenance marker                        不存在
port 19873(issue 里的实锤残留)             已无监听 — 原始残留已被 FLY-1608 当晚绕行清掉
```

### 2.1 生产实锤:长寿 watcher 的租约验证衰减(2026-08-03,Lead 指令 `1ae9fe17-c170-46b1-aed9-77d71b5089ac`)

Annie 直令下生产 watcher 完成进程更替(老 pid 1752 结束,launchd KeepAlive 30s 内拉起新 pid 44797,11:00 起)。前后对照:

* **老进程(活约 2 天)**:每 60s 无限循环 `Creating workspace → OK → ledger upsert refused: current process does not hold the verified mutator lease → rolling back`,**同时**对 `--once` 模式宣称自己是 owner —— 「持有判定」(`_owner_process_matches` 拒他人)与「验证判定」(`assert_or_reuse_owned_lease` 拒自己)两套谓词给出矛盾答案;
* **新进程**:第一轮就把积压的两个 workspace(1482/1624)全部建成 + ledger 落账成功,零回滚。

同日本机交叉验证发现了**可能的机制 —— incarnation 的 `ps -o lstart=` 渲染是 TZ 依赖的**:

```
pid 44797 owner 文件 incarnation:  Mon Aug  3 16:59:57 2026     (watcher 自己写入)
交互 shell `ps -o lstart= -p 44797`: Mon Aug  3 10:59:57 2026   (差 6 小时)
pid 1752 当时 owner 文件:           Sat Aug  1 10:45:06 2026
交互 shell 当时 `ps`:               Sat Aug  1 11:45:06 2026    (差 1 小时)
```

同一进程的「出生时刻」被不同 TZ 环境渲染成不同字符串 → 跨进程(甚至跨环境变化)的 incarnation 比较必然分叉。这解释了两套谓词为何矛盾,也直接威胁本方案的跨进程 owner/claim 校验(watcher 验 teardown、teardown 验 watcher)。

Codex R6 复核定位:这正是 **FLY-1605 已知缺陷类** —— HEAD 上 watcher 侧已修(`flywheel-cmux-sync.sh:6638`/`:3277` 已带 `TZ=UTC LC_ALL=C`,含 cross-TZ 测试;老 watcher 1752 跑的是 pre-1605 旧代码)。**剩余缺口 = `test-teardown.sh` 的两处读取(:41/:139)未 pin** —— 本单作为 FLY-1605 的 teardown 侧补全处理(plan.md §4.4),含首尾空白 trim(不折叠内部空白)。最终确认(老进程 2 天窗口内何时开始失效、env 对照)留实现期。

推论:
* 两层僵局在进程更替前逐字成立(owner live 拒绝 + `.reap` 文件让 `mkdir` 必败);更替只是换了持锁 pid,僵局结构不变。
* 本机走的是 `lockf` 路径 —— teardown 侧的新实现必须同样优先 `lockf`、回退 `flock`,与 `_acquire_reap_mutex` 完全同序,否则两边可能各用一种工具而互不排斥(`lockf` 与 `flock` 在同一 fd 文件上都是 POSIX advisory lock,内核层互斥,但探测顺序必须一致以保证退化行为相同)。
* 验收回放不能用原始残留(已消失),需在 529 QA 房再造等价残留。

## 3. 方案 A 各前提的可行性核对

### 3.1 teardown 侧换 retained-file 锁 — 可行,需镜像三块

`_acquire_reap_mutex` 共 42 行,依赖两个小函数(`_snapshot_live_mutator_processes` ~25 行、`_mutator_command_matches` ~40 行)用于 legacy 目录形态升级的 census 门控。三块全部纯 bash 3.2 兼容、无外部状态,可镜像进 teardown。

为什么镜像而不是 source/共享 lib:
* `flywheel-cmux-sync.sh` 虽可 source(BASH_SOURCE guard),但两脚本各自定义 `log()`、各自的变量命名(`WATCHER_LOCK_DIR` vs `CMUX_MUTATOR_LOCK_DIR`),source 进来符号冲突面大;
* 抽共享 lib 会破坏 watcher 的单文件闭包(`~/.flywheel/bin` 是 symlink,`dirname $0` 解析不到仓库 scripts/lib —— 这正是 FLY-1577 在处理的 bin closure 问题域),不该在本单顺手做;
* 镜像的漂移风险用**跨实现契约测试**钉死(见 §4):任何一边改语义,测试当场红。

### 3.2 watcher yield(统一 maintenance 谓词驱动)— 可行,插入点明确

> 本节按 Codex design review R1-R4 修订;权威细节以 plan.md §4 为准。

* 触发谓词 = `maintenance_requested()`:base marker **或** QA yield claim(见 §3.3)。**按入口分相接线**(R3 修订):谓词替换三个 tick gate(:978/:6233/:6282)与 one-shot 的 `maintenance_entry_allowed`(:7067,claim 下零 mutation 退出);**watch dispatcher 的 pre-acquire gate 只保留 base marker 现有语义** —— claim 不阻塞 watch 启动,acquire 成功后立即走 yield/park,stale claim 由 parked 循环的 reaper 自愈(否则冷启动 watcher 会在 reaper 可达之前被 stale claim 无锁死等)。
* 检测点:`acquire_watcher_lock` 成功后、`watch_main` 任何副作用前;`watch_loop` tick 顶;degraded 长退避 sleep 的**专用切片**(独立于 `FLYWHEEL_CMUX_REOPEN_SWEEP` —— R2 复核:`reopen_aware_sleep` 在 flag=0 时直睡整段,不能依赖它)。
* 让锁:`release_mutator_lease` 后必须 **read-back 验证**(该函数对 owner mismatch / rm 失败都静默返回,不能假设已放);失败 → `holding-with-request` 显式状态(保持 lease、零副作用、重试+告警),绝不假装已放。
* parked → 谓词清空 → 阻塞 re-acquire(统一等待,绝不 exit)→ 复查谓词 → `sync_additive_bootstrap` resync。期间积压事件在 EVENT_FILE,恢复后 `drain_events` 消化 —— 与现有 unhealthy-tick 语义同构。

### 3.3 QA yield claim(独立状态文件,不复用 base marker)— 可行

R1 复核否决了「teardown 结构化占用 base marker」:tmp+mv 是 replace 非 create-if-absent(双 teardown 互覆);foreign `touch` 落同一 inode 会被 teardown 误删;旧 watcher 会因 base marker 长期 no-op(比现状更糟)。改为独立 claim 文件 `${CMUX_MAINTENANCE_MARKER}.qa-teardown`:

* base marker 对 teardown 永远只读(存在 → 拒绝,:660 语义保留且在**持锁后 mutation 前复查**);
* claim 发布 = 同目录 temp 写完整内容 → **hard-link publish**(no-clobber + 内容完整才可见,R2 复核:裸 O_EXCL 存在半写可见窗口)→ read-back;
* malformed claim 双侧 fail-closed(teardown 拒绝、watcher park+周期告警),绝不猜删;
* owner-dead 接管/reap 都在 reap kernel mutex 内做 classify + read-back;
* watcher reap claim 需 **activity fence** 证明(§3.4),base marker 永不 reap。

### 3.4 crash 恢复 — 需要内核锁 fence,census 不够

R2 复核:owner PID 死 ≠ mutation 已停 —— teardown 的 foreground child(`rm`/`git`/`tmux`)argv 不属 teardown family,census 看不见。证明手段改为**内核锁 activity fence**:teardown 在 claim fd 上取 `lockf`/`flock` 锁并全程持有,child 继承 open file description → 父被 SIGKILL 而 child 存活时锁仍被持有;watcher reap 前提 = 非阻塞取 fence 成功。平台语义(macOS `lockf` / Linux `flock` 是否随 fd 继承存续)**必须用真实 parent-SIGKILL + child-survival fixture 实测**,是硬门。Darwin 主路径已在 design review R3 期间由 Codex 本机实测通过(父 bash 被 SIGKILL 后 child 存活期间竞争者 `lockf -t 0` 返回 75,child 退出后返回 0);Linux `flock` 留 CI fixture。硬门失败的处置是 **contingency-stop**(停止实现、回设计评审),不临场启用未成形备选。

崩溃自愈矩阵(修订后):

| teardown 崩溃点 | 残留 | 自愈 |
|---|---|---|
| claim 发布前 | 最多一个 temp(不构成 claim) | 无影响 |
| claim 后、拿 lease 前 | claim(fence 已随进程树消亡释放) | watcher:owner 死 + fence 可取 → reap → resume;或下次 teardown 接管 |
| 拿 lease 后、清理中(child 可能存活) | claim + dead-owner lease | fence 被 child 持有 → watcher 不 reap(fail-closed);child 消亡后 reap + lease 走既有 census rebuild(:6984-7002) |
| 放锁后、删 claim 前 | claim | 同第 2 行 |

### 3.5 过渡窗口(新 teardown + 旧 watcher)

`~/.flywheel/bin/flywheel-cmux-sync` 是 symlink → 主仓 main;merge 后文件即新,但**运行中的 watcher 是旧代码**,要 `flywheel-cmux-install.sh` 受控重启才生效。窗口内:新 teardown 只写 claim 文件,**旧 watcher 完全无视该文件**(不 park、不受扰),teardown 有界等待超时 → 撤 claim + loud fail。严格不劣于现状(这也是不复用 base marker 的关键理由之一);ship 顺序硬约束 = 先受控重启并验证 watcher yield 能力,再做真机验收(plan.md §8)。

### 3.6 调用方可观测性

* `pre-ship-check.sh`:`set -euo pipefail` 下第二处直调(:68)teardown 失败会直接 fail 整个 check(可见);第一处(:63)在 `|| { …; exit 1; }` 分支内,teardown 的 stderr 直通终端且随后 exit 1 —— 均已可观测,**无需改动**。
* 静默吞掉 teardown 失败的调用方不止一处(Codex R1 复核纠正):`qa-fly-1189-room-smoke.sh:109`、`qa-fly-529-roundtable-smoke.sh:44-49`、`qa-fly-529-alert-smoke.sh:54-55`、`qa-fly-153-mirror-smoke.sh:111-121`。改法:共享 single-shot finalizer helper —— teardown 输出落日志文件;失败时 stderr 大声一行 + 写 `/tmp/flywheel-test-slot-<N>.teardown-failed` 残留标记(含 rc/时间戳/日志尾);成功时 owner-safe 清除旧标记;主体失败退出码优先,主体 PASS + cleanup 失败以独立退出码结束 —— 满足验收「至少要能被观测到失败」。

## 4. 测试基建现状(回归测试的落点)

* `scripts/__tests__/test-teardown-cmux-ownership.test.sh` 已有完整 hermetic harness:fake tmux(PATH 覆盖)、`FLYWHEEL_CMUX_WATCHER_LOCK_DIR`/`FLYWHEEL_CMUX_MAINTENANCE_MARKER`/incarnation override 全套 env、隔离 HOME。新测试直接扩这个模式。
* `flywheel-cmux-sync.sh` 支持 source(测试 harness 既有用法)→ 契约测试可以在同一个测试进程里让 cmux-sync 的真函数和 teardown 的真函数抢同一把锁,用真实 `lockf`。
* 验收 E2E 落 529 QA 房(FLY-529/FLY-1608 基建):再造等价残留(slot Bridge node 进程 + slot dir + lock),生产 watcher 活着时真跑 `scripts/test-teardown.sh <slot>`。

## 5. 相关 issue 边界

| Issue | 关系 | 本单动不动 |
|---|---|---|
| FLY-1272 | 单一 mutator lease 的来源设计 | 模型不动,只补「让锁握手」 |
| FLY-1608 | 根因定位来源 + 529 房修复(`FLYWHEEL_COMPLETE_MARKER_DIR` 等) | 只复用其 QA 设施 |
| FLY-913 | restart-guard 护栏(禁手工 kill) | 不动;本修复正是让「被认可的清理路径」重新可用 |
| FLY-1577 | watcher bin 单文件闭包 | 不动;是「不抽共享 lib」的约束来源 |
| FLY-1618 | scheduler mutation 锁无主楔死(同族) | 出界,另单;共享锁原语库抽取记 follow-up |

## 6. 结论

方案 A 经 Codex design review 多轮修订后核对通过:activity fence 依赖的锁继承语义,Darwin `lockf` 主路径已实测成立(§3.4);Linux `flock` 以 CI 上真实 parent-SIGKILL + child-survival fixture 验证(plan.md C5-e 硬门),**硬门失败即 contingency-stop(停实现、回设计评审),无自动备选**。其余前提无未知依赖。进入 plan.md 拆分实施。
