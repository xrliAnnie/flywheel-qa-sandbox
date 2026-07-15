# Design Review — prd.md (Round 4)

Date: 2026-07-08
Author: Codex
Status: CHANGES REQUESTED

## Summary
The new DAG ↔ agent.md layering is directionally correct, and the load-bearing safety claim is true when scoped to Runner `agent.md`: the role file is injected as raw text, while model / permission / skills come from runtime configuration, not from the file. The blocker is the expanded MVP: `generic` is not yet just a cheap parameterized node. It needs a durable completion/output contract and it touches more lifecycle surfaces than the PRD's current "5 面" list and §14 order account for.

## What's Good (Keep)
- The Runner `agent.md` frontmatter safety property is real: `Blueprint` reads the file as text and injects `agentContent.slice(0, 40_000)` into `## Agent Role` (`packages/edge-worker/src/Blueprint.ts:1602`, `packages/edge-worker/src/Blueprint.ts:1606`), then appends the normal baseline prompt (`packages/edge-worker/src/Blueprint.ts:1631`). `permissionMode` is hardcoded to `bypassPermissions` (`packages/edge-worker/src/Blueprint.ts:1676`), and the model comes from `ctx.runnerModel` (`packages/edge-worker/src/Blueprint.ts:1686`).
- `AgentDispatcher` only returns an `AgentConfig` / `agent_file` routing result and does not read model/capability data (`packages/edge-worker/src/AgentDispatcher.ts:31`, `packages/edge-worker/src/AgentDispatcher.ts:215`). The typed `AgentConfig` has `agent_file`, optional `domain_file`, department metadata, and `match`, but no `model`, `skills`, or capability fields (`packages/config/src/types.ts:123`).
- Model resolution is outside `agent.md`: `resolveRoleAdapter()` resolves runner backend/model from labels, dispatch model, project roles, env, and defaults (`packages/teamlead/src/bridge/role-adapter-resolver.ts:165`, `packages/teamlead/src/bridge/role-adapter-resolver.ts:173`, `packages/teamlead/src/bridge/role-adapter-resolver.ts:197`, `packages/teamlead/src/bridge/role-adapter-resolver.ts:206`, `packages/teamlead/src/bridge/role-adapter-resolver.ts:218`).
- The materialized snapshot direction remains right. Copying resolved node shape and resolved agent content forward is the right way to avoid live YAML drift after entry (`engineering/doc/FLY-1020-workflow-templates/prd.md:257`, `engineering/doc/FLY-1020-workflow-templates/prd.md:270`).
- The schema change from bare node names to `{id, type, agent_file}` is mostly consistent: the sample edges/skip now reference ids, and validation says edge/skip targets must be declared node ids (`engineering/doc/FLY-1020-workflow-templates/prd.md:115`, `engineering/doc/FLY-1020-workflow-templates/prd.md:131`).

## Issues & Recommendations

1. Tighten the frontmatter-inert claim: the safety conclusion is correct, but the PRD's evidence is overbroad.

   Why it matters: §2.7 / §5.2 says "全仓没有任何 frontmatter 解析器" (`engineering/doc/FLY-1020-workflow-templates/prd.md:76`, `engineering/doc/FLY-1020-workflow-templates/prd.md:174`). That is factually false: Codex Lead persona loading strips YAML frontmatter (`packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1017`, `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1028`), and other non-agent docs have frontmatter parsers. This does not break the Runner `agent.md` safety property, but the PRD should not claim a repo-wide absence.

   Suggested fix: rewrite the claim to: "No Runner `agent.md` dispatch path consumes `model:` / `skills:` / `permissionMode:` frontmatter." Keep S11, but ground it in `Blueprint`, `AgentDispatcher`, `AgentConfig`, `SkillInjector`, and `resolveRoleAdapter`, not in a repo-wide parser absence. `SkillInjector` also confirms skills are injected from fixed templates, not per-agent `skills:` frontmatter (`packages/edge-worker/src/SkillInjector.ts:23`).

