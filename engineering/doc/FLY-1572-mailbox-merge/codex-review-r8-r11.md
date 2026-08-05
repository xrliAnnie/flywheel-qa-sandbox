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
# Design Review — plan.md (Round 14)
Date: 2026-08-05
Author: Codex
Status: CHANGES REQUESTED

## Summary

All seven Round 13 edits are present in the repository's actual `plan.md`. The narrowed mirror predicate, non-mirror founder/xdept row, three-way reclaim guard, batch lifecycle, reordered reclaim indexes, structural inventory classification, 2 MB family cap, and producer priority values are directionally correct and match the checked code. The orphan NOT NULL remedy is only partially complete, however, and the fresh full-plan pass found one migration blocker plus several adjacent high-severity gaps.

The most serious issue is that §8.2 still classifies `messages` rows independently while §7 requires RPC-family-atomic retention. On the current read-only production snapshot, that rule would archive question roots needed by 64 still-unconsumed responses. The plan is therefore not ready to implement as written.

## What's Good (Keep)

- The R13 orphan predicate now matches the actual producer shapes. `QuestionAdmission` writes `source='question:<seq>'`; `ProtocolIngress` writes `source='ack_receipt:<id>'`; `enqueueHubRoot` writes `source='founder_reply'`; and `ExternalReceiptSaga` writes `source='discord_cross_department'` with a Discord message id in `ref_message_id`. A fresh read-only check of `comm/flywheel/comm.db` found 3,231 dangling refs: 2,181 question mirrors, 1,048 founder replies, 2 cross-department rows, and 0 ack mirrors. The extra two founder rows relative to the plan's 08-05 snapshot are ordinary live drift, not a design discrepancy.
- The narrowed predicate is applied consistently to both the orphan branch and unread coverage anchor, and the new founder/xdept row correctly preserves `id = delivery_id = old id` with `ref_message_id -> ref_id`.
- The R13 reclaim correction matches current behavior: `claimModelBatch` and `claimByClass` use `(claimed_by IS NULL OR claimed_by = owner OR claim_expires_at < now)`; model/protocol failure clears the claim while retaining frozen membership; and fresh model selection requires `batch_id IS NULL`.
- The two proposed reclaim indexes have the correct equality-prefix/order shape. A direct SQLite `EXPLAIN QUERY PLAN` check used `mailbox_lead_reclaim` for `(to_agent,msg_class) + ORDER BY priority,seq` and `mailbox_bridge_reclaim` for `from_agent + ORDER BY priority,seq`, with no TEMP B-TREE.
- The orphan question fallback is grounded in real data: all 2,181 current orphan question mirrors have `legacy_alias`, while only 1,095 currently join lineage, so lineage-only derivation would be insufficient. Delaying the trigger avoids manufacturing lineage for synthetic orphan rows; the missing positive backfill is addressed below.
- The R13 priority table matches current producers: founder hub root 0, ordinary question 1, report question 2, protocol 1, and lead event 2. The structural `sqlite_master.type + schema_generation` inventory rule also correctly distinguishes legacy tables from migrated poison views.
- The family-size cap and explicit maintenance path are present, with a required over-threshold fixture. Keep that bounded-open policy.

## Issues & Recommendations

1. **[BLOCKER] §8.2 violates §7's RPC-family-atomic retention and would strand live responses.** The matrix sends `messages 过期/terminal 历史` directly to `migrated_history`, but independently maps an undelivered response to `QUEUED`. Current pull/authorization code still needs the question root (`check.ts` reads the question before `consumeGateResponse`; `consumeGateResponse` joins response to question), and §7 itself says a family cannot archive while any member is non-terminal. A read-only production query found **64** responses with `delivered_at IS NULL` whose question is expired or `terminal_disposed`; 63 have a consumed canonical mirror. The current row-wise rule would keep the response but remove its question. There is also one expired, unanswered, non-terminal question without a mirror; `db.ts:1242-1252` and `getPendingQuestions` deliberately protect exactly this FLY-1279 case, while the plan would archive it solely because it is expired. Make migration classification family-first: retain every family containing a QUEUED/LEASED member, retain unanswered non-terminal questions regardless of `expires_at`, and keep the question root (normally ACKED) while a response remains unconsumed. Only send an entire family to history when every member is delivery-terminal and the RPC dimension is terminal. Add fixtures for terminal-question + unread-response, expired protected unanswered question, and family-wide history.

