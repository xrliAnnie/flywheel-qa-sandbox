# FLY-2753 定向测试选择 — 调研
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: plan.md

本轮实现执行 `72841877-9325-48d7-b508-3ceb1ed9b635`，从 `d300efb9c` 复核已提交实现，没有重新设计或修改角色行为。比较基准为 `origin/main...HEAD` 的 19 个改动文件。对每个文件的完整路径、文件名和父目录分别执行 `git grep -lF -e <needle> -- packages scripts apps .flywheel`：57 次搜索、107 个去重命中文件。exit 1 仅表示无命中；非 0/1 视为错误。按批准计划限制源码/测试目录；不把全仓历史文档重名当作消费者。

保留并运行新 shell 合同（4 份 prompt + 7 个负例），另运行本单设计产物的 `verify-html.mjs`（14 项）。后者在文档目录，属于直接验证器，主动保留。其余匹配逐文件处置如下；通用 plan/progress/research/exploration 文件名与父目录命中不构成本单内容依赖。

没有 TypeScript、包导出、接口、依赖或编译配置变更。`flywheel-qa-framework` 的 build=`tsc`、typecheck=`tsc --noEmit` 均不编译 Markdown prompt；根包只含全仓递归入口。本单 build/typecheck 和 `vitest related` 为 N/A，未执行空匹配过滤器冒充通过。新增 shell 文件清单只有下表保留项。

## 搜索覆盖

