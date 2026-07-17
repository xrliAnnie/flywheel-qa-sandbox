# FLY-1307 模板派发验收 — 验收矩阵
Issue: FLY-1307
日期: 2026-07-16
基于: plan.md

## Hard Gates

| Gate | 自动化证据 | 结论 |
|---|---|---|
| eng 等价 harness | `phase-orchestrator.test.ts` — `matches handoff order, one fail loop, founder gate, and max-limit escalation` | engine v1 与 legacy belt 的交接顺序、一次 QA 回环、PASS 入 founder gate、第四次超限 escalate 逐事件一致；vendor 阵容按裁定不比较 |
| 四 mutation seams | `workflow-template-selection.test.ts`、`StateStore.workflow-templates.test.ts`、`StateStore.generalized-execution.test.ts`、`workflow-engine-dispatcher.test.ts` 的 v1/v2 逐 flag 矩阵 | selection / materialize / admission / successor consume 共用同一 fail-closed 谓词；拒绝格零 run/reservation/claim/dispatch 增量 |
| source outbox | `StateStore.workflow-source-projector.test.ts` — `FLY-1307 hard gate...` | 真 CommDB source/history 带 `target_run_id`；projector cursor 对账；稳定 run event UID；poison 只进 deadletter、不计成功；投影前先证明 source 行存在 |
| 真机 E2E | `scripts/qa-fly-1307-template-dispatch-e2e.mjs` + `qa/template-dispatch-e2e.json` | 13/13 checks PASS，8 次 real TmuxAdapter fresh spawn；eng QA 回环、product 物化/互审、source projector、restart、OFF 对照全过 |
| default-off | config registry test + selection/E2E OFF 对照 | `workflow_template_dispatch` 为 `governance_gate`、default-off；v1 OFF 精确回 legacy，v2 OFF fail-closed |

真机环境限制：runner sandbox 禁止 `ps`，production `tmux-server-rescue` 因此按设计 fail-closed。E2E 只替换这层检查为 harness-local shim；shim 执行原样的真实 tmux verify/create 命令并回读 live server PID。Bridge、TmuxAdapter、tmux socket/session/window、runner process、StateStore、CommDB 与 Git materialization 均为真实路径，限制已写入 JSON evidence，未隐去或冒充 production rescue 扫描。

## PRD Sentinels S1-S16

| Sentinel | 测试映射 | 状态 |
|---|---|---|
| S1 legacy 无 snapshot ship | `merge-ship-gate.integration.test.ts` — `approved + merged PASSES...`；`dispatch_off_v1_is_exact_legacy...` E2E | PASS：legacy 组合门与 v1 OFF 路径保持 |
| S2 templated eng QA PASS | `StateStore.workflow-claims.test.ts` happy path；E2E `engineering_founder_claim_and_use_time_ship_gate` | PASS：`qa_passed` 绑 server head，USE-time 放行 |
| S3 PASS 后 head 漂移 | `StateStore.workflow-claims.test.ts` E2；`merge-ship-gate.integration.test.ts` stale cached evidence | PASS：H1 不满足 H2 |
| S4 product skip QA | `StateStore.workflow-claims.test.ts` `qa_exempt binds a snapshot digest`；product E2E | PASS：免测证据绑 snapshot，product 不派独立 QA |
| S5 `FLYWHEEL_AUTO_QA=0` 不移除模板 QA | `workflow-template.test.ts` engineering seed/independent-QA invariant；`auto-qa-policy.test.ts` global switch | PASS：legacy Auto-QA policy 与 snapshot 内 QA 是两条独立语义 |
| S6 模板 kill-switch 不改 legacy Auto-QA | selection v1 OFF test + `auto-qa-policy.test.ts` | PASS：OFF 返回 legacy，不触碰 Auto-QA 决策 |
| S7 入口后删 live YAML | `workflow-run-snapshot.test.ts` `parses a pinned run after the live node registry changes` | PASS：运行只解释 snapshot |
| S8 founder feedback kickback | `StateStore.workflow-engine-transition.test.ts` loop tests；legacy `phase-orchestrator` fail-loop tests | PASS：有界回环与现有 guard 一致 |
| S9 QA 伪造 head | `workflow-decision-routes.test.ts` `rejects caller-head drift...` | PASS：server head 不一致即拒、凭证不消费 |
| S10 旧 workflow 在途事件 | `StateStore.workflow-node-lifecycle.test.ts` immutable execution binding；transition `not current node` test | PASS：run/node/attempt 身份固定，旧事件不能驱动新 run |
| S11 agent.md 伪造 model/capability | `workflow-run-snapshot.test.ts` `pins normalized capabilities, dispatch, and agent content` | PASS：agent content 与 core dispatch/capabilities 分离固定 |
| S12 `agent_file` 逃逸/缺失 | `workflow-template.test.ts` strict output/safe paths；`workflow-run-snapshot.test.ts` missing agents | PASS：严格 loader fail-closed |
| S13 无 write/ship capability generic | `workflow-run-snapshot.test.ts` capability pinning；product/research seed tests | PASS：prompt 不授予 registry 外能力，completion route 明确 |
| S14 generic role 不归一成 main | `event-route.test.ts` generalized identity tests；`StateStore.workflow-node-lifecycle.test.ts` binding identity | PASS：workflow node identity 来自 immutable binding |
| S15 output 未写即 complete | `event-route.test.ts` generalized completion；`StateStore.generalized-execution.test.ts` output contracts | PASS：返回 `missing_output`/retryable，不推进 successor |
| S16 output 后 restart/marker replay | FLY-1307 E2E restart check；`complete-marker-reconciler.test.ts` generalized replay | PASS：output/materialized authority 持久，重启无重复派发 |

## Claims Sentinels E1-E6

| Sentinel | 测试映射 | 状态 |
|---|---|---|
| E1 原始红测变绿 | claims、ship-gate、source-outbox、dispatch matrix 全套 | PASS |
| E2 H1 PASS 后漂到 H2 | `StateStore.workflow-claims.test.ts` E2 | PASS |
| E3 capability 重放/冲突/过期/伪造 | 同文件 E3(a/b/c) 与 subject pin tests | PASS |
| E4 founder 写入点 guard | `StateStore.workflow-source-projector.test.ts` founder source 原子事务与 project ownership | PASS |
| E5 遗留 run 字节兼容 | merge ship legacy integration + v1 dispatch OFF | PASS |
| E6 同厂商 review | claims E6 + `StateStore.generalized-execution.test.ts` admission guard | PASS |

## Scope Sentinels

- 未修改任何 production flag value；新增杆只注册为 default-off。
- 未接触 FLY-1306 detection-storm 路径。
- 模板 dispatch 始终消费 snapshot 中 resolver 已固定的 `{vendor, model, effort}`，不重写 vendor/model 选择器。
