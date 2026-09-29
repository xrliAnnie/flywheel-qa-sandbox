# Design Review — plan.md (Round 1)
Date: 2026-09-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案 A 的逐字追加本身可行，不需要新增任何 N-to-N 机制。但目前计划存在 4 项执行问题：PR 范围与分支实际内容冲突、交卷前 HEAD 被账本提交推进却未再次推送、换体同步分支不完整，以及将 transport 能力误当成 DAG 交卷后行为的充分条件。修正这些流程与说明后即可实施。

审查对象为本地 HEAD `37026c0ef3e472342d99da9bc1894add4649d08d`，plan blob `8919628a8c5f2092eee9148d5e66f0638478feaf`；已阅读根目录 CLAUDE.md、README.md、exploration.md、research.md、plan.md。以下 `plan.md`、`research.md`、`exploration.md` 均指 `engineering/doc/FLY-3029-nton-claude-body/` 下文件。

源码证据根目录：`/Users/xiaorongli/.flywheel/state/qa-rooms/c676decf-7a72-45a0-adae-d115a35205da/src/`。下文 `packages/...` 引用均相对此根目录，避免把沙箱旧源码当成当前 comm 契约。

独立核验结果：

| 项目 | 结果 |
|---|---|
| README 当前内容 | 精确为 `\n\nFLY-1375 land E2E marker 20260722T023540Z\n`；3 行、末尾 LF。research.md:16 的显示值多了一个空格，真实标记行前没有空格。 |
| 分支 / upstream | 分支为 `project-slot-1-FLY-3029`；`git rev-parse --abbrev-ref '@{u}'` 明确报 no upstream。 |
| 本地 origin/main | `1855f7a1a806f9c2dbceab69050db40198fd3ec6`；HEAD 在其上已有 4 个设计/账本提交，净增 4 个文件、296 行。未执行 fetch，故这里是本地 tracking ref 的事实。 |
| push-guard | worktree hooksPath 下 pre-push 转发至 `/tmp/flywheel-test-slot-1/state/push-guard/hooks/pre-push`；其 28–30、41–57 行允许新分支/fast-forward，非 ff 需 ACK；33–38 行另行拒绝删除远端分支。未运行真实 hook 或写审计日志。 |
| complete 路由 / flags | `complete.js:87–138` 验证 PR 正整数、`--merged` 依赖 PR；`phase_design_complete` 禁 PR/merged；`pr_handoff` 必须 PR 且禁 merged。`needs_review` 携带 PR 是本任务正确的 PR 路由；缺 question-id 在 CLI 350–355 行仅警告，是否需要 approve gate 还取决于节点契约，见问题 4。 |
| 设计 HTML | `design-html-evidence.js:15–16` 实际为目录正则 `(^|/)doc/FLY-3029(?:-[^/]+)?/` 加大小写不敏感的 `.html` 后缀判断。指定 engineering 路径合法，但不是正则唯一允许的路径；`complete.js:667–686` 还要求 HTML 已提交、存在于 HEAD，且在 base..HEAD 的变更路径中。 |
| 历史先例 | #24 (`e03d7ae99`) 为 README +1、全提交 1 文件；#58 (`7049f7199`) 为 README -1、全提交 3412 文件；#64 (`e9a75dfed`) 为 README +3、全提交 4 文件。research.md:17 / exploration.md:26 所称“三次均单文件 +1”不成立，应更正；只有 #24 是精确同形先例。#24/#58 提交消息记有 `Shipped via :cool: comment`，未把本地历史当成三次流程均已在线核实。 |

执行验证仅限 `/tmp/fly3029-review-hl3pr3fs` 隔离副本/本地临时 Git 仓库：逐字提取 Step 2 命令，在 Bash、Zsh 各执行两次，结果均为原 README 字节 + 恰好一条目标行；另复现问题 3 的两种恢复失败。未运行项目测试套件，未执行真实 stage/gate/progress/complete、fetch/push、PR 创建或消息发送。

## What's Good (Keep)

- 精确目标行、保留已有 FLY-1375 标记、LF 守卫与 `grep -qxF` 的正常重复执行行为均正确。
- 明确将换体、判死、thread 连续性验收交给 FLY-2919 driver receipt；README 仅提供负载，边界合理。
- 保留 TURN 约束、已有 PR 复用、禁止 force-push / hook 绕过以及不自行 merge 的要求。
- 对这个一行探针，文本差异、提交范围和交卷回执验证已足够；无需扩展产品代码或建立新的测试框架。

## Issues & Recommendations

1. **[P1] 当前分支无法满足“PR 只有 README.md”的验收条件。**

   **位置：** `plan.md:18`、`:31`、`:119`、`:130–133`。

   **问题与影响：** 当前 `origin/main...HEAD` 已包含 exploration.md、research.md、plan.md、progress.md，随后设计 HTML 也要求提交到该分支。`progress.js:84–105` 明确会执行 `git add` 和 `git commit --only`，不是仓外状态写入。因此 Step 3 即使只 `git add README.md`，Step 5 对 main 的整个 PR 仍会包含过程文档，`gh pr view --json files` “只有 README.md”必然失败；它也与“不改任何其他文件”及 D5 自相矛盾。

   **建议：** 在计划中明确区分“README 业务改动恰 +1/0”与“已经要求的设计/账本文档”，列出这些过程文件的精确允许范围，并用 `git diff origin/main...HEAD -- README.md` 验业务改动、完整文件列表验范围。若 issue 的硬约束确实是整个 PR 只能有 README，则必须先给出兼容当前已提交设计与分支交接规则的交付安排，不能让 implement 自行猜测或重写历史。

