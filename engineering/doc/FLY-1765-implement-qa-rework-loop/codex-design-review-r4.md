# Design Review — plan.md (FLY-1765) (Round 4)
Date: 2026-08-14
Author: Codex
Status: APPROVED

## Summary

Round 3 的两项 blocker 均已完整闭合。§2.2 现在把 settlement identity 明确绑定到被结算的 open generation，避开 admission 已占用的 activation-keyed clear ID，并为真实的 admission-clear → completion-open → settlement-clear 顺序、重放、attempt N+1 和冲突行补齐了非空转测试。exploration、research 与 plan 对 land authority、`terminal_no_gate` receipt 和版本沿革的表述也已统一。

结合源码复核，该方案可由现有架构直接实现：park generation 在 `workflow_engine_park_outbox` 中按 execution 单调递增，StateStore current evidence 取该 execution 的最新 generation，CommDB projector 也以更高 generation 覆盖旧 projection。因此 `engine-park-settle:<executionId>:<openGeneration>` 能稳定标识一个 open，且新 clear 会成为可投影的更高 generation。没有新增 schema、flag、终态复活边或未受控的 replacement 路径；此前已关闭的 land ordering、FLY-1731 authority 隔离、mutation-time fencing 和 FLY-1269 真机门槛仍保持完整。

## What's Good (Keep)

- 保留 canonical settlement ID `engine-park-settle:<executionId>:<openGeneration>`。它按“一次 open 一次 clear”建模，不受 activation admission 预写 clear 或不同 settlement cause 影响，也适配同一 execution 的 attempt N+1 re-park。
- 保留 same-ID tuple conflict 的 fail-closed 规则。实现时同一 canonical ID 只能代表对应 run/execution/node/attempt/activation/open generation/reason 的 settlement clear，不能沿用 `appendWorkflowEngineParkEventTx` 当前“见 ID 即成功”的宽松行为。
- 保留测试 4b 的真实事件序列，而不是直接手造孤立 open/clear。它同时覆盖 StateStore latest evidence、CommDB projection、重放零新增、下一次 open generation 和冲突行，足以捕获 Round 3 指出的静默碰撞。
- 保留 full-settle、terminal ledger-only 和 replacement transaction 三条腿共享同一 identity helper 的约束，避免三处各自产生不兼容的幂等键。
- 保留 research/exploration 的修正文案：受影响 manifest 的 authority 是 `mode:"land"`；`terminal_no_gate` 只证明该次 completion 没有打开 gate，不是 engine handoff receipt。剩余 `engine_terminal`、`replacement_pending` 和“曾列为未证实项”命中均已限定在无关形态、被拒方案或历史纠正语境。
- 保留此前各轮已确认的边界：真实 compiled `tpl_code` 首个红测、FLY-1731 holder/carrier 阴性 sentinel、真实 land finalizer 顺序、五元组 `closeRunner.authorityCheck`、proven-dead replacement、无新 flag，以及 alive-but-nonconsuming 时 stop release。

## Issues & Recommendations

无阻塞问题。实施与 code review 时按计划验证 same-ID 行的完整 settlement 语义，并确保测试 4b 确实经过现有 admission writer 和 CommDB projector，而非用 mock 绕过 generation 分配；这属于已写明验收条件，不要求调整设计。

## Verdict

APPROVED — ready to implement
