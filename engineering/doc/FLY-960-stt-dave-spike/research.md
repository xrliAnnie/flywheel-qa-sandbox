# FLY-960 STT spike:bot 在强制 DAVE 下收音 go/no-go — 调研

Issue: FLY-960 (https://linear.app/geoforge3d/issue/FLY-960/voice闸-stt-spike-bot-在-discord-vc强制-dave-加密收音-gono-go-真机验证-全树闸)
日期: 2026-07-07
基于: exploration.md

> **调研方法**:一手来源优先——GitHub issue/PR 原文与 merge 状态用 gh api 直查、npm registry
> 直查版本时间线、Discord 官方 blog + 协议文档(docs.discord.food)+ DAVE 白皮书站。所有关键
> 结论都标注来源与日期;时效敏感(生态在 2026-03 强制后快速演化,implement 前可再刷一遍
> §3/§4 的 upstream 状态)。

## 1. TL;DR — 情报大幅反转,顺序改为 A → B → C

issue/PRD 的风险描述基于 2026-07-06 前的情报(「@discordjs/voice 0.19.x 在 DAVE 下当前坏
#11419」「py-cord 据报可用」)。**一手核查后两条都过时了,而且方向相反**:

1. **路径 A(discord.js 生态)**:#11419 已于 **2026-03-13 关闭**——根因找到(RTP padding
   使解密失败)、修复 PR #11449 由 **davey 作者 Snazzah 本人**提交,**已发布进
   @discordjs/voice 0.19.2(2026-03-17,当前最新稳定版)**。0.19.2 之后 discord.js repo
   **再无新的 DAVE 收音 issue**。A 从「雷区最深」变成**先验首选**。
2. **路径 B(py-cord)**:「据报可用」**证伪**。py-cord 2.8.0(2026-05-18)的 DAVE 支持
   **只覆盖发送侧**;**收侧解密的所有 PR 至今没有一个合入 master/release**,官方文档明文
   警告 recording 在 DAVE 下「may not work as expected」。B 的可行形态 = 跑未合入的 PR
   分支,降为次选。
3. **路径 C(本地采音)**:现状不变,保底,产品降级最大,选定需 Annie 拍板(gate 已定)。

**对 spike 的含义**:先验概率显著偏向 GO(A 路径大概率一天内出结果);但 upstream 修复
**没有公开的用户侧确认**(issue 是随 PR merge 关闭的),本 spike 的真机验证恰好就是这个
确认——不能因为「看起来修了」跳过真机。

## 2. DAVE 协议硬事实(直接约束 rig 与证据设计)

来源:Discord 官方 blog「Bringing DAVE to All Discord Platforms」、docs.discord.food
voice-connections、daveprotocol.com 白皮书站。

- **强制时间线**:2026-03-01 起,不支持 DAVE 的客户端/应用**不能参与任何 Discord 通话**;
  voice WebSocket 以 **close code 4017** 直接断开。**没有 opt-out**:在 voice Identify 里报
  `max_dave_protocol_version: 0` 的下场就是 4017(真实案例:#11419 里的转写 bot 在
  0.18.0 上 3 月 9 日起 4017)。→ **不存在「降级到非加密会话」的测试逃生门**;任何能连上
  且收到音的会话必然完成了 DAVE 协商。
- **协商机制**:voice Identify 带 `max_dave_protocol_version` → 服务端在 Session
  Description 回 `dave_protocol_version`(取全场最低共同版本)。→ **证据点①:log 这个
  字段 > 0**。
- **密钥结构**:参与者经 **MLS group** 换 per-sender ratcheted media key;`epoch = 1` 标志
  群组初建;成员进出触发 epoch 前进(key 轮换)。→ **证据点②:log davey session 的
  epoch/commit 事件**;**测试用例:成员进出(rejoin)必须覆盖**,因为 key 轮换是收音链路
  最容易掉帧的时刻(见 §3.3)。
- **帧加密**:codec-aware——帧内部分区间不加密(passthrough 区间),加密区间 AES128-GCM
  整块加密后回插,帧带 magic marker `0xFAFA`。**transport 层加密(aead_aes256_gcm_rtpsize
  + secret_key)在 E2EE 之上仍然全程存在**。→ 收包管线 = 先解 transport、再解 DAVE。
  #11419 的报错 `DecryptionFailed(UnencryptedWhenPassthroughDisabled)` 就出自这一层:
  解密器拿到一个「看起来完全没加密」的帧(根因是 RTP padding 没剥,见 §3.2)。
- **E2EE 可见性**:客户端 UI 有 E2EE 标识;py-cord 暴露 `privacy_code` 属性(「call 升级到
  DAVE 协议才有」)。→ **证据点③:客户端侧 E2EE 标识截图**。

## 3. 路径 A:discord.js / @discordjs/voice — 现状详查

### 3.1 版本与事件时间线(一手,gh api + npm registry,2026-07-07 查)

| 日期 | 事件 |
|------|------|
| 2025-08-17 | @discordjs/voice **0.19.0** 发布(引入 DAVE 支持,依赖 @snazzah/davey) |
| 2026-02-13 | **#11419** 开:「0.19.x DAVE encryption causes reconnect loops and zero audio capture」 |
| 2026-03-01/02 | DAVE 全面强制;0.18.0 及以下 bot 连 VC 直接 4017 |
| 2026-03-09 | **0.19.1** 发布;真实案例(D&D 转写 bot):升级后 DAVE 握手成功,但**首个收包即抛 DecryptionFailed(UnencryptedWhenPassthroughDisabled)** |
| 2026-03-11 | 用户 stevenpetryk 贴最小 repro(receiver.subscribe 收流) |
| 2026-03-12 | **Snazzah(davey 作者、discord.js voice 维护者)诊断出根因并提 PR #11449** |
| 2026-03-13 | #11449 merge,**#11419 关闭** |
| 2026-03-17 | **0.19.2 发布**(release notes 原文:「voice: Strip padding from packets and add guards (#11449)」)——**当前 npm latest 仍是 0.19.2** |
| 2026-03-29 / 06-22 | @snazzah/davey 0.1.11 / **0.1.12**(维护活跃) |
| 2026-03-17 之后 | discord.js repo **再无新开的 DAVE/收音相关 issue**(gh search 核查:created>2026-03-17 关键词 DAVE 仅一条无关 PR) |

### 3.2 根因与修复内容

根因不在 DAVE 密码学,而在**收包解析**:RTP 包的 padding 没按 RFC3550 剥掉,污染了送进
davey 解密器的帧 → 帧不匹配 DAVE 帧格式(0xFAFA magic 等)→ 被判为「passthrough 关闭时
收到未加密帧」→ 抛 DecryptionFailed。#11449 = 按 RTP header 的 padding flag 剥 padding
+ 加 guard(丢弃非 voice payload / 非 RTPv2 包)。改动小而对症——这与「首包即炸」的症状
吻合(padding 包一到就炸,不是偶发)。

### 3.3 残余风险(spike 必须覆盖的验证面)

1. **修复无公开用户确认**:issue 随 merge 关闭,报告者未在 thread 里回「修好了」。0.19.2
   后的「安静」可能是修好了,也可能是收音用户太少。→ **本 spike 就是这个确认**。
2. **MLS key 轮换掉帧指控(#11441)**:有人报「MLS key transition 期间 34% Opus 包静默丢
   失」;被 discord.js 维护者以「AI slop」驳回关闭(报告本身像 AI 生成,数据可信度低)。
   **当不可信情报处理,但测试面要覆盖**:GO 判据的 rejoin/成员变动轮就是冲着 key 轮换
   时刻的收音连续性去的。
3. **evergreen 风险**:audio receive 本就不被 Discord 官方文档化(FLY-883 DR 已证),
   0.19.2 修好也不改变这个长期地位——这是 FLY-545 要背的运维预算,不是 spike 的 gate。

### 3.4 A 路径 spike 形态

`@discordjs/voice@0.19.2` + `discord.js@14.x` + `@snazzah/davey`(预装)+ prism-media
(Opus 解码):joinVoiceChannel(selfDeaf: false)→ receiver.speaking 事件 →
receiver.subscribe(userId) 拿 per-user Opus 流(**SSRC→user 映射 = per-speaker 分离
天然满足**)→ 解码 PCM 存盘 + 送 STT。#11419 里 stevenpetryk 的最小 repro 可以直接当
spike 骨架。

## 4. 路径 B:py-cord — 现状详查(「据报可用」证伪)

### 4.1 一手证据链(gh api,2026-07-07 查)

- **Snazzah 2026-03-05 原话**(#11441 评论):「py-cord doesn't even support DAVE yet,
  let alone voice receive」。PRD 里「py-cord 据报可用」的说法可追溯到 #11419 早期评论的
  跨库对比,该对比在 upstream 已被**发帖人自己撤回**(引用时 py-cord 尚无 DAVE 支持;
  过渡期观察到「能收」是因为当时会话还能降级到非 E2EE——强制后此形态不复存在)。
- **py-cord 2.8.0(2026-05-18 发布)**:changelog 原文「Added support for Discord DAVE
  (Audio & Video E2EE) for **voice-sending related features**」——对应 merge 的是 #3143
  (send,2026-03-14 合入)。**连接与发送 OK(4017 已解),收侧不在内**。
- **收侧解密 PR 全部未合入 master**(逐个核 merged 字段):#2873(send&receive 重写,
  closed 未合)、#3185(「Implement DAVE voice receive decryption」closed 未合)、
  #3201/#3202(「decrypt incoming DAVE-encrypted audio」closed 未合)、#3168(只针对
  feature 分支)、#3179(**只**合入 feature 分支 fix/voice-rec-2,非 master)、**#3159
  (收侧重构,「DAVE Support (rec)」)至今 open**(最后更新 2026-06-15,PR 模板 checklist
  未填、无测试确认)。
- **官方 docs(v2.8.0)**在 start_recording()/start_listening() 下双处警告:「Recording
  may not work as expected due to the new DAVE (End-to-End Encryption) for voice calls.」

### 4.2 B 路径 spike 形态(若走到)

唯一形态 = **跑未合入的分支代码**(#3159 分支或 fix/voice-rec-2)做耳朵 bot:
py-cord `VoiceClient.start_recording(sink)` → sink 收 per-user 音频(sinks 天然按 user
分轨,per-speaker 满足)→ PCM 经 stdout/socket 交回 Node 侧。风险:未 review、未发布、
分支随时 rebase;#3168/#3179 的存在说明该分支曾有 ssrc↔user 映射方向、解密失败 fallback
等真 bug。**进入条件:A 失败**;投入前先刷一遍 #3159 最新状态(可能已 merge 或已烂尾)。

## 5. 路径 C:本地采音绕开 — 现状(不变)

- **机制**:Annie 桌面 Discord 客户端(官方客户端,天然 DAVE)负责解密播放;macOS 装虚拟
  音频设备(BlackHole 2ch)+ 聚合/多输出设备,把 Discord 输出环回;ffmpeg avfoundation 抓
  环回设备 → 16kHz PCM → STT。`packages/voice-core/src/audio/MicCapture.ts` 的实现
  (ffmpeg avfoundation、device 可配)**换个 device 参数就是现成采集器**——543 真机 QA
  已验证这条采集链(彼时用 --device ":2" 修默认设备 bug,见 FLY-959)。
- **降级面(报告必须写清,gate 已定)**:①绑 Annie 桌面客户端在场且入会;②采到的是
  **频道混音**,无 per-speaker 分离(多 Lead 同频时 transcript 无法标谁在说;v1 Huddle
  多为 1:1 尚可容忍,但 §17 多-agent 远期形态受损);③她用手机进 VC / 人不在桌面时整条
  失效;④机器音频路由被系统更新/设备切换打断的运维脆弱性。
- **选定约束(Tadashi gate 补充)**:C 被选定 = 必须 Annie 知情拍板,不是知会。

## 6. 测试基建盘点(本仓/本机现状)

- **bot 身份**:FLY-882 bot 池有 3 个未认领 slot(flywheel-pool-04/05/06,
  `scripts/discord-bot-pool.sh` claim)→ 耳朵 bot + 发送 bot 各占一个,不碰生产 Lead bot。
- **测试 VC**:bot 无 MANAGE_CHANNELS 是既有先例(FLY-529:channel 由 Annie 手建)。
  → plan 里把「建一个 #fly960-spike 语音频道 + 邀两个 pool bot 进 server」列为一次性
  founder/Lead 前置动作(1 分钟),避免 spike 卡权限。
- **参考音源(发送侧,已知安全)**:@discordjs/voice 发送在 DAVE 下可用(PRD 认定 + 全
  生态无发送侧 issue)。参考音频用 543 的 Edge TTS(`packages/voice-core` announce 面)
  生成固定中英混说样句 wav,发送 bot 循环播放 → 收端转写与参考文本比对,全自动可重复。
- **真人类客户端轮**:DAVE 的 MLS group 构成随参与者变化,bot↔bot 会话 ≠ 产品会话形态
  (产品场景必有 Annie 的官方客户端在场)。→ 至少一轮真客户端在场;确认场 = Annie 真说
  2 分钟(不阻塞 GO 判定,gate 已拍)。
- **STT(spike 用,非选型对象)**:收音是被验对象,STT 用现成的——`GEMINI_API_KEY` 本机
  已有(voice-core converse 面在用,config.ts 读 FLYWHEEL_VOICE_* / GEMINI_API_KEY),
  录出的 wav 直接走 Gemini API 文件转写即可,零新基建。
- **spike 代码落点**:`engineering/spike/FLY-960-dave-stt/`(独立 package.json /
  requirements,不进 pnpm-workspace、不碰 packages/voice-core——FLY-959 并行在修它)。

## 7. 对判据与顺序的修订结论(喂 plan.md)

1. **真机顺序改为 A → B → C**(gate 预授权「research 后 A/B 可调」):A 有已发布的对症
   修复 + 与 Flywheel 同栈(选型摩擦最小);B 只剩未合入分支,验证成本与不确定性反超 A;
   C 保底不动。
2. **GO 判据不变**(exploration §3.1 五条),补两个执行细节:
   - 稳定轮里的「rejoin/成员变动」明确为**必测 MLS key 轮换时刻的收音连续性**(§3.3
     残余风险 2 的对应测试);
   - 「DAVE 真在场」证据落点具体化:`dave_protocol_version > 0`(Session Description)、
     davey session epoch/commit 日志、客户端 E2EE 标识截图,三者齐。
3. **时间盒微调**:A 大概率快(现成 repro 骨架 + 已修版本),给 1 天;B 压到 1 天(跑
   分支验证,烂就撤);C 0.5 天;总盒 ≤3 天不变。
4. **选型输出面向 FLY-545 子范围 A**:选通路径要回答 FLY-545 bridge 关心的三件事——
   per-speaker 分离形态、重连/续命行为(4006/4025 等 close code 下 davey session 重建)、
   依赖版本 pin(@discordjs/voice 0.19.2 + davey 0.1.12,或分支 commit)。

## 8. Sources(关键一手来源)

- discord.js #11419(closed 2026-03-13):https://github.com/discordjs/discord.js/issues/11419
- 修复 PR #11449(merged 2026-03-13):https://github.com/discordjs/discord.js/pull/11449
- @discordjs/voice@0.19.2 release notes(2026-03-17):discord.js repo releases
- npm registry 版本时间线:@discordjs/voice(latest=0.19.2)、@snazzah/davey(latest=0.1.12, 2026-06-22)
- discord.js #11441(MLS 轮换丢包指控,closed/驳回):https://github.com/discordjs/discord.js/issues/11441
- py-cord #3135(4017,open):https://github.com/Pycord-Development/pycord/issues/3135
- py-cord PR merge 状态(gh api 逐个核):#2873 / #3143(✅send) / #3159(open) / #3168 / #3179 / #3185 / #3201 / #3202
- py-cord v2.8.0 changelog + voice docs(recording caveat):https://docs.pycord.dev/en/v2.8.0/api/voice.html
- Discord 官方 blog(DAVE 全平台,2026-03-01 强制):https://discord.com/blog/bringing-dave-to-all-discord-platforms
- 协议细节(4017 / MLS / 0xFAFA / 收包管线):https://docs.discord.food/topics/voice-connections
- DAVE 白皮书:https://daveprotocol.com/
- 上游综合背景:engineering/doc/FLY-883-realtime-voice-research/dr-report.md §Discord integration
