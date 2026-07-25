# FLY-1462 rework 永久 hold:terminated holder 空 tmux_session 误判 — 调研

Issue: FLY-1462 (https://linear.app/geoforge3d/issue/FLY-1462/infra引擎-rework-永久-holdpersisted-target-missing-terminated-holder-空)
日期: 2026-07-24
基于: exploration.md

以下全部为对本仓(branch `flywheel-FLY-1462`,base = main @ dc754746)的实读审计,非推测。

## 1. 分类器现状(改动目标)

`packages/teamlead/src/bridge/phase-actor-reentry.ts`(全文 53 行):

```ts
export async function classifyPhaseActorReentry(input: {
	session: PhaseSession;
	probeRegistered(session: PhaseSession): Promise<PhaseLiveness>;
	probePersisted(session: PhaseSession): Promise<PhaseLiveness>;
}): Promise<PhaseActorReentryDecision> {
	const registered = await input.probeRegistered(input.session);
	if (registered === "alive") return { kind: "wake", reason: "registered_alive" };
	if (registered === "dead_pin") return { kind: "replace", reason: "registered_dead_pin" };
	if (registered === "indeterminate") return { kind: "hold", reason: "registered_liveness_indeterminate" };
	if (!input.session.tmux_session) {
		return { kind: "hold", reason: "persisted_target_missing" };   // ← 卡死点(42 行)
	}
	const persisted = await input.probePersisted(input.session);
	if (persisted === "alive") return { kind: "wake", reason: "persisted_target_alive" };
	if (persisted === "dead_pin" || persisted === "absent") return { kind: "replace", reason: "persisted_target_dead" };
	return { kind: "hold", reason: "persisted_liveness_indeterminate" };
}
```

决策类型 `PhaseActorReentryDecision` 是 tagged union:`wake | replace | hold`,每个 kind 各带 reason 字面量 union。**`session.status: string` 已在 `PhaseSession` 上存在**(`phase-orchestrator.ts:63`),分类器已拿到 status,只是没用。

## 2. 两个消费者(改动 blast radius 全集)

`classifyPhaseActorReentry` 全仓生产代码只有两个调用点(grep 证实):

### 2a. `workflow-rework-coordinator.ts:321`(FLY-1150 卡死的现场)

`reconcile(requestId)` 流程:claim delivery(generation+1)→ 校验 request/route/delivery/run → 取 actor session → 分类:
- `hold` → `releaseAndHold`:释放 delivery(写 `last_error=reason`)+ 尽力 `alertHold` → 下个 tick 重来。
- `replace` → `advanceWorkflowReworkDelivery(... to: "replacement_pending", error: reason)` → 返回 `{kind:"replacement_pending", executionId, reason}`。
- `wake` → assertWorktreeReady → activateActorForWake → admit + grantTurn → 唤醒原 holder。

### 2b. `phase-orchestrator.ts:2101` `isWakeTargetProvenDead`(FLY-1224 C8,三段式 keep-alive)

```ts
const decision = await classifyPhaseActorReentry({ session: row,
	probeRegistered: this.deps.effects.probePhaseAlive,
	probePersisted: this.deps.effects.probeGhostTmux });
return decision.kind === "replace";
```

replace = proven dead → 走 spawn fallback;hold/wake = 维持现有 wake 路径。其 JSDoc 明言:"a row with no persisted target keeps the existing wake path (fail-closed)"——本次改动会让 **proven-dead 终态 + 空 target** 的行改判 dead → spawn fallback。对 terminated/failed 行而言 wake 本来就不可能成功(registration 已清,唤不醒),改判是修复而非风险(与同文件 `DEAD_QA_STATUSES = {completed, failed, terminated}` 的"这些 QA 行不再运行"语义一致)。

## 3. hold 的重驱动机制(修复自愈性的证据)

`workflow-engine-dispatcher.ts:550 reconcileWorkflowReworks`:每个 engine reconcile tick 扫 `listWorkflowReworkDeliveries({states:["pending","turn_granted"]})`,对每条调 `coordinator.reconcile`;`replacement_pending` → `materializeWorkflowReworkReplacement`(分配新 executionId,写 `rework_replacement_launched` 事件)。

`StateStore.claimWorkflowReworkDelivery`(18660 行起):**无 generation 上限**——每次 claim `generation+1`,lease 30s。FLY-1150 的 generation 980 = 已被重试 ~980 次(issue 原文"已重试上限"措辞不准确,实际无上限、会永远重试)。**结论:修复 merge + Bridge 重启后,下一个 tick 重分类 → replace → replacement_pending → 新 implement runner,FLY-1150 无需任何人工动作自愈。**

## 4. `tmux_session` 列生命周期(为什么会空)

- 写入:`StateStore` upsert 用 `COALESCE(excluded.tmux_session, tmux_session)`(3769/4003 行)——**只增不清**,新值为 null 时保留旧值。
- 全仓无 `tmux_session = NULL` / clear 路径(grep 证实)。
- 空 = 该行从未持久化过 target(FLY-939 G-C 之前的行、或窗口回收发生在持久化之前的时序,如本次 ship_parked 回收)。
- `listTerminalSessionsWithResidue`(FLY-1185)把"terminal 但还留 tmux_session"当 residue 扫——印证 terminal 行留着 target 是待清理的例外而非常态。

## 5. 终态词汇审计(proven-dead 集合的依据)

仓内已有三套相关词汇,语义各异,**均刻意不互相复用**(StateStore 注释原话:"Deliberately NOT reused … the semantics differ"):

| 词汇 | 位置 | 成员 | 语义 |
|---|---|---|---|
| `TERMINAL_STATUSES` | StateStore.ts:274 | OUTCOME_STATUSES + awaiting_review − approved_to_ship | 单调性:进了就不许回 running |
| `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`(导出) | StateStore.ts:297 | completed, failed, terminated, blocked, rejected, deferred, shelved | 不可逆终态:该行永远不会再通过正常流程回答 gate(FLY-1099 Z1) |
| `AUTO_CLOSE_STATES` | close-runner.ts:53 | completed, rejected, deferred, shelved, terminated | closeRunner **杀 tmux + tab** |
| `CRASH_PRESERVE_STATES` | close-runner.ts:63 | failed, blocked | closeRunner **保留 tmux 尸体**供取证(壳在,进程已死) |
| `DEAD_QA_STATUSES` | phase-orchestrator.ts:227 | completed, failed, terminated | 该 QA 行不再运行(FLY-1050 respawn 判据) |
| `TERMINAL_SESSION_STATUS` | phase-orchestrator.ts:219 | completed, failed | turn-belt 快速通道;**terminated 被 FLY-1050 Codex R1#1 明令禁止加入**(cleanupPending:FSM terminal 但 tmux 还活着,必须留给探针路径守) |

**关键教训(FLY-1050)**:`terminated` ≠ 进程已死——terminate 可返回 cleanupPending。但该守卫的作用面是"**有** tmux target 可探"的行;target 为空时探针物理不可运行,cleanupPending 的 target 恰恰是已知的(cleanup 就 pending 在它上面),**不会落入空 target 分支**。故"空 target + terminated → replace"与 FLY-1050 守卫不冲突。

**`completed` 的特殊性**:completed 是 parked-alive 的常规形态(三段式 park 复用模型:干完活、窗口停着等 wake)。"没有 target"对 completed 行不构成死亡证据(可能是 target 持久化失败的活 parked 窗)。现有测试夹具 status 恰为 `"completed"` 且断言 `absent + 无 target → hold`(见 §7)——把 completed 排除出 proven-dead 集合,既是语义上的正确边界,也让既有断言原样保留。

## 6. reason 字面量下游消费审计

grep 全仓(排除 dist/tests):`persisted_target_dead` / `persisted_target_missing` **无任何生产代码按字符串分支**。消费方式仅两种:
- 作 `error` 字符串写进 `workflow_rework_delivery.last_error`(TEXT 透传)+ `advanceWorkflowReworkDelivery` 的 error 参数 + 日志;
- 测试断言(`workflow-engine-dispatcher.test.ts:1251,1303`)。

**结论:新增独立 reason 字面量(如 `terminal_status_dead`)是低风险的**,只需扩 union 类型。取证诚实性支持新 reason:`persisted_target_dead` 的语义是"探针探过 target 且证死",空 target 分支根本没跑探针,复用该 reason 属于"拿标签冒充事实"(Annie 明令的失效模式)——审计 last_error 时会误导取证。

## 7. 既有测试形态(必须不翻转的断言)

`packages/teamlead/src/bridge/__tests__/workflow-rework-coordinator.test.ts`:
- 夹具 `session = { …, status: "completed", tmux_session: "flywheel:implement-exec", … }`。
- `describe("classifyPhaseActorReentry")` 用 `it.each` 表驱动 8 行,其中 `{ registered:"absent", hasTarget:false, expected:"hold" }` = **completed + 空 target → hold**(本设计保留)。
- 断言 `probePersisted` 调用次数:`registered==="absent" && hasTarget ? 1 : 0`——新增的空 target 早退分支不调 probePersisted,兼容。
- coordinator 级 `makeHarness` 可覆盖 registered/persisted,session 为模块级常量(新增 terminated 场景需允许 session 覆盖或另造行)。

另一处消费者测试:`packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts:1251,1303` 断言 replace reason 为 `persisted_target_dead`(走的是有 target 的探针路径,新逻辑不影响)。

## 8. 事实清单(设计输入)

1. 改动面 = 单文件 `phase-actor-reentry.ts` + 类型 union 扩一个字面量 + 测试。
2. 两个消费者语义一致(replace = proven dead),同改同益,无需分叉。
3. 修复自愈 FLY-1150(engine tick 重驱动,无 generation 上限)。
4. proven-dead 集合 = `terminated, failed, rejected, blocked, deferred, shelved`(= ZOMBIE 集合 − completed);本地枚举 + 逐值注释(仓内惯例),不做集合运算派生(避免静默继承他人未来的语义变更)。
5. `completed` 维持 hold;`running/pending/ship_parked/awaiting_review/approved_to_ship/design_done/approved/timeout` 等一律不进集合(活跃、或语义模糊 → 保守面不动)。
6. 新 reason `terminal_status_dead`,不复用 `persisted_target_dead`。
7. 无 feature flag(纯引擎逻辑,Annie 铁律)。

## 9. 更正附录(post 独立对抗性 review,2026-07-24)

独立 Claude 对抗性 review(见 `claude-design-review-r1.md`)证伪了本文三处结论,以此附录为准:

1. **§4 `tmux_session` 生命周期——"写入: COALESCE upsert"具误导性**:upsert 支持该列,但全仓**无任何生产调用方传入非空值**(grep:仅 StateStore 列名映射 4165 与 dashboard 读)。生产实锤(`phase-orchestrator.fly1329-park-alive.test.ts:104,223` pin,2026-07-17 对活库核查):**1423 行 session 的 `tmux_session` 全部 NULL**。推论:分类器"有 target 的探针路径"生产不可达;空 target 分支是 registration-absent 后的**全部**生产决策路径。"FLY-1050 cleanupPending 一定带 target 不落空分支"的安全论证不成立——cleanupPending 的真守卫是 kill 失败时 **CommDB registration 被保留**(`actions.ts:1537-1546` physicalGone=false → 不 finalize)。
2. **§2b/§8-2 "第二消费者同受益"为死代码**:`isWakeTargetProvenDead` 两个调用点的行均来自 `getAlivePhaseSession`,生产 wiring 过滤 `{running, awaiting_review, approved_to_ship, design_done}`(`plugin.ts:9368-9375`),与 proven-dead 六态不相交。消费者 2 既无收益也无风险。
3. **新发现(review HIGH-1/MED-3,进 plan v2)**:① probe wiring(`plugin.ts:9479-9486`)经 `getTmuxTargetFromCommDb` 把 CommDB **读错误**折叠成 `absent`(`tmux-lookup.ts:268` NOTE 自认),status-only 的 replace 会让瞬时 sqlite 锁触发不可逆替换;② terminate 对查无 registration 的 session 直接 `physicalGone=true` 不尝试 kill(`actions.ts:1544-1546`)——status=terminated **不**蕴含物理死亡。故 plan v2 要求三重证据(六态 + registration 确无 + FLY-1374 exec-marker 全局扫描 missing)。exploration §6 "根治一整类"措辞相应收敛为:根治"已证死"子类;`completed` 姊妹 hold 与可见性告警留 follow-up。
