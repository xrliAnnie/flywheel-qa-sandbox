# Design Review — FLY-1307 plan.md (Round 3)

Date: 2026-07-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的五项方向均已实质折入：flag 真值表、PR-7→7.5 单向 port、closed ship-claim mapping、`engine_owned`/registry 清理及 materializer 的 base/head/adoption 轮廓都明显更接近可实施状态。但当前仍有两个实现阻塞点：append-only receipt 没有定义如何跨 intent/commit/push 三阶段持久化且原子收敛，“全终局 caller”也仍未真正列成封闭清单；另有一条 research 审计结论与现有 StateStore 查询不符。

## What's Good (Keep)

- §4.1 现在明确区分“无候选/v1 dispatch OFF 的 legacy”与“显式请求缺前置/v2 缺任一旗的 fail-closed reject”，§4.3 也把两类期望及拒绝格零副作用分开断言；这保住了 FLY-1281 已批准的 v2 gate order。
- `MaterializedHeadAuthority` 已成为 PR-7 定义、PR-7.5 实现的单向 port；PR-7 用 fake 覆盖 review 语义，真实 head/stale head/response-loss 与 product-v1 正向链归 PR-7.5，切片依赖不再成环。
- materializer 已钉住 `json_v1` 外壳 + `payload.kind='docs_v1'`、base-aware fence、`mat:` effect namespace、deterministic ref/trailer adoption，以及 push-confirmed head 才算 `started`；这些选择均符合伞单既定语义且没有扩进 runner 直写能力。
- ship-claims 表已做到 exact-predicate 映射，明确区分 `design_review_approved` 与同 family 的其他 predicate，并把 product-v1 founder source → projector → terminal CAS 命名出来。
- registry sentinel 的范围、`engine_owned` 最终列形态、TURN 四层 hard gate、default-off/生产 enable 治理和 PR-7→7.5→8 顺序均保持正确；未见 scope 漂入 FLY-1306 或伞单 §3.3 non-goals。

## Issues & Recommendations

1. **[HIGH] append-only `workflow_materialization_receipt` 仍没有可执行的分阶段写入模型，因而 `intent_recorded` 的“输入已钉”和最终 push 证据不能同时成立。** §3 规定 ledger 的 materialize 行只把 `execution_id` 当不可逆的 `mat:` effect id，同时新 receipt 一行包含 output/digest/base、commit head 和 *push-confirmed* remote head，并要求整表 append-only（`plan.md:211-230`）。真实 ledger 目前没有 output/base/head 证据列（`StateStore.ts:15978-15995`）：若 receipt 只在 push 后插入，Bridge 在 `intent_recorded` 或 commit-before-receipt 崩溃后无法从 effect hash 恢复被钉住的 output/base；若 intent 时先插一行，append-only 又不能在 commit/push 后补齐 head；若靠多行追加，计划没有 stage、唯一键、必填列或权威读选择规则。这里还缺“final receipt 插入”和 ledger `started` 转移的同事务边界，否则 crash 可留下 `started` 但 authority unavailable，或 authority 已可见但 ledger 未终局。**建议修复：** 钉死一种不可变阶段模型，例如 append-only evidence rows 带 `stage ∈ {intent_pinned, commit_adopted, push_confirmed}`、`UNIQUE(effect_id, stage)` 与逐 stage 必填约束，或拆成 immutable intent 表 + final receipt 表；allocate 必须在一个 StateStore 事务写 ledger intent + output/base pin，adopt 必须原子写 commit evidence + `launch_committed`，remote equality 确认后必须原子写 final receipt + `started`。`MaterializedHeadAuthority` 只读 `push_confirmed` 且必须与 `workflow_node_output_current` 的当前 attempt/output 匹配。补 push-before-DB、receipt-before-state（应由事务消除）、restart-at-intent 和 restart-at-launch_committed 的反例测试。

2. **[HIGH] Round 2 要求的“全终局 caller 枚举”仍未落成封闭调用表，现文只是把枚举留给实现期，无法证明 composite seam 无旁路。** §2.2-7 仅写“枚举并逐一测试全部 completed/Done/merge/finalize 调用方”（`plan.md:144-155`），但源码中除已使用 `computeAuthoritativeShipDecision` 的 DirectEventSink/event-route/marker/external-merge 面外，至少还有 `closeRunnerInner` 在 eligibility 前直接 `applyTransition(..., 'completed')`（`close-runner.ts:243-291`）、`reconcileDoneRunning` 的 running→completed（`done-running-reconciler.ts:180-220`）、`finalizeStaleBlocker` 的 parked→completed（`stale-blocker-guard.ts:310-335`），以及 `finalizeRecoveredMerge` 的 direct completed write（`merge-ship-gate.ts:198-291`）。其中有的是 ship terminal，有的可能只是 runner/slot housekeeping；若不在计划中逐项分类，实施者必须重新决定哪些要进 engine-owned ship gate、哪些允许清理 session 但绝不能 terminalize workflow run/Linear Done。**建议修复：** 在 §2.2-7 加一个以实际 symbol 为键的 closed caller table，至少覆盖上述路径、existing compute callers、Linear-Done/finalization 调用点和 product-v1 projector terminal driver；每行写明 authoritative seam 的调用位置、engine-owned hold 行为及为何不存在 workflow/Done 旁路。任何 housekeeping exemption 也必须显式说明只清理 runner、不能完成 run 或触发 Done，并有逐 caller 反例测试。这样才真正兑现本轮所称的“ALL callers”。

3. **[MEDIUM] research 对 ledger API 的审计仍不准确，且现有 dispatch evidence reconciler 会读到未来的 materialize 行。** `research.md:38-43,89-94` 两次声称“全部读写 API 硬编码 `kind='dispatch'`”；实际 `StateStore.listNonTerminalWorkflowSideEffects()` 没有 kind 条件（`StateStore.ts:16062-16090`），`listWorkflowSideEffects()` 也返回所有 kind，而 `workflow-shadow-writer.reconcileSideEffects()` 直接消费前者并按 dispatch launch marker/CommDB 证据解释每一行（`workflow-shadow-writer.ts:423-466`）。`mat:` namespace 让当前 marker 偶撞概率低，但这不是清晰的 ownership boundary，也与“materialize 专用 reconcile API”相冲突。**建议修复：** research 改成“现有 mutation/attribution 主路径按 dispatch 实现，但 generic list/non-terminal query 未分 kind”；PR-7.5 工作项除给 attribution 子查询加 `kind='dispatch'` 外，还明确把 legacy dispatch reconciler 的查询收窄到 dispatch，并让 materialize reconciler 独占 `kind='materialize'`。加混合两种 kind 的回归测试，证明两个 reconciler 互不读取/转移对方的行。

## Verdict

CHANGES REQUESTED — address items above