2. **[HIGH] Delaying `receipt_root_lineage_capture` until after load drops legitimate migrated questions with no legacy mirror.** The current trigger creates lineage only when a `lead_inbox` mirror is inserted. §8.2 explicitly migrates a live messages-only question with a generated `delivery_id`, but the R13 rule loads it before installing the new mailbox trigger; its later materialization is an UPDATE, so the AFTER INSERT trigger never fires. Terminal settlement and archived receipt resolution then lack permanent lineage. During migration, explicitly insert-or-canonical-compare lineage for every real migrated live question using `(delivery_id, from_agent, id, to_agent)`, while excluding synthetic orphan rows; then install the runtime trigger. Add a migrated messages-only question test through materialization, archive, and terminal settlement.

3. **[HIGH] The combined orphan question/ack branch is not type-correct, and its question transition contradicts §5.3.** The predicate includes `ack_receipt:%`, but the destination hardcodes `type='question'`, `source_kind='question_orphan'`, and `revoked_missing -> DEAD`. A true-unread orphan ack mirror must instead remain a bridge protocol row (`type='ack_receipt'`, `recipient_kind='bridge'`, bridge recipient, protocol content/membership); its legacy content is sufficient for `ProtocolIngress.handle`, and current ack mirrors do not carry the question-style `legacy_alias`. Separately, §8.2 says a synthetic orphan question dies on first claim, while §5.3 says a pre-materialization `revoked_missing` failure is retryable and returns to QUEUED. Split the migration cases and make the runtime discriminator explicit: migrated `source_kind='question_orphan' + revoked_missing` is terminal; ordinary pre-materialization holds remain retryable. If orphan acks are intentionally unsupported, assert their count is zero at preflight instead of promising an ack fixture and silently converting them to questions.

4. **[HIGH] `from_agent NOT NULL` remains undefined for non-mirror `lead_inbox` producers and their migration rows.** R13 defines it only for orphan mirrors. The current table has no sender column, and the plan's §4.1 “source value mapping” never actually assigns sender identities. This affects at least `discord_chat`, `founder_reply`, `discord_cross_department`, `lead_event:*`, and `protocol_quarantine:*`; the current snapshot already has eight unsettled external `discord_chat` rows that would need a value. `ExternalReceiptMessage` does not even carry the sending Lead identity, so this is not just a migration expression—it requires an API/authority decision. Add an exhaustive source-family table defining live-write and migration derivation for `from_agent`, `source_kind`, and `source_ref`, including fail-closed behavior. Update producers where the true sender is not presently passed, and add per-family canonical replay tests. Do not use an unspecified sentinel.

5. **[HIGH] The fleet runbook claims to quiesce all writers but stops only Bridge and Leads.** Runners and one-shot CLI/MCP processes open `CommDB` on demand (`gate`, `ask`, `inbox`, `check`, `complete`, etc.) and may not hold the file when the `lsof` snapshot runs. A Runner can therefore write after the “no holders” check or after the backup, making rollback lose post-backup data; it can also execute an old CLI against a database already converted to poison views. Preserve the founder-decided fleet-wide hard cutover, but add an enforceable writer fence: stop/park all Runner and inbox-MCP writers and prevent new launches, or install a verified OS/runtime write barrier for every frozen inventory path. Recheck zero writers immediately before backup and before each cutover transaction, and prove no post-backup legacy write in a fault-injected migration/rollback test.

