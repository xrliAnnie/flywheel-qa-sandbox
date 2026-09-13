# FLY-2459 Codex 部门 Lead — 调研
Issue: FLY-2459 (https://linear.app/geoforge3d/issue/FLY-2459/2441-能派-runner-的部门-lead-跑-codex-后端补-codex-lead-动作面的-startmanage-runner)
日期: 2026-09-10
基于: exploration.md

## 结论

标准 Codex Lead 已存在；本单是补齐部门 Lead 的动作和迁移接缝。采用显式 `codexRunnerActions`，共用一份 runner 工具定义，在 `write-capable` 的 gateway 和 `full-access` 的 lead_actions 分别挂接。Honey Lemon 使用现成可见 TUI/full-access carrier。跨厂商切换使用工单允许的受控手动路径；管理台提供准确状态和操作指引，不开放未经实现的在线切换。

本调研是设计输入，不是实施或生产验收。用户已授权完整设计工作流，后续统一进入有效 design review，无额外 brainstorm gate。

## 证据范围与当前状态

- 仓库起点 `d964e9fca`，2026-09-10；仅只读审计产品代码、生产 registry 的非秘密字段和 `/api/fleet/snapshot`。
- GitHub 读取确认 FLY-2445 #1134 已于 2026-09-09T17:17:19Z 合入。当前仓库已有其公共 Lead carrier、mailbox、outbound 与 cursor migration。合入不等于部署。
- 当前 registry：`flywheel-product-lead` 的 backend 未填写（有效值 Claude），`model=opus[1m]`, `effort=high`, `canSpawnRunners=true`, 没有 codexProfile。
- 当前 fleet：`flywheel/flywheel-product-lead`, `backend=claude-code`, `backendWritable=false`, `dispatch.current={provider:anthropic,model:claude-opus-5[1m],effort:high}`。
- 该 snapshot 的 current 是 projects.json 投影，不能单独证明活动进程。真正的上线证据须另采运行线程与 pane。
- 当前环境无 `TEAMLEAD_API_TOKEN`，未直接刷新 Linear 描述；范围采用本次完整 issue 注入，依赖合入状态采用 GitHub 当前数据。不输出/复制任何凭证。

## 准入与配置消费者

| 文件与锚点 | 事实及含义 |
|---|---|
| `packages/teamlead/src/ProjectConfig.ts:758` | canSpawnRunners 缺省归一为 true；不能用它替代新显式开关 |
| `packages/teamlead/src/ProjectConfig.ts:951` | 校验 profile，并在 972 排除派 runner 的 Codex Lead |
| `packages/teamlead/src/bridge/fleet-capabilities.ts:116` | 第二份 canSpawnRunners=false 准入判断 |
| `packages/teamlead/src/resident-codex-lead-roster.ts:15` | 专用patrol还要求codexResidencyPatrol=true；本单不启用、不修改其范围 |
| `scripts/resident-codex-lead-recover.sh:94–113` | 只认Mufasa/InfraBot专用wrapper且有false限制；generic不在支持名单，本单不改，不声称Honey Lemon受其自愈覆盖 |
| `scripts/lib/lead-restart-lifecycle.sh:558` | generic carrier 识别镜像 false 条件；漏改会令班车拒绝新 Lead |
| `packages/flywheel-comm/src/commands/lead-registry.ts:1269` | selector 是 shell 消费共享身份/准入结果的适合出口 |
| `packages/flywheel-comm/src/lead-registry-add.ts:99` | 新建 Lead 目前默认不能派 runner，Codex 默认 full-access；保持开关缺省 false |

低层纯 resolver 应置于 `packages/config`，避免 teamlead 与 comm 相互依赖。输入只含 backend/profile/companion/canSpawnRunners/explicit flag，输出 eligible/enabled/reason；ProjectConfig 校验原始字段后调用。脚本用可信编译后的 selector，不复制 jq 真值表。现有 external、PM/triage、companion 限制保留。

## 两条工具路径

| 路径 | 当前实现 | 本单接缝 |
|---|---|---|
| write-capable headless（测试/低层） | `codex-lead-runtime.ts:1409` gateway + broker | 条件扩展既有 gateway 工具集，完整库存断言 |
| full-access headless/TUI | `codex-lead-runtime.ts:985`, `codex-lead-tui-runtime.ts:1046` lead_actions，无 gateway/broker | 同一工具实现挂 lead_actions；只验证该 MCP server 的工具集 |
| generic 生产 launcher | `scripts/flywheel-lead.sh:169,230` 固定可见 TUI/full-access | Honey Lemon 使用此路径 |
| companion | 不获得本单 runner 动作 | 保持原样 |

- `action-surface.ts:55` 基础 gateway 工具五个：request_runner_lifecycle / relay_ship_decision / discord_send / git_push / open_pr。
- `lead-actions/mcp-config.ts:8` 基础工具两个：discord_send / ack_batch；`lead-actions-main.ts:35` 有固定数量断言，mcp-config 330 也固定 enabled_tools。
- `codex-lead-runtime.ts:1674` 只对 write-capable 做真实 inventory 精确比较；TUI 不支持 write-capable（997）。TUI 573–577/689–697明确移除了live-ready watcher：MCP每turn临时拉起，旧30s超时闸曾误拆Mufasa。本单延续full-access静态config gate，不能等待启动期advertisement。
- full-access 明确允许网络与本地 shell；新开关是受管工具曝光和 handler 的边界，不是对既有 full-access 全部系统权限的隔离保证。

## 身份、授权与环境传递

`lead-identity.ts` → `commands/lead-identity.ts` → `canonical-lead-identity.sh` → runtime/MCP 是现有链路。新增开关只沿IdentityLeadRow/selector/env独立投影传递，不添加到CanonicalLeadIdentity；v1IdentityDigest会摘要model/effort/context以外的所有字段，新增false属性也会改变其他Lead的摘要。保持v1输入字段及序列化顺序逐字节不变，MCP子进程重读raw row验证开关，启动器清掉继承覆盖值。

`authorizeLeadWrite` (`packages/flywheel-comm/src/lead-lease.ts:2633,2795`) 在任何 rollout/audit 模式之前校验完整 canonical identity，包括 backend、Lead key、summary role/digest、Discord identity/stateDir、identityDigest。不能只传 leadId。runtime 在 app-server 启动时登记 carrier assertion（`codex-lead-runtime.ts:1557`），MCP 需要可信 carrier/lease 上下文；不允许“缺字段时关闭租约验证”。

当前 gateway env allowlist（runtime 1439）与 full-access MCP env builder（990）都缺完整消息写入授权字段；TUI renderer（`packages/teamlead/scripts/codex-lead-tui-home.sh:724`）还有镜像配置。实现应共用 builder 的 CLI 投影，且保留精确 env_vars 校验。网关秘密仍只经 broker；full-access 使用现有 credential 名字传递，不能写入 TOML 明文或工具结果。

Honey Lemon 的 generic launcher 已选择 bridge outbound。对 direct outbound 的 full-access 若开启 runner 工具，需在 existing Discord token 之外传 Bridge credential 名字；采用需要项并集，避免把 direct 老用户强制迁为 bridge。缺 runner credential 时整个 opted-in 启动失败，off/direct 的原行为不变。

## Runner API 与去重

`packages/teamlead/src/bridge/runs-route.ts:1382` 是唯一 start dispatcher；`plugin.ts:4723` 挂认证。工具固定 projectName、leadId、sessionRole=main，只让模型给 issueId/taskCategory/idempotencyKey。

- `work-kind.ts` 是 taskCategory 的规范类型；真正可选项来自每Lead `resolveLeadMenus` 的adopted集合。Honey Lemon当前菜单为prd/product_design_flow/prototype；工具描述/schema投影这个集合，call-time重读。菜单准入（2708）拒绝缺 category、未采用菜单和模板覆盖。本单不硬编码菜单值，不修改 implement 模板。
- Linear label 在 Bridge 1900 重新读取；1996 调 DepartmentRegistry，越部门返回 403 `DEPT_SCOPE_REJECT`，保持 FLY-127。
- 同 role 已有 runner 返回 409（1839）；不同显式 key 对活动 workflow 返回 KEY_MISMATCH（2540）。不自动 freshStart，不另开执行。
- 429 admission_paused/load pressure在dispatcher之前return（1869–1883），是refused，可返回Retry-After并由Lead稍后同key调用，wrapper不自动POST。
- 202 `LAUNCH_PENDING` 携 executionId、retryable:false（3741），表示启动所有权可能已存在。
- 409 `WORK_KIND_ROUTE_LAUNCH_EVIDENCE_MISSING` 可以发生在实际 launch 之后（3912、4300）。旧 gateway 的 `mapHttpDispatchOutcome` 仅适用于 retry handler，不能复用于 start。
- 输出分 started/pending/refused/unknown。网络异常、5xx、未知 4xx 和上述 launch 后拒绝都保留不确定性；返回原 key/execution 供只读对账，不自动重新 POST。
- canonicalSubmissionDigest已包含taskCategory/categorySource/tier（runs-route:3115），claimWorkflowRouteDecision冲突在priorResponse之前返回WORK_KIND_ROUTE_DECISION_CONFLICT（3153），本单不改dispatcher/replay逻辑。
- `StateStore.ts:31513` 的 `workflow_run_event.kind=issue_delivery` 有 run/node/activation 与 body digest，真实验收需该绑定事件及 live runner，不能用 prepared 代替。

## 读、发指令、答问题

- `bridge/tools.ts:152` GET /api/sessions 支持 leadId；只过滤 Lead 不足以防同 ID 跨项目，工具再限制 projectName。
- `tools.ts:252,297,369` 单条 session/capture/status 不做 lead scope，且 session 支持 issue-id fallback；工具需 exact executionId，并用 `lead-scope.ts:51` 的 matchesLead + project 等式先验证，不将 issue alias 当 exact target。
- send 是 Comm helper（`commands/send.ts:18`），无通用 Bridge send endpoint。它 authorize → insertInstructionWithId → clearDeclaredState → finally close；给共享 helper 添加可选稳定 ID，再从 package 导出。不得 shell/tmux 发文字。
- `db.ts:4297` 已有稳定 instruction ID 与 sender/recipient/content/provenance 相等去重。换身份/内容重用 ID 拒绝，不冒充成功。
- respond 已导出。读取问题真实 owner/checkpoint 后调用 `respond`，带 expected owner/checkpoint；其事务 guarded insert 拒绝过期/关闭/改属/conflict。
- reserved checkpoints 实际有四个（`db.ts:2357`）：approve_to_ship、review_design、founder_review、review_code；普通 respond 全拒绝。不把自然语言“批准”转成授权记录。
- queued 只说明入箱，不说明 runner 已消费。读取结果中 pane 状态也不等于 workflow 完成。

## 管理台与模型

`management-topology-source.ts:85` 的 selection 来自 registry；105 固定 backendWritable=false，`management-console-contract.ts:165` 类型也是 literal false。writer（`management-existing-writers.ts:498`）、fleet shell 和 batch 继续拒绝跨厂商更改；本单替换过时原因并提供手动迁移 runbook 链接。

Astra canonical ID 来自 `packages/config/src/model-builtins.ts:300`：gpt-6-astra，alias astra。当前 surfaces 只有 runner/workflow；将来若要 selectable Lead catalog，必须在这份目录添加 lead surface。首实例手动路径直接保存 canonical ID/high；不需要开放管理台模型编辑。旧 fleet 的 GPT-5 固定 display 应改为实际 registry selection 的只读投影，以免新实例仍标错模型。

## 可恢复迁移

- `lead-registry add` 对同 Lead 不同字段拒绝（218），不是 update，不应删 row 再注册。
- backend 在 identity digest 内（`lead-identity.ts:104`）；model/effort 不在其中。后端更改必须让旧 carrier 退出，再建立新身份租约。
- summary assignment 只投影项目/Lead/role/aggregator（`summary-assignment.ts:11`）；本单不改这些字段，summary digest 应保持原值。前后 verify-activation，不能无理由重建 receipt。
- `${PROJECTS_FILE}.cfglock` 是已有配置写锁；现有 registry command 590–692 给出 candidate 验证、preimage 检查、durable intent 与 atomic write 模式。
- generic install（`scripts/flywheel-lead.sh:735`）拒绝异构旧 plist；`materialize-lead-manifests.sh` 默认保留旧 manifest，全局 force 又超范围。需要 updater 内对本目标做受验证的 manifest/plist swap。
- update-flywheel 仅定时窗口/founder urgent 两种源（2–7），经 restart-services（255）；普通 restart wave 不更换 carrier。新增helper在受锁且admission暂停的wave内只运行到activated、写deployed_unverified并退出。真实@/start/issue_delivery验收须在wave退出且GET /api/admission/pause确认active=false后；否则runs/start429，无法在锁内完成。窗口外verifier仅对账并写本receipt，无控制面动作。
- Discord 无 cursor 会 baseline 到最新（`RestPollDiscordInboundSource.ts:173`），可能漏掉停机时的 @。复用 `seed-lead-inbound-cursor.ts`，覆盖所有实际订阅频道；writerStopped 声明必须有真实进程退出证明。
- 只有连续“已处理完”的 prefix 可当 cutoff；未决副作用不能拿最新收到 messageId 替代。无法证明则停止迁移，不重放未知动作。
- 新 Codex thread 不复用 Claude sessionId。保留 persona、角色、summary/业务状态及已存在 runner；回滚不能倒退游标或删除新派 runner。

## 验证设计

后续 TDD：先显式能力/多消费者/工具 inventory 负例，再 scope + messaging + start 202/409，最后隔离配置/班车迁移逐检查点崩溃与幂等恢复。生产验收另要求真实 #flywheel-core @ → Codex turn → Flywheel-Product issue start → issue_delivery → live runner、越部门403、后续班车重启不回退。

本次 mmdc 对 flow/model/cutover 各首次及规定标准参数重试均因 macOS `MachPortRendezvousServer Permission denied (1100)` 失败。保留三个 .mmd，HTML 按任务允许的 `DIAGRAM PENDING LOCAL RENDER` 明示；不使用远程渲染或 CSS 假图。

## Lead 方向裁定与 profile 复核

问题 `4f1f2716-9fcc-43bb-bb57-eb7f8b03a6f9` 已答复：采用手动迁移、只读管理台指引、显式 opt-in，不等待已 Canceled 的 FLY-264；profile 保持可配置并沿用现行 launcher 默认。只读 registry 复核正确键是 `codex-infra-bot-lead`（不是显示简称 codex-infra-bot），其 codexProfile=full-access、canSpawnRunners=false、effort=high。`scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh` 委托 `run-codex-infra-bot-tui.sh`，后者第75行设 full-access；generic `flywheel-lead.sh:170` 同样使用该当前档位。

## R1 补充边界证据

- `converge-flywheel-bin.sh:81,153` 的FILES与is_first_adoption_name须同时加入新lib/lead-backend-migration.sh，避免首次adoption被误报severe drift。
- `scripts/test-deploy.sh:269,971` 默认TEST_BRIDGE_DEPT_SCOPE_REJECT=off；部门闸台架必须在启动前显式on，并验证实际Bridge进程配置，不能靠父shell事后改env。
- Honey Lemon generic launcher的profile三处full-access约束（flywheel-lead.sh:170,230与lead-restart-lifecycle.sh:566）是当前可用档位，planner接收公共可选参数但必须在生成intent前拒绝非full-access。
- 所有非目标Lead的v1 identityDigest升级前后逐字节相同；只有Honey Lemon实际backend变化造成预期digest变化。
