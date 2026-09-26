# FLY-2893 Codex 体为什么老出事 — 实施计划
Issue: FLY-2893 (https://linear.app/geoforge3d/issue/FLY-2893/调研修-codex-体为什么老出事近两周每次-codex-体死掉-换体-被判死按原因分类计数-各类浪费的时长与额度-前三类修掉)
日期: 2026-09-25
基于: research.md

## 0. 交付物与边界

- `evidence/scripts/`：`collect.py`（只读导出原始数据）、`usage.py`（rollout / transcript 的 token 与时间线）、`classify.py`（出事清单、归类、浪费计算）、`build_report.py`（生成 HTML）。
- `evidence/raw/*.csv`：原始导出。只留数字、id、时间、错误原文摘录（最多 200 字符，家目录替换成 `~`，邮箱保持源数据里已有的打码）。
  不含消息正文、凭据、命令参数。`evidence/raw/freeze.json` 记录冻结点。
- `evidence/derived/`：`incidents.csv`（一行一个出事执行体）、`classes.csv`（每类汇总）、`vendor_compare.csv`、`review_job_failures.csv`、`unclassified.csv`。
- `report.html`：一页，每节带评论框，页底有「复制全部评论」。用 `publish-report --publish-only` 发布，URL 交给 Lead 投递。
- **不改任何生产数据。** SQLite 一律 `mode=ro`，Linear 只读，本机只跑这四个脚本。修复不在本单，只给建议。

## 1. 窗口与冻结

- `T1 = 2026-09-25T22:00:00Z`，`T0 = T1 − 14 天 = 2026-09-11T22:00:00Z`。
- 总体 = `workflow_execution_runtime.created_at ∈ [T0, T1)` 的全部执行体（Codex 和 Claude）。
- teamlead.db 有 4 GB，不复制。改为在 collect 开始时记下 `max(workflow_run_event.id)` 和 `max(session_events.id)`，之后所有查询都加 `id ≤ 冻结值`，这样重跑能得到同一份数据。
  接上时间要看到 T1 之后的事件，所以事件查询的截止用冻结 id，不用 T1。
- rollout / transcript 只读 `timestamp ≤ 冻结时刻` 的行。

## 2. 什么算「出事」（每个执行体最多一条主记录）

一个执行体只要满足下面任意一条，就记为出事。**出事时刻 `t_i`** 取所有命中信号里最早的那个时间。

| 代码 | 信号 |
|---|---|
| S1 | 有 `session_failed` 事件 |
| S2 | 有 `execution_dead_rolled_back` 事件，且 execution_id 就是本体（被引擎判死） |
| S3 | 有 `unlaunched_admission_rolled_back` 事件（起跑失败） |
| S4 | `sessions.status='blocked'` |
| S5 | run 被 `run_terminated_by_operator` 收掉，且本体是那一刻该 run **最新创建**的体：还活着（terminal_at 为空，或不早于终结前 60 秒）、节点没有 completion、会话也没报过 completed。同一 run 里被顺带收掉的其他体（比如因实现死结被终结的 run 里停驻的 QA 体）**不算** |
| S6 | 会话 `terminal_at` 之后超过 2 分钟，同一线程的 rollout 里还有 `token_count`（复活，或终态后自己续跑） |

**非故障换体，单列、不算出事率：** 判死原因是 `actor_session_terminal:completed`，并且这个体之前已经 `session_completed`（正常交卷），之后才因为 land 冲突再激活。
**正常收尾，不算：** ship 之后的 closeout 收掉（reason 是 `FLY-1185 lifecycle closeout` 或 `DAG workflow ship finalization`）。
**founder 改范围或清理（S5 的 reason 属于直令关单、superseded、ghost、duplicate、清理）：** 归入 K0 非故障，理由是这不是载体出了问题。

S6 只作为附加标记。如果这个体已经因为 S1–S5 出事，它就只是加一个「终态后仍消耗」的标记，不另起一条记录。

## 3. 按根因归类（class_key，沿用 FLY-2072 口径）

规则按优先级从上往下匹配，命中第一条就停。**错误原文按这个顺序取**：transcript 最后一条 `[error]`（codexErrorInfo 和 message）→ `session_failed.lastError` → `sessions.last_error` → 判死 reason。

| 类 | 判据 | 已有病根单 |
|---|---|---|
| K1 账号额度墙 | codexErrorInfo=usageLimitExceeded，或 failureKind=goal_usage_limited，或 S5 的 reason 里写着额度 / usageLimited | FLY-2371、FLY-2521、FLY-2572、FLY-2729 |
| K2 上游模型满载 | serverOverloaded / 「at capacity」 | FLY-2630 |
| K3 Codex 凭据与身份 | unauthorized / refresh token、`auth.json … ENOENT`、`unknown Codex account identity`，或 S5 的 reason 里写着「号识别故障」 | FLY-2750（已修）、FLY-2404、FLY-1896；是否另立新类按实测判断 |
| K4 cyber 400 | invalid_request_error 并且含 cyber / access_programs | FLY-2743 |
| K5 重启后 reown 失败 | failureKind=reown_exhausted、「recovery owner failed after commit」、episode_exhausted / owner_failed_*、turn reconciliation、keyed_home_reown_arm_mismatch、launch_snapshot_mismatch | FLY-2586、FLY-2505、FLY-2558、FLY-2352、FLY-2462 |
| K6 worktree 接管失败 | failureKind 或 lastError 里有 worktree_takeover_failed | FLY-2510、FLY-2463 |
| K7 agent home lease 缺失 | 「codex agent home lease missing」 | FLY-2689 |
| K8 宿主子进程与 git 异常 | 「Child stdio did not close」、GitResultChecker git 错误 | FLY-2617；GitResultChecker 是新类 |
| K9 体自报 blocked | goal_blocked 或 status=blocked，而且**没有**上游 `[error]`。子因按 rollout 最后一条 assistant message 的关键词分：Lead 冻结或暂停 / 依赖 PR / CI 计费 / no-turn 或注册缺失 / 529 房 / 其他 | FLY-2344、FLY-2507；「三轮核验后自报 blocked」整体可能是新类 |
| K10 停驻超时 | 判死 reason=resident_hold_expired | FLY-2477、FLY-2710 |
| K11 无错误原文的判死 | terminal_session_and_dead_probe 或 persisted_target_missing_*，而且所有来源都没有错误原文 | FLY-2537、FLY-2512、FLY-2618（按 pane 丢失等旁证再细分） |
| K12 运维收掉：引擎死结（没有其他信号） | 只命中 S5，reason 不属于 K1 / K3 / K5 / K6 / K0。子类按 reason 原文分：完工死锁（FLY-2373）、返工 wake 耗尽（FLY-2821）、未铸体死结（FLY-2329）、其他 | FLY-2373 · FLY-2821 · FLY-2329 |
| K13 终态后复活 | 只命中 S6 | FLY-2814、FLY-2572 |
| K0 非故障换体 | 见 §2 | —— |
| K? 未归类 | 以上都不命中 | 进 `unclassified.csv`；**覆盖率低于 95% 就停下，补规则再跑** |

同一个 run 在同一分钟内有多个体死于同一类（比如额度墙的批量死亡），按执行体分别计数，另外再给出「批次数」（同一类、间隔不超过 10 分钟的算一批）。

## 4. 浪费时长（单位：单 × 节点小时，**不是**舰队墙钟）

- **接班者**：同一张单（issue_identifier）、同一节点角色、`created_at > t_i` 的第一个执行体，**跨 run、跨 vendor 都算**（Lead 终结后重派、改用 Claude 接力也算接上）。
- **接上时刻 `t_on`**：接班者 rollout 里第一个 `token_count`（Codex），或 transcript 里第一条 assistant 消息（Claude），时间都要 ≥ 接班者的 created_at。
  找不到时，退回用接班者 `session_started` 之后第一个 session_event，并标记 `t_on_fallback`。
- **本次浪费**：`t_i → min(t_on, 接班者自己的 t_i)`。如果接班者还没接上就又出事，后面那段记到接班者名下。这样同一条链上的各段首尾相接，不会重复计算。
- **没有接班者**（单被关掉、run 永久 held，或截至冻结时还没重派）：不计入主数字，单独列出条数和敞口时长（`t_i → 冻结时刻`）。
- **停驻后才被需要**：出事时本体的节点已经 completion（停驻中死掉），当时不耽误任何事，所以浪费从引擎真正要用它的那一刻（之后的 `execution_dead_rolled_back`）算起；如果之后引擎没再要它，就记 0，标 `n/a_parked_after_completion`。
- **拆出其中的人工等待段**：区间内如果 run 进过 held（`retry_limit_escalated` / `unlaunched_admission_alerted` / held 形状的告警），从进 held 到下一个运维动作或接班者创建的这一段，单独列成「其中等人手」。
- **不扣 founder / Lead 的问答等待。** 理由：这段区间本来就是「本该有体在干活、实际没有」的时间，等人手本身就是出事造成的损失。
- 同一个（issue, node）上的区间如果重叠，取并集；重叠部分归给最早的那次出事。

## 5. 浪费额度（能算的都算，算不了的写原因）

- **Q1 死体本身的消耗（上界）**：出事执行体在 `t_i` 之前的 token 总和。之所以是上界：死体推送过的提交，接班者可以直接接着用。
- **Q2 接班者第一回合的消耗（重建成本的代理，下界）**：接班者 rollout 里第一个 task_started 到 task_complete 之间的 token。
- **Q3 终态后的消耗**：会话进入终态 2 分钟以后，同一线程仍在消耗的 token。**所有类都算**，不只 K13；已判死或已收掉的体还在烧额度，本身就是 FLY-2572 / FLY-2814 的形状。
- **盲换具数**：每类引出的、自己也在接上之前就死掉的替身数量。这个数不依赖 token。
- 折算成额度：token 用 FLY-2889 的 fingerprint 方法（`rate_limits.primary.used_percent` 的变化 ÷ 同时段 token）折成「占该号周额度的 %」。这是情景估算，写明误差来源。
  **Claude 侧只给 token，不折算。** 理由：Claude transcript 里没有同类额度读数。

## 6. Codex 与 Claude 同口径对比

按节点角色（implement / eng_design / qa / 其他）分层，每层给：执行体数、出事执行体数（不含 K0）、出事率、每个（issue, node）平均执行体数 −1（全部重派），以及其中由出事引起的重派数。
分母小于 30 的层只列数字，不下结论。另外给一张同期（issue, node）粒度的「至少出过一次事的比例」。

## 7. 评审子进程

`codex_review_job` 按 status=failed 和 failure_reason 分组。superseded_by_revision / head_moved / gate_answered* 算正常作废，**不算出事**。
nonzero_exit / no_verdict / 空原因单独成表，按评审方族（author_family 的对侧）归属，不并入 K 类计数。

## 8. 前三类的排名与修法建议

按「已接上的浪费时长合计」排名，平手时看出事体数。每类写四件事：根因（引用代码位置或病根单）、最小修法、预计节省（按该类 14 天实测浪费 × 修法能覆盖的比例，给区间）、风险。
修法以复用已有病根单为主，建议由 Lead 决定开不开单。

## 9. 自检（缺一不交）

1. `Σ classes.count == incidents.csv 行数`；每类计数都能在 incidents.csv 上用 `grep class_key` 数出来。
2. 未归类率低于 5%。
3. 随机抽 10 条出事记录，人工对照原始事件和 transcript 核实 class 与 `t_i`，结果写进 `evidence/derived/spotcheck.md`。
4. 浪费区间不重叠（脚本里断言）。
5. 从空目录重跑 collect → classify，得到的 incidents.csv 字节级一致（冻结 id 生效）。
6. 避开 FLY-2889 已踩过的坑：scorecard 的累计值不直接相加，token 一律从 rollout 差分得出；同一张单重派后的 run 不当作独立样本，对比全按（issue, node）计。
7. 报告里每个数字旁边都注明分母和口径，不写比证据更强的结论。

## 10. 步骤

1. collect.py：导出原始数据，写冻结点。
2. usage.py：逐执行体的 token、第一个 token 时刻、终态后 token、第一回合 token。
3. classify.py：生成出事清单、归类、浪费区间、各类汇总、vendor 对比，然后跑自检。
4. 人工抽查 10 条，写 spotcheck.md。
5. build_report.py 生成 report.html，发布（publish-only），在线上 URL 上自测（HTTP 200，不残留占位符，390px 宽不出现横向滚动）。
6. 开 docs PR，然后 `complete --route needs_review --pr <N>`，URL 放进完成摘要交给 Lead。
