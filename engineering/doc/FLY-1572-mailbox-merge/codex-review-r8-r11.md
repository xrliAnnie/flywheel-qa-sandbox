# Design Review — plan.md (Round 8)

Date: 2026-08-05
Author: Codex
Status: CHANGES REQUESTED

## Summary

The §12 rebase conclusions and the plan's load-bearing current-code claims are confirmed against `HEAD fa65ecfa`: the retired v2 packages are gone, the provenance fence remains, FLY-1628 added no mailbox-table reader, and the adapter/loop/CLI boundaries are unchanged. The new three-null unread predicate is correct, but its reconciliation wording does not yet compose with the approved dual-identity model and its state precedence is incomplete. The multi-DB ordering is directionally consistent with the three-state open guard, but its partial-failure recovery must be made explicit before implementation.

## What's Good (Keep)

- §12.A is factually sound. `packages/v2-cutover` and `packages/v2-kernel` are absent from the current tree; all five cited reference files exist at `dd165ee5`; and `~/.flywheel/flywheel-v2.db` is absent. Keeping the old v2 references as historical implementation patterns does not create a runtime dependency.
- FLY-1634 did not change `packages/flywheel-comm/src/db.ts`; lease-generation history and current-holder provenance still feed the six sender fields, and `processedFenceFromProvenance` still implements lease-generation → writer-pid → unprotected fallback.
- The FLY-1628 diff in `db.ts` is exactly the new `finalizePaneLossResidue` transaction plus the `target_changed` result variant. It reads only `sessions` and `three_stage_turn`; the full PR diff adds no `messages` or `lead_inbox` reader/writer.
- The current adapter contract remains `LeadDeliveryBatchMember` / `LeadDeliveryBatch` / `DurableAcceptReceipt`; `lead-inbox-loop.ts` still calls exactly the documented 11 queue methods. Relative to `dd165ee5`, the relevant adapter, loop, admission, protocol, send, and respond files are unchanged.
- The current flow evidence still supports the plan: `ask`/`gate` call `insertQuestion`; `send`/`respond` persist intent before `wakeRunnerMailbox`; and `consumeGateResponse` still finishes only `purpose='gate_response'` keyed by response id while ordinary responses create `purpose='park_wake'` keyed by `gate-answer:<questionId>`.
- The three-null predicate itself correctly excludes consumed-but-unsettled historical rows from the unread set. Separating external and messages-origin rows from that acceptance set, and limiting `chat-receipt pending=0` to its actual lane, are both correct.
- §12.C's top-level deployment rule—quiesce writers, migrate each production DB atomically, and install the new binary only after every target DB has a verified completion marker—is compatible with §8.3's three-state open contract.

## Issues & Recommendations

1. **[BLOCKER] The unread id-set anchor compares the wrong identity for folded mirrors.** §8.2 first requires a queued question/ack mirror to become one row with `mailbox.id = messages.id` and `mailbox.delivery_id = old lead_inbox.id`, then requires the post-migration `mailbox.id` set to equal the old unread `lead_inbox.id` set. A correct migration containing a true-unread question or protocol mirror therefore fails the acceptance test; changing the migration to pass it would break the already-approved dual-identity contract. Define the anchor through the coverage record/source-id projection instead: for every old true-unread `lead_inbox` row, require exactly one coverage mapping to a queued inbox mailbox row whose `delivery_id` equals the old row id; for folded mirrors also require `mailbox.id = old ref_message_id`, while non-mirrors require `mailbox.id = mailbox.delivery_id = old id`. Compare the old source-id set through those mappings, not directly to `mailbox.id`, and add true-unread question-mirror and ack-mirror fixtures.

2. **[HIGH] The three-null rule is not applied exhaustively across the earlier type-specific rows.** The question/ack rows still classify mirrors as only `consumed / pending / no mirror`, while the exact definition of `pending` and the gray-zone rules appear later under “lead_inbox 其余 pending”; an implementation can therefore treat `consumed_at IS NULL` as pending and queue a mirror with `processed_at` or `delivered_at` already set. The external row has a similar precedence hole: it maps every not-complete row to QUEUED, although the current external-lane query explicitly excludes `processed_at IS NOT NULL`, and the read-only production spot-check found processed-without-delivered external rows. Make classification precedence global and exhaustive before the per-type destination: disposed/processed evidence first; consumed history next; the delivered-only inbox anomaly requires the recorded manual decision; only the exact inbox three-null tuple is unread/QUEUED. For a settled mirror paired with an otherwise active messages row, specify the legal merged result or abort for manual handling; do not let it fall through to QUEUED. Add cross-product fixtures for question mirror, ack mirror, ordinary inbox, and external rows, including processed-only and delivered-only gray states.

