# FLY-1995 Bridge 低负载准周期不可用 — 调研

Issue: FLY-1995 (https://linear.app/geoforge3d/issue/FLY-1995/容量bug症状-生产-bridge-低负载下准周期不可用623percent-墙钟-health-答不进-1s最大-26-29s进程-cpu)
日期: 2026-08-22
基于: exploration.md

生产 Node 版本:v25.6.1(inspector / perf_hooks API 全部可用)。

---

## 1. 支柱 A:归因仪表选型

### 1.1 检测器 — `perf_hooks.monitorEventLoopDelay`

- 语义:基于 libuv 定时器测「预期唤醒 vs 实际唤醒」的差,histogram 累积。**同步阻塞期间主线程什么都跑不了**,阻塞结束后会记录一个巨大样本 —— 所以它是**事后**检测器(post-hoc),不能在阻塞进行中报警。这对本单足够:发作判定只用来决定「刚结束的窗口是否值得保留 profile」。
- 开销:纳秒级 timer 记账,可忽略;`resolution` 取默认 10ms。
- 发作判定阈值:窗口内 `max delay ≥ 1s` —— 与 issue 的「/health 答不进 1s」判据字面对齐。

### 1.2 抓栈 — 候选对比

| 方案 | 能否抓同步阻塞的栈 | 生产驻留适配 | 结论 |
|------|--------------------|--------------|------|
| (a) 进程内 `node:inspector` Session + `Profiler.start/stop` 连续分窗采样 | **能** —— V8 sampling profiler 用独立采样线程中断 isolate,主线程被同步活占满时照样采到栈 | start/stop 由自己控制;`Profiler.setSamplingInterval` 可调粗(如 5–10ms)压开销;profile 落盘只在窗口边界(主线程解阻塞后) | **选它(主路)** |
| (b) `node --cpu-prof` 启动参数 | 能 | **只在进程干净退出时写文件** —— 常驻 daemon + KeepAlive kill 场景基本拿不到文件 | 否 |
| (c) 外部 attach(SIGUSR1 → inspector 端口 → DevTools/脚本) | 能 | 要人守着现场;开监听端口有安全面;发作 62% 占空比虽高但人工蹲守不满足「自动抓到」 | 备用 runbook,不做主路 |
| (d) macOS `sample` / `spindump` | 已实测 **不能**(JIT 帧 call graph 为空,issue 原文) | — | 已排除 |

**方案 (a) 的关键机制**:连续跑固定长度(30s)的采样窗口,窗口结束时看 1.1 检测器在该窗口的 `max delay`:≥1s 则把 `.cpuprofile` 持久化到 `~/.flywheel/diagnostics/loop-profiles/`,否则丢弃。窗口 30s < BridgeEventLoopGuard 自杀阈值 60s ⇒ 即使发作后紧跟 guard 自杀,上一窗的 profile 已经落盘(profile 数据在采样线程侧累积,stop+serialize 在解阻塞后的窗口边界执行)。留存上限:环形保留最近 N=20 份(单份 30s@10ms ≈ 3k 样本,几百 KB 量级),磁盘占用有界。

### 1.3 确定性补充 — rider 计时账(long-task ledger)

Profiler 可能受 JIT/内联影响可读性(issue 已领教过一次)。加一层**确定性**归因:GatePoller tick、每个 20-tick rider、HeartbeatService pass 等已知周期入口用 `performance.now()` 包一层,耗时 > 500ms 记入内存环形账(名字 + 时长 + ts,容量 ~200 条)。发作窗口保留 profile 时,同时把窗口内的 long-task 条目写进 episode 记录。两层互为备份:profile 给「栈上是谁」,ledger 给「哪个入口跑了多久」——就算 profile 不可读,ledger 也能把范围收到具体 rider。

包装位置在 GatePoller 的 rider 调度处(`gate-poller.ts:695-772` 的 `void Promise.resolve().then(...)` 已是统一形态)与 HeartbeatService 入口,不逐个改 rider 内部 —— 但要注意这些 rider 是 async fire-and-forget:计时要包整个 promise 链(await 到 catch 之后),测的是「该 rider 本轮占用的总墙钟」,同步阻塞段会以「单次 await 间隔超长」的形式反映在 profile 里,ledger 负责点名。

### 1.4 指标暴露 — FLY-1986 测量面(验收 3)

- FLY-1986 的第一问是「load average 够不够格当准入闸门判据」,备选自变量是**事件循环占用** —— 对应指标:`performance.eventLoopUtilization()`(ELU,主线程内采样,每窗口记录)+ delay histogram(p50/p99/max)。
- 暴露面:新只读端点 `GET /api/diagnostics/event-loop`,返回:当前窗口与最近 K 个窗口的 {p50, p99, max, elu, episode?}、episode 总数、最近 episode 时间、long-task 环形账摘要、留存 profile 文件清单。鉴权跟随现有 `/api/*` token 约定(不裸跑,FLY-203 先例)。
- `/health` 加一个**加性**紧凑块 `event_loop: {p99_ms, max_ms, episodes}`(additive JSON,不动既有字段 —— wrapper preflight 与 FLY-1986 探针都只读既有 key,字节兼容)。

## 2. 支柱 B:orphan question 终态选型

| 方案 | 评估 | 结论 |
|------|------|------|
| (1) 给 `getPendingQuestions` 恢复 `expires_at` 过滤 | 动共享查询,影响所有消费者(Lead pending 列表、patrol);FLY-161「runner_question 必须活过 session completion」的语义靠的就是不按 TTL 剪 —— 恢复过滤等于后门重开 TTL 剪除 | 否 |
| (2) 复用 `resolveGate(qid, 0)` | 该原语第一行就拒 runner_question(FLY-307 Codex R1 #6 防线,FLY-161 边界),而 42/46 个 orphan 恰是 runner_question | 否 |
| (3) 新窄 API:`disposeOrphanQuestion(qid, reason)` → `relay_state='terminal_disposed'` | `terminal_disposed` 是 FLY-1645 后的既有出生终态,getPendingQuestions 谓词天然排除它;单条 UPDATE、可审计、不动共享查询 | **选它** |

**触发条件(三重守卫,全部满足才 dispose)**:
1. `store.getSession(from_agent)` 为 null(GatePoller 已在做的判断,orphan 定义本身);
2. question 年龄 > grace window(**24h**)—— 挡住「question 先于 session 注册」的理论竞态,也给任何"迟到注册"的 agent 留够余量;现存 42 条最老已数天,全部会被收口;
3. 每次 dispose 前**当场重查** getSession(不是用缓存判的 orphan 才能 dispose)。

**dispose 动作**:CommDB UPDATE(单条、`relay_state != 'terminal_disposed'` 条件保证幂等)+ StateStore 审计事件 `orphan_question_disposed`(payload: qid/from_agent/lead/age/checkpoint)+ 每 qid 一行日志。**不发 Discord** —— 这些是周级 zombie,审计事件可查即可,不给 Lead/founder 制造噪音(patrol_tick 的名册若需要可后续消费审计事件,不在本单)。

**gate_question orphan(46 里的少数)**:同样条件下 dispose,但先过 `isReviewGateCheckpoint` 排除(镜像 `evictTerminalGateQuestion` 的 FLY-1257 防线)—— review gate 即使源 agent 查无 session 也不自动杀,保持人工出口,只做一次性日志降噪。

**发作前降噪(grace 内)**:内存 `orphanSeenAtTick: Map<qid, tick>` —— 首见记 tick + 打**一次**日志,之后每 20 ticks(60s)才重查一次 getSession(session 出现即移出 map 恢复正常 relay);其余 tick 直接跳过,**不再每 3s 做 getSession + warn**。日志行数从每 qid 每 3s 一行 → 每 qid 终身 2 行(首见 + dispose)。

## 3. 支柱 C:session_events 残留收口选型

### 3.1 一次性手术(2.6M 残留行)

- 模式照 FLY-1648 手术脚本先例:**默认物理只读 dry-run**;apply 前 online backup(`VACUUM INTO` 快照或 sqlite3 `.backup`);精确账(`event_type='issue_thread_infra_notify_skipped'` + 风暴窗 `ts BETWEEN '2026-08-01' AND '2026-08-06'`,预期恰 2,638,046 行,数字对不上 fail-close);事务 + 完整性检查 + 幂等重放。
- **执行窗口**:DELETE 2.6M 行会持写锁秒到分钟级,且之后空间回收(VACUUM)在 1.77GB 库上是长排它锁 —— **只能在 Bridge 停机窗执行**(00:00/12:00 班车部署窗,FLY-1959),作为 operator 步骤,apply 权留 Tadashi/Founder(FLY-1648 同款纪律)。VACUUM 可选:不做则文件尺寸不缩但行已删 → 读放大立即消失(索引扫描量随行数走,不随文件尺寸走),文件回收留后续班车窗。
- 保留 `issue_thread_infra_notify_failed`(48k 行)等其他类型 —— 只动风暴残留这一笔精确账。

### 3.2 写入方限频(防复发)

`founder-thread-notifier.ts` 的 `auditInfra` skip 路径加进程内 rate limiter:同 `(executionId, reason)` 每 10 分钟最多写 1 行审计事件,被压掉的次数聚进下一行的 `suppressed_count` payload 字段(总量守恒,可审计)。当年风暴 9.2 行/s × 76h ≈ 2.5M 行,限频后同风暴 ≈ 450 行。消费面核查:`issue_thread_infra_notify_skipped` 目前 **零读方**(全仓 grep 只有写入点),聚合不破坏任何消费契约 —— 实现节点需复核一次。

### 3.3 明确不做

- **通用 session_events retention 治理**(全类型 TTL/归档)是独立治理议题(牵动 FLY-1863 提过的 bounded-expiry 审计线),不塞进本单。
- **CompatStatement 全物化语义修改**(改成真 lazy step)动 FLY-663 的 67 个调用点契约,独立大手术,不做;本单靠"拆掉被撞的残留 + 仪表指认撞的人"达成症状收敛。

## 4. flag 治理约束

新增 1 个 kill switch:`FLYWHEEL_LOOP_PROFILER`(默认 ON,`=0` 关采样 profiler;检测器 + ELU 指标 + ledger 始终开,开销可忽略)。必须登记 `packages/config/src/feature-flags/registry.ts`(FLY-1455 漂移守卫闭网),标注 owner FLY-1995。不加第二个 flag —— 阈值(1s / 30s 窗 / N=20 留存 / 500ms long-task / 24h grace / 10min 限频)全部写死为常量,理由:每个都有明确锚点(issue 判据 / guard 阈值 / 磁盘上界),可调性没有当前需求,符合 flag 收敛方向(FLY-1806/1808)。

## 5. 风险清单(带到 plan)

1. 采样 profiler 常驻开销:按 10ms 采样间隔,V8 采样线程开销经验值 <2% CPU —— 实现节点须用 /health 延迟分布做**开关前后对照**实测,数字进 QA 证据(不许拍脑袋)。
2. `Profiler.stop` 的序列化在主线程跑:3k 样本量级毫秒级,但要在实现里给 stop→start 的窗口切换测一次实际耗时,防止仪表自己成为新的阻塞源(反身性检查)。
3. orphan dispose 误杀:三重守卫 + 24h grace + review-gate 排除;dispose 是 UPDATE 不是 DELETE,误杀可人工恢复(改回 relay_state)。
4. 手术脚本数字漂移:风暴窗账目以执行时点重查为准,fail-close(账不平不动刀)。
5. 发作机制最终不是 H1:仪表本来就是为这种情况设计的 —— profile + ledger 会把真凶指出来,Fix B/C 的价值独立于 H1 成立。
