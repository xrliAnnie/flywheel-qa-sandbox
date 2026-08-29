# FLY-818 M3 — founder-page delivery contract:实现 handoff 笔记

Issue: FLY-818 (https://linear.app/geoforge3d/issue/FLY-818/infraepicrobustness-系统健壮性追踪-runner-完成idle-不上报-founder-lead-status-不准)
日期: 2026-07-03
基于: plan.md §3.1 / §M3(Codex design review R1#2 + R2#2,已 APPROVED）

> 这是 PR-1 的第二块(② = 818 最初痛点『真卡住没人告诉 founder』的正解)。**Lead 定:清醒专注做、不在长会话尾巴赶。** ① 已全 commit(到 900f494a);M3 从这份笔记接着做。**M3 仍进 PR-1**(PR-1 = ①+② 一起开 PR → Codex code review → 独立 QA)。

## ✅ 设计定稿 · issue-thread(Annie 定 · 2026-07-03 · lead-instruction 7bb06c0f + 纠正 0807c747)

**这是最终有效设计 —— supersede 下面所有 DM / alert-channel 描述。** Annie 原话:「哪个 issue 卡住了,就在哪个 issue thread 里发。」不是 DM、不是独立 alert channel。

> **走了两次弯路**:先做了 channel-only(alert channel @founder,f1d82ec6),但那正是代码库 **FLY-523 已否决**的路 —— `founder-thread-notifier.ts` 文件头原话『never the FLY-368 alert channel — that was the rejected FLY-523 path』。FLY-605 早就把它改成「发 per-issue thread」。Annie 的 redirect = 回到 FLY-605 既定模式。

- **去掉 DM(B)和独立 alert-channel(A)两条路径。**
- **founder-page = 往那个卡住 runner 自己的 [FLY-XX] issue chat_thread post 一条带真 `<@founder>` 的消息**,复用 FLY-605 现成的 issue-thread 推送通道(`founder-thread-notifier.ts` 的 `postFounderThreadCore`,`allowed_mentions:{users:[owner]}`)。
- **用 stuck runner 所属 lead 自己的 bot**(`lead.botToken ?? config.discordBotToken`)—— 不是 FLY-368 Hub 的 repair-chain bot(那个是 alert channel 的,不一定能发进 lead 的 chat channel)。
- **`founder_paged` 的 resolve = 「issue-thread post 真成功(posted)」为准**。`no_chat_thread` = transient(thread 可能稍后才建)→ detector 重试(at-least-once)。ledger 单调去重照旧(别刷屏那条 thread)。

### 权威 wiring(gate-poller 的 FLY-605 fallback 在用,逐字照抄)
```
thread     = store.getChatThreadByIssue(session.issue_id, lead.chatChannel)  // Linear UUID + lead.chatChannel
botToken   = lead.botToken ?? config.discordBotToken
ownerUserId= config.discordOwnerUserId  // snowflake 校验
POST /channels/{thread.thread_id}/messages  body={content, allowed_mentions:{users:[ownerUserId]}}
```

### 架构落点(no secrets in payload)
- founder page **在 `createStuckUnhandledAlerter`(stuck-escalation.ts)里发** —— 它手头就有 `session`(issue_id/identifier)+ 已解析的 `lead`(botToken/chatChannel)。**不能把 botToken 塞进 AlertPayload metadata**(会漏进 audit/log;AlertResult 注释明写『Never carries a token』)。所以 founder page 走 payload 流之外、由持有 `lead.botToken` 的 alerter 直接发。
- **revert Hub M3**:`ensureFounderPaged` / `unifiedChannelId` / `postToChannel` / `AlertResult.founderPaged` / handle() 里的 founder 调用全撤 —— Hub 回到 pre-M3(只管 alert-thread + auto-repair)。
- ledger(`founder_page_ledger` + `recordFounderPaged`/`getFounderPaged`)留在 StateStore,converge 逻辑移进 alerter。
- 新增 `emitFounderStuckNotification`(founder-thread-notifier.ts,复用 `postFounderThreadCore`)。

### gating(Lead 拍 default-ON · ask dd4bee23,surface 给 Annie 最终确认)
② 是 reliability 修复、也是 818 最初痛点。alert-channel 版靠 Hub 存在才 on;issue-thread 版不需要 Hub。**Lead 拍板 (i) default-ON + kill-switch `FLYWHEEL_STUCK_FOUNDER_PAGE=0`**:安全网 default-off 等于没做(合 Annie『真卡住必须有人告诉我』+ 她的 default-enable 原则),且只在真卡住 edge case 才 fire、风险低。额外要 owner id(`config.discordOwnerUserId`)+ store,缺则 legacy byte-compat(default-on 也不 retry-storm 未配置的 Bridge)。① autocontinue 半仍 default-OFF(`FLYWHEEL_RUNNER_AUTOCONTINUE=1`)。Annie 若改主意 = 一行翻回 `=== "1"`。

- 返工影响:#434 head 变 → **重过 Codex code review** → 独立 QA 真机验(真卡住 → 它自己的 [FLY-XX] thread 真出现 @founder 的 page + ledger 收敛零 spam,不碰真账号 DM)。排 793 batch 后、不急、稳着改。改完 hold 等 QA + founder。

## 目标(一句话)
runner **真卡住**(`runner_stuck_unhandled` fires = Q7 fallback,已过 Lead-first grace、Lead 没处理)时,**founder 被可靠 @page 直达、不靠 Lead 转发**。

## 现状锚点(已审计,file:line)
- `createStuckUnhandledAlerter`(`packages/teamlead/src/bridge/stuck-escalation.ts:427-492`)现返 `sent || queued || skipped==="duplicate"`。
- `StuckDetector` 在 `alertUnhandled` 返 true 时置 `annieAlerted=true` **并停重试**(`stuck-runner-detector.ts:540-555`)→ 所以「返 true 但没真 page」= 永久漏报(**正是要修的 bug**)。
- `AlertResult`(`LeadAlertNotifier.ts:114-117`)= `{sent?, skipped?, queued?}`,**无 founderPaged**。
- `LeadAlertNotifier` root alert **显式 `allowed_mentions:{parse:[]}` 不 @**(`:693-715`)。
- `AlertChannelHub` 真实 `<@founder>` **只**在 AutoRepairBot 返 `needs_human` 分支发(`AlertChannelHub.ts:295-330`);nudge "attempted" **不 @founder**(`AutoRepairBot.ts:134-165`)。
- Hub 的 founderId 校验:`AlertChannelHub.ts:327-330`(只认 17-20 位 snowflake;非法返 undefined)。
- FLY-368 已 merged 在 main(Lead 确认:#327/#330/#339),AlertChannelHub 现成、M3 基于 main。

## 改动(4 点,谨慎)
1. **`AlertResult += founderPaged?: boolean`**(byte-compat optional;其他 caller 忽略)。
2. **`AlertChannelHub`:对 `eventType==="runner_stuck_unhandled"` 保证 @founder**——不依赖 AutoRepairBot outcome(nudge 成功也要 page,因为这是 Q7 past-Lead 的 fallback = 793『Lead 漏了』场景)。post 成功 + founder id 合法 → 在 handle() 返回的 result 上置 `founderPaged=true`;founder id 缺/非法 / thread post 失败 / deadletter → `founderPaged=false`(可观测 + 不置 annieAlerted)。
3. **`createStuckUnhandledAlerter` return 语义**:
   ```
   if (result.founderPaged !== undefined) return result.founderPaged;   // Hub 路径:只在真 page 才 true
   return result.sent === true || result.queued === true || result.skipped === "duplicate"; // Hub-off byte-compat fallback
   ```
   → Hub on(生产)= 新的『真 page 才 resolve』语义;Hub off(测试/非生产)= 逐字旧行为(byte-compat)。
4. **跨 duplicate 去重 founder-page event 本身**(Codex R2#2):duplicate 的 `founderPaged` 要反映**原 send 是否真 page 了 founder**(持久化 per-eventId 的 founder-paged 状态,duplicate 查它)——不能只 dedup root alert 就当 paged。可复用 AlertChannelHub 的 alert-thread 行 / eventId 持久状态。

## 测试矩阵(必须全覆盖,Codex R1#2 + R2#2)
- Hub on/off;`FLYWHEEL_ALERT_THREADS` on/off;
- AutoRepairBot attempted vs needs_human(两种都要 @founder for runner_stuck_unhandled);
- founder id missing / invalid(→ founderPaged=false、不置 annieAlerted、可观测 error);
- thread create/post 失败、deadletter/queue 失败(→ 不置 annieAlerted);
- root-only duplicate that never produced founder page(→ 不 resolve);
- **断言『no real founder page ⇒ `alertUnhandled` false / detector 会重试』**(不只断言有 log/deadletter);
- byte-compat:非 runner_stuck_unhandled 事件行为不变;Hub-off fallback = 旧行为。

## QA 硬要求(Lead 特别强调 —— 别踩老坑)
**独立 QA 必须真机验「@founder 真的送达 Annie 眼前」**(不只逻辑返 true / 不只加进 thread)。之前踩过「以为加进 thread 就行、Annie 还是没看到」的坑 —— founder-page 要**真到她眼前**(真 Discord @mention 推送到她)才算数。

## 不确定就问 Lead
368 hub 那块(尤其 founder-page 去重的持久化位点 + Hub handle() 里 founderPaged 的置位时机)拿不准 → 问 flywheel-eng-lead。

## 完成后
M3 + ① 一起:全仓 `pnpm lint` + teamlead tsc + 全 autocontinue/stuck 测 → 开 PR-1 → `stage set pr_created`(Bridge 触发 Codex code review)→ 迭代到 APPROVED → 独立 QA(含上面真机 @founder 验)→ founder ship。
