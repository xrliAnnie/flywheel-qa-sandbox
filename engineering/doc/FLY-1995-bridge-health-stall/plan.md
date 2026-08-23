# FLY-1995 Bridge 低负载准周期不可用 — 实施计划

Issue: FLY-1995 (https://linear.app/geoforge3d/issue/FLY-1995/容量bug症状-生产-bridge-低负载下准周期不可用623percent-墙钟-health-答不进-1s最大-26-29s进程-cpu)
日期: 2026-08-22
基于: research.md
版本: v1.5x.0(暂定,ship 取空号)
状态: design-review APPROVED(Codex R1 11 项全折 → agy 替补 R2 1 项折入 → agy R3 APPROVED;评审链与替补缘由见 reviews/design-review-r3-agy.md)

---

## 0. 一句话

给 Bridge 装「事件循环发作黑匣子」(检测 + 自动留存 CPU profile + rider 墙钟关联账,验收 1/3),把 46 个 orphan question 收进**既有的** FLY-1328 退休权威(验收 2),并交付 operator-gated 手术脚本拆掉 teamlead.db 里 263.8 万行风暴残留 —— **生产 apply 必须在拿到至少一份发作 profile 之后**(证据先于手术,验收 1 的因果链不许被自己毁掉)。

**实况佐证(2026-08-22 18:38)**:写本 plan 时 `flywheel-comm stage set` 连续两次报 aborted(CLI 2s ack 超时),事后查账两次写都落了 —— 症状正在干扰生产控制面的活案例。

## 1. 范围与不做

**做**:Fix A(归因仪表)/ Fix B(orphan 终态,走既有 authority)/ Fix C(手术脚本 + 写入方限频;生产 apply 有证据前置门)。

**不做**:
- 不改 FLY-1971 阈值(验收 4)。
- 不动 FLY-1986 压测方案,只交付其自变量(事件循环占用)的测量面。
- 不改 CompatStatement 全物化语义(FLY-663 契约)。
- 不做通用 session_events retention 治理(只动风暴残留精确账)。
- 不做 profile 文件下载端点(只列 basename;下载另行设计)。
- 不做 >60s 发作的进程内抓取(见 §2.4 已知盲区)。

## 2. Fix A — 事件循环归因仪表

### 2.1 新模块 `packages/teamlead/src/bridge/event-loop-attribution.ts`

单一 class `EventLoopAttribution`:

1. **检测器**:`perf_hooks.monitorEventLoopDelay({ resolution: 10 })` 常开;30s 窗口滚动读取并 reset。**单位纪律:histogram 值是纳秒,统一在模块边界换算 ms(`/1e6`)后再比较/暴露**;窗口记录 `{windowStartTs, windowEndTs, p50Ms, p99Ms, maxMs, elu}`(ELU 用 `performance.eventLoopUtilization()` 差分)。`maxMs ≥ EPISODE_THRESHOLD_MS (1000)` ⇒ episode。
2. **分窗采样 profiler**(`node:inspector` 进程内):生命周期严格为 `Session.connect()` → `Profiler.enable` → `Profiler.setSamplingInterval(10_000µs)`(在任何 start 之前)→ 循环 `Profiler.start` / 窗口边界 `Profiler.stop`。episode 窗持久化 `.cpuprofile`,安静窗丢弃。**协议允许的话先 start 下一窗、再序列化上一窗**,把未采样间隙压到最小;实测的 rollover gap 每窗记进 snapshot。初始化失败(inspector 不可用/enable 抛错)⇒ 模块进入 `degraded` 状态并在 snapshot 暴露,绝不抛穿启动。
3. **rider 墙钟关联账(明确不是占用归因)**:`recordSpan(name, startTs, endTs)` 公开 API;>500ms 才入账;内存环形 200 条。**语义诚实声明写进代码注释与 snapshot 字段名**:记录的是 async 全链墙钟(含无害 await 等待),多个 fire-and-forget rider 可同时"长"而不占循环 —— **栈归因的 authority 是 CPU profile,账本只做时间窗关联**(发作窗里谁在飞)。episode 记录并入窗口内 span + 写 JSONL(复用 FLY-1887 `appendRotatedLogSync` 轮转纪律,10MB/3 代)。
4. **快照**:`snapshot()` 返回最近 K 窗指标、episode 摘要、profile 文件 **basename** 清单(不含绝对路径)、degraded/error 状态、rollover gap 统计。**/health 消费的紧凑块走内存缓存,不做任何文件系统枚举、不抛错**。

### 2.2 持久化与留存(crash-safe)

- 目录:经仓库既有 state-directory seam 解析(`FLYWHEEL_HOME` 适用处生效)→ `<flywheelHome>/diagnostics/loop-profiles/`,目录 0700、文件 0600。
- 写入:temp 文件 + 原子 rename;文件名 `loop-profile-<windowStartIso>-max<ms>.cpuprofile`(严格自有前缀)。
- 留存:**启动时 inventory 仅匹配自有前缀的文件**,跨重启统一按 mtime 剪到 20 份;绝不 follow symlink、绝不删前缀外路径。部分写(crash 遗留 temp 文件)启动时清理,不会被误当证据。
- Bridge `close()` 显式 `stop()`:停窗口 timer、`Profiler.disable`、`session.disconnect()`(接进既有 shutdown 链)。

### 2.3 接线(touch)

- `plugin.ts`:启动实例化;`FLYWHEEL_LOOP_PROFILER=0` 时跳过 profiler(检测器/账本始终开);`/health` 加性块 `event_loop: {p99_ms, max_ms, episodes}`(首窗未满/禁用/degraded 三种形态都有稳定 shape,纯加性);新路由 `GET /api/diagnostics/event-loop`。
- **端点鉴权(fail-closed,不复用会静默放行的通用 middleware)**:既有 `tokenAuthMiddleware` 在 master token 未配置时故意 no-op —— 本路由不走它,显式实现:无 master token 配置 → 503;缺/错 bearer → 401;Gemini-scoped token → 403;master token → 200。四态全测。
- 计时账接线:枚举周期入口逐个包 `recordSpan` —— GatePoller tick 本体、`:695-772` 的全部 rider、per-question relay 循环段、`zombieGateHygienePass`、reconcile/quota/flag-scan/supersede/workflow materialization/landing/health 等 GatePoller 其余 pass、`HeartbeatService` 入口。实现节点以 `gate-poller.ts` 内 `void Promise.resolve().then` 与定名 pass 方法为清单蓝本,逐一登记(计划蓝本≠封闭清单,以实现时 grep 为准),防「选择性证据」。
- `packages/config/src/feature-flags/registry.ts`:按真实 `FeatureFlagSpec` 字段登记 `FLYWHEEL_LOOP_PROFILER`(category: `kill_switch`,source: env,scope: bridge_global,bool,default ON,读时机 `object_construction`,非 direct-toggle),同步 registry drift/truth 测试。

### 2.4 已知盲区(写进文档与验收话术)

**>60s 的同步阻塞抓不到**:30s 窗口边界回调跑在被阻塞的主线程上;阻塞若延续过 BridgeEventLoopGuard 60s 阈值,SIGKILL 先于 `Profiler.stop` 到达,**in-flight 窗口的 profile 随进程消失,上一窗也不含该次阻塞**。观测到的发作最大 26.3s < 60s,该级别可完整抓取;>60s 级别的发作会留下 guard 自杀记录(现有机制)而非 profile。若未来需要抓 >60s 级,升级为进程外采样器 —— 另立 issue,不在本单。

### 2.5 常量

`EPISODE_THRESHOLD_MS=1000` / `WINDOW_MS=30_000` / `PROFILE_KEEP=20` / `LONG_SPAN_MS=500` / `SAMPLING_INTERVAL_US=10_000`。全写死,不加第二个 flag。

## 3. Fix B — orphan question 终态(扩展 FLY-1328 authority,不另立门户)

### 3.1 架构裁定(R1 #1/#2 采纳)

`GatePoller.zombieGateHygienePass()`(60s 节奏)→ `runZombieGateHygiene()` 已是 question 退休的**唯一 authority**,其 `retireQuestionGuarded()`(`db.ts:1537`,UPDATE 打在 **`mailbox` 基表**上 —— `mailbox_message_projection` 是只读 VIEW,R1 抓掉了我伪 UPDATE VIEW 的错误)带全部 load-bearing 防线:exact (id, from_agent) 双守卫、`NOT EXISTS(response)` 并发响应赢、`relay_state != 'terminal_disposed'` 幂等。46 个 voice orphan 恰卡在它的第一道防线上:`zombie-gate-hygiene.ts:133-135` 非-UUID from_agent fail-closed。**本单不绕过、不复制该防线,而是给它新增一条显式的非-runner ask 收口 lane。**

### 3.2 新 lane:`retireSessionlessNonRunnerAsks`(zombie-gate-hygiene 内)

处在既有 hygiene pass 的迭代里,对每条 pending question:

- **只处理 `checkpoint == null` 的 ask**(gate/review-gate 一律维持既有 fail-closed,只做 GatePoller 侧日志降噪);
- **只处理非-UUID from_agent**(UUID = runner,走既有 lane,零改动);
- 三重存在性守卫全空才候选:StateStore `store.getSession()` null **且** CommDB `db.getSession()` null(镜像既有 lane 的 comm-registration 存活保护 —— 有 CommDB 注册的非-runner actor 视为活体,不碰)**且** question `created_at` 距今 > 24h;
- 满足 ⇒ `retireQuestionGuarded(qid, { expectedFromAgent, requireUnanswered: true, resolvedVia: "fly1995_sessionless_ask", retention: "ask_forensic" })`(1h forensic 窗保留行,不立即蒸发)+ StateStore 审计事件 `orphan_question_disposed`(payload: qid/fromAgent/lead/ageHours)+ 一行日志;
- 返回值 false(response 赢/已终态/行不见)⇒ 记日志不重试写(下轮 pass 自然重扫,幂等)。

### 3.3 GatePoller relay 循环:只做降噪缓存,不做任何 disposal 决策

内存 `orphanSeen: Map<qid, {firstSeenTick}>`(上限 500,LRU):首见打**一次** warn;此后每 20 ticks 才重查一次 getSession(session 出现 ⇒ 移出恢复 relay),其余 tick 直接 continue。**disposal 只发生在 §3.2 的 hygiene lane** —— 缓存只省 churn 和日志。qid 被 hygiene 退休后从 `getPendingQuestions` 消失,缓存条目随之自然失效(map 按存在性懒清理)。

**效果承诺(验收 2 可测形态)**:每 qid 日志终身 ≤3 行;现存 42+ 条 voice ask 部署 +24h 内全部终态;`grep -c "orphan question" /tmp/flywheel-bridge.log` 增速归零。

## 4. Fix C — 残留收口

### 4.1 手术脚本 `scripts/fly-1995-session-events-residue-surgery.mjs`

- **精确 cohort 谓词(唯一、半开区间,R1 #7)**:
  `event_type = 'issue_thread_infra_notify_skipped' AND source = 'bridge.founder-thread-notifier' AND ts >= '2026-08-01 22:00:00' AND ts < '2026-08-05 04:00:00'`。dry-run 输出该谓词计数 + 按 execution_id/project 分解 + min/max (id, ts) 身份证据。执行时点重查为准,数字与既往报告不一致 → 打印差异,不 fail(账目以现场为准);**谓词本身是唯一 authority**。
- **dry-run 物理只读**:快照必须用 **`VACUUM INTO`**(或 better-sqlite3 backup API)产出——OS 级 `cp` 拷活库的 main/WAL/SHM 三件套会撕裂(SQLite 并发异步写,三件套彼此不同步 ⇒ 快照可能损坏、基线计数错;agy R2 #1)。`VACUUM INTO` 是在线读一致快照,产物是无 sidecar 的单文件;对该快照查询(live 库上连只读查询都会动 -shm read marks,直接查不构成物理只读证明)。产出**基线收据 JSON**(源库 realpath + 快照文件哈希/字节数、schema version、谓词全文、计数、脚本 SHA-256、时间戳)。
- **`--apply` 握手**:必须携带 `--baseline <receipt.json>`;`fileMustExist` 打开(typo 路径绝不建库);preflight 磁盘空间 ≥ backup 1.8GB + 最坏 WAL 估算;`BEGIN IMMEDIATE`;事务内重查 cohort 计数并与收据比对(不等 → rollback fail-close);backup(`VACUUM INTO`)后 `PRAGMA quick_check` + cohort 计数复核 backup 可用性;DELETE;commit 前 `PRAGMA foreign_key_check`(空)+ 事务内计数归零复核;commit 后 `PRAGMA wal_checkpoint(TRUNCATE)`;写不可变 applied 收据。**不 VACUUM**(文件瘦身留班车窗 operator 决定)。
- **`already_applied` 收窄**:只有存在**绑定同库身份 + 同谓词**的先前 applied 收据时,cohort=0 才是 already_applied;否则 cohort=0 = `target_missing` fail-close(防错库/空库假绿)。
- **better-sqlite3 解析**:经 package 自有 maintenance seam(锚定 `createRequire` 到 teamlead package,或 StateStore 暴露的维护入口),不赌 root hoisting。
- **执行窗口纪律**:Bridge 停机窗(00:00/12:00 班车);apply 权 Tadashi/Founder;实现 runner 只交脚本 + dry-run 收据。

### 4.2 生产 apply 的证据前置门(R1 #9,时序红线)

**顺序固定**:① Fix A/B(+ §4.3 限频)合入并班车部署 → ② profiler 健康与开销核验 → ③ **拿到 ≥1 份生产发作 profile(或对忠实库克隆复现)并归档基线指标** → ④ operator 才许跑 `--apply` → ⑤ 手术后同一测量面对照。理由:残留是当前最强候选烧核面,先动刀可能让发作消失而验收 1 永远补不上,before/after 因果链也断。手术**脚本交付**不受此门限制(dry-run 随 PR 交),被门住的只是生产 apply。

### 4.3 写入方限频(`founder-thread-notifier.ts` auditInfra)

- **只压 `issue_thread_infra_notify_skipped`**;`notified`/`failed` 审计字节不变。
- key = `(projectName, executionId, issueId, kind, reason)`;同 key 10 分钟窗最多 1 行;Map 带 LRU+TTL 上界(1000 条 / 30 分钟)。
- `suppressed_count` 语义定为**尽力采样**(写进字段注释):进程重启/无后续事件会丢窗内累计 —— 不承诺守恒(R1 #10 裁定;精确守恒需要 flush 机制,为一个已停止的风暴类型不值得)。
- 实现前重跑零读方 grep(含 dynamic event-query API 面),留档进 PR。

## 5. TDD 计划

| Fix | RED → GREEN |
|-----|-------------|
| A: 窗口判定 | 纯函数 + **ns→ms 换算边界**(999.x ms 不判 / 1000ms 判);跨窗发作(两窗各判各的) |
| A: profiler 生命周期 | 真 inspector:enable 缺失即 start 失败(证明顺序约束)、init 失败进 degraded 不抛穿、close() 全链断连 |
| A: 真同步阻塞集成 | vitest 内起模块,busy-loop + `Atomics.wait` 各 1.5s ⇒ episode + `.cpuprofile` 落盘且含烧核函数名(Node 22 CI 跑;Node 25 生产形态在 QA 环境重复) |
| A: 留存 crash-safe | fixture 目录:跨"重启"(重实例化)剪到 20 份;temp 残留清理;非自有前缀文件零触碰;symlink 不 follow |
| A: /health 兼容 | reverse-compat sentinel:既有字段逐字不变;首窗/禁用/degraded 三形态 shape 稳定 |
| A: 端点鉴权 | 四态:无 token 配置 503 / 缺 bearer 401 / Gemini token 403 / master 200;响应只含 basename |
| B: hygiene 新 lane | 真 CommDB fixture 全矩阵:voice orphan 24h 退休(resolved_via + forensic 保留)/ 23h 不动 / CommDB 有注册不动 / StateStore 有 session 不动 / UUID sender 走原 lane 字节不变 / gate+review-gate 不动 / response 并发赢 / 幂等重放 |
| B: relay 降噪 | mock store 计数断言:首见 1 查询 1 日志;19 ticks 零查询;第 20 tick 重查;session 恢复 ⇒ relay;map 上限 LRU |
| C: 手术脚本 | 真 WAL fixture(含 -wal/-shm):dry-run 快照查询 + 源三件套字节不变;apply 精确行数 + 他类型零触碰 + backup quick_check;错库 target_missing;typo 路径不建库;无收据 apply 拒绝;重放 already_applied 仅在收据绑定成立时 |
| C: 限频 | 同 key 10min 1 行;异 key 独立;LRU/TTL 逐出;skipped 之外类型字节不变 |

全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新增脚本测试。**开销硬门**:flag ON/OFF 各 ≥10 分钟 /health 延迟分布对照 + 每窗 rollover gap 实测,数字进 QA 证据。

## 6. 验收映射与部署

| Issue 验收 | 交付 | 闭环时点 |
|-----------|------|---------|
| 1. 发作可归因 | Fix A | 部署后观察项(62% 占空比 ⇒ 预期数小时内留存首份发作 profile);归因报告回 FLY-1995 抄 FLY-1986,由独立 QA/ops 出,不由实现 runner 自证;**§4.2 把它顶在手术 apply 之前** |
| 2. orphan 有界 | Fix B | 部署 +24h:42+ 条终态、日志增速归零 |
| 3. FLY-1986 测量面 | /api/diagnostics/event-loop + ELU | 合入即闭环 |
| 4. FLY-1971 hold | 无代码;依赖声明 | 本单结论前 FLY-1971 不按 load 锚点定数 |

部署:纯 Bridge 侧 ⇒ 班车窗生效(FLY-1959);Fix C apply 是独立 operator 步骤且被 §4.2 证据门顶住。QA 注意:529 房跑的是脚本所在仓库的 Bridge(记忆有案),验 A/B 须核对被测 buildSha;Node 25 生产形态的 inspector/开销复测在 QA 环境做。

## 7. 风险

采样开销(QA 硬门实测)/ stop-serialize 反身阻塞(rollover gap 每窗自测)/ >60s 发作盲区(§2.4 已声明,观测级 26.3s 可覆盖)/ orphan 误杀(走既有 guarded 原语 + 三重存在性守卫 + forensic 保留窗,UPDATE 可逆)/ 手术错库假绿(收据绑定 + target_missing fail-close)/ H1 不成立(仪表价值独立成立,§4.2 时序保证证据先行)。