3. **[MEDIUM] The partial multi-DB failure state has no explicit fleet-wide exit path.** §12.C says a failed DB rolls back only itself while previously completed DBs remain migrated, but §8.2's earlier sequence still reads as migrate → deploy → restart for one DB. In that mixed state the old binary fails on migrated poison views and the new binary fails on remaining legacy schemas, so the single multi-project Bridge cannot be restarted. Fold §12.C into §8.2's normative runbook: iterate backup/migrate/verify over the full production inventory, keep the entire fleet quiesced on any failure, and choose one explicit recovery—resume the remaining migrations, or restore every already-migrated DB before restarting the old binary. Deploy once only after all target completion markers and inventory checks pass.

## Verdict

CHANGES REQUESTED — address items above
# Design Review — plan.md (Round 9)

Date: 2026-08-05
Author: Codex
Status: CHANGES REQUESTED

## Summary

All three Round 8 remedies are substantively present: the unread anchor now follows dual identity correctly, the `lead_inbox` classification handles settled/consumed/gray/true-unread states before folding, and the multi-DB runbook has a safe fleet-wide failure exit. One narrow but implementation-significant scope contradiction remains in §8.2: the new four-tier ladder is declared to govern every source row, although its columns and semantics belong only to `lead_inbox`.

## What's Good (Keep)

- The unread acceptance anchor is now a real coverage projection: old `lead_inbox.id` maps to `mailbox.delivery_id`, mirror rows additionally prove `mailbox.id = ref_message_id`, non-mirrors prove `id = delivery_id`, and exact-one coverage plus mandatory question/ack mirror fixtures closes the Round 8 identity defect.
- Within the `lead_inbox` domain, the precedence order correctly prevents settled or consumed rows from becoming ghost unread. The explicit settled-mirror × active-question rule preserves settlement evidence, prevents redelivery, carries `relay_state`, and leaves the unanswered RPC dimension intact; §7 therefore continues to protect it from premature archival.
- External rows are no longer exempt from settlement precedence, and the processed-only/delivered-only/consumed-only/three-null cross-product fixtures make the classification executable rather than anecdotal.
- The fleet-wide runbook is now internally consistent with §8.3 and §12.C: all writers remain quiesced across every production DB, partial completion has exactly two recovery exits, and the three-state open contract is correctly described as a guard rather than a recovery mechanism.
- The §12 rebase conclusions and the previously spot-checked current-code invariants remain unaffected by these edits.

## Issues & Recommendations

1. **HIGH — Scope the global four-tier precedence ladder to physical `lead_inbox` rows.** §8.2 currently says it applies “to all source rows” and that every source row must fall into one tier, while the per-type matrix says all state classification first passes that ladder. That cannot hold for `messages`: the current `messages` schema has `delivered_at` but no `processed_at`, `consumed_at`, `disposed_at`, or `carrier`, and `messages.delivered_at` deliberately means different things by type (`instruction` → LEASED, `response` → ACKED). Taken literally, the new global rule is either unimplementable for `messages` or overrides the load-bearing mappings immediately below it. Change the scope text to “all physical `lead_inbox` source rows, including folded mirrors and external rows”; state that messages-only rows use the `messages` per-type matrix; and state that a merged pair first classifies its `lead_inbox` mirror through the ladder, then applies the merge rule. The existing fixtures can remain unchanged.

## Verdict

CHANGES REQUESTED — address the scoping contradiction above; no other Round 9 changes are requested.
# Design Review — plan.md (Round 10)

Date: 2026-08-05
Author: Codex
Status: CHANGES REQUESTED

## Summary

The Round 9 correction is present and correct: the precedence ladder is now scoped away from messages-only rows, preserves their type-specific `delivered_at` meanings, and defines the ordering for folded pairs. One adjacent exhaustiveness defect remains inside the `lead_inbox` ladder: it includes external rows and promises exact-one classification, but its last two tiers are restricted to inbox rows.

## What's Good (Keep)

- The ladder now explicitly applies to physical `lead_inbox` rows, including folded mirrors and external rows, while messages-only rows remain governed by their per-type matrix mappings.
- Folded pairs have an unambiguous evaluation order: classify the `lead_inbox` mirror first, then apply the merge rule. This resolves the Round 9 contradiction without changing the converged dual-identity or settlement design.
- The unread coverage projection, settled-mirror handling, mandatory mirror fixtures, and fleet-wide migration/rollback ordering remain internally consistent.
- Current code confirms the rationale for excluding messages-only rows: `messages` lacks the settlement/carrier columns and its `delivered_at` mapping remains type-specific.

## Issues & Recommendations

