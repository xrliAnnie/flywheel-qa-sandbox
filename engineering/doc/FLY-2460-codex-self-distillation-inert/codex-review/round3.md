# Design Review — plan.md (Round 3)

Date: 2026-09-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 已经实质关闭 Round 2 的七组显式反馈：承诺拆成 `stage1_done`/`readable_ready`，Lead 对 keyed E4 的新裁定有明确引用，候选改成只负责触发的 `hints`，deadline 与 goal timeout anchor 分开，负观察不再伪装成确定事实，`liveLease` 已删除，批上限与 token schema 也已纠正。admit-time 架构本身可实施，且没有重新引入 closeout、lease fence、旧家回填或 FLY-2359 transport 改动。

但本轮对 Codex 0.153.2 的成功落库路径做了进一步核对，发现顶层两个成功状态仍会产生假阳性。Codex 可以把没有任何 `stage1_outputs` 的 stage1 job 标成 `done`；global phase2 `done` 也不能证明本批/上一执行的 output 被选入该次 consolidation。再加上计划明确让 `expectedButUnclaimed` 不影响成功状态，回执可能声称“上一批已持久化/上一任首轮可读”，实际却没有对应输出或没有覆盖上一任。这是状态合同与本单产品承诺的正确性问题，不是重开已关闭的 admit-time 方向。

结论为 `CHANGES REQUESTED`。修正可以局限在 C2 的快照、状态归类和测试，不需要增加巡逻、回填、lease 映射或修改 FLY-2359。

## What's Good (Keep)

- **admit-time seam 和生命周期边界成立。** 首次 `startSession` 后、`ensureThread` 前触发，既满足原生 memories startup 的进程内条件，也不会创建 runner 自己的新候选；restart/resume 不重复，`stop()` 可中止。
- **Round 2 的可读性问题已按正确层次拆开。** v3 不再把 phase2 未观察到的情形报成可读成功，Mermaid、状态枚举和 E4 均使用 `readable_ready`/`stage1_done` 两层口径。
- **Lead 权威与 scope 已闭合。** `b24705c1` 明确 supersede 原 legacy→seed 验收，FLY-2359 不再是本单 acceptance dependency；计划遵守“不巡逻、不回填、不做受控旧家触发、add nothing else”。
- **`hints` 作为保守上界的职责清楚。** archived、preview、四种 interactive source、1h/10d、两条 up-to-date exclusion 都已与源码对齐；retry/running caps 不复制，由 worker job 行承担实际 claim 权威。
- **时间预算处理比 v2 完整。** deadline 在任何 DB/RPC 之前建立；distill 墙钟从既有 goal budget 中剔除，同时 restart 复用调整后的 anchor，没有凭空续期。
- **负观察和并发风险措辞诚实。** 45s/15s 均写成 `not_observed_within_*`，provisional-memory 的短暂陈旧窗口被显式接受，没有再声称 lease 可给 per-thread 授权或观测。
- **运维、安全与成本边界一致。** 精确 `off` 实现零 hook/DB/RPC/receipt；receipt 读取做 no-follow、类型、大小和身份校验；token 只报告确实可从 `threads.tokens_used` 得到的总量。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[BLOCKER] `jobs.status='done'` 不足以证明 `stage1_done` 所承诺的摘要已经持久化。**

   **Why it matters:** plan §1.2 把 `stage1_done` 定义成 stage1 摘要已持久化到 `memories_1.sqlite`，但 §3.5 的判据只要求本 worker 的 stage1 job 全部为 `done`。Codex 在 `memories/write/src/phase1.rs:260-263` 遇到 `raw_memory` 或 `rollout_summary` 为空时走 `no_output`；`state/src/runtime/memories.rs:931-1000` 仍把 job 更新为 `done`、推进 success watermark，并删除该线程已有的 `stage1_outputs`。因此完全可以出现 receipt=`stage1_done`，同时该线程没有任何可供 phase2 使用的输出。当前 C2 测试矩阵也没有覆盖这个原生成功分支。

   **Suggested fix:** 成功屏障需要把 worker job 与 output snapshot 绑定。对每个要计入 `stage1_done` 的 claim，要求存在同 thread 的 `stage1_outputs`，`source_updated_at >= jobs.input_watermark`，且 `raw_memory`、`rollout_summary` 均非空；仅 `job=done` 但无匹配 output 时记成明确的非成功结果（例如 per-row `done_no_output`，顶层 `partial`），绝不能进入 `stage1_done/readable_ready`。在 receipt 中记录 output presence/watermark（不记录正文），并新增“Codex no-output job done + output row absent/deleted”的测试。

