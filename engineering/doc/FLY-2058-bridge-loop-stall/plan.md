# FLY-2058 Bridge 主循环 stall 取证升级 + 冻结止损 + 嫌疑一缓解 — 实施计划

Issue: FLY-2058 (https://linear.app/geoforge3d/issue/FLY-2058/infra可用性-bridge-的-137-是-eventloopguard-主循环-stall-60s-自我-sigkill账上-14-次)
日期: 2026-08-28
基于: research.md(Codex design review R1+R2 修订:T2 无竞态状态机、T3 范围修正与 SIGKILL 语义、yield 原语改 `setTimeout(0)`、统一 execute 漏斗、collector 两次调用上限、测试 seam 具体化、children 脱敏、分批依赖关系)

## 0. 目标与非目标

**目标**(按依赖顺序分四个 commit,见 §3):

1. **T1 归因取证**:下一次 stall 发生时,forensic 行必须**总能**给出族判据(family evidence),并在 marker/子进程命中时给出归因;两者都未命中时显式记 `unknown`(慢 SQL / 纯 JS 自旋等未插桩来源),而不是缺字段。stall 频率 1–3 次/天,仪器上线后一两天内拿到下一份取证。
2. **T2 冻结止损**(依赖 T1 的 tick-gap):整进程冻结(family B)解除后不再补刀——按 §1-T2 的无竞态状态机记账不杀;真死锁只晚杀一个宽限窗(5s)。
3. **T3 嫌疑一缓解**:网络 git 子进程单步上限压到 10s(`SIGKILL` 语义,见 §1-T3),并保证**相邻两个网络 git 子进程之间 heartbeat timer 真实获得一次执行机会**——消灭「单宏任务多个 30s 网络阻塞连击」的结构。yield 原语必须是 `setTimeout(0)`(进入 timers phase),**不是 `setImmediate`**:R2 实测(Node v25.6.1,timer/poll 两种入口)`await setImmediate` 的 continuation 以 microtask 紧随 check phase 恢复,下一 timers phase 尚未发生,heartbeat 计数不推进;改 `await setTimeout(0)` 后两种场景均推进。
4. **T4 实证主凶止血**:生产 CPU profile 已坐实 `CodexTmuxAdapter.isWaiting → listGateMarkersForExecution → readFileSync` 是当前 2–17s episode 主凶(20 窗合计 28.79%,最坏窗 67.16%–77.05%;同期 Git 0.03%)。复用 CommDB 权威查询,把周期热路径从「每个 adapter 全读 7,955 个 JSON」降为「查本 execution 的 open gate id + exact marker read」。

**修正后的事实认定**(R1 核验):materializer 各方法之间虽有 `await`,但这些 git 方法内部没有真实异步点,resolved-Promise 的 continuation 只进 microtask,**不产生 event-loop turn,heartbeat timer 不会跳**——所以 `resolveBaseHead(最多 2×ls-remote + fetch)→ prepareOrAdoptCommit → readRemoteHead → pushCommit(ls-remote+push+ls-remote)→ readRemoteHead` 实际是**一整段连续同步 stretch**,网络挂起时远超 90s。这使嫌疑一更重,也使 T3 的 yield 必须是显式宏任务(见下),不能依赖方法边界。

**非目标**:不把 CDP/inspector 做进 guard 自动取证(research §3;本次只读既有 `.cpuprofile`);不 asyncify git 全链、不把 `assertNoSymlinkAncestor`/`readAndValidateCommit` 等本地同步 helper 异步化;不动 StateStore 查询层;不清理/迁移现有 gate-marker residue 或误落目录;不碰 shuttle 成对重启(ExitTimeOut 机制,另立单);不改主日志轮转/时间戳;不新增 env 旋钮。

## 1. 改动清单

### T1 归因取证(`BridgeEventLoopGuard.ts` worker source + 类 + marker 覆盖)

worker 检出 `age > stallThresholdMs` 后、走击杀路径前,采集 forensic 字段(逐项 try/catch;单项失败该项写 `null`,**采集失败不改变击杀语义**;预算表述:collector 子进程 `execFileSync timeout: 2000`,其余为同步本地 I/O best-effort,不承诺总 wall-clock 上限):

- `tick_gap_ms`:本次 check 与 worker 自己上一次 check 的间隔(worker 局部变量 `lastCheckAt`)。`≈checkIntervalMs` ⇒ family A;`≈stall_age` ⇒ family B。这是 T2 状态机的判据输入。
- `children`:**结构化脱敏 schema**,不记录原始 argv,collector **硬上限两次进程调用**:第一次 `execFileSync("/bin/ps", ["-axo", "pid=,ppid=,etime=,comm="], { timeout: 2000 })` 全表扫描,过滤 `ppid === bridgePid`,每条保留 `{ pid, etime, comm: basename }`;第二次对 allowlist(`git`、`tmux`)命中的全部 pid 做**一次批量查询** `execFileSync("/bin/ps", ["-o", "pid=,args=", "-p", "<pid1>,<pid2>,…"], { timeout: 2000 })`,在内存中逐条**只提取子命令词**存入 `sub`——提取规则:跳过 git 全局前缀参数(`-c <k>=<v>`、`--git-dir <path>`、`-C <path>` 及其值)后的第一个非选项 token 才是子命令,config value/路径绝不当作 `sub`;URL、ref、路径与其余 argv 在落盘前全部丢弃。过滤 collector 自身(`comm === "ps"`)。列表截断 ≤10 条。**成功采集但无业务子进程记 `[]`,采集失败记 `null`**(两态区分)。测试断言 collector 进程调用次数 ≤2。
- `last_sync_op`:现有 marker 读取不变(已实现)。
- `rss_mb` / `load`:`process.memoryUsage.rss()` 与 `os.loadavg()[0]`。
- 击杀行同时带检测值与终值:`stall_age_at_detect_ms`、`stall_age_final_ms`(无宽限时两者相等)。
- 归因判定字段 `attribution`:`marker` | `child` | `unknown`,**优先级固定**:marker 非空 ⇒ `marker`;否则存在脱敏后的业务子进程 ⇒ `child`;否则 `unknown`。原始字段(`last_sync_op`、`children`)同时保留,判定字段只是索引。T1 的验收就是「族判据总在,归因命中即归因,未命中显式 `unknown`」。

**marker 覆盖扩展**(复用 `withSyncOpMarker`,已从 `flywheel-claude-runner` 正式导出、`flywheel-teamlead` 已有 workspace 依赖,无新依赖边、无需改 `sync-op-marker.ts`):

- `workflow-docs-git.ts`:**marker 在唯一最外层执行漏斗**——新建私有 `execute(args, { timeoutMs, killSignal })`,由它根据原始 git args 生成安全 label(仅子命令词)、`withSyncOpMarker` 包住 `spawnSync`;`run()`(本地,30s)与 `runNetwork()`(网络,10s+SIGKILL,见 T3)**都委托 `execute`**,网络操作不可能绕开 marker。marker 单测必须分别在本地 `run` 与网络 `runNetwork`(特别是 `fetch`、`push`)阻塞期间读取 marker。
- `workflow-resume-checkpoint.ts` `run()` 漏斗:同法,label `"workflow-resume-checkpoint:" + 子命令`。
- `tmux-environment-scrub.ts` / `lead-backends/codex/tui-window.ts` 的 spawnSync:同法,label `"tmux-scrub"` / `"codex-tui:" + 子命令`。

**forensic 日志体积**:guard `start()` 时按现有 `rotateLogIfNeeded`(10MB 阈值)轮转——即**启动时轮转,不是运行期硬上限**;按 1–3 行/天的体量不为本单新增运行期轮转。

### T2 冻结宽限复查(worker source;依赖 T1 tick-gap)

**唯一事件名**:恢复记账事件固定为 `stall_recovered_after_freeze`(与击杀事件 `bridge_event_loop_stall` 并列)。

**无竞态状态机**(SIGCONT 后主 heartbeat timer 与 worker check 谁先跑都必须收敛):

每次 check tick 先原子读取并保存**检测快照** `{ lastBeatAtDetect, ageAtDetect, tickGapAtDetect, detectedAt }`,然后:

| 状态 | 条件 | 动作 |
|---|---|---|
| S0 正常 | `ageAtDetect ≤ threshold` 且 `tickGapAtDetect < threshold` | 返回,等下一 tick |
| S1 独卡击杀 | `ageAtDetect > threshold` 且 `tickGapAtDetect < threshold`(worker 一直健康,心跳缺席可信) | 先保存检测时 marker,再采集 children;采集后重读 heartbeat:仍未推进→SIGKILL;已推进→写独立事件 `stall_recovered_during_forensics` 后回 S0。后者不是 freeze,不得记入 `stall_recovered_after_freeze` |
| S2 冻结已自愈 | `tickGapAtDetect ≥ threshold` 且 `ageAtDetect ≤ threshold`(worker 冻过,但主线程心跳已先恢复——heartbeat 赢了竞态) | 写一条 `stall_recovered_after_freeze`(`recovered_via:"immediate"`,字段取检测快照)→ 回 S0 继续监视 |
| S3 冻结待复查 | `tickGapAtDetect ≥ threshold` 且 `ageAtDetect > threshold` | 暂停主 check interval,启动**唯一一个** pending grace(`setTimeout(graceMs=5000)`);到时重读心跳:`currentBeat ≠ lastBeatAtDetect`(已推进)⇒ 写 `stall_recovered_after_freeze`(`recovered_via:"grace"`)→ 恢复 check interval 回 S0;未推进 ⇒ 用**最新** age 采集取证 → SIGKILL |

- recovered 行与击杀行都同时带 `stall_age_at_detect_ms` / `tick_gap_ms` /(击杀时)`stall_age_final_ms`,消除「字段取初值还是复查值」的歧义:检测值一律入 `*_at_detect_ms`,复查后终值入 `*_final_ms`。
- `stall_recovered_during_forensics` 只表示 S1 检出后、collector 运行期间主 heartbeat 已恢复;它保留检测时 `last_sync_op`,不属于 family B,也不使用 `recovered_via`。这是避免「已经恢复仍补刀」的第二次确认,不是放宽 stall threshold。
- S3 期间不重入(interval 已暂停);恢复后**同一 worker** 回到 S0 并可再次进入任何状态——「recovered 后继续监视、还能再杀」是同一 generation 内的显式合同(testMode 合同:`recovered` 可多次,terminal `stall` 每 generation 至多一次,见 §2)。

### T3 pushCommit / resolveBaseHead 网络链缓解(`workflow-docs-git.ts`)

- `runNetwork(args, cwd, …)`:网络 git 子命令(**`ls-remote`、`fetch`、`push` 全部走它**)`timeout: 10_000` 且 **`killSignal: "SIGKILL"`**,与本地 `run()`(30s 不变)一起**委托 T1 的 `execute` 漏斗**(marker 不被绕开)。R1 实测(Node v25.6.1):默认 SIGTERM 语义下,忽略 SIGTERM 的子进程让 `spawnSync` 远超 timeout 仍不返回;`SIGKILL` 不可捕获,才能支撑上限语义。
- **SIGKILL 的清理语义要单独验收**(不得默认「失败语义不变」):SIGKILL 不运行 git 的 signal/atexit 清理,`fetch` 可能留下 lock/temp pack,网络 git 可能有 remote-helper 后代。对每条强杀路径(尤其 fetch)加行为测试:同一 fixture 上被杀后**随后的正常重跑必须收敛**、repo 内无阻塞后续 git 的 lock/temp 残留、无仍存活的 fake remote-helper 进程。若实测发现残留,再在「bounded cleanup / git 自身传输 timeout(如 `http.lowSpeedLimit`/`lowSpeedTime`)/ 仅网络步做小范围进程组管理」中选最小方案——不预建清理机制。
- **显式 yield 原语 `yieldToTimers()`** = `await new Promise(r => setTimeout(r, 0))`(进入 timers phase;见 §0 R2 实测,`setImmediate` 不满足合同)。合同:**相邻两个网络 git 子进程之间必有一次 `yieldToTimers()`**。逐点列出:
  - `resolveBaseHead`:branch probe `ls-remote` → yield → HEAD fallback `ls-remote`(若走到)→ yield → `fetch`;
  - `readRemoteHead`(单网络步,无内部 yield 需求);
  - `pushCommit`:`ls-remote` → yield → `push` → yield → confirm `ls-remote`;
  - `workflow-docs-materializer.ts` 的方法边界(`resolveBaseHead`→`prepareOrAdoptCommit`→`readRemoteHead`→`pushCommit`→`readRemoteHead`之间)各插一次 yield——await 边界本身不产生 turn(§0 修正)。
  - 本地同步 helper 不 async 化;`prepareOrAdoptCommit` 内部全为本地操作,不加 yield。
- 超时(SIGKILL)时原始 `spawnSync` 是 `status:null` + `signal:"SIGKILL"` + `error.code:"ETIMEDOUT"`;执行漏斗必须用现有 `status: result.status ?? 1` 归一化,再交给现有非零错误路径(throw / materializer 告警 / adopt 幂等)。10s 是**单个网络子进程**的上限;整条链的最坏值 = 网络步数 × 10s + 本地步耗时,不宣称固定总上限,验收以「击杀线以下 + 心跳有推进」为准(§2-7)。

### T4 gate-marker 周期全量扫描止血(`CodexTmuxAdapter.ts`)

- 在每个 adapter `execute()` 生命周期内复用一个 `CommDB` handle。`runGoal.isWaiting` 正常路径只调用现有 `hasPendingBlockingGateFrom(executionId)`;它天然排除 checkpoint-less `ask`,且 DB 本来就是 lifecycle authority。为两条 sender 查询新增一个窄 partial index `mailbox_questions_by_sender ON mailbox(from_agent, created_at) WHERE type='question'`;既有 unique response index承担 `NOT EXISTS` 子查询。query-plan 测试必须断言两条查询使用该 index 且无 bare mailbox scan。
- gate deadline watcher 正常路径调用现有 `getOpenGatesByRunner(executionId)`,对返回的 questionId 逐个 `readGateMarker(dir, id)` 取得 `timeoutMs` / `timeoutBehavior`;不再 `readdirSync` 或读取无关 execution 的 marker。已见过的 id 保留在 watcher 内的小 Set,让 answered/timeout marker 仍能 exact-read 后清理;不扫历史 residue。
- `CommDB` handle 建立失败、查询抛错、或显式 closed guard 命中时,`isWaiting` **回退旧 marker scan**,不是直接报 false;watcher 查询失败同样本 tick fallback。execute 的 goal 已 settle 后先置 closed guard + 停 watcher,再 close handle,避免 teardown callback 误用。测试覆盖运行中 query throw 与 execute 结束后的 retained closure。
- exact-read watcher 只清理由本 watcher 见过的 marker。答案早于第一次 tick、或 Bridge downtime 内完成的 marker 将不再被这条路径发现,所以 cleanup coverage 比现状窄、residue 会继续增长;它已退出热路径,外部状态清理归 FLY-2136/运维。本单不改 `gate-marker.ts` 格式、不建 marker index/cache、不删除现有 7,955 个 marker 或 162MB 误落 Git clone。

## 2. TDD 与验收

### 测试 seam(先于测试用例写清,R1 修正:现有 seam 不够)

- **worker 侧新增 testMode-gated workerData 字段**(结构化可克隆数据,不传函数):`psCommand?: string[]`(collector 可执行文件+固定前缀 argv 的替身,同一替身承接全表与批量两次调用——两次调用只在追加参数上不同;测试注入 fake 脚本路径或不存在路径以驱动成功/失败/超时三态)、`graceMs?: number`(默认 5000,测试压到百 ms 级)。生产路径(`testMode:false`)不读取这些字段之外的行为差异。
- **真 worker + 受控 SAB**:单测用真 `LOOP_GUARD_WORKER_SOURCE` 起 worker(现有 testMode 通道),测试直接操纵 SAB 心跳槽模拟「冻结→恢复」的两种线程顺序(check-before-heartbeat / heartbeat-before-check),不替换 worker source。**两种排序的覆盖只由这些 deterministic 单测负责**(进程级 SIGSTOP 测试不宣称能控制排序,见 §2-6)。
- `testMode` 合同(R3 唯一化):**同一 worker generation 可发零到多条 `recovered`,随后至多一条 terminal `stall`**;发 stall 后停掉 check timer 但保留 port 供测试清理,不自动复活(与生产 S1 terminal 语义一致)。**「recovered 后继续监视并最终击杀」必须在同一 generation 内验证**:状态机测试在同一 worker 上驱动 `S3 恢复 → S0 → S1 击杀`,证明 interval 真正重启、`lastCheckAt` 更新、pending grace 解除。只有测「第一条 terminal stall 之后的第二次 terminal stall」才启动新 generation。
- 现有 `createWorker`/`now` seam 保留原用途(父线程侧),不再声称它能注入 worker 内部时钟。

### 单测(vitest, `packages/teamlead` + `packages/claude-runner`)

1. **状态机四态**:S0/S1/S2/S3 各分支;S3 的恢复与未恢复;两种 SIGCONT 排序(S2 与 S3-恢复,受控 SAB 驱动);**同一 worker generation 上驱动 `S3 恢复 → S0 → S1 击杀`**(证明 interval 重启 / `lastCheckAt` 更新 / grace 解除);第二次 terminal stall 用新 generation。另测 S1 collector 期间恢复只写 `stall_recovered_during_forensics`,不写 freeze 事件。断言 `*_at_detect_ms`/`*_final_ms` 语义、terminal stall 每 generation 至多一次。
2. **forensic 字段**:`psCommand` 注入 fake 输出 ⇒ children 脱敏 schema(basename + allowlist 子命令词、git 全局前缀跳过规则、collector 自滤、≤10 条截断、`[]` vs `null` 两态、**collector 调用次数 ≤2**);**负向测试:fake ps 输出含 credential 形态 argv(URL 带 token、`x-access-token:…`、`-c http.extraHeader=…`),断言产物中不出现**;`attribution` 优先级(marker > child > unknown)。
3. **marker 漏斗**:`execute` 漏斗在本地 `run` 与网络 `runNetwork`(特别是 `fetch`、`push`)阻塞期间 marker 存在且 label 正确(仅子命令词,无 URL/路径),结束后清除;`workflow-resume-checkpoint` 与 tmux/tui spawnSync 同理。
4. **yieldToTimers 合同**:直接测生产 helper——从 timer phase、poll phase 两个入口分别先同步阻塞超过 heartbeat interval,再 `yieldToTimers()`,断言 continuation 执行前 heartbeat 已推进(`setTimeout(0)` 语义);并断言 `setImmediate` 版本会失败的回归锚(防止将来「优化」回去)。runNetwork/run 分别走 10s+SIGKILL / 30s 的参数断言。
5. **gate authority / 热路径**:`runGoal.isWaiting` 在「CommDB 有 blocking gate、marker 缺失」时仍为 true;在「只有 marker、CommDB 无 open gate」时为 false;checkpoint-less ask 为 false。DB query throw / closed handle 时回退 marker。deadline watcher 保留 timeout response + 本实例已见 marker 清理现有测试。另放置大量无关 marker,断言本 execution 的等待/超时语义不受影响;`EXPLAIN QUERY PLAN` 断言 `hasPendingBlockingGateFrom` 与 `getOpenGatesByRunner` 都用 `mailbox_questions_by_sender` 且无 bare mailbox scan(不以脆弱 wall-clock 阈值当正确性断言)。

### 进程级行为验收(`scripts/__tests__/` bash harness 或 vitest spawn 真进程;issue 要求行为级)

5. **真独卡击杀**:最小 node 进程加载真 guard(阈值压到 5s 级),主线程 `spawnSync("/bin/sleep", ["8"])` ⇒ 断言子进程退出 `signal === "SIGKILL"`(Node child `close` 事件的 signal 字段,不只看退出码)、forensic 行 `tick_gap_ms` 小、children 含 sleep(comm basename)、`attribution:"child"`。harness 要求:ref'ed keepalive 防提前退出、独立临时 log 路径、超时清理。
6. **真冻结不杀**:同 harness,外部 `kill -STOP` 整进程 7s 后 `kill -CONT` ⇒ 断言进程**存活**、账上有 `stall_recovered_after_freeze`(**`recovered_via` 取 immediate 或 grace 均通过**——OS 排序不可控,排序覆盖归 deterministic 单测,本测只断言族与存活)。
7. **网络链行为回归**(R2/R3 修正:不应答 remote 在 `resolveBaseHead` 就抛 `materializer_remote_base_unavailable`,后续步骤不可达;首次 materialization 的完整网络序列是**八个 ordinal**,漏掉外层 `readRemoteHead` 会漏测两条恰好依赖 materializer 边界 yield 的相邻对):
   (a) **完整成功序列(八步)**:scripted fake git——按稳定命名的八个网络 ordinal:① resolve branch probe(ls-remote)② HEAD fallback(ls-remote)③ fetch ④ materializer 外层 pre-push `readRemoteHead` ⑤ `pushCommit` 内部 current-head probe ⑥ push ⑦ `pushCommit` 内部 confirm ⑧ materializer 外层 final `readRemoteHead`——每步返回合法输出且各同步阻塞一段时间,真 guard 全程在线 ⇒ 断言 ①–⑧ 实际调用顺序、**每一对相邻网络步之间** heartbeat 已推进(覆盖 git 方法内部与 materializer 方法边界的全部 yield,特别是 ④→⑤ 与 ⑦→⑧)、全程不击杀。guard 测试阈值显式设在**单步上限之上、两个连续网络步之下**。
   (b) **逐 ordinal 超时**:参数化地让八个 call-site ordinal **逐个**单独 timeout(其余成功;按 ordinal 不按子命令种类分组)⇒ 逐个证明 10s+SIGKILL 返回与错误传播路径。
   (c) **SIGKILL residue/重试收敛(必须真实 Git)**(§1-T3):**真实 `git` 可执行文件 + 隔离临时 repo + 可控阻塞 transport/helper**(fake 只能证 Node 侧 timeout,证不了 git 自身的 lock/temp pack 行为);强杀 fetch 后在**同一真实 repo** 执行一次正常真实 fetch / 完整 materializer retry ⇒ 断言收敛、无 git lock/temp 残留;fake helper PID 存活检查作为同测试的附加断言。若真实 fixture 证明有残留,按 §1-T3 菜单选最小修复并 red-green;若无残留,该测试本身就是结论的保留证据。
   (d) 真实不应答 socket 仅作首个网络步 timeout 的 smoke,不再宣称覆盖完整序列。
   (e) fake git 可执行文件忽略 SIGTERM ⇒ 断言 `runNetwork` 在 ~10s 返回(硬上限语义)。

### 全仓门(执行体必跑)

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(注意失败即停假绿坑:确认 teamlead 包真的跑到)+ 新增 bash harness。

## 3. 分批与回滚(R1 修正:是 commit/revert 单元与依赖链,不是独立开关)

| commit | 内容 | 依赖 | 涉及文件 | revert 注意 |
|---|---|---|---|---|
| 1 | T1 forensic + marker 覆盖 | — | `BridgeEventLoopGuard.ts`;`workflow-docs-git.ts`、`workflow-resume-checkpoint.ts`、`tmux-environment-scrub.ts`、`tui-window.ts`(marker 包装) | 单独 revert 安全(无击杀语义变化) |
| 2 | T2 宽限状态机 | commit 1(tick-gap) | `BridgeEventLoopGuard.ts` | revert 它保留 commit 1 需要手工处理同文件 delta |
| 3 | T3 runNetwork + yield | — | `workflow-docs-git.ts`、`workflow-docs-materializer.ts` | 与 commit 1 共享 `workflow-docs-git.ts`,revert 时保留 marker 包装的 delta |
| 4 | T4 CommDB gate authority + exact marker reads | — | `mailbox-schema.ts`;`CodexTmuxAdapter.ts`;query-plan + adapter tests | 独立 revert;会恢复全量 marker scan 热点 |

- **四个 commit 同属一个 PR、一次班车部署**——它们是 review/revert 单元,**不是分阶段上线开关**(R2 修正:不宣称「commit 1 先上线观察再启用 commit 2」;若未来确需分阶段生产观察,那是拆多个 PR 的决策,不在本计划默认路径)。
- 无 schema 变更、无新 env 旋钮、无新子系统。部署走正常班车(FLY-1959:merge 不触发即时重启)。
- 上线后按 family/attribution 分桶验收,不拿 aggregate kill count 反推单一 commit:T2 看 `stall_recovered_after_freeze`;S1 二次确认看 `stall_recovered_during_forensics`;T4 看 event-loop profile 中 `listGateMarkersForExecution` 热栈消失/健康 p99;T3 只看 family-A + `attribution:"marker"|"child"` 且 git `sub` 命中的 kill/episode 是否下降。`unknown` 桶仍高再按实证立慢 SQL / microtask follow-up。

## 4. 风险

| 风险 | 缓解 |
|---|---|
| worker 里 collector 卡死拖延击杀 | collector **硬上限两次**进程调用、各 `timeout: 2000`(最坏 ~4s 延迟,非 1+10 串行);逐项 try/catch;其余为同步本地 I/O best-effort;任何失败带残缺包照杀 |
| 宽限把真死锁多养 5s | 仅 `tick_gap ≥ threshold`(worker 自证被冻)才进 S2/S3;S1 路径行为零变化 |
| 网络 git 10s+SIGKILL 抬高慢网失败率 / 留 residue | 失败路径本就有重试/告警;materializer 幂等(adopt 已存在 commit);SIGKILL 只用于网络步,本地步不变;**residue/重试收敛有专项验收 §2-7(c)**,发现残留时按 §1-T3 选最小对策;若告警噪音上升单独调回常量 |
| CommDB 短暂不可用让 gate wait 误判 | handle 建立失败、查询异常、closed guard 都 fallback 旧 marker scan;deadline watcher 本 tick同样 fallback,下一 tick重试 DB |
| `prepareOrAdoptCommit` 的 2N+5 个本地 git 子进程仍可能形成未 yield stretch | T3 明确只拆网络链;本地 FS 通常快但不是硬上限。T1 marker 会把现场记为 git local sub;若该桶命中,后续最小改为 payload loop 每轮 `yieldToTimers()`,本单不在无命中前扩大 async 面 |
| children 泄露敏感串 | 结构化 schema:basename + allowlist 子命令词,argv 全弃;负向测试含 credential 形态 |
| forensic 行膨胀 | children ≤10 条、每条仅三短字段;guard log 启动时 10MB 轮转,1–3 行/天体量可控 |
| 同文件多 commit 回滚纠缠 | §3 表格显式列出重叠文件与 revert 注意;T2/T3 各有独立行为测试锚定 |
