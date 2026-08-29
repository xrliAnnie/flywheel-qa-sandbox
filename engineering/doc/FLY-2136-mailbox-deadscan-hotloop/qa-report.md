# FLY-2136 mailbox 死信扫描热循环 — QA 报告

Issue: FLY-2136 (https://linear.app/geoforge3d/issue/FLY-2136/urgentbridge-稳定-mailbox-死信扫描热循环饿死事件循环每-tick-全表重扫-66-万终态行事务内)
日期: 2026-08-28
基于: plan.md

## 1. 结论

修复在生产等量数据形状(`63,007 ACKED + 3,212 DEAD`)下通过 query-plan、定向压力、全包回归和真实 Bridge 起停验证。真实 Bridge 连续 240 次 `/health` 请求全部成功,HTTP 延迟 p99 从 FLY-2058 基线的 `25–30.7s` 降到 `1.42ms`,最大值 `28.26ms`;Bridge 自监控最近 30s 窗口 p99 `12.55ms`,0 次 event-loop episode。

死信判定、通知投递与租约语义未修改。活体回归前后热表仍为 `63,007 ACKED + 3,212 DEAD`,未产生伪 `dead_letter_notice`,也未把未到期行提前归档。

## 2. 定向性能与语义回归

| 验证 | 结果 |
|---|---|
| 66K query-plan / uncovered recipient 扫描 | `<500ms` 门通过;测试文件总耗时 `1.355s` |
| near-cap 归档(10 × ~1.8MB family) | 10 个 family 的审计日志与 identity tombstone 全保留;Bridge 自动维护每轮显式限 `5 families + 1 GC intent` |
| 8K gate marker 缓存 | warm pass `0` 次 `readFileSync`,新增单文件只解析 `1` 次;CI 用确定性 I/O 不变量,不拿受 worker 负载影响的 wall-clock 当门禁 |
| flywheel-comm 复审定向用例 | 3 files / 44 tests 通过 |
| teamlead 复审定向用例 | 2 files / 34 tests 通过 |
| config flag policy | 16 tests 通过;两个 interval env 均归类为 numeric tuning |

额外回归覆盖:101 个死信收件人第二页扫描、40 个 pinned/not-due family 的 ring-cursor 前进、归档失败的尝试级节流、Lead dead-alert 扫描节流、gate marker 回答/删除/损坏/同 mtime 不同目录失效、瞬时文件 I/O 失败下一 poll 自愈、缓存对象不可被调用者污染。`content_ref` 文件读取与 SHA 计算已移出 SQLite transaction。

R3 用更长的活体只读样本重新核算归档容量:约 `198.2 terminal rows/h`,平均 `1.14 rows/family`,即约 `174 families/h`。生产默认 `5 families/min = 300 families/h`提供约 `1.7×` 写入余量,足以在 72h retention 窗后收敛;同时比原始 10-family pass 减半单次主线程预算。ring-cursor 前进测试使用同一生产值 `5`。GC 仍独立限 `1 intent/min`。非阻断 follow-up:当前未对连续满批、`busy` 或 skipped 结果做 telemetry,流量继续增长时需要另行补饱和可观测性。

## 3. 仓库门禁

- `pnpm lint`:通过;仅有任务外既存 warning。
- `pnpm -r build`:通过,含 TeamLead 拓扑构建。
- `packages/flywheel-comm --maxWorkers=4`:123 files / 1,732 tests 通过(另 2 skipped);唯一失败是任务外 `qa-result.realgit` 的 5s 全套负载 timeout,隔离复跑 2/2 通过(`2.737s`)。reviewer 指出的 gate-marker wall-clock 断言已删除,该文件在完整套件中通过。
- `packages/edge-worker`:106 files / 1,283 tests 通过。
- `packages/voice-core`:31 files / 321 tests 通过。
- `packages/voice-bridge`:60 files / 673 tests 通过。
- `packages/core` headless:19 files / 219 tests 通过。规范命令中的两个 macOS Terminal.app 真 GUI 用例在受管无 GUI 会话被 AppleScript/XPC 拒绝;不是测试断言失败。
- `packages/teamlead --maxWorkers=4`:729 files、9,656 executed tests 全部通过(另 6 skipped);所有断言完成后,Vitest 父/worker RPC 报一次 `Timeout calling onTaskUpdate`,故进程退出码为 1。此前并发全跑出现的 6 个无关 timeout 均已串行复跑,56/56 通过。
- real-tmux prompt-overflow 压测在全矩阵负载下触发一次 5s timeout;隔离复跑 2/2 通过,5 × 110KB launch 用时 `1.87s`。

## 4. 真实 Bridge 阳性对照

使用 built Bridge、隔离 state/comm/home、单个 QA project 和生产 mailbox schema 启动;数据库写入准确的 `66,219` 条终态行。Bridge 的 W2 lead delivery loop 持续 fresh,证明真实 mailbox tick 正常推进。

连续 240 次、每 100ms 一次请求 `/health`:

| 指标 | 结果 |
|---|---:|
| success | 240 / 240 |
| p50 | 0.78ms |
| p95 | 1.18ms |
| p99 | 1.42ms |
| max | 28.26ms |

Bridge EventLoopAttribution 最近窗口:p99 `12.550143ms`,max `13.672447ms`,event-loop utilization `0.0841`,episodes `0`;五个完整 30s 窗口均无 episode。SIGINT 后 GatePoller 停止、进程退出码 0、QA 端口无监听者。

隔离环境没有把 `claude`/`codex` 放进 PATH,因此 runner runtime 注册按预期跳过;本验证覆盖真实 Bridge server、LeadInboxRuntime/W2 mailbox tick、EventLoopGuard、诊断 API 与有界关闭,不触碰生产 state。
