# FLY-2467 全包门可靠性 — 实施计划
Issue: FLY-2467 (https://linear.app/geoforge3d/issue/FLY-2467)
日期: 2026-09-14
基于: research.md

## 锁定范围
1. CI teamlead 四片，CI OK 覆盖所有矩阵成员；扩展矩阵守卫。若实际耗时仍超400s，在此范围内按文件耗时均衡。
2. teamlead/claude-runner 配置有界 forks（默认1，合法显式覆盖）与 teardownTimeout 60000；不改任何测试或hook timeout。
3. scripts 聚合入口替换 package.json 原命令。先 await pnpm -r build，失败则保存 build 收据并退出，绝不跑旧 dist。动态枚举 packages/* 中有 test:run 的包，串行执行原脚本，保留完整日志与结构化结果。
4. 仅当包 exit 1、完整文件/测试结果证实零失败且存在通过测试、所有 unhandled errors 精确为 [vitest-worker]: Timeout calling "onTaskUpdate" 才重试该包一次。缺失/损坏/不完整结果、其他错误、信号终止、断言或suite失败均 fail closed，不重试。重试仍仅该伪影时分类 artifact，原始非零退出码保留；聚合保留非零退出并提供等价门收据，不谎报普通绿色。任一真失败最终 exit 1；每包都运行，最多2次。
5. runner implement 模板及所有活跃同口径生产者/测试fixture同步：聚合绿 或（仅指定RPC伪影、零断言失败、逐包完整收据）；补验固定命令 VITEST_MAX_FORKS=1 pnpm --filter <pkg> exec vitest run，必须覆盖所有未达包，其他失败不能豁免，exact-head CI仍必需。不修改历史任务快照或当前运行中的homes。
## TDD与验证
先失败测试，再最小实现：四片枚举；CLI伪包 RPC→重试→下游执行+收据；连续RPC最多两次；真断言失败/其他异常/缺失报告/构建失败负对照；模板正反守卫。新 scripts/__tests__/*.test.mjs 必须在 ci.yml 字面列举。
全门 pnpm lint、pnpm -r build、pnpm test:packages:run、新shell测试。保留真实退出码。
## 交付
所有文档/台账/里程碑在最终推送一起完成，里程碑为最后commit；后续审查不推文档。开PR，注册review_code并轮询，阻断项修复后新审查。
精确最终头连续三次 CI 全绿，记录run id、attempt及四片测试步骤耗时，每片<400s；不满足则继续修复验证。PR正文记录指定三个run的改前/改后与近24h命中，运行结果放PR正文与外部收据而非评审后文档提交。
报告Lead，complete --route needs_review --pr NUMBER，park，交给DAG QA；不自行派QA或ship。
