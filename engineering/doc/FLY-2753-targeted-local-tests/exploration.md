# FLY-2753 本机定向验证 — 探索
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: 无

## 目标

让执行代理本机只做全仓 lint（静态格式/代码检查）、受影响包的构建/类型检查以及直接相关测试。全量 = exact-head CI（远端对本次最终提交运行的完整检查）。任何当前提交的 CI 任务失败仍须处理；本单自己的 PR 同样遵守。

## R1 调研纠正：以实际路由决定变更面

当前授权工作树为 `flywheel-qa-sandbox`、分支 `project-slot-1-FLY-2753`、起点 `1855f7a1a`。`.flywheel/config.yaml` 的 engineer、qa、general 分别路由：

- `.flywheel/agents/engineering/engineer-executor.md`
- `.flywheel/agents/engineering/qa-executor.md`
- `.flywheel/agents/general-executor.md`

这些是当前生效入口，首版把它们称为“旧的角色”是错误的。题目中的 nodes 路径与同步器在本仓不存在，不能把这个差异变成完全不修改生效规则的理由。实施可以在本授权分支修改上述入口及直接矛盾的 QA helper 推荐。不得跳到另一个工作树写入。

可读生产源 `/Users/xiaorongli/Dev/flywheel-FLY-2753`（观察 HEAD `3d67d8350`）使用 `.flywheel/agents/nodes/{implement,qa,engineer}.md`，且已有提交 `180bdaa3e`。生产路径是另一个部署目标，不能据其结果声称本分支已通过。原题要求的生产三份规则与同步器仍需在对应授权目标验证；当前 sandbox 无该机制，应报告不适用和未覆盖，不能伪造通过。

目标差异已向 Lead 提问 `70231531-d5e3-4be0-ba98-0b1eb23397ad`。无回复时以当前工作树真实路由执行设计，不等待一个不存在的文件；若 Lead 指定生产目标，仍须取得该目标 TURN 后按同一语义核验。

## 方案比较

| 方案 | 得失 | 选择 |
|---|---|---|
| 只改生效守则的验证条款与直接推荐入口 | 立即消除本机重复全量；需要准确选择测试并核对 CI | 采用 |
| 本机全量限流/排队 | 仍然重复计算，等待和额度问题没有解决 | 不采用 |
| 新建自动测试选择器、数据库或移植生产节点体系 | 引入新的运行时/迁移，与本单不相称 | 不采用 |

## 范围与负向守卫

测试选取覆盖 owning package（改动文件所在的包）的相关测试和直接消费者测试；接口变化检查依赖方；新增 shell 测试照跑。搜索只针对相关源码/测试目录和明确的导入路径，避免对全仓短文件名匹配逐项写排除文档。包名错误、缺脚本、零测试、未执行不得记绿。作者处理红灯，QA 报 FAIL 后交回作者。

不改 CI 任务、权限、审批、TURN、部署、数据库、全量测试工具或生产路径命名。helper 可保留给其他显式用途，但 runner 的本机完成门不得调用它。合入和部署仍分离，由独立 updater 在窗口部署。

## 重新派发的边界确认

2026-09-20 本轮从 `6b987d1b1` / PR #206 继续，当前配置仍路由 engineer、qa、general 三份 executor。实现已在保留分支上完成；本阶段只复核、更新设计交付，不改守则或实现。生产源只读 HEAD 仍为 `3d67d8350`，三份 nodes 具有定向规则；`packages/teamlead/package.json` 的 prebuild 保留同步 `--check`。生产同步器不在当前仓库，原题的生产验收仍是必需范围，不能因 sandbox 通过而豁免。新问题 `7889b4bc-48fa-48ae-99eb-e10bae2e7981` 请求 Lead 明确目标安排。
