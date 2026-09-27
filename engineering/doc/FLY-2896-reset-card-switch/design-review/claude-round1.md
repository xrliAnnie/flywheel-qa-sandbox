# Design Review — plan.md (Claude Round 1)
Status: CHANGES REQUESTED

## Summary

大方向是对的：守护进程提议，Bridge 征得同意，守护进程执行。这个分工遵守 FLY-1456。单写者文件、结构性的 `ApprovedRedeem`、先落 requestId 再 POST、store 不加 triggerKind、新配置键不连坐，这些选择都站得住。但对照代码，有 9 处会让功能失效、误取消、在卡已花掉后把号卡死，或者让验收台架误切生产号。其中 3 处直接关系到"花卡是否正确或会不会重复"（B1、B2、B7）。

已核实为真的前提：`checkReactionConfirmation` 接受 `emoji?` 参数（founder-confirmation.ts:122-131）；`excludedBy` 确有 `"quota"` 和 `"cooldown"` 两个码（account-candidate-selector.ts:244、:304）；`parseConfig` 忽略未知键（quota-monitor-config.ts:78-139）；`ROUTING` 用 `satisfies Record<Kind,…>` 约束，是按 kind 固定的。

## What's Good

- I1 用类型把"只有 `bindApproval` 能构造 `ApprovedRedeem`"做成编译期保证，并配了只允许 `reset_rate_limits` 出现在一个模块的负向守卫。方向正确。
- §5.4 第 4 步"先落盘 requestId 再 POST"，加上"重启后只读判定、不重发"，这个设计是对的。
- I3/I4 的回滚分析准确：`isAccountLastSwitch` 是闭集，`deadProbeStreak` 写法是逐键回落。
- 复核步骤覆盖了 R4 列出的主要竞态：出现可直切号、在用号变了、卡不再是 next_grant。

## Issues

1. **[BLOCKING] consent 没有先按 proposalId 绑定，旧的同意会误伤新提议。** §5.4 第 1 步里 consent 为 `rejected/expired/post_failed` 就把 proposal 置成同名终态，第 2 步 `bindApproval` 失败就把 proposal 置 `cancelled`。两步都没先比较 `consent.proposalId === proposal.proposalId`。守护进程在 §5.3 换了新 episode 以后，Bridge 那边还留着旧卡的 consent。这时候：旧卡的 ❌ 会把新提议直接判成 rejected；旧卡的 ✅ 会让新提议 bindApproval 失败而被 cancelled。
   修法：proposalId 或 digest 不一致的 consent 一律当作"不存在"，不产生任何状态迁移。Bridge 发现 proposal 换了，要先把旧卡编辑成"已取代"，再原子写入新的 `{proposalId: new, state: pending_post, messageId: null}`，之后才允许读反应。messageId 只对它所在的那个 proposalId 有效。补测试：旧 consent 是 approved 或 rejected 时，新 proposal 状态保持不变。

2. **[BLOCKING] 读 ❌ 失败时可能被判成同意。** `checkReactionConfirmation` 遇到 403/429/畸形时返回 `confirmed:false`（founder-confirmation.ts:145-150）。按 §5.6"仅 ✅ 命中 → approved"的写法，如果 ❌ 这一路恰好读失败，而 founder 其实点过 ❌，也会被写成 approved。
   修法：只有 ✅ 返回 `confirmed`，并且 ❌ 返回 `reason === "not_yet"`（确实读成功、确实没人点）时才写 approved。❌ 任何非 `not_yet` 的结果都视为本轮不做决定。补测试：✅ 成功、❌ 返回 429 → 不写 approved。

3. **[BLOCKING] SIGUSR1 唤醒会被早退吞掉，执行位置也没写清。** 唤醒只是再跑一次 tick（quota-monitor-cli.ts:290-301）。`pollOnce` 在 `state.nextUsageDueAt > now && detectedModels.length===0 && !witnessDue` 时直接返回 `local_scan`（quota-monitor.ts 约 1860-1875），所以批准以后可能要等 10–20 分钟才执行。反过来，如果把逻辑放在函数最开头，又拿不到 reconcileActive、transition journal、`authority` 这几道检查的结果，也拿不到在用号本轮的 usage，而第 8 步的 `scope/resetAt` 需要这个 usage。
   修法：放在 reconcileActive 和 authority 检查之后。存在合法的 approved consent 时，像 `witnessDue` 那样强制本轮读 usage。在 `commitSuccessfulObservation` 之后执行，执行完立即 `finish`，不再往下走普通切号逻辑。

