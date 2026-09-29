# FLY-3055 QA 一轮测全 + 判据清单 — 探索
Issue: FLY-3055 (https://linear.app/geoforge3d/issue/FLY-3055/机制qa-一轮测全问题一次列全再判复验只验改动部分实现体修问题要补相邻路径-写进协议-qa-result-判据清单强制校验founder)
日期: 2026-09-29
基于: 无

## 1. 问题（founder 2026-09-28 直令）

> 「QA 能不能一轮把所有的问题都抓出来，省得它搞出个三四轮的 fail？」
> 「光告诉它没用，过两天又忘了。必须做成机制。」

证据（9-25 至 9-28 复盘）：9-28 一天 QA 判 53 次 FAIL / 9 次 PASS；FLY-2886 被判 23 次 FAIL；FLY-2861 四轮 FAIL 每轮只抓一个问题；QA 碰到第一个阻断就停，后面的项要等下一轮；复验把上一轮已 PASS 的项全部重跑（真房一次 1–2 小时）；实现体只修 QA 报的那一个场景，修出新问题。

四条规矩要「做成机制」而不是只改文字：

1. **一轮测全**：一轮把判据里能测的全部测完，所有问题一次列全再判；⛔碰到第一个阻断就停。
2. **复验只验改动**：上一轮已 PASS 的项直接引用证据（claim id / 报告），不重跑；小修 + 有测试 + 精确头 CI 全绿 → 真房复跑豁免。
3. **实现体补相邻路径**：修 QA 报的问题时，同一段逻辑的相邻状态路径一起补测试，交卷说明列出。
4. **qa-result 结构化校验（关键）**：verdict 带判据清单，每条 `pass | fail | not_run | carried`；`not_run` 必须写原因、`carried` 必须引用上一轮 claim id + 证据；FAIL 时有判据既没测也没写原因 → CLI 拒收；下一轮开局 Bridge 注入上一轮清单。

## 2. 现状审计（本仓库代码事实）

本仓库是 QA 沙箱快照（`origin = xrliAnnie/flywheel-qa-sandbox`，HEAD `1855f7a1a`），比生产 Flywheel 旧。审计只认本仓库的字节。

### 2.1 协议文本从哪里进 prompt

issue 点名的三个文件在本仓库**不存在**：

| issue 点名 | 本仓库现状 | 等价落点（本设计采用） |
|---|---|---|
| `packages/teamlead/phase-protocols/qa.md` | 目录不存在，也没有 `workflow-phase-protocol.ts` 加载器 | QA 的有效 prompt 字节在 `packages/edge-worker/src/Blueprint.ts`：① `buildQaModeSystemPromptLines()`（auto-QA，`:395-473`）② 三阶段 QA 段（`:1149-1190`，含 5-fb kickback） |
| `.flywheel/agents/nodes/qa.md` | 无 `nodes/` 目录 | `.flywheel/agents/engineering/qa-executor.md`（`config.yaml` `agents.qa.agent_file`） |
| `packages/teamlead/phase-protocols/implement.md` | 不存在 | Blueprint 三阶段 implement 段 + `## QA Fix Round` 块（`:1127-1147`）；`.flywheel/agents/engineering/engineer-executor.md` |

旧表述（验收要求「已改」）：`qa-executor.md:27`「On FAIL, hand specifics to the dev Runner and re-verify after the fix」；Blueprint `:449` `--summary "<what you tested + verdict + any blocking issue>"`（隐含「一个阻断即 FAIL」）；`:461/:1171` 「report qa-result fail with a specific report (exact scenario / expected-vs-actual / severity)」——单数「scenario」，没有「测完剩下的再判」。

### 2.2 qa-result 链路

`packages/flywheel-comm/src/commands/qa-result.ts`（285 行）：`--status --target-exec --summary --pr-head --exec-id`，**没有清单**。两条投递路径：

- 有 `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL` → `POST /api/workflow/decision`（`workflow-decision-routes.ts:138-283`）→ `submitWorkflowDecisionByCredential`（`StateStore.ts:10481`，一条 SQLite 事务写 `workflow_claims`，`evidence = {summary}`）→ `insertEvent(qa_result)` → `phaseOrchestrator.onQaResult`。credential 只在 `run-dispatcher.ts:966-981` 为三阶段 QA 且有 shadowContext 时铸造，且 `isWorkflowClaimsWriteEnabled` 默认 OFF（`workflow-claims.ts:118`）。
- 否则 → `POST /events`（bearer）→ `event-route.ts:564-605`：reporting 会话 `chat_thread_role==='qa'` → `PhaseOrchestrator.onQaResult`（三阶段）；否则 → `AutoQaCoordinator.onQaResult`（legacy auto-QA，`auto-qa-coordinator.ts:1141`）。event-route 头部已有按 `event_type` 做 400 预校验的先例（`account_rotation`，`:103-112`）。

本沙箱 `config.yaml`：`qa.auto: true`，无 `pipeline.three_stage`（三阶段默认 OFF，`plugin.ts:7002`）。**默认活跃路径是 legacy auto-QA + `/events`**，claims 账本不写。设计若只做 credential 路径，机制在本沙箱默认配置下是空的。

### 2.3 上一轮信息现在怎么传

三条 QA 循环，七个「下一轮开局」出口，全部只传 `summary` 自由文本：

| 循环 | 出口 | 位置 | 现在传什么 |
|---|---|---|---|
| auto-QA（FLY-752 同一 QA 复用） | retest wake（QA） | `auto-qa-effects.ts:629-690` `retestWakeQa` | 新 head + 「re-run your QA scenarios」 |
| auto-QA | feedback wake（实现体） | `auto-qa-effects.ts:403-424` `feedbackWakeMain` | `summary` |
| auto-QA | 死 QA 重起（QA） | coordinator `onMainAwaitingReview` → `startDispatcher.start({qaContext})` | `QaContext{parentExecutionId, prHeadSha, ...}` 无上一轮 |
| 三阶段 keep-alive | retest wake（QA） | `plugin.ts:6813-6850` `wakePhaseRunner kind=retest` | 新 head + 「re-run your QA scenarios」 |
| 三阶段 keep-alive | fix wake（实现体） | 同上 `kind=fix` | `qaSummary` |
| 三阶段 keep-alive OFF | Implement-fix 新起 | `phase-orchestrator.ts:1316-1336` `phaseFixContext{round, qaSummary}` → Blueprint `## QA Fix Round` | `qaSummary` |
| 三阶段 | QA 重起 | `phase-orchestrator.ts:527` `respawnUnenrolledQa` / FLY-1050 respawn | 无上一轮 |

上一轮 verdict 的持久化落点：credential 路径 = `workflow_claims.evidence`；`/events` 路径 = `session_events.payload`（`getLatestQaResultEventForExecution`，`StateStore.ts:3373`）；auto-QA 还有 `auto_qa_record.verdict_event_id`（每次 verdict 更新，record 跨 head retarget 时 PK 原地改，`:5276`）。

### 2.4 上游已落地形态（参照，不照搬）

生产 Flywheel（QA 房 src）已有 `qa-criteria/v1`：`packages/config/src/qa-criteria.ts`（schema/判决/引用规则）、`workflow-qa-criteria-context.ts`（唯一注入入口）、`phase-protocols/qa.md §One-round verdict` 与 `implement.md §QA fix rounds`。它建立在本仓库没有的东西上：`workflow-engine-dispatcher`、run snapshot 固化协议、legacy auto-QA 已删除。本设计**沿用同一套词汇与 JSON 形状**（`qa-criteria/v1`、五种状态、`--criteria-file`、拒收 reason 名），这样沙箱 QA runner 写的清单文件与生产同形；但注入出口、prior 解析、校验位置按本仓库的三条循环重做。

## 3. 需要回答的问题

| # | 问题 | 结论（详见 research.md） |
|---|---|---|
| Q1 | 清单存哪？新表还是复用？ | 不建新表。credential 路径存 `workflow_claims.evidence.qa_criteria`；`/events` 路径存 `session_events.payload.qa_criteria`。两处都是现有「verdict 的唯一真相」，读回即得。 |
| Q2 | legacy 路径没有 claim id，`carried` 引用什么？ | 引用 **Bridge 注入的上一轮 verdict 引用**：credential 路径 = claim id（数字），`/events` 路径 = 上一轮 `qa_result` 的 `event_id`。schema 里 `claim` 收 正整数或字符串，服务端只认「等于注入的那个」。 |
| Q3 | 校验放哪才「不靠自觉」？ | 三层：CLI 预检（形状 + 判决规则，零网络零 marker）→ Bridge 路由前置（两条 ingest 都在写库前拒）→ credential 路径在写 claim 的事务内复核。 |
| Q4 | 七个出口怎么不漂移？ | 一个纯函数入口 `resolveQaCriteriaContext(store, {qaExecutionId,...})` → `{qaBlock?, fixerBlock?}`，七个出口只做拼接。 |
| Q5 | 旧 QA（部署前已在跑）怎么办？ | 它交 verdict 会被 `qa_criteria_required` 拒，stderr 带最小示例；这是刻意的「机制立即生效」。 |
| Q6 | 三阶段 keep-alive OFF 时 QA 是新 exec，prior 怎么找？ | 按 issue 下所有 `chat_thread_role='qa'` 阶段会话的最新 `qa_result` 事件（排除当前）。 |

## 4. 方案候选

| 方案 | 做法 | 否决理由 |
|---|---|---|
| A 只改协议文本 | Blueprint / role 文件加规矩 | founder 原话「光告诉它没用」；没有拒收就没有机制。 |
| B 清单塞进 `--summary` 自由文本 | 约定格式，Bridge 正则解析 | 解析脆弱、无法拒收「没写原因」、注入时无法区分状态。 |
| **C 结构化清单 + 三层校验 + 统一注入（采用）** | `--criteria-file <json>`，`flywheel-config` 共享 schema，CLI 与 Bridge 同一规则；Bridge 从 verdict 持久化落点读上一轮并注入七个出口 | — |
| C′ 新建 `phase-protocols/` 目录 + 加载器 | 让文件名与 issue 一致 | 本仓库没有协议加载机制，新造一套超出 issue 范围；有效 prompt 字节在 Blueprint，改那里才是「改协议」。已非阻塞问 Lead，无异议则按等价映射。 |

存储候选：新表 `qa_criteria_round` vs 复用 verdict 落点。复用：零迁移、verdict 与清单原子写入、rollback 无残留；新表要多一次写且与 claim/event 可能不一致。选复用。

## 5. 决定与假设

- 词汇与生产对齐：`qa-criteria/v1`、状态 `pass | fail | not_run | carried | merged`、拒收 reason `qa_criteria_*`、提示语「先把剩下的判据测完或写明为什么没测」。`merged` 保留（退役旧判据不丢账），首轮禁止。
- 只对 **QA verdict** 强制；`codex-review-result` 等其他 verdict 不带清单。
- 不设 feature flag：founder 要的是强制机制，开关是后门。回滚 = revert。
- 假设 A：Lead 接受 §2.1 的等价映射（非阻塞已问）。
- 假设 B：529 真房复验在本沙箱走 legacy auto-QA 路径（`qa.auto: true`）；设计对三条循环一视同仁，任一路径都能拿到注入。

## 附：新增范围审计（2026-09-29，founder 07:12 直令 + 09:15 澄清）

529 按「改没改 flow」判。本仓库事实：

- 全仓（排除 node_modules/dist）grep `e2e_529`、`room drill`、`Discord-capable`、`evidence-run` 在源码与角色文件里零命中；`packages/flywheel-comm/src/commands/` 没有 `room` 命令。issue 说的「Discord-capable changes → run 529 / No Discord surface → exempt」段落在 `qa-executor.md` 不存在（只有一行 Real-machine E2E）。
- 因此本仓库的工作是**新增**流程门规则与机器校验，不是改写旧段落；evidence-run 记录核对没有存储可接，设计为可选接口（plan §2.1、R-j）。
- 门的开关：`readAgentFile` 在 Blueprint `:1866` 才读角色文件，晚于 `session_started` 发出（`:661`），所以「spawn 时把标记写进会话」会有竞态；改用既有 `auto-qa-config-source.ts`（读项目主线根目录配置，runner 改不到）加一个 `qa.e2e_529_flow_gate` 键。
- issue 顶部 Lead 裁定里的 `room_timeout_contract`（上限 3h）、`real_529_negative_control`、`second_round_carry` 依赖 room 基建，本仓库没有，不在设计范围（plan R-l）。
