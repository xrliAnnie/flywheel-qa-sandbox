# FLY-2920 恢复节点与进度保护 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

## 当前状态

G 尚未实现。此页记录按已批准计划进行的只读核对，不是测试通过、QA 或交卷收据。F 完成后才修改 G 源码。

## 已确认的调用边界

- `progress-resume.ts:computeProgressResume` 目前从 prior session 的 `session_stage` 推导 phase，再与 ledger 比对。`run-infra.ts` 的真实 resumeComputer 传入该旧值；`RunDispatcher.ResumeComputer` 目前只有 issue/role/project 三个参数，缺少当前 engine execution 绑定。
- `workflow_run_node` 保存 run/node/attempt/execution，但没有 phase 字段。phase 必须结合持久 run snapshot 中对应节点的 type 解析，不能假设 node ID 就是 phase，不能只相信调用者 role。
- 旧 session 可以是被替换的 execution；新请求的当前绑定和被恢复的历史内容来源是两件事。停止/取消由现有 run/node terminal receipt 判定，不能把所有 terminated prior session 都当作禁止人工重试。
- `computeProgressResumeAcrossRefs` 已优先 local ref，并先解析一次 commit，再用同一 SHA 读取目录、文件和 tip。该保护以及 branch description/未推提交必须保留。
- `rescue-runtime.ts:makeCloseAndDispatchSuccessor` 是现有登录失效救援：读取 engine ownership 失败或确属 engine-owned 均在破坏性步骤前拒绝；只有 running session 才能 terminate/close/start。批准计划明确保留这一功能，不能用删除它代替证明历史 boot fallback 已不可达。

## 待补的可执行证据

1. 真实持久 workflow run/node/snapshot 绑定与恢复入口联动，覆盖 stopped session、stale session stage、领先 ledger、本地独有 commit；恢复相位由当前有效节点决定，内容仍取原 branch tip。
2. 缺节点、执行绑定冲突、未知读取和 terminal run/node 均有明确拒绝；不退入 legacy fresh/produce，不产生无绑定 successor。
3. 人工授权 start/retry 的负控制仍能工作；既有登录救援、local-first、同 ref pin、description 与未推提交保护保留。
4. 精确 sweep `makeCloseAndDispatchSuccessor`、`startSuccessor`、`session_stage` 的生产消费者，逐项区分显示/人工路径与自动恢复权威；消费者选集列出每个排除原因，并补 changed-TypeScript related 检查。

组合 fixture 必须驱动真实 boot/recovery 调用链；纯字符串“不包含 produce”或仅 mocked git 的单元测试不作为完整验收。
