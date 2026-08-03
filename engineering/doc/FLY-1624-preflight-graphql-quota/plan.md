# FLY-1624 GitHub 配额燃烧根源修复 — 实施计划

Issue: FLY-1624 (https://linear.app/geoforge3d/issue/FLY-1624/529仪器说谎-pre-flight-用-gh-repo-viewgraphql-查沙箱仓库-配额耗尽被报成仓库不存在-一条跑不通的)
日期: 2026-08-03
基于: research.md
修订: R9(折入 Codex design review R1×6 + R2×5 + R3×5 + R4×7 + R5×7 + R6×8 + R7×4 + R8×4;本版自包含,无跨版引用)

## 0. 目标与非目标

**目标**:
1. **Fix A** — 死胡同停表:valid、immutable 观察 → 持久 memo + 候选排除,GraphQL 归零(跨重启,resolved 候选);一次性 severe 告警。
2. **Fix B** — 节流 + merged 事实持久定格(resolved)+ head 证据 REST enrichment。
3. **Fix C** — 吸收 `fix/fly1620-preflight-rest`。

**本单不做**:Fix D(17 处 `gh 名词 动词` → `gh api` 迁移 + CI 静态守卫)→ 独立 follow-up;素材 research.md §7。

**非目标**:不自动 finalize merged-but-stranded run;不改 dispatcher 1s tick;不解决 subjectDigest 重冻结上游成因;FLY-1603/FLY-1608 的两条 stranded 行**不做物理行重写**(运维 follow-up,§9)——但本单**修掉它们的唯一剩余读者缺口**:`listWorkflowGateHoldersForMaterialization` 补 join `workflow_run` 且 `status='active'`(R8 #2,见 §2.9)。

**Flag**:不加新 env flag。回退 = revert + 舰队重启。

**行为收紧声明**:legacy(无 durable repo binding)候选**不自动完成 run** —— 只 pin + 告警,等 durable binding 建立、转 resolved 后才可完成。理由:legacy 探测按 cwd 选仓,probe 与 completion 之间 cwd remote 从仓 A 换 B 且两仓同号 PR 时,旧合同会拿 A 的观察完成 B 的 run。生产正常路径(如 FLY-1609,tpl_code + ship target binding)均 resolved,不受影响。

## 1. 变更总览

| 文件 | 变更 |
|---|---|
| packages/teamlead/src/StateStore.ts | resolver 四态 / 候选枚举(authority + hydration + memo 过滤)/ `recordRunnerShipMergeDeadEnd` / `completeWorkflowGateRunAfterShip`(CAS 扩展)/ `recordRunnerShipLegacyMergeAnomaly`(四 kind)/ `recordRunnerShipMergedObserved` / `resolveRunnerShipMergedObservationProjection` / `recordRunnerShipMergedObservationConflict` / `recordRunnerShipHeadEnrichmentFailure` / `recordRunnerShipHydrationRevalidationFailure` / `recordRunnerShipAuthorityConflict` / `listWorkflowGateHoldersForMaterialization` 补 run-active join(§2.9) |
| packages/teamlead/src/workflow-ship-ready.ts | candidate / outcome 类型 |
| packages/teamlead/src/bridge/workflow-ship-ready-arm.ts | 节流 factory + 状态机 + `enrichPrHead` seam + hydration + legacy boot-pin |
| packages/teamlead/src/bridge/external-merge-reconcile.ts | `checkPrMergeViaGh` 加性 `rawHeadRefOid`(既有字段字节兼容) |
| packages/teamlead/src/bridge/workflow-engine-dispatcher.ts | `reconcileRunnerShipMerges` 分支改造 |
| packages/teamlead/src/bridge/plugin.ts | 注入 `enrichPrHead` |
| packages/teamlead/src/LeadAlertNotifier.ts | 新 disposition 进类型 union |
| scripts/test-deploy.sh | Fix C cherry-pick `5dde8e90` |
| 测试 | StateStore.workflow-engine-transition / workflow-ship-ready-arm / workflow-engine-runner-ship-probe(新)/ enrichPrHead hermetic |

## 2. Fix A — 死胡同停表

### 2.1 无 TTL memo 范围

仅 `head_mismatch` / `rogue_before_approval`,且要求 valid 40-hex merged head + resolved authority。其余情形(head 不可用 / claims/session failure / 瞬态 / legacy / conflict / quarantine)一律不写排除 memo。

### 2.2 authority resolver 四态

```
{ status: "resolved", authority: { repoIdentity, probeRepoSlug, prNumber }, source }
{ status: "legacy_missing", prNumber }      // 无 durable repo binding;session 推导唯一 PR
{ status: "authority_conflict" }
{ status: "unavailable" }
```

- 源① `workflow_ship_target_binding`(question 级、`superseded_at IS NULL`、`frozen_head_sha == holder.head_sha`、run 一致)→ identity + slug(无 PR);
- 源② `getCurrentWorkflowNodePrBindingForHead(runId, holder.head_sha)` 合同(PR-producing 上游节点、exact-head/latest-attempt;内部查询 discriminated zero/one/many,**many → `authority_conflict`**,绝不与 zero 同 undefined)→ 完整 tuple;①②同现交叉验证;
- 源①-only:源③ session 推导唯一 PR → resolved(repo 取①、PR 取③);歧义/缺失 → `unavailable`;
- 源③-only:唯一 PR → `legacy_missing`;歧义/缺失 → `unavailable`;
- 任何源间矛盾/多行 → `authority_conflict`(零探测零 memo 零 completion + `recordRunnerShipAuthorityConflict`);
- fingerprint = `${repoIdentity}:${probeRepoSlug}:${prNumber}`(仅 resolved);
- 测试:binding 由真实上游 implement 节点 completion 产生。

**legacy 合同**:不持久、不 hydrate、不完成;「merged 后不回 GraphQL」= per-boot(boot-pin 分离存储 §3.2);anomaly 告警照发(四 kind,§2.6)。

### 2.3 dead-end memo

- uid `runner_ship_merge_deadend:${questionId}:${holderState}:${holderHeadSha}:${fingerprint}`(仅 resolved);
- checked append:只比语义字段(questionId/state/head/fingerprint/mergedHead/kind),不比时间戳;dedup 命中 payload 一致 → replay,不一致 → fail-loud;
- 重臂 = holder state / head / authority 任一变化(uid 失配 → 候选**重新进入本地对账**,R8 #3:同 authority 的重臂由持久 merged observation hydration 供给,**零 GraphQL**;只有真正未被任何 question 持久化过的**新 fingerprint** 才可能花 1 发 raw GraphQL —— 且若别的 question 已持久化同 fingerprint,新候选同样零调用);
- 排除在枚举 JS 层、authority resolve **之后**过滤。

**`recordRunnerShipMergeDeadEnd`**:

```ts
recordRunnerShipMergeDeadEnd(input: {
  questionId: string;
  expectedHolderState: string; expectedHolderHead: string;
  expectedAuthority: { repoIdentity: string; probeRepoSlug: string; prNumber: number };
  expectedObservationHead: string;         // 驱动本次写入的可信观察 head(R13 #2 / R14 #1)
  mergedHead: string;                      // 40-hex 小写(本方法只收 valid)
  deadEndKind: "head_mismatch" | "rogue_before_approval";
  alertIdentity: WorkflowEngineAlertIdentity; now: string;
}): { ok: true; idempotentReplay: boolean }
 | { ok: false; reason: "holder_unavailable" | "candidate_changed"
              | "observation_inconsistent" | "observation_stale" }
```

入参另含 `expectedObservationHead`(驱动本次写入的 merged head 证据,R13 #2)。事务顺序:① membership 重证(authority_mode='runner_ship'、state ∈ 探测集、run active、`engine_owned=1`、`gate_carrier_epoch=1`、current_node=gate_node)→ `holder_unavailable`;② CAS(state/head == expected;resolver 重跑与 expectedAuthority 全字段一致且 resolved);②′ **投影 re-proof(R13 #2 + R14 #1)**:事务内重跑共享投影,要求 legal、**非 quarantine**、且 **winningHead == expectedObservationHead == mergedHead 三者相等**(单一 head 值贯穿账本授权与 memo 载荷,防「投影授权 A、memo 却写 C」的接线错误)—— 任一失配 → 独立返回 `observation_stale`,零下游写(防「REST 复核后、事务前」另一写者提交 quarantine 的 interleaving);③ 语义重证(`head_mismatch`:mergedHead ≠ 当前 head;`rogue_before_approval`:state ∈ {materializing, awaiting_review} 且 mergedHead == 当前 head)→ `observation_inconsistent`;④ checked append memo;⑤ 同事务告警:head_mismatch → uid `runner_ship_merged_head_mismatch:${questionId}:${expectedHolderHead}:${fingerprint}`;rogue → 沿用既有 uid(event `runner_ship_rogue_merge:${questionId}`、alert `runner_ship_merged_before_approval:${questionId}`);**历史兼容**:pre-existing rogue event/outbox 视为已投递,不重写旧 bundle(避免 checked-append 回滚新 memo),新 memo 照提交。

### 2.4 completion 的 authority CAS(resolved-only)

```ts
completeWorkflowGateRunAfterShip(input: {
  questionId: string; mergedHead: string; now: string;
  expectedHolderState: string; expectedHolderHead: string;
  expectedObservationHead: string;   // 与 winningHead、mergedHead 三等(§2.3 同款)
  observedAuthority: { repoIdentity: string; probeRepoSlug: string; prNumber: number };
  alertIdentity: WorkflowEngineAlertIdentity;
}) // 强制新签名,无旧签名兼容路径;失败结果含 candidate_changed | observation_stale(零下游写)
```

事务顺序显式:membership + `carrier_binding_state='bound'` → state/head CAS → **当前 holder head == mergedHead**(失配 → `subject_mismatch`,零下游写;completion API 自身不依赖 dispatcher 先行分流)→ resolver 重跑全字段比对(漂移 → `candidate_changed`,零表变更零告警)→ **投影 re-proof:legal、非 quarantine、winning head == expectedObservationHead == mergedHead(失配 → `observation_stale` 零下游写)** → 既有 approved/claims/carrier-session 校验 → 才允许 session/run/node 变更。`ship_claims_invalid`/`carrier_session_mismatch` 在**本事务内** enqueue 告警,uid `runner_ship_completion_failure:${questionId}:${reason}:${mergedHead}`(event 去重,恰一次)。legacy 候选不调用本方法。

### 2.5 merged observation 账本:两级投影 + quarantine

**写入 `recordRunnerShipMergedObserved`(仅 resolved)**:
- base 行 uid `runner_ship_merged_observed:${questionId}:${fingerprint}`,语义 payload `{fingerprint, mergedHead: string|null, rawHeadRefOid?}`(`observedAt` 记录但**不参与** checked-append 比较,replay 保 first-seen);
- REST 成功后 null→valid 升级写第二行 uid `runner_ship_merged_observed:${questionId}:${fingerprint}:head`;
- 入参含 `alertIdentity`(R10 #1);返回 typed:`persisted | replay | candidate_changed | quarantined`;infra 失败单列(throw→调用方按失败处理);**仅 persisted/replay 允许下游 memo/completion**;
- 同 question 同 uid 撞 valid A vs valid B(R9 #1 + R10 #1):**检测与双写在同一个原子公开调用内完成** —— `recordRunnerShipMergedObserved` 的事务里验出既有 durable A 与来件 B 冲突后,**直接调用私有共享 bundle helper**(quarantine event + `observation_corrupt` severe outbox 单事务提交),然后返回 `quarantined`。**不存在跨公开方法传递未提交冲突的窗口**。公开的 `recordRunnerShipMergedObservationConflict` 保留给**已可由多条 durable lineage 推导**的 corruption(投影发现 >1 distinct valid heads / 非法 lineage),复用同一 bundle helper;其事务重跑投影,非 corrupt → `projection_changed` 零写入。
**crash 恢复合同(R11 #1 + R12 #1,采用 REST 复核方案,不留安全弱化窗口)**:
- 同进程:事务抛错被捕获后,arm 内存里 pinned 的 B 在同 boot 内零 GraphQL 重试 bundle。
- **hydration-sourced merged 证据在驱动任何不可逆效果前必须先过一次 bounded REST 复核**(不可逆效果 = dead-end memo 写入、completion;幂等告警不算)。复核用 `enrichPrHead`(计共享预算与 REST 退避):`merged_at` 非空且 head 与 hydrated valid head 一致 → 放行本 pass 的不可逆动作;**拿到不同 valid head** → 走原子 conflict bundle(quarantine + `observation_corrupt` 告警),零 memo 零 completion —— crash 前丢失的 B 冲突由此**必然重新被发现**;REST 失败 → fail-closed,本 pass 跳过不可逆动作,退避重试。
- 同 boot 内 raw 观察(GraphQL/REST 刚取得)不需复核 —— 观察与冲突检测在同一原子调用内。
- 成本口径(如实,与 §3.2 单一口径,R14 #3):GraphQL 仍恒零(founder 停表指令不受影响);REST = **每次(重新)进入可动作状态 ≤1 发**(复核成功缓存跨同 fingerprint holder 与本地重试共享;清理/重启后再进入可再花 1 发)。
**测试合同**:① 同进程 fault-injection 两边界(冲突检测后 / marker 与 alert 之间)→ 全回滚零残留 + 同 boot 重试后恰一 marker + 恰一 alert;② **决定性 full-recreation 测试**(不许用捕获异常模拟进程死亡):persist A → holder head=B、观察 valid B、bundle 提交前终止 → 重建 store+arm+dispatcher → 跑完整 dispatcher pass → 断言:hydrate A、零 GraphQL、REST 复核发现 B → conflict bundle(恰一 quarantine + 恰一告警)、**零 memo 零 completion**;③ hydration→复核一致→放行(memo/completion 各一例,恰 +1 REST);④ production-composition `persist A → observe B → conflict bundle` 正常路径。

**投影 `resolveRunnerShipMergedObservationProjection`**(枚举与写事务共用):
- **authority-global**:与活跃 runIds 无关(question/run 仅 provenance);
- **加载形状(R7 #1)**:每次枚举**一次**加载**两个命名空间** —— observed 行与 quarantine 行同一快照读出;查询用**显式字面前缀 range**(`event_uid >= 'runner_ship_merged_observed:' AND event_uid < 'runner_ship_merged_observed;'`,以及 quarantine 同款;`:` 的 ASCII 后继是 `;`),吃 `event_uid` UNIQUE 索引 —— **不用 LIKE**(`_` 是 LIKE 通配符且当前 schema 下 EXPLAIN 为全表 SCAN);加载后校验 kind 与 payload 形状,不合法行按 corruption 处理;**EXPLAIN QUERY PLAN ratchet 测试**钉住索引使用(输出含 SEARCH ... USING INDEX,不含 SCAN);
- **两级合法态**:per-question lineage(base 必在;base-valid 无 upgrade;base-null ≤1 valid upgrade)→ fingerprint 合并(0 valid → merged_needs_rest;恰 1 distinct valid head 胜出,null lineage 并存与多 lineage 同 head 收敛均正常;>1 distinct valid heads 或非法 lineage → corruption);
- **quarantine 优先**:快照含该 fingerprint 的 quarantine 行 → 不 hydrate、不探测(跨重启保持);
- corruption → `recordRunnerShipMergedObservationConflict`:事务重跑投影、确定性 projection digest、quarantine 行 uid `runner_ship_observation_quarantine:${fingerprint}:${digest}`、恰一次 severe 告警(disposition `observation_corrupt`);不复用 authority-conflict 方法(resolved authority 可与损坏账本并存)。

**账本所有权与 replay 合同(R8 #1,run-scoped ledger 上的 authority-global 标记)**:
- 事件 kind 定值:base/upgrade 行 kind = `runner_ship_merged_observed`;quarantine 行 kind = `runner_ship_observation_quarantine`,payload schema = `{fingerprint, digest, conflictingHeads: string[], firstSeenQuestionId, firstSeenRunId}`;escalation uid = 与 event uid 同串(`runner_ship_observation_quarantine:${fingerprint}:${digest}`)。
- **first-writer ownership**:quarantine 行物理挂在**首个观察到 corruption 的 run** 上(`workflow_run_event.run_id` 全局唯一约束下只可能一行)。后到的 run/question 遇同 fingerprint corruption:**先查存在性**(投影快照本就含 quarantine 命名空间)——存在且 fingerprint/digest 匹配 → 直接视为 quarantined,**不做**以自己 run_id 为参的 strict checked replay(那会 `workflow_event_uid_conflict` throw),既有行的 provenance 与首个 alert payload 即权威;digest 不匹配(冲突内容演化)→ 以新 digest 追加新行 + 新告警(uid 含 digest 天然分身)。
- `recordRunnerShipMergedObservationConflict` 签名:`{fingerprint, digest, conflictingHeads, observingQuestionId, observingRunId, alertIdentity, now}` → `{ok:true, idempotentReplay}`(存在同 uid 行即 replay)| `{ok:false, reason:"projection_changed"}`(事务内重跑投影已非 corruption → 零写入)。
- 测试:**双 run 同 fingerprint 并发写** → 恰一 durable quarantine 行、零异常、alert 恰一;close/reopen 后两个 run 的候选均 fail-closed。

### 2.9 materialization 列表的 run-status 缺口(R8 #2,替代 §9 原「行迁移」)

`listWorkflowGateHoldersForMaterialization` 现不 join `workflow_run` —— completed run 的 materializing holder 仍被捞出(FLY-1603/1608 两条 Lead 手写终态行即此形态)。本单补 run-active 谓词。实施回归同时确认旧的 holder-only API 允许尚无 `workflow_run` 行,所以必须保留 legacy no-run holder;**查询形状写死(R9 #2,防列名歧义/`SELECT *` 列覆盖)**:

```sql
SELECT h.* FROM workflow_gate_holder AS h
  LEFT JOIN workflow_run AS r ON r.run_id = h.run_id
 WHERE <既有谓词照旧> AND (r.run_id IS NULL OR r.status = 'active')
 ORDER BY h.created_at ASC, h.question_id ASC
 LIMIT ?
```

(holder-only 投影 `h.*`、全限定排序列 —— 裸 `JOIN` + `SELECT *` 会让 `created_at`/`run_id` 在 column-keyed shim 下歧义或被 run 表同名列覆盖;**`LIMIT ?` 保留并继续绑既有 boundedLimit**,R10 #2 —— 丢掉它会把有界对账批次变成每 pass 无界读。)回归:completed run + materializing holder 不再出现;active run 断言**完整返回行、稳定排序与有界基数**(供给行数 > limit 时验证截断),不只 membership。两条生产行本身不做物理重写(§9 运维 follow-up)。

### 2.6 legacy anomaly(四 kind,R7 #2)

```ts
recordRunnerShipLegacyMergeAnomaly(input: {
  questionId: string;
  expectedHolderState: string; expectedHolderHead: string;
  observed: { prNumber: number; mergedHead: string | null; rawHeadRefOid?: string;
              anomaly: "head_unavailable" | "head_mismatch"
                     | "rogue_before_approval" | "legacy_completion_blocked" };
  alertIdentity: WorkflowEngineAlertIdentity; now: string;
}): { ok: true; idempotentReplay: boolean }
 | { ok: false; reason: "holder_unavailable" | "candidate_changed"
              | "binding_present" | "observation_inconsistent" }
```

CAS = membership + state/head + 重算 fallback PR == observed.prNumber + durable binding 仍缺失(出现 → `binding_present`)。逐 kind 语义重证:
- `head_unavailable`:mergedHead null 且 raw 缺失/空白/非 40-hex(raw 规范化后 valid → `observation_inconsistent`);
- `head_mismatch`:mergedHead valid 且 ≠ 当前 head;
- `rogue_before_approval`:mergedHead valid 且 == 当前 head 且 state ∈ {materializing, awaiting_review};
- `legacy_completion_blocked`(新,§0 收紧的告警面):mergedHead valid 且 == 当前 head 且 state == approved —— 告知「已批准且已 merge,但 legacy 候选无 durable repo 身份,引擎拒绝自动完成,需人工核对 repo 后建立 binding 或人工收尾」。

uid `runner_ship_legacy_merge_anomaly:${questionId}:${expectedHolderState}:${expectedHolderHead}:${observed.prNumber}:${anomaly}`(generation-safe:含 state/head/PR/kind);checked event + 告警恰一次;零排除 memo。

### 2.7 其余告警方法

- `recordRunnerShipHeadEnrichmentFailure`:事务重证投影仍 base-null 无 valid upgrade(REST 成功与第 5 次失败竞态不得假告警);触发 = 同 fingerprint 连续失败次数**达到且保持 ≥5**(level trigger,不是会被一次 CAS race 永久吞掉的 edge;计数器归 classifier 进程内,重启/active 清理重置 —— 如实合同:重启后重新累计);uid `runner_ship_head_enrichment_failed:${questionId}:${fingerprint}`;replay 以首个持久 payload 为准(dedup 命中即已投递,易变 error 字段不参比;error-A→重启→error-B 不 throw 不重复);零排除。
- `recordRunnerShipAuthorityConflict`:事务重跑 resolver 确认仍 conflict;确定性 conflict digest(各源 tuple 排序序列化哈希)进 uid `runner_ship_authority_conflict:${questionId}:${digest}` —— 同一冲突恰一次,冲突内容变化可再告;零 probe/memo/completion。
- 新 disposition 全集(`runner_ship_merged_head_mismatch` / `runner_ship_completion_failure` / `runner_ship_legacy_merge_anomaly` / `runner_ship_head_enrichment_failed` / `runner_ship_hydration_reval_failed` / `runner_ship_authority_conflict` / `observation_corrupt`)进 StateStore alert 枚举 + `LeadAlertNotifier` union。

### 2.8 dispatcher 分支(全部传 observation-time CAS 材料)

| 观察 | 改后 |
|---|---|
| resolver `unavailable` | 本 pass 跳过,零调用 |
| `authority_conflict` / 投影 corruption/quarantine | 零探测;对应 conflict 方法恰一次告警 |
| merged 首观察(resolved) | `recordRunnerShipMergedObserved` 先行;仅 persisted/replay 进下行 |
| merged, head 不可用 | resolved → REST enrichment + 阈值告警;**legacy → anomaly(head_unavailable)+ boot-pin**(R7 #2 补行) |
| merged, valid mismatch | resolved → dead-end memo;legacy → anomaly(head_mismatch) |
| merged, valid match, state≠approved | resolved → dead-end memo(rogue);legacy → anomaly(rogue_before_approval) |
| merged, valid match, approved | resolved → completion(CAS);**legacy → anomaly(legacy_completion_blocked),零完成** |
| open / closed / unknown | 不记;节流 |

写入失败(`candidate_changed`/`observation_inconsistent`/`observation_stale`/`binding_present`)仅 log,下 pass 按新代际自然处理。

## 3. Fix B — 节流 + 状态机 + 持久定格

### 3.1 probeKey 状态机(自包含,R7 #4)

per probeKey = `${projectName}:${fingerprint}`(resolved;legacy 用 `${projectName}:legacy:${prNumber}` 仅作进程内调度键,不持久):

```
gql_pending ──(open/closed)──> definitive_ttl(RUNNER_SHIP_DEFINITIVE_TTL_MS=60_000) ──> gql_pending
gql_pending ──(unknown)──────> gql_backoff(UNKNOWN_BACKOFF_MS=30s→60s→120s→240s→300s) ──> gql_pending
gql_pending ──(merged+valid,同 boot raw)─> merged_valid          [evidence=current,可驱动不可逆动作]
gql_pending ──(merged+head 不可用)─> merged_needs_rest
merged_needs_rest ──(REST ok+persist ok)──> merged_valid
merged_needs_rest ──(REST fail)──> rest_backoff(同梯,独立 namespace) ──> merged_needs_rest
[hydration 注入] ──(hydrated valid)──> merged_hydrated_unverified   [R13 #1:不可直接驱动不可逆动作]
merged_hydrated_unverified ──(REST 复核一致)──> merged_valid[evidence=verified]
merged_hydrated_unverified ──(REST 得不同 valid head)──> conflict bundle(quarantine+alert)
merged_hydrated_unverified ──(REST fail)──> rest_backoff ──> merged_hydrated_unverified
[hydration 注入] ──(hydrated null)──> merged_needs_rest
※ merged_* 无回 GraphQL 转移;outcome 携带 evidence source(current/verified vs hydrated_unverified),**只有 current/verified 可 actionable**。
```

- GraphQL 与 REST 各自独立 in-flight map + backoff 状态(命名空间分离);**共享**每项目 6/min 滑窗预算;槽位分配对两类键统一按 `lastAttemptAt` never-attempted-first(mixed-work 公平,防新 GraphQL 键饿死 enrichment);
- single-flight per key;active 清理 finally 清非本 batch 键(**boot-pin 除外**);
- raw probe 显式传 `checkPrMergeViaGh(projectRoot, prNumber, timeoutMs, probeRepoSlug)`(resolved)。

### 3.2 hydration 与 boot-pin

- resolved:枚举投影 → 候选带 `mergedObserved` → classifier 零 GraphQL 进 merged_*(valid → `merged_hydrated_unverified`,**可动作前 0 GraphQL + 1 REST 复核**;null → merged_needs_rest,REST only)。
- **复核成功缓存(R13 #3)**:key = (probeKey, hydrated winning head, boot generation);同 fingerprint 多 holder 共享;失效 = 投影/authority 变化、quarantine、active 清理、重启。成本如实口径:**每次(重新)进入可动作状态 ≤1 发 REST**(claims/session 修复的反复本地重试不重复花 REST;empty-batch 清理后再进入会再花 1 发),不承诺全生命周期恰一。
- **持久复核失败告警(R13 #3 + R14 #2)**:新方法 `recordRunnerShipHydrationRevalidationFailure`(uid `runner_ship_hydration_reval_failed:${questionId}:${fingerprint}`,阈值 5 连败穿越、首 payload 权威;CAS 重证**投影级条件**:legal、非 quarantine、恰一个 winning valid head 且 == 失败的 hydrated head —— **不论该 head 来自 base 行还是 `:head` upgrade 行**;**不复用** head-enrichment 告警,其 CAS 要求 base-null 投影;disposition 并入两 union)——被批准的 run 不会静默卡死。决定性回归:base-null → REST upgrade → restart → 5 连败 → 恰一告警。
- legacy:boot-lifetime merged pin 存**独立 Map,不随 active 清理**;同 boot 内 `legacy → empty batch → 同 legacy` 零第二发 GraphQL;重启后至多 1 发(如实合同)。
- 冷重臂口径:同 authority 的 state/head 重臂(rogue→approved、empty-batch、清理、重启)= 0 GraphQL;「1 发」仅:新 fingerprint / 首 commit 前 crash 窗口 / legacy per-boot。

### 3.3 `enrichPrHead` seam(自包含)

```ts
enrichPrHead(projectRoot: string, probeRepoSlug: string | null, prNumber: number, timeoutMs: number):
  Promise<{ ok: true; headSha: string; mergedAt: string }
        | { ok: false; reason: "timeout"|"spawn"|"nonzero"|"bad_json"|"not_merged"|"invalid_head";
            rawHead?: string }>
```

生产实现(plugin.ts 注入):`execFile("gh", ["api", slug ? repos/${slug}/pulls/${n} : repos/{owner}/{repo}/pulls/${n}], {cwd: projectRoot, timeout: timeoutMs})`(timeoutMs 默认 10_000);catch-to-result(spawn/timeout/非零/坏 JSON → `{ok:false}`,绝不 throw);成功谓词 = `merged_at` 非空 **且** `head.sha` 规范化 valid 40-hex(否则 `not_merged`/`invalid_head`,`rawHead` 带 bounded 原值 ≤80 字符)。成功 → observation null→valid 升级(persist-before-effect)。REST 计入共享预算;classifier 维护 GraphQL/REST 计数,聚合输出(仅非零或周期汇总)。

## 4. Fix C — 吸收 pre-flight 修复

`git cherry-pick 5dde8e90`(scripts/test-deploy.sh +11/−2,保留 authorship;沙箱检查 REST 化 + 三态文案:存在 / 确认不存在 / 查不成 ≠ 不存在)。补真实脚本执行回归 `scripts/__tests__/test-deploy-preflight-github.test.sh`,并接入 CI 的 FLY-1389/529 repair batch。#767 先 merge 则 rebase 消解。

## 5. TDD(RED → GREEN → REFACTOR)

1. **RED(store)**:
   - memo 排除 + 重臂三方向;真实磁盘 restart(close→reopen);
   - resolver 四态全分支(superseded / 头不符 / many-rows → conflict / 源①-only+唯一 PR → resolved / legacy 歧义 → unavailable;真实上游 completion 建 binding;`__main__`+同 PR+异 slug 零共享);
   - completion:漂移 `candidate_changed` 零表变更零告警;claims/session 失败告警事务内恰一次;
   - **投影**:两级合法态(多 lineage 同 head 收敛、null+valid 收敛不判 corruption;>1 distinct valid → quarantine + `observation_corrupt` 真实 event/outbox 行);同 question A→B → 原子 quarantine 跨 close/reopen(**快照含无关 workflow 事件**,R7 #1);**authority-global 回归**(投影输入不含 Q1 run,仅 Q2 active → hydrate 零 GraphQL);**EXPLAIN ratchet**(range 查询走 UNIQUE 索引,无 SCAN);
   - typed persist 结果(Store 层只测结果类型与原子行,R7 #3);
   - legacy 四 kind 语义重证(含 `legacy_completion_blocked` 与 raw-valid-SHA 拒绝);历史 rogue pre-seeded 升级;changed-cwd 负例;CAS 零写入矩阵(state/head/authority/ownership/epoch);
   - enrichment failure 阈值穿越/竞态/error-A→重启→error-B;authority conflict digest 幂等;
   - **quarantine 所有权(R8 #1)**:双 run 同 fingerprint 并发 corruption → 恰一 quarantine 行、零异常、alert 恰一;digest 变化追加新行;close/reopen 两 run 候选均 fail-closed;
   - **head 三等负例(R14 #1)**:expectedObservationHead ≠ mergedHead(两 dead-end kind 各一)→ `observation_stale` 零 memo 零告警;
   - **materialization 列表 run-active(§2.9)**:completed run + materializing holder 不再出现;active run 与 legacy no-run holder 行为不变。
2. **RED(classifier)**:状态机全转移(含 `merged_hydrated_unverified` 三出口);merged_* 零 GraphQL;hydration(valid→0 GraphQL+**1 REST 复核**再可动作,match/different-head/failure-backoff/公平/共享 probeKey 各例;null→0 GraphQL+REST);复核成功缓存(同 fingerprint 多 holder 共享、清理/重启失效、claims 重试不重复花 REST);legacy boot-pin(empty-batch 后同 boot 零第二发);双 namespace;mixed-work 公平;预算 6/min + 61s never-attempted-first;open 60s TTL;unknown 退避 per key;同 authority 多 holder 不绕退避;head 规范化(missing/空白/非 40-hex/大写);raw 透传;active 清理;probeRepoSlug 显式。
3. **RED(dispatcher,生产 composition,单 arm 跨 pass)**:
   - merged+mismatch:pass1 = 1 raw + memo + 告警;pass2 = 0;
   - merged+malformed(missing 与 blank 两形态):REST 决定性回归(后补 valid matching head → 完成,GraphQL 计数不回升);
   - **persistence-failure composition(R7 #3)**:base 持久化失败 → 零下游效果,同一活 arm 重试持久化零 GraphQL;`:head` 升级写失败 → 零 memo/completion,下 pass 仅重试写、零 GraphQL 零 REST;持久化成功后下游恰一次;
   - restart:resolved 全套重建 0 GraphQL;legacy ≤1 发/boot;observation commit 后 crash → 重启零 GraphQL 续下游;首 commit 前 crash → 恰 1 发(唯一允许);
   - rogue:empty-batch → approved 重臂 → 0 GraphQL → 完成;
   - claims/session 失败各:告警一次、0 GraphQL、修复后完成;
   - **legacy-approved-match**:零完成、零 boot 内再 GraphQL、恰一条 `legacy_completion_blocked` anomaly(R7 #2);**legacy-malformed-head**:零完成、boot-pin、恰一条 `head_unavailable` anomaly;
   - unavailable 混健康候选;authority_conflict;completion_raced;
   - **interleaving(R13 #2)**:REST 复核一致 → 另一写者提交 quarantine → memo/completion 返回 `observation_stale`,零下游写;
   - **复核失败阈值**:持续 REST 失败 → `runner_ship_hydration_reval_failed` 恰一次;修复后完成。
4. **RED(helper)**:enrichPrHead hermetic(argv/cwd/timeout/spawn/nonzero/bad-JSON/merged_at 校验/invalid-head raw 捕获)+ `checkPrMergeViaGh` raw vs normalized 字段断言。
5. **GREEN**;**REFACTOR**(共享 probe-engine 仅当 classifyShipHandled 行为不变且其测试全绿)。
6. Fix C;全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`。

## 6. 验收判据(单一执行清单)

1. 单测全绿;teamlead 回归绿(既有 flake 按台账口径复跑)。
2. **生产采样**(60s × 0.5s):修前基线 = Lead 采样 765/766/762 = 55/52/50,以及止血后单活跃候选 766 = 36/60;修后:死胡同 PR 快照命中 **0**、无活跃 ship ≈0。快照命中数只作**时长旁证**,不折算调用数(R8 #4)。
3. **调用数 SLO(单一可测口径,R8 #4)**:以 classifier 聚合计数为准 —— **每 probeKey 每滚动 60s 资格窗至多 1 次 raw GraphQL 尝试**(≤60/h/候选),项目级 6/min 预算独立生效;无活跃 ship 0/h;死胡同/已定格候选 0/h;quiet-window curl token delta 仅系统级旁证。
4. **告警**:历史死胡同类候选(如再现 1603/1608 形态)各恰一条 head-mismatch severe;无重复刷屏。
5. **529 pre-flight**:GraphQL 耗尽下不误报仓库缺失。
6. **部署完成门**:目标 SHA 已部署;Bridge `/health` healthy;Lead `failed=0`(skipped 逐个列明原因并经认可);FLY-1603 Notification 播报送达。

## 7. 部署与运维

自托管 ship = detached handoff(spin.md 3.4 / self-ship-restart.sh → restart-services.sh)= **全舰队重启**;完成判据 §6.6。ship 纪律:launchd 先改后杀(FLY-193)、精准杀 run-bridge 树(FLY-239)、fail-close handoff。部署效果独立 QA 按 §6 取证;merge/ship 均 founder gate。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 过期观察写入/完成 | 全写路径 CAS(强制签名、事务顺序显式)+ 语义重证 + 零变更断言 |
| 跨仓完成洞 | legacy 不完成 + resolved completion 重跑 resolver |
| 投影歧义/账本损坏/quarantine 失明 | 两级投影 + 双命名空间同快照加载 + range 索引查询 + EXPLAIN ratchet + durable quarantine |
| 冲突观察 B 在 bundle 提交前进程死亡 → stale A 驱动错 memo/错 completion | **无窗口**:hydration 证据驱动不可逆效果前强制 bounded REST 复核(§2.5),冲突必然重发现;REST 失败 fail-closed 跳过;full-recreation 测试跑完整 dispatcher pass 钉住 |
| 跨 question 漏 hydrate | authority-global 投影 + 决定性回归 |
| 瞬态畸形 head 永久化 | 零 memo + REST 自愈 + 决定性回归 |
| 重启 GraphQL 复燃 | resolved 持久 + hydration;legacy per-boot ≤1 + boot-pin 分离 |
| 告警假阳/uid 冲突 | 阈值穿越语义 + 首 payload 权威 + generation-safe uid(state/head/PR/kind) |
| 节流拖慢收敛 | 暖/重臂 0 gh;新 authority 1 发;分钟级 |
| cherry-pick 冲突 | rebase 消解 |

## 9. Follow-up(记回 issue)

- Fix D(research.md §7);
- gate holder subjectDigest 不随 re-push 重冻结的上游成因;
- FLY-1603 / FLY-1608:Lead 止血手写的「completed run + materializing holder」两行的**物理清理**(纯运维,非本单代码;§2.9 已修掉其唯一剩余读者,清理不再有功能紧迫性;若届时仍要清,需单独出带完整 run_id、只读前查、备份、CAS 谓词与幂等说明的运维单);
- 1609 事后取证:runner verify-approval 曾报 head_authority_unavailable 的 claims 路径根因(与 receipt 无关,tpl_code 不走 receipt 分支;需下次复现时抓完整 stderr);
- **observation quarantine 触发后的运维处置**(R12 #2):quarantine 使该 authority 停探停完成,run 停驻 —— 处置步骤:读 quarantine 行 payload(fingerprint/digest/conflictingHeads/firstSeen 溯源)+ 只读核对 workflow_run_event 两条 lineage + REST(`gh api repos/<slug>/pulls/<n>`)取真实 merge head;确认真相后任何修复(清 marker/改 holder)必须走带完整 ID、只读前查、备份与 CAS 谓词的**独立运维单**,不在本单。
