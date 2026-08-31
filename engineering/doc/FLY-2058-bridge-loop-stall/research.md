# FLY-2058 Bridge 主循环 stall 取证与防护机制调研 — 调研

Issue: FLY-2058 (https://linear.app/geoforge3d/issue/FLY-2058/infra可用性-bridge-的-137-是-eventloopguard-主循环-stall-60s-自我-sigkill账上-14-次)
日期: 2026-08-28
基于: exploration.md

## 1. Guard 现状(代码事实)

`packages/teamlead/src/bridge/BridgeEventLoopGuard.ts`:

- 主线程 `setInterval(1s)` 把 `Date.now()` 写 `SharedArrayBuffer` slot 0(`Atomics.store`);worker(eval CJS)`setInterval(5s)` 读,`age > 60s` ⇒ 写 forensic 行(`appendFileSync` 到 `~/.flywheel/bridge-loop-guard.log`)⇒ `process.kill(pid, "SIGKILL")`。
- forensic 现有字段:`event/stall_age_ms/threshold_ms/at/pid/bootTs`,可选 `last_sync_op`。
- worker 读 marker 的合同(`readSyncOp`):文件 ≤4KB、`marker.pid === pid`、`startedAt ∈ [lastBeat, now]`——即 stall 期间启动的 op 才归因,合同正确,**问题只在生产覆盖率≈0**(仅 `codex-daemon-runtime` 两个 execSync)。
- 环境旋钮已备:`FLYWHEEL_BRIDGE_LOOP_GUARD_{HEARTBEAT_MS,STALL_MS,CHECK_MS,LOG}`,`FLYWHEEL_BRIDGE_SYNCOP_DIR`。
- worker 侧还能用的原语:eval worker 是 CJS,可 `require` 任意 builtin(`child_process` 含内)且有**自己的 libuv loop**——主线程卡死时 worker 照常 spawn 子进程/读文件。这是全部取证设计的立足点。

## 2. Bridge 进程内「可 ≥1s 同步阻塞」操作盘点

| 位置 | 形式 | 单步上限 | 单 stretch 最坏连续阻塞 | 备注 |
|---|---|---|---|---|
| `bridge/workflow-docs-git.ts`(18 个 `this.run`) | `spawnSync git` | 30s | **90s**(`pushCommit`: ls-remote→push→ls-remote 无 yield 三连,均走网络) | **唯一盘点到的 ≥60s 单 stretch**;materializer 各方法之间有 await,方法内无 |
| `bridge/workflow-resume-checkpoint.ts`(13 个) | `spawnSync git --git-dir` | 10s | 理论 ~130s,实际本地 store 操作毫秒级 | 弱嫌疑;归因仪器会覆盖 |
| `bridge/tmux-environment-scrub.ts` | `spawnSync tmux` | 5s | 单发 | tmux server 挂起时 5s 封顶 |
| `lead-backends/codex/tui-window.ts` | `spawnSync` | 5s | 单发 | |
| `StateStore.ts`(better-sqlite3) | 同步 SQL | busy_timeout=5000 | 单条大查询无上限(316MB 库) | WAL、synchronous=NORMAL;跨进程实测仅 Bridge 自己打开;「单条慢查询 60s」未排除 |
| `codex-daemon-runtime.ts` ×2 | `execSync ps/lsof` | — | 已有 marker | 15 次 stall 均未归因到它 |
| `config/log-rotate.ts` | rename 链 | ms | — | 已排除 |
| （未知项) | microtask 风暴 / 未盘点同步 IO | — | 无上限 | 只能靠运行时取证覆盖 |

结论:静态盘点**只有 `pushCommit` 一处**能解释 ≥60s 连续阻塞,但「单条慢 SQL」「microtask 风暴」等无静态上限的候选排不掉 ⇒ 归因仪器仍是必需品,不能只改嫌疑。

## 3. Pre-kill 取证机制选型(含实测)

击杀前取证的约束:主线程已死(不能指望它配合)、进程马上要没(必须同步落盘)、macOS 26 hardened(无 root)。

