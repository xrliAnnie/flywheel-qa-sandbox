# FLY-2663 required gate 去真实墙钟 — 实施计划
Issue: FLY-2663 (https://linear.app/geoforge3d/issue/FLY-2663/ci去-flake-observation-performance-墙钟阈值断言50ms100ms在共享-runner)
日期: 2026-09-16
基于: research.md

## 目标、范围与不变量

目标是在 required `CI OK` 的 package、MJS、shell 测试路径中消除“真实墙钟 duration 必须小于
固定常数”的 pass/fail，改用 fake clock、操作数或可观察状态。生产代码的 25ms observation
budget、各 timeout 配置、SQLite schema/queries、land policy 均不改；`fly1364-live-e2e.test.sh`
是 manual-only SLA，不纳入 required guard。

保持 `observation-performance.test.ts` 文件名、matrix row 名和命令不变，因此不修改 CI workflow、
shard exclusions、`ci-test-costs.json` 或 CI structure inventory。没有可靠告警消费者，本次不新增
non-blocking perf job。删除 elapsed 后明确接受 timing-only index-regression 信号下降；保留的
大 fixture 只证明结果、分页、游标和状态边界。

## TDD 切片

### 1. RED：覆盖完整 required graph 的 wall-clock guard

新增 `packages/teamlead/src/__tests__/required-wall-clock-thresholds.test.ts`：

1. 由 `git ls-files` 取得 package tests；解析 `.github/workflows/ci.yml` 的字面脚本引用，取得
   required `scripts/__tests__/*.test.sh|mjs`，manual-only 文件不混入；
2. 先用便宜正则筛候选，只有候选进入 TypeScript AST/脚本数据流；test case 显式 timeout 60s；
3. clock seeds 覆盖 `Date.now()`、`performance.now()`、`process.hrtime*()`，taint 按词法作用域
   传播，含闭包捕获、赋值、array push、spread、`Math.max`；
4. sinks 覆盖 `toBeLessThan`、`toBeLessThanOrEqual`、`assert/assert.ok(a<b|a<=b)`、
   `expect(a<b|a<=b).toBe(true)`，以及 clock-derived value 作为
   `toBeGreaterThan(OrEqual)` 的 RHS；
5. 对生产返回的 `*durationMs/*elapsedMs/*wallMs` 属性采用保守 sink 规则；注入 logical clock
   的确定性值只能用就地 `wall-clock-audit: deterministic-clock <reason>` marker 解释；
6. shell/Python 数据流覆盖 `date +%s`、`$SECONDS`、`time.monotonic/perf_counter` 到
   `-lt/-le/</<=`；输出必须是精确 `path:line`，禁止 path whitelist。

RED 必须至少列出 research 表中的现存 required 违规，包括首轮漏掉的
`agent-browser-runner.test.ts`、`qa-lead-diagnostics.test.mjs`、`codex-guard.test.sh`、
`StateStore.session-events-ts.test.ts`、Tmux `durationMs` 和跨闭包 observation samples；漏报先修
guard，不进入 GREEN。

### 2. GREEN-A：observation 只断言确定性 work bounds

修改 `observation-performance.test.ts`：

- 用可控 `performance.now` fake 固定 deadline clock，删除 `PerformanceObserver`、CPU/context
  switch、samples/summary/max 毫秒断言；
- WAL checkpoint 保留为 fixture 隔离，只断言 `busy=0` 与 WAL 清空，不计时；
- 每次调用保存公开 `pageStats()`，断言 `sourceCandidates<=40`、`holderCandidates<=16`、
  cursor 单调前进；不声称公开 seam 无法观察的 pending 专项 `<=8`；
- 保留 1.7M events、500 holders、25,000 outcomes、steady zero-work、tail progress；
- 两种 mode 的 `modeTick()` 断言 no error，且 closeout/verdict progress 确有 `inspected>0`；不把
  固定 clock 下必然为零的 elapsed/starved 当作证明。

先单跑形成原 `<50/<100` 失败清单，再完成最小替换；不改测试文件或 CI row 名。

### 3. GREEN-B：package elapsed 逐类替换

每个文件单独跑 focused suite：

- 大数据类（FLY-2339、FLY-2136、terminal archive、quota bench）删除 elapsed，保留 scale、
  exact outputs、page/run counts、`scanned<=128`、cursor、既有 query plan 和恢复状态；文档不把
  这些 seam 宣称为端到端索引性能证明；
- 可控 JS timer（TmuxAdapter、transcript sink、mailbox runtime、roundtable、disposition
  receipt、voice announcer）用 `vi.useFakeTimers()` 推进配置的业务 timer。Tmux 明确推进 25ms，
  在 500ms waiting timer 前得到 timeout/kill，从逻辑时间证明 precedence；
- real child/process（agent browser、async-exec、workflow docs git）保留 typed timeout、kill、
  descendants/output/event-loop/state；Vitest timeout 只防永久挂死；
- StructuredInboxRouter 删除 1500ms `Promise.race`，直接 await stop/health，让 Vitest timeout
  做 hang guard；gate no-block 用 pending/DB/不 poll seam；
- CommDB/StateStore lock tests spy/记录生产 `pragma`，断言临界区确实设置
  `busy_timeout = 0` 并恢复 777，同时保留 busy、writer 未调用、release 后成功；
- `StateStore.test.ts` 与 `StateStore.session-events-ts.test.ts` 在写入前后取 OS 时间并按 SQLite
  秒精度断言 `floor(before)<=stored<=ceil(after)`；不是 duration-to-constant；
- `db.fly1328.test.ts` 捕获 finalize 前后时刻，断言 expiry 位于 `before+1h` 和 `after+1h`
  之间；不再把 `Date.now()` 差值与 0.5h/1.05h 常数比较。

### 4. GREEN-C：required MJS/shell 状态化

- `qa-lead-diagnostics.test.mjs` 删除 Node/Python receipt elapsed 字段和 `<4s/<3s`；保留 mode
  status、unavailable、子孙进程/pipe 行为，Node test timeout 防永久挂死；
- `codex-guard.test.sh` 保留 rc=124/7、pid/marker、survivors=0、profile action/call count；
- bounded-run/brake/voucher/memory-sync/buddy-connect tests 删除 `date +%s` 上界，保留 rc、
  launch marker、descendant cleanup、interrupt receipt、cache/permission/secret-scan 等分支特有状态；
- 每个改动脚本直接执行并记录 TAP/exit 状态；不以新的短墙钟 watchdog 替代旧阈值。

### 5. 守卫 GREEN 与 refactor

重新运行 guard，要求 required 清单为空。对确定性注入 clock 的 property sink，只加最窄、带理由
的 marker；不允许 file/path 豁免。最后删无用 clock imports/variables，复跑所有 focused suites。

## 验证

### Focused/TDD

1. guard RED（完整旧断言清单）→ 分切片 GREEN；
2. 每个修改 package 文件对应 Vitest focused run；
3. 每个修改 `scripts/__tests__` 文件直接运行；
4. observation 测试在同一 checkout 串行连续运行 20 次，保存 20/20 结果；
5. 因 CI 拓扑不改，仍运行现有 structure/matrix/shard contracts 证明没有意外漂移。

### 项目门

- `pnpm lint`
- `pnpm -r build`
- `pnpm test:packages:run`
- 本次修改的全部 `scripts/__tests__/*.test.sh|mjs`

若聚合只出现协议允许的 `onTaskUpdate` RPC 噪声，保存完整 PACKAGE_GATE_RECEIPT；任何 assertion
failure 都必须修复，不能用 receipt 放行。

### Review / PR / exact-head CI

1. implementation commit 后 stage `code_review`，按 Codex author 流程新开 gate +
   `request-review`；CHANGES_REQUESTED 修复后必须新开 gate；
2. code review 通过后提交 milestone，且 `engineering/doc/milestones/FLY-2663.md` 是 PR 的 literal
   last commit；之后不再改 head；
3. push feature branch并开 PR；在这个 literal final SHA 上取得完整 workflow 三次全绿（首次 +
   whole-workflow rerun 两次），逐次核对 `CI OK`、observation row 和 guard shard；
4. 若 milestone final head 与受审代码 head 不同，按 exact-head 规则对 final head 再做 code review，
   不复用旧 head 批准。

## 回滚与风险

- 代码改动限定 tests/guard/docs，无 migration、生产状态或 CI topology；回滚 commits 即恢复；
- fake timers 必须在 `finally/afterEach` 恢复，先推进 timer 再 flush microtasks；
- 守卫可能误报/漏报：用 research 的宽 grep + 生产返回字段人工清单校验，禁止 path whitelist；
- 失去的 timing-only 性能信号已明确接受；若实现必须改生产查询或新增 perf 基础设施，停止并向
  Lead 提问，不自行扩大范围。
