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

**累计 8 模块 72 测 + notifier byte-compat 集成。**

## 🔜 未做（整合层,按序,touch 现有 Bridge/StateStore 码)
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
