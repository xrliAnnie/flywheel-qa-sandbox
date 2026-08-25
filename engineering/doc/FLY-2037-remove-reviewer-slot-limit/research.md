# FLY-2037 reviewer 调度边界 — 调研
Issue: FLY-2037 (https://linear.app/geoforge3d/issue/FLY-2037/bridgereview-去掉全局-reviewer-slot-上限founder-直令废-reviewrequestcoordinator)
日期: 2026-08-24
基于: exploration.md

## 1. 结论

固定并发 2 是 `ReviewRequestCoordinator` 内部的一层独立 semaphore，不是 review 协议或同 execution 顺序语义的一部分。最小且完整的改动是净删除这层 semaphore，让 `execChains` 中每个 execution 的 chain 直接执行 `runJob()`。

## 2. 代码审计

### 2.1 全局 slot 的完整边界

文件：`packages/teamlead/src/bridge/review-request-coordinator.ts`

| 位置 | 当前职责 | 本单处置 |
|---|---|---|
| 文件头 `Scheduling` 注释 | 宣称 per-execution 串行 + global concurrency 2 | 改为只保留 per-execution 串行与 boot redrive |
| `ReviewCoordinatorDeps.maxConcurrent?` | 测试/构造 seam | 删除；不留配置能力 |
| `maxConcurrent` / `active` / `waiters` | 全局 slot 状态 | 删除 |
| 构造器 `deps.maxConcurrent ?? 2` | 固定默认上限 | 删除 |
| `stop()` waiter drain | 唤醒全局等待者以便 shutdown | 删除；保留 `stopped = true` |
| `enqueue()` acquire/release | 在 per-exec chain 内再套全局 slot | 删除；保留 chain、stopped check、异常 fail-close |
| `acquireSlot()` / `releaseSlot()` | 全局 FIFO semaphore | 删除 |

`plugin.ts` 的生产构造没有传 `maxConcurrent`。所以现网语义不是可配置 2，而是默认值固定为 2；删除 seam 不涉及 config schema、env、route 或持久化迁移。

### 2.2 必须保留的正确性语义

`enqueue(requestId, executionId)` 先读取 `execChains.get(executionId)`，再用 `chain.then(...)` 把新 job 接在同 execution 尾部。不同 execution 使用不同 Promise chain；因此删除全局 semaphore 后：

- 相同 execution：继续串行；
- 不同 execution：chain 互不等待，可立即并发；
- 重复 requestId：仍由 StateStore claim/idempotency 阻止重复运行；
- stop 后尚未开始的 chain：进入 callback 时先检查 `stopped` 并退出；
- runJob 抛错：仍落 `internal_error`，store 不可用时仍由 boot redrive 恢复。

这些语义不依赖 `active` 或 `waiters`。

### 2.3 与验收相关但不改的路径

- `accept()`：gate 绑定、author family、可信 worktree/head、codex-skip、durable insert 不改。
- `runJob()`：reviewer invocation、timeout、head/gate 复核、fail-close、authority commit 不改。
- `deliverStoredResponse()`：outbox 与 foreign-answer 保护不改。
- `redriveOnBoot()`：running→pending reset 与逐 job enqueue 不改；同 execution 仍经同一 chain。
- `plugin.ts`：构造 wiring 不改，只同步 §7.1 注释说明。

## 3. 历史来源

`git blame` 显示全局 slot 与 per-execution chain 同在 FLY-1188 初始实现 `53364ac097` 引入。原 `engineering/doc/FLY-1188-codex-runner-first-class/plan.md` §7.1/风险表把“全局并发 2”与“execId 串行”并列；后续 FLY-1278 调研也只是记录该现状，没有为固定数字 2 增加新的正确性依赖。

本单是 Founder 对其中吞吐限制的显式新裁决：撤销全局限制，但不撤销同 execution 的顺序语义和 fail-close 协议。

## 4. 测试差距与 TDD 设计

现有 slot 专属测试用 `maxConcurrent: 1` 证明 `stop()` 会排空 waiter。删除全局 slot 后该测试的前提消失，应删除或改写，不能保留一个仅为旧机制存在的 seam。

先新增两条行为测试并在旧实现上得到 RED：

1. **不同 execution 无全局闸**：注册 3 个 execution，三个 reviewer round 都用 deferred promise 阻塞；接受三个 request 后，断言三个 round 全部已开始。旧实现只能开始 2 个，测试应 RED。
2. **同 execution 仍串行**：同 execution 接受两个 design request；第一个阻塞时断言第二个未开始，释放第一个后断言第二个开始。该测试保护本单明确不能删除的语义。

实现后删除 slot waiter shutdown 测试，并保留/补足 stop 对未开始 per-execution chain 的覆盖（可与串行测试合并，避免重复 fixture）。

## 5. 风险判断

| 风险 | 控制 |
|---|---|
| 误删 per-execution chain，导致同 execution review session/round 竞态 | 独立串行测试；实现只删 semaphore 层 |
| stop 后 chain 继续启动新 reviewer | 保留 chain callback 首行 `stopped` check，并保留测试 |
| boot redrive 多 job 并发改变同 execution 顺序 | `redriveOnBoot()` 仍逐项调用同一个 `enqueue()`；串行测试覆盖共同调度原语 |
| 资源/429 | 不在本单掩盖；review failure 原有 fail-close + same requestId retry 保持 |

## 6. 会过期的结论

| 结论 | as-of | 重核方式 |
|---|---|---|
| slot 状态完整位于 coordinator 单文件 | 2026-08-24 `88c3df6b9` | `rg -n "maxConcurrent|active|waiters|acquireSlot|releaseSlot" packages/teamlead/src/bridge/review-request-coordinator.ts` |
| 生产构造没有传并发参数 | 2026-08-24 `88c3df6b9` | 阅读 `packages/teamlead/src/bridge/plugin.ts` 中 `new ReviewRequestCoordinator` |
| 现有测试没有“3 个独立 execution 同时开始”的正向验收 | 2026-08-24 `88c3df6b9` | `rg -n "serial|concurr|slot|started" packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts` |
| FLY-1188 原计划同时规定全局 2 与 per-exec 串行 | 2026-08-24 | 阅读 `engineering/doc/FLY-1188-codex-runner-first-class/plan.md` §7.1 |
