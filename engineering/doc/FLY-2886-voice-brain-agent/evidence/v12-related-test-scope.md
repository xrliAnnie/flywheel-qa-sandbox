# FLY-2886 v12 related test scope (implement, this run)

Base: `4342dd06e` (last exact-head full CI green) .. HEAD. Discovery per changed production TS file: tests in the same package importing it by file name (`/<name>.js`), tests in any package importing its package export subpath, and tests referencing its full source path or `packages/<pkg>/dist/<rel>.js`. Hub files (`StateStore.ts`, `codex-lead-runtime.ts`) keep only consumers touching voice/capability paths. Full machine list: `~/.flywheel/artifacts/FLY-2886/v12-related-test-scope.json`.

Changed production files: 33. Retained tests: 85. Excluded: 929 (directory-name/same-name matches: 398; hub consumers without voice/capability paths: 531).

## Retained
- packages/config/src/__tests__/fly1981-final-ledgers.test.ts
- packages/teamlead/src/__tests__/StateStore.flag-value-store.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-background-degraded.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-health-demand.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-health-projection.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-identity.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-launch-budget.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-schedule.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-session-schema.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-session.test.ts
- packages/teamlead/src/__tests__/StateStore.voice-target-lock.test.ts
- packages/teamlead/src/__tests__/flag-routes.test.ts
- packages/teamlead/src/__tests__/fly-2006-database-retention-sweep.test.ts
- packages/teamlead/src/__tests__/linear-comment-and-lookup.test.ts
- packages/teamlead/src/__tests__/linear-comments.test.ts
- packages/teamlead/src/__tests__/voice-handoff.test.ts
- packages/teamlead/src/__tests__/voice-session-context.test.ts
- packages/teamlead/src/bridge/__tests__/lead-capability-scope.test.ts
- packages/teamlead/src/bridge/__tests__/lead-capability-target-lock.test.ts
- packages/teamlead/src/bridge/__tests__/lead-capability-voice.test.ts
- packages/teamlead/src/bridge/__tests__/lead-reply-failed-route.test.ts
- packages/teamlead/src/bridge/__tests__/voice-capability-events.test.ts
- packages/teamlead/src/bridge/__tests__/voice-health-demand-recorder.test.ts
- packages/teamlead/src/bridge/__tests__/voice-health-projector.test.ts
- packages/teamlead/src/bridge/__tests__/voice-schedule-routes.test.ts
- packages/teamlead/src/bridge/__tests__/voice-schedule-runtime.test.ts
- packages/teamlead/src/bridge/__tests__/voice-session-card.test.ts
- packages/teamlead/src/bridge/__tests__/voice-session-poller.test.ts
- packages/teamlead/src/bridge/__tests__/voice-session-provisioner.test.ts
- packages/teamlead/src/bridge/__tests__/voice-session-routes.test.ts
- packages/teamlead/src/bridge/__tests__/voice-session-runtime.test.ts
- packages/teamlead/src/bridge/__tests__/voice-session-services.test.ts
- packages/teamlead/src/bridge/__tests__/voice-session-start.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/CodexLeadProcess.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/agent-tui-binding.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/browser-capability-proxy.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/buildCodexLeadMcpArgv.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/capability-app-server.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/capability-mcp-argv.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/capability-model-env.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/capability-readiness.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/capability-tui-runtime.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/codex-lead-runtime.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/codex-lead-tui-runtime.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/lead-capability-proxy.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/runner-actions.test.ts
- packages/teamlead/src/lead-backends/codex/__tests__/spawn-env-wash.test.ts
- packages/teamlead/src/lead-backends/codex/lead-actions/__tests__/runner-mcp-config.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/browser-egress-proxy.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/browser-provider.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/capability-home.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/child-spawn-observer.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/credential-paths.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/default-parent-integration.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/default-runtime.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/manifest.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/model-env.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/model-isolation-host.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/model-isolation.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/node-runtime-closure.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/operation-transport.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/parity-drill.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/permission-profile.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/runtime-factory.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/runtime-parent.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/target-lock-provider-integration.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/voice-capability-brief.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/voice-capability-parent.test.ts
- packages/teamlead/src/lead-capabilities/__tests__/voice-founder-denial.test.ts
- packages/voice-codex/src/__tests__/admission-residuals.test.ts
- packages/voice-codex/src/__tests__/bridge-client.test.ts
- packages/voice-codex/src/__tests__/codex-container.test.ts
- packages/voice-codex/src/__tests__/codex-repeat-confirmation.test.ts
- packages/voice-codex/src/__tests__/codex-room.test.ts
- packages/voice-codex/src/__tests__/codex-transport.test.ts
- packages/voice-codex/src/__tests__/daemon-health.test.ts
- packages/voice-codex/src/__tests__/daemon.test.ts
- packages/voice-codex/src/__tests__/lease.test.ts
- packages/voice-codex/src/__tests__/qa2701-final-read-race.test.ts
- packages/voice-codex/src/__tests__/recovery.test.ts
- packages/voice-codex/src/__tests__/session.test.ts
- scripts/__tests__/flywheel-voice-wrapper.test.sh
- scripts/__tests__/install-voice-launchd.test.mjs
- scripts/__tests__/package-onboard-smoke.test.sh
- scripts/__tests__/qa-fly-2519-browser-node.test.mjs

## Results

| Set | Result |
|---|---|
| `pnpm lint` | exit 0, 25 warnings (pre-existing), 0 errors |
| `pnpm --filter "flywheel-voice-codex..." build` (includes teamlead and its deps) | Done |
| `pnpm --filter "...flywheel-teamlead" typecheck`, `pnpm --filter "...flywheel-voice-codex" typecheck` | Done |
| teamlead retained (68 files; `TMPDIR=/tmp/f2886t`, isolated `FLYWHEEL_CODEX_HOMES_ROOT`, 4 threads, tmux-viewer excluded) | 932/932 |
| voice-codex retained (12) | 251/251 |
| config retained (1) | 12/12 |
| `scripts/__tests__/flywheel-voice-wrapper.test.sh` | 32/32 |
| `scripts/__tests__/install-voice-launchd.test.mjs` | pass |
| `scripts/__tests__/package-onboard-smoke.test.sh` | 26/26 (after building the six packages without dist) |
| `scripts/__tests__/qa-fly-2519-browser-node.test.mjs` | 1 pass, 1 fail (`browser_lost` at `BrowserWorker.start`) — see below |
| teamlead `vitest related` (14 leaf modules; expanded to 614 files) | 8552 passed, 4 skipped |
| voice-codex `vitest related` (7 changed files) | 251/251 |
| host tests: `model-isolation-host`, `node-runtime-closure` host case, `admission-residuals` real-host case | pass (real codex 0.156.1, Homebrew node, ps/signals) |

`qa-fly-2519-browser-node` "final Seatbelt policy boots pinned Node, MCP and native Chrome": a darwin-only host test that launches headed Chrome. It pins Chrome 153.0.8010.37 (`BROWSER_HOST_BASELINE`) while this host runs 153.0.8010.53 (auto-updated). The code this PR changed on its path (egress proxy probe URL interception, spawn identity report outside an admission) is a no-op for its traffic. Not re-run, to avoid opening Chrome on the founder's screen again; not part of CI (skips off darwin). Recorded as observed drift, cause not proven.
