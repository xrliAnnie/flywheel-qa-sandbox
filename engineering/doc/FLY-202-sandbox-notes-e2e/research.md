# FLY-202 QA 沙箱说明夹具 — 调研
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: exploration.md

## 1. 仓库、分支与 PR 事实

| 项目 | 当前权威事实 | 设计含义 |
| --- | --- | --- |
| 仓库 | `xrliAnnie/flywheel-qa-sandbox` | 所有写操作仅留在 sandbox clone |
| 分支 | `project-slot-1-FLY-202` | 继续现有 branch，不另建、不 rebase、不 force-push |
| preserved baseline | `ab1d379b1` | 本轮 design 从该 implementation milestone 继续 |
| fetched `origin/main` | `1855f7a1a` | merge-base 与 main 相同，当前 branch behind=0 |
| open PR | #196，OPEN、MERGEABLE、非 draft | 复用 carrier，不创建第二个 PR |
| PR checks | exact preserved head 上两个 checks 均 SUCCESS | 是 baseline 证据，不代替本轮文档验证 |
| inherited 内容 | `FLY-2456 drill marker r2 B1` | 本轮不得删除或改写 |
| doc-flow | enabled，department=`engineering` | 过程文档复用本文件夹 |

PR title/body 仍描述 FLY-2456 drill。这是 branch continuity 的已知历史，不是 design node 改写 PR
metadata 的授权。最终 handoff 要明确披露，但不能通过另开 PR、重锚或 force-push “修干净”。

## 2. 目标文件现状

对当前 `doc/qa/sandbox-notes.md` 运行 bounded parser 得到：

```json
{"introParagraphs":3,"directories":17,"summaryBullets":10,"listingLines":50,"listingMatches":true,"marker":true}
```

这说明 preserved implementation 当前已经满足可机械核验的结构要求：

- 3 段仓库用途说明；
- 17 行顶层目录表；
- 10 条 QA framework 摘要；
- `ls -R doc/ | head -50` 的 50 行 fenced output，且与 live checkout 字节一致；
- inherited marker 仍在。

因此当前实现计划不能继续写“编辑前 parser 预期失败”。它应把首次创建和 re-dispatch 同时建模：
先校验；失败时最小修复，成功时保留字节并记录 no-op evidence。

## 3. 顶层目录模型

下列两个只读命令在本 checkout 都得到相同的 17 个 project directories：

```bash
git ls-tree -d --name-only HEAD | LC_ALL=C sort
find . -mindepth 1 -maxdepth 1 -type d -not -name .git -exec basename {} \; | LC_ALL=C sort
```

当前集合：

```text
.claude
.flywheel
.github
.lead
.serena
agents
doc
docs
engineering
fleet
packages
patches
product
qa-fly294
qa-fly310
scripts
supabase
```

实现时必须重新运行两条命令。若 tracked 与 live 集合不同，先把差异分类为真正的 project directory
或 harness 临时产物；不能静默把临时目录写进长期文档，也不能只看其中一份集合。

## 4. QA framework README 事实

`packages/qa-framework/README.md` 当前 316 行，稳定概念可归纳为十组：

1. reusable、plan-aware QA Agent Framework；
2. framework 与 project config 的两层架构；
3. Quick Start / adoption；
4. Onboard → Analyze + Plan → Research → Write + Execute → Finalize 五步协议；
5. config schema、types 与 example；
6. FLY-115 real-Runner slot model，无 synthetic mode；
7. deploy / inject / teardown scripts 与 prerequisites；
8. `FLYWHEEL_RUNNER_START_POINT` 的 slot-only boundary；
9. hard-gate、Mirror、Roundtable Mirror 与 Alert Mirror 的边界；
10. guides、plan-source contract 与 skill-interface contract。

目标文档当前已有十条；后续节点仍要从 source README 复核含义，不能只数 bullet。

## 5. 命令输出取证

Issue 指定的命令是：

```bash
ls -R doc/ | head -50
```

当前 fenced block 与 `LC_ALL=C` 下的 live stdout 完全相同。design node 的文件位于
`engineering/doc/`，不会改变该 listing；但后续 implementation 在写入前后都应重新执行，因为
`doc/` 可能被其他 authorized phase 更新。

## 6. Test discovery 与排除记录

按 local-test-policy 搜索 exact path、filename、parent path、title 与 inherited marker 后：

- exact path / filename 只命中历史 FLY-202 设计、当前过程文档、milestone 和 founder HTML；
- `packages/qa-framework/__tests__/QaConfigLoader.test.ts`、`shell-export.test.ts` 只因 generic
  `doc/qa` config/path 出现而命中，不读取或解析 `sandbox-notes.md`，因此排除；
- shell suites 和 runtime files 同样只使用 generic `doc/qa` path，与目标 Markdown contract 无关；
- marker literal 命中目标文件及 FLY-202 文档，没有 concrete test consumer。

结论：没有需要运行的 concrete test file。不得回退到 bare Vitest、package test alias 或 full repository
suite；目标验证由 bounded Node parser、`git diff --check` 与 PR state inspection 覆盖。

## 7. 数据 / 结构模型

单一事实流如下：

```text
tracked + live root directories ─┐
QA framework README ─────────────┼─> doc/qa/sandbox-notes.md ─> PR #196
live doc listing ────────────────┘
```

`sandbox-notes.md` 是 materialized view，不是 source of truth。目录名称、README 概念与命令 stdout
都保持各自单一来源；plan 不维护第二份运行时 vocabulary 或 mirrored config。

## 8. 验证策略

1. bounded parser：标题、2–3 intro paragraphs、tracked directory set、10 bullets、50-line fence、live
   stdout byte equality、inherited marker；
2. `git diff --check`：Markdown whitespace hygiene；
3. `git diff --name-status <preserved-baseline>...HEAD`：本 design node 只改授权过程文档、Mermaid 与 HTML；
4. `gh pr view 196`：OPEN、base=`main`、head branch 正确，push 后 remote OID 等于 local HEAD；
5. exact pushed head 的 CI state 由后续 workflow/QA 核验；本地 targeted checks 不能冒充 full-suite evidence。

本轮没有 TypeScript change，`vitest related` 不适用。`pnpm lint` 可作为 repository lint，但不能被描述
为覆盖 Markdown contract 的 test。

## 9. 风险与回滚边界

| 风险 | 设计对策 | 回滚边界 |
| --- | --- | --- |
| 旧文档自证 | 总从目录树、README、live listing 重新取证 | 只回滚 evidence 不符的 target edit |
| re-dispatch 制造 churn | parser 先行，PASS 时 no-op | 不为 commit 而改字节 |
| 顶层目录竞态 | implement 时重新枚举 tracked + live | 不回滚他人 authorized changes |
| PR 元数据与 FLY-202 不一致 | 披露并复用 carrier | 不改写 published history |
| inherited marker 混入结果 | 明确标为 inherited | 不删除既有 FLY-2456 变更 |
| fenced output 漂移 | 写入后立即重新比对 | 仅刷新 fenced block |
| 生产资源误触 | 当前 clone + no deploy/merge/ship | design 阶段无生产副作用 |
