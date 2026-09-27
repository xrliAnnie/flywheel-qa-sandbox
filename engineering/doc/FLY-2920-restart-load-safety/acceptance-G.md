# FLY-2920 恢复节点与进度保护 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

## 当前状态

G 已在代码头 `5ccb661f4` 完成本地相关验证；生产实现来自恢复提交
`9b84697f1`，真实持久 workflow fixture 的最终修正在 `5ccb661f4`。这是实现节点的
相关测试证据，不是 full CI、QA、生产或 ship 证明。

## 实施结果

- `assertWorkflowResumeAuthority` 对 engine-owned 恢复逐项校验 active run、当前
  run/node/attempt/execution、activation、无更高 attempt、持久 snapshot 中的节点角色；
  读取异常、损坏 snapshot、终态或身份冲突统一拒绝，不能退入 legacy fresh start。
- `createProgressResumeComputer` 在读 Git 前后及 dispatcher 进入 lifecycle admission 前复验
  同一身份；QA/no-ledger 早退也不能绕过绑定校验。相位来自当前持久节点 type，旧
  `session_stage` 只保留给人工 legacy start。
- 恢复内容仍从同一 local-first branch ref 的固定 SHA 读取，保留本地独有 commit、
  progress ledger、branch description；停止的 engine run 重启两次均零起体，人工授权
  legacy start 负控制仍可工作。
- 真实 StateStore 关闭/重开后，已证实死亡的旧 execution 由 engine 产生一个新绑定；
  同一 reconcile 后续不重复 dispatch。合法 generic 与 QA 节点仍保留原行为。

## 已确认的调用边界

- `progress-resume.ts:computeProgressResume` 目前从 prior session 的 `session_stage` 推导 phase，再与 ledger 比对。`run-infra.ts` 的真实 resumeComputer 传入该旧值；`RunDispatcher.ResumeComputer` 目前只有 issue/role/project 三个参数，缺少当前 engine execution 绑定。
- `workflow_run_node` 保存 run/node/attempt/execution，但没有 phase 字段。phase 必须结合持久 run snapshot 中对应节点的 type 解析，不能假设 node ID 就是 phase，不能只相信调用者 role。
- 当前 engine 会把合法的非 phase node 映射为 role `main`；不能把缺失/未知绑定的拒绝扩大为拒绝所有合法 generic node。QA 的旧“不读 ledger”早退也不能绕过当前 engine 绑定校验。实现应保留这些既有入口语义，以真实调用链控制测试确认。
- 旧 session 可以是被替换的 execution；新请求的当前绑定和被恢复的历史内容来源是两件事。停止/取消由现有 run/node terminal receipt 判定，不能把所有 terminated prior session 都当作禁止人工重试。
- `computeProgressResumeAcrossRefs` 已优先 local ref，并先解析一次 commit，再用同一 SHA 读取目录、文件和 tip。该保护以及 branch description/未推提交必须保留。
- `rescue-runtime.ts:makeCloseAndDispatchSuccessor` 是现有登录失效救援：读取 engine ownership 失败或确属 engine-owned 均在破坏性步骤前拒绝；只有 running session 才能 terminate/close/start。批准计划明确保留这一功能，不能用删除它代替证明历史 boot fallback 已不可达。

## 可执行证据

消费者发现记录见 `consumers-G.json`：42 个 query 得到 128 个测试命中，保留 17 个
具体文件、逐项排除 111 个并保存原因。Lead 明确禁止覆盖整张 teamlead 图的
`vitest related`，因此没有运行该命令；17 个保留文件均逐个执行。

- `progress-resume-workflow.test.ts`: 8/8，真实临时 Git + StateStore + engine，覆盖
  stale phase、停止/重启、DB reopen/dead replacement、generic/QA、坏绑定、await 后终态。
- `progress-resume.test.ts`: 13/13；`run-dispatcher-resume.test.ts`: 15/15。
- 其余 13 个 Vitest 文件 396/396：`bridge-child-process-census`、`rescue-runtime`、
  `run-dispatcher`、`runs-route-generalized-pending`、`workflow-engine-dispatcher`、
  `fly1560-teardown-guard`、两个 dispatcher seam、pre-registration、prebound、
  `run-infra-continuity`、`runs-route.dag-entry`、`workflow-engine.fly2302-dead-body-commdb`。
- `scripts/__tests__/runtime-role-auto-qa-retirement.test.sh`: PASS。
- 合计 16 个 Vitest 文件 432/432，另 1 个 shell guard；每条命令均带一个具体文件，
  `--maxWorkers=1 --minWorkers=1`。

组合 fixture 驱动真实 boot/recovery 调用链；字符串“不包含 produce”和消费者 sweep
只作范围证据，不替代上述持久库、真实 Git 本地独有提交与 engine 负控制。
