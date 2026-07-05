# FLY-827 Codex code review 硬门 — 实施计划

Issue: FLY-827 (https://linear.app/geoforge3d/issue/FLY-827/infrap1hard-gate-codex-code-review-必须是硬门-任何-pr-没过-codex-approved-就卡住)
日期: 2026-07-03
基于: research.md, exploration.md
Status: Codex design review round 1 findings 全部并入(见 §8 变更记录)

## 0. 目标(一句话)

让 Codex code review 成为 Bridge 强制的硬门:任何 **Flywheel runner-controlled ship** 的 PR,没有一条**匹配当前 head SHA 且经 Codex 审过该 head 的 APPROVED 权威记录**,就 (a) auto-QA 起不来、(b) merge 被 verify-approval 拦、(c) founder 保持挂起 + Flywheel Alerts 告警 + 重发「去跑 Codex」指令给 runner。默认 ON,`FLYWHEEL_CODEX_HARD_GATE=0` **live-toggle** 紧急放行。

**范围边界(HIGH-5)**:硬门覆盖 Flywheel 自动 ship 路径(auto-QA + verify-approval + :cool: deploy)。`pr_handoff`(no-transport runner → founder 手动 ship)不走 verify-approval,**本 PR 出范围**,但在 handoff 面上**带 codex 状态警示**(见 Step 9)不让它成静默洞。GitHub branch-protection status-check = 未来互补层(非本 PR)。

## 1. Lead 批准要点(brainstorm gate,已 APPROVED)

- 默认 ON + `FLYWHEEL_CODEX_HARD_GATE=0` kill-switch(命门、要可靠 → 进 feature-flag registry 做 live direct-toggle)。
- 只做 code review 门(design review 现状不变)。
- await-codex-gate 发事件(不新增 runner 必记命令);**runner 没跑 Codex → fail-closed 卡住 + 告警 + 重发指令**(闭环)。
- 补洞 = 运营(非本 PR);#802/#807 已核实过了、#430 已让 793 跑。
- **两条硬要求(必进 QA)**:① 独立 QA 造新 PR 证三件事 —— (a) 无 Codex 的 PR 被卡、(b) 有 Codex approved 的 PR 不误卡、(c) kill-switch 一开立即放行;② restart-gated + 全域 → pre-ship 必须在 **529 QA Room 真机**验过再 ship。

## 2. 设计总览

```
runner: PR created ──stage set pr_created──▶ Bridge handleCodexAutoTrigger
                                              ├─ (若 session 已有 head) 登记 codex_review_record=pending / skipped(审计友好,非 gate 真相)
                                              └─ CommDB 指令: /codex-code-review(写含 reviewedHeadSha 的 JSON)+ await-codex-gate code
runner: /codex-code-review ─APPROVED→ 写本地 code-review.json {..., reviewedHeadSha:<审过的 commit>}
runner: await-codex-gate code ─校验 result.reviewedHeadSha === git HEAD(本地两者一致)→ 发 codex_review_result{prHeadSha=reviewedHeadSha} ─▶ Bridge onCodexReviewResult
                                              └─ recordCodexReviewApproved(exec, head)  [insert-or-approve]
                                                 若 parent 已 awaiting_review 且此刻 codex 满足 → 重驱动 onMainAwaitingReview(codexReleased 强制首 spawn)
runner: complete --route needs_review ─▶ awaiting_review
Bridge onMainAwaitingReview:
   isCodexGateSatisfied(store,session,head,env)? ── 否 ─▶ codex-hold: 发 thread + 重发指令 + 限频告警; 不 spawn QA (founder 挂起)
                                                  └─ 是 ─▶ (现有) policy → claim + spawn QA
Bridge founder 挂起: isReviewHeld = !isCodexGateSatisfied(...) OR isQaHeld  (4 处压制点: event-route/gate-poller/HeartbeatService/DirectEventSink)
Bridge restart / default-ON 翻转: reconcileCodexHolds() 扫 active awaiting_review main → 缺 codex → 幂等 codex-hold effect(补告警/重发)
runner ship: verify-approval ── codex approved(匹配 head) / skipped / gate-off? 否 ─▶ approved:false reason=codex_review_not_approved
```

**核心谓词 `isCodexGateSatisfied(store, session, sha, env)`(MED-7,集中,防三处漂移)**:
`hardGateOff(env)` → true;`session.codex_skip` → true;record(exec,sha).status ∈ {approved, skipped} → true;否则 false。sha 一律 lower-case。verify-approval 在 flywheel-comm 包不能 import Bridge helper,**镜像同款 query/条件**(读同一 teamlead.db)。

## 3. 实施步骤(TDD,RED→GREEN,顺序)

### Step 1 — StateStore: `codex_review_record` 表 + 方法(HIGH-1)
**文件**: `packages/teamlead/src/StateStore.ts`
- 建表(initSchema,镜像 auto_qa_record `:1242`):列 = `execution_id, target_pr_head_sha, issue_id, project_name, status('pending'|'approved'|'skipped', default 'pending'), reviewed_target, codex_thread_id, rounds, verdict_event_id, created_at, approved_at`;PK `(execution_id, target_pr_head_sha)` + `CREATE INDEX idx_codex_review_status`。
- 方法:
  - **`recordCodexReviewApproved({executionId, targetPrHeadSha, verdictEventId, reviewedTarget?, codexThreadId?, rounds?})`** — **insert-or-approve(HIGH-1)**:`INSERT ... ON CONFLICT(execution_id,target_pr_head_sha) DO UPDATE SET status='approved', approved_at=COALESCE(approved_at, now), verdict_event_id=COALESCE(verdict_event_id, excluded.verdict_event_id), reviewed_target=COALESCE(reviewed_target, excluded.reviewed_target), ... WHERE status != 'skipped'`。无 row → 直接 INSERT approved(需要 issue_id/project_name → 从 session 取,handler 传入)。已 approved → **幂等且保留原审计字段(COALESCE,R2-LOW-4:重放的 approved event 不 restamp approved_at / 不覆盖 verdict_event_id)**。skipped → 不覆盖(gate 已满足)。返回是否现在满足。
  - `markCodexReviewSkipped({executionId, targetPrHeadSha, issueId, projectName})` — upsert status='skipped'(pr_created + codex_skip 时,有 head 才写;无 head 靠 session.codex_skip 兜)。
  - `upsertCodexReviewPending({executionId, targetPrHeadSha, issueId, projectName})` — `INSERT ... ON CONFLICT DO NOTHING`(仅审计友好;不存在也不影响 gate)。
  - `getCodexReviewRecord(executionId, targetPrHeadSha)` / `listCodexReviewRecordsByStatus(status)`。
  - `isCodexCodeReviewApproved(executionId, sha)` → record.status ∈ {approved,skipped}(lower-case sha)。
**测试**(`StateStore.test.ts`): **无 pending row + recordApproved → isCodexCodeReviewApproved true**(HIGH-1);pending→approved;approved 幂等;skipped 不被 approved 覆盖;pending 不覆盖已 approved;大小写归一。

### Step 2 — code-review result 绑 reviewed head + await-codex-gate 上报(HIGH-2)
**文件**: 新 `packages/flywheel-comm/src/commands/codex-review-result.ts`;改 `await-codex-gate.ts` / `index.ts`;改 `event-route.ts::buildCodexInstruction`(schema 文案)。
- **result schema 加 `reviewedHeadSha`**(HIGH-2):`buildCodexInstruction`(reviewType=code)要求 runner 在写 code-review.json 时,把「Codex 审过的那个 commit」= `git rev-parse HEAD`(review 当时)写进 `reviewedHeadSha`。design review schema **不变**。
- `await-codex-gate.ts`:
  - `validateResult`(仅 reviewType=code):新增校验 `reviewedHeadSha` 是 40-hex,且 **`reviewedHeadSha === 当前 git rev-parse HEAD`**(本地两者一致 → 证明 result 审的就是当前 head)。缺失/不一致 → **fatal(fail-closed,exit1)**;runner 必须重跑 Codex。design review 不校验 head(旧 schema)。
  - 成功路径(code,exit0 前):best-effort 调 `emitCodexReviewResult({reviewType:'code', status:'APPROVED', prHeadSha=reviewedHeadSha, reviewedTarget, rounds, codexThreadId, execId})`。env(BRIDGE_URL/ISSUE_ID/PROJECT_NAME/EXEC_ID)缺失 → log warn 但仍 exit0(不破坏本地门;Bridge fail-closed 兜)。
  - skip 分支(codex-skip-bypass)不上报(Bridge 已在 pr_created 认 session.codex_skip)。
- 新命令(镜像 `qa-result.ts`):`buildCodexReviewResultBody(...)` 纯函数 + `emitCodexReviewResult(opts)` retry(4/backoff 1,2,4s)+ fail-close marker(`~/.flywheel/state/codex-review-result-failed/<exec>.json`)。event_type `codex_review_result`,payload `{reviewType, status, prHeadSha, reviewedTarget, rounds, codexThreadId, targetExecutionId=execId}`。
- `index.ts` 注册 `case "codex-review-result"`(手动/未来用;await-codex-gate 内部直接调函数不 shell)。
**测试**: `codex-review-result.test.ts`(body/retry/marker);`await-codex-gate.test.ts` 加:**旧 result head A + worktree HEAD B → gate fatal exit1、不上报**(HIGH-2);code valid + head 一致 → 触发上报(mock fetch);env 缺失 → 仍 exit0 不 throw;design/skip 不上报。

### Step 3 — Bridge: `onCodexReviewResult` + re-drive(HIGH-3)
**文件**: `auto-qa-coordinator.ts`;`event-route.ts`。
- coordinator 加 `onCodexReviewResult(event)`:校验(status==="APPROVED"、reviewType==="code"、prHeadSha 40-hex、event.execution_id 是已知 main session)→ `recordCodexReviewApproved(exec, sha, verdictEventId=event.event_id, ...,issueId/projectName from session)`。然后若 `parent.status==="awaiting_review"` 且 `parent.pr_head_sha(lower)==sha` → 重驱动 QA spawn。
- **re-drive 语义(HIGH-3)**:不能用 `onMainAwaitingReview(...,{freshTransition:false})`(无 owner + false → 直接 return,跳过首 spawn)。改:`onMainAwaitingReview(parent, {codexReleased:true})`。`onMainAwaitingReview` 内:codexReleased 时,即便 `freshTransition` 缺省/false,也允许「当前 head 有 approved/skipped codex record **且**无 QA owner record」→ 走首个 claim+spawn。（等价于「Codex 刚放行 → 视作一次合法的 fresh review-pass」。）
- `event-route.ts:621` 后加分支:`event.event_type === "codex_review_result"` → `autoQaCoordinator.current?.onCodexReviewResult(event)`,早返回(try/catch,mirror qa_result:632)。
**测试**: `auto-qa-coordinator.test.ts` — onCodexReviewResult 记 approved;非 APPROVED/非 code/bad sha/未知 exec 拒;**complete 先到被 codex hold(无 QA owner)→ codex_review_result 到 → claim QA record + spawn QA**(HIGH-3);approved 但 parent 非 awaiting_review → 只记录不 spawn。`event-route` 路由测试。

### Step 4 — auto-QA spawn gate(codex 前置)+ codex-hold effect(HIGH-3 ordering)
**文件**: `auto-qa-coordinator.ts`;`event-route.ts`(抽 `queueCodexCodeReviewInstruction`);`auto-qa-effects.ts`(告警 + 重发);`codex-gate.ts`(新 helper)。
- `onMainAwaitingReview`(`:233`)顺序:main 判断 → sha 有效性(FAIL-CLOSED,现有 `:252`)→ **codex gate**(新)→ policy(现有)→ owner/claim/spawn/retest(现有)。**codex gate 放在 policy 之前**:即便 QA policy 关(no-qa/FLYWHEEL_AUTO_QA=0),codex 未过也 hold+告警(codex 全队通用,独立于 QA);codex 过 + QA 关 → 继续走 policy-disabled 早返回(founder surface,无 QA)。
  ```
  if (!isCodexGateSatisfied(store, session, sha, env)) {
     await effects.postThread({session, text:"⛔ Codex code review 未通过(head <sha8>)— QA 不启动,已重发 review 指令。founder 保持挂起。"});
     effects.queueCodexInstruction({session});                 // 重发 /codex-code-review 指令(D3 闭环)
     await effects.alertCodexGateBlocked({session, sha});      // 限频:每(exec,head)一次
     return;
  }
  ```
- `queueCodexCodeReviewInstruction(projectName, execId)`:从 `handleCodexAutoTrigger` 抽出 code-review 指令 CommDB 写逻辑(纯函数,复用于 pr_created + 重发 + reconcile)。effect `queueCodexInstruction` 包一层。
- `alertCodexGateBlocked`(auto-qa-effects,mirror `alertLeadPipelineError:266`):eventType `codex_gate_blocked`,eventId `codex-gate:<exec>:<sha>`(每 head 一次,防刷屏),severity warning。
**测试**: `auto-qa-coordinator.test.ts` — codex 未过 → 不 claim/不 spawn + thread + queueInstruction + alert;codex 过 → 正常 spawn;**QA policy off + codex 未过 → 仍 hold+alert**;QA off + codex 过 → 早返回不 spawn;gate-off(kill-switch)→ 跳过 codex 直走 policy。

### Step 4b — auto-QA 跳过 QA issue 自身(Lead follow-up,防 QA-of-QA #828)
**文件**: `StateStore.ts`(`isQaIssue`);`auto-qa-coordinator.ts`(`onMainAwaitingReview` 前置守卫)。
- `session_role !== "main"` 守的是 auto-QA spawn 的 QA runner;但**普通(main-role)runner 被重派到 `QA·FLY-XX` issue** 上时,`onMainAwaitingReview` 会在该 QA issue 上再 spawn auto-QA → QA-of-QA(824→828 的洞)。
- `store.isQaIssue(issueId)`:结构化判定 `SELECT 1 FROM auto_qa_record WHERE qa_issue_id = ?`(只对本 Bridge 经 FLY-643 真正建过的 QA issue 返 true,不靠标题模式)。
- `onMainAwaitingReview` 在 main-role 检查后立即:`if (store.isQaIssue(session.issue_id)) return`。
**测试**:普通 runner 在 QA issue(issue_id 匹配某 auto_qa_record.qa_issue_id)→ 不 spawn、不 claim record。

### Step 5 — founder 挂起谓词 `isReviewHeld`(HIGH-4 消费点)
**文件**: `auto-qa-held.ts`;`event-route.ts:1903`;`gate-poller.ts:394`;`HeartbeatService.ts:298`;**`DirectEventSink.ts`(R4-HIGH-1,第 4 个 founder-surface path)**。
- `isReviewHeld(store, session, env?)`:非 main/非 awaiting_review → false;**missing/invalid sha(R2-MED-3)**:若 `hardGateEnabled(env) && !session.codex_skip` → **true**(hard gate on 时,一个 awaiting_review 但没有可绑 head 的 main session 无法过 codex → 必须 hold founder,不能 surface 一个不可 merge 的 review),否则(gate-off / codex_skip)→ false(byte-compat 回退 isQaHeld 的无-sha 行为);有 sha → `!isCodexGateSatisfied(store,session,sha,env)` → **true**,否则 `isQaHeld(store, session)`。
- missing-sha 的 codex-hold effect 用「missing PR head binding;请带 headSha/questionId 重跑 complete」文案(不假装能跑 head-specific review)。
- **4 处** `isQaHeld(...)` → `isReviewHeld(...)`:`event-route.ts:1903`(always-deliver)、`gate-poller.ts:394`(approve gate relay/fallback)、`HeartbeatService.ts:298`(gate_timed_out)、**`DirectEventSink.ts` ~610(emitCompleted 的 review-required pushNotification 决策,R4-HIGH-1)** —— DirectEventSink.emitCompleted 在 `:586-607` 调 onMainAwaitingReview 后,`:610-620` 用 isQaHeld 决定是否 push;codex 未过时无 auto_qa_record → isQaHeld=false → 会 push 泄漏 founder,故必须换 isReviewHeld(同款 hard-gate env 语义)。保留 `isQaHeld`(coordinator 内部 QA 判定用)。`AutoQaHeldStore` 接口加 `isCodexCodeReviewApproved` + `getSession`(fake 便利)。
**测试**(`auto-qa-held.test.ts` / 新 `review-held.test.ts`)— codex 未过→held;codex 过+QA 未过→held;都过→released;gate-off→回退 isQaHeld;session.codex_skip→released;**missing sha + hard gate on + 非 codex_skip → held(R2-MED-3);missing sha + gate-off → false(byte-compat)**;非 awaiting_review→false。**DirectEventSink 测试(R4-HIGH-1)**:codex 未过 + hard gate on → emitCompleted 不 pushNotification(founder 不 surface);gate-off → 放行;codex 过 → 落到正常 QA-held 行为。

### Step 6 — merge gate: verify-approval 加 codex 检查(MED-7 镜像)
**文件**: `packages/flywheel-comm/src/commands/verify-approval.ts` / `index.ts`。
- reason 枚举加 `"codex_review_not_approved"`。sessions SELECT 加读 `codex_skip`。
- head SHA 匹配成功后(`:251` 之后、return approved 前):`if (hardGateOn(effectiveEnv) && !session.codex_skip) { SELECT 1 FROM codex_review_record WHERE execution_id=? AND lower(target_pr_head_sha)=? AND status IN('approved','skipped'); 无 → return notApproved("codex_review_not_approved",...) }`。复用已开的 better-sqlite3 statePath readonly 连接。查失败 → fail-closed not approved。
- **kill-switch live 于 runner CLI 双向(R2-HIGH-1 + R3-HIGH-1,命门核心)**:verify-approval 跑在 **runner CLI 进程**,只读 spawn 时 inherited `process.env`,**不会**自动看到 Bridge live mutation。→ `hardGateOn` 必须 **call-time 读权威的 `~/.flywheel/.env`**。**关键(R3-HIGH-1,re-arm 方向)**:flag-route 把 default-on flag 切回 ON = **删除 .env 行**(非写 `=1`),所以「.env 里 key 缺失」= default-on = ON。若 key 缺失时 fallback 到 runner inherited env,一个 spawn 时继承了 `=0` 的 runner 在 re-arm 后仍会读旧 `0` → 仍 bypass(re-arm 失效)。正确优先级:
  1. `args.env` 显式带 key(测试注入)→ 用它。
  2. 否则 **`~/.flywheel/.env` 可读** → `readEnvValue(content, "FLYWHEEL_CODEX_HARD_GATE")`;结果 = `value !== "0"`(**key 缺失 = default-on = ON,不 fallback 到 inherited**)。→ OFF(`.env` 有 `=0`)与 ON(`.env` 无 key)**双向 live**。
  3. 否则(`.env` 不可读/不存在,legacy)→ inherited `process.env`(缺失 = default-on)。
- 复用现成 .env reader(flag-toggle 写的同一路径/解析);无则最小单键解析。
**测试**: `verify-approval.test.ts` — founder+codex approved(匹配 head)→ approved;founder approved + 无 codex → codex_review_not_approved;codex approved 但 head 不匹配 → codex_review_not_approved;skipped → approved;session.codex_skip → approved(无 record);**gate-off(inherited env,无 .env)→ 跳过 codex 仍 approved(byte-compat sentinel)**;**OFF live**:inherited 无/旧 flag + `.env` 有 `=0` → 跳过 codex(无需重启);**ON re-arm live(R3-HIGH-1)**:inherited 旧 `=0` + `.env` 可读且 key 缺失 → **codex 强制执行**(不被旧继承值 bypass);**legacy**:`.env` 不可读 + inherited `0` → 跳过(fallback)。

### Step 7 — pr_created 登记 + codex_skip 一致性
**文件**: `event-route.ts::handleCodexAutoTrigger`。
- reviewType=code:若 session 已有 pr_head_sha(通常没有,见 research §2)→ `upsertCodexReviewPending`(审计);codex_skip 且有 head → `markCodexReviewSkipped`。**pending/skipped record 非 gate 必要条件** —— gate 真相 = `isCodexGateSatisfied`(认 session.codex_skip + approved/skipped record)。这样避开 head 时序坑(HIGH-1 已让 approved 不依赖 pending)。
- codex_skip 的 session 全程放行由 `isCodexGateSatisfied` 的 `session.codex_skip` 分支保证(onMainAwaitingReview / isReviewHeld / verify-approval 三处都认),不依赖 record。
**测试**: `event-route.codex-trigger.test.ts` 加:pr_created + session 有 head → pending 登记;codex_skip + 有 head → skipped 记录;codex_skip 无 head → 后续 gate 仍放行(isCodexGateSatisfied 认 flag)。

### Step 8 — kill-switch: feature-flag registry direct-toggle + 集中 helper(MED-6, MED-7)
**文件**: `packages/config/src/feature-flags/registry.ts`;新 `packages/teamlead/src/bridge/codex-gate.ts`;flywheel-comm 侧内联。
- **registry(MED-6 + R3-MED-2)**:加 `FLYWHEEL_CODEX_HARD_GATE` 为 `kill_switch`、`toggleable:"direct"`、default-on(`!== "0"`)。`readSites` **只列 Bridge 侧 call_time 读点**(`codex-gate.ts` / `auto-qa-held.ts` 经 helper)—— 这样满足 `isDirectToggleable`(要求每个 readSite 都是 call_time)。verify-approval 是 **runner CLI 侧、每次 invocation 重读 `~/.flywheel/.env`** 的独立机制(见 Step 6),**不列为 registry call_time readSite**(避免 `cli_invocation` 触发 direct-toggle guard 拒绝,也避免假装它是普通 call_time 读)。`directToggleProof` 引用**两个** live-observe 证据:Bridge 侧 registry direct-toggle test **和** CLI 侧 `.env` 双向 live-toggle test(Step 6)。这样 flag-route apply(持久化 .env + mutate Bridge process.env)= Bridge live;CLI 侧靠每次 invocation 重读 .env = runner live(命门可靠,Lead 硬要求 c)。
- **helper(MED-7)**:`packages/teamlead/src/bridge/codex-gate.ts`:`hardGateEnabled(env)=env.FLYWHEEL_CODEX_HARD_GATE!=="0"`;`isCodexGateSatisfied(store, session, sha, env)`(见 §2)。verify-approval(flywheel-comm,不 import Bridge)内联同款 query,但 `hardGateEnabled` 用 **call-time `.env` 读取版**(R2-HIGH-1,见 Step 6):Bridge 侧读 live-mutated process.env(flag apply 就地改了);runner CLI 侧读 `~/.flywheel/.env`。两处的「default-on + `=0` 关」语义必须一致,注释互指。
**测试**: `resolve.direct-toggle.test`(registry live-observe:改 .env → process.env 立即变 → Bridge gate 立即放行);verify-approval CLI live-toggle test(见 Step 6);helper 单测(gate-off/codex_skip/approved/skipped/none 矩阵)。

### Step 9 — restart / default-ON codex-hold reconcile(HIGH-4)+ pr_handoff 状态警示(HIGH-5)+ 接线
**文件**: `auto-qa-coordinator.ts`(reconcile);`plugin.ts`(接线);`Blueprint.ts`(pr_handoff 文案);`buildCodexInstruction`(schema)。
- **reconcileCodexHolds()(HIGH-4)**:扫 `store.getActiveSessions()` 里 `status==='awaiting_review'` 的 main session:`hardGateEnabled && !session.codex_skip && sha 有效 && !isCodexCodeReviewApproved(exec,sha) && 无对应 running auto_qa_record` → 执行**幂等** codex-hold effect(postThread/queueInstruction/alertCodexGateBlocked;alert 的 eventId=`codex-gate:<exec>:<sha>` 天然去重,thread/queue 用 marker 或 dedupe 防重启刷屏)。
- **missing-head 分支(R3-LOW-3)**:reconcile 也扫 `hardGateEnabled && !session.codex_skip && sha 缺失/无效` 的 awaiting_review main → deduped alert `codex-gate-missing-head:<exec>` + 「请带有效 headSha/questionId 重跑 complete」提示(**不**发普通 head-specific review 指令,因为没 head 可审)。否则重启后 missing-head session 只被 isReviewHeld 静默 suppress、不再重发 actionable 提示。
- **启动顺序(R2-HIGH-2,修正)**:**founder-hold 本身不依赖 reconcile 时序** —— 与现有 auto-QA 一致(plugin.ts:3607-3611 的设计理由):durable `codex_review_record` + `isReviewHeld` 直接查表,重启后 GatePoller/Heartbeat/event-route 一旦评估就 hold(缺 approved record = held),**即使 timer 先于 reconcile 起也安全**。因此 `reconcileCodexHolds()` **不需要 reorder 到 timer 之前**,与现有 `reconcileOnStartup()` 并列(在 coordinator 构造后、`plugin.ts:3656` 附近)运行即可 —— 它只补 **side-effects**(重启后重新告警 + 重发指令),hold 由 durable 表兜。plan §5 QA-5 因此验的是「重启后 reconcile 补告警/重发」+「hold 立即生效(查表)」两点。
- **pr_handoff(HIGH-5)**:`Blueprint.ts` pr_handoff finish 文案 + DecisionLayer/handoff surface 增加一行「Codex code review 状态(当前 head:过/未过)」提示,让 founder 手动 ship 前知情。**不硬 block**(手动动作无法本地 block);硬 block 留 GitHub branch-protection 未来层。
- **接线**:coordinator 构造(`plugin.ts:3641`)注入 `queueCodexInstruction`/`alertCodexGateBlocked` effect + env;`reconcileCodexHolds` 在启动调。CLAUDE.md 里程碑行(ship 时)。

## 4. 文件清单(预估)

| 文件 | 改动 |
|---|---|
| `teamlead/src/StateStore.ts` | +codex_review_record 表 + recordCodexReviewApproved(insert-or-approve)/markSkipped/upsertPending/get/list/isApproved |
| `teamlead/src/bridge/codex-gate.ts` | 新:hardGateEnabled + isCodexGateSatisfied(集中谓词) |
| `teamlead/src/bridge/auto-qa-coordinator.ts` | +onCodexReviewResult;onMainAwaitingReview 加 codex 前置 gate + codexReleased override;+reconcileCodexHolds |
| `teamlead/src/bridge/auto-qa-effects.ts` | +alertCodexGateBlocked +queueCodexInstruction |
| `teamlead/src/bridge/auto-qa-held.ts` | +isReviewHeld(用 isCodexGateSatisfied) |
| `teamlead/src/bridge/event-route.ts` | +codex_review_result 路由;handleCodexAutoTrigger pending/skipped + 抽 queueCodexCodeReviewInstruction;buildCodexInstruction schema 加 reviewedHeadSha;isQaHeld→isReviewHeld |
| `teamlead/src/bridge/gate-poller.ts` / `HeartbeatService.ts` / `DirectEventSink.ts` | isQaHeld→isReviewHeld(DirectEventSink=R4 第 4 surface path) |
| `teamlead/src/bridge/plugin.ts` | effects 接线 + reconcileCodexHolds 启动调用 |
| `edge-worker/src/Blueprint.ts` | pr_handoff finish 文案加 codex 状态提示 |
| `config/src/feature-flags/registry.ts` | +FLYWHEEL_CODEX_HARD_GATE direct kill-switch |
| `flywheel-comm/src/commands/codex-review-result.ts` | 新命令 + emit |
| `flywheel-comm/src/commands/await-codex-gate.ts` | code 校验 reviewedHeadSha===HEAD + 成功后上报 |
| `flywheel-comm/src/commands/verify-approval.ts` | +codex_review_not_approved + 读 codex_skip + hardGate |
| `flywheel-comm/src/index.ts` | 注册 codex-review-result |
| 各 `__tests__/` | 见每步测试 |
| `engineering/doc/FLY-827-codex-hard-gate/` | 本套文档(随 PR merge) |

## 5. 验证(QA scope,Lead 硬要求)

**单测**:每步 __tests__ 全绿 + `pnpm -w test` 无回归。含 byte-compat sentinel(gate-off 时 verify-approval/onMainAwaitingReview/isReviewHeld 逐字回退)。

**独立 QA(造新 PR,529 QA Room 真机)必证**:
1. **(a) 无 Codex 的 PR 被卡**:新 PR,runner 不跑 codex → awaiting_review → QA 不 spawn + founder 挂起(不 surface)+ Flywheel Alerts codex_gate_blocked + runner inbox 收重发指令;verify-approval → `codex_review_not_approved`。
2. **(b) 有 Codex approved 不误卡**:跑通 codex(reviewedHeadSha===HEAD)→ 上报 → record approved → QA 正常 spawn → verify-approval codex 分支通过。
3. **(c) kill-switch 一开立即放行**:flag-route toggle `FLYWHEEL_CODEX_HARD_GATE=0`(不重启)→ 无 codex 的 PR 也放行,verify-approval 不拒。
4. **head 变**:codex approved head A → push head B → onMainAwaitingReview/verify-approval 对 B fail-closed;旧 code-review.json(head A)+ HEAD B → await-codex-gate fatal 不误上报(HIGH-2)。
5. **restart**:awaiting_review 缺 codex 的 session,Bridge 重启后 reconcileCodexHolds 补 hold+告警+重发(HIGH-4)。

## 6. 风险 & 缓解

- **默认 ON 卡全 fleet**:kill-switch 进 registry 做 live direct-toggle(命门可靠,MED-6);pre-ship 529 真机验;fail-closed 只挡 ship 绝不误 merge。
- **旧 code-review.json 误批新 head(HIGH-2)**:reviewedHeadSha===HEAD 本地一致校验,不一致 fatal。
- **无 pending 时 approved 落不了库(HIGH-1)**:recordCodexReviewApproved insert-or-approve。
- **complete 先到跳首 QA(HIGH-3)**:codexReleased override 强制首 spawn。
- **restart 只 suppress 不告警(HIGH-4)**:reconcileCodexHolds sweep。
- **三处 gate 漂移(MED-7)**:isCodexGateSatisfied 集中(verify-approval 镜像)。
- **pr_handoff 静默(HIGH-5)**:本 PR 出范围但 handoff 面带状态警示;branch-protection 未来层。

## 7. 出范围(确认)

- design review 门:现状不变(await-codex-gate design,implement 前门)。
- 补今天的洞(#430 重跑 Codex、#802/#807 核实)= 运营(Lead 已核实 #802/#807 都过、#430 让 793 跑)。
- pr_handoff / manual GitHub merge 硬 block:本 PR 出范围(带状态警示)。GitHub branch-protection status-check = 未来互补层。
- 防恶意 runner 伪造 verdict:出范围(同 verify-approval/qa-result「可信本地进程」威胁模型)。

## 8. Codex design review 变更记录

Round 1(xhigh)CHANGES REQUESTED,全部并入:
- HIGH-1 → Step 1 recordCodexReviewApproved insert-or-approve(不依赖 pending)。
- HIGH-2 → Step 2 code result 加 reviewedHeadSha + await-codex-gate 校验 ===HEAD。
- HIGH-3 → Step 3 codexReleased override(不用 freshTransition:false)。
- HIGH-4 → Step 9 reconcileCodexHolds sweep。
- HIGH-5 → 范围收敛(§0/§7)+ pr_handoff 状态警示。
- MED-6 → Step 8 registry direct kill-switch。
- MED-7 → §2/Step 8 isCodexGateSatisfied 集中 helper。
- MED-8 → Step 4 fix-loop 新 head blocker test。

Round 2(xhigh)CHANGES REQUESTED,全部并入:
- R2-HIGH-1(verify-approval 在 runner CLI 进程读 inherited env,Bridge live-toggle 后已跑 runner 仍拒)→ Step 6/8 verify-approval call-time 读 `~/.flywheel/.env` 权威 flag + live-toggle test。
- R2-HIGH-2(reconcileCodexHolds 顺序 vs 实际 boot 顺序)→ Step 9 修正:hold 由 durable 表 + isReviewHeld 保证(时序无关,同 auto-QA plugin.ts:3607-3611),reconcile 只补 side-effects、不需 reorder。
- R2-MED-3(missing sha 时 founder 仍被 surface)→ Step 5 isReviewHeld 在 hard-gate on + 非 codex_skip 时对 missing-sha 也 hold(gate-off 回退)。
- R2-LOW-4(approved 幂等审计字段)→ Step 1 COALESCE approved_at / verdict_event_id。

Round 3(xhigh)CHANGES REQUESTED,全部并入(核心设计 Codex 已认可 sound):
- R3-HIGH-1(kill-switch re-arm 单向:OFF live 但 ON 不 live,已跑 runner 继承旧 `=0` 在 flag 删行 re-arm 后仍 bypass)→ Step 6 优先级修正:`.env` 可读时以它为准(含 key 缺失=default-on ON),不 fallback 继承 env;双向 live-toggle test。
- R3-MED-2(registry cli_invocation vs call_time + isDirectToggleable 语义)→ Step 8:readSites 只列 Bridge call_time 点,verify-approval 作 CLI-侧 .env-reread 独立机制、不列 readSite,directToggleProof 引双证。
- R3-LOW-3(reconcile 不覆盖 missing-head hold)→ Step 9 加 missing-head 分支 deduped alert。

Round 4(xhigh)CHANGES REQUESTED,并入(R3 修法 Codex 确认全 sound,含 .env parse-fail-closed-to-ON):
- R4-HIGH-1(DirectEventSink 是第 4 个 founder-surface path,漏接 isReviewHeld)→ Step 5 + 文件清单加 `DirectEventSink.ts`,emitCompleted 的 pushNotification 决策 isQaHeld→isReviewHeld + DirectEventSink held test。
