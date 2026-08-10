# FLY-1655 self-ship 按不变量重设计 — 调研(根因裁定)

Issue: FLY-1655 (https://linear.app/geoforge3d/issue/FLY-1655/founder-直令唯一单-self-ship-修了又坏-n-真根因每次修复只覆盖上一次事故的状态签名要按不变量重设计)
日期: 2026-08-08
基于: exploration.md

> 取证方法:5 条并行源码取证线(binding 写入路径 / 对齐杠杆前置 / 凭据过期 / 收尾 500 与重派 / founder 批准识别)+ 生产库只读快照(`VACUUM INTO`,teamlead.db 1.6GB + comm.db + 事故夜备份 `/tmp/comm.db.pre-gate-repair-20260807T031451Z`)+ 生产仓 git reflog 部署对账。全程零写生产。行号基于 `flywheel-FLY-1655` @ `cd922b4f`(= 当时 origin/main)。

## 0. 2026-08-09 founder 方向纠偏后的追加裁定

真库复核 FLY-1648 与当前 FLY-1655 的 `tpl_code` schema-v2 snapshot：图均只到 `founder_gate`，没有 ship/land 终节点；`implement` resolved capabilities 同时持有 `creates_pr/can_ship/can_land/approval_gate_holder`，QA 的三项均为 false。故“QA 自 ship”不是事实，真正结构是**DAG 缺终端 ship 节点，迫使上游实现 runner 兼任 shipper**。

仓内已有 schema-v1 `approval_gate -> land(execution=engine)` 原生能力、land executor 与默认 engineering land migration。按平台能力复用即可；无需继续扩建 runner carrier binding reconciliation、死亡交付推断或 gate-reissue saga。后续设计以 plan.md 的 terminal-land 不变量为准，本调研下文保留原始事故取证，但其中“应补齐旧 runner_ship 账”的方案性推论不再作为实施前提。

---

## 1. 实例 A 根因裁定:唯一真差异 = **gate 物化时刻生产在跑哪个二进制,且新码不对账旧 gate**

### 1.1 数据侧排除法(全部已证)

- 四个 run(FLY-1572/1596/1638/1648)的 `workflow_run.snapshot` **逐字节相同**(jq -S 排序后 cmp 相等,均 schema_version=2 / tpl_code rev 3)。⇒ issue 候选假设 Ⓐ(v1→v2 迁移改写)与 Ⓒ(manifest 形状差异)**对这四个 run 均不成立**。另证:全仓 `UPDATE workflow_run SET snapshot` 零命中——snapshot 只在 INSERT 时写,从无事后改写,Ⓐ 在机制上不存在。
- 四个 gate holder 形状**完全一致**:`authority_mode=runner_ship / subject_kind=git_head / carrier_binding_state=bound / materialization_stage=completed`,card 都发了,evidence claim 都在。
- 四个 carrier session 材料**齐全一致**:`worktree_binding_{path,branch,generation,locked_at}`、`pr_number`、`pr_head_sha`、`review_question_id` 全部就绪。1648 的 binding 写入所需的每一份材料都在,**只差那一次搬运**。

### 1.2 代码侧:v2 的 binding 写入步骤是 FLY-1638(PR #779, `f02ecbc8`)才存在的

`workflow_ship_target_binding` 全库只有一条 INSERT(`StateStore.ts:25064`,由 `recordWorkflowShipTargetBindingTx` 持有),五条到达路径(W1 legacy `setReviewBinding` StateStore.ts:6285 / W2 land_v1 transition :28300 / W3 v2 gate 创建 :30237 / W4 rebind :32590 / W5 `ensureWorkflowGateHolder` :32080——生产零调用方)。

关键 git 考古:
- **`f812aafb`(FLY-1434, 07-23)建表建机制,但 `workflowRunRequiresShipTarget` 只认 v1 land_v1**;
- **`f02ecbc8`(FLY-1638, 08-05 16:34 MDT)才把 v2 打通**:①`workflowRunRequiresShipTarget` 加 `resolveWorkflowGateAuthority(snapshot).mode === "runner_ship"`;② `createWorkflowGateHolderTx` 加 `if (carrierBindingState === "bound") bindWorkflowShipTargetForGateTx(...)`(StateStore.ts:30236);③ rebind 补写 binding。
- 在 `4857d999`(#783,#779 的前两个 commit)上直接读源码确认:旧 `createWorkflowGateHolderTx` **写 `review_question_id` + 置 `bound`,但没有任何 binding 写入调用**——产出的账面形状与 1648 现场**逐字段吻合**(qid ✅ / bound ✅ / binding 零行 ❌)。
- 当前 HEAD 下这三步在**同一事务相邻两行**(:30150 与 :30236),"qid 有、binding 无"在新码下不可能发生。

### 1.3 部署对账(生产仓 `~/Dev/flywheel` reflog,时区 MDT)

| 时刻 | 事件 |
|---|---|
| 08-05 全天 | 生产 HEAD 在 `6fbc4292`→`4857d999` 一带(均 **pre-#779**) |
| 08-05 21:53 → 08-06 全天 | 被反复 `reset`/`checkout` **钉在 `4857d999`**(07:16、09:44 两次 reset 回去;r4 mailbox 迁移窗的稳定性操作) |
| **08-07 01:16:47** | `merge origin/main: Fast-forward` → `cecdb06e`(**首次含 #779**) |

FLY-1648 的 run 08-06 13:28 MDT 启动、gate 08-06 20:32 MDT 物化、run 08-06 22:39 MDT 被判终——**整个生命周期都在 pre-#779 的二进制上**。修复(#779)已在 main 上躺了 28 小时,但生产没部署;部署后新码只在 `createWorkflowGateHolderTx`(新 gate 诞生时)写 binding,**对已存在的 divergent gate 零对账、零回填**。

### 1.4 对照组(1572/1596/1638)为什么有行

三行是表中**最后插入的三行**(rowid 32/33/34,序 1596→1638→1572),插入顺序既不等于 gate 创建顺序(1638→1596→1572)也不等于批准/merge 顺序——是**事后按某种枚举序补写**的,且在 08-07 04:46 UTC(issue 建单、部署前)已存在 ⇒ 由旧二进制的某条路径写入。旧二进制唯一可达的生产写入器是 W1(`setReviewBinding`,StateStore.ts:5807@4857d999)。FLY-1572 当天 verify-approval 成功过(`runner_ship_approved` 22:40 UTC → merge → `run_completed`),说明该路径当时对它真跑通了。

**待验-1(不影响设计结论)**:触发这三次 W1 写入的精确事件(候选:runner 撞墙后按提示 re-request review 携带 `--question-id` 的事件;1648 的 carrier 在 03:05:53 也发过第二个 approve_to_ship question `63dd2596`,但其 session.review_question_id 未被覆写 ⇒ 那次事件没走到 setReviewBinding)。复核手段:08-05 Bridge stdout 中 `[event-route] review ship target unavailable` 告警行、三个 runner 的 transcript。

### 1.5 读写不对称(实例 A 的放大器)

| 消费者 | 授权来源 | 缺行时 |
|---|---|---|
| `/head-authority`(runner 自 ship,verify-approval 依赖) | **仅** `workflow_ship_target_binding`(workflow-decision-routes.ts:316-322,检查还在 holder/session 一致性**之前**) | 409 `ship_target_binding_unavailable`,不带成因 |
| 引擎内部 `resolveRunnerShipAuthority`(StateStore.ts:32727-32734) | binding **或** `workflow_node_pr_binding` **或** session PR,三级回落 | 照样 `resolved(source:"node_binding")` |

`workflow_node_pr_binding` 与 ship_target 字段几乎同构(路径/identity/slug/head/generation),**信息完全冗余,缺的只是一次搬运**——引擎侧早就实现了"缺行回落到冗余源"的正确形状,runner 侧没有。这是"读时补齐"方案的现成范式与数据基础。

附带发现(独立缺陷):`recordWorkflowShipTargetBindingTx` 的幂等比对 `matches()` 不含 `superseded_at`(:25046-25053)——一条已作废的行会让重绑变静默 no-op(F9 形状)。

---

## 2. 实例 B 根因裁定:relay 是"没有 founder-gate 语义的 founder-gate 写原语" + 三道墙锁死恢复

### 2.1 修正 issue 的两处前提(都让 bug 更严重)

1. **cardMessageId 强等检查(write-gate-response.ts:429-441,非 449)只对 `source === "reaction"` 生效**。Annie 在 thread 里发的 `SHIP-VERDICT: yes` 根本没走到任何识别器——**门在此之前已被 relay 从候选集移除**:`getPendingQuestions`(flywheel-comm db.ts:2063-2078)要求 `NOT EXISTS(response child)` **且** `relay_state != 'terminal_disposed'`,relay 一次写掉两个条件 → 文本批准通道(founder-reply-deliverer.ts:369-374 → :607-609)取到空集,`tryFounderShipApproval` 从未被调用。
2. **`SHIP-VERDICT:` 识别器在代码里不存在**(全仓 grep 仅命中文档/prompt)。即使门还在,带冒号的消息也会被 Tier-2 结构复杂度拒绝(tier2-allowlist.ts:134)转 Tier-3 Haiku。ship-report HTML 引导 founder 用一种系统不认识的格式回批。

### 2.2 护栏不对称是同一个 commit 的遗漏,不是漂移

`d817eff2`(FLY-1392, PR #661)同一 diff 里:`routeFounderReply`(db.ts:2536-2543)与 `respondAndReceipt`(db.ts:2875-2877)都加了 `approve_to_ship` 硬拒;`handleReceipt` 的 relay 分支 SELECT **刻意不取 `checkpoint`**(db.ts:2746),无 `hasApprovalIntent` 检查、无 Bridge 路由、绕过整个 13 步 guard ladder。Lead 用它转交 Annie 原话 → 写入 `from_agent=<lead-id>` 的 response child(db.ts:2770)+ `terminal_disposed`(db.ts:2782)。

### 2.3 三道独立的墙(恢复为什么不可能)

- **墙 1**:response child + terminal_disposed 把门移出 founder 候选集(见 2.1)。手改 `relay_state` 回 `open` 救不了——response child 才是更硬的锁。
- **墙 2**:`conflicting_prior_response`(write-gate-response.ts:399-412)——prior(Lead 转交的散文,isApproval=false)与 founder 的 `{"approved":true}`(isApproval=true)方向不一致 → 拒。
- **墙 3**:`response-guard` `actor_mismatch`(response-guard.ts:79-82)——prior.from_agent 是 Lead 不是 canonical founder → 拒。
- `messages` 表 `idx_unique_response`(每 question 至多一个 response)使占位**永久**。取证实锤:备份库中 response child `c1d9dedd` 的 content 就是 Annie 的批准原文(`SHIP-VERDICT: yes ...`),from_agent=`flywheel-eng-lead` —— **founder 的批准逐字进了库,却记在 Lead 名下,从此这道门对 founder 关闭**。

### 2.4 静默性:零日志、零审计、零 founder 可见反馈(已证)

被 relay 消费后的门:文本通道拿空集不留痕;decision-convergence 看门狗被双重解除(convergence 行只为 shipGates 建、terminal_disposed 行被静默 close,plugin.ts:7100-7106);reaction 通道 `card_authority_engine_card_mismatch` 的拒绝结果被调用方丢弃(founder-reaction-approval-handler.ts:208-209),该错误码零测试覆盖。

### 2.5 手改库毁账的机制(墙外的第四层)

`archiveFamily`(mailbox-queue.ts:1112-1265)是**删除式**归档:family 全 ACKED/DEAD + 存在 response child(或 terminal_disposed)+ 超 72h retention ⇒ `DELETE FROM mailbox`。它挂在**每一次可写 CommDB open** 上(db.ts:737 `archiveOnOpen` 默认 true;teamlead 侧数十处 open)。Lead 手改 `terminal_disposed→open` 后,唯一豁免条款(:1142-1148)因 response child 仍在而不成立 → 下一次任意进程 open 库,整个 family(含 Annie 批准原文)被物理删除。当前生产 mailbox 中 `workflow-gate:*` 行已全部消失,原文仅存于事故夜备份。

### 2.6 真机补充:source session 正常结束也会消费 engine-owned gate

2026-08-09 slot 4 原生 `generic` DAG(`execute → founder_gate → land`)给出一个新状态签名,但根因仍是同一个不变量冲突:

- run `96d469bf` 在 `04:48:34Z` 正常完成 `execute`,保持 `active@founder_gate`;holder 已 `bound/awaiting_review/completed`,卡片 `1536234793707118692`。
- source session `a98b4703` 同刻进入 `completed`;FLY-1448 的 `TerminalReceiptSettlementProjector` 在 `04:48:54Z` 无条件对该 session 的每个 `approve_to_ship` 调 `supersedeShipGateAndReceiptFamily(...superseded_session_terminal)`。CommDB question 因此变 `terminal_disposed`,reaction poll 从此取不到。
- Discord 只读回查确认卡片上的 ✅ 唯一 reactor 是 owner id `1138241636057481306`(`Annie`),不是测试代理;批准后 12 分钟 run/PR 仍不动。
- 该 disposer 来自 `37bcb8e2`(FLY-1448/1466,PR #696),本分支未改该文件。FLY-1655 把 ship 职责移到 engine terminal node 后,source executable 正常结束而 holder 继续存活成为必然路径,暴露了旧逻辑“session terminal ⇒ gate obsolete”的错误假设。

正确不变量已有单一权威实现:`workflowGatePresentationDisposition(...) === holder_authoritative`。terminal receipt settlement 只能保留这一个 question 及其 receipt family;同 execution 的 stale/legacy gate仍按原逻辑 dispose。判据不含 `qa`、`execute`、`founder_gate`、`land` 等节点名,不加新表、timer或恢复状态机。

---

## 3. 实例 C + FLY-1607/1638 并入部分:收尾 500 无出口 × 补位判活不判交付

### 3.1 `incoherent_ship_bundle` 精确成因(修正 issue 归属:**FLY-1441 引入,不是 1607/1638**)

唯一抛出函数 `resolveWorkflowGateAuthority`(workflow-run-snapshot.ts:142-182),由 `ea32cf6d`(FLY-1441, PR #690, 07-23)引入,三个 throw:
- **形态 A**(击中 FLY-1590/1591/1597/1606/1623/1625 六单的那个):`ship_claims` 只含 `founder_approved` ⇒ subjectKind=snapshot_digest,而 carrier 要 git_head ⇒ 抛。引爆者是 `2ed08e54`(PR #748)把 `generic` 提成 carrier 却没论证 ship_claims。**FLY-1638(`f02ecbc8`)已删除此 throw**。
- **形态 B(仍在)**:≥2 个 ship-capable 节点(:163)。`isAuxiliaryGeneric` 降级的前置是"至少一个 generic 带 `produces_output:true`",而 menu 编译路径从不设置该字段 ⇒ 任何"双 generic 节点"的 menu shape 仍必爆;且降级只在 build 时生效,**已冻结的旧快照不回溯**。
- **形态 C(仍在)**:单 carrier 但能力位不齐(六条全查,`completion_route!=="needs_review"` 最易踩,:175)。

FLY-1607 在代码里零命中——它只是同族症状的另一个单号。

### 3.2 execute 收尾 500 的"无出口"结构(逐项已证)

- `commitEnrolledCompletion` 内 4 个触点只有 gate transition 一处有 try/catch(StateStore.ts:27701-27708,FLY-1638 加,降级为 409);主路径 :24911 / 幂等重放 :26641 / teardown :26873 **裸调用**,throw 逃逸到 Express 兜底(plugin.ts:3853-3866)→ HTTP 500,**事务整体回滚零痕迹**:无 receipt、node 留 running、run 留 active、无事件、无告警。
- Runner CLI 重试 4 次(complete.ts:59-61)耗尽 → fail-close marker + exit 1;**marker 重放通道对 500 判 `transient_failed`,无限期每次 boot/heartbeat 重试,零上限零升级**(complete-marker-reconciler.ts:735-739, :1072)。
- `workflow_run` / `workflow_run_node` 的状态域里**没有 needs_lead 这个态**——收尾失败没有任何可转入的"需要人"终态。
- 对照:同仓库 rework delivery 有完整的正确形状(5 次退避 → `needs_lead` → 告警,StateStore.ts:21282-21289 / :21384-21435)。execute completion 没有等价物。
- **FLY-1648(PR #788)的 digest-attempt ledger(5 次 dead-end)真实存在但只接线在 `completeWorkflowGateRunAfterShip`(merge 后 gate 收尾)一个表面**(唯一调用点 workflow-engine-dispatcher.ts:765),与 runner 提交 node completion 的 `/events` 表面不相交——照上次事故签名点修的又一实例。

### 3.3 补位重派:判"活"不判"交付"

`reconcileDeadExecutions`(workflow-engine-dispatcher.ts:1592-1782,每秒一轮 + 每次 boot 即刻一轮):活工单 = `status='active'` 一条;无活执行体 = node running + session 终态/teardown + 无 receipt + 探针 dead。**全函数零 PR 查询、零 merge 探针、零 Linear 读取**。唯一"已交付"代理是 `session.status === 'completed'` → hold(FLY-1638 加的 fence,StateStore.ts:24292-24404)——但 marker quarantine 路径会把 session 打成 `failed`,fence 判的是状态字面量,照样盲换。盲换 durable cap = 3 次(`MAX_BLIND_REPLACEMENTS`,side-effect ledger 计数),第 2 次起发 `repeated_dead_execution_pattern` 事件——**只记账不刹车**(1650 实测:事件发了,1 秒后照样 admit 新执行体)。

- FLY-1650 时间线(真库):execute admitted 08-06 19:55 UTC → (PR #787 已 merge、Linear Done,但收尾 500 使 run 永远 active)→ 08-07 04:10:39 关 runner → **同秒** dead_rolled_back + 重派;04:33:10 再关 → `repeated_dead_execution_pattern`(deathNumber=2)→ **1 秒后又 admit** → 04:33:13 操作员 `POST /api/runs/:id/terminate` 才止血。
- `terminate` 是纯手动出口(全仓零自动调用),只翻 `workflow_run.status` 一个字段;其 quiescence 闸门自 FLY-1434 起被永久中和(StateStore.ts:22800-22812)。
- **FLY-1638 三件套(no_code 终态 / dead-exec fence / completed-without-receipt hold)已全部 merge**,CLAUDE.md:157 的"⏳ pending"条目过期。1650 事故发生在 #779 合入 main 之后——但生产当时仍钉在 `4857d999`(见 1.3),**1650 的收尾 500 同样撞在未部署的旧二进制上**(旧码 gate transition 无 try/catch)。

### 3.4 1648 gate 的 `runner_ship_merged_before_approval`

1648 run event 47-50:引擎观察到 PR #788 已 merge(head 与 holder 逐字一致)但 holder 仍 awaiting_review ⇒ 记 `runner_ship_merge_deadend(kind:"rogue_before_approval")` + 告警。这不是"rogue merge"——是实例 A(binding 缺行拒掉正门)+ 实例 B(founder 批准进不来)把人逼到手动 merge 后,引擎按账面(无批准记录)如实判定。账面与现实脱钩的完整闭环。

---

## 4. 对齐杠杆现状:快照条件 × 覆盖矩阵(摘要)

> 完整矩阵见取证附录(R1-R17)。修正 issue 前提:三条杠杆非 FLY-1625 所建——`/re-qa` 是 FLY-1244(PR #593),`/gate-carrier-rebind` + `/loop-reentry` 是 FLY-1441(PR #690,事故夜 founder 口头授权直合);FLY-1625 只是把它们写进了文档。另存在第四条杠杆 `POST /api/runs/:id/rework`(整段重跑,唯一能碰 bound 状态的路径,代价是丢弃全部 QA/gate 证据)。

- `rebindWorkflowGateCarrier`(StateStore.ts:32413;stage 侧 :32310)实际 ~18 项前置。其中 **B2 `carrier_binding_state='unbound'` / B3 `state='materializing'` / B4 `materialization_stage='question_intent'` 是纯状态快照**(FLY-1441 那夜事故的形状);B15 `session.status==='ship_parked'` 与创建路径接受的 `running|ship_parked` 是同一语义两套形状。同组条件在 stage 只读、apply 事务、SQL WHERE 里**写了三遍**且互有出入(B10 只在 stage)。
- **结构性死区(已证)**:`bound → unbound` 全代码库零写路径;`materialization_stage` 单调不减(:32157-32159)。⇒ gate 一旦物化推进,rebind 永久失效;当晚形状(R4:bound+awaiting_review+completed)**只有 rework(整段重跑)一条路**。R8(terminated run)/ R10(engine_owned=0)完全无覆盖。
- `/loop-reentry` 结构性不适用于 gate(L9 排除 `founder_feedback_kickback`,而模板里 gate 唯一出边就是它)。"三条杠杆"对 gate 修复实际只有一条。
- **诊断力塌缩**:rebind 的 ~18 项前置塌缩成一个 `rebind_proof_unavailable`(canonical 解析器一路 `return undefined` 无 reason 通道);`holder_unavailable` 一个桶装 10 条。唯一逐条报因的是 `/re-qa` stage(routes:235-271)——是"该抄的形状"。`gate_carrier_unbound` 告警只在创建时 unbound 的分支发;**bound-but-wrong 区域零告警**。
- 审计不对称:rebind/loop-reentry 有 receipt 表 + run event;`/re-qa` **零审计凭证**;而把 holder 推进 bound 的 setReviewBinding 旁路(StateStore.ts:6299-6313)不留 receipt、不写 run event、条件比受审计的 rebind 更宽。

---

## 5. 凭据("钥匙不过期")现状

- **两个凭据族**:submission(QA 判决,`workflow_submission_credential`,强制点 StateStore.ts:27055)与 output(产物,:24794)。issue 里的 23142/25252 行号已漂移且混指两族。
- **TTL 双路径**:v2 路径 `credentialWindowForNode`(workflow-submission-expiry.ts:28-54,qa=360min 由 FLY-1638 加,review 节点缺字段落回 60min);**legacy claims-admission 路径 `run-infra.ts:643-646` 硬编码 30min 软窗 + 2h 绝对死线,不调用 credentialWindowForNode**。FLY-1649 QA 跑 2h ⇒ 正好撞穿 legacy 绝对死线,且死线是重铸的硬地板(`workflowCredentialRotationExpiryTx` StateStore.ts:19236-19248)——**连重铸都救不了**。FLY-1638 的 360min 修在了 FLY-1649 没走的路上。
- **TTL 不是主力防线(放宽的安全依据)**:防错 head 靠 `head_authority_mismatch`、防重放靠 `consumed_at` 一次性消费、防陈旧 attempt 靠 `binding_not_current` + 新 attempt 主动 revoke——全部独立于 TTL。代码注释自认 TTL 只是"被收割凭据的爆炸半径时限"(StateStore.ts:19962-19964)。claim 层已有 `permanent=1` 语义先例(schema :15682-15693 / 判定 :30375)。
- **marker 死信箱(完全成立)**:`qa-result-failed` marker 只存 body_digest(FLY-1244 `e4e3a796` 把正文换成 sha256,当时为防 token 泄露),`credential_expired` 属确定性拒绝立即写 marker + exit 1;**全仓零读取方**。判决正文在过期路径上无任何落盘。
- **重铸/递增入口对活着的 QA 全关死**:pre-launch 重铸被 `launch_committed` 拒;delivery-repair 重铸要求 shell 已死;`/re-qa` 是**重新 spawn 新 QA 重跑全部验证**(2 小时白干)且只有 Lead/founder 能按。⇒ FLY-1625 候选④"同 session 复验的凭据重铸正规入口" = **纯未建**(本次取证确认)。
- 同一 commit `e4e3a796`(FLY-1244)一次引入了 credential_expired 强制、legacy 30min/2h 硬编码、marker 正文→digest 三件事——不是三个独立缺陷,是一次改动的三个面。
- `verify-approval` 与 qa 凭据是**完全独立的两族机制**(verify-approval 无 TTL,防陈旧靠 head 相等)——动 qa TTL 不影响 verify-approval,且它是"用 head binding 而非时间防陈旧"的现成范式。

---

## 6. FLY-1625 四候选现状裁定(research 侧事实;最终"落地/判死"由 plan 执行)

| # | 候选 | 现状(附证据) |
|---|---|---|
| ① | holder head 取自 carrier/PR binding 而非 QA cwd HEAD | **部分被 FLY-1638 覆盖**:v2 gate holder 的 head 来自 gate evidence(claims 的 subject_digest)与 carrier prBinding 校验(StateStore.ts:30141-30148);但 qa-result 侧 head 权威已由 `resolveWorkflowHeadAuthority` 服务端裁决(workflow-decision-routes.ts:416-438)。**残留**:`/head-authority` 缺 binding 时的 409 不带成因(交付要求 6)。 |
| ② | carrier 绑定周期重试/状态变化时重试 | **纯未建**:W3 只在 holder 诞生瞬间试一次,失败分支只发 `gate_carrier_unbound` 告警,零重试调度(StateStore.ts:30259-30313);全仓无以缺行为条件的补写作业;升级部署零回填(1.3 实证)。 |
| ③ | 带审计的操作员对齐杠杆 | **已建但按快照成形**(issue 更正区已确认"建了";本次取证补充:前置含 3 条纯快照条件、bound→unbound 无写路径、stage 单调不减、错误信息塌缩、bound-but-wrong 零告警、覆盖矩阵存在完全无杠杆的死区 R8/R10)。 |
| ④ | 同 session 复验 attempt 递增/凭据重铸正规入口 | **纯未建**(§5 逐条排除:每条现有重铸/递增路径要么要求 runner 已死、要么整单重跑)。 |

## 7. 待验清单(不阻塞设计,由 implement 节点收口)

1. **待验-1**(§1.4):旧二进制写 rowid 32-34 三行的精确触发事件。
2. **待验-2**:1650 的 execute 收尾 500 是否为 `incoherent_ship_bundle` 形态 A(生产旧码)——按 §3.1 的 O(1) 判据查其 snapshot 能力位即可闭环。
3. **待验-3**:08-05~08-07 生产 Bridge 进程的实际重启时刻(reflog 是源码状态,tsx 在进程启动时读源码;需与 bridge 日志对账)。
