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

**非目标 / 假设**:① 不实现 FLY-795 durable-state 地基(只标依赖、留接口);② **甲(Annie 拍):
一个 issue、三个内部阶段、不拆独立 sub-issue、Bridge RPC 不改** ⇒ fan-out 关系图 = feature ↔ QA
(AutoQaRecord),**不建/不遍历 Linear sub-issue 子树**(原 v2 复杂接口删掉);③ 不改 verify-approval
的 4-源校验(复用);④ **不引入 PR mode / pr_handoff**(Annie:『绝对没说要用 PR mode』)—— runner
自 ship = **复用现有 deploy workflow / 🆒 self-ship**,不做「runner 交 PR 给 founder 手动 ship」。

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
分支,从「只 WAKE」改为(仅当身份 + 硬约束全满足才写批准,否则 WAKE-only + 交回 Lead)。

**A-0 批准信号抽象层(Annie D2-② 要求:可扩展到语音/图片)**:批准检测不绑死单一形态,而是抽
一个 `ApprovalSignalSource` —— 每个 source 把一个 founder 输入归一成**完全绑定的**
`ApprovalSignal`(discriminated union,§5),gate-write 路径 **source-无关**(信号绑定后)。

> **『明确批准』的确切定义(Annie 要求明确定义)** = 一个 **kind:"approve"、身份=canonical
> founder、绑定到当前 gate(questionId + prHeadSha + targetMessageId/message)** 的
> `ApprovalSignal`,来自以下任一 source。**任何达不到的(含糊 / reject / 非本人 / 无绑定 / REST
> 失败)= 不算批准 → 不 ship**(fail-closed)。

- **`ReactionSource`(v1,✅ 对勾)**:founder 在 ship-gate 那条消息上贴 ✅ = **确定性批准,零
  LLM**。**不用 🆒**(Annie:少见;v1 只 ✅)。最简单最稳,是主路径。**必须绑到 A-0b 的
  durable `targetMessageId`**(下条);缺绑定 → 拒批准(不靠文字/时间戳/最新 post/扫 thread 猜)。
- **`TextSource`(v1,自由文字)—— 3 层省钱(Annie:能免费就别付费)**:**Tier-2 = 精确短句
  allowlist(非 substring,Codex R7 #1)**:归一化后**整条消息**恰等于白名单短句才算(如 `ship` /
  `ship it` / `approve` / `approved` / `lgtm` / `go` / `批准` / `可以 ship` / `上线吧` /
  `同意上线` / `ship FLY-799`)。**任一命中即降级 Tier-3 / unclear**:含 newline/引用/代码块/URL/
  `?`/`:`/逗号分号/多句、>4-5 tokens 或 >~32 chars、任何 hedge/条件/否定(no/not/don't/but/after/
  if/when/unless/wait/hold、别/不/先/等/看/再/待会/如果/除非/但是/改完/晚点)。**出现 issue/PR 号
  或 `FLY-xxx` 必须与当前 `issueId`/PR 号精确匹配**,否则 unclear(裸 `ship 756` 若 756≠当前绑定
  则不批)。**Tier-3 只有真·模糊自由文字才兜底** → A-3 classifier,**走订阅不烧付费 API**(见 A-3)。
- **`ImageSource`(代码 v1 建好、但 default-off,Annie 拍 B / Tadashi 2026-07-02)**:Annie 选
  **B = v1 ship 只『打字 + ✅』,图片作紧跟的 fast-follow(仍在 799 内)**。所以 ImageSource **代码
  照建 + 测好(已 landed)**,但 v1 **放它自己的 flag `FLYWHEEL_FOUNDER_IMAGE_APPROVAL` 默认 OFF**;
  v1 运行行为 = 打字+✅,图片这个 flag 作**下一个增量紧跟着 flip-on**(同 799)。ApprovalSignal 抽象
  撑住三种、图片随时能开。founder 发**图片附件**(截图/图片确认)→ **多模态 classifier**(Claude
  原生多模态,实测订阅可跑)判是否明确批准。**证据到附件级(Codex R5)**:先只收
  founder-authored Discord 图片附件(非文字里任意 URL)、过 MIME/扩展 allowlist + 数量/字节上限 +
  成功 fetch + **classify 前算 sha256**;verdict 要求 `evidenceMessageId===expectedMessageId`
  **且** `evidenceAttachmentIds ⊆ 期望附件`;fetch 失败 → unclear(不回退文字推断)。审计记
  attachmentId/filename/contentType/byteSize/sha256/classifier model+version/prompt+policy version。
  **图片语义 fail-closed 严规(Codex R5,图比文字更易误判)**:只有 founder 消息/图**无歧义表达
  『现在批准 ship 这个当前 gate』**才 approve;以下一律 `unclear` → 不 ship:纯状态截图、
  历史/转发的旧批准、通用 ✅/👍 图、别的 issue/PR、看不清/裁切/残缺、或无法把图绑到当前
  `questionId/prHeadSha`。倾向要求「图里能看到当前 issue/PR/gate 上下文」或「配一句把图绑到
  『ship this』的 founder 文字」。
