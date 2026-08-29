# FLY-1041 QA ②③④ — 真机证据(Chrome-as-Annie founder-reply E2E)

日期: 2026-07-09
方式: 模块驱动(FLY-605 先例)—— 真编译 deliverer `emitFounderReplyDeliveryForThread` + 真 `makeFounderShipApprovalCallback` 组合 + 真 tier2/tier3 classifier + 真 `reactToFounderMessage` + 真 CommDB,读 Annie **真账号**(`xrliannie_96634`)在隔离 529 thread 发的**真消息**(经她授权的 Chrome-as-Annie 驱动),真 Discord GET/PUT。零 mock。
Harness: `packages/teamlead/qa-fly1041-inbound.mts`(setup/verify 子命令)。

## 结果:②③④ 全部真机 PASS

| 点 | 场景 | Annie 真消息 | deliverer 行为 | 真 Discord 回执 | 判定 |
|---|---|---|---|---|---|
| ② reply-to-card | 隔离 thread 内 **回复卡** 发「okk」 | msg `1524825369377767465`, **type=19 (REPLY)**, `ref=1524824757793460335`(卡 id) | reply-to-card 检测命中 → readCurrentBinding 绑到该 gate → tier2 降级「okk」→ **tier3 带 replyToCard 上下文** → approve → 真 comm.db 写 `{"approved": true}` | 她「okk」上真点 **✅** | ✅ PASS |
| ③ ✅ reaction | 发「ship」 | msg `1524824972244025537`, type=0, content `ship` | tier2 确定性 approve → 真 comm.db 写 `{"approved": true}` | 她「ship」上真点 **✅** | ✅ PASS |
| ④ ❓ 回执 | held session 下发「ship」 | msg `1524826598258245713`, type=0, content `ship` | `isHeld=true` → hold guard 短路 → **不写 response** | 她「ship」上真点 **❓** | ✅ PASS |

真 Discord API 快照(留档不删):

```
③ok   (thread 1524801758356963509): Annie msg 1524824972244025537 type=0  content='ship' ref=None      reactions=['✅']
②reply(thread 1524824756694810624): Annie msg 1524825369377767465 type=19 content='okk'  ref=1524824757793460335 reactions=['✅']
④held (thread 1524824765481619578): Annie msg 1524826598258245713 type=0  content='ship' ref=None      reactions=['❓']
```

## 覆盖的 FLY-1041 修复面(真机)

- **Fix B reply-to-card 确定性绑定**(②):真 type-19 reply → `message_reference` → readCurrentBinding → cardGate 收窄 → 只绑该 gate;短语「okk」经 replyToCard 上下文在 tier3 被判为对该卡的批准。直击 FLY-910「短回复不绑」痛点。
- **Fix C ✅ 回执**(③):founder 短语批准落 response 后,她消息被真点 ✅(她要的即时可见回执)。
- **Fix B/C held→❓**(④):codex/QA 未绿(held)时 founder 批准**不被静默写入**(FLY-910 05:47 翻转即此类),改为 ❓ 回执 + 不写 response —— verify-approval 第5步不会再被绕过。

## 说明

- founder 身份硬闸(`founder-reply-deliverer.ts:245` = `author.id===ownerUserId && author.bot!==true`)在真机被满足:消息来自 Annie 真账号(非 bot),这也证明防伪闸对真 founder 放行、对 bot 拦截。
- Annie 授权的 Chrome-as-Annie(FLY-612 后 standing rule + 本轮她本人在 thread 再次确认)驱动她登录态在隔离测试 thread 发测试消息;不碰生产 thread、只发测试内容、thread 留档。
