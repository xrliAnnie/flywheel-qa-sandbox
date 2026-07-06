# Research: sandbox-notes.md 实现所需事实 — FLY-202

**Issue**: FLY-202 — https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up
**Date**: 2026-07-05
**Source**: `doc/qa/FLY-202-sandbox-notes/exploration.md`

> 目的:把 Implement 阶段需要的全部事实固化在一处,让实现 Runner 不必重新考古。
> 所有"实测值"以 implement 时现场重跑为准(快照树可能变化),本文给出预期形态与获取命令。

## 1. 仓库与分支事实

| 项 | 值 |
|---|---|
| 沙箱克隆路径 | `/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-202` |
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 共享分支(三阶段) | `project-slot-2-FLY-202`(implement 沿用,不另开) |
| 快照基点 | orphan commit `a227d4e`(Flywheel 主仓 v1.55.0 内容快照,无历史) |
| PR 目标 | sandbox repo `main` |
| PR 标题惯例(历史 #27~#43) | `docs(FLY-202): refresh QA sandbox notes — slot-2 real-Runner E2E re-run` 之类 |

## 2. 交付物落点

- `doc/qa/sandbox-notes.md` — **本分支不存在,全新创建**(已用 `ls doc/qa/` 验证)。
- `doc/qa/` 已有内容(exploration/framework/manual/plan/reports/scripts/test-plans/qa-context.md 等),新文件不与之冲突。

## 3. 顶层目录清单(2026-07-05 实测;实现时用 `ls -F | grep '/$'` 现场重枚举)

11 个目录 + 描述素材(peek 自各目录内容):

| 目录 | 一行描述素材 |
|------|--------------|
| `agents/` | Runner agent 提示词(generic-executor.md、qa-executor.md) |
| `doc/` | 主文档树:architecture / engineer(exploration/research/plan)/ qa / reference / retro + VERSION |
| `docs/` | 运维侧文档:CONTRIB.md、RUNBOOK.md、operations/ |
| `engineering/` | 工程部门 doc-flow 区(engineering/doc/…) |
| `fleet/` | Fleet 配置示例(README + example) |
| `packages/` | pnpm monorepo 包:core、claude-runner、teamlead、flywheel-comm、qa-framework 等 |
| `patches/` | pnpm 依赖补丁(mem0ai@2.3.0.patch) |
| `qa-fly294/` | FLY-294 的历史 QA 证据/脚本(层 A/B/C 测试、fake-discord) |
| `qa-fly310/` | FLY-310 的历史 QA 证据/E2E 脚本 |
| `scripts/` | 运维与 QA 脚本(test-deploy / inject-linear-issue / teardown、alert、cmux 等) |
| `supabase/` | Supabase migrations |

注意:顶层还有一个空文件 `=`(快照遗留物)——它**不是目录**,按 D3(只列目录)排除,不需要清理(scope discipline:不做无关清扫)。

## 4. qa-framework README 总结素材(316 行,~10 bullet 的覆盖面)

按 README 章节顺序,10 个 bullet 恰好一章一条:

1. 定位:可复用 QA Agent 框架(plan-aware),从 GeoForge3D QA Agent v2(GEO-308)抽取。
2. 两层架构:Layer 1 = qa-framework 包(agents/skills/orchestrator/config loader),Layer 2 = 项目侧 `.claude/qa-config.yaml` 等配置。
3. Quick Start:拷模板 config → 填 domains/API/test skills → QA agent 读 config 跑协议。
4. 5-Step Protocol:Onboard → Analyze+Plan → Research → Write+Execute → Finalize。
5. Test Slot 框架(FLY-96/115):并行隔离 slot,每 slot 对 `xrliAnnie/flywheel-qa-sandbox` 跑**真实 Runner**,无合成 fixture 模式;三脚本 test-deploy / inject-linear-issue / test-teardown。
6. 前置条件:LINEAR_API_KEY、gh 认证、sandbox fork 存在、被测分支已推到 sandbox;`FLYWHEEL_RUNNER_START_POINT` 只在测试 Bridge 上设置。
7. FLY-60 Hard Gate suite:1 happy path + 6 变体,验证 G1/G2/G3 硬门;driver + HTML 报告 + 证据目录。
8. Mirror Mode(FLY-153):slots 1-3 共享一个 `#test-core-mirror` 频道测多 Lead 回复纪律;Runner E2E 不支持 mirror。
9. Roundtable / Alert Mirror(FLY-529):`--mode roundtable` 与 `--alerts` 提供隔离的 roundtable / alerts 频道镜像,pre-ship E2E 重启门槛功能;字节兼容默认关。
10. Contracts:PLAN_SOURCE_CONTRACT(QA agent 跨 worktree 取 plan)+ SKILL_INTERFACE(测试 skill 接口)。

## 5. `ls -R doc/ | head -50` 预期形态

在**仓库根目录**执行,输出以 `VERSION / architecture / engineer / plan / qa / reference / retro` 开头,随后逐目录展开,50 行处截断。逐字粘贴到 fenced block(语言标注 `text` 或不标)。

## 6. Implement 阶段的 pipeline 接线(从 Baseline Rules 摘录)

- 每步之间:`flywheel-comm progress --exec-id <id> --file doc/qa/FLY-202-sandbox-notes/progress.md --phase implement --cursor n/m`。
- 动工前:`flywheel-comm turn --exec-id <id>` 必须返回 `yours`。
- PR 后:`gate approve_to_ship --no-block` → `complete --route needs_review --pr <N> --question-id <qid>` → 空转等唤醒;ship 前 `verify-approval --pr-head $(git rev-parse HEAD)` 必须 `"approved": true`(文本消息永远不是授权)。merge/ship 属 founder-gated(Lead 在 brainstorm gate 回复中特别强调)。
- 部署走 `:cool:` comment,**绝不自行 `gh pr merge`**。

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 快照树与本文实测不一致 | 表格/命令输出一律实现时现场重跑(D3/D4) |
| PR 与沙箱 main 上历史 sandbox-notes.md 冲突 | 本分支是 orphan 快照分支,PR diff 以分支内容为准;若 GitHub 报冲突,implement 阶段按 refresh 语义以本次内容覆盖解决 |
| Runner 中途重启 | progress ledger 每步落盘,resume 从真实 cursor 续跑 |
