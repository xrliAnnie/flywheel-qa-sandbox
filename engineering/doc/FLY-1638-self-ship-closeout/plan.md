# FLY-1638 self-ship 自动化收尾 — 实施计划

Issue: FLY-1638 (https://linear.app/geoforge3d/issue/FLY-1638/self-ship-自动化收尾1625-修复合一单-ship-绑定修复-重试封顶-防空转-qa-ttl-预配-重启前暂停接活)
日期: 2026-08-04
基于: research.md
状态: **Codex design review 6 轮 APPROVED**(R1 11 项 / R2 6 项 / R3 2 项 / R4 2 项 / R5 1 项全折入;R6 APPROVED)

> **R6 非阻塞实施守则**(不改结论,实施节点必读):
> 1. 仓库枚举失败**不得**丢弃既有 lifecycle worktree binding —— `Blueprint` 现对 `emitWorktreeReady()` 异常是 log+继续 launch;path/branch/generation 照常绑定,baseline 字段落 null(=不合格 no_code),核心 binding 落盘前不抛。
> 2. `repo_baseline_set_json`/`repo_baseline_set_digest` 加进既有 sessions worktree-binding 列组(legacy null);`grant_started_at` 显式进 `workflow_rework_delivery` rebuild/copy/双 boot fixture;baseline digest 用既有 canonical SHA-256 helper **重算比对**,不把存储的 JSON 与 digest 当两个独立可信输入。

## 0. 总原则

- **机制数不升**:修复面 2/3/5 是给既有机制加谓词/收窄判定;唯一新增小机制是修复面 6 的 admission pause(issue 明示的 DR 四步模型缺口);修复面 5③ 反而**删除**一类错误重派行为。
- **不动 `workflow_v2` DAG 引擎本体**;不动 founder-gated merge 权限模型(verify-approval 安全检查逐字保留,只修它读不到数据的断链)。
- **三个前提修正**(research §4 + Codex R1#4):
  1. 子缺陷 ① 真 throw 点在 `workflow-run-snapshot.ts:176-177`(非 workflow-menu.ts);
  2. 子缺陷 ③ 真缺陷是死亡判定把「诚实完成但 receipt 丢失」当死 runner,不是缺 run-status 检查;
  3. replacement 计数**本已持久**(从 `workflow_side_effect_ledger` durable 行派生,`rollbackDeadWorkflowNodeExecution` 独立 count 后执行 `MAX_BLIND_REPLACEMENTS+1`)—— 不随 Bridge 重启清零;8-05 两次 boot 各重派一轮是因为 cap=3 未耗尽(FLY-1606 耗尽即 held)。**不引入第二计数器**,只加两次重启回归测试锁行为。
- TDD:每个 seam 先落失败测试(含 research 点名的零覆盖 seam:真过期凭证 → 409;schema-v2 gate 物化 → /head-authority;以及 R1 新增的 gate-proof / 迁移 / crash 边界组)。

## 1. 修复面 1 + 5①:runner_ship 的 gate 主体与 ship 绑定(合并设计)

两者是同一条 authority 链的两半,合并陈述。

**选型:写入侧补齐 + resolver 对称化**。否决「land_v1 读分支识别 schema-v2 凭证链」:读路径长出第二套 authority 模型,双建模正是病根。

### 1.1 subjectKind 对称化(5①)

`resolveWorkflowGateAuthority`(`workflow-run-snapshot.ts:142-184`):`runner_ship` 模式(唯一 carrier 且能力包完整)**无条件** `subjectKind = "git_head"`,与 `land` 模式(`:149-151`)对称;`engine_terminal` 保持 claims 推导。`:177` 的 throw 随之消失;`:162`(≥2 carrier)与 `:174`(能力包不完整)保留 —— 那两类仍是真不一致。
**理由**:carrier 的存在本身蕴含 ship 主体是 git head(PR 由 carrier 产出);claims 列表回答「ship 需要哪些证据」,不反向决定主体类型。resolver 级修复对**已 pin 的 6 个僵尸快照即时生效**(快照内容不变),并同时治好 `tpl_generic` 与 `tpl_generic_menu` 两个 template id。
**否决:改 seed ship_claims**:治不了已 pin 快照;generic 无 QA 节点,声明 `qa_passed` 永远无法满足;两个 template id 要分别改。

### 1.2 runner_ship 的 gate-proof 规则(R1#1 + R2#1)

`resolveWorkflowGateEvidenceTx` 目前从 claims 推 proof 主体 —— generic 只有 `founder_approved` → 会与 1.1 的 git_head 冲突,gate 物化改抛 `workflow_gate_subject_contract_conflict`(等于换个名字继续 500)。**补 runner_ship 专属 proof 规则**,且规则本身**永不 throw**(R2#1:proof 规则若在 §1.3 建 unbound holder 之前就抛,unbound 路径根本走不到):

- **有匹配 PR binding**(当前 carrier attempt 的不可变 `workflow_node_pr_binding`,run/node/attempt 精确匹配,与 carrier session/activation 交叉核对一致)→ 冻结该 head 为 proof 主体;evidence claims 为空也允许(founder-only generic run 的合法形态)。
- **无匹配 PR binding** → 用 **server-authoritative 临时 head**(transition/worktree head)建 **unbound** holder;若连可信 head 都没有 → hold/escalate,**不建 question**。仅当后续不可变 PR row 匹配时才 freeze/bind。
- `engine_terminal` 的既有 proof 行为不动。审计全部 `resolveWorkflowGateAuthority` 消费点(`StateStore.ts:23261/28028/28145/30367/30532`、`gate-authority-view.ts:63`)确认无隐式依赖旧 subjectKind。

### 1.3 binding 写入(修复面 1,R1#2 + R2#1 事务序)

1. **放宽谓词** `workflowRunRequiresShipTarget`(`StateStore.ts:23343-23355`):schema-v2 且 authority mode 为 `runner_ship` 也返回 true;`engine_terminal` 保持 false。resolver 可能 throw(旧 incoherent 快照)→ 沿用现有 catch→false,谓词永不抛。
2. **immediate-carrier 事务序(R2#1 核心)**:heavy 拓扑里 carrier(implement)早在前一 transition 已 park,gate 由 QA 后续打开;而 **generic carrier 在自己的 completion 事务里直达 gate,session 此刻仍 `running`** —— 若 bound 谓词要求 `ship_parked`,合法 PR binding 也会被判 unbound,且后置 `projectGeneralizedCompletionTx` 还会把新升的 `awaiting_review` 覆盖回 `ship_parked`。**明确同事务内顺序**:记 PR binding → 把当前 carrier 投影到 pre-gate parked 态 → holder 绑定判定 → 升 `awaiting_review`;后置 projector 对已升级 session **不降级**(幂等哨兵)。
3. **bound 谓词收紧**:`carrierBindingState = "bound"` 判定**并入**「存在匹配的当前 PR binding(run/node/attempt/head/repo identity 全对齐)」。缺失/不匹配 → unbound + 既有 `gate_carrier_unbound` 单次升级,**绝不 throw**(否则 gate 创建 fail-closed = complete→500 同形)。
4. **写入 + supersede**:bound 确立后同事务调 `bindWorkflowShipTargetForGateTx({runId, questionId, headSha})`;写入前先调 `supersedeWorkflowShipTargetsForCurrentGateTx`(镜像 land_v1 —— 否则旧 question 的 binding 仍 live)。
5. **手动逃生口同步**:`rebindWorkflowGateCarrier`(`:30583-30603`)同前提、同 supersede、同写入。

### 1.4 测试

- **从真 `running` generic session 出发**(R2#1):合法 PR binding → bound + binding 行 + awaiting_review 不被降级;PR binding 缺失 → unbound + 临时 head + 单次升级,无 500;整事务回滚边界。
- founder-only generic manifest 走完真实 gate 物化:无 throw(两个错误名都不抛)。
- schema-v2 run 真 gate 物化 → 真 `workflow-gate:*` question id 调 `POST /api/workflow/head-authority` → ok + frozen head 一致(research §2.4 零覆盖 seam)。
- 替换 gate 的 supersede;rebind 路径同断言。
- resolver 消费点回归:land 与 engine_terminal 行为逐字不变。

## 2. 修复面 2:rework 重试封顶(≤5 → needs_lead,告警走 Lead ticket lane)

### 2.1 状态与迁移(R1#7 契约化)

- `workflow_rework_delivery` 新终态 `needs_lead` + 新列 `hold_count INTEGER NOT NULL DEFAULT 0`、`next_retry_at TEXT`(见 2.2 退避)。
- **迁移契约**(table-rebuild,模板 `StateStore.ts:15009-15090`):`sqlite_master` SQL 嗅探 + 列存在检测 → `workflow_rework_delivery_next` 携带**全部**现约束/外键 + 新 CHECK/新列 → 数据拷贝(`hold_count=0`)→ swap → 外键恢复 → **二次 boot 幂等**。测试:含全部旧 state 与被引用 route 的 fixture、`PRAGMA foreign_key_check`、store 重开两次、零行/零约束丢失。
- 同步更新:`advanceWorkflowReworkDelivery` allowed 表、`claimWorkflowReworkDelivery` claimable 集、`listWorkflowReworkDeliveries` 默认、dispatcher 扫描态(**排除** needs_lead)、row mapper 与 `WorkflowReworkDeliveryRow["state"]` union。

### 2.2 原子封顶(R1#6)

- **单事务 CAS**:新 store 方法(如 `settleWorkflowReworkFailure`)一次事务内:验 owner/generation/state → `hold_count+1` → 若 `< 5`:release + 写 `next_retry_at = now + backoff(hold_count)`(指数:1m/2m/4m/8m,总窗 ~15m —— 1s tick 下裸计数 5 次=5 秒即枯竭,必须退避才配叫「重试 5 次」);若 `>= 5`:state → `needs_lead` + 同事务 `enqueueWorkflowEngineAlertTx`(`workflow_engine_escalation`,携带既有 `WorkflowEngineAlertIdentity` 载荷)**恰一次**。coordinator 的 `releaseAndHold` / `releaseRetryable` 改为都走此方法 —— **retryable 类失败(missing context/actor、corrupt authority、admission、turn grant、projection failure)同样消耗预算**(否则那几类照样无限转,R1#6);claim/list 查询排除 `next_retry_at > now`。
- **止血刷屏**:删除每迭代 `effects.alertHold`;`three_stage_stuck` 发射点随之移除(dead code 清单给 review)。告警只在转 needs_lead 时发一次,走 ticket lane(`workflow_engine_escalation` 不在 `ISSUE_PROGRESS_KINDS` → Lead alert channel,不进 founder thread)。
- **Lead 复活路径:stage-aware 终局(R1#6 + R2#3 + R3#2 crash-safe 三态)**:`openOperatorRework` 现会被 reserved target 的 `target_attempt_already_reserved` 拒;且第 5 次失败发生的阶段不同,预约「从未成功投递」并不总成立。coordinator 实际序:admit(activation+credential)→ 解析 authority context → 外呼 `grantTurn` → 本地记 turn → 外呼 `wakeActor`。终局按**三个显式 disposition** 分派(R3#2:「admitted 但尚未 dispatch」是独立区间,`authority_context_corrupt` 即现例;`grantTurn`/`wakeActor` 抛错即便本地行未推进也是 ambiguous):
  1. **pre-admission**(admit 未发生):直接 settle:target 预约回滚 + verification path settle + `needs_lead`。
  2. **admitted 且可证明未发起 grant**(如 authority context 解析失败):原子 revoke 未用 credential + abandon activation + 预约回滚 + settle + `needs_lead`。
  3. **grant/wake 已投递或 ambiguous**(外呼已发出/抛错/结果不明):`needs_lead` + **fence 后续重试**,**保留预约**。
  - **grant-dispatch intent 持久标记(R4#2)**:`authority_context_corrupt`(→2)与「`grantTurn` 可能成功但 `recordWorkflowActivationTurn` 未跑」(→3)在 StateStore 持久行上**不可分辨**(grant 活在 CommDB/外部效果空间)。外呼 `grantTurn` **之前**,在同一 owner/generation CAS 下持久写 monotonic intent(利用已计划的 rebuild 加 nullable `grant_started_at` 列)。判定规则:**标记不存在的同步失败 → disposition 2;标记一旦存在 → 任何错误/crash 一律 disposition 3**(即便网络调用实际没发出)。wake 无需独立标记 —— grant 已启动即选 retain。
  - **disposition 从 durable facts 推导**:终局 CAS 复查 activation / credential / turn / delivery / reservation / `grant_started_at` 持久行,**不信 coordinator 本地 stage flag**;crash 后证据不足 → 一律取 disposition 3(ambiguous/retain)。
  - **operator 清理事务具名(R3#2)**:扩展 `openOperatorRework` 的 quiescence-authorized 事务(或其调用的既有 operator cleanup 事务):revoke/fence 旧 activation 与 credentials → settle 旧 target/预约 → **然后才**铸后继 attempt。
  预算仍是同一个 hold_count,不加第二计数。

### 2.3 测试

- 连续失败 → hold_count 递进 + backoff 生效(claim 被 `next_retry_at` 挡住)→ 第 5 次转 needs_lead,outbox 恰 1 条,founder thread 0 条。
- crash/race:第 5 次失败与另一 tick 并发 claim → CAS 单赢家。
- **stage-aware 终局(R2#3 + R3#2 + R4#2)**:第 5 次失败分别发生在 admission / turn grant/projection / wake / post-wake projection 各阶段的终局断言;**crash 边界三组(R4#2 修订)**:`grant_started_at` 标记**前**崩、标记**后外呼前**崩、外呼可能成功后本地投影前崩 → 重启后 disposition 从 durable facts 复推(前者 →2,后两者 →3);**迟到的 credential 提交或延迟 wake 不得复活被取代的 attempt;任何测试不得观察到两个可行动 attempt**。
- needs_lead 后 dispatcher 不再扫描;pre-delivery 形 → `openOperatorRework` 可开新单;post-delivery 形 → operator 路径先证 quiescence。
- retryable 类失败同预算断言。

## 3. 修复面 3:防空转谓词(R1#8 重定义)

插入点不变(mint 单一闸门 `StateStore.ts:26074`,事务内纯读),**谓词重定义**:

1. **谓词:复用既有 claim resolver,不写弱化 raw query(R2#2)**:从 pinned decision contract 解析 QA 节点与其当前 attempt,调 `resolveWorkflowDecisionClaim({ decisionKind: "qa_verdict", predicate: "qa_passed", requiredAttempt, subjectKind: "git_head", subjectDigest })` —— **仅 `valid: true` 时抑制**。
   - resolver 已内建:run/node/decision-kind/subject 定界、`requiredAttempt` 的 latest-physical-attempt 铁律、同 attempt 矛盾 predicate 检测、选中后的 revocation + expiry 复查 —— raw「ORDER BY … LIMIT 1」形在 revocation 先于 LIMIT、expiry、同 attempt 冲突、跨 decision family 混比四处都有歧义(R2#2 逐条点名),弃用。
   - 不比较 `activeRequest?.base_revision`(initial kickback 无 activeRequest,R1#8)。attempt-1 PASS + attempt-2 FAIL 同 head → resolver 按 requiredAttempt 解析为 not-valid → 照铸(latest 铁律);幽灵场景(当前 attempt 的 PASS 有效在册还要铸)才被抑制。三种 mint 味道统一走此谓词。
2. **命中后的走向**:transition 照常**原子完成源节点**;跳过 rework 四表 INSERT 与 target 预约;**不** append `edge_traversed`、**不**把 `current_node_id` 指向被跳过的目标(R1#8);记 `rework_suppressed_idle_spin` 幂等事件;除非存在被证明的真实替代边,否则 run → `held` + 复用修复面 2 的单发 ticket-lane 升级。
3. **operator 路径不加谓词**(R1#8):`openOperatorRework` 无 head 输入,且 master 授权 + quiescence 检查的 operator 路径就是预期 escape hatch。

测试:四种 mint 味道 × 谓词命中/不命中;**同 head PASS-then-FAIL → 照铸**(latest 铁律回归);revoked-latest / expired-latest / 同 attempt PASS+FAIL 冲突 / 其他 subject 上更新的 QA attempt / 无关高 attempt founder/review claims(R2#2 五组)→ 全部照铸;命中 → 无 rework 行、无 target 预约、无 edge_traversed、事件幂等。

## 4. 修复面 4:QA 节点 TTL 预配(qa 默认 6h)

1. **registry 默认**:`node-type-registry.ts` `NodeTypeRegistryEntry` 加平级字段 `submissionWindowMinutes?: number`(不进 capabilities —— 后者序列化进快照);`qa` entry 设 `360`。
2. **解析序**:`credentialExpiryForNode` 改为 `manifest 显式值 ?? registry[type] 默认 ?? 60`。
3. **语义诚实化(R1#9)**:registry 默认是**可变的 issuance-time 运营策略** —— 明确文档 + 测试:已 pin run 的**新发**凭证也吃新默认(这正是「预配」要的:1628 类存量 run 立即受益);已发凭证不动;snapshot digest 不动(`workflow-run-snapshot.test.ts:63-79` 哨兵)。不做「pin 进新快照」变体 —— 那会让运营调窗永远追不上已 pin run,与验收锚背道而驰。
4. **堵三个旁路发行点**:共享 helper `credentialWindowForNode(snapshot, nodeId, now)`(复用 `computeSubmissionExpiry`),`runs-route.ts:2568-2578`、`workflow-rework-coordinator.ts:380-397`、`actions.ts:989-997` 改走 helper。**明示并测试 actions retry 路径的窗口扩张**(15m/60m → 按节点类型窗 + 24h absolute;qa retry 撞墙与 1628 同病,扩张是修复不是副作用,R1#9)。
5. seed 层不动(heavy tier 180m 显式声明优先于 registry 默认,自然覆盖)。

测试:真过期凭证 → `submitWorkflowDecisionByCredential` / `POST /api/workflow/decision` → 409 `credential_expired`(`StateStore.ts:25252` 首踩);qa 新凭证 6h、非 qa 60m、manifest 显式值优先;digest 哨兵;三旁路各一条窗口断言 + retry 扩张断言。

## 5. 修复面 5(续):僵尸重派根除

### 5② seed 合成断言

- **主守卫(CI 测试)**:table-driven —— 两个 seed 家族(12 file seeds + 全部 menu shapes 经 `compileWorkflowMenuSeed`,用 **live node-type registry** 合成快照)逐个断言 `resolveWorkflowGateAuthority` 不抛。落点 `workflow-menu.test.ts` / `workflow-template.test.ts`。
- **gate-proof 覆盖分离(R2#6)**:1.2 的 proof 规则依赖 runtime 行(`workflow_run_node`/activation/session/PR binding),**合成快照证不了** —— 其覆盖放 seeded StateStore 集成测试(§1.4),不塞进 seed 断言。
- **次守卫**:`scripts/verify-workflow-seeds.mjs` 补**结构断言**(`resolveWorkflowGateAuthority` 不抛,仅此)+ 接入 `package.json` scripts 与 CI。

### 5③ completed-without-receipt:dead-exec 专属分支(R1#3 重设计)

- **不动 `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`** —— 它是共享 FSM primitive(`applyTerminalTimestamp`、lifecycle launch 仲裁、物化、rework 恢复、phase 重入、divergence sweep 都在用);从里面摘 `completed` 会让正常完成 session 拿不到 `terminal_at` 并在无关恢复路径被重判为活。
- **改为 `reconcileDeadExecutions()` 内的专属判定**:`session completed ∧ node running ∧ 无 completion receipt` → **一个原子 StateStore CAS**:复查三事实 → run → `held` → 幂等 `completion_receipt_missing` 事件 → 恰一次 escalation(ticket lane)。**不 respawn**(活已干完,重做永远是错的)。其余 irreversible terminal 状态照旧走既有 dead/liveness 替换路径。
- **replacement 计数**:不改(前提修正 3)。补两次 Bridge 重启回归测试:completed-without-receipt 形不再触发 respawn,`launch_ordinal` 不增。

### 5④ generic 节点 no_code 出口:窄事务闭环(R1#5 + R2#4/#5 完整化)

- **能力面(R2#4 DTO 适配)**:`GeneralizedExecutionDispatch.capabilities` 与 `BlueprintContext.workflowCapabilities` 现型为 `Record<string, boolean | string>` —— 数组装不进。改用 **boolean capability** `allow_no_code_completion: true`(registry generic entry;现 DTO 零类型改动)。快照 capability exact parser、物化器同步接受可选新字段;digest 哨兵 = 无该字段的旧快照 digest 不变。
- **prompt 贯通(R2#4)**:Blueprint 现只渲染 primary route(`needs_review` + `produces_output: true` → 指示 runner 提交 output 走 needs_review),新出口 runner 根本看不见。渲染显式 no-artifact 完成指令(「确无产出/取消时用 `complete --route no_code`,禁伪造 PR」)。
- **`produces_output` 修正**:no_code 分支放行「无 output credential 提交」的完成形,needs_review 分支维持现约束;**同事务 revoke 未用 output credential**(R2#4 —— 否则 run 完结后旧 credential 仍可被消费)。
- **⚠️ 缺失证据的信任规则(R2#4 安全洞 + R3#1 权威源具体化)**:**不能只信 runner 选的 route** —— 否则产出了 PR 的 runner 可省略 PR 证据、选 no_code、绕过 founder gate。no_code 分支 fail-closed 校验:
  1. 存在当前 output / PR binding / PR 证据 → **拒**(`no_code_artifact_present`)。
  2. **权威源(R3#1 + R4#1 封存点修正)**:admission 时封存**不可行** —— `admitGeneralizedWorkflowExecution` 发生在 `startDispatcher.start()` 之前,generic 无 `startPoint`,worktree 与其 generation 此刻尚不存在;`workflow_execution_binding` 有 no-update 触发器,可空列后补会弱化不可变性;单一 SHA/repo 对也表达不了多仓库。**改在既有权威 worktree-creation seam 封存**:`WorktreeManager.create()` 之后、runner launch 之前,Bridge-local `emitWorktreeReady`/`bindWorktreeOnce` 路径封存 baseline 集合,与 path/branch/generation 一起进**既有 set-once worktree-binding 权威组**;不把 activation binding 变通用可变。**不完整集合与 legacy(null)activation 一律不可用 no_code**(fail-closed;legacy-null 即迁移行为 —— 旧行无集合字段,直接不合格,无需回填)。补 sealing replay/ABA 测试。
  2a. **inventory 与 canonical 编码的具体定义(R5#1)**:**Bridge-owned pre-launch 枚举**,root 在真实 worktree 路径:记录 `__main__`(worktree 根仓库)+ 其内每个**验证过的**嵌套 Git root。每条 entry = `{ relative_path(normalized), remote_identity(normalized), baseline_head(40-hex) }`;按 `relative_path` 字典序排序;持久化 **canonical JSON**(及其 digest)进 worktree-binding 权威组的具名 set-once 字段(如 `repo_baseline_set_json` + `repo_baseline_set_digest`)。**完成时用同一枚举算法重跑,要求集合精确相等** —— 新建的嵌套仓库、消失的仓库、重复 identity、symlink 逃逸、任何 ambiguous 形 → **拒**。不用 EdgeWorker `repositories` map(路由级集合,不代表本 worktree 内的仓库根)、不信 runner 提交的 `targetRepoPath`(no-code caller 可以不给,不能定义缺失权威)。
  3. **完成时 fenced attestation**:no_code 完成前做仓库探测(HEAD、clean/dirty、未合入提交),closeout 事务内**复查 activation/worktree generation** —— generation 不符/证明缺失/过期 → 拒(探针 freshness 边界)。
  4. **仓库范围**:证明覆盖 bound worktree 内**全部已配置仓库**;嵌套仓库 scope 不明 → **fail-closed 拒**,绝不静默只查 root(嵌套仓库可藏 shippable delta)。
  5. 若实施中发现证据链无法在本单范围内补齐 → **`allow_no_code_completion` 保持关闭、出口拆 follow-up**,绝不弱化 founder-gate 边界(R3#1 兜底指令)。
- **窄事务闭环**(enrollment/transition 边界,不进 DAG 引擎核心):`generic + no_code` 完成 → 单事务:验 route/no-artifact 契约(上述规则)→ 写 completion receipt → source attempt 置 done → session 投影 `completed` + `terminal_at` → run 置 terminal `completed` → revoke 未用 credential → 幂等 `completed_no_artifact` 事件 → **不遍历、不物化 gate**。
  **理由**:founder gate 的意义是授权 ship;经证明无产物则无可授权。
- **外部收尾权威(R2#5)**:原子事务**只管** receipt/node/session/run —— `completed_no_artifact` 没有(也不该有)Linear 变更消费者;lifecycle closeout allowlist(`ship_complete | linear_reconcile | founder_park`)里 runner verdict 制造不了权威。1623 形(Linear 已 cancel)依赖**既有** terminal-Linear reconcile closeout 收尾并测试;活 issue 的外部 closeout 留待既有可信 disposition。若产品语义要 runner no-code verdict 推 Linear Done → **新权威机制,单独立项**,不藏在 run event 后面(→ honest boundary)。
- `needs_review` 完成(有 PR)→ 照走 gate → §1 打通的 runner_ship ship 链。
- **诊断步**:实施时读一个 pre-#748 generic run 的 event ledger,确认 engine_terminal 历史停滞点;若属独立断裂,如实报 Lead 拆 follow-up,不静默扩科。

测试:no_code 完成 → run completed、无 gate holder、无 node 预约、replay 幂等;**PR/output 在场 → 拒**;**R3#1 七组**:root 未变 / untracked+dirty / 已提交 delta / 仅嵌套仓库 delta / run 期间目标分支推进 / worktree generation 过期 / 完成-探针竞态;**R5#1 两组**:run 期间新建嵌套仓库 → 拒(集合不等)/ containment+重复 identity → 拒;legacy-null 行不可用 no_code;未用 credential 事务后不可消费;prompt 渲染断言(DTO/build);已 cancel Linear issue 经既有 reconcile 收尾;`produces_output` 两分支;needs_review + PR → gate → binding(接 §1);两 template id 过 5② 断言。

## 6. 修复面 6:admission pause(R1#10 补 bootstrap/覆盖/时长)

1. **持久单行**:新表 `admission_pause(id=1 CHECK, paused_until, set_by, reason)`,镜像 `fleet_pressure_hold`。无 timer:probe 现读比较 now,过期自动失效;durable(重启保刹车)。
2. **执行点(覆盖证明,R1#10)**:
   - `RunnerAdmissionController.tryAdmit()` 加 sibling probe → typed reason `"admission_paused"`;`AdmissionDecision`/`AdmissionDeferredError` 增 `retryAfterSeconds`,`runs-route.ts` 直接 precheck 与 typed-error handler **两处**都带 `Retry-After` 头。
   - retry chokepoint 是 **`RetryDispatcher.dispatch()`**(`runnerAdmission` 现只属 `RunDispatcher`,R1#10 纠正)—— probe 穿线进基类(或显式 override),并以测试**证明**六类 lane(HTTP start、phase handoff、auto-QA、rescue、retry、dead-exec replacement)全部过闸。
   - pause 检查放在 untyped `accepting` shutdown 判定**之前** —— 重启窗口的契约统一为 429,不落 500。
3. **端点**:`POST /api/admission/pause {durationSeconds}` / `POST /api/admission/resume`。独立前缀(gemini scoped token 够不着)+ Bearer master token + fail-closed 503 包装(`plugin.ts:2122-2134` 习语)。durationSeconds 上限 1h。
4. **restart-services.sh + staged rollout(R1#10 bootstrap 悖论)**:
   - **本单(阶段 1)**:land 端点 + probe + 脚本 Step 0(`deploy_and_verify` 内、self-detach 块之后,`notify_routine` 后 `stop_bridge` 前)POST pause,**默认 lease = 上限 1h**(600s 短于既有 15m health 窗 + build + stop,必然过期,R1#10);post-health 后显式 resume(失败不致命,TTL 兜底);`rollback_and_restart` 同 Step 0。**脚本侧 best-effort**:首次自部署时旧 Bridge 没有 pause 端点,失败必须放行 —— 并在输出里明示「pause unavailable (pre-feature Bridge), proceeding without brake」。首次部署的一次性人工 quiesce 要求写进 ship 备注。
   - **阶段 2(follow-up,兼容性确立后)**:pause 确认失败转 fail-closed。本单不做,写进 honest boundary。
   - **回滚边界措辞(R2#6 修正)**:回滚到前置版 Bridge 后,该 Bridge 在其运行期间**立即且无限期**无视 pause row —— TTL 只防「pause-aware 版本回来后的陈旧刹车」,**不防**回滚期间的 admission。如实记为已知边界。
5. 测试:pause → `/api/runs/start` 429 + Retry-After;retry lane 同拒;六 lane 覆盖证明;TTL 过期放行;mid-boot 持久;resume 即时;无 token → 503;`test-restart-services.sh` 补 Step 0 时序、secret 不进 argv、expiry>health-timeout、确认失败放行、rollback 行为。

## 7. 验收锚映射(全部活体)

| 锚 | 修复面 | 验证方式 |
|---|---|---|
| 1631 approve 后 verify 撞 binding_unavailable → 零人工 | 1+5① | 真机:schema-v2 DAG run QA PASS → founder approve → verify-approval ok → merge 全程零人工 |
| 1631/1596 held 刷屏 → 停在 5、告警只到 Lead | 2 | 注入连续 hold 失败 → backoff 递进 → needs_lead;Lead channel 恰 1 条、founder thread 0 条 |
| 1631 implement@3 幽灵 rework → 不铸 | 3 | 同 head latest=PASS 重放 → 无 rework 行 + suppressed 事件;PASS-then-FAIL 对照 → 照铸 |
| 1628 QA 凭证 1h 墙 → 6h 窗 | 4 | 新 qa 凭证 expires-issued=6h;3.7h 模拟不过期;真过期 → 409 回归 |
| 1634 部署期间派发 → 明确稍后再试 | 6 | restart 窗口内 /api/runs/start → 429 typed + Retry-After |
| 6 个 generic 单零重派 | 5③(+1/5①) | 重放 completed∧无receipt 形 → held 不 respawn;双重启 → launch_ordinal 不增 |
| tpl_generic_menu completed > 0 | 5④ | 真机 generic 单 no_code 收尾 → run completed |
| 取消单(1623 形)正常关闭 | 5④ | no_code 完成,无伪造 PR |
| 96 快照普查 6 例 incoherent_ship_bundle 归零 | 5① | 普查重跑 → 0 |
| 真机 E2E:完整 DAG run QA PASS → 自 ship → 收尾级联 | 全部 | 一条真 issue 走全链 |

## 8. 实施切分与顺序(R1#11 重排)

单 PR,提交按依赖序,每步测试先行:

1. **gate-proof + resolver**(1.1+1.2,含消费点回归测试)——一切 ship 链的地基。
2. **seed 合成断言**(5②)——立即锁住 1 的成果。
3. **binding 写入 + supersede + rebind**(1.3,bound 谓词收紧)。
4. **generic no_code 出口**(5④)—— 内部顺序:**authority capture 先行**(worktree-creation seam 的 baseline 集合封存,R4#1)→ capability/prompt → closeout 事务(含 produces_output 修正)。
5. **completed-without-receipt 专属分支**(5③,不动共享终态常量)+ 双重启回归。
6. **rework 迁移**(2.1)→ **原子封顶 + backoff + 预约回滚**(2.2)。
7. **防空转谓词**(3,在 latest-claim 规则确立后)。
8. **TTL**(4)。
9. **pause API/probe → 脚本 Step 0**(6,API 先于脚本依赖)。
10. docs/milestone 尾提交。

专项测试组(R1#11):boot/migration 组、crash 边界/幂等组、旧 pin 快照组、restart/rollback 组;全过后才跑活体锚 + 96 快照普查。
全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `scripts/test-restart-services.sh`。
Codex code review(`codex:rescue`)循环至 APPROVED;真机 E2E 由独立 QA 节点承接(本设计节点不 ship)。

## 9. Honest boundary

- 消息层展示形态(通知折叠、held 告警措辞)→ FLY-1569 D/E。
- runner no-code verdict 推动**活** Linear issue 到 Done = 新权威/effect 机制 → 单独立项(R2#5);本单只做 DB 侧原子闭环 + 已终态 issue 的既有 reconcile 收尾。
- pause 的 fail-closed enforcement(阶段 2)与「回滚到前置版 Bridge 运行期间无视 pause row」边界 → 兼容性确立后的 follow-up;本单 best-effort + TTL 自愈。
- pre-#748 generic run 的 engine_terminal 历史停滞若属独立断裂 → 诊断后如实上报拆单。
- `held` 既有语义、`MAX_BLIND_REPLACEMENTS` 数值与其 ledger 计数权威、founder-only merge 契约、`verify-approval` 安全检查、`ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES` 常量:全部不动。
- 96 快照普查中非本六单的 `:162`/`:174` 类 incoherent 形(若有)不在本单 —— 真不一致,保留 fail-closed。
