# Design Review — plan.md (Round 5)

Date: 2026-07-21
Author: Codex
Status: APPROVED

## Summary

Round 5 已关闭 Round 4 的全部剩余问题：first-class holder 现在贯穿 reaction/text/direct/deferred 的真实 founder ingress，QA teardown 后批准仍可端到端落到同一 land operation；reject/feedback 也有 durable、可恢复且与现有 three-stage 行为等价的 kickback loop。结合前四轮已补齐的 fencing、correlation、resumable finalization、compatibility 与 rollout contracts，本计划在当前架构上可实施，风险边界和交付顺序足够清晰。

## What's Good (Keep)

- `GateAuthorityView` 将 engine-owned authority 与 legacy session authority明确分支，所有批准入口共享同一 holder 校验，而 legacy 路径保持原有 session-based bytes；这同时解决了 teardown race 和 byte-compat。
- “QA 已 teardown + founder 点击 bound card ✅”从 reaction poller 一直测到 CommDB source、holder approval、claims 和同一 operation，覆盖的是实际生产链而非 projector shortcut。
- text reply、response-loss/deferred rebind parity tests 补齐了 reaction 之外的入口与第二窗口恢复，能防止各 approval surfaces 再次漂移。
- trusted feedback 被建模为 durable source event；holder supersede、旧 card/head authority 失效与 `approval_gate → implement` kickback 在 StateStore 收敛，重启窗口也有明确测试。
- land-only manifest variant 承载新的 feedback edge/capability，旧 v1 validator、seeds、snapshots 和 digest 均不需要接受新 vocabulary。
- 新 land template IDs、默认 OFF flag、explicit override E2E、后续显式 rebind 的激活顺序避免了隐式 fleet cutover。
- `land_operation` fencing、Actions comment/run correlation、三阶段 finalization facts、reader migration/backfill 和 postcondition-confirmed completion 已形成完整的幂等恢复链。
- stale resident Codex 的安全边界、legacy manual recovery、sanctioned `:cool:` workflow 与 founder-only authority 均被保留。

## Issues & Recommendations

无阻塞问题。实施时保持两条已写入计划的边界即可：engine-only adapter 必须由 snapshot variant/engine ownership 双重判定，不能仅凭 question shape 猜测；feedback 的“retire question/card”应实现为可验证的 durable authority retirement（CommDB response 已回答、StateStore current-holder/card binding 已撤销），不要重新引入跨 StateStore/CommDB/Discord 的伪原子事务。

## Verdict

APPROVED — ready to implement