6. **[MEDIUM] The R13 failed-batch contract omits the due-time guard and conflates Lead/protocol attempt limits.** The plan records `next_retry_at` backoff, but the frozen-batch selection/CAS contract never requires `next_retry_at IS NULL OR next_retry_at <= now`. With `claimed_by=NULL`, the stated three-way guard can reclaim on the next 1-second tick and exhaust attempts immediately. Current callers set `respectRetryAt: true`, and current selection applies that predicate to both existing and fresh work. Also, §5.3a says Lead/bridge rows exceed `maxModelAttempts=5`, while current protocol uses `maxProtocolAttempts=3`. Make the due predicate contractual for Lead and bridge reclaim, retain the distinct 5/3 caps, and add clock-driven backoff tests for both lanes.

7. **[LOW] Step 0 is stale relative to the upstream authority.** `doc/messaging-rework/design.md` already contains the P9 note with status `confirmed` and durable confirmation ids, but §9 still says the note is merely drafted and must be synchronized/confirmed before implementation. Mark the step complete or turn it into a verification-only precondition so implementation does not wait on or duplicate an already-finished governance action.

## Verdict

CHANGES REQUESTED — address items above

# Design Review — plan.md (Round 15)
Date: 2026-08-05
Author: Codex
Status: CHANGES REQUESTED

## Summary

All seven Round 14 findings are represented in the actual Round 15 text, and the lineage, orphan-type, sender-identity, retry, and governance corrections are substantively sound. The new family-first rule also fixes the two concrete data-loss shapes from Round 14.

The fresh pass found two remaining correctness gaps in those folds. First, the family pre-pass claims parity with §7 but omits §7's 72-hour retention gate and does not fully specify the state of roots retained only by the override. Second, `chmod` is temporarily removed for the in-place migration, so it is not a continuous writer fence during the only interval where a late same-user CLI can corrupt the backup/cutover boundary. A smaller predicate-description contradiction remains around supported ack mirrors versus unsupported orphan acks. These are localized, but the first two keep the plan from being implementation-ready.

## What's Good (Keep)

- The family-first classification is the right abstraction. It retains the question root for an unread response and preserves unanswered, non-`terminal_disposed` questions regardless of expiry. Keep the three family fixtures and the rule that history admission is family-atomic.
- The lineage repair is complete in the important direction: every real migrated live question gets an insert-or-canonical-compare into permanent `receipt_root_lineage`; synthetic orphan questions are excluded; and the runtime trigger is installed only after backfill. The materialize → archive → terminal-settlement test exercises the right lifecycle.
- The orphan split is now type-correct. Only dangling `question:%` rows may synthesize `question_orphan`; dangling `ack_receipt:%` is a preflight-zero, fail-closed condition. §5.3's `source_kind='question_orphan'` discriminator also cleanly separates permanent missing-source rows from retryable admission holds.
- The new §4.1 table gives `from_agent` an explicit authority for every live producer family in scope. In particular, extending the xdept API to carry the sending Lead is safer than reconstructing authorization from a Discord id. Unknown live source families fail closed rather than inventing an identity.
- Lead and bridge frozen-batch reclaim now honors `next_retry_at`, retains the exact three-way claim guard, and preserves the distinct model/protocol attempt caps of 5 and 3. The clock-driven tests are the correct regression boundary.
- Step 0 now matches the upstream authority: `design.md` contains the P9 note with `status=confirmed` and durable confirmation ids, so verification-only is correct.
- The runbook now inventories all writer classes, stops fleet processes, blocks Runner launches, rechecks holders at both important seams, and requires an old-build negative test. Keep those operational checks even after fixing the fence primitive below.

## Issues & Recommendations

1. **[HIGH] The family history predicate still omits §7's 72-hour retention condition.** §8.2 says a family goes to `migrated_history` when all members are delivery-terminal and the RPC dimension is terminal, then calls that “字面同一” with §7. Section 7 has a third condition: the family's latest terminal timestamp must be at least 72 hours old. A fresh read-only query of `comm/flywheel/comm.db` found **363** fully delivery/RPC-terminal question families, all **363** still inside that 72-hour window. The Round 15 rule would move them to history at cutover even though the steady-state archiver must retain them. Make migration use the full archive eligibility predicate, including `latest_terminal_at + 72h <= cutover_now`; terminal families still inside the window remain terminal rows in `mailbox`. Add T+71h/T+73h migration fixtures so “same predicate” is executable, not descriptive shorthand.

