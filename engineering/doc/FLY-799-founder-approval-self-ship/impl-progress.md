# FLY-799 实现进度 breadcrumb（供 context 续接精确定位）

Issue: FLY-799 (https://linear.app/geoforge3d/issue/FLY-799/infrafounder-facingp1-ship-流程重构founder-discord-批准-归属-founder-runner-自)
日期: 2026-07-02
基于: plan.md（Codex design review 8 轮 APPROVED）

> 分支 `flywheel-FLY-799`。全 default-ON + kill-switch。TDD。**绝不自 ship**。
> 做完 → PR → Codex code review → 独立 QA → hold approve gate（等 founder）。

## ✅ 已 landed（6 模块,64 测全绿,均 commit)
全在 `packages/teamlead/src/bridge/approval-signal/`(+ 对应 `__tests__/`):
1. `tier2-allowlist.ts` — Tier-2 精确短句 allowlist(零 AI,防误批,号匹配)。29 测。`949a174d`
2. `canonical-founder-id.ts` — A-1 单一 founder id 派生(缺/冲突→null fail-closed)。6 测。`d2d64bdf`
3. `subscription-claude-classifier-runner.ts` — A-3 订阅 Haiku headless(`claude -p --model claude-haiku-4-5-20251001 --output-format json`,execFile 无 shell,fail-closed 全失败→ok:false)。8 测。`9e44ea9d`
4. `founder-ship-approval-classifier.ts` — Tier-3 classifier(建 prompt + evidence_message_id===expectedMessageId 绑定)。9 测。`60b1a9f0`
5. `types.ts` — `ApprovalSignal` discriminated union + `GateBinding`。
6. `text-approval-source.ts`(TextSource:身份→Tier2→Tier3)+ `reaction-approval-source.ts`(ReactionSource:包 `checkReactionConfirmation`,✅ only,绑 targetMessageId)。12 测。`0cea1789`
7. `gate-message-binding.ts`(A-0b 纯核):`extractGateMessageId`(解 Discord create-message .id)+ `bindingEventId`(write-once)+ `selectCurrentBinding`(fail-closed 恰一个 questionId+prHeadSha)。8 测。`3a39b577`
8. **notifier 集成**:`founder-thread-notifier.ts` `postFounderThreadCore` ok 时解析 body 拿 message id、经 `FounderThreadNotifyResult.gateMessageId`(optional)返回。byte-compat(13 现存 notifier 测仍绿,milestone 路径不受影响)。`424af478`

实测过:headless Haiku 走订阅可跑(~7.5s,无 API key);`--output-format json` envelope = `{type,subtype,is_error,result,...}`;Discord create-message 返回 `{id,...}`。

9. `image-approval-source.ts`(ImageSource:身份→MIME/size 过滤→注入多模态 classify→evidence 绑定 evidenceMessageId + evidenceAttachmentIds⊆valid)。8 测。`2054f00f`

**多模态实测 OK(claude -p @image 订阅可读)。但 Annie 拍 B(Tadashi 澄清):v1 只开『打字+✅』,ImageSource 代码建好但 v1 放自己的 flag `FLYWHEEL_FOUNDER_IMAGE_APPROVAL` **default-off**,图片作 799 内 fast-follow flip-on。别 v1 就 ON。**

10. `gate-message-binding-store.ts`(A-0b StateStore 持久化,write-once,真库测,4 测,`2f964665`)
11. `fanout-finalization.ts`(Part C:`collectRelatedNodes` feature↔QA + `isQaSafeToFinalize` 只 PASS,3 测,`cd6b9089`)
12. `write-gate-response.ts`(A-4 共享受信任写原语,结构 deps,8 测,`57d94c70`+`9df95163`)
13. `founder-ship-approval-handler.ts`(**keystone**:身份→A-2 收窄一 gate→TextSource→共享写,7 测,`265cdad9`)
14. **deliverer byte-compat 接线**:`founder-reply-deliverer.ts` ship 分支加 optional `tryFounderShipApproval`(absent→WAKE-only 逐字,11 现存测绿,`b0f20155`)

**累计 13 功能模块 126 测全绿(含现存 deliverer 11 + notifier 13,byte-compat 验过)。文字批准端到端全通:founder 文字→身份→A-2 收窄→TextSource→写 {approved:true} 归属 founder→(hook)翻状态+唤醒。**

## 🔜 剩余 = 生产 plumbing
0. **build worktree deps 才能跑测**:`pnpm --filter "flywheel-teamlead^..." build`(gate-poller/deliverer import 真 flywheel-comm/db + flywheel-core)。已建。

### ✅ 已 landed（本轮续接）
- **文字批准端到端 wire**(`c03d0cf8`+`62570620`):`startBridge` 建 `makeFounderShipApprovalCallback`(canonicalFounderId + store + denylist + onResponseWritten)→ 传进 GatePoller.config.tryFounderShipApproval;deliverer ship 分支已接。共享 flip+wake 从 wiring 抽成 `buildGateResponsePostWriteHook`(Surface B + founder-reply 同一真相)。
- **binding 写**(`358978ae`):`maybeEmitFounderThreadFallback` 在 posted approve_to_ship ping 后 `writeGateMessageBinding`(写前核 awaiting_review + review_question_id===qid + pr_head)。write-once。
- **✅ reaction 端到端 wire**(`358978ae`+`48b653a3`):`founder-reaction-approval-handler.ts`(per-gate,读 binding→evaluateReactionSource→共享写)+ `founder-reaction-approval-factory.ts`(同文字 gating,reactionFetcherImpl 是 per-call arg=per-lead botToken)+ gate-poller `founderReactionApprovalPass`(枚举 pending approve_to_ship gate,建 per-lead Discord reactions fetcher,per-qid 15s 节流,piggyback founder-reply sub-cadence,自限=flip 后掉出 awaiting_review filter)+ plugin `makeFounderReactionApprovalCallback`(readBindingImpl=readCurrentGateMessageBinding)。**14 新测 + 18 gate-poller founder 测 + full teamlead build 全绿。**

### ✅ 已 landed（续接第二轮 — 全部 plumbing 完成）
- **Part B re-wake reconciler**(`67a2eea3`):`stale-approved-ship-reconciler.ts`(isRewakeCandidate 纯核 + reconcileStaleApprovedShip 注入式)+ gate-poller `staleApprovedShipReconcilePass`(默认-ON `FLYWHEEL_STALE_SHIP_REWAKE`,tmux 探活→活=re-wake approval / 死=alert 一次 defer 795,per-session backoff + 跨-pass dead dedup)。11 测。
- **Part C 审计结论(Tadashi 拍)**:issue 说的 fan-out(close runner/QA/worktree/thread/cmux)现有机制**已全覆盖** —— auto-qa-coordinator 在 QA-pass 当刻 `closeQaRunner`(auto-qa-coordinator.ts:644),`runPostShipFinalization` 在 ship 做 feature tmux+worktree+thread archive。→ **(a) 跳过冗余 ship-时 QA fan-out**;`collectRelatedNodes`/`isQaSafeToFinalize` 保留作防御模块不接主 finalization。
- **auto-Linear-Done-on-ship**(`de1dc387`,Part C 真缺口):`linear-issue-finalizer.ts`(`markLinearIssueDone` 解 completed-type『Done』state + name fallback,best-effort never throw;`makeLinearDoneFinalizer` 默认-ON `FLYWHEEL_AUTO_LINEAR_DONE`)→ `runPostShipFinalization` optional `markIssueDone` dep(结构性 ship-success gate=只在 merged 证据跑)→ 3 call site(DirectEventSink + event-route ×2)。9 测 + 68 post-ship/event-route 回归绿。
- **ImageSource default-off scaffold**(`baa4cfff`):handler image 分支(注入式,image approve/reject 权威、unclear→落文字)+ factory `FLYWHEEL_FOUNDER_IMAGE_APPROVAL=1` opt-in(默认 OFF,per-call)+ evaluateImageImpl passthrough(v1 未接=即使 flag on 也 inert)+ msg.imageAttachments optional。16 测。**flip-on fast-follow(default-off 故 inert)= deliverer download+sha256 + 生产多模态 evaluator**。

### 🔜 未做(明确 out-of-v1)
- gate-response-router 改用共享 `writeGateResponseAndRunPostWrite`(可选 dedup,风险,skip)。
- ImageSource flip-on(default-off fast-follow):deliverer 附件 download+hash + 生产多模态 classifier。

## 全部 flag(default 值)
- `FLYWHEEL_FOUNDER_AUTO_APPROVE`(默认 ON,`=0` kill)+ `FLYWHEEL_FOUNDER_AUTO_APPROVE_DENYLIST`(逗号分隔 project)
- `FLYWHEEL_FOUNDER_IMAGE_APPROVAL`(默认 OFF,`=1` opt-in;v1 inert)
- `FLYWHEEL_STALE_SHIP_REWAKE`(默认 ON,`=0` kill)
- `FLYWHEEL_AUTO_LINEAR_DONE`(默认 ON,`=0` kill)

**总计 179 FLY-799 测 across 21 files 全绿 + full teamlead build + full-repo biome lint(0 error)。**

--- 旧笔记（细节保留）---
1. **A-0b 绑定持久化(纯核 + notifier 已做)**:剩 = ① StateStore 写/读绑定方法(用 `insertEvent(bindingEventId(qid), payload=GateMessageBinding)` write-once + 读回 helper);② `gate-poller.ts` `maybeEmitFounderThreadFallback`(approve_to_ship 分支)在 notifier 返回 `gateMessageId` 后写绑定(写前核 session awaiting_review + review_question_id/pr_head 未变)。ReactionSource evaluate 时读 `selectCurrentBinding` 取 targetMessageId。
2. **ImageSource**(`image-approval-source.ts`):founder 图片附件 → 多模态 classifier。**前置:先实测 `claude -p` 是否支持图片附件输入(base64/文件路径);不支持 → v1 feature-gate(env 关),绝不退化成文字**。证据到附件级(sha256 + evidenceAttachmentIds)。`RawDiscordMessage` + fetch 扩到含附件。
3. **共享 `writeGateResponseAndRunPostWrite`**:从 `founder-consent/gate-response-router.ts`(L235-268 幂等)+ `wiring.ts`(`onResponseWritten` L153-223)抽出;Surface B 与 founder-reply 共用。含 checkpoint/当前-question/status 守卫 + 相同批准 retry + 冲突拒 + retrySafe 才让 cursor 前移。export `onResponseWritten` + helper 供 deliverer。
4. **deliverer ship 分支接线**:`founder-reply-deliverer.ts` `processFounderMessage` 的 ship 分支(现只 WAKE,L238-297)改为:身份验证(canonicalFounderId)→ A-2 收窄恰一个当前 ship gate(status=awaiting_review && review_question_id===qid)→ 调 sources(Reaction/Text/Image)→ 明确 approve → 共享 helper 写 `{approved:true}` actor=真实 founder id + audit(user id + msg id + questionId + prHeadSha + node set)→ onResponseWritten 翻状态+唤醒。含糊/reject/非本人→WAKE-only。装配在 `gate-poller.ts` `founderReplyDeliverPass`(L1795-1883)注入 sources + helper + canonicalFounderId。reaction 独立 per-gate poll(不共享文字 cursor)+ bounded backoff + durable signal marker。
5. **Part C fan-out**(`fanout-finalization.ts`):shipped runner 自 ship 触发 `runPostShipFinalization` 后,`collectRelatedNodes` = root + 其 `auto_qa_record` QA(**甲:只 feature↔QA,无 sub-issue 树**)→ `cleanupNode`(`closeRunner{finalizeDone,archive}` + `removeCleanWorktree` + 抽 `LinearIssueFinalizer.markDone` 从 plugin.ts L1882-1938)。per-node marker + reconcile;只收尾已 PASS QA;best-effort 失败告警不回滚。
6. **Part B re-wake reconciler**(`stale-approved-ship-reconciler.ts`):默认-ON 安全前提。startup+bounded scan 扫 flag-ON+stale `approved_to_ship`(有 review_question_id/pr_head_sha/PR#)→ durable claim `(execId,questionId,prHeadSha,prNumber)`+marker+crash adopt → re-verify(复用 `verifyApproval`,PR live head===session pr_head_sha;merged→只 finalize;mismatch/closed/429→fail-closed+alert)→ **只 re-wake 活 runner**(不自 post :cool:);真死→alert+待 795。**不读 795 progress.md**(消费需求→Tadashi→795,不各造)。
7. **装配 + flag**:`plugin.ts` 装 sources+helper+canonicalFounderId+`FLYWHEEL_FOUNDER_AUTO_APPROVE`(默认 ON,`=0` kill-switch)+ per-project denylist。reverse-compat sentinel(`=0`=逐字旧 WAKE-only)。

## 关键复用点（已确认）
- reaction 轮询:`lead-backends/codex/gateway/founder-confirmation.ts` `checkReactionConfirmation`(分页+fail-closed)。
- 收尾原语:`bridge/close-runner.ts` `closeRunner{finalizeDone,archive}`;`bridge/auto-qa-effects.ts` `closeQaRunner`(L463);`bridge/post-ship-finalization.ts` `runPostShipFinalization`。
- QA 边:`auto_qa_record` 表(StateStore L1242,parent_execution_id↔qa_execution_id+qa_issue_id)。
- 写路径信任:`verify-approval.ts`(不校验 responseFrom)+ `respond.ts` GATED_CHECKPOINTS 锁写。
- runner 自 ship:`edge-worker/src/Blueprint.ts` APPROVE GATE L1145-1177(verify-approval→:cool:,不改)。

## 测试基建
worktree 需 `pnpm install`(已装)。跑测:`cd packages/teamlead && pnpm exec vitest run <file>`。format:`pnpm exec biome check --write <files>`。
