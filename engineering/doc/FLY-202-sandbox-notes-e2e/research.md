# FLY-202 QA 沙箱 fixture 说明刷新 — 调研
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: exploration.md

## 1. 仓库与分支事实

| 项目 | 当前证据 |
| --- | --- |
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 当前分支 | `project-slot-6-FLY-202` |
| base | `origin/main` at `1855f7a1a`（review round 1 复核） |
| divergence | review round 1 时 ahead 8、behind 0；均为本 issue design/progress commits |
| 远端同名分支 | 已存在，指向 `341728fdd`（当时本地 HEAD） |
| 同 head 的历史 PR | `gh pr list` 返回空数组 |
| 并行同 issue PR | sandbox PR #203 open，head=`project-slot-3-FLY-202`，也修改 `doc/qa/sandbox-notes.md` |

因此 implement 节点不应重锚、rebase 或 force-push。它应先 fetch；若 `origin/main` 已前进，用普通 merge 同步后再生成快照。之后在同一 feature branch 上追加 docs commit，普通 fast-forward `git push`，然后对 sandbox `main` 开 PR。

## 2. 目标文件与消费者

`doc/qa/sandbox-notes.md` 已存在，共 99 行、6628 bytes；Git 历史显示它是 FLY-202 多次真实 Runner E2E 的稳定刷新目标。当前内容已有 3 段用途说明、17 行目录表、10 条 README 摘要和 fenced tree 输出。

`git grep -F sandbox-notes.md` 未发现运行时代码读取该文件；引用只出现在旧 FLY-202 设计资料中。因此它的消费者是 QA 操作者和 PR reviewer，而不是解析器。没有 schema migration、数据库迁移或兼容层；唯一稳定身份是路径本身。

当前 tree block 已过期：它列出已删除的 `doc/FLY-202-generalized-e2e`，且未列出当前存在的 `doc/FLY-145-s6-retry-product-test`。这提供了本轮真实、可审查的 diff，支持“原位刷新”而非无变化提交。

## 3. 顶层目录事实

现场命令 `git ls-tree -d --name-only HEAD | LC_ALL=C sort` 得到 17 个已跟踪顶层目录：

| 目录 | 一行职责描述的事实来源 |
| --- | --- |
| `.claude/` | QA config、commands、skills 与 orchestrator 辅助文件 |
| `.flywheel/` | sandbox Flywheel config 与 executor role 文件 |
| `.github/` | GitHub Actions workflows |
| `.lead/` | 各 Lead 身份与共享规则 |
| `.serena/` | Serena 项目配置与本地元数据 |
| `agents/` | 通用与 QA Runner executor prompts |
| `doc/` | 架构、工程、QA、计划、参考与复盘文档 |
| `docs/` | 贡献说明、运维 runbook 与 operations 文档 |
| `engineering/` | doc-flow 工程文档与 spikes |
| `fleet/` | fleet 示例和说明 |
| `packages/` | pnpm monorepo packages |
| `patches/` | 版本化依赖补丁 |
| `product/` | doc-flow 产品文档 |
| `qa-fly294/` | FLY-294 QA scripts、fixtures 与报告 |
| `qa-fly310/` | FLY-310 E2E scripts、evidence 与报告 |
| `scripts/` | 开发、部署、维护与 QA 自动化 |
| `supabase/` | Supabase metadata 与 migrations |

隐藏目录也属于“every top-level directory”，所以不能用只显示非隐藏项的裸 `ls` 生成表格。Git tree 查询会自然排除 `.git/`、`node_modules/`、`dist/` 与其它未跟踪工具产物。implement 节点仍需在写入前重跑发现命令，以当前 HEAD 为准。

## 4. README 摘要范围

`packages/qa-framework/README.md` 当前为 316 行、16485 bytes。约 10 条摘要应覆盖：

1. 可复用、plan-aware 的 QA agent framework 定位。
2. framework 与 project config 的两层架构。
3. Quick Start 的 config / suite 接入流程。
4. Onboard → Analyze + Plan → Research → Write + Execute → Finalize 五步协议。
5. test-slot 用真实 Runner 跑 sandbox、没有 synthetic mode。
6. `test-deploy.sh`、`inject-linear-issue.sh`、`test-teardown.sh` 三个入口。
7. Linear key、GitHub auth、sandbox repo 与 branch 的前置条件。
8. `FLYWHEEL_RUNNER_START_POINT` 只在 slot Bridge 生效的隔离边界。
9. FLY-60 hard-gate suite，以及 mirror / roundtable / alert mirror 的用途和 Runner E2E 限制。
10. plan discovery 与 QA skill interface 两份 contracts。

摘要必须转述，不应大段复制 README；显示标签可以简化，但脚本名、环境变量名和模式边界必须准确。

## 5. 命令输出与顺序

issue 指定的命令是 `ls -R doc/ | head -50`。实测表明它随 locale 改变：`LC_ALL=C` 从 `FLY-145-s6-retry-product-test` 开始，而 `LC_ALL=en_US.UTF-8` 从 `architecture` 开始，前 50 行因此覆盖不同子树。implement 节点应在所有目标文档内容写完后用 `LC_ALL=C ls -R doc/ | head -50` 固定排序，把 stdout 原样放入 `text` fenced block，同时记录原命令与 locale；最终验证和 QA 必须使用同一 locale 逐字比较。

由于设计文档位于 `engineering/doc/` 而非 `doc/`，本设计阶段新增文件不会改变该命令输出。后续若其他节点同时改变 `doc/`，应以目标文件最后写入时的同一 worktree 快照为准。

## 6. 安全与验证边界

- 内容是纯 Markdown，不渲染用户输入，也没有 SQL 或外部输入边界；HTML escaping / parameterized queries 不适用目标文件。
- founder HTML 的两次本地 `mmdc` 渲染均因 sandbox 禁止 Chromium macOS rendezvous port 而失败；按合同保留 Mermaid 源并显示 `DIAGRAM PENDING LOCAL RENDER`，未使用远程渲染或 CSS 假图。运行时评论只通过 `textContent` / `value` 写入，避免 derived data 进入 `innerHTML` 或 script。
- 本任务不需要运行 package 或 repository test suite。验证应使用具体的 shell assertions、`git diff --check`、集合比对、bullet 计数、tree block 比对和 `gh pr view`。
- 最终 diff 允许本 issue 的 design artifacts、progress ledger 与目标 notes；不允许生产代码、config 或无关文档改动。
