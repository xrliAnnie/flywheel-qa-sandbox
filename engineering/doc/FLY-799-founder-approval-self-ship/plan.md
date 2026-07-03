# FLY-799 Ship 流程重构:founder 批准归属 founder + runner 自 ship + fan-out 收尾 — 实施计划

Issue: FLY-799 (https://linear.app/geoforge3d/issue/FLY-799/infrafounder-facingp1-ship-流程重构founder-discord-批准-归属-founder-runner-自)
日期: 2026-07-02
基于: exploration.md, research.md

> **plan-first**:本 plan 走 Codex design review → present Annie。§7 的大方向问题必须 Annie
> 拍板后才 implement。**不自 ship、不代 merge。**

---

## 1. 目标 & 非目标

**目标**:founder 在 [FLY-XX] thread 的**明确批准**(身份验证=她本人 Discord)被**自动、归属
她本人**地写进 `approve_to_ship` gate → `verify-approval` 翻 true → runner 走它**现成的**自
ship → 触发**顺关系图的 fan-out 收尾**(shipped runner + QA + [v2] sub-issue 全清)。Lead 只
relay,不代 merge。

**非目标**:① 不实现 FLY-795 durable-state 地基(只标依赖、留接口);② 不建 FLY-793 的 sub-
issue 三段式结构(fan-out v2 接口留好、遍历随 793);③ 不改 verify-approval 的 4-源校验(复用)。

## 2. 架构:现状 vs 目标

```mermaid
graph TD
    subgraph NOW["现状(断)"]
        A1[founder thread 打字 'ship 756'] --> A2[founder-reply-deliverer<br/>身份验证 OK]
        A2 -.只 WAKE、不写 gate.-> A3[runner 醒]
        A3 --> A4[verify-approval = false<br/>gate_not_answered]
        A4 -.卡 awaiting_review.-> A5[Lead 外部 gh pr merge]
        A5 -.没 session_completed.-> A6[收尾从不跑 ❌]
    end
    subgraph TARGET["目标(通)"]
        B1[founder thread 批准 / reaction] --> B2[founder-reply-deliverer<br/>身份验证 + 批准意图判定]
        B2 -->|明确批准| B3[写 approved:true<br/>归属 founder + onResponseWritten]
        B3 --> B4[awaiting_review→approved_to_ship<br/>+ 唤醒 runner]
        B4 --> B5[verify-approval = true]
        B5 --> B6[runner 自 ship :cool: → merged]
        B6 --> B7[fan-out finalization<br/>顺关系图全清 ✅]
        B2 -->|含糊/reject/非本人| B8[WAKE-only + relay Lead<br/>不 ship]
    end
```

## 3. 设计(三部分)

### Part A — founder-approval-relay + gate-flip(核心)

> **反转 FLY-175/FLY-605 的「approve_to_ship=WAKE-only」边界 = 新增一条 first-class 授权写面。
> 它必须比现有 Surface A/B consent 更严:证据绑到"这条 Discord 消息 + 这个当前 review question
> + 这个 PR head",可审计、可重试。** 以下 5 条硬约束(Codex R1 #1-#4)是这条写面的合同。

**主改点**:`bridge/founder-reply-deliverer.ts` `processFounderMessage` 的 `ship`(approve_to_ship)
分支,从「只 WAKE」改为(仅当 5 条硬约束全满足才写批准,否则 WAKE-only + 交回 Lead):

**A-1 身份(单一 canonical + fail-closed,Codex R1 #4)**:founder id 现分散在两处 ——
`discordOwnerUserId`(deliverer 用,gate-poller L1795-1847)与 `founderConsent.founderUserId`
(evaluator annotate 用,evaluator L225-234)。本写面**派生单一 canonical founder id**:两者都
缺 → fail-closed 不写;两者都在但**不相等** → fail-closed 不写(配置错防线)。消息身份仍是
`msg.author.id === canonicalFounderId && !bot`。

**A-2 唯一当前 ship gate(Codex R1 #2)**:现匹配模型把一条 founder 消息匹配到 thread 里所有
更早的 pending question、并对每个 approve_to_ship gate 循环(deliverer L181-188、L238-297)——
对 WAKE-only 无害,对**授权写危险**(一句「ship it」可能批准同 thread 的多个 live review /
rerun / 未来 sub-issue)。写前**收窄候选**:只留 `session.status==="awaiting_review" &&
session.review_question_id === q.questionId` 的 gate,**要求恰好一个**;>1 → 不写、WAKE-only +
交回 Lead(除非 Annie 明确批 batch 语法,§7-D2)。

**A-3 批准意图判定(专用 classifier,绑消息,Codex R1 #1)**:**不直接复用
`FounderConsentEvaluator`** —— 它会 env/label short-circuit(evaluator L149-178)、cache 按
issue/exec/action/head 而非消息 id(L180-200)、只要求 evidence 是"window 内某条 founder 消息"
(L297-314)。新增专用合同 `FounderShipApprovalClassifier`:输入必须含 `expectedMessageId /
messageContent / questionId / executionId / issueId / prHeadSha`;**禁用 env/label bypass**;
**禁 cache 或按 `(questionId, prHeadSha, expectedMessageId)` 为 key**;若用 LLM,**要求
`decision.evidenceMessageId === expectedMessageId`**,否则 fail-closed。明确 reject/
changes-requested → 写 feedback(非 approved)+ feedback_wake。含糊/非本人 → WAKE-only。

**A-4 写路径复用受信任语义(抽共享 helper,Codex R1 #3)**:**不裸写
`db.insertResponse + onResponseWritten`**。抽一个共享内部 helper
`writeGateResponseAndRunPostWrite`,**Surface B(gate-response-router)与本 founder-reply 路径
共用**,合同 = 现有 approveExecution / gate-router 的幂等语义(actions.ts L223-303、
gate-response-router L235-268):① 校验 checkpoint==approve_to_ship;② 校验 questionId ==
session 当前 review_question_id;③ 校验 session `awaiting_review`(或已 `approved_to_ship` 幂等);
④ 已存在**相同**批准 response → 当 retry 重跑 hook;⑤ 已存在**冲突** feedback → 拒;⑥
founder-reply cursor **只在 response + post-write 副作用达到 retry-safe 状态后**才前移(写了
response 但 transition/wake 失败 → 不前移 cursor,下轮重试收敛)。

**A-5 归属 + 审计**:actor 用真实 founder Discord user id(不只是通用 `founder-discord` 串);
审计事件记 **真实 user id + 证据 message id + questionId + prHeadSha + 收窄到的 node set**
(Codex R1 #7),复用现有 `founder_consent_audit` / session_events。

**装配**:`gate-poller.ts` `founderReplyDeliverPass()`(L1864-1871)给
`emitFounderReplyDeliveryForThread` deps 注入 `writeGateResponseAndRunPostWrite` +
`FounderShipApprovalClassifier` handle。helper/hook 由 plugin.ts 从
`buildFounderConsentWiring(...)` 提供(把 `onResponseWritten` + 新 helper 从 wiring export)。

**为何安全**:verify-approval 不校验 responseFrom(research A.1),它信任「谁写 approve_to_ship
response 谁权威」,而写路径本被 respond.ts 限死(research A.3)。FLY-799 在 **Bridge 进程内、
基于 Discord 身份验证过的、绑定到唯一当前 question + PR head + 具体消息 id 的 founder 批准**
写 —— 比 Lead 转述更强的 founder 授权证据,等价于「被信任路径」,符合 FLY-175 本意。**这条写面
走独立的 default-off flag(区别于 default-on 的 founder-reply-deliver flag)**,opt-in 才启用。

### Part B — runner 自 ship(基本不改 + 795 依赖)

Blueprint APPROVE GATE 已对(research B)。Part B 只需:
- **D3 若保 `:cool:`**(Codex R1 认同):零改动,保 CI/deploy/branch-protection。
- **D3 若改 `gh pr merge`**:改 Blueprint L1167 那句 + 加 verify-approval 后的 `gh pr merge`
  路径(碰 founder-only-authority.md,风险见 §7-D3)。

**795 依赖 —— 诚实定位(Codex R1 #5,不再声称 restart-resilient)**:runner 醒来后的自 ship
是**一次性过程**(verify-approval→`:cool:`→轮询 merge→改 land-status→completed,Blueprint
L1159-1177)。若 runner 进程在**批准后、`:cool:`/land-rewrite/completion 之前**死掉,「wake +
幂等 verify-approval」**兜不住**(它只在同一个活 runner 真消费了 wake 时才续做);现有
stale-blocker 逻辑只会 alert / finalize 已 merged/closed 的 PR,**不会 resume 一个 open 的
approved ship**(stale-blocker-guard L14-19、L126-139)。因此:
- **v1 落地 default-off**(landing code 允许);但**把它当新 ship 流程正式启用,前置条件 =
  FLY-795 durable-state 地基,或本 issue 自带一个具体的 v1 reconciler**:检测 stale
  `approved_to_ship` + open PR 的 session → bounded、audited 地 re-wake / re-drive。
- 设计里定义窄接口 `ShipResumeSubstrate`(v1 = wake + 幂等 verify + [可选] stale-approved
  reconciler;v2 = 795 durable 快照续做),实现挂接口后。**production 启用的 gating 写进 §9
  rollout + §7 present Annie。**

### Part C — fan-out 收尾(扩 post-ship-finalization)

shipped runner 自 ship 触发 `runPostShipFinalization`(对它自己,已存在)后,**再顺关系图遍历**
清理每个相关节点。新增 `runFanoutFinalization(rootExecutionId)`:

```mermaid
graph TD
    S[shipped runner 自 ship → runPostShipFinalization] --> G[collectRelatedNodes<br/>关系图遍历]
    G --> Q[auto_qa_record: parent→qa_execution_id + qa_issue_id]
    G -.v2/793.-> T[Linear sub-issue 子树<br/>parent/children via Linear SDK]
    Q --> C[对每节点: cleanupNode]
    T -.deferred.-> C
    C --> C1[mark Linear Done]
    C --> C2[closeRunner finalizeDone+archive<br/>tmux+cmux+tab+thread+row]
    C --> C3[removeCleanWorktree]
```

- **节点收集** `collectRelatedNodes(rootExecId)`:
  - v1:root 的 `auto_qa_record`(parent=root)→ `qa_execution_id`(QA runner)+ `qa_issue_id`
    (QA issue/thread)。
  - v2(接口留好、遍历 deferred):Linear `issue.parent` 上溯到 main → `.children()` 下遍
    design/implement/QA sub-issue。需处理「无 linear client」fallback(research C.4)。
- **v1 fan-out 的真实增量(Codex R1 #6,别高估复用)**:QA PASS 现在**已经**关掉了 QA runner
  (auto-qa-coordinator L629-652,reconcile L691-715 还会重试),所以 v1 QA fan-out 的真实工作
  ≈「**若 QA runner 仍 live 则 verify/close;若有 QA issue 则标 Done**」。**不动**
  `running / awaiting_retest / stuck` 的 QA 记录(那些 QA 还没结论,root 批准不覆盖它们的关闭
  授权 —— Codex R1 #7);只处理已 PASS / 可安全收尾的。「标任意 Linear issue Done」**不是现成
  原语** —— 现逻辑埋在 HTTP `/api/linear/update-issue` route(plugin.ts L1882-1938)→ **抽一个
  内部 `LinearIssueFinalizer` helper**(复用其 state-name resolution),显式传 `transitionOpts`
  / `archive` / `removeCleanWorktree` deps。
- **每节点** `cleanupNode(node)`:`closeRunner({finalizeDone:true, archive})`(tmux+cmux+tab+
  thread+row)+ `removeCleanWorktree` + `LinearIssueFinalizer.markDone`。
- **per-node 可重试状态(Codex R1 #6,不照抄 post-ship 的一次性 claim)**:post-ship 的单个
  one-shot claim(L159-168)对**单** runner 够,但 fan-out 多节点若照抄、部分失败就变不可重试。
  → 定义 `FanoutFinalizationStore`(或 session_events 协议)记**每节点** `started/succeeded/
  failed` marker + **重启 reconcile**(未完成节点下次续清)。失败节点记 founder-facing alert
  (FLY-368 channel)+ 不阻塞其他节点(§7-D2b)。整体仍有一个 fan-out 级 claim 防并发重入,但
  节点级状态保证部分成功可续。
- **授权语义(Codex R1 #7)**:写批准的 audit 事件里**先记下收窄到的 related node set**(A-5),
  再动手;v1 只覆盖「已 PASS QA 收尾」,更宽的 subtree runner 关闭授权 defer 到 FLY-793 设计
  关系图 + 授权措辞。classifier 的 action 名显式化(如 `approve_to_ship_and_finalize_related`)。

## 4. 改动清单(文件级)

| # | 文件 | 改动 | Part |
|---|------|------|------|
| 1 | `bridge/founder-reply-deliverer.ts` | ship 分支:A-1..A-5 硬约束 → 调 classifier + 共享写 helper | A |
| 2 | `bridge/gate-poller.ts` `founderReplyDeliverPass` | 注入 classifier + `writeGateResponseAndRunPostWrite` + canonical founder id | A |
| 3 | `bridge/founder-consent/wiring.ts` | export `onResponseWritten` + 抽出的共享 `writeGateResponseAndRunPostWrite`(Surface B 也改用) | A |
| 4 | `bridge/founder-consent/gate-response-router.ts` | 改用共享 `writeGateResponseAndRunPostWrite`(去重,Codex R1 #3) | A |
| 5 | `bridge/founder-ship-approval-classifier.ts`(新) | `FounderShipApprovalClassifier`:绑 expectedMessageId,禁 bypass/cache,require evidenceMessageId 匹配 | A |
| 6 | `bridge/plugin.ts` | 装配 classifier + helper + canonical founder id + 新 default-off flag → GatePoller config | A |
| 7 | `bridge/fanout-finalization.ts`(新) | `collectRelatedNodes` + `cleanupNode` + fan-out claim | C |
| 8 | `bridge/linear-issue-finalizer.ts`(新,从 plugin.ts L1882-1938 抽) | `LinearIssueFinalizer.markDone`(state-name resolution 复用) | C |
| 9 | `StateStore.ts` + `bridge/fanout-finalization-store.ts`(新) | `FanoutFinalizationStore`:per-node started/succeeded/failed marker + reconcile | C |
| 10 | `bridge/post-ship-finalization.ts` | ship 收尾后 call fan-out(v1 = auto_qa 链,仅已 PASS QA) | C |
| 11 | [Part B production 启用前] stale-`approved_to_ship` reconciler(或依赖 795) | Codex R1 #5 | B |
| 12 | `edge-worker/src/Blueprint.ts` | [仅 D3=merge 时] 改 :cool: 那句 | B |
| 13 | 2 个 env 开关(default-off 授权写面 + fan-out)+ 测试夹具 + 单测/集成测 | byte-compat + TDD | ALL |

## 5. 接口(795 边界 + fan-out 收集器)

```ts
// Part A — 绑消息的 ship 批准判定器(Codex R1 #1)。禁 bypass/cache;require evidence 匹配。
interface FounderShipApprovalInput {
  expectedMessageId: string;   // 正在处理的这条 Discord 消息 id
  messageContent: string;
  questionId: string;          // 必须 = session 当前 review_question_id
  executionId: string;
  issueId: string;
  prHeadSha: string;
}
type ShipApprovalVerdict =
  | { kind: "approve"; evidenceMessageId: string }   // require === expectedMessageId
  | { kind: "reject"; reason: string }
  | { kind: "unclear" };                              // fail-closed → WAKE-only
interface FounderShipApprovalClassifier {
  classify(input: FounderShipApprovalInput): Promise<ShipApprovalVerdict>;
}

// Part A — 共享受信任写面(Surface B + founder-reply 共用,Codex R1 #3 / R2 #2)
// 需要完整 trusted deps 才能守 status/head 并观测 post-write 结果(不能只有 db+qid+answer)。
interface WriteGateResponseResult { written: boolean; retrySafe: boolean; reason?: string }
function writeGateResponseAndRunPostWrite(args: {
  db: CommDB;
  store: StateStore;                     // getSession → 守 status
  questionId: string;
  executionId: string;
  actor: string;                          // 真实 founder user id | leadId(Surface B)
  answer: string;                         // '{"approved":true}' | feedback
  expectedCurrentReviewQuestionId: string;
  expectedStatus?: string;                // "awaiting_review"(founder-reply 路径)
  expectedPrHeadSha?: string;             // 供 audit/binding
  // post-write hook 返回可观测结果(成功/失败),而非静默吞;调用方决定 cursor 是否前移
  runPostWrite: (info: {...}) => Promise<{ ok: boolean }>;
}): Promise<WriteGateResponseResult>;
// 语义:checkpoint==approve_to_ship + questionId==当前 review_question_id + status 守卫 +
// 相同批准当 retry 重跑 hook + 冲突 feedback 拒。
// **founder-reply 路径**:post-write hook 失败 → retrySafe:false → cursor 不前移(下轮重试)。
// **HTTP Surface B 路径**:仍可选现有 best-effort(hook 失败不 fail 请求)—— 但这是**调用方
// 显式策略**,不藏在共享原语里。

// Part B — ship resume 地基(v1 = wake+幂等 verify [+可选 stale-approved reconciler];v2 = FLY-795)
interface ShipResumeSubstrate { ensureShipResumable(execId: string): Promise<void>; }

// Part C — 关系图收集(v1 auto_qa;v2 Linear 子树)
interface RelatedNode {
  executionId?: string;   // 有 runner 的节点
  issueId: string;
  role: "shipped" | "qa" | "design" | "implement";
  qaStatus?: string;      // v1:只处理已 PASS;跳过 running/awaiting_retest/stuck
}
function collectRelatedNodes(rootExecId: string): Promise<RelatedNode[]>;

// Part C — per-node 可重试状态(Codex R1 #6)
interface FanoutFinalizationStore {
  mark(execIdOrIssueId: string, node: string, state: "started"|"succeeded"|"failed"): void;
  pendingNodes(rootExecId: string): string[];   // 重启 reconcile 用
}

// Part C — 从 plugin.ts /api/linear/update-issue 抽出的标 Done 原语
interface LinearIssueFinalizer { markDone(issueId: string): Promise<{ done: boolean; reason?: string }>; }
```

## 6. 安全 / fail-closed / 防伪造(初判,§7-D1 请 Annie 定强度)

- **身份**:`msg.author.id === canonicalFounderId && !bot`(A-1:canonical = `discordOwnerUserId`
  与 `founderConsent.founderUserId` 一致解析;缺/冲突 → fail-closed)。Discord 保证作者 id 不可
  冒充;强度 = Discord 账号安全 + bot token 保密。
- **意图**:fail-closed —— 只有**明确**批准(A-3 classifier,require `evidenceMessageId ===
  expectedMessageId`)才写 `{approved:true}`;含糊/reject/非本人 → 不 ship。
- **绑定**:恰好一个当前 ship gate(A-2)+ 只答 session 当前 `review_question_id`
  (gate-response-router 同款防 stale,research A.4)+ `pr_head_sha` 匹配(改了码 → 旧批准失效)。
- **残余向量**(surface Annie):同机有 db 写权限的进程能直接伪造(verify-approval 已声明的
  threat-model);canonicalFounderId 配错;Discord 账号被盗。
- **审计**:每次写批准记 `founder_consent_audit` / session_event(actor = **真实 founder Discord
  user id**,非通用串 + 证据 message id + questionId + prHeadSha + 收窄 node set,A-5),复用现有
  审计表。

## 7. ⚠️ 大方向开放问题(present Annie,拍板后才 implement)

- **D1 身份防伪造强度**:Discord `author.id` 够吗?要不要**第二因子**(如只认 ✅/🆒 **reaction**
  而非/além自由文字,或 reaction+文字双确认)?reaction 更不含糊但要额外读 Discord reactions
  API(+scope)。
- **D2 批准意图判定**:(a) 只认 reaction(最安全);(b) 关键词白名单(轻但误判);(c) 专用
  `FounderShipApprovalClassifier`(A-3;可**借用** LLM/prompt 模式,但**不直接复用**
  `FounderConsentEvaluator` —— 它的 bypass/cache/window 语义对这条 message-bound 写面太宽);
  (d)【建议】文字走 c + 支持 reaction,fail-closed。**+ 部分成功回滚语义(D2b)**:ship 不可逆 → 「回滚」
  = 清理这步;建议**尽力清 + 失败节点告警 + 不阻塞其他 + 幂等不重清**。接受吗?
- **D3 自 ship 机制**:【建议】保 `:cool:`(保 CI-green+branch-protection+守 FLY-248);Annie 字
  面写 `gh pr merge`(绕 CI+保护、重开 FLY-248 风险)。字面照做吗?
- **D4 fan-out v1 scope**:v1 = auto_qa_record 链(现在能落);Linear sub-issue 子树接口留好、
  遍历随 FLY-793。接受切分吗?

## 8. 测试(TDD,byte-compat)

- **单测**:批准判定器(明确批准/reject/含糊/非本人 4 类);deliverer ship 分支(写批准 +
  hook 触发 / fail-closed 不写);fan-out `collectRelatedNodes`(有 QA / 无 QA)+ `cleanupNode`
  幂等 + 部分成功(某节点失败不阻塞 + 告警)。
- **安全回归专项(Codex R2 #3,逐条对应 R1 失败模式,防实现时回退)**:
  ① evidence message id 不匹配 → fail-closed;② env/label bypass 不能批准;③ cache 不能跨
  message id 复用批准;④ 同 thread 两个当前 ship gate → 不写 + 交回 Lead;⑤ canonical founder
  id 缺/冲突 → fail-closed;⑥ 已存在相同批准 → 重跑 post-write hook(幂等);⑦ 已存在冲突
  feedback → 拒;⑧ post-write hook 失败 → founder-reply cursor 不前移;⑨ default-off 授权写面
  → byte-compat 逐字 WAKE-only;⑩ 非 PASS QA 记录被跳过;⑪ per-node fan-out 失败 → 重启后只续
  未完成节点、不重做已成功节点。
- **集成**:真 CommDB + StateStore:founder 消息 → gate 翻 → verify-approval=true;fan-out 关
  QA + archive。
- **byte-compat**:env 开关(如 `FLYWHEEL_FOUNDER_AUTO_APPROVE=0` 默认?见 rollout)默认关 →
  行为逐字等于现状(WAKE-only);reverse-compat sentinel。
- **真机 E2E**(独立 QA,529 Room / Claude-in-Chrome):Annie 真账号在 thread 批准 → runner 真
  自 ship → QA+worktree+thread+cmux 全清;非本人/含糊不 ship。

## 9. Rollout
Bridge 侧改动 → 需一次 Bridge 重启部署(runner 提示词若 D3=保 :cool: 则不改,fleet 不用重
起)。env 开关默认**关**(opt-in),先在 529 Room / 单项目验,再 fleet。协调批量 Bridge 重启
(攒 PR)。

## 10. 依赖 / 时序
- **可并行设计**(Tadashi):跟 FLY-795 并行走 plan-first。Part A/C 可先落(default-off)。
  **Part B 作为新 ship 流程正式启用,前置 = FLY-795 durable-state 地基 _或_ 本 issue 自带的
  stale-`approved_to_ship`+open-PR reconciler**(二选一,非硬依赖 795 才能动;接口留好)。
- **v2 fan-out** 依赖 FLY-793 sub-issue 结构。
- **present Annie** 拍 §7 → Codex design review 已过 → 才 implement。
