# Design: QA 沙箱夹具任务 — FLY-202

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
https://linear.app/studio/issue/FLY-202
**Date**: 2026-08-10
**Status**: Active (repeatable fixture refresh)
**Node**: sandbox real-Runner E2E execution

## 1. 一句话总结

给 QA slot harness 一个**真实存在、PreHydrator 可拉取**的 Linear issue(FLY-202 本身),
其任务是一个小而稳的 5 步文档作业(产出 `doc/qa/sandbox-notes.md` + PR),
让真 Runner E2E 测试有可注入的靶子和足够长的 mid-work 观察窗口。

## 2. 背景与目的

- FLY-115/FLY-96 的 test-slot 框架("no synthetic mode")用 `scripts/inject-linear-issue.sh <N> <FLY-XXX>`
  直接 POST `/api/runs/start` 给 slot Bridge,PreHydrator 需要一个**真的** Linear issue 才能水合任务上下文。
- FLY-197 发现文档里引用的 `FLY-SBX-1` 并不存在——本 issue 就是补这个缺口的**常驻夹具(fixture)**。
- 任务刻意设计成"多步、慢速、零风险":每一步产出可独立验证,步与步之间给 QA 留出
  观察 Runner mid-work 状态的窗口(idle watchdog、gate、心跳等场景都需要这种窗口)。
- 该 fixture 会被 sandbox slot 重复注入;当前 baseline 已包含上一轮
  `doc/qa/sandbox-notes.md`,所以每次 run 都应按**当前仓库快照原位刷新**同一文件,
  既产生可 review 的真实 diff,又不累积按 run 命名的垃圾文件。

## 3. 实现设计(implement 节点的合同)

### 3.1 Runner 任务 5 步(照 issue 原文,不加戏)

| 步 | 动作 | 产出/验证点 |
|----|------|-------------|
| 1 | 创建 `doc/qa/sandbox-notes.md`,写 2-3 段说明 flywheel-qa-sandbox 仓库用途 | 文件存在,§1 有 2-3 段 |
| 2 | 追加顶层目录表:仓库根每个目录一行描述 | §2 表格行数 = 根目录数 |
| 3 | 追加 `packages/qa-framework/README.md` 摘要,约 10 条 bullet | §3 有 ~10 条 |
| 4 | 运行 `ls -R doc/ \| head -50`,输出贴进 fenced 代码块 | §4 有 fenced block,内容为实时输出 |
| 5 | commit 到 feature 分支,对 sandbox main 开 PR | PR 存在,base=main,只含本文档 |

### 3.2 内容要点(implement 时以实时仓库快照为准)

- **§2 目录表**(当前快照草稿,implement 时须重新 `ls` 核对):
  `agents/`(Runner 角色提示词)· `doc/`(工程/QA/架构文档区)· `docs/`(贡献与运维手册)·
  `engineering/`(doc-flow 工程部门区)· `fleet/`(fleet 配置示例)· `packages/`(pnpm monorepo 源码)·
  `patches/`(pnpm 补丁)· `product/`(doc-flow 产品部门区)· `qa-fly294/`、`qa-fly310/`(历史 QA 证据)·
  `scripts/`(控制面 shell 脚本)· `supabase/`(数据库 migration)。
- **§3 README 摘要**覆盖:框架定位(可复用 QA agent 框架)、两层架构(framework ↔ 项目 config)、
  5-Step QA Protocol、test-slot 真 Runner E2E(deploy/inject/teardown 三脚本)、
  `FLYWHEEL_RUNNER_START_POINT`、FLY-60 hard-gate 套件、mirror / roundtable / alerts 三种镜像模式、contracts。
- **§4** 的 `ls -R` 输出必须是 run 时真实执行结果,不许手工编造。

### 3.3 分支与 PR

- 分支:slot 预建分支 `project-slot-2-FLY-202`(与 main 齐平),push 后对
  `xrliAnnie/flywheel-qa-sandbox` main 开 PR。
- PR 内容**只允许**本 issue 文档(`doc/qa/sandbox-notes.md` + 本 issue 文件夹),
  零生产代码改动 — 顺手修代码违反 Lead guardrail(见 memory: qa-sandbox-smoke-conventions)。
- merge 是 founder-gated,不在 Runner 权限内;implement 节点走 approve gate,本 design 节点不碰。

## 4. 关键取舍与被否方案

| 决策 | 选择 | 被否方案 & 理由 |
|------|------|----------------|
| issue 形态 | 真 Linear issue(本 issue) | mock PreHydrator 响应 — 偏离真实链路,框架明确 "no synthetic mode";复用生产 issue — 污染生产看板 |
| 任务类型 | 纯文档 5 步 | 改代码任务 — 有生产风险且 CI 不稳;单步任务 — mid-work 窗口太短,QA 观察不到中间态 |
| 文档落点 | `doc/qa/sandbox-notes.md` | 仓库根 — 与现有 QA 文档区(doc/qa/)割裂;每次 run 新文件名 — 破坏幂等,垃圾堆积 |
| 幂等策略 | 同名文件按当前快照原位刷新 | 删除后原样重建 — 没有有效 review 信号;每次新增 run-stamped 文件 — 垃圾累积且破坏稳定路径 |

## 5. 诚实边界

**本设计做到**:
- 定义 implement 节点的完整合同(5 步 + 内容要点 + 分支/PR 约束)。
- 保证任务零生产影响:全程只碰 sandbox clone,只产出 Markdown。

**本设计不做**:
- 不验证 Discord 推送/merge 流程(merge 为 founder-gated,属 harness 观察面而非本任务)。
- 不保证 §2 目录表长期准确 — 内容以每次 run 的 tracked 顶层目录快照为准,baseline 变了表就变。
- 不供生产 Lead/Runner 使用:issue 标题已标 "do not pick up",本 fixture 仅限 test-slot 注入。
- 设计交付不等 founder review(节点合同);后续 founder 意见由当时 TURN 持有者以
  design-correction.md 增量修正。
