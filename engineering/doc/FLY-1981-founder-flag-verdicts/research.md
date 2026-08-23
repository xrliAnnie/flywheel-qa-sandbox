# FLY-1981 flag 治理 founder 裁定执行批 — 调研

Issue: FLY-1981 (https://linear.app/geoforge3d/issue/FLY-1981/flag治理founder裁定执行批-复查结论9-条固化删除-auto-qa-整体退役-consentattribution)
日期: 2026-08-22
基于: exploration.md

本文档是 file:line 级的手术清单:每项裁定删什么、留什么、搬什么、测什么。行号锚定于 worktree HEAD `c63ca48b7`(含 FLY-1778/FLY-1831);行号会漂,复核用 `git log -S` 重定位。

## 1. A 组固化 — 逐条手术边界

### A1. `reports_ttl_days` → 常量 7 天
- 删:`plugin.ts:950` 附近 `resolveReportsTtlMs` 的 env 解析(含 `0 disables` 分支,`plugin.ts:4133-4135` 读点)→ 直接 `7 * 24 * 3600 * 1000` 常量(或保留函数、去参数化)。
- 删:registry `reports_ttl_days` 行(registry.ts:846-866);`feature-flags-resolve.test.ts` 对应用例。
- 墓碑:`RETIRED_FLAGS` + `FLYWHEEL_REPORTS_TTL_DAYS, retiredBy: FLY-1981`。
- 注意:`0 disables` 语义一起死——固化后 TTL 恒 7 天,不存在「禁用清理」档。生产从未用过 0。

### A2. `workflow_resume` → 固化 enabled
- 现网 `.env:174` `FLYWHEEL_WORKFLOW_RESUME=1`,固化零行为变化。
- 删:`plugin.ts:4071` 与 `plugin.ts:6217` 两处 `storeWorkflowResumeEnabled(flagStore)` 注入 → resume 无条件接通(谓词恒 true 或直接去谓词参数)。
- 删:store-policy.ts `STORE_MANAGED_FLAGS` 中 `workflow_resume`(5→4)+ `getFlagStoreCodec` optInCodec 分支;`storeWorkflowResumeEnabled` wrapper 本体。
- 删:registry `workflow_resume` 行(registry.ts:1305-1330);测试 `runs-route.dag-entry`(flag 分支用例改为常开断言)、`flag-store-runtime`、`management-existing-writers`、`flag-routes`、`StateStore.flag-value-store`、`workflow-engine-dispatcher` 中对应用例。
- store 残留:生产 `flag_values` 表实测为空,无 orphan 行;实施时仍加防御(store 若有该行,迁移中删除或忽略均可,写明选择)。
- 墓碑 + runbook:updater 原子删 `.env:174`(见 §5)。

### A3. `instruction_path_check` → 校验永远做
- 删 5 处 `=0` 分支:`plugin.ts reconcileDesignReviewManifestOutbox`、`event-route.ts handleStageChanged`、`design-review-validation.ts validateDesignReviewProjection`(env-param)、`await-codex-gate.ts validateResult` + `validateDesignProjectionWithBridge`(CLI ×2)。
- 删:registry 行(registry.ts:1362+);`await-codex-gate.test.ts` / `event-route.codex-trigger.test.ts` / `flag-truth.test.ts` 对应用例。墓碑。

### A4. `design_html_gate` → 门永远在
- 删 4 处 `=== "0"` 逃生分支:`complete.ts:583-585`(CLI)+ `DirectEventSink.ts:532-539` + `event-route.ts:717-729` + `complete-marker-reconciler.ts:659-670`;`complete.ts:644` 报错文案里的「Emergency operator escape」句一并删。
- 删:registry 行;`feature-flags-drift/registry` 测试用例。墓碑。

### A5. `ship_ci_guard` → 门永远在
- 删:`ship-ci-guard.ts:47` `=0` 短路;registry 行;`ship-ci-guard.test.ts` 的 bypass 用例改为「无旁路」断言。墓碑。

### A6. `codex_hard_gate_killswitch` → 硬门永远在
- 删:`codex-gate.ts:20` `HARD_GATE_ENV` + `codexHardGateEnabled` 的 =0 分支(Bridge 侧);`verify-approval.ts:274-308` `resolveCodexHardGateOn` 三级读(argsEnv/live-.env/process.env)→ 恒 true(`verify-approval.ts:679-684` 调用点简化;`row.codex_skip` 与 `codexApprovedForHead` 语义不动)。
- `auto-qa-held.ts` 的读点随 B 组一起处理。
- 删:`vitest.setup.ts:49` 的 `FLYWHEEL_CODEX_HARD_GATE="0"` 全局测试 pin —— **这会让 teamlead 全测试套在「门恒在」下跑,预计有存量用例靠这个 pin 绕门,须逐个改为提供真实 codex 证据或显式 codex_skip**(工作量集中点,见 plan)。
- 删:registry 行 + `drift-scan.test.ts` 等用例;`verify-approval.test.ts` 的 .env live-toggle 双向用例改为「恒 ON」断言。墓碑。

### A7. `qa_done_gate_killswitch` → 防盗门永远设防
- 删:`ship-eligibility.ts:39` `QA_DONE_GATE_KEY` + `evaluateQaShipGate` 里 `resolveDefaultOnGate` 调用与 `qa_gate_off` 出口(ship-eligibility.ts:234-239);`resolveDefaultOnGate` 若仅剩 merge 门一个调用方,内联或保留均可(merge 门 `FLYWHEEL_MERGE_APPROVAL_GATE` **不在本批,一个字节不动**)。
- 删:registry 行;`ship-eligibility.test.ts` gate-off 用例转「恒设防」。墓碑。

### A8. `lead_core_mention_gated` → 删 flag 面,保 plumbing 面
- 删:registry 行(registry.ts:823-841);`codex-lead.sh:97` 的 `-z` 预设覆盖口(projects.json 计算成为唯一来源,操作员预设不再被承认)。
- 保:`codex-lead.sh` 计算+export、`codex-lead-runtime.ts:617` 读点、`apply-core-room-mention-gate.sh` 注释——**字节不动**。
- 改判:env var 进 `NON_FLAG_ALLOWLIST`(truth.ts:238)注明「launcher→runtime plumbing(FLY-898),非操作员开关,FLY-1981 摘牌」——FLY-1809 `lead_cross_dept_channel_ids` 同款先例。**不进 RETIRED_FLAGS**(生产仍在读,墓碑会误报)。

### A9. `founder_attribution_gate` → 最严档写死
- 删:`founder-attribution.ts` `ATTRIBUTION_GATE_KEY` + `resolveFounderAttributionGateOn`(126+)整个解析(argsEnv/process.env/live-.env 四级)→ 调用点 `verify-approval.ts:569-574` 的 `attributionGateOn` 恒 true(保留 founderId 不可解析 = 跳过的诚实边界,那是能力边界不是开关)。
- **529 QA 房迁移(Codex R1 #1 / R2 #1 / R3 #1 三轮修正后的终形——零新 Bridge 代码)**。R2 版「respond-equivalent writer」的前提(「529 房今天就是用 respond 批准且 verify 通过」)被 R3 以 HEAD 源码证伪并经本节复核确认:`respond.ts:61-67` 对 approve_to_ship gate 上任何带 approval intent 的 Lead 回复(含 `{"approved":true}` 精确 fixture)在写入前即抛 `lead_ack_rejected`;`write-gate-response.ts:350-358` 只准入 `awaiting_review`/`approved_to_ship`(或 engine authority awaiting_review/approved),不准入裸 running。**HEAD 行为是权威 ⇒ 采用 Codex 建议的完整合法链,不造任何新写入面:**
  - **终形:529 驱动一律走既有 `/api/actions/approve`(writer="bridge")。** HEAD 源码证据链:`actions.ts:247-262` engine run 经 engineAuthority 准入(carrier 可为 running);非 engine 要求 awaiting_review;:296 解析 bound question(engineAuthority.questionId ?? session.review_question_id);写 gate 回执(可信 writer="bridge")→ :392-398 合法 FSM 边 approve(awaiting_review→approved_to_ship)→ :509 唤醒(「woken runner's verify-approval sees approved_to_ship」)。verify-approval 的 binding/status/attribution 三查全部按构造满足,一行不弱化。
  - **两种 harness 形态**:① engine(schema-v2 DAG)run——ship 卡 gate 携带 engine authority,驱动直接 POST approve,无需 session 状态迁移;② legacy 阻塞 gate 套件(fly-60 hard-gate 形)——harness 改走生产标准绑定路(runner `complete --route needs_review --question-id <qid>` 落 awaiting_review + binding),再 POST approve → 唤醒 → resume runner verify+merge。`test-auto-approve.sh` 的 respond 路在 HEAD 本已必死(lead_ack_rejected),此次一并汰换,属修复而非倒退。
  - 设计前提已按 R3 要求以 HEAD 源码逐环取证(上两条 file:line);deployed/cache 版本偏差的核查并入 FLY-1914 sweep(若 529 现役驱动字节与 HEAD 不一致,列明真实 producer 及其收敛)。
  - 合同测试:调用**真 `verifyApproval`** 断言对精确 question/head 放行(不是只断言 response 插入 + wake);对抗用例:错 owner / gate 缺失或过期 / head 漂移 / 重复回执 / 重试。
  - 双冒烟:①预删除冒烟(=0 注入仍在,验证新驱动链本身);②**final-head 冒烟(=0 注入已删)**,通过后 Batch 3 才算完。
- 删:registry 行;`verify-approval.test.ts` gate-off 用例转恒 ON。墓碑。
- 外部消费者 sweep(FLY-1914 规矩):`FLYWHEEL_FOUNDER_ATTRIBUTION_GATE` 在插件 fork / `~/.claude/plugins/cache` 的引用须逐 root 核查并在 PR body 附时间戳证据。

### A10. `founder_consent_decision_mode` → 写死 audit_only
- 现网 `.env:149` = `audit_only`(exploration 发现②),写死该档零行为变化。
- 改:`decision-mode.ts resolveDecisionMode` → 常量返回 `"audit_only"`(或直接删函数,调用方内联常量;保留导出名以免涟漪,实施时选小 diff 方向);删 env 解析 + `FLYWHEEL_FOUNDER_CONSENT_ENABLED` legacy 别名分支 + invalid-value throw。
- 删:registry `founder_consent_decision_mode` 行;`resolve.ts:202-205` 的 DECISION_MODE 特判;truth.ts:500 legacy 别名的 NON_FLAG_ALLOWLIST 行 → 移墓碑;`decision-mode.test.ts` 逐字节 reverse-compat sentinel **合法 retarget**(合同本身变了,参照 FLY-217 哨兵 retarget 先例,须在 PR 里点名)。
- 净删不可达分支:`founder-consent/config.ts:220` `decisionMode !== "off"` 恒 true(required-field 校验恒做——现网 audit_only 本就走这支);`wiring.ts`/`middleware.ts` 的 off 短路死支;`gate-response-router.ts` enforce 专属写路径(`bridge-founder-consent` 归属写侧)不可达 → 删,但 `TRUSTED_BRIDGE_APPROVAL_WRITERS` 里的 `"bridge-founder-consent"` **保留**(读侧,历史回执可携带)。evaluator/audit/cache/prompt/reserved-endpoints 机制全保留(audit_only 现役)。
- 墓碑 ×2:`FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE` + `FLYWHEEL_FOUNDER_CONSENT_ENABLED`。runbook:updater 原子删 `.env:149`。

## 2. B 组退役 — auto-QA 管线 + founder_milestone_report

### B1. auto-QA:死/活二分表

生产铁证(2026-08-22 只读):`auto_qa_record` 74 行,最后写入 **2026-07-12 21:13**;`qa_required=1` 快照最后落于 07-13(flywheel)/07-11(geoforge3d);DAG QA session(role='qa')flywheel 434 个、最新今天。管线休眠 40+ 天,DAG QA 是唯一现役路径。

**死(随本单删)——Codex R1 #2 补全后的清单:**
| 资产 | 说明 |
|------|------|
| `auto-qa-policy.ts`(80 行) | 启用决策(FLYWHEEL_AUTO_QA + qa.auto + no-qa label + skip_labels) |
| `auto-qa-config-source.ts`(72 行) | canonical-root qa 块加载 |
| `auto-qa-coordinator.ts` 中的 spawn 家族 | `manualSpawnQa` / `onMainAwaitingReview` / `spawnQa` / `driveRetest` / `onQaResult` / `onQaSessionFailed` / `sweepOrphanedQaRecords`(A-3)/ recovery 家族 / `qa_required` 快照写入(:553/:585)与 A-1b backfill(:1938+) |
| **`manual-qa-routes.ts` + 两处 `/api/qa/manual-spawn*` mount + `BridgeAppOptions.manualQaTokens` + fleet 接线 + 路由测试** | 手动 QA spawn 是同一退役机制的人工入口(Codex R1 #2 补) |
| `auto-qa-effects.ts`(881 行)中 QA-issue 创建/retest/close 效果 | `createQaIssue` / `retestWakeQa` / `closeQaRunner` 等 |
| `lead-rules-base/auto-qa-pipeline.md` | Lead 提示词块(claude-lead.sh 装配处同步删) |
| HeartbeatService `auto_qa` stuck 巡检(:1856 附近) | stuck 状态推进 |
| `plugin.ts:8713` orphan sweep 接线、`event-route.ts:1192/2908/2933` spawn 触发接线 | 触发边 |
| StateStore 写方法 | `INSERT INTO auto_qa_record`(:8592)、`setQaRequiredSnapshot` 等**只被死者调用**的 mutation/spawn API(读 API 全保留,见活表) |
| env `FLYWHEEL_AUTO_QA` + config key `qa.auto`(**整个顶层 `qa` 块**) | registry 两行(`auto_qa_killswitch` :429-450、`qa_auto` :1066-1086)、store-policy `PROTECTED_LEGACY_FLAG_NAMES` 中 `auto_qa_killswitch`、ConfigLoader `qa` 块解析(含 skip_labels/agent 等全部子键)、types、`.flywheel/config.yaml` qa 块 |
| `FLYWHEEL_QA_RECONCILE_EVERY_N_TICKS`(truth.ts:570 allowlist + 读点) | auto-QA 对账节拍 tuning env,随机制死(Codex R1 #6 补) |

**活(必须搬家/原地保留)——Codex R1 #2 修正后:**
| 资产 | 为什么活 | 去向 |
|------|---------|------|
| **`auto-qa-held.ts`(224 行)** | **不是纯 codex-held 恢复**:它是 merge-block / codex 证据 / 冻结 auto_qa_record 证据 / ship-relevance 的共享 fail-closed 授权与 founder-surface 谓词,被 DirectEventSink / event-route / actions / gate-poller / question-admission / founder-consent wiring / issue display / 三个 approval-signal 模块 import。删它 = 编译崩或放松 founder 批准面 | **byte-for-byte 迁 `review-hold.ts`(中性名)**,只删其中 hard-gate-off 分支 |
| `onCodexReviewResult`(coordinator:836-903,去掉尾部 re-drive spawn) | **codex 硬门的证据写入者**(`recordCodexReviewApproved` → verify-approval 读 codexApprovedForHead)——A6 刚把这扇门焊死 | 搬独立模块(如 `codex-review-ingest.ts`),event-route.ts:1209 接线随迁 |
| `alertMergeWithoutApproval` / `alertShipAttemptFailed` / `alertCompleteMarkerHeld`(coordinator:778-835) | merge-block(FLY-869)/ship-attempt(FLY-1505)/marker-held 告警,属于焊死的 merge/QA 门配套;DirectEventSink:703/793、event-route:1673/1752/2566、plugin:6753 在调 | 搬独立告警模块,调用点随迁 |
| **`AutoQaEffects.postThreadResult`** | `ReviewRequestCoordinator` 经独立 `AutoQaEffects` 实例使用(plugin.ts:9206-9231) | 搬中性 review-thread effect 模块后才许删/收窄 effects 类 |
| **`codexHold` + `reconcileCodexHolds`(plugin.ts:9359 外部调用)+ 其活体触发边(Codex R2 #2)** | codex-hold → 证据落地后推进 ship-ready 的恢复路,服务焊死的 codex 硬门(非 spawn 职能)。**触发链警示**:现网首次 codexHold 由 `onMainAwaitingReview` 前段发起(该方法整体在死表),`reconcileCodexHolds` 只在 Bridge 启动跑——若只留后者,新进入 review 的 session 要等 Bridge 重启才拿到 once-per-head codex 指令 requeue | 从 `onMainAwaitingReview` **前段抽出中性 codex-review hold handler**,保留两个活体完成调用位(event-route awaiting_review 入口 + DirectEventSink);codex 满足后即停,**不得进入任何 QA policy/spawn 路径**。测试:Bridge 启动后新进 review 的 session 拿到 hold/requeue + 既有重启对账用例 |
| **`auto_qa_stuck` alert kind**(infra-event-router:60 + kind-contract:130)+ `GatePoller.handleHeldReviewGate` | held-review 卡门告警仍是活职能(门恒在);但恢复文案指向将删的 manual-QA 端点 | **保留 kind(历史名,episode 连续性)**,重写恢复文案(指向 cancel/re-dispatch 出口);kind-contract 注记历史名由来 |
| `auto_qa_record` 表 + **全部读路径** | 冻结历史账本:`evaluateQaShipGate` legacy 路径、`lifecycle-root-key.ts`、`lifecycle-closeout.ts`、`fanout-finalization.ts`、`scripts/cycle-time/lib/collect.mjs`、qa-framework eval 读取(Codex R1 #2 补全) | 原地,零改动;写者归零;所需 StateStore 读 API 保留 |
| `evaluateQaShipGate` 双路径本体 | 防盗门永远设防(A7) | 原地(只删 gate-off 出口) |
| `alertCodexGateBlocked` deps(:210) | codex 门告警(门恒在) | 并入搬家告警模块 |
| `isReviewableRole` 等共享谓词 | 搬家模块复用 | 随迁 |

**实施纪律(Codex R1 #2)**:动手前产出 symbol 级 caller matrix(coordinator 方法 × effects 方法 × routes × alerts × 冻结表读者 × 每个外部调用点),每步删除以「生产编译通过 + 零意外 caller」为前置;上表是 matrix 的起点不是终点。

**退役后语义(刻意更严,Codex R1 #3 修正):** 非 DAG code-PR session 将以 `qa_required=NULL` → `qa_snapshot_missing_failclosed` 永久卡门(A-3 sweep 与 manual-QA 端点都死了,**不存在任何补 QA 证据的路——含 founder:`reviewHoldReason` 返回 qa_evidence_missing 时 approveExecution 也拒**)。受影响 session 的**唯一受支持出口 = cancel + 在 `pipeline.dag` 下重派**(绝不做绕门的证据补写路径,「只严不松」)。删前必核(写进 PR):① `auto_qa_record` 零新增窗口复测;② 全项目近 30 天 session 中非 DAG code-PR 活体清点(**必须为零才许删**;非零则停,上报 Lead);③ `qa.auto`/`FLYWHEEL_AUTO_QA` 消费者 sweep(主仓 scripts/packages + 插件 fork + `~/.claude/plugins/cache`,FLY-1914 规矩,带时间戳)。

**2026-08-23 exact-head review 修订(覆盖上一段的未来路由结论):** R1 HIGH `non-dag-projects-permanently-ship-blocked` 证明「当下 0 个活体」不足以推出「未来无人依赖」:六个配置项目里只有 flywheel 显式 `pipeline.dag:true`,其余五个省略;近 45 天 tidal-echo 仍有 3 个 legacy PR session。Lead 对 question gate `04a2cf4a-5ec9-4652-9789-20f96e21b173` 裁定本 PR 内完成 fleet cutover:缺省 `pipeline.dag=true`;无项目 menu 的默认 binding 为全局 schema-v2 `tpl_code`;既有 custom binding 不覆盖;显式 `false`/配置不可读在 fresh code dispatch 边界 fail-fast;缺 binding 也拒绝,绝不静默落 legacy。现役清点为 **0 个** `pending/running/awaiting_review/needs_review/pr_created/approved_to_ship` legacy main code-PR session;仅有 3 条陈旧 `blocked` 行(FLY-523、growth/LEARN-209、历史 sub/LEARN-123,最后活动均不晚于 2026-07-05),无活 runner 会被翻转搁浅。这样 auto-QA 仍整体退役,A7 QA 防盗门不放松,其他项目从下一次标准 code dispatch 起进入 DAG QA 主路。

**2026-08-23 QA 5.9 binding 形状修订(覆盖上段的 wildcard 终态):** 生产只读复测发现 `workflow_category_binding` 只有 flywheel 的 6 条 exact 行,其余五项目尚无行;若 boot 为它们生成 `* → tpl_code`,`StateStore.getWorkflowCategoryBinding` 的 wildcard fallback 会让 `design/generic/prd/prototype` 错进期望 PR、终点 merge 的码流。终态因此改为对每个 DAG-on、非 menu-managed 项目只新增缺失的 6 条 canonical exact binding:`code → tpl_code`,`simple_code → tpl_simple_code`,`design → tpl_design`,`generic → tpl_generic_menu`,`prd → tpl_prd`,`prototype → tpl_prototype`;不生成 wildcard,不覆盖 operator 已有 exact 或 wildcard。flywheel 继续由 menu reconcile 补齐同一矩阵,所以舰队验收是 **6 项目 × 6 exact 行 = 36 行**。`pipeline.dag:false → DAG_DISPATCH_DISABLED`、缺 exact binding → `DAG_ENTRY_NOT_MATERIALIZED` 保持 fail-closed,活动 work-kind 域不得借 wildcard 回落。

### B2. founder_milestone_report(全家谱,Codex R1 #6 补全)
- 删:`gate-poller.ts maybeEmitMilestoneReports` + 接线、`founder-milestone-config-source.ts` 整文件、ConfigLoader/types 的 `founder_milestone_report` 块(**整个顶层路径含 milestones 子键**)、registry `founder_milestone_report_enabled` 行、`.flywheel/config.yaml` 的块(本仓提交)、两个测试文件。
- 删(机制配套):`emitFounderMilestoneNotification`、`founder_milestone_undelivered` kind(LeadAlertNotifier / infra-event-router / kind-contract / founder-thread-notifier / alert-kind-copy)及其测试;三个 tuning env `FLYWHEEL_FOUNDER_MILESTONE_{PATROL_TICKS,LOOKBACK_HOURS,GRACE_MS}`(truth.ts:558-562 allowlist 行 + gate-poller.ts:2065-2081 读点)。
- 诚实边界:flywheel 现网 enabled:true——删除后 failed/blocked 终态不再有 mechanism-guaranteed @founder push;现役覆盖 = DecisionLayer→Lead relay + FLY-1687 Lead 巡检。founder 圈删,照办;design HTML 里如实标注这条损失。
- config-key 墓碑:见 §4。

## 3. C 组 — 「新 flag 默认纳管」机械强制

现状缺口:`getStoreEligibility`(store-policy.ts)对不在 `STORE_MANAGED_FLAGS` 的 flag 返回 `not_store_managed` —— 合法状态,不红。存量基线:registry 48 spec(env 37 / project_config 11;direct 9 / readonly 22 / conversational 17)。**本单退役触及 13 个 registry spec 名**(A 组 10 + `auto_qa_killswitch` + `qa_auto` + `founder_milestone_report_enabled`;12 项 founder 裁定中 auto-QA 一项对应两行),落地后 registry 余 **35** 行(48 − 13)(Codex R1 #4 修正)。

设计(exploration 选项 C1,按 Codex R1 #5 收紧——豁免面归零):
1. `LEGACY_UNMANAGED_BASELINE`:**不可变最大集合,按 spec 名冻结,含存活的 governance_gate spec 与 project_config spec 在内的全部现存非纳管名**。守卫断言:当前非纳管集合 ⊆ 冻结字面量(只许缩不许长)。
2. 新增 spec 的唯一合法形态:名字在 baseline 外 ⇒ **必须** ∈ `STORE_MANAGED_FLAGS` 且具备 env-backed codec、运行时 store wrapper 读点、seeded row(`StateStore.ensureFlagValueRows`)、management-route 测试。**公式里不给 `FLAG_EXEMPTIONS` 位置**(exemptions 是 registry 外的账,`auditFlagAccounts` 本就拒绝双账重叠——放进公式 = 注册外逃生门);**不给 category 级豁免**(新 spec 自贴 `governance_gate` 标签即可逃逸)。
3. project_config 约束:现行 store 只支持 env-backed flag(`ensureFlagValueRows` 需要 envVar + codec)⇒ 在项目级 store 授权存在之前,**机械拒绝新增 `project_config` spec**(想加项目级开关 = 先建项目级 store authority,另立 issue)。
4. **FLAG_EXEMPTIONS 同步闭网(Codex R2 #3)**:既有 `auditFlagAccounts` 会接受一条字段齐全的新 exemption + 真实代码读点——「只写 exemptions 不注册」在现行审计下**不会红**,这正是 C 组要堵的旁路。修法:exemptions 名单同样按名冻结为不可变最大基线(只许缩);新的生产 boolean env 读点 + 新 exemption 条目(即便 reason/owner/persistence 全合法)⇒ RED。未来真正的 invocation seam 若需通道,走单独受约束的非产品 ledger,不得伪装成 runtime flag。
5. 守卫测试(config 包):上述公式 + **阳性对照**(注入虚构新 env spec → RED)+ **两个阴性对照**(a. 新 spec 自贴 governance_gate → 仍 RED;b. **同时注入假读点 + 一条字段全合法的新 exemption → 仍 RED**——证明 #4 的冻结真的闭网)。报错文案直接给「加 flag 的唯一姿势」runbook 路径。
6. runbook:`doc/engineer/implementation/flag-authoring-runbook.md` —— 注册 registry → 入 `STORE_MANAGED_FLAGS` + codec → seeded row → 读点走 store wrapper(FLY-1778 具名 wrapper 模式)→ management-route 测试 → 守卫全绿;FLAG_EXEMPTIONS 是冻结的存量账,不是新 flag 的逃生门。
7. 明确不做:存量 37 env flag 的批量迁 store(FLY-1405 台账按批走,exploration 选项 C2 否决)。

## 4. 墓碑与登记机制扩展(数字按 Codex R1 #4 校正)

- 五本账分开数:**12 项 founder 裁定 → 13 个 registry spec 删除(post-count 48→35)→ 11 条 envVar 墓碑 → 2 个 config 顶层路径整体退役 → 4 个辅助 tuning env 单列退役**。
- `RETIRED_FLAGS` 新增 **11** 条 envVar 墓碑(retiredBy: "FLY-1981"):REPORTS_TTL_DAYS / WORKFLOW_RESUME / INSTRUCTION_PATH_CHECK / AUTO_QA / CODEX_HARD_GATE / DESIGN_HTML_GATE / SHIP_CI_GUARD / QA_DONE_GATE / FOUNDER_ATTRIBUTION_GATE / FOUNDER_CONSENT_DECISION_MODE / FOUNDER_CONSENT_ENABLED(legacy 别名从 NON_FLAG_ALLOWLIST 移入)。tuning env(QA_RECONCILE_EVERY_N_TICKS + FOUNDER_MILESTONE_×3)随 B 组机制死,是否入墓碑按其现分类处置(allowlist 行删除 + 若曾是 flag 则墓碑;实施时按 truth 守卫指引)。`LEAD_CORE_MENTION_GATED` **不入墓碑**(plumbing 存活,入 NON_FLAG_ALLOWLIST)。
- 新增 `RETIRED_CONFIG_PATHS`(truth.ts,平行于 RETIRED_FLAGS):**整个顶层 `qa` 与 `founder_milestone_report` 路径**(非仅 .auto/.enabled 叶子——skip_labels/agent/milestones 子键一并拒;Codex R1 #6),retiredBy FLY-1981。ConfigLoader 在 YAML parse 后即拒(loud reject 而非静默接受——ConfigLoader 不拒未知顶层字段,删 types 后 stale 块会被静默吞);drift/truth 守卫拒绝再注册;ConfigLoader 测试覆盖备用子键形态。
- 集合守卫:仿 FLY-1806「31 条集合守卫」,断言 **13 个 spec 名**在 registry 精确归零 + post-count == 35 + 生产代码读点归零(grep 谓词式,阳性对照)。
- **辅助退役账(第五本,Codex R2 #4)**:4 个非 flag tuning env(`FLYWHEEL_QA_RECONCILE_EVERY_N_TICKS` + `FLYWHEEL_FOUNDER_MILESTONE_{PATROL_TICKS,LOOKBACK_HOURS,GRACE_MS}`)不入 11 条墓碑账,单列 ledger:断言零生产读点、零 allowlist 条目、零写者,并纳入消费者 sweep 覆盖面。

## 5. 生产迁移 runbook(单一无歧义顺序 + 回滚栅栏,Codex R1 #7 修正)

「代码 merge/staged」≠「新进程已部署」——顺序里显式区分:

1. **Stage**:PR merge 后班车构建新 artifact 就绪(尚未换进程)。
2. **原子删除**:updater 原子删 `~/.flywheel/.env` 两条(`FLYWHEEL_WORKFLOW_RESUME=1`、`FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE=audit_only`)。
3. **static preflight** 确认删净。
4. **no-old-binary-restart 栅栏**:步骤 2 与 5 之间禁止旧 binary 重启(launchd KeepAlive 场景下 = 删 env 与换进程必须在同一维护动作内完成)。否则旧 binary 以裸 env 重启 → workflow_resume 从 on 跌回 off、consent 从 audit_only 跌回 off——正是「变松」事故。
5. **部署新 Bridge**(班车)→ health + live preflight。
6. **行为验证**:resume 恒通(effective on)+ consent 审计仍在写(audit_only 语义)。
7. **回滚**:若需回旧 binary,**先恢复两条 env 值再启动旧进程**(反向栅栏)。

其余:`.flywheel/config.yaml`(本仓)qa 块 + founder_milestone_report 块删除随 PR 主提交;529 QA 房 `test-deploy.sh` 注入删除与驱动换路径同 PR(前置 = 窄批准路径真机冒烟通过),下一次 QA 房启动自然生效,无生产面。

## 6. 测试资产清单(实施时逐个处置)

- config 包:feature-flags-{resolve,drift,registry}.test / flag-truth.test / decision-mode.test(sentinel retarget)/ drift-scan.test / ConfigLoader.test。
- flywheel-comm:verify-approval.test(hard-gate live-toggle ×2 + attribution)/ ship-eligibility.test / ship-ci-guard.test / complete.test / await-codex-gate.test。
- teamlead:vitest.setup.ts **CODEX_HARD_GATE="0" 全局 pin 摘除**(高波及,plan 单列)/ auto-qa-{policy,coordinator,ship-gate-rebind,…}.test(死者删,搬家职能测试随迁;auto-qa-held.test 随 byte-for-byte 迁移改名 review-hold.test,仅删 gate-off 用例)/ manual-qa-routes 路由测试(删)/ event-route 家族 / DirectEventSink / complete-marker-reconciler / merge-ship-gate.integration / fly1505 家族(alert 搬家后指向新模块)/ codex-gate.test / flag-{routes,toggle}.test / feature-flag-render.test / management-existing-writers.test / StateStore.flag-value-store.test / gate-poller-milestone.test(删)/ founder-milestone-config-source.test(删)/ founder-consent 家族(enforce 死支用例删,audit_only 恒档断言)。
- qa-framework:eval sqlite-reader/extract 读 auto_qa_record —— 历史读留,断言不依赖新写入。
- shell:`scripts/__tests__` 中 test-deploy 相关合同(attribution 注入行消失后的合同更新)。

## 7. 风险台账

| 风险 | 等级 | 缓解 |
|------|------|------|
| vitest.setup 摘 CODEX_HARD_GATE=0 pin 引爆存量用例 | 中 | 单独 commit 先行摸底(≥13 个测试/setup 文件显式引用,另有隐性依赖);**凡建模 code-PR 场景一律给真 `recordCodexReviewApproved` 证据;`codex_skip` 仅限场景本就建模 sanctioned skip/no-code 合同**(Codex R1 #8);转换清单入 PR 供 review;不许测试内重设 env 复活旋钮 |
| coordinator 拆解漏搬活职能(review-hold 谓词/codex 证据写入/三类告警/postThreadResult/codexHold 恢复) | 高 | §2 死/活二分表 + symbol 级 caller matrix 前置;每删一步生产编译过 + 零意外 caller;fly1505/merge-ship-gate 集成测试全绿为准 |
| 529 QA 房批准换路后驱动回归 | 高 | 终形 = 既有 `/api/actions/approve`(writer="bridge",engine authority / awaiting_review 两形态,§1 A9 源码证据链);真 `verifyApproval` 合同测试 + 对抗矩阵;预删除冒烟 + final-head 冒烟都过才删 =0 注入(顺序不可倒) |
| 非 DAG code-PR 活体漏查 → 退役后卡门 | 低(证据 40+ 天零写入) | 删前必核三步写进 PR,活体必须为零;卡门方向 = 更严,唯一出口 = cancel + `pipeline.dag` 重派(不存在人工补证据路) |
| .env 残值清理顺序错 | 低 | 走 §5 单一七步顺序(no-old-binary-restart 栅栏 + 回滚先恢复 env);两值 == 固化值,栅栏内新旧字节行为一致 |
| 插件 fork / plugins cache 消费者漏扫 | 中 | FLY-1914 三 root sweep 带时间戳进 PR body,查不到的 root 显式写「未检查」 |
