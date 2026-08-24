# FLY-1851 会议模式 — 事实台账

Issue: FLY-1851 (https://linear.app/geoforge3d/issue/FLY-1851/voiceprd-共创-c-会议模式-在语音房里把-prd-聊定而不是互相发大段文字)
日期: 2026-08-19
基于: exploration.md

> 本文只放**可核的事实与出处**。产品判断在 `exploration.md`,怎么继续在 `plan.md`。
> 纪律:本轮**只读**。未改任何生产代码 / 配置,未启动任何服务,未跑任何消耗额度的探针。

---

## 1. 今天(2026-08-19)语音线的部署状态 —— 本轮独立复核

| 查什么 | 命令 | 结果 |
|---|---|---|
| launchd job | `launchctl list \| grep -i voice` | 只有 `com.apple.voicebankingd` / `VoiceOver` / `voicememod`,**无 flywheel voice job** |
| plist | `ls ~/Library/LaunchAgents \| grep -i voice` | **无** |
| 进程 | `ps aux \| grep voice-bridge` | **无** |
| 配置 | `grep -c huddle ~/.flywheel/projects.json` | **0** |

`packages/voice-bridge/src/config.ts` 在 `huddle` 块缺失时 **fail-closed 抛错**
(原文:"no project in projects.json has a huddle block")。

⇒ **结论(可证伪)**:今天没有任何一条语音管线在跑,且配置未就绪。
与 FLY-1827 在 2026-08-17 的复核一致 —— **两天过去没有变化。**

## 2. 代码规模(main,排除测试文件)

| 范围 | 行数 |
|---|---|
| `packages/voice-bridge/src` | **13,225** |
| voice-core + voice-bridge + voice-headphone | **20,231** |

> issue 描述里的「约 13000 行」= voice-bridge 那一项,数字对得上。

## 3. 已经落成代码的会议机器(**本单最相关的一节**)

目录:`packages/voice-bridge/src/huddle/` — 12 个源文件。

| 文件 | 行 | 它解决的是本单哪一格 | 核心合同(取自文件头注释,非转述) |
|---|---|---|---|
| `HuddleSession.ts` | 1226 | **C1 + C2** | 状态机 `idle → assembling → live → concluding → landing → teardown`;每个参会 Lead 一条 session;**她的音频只喂给被点名那一条**;**一次只开一张嘴** —— 没拿到发言权就开口的 Lead 会被打断、音频落在关闭的嘴闸上 |
| `AddressRouter.ts` | 97 | **C2** | 点名指针 **sticky**:起点是第一个被 @ 的 Lead,只有她在一句话里**明确念到另一个人的名字**才切;一句里念了多个名字,**最后一个赢**;切换那句话是旧 session 听到的,所以由编排器打断旧的、把转写重放进新的 |
| `FeedPipeline.ts` | — | **C2** | 没被点名的 Lead 用**静默文本注入**补上下文(不触发说话) |
| `ConclusionPipeline.ts` | 223 | **C3** | 落地顺序是**合同**:摘要 comment → worktree → Done → TIV 卡片。**Done 放最后** —— 任何早一步失败都让 issue 保持打开且失败被说出来,绝不静默半落地。带幂等标记,重跑不会写两遍 |
| `residentMinutes.ts` | 58 | **C4** | 主持 Lead 的常驻大脑出摘要(引用她的话 + 时间戳);**只有干净终止才落**,中途失败一律回落成**带时间戳的原始流水**,绝不落半截摘要 |
| `ConfirmationLadder.ts` / `confirm-heuristics.ts` | — | (C1 尾巴) | 动作确认阶梯 |
| `GlawCommand.ts` / `wireMeeting.ts` / `huddleTiv.ts` / `ResidentLineDriver.ts` / `ReadOnlyLeadBrain.ts` | — | 接线 | slash 命令入口 / Discord 文字区 / 常驻线驱动 |

### ⚠️ 三条必须一起读的边界

1. **底座是 Gemini Live,不是 Codex。** `HuddleSession` 注释原文写的是 "One Gemini Live session per
   participating Lead"。她已定「Discord 语音房那条腿整段重做,换 Codex」⇒ **实现大概率整段作废,产品决定可能还成立。**
2. **`ConclusionPipeline` 落的是「会议纪要 + action items 写进立项 issue」,不是 PRD。**
   这是 C3 的真空所在 —— 机器有,但它产的不是本单要的东西。
3. **零运行 + 真机 FAIL ×2**(见 §1、§5)。有代码 ≠ 有产品。

## 4. all-listen 为什么被判死(**C2 的关键先例**)

出处:`engineering/doc/FLY-968-voice-model-bakeoff/bakeoff.md` §0 问① + §2,2026-07-07 真机横评。

| 策略 | 60 分钟会议成本 | 判 |
|---|---|---|
| 单 session | ~$0.66 | 基线 |
| **all-listen ×3**(她的话同时喂给所有 Lead) | ~$1.67 | **不可用** —— **10 轮里 8 轮有没被点名的 Lead 抢答,system prompt 压不住** |
| **点名 + 静默补喂 ×3** | ~$0.68(≈1.05×) | **推荐,并已落成 `AddressRouter`** |

配套实验事实:
- 并发**不加延迟税**(3 并发 727–1138ms,median 831ms,与单 session 同)。
- 补喂管线是必需品:**负对照证明不补喂时模型会自信瞎编**(有个 Lead 编了个不存在的代号)。
  ⇒ 「补喂丢消息比没有补喂更危险」是原报告的原话。

⚠️ **时效边界(必须标)**:这组数据全部跑在 **Gemini Live** 上,**从未在 Codex realtime 上重测**。
「给 LLM 听到就会答」这个机制大概率跨厂牌成立,但 **8/10 这个具体数字只属于 Gemini**。
引用时不许写成「Codex 上也是 8/10」。

## 5. 历史真人验收(别把「Done」读成「跑通」)

| 管线 | 命令 | 真人结论 | 出处 |
|---|---|---|---|
| 语音助理 | `/gemini` | ✅ Annie 验收「一来一回正常」 | FLY-1347 measurement pack §0 |
| **Huddle 会议** | `/glaw` | ❌ **founder 真机 FAIL ×2**,7 分钟死窗 | 同上 |
| ElevenLabs | `/eleven` | ❌ Annie 真人 FAIL(barge-in 风暴,R1 1.5s → R2 28.5s 雪崩);**她已定「可以直接立单删掉」** | 同上 + FLY-1827 第 2 轮 |
| 语音派活 | `/gemini-advanced` | merged 但 default-off,enablement 硬门未过 | 同上 |

- `FLY-545`(Huddle 实现单)在 Linear 上是 **Done**,但其自身描述写着「FOLDED INTO FLY-1160…
  不单独 ship、不单独跟踪」,**Done 是记账,不是「跑通」**(FLY-1827 §⑤)。
- 同 pack 记录的对照:干净 WAV vs Annie 真声 —— barge-in「极少」vs「**单场 8+ 次**」;
  延迟中位 6.4s vs 「R2 28.5s 雪崩」。⇒ **机器层绿不代表真人层绿。**

## 6. Codex 语音底座今日事实(C5 的输入)

| 项 | 事实 | as-of / 出处 |
|---|---|---|
| Codex CLI 版本 | **0.148.0** | 本轮 `codex --version`,2026-08-19 |
| v3 realtime 准入 | **没有被拒过。** 七月那次 "Voice session access denied" 是**走错通道**(v1/v3 走 WebRTC,v2 走 websocket);换 WebRTC 当场就通,独立复现 2 次 | FLY-1844 `evidence/P6/P7`,**验于 0.147.0** |
| ⚠️ 验证边界 | **只证明了会话建得起来**(SDP 握手完成、后端返回真实 answer)。**「打电话那种完整体验」从未验过** —— 没让它说过一句话 | FLY-1844 research.md §6 |
| ⚠️ 版本漂移 | 本机已 **0.148.0**,FLY-1844 验的是 **0.147.0**;而 `realtime_conversation` 的状态是 **under development / 默认关**,协议随时可变 ⇒ **今日未重跑** | 本轮实测 |
| CLI 入口 | **无** voice / realtime 子命令;只有 `--enable realtime_conversation` 这个实验开关 | FLY-1844 §4 |
| Codex-as-Lead | 已是既有生产形态(16 个 Lead 中 2 个走 `codex-app-server`) | `~/.flywheel/projects.json` |
| Claude vs Codex Lead 的权限差 | **只剩一条**:Codex 可写范围钉在项目根 `writable_roots`,Claude 不圈。其余等价 | FLY-1844 D-4(实测) |
| 限制来源 | **角色,不是厂牌**(mufasa=Codex / belle=Claude,同为 companion,限制一模一样) | 同上 |
| Discord 语音腿 | `voice-bridge` 已有 joinVoiceChannel / DAVE opus 解密 / EarsReceiver / LeadSpeaker / barge-in / BrainPort | FLY-1844 §4 |
| 接 Codex 的缝 | `BrainPort` 是 **text-in / text-stream-out** loopback;Gemini 走 audio-direct,**没有文本缝** | 同上 |
| ❗ 从未接过 | **「Codex 的嘴接进 Discord 语音房」两端都现成,但从来没接过** | FLY-1844 §6 未验清单⑤ |
| ❗ **「听懂」那一步今天走 Gemini Live** | 两条现成的耳朵(本机麦克风 `MicCapture` / 语音房 `EarsReceiver`)都把 PCM 喂给 **Gemini Live** 出转写。**而她为语音拍的 vendor 是 Codex** ⇒ **换 Codex 不是「接上就行」,收音那一段要一起解决** | **B 的台账**(见下方 §6.1) |

### 6.1 底座描述的权威版在 B 那边 —— 本单只引,不重写

Honey Lemon 2026-08-19 定:B(FLY-1850)和 C(本单)都要「Lead 能说话、能听」,
**这个共同底座只写一份**,权威版在 B:

> `product/doc/FLY-1850-headphone-voice-relay/research.md` §2.3
> (分支 `flywheel-FLY-1850` / PR #891)

本单需要知道的三条(**引用,不复述细节**):

1. **Discord 语音房收音** = `voice-bridge/src/audio/EarsReceiver.ts`:一个「耳朵」bot 订阅房里**所有真人**
   —— **只订人不订 bot**,这是**结构性防回声**;带 **350ms backchannel 门**(「嗯」「对」不算打断)。
   ⇒ **对 C2 直接相关**:多方开会时「谁在说、算不算打断」这一层,底座已经有一个真实的判据了。
2. **PCM → 文字这一步,两条耳朵都走 Gemini Live**(`voice-core/src/cli.ts` 的 `registry.create("gemini-live")`)。
3. **今天唯一被她真人验收过的语音管线是 `/gemini`**(Gemini Live,「一来一回正常」);
   **Codex 那条路至今没让它说过一句话**(与本文 §6 的验证边界一致)。

📎 **一处极容易搞混的,先钉死**:她「一票否决」过的是 **gemini-cli**(那个写代码的 CLI,理由「写的太差、千万不要抄」),
**不是 Gemini Live 这条语音管线**。**两者不是一回事,不要当成她否过 Gemini。**

⚠️ 这三条**不是在建议换 vendor** —— 走 Codex 是她已定的前提(见 `exploration.md` §3)。
它们的用途是:**C5 那一格谈「工程代价」时,代价里必须包含收音这一段,不能只算「嘴」。**

## 7. FLY-906 已批 PRD:哪些可以复用,哪些已经烂了

`product/doc/FLY-906-voice-product-experience/prd.md` — v0.17,**2026-07-06 Annie 最终 review 通过**,42KB。

**和本单直接相关的两节**(可作为 C1/C3/C4 的旧答案摆给她确认):

- **§12.0 / §12.1 Huddle v1**:一个常驻共享 `#huddle` 语音房(不是每场建临时房);她在**任何文字频道**
  打一条 slash 命令 + @ 点名 → 被点名的 Lead ~1s 自动进房 → 她 tap 一下进来(**若她已在别的语音房 → 零 tap 直接挪进来**);
  **一发起就自动建 1 条立项 issue**;聊完由**第一个被 @ 的 Lead**(主持/记录)写 summary + action items 进那条 issue → 存档关闭。
- **一条硬约束(当时就查清了)**:**Discord 不能强拉一个「没在语音里」的人进服务器语音房**(ring 只存在于 DM)。
  ⇒ **她进会必然要她自己 tap 一次**,bot 那半边可以 100% 自动。这条今天仍成立,**不要在 PRD 里假装能修**。

**已经烂掉的锁**(FLY-1827 §⑤ 实测):

| PRD 写的 | 实际 |
|---|---|
| 命令名 `/meet`(R10 锁定) | 代码是 `DEFAULT_COMMAND = "glaw"`(`voice-bridge/src/config.ts:117`) |
| per-Lead 独立声线 = **硬需求**(§17) | 2026-07-21 co-eval **砍成「单声 + 身份报头」**。PRD 未更新,两处冲突 |

⇒ **引 FLY-906 时必须逐条核**,不能整段当权威。

## 8. 未查清 / 未验(诚实清单)

**缺真机**
1. Codex 的嘴接进 Discord 语音房 —— 两端现成,**从未接过**。
2. Codex v3 上「多个 Lead 同时在一个房里」—— **从未试过**;all-listen 的抢答结论只在 Gemini 上量过。
3. Codex v3 的音质 / 延迟 / barge-in / 长会话稳定性 —— FLY-1844 只验准入。

**缺决定(要她拍,正是本单要聊的)**
4. C1–C6 六格,全部未答。

**缺信息**
5. `realtime_conversation` 何时转正、v3 的用量与限流天花板 —— 外部信息,拿不到。
6. 7/24 之后 voice 线为何整体停摆 —— FLY-1827 也没查到,**无任何 issue / 文档写过「暂停 voice」**。

## 9. 纪律

- 全程只读。未改生产代码 / 配置,未启动任何服务,未跑 codex 探针(不消耗额度、不碰共享 symlink)。
- 每条会过期的结论都带 as-of 与重核命令(见 `exploration.md` §9)。
- 未给方向结论 —— 方向由她拍,本文只摆事实。
