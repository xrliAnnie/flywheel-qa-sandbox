# FLY-2711 consumer discovery

Date: 2026-09-24

Commands were run with `git grep -lF` using every changed TypeScript file full path, file name, and the immediate parent directory. The executable inclusion set is intentionally bounded to direct/runtime consumers; every literal-only match excluded from local tests is listed below.

## Main repository

Included executable coverage:

- `packages/teamlead/src/bridge/__tests__/voice-self-filter-probe.test.ts`
- `packages/teamlead/src/bridge/__tests__/voice-self-filter-vectors.test.ts`
- Both were run directly and through `vitest related`; no production TypeScript file changed.

Excluded exact-name/full-path matches (documentation or historical path inventory, not executable consumers):

- `engineering/doc/FLY-2681-ci-on-demand-matrix/data/paths-0916.json`
- `engineering/doc/FLY-2598-voice-host-activation/self-filter-contract.md`
- `engineering/doc/FLY-2711-voice-carrier-parity/plan.md`

Excluded parent-directory matches (each contains the literal test-directory path only; none imports or executes either changed test file):

- `doc/engineer/plan/archive/v1.28.0-FLY-159-gate-timeout-48h.md`
- `doc/engineer/plan/archive/v1.28.0-FLY-162-lead-thread-routing.md`
- `doc/engineer/plan/archive/v1.28.0-GEO-151-proofshot-integration.md`
- `doc/engineer/plan/archive/v1.29.0-FLY-173-routing-guard-core-exempt.md`
- `doc/engineer/plan/archive/v1.56.0-FLY-529-qa-room-mirrors.md`
- `doc/engineer/plan/inprogress/v1.52.0-FLY-371-projectname-linear-mapping.md`
- `doc/engineer/plan/inprogress/v1.55.0-FLY-494-kimi-runner-backend.md`
- `doc/engineer/plan/new/v1.56.0-FLY-742-cron-stale-session-guard.md`
- `doc/plan/archive/v1.21.0-FLY-47-channel-contract.md`
- `doc/qa/FLY-710-fly707-enablement-qa-report.md`
- `engineering/doc/FLY-1048-watchdog-detection-remaining/plan.md`
- `engineering/doc/FLY-1070-qa-respawn-verify/research.md`
- `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/kill5-attribution-worktree-activity.txt`
- `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/kill5-vitest-trigger-hunt.txt`
- `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/step3-suspect-matrix-static-batch2.txt`
- `engineering/doc/FLY-1142-swap-sensor-real-pressure/plan.md`
- `engineering/doc/FLY-1142-swap-sensor-real-pressure/research.md`
- `engineering/doc/FLY-1165-done-thread-archive-reconcile/plan.md`
- `engineering/doc/FLY-1193-oom-alert-debounce/plan.md`
- `engineering/doc/FLY-1204-phase-session-leak/research.md`
- `engineering/doc/FLY-1232-pr1-claims-substrate/plan.md`
- `engineering/doc/FLY-1232-pr1-claims-substrate/qa-report.md`
- `engineering/doc/FLY-1234-watchdog-stuck-false-positives/e2e-evidence/qa-fly1234-nton-e2e.mjs`
- `engineering/doc/FLY-1238-founder-message-gate-guard/plan.md`
- `engineering/doc/FLY-1252-quota-state-trust/plan.md`
- `engineering/doc/FLY-1254-no-verdict-parse-fix/plan.md`
- `engineering/doc/FLY-1255-vendor-neutral-model-display/plan.md`
- `engineering/doc/FLY-1256-external-quota-autoswitch/plan.md`
- `engineering/doc/FLY-1257-codex-runtime-retry-defects/plan.md`
- `engineering/doc/FLY-1259-design-backend-override/plan.md`
- `engineering/doc/FLY-1259-design-backend-override/research.md`
- `engineering/doc/FLY-1264-reconnect-title-restore/plan.md`
- `engineering/doc/FLY-1269-codex-phase-keepalive/plan.md`
- `engineering/doc/FLY-1328-runner-close-ask-cleanup/qa-report.md`
- `engineering/doc/FLY-1372-dag-dispatch-entry/plan.md`
- `engineering/doc/FLY-1392-receipt-foundation/qa-report.md`
- `engineering/doc/FLY-1423-qa-kickback-deadlock/plan.md`
- `engineering/doc/FLY-1423-qa-retry-ghost-admit/codex-rescue-design-feedback-flywheel-FLY-1423-plan-round1.md`
- `engineering/doc/FLY-1466-strip-three-flags/research.md`
- `engineering/doc/FLY-1497-v2db-schema-kernel/qa-report.md`
- `engineering/doc/FLY-1501-alerts-storm-shim/design-review/codex-rescue-design-feedback-flywheel-FLY-1501-plan-round1.md`
- `engineering/doc/FLY-1570-watchdog-teardown/qa-report.md`
- `engineering/doc/FLY-1586-inbox-loop-poison-isolation/progress.md`
- `engineering/doc/FLY-1709-archive-once-deadlock/research.md`
- `engineering/doc/FLY-1751-control-channel-reliability/research.md`
- `engineering/doc/FLY-1766-watchdog-teardown-qa/evidence/slot3-runner-pane-login-expired.txt`
- `engineering/doc/FLY-1766-watchdog-teardown-qa/harness/README.md`
- `engineering/doc/FLY-1788-prd-activation-missing/plan.md`
- `engineering/doc/FLY-1810-doc-flow-rollout/audit.md`
- `engineering/doc/FLY-1877-classify-docs-only-rule/plan.md`
- `engineering/doc/FLY-1929-kernel-panic-voucher-leak/plan.md`
- `engineering/doc/FLY-1942-comm-defense-trio/research.md`
- `engineering/doc/FLY-1987-actions-cost-audit/data/raw/prfiles.tsv`
- `engineering/doc/FLY-1991-retired-env-cleanup/plan.md`
- `engineering/doc/FLY-2008-founder-reply-deliver-stall/plan.md`
- `engineering/doc/FLY-2017-runner-stop-edge/plan.md`
- `engineering/doc/FLY-2026-browser-on-demand/plan.md`
- `engineering/doc/FLY-2027-generalized-land-closeout/qa-report.md`
- `engineering/doc/FLY-2030-raya-brain-inquiry/progress.md`
- `engineering/doc/FLY-2037-remove-reviewer-slot-limit/exploration.md`
- `engineering/doc/FLY-2037-remove-reviewer-slot-limit/plan.md`
- `engineering/doc/FLY-2037-remove-reviewer-slot-limit/qa-report.md`
- `engineering/doc/FLY-2037-remove-reviewer-slot-limit/research.md`
- `engineering/doc/FLY-2075-alert-hub-starvation/research.md`
- `engineering/doc/FLY-2100-flag-scope-per-project/research.md`
- `engineering/doc/FLY-2102-flag-b2-startup-freeze/exploration.md`
- `engineering/doc/FLY-2102-flag-b2-startup-freeze/progress.md`
- `engineering/doc/FLY-2104-weekly-flag-scan/plan.md`
- `engineering/doc/FLY-2112-sessionless-founder-gate-closeout/plan.md`
- `engineering/doc/FLY-2115-land-worktree-dependency/plan.md`
- `engineering/doc/FLY-2134-monitor-the-monitors/codex-review-round1.md`
- `engineering/doc/FLY-2134-monitor-the-monitors/plan.md`
- `engineering/doc/FLY-2134-monitor-the-monitors/research.md`
- `engineering/doc/FLY-2136-mailbox-deadscan-hotloop/research.md`
- `engineering/doc/FLY-2137-calendar-write-governance/plan.md`
- `engineering/doc/FLY-2152-verdict-delivery-patrol/plan.md`
- `engineering/doc/FLY-2152-verdict-delivery-patrol/qa-report.md`
- `engineering/doc/FLY-2168-codex-interactive-tui/plan.md`
- `engineering/doc/FLY-2190-rosetta-tmux-arm64/plan.md`
- `engineering/doc/FLY-2194-review-supersede-alerts/plan.md`
- `engineering/doc/FLY-2207-cmux-watcher-lifecycle/plan.md`
- `engineering/doc/FLY-2216-raya-brain-residency/plan.md`
- `engineering/doc/FLY-2228-review-head-self-heal/plan.md`
- `engineering/doc/FLY-2257-console-ux-implement/plan.md`
- `engineering/doc/FLY-2259-raya-brain-cutover/plan.md`
- `engineering/doc/FLY-2259-raya-brain-cutover/research.md`
- `engineering/doc/FLY-2264-arm64-tmux-gate/plan.md`
- `engineering/doc/FLY-2293-linear-start-state/plan.md`
- `engineering/doc/FLY-2302-dead-body-commdb-residue/plan.md`
- `engineering/doc/FLY-2313-pending-closeout-finalization/plan.md`
- `engineering/doc/FLY-2332-replay-credential-rotation/plan.md`
- `engineering/doc/FLY-2351-snapshot-disk-guard/research.md`
- `engineering/doc/FLY-2352-codex-reown-capability-drift/plan.md`
- `engineering/doc/FLY-2368-flag-copy-humanization/research.md`
- `engineering/doc/FLY-2390-criteria-c-aggregator/exploration.md`
- `engineering/doc/FLY-2396-founder-gate-head-origin/plan.md`
- `engineering/doc/FLY-2396-founder-gate-head-origin/research.md`
- `engineering/doc/FLY-2399-auto-approve-learning/code-review-r2.md`
- `engineering/doc/FLY-2399-auto-approve-learning/plan.md`
- `engineering/doc/FLY-2408-ship-gate-title-marker/plan.md`
- `engineering/doc/FLY-2426-anchor-pr-retirement/plan.md`
- `engineering/doc/FLY-2430-lead-rework-attribution/plan.md`
- `engineering/doc/FLY-2465-codex-fleet-rotation/plan.md`
- `engineering/doc/FLY-2485-lead-judgment-cell/evidence/rework-lint.txt`
- `engineering/doc/FLY-2485-lead-judgment-cell/research.md`
- `engineering/doc/FLY-2490-closeout-never-launched-node/plan.md`
- `engineering/doc/FLY-2490-closeout-never-launched-node/research.md`
- `engineering/doc/FLY-2498-design-holder-commdb-residue/plan.md`
- `engineering/doc/FLY-2504-rework-replacement-receipt/research.md`
- `engineering/doc/FLY-2508-updater-beta-alignment/design-review/codex-round1.md`
- `engineering/doc/FLY-2508-updater-beta-alignment/plan.md`
- `engineering/doc/FLY-2519-codex-lead-parity/code-review-r2.md`
- `engineering/doc/FLY-2519-codex-lead-parity/review-code-attempt6-r4.json`
- `engineering/doc/FLY-2519-codex-lead-parity/review-code-attempt6-r5.json`
- `engineering/doc/FLY-2523-quota-home-readiness/plan.md`
- `engineering/doc/FLY-2547-reviewer-no-verdict-prompt/plan.md`
- `engineering/doc/FLY-2547-reviewer-no-verdict-prompt/research.md`
- `engineering/doc/FLY-2560-trial-judgment-evidence/replay-evidence.json`
- `engineering/doc/FLY-2563-bridge-loop-fd/plan.md`
- `engineering/doc/FLY-2603-summary-receipts/validation.md`
- `engineering/doc/FLY-2638-discord-attachment-content/research.md`
- `engineering/doc/FLY-2643-visible-tui-default/plan.md`
- `engineering/doc/FLY-2655-voice-receive-recovery/realtime-handoff.md`
- `engineering/doc/FLY-2661-manual-history-render/plan.md`
- `engineering/doc/FLY-2662-closeout-recovery/evidence/replay-manifest.json`
- `engineering/doc/FLY-2662-closeout-recovery/implement-red-pending-window.md`
- `engineering/doc/FLY-2669-shuttle-failure-visibility/review-r2.json`
- `engineering/doc/FLY-2680-raya-merge-plan/plan.md`
- `engineering/doc/FLY-2681-ci-on-demand-matrix/data/paths-0916.json`
- `engineering/doc/FLY-2697-summary-migration-gate/plan.md`
- `engineering/doc/FLY-2697-summary-migration-gate/research.md`
- `engineering/doc/FLY-2711-voice-carrier-parity/plan.md`
- `engineering/doc/FLY-2746-ubicloud-ci-cutover/canary-receipt.md`
- `engineering/doc/FLY-2751-epic-page-blob-budget/design-correction.md`
- `engineering/doc/FLY-2751-epic-page-blob-budget/plan.md`
- `engineering/doc/FLY-2753-targeted-local-tests/implementation.md`
- `engineering/doc/FLY-2789-workflow-scorecard/plan.md`
- `engineering/doc/FLY-2807-quota-probe-fixes/plan.md`
- `engineering/doc/FLY-546-headphone-mode/plan.md`
- `engineering/doc/FLY-728-per-issue-model/plan.md`
- `engineering/doc/FLY-728-per-issue-model/research.md`
- `engineering/doc/FLY-755-model-code-front/plan.md`
- `engineering/doc/FLY-766-chrome-lifecycle-reaper/plan.md`
- `engineering/doc/FLY-788-runner-default-model-opus/plan.md`
- `engineering/doc/FLY-788-runner-default-model-opus/research.md`
- `engineering/doc/FLY-827-codex-hard-gate/research.md`
- `engineering/doc/FLY-887-phase-session-keepalive/qa-report.md`
- `engineering/doc/FLY-887-phase-session-keepalive/research.md`
- `engineering/doc/FLY-900-remove-founder-ux-gate/research.md`
- `engineering/doc/FLY-927-alert-ticket-queue/plan.md`
- `engineering/doc/FLY-945-founder-approve-self-ship/qa-report.md`
- `engineering/doc/milestones/FLY-2278.md`
- `packages/claude-runner/test/fixtures/kill-path-inventory.json`
- `packages/config/src/feature-flags/registry.ts`
- `packages/qa-framework/README.md`
- `scripts/__tests__/ci-structure.test.sh`
- `scripts/__tests__/fly1674-residue.test.sh`
- `scripts/__tests__/fly2102-flag-freeze.test.sh`
- `scripts/__tests__/runtime-role-auto-qa-retirement.test.sh`
- `scripts/lib/path-hygiene.sh`

