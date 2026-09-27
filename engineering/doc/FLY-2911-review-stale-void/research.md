# FLY-2911 评审作废止损 — 调研
Issue: FLY-2911 (https://linear.app/geoforge3d/issue/FLY-2911/token7-评审作废止损新-head-一推就停旧评审推送后静默-2-分钟再开评审撞额度的自动重试先核版本同一-gate-只留最新任务)
日期: 2026-09-25
基于: exploration.md

## 1. 需要的接缝（逐个核对过代码）

| 接缝 | 现状 | 需要的改动 |
|---|---|---|
| 中途停评审进程 | `defaultClaudeReviewSpawner` 已有 `killTree`（进程组 SIGKILL），只被超时 / 溢出调用 | `ClaudeReviewInvocation.signal?: AbortSignal` → spawner 监听 `abort` 调 `killTree`；结果新增 `aborted`；`runClaudeReviewRound` 返回 `{kind:"failed", reason:"aborted"}` |
| 运行中复查 | 无 | 协调器在 `runJob` 跑评审期间挂一个看门狗（默认 30 秒一次）：查 gate、查 head |
| 登记新请求时清旧任务 | `accept` 不看旧任务 | 新任务插入与「作废同一条线上的旧任务」放进**同一个事务** |
| 到点重试核版本 | `retryIfStillEligible` 只查 gate + head | 增加「同一条线上有更新的已受理请求」检查；gate 不开改为作废（带审计） |
| 推送后静默 | 无；`accept` 立即入队 | 任务行增加 `quiet_until`；`runJob` 在认领前检查，未到点就挂定时器；到点 head 变了就原地换冻结 head 并重新计时 |
| 审计 | 失败只写 `failure_reason`；无「谁取代了谁」 | 任务行新增 `voided_at`、`superseded_by_request_id`；同事务写 `session_events`（`review_job_voided` / `review_quiet_window_restarted`） |

## 2. 设计取舍与否决的方案

### 2.1 怎么发现「新 head」

| 方案 | 结论 |
|---|---|
| **看门狗轮询 `git rev-parse HEAD`（选）** | 与开跑前、交结论时的 head 复查是**同一个判定**，只是更早；`rev-parse` 毫秒级；不依赖外部事件 |
| runner worktree 装 git post-commit / pre-push 钩子 | 否：runner 规则禁止改 `core.hooksPath`；Codex runner 的 worktree 钩子不归 Bridge 管 |
| GitHub push webhook | 否：Bridge 没有公网入口；评审读的是本地 worktree，本地提交先于推送 |
| `fs.watch` 盯 `.git/HEAD` | 否：worktree 的 gitdir 在主仓 `.git/worktrees/<name>`，refs 可能 packed，macOS 事件不稳，复杂度高 |

防抖：一次读到不一致不算，**连续两次**（≥1 个周期）不一致才停，避免 rebase 中间态 / 临时 checkout 误杀。

### 2.2 「作废」存成什么

| 方案 | 结论 |
|---|---|
| **沿用 `status='failed'` + 新列 `voided_at` / `superseded_by_request_id`（选）** | 所有现有读者（巡检、重驱、outbox、census）把 failed 当终态，天然正确；新列只加不改 |
| 新状态值 `voided` | 否：`status` 有 CHECK 约束，要重建表；每个按 status 分支的读者都要改 |

原因词表沿用现有值，只新增一个：

| 触发 | failure_reason | 是否已有 |
|---|---|---|
| gate 被同执行的新 gate 取代 | `superseded_by_revision` | 已有 |
| gate 已被外部回答 / 跨执行取代 | `gate_answered_externally` | 已有 |
| gate 过期 / 丢失 / 不匹配 / CommDB 不可读 | `gate_expired` / `gate_missing` / `gate_mismatch` / `gate_unknown` | 已有 |
| 同一条线登记了更新的已受理请求 | **`superseded_by_request`** | 新增 |
| head 变了（看门狗 / 重试到点） | `head_moved` / `head_moved_exhausted`（走现有 FLY-2228） | 已有 |

`scripts/lead-patrol-snapshot.sh` 的 `REVIEW_JOB_FAILED` 排除表要加 `superseded_by_request`（否则被作废的任务会以「请用同 requestId 重投」出现在巡检里，这正是 9-25 Lead 看到的「旧任务仍在」）。**巡检脚本不引用新列**：脚本可能先于 Bridge 重启生效，新列那时还不存在。

### 2.3 「同一 gate / 同一条线」怎么界定

- 线 = `project_name` + `issue_id` + `review_type` + `target_repo_identity`；`issue_id` 为空时退回 `execution_id`。
- 为什么按 issue 而不是按 execution：现有 3 秒一轮的 `issue-gate-supersede` 本来就按「同 issue + 同 checkpoint 只留最新 gate」取代旧 gate；跨执行的旧任务在交结论时会撞 `gate_answered_externally`（FLY-2904 W9 的 21 个 / 3.73 亿）。本线定义**不宽于**这个扫描，所以不会作废它本来不会作废的东西。
- 「更新」按 **gate 的先后**（CommDB `(created_at, rowid)`，与扫描同一比较器）判定；同一道门上的多个请求按受理序号 `accept_seq`（plan v4；v2/v3 曾用任务行 rowid / 受理时间戳，均被 Codex 指出会倒置）。v1 曾按任务插入顺序，Codex R1 指出旧门请求晚到会反向作废新门的唯一评审，已改（见 plan §3）。
- **只有「已受理」的行能取代别人**。登记时 gate 校验不过的请求也会落一行 `failed` 审计行（例：`b94193db`，`gate_mismatch`），它不是有效请求。最终方案（plan v4）用整数列 `accept_seq`：NULL = 未受理，0 = 迁移前受理（先后未知），≥1 = 迁移后按受理顺序递增；继任与复用物化继承原请求的值。历史回填只标 0，判定「受理与否」用结构谓词 `status<>'failed' OR frozen_head_sha/target_path/target_repo_path 任一非空`（拒绝分支的插入从不传这三者，已核对 `accept()` 第 931–940 行与活库）。
- 本任务自己的 FLY-2228 继任（`head_move_parent_request_id = 自己`）不算「更新的请求」。

### 2.4 静默期：原地换 head 还是铸继任

| 方案 | 结论 |
|---|---|
| **静默期内 head 变了：原地 CAS 换 `frozen_head_sha` 并把 `quiet_until` 往后推（选）** | 任务还没开跑，没有会话、没有结论、没有复用绑定（复用只绑 `running` 任务，`findRunningCodexReviewJobForHead`）；不消耗 FLY-2228 的 2 次继任额度；每次换 head 写审计事件，旧 head 不丢 |
| 铸 FLY-2228 继任 | 否：连推 3 次就耗尽额度并告警「请开新 gate」；多一串行 |

「重新计时」的精确含义：到点时发现 head 变了，就从**发现的时刻**再等一个完整窗口。所以开跑时满足「开跑前至少一整个窗口内 head 未变」。窗口内来回推（A→B→A）不会被发现，这与交结论时的单点复查语义一致。

只对代码评审生效：issue 讲的是「推送」；设计评审的更新由「只留最新请求」覆盖。

### 2.5 并发与「谁最后写谁赢」

现在 `completeCodexReviewJob` 无状态守卫、`recordCodexReviewJobFailure` 只防 done/skipped。一旦允许外部作废一个 running 任务，下列竞态都会出现，必须堵上：

| 竞态 | 后果（不堵） | 堵法 |
|---|---|---|
| 作废落库后，评审结论恰好返回（`runJob` 在 `await tryDeriveHead` 等处让出） | 结论覆盖作废，并答 gate、写授权 | `completeCodexReviewJob` 加 `AND status='running'` 并返回是否写入；未写入则不答 gate、不写授权 |
| 被杀进程以非零退出 | 失败原因被覆盖成 `nonzero_exit`，甚至按额度排重试 | `aborted` 结果一律直接返回；`runJob` 内所有失败写入带 `expectStatus:'running'` CAS |
| 作废后同 requestId 被再 POST | 失败行被复活重跑 | `accept` 遇到 `voided_at` 非空直接 409（附取代者）；`claimCodexReviewJobRunning` 加 `AND voided_at IS NULL` |
| 作废后 head-move 路径又铸继任 | 作废的任务长出继任 | `failAndRequeueCodexReviewJobForHeadMove` 加 `AND voided_at IS NULL`，并支持 `expectStatus` |
| 重试定时器 / 静默定时器在作废后触发 | 重跑 | 作废清 `retry_at`/`retry_trigger`/`retry_parked_at_ms`/`quiet_until`；定时器回调再读行，认领 CAS 兜底 |

### 2.6 被杀的评审会话还能不能 resume

FLY-2228 继任会沿用父任务的 `reviewer_session_uuid` 并 `--resume`。被 SIGKILL 的会话 transcript 以未完成的回合结尾。Claude Code 对被中断的会话可以继续（会补中断标记）；找不到会话时已有「换新会话一次」的兜底。风险记为**未实测**；实现节点可选做一次本地小实验（起一个 `claude -p`，几秒后杀，再 `--resume`）确认。

### 2.7 不叫 Lead

作废是预期内的止损，只写日志 + 审计事件，不走 `emitReviewJobFailureAlert`。head-move 路径维持现状（FLY-2228 / d265aa951 有意通知属主 Lead）。

## 3. 能省多少（情景值，不是保底）

假设：评审 token 与评审进程存活时长成正比；看门狗延迟 ≤ 60 秒。

| 桶（FLY-2904 W9） | 观测 | 能被新机制截掉的比例 | 情景值 |
|---|---|---|---|
| superseded_by_revision 6.98 亿 | 44% 的评审时长发生在 gate 被取代之后；19 个在登记后 2 分钟内被取代 | 看门狗 ≈44%，其中代码评审 14 个另被静默期整单拦下（与看门狗重叠，不相加） | ≈3.0 亿 |
| head_moved 4.59 亿 | 38% 的时长发生在新提交之后；10/48 新提交在登记后 2 分钟内 | ≈38% | ≈1.7 亿 |
| gate_answered_externally 3.73 亿 | 回答时刻只查到 4/21 | 未知 | 不计 |
| 失败 / 其它 0.76 亿 | — | 到点核版本只防重跑，不省已花的 | 不计 |

合计情景值 ≈ 4.7 亿 / 14 天（观测集合 × 明示比例；gate 被外部回答那一桶有收益但无法估）。

## 4. 测试可行性

- `review-request-coordinator.test.ts`（5,745 行）已有 `reviewRound` / `deriveHead` / `setTimer` / `now` 注入，可以完全确定性地驱动看门狗与静默期（假定时器）。
- `StateStore.codex-review.test.ts` 覆盖 CAS 与迁移。
- `claude-review-runner.test.ts` 已有假 spawner，可测 abort → killTree。
- 9-25 序列可以做成一个回放夹具（五个请求、四个 gate、两个执行），不依赖本机活库。
- 本机负载很高（实测 load1 135），只跑这三个文件 + 巡检脚本相关测试。
