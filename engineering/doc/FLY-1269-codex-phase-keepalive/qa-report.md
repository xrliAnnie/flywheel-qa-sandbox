# FLY-1269 Codex Resident Phase 529 E2E — Implement Evidence

Issue: [FLY-1286](https://linear.app/geoforge3d/issue/FLY-1286/qa-fly-1269-codex-常驻三段式-529-room-真机-e2edesigncodex-implementcodex)
日期: 2026-07-15
基于: FLY-1269 candidate snapshot `c833f78b552b0df54fb49d8f0d7c79331513ea28`

## Verdict

**FAIL — A2 resident hold / budget freeze 未成立。**

Implement phase 按计划取得 `implement / epoch 2` TURN 后，从 StateStore、CommDB、Codex
session state、native goal DB、tmux 与 execution-private socket 反向检查 Design。Design
仍是成功链原 execution/thread/goal，TUI 和 socket 也都活着，但它只有 CommDB
`declaredState=parked` 标签，没有进入 native paused hold：

- `session.json.phaseHold = null`；
- native goal `status = active`；
- 5 秒窗口内 `tokens_used` 从 `758321` 增至 `759004`（`+683`）；
- `time_used_seconds` 从 `4389` 增至 `4394`（`+5`）；
- `updated_at_ms` 从 `1784110734993` 增至 `1784110739676`；
- Design TUI 正在反复执行 `turn` / `inbox` / `park`，而不是停在 adapter 的
  `phaseHold.state=paused` 循环。

这直接触发 plan Stop Condition 4。Implement 没有执行 daemon crash、没有请求 mailbox
wake、没有 signal 任何进程，也没有继续构造一条表面成功的链。

## Runtime Identity

| Plane | Design evidence | Result |
|---|---|---|
| StateStore | `c552669e-611b-47fc-98ca-63371c81cbe8`, `design_done`, `codex-tmux`, `gpt-5.6-sol` | identity retained |
| Native thread | `019f6506-6123-7453-9bc1-5aaaa4c32c58` | same thread |
| Native goal | `acedce0b-ad08-47b8-adbe-0618df6caa09`, `active` | **FAIL: expected paused** |
| Session latch | `phaseHold: null` | **FAIL: expected paused latch** |
| CommDB state | `parked`, reason `three-stage design parked until ship` | label exists but does not prove hold |
| TURN | holder `e854cc74-39dc-4c75-b78b-d2e220a08cbe`, phase `implement`, epoch `2` | correct handoff |
| tmux | target exists, `pane_dead=0` | live |
| app-server | socket `407ac44945241bf9.sock` connects; `lsof` holder PID/PGID `47673` | live and attributable |

The StateStore heartbeat remained at `2026-07-15 10:00:20`; this is not treated as proof of death
because the stronger socket/lsof/tmux oracles showed the execution live, and the native goal counters
were still advancing.

## Acceptance Matrix

| ID | Verdict | Evidence |
|---|---|---|
| A1 locked dispatch | INCOMPLETE | Design and Implement are Codex `gpt-5.6-sol`; QA was not spawned after fail-fast, so Opus is unproven. |
| A2 Design resident | **FAIL** | Same exec/thread/goal remains live, but no `phaseHold`, goal active, token/time counters advance. |
| A3 crash recovery | NOT RUN | Unsafe and invalid after A2 preconditions failed. |
| A4 mailbox wake | NOT RUN | Lead wake was not requested after the chain had already failed. |
| A5 Implement resident | NOT RUN | Implement did not complete/park a failed chain. |
| A6 TURN chain | PARTIAL | Design → Implement handoff is correct at epoch 2; QA epoch 3 was not started. |
| A7 terminal shutdown | NOT RUN | External terminal observer was not armed for a failed chain. |
| A8 isolation | PASS TO FAILURE POINT | All mutations stayed inside the plan allowlist; no production source/config changed. |

Missing and not-run evidence is not counted as PASS. Overall verdict remains FAIL.

## Observer TDD

The terminal observer deliverable was built before the live stop condition was found. Its nine
fixture tests cover:

1. requested → acked ordering before row deletion;
2. same-request durable `lead_close_runner` corroboration when ack sampling is missed;
3. live/fresh cleanup without ack/corroboration fails closed;
4. proven direct cleanup is classified with `rerunRequired:true`;
5. indeterminate liveness fails closed;
6. old same-issue attempts outside the manifest are ignored;
7. TURN and QA successful-chain cleanup are mandatory;
8. socket listener/holder orphans fail;
9. both SQLite databases are opened with `-readonly` and `PRAGMA query_only=1`.

The observer was also run in real `--once` mode against test-slot-2. That read exposed the live
Design socket and stale StateStore heartbeat without writing either source database.

## Regression Verification

Fresh verification at the failure evidence head:

- terminal observer: 9/9 tests passed;
- `codex-phase-lifecycle` + daemon client/runtime: 87/87 tests passed;
- three-stage phase routing table: 21/21 tests passed;
- observer syntax, evidence JSON parse, and `git diff --check`: passed.

The narrow static suite is therefore green while the real resident chain fails A2. The static tests
must not be used to override the live native-goal evidence.

## Safety / Scope

- No `packages/**`, workflow, runtime config, or production script was modified.
- No daemon/process signal was sent.
- No Design wake instruction was requested or injected.
- No production PR #604 action was taken.
- Raw structured evidence is in `qa/529-e2e-chain.json`.

## Required Recovery

FLY-1269 must ensure phase completion transitions the native Codex goal into the adapter-managed
paused hold before the Design phase begins self-driven continuation/polling. After the candidate is
fixed and cross-family reviewed, rerun FLY-1286 from a fresh successful chain; do not resume at the
crash or wake steps from this failed chain.
