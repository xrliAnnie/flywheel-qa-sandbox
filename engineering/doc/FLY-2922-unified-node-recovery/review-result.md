# FLY-2922 设计评审结果（沙箱 slot-2 重派轮） — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-27
基于: plan.md

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

## Round 3

结果在收到后追加。
