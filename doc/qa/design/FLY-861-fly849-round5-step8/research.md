# Research: FLY-849 Round 5 — Current-State Verification — FLY-861

**Issue**: FLY-861
**Date**: 2026-07-04
**Source**: `doc/qa/design/FLY-861-fly849-round5-step8/exploration.md`

## 已核验事实（全部实测，非假设）

### 1. 环境与分支

| 检查 | 结果 |
|------|------|
| `git remote -v` | `xrliAnnie/flywheel-qa-sandbox`（fetch+push）✓ sandbox，非生产 |
| 当前分支 | `project-slot-2-FLY-861` |
| PR base 分支 | `qa/fly849-793-batch-combined`，tip = `4a4875d` |
| 祖先关系 | `git merge-base --is-ancestor qa/fly849-793-batch-combined HEAD` ✓ |
| 工作区 | clean（设计文档为本阶段新增） |

### 2. combined 分支本轮新增内容（被验对象）

- **FLY-859 Step 8**（PR #443，merge `baca27c`）：`70983d2` three-stage QA verdict tail —— PASS releases founder/ship，FAIL runs the Implement-fix loop；`4a21b26` Codex code R1 fix；`66d8650` flag-drift allowlist。
- **FLY-856**（PR #442，merge `1253524`）：`eb4d4f5` phase handoff 用 resolveLeadId 解真实 leadId（phantom `prev.lead_id` 曾致 phase window 关不掉，FLY-855）。
- 底座：793（三阶段 pipeline）+ 795（restart-resilient resume）+ 799 + cmux phase window（`34af071`、`304b0dc`）。

### 3. 交付物落点

- `doc/qa/harness/` **目前不存在** → Implement 阶段创建该文件即隐式建目录（git 按文件跟踪，无需额外步骤）。
- 无同名文件冲突；`git log --all -- 'doc/qa/harness/'` 为空（前几轮 round marker 在各自 slot 分支/仓库状态中，本仓无遗留）。

### 4. 设计文档布局先例

FLY-202（同 sandbox、同三阶段框架、2026-07-03）：`doc/qa/design/<ISSUE>-<slug>/{exploration,research,plan,progress}.md`，含变更分桶（Bucket A 设计文档 / Bucket B 交付物）与 design_review 流程（`stage set design_review --plan <path>` → Bridge 触发 Codex，结果 JSON 落 `.flywheel/runs/<exec>/codex/design-review.json`；Runner 用 `await-codex-gate` 阻塞等待）。本轮沿用。

### 5. checkpoints 配置（`.flywheel/config.yaml`）

| gate | enabled | timeout | behavior |
|------|---------|---------|----------|
| brainstorm | true | 24h | fail-close —— **已过**（Lead 明确批准） |
| question | true | 24h | fail-open |
| approve_to_ship | true | 24h | fail-close —— 本轮由 **FLY-859 Step 8** 在 QA PASS 后挂到 QA phase 自身（这正是被验行为） |

另：`qa.auto: true` + `skip_labels: [docs, chore]`（FLY-579 auto-QA）与三阶段 pipeline 的 QA phase 是两套机制；本轮走三阶段 QA phase（Sonnet），由 FLY-793/859 的 ThreeStageQaCoordinator 驱动，非 FLY-579 路径。

## 风险与消解

| 风险 | 消解 |
|------|------|
| Implement 阶段误改交付物内容（措辞漂移） | plan 中字节级钉死文件全文，QA 逐字核验 |
| PR 误开向 `main` | plan Step 明确 `--base qa/fly849-793-batch-combined` + 开 PR 前核验命令 |
| 误碰 Bucket 外文件 | plan 定义 Bucket A/B，verification 清单含 `git status` 范围检查 |
| 误在生产仓操作 | Step 1 环境断言（remote 必须是 flywheel-qa-sandbox，否则 `complete --route blocked`） |
| Implement 阶段自 ship（破坏 Step 8 被验路径） | plan 明示：Implement 开 PR 后按其注入协议收尾，**不做 merge**；founder gate + ship 属 QA phase（FLY-859 Step 8） |
