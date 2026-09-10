# FLY-2460 准入蒸馏通道 — 调研
Issue: FLY-2460 (https://linear.app/geoforge3d/issue/FLY-2460/2355b3-codex-自蒸馏从不触发runner-家里模型拿不到原生-memory-工具memory-stage1-后台任务从不跑)
日期: 2026-09-09
基于: exploration.md

## 1. 调研目标

exploration.md 已把根因钉在 Codex 源码与我们的家布局上,并用 scratchpad 实验证明「同一家再起一次根会话 + 覆盖阈值」95 秒出真记忆。本文回答实施层的问题:通道挂在 runner 生命周期的哪一点、用哪条现成接缝、怎么等它结束、怎么留下可核对的回执、怎么在 529 房证明。

## 2. Codex 侧可依赖的合同(0.153.2,file:line 见 exploration §2)

| 合同 | 出处 | 对通道的含义 |
|---|---|---|
| 管线只由 app-server `turn/start`(有输入、已开始)触发 | `turn_processor.rs:657-669` | 通道必须真的起一个线程并送一条 turn;不能只 `thread/start` |
| `thread/start.config` 是 dotted-path 覆盖,与 `-c` 同一条合并路径 | `config_manager.rs:186-230` → `config/src/overrides.rs:18-22` | `memories.*` 可按线程覆盖,不用改家里 config.toml |
| `ephemeral` 线程跳过管线 | `start.rs:33` | 触发线程不能 ephemeral |
| `memories.generate_memories=false` ⇒ 该线程 `memory_mode='disabled'` | `config/src/types.rs:297`,claim SQL 过滤 `memory_mode='enabled'` | 触发线程自己永不成为候选,不污染记忆 |
| 候选 = 别的线程、`cli/vscode/atlas/chatgpt` 来源、`archived=0`、`preview<>''`、`updated_at ∈ [now−age, now−idle]`、每次最多 `max_rollouts_per_startup` | `phase1.rs:160-174`、claim SQL | 上一次执行的线程(结束 ≥1h)合格;本次刚结束的线程不合格 |
| `min_rollout_idle_hours` 钳在 `[1,48]`,`max_rollouts_per_startup` 钳在 `[1,128]`(stage1 并发上限 8 在 `memories/write/src/lib.rs:81`) | `config/src/types.rs:56-57, 384-394` | 通道不可能让「刚结束」的线程当场蒸馏;只能在下一次根会话蒸馏上一次 |
| 已成功水位 ≥ `updated_at` 的线程不再 claim | `state memories.rs try_claim_stage1_job` | 通道幂等:重复触发不重复蒸馏 |
| stage1 输出持久落 `memories_1.sqlite.stage1_outputs`;文件由 phase2 写 | `phase1.rs result::success`、`phase2.rs:219` | (a) 的第一层证据在 DB,不必等 phase2 |
| phase2 成功后 6h 冷却(常量)、running lease 1h | `state memories.rs:21, 1152-1163` | 通道不能强制 phase2;要写清「文件可能下一次才出现」 |
| 限额守卫默认要求剩余 ≥25%,`rate_limit_reached` 直接跳 | `guard.rs:38-58` | 不覆盖;回执要能区分「守卫跳过」与「无候选」 |
| 管线是 daemon 进程内 tokio 任务 | `start.rs:54` | daemon 活多久,管线就能跑多久;`runtime.stop()` 会打断 phase2(生产实证) |
| Codex 不把跳过原因写日志,只记 metrics | `phase1.rs:84`、`start.rs:69-73` | 唯一可核对的是 DB 前后差 + `memories/` 文件 |

## 3. 我们这边的接缝

### 3.1 生命周期插入点(`packages/claude-runner/src/CodexTmuxAdapter.ts`)

```
execute()
  runtime = runtimeFactory(opts)              // CodexDaemonGoalRuntime
  goalPromise = runtime.runGoal(...)          // :1555
  ├─ phaseLifecycle: race(goal, waitForShutdown)   // :1626-1653
  │    shutdown 先到 → controlledShutdownRequestId, runtime.stop()   ← 通道必须跳过
  │    goal 先到     → outcome = first.outcome                        ← ★ 通道插在这里
  └─ 无 phaseLifecycle: outcome = await goalPromise                   ← ★ 同上
  finally                                    // :1659
    cancel window/reopen → stopIntake → runtime.stop() → drained() → closeTranscript
    → CommDB closeout → retireExecutionCredential (:817-839)
```

`runGoal` 在 goal 终态时**返回但不拆 session**(`codex-daemon-goal-runtime.ts:597`),v1 曾把通道放在 ★;R1 评审指出 Codex 的 1h 闲置下限让「收尾蒸馏本次线程」不可能,且 `caughtError` 在 try 内不可见、晚到的受控关停会被拖住。**v2 改为准入侧**:`runGoal` 首次 `startSession` 之后、`ensureThread`(建 runner 线程,:521)之前——daemon 已起、goal 循环的事件监听还没安装、runner 还没开始写 rollout;`stop()` 到来时用 AbortSignal 中止。

### 3.2 Goal runtime(`codex-daemon-goal-runtime.ts`)

- `session: DaemonSession | null`(:231)私有,含 `client`、`codexHome`、`exited`;`runGoal` 不可重入(`running` 标志,:478)。
- v2 不加公开借用方法,而是在 `RunGoalInput` 上加可选钩子 `beforeFirstThread({client, codexHome, signal})`,由 `runGoal` 在首次会话建立后调用(`restarts===0 && !resumeThreadId`);`CodexDaemonGoalRuntimeLike` 接口不变,现有假 runtime 不受影响。

### 3.3 Daemon client(`codex-daemon-client.ts`)

- `startThread(input)`(:455-473)只透传 `cwd/sandbox/approvalPolicy/model/baseInstructions`,需要加 `config?: Record<string, string | number | boolean>` 直接放进 `thread/start` params(键名 `config`,app-server v2 `ThreadStartParams.config`)。
- `startTurn(threadId, text)`(:565-586)已存在,返回 turn id;v2 通道通过 `setEvents({onNotification})`(:273)在 goal 循环安装监听之前临时接管事件槽,捕获触发线程的 `turn/completed`,之后清空。
- 请求超时统一走 `reqTimeoutMs`(:355-367),`startThread` 需要加 `timeoutMs` 透传,让通道按剩余预算限制 RPC。

### 3.4 读 `memories_1.sqlite`

- claude-runner 目前无 sqlite 依赖;`flywheel-comm` 已用 `better-sqlite3`(`commdb-open-gate.ts:12`),根 `package.json:63` 已 pin。`memories_1.sqlite` 是 WAL 模式(有 `-wal/-shm`),`sql.js` 读主文件会漏掉 WAL 页,不能用;`node:sqlite`(Node 25 可用)仍是 experimental。**选 `better-sqlite3` 只读打开**(`readonly: true, fileMustExist: true`),用后立即 close。
- 需要的查询(参数化、只读):`state_5.sqlite` 的 `threads`(id, source, memory_mode, updated_at_ms, archived_at, rollout_path, tokens_used);`memories_1.sqlite` 的 `jobs`(kind, job_key, status, worker_id, lease_until, last_success_watermark, last_error)与 `SELECT COUNT(*) FROM stage1_outputs`。
- 文件不存在(家从未跑过管线)视为空集,不是错误;打开/查询失败是 `skipped:db_unreadable`。

### 3.5 Keyed 家租约(`codex-home.ts`)

- `listCodexAgentHomeLeases(home)`(:536)是模块私有,admit 只在 60s stale 的 mkdir 锁内列一次 lease(:572-640),锁不能长持。v1 想用「唯一 lease」当并发授权,R1 #2 指出是 check-then-admit TOCTOU。**v2 不用 lease 计数**:安全边界来自 Codex 自己的 1h 闲置下限(活线程 `updated_at` 是最近几秒,不可能被 claim)+ 水位重蒸馏(闲置 >1h 的卡 gate 线程被蒸馏一次,恢复后再蒸馏)。通道不读 lease 目录、不做 per-candidate 存活标注(v2 曾设 `liveLease`,R2 #6 后删除:`threads.id` 与 lease 文件名 executionId 没有本地映射)。

### 3.6 回执落点

- 日志:adapter 的 `this.log` 已进 runner 日志;transcript sink 的 `appendMeta`(`CodexTranscriptSinkLike`)可加一行 meta。
- 持久:`<home>/.flywheel-memory-distill/<executionId>.json`(隐藏目录,FLY-2359 白名单不复制隐藏路径,不会被当记忆运走)。只写身份、计数、状态、耗时、原因,不写记忆正文。

## 4. 529 房取证手段

- 房内起真实 Codex runner:`scripts/test-deploy.sh <slot> --generalized --codex-runner --no-lead --expect-head <sha>`(FLY-2359 qa-runbook §2);exact-head 闸不覆盖 claude-runner dist,QA 需自己 build 并核对 dist 字节(runner memory: 529 exact-head gate)。
- DB 取证:`sqlite3 <home>/memories_1.sqlite 'select kind,job_key,status,worker_id,last_error from jobs'`、`select thread_id,length(raw_memory),rollout_slug from stage1_outputs`。
- 读路径取证:`CODEX_HOME=<home> codex debug prompt-input ...` 固定 ephemeral(`cli/src/main.rs:2231`),零副作用;在其导出的 developer 段里找 `memories.instructions` 片段中该任务的 slug/关键词。
- 6h 冷却:两段式证据——T2 准入通道后 DB 有 T1 线程 stage1 done 且 raw 非空、非模板(第一层,`stage1_done`);phase2 在通道内 claimed+done 时(该家上次 phase2 成功 >6h 前)`memory_summary.md` 更新、T2 首轮可读(第二层,`readable_ready`),否则在 ≥6h 后的 T3 上验证。QA 路书按此排程。

## 5. 风险与已知边界

| 风险 | 处理 |
|---|---|
| 守卫按 founder 账号剩余额度跳过(<25%) | 不改阈值;候选由我们自己算,所以「有候选却 45s 内没有本 worker 的 job 行」= `skipped:no_claim_observed_within_45s`(守卫或 Codex 自身过滤;只是 45s 内未观察到);QA 在房里先看账号用量 |
| 通道多一次模型往返(触发 turn) | 输入固定极短;不给工具;可接受 |
| 并发共家:卡 gate >1h 的活线程被蒸馏「到目前为止」 | Codex 1h 下限已排除正在写的线程;这是 Codex 原生 provisional-memory 语义:恢复前其他任务可能短暂读到过时摘要,恢复后水位前进会再蒸馏;设计显式接受,不做 per-candidate 存活标注(threadId 与 executionId 无本地映射) |
| 通道超时 | 绝对截止 ≤5 分钟(stage1 ≈40s×claimed + phase2 ≈90s);到期只记 `skipped:timeout`,runner 线程照常建立;DB 里已 done 的 stage1 输出持久 |
| stage1 输入超模型窗口 | Codex 自己截到 70%(`prompts.rs:100-125`);主机 12.7MB rollout 成功;超大 rollout 失败进 `jobs.last_error`,回执带出 |
| `thread/start` 失败/daemon 已死 | 全部 fail-open:记原因,runner 线程照常建立 |
| eng_design 家至今零任务 | 通道回执第一次把「管线没进」变成可见;若 QA 在房里复现,原因(守卫/状态库)从回执与 `memories/` 是否出现即可判 |
