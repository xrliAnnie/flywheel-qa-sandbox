# FLY-2606 模板与 Lead 参数热生效 — 调研
Issue: FLY-2606 (https://linear.app/geoforge3d/issue/FLY-2606/热生效-founder-2026-09-16-0038z改模板effort-要等重启才生效本来就有问题-工作流模板从仓库种子发布到)
日期: 2026-09-15
基于: exploration.md

## 结论

模板的存储、CAS（仅当前版本仍等于读取版本时才写）、不可变历史和人工版保护均已具备。缺口是可审计的 seed/file CLI，以及精确重试、完整发布原因和旧 run 保护。Lead 缺口在进程内部会话设置，不在 projects.json 是否已写好。

基线为 `6556b0751`。本调查只读源码、生成本机协议 schema；未连接生产模型、未写生产 DB、未测试热更新实现。方案依赖的真实运行效果留给实现后的隔离验收。

## 模板生产者与消费者

| 文件与定位 | 当前合同 | 对本次的影响 |
|---|---|---|
| `packages/teamlead/src/bridge/workflow-template-routes.ts:26-90`；`bridge/plugin.ts:2287` | `/api/workflow/templates`、详情、版本、binding，专用 router 只有 GET | 保留旧 URL；验收 URL 增加只读 alias，共用处理器 |
| `bridge/plugin.ts:2837-2872,6090-6108` | 受管管理台 stage/apply 注册 DAG writer | 不是“完全无写 API”；full manifest 需扩展现有 authoring 服务 |
| `bridge/management-dag-writer.ts:105-166` | 单节点 model/effort 修改，固定一次 modelSnapshot，支持修复历史模型拼写 | CLI 不能通过重复改节点冒充完整发布；共享校验/事务边界 |
| `StateStore.ts:29363-29476` | revision + publication + pointer + audit 同事务；expectedRevision CAS | 扩充审计与操作幂等结果，同事务失败全部回滚 |
| `StateStore.ts:29479-29539` | 旧 revision 指针发布，不再验证旧 manifest | rollback 应把旧内容重新校验并发布新 revision |
| `StateStore.ts:29542-29580,29787-29879` | 非 system 发布成为 founder-owned；seed importer 和 FLY-2121 保留人工版 | 手动 `--from seed` 也不能用 system actor；digest 不能代表时间顺序 |
| `bridge/plugin.ts:5433-5477`；`workflow-menu.ts:382` | 启动编译 seed；启动 migration 早于监听/派工 | publish 应按请求编译并冻结内容，不复用启动数组 |
| `workflow-template-selection.ts`；`StateStore.ts:30986` | 新 run 按当前发布选择，并在 materialization 校验 expected selection | 发布与派工竞争必须全部是旧版或全部新版，不能混合 |
| `workflow-run-snapshot.ts:503-519` | 当前节点都写 dispatchPinned=true | 现代 run 后续节点读固定 dispatch |
| `workflow-dispatch-resolution.ts:95-158`；测试 `workflow-dispatch-resolution.test.ts:387-411` | 历史未 pin 的快照有 live_template 兼容分支 | 发布前对目标 active/held run 加阴性守卫；不改老快照 |

### 现成管理授权不是 founder 批准

`bridge/plugin.ts:2911-2972`、`flag-routes.ts:353-365` 和 CLI `commands/feature-flags.ts:171,255-294` 使用 loopback Host、same Origin、一次 SHA 绑定 token。普通写入 actor 是服务端 `bridge-local-operator`。Host/Origin 不证明某个自然人或 Lead 身份，也不构成隔离同 UID 模型的强边界。`fleet-admin.ts:138-174` 的 token 在内存、60秒过期、用一次即销毁，不能承担重试 receipt。

本次采用相同 local-operator authority，不新增“已由 founder 审批”的暗示。actor 固定服务端 principal；reason 记录操作意图，客户端 label 如保留必须标为 unverified。生产发布仍遵循任务规定的 founder→Lead 运行权限。

## Lead authority 与 FLY-2602 衔接

- `packages/flywheel-comm/src/summary-registry-migration.ts:473-493` 实际比较 `summaryAssignmentDigest` 投影；不是全文件 SHA。`lead-identity.ts:108-125` 明确排除 model/effort/modelContextWindow 的 v1 identity digest。新机制不得重铸身份收据。
- `packages/teamlead/src/lead-model-launch.ts:42-112` 以及 `scripts/claude-lead.sh:1944-2028` 在每次物理 launch 解析实时 registry，并处理模型能力及默认值；不是运行中每轮解析。
- `lead-backends/codex/codex-lead-runtime.ts:718-754,1094-1130` 从 env 构建启动时 thread params。TUI runtime `codex-lead-tui-runtime.ts:905-1060` 在 thread/start/resume 使用这份对象。
- `CodexLeadProcess.ts:413-433` 的 startTurn 当前只转发 input 与 correlation；`CodexTurnExecutor.ts:129-173` 只覆盖 router 发起 turn。自主 goal、手动 TUI 不通过它（另见 `doc/architecture/codex-lead-turn-observation.md`）。
- `CodexLeadInboxSocket.ts:1-125` 已有 owning-sidecar 的 HMAC Unix socket 与能力协商，可扩展参数重载命令；不能让 Bridge 直接改 sidecar journal 或独立重建 thread。
- `management-existing-writers.ts:376-389,517-566` 当前仅 Claude Lead 可写且调用重启 Fleet engine，Codex 是 readonly。故不能把“复用 fleet apply”当成已有 Codex 热写能力。
- `scripts/flywheel-config-lock.sh:1-57` 是现有 projects.json 写锁；参数编辑必须使用同一 `.cfglock`，从同一 preimage 生成候选、校验并原子 rename。

### 最新 Lead 裁定

Question `85b26eff-69c9-4986-966b-12148f4381dc` 的答复：2602 只做一次性模板迁移与直改 runbook；Raya effort=high 已由 Lead 主机直改并 verify-activation ok:true。2606 独立负责机制，覆盖 router 与 /goal 自续，不动生产。这里记录的是 Lead 回执事实，不是本节点对生产生效的验证。

## Codex 原生协议证据

本机 `codex --version` = `codex-cli 0.153.2`。运行 `codex app-server generate-json-schema --experimental --out /tmp/fly2606-codex-schema` 成功：

| 方法/通知 | 本机 schema 字段 | 语义 |
|---|---|---|
| `thread/settings/update` | threadId, model, effort | 更新后续 turn 的设置，不需发模型消息 |
| `thread/settings/updated` | threadId, threadSettings | 应用后的会话设置通知；不同于空 RPC response |
| `turn/start` | threadId, input, model, effort | 当前和后续 turn override |

本机 `/Users/xiaorongli/Dev/codex-oss` 源码仅用于协议研究，**不是此次修改目标，也不是部署二进制同源证明**：`app-server/src/request_processors/turn_processor.rs:825-870` 只提交 core operation 后返回；`core/src/session/handlers.rs:90-114` 应用后才发 ThreadSettingsApplied；`app-server/tests/suite/v2/thread_settings_update.rs:33,167` 含后续 turn 和 active-turn 更新测试。真实 binary 对 goal continuation 的行为仍需隔离 QA。

[OpenAI App Server 官方文档](https://learn.chatgpt.com/docs/app-server)确认 turn/start 的 model/effort 可成为后续默认，以及 turn/steer 不接受配置 override。公开页面未找到 thread/settings/update，因此本计划把该能力视为本机实验协议，要求版本/能力探测、收到匹配应用通知、真实下一 turn 参数记录三层证据；不能只依赖网页或本地源码。

## Claude 边界研究

本地 Claude 源 `src/utils/settings/applySettingsChange.ts:70-90` 可把文件 effortLevel 变化同步到会话；它不同时刷新 mainLoopModel，且 --model/session override 有优先级。因此“改 settings.json 就覆盖两字段、每 turn 生效”尚无证据。不可借终端输入 `/model`、重启会话、或偷偷改模型 prompt 作为兜底。Lead 已通过 question `4fbfd625-1300-4984-aa4b-33911d0502e0` 裁定：本单强制覆盖Codex常驻Lead，Claude热入口明确unsupported并另开跟进；接受active历史unpinned run拒绝发布，本设计不设绕过。

## 推荐验证

1. 独立 DB 上发布、丢响应重试、rollback、旧种子重启；断言 revision/publication/audit/receipt 原子性。
2. 保留一个既有 run 在 design，发布后启动其 implement；实际 admission dispatch 仍旧。另起 run 的 snapshot/dispatch 为新；历史 unpinned active/held run 必须拒绝发布。
3. 隔离同一进程、同一 thread 的 Codex Lead：router turn、手动 TUI turn、自主 goal continuation 各一次；变更发生于 active turn 期间；当前 turn 参数不变，应用通知后的下一 turn 使用新值。
4. source commit、runtime apply、actual turn 分别保存 receipt；失败、离线和超时显示 pending/unavailable，不能报 applied。
5. 回滚仍走新操作、CAS 和热应用，不还原整个 DB 或 projects.json 全文件，不覆写并发他人变更。

本地Codex TUI源码 `tui/src/chatwidget/settings.rs:353-366` 会将同thread的settings/updated应用到界面状态；这为手动turn不覆盖回旧值提供设计依据，仍需实际binary的TUI试验。通知中字段是threadSettings.effort，thread/read返回thread.reasoningEffort；两者不能混用。

## R1评审补证与修正

- `canonical-lead-identity.sh:138-140` 当前会对model/effort/contextWindow作严格env等值断言；`flywheel-daemon.sh:356-359`从manifest投影这些env。旧manifest或已加载launchd env并非纯展示，因此仅改projects可能让后续启动失败。plan §3.6明确只让Codex可变model/effort改读registry，其余身份断言保留；冷启动和重连均要验首轮。
- `StateStore.ts:13498`已有live-set使用status IN ('active','held')；held可恢复。发布守卫应覆盖两种状态，而非只查字面active。
- `CodexLeadInboxSocket.ts:595-627` HMAC按method列字段；新方法必须各有完整规范化分支。`backend-migration-config-lock.ts`已有Node持锁握手，lead-registry.ts已有no-follow/atomic rename/fsyncDirectory，应复用而非再写一套。
- TUI是会话参数的并发写入者；registry未变不证明实际设置未变。plan §3.7记录当前drift及历史证据的区别，不把来源不明通知认作founder。