2. **[HIGH] Temporarily lifting `chmod` reopens the post-backup writer race the fence is meant to close.** POSIX mode bits are file-wide, not process-scoped. The migrator and old one-shot CLIs run as the same user; while the plan temporarily restores write permission so the migrator can checkpoint and run `BEGIN IMMEDIATE`, any newly launched old CLI can also open the file. `CommDB` immediately opens read-write, sets WAL mode, executes schema/migrations, and purges on construction (`packages/flywheel-comm/src/db.ts:773-785`). Thus the “barrier immediately before cutover” is a TOCTOU check: after permission is lifted, it no longer fences a late CLI. Keep the canonical legacy path continuously non-writable to other opens. Viable implementations include opening and retaining the migrator's write-capable descriptor before applying the read-only mode, then verifying it is the sole holder and never lifting the mode; migrating a staging copy followed by the already-specified atomic/sidecar-safe swap; or using a genuinely separate migration identity/ACL. Add a race test that launches an old CLI at every seam while the migrator itself has write capability—not only while the file is statically read-only.

3. **[MEDIUM] Family-forced roots outside the normal matrix still lack a deterministic state/timestamp mapping.** The matrix's question row applies only to “未过期未 terminal” questions and maps no-mirror rows to `QUEUED`. The family pre-pass overrides the destination for expired/terminal roots but says only “正常映射(通常 ACKED).” Current production has a `terminal_disposed` question with an unread response and **no mirror**; that retained dependency root must be `ACKED`, never `QUEUED`, while the protected expired unanswered/no-mirror case must remain `QUEUED`. Specify these two override mappings, including the `acked_at` derivation when no mirror timestamp exists, and make the terminal-root fixture explicitly mirrorless. Otherwise implementations can either redeliver an answered question or suppress the protected unanswered one.

4. **[MEDIUM] The unread anchor still says it uses the same predicate as the orphan branch, but the predicates intentionally differ after Round 15.** The orphan-synthesis branch is now `source LIKE 'question:%'` only; the unread folding/identity anchor correctly still recognizes source-backed question **and ack** mirrors. Rewrite §8.2's anchor wording to distinguish: `(a)` fold/anchor predicate = question or ack with a matching `messages` row, `(b)` orphan synthesis = dangling question only, and `(c)` dangling ack = preflight abort. Keep a source-backed unread ack fixture, but do not describe it as an orphan fixture.

## Verdict

CHANGES REQUESTED — address items above

# Design Review — plan.md (Round 16)
Date: 2026-08-05
Author: Codex
Status: CHANGES REQUESTED

## Summary

All four Round 15 findings are folded into the actual plan. The full 72-hour family predicate, deterministic root states, and three-way mirror classification are correct and complete. Moving the transaction to a staging database is also the right way to keep the canonical legacy path continuously fenced.

The new cutover sequence still contains one internal impossibility: after the canonical file becomes `0444`, a detected WAL/hash mismatch cannot return to the read-write checkpoint step without lifting the fence, while the race test simultaneously requires a pre-fence old-CLI write to fail even though no OS fence exists yet. The staging swap also needs an explicit forward-cutover recovery ledger and same-filesystem placement contract; §8.4's rollback phases cannot be imported verbatim. These are localized runbook corrections, but they affect the migration's core safety proof.

## What's Good (Keep)

- The family admission rule now exactly matches §7: delivery-terminal, RPC-terminal, and past the latest-terminal + 72-hour boundary. T+71h/T+73h fixtures make the time boundary unambiguous, and in-window terminal families correctly stay in `mailbox` for steady-state archival.
- Family-forced roots now have deterministic states. Answered/`terminal_disposed` dependency roots are ACKED even without a mirror, while expired protected unanswered roots remain QUEUED. The explicitly mirrorless terminal fixture covers the real production shape found in Round 15.
- The unread anchor is now correctly split into source-backed question/ack folding, dangling-question synthesis, and dangling-ack preflight abort. The source-backed ack fixture is labeled accurately.
- Staging migration eliminates the original same-UID `chmod` window during DDL. Before the swap, the canonical legacy database is read-only; after the swap, poison views and `schema_generation` reject old binaries. Keep this two-state defense.
- The staging transaction still preserves the hard-cutover contract: completed marker last, rollback on any transaction failure, full reconciliation before swap, and no feature flag or mixed-schema runtime.

