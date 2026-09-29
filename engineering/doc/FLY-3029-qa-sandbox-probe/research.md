# FLY-3029 N-to-N QA 探针 — 调研
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: exploration.md

## 1. 仓库与分支事实

| 项目 | 当前证据 |
|---|---|
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 分支 | `project-slot-3-FLY-3029` |
| design 审计 HEAD | `1855f7a1a806f9c2dbceab69050db40198fd3ec6` |
| origin/main | 同为 `1855f7a1a` |
| upstream | 未配置；首次 push 需要 `git push -u origin <当前分支>` |
| push guard | worktree 专属 hook 已配置；不得绕过或强推 |

Issue 描述中的 529 slot 2 / `bfdea677` 与当前 orchestrator 授权的 slot 3 worktree 不一致。已向 Lead 提交非阻塞问题 `a1e74df8-12c7-44b0-a21d-00516461ba90`。在答复前，本设计以不破坏编排身份为默认：不 reset、不转槽、不触碰生产；implement 节点仍须以届时 TURN、inbox 与现场 HEAD 为准。

## 2. `README.md` 精确现状

根 `README.md` 是 44 bytes，内容为两个空行、现有 marker 和结尾 LF：

```text


FLY-1375 land E2E marker 20260722T023540Z
```

`git grep -nF -- 'FLY-2919 N-to-N claude-body probe' -- .` 零命中；新行尚不存在。旧 marker 只在根 `README.md` 命中。因此最小补丁可保留现有三行，新增第 4 行，不需要额外空行或全文件重写。

README 最近三次历史变更均为 sandbox E2E marker / happy-path 文档更新，说明一次性 probe 放在根 README 与该仓库用途一致。

## 3. 消费者与测试影响面

按本地测试策略搜索了旧 literal、新 literal、`README.md` 文件名和 `./README.md` 路径形状。新 literal 与 `./README.md` 均零命中；旧 literal 只命中根 README。`README.md` 的 test/QA-shaped 匹配分为：

- **临时 fixture 自建 README**：`SkillInjector.test.ts`、`migrate-agents-path.test.ts`、`workflow-decision-routes.test.ts`、`shell-publish.e2e.test.ts`、`scripts/e2e-heartbeat.ts`、`scripts/qa-fly-1188-e2e.mjs`、`scripts/qa-fly-1236-e2e.mjs`、`scripts/qa-fly-1239-e2e.mjs`、`scripts/qa-fly-1244-os-proof.mjs`、`scripts/test-restart-services.sh`。它们在临时目录内创建自己的 README，不读取仓库根内容。
- **读取或引用其他 README**：`fly152-reply-discipline.test.ts`、`fly369-patrol-rule.test.ts` 读取包内规则 README；`scripts/qa-fly-153-mirror-smoke.sh`、`scripts/test-deploy.sh`、`scripts/test-slots.example.json` 只引用 qa-framework README 的说明。
- **文件清单或生成路径**：`onboard-shell-publish-gate.test.sh`、`package-onboard-version-injection.test.sh`、`package-onboard.test.sh` 只核对打包文件名；`test-setup-doc-flow.sh`、`test-setup-new-project.sh` 检查脚本生成的其他 README 路径。
- **注释命中**：`packages/teamlead/scripts/test-fly26-rules-split.sh` 的注释明确排除其包内 README。
- **非执行证据文档**：`doc/qa/FLY-710-fly707-enablement-qa-report.md`、`doc/qa/sandbox-notes.md`、`engineering/doc/FLY-886-sub-fold-tidal-echo/qa-report.md`。

以上匹配均不依赖根 README 的真实内容，因此全部排除，不保留本地测试。Implement 节点仍必须在自己的最终 HEAD 重跑发现并逐项记录新增/变化的匹配，不能把本次清单当成永久常量。

本变更是 Markdown-only，没有 owning TypeScript package。定向运行 `pnpm exec biome check README.md` 得到 `Checked 0 files`、README ignored、exit 1，证明 Biome 不覆盖该文件；不能用全仓 lint 或 full suite 制造无关证据。精确头 PR CI 是全套验证唯一来源，但该合成任务的主验收仍由 FLY-2919 driver receipt 完成。

## 4. 边界与失败语义

### 输入边界

唯一输入是 issue 中给定的固定 ASCII 文本，不含用户生成 HTML、SQL 或网络 payload；本任务不引入数据库、接口或运行时渲染。

### 幂等与换体续跑

- `origin/main` 上目标 literal 必须是 0 次；若已存在，按夹具冲突停止并报告。
- 当前 issue 分支为 0 次时进入新写入路径。
- 当前分支恰好 1 次时，只有前一 body 留下的单行 diff或 subject 精确为 `docs(FLY-3029): add N-to-N claude-body probe` 的 commit 才允许续跑；来源不明或出现多次时停止。
- 写入后 literal 必须恰好 1 次、位于最后一行，最后一个 byte 必须是 LF（hex `0a`）。
- `git diff HEAD -- README.md` 必须只新增目标行，既覆盖 staged 也覆盖 unstaged 状态。
- implement 获得 TURN 后若 HEAD 或 README 已变化，以现场重跑结果为准。

### 阶段身份

每个 DAG phase/body 有独立 execution id。Implement 的 inbox 和 progress 只能使用运行时注入的 `$FLYWHEEL_EXEC_ID`，禁止复用本 design id。probe commit 与首次 push 后分别写 cursor；progress 会创建独立 commit，因此最终不能假设 HEAD 就是 probe commit，而应按精确 subject 恢复 probe SHA 并验证它是 upstream 的祖先。

### Git 边界

- README probe commit 只暂存根 `README.md`，不吸收设计文档或无关 dirty files。
- 正常 fast-forward push 当前 feature branch 并设置 upstream；不 push main、不 force push、不 merge。
- push 失败先核远端与 hook 输出；非 fast-forward 必须由 Lead 明确许可。

## 5. 验收证据分层

| 层级 | 证明什么 | 不能证明什么 |
|---|---|---|
| `git grep` + README 尾部 | 指定行存在且只存在一次 | Runner/thread 生命周期正确 |
| `git diff --check` + 单文件 diff | 变更范围与空白正确 | 已提交或已推送 |
| commit SHA + upstream ancestor | probe 已提交并进入远端 feature branch | driver 已收到交卷 |
| FLY-2919 driver receipt | 死体换体、活体保活、同 thread 续干、交卷回 thread | 生产可派发该 fixture |

四层证据不可互相替代。README 行存在不是 N-to-N QA PASS，窗口消失也不是死亡证据。

## 6. 调研结论

无需引入代码、脚本、迁移或新接口。后续实现应是一笔 Markdown-only 的最小提交；主要风险是重复追加、错误分支/基线、错误消费 phase inbox，以及把仓库效果误当 driver 生命周期验收。计划通过 preflight、单行补丁、分层验证与正常 handoff 控制这些风险。
