# FLY-2058 Bridge 主循环 stall 根因探索 — 探索

Issue: FLY-2058 (https://linear.app/geoforge3d/issue/FLY-2058/infra可用性-bridge-的-137-是-eventloopguard-主循环-stall-60s-自我-sigkill账上-14-次)
日期: 2026-08-28
基于: 无

## 0. 一句话

Bridge 的 137 退出全部来自 `BridgeEventLoopGuard` 的自我 SIGKILL(账本已从 14 条涨到 **15 条**,本探索当天又死两次);账本形状本身把 15 次分成**两个根因族**——「主线程独卡」(11 次,真阳性)与「整进程冻结」(4+1 次,guard 醒来补刀)——且对主线程独卡族,已找到一个机制完全吻合的头号嫌疑:`workflow-docs-git.pushCommit` 在一个同步 stretch 里背靠背跑最多 3 个 30s 上限的网络 spawnSync。

## 1. 本探索新增的事实(全部为本日实测,非推断)

### 1.1 账本在涨:15 条,今天两条

`~/.flywheel/bridge-loop-guard.log`(guard 用 `appendFileSync` 同步落盘,SIGKILL 前写完,这就是它在主日志里搜不到、账本却在的原因——`console.error` 的异步缓冲在 SIGKILL 时丢失):

| # | 击杀时刻 (UTC) | stall_age | uptime | 备注 |
|---|---|---|---|---|
| 1 | 08-15 21:55:45 | **890s** | 117min | 超长族 |
| 2 | 08-15 22:28:43 | **576s** | 33min | 超长族(连环) |
| 3 | 08-15 23:29:12 | **1008s** | 60min | 超长族(连环) |
| 4 | 08-16 05:18:57 | **362s** | 350min | 超长族 |
| 5 | 08-19 17:53:22 | 63s | 902min | 刚过阈值族 |
| 6 | 08-22 19:37:56 | 62s | 189min | 刚过阈值族 |
| 7 | 08-24 22:46:39 | 63s | 225min | 刚过阈值族 |
| 8 | 08-24 23:48:35 | 65s | 61min | 刚过阈值族 |
| 9 | 08-25 05:29:34 | 60s | 339min | 刚过阈值族 |
| 10 | 08-25 21:19:15 | 64s | 117min | = issue 里 14:19 PDT 那次死亡 |
| 11 | 08-25 21:38:03 | **237s** | 17min | = issue 里 14:38 PDT 那次;swap 风暴时段 |
| 12 | 08-26 12:20:34 | 64s | 318min | 刚过阈值族 |
| 13 | 08-28 03:37:00 | 64s | 516min | 刚过阈值族 |
| 14 | 08-28 23:00:18 | 64s | 873min | **今天**,见 1.3 |
| 15 | 08-28 23:25:38 | 64s | 24min | **今天**,见 1.3 |

- issue 里的两次死亡(#10/#11)与账本时刻**精确对齐**(#11 的 stallStart 21:34:07 vs issue 记录的最后日志 14:34:04 PDT)。「凶手已定」坐实。
- **15 条没有一条带 `last_sync_op`**:sync-op marker 机制端到端接通了(`plugin.ts` 传了 `syncOpMarkerPath`),但生产里只有 `codex-daemon-runtime` 的两个 execSync(`ps-pgid` / `lsof-socket`)被 `withSyncOpMarker` 包住——覆盖率≈0,所以 15 次全部无归因。
- uptime 从 17min 到 15h 都有 ⇒ 与启动阶段无关。

### 1.2 账本形状自己就是判据:两个根因族

guard 结构:主线程每 1s 把 `Date.now()` 写进 SharedArrayBuffer;worker 线程每 5s 检查,`age > 60s` 即 SIGKILL。因此:

- **stall_age ≈ 60–65s(11 次)** ⇒ worker 按时在查、按时击杀 ⇒ **worker 线程活着,只有主线程卡死** ⇒ 真阳性。记录值是 min 偏置的(实际 stall 可能更长,60s 一到就杀了)。
- **stall_age = 237/362/576/890/1008s(5 次)** ⇒ 检查年龄远超「阈值+检查间隔」,唯一解释是 **worker 自己也被冻结了同样久**,醒来后才补刀 ⇒ **整个进程(乃至机器)级冻结**——8-15 连环三杀 + 8-25 的 237s 正对 issue 记录的 swap 风暴时段。这一族里 kill 是「补刀」:冻结解除后进程本可恢复,击杀反而在 thrash 的机器上追加一次冷启动。

### 1.3 今天两次死亡:机器没冻,是 Bridge 独卡(排除 family B)

对 #14(stall 窗口 22:59:14→23:00:18 UTC)与 #15(23:24:34→23:25:38)各做整机 syslog 密度检查(`/usr/bin/log show --style compact`,按 10s 分桶):stall 窗口内整机日志**持续以每 10s 三五千条正常流动**,launchd 在 16:00:18.296 PDT 记录 `service inactive: com.flywheel.bridge`(与 guard 击杀 23:00:18.179Z 毫秒级吻合),随后 ~5s 内 KeepAlive 重启。⇒ 今天两次都是 family A 真阳性,不是机器冻结。

(#15 击杀后 syslog 爆到每 10s 7 万条,查明是 `ecosystemanalyticsd`/`trustd`/`taskgated` 对新 node 进程做签名验证的重启噪音,非因果。)

### 1.4 死亡现场已灭失,且以后每次都会灭失

`/tmp/flywheel-bridge.log` 每次 boot 重置,死亡实例的最后几行**不留**;主日志大多数行**没有时间戳**。⇒ 事后取证不可行,**取证必须由 guard(唯一活着的目击者)在击杀前完成**。这是设计的硬前提。

### 1.5 pre-kill 取证工具实测:`/usr/bin/sample` 不可用

对健康 Bridge 实测 `sample <pid> 1`:所有线程 `failed to get thread state`,call graph 为空(macOS 26 hardened 限制,非 root 拿不到 task port)。⇒ 原生栈采样路线**排除**,取证要走别的组合(见 §3)。

## 2. Family A 头号嫌疑:pushCommit 的同步网络三连

`packages/teamlead/src/bridge/workflow-docs-git.ts` 的 `pushCommit`,一个同步 stretch(之间零 await、事件循环零让出)里跑:

```
ls-remote(30s cap) → push --porcelain(30s cap) → ls-remote 确认(30s cap)
```

每个 `this.run()` 是 `spawnSync(git, …, { timeout: 30_000 })`。网络劣化(挂起而非快速失败)时,每步吃满 30s 超时 ⇒ **60–90s 连续主循环阻塞**,与 family A 的 60.3–64.8s 击杀签名精确吻合(60s 阈值 + 0–5s 检查相位)。旁证:8-25 #10 死前最后日志正是 `RoundtableThreadManager poll failed { err: 'fetch failed' }`——同时段网络在挂。

同文件还有 18 个 `this.run` 调用点;`workflow-resume-checkpoint.ts` 另有 13 个(10s cap,`--git-dir` 本地 store 操作,单步慢的概率低,但同样是同步串联)。

**注意:此为机制吻合 + 时间旁证,尚未实证**(没有任何一次 stall 带归因)。其余候选(单条大查询扫 316MB 的 teamlead.db、microtask 风暴自旋、未盘点的同步 IO)未排除——所以设计必须是「归因优先」,不是「直接改嫌疑」。

## 3. 已排除 / 已核实清单(本日)

| 候选 | 判据 | 结论 |
|---|---|---|
| launchd ExitTimeOut=30 TERM→KILL 升级(issue 原头号线索) | 15 条 guard 账目直接产生 137(SIGKILL=128+9),两次死亡时刻与账本毫秒级对齐 | ❌ 不是这 15 次的凶手(但 shuttle 成对重启或仍与它有关,见 §5 边界) |
| `rotateLogIfNeeded` 同步轮转大日志 | 读了 `packages/config/src/log-rotate.ts`:纯 rename,毫秒级 | ❌ 排除 |
| 跨进程 DB 争锁 | `lsof` 实测只有 Bridge(pid 2443)打开 teamlead.db;WAL 模式读不阻写;`busy_timeout=5000` 单步最多同步等 5s | ⚠️ 单发不足以 60s,弱嫌疑保留 |
| StateStore 仍在 sql.js | FLY-663 已迁 better-sqlite3(原生,WAL,synchronous=NORMAL) | ✅ 核实(但 better-sqlite3 每条查询同步阻塞主循环,大查询候选保留) |
| 机器 OOM/jetsam(今天两次) | stall 窗口整机 syslog 正常密度 | ❌ 排除(家族 B 的 5 次除外,那是 swap 风暴) |
| `sample` 做 pre-kill 栈采样 | 实测 0 栈 | ❌ 路线排除 |

## 4. 设计方向(交给 research/plan 展开)

1. **归因优先**:guard 击杀前抓一份「取证包」——worker 自身 tick gap(一个数直接判 A/B 族)、sync-op marker(把覆盖从 2 处扩到所有可能 ≥1s 的同步操作,git spawnSync 全量优先)、`ps` 抓 Bridge 子进程(spawnSync 在跑时子进程命令行就是铁证)、可选 CDP pause 抓 JS 自旋栈。stall 频率 1–3 次/天,归因会在一两天内自己送上门。
2. **Family B 止损**:worker 发现自己 tick gap 也超阈值(= 整进程冻结)时,给主线程一个 5s 宽限窗证明活性,活着就不杀只记账——消灭 8-15 式连环补刀。真死锁只多等 5s。
3. **嫌疑一的低风险缓解**(与归因并行或随后):压缩 pushCommit 链的最坏连续阻塞(网络 git 超时 30s→10s,和/或步间让出事件循环),使单链 < 60s 阈值。
4. **验收必须行为级**(issue 明确要求):人造 70s 同步阻塞 → 断言取证包落盘 + 击杀;`SIGSTOP` 整进程 70s + `SIGCONT` → 断言**不杀**且记账(family B 宽限生效)。

## 4.5 附录:2026-08-29 01:0x 活体发作情报(Lead a92f678a 转来 + 本席现场补采)

设计评审进行中,生产 Bridge 症状**正在活体发作**(FLY-2031 只读监控):

- `/health` 自报 event_loop **p99 max = 30752.6ms、175 episodes**,一小时内从 ~24998ms/88 单调恶化;三个 10s 请求超时。
- **30752ms 这个形状值得记一笔**:网络 git spawnSync 的 timeout 上限正是 30_000ms——单步吃满超时的 episode 会呈现为 ~30.x s 的 event-loop 卡段,与嫌疑一的单步上限精确同形。两步连击(60s+)才触发 guard 击杀,单步 30s 只表现为「p99 30s 级 + API 超时」——**这正是账本 60–65s 击杀族的前奏区间**。
- 本席 01:06Z 现场补采:瞬时无 git 子进程(发作间歇性)、无 sync-op marker(覆盖率≈0 的已知状态)、当前窗口 p99 5473ms/episodes 180(还在涨)。活体监视(1s 粒度)实测:僵尸子进程以每秒多个的速率出现且 1–4s 才被收尸(= 循环滞后到秒级才处理 exit)、/health 实测 14.76s / 5.96s 两次卡顿、卡顿窗口内**无任何存活子进程**(⇒ 当下的阻塞者是进程内代码,不是 spawnSync 子进程;`ps -Awwo`(chrome-session-reaper)与 tmux pane capture 均为 async execFile,已排除)。
- **01:1x 活体 CPU profile 铁证**(`kill -USR1` 开 Node inspector + CDP `Profiler`,15s / 4679 样本,主线程 CPU ~87% state R,累计 sys 34:32 + user 25:48 / uptime 100min):
  - **62.9% 的主线程 CPU 在 `flywheel-comm/dist/mailbox-queue.js:1232` —— `scanAndInsertDeadLetterNotices` 的 transaction 回调**,+5.2% `listUncoveredLeadDeadLetters`、+1.3% `hasPendingQuestionsFrom` 等 mailbox/db 同类项。`RunnerMailboxLane.tick()` **每个 tick 都跑**这套死信扫描(≤100 收件人 × 20 行,comm.db mailbox 表现有 3212 DEAD + 63007 ACKED 行,同步事务内含 `readFileSync(content_ref)` —— profile 里 17.6% 的原生 `readFileUtf8` 即来源于此)。
  - 另 ~25%:`CodexTmuxAdapter.isWaiting/tick` + `defaultExecFile`(codex tmux 轮询)。
  - **结论修正**:「主循环在干什么」对**当下活体发作**已有直接答案——mailbox 死信扫描把主线程当 CPU 磨盘,这是连续性 p99 episode 的病灶,也是 family A 击杀「无 marker、无子进程」形态(attribution: unknown)的头号进程内嫌疑;**git 同步链(嫌疑一)未被取代**——30752ms p99 max 与 30s git timeout 同形、8-25 死亡与网络故障同窗,它仍是「离散 60s+ 击杀」的并列嫌疑。两者由 T1 取证在击杀现场分辨。修 mailbox 扫描热循环属另一个 issue(工程裁量在 Lead)。
  - 工具修正(推翻 research §3 的一条排除):macOS 26 无 root 下 `sample` 不可用,但 **`SIGUSR1` + CDP Profiler 对 CPU 饱和型 stall 完全可用**(本次即为实证;localhost:9229,免重启)。已固化为黄金窗口人工取证手法,不进 guard 自动机制(只删不加)。

## 4.6 附录:2026-08-29 01:2x–01:4x 干预反证 + held-dispatch 复核

- Lead 按 founder 直令把 **66,272 条终态 mailbox 行归档(零删除)**后,p99 `30752ms → 279ms`(110×),反向确认 §4.5 的 mailbox 热循环病灶;其修法归 **FLY-2136**,本单不重复。
- 01:45Z 症状再次出现(`/health` 3.8–5.7s、哨兵 start-transfer 最高 41.56s),但此时 mailbox 仅 **487 行**(终态 159、无回积):所以 **mailbox 已被排除出这一波**。TCP connect 仅 0.25ms 而 start-transfer 久等,证明请求已到本机、主循环迟迟不服务;T1/T3 的同步链判别与缓解仍有独立价值。当前生产 build 尚未含本分支 marker,不能把「无 marker」误报成反证。
- 同窗另有 `engine_land_authority_unavailable` held-dispatch 重试风暴:最新 12,000 行 Bridge log 中占 **9,663 行**。为检验「日志多 = CPU 凶手」假说,本席用已开启的 Node inspector 连取两个 15s CDP profile:
  - 第二窗按调用树累计,`WorkflowEngineDispatcher.reconcile` 占 **2.58% inclusive**;主要是 `reconcileDeadExecutionTripwires` 1.52% 与 `reconcileWorkflowReworks` 0.84%,held land consume 本身未形成可见热点。结论:它是确定的无效重试/日志噪音,但**本采样窗不支持它是 41s stall 主凶**。
  - 同窗更大的同步消费者是 `CodexTmuxAdapter.isWaiting` 27.45% inclusive、`HeartbeatService.getZombieAlertBacklog` 21.78%、tmux `spawnSync` 10.45%;相邻第一窗 `readFileUtf8` 自耗累计约 36.8%。这些是后续取证候选,不在本单横向扩修。
- held 状态做指数退避或事件驱动重评值得另立 follow-up;按 Lead 指令只留证据,**不在 FLY-2058 当场改**。

## 4.7 附录:2026-08-29 02:1x–02:3x gate-marker 铁证

- Lead 转来独立发现:`~/.flywheel/state/codex-gates` 有 7,955 个顶层文件、目录总量 250MB。现场拆分后校准数字:**热路径实际会读取的是 7,955 个顶层 JSON,合计 3,259,327 bytes**;250MB 还包含一个误落在目录里的 162MB Git clone 与 57MB `ask/` 子目录,`listGateMarkersForExecution()` 都不会递归读取。目录总量不是每轮 I/O 量,不能混报。
- 生产 Bridge 已落盘的 20 个连续 CPU profile(02:15–02:35Z,合计 648.221s sampled wall time)给出直接调用栈:`listGateMarkersForExecution` **28.79% inclusive**、`CodexTmuxAdapter.isWaiting` **25.07%**、全部 `readFileSync` **43.50%**、`readdirSync` **1.24%**;同期 Git 栈仅 **0.03%**。最坏的 10–17s episode 窗里,marker 全量扫描占 **67.16%–77.05%**,原生 `readFileUtf8` 占 **57.25%–66.99%**。
- 源码闭环:`CodexTmuxAdapter` 的 resident goal `isWaiting()` 与 gate deadline watcher 都按 executionId 调 `listGateMarkersForExecution()`;后者每次先 `readdirSync` 顶层目录,再同步读取/解析**全部** `.json`,最后才按 executionId 过滤。每个活跃 Codex adapter 都重复同一全量扫描。⇒ 这条链已从「候选」升级为**当前 2–17s 主循环 stall 的直接实证主凶**,并且比本窗 Git 链高三个数量级。
- 最小修法不建 marker index/cache、不迁移文件格式:复用已安装的 `CommDB.hasPendingBlockingGateFrom(executionId)` 作为 `isWaiting` 权威(源码注释本就声明 DB 是 authority),deadline watcher 用 `getOpenGatesByRunner(executionId)` 取得极小 questionId 集合,再逐个 `readGateMarker(dir, id)` 读取 timeout 元数据;为 sender 查询补一个窄 SQLite partial index + query-plan gate。顶层 residue 不再进入周期热路径;清理 7,955 个旧 marker 与误落 Git clone属 FLY-2136/运维清理,本单不删除外部状态。

## 5. 边界(明确不做/未知)

- **shuttle 成对重启(00:00/12:00,间隔 31s)不在本单**:账本里没有任何一条落在 shuttle 时刻 ⇒ 那是另一机制(疑似 bootout TERM→ExitTimeOut→KILL),留观察线索但不建东西。
- 尚无任何一次 stall 的**实证归因**;§2 是最强嫌疑而非结论。
- family B 的 5 次,机器级 swap 风暴的成因(谁吃的内存)不在本单——本单只管 Bridge 在风暴里别自杀。
- 死亡实例日志灭失问题,只通过「guard 击杀前取证」绕过,不改主日志的轮转/时间戳机制(scope 纪律)。
