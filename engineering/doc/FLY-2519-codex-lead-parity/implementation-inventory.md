# FLY-2519 Codex Lead 能力对等 — 实施盘点
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-13
基于: plan.md

C1 只读采集；不是生产验收，也不授予目录中的任何动作。执行 `node scripts/qa-codex-lead-parity.mjs --mode inventory --project flywheel --lead flywheel-product-lead`。测试使用 fixture，采集器不启动进程、不连接 provider、不写 registry。配置只输出名称，源文件只输出路径、行号、摘要；不输出凭证、配置值或业务正文。

## 实际输入差集

Claude 基准是 `flywheel-eng-lead`，目标是 `flywheel-product-lead`；角色不同，实际规则适用性仍由 C4 共用 selector 判定。当前目标按 `derive_codex_lead_home` 规则解析的 `.codex-flywheel-product-lead` 配置/skills 缺失。缺失不是空工具列表，不能据此声称已全量枚举在线 Codex 会话。

| 项目 | 实际观察 | 尚缺证据 |
|---|---|---|
| Claude MCP 配置 | flywheel-inbox, flywheel-terminal, gbrain, linear-api, xiaohongshu-mcp | 各服务 tools/list 与 live scope |
| Codex MCP 配置 | missing_or_unreadable | active home/config 与工具 schema |
| Claude 插件 | 21 个 installed registry 名称；不是全部启用 | 当前 launcher enabledPlugins/会话实际加载 |
| Claude 规则 | 1 个已物化 bundle，见源路径清单 | 当前 activation 是否加载；product 角色差异 |
| skills | Claude 31，目标 Codex 0 | C4 适用源与 provision |

## P01–P17 证据与差集

| ID | 面 | 当前证据/差集 |
|---|---|---|
| P01 | runner actions | 既有 runner 操作由 #1162 保留；当前缺同 activation 运行证据。 |
| P02 | Discord inbound and threads | Discord fork 静态 reply 可见；Codex 当前目标 home 未观察到线程工具。 |
| P03 | Discord history | Discord fork fetch_messages 静态可见；Codex tools/list 缺失。 |
| P04 | Discord rich actions | fork react/edit_message/download_attachment/reply 静态可见；Codex tools/list 缺失。 |
| P05 | Linear | linear-api 已配置；远端 HTTP 工具 schema 未采集。 |
| P06 | GitHub and git | gh/git 路径存在仅表示本机安装；认证 broker/安全 feature push 尚缺。 |
| P07 | Bridge and comm | 下表逐条列 Bridge source routes；现有模型入口仅 runner 六工具不足以覆盖。 |
| P08 | terminal | terminal 源码六工具见下；close_runner 不能新增 broker 授权。 |
| P09 | inbox receipts | inbox 源码 batch/event 两工具见下；Codex event ACK 仍需受管入口。 |
| P10 | patrol | patrol 脚本存在；六步读取与 judgment 写分开验证尚缺。 |
| P11 | reports | comm publish-report/verify-report 存在；broker 与 HTML skill provision 尚缺。 |
| P12 | browser | 安装清单含 Claude browser 插件不作为 Codex 验收；独立受管 browser 尚缺。 |
| P13 | rules | 物化 bundle 及源 hash 可枚举；active 选择与角色一致性未证明。 |
| P14 | persona and skills | 实际 SKILL.md 列出；target provision 缺失。 |
| P15 | gbrain | gbrain 已配置；schema/read/write receipt 未采集。 |
| P16 | Xiaohongshu | xiaohongshu-mcp 已配置；schema/账号授权/学习 skill receipt 未采集。 |
| P17 | other integrations | 其他插件全名单如下；每个适用工具仍需 live tools/list 与 mapping。 |

## 静态工具声明

`schemaSourceDigest` 是 schema 的源语法摘要；动态 description/schema 执行结果未知。`toolSchemaDigest=null` 明确没有把源码或配置冒充 MCP tools/list。

| 来源 | 工具 | 声明 |
|---|---|---|
| repository | `runner_terminal_capture` | `packages/terminal-mcp/src/index.ts:114` |
| repository | `runner_terminal_list` | `packages/terminal-mcp/src/index.ts:156` |
| repository | `runner_terminal_search` | `packages/terminal-mcp/src/index.ts:247` |
| repository | `runner_terminal_status` | `packages/terminal-mcp/src/index.ts:321` |
| repository | `runner_terminal_input` | `packages/terminal-mcp/src/index.ts:376` |
| repository | `close_runner` | `packages/terminal-mcp/src/index.ts:445` |
| repository | `flywheel_inbox_ack_batch` | `packages/inbox-mcp/src/index.ts:83` |
| repository | `flywheel_inbox_ack_event` | `packages/inbox-mcp/src/index.ts:110` |
| discord@claude-plugins-official (installed only) | `reply` | `$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:1076` |
| discord@claude-plugins-official (installed only) | `react` | `$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:1103` |
| discord@claude-plugins-official (installed only) | `edit_message` | `$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:1116` |
| discord@claude-plugins-official (installed only) | `download_attachment` | `$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:1131` |
| discord@claude-plugins-official (installed only) | `fetch_messages` | `$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:1143` |
| discord@flywheel-plugins (installed only) | `reply` | `$HOME/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1174` |
| discord@flywheel-plugins (installed only) | `react` | `$HOME/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1201` |
| discord@flywheel-plugins (installed only) | `edit_message` | `$HOME/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1214` |
| discord@flywheel-plugins (installed only) | `download_attachment` | `$HOME/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1229` |
| discord@flywheel-plugins (installed only) | `fetch_messages` | `$HOME/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts:1241` |