1. **HIGH — Make the external branch exhaustive within the exact-one `lead_inbox` classifier.** The header says all physical `lead_inbox` rows—including external rows—must pass the ladder with no exemption, and the fixtures explicitly include external processed-only/delivered-only/consumed-only/three-null rows. Tiers ① and ② classify the first and third cases, but tier ③ requires `carrier='inbox'` and tier ④ is also inbox-only, so external delivered-only and external three-null rows land in no tier. The external matrix later maps those states to ACKED and QUEUED, but the matrix header says every `lead_inbox` state is classified by the ladder first. Make tiers ③ and ④ carrier-aware—for example, delivered-only inbox → recorded manual decision while delivered-only external → ACKED; three-null inbox → true-unread QUEUED while three-null external → incomplete/unsettled QUEUED—or explicitly define a post-①/② external branch and narrow the exact-one claim accordingly. Keep the existing external cross-product fixtures to prove exhaustiveness.

## Verdict

CHANGES REQUESTED — close the external-row exhaustiveness gap above; no other Round 10 changes are requested.
# Design Review — plan.md (Round 11)

Date: 2026-08-05
Author: Codex
Status: APPROVED

## Summary

The Round 10 exhaustiveness issue is fully resolved. The carrier-aware `lead_inbox` ladder now classifies every physical row exactly once, composes cleanly with the per-type matrix and folded-pair rules, and preserves the deliberately narrower inbox unread acceptance anchor.

## What's Good (Keep)

- Tier ③ now distinguishes the one inbox delivered-only anomaly from external delivered-only rows, mapping the latter to ACKED consistently with the external lifecycle and loop invisibility contract.
- Tier ④ now distinguishes true-unread inbox rows from incomplete/unsettled external rows; both become QUEUED for their own reasons, while only the inbox branch participates in the unread id-set equality anchor.
- The external three-null rows are explicitly reconciled outside the unread anchor, so the coverage contract remains exhaustive without contaminating the founder-side unread acceptance metric.
- The messages-only exclusion and folded-pair evaluation order from Round 10 remain correct: messages retain type-specific `delivered_at` semantics, and mirrors are classified before merge rules are applied.
- The dual-identity coverage projection, settled-mirror rule, cross-product fixtures, and fleet-wide migration/rollback runbook remain mutually consistent with §§1–12 and the current-code spot checks from Round 8.

## Issues & Recommendations

1. None. No blocking or non-blocking design defects were found in the Round 11 plan.

## Verdict

APPROVED — ready to implement
# Design Review — plan.md (Round 12, Bridge design-review gate lane)

Date: 2026-08-05
Author: Bridge design-review lane (gate `b515d6ba` / request `d1027baa`)
Status: CHANGES REQUESTED → fixed in commit 97aadb83 (prior exec d65b5262)

2 HIGH(§5.3a Lead/bridge claim-TTL 重领需保留为旧能力平移;folded question 的 type/ref_id 权威与 discriminator)+ advisories(lineage 永久解引用、orphan mirror、transient admission、append-only 容量、priority/index、Bridge 依赖、发现式 inventory、registry replay、delivery fallback、archive contention)。全部就地折入,见 plan §12.D。

# Design Review — plan.md (Round 13, Bridge design-review gate lane)

Date: 2026-08-05
Author: Bridge design-review lane (request `c51f5e70` round 2)
Status: CHANGES REQUESTED → fixed by successor design exec a939207a

- HIGH `orphan-branch-overreaches-founder-hub`: orphan 镜像分支谓词误捕 founder_reply(1,046)/discord_cross_department(2)构造性 dangling 行 → 谓词收窄到 `source LIKE 'question:%'/'ack_receipt:%'`,新增非镜像矩阵行,恒等锚同步收窄。
- HIGH `lead-failed-batch-requeue-gap`: §5.3a 重领谓词缺 `claimed_by IS NULL` 三路条件;失败路径产出 NULL-claim 态会永久搁浅 → 三路谓词逐字入合同,Lead/bridge 失败转移 + batch_id 生命周期显式定稿,transient 释放清 batch_id。
- MEDIUM `reclaim-index-column-order`: 重领索引排序键前有非等值列,EXPLAIN 断言自败 → 双索引重排为等值前缀+排序键,claim/TTL 判定移 CAS 步。
- MEDIUM `orphan-row-notnull-columns-undefined`: 合成 orphan 行 from_agent/content 无定义 → lineage→legacy_alias→fail-closed 三级派生,lineage 触发器迁移后创建。
- LOW `inventory-detects-poison-views`: 库态分类按 `sqlite_master.type`+schema_generation,毒药 VIEW 不误报 legacy。
- LOW `archive-single-family-size-unbounded`: 单 family 2MB 内嵌体积上限 + 显式维护路径 + 合成 fixture。
- LOW `question-priority-derivation`: priority 逐 producer 派生表落 §5.3(hub 0 / question 1 / protocol 1 / report question 2 / lead_event 2)。

全部 7 项折入 plan(§3.1/§5.3/§5.3a/§7/§8.2/§12.C/§12.E)。
