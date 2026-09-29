# FLY-3055 QA 一轮测全 + 判据清单强制校验 — 探索

Issue: FLY-3055 (https://linear.app/geoforge3d/issue/FLY-3055/机制qa-一轮测全问题一次列全再判复验只验改动部分实现体修问题要补相邻路径-写进协议-qa-result-判据清单强制校验founder)
日期: 2026-09-29
基于: 无

## 1. 问题（founder 直令）

founder 2026-09-28 的原话：「要测就一轮测全，不要在那测一个就打回去」「光告诉它没用，过两天又忘了，必须做成机制」。

复盘证据（9-25 到 9-28）：

| 现象 | 数据 |
|---|---|
| QA 判 FAIL 次数 / PASS 次数（9-28 单日） | 53 / 9 |
| FLY-2886 被判 FAIL 的轮数 | 23 |
| FLY-2861 每轮只抓一个问题的 FAIL 轮数 | 4 |
| 真房复验重跑一次的耗时 | 1 到 2 小时 |

四个根因，每一个都要有对应的机制而不只是文字：

1. **QA 碰到第一个阻断就停**，剩下的判据留到下一轮才测（2886 守卫一出问题，语音房 B2/D2 就没测）。
2. **QA 问题不一次列全**，每轮只报一个，实现体修一个再被打回一个。
3. **复验把上一轮已 PASS 的项全部重跑**，真房一次 1 到 2 小时。
4. **实现体只修 QA 报的那一个场景**，相邻状态路径没补测，修出新问题（2861 第 3、4 轮的 FAIL 都是上一轮修法引出来的）。

## 2. 沙箱仓现状审计（v1.55.0）

本任务在 `flywheel-qa-sandbox` 仓（`doc/VERSION` = v1.55.0）上做设计。issue 文本点名的三个协议文件在本仓**不存在**，下面是实际落点映射。

### 2.1 协议文本的真实位置

| issue 点名路径 | 本仓状态 | 本仓实际承载同一职责的位置 |
|---|---|---|
| `packages/teamlead/phase-protocols/qa.md` | 不存在（目录都没有） | `packages/edge-worker/src/Blueprint.ts` 里 `buildQaModeSystemPromptLines()`（auto-QA 提示词，395 到 475 行）与三段式 QA 段提示词（1150 到 1200 行） |
| `.flywheel/agents/nodes/qa.md` | 不存在 | `.flywheel/agents/engineering/qa-executor.md`（项目 QA 角色）+ `agents/qa-executor.md`（随 Flywheel 发布的默认 QA 角色） |
| `packages/teamlead/phase-protocols/implement.md` | 不存在 | `.flywheel/agents/engineering/engineer-executor.md` + Blueprint 三段式 fix-round 提示词（`## QA Fix Round`，1140 到 1148 行）+ `plugin.ts` 的 `wakePhaseRunner` fix 唤醒文案（6830 行附近） |

旧的「碰到阻断即停」表述在本仓的具体形态：

- `Blueprint.ts:460` auto-QA：`FAIL → report qa-result fail with a specific report (exact scenario / expected-vs-actual / severity)` —— 只要求一个 scenario，没有「测完再判」。
- `Blueprint.ts:1171-1173` 三段式 QA 第 5 步：`On FAIL: commit + push your findings/failing tests ... qa-result --status fail --summary "<exact scenario / expected-vs-actual / severity>"` —— 同上。
- `qa-executor.md:27`：`On FAIL, hand specifics to the dev Runner and re-verify after the fix` —— 复验没有「只验改动」的约束。
- `Blueprint.ts:1144`（fix round）：`fix exactly what they name` —— 明确只修 QA 点名的那一个，与「补相邻路径」相反。

### 2.2 verdict 数据链路（两条通道）

```
QA Runner ──flywheel-comm qa-result──┐
                                     │  (a) 有 FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL
                                     ├──POST /api/workflow/decision──▶ workflow-decision-routes.ts
                                     │       └─▶ StateStore.submitWorkflowDecisionByCredential
                                     │             └─▶ workflow_claims (evidence JSON) + 消费 credential
                                     │       └─▶ insertEvent(qa_result) ─▶ PhaseOrchestrator.onQaResult
                                     │
                                     │  (b) 无 credential（legacy）
                                     └──POST /events (Bearer ingest token)──▶ event-route ─▶ AutoQaCoordinator.onQaResult
```

- CLI：`packages/flywheel-comm/src/commands/qa-result.ts`，flag 只有 `--status / --target-exec / --summary / --exec-id / --pr-head`。verdict 体就是 `status + summary` 自由文本。
- Bridge 权威通道：`workflow-decision-routes.ts:137` `/decision`，把 `summary` 作为 `evidence: { summary }` 写进 `workflow_claims.evidence`（JSON 列，已存在）。
- 三段式编排：`PhaseOrchestrator.onQaResult` 只看 `status`，FAIL 时把 `summary` 原样塞给 fixer（`phaseFixContext.qaSummary`）。

**结论：整条链路上没有任何结构化的「判据」概念。** 「测了什么、没测什么、为什么没测」全部埋在 `--summary` 自由文本里，机器无法校验，下一轮 QA 也读不到上一轮的清单。

### 2.3 「上一轮信息」现状

| 出口 | 现在注入了什么 | 缺什么 |
|---|---|---|
| 三段式 fix 起新 implement（`phase-orchestrator.ts:1529` `phaseFixContext`） | `round` + `qaSummary` 自由文本 | fail 判据清单、相邻路径要求 |
| 三段式 fix 唤醒 parked implement（`plugin.ts` `wakePhaseRunner` kind=fix） | 同上 | 同上 |
| 三段式 QA 复验唤醒（`wakePhaseRunner` kind=retest） | 只有新 head | 上一轮清单、哪些可沿用、哪些必须重验 |
| auto-QA 复验唤醒（`auto-qa-effects.ts:664` `retestWakeQa`） | 只有新 head | 同上 |
| DAG re-QA 换新 attempt（`phase-orchestrator.ts:527` `respawnUnenrolledQa`） | 只有 `shadowContext.attempt` | 同上 |

### 2.4 存储

- `workflow_claims`（`StateStore.ts:9581`）已有 `evidence JSON` 列、`decision_kind`、`node_id`、`attempt`、`predicate`（`qa_passed | qa_failed`）。**不需要新表**：清单放进 `evidence`，上一轮清单按 `run_id + node_id='qa' + attempt` 查最近一条 claim。
- `workflow_claim_revocation` 已存在：沿用（carried）时要检查上一轮 claim 没被不兼容原因撤销。
- `session_events`（`qa_result` 事件 payload）：legacy 通道的唯一落点，无 claim id。

## 3. 硬约束：与 QA 房 Bridge 对齐

本沙箱 DAG 工作流跑在 QA 房里，QA 房的 Bridge 与 `flywheel-comm` CLI 来自真仓 `flywheel-FLY-3055` 分支（v1.57.0），**真仓已实现 `qa-criteria/v1`**（`packages/config/src/qa-criteria.ts`）。本沙箱的 QA 节点提交 verdict 时打到的是那个 Bridge。因此：

- 判据清单的 schema 名、字段名、状态枚举、拒收 reason 字符串**必须与真仓 `qa-criteria/v1` 字节对齐**，否则沙箱 QA 节点的 verdict 会被真 Bridge 拒收（`qa_criteria_required` / `qa_criteria_invalid`）。
- 真仓实现是本设计的**参考实现**，不是照抄对象：真仓有 `workflow-engine-dispatcher.ts`、`workflow-qa-criteria-context.ts`、`workflow-rework-wake-copy.ts` 等本仓不存在的文件；本仓的注入出口是 §2.3 那五个。

## 4. 方案空间

### 方案 A：只改协议文字（拒绝）

把「一轮测全」写进 qa-executor.md 和 Blueprint 提示词。founder 已明确否决：「光告诉它没用，过两天又忘了」。文字只是必要条件。

### 方案 B：结构化判据清单 + 双层校验 + 上一轮注入（采用）

1. **判据清单 schema `qa-criteria/v1`**（共享模块 `packages/config/src/qa-criteria.ts`，CLI 与 Bridge 同一份规则）：每条判据 `id / title / status / evidence / reason / claim`，status ∈ `pass | fail | not_run | carried | merged`。
2. **CLI 本地预检**（`qa-result --criteria-file <json>`）：文件不合规**在发任何 HTTP 前**拒收、不写 marker，提示「先把剩下的判据测完或写明为什么没测」。
3. **Bridge 权威复核**（`/api/workflow/decision` + `submitWorkflowDecisionByCredential` 事务内）：同一份规则再跑一遍，加上账本才有的信息（carried 引用的 claim 是否存在、是否 pass、是否被撤销、上一轮全部 id 是否都被覆盖）。拒收在 credential 消费**之前**，事务回滚。
4. **上一轮注入**：QA 复验与 fixer 出口都从 `workflow_claims.evidence` 取上一轮清单，渲染成「已 pass 可沿用 / fail 与 not_run 必须重验」块。
5. **协议文字**同步改：qa-executor.md（两份）、engineer-executor.md、Blueprint 三处提示词、两处唤醒文案。

### 方案 C：新建 `qa_criteria` 表（拒绝）

比复用 `evidence` 多一次迁移、多一个与 claim 不一致的可能。清单和 verdict 是同一次原子提交，放同一行最诚实。

### 方案 D：只做 CLI 预检不做 Bridge 复核（拒绝）

CLI 是 runner 进程里跑的，runner 可以改 dist、可以直接 curl。「规矩不靠自觉」意味着权威校验必须在 Bridge。

## 5. 关键设计决定

| 决定 | 选择 | 原因 |
|---|---|---|
| 清单是否强制 | 走 `/api/workflow/decision`（有 credential）的 QA verdict **强制**；legacy `/events` 通道**不强制**（只在有清单时校验形状） | legacy 通道没有 claim 账本，carried 无法引用；且它是 auto-QA 独立 issue 流，本 issue 的 DAG 场景不走它 |
| `not_run` 缺 reason 怎么处理 | CLI 与 Bridge 都拒收（`qa_criteria_invalid`，field=`reason`） | 这是「先测完或写明为什么」的机器化 |
| FAIL 时允许 `not_run` 吗 | 允许，但每条必须有具体 reason；占位词（`n/a`、`skip`、`todo`、`-`、`无`、`略`）视为缺 reason | 真阻断（房间起不来）确实测不了，但要写明 |
| `carried` 引用什么 | 上一轮 claim id（正整数）+ evidence | claim id 是账本主键，Bridge 能验；报告 URL 不能验 |
| 上一轮清单被撤销了怎么办 | 只接受白名单撤销原因（head 被取代、操作员重做、founder 反馈等），其他一律拒 `qa_criteria_carried_invalid` | fail-closed |
| 上一轮 id 本轮漏了 | 拒 `qa_criteria_prior_uncovered`，列出缺的 id | 「一次列全」跨轮也成立 |
| 判据合并 | `merged` 状态 + `into` 指向本轮另一条 | 判据会随理解细化，允许收拢但不允许消失 |
| PASS/FAIL 与清单一致性 | FAIL 必须至少 1 条 fail；PASS 必须 0 条 fail 且至少 1 条 pass/carried | 防「清单全 pass 却判 FAIL」或反之 |
| 真房复跑豁免 | 写进协议文字，落在 `carried` 的 evidence 里（新测试 + CI run） | 没有机器能判「小 bug」，靠 Bridge 只能验引用链，判断留给 QA 但要留痕 |
| 相邻路径 | 协议文字 + fixer 注入块列出 fail 判据 + 要求交卷说明列相邻路径 | 无法机器判「相邻」，但让 fixer 看到完整清单能减少漏修 |

## 6. 非目标

- 不改 legacy `/events` 通道的语义，不给它加 claim 账本。
- 不做「自动判断哪些判据受 diff 影响」的静态分析；只把上一轮清单和 `git diff <prev-head>..HEAD` 的要求交给 QA。
- 不改 `verify-approval`、ship 流程、founder gate。
- 不改 founder 侧 Discord 展示（只加一行判据计数）。

## 7. 待 Lead 确认的问题（非阻塞，按默认继续）

1. **legacy `/events` 通道是否也强制清单？** 默认：不强制（有则校验形状）。理由见 §5。
2. **清单上限**：默认单轮非 merged 判据 ≤ 30、总 ≤ 60、文件 ≤ 64KB，与真仓对齐。

## 8. 下一步

research.md 落到代码级：每个改动点的行号、既有测试 seam、schema 细则、拒收 reason 表、注入预算与字节兼容策略。
