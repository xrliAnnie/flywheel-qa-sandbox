# FLY-2753 本机定向测试守则 — 实施记录
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: plan.md

## 实现与范围

- TURN: implement epoch 2; execution `4b84f105-9225-42a4-95cb-662c6c05a315`。
- Design R2 gate `92378e0f-a721-4723-a6f8-6065de1ded82` effective APPROVED；执行本仓适配的原计划。
- RED anchor `9750ba8b9`：三份实际角色文件均因旧全量语句失败，3 failed / 23 skipped；不是 ENOENT。首次无依赖的 vitest 启动失败单独记录，随后 `pnpm install --frozen-lockfile` 成功，锁文件不变。
- 单一 canonical policy + 三处 marker 投影；只改 engineer 验证第 5 步/description、qa 验证第 3 步、general 路由验证摘要。其余角色条款保持，CLAUDE.md、registry、CI workflow 未修改。
- 同步器固定三条目标路径，默认只检查；`--write` 先校验全部输入，再逐文件写。非法 source/marker/参数/缺目标均 fail closed；不声称磁盘故障下跨文件原子性，修复后重跑 check。
- prebuild 精确连接真实同步检查；测试通过真实 pnpm build fixture 证明漂移阻止 build。无数据库、运行时 API、exports/types 变更，故不触发 dependents typecheck；无新增 shell 测试。

## 本机验证

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | exit 0，1896 files，14 个原有 unused suppression 警告；本单文件无警告 |
| `node scripts/sync-phase-protocols.mjs --check` | exit 0，3 projections checked |
| `pnpm --filter "flywheel-teamlead..." build` | exit 0，teamlead + 依赖构建；日志包含实际 prebuild 执行 |
| `pnpm --filter flywheel-teamlead typecheck` | exit 0 |
| `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/local-verification-policy.test.ts` | 26/26 PASS |
| `pnpm --filter flywheel-teamlead exec vitest related src/__tests__/local-verification-policy.test.ts --run` | 26/26 PASS |
| `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/AgentDispatcher.test.ts` | 38/38 PASS |
| `git diff --check` | exit 0 |

26 个合同测试覆盖真实文本、精确同步/默认 read-only、漂移/修复/幂等、块外字节不变、8 类 marker 错误、无/空/非法 source、三个缺目标、非法参数、cwd 独立、真实 prebuild 生命周期、每条规则删除及旧全量词回归。负例 mutation 初次删除 `owning package` 只去掉两次出现之一，已修为 replaceAll 并重跑全部绿色。测试显式断言角色红 job 动作紧邻 END marker。

本机未运行全量包测试或全仓构建。本机结果只证明此处定向范围；最终 SHA 和完整 CI job 证据将通过 PR 与 completion/report receipt 记录，不能以本机绿替代。当前没有冻结头的 `ci-full ensure` 注入，不主动请求 full CI；sandbox 的现有 CI workflow 在 PR 触发，需核实 Build & Test 及 payload-distribution 所有 job，红 job 必须处理。QA 拥有后续冻结头验证职责。

## 设计建议处置

- `script-fails-repo-lint-as-written`：保持算法，使用模板字符串和 Biome 格式；本单 lint 通过。
- `role-action-adjacency-unasserted`：增加邻接正/负断言。
- `agentdispatcher-consumer-justification-overstated`：38 个用例验证路由路径兼容，**不读取本次角色正文**；正文证据仅新合同测试提供。
- `sync-script-name-collides-upstream`：保留批准计划/用户指定路径；本 sandbox 是三处本机验证规则同步，未来与现代九投影实现合并时需显式解决语义冲突。
- `prebuild-gate-placed-in-unrelated-package`：保留计划中的 prebuild 接线以不修改 CI workflow；代价为 teamlead 构建也承担仓库 prompt drift gate。建议已在设计阶段报 Lead。

## 消费者选择（每个匹配均列明）

对七个改动源文件分别使用完整路径、文件名、父目录执行 `git grep -lF -- <key>`；下面 Q 编号给出精确查询。索引查询不等同依赖关系，尤其 `scripts`/`package.json` 会匹配大量无关历史文档及其他测试。保留新合同测试与计划指定 AgentDispatcher，其余每个唯一匹配路径及排除原因如下。新文件在 staged 后复查；本记录自引用不作为可执行消费者。

原因码：
- KEEP：新增合同与计划指定路由验证。
- DOC：文档/历史报告/示意资产，非可执行测试。
- PATH：配置或合成 fixture 仅使用角色路径；未读取角色正文，路径/registry 未改。
- OTHER：仅通用父目录/文件名命中，测试其他未改脚本、模块或 manifest；无本单规则/同步器依赖。
- META：未改运行时/打包/配置引用，未直接验证本次规则；manifest 仅增加 prebuild，不改运行时 exports/deps。

- Q1: `.flywheel/agents/engineering/engineer-executor.md` (10 matches)
- Q2: `engineer-executor.md` (13 matches)
- Q3: `.flywheel/agents/engineering` (34 matches)
- Q4: `.flywheel/agents/engineering/qa-executor.md` (12 matches)
- Q5: `qa-executor.md` (34 matches)
- Q6: `.flywheel/agents/general-executor.md` (17 matches)
- Q7: `general-executor.md` (21 matches)
- Q8: `.flywheel/agents` (77 matches)
- Q9: `scripts/lib/local-verification-policy.md` (5 matches)
- Q10: `local-verification-policy.md` (5 matches)
- Q11: `scripts/lib` (140 matches)
- Q12: `scripts/sync-phase-protocols.mjs` (5 matches)
- Q13: `sync-phase-protocols.mjs` (7 matches)
- Q14: `scripts` (876 matches)
- Q15: `packages/teamlead/package.json` (17 matches)
- Q16: `package.json` (135 matches)
- Q17: `packages/teamlead` (605 matches)
- Q18: `packages/teamlead/src/__tests__/local-verification-policy.test.ts` (3 matches)
- Q19: `local-verification-policy.test.ts` (4 matches)
- Q20: `packages/teamlead/src/__tests__` (112 matches)

<details>
<summary>逐项匹配与排除清单</summary>

