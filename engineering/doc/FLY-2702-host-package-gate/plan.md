# FLY-2702 主机 package gate 排队 — 实施计划
Issue: FLY-2702 (https://linear.app/geoforge3d/issue/FLY-2702/主机吞吐-本机全量-package-gate-无并发上限今天-6-7-具体同时跑-pnpm-testpackagesrun单次)
日期: 2026-09-17
基于: research.md

## 状态与交付边界
Status: review-pending（round 1 HIGH 已修订，待新审查）。本计划供独立 Implement / QA 节点执行；Design 不实施、不部署、不派发。有效 reviewVerdict=APPROVED 才完成设计交接。Lead 范围答复：b44b5250-57a1-4fce-a36e-27475cf3f6a4。

## 1. 不变量
1. enabled 本机所有 worktree 同 UID 只有一个容量域；原子 `occupied < capacity` 且 request 为最早 queued 才能 reserved；occupied 包含 reserved/running/draining/recovery_hold。
2. 入队期间零 build / Vitest；一次占位覆盖构建、所有 package 与最多一次 RPC retry。
3. 心跳超时不撤销活任务。释放须证明 supervisor 不再启动工作且运行组为空；死亡父进程不能释放仍运行的子孙所占名额。
4. FIFO 只按数据库分配的 seq 排序；requestId 为随机 UUID；队位/时长/标签不是身份。
5. queued 不产生测试成功/失败，也不消耗测试执行 timeout；只有对应本次有效等待才抑制 STALLED。
6. 默认不改变 CI；启用失败不 fail-open；回退必须明确标注 bypass。

## 2. 模块及入口
保留 package.json 命令。将 `classifyAttempt`、`summarizeRun` 与现有实际执行循环抽到 `scripts/lib/package-gate-core.mjs`，scripts/package-gate.mjs 保留导出兼容及公开 runGate。新增：
- `scripts/package-gate-host.py`：Python 标准库 sqlite3 的队列、事务、监督运行、信号处理、status/config 子命令；无需构建即可启动。
- `scripts/package-gate-worker.mjs`：内部执行当前完整 gate；由 supervisor 在启动屏障后运行。公开 CLI 和导出 runGate 都经过限流，不提供可由普通 CLI flag 跳过的内部模式。worker 是内部模块，不是恶意同 UID 的隔离边界。
- `packages/teamlead/src/package-gate-queue.ts`：有界只读 reader、运行身份核验及纯解析；供 collector sample/recheck 共用。
- 新增单元/多进程测试与 `scripts/qa-package-gate-host.mjs` 验收 harness；QA 原始输出写本 issue evidence/ 下。

公开 `runGate({root,pnpm,receiptRoot,quiet})` 返回原 summary；enabled 时从 supervisor 子进程的专用控制 fd 接收 result，stdout/stderr 保持原测试输出。测试依赖注入独立 queueRoot/processProbe/clock 仅存在测试 API，不提供生产 env 换 root。CI/bypass 直接调用 core，无 Python/DB/probe 访问。

### 2.1 唯一主机路径与开关
Python `pwd.getpwuid(os.getuid()).pw_dir` 得实际用户 home，规范化为 `<osHome>/.flywheel/state/package-gate/v1/`。UID 和随机创建的账本generation写入meta。bootId不是准入依赖；本沙箱sysctl也不可用，不得用它阻止正常gate。不是 worktree、project、CODEX_HOME 或 tmpdir。collector 必须由相同 OS 解析器取得路径，不能用 Bridge scratch HOME 或可任意指向文件的报告输入；root mismatch 报 UNKNOWN。

只对 `process.platform === 'darwin' || 'linux'` 的本机路径启用；CI 识别沿用常用 `CI` 非空且非 `0/false`，另 `GITHUB_ACTIONS=true`，CI 始终走既有 core。新增本机 env `FLYWHEEL_PACKAGE_GATE_HOST_LIMIT=0` 为整体回退；unset/1 为启用，其余非空值报配置错。CI 即使设置 1 也不创建队列。主机另有固定路径 `control.json`，缺省 mode=disabled；`config --enable/--disable` 原子写入mode/generation。新调用和queued每250ms读取，损坏/不可读不是disabled而是基础设施错误。disabled的新调用直接core；queued见disable则事务取消自己的排队记录、打印bypass后直接core，occupied继续原监督收尾。关闭是明确放弃上限，不能声称仍N受控；无需重启Runner。启用必须账本排空，先确认部署的collector已支持队列。env禁用只影响该调用；主机control关闭同时解开现有queued等待，正常回退先停止新交卷并排空，紧急关闭可直接放行queued但明确不保证上限。绝不删除occupied记录。

容量持久化在同一 DB 的 singleton meta，首次事务创建 capacity=2（待 QA 实测）。`python3 scripts/package-gate-host.py config --capacity 2|3` 只允许账本无 queued/occupied 时事务修改；拒绝 0/负数/NaN/过大数。无每进程 N env，避免各自上限不同。status 输出当前容量及是否未校准。调参由 Implement/QA 实测完成，不由 Design 修改主机配置。

目录 0700，文件 0600；拒绝软链接、非本 UID owner 和非本地文件系统；固定子文件名，无用户拼接路径。DB 用 DELETE journal（低频短事务，不需 WAL），busy_timeout=250ms；忙时退避≤250ms后重试，不当测试红、不绕过。所有 SQL 参数绑定。DB 无法安全读取/损坏/磁盘满则明确 infrastructure_error，非零且保留诊断；不要覆盖损坏账本自建空队列。

## 3. 数据合同与事务
`meta(schemaVersion=1, uid, generation, capacity, calibrated, revision, nextSeq)`；`requests(requestId TEXT PRIMARY KEY, seq INTEGER UNIQUE, protocolVersion, state, enqueuedAt, supervisorPid, ownerLockId, worktreeRealpath, head, executionIdClaim NULL, heartbeatAt, admittedAt NULL, workerPid NULL,  pgid NULL, finishedAt NULL, exitCode NULL, outcome NULL, receiptPath NULL)`。

state 枚举 `queued, suspended, reserved, running, draining, recovery_hold, finished, cancelled, abandoned`；finished/cancelled/abandoned 不占槽。seq由meta.nextSeq在同一个写事务内递增分配，永不重用；时间 UTC 毫秒用于展示，时长/等待上限用 monotonic。每次独立调用产生新 requestId；RPC retry 不重新入队。真正重新调用不是旧请求复用，避免两次执行同一个槽。

主机supervisor先以request UUID创建0600的独占owner.lock并持有flock(LOCK_EX)，再以BEGIN IMMEDIATE插入queued。owner lock是进程生命周期凭据：不依赖ps/PID birth，持有者死亡内核释放；文件在live期间及该row尚保留时不unlink，不复用UUID；终态超保留期且再次确证owner锁自由、组为空后，先事务删row再删该UUID文件。request行与lock文件匹配必须核验dev/inode/uid，禁止换文件骗取空锁。入场交易读取 capacity、按 seq 找最早有效 queued、计算 occupied 并 CAS queued→reserved；只有本请求可认领自己，队首每 250ms 唤醒，最多 250ms jitter。queued心跳超过10s时，在事务内CAS为suspended，不占名额也不挡后面健康queued；其恢复必须在事务中领取新的seq（requestId不变，保存previousSeq），状态回queued，不能用旧reservation继续运行。这样FIFO定义为健康可调度请求的入队顺序。occupied从不因心跳陈旧被夺槽；陈旧/死owner按§4恢复。每笔写事务毫秒级，禁止事务中启动子进程、读远端或等待进程退出。

每 2s heartbeat 更新与 10s pane 更新；入队、队位改变、入场、终止即时打印。文本固定前缀：`PACKAGE_GATE_WAIT request=<uuid> 等待第 k 位 / 前面 m 个 / 已等 ts`。k 为 queued 的一基序号，m=k-1，不含运行者；同时列 `运行 r/N`。quiet 只静音测试内容，生产等待信息仍输出 stderr；测试可注入 sink。

每个事务提交后在短投影锁下读最新 revision 并原子 tmp+rename 刷新 ledger.json，避免旧写者覆盖新投影；最多每秒合并一次。ledger 含全部 live rows、最近100条终态、updatedAt、revision、capacity、requestId/pid/worktree/enqueuedAt/position/waitMs。投影失败报警但不改变 DB 授权；status --json/--text 直接读 DB，巡检不信投影。终态最多保留7天且最多10000条，清理不得删除 live rows；不触及现有 /tmp gate receipt 保留策略。

## 4. 崩溃、安全启动与释放
监督进程必须跨过两个不同问题：原子取位；取位后子进程启动/崩溃窗口。

### 4.1 屏障与生命线
1. reserved已提交后，Python supervisor建立独立session/process group的launcher。launcher只发READY(pid,pgid)，阻塞在匿名GO管道，不能运行Node/build/test。
2. supervisor将PGID提交reserved行；失败关闭管道，launcher EOF直接退出。GO写端不传给launcher或孙进程；只有supervisor持有，避免自己留下写端使EOF永不发生。
3. commit成功才发一次GO；launcher exec Node worker，PID/PGID保持。running写失败仍reserved计容量；重放不二次启动。
4. supervisor→worker另有单向lifeline fd（生命线：上游消失即EOF）。worker的独立收尾watchdog与其同沙箱、在测试进程组之外，持有读端；读到EOF或core完成/崩溃就对自己建立且仍归属本次请求的组TERM，5s后KILL，再以killpg(pgid,0)得到ESRCH确认清空。lifeline写端也只能在supervisor，不能被worker/watchdog/测试继承。watchdog在GO前建立且READY回执必须含watchdog pid；它不运行测试、不占额外gate名额。
5. supervisor和watchdog都可以执行本请求正常清理，操作幂等；只有自身创建的组可发送TERM/KILL，其他沙箱reaper只signal 0观察，绝不发终止信号。core完成后有残留，同样TERM→5s→KILL，receipt记残留组和cleanup结果；清理异常使hostQueue基础设施失败，不能把测试passed掩盖为完整通过。

CLI收到SIGINT/SIGTERM：queued取消零子进程；occupied转draining并启动上述cleanup；130/143保留。CLI突然死亡导致supervisor的控制管道EOF；supervisor死亡由watchdog生命线EOF触发收尾。watchdog死亡但supervisor活由supervisor接管；两者同时死亡但测试组还有成员时保留recovery_hold，直到组自己结束或有同沙箱存活控制者清理；不能以TTL超发。极端多重故障是可见异常，不作为正常自动恢复通过案例。

summary保留schemaVersion=1与0/1/2测试语义，加可选hostQueue。core.startedAt保留原执行起点；submittedAt/admittedAt/finishedAt/queueWaitMs/serviceMs/totalWallMs明确区分等待与运行。基础设施失败exit=1、failureKind=host_queue，保留已有测试receipt。

### 4.2 跨沙箱自动恢复：不使用ps、bootId或完整census
每个等待supervisor最多每2s恢复扫描。新开同inode owner.lock做LOCK_EX|LOCK_NB：冲突证明该request仍有holder；成功证明holder已释放/死亡，立即关闭探测fd。所有协议写者遵循同一DB短事务，snapshot/CAS复核state、ownerLockId和pgid。未找到lock、inode变化、权限错误均UNKNOWN，不等于死亡。
- queued holder已无：abandoned；queued holder活但heartbeat陈旧：suspended，恢复后新seq。occupied holder活：保留。
- occupied holder已无且PGID尚未登记：GO尚不可能发出，按屏障协议abandoned，自动释放。
- occupied holder已无且PGID登记：只调用 `os.killpg(pgid,0)`。ESRCH是空组证据，可CAS abandoned释放；成功或EPERM都表示不能证明空组，保留recovery_hold。后续每2s继续观察；watchdog在原沙箱收尾后跨沙箱观察变ESRCH即可自动释放，无需不受限的清理服务。
- 永不以 `kill(pid,0)` 或PID号码宣称精确身份；PGID复用为别的组只会保守延迟释放，reaper绝不signal该组。全部旧lock已自由且所有登记组均ESRCH的重启残留自动清空；若PGID被复用长驻则明确recovery_hold，需要Lead在排空确认后做记录级修复，不能删除整库。该罕见歧义是Follow-up，不假称所有崩溃都能有界恢复。

可用性证据见evidence/sandbox-primitives.json：当前真实Codex沙箱pwd/SQLite/flock可用；另一工具调用内活组probe=EPERM，其45s后自然结束后同PGIDprobe=ESRCH。ps与两种boot sysctl均不可用，全部移出正常gate及reaper依赖。这只是两个工具调用的原语可行性，不替代两个独立真实Runner沙箱的验收。

正常释放后≤5s交接；普通单点CLI/supervisor死亡后watchdog≤5s收尾+≤2sreaper检测再放行（进程不能立即死亡时继续hold并显示原因）。全组SIGKILL后锁自动自由、组ESRCH，≤2s扫描回收；不设必须等10s才检查的延迟。

## 5. 巡检身份、状态与消费闭包
scheduler只记录原始 `FLYWHEEL_EXEC_ID` 声明、worktree realpath、PID展示值、request lock identity和enqueuedAt，不读CommDB/StateStore、不在Python复制collector身份规则。完整绑定只由已有TS collector查StateStore和CommDB：worktree binding / workflow_execution_binding / workflow_activation_turn来自StateStore；owner / runner_workflow_activation / three_stage_turn来自CommDB。

`package-gate-queue.ts`用只读DB快照返回absent | queued-valid | unrelated | unknown。queued-valid要求schema/UID/generation、state=queued、heartbeat≤10s、owner lock仍冲突、worktree realpath与当前runner绑定一致、exec claim等于该owner；由可信collector对当前runner与supervisor ancestry做既有host进程观察核验（不是沙箱里的gate前置）。还要求enqueuedAt严格晚于当前activation grant创建时间和当前binding创建时间，当前tuple在collector前后复核不变；同时间戳边界/时钟异常/无法取得grant时间返回UNKNOWN，不用猜测将旧排队归给新activation。稳定语义digest包含当前权威tuple+requestId。历史激活的排队不准穿越grant边界；手工anonymous也受限流但不授予Runner WAITING。

具体取数：扩展现有TS collector查询，读取StateStore `workflow_activation_turn.granted_at`（StateStore.ts:29329）、`workflow_execution_binding.bound_at`（:5852）及 `sessions.worktree_binding_locked_at`（:25623）；边界取三者的最大值，时间严格解析，缺失/不合法/晚于当前采样为UNKNOWN。该取数留在TS collector共享查询中，Python不复制。有效path、锁、时间并不替代owner核验。同UID恶意文件伪造不在本轮安全隔离承诺内。

在 collector 完成既有所有 owner/ref/events 检查后，加 `effectiveWait={kind:'package_gate_queue',id:requestId}`（明确固定优先级：gate → declaration(parked/long_task) → phase → package_gate_queue，保留既有顺序），另带 queueEvidence（requestId/status/seq/position/enqueuedAt/observedAt/revision）。fingerprint 只纳入 requestId+state+绑定，不纳入 heartbeat/position/revision；前后状态变化本轮 UNKNOWN，下轮重采样。数量字段安全整数、字符串有长度界限，控制字符转义，禁止拼 shell/HTML。

在 evaluator 为此 kind 加专用规则：只有 sources/ownership/events 完整时，首次及持续有效 queued 返回 WAITING，优先于 recent-progress ACTIVE；其他 wait 种类顺序不改。来源不完整先 UNKNOWN，不能借 queued 覆盖依赖故障。队位/heartbeat不更新 last_change；出队造成一次状态转换并从新 baseline 开始观察，running 不能得到 queue 豁免。

sample 和 --recheck 调同一 reader；旧 STALLED 候选 recheck 发现 valid queued 返回 waiting-confirmed。snapshot PANE_EVIDENCE 追加已校验的 queue_request/position/wait_seconds，不 early return：PANE_DEAD、LIMIT_LIVE、INTERACTIVE_MENU、CAPTURE_FAILED、HASH_UNAVAILABLE 原样保留。有效 queued 仅禁止 STALLED_60M 及基于该候选的 nudge。

同步 collector/continuity/cli/report schema 测试、shell snapshot、runbook；检查 legacy-token-savings/runner-patrol-rules.md 真实激活消费者并按现有生成关系同步。scripts helper加入 package-onboard.sh / allowlist / smoke，若被 patrol直接执行则加 PATROL_HELPER_SOURCES pin。正常 updater 部署编译 dist；源码通过不是已部署 STEP 2 生效。本设计不重启服务。

## 6. TDD 实施分块与命令
每块先落失败测试，记录 expected failure，再最小实现、测试绿、独立提交；不在本设计节点执行。

### A — 队列协议与多进程原子性
文件：scripts/package-gate-host.py；scripts/__tests__/package-gate-host.test.mjs。
- [ ] 建临时 fake root 和两个不同 worktree，启动 N+1 个真实 OS helper，执行日志记录真实启动事件；首批用管道 latch 保持占位。
- [ ] 先断言 `maxActive<=N`、`N+1.spawnCount===0`、seq FIFO、重复时间戳不改顺序；当前无 helper 应失败。
- [ ] 实现 schema、短事务、唯一 root、status/投影、严格 config；加事务忙、两进程同时初始化、损坏DB、软链接、投影失败不授权、不同 HOME/CODEX_HOME 的同 UID 测试。
- [ ] 运行 `node --test scripts/__tests__/package-gate-host.test.mjs`，要求所有并发断言通过；提交 queue core。

### B — 监督/屏障/集成
文件：scripts/package-gate.mjs；scripts/lib/package-gate-core.mjs；scripts/package-gate-worker.mjs；现有 package-gate.test.mjs及新增 host tests。
- [ ] fake pnpm 在 build 或 test 阶段 latch；断言排队时没有 build，retry仍占同 request；启动屏障每个切点杀 supervisor，检查 GO 前零执行、GO 后残余组仍计容量。
- [ ] 迁移所有现有runGate假pnpm测试到显式隔离queueRoot，断言真实主机根从未写入；不能让本地单测进入真实队列。
- [ ] 实现公开runGate wrapper与控制fd结果、取消、组清空后release；新增 spawn failure、build fail、assertion fail、RPC retry artifact、SIGINT/TERM/KILL、lock inode变化、PGID复用保守hold、组残留负向。
- [ ] 运行 `node --test scripts/__tests__/package-gate.test.mjs scripts/__tests__/package-gate-host.test.mjs`；保留现有真实 Vitest reporter测试。
- [ ] CI=true及GITHUB_ACTIONS=true均断言 Python/DB从未调用，结果逐字段兼容；回退env=0不入队且stderr明确bypass。提交 gate integration。

### C — 巡检消费
文件：packages/teamlead/src/package-gate-queue.ts，patrol-continuity-collector.ts / patrol-continuity.ts / patrol-continuity-cli.ts / patrol-report.ts；对应 __tests__；scripts/lead-patrol-snapshot.sh及测试。
- [ ] 先失败场景：真实 queued >3600s不得STALLED；首次就WAITING；queue+menu/dead/quota仍FINDING；STALLED候选recheck已queued不得nudge。
- [ ] 实现 §5；测试错exec/activation/attempt/TURN、旧generation/锁替换、死owner、陈旧heartbeat、损坏账本、anonymous、HOME被scratch替换、前后出队竞态、队位变化不刷进展。
- [ ] `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/patrol-continuity*.test.ts src/__tests__/patrol-report.test.ts src/__tests__/package-gate-queue.test.ts`（实施先核对 package name）；`bash scripts/__tests__/lead-patrol-snapshot.test.sh`。
- [ ] 更新runbook/打包闭包；运行 package-onboard相关 smoke；提交巡检集成。

### D — QA与校准工具
文件：scripts/qa-package-gate-host.mjs；本目录 evidence/acceptance-manifest.json、baseline.csv、after-n2.csv、after-n3.csv、ps-before.jsonl、ps-after.jsonl、qa-report.md。
- [ ] harness参数固定工作负载manifest、N和输出目录，拒绝缺6份、漂移head/hash、已有不明gate；fixture模拟验证 makespan计算和超阈值必FAIL。
- [ ] 执行下一节所有实验并记录原始receipt/exit；满足后设置校准N，失败不得写通过。提交实证与选择理由。

## 7. 验收协议（不缩小 issue 要求）
### 固定分母
冻结六个独立 worktree 的 head、dirty diff hash（应为空）、lockfile、Node/pnpm、测试清单、机器核数和后台负载；每份 workload 都包括 build + packages + retry 策略。主机无其他 gate 时，各自单独跑得到 service time b1..b6；每份至少2次同缓存策略测量取中位数。依 seq 顺序分配到最早空闲的 N 个虚拟槽：`finish[minSlot] += bi`，理论 T_N=max(finish)。相同bi时为 ceil(6/N)*b。分母在 after 前冻结，不能用拥塞后的 after 时长重新算。

### 六体 after
新增硬前置：两个不同的真实Codex workspace-write/approval=never Runner沙箱，各起一个gate；对其中一个调用方组SIGKILL，另一沙箱必须自动回收，且单杀supervisor触发watchdog收尾，不需要ps/bootId。加真实同组清理负向、失效lock、跨沙箱EPERM→ESRCH、HOME解析与DB写权限验证。未通过不能开启全机限流。

N=2、N=3 各一次独立空闲窗口，六个入口同一屏障释放（记录全部提交时差），分别模拟对应 T_N；C_N=lastFinished-firstAdmitted，必须 C_N≤1.2*T_N。另报告首提交到末完成总wall，不能藏初始等待。结果表每行 request/worktree/head/seq/queuedAt/admittedAt/finishedAt/wait/service/total/exit/RPC次数/receipt。任一真实失败或 RPC artifact=2 不算吞吐通过；无 RPC-only失败的干净六次才能宣称“无RPC超时假红”，保留 FLY-2467 注入回归证明真实断言不会变绿。

通过的 N 中选总耗时较低且无host异常的一项；差异≤5%选2降低争用。两者均不过则报告FAIL和瓶颈，不放宽×1.2、不改分母、不声称优化成功。上线前N仍标未校准。

### 阴性与恢复
使用假任务保持 N 槽，N+1 位应在 pane与账本可见且 build/test spawn=0；释放一个前任，观测实际后继 build/worker spawn 时间差≤5s，至少10轮含不同worktree及同毫秒入队。真实全量six-run同时核对每次正常接替≤5s。取消队首后下一位进，随机 kill CLI/supervisor/worker、保留测试孙进程均不超发，组清空后自动回收。identity观察失败不能抢槽；恢复后不得永久占位。

### before/after证据及实际部署
设计保存的 Lead 历史before是上下文，不替代原始ps。QA在批准的低干扰窗口采集当前未限流before（若已有原始现场可用则引用并保留采样时间），不得为造基线在繁忙主机另起8个gate。每5s采样 timestamp,pid,ppid,pgid,birth,etime,cpu,state,command 仅白名单 gate/Vitest 进程，勿采全环境或凭据；连同uptime/load、每个gate receipt、wall表及采样失败写manifest。若没有可比原始before，标验收证据不全并补采，不能用叙述替代。

生产STEP2验收须在正常部署后，用实际 installed launcher 观察一名排队体>60min或用真实采样+可控时间的非生产闭包测试补充；完整原始PANE_EVIDENCE、collector证据、recheck结果入档。模拟时间只能证明判断算法，至少一次真实排队的 deployed STEP2输出必须取得。未部署只能写local integration pass。

## 8. 迁移与回退
发布顺序固定：代码合入时control缺省disabled；正常updater先部署collector和helper，真实installed STEP2可读取fixture/匿名队列但不错误豁免的检查通过；更新活跃worktree覆盖后，QA用隔离root验证，再主机config --enable。不能合并即自动限流而巡检尚未部署。

新版本可与旧CLI共存，但旧入口不会自动排队，故不能宣称混合版本期全机N受控。实施/QA盘点所有活跃worktree gate脚本hash；旧任务让其正常结束，新任务更新到含限流入口版本再入场；不得杀他体任务或偷偷改其工作树。若旧入口仍在运行/待交卷，报告coverage incomplete并由Lead协调 rollout，验收不通过。

v1存在未知schema时拒绝启动，不另造v2空域并行；未来升级须全域排空后迁移。回退=正常先停止新入队、排空、config --disable；单次env=0仍保留。紧急host disable解开queued，不杀occupied，不删DB，明确放弃N保证。不能删除DB/锁文件“修复”活槽。CI无需迁移。合并与部署分开，独立updater按窗口部署；设计不申请ship。

## 9. 设计交付审计
- [ ] exploration/research/plan前缀元数据及progress齐全，commit并push。
- [ ] 显式review gate + request-review，持有有效APPROVED；所有非阻塞建议列Follow-ups并report Lead。
- [ ] diagram-first中文HTML，每卡评论本地保存、汇总标记和分块复制，单nonced script、无外链资源；Mermaid本地SVG或按规则记录两次失败。
- [ ] committed HTML publish-only，验 hosted200/CSP/nonce/内容，report DESIGN-HTML URL。
- [ ] exact complete --route phase_design_complete 后 park；保留resident goal，交由controller推进。

## 10. Round 1 disposition与Follow-ups
HIGH sandbox-process-identity-infeasible：已修订§2–5/§7，正常gate与reaper不再执行ps或boot sysctl，以owner flock+空组ESRCH+同沙箱watchdog收尾；附当前沙箱原语证据，真实双Runner验收为启用硬门槛。

同轮advisories：no-host-level-kill-switch、merge-activates-queue-before-patrol-deploy、normal-completion-residual-group-unspecified、orphan-run-no-lifeline、identity-tuple-source-and-duplication、stale-queued-head-blocks-fifo、existing-rungate-tests-hit-real-queue、wait-priority-order-underspecified全部已在相应章节收敛，不另扩需求。Follow-up保留极端多重监督进程死亡+残留组和重启PGID长驻复用的hold诊断；这些不授予不安全自动清理，也不改变普通崩溃必须自动恢复的验收。
