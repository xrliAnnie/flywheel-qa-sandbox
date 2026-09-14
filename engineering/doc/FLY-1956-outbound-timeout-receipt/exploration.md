# FLY-1956 出站超时与可核回执 — 探索
Issue: FLY-1956 (https://linear.app/geoforge3d/issue/FLY-1956/bridge出站-flywheel-comm-出站调用高频-abortedqa-resultstage-setask-nudge)
日期: 2026-09-13
基于: 无

## 1. 问题陈述(founder 视角)

Runner 在负载时段调 `flywheel-comm` 的三类出站命令,反复看到 `This operation was aborted`:

| 实例 | 命令 | 现象 | 最终一致性由谁兜住 |
|---|---|---|---|
| FLY-1867 QA(load 34.9,Bridge `/health` ok,uptime 3.8h) | `qa-result --status pass` | 连续 4 次 aborted → FAIL-CLOSE;重跑得到 `409 replay_payload_mismatch` | 服务端首投已落账;QA runner 走了一整轮只读账本自证 |
| FLY-1934 QA | `stage set` ×3 | 三连 aborted,stage **未记录**;`ask` 报 `lead inbox nudge failed` | ask 的 durable queue row 保留;stage 没有任何兜底 |
| 2026-08-21 多次 | `send` 后 nudge | `nudge failed durable row retained` | durable row 保留,Lead 30s 空闲轮询兜底 |

共性:**正确性靠 durable 层最终一致,即时性靠重播;调用方拿不到「落账了但回执丢了」vs「没落账」的区分。**

## 2. 现状审计(代码事实)

### 2.1 三个出站调用的超时与重试(flywheel-comm 侧)

| 命令 | 端点 | 单次超时 | 次数 / 退避 | 幂等键 | 失败语义 |
|---|---|---|---|---|---|
| `stage set` (`commands/stage.ts:90`) | `POST /events` | **2000 ms** | **1 次,无重试** | `event_id = randomUUID()` 每次调用新生成 | fail-open:stderr 警告 `stage not recorded`,exit 0 |
| `qa-result` (`commands/qa-result.ts:44-46`) | `POST /api/workflow/decision` | **5000 ms** | 4 次,退避 1/2/4 s | `client_request_id = randomUUID()` **每次进程新生成**(同进程 4 次重试复用) | fail-close:写 `~/.flywheel/state/qa-result-failed/<execId>.json`,exit 1;**没有任何 Bridge 侧 drain** |
| `ask` / `send` / `ack-event` / `gate` 后的 nudge (`lead-inbox-nudge.ts:43`) | `POST /api/lead-inbox/nudge` | **200 ms** | 1 次 | 无(doorbell,幂等) | best-effort:警告 `nudge failed; durable queue row retained` |
| (同族)`complete` / `codex-review-result` | `/events` | 5000 ms | 4 次,1/2/4 s | 同进程复用 event_id | fail-close marker,Bridge `complete-marker-reconciler` 开机 drain |

### 2.2 Bridge 侧:响应在哪一刻发出

- `/events`(`event-route.ts:649-3505`):`store.insertEvent` 在 **1496 行**落账(按 `event_id` 去重,重复返回 `{ok:true, duplicate:true}`),但 `res.json({ok:true})` 在 **3503 行**,中间是 session 状态机、Discord 线程改名、Lead 投递等一整段。stage_changed 分支本身几乎全同步,所以「stage set 2s 超时」几乎总是**事件循环排队**造成的,而事件已经落账。
- `/api/workflow/decision`(`workflow-decision-routes.ts:694-825`):落账 **之前** 要 `await resolveEngineDecisionCanonical`(git rev-parse ×3,各 15s 上限)与 `await resolveGateEntryBinding` → `probeWorkflowPr`(**`gh pr view`,15 s 上限**,`workflow-pr-probe.ts:29`)。也就是说服务端一次处理的合法上界远超客户端 5 s;客户端 abort 不会取消服务端工作,**4 次重试 = 4 个并发 gh 子进程**,在 load 34 的机器上互相加重。
- 决策落账后重放语义(`StateStore.ts:55985-56004`):同 credential、同 `client_request_id`、同 payload digest → `idempotentReplay:true`;`client_request_id` 不同 → `replay_payload_mismatch`。**这正是 FLY-1867 的 409 来源**:重跑进程换了新 id。
- `/api/lead-inbox/nudge`(`plugin.ts:3175-3196`)只是把 `nudgePending=true`;Lead inbox loop 活跃 1 s、空闲 **30 s** 一轮(`lead-inbox-loop.ts:29-30`)。200 ms 在 p99 ≈ 1 s 的事件循环下几乎必失败;失败代价 = 最多晚 30 s。
- 客户端断连(abort)在三条路由上**都不被感知**(`req.on("close")` / `writableEnded` 零使用),所以 Bridge 日志与 `/health` 里没有「客户端已放弃」的任何计数。

### 2.3 已有的负载可观测面

- `/health`(无鉴权)已带 `event_loop: {p99_ms, max_ms, episodes}`(`event-loop-attribution.ts`,30 s 窗口),今日实测 `p99_ms: 1002.96, max_ms: 2178.9, episodes: 13`。
- `GET /api/diagnostics/event-loop`(master token)给 30 s 窗口序列 + 长 span 归因;`recordSpan` 目前只挂在 git 物化与少数几处。
- `BridgeEventLoopGuard` 60 s 停摆才 SIGKILL;它解决「假死」,不解决「秒级卡顿」。
- **FLY-1986(load-stress-knee)** 已实测:零施压、load 5–11 时生产 Bridge `/health` p95 11.96 s / max 30.31 s,呈 130–155 s 坏段 + 50–65 s 好段,**没有渐变预警期**。⇒ 固定 2 s / 5 s 超时在坏段里必然全军覆没;本单不能假设「调大一点就好」,必须假设 **单次响应可能 5–30 s 不来**。

## 3. 根因归纳

1. **超时阈值与服务端合法上界脱节**:客户端 5 s vs 服务端 gh 15 s;客户端 2 s vs 事件循环 5–30 s 坏段。
2. **重试不带跨进程的幂等键**:同进程重试幂等,换进程就变成「新请求」,服务端只能判 mismatch。
3. **回执缺位**:客户端把「读响应超时」等同于「失败」,而服务端在超时之后仍会落账;没有任何一条路径能便宜地回答「我那一笔落了没」。
4. **重试即放大**:abort 不取消服务端工作,并发重复请求在决策路由上各自再起 gh/git 子进程。
5. **背压不可见**:客户端放弃这件事 Bridge 不知道,`/health` 没有「被放弃的请求数」;runner 日志里只有一句 aborted。

## 4. 设计方向(候选)

### 方向 A(推荐):同键重放 = 重试 = 自证;超时按服务端上界校准;服务端合流 + 放弃计数

一句话:**每个关键写操作携带一个跨进程稳定的幂等键;重试与自证都是「同键重放」;服务端对同键重放返回的 `duplicate` / `idempotentReplay` 就是回执。**

- `qa-result`:把 `client_request_id` 先写到 marker(write-ahead),重跑时若 marker 里的 (target, status, prHeadSha) 与本次一致则复用该 id → 服务端 `idempotentReplay:true` = 已落账。单次超时 5 s → 20 s,总预算 ≥ 服务端最坏上界。
- `stage set`:同 `event_id` 重试 3 次(10 s / 退避 2 s、5 s),`duplicate:true` 视为落账;耗尽后写 stage marker,由**下一次任何 flywheel-comm 调用**(同 exec 环境)先行重放,不再静默丢。
- Bridge:`/api/workflow/decision` 按 credential 哈希做 in-flight 合流(singleflight,即同一把凭证在飞时第二个请求等第一个的结果而不是再起一遍探测);三条路由记录「客户端在响应前断开」计数并暴露到 `/health.outbound_pressure`;CLI 终局失败时打印 `/health` 的 `event_loop` + `load1`。
- nudge:200 ms → 1500 ms,措辞改成「doorbell 未送达;durable row 已保留,Lead 最迟 30 s 内轮询到」。

### 方向 B:Bridge 把 `/events` 的响应提前到 insertEvent 之后

直接解决 stage 的「已落账却报没记录」。**拒绝**:`/events` 后半段有多处 409(`review_ship_target_binding_rejected`、quota ownership 等)是合同的一部分,`complete` 依赖它们;为 stage 单独开早返回会造成一条路由两种响应时序,Codex 与后续维护者都得记住这个特例。

### 方向 C:新增只读回执端点(`GET /api/workflow/decision/receipt`、`GET /api/sessions/:id/stage`)

**拒绝(作为主路径)**:同键重放已经是幂等的读写合一回执,不需要新的鉴权面;新增 GET 还要决定 runner 用哪把 token(runner 只有 ingest token,读 session 状态是新的暴露面)。保留为「若 Codex 认定 write-ahead marker 不够」的备选。

### 方向 D:把超时做成按 `/health.event_loop.p99` 动态自适应

**拒绝**:读 `/health` 本身在坏段里也要 5–30 s;自适应逻辑会成为第二个要调的旋钮。用「总预算 ≥ 服务端上界 + 观测到的坏段长度」这一条静态规则更可解释。

## 5. 需要 Lead 裁定的问题(非阻塞,先按默认继续)

1. stage marker 的 drain 放在 **CLI 下一次调用前置**(零 Bridge 改动)还是扩展 `complete-marker-reconciler`(Bridge 开机 drain)?默认前者:reconciler 带 force-fail 语义,扩进去要动 lifecycle 合同。
2. 「重放 load>30 场景」的验收用**注入延迟的确定性 harness**(服务端人为延迟 8 s)作为门槛,真实 load>30 的运行作为可选证据 —— 在生产机上人为打到 load>30 会伤在飞 runner。

## 6. 非目标

- 不改 Lead inbox loop 的轮询节奏、不改事件循环本身的性能(那是 FLY-1986 / FLY-1971 的地界)。
- 不给 `/events` 改响应时序,不新增 token 类型。
- 不做 Bridge 侧 qa-result marker drain(QA 判决必须由 QA 进程亲手重放,凭证语义才成立)。