| 机制 | 覆盖 | 实测/依据 | 取舍 |
|---|---|---|---|
| `/usr/bin/sample <pid>` 原生栈 | 全部 | ❌ **实测失败**:对健康 Bridge 采样,全线程 `failed to get thread state`,call graph 空(需要 task port,SIP 拦截) | 排除 |
| `spindump` | 全部 | 需 root | 排除(daemon 无 root) |
| **worker 自身 tick gap** | A/B 族判别 | worker 记录自己上一次 check 的时刻(SAB slot 1 或 worker 局部变量),`gap≈5s` ⇒ 主线程独卡;`gap≈stall_age` ⇒ 整进程冻结。零成本、无权限问题 | ✅ 必选,一个数就把 exploration §1.2 的推断变成每条账目的显式字段 |
| **`ps` 抓子进程** | spawnSync 类(git/tmux/…) | worker `execFileSync("/bin/ps", ["-o", "pid,ppid,etime,command", "-ax"])` 过滤 `ppid==bridgePid`;spawnSync 阻塞时子进程命令行就是铁证(如 `git push …`)。ps 本身不依赖 task port,普通用户可用 | ✅ 必选,对头号嫌疑是决定性证据 |
| **sync-op marker 扩覆盖** | 被包住的同步 op | 机制已端到端接通(§1),`markSyncOp` 3 次 fs 调用 ~ms 级,只包「预期可 ≥1s」的 op(git spawnSync 全量、StateStore 维护类操作),不包每条 SQL | ✅ 必选,复用现有机制,零新子系统 |
| CDP self-attach(`inspector.open` + worker 走 ws `Debugger.pause`)抓 JS 栈 | 纯 JS 自旋/microtask 风暴 | V8 inspector pause 走 interrupt,能打断长 JS 执行;但 native 阻塞(spawnSync/better-sqlite3)期间不会触发;需常驻 inspector 端口(安全面)+ worker 里实现 CDP 客户端 | ⚠️ **不进本期**:复杂度/安全面不成比例,前三样已覆盖两大族 + 头号嫌疑;若归因后仍有「无 marker、无子进程、worker 健康」的暗 stall,再立后续单 |

## 4. Family B(整进程冻结)止损选型

现状:worker 醒来发现 age 超阈 ⇒ 立即 SIGKILL。8-15 连环三杀 + 8-25 的 237s 都是「冻结解除后补刀」——机器在 thrash 时再追加一次冷启动(boot + 全舰重连),是负收益。

| 方案 | 行为 | 取舍 |
|---|---|---|
| A. 维持立即杀 | 不变 | 保守但已被账本证明有害(5/15 是补刀) |
| B. **冻结场景宽限复查**:检出 stall 时,若 worker 自身 tick gap 也 ≥ 阈值(说明 worker 同被冻结,主线程「没跳」不可信),等 5s 宽限窗再读一次心跳;恢复了 ⇒ 只记 `stall_recovered_after_freeze` 账,不杀;没恢复 ⇒ 照杀 | ✅ 推荐:真死锁只晚杀 5s;补刀场景零杀。判据用的就是 §3 的 tick gap,无新机制 |
| C. 通用二次确认(无论 gap 大小都宽限) | 主线程独卡族也多活 5s | 不必要:worker 健康时 age 就是可信的,60s 已经等够了 |

选 B。注意宽限窗内 worker 用 `setTimeout(5s)` 再查,期间不重复触发。

## 5. 头号嫌疑(pushCommit 三连)缓解选型

| 方案 | 改动 | 取舍 |
|---|---|---|
| a. 网络 git 超时 30s→10s | `workflow-docs-git.ts` 一个常量 | 单 stretch 最坏 90s→30s,低于 60s 阈值;网络差时 push 失败率上升,但该路径本就有失败处理(materializer 重试/告警),**只改数字不加机制** |
| b. 步间 yield(`await setImmediate()`) | pushCommit 内 3 步之间 | 心跳能跳,guard 不再误伤;但主循环仍被每步 30s 独占(chat-send API 照样卡 30s),治标 |
| c. 全面 asyncify(spawnSync→spawn/execFile await) | 重构 18 个调用点 + 调用方语义 | 根治但改动面大、回归面大,与「归因未实证」不匹配 |
| d. 移去 worker thread 执行 git | 新执行通道 | 造子系统,founder 红线 |
| **选型: a + b 同做** | 两处小改 | a 把最坏值压回阈值下,b 消除「单 stretch 多连」这一类的结构性风险;c 留给归因实证后的后续单(若证明 git 链是主凶且 30s 级阻塞仍不可接受) |

