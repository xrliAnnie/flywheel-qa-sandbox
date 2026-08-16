# FLY-1375 自动 Land 流程 — 运维手册
Issue: FLY-1375 (https://linear.app/geoforge3d/issue/FLY-1375/ship-自动化-founder-说-ship-后全自动收尾-land-流程cool-merge-清-worktree-关全部)
日期: 2026-07-21
基于: plan.md

## 正常路径

Founder 在当前审批卡片上批准后，Bridge 会把审批投影到对应的 workflow gate holder，并激活引擎拥有的 `land` 节点。Land executor 随后按持久化步骤收据执行：

1. 重新校验当前审批 holder、PR 号、批准 head 与 QA/Founder claims。
2. 向 PR 发布内容严格等于 `:cool:` 的评论，触发 sanctioned ship workflow。
3. 通过 `trigger_comment_id + head` 关联 workflow 回执；确认 PR 已合并后才继续。
4. 给本 issue 的每个 session 一次 cleanup opportunity，然后执行 issue 级 closeout。
5. 关闭全部 session、清理 worktree、归档 Discord thread、把 Linear issue 标为 Done。
6. 仅在上述后置条件全部成立后，写入 `finalization_completed` 并完成 workflow run。

查询状态：

- `GET /api/lifecycle/land/:operationId`：查看当前 operation、lease、步骤收据和最近错误。
- `POST /api/lifecycle/land`：仅用于受控恢复或 legacy 在飞单；请求需携带 `project`、`issueId`，并建议携带精确 `prNumber`、`approvedHead` 作为断言。Bridge 的周期 worker 会持续推进同一 operation，不依赖请求进程存活。
- Discord issue thread 会收到 activated、`:cool:` triggered、merge confirmed、cleanup requested、partial/held、completed 等链路播报。

## 故障与恢复

所有 land operation 以批准 head 为幂等键，并由 generation-fenced lease 保护。进程退出后可安全重试；已存在的步骤收据不会重复执行不可逆动作。

- `partial`：通常是 workflow 尚未完成、closeout 尚未收敛、worktree/归档/Linear Done 暂时失败。修复依赖后让 dispatcher 下一轮重试，或对同一参数重发 lifecycle land 请求。
- `held`：authority/head 不一致、PR 已关闭未合并或 sanctioned workflow 明确失败。Workflow run 同时进入 held，并通过 workflow alert outbox 向 Lead 升级；先处理原因，再按 run 管理流程恢复。
- `busy`：另一个有效 lease 正在执行，无需人工干预。

紧急回退时，保留旧工程模板绑定，按 FLY-1338 人工范式完成 sanctioned `:cool:` merge、全部 session close、worktree 清理、Linear Done 与 thread archive；不要使用裸 `gh pr merge --squash`。

## Legacy 在飞单检查单

1. 确认 PR number、当前 remote head 和 Founder 批准 head 完全一致。
2. 确认 QA 与 code-review 证据仍有效，且没有更新的拒绝或反馈。
3. 通过 lifecycle land endpoint 创建 runless operation；worker 会在执行前重新走 legacy authoritative ship decision。
4. 若自动入口不可用，严格执行 FLY-1338 顺序：`:cool:` → 确认 merged → cleanup opportunity → close 全部 issue sessions → 删除干净 worktree → Linear Done → archive thread。
5. 记录每一步结果；任何不确定状态都停在 partial/held，不宣告完成。

## 真机验收

- Founder 批准后除批准本身外零人工介入；PR 只能由 `:cool:` workflow 合并。
- 故意保留一个 `lease_stale` 或 `awaiting_review` session，land 仍能把 issue 的所有 session 收敛关闭。
- 制造陈旧或已损坏的 worktree 登记；land 后同分支新 runner 能从干净 worktree 启动，危险的不一致绑定必须 fail closed 并升级。
- 最终同时确认：PR merged、worktree 不存在、全部 session 关闭、Linear 为 Done、Discord thread 已归档，且 thread 中保留完整链路播报。