2. **[P1] push 后继续自动提交 progress，交卷时本地 HEAD 与 PR head 不一致。**

   **位置：** `plan.md:94–98`、`:122–133`、`:154`。

   **问题与影响：** 按“每步之后”执行，Step 4 推送 H0 后写账本产生 H1，Step 5 后再次写账本产生 H2，Step 6 没有重推便 complete。`progress.js:95–105` 证明每次账本更新都会提交；`complete.js:748–785` 采集的是当前本地 HEAD；`primary-pr-admission.ts:212–223` 会因 GitHub PR 仍指 H0 拒绝为 `primary_pr_head_mismatch`。即使走其他完成分支，提交证据与实际 PR 也已不一致。Step 6 成功后再调用 progress 还可能因状态不再是 running 被 `progress.js:28–35` 拒绝。最后的 `git show --stat HEAD` 也将显示账本提交，而不是 README 的 +1 提交。

   **建议：** 明确最后一次账本提交在最终 push 和 gate/complete 之前；PR 创建后若更新账本，必须再次 push、确认 `git rev-parse HEAD` 等于 `gh pr view <n> --json headRefOid -q .headRefOid`，并按已有流程等待这个最终头的 review/CI。complete 成功后不再让“每步之后”规则生成提交。保存 README 提交 SHA，用 `git show --stat <README-commit>` 验证单行提交，不用会随账本变化的 HEAD。

3. **[P2] 换体同步吞掉 pull 失败，并把“无本地 upstream”误判成“无需续接远端”。**

   **位置：** `plan.md:65–71`、`:130–137`。

   **问题与影响：** `git rev-parse ... && git pull --ff-only || true` 将 pull 的任何错误转成成功；查看 `git log -1` 不能证明本地已同步。另一个独立场景是新体本地分支未配置 upstream，但远端已有旧体 push 的同名分支，当前命令会跳过它。计划要求 Step 0 后也写 progress，这又可能在 fetch/pull 前先创建一个本地提交，使可 fast-forward 的恢复变成分叉。

   **复现：** `/tmp` 隔离仓库中，旧体推进远端，新体先创建 Step 0 progress 提交，再执行计划原样 Step 1：stderr 为 `fatal: Not possible to fast-forward, aborting.`，整体退出码却为 0；本地 HEAD 不等于 upstream。另从 main 建立无 upstream 的同名本地分支，远端已含探针，执行 Step 1 仍返回 0 且本地没有探针。

   **建议：** 获得 TURN 后，先检查并保留旧体留下的 README 暂存/未提交改动，在任何新 progress 提交前完成恢复判断。让 fetch/pull 的真实失败停止后续写入；无 upstream 时显式检查 `origin/project-slot-1-FLY-3029`：存在则在保留本地工作的前提下续接它，不存在才走首推。分叉/冲突要明确处理或上报，不能 `|| true`。同理，Step 5 的 `gh pr list ... || true` 应区分“成功且结果为空”与查询失败。均只是修正现有命令分支，不要求新增恢复机制。

4. **[P2] Step 6 把 legacy approve gate 与 DAG 节点交接规则混为一谈。**

   **位置：** `plan.md:7`、`:20`、`:49–51`、`:123–128`；`research.md:35`。

   **问题与影响：** 计划称这是 DAG implement 节点且“不请求 ship 授权”，随后却无条件要求创建 approve gate，并断言 complete 后必进入 awaiting_review、等待自己 ship。实际 `complete.js:350–355` 对缺 question-id 仅警告；`:399–407` 明确区分 `engine_gate_handoff`（节点终结、不要等 ship 或 verify-approval）、`runner_ship_park` 与 `loop_park`。`Blueprint.ts:1987–1990` 禁止没有 can_ship 能力的 generalized 节点请求 ship approval；`:2037–2042` 给出的 PR 交卷命令是 `complete --route needs_review --pr <NUMBER>`。因此“Claude 有 transport”不足以推出计划中的后续流程，在 engine-owned 节点上照此执行会发错 gate 或等待一个不会发给自己的唤醒。

   **建议：** 将交卷段改为遵循 implement 节点实际注入的 capabilities/完成指令：若它明确要求 legacy approve gate，保留 `gate approve_to_ship --no-block` 和返回的 question-id；若由 engine 接管 gate，则用注入的 `needs_review --pr` 交接，不自行索取 ship 授权。成功后依据实际 `completionDisposition` 收尾或 park，不硬编码 awaiting_review。整体 approve→ship 仍由现有 DAG/Lead 负责，不修改任何调度机制。

## Verdict

CHANGES REQUESTED — address items above
