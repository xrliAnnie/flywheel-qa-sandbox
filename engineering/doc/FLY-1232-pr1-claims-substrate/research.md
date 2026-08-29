# FLY-1232 PR-1 身份+事务 substrate — 调研

Issue: FLY-1232 (https://linear.app/geoforge3d/issue/FLY-1232/build-dag-模板引擎-pr-1身份事务-substrateclaims-账本-6-表-一次性-decision-capability)
日期: 2026-07-13
基于: exploration.md

> 按 Lead 覆盖令（b64cea04，design 轻量化）：本文档**不做独立业界调研** —— spec = 伞单
> flywheel-FLY-1135 分支 plan.md（Codex 4 轮 APPROVED），规范以其 §2.1/§2.2/§2.4b/§3.1b/§3.2
> 为准。§A–§E 是对 main 与参考实现的审计（段① 的验证底座），§F 是段②（并行写入）的增量分析
> （已折入 Codex design R1 对派发证据链的事实修正）。

审计对象：① main（本分支 flywheel-FLY-1232 = main HEAD 5d0e6f579）；② 上游 spec
（flywheel-FLY-1135 分支 plan.md）；③ 参考实现分支 fly-1135-pr1-substrate @ 3a993f3d5
（单 commit，4 文件 +2070 行）；④ 段② 挂点：packages/teamlead/src/bridge/ 的
phase-orchestrator / run-dispatcher / run-infra / launch-claim-store / started-evidence。

## A. main 现状审计

| 检查项 | 结论 |
|--------|------|
| StateStore 基座 | packages/teamlead/src/StateStore.ts，better-sqlite3 + sql.js 兼容 shim（FLY-663）；迁移入口 = 构造期一次性跑各 migrateXxx()，全部 CREATE TABLE IF NOT EXISTS 幂等风格 |
| workflow_ 前缀表 | main 上**零存在**（grep 无命中）——6 张新表无命名冲突 |
| FLYWHEEL_WORKFLOW_* env flag | main 上**零存在** —— 3 个新 flag 无冲突 |
| 跨厂商 review 概念 | 已有：packages/config/src/review-family.ts（FLY-1188）——adapterTypeToFamily（adapter_type→family，claude-tmux/NULL→claude，codex-tmux→codex，其余去 -tmux 后缀）+ crossFamilyReviewSatisfied（reviewer 家族必须 ≠ author 家族；legacy 无家族戳的行仅 claude 作者可过，非 claude 作者 fail-closed）。被 StateStore.isCodexCodeReviewApproved 与 flywheel-comm verify-approval 双侧消费 |
| merge-base 距离 | 参考分支 merge-base = 852447f16；main 之后仅 dda356779（FLY-1211 PRD docs）+ 5d0e6f579（1038 prototype serve.mjs lint）两个 commit，与参考实现 4 文件**零重叠** → cherry-pick 预期干净 |
| 伞单设计文档位置 | engineering/doc/FLY-1135-layer1-dag-templates/ 只在 flywheel-FLY-1135（HEAD 9ed7ea69e，纯 docs 态）与参考分支上，**不在 main** |

## B. 参考实现审计（3a993f3d5，逐项对 spec）

文件清单：

| 文件 | 行数 | 内容 |
|------|------|------|
| packages/teamlead/src/workflow-claims.ts | +151 | 封闭词汇表（predicates / issuer_kinds / subject_kinds / decision families / 系统 claim allowlist / review 类集合 / 放行集合）+ canonical JSON 摘要 + token 生成/哈希 + 3 flag 读取器 |
| packages/teamlead/src/StateStore.ts | +1099 | migrateWorkflowClaimsLedger()（6 表 DDL + 2 索引 + append-only triggers）+ 全部读写原语 + 行/结果类型 |
| StateStore.workflow-claims.test.ts | +690 | 32 条 substrate 测试（清单见 §D） |
| fly1135-doc-sentinel.test.ts | +130 | 3 条 sentinel 测试（含突变自检） |

### B.1 表结构 vs 伞单 §2.1 规范逐列核对

**workflow_claims**（append-only）：id / server_seq(UNIQUE) / issued_at / issue_id /
workflow_run_id / node_id / decision_kind / attempt / predicate(CHECK 封闭枚举 6 值) /
issuer_kind(CHECK 3 值) / issuer_execution_id / issuer_node_id / issuer_vendor / issuer_model /
subject_producer_execution_id / subject_kind(CHECK {git_head, snapshot_digest}) / subject_digest /
expires_at / permanent / submission_digest / client_request_id / evidence(json) / authority_id。
两条表级 CHECK 落实 §2.1 的按 issuer_kind 空值约束：
- runner_node ⇒ node_id/attempt/issuer_execution_id/issuer_node_id/issuer_vendor/issuer_model/
  submission_digest/client_request_id 全非空；
- expires_at 非空 XOR permanent=1（「仅显式永久系统 claim 可空」）。

与 §2.1 规范的对应关系全部成立；**一处结构化偏差**：规范表把 expiry 描述为单列 expires_at，
实现拆成 expires_at + permanent 标志列 —— 语义等价且更可查（permanent 显式化，避免「NULL 即永久」
的隐式约定），判定为忠实实现而非 drift。

**workflow_decision_capability**：token_hash(UNIQUE，**绝无明文列**) / run_id / node_id /
execution_id / attempt / allowed_predicate_family / manifest_revision / evidence_schema_version /
expected_subject_digest(可空的 subject 钉) / issued_at / expires_at / **absolute_deadline_at** /
consumed_at / consumed_claim_id / revoked / revoked_reason。§2.2 全列覆盖；absolute_deadline_at
落实「heartbeat 续期有绝对上限」。

**workflow_run**：run_id PK / issue_id / project_name / template_id? / template_revision? /
snapshot(JSON)? / current_node_id / status / **claims_read_enrolled**(typed enrollment) /
created_at。§3.1b 的 run 主记录最小态 + §3.2 的显式 enrollment 标记。

**workflow_run_node**：PK (run_id, node_id, attempt) —— §2.4b 的 attempt-keyed 投影。

**workflow_run_event**：(run_id, seq) UNIQUE + event_uid UNIQUE（幂等键）+ kind/node_id/edge_id/
execution_id/payload/at。§3.1b 的 append-only 事件账本。

**workflow_claim_revocation**：claim_id / revoked_at / reason / actor —— §2.1 的独立吊销账本。

**append-only triggers**：BEFORE UPDATE / BEFORE DELETE RAISE(ABORT) 落在
**workflow_claims / workflow_claim_revocation / workflow_run_event 三张账本表**上。
workflow_decision_capability / workflow_run / workflow_run_node **有意不设**：核销与续期
（consumed_at/expires_at/revoked）、投影更新（state/current_node_id）本身就是受控 UPDATE ——
「账本不可改写，凭证与投影可变」是 spec 的本意（issue 文案「六表 DDL + append-only triggers」
读作「六表 DDL，其中账本表挂 triggers」）。

### B.2 单事务 submit（submitWorkflowDecisionClaim）vs §2.2

事务体顺序：按 token_hash 取凭证 → consumed 分支（幂等重放判定）→ revoked → 过期（到期瞬间即
过期，fail-closed）→ predicate ∈ allowed family → subject_kind 合法 → expected_subject_digest
钉比对 → review 类必须带 producer 且 issuerVendor ≠ subjectProducerVendor（E6）→ 必须带
claim expiry → run 存在 → 写 claim（issuer_kind 硬编码 runner_node，authority_id = capability id）
→ 核销凭证（consumed_at + consumed_claim_id）→ appendWorkflowRunEventTx(claim_written，
event_uid = claim_written:{capId}:{clientRequestId})。**任何拒绝分支在写入前返回，事务里零残留**
——落实 §2.2「capability 校验先于任何通用事件落库，防无效提交留下像证据的输入」（R1#6）。

**E3 幂等重放**：submission_digest = canonical JSON（key 排序、undefined 剔除）的 sha256，
覆盖全部语义字段；重放判定 = prior.submission_digest === digest 且 client_request_id 一致 →
返回已建 claim（idempotentReplay: true）；不一致 → replay_payload_mismatch 拒。与 §2.2 R2#3
收紧版一致。

**系统 claim 路径分离**（appendWorkflowSystemClaim）：SYSTEM_CLAIM_ALLOWLIST 结构性锁死
bridge_policy→qa_exempt、founder_challenge→founder_approved；qa_exempt 强制 subject_kind=
snapshot_digest、founder_approved 强制 git_head；expiry XOR permanent。runner predicates 经
系统路径结构性不可达 —— §2.1/§2.3 语义正确。

### B.3 §2.1 解析算法（resolveWorkflowDecisionClaim）

过滤 (run, node?, decision_kind, subject_kind, subject_digest) → 取最高 attempt（NULL 按 0），
同 attempt 内取最高 server_seq → 同层 predicate 冲突 → conflict 拒 → 查 revocation 行 → 过期
（permanent 豁免）→ PASSING_PREDICATES 判 pass。**候选一旦选出绝不回落更旧 attempt**（测试
559/583 行显式钉死：最新 attempt FAIL/被吊销时，即使旧 attempt 对同 subject 有 PASS 也拒）。
与 §2.1「先选最高、再验有效、绝不回落」逐字一致。

### B.4 凭证生命周期（issue/renew）

- 签发：家族 ∈ RUNNER_CAPABILITY_FAMILIES（qa_verdict/review_verdict —— founder_decision/
  qa_policy 结构性发不出 runner 票）；同节点已 consumed 的 attempt ≥ 新 attempt 或存在更高
  attempt 活票 → stale_attempt 拒；签发新 attempt 自动吊销旧未核销票（superseded_by_attempt_N）。
- 续期：consumed/revoked/已过期拒；否则 min(请求值, absolute_deadline_at)。
- 明文 token 仅在签发返回值出现一次；DB 只有 sha256（测试 211 行断言明文不落库）。

### B.5 flags 与 enrollment

FLYWHEEL_WORKFLOW_CLAIMS_WRITE / FLYWHEEL_WORKFLOW_CLAIMS_READ / FLYWHEEL_WORKFLOW_FORCE_LEGACY
三个独立读取器，仅 === "1" 为开，默认全 OFF；enrollment 是 createWorkflowRun 的显式入参落列。
READ / FORCE_LEGACY 在本单无消费方（子单 B 的接线点）；WRITE flag 的第一个消费方 = 段②。

### B.6 参考实现的已知缺口（Codex design R1#6 —— 实现期硬化项）

1. **时间戳解析不拒非法输入**：workflowExpired 用 Date.parse 比较，Date.parse(非法串) = NaN，
   NaN 比较恒 false → 畸形 expiry 会被当作「未过期」——必须在 API 边界拒非有限时间戳（fail-closed）。
2. **签发不校验 expires_at ≤ absolute_deadline_at**：初始签发可越过绝对上限（续期有 cap，签发
   没有）——补校验。
3. **A9 的 consumed/revoked 续期拒绝缺测试**：代码分支存在但 starter suite 只测了 deadline cap
   与已过期续期 —— 补两条测试。
4. **appendWorkflowSystemClaim 信调用方 issueId**：应从 run 行派生（或校验一致，不符拒）。

## C. 发现的问题与设计注意点（进 plan 的实质输入）

1. **sentinel 文件系统依赖（阻断级）**：fly1135-doc-sentinel.test.ts 以 REPO_ROOT 相对路径读
   engineering/doc/FLY-1135-layer1-dag-templates/{exploration,research,plan}.md；main 无此目录
   → 只摘代码 commit 必红。**处置（gate 已批）**：本 PR 连带伞单文档（**钉 9ed7ea69e**）入库，
   且**文档 commit 在代码 commit 之前**（否则中间 commit 必红、不可 bisect —— R1#7）。
2. **E6 家族口径（契约级）**：claim 层门是裸字符串比较；subjectProducerVendor 只参与门判定
   **不落库**（落库的是 subject_producer_execution_id —— 真相可回查）。与 FLY-1188 家族概念的
   对齐方式 = 调用方契约：**传入值必须是服务端解析后的 family**（伞单 §3.1-3「绝不信 manifest/
   runner 自报」）。实现期在 submitWorkflowDecisionClaim 的 jsdoc 上把该契约写死。
3. **server_seq 生成方式**：MAX(server_seq)+1 事务内取号。Bridge 是 teamlead.db 唯一写者
   （单进程 better-sqlite3），事务内自增安全；若未来多写者需换表级 sequence —— 不属本单。
4. **workflowSelectAll / save() 惯例**：沿用 sql.js shim 的 prepare/bind/step 惯用法与每写
   save() 惯例，与文件内既有代码风格一致。
5. **词汇纪律**：sentinel 除扫伞单三文档外，还扫 packages/{teamlead,config,flywheel-comm}/src
   全部 .ts/.js/.mjs/.yaml 文件的退休词汇 —— 本单新增代码与文档都必须干净。

## D. 测试覆盖清单（32 substrate + 3 sentinel，全绿 @ 参考分支）

| 组 | 覆盖 |
|----|------|
| workflow_run enrollment (1) | 显式 enrollment 落列、绝不推断 |
| run_event (3) | 每 run 单调 seq 跨 run 独立；event_uid 幂等去重；未知 run fail-closed |
| run_node (1) | (run,node,attempt) 键 upsert |
| capability (6) | 只存 hash；未知 run 拒；新 attempt 吊旧票;stale attempt 拒；consumed attempt 不可重发；续期 ≤ absolute deadline；过期票不可续 |
| submit (9) | happy path 原子三写；E3(a) 同 payload 幂等；E3(b) 异 payload 拒 + 过期拒且零残留；E3(c) 未知 token 拒；family 外 predicate 拒；subject 钉不符拒；E6 同厂商拒；review 缺 producer 拒；runner claim 必须带 expiry |
| system claim (4) | qa_exempt 绑 snapshot 非 head;allowlist 双向锁；founder_approved 必须 git_head;expiry XOR permanent |
| 解析 (4) | E2 头移动语义（H1 PASS 不放行 H2，新 attempt 对 H2 PASS 放行）；最新 attempt FAIL 绝不回落旧 PASS；吊销后绝不回落；USE-time 过期拒 |
| append-only (1) | 三账本表 UPDATE/DELETE DB 层拒 |
| flags (1) | 三 flag 默认 OFF 且独立 |
| sentinel (3) | 扫描器突变自检（能红）；伞单三文档无退休词汇；三 src 树无退休词汇 |

伞单 §2.5 验收映射：本 PR 直接覆盖 **E3（全三款）+ E6（claim 层）+ E2 的解析语义单测**；
E1（红测变绿）= 子单 B、E4（founder guard 突变测试）= 子单 B、E5（遗留路径字节不变）在本 PR
表现为「零生产读接线 + default-off」，行为级 E5 验收随子单 B 读切换落。

## E. 段① 结论

参考实现对 spec 的忠实度经逐列/逐分支核对成立，无结构性返工；实现工作 = 文档收带（先行）+
cherry-pick + §B.6 硬化 + E6 契约 jsdoc + 全量验证 + 完整 review/QA。

## F. 段②（并行写入）增量分析 — R1 修正版

> Codex design R1 对本节初稿的派发证据链做了三处事实纠正（fresh 路径不经 LaunchClaimStore /
> session_started 行非 started 证据 / start() 返回 ≠ 落地），本版为修正后的权威版本。

### F.1 生产派发/生命周期路径的真实形态（审计事实）

**派发有两条真路径，证据机制不同**：

- **fresh（RunDispatcher.start）**：生成 execution id → CommDB 预注册 `:pending` 行 → 调度
  Blueprint.run() 后**立即返回**。**不经 LaunchClaimStore、不设 launchCommitPath** ——
  「start() 返回」不能当作任何落地证据。
- **retry（RetryDispatcher.dispatch + successorExecutionId）**：LaunchClaimStore.claim（原子
  INSERT-OR-IGNORE 防双起）+ launchCommitPath commit marker（**由 adapter 在 durable commit
  点写**，TmuxAdapter/CodexTmuxAdapter 已实现；normal 路径不设 marker 有显式 byte-compat 测试）。
- LaunchClaimStore.recordWindow **当前无生产调用方** —— 不得把 window 记录描述成既有证据。

**started 证据已有权威判定器**（started-evidence.ts，FLY-245 D2）：started 意味着且仅意味着
「runner 在 CommDB 自注册了非 :pending 的 tmux 身份 **且** 该 window 现在活着」。三个更弱信号
被该模块明文排除：intent WAL marker（只证明「想启动」）、CommDB `:pending` 预注册、StateStore
早期 session_started 事件（**在 adapter spawn 之前**由 DirectEventSink.emitStarted 写入）。
lookup_error = 无法证明任何一边，调用方必须 fail-closed。

**生命周期分支形态**：handoff() 有 wake 与 spawn 两个分支；keep-alive kickback 直接 wake
implement **不经 RunDispatcher**；QA PASS 在 onQaResult() 内持久化 intent 后返回；QA FAIL 分散
在 onQaResult() / runFailFlow() / runFailFlowKeepAlive()。启动 reconcile（reconcileOnStartup
等）在下游 phase 活着时**有意跳过**已完成的 handoff。组装点：plugin.ts 调
setupRunInfrastructure()，**run-infra.ts** 构造 LaunchClaimStore 与 RunDispatcher —— shadow
writer 的注入面在 run-infra，不在 plugin 直构。

**生产 attempt 现实（三种不同重入，不能共用一条规则）**：

1. **pre-commit 同 execId re-drive**（崩溃后 replay）——同一物理启动的收敛重试；
2. **post-start 替换**（reconcileQaLoss 在已启动的 QA 死后**换新 execution 重спawn，不涨
   belt/fix 轮**）——同一逻辑决策轮的第二次物理启动；
3. **回环重入**（QA-FAIL kickback，belt 轮 +1；keep-alive 形态下 implement 被 wake 复用同一
   execution）——新逻辑决策轮，未必有新物理启动。

### F.2 接缝设计（byte-compat 的结构保证）

- **可选窄接口注入**：不给 PhaseOrchestrator/RunDispatcher 直塞 StateStore —— deps 增加可选
  workflowShadow 接口；undefined ⇒ 全 no-op ⇒ 现有行为字节不变。注入面 = run-infra.ts
  （RunInfraOptions 增可选字段）+ PhaseOrchestratorDeps；plugin.ts 只按 flag 决定构造与否
  （单一开关点）。startBridge 外部注入 startDispatcher 的路径（测试/QA harness）不做 shadow
  包装 —— 观察期显式声明的覆盖边界，文档+测试钉住。
- **失败姿态（显式声明，非静默吞错）**：影子事务失败 = 整体回滚 + 带 issue/run/execution 标识
  的 loud warn，绝不阻断生产流。观察期姿态：影子账本不是权威；执法翻转在子单 B/D。
- **原子性（R1#2 + R3#5 统一命名面）**：影子写不走「顺序调多个原语」——唯一规范事务面 =
  **applyWorkflowShadowBatch**（单事务内：getOrCreate run + event_uid 去重/seq 分配 + run/node
  投影 + 事件追加 + 可选 side_effect 转移；launch_ordinal 在事务内分配并返回）。对账侧如需
  side-effect-only 便捷方法，它**委托同一 batch 事务**、且绝不用于 T1/T2/T7 的创建。
  同态重放 = 幂等 no-op，非法转移 = 拒。
- **run 边界**：活影子 run 唯一性由**部分唯一索引**（(project_name, issue_id) WHERE
  status='active'）在 DB 层保证；post-ship finalization 挂终结 seam 把 run 推出 active ——
  防「船开走了，后续同 issue 的新 workflow 还挂在旧 run 上」。

### F.3 ②b 派发副作用状态机 —— 证据真值表（R1#1 + R2#3 修正版）

**账本语义先行**：side_effect 账本记录的是**启动结果的历史**（这次物理启动走到了哪一步），
不是会话存活状态。「runner 启动成功后自然退出」不改变启动史 —— 这就是 started 是终态的原因，
也是判据必须用**持久事实**而非「现在活着」的原因。

| 影子状态 | 达成证据（唯一判据，全部为持久事实、对账时任意时刻可读） | 说明 |
|----------|----------------------|------|
| intent_recorded | 副作用前，与生命周期事件同一 StateStore 复合事务写入（§F.2 R2 修正：写入点在 RunDispatcher.start 的 pre-launch seam —— execId 分配之后、CommDB 预注册/Blueprint.run() 之前） | 唯一 owner = 派发器 pre-launch seam（见 plan 转移表 T1/T2/T7） |
| launch_committed | **adapter durable commit marker**（launchCommitPath 文件）存在 | fresh 路径今天不设 marker → **WRITE flag ON 时 fresh 路径也传 launchCommitPath**（BlueprintContext 既有字段、adapter 已实现写入，零 adapter 代码改动）；flag OFF 保持 undefined = 既有「normal 路径无 marker」哨兵。⚠️ flag ON 会让 fresh 启动走 commit-gate 包装（与 retry 路径同形态，FLY-245 已审机制）—— flag ON 的显式行为差异，plan 风险节声明 + QA 真机验证 |
| started | **launch_committed 已达成（marker 已证）∧ CommDB 非 :pending 行存在**（R3#1：两证据缺一不可，绝无「仅行」捷径） | **终态**。「启动成功」的持久历史事实。⚠️ Codex 路径的 CommDB 行是 **adapter 在 goal runtime 起来之前自己建的**（非 runner 自注册），且 setup/goal 失败也会保留终态行 —— 行单独证明不了启动成功，必须以 marker 为前置。started-evidence.ts 的 live-window 探针回答「现在还活着吗」（re-drive 安全决策用），账本不问这个问题。持久双证据同时消解 adapter 回调时序差（TmuxAdapter: marker→注册→回调；CodexTmuxAdapter: 行→回调→marker）—— 证据是文件/DB 行，对账时读，不依赖回调瞬间 |
| abandoned | 仅**pre-commit 正失败证据**：Blueprint.run() 显式拒绝 **且** 无 commit marker **且** 无非 :pending CommDB 行 | 带 reason + abandoned_at；marker 已在 ⇒ 停在 launch_committed。**Codex pre-goal 失败的保守案例（诚实声明）**：行在而 marker 永不出现 ⇒ 永远停在 intent_recorded（unknown），不 started 也不 abandon —— 宁可停在未知，绝不伪造历史。commit 后 window 死、indeterminate/lookup_error ⇒ 保持 launch_committed |

**attempt/ordinal 语义（R1#3 + R3#2 收紧）**：side_effect 行身份 = (run_id, node_id, attempt,
kind, **launch_ordinal**)；attempt = 逻辑决策轮（belt/fix 轮驱动，kickback 重入 +1；wake 复用
执行也算新 attempt 但**不产生新 side_effect 行** —— wake 不是 spawn 副作用）。
**launch_ordinal 由 writer 在 batch 事务内分配并返回（绝不信 orchestrator 预计算）**，规则 =
同 (run,node,attempt) 内**每个不同的 execution_id 得新 ordinal**（不论前一次物理启动走到哪一步
—— fresh start() 每次都分配新 UUID，crash 后 reconcile 重进 handoff 就是新 execution，必须有
自己的账本行）；只有**真·同 execution 的 pre-commit re-drive** 收敛到既有行。dispatch 类
event_uid 使用 writer 返回的 ordinal。**已提交行的 execution_id 永不改写** —— 历史不抹。

