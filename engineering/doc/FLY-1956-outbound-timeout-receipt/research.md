# FLY-1956 出站超时与可核回执 — 调研
Issue: FLY-1956 (https://linear.app/geoforge3d/issue/FLY-1956/bridge出站-flywheel-comm-出站调用高频-abortedqa-resultstage-setask-nudge)
日期: 2026-09-13
基于: exploration.md

## A. 生产证据(本机只读普查,2026-09-13)

### A.1 `~/.flywheel/state/qa-result-failed/` 普查(46 个文件)

| error 类别 | 数量 | 说明 |
|---|---|---|
| `409 replay_payload_mismatch` | 13 | 重跑进程换了新 `client_request_id`,服务端只能判「凭证已被别的提交消费」 |
| `This operation was aborted` | 5 | 客户端 5 s 读响应超时 |
| `409 transition_refused` / `head_authority_mismatch` / `credential_revoked` / `land_head_pr_merged` | 8 | 确定性拒绝,不属本单 |
| `qa_activation_context_unavailable` | 4 | 激活上下文过期,不属本单 |
| 其它 | 16 | 含手工重命名的 `.resolved-verdict-already-recorded-claim388-0007`、`.stale-false-failure-pass-landed-claim384x-see-run-events-23:32` —— **人工确认「假失败,pass 已落账」**的痕迹 |

两个直接结论:

1. **abort → 重跑 → mismatch 是一条固定链**。marker 以 `<execId>.json` 命名,重跑失败会**覆盖**首投的 marker,首投的 `client_request_id` 随之丢失 —— 那正是能让服务端回答「已落账」的唯一钥匙。
2. 现状里没有任何机器路径把「已落账」告诉调用方,所以出现了文件名里手写结论的做法。

### A.2 `/health` 今日实测

```
event_loop: { p99_ms: 1002.96, max_ms: 2178.94, episodes: 13 }   (uptime 3767 s, sessions 16)
```

### A.3 FLY-1986 已量得的形状(`engineering/doc/FLY-1986-load-stress-knee/plan.md` §0)

零施压、load 5.3–11.2 时生产 `/health`:600 样本 p50 2.7 ms / p95 11.96 s / max 30.31 s;坏段 130–155 s、好段 50–65 s;Tadashi 独立复现 15.9 / 19.1 / 14.6 s。**没有渐变预警**。本单据此把「单次响应 5–30 s 不来」当作正常工况而不是异常。

## B. 代码事实(逐条可核)

### B.1 超时/重试清单(flywheel-comm)

| 命令 | 文件:行 | 单次超时 | 次数 | 退避 | 键 | 耗尽行为 |
|---|---|---|---|---|---|---|
| `stage set` | `commands/stage.ts:90,214-236` | 2000 ms | 1 | — | `event_id` 进程内随机 | stderr 警告 + exit 0 |
| `qa-result` | `commands/qa-result.ts:44-46,704-938` | 5000 ms | 4 | 1/2/4 s | `client_request_id` 进程内随机(`:599`) | marker + exit 1 |
| `complete` | `commands/complete.ts:73-75` | 5000 ms | 4 | 1/2/4 s | 同上 | marker + exit 1,Bridge 开机 drain |
| `codex-review-result` | `commands/codex-review-result.ts:23-25` | 5000 ms | 4 | 1/2/4 s | 同上 | marker |
| nudge | `lead-inbox-nudge.ts:43` | 200 ms | 1 | — | 无 | 警告 |
| `request-review` | `commands/request-review.ts:42-43` | 20 000 ms | 3 | 1/3/8 s | — | — |
| `evidence-run` | `commands/evidence-run.ts:28-29` | 15 000 ms | 3 | 1/2 s | — | — |

同一个仓库里已经存在 15–20 s 的单次超时先例(`request-review`、`evidence-run`),本单把关键写操作校准到同一量级不是新口径。

### B.2 `/events` 的落账时刻与响应时刻

- 落账:`event-route.ts:1496` `store.insertEvent(...)`;重复 `event_id` → `:1507` `res.json({ok:true, duplicate:true})`。
- 正常响应:`:3503`,在 session 状态机、Discord 改名、Lead 投递之后。
- `insertEvent`(`StateStore.ts:9755`)在事务内 INSERT,唯一键冲突返回 `false`;`stage_changed` 还会顺带结算 launch delivery attempt。
- stage_changed 分支(`:2757-2870`)本身:`patchSessionMetadata` 同步;`issueDisplayRefresh.enqueue` 入队;`handleCodexAutoTrigger` 同步写 CommDB;`handleProofShotAutoTrigger` fire-and-forget。**没有 await 网络**。⇒ stage 超时 = 事件循环排队,不是 handler 慢。

### B.3 `/api/workflow/decision` 的服务端合法上界

```
resolveEngineDecisionCanonical → resolveWorkflowHeadAuthority / resolveBoundRepositoryAuthority
   git rev-parse --show-toplevel   (timeout 15 s, repository-authority.ts:73)
   git remote get-url origin ‖ git rev-parse HEAD   (各 15 s, :81-85)
resolveGateEntryBinding → probeWorkflowPr
   gh pr view <n> -R <slug> --json ...   (timeout 15 s, workflow-pr-probe.ts:29)
store.submitWorkflowDecisionByCredential   (同步事务)
insertEvent + persistRunnerMemoryCloseout   (同步)
res.json({ok, claimId, serverSeq, idempotentReplay, requestId})
```

- 全是 `promisify(execFile)`,不阻塞事件循环,但**每个到达的重复请求都会再跑一遍**这些子进程(`consumed_at` 在 `:722` 读取一次,并发到达时都还是 null)。
- 理论最坏 ≈ 15 + 15 + 15 = 45 s;负载时段 `gh` 冷启动 + GitHub API 常见 3–8 s。客户端 5 s 必然打在中途。
- 重放判定(`StateStore.ts:55985-56004`):`consumed_at != null` 时,`consumed_submission_digest === digest && consumed_client_request_id === clientRequestId` → `idempotentReplay:true`;否则 `replay_payload_mismatch`。digest 含 `evidence.summary`,所以**同 id 但 summary 变了也会 mismatch**。

### B.4 nudge

- `/api/lead-inbox/nudge`(`plugin.ts:3175-3196`)只置 `nudgePending`;`lead-inbox-loop.ts:29-30` 活跃 1 s / 空闲 30 s。
- 调用点 4 处(`index.ts:528,599,867,2227`),都是 durable row 先落账再敲门。⇒ nudge 失败的**唯一代价是最多晚 30 s**,不是丢失。措辞「nudge failed」误导 runner/Lead 以为丢了。

### B.5 客户端断连感知

`event-route.ts` / `workflow-decision-routes.ts` 对 `req.on("close")` / `res.writableEnded` 零使用;`plugin.ts` 只在 SSE 与 fleet progress 用过 `req.on("close")`(`:2411,2727`)。Express 在客户端断开后照常跑完 handler 并 `res.json`(写到已关闭的 socket,静默)。⇒ 服务端没有任何一处知道「这次响应没人收」。

### B.6 已有可复用的观测与注入点

- `EventLoopAttribution.healthSnapshot()` → `/health.event_loop`(无鉴权);`recordSpan(name,start,end)` 只记录 >500 ms 的 span,已被 git 物化路径使用。
- `WorkflowDecisionRouterDeps`(`workflow-decision-routes.ts:33-61`)可注入 `prProbe`、`now`;测试可以用慢 `prProbe` 复现并发重复。
- `createEventRouter` 在 `plugin.ts:2496` 以 `app.use("/events", tokenAuthMiddleware, router)` 挂载,可在中间件链插一个观测中间件而不改 router。
- 测试:`stage.test.ts` 用 `vi.stubGlobal("fetch")` + `process.exit` 抛错;`lead-inbox-nudge.test.ts` 注入 `fetchImpl`/`warn`;`qa-result.test.ts` 注入 `createClientRequestId`/`now`/`sleep`、以 `HOME` 临时目录验 marker。

## C. 候选方案可行性核对

### C.1 跨进程同键重放(qa-result)

- 需要的信息已经在 marker 里:`client_request_id`、`recoverable_verdict{targetExecutionId,status,prHeadSha,summary}`(`qa-result.ts:1453-1496`)。
- 缺的两件事:(a) 首投**之前**就写 marker(write-ahead),否则进程被 kill 时 id 丢失;(b) 重跑时**读** marker 并复用 id 与 summary。现状 `readMarker` 不存在。
- 风险:重跑时 verdict 翻转(pass→fail)。同 id 不同 payload 会被服务端判 mismatch,这是正确行为,但客户端应在**发送前**就拒绝并说明,而不是让服务端来说。

### C.2 stage set 同键重试 + 前置 drain

- `/events` 已按 `event_id` 幂等,`duplicate:true` 就是「已落账」回执。同 id 重试零服务端改动。
- drain 位置:`index.ts:259` `main()` 在 `switch(command)` 之前,只在 `FLYWHEEL_EXEC_ID` 存在且 marker 目录里有该 exec 的文件时才动;单次 5 s、不重试、失败留 marker。stage 顺序:marker 按写入时间排序逐个重放,任一失败即停,不跳过(否则乱序会让 Bridge 收到「回退」的 stage)。
- 与 `complete-marker-reconciler` 的关系:互不相关;stage marker 不进 Bridge。

### C.3 Bridge 决策合流(singleflight)

- 键:`hashCapabilityToken(credential)`(flywheel-config 已导出,决策路由未 import,需加)。
- 语义:同键在飞 → 后到者 await 同一个 Promise,得到相同 `{status, json}`;settle 后立刻从 map 删除。不跨进程,不持久化。
- 边界:只合流 **同 credential 且同 client_request_id** 的请求;同 credential 不同 id 的第二个请求不合流,照常走到 store 得到 mismatch(保持现有合同)。

### C.4 断连观测

- 中间件:`res.on("close", () => { if (!res.writableEnded) meter.abort(route, Date.now()-start) })`,再加 `res.on("finish")` 记录 handler 墙钟并在 >500 ms 时 `recordSpan`。
- 暴露:`/health.outbound_pressure = { events: {client_aborted_total, last_aborted_at, last_abort_after_ms}, workflow_decision: {...}, lead_inbox_nudge: {...} }`。`/health` 消费者(wrapper、liveness probe、FLY-1986 collector)均不拒未知键(runner-memory:「validator 不拒额外 component;probe jq 不校验未知键」)。

### C.5 客户端诊断快照

终局失败时 `GET /health`(2 s 超时,失败就打印「health unavailable」)取 `event_loop` + `os.loadavg()[0]`,打印一行:
`[qa-result] bridge pressure: event_loop p99=1003ms max=2179ms episodes=13 load1=34.9` —— 让 Lead 从 runner 日志一眼看出是负载而不是逻辑错误。

## D. 与相邻 issue 的边界

| issue | 关系 | 本单不做 |
|---|---|---|
| FLY-1986 load-stress-knee | 提供「坏段 5–30 s」的量;其 Phase-0 collector 只读 | 不改准入阈值,不做压测 |
| FLY-1971 准入无预警 | 同族观测 | 不动 runner-admission |
| FLY-172 complete-marker-reconciler | 兜底范式 | 不把 stage/qa marker 塞进它 |
| FLY-1373 nudge doorbell | 200 ms 的出处 | 不改 inbox loop 轮询 |