- **`VoiceSource`(未来)**:语音转写 → 同一 classifier,**作为新 source 插入,不碰 gate-write
  路径**。这就是 Annie 要的抽象层(image/voice 都是它验证的用例)。
- 无论哪个 source,A-1(身份)+ A-2(唯一当前 gate)+ A-4(受信任写)+ A-5(审计)都照常套用。
  reaction 的「身份」= reactor `user.id === canonicalFounderId && bot !== true`(Codex R3 #3:要
  完整 user 对象、查 bot 位);text/image/voice = 消息作者 id === canonicalFounderId && !bot。

**A-0b ship-gate 消息 id 的 durable 绑定(Codex R3 #1,ReactionSource 的前置)**:现在
`founder-thread-notifier` POST「🚀 Ship gate 等你批准」后**只 audit threadId/status、不存 Discord
message id**(notifier L170-175/L229-257),`chat_threads` 也不存 per-gate 通知消息 → **今天没有
`(questionId,prHeadSha,threadId)→gateMessageId` 绑定**。修:notifier 成功后**解析 Discord POST
返回的 message id 并返回**;durable 存一行/事件,key 至少含 `questionId / executionId / issueId /
prHeadSha / threadId / gateMessageId / checkpoint / postedAt`。`ReactionSource.evaluate` 从这条
绑定取 `targetMessageId`,缺则拒批准。**幂等(Codex R4 #2)**:notifier 「先 POST 后写 marker」
可能重复发 gate 通知 → 用 unique key `(questionId, prHeadSha, checkpoint)`、`gateMessageId` 一旦写
入 immutable(或允许多行但 ReactionSource 要求「恰好一条当前绑定」否则 fail-closed);**写绑定前
再核 session 仍 `awaiting_review` 且 `review_question_id`+`prHeadSha` 未变**。

**A-0c reaction 观察独立于文字 cursor(Codex R3 #2)**:reaction 可能后贴到一条已在文字 cursor
后面的旧 gate 消息 → 不能塞进现有 `/messages?after=<cursor>` 循环(会漏 or 重复)。改成
**per-current-gate poll**:对每个 `awaiting_review` 且 `review_question_id===当前 gate` 的 session,
取其 durable `targetMessageId`,**只 poll 那条消息的 ✅ reactors**(复用 gateway 已有的
`founder-confirmation.ts`:emoji 编码 + bounded 分页 + 精确 founder-id + fail-closed
HTTP/malformed/429 —— Codex R3 「reuse」),命中 → 调共享写 helper(A-4 幂等);retry-safe 后落一个
durable signal marker `founder-approval-signal:reaction:<questionId>:<prHeadSha>:<targetMessageId>:
<founderId>:✅` 防重复触发。REST 失败/429/404 = 非批准、不推进文字 cursor、不落 marker。**bounded backoff
(Codex R4 #3)**:per-binding 记 last-checked + 429/5xx/404 退避,别每个 GatePoller tick 都猛敲
Discord;fail-closed 语义不变、retry-safe 前绝不 mark processed。

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

**A-3 批准意图判定(专用 classifier,绑消息,Codex R1 #1;仅 Tier-3 兜底调)**:**不直接复用
`FounderConsentEvaluator`** —— 它会 env/label short-circuit(evaluator L149-178)、cache 按
issue/exec/action/head 而非消息 id(L180-200)、只要求 evidence 是"window 内某条 founder 消息"
(L297-314)。新增专用合同 `FounderShipApprovalClassifier`:输入必须含 `expectedMessageId /
messageContent / questionId / executionId / issueId / prHeadSha`;**禁用 env/label bypass**;
**禁 cache 或按 `(questionId, prHeadSha, expectedMessageId)` 为 key**;**要求
`decision.evidenceMessageId === expectedMessageId`**,否则 fail-closed。明确 reject/
changes-requested → 写 feedback(非 approved)+ feedback_wake。含糊/非本人 → WAKE-only。
**成本(Annie:能免费就别付费)+ 订阅 runner 合同(Codex R7 #2)**:classifier 只在 **Tier-3
(真·模糊自由文字 / 图片)** 才调,且**走订阅**(headless `claude -p` / Claude Code,与 Belle/Runner
同套 subscription),**不用付费 `AnthropicLLMClient`**。当前 codebase 无现成「一次性 prompt→严格
JSON verdict」封装 → 新 seam `SubscriptionClaudeClassifierRunner`,硬合同:**`execFile` 无 shell +
固定 cwd + 最小 env + 显式 `CLAUDE_CONFIG_DIR`/PATH;严格 timeout + max stdout/stderr buffer + 并发
上限 + 失败熔断;timeout/nonzero/login/rate-limit/malformed JSON 全部 → `unclear` + WAKE-only**
(绝不 fail-open);输出过 JSON schema 校验 + 叠加 `evidenceMessageId===expectedMessageId`
(+image attachment ids/hash);审计记 `claude --version`/promptHash/policyVersion/latency/exit/stderr
摘要。**ImageSource 多模态 = 实测已支持(2026-07-02,Tadashi 要求先测不假设)**:`claude -p
'What text... @/tmp/fly799-ship.png' --model claude-haiku-4-5-20251001` 在本机**订阅正确读出图内
文字**(~7s,无 API key)→ **ImageSource 纳入 v1、不 feature-gate-off**。机制:founder 的 Discord
图片附件**下载到受控 temp 路径**(image MIME allowlist + size cap)→ sha256 → prompt 里
`@<temp-path>` 引用喂**同一 runner**(`--output-format json`)→ 判 → 清 temp。**安全**:`@path`
只引用我们下载的受控路径,founder 文字作数据不作路径(防 `@/etc/passwd` 注入);下载失败/非图片/
超限 → unclear。绝大多数批准是 ✅ 或 Tier-2(零 AI)→ Tier-3(文字/图片)极少触发。
- **模型 + 机制(Annie/Tadashi 拍)**:Tier-3 = **on-demand headless `claude -p`(不是常驻进程,
  只在罕见模糊文字时起一个 headless claude 判一句立刻退)**,model = **Haiku
  `claude-haiku-4-5-20251001`**(model-tiers trivial 档、订阅可用),**订阅 auth、非付费 API**。
- **实测确认(2026-07-02,给 Annie 准信)**:`claude -p '<判定 prompt>' --model
  claude-haiku-4-5-20251001` 在本机**订阅跑通**(无 API key)—— 对『先别 ship 我看看』正确返
  `{"approved": false}`,~7.5s 一次性。→ **用 Haiku,不用退 Sonnet**。实现注:`-p` 输出会带
  ```json fence → runner 用 `--output-format json` 或剥 fence 后再过 schema 校验。

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
有独立 flag 作 kill-switch;Annie 拍『默认 ON』(直接上线、发现问题再关),不是 opt-in-off。**
仍保留 `=0` 关闭时逐字等于旧 WAKE-only 行为 + reverse-compat sentinel(证明关掉=旧行为)。
**默认 ON 的前提 = Part B 的 v1 stale-approved reconciler 必须在 799 内落地**(否则 Bridge 重启
中断自 ship 会 strand;见 Part B / §9)。

### Part B — runner 自 ship(基本不改 + 795 依赖)

Blueprint APPROVE GATE 已对(research B)。Part B:
- **D3 = 保留 `:cool:`(Annie 已拍✅)**:**零改动** runner 提示词,保 CI/deploy/branch-protection。
  `gh pr merge` 方案已否决(不改 Blueprint L1167)。

**默认 ON 的 restart 安全前提 —— v1 stale-approved reconciler(Codex R7 #3,in-scope)**:runner
醒来后的自 ship 是**一次性过程**(verify-approval→`:cool:`→轮询 merge→改 land-status→completed,
Blueprint L1159-1177)。现有 stale-blocker 对 open PR 只 alert(stale-blocker-guard L14-19、
L126-139),不 resume。因默认 ON,本 issue 落地一个**明确 re-wake-only 状态机**(不做 Bridge 自
post `:cool:` 的 re-driver —— 那会变成新的 Bridge-side ship executor,与「runner 自 ship 零改」
矛盾;full runner-death 恢复 defer 795):
- **触发**:Bridge startup + bounded periodic scan;只扫 **flag ON 且 stale** 的
  `status=approved_to_ship` 且有 `review_question_id`/`pr_head_sha`/PR number 的 session。
- **claim**:durable lock keyed `(executionId, questionId, prHeadSha, prNumber)` + marker
  (`scanned/rewake_sent/adopted/alerted/done`),crash 可 adopt;单 Bridge worker 收口。
- **re-verify**:复用 `verifyApproval`;查 **PR live head sha === session pr_head_sha**;PR
  merged → 只 finalize/landing、**不重复 ship**;PR closed/head mismatch/missing/429/unknown →
  **fail-closed + alert**。
- **动作 = 只 re-wake 仍活着的 runner mailbox**(不自 post `:cool:`)。**runner 已死(真 strand)
  → alert + 明说『live runner 才修,真 death 待 795』**,并据此**收窄默认-ON 的可靠性声明**(诚实:
  覆盖『Bridge 重启但 runner tmux 存活』这个常见情形;机器重启杀了 runner 的真 death 留 795)。
- 窄接口 `ShipResumeSubstrate`(v1 = re-wake + 幂等 verify + reconciler;v2 = 795 断点续做)。
- **与 795 的边界(Tadashi 2026-07-02)**:v1 re-wake reconciler **不读 795 的 `progress.md`**
  —— 它只用 StateStore `approved_to_ship` + PR head + `verifyApproval`,自足。真 runner-death 恢复
  (v2)= **消费 795 的 durable substrate**(经 `ShipResumeSubstrate` 接口),**不各造**:我的消费
  需求交给 Tadashi 转 795,不自建 progress 机制。

### Part C — fan-out 收尾(扩 post-ship-finalization)

> **甲(Annie 拍 2026-07-02):一个 issue、三个内部阶段、不拆独立 sub-issue、Bridge RPC 不改。**
> ⇒ **finalization 关系图 = feature ↔ QA(AutoQaRecord),不是三段 Linear 子树。** 原本留的
> 『Linear sub-issue 子树遍历(v2/793)』**不再需要** —— 删掉那套复杂接口,fan-out 就是「关 feature
> runner + 它的 QA」。

shipped runner 自 ship 触发 `runPostShipFinalization`(对它自己,已存在)后,**再清它的 QA**:

```mermaid
graph TD
    S[shipped runner 自 ship → runPostShipFinalization] --> G[collectRelatedNodes]
    G --> Q[auto_qa_record: parent→qa_execution_id + qa_issue_id]
    Q --> C[cleanupNode QA]
    C --> C1[mark QA issue Done]
    C --> C2[closeRunner finalizeDone+archive<br/>tmux+cmux+tab+thread+row]
    C --> C3[removeCleanWorktree]
```

- **节点收集** `collectRelatedNodes(rootExecId)`:root 的 `auto_qa_record`(parent=root)→
  `qa_execution_id`(QA runner)+ `qa_issue_id`(QA issue/thread)。**就这一层**(甲 = 无 sub-issue
  树,不走 Linear parent/children)。
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
| 1 | `bridge/founder-reply-deliverer.ts` | ship 分支:身份 + A-1..A-5 → 调 `ApprovalSignalSource` → 共享写 helper;`RawDiscordMessage` + fetch 扩到含**图片附件**(Codex R5:只 founder-authored、allowlist、fetch+hash) | A |
| 1b | `bridge/approval-signal/`(新) | `ApprovalSignalSource` 抽象 + `ReactionSource`(per-gate poll `targetMessageId` 的 ✅,复用 `founder-confirmation.ts`,确定性零 LLM,查 bot 位)+ `TextSource`(Haiku)+ `ImageSource`(图片附件→多模态 classifier,Annie D2);VoiceSource 留口 | A |
| 1c | `bridge/founder-thread-notifier.ts` | 成功 POST 后解析并返回 Discord `gateMessageId`(现只 audit threadId/status) | A |
| 1d | `StateStore.ts` + `bridge/gate-message-binding.ts`(新) | durable `(questionId,execId,issueId,prHeadSha,threadId,gateMessageId,checkpoint,postedAt)` 绑定 + reaction signal marker | A |
| 2 | `bridge/gate-poller.ts` `founderReplyDeliverPass` | 注入 signal sources + `writeGateResponseAndRunPostWrite` + canonical founder id;founder-reply 读取扩到 reactions | A |
| 3 | `bridge/founder-consent/wiring.ts` | export `onResponseWritten` + 抽出的共享 `writeGateResponseAndRunPostWrite`(Surface B 也改用) | A |
| 4 | `bridge/founder-consent/gate-response-router.ts` | 改用共享 `writeGateResponseAndRunPostWrite`(去重,Codex R1 #3) | A |
| 5 | `bridge/founder-ship-approval-classifier.ts`(新) | Tier-2 **精确短句 allowlist**(整条恰等、零 AI、数据+表驱动测试)+ Tier-3 `FounderShipApprovalClassifier`(**走订阅 headless claude,非付费 API**;绑 expectedMessageId,禁 bypass/cache,require evidenceMessageId 匹配;图片多模态同订阅) | A |
| 6 | `bridge/plugin.ts` | 装配 signal sources + helper + canonical founder id + **default-ON kill-switch flag**(`FLYWHEEL_FOUNDER_AUTO_APPROVE`,`=0` 关)+ per-project denylist → GatePoller config | A |
| 7 | `bridge/fanout-finalization.ts`(新) | `collectRelatedNodes` + `cleanupNode` + fan-out claim | C |
| 8 | `bridge/linear-issue-finalizer.ts`(新,从 plugin.ts L1882-1938 抽) | `LinearIssueFinalizer.markDone`(state-name resolution 复用) | C |
| 9 | `StateStore.ts` + `bridge/fanout-finalization-store.ts`(新) | `FanoutFinalizationStore`:per-node started/succeeded/failed marker + reconcile | C |
| 10 | `bridge/post-ship-finalization.ts` | ship 收尾后 call fan-out(v1 = auto_qa 链,仅已 PASS QA) | C |
| 11 | `bridge/stale-approved-ship-reconciler.ts`(新,**v1 in-scope**,默认-ON 安全前提) | 检测 stale `approved_to_ship`+open-PR → **re-wake-only**(只叫醒活 runner,**Bridge 绝不自 post :cool:**;真死→alert,待 795) | B |
| 12 | `edge-worker/src/Blueprint.ts` | [仅 D3=merge 时] 改 :cool: 那句 | B |
| 12b | `bridge/subscription-claude-classifier-runner.ts`(新) | Tier-3 走订阅的 fail-closed wrapper(execFile、无 shell、timeout/buffer/并发上限、JSON schema、失败→unclear;image 先证多模态支持否则 feature-gate) | A |
| 13 | env 开关(**default-ON kill-switch** 授权写面 + per-project denylist + fan-out flag)+ 测试夹具 + 单测/集成测 | kill-switch compat + TDD | ALL |

## 5. 接口(795 边界 + fan-out 收集器)

```ts
// Part A — 批准信号抽象层(Annie D2-②:可扩展到语音)。gate-write 路径 source-无关。
// Codex R3 #4:用 discriminated union(非 free-form evidenceRef),每个 source 产出**完全绑定、
// 可审计**的信号;source-agnostic 只发生在信号已绑定之后。
type GateBinding = {           // 每个 source evaluate 的共同上下文
  questionId: string;          // = session 当前 review_question_id
  executionId: string; issueId: string; prHeadSha: string;
  threadId: string; canonicalFounderId: string;
  targetMessageId: string;     // ★ ship-gate 通知消息的 durable Discord id(A-0b)
};
type ApprovalSignal =   // 每个 variant 都带 questionId+prHeadSha,审计对称(Codex R4 #1)
  | { source: "reaction"; kind: "approve"; questionId: string; prHeadSha: string;
      targetMessageId: string; emoji: "✅"; reactorUserId: string }
  | { source: "text"; kind: "approve" | "reject" | "unclear"; questionId: string; prHeadSha: string;
      messageId: string; authorUserId: string }
  | { source: "image"; kind: "approve" | "reject" | "unclear"; questionId: string; prHeadSha: string;
      messageId: string; authorUserId: string;
      evidenceAttachmentIds: string[]; imageHashes: string[] }  // Annie D2:图片确认(证据到附件级)
  | { source: "voice"; kind: "approve" | "reject" | "unclear"; questionId: string; prHeadSha: string;
      transcriptId: string }; // future
// Codex R4 #1:接口按 source 各自数据流分,别硬统一(reaction 只吃 gate+targetMessageId;text/image 吃 message)
interface ReactionSource { evaluate(gate: GateBinding): Promise<ApprovalSignal | null>; }
interface TextSource {
  evaluate(args: { gate: Omit<GateBinding, "targetMessageId">;
                   message: { id: string; content: string; authorId: string } }): Promise<ApprovalSignal | null>;
}
interface ImageSource {  // founder 图片附件 → 多模态 classifier(Codex R5:证据必须到附件级)
  evaluate(args: {
    gate: Omit<GateBinding, "targetMessageId">;
    // 只收 founder-authored Discord 图片附件(非文字里的任意 URL);先 fetch+hash 再 classify
    message: { id: string; authorId: string;
               imageAttachments: { id: string; filename: string; contentType: string;
                                   byteSize: number; sha256: string }[] };
  }): Promise<ApprovalSignal | null>;
}
// 多模态 classifier verdict(TextSource 用 ClassifierVerdict;ImageSource 用这个):
// require evidenceMessageId===expectedMessageId AND evidenceAttachmentIds ⊆ expectedAttachmentIds(非空);
// cache(若有)key = (questionId, prHeadSha, expectedMessageId, attachmentIds, imageHashes)。
// v1: ReactionSource(✅ 确定性零 LLM) + TextSource(Haiku) + ImageSource(多模态 classifier);future: VoiceSource

// Part A — 绑消息的 ship 批准判定器(Codex R1 #1;仅 TextSource / VoiceSource 用)。禁 bypass/cache;require evidence 匹配。
interface FounderShipApprovalInput {
  expectedMessageId: string;   // 正在处理的这条 Discord 消息 id
  messageContent: string;
  questionId: string; executionId: string; issueId: string; prHeadSha: string;
}
type ClassifierVerdict =        // R3 #4:与 source-level ApprovalSignal 分名,避免碰撞
  | { kind: "approve"; evidenceMessageId: string }   // require === expectedMessageId
  | { kind: "reject"; reason: string }
  | { kind: "unclear" };                              // fail-closed → WAKE-only
interface FounderShipApprovalClassifier {
  classify(input: FounderShipApprovalInput): Promise<ClassifierVerdict>;
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

// Part B — ship resume 地基(v1 = re-wake + 幂等 verify + stale-approved reconciler[in-scope];v2 = FLY-795)
interface ShipResumeSubstrate { ensureShipResumable(execId: string): Promise<void>; }

// Part C — 关系图收集(甲:只 feature ↔ QA,不走 Linear 子树)
interface RelatedNode {
  executionId?: string;   // 有 runner 的节点
  issueId: string;
  role: "shipped" | "qa";
  qaStatus?: string;      // 只处理已 PASS;跳过 running/awaiting_retest/stuck
}
function collectRelatedNodes(rootExecId: string): Promise<RelatedNode[]>; // = root + 其 auto_qa_record

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
- **意图**:fail-closed —— 只有**完全绑定的 `ApprovalSignal`**(Codex R4 #4)才写
  `{approved:true}`:reaction 证据 = `(targetMessageId, emoji, reactorUserId)`;text 证据 =
  `(messageId, classifier evidenceMessageId===expectedMessageId)`。含糊/reject/非本人 → 不 ship。
- **绑定**:恰好一个当前 ship gate(A-2)+ 只答 session 当前 `review_question_id`
  (gate-response-router 同款防 stale,research A.4)+ `pr_head_sha` 匹配(改了码 → 旧批准失效)。
- **残余向量**(surface Annie):同机有 db 写权限的进程能直接伪造(verify-approval 已声明的
  threat-model);canonicalFounderId 配错;Discord 账号被盗。
- **审计**:每次写批准记 `founder_consent_audit` / session_event(actor = **真实 founder Discord
  user id**,非通用串 + 证据 message id + questionId + prHeadSha + 收窄 node set,A-5),复用现有
  审计表。

## 7. 大方向决定(Annie 拍板记录)

- **D1 身份防伪造强度 = 批准边界反转 ✅(Annie 拍)**:验明是她本人 Discord 身份(reaction
  user / message author === canonicalFounderId 且非 bot)→ 把 approval 写进 gate(反转
  FLY-175 WAKE-only)。fail-closed:身份不符 → WAKE-only 不写。
- **D2 明确批准 = 文字 / ✅ reaction【v1 开】+ 图片【建好但 default-off,fast-follow flip】(Annie 拍 B,Tadashi 2026-07-02 澄清)**:v1 三 source 代码全建好,但**运行只开文字+✅**;图片走自己的
  `FLYWHEEL_FOUNDER_IMAGE_APPROVAL` 默认 OFF,作 799 内下一个增量 flip-on。**文字走 3 层省钱
  (Annie:能免费就别付费)**:① ✅ reaction 零 AI(主路径)② Tier-2 常见关键词零 AI(带否定守卫)
  ③ 只有真·模糊文字/图片才调 classifier,**走订阅不烧付费 API**(A-3)。`ApprovalSignalSource`
  抽象让语音以后插入。**明确批准的确切定义见 A-0**。**D2b 收尾失败 = best-effort 不回滚 ✅**:
  失败节点只告警(FLY-368)+ 不阻塞其他 + 幂等不重清 + per-node reconcile;**绝不回滚已 ship**。
- **D3 自 ship 机制 = 保留 `:cool:` ✅(Annie 拍)**:runner 提示词零改,保 CI+branch-protection;
  `gh pr merge` 已否决;**不引入 PR mode/pr_handoff ✅(Annie 拍)**。
- **D4 fan-out scope = feature ↔ QA(甲,Annie 2026-07-02 改拍)**:一个 issue 三内部阶段、不拆
  独立 sub-issue ⇒ 收尾 = 关 feature runner + 它的 QA(AutoQaRecord)。**不再需要 sub-issue 树
  遍历**,原『分两波 / 793 rebase 补三段』作废,一波做全。
- **上线 = 默认 ON ✅(Annie 拍:直接上线、发现问题再关,别默认关)**。因为默认 ON,**runner 自
  ship 中途重启的可靠性不能再等 795** → **本 issue 内落地 v1 stale-`approved_to_ship`+open-PR
  reconciler**(bounded/audited re-drive)作默认-ON 的安全前提;795 落地后可替换为更强的断点续做。
  flag 仍在(kill-switch),`=0` 关掉 = 逐字旧 WAKE-only 行为。

### 本轮回 Annie 的两个问题(D2 a/b)
- **(a) Haiku 分类器装在 Bridge 哪一层?** 装在 **Bridge 进程内、GatePoller 的 founder-reply 读取
  那一层**(新模块 `founder-ship-approval-classifier.ts`),跟现在已经在读你 thread 消息的代码
  **同一层**。它**只在真·模糊自由文字才跑**(✅ 和常见短语『ship/批准』都零 AI)。判断**沿用系统
  已有的同款语义判断思路,但新加一个薄的订阅 runner 封装**(走订阅、不烧付费 API)。
- **(b) 会不会太复杂?值不值?** 核心其实很小 —— 大部分是把**已有零件接起来**(自 ship / 收尾 /
  状态翻转都现成、verify-approval 零改)。真正新增就三块:① 文字批准的 Haiku 判断(**一次很轻的
  调用、只在你批准 ship 这种少见时刻**跑,非热路径);② `ApprovalSignal` 抽象层(小,为你要的语音
  留口);③ 收尾的分步重试(为正确性)。**✅ 表情路径零 AI、最简单最稳、是主路径**;Haiku 只为
  「别把『我看看再 ship』误当批准」兜底 —— ship 不可逆,值得这道 fail-closed 闸。**评估:值** ——
  换来你再也不用提醒 / 手动 merge。想更省:v1 可先只上 **✅ 表情(彻底零 AI)**、文字批准当
  fast-follow;但你说要文字我就都留在 v1。

## 8. 测试(TDD,byte-compat)

- **单测**:批准判定器(明确批准/reject/含糊/非本人 4 类);deliverer ship 分支(写批准 +
  hook 触发 / fail-closed 不写);fan-out `collectRelatedNodes`(有 QA / 无 QA)+ `cleanupNode`
  幂等 + 部分成功(某节点失败不阻塞 + 告警)。
- **安全回归专项(Codex R2 #3,逐条对应 R1 失败模式,防实现时回退)**:
  ① evidence message id 不匹配 → fail-closed;② env/label bypass 不能批准;③ cache 不能跨
  message id 复用批准;④ 同 thread 两个当前 ship gate → 不写 + 交回 Lead;⑤ canonical founder
  id 缺/冲突 → fail-closed;⑥ 已存在相同批准 → 重跑 post-write hook(幂等);⑦ 已存在冲突
  feedback → 拒;⑧ post-write hook 失败 → founder-reply cursor 不前移;⑨ **kill-switch `=0`**
  → byte-compat 逐字 WAKE-only(flag 未设=默认 ON);⑩ 非 PASS QA 记录被跳过;⑪ per-node fan-out 失败 → 重启后只续
  未完成节点、不重做已成功节点。
- **reaction 专项(Codex R3 #5)**:⑫ 无 durable target gate message id → 不批准;⑬ ✅ 贴在
  非-gate / 旧 gate / QA ship-ready 消息 → 忽略;⑭ 重新 review 后 ✅ 贴旧 gate → 被当前
  `review_question_id`+`prHeadSha` 拒;⑮ reaction API 分页第 2 页才找到 founder → 命中;
  ⑯ 403/404/429/malformed → fail-closed;⑰ 重复 poll 同一 ✅ → 幂等(signal marker);⑱ 批准后
  founder 取消 ✅ → 已 durable 写不回滚;⑲ audit 记 targetMessageId + emoji + reactorUserId。
- **classifier 分层 + 成本专项(Codex R7 #5,含绕过面)**:㉙ Tier-2 精确短句 `ship`/`批准` →
  approve 零 AI;㉚ 绕过面全 unclear/Tier-3:`I approve the direction but don't ship yet`、
  `LGTM after QA`、`他刚才说 ship it, 我不同意`、`go with option A`、引用/代码块/URL/问号/多句/
  超长、`ship 756` 但 756≠当前绑定 issue/PR;㉛ Tier-3 调的是**订阅 runner**(不实例化付费
  `AnthropicLLMClient`,断言);㉜ 订阅 runner 失败模式全 fail-closed→unclear:CLI 缺失/需登录/
  timeout/nonzero/stderr 噪声/malformed JSON/schema 不符/图片不支持;㉝ 默认 ON:flag 未设=开启;
  `=0`=逐字旧 WAKE-only;per-project denylist 命中=不写;㉞ reconciler crash interleavings:PR 已
  merged→只 finalize、closed/head mismatch/429/unknown→fail-closed+alert、claim 后 crash 可 adopt、
  PR 已有 ship 信号 / runner 可能已发 `:cool`→**reconciler 自己绝不发 `:cool:`、只 adopt+alert**;
  双 Bridge worker 不双 ship;**只 re-wake 活 runner,真死 runner→alert(不谎报修复,待 795)**。
- **image 专项(Codex R5)**:⑳ 无附件 → null/unclear;㉑ 非图片/超大附件 → fail-closed;㉒ 多附件
  需显式 evidenceAttachmentIds;㉓ 通用 ✅/👍 图 → unclear;㉔ 旧批准/别 issue/QA-pass 截图 →
  unclear;㉕ 看不清图 → unclear;㉖ 合法当前-gate 图批准仅当作者=canonical founder 且
  questionId/prHeadSha 匹配才写;㉗ audit 含 image sha256 + evidenceAttachmentId;㉘ fetch 失败 →
  unclear(不回退文字)。
- **集成**:真 CommDB + StateStore:founder 消息 → gate 翻 → verify-approval=true;fan-out 关
  QA + archive。
- **kill-switch compat**:flag `FLYWHEEL_FOUNDER_AUTO_APPROVE` **默认 ON**(Annie 拍);`=0`
  关掉 → 行为逐字等于现状(WAKE-only);reverse-compat sentinel 证明 `=0` = 旧行为。
- **真机 E2E**(独立 QA,529 Room / Claude-in-Chrome):Annie 真账号在 thread 批准 → runner 真
  自 ship → QA+worktree+thread+cmux 全清;非本人/含糊不 ship。

## 9. Rollout
Bridge 侧改动 → 需一次 Bridge 重启部署(runner 提示词 D3=保 :cool 不改,fleet 不用重起)。
**flag 默认 ON(Annie:直接上线、发现问题再关)**,`FLYWHEEL_FOUNDER_AUTO_APPROVE=0` 是 kill-switch;
**加 per-project disable/denylist**(某项目出问题不用全 fleet 关停,Codex R7 #4)。
**默认 ON 的 release-readiness gates(全过才 merge)**:① Tier-2 精确短句收窄 + 绕过测试全过;
② `SubscriptionClaudeClassifierRunner` fail-closed 测试全过;③ stale-approved reconciler
crash/幂等测试全过;④ kill-switch `=0` sentinel 证明旧 WAKE-only 逐字行为;⑤ 独立 QA(529 Room /
Claude-in-Chrome)真机验过(Annie 真账号批准 → 自 ship + 全清;非本人/含糊/旧 head 不 ship)。
协调批量 Bridge 重启(攒 PR)。

## 10. 依赖 / 时序
- **可并行设计**(Tadashi):跟 FLY-795 并行走 plan-first。
- **fan-out = feature ↔ QA,一波做全(甲,Annie 2026-07-02)**:不拆独立 sub-issue ⇒ 收尾就是关
  feature runner + 它的 auto_qa_record QA。**原『793 rebase 补三段树』作废**;不再为 sub-issue 树
  留复杂接口(`collectRelatedNodes` 只收 root + 其 QA)。
- **Part B(默认 ON)**:runner 自 ship 中途重启的可靠性 = 本 issue 的 re-wake-only reconciler
  兜常见情形(Bridge 重启但 runner 活)+ 真 runner-death 恢复靠 FLY-795(顺序可协调)。
- **收尾 = best-effort(Annie ②)**:某步失败只告警(FLY-368),**绝不回滚已 ship 的东西**
  (ship 不可逆);幂等不重清 + per-node reconcile 补未完成。
- **present Annie** 拍板 → Codex design review 已过(4 轮 APPROVED)→ 才 implement。