2. **[BLOCKER] `memory_consolidate_global=done` 不证明上一执行的 output 被本次 phase2 选入，因而不足以命名为 `readable_ready`。**

   **Why it matters:** Codex 的 phase2 不是无界合并全部 stage1 outputs。默认最多选择 256 条（`config/src/types.rs:52`），`state/src/runtime/memories.rs:446-505` 按 usage/last usage/更新时间排序取 top-N；新的 T1 output 可能被更高 usage 的旧项挤出。phase2 成功时，源码会在 `state/src/runtime/memories.rs:1240-1291` 用 `selected_for_phase2` 和 `selected_for_phase2_source_updated_at` 精确标记本次输入集合。v3 只看 global job 的 worker/status，所以即使 T1 未入选也会报 `readable_ready`。这不满足 §1.1、§1.2 与 E4 所说的“本次首轮读到上一任经验”。

   **Suggested fix:** `readable_ready` 至少要求本单声称覆盖的 stage1 output 在该次成功 phase2 后满足 `selected_for_phase2=1` 且 `selected_for_phase2_source_updated_at=source_updated_at`；未被选入时只能保留 `stage1_done`。把 `readable_ready` 的运行时含义精确定义成“目标 output 已进入本次成功 phase2 baseline，且可读 artifact 存在”，而“模型确实复述 T1 经验”仍由 E4 的真实模型 receipt 验证。新增超过 phase2 selection cap、目标 output 未选中，以及目标 snapshot 被选中的两组测试。

3. **[HIGH] `expectedButUnclaimed` 被排除在顶层状态之外，与“上一批/上一次”承诺冲突。**

   **Why it matters:** §3.5 明确规定 hints 中未 claim 的线程不影响顶层状态。反例是 hints 包含上一执行 T1 和另一个线程 T0，Codex 因 retry/running cap 只 claim T0；T0 完成后计划会报 `stage1_done`，甚至可能由一个已有 global phase2 job 报 `readable_ready`，但 T1 没有被处理。更极端地，worker 可以只 claim phase2，stage1 集为空时“所有 stage1 都 done”会 vacuously true。这样 receipt 的技术定义与 §1.1 的“上一次的日记一定摘要”、§1.2 的“上一批合格线程”和 E2 的 T1 目标不一致。

   **Suggested fix:** 不必再复制 Codex 的 retry/running 逻辑，但必须定义成功覆盖集。最小改动是：`stage1_done/readable_ready` 要求至少一条 worker stage1 claim，且所有 `hints`（或明确指定的“上一执行目标线程”）都有匹配的非空、同 watermark output；`expectedButUnclaimed` 非空时降为 `partial`。如果产品只愿意保证“Codex 实际 claim 的子集”，则相反方向是把状态改名为 `claimed_stage1_done` 并同步削弱 founder 承诺和 E2，不能继续称上一批/上一任已完成。增加“部分 claim”“只有 phase2 claim”“最新 T1 未 claim 但旧 T0 done”三组状态测试。

4. **[LOW] research.md 仍有三处与 v3 明文合同不一致。**

   **Why it matters:** research §2 的候选行仍只写 `vscode/cli`，遗漏已确认的 `atlas/chatgpt`；§3.5 仍说读取 lease 并写 `liveLease`，而 v3 已明确删除该字段；§5 仍使用旧状态 `skipped:no_claim`，不是 `skipped:no_claim_observed_within_45s`。这些会让实现者从 research 得到与 plan 相反的字段和断言。

   **Suggested fix:** 仅做事实同步：补齐四种 source，删除 `liveLease` 读取/标注句，更新完整负观察状态名。显式标记为历史上被拒绝的 v1/v2 方案可保留，但不能继续写成现行实现合同。

## Verdict

CHANGES REQUESTED — address items above
