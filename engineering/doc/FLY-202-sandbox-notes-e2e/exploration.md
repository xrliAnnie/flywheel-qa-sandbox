# FLY-202 QA 沙箱 fixture 笔记 — 探索
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: 无（本轮 re-dispatch 任务描述 + 分支 `origin/project-slot-4-FLY-202@77ed18b` + PR #194）

---

## 1. 一句话方向

把 FLY-202 当作 test-slot 专用的真实 Runner 测试夹具：在继承的开放 PR #194 上验证五项交付仍与当前仓库一致，只在发现漂移时做最小修复，并保持 PR 开放、绝不合入 main。

## 2. 任务目的

FLY-202 不是产品功能，而是 QA 基础设施的 fixture（测试夹具，指为了稳定复现测试流程而保留的真实输入）。`scripts/inject-linear-issue.sh` 通过 `POST /api/runs/start` 启动真实 Runner；PreHydrator 必须能从 Linear 读取到真实 issue，文档里并不存在的 `FLY-SBX-1` 无法满足这条路径。这个 issue 因而给 test-slot harness 一个长期可见、工作量小但有多个中间步骤的目标，方便 QA 在 Runner 工作中途观察状态。

“do not pick up” 约束生产 Lead 和生产 Runner。本执行由 test-slot-4 明确启动，execution id 为 `cd41d8e7-9d88-45e1-9921-4f0e91b42485`，DAG 节点为 `eng_design`，属于预期消费者。

## 3. 明确交付

最终内容产物是 `doc/qa/sandbox-notes.md`，必须同时满足：

1. 2–3 个正文段落说明 `flywheel-qa-sandbox` 的用途。
2. 表格逐项覆盖仓库每个顶层目录，并给出非空的一行描述。
3. 用约 10 条 bullet 概括 `packages/qa-framework/README.md`。
4. fenced code block 逐字保存 `ls -R doc/ | head -50` 的输出。
5. 内容位于 feature branch 上，并通过开放 PR 指向 sandbox 仓库的 `main`。

## 4. 继承状态

| 事实 | 当前值 |
|---|---|
| 分支基线 | `project-slot-4-FLY-202@77ed18b` |
| 开放 PR | #194，base=`main`，head=`project-slot-4-FLY-202` |
| PR 状态 | OPEN、MERGEABLE、exact-head 两个 CI check 均成功 |
| 现有内容 | `doc/qa/sandbox-notes.md` 已包含五项要求，且告警隔离措辞已按源码修正 |
| 本轮 design 写入 | `engineering/doc/FLY-202-sandbox-notes-e2e/` 下过程文档与 founder HTML |

本轮不是从零开始。先前 design 和 implement 已经把任务做完；当前 design 节点必须基于继承头重新核验，并给后续 implement 节点一个幂等执行合同（幂等，指重复执行不会制造额外变化），而不是为了“有改动”重写正确产物。

## 5. 方案比较

### A. 验证优先，只修漂移（推荐）

重新计算目录集合、README 摘要数量、`doc/` 快照、PR 绑定和内容事实。全部通过时，implement 节点不改内容，只记录核验并收尾；有红项时仅修对应段落或表格行。

- 优点：保留 PR 历史与稳定 fixture；最小化 `doc/` 快照被设计流程自我干扰的风险。
- 代价：需要把验收断言写得足够明确，避免“看起来没问题”的弱核验。

### B. 每轮完整重建 `sandbox-notes.md`

- 优点：流程表面上简单。
- 缺点：制造无意义 diff，容易改坏已经正确的告警边界、继承 marker 或快照；拒绝。

### C. 新建分支和第二个 PR

- 优点：本轮历史独立。
- 缺点：同一个 head 目标已有开放 PR，重复 PR 会分裂 CI、评审和 fixture 状态；拒绝。

## 6. 关键约束与负向守卫

- 所有写操作只在 sandbox clone 与当前 feature branch 内进行；不触碰生产资源。
- 过程文档继续复用 `engineering/doc/FLY-202-sandbox-notes-e2e/`，不创建第二个 FLY-202 doc-flow 文件夹。
- 不在 `doc/` 下新增或删除文件；该目录的文件名本身会改变第 4 项快照。
- 保留 `doc/qa/sandbox-notes.md` 最后的 `- FLY-2456 drill marker r1 B1`。
- 不另开 PR、不 merge、不 rebase、不 force-push、不请求 ship approval、不 dispatch 后继节点。
- 分支分叉、PR 关闭、越界冲突或来源事实无法确认时停止内容修改并上报 Lead。

## 7. 成功标准

设计完成时应有：最新的探索、调研和实施计划；新 execution 绑定的有效 APPROVED design review；包含真实 Mermaid 本地渲染图和逐节评论层的 founder HTML；所有文档与 HTML 已提交并 fast-forward push；HTML 已发布、自验并向 Lead 报告。此节点不实现 `sandbox-notes.md`，也不推进、合并或关闭 PR。
