# FLY-2886 related verification scope

Discovery merge-base: `ef47e9a05cd4b6e625f58c0dc0abe7ff41a26d6d` (`git merge-base origin/main HEAD`). Discovery HEAD: `b9008dfe357b85720f628069b4c4aae931e391dc`; completion HEAD: `b9008dfe357b85720f628069b4c4aae931e391dc`. Working-tree edits and untracked sources are included. Generated 2026-09-26T07:35:16.672469+00:00.

Scope: 91 production TypeScript files; 142 retained executable test paths (12 shell, 16 Node); 36 excluded test matches. This is an inventory, not execution evidence. No test suite was run to create it.

## Exact discovery commands

```sh
git merge-base origin/main HEAD
git rev-parse HEAD
git diff --name-only -z "$(git merge-base origin/main HEAD)" --
git ls-files --others --exclude-standard -z
python3 engineering/doc/FLY-2886-voice-brain-agent/evidence/related-test-discover.py
node scripts/fly-2006-retention-consumer-gate.mjs > /tmp/fly2886-retention-inventory-check.json
python3 engineering/doc/FLY-2886-voice-brain-agent/evidence/related-test-finalize.py
```

For every existing changed production `.ts`, `.tsx`, `.mts`, or `.cts` file, the script contributes three fixed-string queries: repository-relative full path, filename, and parent directory. It runs their union in one batched `git grep -lF -z --untracked --exclude-standard -e QUERY ... -- .` call; the first pass also ran each query individually. This avoids rescanning the large tree 3N times without broadening matches. Generated inventory artifacts are excluded using the explicit pathspecs stored in the exact `batchedCommands` argv in the JSON. Tests, test helpers/fixtures under test directories, and deleted files are excluded from the production-input set. The exact production-input SHA-256, every query and its batch command argv, every matched path and disposition, and test matching lines are retained in `related-test-scope.json`.

Changed tests are independently retained even when import specifiers use `.js` and literal `.ts` grep cannot discover them. Direct source/import consumers, changed tests, and repository guards that actually scan changed source roots are retained. Shared directory names alone do not retain unrelated tests. Excluded matches below are comment-only, synthetic fixtures, suffix collisions, or specific unchanged siblings; non-test matches remain enumerated in JSON. Import-graph selection is still necessary: literal grep alone does not prove the complete transitive test graph.

## Snapshot stability

Production files edited during scan: `packages/teamlead/src/bridge/lead-capability-target-lock.ts`, `packages/teamlead/src/bridge/plugin.ts`, `packages/teamlead/src/bridge/voice-target-reconcile.ts`, `packages/voice-codex/src/session.ts`. Newly added production paths after scan input: none. A later production path/content change requires rechecking this inventory; this snapshot is not exact-head CI evidence.

## Package manifests and registration

- `packages/teamlead/package.json` adds the `./voice-capability` export to `dist/voice-capability.js` / `.d.ts`. Existing `files: [dist, ...]`, `PO_PACKAGES`, and `node_modules/flywheel-teamlead/dist/*` payload allowlist cover the new modules. Voice-core and voice-codex already participate in PO_PACKAGES and have matching dist globs. No new runtime asset root is introduced.
- Read-only `git diff --unified=0 MERGE_BASE -- packages/**/*.ts packages/*/package.json` added-line scan for `git\s+clone|xrliannie/|package-onboard` found no candidate repository-access lines. Gate 4 matches normalized exact lines, so compiled payload checks remain required; this source scan is not a payload gate pass.
- Retain `bash scripts/__tests__/package-onboard.test.sh`, `bash scripts/__tests__/gate4-allowlist-masking.test.sh`, and `bash scripts/__tests__/package-onboard-smoke.test.sh`. They are listed, not executed here. Package assembly/gates must use fresh affected dist output.
- Two new `scripts/lib/fly-2006-retention-tables/teamlead/capability_target_lock{_waiters,s}.json` fragments use `protectedCurrentOrReference`. The local retention fragment guide explicitly requires no shared manifest/test edit for protected tables. Both fragments have the exact three-field schema.
- Read-only `node scripts/fly-2006-retention-consumer-gate.mjs` completed exit 0: `ok: true`, 101 consumers, zero errors. Its full result is in the machine JSON. Retention registry/consumer regression tests remain retained.
- No new or modified `scripts/__tests__/*.test.sh` files exist in the merge-base-to-working-tree diff. Newly discovered shell consumers are existing tests omitted by the old TypeScript-only inventory; list below.
- No missing package payload/retention registration was identified by these bounded read-only checks. Runtime capability catalog policy is covered by its changed manifest tests and remains the implementation owner’s responsibility.