2. `generic` has no defined output / completion / handoff contract.

   Why it matters: §5.4 pins conservative capabilities (`shared_branch_writer=false`, `creates_pr=false`, `can_ship=false`, `can_land=false`, `approval_gate_holder=false`) but does not say how a generic node produces a durable artifact or how downstream nodes consume it (`engineering/doc/FLY-1020-workflow-templates/prd.md:190`, `engineering/doc/FLY-1020-workflow-templates/prd.md:195`). Current completion semantics are route-based and hardcoded: `flywheel-comm complete` only accepts `auto_approve`, `needs_review`, `blocked`, `no_code`, `pr_handoff`, and `phase_design_complete` (`packages/flywheel-comm/src/commands/complete.ts:30`, `packages/flywheel-comm/src/commands/complete.ts:101`). The two sinks and marker reconciler mirror those route semantics (`packages/teamlead/src/bridge/event-route.ts:832`, `packages/teamlead/src/DirectEventSink.ts:355`, `packages/teamlead/src/bridge/complete-marker-reconciler.ts:78`).

   Suggested fix: add an explicit generic-node result contract before accepting it into MVP. At minimum, registry/snapshot needs fields such as `completion_route` / `boundary_status`, `output_mode`, `output_visibility`, and `handoff_payload`. If the intended generic node is read-only, make it complete via an existing safe route such as `no_code` and persist a `workflow_node_outputs[node_id]` payload that later nodes can read. If it writes docs or evidence to the shared branch, then `shared_branch_writer=false` is not the right default for that template instance.

3. Adding `generic` is more than the current "5 production surfaces"; it becomes a durable workflow role unless the PRD explicitly avoids per-node thread/session roles.

   Why it matters: the PRD lists persistence, display, finalization, retry, and startup reconcile as the one-time cost (`engineering/doc/FLY-1020-workflow-templates/prd.md:40`, `engineering/doc/FLY-1020-workflow-templates/prd.md:198`). Source shows more hardcoded lifecycle surfaces:
   - `ChatThreadRole` is fixed to `"main" | "design" | "implement" | "qa"`, and unknown roles normalize to `main` (`packages/teamlead/src/StateStore.ts:263`, `packages/teamlead/src/StateStore.ts:276`).
   - Active/phase queries only include design/implement/qa (`packages/teamlead/src/StateStore.ts:2549`, `packages/teamlead/src/StateStore.ts:2576`, `packages/teamlead/src/StateStore.ts:2659`).
   - Reverse lookup from phase threads normalizes unknown stored roles back to `main` (`packages/teamlead/src/StateStore.ts:4137`, `packages/teamlead/src/StateStore.ts:4147`).
   - Issue display derives from `THREE_STAGE_PHASE_SEQUENCE` and `PHASE_THREAD_BADGE` (`packages/teamlead/src/bridge/issue-display.ts:16`, `packages/teamlead/src/bridge/issue-display.ts:153`, `packages/teamlead/src/bridge/issue-display.ts:214`), and the refresher reads latest phase sessions from the three-role query (`packages/teamlead/src/bridge/issue-display-refresher.ts:254`, `packages/teamlead/src/bridge/issue-display-refresher.ts:618`).
   - TURN recovery priority is hardcoded to `qa`, `implement`, `design` (`packages/teamlead/src/bridge/phase-orchestrator.ts:162`), and recovery candidates are filtered by those roles (`packages/teamlead/src/bridge/phase-orchestrator.ts:1560`, `packages/teamlead/src/bridge/phase-orchestrator.ts:1567`).
   - The completion sinks preserve only existing three-stage phase roles via `resolveCompletionSessionRole()` (`packages/config/src/three-stage-phases.ts:77`, `packages/teamlead/src/bridge/event-route.ts:1088`, `packages/teamlead/src/DirectEventSink.ts:612`).

   Suggested fix: either constrain MVP `generic` to not create a new phase/chat-thread role at all, or explicitly expand the workstream to "workflow node id lifecycle" across session role preservation, chat-thread roles, completion route mapping, display ordering, TURN recovery priority, marker replay, finalizer, retry, and startup reconcile. The PRD currently says "node-id 集合", but it needs to say which DB/session field stores node ids and how unknown legacy roles stay byte-compatible.