## Issues & Recommendations

1. **[HIGH] The checkpoint → fence convergence loop contradicts the continuous-fence invariant and its race test.** Step 2b says that after `chmod 0444`, a WAL/hash mismatch returns to step 2a for another read-write checkpoint. That requires making the canonical legacy database writable again, directly violating “写闸一经上闸绝不解除.” Also, an old CLI injected in the a→b seam runs before `chmod`; it may legitimately commit. The hash/WAL check can detect and absorb that write, but the stated test cannot require it to fail loud with zero changes. Use a contract that is mechanically satisfiable. One safe shape is: checkpoint as a best-effort optimization, apply `0444`, wait until all pre-fence holders drain, then treat the frozen **DB + any committed WAL** as the source snapshot; run SQLite online backup read-only so WAL frames are included, validate the backup, and quarantine/remove canonical sidecars only after the backup is durable and before the atomic swap. The pre-fence race test should require “commit is detected and included in the authoritative backup/retry,” while the three post-fence seams require fail-loud and zero change. If WAL-free backup remains mandatory, the plan needs a different process-selective barrier that lets only the migrator checkpoint after fencing.

2. **[HIGH] The forward staging swap lacks its own durable crash/re-entry state machine.** Section 8.4 defines a rollback intent with `refs_swapped → db_swapped` phases and assumes the pre-swap canonical database is the migrated one. The forward operation has the opposite worlds and no refs swap, so “follow §8.4 discipline” does not define what happens after crashes between staging verification, canonical rename, parent-directory fsync, and verification. It also leaves an unswapped legacy canonical file at `0444` if staging migration fails and the fleet chooses the abandon/restart-old-binary path; §8.2 step 3 only discusses rolling back already migrated databases. Define an external forward `migration-swap-intent` with canonical/staging/backup hashes, original file mode, sidecar state, and phases such as `fenced → backed_up → staging_verified → canonical_swapped → dir_fsynced → verified → done`. Re-entry must inspect the actual schema/hash before advancing, and abort-all must restore the exact original mode for every unswapped verified-legacy database. Fault-inject every phase and run recovery twice.

3. **[MEDIUM] “Private staging directory” must be constrained to the canonical filesystem.** Atomic `rename` is only guaranteed within one filesystem; a default temporary directory can reside on another device and fail with `EXDEV`. Specify a mode-0700 staging directory adjacent to the canonical database (or otherwise assert equal `st_dev`), a mode-0600 staging file, and fail closed on a cross-device path—never fall back to copy-overwrite. Include the staging file/directory and canonical parent-directory fsyncs in the forward intent above.

## Verdict

CHANGES REQUESTED — address items above

# Design Review — plan.md (Round 17)
Date: 2026-08-05
Author: Codex
Status: CHANGES REQUESTED

## Summary

All three Round 16 findings are folded into the actual plan. The frozen DB+WAL snapshot model is technically sound, the race semantics are now honest, and the forward intent plus same-filesystem staging contract close the prior swap/re-entry gaps.

One high-severity abort-path omission remains. After the durable backup, §8.2 quarantines the canonical WAL/SHM before swap, but abort-all restores only the main file's original mode for an unswapped legacy database. If the authoritative snapshot contained committed WAL frames—the case this round explicitly adds—the canonical main file alone can be stale. Restarting the old binary after merely restoring its mode can therefore lose a legitimate pre-fence commit.

## What's Good (Keep)