## Approved exclusion

Always exclude `**/tmux-viewer.macos.test.ts`, as explicitly approved in `plan.md` section 9 (line 322). This exception applies to subsequent related/import-graph selection even if literal grep does not match that test.

## Excluded executable-test matches

| Path | Reason |
| --- | --- |
| `packages/agent-team-transport/src/__tests__/grep-gate.test.ts` | cli.ts is only a suffix of unchanged agent-team-transport-cli.ts. |
| `packages/agent-team-transport/src/claude/__tests__/ClaudeCodeAdapter.test.ts` | plugin.ts appears only in a historical comment; no changed module import. |
| `packages/claude-runner/test/TmuxAdapter.test.ts` | plugin.ts appears in behavior-mirroring comments/test names; no changed module import. |
| `packages/claude-runner/test/kill-path-inventory.test.ts` | Parent-directory matches enumerate unchanged reapers/tmux lookup; no changed production file is read. |
| `packages/config/src/__tests__/flag-truth.test.ts` | Parent-directory hit is a comment pointing to unrelated delivery-secret test. |
| `packages/edge-worker/src/__tests__/cipher-dimensions.test.ts` | session.ts refers to unrelated auth/session.ts fixture. |
| `packages/edge-worker/src/__tests__/resolveBridgeUrl.test.ts` | config.ts refers to unchanged teamlead config defaults, not changed voice-codex config.ts. |
| `packages/teamlead/scripts/test-fly26-rules-split.sh` | plugin.ts appears only in route-prefix comment, not as changed-source input. |
| `packages/teamlead/src/__tests__/account-selfheal-bytecompat.test.ts` | plugin.ts occurs only in explanatory account-selfheal comments; no changed-source input. |
| `packages/teamlead/src/__tests__/bridge-child-process-census.test.ts` | Reads unchanged child-process-census.json; common directory alone is not a changed-file consumer. |
| `packages/teamlead/src/__tests__/fly2121-legacy-name-guard.test.ts` | Parent-directory strings construct synthetic rogue/compatibility fixtures, not changed production sources. |
| `packages/teamlead/src/__tests__/fly247-bash-suites.test.ts` | Only parent-directory match is a repository-root navigation comment. |
| `packages/teamlead/src/__tests__/fly574-bash-suites.test.ts` | Only parent-directory match is a repository-root navigation comment. |
| `packages/teamlead/src/__tests__/pane-live-region-fly927-echo.test.ts` | Only parent-directory hit is a synthetic pane-text line naming unchanged LeadAlertNotifier.ts. |
| `packages/teamlead/src/__tests__/quota-ignition-red-lines.test.ts` | plugin.ts occurs only in comments describing copied composition; test imports unchanged quota modules. |
| `packages/teamlead/src/__tests__/report-hosting-secrets.test.ts` | Directory hits import unchanged report-hosting-secrets.ts/vercel-hosting-api.ts. |
| `packages/teamlead/src/__tests__/required-wall-clock-thresholds.test.ts` | Directory hits list unrelated unchanged ship-judgment test thresholds. |
| `packages/teamlead/src/bridge/__tests__/lead-patrol-config.test.ts` | config.ts is a suffix in unchanged lead-patrol-config.ts. |
| `packages/teamlead/src/xiaohongshu-write/__tests__/offline-configuration.test.ts` | config.ts is a suffix in unchanged scripts/xhs/assemble-config.ts. |
| `packages/voice-bridge/src/__tests__/assistant-wiring.test.ts` | cli.ts refers to voice-bridge CLI in a comment, not changed voice-codex CLI. |
| `packages/voice-bridge/src/__tests__/eleven-config.test.ts` | config.ts refers to voice-bridge assistant config, not changed voice-codex config. |
| `scripts/__tests__/auto-narrow-rollback-precheck.test.sh` | StateStore.ts is a synthetic temporary repository fixture; this test does not read current StateStore.ts. |
| `scripts/__tests__/ci-structure.test.sh` | Directory hits point to unchanged review-governance-docs/fly1135-doc-sentinel tests. |
| `scripts/__tests__/fly-1867-playwright-orphan-census.test.sh` | Directory hits create synthetic source.ts fixtures for dist freshness, not changed files. |
| `scripts/__tests__/fly-2026-browser-idle-census.test.sh` | Directory hits name unchanged browser-idle/census/reaper sources. |
| `scripts/__tests__/flywheel-log-janitor.test.sh` | Directory hits read unchanged workflow-ledger-states.ts/operational-terminal-status.ts. |
| `scripts/__tests__/flywheel-log-rotate.test.sh` | Directory hits enumerate unchanged log rotation entrypoints and BridgeEventLoopGuard.ts. |
| `scripts/__tests__/lead-alert-strict-delivery.test.sh` | Directory hit reads unchanged LeadAlertNotifier.ts. |
| `scripts/__tests__/legacy-swap-broadcast-retirement.test.sh` | Directory hits create synthetic fleet-sensors.ts temporary git fixtures. |
| `scripts/__tests__/package-gate.test.mjs` | Filename config.ts occurs only as suffix in vitest.config.ts; unrelated package-gate config test. |
| `scripts/__tests__/r4-window.test.sh` | Filename manifest.ts is only a substring of unrelated manifest.tsv. |
| `scripts/__tests__/rollback-r4.test.sh` | Filename manifest.ts is only a substring of unrelated manifest.tsv. |
| `scripts/__tests__/teamlead-shards.test.mjs` | Filename config.ts occurs only as suffix in unchanged vitest.config.ts. |
| `scripts/__tests__/test-deploy-generalized.test.sh` | Directory hit imports unchanged bridge-exit-marker.ts. |
| `scripts/test-deploy.sh` | Operational deployment/restart helper, not a hermetic test harness; outside authorized local verification. |
| `scripts/test-restart-services.sh` | Operational service restart helper, not a hermetic test harness; outside authorized local verification. |

