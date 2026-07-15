# FLY-1244 Acceptance Matrix

日期: 2026-07-14

本表把 `plan.md` §8 每一格钉到可执行测试；`fresh-spawn-e2e.json` 是真机证据，只有 boolean 与 key-name，
不含 credential/head/token 值。S1–S16 按设计中已修订的 claims 载体映射。

| 格 | S | 自动化证据 |
|---|---|---|
| E1 | S8 | `REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts`（原断言） |
| E2 | S8/S9 | `workflow-decision-routes.test.ts` + `scripts/qa-fly-1244-os-proof.mjs`（H1 PASS→H2 拒→attempt 2 PASS） |
| E3 | S8 | `StateStore.workflow-claims.test.ts` + `workflow-decision-routes.test.ts` + 真机 E2E（exact replay / mismatch / expiry / stale / no credential / caller head） |
| E4 | S1/S2 | `write-gate-response.test.ts`、`actions.test.ts`、`gate-response-router.test.ts`、`text/reaction/founder-ship/voice/deferred` 路由测试 |
| E5 | S3–S7 | `ship-eligibility.test.ts` legacy truth-table + 既有 `auto-qa-coordinator.test.ts` |
| E6 | S10 | `review-family.test.ts` 的 `manifestReviewFamilyOk` + `StateStore.workflow-claims.test.ts` 的 `same_vendor_review` |
| TT | S8 | `ship-eligibility.test.ts` durable/non-durable、READ、FORCE_LEGACY 五分支 |
| BIND | S8 | `StateStore.workflow-admission.test.ts` + `StateStore.workflow-claims.test.ts`（immutable binding/current attempt/stale/corrupt） |
| CRED | S8 | `StateStore.workflow-admission.test.ts` + `workflow-decision-routes.test.ts`（跨时钟 response-loss replay）+ 真机 E2E |
| L1 | S8 | `fresh-spawn-e2e.json`：server head、no shared ingest、replay/mismatch；已知同 uid 残留显式为 true |
| FC | S8 | `ship-eligibility.test.ts` live `.env` flip，且 FORCE 在 claims SQL 前求值 |
| RQ | S8 | `workflow-decision-routes.test.ts` + `phase-orchestrator.test.ts` / `phase-orchestrator.fly1050-qa-respawn.test.ts` |
| HEAD | S8 | `workflow-decision-routes.test.ts`、`verify-approval.test.ts`、`merge-ship-gate.integration.test.ts`、`external-merge-reconcile.test.ts` |
| AUTH | S1/S2 | `write-gate-response.test.ts` + `founder-approval-projector.test.ts` + founder-consent/action 路由测试 |
| T1 | S1/S2 | `workflow-source-events.test.ts` + `StateStore.workflow-source-projector.test.ts`（exact replay/digest poison/receipt/deadletter/TURN） |
| M1 | S11–S16 | `StateStore.workflow-templates.test.ts`（DDL、append-only、publish CAS rollback、seed idempotency、founder-owned refuse） |
| M2 | S11–S16 | `workflow-template.test.ts`（strict unknown keys/graph/loops/vendor-model/pointer/三种子）+ `review-family.test.ts` |
| M3 | S11–S16 | `StateStore.workflow-templates.test.ts`（selection→override reason→effective validation→snapshot/audit） |
| M4 | S11–S16 | `workflow-template-routes.test.ts`（GET 可查；create/publish/rebind POST 全 404） |

真机命令：`node scripts/qa-fly-1244-os-proof.mjs`。平台/Claude/Codex/tmux pin 变化会 fail，必须重跑并重新
确认威胁模型；READ 仍不得上生产，直到 peer-credential/独立 principal follow-up 也闭合。