| 匹配路径 | 查询 | 处置 |
| --- | --- | --- |
| `.claude/commands/orchestrator.md` | Q14, Q17 | DOC |
| `.claude/commands/setup-discord-lead.md` | Q14, Q17 | DOC |
| `.claude/commands/setup-flywheel-hooks.md` | Q14 | DOC |
| `.claude/commands/spin.md` | Q14 | DOC |
| `.claude/orchestrator/lock.sh` | Q14 | META |
| `.claude/qa-config.yaml` | Q17 | META |
| `.flywheel/agents/engineering/engineer-executor.md` | Q14, Q17 | DOC |
| `.flywheel/agents/engineering/qa-executor.md` | Q14 | DOC |
| `.flywheel/agents/general-executor.md` | Q2, Q14 | DOC |
| `.flywheel/config.yaml` | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q14 | META |
| `.github/workflows/ci.yml` | Q11, Q14, Q17 | META |
| `.github/workflows/payload-beta-release.yml` | Q14 | META |
| `.github/workflows/payload-promote.yml` | Q14 | META |
| `.lead/flywheel-eng-lead/identity.md` | Q14 | DOC |
| `.serena/project.yml` | Q14 | META |
| `CLAUDE.md` | Q3, Q8, Q14, Q16, Q17 | DOC |
| `agents/generic-executor.md` | Q8 | DOC |
| `agents/qa-executor.md` | Q5 | DOC |
| `doc/FLY-145-s6-retry-product-test/design-review.md` | Q14 | DOC |
| `doc/FLY-145-s6-retry-product-test/plan.md` | Q14 | DOC |
| `doc/FLY-145-s6-retry-product-test/research.md` | Q17 | DOC |
| `doc/FLY-202-qa-sandbox-fixture/design.md` | Q14 | DOC |
| `doc/FLY-202-qa-sandbox-fixture/plan.md` | Q14 | DOC |
| `doc/architecture/archive/v0.1.0-flywheel-orchestrator.md` | Q16 | DOC |
| `doc/architecture/capability-matrix.md` | Q14, Q17 | DOC |
| `doc/architecture/infra-alerts-spec.md` | Q14, Q17 | DOC |
| `doc/architecture/product-experience-spec.md` | Q17 | DOC |
| `doc/architecture/v0.2-architecture.md` | Q14 | DOC |
| `doc/engineer/deep-research/001-decision-layer-gemini.md` | Q16 | DOC |
| `doc/engineer/deep-research/002-decision-layer-chatgpt.md` | Q14 | DOC |
| `doc/engineer/deep-research/007-parallel-ai-agents-pkarnal.md` | Q14 | DOC |
| `doc/engineer/deep-research/010-ai-agent-frameworks-2026.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/FLY-115-qa-real-runner-support.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/FLY-158-skill-invocation-architecture.md` | Q5, Q8 | DOC |
| `doc/engineer/exploration/archive/FLY-162-lead-thread-routing.md` | Q17 | DOC |
| `doc/engineer/exploration/archive/FLY-163-remove-forum-channel-concept.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/exploration/archive/FLY-168-comm-send-transport-gap.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/FLY-169-cmux-attach-self-heal.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/FLY-20-auto-restart-cd.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/FLY-205-doc-flow-baseline.md` | Q8, Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/FLY-27-triage-deep-optimization.md` | Q17, Q20 | DOC |
| `doc/engineer/exploration/archive/FLY-66-global-qa-framework.md` | Q16 | DOC |
| `doc/engineer/exploration/archive/GEO-149-cipher-decision-memory.md` | Q11, Q14 | DOC |
| `doc/engineer/exploration/archive/GEO-158-jido-directive-fsm.md` | Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-167-runtime-forum-tag-update.md` | Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-168-retry-api-requeue.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-169-completed-post-auto-cleanup.md` | Q17, Q20 | DOC |
| `doc/engineer/exploration/archive/GEO-179-terminal-auto-close.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/GEO-187-lead-agent-behavior-design.md` | Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-198-fix-mem0-memory-layer.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-203-claude-lead-mem0-memory.md` | Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-204-fix-mem0-entity-mapping.md` | Q17, Q20 | DOC |
| `doc/engineer/exploration/archive/GEO-205-claude-lead-agent-identity.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/GEO-206-phase2-lead-proactive-comm.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-234-lead-agent-behavior-config.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-246-multi-lead-architecture.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-262-lead-tmux-visibility.md` | Q15, Q16, Q17, Q20 | DOC |
| `doc/engineer/exploration/archive/GEO-266-runner-inbox-polling.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/GEO-267-lead-auto-start-runner.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-276-pm-auto-triage.md` | Q17, Q20 | DOC |
| `doc/engineer/exploration/archive/GEO-286-lead-workspace-project-dir.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/GEO-288-daily-standup.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/archive/v0.1.1-interactive-runner-architecture.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/v0.2-parallel-execution.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/v0.2-skill-system.md` | Q14 | DOC |
| `doc/engineer/exploration/archive/v0.4-teamlead-agent.md` | Q11, Q14, Q16, Q17 | DOC |
| `doc/engineer/exploration/archive/v0.5-steipete-ecosystem.md` | Q14 | DOC |
| `doc/engineer/exploration/new/FLY-142-changeset-summary.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/new/FLY-142-option4-detail.md` | Q17 | DOC |
| `doc/engineer/exploration/new/FLY-143-lead-mcp-scope-audit.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/exploration/new/FLY-152-shared-channel-reply-audit.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/new/FLY-152-ship-options.md` | Q14 | DOC |
| `doc/engineer/exploration/new/FLY-159-gate-timeout-rethink.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/exploration/new/FLY-161-runner-ask-bridge-event.md` | Q17, Q20 | DOC |
| `doc/engineer/exploration/new/FLY-21-simba-triage-perf.md` | Q17, Q20 | DOC |
| `doc/engineer/exploration/new/FLY-214-global-skill-framework.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/new/FLY-270-self-onboard.md` | Q14 | DOC |
| `doc/engineer/exploration/new/FLY-285-mufasa-belle-coe.md` | Q8, Q17 | DOC |
| `doc/engineer/exploration/new/FLY-286-xiaohongshu-learning-applied.md` | Q14, Q17 | DOC |
| `doc/engineer/exploration/new/FLY-443-xiaohongshu-deep-learning-skill.md` | Q14 | DOC |
| `doc/engineer/exploration/new/FLY-510-global-notion-integration.md` | Q14 | DOC |
| `doc/engineer/exploration/new/FLY-594-wolf-gemma-challenge-autonomy.md` | Q17 | DOC |
| `doc/engineer/exploration/new/FLY-604-role-based-executors.md` | Q2, Q3, Q5, Q6, Q7, Q8 | DOC |
| `doc/engineer/exploration/new/FLY-616-eval-output-quality.md` | Q14 | DOC |
| `doc/engineer/exploration/new/FLY-626-state-aware-stall-watchdog.md` | Q17 | DOC |
| `doc/engineer/exploration/new/FLY-637-watchdog-backoff-fingerprint-quiet-registry.md` | Q17 | DOC |
| `doc/engineer/exploration/new/FLY-663-statestore-wasm-corruption-root-cause.md` | Q17 | DOC |
| `doc/engineer/exploration/new/FLY-742-cron-stale-session-guard.md` | Q14 | DOC |
| `doc/engineer/exploration/new/FLY-NEW-cleanup-sessions-thread-id.md` | Q17 | DOC |
| `doc/engineer/exploration/new/GEO-223-runner-safety-claudemd-templates.md` | Q14 | DOC |
| `doc/engineer/exploration/new/v0.5-remote-screenshot.md` | Q14, Q16, Q17 | DOC |
| `doc/engineer/exploration/new/v1.27.0-FLY-137-runner-pipeline-gaps-audit.md` | Q7, Q8, Q17 | DOC |
| `doc/engineer/implementation/FLY-182-track-a-ship-checklist.md` | Q14 | DOC |
| `doc/engineer/implementation/FLY-222-a0-a10-runbook.md` | Q14 | DOC |
| `doc/engineer/implementation/FLY-224-phase-0a-contract-freeze.md` | Q17 | DOC |
| `doc/engineer/implementation/FLY-259-mufasa-tui-cutover-runbook.md` | Q14, Q17 | DOC |
| `doc/engineer/implementation/FLY-260-mufasa-read-deny-cutover-runbook.md` | Q14, Q17 | DOC |
| `doc/engineer/implementation/FLY-503-xhs-deep-consolidation.md` | Q14 | DOC |
| `doc/engineer/implementation/codex-log-bloat-guard.md` | Q14 | DOC |
| `doc/engineer/implementation/companion-lead-single-process.md` | Q14, Q17 | DOC |
| `doc/engineer/implementation/fly-1023-buddy-onboarding-runbook.md` | Q14 | DOC |
| `doc/engineer/implementation/fly-1062-payload-release-runbook.md` | Q14 | DOC |
| `doc/engineer/implementation/fly-247-fleet-migration.md` | Q14 | DOC |
| `doc/engineer/implementation/ponytail-setup.md` | Q14 | DOC |
| `doc/engineer/implementation/restart-guard.md` | Q14 | DOC |
| `doc/engineer/implementation/v0.4-step1-teamlead-integration-test.md` | Q17 | DOC |
| `doc/engineer/implementation/v1.27.0-FLY-142-spike-results.md` | Q14 | DOC |
| `doc/engineer/onboarding/lead-mcp-setup.md` | Q14, Q17 | DOC |
| `doc/engineer/onboarding/new-project-flywheel-setup.md` | Q6, Q7, Q8 | DOC |
| `doc/engineer/onboarding/tidal-echo/CUTOVER.md` | Q8, Q14 | DOC |
| `doc/engineer/onboarding/tidal-echo/README.md` | Q14 | DOC |
| `doc/engineer/onboarding/tidal-echo/config.yaml` | Q8 | DOC |
| `doc/engineer/plan/archive/v0.1.1-interactive-runner.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v0.2-step1-infrastructure.md` | Q14, Q16 | DOC |
| `doc/engineer/plan/archive/v0.2-step2-integration.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v0.2-step2b-decision-layer.md` | Q14, Q16 | DOC |
| `doc/engineer/plan/archive/v0.2-step2c-notifications.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v0.2-step3-parallel-execution.md` | Q11, Q14 | DOC |
| `doc/engineer/plan/archive/v0.3-step1-memory-system-backlog.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v0.3-step1-memory-system.md` | Q11, Q14, Q16 | DOC |
| `doc/engineer/plan/archive/v0.4-step1-teamlead-agent.md` | Q11, Q14, Q15, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v0.4-step2-teamlead-brain.md` | Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v0.5-step1-openclaw-bridge.md` | Q15, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.0-GEO-155-disable-auto-approve.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.0-phase1-lead-mvp.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.1.0-GEO-145-memory-production-setup.md` | Q11, Q14, Q16 | DOC |
| `doc/engineer/plan/archive/v1.10.0-GEO-234-lead-agent-behavior-config.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.10.0-GEO-252-bridge-per-lead-bot-token.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.10.0-GEO-253-forum-tag-config.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.11.0-GEO-259-lead-data-isolation.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.11.0-GEO-262-lead-tmux-visibility.md` | Q15, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.12.0-GEO-260-lead-response-tuning.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.12.0-GEO-266-runner-inbox-hook.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.13.0-GEO-267-lead-auto-start-runner.md` | Q11, Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.13.0-GEO-270-runner-tmux-cleanup.md` | Q14, Q16 | DOC |
| `doc/engineer/plan/archive/v1.14.0-GEO-270-stale-session-patrol.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.15.0-GEO-275-pm-lead-simba-core-channel.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.15.0-GEO-277-runner-terminal-auto-open.md` | Q11, Q14 | DOC |
| `doc/engineer/plan/archive/v1.16.0-GEO-276-pm-auto-triage.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.16.0-GEO-291-flywheel-orchestrator.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.17.0-GEO-200-forum-thread-link-fix.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.17.0-GEO-280-sprint-closing.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.17.0-GEO-285-lead-context-window.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.17.0-GEO-286-lead-workspace-project-dir.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.17.0-GEO-288-daily-standup.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.17.0-GEO-294-triage-html-report.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.17.0-GEO-296-fork-claude-plugins.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.17.0-GEO-298-linear-team-reorg.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.18.0-FLY-11-terminal-mcp-tool.md` | Q14, Q16, Q17 | DOC |
| `doc/engineer/plan/archive/v1.18.0-FLY-20-auto-restart-cd.md` | Q11, Q14, Q16, Q17 | DOC |
| `doc/engineer/plan/archive/v1.18.0-FLY-20-discord-plugin-detection.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.18.0-FLY-26-lead-rules-scalability.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.18.0-FLY-27-triage-html-template.md` | Q15, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.18.0-GEO-203-claude-lead-mem0-memory.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.18.0-GEO-292-lead-orchestration.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.2.0-GEO-149-cipher-decision-memory.md` | Q11, Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.2.0-GEO-157-adapter-protocol-heartbeat.md` | Q11, Q14 | DOC |
| `doc/engineer/plan/archive/v1.2.0-GEO-158-jido-directive-fsm.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.2.0-GEO-163-slack-discord-migration.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.21.0-FLY-66-global-qa-framework.md` | Q5, Q14, Q16 | DOC |
| `doc/engineer/plan/archive/v1.22.0-FLY-59-session-role-lane.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.22.0-FLY-86-pipeline-fixes.md` | Q11, Q14 | DOC |
| `doc/engineer/plan/archive/v1.22.0-FLY-92-runner-idle-watchdog.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.23.0-FLY-102-lead-driven-runner-lifecycle.md` | Q14, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.23.0-FLY-102-runner-bash-timeout.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.23.0-FLY-108-session-status-flip.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.23.0-FLY-109-lead-resume-inbox.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.23.0-FLY-99-runner-residual-worktree.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.24.0-FLY-115-qa-real-runner-support.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.24.1-FLY-115-fix-runner-trust.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.24.2-FLY-115-test-env-gaps.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.25.0-FLY-110-cmux-sync-pane-exited-cleanup.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.25.0-FLY-116-runner-terminal-auto-close.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.25.0-FLY-128-terminal-spawn-consistency.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.25.0-FLY-129-cmux-ipc-fix.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.25.0-FLY-60-hard-gate-e2e.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.25.0-FLY-77-remove-discord-control-channel.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.27.0-FLY-152-lead-reply-discipline.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.27.0-FLY-153-framework-mirror-channel.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.27.1-FLY-142-agent-team-full-mirror-vendor-neutral.md` | Q14, Q16, Q17 | DOC |
| `doc/engineer/plan/archive/v1.27.2-FLY-137-runner-agent-dispatch.md` | Q5, Q6, Q7, Q8, Q14, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.27.2-FLY-158-skill-disable-model-invocation.md` | Q8, Q14, Q16 | DOC |
| `doc/engineer/plan/archive/v1.28.0-FLY-129-cmux-integration-overhaul.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.28.0-FLY-159-gate-timeout-48h.md` | Q14, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.28.0-FLY-162-lead-thread-routing.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.28.0-FLY-163-remove-forum-concept.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.28.0-GEO-151-proofshot-integration.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.28.2-FLY-168-comm-send-mailbox-dual-write.md` | Q16 | DOC |
| `doc/engineer/plan/archive/v1.28.3-FLY-169-cmux-attach-self-heal.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.29.0-FLY-172-runner-heartbeat-orphan.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.29.0-FLY-173-routing-guard-core-exempt.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.29.x-FLY-175-founder-consent-hard-gate.md` | Q14, Q15, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.3.0-GEO-149-cipher-decision-memory.md` | Q11, Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.3.0-GEO-167-runtime-forum-tag-update.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.3.0-GEO-168-retry-api-requeue.md` | Q11, Q14, Q15, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.3.0-GEO-169-completed-post-auto-cleanup.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.3.0-GEO-175-cicd-pipeline.md` | Q16 | DOC |
| `doc/engineer/plan/archive/v1.3.0-GEO-179-terminal-auto-close.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.3.0-GEO-204-fix-mem0-entity-mapping.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.32.0-FLY-203-remote-report-pipeline.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.33.0-FLY-205-doc-flow-baseline.md` | Q8, Q11, Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.35.0-FLY-217-superpowers-rpc-default.md` | Q8 | DOC |
| `doc/engineer/plan/archive/v1.39.0-FLY-224-vendor-pluggable-lead.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.4.0-GEO-152-multi-lead-routing.md` | Q11, Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.40.0-FLY-247-fleet-config-dashboard.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.41.0-FLY-247-fleet-console.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.42.0-FLY-245-codex-lead-founder-gate.md` | Q17 | DOC |
| `doc/engineer/plan/archive/v1.47.0-FLY-270-self-onboard.md` | Q3, Q7, Q8, Q14, Q16, Q17 | DOC |
| `doc/engineer/plan/archive/v1.49.0-FLY-350-mufasa-unconfine-option1-full-lead.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.5.0-GEO-187-lead-agent-behavior-design.md` | Q11, Q14, Q15, Q16, Q17 | DOC |
| `doc/engineer/plan/archive/v1.5.0-GEO-198-fix-mem0-memory-layer.md` | Q11, Q14, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.51.0-FLY-350-generic-codex-full-access-backend.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.56.0-FLY-529-qa-room-mirrors.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.58.0-FLY-583-enforcer-silent-auto-execute.md` | Q14 | DOC |
| `doc/engineer/plan/archive/v1.6.0-GEO-195-claude-discord-lead-runtime.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.7.0-GEO-203-claude-lead-mem0-memory.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/archive/v1.7.0-GEO-205-claude-lead-agent-identity.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.8.0-GEO-206-lead-runner-bidirectional-comm.md` | Q11, Q14, Q16, Q17 | DOC |
| `doc/engineer/plan/archive/v1.9.0-GEO-206-phase2-lead-proactive-comm.md` | Q14, Q16, Q17 | DOC |
| `doc/engineer/plan/archive/v1.9.0-GEO-246-multi-lead-architecture.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v1.9.1-GEO-269-tmux-session-naming.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/archive/v2.0-FLY-123-vendor-neutral-agent-runtime.md` | Q8, Q14, Q17 | DOC |
| `doc/engineer/plan/backlog/v0.6-step1-workflow-config.md` | Q11, Q14 | DOC |
| `doc/engineer/plan/backlog/v0.6-step2-dashboard.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/backlog/v0.6-step3-land-skill.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/plan/backlog/v1.27.1-FLY-137-runner-agent-dispatch.md` | Q7, Q8, Q14, Q16, Q17, Q20 | DOC |
| `doc/engineer/plan/draft/v1.48.0-FLY-292-chat-thread-archive-reliability.md` | Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.22.0-FLY-43-restart-services-fix.md` | Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.22.0-FLY-44-lead-force-close.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/inprogress/v1.22.0-FLY-88-cmux-integration.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.22.0-FLY-88-cmux-workspace-sync.md` | Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.22.0-FLY-91-discord-thread-reply.md` | Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.23.0-FLY-90-gbrain-wiki-deployment.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.23.0-FLY-95-runner-worktree-isolation.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/inprogress/v1.23.0-FLY-98-cmux-auto-sync.md` | Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.26.0-FLY-143-lead-mcp-inherit.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.28.1-FLY-161-runner-question-event.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/inprogress/v1.29.4-FLY-177-cmux-watcher-launchd.md` | Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.30.0-FLY-178-executor-routing-by-work-type.md` | Q8, Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.30.1-FLY-183-discord-adapter-orphan-reap.md` | Q11, Q14, Q16, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.31.0-FLY-182-queue-delivery.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/inprogress/v1.35.0-FLY-216-flywheel-skills-capability-library.md` | Q11, Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.36.1-FLY-228-229-runner-lifecycle.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.36.2-FLY-222-xiaohongshu-periodic-learning.md` | Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.43.0-FLY-254-cmux-reopen-reattach-sweep.md` | Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.44.0-FLY-253-runner-stuck-false-positive.md` | Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.48.0-FLY-286-xiaohongshu-learning-applied.md` | Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.49.0-FLY-284-from-scratch-onboard.md` | Q8, Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.49.0-FLY-285-mufasa-coe.md` | Q8, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.49.0-FLY-307-gatepoller-wedge-fix.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/inprogress/v1.52.0-FLY-371-projectname-linear-mapping.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/inprogress/v1.52.0-FLY-387-lead-outbound-reply-malformation-guard.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.54.0-FLY-493-antigravity-runner-backend.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.55.0-FLY-368-unified-alert-channel-autofix-bot.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.55.0-FLY-494-kimi-runner-backend.md` | Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.55.1-FLY-513-codex-global-binary-stability.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.56.0-FLY-510-global-notion-integration.md` | Q14 | DOC |
| `doc/engineer/plan/inprogress/v1.56.0-FLY-516-bridge-restart-port-hardening.md` | Q11, Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/inprogress/v1.58.0-FLY-369-lead-relay-wake-patrol-followup.md` | Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.58.0-FLY-569-roundtable-reply-in-thread-default-on.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.58.0-FLY-676-roundtable-thread-reply-discipline.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.59.0-FLY-576-roundtable-thread-membership.md` | Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.59.0-FLY-615-ponytail-per-project-rollout.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.60.0-FLY-560-runner-attach-pin.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.60.0-FLY-576-roundtable-reply-surface.md` | Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.60.0-FLY-579-global-auto-qa-pipeline.md` | Q3, Q4, Q5, Q8, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.61.0-FLY-616-eval-output-quality.md` | Q14, Q16 | DOC |
| `doc/engineer/plan/inprogress/v1.61.0-FLY-639-statestore-corruption-crashloop.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.61.0-FLY-643-auto-qa-separate-issue.md` | Q5, Q17 | DOC |
| `doc/engineer/plan/inprogress/v1.63.0-FLY-720-crash-runner-liveness-reaper.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/new/v0.1.0-FLY-358-shared-writing-skill.md` | Q14 | DOC |
| `doc/engineer/plan/new/v0.2.0-FLY-443-xiaohongshu-deep-learning-skill.md` | Q14 | DOC |
| `doc/engineer/plan/new/v1.23.0-FLY-83-lead-daemon-stuck.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/new/v1.37.0-FLY-231-onboard-mufasa-belle.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/new/v1.47.0-FLY-398-codex-lead-mcp-approval-windowed.md` | Q14 | DOC |
| `doc/engineer/plan/new/v1.48.0-FLY-282-roundtable-allowbots-selfheal.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/new/v1.49.0-FLY-260-codex-lead-read-deny.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/new/v1.49.0-FLY-286-web-local-review-route.md` | Q17 | DOC |
| `doc/engineer/plan/new/v1.50.0-FLY-286-pipeline-wiring.md` | Q16 | DOC |
| `doc/engineer/plan/new/v1.51.0-FLY-360-lead-1m-context-tier.md` | Q14, Q17, Q20 | DOC |
| `doc/engineer/plan/new/v1.56.0-FLY-368-ownership-rework.md` | Q14 | DOC |
| `doc/engineer/plan/new/v1.56.0-FLY-742-cron-stale-session-guard.md` | Q17 | DOC |
| `doc/engineer/plan/new/v1.57.0-FLY-519-fleet-provisioning.md` | Q11, Q14 | DOC |
| `doc/engineer/plan/new/v1.58.0-FLY-637-watchdog-quiet-refinement.md` | Q17 | DOC |
| `doc/engineer/plan/new/v1.58.0-FLY-650-portable-provisioning.md` | Q11, Q14 | DOC |
| `doc/engineer/plan/new/v1.58.0-FLY-663-statestore-better-sqlite3-migration.md` | Q17, Q20 | DOC |
| `doc/engineer/plan/new/v1.58.0-FLY-671-per-project-model-effort.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/new/v1.60.0-FLY-626-token-frugal-state-aware-watchdog.md` | Q17 | DOC |
| `doc/engineer/plan/new/v2.0-FLY-31-flywheel-next-gen-architecture.md` | Q14, Q17 | DOC |
| `doc/engineer/plan/new/v2.1-FLY-52-product-experience-implementation.md` | Q17 | DOC |
| `doc/engineer/qa/FLY-312-fly307-validation/report.md` | Q14, Q17 | DOC |
| `doc/engineer/qa/FLY-695-lead-pending-escalation-real-discord-e2e/report.md` | Q14, Q17 | DOC |
| `doc/engineer/research/archive/FLY-102-lead-driven-runner-lifecycle.md` | Q17 | DOC |
| `doc/engineer/research/archive/FLY-11-terminal-mcp-tool.md` | Q16 | DOC |
| `doc/engineer/research/archive/FLY-115-qa-real-runner-support.md` | Q14, Q16 | DOC |
| `doc/engineer/research/archive/FLY-129-cmux-ipc-rootcause.md` | Q14 | DOC |
| `doc/engineer/research/archive/FLY-147-codebase-audit.md` | Q14, Q17 | DOC |
| `doc/engineer/research/archive/FLY-168-mailbox-wake-mechanism.md` | Q17 | DOC |
| `doc/engineer/research/archive/FLY-169-cmux-attach-detection.md` | Q14 | DOC |
| `doc/engineer/research/archive/FLY-191-stale-awaiting-review-cleanup.md` | Q17 | DOC |
| `doc/engineer/research/archive/FLY-193-lead-freeze-detect-and-idle-suppress.md` | Q14, Q17 | DOC |
| `doc/engineer/research/archive/FLY-20-auto-restart-cd.md` | Q14, Q16, Q17 | DOC |
| `doc/engineer/research/archive/FLY-20-auto-restart-trigger.md` | Q14 | DOC |
| `doc/engineer/research/archive/FLY-203-remote-report-pipeline.md` | Q17 | DOC |
| `doc/engineer/research/archive/FLY-205-doc-flow-baseline.md` | Q8, Q14, Q17 | DOC |
| `doc/engineer/research/archive/FLY-208-post-completion-feedback-loop.md` | Q8 | DOC |
| `doc/engineer/research/archive/FLY-217-superpowers-rpc-default.md` | Q8, Q17 | DOC |
| `doc/engineer/research/archive/FLY-529-qa-room-roundtable-alerts.md` | Q14, Q17 | DOC |
| `doc/engineer/research/archive/FLY-66-qa-framework-extraction.md` | Q5, Q14, Q16, Q17 | DOC |
| `doc/engineer/research/archive/GEO-145-supabase-pgvector-migration.md` | Q11, Q14, Q16 | DOC |
| `doc/engineer/research/archive/GEO-149-cipher-knowledge-architecture.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/research/archive/GEO-152-multi-lead-routing.md` | Q17, Q20 | DOC |
| `doc/engineer/research/archive/GEO-157-adapter-unification-codebase-analysis.md` | Q17 | DOC |
| `doc/engineer/research/archive/GEO-158-fsm-directive-implementation.md` | Q17 | DOC |
| `doc/engineer/research/archive/GEO-163-discord-migration-research.md` | Q15, Q16, Q17 | DOC |
| `doc/engineer/research/archive/GEO-175-cicd-pipeline-implementation.md` | Q16, Q17 | DOC |
| `doc/engineer/research/archive/GEO-179-terminal-auto-close.md` | Q14 | DOC |
| `doc/engineer/research/archive/GEO-198-fix-mem0-memory-layer.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/research/archive/GEO-203-claude-lead-mem0-memory.md` | Q14, Q17 | DOC |
| `doc/engineer/research/archive/GEO-206-phase2-lead-proactive-comm.md` | Q14, Q16, Q17 | DOC |
| `doc/engineer/research/archive/GEO-246-multi-lead-architecture.md` | Q14 | DOC |
| `doc/engineer/research/archive/GEO-261-session-completed-missing.md` | Q14 | DOC |
| `doc/engineer/research/archive/GEO-262-lead-tmux-visibility.md` | Q15, Q16, Q17 | DOC |
| `doc/engineer/research/archive/GEO-267-lead-auto-start-runner.md` | Q11, Q14, Q17, Q20 | DOC |
| `doc/engineer/research/archive/GEO-270-runner-tmux-cleanup.md` | Q17 | DOC |
| `doc/engineer/research/archive/GEO-275-pm-lead-simba-core-channel.md` | Q14, Q17 | DOC |
| `doc/engineer/research/archive/GEO-292-lead-orchestration-patterns.md` | Q17, Q20 | DOC |
| `doc/engineer/research/archive/GEO-296-fork-sync-strategy.md` | Q16 | DOC |
| `doc/engineer/research/archive/v0.1.0-decision-layer-cross-reference.md` | Q16 | DOC |
| `doc/engineer/research/archive/v0.5-openclaw-pivot-codebase-research.md` | Q17 | DOC |
| `doc/engineer/research/new/007-remote-execution-eval.md` | Q16 | DOC |
| `doc/engineer/research/new/FLY-105-digest-layer-between-raw-records-and-gbrain.md` | Q14 | DOC |
| `doc/engineer/research/new/FLY-129-cmux-research-followup.md` | Q14 | DOC |
| `doc/engineer/research/new/FLY-129-refresh-surfaces-spike.md` | Q14 | DOC |
| `doc/engineer/research/new/FLY-188-claude-in-chrome-screenshot-persistence.md` | Q14, Q16, Q17 | DOC |
| `doc/engineer/research/new/FLY-222-xiaohongshu-learning-feasibility.md` | Q14 | DOC |
| `doc/engineer/research/new/FLY-224-codex-as-lead-feasibility.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-253-runner-stuck-false-positive-audit.md` | Q17 | DOC |
| `doc/engineer/research/new/FLY-270-self-onboard.md` | Q11, Q14, Q16, Q17 | DOC |
| `doc/engineer/research/new/FLY-284-from-scratch-onboard.md` | Q8, Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-285-mufasa-coe-architecture.md` | Q8 | DOC |
| `doc/engineer/research/new/FLY-286-xiaohongshu-learning-applied.md` | Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-349-xiaohongshu-v2-deep-parallel.md` | Q14 | DOC |
| `doc/engineer/research/new/FLY-358-shared-writing-skill.md` | Q14 | DOC |
| `doc/engineer/research/new/FLY-443-fly349-engine-packaging-audit.md` | Q14 | DOC |
| `doc/engineer/research/new/FLY-510-notion-integration-mechanics.md` | Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-512-codex-long-running-work.md` | Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-519-fleet-provisioning-audit.md` | Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-576-roundtable-thread-membership.md` | Q17 | DOC |
| `doc/engineer/research/new/FLY-579-pipeline-mechanism-audit.md` | Q3, Q4, Q5, Q8 | DOC |
| `doc/engineer/research/new/FLY-614-token-attribution-feasibility.md` | Q17 | DOC |
| `doc/engineer/research/new/FLY-615-ponytail-integration.md` | Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-616-eval-reuse-audit.md` | Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-650-portable-provisioning-audit.md` | Q11, Q14, Q17 | DOC |
| `doc/engineer/research/new/FLY-742-cron-stale-session-guard.md` | Q17 | DOC |
| `doc/engineer/research/new/v1.27.2-FLY-137-geoforge3d-agents-audit.md` | Q5, Q6, Q7, Q8 | DOC |
| `doc/plan/archive/v1.21.0-FLY-47-channel-contract.md` | Q11, Q14, Q15, Q16, Q17 | DOC |
| `doc/qa/FLY-670-ponytail-live-e2e-report.md` | Q14 | DOC |
| `doc/qa/FLY-704-fly694-bash32-reexec-guard-report.md` | Q14, Q17 | DOC |
| `doc/qa/FLY-705-codex-log-guard-qa-report.md` | Q14 | DOC |
| `doc/qa/FLY-706-token-delivery-qa-report.md` | Q11, Q14 | DOC |
| `doc/qa/FLY-710-fly707-enablement-qa-report.md` | Q14, Q17 | DOC |
| `doc/qa/exploration/archived/FLY-47/analyst-notes.md` | Q17 | DOC |
| `doc/qa/framework/dependency-build-policy.md` | Q14, Q16 | DOC |
| `doc/qa/framework/real-runner-e2e-guide.md` | Q14 | DOC |
| `doc/qa/framework/sandbox-sync-guide.md` | Q14 | DOC |
| `doc/qa/manual/GEO-151-L3-windows.md` | Q14, Q17 | DOC |
| `doc/qa/plan/archived/v1.21.0-FLY-47-qa-spec.md` | Q14 | DOC |
| `doc/qa/reports/v1.24.0-FLY-108-round2-qa-report.md` | Q17, Q20 | DOC |
| `doc/qa/reports/v1.24.2-FLY-108-round3-qa-report.md` | Q14 | DOC |
| `doc/qa/reports/v1.24.3-FLY-108-round4-qa-report.md` | Q14 | DOC |
| `doc/qa/reports/v1.24.4-FLY-108-round5-qa-report.md` | Q14, Q17 | DOC |
| `doc/qa/reports/v1.24.5-FLY-108-round6-qa-report.md` | Q14 | DOC |
| `doc/qa/reports/v1.24.5-FLY-109-round1-qa-report.md` | Q14 | DOC |
| `doc/qa/reports/v1.24.5-FLY-83-round1-qa-report.md` | Q14, Q17 | DOC |
| `doc/qa/reports/v1.24.5-FLY-99-round1-qa-report.md` | Q14, Q17 | DOC |
| `doc/qa/reports/v1.25.0-FLY-60-hard-gate-e2e-report.md` | Q14 | DOC |
| `doc/qa/reports/v1.25.0-FLY-77-discord-cleanup-evidence/README.md` | Q14 | DOC |
| `doc/qa/reports/v1.27.0-FLY-127-r3-replay-test.md` | Q17, Q20 | DOC |
| `doc/qa/reports/v1.44.0-FLY-259-qa-report.md` | Q14, Q17 | DOC |
| `doc/qa/sandbox-notes.md` | Q5, Q14 | DOC |
| `doc/qa/test-plans/FLY-259-codex-tui-qa-handoff.md` | Q14, Q17 | DOC |
| `doc/reference/cyrus-contract-snapshot.md` | Q16 | DOC |
| `doc/reference/discord-bot-pool-claim-guide.md` | Q11, Q14 | DOC |
| `docs/CONTRIB.md` | Q14, Q16 | DOC |
| `docs/RUNBOOK.md` | Q17 | DOC |
| `docs/operations/bridge-daemon-management.md` | Q14, Q17 | DOC |
| `docs/operations/fleet-provisioning-runbook.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-1005-multi-machine/prd.md` | Q17 | DOC |
| `engineering/doc/FLY-1006-eleven-product-e2e/design-review-round1.md` | Q14 | DOC |
| `engineering/doc/FLY-1006-eleven-product-e2e/design-review-round2.md` | Q14 | DOC |
| `engineering/doc/FLY-1006-eleven-product-e2e/evidence/qa-fix-round3.md` | Q17 | DOC |
| `engineering/doc/FLY-1006-eleven-product-e2e/plan.md` | Q16 | DOC |
| `engineering/doc/FLY-1018-gemini-advanced-build/design-review-round1.md` | Q17 | DOC |
| `engineering/doc/FLY-1018-gemini-advanced-build/design-review-round2.md` | Q17 | DOC |
| `engineering/doc/FLY-1018-gemini-advanced-build/design-review-round3.md` | Q17 | DOC |
| `engineering/doc/FLY-1018-gemini-advanced-build/harness-evidence.md` | Q14 | DOC |
| `engineering/doc/FLY-1018-gemini-advanced-build/plan.md` | Q14, Q16, Q17 | DOC |
| `engineering/doc/FLY-1018-gemini-advanced-build/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1020-workflow-templates/codex-review-r1.md` | Q17 | DOC |
| `engineering/doc/FLY-1020-workflow-templates/codex-review-r2.md` | Q17 | DOC |
| `engineering/doc/FLY-1020-workflow-templates/codex-review-r3.md` | Q17 | DOC |
| `engineering/doc/FLY-1020-workflow-templates/codex-review-r4.md` | Q17 | DOC |
| `engineering/doc/FLY-1020-workflow-templates/codex-review-r6.md` | Q17 | DOC |
| `engineering/doc/FLY-1023-buddy-onboarding-build/exploration.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-1023-buddy-onboarding-build/plan.md` | Q11, Q14, Q17 | DOC |
| `engineering/doc/FLY-1023-buddy-onboarding-build/qa-report.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-1023-buddy-onboarding-build/research.md` | Q11, Q14, Q17 | DOC |
| `engineering/doc/FLY-1041-gate-binding-ambiguity/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-1041-gate-binding-ambiguity/qa-evidence/inbound-234-chrome-as-annie.md` | Q17 | DOC |
| `engineering/doc/FLY-1041-gate-binding-ambiguity/qa-evidence/point1-and-card-real.md` | Q17 | DOC |
| `engineering/doc/FLY-1041-gate-binding-ambiguity/qa-report.md` | Q17 | DOC |
| `engineering/doc/FLY-1047-gemini-bargein-opening-qa/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-1048-watchdog-detection-remaining/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1048-watchdog-detection-remaining/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-1048-watchdog-detection-remaining/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1049-fly915-alerts-closeout/exploration.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1049-fly915-alerts-closeout/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-1049-fly915-alerts-closeout/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1049-fly915-alerts-closeout/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1050-three-stage-qa-respawn/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-1050-three-stage-qa-respawn/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/exploration.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md` | Q14, Q16, Q17 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/plan.md` | Q5, Q14, Q16, Q17 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/pr2-qa-report.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/pr2-thin-shell.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/pr3-pr4-exploration.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/pr3-pr4-plan.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/pr3-pr4-research.md` | Q11, Q14, Q16 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/progress.md` | Q14 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/qa-report.md` | Q5, Q14, Q17 | DOC |
| `engineering/doc/FLY-1062-npm-distribution/research.md` | Q14, Q16, Q17 | DOC |
| `engineering/doc/FLY-1065-voice-transcript-panel/design-review-delta-round1.md` | Q14 | DOC |
| `engineering/doc/FLY-1065-voice-transcript-panel/design-review-round1.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1065-voice-transcript-panel/design-review-round2.md` | Q17 | DOC |
| `engineering/doc/FLY-1065-voice-transcript-panel/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-1070-qa-respawn-verify/evidence/qa-e2e-harness.mjs` | Q17 | DOC |
| `engineering/doc/FLY-1070-qa-respawn-verify/evidence/qa-f8-harness.mjs` | Q17 | DOC |
| `engineering/doc/FLY-1070-qa-respawn-verify/evidence/step0-build.log` | Q17 | DOC |
| `engineering/doc/FLY-1070-qa-respawn-verify/evidence/step1-unit-rerun.log` | Q17 | DOC |
| `engineering/doc/FLY-1070-qa-respawn-verify/research.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1071-enable-window-closeout/evidence/task0-w4-log-before.txt` | Q17 | DOC |
| `engineering/doc/FLY-1071-enable-window-closeout/evidence/task2-w4-recovered-log.txt` | Q17 | DOC |
| `engineering/doc/FLY-1071-enable-window-closeout/evidence/task6-drill-fire.mjs` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1071-enable-window-closeout/exploration.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1071-enable-window-closeout/plan.md` | Q11, Q14, Q17 | DOC |
| `engineering/doc/FLY-1071-enable-window-closeout/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1081-restart-notify-infra-bot/exploration.md` | Q11, Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-1081-restart-notify-infra-bot/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1081-restart-notify-infra-bot/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1081-restart-notify-infra-bot/research.md` | Q11, Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-1082-fleet-alerts-arc-repair/exploration.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-1082-fleet-alerts-arc-repair/incident-bridge-2329-analysis.md` | Q14 | DOC |
| `engineering/doc/FLY-1082-fleet-alerts-arc-repair/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-1082-fleet-alerts-arc-repair/progress.md` | Q14 | DOC |
| `engineering/doc/FLY-1082-fleet-alerts-arc-repair/qa-report.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-1082-fleet-alerts-arc-repair/research.md` | Q11, Q14, Q17 | DOC |
| `engineering/doc/FLY-1099-founder-reply-ingest-fix/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1116-chrome-pairing-repair/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-1116-chrome-pairing-repair/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/corrections-to-FLY-1082-records.md` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/INDEX.md` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/SHA256SUMS.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/bridge-seg-130918-pre.log` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/bridge-seg-142620-pre.log` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/bridge-seg-144037-pre.log` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/bridge-seg-181658-pre.log` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/bridge-seg-182324-tail.log` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/bridge-seg-210341-pre.log` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/bridge-seg-232959-pre.log` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/scripts-snapshot/com.flywheel.bridge.plist` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/scripts-snapshot/flywheel-bridge-wrapper.DEPLOYED.sh` | Q11, Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/scripts-snapshot/flywheel-bridge-wrapper.sh` | Q11, Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/bridge-launchd-plist.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/bridge-process-tree-and-watchdog-source.txt` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/cmux-autostart-content.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/deployed-vs-repo-scripts.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/e1-lifecycle-rebuild.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/incident-version-scripts-audit.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/kill5-attribution-worktree-activity.txt` | Q17 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/kill5-vitest-trigger-hunt.txt` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/source-facts-wrapper-watchdog.txt` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/step3-suspect-matrix-static-batch1.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/step3-suspect-matrix-static-batch2.txt` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/step7-attack-surface-core.txt` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/tmux-35a-fatal-path-source.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/watchdog-source-bc9c9bfb.txt` | Q17 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/transcripts/watchdog-source-locate.txt` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/forensics-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-1117-forensics-0709-failure-chain/research.md` | Q14 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/acceptance-evidence.md` | Q14 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/codex-design-review-r1.md` | Q14 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/codex-design-review-r2.md` | Q14 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/codex-design-review-r3.md` | Q14 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/evidence-soak-script.mjs` | Q17 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/qa-fly-1142-real-pressure-e2e.mjs` | Q17 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1142-swap-sensor-real-pressure/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1159-gemini-advanced-voice/evidence/sim-diffstat.txt` | Q16 | DOC |
| `engineering/doc/FLY-1159-gemini-advanced-voice/exploration.md` | Q16 | DOC |
| `engineering/doc/FLY-1159-gemini-advanced-voice/handoff.md` | Q16 | DOC |
| `engineering/doc/FLY-1159-gemini-advanced-voice/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-1159-gemini-advanced-voice/qa-report.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-1159-gemini-advanced-voice/research.md` | Q16 | DOC |
| `engineering/doc/FLY-1165-done-thread-archive-reconcile/plan.md` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-1165-done-thread-archive-reconcile/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1178-voice-agent-ecosystem/dr-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1178-voice-agent-ecosystem/evidence/dr-founder-export-raw.txt` | Q14 | DOC |
| `engineering/doc/FLY-1185-worktree-branch-cleanup/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1185-worktree-branch-cleanup/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1185-worktree-branch-cleanup/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1185-worktree-branch-cleanup/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1188-codex-runner-first-class/exploration.md` | Q5 | DOC |
| `engineering/doc/FLY-1188-codex-runner-first-class/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-1188-codex-runner-first-class/qa/orphan-daemon-evidence.txt` | Q14 | DOC |
| `engineering/doc/FLY-1188-codex-runner-first-class/qa/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1188-codex-runner-first-class/research.md` | Q5, Q14 | DOC |
| `engineering/doc/FLY-1188-codex-runner-first-class/t2-daemon-assessment.md` | Q17 | DOC |
| `engineering/doc/FLY-1188-codex-runner-first-class/v1-goal-probe.mjs.txt` | Q15, Q16, Q17 | DOC |
| `engineering/doc/FLY-1189-qa-prc-nton-e2e/design-review/codex-rescue-design-feedback-flywheel-FLY-1189-plan-round1.md` | Q14 | DOC |
| `engineering/doc/FLY-1189-qa-prc-nton-e2e/design-review/codex-rescue-design-feedback-flywheel-FLY-1189-plan-round2.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1189-qa-prc-nton-e2e/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-1189-qa-prc-nton-e2e/plan.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-1189-qa-prc-nton-e2e/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1189-qa-prc-nton-e2e/research.md` | Q14 | DOC |
| `engineering/doc/FLY-1193-oom-alert-debounce/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1193-oom-alert-debounce/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1204-phase-session-leak/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1204-phase-session-leak/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1224-per-phase-vendor/design-review-round1.md` | Q14 | DOC |
| `engineering/doc/FLY-1224-per-phase-vendor/design-review-round3.md` | Q17 | DOC |
| `engineering/doc/FLY-1224-per-phase-vendor/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1224-per-phase-vendor/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1224-per-phase-vendor/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1225-thread-badge-false-done/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1225-thread-badge-false-done/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1232-pr1-claims-substrate/codex-design-round1.md` | Q17 | DOC |
| `engineering/doc/FLY-1232-pr1-claims-substrate/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1232-pr1-claims-substrate/qa-report.md` | Q17 | DOC |
| `engineering/doc/FLY-1232-pr1-claims-substrate/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1234-watchdog-stuck-false-positives/e2e-evidence/qa-fly1234-nton-e2e.mjs` | Q17 | DOC |
| `engineering/doc/FLY-1234-watchdog-stuck-false-positives/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1234-watchdog-stuck-false-positives/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1236-codex-goal-objective-limit/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-1236-codex-goal-objective-limit/qa/tui-death-rootcause.md` | Q14 | DOC |
| `engineering/doc/FLY-1238-founder-message-gate-guard/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1238-founder-message-gate-guard/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1238-founder-message-gate-guard/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1239-tui-rollout-race/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-1239-tui-rollout-race/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-1239-tui-rollout-race/qa/result.md` | Q14 | DOC |
| `engineering/doc/FLY-1239-tui-rollout-race/research.md` | Q14 | DOC |
| `engineering/doc/FLY-1241-read-deny-cleanup/exploration.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1241-read-deny-cleanup/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1241-read-deny-cleanup/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1242-delete-lead-pane-readiness/exploration.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1243-flag-cleanup-batch12/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1244-enforcement-claims-templates/exploration.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1244-enforcement-claims-templates/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1244-enforcement-claims-templates/qa/acceptance-matrix.md` | Q14 | DOC |
| `engineering/doc/FLY-1244-enforcement-claims-templates/qa/mutation-report.md` | Q17 | DOC |
| `engineering/doc/FLY-1244-enforcement-claims-templates/qa/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1244-enforcement-claims-templates/research.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1249-qa-flag-batch12/qa-report.md` | Q16 | DOC |
| `engineering/doc/FLY-1249-qa-flag-batch12/round2-delta.md` | Q14 | DOC |
| `engineering/doc/FLY-1253-review-wait-parking/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1253-review-wait-parking/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-1254-no-verdict-parse-fix/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-1254-no-verdict-parse-fix/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-1254-no-verdict-parse-fix/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1264-reconnect-title-restore/plan.md` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-1264-reconnect-title-restore/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-1264-reconnect-title-restore/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1269-codex-phase-keepalive/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-1269-codex-phase-keepalive/qa/m0-complete-paused-probe.mjs.txt` | Q16 | DOC |
| `engineering/doc/FLY-1269-codex-phase-keepalive/research.md` | Q17 | DOC |
| `engineering/doc/FLY-1286-codex-phase-keepalive-e2e/research.md` | Q17 | DOC |
| `engineering/doc/FLY-202-sandbox-notes-e2e/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-202-sandbox-notes-e2e/research.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-2753-targeted-local-tests/design-review.md` | Q2, Q8, Q12, Q13, Q14, Q17, Q19 | DOC |
| `engineering/doc/FLY-2753-targeted-local-tests/design-verification.md` | Q13 | DOC |
| `engineering/doc/FLY-2753-targeted-local-tests/design.html` | Q14 | DOC |
| `engineering/doc/FLY-2753-targeted-local-tests/exploration.md` | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8 | DOC |
| `engineering/doc/FLY-2753-targeted-local-tests/implementation.md` | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11, Q12, Q13, Q14, Q15, Q16, Q17, Q18, Q19, Q20 | DOC |
| `engineering/doc/FLY-2753-targeted-local-tests/plan.md` | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11, Q12, Q13, Q14, Q15, Q16, Q17, Q18, Q19, Q20 | DOC |
| `engineering/doc/FLY-2753-targeted-local-tests/research.md` | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11, Q14, Q15, Q16, Q17, Q18, Q19, Q20 | DOC |
| `engineering/doc/FLY-293-cmux-stale-pin-reaper/exploration.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-293-cmux-stale-pin-reaper/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-293-cmux-stale-pin-reaper/research.md` | Q14 | DOC |
| `engineering/doc/FLY-353-dag-orchestration/prd.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-543-pluggable-voice-skill/design-review-r2-round1.md` | Q16 | DOC |
| `engineering/doc/FLY-543-pluggable-voice-skill/design-review-round1.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-543-pluggable-voice-skill/plan.md` | Q16 | DOC |
| `engineering/doc/FLY-543-pluggable-voice-skill/progress.md` | Q14 | DOC |
| `engineering/doc/FLY-543-pluggable-voice-skill/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-543-pluggable-voice-skill/research.md` | Q14, Q16, Q17 | DOC |
| `engineering/doc/FLY-545-huddle-mode/evidence/bot-provisioning.md` | Q14 | DOC |
| `engineering/doc/FLY-545-huddle-mode/evidence/qa-pr1-opus-verdict.md` | Q16 | DOC |
| `engineering/doc/FLY-545-huddle-mode/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-545-huddle-mode/plan.md` | Q14, Q16, Q17 | DOC |
| `engineering/doc/FLY-545-huddle-mode/research.md` | Q14 | DOC |
| `engineering/doc/FLY-546-headphone-mode/design-review-round1.md` | Q17 | DOC |
| `engineering/doc/FLY-546-headphone-mode/plan.md` | Q14, Q16, Q17 | DOC |
| `engineering/doc/FLY-546-headphone-mode/qa-report.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-546-headphone-mode/research.md` | Q17 | DOC |
| `engineering/doc/FLY-648-portable-product/exploration.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-648-portable-product/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-648-portable-product/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-685-close-runner-stale-pin/exploration.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-685-close-runner-stale-pin/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-696-account-self-heal/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-696-account-self-heal/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-709-fleet-flag-console/plan-p5-unified-console.md` | Q17 | DOC |
| `engineering/doc/FLY-709-fleet-flag-console/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-709-fleet-flag-console/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-725-founder-milestone-report/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-725-founder-milestone-report/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-727-daily-completion-digest/deploy-events-redesign.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-727-daily-completion-digest/exploration.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-727-daily-completion-digest/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-727-daily-completion-digest/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-728-per-issue-model/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-728-per-issue-model/research.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-744-token-daily-report/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-744-token-daily-report/research.md` | Q14 | DOC |
| `engineering/doc/FLY-751-runner-memory-footprint/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-751-runner-memory-footprint/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-751-runner-memory-footprint/research.md` | Q14 | DOC |
| `engineering/doc/FLY-752-auto-qa-fix-loop/exploration.md` | Q5 | DOC |
| `engineering/doc/FLY-752-auto-qa-fix-loop/plan.md` | Q3, Q4, Q5, Q8 | DOC |
| `engineering/doc/FLY-752-auto-qa-fix-loop/research.md` | Q5 | DOC |
| `engineering/doc/FLY-754-viewer-session-leak/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-754-viewer-session-leak/research.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-755-model-code-front/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-755-model-code-front/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-755-model-code-front/research.md` | Q17 | DOC |
| `engineering/doc/FLY-756-nested-attach-race/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-756-nested-attach-race/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-756-nested-attach-race/research.md` | Q14 | DOC |
| `engineering/doc/FLY-758-cmux-win0-scaffold-pin/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-758-cmux-win0-scaffold-pin/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-766-chrome-lifecycle-reaper/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-788-runner-default-model-opus/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-788-runner-default-model-opus/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-788-runner-default-model-opus/research.md` | Q17 | DOC |
| `engineering/doc/FLY-793-three-stage-agent-split/exploration.md` | Q5 | DOC |
| `engineering/doc/FLY-793-three-stage-agent-split/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-795-restart-resilient-resume/plan.md` | Q16, Q17 | DOC |
| `engineering/doc/FLY-799-founder-approval-self-ship/impl-progress.md` | Q17 | DOC |
| `engineering/doc/FLY-799-founder-approval-self-ship/research.md` | Q17 | DOC |
| `engineering/doc/FLY-802-roundtable-thread-autoarchive/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-807-qa-thread-routing/research.md` | Q17 | DOC |
| `engineering/doc/FLY-812-chrome-default-on/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-812-chrome-default-on/research.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-817-runner-cmux-cleanup-gap/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-817-runner-cmux-cleanup-gap/research.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-818-auto-continue-monitor/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-818-auto-continue-monitor/m3-founder-page-notes.md` | Q17 | DOC |
| `engineering/doc/FLY-825-cmux-dual-attach-restart/exploration.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-825-cmux-dual-attach-restart/plan.md` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-825-cmux-dual-attach-restart/research.md` | Q14 | DOC |
| `engineering/doc/FLY-827-codex-hard-gate/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-827-codex-hard-gate/research.md` | Q17 | DOC |
| `engineering/doc/FLY-846-auto-qa-spawn-guards/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-846-auto-qa-spawn-guards/research.md` | Q17 | DOC |
| `engineering/doc/FLY-859-three-stage-qa-release/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-865-account-switch-identity/plan.md` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-865-account-switch-identity/research.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-867-cmux-tmux-desync-closure/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-867-cmux-tmux-desync-closure/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-867-cmux-tmux-desync-closure/research.md` | Q14 | DOC |
| `engineering/doc/FLY-869-pipeline-discipline/research.md` | Q17 | DOC |
| `engineering/doc/FLY-871-codex-rescue-bot/C6-infra-bot-deployment.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-871-codex-rescue-bot/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-871-codex-rescue-bot/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-871-codex-rescue-bot/qa-report-r2r3.md` | Q17 | DOC |
| `engineering/doc/FLY-871-codex-rescue-bot/qa-report.md` | Q17 | DOC |
| `engineering/doc/FLY-871-codex-rescue-bot/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-879-external-interviewer-bot/deploy-runbook.md` | Q3, Q8, Q14, Q17 | DOC |
| `engineering/doc/FLY-879-external-interviewer-bot/permission-checklist.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-879-external-interviewer-bot/plan.md` | Q3, Q8, Q14, Q17 | DOC |
| `engineering/doc/FLY-879-external-interviewer-bot/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-879-external-interviewer-bot/research.md` | Q3, Q8, Q14, Q17 | DOC |
| `engineering/doc/FLY-880-internal-pm-agent/exploration.md` | Q3, Q8 | DOC |
| `engineering/doc/FLY-880-internal-pm-agent/honey-lemon-deployment-checklist.md` | Q3, Q8, Q14, Q17 | DOC |
| `engineering/doc/FLY-880-internal-pm-agent/plan.md` | Q3, Q8, Q14 | DOC |
| `engineering/doc/FLY-880-internal-pm-agent/qa-report.md` | Q3, Q8, Q14 | DOC |
| `engineering/doc/FLY-880-internal-pm-agent/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-882-discord-bot-token-pool/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-882-discord-bot-token-pool/plan.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-882-discord-bot-token-pool/research.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-883-realtime-voice-research/dr-prompt.md` | Q14 | DOC |
| `engineering/doc/FLY-883-realtime-voice-research/dr-report.md` | Q14 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/activation/README.md` | Q8 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/activation/repoint-876-cron-content.sh` | Q14 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/activation/repoint-876-plists.sh` | Q14 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/activation/swap-asha-launchd.sh` | Q14 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/activation/transform-asha-manifest.sh` | Q8 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/apply/fold-projects.sh` | Q14, Q17 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/exploration.md` | Q8, Q14 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/plan.md` | Q8, Q14, Q17 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/progress.md` | Q14 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/qa-report.md` | Q8, Q14, Q17 | DOC |
| `engineering/doc/FLY-886-sub-fold-tidal-echo/research.md` | Q8, Q14, Q17 | DOC |
| `engineering/doc/FLY-887-phase-session-keepalive/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-887-phase-session-keepalive/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-887-phase-session-keepalive/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-887-phase-session-keepalive/research.md` | Q17 | DOC |
| `engineering/doc/FLY-889-ci-job-timeout-mitigation/plan.md` | Q11, Q14, Q17 | DOC |
| `engineering/doc/FLY-889-ci-job-timeout-mitigation/qa-report.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-889-ci-job-timeout-mitigation/research.md` | Q16 | DOC |
| `engineering/doc/FLY-891-discord-bot-pool-qa-dryrun/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-891-discord-bot-pool-qa-dryrun/plan.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-891-discord-bot-pool-qa-dryrun/qa-result.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-891-discord-bot-pool-qa-dryrun/research.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-892-one-issue-one-thread/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-892-one-issue-one-thread/progress.md` | Q14 | DOC |
| `engineering/doc/FLY-892-one-issue-one-thread/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-898-core-room-reply-gate/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-898-core-room-reply-gate/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-900-remove-founder-ux-gate/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-900-remove-founder-ux-gate/qa-report.md` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-900-remove-founder-ux-gate/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-901-product-designer-dual-register/exploration.md` | Q3, Q8, Q14, Q17 | DOC |
| `engineering/doc/FLY-901-product-designer-dual-register/plan.md` | Q3, Q8, Q14 | DOC |
| `engineering/doc/FLY-901-product-designer-dual-register/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-901-product-designer-dual-register/research.md` | Q3, Q8, Q14 | DOC |
| `engineering/doc/FLY-907-thread-display-refresh/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-907-thread-display-refresh/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-907-thread-display-refresh/research.md` | Q17 | DOC |
| `engineering/doc/FLY-910-onboarding/prd.md` | Q14 | DOC |
| `engineering/doc/FLY-913-restart-guard-hook/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-913-restart-guard-hook/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-913-restart-guard-hook/qa-report.md` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-913-restart-guard-hook/qa/qa_bypass.py` | Q14 | DOC |
| `engineering/doc/FLY-913-restart-guard-hook/qa/qa_matrix.py` | Q14 | DOC |
| `engineering/doc/FLY-913-restart-guard-hook/research.md` | Q14 | DOC |
| `engineering/doc/FLY-921-three-stage-turn-belt/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-921-three-stage-turn-belt/plan.md` | Q17, Q20 | DOC |
| `engineering/doc/FLY-921-three-stage-turn-belt/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-921-three-stage-turn-belt/research.md` | Q14 | DOC |
| `engineering/doc/FLY-927-alert-ticket-queue/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-927-alert-ticket-queue/plan.md` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-927-alert-ticket-queue/research.md` | Q14 | DOC |
| `engineering/doc/FLY-929-profile-autoswitch-notify-migration/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-929-profile-autoswitch-notify-migration/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-939-wake-not-respawn/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-939-wake-not-respawn/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-939-wake-not-respawn/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-939-wake-not-respawn/research.md` | Q17 | DOC |
| `engineering/doc/FLY-944-shared-channel-mention-gating/exploration.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-944-shared-channel-mention-gating/plan.md` | Q14, Q17, Q20 | DOC |
| `engineering/doc/FLY-944-shared-channel-mention-gating/qa-report.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-944-shared-channel-mention-gating/research.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-945-founder-approve-self-ship/plan.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-945-founder-approve-self-ship/qa-report.md` | Q17 | DOC |
| `engineering/doc/FLY-945-founder-approve-self-ship/research.md` | Q17 | DOC |
| `engineering/doc/FLY-954-provision-sandbox-escape/exploration.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-954-provision-sandbox-escape/plan.md` | Q11, Q14, Q17 | DOC |
| `engineering/doc/FLY-954-provision-sandbox-escape/progress.md` | Q17 | DOC |
| `engineering/doc/FLY-954-provision-sandbox-escape/qa-report.md` | Q11, Q14, Q17 | DOC |
| `engineering/doc/FLY-954-provision-sandbox-escape/research.md` | Q11, Q14 | DOC |
| `engineering/doc/FLY-957-record-deployed-range-grep/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-957-record-deployed-range-grep/plan.md` | Q14 | DOC |
| `engineering/doc/FLY-957-record-deployed-range-grep/qa-report.md` | Q14 | DOC |
| `engineering/doc/FLY-957-record-deployed-range-grep/research.md` | Q14 | DOC |
| `engineering/doc/FLY-960-stt-dave-spike/design-review-round1.md` | Q11, Q14, Q16 | DOC |
| `engineering/doc/FLY-960-stt-dave-spike/plan.md` | Q11, Q14, Q16 | DOC |
| `engineering/doc/FLY-960-stt-dave-spike/research.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-967-gemini-live-assistant/design-review-round1.md` | Q14, Q17 | DOC |
| `engineering/doc/FLY-967-gemini-live-assistant/plan.md` | Q17 | DOC |
| `engineering/doc/FLY-967-gemini-live-assistant/qa-report.md` | Q17 | DOC |
| `engineering/doc/FLY-968-voice-model-bakeoff/design-review-round1.md` | Q14 | DOC |
| `engineering/doc/FLY-968-voice-model-bakeoff/design-review-round2.md` | Q14 | DOC |
| `engineering/doc/FLY-968-voice-model-bakeoff/plan.md` | Q16 | DOC |
| `engineering/doc/FLY-977-ci-biome-lint-fix/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-977-ci-biome-lint-fix/plan.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-977-ci-biome-lint-fix/qa-report.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-977-ci-biome-lint-fix/research.md` | Q14, Q16, Q17 | DOC |
| `engineering/doc/FLY-980-elevenlabs-tts-spike/design-review-round1.md` | Q14 | DOC |
| `engineering/doc/FLY-980-elevenlabs-tts-spike/exploration.md` | Q14 | DOC |
| `engineering/doc/FLY-980-elevenlabs-tts-spike/plan.md` | Q14, Q16 | DOC |
| `engineering/doc/FLY-997-gemini-agent-spike/design-review-round1.md` | Q16 | DOC |
| `engineering/doc/FLY-997-gemini-agent-spike/exploration.md` | Q17 | DOC |
| `engineering/doc/FLY-997-gemini-agent-spike/plan.md` | Q16 | DOC |
| `engineering/doc/milestones/FLY-145.md` | Q14 | DOC |
| `engineering/spike/FLY-1006-eleven/package.json` | Q14 | DOC |
| `engineering/spike/FLY-960-dave-stt/package-lock.json` | Q14 | DOC |
| `engineering/spike/FLY-980-eleven/package.json` | Q14 | DOC |
| `engineering/spike/FLY-997-gemini-agent/package.json` | Q14 | DOC |
| `engineering/spike/FLY-997-gemini-agent/run-s1-smoke.mjs` | Q16 | DOC |
| `fleet/README.md` | Q11, Q14 | DOC |
| `package.json` | Q14 | META |
| `packages/agent-team-transport/bin/agent-team-transport-cli.ts` | Q14, Q17 | META |
| `packages/agent-team-transport/bin/grep-gate.ts` | Q14, Q17 | META |
| `packages/agent-team-transport/package.json` | Q14 | META |
| `packages/claude-runner/bin/flywheel-claude-profile` | Q14, Q17 | META |
| `packages/claude-runner/package.json` | Q14 | META |
| `packages/claude-runner/src/TmuxAdapter.ts` | Q14 | META |
| `packages/claude-runner/src/TmuxRunner.ts` | Q14 | META |
| `packages/claude-runner/src/index.ts` | Q14 | META |
| `packages/claude-runner/test-scripts/README.md` | Q14 | DOC |
| `packages/config/package.json` | Q14 | META |
| `packages/config/src/ConfigLoader.ts` | Q8 | META |
| `packages/config/src/__tests__/ConfigLoader.test.ts` | Q3, Q6, Q7, Q8 | PATH |
| `packages/config/src/__tests__/decision-mode.test.ts` | Q17 | OTHER |
| `packages/config/src/__tests__/feature-flags-drift.test.ts` | Q17 | OTHER |
| `packages/config/src/decision-mode.ts` | Q17 | META |
| `packages/config/src/feature-flags/registry.ts` | Q14, Q17 | META |
| `packages/config/src/types.ts` | Q5, Q8 | META |
| `packages/core/package.json` | Q14 | META |
| `packages/core/src/FlywheelRunnerRegistry.ts` | Q14 | META |
| `packages/core/src/adapter-types.ts` | Q14 | META |
| `packages/core/src/tmux-viewer.ts` | Q14 | META |
| `packages/dag-resolver/package.json` | Q14 | META |
| `packages/edge-worker/package.json` | Q14 | META |
| `packages/edge-worker/src/AgentDispatcher.ts` | Q3, Q4, Q5, Q6, Q7, Q8 | META |
| `packages/edge-worker/src/Blueprint.ts` | Q14, Q17 | META |
| `packages/edge-worker/src/GitService.ts` | Q14 | META |
| `packages/edge-worker/src/__tests__/AgentDispatcher.test.ts` | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8 | KEEP |
| `packages/edge-worker/src/__tests__/Blueprint.fly205-doc-flow.test.ts` | Q8 | PATH |
| `packages/edge-worker/src/__tests__/Blueprint.v0.6.integration.test.ts` | Q8 | PATH |
| `packages/edge-worker/src/__tests__/WorktreeManager.test.ts` | Q14 | OTHER |
| `packages/edge-worker/src/__tests__/resolveBridgeUrl.test.ts` | Q14, Q17 | OTHER |
| `packages/edge-worker/src/prompts/subroutines/release-execution.md` | Q14, Q16 | DOC |
| `packages/flywheel-cli/package.json` | Q14 | META |
| `packages/flywheel-cli/src/__tests__/doctor.test.ts` | Q8 | PATH |
| `packages/flywheel-cli/src/__tests__/migrate-agents-path.test.ts` | Q5, Q6, Q7, Q8 | PATH |
| `packages/flywheel-cli/src/commands/doctor.ts` | Q8 | META |
| `packages/flywheel-cli/src/commands/init.ts` | Q8 | META |
| `packages/flywheel-cli/src/commands/migrate-agents-path.ts` | Q7, Q8 | META |
| `packages/flywheel-cli/src/index.ts` | Q8 | META |
| `packages/flywheel-cli/src/templates/config.yaml.tmpl` | Q8 | META |
| `packages/flywheel-comm/package.json` | Q14 | META |
| `packages/flywheel-comm/src/__tests__/xiaohongshu-analysis-store.test.ts` | Q16 | OTHER |
| `packages/flywheel-comm/src/commands/complete.ts` | Q17 | META |
| `packages/flywheel-comm/src/commands/gate.ts` | Q17 | META |
| `packages/flywheel-comm/src/commands/stage.ts` | Q17 | META |
| `packages/gemini-agent/README.md` | Q14, Q17 | DOC |
| `packages/gemini-agent/package.json` | Q14 | META |
| `packages/gemini-agent/scripts/harness-delegate-replay.mjs` | Q14 | META |
| `packages/gemini-agent/src/tools/schemas.ts` | Q14 | META |
| `packages/github-event-transport/package.json` | Q14 | META |
| `packages/inbox-mcp/package.json` | Q14 | META |
| `packages/linear-event-transport/package.json` | Q14 | META |
| `packages/onboard-shell/__tests__/onboard-shell-install.test.sh` | Q14, Q16 | OTHER |
| `packages/onboard-shell/__tests__/onboard-shell-negatives.test.sh` | Q14, Q16 | OTHER |
| `packages/onboard-shell/__tests__/onboard-shell-publish-gate.test.sh` | Q11, Q14, Q16 | OTHER |
| `packages/onboard-shell/__tests__/onboard-shell-qa-gaps.test.sh` | Q14, Q16 | OTHER |
| `packages/onboard-shell/__tests__/onboard-shell-rotation.test.sh` | Q14, Q16 | OTHER |
| `packages/onboard-shell/__tests__/onboard-shell-secret.test.sh` | Q14, Q16 | OTHER |
| `packages/onboard-shell/lib/install.mjs` | Q14 | META |
| `packages/onboard-shell/lib/onboard.mjs` | Q14 | META |
| `packages/onboard-shell/lib/update.mjs` | Q14 | META |
| `packages/payload-endpoint/__tests__/lifecycle.test.mjs` | Q14 | OTHER |
| `packages/payload-endpoint/__tests__/serve.mjs` | Q14 | OTHER |
| `packages/qa-framework/README.md` | Q14, Q17 | DOC |
| `packages/qa-framework/__tests__/QaConfigLoader.test.ts` | Q14 | OTHER |
| `packages/qa-framework/agents/qa-parallel-executor.md` | Q14 | DOC |
| `packages/qa-framework/eval/scorecard.mjs` | Q14 | META |
| `packages/qa-framework/orchestrator/lock.sh` | Q14 | META |
| `packages/qa-framework/package.json` | Q14 | META |
| `packages/qa-framework/src/config/shell-export.ts` | Q14 | META |
| `packages/qa-framework/suites/fly-102-lead-driven-runner-lifecycle.md` | Q17, Q20 | DOC |
| `packages/qa-framework/suites/fly-161-runner-question.md` | Q14 | DOC |
| `packages/qa-framework/suites/fly-162-thread-routing.md` | Q14 | DOC |
| `packages/qa-framework/suites/fly-529-alert-mirror.md` | Q11, Q14 | DOC |
| `packages/qa-framework/suites/fly-529-roundtable-mirror.md` | Q14 | DOC |
| `packages/qa-framework/suites/fly-60-hard-gate.md` | Q14, Q17 | DOC |
| `packages/slack-event-transport/package.json` | Q14 | META |
| `packages/teamlead/lead-rules-base/README.md` | Q14, Q17, Q20 | DOC |
| `packages/teamlead/lead-rules-base/founder-only-authority.md` | Q17 | DOC |
| `packages/teamlead/package.json` | Q12, Q13, Q14 | META |
| `packages/teamlead/qa-fly1041-inbound.mts` | Q17 | META |
| `packages/teamlead/qa-fly1041-real.mts` | Q17 | META |
| `packages/teamlead/qa-fly1232-flagon-drill.mjs` | Q17 | META |
| `packages/teamlead/scripts/__tests__/claude-lead-manifest-preserve.test.sh` | Q14, Q17 | OTHER |
| `packages/teamlead/scripts/__tests__/fly231-companion-launch-plan.test.sh` | Q17 | OTHER |
| `packages/teamlead/scripts/__tests__/fly231-restart-candidate.test.sh` | Q11, Q14, Q17 | OTHER |
| `packages/teamlead/scripts/__tests__/fly241-lead-model-override.test.sh` | Q17 | OTHER |
| `packages/teamlead/scripts/__tests__/fly869-founder-ux-default-mode.test.sh` | Q14, Q17 | OTHER |
| `packages/teamlead/scripts/__tests__/fly879-external-launch-plan.test.sh` | Q17 | OTHER |
| `packages/teamlead/scripts/__tests__/lead-backend-dispatch.test.sh` | Q14, Q17 | OTHER |
| `packages/teamlead/scripts/__tests__/mcp-inherit.test.sh` | Q11, Q14, Q17 | OTHER |
| `packages/teamlead/scripts/__tests__/run-codex-infra-bot-tui.test.sh` | Q14 | OTHER |
| `packages/teamlead/scripts/__tests__/run-codex-lead-mufasa-tui-fullaccess.test.sh` | Q14 | OTHER |
| `packages/teamlead/scripts/__tests__/run-codex-lead-mufasa-tui.test.sh` | Q14, Q17 | OTHER |
| `packages/teamlead/scripts/claude-lead.sh` | Q14, Q17 | META |
| `packages/teamlead/scripts/fly-513-repoint-global-codex.sh` | Q14 | META |
| `packages/teamlead/scripts/inbox-ack-rule.md` | Q17 | DOC |
| `packages/teamlead/scripts/qa-fly259-mufasa-tui-slot.sh` | Q14, Q17 | META |
| `packages/teamlead/scripts/run-codex-infra-bot-tui.sh` | Q14, Q17 | META |
| `packages/teamlead/scripts/run-codex-lead-mufasa-fullaccess.sh` | Q14, Q17 | META |
| `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh` | Q14, Q17 | META |
| `packages/teamlead/scripts/run-codex-lead-mufasa-tui.sh` | Q14, Q17 | META |
| `packages/teamlead/scripts/run-codex-lead-mufasa-writecapable.sh` | Q17 | META |
| `packages/teamlead/scripts/run-codex-lead-mufasa.sh` | Q17 | META |
| `packages/teamlead/scripts/templates/flywheel-codex-lead-wrapper-mufasa-tui.sh` | Q14, Q17 | META |
| `packages/teamlead/scripts/test-fly205-doc-flow-lead.sh` | Q14, Q17 | OTHER |
| `packages/teamlead/scripts/test-fly26-rules-split.sh` | Q14, Q17 | OTHER |
| `packages/teamlead/scripts/test-lead-alert-dedup.sh` | Q14 | OTHER |
| `packages/teamlead/scripts/test-rotation.sh` | Q14, Q17 | OTHER |
| `packages/teamlead/scripts/test-tui-window-lost-alert.sh` | Q14 | OTHER |
| `packages/teamlead/scripts/test-verify-windowed-lead.sh` | Q17 | OTHER |
| `packages/teamlead/src/DirectEventSink.ts` | Q17 | META |
| `packages/teamlead/src/LeadAlertNotifier.ts` | Q14 | META |
| `packages/teamlead/src/LeadWatchdog.ts` | Q14, Q17 | META |
| `packages/teamlead/src/StateStore.ts` | Q14 | META |
| `packages/teamlead/src/__tests__/LeadWatchdog-fly927-echo.test.ts` | Q17 | OTHER |
| `packages/teamlead/src/__tests__/cipher-bridge-e2e.test.ts` | Q16 | OTHER |
| `packages/teamlead/src/__tests__/eventIdParity.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/__tests__/feature-flag-render.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/__tests__/fleet-apply-command.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/__tests__/fly222-memory-rule.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/__tests__/fly247-bash-suites.test.ts` | Q14, Q17, Q20 | OTHER |
| `packages/teamlead/src/__tests__/fly350-fullaccess-deploy.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/__tests__/fly574-bash-suites.test.ts` | Q14, Q17, Q20 | OTHER |
| `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/__tests__/local-verification-policy.test.ts` | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11, Q12, Q13, Q14, Q15, Q16, Q17 | KEEP |
| `packages/teamlead/src/__tests__/mailbox-gc.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/__tests__/stuck-escalation.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/bridge/__tests__/fly707-enablement.test.ts` | Q17 | OTHER |
| `packages/teamlead/src/bridge/__tests__/kind-contract.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/bridge/bridge-exit-marker.ts` | Q11, Q14 | META |
| `packages/teamlead/src/bridge/cmux-close-request.ts` | Q14 | META |
| `packages/teamlead/src/bridge/digest-route.ts` | Q14 | META |
| `packages/teamlead/src/bridge/lead-alert-helpers.ts` | Q14 | META |
| `packages/teamlead/src/bridge/plugin.ts` | Q14 | META |
| `packages/teamlead/src/bridge/publish-broker/__tests__/shell-publish.e2e.test.ts` | Q16 | OTHER |
| `packages/teamlead/src/bridge/publish-broker/endpoint-client.ts` | Q14 | META |
| `packages/teamlead/src/bridge/publish-broker/registry-client.ts` | Q16 | META |
| `packages/teamlead/src/bridge/publish-broker/shell-publish.ts` | Q16 | META |
| `packages/teamlead/src/bridge/publish-broker/shell-verify.ts` | Q11, Q14, Q16, Q17 | META |
| `packages/teamlead/src/bridge/report-registry.ts` | Q14 | META |
| `packages/teamlead/src/bridge/run-dispatcher.ts` | Q11, Q14 | META |
| `packages/teamlead/src/bridge/run-infra.ts` | Q11, Q14, Q17 | META |
| `packages/teamlead/src/bridge/stuck-candidate.ts` | Q17, Q20 | META |
| `packages/teamlead/src/bridge/sync-flywheel-hooks.ts` | Q14, Q17 | META |
| `packages/teamlead/src/bridge/tmux-lookup.ts` | Q14 | META |
| `packages/teamlead/src/index.ts` | Q14 | META |
| `packages/teamlead/src/lead-backends/codex/__tests__/codex-lead-runtime.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/lead-backends/codex/__tests__/read-deny-removed.sentinel.test.ts` | Q14, Q17 | OTHER |
| `packages/teamlead/src/lead-backends/codex/__tests__/tui-window-alert.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts` | Q16 | META |
| `packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts` | Q14 | META |
| `packages/teamlead/src/lead-backends/codex/gateway/__tests__/ship-preflight.test.ts` | Q14 | OTHER |
| `packages/teamlead/src/lead-backends/codex/tui-window-alert.ts` | Q14, Q17 | META |
| `packages/terminal-mcp/package.json` | Q14 | META |
| `packages/token-usage/README.md` | Q14 | DOC |
| `packages/token-usage/package.json` | Q14 | META |
| `packages/voice-bridge/e2e/eleven-voice-loop.mjs` | Q14 | META |
| `packages/voice-bridge/e2e/fly1065-staged-discord.mjs` | Q14 | META |
| `packages/voice-bridge/package.json` | Q14 | META |
| `packages/voice-bridge/src/__tests__/daemon-health.test.ts` | Q11, Q14 | OTHER |
| `packages/voice-bridge/src/__tests__/eleven-wiring.test.ts` | Q14 | OTHER |
| `packages/voice-bridge/src/__tests__/eleven-ws.test.ts` | Q14 | OTHER |
| `packages/voice-bridge/src/__tests__/qa-fly1065-integration.test.ts` | Q14 | OTHER |
| `packages/voice-bridge/src/assistant/AssistantSession.ts` | Q14 | META |
| `packages/voice-bridge/src/cli.ts` | Q11, Q14 | META |
| `packages/voice-bridge/src/eleven/ElevenSession.ts` | Q14 | META |
| `packages/voice-core/.gitignore` | Q14 | META |
| `packages/voice-core/evidence/poc-announce.md` | Q14 | DOC |
| `packages/voice-core/package.json` | Q14 | META |
| `packages/voice-core/src/__tests__/gemini-live.test.ts` | Q14 | OTHER |
| `packages/voice-core/src/backends/gemini/GeminiLiveBackend.ts` | Q14 | META |
| `packages/voice-core/src/config.ts` | Q14 | META |
| `packages/voice-core/src/scrub.ts` | Q14 | META |
| `packages/voice-headphone/package.json` | Q14 | META |
| `pnpm-lock.yaml` | Q17 | META |
| `product/doc/FLY-1005-multi-machine-runners/plan.md` | Q17 | DOC |
| `product/doc/FLY-1005-multi-machine-runners/research.md` | Q17 | DOC |
| `product/doc/FLY-1022-hierarchical-runner-tree/exploration.md` | Q17 | DOC |
| `product/doc/FLY-1038-unified-management-dashboard/prototype/dashboard.html` | Q1, Q2, Q3, Q5, Q6, Q7, Q8, Q14 | DOC |
| `product/doc/FLY-1045-human-company-mechanisms/deep-research-agent-incentives.md` | Q14 | DOC |
| `product/doc/FLY-1045-human-company-mechanisms/exploration.md` | Q14, Q17 | DOC |
| `product/doc/FLY-1045-human-company-mechanisms/plan.md` | Q17 | DOC |
| `product/doc/FLY-1045-human-company-mechanisms/research.md` | Q17 | DOC |
| `product/doc/FLY-1059-designer-agent-role/exploration.md` | Q3, Q8, Q17 | DOC |
| `product/doc/FLY-1059-designer-agent-role/plan.md` | Q3, Q8, Q14 | DOC |
| `product/doc/FLY-1059-designer-agent-role/research.md` | Q3, Q8 | DOC |
| `product/doc/FLY-1063-github-cool-ship/research.md` | Q14, Q17 | DOC |
| `product/doc/FLY-1089-pm-prototype-executor-roles/exploration.md` | Q3, Q8 | DOC |
| `product/doc/FLY-1089-pm-prototype-executor-roles/plan.md` | Q1, Q2, Q3, Q6, Q7, Q8, Q14 | DOC |
| `product/doc/FLY-1089-pm-prototype-executor-roles/research.md` | Q3, Q8 | DOC |
| `product/doc/FLY-1091-feature-flag-policy/audit.md` | Q17 | DOC |
| `product/doc/FLY-1091-feature-flag-policy/exploration.md` | Q17 | DOC |
| `product/doc/FLY-1091-feature-flag-policy/research.md` | Q17 | DOC |
| `product/doc/FLY-1098-release-cicd/research.md` | Q16 | DOC |
| `product/doc/FLY-1180-tri-platform-identity/exploration.md` | Q14 | DOC |
| `product/doc/FLY-1180-tri-platform-identity/research.md` | Q11, Q14 | DOC |
| `product/doc/FLY-346-aio-sandbox-runner-eval/plan.md` | Q14 | DOC |
| `product/doc/FLY-910-non-eng-onboarding/assets-brief.md` | Q14 | DOC |
| `product/doc/FLY-910-non-eng-onboarding/exploration.md` | Q14 | DOC |
| `product/doc/FLY-914-interactive-review-artifact/build-issues-draft.md` | Q17 | DOC |
| `product/doc/FLY-915-infra-alerts-pipeline/exploration.md` | Q14 | DOC |
| `product/doc/FLY-964-status-display-redesign/prd.md` | Q17 | DOC |
| `product/doc/FLY-978-decouple-cleanup-restart/exploration.md` | Q14, Q17 | DOC |
| `qa-fly294/QA-REPORT-FLY-294.md` | Q17 | DOC |
| `qa-fly294/layerA.mts` | Q17 | META |
| `qa-fly294/layerB.mts` | Q17 | META |
| `qa-fly310/QA-REPORT-FLY-310.md` | Q14 | DOC |
| `qa-fly310/e2e-launch-env.sh` | Q17 | META |
| `qa-fly310/e2e-setup.sh` | Q14, Q17 | META |
| `qa-fly310/fly310-adversarial.sh` | Q14, Q17 | META |
| `qa-fly310/fly310-ps-env.sh` | Q14, Q17 | META |
| `qa-fly310/fly310-tamper3.sh` | Q14, Q17 | META |
| `qa-fly310/fly310-verify-suspects.sh` | Q14, Q17 | OTHER |
| `review.json` | Q16 | META |
| `scripts/__tests__/agent-cli-provider-contract.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/bridge-liveness-probe.test.sh` | Q14 | OTHER |
| `scripts/__tests__/bridge-port.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/bridge-wrapper-fail-loud.test.sh` | Q14 | OTHER |
| `scripts/__tests__/buddy-escalate.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/codex-log-guard.test.sh` | Q14 | OTHER |
| `scripts/__tests__/converge-flywheel-bin.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/customer-e2e-acceptance.test.sh` | Q14, Q16 | OTHER |
| `scripts/__tests__/discord-bot-pool.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/fleet-capture.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/fleet-sanitize.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/fly1165-sweep-decision.test.mjs` | Q14 | OTHER |
| `scripts/__tests__/flywheel-buddy-captain.test.sh` | Q11, Q14, Q17 | OTHER |
| `scripts/__tests__/flywheel-buddy-connect.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/flywheel-buddy-github.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/flywheel-buddy-steps.test.sh` | Q11, Q14, Q17 | OTHER |
| `scripts/__tests__/flywheel-buddy.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/flywheel-daemon-install-verify.test.sh` | Q14 | OTHER |
| `scripts/__tests__/flywheel-daemon-plist-env.test.sh` | Q14 | OTHER |
| `scripts/__tests__/flywheel-fleet-report.test.sh` | Q14 | OTHER |
| `scripts/__tests__/flywheel-fleet.test.sh` | Q14 | OTHER |
| `scripts/__tests__/flywheel-onboard.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/flywheel-setup-bot.test.sh` | Q14 | OTHER |
| `scripts/__tests__/flywheel-setup-channels.test.sh` | Q14 | OTHER |
| `scripts/__tests__/flywheel-setup-config.test.sh` | Q11, Q14, Q17 | OTHER |
| `scripts/__tests__/flywheel-setup-engine.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/flywheel-setup-linear.test.sh` | Q14 | OTHER |
| `scripts/__tests__/flywheel-setup-poc.test.sh` | Q14, Q17 | OTHER |
| `scripts/__tests__/flywheel-setup-resume-e2e.test.sh` | Q14, Q17 | OTHER |
| `scripts/__tests__/flywheel-setup-services.test.sh` | Q14 | OTHER |
| `scripts/__tests__/gate4-allowlist-masking.test.sh` | Q11, Q14, Q16 | OTHER |
| `scripts/__tests__/gate4-forms-probe.test.sh` | Q11, Q14, Q16 | OTHER |
| `scripts/__tests__/host-config.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/host-path-allowlist.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/lead-alert-dirs.test.sh` | Q14 | OTHER |
| `scripts/__tests__/lead-alert-strict-delivery.test.sh` | Q14, Q17 | OTHER |
| `scripts/__tests__/linux-preflight.test.sh` | Q14 | OTHER |
| `scripts/__tests__/materialize-lead-manifests.test.sh` | Q14 | OTHER |
| `scripts/__tests__/package-onboard-smoke.test.sh` | Q5, Q14, Q16, Q17 | OTHER |
| `scripts/__tests__/package-onboard-version-injection.test.sh` | Q11, Q14, Q16 | OTHER |
| `scripts/__tests__/package-onboard.test.sh` | Q11, Q14, Q16 | OTHER |
| `scripts/__tests__/packaged-restart.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/packaged-seams.test.sh` | Q11, Q14, Q17 | OTHER |
| `scripts/__tests__/payload-key-cleanup.test.sh` | Q14 | OTHER |
| `scripts/__tests__/payload-release-pipeline.test.sh` | Q14, Q16 | OTHER |
| `scripts/__tests__/platform-deps.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/provision-fleet-host.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/provision-linux.test.sh` | Q14 | OTHER |
| `scripts/__tests__/provision-prebuilt.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/provision-statedir.test.sh` | Q14 | OTHER |
| `scripts/__tests__/publish-broker-structure.test.sh` | Q17 | OTHER |
| `scripts/__tests__/qa-room-env.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/restart-deployed-range.test.sh` | Q14 | OTHER |
| `scripts/__tests__/restart-notify-routine.test.sh` | Q14 | OTHER |
| `scripts/__tests__/restart-services-notify.test.sh` | Q14 | OTHER |
| `scripts/__tests__/script-sanity.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/self-ship-restart.test.sh` | Q14 | OTHER |
| `scripts/__tests__/setup-prebuilt.test.sh` | Q14 | OTHER |
| `scripts/__tests__/setup-roundtable-config.test.sh` | Q14 | OTHER |
| `scripts/__tests__/shell-pack-install-dryrun.test.sh` | Q14, Q16 | OTHER |
| `scripts/__tests__/simba-grep-zero.test.sh` | Q14 | OTHER |
| `scripts/__tests__/supervisor.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/test-deploy-multilead.test.sh` | Q11, Q14 | OTHER |
| `scripts/__tests__/test-deploy-qa-room.test.sh` | Q14 | OTHER |
| `scripts/__tests__/test-pm-executor-contract.sh` | Q3, Q8, Q14 | OTHER |
| `scripts/__tests__/test-setup-doc-flow.sh` | Q14 | OTHER |
| `scripts/__tests__/test-setup-new-project.sh` | Q8, Q14 | PATH |
| `scripts/__tests__/token-usage-daily-channel.test.sh` | Q14 | OTHER |
| `scripts/__tests__/token-usage-daily-failloud.test.sh` | Q14 | OTHER |
| `scripts/__tests__/update-flywheel-queue.test.sh` | Q14 | OTHER |
| `scripts/__tests__/voice-bridge-wrapper.test.sh` | Q14 | OTHER |
| `scripts/__tests__/wrapper-host-config-revcompat.test.sh` | Q11, Q14 | OTHER |
| `scripts/alert-queue-drain-permanent.mjs` | Q14 | META |
| `scripts/bridge-liveness-probe.sh` | Q14 | META |
| `scripts/buddy/first-output-skill.md` | Q14 | DOC |
| `scripts/cleanup-fly-77-config.sh` | Q14 | META |
| `scripts/cleanup-sessions.ts` | Q14 | META |
| `scripts/com.flywheel.daily-digest.plist` | Q14 | META |
| `scripts/com.flywheel.daily-standup.plist` | Q14 | META |
| `scripts/com.flywheel.token-usage-daily.plist` | Q14 | META |
| `scripts/com.flywheel.updater.plist` | Q14 | META |
| `scripts/com.flywheel.xiaohongshu-learning.plist` | Q14 | META |
| `scripts/converge-flywheel-bin.sh` | Q14 | META |
| `scripts/daily-standup.sh` | Q14, Q17 | META |
| `scripts/discord-e2e.sh` | Q14 | META |
| `scripts/e2e-adapter-protocol.ts` | Q17 | META |
| `scripts/e2e-demo.ts` | Q17 | META |
| `scripts/e2e-heartbeat.ts` | Q14, Q17 | META |
| `scripts/e2e-scan-notify.ts` | Q14, Q17 | META |
| `scripts/e2e-tmux-runner.ts` | Q14 | META |
| `scripts/fleet-capture.sh` | Q11, Q14 | META |
| `scripts/fly254-p0-probe.sh` | Q14 | META |
| `scripts/fly503-consolidation/build_review.py` | Q14, Q17 | META |
| `scripts/fly503-consolidation/test_build_review.py` | Q14 | OTHER |
| `scripts/flywheel-bridge-wrapper.sh` | Q11, Q14 | META |
| `scripts/flywheel-buddy.sh` | Q14 | META |
| `scripts/flywheel-cmux-install.sh` | Q14 | META |
| `scripts/flywheel-cmux-sync.sh` | Q14, Q17 | META |
| `scripts/flywheel-daemon.sh` | Q14 | META |
| `scripts/flywheel-lead-wrapper.sh` | Q14, Q17 | META |
| `scripts/flywheel-onboard.sh` | Q11, Q14 | META |
| `scripts/flywheel-setup.sh` | Q17 | META |
| `scripts/flywheel-voice-bridge-wrapper.sh` | Q11, Q14 | META |
| `scripts/gemini-agent-guard.sh` | Q17 | META |
| `scripts/hooks/flywheel-restart-guard.py` | Q14 | META |
| `scripts/hooks/install-restart-guard.sh` | Q14 | META |
| `scripts/hooks/test-discord-reply-enforcer.py` | Q14 | OTHER |
| `scripts/hooks/test-flywheel-restart-guard.py` | Q14, Q17 | OTHER |
| `scripts/hooks/test-inbox-check.sh` | Q14 | OTHER |
| `scripts/hooks/test-reply-enforcer-install-integration.sh` | Q14, Q17 | OTHER |
| `scripts/hooks/test-reply-enforcer-install.sh` | Q14, Q17 | OTHER |
| `scripts/hooks/test-restart-guard-install.sh` | Q14 | OTHER |
| `scripts/inject-linear-issue.sh` | Q14, Q17 | META |
| `scripts/launchd/com.flywheel.bridge-liveness-probe.plist` | Q14 | META |
| `scripts/launchd/com.flywheel.bridge.plist` | Q14 | META |
| `scripts/launchd/com.flywheel.codex-log-guard.plist` | Q14 | META |
| `scripts/launchd/com.flywheel.voice-bridge.plist` | Q14 | META |
| `scripts/lib/agent-cli-providers/CONTRACT.md` | Q11, Q14 | DOC |
| `scripts/lib/agent-cli-providers/claude.sh` | Q11, Q14 | META |
| `scripts/lib/bridge-port.sh` | Q14 | META |
| `scripts/lib/buddy-captain-preview.sh` | Q14, Q17 | META |
| `scripts/lib/buddy-connect.sh` | Q11, Q14 | META |
| `scripts/lib/host-config.sh` | Q14 | META |
| `scripts/lib/local-verification-policy.md` | Q14 | KEEP（由新合同读取） |
| `scripts/lib/qa-fly-529-fire-bridge-alert.mjs` | Q14, Q17 | META |
| `scripts/lib/qa-multilead.sh` | Q11, Q14 | META |
| `scripts/lib/qa-room.sh` | Q11, Q14 | META |
| `scripts/lib/restart-candidate.sh` | Q14, Q17 | META |
| `scripts/lib/script-sanity.sh` | Q14 | META |
| `scripts/lib/self-ship-queue.sh` | Q14 | META |
| `scripts/lib/setup.ts` | Q11, Q14, Q17 | META |
| `scripts/mailbox-gc.mjs` | Q14 | META |
| `scripts/materialize-lead-manifests.sh` | Q14, Q17 | META |
| `scripts/meta-alert.sh` | Q14 | META |
| `scripts/package-onboard-files.allow` | Q5, Q11, Q14, Q16 | META |
| `scripts/package-onboard.sh` | Q5, Q11, Q14, Q16, Q17 | META |
| `scripts/packaged/audit-grep-allowlist.tsv` | Q11, Q14 | META |
| `scripts/packaged/bootstrap-services.sh` | Q14 | META |
| `scripts/packaged/create-compat-mirror.sh` | Q16 | META |
| `scripts/packaged/dependency-union-exceptions.tsv` | Q16 | META |
| `scripts/packaged/restart-packaged-services.sh` | Q11, Q14 | META |
| `scripts/pre-ship-check.sh` | Q14 | META |
| `scripts/provision-fleet-host.sh` | Q14 | META |
| `scripts/qa-fly-1048-real-discord-e2e.mjs` | Q14, Q17 | META |
| `scripts/qa-fly-1082-fleet-alerts-e2e.mjs` | Q14, Q17 | META |
| `scripts/qa-fly-1188-e2e.mjs` | Q14 | META |
| `scripts/qa-fly-1189-preflight.sh` | Q14 | META |
| `scripts/qa-fly-1189-room-smoke.sh` | Q14 | META |
| `scripts/qa-fly-1193-debounce-e2e.mjs` | Q14, Q17 | META |
| `scripts/qa-fly-1236-e2e.mjs` | Q14 | META |
| `scripts/qa-fly-1239-e2e.mjs` | Q14 | META |
| `scripts/qa-fly-1244-os-proof.mjs` | Q15, Q16, Q17 | META |
| `scripts/qa-fly-1264-reconnect-title-restore-e2e.mjs` | Q14 | META |
| `scripts/qa-fly-153-mirror-smoke.sh` | Q14 | META |
| `scripts/qa-fly-529-alert-smoke.sh` | Q11, Q14, Q17 | META |
| `scripts/qa-fly-529-roundtable-smoke.sh` | Q14 | META |
| `scripts/qa-fly-60-driver.sh` | Q14 | META |
| `scripts/qa-fly-60-report-html.sh` | Q14 | META |
| `scripts/qa-fly-695-lead-pending-escalation-e2e.mjs` | Q17 | META |
| `scripts/qa-fly-863-codex-hold-signal-e2e.mjs` | Q17 | META |
| `scripts/qa-fly-901-real-config-dispatch-e2e.mjs` | Q14 | META |
| `scripts/qa-fly-907-real-discord-e2e.mjs` | Q14 | META |
| `scripts/qa-fly892-real-discord-thread-e2e.mjs` | Q14 | META |
| `scripts/qa-fly921-real-discord-turn-belt-e2e.mjs` | Q14, Q17 | META |
| `scripts/qa-fly939-real-discord-wake-not-respawn-e2e.mjs` | Q14, Q17 | META |
| `scripts/release/broker-request.mjs` | Q14 | META |
| `scripts/release/lib/endpoint-client.mjs` | Q14 | META |
| `scripts/release/license-key.mjs` | Q14 | META |
| `scripts/release/payload-cleanup.mjs` | Q14 | META |
| `scripts/release/payload-promote.mjs` | Q14, Q16 | META |
| `scripts/release/payload-release.mjs` | Q14 | META |
| `scripts/release/shell-prepare.mjs` | Q14, Q16 | META |
| `scripts/release/shell-publish-preflight.sh` | Q14, Q16 | META |
| `scripts/restart-services.sh` | Q11, Q14, Q16, Q17 | META |
| `scripts/run-bridge.ts` | Q11, Q14, Q17 | META |
| `scripts/run-issue.ts` | Q14, Q16, Q17 | META |
| `scripts/run-project.ts` | Q14 | META |
| `scripts/run-voice-bridge.ts` | Q14 | META |
| `scripts/set-lead-avatar.sh` | Q14 | META |
| `scripts/setup-alert-channel.sh` | Q14 | META |
| `scripts/setup-doc-flow.sh` | Q14 | META |
| `scripts/setup-mirror-channel.sh` | Q14 | META |
| `scripts/setup-new-project.sh` | Q8, Q14 | META |
| `scripts/setup-ponytail.sh` | Q14 | META |
| `scripts/setup-roundtable-channel.sh` | Q14 | META |
| `scripts/setup-roundtable-config.sh` | Q14 | META |
| `scripts/smoke-test.ts` | Q14 | OTHER |
| `scripts/spike-mailbox-wake.sh` | Q14 | META |
| `scripts/spike-tmux-runner.sh` | Q14 | META |
| `scripts/sync-gbrain-docs.sh` | Q14 | META |
| `scripts/sync-phase-protocols.mjs` | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11, Q13, Q14 | KEEP（由新合同执行） |
| `scripts/test-auto-approve.sh` | Q14 | OTHER |
| `scripts/test-cmux-sync-hooks-integration.sh` | Q14 | OTHER |
| `scripts/test-cmux-sync.sh` | Q14 | OTHER |
| `scripts/test-deploy.sh` | Q14, Q16, Q17 | OTHER |
| `scripts/test-geo206-integration.ts` | Q17 | OTHER |
| `scripts/test-restart-services.sh` | Q11, Q14, Q16, Q17 | OTHER |
| `scripts/test-set-lead-avatar.sh` | Q14 | OTHER |
| `scripts/test-slots.example.json` | Q14 | OTHER |
| `scripts/test-stale-patrol.ts` | Q14, Q17 | OTHER |
| `scripts/test-teardown.sh` | Q14 | OTHER |
| `scripts/token-usage-daily.sh` | Q14 | META |
| `scripts/update-flywheel.sh` | Q11, Q14 | META |
| `scripts/verify-anna-isolation.sh` | Q14, Q17 | META |
| `scripts/voice-audition-fly546.mjs` | Q14 | META |
| `scripts/xiaohongshu-learning-tick.sh` | Q14 | META |
| `scripts/xiaohongshu-scheduler.ts` | Q14, Q17 | META |

</details>

具体排除核验：`migrate-agents-path.test.ts` 自建 `# generic` / `# qa` fixture；`ConfigLoader.test.ts` 用 mock YAML；`test-pm-executor-contract.sh` 检验另一个 PM 角色；`package-onboard-smoke.test.sh` 检查 `agents/qa-executor.md`（不同文件）存在性；`script-sanity.test.sh` 检验独立 shell 安装 helper；`fly247/fly574-bash-suites.test.ts` 包装固定的未改 shell 套件；`qa-fly-1244-os-proof.mjs` 用 teamlead manifest 定位 createRequire，不消费 prebuild；均不是本次规则消费者。

提交后复查：新增 source 与同步器也已进入 git grep 索引；所有新增匹配仅为本单 source、同步器、package prebuild 或记录自身，测试选择不变。三份角色先验证非空，旧命令/receipt 的 grep exit 1；逐文件剥除允许改动段后与 RED anchor 对比，其他文字逐字相同。
