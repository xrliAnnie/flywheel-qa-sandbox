# FLY-2922 首块消费者核对 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-26
基于: implementation-evidence.md

核对时间：2026-09-26T16:29:25.452006+00:00。本表只覆盖 watch retention slice；后续改变恢复/关闭/额度/规则时必须重新核对，不代表整单 sweep。

执行 `git grep -lF`，分别使用 `packages/teamlead/src/StateStore.ts`、`StateStore.ts`、`packages/teamlead/src`；119 个文字匹配逐条处置如下。另按 `pruneWorkflowDeadExecutionWatches` 搜索，唯一生产调用者为 workflow-engine-dispatcher，保留两个直接行为测试文件。

`vitest related` 使用 `/tmp/fly2922-watch-vitest.config.mts`，继承原配置、setup、serial 调度，只将 include 限为上述两个文件；避免枢纽 StateStore 触发全包。

| 匹配文件 | 本块处置 |
|---|---|
| `packages/claude-runner/bin/flywheel-claude-profile` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/claude-runner/src/codex-process-snapshot.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/claude-runner/test/fixtures/kill-path-inventory.json` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/claude-runner/test/kill-path-inventory.test.ts` | 保留此仓库守卫测试。 |
| `packages/claude-runner/test/kill-path-inventory.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/config/src/__tests__/drift-scan.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/config/src/__tests__/drift-scan/index.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/config/src/__tests__/feature-flags-drift.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/config/src/__tests__/feature-flags-registry.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/config/src/__tests__/feature-flags-store-policy.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/config/src/__tests__/flag-truth.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/config/src/__tests__/fly1808-wave-a.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/config/src/__tests__/fly1981-final-ledgers.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/config/src/feature-flags/registry.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/config/src/feature-flags/store-policy.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/edge-worker/src/Blueprint.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/edge-worker/src/__tests__/resolveBridgeUrl.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/flywheel-comm/src/commands/complete.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/flywheel-comm/src/commands/gate.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/flywheel-comm/src/commands/stage.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/flywheel-comm/src/commands/verify-approval.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/qa-framework/README.md` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/qa-framework/suites/fly-102-lead-driven-runner-lifecycle.md` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/qa-framework/suites/fly-60-hard-gate.md` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/lead-rules-base/README.md` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/lead-rules-base/founder-only-authority.md` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/src/DirectEventSink.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/src/__tests__/StateStore.land-carryover.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/StateStore.workflow-gate-card-lifecycle.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/bridge-child-process-census.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fixtures/fly2567/compatibility.json` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/src/__tests__/fixtures/loop-guard/attribution-probe.mts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/src/__tests__/fly2121-legacy-name-guard.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fly2248-mechanism-guards.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fly2268-mechanism-guards.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fly2278-retirement.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fly2278-settle.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fly2396-authorship-boundary.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fly2398-narrow-boundary.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fly247-bash-suites.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/fly574-bash-suites.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/hold-shape-registry.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/pane-live-region-fly927-echo.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/report-hosting-secrets.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/required-wall-clock-thresholds.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/__tests__/workflow-dispatch-seams.structure.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/bridge/__tests__/fixtures/fly2269-r4-reviewer-raw.txt` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/src/bridge/__tests__/fly1560-teardown-guard.test.ts` | 保留此仓库守卫测试。 |
| `packages/teamlead/src/bridge/__tests__/land-executor.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/bridge/__tests__/ship-judgment-history-disabled.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/bridge/__tests__/workflow-gate-fence-wiring.test.ts` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `packages/teamlead/src/bridge/child-process-census.json` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/src/bridge/event-route.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/src/bridge/hold-mutation-inventory.json` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `packages/teamlead/src/bridge/run-infra.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/__tests__/auto-narrow-rollback-precheck.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/autocompact-override-retirement.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/ci-structure.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/codex-home-reconcile-cadence.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/fixtures/customer-release-reserve-worker.mjs` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/__tests__/fly-1867-playwright-orphan-census.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/fly-2026-browser-idle-census.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/fly1645-receipt-residue-gate.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/fly1674-residue.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/fly1680-v1-extinction.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/fly2102-flag-freeze.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/fly2403-design-model-comparison.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/flywheel-log-janitor.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/flywheel-log-rotate.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/lead-alert-strict-delivery.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/legacy-swap-broadcast-retirement.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-codex-lead-parity.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-adopt.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-cli.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-fleet.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-observe.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-park-adopt.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-qa-identity.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-rework-adopt.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-runner-windows.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-scan.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-selection.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-shape.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/qa-fly-2456-terminate-adopt.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/runtime-role-auto-qa-retirement.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/ship-judgment-timer.test.mjs` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/test-deploy-generalized.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/__tests__/v2-retirement-cleanup.test.sh` | 本块排除：文字路径引用或其他 StateStore 行为，未调用 watch pruning；此次未改其 flags、hold/rework/land/投递/进程协议。恢复入口相关测试后续重新纳入。 |
| `scripts/e2e-demo.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/e2e-scan-notify.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/fly-1867-legacy-profiles-quarantine.mjs` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/fly-1867-playwright-orphan-census.mjs` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/fly-2006-retention-consumer-gate.config.json` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/fly-2026-browser-idle-census.mjs` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/fly1645-receipt-residue-gate.config.json` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/fly503-consolidation/build_review.py` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/flywheel-cmux-sync.sh` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/inject-linear-issue.sh` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/lib/legacy-swap-broadcast-retirement.sh` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/lib/path-hygiene.sh` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/lib/qa-fly-2456-report-pair.mjs` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/lib/raya-registry-identity.jq` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/lib/setup.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/migrate-report-hosting.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/qa-codex-lead-parity.mjs` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/qa-fly-1193-debounce-e2e.mjs` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/qa-fly-1707-incident-dispatcher.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/run-bridge.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/run-issue.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/test-deploy.sh` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/test-restart-services.sh` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/test-stale-patrol.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/update-flywheel.sh` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/xhs/assemble-config.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/xhs/build-native-runtime.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/xhs/build-runtime.mjs` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/xhs/measure-runtime.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |
| `scripts/xiaohongshu-scheduler.ts` | 本块排除：文档、夹具或非 pruning 调用者；本块未改其 CLI、flags、生命周期、schema 或公开类型合同。 |

额外保留：FLY-2567 `lead-token-savings-drift.test.ts`。稀疏迁移测试暂不因本块新增运行：没有迁移/列/初始化逻辑变化；后续 receipt schema 变更必须纳入。外部插件 fork/cache 的整单 sweep 尚未执行，不能报告零引用。
