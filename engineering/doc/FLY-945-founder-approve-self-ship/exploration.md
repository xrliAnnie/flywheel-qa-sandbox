# FLY-945 founder 批准 → runner self-ship 断链 — 探索

Issue: FLY-945 (https://linear.app/geoforge3d/issue/FLY-945/bugworkflow-founder-批准没触发-runner-self-ship-lead-被迫-executor-merge)
日期: 2026-07-06
基于: 无

## 1. 一句话

founder 在 Discord 批准 → runner 自 ship + 自清理 + 自归档,这条链**每一环都已经存在**(FLY-799 建了批准桥、FLY-58/369 建了 self-ship 与归档级联),但今晚 FLY-921 的实测证明链上有 4 个断点叠加,导致 Annie 的「ok ship it」等了 11 分钟才落库、落库时又绑在过期 head 上、Lead 顶不住先 executor-merge、自清理自归档全部没触发。

## 2. 审计结论(先纠正 issue 里的两个假设)

逐条对着生产 DB(`~/.flywheel/teamlead.db` / `~/.flywheel/comm/flywheel/comm.db`)、Bridge 代码和 Discord 原文核过:

1. **「桥根本没建」不成立** —— FLY-799 的 founder 文字批准桥是建好且 default-ON 的
   (`founder-ship-approval-handler.ts` + `text-approval-source.ts` + Tier-2 allowlist + Tier-3 分类器 + `write-gate-response.ts`),
   而且**今晚它真的把 Annie 的批准写进了 gate**:comm.db 里 question `dbe11e5b` 有一条
   `{"approved": true}`,from_agent = Annie 的 Discord id(1138241636057481306),03:07:30 UTC 落库,
   FSM 同秒 awaiting_review → approved_to_ship。桥在,但**慢到等于没有**(见 §3 断点 ①)。
2. **「Lead 自批 {approved:true} 会被机制拒掉」不成立(目前)** —— `verify-approval` 只校验
   response 是结构化 `{"approved": true}` + 状态 + pr_head 绑定,**不校验 responseFrom 身份**;
   生产 `DECISION_MODE` 未设(= off),Bridge gate-response 端点是 pass-through。
   Lead 不自批靠的是 founder-only-authority **合同**(以及 Tadashi 当晚给 runner 下的
   「已 park,不会自批」指令),不是机制。Annie 要的「只有 founder 能批」目前是纸面约束——这本身是本 issue 应该补的一块(§5 方向 E)。

## 3. 今晚 FLY-921 实锤时间线(全部 UTC,2026-07-07)

| 时刻 | 事件 | 证据 |
|---|---|---|
| 02:33:22 | QA session(2935948e)开 approve_to_ship gate `dbe11e5b`,**绑 head 923c48d0**;FSM → awaiting_review | comm.db + session_events |
| 02:43:24 | Bridge 在 [FLY-921] thread 发 ship-gate 消息 + FLY-799 gate-message binding 落库 | `founder_thread_notified` / `ship_gate_msg_binding` |
| 02:51:07 | runner 补推 QA 证据 commit,**PR head 漂到 4ac0df03**(qa_result 事件里带新 sha),但没有重开 gate、session pr_head_sha 仍是 923c48d0 | `qa_result` payload |
| 02:41 / 02:47 | Annie 两条追问(QA 是怎么测的 / 要求真 Discord E2E)——各自**延迟整 10 分钟**(02:52:10 / 02:58:33)才被处理成 WAKE-only | `founder_ship_reply_waked` |
| **02:56:26** | **Annie:「ok ship it」**(msg 1523885378103148626) | Discord 原文 |
| 02:56–03:03 | 10 分钟 grace 内这条消息完全不被处理;runner 侧 verify-approval = `gate_not_answered`;Annie 视角 = 批准没反应 | 机制推演(§4 断点 ①) |
| **03:03:46** | **Lead executor-merge PR #478**(`gh pr merge`,GitHub 显示 mergedBy=xrliAnnie 凭据) | `gh pr view 478` |
| **03:07:30** | grace 到期,FLY-799 文字路径把「ok ship it」写成 gate 答复(归属 Annie)+ FSM → approved_to_ship —— **晚了 4 分钟,且绑的还是 923c48d0** | comm.db response + `state_transition` |
| 03:08:07 | runner 醒来 verify-approval → **`pr_head_sha_mismatch`**(批准绑 923c48d0,head 已是 4ac0df03);它再跑 `complete --route needs_review` 想重开 review,**FSM 却走了 approved_to_ship --session_completed--> completed(终态)**,没回 awaiting_review | runner ask 原文(bb8571c6)+ `state_transition` |
| 03:20:31 | runner 确认 PR 已被 merge,`stage set completed` 收尾。**因为 merge 不是 self-ship 路径:无 merged landing 证据 → `isPostApproveShipComplete` 不成立 → post-ship finalization(tmux 清理 + 🏁 + thread 归档 + 标 Done)全部没跑** | session_events + `post-ship-finalization.ts` |
| 03:24 | Annie:「不是它应该自己 ship 做清理然后 archive 吗?为什么还在这里?」→ 手动叫 Lead archive | Discord 原文 |

## 4. 四个断点(按因果顺序)

### ① founder 入站 10 分钟 grace —— 本次「批准没触发」的直接根因
`GatePoller.founderReplyDeliverGraceMs()` 默认 **10 * 60_000**。founder-reply-deliverer 扫 thread 时,
`now - msgMs < graceMs` 的消息直接 `break`(整个 thread 停在这条消息前)。设计出处是 FLY-605:
Bridge 只是「Lead 没 relay 时的 fallback」,给 Lead 10 分钟先手窗口。
但对 approve_to_ship 这个 checkpoint,**Lead 本来就被禁止代答**(founder-only),
所谓 fallback 实际是唯一通道——却背着为 relay 设计的 10 分钟延迟。
对照:同为 FLY-799 的 ✅-reaction 批准路径是 **15 秒**一轮(`founderReactionApprovalPass`)。
文字批准(Annie 最自然的动作)反而是最慢的通道。

### ② head 漂移 —— 即使批准秒到,self-ship 也照样失败
gate 开在 923c48d0;runner 02:51 补推 QA 证据 commit(常见且合理的动作)→ head 4ac0df03,
但没有按协议重开 review(协议是软文本,runner 没执行;Bridge 也没有任何机制感知/纠正)。
之后落库的批准按 verify-approval 的安全设计**必须**绑 session 的 pr_head_sha(923c48d0)→ mismatch。
注意 02:51 的 `qa_result` 事件里明明白白带着新 head——**Bridge 当时就有足够信息发现绑定已过期**,却什么都没做。

### ③ 过期批准的恢复路径断头 —— FSM 边错误
runner 发现 mismatch 后按协议重开 review(`complete --route needs_review`),
但 FSM 把 approved_to_ship + session_completed 推成 **completed(终态)** 而不是回 awaiting_review。
(FLY-208 5a 的 evidence-gap 语义:approved_to_ship 无 merge 证据的 completion → completed + 标记。
它假设这种 completion 是「结束」,没考虑「我要重新请求 review」这个活路。)
本次因为 PR 已被 Lead merge 所以无感,但这条边意味着:**任何** stale-approval 场景 runner 都无法自救重开 gate。

### ④ executor-merge 不触发收尾 —— 自清理+自归档蒸发
post-ship finalization(tmux 清理 + 🏁通知 + thread 归档 + 标 Done → FLY-369 级联)的准入是
`isPostApproveShipComplete`:要么先前状态是 approved_to_ship、要么 landing 证据 status=merged。
Lead 直接 `gh pr merge` 时两者皆无 → 整套收尾静默跳过 → Annie 手动催归档。
已有先例支持补这个兜底:FLY-742 stale-blocker guard 的注释明确「merged/closed PR = founder 已经决策 →
auto-finalize 是 Bridge 系统健康清理,不是 founder-gated 动作」——但它只挂在 run-start 409 路径上被动触发。

## 5. 修复方向(exploration 层面,细化留给 research/plan)

**A. 砍掉 approve_to_ship 的入站延迟(P0,治「批准没触发」)**
ship-gate 的 founder 文字消息不吃 10 分钟 grace——目标体感与 ✅-reaction 同级(≤~30s)。
非 ship 的 relay fallback(brainstorm/question)保留 grace(那是它的本职场景)。
实现形态(candidates,research 里定):per-checkpoint grace / ship-gate 专用快扫描线(复用 reaction pass 的 15s 节奏)/ 拆 cursor。
要处理好共享 cursor 的顺序语义(at-least-once、不能因快慢两线互相吞消息)。

**B. head 漂移的感知与纠正(P0,治「批准落空」)**
最小闭环:Bridge 看到 awaiting_review session 出现**带新 head 的 qa_result**(或等价的新 head 证据)时,
自动刷新 review 绑定(session pr_head_sha + FLY-799 gate binding + 在 thread 里更新/追发 gate 消息注明新 sha)。
founder 批准永远落在「她看到的最新已 QA head」上。加上 runner 侧协议硬化(gate 开了以后禁推;要推先重开 review)。
安全底线不动:verify-approval 的 head 绑定校验一个字不改。

**C. FSM 恢复边(P1,治「自救断头」)**
approved_to_ship + `session_completed(route=needs_review, 无 merge 证据)` → 回 awaiting_review(重新 review),
不再终态 completed。带新 question 绑定(沿用现有 rebind 语义)。

**D. 外部 merge 收敛兜底(P1,治「归档蒸发」——即使未来再有人工 merge 也不该要 Annie 催)**
GatePoller 周期对 awaiting_review / approved_to_ship 的 session 核 PR 真实状态(gh),
发现 MERGED → 走 FLY-742 同款语义 auto-finalize(completed + merge 证据)→ post-ship finalization + FLY-369 归档级联。
这是兜底,不是给 executor-merge 开绿灯。

**E. founder-only 从合同变机制(P1)**
verify-approval 增加归属校验:response 的 from_agent 必须 ∈ {canonical founder id, Bridge founder-consent 写入者};
带 kill-switch + QA 房间显式旁路(FLY-115 测试框架的 lead-respond 路径要保住)。
让「Lead 自批会被拒」从 Annie 以为的现状变成真的现状。

**F. Lead 纪律收尾(文档,零代码)**
lead-rules-base(founder-only-authority 或新节):executor-merge 正式退役——founder 批准后 Lead 不插手,
runner ship 不动时 Lead 的动作是修机制/升级,不是代 merge。

## 6. 明确不做(out of scope)

- 「强制所有 QA 跑真 Discord E2E」的硬 gate(Annie 当晚同场提的另一个要求)——独立 issue,不混进本链。
- FLY-799 image/voice 批准源、DECISION_MODE=enforce 的 Haiku 评估器 rollout(FLY-175 Track 3)。
- 非 admin actor 的结构性 merge 保护(FLY-350 M-2 已接受 admin/contract-only,follow-up 已挂账)。

## 7. 关联

FLY-799(批准桥本体)· FLY-605(grace 出处)· FLY-827(codex hard gate,verify-approval 第 5 步)·
FLY-369(close→archive 级联)· FLY-742(stale parked auto-finalize 先例)· FLY-208(evidence-gap completion 语义)·
FLY-921(实锤事故载体)· FLY-175(founder-only-authority)