4. **[BLOCKING] 用卡切号之后，状态善后缺失，H1 的触发 scope 也没有定义。**
   (a) `pollOnce` 普通成功切号的尾部会设置 `lastSwitchAt`、`observedGeneration`、`reviveEpoch`，清掉 `confirmation` 和 `pendingSwitchFailure`，并调用 `openBlockedRecovery`（quota-monitor.ts 约 2310-2335）。plan 没提这些。H2 场景下 pane 已经撞墙，缺了 `reviveEpoch` 就不会复活 pane；`blockedEpisode` 只会被下一轮 reconcile 静默清掉，不会发恢复通知。修法：把这段尾部抽成共享函数，两条路径共用。
   (b) H1 发生在 `scope===null` 时。批准后第 8 步写的 `trigger:{kind:"quota",scope,resetAt}` 里 scope 没有值。另外 `commitSwitch` 会把转出号的 `quotaExhaustedUntil/switchCooldownUntil` 设到重置时刻（switch-executor.ts:590-595）。如果驱动窗是周窗、在 86% 就批准执行，转出号剩下的 14% 周额度会被冷却锁到周重置，可能是好几天的浪费。
   必须明确选一种语义：一是"批准即执行"，那就要定义 scope 取驱动窗、resetAt 取该窗的重置时刻；二是"提前问、撞墙再执行"（批准先保留，到 `trigger5hPct` 或周 100% 时再领卡），这种要重新定义 30 分钟的批准新鲜度。这是产品决定，请交 Lead 裁定。

5. **[BLOCKING] 冷却中的候选号拿不到用量数据。** selector 对处于冷却的号在读凭据之前就直接 `continue`（account-candidate-selector.ts:227-247），这些号在 panorama 里没有 `usage`。而已满的非在用号几乎都在冷却中，因为被切走时 `switchCooldownUntil` 会被设成重置时刻。§5.3 第 4 步只读 profile 和 cedar，`naturalRecoveryAt` 需要的 `SuccessfulUsage` 没有来源。
   修法：用 `quota-usage-api` 的 `validatePayload`（导出即可）从 cedar 响应里解析 `five_hour/seven_day`；如果响应里确实不带这两个窗，就再补一次 `fetchUsage`。补测试：目标号处于冷却且 panorama 无 usage 时，仍能选中它。

6. **[BLOCKING] 卡已经花了但切号失败时，目标号会被卡到自然恢复。** 第 8 步如果 `switchAccount` 返回 `no_account/failed`（例如 keychain 读回不一致、target_stale、锁丢失），plan 没写后续怎么处理。目标号的 `switchCooldownUntil` 仍然等于原来的自然恢复时刻，普通 90% 路径的 selector 会一直排除它（account-store.ts:526-530）。结果是卡白花。
   修法：加一个持久状态 `redeemed_switch_pending`。只要 generation 没变，每轮用 `resetCardTarget` 重试。并且（或者）在确认恢复之后，于锁内清除目标号现有的 `switchCooldownUntil/quotaExhaustedUntil` 字段。这两个都是已有字段，回滚安全。

7. **[BLOCKING] 超时重试的依据是推断，可能重复花卡。** "服务端 10 分钟幂等窗"在 research §1.2 里只是客户端行为（客户端把未确认的 requestId 保留 10 分钟），并没有服务端的证据。plan 第 6 步却在 60 秒后盲发第二次 POST。默认卡在第二次时一般会得到 `not_limited`，但 `use_requires_limit=false` 的卡和 `resets_total>1` 的卡没有这层保护。另外 `unavailable`、5xx、`malformed` 这几种结果，CLI 视为"未确认"：它会走 `Ft(...)` 保存 pending id，并显示 `unconfirmedLine`（excerpts 约 432-446 行）。plan 却把它们记成终态 `failed`。
   修法：超时和上述三种结果都先做只读判定（`resets_left` 是否减少、窗是否已清）。只有确认 `resets_left` 没变并且仍然 `atLimit` 时，才用同一个 id 重发，且最多一次。重发放到下一轮 tick，不要在本轮里 sleep 60 秒。

8. **[BLOCKING] @ 不会真的提醒到她。** `postDiscordMessageToChannel` 把 `allowed_mentions: { parse: [] }` 写死了（discord-utils.ts:241），所以 `<@founder>` 不会推送通知。plan 却把这个函数列为"原样复用"。后果是每张征询卡都只会走到过期，整个功能实际没有用。
   修法：给这个函数加一个窄选项 `allowedUserIds:[founderId]`，并加测试断言请求 body。同时建议用现成的 `nonce/enforceNonce`（:221-231），由 proposalId 派生 nonce，这样 Bridge 在"POST 成功、messageId 还没落盘"之间崩溃，重启后重发也不会出现两张卡。

9. **[BLOCKING] 验收台架可能误切生产号。** 台架里跑的是真 `switchAccount`，它的 `applyProfile` 会执行 `flywheel-claude-profile use`，写的是本机 Keychain。§7 只隔离了 `FLYWHEEL_STATE_DIR`。
   修法：写明 `applyProfile` 必须用桩，并同时隔离 `FLYWHEEL_CLAUDE_ACCOUNTS_PATH`、池目录和 `FLYWHEEL_QUOTA_PIDFILE`。redeem 模块的 origin 只能通过 deps 注入，并且照 observer 的做法要求 baseUrl 必须和 fetchFn 一起注入；不能读任何 env（注意 `FLYWHEEL_QUOTA_API_BASE` 这类先例，quota-usage-api.ts:179）。