## Nested `paired/claude-plugins` repository

Included executable coverage:

- `external_plugins/discord/package.json` and `external_plugins/discord/start-adapter.sh`: runtime entrypoint references; covered by `bun build ./server.ts --target=bun` and the full package `bun test`.
- `.github/workflows/validate-discord-runtime.yml`: validation consumer; fork PR CI passed.
- `external_plugins/discord/self-author-filter.test.ts`, `external_plugins/discord/voice-self-filter-socket.test.ts`, and `external_plugins/discord/voice-self-filter-vectors.test.ts`: direct tests; all included in the 257-test package run.

No-match searches (exit 1 means no tracked literal consumer):

- `external_plugins/discord/self-author-filter.test.ts`
- `self-author-filter.test.ts`
- `external_plugins/discord/self-author-filter.ts`
- `self-author-filter.ts`
- `external_plugins/discord/voice-self-filter-socket.test.ts`
- `voice-self-filter-socket.test.ts`
- `external_plugins/discord/voice-self-filter-socket.ts`
- `external_plugins/discord/voice-self-filter-vectors.test.ts`
- `voice-self-filter-vectors.test.ts`

Excluded exact-name/full-path matches:

- `external_plugins/discord/doc/FLY-306-reply-reliability-guard/plan.md` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `.github/workflows/sync-upstream.yml` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/discord/chat-receipt-runtime.test.ts` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/discord/doc/FLY-306-reply-reliability-guard/qa-fly-309-report.md` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/discord/reply-send.ts` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/discord/roundtable-shared-routing.ts` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/discord/roundtable-thread-policy.ts` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/discord/server.ts` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/discord/skills/access/SKILL.md` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/fakechat/package.json` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/imessage/package.json` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/telegram/package.json` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/telegram/server.ts` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `plugins/mcp-server-dev/skills/build-mcp-app/SKILL.md` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `plugins/mcp-server-dev/skills/build-mcp-server/references/remote-http-scaffold.md` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.
- `external_plugins/discord/voice-self-filter-socket.test.ts` — generic filename, documentation, self-reference, or another plugin; not a direct FLY-2711 consumer.

Excluded parent-directory matches:

- `.claude-plugin/marketplace.json` — marketplace/sync metadata or historical documentation; not an executable consumer of the changed modules.
- `.github/workflows/sync-upstream.yml` — marketplace/sync metadata or historical documentation; not an executable consumer of the changed modules.
- `external_plugins/discord/doc/FLY-306-reply-reliability-guard/plan.md` — marketplace/sync metadata or historical documentation; not an executable consumer of the changed modules.
- `external_plugins/discord/doc/FLY-306-reply-reliability-guard/qa-fly-309-report.md` — marketplace/sync metadata or historical documentation; not an executable consumer of the changed modules.

