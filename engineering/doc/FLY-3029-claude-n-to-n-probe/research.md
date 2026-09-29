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

仓库对字符串 `README.md` 的引用很多。当前 HEAD 的逐行审计找到 21 个可执行测试、QA 脚本或测试配置形状的匹配；它们均不读取根 README 的真实内容：

- **临时 fixture 自建 README**：`SkillInjector.test.ts`、`migrate-agents-path.test.ts`、`workflow-decision-routes.test.ts`、`shell-publish.e2e.test.ts`、`scripts/e2e-heartbeat.ts`、`scripts/qa-fly-1188-e2e.mjs`、`scripts/qa-fly-1236-e2e.mjs`、`scripts/qa-fly-1239-e2e.mjs`、`scripts/qa-fly-1244-os-proof.mjs`、`scripts/test-restart-services.sh`。
- **读取或引用其他 README**：`fly152-reply-discipline.test.ts`、`fly369-patrol-rule.test.ts` 读取包内规则 README；`scripts/qa-fly-153-mirror-smoke.sh`、`scripts/test-deploy.sh`、`scripts/test-slots.example.json` 只引用 qa-framework README 的说明。
- **文件清单或生成路径**：`onboard-shell-publish-gate.test.sh`、`package-onboard-version-injection.test.sh`、`package-onboard.test.sh` 只核对打包文件名；`test-setup-doc-flow.sh`、`test-setup-new-project.sh` 检查脚本生成的其他 README 路径。
- **注释命中**：`packages/teamlead/scripts/test-fly26-rules-split.sh` 明确在注释中排除它自己的包内 README。

另外，`doc/qa/FLY-710-fly707-enablement-qa-report.md`、`doc/qa/sandbox-notes.md`、`engineering/doc/FLY-886-sub-fold-tidal-echo/qa-report.md` 是证据文档，不是可执行测试。Implement 节点仍需在自己的 HEAD 重新运行完整消费者搜索并逐项记录所有新增或变化的 test-shaped match，不能把上述数量当作固定预期。

因此当前 21 个可执行/配置匹配全部排除，理由是与根 README 内容没有依赖关系。变更是 Markdown-only，也没有 owning TypeScript package，所以不运行 Vitest、build 或 typecheck。定向执行 `pnpm exec biome check README.md` 的权威结果是 `Checked 0 files`、`README.md` ignored、exit 1，证明 Biome 不覆盖 Markdown；因此也不运行全仓 `pnpm lint` 来制造无关证据。验证集中在 literal、diff、Git 提交和 driver receipt。精确头 PR CI 仍是全套验证的唯一来源，但这个合成任务的主验收由 FLY-2919 driver receipt 完成。

## 4. 实现边界和失败语义

### 输入边界

唯一输入是 issue 中给定的固定 ASCII 文本，不含用户生成 HTML、数据库查询或网络 payload。本任务没有 SQL 或 HTML 渲染边界。

### 幂等与冲突处理

- `origin/main` 上目标 literal 必须是 0 次；若 main 已存在，按夹具冲突停止并向 Lead 报告。
- 当前 issue 分支上目标 literal 若为 0 次，进入新写入路径；若恰好 1 次，则检查来源：前一个 FLY-3029 body 留下的单行工作树 diff 或该分支上的 probe commit 可以续跑，来源不明或多次出现才停止。
- 写入后目标 literal 必须恰好 1 次，并且是文件最后一行。
- 文件最后一个 byte 必须是 LF（hex `0a`）。
- `git diff -- README.md` 必须只显示一行新增，不能删除或改写现有 marker。
- 如果 implement 获得 TURN 后发现 README 或 HEAD 已变化，重新执行上述检查，以现场状态为准；不要照抄本调研的行号或 byte count。

### 阶段身份与续跑

- 每个 DAG phase/body 都有自己的 execution id。Implement 的 inbox 和 progress 只能使用运行时注入的 `$FLYWHEEL_EXEC_ID`；禁止复用 design id、旧 body id 或其他阶段 id，否则会漏读本体消息并破坏性消费别人的 inbox。
- probe commit 后与首次 push 后各写一次 implement progress cursor。Progress 自身会生成独立 commit，所以最终验证不能假设 HEAD 就是 probe commit；必须通过固定 commit subject 恢复 probe SHA，并验证该 SHA 是 upstream 的祖先。

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
