# FLY-1614 held-carrier 缺陷修复 — 实施计划(run 2 rework,R2 折入 Codex R1×4)
Issue: FLY-1614 (https://linear.app/geoforge3d/issue/FLY-1614/巡检场景1-节点完成下一棒交接无死线无自播报-turn-beltfounder-gate-停滞只能靠-lead-查表发现今晚-3)
日期: 2026-08-11
基于: plan.md、design-correction.md、QA claim 139(qa_failed @ head 253b283f)、~/.flywheel/qa-evidence/FLY-1614/retest-checklist.md

## 0. 一句话

前 run 的完整实现(PR #805,Codex R2 APPROVED)被 QA 判 FAIL,唯一 blocking finding:**可恢复的 held run 会把 founder 已批准的 ship-carrier delivery 静默、永久地终态化**;本 rework 只修这一处 —— held→active 恢复时对 `workflow_carrier_delivery` 做与 `workflow_rework_delivery` 同款 un-hold(FLY-1628 机制镜像)+ `settleWorkflowCarrierFailure` 的 cancel 分支必发告警,其余实现原样采纳,不重推。

## 1. Run lineage(为什么这是 rework 而不是新设计)

- **Run 1**(9bd7a57e):design→implement(PR #805)→ QA **FAIL**(claim 139,serverSeq 139,head `253b283f`)→ rework 投递卡 `worktree_not_ready:head_mismatch` → tmux server 事故全员死亡 → founder 授权 terminate。
- **Run 2**(ccd8cca3,本 run):恢复重派。Lead 接续令([lead-instruction df1fc3b2-9bfc-4ea6-8546-fcbcec50eff3])钉死范围:采纳既有 plan.md + design-correction.md + PR #805 实现,只折入 FAIL 修复。
- QA 明确豁免:**其余全部通过,无需重推** —— 16/16 生产副本集成、4/4 真 Discord E2E(529 房)、四包本地套件、CI 9/9 绿;pre-fix 生产基线(5 个真实 approved runner_ship gate 批准后零 engine grant)成立。

## 2. 病理(QA claim 139,已在 head 253b283f 代码逐行核实)

`settleWorkflowCarrierFailure`(StateStore.ts:33577)的 `run.status !== "active"` 分支(:33640-33682):

1. **held(可恢复)与 terminal(completed/terminated)一视同仁地终态化**:held run → delivery `state='held'`、`next_retry_at=NULL`、`owner_id=NULL`,1/2/4/8min 退避阶梯一次都没走(`hold_count` 停在 0);
2. **事件名撒谎**:两种情况都 append `carrier_delivery_cancelled`(:33666)—— held 明明是"暂停"却记成"取消";
3. **零告警**:该分支不 enqueue 任何 `workflow_alert_outbox` 行(对照 active 分支耗尽时 :33726 有 severe 告警);
4. **无自复活**:`listWorkflowCarrierDeliveries` 默认 drain 集合 = `pending/grant_started/turn_granted`(:32939),held 永不入列;run 恢复 active 后 drain 返回 delivered=0/held=0;
5. **不对称**:FLY-1628 pane-loss held→active 恢复(StateStore.ts:20969)显式 un-hold `workflow_rework_delivery` 并重置 hold_count,carrier delivery 无对应物;
6. **唯一生路 = 人**:authenticated operator redrive(StateStore.ts:32867)是全表唯一把 state 写回 `pending` 的路径(QA 反证法枚举全部 UPDATE 证明)。

现实路径(QA 原文):founder 批准 ship → carrier runner pane 死 → pane-loss hold run → carrier delivery 被静默终态化 → pane-loss 恢复 run 回 active → rework delivery 复活而 carrier delivery 不复活 → **批准过的 ship 永远不会发生,且没人被告知** —— 正是 FLY-1614 立单要消灭的形态。可达性:生产当前 27 个 `status='held'` run,自动 held→active 路径存在。

## 3. 修法(四个写点,全部沿用既有机器,零新组件)

### 3.1 Fix A — `settleWorkflowCarrierFailure` 非 active 分支拆分(诚实 + 必发告警)

把 :33640-33682 一个分支拆成两种事实:

- **run held(可恢复)** → delivery `state='held'`,`last_error='run_inactive:held'`,**保留 hold_count 与退避语义不清零**;事件改为 **`carrier_delivery_held`**(uid `carrier_delivery_held:<questionId>:<generation>`);**enqueue 一条 severe Lead 告警**(escalationUid = `carrier_delivery_held:<questionId>:<generation>`,`eventId === escalationUid`,复用 `enqueueWorkflowEngineAlertTx` → 既有 `workflow_alert_outbox` claim/retry/receipt 机器)。generation salt 的正确性已核(Codex R1 确认):`generation` 是 ownership-claim generation(StateStore.ts:33004-33018 每次非幂等 claim +1,live same-owner replay 不加),held 后同 generation 不可能再 claim,只有复活回 pending 后新 claim 才得新 generation ⇒ 同一 hold episode 恰一条、复活后再 hold 可再报;**不得改用 `redrive_generation`**(自动 revival 不增它,会压掉后续 episode)。
- **run terminal(completed/terminated)** → 维持 `state='completed'` + 事件 `carrier_delivery_cancelled`(语义此时才成立);**enqueue 一条 severe 告警**(escalationUid = `carrier_delivery_cancelled:<questionId>`,`eventId === escalationUid`):founder 批准的 ship 随 run 终止被丢弃,批准证据丢失必须有人知道。精确口径(Codex R2):Fix D 原子含 owned `grant_started/turn_granted` 行,晚到的 owner 会输在 carrier CAS 上而非进入本分支;本分支的主要存在意义是**其他不同步收敛 carrier 行的异步 run 终态写者**。
- **告警正文 = 可执行的恢复指令(Codex R1 #2)**:held 告警不得直接给 operator redrive 原文 —— redrive canonical 要求 run 已 active 且 tuple 仍 current(StateStore.ts:32751-32774),run 仍 held 时 stage 必拒。正确正文:①先恢复 held run(pane-loss recovery);②Fix B 会在 held→active 同一事务自动复活 delivery;③仅当 run 已 active 且自动复活未发生时才用 guarded carrier redrive。terminal 告警正文指向 operator rework / 重新取得批准,并注明「若 terminate 属预期可忽略」;不复用 held 的 redrive 指令(completed 行不可 redrive,:32771/:32873)。
- **alert disposition 类型面(Codex R1 #3)**:`carrier_delivery_held` 与 `carrier_delivery_cancelled` 加入两处 disposition union(StateStore.ts:38564-38586;LeadAlertNotifier.ts:388-410);**不得借用 `carrier_delivery_exhausted`**。

### 3.2 Fix B — held→active 恢复位点补 carrier 复活(FLY-1628 镜像)

新共享 tx helper `reviveHeldWorkflowCarrierDeliveriesTx(runId, now, reason)`:

```sql
UPDATE workflow_carrier_delivery
   SET state='pending', owner_id=NULL, lease_expires_at=NULL,
       next_retry_at=NULL, last_error=?, updated_at=?
 WHERE run_id=? AND state='held' AND last_error LIKE 'run_inactive:%'
```

- **不重置 hold_count**(与 operator redrive 的 hold_count=0 区分:自动复活继续消费既有退避预算,防「hold↔revive 死循环免费重置阶梯」;Codex R1 确认:inactive 分支本身不加 hold_count,保留值只保存真实投递失败已消耗的预算);每复活一行 append run event **`carrier_delivery_revived:<questionId>:<generation>`**(generation = 刚结束的 held episode 的 generation,与 Fix A 的 held 事件/告警精确配对;同 delivery 多轮 held→revive 各得独立 uid,避开 `workflow_event_uid_conflict`)。
- 调用点 = **穷举后的全部 held→active 写点**(全文件仅两处,已核):
  1. **StateStore.ts:20969**(pane-loss replacement recovery,`heldPaneLossRecovery` 分支)—— 在 un-hold rework delivery 的同一事务里调用。这是 QA 指名的镜像点。
  2. **StateStore.ts:23997**(`openOperatorRework`)—— 此处**不复活而是显式 cancel**(见 Fix C):该路径 supersede gate holder 并 revoke `founder_approved` claim,复活 delivery 会让 drain 去给已撤销的批准发棒。
- plan §2.2c 的教训在此复用:修复绑定「全部写点」而非单点;新增写点时测试矩阵红线(见 §5)会失败提示补调用。

### 3.3 Fix C — `openOperatorRework` 显式 cancel 未投递的 open carrier delivery

在 :23997 同一事务(supersede gate holder / revoke claim 之后)对该 run 所有 **undelivered open states**(`state IN ('pending','grant_started','turn_granted','held')`,**不含** `wake_delivered/receipt_started` —— 它们表示 handoff effect 已外发/已收据,不应倒写成「未投递取消」;旧批准的后续 ship authority 由 gate-holder supersede + claim revocation fail-close)的 carrier delivery 行:`state='completed'`,`owner_id=NULL`,`lease_expires_at=NULL`,`next_retry_at=NULL`(不留 completed 行上的假 lease),`last_error='operator_rework_superseded'`,逐行 append `carrier_delivery_cancelled:<questionId>:<generation>:operator_rework` 事件。**不告警** —— 操作者亲手发起的 supersede,run event 落账即可审计。

### 3.4 Fix D — operator `held → terminated` 的 carrier 终态收敛(Codex R1 BLOCKING)

`changeWorkflowRunStateByOperator` 允许从 held 直接 terminate run(StateStore.ts:23349-23353,写入 :23460-23462)—— 这是 held 状态的第三个出口,穷举 `SET status='active'` 抓不到它。若 carrier 已被 Fix A 置 held,operator terminate 后:不在 drain 集合、settle 只认 owned `pending/grant_started/turn_granted`(:33632-33638)→ 该行永久滞留,违反 §3.5 不变量。

修法:在 `changeWorkflowRunStateByOperator` 的 `target === 'terminated'` **同一事务**里调共享 tx helper,把该 run `state IN ('pending','grant_started','turn_granted','held')` 的 carrier 行收敛为 `completed`,清 `owner_id/lease_expires_at/next_retry_at`,`last_error='operator_terminate:<reason>'`,逐行 append `carrier_delivery_cancelled:<questionId>:<generation>:operator_terminate` 事件。**不额外发 Lead alert**(Codex R1 推荐项):显式 terminate 本身已是 operator-visible 动作并有 operator event,carrier cancel 落 run event 即可;与 Fix C 同一口径。与 §3.1 settle terminal 分支的告警不对称是刻意的:settle 分支 = 引擎**事后异步**发现批准被丢(无人在场,必须喊人);Fix C/D = 操作者**亲手同步**动作(在场,落账即可)。

### 3.5 设计不变量(本次修复后的可见性合同)

carrier delivery 离开 drain 集合的每一种迁移,必须满足其一:
(a) 可自动复活(held + Fix B 恢复钩子);(b) run event + Lead 告警(Fix A 两分支);(c) 操作者显式动作落账(operator redrive / Fix C / Fix D)。
不存在第四种 —— 这正是 claim 139 所违反、且本单标题所指的「静默停滞」。**穷举口径(Codex R1 教训)**:held 的出口不止 `SET status='active'` 两处字面写点,还有参数化的 operator transition(:23460);实现时必须以「所有改写 `workflow_run.status` 的事务」为审计面,而非字面 grep。

## 4. 明确不做(honest boundary)

1. **rework-held wedge(FLY-1671 形态,issue 评论 2026-08-11 10:39 + 11:52)**:`workflow_rework_delivery` 被 `worktree_not_ready:worktree_dirty` 这类瞬时原因 hold 后(`next_retry_at=NULL`、claim 只认 `pending|turn_granted`、执行体活着 → pane-loss recovery 帮不上)永久楔死 —— 同族病,但在 rework 投递机械本体。plan §2.4 明确「rework 主链投递机械不动」,且 FLY-1648(pending PR)正在同一机械上动刀(held materialize 退避→needs_lead)。**移出本 run**,报 Tadashi 裁决:立新单或并入 FLY-1648 复测面。本 run 只修 carrier 侧。
2. **§2.3 ledger validator 对 held run 的排除维持不变**:修复后 held 是暂态(要么 Fix B 复活,要么 Fix A 已告警),validator 无需为 held 新增谓词。
3. 其余 PR #805 全部机械(carrier drain/退避/needs_lead、turn_wait_ledger、turn_wake_outbox、validator、redrive、runbook)**原样采纳,零改动**。
4. **旧实现面的三条独立审计观察不进本 run 合同**(Codex R1 #4:严格遵守「采纳既有 + 只折 FAIL 修复」)—— 已单独整理为 Lead advisory,随设计报告经 `flywheel-comm ask` 提交 Tadashi 立项/裁决,implement 节点**不得**顺手处理。

## 5. 验收(TDD 合同 + QA retest-checklist.md 逐条)

新增测试(先红后绿):
| 面 | 测试 |
|---|---|
| Fix A | settle 三态分支:run held → state='held' + `carrier_delivery_held` 事件 + 恰一条告警(同 generation 重放不重发;复活后再 hold 新 generation 可再报);run terminated/completed → state='completed' + `carrier_delivery_cancelled` + 恰一条告警;run active → 既有退避行为逐字节不变(回归);告警正文断言含「先恢复 run→自动复活→仅后备 redrive」阶梯而非裸 redrive 指令 |
| Fix B | held 行经 20969 恢复后回 pending 且 hold_count 保留 → drain 立即拾取;`run_inactive:%` 之外的 held 行(未来新原因)不被误复活;**两轮 held→revive 各得独立 `carrier_delivery_revived:<q>:<gen>` uid**(单轮 CAS replay 不够);CAS/幂等(重放零行修改) |
| Fix C | operator rework 后 undelivered open 行全部 cancel + 事件 + owner/lease/next_retry 清空;`wake_delivered/receipt_started` 行不被触碰;drain 不再拾取;redrive 对 state='completed' 拒绝(既有行为回归) |
| Fix D | carrier 已 Fix-A-held → operator terminate(held→terminated,:23460)→ 行收敛 completed + cancel 事件;pending carrier → 直接 operator terminate 同款收敛;同一 clientRequestId 重放幂等;与既有 held→terminated 覆盖(StateStore.fly1385-dead-exec.test.ts:1140-1158)组合,不只用手工 DB terminal fixture |
| 端到端 | advisory-held.mjs 必须通过正规 pane-loss held→active 事务恢复:held 下不静默终态化(有事件+告警);恢复后 `listWorkflowCarrierDeliveries` 返回该 delivery 且 drain 复活(与 rework parity)。不得用 raw SQL `UPDATE workflow_run` 绕过恢复事务后要求常驻 read/reconcile seam 替测试兜底。 |

复测(QA retest-checklist.md 原文合同,由独立 QA 节点执行):advisory-held.mjs、harness.mjs(16 场景,生产副本)、harness2.mjs、discord-e2e.mjs(529 房 slot 3);**先重建 dist 并断言 dist == 被测 head**;ship report 在 fixed head 上重生成(旧报告 PASS banner 早于 FAIL finding,必须重出)。Lead 于 2026-08-11 裁决:QA 更新 advisory harness 以行使生产恢复事务;若部署时发现历史 `active run + held carrier` 遗留行,部署清单执行一次性 operator reconcile,不把遗留数据补偿写成常驻机制。

全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(既有宿主例外照实报告,不伪报整门全绿)。

## 6. Head 纪律(run 2 工作约定,QA 血泪档案全文收录)

qa_pass 走 `qa → founder_gate` 会进 FLY-1655 land-head gate:verdict head 必须命中 `workflow_node_pr_binding` 行(StateStore.ts:28069-28076),否则 `land_head_unavailable` → 裸 409。`flywheel-comm progress` 会把 progress.md commit 到被测分支 → **每次台账更新都把 HEAD 推离 PR binding**(前 run 因此产生三次漂移 commit)。

1. **verdict 窗内被测分支零台账 commit** —— tip 即 PR head,靠构造保证;
2. 已漂移:停手、push 使 remote tip == local HEAD、通知 Tadashi 等他 rebind(rebind 是 Lead 名下动作),自己不 rebind;
3. **绝不给旧 head 发证** —— 即使 `git diff <old> <tip> -- packages/` 为空。

## 7. 实施顺序(implement 节点)

1. 先红测试(§5 Fix A/B/C/D 全矩阵)→ 实现四个写点 → 绿;
2. 验证 advisory-held.mjs 的告警分支;其恢复分支由 QA 改为调用正规 pane-loss 恢复事务后复测;
3. 全仓门;
4. Codex code review(codex:rescue,loop until approved);
5. push(head 纪律 §6)→ 报 Tadashi;QA 复测 + ship report 重生成归独立 QA 节点。

版本号 ship 时取空号;无新 env、无新 flag、无 schema 迁移(全部沿用既有表列)。