| 改动文件 | 三种 needle 的命中文件数（完整路径 / 文件名 / 父目录） |
|---|---|
| `.flywheel/agents/engineering/engineer-executor.md` | 3 / 4 / 6 |
| `.flywheel/agents/engineering/qa-executor.md` | 4 / 9 / 6 |
| `.flywheel/agents/general-executor.md` | 6 / 7 / 19 |
| `engineering/doc/FLY-2753-targeted-local-tests/design-review-r1.json` | 0 / 0 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/design-review-r2.json` | 0 / 0 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/design-review-resumed-r1.json` | 0 / 0 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/design-review-resumed-r2.json` | 0 / 0 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/exploration.md` | 0 / 8 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/flow.mmd` | 0 / 0 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/founder-design.html` | 0 / 0 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/implementation.md` | 0 / 0 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/plan.md` | 0 / 45 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/progress.md` | 0 / 25 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/research.md` | 0 / 14 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/verification.md` | 0 / 0 / 0 |
| `engineering/doc/FLY-2753-targeted-local-tests/verify-html.mjs` | 0 / 0 / 0 |
| `engineering/doc/milestones/FLY-2753.md` | 0 / 0 / 0 |
| `packages/qa-framework/agents/qa-parallel-executor.md` | 1 / 2 / 1 |
| `scripts/__tests__/fly2753-targeted-verification-contract.test.sh` | 0 / 0 / 18 |

## 每个匹配的处置

| 匹配文件 | 处置与原因 |
|---|---|
| `.flywheel/agents/engineering/engineer-executor.md` | 保留人工核对，并由新增 shell 合同直接读取验证。 |
| `.flywheel/agents/engineering/qa-executor.md` | 保留人工核对，并由新增 shell 合同直接读取验证。 |
| `.flywheel/agents/general-executor.md` | 保留人工核对，并由新增 shell 合同直接读取验证。 |
| `.flywheel/config.yaml` | 排除测试：实际角色路由已人工核对，配置未变。 |
| `packages/claude-runner/test/codex-daemon-adapter-helpers.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/config/src/ConfigLoader.ts` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `packages/config/src/__tests__/ConfigLoader.test.ts` | 排除：YAML 路径/配置夹具；不读取改动的验证文字，路径与路由未改。 |
| `packages/config/src/__tests__/progress-path-resolver.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md, progress.md），不读取本单内容。 |
| `packages/config/src/__tests__/progress-schema.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（exploration.md, plan.md, progress.md），不读取本单内容。 |
| `packages/config/src/feature-flags/registry.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/config/src/index.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/config/src/progress-path-resolver.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/config/src/progress-schema.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（exploration.md, plan.md, progress.md），不读取本单内容。 |
| `packages/config/src/types.ts` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `packages/core/src/adapter-types.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/edge-worker/src/AgentDispatcher.ts` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `packages/edge-worker/src/Blueprint.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（exploration.md, plan.md, progress.md, research.md），不读取本单内容。 |
| `packages/edge-worker/src/__tests__/AgentDispatcher.test.ts` | 排除：角色选择和 agent_file 字符串断言；不读取本次提示词内容，路由未改。 |
| `packages/edge-worker/src/__tests__/Blueprint.fly205-doc-flow.test.ts` | 排除：通用 doc-flow 文案与临时 agent 夹具，不加载本单文档或角色内容。 |
| `packages/edge-worker/src/__tests__/Blueprint.v0.6.integration.test.ts` | 排除：临时 product prompt 的路径/大小/符号链接夹具，不读取本单四份 prompt。 |
| `packages/edge-worker/src/__tests__/__snapshots__/Blueprint.fly1188-codex-prompt.test.ts.snap` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/edge-worker/src/__tests__/resume-mode.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/edge-worker/src/resume-mode.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（exploration.md, plan.md, progress.md, research.md），不读取本单内容。 |
| `packages/flywheel-cli/src/__tests__/doctor.test.ts` | 排除：临时 product agent 路径检查，不读取本单 prompt。 |
| `packages/flywheel-cli/src/__tests__/migrate-agents-path.test.ts` | 排除：同名迁移夹具；本单未改路径或迁移代码。 |
| `packages/flywheel-cli/src/commands/doctor.ts` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `packages/flywheel-cli/src/commands/init.ts` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `packages/flywheel-cli/src/commands/migrate-agents-path.ts` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `packages/flywheel-cli/src/index.ts` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `packages/flywheel-cli/src/templates/config.yaml.tmpl` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `packages/flywheel-comm/src/__tests__/codex-resume-render.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（research.md），不读取本单内容。 |
| `packages/flywheel-comm/src/__tests__/request-review.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/flywheel-comm/src/commands/__tests__/progress.realgit.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/flywheel-comm/src/commands/__tests__/progress.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/flywheel-comm/src/commands/codex-resume.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（research.md），不读取本单内容。 |
| `packages/flywheel-comm/src/commands/progress.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/flywheel-comm/src/index.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/gemini-agent/README.md` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/qa-framework/README.md` | 排除测试：helper 文档链接；提示词由本单 shell 合同验证。 |
| `packages/qa-framework/agents/qa-parallel-executor.md` | 保留人工核对，并由新增 shell 合同直接读取验证。 |
| `packages/teamlead/scripts/__tests__/fly869-founder-ux-default-mode.test.sh` | 排除：只引用其他 shell 测试/目录或自身运行说明，不读取本单合同。 |
| `packages/teamlead/src/DirectEventSink.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/__tests__/core-room-gate.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（research.md），不读取本单内容。 |
| `packages/teamlead/src/__tests__/fly1135-doc-sentinel.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（exploration.md, plan.md, research.md），不读取本单内容。 |
| `packages/teamlead/src/__tests__/fly247-bash-suites.test.ts` | 排除：显式枚举其他 shell 测试，无 glob，不调用本单新增合同。 |
| `packages/teamlead/src/__tests__/fly574-bash-suites.test.ts` | 排除：显式枚举另外两个 shell 测试，不调用本单新增合同。 |
| `packages/teamlead/src/account-heal/account-ledger.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（research.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-frame1.txt` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-frame2.txt` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly1050-qa-respawn.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（research.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/__tests__/progress-resume.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md, progress.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/__tests__/run-dispatcher-resume.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/__tests__/stale-approved-ship-reconciler.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/done-thread-reconcile.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/gate-poller.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/lifecycle-closeout.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/lifecycle-routes.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/lifecycle-sweep.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/mcp-descendant-reaper.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/plugin.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/post-ship-finalization.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/progress-resume.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/rescue-runtime.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/run-dispatcher.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md, progress.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/run-infra.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md, progress.md），不读取本单内容。 |
| `packages/teamlead/src/bridge/stale-approved-ship-reconciler.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（progress.md），不读取本单内容。 |
| `packages/teamlead/src/lead-backends/codex/__tests__/read-deny-removed.sentinel.test.ts` | 排除：引用其他 scripts/__tests__ 测试，不调用本单合同。 |
| `packages/voice-core/evidence/README.md` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/evidence/fly-959-qa-verification.md` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/evidence/fly-959-regression.md` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/evidence/poc-converse.md` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/__tests__/announcer.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/__tests__/extra-tools.test.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/audio/MicCapture.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/backends/edge-tts/EdgeTtsBackend.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/backends/edge-tts/EdgeTtsEngine.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/backends/gemini/GeminiLiveBackend.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/backends/gemini/transport.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/backends/registry.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/brain/HeadlessClaudeBrain.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/cli.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/config.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/index.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/process.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/transcript.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `packages/voice-core/src/types.ts` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `scripts/__tests__/fly1165-sweep-decision.test.mjs` | 排除：只引用其他 shell 测试/目录或自身运行说明，不读取本单合同。 |
| `scripts/__tests__/fly2753-targeted-verification-contract.test.sh` | 保留并执行：直接读取四份改动 prompt 的合同，含七种负例。 |
| `scripts/__tests__/package-onboard-smoke.test.sh` | 排除：检查打包后的 agents/qa-executor.md，属于另一个未改动 prompt。 |
| `scripts/__tests__/test-pm-executor-contract.sh` | 排除：同目录的 PM/prototype/product-designer 三份规则合同，均未改动。 |
| `scripts/__tests__/test-setup-doc-flow.sh` | 排除：只引用其他 shell 测试/目录或自身运行说明，不读取本单合同。 |
| `scripts/__tests__/test-setup-new-project.sh` | 排除：临时 content-executor 初始化检查；只有父目录名称相同。 |
| `scripts/fly1165-archive-done-threads.mjs` | 排除：通用文档名/其他 issue 注释或夹具命中（research.md），不读取本单内容。 |
| `scripts/hooks/flywheel-restart-guard.py` | 排除：通用文档名/其他 issue 注释或夹具命中（plan.md），不读取本单内容。 |
| `scripts/lib/agent-cli-providers/CONTRACT.md` | 排除：只引用其他 shell 测试/目录或自身运行说明，不读取本单合同。 |
| `scripts/lib/bridge-port.sh` | 排除：只引用其他 shell 测试/目录或自身运行说明，不读取本单合同。 |
| `scripts/lib/qa-multilead.sh` | 排除：只引用其他 shell 测试/目录或自身运行说明，不读取本单合同。 |
| `scripts/lib/restart-candidate.sh` | 排除：只引用其他 shell 测试/目录或自身运行说明，不读取本单合同。 |
| `scripts/package-onboard-files.allow` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `scripts/package-onboard.sh` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `scripts/qa-fly-907-real-discord-e2e.mjs` | 排除：通用文档名/其他 issue 注释或夹具命中（exploration.md），不读取本单内容。 |
| `scripts/setup-doc-flow.sh` | 排除：通用文档名/其他 issue 注释或夹具命中（exploration.md, plan.md, research.md），不读取本单内容。 |
| `scripts/setup-new-project.sh` | 排除测试：通用角色路径处理、类型、模板或打包引用；未改路径与加载机制。 |
| `scripts/test-deploy.sh` | 排除：只引用其他 shell 测试/目录或自身运行说明，不读取本单合同。 |
| `scripts/voice-audition-fly546.mjs` | 排除：通用文档名/其他 issue 注释或夹具命中（research.md），不读取本单内容。 |
