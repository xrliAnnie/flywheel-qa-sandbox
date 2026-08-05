# FLY-1638 self-ship 自动化收尾 — 实施计划

Issue: FLY-1638 (https://linear.app/geoforge3d/issue/FLY-1638/self-ship-自动化收尾1625-修复合一单-ship-绑定修复-重试封顶-防空转-qa-ttl-预配-重启前暂停接活)
日期: 2026-08-04
基于: research.md

## 0. 总原则

- **机制数不升**:修复面 2/3/5 是给既有机制加谓词/收窄死亡定义;唯一新增小机制是修复面 6 的 admission pause(issue 明示的 DR 四步模型缺口,几十行);修复面 5③ 反而**删除**一类错误重派行为。
- **不动 `workflow_v2` DAG 引擎本体**;不动 founder-gated merge 权限模型(verify-approval 的安全检查逐字保留,只修它读不到数据的断链)。
- **两个前提修正**(research §4):子缺陷 ① 的真 throw 点在 `workflow-run-snapshot.ts:176-177`(非 workflow-menu.ts);子缺陷 ③ 的真缺陷是死亡谓词误判「诚实完成但 receipt 丢失」,不是缺 run-status 检查。计划按真机制设计。
- TDD:每个修复面先写失败测试(含 research 点名的两个零覆盖 seam:真过期凭证 → 409;schema-v2 gate 物化 → /head-authority)。

## 1. 修复面 1:RC-B ship 绑定(schema-v2 写 binding 行)

**选型:方案 (a) 写入侧补齐** —— schema-v2 gate 物化时写 `workflow_ship_target_binding` 行,复用 land_v1 的冻结/supersede 语义,保持 `/head-authority` 单一读路径。
**否决方案 (b)**(land_v1 分支识别 schema-v2 凭证链):读路径要长出第二套 authority 模型,且丢掉 frozen_head_sha 的 gate-open 冻结语义;双建模正是本 bug 的病根,不再加一层。

改动(全在 `packages/teamlead/src/StateStore.ts`,同事务):

1. **放宽谓词** `workflowRunRequiresShipTarget`(`:23343-23355`):schema_version===2 且 `resolveWorkflowGateAuthority(snapshot).mode === "runner_ship"` 也返回 true;`engine_terminal` 保持 false(无 repo 可绑)。resolver 可能 throw(旧 incoherent 快照)→ 沿用现有 catch→false 形状,谓词永不抛。
2. **gate 物化时写 binding**:`createWorkflowGateHolderTx`(`:28136-28305`)在 `carrierBindingState === "bound"` 确立后调 `bindWorkflowShipTargetForGateTx({runId, questionId, headSha: proof.subjectDigest})`,镜像 land_v1 的 `:26361`;`unbound`/`engine_terminal` 不调不抛(unbound 已有 `gate_carrier_unbound` 升级,不重复报)。
3. **手动逃生口同步**:`rebindWorkflowGateCarrier`(`:30583-30603`)补同一写入 —— 今天连手工 rebind 都救不回 verify-approval。

测试(research §2.4 缺口):新增集成测试 —— schema-v2 run 走完真实 gate 物化,拿真 `workflow-gate:*` question id 调 `POST /api/workflow/head-authority`,断言 ok + frozen head 一致;补 rebind 路径同断言。

## 2. 修复面 2:rework 重试封顶(≤5 → needs_lead,告警走 Lead ticket lane)

照抄 `workflow_alert_outbox` 的 `attempt < N` 封顶形(research §3.1):

1. **新终态** `needs_lead`:`workflow_rework_delivery.state` CHECK 迁移(table-rebuild 模板 `StateStore.ts:15009-15090`)。真终态 —— 同步更新六处:`advanceWorkflowReworkDelivery` allowed 表(`:20115-20126`)、`claimWorkflowReworkDelivery` claimable 集(`:19983-19992`)、`listWorkflowReworkDeliveries` 默认(`:19527-19531`)、dispatcher 扫描态(`workflow-engine-dispatcher.ts:706-708`,**排除** needs_lead)、`WorkflowReworkDeliveryRow["state"]`(`:33810`)、`openOperatorRework` 的 open-delivery 守卫(`:21815-21825`,needs_lead **不算** open —— Lead 想重试时开新 operator rework 即天然复活路径,零新机制)。
2. **计数**:`workflow_rework_delivery` 加 `hold_count INTEGER NOT NULL DEFAULT 0`(同一次 rebuild 迁移带上)。`releaseWorkflowReworkDelivery` 增加 `hold: boolean` 入参,hold 型 release 时 `hold_count+1` 并返回新值。不复用 `generation`(它连成功路径的 claim 也计数,语义脏)。
3. **封顶转移**:coordinator `releaseAndHold`(`workflow-rework-coordinator.ts:210-233`)改为:release(hold=true)→ 若 `hold_count >= 5` → 新 store 方法 `markWorkflowReworkNeedsLead(requestId, reason)`:同事务里 `state → needs_lead` + `enqueueWorkflowEngineAlertTx(eventType: "workflow_engine_escalation", …)`(镜像 stall 升级 `:18081-18114`)。
4. **止血刷屏**:删除 `releaseAndHold` 里每迭代的 `effects.alertHold` 调用 —— 告警只在封顶转 needs_lead 时发**一次**,且 `workflow_engine_escalation` 不在 `ISSUE_PROGRESS_KINDS` → 走 ticket lane → Lead alert channel,不进 founder thread(research §3.2)。`alertHold` effect 及其 `three_stage_stuck` 发射点整体移除(dead code 列给 review)。

测试:hold 5 次 → 第 5 次后 state=needs_lead、outbox 恰 1 条 escalation、dispatcher 下一 tick 不再 claim;needs_lead 后 `openOperatorRework` 可开新单。

## 3. 修复面 3:防空转谓词(幽灵 rework 不铸)

插入点 = mint 单一闸门 `StateStore.ts:26074`(research §3.4),事务内纯读,覆盖全部四种 mint 味道:

1. **谓词**:`input.subjectDigest`(当前 head,40-hex 已验)=== `activeRequest?.base_revision`(上一轮 rework 的基线)**且** 存在未撤销 `qa_passed` claim(`workflow_claims` predicate='qa_passed'、`subject_digest = 当前 head`、LEFT JOIN `workflow_claim_revocation` 为空;raw 形照 `:29060-29070`)→ **不铸**。不用 `resolveWorkflowDecisionClaim`(其「superseded PASS 不算证据」+ `requiredAttempt` 契约是为 transition authority 设计的;这里问的是更窄的「这个 head 是否已被证明通过」,内容寻址的 head 上任何未撤销 PASS 都成立)。
2. **命中后的走向**(research §3.4 设计决定点):**不能** `{ok:false}`(会变 `transition_refused` 丢 verdict)。transition 照常完成源节点 + 边遍历,仅跳过 rework 四表 INSERT 与 target 节点预约;发 `rework_suppressed_idle_spin` run event(复用既有 event 表,非新机制)。若跳过 rework 后该 transition 无合法延续(边目标即 rework 目标),run → `held` + 复用修复面 2 的单发 ticket-lane 升级。
3. `openOperatorRework` 同谓词(可选对称,新拒绝 reason `rework_idle_spin`)—— founder 手动开单一般是有意为之,谓词只在完全同 head 同 PASS 时拒,附 override 提示走 force 语义?**不加 force 旋钮**(机制数不升):operator 路径命中即拒 + 明确 reason,founder 真要重跑可先 revoke claim(既有能力)。

测试:同 head + 未撤销 PASS → 不铸 + 事件落账;head 变了 → 照铸;PASS 已撤销 → 照铸;operator 路径拒绝 reason 断言。

## 4. 修复面 4:QA 节点 TTL 预配(qa 默认 6h)

1. **registry 默认**:`packages/config/src/node-type-registry.ts` `NodeTypeRegistryEntry` 加平级字段 `submissionWindowMinutes?: number`(**不进 capabilities** —— capabilities 会被序列化进快照比较);`qa` entry(`:92-103`)设 `360`。其余类型不设 → 落 60 兜底。
2. **解析序**:`credentialExpiryForNode`(`workflow-engine-dispatcher.ts:105-122`)改为 `manifest node.submissionWindowMinutes ?? registry[type].submissionWindowMinutes ?? 60`。registry 默认在 dispatch 时现读、**不进 digest** → 新默认只影响新发凭证,已 pin run 不动(research §1.4 的「预配」语义;`workflow-run-snapshot.test.ts:63-79` digest 断言必须保持不动,作为回归哨兵)。
3. **堵三个旁路发行点**(research §1.1):抽共享 helper(`credentialWindowForNode(snapshot, nodeId, now) → {expiresAt, absoluteDeadlineAt}`,复用 `computeSubmissionExpiry`),`runs-route.ts:2568-2578`、`workflow-rework-coordinator.ts:380-397`、`actions.ts:989-997` 全部改走 helper —— 否则 qa 节点经 rework/retry 进来仍撞 1h/15m 旧窗。absolute deadline 保持 24h 上限。
4. seed 层不动(heavy tier 的 180m 显式声明继续生效——manifest 值优先于 registry 默认,自然覆盖)。

测试(research §1.5 缺口):**真过期凭证** → `submitWorkflowDecisionByCredential` / `POST /api/workflow/decision` → 409 `credential_expired`(`StateStore.ts:25252` 首次被踩);qa 节点新凭证 `expires_at - issued_at = 6h`;非 qa 节点仍 60m;manifest 显式值仍优先;digest 哨兵不动;三旁路发行点各一条窗口断言。

## 5. 修复面 5:僵尸重派根除(四个子缺陷)

### 5① seed/registry 矛盾 → resolver 级修复

**选型:修 `resolveWorkflowGateAuthority` 的 subjectKind 推导** —— `runner_ship` 模式(carrier 存在)**无条件** `subjectKind = "git_head"`,与 `land` 模式(`:149-151` 无条件 git_head)对称;`engine_terminal` 保持 claims 推导。`:176-177` 的 throw 随之消失(`:162` ≥2 carrier、`:174` 能力包不完整两个 throw 保留 —— 那两类仍是真不一致)。
**否决:改 seed 的 ship_claims**(给 generic 加 qa_passed/design_review_approved):(i) 治不了**已 pin 的 6 个僵尸快照**(snapshot 内容已冻结,resolver 修复对旧快照即时生效);(ii) 语义谎报 —— generic 无 QA 节点,声明 qa_passed 永远无法满足;(iii) `tpl_generic` 与 `tpl_generic_menu` 两个 template id 要分别改,漏一个照样坏。
**理由**:carrier 的存在本身就蕴含 ship 主体是 git head —— PR 由 carrier 产出;claims 列表回答「ship 需要哪些证据」,不该反向决定主体类型。

### 5② seed 合成断言

- **主守卫(进 CI 的测试)**:table-driven 测试 —— 两个 seed 家族(12 个 file seeds + 全部 menu shapes 经 `compileWorkflowMenuSeed`,用 **live node-type registry** 合成快照)逐个 `expect(() => resolveWorkflowGateAuthority(snap)).not.toThrow()`。落点 `workflow-menu.test.ts` / `workflow-template.test.ts`(已有 round-trip 骨架)。
- **次守卫**:`scripts/verify-workflow-seeds.mjs` 补同断言,并接入 `package.json` scripts + `.github/workflows/ci.yml`(它 docblock 声称守 boot 路径却没接 CI,research §4.2)。

### 5③ 死亡谓词收窄 + 计数持久化

1. **`"completed"` 移出 `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`**(`StateStore.ts:312-320`)。session.status='completed' 意味 runner 跑完并上报过 —— node 无 receipt 是**引擎侧记账断裂**(如 complete→500),不是死 runner;respawn 永远是错的(活已干完)。
2. **新 reconcile 分支**:sweep(`workflow-engine-dispatcher.ts:1362-1373`)遇 `session completed ∧ node running ∧ 无 receipt` → 不 respawn,run → `held` + 单发 `workflow_engine_escalation`(reason `completion_receipt_missing`)。fail-loud 代替昂贵重做;修复面 5① 落地后此形不再批量出现,该分支是兜底。
3. **replacement 计数持久化**:`MAX_BLIND_REPLACEMENTS=3` 现按 Bridge 生命周期计数、重启清零(research §4.3)。改为从持久账本推导 —— count `workflow_run_event` 中该 (run,node,attempt) 的 `execution_dead_rolled_back` 行数(零新列、零新表,账本本就 durable)。耗尽 → 既有 held+alert 路径不变。

### 5④ generic 节点合法非 needs_review 出口

1. **route 集合化(最小面)**:generic registry entry 的 `completion_route: "needs_review"` 扩为**合法终态集** `["needs_review", "no_code"]`(仅 generic;其余类型保持单值语义,类型层面用 `completion_route: string | string[]` 或新增 `additional_completion_routes`,实施时取改动面最小者)。StateStore 路由校验(`:24757-24759`)由「等值」改「集合成员」。
2. **no_code 的 run 级收尾**:generic carrier 以 `no_code` 完成(取消/无产出)→ **run 直接 terminal completed,不进 ship gate** —— founder gate 的存在意义是授权 ship;无产物则无可授权。发 run event `completed_no_artifact` 落账,Linear/issue thread 照常收尾级联。`needs_review` 完成(有 PR)→ 照走 gate → 修复面 1+5① 打通的 runner_ship ship 链。
3. **诊断步**:实施时读一个 pre-#748 generic run 的 event ledger,确认 engine_terminal 停滞点(research §4.4:pre-#748 completed 也是 0),把发现记进 implementation notes —— 若 engine_terminal gate 流对 generic 另有独立断裂,如实报 Lead 拆 follow-up,不在本单静默扩科。

测试:no_code 完成 → run completed、无 gate holder、无 500;needs_review + PR → gate → binding 行存在(接修复面 1 测试);取消单闭环(1623 形);`tpl_generic_menu` 合成快照过 5② 断言。

## 6. 修复面 6:admission pause(重启前暂停接活)

镜像 `fleet_pressure_hold`(research §5.2),TTL 化:

1. **持久单行**:新表 `admission_pause(id=1 CHECK, paused_until TEXT, set_by TEXT, reason TEXT)`。不复用 `fleet_pressure_hold`(单槽 probe 已被 swap sensor 占用;语义混用会让解除逻辑互踩)。**无 timer**:probe 现读 `paused_until` 与 now 比较,过期即自动失效 —— durable(重启保刹车)+ 自解除。
2. **执行点(双位)**:
   - `RunnerAdmissionController.tryAdmit()`(`runner-admission.ts:228-241` 旁)加 sibling probe → typed reason `"admission_paused"` → `runs-route.ts:1352` 现成 429 形 + `Retry-After` 头(剩余秒数)。覆盖 `start()` 全部六 lane。
   - `RunDispatcher.dispatch()`(`run-dispatcher.ts:578-582`)补同一 pause 检查(typed `AdmissionDeferredError`)—— 堵 retry/dead-exec 缺口(research §5.1;shutdown `accepting` flag 的 untyped-500 反面教材不重蹈)。
3. **端点**:`POST /api/admission/pause {durationSeconds}` / `POST /api/admission/resume`。**独立前缀**(不挂 `/api/runs`,gemini scoped token 够不着)+ Bearer master token + fail-closed 503 包装(`plugin.ts:2122-2134` 习语)。durationSeconds 边界校验(上限 1h,防误设永久)。
4. **restart-services.sh**:`deploy_and_verify()` 新 **Step 0**(`:1673` 附近,`notify_routine` 后、`stop_bridge` 前):`curl -K -`(token 不进 argv,`:242-244` 先例)POST pause(默认 600s),**best-effort 非致命**;post-health 验证通过后(`:1715-1732` 之后)显式 POST resume,失败不致命(TTL 兜底)。调用必须在 FLY-1634 self-detach 块**之后**的 child 流程内(`:609-620` 竞态约束);新 flag 进 `RESTART_ARGS` 透传。`rollback_and_restart`(`:1624`)同 Step 0。

测试:pause 生效 → `/api/runs/start` 429 `admission_paused` + Retry-After;retry lane(dispatch)同拒;TTL 过后自动放行;重启中途(新 Bridge boot)刹车仍在;resume 即时放行;无 token 配置 → 端点 503 不裸奔;`test-restart-services.sh` 补 Step 0 时序断言。

## 7. 验收锚映射(全部活体)

| 锚 | 修复面 | 验证方式 |
|---|---|---|
| 1631 approve 后 verify 撞 binding_unavailable → 零人工 | 1 (+5①) | 真机:schema-v2 DAG run QA PASS → founder approve → verify-approval ok → merge,全程零人工 |
| 1631/1596 held 刷屏 → 停在 5、告警只到 Lead | 2 | 注入 5 次 hold 失败 → needs_lead + Lead channel 恰 1 条、founder thread 0 条 |
| 1631 implement@3 幽灵 rework → 不铸 | 3 | 同 head + PASS 重放 → 无 rework 行 + suppressed 事件 |
| 1628 QA 凭证 1h 墙 → 6h 窗 | 4 | 新 qa 凭证 expires-issued=6h;3.7h 模拟不过期 |
| 1634 部署期间派发 → 明确稍后再试 | 6 | restart 窗口内 /api/runs/start → 429 typed + Retry-After |
| 6 个 generic 单零重派 | 5①③ | 重放 completed∧无receipt 形 → 不 respawn;Bridge 双重启 → launch_ordinal 不增 |
| tpl_generic_menu completed > 0 | 5④ | 真机 generic 单 no_code 收尾 → run completed |
| 取消单(1623 形)正常关闭 | 5④ | no_code 完成,无伪造 PR |
| 96 快照普查 6 例 incoherent_ship_bundle 归零 | 5① | 普查脚本重跑 → 0 |
| 真机 E2E:完整 DAG run QA PASS → 自 ship → 收尾级联 | 全部 | 一条真 issue 走全链 |

## 8. 实施切分与顺序

1. **PR 内提交序**(单 PR,提交按依赖序):5①(resolver)→ 5②(断言,锁住 5①)→ 1(binding)→ 5④(出口)→ 5③(谓词收窄+计数)→ 2(封顶)→ 3(防空转)→ 4(TTL)→ 6(pause)→ docs/milestone 尾提交。
2. 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `scripts/test-restart-services.sh`。
3. Codex code review(`codex:rescue`)循环至 APPROVED;真机 E2E 由独立 QA 节点承接(本设计节点不 ship)。

## 9. Honest boundary

- 消息层展示形态(通知折叠、held 告警措辞)→ FLY-1569 D/E。
- pre-#748 generic run 的 engine_terminal gate 历史停滞若属独立断裂 → 诊断后如实上报拆单,不在本单静默修。
- `held` 既有语义、`MAX_BLIND_REPLACEMENTS` 数值、founder-only merge 契约、`verify-approval` 安全检查:全部不动。
- 96 快照普查中非本六单的其他 incoherent 形(若有 `:162`/`:174` 类)不在本单——那两个 throw 是真不一致,保留 fail-closed。
