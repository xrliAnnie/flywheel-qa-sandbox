# FLY-1686 progress 记账 × land-head 闸互斥 — 调研

Issue: FLY-1686 (https://linear.app/geoforge3d/issue/FLY-1686/bug阻塞级-流水线强制-progress-记账-1655-land-head-闸互斥-所有-schema-v2-code-run-的-qa)
日期: 2026-08-11
基于: exploration.md

审计基线:branch `flywheel-FLY-1686` @ main d6536134(与生产 Bridge buildSha 一致)。所有 file:line 均为实读,非推测。

> ⛔ **第三代注(2026-08-11)**:founder 整体否决 reconcile/diff 路线(原话见 exploration.md §0)后,本文 §3-§9 的 gen-2 实现合同(reconcile 提案、diff 白名单、授权 push 握手接线位置)**作废,保留为审计记录**;gen-3 机制核查见文末 **§12**,governing plan = 同文件夹 `plan.md`(gen-3)。§1/§2/§4/§10 的机制事实(409 路径、binding 写入语义、下游一致性矩阵、幂等)继续有效并被 gen-3 直接引用。

## 1. 409 的完整代码路径

| 步骤 | 位置 | 事实 |
|------|------|------|
| 入口 | `packages/teamlead/src/bridge/workflow-decision-routes.ts:404` `/decision` | 凭据认证;`client_pr_head_sha` 只做比对,不提权 |
| engine 判定 | 同文件 :72 `resolveEngineDecisionCanonical` | `getGeneralizedWorkflowNodeForExecution` + `run.engine_owned===1` 才走 engine 路径 |
| head 自派 | 同文件 :99-102 → `bridge/head-authority.ts:18-43` | family=`qa_verdict` ⇒ serverHead = QA worktree `git rev-parse HEAD`(5s timeout,40-hex 校验) |
| producer 定位 | :103-113 | manifest 反查进入 qa 节点的边,取该 from-node 最新 `state='done'` attempt |
| 提交+转移 | `StateStore.ts` `submitWorkflowDecisionByCredential`(claim 写入 :27500 起) | claim INSERT → 凭据消费 → engine run 时 `commitWorkflowTransitionTx`(:27578),`subjectDigest`=serverHead |
| **land 闸** | `StateStore.ts:28054-28079` | 目标是 gate 且 `resolveWorkflowGateAuthority(snapshot).mode==="land"` ⇒ head 必须 `getCurrentWorkflowNodePrBindingForHead(runId, head)` 命中,否则 `land_head_unavailable` |
| 409 收口 | `StateStore.ts:27588-27602` | `transitionRefusal` 置位 → throw → catch 返回 `{ok:false, reason:"transition_refused"}` → 路由回 409 |
| 回滚语义 | `this.db.transaction` 回滚 | claim/凭据消费一并回滚 ⇒ **凭据未消费,重发只会确定性再撞**(FLY-1672 实况吻合) |

### binding 匹配语义(`StateStore.ts:32597-32640`)

`resolveCurrentWorkflowNodePrBindingForHead`:对 run 内每个 node 取 **最新 attempt** 的 binding 行,`lower(head_sha)` 全等匹配;0 行 = zero,1 行 = 命中,多行 = many(上层视为 miss)。**没有任何祖先/前缀容忍**——这就是闸的"精确命中"语义。

## 2. binding 的写入与不可改写

`recordWorkflowNodePrBindingTx`(`StateStore.ts:26591-26677`),由 implement 节点完成路径 `commitEnrolledCompletion` 调用(:27056):

- 唯一键 (run_id, node_id, attempt);receipt 幂等;
- **同 tuple 已存在时只做逐字段比对,拒绝改写 head**(:26650);
- 同事务镜像 `sessions.pr_head_sha = head`(:26671-26675)—— reconcile 必须复制这个镜像动作(见 §4)。

## 3. 漂移来源(两条"必须"的另一半)

- `flywheel-comm progress`(`packages/flywheel-comm/src/commands/progress.ts`):FLY-795 单写者、temp+rename、`git commit --only -- <progress.md>` path-limited 本地 commit;**从不 push**(与 memory 记录一致)。流水线 baseline 规则强制每个 Runner(含 QA 节点)维护。
- QA 报告 commit:QA 契约"收工前 git status 必须为空"。
- 两者都落在 QA worktree 检出的同一 PR 分支 ⇒ QA HEAD = 绑定值 + 若干纯文档 commit。FLY-1672 实况:绑定 d0bafb79,QA HEAD b0706adb,`git diff -- scripts/ packages/ .github/` 为空。

## 4. 下游一致性矩阵(reconcile 必须保住的每一处)

| 消费点 | 位置 | 依赖 | reconcile 后是否自洽 |
|--------|------|------|---------------------|
| gate holder 物化(land) | `StateStore.ts:28615-28666` | holder.head_sha = subjectDigest(T) | ✅ binding 已 = T |
| ship-target 冻结 | `bindWorkflowShipTargetForGateTx`(:25423-25441)| 按 holder head 查 binding,**miss 即 throw** | ✅ 这正是"必须先改 binding"的结构性证明 |
| land 授权 | `bridge/land-executor.ts:146-176` | holder.head==approved_head;binding@holder-head 存在且 pr_number 一致;`resolveEngineWorkflowShipClaims(subjectDigest=approved_head)` | ✅ QA claim 的 subject_digest 本来就是 T |
| **GitHub 实测 head** | `land-executor.ts:329,395` | `gh pr view` 的 headRefOid **必须全等** approved_head | ⚠️ **T 必须已在 PR head 上** —— reconcile 前置改为"实测 PR headRefOid==T"(终点取证),否则 land 卡 `pr_head_mismatch`(FLY-1667 家族) |
| carrier 比对三处 | `StateStore.ts:30497,32723,32898` | `session.pr_head_sha == holder.head_sha` | ✅(R1 订正)三处均为 **runner_ship-only** 路径,land 授权只读 holder+binding ⇒ session 镜像**非结构必需**;保留为带守卫的非致命投影维护(见 plan §2.3) |
| PR manifest seal | `sealWorkflowPrManifestFromBindings`(:26186)| seal 时读**活 binding** | ✅ seal 无 verdict 前生产调用方(唯一入口 runs-route.ts:664,master-token HTTP);防御:CAS 拒绝已 seal 且冻旧 head 的情况 |
| convergence 扫描 | `StateStore.ts:26092-26111` | `b.head_sha = d.frozen_head_sha` join | ✅ 只要 seal 发生在 reconcile 之后(生产顺序如此) |

## 5. 先例:FLY-945 Fix B(legacy 路径的同类修复)

`bridge/auto-qa-coordinator.ts:1607-1740` `tryShipGateRebind` —— legacy(非 engine)ship gate 在 QA evidence commit 推走 head 时的 rebind,生产验证过。其 fail-closed 条件集直接可借鉴:

1. 仅 PASS verdict("only a QA-proven head deserves the gate");
2. gate 问题**尚无 founder 回应**(已答的批准冻结在 founder 看到的 sha 上);
3. reporter 身份过同一记录校验(不给陌生 sha 开门);
4. `git merge-base --is-ancestor old new` 在 session worktree 证明 same-branch-forward(worktree 缺失 → 拒);
5. CAS 改 head(`setSessionPrHeadShaForRebind`,WHERE-status 守卫)+ 审计事件 + thread anchor。

**与本单的差异**:legacy rebind 无"纯文档 diff"守卫(它的安全网是 founder 看到 rebind anchor 后再批新 sha);engine land 路径的批准卡片不展示 diff,且 implement 节点内的 code review 证据只覆盖到绑定 head —— 所以本单**必须**加纯文档守卫,保证"过了 review 的代码 == 合入的代码"。这也与 Lead 手术判据逐字一致。

## 6. engine 路径的 qa PASS 时机 = 唯一安全窗口

qa→gate 转移发生时:gate holder 尚未存在(本次转移才创建)、founder 尚未看到任何 head、ship-target 尚未冻结。在这个窗口内改 binding,下游全链(holder → ship-target → founder 卡片 → land merge)看到的都是同一个 T,「批准 head == merge tip」不变量零触碰。窗口之后(S9)任何漂移仍被 land executor 的 GitHub 全等检查拦住——原有防线不动。

## 7. runner_ship 模式的软化变体(v1 出界依据)

`createWorkflowGateHolderTx`(`StateStore.ts:30447-30602`):runner_ship 模式下 binding@T miss **不 throw**,只是 carrier 留 unbound(:30501-30536),later 走 carrier-rebind 流程(那条流程同样比对 `session.pr_head_sha == holder.head_sha`,漂移时得 `carrier_session_mismatch`,退化但不死锁)。FLY-1655 后新 revision 一律 land 模式,runner_ship 仅冻结/custom 兼容边界保留 ⇒ v1 不动它,避免碰兼容面。

## 8. diff 白名单的推导

- doc-flow 契约(FLY-205):一 issue 一文件夹 `<dept>/doc/<ISSUE>-<slug>/`,dept 为 `^[a-z0-9-]+$` 目录名(`packages/config/src/ConfigLoader.ts:321-347` 校验 `doc_flow.default_department` 同一正则);progress.md 与 QA 报告都在该文件夹内(baseline 规则:"progress.md in YOUR doc folder")。
- 结论(R2 收紧):白名单 = changed path 匹配 `^[a-z0-9-]+/doc/<ISSUE>-[a-z0-9-]+/.+`,`<ISSUE>` 取自信任链(**`sessions.issue_identifier`** 列优先(`StateStore.ts:890`,schema :2384),identifier 形态的 `run.issue_id` 次之,双缺/冲突 fail-closed)。**注意**:`workflow_run.issue_id` **不是**有保证的 identifier 权威——表无 `issue_identifier` 列,`runs-route.ts:2407-2410` 存原始 issueId,UUID/identifier 混用是代码库明确现实(R2 §4)。**显式不含** repo 根 `doc/`(flywheel legacy 树,v2 QA 不应写)与一切 `.md` 扩展名规则(`lead-rules-base/*.md` 等 .md 是生产行为文件,扩展名白名单不安全)。
- 加固:`git diff --raw --no-renames -z B T`(NUL 解析防 tab/换行路径;`--no-renames` 消 rename/copy 双路径隐匿面)检查 mode —— 两侧只放行 100644/000000(可执行位 100755、symlink 120000、submodule 160000 一律拒)。git 输出的路径已相对 repo 根规范化,无 `..` 注入面。
- 威胁模型:防的是**误提交代码绕过 review**(真实事故形态),不是恶意 agent;白名单外任何路径 → 拒绝 + Lead 告警,宁可误杀回工。

## 9. push 与 PR 权威机制(R1 §1/§2 修订后口径)

- **session.branch 不是 PR 的权威 ref**:binding 记录 pr_number/repo 身份但从不存 headRefName;仓库史上有本地 phase 分支与 PR 分支不同名的真实案例(push 到错 ref"成功"但 PR 纹丝不动)。权威解析 = `gh pr view <binding.pr_number> -R <binding.probe_repo_slug> --json state,isCrossRepository,headRefName,headRefOid`(cwd=binding.target_repo_path,与 land-executor 同款只读形态)。
- **push 归 QA 侧,但形态是服务端授权握手**(R2 §1 终稿):第一发提交零变更;引擎守卫(preflight/ancestry/diff/PR 取证)全过而 PR 未在 T 时,才下发含 `{expectedHeadRefName, expectedHeadOid, prNumber, repoSlug}` 的 push 指令;CLI 先证明 `origin` 归属(共享 normalizer 归一比对 repoSlug,R3 §1)再推**被授权的精确 SHA**(绝不推 HEAD),单次额度。未通过守卫的 tip 永不被发布;引擎绝不执行外部变更(push-成功-事务-拒绝的孤儿窗口在引擎侧不存在)。引擎只做终点取证:PR headRefOid==T 才允许 DB reconcile。
- 幽灵 SHA(FLY-1667)防线因此更强:不是"push 过了"而是"GitHub 实测 PR head 就是 T"。

## 10. 幂等/并发事实

- 拒绝路径:整个事务回滚,凭据未消费 ⇒ QA 换 clientRequestId 重发即可(这也是修复上线后 FLY-1676 卡住 run 54fc46dd 的解卡方式:QA 原文重发,引擎守卫通过后走握手,无需再手术)。
- 成功路径:同 clientRequestId 重放由 admission preflight 用**存档 claim 的 subjectDigest** 重建 digest 比对后直接返回原 receipt——不读当前 HEAD(QA worktree 即使又前进,replay 语义不受影响,R2 §2)。既有 `consumed_submission_digest` 事务内识别(`StateStore.ts:27360-27393`)保持为权威。
- 并发:凭据单次消费串行化同一 QA 的提交;跨写者用 binding CAS(事务内验旧值)兜底。

## 11. 结论

方案①落地为三段式:StateStore admission preflight(fresh/exact_replay/reject,先于任何 git 读)→ 路由层只读守卫(tri-state 分流/祖先/纯文档 diff/PR 终点取证)产出 reconcile 提案或下发精确 SHA push 指令 → StateStore 事务内 CAS 应用(改 binding + 非致命投影镜像 + 审计事件)→ 原有 land 闸以 T 命中。引擎零外部变更;push 归 QA 侧且只推服务端授权的精确 SHA。无新 flag,健康路径字节等价。实施细节见 plan.md。

## 12. gen-3 机制核查(绑定移到 terminal 直接前驱完成点)

以下为第三代方向的代码级核查(worktree @ cc6b041d merge main d6536134),支撑 gen-3 plan。

### 12.1 「进 gate 的完成动作绑定」在三种既有形态下的现状

| 形态 | 进 approval gate 的动作 | binding 写入时机(现状) | gen-3 结论 |
|------|------------------------|--------------------------|-----------|
| generic/menu 单节点(execute→gate) | `complete` → `/events` → `commitEnrolledCompletion` | **同一事务**:`input.prBinding`(complete 携带的 PR 证据,`headSha` 必须 == completionSubjectDigest,`StateStore.ts:27053-27055`)→ `recordWorkflowNodePrBindingTx` → 随后 `commitWorkflowTransitionTx` 进 gate,land 闸查询命中 | **已经是 gen-3 形态,字节不动** |
| runner_ship 兼容(carrier=implement→terminal_gate) | carrier completion(needs_review) | 同上——carrier 完成 = 进 gate,绑定即发生在 gate 进入点 | **已经是 gen-3 形态,字节不动** |
| tpl_code 多节点(implement→qa→gate→land) | qa 的 `qa-result` PASS(decision 路由) | ❌ binding 在 **implement** 完成时写(qa 的进-gate 动作不带 PR 证据、不写 binding)→ qa attested head T ≠ 绑定值 → 409 | **病灶**:唯一不符合「进 gate 者绑定」的形态 |

⇒ gen-3 不是发明新机制,是把前两行的既有形态**提升为通用规则**,补齐第三行。

### 12.2 通用规则的 DAG 结构化定义(零节点名硬编码)

「绑定者」= **其 outcome 边 target == `workflowApprovalGate(manifest).node` 的那次 completion/decision**(`workflow-template.ts:800`;land 形态取 `manifest.approval_gate`,runner_ship 形态取 `terminal_gate`——两形态自动统一)。tpl_code 前驱=qa、generic=execute、prd=produce、未来模板自动成立;FAIL/kickback 边不进 gate ⇒ 天然不绑定。

### 12.3 qa_verdict 路需要补的两块(gen-2 可复用件按价值采纳)

1. **服务端 PR attestation(bind 前置取证)**:qa 不跑 `complete`,无 PR 证据随身 ⇒ 路由在 submit 前对 QA worktree 跑一次 `gh pr view --json number,state,isDraft,isCrossRepository,headRefName,headRefOid`(cwd=worktree,按当前分支解析 PR;gen-2 已验证的只读形态,`land-executor.ts` 同款)。要求 state==OPEN、!isDraft(Linear 评论:draft PR 已两次咬 land)、!isCrossRepository、`headRefOid == T`。PR 号与 PR 创建节点 session 的 `pr_number` 交叉核对(fail-loud)。
2. **`headRefOid != T` 时的授权 push 握手(= gen-2 C1,绑定时机无关,整件采纳)**:409 `land_head_pr_not_at_tip` 附 `{expectedHeadOid: T, expectedHeadRefName, prNumber, repoSlug}`;CLI 按修正案 C1 的凭据链(真 HOME 单次 `gh auth git-credential get` + cleanEnv push + 一次性内存 credential helper + 严格 push-endpoint 解析器)push **被授权的精确 SHA**,换 clientRequestId 重发一次。C2(marker 先于 eager abort)与 C3 的 family 限定语义同为时机无关件,采纳。

### 12.4 净删除清单(gen-3 落地时从分支/生产拆除)

- `packages/teamlead/src/bridge/land-head-reconcile.ts`(449 行)+ 两个 reconcile 测试文件 + routes 里 reconcile 分支接线;
- StateStore 的 reconcile CAS 应用机器(gen-2 新增段);
- diff 白名单(形A/形B 正则、mode 守卫、ancestry 证明)整族——**对比机器失去存在理由**;
- `commitEnrolledCompletion` 对**非进-gate** completion 的 binding 写入(implement 在多节点 land DAG 中不再冻结 head;`sessions.pr_number/pr_head_sha` 镜像保留——display/交叉核对用途,非权威);
- gen-2 修正案 C4(白名单闭集)随对比机器一并消亡——它修的对象不存在了。

### 12.5 保留清单(红线逐条)

- `commitWorkflowTransitionTx` land 闸(`StateStore.ts:28069-28079`)**一行不改**:qa_verdict 路的 binding 在同一 submit 事务内、transition 之前写入(与 generic 形态 L27053→L27136 的既有次序同构),闸查询自然命中——闸从「拒收器」变回「不变量断言」,语义零松动;
- land executor 全部等值检查 + merge 探针 GitHub 全等(`land-executor.ts:146-176,329,395`)不动;
- attest 语义(`resolveWorkflowHeadAuthority`,服务端 rev-parse,客户端永不提权)不动;
- `recordWorkflowNodePrBindingTx` 的冻结/幂等/session 镜像语义不动(只是调用时机与调用者变了);
- fail-loud:所有拒绝带精确 reason(gen-2 错误 taxonomy 中与对比机器无关的部分沿用:`land_head_pr_not_at_tip/closed/merged/cross_repo` + 新增 `land_head_pr_draft`)。

### 12.6 存量与恢复

部署后无需任何数据手术:in-flight run 的旧 implement binding 行(head=commit1)留在表里;qa PASS 重交 → 新行 (qa 节点, attempt, head=T) 写入;`resolveCurrentWorkflowNodePrBindingForHead` 按 head 查 T 唯一命中 qa 行(implement 行 head≠T,无 "many" 碰撞);land executor 按 holder head=T 命中同一行,pr_number 一致。FLY-1676(54fc46dd)的 PASS 判决 durable 在 marker,原样重交即通。
