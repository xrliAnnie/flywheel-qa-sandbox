# FLY-945 founder 批准 → runner self-ship 全链修复 — 实施计划

Issue: FLY-945 (https://linear.app/geoforge3d/issue/FLY-945/bugworkflow-founder-批准没触发-runner-self-ship-lead-被迫-executor-merge)
日期: 2026-07-06
基于: research.md

## 0. 目标与不变量

**目标(Annie 原话的机制化)**:founder 在 Discord thread 里说 "ship it"/批准 → **≤~75s** 被记成
founder 批准、绑当前(已 QA 的)PR head → runner `verify-approval` 通过 → runner 自己 merge →
completed → 自动标 Done + thread 归档(FLY-369 级联)。全程 Lead 零插手,founder 零催办。

**不许动的安全不变量**:
1. `verify-approval` 的既有五步校验(绑定 question / 结构化答复 / 状态 / pr_head / codex hard gate)一步不放松——本计划只**收紧**(E)与**喂对数据**(B)。
2. 批准归属永远是 founder(或 Bridge 的 founder-gated 写入者),消息文本永远不是授权。
3. 非 approve_to_ship 的 founder-reply 投递行为**字节不变**(10min grace、Lead 先手语义原样)。
4. 每个行为改动带 kill-switch env;`=0` 时 reverse-compat 测试锁字节不变。

交付形态:三段式同分支单 PR,按 Fix 分 commit(A→B→C→D→E→F 顺序,每个 commit 测试独立绿)。

## 1. Fix A(P0)— ship-gate founder 文字消息去 10min grace

### 1.1 行为定义
- 消息适用 grace = min(其 matching pending questions 的 checkpoint grace):
  `approve_to_ship` → `FLYWHEEL_SHIP_GATE_GRACE_MS`(默认 **15_000**);其余 checkpoint → 现状 10min。
- 循环语义:未成熟消息**不处理且 cursor 不得越过**,但继续处理其后已成熟消息
  (现 `break` → 改为记 `stopAdvanceAt`,循环继续;`advanceableUpTo` 只能推进到第一个未处理成功/未成熟消息之前——保 at-least-once)。
- **GatePoller 侧 question 预过滤必须整体重做,不是分流**(Codex R1 #3):现状是「question 未过 grace → 不入组」,
  若只让 ship question 提前入组,deliverer 拿到的 pending 集不完整——founder 对年轻非 ship question 的回复会被
  判「无 matching → irrelevant → cursor 越过」,**永久丢失**。改为:一个 thread 只要有**任一** pending question
  达到其 checkpoint 的可扫描门槛就入组,且**把该 thread 的全部 pending questions(不论成熟度)都传给 deliverer**,
  每个 question 附带自己的 checkpointGrace;deliverer 用**全集**做 matching,成熟度只影响「现在处理 vs 停推进等下轮」,
  绝不影响「是否算 matching」。cursor 停推进点 = 最早一条「有 matching 但未成熟(按其适用 grace)或处理失败」的消息之前。
- 处理一条成熟 ship 消息时行为不变:tryFounderShipApproval → 未认领则 WAKE-only(wake 文本照旧)。
- **reaction 批准 pass 一并放行**(Codex R1 #6):`founderReactionApprovalPass` 现同样用
  `founderReplyDeliverGraceMs()` 过滤 gate(`gate-poller.ts:2046`)——15s 只是 per-question 复查节流,
  端到端仍被 10min grace 压着。该过滤同步改为 ship-gate 用 `FLYWHEEL_SHIP_GATE_GRACE_MS`。

### 1.2 触点
- `packages/teamlead/src/bridge/gate-poller.ts`:question 分组过滤 + 把 per-checkpoint grace 传进 ctx
  (`FounderReplyThreadCtx.graceMs` → 改为 `graceMsFor(checkpoint)` 或在 questions 上带 checkpointGrace)。
- `packages/teamlead/src/bridge/founder-reply-deliverer.ts`:主循环重写(§1.1);函数签名向后兼容
  (未传 per-checkpoint 配置时 = 全 10min = 字节不变)。
- env:`FLYWHEEL_SHIP_GATE_GRACE_MS`(默认 15000;设成 600000 即回退旧行为——kill-switch 就是它,不另加开关)。

### 1.3 测试(packages/teamlead vitest,扩 founder-reply-deliverer 既有套件)
- 表驱动消息序列:①纯 ship 成熟 → 立即认领;②「未成熟非 ship 在前 + 成熟 ship 在后」→ ship 被处理、cursor 停在非 ship 前;
  ③重扫幂等(同消息二次扫不重复写/不重复 wake);④混合 matching(ship+非 ship 同 matching)→ 取 min grace,ambiguous 分支行为不变;
  ⑤`FLYWHEEL_SHIP_GATE_GRACE_MS=600000` → 与改动前逐事件一致(reverse-compat)。
- 时钟注入(deliverer 已可注入 now?否则加 nowFn 参数,禁 Date.now 裸用)。
- 新增:⑥「年轻非 ship question 的 founder 回复」在新语义下不丢(matching 用全集,cursor 停在它前面等成熟);
  ⑦reaction pass 的 ship-gate grace 放行测试(gate 过 15s 即可被 reaction 批准认领)。

## 2. Fix B(P0)— head 漂移自动 rebind

### 2.1 行为定义
在 auto-qa-coordinator 的 qa_result 校验路径(现"verdict head != parent head → drop",`auto-qa-coordinator.ts:~1064`)加分叉:
满足**全部**条件才 rebind,否则维持现状 drop:
1. verdict `status === "pass"`,且 qa_result 通过既有的报告者/record 校验(不为陌生 sha 开口子);
2. parent session `status === "awaiting_review"` 且 `review_question_id` 已绑(非 unbound);
3. 该 gate question **尚无 response**(comm.db 读);
4. **祖先校验**:session.pr_head_sha 是 reported sha 的祖先——在 session.worktree_path(缺失则跳过 rebind,fail-closed)
   跑 `git merge-base --is-ancestor <old> <new>`,证明是"同分支往前推",不是换头。
动作(单事务思维,按序):
1. `StateStore` 更新 session.pr_head_sha = reported sha(新 setter,只允许 awaiting_review 状态下调用);
   **text 批准路径到此已闭环**——`tryFounderShipApproval` 的 binding 是从 session 现算的,不读 durable store。
2. **binding store 引入 revision 语义(Codex R1 #1,不能直接 `writeGateMessageBinding`)**:现 binding 是
   write-once 的 session event(event_id = `bindingEventId(questionId)`,二次写被 UNIQUE 幂等吞掉,
   `gate-message-binding-store.ts` + 锁死它的单测)。改为 event_id 带**完整 40-hex head**:
   `bindingEventId(questionId, prHeadSha)`(Codex R2 #4:8 位前缀只配做展示文本,不配做持久唯一键;
   展示仍用 sha.slice(0,8))——每个 (question, head) 一条 write-once 行;
   `readCurrentGateMessageBinding(store, execId, questionId, prHeadSha)` 按「session 当前 pr_head_sha」精确匹配对应行
   (旧 head 行保留、自然失配)。既有单测**有意识地**更新:同 (question,head) 二次写仍幂等;head 失配仍读 null。
   GatePoller 原写点(`gate-poller.ts:~1499`)与 rebind 写点共用同一新 API。
3. **写序(Codex R2 #3,binding 行必须带真实 gateMessageId,不能先写后发)**:
   a. 更新 session.pr_head_sha(步骤 1)——**text 批准路径自此即已闭环**;
   b. thread **追发**通知(复用 founder-thread-notifier 的 bot 发送件):
      「⚠️ gate 更新:PR head <old8> → <new8>(QA 证据 commit,QA PASS)。你的批准将绑定新 head。」;
   c. 追发**成功**(拿到 Discord message id)→ 才写新 revisioned binding 行(targetMessageId = 追发消息 id)。
   追发**失败** → **不写**新 head 的 binding 行,记事件 `ship_gate_rebind_notify_failed`;此时 text 批准照常可用
   (session head 已新),reaction 批准对新 head fail-closed,直到重试补上锚点。
   **重试钩子**:rebind 入口幂等——若 session.pr_head_sha 已等于 reported sha 但当前 head 无 binding 行,
   则只重做 b+c(下一条 qa_result 重发/下一轮 pass 自然触发)。
   产品语义写明:rebind 后 founder ✅ 在**旧** gate 消息上 = 失配 no-op(她看到的旧消息标着旧 sha,fail-closed 正确);
   追发消息就是新的可 ✅ 对象。
4. 审计事件 `ship_gate_rebound`(old/new sha、questionId、追发 message id)。
已有 response → 永不 rebind(exploration §4③ 场景走 Fix C)。

### 2.2 与批准写入的竞态
write-gate-response / gate-response-router 写响应时的既有校验(current review question)不动;
rebind 只改 pr_head_sha 不改 questionId,所以两序都安全:
先批准后 rebind → rebind 条件 3 拦住(退化为现状,走 C);先 rebind 后批准 → verify 读到新 sha,通过。

### 2.3 Codex hard gate 连带(不改代码,改协议文本)
rebind 后若新 head 无 codex_review_record,verify 以 `codex_review_not_approved` 拦——**保留**。
runner 协议(Blueprint APPROVE GATE 文本,Fix F 一并改):gate 后确需 push → 立即对新 head 补 codex review(resume 增量)+ 重发 qa_result。

### 2.4 触点与测试
- `auto-qa-coordinator.ts`(分叉点)、`StateStore.ts`(setter + 迁移无:复用列)、`gate-message-binding-store.ts`、
  审计事件、env `FLYWHEEL_SHIP_GATE_REBIND=0` 短路回 drop 现状。
- 测试:①全条件满足 → 三写一发全发生;②各条件逐一不满足 → 精确回 drop(现状字节);③祖先校验假 sha → drop;
  ④已有 response → 不 rebind;⑤`=0` reverse-compat;⑥真 git 仓 fixture 跑 merge-base(不 mock git)。

## 3. Fix C(P1)— FSM 重 review 恢复边

- `packages/core/src/workflow-fsm.ts`:`approved_to_ship` 目标集加 `"awaiting_review"`。
- 三 sink + CLI 同步(FLY-208 的四处一致律),判据统一为:
  `approved_to_ship + session_completed(route=needs_review) + completion 携带的 reviewQuestionId 存在且 ≠ session 现绑定 + 无 merged landing`
  → 映射 `awaiting_review`(+ 重绑 question/pr_head,复用 needs_review 既有绑定写路径);
  **无新 questionId** 的该组合 → 维持 FLY-208 5a(completed + evidence-gap 标记)。
  - `event-route.ts:~1136` / `DirectEventSink.ts:~430`:两处本就拿得到 session 与 completion payload,就地加分叉。
  - `complete-marker-reconciler.ts:~205`:**API 显式扩参**(Codex R1 #5)——`expectedStatusFromMarker`
    现只收 `(body, currentStatus)`,判据里的「新旧 questionId 对比」做不了。改为传入
    `currentReviewQuestionId`(来自 session 行),marker `body` 侧确认/补齐 `questionId` 字段
    (`complete --route needs_review --question-id` 已把它写进 completion payload,reconciler marker 若缺该字段则补上,
    缺失时 fail-safe 回 FLY-208 5a completed)。三处判据必须同一 commit 落地 + 各自矩阵测试,防 FLY-208 式 sink 漂移。
  - `flywheel-comm complete.ts`:提示文本补充(从 approved_to_ship 重开 review 必须带新 `--question-id`)。
- 测试:FSM 表测试 + 每个 sink 的组合矩阵(新/旧/缺 questionId × landing 有无 × route),旧组合逐字节回归;
  reconciler 扩参后旧调用形态的兼容测试。

## 4. Fix D(P1)— 外部 merge 收敛兜底

- 挂点:GatePoller patrol 节奏(每 20 tick,零新 timer)新 pass `externalMergeReconcilePass()`:
  1. parked(awaiting_review/approved_to_ship)且 idle 超 TTL(复用 FLY-742 的 staleAnchor + TTL 思路,默认 30min)
     → 核 PR 真实状态;**MERGED(且仅 MERGED)** → 进入统一收尾(见下)。
  2. completed-but-unfinalized:status=completed、有 pr 线索(pr_number 或 head)、chat thread 未归档(archive-once 表)、
     `last_activity_at` 在近 `FLYWHEEL_MERGE_RECONCILE_WINDOW_DAYS`(默认 7)内 → PR MERGED 则进入统一收尾。
  - **只复用 FLY-742 的「有界 gh 查询」模式,不复用它的 finalizer**(Codex R1 #4):stale-blocker 的 finalizer
    把 closed 也当 finalize_proceed、直推 completed + 归档,绕过 `runPostShipFinalization` 与 FLY-869 的
    ship-eligibility seam——对本 pass 是错的。gh 查询统一扩为 `state,mergedAt,mergeCommit`(拿 merge 证据,不只 state)。
    收尾按候选类**分两条路**(Codex R2 #1:`computeShipDecision`→`verifyApproval` 硬要求状态 = approved_to_ship,
    对已 completed 的行必然 `status_not_approved_to_ship`,不能共用):
    - **路 1(parked:awaiting_review / approved_to_ship)**:pre-transition 跑 FLY-869 `computeShipDecision`
      (approval + codex + QA)——不 ship-eligible 的 merged session 按既有 merge_block 语义 park(不收尾、不归档),
      与 merge-ship-gate 一致;eligible → 合成 merged landing 证据(mergeCommit oid)→ completed 转换 →
      `runPostShipFinalization`——与 DES/event-route 的 recovered-merge 路径同 seam。
    - **路 2(completed-but-unfinalized)**:不碰 verifyApproval(状态检查冲突),用**窄域恢复校验**,
      且必须 **head-aware**(Codex R3 #1:没有 head 关联的「founder 批过」区分不了「批的是旧 head、
      后面又被人工 merge 了没批过的 commits」——那种残局该被看见,不是被归档):
      ① bound `review_question_id` 的 response 存在、结构化 `{approved:true}`、归属 ∈ Fix E 的可信集
      (founder id / "bridge" / "bridge-founder-consent";复用 E 的归属 helper);
      ② gh 查询扩带 `headRefOid`:**merged PR 的 head 必须精确等于 session 的 bound `pr_head_sha`**。
      ①+② 都过 → 合成 merged landing → 直接 `runPostShipFinalization`(状态已是 completed,无转换)。
      任一不过 → **不收尾、发 Lead alert**(rogue / 批准-head 与 merge-head 脱节的 merge 要被看见)。
      v1 刻意只认 exact head match(最强且实现最稳——completed session 的 worktree 可能已清,ancestry 校验
      不可靠);「bound head 是 merged head 祖先 + merged head 有 codex/QA 证据」的放宽形态留作观察 alert 量后的
      可选扩展,不进本 PR。当晚 FLY-921 残局(批准绑 923c48d0、merge head 4ac0df03)在此规则下走 **alert**
      而非自动归档——符合语义;该残局今晚已由 Lead 手动归档,属一次性人工恢复,不倒灌成自动化规则。
  - PR open/unknown/**closed-unmerged 一律不动**(closed≠merged,可能是 reject 场景)。
    gh 调用节流:每 pass 每 project 上限 N(默认 3)个候选,轮转推进。
- env:`FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0` 短路。事件 `external_merge_finalized` 审计。
- 测试:mock gh 状态矩阵;finalize 幂等(archive-once);节流;`=0` reverse-compat;
  **路 2 两个结局锁死**(Codex R4 备注):exact merged-head match → finalize;
  旧 head 可信批准 + merged 新 head → alert 且不归档;并断言 completed 行仍保有 bound `pr_head_sha`
  (恢复路径依赖 upsertSession 保留未指明字段的既有行为)。
- 明确定位写进代码注释:兜底收敛器,executor-merge 同时被 F 退役——这不是许可。

## 5. Fix E(P1)— verify-approval founder 归属校验

- **读侧**:`packages/flywheel-comm/src/commands/verify-approval.ts` 结构化校验通过后加:
  `responseFrom ∈ { canonicalFounderId, "bridge", "bridge-founder-consent" }`,否则新 reason
  `response_not_founder_attributed`(fail-closed)。
  - founder id 解析:复用 FLY-827 的 `~/.flywheel/.env` 活读模式,读 `DISCORD_OWNER_USER_ID`
    (test 注入口沿用 codexDotenvPath 同款参数模式);**解析不到 → 跳过本步**(feature-off 语义,文档写明诚实边界)。
  - kill-switch:`FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0`(同样 `~/.flywheel/.env` 活读)。
- **写侧(Codex R1 #2,必须与读侧同 PR)**:`gate-response-router.ts` 现在 pass-through 与 consent-allow
  两条路都把 **leadId** 写进 response.from_agent——只改读侧会把「founder-consent 验证通过的合法批准」也拒掉。改为:
  - **仅 enforce 路径的 `decision === "allow" | "bypass"`** 写 `from_agent = "bridge-founder-consent"`
    (leadId 已在 founder_consent_audit 行里,审计不丢);
  - **audit_only 明确保持写 leadId**(Codex R2 #2):audit_only 的语义是「记录但总放行写入」,连 **deny** 都会写
    response——若 naive 地把 allow 分支统一改可信归属,audit_only+deny 就变成 verify 可过的可信批准,
    Lead 自批之门重开。故 audit_only 写 leadId → 被读侧拒(除非 QA/应急 kill-switch),**deny-case 单测锁死**:
    audit_only + evaluator deny → response 落 leadId → verify `response_not_founder_attributed`;
  - **pass-through**(DECISION_MODE=off,无 consent 校验):**保持写 leadId** ——被读侧拒**正是** E 的本意
    (off 模式下 Lead respond 自批不再能过 verify;合法通道 = FLY-799 founder 文字/reaction、dashboard
    `/api/actions/approve`("bridge")、QA 房 kill-switch、应急 BYPASS+kill-switch 组合);
  - idempotent-retry 分支:沿用 prior response 的归属(不重写行)。
  - 模式矩阵测试:off-passthrough / audit_only-allow / **audit_only-deny** / enforce-allow / enforce-deny / bypass
    × 读侧判定;部署窗口兼容:重启前已写入的 lead 归属批准在重启后 verify 会被拒 → rollout 注明「在途 approve 需重批」。
- QA 框架影响清单(implement 时 grep 落实):`packages/qa-framework` / `scripts/test-slots` / 529 房驱动脚本里
  所有 lead-respond 批准路径 → slot env 注入 `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0`(或改走带 founder id 的 respond)。
- 测试:归属矩阵(founder id / "bridge" / "bridge-founder-consent" / leadId / FOUNDER_AGENT("founder-bridge-auto",
  **注意**:它只写非 gated 答复,出现在 approve_to_ship response 上本身就异常 → 拒)× id 缺失 × kill-switch;
  既有全部用例在 `=0` 下逐字节回归。

## 6. Fix F(P1)— 纪律文本(零代码)

- `packages/teamlead/lead-rules-base/founder-only-authority.md`:新节「executor-merge 退役(FLY-945)」——
  founder 批准后 Lead 零动作;runner 不动 → 诊断/升级,不代 merge;附 FLY-921 时间线反例。
- `packages/edge-worker/src/Blueprint.ts` APPROVE GATE 段:补「gate 开启后 push 需立即补 codex review + 重发 qa_result(触发自动 rebind);禁止在无重 review 的情况下让 head 漂移」。

## 7. 测试与 QA 总策略

- 单元/集成:各 Fix 内嵌(上文);全仓 `pnpm lint` + 触及包全测绿。
- **真机独立 QA(Annie 规矩:默认真 Discord E2E,跳过须先问)**,529 房场景清单:
  1. 主链:runner 开 gate → founder(测试号)thread 里发「ship it」→ ≤75s 批准落库(归属 founder)→
     runner verify 过 → 自 merge(测试仓)→ completed → 标 Done + thread 归档全自动。
  2. head 漂移:gate 开后补 push + 重发 qa_result → 观察 rebind 追发消息 → founder 批准 → verify 过(新 head)。
  3. 过期批准恢复:批准后再 push → mismatch → runner 重开 review(新 question)→ FSM 回 awaiting_review(Fix C)。
  4. 外部 merge 兜底:人工 gh merge → reconcile pass 在 TTL 后收敛 → 归档级联触发。
  5. 归属拒绝:Lead respond 自批 → verify 拒 `response_not_founder_attributed`。
- 事故重放对照:用 FLY-921 的事件序列做 fixture,断言新代码下 02:56 的批准在 02:57 前落库。

## 8. 上线与回滚

- 全部 Bridge 侧(+flywheel-comm CLI dist)→ **一次 batched Bridge 重启**生效(遵循「多 PR 攒一次重启」惯例);
  runner 侧只有 Blueprint 文本(spawn 时现读,无需重启)。
- 逐项 kill-switch(§1-5)可单独回退;全关 = 字节回到今晚的行为。
- 部署后验证由独立 QA 做(不自证):重放场景 1(真 founder 文字批准走通全链)+ claims/DB 铁证。

## 9. 风险表

| 风险 | 缓解 |
|---|---|
| A1 循环重写破坏 at-least-once | 不变量测试矩阵(§1.3②③)+ cursor 推进规则单测锁死 |
| B 祖先校验在 worktree 缺失/已清理时误判 | 缺 worktree → 不 rebind(fail-closed 回 drop 现状) |
| D 误归档还活着的 issue(参考 task#117 归档级联误伤先例) | 只认 gh MERGED + TTL + archive-once + 窗口 7 天 + kill-switch |
| E 弄死没配 founder id 的项目 / QA 房 | id 缺失=跳过;QA 房显式 `=0`;grep 清单落实 |
| FSM/三 sink 映射不同步(FLY-208 前车) | 四处同一 commit 改 + 每 sink 矩阵测试 |

## 10. 里程碑

1. commit A(deliverer 快路径)+ 测试
2. commit B(rebind)+ 测试
3. commit C(FSM+三 sink)+ 测试
4. commit D(reconcile)+ 测试
5. commit E(attribution)+ QA 框架 env 落实 + 测试
6. commit F(文本)+ docs
7. Codex code review 循环 → 独立 QA(529 房 §7)→ founder gate → self-ship(吃自己的狗粮:本 PR 就该走 A-F 修好的链)

版本注:plan 不锁版本号,实际 ship 时取当时空号(照 FLY-217 先例)。