## Retained shell and Node checks

Run only the explicitly retained checks when authorized; no aggregate/full-suite command is prescribed.

```sh
bash scripts/__tests__/autocompact-override-retirement.test.sh
bash scripts/__tests__/codex-home-reconcile-cadence.test.sh
node --test scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs
node --test scripts/__tests__/fly1645-receipt-residue-gate.test.mjs
bash scripts/__tests__/fly1674-residue.test.sh
bash scripts/__tests__/fly1680-v1-extinction.test.sh
bash scripts/__tests__/fly2102-flag-freeze.test.sh
bash scripts/__tests__/fly2403-design-model-comparison.test.sh
bash scripts/__tests__/flywheel-voice-wrapper.test.sh
bash scripts/__tests__/gate4-allowlist-masking.test.sh
bash scripts/__tests__/package-onboard-smoke.test.sh
bash scripts/__tests__/package-onboard.test.sh
node --test scripts/__tests__/qa-codex-lead-parity.test.mjs
node --test scripts/__tests__/qa-fly-2456-adopt.test.mjs
node --test scripts/__tests__/qa-fly-2456-cli.test.mjs
node --test scripts/__tests__/qa-fly-2456-fleet.test.mjs
node --test scripts/__tests__/qa-fly-2456-observe.test.mjs
node --test scripts/__tests__/qa-fly-2456-park-adopt.test.mjs
node --test scripts/__tests__/qa-fly-2456-qa-identity.test.mjs
node --test scripts/__tests__/qa-fly-2456-rework-adopt.test.mjs
node --test scripts/__tests__/qa-fly-2456-runner-windows.test.mjs
node --test scripts/__tests__/qa-fly-2456-scan.test.mjs
node --test scripts/__tests__/qa-fly-2456-selection.test.mjs
node --test scripts/__tests__/qa-fly-2456-shape.test.mjs
node --test scripts/__tests__/qa-fly-2456-terminate-adopt.test.mjs
bash scripts/__tests__/runtime-role-auto-qa-retirement.test.sh
node --test scripts/__tests__/ship-judgment-timer.test.mjs
bash scripts/__tests__/v2-retirement-cleanup.test.sh
```

## Per-package production inputs and retained test paths

Each package also has `changed-production-PACKAGE.txt` and `retained-PACKAGE.txt` machine lists. Use package-relative paths for explicit Vitest invocations. Teamlead Bridge checks require isolated `FLYWHEEL_CODEX_HOMES_ROOT=/tmp/fly2886-related-homes`; its test setup additionally creates per-test temporary roots. Do not execute one huge related command from this document. Divide the retained paths by the bounded validation batches owned by the root agent.

