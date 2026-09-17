# FLY-2663 required tests 墙钟审计 — 调研
Issue: FLY-2663 (https://linear.app/geoforge3d/issue/FLY-2663/ci去-flake-observation-performance-墙钟阈值断言50ms100ms在共享-runner)
日期: 2026-09-16
基于: exploration.md

## CI 约束

GitHub main branch protection 当前只要求 `CI OK`。`.github/workflows/ci.yml` 的 `CI OK`
聚合 `unit-tests` 与全部 script-test jobs；`unit-tests` matrix 内 `observation performance` 直接执行
目标文件。因此目标测试或其它 required 测试中的墙钟假红都会使唯一 required context 失败。

普通 teamlead 四 shard 通过 `scripts/teamlead-ci-shard.mjs` 排除目标文件；
`scripts/__tests__/teamlead-shards.test.mjs`、`ci-structure.test.sh`、
`ci-matrix-coverage.test.sh` 和 `packages/teamlead/ci-test-costs.json` 锁定现有拓扑。本次不改文件名、
matrix row 名或命令，不触碰这组结构合同。

## 根因与现有修复边界

main 已包含 FLY-2645：在 backlog、tail、modeTick 测量前执行 `wal_checkpoint(TRUNCATE)`，将
可识别的 SQLite checkpoint I/O 移出窗口。它仍保留 `<50ms/<100ms`，所以宿主 deschedule、GC、
fsync 抖动仍能让 max-of-five 假红。Lead 提供的同一 SHA 证据是两次约 82.7ms 失败、第三次通过；
继续放宽常数不能满足“required checks 不再用真实毫秒判定”的验收。

## observation 的确定性边界

`observation-cursor.ts` 的公开接口提供可断言的不变量：

- due pending query `LIMIT 8`，normal source page `LIMIT 32`；两段都可能在一次调用发生，因此
  `pageStats().sourceCandidates` 上界是 **40**，不是 32；
- holder 总预算是 16，因此 `holderCandidates<=16`；`pageStats()` 没有 pending/normal 拆分，
  不能从公开 seam 单独声称 pending candidates `<=8`；
- `pageStats()` 还暴露 outcomes、cursor 与 deferred，可证明每次调用的工作上限与前进；
- steady state 可断言三种计数都为 0；1.7M/500 fixture 可断言 25,000 closeout outcomes 完整产生；
- `modeTick()` 可从 StateStore observation progress 与 injected spies 验证两个 source 确有
  `inspected>0`、不报错；固定 clock 后不把必然为零的 elapsed/starved 当作额外覆盖。

这些证据证明 bounded work 和结果正确性，不证明宿主上的微秒级吞吐。删掉真实 elapsed 后，若内部
点查索引退化，某些测试会损失 timing-only 信号；本次明确接受这部分覆盖下降，不以手抄 SQL 的
EXPLAIN 冒充端到端生产查询证明。大 fixture 保留是为了结果/分页/游标覆盖，而不是性能基准。

## 修正后的 required-check 清单

首轮清单只交叉 `toBeLessThan(`，漏掉 `toBeLessThanOrEqual`、`assert(a<b)`、跨闭包数组、
生产返回的 `durationMs`，也没扫描 required shell/MJS。修正后使用：

1. package 测试中的 `Date.now`、`performance.now`、`process.hrtime*`，配合 `<`/`<=`、
   `toBeLessThan(OrEqual)`、`expect(a<b).toBe(true)` 和 tainted value 作为 greater-than RHS；
2. `.github/workflows/ci.yml` 实际引用的 `scripts/__tests__/*.test.sh|mjs`，检查 `date +%s`、
   `$SECONDS`、Python `time.monotonic/perf_counter` 到 `-lt/-le/</<=` 的数据流；
3. 人工复核生产返回的 `durationMs/elapsedMs/wallMs`，因为 clock source 不在测试文件中。

修正扫描确认以下 required 测试有真实墙钟上界，必须处置：

| 类别 | 文件/断言 | 确定性处置 |
|---|---|---|
| observation | `observation-performance.test.ts` 的 `<50/<100` | 固定 performance clock；断言 source≤40、holder≤16、cursor/outcomes/progress |
| 大数据 | `fly2339-bounded-delivery-maintenance.test.ts`、`mailbox-query-plans.fly2136.test.ts`、`StateStore.fly2341-terminal-archive.test.ts`、`codex-quota-bench.test.ts` | 保留规模、功能、分页/scan/cursor/query-plan/state 证据，删除 elapsed；明确接受 timing-only 覆盖下降 |
| child/timeout | `agent-browser-runner.test.ts`、`async-exec-file.test.ts`、`workflow-docs-git-stall.test.ts` | 保留 typed timeout、kill、descendant/output/event-loop/state；测试框架 timeout 只防永久挂死 |
| fake timers | `TmuxAdapter.test.ts`、`codex-transcript-sink.test.ts`、`mailbox-lead-runtime.test.ts`、`roundtable-allowbots.test.ts`、`disposition-receipt.test.ts` | 推进业务 timer，断言 timeout precedence/abort/副作用，不采样宿主耗时 |
| process state | `gate-noblock.test.ts`、`StructuredInboxRouter.test.ts` | 断言 pending/exit/health；Router 删除 1500ms `Promise.race`，由 Vitest timeout 防永久挂死 |
| SQLite lock | `auto-narrow-source.test.ts`、`StateStore.auto-narrow-approval.test.ts` | spy/记录生产 `pragma("busy_timeout = 0")` 和恢复；保留 busy、writer 未调用、解锁后成功 |
| DB wall semantics | `StateStore.test.ts`、`StateStore.session-events-ts.test.ts`、`db.fly1328.test.ts` | 写入前后记录边界，按 SQLite 秒精度断言区间/顺序；TTL 断言 `before+1h <= expiry <= after+1h` |
| voice | `voice-core/src/__tests__/announcer.test.ts` | fake timers 推进 synth delay，断言 logical `playbackStartMs` |
| required MJS | `qa-lead-diagnostics.test.mjs` 两处 `<4s/<3s` | 删除 receipt elapsed；用 status/unavailable/descendant 结果与 Node test timeout |
| required shell | `codex-guard.test.sh`、`qa-fly1501-bounded-run.test.sh`、`qa-fly1501-brake-missing-alert.test.sh`、`voucher-watch.test.sh`、`test-lead-memory-sync.test.sh`、`flywheel-buddy-connect.test.sh` | 删除 `date +%s` 上界；保留 rc、marker、survivor、receipt、cache/permission/launch 等状态证据，job timeout 防永久挂死 |

`fly1364-live-e2e.test.sh` 含真实 SLA，但不在 CI workflow 的 required 执行路径，保留并在守卫输出中
分类为 manual-only；`fly1364-discord-e2e.test.sh` 只报告 latency，不用它决定测试成败。其它宽泛
文本候选（fixture timestamp、字符串位置/长度、注入 logical clock、循环计数、源码行号）不是
真实墙钟上界，AST/required-script 数据流应排除，不能靠文件白名单隐藏。

## Guard 设计结论

守卫放在 existing package unit discovery 下，不新增 script suite。它先以便宜正则筛含 clock/
duration sink 的文件，再对候选做 AST/数据流分析，并显式给测试 60s timeout，避免守卫自身受默认
5s 共享 runner 调度影响。

TS/JS taint 按词法作用域传播，覆盖闭包捕获、赋值、array push、spread、`Math.max`。对生产返回
的 `*durationMs/*elapsedMs/*wallMs` 采用保守 sink 规则；确由注入 logical clock 产生的值需要就地
`wall-clock-audit: deterministic-clock <reason>` marker。marker 是语义说明，不是 path whitelist。
Shell/MJS 只扫描 workflow 实际引用的 required scripts；输出统一为 `path:line`。

## 验证口径

- 本地：修改后的 observation 测试串行连续运行 20 次；任何一次失败都算失败。
- focused：守卫及每个改动文件对应 suite；所有改动的 `scripts/__tests__` 逐个执行。
- 聚合：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`。
- CI：PR literal final head 的完整 workflow 三次全绿；每次核对 `CI OK`、observation row 与守卫
  所在 shard。重跑必须绑定同一 SHA，不复用旧 head 证据。