4. The current `agent_file` containment helper is safe for path checks, but not for generic fail-closed semantics or snapshot immutability as written.

   Why it matters: `readAgentFile()` rejects absolute paths, parent-escaping paths, resolve escapes, and symlink escapes (`packages/edge-worker/src/Blueprint.ts:1967`, `packages/edge-worker/src/Blueprint.ts:1971`, `packages/edge-worker/src/Blueprint.ts:1977`, `packages/edge-worker/src/Blueprint.ts:1989`). But it returns `null` for unsafe/missing files (`packages/edge-worker/src/Blueprint.ts:1974`, `packages/edge-worker/src/Blueprint.ts:2002`), and the current caller logs a warning and falls back to the generic prompt (`packages/edge-worker/src/Blueprint.ts:1624`). That directly contradicts S12's required fail-closed behavior for `generic` (`engineering/doc/FLY-1020-workflow-templates/prd.md:401`).

   Suggested fix: specify a strict loader path for workflow `generic` nodes. It can reuse the same containment checks, but `null` must fail config/run admission, not continue. Also tighten §7: "resolved agent.md content or immutable reference" (`engineering/doc/FLY-1020-workflow-templates/prd.md:261`) is only safe if the immutable reference is content-addressed storage. A canonical-root path plus `agent_file_hash` is not enough if a later phase re-reads the path after the file changes; the runtime must use copied content or a content-addressed blob only.

5. `generic` currently inherits the default implement/PR/approve prompt path unless the Blueprint capability refactor lands first.

   Why it matters: the current Blueprint only recognizes three internal phase roles through `ctx.sessionRole === "design" | "implement" | "qa"` with `shareParentBranch` (`packages/edge-worker/src/Blueprint.ts:913`, `packages/edge-worker/src/Blueprint.ts:917`, `packages/edge-worker/src/Blueprint.ts:927`). Everything else gets the generic implementation prompt to create a branch, commit, push, and open a PR (`packages/edge-worker/src/Blueprint.ts:1031`), plus merge/approval/landing rules unless excluded by existing QA/phase checks (`packages/edge-worker/src/Blueprint.ts:1041`, `packages/edge-worker/src/Blueprint.ts:1348`, `packages/edge-worker/src/Blueprint.ts:1459`). §5.4 says prompt for `generic` comes only from `agent_file` and capabilities come from registry (`engineering/doc/FLY-1020-workflow-templates/prd.md:193`), but §14 puts Blueprint prompt/capability migration at step 9, after generic is added at step 6 (`engineering/doc/FLY-1020-workflow-templates/prd.md:416`, `engineering/doc/FLY-1020-workflow-templates/prd.md:419`).

   Suggested fix: move the capability-driven Blueprint prompt refactor before enabling any `generic` node dispatch. The first generic sentinel should assert that a generic node with all write/ship capabilities false does not receive branch/PR/approve/ship instructions and has a defined completion command.

6. §14 sequencing is dependency-inverted for the expanded MVP.

   Why it matters: the suggested order has orchestrator sequence/skip/loop in step 5, `generic` role-surface expansion in step 6, lifecycle workstream in step 8, and Blueprint capability migration in step 9 (`engineering/doc/FLY-1020-workflow-templates/prd.md:414`, `engineering/doc/FLY-1020-workflow-templates/prd.md:415`, `engineering/doc/FLY-1020-workflow-templates/prd.md:416`, `engineering/doc/FLY-1020-workflow-templates/prd.md:418`, `engineering/doc/FLY-1020-workflow-templates/prd.md:419`). If `generic` is MVP, the durable node-id model, output/completion contract, completion sinks, marker replay, display, TURN recovery, and Blueprint capability gating must exist before the orchestrator can correctly interpret a snapshot containing generic nodes.

   Suggested fix: split the epic sequence into two gates:
   - Substrate first: schema + materialized snapshot + node-id lifecycle substrate + completion/output contract + strict `agent_file` loader + Blueprint capability gating.
   - Then behavior migration: design/implement/qa registry compatibility, workflow-aware ship gate, orchestrator sequence/skip, QA loop migration, Auto-QA boundary, lifecycle sentinels, and finally enabling shipped templates with `generic`.

7. Minor schema consistency gaps remain after `{id,type,agent_file}`.

   Why it matters: the PRD says edge/skip target ids must exist (`engineering/doc/FLY-1020-workflow-templates/prd.md:131`), but the new schema also needs explicit validation for unique node ids, source ids, edge ids for loop counters, and `agent_file` being required only for `type: generic` and rejected for core node types. Without this, `loop_counters` and `current_node_id` in the snapshot (`engineering/doc/FLY-1020-workflow-templates/prd.md:265`, `engineering/doc/FLY-1020-workflow-templates/prd.md:266`) can become ambiguous.

   Suggested fix: add these schema rules and sentinel cases next to S12.

## Verdict
CHANGES REQUESTED — the `agent.md` layering is sound, but `generic` in MVP needs a stricter role-scope statement, a concrete output/completion protocol, and an earlier durable-node substrate before it is safe to hand to Tadashi as buildable.