### packages/config

Changed production TypeScript:

```text
```

Retained tests:

```text
packages/config/src/__tests__/drift-scan.test.ts
packages/config/src/__tests__/feature-flags-drift.test.ts
packages/config/src/__tests__/feature-flags-registry.test.ts
packages/config/src/__tests__/feature-flags-store-policy.test.ts
packages/config/src/__tests__/fly1808-wave-a.test.ts
packages/config/src/__tests__/fly1981-final-ledgers.test.ts
```

### packages/teamlead

Changed production TypeScript:

```text
packages/teamlead/src/ProjectConfig.ts
packages/teamlead/src/StateStore.ts
packages/teamlead/src/bridge/bootstrap-format-legacy.ts
packages/teamlead/src/bridge/bootstrap-format.ts
packages/teamlead/src/bridge/bootstrap-generator.ts
packages/teamlead/src/bridge/bootstrap-route.ts
packages/teamlead/src/bridge/commdb-lead-runtime.ts
packages/teamlead/src/bridge/lead-capability-discord.ts
packages/teamlead/src/bridge/lead-capability-read.ts
packages/teamlead/src/bridge/lead-capability-report.ts
packages/teamlead/src/bridge/lead-capability-runners.ts
packages/teamlead/src/bridge/lead-capability-scope.ts
packages/teamlead/src/bridge/lead-capability-target-lock.ts
packages/teamlead/src/bridge/lead-capability-voice.ts
packages/teamlead/src/bridge/lead-runtime.ts
packages/teamlead/src/bridge/mailbox-lead-runtime.ts
packages/teamlead/src/bridge/plugin.ts
packages/teamlead/src/bridge/voice-capability-events.ts
packages/teamlead/src/bridge/voice-session-context.ts
packages/teamlead/src/bridge/voice-session-poller.ts
packages/teamlead/src/bridge/voice-session-routes.ts
packages/teamlead/src/bridge/voice-session-services.ts
packages/teamlead/src/bridge/voice-target-reconcile.ts
packages/teamlead/src/lead-backends/codex/buildCodexLeadMcpArgv.ts
packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts
packages/teamlead/src/lead-backends/codex/lead-capability-proxy.ts
packages/teamlead/src/lead-capabilities/authority.ts
packages/teamlead/src/lead-capabilities/automatic-outbound.ts
packages/teamlead/src/lead-capabilities/broker.ts
packages/teamlead/src/lead-capabilities/browser-config.ts
packages/teamlead/src/lead-capabilities/browser-provider.ts
packages/teamlead/src/lead-capabilities/browser-worker.ts
packages/teamlead/src/lead-capabilities/catalog.ts
packages/teamlead/src/lead-capabilities/context7-provider.ts
packages/teamlead/src/lead-capabilities/gbrain-provider.ts
packages/teamlead/src/lead-capabilities/handlers/bridge-attachments.ts
packages/teamlead/src/lead-capabilities/handlers/bridge-discord.ts
packages/teamlead/src/lead-capabilities/handlers/bridge-read.ts
packages/teamlead/src/lead-capabilities/handlers/bridge-terminal-evidence.ts
packages/teamlead/src/lead-capabilities/handlers/bridge-voice.ts
packages/teamlead/src/lead-capabilities/handlers/browser.ts
packages/teamlead/src/lead-capabilities/handlers/context7.ts
packages/teamlead/src/lead-capabilities/handlers/github-provider.ts
packages/teamlead/src/lead-capabilities/handlers/github.ts
packages/teamlead/src/lead-capabilities/handlers/linear-provider.ts
packages/teamlead/src/lead-capabilities/handlers/linear.ts
packages/teamlead/src/lead-capabilities/handlers/report-deliver.ts
packages/teamlead/src/lead-capabilities/handlers/report-publish.ts
packages/teamlead/src/lead-capabilities/handlers/report-verify.ts
packages/teamlead/src/lead-capabilities/handlers/upstream-read.ts
packages/teamlead/src/lead-capabilities/handlers/upstream-write-denials.ts
packages/teamlead/src/lead-capabilities/handlers/xiaohongshu-authority-read.ts
packages/teamlead/src/lead-capabilities/handlers/xiaohongshu-write-management.ts
packages/teamlead/src/lead-capabilities/handlers/xiaohongshu-write.ts
packages/teamlead/src/lead-capabilities/manifest.ts
packages/teamlead/src/lead-capabilities/native-skill-baseline.ts
packages/teamlead/src/lead-capabilities/patrol-github-facts.ts
packages/teamlead/src/lead-capabilities/receipts.ts
packages/teamlead/src/lead-capabilities/runtime-authority.ts
packages/teamlead/src/lead-capabilities/runtime-factory.ts
packages/teamlead/src/lead-capabilities/runtime-parent.ts
packages/teamlead/src/lead-capabilities/target-lock-client.ts
packages/teamlead/src/lead-capabilities/voice-action-ledger.ts
packages/teamlead/src/lead-capabilities/voice-capability-parent.ts
packages/teamlead/src/lead-capabilities/voice-capability-session.ts
packages/teamlead/src/lead-capabilities/voice-resolve.ts
packages/teamlead/src/lead-capabilities/xiaohongshu-provider.ts
packages/teamlead/src/voice-capability.ts
```

