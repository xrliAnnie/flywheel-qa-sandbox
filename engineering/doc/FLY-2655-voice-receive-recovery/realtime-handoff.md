# FLY-2655 Realtime 最终设计交接 — 实施计划
Issue: FLY-2655 (https://linear.app/geoforge3d/issue/FLY-2655/2598follow-up-raya-rg-语音会话-live-10-秒即-faileddiscord-audio)
日期: 2026-09-20
基于: plan.md; design-correction.md; realtime-review-disposition.md

## 当前有效收据与边界

R3有效reviewVerdict=APPROVED、reviewerVerdict=APPROVED，question 1e7e6c09-a3ae-423c-b952-183e8235892e，request 508b90a8-5c0e-409f-b9fe-0a5f0818417f，受审设计提交c1fc022f2。完整收据realtime-design-review-r3.json；受审plan/correction字节摘要见realtime-review-request-r3.json，交接时核对一致。文内REVIEW_REQUIRED是受审时状态，当前裁决以本收据为准；保留受审字节及历史，不重开设计。

保留177c539ea的DAVE与隔离工装实现；执行plan§11及design-correction E1–E5，直连固定gpt-realtime-1.5，仅做声音前台，原Lead仍是唯一回答者。未修改实现、升级Codex、改生产注册表/凭据或操作slot2。没有新真实API探针或真人QA；原attempt2仍FAIL。两场真人≥60秒、多句短话+停顿、原Lead音频回复及割接后#raya自主开场均不减少。

## R3 非阻断验收路径勘误（执行时先读）

`statestore-reason-gate-test-path-wrong`已源码核实：附录E2清单及定向命令中的teamlead `src/__tests__/voice-routes.test.ts`实际覆盖旧/api/voice router，与本次session状态路由无关。正确文件为 **packages/teamlead/src/bridge/__tests__/voice-session-routes.test.ts**，既有/state测试在203、328行。StateStore测试路径正确，保持。执行相关命令应为：

```sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.voice-session.test.ts src/bridge/__tests__/voice-session-routes.test.ts
```

这只是测试路径勘误，§2.1要求实际Store/route、终态/outbound结算及负对照的验收范围不变。未运行实现测试，不把错误路径的绿当通过。受审附录保留原字节，本交接作为明确勘误入口。

## R3 advisory逐项去向

- MEDIUM statestore-reason-gate-test-path-wrong：上节勘误；实现须新增/运行正确路由的状态端到端用例。
- MEDIUM playback-deadline-is-total-duration-not-stall：Follow-up，同R2；QA实测播放时长与丢拍，触发不能以文字或单测判PASS。
- MEDIUM segment-serialization-doubles-reply-latency：Follow-up，同R2；记录首声、段间静场和长回复总时长，真人体验失败不能算通过；未授权新并行队列。
- LOW dropped-receipt-requires-claim-first：Lead指令实现必做，沿用既有claimOutbound→attemptToken→receipt顺序；“循环前”指已claim后的朗读片段循环前，不是跳过item claim。每item结算一次，不形成重复提示。
- LOW pre-live-normal-end-unguarded：Lead指令实现必做。ready时校验expiry剩余时间足够覆盖启动窗口（presenceGraceMs+startBudgetMs+5s）；未live时正常结束回调统一转failed，不能拿ended撞warming白名单。覆盖异常近expiry/时钟偏移及warming回调反例；不能扩张warming→ended转移表。
- LOW capacity-reason-token-overloaded：Follow-up，同R2；区分state+reason，pending溢出不得作为正常ended/realtime_capacity。
- LOW expiry-fallback-55min-unverified：Follow-up，同R2；55分钟非API保证，真实expiry证据待E5，未测不得称成功。
- LOW dead-code-disposition-unlisted：Follow-up，同R2；实现PR逐项列旧assistant/feed/flush/delegation路径去留，不能留下第二条无门控出声入口。
- LOW uplink-drop-counters-absent-from-evidence：Follow-up，同R2；QA说明缺口，对缺证据假说保留未决，不猜测根因。

Lead于问题86b1105c-192e-49f6-9f4b-bf1ba8d6c3bd回复：claim before dropped receipt与pre-live normal-end guard两项实现必做，其余按实现体判断；完整原文realtime-lead-handoff-ruling.txt。以上9项已通过ask --report报告Lead；MEDIUM/LOW不阻断有效APPROVED。没有HIGH治理裁决或自我豁免。

## 交付证据入口

founder-design.html与build-report.py：最终交互HTML，8节评论及路径隔离存储/分段复制；realtime-html-verification.json仅DOM/controller检查。flow.mmd/model.mmd本地渲染各两次失败，见realtime-diagram-render.json，HTML保留DIAGRAM PENDING LOCAL RENDER；没有远程渲染。realtime-publish-receipt.json/realtime-hosted-verification.json由发布后真实收据补齐，不能以本段先验宣称发布成功。完成须DESIGN-HTML报告后phase_design_complete与park。
