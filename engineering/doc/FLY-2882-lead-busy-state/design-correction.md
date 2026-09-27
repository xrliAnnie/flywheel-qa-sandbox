# FLY-2882 Lead 忙闲只读接口 — 设计修正
Issue: FLY-2882 (https://linear.app/geoforge3d/issue/FLY-2882/语音耳机bridge-某个-lead-现在在忙什么只读接口在不在一轮活里在做哪张单已经多久claudecodex-两种载体)
日期: 2026-09-25
基于: plan.md

**出处**:设计节点按 manifest 要求的 gpt-6-astra(xhigh)对 plan v3 的补审,thread `01a0da53-29b5-7422-b635-2e1ad75024e3`,结论 CHANGES REQUESTED(3 blocking + 2 advisory),Lead 已核实全部成立(lead-instruction `bf360de9-01c2-49ec-af5e-9c5894a35e0b`,原文 `/tmp/codex-rescue-design-feedback-flywheel-FLY-2882-plan-astra.md`)。本文件是 plan v3 的**修正层**:下面写到的地方以本文件为准,其余不变。之前三轮设计评审用的是 companion 默认模型 gpt-5.6-sol。

## C1(blocking #1)Codex tracker 改接原始事件接缝

**问题**:v3 §5.2 只包装 demux 的 `toExecutor` / `toObserver`。`TurnDemux` 在 `dispatchPending` 期间扣住未注册 turn 的全部事件,直到 `turn/start` 回包(RPC 默认最多 60 s)——这段时间轮已经开始,却会读成 idle;bootstrap 超时 / 溢出后被 tombstone 的轮,其真实完成事件被 demux 丢弃,busy 会一直卡住。

**修正**:
1. 生命周期**只在原始 proc `notification` 接缝观察**(`wireDemuxedProcess` 的 notification 监听里、`demux.route()` 之前),只读 `method / params.threadId / turn.id / turn.status / turn.startedAt`。完成事件只处理一次:只吃 `notification` 流里的 `turn/completed`,不再额外吃 `CodexLeadProcess` 同时发的 `turnCompleted`。
2. 新开的轮先记 `origin: "unknown"`;**demux 只负责补来源**:进 executor → `message`;进 observer 且来源可证(正常路由、或另一轮认领成功后的 flush)→ `founder_terminal`;abort / 溢出 flush、认领失败(poisoned claim)→ 保持 `unknown`,不能当作 founder 的证明。为此 `TurnDemux` 的 `toObserver` 增加第三个参数 `provenance: "foreign" | "unproven"`(加性,既有 sink 忽略即可)。
3. 忙闲只由原始生命周期决定,来源只影响 `turn.origin` 与 trigger 原因。

## C2(blocking #2)Claude 必须有子进程活体证据

**问题**:`probeV2LeadPane(…, "capture")` 只证明父进程 `bash … lead-body.sh` 还在。Claude 退出后,`claude-lead.sh` 还要回收 poller、写退出回执,到 `:3811` 才杀 tmux;这段时间旧的 done 行和输入框都还在屏上,纯解析会答 idle。v3「Claude 进程不在时画面里没有输入框」不成立。

**修正**:
1. `LeadWindowLocator.ts` 新增只读 `readV2LeadClaudePid(window, runner)`:`tmux list-panes`(`pane_pid`、`pane_dead`)+ `ps -A -o pid=,ppid=,ucomm=`。只认 pane 的 `lead-body.sh` bash 的**直接子进程**里、内核进程名为 `claude` 或 Claude 版本号(与 send 强度同一正则;生产实测为 `2.1.282`)的那**一个**;只取 pid/ppid/内核名,不读命令行参数。
2. 读取顺序:locate(原 capture 强度核验)→ **pid₁** → capture(原核验)→ **pid₂**;pid₁、pid₂ 都存在且相等才解析画面(证明整个截屏期间是同一个活着的 Claude)。
3. 新 unknown 原因:`lead_process_not_running`(查询成功但没有 Claude 子进程)、`lead_process_unverified`(查询失败、多于一个候选、或截屏前后 pid 不同)。
4. 删去 v3「不新增 exec 调用点」的说法:经既有注入 runner 接缝新增 `tmux list-panes` 与 `ps` 两类只读元数据查询(各两次);不新增同步 exec、spawn 或 kill。不使用 `send` 强度,不把 lead-body breadcrumb 当活体证据。

## C3(blocking #3)实时生命周期事件的校验

**问题**:v3 只校验 `startedAt` 数值;`turn/completed` 的名字本身就能把 busy 变 idle(状态 `inProgress` 或缺 status 的「完成」也照删),tracker 也没有 thread 准入。

**修正**(metadata-only validator,放在 tracker 里):
1. 绑定前(`bindThread` 之前)一律忽略;`params.threadId` 与绑定线程不同 → 忽略,不动状态、不动 revision。
2. 绑定线程上:`turn/started` 必须 `turn.id` 合法且 `turn.status === "inProgress"`,`startedAt` 缺省/为 null 时用本地收到时刻,出现但不合法(非正数、非有限、晚于本地时钟 5 s 以上)算畸形;`turn/completed` 必须 `turn.status ∈ {completed, interrupted, failed}`。缺 `threadId` 也算畸形(证明不了是本线程)。
3. 本线程出现畸形生命周期事件 → **作废信任**:`seeded=false`、清空 active、revision+1,接口答 unknown(`turn_state_not_seeded`,文案改为「还没拿到或刚作废了可信状态」),并通过 `onTrustLost` 重新走有界 seed(立即一次 + 2 s + 10 s)。之后任何合法的 start/完成事件也会自然恢复信任。
4. 重复完成幂等。正文/delta 一律不进 tracker。

## A1(advisory #4)截止时间与工厂用法

- `defaultLeadPaneCapture()` 是工厂:服务启动时建一次 `CaptureFn`,读时 `await capture(ref, 150)`(`-S -150` 含 scrollback,不作为精确总行数上限)。
- 单个 Lead 整条读取链统一 **8 s 截止**,超时答新 unknown 原因 `read_timed_out`(内部 tmux/ps 各自仍有 5 s 上限,迟到结果丢弃)。fleet 并发由 4 提到 **6**:17 个 Lead 最坏 ⌈17/6⌉×8 s = 24 s。CLI 超时:单个 15 s(> 8 s),`--all` 由 30 s 提到 **45 s**,在册 Lead 增到 30 个以内仍够。

## A2(advisory #5)分钟精度的误差

读 2.1.282 二进制里的 `en()`:`天/时/分 = Math.floor`,`秒 = Math.round`(59.5 s 进位)。≥1 天的格式 `1d 2h 3m` 不带秒,所以显示的分钟是**截断**,真实时长落在 `[显示值 − 0.5 s, 显示值 + 59.5 s)`。修正:带「天」且无秒位的时长按区间中点 **+30 s** 估算,`precision: "minute"`,开始时间误差 ≤ 30 s。其它不带秒位的形态(只在 `hideTrailingZeros` 且秒为 0 时出现,spinner 不用)不加修正。补了分钟边界的静态夹具。

## 对 FLY-2883 的稳定接口

- `parseClaudeLeadPaneActivity(pane, leadId)`:签名与返回形状不变。
- `readV2LeadClaudePid(window, runner?, timeoutMs?)`:新增导出。
- `LeadTurnStateTracker`:`constructor({binding, now?, generation?, onTrustLost?})`、`bindThread`、`observeLifecycle(method, params)`、`setOrigin(turnId, origin)`、`markDisconnected`、`needsSeed/beginSeed/applySeed`、`snapshot`;`seedTurnStateWithRetry`。v3 草稿里的 `onTurnStarted/onTurnCompleted` 由 `observeLifecycle` + `setOrigin` 取代。