Retained tests:

```text
packages/teamlead/src/__tests__/ProjectConfig.test.ts
packages/teamlead/src/__tests__/StateStore.fly2341-terminal-archive.test.ts
packages/teamlead/src/__tests__/StateStore.land-carryover.test.ts
packages/teamlead/src/__tests__/StateStore.voice-session-schema.test.ts
packages/teamlead/src/__tests__/StateStore.voice-session.test.ts
packages/teamlead/src/__tests__/StateStore.voice-target-lock.test.ts
packages/teamlead/src/__tests__/StateStore.workflow-gate-card-lifecycle.test.ts
packages/teamlead/src/__tests__/bridge-sync-op-marker-coverage.test.ts
packages/teamlead/src/__tests__/chrome-session-reaper.test.ts
packages/teamlead/src/__tests__/createLeadRuntime-preflight.test.ts
packages/teamlead/src/__tests__/event-route.test.ts
packages/teamlead/src/__tests__/fly-2413-retention-registry.test.ts
packages/teamlead/src/__tests__/fly2248-mechanism-guards.test.ts
packages/teamlead/src/__tests__/fly2268-mechanism-guards.test.ts
packages/teamlead/src/__tests__/fly2278-retirement.test.ts
packages/teamlead/src/__tests__/fly2278-settle.test.ts
packages/teamlead/src/__tests__/fly2337-dead-mail-terminalization.test.ts
packages/teamlead/src/__tests__/fly2396-authorship-boundary.test.ts
packages/teamlead/src/__tests__/fly2398-narrow-boundary.test.ts
packages/teamlead/src/__tests__/fly2478-resident-probe.test.ts
packages/teamlead/src/__tests__/founder-consent-integration.test.ts
packages/teamlead/src/__tests__/hold-shape-registry.test.ts
packages/teamlead/src/__tests__/lead-token-savings-bootstrap.test.ts
packages/teamlead/src/__tests__/mailbox-lead-runtime.test.ts
packages/teamlead/src/__tests__/publish-html-route.test.ts
packages/teamlead/src/__tests__/reports-route-mount.test.ts
packages/teamlead/src/__tests__/terminal-archive-enqueue-sites.test.ts
packages/teamlead/src/__tests__/terminal-commdb-sync-wiring.test.ts
packages/teamlead/src/__tests__/voice-session-context.test.ts
packages/teamlead/src/__tests__/workflow-dispatch-seams.structure.test.ts
packages/teamlead/src/bin/standing-authority-loaded-rule.test.ts
packages/teamlead/src/bridge/__tests__/automated-message-inventory.test.ts
packages/teamlead/src/bridge/__tests__/codex-runner-orphan-reaper.test.ts
packages/teamlead/src/bridge/__tests__/codex-session-reown-wiring.structure.test.ts
packages/teamlead/src/bridge/__tests__/codex-terminal-harvest-wiring.test.ts
packages/teamlead/src/bridge/__tests__/commdb-fsm-reconcile.fly1329-parked-veto.test.ts
packages/teamlead/src/bridge/__tests__/epic-residual-plugin-wiring.test.ts
packages/teamlead/src/bridge/__tests__/fly1505-boot-drain-order.test.ts
packages/teamlead/src/bridge/__tests__/fly1560-teardown-guard.test.ts
packages/teamlead/src/bridge/__tests__/fly1808-autocontinue-retired.test.ts
packages/teamlead/src/bridge/__tests__/founder-text-approval-wiring.test.ts
packages/teamlead/src/bridge/__tests__/gate-poller-lead-reconcile.test.ts
packages/teamlead/src/bridge/__tests__/gemini-scoped-token.test.ts
packages/teamlead/src/bridge/__tests__/infra-alert-wiring.test.ts
packages/teamlead/src/bridge/__tests__/land-content-proof.test.ts
packages/teamlead/src/bridge/__tests__/land-executor.test.ts
packages/teamlead/src/bridge/__tests__/lead-capability-report.test.ts
packages/teamlead/src/bridge/__tests__/lead-capability-scope.test.ts
packages/teamlead/src/bridge/__tests__/lead-capability-target-lock.test.ts
packages/teamlead/src/bridge/__tests__/liveness-manifest.test.ts
packages/teamlead/src/bridge/__tests__/playwright-orphan-census.test.ts
packages/teamlead/src/bridge/__tests__/residue-harvest.test.ts
packages/teamlead/src/bridge/__tests__/ship-judgment-history-disabled.test.ts
packages/teamlead/src/bridge/__tests__/ship-judgment-runtime.test.ts
packages/teamlead/src/bridge/__tests__/snapshot-closeout.test.ts
packages/teamlead/src/bridge/__tests__/voice-capability-events.test.ts
packages/teamlead/src/bridge/__tests__/voice-session-poller.test.ts
packages/teamlead/src/bridge/__tests__/voice-session-routes.test.ts
packages/teamlead/src/bridge/__tests__/voice-session-services.test.ts
packages/teamlead/src/bridge/__tests__/voice-target-reconcile.test.ts
packages/teamlead/src/bridge/__tests__/workflow-gate-card-lifecycle-wiring.test.ts
packages/teamlead/src/bridge/__tests__/workflow-gate-fence-wiring.test.ts
packages/teamlead/src/bridge/__tests__/workflow-pr-binding-wiring.test.ts
packages/teamlead/src/lead-backends/codex/__tests__/capability-mcp-argv.test.ts
packages/teamlead/src/lead-backends/codex/__tests__/runner-actions.test.ts
packages/teamlead/src/lead-backends/codex/__tests__/spawn-env-wash.test.ts
packages/teamlead/src/lead-capabilities/__tests__/bridge-terminal-evidence.test.ts
packages/teamlead/src/lead-capabilities/__tests__/broker.test.ts
packages/teamlead/src/lead-capabilities/__tests__/browser-config.test.ts
packages/teamlead/src/lead-capabilities/__tests__/browser-provider.test.ts
packages/teamlead/src/lead-capabilities/__tests__/browser-worker.test.ts
packages/teamlead/src/lead-capabilities/__tests__/catalog.test.ts
packages/teamlead/src/lead-capabilities/__tests__/default-parent-integration.test.ts
packages/teamlead/src/lead-capabilities/__tests__/gbrain-host.test.ts
packages/teamlead/src/lead-capabilities/__tests__/gbrain-transport.test.ts
packages/teamlead/src/lead-capabilities/__tests__/github-terminal-evidence.test.ts
packages/teamlead/src/lead-capabilities/__tests__/linear-provider.test.ts
packages/teamlead/src/lead-capabilities/__tests__/linear.test.ts
packages/teamlead/src/lead-capabilities/__tests__/native-skill-baseline.test.ts
packages/teamlead/src/lead-capabilities/__tests__/receipts.test.ts
packages/teamlead/src/lead-capabilities/__tests__/runtime-factory.test.ts
packages/teamlead/src/lead-capabilities/__tests__/runtime-parent.test.ts
packages/teamlead/src/lead-capabilities/__tests__/target-lock-client.test.ts
packages/teamlead/src/lead-capabilities/__tests__/target-lock-provider-integration.test.ts
packages/teamlead/src/lead-capabilities/__tests__/voice-capability-session.test.ts
packages/teamlead/src/lead-capabilities/__tests__/voice-resolve.test.ts
packages/teamlead/src/ship-judgment/__tests__/legacy-retirement.test.ts
```