- Checkpoint is correctly demoted to an optional WAL-size optimization. Correctness now starts at the `0444` fence and uses the frozen main DB plus committed WAL frames.
- I reproduced the proposed primitive locally: with the DB, WAL, and SHM all `0444`, SQLite's read-only online backup included a row present only in WAL. The resulting backup passed integrity checks and contained the row. This validates the core Round 17 approach.
- The pre-fence seam now has the right contract: a commit may succeed, but it must be detected and included in the authoritative backup. The three post-fence seams correctly require fail-loud and zero logical changes.
- The external `migration-swap-intent` records hashes, original mode, and sidecar state; the seven forward phases, actual-world-state re-entry, and two-pass fault recovery are the right structure.
- Staging is now concretely atomic: adjacent mode-0700 directory, equal `st_dev`, mode-0600 file, `EXDEV` fail-closed, no copy-overwrite fallback, and directory fsyncs in the intent.
- The earlier family retention, lineage, orphan, identity, retry, and source-backed anchor corrections remain intact.

## Issues & Recommendations

1. **[HIGH] Abort-all does not restore committed WAL state after canonical sidecars are quarantined.** Step 2c explicitly allows the frozen authority to be `main DB + committed WAL`, backs that combined state up, and then quarantines canonical sidecars. Step 2f/3(b) says an unswapped verified-legacy database is made restartable by restoring its original mode, but mode restoration does not put those WAL frames back into the canonical database. A local reproduction made the failure concrete: the fenced read-only online backup contained the WAL-only row, while a copy of the canonical main file without its sidecars failed with `no such table`. Extend the forward intent with an explicit sidecar-quarantined/restoration state. On abort-all before `canonical_swapped`, either (preferred) atomically replace canonical with a verified copy of the durable online backup, which has the WAL frames materialized, then restore the original mode and fsync; or restore the quarantined WAL state by recorded hashes before reopening. The all-legacy exit gate must compare the restored canonical projection/hash/row counts with the authoritative backup, not only schema classification and mode. Add a fault fixture: commit a row only to WAL in the a→b seam, complete backup, quarantine sidecars, fail staging, choose abort-all, run recovery twice, then prove a true old build reads that row after restart.

## Verdict

CHANGES REQUESTED — address items above

# Design Review — plan.md (Round 18)
Date: 2026-08-05
Author: Codex
Status: APPROVED

## Summary

The single Round 17 HIGH is fully addressed in the actual plan text. Abort-all now restores the authoritative database content as well as its original mode, the forward ledger explicitly tracks sidecar quarantine/restoration, and the all-legacy exit gate proves equivalence to the WAL-inclusive backup before an old binary may restart.

I rechecked the surrounding forward-swap sequence and found no remaining feasibility, correctness, sequencing, or recovery contradiction. The plan is ready to implement.

## What's Good (Keep)

- `sidecars_quarantined` is now a first-class forward-intent phase, ordered after the durable backup and before staging verification. The intent records enough DB/backup/sidecar state for actual-world re-entry rather than trusting a possibly stale phase field.
- The preferred abort path is correct: atomically replace canonical with a verified copy of the online backup, restore the original mode, and fsync. Because the online backup materializes committed WAL frames, the result is a self-contained legacy database rather than a stale main file.
- The hashed-WAL fallback remains fail-closed and is subordinate to the safer materialized-backup path.
- The all-legacy fleet exit now checks restored projection, hash, and row counts against the authoritative backup in addition to schema classification and mode. This closes the prior false-safe state.
- The fault fixture is exactly the required regression: WAL-only pre-fence commit, durable backup, sidecar quarantine, staging failure, abort-all, two recovery runs, then a true old build reads the row.
- I reproduced the preferred path locally end to end: a row present only in WAL survived read-only online backup, sidecar quarantine, atomic canonical replacement from the backup, mode restoration, and integrity check.
- The previous family-atomic retention, 72-hour gate, lineage backfill, orphan/type handling, sender identity, reclaim/backoff, continuous fence, same-filesystem staging, poison-view cutover, and fleet rollback contracts remain consistent.

## Issues & Recommendations

No blocking issues. During implementation, keep the planned fault injection at every forward-intent phase and preserve the rule that no old binary starts until the content-equivalence and mode checks both pass.

## Verdict

APPROVED — ready to implement
