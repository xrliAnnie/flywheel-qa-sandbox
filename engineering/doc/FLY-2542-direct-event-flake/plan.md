# FLY-2542 DirectEventSink 时序隔离 — 实施计划
Issue: FLY-2542 (https://linear.app/geoforge3d/issue/FLY-2542/flake-directeventsinktestts1605-在-ci-teamlead-shard-3-间歇红9-14)
日期: 2026-09-14
基于: research.md

1. 在临时副本中延迟 Vitest callFunctionMock 750ms，跨 timeout/tail 用例边界重现共享 importer callstack 的重叠；真实 SDK directRequest 直接 throw，禁止网络。保留原始 tail 断言。红侧必须出现原来的 updateIssue 0 次，绿侧使用相同实验只加修复。详见 research.md 的可执行复现步骤。
2. 已实测 dynamicImportSettled() 仍红；使用标准库 Promise 信号，在 SDK issue mock 开始挂起时 resolve，await 信号后才推进 fake timer。该可观测执行点证明动态导入已完成，且不会增加轮询超时。只动原 timeout 测试夹具，不改 tail 断言、生产逻辑、依赖或配置。设计门 f72018c1-0257-4ca4-840f-e1a77dfd3128 APPROVED；机制细化符合 semantic-settle advisory。
3. 跑整文件及目标相邻用例连续 20 次并保存命令、计数；调查 run 34800774965 attempt 1 的 onTaskUpdate RPC timeout 与分片负载证据，分别报告，不凭相关性宣称同因。
4. 执行 pnpm lint、pnpm -r build、pnpm test:packages:run --exclude '**/tmux-viewer.macos.test.ts'（按设计评审避开真实 Terminal.app；单包顺序、Vitest worker 上限 2）；新 shell 测试如有逐个执行。失败保留并经 Lead 决定，不将聚焦绿冒充全仓绿。
5. 完成 progress 和 engineering/doc/milestones/FLY-2542.md，最后提交包含里程碑；同推代码与台账后注册精确头代码评审，开 PR，相关分片连续两次绿。review 后不推文档，新增代码修改须重新评审。通过报告及 complete --route needs_review --pr NUMBER 交接，然后 park，不派 QA、不 merge。
