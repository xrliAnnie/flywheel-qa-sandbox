# FLY-2390 判据 c 聚合 — 代码审查 R2
Issue: FLY-2390 (https://linear.app/geoforge3d/issue/FLY-2390)
日期: 2026-09-10
基于: implementation.md

Reviewed HEAD: 820fc9af29700da1d9a235f8047b80b2c31a737f

Effective verdict: APPROVED; request f87d4651-eda2-41f3-8043-6a4b006f514f. All findings are non-blocking; forwarded to Lead.

## MEDIUM retention-registry-depends-on-gitignored-dist

The R1 HIGH was fixed the right way at the package end — `evaluate.ts` now defines `READINESS_WINDOW_MS = 14*24*60*60*1_000` locally and the built `dist/bridge/release-readiness/evaluate.js` has zero runtime imports (verified: grep finds no `../../../../../scripts/` specifier anywhere in `packages/teamlead/dist`, and the new `release-readiness-packaged.test.ts` loads it from a synthetic `node_modules/flywheel-teamlead/...` tree). But the replacement — `export { READINESS_WINDOW_MS as RETENTION_MS } from "../../packages/teamlead/dist/bridge/release-readiness/evaluate.js"` — points `scripts/` at a **gitignored** artifact (`git check-ignore` confirms `.gitignore:16 dist/`). Two consequences. (1) Integrity seal: `engineSourceDigest()` (fly-2006-retention-engine.mjs:394-403) hashes exactly `[engine, fly-2006-retention-registry.mjs, cohort, evidence, mailbox-archive]`, and `registrySha256: sha256File(registryPath)` (line 418) hashes the registry file. `RETENTION_MS` is what computes `cutoff14 = startedAt - RETENTION_MS` (line 1066-1068) — the value that decides which rows get deleted — and it now lives in a file no digest covers. The `engine_digest_mismatch` fence at line 1600, which exists precisely to stop `apply` when the engine changed between inventory and apply, can no longer see a horizon change; the FLY-2139 activation receipt has the same hole. (2) Build-order coupling: `scripts/flywheel-log-janitor.sh:86` and `scripts/db-maintenance.sh:13` invoke `fly-1998-database-retention-sweep.mjs` → engine → registry, so those standalone scripts now hard-require a built, current `packages/teamlead/dist`. CI is safe (every job runs `pnpm build` before tests, and all four retention suites pass here: 57/57), and teamlead's build script never `rm -rf dist`, so the reachable window is small — which is why this is MEDIUM, not HIGH. Fix: put the constant in a source-level module both sides can read (e.g. `flywheel-release-contract`, already a teamlead dependency) and add it to the `engineSourceDigest()` file list, so the seal covers the value again.

## MEDIUM transient-outbox-presence-latches-episode

The R1 HIGH is genuinely fixed: `run()` now takes a second `scanReadinessOutbox(outboxRoot)` after ingestion and feeds the heartbeat from `remaining` (lines 117, 129-130). I re-ran my R1 probe at this head with the real `ReleaseReadinessRider` and one `publications/<day>.json`: the ingesting tick now records `outboxPending: 0, outboxInvalid: 0, ingestOk: true`, `isReadinessHeartbeatHealthy` returns true, and `landed/<day>.json` exists — previously it was `outboxPending: 1` and unhealthy. What remains is a narrower race with the same latching consequence. The ingestion list comes from snapshot A (line 74) but the heartbeat counts come from snapshot B (line 117), and between them sits `await projectShellObservations(...)` (line 84), which spawns a sqlite3 subprocess. Any file created in that gap — in practice a `lead-alert.sh` `*.intent.json`, which lives roughly 100-300 ms between the preflight write and the post-claim `mv` to `landed/` — is counted as pending at B despite nothing being stuck, giving one unhealthy heartbeat. Because `evaluateReadiness` (evaluate.ts:213-220) emits `source_unhealthy` when ANY heartbeat in `[episodeFrom, now]` is unhealthy, one such sample latches the episode at `unknown` until the 14-day truncation rolls it out. Rough rate: ~0.3% per shell alert, so ~30% over an episode with 100 alerts, ~80% with 500. The cheap fix is already computed and currently unused: `scanReadinessOutbox` returns `oldestPendingAt` — gate on pending-and-stale (e.g. older than one tick interval) rather than on bare presence.

## MEDIUM claims-observation-table-missing-until-first-shell-alert

Still present at this head: only `lead-alert.sh` creates `alert_version_observations`, and the rider reads it with `.bail on` + `PRAGMA query_only=ON`, so before the first shell alert `sqliteRunWithStdin` rejects and `claims_db_ok=0` on every tick; combined with the ANY-unhealthy-tick rule this keeps the first deployment episode at `unknown`. See code-review-r1.md for the full argument and the verified sqlite3 reproduction. Not re-argued.

## MEDIUM minute-timeline-blows-512kib-cap

Still present at this head: a 14-day window with empty evidence renders 485 504 bytes against the 524 288 cap (measured against the real `renderReadinessReport`), leaving ~38 KB for every evidence table; a sparse window with real evidence throws RangeError → 413 → the daily report never publishes. See code-review-r1.md. Not re-argued.

## MEDIUM verdict-append-on-every-read-unbounded

Still present at this head: `GET /verdict` and `POST /report/render` both append to `release_readiness_verdicts`, which is classified `protected` and never pruned, so a polling consumer grows the in-memory sql.js StateStore without bound. See code-review-r1.md. Not re-argued.

## MEDIUM rider-loads-full-evidence-to-read-publications

Still present at this head: the rider calls `getReleaseReadinessEvidence(commit, now-14d, now)` every 60s and keeps only `.publications`, materializing ~20 000 heartbeat rows plus all events/gaps/bugs each tick. See code-review-r1.md. Not re-argued.

## MEDIUM no-publication-does-not-block-green

Still present at this head: with zero publications in the window neither `founder_signal_unobserved` nor `founder_thumbs_down` can fire, so the default unconfigured state (`FLYWHEEL_READINESS_REPORT_CHANNEL` unset ⇒ the report script exits 0) silently removes the founder gate rather than failing closed. See code-review-r1.md. Not re-argued.

## MEDIUM shell-observation-rejected-when-doc-version-unreadable

Still present at this head: a shell observation with a real 40-hex commit but NULL `base_version` (unreadable `doc/VERSION`, which packaged trees never carry even though `lead-alert.sh` ships in PO_SCRIPT_FILES) is counted as a rejected row and projected with `sourceCommit: null`, latching the heartbeat unhealthy. See code-review-r1.md. Not re-argued.

## LOW cursor-page-parse-is-all-or-nothing

Still present at this head: `z.array(cursorRow).parse(...)` validates the whole page before the per-row `rejectedRows` leniency can run, so one bad row throws, sets `claimsDbOk=false`, and wedges the cursor permanently. See code-review-r1.md. Not re-argued.

## LOW post-create-failure-reports-502-after-linear-success

Still present at this head: a throw from the post-create bookkeeping (`created bug identifier missing`, or a UNIQUE collision inside `resolveReleaseBugIntent`) is reported to the caller as `502 Linear API error` after the issue already exists in Linear. See code-review-r1.md. Not re-argued.

## LOW bug-report-row-has-no-resolution-receipt

Still present at this head: `recordReleaseBugReport` writes a finalized row with no receipt, so a later resolve on that intent throws `release bug resolution receipt missing` and surfaces as a 500. See code-review-r1.md. Not re-argued.