### packages/voice-codex

Changed production TypeScript:

```text
packages/voice-codex/src/audio.ts
packages/voice-codex/src/bridge-client.ts
packages/voice-codex/src/cli.ts
packages/voice-codex/src/codex-home.ts
packages/voice-codex/src/codex/BrainCoordinator.ts
packages/voice-codex/src/codex/CodexProofSpeaker.ts
packages/voice-codex/src/codex/CodexRoomFrontend.ts
packages/voice-codex/src/codex/CodexVoiceBackend.ts
packages/voice-codex/src/codex/CodexVoiceContainer.ts
packages/voice-codex/src/codex/CodexVoiceHandoff.ts
packages/voice-codex/src/codex/RealtimeTransport.ts
packages/voice-codex/src/codex/ScriptWriter.ts
packages/voice-codex/src/codex/SpeechArbiter.ts
packages/voice-codex/src/codex/SpokenScript.ts
packages/voice-codex/src/codex/ThreadEventRouter.ts
packages/voice-codex/src/config.ts
packages/voice-codex/src/daemon.ts
packages/voice-codex/src/discord-room.ts
packages/voice-codex/src/journal.ts
packages/voice-codex/src/pipeline/Uplink.ts
packages/voice-codex/src/session.ts
packages/voice-codex/src/voice-minutes.ts
```

