# FLY-3029 Claude N-to-N 探针 — 调研
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: exploration.md

## 1. 仓库与分支事实

| 项目 | 当前证据 |
|---|---|
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 分支 | `project-slot-5-FLY-3029` |
| 设计审计时 HEAD | `1855f7a1a806f9c2dbceab69050db40198fd3ec6` |
| origin/main | 同为 `1855f7a1a` |
| upstream | 未配置；首次 push 必须使用 `git push -u origin project-slot-5-FLY-3029` |
| push guard | worktree 专属 hook 已配置；不得绕过、不得强推 |

Issue 描述中的 529 slot 2 / `bfdea677` 是原始 FLY-2919 QA 台架身份，而当前被授权的设计 worktree 是 slot 5 / `1855f7a1a`。Lead 已通过问题 `e54708b7-4322-417c-bf3e-933fc970e377` 裁定这是 QA test-slot identity override：继续 slot 5 sandbox 当前头，不得 reset，也不得转向生产 slot 2。该裁定消除了基线歧义；implement 节点仍需以届时 TURN 和现场 HEAD 为写权限证据。

## 2. `README.md` 的精确现状

根 `README.md` 为 44 bytes，字节级内容是两个空行、现有 marker 和结尾 LF：

```text


FLY-1375 land E2E marker 20260722T023540Z
```

`git grep -nF -- 'FLY-2919 N-to-N claude-body probe' -- .` 当前零命中；指定的新行尚不存在。现有尾行只在 `README.md:3` 命中。因此最小补丁可以保留前三行，新增第 4 行，不需要补额外空行，也不需要重写文件。

该文件最近三次历史变更均为 sandbox E2E marker / happy-path 文档变更，说明把一次性测试标记放在根 README 与仓库既有用途一致。

## 3. 消费者与测试影响面

仓库对字符串 `README.md` 的引用很多，但测试形状的 11 个文件经逐行检查后均不读取根 README 的真实内容：

- `SkillInjector.test.ts`、`migrate-agents-path.test.ts`、`workflow-decision-routes.test.ts`、`shell-publish.e2e.test.ts` 各自在临时目录创建自己的 README fixture。
- `fly152-reply-discipline.test.ts`、`fly369-patrol-rule.test.ts` 读取的是包内规则目录的 README。
- `onboard-shell-publish-gate.test.sh`、`package-onboard-version-injection.test.sh`、`package-onboard.test.sh` 检查打包清单里的文件名，不断言仓库根 README 内容。
- `test-setup-doc-flow.sh`、`test-setup-new-project.sh` 检查由 setup 脚本生成的其他 README 路径。

因此这些 11 个测试全部排除，理由是它们与根 README 内容没有依赖关系。变更是 Markdown-only，也没有 owning TypeScript package，所以不运行 Vitest、build 或 typecheck；验证应集中在 literal、diff 和 Git 提交证据。精确头 PR CI 仍是全套验证的唯一来源，但这个合成任务的主验收由 FLY-2919 driver receipt 完成。

## 4. 实现边界和失败语义

### 输入边界

唯一输入是 issue 中给定的固定 ASCII 文本，不含用户生成 HTML、数据库查询或网络 payload。本任务没有 SQL 或 HTML 渲染边界。

### 幂等与冲突处理

- 写入前目标 literal 必须是 0 次；若已经存在，禁止再追加，向 Lead 报告已有状态和当前 HEAD。
- 写入后目标 literal 必须恰好 1 次，并且是文件最后一行。
- `git diff -- README.md` 必须只显示一行新增，不能删除或改写现有 marker。
- 如果 implement 获得 TURN 后发现 README 或 HEAD 已变化，重新执行上述检查，以现场状态为准；不要照抄本调研的行号或 byte count。

### Git 边界

- 只提交根 `README.md` 与本 issue 的设计产物；不吸收无关 dirty files。
- 正常 push 当前 feature branch并设置 upstream；不 push main、不 force push、不 merge。
- push 失败先检查远端分支与 hook 输出；非 fast-forward 需要 Lead 明确许可，不能绕过 hook。

## 5. 验收证据分层

| 层级 | 证明什么 | 不能证明什么 |
|---|---|---|
| `git grep` + README 尾部 | 指定行存在且只存在一次 | Runner/thread 生命周期正确 |
| `git diff --check` + 单文件 diff | 变更无空白错误且范围为一行 | 已提交或已推送 |
| 本地 commit SHA + `git ls-remote`/push 收据 | 变更已进入远端 feature branch | QA driver 已收到交卷 |
| FLY-2919 driver receipt | 死体换体、活体保活、同 thread 续干、交卷回 thread | 生产系统可以派发该 fixture |

最终判定必须保留这四层的区别。尤其不能把“README 已有目标行”写成 N-to-N QA PASS，也不能把“窗口消失”直接写成死体。

## 6. 研究结论

没有理由引入代码、脚本、数据库迁移或新接口。后续实现应该是一次 Markdown-only 的最小提交；技术风险主要来自重复追加、写错分支、错误处理基线差异，以及把仓库效果误当成 driver 生命周期验收。计划将用显式 preflight、单行补丁、逐层验证和正常 handoff 消除这些风险。
