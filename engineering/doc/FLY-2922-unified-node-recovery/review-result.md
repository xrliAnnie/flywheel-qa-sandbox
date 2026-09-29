# FLY-2922 三域隔离收口与 QA@4 — 设计评审记录
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: plan.md

> **当前状态：Round 2 PENDING。** 下方 2026-09-27 的 verify-then-submit Round 1–3 是历史记录，已被 2026-09-29 三域隔离计划取代，不能作为当前 plan blob 的批准，也不能执行已删除的 `handin.zsh`。

评审对象：本轮 design 节点的 verify-then-submit 合同（plan.md + handin.zsh），不是上游已批准的 held 恢复设计（那份的有效评审见 origin/flywheel-FLY-2922 的 review-result.md：gate d9ab4f85、0f29f815）。评审模型由 Bridge 指定：gpt-6-astra / xhigh；Codex thread `01a0e2e9-4f98-7502-b116-d377dd2fd8d6`。

## Round 1 — CHANGES_REQUESTED

request `023e256d-3188-44b1-9a59-a5848b7b547b`，plan blob `1aa36a8de9af082575419b163020909e3ab06652`（提交 1b7c5a11d），turn `01a0e2e9-5582-7e03-bbbf-fd40e742ac03`；findings critical=0 high=1 medium=5 low=0。全部接受，处置见 plan.md §9：

1. HIGH `--target-repo` 被 `complete.js:807–828` 拒绝 → 删除跨 worktree 绑定，Lane A 不带 `--pr`。
2. MEDIUM 失败只 echo、fetch/progress/push/report 无控制流 → 改为 `handin.zsh` 逐步检查退出码；生产侧 fetch 改 `ls-remote`。
3. MEDIUM MEDIUM-advisory 事实与实现头不符 → preflight 已落地（workflow-node-recovery.ts:243–246 / runs-route 409 / StateStore 62704–62725）；共享 materializer 的 rework 路径改引 `materializeReworkReplacementCoreTx:45593`。
4. MEDIUM 失败后无限等 Lead 与 `ask --report` 语义冲突 → 一次报告即退出。
5. MEDIUM Follow-ups/Lane B 无落地步骤、占位符不可粘贴 → A8 机器核对生产 PR 正文 7 个标记；`handin-body.md` 提交；Lane B 捕获真实 PR 号。
6. MEDIUM `ci-full ensure` 固定查沙箱仓 → 取证命令移到生产仓上下文。

## Round 2 — CHANGES_REQUESTED

request `d2c3ca1b-d42d-4405-8d3c-6103af5152e2`，plan blob `d427730d18dda2a2350aa239aa6d937bb9de268d`（提交 44b687b64），turn `01a0e3aa-3a14-7da1-aa06-dc8026302ebb`；findings medium=1 low=1；R1 六项全部 CLOSED。处置见 plan.md §10：

1. MEDIUM A8 把 gh 不可用一边记 unverifiable 一边写 `A1-A8 PASS`，空响应又误判成 head 不匹配 → A8 三态（PASS / UNVERIFIABLE / BLOCKED），JSON 与字段形态逐项检查，所有输出统一 `A1-A7 PASS; A8=<状态>`。
2. LOW 报告把 409 reason 写成兜底值 `recovery_preflight_failed` → 改为「HTTP 409 保留具体 reason；上下文无效为 `engine_rework_replacement_context_invalid`」。

## Round 3 — APPROVED（有效评审）

request `16de6265-85ff-4760-a120-5d785dadb51d`，plan blob `ad33389ffe306853bc5c23d4a263f9d894491e2e`（提交 9dad40707），turn `01a0e3b1-7f6d-72a1-a69b-f344aaad5a96`；findings 全零。R2 两项 CLOSED：A8 三态在 8 个隔离场景下分类正确；409 reason 与实现头源码一致。Codex 本轮独立跑了完整 DRY_RUN（A1–A7 与 A8 PASS，生产 PR 正文缺 `92e28887` 如实列出）。

批准的是「按该 verify-then-submit 合同进入 implement」，不是对生产实现的 QA、CI 或可合并性批准。

## 非阻塞 Follow-ups（交 Lead）

- 生产 PR #1374 正文缺最新复审 ID `92e28887`（沙箱 runner 不编辑生产 PR）。
- Lead 问题 `0d73b791`（交卷 lane）无答复时 implement 节点按 Lane A。

## 重派重绑（exec 0edcc786，2026-09-27 17:2x UTC）

design 节点被以新 exec `0edcc786-726c-42e3-a310-77c5fda21351` 重派。plan.md blob 仍为 `ad33389ffe306853bc5c23d4a263f9d894491e2e`（与 Round 3 批准对象逐字一致），未重写任何交付物。`stage set design_review --plan` 为本 exec 铸出新 manifest request `1a2e90ca-b426-403f-8bbe-c9efd513280c`（reviewer 仍 gpt-6-astra/xhigh）；用 `review-round design --round 3 --verdict APPROVED --thread 01a0e2e9… --turn 01a0e3b1-7f6d-72a1-a69b-f344aaad5a96` 把 Round 3 那一 turn 绑回该 request（Bridge 回执 `model=gpt-6-astra/xhigh required=gpt-6-astra/xhigh match=yes`），`await-codex-gate design` 返回 `design review APPROVED for exec=0edcc786-…`。没有新增评审轮次：本段是同一裁决对同一 blob 的重绑，不是新的批准。

## 2026-09-29 Round 1 — CHANGES_REQUESTED

- gate question：`0c9bc1c3-8c9a-4fb0-a5d8-f7acca2b8b88`
- request：`0cfeca03-fa17-4e78-b649-6bd17c5dce97`
- effective verdict：`CHANGES_REQUESTED`
- blocking findings：
  - `sandbox-dag-mutates-prod-pr`：当前 slot-2 sandbox DAG 不能写生产 worktree/PR，也不能为生产头取得有效 review/completion。
  - `qa-tasks-unexecutable-recursive`：inner QA 是 stub，不会执行 host QA tasks；用 `FLY-2922` 再开 driver 会递归。
- advisories：
  - `stale-handoff-and-artifacts`：删除旧 `handin.zsh` / `handin-body.md` 与未使用旧图，本文件把旧批准标为 superseded。
  - `task3-test-paths-wrong`：测试文件改为真实路径；Vitest 参数改为 package-relative `src/...`。
  - `qa-source-checkout-unspecified`：QA 改用 owner 专属 isolated clone，生产 remote 只读 fetch exact head，origin 固定 QA sandbox。
  - `teardown-path-mismatch`：raw `test-deploy.sh --qa-stub-runner` 只用 `scripts/test-teardown.sh PRIMARY_SLOT`。

修订策略：把执行链拆为 Production Implement、Host QA Controller、Inner Sandbox DAG 三个授权域。inner runner 永不触达生产；host driver 使用 Lead 授权的 fixture issue（禁止 `FLY-2922`）与 QA sandbox repo authority；房内 stub verdict 只推进 fixture run，最终 QA verdict 由房外 owner 根据原始 evidence 给出。

## 2026-09-29 Round 2 — PENDING

- 修订提交：`01f1fb46a`
- gate question：`f32da210-64ba-405f-8554-a15e3f52c909`
- request：`3240a3cb-8fd7-48f4-8c89-24215054a784`
- 审阅对象：三域隔离 plan blob；上一轮 question/verdict 不复用。