**event_uid 命名空间（R2#2）**：keep-alive 下同一 execution 跨多个逻辑轮 —— 裸
complete:{executionId} 会把第二轮的合法完成误判为重放。全部生命周期 uid 以 run + node +
attempt 为命名空间（可用处再缀 execution/源事件 id），如
run:{runId}:complete:{node}:{attempt}:{executionId}；kickback 以 runId（非 issueId）为域，
防同 issue 二次 workflow 撞车。

### F.4 边界表（谁属 A、谁不属）

| 内容 | 归属 | 依据 |
|------|------|------|
| run/run_node/run_event 生命周期影子双写（②a） | A（本单） | 覆盖令原文 |
| 派发 outbox/reconcile 状态机（②b，仅 dispatch kind，观察不驱动） | A（本单，独立模块） | ask a530fe31 裁定：伞单 ② 全量按字面全取 |
| 本地 claim 并行写（QA/codex verdict 生产者） | B（Lead 终裁，ask c33d61d2） | claim 行必须挂 authority；影子期无 capability 下发，强写 = 无授权的替身声明（Lead：恰是整套设计要消灭的东西） |
| 跨库投影（CommDB source event / TURN 源历史） | B | 伞单 §3.2（原③）+ Lead 确认 |
| claims 读切换 + 红测变绿 | B | 伞单 §3.2（原④） |
| materialize kind 的副作用状态机 | B | 伞单 §5-Q2（product 线） |
| 外部注入 startDispatcher 的 shadow 覆盖 | 不覆盖（显式声明的观察期边界） | R1#5；生产组装路径 = setupRunInfrastructure |
