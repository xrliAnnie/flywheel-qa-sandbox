# FLY-2893 Codex 体为什么老出事 — 调研
Issue: FLY-2893 (https://linear.app/geoforge3d/issue/FLY-2893/调研修-codex-体为什么老出事近两周每次-codex-体死掉-换体-被判死按原因分类计数-各类浪费的时长与额度-前三类修掉)
日期: 2026-09-25
基于: exploration.md

本文件只回答三个问题：数据从哪里来、每个信号实际是什么意思、根因能在哪一层读出来。
所有读取都是只读的：`teamlead.db` 用 `file:…?mode=ro`，rollout 和 transcript 只读文件，Linear 只跑 GraphQL 查询。

## 1. 数据源地图

| 要的量 | 来源 | 实测要点 |
|---|---|---|
| 执行体名册（vendor / model / 节点 / run / attempt / 创建时间） | `workflow_execution_runtime`（只追加） | 窗口内 Codex 694、Claude 约 320；`sessions.vendor` 为空，**vendor 只能从这张表取** |
| 会话终态与原文 | `sessions.status / last_error / terminal_at / issue_identifier` | status 有 completed / failed / terminated / blocked / running / ship_parked |
| 失败原文（首选） | `session_events.event_type='session_failed'` 的 payload：`failureKind` 和 `lastError` | Codex 452 条；failureKind ∈ goal_usage_limited / reown_exhausted / worktree_takeover_failed / goal_blocked / 空 |
| 引擎判死 | `workflow_run_event.kind='execution_dead_rolled_back'`，execution_id 是死体，payload 里有 `reason` 和 `newExecutionId` | reason ∈ terminal_session_and_dead_probe / actor_session_terminal:{completed,failed,blocked} / resident_hold_expired / persisted_target_missing_and_dead_probe |
| 换体链 | `writer_replacement`（execution_id 是新体，payload 里有 deadExecutionId）、`rework_replacement*`、`repeated_dead_execution_pattern`（deathNumber）、`retry_limit_escalated`（盲换预算用尽，run 进 held） | |
| 起跑失败 | `unlaunched_admission_rolled_back`；对应的 session_failed 通常是 worktree_takeover_failed 或空 | |
| 重启恢复失败 | session_events `reown_revive_failed`、`reown_turn_reconcile_failed`；failureKind=reown_exhausted | |
| 运维收掉 | `run_terminated_by_operator`（payload.reason 是 Lead 写的原文）；session_events `lead_close_runner.reason` | 被收掉的 run 大多是额度死链、「Codex 号识别故障」、FLY-2329 死结 |
| Codex 真实错误（lastError 不够时） | `~/.flywheel/state/codex-sessions/<exec>/transcript.log` 尾部的 `[error] {…}` 行（`codexErrorInfo`、`message`）和 `── run ended: <status>` | 旧版 adapter 的 lastError 只写 `goal ended non-complete: blocked`；真因（比如 serverOverloaded）只在 transcript 里 |
| 体自报 blocked 的理由 | rollout（`session.json.threadId` → `rollout-*-<threadId>.jsonl`）里最后一条 assistant message | 613/694 个 Codex 执行体能找到 rollout |
| token 用量与时间线 | rollout 里的 `event_msg/token_count`（累计 `total_token_usage`，和 `rate_limits.primary.used_percent`） | 沿用 FLY-2889 `usage.py` 的做法：累计值取差分，计数器回落时按新段从 0 算 |
| Claude 对照 | 同一组表；Claude 的 transcript 在 `~/.claude/projects/<slug>/*.jsonl` | Claude 体不走 goal runtime，没有 usageLimited 或 goal_blocked 这类路径 |
| 评审子进程 | `codex_review_job`（status=failed + failure_reason） | 窗口内失败 173 条，其中 superseded_by_revision / head_moved / gate_answered_externally 是正常作废；基础设施失败只有 nonzero_exit 8 和 no_verdict 6 |
| 病根子单 | Linear FLY-2072 的 150 张子单（标题、描述里的 class_key） | 快照存进 evidence |

没有采用的数据源：

- **Bridge 日志**（`/tmp/flywheel-bridge.log*`）按 10 MB 滚动，现在只剩约 8 小时，覆盖不了 14 天。
  FLY-2814 的直接证据（`daemon died mid-goal — restart n/5`）因此拿不到。改用间接信号：「会话终态之后 rollout 里还有 token_count」。
- **comm.db**（`~/.flywheel/comm/<project>/comm.db`）只在 FLY-2889 用来扣 founder / Lead 的等待。本单的分类不需要它；
  浪费时长也**不扣**等待，理由见 plan §4。

## 2. 信号的实际含义（抽样核实）

1. **`actor_session_terminal:completed` 不是故障。** 抽查 3 例（FLY-2490 21f3edef、FLY-2807 f4c9594c、FLY-2808 9cf1770e）：体已经正常 `session_completed`（route=needs_review），
   后来 land 撞上合并冲突（`land_conflict_resolution_started`），引擎要重新激活 implement，旧体已终态，只能换体。
   这一类单独列为「非故障换体」，不算进出事率。Claude 也有 12 例同样情况。
2. **usageLimited 是账号额度墙。** transcript 里是 `codexErrorInfo=usageLimitExceeded`，「You've hit your usage limit」。
   它成批出现（09-18 02Z 一小时 35 次），替身起跑就死（tokens=0），盲换 3 具后撞 `retry_limit_escalated`。形状和 FLY-2371 完全一致。
   FLY-2521 已查明自动切号子系统在宿主上没部署完成。
3. **goal_blocked 要拆成两种：**
   - 上游错误：transcript 有 `[error]`。已见到 serverOverloaded「Selected model is at capacity」（FLY-2630）、unauthorized「refresh token」、
     invalid_request_error（cyber 400，FLY-2743）。例：FLY-2570 10238c22 的 lastError 只写 blocked，transcript 里是 serverOverloaded。
   - 体自报 blocked：transcript 没有 `[error]`。rollout 最后一条消息的形状基本一致：「连续三轮核验同一外部阻塞 → 按 goal 三轮门槛标 blocked → 已报告 Lead」。
     阻塞原因有：Lead 冻结 / 暂停指令、依赖 PR 未合、GitHub Actions 计费封锁、TURN 为 no-turn 或执行注册缺失（引擎侧）、529 房起不来。
     **体自报 blocked 之后，adapter 把它当失败，引擎判死换体**（`terminal_session_and_dead_probe`）。这是 Codex 独有的机制：Claude 体在同样处境下只是停着等。
4. **failureKind 为空的要看 lastError 原文**，已见到的有：
   - `Codex source auth is unavailable at ~/.codex/auth.json: ENOENT` 和 `unknown Codex account identity`：9-18 的「Codex 号识别故障」，founder 直令保全后重派的就是这一批。
   - `Codex recovery owner failed after commit`：重启后 reown，FLY-2586 / FLY-2505 族。
   - `Child stdio did not close within 250ms`：新类，待看。
   - `codex agent home lease missing`：FLY-2689。
   - `[GitResultChecker] Unexpected git error … Child …`：新类。
   - 空 lastError 且 status=failed：要去 transcript 里找。
5. **引擎判死链的死因号（deathNumber）和 `retry_limit_escalated`** 可以还原「一次出事连带盲换了几具」。
   Lead 事后终结 run 再重派（`run_terminated_by_operator`）会跨 run，所以「下一个体」必须按同单、同节点角色跨 run 去找。
6. **复活（FLY-2814）**：按代码（`codex-daemon-goal-runtime.ts` 的 runGoal catch），只要 `!this.stopped` 且是传输死亡，就最多换号 resume 5 次。
   只看数据库是看不到的；间接信号是「会话 terminal_at 之后，同线程 rollout 还有 token_count」。

## 3. 同口径对比要注意的地方

- Codex 以 implement 为主（646/745 次派发），Claude 以 qa 为主（231/361）。**必须按节点角色分层比**，不然节点构成差异会冒充载体差异。
- Claude 的 implement 只有 62 次派发，样本小；比较时要写出分母，不给置信结论。
- 同一张单重派后，新 run 会在旧分支上继续干（见 FLY-2889 的教训），所以「出事率」按**执行体**算，同时给「每张单 × 节点的额外执行体数」。

## 4. 已知的缺口

- 52 个 Codex 执行体没有 `session.json`，29 个没有 threadId，大多是起跑失败。它们的 token 记 0，并标注「无 rollout」。
- Codex 订阅的 token 没有单价。额度只能折成「占账号周额度的百分比」，按 rollout 里 `used_percent` 和 token 的比值估算（沿用 FLY-2889 的 fingerprint 方法），这是情景估算。
- 浪费时长里包含 Lead / founder 的反应时间（比如 retry_limit hold 之后等人手 resume）。这部分是真实损失，不扣，但会单独列出「其中人工介入等待」。