Retained tests:

```text
packages/voice-codex/src/__tests__/audio.test.ts
packages/voice-codex/src/__tests__/brain-coordinator.test.ts
packages/voice-codex/src/__tests__/bridge-client.test.ts
packages/voice-codex/src/__tests__/codex-container.test.ts
packages/voice-codex/src/__tests__/codex-handoff-transcript.test.ts
packages/voice-codex/src/__tests__/codex-home.test.ts
packages/voice-codex/src/__tests__/codex-room.test.ts
packages/voice-codex/src/__tests__/codex-speak.test.ts
packages/voice-codex/src/__tests__/codex-transport.test.ts
packages/voice-codex/src/__tests__/config.test.ts
packages/voice-codex/src/__tests__/daemon.test.ts
packages/voice-codex/src/__tests__/journal-delivery.test.ts
packages/voice-codex/src/__tests__/script-writer.test.ts
packages/voice-codex/src/__tests__/session.test.ts
packages/voice-codex/src/__tests__/speech-arbiter.test.ts
packages/voice-codex/src/__tests__/spoken-script.test.ts
packages/voice-codex/src/__tests__/thread-event-router.test.ts
packages/voice-codex/src/__tests__/voice-minutes.test.ts
packages/voice-codex/src/pipeline/Uplink.test.ts
```

### packages/voice-core

Changed production TypeScript:

```text
packages/voice-core/src/types.ts
```

Retained tests:

```text
packages/voice-core/src/__tests__/announcer.test.ts
packages/voice-core/src/__tests__/rotator-backend-integration.test.ts
```

### scripts

Changed production TypeScript:

```text
```

Retained tests:

```text
scripts/__tests__/autocompact-override-retirement.test.sh
scripts/__tests__/codex-home-reconcile-cadence.test.sh
scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs
scripts/__tests__/fly1645-receipt-residue-gate.test.mjs
scripts/__tests__/fly1674-residue.test.sh
scripts/__tests__/fly1680-v1-extinction.test.sh
scripts/__tests__/fly2102-flag-freeze.test.sh
scripts/__tests__/fly2403-design-model-comparison.test.sh
scripts/__tests__/flywheel-voice-wrapper.test.sh
scripts/__tests__/gate4-allowlist-masking.test.sh
scripts/__tests__/package-onboard-smoke.test.sh
scripts/__tests__/package-onboard.test.sh
scripts/__tests__/qa-codex-lead-parity.test.mjs
scripts/__tests__/qa-fly-2456-adopt.test.mjs
scripts/__tests__/qa-fly-2456-cli.test.mjs
scripts/__tests__/qa-fly-2456-fleet.test.mjs
scripts/__tests__/qa-fly-2456-observe.test.mjs
scripts/__tests__/qa-fly-2456-park-adopt.test.mjs
scripts/__tests__/qa-fly-2456-qa-identity.test.mjs
scripts/__tests__/qa-fly-2456-rework-adopt.test.mjs
scripts/__tests__/qa-fly-2456-runner-windows.test.mjs
scripts/__tests__/qa-fly-2456-scan.test.mjs
scripts/__tests__/qa-fly-2456-selection.test.mjs
scripts/__tests__/qa-fly-2456-shape.test.mjs
scripts/__tests__/qa-fly-2456-terminate-adopt.test.mjs
scripts/__tests__/runtime-role-auto-qa-retirement.test.sh
scripts/__tests__/ship-judgment-timer.test.mjs
scripts/__tests__/v2-retirement-cleanup.test.sh
```