## Bridge route/method/guard 清单

自动 AST 扫描 `packages/teamlead/src/bridge`（排除测试）。相同路由不同条件分支保留独立行。直接 app 路由使用完整 path；factory 多挂点列在 mount 栏。guard 列是 handler/挂载中的实际标识符索引，便于逐条审查，不声称这些标识符在每条执行路径生效。授权状态始终 false；broker 必须按 C3 正负测试建立 allowlist。

`read_candidate` 来自 GET/HEAD/OPTIONS；POST 等为 `write_candidate`，其中 memory/search、digest/render、quota/status 等可能是语义只读，不能把 HTTP method 分类当最终权限。`reserved` 是保守拒绝候选：lifecycle、ship、merge receipt、close 等。动态 `/actions/:action` 还包含 approve/terminate/retry/reject/defer/shelve，必须逐 action 分开，不能全量透传；approve/terminate 不进入新 broker。

| Method | Path / mounts | 分类 | handler / mount guard symbols | source |
|---|---|---|---|
| POST | `/api/account-switch` | write_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/account-switch-route.ts:12` |
| POST | `/:action (mounts: /actions, /api/actions)` | write_candidate | cardAuthority, checkLeadScope, gateAuthorityView, materializedHeadAuthority, scopeErr / actionGateAuthorityView, apiToken, geminiAgentToken, materializedHeadAuthority, tokenAuthMiddleware | `packages/teamlead/src/bridge/actions.ts:1838` |
| GET | `/duty/alert-tickets/lookup` | read_candidate | none observed / alertDutyToken, dutyAuth | `packages/teamlead/src/bridge/alert-duty-router.ts:256` |
| GET | `/duty/alert-tickets/outstanding` | read_candidate | none observed / alertDutyToken, dutyAuth | `packages/teamlead/src/bridge/alert-duty-router.ts:269` |
| GET | `/duty/alert-board` | read_candidate | none observed / alertDutyToken, dutyAuth | `packages/teamlead/src/bridge/alert-duty-router.ts:332` |
| POST | `/duty/alert-tickets/transition` | write_candidate | none observed / alertDutyToken, dutyAuth | `packages/teamlead/src/bridge/alert-duty-router.ts:440` |
| POST | `/api/workflow/shadow-declaration` | write_candidate | authorId, authorIsBot, botToken, discordAuthorUserId / none observed | `packages/teamlead/src/bridge/auto-merge-shadow-route.ts:147` |
| POST | `/api/codex/quota/bind` | write_candidate | authDigest / ingestToken | `packages/teamlead/src/bridge/codex-quota-route.ts:107` |
| POST | `/api/codex/quota/observe` | write_candidate | none observed / ingestToken | `packages/teamlead/src/bridge/codex-quota-route.ts:172` |
| GET | `/api/codex/quota/status` | read_candidate | none observed / ingestToken | `packages/teamlead/src/bridge/codex-quota-route.ts:261` |
| POST | `/api/codex/quota/status` | write_candidate | none observed / ingestToken | `packages/teamlead/src/bridge/codex-quota-route.ts:262` |
| POST | `/api/dependency/add` | write_candidate | claimedActor, claimed_actor / apiToken, geminiAgentToken, masterOnlyAuthMiddleware | `packages/teamlead/src/bridge/dependency-route.ts:877` |
| POST | `/api/dependency/remove` | write_candidate | claimedActor, claimed_actor / apiToken, geminiAgentToken, masterOnlyAuthMiddleware | `packages/teamlead/src/bridge/dependency-route.ts:1139` |
| POST | `/api/dependency/note` | write_candidate | claimedActor, claimed_actor / apiToken, geminiAgentToken, masterOnlyAuthMiddleware | `packages/teamlead/src/bridge/dependency-route.ts:1288` |
| GET | `/api/dependency/log` | read_candidate | author / apiToken, geminiAgentToken, masterOnlyAuthMiddleware | `packages/teamlead/src/bridge/dependency-route.ts:1400` |
| POST | `/api/deployments/report` | write_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/deployments-route.ts:23` |
| POST | `/api/digest/render` | write_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/digest-route.ts:23` |
| GET | `/api/epic-page/status` | read_candidate | reportUrlForToken, token, token8 / apiToken, geminiAgentToken, masterOnlyAuthMiddleware | `packages/teamlead/src/bridge/epic-page-route.ts:153` |
| POST | `/api/epic-page/generate` | write_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/epic-page-route.ts:205` |
| POST | `/events/heartbeat` | write_candidate | none observed / ingestToken, materializedHeadAuthority, reviewAuthorizationAlerts, tokenAuthMiddleware | `packages/teamlead/src/bridge/event-route.ts:635` |
| POST | `/events` | write_candidate | FounderReviewAuthorityResult, GUARDRAIL_EVENT_TYPES, authoritativeHead, authoritativeIssueIdentifier, authority, authorityRoot, claimed, computeAuthoritativeShipDecision, discordBotToken, evaluateFounderReviewAuthority, fallbackBotToken, founderId, founderReviewCheckpointEnabled, isGuardrail, materializedHeadAuthority, nodeRequiresFounderReview, resolveBoundRepositoryAuthority, resolveFounderId, reviewAuthorizationAlerts / ingestToken, materializedHeadAuthority, reviewAuthorizationAlerts, tokenAuthMiddleware | `packages/teamlead/src/bridge/event-route.ts:649` |
| POST | `/api/founder-consent/runner-gate-response` | write_candidate | cardAuthority, carrierClaim, founderId, gateAuthorityView, leadLeaseEnv, leadWriteAuthorizationDeps, leaseClaim, leaseKey / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/founder-consent/gate-response-router.ts:163` |
| GET | `/` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/founder-consent/wiring.ts:516` |
| POST | `/api/founder-routing/runner-response` | write_candidate | authenticatedLead, authorizeRequest, carrierClaim, insertGuardedResponse, leaseClaim, leaseKey / apiToken, createFounderRoutingResponseRouter, tokenAuthMiddleware | `packages/teamlead/src/bridge/founder-routing-response-route.ts:92` |
| GET | `/api/lead-lease/diagnostics` | read_candidate | LeadLeaseDiagnosticsBudgetError, LeadWriteAuthorizationDeps, authorizationDeps, collectLeadLeaseDiagnostics / apiToken, createLeadLeaseDiagnosticsRouter, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lead-lease-diagnostics.ts:27` |
| POST | `/api/lead-lease/self-check` | write_candidate | LeadWriteAuthorizationDeps, authorizationDeps, carrierClaim, claimedLeadId, validateLeadCarrierAuthorization / apiToken, createLeadLeaseSelfCheckRouter, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lead-lease-self-check.ts:24` |
| POST | `/api/lifecycle/land` | reserved | guard / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lifecycle-routes.ts:219` |
| GET | `/api/lifecycle/land/:operationId` | reserved | guard / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lifecycle-routes.ts:264` |
| POST | `/api/lifecycle/land/:operationId/resume` | reserved | guard / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lifecycle-routes.ts:277` |
| POST | `/api/lifecycle/park` | reserved | founderDecisionId, guard / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lifecycle-routes.ts:311` |
| POST | `/api/lifecycle/dry-run` | reserved | guard / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lifecycle-routes.ts:348` |
| POST | `/api/lifecycle/unpark` | reserved | guard / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lifecycle-routes.ts:414` |
| POST | `/api/lifecycle-apply` | reserved | apiTokenConfigured / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/lifecycle-routes.ts:450` |
| POST | `/api/memory/search` | write_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/memory-route.ts:30` |
| POST | `/api/memory/add` | write_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/memory-route.ts:129` |
| POST | `/api/ship-approval-request` | reserved | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:1732` |
| GET | `/api/capacity` | read_candidate | apiToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:1759` |
| GET | `/api/sessions/:executionId/snapshot-owner` | read_candidate | apiToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:1764` |
| GET | `/api/workflow/menu-policies` | read_candidate | apiToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:1789` |
| GET | `/api/admission/pause` | read_candidate | apiToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:1836` |
| POST | `/api/admission/pause` | write_candidate | AdmissionPauseLeaseConflictError, apiToken, leaseId, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:1850` |
| POST | `/api/admission/resume` | write_candidate | apiToken, leaseId, leaseLapsed, lease_id, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:1930` |
| GET | `/api/admission/quiescence` | read_candidate | apiToken, countOpenLaunchClaims, durableLaunchClaims, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:1986` |
| POST | `/api/doa-backoff/reset` | write_candidate | apiToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:2054` |
| POST | `/api/doa-backoff/reset` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2123` |
| POST | `/api/workflow/evidence-run` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2161` |
| POST | `/api/workflow/shadow-declaration` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2167` |
| POST | `/api/workflow/evidence-run` | write_candidate | ingestToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:2174` |
| POST | `/api/workflow/shadow-declaration` | write_candidate | ingestToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:2187` |
| GET | `/health` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2299` |
| GET | `/api/diagnostics/event-loop` | read_candidate | apiToken, authorization, geminiAgentToken / none observed | `packages/teamlead/src/bridge/plugin.ts:2359` |
| GET | `/` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2397` |
| GET | `/sse` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2404` |
| POST | `/design-review-validation` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2531` |
| POST | `/design-review-validation` | write_candidate | ingestToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:2538` |
| POST | `/review-requests` | write_candidate | ingestToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:2562` |
| POST | `/review-rulings` | write_candidate | ingestToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:2596` |
| GET | `/api/fleet/snapshot` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2628` |
| GET | `/api/fleet/flag-report.html` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2651` |
| GET | `/api/fleet/progress` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2671` |
| POST | `/api/fleet/stage` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2734` |
| POST | `/api/fleet/apply` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2750` |
| POST | `/api/fleet/changes/stage` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2765` |
| POST | `/api/fleet/changes/apply` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2784` |
| POST | `/api/fleet/flag/stage` | write_candidate | carrierClaim, leadAuth / none observed | `packages/teamlead/src/bridge/plugin.ts:2839` |
| POST | `/api/fleet/flag/apply` | write_candidate | carrierClaim, confirmToken, leadAuth / none observed | `packages/teamlead/src/bridge/plugin.ts:2867` |
| POST | `/api/fleet/runner/stage` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:2913` |
| POST | `/api/fleet/runner/apply` | write_candidate | confirmToken / none observed | `packages/teamlead/src/bridge/plugin.ts:2926` |
| GET | `/xhs-review/:reportToken` | read_candidate | reportToken / none observed | `packages/teamlead/src/bridge/plugin.ts:2982` |
| POST | `/xhs-review/:reportToken/action` | write_candidate | reportToken / none observed | `packages/teamlead/src/bridge/plugin.ts:3000` |
| POST | `/api/lead-inbox/nudge` | write_candidate | apiToken, ingestToken, masterOrIngestAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:3176` |
| POST | `/api/lead-outbound/send` | write_candidate | apiToken, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:3222` |
| POST | `/api/sessions/:executionId/close-tmux` | reserved | apiToken, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:3231` |
| POST | `/api/sessions/:executionId/close-runner` | reserved | apiToken, geminiAgentToken, globalBotToken, runCloseAuthority, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:3390` |
| POST | `/api/patrol/scan-stale` | write_candidate | apiToken, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:3539` |
| POST | `/api/cipher-principle` | write_candidate | apiToken, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:3754` |
| POST | `/api/linear/create-issue` | write_candidate | apiToken, createIssueParentAuth, geminiAgentToken, resolveTeamScopedLabel, scopeLabelName, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:3813` |
| PATCH | `/api/linear/update-issue` | write_candidate | apiToken, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4097` |
| GET | `/api/linear/issues` | read_candidate | apiToken, geminiAgentToken, resolveLinearScope, scope, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4165` |
| POST | `/api/linear/comment` | write_candidate | apiToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4258` |
| GET | `/api/linear/issue` | read_candidate | apiToken, resolveLinearScope, scope, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4335` |
| GET | `/api/linear/comments` | read_candidate | apiToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4420` |
| POST | `/api/ship-approval-request` | reserved | apiToken, apiTokenConfigured, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4531` |
| GET | `/api/config/discord-guild-id` | read_candidate | apiToken, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4545` |
| POST | `/api/bootstrap/:leadId` | write_candidate | apiToken, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4558` |
| POST | `/api/flag-scan/run` | write_candidate | apiToken, geminiAgentToken, tokenAuthMiddleware / none observed | `packages/teamlead/src/bridge/plugin.ts:4958` |
| POST | `/api/flag-scan/run` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/plugin.ts:4964` |
| POST | `/api/publish-html` | write_candidate | vercelToken / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/publish-html-route.ts:18` |
| POST | `/api/reports/publish` | write_candidate | reportUrlForToken, token, vercelToken / apiToken, ingestToken, reportsAuthMiddleware | `packages/teamlead/src/bridge/reports-route.ts:249` |
| POST | `/api/reports/deliver` | write_candidate | discordBotToken, resolveDiscordBotToken, writeTokenReportReceipt / apiToken, ingestToken, reportsAuthMiddleware | `packages/teamlead/src/bridge/reports-route.ts:430` |
| POST | `/api/rescue` | write_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/rescue-route.ts:51` |
| GET | `/api/runs/:runId/holds` | read_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:444` |
| POST | `/api/runs/:runId/resume/stage` | write_candidate | auth, confirmToken, confirmTokens / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:450` |
| POST | `/api/runs/:runId/resume` | write_candidate | auth, confirmToken, confirmTokens / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:476` |
| GET | `/api/runs/:runId/diagnostic` | read_candidate | auth, authorization, masterToken, secureTokenEqual / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:741` |
| POST | `/api/runs/:runId/pr-manifest` | write_candidate | auth, authorization, masterToken, secureTokenEqual / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:813` |
| POST | `/api/runs/:runId/pr-manifest/merge-receipt` | reserved | auth, authorization, masterToken, secureTokenEqual / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:915` |
| POST | `/api/runs/:runId/rework` | write_candidate | FounderAuthorEvidence, auth, authorId, author_user_id, authorization, authorizeRework, canonicalFounderId, currentFounderGateHolder, founderAuthorEvidence, founderMessageRef, founderMessageRefBody, founderQuote, founder_id_at_capture, gateBotToken, masterToken, parseFounderMessageRef, secureTokenEqual / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:1010` |
| GET | `/api/runs/route-decisions/summary` | read_candidate | auth, authorization, masterToken, secureTokenEqual / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:1358` |
| POST | `/api/runs/start` | write_candidate | WORKFLOW_LAUNCH_SOFT_LEASE_MS, WorkflowRequestAuthKind, auth, authKind, authority, authorization, casLaunchClaimState, claimLegacyWorkflowEntry, claimWorkflowLaunchDeliveryRepair, claimWorkflowRouteDecision, claimed, dagAuthority, deliveryAuthority, founder_review_required, ghostGuardSessionWaitMs, guarded, isDeptScopeRejectEnabled, isLeadInScope, launchDeliveryAuthority, launchGateToken, launchReleaseFence, leaseExpiresAt, legacyEntryClaim, masterToken, nodeRequiresFounderReview, releaseFailedWorkflowLaunch, released, requestAuthKind, scopedToken, secureTokenEqual, staleBlockerGuard, templateAuthority, token / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:1382` |
| GET | `/api/runs/active` | read_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/runs-route.ts:4443` |
| POST | `/api/standup/trigger` | write_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/standup-route.ts:17` |
| POST | `/api/workflow/evidence-run` | write_candidate | WorkflowHeadAuthority, authority, getWorkflowSubmissionCredentialByToken, resolveHeadAuthority, resolveWorkflowHeadAuthority / none observed | `packages/teamlead/src/bridge/strength-two-evidence-route.ts:310` |
| POST | `/api/leads/:leadId/detection-ack` | write_candidate | auth / apiToken, auth, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/stuck-remanage-routes.ts:93` |
| POST | `/api/sessions/:executionId/detection-ack` | write_candidate | auth / apiToken, auth, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/stuck-remanage-routes.ts:240` |
| POST | `/api/sessions/:executionId/recovery-nudge` | write_candidate | auth / apiToken, auth, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/stuck-remanage-routes.ts:390` |
| POST | `/api/tmux-hold-observation` | write_candidate | apiToken / apiToken | `packages/teamlead/src/bridge/tmux-hold-route.ts:121` |
| GET | `/api/alert-duty/seat` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:143` |
| GET | `/api/sessions` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:152` |
| GET | `/api/sessions/:id` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:252` |
| GET | `/api/sessions/:id/history` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:271` |
| GET | `/api/sessions/:id/capture` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:297` |
| GET | `/api/sessions/:id/status` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:339` |
| GET | `/api/resolve-action` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:385` |
| POST | `/api/chat-threads/register` | write_candidate | botToken, regBotToken / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:473` |
| POST | `/api/chat-threads/create` | write_candidate | botToken / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:542` |
| POST | `/api/chat-threads/send` | write_candidate | botToken / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:711` |
| GET | `/api/chat-threads/by-thread/:threadId` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:1023` |
| GET | `/api/chat-threads` | read_candidate | none observed / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:1045` |
| POST | `/api/chat-threads/archive` | write_candidate | ArchiveAuthority, apiTokenConfigured, authority, botToken, fallbackBotToken, globalBotToken, resolveBotTokenForThread / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:1074` |
| POST | `/api/discord/reply-guard` | write_candidate | evaluateReplyGuard, issueTokens, replyGuardEnabled, scanIssueTokens / apiAuthWithRunnerTierDelegation, apiToken, apiTokenConfigured, geminiAgentToken, globalBotToken, replyGuardEnabled | `packages/teamlead/src/bridge/tools.ts:1276` |
| GET | `/api/triage/data` | read_candidate | projectScopedSessions, resolveLinearScope, scope / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/triage-data-route.ts:50` |
| GET | `/api/triage/template` | read_candidate | none observed / apiToken, geminiAgentToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/triage-template-route.ts:15` |
| GET | `/api/voice/scope` | read_candidate | botUserIdFromToken, founderId, founderIdFingerprint, globalBotToken, scopeChannelIds / apiToken, apiTokenConfigured, discordBotToken, founderApprovalIsHeld, founderConsent, founderConsentUserId, founderShipPostWriteHook, founderUserId, gateAuthorityView, geminiAgentToken, globalBotToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/voice-routes.ts:231` |
| GET | `/api/voice/context` | read_candidate | none observed / apiToken, apiTokenConfigured, discordBotToken, founderApprovalIsHeld, founderConsent, founderConsentUserId, founderShipPostWriteHook, founderUserId, gateAuthorityView, geminiAgentToken, globalBotToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/voice-routes.ts:264` |
| GET | `/api/voice/gate-binding` | read_candidate | gateAuthorityView / apiToken, apiTokenConfigured, discordBotToken, founderApprovalIsHeld, founderConsent, founderConsentUserId, founderShipPostWriteHook, founderUserId, gateAuthorityView, geminiAgentToken, globalBotToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/voice-routes.ts:295` |
| POST | `/api/voice/ship-approval` | reserved | apiTokenConfigured, canonicalFounderId, cardAuthority, founderId, founderUserId, gateAuthorityView / apiToken, apiTokenConfigured, discordBotToken, founderApprovalIsHeld, founderConsent, founderConsentUserId, founderShipPostWriteHook, founderUserId, gateAuthorityView, geminiAgentToken, globalBotToken, tokenAuthMiddleware | `packages/teamlead/src/bridge/voice-routes.ts:319` |
| POST | `/` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:82` |
| GET | `/desired` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:136` |
| GET | `/by-meeting/:meetingId` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:141` |
| GET | `/:sessionId` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:152` |
| POST | `/:sessionId/stop` | write_candidate | none observed / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:161` |
| POST | `/:sessionId/claim` | write_candidate | claimVoiceSession, claimed, leaseExpiresAt, leaseToken, leaseTtlMs / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:173` |
| POST | `/:sessionId/renew` | write_candidate | LEASE_CONFLICT, lease, leaseToken, leaseTtlMs / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:201` |
| POST | `/:sessionId/state` | write_candidate | LEASE_CONFLICT, lease, leaseToken / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:215` |
| GET | `/:sessionId/outbound` | read_candidate | LEASE_CONFLICT, getActiveVoiceLease, lease, leaseToken / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:257` |
| POST | `/:sessionId/outbound/:seq/claim` | write_candidate | LEASE_CONFLICT, attemptToken, claimVoiceOutbound, lease, leaseToken / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:270` |
| POST | `/:sessionId/outbound/:seq/receipt` | write_candidate | LEASE_CONFLICT, attemptToken, lease, leaseToken / none observed | `packages/teamlead/src/bridge/voice-session-routes.ts:289` |
| POST | `/api/workflow/carrier-redrive/stage` | write_candidate | none observed / ConfirmTokenStore, apiToken, tokens | `packages/teamlead/src/bridge/workflow-carrier-redrive-routes.ts:279` |
| POST | `/api/workflow/carrier-redrive` | write_candidate | none observed / ConfirmTokenStore, apiToken, tokens | `packages/teamlead/src/bridge/workflow-carrier-redrive-routes.ts:283` |
| POST | `/api/workflow/output` | write_candidate | token / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:519` |
| POST | `/api/workflow/head-authority` | write_candidate | authority, authorityMode, authorityRoot, authority_mode, exactHeadAuthority, resolveBoundRepositoryAuthority, resolveWorkflowExactHeadAuthority, resolveWorkflowHeadAuthority / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:544` |
| POST | `/api/workflow/decision` | write_candidate | claimExpiresAt, claimId, enqueueCommittedWorkflowClaim, getWorkflowSubmissionCredentialByToken, resolveWorkflowHeadAuthority / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:694` |
| POST | `/api/workflow/re-qa/stage` | write_candidate | confirmToken, tokens / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:943` |
| POST | `/api/workflow/gate-carrier-rebind/stage` | write_candidate | confirmToken, tokens / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:978` |
| POST | `/api/workflow/gate-carrier-rebind` | write_candidate | confirmToken, token, tokens / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:1018` |
| POST | `/api/workflow/loop-reentry/stage` | write_candidate | confirmToken, tokens / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:1096` |
| POST | `/api/workflow/loop-reentry` | write_candidate | confirmToken, token, tokenIdentity, tokens / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:1134` |
| POST | `/api/workflow/re-qa` | write_candidate | confirmToken, resolveWorkflowHeadAuthority, token, tokens / ConfirmTokenStore, materializedHeadAuthority, tokens | `packages/teamlead/src/bridge/workflow-decision-routes.ts:1203` |
| GET | `/api/workflow/menus` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/workflow-menu-routes.ts:43` |
| GET | `/api/workflow/templates` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/workflow-template-routes.ts:36` |
| GET | `/api/workflow/templates/:templateId/revisions` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/workflow-template-routes.ts:40` |
| GET | `/api/workflow/templates/:templateId` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/workflow-template-routes.ts:58` |
| GET | `/api/workflow/template-binding` | read_candidate | none observed / none observed | `packages/teamlead/src/bridge/workflow-template-routes.ts:77` |
| POST | `/api/workflow/cutovers/FLY-1436/stage` | write_candidate | none observed / ConfirmTokenStore, apiToken, tokens, workKindCutoverTokens | `packages/teamlead/src/bridge/workkind-cutover.ts:800` |
| POST | `/api/workflow/cutovers/FLY-1436/apply` | write_candidate | none observed / ConfirmTokenStore, apiToken, tokens, workKindCutoverTokens | `packages/teamlead/src/bridge/workkind-cutover.ts:804` |

