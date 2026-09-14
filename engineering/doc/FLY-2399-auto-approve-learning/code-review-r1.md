# FLY-2399 自动审批学习 — Code review R1
Issue: FLY-2399 (https://linear.app/geoforge3d/issue/FLY-2399)
日期: 2026-09-11
基于: implementation.md

reviewVerdict: APPROVED; reviewerVerdict: APPROVED

Reviewed HEAD: `beaed3e6a5c49dc49291b4c805296fe957a712da`; request `28affe11-9424-468c-8d2f-64b9ae9c31a8`. All advisories retained without implementation changes per Lead.

## MEDIUM: off-mode-observe-creates-new-ack-message

packages/teamlead/src/ship-judgment/clarifications.ts:164 — `observe()` has no mode gate, so `off` is not a full kill switch for new messages

`ShipJudgmentClarifications` takes `readMode` but only `sweep()` (line 85) and `ensure()` (line 118) consult it; `observe()` does not, and neither does `createShipJudgmentReplyObserver` (bridge/ship-judgment-routes.ts:55). With the flag at `off`, a founder reply to a clarification message posted earlier during dry_run still performs the authenticated Discord GET, inserts a new `ship_judgment_clarification` revision AND a new `purpose='ack'` delivery row (clarifications.ts:273-299). `LearningDelivery.work()` returns ack rows in any mode (learning-delivery.ts:161 `AND (purpose='ack' OR state IN ('posting','uncertain') OR ?='dry_run')`), `claim()` gates only clarification posts (learning-delivery.ts:203), and the bridge `canPost` explicitly allows ack in any mode (bridge/ship-judgment-runtime.ts:177) — so the Bridge POSTs a brand-new Discord message while the flag is `off`. Flushing an *already pending* ack in `off` is documented and tested (implementation.md:62 「off 只保留 ack 和未知 POST 恢复」); *creating a new one* is not covered by any test and reads against plan.md §2 「`off`不启动新意见/新澄清」 and U10 「零新消息」. Secondarily, `observeShipJudgmentReply` returning "handled" (founder-reply-deliverer.ts:644) also suppresses `deliverAmbiguousToLead` in `off`, so the Lead never sees that founder message. Either add the mode gate or record the deviation explicitly in the plan.

## MEDIUM: stale-db-handle-after-corruption-recovery

packages/teamlead/src/bridge/ship-judgment-history-runtime.ts:24 — History and judgment runtimes capture `db.raw` once; `recoverFromCorruption()` closes that handle

`createShipJudgmentHistoryRuntime` captures `deps.store.getShipJudgmentHistoryState()` and `getShipJudgmentHistory()` at construction (lines 24-25), and `ShipJudgmentRuntime`'s constructor captures `getShipJudgmentInputs()` (runtime.ts:38) and `getShipJudgmentJobs()` (runtime.ts:50). Each getter returns an object holding `this.db.raw` at that instant (StateStore.ts:4837/4841/4861/4865). `StateStore.recoverFromCorruption()` swaps in a new handle and closes the old one (StateStore.ts:4074-4087), and it has live callers in bridge/gate-poller.ts and HeartbeatService.ts. After any corruption-recovery episode the captured handles are closed: `ShipJudgmentWorker.drain()`'s `jobs.recoverExpired()` and `ShipJudgmentHistoryRuntime.execute()`'s `state.claim()` throw `The database connection is not open` on every subsequent tick, each caught and reduced to a `console.warn` error code — the whole ship-judgment subsystem is silently dead until Bridge restart while the rest of the Bridge reports healthy. Fails closed (no bad approval), but the degradation is permanent and only visible in logs. Pass `() => this.db.raw` or re-fetch per tick, as `getEpicShipJudgmentHistory` (StateStore.ts:4828) already does.

## MEDIUM: learning-403-permanently-drops-ack

packages/teamlead/src/ship-judgment/learning-transport.ts:38 — A single transient Discord 403 permanently drops the founder-facing receipt

`writeLearningMessage` maps status 403/404 on the pre-flight channel GET (line 38) and on the POST (line 95) to `{kind:"unavailable", code:"discord_forbidden"}`. `sendLearningMessage` (learning-sender.ts:77) routes that to `LearningDelivery.unavailable()`, which sets `state='unavailable'`; `claim()` then returns `inactive` forever (learning-delivery.ts:190-191). There is no retry, no backoff and no alert. Failure scenario: a role-propagation blip or a momentarily-removed bot permission during the one attempt permanently suppresses the 「已记录，未改变批准」 receipt for an explanation that *was* durably recorded, leaving the founder with no signal that her reply landed — and, per the ack's own wording, no restatement that approval still requires the original card. Compare the 429 branch on the same function, which correctly returns a `retryAt`. Consider treating 403 as retryable-with-backoff (or terminal only after N attempts) and surfacing `unavailable` as an operator alert.

## MEDIUM: opinion-delivery-has-no-terminal-state

packages/teamlead/src/ship-judgment/delivery.ts:430 — Opinion delivery can retry forever on a permanent 4xx, appending one audit event per attempt

`ShipJudgmentDelivery.failed()` always returns the row to `'pending'`/`'uncertain'`; unlike `LearningDelivery` there is no `unavailable()` counterpart and no attempt ceiling. `attempt` is reset only by `confirm`/`emptyScan`/`confirmHistory`, never by `failed`, so the backoff pins at the 1-hour cap (delivery.ts:443-446). Failure scenario: the founder deletes the ship card; `message_reference: { fail_if_not_exists: true }` (discord-transport.ts:51) makes every POST a permanent 4xx → `{kind:"failed"}` → `'pending'` → retry. Because the audit `eventUid` embeds `claim.generation` (delivery.ts:466), each retry writes a *distinct* `ship_judgment_delivery_error` row into `workflow_run_event` — roughly 24 new rows/day per stuck card, with no alert, until the gate leaves `awaiting_review`. It also inflates `deliveryEvidence.failedAttempts` in the statistics report. Bounded by `listShipJudgmentScanQuestions`, so not unbounded across the fleet, but a stuck card is invisible.

## MEDIUM: outcome-observers-cursorless-3s-full-scan

packages/teamlead/src/ship-judgment/outcomes.ts:108 — `observeCancellations`/`observeVerdicts` run a cursorless full-history scan every 3 seconds

Both are invoked from `ShipJudgmentRuntime.modeTick()` on a `setInterval(..., 3_000)` (runtime.ts:75-99). `observeCancellations` (line 108) joins `session_events` × `workflow_run` — with `OR EXISTS (SELECT 1 FROM workflow_run_issue_alias ...)`, which defeats index use on the run join — × `workflow_gate_holder`, anti-joined against `ship_judgment_outcome`, over all history, on every tick; `observeVerdicts` (line 381) does the same over `workflow_founder_gate_verdict`. `ShipJudgmentClarifications.sweep()` (clarifications.ts:91-110) already uses a durable `learning_cursor` for exactly this reason, so the pattern exists in this same change set. As `session_events` grows, every Bridge tick pays an O(table) scan on the main event loop. `LIMIT 50` bounds the rows returned, not the scan.

## MEDIUM: resolve-lead-throws-when-flywheel-project-absent

packages/teamlead/src/bridge/ship-judgment-routes.ts:30 — Route helpers call `resolveLeadForIssue` unguarded while the two runtime factories guard it

`resolveLeadForIssue` throws `No project found for "flywheel"` when `projects` has no flywheel entry (ProjectConfig.ts:1250-1254). `createShipJudgmentBridgeRuntime` (bridge/ship-judgment-runtime.ts:44-47) and `createShipJudgmentHistoryRuntime` (bridge/ship-judgment-history-runtime.ts:17-22) both return `undefined` in that case, but `listShipJudgmentReplyThreads` (line 30) and `createShipJudgmentReplyObserver` (line 69) are wired unconditionally in plugin.ts and have no equivalent check. Failure scenario — `projects.json` loses its flywheel entry while the StateStore still holds flywheel `workflow_run` rows (the memory index records production `projects.json` bindings going null for all six projects): `listShipJudgmentReplyThreads` throws on every gate-poller tick, contained only by the `console.warn` at gate-poller.ts:2319; the observer's promise rejects for any reply anchored to a delivered clarification, so `processFounderMessage` throws, `founder-reply-deliverer.ts:526-532` records `process_exception`, and that founder message stops the whole thread scan until it dead-letters. Over HTTP it surfaces as a permanent `503 learning_reference_unavailable`, a transient-sounding code the CLI tells the operator to retry.

## MEDIUM: reference-route-reports-403-after-commit

packages/teamlead/src/bridge/ship-judgment-reference-route.ts:87 — Post-write authorization re-check returns 403 for work that already committed

By the time line 87's `if (!authorized())` runs, `observe()` has already committed the `ship_judgment_clarification` row and the pending `ack` delivery row (clarifications.ts:273-299). `authorized()` (lines 65-72) swallows *any* throw from `authorizeLeadWrite`, which opens `lead-lease.db` and reads `projects.json` — a lock contention or EMFILE is reported identically to a real authorization denial. Failure scenario: the founder's explanation is durably recorded and the ack posts to Discord, while `ship-judgment-ref.ts:113-116` prints `{"error":"bridge_http_403"}` and exits 1. Recoverable (a retry hits `existing` → 200) but the receipt is wrong. Related: a transient blip inside the `canonicalFounderId` wrapper at line 79 makes `observe()` see two different founder ids, yielding `ignored` → `422 reference_not_verified_explanation`, a permanent-sounding verdict for a transient condition. Also note `authorizeLeadWrite` runs up to 4× per HTTP request (lines 74, 79 twice, 87), each synchronously opening a SQLite store.

## MEDIUM: model-subprocess-settles-only-on-close

packages/teamlead/src/ship-judgment/subscription-process.ts:113 — Model subprocess promise resolves only on `close`; an orphan holding the pipes wedges the worker permanently

Resolution happens exclusively in `child.on("close", ...)` (line 113), and `stop()` only sends SIGTERM/SIGKILL to the direct pid — the child is not `detached`, so there is no process-group kill. `close` waits for all three stdio pipes to close. If the model binary leaves any subprocess holding the inherited stdout/stderr pipe, `close` never fires: the 120 s timer and the kill timer have both already run and nothing else can settle the promise. Consequence chain: the `finally { await rm(cwd, ...) }` never runs (temp dir leaks), and `await this.deps.evaluate(...)` in worker.ts:92 hangs inside `drain()`, so `this.active` (worker.ts:43-53) stays pending forever — every later `tick()` returns the same stuck promise and `stop()` (`await this.active`) hangs Bridge shutdown. The comment at line 22 shows waiting for `close` is deliberate, but there is no backstop timer that settles independently of it.

## MEDIUM: coverage-test-ref-substring-check

packages/teamlead/src/ship-judgment/evaluate.ts:160 — The "exact test name quoted in report" gate is a one-character substring check

`citation.quote.includes(useCase.test_ref)` is the only thing binding a claimed use-case result to a real test name. `test_ref` is validated only by `text = z.string().min(1).refine(len <= 2000)` (lines 10-13), and the model supplies both `test_ref` and `quote`; `quote` merely has to be a verbatim substring of a frozen `qa` source (validateCitation, contract.ts:152-158). So a model returning `test_ref: "a"` plus any QA quote containing the letter "a" satisfies `coverage: "pass"` for that use case. The prompt asks for the exact test name (subscription-evaluator.ts:22) but nothing enforces a plausible shape or minimum length. Not ship-blocking — the opinion is advisory-only in dry_run and cannot approve anything — but it weakens the coverage point that the whole design rests on, and the QA plan's negative cases should be able to kill it.

## MEDIUM: concurrent-shared-refresh-orphan-and-stopped-reuse

packages/teamlead/src/bridge/ship-judgment-runtime.ts:319 — Two concurrent `collect()` entries can orphan a `SharedProjectRefresh`; `stopSources` never clears it

`collect` is reached from both `ShipJudgmentScanner.tick()` and `ShipJudgmentWorker.prepare()`, which have independent single-flight guards and can run concurrently. Line 320's `await refresh?.stop()` is a yield point (it yields even when `refresh` is `undefined`), so both entries can observe `!refresh`, both yield, and both construct a `SharedProjectRefresh`; the second assignment orphans the first. `stopSources` (line 300) stops only whatever `refresh` currently points at, so the orphan's in-flight collection — including its 60 s abort controller and in-flight GitHub fetches — is never aborted during Bridge shutdown. Separately, `stopSources` never sets `refresh = undefined`, so a `stop()` → `start()` cycle reuses a stopped instance and every refresh returns `refresh_stopped` (project-refresh.ts:62-66), permanently forcing `mechanical: undetermined`.

## MEDIUM: unbounded-immutable-ship-judgment-ledger

scripts/lib/fly-2006-retention-registry.mjs:40 — Eight new tables are both never-swept and delete-blocked, with no row-count ceiling

All eight tables are classified `protectedCurrentOrReference` (never swept), and StateStore.ts:5091-5097 additionally installs `BEFORE DELETE ... RAISE(ABORT)` triggers on five of them, so even a future manual policy cannot delete rows without dropping triggers first. Per-row caps exist (`sources_json` ≤ 98304, `result_json` ≤ 65536, `latest_candidate_json` ≤ 98304) but nothing caps row count: up to 3 inputs + N opinions + N outcomes per founder gate, forever, with each input row carrying up to ~96 KiB of frozen source text. plan.md:120 records the deliberate choice not to put these in the 14-day deletion group, so this is a known decision — but the combination of never-swept + delete-blocked means `teamlead.db` on the root volume grows monotonically with ship-gate volume with no reclaim path at all. The memory index already records a prior incident of a production DB copy filling the root volume. Worth an explicit accepted-risk note plus a size alarm in the PR rather than leaving it implicit. Related: `ship_judgment_clarification(supersedes)` has no index, and history-query.ts:118 runs a `NOT EXISTS ... WHERE reply.supersedes=?` per outer row, so the history build degrades toward O(n²) as the never-swept table grows.

## MEDIUM: github-token-forks-gh-per-request

packages/teamlead/src/bridge/ship-judgment-runtime.ts:376 — `readShipJudgmentGithubToken` forks `gh auth token` once per GitHub API request

`github-api.ts:137` awaits `this.token(signal)` inside every `get()`. With `GH_TOKEN`/`GITHUB_TOKEN` unset, each GitHub call becomes an `execFile("gh", ["auth","token",...])` with a 20 s timeout in the Bridge process. One refresh round walks `main` per repo, then open-PR pages, then per-PR file pages — dozens of subprocess spawns per collect, with no memoization or TTL cache. Combined with the 60 s whole-collection budget in `SharedProjectRefresh.collect` and the 20 s per-request budget, this makes `collection_timeout` likely on a cold cache in production. Minor related nit: line 380 accepts `GH_TOKEN="   "` as a token (no trim/emptiness check), producing an opaque GitHub 401 instead of falling through to `gh auth token`.

## LOW: marker-escaping-scan-mismatch

packages/teamlead/src/ship-judgment/render.ts:50 — Sender escapes the correlation marker; the scanner matches the raw marker — untested round-trip

render.ts:50 emits ``​`${text(view.marker, 220)} opinion:${text(view.opinionId, 200)}`​`` where `text()` (lines 4-17) escapes ``[\\`*_{}[\]()~|]``, `@<>`, control characters, and truncates with `…`. discord-scan.ts:96 searches for the **raw, unescaped** ``const prefix = `\`${input.marker} ${kind}:`​``. Today this round-trips because the marker is `ship-judgment:workflow-gate:<sha256hex>` and the opinion id is a `randomUUID()` — none of those characters are escaped — but nothing asserts it: sender.test.ts stubs `scan`, and discord-scan.test.ts hand-builds the message content. If a question id ever contains `_`, `(`, `[`, `|`, `~`, `*` or a backtick, scan-based crash recovery stops recognizing the bot's own message, `emptyScan` confirms "none" after two stable frontiers, and the sender posts a **duplicate** opinion message — exactly the double-POST the design forbids. A render→scan round-trip test is the cheap fix.

## LOW: message-budget-checked-before-automation-prefix

packages/teamlead/src/ship-judgment/render.ts:52 — The 2000-char Discord budget is checked against two different strings

render.ts:52 throws on `content.length > 2000` for the *unmarked* text, but discord-transport.ts:21-23 checks the same limit against `markAutomatedDiscordText(input.content)`, which is 7 UTF-16 units longer (`🤖[自动] `, bridge/automated-message.ts:1). A render passing at 1994-2000 characters becomes a permanent `{kind:"failed"}` send with no useful diagnosis. Not reachable with the current field caps (a realistic render is ~1.5 KB), but the two budgets should measure the same string.

## LOW: merge-base-all-rejects-multi-base-history

packages/teamlead/src/ship-judgment/git-input.ts:86 — `merge-base --all` output is parsed with a single-SHA regex

`git merge-base --all` prints one SHA per line; `shaSchema` is `/^[0-9a-f]{40}$/` and JS `$` is not multiline, so a criss-cross history with 2+ merge bases makes the parse throw a raw `ZodError`, which prepare-git.ts:168 converts into `git_preparation_failed` for the whole target. The result is fail-closed (`mechanical: undetermined`) but silent and untested — git-input.test.ts only covers the single-base case. If "ambiguous history ⇒ refuse" is the intent, it should be an explicit error code rather than a schema parse failure; if not, `--all` should be dropped.

## LOW: epic-budget-tests-have-no-timeout-headroom

packages/teamlead/src/epic-page/__tests__/founder-budget.test.ts:21 — The new/modified epic-page budget tests are the slowest in the package with no per-test timeout

Honest scope note first: on an idle machine the whole `src/ship-judgment src/epic-page` selection is green — 76 files / 584 tests in 17 s — so this is NOT a broken build. But `materializeEpicPage` now renders through `hostedBudgetHtml(renderEpicPageBudgetBundle(...))` (materialize.ts:146), and `renderEpicPageBudgetBundle` (optional-budget.ts:19-60) itself runs a binary search over full page renders nested inside `applyAttentionBudget`'s own ~11-render binary search — roughly an order of magnitude more full-page renders per materialization than the previous single `renderEpicPageHtml`. Under CPU contention I measured `founder-budget.test.ts > measures the combined child cap...` at 6.8 s and `materialize.test.ts > budgets the hosted representation...` at 10.3 s, both exceeding the package's 5000 ms default `testTimeout` (packages/teamlead/vitest.config.ts sets none); idle they are 1.2 s and 1.8 s. CI runs `pnpm --filter flywheel-teamlead test:run --shard=N/3` with parallel forks on a 4-core runner, so these are plausible flake candidates. An explicit per-test timeout would remove the risk cheaply.

## LOW: replay-script-leaves-empty-output-blocking-retry

scripts/replay-ship-judgment.mjs:83 — A failed replay leaves a 0-byte `wx` artifact that blocks re-running the same case

The output handle is opened `wx`/0600 before the model call (deliberate, per the comment at line 82), but on any failure the `finally` only closes it and never unlinks. Every re-run with the same `--output` then dies with EEXIST until the operator manually removes the empty file. The qa-handoff doc does say "输入错误可能留下空的已预留报告，视为失败保留", so the retention is intentional — but the failure message should tell the operator to remove it, or the CLI should require an explicit `--force`.

