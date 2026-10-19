# FLY-202 QA 沙箱 fixture 笔记 — 调研
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: exploration.md

---

以下事实在 2026-09-26 基于继承 implementation head `77ed18bfa86ba83fcf6f077edd76f33a63d95d61` 重新核验。本轮 design ledger commit 叠加在该 head 之后，但尚未 push；内容产物本身仍取自 `77ed18b`。

## 1. 仓库与 PR 现状

| 事实 | 结果 |
|---|---|
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 分支 | `project-slot-4-FLY-202`；继承远端 head `77ed18b`，本地只额外领先本轮 design ledger |
| origin/main | `1855f7a1a806f9c2dbceab69050db40198fd3ec6` |
| PR #194 | OPEN、非 draft、base=`main`、head=`project-slot-4-FLY-202`、MERGEABLE / CLEAN |
| 继承 head CI | `Build & Test` SUCCESS；`FLY-1062 payload distribution` SUCCESS，二者均绑定 `77ed18b` |
| 工作树 | 除本轮 `engineering/doc/FLY-202-sandbox-notes-e2e/` 设计文档外无未提交变化 |

最终设计文档 push 会移动 PR head，因此上表的 CI 只能证明继承头，不能冒充最终新 head 的 CI。后续节点如需 exact-head CI，必须重新读取新 SHA 的 check 结果。

## 2. 五项交付的当前证据

| ID | 要求 | 实测证据 | 结果 |
|---|---|---|---|
| V1 | 用途说明 2–3 段 | 按空行分块统计标题与 `## Top-level directories` 之间正文 | 3 段，PASS |
| V2 | 每个顶层目录 + 非空描述 | `git ls-tree -d --name-only HEAD` 与表格首列排序后 `diff`；检查第二列 | 17=17、集合一致、0 个空描述，PASS |
| V3 | README 约 10 bullets | 统计 summary section 中以 `- ` 开头的行 | 10 条，PASS |
| V4 | `ls -R doc/ \| head -50` fenced block | 提取唯一 `text` fenced block 与现场命令输出逐字 `diff` | 50=50 行、diff exit 0，PASS |
| V5 | feature branch + PR | `gh pr view 194` + 本地/远端 SHA | PR OPEN，base/head 正确，远端绑定 `77ed18b`，PASS |
| V6 | 继承 marker | 读取最后一个非空行 | `- FLY-2456 drill marker r1 B1`，PASS |

目录检查使用 Git tree 作为 source of truth（事实来源），不会把本地未跟踪缓存误当成仓库目录。表格正确包含 `.claude/`、`.flywheel/`、`.github/`、`.lead/`、`.serena/` 五个 tracked 点目录；顶层名为 `=` 的对象是文件，不属于“every top-level directory”。

## 3. README 摘要覆盖范围

`packages/qa-framework/README.md` 当前 316 行，包含 11 个二级 section：Architecture、Quick Start、5-Step Protocol、Config Schema、Examples、Test Slot Framework、FLY-60 Hard Gate、Mirror Mode、Roundtable Mirror、Alert Mirror、Contracts。现有 10 条摘要通过合并相关小节覆盖这些主题，没有把“约 10 条”机械扩大成每个标题一条。

关键来源事实：

- README 的 Test Slot Framework 明确说明每个 slot 运行真实 Runner，且不支持 synthetic / fixture mode。
- 三个入口脚本分别负责部署、注入真实 Linear issue 和 teardown；真实 Runner 前置条件包括 `LINEAR_API_KEY` 与 GitHub push 权限。
- `FLYWHEEL_RUNNER_START_POINT` 仅由 test slot Bridge 设置，生产 launcher 未设置时仍走 `origin/main`。
- Mirror / Roundtable / Alert 三类模式有各自边界；共享频道模式默认拒绝 Runner E2E。

## 4. 告警隔离措辞核对

现有第 2 段写的是：只有显式以 `test-deploy.sh --alerts` 部署并配置 test alert channel 时，才使用 slot-local alert queue；否则保留 production-default paths。该表述与三处来源一致：

1. `packages/qa-framework/README.md` 的 Alert Mirror section：`--alerts` 同时隔离 Bridge 与 shell writer；无 `--alerts` 时 overrides unset，走 production paths。
2. `scripts/test-deploy.sh`：`ALERTS=0` 为默认；解析 `--alerts` 后置 1；缺少 `alertChannel.channelId` 时 fail closed。
3. `scripts/lead-alert.sh`：`FLYWHEEL_ALERT_QUEUE_DIR` 未设置时回落到 `${HOME}/.flywheel/alert-queue` 的 production default。

因此前一轮已修正的边界是准确的，本轮不应再改成“所有 slot 默认隔离 alert queue”。

## 5. `doc/` 快照的结构风险

现场前 50 行覆盖 `doc/` 顶层清单、`doc/FLY-145-s6-retry-product-test/`、`doc/FLY-202-qa-sandbox-fixture/`，以及 `doc/architecture/` 的开头。任何对这些位置的文件新增、删除或重命名都可能让 V4 失效。

本轮过程文档位于 `engineering/doc/FLY-202-sandbox-notes-e2e/`，不在 `doc/` 树内，所以 Markdown、Mermaid、SVG、HTML 的刷新不会改变 snapshot。后续 implement 仍须把“`doc/` 下零新增/删除”作为显式守卫。

## 6. 测试与验证范围

本 issue 的目标是 Markdown 内容和 PR wiring，没有 TypeScript 或 shell 实现变更。根据 local-test-policy/v1，不应运行全仓或全包测试来证明文档正确。相关证据应由上述内容断言、`git diff --check`、Git/PR SHA 绑定与 exact-head CI 构成；如后续 implement 没有代码变更，则没有可保留的 concrete Vitest file，禁止退回 broad Vitest 命令。

## 7. 设计结论

当前内容已经满足 issue 五步，且先前已知的告警事实错误已经消失。实施计划应采用“验证通过即 no-op（不改内容）”路径，同时保留漂移修复分支。设计本身需要刷新、重新评审、重新发布；内容产物不应因 design re-dispatch 被无条件重写。
