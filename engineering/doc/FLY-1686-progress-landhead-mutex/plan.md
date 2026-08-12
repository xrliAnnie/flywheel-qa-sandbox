# FLY-1686 terminal 前驱绑定(gen-3)— 实施计划

Issue: FLY-1686 (https://linear.app/geoforge3d/issue/FLY-1686/bug阻塞级-流水线强制-progress-记账-1655-land-head-闸互斥-所有-schema-v2-code-run-的-qa)
日期: 2026-08-11
基于: research.md(§1/§2/§4/§10 机制事实 + §12 gen-3 核查)+ exploration.md §0(founder 原话,最高约束)

**Version**: v1.58.0(暂定,ship 取空号)
**Status**: codex-approved(gen-3 design review 6 轮:R1-R5 共 23 项全吸收 + R6 APPROVED,两条 LOW 表格同步已折入;本文是本分支**唯一 governing plan**)

> 📌 **gen-5 采纳注(2026-08-11 晚)**:本 plan 原文不动、继续 governing。gen-5 基线重核(main `b0a095a8`,含 FLY-1693 模板退役与 #805 carrier-delivery 增量)与 Linear 晚间更正对账见同文件夹 `gen5-adoption.md`;其中 `tpl_eng.yaml` / `tpl_product_v1.yaml` 引用降级为历史注,§3.8 / §6.4 净删除口径按 gen-5 干净谱系重读(净删除 = 不移植)。
>
> 📌 **世代关系**:gen-2(reconcile/diff 路线,PR #807 + 修正案 C1-C4)被 founder 原话整体否决(exploration.md §0 逐字入档);正文保全于 git 历史(cc6b041d),修正案已挂 SUPERSEDED 横幅。gen-2 中**与绑定时机无关**的可复用件(C1 凭据/push 分离、C2 marker 先行、严格 push-endpoint 解析器、admission preflight exact-replay 补写)按价值折入本计划。

## 0. 一句话与红线

**一句话**:把「PR 权威 head 的绑定」从中间节点完成点**移到进入 approval gate 的那次提交**——该次提交的服务端 attested head 一次性绑定、直通 founder 卡与 land;中间节点绑定与 commit1/commit2 对比机器**净删除**。规则按 DAG 结构位置定义,对 land 与 runner_ship 两种 authority mode、对任意 family(qa_verdict / review_verdict / …)统一成立。

**红线(全部保留)**:
- land 闸 merge-tip == 绑定 sha:`commitWorkflowTransitionTx` 的 land 闸(`StateStore.ts:28677-28686` 区)、land executor 全部等值检查 + merge 前后 GitHub 全等(`land-executor.ts:146-176,325-330,389-396`)零松动——绑定发生在同一事务、transition 之前,闸从「拒收器」回归「不变量断言」;
- attest 语义:head 一律服务端派生(qa_verdict = `resolveWorkflowHeadAuthority` rev-parse;review_verdict = receipt-backed materialized head,`materialized-head-authority.ts:59-79`);客户端输入只比对,永不提权;
- fail-loud:一切拒绝带精确 reason(completion 与 decision 两路都不再吞成裸 `transition_refused`,§3.7);
- 无新 env flag、无 schema 迁移;
- **通用性(原话二)**:绑定者由 DAG 结构位置定义(§1),实现与测试断言**零节点名硬编码**(fixture 用中性 node id;真实 seed 回归按模板加载但断言不依赖名称)。

## 1. 通用规则(结构化定义)

> **绑定者 = 其 outcome 边 target 为 `workflowApprovalGate(manifest).node` 的那次 completion/decision(= gate 的直接前驱动作)。**
> 绑定动作 = 在该次提交的**同一 DB 事务**内,以该次提交的服务端 attested head T + 服务端解析的 repository/worktree authority 元组(§3.3),经既有 `recordWorkflowNodePrBindingTx` 写入 (run_id, 该节点 id, 该 attempt) 的唯一 binding 行,**并在同事务内退休本 run 其他节点的在途旧 binding 行**(§3.5,仅 legacy 在途需要),然后照常 transition 进 gate。

- `workflowApprovalGate`(`workflow-template.ts:794-805`)对 land 取 `approval_gate`、runner_ship 取 `terminal_gate` ⇒ **两种 authority mode 同一条规则**(R1-1:runner_ship 的真实拓扑同样是 decision 进 gate,`tpl_eng.yaml:25-27,43`);
- tpl_code 前驱=qa、tpl_generic=execute、tpl_product_v1 前驱=**review**(`tpl_product_v1.yaml:38-45`,R1-4)、任意未来模板自动成立;
- FAIL / kickback / loop 边不进 gate ⇒ 不绑定、零探针;
- 返工后再次进 gate = 新 attempt 绑新行,latest-attempt 语义退位同节点旧行;跨节点旧行由 §3.5 收敛。

## 2. 两条进-gate 驱动与现状(R1-1 订正后)

| 驱动 | 真实形态 | gen-3 动作 |
|------|---------|-----------|
| **enrolled completion** 直接进 gate(tpl_generic 单节点 execute→gate 等) | 完成时带 `input.prBinding` 证据写 binding(`StateStore.ts:27053-27070`)——已是 gate-entry 绑定 | 保持;写入条件收紧为「outcome 边 target == approval gate」(对现役 seeds 行为等价,防御未来形态) |
| **decision** 进 gate(tpl_code / **tpl_eng runner_ship** 的 qa_verdict;tpl_product/designer/prototype 的 review_verdict) | **不写 binding**——land 形态 409(病灶);runner_ship 形态靠 carrier completion 的旧点绑定 + holder 的 carrier-owned 要求撑着 | **补齐**:PASS 且 pass 边 target == approval gate 时,路由做服务端 PR attestation(§3.3),submit 事务内绑定→退休旧行→transition(§3.4);**land 与 runner_ship 一致适用** |
| 中间节点 completion(tpl_code/tpl_eng 的 implement 等) | 完成即写 binding(病根:冻结 commit1) | **净删除**:不再写权威 binding 行;PR 证据仍镜像 `sessions.pr_number/pr_head_sha`(display + §3.3 的 PR 身份来源) |

## 3. 改动清单

### 3.1 `StateStore.ts` — completion 侧

1. `commitEnrolledCompletion`(L27053 区):`if (input.prBinding)` → `if (input.prBinding && completionEntersApprovalGate)`(engineOutcome 边的 `edge.to === workflowApprovalGate(manifest).node`;数据函数内已有)。非进-gate completion 的 PR 证据:抽出既有 sessions 双写(L26671-26675)为私有 `mirrorSessionPrEvidenceTx`,两处共用——**镜像保留,权威行不写**。此收紧同时关闭 §3.5 退休后旧 completion 重放再插入的路径(重放走同一条件,不再写行)。
2. completion 路的 transition 拒绝不再吞裸 `transition_refused`(R1-6 / R2-5 / R3-4):`WorkflowCompletionResult` union(`StateStore.ts:37579-37608`)增可选 `detail:{transitionReason}`;**`event-route.ts`(L892-940)列入改动清单**,409 响应透传 detail;refusal 的 durable 审计发生在**回滚事务之外的独立提交**,UID digest **纳入 submission identity + transitionReason**(`completion_transition_refused:<digest(run,node,attempt,sourceEventId,transitionReason)>`,R3-4:同 attempt 先后不同 reason 各留精确一条,同请求同 reason 重试幂等——checked append 不冲突也不静默吞);测试:HTTP detail 精确、业务事务零残留、同 reason replay dedupe、**同 attempt reason 变化产生第二条事件**。

### 3.2 `StateStore.ts` — holder / rebind 与 carrier 解耦 + **镜像投影**(R1-1 / R2-1)

- `createWorkflowGateHolderTx`(L31105-31115 区)与 stage/apply carrier-rebind 两处(L33375-33387,L33550-33563):把「精确 head 的 binding 必须属于 `carrierNodeId` 且 attempt 相同」改为**两身份解耦**:gate-entry binding(任意进-gate 节点所有)提供唯一 PR/head authority;`carrierNodeId` 仅用于选择 ship actor(存活 carrier session)。
- **carrier 镜像投影 + 持久 B fence(R2-1 / R3-3)**:carrier 的 `pr_head_sha` 在中间 completion 后停在 B,不会自动前进到 T。candidate 显式携带 attestation 时 route 观察到的 `expectedProducerMirrorHead = B`;holder 事务内**重读** producer/carrier session,要求 current ∈ {B(待投影), T(已投影幂等)},第三值 C → 既有 unbound/escalation fail-loud(**不许把「当前值」自命名为 B**,那会掏空第三值守卫)。投影 CAS 前置:结构化 current carrier + activation/status 守卫 + `carrier.pr_number == gateEntryBinding.pr_number`(**镜像只有 number/head 两列,`StateStore.ts:917-965`——它是 actor correlation,不比对 repo tuple;repo 安全由 route 已按 gate-entry binding 的 slug 探测该 PR 保证**)。**B 以非权威 fence 持久化**到既有不可变载体(gate-entry 绑定事务追加的 checked run event `gate_entry_mirror_fence:<run>:<gate-node>:<attempt>`,payload 含 B/T/prNumber)——延迟的 stage/apply rebind 从该载体恢复同一 B,不从当前 session 猜。
- runner_ship 回归(§5-T5b)必须显式构造 **B != T**:首次 holder(投影→bound)、延迟 stage/apply rebind(fence 恢复)、镜像 PR-number mismatch、**镜像=C 的首次 holder 与延迟 rebind 双负例**(R3-3),分腿证明。

### 3.3 `workflow-decision-routes.ts` — 服务端 PR attestation(R1-2 / R2-2 / R2-3 钉死算法,**按 authority 类型分型**)

PASS 且 canonical pass 边 target == approval gate 且 run engine_owned(land 与 runner_ship 皆适用)时,submit 前按 family 的 head 来源分两型:

**A 型:worktree-attested(qa_verdict 等,T = 提交 execution 的 rev-parse)**
1. **repo tuple**(R2-3:sessions 无 repo 身份列):从**提交 execution 自身**的 immutable worktree binding 调既有 `resolveBoundRepositoryAuthority`(`repository-authority.ts:18-77`;event-route.ts:778-828 同构)一次解析 `{targetRepoIdentity, probeRepoSlug, targetRepoPath, head}`,要求 head **== T**(否则 `land_head_authority_drift` fail-closed);generation 取该 execution 的 worktree binding generation;
2. **PR number**:producer execution 的 sessions PR 镜像(唯一 `pr_number`,并与其 `pr_head_sha` 交叉参考);缺失/冲突 → `land_head_pr_identity_unavailable`。**不按当前分支发现 PR**;
3. **PR 探测**:`gh pr view <prNumber> -R <probeRepoSlug> --json state,isDraft,isCrossRepository,headRefName,headRefOid`(gen-2 只读形态;timeout + 注入 seam)。`state!=OPEN` → `land_head_pr_closed/merged`;`isDraft` → `land_head_pr_draft`;`isCrossRepository` → `land_head_pr_cross_repo`;ref 过 `git check-ref-format` 否则 `land_head_pr_ref_invalid`;
4. `headRefOid != T` → **409 `land_head_pr_not_at_tip`** + push 握手指令(§3.6);
5. 全过 → candidate(含完整 repo tuple;**不含 receiptId**)。

**B 型:receipt-attested(review_verdict 等 materialized-head family;R2-2 / R3-2 wire contract 钉死)**
真实 materializer 用临时 index/`commit-tree` 造 T 并推独立 ref(`workflow-docs-git.ts:95-174`),**T 不是也不该是 producer worktree HEAD**——authority 不走 worktree:
1. **receipt resolver 扩展为一次 joined read**:返回 `{effectId, outputId, attempt, repo, ref, head}` 并验证 intent/adopted/push_confirmed/current-output/direct-producer 全链(现 `MaterializedHeadAuthorityResult` 只有 head/outputId/attempt,`materialized-head-authority.ts:1-17`,需扩展);
2. **DB 投影(逐字段定义,满足既有非空约束 `StateStore.ts:15653-15668`)**:先验证 receipt repo == 项目权威 `projectRepo`,然后 `targetRepoIdentity="__main__"`、`probeRepoSlug=normalize(repo)`、`targetRepoPath=projectRoot`(仅作 server-controlled repo I/O anchor,**不声称其 HEAD 是 authority**)、`worktreeBindingGeneration="receipt-v1:<effectId>"`(严格 namespace,精确 parser);
3. **PR 身份与终点**:producer 镜像 `pr_number` + receipt repo → 同 §A-3 探测;`headRefOid != T` → **独立终态 reason `land_head_materialized_pr_not_at_tip`(R3-1:不复用 A 型 reason,绝不进入 push 分支)**——review 无 worktree,机器不代 push;今天同形态死在不透明 409,本设计变为提交时精确早失败 + Lead 可见,非回归;
4. **事务内 receipt 复核**(R3-2):§3.4 事务在退休/写入前按 `effectId` 重读 immutable receipt 链,核对 run/current output/repo/ref/head 全等;`/head-authority` 及后续复核按 generation namespace 分型,receipt-attested 走**同一 resolver + remote-ref 探测**,不得本地 rev-parse、不得另写一套解析;
5. candidate 为**显式 discriminated union**:`kind:"worktree"`(A 型)| `kind:"materialization_receipt"`(B 型,携带 exact effectId/repo/ref/head)——不靠松散字符串分型;
6. §3.7 对 B 型文案 = 「绑定 server-attested materialized head」,不得写「你的当前 HEAD」。

非 PASS、非进-gate 边、非 engine、legacy 三段式:零新增探针,字节不动。**删除**:gen-2 reconcile 接线、tri-state、ancestry/diff 守卫调用整段。

### 3.4 `StateStore.ts` — submit 事务内绑定(含独立复核)

`submitWorkflowDecisionByCredential` 增 internal-only `gateEntryBinding?`。事务内顺序:既有凭据全量校验 → exact replay 先返回(L27924-27943 语义不动)→ **镜像复核门控**(family/predicate 与 canonical 一致;pass 边唯一且 target==approvalGate;engine_owned + `status==="active"`;`headSha === lower(subjectDigest)`;nodeId/attempt == credential 的;prNumber 与 producer 镜像一致;任一不符 → 顶层精确 reason **`land_gate_entry_binding_mismatch`** 整体回滚)→ §3.5 旧行退休 → `recordWorkflowNodePrBindingTx`(原样;receiptId 事务内 = `gate-entry:<credential.id>:<clientRequestId>`)→ claim → transition(land 闸命中同事务行)→ holder(§3.2 新判定)→ ship-target。任一环拒 = 整体回滚零残留(退休一并回滚)。

### 3.5 在途旧 binding 收敛 + **共享 gate-entry helper**(R1-3 / R2-3 / R2-4 / R5-1)

**实现形态(R5-1 HIGH)**:sealed 前置检查 → 跨节点旧行 tuple 校验/退休 + checked 审计 → successor binding 写入,三步收敛为 StateStore **私有事务内 helper**(职责固定,不接受路由传入的「已验证」布尔)。**两条 driver 都在 exact replay 之后、transition 之前调用同一 helper**:`commitEnrolledCompletion`(当 `completionEntersApprovalGate && input.prBinding`;拒绝走 §3.1-2 的 `detail.transitionReason` + 独立 durable refusal audit,绝不 warn-and-continue)与 `submitWorkflowDecisionByCredential`(既有序列位)。任一拒绝回滚该 driver 的整个业务事务。⇒ 同一 DAG 结构不因提交 API 不同而获得不同的 manifest/legacy 安全。

helper 内,写入 gate-entry 行之前,同事务扫描本 run 的 current binding 行(per-node latest CTE,`StateStore.ts:33251-33264`):
- 存在**其他节点**的 current 行:要求其**完整 repo tuple** `{target_repo_identity, probe_repo_slug, pr_number}` 与 candidate 全等(R2-3:PR number 是 repository-scoped,manifest 唯一键即 `identity+NUL+pr_number`,`StateStore.ts:26242-26252`;任一不等 → `land_gate_entry_binding_mismatch` fail-loud);全等则**物理 DELETE + `pr_binding_retired` 审计事件**(payload:被退休行全字段 + 接任 tuple)。重放再插入已被 §3.1-1 条件关闭;退休随事务回滚;
- 覆盖面:land gate lookup、ship-target、land executor、single closeout、carrier rebind 自动受益;old==T("many")与 old!=T 两腿收敛;
- **sealed manifest 前置检查(R4-1)**:seal 是独立快照(`workflow_declared_pr.frozen_head_sha`,`StateStore.ts:26221-26345`),**不随 binding 退休收敛**——gate-entry 事务在退休/写入前读取 current manifest:已 sealed 且 declared set 与本次 successor authority(`{repo identity, slug, prNumber, T}` + expected_count)不全等 → **精确 reason `land_gate_entry_sealed_manifest_stale` fail-closed,全事务零残留**(绝不静默改写 sealed authority;reopen 只能走既有 master-auth 流程);已 sealed 且恰为 T → 幂等继续。post-ship 归因(`declared_pr_not_found` 家族,post-ship-finalization.ts:641-658)因此不可能在 merge 后才暴露 stale frozen head;stale-sealed run 纳入部署枚举清单;
- **存量两类分治(R2-4:exact replay 在退休之前返回,已消费 receipt 的 run 绕过本机制)**:
  - **未过闸类**(FLY-1676 形态:decision 曾被拒、整体回滚、credential 未消费):PASS 重交自动收敛,零手术——「无需数据手术」承诺**仅限此类**;
  - **已入 gate 类**(gen-2 下已成功消费 receipt、holder 已立、binding owner 非 gate 直接前驱)与 **stale-sealed 类**:部署合同 = **入库的只读枚举命令**(R3-5 / R5-2:`scripts/` 下 checked-in read-only script,内部用生产 snapshot parser 解析 gate 直接前驱,输出 run/holder/question/binding owner/head/receipt/seal 状态与建议 disposition;fixture 含未过闸/已入 gate/**stale-sealed 未过闸**/合法 gen-3 四类,断言 forward 模式恰命中「已入 gate + stale-sealed」两类),双端 restart 前运行,**非空且无逐 run 处置记录 = 阻断部署**;逐 run 由 Lead 显式处置(drain 至 land 完成 / 按既有手术口径对齐)——不做自动 legacy repair;PR 描述附命令、执行 SHA、时间与结果;
  - 测试补「already-consumed exact replay 原样返回旧 receipt、零退休零绑定」一腿(T7)。

### 3.6 `qa-result.ts` + flywheel-config — C1/C2 采纳、reason 词汇与 **lazy git**(R3-1)

- **首发不再 eager derive HEAD**(R3-1 BLOCKER):credential submission 路径删除 POST 前的无条件 `deriveHeadSha(getGit())`(现 :657-686)——`client_pr_head_sha` 本就是可选比对输入,服务端 authority 不依赖它;**收到 A 型 push instruction 后才 lazy `getGit()`**;legacy `/events` 路径保留旧行为。⇒ 无 worktree 的 B 型 review 能正常 POST;
- C1(凭据/push 分离)整件采纳,**仅由 A 型 `land_head_pr_not_at_tip` 触发**:严格 push-endpoint 解析器 → 真 HOME 单次 `gh auth git-credential get` → cleanEnv 一次性内存 credential helper 非 force push **精确 SHA** → 新 clientRequestId 重发,至多一次;
- C2(marker 先行)整件采纳;
- `DETERMINISTIC_REJECTION_REASONS` 增补:`land_head_pr_closed/merged/cross_repo/draft/ref_invalid/identity_unavailable`、`land_head_authority_drift`、`land_gate_entry_binding_mismatch`、**`land_head_materialized_pr_not_at_tip`(B 型终态,零 git/credential/push 调用)**、**`land_gate_entry_sealed_manifest_stale`(R5-2:一次 POST 即终态 + marker durable,CLI 测试断言)**;`land_head_pr_unresolvable` 族不入清单 = 有界重试;
- CLI 级测试(R3-1):B 型无 worktree 成功 POST;B 型 not-at-tip → git context/credential lookup/push **零调用** + marker durable;A 型握手行为不变;
- 删除 gen-2 diff/reconcile reason 词汇与处理支。

### 3.7 `Blueprint.ts` — 条件化契约文案(R1-5 / R4-3 按 authority 分型)

服务端从 pinned snapshot 派生 `passEntersApprovalGate` + authority 类型,随 generalized execution context 注入;**仅对 gate 直接前驱**追加,且按型措辞:**A 型** = 「你的 PASS 以你 worktree 当时的 HEAD 一次性绑定为上线版本」;**B 型** = 「你的 PASS 以 server-attested materialized head 一次性绑定」(no-worktree review 不得被告知「当前 HEAD」);两型共享「verdict 之后不再产生任何 commit」纪律句。多跳中间 decision 节点不注入。测试(T9 三腿):A 直接前驱 positive、B 直接前驱/no-worktree positive、非前驱 negative。

### 3.8 净删除清单

- `land-head-reconcile.ts` + 两个专属测试 + routes 接线 + StateStore reconcile CAS 段;diff 白名单/mode 守卫/ancestry/`--raw -z` 解析器整族;修正案 C4;
- 中间节点 completion 的 binding 写入(§3.1-1);holder/rebind 的 carrier-owned binding 要求(§3.2,改为解耦判定);
- gen-2 绑定时机耦合测试删除/改写;**保留**:严格 push-endpoint 解析器 + parity 测试、C1/C2 台架、admission preflight exact-replay 补写、PR-attestation reason 族。

### 3.9 对 FLY-1645 QA 输入的明确回答(设计令要求)

**记账侧结构性消解;verdict 后保留一行纪律。** verdict 前的台账/报告 commit 被 attested T 自然吸收(互斥消失,1645 QA 的「停写台账自保」不再必要);verdict 后 = 绑定点即台账停笔点(§3.7 契约句,仅对 gate 直接前驱注入),结构兜底两层:`progress` 单写者闸(完成即失写权)+ land executor GitHub 全等(FLY-1667 防线)。不建新验证器;Lead 临时规则「PASS 前不许台账 commit 骑在 PR head 上」部署后废止。

## 4. 安全性论证(靠角色合同,不建新机器)

commit2 未经 code review 的部分 = 非代码节点的文档 commit,由既有角色合同保证(qa-developer-separation「never modify source/config」);founder 批的、land 合的都是 T,无「批 A 合 B」窗口;违反角色合同 = 合同违规,由 review 纪律 + CI/审计兜底——不用 diff 机器二次验证(founder 否决的正是它)。幽灵 SHA 防线(R5-3 口径精确化):**decision gate-entry(A/B 型)** 的绑定硬前置 = GitHub 实测 PR headRefOid==T + authority 同源解析 head==T(终点双取证);**enrolled completion** 依赖既有 server worktree attestation(`event-route.ts:778-828`,不新增 probe,保持 T5a 兼容口径),GitHub 精确等值仍由零改动的 land executor 执行。

## 5. TDD 计划(先红后绿;fixture 一律中性 node id,断言零节点名)

| # | 测试 | 断言 |
|---|------|------|
| T1 | StateStore 事务单测 | gateEntryBinding 全绿:退休→绑定→claim→transition→holder→ship-target 原子;镜像复核每条负例 → `land_gate_entry_binding_mismatch` 整体回滚零残留(含退休回滚);exact replay 绑定前返回;binding 冻结/幂等/镜像回归 |
| T2 | attestation 单测(fake gh) | PR 镜像缺失/冲突、closed/merged/draft/cross-repo/ref-invalid、authority 解析 head≠T、headRefOid≠T 每腿精确 reason + 零 DB 变更;全过组装 candidate;非 PASS/非进-gate/非 engine/legacy 零探针 |
| T3 | 路由集成:decision 进 gate(真 git fixture + fake gh) | 多节点 land DAG(中性 id):中间节点完成 → **无 binding 行**、镜像在;前驱 commit 台账+报告 → PASS → binding=(前驱,attempt,T)、holder/ship-target 全链=T;land 闸同事务命中 |
| T4 | 授权 push 握手(C1 台架迁移) | not_at_tip → 完整指令 → 精确 SHA push(凭据零 argv、endpoint 归属证明)→ 重发通过;至多一次;push 后又前进 → 再拒 → 停笔重握手 |
| T5a | 反向兼容:enrolled 直进 gate | 单节点 land run 与 main 基线行为合同等价(binding 时机/内容/事件序列);FAIL/kickback 零绑定零探针;`commitWorkflowTransitionTx` 未绑定 head 仍 `land_head_unavailable`(闸零松动) |
| T5b | **runner_ship 全链**(R1-1 / R2-1 / R3-3) | **显式构造 carrier B != gateEntry T**:首次 holder(投影→bound)、延迟 stage/apply rebind(fence 恢复)、镜像 PR-number mismatch → unbound fail-loud、**镜像=C 的首次 holder 负例**、**镜像=C 的延迟 rebind 负例**,五腿分别证明;actor=carrier、ship-target 新行、founder feedback 恢复 |
| T6 | 通用性(R1-4/7 / R2-2 / R3-1/2) | 同一 fixture 三种拓扑参数化(中性 id):直进 gate / 一跳 worktree-attested / **两跳 receipt-attested(生产 materializer + 真 git 构造 `T != producer worktree HEAD` + 独立 ref;fake authority 回 worktree HEAD = 虚绿,禁止)**,B 型**分两腿**:自然 separate-ref → `land_head_materialized_pr_not_at_tip` 终态零 binding;外部前置 PR tip==T → binding/holder/ship-target/`head-authority` 全链成功;provenance 负例:malformed/unknown `receipt-v1` generation、wrong run/output/repo/ref/head、superseded output、remote drift、A 型 UUID 不误分类;node binding 与 ship-target 同一 provenance tuple;断言实现零节点名分支 |
| T7 | 在途收敛(R1-3 / R2-4 / R4-1 / R5-1 九腿 × 双 driver) | 旧行 old==T、old!=T、same-PR-number-different-repo 拒退休、退休后 completion 重放不复活、事务拒绝退休回滚、already-consumed exact replay 零退休零绑定、pre-sealed 旧 B → `land_gate_entry_sealed_manifest_stale` 全事务零变更、pre-sealed 恰 T → 幂等继续、post-ship 归因断言——**stale-sealed / old==T / old!=T / tuple-mismatch / rollback 腿至少在 completion 与 decision 两个 driver 各跑一遍**(R5-1);每腿断言唯一/不变 current 行 + 审计事件;completion 侧拒绝断言 `/events` 409 detail + durable refusal audit |
| T8 | 幂等/崩溃窗口 | 同 clientRequestId 重放零重复绑定;C2 marker 腿迁移 |
| T9 | 净删除守卫 + prompt 三腿 | reconcile/diff-whitelist 符号在最终 tree 归零(排除文档);Blueprint 注入(R4-3/R5-3):**A 型直接前驱 positive、B 型直接前驱/no-worktree positive、非前驱 negative** |

全仓门:`pnpm lint` + `pnpm -r build` + 定向 vitest;host 不跑全量,全包结论以 CI 为准。

## 6. 验收

1. T3/T5b/T6/T7 端到端绿(FLY-1672 形态治愈 + runner_ship 零回归 + review-family 闭环 + 在途收敛);
2. 真机独立 QA(编排方安排):529 房真 tpl_code land run 全链(台账+报告 commit → PASS 一次过闸 → founder 卡 → land 合 commit2);generic 对照等价;FAIL 回工不受影响;
3. 存量(R2-4 / R5-2 三类口径):**未过闸类**(FLY-1676 等)PASS 重交走通零手术;**已入 gate 类**与 **stale-sealed 类**部署前只读枚举 + 逐 run Lead 显式处置,清单进 PR 描述——不承诺普遍零手术;
4. **净删除口径(R1-7)**:以 gen-2 保全头 `cc6b041d` 为基线,gen-3 实现 delta 为净删除;最终 tree comparison 符号归零(T9)。相对 main 的 PR diff 不作为净删除判据(C1/C2/parser/文档为保留新增)。

## 7. 部署、回滚与鸡生蛋

- **前向部署**:CLI + Bridge 双侧 ⇒ `restart-services.sh`,双端 SHA 各自核过才让 in-flight 重发;§3.5 的只读枚举命令(已入 gate 类 + stale-sealed 类)非空且无逐 run 处置记录 = 阻断部署;本单自己的 QA 在旧 Bridge 上仍撞旧病 → PR 描述写明部署顺序 + 人工放行路径(判决 durable 在 marker,founder 可 out-of-band,Lead 按 issue 临时手术);
- **回滚合同(R4-2:「revert 即回滚」不成立——gen-3 改的是持久数据语义)**:同一枚举命令提供 `--rollback` 只读模式,列出四类中途 run:①中间 completion 已按 gen-3 完成但尚无 gate-entry binding(revert 后 gen-2 reconcile 因无 producer binding 返回 undefined,run 无法自愈);②存在 `pr_binding_retired` / gate-entry binding 的 active run(revert 不恢复被删行);③`receipt-v1:` ship-target(旧 `/head-authority` 无 namespace 分流会误判 drift);④unbound runner_ship + mirror fence(旧 rebind 要求 carrier-owned binding)。**非空且无逐 run 处置记录 = 阻断回滚**;可接受处置 = drain 至安全终态 / 让该 run 在 gen-3 上跑完 gate/land / Lead 按审计 payload 显式处置——不做自动复活 gen-2 binding;fixture 按 run 阶段证明「completion 后、decision 前」最危险窗口不漏;runbook 记录 command/SHA/time/result;
- **过渡期官方止血(部署前每次发生时;来自 1697 QA 活体,run cf5b2a19)**:QA 在本地 worktree 把 HEAD detach 回绑定 head(如 `git checkout <bound-sha>`)后提交 verdict,再切回原分支——可逆、分支指针/远端零动,规避「实时 rev-parse ≠ 绑定值」的 409;**注意**它只解 verdict 提交,land 阶段 PR head 若已漂移仍会 `pr_head_mismatch` held(1697 实录:gate 头 5244864c vs PR 头 a8ca9ea0,纯 doc 漂移)→ 仍需 Lead/founder 兜底。1697 的完整病程(QA 409 → detach 工作法 → land held → founder 手动)是 gen-3 要消灭的标本,部署后该工作法废止;
- 无 schema、无 flag;PR #807 关闭不合入,本分支 gen-3 PR 取代。

## 8. 诚实边界

- 不修(另族):rework 激活 `worktree_not_ready` 两臂;sessions completed wedge / `review_question_id` 写回;「原子写 6 处」合同;
- verdict 后漂移:§3.9 纪律 + 既有防线,不建新机器;
- PASS 时 PR 仍 draft:前移拦截(现状 land 时才炸),runner 先 `gh pr ready`;
- **B 型(receipt-attested)的 `land_head_materialized_pr_not_at_tip` = 终态精确拒绝**(review 无 worktree,无 push 握手):materialized T 不在 producer PR 上的形态今天同样 land 不了(死在不透明 409),本设计把失败前移为提交时精确 reason + Lead 可见;「materialized T 如何登上 producer PR」是产品族 landing 故事的独立设计题,不在本 bug 单内造机器;
- A 型 authority 解析 head≠T(提交者 worktree 在提交瞬间又动):fail-closed 精确 reason——不猜不赦免;
- legacy 三段式路径零改动。

## 9. QA follow-up: push 后 stale-read settle re-probe(2026-08-12)

独立真机 QA 在 PR head `4930067f` 证实主设计 17 项中 16 项通过；唯一失败位于 CLI 握手的 read-after-write 窗口：授权 `git push` 已成功，但紧接着的 `/api/workflow/decision` 让服务端通过 `gh pr view` 仍读到 push 前旧 tip，约 1.83 秒后才收敛。当前 `qa-result.ts` 在 `landHeadPushUsed=true` 后把任何第二个 `land_head_pr_not_at_tip` 都判为终态，无法区分 stale read 与真实漂移。

本 follow-up 不改服务端、不增加 push 次数、不放松 head 等值不变量：

1. 首个合法 409 仍按现有 C1/C2 规则写 marker、只 push 一次，并保存指令中的 push 前 `currentHeadOid`。
2. push 后重发若仍为 409，且新 detail 的 `currentHeadOid` **精确等于**保存的旧值，则按 250ms 间隔在 5s wall-clock deadline 内重探；每次重探沿用同一 resend `client_request_id`，不再 push，也不消耗 generic retry budget。
3. 新 detail 的 `currentHeadOid` 一旦不同于旧值，视为真实 post-push 漂移，立即维持既有 fail-close；detail 非法同样不进入 settle 赦免。
4. deadline 到期仍只见旧值则 fail-close 并保留 recoverable marker；提示语明确区分「远端 tip 在 settle window 内不可见」与「PR tip 真变化」，不再误导为 QA 本轮又产生了 commit。

### T10: CLI settle 状态机(RED → GREEN)

**文件**：`packages/flywheel-comm/src/commands/__tests__/qa-result.test.ts`、`packages/flywheel-comm/src/commands/qa-result.ts`

- [x] 测试 A：首发 409(A→B) → push → 重发仍见 A → 等待 250ms → 再探 accepted；断言 3 次 POST、1 次 push、同一个 resend request id、delay 恰为 250ms。RED 证据：旧实现第二次 409 即 `exit:1`；GREEN：定向 vitest 通过。
- [x] 测试 B：持续返回旧 A 直到 5s deadline；断言总等待不超过 5s、1 次 push、marker 保留、错误提示含 settle timeout 且不含 `Stop making commits`。RED 证据：旧实现第一次 stale 409 即提前退出；GREEN：定向 vitest 通过。
- [x] 测试 C：push 后返回不同 `currentHeadOid=B` 且 `expectedHeadOid=C`；断言零 settle wait、1 次 push、立即 fail-close，确保原 T4 真漂移安全腿不松动。
- [x] 最小实现：给 `qaResult` 增加窄 `now`/`sleep` 测试 seam；记录 pre-push OID 与 settle deadline；只在旧 OID 精确相等时 sleep + 不计 attempt 重探。
- [x] GREEN 后运行整个 `qa-result.test.ts`、real-git suite、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 与本 PR shell gate test。变更包 `flywheel-comm` 全量 1430 tests 通过；全仓唯一稳定红为未触及的 macOS Terminal `osascript` 真机集成两腿(隔离复现)，重负载 Teamlead timeout 三文件隔离复跑全绿。冻结 head 后重请 code review；独立 QA 同体复测由 DAG 编排方执行。