10. **[ADVISORY] `verifyAndRankCandidates` 的副作用比 plan 写的多。** 除了 `recordObservation`，每个候选号还会触发一次 `verifyCandidate` 探测刷新。这会轮换池里的 refresh token 并写回凭据文件（freshness.ts 头注释）。按现在的设计，H1 每 20 分钟跑一次，第 4 步又刷新一次，执行时再来一次，每个号每小时会被刷新 3 次以上。建议：第 4 步直接用 quota-monitor.ts:330 现成的 `readCandidateCredential(..., refresh=false)`，这样也不需要从 selector 导出新函数；H1 的节流间隔不低于 `candidateSweepMinutes`。

11. **[ADVISORY] proposal 文件"存在但不合法"要 fail-closed。** 现在"不合法"和"不存在"被当成同一种情况，这会让系统在丢失一条 `executing/ambiguous` 记录后，对同一张卡重新提议。建议区分 ENOENT 和"不合法"：后者关掉本功能并发告警；另外提议前先查 audit，看这个 grant id 是否已经尝试过。

12. **[ADVISORY]** Bridge 一直不在线时，proposal 会永远停在 `awaiting_consent`。守护进程应在 `expiresAt` 加一段宽限后自己置 `expired`。

13. **[ADVISORY]** 守护进程无法独立算出 founder id，所以 `bindApproval` 里的 founderId 比较只是自己跟自己比。文档里应该如实写明：信任锚点是同 uid 的 0600 文件加上 Bridge 侧的检查。

14. **[ADVISORY] 新告警 kind 登记位置不全。** plan 只提了 `ROUTING` 和 lead-alert.sh 的 plain 白名单。实际要改的是 lead-alert.sh 的 kind case（:257），而不是 plain 白名单（:436）；此外还有 `kind-contract.ts`、`LeadAlertNotifier.ts`、`alert-kind-copy.ts`。另外 ROUTING 是按 kind 固定的，同一个 kind 做不到"severe 就 @、info 就不 @"。建议删掉 info 级，或者直接复用现有 kind，只换 signature。

15. **[ADVISORY]** 负向守卫会被现有代码撞红：account-detail-observer.ts:29 的注释里已经出现了 `reset_rate_limits`。守卫要么只扫字符串字面量，要么把这个文件加入白名单。

16. **[ADVISORY]** plugin.ts:12877-12886 里 `await landOperationTick()` 没有包 try。它一抛异常，后面整条 finally 链都不会执行。resetCard 的 tick 要单独包一层 try。

17. **[ADVISORY]** `safeNoTargetText` 会把 detail 截到 4000 字节。`reset_card:` 那一行如果追加在 panorama 后面，容易被截掉，建议放到最前。另外在等待同意期间，`quota_no_target` 每 30 分钟 @ 一次，和征询卡重复打扰她。

18. **[ADVISORY] 需要 Lead 裁定的两个产品问题。**
    (a) 在 `headroomDegraded` 时，5h 99% 的号也会进入 `ranked`，被当成"能直接切"，于是永远不会问她。这是否符合 founder 说的"没有别的可用号"？
    (b) 如果驱动窗再过 30 分钟以内就会自然重置，是否应该不问？

19. **[ADVISORY]** §9 说挂点和 FLY-2830 的改动"在不同函数段"，这不准确：2830 §6.2 同样在 `pollOnce` 开头加逻辑，并且也改 `nextUsageDueAt`，两边在语义上会冲突，需要合并时协调。

20. **[ADVISORY] 可以删掉的部分。** proposal 里的 `alternatives` 列表；本轮内 sleep 60 秒后重试；`resetCardTarget.verifiedAt`（和 base 的 `verifiedAt` 重复）；audit 按尾部 64 KiB 读（没有任何代码读它）。`account-candidate-selector.ts` 不需要改（见第 10 条）。

21. **[ADVISORY] 需要补的测试。** B1、B2、B3（唤醒时 `nextUsageDueAt` 在未来）、B5、B6、B8 各一条 RED 用例；H1 在 `resetCardAskPct ≥ trigger5hPct` 时不触发；用卡切号成功后 `reviveEpoch` 和 `lastSwitchAt` 被正确设置；proposal 文件存在但不合法时 fail-closed。

## Verdict

CHANGES REQUESTED。B1 到 B9 必须改：B1、B2、B7 关系到花卡的正确性和不重复；B3、B4、B5、B6、B8 会让功能实际失效，或让卡白花；B9 会让验收误切生产号。B4(b) 需要先请 Lead 裁定"批准即执行"还是"撞墙再执行"。其余 ADVISORY 条目可以在实现阶段顺手处理。
