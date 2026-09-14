# FLY-2399 自动审批学习 — Code review R2
Issue: FLY-2399 (https://linear.app/geoforge3d/issue/FLY-2399)
日期: 2026-09-11
基于: implementation.md

reviewVerdict: CHANGES_REQUESTED; reviewedHead: 87aab52be0f6d526b7f02585292561f56aafbd64; request: e77881e0-3617-406e-b8f8-a8a9e2e42e88

Only HIGH bridge-runtime-off-mode-test-red is repaired. Other findings remain advisory.

## HIGH: bridge-runtime-off-mode-test-red

packages/teamlead/src/bridge/__tests__/ship-judgment-runtime.test.ts:205 — Head is CI-red: two tests in the changed package still assert the old off-mode behaviour

`cdfa6320f` changed the off-mode contract (`ShipJudgmentRuntime.modeTick` now returns immediately when `mode() === "off"`, and `LearningDelivery.work`/`claim` short-circuit) and updated `src/ship-judgment/__tests__/{runtime,learning-delivery,learning,outcomes}.test.ts`, but did not update `src/bridge/__tests__/ship-judgment-runtime.test.ts`. That file still builds the runtime with `mode: () => "off"` (line 197) and asserts that ack receipts are posted anyway.

Reproduced at this exact head, in isolation:
```
$ npx vitest run src/bridge/__tests__/ship-judgment-runtime.test.ts
 × sends at most two pending learning receipts with configured bot (true)
   → expected +0 to be 2  (ship-judgment-runtime.test.ts:205)
 × sends at most two pending learning receipts with configured bot (false)
   → expected { n: +0 } to deeply equal { n: 3 }  (ship-judgment-runtime.test.ts:223)
 Test Files 1 failed (1) | Tests 2 failed | 2 passed (4)
```
The same two failures appear in the broader run (87 files: 86 passed, 1 failed; 712 tests: 710 passed, 2 failed). `packages/teamlead/vitest.config.ts` has no `exclude`, and CI runs `pnpm --filter flywheel-teamlead test:run --shard=N/3` (.github/workflows/ci.yml:162-167), so this file lands in a shard and turns that shard red. `tsc --noEmit` on the package is clean, so this is purely the stale assertions.

Both stale assertions encode exactly the behaviour that was deliberately removed (ack POSTs while the flag is off), so the test — not the code — is what needs updating: assert 0 posts and 0 `state='delivered'` rows in `off`, and move the two-per-round / owner-missing-defer coverage to a `dry_run` runtime. Note the `!botConfigured` branch additionally asserts `n: 3` rows with `last_error='learning_owner_or_guild_missing'`, which can no longer happen in off because `delivery.defer(...)` is never reached.

## MEDIUM: off-leaves-opinion-marked-current

packages/teamlead/src/ship-judgment/runtime.ts:84 — Off-mode full stop also skips `setMode`, so a live opinion is never marked historical while the flag is off

`modeTick` now returns before `modeSweep`, and `modeSweep` is the only caller of `ShipJudgmentDelivery.setMode`. Consequently a `dry_run -> off` transition never writes `delivery_mode='off'`; the row keeps `delivery_mode='dry_run'`, `mode_label='current'`.

Two visible consequences. (1) `readEpicJudgment` (ship-judgment/epic-facts.ts) computes `historical = delivery_mode !== 'dry_run' || mode_label === 'history'`, so the Epic page keeps rendering the stale advisory as `display: "published"` for as long as the flag is off. (2) `sendJudgmentHistory`'s `历史试判，模式已变` PATCH never runs in off, so the posted Discord opinion keeps its full three-point text with no staleness marker. implementation.md §26 explicitly describes off as a mode that still PATCHes its own history label (`off/auto 只恢复未知 POST 或 PATCH 自己的历史标记`), so the new full-stop contradicts the stated design for this one action.

No authority is affected (the opinion message itself always says `dry_run` and `仍由你批准`, and `ShipJudgmentDelivery.claim` / `sendJudgmentOpinion.enabled()` still block all posting in off), which is why this is not ship-blocking. But if the founder flips the kill-switch during an incident, the machine opinion continues to present itself as current on the Epic page. Consider either allowing the history-label PATCH in off, or having the `off` transition at least write `delivery_mode`/`mode_label` before the loop stops.

## MEDIUM: duplicate-file-aborts-collection

packages/teamlead/src/ship-judgment/inputs.ts:60 — A card with two PRs in the same repo touching a shared path throws out of `freeze` and silently yields no opinion

`contract.targetSetDigest` dedups targets on `[repo_identity, pr_number]`, and `workflow_declared_pr`'s primary key is `(run_id, revision, repo_identity, pr_number)` — both explicitly allow two declared PRs against the *same* `repo_identity`. `collect.ts` then appends one `files` entry per diff file per target, keyed only by `(repo_identity, path)`. `ShipJudgmentInputs.freeze` rejects that with `throw new Error("duplicate_file")`, and unlike every other collection failure this one is a raw throw rather than a `CollectionFailure`/`undetermined` reason.

Failure scenario: a run declares PR #100 and PR #101 in `owner/repo`, both editing `packages/teamlead/src/StateStore.ts`. `collectJudgmentInput` returns `status: "ready"`, `ShipJudgmentRuntime.collect` calls `freeze`, which throws before the transaction. The throw escapes `scanner.process` (caught only as `onError("judgment_card_scan_failed")`) and `worker.prepare` (caught only as `onError("judgment_worker_failed")`). Neither path calls `this.deps.unavailable(question, reason)`, so the card gets no opinion and no `undetermined` record — the founder sees nothing at all, repeatedly, with only a console warning. Ironically this is precisely the overlapping-file case the mechanical conflict check exists to report. Either dedupe/guard `files` inside `collectJudgmentInput` and return `undetermined` with a named reason, or key `files` on `(repo_identity, pr_number, path)`.

## MEDIUM: audit-sidecar-unbounded-judgment-evidence

packages/teamlead/src/epic-page/render-html.ts:489 — Judgment evidence is added to the audit sidecar unconditionally, outside the new page budget

`renderJudgment` calls `dictionary.sidecar.add(cell)` *before* the `judgmentRows` limit check, and `renderJudgmentHistory` adds its cell unconditionally. `AuditSidecar.add` stores the full value losslessly, so each item contributes the entire `EpicJudgment` including `evidence.evaluation` (the parsed `result_json`, capped by the DB at 64 KiB) and `evidence.mechanical` (the parsed candidate, capped at 98 KiB with up to 1000 `overlaps`).

`renderEpicPageBudgetBundle` binary-searches only on `hostedBundleBytes(bundle)`, which measures `bundle.html` alone, and `epic-page-publisher.ts` enforces only `EPIC_PAGE_MAX_HTML_BYTES` on `staged.html`. Nothing on the path — `putEpicPage`, `serveAudit` in report-gateway-runtime.ts — caps `audit.json`. So shrinking `judgmentRows` to 0 (which the new budget code does under pressure, emitting `机器意见摘要已缩减；完整依据见审计附件`) leaves the sidecar at full size while promising the reader the evidence is in the attachment.

Failure scenario: a flywheel Epic with a few dozen gate-carrying children, each with a full model evaluation, produces a multi-MB `index.audit.json` that is re-uploaded to Blob on every Epic publish — and the publish cadence just increased, since `shipJudgmentHistoryRuntime.onChanged` now calls `epicPageRefresher.requestRefresh("flywheel", "ship_judgment_history")`. A byte cap on `bundle.audit.json` (or trimming `evidence` for sidecar entries beyond the rendered limit) would close this.

## MEDIUM: legacy-freeze-repatch-on-every-boot

packages/teamlead/src/StateStore.ts:54318 — Every Bridge boot re-edits all previously frozen legacy auto-narrow opinion messages

Unchanged at this head. `invalidateAutoNarrowLegacyFreezeOnStartup` unconditionally clears `legacy_frozen_at` and `next_attempt_at` for every row where either freeze column is non-null, and plugin.ts calls it on each boot before `gatePoller.start()`. `reconcileAutoNarrowOpinionDeliveries` (bridge/auto-narrow-opinion-delivery.ts, dry_run branch) then re-claims each row and re-issues `deps.edit(...)` with byte-identical freeze text, 20 rows per sweep, until every row is re-frozen.

Failure scenario: flywheel has N cards with a frozen legacy opinion message and the Bridge restarts (routine, via launchd). Each restart produces N Discord PATCHes that change nothing but bump `edited_timestamp`, so the founder sees fresh '(edited)' churn on old cards and Discord write budget is consumed for no state change. The rollback-recovery intent is legitimate, but it should be conditioned on something that can actually detect a rewritten message (a stored content digest, or a bounded one-shot marker) rather than re-editing every frozen row on every process start.

## MEDIUM: historical-thread-backlog-replay

packages/teamlead/src/bridge/gate-poller.ts:2407 — Re-adding terminal-run threads to the founder-reply scan replays their accumulated message backlog

Unchanged at this head (the off-mode guard added to `replyThreads` only suppresses this while the flag is off). The loop merges `listShipJudgmentReplyThreads()` results into `byThread`. Those threads belong to runs no longer in `listNonTerminalSessions()`, so they dropped out of founder-reply scanning at some point while their inbound cursor stayed durable — plugin.ts wires `new FileInboundCursorStore(founderReplyCursorPath)`.

`emitFounderReplyDeliveryForThread` bootstraps to head only when `cursorStore.load()` returns `undefined`; for these threads it returns the old saved cursor, so every founder message posted since then is processed on first re-entry. With `questions: []` those messages fall through `processFounderMessage` to `deliverAmbiguousToLead`, and a reply to a superseded card additionally triggers `recordVoidedWorkflowGateInput` plus a late `oldCardGuidance` post. Concretely: the founder posts two follow-up notes the day after a run lands; weeks later a clarification is delivered in that thread, the thread rejoins the scan set, and the Lead receives both stale notes as fresh founder replies while the bot posts stale guidance. Consider bootstrapping to head, or clamping the effective `after` to the clarification's `visible_at`, for threads entering via this new historical source.

## MEDIUM: scan-cursor-reused-across-orderings

packages/teamlead/src/bridge/gate-poller.ts:2317 — `founderReplyScanCursor` is reused as the clarification-thread page cursor despite a different ordering and domain

Unchanged at this head. `this.founderReplyScanCursor` is the pre-existing round-robin position over *all* zero-question scan threads (written at line 2551 from `ctx.threadId`, compared with `compareThreadIds`). It is now also passed as `after` to `listShipJudgmentReplyThreads`, whose `ShipJudgmentClarifications.replyThreads` pages a different set ordered by `(length(thread_id), thread_id)` and silently wraps back to page 1 when the cursor yields nothing. Line 2496 adds a second, conflicting writer (`if (tasks.length === 0 && historical.nextCursor)`), and `nextCursor` is `rows.at(-1)?.threadId` from the raw pre-filter rows rather than the returned `threads`.

Failure scenario: with more than 25 threads carrying delivered clarifications, the window handed to the poller jumps according to an unrelated rotation, so some clarification threads are revisited every tick while others are never selected — founder explanations in the unvisited threads are only picked up if the run happens to still be non-terminal. Note also that `replyThreads` calls `discordId.parse(after)` and throws on a non-snowflake cursor, which the try/catch at line 2318 swallows, so the degradation is silent. A dedicated cursor advanced from the returned page would make the rotation well-defined.

## LOW: clarification-reply-swallowed

packages/teamlead/src/bridge/founder-reply-deliverer.ts:643 — A founder reply to a clarification message is consumed entirely and never reaches the Lead

Unchanged at this head. When `observeShipJudgmentReply` returns `handled`, `processFounderMessage` returns `{ ok: true }` before any classification, so the message never reaches `deliverAmbiguousToLead`. If the founder answers the divergence question and appends an unrelated instruction in the same message ('...顺便把 X 回滚'), the whole message is recorded only as `reply_text` in the immutable clarification ledger and the Lead never sees it; the founder's only feedback is the static ack. Mitigated because `renderLearningMessage` tells the founder 回复此条仅记录解释, and approval is unaffected (the ship path requires a reply matching the card binding, which `replyTarget` can never match). Still worth considering forwarding the message to the Lead in addition to recording it.

