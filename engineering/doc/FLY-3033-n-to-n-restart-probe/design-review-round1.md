# FLY-3033 N-to-N 重启探针 — Codex 设计评审第 1 轮（原文存档）
Issue: FLY-3033 (https://linear.app/geoforge3d/issue/FLY-3033/529-合成单勿派-fly-2920-真房-n-to-n-codex-实现体重启负载演练用)
日期: 2026-09-28
基于: plan.md

> 评审者 gpt-6-astra / xhigh，线程 `01a0ea77-cf29-74b0-a114-1398c87830a5`。以下为评审者原文；文中 `./…` 与 `/private/tmp/…` 链接指评审者当时的临时脚本与结果文件，未入库。

# Design Review — plan.md (Round 1)

Date: 2026-09-28 / Author: Codex / Status: CHANGES REQUESTED

## Summary

冻结后评审的顺序、README 字节合同及沙箱边界合理，但目前不能兑现“任何一步被杀，从 Task 0 重跑都收敛”：真实 `progress` 的命令内部中断会留下计划拒绝恢复的文件。Task 5 也需要明确区分新建评审与沿用原身份恢复评审。

审查对象为 `engineering/doc/FLY-3033-n-to-n-restart-probe/plan.md`，blob `61cdd3ab4f16fce4640cd9519b82b699f66f6602`。已读取 CLAUDE.md、README、exploration/research/dry-run、两个 harness 文件及前案 `origin/project-slot-2-FLY-3030`（`1cb0a7a90692f367e176b258746fb3c4625f76ee`）。运行时源代码来自 `/Users/xiaorongli/Dev/flywheel-FLY-2920`，HEAD `df10f07c6c74df7c416cfbb15d417592e3930ceb`；核对了 turn、progress、gate、request-review、await-codex-gate、complete 和 Codex 注入协议。

验证与边界：

- **已执行**：常量及八个 Task 块均通过 `/bin/sh -n`；指定 dry-run 完整运行 exit 0，观察到既有场景的预期结果和成功场景的 `final: OK`。其日志摘要两次出现 `tr: Illegal byte sequence`，不将这些截断摘要当作完整错误证据。Task 5 仍只演练冻结头前置，gh/comm 大部分行为仍为桩。
- **已执行补充复现**：调用真实运行时 `runProgress`，将 session/fs/git 依赖指向临时仓，在四个内部边界对测试进程发 SIGKILL；四次重进原文 Task 0 均 exit 1。另以临时 CommDB 调用真实 `gate`，以 mock fetch 调用真实 `requestReview`，验证重复调用的身份变化。见下方两项发现及可重跑脚本。
- **静态核对**：README 与 `origin/main` 均为 3 行、44 字节，目标行含换行为 30 字节，计划的 4 行/74 字节正确；`progress` 使用 YAML frontmatter、原子文件替换及 path-limited `git commit --only`；`turn` 首字段为 `yours`；code gate 校验 reviewed HEAD；`needs_review --pr` 是合法完成路由。当前 completion-drain v2 明确允许处理并 ack 后重跑同一 complete，无需 `--drain-receipt`，Task 6b 这一点正确。CI 文件确实有 `pull_request -> main` 和 20 分钟 job timeout。
- **只读网络核对**：`gh pr list` 返回当前分支无 PR；`git ls-remote` 成功返回分支头。真实 GitHub 写入、未来冻结头 CI、Bridge 复审/完成及 driver 生命周期回执均为 **unverifiable（本轮未执行）**，不计为通过。未安装依赖，未运行产品测试套件，未调用真实 Bridge 写接口，未修改仓库文件或推送。

评审期间外部提交使工作区 HEAD 从 `c80095182fd83e3d1f35eddf066502e496d6436e` 变为 `e9590fd15ae12a74485f62455954488932217743`；上述 plan blob 始终未变。

## What's Good (Keep)

- 保留“README → 账本定稿 → milestone 最后提交 → 冻结头评审 → CI → 回报/交卷”的顺序，避免批准被后续账本 commit 作废。
- 保留 README 前缀、末行、唯一性、字节/行数、numstat 和提交数断言，以及每次 push 前的范围检查。
- 保留 `frozen` 对“milestone 不存在”和“Git 读取失败”的区分，以及跨 shell 重新推导 HEAD/PR 的做法。
- 保留 TURN、沙箱 remote、push-guard、禁止 force push/安装依赖/自行合并等边界；README 成功与 driver 生命周期证据分开表述也正确。
- 对重启演练而言，恢复检查的复杂度有依据。修订宜补齐现有两个恢复合同，无需另建通用执行框架。

## Issues & Recommendations

1. **[high] Task 0 拒绝真实 progress 崩溃残留，导致合法重启永久停在预检。**

   **位置**：[plan.md:163](/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-3033/engineering/doc/FLY-3033-n-to-n-restart-probe/plan.md:163)，关联 `prog` 的 49–54 行及 Task 0 的 117–145 行。

   **场景与证据**：Task 2/3/4 都会调用 `progress`。真实实现先持有 `<progress.md>.lock`，写 `<progress.md>.tmp-<pid>` 并 rename，再 git add/commit，最后才在 `finally` 删除锁；SIGKILL 不会执行 rollback/finally。见运行时 `progress.ts:183–206`、`383–429`。本轮使用真实 `runProgress` 和隔离依赖复现：

   | 中断点 | 遗留状态 | 原文 Task 0 重放 |
   |---|---|---|
   | 获取 progress 锁后 | `?? progress.md.lock` | exit 1，白名单外改动 |
   | 临时文件写完、rename 前 | 锁及 `progress.md.tmp-<pid>` | exit 1，白名单外改动 |
   | rename 后、git add 前 | ` M progress.md` 及锁 | exit 1，白名单外改动 |
   | progress commit 成功、清锁前 | 账本已提交，仅锁残留 | exit 1，白名单外改动 |

   Task 0 只回收 Git 的四类锁，只允许 README/milestone 脏文件；所以反复等待重跑仍失败。`progress` 自带的旧锁回收也无法触达。原 harness 的 progress 桩没有真实锁/临时文件，也没有在这些内部边界中断，因而未暴露问题。

   **建议**：在 Task 0 增加针对本单账本及其确切侧文件的恢复规则，并证明旧写者已退出；不能仅扩大白名单或按锁龄删除。将“游标已到位，可以跳过”的依据改为已提交且经校验的账本状态：当前 `prog` 读取工作区文件，若只放行脏账本，rename 后尚未提交的 `1/3` 也会被误判为完成并跳过。恢复后重新提交需要提交的账本，冻结后则只做必要清理并保持 HEAD 不变。把上述四个切点加入演练，要求完整重跑到最终断言成立，而不只是预期 STOP。

   **可重跑证据**：[review-restart-probes.py](./review-restart-probes.py)，本次结果 [results.json](/private/tmp/fly3033-review-_moiizxw/results.json)。运行时 session 权威在临时依赖中模拟；没有终止真实 runner 或操作真实状态库。

2. **[medium] Task 5 将新建 gate/request 当作无副作用重放，与 FLY-2920 的原身份恢复协议不符。**

   **位置**：[plan.md:319](/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-3033/engineering/doc/FLY-3033-n-to-n-restart-probe/plan.md:319)，关联 309–318 行。

   **场景与证据**：前体注册复审后被中断，或 Bridge 重启将原任务标为 `bridge_restart_retired`。计划只区分“已有 APPROVED”与“否则重新请求”，且声称注入的 gate 会立即通过、重复请求无副作用。实际 `gate review_code --no-block` 会插入问题并返回 `pending`（`gate.ts:209–218, 266–288`）；不带 `--request-id` 的 `request-review` 每次产生新 UUID（`request-review.ts:85`）。隔离实测：给第一个 gate 写入 APPROVED 响应后再次调用，仍产生另一个 pending question；对同一 question 两次注册也产生两个 requestId。后者仅验证 CLI 请求身份，未将 mock accepted 响应视为真实 Bridge 验证。

   对 interrupted review，真实注入合同明确要求检查 TURN、沿用原 `requestId`、`questionId` 和 repository binding，禁止新开 gate；`retry-held` 回原 gate 等待，`operator_required` 交 Lead。见 `packages/claude-runner/agents/codex-runner-contract.md:138–146`、`packages/edge-worker/src/Blueprint.ts:2734–2741`。协调器只有在命中原 requestId 时才进入 `acceptRetiredRetry`（`review-request-coordinator.ts:1489–1512`）。直接重跑新建序列不能证明恢复了原评审，还会改变或增加待处理身份。

   **建议**：删除“重复请求无副作用”的无条件结论，明确首次注册、已有 pending/answered gate、retired/held/operator-required 四类分支及原身份的恢复来源；优先使用注入协议的 `check` recovery hint 和原命令。已有批准应读取其权威记录并核对冻结头，不能把新建 gate 的 exit 0 当作批准。相同 execution 的重放沿用原绑定；execution 已变化时必须按引擎交接规则处理，不能把旧 execution 的绑定直接移植。保留“以注入指令为准”，但使本段自身与它一致，并补一项中断评审恢复演练。

   **可重跑证据**：[review-gate-probe.mjs](./review-gate-probe.mjs)，本次结果 [results.json](/private/tmp/fly3033-review-gate-80ifLW/results.json)。本轮在清除 `FLYWHEEL_*` 的子进程环境中执行；留存脚本也在调用前清除这些变量。所有 gate 数据落临时 CommDB，网络使用 mock fetch。

## Verdict

**CHANGES REQUESTED**

Finding counts: critical=0, high=1, medium=1, low=0; total=2.

修复账本中断恢复并校正 Task 5 的重放规则后复审；无需改动已经成立的 README 合同或冻结顺序。
