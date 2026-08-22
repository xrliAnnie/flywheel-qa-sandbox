# FLY-1778 动态 flag store 重做 — M0 读点清单

Issue: FLY-1778 (https://linear.app/geoforge3d/issue/FLY-1778/flag治理地基第3批-动态-flag-store-重做-值存-sqlite-read-on-use-产出-value-last)
日期: 2026-08-21
基于: plan.md

---

## 0. 结论先行:46 条不是 46 条都迁

本清单以代码基线 `f4b2987a7` 重新盘点。当前 registry 恰有 **46** 条,但 FLY-1778 v1 的终审结果是:

| 处置 | 数量 | 含义 |
|---|---:|---|
| **纳管 SQLite(A 桶)** | **5** | Bridge 内全读点可做 read-on-use,且已有 direct 翻转入口消费 |
| **留 legacy** | **35** | 安全/治理/跨进程/value/project-config 等边界,不进本 store |
| **冻结在当前 restart timing,另单处理** | **6** | 启动序/对象构造骨架;本单只立据,不做与四件套无关的行为手术 |
| **删** | **0** | 46 条都仍有生产读者;M0 没发现可在本单无裁决删除的 dead flag |

所以 Annie 问的「46 个 flag 都需要吗」的直接答案是:**不需要。只有 5 条需要本单的 SQLite/read-on-use 地基,41 条不迁。**「删 0」也不等于 46 条都应长期保留——退役裁决继续由 FLY-1781/B3 流程负责;它只表示 FLY-1778 没有发现可越过 founder 裁决顺手删除的死开关。

当前 `isDirectToggleable` 的 **8** 条 founder 可操作 flag 是:

- 纳管 5 条:`flag_retirement_scan`、`workflow_rework_reentry`、`skill_framework_mode`、`workflow_resume`、`workflow_turn_divergence_alerts`;
- 安全集 legacy-live 3 条:`mailbox_queue`、`auto_qa_killswitch`、`codex_hard_gate_killswitch`。

**冻结名单与这 8 条的交集为 0。** founder 实际会从现有自助入口翻的 flag 没有一条被留在「要重启才生效」状态;三条不进 DB 的安全 flag 继续沿用今天已经免重启的 `.env` persist + `process.env`/live-`.env` 路径。

## 1. 核查方法与写者图例

本轮没有从 registry 表反推事实,而是按 plan §1 的四步做:

1. 对 35 个 env flag 做字面量多形态 sweep(`process.env.X`、`env.X`、`env[X]`、shell `${X}`);
2. 扫 `readEnvValueFromContent` 全部调用点,确认 live `.env` 真读者;
3. 追 `SKILL_FRAMEWORK_MODE_ENV` 等导出/局部常量的 import 和使用点;
4. 逐个打开候选与六处 frozen 读点,确认进程、timing、构造位置与真实调用图。

写者缩写:

| 写者 | 当前路径 | M0 后处置 |
|---|---|---|
| W1 | direct 双面:CLI `/api/fleet/flag/stage|apply` + management writer `existing-direct-flag-v1`;两者最终都写 `.env` 再改 Bridge `process.env` | A 桶只保留 CLI managed 分支;management writer 对 managed 值改为只读/拒写 |
| W2 | operator/reviewed `.env` 变更;无本单认可的 direct 自助写面 | 保持 legacy |
| W3 | `mailbox_queue` 的 W1 + deploy-barrier shell/Bridge 持有者协议会强制写/清 `FLYWHEEL_MAILBOX_QUEUE` | 保持 legacy,结构性排除 |
| W4 | project `.flywheel/config.yaml` / project config 管理流程 | 保持 project_config,不复制进 global store |
| W5 | voice QA staged harness 注入,生产禁止置位 | 保持 QA-only legacy |

表中「live 文件」只指行为路径是否直接重读共享 `.env` 内容,不把 `resolveAllFlags()` 为报告展示读取 `.env` 算成运行时权威读点。

## 2. 46 条逐条 manifest

| # | flag / source | 真实读点与进程归属 | live 文件 | 写者 | 终审处置与理由 |
|---:|---|---|:---:|---|---|
| 1 | `flag_retirement_scan`<br>`FLYWHEEL_FLAG_RETIREMENT_SCAN` | `flag-retirement-scan.ts:flagRetirementScanEnabled`;`plugin.ts` 注入每轮 enabled closure;Bridge call-time | 否 | W1 | **A/纳管**。bool direct,下一次 weekly rider tick 生效,无跨进程读者 |
| 2 | `mailbox_queue`<br>`FLYWHEEL_MAILBOX_QUEUE` | `mailbox-queue.ts:mailboxQueueEnabled`(Bridge lanes) + `inbox-mcp/queue-mode.ts:resolveLiveMailboxQueueEnabled`(独立 MCP) + deploy-barrier owner 协议 | **是** | W3 | **留 legacy·安全 live**。跨进程重读 + deploy-barrier 自动写者;DB-only 会破坏 fleet rollback/re-arm |
| 3 | `liveness_activity_window_ms`<br>`FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS` | `liveness-evidence.ts:activityWindowMs`;Bridge call-time,只改告警措辞 | 否 | W2 | **留 legacy**。自由数值(value),无 bounded direct 目标;FLY-1405 幸存者已终审,不为覆盖率纳管 |
| 4 | `converge_cmux_symlink`<br>`FLYWHEEL_CONVERGE_CMUX_SYMLINK` | `scripts/converge-flywheel-bin.sh:converge_cmux_symlink`;每次 CLI/部署调用 | 否 | W2 | **留 legacy**。shell 跨进程读者,v1 不造跨进程 DB reader |
| 5 | `cmux_view_helper`<br>`FLYWHEEL_CMUX_VIEW_HELPER` | `scripts/flywheel-cmux-sync.sh:view_helper_enabled`;resident shell watcher | 否 | W2 | **留 legacy**。shell 跨进程读者 |
| 6 | `cmux_node_presence`<br>`FLYWHEEL_CMUX_NODE_PRESENCE` | `scripts/flywheel-cmux-sync.sh:cmux_node_presence`;resident shell watcher | 否 | W2 | **留 legacy**。shell 跨进程读者 |
| 7 | `voice_qa_presence_override`<br>`FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE` | `voice-bridge/assistant/wiring.ts:wireAssistantMode`;独立 voice-bridge 构造时快照 | 否 | W5 | **冻结 #1**。QA-only + 外部 daemon object-construction;非 founder 自助控制,跟随 voice QA 专项改造 |
| 8 | `auto_qa_killswitch`<br>`FLYWHEEL_AUTO_QA` | `auto-qa-policy.ts:resolveAutoQaPolicy`;Bridge 每次 policy resolve | 否 | W1 | **留 legacy·安全 live**。全局 QA emergency stop,保持现有 `process.env` 即时释放路径 |
| 9 | `codex_hard_gate_killswitch`<br>`FLYWHEEL_CODEX_HARD_GATE` | Bridge `codex-gate.ts`/`auto-qa-held.ts` + 隐藏读者 `flywheel-comm verify-approval.ts:resolveCodexHardGateOn` | **是** | W1 | **留 legacy·安全 live**。merge authority 双进程 re-arm;DB-only 会让 CLI 看不到应急值 |
| 10 | `merge_approval_gate_killswitch`<br>`FLYWHEEL_MERGE_APPROVAL_GATE` | `flywheel-comm/ship-eligibility.ts:resolveDefaultOnGate`;Bridge caller + 独立 CLI | **是** | W2 | **留 legacy·安全 live**。ship authority 跨进程门 |
| 11 | `qa_done_gate_killswitch`<br>`FLYWHEEL_QA_DONE_GATE` | `flywheel-comm/ship-eligibility.ts:resolveDefaultOnGate`;Bridge caller + 独立 CLI | **是** | W2 | **留 legacy·安全 live**。QA ship authority 跨进程门 |
| 12 | `design_html_gate`<br>`FLYWHEEL_DESIGN_HTML_GATE` | `complete.ts` CLI + Bridge `event-route.ts`、`DirectEventSink.ts`、`complete-marker-reconciler.ts` | 否 | W2 | **留 legacy·治理**。governance gate 全拒;FLY-1405 幸存者收口 |
| 13 | `issue_gate_supersede_mode`<br>`FLYWHEEL_ISSUE_GATE_SUPERSEDE` | `issue-gate-supersede.ts:sweepIssueGatesForProject`;Bridge call-time | 否 | W2 | **留 legacy**。enum readonly,无 direct 翻转消费者;FLY-1405 幸存者收口 |
| 14 | `ship_ci_guard`<br>`FLYWHEEL_SHIP_CI_GUARD` | `flywheel-comm/ship-ci-guard.ts:probeShipCiGreen`;每次独立 CLI | 否 | W2 | **留 legacy·安全 live**。ship CI 证据链,跨进程应急旁路;FLY-1405 幸存者收口 |
| 15 | `deferred_approval_ttl_ms`<br>`FLYWHEEL_DEFERRED_APPROVAL_TTL_MS` | `approval-signal/deferred-approval.ts:deferredApprovalTtlMs`;Bridge call-time | 否 | W2 | **留 legacy**。自由数值(value),不扩 direct API |
| 16 | `founder_reply_deadletter_age_ms`<br>`FLYWHEEL_FOUNDER_REPLY_DEADLETTER_AGE_MS` | `gate-poller.ts:founderReplyDeadletterAgeMs`;Bridge call-time | 否 | W2 | **留 legacy**。自由数值(value) |
| 17 | `workflow_rework_reentry`<br>`FLYWHEEL_WORKFLOW_REWORK_REENTRY` | `workflow-rework-coordinator.ts:reconcile` + `workflow-engine-dispatcher.ts:reconcileWorkflowReworks/reconcileWorkflowReworkStalls`;均持有 Bridge `process.env` 对象 | 否 | W1 | **A/纳管**。bool direct,三处均在 Bridge;FLY-1405 幸存者正式收编 |
| 18 | `issue_display_sweep_ticks`<br>`FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS` | `plugin.ts:startBridge` 构造 GatePoller cadence | 否 | W2 | **冻结 #2**。自由数值 + object-construction,改 timer 生命周期属独立手术 |
| 19 | `ship_gate_grace_ms`<br>`FLYWHEEL_SHIP_GATE_GRACE_MS` | `gate-poller.ts:shipGateGraceMs`;Bridge call-time | 否 | W2 | **留 legacy**。自由数值(value),无 bounded direct 目标 |
| 20 | `external_merge_reconcile`<br>`FLYWHEEL_EXTERNAL_MERGE_RECONCILE` | `external-merge-reconcile.ts:createExternalMergeReconciler().pass`;Bridge call-time | 否 | W2 | **留 legacy**。bool conversational,无现成自助写入口消费;不为覆盖率纳管 |
| 21 | `merge_reconcile_window_days`<br>`FLYWHEEL_MERGE_RECONCILE_WINDOW_DAYS` | 同一 reconciler pass;Bridge call-time | 否 | W2 | **留 legacy**。自由数值(value) |
| 22 | `ship_gate_card_grace_ms`<br>`FLYWHEEL_SHIP_GATE_CARD_GRACE_MS` | `gate-poller.ts:shipGateCardGraceMs`;Bridge call-time | 否 | W2 | **留 legacy**。自由数值(value) |
| 23 | `lead_core_mention_gated`<br>`FLYWHEEL_LEAD_CORE_MENTION_GATED` | `codex-lead-runtime.ts`;独立 Codex Lead 进程,launcher 注入 | 否 | W2 | **冻结 #3**。mixed/Lead 启动边界;不是 Bridge 内读点,需 Lead runtime 专项改造 |
| 24 | `reports_ttl_days`<br>`FLYWHEEL_REPORTS_TTL_DAYS` | `plugin.ts:resolveReportsTtlMs`;report registry 构造时快照 | 否 | W2 | **冻结 #4**。自由数值 + object-construction,重建 registry 生命周期不属四件套 |
| 25 | `ghost_guard_wait_ms`<br>`FLYWHEEL_GHOST_GUARD_WAIT_MS` | `runs-route.ts:GHOST_GUARD_SESSION_WAIT_MS`;模块/Bridge boot 常量 | 否 | W2 | **冻结 #5**。自由数值 + boot 骨架;FLY-1405 幸存者只立据 |
| 26 | `founder_consent_decision_mode`<br>`FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE` | `decision-mode.ts:resolveDecisionMode`;Bridge policy call-time | 否 | W2 | **留 legacy·治理**。founder-consent governance mode 不进 DB-only |
| 27 | `founder_attribution_gate`<br>`FLYWHEEL_FOUNDER_ATTRIBUTION_GATE` | `flywheel-comm/founder-attribution.ts:resolveFounderAttributionGateOn`;独立 CLI | **是** | W2 | **留 legacy·治理**。每次 verify 路径 live-re-read |
| 28 | `lead_lease_bypass`<br>`FLYWHEEL_LEAD_LEASE_BYPASS` | `flywheel-comm/lead-lease.ts:authorizeLeadWrite`;独立 CLI | 否 | W2 | **留 legacy·治理**。break-glass bypass;FLY-1405 幸存者收口 |
| 29 | `checkpoint_enabled`<br>`checkpoints.*.enabled` | embedded `Blueprint.runInner`;Bridge 内 edge-worker package,per-project call-time | n/a | W4 | **留 project_config·治理**。逐项目动态 key,不复制到 global store |
| 30 | `pipeline_dag`<br>`pipeline.dag` | `pipeline-config-source.ts:loadWorkKindConfigStrict`;Bridge call-time | n/a | W4 | **留 project_config**。per-project authority 已存在 |
| 31 | `pipeline_work_kind`<br>`pipeline.work_kind` | 同上;Bridge call-time | n/a | W4 | **留 project_config**。per-project authority 已存在 |
| 32 | `founder_milestone_report_enabled`<br>`founder_milestone_report.enabled` | `gate-poller.ts:maybeEmitMilestoneReports`;per-project config read | n/a | W4 | **留 project_config** |
| 33 | `xiaohongshu_auto_create`<br>`xiaohongshu_learning.collections[].auto_create` | `xiaohongshu-scheduler.ts:planLearningRuns`;Bridge scheduler call-time | n/a | W4 | **留 project_config** |
| 34 | `qa_auto`<br>`qa.auto` | `auto-qa-policy.ts:resolveAutoQaPolicy`;Bridge per-project call-time | n/a | W4 | **留 project_config**;与 #8 global kill switch 是两层权威,不折叠 |
| 35 | `doc_flow`<br>`doc_flow.enabled` | embedded `Blueprint.runInner`;Bridge 内 edge-worker package | n/a | W4 | **留 project_config** |
| 36 | `skill_framework_mode`<br>`FLYWHEEL_SKILL_FRAMEWORK_MODE` | owning resolver + 隐藏 raw 读:`Blueprint.ts:resolveSkillFrameworkForRun`、`runs-route.ts`、`run-dispatcher.ts`;代码都在 Bridge 进程 | 否 | W1 | **A/纳管**。enum direct;需 run-infra 注入 raw-control reader,保留 `split`×issue 两层语义;FLY-1405 幸存者收编 |
| 37 | `skill_framework_split_participation`<br>`skill_framework.split` | `skill-framework-participation.ts:makeSkillFrameworkParticipationReader`;per-project fresh read | n/a | W4 | **留 project_config**。它是 #36 `split` 下的项目 opt-out,不并入 global 行;FLY-1405 幸存者收口 |
| 38 | `proofshot`<br>`skills.proofshot.enabled` | `ConfigLoader.validate`;project config | n/a | W4 | **留 project_config** |
| 39 | `xiaohongshu_learning`<br>`xiaohongshu_learning.enabled` | `ConfigLoader.validate`;project config | n/a | W4 | **留 project_config** |
| 40 | `ponytail`<br>`ponytail.enabled` | `ConfigLoader.validate`;当前 runtime dormant | n/a | W4 | **留 project_config/read-only**。Annie exception + dormant 事实不由本单改写 |
| 41 | `done_thread_reconcile_interval_min`<br>`FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN` | `done-thread-reconcile.ts:resolveDoneThreadReconcileConfig`;Bridge 每 tick | 否 | W2 | **留 legacy**。自由数值(value) |
| 42 | `done_thread_reconcile_max_per_run`<br>`FLYWHEEL_DONE_THREAD_RECONCILE_MAX_PER_RUN` | 同上;Bridge 每 tick | 否 | W2 | **留 legacy**。自由数值(value) |
| 43 | `publish_broker`<br>`FLYWHEEL_PUBLISH_BROKER` | `publish-broker/wire.ts:wirePublishBroker`;Bridge boot 决定是否创建 unix socket/observer | 否 | W2 | **冻结 #6**。启动/资源生命周期骨架;非 direct founder flag |
| 44 | `workflow_resume`<br>`FLYWHEEL_WORKFLOW_RESUME` | `runs-route.ts:isWorkflowResumeEnabled` + 隐藏读者 `workflow-engine-dispatcher.ts:deferDeadExecutionForReadyResume` 与 terminal recovery 分支;全在 Bridge | 否 | W1 | **A/纳管**。bool direct;需把两处未登记读者一并接 wrapper |
| 45 | `workflow_turn_divergence_alerts`<br>`FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS` | `workflow-turn-ledger-validator.ts:workflowTurnDivergenceAlertsEnabled`;`plugin.ts` 每轮 reconcile 调用;Bridge | 否 | W1 | **A/纳管**。bool direct,下一轮 ledger reconcile 即生效 |
| 46 | `instruction_path_check`<br>`FLYWHEEL_INSTRUCTION_PATH_CHECK` | Bridge `plugin.ts`/`event-route.ts`/`design-review-validation.ts` + 独立 `flywheel-comm await-codex-gate.ts` | 否 | W2 | **留 legacy**。跨进程 design-review 证据门,v1 不造 CLI DB reader |

等式:**5 纳管 + 35 legacy + 6 frozen + 0 delete = 46**。

## 3. A 桶终审名单与机器可核调用图

### A1 `flag_retirement_scan`

```text
flywheel-comm feature-flags apply
  → POST /api/fleet/flag/stage|apply
  → [M1] StateStore.applyFlagValueChange(flag_retirement_scan)

plugin.ts createFlagRetirementScanner
  → enabled closure (每次 tick 调用)
  → [M2] storeFlagRetirementScanEnabled(store)
  → StateStore point lookup → bool codec(default-on)
```

- package/process:`teamlead` / Bridge;
- raw 来源:当前 `process.env`,seed 后为 `flag_values`;
- timing:call-time;
- seam:plugin 已有 injected `enabled` closure,不新增抽象。

### A2 `workflow_rework_reentry`

```text
CLI managed apply → StateStore transaction

plugin.ts
  ├─ WorkflowReworkCoordinator.reconcile
  └─ WorkflowEngineDispatcher
       ├─ reconcileWorkflowReworks
       └─ reconcileWorkflowReworkStalls
          → [M2] storeWorkflowReworkReentryEnabled(this.options.store)
```

- package/process:`teamlead` / Bridge;
- raw 来源:两个对象今天都持有同一个 `process.env` 引用;迁移后两者已有 StateStore dependency 可作点读;
- timing:三处 call-time;
- seam:使用现有 store dependency,不加 cache/listener。

### A3 `skill_framework_mode`

```text
CLI managed apply → StateStore transaction

run-infra.ts (Bridge 组合根)
  → [M2] storeSkillFrameworkModeControl(store) // {present, raw}
  → 注入 Blueprint
       ├─ split participation 前置判断
       └─ resolveSkillFrameworkMode({ env-like control, issueIdentifier, ... })

runs-route.ts request admission
  → named store reader → split override admission

run-dispatcher.ts sticky-stamp lookup
  → named store reader → split-only lookup
```

- package/process:`config` resolver + embedded `edge-worker` Blueprint + `teamlead`,**运行时全在 Bridge 进程**;
- raw 来源:DB 保留在场性与非法/空 raw;codec 的钟只 canonical 全局控制值,不预解析 per-issue arm;
- timing:4 个 raw 决策点均 call-time;
- seam:`run-infra.ts` 已是 Blueprint 组合根,加一个窄 reader 参数;不让 edge-worker 反向依赖 StateStore;
- 比例复核:这条的 seam 是 A 桶最贵一项,但它正是 founder 会实际翻的四臂开关;缩出会违反「founder 实际会动的 flag 零冻结」,因此保留。

### A4 `workflow_resume`

```text
CLI managed apply → StateStore transaction

runs-route.ts
  → isWorkflowResumeEnabled → [M2] storeWorkflowResumeEnabled(store)

WorkflowEngineDispatcher
  ├─ deferDeadExecutionForReadyResume
  └─ reconcile terminal completed branch
     → 同一 named store reader
```

- package/process:`teamlead` / Bridge;
- raw 来源:DB seed 后 point lookup;
- timing:三处 call-time;
- seam:runs route 与 dispatcher 都已有 StateStore 依赖;不加跨包 adapter。

### A5 `workflow_turn_divergence_alerts`

```text
CLI managed apply → StateStore transaction

plugin.ts reconcileWorkflowTurnLedgers 每轮
  → [M2] storeWorkflowTurnDivergenceAlertsEnabled(store)
  → alertEnabled
```

- package/process:`teamlead` / Bridge;
- raw 来源:DB;
- timing:每轮 call-time;
- seam:替换现有单个 helper call。

A 桶终审仍为设计预判的 5 条,**未扩员**。新发现的隐藏读者没有跨出 Bridge,但会全部进入实现与回归测试,不能继续只登记 owning resolver 一行。

## 4. frozen 六处逐条理由

这里的「冻结」是**维持当前 read timing**,不是冻结值/永久不做。六处都是启动序或对象构造骨架,且都不在当前 8 条 direct 自助名单里:

| flag | 当前冻结点 | 为什么不在 FLY-1778 手术 | follow-up 验收形状 |
|---|---|---|---|
| `voice_qa_presence_override` | voice-bridge `wireAssistantMode` object construction | 外部 daemon + QA-only allowlist;Bridge store 无法替它读 | voice-bridge 独立动态控制/明确维持 boot-only |
| `issue_display_sweep_ticks` | GatePoller cadence construction | 改 timer 生命周期,不是 flag 值地基 | 重排/重建 cadence 后无重复 timer |
| `lead_core_mention_gated` | Codex Lead launcher/runtime mixed | 读者不是 Bridge,需 Lead runtime control plane | 新 Lead 与存量 Lead 行为分别定义 |
| `reports_ttl_days` | report registry construction | 自由数值 + registry 资源生命周期 | 新 TTL 对后续 publish 生效且不破坏已发布链接 |
| `ghost_guard_wait_ms` | `runs-route.ts` 模块常量/Bridge boot | admission timeout 骨架,自由数值 | 新 request 使用新预算,在飞 request 语义明确 |
| `publish_broker` | boot 创建 unix socket + reaction observer | 开关直接决定资源是否存在 | 动态 start/stop 的 socket/observer 清理可证 |

建议 follow-up 名称:`FLY-1405 residual — six restart-frozen read sites call-time audit`。本节点没有建单权限,由 Lead 在 M0 复审后创建/归档决定。

## 5. FLY-1405 旧 45 条标记的收口

旧 ledger 的 45 条中现存 10 条,本表逐条终审如下:

| 现存 flag | 本轮去向 |
|---|---|
| `liveness_activity_window_ms` | 留 legacy value |
| `voice_qa_presence_override` | frozen #1 |
| `design_html_gate` | 留 legacy governance |
| `issue_gate_supersede_mode` | 留 legacy readonly |
| `ship_ci_guard` | 留 legacy safety/CLI |
| `workflow_rework_reentry` | **A/纳管** |
| `ghost_guard_wait_ms` | frozen #5 |
| `lead_lease_bypass` | 留 legacy governance/CLI |
| `skill_framework_split_participation` | 留 project_config |
| `skill_framework_mode` | **A/纳管** |

其余 35 条已由后续清理批删除;不把 2026-07 快照复制成新 registry 字段。

## 6. registry 元数据差异与实现义务

M0 复现/补充了四类不能只看 registry 的事实:

1. `codex_hard_gate_killswitch`:隐藏 `verify-approval.ts` live `.env` 读点,必须留安全 legacy;
2. `skill_framework_mode`:registry 只列 owning resolver,实际另有 `Blueprint.ts`、`runs-route.ts`、`run-dispatcher.ts` 三个 raw 决策点;
3. `workflow_resume`:registry 只列 `runs-route.ts`,实际 `workflow-engine-dispatcher.ts` 还有两处行为读;
4. `mailbox_queue`:除 Bridge/MCP 读者外还有 deploy-barrier writers,不能按普通 direct flag 迁。

M2 必须同步 registry `readSites` 与 delegated 精确 roster;不扩大 drift scanner 能力。Ponytail ladder在这里的落点是:**用现有 StateStore、现有 SQLite transaction、现有路由和现有组合根;不加依赖、不加 cache/event bus、不建跨进程 reader、不把六个 frozen 手术塞进本单。**

## 7. 规模与 scope 复审请求

- A 桶保持 5,候选未扩;
- 新发现的隐藏点均可通过 plan 已计入的 named wrapper/现有依赖注入 seam 处理;
- 功能码估算维持 **约 1,320 行**,仍低于 2k 硬停线;若实现中需要新跨进程 reader、epoch、mirror、sweep 或 generic flag framework,立即停下复审;
- 显式收窄 1:六处 frozen read-site 手术拆 follow-up;
- 显式收窄 2:FLY-1781/B3 消费 `value_last_changed` 拆 follow-up(本单只产出字段/readiness 契约,不双写现役快照判据);
- dashboard 写面继续不做;v1 只保留 CLI managed 写面,现有 management writer 对 managed 值只读。

**请求 Tadashi 冻结名单复审:**批准上面的「5 纳管 / 35 legacy / 6 frozen / 0 delete」与两处 scope 收窄后,才进入 M1 RED。门未过前不修改 `src`、schema 或生产测试。

## 8. 会过期的结论

| 结论 | as-of | 重核命令/方法 |
|---|---|---|
| registry = 46 | `f4b2987a7` | `pnpm exec tsx -e 'import { FEATURE_FLAGS } from "./packages/config/src/feature-flags/registry.ts"; console.log(FEATURE_FLAGS.length)'` |
| direct = 8 | `f4b2987a7` | 以 `isDirectToggleMetadata` 对活 registry 过滤,不可抄本表 |
| A 桶 = 5 | 本 M0 + Lead 复审前 | 重跑 env 字面量、常量 import、`readEnvValueFromContent`、resolver 调用图四类 sweep |
| frozen = 6 | 本 M0 | 查每条 `readSites[].timing ∈ {object_construction,bridge_boot,mixed}` 后逐文件确认,不可只计 timing |
| 行号/调用点 | `f4b2987a7` | 用符号名 `rg`,不用长期引用本表行号 |