### 5.1 活体 profile 后的主凶修正:gate-marker 全量扫描

2026-08-29 02:15–02:35Z 的 20 个生产 CPU profile 已把当前发作归到 `CodexTmuxAdapter.isWaiting → listGateMarkersForExecution → readFileSync`:20 窗合计 inclusive 28.79%,最坏 episode 窗 67.16%–77.05%;同期 Git 栈 0.03%。目录总量 250MB 中只有顶层 7,955 个 JSON/3.26MB 会被该函数读取,但每个 resident adapter 每轮都重复全量同步解析,足以制造 10–17s 主线程 CPU 磨盘。

| 方案 | 正确性 / 成本 | 结论 |
|---|---|---|
| A. 复用 CommDB 权威查询 + exact marker read | `hasPendingBlockingGateFrom` 已区分 blocking gate 与普通 ask;`getOpenGatesByRunner` 返回当前 execution 的极小 id 集合,仅 exact-read timeout marker。补一个 sender partial index,无 marker 格式/依赖变化 | **选** |
| B. marker 目录加 execution index | 要迁移旧格式、维护双写/清理/兼容 | 不需要 |
| C. 按目录 mtime 做进程级 cache | invalidation/mtime 精度与对象可变性带来新正确性面;每次目录变更仍会全扫 | 不需要 |
| D. 只清理 7,955 个 residue | 能暂时降载,但没消除 O(N × adapters × polls) 结构;且删除外部状态不属本单授权 | 不选 |

选择 A:它是 Ponytail ladder 的「复用已安装依赖/既有权威查询」,删除热路径而不新建抽象。DB 不可用或查询抛错时保留原 marker scan 作为兼容 fallback;生产正常路径不再扫描目录。两条 sender 查询必须由 partial index + `EXPLAIN QUERY PLAN` 测试约束,避免把文件扫描换成 mailbox 全表扫描。

## 6. 行为级验收路径(issue 要求)

1. **人造主线程独卡**:测试旋钮(仅测试构造)让 Bridge 主线程跑 `Atomics.wait` 或同步 sleep 70s(用 `spawnSync("/bin/sleep")` 更贴近真实形态)⇒ 断言:guard 击杀(退出码 137)、forensic 行含 `tick_gap` 小值 + `children` 里有 sleep 子进程(+ 若包了 marker,`last_sync_op` 命中)。
2. **人造整进程冻结**:对测试 Bridge `kill -STOP <pid>`,70s 后 `kill -CONT` ⇒ 断言:**不死**、forensic 账上多一条 `stall_recovered_after_freeze`(带 `tick_gap≈70s`)。
3. **pushCommit 上限回归**:对假 remote(挂起的 socket)跑 pushCommit ⇒ 断言单次调用墙钟 < 35s(a 生效)且期间心跳有推进(b 生效)。
- 现有 harness:`BridgeEventLoopGuard` 已有 `testMode`(postMessage 代替 kill)+ 注入 seam(`createWorker/now/rotateLog`),单测可全走注入;1/2 需要真进程级 e2e(`scripts/__tests__/` bash harness 或 vitest spawn 子进程)。

## 7. 风险与开放问题

- **归因仪器自身不得制造 stall**:worker 里的 `ps` 用 `execFileSync` 带 `timeout: 2000`;全部 try/catch;取证总预算 ≤3s,超时直接带残缺包击杀(击杀语义不因取证失败而变)。
- forensic 行体积:`children` 列表截断到 ≤10 条、每条命令行 ≤200 字符,防日志膨胀。
- 宽限窗的边界:若冻结由 SIGSTOP 之外的原因(如 kernel 调度饥饿)导致 gap 虚高——判据仍成立(worker 没按时跑 = 该时段「主线程没跳」不可作为死亡证据)。
- 慢 SQL 候选未排除:本期不给 StateStore 每条查询加 marker(成本/收益不匹配),靠「无 marker + 无子进程 + tick gap 小」的残缺包形状指向它,再立后续单。
- shuttle 成对重启(ExitTimeOut 机制)确认不在本单(exploration §5)。