动态注入未自动解出的路径：`createVoiceSessionRouter` 在 plugin.ts `/api/voice/sessions` 挂载，`buildFounderConsentWiring` debug router 由注入 wiring 决定。它们在表内保留 local path；不能假装扫描器已解析所有动态挂载。

## comm CLI source inventory

下列是顶层 command switch 的真实源码声明；不是模型允许命令清单。保留原 CLI，不删除/改名。

| Command | Source |
|---|---|
| `ask` | `packages/flywheel-comm/src/index.ts:271` |
| `check` | `packages/flywheel-comm/src/index.ts:274` |
| `ack-event` | `packages/flywheel-comm/src/index.ts:277` |
| `alert-ticket` | `packages/flywheel-comm/src/index.ts:280` |
| `oncall-draft` | `packages/flywheel-comm/src/index.ts:283` |
| `gate` | `packages/flywheel-comm/src/index.ts:286` |
| `hold` | `packages/flywheel-comm/src/index.ts:289` |
| `pending` | `packages/flywheel-comm/src/index.ts:292` |
| `respond` | `packages/flywheel-comm/src/index.ts:295` |
| `chat-ingest` | `packages/flywheel-comm/src/index.ts:298` |
| `send` | `packages/flywheel-comm/src/index.ts:301` |
| `lead-identity` | `packages/flywheel-comm/src/index.ts:304` |
| `lead-registry` | `packages/flywheel-comm/src/index.ts:307` |
| `summary-registry` | `packages/flywheel-comm/src/index.ts:310` |
| `summary` | `packages/flywheel-comm/src/index.ts:313` |
| `lead-lease` | `packages/flywheel-comm/src/index.ts:316` |
| `inbox` | `packages/flywheel-comm/src/index.ts:319` |
| `message-status` | `packages/flywheel-comm/src/index.ts:322` |
| `voice-session` | `packages/flywheel-comm/src/index.ts:325` |
| `adopt-inflight` | `packages/flywheel-comm/src/index.ts:328` |
| `sessions` | `packages/flywheel-comm/src/index.ts:331` |
| `capture` | `packages/flywheel-comm/src/index.ts:338` |
| `search` | `packages/flywheel-comm/src/index.ts:341` |
| `stage` | `packages/flywheel-comm/src/index.ts:344` |
| `progress` | `packages/flywheel-comm/src/index.ts:347` |
| `park` | `packages/flywheel-comm/src/index.ts:351` |
| `busy` | `packages/flywheel-comm/src/index.ts:354` |
| `unpark` | `packages/flywheel-comm/src/index.ts:357` |
| `turn` | `packages/flywheel-comm/src/index.ts:360` |
| `complete` | `packages/flywheel-comm/src/index.ts:363` |
| `runner-stopped` | `packages/flywheel-comm/src/index.ts:366` |
| `runner-wake-sweep` | `packages/flywheel-comm/src/index.ts:369` |
| `await-codex-gate` | `packages/flywheel-comm/src/index.ts:372` |
| `qa-result` | `packages/flywheel-comm/src/index.ts:375` |
| `workflow-output` | `packages/flywheel-comm/src/index.ts:378` |
| `evidence-run` | `packages/flywheel-comm/src/index.ts:381` |
| `shadow-declare` | `packages/flywheel-comm/src/index.ts:384` |
| `request-review` | `packages/flywheel-comm/src/index.ts:387` |
| `review-ruling` | `packages/flywheel-comm/src/index.ts:390` |
| `codex-review-result` | `packages/flywheel-comm/src/index.ts:393` |
| `codex-resume` | `packages/flywheel-comm/src/index.ts:396` |
| `verify-approval` | `packages/flywheel-comm/src/index.ts:399` |
| `cleanup` | `packages/flywheel-comm/src/index.ts:402` |
| `visual-capture` | `packages/flywheel-comm/src/index.ts:405` |
| `publish-report` | `packages/flywheel-comm/src/index.ts:408` |
| `verify-report` | `packages/flywheel-comm/src/index.ts:411` |
| `feature-flags` | `packages/flywheel-comm/src/index.ts:414` |
| `epic-page` | `packages/flywheel-comm/src/index.ts:417` |
| `dependency` | `packages/flywheel-comm/src/index.ts:420` |
| `lead-note` | `packages/flywheel-comm/src/index.ts:423` |
| `founder-time` | `packages/flywheel-comm/src/index.ts:426` |
| `runner-config` | `packages/flywheel-comm/src/index.ts:429` |
| `snapshot` | `packages/flywheel-comm/src/index.ts:432` |
| `token-report` | `packages/flywheel-comm/src/index.ts:435` |
| `report-deployed` | `packages/flywheel-comm/src/index.ts:438` |
| `notify` | `packages/flywheel-comm/src/index.ts:441` |
| `set-artifact` | `packages/flywheel-comm/src/index.ts:444` |
| `account-rotation-notify` | `packages/flywheel-comm/src/index.ts:447` |
| `xhs-state` | `packages/flywheel-comm/src/index.ts:450` |
| `xhs-analysis` | `packages/flywheel-comm/src/index.ts:453` |
| `xhs-validate-final` | `packages/flywheel-comm/src/index.ts:456` |

