# FLY-1415 dead-exec 去判断化(Option 1 盲换)— QA 报告

Issue: FLY-1415 (https://linear.app/geoforge3d/issue/FLY-1415/engine韧性重构-dead-exec-处理去判断化-option-1bridge-只机械换人盲换3-耗尽升级所属-lead删死因分流)
日期: 2026-07-22
基于: plan.md

QA 节点(DAG engine-owned)verdict:**PASS**,已 durable 落库(`workflow_claims.predicate=qa_passed`,issuer=cee83825,subject_producer=88e29905,node state=done)。PR #669,head `b6b5b6f3`,CI 全绿。

---

## 1. 代码级验收(真 StateStore 单测,5 项能力级验收全覆盖,详见落库 verdict evidence)

| # | 验收 | 证据(测试) |
|---|------|------|
| 1 | 误判防护 | dispatcher #1146(idle working/awaiting_review→probe 0 调用 0 换)、#1182(terminal 但 pane alive→0 换);真 tmux 3.5a 隔离 socket 7/7,含 mixed(1死+1活 pane)→alive |
| 2 | 盲换自愈 | #1112(dead→1 换保 active)、#687(有 output 仍盲换、dead_execution_after_output 事件归零) |
| 3 | 耗尽升级 | #768(3 换死→held+retry_limit_escalated+人话告警+durable outbox)、#882、alert-routing 4 测(所属 Lead 权威链) |
| 4 | 去判断 | #1682(配额/provider/null 逐字节 toEqual)、dispatcher last_error 引用=0 |
| 5 | 无回退 | generalized-launch-recovery 探针全矩阵守卫 + 真 tmux 7/7 + 死码 sweep 生产源归零 |

CI:build+typecheck+lint / teamlead unit 1-3 / heavy / light / script / NPM 全 SUCCESS。无连带破坏(infra-alert-wiring metadata 读者 12 测通过)。

---

## 2. 完整隔离房 Discord E2E(§5.3 场景③,founder 指令 [lead-instruction f71b8c1f] 补齐)

**方法**:Tadashi-approved 模块驱动(不起全 Bridge、不碰生产 Bridge,避开 audit.db/dept-scope/TMPDIR 雷),但驱动的是**真生产代码路径**——真 StateStore 盲换耗尽 → 真 `WorkflowEngineDispatcher.reconcileWorkflowEngineAlerts()`(生产 outbox drain)→ 真 `LeadAlertNotifier`(真 global fetch)→ 真 Discord POST → 隔离频道 API readback(权威;Chrome-as-Annie headless 禁用 AskUserQuestion 且常撞登录墙,API GET readback 按队规为权威证据)。

**整条腿(exhaustion → alert outbox → 真 Discord POST → 频道真收到)18/18 PASS**:

- 所属 Lead 权威链:真 `resolveWorkflowRunAlertIdentity` 解析 run.selected_by(owning-lead)→ `{leadId:"owning-lead", leadResolution:"resolved"}`(**非** default-lead)。
- 盲换 3 次自愈期间 0 中途告警(决策 B);第 4 次盲换 → `retry_limit_exceeded`;run → `held`。
- outbox 耗尽告警 payload:routed to owning-lead;title「【需人工】FLY-1335 节点 implement 盲换 3 次仍起不来」;body「FLY-1335 的 implement 节点换了 3 次仍起不来,引擎已停手,run 已挂起(held),需要你判断下一步处理。」**不含 POST /api**;metadata launchCount=4 / maxBlindReplacements=3 / management.terminate / leadResolution=resolved。
- 真 dispatcher drain finalized=1;`LeadAlertNotifier.alert` 返回 `{sent:true, channelId, messageId}`;outbox 行转 `state=sent` + 追加 `workflow_engine_alert_posted` 审计事件。
- **Discord readback(终点取证,非工具自报)**:GET message id = 200,频道真收到,正文含人话「换了 3 次仍起不来」+ FLY-1335 + implement。
- 阴性对照:cursor 之后确有新消息且 id 匹配(排除读到旧回声)。

**投递证据**:
- 隔离频道:`#test-flywheel-alerts`(`1519421055805165842`,guild `1485787271192907816`)
- message id:`1529510518715449376`
- URL:https://discord.com/channels/1485787271192907816/1519421055805165842/1529510518715449376
- harness:`engineering/doc/FLY-1415-dead-exec-blind-retry/qa-fly1415-discord-e2e.mjs`(18/18 PASS)

**隔离纪律核实**:生产 `~/.flywheel/delivery-secret.*` 前后逐字一致(`52127555-...` @ Jul 19 01:29,未被本次触碰);FLYWHEEL_DELIVERY_SECRET_PATH/ALERT_QUEUE_DIR/DEADLETTER_DIR/CLAIMS_DB 全隔离到 scratchpad;未起真 runner、未重启任何 Bridge。

---

## 3. Codex code-review

DAG 独立 review 节点(非本 QA 节点 scope);Bridge merge 时独立 enforce codex_hard_gate。
