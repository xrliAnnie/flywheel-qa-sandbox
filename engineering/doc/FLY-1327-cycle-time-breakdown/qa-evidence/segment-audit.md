# FLY-1327 周期时间分解 — 段证据抽查
Issue: FLY-1327
日期: 2026-07-17
基于: plan.md

## Run

- 固定 `as-of`: `2026-07-17T08:55:31.345Z`
- required sources: Linear / teamlead SQLite / CommDB / GitHub 均为 `ok`
- teamlead raw snapshot SHA-256: `8fa79441a6326ca9e5cc6231fbd55dbfb6b27c0bf031c014c5398d793f699fd3`
- CommDB raw snapshot SHA-256: `da2038b519ecc527224f2c11368274812595d1fe5d8dc261a510ba5f59887ac8`
- system-health: 请求到 `as-of` 所在本地日期为止，全部日志日存在；真实两行 block 格式已解析，未再把可达 load 误报为 unknown。

## Spot checks

1. **FLY-1252 lifecycle / backlog wait**
   - Linear 返回 `createdAt=2026-07-14T21:07:22.898Z`、`completedAt=2026-07-17T06:59:14.457Z`。
   - 第一条可观测工作事件为 `2026-07-16T08:07:50.000Z`；报告将此前 `35h 0m` 标为 `idle_gap/backlog_or_dispatch_wait`，没有冒充编码时间。
2. **FLY-1309 implement work**
   - `session_events.event_id=1f421a35-3ca8-47ab-aad8-1e3579fb8986` 是 `stage_changed/implement`，时间 `2026-07-16T10:47:54Z`。
   - 下一阶段边界为 `2026-07-16T12:36:09Z`；报告对应 `working/implement` 为 `1h 48m 15s`。
3. **FLY-1309 CI round**
   - `gh run 29510489630`: head `904f3b9b…`，`createdAt=2026-07-16T15:17:42Z`，`updatedAt=2026-07-16T15:35:12Z`，`conclusion=success`。
   - 报告保留完整 CI 区间；与 review 重叠部分由优先级归 review，剩余部分归 CI，区间没有重复计时。
4. **FLY-1307 cross-family review**
   - `codex_review_job.request_id=b308b260-2da3-4b5f-a0e1-c187107a8699`: code R1，`created_at=10:36:06Z`、`updated_at=10:55:07Z`、`responded_at=10:55:09Z`、`APPROVED`。
   - review runtime 使用 created→updated 的 `19m 1s`；额外 `2s` delivery latency 单列 diagnostics，不灌入 review runtime。
5. **FLY-1252 independent QA**
   - `sessions.execution_id=9ab65c68-f1b1-49e4-b6f6-cf9e46a5c40d`: role `qa`，`started_at=2026-07-16T10:56:55.901Z`、`terminal_at=15:53:30Z`、status `terminated`。
   - 报告从真实 session 边界建立 QA activity；与更高优先级 gate / rework 重叠处按冻结优先级切段，未重复累计。
6. **FLY-1252 approve gate**
   - CommDB question `9405bee0-9a79-40ff-9b72-74dadeee2ca3` 在 `2026-07-17T05:13:43Z` 打开，快照内没有 response。
   - 报告按 approved design 的 supersession/terminal/lifecycle 规则截断，直到 issue completedAt；没有伪造回答时间。
7. **FLY-1319 isolated infra failures**
   - QA session `7c568e73-cbc7-4acb-a419-a0a8a726282e` 因 tmux rescue 失败，真实边界 `06:14:07.291Z→06:15:40Z`。
   - 它是单个失败，未达到「同分钟 ≥3 个 project-wide session、相同 fingerprint」的 infra 证据门槛，因此报告没有把它臆测成 `infra_incident`；按 session role 仍计为 QA。由此本批次 infra 可节省上界为 `0m`，不是说事故不存在，而是严格口径下不能把单点错误外推为集群事故。

## Conservation

四个 issue 均满足 `Σ(segment.end_ms - segment.start_ms) = report.end_ms - report.t0`；校验器同时拒绝越界、空 evidence、未配对以及未声明重叠的区间。

## Production overlap sweep

cross-family review R2 / R3 依次指出同一 issue 的 phase session、跨 PR CI 和跨 execution rework 都可以并发。每个修复均先用生产形状 fixture 复现对应的 `illegal interval overlap`，再只对语义上可并发的 producer 声明 `allow_overlap`。

最终 sweep 使用 teamlead / CommDB 的 WAL-safe 只读备份，组装 `analyzeSources` 使用的全部 DB producer，而不只是 session stage：

- `teamlead/session_stage`: 2,565
- `teamlead/qa_session`: 216
- `teamlead/review_round`: 178
- `teamlead/rework`: 53
- `teamlead/qa_run`: 60
- `commdb/gate_question`: 72
- `teamlead/incident`: builder 已执行，当前严格三-session 聚类门槛下产出 0

合计覆盖 1,006 个 session、37,941 个 event、186 条 review row、60 条 auto-QA record，以及 469 个至少有一个 DB activity interval 的 issue，共 3,144 个实际 interval。正向控制仍能拒绝未声明的 synthetic `rework` overlap；修复后 open lifecycle 与 simulated closed lifecycle 两条验证路径均为 0 失败。GitHub `ci_run` 不在 SQLite sweep 内，另以双 PR 分支并发 fixture 覆盖；四个报告样本则继续走固定 `as-of` 的真实 GitHub 采集。固定快照的六个 canonical 产物再次逐字节 `cmp` 通过，说明修复只消除了错误拒绝，没有改变本报告数据或结论。
