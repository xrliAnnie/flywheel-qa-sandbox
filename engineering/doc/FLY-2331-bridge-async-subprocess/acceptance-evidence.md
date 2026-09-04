# FLY-2331 Bridge 异步子进程 — 验收证据
Issue: FLY-2331 (https://linear.app/geoforge3d/issue/FLY-2331/引擎稳定性urgent-bridge-主线程用-execfilesync无超时跑-adapter-shell-证据收集-approve-的)
日期: 2026-09-04
基于: plan.md

## 真实时长回归

命令：

```sh
scripts/__tests__/fly2331-bridge-async-child.test.sh
```

结果：

```text
PASS fly2331 async=70s sync-mutant=61s heartbeats=70 group=2/2 reap=1/1
```

- async arm：PATH 首位 fake `git` 的 `worktree add` 实际运行 70 秒；子进程正常完成，Bridge guard heartbeat 推进 70 次，forensic log 没有 terminal stall。
- sync mutant：同一个 fake `git` 与同一个 guard 改用 `execFileSync`；进程在 61 秒被 SIGKILL，forensic log 写入 `bridge_event_loop_stall`。
- 两臂均先校验 fake Git 调用记录，排除误用系统 Git 的假绿。
- process-group arm：fake Git 与继承 stdio 的孙进程在 250ms deadline 后均在 3 秒回收窗口内消失，分母 2/2。
- detached reap arm：短寿命 detached/unref child 的 `exit` 被观察，随后 `ps` 与 `kill(0)` 均确认消失，分母 1/1。
- harness 使用隔离的临时 HOME、STATE_DIR、SYNCOP_DIR 与日志目录；两个 package build
  在 fake Git 加入 PATH 前完成，因此 repo-local `dist` 的 build identity 保持为真实 SHA40，
  且未读取或写入生产 Bridge 状态。

## 缩放预检

在真实时长运行前执行同一 harness 的缩放预检：

```sh
FLY2331_ACCEPTANCE_SLEEP_SECONDS=3 \
FLY2331_GUARD_STALL_MS=1000 \
FLY2331_MIN_HEARTBEATS=2 \
scripts/__tests__/fly2331-bridge-async-child.test.sh
```

结果：

```text
PASS fly2331 async=3s sync-mutant=2s heartbeats=3 group=2/2 reap=1/1
```

## Code review R3 修复复验

第 3 轮 code review 指出 harness 原先在两个 package build 前注入 fake Git，导致 Teamlead
build identity 被 `fake-git-complete` 污染并浪费 70 秒 CI 预算。先给
`ci-structure.test.sh` 增加顺序哨兵并确认旧实现 RED，再把 PATH 注入移动到两个 build 后；
顺序哨兵转绿，repo-local build identity 与当时真实 branch head 一致。修改后的真实时长
harness 再次通过：

```text
PASS fly2331 async=71s sync-mutant=61s heartbeats=70 group=2/2 reap=1/1
```

其余四项发现也各有独立 RED/GREEN 证据：

- 慢子进程测试先用 IPC ready handshake 确认计时起点，再用相对 deadline 窗口判断；所有
  复验按 `VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1` 执行，避免整机高负载把固定绝对时间
  误判为回归。
- fleet recovery 通过注入的 async exec seam 验证 `timeout=120000` 与
  `maxBuffer=16777216`；旧实现未经过 seam，测试先 RED，接入显式 16 MiB 上限后 GREEN。
- parent 已触发 `exit` 后不再向负 PGID 发信号，避免 PID/PGID 被复用时误杀无关进程；测试
  先捕获旧实现的负数 `process.kill` 调用，再验证修复后不存在该调用。
- 兼容同步入口省略 timeout 时仍使用原有 20 秒有限上限，但该行为现在由导出的命名常量
  与接口文档固定；测试先因常量缺失 RED，再验证值为 `20000`。

最终聚焦复验：Claude runner 3 files / 13 tests PASS，Teamlead fleet 23 tests PASS，两个受影响
package build PASS，变更集 Biome、shell syntax、CI structure/enumeration 哨兵与 repo lint 均 PASS。
