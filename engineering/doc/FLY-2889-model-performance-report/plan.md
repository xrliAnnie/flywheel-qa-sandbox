# FLY-2889 模型表现报告 — 实施计划（统计口径）
Issue: FLY-2889 (https://linear.app/geoforge3d/issue/FLY-2889/模型表现报告-设计-实现-qa-各节点分流的各模型正确度速度花费三维度实测-结合额度给调整比例的建议一页可评论-html)
日期: 2026-09-25
基于: research.md

## 1. 交付
- `scripts/collect.py`：只读查询生产 teamlead.db / CommDB / Codex rollout 的额度字段，导出 `data/*.csv|json`（数值用量可导出；不含消息正文、认证 token/凭据、命令参数）。
- `scripts/analyze.py`：由导出数据算出全部指标 → `data/metrics.json`。
- `report.html`：一页浅色完整 HTML，每节评论框 + 底部「复制全部评论」（FLY-2881 v3 做法），`publish-report --publish-only`。
- 不改 models.json、代码、配置；不跑测试套件。

## 2. 范围、入组与分段
- 入组（cohort）：节点片段的**首次 admission**（该 run/node 最早 runtime.created_at）落在 `[T0, T1)`；T0=`2026-09-08T19:18:20Z`（第一条 `design_model_arm_assigned`），T1=采集时刻。入组后该片段的全部 attempt 都追溯到 T1，结果一律「截至 T1」。T1 之后的数据不读：teamlead.db 在单个只读事务里取快照，所有时间条件 `< T1`；CommDB 同样按 `< T1` 截断。
- 节点：eng_design / implement / qa / general；项目：所有 workflow 项目（计数按项目列出）。
- 分组键：节点角色 × `vendor/model/effort`（`workflow_execution_runtime`，不从别名猜）。
- 分层，**层与层不合并出赢家**：
  - O 层（观察）：全部入组片段按实际模型。实现/QA 的模型是按日期整体切换的，O 层只是描述，受时间与单子难度混杂；报每日模型构成作背景。
  - L 层（旧设计分流）：有 `design_model_arm_assigned` 且 runtime 模型=分组模型。旧规则比例在 09-20~09-24 多次改动（75/50/0/100/0），**按比例版本再切时间段**报；某段 100%/0% 给单一模型的属确定性分配，只作观察。
  - N 层（新分流）：`model_arm_assigned`（09-24 23:15Z 起，按单+节点稳定哈希，跨 run 继承），policyVersion 单独列。这是按稳定哈希分桶的一层（确定性分桶，不宣称已证随机独立），样本很小；policyVersion 不止一个时分表。O 包含 L/N，三表不能相加或互为独立验证。
  - 有 arm 但 runtime ≠ arm 模型：单列 `arm_not_honored`/降级，不进任一组。新规则生效后没有 arm 的片段记 `unassigned`（固定默认节点如 general 本来就无 arm），**不**称人工覆盖。
- 样本门槛按**独立单数**（同单多次 run 只算一个单）：< 5 单标「样本太少」，只列原值不排序。run 级指标注明是按运行加权。

## 3. 统计单位
- 汇总单位：节点片段（run_id, node_id）；同片段多个模型 → `mixed`，单列。
- 速度单位：attempt（run_id, node_id, attempt），见 4.2。
- 噪声（4.4）以片段为单位；**完整样本为主表**，「剔除噪声后」只作敏感性视图，并列出每类剔除数（剔噪可能筛掉某模型更容易撞上的死会话）。

## 4. 指标定义
### 4.1 正确度（均为流程结果代理，不是模型固有正确率）
- **评审首轮结果**只用有逐轮事实的来源：`codex_review_job`（status=done 的每一行是一轮真实 verdict）。分母 = 截至 T1 已取得至少一条有效 verdict 的片段（以 responded_at 判 < T1），另列「只发起请求、无有效 verdict」的片段数，不记失败；同 created_at 用 request_id 定序；首轮 = 按 created_at 最早的 done 行；「轮数」= 到首个 APPROVED 为止的 done 行数，从未 APPROVED 的单列「截至 T1 未通过」，其首轮仍计为失败。failed 行是基础设施失败，不算轮。
- 按**作者家族 × 评审家族**分层列出（`author_family` + `same_family_sanction`：Claude 作者在本窗大多由 Claude 同家族应急审，Codex 作者由 Claude 审）；跨评审家族只描述「流程通过率」，不据此给作者模型排正确度名次。
- runner 自报的 `codex_review_record.rounds`（只在批准时写）只报「批准回执中的自报轮数」分布，不计算首轮通过率；transcript 中的评审调用次数不采用（证明不了 verdict）。无逐轮来源的设计片段（Claude 作者自跑的设计评审）记「拿不到：逐轮 verdict 只在已清理的 worktree 回执里」。
- **实现 QA 首过**：片段内全部 producer execution 被 QA 判的**最早**一条 QA claim（按 server_seq）为 qa_passed；分母 = 截至 T1 已有 QA claim 的实现片段，另列尚未到 QA 的片段数。**被 QA 打回次数** = 该片段 producer 收到的 qa_failed 条数（同一 head 多条只算一次）。
- **QA 节点「后续返工/绕过信号」**（不叫「判决被推翻」）：
  - pass 信号：该 qa_passed 的 subject head（`subject_digest`）在 founder_gate 被判 `rework`（`workflow_founder_gate_verdict.head_sha` 相同）。分母 = 该 head 已有 founder 判决的 pass；尚无判决的 pass 单列「未到审」。该信号包含需求变更等非 QA 错误，也可能漏掉 founder 没发现的问题，不能解释为 QA 错误率。
  - fail 信号：qa_failed 之后、同 run 下一条 QA 判决之前，出现 `authority=lead, source_node=qa` 的改判，或同一 head 直接 founder_approved。
  - land/CI 在 pass 之后被 engine 打回单列参考，不算 QA 信号。
  - 每条判决最多计一次，只关联它之后、下一条 QA 判决之前的事件。
- general 节点无适用的正确度事实，显示 N/A。

### 4.2 速度（截至 T1 已完成 attempt 的条件分布）
- attempt 活跃区间：该 attempt 最早 binding（spawn/wake/replacement）`bound_at` → 该 attempt 的完成（implement/design/general 用 `workflow_node_completion`；QA 用该 attempt 的第一条 QA claim）。**不用片段外包络**，所以实现返工之间的 QA / founder 等待不会计入实现。
- 在区间内扣除（各段取并集后一次扣，防重复）：①该 attempt 执行发起的阻塞问题（CommDB checkpoint∈question/founder_review/approve_to_ship，created_at→首条 response，无 response 则到区间末）；②重启中断：`execution_dead_rolled_back` / `resume_target_unrecoverable` / `rework_pane_loss_handoff` → 下一条 binding；③额度暂停：两张暂停表 0 行 ⇒ 写「无已记录的可扣暂停」，不宣称不存在额度等待。评审往复不扣（两家族都含评审循环），写明。
- 报：attempt 1 与返工 attempt 分开；中位数 + P90（最近秩），同时报 attempt 单位的「完成数/入组数」、未完成 attempt 数量与独立单数；样本不足只列原值。不据此下「整体更快」的结论，只在完成率相近时比较。
- 成功交付时长（run 创建 → `run_completed`）：扣 founder gate 停留段，结束点只用权威事件——同 run 同 gate attempt 的 `workflow_founder_gate_verdict.recorded_at`（approved 或 rework），裁切到 run 区间；找不到 verdict 的 gate 段不扣并计数「未扣段」（`gate_holder.updated_at` 是行维护时间，不用）。再与 ①② 取并集一次扣除。同时报原始墙钟。只作「已成功 run 的条件描述」，按运行加权，不含同单先前失败 run。

### 4.3 花费（作者执行自身用量）
- **单一来源 = 原生 transcript / rollout，按执行逐个定位**，全窗口同一口径（不混用 scorecard 表，避免跨来源重复）：
  - Claude：`~/.claude/projects/<cwd slug>/*.jsonl` 中 `prompt_snapshot` 附件含 `--exec-id <execution_id>` 的文件（09-08 早期无该附件的，退而要求 exec-id 出现且文件首条时间在执行 created_at 后 60s 内）；按 message.id 取最后一行 usage，跳过 `<synthetic>`；input / cache_read / cache_write / output 互斥相加。主 transcript 为主口径；`subagents/*.jsonl` 另列（真实花费含它）。
  - Codex：`~/.flywheel/state/codex-sessions/<exec>/session.json` 的 threadId → `rollout-*-<threadId>.jsonl`（同一 threadId 的副本按文件名去重，不相加）；`total_token_usage` 相邻差分；total = input+output（cached ⊂ input、reasoning ⊂ output）。计数回落：只在新 turn 边界处按 FLY-2789 importer 的同一规则视为新段；其他位置的回落记为该执行 `counter_anomaly`，该执行不进确切汇总。报告回落次数。
  - 早期（09-08）无 prompt_snapshot、只靠「exec-id 出现 + 60s 邻近」匹配的 Claude 文件是**候选归属**，单列计数，不进确切模型汇总。
  - 方法校验：凡 FLY-2789 scorecard cursor 为 complete 的执行，逐执行比对回填 total 与 scorecard `normalized_delta` 之和，差值明细存 `data/validation_scorecard_vs_raw.csv`（仅执行 id、vendor、两种计数、差值）。
- **覆盖按执行判，但只称「已观测作者用量」**：片段内每个实际启动的执行都定位到文件 ⇒ `files_located_all`（文件定位覆盖 100%，**不等于**用量完整：进程被杀、尾部未写完等仍可能少记）；任一执行找不到文件 ⇒ `partial`（下界），列出缺失执行数与原因；整片段无文件 ⇒ `missing`。不为找不到的执行补零。T1 时仍在写的执行标 `open`。所有花费数字的标签都是「已观测作者用量（主 session）」，不称执行总成本；subagent 用量另列，不加进主表。
- 旁路 reviewer（Bridge 评审作业）的用量不在作者文件里，不计；Claude 作者自跑 Codex 评审的 Codex 用量也不在作者 Claude 文件里。两家族都只计作者本身，写明。
- 额度折算只给**情景估算**，不作排序依据：
  - Codex：**「reset 时间桶的假设系数」，账号归属未验证**。rollout 的 token_count 事件带 `rate_limits.primary`（仅取 window_minutes=10080）的 used_percent 与 resets_at，按 resets_at 分桶；**假设**同一桶来自同一账号的同一周窗（当前账号表里恰有一个账号的 `weekly.resetAt` 与之相同只作旁证，不作身份证明；多个账号同时匹配或矛盾时该桶不出系数）。Δ百分点 = 桶内首次到达最大值时读数 − 起点读数；token = 同一时间区间内该桶全部 rollout 的 total_token_usage 增量（按原生 thread 去重、逐文件差分）。给出「每个百分点 ≈ 多少 token」（total 与 uncached+output 两口径）的区间，及其乘到作者已观测 token 上的「假设性百分比区间」；数字旁明示「假设、未验证账号归属、不用于排序」。没有可用 primary 周窗的，写「无可用周窗」。
  - Claude：无执行→账号绑定，网页端用量不可见 ⇒ 片段级百分比记「拿不到」；只报 token 与各账号当前周读数（带读数时间与重置时间）。
  - Claude 与 Codex token 不可直接比较。

### 4.4 噪声
片段标记：执行被判死/换体/resume 失败/unlaunched 回滚、多执行、mixed、arm_not_honored；Codex 池耗尽只在有界 incident 时间窗内且为 codex 片段才标。

## 5. 建议的产出方式
每个角色：当前比例 → 各层结果（样本不足的不排序，允许结论为「不足以判断优劣」）→ 结合额度（建单时：Codex 只有 school 有余量、Claude business 本周 ~89%；报告以采集时各账号最新读数及其时间戳、重置时间为准）给**具体新比例**（可以是额度约束下的小规模试运行比例）、理由、不确定性，交 founder 拍。

## 6. 验证
- 抽样人工对照事件时间轴（至少含一个 replacement 片段、一个多 attempt 返工片段、一个跨 scorecard 启用时刻的片段），核对区间、扣除项与用量完整性标记。
- 所有计数可由 `data/` 下导出文件复算；metrics.json 带 T1 和每项样本数。
- HTML：完整文档、浅色、手机宽度不横向滚动、评论框可复制；发布后 curl 200。
