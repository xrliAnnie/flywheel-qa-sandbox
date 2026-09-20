# FLY-2753 本机定向验证 — 探索
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: 无

## 目标与已授权范围

把每个 runner（执行任务的工程代理）在本机重复跑全仓包测试的要求，改成全仓 lint（静态格式与代码检查）、受影响包构建/类型检查、直接相关测试。全量包测试的通过证据只来自 exact-head CI（远端对本次最终提交运行的持续集成检查）。任一当前提交 CI job（独立检查任务）失败仍须处理。本单自己的 PR 也遵循此规则。

Founder 在 2026-09-19 04:03Z 同意的方向由注入 issue 提供。主机并发与耗时数字是问题陈述，设计阶段没有重新测量，不能把它当作本次性能基准。

## 现场事实与仓库边界

- 当前获授权工作树是 `flywheel-qa-sandbox`，起点 `1855f7a1a`，分支 `project-slot-1-FLY-2753`。TURN 为 design/epoch 1。
- 这个 sandbox 没有 `.flywheel/agents/nodes/`、`scripts/sync-phase-protocols.mjs` 或 `packages/teamlead/phase-protocols/`；只有旧的 `engineering/engineer-executor.md` / `qa-executor.md` 等角色。不能用不存在文件的 grep 零结果宣称成功。
- 可读生产源工作树 `/Users/xiaorongli/Dev/flywheel-FLY-2753` 的 HEAD 是 `3d67d8350`，已经有实现提交 `180bdaa3e`。本阶段只读审计，绝不在另一个工作树写入，也不把那里的实现当成当前分支成果。
- 真正三份目标是 `.flywheel/agents/nodes/{implement,qa,engineer}.md`，不是 `.flywheel/agents/engineer.md`。
- 目标环境问题已交给 Lead：`70231531-d5e3-4be0-ba98-0b1eb23397ad`。设计可继续，实施必须先取得含这些源文件的授权目标。不能为让检查通过而复制整套生产机制到 sandbox。

## 方案比较

| 方案 | 得失 | 结论 |
|---|---|---|
| 只改验证条款，保留现有 CI/阶段协议 | 小改动直接消除本机重复全量；需要仔细选定向测试 | 采用 |
| 把本机全量限流或串行化 | 仍是每具重复验证，耗时和额度问题未解决 | 不采用 |
| 增加新测试选择器/新回执数据库 | 自动化更强，但引入新运行时与迁移，超出本单 | 不采用 |

## 锁定设计

三份角色采用同一验证含义，分别保留实现与 QA 的职责：作者修复红灯，QA 报 FAIL 并交回作者。测试选择包括改动所在包内相关文件、直接依赖改动的消费者测试、所有新增 shell 测试；必须记录选择依据和排除理由。全仓 lint 保留，递归全仓 build 改为受影响包及必要依赖；接口/导出/类型变化还检查受影响消费者。

全量证据绑定 PR 的最终提交；已有 `CI Scope OK` 只是范围检查，不是完整测试证据。保留现有冻结提交后请求全量 CI 的所有权，不让每次代码评审修改都触发全量。日志、结果、提交标识都要可核查。

## 边界

只改验证相关条款及直接回归测试。不改 CI 任务集合、超时、测试运行器、回执工具本身、审批、TURN、部署、QA 产品验证要求或其他条款。没有数据库结构或稳定身份迁移；合入和部署分离，仍由独立 updater 在窗口部署。
