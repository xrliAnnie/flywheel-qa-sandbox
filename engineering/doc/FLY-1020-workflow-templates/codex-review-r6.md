# Design Review — prd.md (Round 6)

Date: 2026-07-09
Author: Codex
Status: APPROVED

## Summary

Round 6 resolves the remaining R5 blocker. The `generic` output contract is now implementable against the existing completion architecture because structured node output is explicitly moved out of `complete`, written before completion, persisted at issue/workflow scope, and checked before handoff. I found no remaining dependency inversion in the Gate A / Gate B sequencing, and no remaining substantive contradiction in the frontmatter or 8-surface claims.

## What's Good (Keep)

- §5.6 now correctly treats `complete` as a status transition, not a structured-output transport. That matches the real CLI payload, which only has `summary` as a free-text optional field (`packages/flywheel-comm/src/commands/complete.ts:68`, `:172`-`:178`) and writes the same event body into the fail-close marker (`:200`-`:208`, `:249`-`:255`, `:395`-`:415`).
- The independent `workflow-output` write channel plus write-before-complete ordering is the right shape. It avoids overloading marker replay: both HTTP `/events` and `DirectEventSink` map `no_code` to status only (`packages/teamlead/src/bridge/event-route.ts:832`-`:843`, `:1042`-`:1057`; `packages/teamlead/src/DirectEventSink.ts:355`-`:380`, `:511`-`:522`), and the marker reconciler only validates/replays the completion route (`packages/teamlead/src/bridge/complete-marker-reconciler.ts:74`-`:82`, `:246`-`:252`).
- The output-present fail-closed rule is now explicit: a `produces_output` node cannot advance if `workflow_node_outputs[node_id]` is missing (`engineering/doc/FLY-1020-workflow-templates/prd.md:250`-`:258`, `:473`-`:474`). That closes the downstream-stranding gap from R5.
- The frontmatter claim is now scoped correctly to Runner `agent.md` dispatch paths, with the Codex Lead counterexample preserved (`engineering/doc/FLY-1020-workflow-templates/prd.md:86`-`:104`, `:212`-`:218`).
- The “new node role” cost model now consistently uses the 8 production surfaces, including silent role normalization, completion sinks, finalizer, retry, and startup reconcile (`engineering/doc/FLY-1020-workflow-templates/prd.md:52`-`:65`, `:266`, `:429`).
- Gate A now contains the prerequisites that must exist before `generic` can run: materialized snapshot, node-id substrate, ship-gate evidence, output/completion contract, strict loader, and Blueprint capability gating (`engineering/doc/FLY-1020-workflow-templates/prd.md:483`-`:489`). Gate B then migrates behavior and enables templates (`:491`-`:496`), so the previous dependency inversion is gone.

## Issues & Recommendations

1. No blocking issues.

   The section 5.6 output contract is now buildable. The implementation should keep the exact ordering the PRD states: persist `workflow_node_outputs[(workflow_run_id,node_id)]`, then accept `complete --route no_code`; on completion, verify required output before invoking workflow handoff. Because output is issue-level durable state and not marker payload, Bridge restart and marker replay no longer strand a downstream node that reads `workflow_node_outputs`.

2. Non-blocking cleanup: update two stale references while editing.

   In §5.6, the marker replay citation points at `complete-marker-reconciler.ts:5-7`, which describes the marker mechanism generally; the actual `no_code` valid-route evidence is `complete-marker-reconciler.ts:74-82` (`engineering/doc/FLY-1020-workflow-templates/prd.md:247`). In §14, step 10 still says `reverse-compat sentinels(S1–S14)`, but the table now includes S15 and S16 (`engineering/doc/FLY-1020-workflow-templates/prd.md:473`-`:474`, `:495`). These are citation/text cleanups, not design blockers.

## Verdict

APPROVED — ready to implement.
