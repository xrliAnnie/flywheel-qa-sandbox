# FLY-145 S6 retry Product-Test — QA 报告
Issue: FLY-145 (https://linear.app/geoforge3d/issue/FLY-145/qa-fly-127-sandbox-s6-retry-product-test)
日期: 2026-09-26
基于: plan.md

## 结论

**Workflow verdict: FAIL. Behavior result: INCONCLUSIVE.**

本轮不能执行有效的 S6 四 Lead 实机矩阵，且候选 PR 的 exact-head CI 前置条件不成立。QA 没有向 Discord 发送根消息，也没有归档 FLY-145；这样保留了“同一 attempt 只允许一个根事件”的证据边界，避免把单 slot 输入伪装成四路 fan-out。

## Attempt identity

| field | value |
|---|---|
| attempt_id | `qa-db6d7c43-f153-4db5-bfe7-20cca66037c1-preflight` |
| started_at | `2026-09-26T13:29:17.040Z` |
| readiness_decision_at | `2026-09-26T13:34:25Z` |
| issue | `FLY-145` |
| expected department label | `Product-Test` |
| intended source channel | `cos-test` / `1493080991290626079` |
| root message | **not sent** |
| reviewed head | `ba3ed6a2999909e99446bff65ba7b39183070aa1` |
| candidate PR | `xrliAnnie/flywheel-qa-sandbox#263` |

## Product-user flow checked

The user-visible contract is a real shared-channel routing decision: one valid instruction reaches all four Lead bots; only `flywheel-test-2` starts and spawns for the `Product-Test` issue; `flywheel-test-1/3/4` stay silent and cause no backend side effect. This is Discord-capable and requires real N-to-N evidence, not an API-only substitute.

The required production-mirror topology was absent:

- the safe projection of `/Users/xiaorongli/.flywheel/test-slots.json` maps slot 1 to `cos-test`, slot 2 to `product-lead-test`, slot 3 to `ops-lead-test`, and slot 4 to `finance-lead-test`; different default channels do not prove shared delivery;
- `/private/tmp/flywheel-test-slot-1/`, `-2/`, and `-3/` had no active `bridge-launch.json` receipt;
- the only active root was `/private/tmp/flywheel-test-slot-4/`, whose launch receipt binds a single `flywheel-test-4` Lead to `finance-lead-test` and records `BRIDGE_DEPT_SCOPE_REJECT=off`;
- no external campaign receipt was found for four-way `cos-test` fan-out, a staged cos roster, four enabled scope gates, or four continuous `/api/runs/start` ingress captures.

Because those are preconditions for interpreting silence, posting `<@1493072948683341976> 起 Runner FLY-145` now would not test the promised matrix. The real Discord N-to-N was therefore **not run**, and this is a blocking QA failure rather than a no-surface exemption.

## Fixture verification

Linear read-back at QA time returned:

| field | observed |
|---|---|
| identifier | `FLY-145` |
| title | `[QA-FLY-127 sandbox] S6 retry — Product-Test` |
| archived | no (`archivedAt=null`) |
| state | `Canceled` |
| labels | `Flywheel`, `Product-Test` |

The issue exists and retains the expected department label, but it is not a sufficient substitute for the missing four-way delivery topology.

## Four-slot evidence matrix

| slot | expected | input receipt | reply | start receipt | spawn | row result |
|---|---|---:|---:|---:|---:|---|
| 1 / `flywheel-test-1` | silent | missing | not observed | not observable | not observable | INCONCLUSIVE |
| 2 / `flywheel-test-2` | unique start + spawn | missing | not observed | not observable | not observable | INCONCLUSIVE |
| 3 / `flywheel-test-3` | silent | missing | not observed | not observable | not observable | INCONCLUSIVE |
| 4 / `flywheel-test-4` | silent | isolated slot only; not shared input | not stimulated | current Bridge gate is off | current DAG QA session excluded from campaign evidence | INCONCLUSIVE |

No zero count above is promoted to PASS: without a proven input receipt and continuous ingress capture, “nothing observed” does not prove silence.

## Exact-head CI evidence

After acquiring the QA TURN, the reviewed branch was fetched and local/remote heads matched at `ba3ed6a2999909e99446bff65ba7b39183070aa1`. The mandatory command

```text
flywheel-comm ci-full ensure --pr 263 --head ba3ed6a2999909e99446bff65ba7b39183070aa1 --json
```

returned exit 1:

```json
{"exitCode":1,"status":"legacy_ci_not_green","detail":"mergeStateStatus=DIRTY"}
```

GitHub independently reported `mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`, and no exact-head checks. The branch's issue-local change is documentation-only relative to its continuity base, but the PR is stale against current sandbox `main` and exposes a very large unrelated divergence. QA did not resolve product-source conflicts; the author must provide a repaired reviewed head before a future PASS attempt.

## Honest boundary and cleanup

- Not tested: real shared-channel message delivery, bot replies, `/api/runs/start` admissions, and Runner spawn correlation. Reason: the required four-Lead topology and capture receipts were absent. Risk: high; these are the core acceptance criteria. Coverage point: a repaired attempt with the production-mirror receipts defined in `plan.md`.
- Not run: local Vitest/package suites. Reason: this issue adds no product code, and broad local suites are forbidden; unit evidence cannot replace the missing live matrix.
- Not published: founder ship-report HTML. FAIL does not publish a ship report.
- Not archived: FLY-145. Archive is allowed only after a behavioral PASS and resolution of the FLY-1189 fixture dependency.
- No product code or runtime configuration was changed by QA.

## Required repair before re-test

1. Provide a reviewed, conflict-free PR head whose mandatory `ci-full ensure` returns exit 0.
2. Provide an isolated production-mirror campaign receipt proving all four bots consume the same `cos-test` root event.
3. Prove the staged cos roster recognizes test-2/3/4 and all four Bridges have department scope enforcement enabled.
4. Provide continuous, redacted ingress capture for all four Bridges so start=0 is verifiable.
5. Re-dispatch QA on the repaired head; send exactly one root message, hold the full observation window, and record strength-two 529 evidence before teardown.