## 实际规则、skill、插件输入

Rule bundles（历史物化，尚未绑定 active session）：

- `$HOME/.flywheel/lead-rules-bundles/flywheel-flywheel-eng-lead.81852-lstart-c69f1b5ee708c2fb.md` sha256=5cf8522ae13f1f435a0284086e3696291344ee2f21bdb590ecb5bce9eff392e3
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/inbox-ack-rule.md` sha256=26207a075496f647b3b12ff6d82b9f0235189a6eab61665c1a9c72bc6c1615ae
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/department-lead-rules.md` sha256=757ba4427b0c4fe306542e89de4173f227ee5a42b2ab738b417716126bfeb548
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/runner-messaging-rules.md` sha256=bea5a4e6512ff3c10340e9652666b0858e73dd42d012e227414d772bfbdb1bcc
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/executor-routing.md` sha256=548dcfd10016b38ecc9b3c5873140c4c0662703e30dbe773e1f7997b5c18130d
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/model-routing.md` sha256=5178a4657e303a90214cf7d27b6f1663ab076272b8555f2a9da67d531752bb58
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/stuck-runner-remanage.md` sha256=a6e7e0ed196791f461b740bfd784ad97ea876dc20103fc09a45cf804edcb5cc7
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/runner-reengage-rules.md` sha256=56fa4771e19c9f645b3f2b7f1fbcd0e9b7b1ee334eb834e1d396de3ae4f538ed
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/doc-flow-rules.md` sha256=5b414c377a56f8497fd7bb3cc6087e3eda83573b123448617562da3d770fa9fb
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/default-enable-policy.md` sha256=d971c5fde3984a62a01ed5d069707bad3ee6c5a6da10f80ab1fec58d840ad71e
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/xiaohongshu-memory-rules.md` sha256=d42bcff55c8cd56e4efa40524ad9b16c8b1e6ab63cc5487e32ef77614c1375b7
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/summary-inflow.md` sha256=5f76ef672f4b78d6f46cfc8cd69d7d75c6aa965c2a3f942381b77a8c41c7f509
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/runner-patrol-rules.md` sha256=fb3479d4b6355e6778783fcc02db2600e1351a8979207baa1a2dfe7bbe203f11
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/founder-local-time.md` sha256=db3f7d20ef9002d05304618e0258d8c3ac059c7e50aa6ba18e1446b5cee83be8
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/founder-only-authority.md` sha256=64f6b785e52fba2097fdd3b5de04af06a2ca2925852bb04f6bb95a3df9048385
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/founder-html-delivery.md` sha256=c3347b2f94d6de678e8e3f14233ca93069c367b943bf706f06fddf033ab56edc
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/cross-dept-channel-rules.md` sha256=01b5f22f576f20086b4fabcf1516372fc354ca6fcf2bbf9760957e23b7d21004
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/../lead-rules-base/discord-reply-contract.md` sha256=e82fe7bfb5d71d4aefe64d81fac665b36e1aeb32570ce17c0b4c1160a0ea9172
  - `$HOME/Dev/flywheel/packages/teamlead/scripts/screencapture-l3-skill.md` sha256=ce9bfdd71a6d9b9050d032c8aff88c9e5cc6ee6c3c1a7632804e8ac2f25752db

Skills（installed source，不推导当前角色启用）：

- `analyzing-user-feedback`: `$HOME/.claude/skills/analyzing-user-feedback/SKILL.md`
- `chrome-repair`: `$HOME/.claude/skills/chrome-repair/SKILL.md`
- `codex`: `$HOME/.claude/skills/codex/SKILL.md`
- `codex-image`: `$HOME/.claude/skills/codex-image/SKILL.md`
- `competitive-analysis`: `$HOME/.claude/skills/competitive-analysis/SKILL.md`
- `computer-bootstrap`: `$HOME/.claude/skills/computer-bootstrap/SKILL.md`
- `deep-research`: `$HOME/.claude/skills/deep-research/SKILL.md`
- `defining-product-vision`: `$HOME/.claude/skills/defining-product-vision/SKILL.md`
- `dogfooding`: `$HOME/.claude/skills/dogfooding/SKILL.md`
- `flywheel-land`: `$HOME/.claude/skills/flywheel-land/SKILL.md`
- `founder-html-delivery`: `$HOME/.claude/skills/founder-html-delivery/SKILL.md`
- `gemini-image`: `$HOME/.claude/skills/gemini-image/SKILL.md`
- `gemini-video`: `$HOME/.claude/skills/gemini-video/SKILL.md`
- `last30days`: `$HOME/.claude/skills/last30days/SKILL.md`
- `notion`: `$HOME/.claude/skills/notion/SKILL.md`
- `prioritizing-roadmap`: `$HOME/.claude/skills/prioritizing-roadmap/SKILL.md`
- `problem-definition`: `$HOME/.claude/skills/problem-definition/SKILL.md`
- `product-brainstorming`: `$HOME/.claude/skills/product-brainstorming/SKILL.md`
- `product-taste-intuition`: `$HOME/.claude/skills/product-taste-intuition/SKILL.md`
- `proofshot`: `$HOME/.claude/skills/proofshot/SKILL.md`
- `scoping-cutting`: `$HOME/.claude/skills/scoping-cutting/SKILL.md`
- `supabase`: `$HOME/.claude/skills/supabase/SKILL.md`
- `supabase-postgres-best-practices`: `$HOME/.claude/skills/supabase-postgres-best-practices/SKILL.md`
- `synthesize-research`: `$HOME/.claude/skills/synthesize-research/SKILL.md`
- `video-watch`: `$HOME/.claude/skills/video-watch/SKILL.md`
- `working-backwards`: `$HOME/.claude/skills/working-backwards/SKILL.md`
- `writing-engine`: `$HOME/.claude/skills/writing-engine/SKILL.md`
- `writing-north-star-metrics`: `$HOME/.claude/skills/writing-north-star-metrics/SKILL.md`
- `writing-prds`: `$HOME/.claude/skills/writing-prds/SKILL.md`
- `xiaohongshu-deep-learning`: `$HOME/.claude/skills/xiaohongshu-deep-learning/SKILL.md`
- `xiaohongshu-learning`: `$HOME/.claude/skills/xiaohongshu-learning/SKILL.md`

Installed plugins（enabled 未验证）：

- `claude-md-management@claude-plugins-official`
- `code-review@claude-plugins-official`
- `code-simplifier@claude-plugins-official`
- `codex@openai-codex`
- `context7@claude-plugins-official`
- `discord@claude-plugins-official`
- `discord@flywheel-plugins`
- `everything-claude-code@everything-claude-code`
- `figma@claude-plugins-official`
- `firebase@claude-plugins-official`
- `frontend-design@claude-plugins-official`
- `linear@claude-plugins-official`
- `matt-skills@matt-skills`
- `minimalist-entrepreneur@minimalist-entrepreneur`
- `playwright@claude-plugins-official`
- `pr-review-toolkit@claude-plugins-official`
- `security-guidance@claude-plugins-official`
- `serena@claude-plugins-official`
- `skill-creator@claude-plugins-official`
- `superpowers@superpowers-dev`
- `typescript-lsp@claude-plugins-official`

## 验证界限

Fixture tests 覆盖 secret canary 不输出、P01–P17 全列、configured != tools/list、缺失输入明确、非法模式/identity 拒绝、route mount/method/guard 源提取。C1 的源码差集已经可审查；完整 live tools/schema 与 active 规则还没有证据，继续属于未验收。所有 PR 能力行保持未勾选。
