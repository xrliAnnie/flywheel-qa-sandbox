# FLY-1425 qa-result fail-loud 收敛 — 设计修正

Issue: FLY-1425 (https://linear.app/geoforge3d/issue/FLY-1425/enginebug2-qa-result-凭据缺失静默回退-events-假成功-fail-loud-引擎层未消费看门狗)
日期: 2026-07-22
基于: plan.md

## Founder 拍板

> 「我不希望我们加越来越多的看门狗…如果我们要有一个看门狗的话,它需要是一个generic的看门狗,不能说发现了问题一就出一个问题一的看门狗…我希望有一个generic的看门狗solution…而不是来一个打一个,跟打地鼠一样。」

> 「如果fail load已经足够修这个问题,只是没有办法达到100%的话,我建议把Watchdog这一层还是剥掉,不要增加这里的复杂度。」

## 修正结论

本文件取代 `plan.md` 中所有「引擎层 qa 未消费看门狗」的交付决策。历史探索、调研和原计划保留为决策过程记录；若与本文件冲突，以本文件为准。

### 废除概念

废除 FLY-1425 专用的引擎层 qa 未消费看门狗整层，包括：

- `WorkflowEngineDispatcher.reconcileStalledDecisions()` 及其扫描游标、时间窗口、runner parked/terminal 判定和 owning Lead 告警；
- `qaDecisionWatchdogEnabled`、`FLYWHEEL_QA_DECISION_WATCHDOG` 与 `FLYWHEEL_QA_DECISION_STALL_SOFT_MS`；
- stalled-decision 的 StateStore 候选查询、告警 disposition、dedupe helper；
- 为该看门狗抽取的 runner declared-state tri-state helper；
- watchdog 专属单元测试、集成测试、真机 E2E 场景与脚本部分。

### 保留器官

FLY-1425 只保留以下 fail-loud 闭环：

1. **fail-loud**：engine-owned runner 明确预期 workflow submission credential 时，若 `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL` 缺失，`qa-result` 在发出网络请求前明确报错并非零退出；服务端 `/events` 对 engine-owned `qa_result` 再做权威拒收，禁止 200 假成功。
2. **幂等存储**：保留 `/api/workflow/decision` 的 credential 消费、幂等 receipt 与节点推进合同；保留 legacy/shadow 合法 `/events` 路径原有幂等存储，不引入新的 watchdog outbox episode。
3. **日志诚实**：只有服务端确认 credential 已消费且返回完整 decision ack 后，才打印 `decision consumed`；legacy/shadow `/events` 成功只打印 event 已存储且明确说明它不是 DAG decision。
4. **prompt 与 sentinel plumbing**：保留 engine-owned 车道的 `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1` 注入，以及禁止剥 credential、遇到 replay mismatch 停止重试并报告 Lead 的提示。

### 缺口去向

剥掉专用看门狗后，极端情形「runner 死了没交账」不在 FLY-1425 继续加局部检测。该缺口统一归入 **FLY-1386 generic 不变量框架**：由 generic watchdog/invariant solution 表达「workflow 节点声称运行、执行生命周期已结束、但终态事实未入账」这一跨节点不变量，而不是为 qa-result 再造一只问题专用看门狗。

## 修正后的验收边界

- 剥掉 credential、保留 engine-owned sentinel 运行 `qa-result`：明确错误、非零退出、零网络请求。
- 即使 sentinel 也被误剥，engine-owned `qa_result` 投到 `/events`：服务端返回 `workflow_submission_required`，事件不落库、credential 不消费、DAG 不推进。
- 真正消费 credential 并推进节点后才出现 `decision consumed`；legacy/shadow event 成功日志不得声称 DAG 已推进。
- PR 中不存在 FLY-1425 专用 stalled-decision watchdog 的代码、flag、测试或 E2E 逻辑。
